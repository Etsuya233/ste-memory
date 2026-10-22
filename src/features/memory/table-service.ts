import {
  DomainError,
  memoryTableKey,
  memoryTableName,
  memoryTablePosition,
  type MemoryField,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type VectorIndexConfiguration,
  validateVectorIndexConfiguration,
} from "./domain/index.ts";
import type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";

export interface CreateMemoryTableInput {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  /** 空间内显式顺序（调用方给出：新建取当前最大值 + 1） */
  readonly position: number;
}

export interface UpdateMemoryTableInput {
  readonly vectorIndex?: VectorIndexConfiguration;
  readonly key?: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly position?: number;
}

export class MemoryTableService {
  private readonly spaces: MemorySpaceRepository;
  private readonly tables: MemoryTableRepository;
  private readonly fields?: {
    list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<readonly MemoryField[]>;
  };
  private readonly createId: () => MemoryTableId;
  private readonly now: () => string;

  constructor(
    spaces: MemorySpaceRepository,
    tables: MemoryTableRepository,
    createId: () => MemoryTableId,
    now: () => string,
    fields?: {
      list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<readonly MemoryField[]>;
    },
  ) {
    this.spaces = spaces;
    this.tables = tables;
    this.createId = createId;
    this.now = now;
    this.fields = fields;
  }

  async create(
    memorySpaceId: MemorySpaceId,
    input: CreateMemoryTableInput,
  ): Promise<MemoryTable | undefined> {
    if (!(await this.spaces.find(memorySpaceId))) return undefined;
    const key = memoryTableKey(input.key);
    if (await this.tables.findByKey(memorySpaceId, key)) {
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
      name: memoryTableName(input.name),
      description: input.description,
      prompt: input.prompt,
      enabled: true,
      position: memoryTablePosition(input.position),
      displayStrategy: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.tables.create(memoryTable);
    return memoryTable;
  }

  async delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean> {
    return this.tables.delete(memorySpaceId, id);
  }

  async find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined> {
    return this.tables.find(memorySpaceId, id);
  }

  async list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]> {
    return this.tables.list(memorySpaceId);
  }

  async update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): Promise<MemoryTable | undefined> {
    const current = await this.tables.find(memorySpaceId, id);
    if (!current) return undefined;
    const key = input.key === undefined ? current.key : memoryTableKey(input.key);
    const conflict = await this.tables.findByKey(memorySpaceId, key);
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
      position:
        input.position === undefined ? current.position : memoryTablePosition(input.position),
      updatedAt: this.now(),
      vectorIndex: input.vectorIndex ?? current.vectorIndex,
    };
    if (input.vectorIndex !== undefined) {
      if (!this.fields) throw new Error("保存向量索引配置需要字段仓库");
      validateVectorIndexConfiguration(
        input.vectorIndex,
        await this.fields.list(memorySpaceId, id),
      );
    }
    await this.tables.update(updated);
    return updated;
  }
}
