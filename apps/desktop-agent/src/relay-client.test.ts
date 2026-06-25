import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RelayE2eeSession, type SerializedRelayE2eeSession } from "@easycode/e2ee";
import type { RelayEnvelope, RelayPayload } from "@easycode/protocol";
import { DesktopRelayClient, RelayAuthenticationError, revokePairing, type RelayE2eeSessionStore } from "./relay-client.js";

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

test("reconnects with the latest server sequence cursor", async () => {
  const upgradeUrls: string[] = [];
  const observedSeqs: number[] = [];
  let sentCursorEnvelope = false;
  const harness = await createHarness((socket, envelope) => {
    if (envelope.payload.kind === "ping") socket.close(4000, "reconnect with cursor");
  }, {
    onUpgrade: (url) => {
      upgradeUrls.push(url);
    },
    onConnection: (socket) => {
      if (sentCursorEnvelope) return;
      sentCursorEnvelope = true;
      socket.send(JSON.stringify({
        id: "env_mobile_cursor",
        pairId: "pair_test",
        serverSeq: 12,
        source: "mobile",
        createdAt: new Date().toISOString(),
        payload: {
          kind: "ping",
          nonce: "cursor"
        }
      }));
    }
  });
  const client = createTestClient(harness.serverUrl, {
    afterSeq: 5,
    onServerSeq: (serverSeq) => {
      observedSeqs.push(serverSeq);
    }
  });

  try {
    await client.connect();
    client.send({ kind: "ping", nonce: "force-reconnect" });
    await waitFor(() => upgradeUrls.length >= 2, "reconnect with updated afterSeq");

    assert.match(upgradeUrls[0] ?? "", /afterSeq=5/);
    assert.match(upgradeUrls[1] ?? "", /afterSeq=12/);
    assert.deepEqual(observedSeqs, [12]);
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

    const restoredMobileE2ee = await RelayE2eeSession.restore(await mobileE2ee.serialize());
    const mobileInputEnvelope = {
      id: "env_mobile_input",
      pairId: "pair_test",
      source: "mobile" as const,
      createdAt: new Date().toISOString()
    };
    desktopSocket.send(JSON.stringify({
      ...mobileInputEnvelope,
      payload: await restoredMobileE2ee.encryptEnvelopePayload(mobileInputEnvelope, {
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

test("e2ee mode restores desktop session state before sending business payloads", async () => {
  const received: RelayEnvelope[] = [];
  const decryptedByMobile: RelayPayload[] = [];
  const desktopE2ee = await RelayE2eeSession.create({
    role: "desktop",
    pairId: "pair_test"
  });
  const mobileE2ee = await RelayE2eeSession.create({
    role: "mobile",
    pairId: "pair_test"
  });
  await mobileE2ee.handleKeyExchange(await desktopE2ee.createHello());
  await desktopE2ee.handleKeyExchange(await mobileE2ee.createHello());

  const store = memoryE2eeStore(await desktopE2ee.serialize());
  const harness = await createHarness(async (_socket, envelope) => {
    received.push(envelope);
    if (envelope.payload.kind === "encrypted_payload") {
      decryptedByMobile.push(await mobileE2ee.decryptEnvelopePayload(envelope));
    }
  });
  const client = createTestClient(harness.serverUrl, {
    e2ee: true,
    e2eeStore: store
  });

  try {
    await client.connect();
    client.send({
      kind: "desktop_status",
      targets: [],
      sessions: [],
      capabilities: {}
    });

    await waitFor(() => decryptedByMobile.some((payload) => payload.kind === "desktop_status"), "restored encrypted desktop status");
    assert.equal(received.some((envelope) => envelope.payload.kind === "desktop_status"), false);
  } finally {
    client.close();
    await harness.close();
  }
});

test("reports invalid pairing when relay rejects desktop socket authentication", async () => {
  const harness = await createRejectingHarness(401);
  let invalidPairId = "";
  const client = createTestClient(harness.serverUrl, {
    onPairingInvalid: (pairId) => {
      invalidPairId = pairId;
    }
  });

  try {
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof RelayAuthenticationError && error.statusCode === 401
    );
    assert.equal(invalidPairId, "pair_test");
  } finally {
    client.close();
    await harness.close();
  }
});

test("revokePairing sends the desktop pair token to the relay", async () => {
  let method = "";
  let path = "";
  let authorization = "";
  const httpServer = createServer((request, response) => {
    method = request.method ?? "";
    path = request.url ?? "";
    authorization = request.headers.authorization ?? "";
    response.writeHead(204).end();
  });
  await listen(httpServer);
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("HTTP test server did not bind to a port");

  try {
    assert.equal(await revokePairing(`http://127.0.0.1:${address.port}`, "pair_test", "desktop_token_test"), true);
    assert.equal(method, "DELETE");
    assert.equal(path, "/v1/pairings/pair_test");
    assert.equal(authorization, "Bearer desktop_token_test");
  } finally {
    await closeHttpServer(httpServer);
  }
});

const createTestClient = (
  serverUrl: string,
  options: {
    afterSeq?: number;
    e2ee?: boolean;
    e2eeStore?: RelayE2eeSessionStore;
    onServerSeq?: (serverSeq: number, envelope: RelayEnvelope) => void | Promise<void>;
    onPairingInvalid?: (pairId: string) => void | Promise<void>;
    onEnvelope?: (envelope: RelayEnvelope) => void | Promise<void>;
  } = {}
): DesktopRelayClient =>
  new DesktopRelayClient({
    serverUrl,
    pairId: "pair_test",
    desktopToken: "token_test",
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    afterSeq: options.afterSeq,
    e2ee: options.e2ee,
    e2eeStore: options.e2eeStore,
    onServerSeq: options.onServerSeq,
    onPairingInvalid: options.onPairingInvalid,
    onEnvelope: options.onEnvelope ?? (() => undefined)
  });

const memoryE2eeStore = (initial?: SerializedRelayE2eeSession): RelayE2eeSessionStore => {
  let stored = initial;
  return {
    load: async () => stored,
    save: async (_pairId, session) => {
      stored = session;
    },
    delete: async () => {
      stored = undefined;
    }
  };
};

async function createHarness(
  onEnvelope: (socket: WebSocket, envelope: RelayEnvelope) => void | Promise<void>,
  options: {
    onUpgrade?: (url: string) => void;
    onConnection?: (socket: WebSocket) => void;
  } = {}
): Promise<{
  serverUrl: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    options.onUpgrade?.(request.url ?? "");
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    options.onConnection?.(socket);
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

async function createRejectingHarness(statusCode: number): Promise<{
  serverUrl: string;
  close: () => Promise<void>;
}> {
  const httpServer = createServer();
  httpServer.on("upgrade", (_request, socket) => {
    socket.write(`HTTP/1.1 ${statusCode} Unauthorized\r\n\r\n`);
    socket.destroy();
  });

  await listen(httpServer);
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("Rejecting harness server did not bind to a port");

  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
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
