import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../../features/memory-snapshot/snapshot.ts";
import { parseMemoryMacros } from "../../features/macros/macro-expression.ts";
import type {
  MemorySpaceRepository,
  MemorySpace,
  MemorySpaceId,
} from "../../features/memory/index.ts";
import { deleteTableContents } from "./sqlite-schema-repositories.ts";
import type { SqliteRepositoryView } from "./sqlite-repository-view.ts";

/** 空间级配置及整体清除；表格级级联规则共用 schema 仓库的删除实现。 */
export class SqliteSpaceRepository implements MemorySpaceRepository {
  private readonly context: SqliteRepositoryView;

  constructor(context: SqliteRepositoryView) {
    this.context = context;
  }

  async create(space: MemorySpace): Promise<void> {
    const { memory } = this.context;
    memory.assertWritable(space.id);
    if (memory.hasSpace(space.id)) {
      throw new Error("记忆空间 ID 已存在");
    }
    await memory.replace({
      schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
      floorLedger: [],
      space: { ...space, macros: parseMemoryMacros(space.macros) },
      tables: [],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    });
  }

  find(id: MemorySpaceId): Promise<MemorySpace | undefined> {
    return this.context.get(id, "space", id);
  }

  setMacros: MemorySpaceRepository["setMacros"] = (id, macros, updatedAt) => {
    const { memory, client, get, token } = this.context;
    return memory.write(
      id,
      async () => {
        const current = await get(id, "space", id);
        if (!current) {
          return undefined;
        }
        const next = { ...current, macros: parseMemoryMacros(macros), updatedAt };
        await client.putEntity(id, "space", next);
        return next;
      },
      token,
    );
  };

  async rename(
    id: MemorySpaceId,
    name: string,
    updatedAt: string,
  ): Promise<MemorySpace | undefined> {
    const current = await this.context.get(id, "space", id);
    if (!current) {
      return undefined;
    }
    const next = { ...current, name, updatedAt };
    await this.context.save(id, "space", next);
    return next;
  }

  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    const { memory, get, list, erase, token } = this.context;
    if (!(await get(id, "space", id))) {
      return false;
    }
    return memory.write(
      id,
      async () => {
        // 记录清除保留空间与表结构；修订身份随记录/历史一并移除。
        for (const kind of ["record", "history", "evidence", "floor"] as const) {
          for (const item of await list(id, kind)) {
            await erase(id, kind, "evidence_id" in item ? item.evidence_id : item.id);
          }
        }
        return true;
      },
      token,
    );
  }

  async deleteAllTables(id: MemorySpaceId): Promise<boolean> {
    const { memory, get, list, erase, token } = this.context;
    if (!(await get(id, "space", id))) {
      return false;
    }
    return memory.write(
      id,
      async () => {
        for (const table of await list(id, "table")) {
          await deleteTableContents(this.context, id, table.id);
        }
        for (const item of await list(id, "evidence")) {
          await erase(id, "evidence", item.evidence_id);
        }
        return true;
      },
      token,
    );
  }
}
