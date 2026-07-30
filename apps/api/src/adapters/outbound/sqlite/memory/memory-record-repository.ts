import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRecordSource,
  MemoryRevisionId,
  MemoryRevisionSource,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type {
  MemoryRecordHistoryQuery,
  MemoryRecordMutation,
  MemoryRecordRepository,
} from "@ste-memory/core/memory/adapter";
import type { UnitOfWork } from "@ste-memory/tools";
import type { DatabaseContext } from "../database/database-context.ts";
import type { MemoryRecordHistoryTable, MemoryRecordsTable } from "../database/schema/database.ts";

class StaleRecordError extends Error {}

function toMemoryRecord(row: MemoryRecordsTable): MemoryRecord {
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

function toMemoryRecordHistory(row: MemoryRecordHistoryTable): MemoryRecordHistory {
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

export class KyselyMemoryRecordRepository implements MemoryRecordRepository {
  readonly #context: DatabaseContext;
  readonly #unitOfWork: UnitOfWork;

  constructor(context: DatabaseContext, unitOfWork: UnitOfWork) {
    this.#context = context;
    this.#unitOfWork = unitOfWork;
  }

  async create(record: MemoryRecord): Promise<void> {
    await this.#context.database
      .insertInto("memory_records")
      .values({
        id: record.id,
        memory_space_id: record.memorySpaceId,
        table_id: record.tableId,
        payload_json: JSON.stringify(record.payload),
        display_text: record.displayText,
        source_json: JSON.stringify(record.source),
        revision_id: record.revisionId,
        revision_source: record.revisionSource,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .execute();
  }

  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_records")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? toMemoryRecord(row) : undefined;
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryRecord[]> {
    const rows = await this.#context.database
      .selectFrom("memory_records")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("table_id", "=", tableId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toMemoryRecord);
  }

  async commit(mutations: readonly MemoryRecordMutation[]): Promise<boolean> {
    try {
      await this.#unitOfWork.run(async () => {
        for (const mutation of mutations) {
          const history = mutation.history;
          await this.#context.database
            .insertInto("memory_record_history")
            .values({
              id: history.id,
              record_id: history.recordId,
              memory_space_id: history.memorySpaceId,
              table_id: history.tableId,
              payload_json: JSON.stringify(history.payload),
              display_text: history.displayText,
              source_json: JSON.stringify(history.source),
              previous_revision_id: history.previousRevisionId,
              previous_revision_source: history.previousRevisionSource,
              revision_id: history.revisionId,
              revision_source: history.revisionSource,
              created_at: history.createdAt,
              updated_at: history.updatedAt,
              archived_at: history.archivedAt,
            })
            .execute();
          const result = mutation.current
            ? await this.#context.database
                .updateTable("memory_records")
                .set({
                  payload_json: JSON.stringify(mutation.current.payload),
                  display_text: mutation.current.displayText,
                  source_json: JSON.stringify(mutation.current.source),
                  revision_id: mutation.current.revisionId,
                  revision_source: mutation.current.revisionSource,
                  created_at: mutation.current.createdAt,
                  updated_at: mutation.current.updatedAt,
                })
                .where("memory_space_id", "=", mutation.previous.memorySpaceId)
                .where("table_id", "=", mutation.previous.tableId)
                .where("id", "=", mutation.previous.id)
                .where("revision_id", "=", mutation.previous.revisionId)
                .executeTakeFirst()
            : await this.#context.database
                .deleteFrom("memory_records")
                .where("memory_space_id", "=", mutation.previous.memorySpaceId)
                .where("table_id", "=", mutation.previous.tableId)
                .where("id", "=", mutation.previous.id)
                .where("revision_id", "=", mutation.previous.revisionId)
                .executeTakeFirst();
          const changed =
            "numUpdatedRows" in result ? result.numUpdatedRows : result.numDeletedRows;
          if (changed !== 1n) throw new StaleRecordError();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof StaleRecordError) return false;
      throw error;
    }
  }

  async listHistory(query: MemoryRecordHistoryQuery): Promise<MemoryRecordHistory[]> {
    let selection = this.#context.database
      .selectFrom("memory_record_history")
      .selectAll()
      .where("memory_space_id", "=", query.memorySpaceId);
    if (query.tableId !== undefined) selection = selection.where("table_id", "=", query.tableId);
    if (query.recordId !== undefined) selection = selection.where("record_id", "=", query.recordId);
    if (query.revisionId !== undefined)
      selection = selection.where("revision_id", "=", query.revisionId);
    if (query.archivedFrom !== undefined)
      selection = selection.where("archived_at", ">=", query.archivedFrom);
    if (query.archivedTo !== undefined)
      selection = selection.where("archived_at", "<=", query.archivedTo);
    const rows = await selection.orderBy("archived_at", "desc").orderBy("id").execute();
    return rows.map(toMemoryRecordHistory);
  }
}
