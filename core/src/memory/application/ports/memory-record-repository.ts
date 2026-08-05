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
}

/**
 * 一次原子批次内的一条记录变更：
 * - create：新建记录（无旧状态、无历史快照）；
 * - replace：更新（含 current）或删除（无 current）一条已有记录，并保留旧状态历史。
 */
export type MemoryRecordMutation =
  | { readonly kind: "create"; readonly current: MemoryRecord }
  | {
      readonly kind: "replace";
      readonly previous: MemoryRecord;
      readonly current?: MemoryRecord;
      readonly history: MemoryRecordHistory;
    };

export interface MemoryRecordHistoryQuery {
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId?: MemoryTableId;
  readonly recordId?: MemoryRecordId;
  readonly revisionId?: MemoryRevisionId;
  readonly archivedFrom?: string;
  readonly archivedTo?: string;
}

export interface MemoryRecordRepository {
  create(record: MemoryRecord, evidence: readonly MemoryEvidence[]): Promise<void>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryRecord[]>;
  commit(
    mutations: readonly MemoryRecordMutation[],
    evidence: readonly MemoryEvidence[],
  ): Promise<boolean>;
  listHistory(query: MemoryRecordHistoryQuery): Promise<MemoryRecordHistory[]>;
}
