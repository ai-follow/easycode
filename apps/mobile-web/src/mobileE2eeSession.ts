import {
  RelayE2eeSession,
  shouldEncryptRelayPayload,
  type CleartextRelayPayload,
  type SerializedRelayE2eeSession
} from "@easycode/e2ee";
import type { KeyExchangePayload, RelayEnvelope } from "@easycode/protocol";
import { e2eeStorageKey, loadStoredE2eeSession, type KeyValueStorage } from "./mobileStorage.js";

export type MobileE2eeSessionStore = {
  load(pairId: string): SerializedRelayE2eeSession | undefined;
  save(pairId: string, session: SerializedRelayE2eeSession): void;
  remove(pairId: string): void;
};

export const createMobileE2eeSessionStore = (storage: KeyValueStorage): MobileE2eeSessionStore => ({
  load: (pairId) => loadStoredE2eeSession(storage, pairId),
  save: (pairId, session) => {
    storage.setItem(e2eeStorageKey(pairId), JSON.stringify(session));
  },
  remove: (pairId) => {
    storage.removeItem(e2eeStorageKey(pairId));
  }
});

export class MobileE2eeSessionManager {
  private session?: RelayE2eeSession;
  private pairId = "";

  constructor(private readonly store?: MobileE2eeSessionStore) {}

  get ready(): boolean {
    return this.session?.ready ?? false;
  }

  get currentPairId(): string | undefined {
    return this.pairId || undefined;
  }

  async restore(pairId: string): Promise<RelayE2eeSession | undefined> {
    if (this.session && this.pairId === pairId) return this.session;

    const stored = this.store?.load(pairId);
    if (!stored) return undefined;
    if (stored.role !== "mobile" || stored.pairId !== pairId) {
      this.store?.remove(pairId);
      return undefined;
    }

    try {
      const restored = await RelayE2eeSession.restore(stored);
      this.remember(pairId, restored);
      return restored;
    } catch {
      this.store?.remove(pairId);
      return undefined;
    }
  }

  async ensure(pairId: string): Promise<RelayE2eeSession> {
    if (this.session && this.pairId === pairId) return this.session;

    const restored = await this.restore(pairId);
    if (restored) return restored;

    const created = await RelayE2eeSession.create({
      role: "mobile",
      pairId
    });
    this.remember(pairId, created);
    return created;
  }

  async handleKeyExchange(pairId: string, payload: KeyExchangePayload): Promise<KeyExchangePayload> {
    const session = await this.ensure(pairId);
    await session.handleKeyExchange(payload);
    await this.save(pairId, session);
    return session.createHello();
  }

  async decryptEnvelopePayload(envelope: RelayEnvelope): Promise<CleartextRelayPayload> {
    const session = await this.ensure(envelope.pairId);
    if (!session.ready) throw new Error("Received encrypted payload before mobile E2EE session was ready");
    return session.decryptEnvelopePayload(envelope);
  }

  async prepareOutboundEnvelope(envelope: RelayEnvelope): Promise<RelayEnvelope> {
    if (!shouldEncryptRelayPayload(envelope.payload)) return envelope;

    const session = this.session && this.pairId === envelope.pairId
      ? this.session
      : await this.restore(envelope.pairId);
    if (!session?.ready) return envelope;

    return {
      ...envelope,
      payload: await session.encryptEnvelopePayload(envelope, envelope.payload as CleartextRelayPayload)
    };
  }

  forget(pairId?: string): void {
    if (pairId) this.store?.remove(pairId);
    if (!pairId || this.pairId === pairId) this.clearMemory();
  }

  clearMemory(): void {
    this.session = undefined;
    this.pairId = "";
  }

  private async save(pairId: string, session: RelayE2eeSession): Promise<void> {
    this.store?.save(pairId, await session.serialize());
  }

  private remember(pairId: string, session: RelayE2eeSession): void {
    this.session = session;
    this.pairId = pairId;
  }
}
