import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayStore } from "./store.js";
import { isOriginAllowed, normalizeAllowedOrigins } from "./origins.js";

type RequestHandlerOptions = {
  adminToken?: string;
  allowedOrigins?: string[];
  heartbeatIntervalMs?: number;
  serviceVersion?: string;
  startedAt?: Date;
  readinessChecks?: Record<string, () => Promise<void>>;
};

const baseJsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-methods": "DELETE,GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-easycode-relay-token"
};

type ResponseHeaders = Record<string, string>;

const sendJson = (response: ServerResponse, statusCode: number, body: unknown, headers: ResponseHeaders): void => {
  response.writeHead(statusCode, headers);
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
    const headers = createResponseHeaders(request, options);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "OPTIONS") {
        if (!isCorsAllowed(request, options)) {
          sendJson(response, 403, { error: "Origin not allowed" }, headers);
          return;
        }
        response.writeHead(204, headers);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, await healthPayload(store, options), headers);
        return;
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const ready = await readinessPayload(store, options);
        sendJson(response, ready.ready ? 200 : 503, ready, headers);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/pairings") {
        if (!isAuthorized(request, options.adminToken)) {
          sendJson(response, 401, { error: "Unauthorized" }, headers);
          return;
        }
        sendJson(response, 201, await store.createPairing(), headers);
        return;
      }

      const deleteMatch = url.pathname.match(/^\/v1\/pairings\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch?.[1]) {
        const token = authToken(request);
        if (!token || !(await store.revokePairing(deleteMatch[1], token))) {
          sendJson(response, 401, { error: "Unauthorized" }, headers);
          return;
        }
        response.writeHead(204, headers);
        response.end();
        return;
      }

      const claimMatch = url.pathname.match(/^\/v1\/pairings\/([0-9]{6})\/claim$/);
      if (request.method === "POST" && claimMatch?.[1]) {
        await readBody(request);
        const claimed = await store.claimPairing(claimMatch[1]);
        if (!claimed) {
          sendJson(response, 404, { error: "Pairing code not found or expired" }, headers);
          return;
        }
        sendJson(response, 200, claimed, headers);
        return;
      }

      sendJson(response, 404, { error: "Not found" }, headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 500, { error: message }, headers);
    }
  };

const isAuthorized = (request: IncomingMessage, adminToken?: string): boolean => {
  if (!adminToken) return true;

  const bearerToken = authToken(request);
  const headerToken = request.headers["x-easycode-relay-token"];
  const explicitToken = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  return bearerToken === adminToken || explicitToken === adminToken;
};

const authToken = (request: IncomingMessage): string | undefined => {
  const authorization = request.headers.authorization ?? "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1];
};

const healthPayload = async (store: RelayStore, options: RequestHandlerOptions) => {
  const startedAt = options.startedAt ?? new Date();
  return {
    ok: true,
    service: "easycode-relay",
    version: options.serviceVersion ?? "0.1.0",
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
    startedAt: startedAt.toISOString(),
    adminTokenConfigured: Boolean(options.adminToken),
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    ...(await store.getStats())
  };
};

const readinessPayload = async (store: RelayStore, options: RequestHandlerOptions) => {
  const checks: Record<string, boolean> = {};
  const errors: Record<string, string> = {};

  try {
    await store.getStats();
    checks.store = true;
  } catch (error) {
    checks.store = false;
    errors.store = error instanceof Error ? error.message : String(error);
  }

  for (const [name, check] of Object.entries(options.readinessChecks ?? {})) {
    try {
      await check();
      checks[name] = true;
    } catch (error) {
      checks[name] = false;
      errors[name] = error instanceof Error ? error.message : String(error);
    }
  }

  const ready = Object.values(checks).every(Boolean);
  return {
    ready,
    checks,
    ...(Object.keys(errors).length > 0 ? { errors } : {})
  };
};

const createResponseHeaders = (request: IncomingMessage, options: RequestHandlerOptions): ResponseHeaders => {
  const headers: ResponseHeaders = { ...baseJsonHeaders };
  const origin = request.headers.origin;
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);

  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }

  if (origin && allowedOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  return headers;
};

const isCorsAllowed = (request: IncomingMessage, options: RequestHandlerOptions): boolean => {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) return true;

  const origin = request.headers.origin;
  return isOriginAllowed(typeof origin === "string" ? origin : undefined, allowedOrigins);
};
