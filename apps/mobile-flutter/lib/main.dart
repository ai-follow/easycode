import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'e2ee.dart';

void main() {
  runApp(const EasyCodeApp());
}

class PrimaryInteractionAction {
  const PrimaryInteractionAction({
    required this.request,
    required this.option,
  });

  final Map<String, dynamic> request;
  final Map<String, dynamic> option;
}

final _primaryActionPatterns = [
  RegExp(r'\b(continue|proceed|resume|retry)\b', caseSensitive: false),
  RegExp(r'\b(approve|allow|accept|yes|ok|okay|run)\b', caseSensitive: false),
];

const defaultContinueText = 'continue';

PrimaryInteractionAction? selectPrimaryInteractionAction(List<Map<String, dynamic>> interactions) {
  PrimaryInteractionAction? best;
  var bestPatternIndex = _primaryActionPatterns.length;
  var bestRequestIndex = interactions.length;
  var bestOptionIndex = 0;

  for (var requestIndex = 0; requestIndex < interactions.length; requestIndex += 1) {
    final request = interactions[requestIndex];
    final rawOptions = request['options'];
    if (rawOptions is! List) continue;

    for (var optionIndex = 0; optionIndex < rawOptions.length; optionIndex += 1) {
      final rawOption = rawOptions[optionIndex];
      if (rawOption is! Map<String, dynamic>) continue;
      final label = rawOption['label'];
      if (label is! String) continue;

      final patternIndex = _primaryActionPatterns.indexWhere((pattern) => pattern.hasMatch(label));
      if (patternIndex < 0) continue;

      if (best == null ||
          patternIndex < bestPatternIndex ||
          (patternIndex == bestPatternIndex && requestIndex < bestRequestIndex) ||
          (patternIndex == bestPatternIndex && requestIndex == bestRequestIndex && optionIndex < bestOptionIndex)) {
        best = PrimaryInteractionAction(request: request, option: rawOption);
        bestPatternIndex = patternIndex;
        bestRequestIndex = requestIndex;
        bestOptionIndex = optionIndex;
      }
    }
  }

  return best;
}

class EasyCodeApp extends StatelessWidget {
  const EasyCodeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EasyCode',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2563EB)),
        useMaterial3: true,
      ),
      home: const RelayScreen(),
    );
  }
}

class RelayScreen extends StatefulWidget {
  const RelayScreen({super.key});

  @override
  State<RelayScreen> createState() => _RelayScreenState();
}

class _RelayScreenState extends State<RelayScreen> {
  static const pairingServerUrlKey = 'easycode:pairing:serverUrl';
  static const pairingPairIdKey = 'easycode:pairing:pairId';
  static const pairingMobileTokenKey = 'easycode:pairing:mobileToken';

  final serverController = TextEditingController(text: 'http://localhost:8787');
  final codeController = TextEditingController();
  final messageController = TextEditingController();

  WebSocketChannel? channel;
  Timer? reconnectTimer;
  int reconnectAttempt = 0;
  int lastServerSeq = 0;
  int pendingOutboundCount = 0;
  bool closingIntentionally = false;
  String status = 'Disconnected';
  String pairId = '';
  String mobileToken = '';
  String selectedSessionId = '';
  final messages = <Map<String, dynamic>>[];
  final interactions = <Map<String, dynamic>>[];
  final queuedEnvelopes = <Map<String, dynamic>>[];
  final pendingAckEnvelopes = <String, Map<String, dynamic>>{};
  final e2eeManager = FlutterE2eeSessionManager();

  @override
  void initState() {
    super.initState();
    unawaited(restorePairing());
  }

  @override
  void dispose() {
    reconnectTimer?.cancel();
    closingIntentionally = true;
    channel?.sink.close();
    serverController.dispose();
    codeController.dispose();
    messageController.dispose();
    super.dispose();
  }

