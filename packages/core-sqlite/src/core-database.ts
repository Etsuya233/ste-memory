import { openSqliteDatabase } from "./database.ts";

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS core_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

const CREATE_MEMORY_SPACES_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT
`;

export function migrateCoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
    database.exec(CREATE_MEMORY_SPACES_TABLE);
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}
