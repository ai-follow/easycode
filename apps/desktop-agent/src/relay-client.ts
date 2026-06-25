import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  CreatePairingResponseSchema,
  RelayEnvelopeSchema,
  type CreatePairingResponse,
  type RelayEnvelope,
  type RelayPayload
} from "@easycode/protocol";

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

  constructor(options: RelayClientOptions) {
    this.serverUrl = options.serverUrl;
    this.pairId = options.pairId;
    this.desktopToken = options.desktopToken;
    this.onEnvelope = options.onEnvelope;
  }

  async connect(): Promise<void> {
    const wsUrl = new URL("/v1/ws", this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("pairId", this.pairId);
    wsUrl.searchParams.set("role", "desktop");
    wsUrl.searchParams.set("token", this.desktopToken);

    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      this.ws?.once("open", () => resolve());
      this.ws?.once("error", reject);
    });

    this.ws.on("message", async (raw) => {
      const parsed = RelayEnvelopeSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) {
        console.error(`[desktop] ignored invalid relay envelope: ${parsed.error.message}`);
        return;
      }
      await this.onEnvelope(parsed.data);
    });
  }

  send(payload: RelayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay socket is not open");
    }

    const envelope: RelayEnvelope = {
      id: `env_${randomUUID()}`,
      pairId: this.pairId,
      source: "desktop",
      createdAt: new Date().toISOString(),
      payload
    };

    this.ws.send(JSON.stringify(envelope));
  }

  close(): void {
    this.ws?.close();
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
