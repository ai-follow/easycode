import { spawn } from "node:child_process";
import { connect as createConnection, createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { RelayE2eeSession } from "../packages/e2ee/dist/index.js";
import { PAIRING_REVOKED_CLOSE_CODE, PAIRING_REVOKED_CLOSE_REASON } from "../packages/protocol/dist/index.js";

const root = new URL("..", import.meta.url);
const port = await findOpenPort();
const serverUrl = `http://localhost:${port}`;
const relayAdminToken = "e2e-relay-admin-token";
const processes = [];

try {
  const relay = spawnManaged("relay", "node", ["apps/relay-server/dist/index.js"], {
    PORT: String(port),
    EASYCODE_RELAY_ADMIN_TOKEN: relayAdminToken,
    EASYCODE_ALLOWED_ORIGINS: "https://allowed.example"
  });
  await relay.waitForOutput(/listening/);

  const deniedOriginStatus = await websocketUpgradeStatus(serverUrl, "https://denied.example");
  if (deniedOriginStatus !== 403) {
    throw new Error(`Expected denied WebSocket Origin to return 403, got ${deniedOriginStatus}`);
  }

  const unauthorizedPairing = await fetch(`${serverUrl}/v1/pairings`, {
    method: "POST"
  });
  if (unauthorizedPairing.status !== 401) {
    throw new Error(`Expected unauthorized pairing creation to return 401, got ${unauthorizedPairing.status}`);
  }

  const desktop = spawnManaged("desktop", "node", [
    "apps/desktop-agent/dist/index.js",
    "--adapter",
    "mock",
    "--server",
    serverUrl,
    "--relay-token",
    relayAdminToken
  ], {
    EASYCODE_E2EE: "1"
  });
  const pairingOutput = await desktop.waitForOutput(/pairing code:\s*(\d{6})/);
  const pairingCode = pairingOutput.match(/pairing code:\s*(\d{6})/)?.[1];
  if (!pairingCode) throw new Error("Desktop agent did not print a pairing code");

  const claim = await fetch(`${serverUrl}/v1/pairings/${pairingCode}/claim`, {
    method: "POST"
  });
  if (!claim.ok) throw new Error(`Failed to claim pairing: ${claim.status} ${await claim.text()}`);

  const { pairId, mobileToken } = await claim.json();
  const first = await connectMobile(serverUrl, pairId, mobileToken);
  const snapshot = await waitFor(first.received, (envelope) => envelope.payload.kind === "session_snapshot", "session snapshot");
  const sessionId = snapshot.payload.sessionId;
  const seqAfterSnapshot = maxServerSeq(first.received);

  first.ws.send(
    JSON.stringify({
      id: `env_${randomUUID()}`,
      pairId,
      source: "desktop",
      createdAt: new Date().toISOString(),
      payload: {
        kind: "ping",
        nonce: "wrong-source"
      }
    })
  );
  await waitFor(
    first.received,
    (envelope) =>
      envelope.payload.kind === "error" &&
      envelope.payload.message.includes("Envelope pairId/source does not match the authenticated socket"),
    "relay source mismatch error"
  );

  const textPayload = {
    kind: "user_input",
    sessionId,
    input: {
      type: "text",
      inputId: `input_${randomUUID()}`,
      text: "hello from e2e smoke"
    }
  };
  const textEnvelopeId = await sendMobile(first, pairId, textPayload);
  await waitFor(
    first.received,
    (envelope) => envelope.payload.kind === "ack" && envelope.payload.refId === textEnvelopeId,
    "relay ack for text input"
  );

  const textEcho = (envelope) =>
    envelope.payload.kind === "client_event" &&
    envelope.payload.event.type === "message" &&
    envelope.payload.event.payload.text.includes("Echo from desktop client: hello from e2e smoke");

  await waitFor(
    first.received,
    textEcho,
    "mock assistant echo"
  );

  const ackCountBeforeDuplicate = countEnvelopes(
    first.received,
    (envelope) => envelope.payload.kind === "ack" && envelope.payload.refId === textEnvelopeId
  );
  await sendMobile(first, pairId, textPayload, textEnvelopeId);
  await waitFor(
    first.received,
    () =>
      countEnvelopes(
        first.received,
        (envelope) => envelope.payload.kind === "ack" && envelope.payload.refId === textEnvelopeId
      ) > ackCountBeforeDuplicate,
    "relay ack for duplicate text input"
  );
  await sleep(450);
  const textEchoCount = countEnvelopes(first.received, textEcho);
  if (textEchoCount !== 1) {
    throw new Error(`Expected duplicate envelope to be deduped before desktop delivery, got ${textEchoCount} echoes`);
  }

  await sendMobile(first, pairId, {
    kind: "user_input",
    sessionId,
    input: {
      type: "text",
      inputId: `input_${randomUUID()}`,
      text: "/request"
    }
  });

  const interactionEnvelope = await waitFor(
    first.received,
    (envelope) => envelope.payload.kind === "client_event" && envelope.payload.event.type === "interaction_request",
    "interaction request"
  );
  const interaction = interactionEnvelope.payload.event.payload;
  const option = interaction.options[0];
  if (!option) throw new Error("Interaction request had no options");

  await sendMobile(first, pairId, {
    kind: "user_input",
    sessionId,
    input: {
      type: "interaction_response",
      inputId: `input_${randomUUID()}`,
      requestId: interaction.id,
      optionId: option.id,
      value: option.value
    }
  });

  await waitFor(
    first.received,
    (envelope) =>
      envelope.payload.kind === "client_event" &&
      envelope.payload.event.type === "message" &&
      envelope.payload.event.payload.text.includes("Interaction response delivered"),
    "interaction response delivery"
  );

  first.ws.close();

  const replay = await connectMobile(serverUrl, pairId, mobileToken, seqAfterSnapshot, first.e2ee);
  await sleep(400);
  const replayedSeqs = replay.received.map((envelope) => envelope.serverSeq ?? 0);
  if (replayedSeqs.length === 0) throw new Error("Expected replayed envelopes after reconnect cursor");
  if (!replayedSeqs.every((seq) => seq > seqAfterSnapshot)) {
    throw new Error(`Replay returned an envelope before cursor ${seqAfterSnapshot}: ${replayedSeqs.join(",")}`);
  }
  replay.ws.close();

  const revoked = await connectMobile(serverUrl, pairId, mobileToken, maxServerSeq(replay.received), replay.e2ee);
  const revokedClose = waitForClose(revoked.ws);
  const revoke = await fetch(`${serverUrl}/v1/pairings/${pairId}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${mobileToken}`
    }
  });
  if (revoke.status !== 204) throw new Error(`Expected pairing revoke to return 204, got ${revoke.status}`);
  const closeEvent = await revokedClose;
  if (closeEvent.code !== PAIRING_REVOKED_CLOSE_CODE || closeEvent.reason !== PAIRING_REVOKED_CLOSE_REASON) {
    throw new Error(`Expected revoke close ${PAIRING_REVOKED_CLOSE_CODE}/${PAIRING_REVOKED_CLOSE_REASON}, got ${closeEvent.code}/${closeEvent.reason}`);
  }

  console.log(`e2e smoke ok pair=${pairId} session=${sessionId} replayed=${replayedSeqs.join(",")}`);
} finally {
  for (const child of processes.reverse()) child.kill("SIGTERM");
}

