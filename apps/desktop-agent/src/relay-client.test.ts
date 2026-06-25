import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import type { RelayEnvelope } from "@easycode/protocol";
import { DesktopRelayClient } from "./relay-client.js";

test("retries unacknowledged envelopes with the same id after reconnect", async () => {
  const received: RelayEnvelope[] = [];
  const harness = await createHarness((socket, envelope) => {
    received.push(envelope);
    if (received.length === 1) socket.close(4000, "drop before ack");
  });
  const client = createTestClient(harness.serverUrl);

  try {
    client.send({ kind: "ping", nonce: "retry-me" });
    await client.connect();

    await waitFor(() => received.length >= 2, "retried envelope");

    assert.equal(received[0]?.id, received[1]?.id);
    assert.deepEqual(received[1]?.payload, { kind: "ping", nonce: "retry-me" });
  } finally {
    client.close();
    await harness.close();
  }
});

test("does not retry acknowledged envelopes after reconnect", async () => {
  const received: RelayEnvelope[] = [];
  const harness = await createHarness((socket, envelope) => {
    received.push(envelope);
    socket.send(JSON.stringify(serverAck(envelope)));
    socket.close(4000, "closed after ack");
  });
  const client = createTestClient(harness.serverUrl);

  try {
    client.send({ kind: "ping", nonce: "ack-me" });
    await client.connect();

    await waitFor(() => received.length === 1, "first envelope");
    await sleep(80);

    assert.equal(received.length, 1);
  } finally {
    client.close();
    await harness.close();
  }
});

const createTestClient = (serverUrl: string): DesktopRelayClient =>
  new DesktopRelayClient({
    serverUrl,
    pairId: "pair_test",
    desktopToken: "token_test",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    onEnvelope: () => undefined
  });

async function createHarness(onEnvelope: (socket: WebSocket, envelope: RelayEnvelope) => void): Promise<{
  serverUrl: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      onEnvelope(socket, JSON.parse(raw.toString()) as RelayEnvelope);
    });
  });

  await listen(httpServer);
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("Harness server did not bind to a port");

  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const client of wss.clients) client.close();
      await closeWebSocketServer(wss);
      await closeHttpServer(httpServer);
    }
  };
}

const serverAck = (envelope: RelayEnvelope): RelayEnvelope => ({
  id: `server_ack_${envelope.id}`,
  pairId: envelope.pairId,
  source: "server",
  createdAt: new Date().toISOString(),
  payload: {
    kind: "ack",
    refId: envelope.id
  }
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
