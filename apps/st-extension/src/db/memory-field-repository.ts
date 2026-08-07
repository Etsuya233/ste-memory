import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldKey,
  MemorySpaceId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { MemoryFieldRepository } from "@ste-memory/core/memory/adapter";
import type { SteMemoryDatabase } from "./database.ts";

/**
 * core MemoryFieldRepository 端口的 Dexie（IndexedDB）实现（ADR 0002）。
 *
 * 作用域规则：find/delete/update 都以「id 命中 + 空间/表格匹配」为准，
 * 跨空间或跨表格操作一律视为未命中（与 SQLite 参照实现同语义）。
 */
export class DexieMemoryFieldRepository implements MemoryFieldRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async create(field: MemoryField): Promise<void> {
    await this.#db.memoryFields.add(field);
  }

  async delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<boolean> {
    const field = await this.find(memorySpaceId, tableId, id);
    if (!field) return false;
    await this.#db.memoryFields.delete(id);
    return true;
  }

  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined> {
    const field = await this.#db.memoryFields.get(id);
    return field?.memorySpaceId === memorySpaceId && field.tableId === tableId
      ? field
      : undefined;
  }

  async findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): Promise<MemoryField | undefined> {
    return this.#db.memoryFields
      .where("[memorySpaceId+tableId+key]")
      .equals([memorySpaceId, tableId, key])
      .first();
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]> {
    const fields = await this.#db.memoryFields
      .where("[memorySpaceId+tableId]")
      .equals([memorySpaceId, tableId])
      .toArray();
    // 与 SQLite 参照实现同语义：position 升序（id 兜底，保证确定性）
    return fields.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async update(field: MemoryField): Promise<boolean> {
    const current = await this.find(field.memorySpaceId, field.tableId, field.id);
    if (!current) return false;
    // 与 SQLite 参照实现的 .set() 同语义：只写可变字段，createdAt 是创建事实不覆盖
    const count = await this.#db.memoryFields.update(field.id, {
      key: field.key,
      name: field.name,
      required: field.required,
      prompt: field.prompt,
      enabled: field.enabled,
      position: field.position,
      options: field.options,
      referenceTableId: field.referenceTableId,
      maxChars: field.maxChars,
      valuePattern: field.valuePattern,
      valuePatternMessage: field.valuePatternMessage,
      updatedAt: field.updatedAt,
    });
    return count > 0;
  }
}
