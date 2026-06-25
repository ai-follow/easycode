import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
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

export type RelayStoreOptions = {
  pairingTtlMs?: number;
  backlogLimit?: number;
  dedupeLimit?: number;
  postgresUrl?: string;
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
  close?(): Promise<void>;
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
  seenEnvelopeIdOrder: string[];
};

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BACKLOG_LIMIT = 200;
const DEFAULT_DEDUPE_LIMIT = 1000;

const token = (): string => randomBytes(32).toString("base64url");
const hashToken = (value: string): string => createHash("sha256").update(value).digest("base64url");
const pairingCode = (): string => String(randomInt(100000, 1000000));
const iso = (ms: number): string => new Date(ms).toISOString();

export const createRelayStore = (driver = "memory", options: RelayStoreOptions = {}): RelayStore => {
  if (driver === "memory") return new MemoryRelayStore(options);
  if (driver === "postgres") return new PostgresRelayStore(options);
  throw new Error(`Unsupported relay store driver "${driver}". Use "memory" or "postgres".`);
};

export class MemoryRelayStore implements RelayStore {
  private readonly pairingsById = new Map<string, PairingRecord>();
  private readonly pairingsByCode = new Map<string, PairingRecord>();
  private readonly pairingTtlMs: number;
  private readonly backlogLimit: number;
  private readonly dedupeLimit: number;

