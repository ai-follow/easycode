import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationSnapshotSchema } from "@easycode/protocol";
import test from "node:test";

type InspectJson = {
  target: unknown;
  elementCount: number;
  snapshot: unknown;
};

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(distDir, "..");
const inspectCliPath = join(distDir, "inspect.js");
const fixturesDir = join(packageRoot, "fixtures");

test("inspect CLI replays every accessibility fixture as JSON", async () => {
  const fixtureFiles = (await readdir(fixturesDir)).filter((file) => file.endsWith(".txt")).sort();
  assert.ok(fixtureFiles.length > 0, "expected at least one accessibility fixture");

  for (const fixtureFile of fixtureFiles) {
    const fixturePath = join(fixturesDir, fixtureFile);
    const result = spawnSync(process.execPath, [inspectCliPath, "--input", fixturePath, "--json"], {
      cwd: packageRoot,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, `${fixtureFile} inspect stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as InspectJson;
    assert.ok(parsed.elementCount > 0, `${fixtureFile} should expose accessibility elements`);
    ConversationSnapshotSchema.parse(parsed.snapshot);
  }
});
