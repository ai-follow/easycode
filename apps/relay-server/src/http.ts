import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayStore } from "./store.js";

type RequestHandlerOptions = {
  adminToken?: string;
  heartbeatIntervalMs?: number;
  serviceVersion?: string;
  startedAt?: Date;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-easycode-relay-token"
};

const sendJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : {};
};

export const createRequestHandler =
  (store: RelayStore, options: RequestHandlerOptions = {}) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "OPTIONS") {
        response.writeHead(204, jsonHeaders);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, healthPayload(store, options));
        return;
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        sendJson(response, 200, {
          ready: true,
          checks: {
            store: true
          }
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/pairings") {
        if (!isAuthorized(request, options.adminToken)) {
          sendJson(response, 401, { error: "Unauthorized" });
          return;
        }
        sendJson(response, 201, store.createPairing());
        return;
      }

      const claimMatch = url.pathname.match(/^\/v1\/pairings\/([0-9]{6})\/claim$/);
      if (request.method === "POST" && claimMatch?.[1]) {
        await readBody(request);
        const claimed = store.claimPairing(claimMatch[1]);
        if (!claimed) {
          sendJson(response, 404, { error: "Pairing code not found or expired" });
          return;
        }
        sendJson(response, 200, claimed);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message });
    }
  };

const isAuthorized = (request: IncomingMessage, adminToken?: string): boolean => {
  if (!adminToken) return true;

  const authorization = request.headers.authorization ?? "";
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const headerToken = request.headers["x-easycode-relay-token"];
  const explicitToken = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  return bearerToken === adminToken || explicitToken === adminToken;
};

const healthPayload = (store: RelayStore, options: RequestHandlerOptions) => {
  const startedAt = options.startedAt ?? new Date();
  return {
    ok: true,
    service: "easycode-relay",
    version: options.serviceVersion ?? "0.1.0",
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
    startedAt: startedAt.toISOString(),
    adminTokenConfigured: Boolean(options.adminToken),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    ...store.getStats()
  };
};
