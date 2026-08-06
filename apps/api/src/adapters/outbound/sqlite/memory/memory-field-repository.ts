import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryFieldType,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { MemoryFieldRepository } from "@ste-memory/core/memory/adapter";
import type { DatabaseContext } from "../database/database-context.ts";
import type { MemoryFieldsTable } from "../database/schema/database.ts";

function toMemoryField(row: MemoryFieldsTable): MemoryField {
  return {
    id: row.id as MemoryFieldId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    tableId: row.table_id as MemoryTableId,
    key: row.key as MemoryFieldKey,
    name: row.name,
    type: row.type as MemoryFieldType,
    required: row.required === 1,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    position: row.position,
    options: JSON.parse(row.options_json) as string[],
    referenceTableId: row.reference_table_id as MemoryTableId | null,
    maxChars: row.max_chars,
    valuePattern: row.value_pattern,
    valuePatternMessage: row.value_pattern_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class KyselyMemoryFieldRepository implements MemoryFieldRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  async create(field: MemoryField): Promise<void> {
    await this.#context.database
      .insertInto("memory_fields")
      .values({
        id: field.id,
        memory_space_id: field.memorySpaceId,
        table_id: field.tableId,
        key: field.key,
        name: field.name,
        type: field.type,
        required: field.required ? 1 : 0,
        prompt: field.prompt,
        enabled: field.enabled ? 1 : 0,
        position: field.position,
        options_json: JSON.stringify(field.options),
        reference_table_id: field.referenceTableId,
        max_chars: field.maxChars,
        value_pattern: field.valuePattern,
        value_pattern_message: field.valuePatternMessage,
        created_at: field.createdAt,
        updated_at: field.updatedAt,
      })
      .execute();
  }

  async delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<boolean> {
    const result = await this.#context.database
      .deleteFrom("memory_fields")
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_fields")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toMemoryField(row) : undefined;
  }

  async findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): Promise<MemoryField | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_fields")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? toMemoryField(row) : undefined;
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]> {
    const rows = await this.#context.database
      .selectFrom("memory_fields")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .orderBy("position")
      .orderBy("id")
      .execute();
    return rows.map(toMemoryField);
  }

  async update(field: MemoryField): Promise<boolean> {
    const result = await this.#context.database
      .updateTable("memory_fields")
      .set({
        key: field.key,
        name: field.name,
        required: field.required ? 1 : 0,
        prompt: field.prompt,
        enabled: field.enabled ? 1 : 0,
        position: field.position,
        options_json: JSON.stringify(field.options),
        reference_table_id: field.referenceTableId,
        max_chars: field.maxChars,
        value_pattern: field.valuePattern,
        value_pattern_message: field.valuePatternMessage,
        updated_at: field.updatedAt,
      })
      .where("memory_space_id", "=", field.memorySpaceId)
      .where("table_id", "=", field.tableId)
      .where("id", "=", field.id)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}
