import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryField, MemoryTable } from "@ste-memory/core";

export class MemoryDefinitionStatements {
  private readonly createTableStatement: StatementSync;
  private readonly createFieldStatement: StatementSync;

  constructor(database: DatabaseSync) {
    this.createTableStatement = database.prepare(`INSERT INTO memory_tables (
      id, memory_space_id, kind, system_key, name, description, prompt, enabled,
      display_strategy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.createFieldStatement = database.prepare(`INSERT INTO memory_fields (
      id, memory_space_id, table_id, name, type, required, prompt, enabled, position,
      options_json, reference_table_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  createTable(table: MemoryTable): void {
    this.createTableStatement.run(
      table.id,
      table.memorySpaceId,
      table.kind,
      table.systemKey,
      table.name,
      table.description,
      table.prompt,
      table.enabled ? 1 : 0,
      table.displayStrategy ? JSON.stringify(table.displayStrategy) : null,
      table.createdAt,
      table.updatedAt,
    );
  }

  createField(field: MemoryField): void {
    this.createFieldStatement.run(
      field.id,
      field.memorySpaceId,
      field.tableId,
      field.name,
      field.type,
      field.required ? 1 : 0,
      field.prompt,
      field.enabled ? 1 : 0,
      field.position,
      JSON.stringify(field.options),
      field.referenceTableId,
      field.createdAt,
      field.updatedAt,
    );
  }
}
