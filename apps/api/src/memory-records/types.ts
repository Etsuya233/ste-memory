import type {
  CreateMemoryRecordInput,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordPage,
  MemorySpaceId,
  MemoryTableId,
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
}
