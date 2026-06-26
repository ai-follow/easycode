import 'dart:collection';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _payloadVersion = 1;
const _keyExchangeSuite = 'p256-hkdf-sha256-aes-256-gcm';
const _payloadSuite = 'aes-256-gcm';
const _keyInfo = 'easycode relay payload encryption v1';
const _clearPayloadKinds = {
  'ack',
  'error',
  'ping',
  'key_exchange',
  'encrypted_payload',
};

class FlutterE2eeSessionManager {
  RelayE2eeSession? _session;
  String _pairId = '';

  bool get ready => _session?.ready ?? false;

  Future<void> restore(String pairId) async {
    if (_session != null && _pairId == pairId) return;

    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_e2eeStorageKey(pairId));
    if (raw == null) return;

    try {
      final state = jsonDecode(raw) as Map<String, dynamic>;
      if (state['role'] != 'mobile' || state['pairId'] != pairId) {
        await prefs.remove(_e2eeStorageKey(pairId));
        return;
      }
      _remember(pairId, await RelayE2eeSession.restore(state));
    } catch (_) {
      await prefs.remove(_e2eeStorageKey(pairId));
    }
  }

  Future<Map<String, dynamic>> handleKeyExchange(String pairId, Map<String, dynamic> payload) async {
    final session = await _ensure(pairId);
    await session.handleKeyExchange(payload);
    await _save(pairId, session);
    return session.createHello();
  }

  Future<Map<String, dynamic>> decryptEnvelopePayload(Map<String, dynamic> envelope) async {
    final session = await _ensure(envelope['pairId'] as String);
    if (!session.ready) {
      throw StateError('Received encrypted payload before mobile E2EE session was ready');
    }
    return session.decryptEnvelopePayload(envelope);
  }

  Future<Map<String, dynamic>> prepareOutboundEnvelope(Map<String, dynamic> envelope) async {
    final payload = envelope['payload'] as Map<String, dynamic>;
    if (!shouldEncryptRelayPayload(payload)) return envelope;

    final session = _session != null && _pairId == envelope['pairId']
        ? _session
        : await _restoreIfAvailable(envelope['pairId'] as String);
    if (session == null || !session.ready) return envelope;

    return {
      ...envelope,
      'payload': await session.encryptEnvelopePayload(envelope, payload),
    };
  }

  Future<void> forget(String pairId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_e2eeStorageKey(pairId));
    if (_pairId == pairId) clearMemory();
  }

  void clearMemory() {
    _session = null;
    _pairId = '';
  }

  Future<RelayE2eeSession> _ensure(String pairId) async {
    if (_session != null && _pairId == pairId) return _session!;

    final restored = await _restoreIfAvailable(pairId);
    if (restored != null) return restored;

    final created = await RelayE2eeSession.create(pairId);
    _remember(pairId, created);
    return created;
  }

  Future<RelayE2eeSession?> _restoreIfAvailable(String pairId) async {
    await restore(pairId);
    return _session != null && _pairId == pairId ? _session : null;
  }

  Future<void> _save(String pairId, RelayE2eeSession session) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_e2eeStorageKey(pairId), jsonEncode(await session.serialize()));
  }

  void _remember(String pairId, RelayE2eeSession session) {
    _pairId = pairId;
    _session = session;
  }
}

class RelayE2eeSession {
  RelayE2eeSession._({
    required this.pairId,
    required this.keyId,
    required this.keyPair,
    this.peerPublicKey,
    this.payloadKey,
  });

  static final _ecdh = Ecdh.p256(length: 256);
  static final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
  static final _aesGcm = AesGcm.with256bits();

  final String pairId;
  final String keyId;
  final EcKeyPair keyPair;
  String? peerPublicKey;
  SecretKey? payloadKey;

  bool get ready => payloadKey != null;

  static Future<RelayE2eeSession> create(String pairId) async {
    return RelayE2eeSession._(
      pairId: pairId,
      keyId: _defaultPayloadKeyId(pairId),
      keyPair: await _ecdh.newKeyPair(),
    );
  }

  static Future<RelayE2eeSession> restore(Map<String, dynamic> state) async {
    if (state['version'] != _payloadVersion) {
      throw StateError('Unsupported relay E2EE session version: ${state['version']}');
    }

    final privateKeyJwk = state['privateKeyJwk'] as Map<String, dynamic>;
    final keyPair = EcKeyPairData(
      d: _base64UrlDecode(privateKeyJwk['d'] as String),
      x: _base64UrlDecode(privateKeyJwk['x'] as String),
      y: _base64UrlDecode(privateKeyJwk['y'] as String),
      type: KeyPairType.p256,
    );

    final session = RelayE2eeSession._(
      pairId: state['pairId'] as String,
      keyId: state['keyId'] as String,
      keyPair: keyPair,
      peerPublicKey: state['peerPublicKey'] as String?,
    );
    if (session.peerPublicKey != null) {
      await session._derivePayloadKey(session.peerPublicKey!);
    }
    return session;
  }

  Future<Map<String, dynamic>> createHello() async {
    final publicKey = await keyPair.extractPublicKey();
    return {
      'kind': 'key_exchange',
      'version': _payloadVersion,
      'suite': _keyExchangeSuite,
      'phase': 'mobile_hello',
      'keyId': keyId,
      'publicKey': _base64UrlEncode(await publicKey.toDer()),
    };
  }

