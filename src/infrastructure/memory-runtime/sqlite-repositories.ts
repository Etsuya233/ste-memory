import type { SqliteView } from "../sqlite/types.ts";
import type { SqliteMemoryStore, SqliteRepositories } from "./sqlite-memory-store.ts";
import { SqliteRepositoryView } from "./sqlite-repository-view.ts";
import { SqliteSpaceRepository } from "./sqlite-space-repository.ts";
import { createTableRepository, createFieldRepository } from "./sqlite-schema-repositories.ts";
import { SqliteRecordRepository } from "./sqlite-record-repository.ts";

/** 四组领域端口使用同一个读视图与任务事务身份。 */
export function sqliteRepositories(
  memory: SqliteMemoryStore,
  view: SqliteView = "committed",
  token?: symbol,
): SqliteRepositories {
  const context = new SqliteRepositoryView(memory, view, token);
  return {
    spaces: new SqliteSpaceRepository(context),
    tables: createTableRepository(context),
    fields: createFieldRepository(context),
    records: new SqliteRecordRepository(context),
  };
}
