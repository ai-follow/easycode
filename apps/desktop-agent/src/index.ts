#!/usr/bin/env node
import type { RelayEnvelope, UserInput } from "@easycode/protocol";
import type { AdapterName } from "./adapters/index.js";
import { createAdapter } from "./adapters/index.js";
import { createPairing, DesktopRelayClient } from "./relay-client.js";

type CliOptions = {
  serverUrl: string;
  adapterName: AdapterName;
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : fallback;
  };

  return {
    serverUrl: get("--server", process.env.EASYCODE_SERVER_URL ?? "http://localhost:8787"),
    adapterName: get("--adapter", process.env.EASYCODE_ADAPTER ?? "mock") as AdapterName
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const adapter = createAdapter(options.adapterName);

  console.log(`[desktop] using adapter=${options.adapterName} server=${options.serverUrl}`);

  const pairing = await createPairing(options.serverUrl);
  console.log(`[desktop] pairing code: ${pairing.pairingCode}`);
  console.log("[desktop] open the mobile client and claim this code before it expires.");

  const targets = await adapter.discoverClients();
  if (targets.length === 0) {
    throw new Error(`No targets found for adapter ${options.adapterName}`);
  }

  const target = targets[0];
  if (!target) throw new Error(`No target selected for adapter ${options.adapterName}`);
  const session = await adapter.attach(target);
  console.log(`[desktop] attached session=${session.sessionId} target="${target.title}"`);

  let relay: DesktopRelayClient;
  const handleEnvelope = async (envelope: RelayEnvelope): Promise<void> => {
    if (envelope.payload.kind !== "user_input") return;
    await deliverInput(envelope.payload.sessionId, envelope.payload.input);
  };

  relay = new DesktopRelayClient({
    serverUrl: options.serverUrl,
    pairId: pairing.pairId,
    desktopToken: pairing.desktopToken,
    onEnvelope: handleEnvelope
  });
  await relay.connect();

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
