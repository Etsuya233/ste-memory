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

  async create(name: string): Promise<MemorySpace> {
    const now = this.now();
    const memorySpace: MemorySpace = {
      id: this.createId(),
      name: memorySpaceName(name),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.create(memorySpace);
    return memorySpace;
  }

  async delete(id: MemorySpaceId): Promise<boolean> {
    return this.repository.delete(id);
  }

  async find(id: MemorySpaceId): Promise<MemorySpace | undefined> {
    return this.repository.find(id);
  }

  async list(): Promise<MemorySpace[]> {
    return this.repository.list();
  }

  async rename(id: MemorySpaceId, name: string): Promise<MemorySpace | undefined> {
    return this.repository.rename(id, memorySpaceName(name), this.now());
  }
}
