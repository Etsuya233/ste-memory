import {
  memorySpaceName,
  type MemoryFieldId,
  type MemorySpace,
  type MemorySpaceId,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";
import { createSystemMemoryDefinitions } from "./system-memory-table-definitions.ts";

export class MemorySpaceService {
  private readonly repository: MemorySpaceRepository;
  private readonly createId: () => MemorySpaceId;
  private readonly createTableId: () => MemoryTableId;
  private readonly createFieldId: () => MemoryFieldId;
  private readonly now: () => string;

  constructor(
    repository: MemorySpaceRepository,
    createId: () => MemorySpaceId,
    createTableId: () => MemoryTableId,
    createFieldId: () => MemoryFieldId,
    now: () => string,
  ) {
    this.repository = repository;
    this.createId = createId;
    this.createTableId = createTableId;
    this.createFieldId = createFieldId;
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
    const definitions = createSystemMemoryDefinitions(
      memorySpace.id,
      this.createTableId,
      this.createFieldId,
      now,
    );
    this.repository.create(memorySpace, definitions.tables, definitions.fields);
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
