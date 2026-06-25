import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelayEnvelope } from "@easycode/protocol";
import { MobileOutbox } from "./mobileOutbox.js";

test("mobile outbox queues disconnected envelopes, dedupes ids, and trims oldest entries", () => {
  const outbox = new MobileOutbox(2);

  assert.equal(outbox.enqueue(envelope("env_1")), true);
  assert.equal(outbox.enqueue(envelope("env_1")), false);
  assert.equal(outbox.enqueue(envelope("env_2")), true);
  assert.equal(outbox.enqueue(envelope("env_3")), true);

  assert.equal(outbox.pendingCount, 2);
  assert.deepEqual(outbox.takeQueued().map((item) => item.id), ["env_2", "env_3"]);
  assert.equal(outbox.pendingCount, 0);
});

test("mobile outbox tracks pending acks and clears accepted envelopes", () => {
  const outbox = new MobileOutbox();
  outbox.trackPending(envelope("env_1"));

  assert.equal(outbox.pendingCount, 1);
  assert.equal(outbox.ack("env_1"), true);
  assert.equal(outbox.ack("env_1"), false);
  assert.equal(outbox.pendingCount, 0);
});

test("mobile outbox requeues pending envelopes in original send order after reconnect", () => {
  const outbox = new MobileOutbox();
  outbox.trackPending(envelope("env_1"));
  outbox.trackPending(envelope("env_2"));

  outbox.requeuePending();

  assert.equal(outbox.pendingCount, 2);
  assert.deepEqual(outbox.takeQueued().map((item) => item.id), ["env_1", "env_2"]);
});

test("mobile outbox removes relay rejected envelopes from queue or pending acks", () => {
  const outbox = new MobileOutbox();
  outbox.enqueue(envelope("env_queued"));
  outbox.trackPending(envelope("env_pending"));

  assert.equal(outbox.reject("env_queued"), true);
  assert.equal(outbox.reject("env_pending"), true);
  assert.equal(outbox.reject("env_missing"), false);
  assert.equal(outbox.pendingCount, 0);
});

test("mobile outbox clear drops queued and pending envelopes", () => {
  const outbox = new MobileOutbox();
  outbox.enqueue(envelope("env_queued"));
  outbox.trackPending(envelope("env_pending"));

  outbox.clear();

  assert.equal(outbox.pendingCount, 0);
  assert.deepEqual(outbox.takeQueued(), []);
});

const envelope = (id: string): RelayEnvelope => ({
  id,
  pairId: "pair_test",
  source: "mobile",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    kind: "ping",
    nonce: id
  }
});
