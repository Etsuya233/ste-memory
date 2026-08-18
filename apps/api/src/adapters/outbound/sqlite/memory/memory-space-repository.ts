import type { MemorySpace, MemorySpaceId } from "@ste-memory/core/memory";
import type { MemorySpaceRepository } from "@ste-memory/core/memory/adapter";
import type { UnitOfWork } from "@ste-memory/tools";
import type { DatabaseContext } from "../database/database-context.ts";

export class KyselyMemorySpaceRepository implements MemorySpaceRepository {
  readonly #context: DatabaseContext;
  readonly #unitOfWork: UnitOfWork;

  constructor(context: DatabaseContext, unitOfWork: UnitOfWork) {
    this.#context = context;
    this.#unitOfWork = unitOfWork;
  }

  async create(memorySpace: MemorySpace): Promise<void> {
    await this.#context.database
      .insertInto("memory_spaces")
      .values({
        id: memorySpace.id,
        name: memorySpace.name,
        created_at: memorySpace.createdAt,
        updated_at: memorySpace.updatedAt,
      })
      .execute();
  }

  async delete(id: MemorySpaceId): Promise<boolean> {
    const result = await this.#context.database
      .deleteFrom("memory_spaces")
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  async find(id: MemorySpaceId): Promise<MemorySpace | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_spaces")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row
      ? {
          id: row.id as MemorySpaceId,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async list(): Promise<MemorySpace[]> {
    const rows = await this.#context.database
      .selectFrom("memory_spaces")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map((row) => ({
      id: row.id as MemorySpaceId,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async rename(
    id: MemorySpaceId,
    name: string,
    updatedAt: string,
  ): Promise<MemorySpace | undefined> {
    const result = await this.#context.database
      .updateTable("memory_spaces")
      .set({ name, updated_at: updatedAt })
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n ? this.find(id) : undefined;
  }

  /**
   * 清除空间记录（spec reset-space）：单事务删除该空间全部记录派生数据
   * （记录 / 历史 / 证据），表格定义与字段保留（与 Dexie 镜像实现同语义）。
   */
  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    return this.#unitOfWork.run(async () => {
      if (!(await this.#spaceExists(id))) return false;
      await this.#context.database
        .deleteFrom("memory_records")
        .where("memory_space_id", "=", id)
        .execute();
      await this.#context.database
        .deleteFrom("memory_record_history")
        .where("memory_space_id", "=", id)
        .execute();
      await this.#context.database
        .deleteFrom("memory_evidence")
        .where("memory_space_id", "=", id)
        .execute();
      return true;
    });
  }

  /**
   * 重置空间（spec reset-space）：单事务删除该空间全部表格（字段/记录/历史经
   * ON DELETE CASCADE 级联删除），证据按空间显式删除；空间实体本身保留。
   */
  async deleteAllTables(id: MemorySpaceId): Promise<boolean> {
    return this.#unitOfWork.run(async () => {
      if (!(await this.#spaceExists(id))) return false;
      await this.#context.database
        .deleteFrom("memory_evidence")
        .where("memory_space_id", "=", id)
        .execute();
      // 字段必须先删：memory_fields.reference_table_id 是 ON DELETE RESTRICT，
      // 引用其他表的字段还在时不能删被引用表（记录/历史经 table_id 级联删除）。
      await this.#context.database
        .deleteFrom("memory_fields")
        .where("memory_space_id", "=", id)
        .execute();
      await this.#context.database
        .deleteFrom("memory_tables")
        .where("memory_space_id", "=", id)
        .execute();
      return true;
    });
  }

  async #spaceExists(id: MemorySpaceId): Promise<boolean> {
    const row = await this.#context.database
      .selectFrom("memory_spaces")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    return row !== undefined;
  }
}
