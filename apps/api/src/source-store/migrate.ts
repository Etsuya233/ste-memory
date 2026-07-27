import { openSqliteDatabase } from "@ste-memory/core-sqlite/database";

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS source_store_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export function migrateSourceStoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
  } finally {
    database.close();
  }
}
