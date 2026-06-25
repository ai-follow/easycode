import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type {
  ClaimPairingResponse,
  CreatePairingResponse,
  DeviceRole,
  RelayEnvelope
} from "@easycode/protocol";

export type RelayConnection = {
  id: string;
  role: DeviceRole;
  send: (envelope: RelayEnvelope) => void;
};

type PairingRecord = {
  pairId: string;
  pairingCode: string;
  desktopToken: string;
  mobileToken?: string;
  expiresAtMs: number;
  connections: Map<string, RelayConnection>;
  backlog: RelayEnvelope[];
  seenEnvelopeIds: Set<string>;
};

const PAIRING_TTL_MS = 10 * 60 * 1000;
const BACKLOG_LIMIT = 200;

const token = (): string => randomBytes(32).toString("base64url");
const pairingCode = (): string => String(randomInt(100000, 1000000));
const iso = (ms: number): string => new Date(ms).toISOString();

export class RelayStore {
  private readonly pairingsById = new Map<string, PairingRecord>();
  private readonly pairingsByCode = new Map<string, PairingRecord>();

  createPairing(): CreatePairingResponse {
    this.gcExpired();

    const expiresAtMs = Date.now() + PAIRING_TTL_MS;
    const record: PairingRecord = {
      pairId: `pair_${randomUUID()}`,
      pairingCode: this.createUniquePairingCode(),
      desktopToken: token(),
      expiresAtMs,
      connections: new Map(),
      backlog: [],
      seenEnvelopeIds: new Set()
    };

    this.pairingsById.set(record.pairId, record);
    this.pairingsByCode.set(record.pairingCode, record);

    return {
      pairId: record.pairId,
      pairingCode: record.pairingCode,
      desktopToken: record.desktopToken,
      expiresAt: iso(record.expiresAtMs)
    };
  }

  claimPairing(code: string): ClaimPairingResponse | undefined {
    this.gcExpired();
    const record = this.pairingsByCode.get(code);
    if (!record) return undefined;

    record.mobileToken ??= token();

    return {
      pairId: record.pairId,
      mobileToken: record.mobileToken,
      expiresAt: iso(record.expiresAtMs)
    };
  }

  authenticate(pairId: string, role: DeviceRole, providedToken: string): boolean {
    this.gcExpired();
    const record = this.pairingsById.get(pairId);
    if (!record) return false;
    if (role === "desktop") return providedToken === record.desktopToken;
    return Boolean(record.mobileToken) && providedToken === record.mobileToken;
  }

  addConnection(pairId: string, connection: RelayConnection): RelayEnvelope[] {
    const record = this.getRequiredPairing(pairId);
    record.connections.set(connection.id, connection);
    return [...record.backlog];
  }

  removeConnection(pairId: string, connectionId: string): void {
    const record = this.pairingsById.get(pairId);
    record?.connections.delete(connectionId);
  }

  acceptEnvelope(envelope: RelayEnvelope): { duplicate: boolean; recipients: RelayConnection[] } {
    const record = this.getRequiredPairing(envelope.pairId);
    if (record.seenEnvelopeIds.has(envelope.id)) {
      return { duplicate: true, recipients: [] };
    }

    record.seenEnvelopeIds.add(envelope.id);
    record.backlog.push(envelope);
    if (record.backlog.length > BACKLOG_LIMIT) {
      record.backlog.splice(0, record.backlog.length - BACKLOG_LIMIT);
    }

    const targetRole: DeviceRole = envelope.source === "desktop" ? "mobile" : "desktop";
    const recipients = [...record.connections.values()].filter((connection) => connection.role === targetRole);
    return { duplicate: false, recipients };
  }

  getStats(): { pairings: number; connections: number } {
    this.gcExpired();
    let connections = 0;
    for (const record of this.pairingsById.values()) connections += record.connections.size;
    return { pairings: this.pairingsById.size, connections };
  }

  private getRequiredPairing(pairId: string): PairingRecord {
    const record = this.pairingsById.get(pairId);
    if (!record) throw new Error(`Unknown pairId: ${pairId}`);
    return record;
  }

  private createUniquePairingCode(): string {
    let code = pairingCode();
    while (this.pairingsByCode.has(code)) code = pairingCode();
    return code;
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const record of this.pairingsById.values()) {
      if (record.mobileToken || record.expiresAtMs > now) continue;
      this.pairingsById.delete(record.pairId);
      this.pairingsByCode.delete(record.pairingCode);
    }
  }
}
