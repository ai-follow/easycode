import { parseAllowedOrigins } from "./origins.js";
import { runPostgresMigrations } from "./postgres-migrations.js";
import { createRelayServer } from "./server.js";
import { createRelayStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const heartbeatIntervalMs = parsePositiveInt(process.env.EASYCODE_WS_HEARTBEAT_MS, 30000);
const relayStoreDriver = process.env.EASYCODE_RELAY_STORE ?? "memory";

const main = async (): Promise<void> => {
  if (relayStoreDriver === "postgres" && parseBoolean(process.env.EASYCODE_POSTGRES_MIGRATE)) {
    const result = await runPostgresMigrations(requiredEnv("EASYCODE_POSTGRES_URL"), {
      migrationsDir: process.env.EASYCODE_POSTGRES_MIGRATIONS_DIR
    });
    console.log(`[relay] postgres migrations applied=${result.applied.join(",") || "-"} skipped=${result.skipped.join(",") || "-"}`);
  }

  const store = createRelayStore(relayStoreDriver, {
    pairingTtlMs: parsePositiveInt(process.env.EASYCODE_PAIRING_TTL_MS, 10 * 60 * 1000),
    backlogLimit: parsePositiveInt(process.env.EASYCODE_RELAY_BACKLOG_LIMIT, 200),
    dedupeLimit: parsePositiveInt(process.env.EASYCODE_RELAY_DEDUPE_LIMIT, 1000),
    postgresUrl: process.env.EASYCODE_POSTGRES_URL
  });

  const relay = createRelayServer({
    store,
    adminToken: process.env.EASYCODE_RELAY_ADMIN_TOKEN,
    allowedOrigins: parseAllowedOrigins(process.env.EASYCODE_ALLOWED_ORIGINS),
    heartbeatIntervalMs,
    serviceVersion: process.env.npm_package_version,
    startedAt: new Date()
  });

  relay.server.listen(port, () => {
    console.log(`[relay] listening on http://localhost:${port}`);
  });
};

main().catch((error) => {
  console.error(`[relay] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
