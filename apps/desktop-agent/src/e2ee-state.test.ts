import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayE2eeSession } from "@easycode/e2ee";
import { FileRelayE2eeSessionStore } from "./e2ee-state.js";

test("file e2ee session store saves, loads, and deletes session state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easycode-e2ee-"));
  const store = new FileRelayE2eeSessionStore(directory);
  const session = await RelayE2eeSession.create({
    role: "desktop",
    pairId: "pair_test"
  });

  try {
    await store.save("pair_test", await session.serialize());
    const loaded = await store.load("pair_test");

    assert.ok(loaded);
    assert.equal(loaded.role, "desktop");
    assert.equal(loaded.pairId, "pair_test");

    await store.delete("pair_test");
    assert.equal(await store.load("pair_test"), undefined);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true
    });
  }
});

test("file e2ee session store ignores invalid state files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easycode-e2ee-"));
  const store = new FileRelayE2eeSessionStore(directory);

  try {
    await writeFile(join(directory, `${encodeURIComponent("pair_null")}.json`), "null");
    assert.equal(await store.load("pair_null"), undefined);

    await writeFile(join(directory, `${encodeURIComponent("pair_broken")}.json`), "{");
    assert.equal(await store.load("pair_broken"), undefined);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true
    });
  }
});
