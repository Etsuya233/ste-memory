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

  /** 清除空间记录（spec reset-space）：删除该空间全部记录派生数据，保留表格结构。 */
  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    return this.repository.clearRecords(id);
  }

  /** 重置空间（spec reset-space）：删除该空间全部表格（级联字段/记录/历史/证据），空间实体保留。 */
  async deleteAllTables(id: MemorySpaceId): Promise<boolean> {
    return this.repository.deleteAllTables(id);
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
