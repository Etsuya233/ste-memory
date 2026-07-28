import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordHistoryQuery,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRecordRepository,
  MemoryRecordMutation,
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

interface MemoryRecordHistoryRow {
  readonly id: string;
  readonly record_id: string;
  readonly memory_space_id: string;
  readonly table_id: string;
  readonly payload_json: string;
  readonly display_text: string;
  readonly source_json: string;
  readonly previous_revision_id: string;
  readonly previous_revision_source: string;
  readonly revision_id: string;
  readonly revision_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string;
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

function toMemoryRecordHistory(row: MemoryRecordHistoryRow): MemoryRecordHistory {
  return {
    id: row.id as MemoryRecordHistoryId,
    recordId: row.record_id as MemoryRecordId,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    tableId: row.table_id as MemoryTableId,
    payload: JSON.parse(row.payload_json) as MemoryRecordPayload,
    displayText: row.display_text,
    source: JSON.parse(row.source_json) as MemoryRecordSource,
    previousRevisionId: row.previous_revision_id as MemoryRevisionId,
    previousRevisionSource: row.previous_revision_source as MemoryRevisionSource,
    revisionId: row.revision_id as MemoryRevisionId,
    revisionSource: row.revision_source as MemoryRevisionSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
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

  commit(mutations: readonly MemoryRecordMutation[]): boolean {
    const database = openSqliteDatabase(this.databaseUrl);
    database.exec("BEGIN IMMEDIATE");
    try {
      const insertHistory = database.prepare(`INSERT INTO memory_record_history (
        id, record_id, memory_space_id, table_id, payload_json, display_text, source_json,
        previous_revision_id, previous_revision_source, revision_id, revision_source,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const updateRecord = database.prepare(`UPDATE memory_records SET
        payload_json = ?, display_text = ?, source_json = ?, revision_id = ?,
        revision_source = ?, created_at = ?, updated_at = ?
        WHERE memory_space_id = ? AND table_id = ? AND id = ? AND revision_id = ?`);
      const deleteRecord = database.prepare(
        "DELETE FROM memory_records WHERE memory_space_id = ? AND table_id = ? AND id = ? AND revision_id = ?",
      );
      for (const mutation of mutations) {
        const history = mutation.history;
        insertHistory.run(
          history.id,
          history.recordId,
          history.memorySpaceId,
          history.tableId,
          JSON.stringify(history.payload),
          history.displayText,
          JSON.stringify(history.source),
          history.previousRevisionId,
          history.previousRevisionSource,
          history.revisionId,
          history.revisionSource,
          history.createdAt,
          history.updatedAt,
          history.archivedAt,
        );
        const result = mutation.current
          ? updateRecord.run(
              JSON.stringify(mutation.current.payload),
              mutation.current.displayText,
              JSON.stringify(mutation.current.source),
              mutation.current.revisionId,
              mutation.current.revisionSource,
              mutation.current.createdAt,
              mutation.current.updatedAt,
              mutation.previous.memorySpaceId,
              mutation.previous.tableId,
              mutation.previous.id,
              mutation.previous.revisionId,
            )
          : deleteRecord.run(
              mutation.previous.memorySpaceId,
              mutation.previous.tableId,
              mutation.previous.id,
              mutation.previous.revisionId,
            );
        if (result.changes !== 1) {
          database.exec("ROLLBACK");
          return false;
        }
      }
      database.exec("COMMIT");
      return true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  listHistory(query: MemoryRecordHistoryQuery): MemoryRecordHistory[] {
    const conditions = ["memory_space_id = ?"];
    const values: string[] = [query.memorySpaceId];
    const filters: readonly [string, string | undefined][] = [
      ["table_id = ?", query.tableId],
      ["record_id = ?", query.recordId],
      ["revision_id = ?", query.revisionId],
      ["archived_at >= ?", query.archivedFrom],
      ["archived_at <= ?", query.archivedTo],
    ];
    for (const [condition, value] of filters) {
      if (value !== undefined) {
        conditions.push(condition);
        values.push(value);
      }
    }
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare(
          `SELECT * FROM memory_record_history WHERE ${conditions.join(" AND ")} ORDER BY archived_at DESC, id`,
        )
        .all(...values)
        .map((row) => toMemoryRecordHistory(row as unknown as MemoryRecordHistoryRow));
    } finally {
      database.close();
    }
  }
}
