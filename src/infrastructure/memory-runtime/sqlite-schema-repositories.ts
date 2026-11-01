import type { MemoryTableRepository, MemoryFieldRepository } from "../../features/memory/index.ts";
import type { SqliteRepositoryView } from "./sqlite-repository-view.ts";

/** 表结构及表级级联删除。顺序相同时按 ID 排序，保证界面和导出读取稳定。 */
export function createTableRepository(context: SqliteRepositoryView): MemoryTableRepository {
  const { memory, get, list, save, token } = context;
  return {
    create: (table) => save(table.memorySpaceId, "table", table),
    find: (id, key) => get(id, "table", key),
    findByKey: async (id, key) => (await list(id, "table")).find((item) => item.key === key),
    list: async (id) =>
      (await list(id, "table")).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    update: async (table) => {
      if (!(await get(table.memorySpaceId, "table", table.id))) {
        return false;
      }
      await save(table.memorySpaceId, "table", table);
      return true;
    },
    delete: async (id, key) => {
      if (!(await get(id, "table", key))) {
        return false;
      }
      return memory.write(
        id,
        async () => {
          await deleteTableContents(context, id, key);
          return true;
        },
        token,
      );
    },
  };
}

/** 字段身份在空间内唯一，读写仍须核对 tableId，防止跨表访问。 */
export function createFieldRepository(context: SqliteRepositoryView): MemoryFieldRepository {
  const { memory, get, list, save, erase, token } = context;
  return {
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
      if (!previous || previous.tableId !== field.tableId) {
        return false;
      }
      await save(field.memorySpaceId, "field", field);
      return true;
    },
    delete: async (id, tableId, key) => {
      const field = await get(id, "field", key);
      if (field?.tableId !== tableId) {
        return false;
      }
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
}

export async function deleteTableContents(
  context: SqliteRepositoryView,
  id: string,
  tableId: string,
): Promise<void> {
  const { list, erase } = context;
  for (const field of await list(id, "field")) {
    if (field.tableId === tableId) {
      await erase(id, "field", field.id);
    }
  }
  for (const record of await list(id, "record")) {
    if (record.tableId === tableId) {
      await erase(id, "record", record.id);
    }
  }
  for (const history of await list(id, "history")) {
    if (history.tableId === tableId) {
      await erase(id, "history", history.id);
    }
  }
  await erase(id, "table", tableId);
}
