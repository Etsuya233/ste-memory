import { Dexie } from "dexie";
import type {
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "@ste-memory/core/memory";
import type { MemoryTableRepository } from "@ste-memory/core/memory/adapter";
import type { SteMemoryDatabase } from "./database.ts";

/**
 * core MemoryTableRepository 端口的 Dexie（IndexedDB）实现（ADR 0002）。
 *
 * 作用域规则：find/delete/update 都以「id 命中 + memorySpaceId 匹配」为准，
 * 跨空间操作一律视为未命中（与 SQLite 参照实现同语义）。
 */
export class DexieMemoryTableRepository implements MemoryTableRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async create(memoryTable: MemoryTable): Promise<void> {
    await this.#db.memoryTables.add(memoryTable);
  }

  async delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean> {
    // 与 SQLite 参照实现的 ON DELETE CASCADE 同语义：删表格连带删其字段定义、
    // 当前记录与修订历史（证据只挂在空间上，不随表删）
    return this.#db.transaction(
      "rw",
      [
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
      ],
      async () => {
        const table = await this.#db.memoryTables.get(id);
        if (!table || table.memorySpaceId !== memorySpaceId) return false;
        await this.#db.memoryFields
          .where("[memorySpaceId+tableId]")
          .equals([memorySpaceId, id])
          .delete();
        await this.#db.memoryRecords
          .where("[memorySpaceId+tableId]")
          .equals([memorySpaceId, id])
          .delete();
        await this.#db.memoryRecordHistory
          .where("[memorySpaceId+tableId+recordId]")
          .between([memorySpaceId, id, Dexie.minKey], [memorySpaceId, id, Dexie.maxKey])
          .delete();
        await this.#db.memoryTables.delete(id);
        return true;
      },
    );
  }

  async find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined> {
    const table = await this.#db.memoryTables.get(id);
    return table?.memorySpaceId === memorySpaceId ? table : undefined;
  }

  async findByKey(
    memorySpaceId: MemorySpaceId,
    key: MemoryTableKey,
  ): Promise<MemoryTable | undefined> {
    return this.#db.memoryTables
      .where("[memorySpaceId+key]")
      .equals([memorySpaceId, key])
      .first();
  }

  async list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]> {
    const tables = await this.#db.memoryTables
      .where("memorySpaceId")
      .equals(memorySpaceId)
      .toArray();
    // 与 SQLite 参照实现同语义：创建时间升序（id 兜底，保证确定性）
    return tables.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  async update(memoryTable: MemoryTable): Promise<boolean> {
    const current = await this.find(memoryTable.memorySpaceId, memoryTable.id);
    if (!current) return false;
    // 与 SQLite 参照实现的 .set() 同语义：只写可变字段，createdAt 是创建事实不覆盖
    const count = await this.#db.memoryTables.update(memoryTable.id, {
      key: memoryTable.key,
      name: memoryTable.name,
      description: memoryTable.description,
      prompt: memoryTable.prompt,
      enabled: memoryTable.enabled,
      displayStrategy: memoryTable.displayStrategy,
      updatedAt: memoryTable.updatedAt,
    });
    return count > 0;
  }
}
