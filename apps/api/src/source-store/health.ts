import type { DatabaseHealthCheck, DatabaseStatus } from "@ste-memory/core";
import { checkSqliteConnection } from "@ste-memory/sqlite-utils";

export class SourceStoreDatabaseHealthCheck implements DatabaseHealthCheck {
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
