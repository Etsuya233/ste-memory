import type {
  MemoryField,
  MemorySpace,
  MemorySpaceId,
  MemorySpaceRepository,
  MemoryTable,
} from "@ste-memory/core";
import { openSqliteDatabase } from "./database.ts";
import { MemoryDefinitionStatements } from "./memory-definition-statements.ts";

interface MemorySpaceRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toMemorySpace(row: MemorySpaceRow): MemorySpace {
  return {
    id: row.id as MemorySpaceId,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMemorySpaceRepository implements MemorySpaceRepository {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  create(
    memorySpace: MemorySpace,
    systemTables: readonly MemoryTable[],
    systemFields: readonly MemoryField[],
  ): void {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const createSpace = database.prepare(
        "INSERT INTO memory_spaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const definitions = new MemoryDefinitionStatements(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        createSpace.run(
          memorySpace.id,
          memorySpace.name,
          memorySpace.createdAt,
          memorySpace.updatedAt,
        );
        for (const table of systemTables) {
          definitions.createTable(table);
        }
        for (const field of systemFields) {
          definitions.createField(field);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }

  delete(id: MemorySpaceId): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database.prepare("DELETE FROM memory_spaces WHERE id = ?").run(id).changes === 1;
    } finally {
      database.close();
    }
  }

  find(id: MemorySpaceId): MemorySpace | undefined {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const row = database.prepare("SELECT * FROM memory_spaces WHERE id = ?").get(id);
      return row ? toMemorySpace(row as unknown as MemorySpaceRow) : undefined;
    } finally {
      database.close();
    }
  }

  list(): MemorySpace[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare("SELECT * FROM memory_spaces ORDER BY created_at DESC")
        .all()
        .map((row) => toMemorySpace(row as unknown as MemorySpaceRow));
    } finally {
      database.close();
    }
  }

  rename(id: MemorySpaceId, name: string, updatedAt: string): MemorySpace | undefined {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const result = database
        .prepare("UPDATE memory_spaces SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, updatedAt, id);
      if (result.changes === 0) return undefined;
      const row = database.prepare("SELECT * FROM memory_spaces WHERE id = ?").get(id);
      return toMemorySpace(row as unknown as MemorySpaceRow);
    } finally {
      database.close();
    }
  }
}
