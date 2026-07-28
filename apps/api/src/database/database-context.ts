import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema/database.ts";

export type DatabaseExecutor = Omit<
  Kysely<DatabaseSchema>,
  "transaction" | "startTransaction" | "connection" | "destroy"
>;

export class DatabaseContext {
  readonly #transactions = new AsyncLocalStorage<Transaction<DatabaseSchema>>();
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  get database(): DatabaseExecutor {
    return this.#transactions.getStore() ?? this.#database;
  }

  get hasTransaction(): boolean {
    return this.#transactions.getStore() !== undefined;
  }

  withinTransaction<TResult>(
    transaction: Transaction<DatabaseSchema>,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    return this.#transactions.run(transaction, operation);
  }
}