function spawnManaged(label, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  processes.push(child);

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  child.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") return;
    console.error(`[${label}] exited code=${code} signal=${signal}\n${output}`);
  });

  return {
    waitForOutput: (pattern, timeoutMs = 5000) =>
      waitForText(() => output, pattern, `${label} output ${pattern.toString()}`, timeoutMs),
    kill: (signal) => {
      if (!child.killed) child.kill(signal);
    }
  };
}

async function connectMobile(serverUrl, pairId, mobileToken, afterSeq = 0, e2ee) {
  const wsUrl = new URL("/v1/ws", serverUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("pairId", pairId);
  wsUrl.searchParams.set("role", "mobile");
  wsUrl.searchParams.set("token", mobileToken);
  if (afterSeq > 0) wsUrl.searchParams.set("afterSeq", String(afterSeq));

  const ws = new WebSocket(wsUrl);
  const mobileE2ee = e2ee ?? await RelayE2eeSession.create({
    role: "mobile",
    pairId
  });
  const received = [];
  const rawReceived = [];
  const errors = [];
  ws.addEventListener("message", (event) => {
    void handleMobileEnvelope(ws, mobileE2ee, received, rawReceived, JSON.parse(String(event.data))).catch((error) => {
      errors.push(error);
    });
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`Failed to connect ${wsUrl}`)), { once: true });
  });

  return { ws, received, rawReceived, errors, e2ee: mobileE2ee };
}