  Future<void> claimPairing() async {
    setState(() => status = 'Claiming');
    final server = serverController.text.trim();
    final code = codeController.text.trim();
    final response = await http.post(Uri.parse('$server/v1/pairings/$code/claim'));
    if (!mounted) return;

    if (response.statusCode < 200 || response.statusCode >= 300) {
      setState(() => status = 'Claim failed: ${response.body}');
      return;
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    pairId = body['pairId'] as String;
    mobileToken = body['mobileToken'] as String;
    await savePairing(server, pairId, mobileToken);
    if (!mounted) return;
    unawaited(connectSocket());
  }

  Future<void> connectSocket() async {
    reconnectTimer?.cancel();
    reconnectTimer = null;
    closingIntentionally = false;
    await e2eeManager.restore(pairId);
    if (!mounted) return;

    final uri = Uri.parse(serverController.text.trim());
    final queryParameters = <String, String>{
      'pairId': pairId,
      'role': 'mobile',
      'token': mobileToken,
      if (lastServerSeq > 0) 'afterSeq': '$lastServerSeq',
    };
    final wsUri = uri.replace(
      scheme: uri.scheme == 'https' ? 'wss' : 'ws',
      path: '/v1/ws',
      queryParameters: queryParameters,
    );

    final previousChannel = channel;
    channel = null;
    previousChannel?.sink.close();
    final nextChannel = WebSocketChannel.connect(wsUri);
    channel = nextChannel;
    setState(() => status = 'Connected');

    nextChannel.stream.listen(
      (event) {
        reconnectAttempt = 0;
        unawaited(
          applyEnvelope(jsonDecode(event as String) as Map<String, dynamic>).catchError((Object error) {
            if (mounted && channel == nextChannel) {
              setState(() => status = 'Relay payload error: $error');
            }
          }),
        );
      },
      onError: (Object error) {
        if (!mounted || channel != nextChannel) return;
        setState(() => status = 'Socket error: $error');
      },
      onDone: () {
        if (!mounted || channel != nextChannel) return;
        requeuePendingAcks();
        setState(() => status = 'Disconnected');
        if (!closingIntentionally && pairId.isNotEmpty && mobileToken.isNotEmpty) {
          scheduleReconnect();
        }
      },
    );
  }

  Future<void> restorePairing() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;

    final storedServerUrl = prefs.getString(pairingServerUrlKey);
    final storedPairId = prefs.getString(pairingPairIdKey);
    final storedMobileToken = prefs.getString(pairingMobileTokenKey);
    if (storedServerUrl == null || storedPairId == null || storedMobileToken == null) return;
    if (storedServerUrl.isEmpty || storedPairId.isEmpty || storedMobileToken.isEmpty) return;

    serverController.text = storedServerUrl;
    pairId = storedPairId;
    mobileToken = storedMobileToken;
    lastServerSeq = prefs.getInt(lastSeqKey(storedPairId)) ?? 0;
    if (mounted) setState(() => status = 'Connecting');
    unawaited(connectSocket());
  }

