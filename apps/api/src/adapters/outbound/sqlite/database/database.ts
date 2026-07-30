import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type DatabaseDriverType from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { DatabaseSchema } from "./schema/database.ts";

const require = createRequire(import.meta.url);
const DatabaseDriver = require("better-sqlite3") as typeof DatabaseDriverType;

export function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("sqlite:")) {
    throw new Error(`Unsupported database URL: ${databaseUrl}`);
  }
  const databasePath = databaseUrl.slice("sqlite:".length);
  if (!databasePath) throw new Error("SQLite database URL must include a file path");
  return databasePath === ":memory:" ? databasePath : resolve(databasePath);
}

export function createDatabase(databaseUrl: string): Kysely<DatabaseSchema> {
  const databasePath = sqlitePathFromUrl(databaseUrl);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseDriver(databasePath);
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}
