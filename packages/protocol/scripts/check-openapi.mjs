import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyRelayOpenApi } from "./generate-openapi.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const openApiPath = resolve(scriptDir, "../openapi/easycode-relay.openapi.json");
const expected = stringifyRelayOpenApi();
const actual = await readFile(openApiPath, "utf8");

if (actual !== expected) {
  console.error(`Relay OpenAPI artifact is stale. Run: pnpm --filter @easycode/protocol openapi:generate`);
  process.exitCode = 1;
}

const parsed = JSON.parse(actual);
for (const path of ["/health", "/ready", "/v1/pairings", "/v1/pairings/{pairId}", "/v1/pairings/{pairingCode}/claim", "/v1/ws"]) {
  if (!parsed.paths?.[path]) {
    console.error(`Relay OpenAPI artifact is missing path: ${path}`);
    process.exitCode = 1;
  }
}

for (const schema of ["RelayEnvelope", "CreatePairingResponse", "ClaimPairingResponse", "HealthResponse", "ReadinessResponse", "ErrorResponse"]) {
  if (!parsed.components?.schemas?.[schema]) {
    console.error(`Relay OpenAPI artifact is missing component schema: ${schema}`);
    process.exitCode = 1;
  }
}