  constructor(options: RelayStoreOptions = {}) {
    this.pairingTtlMs = positiveIntOrDefault(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.backlogLimit = positiveIntOrDefault(options.backlogLimit, DEFAULT_BACKLOG_LIMIT);
    this.dedupeLimit = positiveIntOrDefault(options.dedupeLimit, DEFAULT_DEDUPE_LIMIT);
  }

  async createPairing(): Promise<CreatePairingResponse> {
    this.gcExpired();

    const expiresAtMs = Date.now() + this.pairingTtlMs;
    const desktopToken = token();
    const record: PairingRecord = {
      pairId: `pair_${randomUUID()}`,
      pairingCode: this.createUniquePairingCode(),
      desktopTokenHash: hashToken(desktopToken),
      expiresAtMs,
      nextServerSeq: 1,
      connections: new Map(),
      backlog: [],
      seenEnvelopeIds: new Set(),
      seenEnvelopeIdOrder: []
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
    record.seenEnvelopeIdOrder.push(envelope.id);
    this.trimSeenEnvelopeIds(record);
    record.backlog.push(stampedEnvelope);
    if (record.backlog.length > this.backlogLimit) {
      record.backlog.splice(0, record.backlog.length - this.backlogLimit);
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

  private trimSeenEnvelopeIds(record: PairingRecord): void {
    if (record.seenEnvelopeIdOrder.length <= this.dedupeLimit) return;
    const removed = record.seenEnvelopeIdOrder.splice(0, record.seenEnvelopeIdOrder.length - this.dedupeLimit);
    for (const envelopeId of removed) record.seenEnvelopeIds.delete(envelopeId);
  }
}

export class PostgresRelayStore implements RelayStore {
  private readonly pool: Pool;
  private readonly pairingTtlMs: number;
  private readonly backlogLimit: number;
  private readonly dedupeLimit: number;
  private readonly connectionsByPair = new Map<string, Map<string, RelayConnection>>();

  constructor(options: RelayStoreOptions = {}) {
    this.pool = new Pool({ connectionString: requiredPostgresUrl(options.postgresUrl) });
    this.pairingTtlMs = positiveIntOrDefault(options.pairingTtlMs, DEFAULT_PAIRING_TTL_MS);
    this.backlogLimit = positiveIntOrDefault(options.backlogLimit, DEFAULT_BACKLOG_LIMIT);
    this.dedupeLimit = positiveIntOrDefault(options.dedupeLimit, DEFAULT_DEDUPE_LIMIT);
  }

  async createPairing(): Promise<CreatePairingResponse> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const expiresAtMs = Date.now() + this.pairingTtlMs;
      const desktopToken = token();
      const pairId = `pair_${randomUUID()}`;
      const code = pairingCode();
      const result = await this.pool.query<{ pair_id: string }>(
        `
          INSERT INTO relay_pairings (pair_id, pairing_code, desktop_token_hash, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (pairing_code) DO NOTHING
          RETURNING pair_id
        `,
        [pairId, code, hashToken(desktopToken), new Date(expiresAtMs)]
      );

      if ((result.rowCount ?? 0) > 0) {
        return {
          pairId,
          pairingCode: code,
          desktopToken,
          expiresAt: iso(expiresAtMs)
        };
      }
    }

    throw new Error("Failed to create a unique pairing code");
  }

  async claimPairing(code: string): Promise<ClaimPairingResponse | undefined> {
    const mobileToken = token();
    const result = await this.pool.query<{ pair_id: string; expires_at: Date | string }>(
      `
        UPDATE relay_pairings
        SET mobile_token_hash = $2,
            pairing_code = NULL,
            claimed_at = now(),
            updated_at = now()
        WHERE pairing_code = $1
          AND mobile_token_hash IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING pair_id, expires_at
      `,
      [code, hashToken(mobileToken)]
    );

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      pairId: row.pair_id,
      mobileToken,
      expiresAt: pgDateIso(row.expires_at)
    };
  }

  async authenticate(pairId: string, role: DeviceRole, providedToken: string): Promise<boolean> {
    const result = await this.pool.query<{
      desktop_token_hash: string;
      mobile_token_hash?: string;
    }>(
      `
        SELECT desktop_token_hash, mobile_token_hash
        FROM relay_pairings
        WHERE pair_id = $1
          AND revoked_at IS NULL
          AND (mobile_token_hash IS NOT NULL OR expires_at > now())
      `,
      [pairId]
    );

    const row = result.rows[0];
    if (!row) return false;
    if (role === "desktop") return tokenMatches(providedToken, row.desktop_token_hash);
    return tokenMatches(providedToken, row.mobile_token_hash);
  }

  async addConnection(pairId: string, connection: RelayConnection, afterSeq?: number): Promise<RelayEnvelope[]> {
    let connections = this.connectionsByPair.get(pairId);
    if (!connections) {
      connections = new Map();
      this.connectionsByPair.set(pairId, connections);
    }
    connections.set(connection.id, connection);

    const hasCursor = typeof afterSeq === "number" && Number.isFinite(afterSeq) && afterSeq >= 1;
    const result = hasCursor
      ? await this.pool.query<EnvelopeRow>(
        `
          SELECT pair_id, envelope_id, server_seq, source, created_at, payload
          FROM (
            SELECT pair_id, envelope_id, server_seq, source, created_at, payload
            FROM relay_envelopes
            WHERE pair_id = $1 AND server_seq > $2
            ORDER BY server_seq DESC
            LIMIT $3
          ) backlog
          ORDER BY server_seq ASC
        `,
        [pairId, afterSeq, this.backlogLimit]
      )
      : await this.pool.query<EnvelopeRow>(
        `
          SELECT pair_id, envelope_id, server_seq, source, created_at, payload
          FROM (
            SELECT pair_id, envelope_id, server_seq, source, created_at, payload
            FROM relay_envelopes
            WHERE pair_id = $1
            ORDER BY server_seq DESC
            LIMIT $2
          ) backlog
          ORDER BY server_seq ASC
        `,
        [pairId, this.backlogLimit]
      );

    return result.rows.map(rowToEnvelope);
  }

  async removeConnection(pairId: string, connectionId: string): Promise<void> {
    const connections = this.connectionsByPair.get(pairId);
    connections?.delete(connectionId);
    if (connections?.size === 0) this.connectionsByPair.delete(pairId);
  }

  async revokePairing(pairId: string, providedToken: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        desktop_token_hash: string;
        mobile_token_hash?: string;
      }>(
        `
          SELECT desktop_token_hash, mobile_token_hash
          FROM relay_pairings
          WHERE pair_id = $1 AND revoked_at IS NULL
          FOR UPDATE
        `,
        [pairId]
      );

      const row = result.rows[0];
      if (!row || (!tokenMatches(providedToken, row.desktop_token_hash) && !tokenMatches(providedToken, row.mobile_token_hash))) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `
          UPDATE relay_pairings
          SET revoked_at = now(),
              pairing_code = NULL,
              updated_at = now()
          WHERE pair_id = $1
        `,
        [pairId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    const connections = this.connectionsByPair.get(pairId);
    if (connections) {
      for (const connection of connections.values()) connection.close?.();
      connections.clear();
      this.connectionsByPair.delete(pairId);
    }
    return true;
  }

  async acceptEnvelope(
    envelope: RelayEnvelope
  ): Promise<{ duplicate: boolean; envelope?: RelayEnvelope; recipients: RelayConnection[] }> {
    const client = await this.pool.connect();
    let stampedEnvelope: RelayEnvelope | undefined;
    try {
      await client.query("BEGIN");
      const pairing = await client.query<{ next_server_seq: string | number }>(
        `
          SELECT next_server_seq
          FROM relay_pairings
          WHERE pair_id = $1 AND revoked_at IS NULL
          FOR UPDATE
        `,
        [envelope.pairId]
      );

      const row = pairing.rows[0];
      if (!row) throw new Error(`Unknown pairId: ${envelope.pairId}`);

      const duplicate = await client.query(
        `
          SELECT 1
          FROM relay_envelopes
          WHERE pair_id = $1 AND envelope_id = $2
        `,
        [envelope.pairId, envelope.id]
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return { duplicate: true, recipients: [] };
      }

      const serverSeq = Number(row.next_server_seq);
      stampedEnvelope = {
        ...envelope,
        serverSeq
      };

      await client.query(
        `
          UPDATE relay_pairings
          SET next_server_seq = next_server_seq + 1,
              updated_at = now()
          WHERE pair_id = $1
        `,
        [envelope.pairId]
      );
      await client.query(
        `
          INSERT INTO relay_envelopes (pair_id, envelope_id, server_seq, source, created_at, payload)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [envelope.pairId, envelope.id, serverSeq, envelope.source, envelope.createdAt, envelope.payload]
      );
      await trimPostgresEnvelopeWindow(client, envelope.pairId, this.dedupeLimit);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    const targetRole: DeviceRole = envelope.source === "desktop" ? "mobile" : "desktop";
    const recipients = [...(this.connectionsByPair.get(envelope.pairId)?.values() ?? [])].filter(
      (connection) => connection.role === targetRole
    );
    return { duplicate: false, envelope: stampedEnvelope, recipients };
  }

  async getStats(): Promise<RelayStoreStats> {
    const result = await this.pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM relay_pairings
        WHERE revoked_at IS NULL
          AND (mobile_token_hash IS NOT NULL OR expires_at > now())
      `
    );
    let connections = 0;
    for (const pairConnections of this.connectionsByPair.values()) connections += pairConnections.size;
    return {
      pairings: Number(result.rows[0]?.count ?? 0),
      connections
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

type EnvelopeRow = QueryResultRow & {
  pair_id: string;
  envelope_id: string;
  server_seq: string | number;
  source: RelayEnvelope["source"];
  created_at: Date | string;
  payload: RelayEnvelope["payload"];
};

const rowToEnvelope = (row: EnvelopeRow): RelayEnvelope => ({
  id: row.envelope_id,
  pairId: row.pair_id,
  serverSeq: Number(row.server_seq),
  source: row.source,
  createdAt: pgDateIso(row.created_at),
  payload: row.payload
});

const trimPostgresEnvelopeWindow = async (client: PoolClient, pairId: string, dedupeLimit: number): Promise<void> => {
  await client.query(
    `
      DELETE FROM relay_envelopes
      WHERE pair_id = $1
        AND server_seq NOT IN (
          SELECT server_seq
          FROM relay_envelopes
          WHERE pair_id = $1
          ORDER BY server_seq DESC
          LIMIT $2
        )
    `,
    [pairId, dedupeLimit]
  );
};

const rollbackQuietly = async (client: PoolClient): Promise<void> => {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original database error.
  }
};

const requiredPostgresUrl = (postgresUrl: string | undefined): string => {
  if (postgresUrl) return postgresUrl;
  throw new Error("Postgres relay store requires EASYCODE_POSTGRES_URL or RelayStoreOptions.postgresUrl");
};

const pgDateIso = (value: Date | string): string => {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
};

const tokenMatches = (providedToken: string, expectedHash: string | undefined): boolean => {
  if (!expectedHash) return false;
  const providedHash = hashToken(providedToken);
  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(expectedHash);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

const positiveIntOrDefault = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && typeof value === "number" && value > 0 ? value : fallback;
