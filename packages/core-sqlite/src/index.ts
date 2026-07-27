import type { DatabaseHealthCheck, DatabaseStatus } from "@ste-memory/application";
import {
  checkSqliteConnection,
  openSqliteDatabase,
} from "@ste-memory/sqlite-utils";

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS core_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export function migrateCoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
  } finally {
    database.close();
  }
}

export class CoreDatabaseHealthCheck implements DatabaseHealthCheck {
  readonly #databaseUrl: string;

  constructor(databaseUrl: string) {
    this.#databaseUrl = databaseUrl;
  }

  check(): DatabaseStatus {
    try {
      checkSqliteConnection(this.#databaseUrl);
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : "Unknown database error",
      };
    }
  }
}
