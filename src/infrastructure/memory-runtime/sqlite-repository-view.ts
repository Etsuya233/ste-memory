import type { SqliteMemoryClient, SqliteView } from "../sqlite/types.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

/** 一组仓库共享一个读视图及 writer 身份。未加载空间的读取遵循领域端口的空结果约定；
 * 实体写入统一进入 MemoryStore，携带 token 的工具写入留在当前任务保存点内。 */
export class SqliteRepositoryView {
  readonly memory: SqliteMemoryStore;
  readonly client: SqliteMemoryClient;
  readonly token: symbol | undefined;
  readonly get: SqliteMemoryClient["getEntity"];
  readonly list: SqliteMemoryClient["listEntities"];
  readonly save: SqliteMemoryClient["putEntity"];
  readonly erase: SqliteMemoryClient["deleteEntity"];

  constructor(memory: SqliteMemoryStore, view: SqliteView, token?: symbol) {
    this.memory = memory;
    this.client = memory.client;
    this.token = token;
    this.get = async (id, kind, key) =>
      memory.hasSpace(id) ? memory.client.getEntity(id, kind, key, view) : undefined;
    this.list = async (id, kind) =>
      memory.hasSpace(id) ? memory.client.listEntities(id, kind, view) : [];
    this.save = (id, kind, entity) =>
      memory.write(id, () => memory.client.putEntity(id, kind, entity), token);
    this.erase = (id, kind, key) => memory.client.deleteEntity(id, kind, key);
  }
}
