import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileDesktopPairingStore, normalizeServerUrl } from "./pairing-state.js";

test("file desktop pairing store saves, loads, and deletes pairing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easycode-pairing-"));
  const store = new FileDesktopPairingStore(join(directory, "pairing.json"));

  try {
    const saved = await store.save("http://localhost:8787/", {
      pairId: "pair_test",
      pairingCode: "123456",
      desktopToken: "desktop_token_test",
      expiresAt: "2026-01-01T00:00:00.000Z"
    });
    const loaded = await store.load("http://localhost:8787");

    assert.ok(loaded);
    assert.equal(loaded.pairId, "pair_test");
    assert.equal(loaded.desktopToken, "desktop_token_test");
    assert.equal(loaded.pairingCode, "123456");
    assert.equal(loaded.serverUrl, saved.serverUrl);

    await store.saveLastServerSeq("http://localhost:8787", "pair_test", 8);
    await store.saveLastServerSeq("http://localhost:8787", "pair_test", 7);
    assert.equal((await store.load("http://localhost:8787"))?.lastServerSeq, 8);

    await store.delete();
    assert.equal(await store.load("http://localhost:8787"), undefined);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true
    });
  }
});

test("file desktop pairing store ignores invalid or mismatched state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easycode-pairing-"));
  const file = join(directory, "pairing.json");
  const store = new FileDesktopPairingStore(file);

  try {
    await writeFile(file, "null");
    assert.equal(await store.load("http://localhost:8787"), undefined);

    await writeFile(file, "{");
    assert.equal(await store.load("http://localhost:8787"), undefined);

    await store.save("http://localhost:8787", {
      pairId: "pair_test",
      pairingCode: "123456",
      desktopToken: "desktop_token_test",
      expiresAt: "2026-01-01T00:00:00.000Z"
    });
    assert.equal(await store.load("http://127.0.0.1:8787"), undefined);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true
    });
  }
});

test("normalizes relay server urls for pairing state matching", () => {
  assert.equal(normalizeServerUrl("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(normalizeServerUrl(" http://localhost:8787 "), "http://localhost:8787");
});
