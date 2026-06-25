import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const root = new URL("..", import.meta.url);
const port = await findOpenPort();
const serverUrl = `http://localhost:${port}`;
const relayAdminToken = "e2e-relay-admin-token";
const processes = [];

try {
  const relay = spawnManaged("relay", "node", ["apps/relay-server/dist/index.js"], {
    PORT: String(port),
    EASYCODE_RELAY_ADMIN_TOKEN: relayAdminToken
  });
  await relay.waitForOutput(/listening/);

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
  ]);
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

  sendMobile(first.ws, pairId, {
    kind: "user_input",
    sessionId,
    input: {
      type: "text",
      inputId: `input_${randomUUID()}`,
      text: "hello from e2e smoke"
    }
  });

  await waitFor(
    first.received,
    (envelope) =>
      envelope.payload.kind === "client_event" &&
      envelope.payload.event.type === "message" &&
      envelope.payload.event.payload.text.includes("Echo from desktop client"),
    "mock assistant echo"
  );

  sendMobile(first.ws, pairId, {
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

  sendMobile(first.ws, pairId, {
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

  const replay = await connectMobile(serverUrl, pairId, mobileToken, seqAfterSnapshot);
  await sleep(400);
  const replayedSeqs = replay.received.map((envelope) => envelope.serverSeq ?? 0);
  if (replayedSeqs.length === 0) throw new Error("Expected replayed envelopes after reconnect cursor");
  if (!replayedSeqs.every((seq) => seq > seqAfterSnapshot)) {
    throw new Error(`Replay returned an envelope before cursor ${seqAfterSnapshot}: ${replayedSeqs.join(",")}`);
  }
  replay.ws.close();

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

async function connectMobile(serverUrl, pairId, mobileToken, afterSeq = 0) {
  const wsUrl = new URL("/v1/ws", serverUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("pairId", pairId);
  wsUrl.searchParams.set("role", "mobile");
  wsUrl.searchParams.set("token", mobileToken);
  if (afterSeq > 0) wsUrl.searchParams.set("afterSeq", String(afterSeq));

  const ws = new WebSocket(wsUrl);
  const received = [];
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)));
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`Failed to connect ${wsUrl}`)), { once: true });
  });

  return { ws, received };
}

function sendMobile(ws, pairId, payload) {
  ws.send(
    JSON.stringify({
      id: `env_${randomUUID()}`,
      pairId,
      source: "mobile",
      createdAt: new Date().toISOString(),
      payload
    })
  );
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
