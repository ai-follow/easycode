import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export type PostgresMigration = {
  version: string;
  filePath: string;
  sql: string;
};

export type PostgresMigrationResult = {
  applied: string[];
  skipped: string[];
};

export type PostgresMigrationOptions = {
  migrationsDir?: string;
};

const migrationsTableSql = `
  CREATE TABLE IF NOT EXISTS relay_schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

export const runPostgresMigrations = async (
  postgresUrl: string,
  options: PostgresMigrationOptions = {}
): Promise<PostgresMigrationResult> => {
  const migrations = await loadPostgresMigrations(options.migrationsDir);
  const pool = new Pool({ connectionString: postgresUrl });
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await pool.query(migrationsTableSql);

    for (const migration of migrations) {
      const existing = await pool.query(
        "SELECT 1 FROM relay_schema_migrations WHERE version = $1",
        [migration.version]
      );
      if ((existing.rowCount ?? 0) > 0) {
        skipped.push(migration.version);
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO relay_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [migration.version]
        );
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Keep the migration failure as the reported error.
        }
        throw error;
      } finally {
        client.release();
      }
    }

    return { applied, skipped };
  } finally {
    await pool.end();
  }
};

export const loadPostgresMigrations = async (migrationsDir = resolveDefaultMigrationsDir()): Promise<PostgresMigration[]> => {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();

  return Promise.all(
    sqlFiles.map(async (fileName) => {
      const filePath = path.join(migrationsDir, fileName);
      return {
        version: path.basename(fileName, ".sql"),
        filePath,
        sql: await readFile(filePath, "utf8")
      };
    })
  );
};

export const resolveDefaultMigrationsDir = (): string => {
  const candidates = [
    path.resolve(process.cwd(), "infra/postgres"),
    path.resolve(process.cwd(), "../../infra/postgres")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Could not find infra/postgres. Set EASYCODE_POSTGRES_MIGRATIONS_DIR explicitly.");
  }
  return found;
};
