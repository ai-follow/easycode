import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  runApp(const EasyCodeApp());
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
  bool closingIntentionally = false;
  String status = 'Disconnected';
  String pairId = '';
  String mobileToken = '';
  String selectedSessionId = '';
  final messages = <Map<String, dynamic>>[];
  final interactions = <Map<String, dynamic>>[];

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
    connectSocket();
  }

  void connectSocket() {
    reconnectTimer?.cancel();
    reconnectTimer = null;
    closingIntentionally = false;

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
    setState(() => status = 'Connecting');

    nextChannel.stream.listen(
      (event) {
        reconnectAttempt = 0;
        applyEnvelope(jsonDecode(event as String) as Map<String, dynamic>);
        if (mounted) setState(() => status = 'Connected');
      },
      onError: (Object error) {
        if (!mounted || channel != nextChannel) return;
        setState(() => status = 'Socket error: $error');
      },
      onDone: () {
        if (!mounted || channel != nextChannel) return;
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
    connectSocket();
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
      connectSocket();
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
    if (!mounted) return;

    setState(() {
      status = 'Disconnected';
      pairId = '';
      mobileToken = '';
      selectedSessionId = '';
      lastServerSeq = 0;
      reconnectAttempt = 0;
      messages.clear();
      interactions.clear();
    });

    if (previousServerUrl.isNotEmpty && previousPairId.isNotEmpty && previousMobileToken.isNotEmpty) {
      unawaited(revokePairing(previousServerUrl, previousPairId, previousMobileToken));
    }
  }

  void applyEnvelope(Map<String, dynamic> envelope) {
    unawaited(rememberServerSeq(envelope));
    final payload = envelope['payload'] as Map<String, dynamic>;
    final kind = payload['kind'] as String;

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
  }

  void sendText() {
    final text = messageController.text.trim();
    if (text.isEmpty || selectedSessionId.isEmpty || channel == null) return;
    messageController.clear();
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
    channel?.sink.add(jsonEncode(envelope));
  }

  String lastSeqKey(String pairId) => 'easycode:last-server-seq:$pairId';

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
                child: Row(
                  children: [
                    Expanded(child: TextField(controller: messageController, decoration: const InputDecoration(hintText: 'Message'))),
                    const SizedBox(width: 8),
                    FilledButton(onPressed: sendText, child: const Text('Send')),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
