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
