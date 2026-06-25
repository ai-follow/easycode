import type { SerializedRelayE2eeSession } from "@easycode/e2ee";

export { shouldEncryptRelayPayload as shouldEncryptPayload } from "@easycode/e2ee";

export type StoredPairing = {
  serverUrl: string;
  pairId: string;
  mobileToken: string;
};

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const pairingStorageKey = "easycode:pairing";

export const lastSeqKey = (pairId: string): string => `easycode:last-server-seq:${pairId}`;
export const e2eeStorageKey = (pairId: string): string => `easycode:e2ee-session:${pairId}`;

export const loadStoredPairing = (storage: Pick<KeyValueStorage, "getItem">): StoredPairing | undefined => {
  try {
    const raw = storage.getItem(pairingStorageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredPairing>;
    if (!parsed.serverUrl || !parsed.pairId || !parsed.mobileToken) return undefined;
    return {
      serverUrl: parsed.serverUrl,
      pairId: parsed.pairId,
      mobileToken: parsed.mobileToken
    };
  } catch {
    return undefined;
  }
};

export const storePairing = (storage: Pick<KeyValueStorage, "setItem">, pairing: StoredPairing): void => {
  storage.setItem(pairingStorageKey, JSON.stringify(pairing));
};

export const loadStoredE2eeSession = (
  storage: Pick<KeyValueStorage, "getItem">,
  pairId: string
): SerializedRelayE2eeSession | undefined => {
  try {
    const raw = storage.getItem(e2eeStorageKey(pairId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<SerializedRelayE2eeSession>;
    if (
      parsed.version !== 1 ||
      parsed.role !== "mobile" ||
      parsed.pairId !== pairId ||
      !parsed.keyId ||
      !parsed.publicKey ||
      !parsed.privateKeyJwk
    ) {
      return undefined;
    }
    return parsed as SerializedRelayE2eeSession;
  } catch {
    return undefined;
  }
};
