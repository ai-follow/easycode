import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { RelayE2eeSession, type CleartextRelayPayload, type SerializedRelayE2eeSession } from "@easycode/e2ee";
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
  e2ee?: boolean;
  e2eeStore?: RelayE2eeSessionStore;
};

export type RelayE2eeSessionStore = {
  load(pairId: string): Promise<SerializedRelayE2eeSession | undefined>;
  save(pairId: string, session: SerializedRelayE2eeSession): Promise<void>;
  delete?(pairId: string): Promise<void>;
};

export class DesktopRelayClient {
  private readonly serverUrl: string;
  private readonly pairId: string;
  private readonly desktopToken: string;
  private readonly onEnvelope: (envelope: RelayEnvelope) => void | Promise<void>;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly sendQueueLimit: number;
  private readonly e2eeStore?: RelayE2eeSessionStore;
  private readonly e2eeSession?: Promise<RelayE2eeSession>;
  private ws?: WebSocket;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting?: Promise<void>;
  private readonly sendQueue: RelayEnvelope[] = [];
  private readonly pendingClearPayloads: RelayPayload[] = [];
  private readonly pendingAcks = new Map<string, RelayEnvelope>();

  constructor(options: RelayClientOptions) {
    this.serverUrl = options.serverUrl;
    this.pairId = options.pairId;
    this.desktopToken = options.desktopToken;
    this.onEnvelope = options.onEnvelope;
    this.reconnectBaseMs = positiveIntOrDefault(options.reconnectBaseMs, RECONNECT_BASE_MS);
    this.reconnectMaxMs = positiveIntOrDefault(options.reconnectMaxMs, RECONNECT_MAX_MS);
    this.sendQueueLimit = positiveIntOrDefault(options.sendQueueLimit, SEND_QUEUE_LIMIT);
    this.e2eeStore = options.e2eeStore;
    this.e2eeSession = options.e2ee
      ? this.createOrRestoreE2eeSession()
      : undefined;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  send(payload: RelayPayload): void {
    void this.sendPayload(payload).catch((error) => {
      console.error(`[desktop] failed to prepare relay payload: ${error instanceof Error ? error.message : String(error)}`);
    });
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
        void this.sendKeyExchangeHello().catch((error) => {
          console.error(`[desktop] failed to send key exchange hello: ${error instanceof Error ? error.message : String(error)}`);
        });
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
      if (parsed.data.payload.kind === "key_exchange") {
        await this.handleKeyExchange(parsed.data);
        return;
      }
      await this.deliverEnvelope(parsed.data);
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

  private async sendPayload(payload: RelayPayload): Promise<void> {
    const e2ee = this.e2eeSession ? await this.e2eeSession : undefined;
    if (!e2ee || !shouldEncryptPayload(payload)) {
      this.sendEnvelope(this.createEnvelope(payload));
      return;
    }

    if (!e2ee.ready) {
      this.pendingClearPayloads.push(payload);
      this.trimPendingClearPayloads();
      return;
    }

    const envelope = this.createEnvelope(payload);
    this.sendEnvelope({
      ...envelope,
      payload: await e2ee.encryptEnvelopePayload(envelope, payload as CleartextRelayPayload)
    });
  }

  private async sendKeyExchangeHello(): Promise<void> {
    const e2ee = this.e2eeSession ? await this.e2eeSession : undefined;
    if (!e2ee) return;
    this.sendEnvelope(this.createEnvelope(await e2ee.createHello()));
  }

  private async handleKeyExchange(envelope: RelayEnvelope): Promise<void> {
    const e2ee = this.e2eeSession ? await this.e2eeSession : undefined;
    if (!e2ee || envelope.payload.kind !== "key_exchange") return;
    await e2ee.handleKeyExchange(envelope.payload);
    await this.saveE2eeSession(e2ee);
    await this.flushPendingClearPayloads();
  }

  private async deliverEnvelope(envelope: RelayEnvelope): Promise<void> {
    const e2ee = this.e2eeSession ? await this.e2eeSession : undefined;
    if (!e2ee || envelope.payload.kind !== "encrypted_payload") {
      await this.onEnvelope(envelope);
      return;
    }
    await this.onEnvelope({
      ...envelope,
      payload: await e2ee.decryptEnvelopePayload(envelope)
    });
  }

  private async flushPendingClearPayloads(): Promise<void> {
    if (this.pendingClearPayloads.length === 0) return;
    const pending = this.pendingClearPayloads.splice(0);
    for (const payload of pending) await this.sendPayload(payload);
  }

  private async createOrRestoreE2eeSession(): Promise<RelayE2eeSession> {
    const stored = await this.e2eeStore?.load(this.pairId);
    if (stored?.role === "desktop" && stored.pairId === this.pairId) {
      try {
        return await RelayE2eeSession.restore(stored);
      } catch (error) {
        console.error(`[desktop] ignored invalid e2ee state for pair ${this.pairId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return RelayE2eeSession.create({
      role: "desktop",
      pairId: this.pairId
    });
  }

  private async saveE2eeSession(session: RelayE2eeSession): Promise<void> {
    await this.e2eeStore?.save(this.pairId, await session.serialize());
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

  private trimPendingClearPayloads(): void {
    if (this.pendingClearPayloads.length > this.sendQueueLimit) {
      this.pendingClearPayloads.splice(0, this.pendingClearPayloads.length - this.sendQueueLimit);
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
    this.pendingClearPayloads.length = 0;
    this.pendingAcks.clear();
    void this.e2eeStore?.delete?.(this.pairId).catch((error) => {
      console.error(`[desktop] failed to delete e2ee state for pair ${this.pairId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

const shouldEncryptPayload = (payload: RelayPayload): boolean =>
  payload.kind !== "ack" &&
  payload.kind !== "error" &&
  payload.kind !== "ping" &&
  payload.kind !== "key_exchange" &&
  payload.kind !== "encrypted_payload";

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
