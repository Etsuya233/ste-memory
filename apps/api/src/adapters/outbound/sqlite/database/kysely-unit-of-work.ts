import type { UnitOfWork } from "@ste-memory/tools";
import type { Kysely } from "kysely";
import type { DatabaseContext } from "./database-context.ts";
import type { DatabaseSchema } from "./schema/database.ts";

export class KyselyUnitOfWork implements UnitOfWork {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #context: DatabaseContext;

  constructor(database: Kysely<DatabaseSchema>, context: DatabaseContext) {
    this.#database = database;
    this.#context = context;
  }

  run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.#context.hasTransaction) return operation();
    return this.#database
      .transaction()
      .execute((transaction) => this.#context.withinTransaction(transaction, operation));
  }
}
