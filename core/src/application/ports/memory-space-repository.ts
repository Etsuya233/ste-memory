import type { MemorySpace, MemorySpaceId } from "../../domain/index.ts";

export interface MemorySpaceRepository {
  create(memorySpace: MemorySpace): void;
  delete(id: MemorySpaceId): boolean;
  find(id: MemorySpaceId): MemorySpace | undefined;
  list(): MemorySpace[];
  rename(id: MemorySpaceId, name: string, updatedAt: string): MemorySpace | undefined;
}
