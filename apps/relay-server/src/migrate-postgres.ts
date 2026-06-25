#!/usr/bin/env node
import { runPostgresMigrations } from "./postgres-migrations.js";

const main = async (): Promise<void> => {
  const postgresUrl = process.env.EASYCODE_POSTGRES_URL;
  if (!postgresUrl) {
    throw new Error("EASYCODE_POSTGRES_URL is required");
  }

  const result = await runPostgresMigrations(postgresUrl, {
    migrationsDir: process.env.EASYCODE_POSTGRES_MIGRATIONS_DIR
  });

  console.log(`[relay] postgres migrations applied=${result.applied.join(",") || "-"} skipped=${result.skipped.join(",") || "-"}`);
};

main().catch((error) => {
  console.error(`[relay] postgres migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
