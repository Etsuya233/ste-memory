import type {
  MemorySpaceId,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
  MemoryTableKey,
  MemoryTableKind,
} from "@ste-memory/core/memory";
import type { MemoryTableRepository } from "@ste-memory/core/memory/adapter";
import type { DatabaseContext } from "../database/database-context.ts";
import type { MemoryTablesTable } from "../database/schema/database.ts";

function toMemoryTable(row: MemoryTablesTable): MemoryTable {
  return {
    id: row.id as MemoryTableId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    key: row.key as MemoryTableKey,
    kind: row.kind as MemoryTableKind,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    displayStrategy: row.display_strategy
      ? (JSON.parse(row.display_strategy) as MemoryTableDisplayStrategy)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class KyselyMemoryTableRepository implements MemoryTableRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  async create(table: MemoryTable): Promise<void> {
    await this.#context.database
      .insertInto("memory_tables")
      .values({
        id: table.id,
        memory_space_id: table.memorySpaceId,
        key: table.key,
        kind: table.kind,
        name: table.name,
        description: table.description,
        prompt: table.prompt,
        enabled: table.enabled ? 1 : 0,
        display_strategy: table.displayStrategy ? JSON.stringify(table.displayStrategy) : null,
        created_at: table.createdAt,
        updated_at: table.updatedAt,
      })
      .execute();
  }

  async delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean> {
    const result = await this.#context.database
      .deleteFrom("memory_tables")
      .where("memory_space_id", "=", memorySpaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  async find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_tables")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toMemoryTable(row) : undefined;
  }

  async findByKey(
    memorySpaceId: MemorySpaceId,
    key: MemoryTableKey,
  ): Promise<MemoryTable | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_tables")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? toMemoryTable(row) : undefined;
  }

  async list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]> {
    const rows = await this.#context.database
      .selectFrom("memory_tables")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toMemoryTable);
  }

  async update(table: MemoryTable): Promise<boolean> {
    const result = await this.#context.database
      .updateTable("memory_tables")
      .set({
        key: table.key,
        name: table.name,
        description: table.description,
        prompt: table.prompt,
        enabled: table.enabled ? 1 : 0,
        display_strategy: table.displayStrategy ? JSON.stringify(table.displayStrategy) : null,
        updated_at: table.updatedAt,
      })
      .where("memory_space_id", "=", table.memorySpaceId)
      .where("id", "=", table.id)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
