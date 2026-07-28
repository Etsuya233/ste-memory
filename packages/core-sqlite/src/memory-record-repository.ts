import type {
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRecordRepository,
  MemoryRecordSource,
  MemoryRevisionId,
  MemoryRevisionSource,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core";
import { openSqliteDatabase } from "./database.ts";

interface MemoryRecordRow {
  readonly id: string;
  readonly memory_space_id: string;
  readonly table_id: string;
  readonly payload_json: string;
  readonly display_text: string;
  readonly source_json: string;
  readonly revision_id: string;
  readonly revision_source: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  return {
    id: row.id as MemoryRecordId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    tableId: row.table_id as MemoryTableId,
    payload: JSON.parse(row.payload_json) as MemoryRecordPayload,
    displayText: row.display_text,
    source: JSON.parse(row.source_json) as MemoryRecordSource,
    revisionId: row.revision_id as MemoryRevisionId,
    revisionSource: row.revision_source as MemoryRevisionSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteMemoryRecordRepository implements MemoryRecordRepository {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  create(record: MemoryRecord): void {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      database
        .prepare(
          `INSERT INTO memory_records (
          id, memory_space_id, table_id, payload_json, display_text, source_json,
          revision_id, revision_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.memorySpaceId,
          record.tableId,
          JSON.stringify(record.payload),
          record.displayText,
          JSON.stringify(record.source),
          record.revisionId,
          record.revisionSource,
          record.createdAt,
          record.updatedAt,
        );
    } finally {
      database.close();
    }
  }

  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): MemoryRecord | undefined {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const row = database
        .prepare(
          "SELECT * FROM memory_records WHERE memory_space_id = ? AND table_id = ? AND id = ?",
        )
        .get(memorySpaceId, tableId, id);
      return row ? toMemoryRecord(row as unknown as MemoryRecordRow) : undefined;
    } finally {
      database.close();
    }
  }

  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryRecord[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare(
          "SELECT * FROM memory_records WHERE memory_space_id = ? AND table_id = ? ORDER BY created_at, id",
        )
        .all(memorySpaceId, tableId)
        .map((row) => toMemoryRecord(row as unknown as MemoryRecordRow));
    } finally {
      database.close();
    }
  }
}
