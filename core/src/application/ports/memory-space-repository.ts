import type { MemorySpace, MemorySpaceId } from "../../domain/index.ts";

export interface MemorySpaceRepository {
  create(memorySpace: MemorySpace): Promise<void>;
  delete(id: MemorySpaceId): Promise<boolean>;
  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  list(): Promise<MemorySpace[]>;
  rename(id: MemorySpaceId, name: string, updatedAt: string): Promise<MemorySpace | undefined>;
}
