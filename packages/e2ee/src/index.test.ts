import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  createKeyExchangePayload,
  decryptRelayPayload,
  deriveRelayPayloadKeyFromPeer,
  deriveRelayPayloadKey,
  encryptRelayPayload,
  generateKeyExchangeKeyPair,
  generateRelayKeySecret,
  relayPayloadAad,
  type CleartextRelayPayload
} from "./index.js";

test("base64url helpers round trip bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);

  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);
  assert.equal(encoded.includes("="), false);
  assert.deepEqual(base64UrlDecode(encoded), bytes);
});

test("encrypts and decrypts a relay payload", async () => {
  const secret = generateRelayKeySecret();
  const payloadKey = await deriveRelayPayloadKey({
    secret,
    pairId: "pair_test",
    keyId: "key_pair_test_1"
  });
  const aad = relayPayloadAad({
    envelopeId: "env_test",
    pairId: "pair_test",
    source: "mobile",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  const cleartext: CleartextRelayPayload = {
    kind: "user_input",
    sessionId: "session_test",
    input: {
      type: "text",
      inputId: "input_test",
      text: "hello encrypted relay"
    }
  };

  const encrypted = await encryptRelayPayload(cleartext, {
    ...payloadKey,
    aad
  });
  const decrypted = await decryptRelayPayload(encrypted, {
    key: payloadKey.key
  });

  assert.equal(encrypted.kind, "encrypted_payload");
  assert.equal(encrypted.keyId, "key_pair_test_1");
  assert.notEqual(encrypted.ciphertext, JSON.stringify(cleartext));
  assert.deepEqual(decrypted, cleartext);
});

test("derives matching relay payload keys from peer public keys", async () => {
  const desktopKeys = await generateKeyExchangeKeyPair();
  const mobileKeys = await generateKeyExchangeKeyPair();
  const desktopHello = await createKeyExchangePayload({
    phase: "desktop_hello",
    keyId: "key_pair_test_1",
    publicKey: desktopKeys.publicKey
  });
  const mobileHello = await createKeyExchangePayload({
    phase: "mobile_hello",
    keyId: "key_pair_test_1",
    publicKey: mobileKeys.publicKey
  });

  const desktopPayloadKey = await deriveRelayPayloadKeyFromPeer({
    privateKey: desktopKeys.privateKey,
    peerPublicKey: mobileHello.publicKey,
    pairId: "pair_test",
    keyId: desktopHello.keyId
  });
  const mobilePayloadKey = await deriveRelayPayloadKeyFromPeer({
    privateKey: mobileKeys.privateKey,
    peerPublicKey: desktopHello.publicKey,
    pairId: "pair_test",
    keyId: mobileHello.keyId
  });
  const encrypted = await encryptRelayPayload({
    kind: "ping",
    nonce: "ecdh"
  }, desktopPayloadKey);

  assert.equal(desktopHello.kind, "key_exchange");
  assert.equal(mobileHello.phase, "mobile_hello");
  assert.deepEqual(await decryptRelayPayload(encrypted, { key: mobilePayloadKey.key }), {
    kind: "ping",
    nonce: "ecdh"
  });
});

test("rejects decryption with a different pair key", async () => {
  const firstKey = await deriveRelayPayloadKey({
    secret: generateRelayKeySecret(),
    pairId: "pair_test"
  });
  const secondKey = await deriveRelayPayloadKey({
    secret: generateRelayKeySecret(),
    pairId: "pair_test"
  });
  const encrypted = await encryptRelayPayload({
    kind: "ping",
    nonce: "wrong-key"
  }, firstKey);

  await assert.rejects(
    () => decryptRelayPayload(encrypted, { key: secondKey.key }),
    /operation-specific reason|decrypt/i
  );
});

test("binds ciphertext to additional authenticated data", async () => {
  const payloadKey = await deriveRelayPayloadKey({
    secret: generateRelayKeySecret(),
    pairId: "pair_test"
  });
  const encrypted = await encryptRelayPayload({
    kind: "ping",
    nonce: "aad-test"
  }, {
    ...payloadKey,
    aad: relayPayloadAad({
      envelopeId: "env_a",
      pairId: "pair_test",
      source: "desktop",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
  });

  const tampered = {
    ...encrypted,
    aad: base64UrlEncode(relayPayloadAad({
      envelopeId: "env_b",
      pairId: "pair_test",
      source: "desktop",
      createdAt: "2026-01-01T00:00:00.000Z"
    }))
  };

  await assert.rejects(
    () => decryptRelayPayload(tampered, { key: payloadKey.key }),
    /operation-specific reason|decrypt/i
  );
});
