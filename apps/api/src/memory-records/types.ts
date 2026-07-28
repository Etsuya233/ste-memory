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
  ): MemoryRecord | undefined;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): MemoryRecord | undefined;
  list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): MemoryRecordPage | undefined;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    input: UpdateMemoryRecordInput,
  ): MemoryRecord | undefined;
  delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    expectedRevisionId: MemoryRevisionId,
    revisionSource: MemoryRevisionSource,
  ): boolean;
  listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): readonly MemoryRecordHistory[];
}
