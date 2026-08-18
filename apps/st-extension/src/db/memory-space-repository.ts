import { Dexie } from "dexie";
import type { MemorySpace, MemorySpaceId, MemoryTableId } from "@ste-memory/core/memory";
import type { MemorySpaceRepository } from "@ste-memory/core/memory/adapter";
import type { SteMemoryDatabase } from "./database.ts";

/** core MemorySpaceRepository 端口的 Dexie（IndexedDB）实现（ADR 0002）。 */
export class DexieMemorySpaceRepository implements MemorySpaceRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async create(memorySpace: MemorySpace): Promise<void> {
    await this.#db.memorySpaces.add(memorySpace);
  }

  async delete(id: MemorySpaceId): Promise<boolean> {
    // 与 SQLite 参照实现的 ON DELETE CASCADE 同语义：删空间连带删其表格、字段、
    // 记录、修订历史、字段证据、填表任务与楼层进度台账（ticket 13 新增两张表）
    return this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
        this.#db.memoryFillTasks,
        this.#db.floorFillLedger,
        this.#db.memoryLogs,
      ],
      async () => {
        const space = await this.#db.memorySpaces.get(id);
        if (!space) return false;
        const tables = await this.#db.memoryTables.where("memorySpaceId").equals(id).toArray();
        for (const table of tables) {
          await this.#deleteTableData(id, table.id);
        }
        await this.#db.memoryRecordHistory.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryEvidence.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryFillTasks.where("memorySpaceId").equals(id).delete();
        await this.#db.floorFillLedger.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryLogs.where("spaceId").equals(id).delete();
        await this.#db.memoryTables.where("memorySpaceId").equals(id).delete();
        await this.#db.memorySpaces.delete(id);
        return true;
      },
    );
  }

  async find(id: MemorySpaceId): Promise<MemorySpace | undefined> {
    return this.#db.memorySpaces.get(id);
  }

  /**
   * 清除空间记录（spec reset-space）：单事务删除该空间全部记录派生数据
   * （记录 / 历史 / 证据），表格定义与字段保留（与 SQLite 参照实现同语义）。
   */
  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    return this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        if (!(await this.#db.memorySpaces.get(id))) return false;
        await this.#db.memoryRecords.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryRecordHistory.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryEvidence.where("memorySpaceId").equals(id).delete();
        return true;
      },
    );
  }

  /**
   * 重置空间（spec reset-space）：单事务删除该空间全部表格（字段/记录/历史
   * 一并删除），证据按空间删除；空间实体本身保留（与 SQLite 参照实现同语义）。
   */
  async deleteAllTables(id: MemorySpaceId): Promise<boolean> {
    return this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        if (!(await this.#db.memorySpaces.get(id))) return false;
        const tables = await this.#db.memoryTables.where("memorySpaceId").equals(id).toArray();
        for (const table of tables) {
          await this.#deleteTableData(id, table.id);
        }
        // 孤儿历史兜底（与 delete 同语义）：历史行可能因更早的部分删除而无归属表
        await this.#db.memoryRecordHistory.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryEvidence.where("memorySpaceId").equals(id).delete();
        await this.#db.memoryTables.where("memorySpaceId").equals(id).delete();
        return true;
      },
    );
  }

  /** 删除一张表的字段/记录/历史（空间级联删除与重置空间共用，与 SQLite 参照实现同语义）。 */
  async #deleteTableData(id: MemorySpaceId, tableId: MemoryTableId): Promise<void> {
    await this.#db.memoryFields.where("[memorySpaceId+tableId]").equals([id, tableId]).delete();
    await this.#db.memoryRecords.where("[memorySpaceId+tableId]").equals([id, tableId]).delete();
    await this.#db.memoryRecordHistory
      .where("[memorySpaceId+tableId+recordId]")
      .between([id, tableId, Dexie.minKey], [id, tableId, Dexie.maxKey])
      .delete();
  }

  async list(): Promise<MemorySpace[]> {
    const spaces = await this.#db.memorySpaces.toArray();
    // 与 SQLite 参照实现同语义：创建时间倒序（id 兜底，保证确定性）
    return spaces.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  }

  async rename(
    id: MemorySpaceId,
    name: string,
    updatedAt: string,
  ): Promise<MemorySpace | undefined> {
    const count = await this.#db.memorySpaces.update(id, { name, updatedAt });
    return count > 0 ? this.find(id) : undefined;
  }
}
