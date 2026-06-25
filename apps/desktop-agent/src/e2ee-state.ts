import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { SerializedRelayE2eeSession } from "@easycode/e2ee";
import type { RelayE2eeSessionStore } from "./relay-client.js";

export const defaultDesktopStateDir = (): string => process.env.EASYCODE_STATE_DIR ?? join(process.cwd(), ".easycode");

export const defaultE2eeStateDir = (): string =>
  process.env.EASYCODE_E2EE_STATE_DIR ?? join(defaultDesktopStateDir(), "e2ee");

export class FileRelayE2eeSessionStore implements RelayE2eeSessionStore {
  constructor(private readonly directory = defaultE2eeStateDir()) {}

  async load(pairId: string): Promise<SerializedRelayE2eeSession | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.pathFor(pairId), "utf8")) as unknown;
      if (!isSerializedRelayE2eeSession(parsed, pairId)) return undefined;
      return parsed;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(pairId: string, session: SerializedRelayE2eeSession): Promise<void> {
    if (!isSerializedRelayE2eeSession(session, pairId)) {
      throw new Error(`Refusing to save invalid E2EE session state for pair ${pairId}`);
    }

    await mkdir(this.directory, {
      recursive: true,
      mode: 0o700
    });
    const target = this.pathFor(pairId);
    const temp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, `${JSON.stringify(session)}\n`, {
      mode: 0o600
    });
    await rename(temp, target);
    await chmod(target, 0o600);
  }

  async delete(pairId: string): Promise<void> {
    try {
      await unlink(this.pathFor(pairId));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private pathFor(pairId: string): string {
    return join(this.directory, `${encodeURIComponent(pairId)}.json`);
  }
}

const isSerializedRelayE2eeSession = (value: unknown, pairId: string): value is SerializedRelayE2eeSession => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SerializedRelayE2eeSession>;
  return (
    candidate.version === 1 &&
    (candidate.role === "desktop" || candidate.role === "mobile") &&
    candidate.pairId === pairId &&
    typeof candidate.keyId === "string" &&
    candidate.keyId.length > 0 &&
    typeof candidate.publicKey === "string" &&
    candidate.publicKey.length > 0 &&
    typeof candidate.privateKeyJwk === "object" &&
    candidate.privateKeyJwk !== null
  );
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";
