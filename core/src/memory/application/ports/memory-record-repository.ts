import type {
  MemoryEvidence,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
  MemoryRevisionId,
} from "../../domain/index.ts";

export interface MemoryEvidenceRepository {
  findEvidence(
    memorySpaceId: MemorySpaceId,
    sourceType: string,
    sourceId: string | number,
  ): Promise<MemoryEvidence | undefined>;
  createEvidence(memorySpaceId: MemorySpaceId, evidence: MemoryEvidence): Promise<void>;
}

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
  create(record: MemoryRecord): Promise<void>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryRecord[]>;
  commit(mutations: readonly MemoryRecordMutation[]): Promise<boolean>;
  listHistory(query: MemoryRecordHistoryQuery): Promise<MemoryRecordHistory[]>;
}
