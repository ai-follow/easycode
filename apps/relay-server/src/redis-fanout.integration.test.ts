import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RelayEnvelope } from "@easycode/protocol";
import { RedisRelayFanoutBus, type RelayFanoutMessage } from "./fanout.js";

const redisTestUrl = process.env.EASYCODE_REDIS_TEST_URL;

test("redis relay fanout bus publishes envelopes to subscribers", {
  skip: redisTestUrl ? false : "Set EASYCODE_REDIS_TEST_URL to run the Redis fanout integration test"
}, async () => {
  assert.ok(redisTestUrl);
  const channel = `easycode:relay:fanout:test:${randomUUID()}`;
  const publisher = new RedisRelayFanoutBus({ redisUrl: redisTestUrl, channel });
  const subscriber = new RedisRelayFanoutBus({ redisUrl: redisTestUrl, channel });
  const received: RelayFanoutMessage[] = [];

  try {
    await subscriber.subscribe((message) => {
      received.push(message);
    });

    const envelope = testEnvelope();
    await publisher.publish({
      originId: "relay_integration_a",
      envelope
    });

    await waitFor(() => received.length === 1);
    assert.equal(received[0]?.originId, "relay_integration_a");
    assert.equal(received[0]?.envelope.id, envelope.id);
  } finally {
    await publisher.close();
    await subscriber.close();
  }
});

const testEnvelope = (): RelayEnvelope => ({
  id: `env_${randomUUID()}`,
  pairId: `pair_${randomUUID()}`,
  source: "mobile",
  createdAt: new Date().toISOString(),
  payload: {
    kind: "ping",
    nonce: randomUUID()
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for Redis fanout message");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