  Future<void> savePairing(String serverUrl, String pairId, String mobileToken) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(pairingServerUrlKey, serverUrl);
    await prefs.setString(pairingPairIdKey, pairId);
    await prefs.setString(pairingMobileTokenKey, mobileToken);
  }

  Future<void> rememberServerSeq(Map<String, dynamic> envelope) async {
    final serverSeq = envelope['serverSeq'];
    if (serverSeq is! int || serverSeq <= lastServerSeq) return;

    lastServerSeq = serverSeq;
    final envelopePairId = envelope['pairId'] as String? ?? pairId;
    if (envelopePairId.isEmpty) return;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(lastSeqKey(envelopePairId), serverSeq);
  }

  void scheduleReconnect() {
    if (reconnectTimer != null) return;
    reconnectAttempt += 1;
    final delayMs = math.min(10000, 1000 * (1 << math.min(reconnectAttempt - 1, 4)));
    reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      reconnectTimer = null;
      if (pairId.isEmpty || mobileToken.isEmpty) return;
      unawaited(connectSocket());
    });
  }

  Future<void> forgetPairing() async {
    closingIntentionally = true;
    reconnectTimer?.cancel();
    reconnectTimer = null;
    final previousChannel = channel;
    channel = null;
    previousChannel?.sink.close();

    final previousServerUrl = serverController.text.trim();
    final previousPairId = pairId;
    final previousMobileToken = mobileToken;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(pairingServerUrlKey);
    await prefs.remove(pairingPairIdKey);
    await prefs.remove(pairingMobileTokenKey);
    if (previousPairId.isNotEmpty) await prefs.remove(lastSeqKey(previousPairId));
    if (previousPairId.isNotEmpty) await e2eeManager.forget(previousPairId);
    if (!mounted) return;

    setState(() {
      status = 'Disconnected';
      pairId = '';
      mobileToken = '';
      selectedSessionId = '';
      lastServerSeq = 0;
      reconnectAttempt = 0;
      queuedEnvelopes.clear();
      pendingAckEnvelopes.clear();
      pendingOutboundCount = 0;
      messages.clear();
      interactions.clear();
    });

    if (previousServerUrl.isNotEmpty && previousPairId.isNotEmpty && previousMobileToken.isNotEmpty) {
      unawaited(revokePairing(previousServerUrl, previousPairId, previousMobileToken));
    }
  }

  Future<void> applyEnvelope(Map<String, dynamic> envelope) async {
    unawaited(rememberServerSeq(envelope));
    var payload = envelope['payload'] as Map<String, dynamic>;

    if (payload['kind'] == 'key_exchange') {
      final reply = await e2eeManager.handleKeyExchange(envelope['pairId'] as String, payload);
      unawaited(sendEnvelope({
        'id': 'env_${DateTime.now().microsecondsSinceEpoch}',
        'pairId': envelope['pairId'],
        'source': 'mobile',
        'createdAt': DateTime.now().toUtc().toIso8601String(),
        'payload': reply,
      }));
      return;
    }

    if (payload['kind'] == 'encrypted_payload') {
      payload = await e2eeManager.decryptEnvelopePayload(envelope);
    }

    final kind = payload['kind'] as String;

    if (kind == 'ack') {
      final refId = payload['refId'] as String?;
      if (refId != null) {
        pendingAckEnvelopes.remove(refId);
        removeQueuedEnvelope(refId);
        updatePendingOutboundCount();
      }
      return;
    }

    if (kind == 'error') {
      final refId = payload['refId'] as String?;
      if (refId != null) {
        pendingAckEnvelopes.remove(refId);
        removeQueuedEnvelope(refId);
        updatePendingOutboundCount();
      }
      setState(() => status = payload['message'] as String? ?? 'Relay error');
      return;
    }

    if (kind == 'ping') return;

    setState(() {
      if (kind == 'desktop_status') {
        final sessions = payload['sessions'] as List<dynamic>;
        if (sessions.isNotEmpty && selectedSessionId.isEmpty) {
          selectedSessionId = (sessions.first as Map<String, dynamic>)['sessionId'] as String;
        }
      } else if (kind == 'session_snapshot') {
        selectedSessionId = payload['sessionId'] as String;
        final snapshot = payload['snapshot'] as Map<String, dynamic>;
        messages
          ..clear()
          ..addAll(dedupeById((snapshot['messages'] as List<dynamic>).cast<Map<String, dynamic>>()));
        interactions
          ..clear()
          ..addAll(dedupeById((snapshot['pendingInteractions'] as List<dynamic>).cast<Map<String, dynamic>>()));
      } else if (kind == 'client_event') {
        selectedSessionId = payload['sessionId'] as String;
        final event = payload['event'] as Map<String, dynamic>;
        if (event['type'] == 'message') {
          appendUniqueById(messages, event['payload'] as Map<String, dynamic>);
        }
        if (event['type'] == 'interaction_request') {
          appendUniqueById(interactions, event['payload'] as Map<String, dynamic>);
        }
      }
    });
    if (mounted) setState(() => status = 'Connected');
    unawaited(flushQueuedEnvelopes());
  }

  void sendText() {
    final text = messageController.text.trim();
    if (text.isEmpty || selectedSessionId.isEmpty) return;
    messageController.clear();
    sendTextInput(text);
  }

  void sendContinueText() {
    if (selectedSessionId.isEmpty) return;
    sendTextInput(defaultContinueText);
  }

  void sendTextInput(String text) {
    sendInput({
      'type': 'text',
      'inputId': 'input_${DateTime.now().microsecondsSinceEpoch}',
      'text': text,
    });
  }

  void sendInteraction(Map<String, dynamic> request, Map<String, dynamic> option) {
    interactions.removeWhere((item) => item['id'] == request['id']);
    sendInput({
      'type': 'interaction_response',
      'inputId': 'input_${DateTime.now().microsecondsSinceEpoch}',
      'requestId': request['id'],
      'optionId': option['id'],
    });
    setState(() {});
  }

  void sendInput(Map<String, dynamic> input) {
    final envelope = {
      'id': 'env_${DateTime.now().microsecondsSinceEpoch}',
      'pairId': pairId,
      'source': 'mobile',
      'createdAt': DateTime.now().toUtc().toIso8601String(),
      'payload': {
        'kind': 'user_input',
        'sessionId': selectedSessionId,
        'input': input,
      },
    };
    unawaited(sendEnvelope(envelope));
  }

  String lastSeqKey(String pairId) => 'easycode:last-server-seq:$pairId';

  Future<void> sendEnvelope(Map<String, dynamic> envelope) async {
    if (channel == null || status != 'Connected') {
      enqueueEnvelope(envelope);
      return;
    }

    late Map<String, dynamic> prepared;
    try {
      prepared = await e2eeManager.prepareOutboundEnvelope(envelope);
    } catch (error) {
      if (mounted) setState(() => status = 'E2EE send error: $error');
      enqueueEnvelope(envelope);
      return;
    }
    pendingAckEnvelopes[prepared['id'] as String] = prepared;
    updatePendingOutboundCount();
    try {
      channel?.sink.add(jsonEncode(prepared));
    } catch (_) {
      pendingAckEnvelopes.remove(prepared['id']);
      enqueueEnvelope(prepared);
    }
  }

  void enqueueEnvelope(Map<String, dynamic> envelope) {
    final id = envelope['id'] as String;
    if (queuedEnvelopes.any((item) => item['id'] == id) || pendingAckEnvelopes.containsKey(id)) return;

    queuedEnvelopes.add(envelope);
    if (queuedEnvelopes.length > 200) {
      queuedEnvelopes.removeRange(0, queuedEnvelopes.length - 200);
    }
    updatePendingOutboundCount();
  }

  Future<void> flushQueuedEnvelopes() async {
    if (queuedEnvelopes.isEmpty || channel == null || status != 'Connected') return;
    final queued = List<Map<String, dynamic>>.from(queuedEnvelopes);
    queuedEnvelopes.clear();
    updatePendingOutboundCount();
    for (final envelope in queued) {
      await sendEnvelope(envelope);
    }
  }

  void requeuePendingAcks() {
    if (pendingAckEnvelopes.isEmpty) return;
    queuedEnvelopes.insertAll(0, pendingAckEnvelopes.values);
    pendingAckEnvelopes.clear();
    if (queuedEnvelopes.length > 200) {
      queuedEnvelopes.removeRange(0, queuedEnvelopes.length - 200);
    }
    updatePendingOutboundCount();
  }

  void removeQueuedEnvelope(String envelopeId) {
    queuedEnvelopes.removeWhere((item) => item['id'] == envelopeId);
  }

  void updatePendingOutboundCount() {
    final nextCount = queuedEnvelopes.length + pendingAckEnvelopes.length;
    if (pendingOutboundCount == nextCount) return;
    if (!mounted) {
      pendingOutboundCount = nextCount;
      return;
    }
    setState(() => pendingOutboundCount = nextCount);
  }

  List<Map<String, dynamic>> dedupeById(List<Map<String, dynamic>> items) {
    final seen = <String>{};
    return [
      for (final item in items)
        if (item['id'] is String && seen.add(item['id'] as String)) item,
    ];
  }

  void appendUniqueById(List<Map<String, dynamic>> items, Map<String, dynamic> next) {
    final id = next['id'];
    if (id is String && items.any((item) => item['id'] == id)) return;
    items.add(next);
  }

  Future<void> revokePairing(String serverUrl, String pairId, String mobileToken) async {
    try {
      await http.delete(
        Uri.parse('$serverUrl/v1/pairings/$pairId'),
        headers: {'authorization': 'Bearer $mobileToken'},
      );
    } catch (_) {
      // Local forget should still succeed if the relay is unavailable.
    }
  }

  @override
  Widget build(BuildContext context) {
    final primaryAction = selectPrimaryInteractionAction(interactions);
    final showGenericContinue = primaryAction == null && interactions.isEmpty && selectedSessionId.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: const Text('EasyCode'),
        subtitle: Text(status),
        actions: [
          if (pairId.isNotEmpty)
            TextButton(
              onPressed: forgetPairing,
              child: const Text('Forget'),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (pairId.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    TextField(controller: serverController, decoration: const InputDecoration(labelText: 'Relay server')),
                    TextField(
                      controller: codeController,
                      decoration: const InputDecoration(labelText: 'Pairing code'),
                      keyboardType: TextInputType.number,
                    ),
                    const SizedBox(height: 12),
                    FilledButton(onPressed: claimPairing, child: const Text('Connect')),
                  ],
                ),
              )
            else
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    for (final message in messages)
                      ListTile(
                        title: Text(message['role'] as String? ?? 'client'),
                        subtitle: Text(message['text'] as String? ?? ''),
                      ),
                    for (final request in interactions)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(request['text'] as String? ?? ''),
                              Wrap(
                                spacing: 8,
                                children: [
                                  for (final option in (request['options'] as List<dynamic>).cast<Map<String, dynamic>>())
                                    OutlinedButton(
                                      onPressed: () => sendInteraction(request, option),
                                      child: Text(option['label'] as String),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            if (pairId.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    if (primaryAction != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: SizedBox(
                          width: double.infinity,
                          child: FilledButton(
                            onPressed: () => sendInteraction(primaryAction.request, primaryAction.option),
                            child: Text(primaryAction.option['label'] as String? ?? 'Continue'),
                          ),
                        ),
                      )
                    else if (showGenericContinue)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: SizedBox(
                          width: double.infinity,
                          child: FilledButton(
                            onPressed: sendContinueText,
                            child: const Text('Continue'),
                          ),
                        ),
                      ),
                    if (pendingOutboundCount > 0)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text('Waiting for relay ack: $pendingOutboundCount'),
                      ),
                    Row(
                      children: [
                        Expanded(child: TextField(controller: messageController, decoration: const InputDecoration(hintText: 'Message'))),
                        const SizedBox(width: 8),
                        FilledButton(onPressed: sendText, child: const Text('Send')),
                      ],
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
