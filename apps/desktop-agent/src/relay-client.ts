import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  CreatePairingResponseSchema,
  RelayEnvelopeSchema,
  type CreatePairingResponse,
  type RelayEnvelope,
  type RelayPayload
} from "@easycode/protocol";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const SEND_QUEUE_LIMIT = 200;

type RelayClientOptions = {
  serverUrl: string;
  pairId: string;
  desktopToken: string;
  onEnvelope: (envelope: RelayEnvelope) => void | Promise<void>;
};

export class DesktopRelayClient {
  private readonly serverUrl: string;
  private readonly pairId: string;
  private readonly desktopToken: string;
  private readonly onEnvelope: (envelope: RelayEnvelope) => void | Promise<void>;
  private ws?: WebSocket;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private readonly sendQueue: RelayPayload[] = [];

  constructor(options: RelayClientOptions) {
    this.serverUrl = options.serverUrl;
    this.pairId = options.pairId;
    this.desktopToken = options.desktopToken;
    this.onEnvelope = options.onEnvelope;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  send(payload: RelayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.enqueue(payload);
      this.scheduleReconnect();
      return;
    }

    this.sendEnvelope(payload);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
  }

  private async openSocket(): Promise<void> {
    if (this.connecting) return this.connecting;

    const wsUrl = new URL("/v1/ws", this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("pairId", this.pairId);
    wsUrl.searchParams.set("role", "desktop");
    wsUrl.searchParams.set("token", this.desktopToken);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    this.connecting = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        this.reconnectAttempt = 0;
        this.flushQueue();
        resolve();
      });
      ws.once("error", reject);
      ws.once("unexpected-response", (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          this.stopReconnect();
          reject(new Error(`Relay rejected desktop socket authentication: ${response.statusCode}`));
          return;
        }

        reject(new Error(`Unexpected relay socket response: ${response.statusCode}`));
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    ws.on("message", async (raw) => {
      const parsedJson = safeJson(raw.toString());
      const parsed = RelayEnvelopeSchema.safeParse(parsedJson);
      if (!parsed.success) {
        console.error(`[desktop] ignored invalid relay envelope: ${parsed.error.message}`);
        return;
      }
      await this.onEnvelope(parsed.data);
    });

    ws.on("error", (error) => {
      if (!this.closed) console.error(`[desktop] relay socket error: ${error.message}`);
    });

    ws.on("close", (_code, reason) => {
      if (this.ws === ws) this.ws = undefined;
      if (reason.toString() === "Pairing revoked") {
        this.stopReconnect();
        console.error("[desktop] relay pairing was revoked; reconnect stopped");
        return;
      }
      if (!this.closed) this.scheduleReconnect();
    });

    await this.connecting;
  }

  private sendEnvelope(payload: RelayPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.enqueue(payload);
      this.scheduleReconnect();
      return;
    }

    const envelope: RelayEnvelope = {
      id: `env_${randomUUID()}`,
      pairId: this.pairId,
      source: "desktop",
      createdAt: new Date().toISOString(),
      payload
    };

    ws.send(JSON.stringify(envelope));
  }

  private enqueue(payload: RelayPayload): void {
    this.sendQueue.push(payload);
    if (this.sendQueue.length > SEND_QUEUE_LIMIT) {
      this.sendQueue.splice(0, this.sendQueue.length - SEND_QUEUE_LIMIT);
    }
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const payload of this.sendQueue.splice(0)) {
      this.sendEnvelope(payload);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const attempt = Math.min(this.reconnectAttempt + 1, 5);
    this.reconnectAttempt = attempt;
    const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket().catch((error) => {
        console.error(`[desktop] relay reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private stopReconnect(): void {
    this.closed = true;
    this.sendQueue.length = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

export const createPairing = async (serverUrl: string, relayToken?: string): Promise<CreatePairingResponse> => {
  const headers = new Headers({
    "content-type": "application/json"
  });
  if (relayToken) headers.set("authorization", `Bearer ${relayToken}`);

  const response = await fetch(new URL("/v1/pairings", serverUrl), {
    method: "POST",
    headers,
    body: "{}"
  });

  if (!response.ok) {
    throw new Error(`Failed to create pairing: ${response.status} ${await response.text()}`);
  }

  return CreatePairingResponseSchema.parse(await response.json());
};

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};
