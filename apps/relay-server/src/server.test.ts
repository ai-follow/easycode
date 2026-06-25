import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import type { RelayEnvelope, RelayPayload } from "@easycode/protocol";
import { InMemoryRelayFanoutBus } from "./fanout.js";
import { createRelayServer } from "./server.js";
import { MemoryRelayStore } from "./store.js";

test("websocket handler acks duplicate envelopes without forwarding them twice", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();
  const claim = await store.claimPairing(pairing.pairingCode);
  assert.ok(claim);

  const relay = createRelayServer({
    store,
    heartbeatIntervalMs: 1000,
    logger: silentLogger
  });
  await listen(relay.server);

  const address = relay.server.address();
  if (typeof address !== "object" || !address) throw new Error("Relay test server did not bind to a port");
  const serverUrl = `http://127.0.0.1:${address.port}`;

  const desktop = await connectSocket(serverUrl, pairing.pairId, "desktop", pairing.desktopToken);
  const mobile = await connectSocket(serverUrl, pairing.pairId, "mobile", claim.mobileToken);
  const desktopReceived = collectMessages(desktop);
  const mobileReceived = collectMessages(mobile);

  try {
    const payload: RelayPayload = {
      kind: "user_input",
      sessionId: "session_test",
      input: {
        type: "text",
        inputId: `input_${randomUUID()}`,
        text: "dedupe me"
      }
    };
    const envelope = mobileEnvelope(pairing.pairId, "env_duplicate_test", payload);

    mobile.send(JSON.stringify(envelope));
    mobile.send(JSON.stringify(envelope));

    await waitFor(() => count(mobileReceived, (item) => item.payload.kind === "ack" && item.payload.refId === envelope.id) === 2);
    await waitFor(() => count(desktopReceived, (item) => item.id === envelope.id) === 1);
    await sleep(100);

    assert.equal(count(desktopReceived, (item) => item.id === envelope.id), 1);
  } finally {
    desktop.close();
    mobile.close();
    await relay.close();
  }
});

test("fanout bus forwards accepted envelopes to local recipients on another relay node", async () => {
  const store = new MemoryRelayStore();
  const pairing = await store.createPairing();
  const claim = await store.claimPairing(pairing.pairingCode);
  assert.ok(claim);

  const fanoutBus = new InMemoryRelayFanoutBus();
  const firstRelay = createRelayServer({
    store,
    fanoutBus,
    nodeId: "relay_a",
    heartbeatIntervalMs: 1000,
    logger: silentLogger
  });
  const secondRelay = createRelayServer({
    store,
    fanoutBus,
    nodeId: "relay_b",
    heartbeatIntervalMs: 1000,
    logger: silentLogger
  });
  await listen(firstRelay.server);
  await listen(secondRelay.server);

  const firstAddress = firstRelay.server.address();
  const secondAddress = secondRelay.server.address();
  if (typeof firstAddress !== "object" || !firstAddress) throw new Error("First relay test server did not bind to a port");
  if (typeof secondAddress !== "object" || !secondAddress) throw new Error("Second relay test server did not bind to a port");

  const mobile = await connectSocket(`http://127.0.0.1:${firstAddress.port}`, pairing.pairId, "mobile", claim.mobileToken);
  const desktop = await connectSocket(`http://127.0.0.1:${secondAddress.port}`, pairing.pairId, "desktop", pairing.desktopToken);
  const mobileReceived = collectMessages(mobile);
  const desktopReceived = collectMessages(desktop);

  try {
    const envelope = mobileEnvelope(pairing.pairId, "env_cross_node", {
      kind: "user_input",
      sessionId: "session_test",
      input: {
        type: "text",
        inputId: `input_${randomUUID()}`,
        text: "cross-node"
      }
    });

    mobile.send(JSON.stringify(envelope));

    await waitFor(() => count(mobileReceived, (item) => item.payload.kind === "ack" && item.payload.refId === envelope.id) === 1);
    await waitFor(() => count(desktopReceived, (item) => item.id === envelope.id) === 1);

    assert.equal(desktopReceived[0]?.payload.kind, "user_input");
  } finally {
    mobile.close();
    desktop.close();
    await firstRelay.close();
    await secondRelay.close();
  }
});

test("server readiness includes fanout bus health", async () => {
  const fanoutBus = new InMemoryRelayFanoutBus();
  fanoutBus.healthCheck = async () => {
    throw new Error("fanout down");
  };
  const relay = createRelayServer({
    store: new MemoryRelayStore(),
    fanoutBus,
    heartbeatIntervalMs: 1000,
    logger: silentLogger
  });
  await listen(relay.server);

  const address = relay.server.address();
  if (typeof address !== "object" || !address) throw new Error("Relay test server did not bind to a port");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
    const body = await response.json() as {
      ready: boolean;
      checks: Record<string, boolean>;
      errors: Record<string, string>;
    };

    assert.equal(response.status, 503);
    assert.equal(body.ready, false);
    assert.deepEqual(body.checks, {
      store: true,
      fanout: false
    });
    assert.deepEqual(body.errors, {
      fanout: "fanout down"
    });
  } finally {
    await relay.close();
  }
});

const silentLogger = {
  log: () => undefined,
  error: () => undefined
};

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function connectSocket(
  serverUrl: string,
  pairId: string,
  role: "desktop" | "mobile",
  token: string
): Promise<WebSocket> {
  const wsUrl = new URL("/v1/ws", serverUrl);
  wsUrl.protocol = "ws:";
  wsUrl.searchParams.set("pairId", pairId);
  wsUrl.searchParams.set("role", role);

  const headers = role === "desktop" ? { authorization: `Bearer ${token}` } : undefined;
  if (role === "mobile") wsUrl.searchParams.set("token", token);

  const socket = new WebSocket(wsUrl, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function collectMessages(socket: WebSocket): RelayEnvelope[] {
  const received: RelayEnvelope[] = [];
  socket.on("message", (raw) => {
    received.push(JSON.parse(raw.toString()) as RelayEnvelope);
  });
  return received;
}

const mobileEnvelope = (pairId: string, id: string, payload: RelayPayload): RelayEnvelope => ({
  id,
  pairId,
  source: "mobile",
  createdAt: new Date().toISOString(),
  payload
});

const count = (envelopes: RelayEnvelope[], predicate: (envelope: RelayEnvelope) => boolean): number =>
  envelopes.filter(predicate).length;

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for relay websocket condition");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
