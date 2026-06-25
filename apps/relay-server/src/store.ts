import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
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
  close?: () => void;
};

export type RelayStoreStats = {
  pairings: number;
  connections: number;
};

export type RelayStore = {
  createPairing(): Promise<CreatePairingResponse>;
  claimPairing(code: string): Promise<ClaimPairingResponse | undefined>;
  authenticate(pairId: string, role: DeviceRole, providedToken: string): Promise<boolean>;
  addConnection(pairId: string, connection: RelayConnection, afterSeq?: number): Promise<RelayEnvelope[]>;
  removeConnection(pairId: string, connectionId: string): Promise<void>;
  revokePairing(pairId: string, providedToken: string): Promise<boolean>;
  acceptEnvelope(envelope: RelayEnvelope): Promise<{ duplicate: boolean; envelope?: RelayEnvelope; recipients: RelayConnection[] }>;
  getStats(): Promise<RelayStoreStats>;
};

type PairingRecord = {
  pairId: string;
  pairingCode: string;
  desktopTokenHash: string;
  mobileTokenHash?: string;
  expiresAtMs: number;
  nextServerSeq: number;
  connections: Map<string, RelayConnection>;
  backlog: RelayEnvelope[];
  seenEnvelopeIds: Set<string>;
};

const PAIRING_TTL_MS = 10 * 60 * 1000;
const BACKLOG_LIMIT = 200;

const token = (): string => randomBytes(32).toString("base64url");
const hashToken = (value: string): string => createHash("sha256").update(value).digest("base64url");
const pairingCode = (): string => String(randomInt(100000, 1000000));
const iso = (ms: number): string => new Date(ms).toISOString();

export const createRelayStore = (driver = "memory"): RelayStore => {
  if (driver === "memory") return new MemoryRelayStore();
  throw new Error(`Unsupported relay store driver "${driver}". Only "memory" is implemented in this build.`);
};

export class MemoryRelayStore implements RelayStore {
  private readonly pairingsById = new Map<string, PairingRecord>();
  private readonly pairingsByCode = new Map<string, PairingRecord>();

  async createPairing(): Promise<CreatePairingResponse> {
    this.gcExpired();

    const expiresAtMs = Date.now() + PAIRING_TTL_MS;
    const desktopToken = token();
    const record: PairingRecord = {
      pairId: `pair_${randomUUID()}`,
      pairingCode: this.createUniquePairingCode(),
      desktopTokenHash: hashToken(desktopToken),
      expiresAtMs,
      nextServerSeq: 1,
      connections: new Map(),
      backlog: [],
      seenEnvelopeIds: new Set()
    };

    this.pairingsById.set(record.pairId, record);
    this.pairingsByCode.set(record.pairingCode, record);

    return {
      pairId: record.pairId,
      pairingCode: record.pairingCode,
      desktopToken,
      expiresAt: iso(record.expiresAtMs)
    };
  }

  async claimPairing(code: string): Promise<ClaimPairingResponse | undefined> {
    this.gcExpired();
    const record = this.pairingsByCode.get(code);
    if (!record) return undefined;

    if (record.mobileTokenHash) return undefined;

    const mobileToken = token();
    record.mobileTokenHash = hashToken(mobileToken);
    this.pairingsByCode.delete(code);

    return {
      pairId: record.pairId,
      mobileToken,
      expiresAt: iso(record.expiresAtMs)
    };
  }

  async authenticate(pairId: string, role: DeviceRole, providedToken: string): Promise<boolean> {
    this.gcExpired();
    const record = this.pairingsById.get(pairId);
    if (!record) return false;
    if (role === "desktop") return tokenMatches(providedToken, record.desktopTokenHash);
    return tokenMatches(providedToken, record.mobileTokenHash);
  }

  async addConnection(pairId: string, connection: RelayConnection, afterSeq?: number): Promise<RelayEnvelope[]> {
    const record = this.getRequiredPairing(pairId);
    record.connections.set(connection.id, connection);
    if (typeof afterSeq !== "number" || !Number.isFinite(afterSeq) || afterSeq < 1) {
      return [...record.backlog];
    }
    return record.backlog.filter((envelope) => (envelope.serverSeq ?? 0) > afterSeq);
  }

  async removeConnection(pairId: string, connectionId: string): Promise<void> {
    const record = this.pairingsById.get(pairId);
    record?.connections.delete(connectionId);
  }

  async revokePairing(pairId: string, providedToken: string): Promise<boolean> {
    const record = this.pairingsById.get(pairId);
    if (!record) return false;
    if (!tokenMatches(providedToken, record.desktopTokenHash) && !tokenMatches(providedToken, record.mobileTokenHash)) return false;

    this.pairingsById.delete(pairId);
    if (this.pairingsByCode.get(record.pairingCode) === record) {
      this.pairingsByCode.delete(record.pairingCode);
    }

    for (const connection of record.connections.values()) {
      connection.close?.();
    }
    record.connections.clear();
    return true;
  }

  async acceptEnvelope(
    envelope: RelayEnvelope
  ): Promise<{ duplicate: boolean; envelope?: RelayEnvelope; recipients: RelayConnection[] }> {
    const record = this.getRequiredPairing(envelope.pairId);
    if (record.seenEnvelopeIds.has(envelope.id)) {
      return { duplicate: true, recipients: [] };
    }

    const stampedEnvelope = {
      ...envelope,
      serverSeq: record.nextServerSeq
    };
    record.nextServerSeq += 1;
    record.seenEnvelopeIds.add(envelope.id);
    record.backlog.push(stampedEnvelope);
    if (record.backlog.length > BACKLOG_LIMIT) {
      record.backlog.splice(0, record.backlog.length - BACKLOG_LIMIT);
    }

    const targetRole: DeviceRole = envelope.source === "desktop" ? "mobile" : "desktop";
    const recipients = [...record.connections.values()].filter((connection) => connection.role === targetRole);
    return { duplicate: false, envelope: stampedEnvelope, recipients };
  }

  async getStats(): Promise<RelayStoreStats> {
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
      if (record.mobileTokenHash || record.expiresAtMs > now) continue;
      this.pairingsById.delete(record.pairId);
      if (this.pairingsByCode.get(record.pairingCode) === record) {
        this.pairingsByCode.delete(record.pairingCode);
      }
    }
  }
}

const tokenMatches = (providedToken: string, expectedHash: string | undefined): boolean => {
  if (!expectedHash) return false;
  const providedHash = hashToken(providedToken);
  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(expectedHash);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};
