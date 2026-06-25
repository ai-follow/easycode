import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayE2eeSession } from "@easycode/e2ee";
import type { RelayEnvelope, RelayPayload } from "@easycode/protocol";
import { createMobileE2eeSessionStore, MobileE2eeSessionManager } from "./mobileE2eeSession.js";
import { e2eeStorageKey, type KeyValueStorage } from "./mobileStorage.js";

const pairId = "pair_test";
const createdAt = "2026-01-01T00:00:00.000Z";

test("mobile e2ee manager completes key exchange, persists state, and encrypts outbound payloads", async () => {
  const storage = memoryStorage();
  const manager = new MobileE2eeSessionManager(createMobileE2eeSessionStore(storage));
  const desktop = await RelayE2eeSession.create({
    role: "desktop",
    pairId
  });

  const mobileHello = await manager.handleKeyExchange(pairId, await desktop.createHello());
  await desktop.handleKeyExchange(mobileHello);

  const clearPayload: RelayPayload = {
    kind: "user_input",
    sessionId: "session_test",
    input: {
      type: "text",
      inputId: "input_test",
      text: "hello from mobile"
    }
  };
  const envelope = createMobileEnvelope("env_mobile_1", clearPayload);
  const encrypted = await manager.prepareOutboundEnvelope(envelope);

  assert.equal(manager.ready, true);
  assert.equal(manager.currentPairId, pairId);
  assert.ok(storage.getItem(e2eeStorageKey(pairId)));
  assert.equal(encrypted.payload.kind, "encrypted_payload");
  assert.deepEqual(await desktop.decryptEnvelopePayload(encrypted), clearPayload);
});

test("mobile e2ee manager restores persisted state and decrypts desktop payloads", async () => {
  const storage = memoryStorage();
  const store = createMobileE2eeSessionStore(storage);
  const manager = new MobileE2eeSessionManager(store);
  const desktop = await RelayE2eeSession.create({
    role: "desktop",
    pairId
  });

  await desktop.handleKeyExchange(await manager.handleKeyExchange(pairId, await desktop.createHello()));

  const restored = new MobileE2eeSessionManager(store);
  await restored.restore(pairId);

  const clearPayload: RelayPayload = {
    kind: "desktop_status",
    targets: [],
    sessions: [],
    capabilities: {}
  };
  const envelope = createDesktopEnvelope("env_desktop_1", clearPayload);
  const encryptedEnvelope: RelayEnvelope = {
    ...envelope,
    payload: await desktop.encryptEnvelopePayload(envelope, clearPayload)
  };

  assert.equal(restored.ready, true);
  assert.deepEqual(await restored.decryptEnvelopePayload(encryptedEnvelope), clearPayload);
});

test("mobile e2ee manager leaves relay control frames unencrypted", async () => {
  const storage = memoryStorage();
  const manager = new MobileE2eeSessionManager(createMobileE2eeSessionStore(storage));
  const desktop = await RelayE2eeSession.create({
    role: "desktop",
    pairId
  });

  await desktop.handleKeyExchange(await manager.handleKeyExchange(pairId, await desktop.createHello()));

  const ping = createMobileEnvelope("env_ping", {
    kind: "ping",
    nonce: "control"
  });
  const session = await manager.ensure(pairId);
  const keyExchange = createMobileEnvelope("env_key_exchange", await session.createHello());

  assert.equal((await manager.prepareOutboundEnvelope(ping)).payload.kind, "ping");
  assert.equal((await manager.prepareOutboundEnvelope(keyExchange)).payload.kind, "key_exchange");
});

test("mobile e2ee manager drops invalid restored state", async () => {
  const storage = memoryStorage();
  storage.setItem(e2eeStorageKey(pairId), JSON.stringify({
    version: 1,
    role: "mobile",
    pairId,
    keyId: "pair:pair_test:payload:v1",
    publicKey: "not-a-public-key",
    privateKeyJwk: {
      kty: "EC"
    }
  }));

  const manager = new MobileE2eeSessionManager(createMobileE2eeSessionStore(storage));

  assert.equal(await manager.restore(pairId), undefined);
  assert.equal(storage.getItem(e2eeStorageKey(pairId)), null);
});

test("mobile e2ee manager rejects non-mobile stored state from custom stores", async () => {
  const removed: string[] = [];
  const manager = new MobileE2eeSessionManager({
    load: () => ({
      version: 1,
      role: "desktop",
      pairId,
      keyId: "pair:pair_test:payload:v1",
      publicKey: "not-used",
      privateKeyJwk: {
        kty: "EC"
      }
    }),
    save: () => undefined,
    remove: (nextPairId) => {
      removed.push(nextPairId);
    }
  });

  assert.equal(await manager.restore(pairId), undefined);
  assert.deepEqual(removed, [pairId]);
});

test("mobile e2ee manager forgets persisted and in-memory state for a pair", async () => {
  const storage = memoryStorage();
  const manager = new MobileE2eeSessionManager(createMobileE2eeSessionStore(storage));
  const desktop = await RelayE2eeSession.create({
    role: "desktop",
    pairId
  });

  await manager.handleKeyExchange(pairId, await desktop.createHello());
  manager.forget(pairId);

  assert.equal(manager.currentPairId, undefined);
  assert.equal(manager.ready, false);
  assert.equal(storage.getItem(e2eeStorageKey(pairId)), null);
});

const createMobileEnvelope = (id: string, payload: RelayPayload): RelayEnvelope => ({
  id,
  pairId,
  source: "mobile",
  createdAt,
  payload
});

const createDesktopEnvelope = (id: string, payload: RelayPayload): RelayEnvelope => ({
  id,
  pairId,
  source: "desktop",
  createdAt,
  payload
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
