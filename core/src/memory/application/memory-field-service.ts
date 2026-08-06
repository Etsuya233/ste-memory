import {
  DomainError,
  derivedDisplayTemplate,
  memoryFieldConfiguration,
  memoryFieldKey,
  memoryFieldName,
  memoryFieldPosition,
  memoryFieldValuePattern,
  memoryTableDisplayFieldIds,
  type MemoryField,
  type MemoryFieldConfiguration,
  type MemoryFieldId,
  type MemoryFieldType,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableDisplayStrategy,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";

export interface CreateMemoryFieldInput {
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly options?: readonly string[];
  readonly referenceTableId?: MemoryTableId | null;
  /** 文本类字段值长度上限（字符数）；缺省 null 表示不限。 */
  readonly maxChars?: number | null;
  /** 文本类字段非空值的格式校验正则；缺省 null 表示不校验。 */
  readonly valuePattern?: string | null;
  /** 格式校验失败时回喂 Agent 的错误说明（人类可读，含示例）。 */
  readonly valuePatternMessage?: string | null;
}

export interface UpdateMemoryFieldInput {
  readonly key?: string;
  readonly type?: MemoryFieldType;
  readonly name?: string;
  readonly required?: boolean;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly position?: number;
  readonly options?: readonly string[];
  readonly referenceTableId?: MemoryTableId | null;
  readonly maxChars?: number | null;
  readonly valuePattern?: string | null;
  readonly valuePatternMessage?: string | null;
}

export interface MemoryFieldUpdateResult {
  readonly field: MemoryField;
  readonly warnings: readonly string[];
}

export class MemoryFieldService {
  private readonly tables: MemoryTableRepository;
  private readonly fields: MemoryFieldRepository;
  private readonly createId: () => MemoryFieldId;
  private readonly now: () => string;

  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    createId: () => MemoryFieldId,
    now: () => string,
  ) {
    this.tables = tables;
    this.fields = fields;
    this.createId = createId;
    this.now = now;
  }

  async create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryFieldInput,
  ): Promise<MemoryField | undefined> {
    if (!(await this.tables.find(memorySpaceId, tableId))) return undefined;
    const key = memoryFieldKey(input.key);
    if (await this.fields.findByKey(memorySpaceId, tableId, key)) {
      throw new DomainError({
        type: "memory_field_key_conflict",
        humanMsg: "同一表格内的字段 Key 不能重复",
      });
    }
    const configuration = await this.validatedConfiguration(
      memorySpaceId,
      input.type,
      input.options ?? [],
      input.referenceTableId ?? null,
      input.maxChars ?? null,
    );
    const now = this.now();
    const field: MemoryField = {
      id: this.createId(),
      memorySpaceId,
      tableId,
      key,
      name: memoryFieldName(input.name),
      type: input.type,
      required: input.required,
      prompt: input.prompt,
      enabled: input.enabled,
      position: memoryFieldPosition(input.position),
      options: configuration.options,
      referenceTableId: configuration.referenceTableId,
      maxChars: configuration.maxChars,
      valuePattern: memoryFieldValuePattern(input.valuePattern),
      valuePatternMessage: input.valuePatternMessage?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    await this.fields.create(field);
    return field;
  }

  async delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<boolean> {
    const table = await this.tables.find(memorySpaceId, tableId);
    if (table?.displayStrategy && memoryTableDisplayFieldIds(table.displayStrategy).includes(id)) {
      throw new DomainError({
        type: "memory_field_used_by_display_strategy",
        humanMsg: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
      });
    }
    return this.fields.delete(memorySpaceId, tableId, id);
  }

  async find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined> {
    return this.fields.find(memorySpaceId, tableId, id);
  }

  async list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]> {
    return (await this.fields.list(memorySpaceId, tableId)).sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  async setDisplayStrategy(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ): Promise<MemoryTable | undefined> {
    const table = await this.tables.find(memorySpaceId, tableId);
    if (!table) return undefined;
    if (strategy.type === "field") {
      const field = await this.fields.find(memorySpaceId, tableId, strategy.fieldId);
      if (!field || field.type !== "short_text" || !field.enabled) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示字段必须是当前表中的短文本字段",
        });
      }
    } else {
      const template = derivedDisplayTemplate(strategy.template);
      const referencedFields = await Promise.all(
        template.fieldIds.map((fieldId) => this.fields.find(memorySpaceId, tableId, fieldId)),
      );
      if (referencedFields.some((field) => !field?.enabled)) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示模板只能引用当前表中的字段",
        });
      }
    }
    const updated = { ...table, displayStrategy: strategy, updatedAt: this.now() };
    await this.tables.update(updated);
    return updated;
  }

  async update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
    input: UpdateMemoryFieldInput,
  ): Promise<MemoryFieldUpdateResult | undefined> {
    const field = await this.fields.find(memorySpaceId, tableId, id);
    if (!field) return undefined;
    const key = input.key === undefined ? field.key : memoryFieldKey(input.key);
    const conflict = await this.fields.findByKey(memorySpaceId, tableId, key);
    if (conflict && conflict.id !== id) {
      throw new DomainError({
        type: "memory_field_key_conflict",
        humanMsg: "同一表格内的字段 Key 不能重复",
      });
    }
    if (input.type !== undefined && input.type !== field.type) {
      throw new DomainError({
        type: "memory_field_type_immutable",
        humanMsg: "字段创建后不能修改类型",
      });
    }
    const configuration = await this.validatedConfiguration(
      memorySpaceId,
      field.type,
      input.options ?? field.options,
      input.referenceTableId ?? field.referenceTableId,
      input.maxChars ?? field.maxChars,
    );
    const table = await this.tables.find(memorySpaceId, tableId);
    if (
      input.enabled === false &&
      table?.displayStrategy &&
      memoryTableDisplayFieldIds(table.displayStrategy).includes(id)
    ) {
      throw new DomainError({
        type: "memory_field_used_by_display_strategy",
        humanMsg: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
      });
    }
    const updated: MemoryField = {
      ...field,
      key,
      name: input.name === undefined ? field.name : memoryFieldName(input.name),
      required: input.required ?? field.required,
      prompt: input.prompt ?? field.prompt,
      enabled: input.enabled ?? field.enabled,
      position: input.position === undefined ? field.position : memoryFieldPosition(input.position),
      options: configuration.options,
      referenceTableId: configuration.referenceTableId,
      maxChars: configuration.maxChars,
      valuePattern:
        input.valuePattern === undefined
          ? field.valuePattern
          : memoryFieldValuePattern(input.valuePattern),
      valuePatternMessage:
        input.valuePatternMessage === undefined
          ? field.valuePatternMessage
          : (input.valuePatternMessage?.trim() || null),
      updatedAt: this.now(),
    };
    await this.fields.update(updated);
    return {
      field: updated,
      warnings:
        updated.required && !updated.enabled ? ["停用必填字段后，Agent 可能无法创建合法记录"] : [],
    };
  }

  private async validatedConfiguration(
    memorySpaceId: MemorySpaceId,
    type: MemoryFieldType,
    options: readonly string[],
    referenceTableId: MemoryTableId | null,
    maxChars: number | null,
  ): Promise<MemoryFieldConfiguration> {
    const configuration = memoryFieldConfiguration(type, options, referenceTableId, maxChars);
    if (
      configuration.referenceTableId &&
      !(await this.tables.find(memorySpaceId, configuration.referenceTableId))
    ) {
      throw new DomainError({
        type: "memory_field_reference_table_invalid",
        humanMsg: "引用字段的目标表必须属于当前记忆空间",
      });
    }
    return configuration;
  }
}
