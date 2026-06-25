import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadPostgresMigrations, resolveDefaultMigrationsDir } from "./postgres-migrations.js";

test("loads postgres migrations in filename order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "easycode-migrations-"));
  try {
    await writeFile(path.join(dir, "002_second.sql"), "SELECT 2;", "utf8");
    await writeFile(path.join(dir, "001_first.sql"), "SELECT 1;", "utf8");
    await writeFile(path.join(dir, "README.md"), "ignored", "utf8");

    const migrations = await loadPostgresMigrations(dir);

    assert.deepEqual(
      migrations.map((migration) => migration.version),
      ["001_first", "002_second"]
    );
    assert.deepEqual(
      migrations.map((migration) => migration.sql.trim()),
      ["SELECT 1;", "SELECT 2;"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves the repository postgres migrations directory", () => {
  assert.equal(path.basename(resolveDefaultMigrationsDir()), "postgres");
});
