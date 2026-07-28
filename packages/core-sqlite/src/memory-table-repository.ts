import type {
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKind,
  MemoryTableDisplayStrategy,
  MemoryTableRepository,
  SystemMemoryTableKey,
} from "@ste-memory/core";
import { openSqliteDatabase } from "./database.ts";
import { MemoryDefinitionStatements } from "./memory-definition-statements.ts";

interface MemoryTableRow {
  readonly id: string;
  readonly memory_space_id: string;
  readonly kind: string;
  readonly system_key: string | null;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly display_strategy: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toMemoryTable(row: MemoryTableRow): MemoryTable {
  return {
    id: row.id as MemoryTableId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    kind: row.kind as MemoryTableKind,
    systemKey: row.system_key as SystemMemoryTableKey | null,
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

export class SqliteMemoryTableRepository implements MemoryTableRepository {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  create(memoryTable: MemoryTable): void {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      new MemoryDefinitionStatements(database).createTable(memoryTable);
    } finally {
      database.close();
    }
  }

  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return (
        database
          .prepare("DELETE FROM memory_tables WHERE memory_space_id = ? AND id = ?")
          .run(memorySpaceId, id).changes === 1
      );
    } finally {
      database.close();
    }
  }

  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const row = database
        .prepare("SELECT * FROM memory_tables WHERE memory_space_id = ? AND id = ?")
        .get(memorySpaceId, id);
      return row ? toMemoryTable(row as unknown as MemoryTableRow) : undefined;
    } finally {
      database.close();
    }
  }

  list(memorySpaceId: MemorySpaceId): MemoryTable[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare("SELECT * FROM memory_tables WHERE memory_space_id = ? ORDER BY created_at, id")
        .all(memorySpaceId)
        .map((row) => toMemoryTable(row as unknown as MemoryTableRow));
    } finally {
      database.close();
    }
  }

  update(memoryTable: MemoryTable): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return (
        database
          .prepare(
            `
          UPDATE memory_tables
          SET name = ?, description = ?, prompt = ?, enabled = ?, display_strategy = ?, updated_at = ?
          WHERE memory_space_id = ? AND id = ?
        `,
          )
          .run(
            memoryTable.name,
            memoryTable.description,
            memoryTable.prompt,
            memoryTable.enabled ? 1 : 0,
            memoryTable.displayStrategy ? JSON.stringify(memoryTable.displayStrategy) : null,
            memoryTable.updatedAt,
            memoryTable.memorySpaceId,
            memoryTable.id,
          ).changes === 1
      );
    } finally {
      database.close();
    }
  }
}
