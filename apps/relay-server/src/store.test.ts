import assert from "node:assert/strict";
import test from "node:test";
import type { RelayEnvelope } from "@easycode/protocol";
import { RelayStore } from "./store.js";

test("assigns server sequence numbers and filters backlog by cursor", () => {
  const store = new RelayStore();
  const pairing = store.createPairing();

  const first = envelope(pairing.pairId, "one");
  const second = envelope(pairing.pairId, "two");

  const firstAccepted = store.acceptEnvelope(first);
  const secondAccepted = store.acceptEnvelope(second);

  assert.equal(firstAccepted.envelope?.serverSeq, 1);
  assert.equal(secondAccepted.envelope?.serverSeq, 2);

  const backlog = store.addConnection(
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

test("ignores duplicate envelope ids", () => {
  const store = new RelayStore();
  const pairing = store.createPairing();
  const item = envelope(pairing.pairId, "same");

  assert.equal(store.acceptEnvelope(item).duplicate, false);
  assert.equal(store.acceptEnvelope(item).duplicate, true);

  const backlog = store.addConnection(pairing.pairId, {
    id: "desktop_1",
    role: "desktop",
    send: () => undefined
  });

  assert.equal(backlog.length, 1);
});

test("allows a pairing code to be claimed only once", () => {
  const store = new RelayStore();
  const pairing = store.createPairing();

  const firstClaim = store.claimPairing(pairing.pairingCode);
  const secondClaim = store.claimPairing(pairing.pairingCode);

  assert.ok(firstClaim);
  assert.equal(firstClaim.pairId, pairing.pairId);
  assert.equal(secondClaim, undefined);
  assert.equal(store.authenticate(pairing.pairId, "mobile", firstClaim.mobileToken), true);
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
