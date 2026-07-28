import {
  DomainError,
  memoryTableKey,
  memoryTableName,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKind,
} from "../domain/index.ts";
import type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";

export interface CreateMemoryTableInput {
  readonly key: string;
  readonly kind: MemoryTableKind;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export interface UpdateMemoryTableInput {
  readonly key?: string;
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

  create(memorySpaceId: MemorySpaceId, input: CreateMemoryTableInput): MemoryTable | undefined {
    if (!this.spaces.find(memorySpaceId)) return undefined;
    const key = memoryTableKey(input.key);
    if (this.tables.findByKey(memorySpaceId, key)) {
      throw new DomainError({
        type: "memory_table_key_conflict",
        humanMsg: "同一记忆空间内的表格 Key 不能重复",
      });
    }
    const now = this.now();
    const memoryTable: MemoryTable = {
      id: this.createId(),
      memorySpaceId,
      key,
      kind: input.kind,
      name: memoryTableName(input.name),
      description: input.description,
      prompt: input.prompt,
      enabled: true,
      displayStrategy: null,
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
    const key = input.key === undefined ? current.key : memoryTableKey(input.key);
    const conflict = this.tables.findByKey(memorySpaceId, key);
    if (conflict && conflict.id !== id) {
      throw new DomainError({
        type: "memory_table_key_conflict",
        humanMsg: "同一记忆空间内的表格 Key 不能重复",
      });
    }
    const updated: MemoryTable = {
      ...current,
      key,
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
