import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayStore } from "./store.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
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
  (store: RelayStore) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "OPTIONS") {
        response.writeHead(204, jsonHeaders);
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, ...store.getStats() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/pairings") {
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
