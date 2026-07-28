import type {
  CreateMemoryRecordInput,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryQuery,
  MemoryRecordId,
  MemoryRecordPage,
  MemorySpaceId,
  MemoryTableId,
  MemoryRevisionId,
  MemoryRevisionSource,
  UpdateMemoryRecordInput,
} from "@ste-memory/core";

export interface MemoryRecordManager {
  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined>;
  list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): Promise<MemoryRecordPage | undefined>;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    input: UpdateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined>;
  delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    expectedRevisionId: MemoryRevisionId,
    revisionSource: MemoryRevisionSource,
  ): Promise<boolean>;
  listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): Promise<readonly MemoryRecordHistory[]>;
}
