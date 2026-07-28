import { memorySpaceName, type MemorySpace, type MemorySpaceId } from "../domain/index.ts";
import type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";

export class MemorySpaceService {
  private readonly repository: MemorySpaceRepository;
  private readonly createId: () => MemorySpaceId;
  private readonly now: () => string;

  constructor(repository: MemorySpaceRepository, createId: () => MemorySpaceId, now: () => string) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  create(name: string): MemorySpace {
    const now = this.now();
    const memorySpace: MemorySpace = {
      id: this.createId(),
      name: memorySpaceName(name),
      createdAt: now,
      updatedAt: now,
    };
    this.repository.create(memorySpace);
    return memorySpace;
  }

  delete(id: MemorySpaceId): boolean {
    return this.repository.delete(id);
  }

  find(id: MemorySpaceId): MemorySpace | undefined {
    return this.repository.find(id);
  }

  list(): MemorySpace[] {
    return this.repository.list();
  }

  rename(id: MemorySpaceId, name: string): MemorySpace | undefined {
    return this.repository.rename(id, memorySpaceName(name), this.now());
  }
}
