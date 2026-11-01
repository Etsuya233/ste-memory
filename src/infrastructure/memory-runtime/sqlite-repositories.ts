import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../../features/memory-snapshot/snapshot.ts";
import { parseMemoryMacros } from "../../features/macros/macro-expression.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type {
  MemorySpaceRepository,
  MemoryTableRepository,
  MemoryFieldRepository,
  MemoryRecordMutation,
  MemoryRecordHistoryQuery,
  MemorySpaceId,
  MemoryRecordRepository,
} from "../../features/memory/index.ts";
import type { SqliteMemoryClient, SqliteView } from "../sqlite/types.ts";
import type { SqliteMemoryStore, SqliteRepositories } from "./sqlite-memory-store.ts";

/** 端口按空间→表→字段→记录排列；闭包共用同一SQLite视图和写事务归属。
 * 返回值是四组声明式领域端口，SQL事务执行留在MemoryStore，载荷转换留在对应端口。 */
export function sqliteRepositories(
  memory: SqliteMemoryStore,
  view: SqliteView = "committed",
  token?: symbol,
): SqliteRepositories {
  const client = memory.client;
  const get: SqliteMemoryClient["getEntity"] = async (id, kind, key) =>
    memory.hasSpace(id) ? client.getEntity(id, kind, key, view) : undefined;
  const list: SqliteMemoryClient["listEntities"] = async (id, kind) =>
    memory.hasSpace(id) ? client.listEntities(id, kind, view) : [];
  const save: SqliteMemoryClient["putEntity"] = (id, kind, entity) =>
    memory.write(id, () => client.putEntity(id, kind, entity), token);
  const erase = (
    id: string,
    kind: Parameters<SqliteMemoryClient["deleteEntity"]>[1],
    key: string,
  ) => client.deleteEntity(id, kind, key);
  const deleteTable = async (id: string, tableId: string) => {
    for (const field of await list(id, "field"))
      if (field.tableId === tableId) await erase(id, "field", field.id);
    for (const record of await list(id, "record"))
      if (record.tableId === tableId) await erase(id, "record", record.id);
    for (const history of await list(id, "history"))
      if (history.tableId === tableId) await erase(id, "history", history.id);
    await erase(id, "table", tableId);
  };
  const spaces: MemorySpaceRepository = {
    create: async (space) => {
      memory.assertWritable(space.id);
      if (memory.hasSpace(space.id)) throw new Error("记忆空间 ID 已存在");
      await memory.replace({
        schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
        space: { ...space, macros: parseMemoryMacros(space.macros) },
        tables: [],
        fields: [],
        records: [],
        history: [],
        evidence: [],
      });
    },
    find: (id) => get(id, "space", id),
    setMacros: async (id, macros, updatedAt) => {
      return memory.write(
        id,
        async () => {
          const current = await get(id, "space", id);
          if (!current) return undefined;
          const next = { ...current, macros: parseMemoryMacros(macros), updatedAt };
          await client.putEntity(id, "space", next);
          return next;
        },
        token,
      );
    },
    rename: async (id, name, updatedAt) => {
      const current = await get(id, "space", id);
      if (!current) return undefined;
      const next = { ...current, name, updatedAt };
      await save(id, "space", next);
      return next;
    },
    clearRecords: async (id) => {
      if (!(await get(id, "space", id))) return false;
      return memory.write(
        id,
        async () => {
          for (const kind of ["record", "history", "evidence"] as const) {
            for (const item of await list(id, kind))
              await erase(id, kind, "evidence_id" in item ? item.evidence_id : item.id);
          }
          return true;
        },
        token,
      );
    },
    deleteAllTables: async (id) => {
      if (!(await get(id, "space", id))) return false;
      return memory.write(
        id,
        async () => {
          for (const table of await list(id, "table")) await deleteTable(id, table.id);
          for (const item of await list(id, "evidence"))
            await erase(id, "evidence", item.evidence_id);
          return true;
        },
        token,
      );
    },
  };
  const tables: MemoryTableRepository = {
    create: (table) => save(table.memorySpaceId, "table", table),
    find: (id, key) => get(id, "table", key),
    findByKey: async (id, key) => (await list(id, "table")).find((item) => item.key === key),
    list: async (id) =>
      (await list(id, "table")).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    update: async (table) => {
      if (!(await get(table.memorySpaceId, "table", table.id))) return false;
      await save(table.memorySpaceId, "table", table);
      return true;
    },
    delete: async (id, key) => {
      if (!(await get(id, "table", key))) return false;
      return memory.write(
        id,
        async () => {
          await deleteTable(id, key);
          return true;
        },
        token,
      );
    },
  };
  const fields: MemoryFieldRepository = {
    create: (field) => save(field.memorySpaceId, "field", field),
    find: async (id, tableId, key) => {
      const field = await get(id, "field", key);
      return field?.tableId === tableId ? field : undefined;
    },
    findByKey: async (id, tableId, key) =>
      (await list(id, "field")).find((item) => item.tableId === tableId && item.key === key),
    list: async (id, tableId) =>
      (await list(id, "field"))
        .filter((item) => item.tableId === tableId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    update: async (field) => {
      const previous = await get(field.memorySpaceId, "field", field.id);
      if (!previous || previous.tableId !== field.tableId) return false;
      await save(field.memorySpaceId, "field", field);
      return true;
    },
    delete: async (id, tableId, key) => {
      const field = await get(id, "field", key);
      if (field?.tableId !== tableId) return false;
      return memory.write(
        id,
        async () => {
          await erase(id, "field", key);
          return true;
        },
        token,
      );
    },
  };
  const records: SqliteRepositories["records"] = {
    create: (record, evidence) =>
      memory.write(
        record.memorySpaceId,
        async () => {
          for (const item of evidence)
            await client.putEntity(record.memorySpaceId, "evidence", item);
          await client.putEntity(record.memorySpaceId, "record", record);
        },
        token,
      ),
    find: async (id, tableId, key) => {
      const record = await get(id, "record", key);
      return record?.tableId === tableId ? record : undefined;
    },
    list: async (id, tableId) =>
      (await list(id, "record")).filter((record) => record.tableId === tableId),
    commit: async (mutations, evidence) => {
      if (mutations.length === 0) return true;
      const id = spaceOf(mutations[0]!);
      let applied = false;
      try {
        return await memory.write(
          id,
          async () => {
            for (const mutation of mutations) {
              if (spaceOf(mutation) !== id) throw new Error("一个记忆批次不能跨空间");
              if (mutation.kind === "replace") {
                const current = await client.getEntity(id, "record", mutation.previous.id, "write");
                if (current?.revisionId !== mutation.previous.revisionId) return false;
              }
            }
            for (const item of evidence) await client.putEntity(id, "evidence", item);
            for (const mutation of mutations) {
              if (mutation.kind === "replace")
                await client.putEntity(id, "history", mutation.history);
              if (mutation.current) await client.putEntity(id, "record", mutation.current);
              else if (mutation.kind === "replace") await erase(id, "record", mutation.previous.id);
            }
            applied = true;
            return true;
          },
          token,
        );
      } catch (error) {
        // A rejected optimistic lock committed no record changes. Preserve that result
        // even if persisting the unchanged snapshot also failed.
        if (!applied && error instanceof MemoryCommitPersistenceError) return false;
        throw error;
      }
    },
    listHistory: async (query) =>
      (await list(query.memorySpaceId, "history"))
        .filter((item) => historyMatches(item, query))
        .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.id.localeCompare(a.id)),
    findEvidence: async (id, sourceType, sourceId) =>
      (await list(id, "evidence")).find(
        (item) => item.source_type === sourceType && item.source_id === sourceId,
      ),
  };
  return { spaces, tables, fields, records };
}

function spaceOf(mutation: MemoryRecordMutation): MemorySpaceId {
  return mutation.kind === "create"
    ? mutation.current.memorySpaceId
    : mutation.previous.memorySpaceId;
}

function historyMatches(
  item: Awaited<ReturnType<MemoryRecordRepository["listHistory"]>>[number],
  query: MemoryRecordHistoryQuery,
): boolean {
  return (
    (query.tableId === undefined || item.tableId === query.tableId) &&
    (query.recordId === undefined || item.recordId === query.recordId) &&
    (query.revisionId === undefined || item.revisionId === query.revisionId) &&
    (query.archivedFrom === undefined || item.archivedAt >= query.archivedFrom) &&
    (query.archivedTo === undefined || item.archivedAt <= query.archivedTo)
  );
}
