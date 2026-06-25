import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CreatePairingResponse } from "@easycode/protocol";
import { defaultDesktopStateDir } from "./e2ee-state.js";

export type StoredDesktopPairing = {
  version: 1;
  serverUrl: string;
  pairId: string;
  desktopToken: string;
  pairingCode?: string;
  expiresAt?: string;
  lastServerSeq?: number;
  savedAt: string;
};

export type DesktopPairingStore = {
  load(serverUrl: string): Promise<StoredDesktopPairing | undefined>;
  save(serverUrl: string, pairing: CreatePairingResponse): Promise<StoredDesktopPairing>;
  saveLastServerSeq(serverUrl: string, pairId: string, serverSeq: number): Promise<void>;
  delete(): Promise<void>;
};

export const defaultPairingStateFile = (): string =>
  process.env.EASYCODE_PAIRING_STATE_FILE ?? join(defaultDesktopStateDir(), "pairing.json");

export class FileDesktopPairingStore implements DesktopPairingStore {
  constructor(private readonly file = defaultPairingStateFile()) {}

  async load(serverUrl: string): Promise<StoredDesktopPairing | undefined> {
    const state = await this.readState();
    if (!state || state.serverUrl !== normalizeServerUrl(serverUrl)) return undefined;
    return state;
  }

  async save(serverUrl: string, pairing: CreatePairingResponse): Promise<StoredDesktopPairing> {
    const state: StoredDesktopPairing = {
      version: 1,
      serverUrl: normalizeServerUrl(serverUrl),
      pairId: pairing.pairId,
      desktopToken: pairing.desktopToken,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
      savedAt: new Date().toISOString()
    };

    await this.writeState(state);
    return state;
  }

  async saveLastServerSeq(serverUrl: string, pairId: string, serverSeq: number): Promise<void> {
    if (!Number.isInteger(serverSeq) || serverSeq <= 0) return;
    const state = await this.load(serverUrl);
    if (!state || state.pairId !== pairId || (state.lastServerSeq ?? 0) >= serverSeq) return;
    await this.writeState({
      ...state,
      lastServerSeq: serverSeq,
      savedAt: new Date().toISOString()
    });
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.file);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private async readState(): Promise<StoredDesktopPairing | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (!isStoredDesktopPairing(parsed)) return undefined;
      return parsed;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private async writeState(state: StoredDesktopPairing): Promise<void> {
    await mkdir(dirname(this.file), {
      recursive: true,
      mode: 0o700
    });
    const temp = `${this.file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, `${JSON.stringify(state)}\n`, {
      mode: 0o600
    });
    await rename(temp, this.file);
    await chmod(this.file, 0o600);
  }
}

export const normalizeServerUrl = (serverUrl: string): string => {
  try {
    const url = new URL(serverUrl);
    url.hash = "";
    url.search = "";
    if (url.pathname === "/") url.pathname = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return serverUrl.trim().replace(/\/$/, "");
  }
};

const isStoredDesktopPairing = (value: unknown): value is StoredDesktopPairing => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredDesktopPairing>;
  return (
    candidate.version === 1 &&
    typeof candidate.serverUrl === "string" &&
    candidate.serverUrl.length > 0 &&
    typeof candidate.pairId === "string" &&
    candidate.pairId.length > 0 &&
    typeof candidate.desktopToken === "string" &&
    candidate.desktopToken.length > 0 &&
    typeof candidate.savedAt === "string" &&
    candidate.savedAt.length > 0 &&
    (typeof candidate.lastServerSeq === "undefined" || (Number.isInteger(candidate.lastServerSeq) && candidate.lastServerSeq > 0)) &&
    (typeof candidate.pairingCode === "undefined" || typeof candidate.pairingCode === "string") &&
    (typeof candidate.expiresAt === "undefined" || typeof candidate.expiresAt === "string")
  );
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";
