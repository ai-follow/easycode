#!/usr/bin/env node
import type { CreatePairingResponse, RelayEnvelope, UserInput } from "@easycode/protocol";
import type { AdapterName } from "./adapters/index.js";
import { createAdapter } from "./adapters/index.js";
import { defaultE2eeStateDir, FileRelayE2eeSessionStore } from "./e2ee-state.js";
import { defaultPairingStateFile, FileDesktopPairingStore, type DesktopPairingStore, type StoredDesktopPairing } from "./pairing-state.js";
import { createPairing, DesktopRelayClient, RelayAuthenticationError, revokePairing } from "./relay-client.js";
import { formatTargets, selectTarget } from "./target-selection.js";

type CliOptions = {
  serverUrl: string;
  adapterName: AdapterName;
  relayToken?: string;
  targetId?: string;
  targetIndex?: number;
  targetTitle?: string;
  listTargets: boolean;
  e2ee: boolean;
  e2eeStateDir: string;
  pairingStateFile: string;
  resetPairing: boolean;
};

type ActivePairing = Pick<CreatePairingResponse, "pairId" | "desktopToken" | "pairingCode" | "expiresAt"> & {
  reused: boolean;
  lastServerSeq?: number;
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : fallback;
  };
  const getOptional = (name: string): string | undefined => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : undefined;
  };

  return {
    serverUrl: get("--server", process.env.EASYCODE_SERVER_URL ?? "http://localhost:8787"),
    adapterName: get("--adapter", process.env.EASYCODE_ADAPTER ?? "mock") as AdapterName,
    relayToken: getOptional("--relay-token") ?? process.env.EASYCODE_RELAY_TOKEN ?? process.env.EASYCODE_RELAY_ADMIN_TOKEN,
    targetId: getOptional("--target"),
    targetIndex: parseOptionalIndex(getOptional("--target-index")),
    targetTitle: getOptional("--target-title"),
    listTargets: args.includes("--list-targets"),
    e2ee: args.includes("--e2ee") || process.env.EASYCODE_E2EE === "1",
    e2eeStateDir: getOptional("--e2ee-state-dir") ?? defaultE2eeStateDir(),
    pairingStateFile: getOptional("--pairing-state-file") ?? defaultPairingStateFile(),
    resetPairing: args.includes("--reset-pairing") || process.env.EASYCODE_RESET_PAIRING === "1"
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const adapter = createAdapter(options.adapterName);

  console.log(`[desktop] using adapter=${options.adapterName} server=${options.serverUrl}`);
  console.log(`[desktop] pairing state file=${options.pairingStateFile}`);
  if (options.e2ee) console.log("[desktop] e2ee enabled");
  if (options.e2ee) console.log(`[desktop] e2ee state dir=${options.e2eeStateDir}`);
  const pairingStore = new FileDesktopPairingStore(options.pairingStateFile);
  if (options.resetPairing) {
    await resetSavedPairing(options, pairingStore);
  }

  const targets = await adapter.discoverClients();
  if (targets.length === 0) {
    throw new Error(`No targets found for adapter ${options.adapterName}`);
  }

  if (options.listTargets) {
    console.log(formatTargets(targets));
    return;
  }

  const target = selectTarget(targets, options);
  const session = await adapter.attach(target);
  console.log(`[desktop] attached session=${session.sessionId} target="${target.title}"`);

  let pairing = await loadOrCreatePairing(options, pairingStore);
  logPairing(pairing);

  let relay: DesktopRelayClient;
  const handleEnvelope = async (envelope: RelayEnvelope): Promise<void> => {
    if (envelope.payload.kind !== "user_input") return;
    await deliverInput(envelope.payload.sessionId, envelope.payload.input);
  };

  const createRelay = (activePairing: ActivePairing): DesktopRelayClient =>
    new DesktopRelayClient({
      serverUrl: options.serverUrl,
      pairId: activePairing.pairId,
      desktopToken: activePairing.desktopToken,
      afterSeq: activePairing.lastServerSeq,
      e2ee: options.e2ee,
      e2eeStore: options.e2ee ? new FileRelayE2eeSessionStore(options.e2eeStateDir) : undefined,
      onServerSeq: async (serverSeq) => {
        if ((activePairing.lastServerSeq ?? 0) >= serverSeq) return;
        activePairing.lastServerSeq = serverSeq;
        await pairingStore.saveLastServerSeq(options.serverUrl, activePairing.pairId, serverSeq);
      },
      onPairingInvalid: async (invalidPairId) => {
        if (invalidPairId === activePairing.pairId) await pairingStore.delete();
      },
      onEnvelope: handleEnvelope
    });

  relay = createRelay(pairing);
  try {
    await relay.connect();
  } catch (error) {
    if (!(pairing.reused && error instanceof RelayAuthenticationError)) throw error;
    console.error("[desktop] saved pairing was rejected by relay; creating a new pairing");
    await pairingStore.delete();
    pairing = await createAndSavePairing(options, pairingStore);
    logPairing(pairing);
    relay = createRelay(pairing);
    await relay.connect();
  }

  relay.send({
    kind: "desktop_status",
    targets,
    sessions: [session],
    capabilities: {
      [adapter.id]: adapter.capabilities()
    }
  });

  relay.send({
    kind: "session_snapshot",
    sessionId: session.sessionId,
    snapshot: await adapter.getSnapshot(session.sessionId)
  });

  void (async () => {
    for await (const event of adapter.subscribeEvents(session.sessionId)) {
      relay.send({
        kind: "client_event",
        sessionId: session.sessionId,
        event
      });
    }
  })().catch((error) => {
    console.error(`[desktop] adapter event stream failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const shutdown = (): void => {
    relay.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  async function deliverInput(sessionId: string, input: UserInput): Promise<void> {
    console.log(`[desktop] input ${input.inputId} kind=${input.type}`);
    if (sessionId !== session.sessionId) {
      relay.send({
        kind: "client_event",
        sessionId,
        event: {
          type: "delivery_state",
          payload: {
            inputId: input.inputId,
            status: "failed",
            detail: "Desktop session is no longer attached.",
            updatedAt: new Date().toISOString()
          }
        }
      });
      return;
    }

    const receipt = await adapter.sendInput(sessionId, input);
    relay.send({
      kind: "client_event",
      sessionId,
      event: {
        type: "delivery_state",
        payload: {
          inputId: input.inputId,
          status: receipt.status,
          detail: receipt.detail,
          updatedAt: receipt.deliveredAt
        }
      }
    });
  }
};

main().catch((error) => {
  console.error(`[desktop] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

function parseOptionalIndex(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function loadOrCreatePairing(options: CliOptions, store: DesktopPairingStore): Promise<ActivePairing> {
  const stored = await store.load(options.serverUrl);
  if (stored) return activePairingFromStored(stored);
  return createAndSavePairing(options, store);
}

async function createAndSavePairing(options: CliOptions, store: DesktopPairingStore): Promise<ActivePairing> {
  const pairing = await createPairing(options.serverUrl, options.relayToken);
  await store.save(options.serverUrl, pairing);
  return {
    ...pairing,
    reused: false
  };
}

async function resetSavedPairing(options: CliOptions, store: DesktopPairingStore): Promise<void> {
  const stored = await store.load(options.serverUrl);
  if (stored) {
    try {
      const revoked = await revokePairing(options.serverUrl, stored.pairId, stored.desktopToken);
      if (revoked) console.log(`[desktop] revoked saved pairing pairId=${stored.pairId}`);
    } catch (error) {
      console.error(`[desktop] failed to revoke saved pairing before reset: ${error instanceof Error ? error.message : String(error)}`);
    }

    await new FileRelayE2eeSessionStore(options.e2eeStateDir).delete(stored.pairId);
  }
  await store.delete();
  console.log("[desktop] cleared saved pairing state");
}

function activePairingFromStored(stored: StoredDesktopPairing): ActivePairing {
  return {
    pairId: stored.pairId,
    desktopToken: stored.desktopToken,
    pairingCode: stored.pairingCode ?? "",
    expiresAt: stored.expiresAt ?? "",
    lastServerSeq: stored.lastServerSeq,
    reused: true
  };
}

function logPairing(pairing: ActivePairing): void {
  if (!pairing.reused) {
    console.log(`[desktop] pairing code: ${pairing.pairingCode}`);
    console.log("[desktop] open the mobile client and claim this code before it expires.");
    return;
  }

  console.log(`[desktop] using saved pairing pairId=${pairing.pairId}`);
  if (pairing.pairingCode && !isExpired(pairing.expiresAt)) {
    console.log(`[desktop] saved pairing code, if not claimed yet: ${pairing.pairingCode}`);
  }
  console.log("[desktop] mobile clients with saved credentials can reconnect without claiming a new code.");
}

function isExpired(expiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
