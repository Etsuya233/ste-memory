import { checkSqliteConnection } from "@ste-memory/core-sqlite/database";
import type { DatabaseHealthCheck, DatabaseStatus } from "./types.ts";

export class SqliteDatabaseHealthCheck implements DatabaseHealthCheck {
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
