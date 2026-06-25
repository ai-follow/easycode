import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  DeviceRoleSchema,
  PAIRING_REVOKED_CLOSE_CODE,
  PAIRING_REVOKED_CLOSE_REASON,
  RelayEnvelopeSchema,
  type DeviceRole,
  type RelayEnvelope
} from "@easycode/protocol";
import { createRequestHandler } from "./http.js";
import { isOriginAllowed, parseAllowedOrigins } from "./origins.js";
import { createRelayStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const heartbeatIntervalMs = parsePositiveInt(process.env.EASYCODE_WS_HEARTBEAT_MS, 30000);
const startedAt = new Date();
const store = createRelayStore(process.env.EASYCODE_RELAY_STORE, {
  pairingTtlMs: parsePositiveInt(process.env.EASYCODE_PAIRING_TTL_MS, 10 * 60 * 1000),
  backlogLimit: parsePositiveInt(process.env.EASYCODE_RELAY_BACKLOG_LIMIT, 200)
});
const allowedOrigins = parseAllowedOrigins(process.env.EASYCODE_ALLOWED_ORIGINS);
const server = createServer(createRequestHandler(store, {
  adminToken: process.env.EASYCODE_RELAY_ADMIN_TOKEN,
  allowedOrigins,
  heartbeatIntervalMs,
  serviceVersion: process.env.npm_package_version,
  startedAt
}));
const wss = new WebSocketServer({ noServer: true });

type AliveWebSocket = WebSocket & {
  isAlive?: boolean;
};

const send = (connectionId: string, wsSend: (data: string) => void, envelope: RelayEnvelope): void => {
  try {
    wsSend(JSON.stringify(envelope));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown send error";
    console.error(`[relay] failed to send to ${connectionId}: ${message}`);
  }
};

server.on("upgrade", (request, socket, head) => {
  void handleUpgrade(request, socket, head).catch((error) => {
    console.error(`[relay] upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
    socket.destroy();
  });
});

const handleUpgrade = async (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/v1/ws") {
    socket.destroy();
    return;
  }

  const pairId = url.searchParams.get("pairId") ?? "";
  const roleResult = DeviceRoleSchema.safeParse(url.searchParams.get("role"));
  const token = upgradeAuthToken(request, url);
  const afterSeq = parseOptionalPositiveInt(url.searchParams.get("afterSeq"));
  const origin = headerValue(request.headers.origin);

  if (origin && !isOriginAllowed(origin, allowedOrigins)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!roleResult.success || !(await store.authenticate(pairId, roleResult.data, token))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    void handleConnection(ws, pairId, roleResult.data, afterSeq);
  });
};

const handleConnection = async (ws: WebSocket, pairId: string, role: DeviceRole, afterSeq?: number): Promise<void> => {
  const aliveWs = ws as AliveWebSocket;
  aliveWs.isAlive = true;
  aliveWs.on("pong", () => {
    aliveWs.isAlive = true;
  });

  const connectionId = `${role}_${randomUUID()}`;
  const backlog = await store.addConnection(pairId, {
    id: connectionId,
    role,
    send: (envelope) => send(connectionId, (data) => ws.send(data), envelope),
    close: () => ws.close(PAIRING_REVOKED_CLOSE_CODE, PAIRING_REVOKED_CLOSE_REASON)
  }, afterSeq);

  console.log(`[relay] ${role} connected pairId=${pairId} connection=${connectionId}`);

  for (const envelope of backlog) {
    if (envelope.source !== role) ws.send(JSON.stringify(envelope));
  }

  ws.on("message", async (raw: RawData) => {
    try {
      const parsedJson = safeJson(raw.toString());
      const parsed = RelayEnvelopeSchema.safeParse(parsedJson);
      if (!parsed.success) {
        ws.send(JSON.stringify(serverError(pairId, parsed.error.message)));
        return;
      }

      const envelope = parsed.data;
      if (envelope.pairId !== pairId || envelope.source !== role) {
        ws.send(JSON.stringify(serverError(pairId, "Envelope pairId/source does not match the authenticated socket", envelope.id)));
        return;
      }

      const accepted = await store.acceptEnvelope(envelope);
      if (accepted.duplicate) {
        ws.send(JSON.stringify(serverAck(pairId, envelope.id)));
        return;
      }
      if (!accepted.envelope) return;
      ws.send(JSON.stringify(serverAck(pairId, envelope.id)));
      for (const recipient of accepted.recipients) recipient.send(accepted.envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ws.send(JSON.stringify(serverError(pairId, message)));
    }
  });

  ws.on("close", () => {
    void store.removeConnection(pairId, connectionId);
    console.log(`[relay] ${role} disconnected pairId=${pairId} connection=${connectionId}`);
  });
};

server.listen(port, () => {
  console.log(`[relay] listening on http://localhost:${port}`);
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<AliveWebSocket>) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }

    client.isAlive = false;
    client.ping();
  }
}, heartbeatIntervalMs);

wss.on("close", () => {
  clearInterval(heartbeat);
});

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const parseOptionalPositiveInt = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const headerValue = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;

const upgradeAuthToken = (request: IncomingMessage, url: URL): string => {
  const authorization = headerValue(request.headers.authorization) ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? headerValue(request.headers["x-easycode-relay-token"]) ?? url.searchParams.get("token") ?? "";
};

const serverError = (pairId: string, message: string, refId?: string): RelayEnvelope => ({
  id: `server_${randomUUID()}`,
  pairId,
  source: "server",
  createdAt: new Date().toISOString(),
  payload: {
    kind: "error",
    message,
    refId
  }
});

const serverAck = (pairId: string, refId: string): RelayEnvelope => ({
  id: `server_${randomUUID()}`,
  pairId,
  source: "server",
  createdAt: new Date().toISOString(),
  payload: {
    kind: "ack",
    refId
  }
});
