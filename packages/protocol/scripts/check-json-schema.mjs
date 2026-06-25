import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyProtocolJsonSchema } from "./generate-json-schema.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(scriptDir, "../schemas/easycode-protocol.schema.json");
const expected = stringifyProtocolJsonSchema();
const actual = await readFile(schemaPath, "utf8");

if (actual !== expected) {
  console.error(`Protocol JSON Schema is stale. Run: pnpm --filter @easycode/protocol schema:generate`);
  process.exitCode = 1;
}

const parsed = JSON.parse(actual);
for (const definition of ["RelayEnvelope", "RelayPayload", "UserInput", "InteractionRequest", "CreatePairingResponse", "ClaimPairingResponse"]) {
  if (!parsed.definitions?.[definition]) {
    console.error(`Protocol JSON Schema is missing definition: ${definition}`);
    process.exitCode = 1;
  }
}
