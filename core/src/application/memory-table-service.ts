import {
  memoryTableName,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";

export interface CreateCustomMemoryTableInput {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export interface UpdateMemoryTableInput {
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
}

export class MemoryTableService {
  private readonly spaces: MemorySpaceRepository;
  private readonly tables: MemoryTableRepository;
  private readonly createId: () => MemoryTableId;
  private readonly now: () => string;

  constructor(
    spaces: MemorySpaceRepository,
    tables: MemoryTableRepository,
    createId: () => MemoryTableId,
    now: () => string,
  ) {
    this.spaces = spaces;
    this.tables = tables;
    this.createId = createId;
    this.now = now;
  }

  createCustom(
    memorySpaceId: MemorySpaceId,
    input: CreateCustomMemoryTableInput,
  ): MemoryTable | undefined {
    if (!this.spaces.find(memorySpaceId)) return undefined;
    const now = this.now();
    const memoryTable: MemoryTable = {
      id: this.createId(),
      memorySpaceId,
      kind: "custom",
      name: memoryTableName(input.name),
      description: input.description,
      prompt: input.prompt,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.tables.create(memoryTable);
    return memoryTable;
  }

  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): boolean {
    return this.tables.delete(memorySpaceId, id);
  }

  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): MemoryTable | undefined {
    return this.tables.find(memorySpaceId, id);
  }

  list(memorySpaceId: MemorySpaceId): MemoryTable[] {
    return this.tables.list(memorySpaceId);
  }

  update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): MemoryTable | undefined {
    const current = this.tables.find(memorySpaceId, id);
    if (!current) return undefined;
    const updated: MemoryTable = {
      ...current,
      name: input.name === undefined ? current.name : memoryTableName(input.name),
      description: input.description ?? current.description,
      prompt: input.prompt ?? current.prompt,
      enabled: input.enabled ?? current.enabled,
      updatedAt: this.now(),
    };
    this.tables.update(updated);
    return updated;
  }
}
