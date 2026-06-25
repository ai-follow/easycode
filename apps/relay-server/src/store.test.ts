import assert from "node:assert/strict";
import test from "node:test";
import type { RelayEnvelope } from "@easycode/protocol";
import { createRelayStore, MemoryRelayStore, PostgresRelayStore } from "./store.js";

test("assigns server sequence numbers and filters backlog by cursor", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();

  const first = envelope(pairing.pairId, "one");
  const second = envelope(pairing.pairId, "two");

  const firstAccepted = await store.acceptEnvelope(first);
  const secondAccepted = await store.acceptEnvelope(second);

  assert.equal(firstAccepted.envelope?.serverSeq, 1);
  assert.equal(secondAccepted.envelope?.serverSeq, 2);

  const backlog = await store.addConnection(
    pairing.pairId,
    {
      id: "mobile_1",
      role: "mobile",
      send: () => undefined
    },
    1
  );

  assert.equal(backlog.length, 1);
  assert.equal(backlog[0]?.id, second.id);
});

test("ignores duplicate envelope ids", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();
  const item = envelope(pairing.pairId, "same");

  assert.equal((await store.acceptEnvelope(item)).duplicate, false);
  assert.equal((await store.acceptEnvelope(item)).duplicate, true);

  const backlog = await store.addConnection(pairing.pairId, {
    id: "desktop_1",
    role: "desktop",
    send: () => undefined
  });

  assert.equal(backlog.length, 1);
});

test("trims backlog to the configured limit", async () => {
  const store = new MemoryRelayStore({ backlogLimit: 2 });
  const pairing = await store.createPairing();

  await store.acceptEnvelope(envelope(pairing.pairId, "one"));
  await store.acceptEnvelope(envelope(pairing.pairId, "two"));
  await store.acceptEnvelope(envelope(pairing.pairId, "three"));

  const backlog = await store.addConnection(pairing.pairId, {
    id: "mobile_1",
    role: "mobile",
    send: () => undefined
  });

  assert.deepEqual(
    backlog.map((item) => item.id),
    ["env_two", "env_three"]
  );
});

test("trims duplicate tracking to the configured limit", async () => {
  const store = new MemoryRelayStore({ dedupeLimit: 2 });
  const pairing = await store.createPairing();
  const first = envelope(pairing.pairId, "one");
  const second = envelope(pairing.pairId, "two");
  const third = envelope(pairing.pairId, "three");

  assert.equal((await store.acceptEnvelope(first)).duplicate, false);
  assert.equal((await store.acceptEnvelope(second)).duplicate, false);
  assert.equal((await store.acceptEnvelope(third)).duplicate, false);

  assert.equal((await store.acceptEnvelope(first)).duplicate, false);
  assert.equal((await store.acceptEnvelope(third)).duplicate, true);
});

test("uses configured pairing ttl", async () => {
  const store = new MemoryRelayStore({ pairingTtlMs: 1234 });
  const before = Date.now();
  const pairing = await store.createPairing();
  const expiresAt = new Date(pairing.expiresAt).getTime();

  assert.ok(expiresAt >= before + 1234);
  assert.ok(expiresAt < before + 2500);
});

test("allows a pairing code to be claimed only once", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();

  const firstClaim = await store.claimPairing(pairing.pairingCode);
  const secondClaim = await store.claimPairing(pairing.pairingCode);

  assert.ok(firstClaim);
  assert.equal(firstClaim.pairId, pairing.pairId);
  assert.equal(secondClaim, undefined);
  assert.equal(await store.authenticate(pairing.pairId, "mobile", firstClaim.mobileToken), true);
});

test("stores pair tokens as hashes", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();
  const claim = await store.claimPairing(pairing.pairingCode);
  assert.ok(claim);

  assert.equal(await store.authenticate(pairing.pairId, "desktop", pairing.desktopToken), true);
  assert.equal(await store.authenticate(pairing.pairId, "mobile", claim.mobileToken), true);

  const records = (store as unknown as {
    pairingsById: Map<string, { desktopTokenHash: string; mobileTokenHash?: string; desktopToken?: string; mobileToken?: string }>;
  }).pairingsById;
  const stored = records.get(pairing.pairId);

  assert.ok(stored);
  assert.equal(stored.desktopToken, undefined);
  assert.equal(stored.mobileToken, undefined);
  assert.notEqual(stored.desktopTokenHash, pairing.desktopToken);
  assert.notEqual(stored.mobileTokenHash, claim.mobileToken);
});

test("revokes a pairing with a desktop or mobile token", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();
  const claim = await store.claimPairing(pairing.pairingCode);
  assert.ok(claim);

  let closed = false;
  await store.addConnection(pairing.pairId, {
    id: "mobile_1",
    role: "mobile",
    send: () => undefined,
    close: () => {
      closed = true;
    }
  });

  assert.equal(await store.revokePairing(pairing.pairId, "wrong-token"), false);
  assert.equal(await store.authenticate(pairing.pairId, "mobile", claim.mobileToken), true);

  assert.equal(await store.revokePairing(pairing.pairId, claim.mobileToken), true);
  assert.equal(closed, true);
  assert.equal(await store.authenticate(pairing.pairId, "mobile", claim.mobileToken), false);
  assert.equal(await store.revokePairing(pairing.pairId, claim.mobileToken), false);
});

test("creates the configured relay store driver", async () => {
  assert.ok(createRelayStore() instanceof MemoryRelayStore);
  assert.ok(createRelayStore("memory") instanceof MemoryRelayStore);
  assert.throws(() => createRelayStore("postgres"), /requires EASYCODE_POSTGRES_URL/);
  const postgresStore = createRelayStore("postgres", { postgresUrl: "postgres://easycode:easycode@localhost:5432/easycode" });
  assert.ok(postgresStore instanceof PostgresRelayStore);
  await postgresStore.close?.();
  assert.throws(() => createRelayStore("redis"), /Unsupported relay store driver "redis"/);
});

const envelope = (pairId: string, id: string): RelayEnvelope => ({
  id: `env_${id}`,
  pairId,
  source: "desktop",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    kind: "ping",
    nonce: id
  }
});
