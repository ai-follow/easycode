import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RelayEnvelope } from "@easycode/protocol";
import { PostgresRelayStore } from "./store.js";

const postgresTestUrl = process.env.EASYCODE_POSTGRES_TEST_URL;

test("postgres relay store persists pairing, envelopes, replay, and revocation", {
  skip: postgresTestUrl ? false : "Set EASYCODE_POSTGRES_TEST_URL to run the PostgreSQL integration test"
}, async () => {
  assert.ok(postgresTestUrl);
  const store = new PostgresRelayStore({
    postgresUrl: postgresTestUrl,
    backlogLimit: 2,
    dedupeLimit: 3
  });

  try {
    const pairing = await store.createPairing();
    const claim = await store.claimPairing(pairing.pairingCode);
    assert.ok(claim);
    assert.equal(await store.authenticate(pairing.pairId, "desktop", pairing.desktopToken), true);
    assert.equal(await store.authenticate(pairing.pairId, "mobile", claim.mobileToken), true);

    const forwarded: RelayEnvelope[] = [];
    let closed = false;
    await store.addConnection(pairing.pairId, {
      id: "mobile_integration",
      role: "mobile",
      send: (envelope) => forwarded.push(envelope),
      close: () => {
        closed = true;
      }
    });

    const first = envelope(pairing.pairId, "one");
    const firstAccepted = await store.acceptEnvelope(first);
    assert.equal(firstAccepted.duplicate, false);
    assert.equal(firstAccepted.envelope?.serverSeq, 1);
    assert.equal(forwarded[0]?.id, first.id);
    assert.equal((await store.acceptEnvelope(first)).duplicate, true);

    await store.acceptEnvelope(envelope(pairing.pairId, "two"));
    await store.acceptEnvelope(envelope(pairing.pairId, "three"));

    const replay = await store.addConnection(pairing.pairId, {
      id: "mobile_replay",
      role: "mobile",
      send: () => undefined
    });
    assert.deepEqual(
      replay.map((item) => item.id),
      [`env_two_${testRunId}`, `env_three_${testRunId}`]
    );

    assert.equal(await store.revokePairing(pairing.pairId, claim.mobileToken), true);
    assert.equal(closed, true);
    assert.equal(await store.authenticate(pairing.pairId, "mobile", claim.mobileToken), false);
  } finally {
    await store.close();
  }
});

const testRunId = randomUUID();

const envelope = (pairId: string, id: string): RelayEnvelope => ({
  id: `env_${id}_${testRunId}`,
  pairId,
  source: "desktop",
  createdAt: new Date().toISOString(),
  payload: {
    kind: "ping",
    nonce: id
  }
});
