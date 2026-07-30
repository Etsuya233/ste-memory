import { sql } from "kysely";
import type { DatabaseContext } from "./database-context.ts";
import type { DatabaseHealthCheck, DatabaseStatus } from "../../../../application/ports/health.ts";

export class KyselyDatabaseHealthCheck implements DatabaseHealthCheck {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  async check(): Promise<DatabaseStatus> {
    try {
      await this.#context.database
        .selectNoFrom(sql<number>`1`.as("value"))
        .executeTakeFirstOrThrow();
      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : "Unknown database error",
      };
    }
  }
}