  Future<void> handleKeyExchange(Map<String, dynamic> payload) async {
    if (payload['suite'] != _keyExchangeSuite) {
      throw StateError('Unsupported key exchange suite: ${payload['suite']}');
    }
    if (payload['keyId'] != keyId) {
      throw StateError('Unexpected key exchange key id: ${payload['keyId']}');
    }
    if (payload['phase'] != 'desktop_hello') {
      throw StateError('Unexpected key exchange phase for mobile: ${payload['phase']}');
    }
    await _derivePayloadKey(payload['publicKey'] as String);
  }

  Future<Map<String, dynamic>> serialize() async {
    final data = await keyPair.extract();
    return {
      'version': _payloadVersion,
      'role': 'mobile',
      'pairId': pairId,
      'keyId': keyId,
      'publicKey': _base64UrlEncode(await (await keyPair.extractPublicKey()).toDer()),
      'privateKeyJwk': {
        'kty': 'EC',
        'crv': 'P-256',
        'key_ops': ['deriveBits'],
        'ext': true,
        'd': _base64UrlEncode(data.d),
        'x': _base64UrlEncode(data.x),
        'y': _base64UrlEncode(data.y),
      },
      if (peerPublicKey != null) 'peerPublicKey': peerPublicKey,
    };
  }

  Future<Map<String, dynamic>> encryptEnvelopePayload(
    Map<String, dynamic> envelope,
    Map<String, dynamic> payload,
  ) async {
    final key = payloadKey;
    if (key == null) throw StateError('Relay E2EE session is not ready');

    final aad = _relayEnvelopeAad(envelope);
    final plaintext = utf8.encode(_stableJson(payload));
    final secretBox = await _aesGcm.encrypt(
      plaintext,
      secretKey: key,
      aad: aad,
      nonce: _randomNonce(12),
    );

    return {
      'kind': 'encrypted_payload',
      'version': _payloadVersion,
      'suite': _payloadSuite,
      'keyId': keyId,
      'nonce': _base64UrlEncode(secretBox.nonce),
      'ciphertext': _base64UrlEncode([...secretBox.cipherText, ...secretBox.mac.bytes]),
      'aad': _base64UrlEncode(aad),
    };
  }

  Future<Map<String, dynamic>> decryptEnvelopePayload(Map<String, dynamic> envelope) async {
    final key = payloadKey;
    if (key == null) throw StateError('Relay E2EE session is not ready');

    final payload = envelope['payload'] as Map<String, dynamic>;
    if (payload['suite'] != _payloadSuite) {
      throw StateError('Unsupported relay payload encryption suite: ${payload['suite']}');
    }

    final encrypted = _base64UrlDecode(payload['ciphertext'] as String);
    const macLength = 16;
    if (encrypted.length <= macLength) throw StateError('Invalid encrypted relay payload');

    final plaintext = await _aesGcm.decrypt(
      SecretBox(
        encrypted.sublist(0, encrypted.length - macLength),
        nonce: _base64UrlDecode(payload['nonce'] as String),
        mac: Mac(encrypted.sublist(encrypted.length - macLength)),
      ),
      secretKey: key,
      aad: _relayEnvelopeAad(envelope),
    );
    final decoded = jsonDecode(utf8.decode(plaintext)) as Map<String, dynamic>;
    final kind = decoded['kind'];
    if (kind == 'encrypted_payload' || kind == 'key_exchange') {
      throw StateError('Decrypted relay payload cannot be $kind');
    }
    return decoded;
  }

  Future<void> _derivePayloadKey(String nextPeerPublicKey) async {
    peerPublicKey = nextPeerPublicKey;
    final peerPublic = EcPublicKey.parseDer(
      _base64UrlDecode(nextPeerPublicKey),
      type: KeyPairType.p256,
    );
    final sharedSecret = await _ecdh.sharedSecretKey(
      keyPair: keyPair,
      remotePublicKey: peerPublic,
    );
    payloadKey = await _hkdf.deriveKey(
      secretKey: SecretKey(await sharedSecret.extractBytes()),
      nonce: utf8.encode('easycode pair $pairId'),
      info: utf8.encode(_keyInfo),
    );
  }
}

bool shouldEncryptRelayPayload(Map<String, dynamic> payload) {
  final kind = payload['kind'];
  return kind is String && !_clearPayloadKinds.contains(kind);
}

List<int> _relayEnvelopeAad(Map<String, dynamic> envelope) {
  return utf8.encode(_stableJson({
    'createdAt': envelope['createdAt'],
    'envelopeId': envelope['id'],
    'pairId': envelope['pairId'],
    'source': envelope['source'],
    'version': _payloadVersion,
  }));
}

String _e2eeStorageKey(String pairId) => 'easycode:e2ee-session:$pairId';

String _defaultPayloadKeyId(String pairId) => 'pair:$pairId:payload:v1';

List<int> _randomNonce(int length) => List<int>.generate(length, (_) => _RelayRandom.nextByte());

String _base64UrlEncode(List<int> bytes) {
  return base64Url.encode(bytes).replaceAll('=', '');
}

Uint8List _base64UrlDecode(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]*$').hasMatch(value)) {
    throw FormatException('Invalid base64url value');
  }
  final padded = value.padRight(((value.length + 3) ~/ 4) * 4, '=');
  return Uint8List.fromList(base64Url.decode(padded));
}

String _stableJson(Object? value) => jsonEncode(_sortJson(value));

Object? _sortJson(Object? value) {
  if (value is List) return value.map(_sortJson).toList();
  if (value is Map) {
    final output = SplayTreeMap<String, Object?>();
    for (final entry in value.entries) {
      output[entry.key.toString()] = _sortJson(entry.value);
    }
    return output;
  }
  return value;
}

class _RelayRandom {
  static final _random = Random.secure();

  static int nextByte() => _random.nextInt(256);
}
