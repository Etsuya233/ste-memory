import type {
  MemoryRecord,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "../../domain/index.ts";

export interface MemoryRecordRepository {
  create(record: MemoryRecord): void;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): MemoryRecord | undefined;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryRecord[];
}
