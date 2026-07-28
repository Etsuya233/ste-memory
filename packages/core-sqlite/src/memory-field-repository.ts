import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldRepository,
  MemoryFieldType,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core";
import { openSqliteDatabase } from "./database.ts";
import { MemoryDefinitionStatements } from "./memory-definition-statements.ts";

interface MemoryFieldRow {
  readonly id: string;
  readonly memory_space_id: string;
  readonly table_id: string;
  readonly name: string;
  readonly type: string;
  readonly required: number;
  readonly prompt: string;
  readonly enabled: number;
  readonly position: number;
  readonly options_json: string;
  readonly reference_table_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toMemoryField(row: MemoryFieldRow): MemoryField {
  return {
    id: row.id as MemoryFieldId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    tableId: row.table_id as MemoryTableId,
    name: row.name,
    type: row.type as MemoryFieldType,
    required: row.required === 1,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    position: row.position,
    options: JSON.parse(row.options_json) as string[],
    referenceTableId: row.reference_table_id as MemoryTableId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMemoryFieldRepository implements MemoryFieldRepository {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  create(field: MemoryField): void {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      new MemoryDefinitionStatements(database).createField(field);
    } finally {
      database.close();
    }
  }

  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return (
        database
          .prepare(
            "DELETE FROM memory_fields WHERE memory_space_id = ? AND table_id = ? AND id = ?",
          )
          .run(memorySpaceId, tableId, id).changes === 1
      );
    } finally {
      database.close();
    }
  }

  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): MemoryField | undefined {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const row = database
        .prepare(
          "SELECT * FROM memory_fields WHERE memory_space_id = ? AND table_id = ? AND id = ?",
        )
        .get(memorySpaceId, tableId, id);
      return row ? toMemoryField(row as unknown as MemoryFieldRow) : undefined;
    } finally {
      database.close();
    }
  }

  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare(
          "SELECT * FROM memory_fields WHERE memory_space_id = ? AND table_id = ? ORDER BY position, id",
        )
        .all(memorySpaceId, tableId)
        .map((row) => toMemoryField(row as unknown as MemoryFieldRow));
    } finally {
      database.close();
    }
  }

  update(field: MemoryField): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return (
        database
          .prepare(
            `UPDATE memory_fields
             SET name = ?, required = ?, prompt = ?, enabled = ?, position = ?, options_json = ?,
                 reference_table_id = ?, updated_at = ?
             WHERE memory_space_id = ? AND table_id = ? AND id = ?`,
          )
          .run(
            field.name,
            field.required ? 1 : 0,
            field.prompt,
            field.enabled ? 1 : 0,
            field.position,
            JSON.stringify(field.options),
            field.referenceTableId,
            field.updatedAt,
            field.memorySpaceId,
            field.tableId,
            field.id,
          ).changes === 1
      );
    } finally {
      database.close();
    }
  }
}
