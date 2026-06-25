import { parseAllowedOrigins } from "./origins.js";
import { createRelayServer } from "./server.js";
import { createRelayStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const heartbeatIntervalMs = parsePositiveInt(process.env.EASYCODE_WS_HEARTBEAT_MS, 30000);
const store = createRelayStore(process.env.EASYCODE_RELAY_STORE, {
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
