import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
  MemoryRevisionId,
} from "../../domain/index.ts";

export interface MemoryRecordMutation {
  readonly previous: MemoryRecord;
  readonly current?: MemoryRecord;
  readonly history: MemoryRecordHistory;
}

export interface MemoryRecordHistoryQuery {
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId?: MemoryTableId;
  readonly recordId?: MemoryRecordId;
  readonly revisionId?: MemoryRevisionId;
  readonly archivedFrom?: string;
  readonly archivedTo?: string;
}

export interface MemoryRecordRepository {
  create(record: MemoryRecord): void;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): MemoryRecord | undefined;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryRecord[];
  commit(mutations: readonly MemoryRecordMutation[]): boolean;
  listHistory(query: MemoryRecordHistoryQuery): MemoryRecordHistory[];
}
