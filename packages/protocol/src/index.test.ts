import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayEnvelopeSchema, RelayPayloadSchema } from "./index.js";

test("accepts current cleartext relay payloads", () => {
  const parsed = RelayPayloadSchema.parse({
    kind: "ping",
    nonce: "still-cleartext"
  });

  assert.deepEqual(parsed, {
    kind: "ping",
    nonce: "still-cleartext"
  });
});

test("accepts opaque encrypted relay payloads", () => {
  const parsed = RelayEnvelopeSchema.parse({
    id: "env_encrypted",
    pairId: "pair_test",
    source: "mobile",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      kind: "encrypted_payload",
      version: 1,
      suite: "xchacha20poly1305-ietf",
      keyId: "key_pair_test_1",
      nonce: "base64url-nonce",
      ciphertext: "base64url-ciphertext",
      aad: "base64url-aad"
    }
  });

  assert.equal(parsed.payload.kind, "encrypted_payload");
  if (parsed.payload.kind === "encrypted_payload") {
    assert.equal(parsed.payload.version, 1);
    assert.equal(parsed.payload.suite, "xchacha20poly1305-ietf");
    assert.equal(parsed.payload.keyId, "key_pair_test_1");
  }
});

test("rejects incomplete encrypted relay payloads", () => {
  const parsed = RelayPayloadSchema.safeParse({
    kind: "encrypted_payload",
    version: 1,
    suite: "aes-256-gcm",
    keyId: "key_pair_test_1",
    nonce: "",
    ciphertext: "base64url-ciphertext"
  });

  assert.equal(parsed.success, false);
});

test("accepts key exchange payloads", () => {
  const parsed = RelayPayloadSchema.parse({
    kind: "key_exchange",
    version: 1,
    suite: "p256-hkdf-sha256-aes-256-gcm",
    phase: "desktop_hello",
    keyId: "key_pair_test_1",
    publicKey: "base64url-spki"
  });

  assert.equal(parsed.kind, "key_exchange");
  if (parsed.kind === "key_exchange") {
    assert.equal(parsed.phase, "desktop_hello");
    assert.equal(parsed.suite, "p256-hkdf-sha256-aes-256-gcm");
  }
});
