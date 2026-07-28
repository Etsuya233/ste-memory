import {
  DomainError,
  derivedDisplayTemplate,
  memoryFieldConfiguration,
  memoryFieldKey,
  memoryFieldName,
  memoryFieldPosition,
  memoryTableDisplayFieldIds,
  type MemoryField,
  type MemoryFieldConfiguration,
  type MemoryFieldId,
  type MemoryFieldType,
  type MemorySpaceId,
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

  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryFieldInput,
  ): MemoryField | undefined {
    if (!this.tables.find(memorySpaceId, tableId)) return undefined;
    const key = memoryFieldKey(input.key);
    if (this.fields.findByKey(memorySpaceId, tableId, key)) {
      throw new DomainError({
        type: "memory_field_key_conflict",
        humanMsg: "同一表格内的字段 Key 不能重复",
      });
    }
    const configuration = this.validatedConfiguration(
      memorySpaceId,
      input.type,
      input.options ?? [],
      input.referenceTableId ?? null,
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
      createdAt: now,
      updatedAt: now,
    };
    this.fields.create(field);
    return field;
  }

  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): boolean {
    const table = this.tables.find(memorySpaceId, tableId);
    if (table?.displayStrategy && memoryTableDisplayFieldIds(table.displayStrategy).includes(id)) {
      throw new DomainError({
        type: "memory_field_used_by_display_strategy",
        humanMsg: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
      });
    }
    return this.fields.delete(memorySpaceId, tableId, id);
  }

  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): MemoryField | undefined {
    return this.fields.find(memorySpaceId, tableId, id);
  }

  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): MemoryField[] {
    return this.fields
      .list(memorySpaceId, tableId)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  }

  setDisplayStrategy(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ) {
    const table = this.tables.find(memorySpaceId, tableId);
    if (!table) return undefined;
    if (strategy.type === "field") {
      const field = this.fields.find(memorySpaceId, tableId, strategy.fieldId);
      if (!field || field.type !== "short_text" || !field.enabled) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示字段必须是当前表中的短文本字段",
        });
      }
    } else {
      const template = derivedDisplayTemplate(strategy.template);
      if (
        template.fieldIds.some(
          (fieldId) => !this.fields.find(memorySpaceId, tableId, fieldId)?.enabled,
        )
      ) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示模板只能引用当前表中的字段",
        });
      }
    }
    const updated = { ...table, displayStrategy: strategy, updatedAt: this.now() };
    this.tables.update(updated);
    return updated;
  }

  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
    input: UpdateMemoryFieldInput,
  ): MemoryFieldUpdateResult | undefined {
    const field = this.fields.find(memorySpaceId, tableId, id);
    if (!field) return undefined;
    const key = input.key === undefined ? field.key : memoryFieldKey(input.key);
    const conflict = this.fields.findByKey(memorySpaceId, tableId, key);
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
    const configuration = this.validatedConfiguration(
      memorySpaceId,
      field.type,
      input.options ?? field.options,
      input.referenceTableId ?? field.referenceTableId,
    );
    const table = this.tables.find(memorySpaceId, tableId);
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
      updatedAt: this.now(),
    };
    this.fields.update(updated);
    return {
      field: updated,
      warnings:
        updated.required && !updated.enabled ? ["停用必填字段后，Agent 可能无法创建合法记录"] : [],
    };
  }

  private validatedConfiguration(
    memorySpaceId: MemorySpaceId,
    type: MemoryFieldType,
    options: readonly string[],
    referenceTableId: MemoryTableId | null,
  ): MemoryFieldConfiguration {
    const configuration = memoryFieldConfiguration(type, options, referenceTableId);
    if (
      configuration.referenceTableId &&
      !this.tables.find(memorySpaceId, configuration.referenceTableId)
    ) {
      throw new DomainError({
        type: "memory_field_reference_table_invalid",
        humanMsg: "引用字段的目标表必须属于当前记忆空间",
      });
    }
    return configuration;
  }
}
