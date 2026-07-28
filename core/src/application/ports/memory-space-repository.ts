import type { MemoryField, MemorySpace, MemorySpaceId, MemoryTable } from "../../domain/index.ts";

export interface MemorySpaceRepository {
  create(
    memorySpace: MemorySpace,
    systemTables: readonly MemoryTable[],
    systemFields: readonly MemoryField[],
  ): void;
  delete(id: MemorySpaceId): boolean;
  find(id: MemorySpaceId): MemorySpace | undefined;
  list(): MemorySpace[];
  rename(id: MemorySpaceId, name: string, updatedAt: string): MemorySpace | undefined;
}
