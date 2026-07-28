import type { MemorySpace, MemorySpaceId, MemorySpaceRepository } from "@ste-memory/core";
import type { DatabaseContext } from "../database/database-context.ts";

export class KyselyMemorySpaceRepository implements MemorySpaceRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
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
}
