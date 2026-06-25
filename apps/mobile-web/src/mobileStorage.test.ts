import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelayPayload } from "@easycode/protocol";
import {
  e2eeStorageKey,
  lastSeqKey,
  loadStoredE2eeSession,
  loadStoredPairing,
  pairingStorageKey,
  shouldEncryptPayload,
  storePairing,
  type KeyValueStorage
} from "./mobileStorage.js";

test("mobile storage loads and stores pairing credentials", () => {
  const storage = memoryStorage();
  storePairing(storage, {
    serverUrl: "http://localhost:8787",
    pairId: "pair_test",
    mobileToken: "mobile_token_test"
  });

  assert.deepEqual(loadStoredPairing(storage), {
    serverUrl: "http://localhost:8787",
    pairId: "pair_test",
    mobileToken: "mobile_token_test"
  });
  assert.equal(pairingStorageKey, "easycode:pairing");
});

test("mobile storage ignores invalid pairing and e2ee state", () => {
  const storage = memoryStorage();
  storage.setItem(pairingStorageKey, "{");
  assert.equal(loadStoredPairing(storage), undefined);

  storage.setItem(pairingStorageKey, JSON.stringify({ pairId: "pair_test" }));
  assert.equal(loadStoredPairing(storage), undefined);

  storage.setItem(e2eeStorageKey("pair_test"), JSON.stringify({
    version: 1,
    role: "desktop",
    pairId: "pair_test",
    keyId: "key_test",
    publicKey: "public",
    privateKeyJwk: {}
  }));
  assert.equal(loadStoredE2eeSession(storage, "pair_test"), undefined);
});

test("mobile storage loads valid mobile e2ee state for the matching pair", () => {
  const storage = memoryStorage();
  const state = {
    version: 1 as const,
    role: "mobile" as const,
    pairId: "pair_test",
    keyId: "key_test",
    publicKey: "public",
    privateKeyJwk: {
      kty: "EC"
    }
  };
  storage.setItem(e2eeStorageKey("pair_test"), JSON.stringify(state));

  assert.deepEqual(loadStoredE2eeSession(storage, "pair_test"), state);
  assert.equal(loadStoredE2eeSession(storage, "other_pair"), undefined);
  assert.equal(lastSeqKey("pair_test"), "easycode:last-server-seq:pair_test");
});

test("mobile encryption predicate leaves relay control frames clear", () => {
  const payloads: RelayPayload[] = [
    { kind: "ack", refId: "env_1" },
    { kind: "error", message: "failed" },
    { kind: "ping", nonce: "nonce" },
    {
      kind: "key_exchange",
      version: 1,
      suite: "p256-hkdf-sha256-aes-256-gcm",
      phase: "desktop_hello",
      keyId: "key_test",
      publicKey: "public"
    },
    {
      kind: "encrypted_payload",
      version: 1,
      suite: "aes-256-gcm",
      keyId: "key_test",
      nonce: "nonce",
      ciphertext: "ciphertext"
    }
  ];

  assert.equal(payloads.every((payload) => !shouldEncryptPayload(payload)), true);
  assert.equal(shouldEncryptPayload({
    kind: "user_input",
    sessionId: "session_1",
    input: {
      type: "text",
      inputId: "input_1",
      text: "hello"
    }
  }), true);
});

const memoryStorage = (): KeyValueStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
};
