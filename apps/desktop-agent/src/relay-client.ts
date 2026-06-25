import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  CreatePairingResponseSchema,
  PAIRING_REVOKED_CLOSE_CODE,
  PAIRING_REVOKED_CLOSE_REASON,
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
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  sendQueueLimit?: number;
};

export class DesktopRelayClient {
  private readonly serverUrl: string;
  private readonly pairId: string;
  private readonly desktopToken: string;
  private readonly onEnvelope: (envelope: RelayEnvelope) => void | Promise<void>;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly sendQueueLimit: number;
  private ws?: WebSocket;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private readonly sendQueue: RelayEnvelope[] = [];
  private readonly pendingAcks = new Map<string, RelayEnvelope>();

  constructor(options: RelayClientOptions) {
    this.serverUrl = options.serverUrl;
    this.pairId = options.pairId;
    this.desktopToken = options.desktopToken;
    this.onEnvelope = options.onEnvelope;
    this.reconnectBaseMs = positiveIntOrDefault(options.reconnectBaseMs, RECONNECT_BASE_MS);
    this.reconnectMaxMs = positiveIntOrDefault(options.reconnectMaxMs, RECONNECT_MAX_MS);
    this.sendQueueLimit = positiveIntOrDefault(options.sendQueueLimit, SEND_QUEUE_LIMIT);
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  send(payload: RelayPayload): void {
    this.sendEnvelope(this.createEnvelope(payload));
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

    const ws = new WebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${this.desktopToken}`
      }
    });
    this.ws = ws;

    this.connecting = new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
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
      if (parsed.data.payload.kind === "ack") {
        this.pendingAcks.delete(parsed.data.payload.refId);
        return;
      }
      if (parsed.data.payload.kind === "error" && parsed.data.payload.refId) {
        this.pendingAcks.delete(parsed.data.payload.refId);
        console.error(`[desktop] relay rejected envelope ${parsed.data.payload.refId}: ${parsed.data.payload.message}`);
        return;
      }
      await this.onEnvelope(parsed.data);
    });

    ws.on("error", (error) => {
      if (!this.closed) console.error(`[desktop] relay socket error: ${error.message}`);
    });

    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = undefined;
      if (code === PAIRING_REVOKED_CLOSE_CODE || reason.toString() === PAIRING_REVOKED_CLOSE_REASON) {
        this.stopReconnect();
        console.error("[desktop] relay pairing was revoked; reconnect stopped");
        return;
      }
      if (!this.closed) {
        this.requeuePendingAcks();
        this.scheduleReconnect();
      }
    });

    await this.connecting;
  }

  private createEnvelope(payload: RelayPayload): RelayEnvelope {
    return {
      id: `env_${randomUUID()}`,
      pairId: this.pairId,
      source: "desktop",
      createdAt: new Date().toISOString(),
      payload
    };
  }

  private sendEnvelope(envelope: RelayEnvelope): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.enqueue(envelope);
      this.scheduleReconnect();
      return;
    }

    this.pendingAcks.set(envelope.id, envelope);
    ws.send(JSON.stringify(envelope), (error) => {
      if (!error) return;
      this.pendingAcks.delete(envelope.id);
      this.enqueue(envelope);
      this.scheduleReconnect();
    });
  }

  private enqueue(envelope: RelayEnvelope): void {
    if (this.sendQueue.some((queued) => queued.id === envelope.id)) return;
    this.sendQueue.push(envelope);
    this.trimQueue();
  }

  private requeuePendingAcks(): void {
    const pending = [...this.pendingAcks.values()];
    this.pendingAcks.clear();
    for (const envelope of pending.reverse()) {
      if (this.sendQueue.some((queued) => queued.id === envelope.id)) continue;
      this.sendQueue.unshift(envelope);
    }
    this.trimQueue();
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const envelope of this.sendQueue.splice(0)) {
      this.sendEnvelope(envelope);
    }
  }

  private trimQueue(): void {
    if (this.sendQueue.length > this.sendQueueLimit) {
      this.sendQueue.splice(0, this.sendQueue.length - this.sendQueueLimit);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const attempt = Math.min(this.reconnectAttempt + 1, 5);
    this.reconnectAttempt = attempt;
    const delayMs = Math.min(this.reconnectBaseMs * 2 ** (attempt - 1), this.reconnectMaxMs);

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
    this.pendingAcks.clear();
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

const positiveIntOrDefault = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && typeof value === "number" && value > 0 ? value : fallback;
