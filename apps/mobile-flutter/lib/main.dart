import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
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
  final serverController = TextEditingController(text: 'http://localhost:8787');
  final codeController = TextEditingController();
  final messageController = TextEditingController();

  WebSocketChannel? channel;
  String status = 'Disconnected';
  String pairId = '';
  String mobileToken = '';
  String selectedSessionId = '';
  final messages = <Map<String, dynamic>>[];
  final interactions = <Map<String, dynamic>>[];

  @override
  void dispose() {
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

    if (response.statusCode < 200 || response.statusCode >= 300) {
      setState(() => status = 'Claim failed: ${response.body}');
      return;
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    pairId = body['pairId'] as String;
    mobileToken = body['mobileToken'] as String;
    connectSocket();
  }

  void connectSocket() {
    final uri = Uri.parse(serverController.text.trim());
    final wsUri = uri.replace(
      scheme: uri.scheme == 'https' ? 'wss' : 'ws',
      path: '/v1/ws',
      queryParameters: {
        'pairId': pairId,
        'role': 'mobile',
        'token': mobileToken,
      },
    );

    final nextChannel = WebSocketChannel.connect(wsUri);
    channel = nextChannel;
    setState(() => status = 'Connected');

    nextChannel.stream.listen(
      (event) => applyEnvelope(jsonDecode(event as String) as Map<String, dynamic>),
      onError: (Object error) => setState(() => status = 'Socket error: $error'),
      onDone: () => setState(() => status = 'Disconnected'),
    );
  }

  void applyEnvelope(Map<String, dynamic> envelope) {
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
          ..addAll((snapshot['messages'] as List<dynamic>).cast<Map<String, dynamic>>());
        interactions
          ..clear()
          ..addAll((snapshot['pendingInteractions'] as List<dynamic>).cast<Map<String, dynamic>>());
      } else if (kind == 'client_event') {
        selectedSessionId = payload['sessionId'] as String;
        final event = payload['event'] as Map<String, dynamic>;
        if (event['type'] == 'message') {
          messages.add(event['payload'] as Map<String, dynamic>);
        }
        if (event['type'] == 'interaction_request') {
          interactions.add(event['payload'] as Map<String, dynamic>);
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
      'value': option['value'],
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('EasyCode'),
        subtitle: Text(status),
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
