import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RelayE2eeSession } from "@easycode/e2ee";
import type { RelayEnvelope, RelayPayload } from "@easycode/protocol";
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

test("e2ee mode exchanges keys, encrypts outgoing payloads, and decrypts incoming payloads", async () => {
  const received: RelayEnvelope[] = [];
  const decryptedByMobile: RelayPayload[] = [];
  const deliveredToDesktop: RelayEnvelope[] = [];
  const mobileE2ee = await RelayE2eeSession.create({
    role: "mobile",
    pairId: "pair_test"
  });
  let desktopSocket: WebSocket | undefined;
  let mobileHelloSent = false;

  const harness = await createHarness(async (socket, envelope) => {
    received.push(envelope);
    desktopSocket = socket;

    if (envelope.payload.kind === "key_exchange") {
      await mobileE2ee.handleKeyExchange(envelope.payload);
      return;
    }

    if (envelope.payload.kind === "encrypted_payload") {
      decryptedByMobile.push(await mobileE2ee.decryptEnvelopePayload(envelope));
    }
  });
  const client = createTestClient(harness.serverUrl, {
    e2ee: true,
    onEnvelope: (envelope) => {
      deliveredToDesktop.push(envelope);
    }
  });

  try {
    await client.connect();
    await waitFor(() => received.some((envelope) => envelope.payload.kind === "key_exchange"), "desktop key exchange hello");

    client.send({
      kind: "desktop_status",
      targets: [],
      sessions: [],
      capabilities: {}
    });
    await sleep(50);
    assert.equal(received.some((envelope) => envelope.payload.kind === "desktop_status"), false);

    if (!desktopSocket) throw new Error("Harness did not capture the desktop socket");
    const mobileHello: RelayEnvelope = {
      id: "env_mobile_hello",
      pairId: "pair_test",
      source: "mobile",
      createdAt: new Date().toISOString(),
      payload: await mobileE2ee.createHello()
    };
    desktopSocket.send(JSON.stringify(mobileHello));
    mobileHelloSent = true;

    await waitFor(() => decryptedByMobile.some((payload) => payload.kind === "desktop_status"), "encrypted desktop status");
    assert.equal(received.some((envelope) => envelope.payload.kind === "encrypted_payload"), true);

    const mobileInputEnvelope = {
      id: "env_mobile_input",
      pairId: "pair_test",
      source: "mobile" as const,
      createdAt: new Date().toISOString()
    };
    desktopSocket.send(JSON.stringify({
      ...mobileInputEnvelope,
      payload: await mobileE2ee.encryptEnvelopePayload(mobileInputEnvelope, {
        kind: "user_input",
        sessionId: "session_test",
        input: {
          type: "text",
          inputId: "input_test",
          text: "encrypted hello"
        }
      })
    }));

    await waitFor(() => deliveredToDesktop.some((envelope) => envelope.payload.kind === "user_input"), "decrypted mobile input");
    assert.equal(mobileHelloSent, true);
    assert.deepEqual(deliveredToDesktop[0]?.payload, {
      kind: "user_input",
      sessionId: "session_test",
      input: {
        type: "text",
        inputId: "input_test",
        text: "encrypted hello"
      }
    });
  } finally {
    client.close();
    await harness.close();
  }
});

const createTestClient = (
  serverUrl: string,
  options: {
    e2ee?: boolean;
    onEnvelope?: (envelope: RelayEnvelope) => void | Promise<void>;
  } = {}
): DesktopRelayClient =>
  new DesktopRelayClient({
    serverUrl,
    pairId: "pair_test",
    desktopToken: "token_test",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    e2ee: options.e2ee,
    onEnvelope: options.onEnvelope ?? (() => undefined)
  });

async function createHarness(onEnvelope: (socket: WebSocket, envelope: RelayEnvelope) => void | Promise<void>): Promise<{
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
      Promise.resolve(onEnvelope(socket, JSON.parse(raw.toString()) as RelayEnvelope)).catch((error) => {
        socket.emit("error", error);
      });
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