function websocketUpgradeStatus(serverUrl, origin, timeoutMs = 5000) {
  const url = new URL("/v1/ws?pairId=pair_origin_check&role=mobile&token=wrong", serverUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname;
  const key = randomBytes(16).toString("base64");

  return new Promise((resolve, reject) => {
    const socket = createConnection(port, host, () => {
      socket.write(
        [
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${key}`,
          `Origin: ${origin}`,
          "",
          ""
        ].join("\r\n")
      );
    });

    let response = "";
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`Timed out waiting for WebSocket upgrade status from ${url}`));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const status = response.match(/^HTTP\/1\.1\s+(\d{3})/);
      if (!status?.[1]) return;
      socket.end();
      resolve(Number(status[1]));
    });
    socket.on("error", reject);
  });
}

async function handleMobileEnvelope(ws, e2ee, received, rawReceived, envelope) {
  rawReceived.push(envelope);

  if (envelope.payload.kind === "key_exchange") {
    await e2ee.handleKeyExchange(envelope.payload);
    ws.send(JSON.stringify({
      id: `env_${randomUUID()}`,
      pairId: envelope.pairId,
      source: "mobile",
      createdAt: new Date().toISOString(),
      payload: await e2ee.createHello()
    }));
    return;
  }

  if (envelope.payload.kind === "encrypted_payload") {
    envelope = {
      ...envelope,
      payload: await e2ee.decryptEnvelopePayload(envelope)
    };
  }

  received.push(envelope);
}

async function sendMobile(mobile, pairId, payload, id = `env_${randomUUID()}`) {
  const envelope = {
    id,
    pairId,
    source: "mobile",
    createdAt: new Date().toISOString(),
    payload
  };
  if (mobile.e2ee.ready && shouldEncryptPayload(payload)) {
    envelope.payload = await mobile.e2ee.encryptEnvelopePayload(envelope, payload);
  }
  mobile.ws.send(JSON.stringify(envelope));
  return id;
}

function shouldEncryptPayload(payload) {
  return !["ack", "error", "ping", "key_exchange", "encrypted_payload"].includes(payload.kind);
}

function countEnvelopes(envelopes, predicate) {
  return envelopes.filter(predicate).length;
}

function waitFor(received, predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const found = received.find(predicate);
      if (found) {
        clearInterval(interval);
        resolve(found);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 50);
  });
}

function waitForText(read, pattern, label, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const output = read();
      if (pattern.test(output)) {
        clearInterval(interval);
        resolve(output);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for ${label}\n${output}`));
      }
    }, 50);
  });
}

function waitForClose(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
}

function maxServerSeq(envelopes) {
  return Math.max(0, ...envelopes.map((envelope) => envelope.serverSeq ?? 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOpenPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selectedPort = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!selectedPort) throw new Error("Failed to allocate an open port");
  return selectedPort;
}
