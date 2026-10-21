import {
  DomainError,
  memoryFieldConfiguration,
  memoryFieldKey,
  memoryFieldName,
  memoryFieldValuePattern,
  memoryTableKey,
  memoryTableName,
  memorySummaryRules,
  type MemoryField,
  type MemoryFieldId,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableDisplayStrategy,
  type MemoryTableId,
} from "../memory/index.ts";
import type { TablePresetDisplayStrategy, TablePresetStructure } from "./preset-model.ts";

/**
 * 预设实例化（spec 4.2 / 10.2）：把预设结构复制成具体记忆空间的表/字段行。
 *
 * - 引用目标按预设内表 Key 解析、显示策略占位符按字段 Key 解析，一律生成全新
 *   实体 ID——预设不保存来源空间的实体 ID，实例化后引用局限在新空间内；
 * - 首次创建与应用预设（含按同一预设重新初始化）共用本函数；
 * - 预设内容自相矛盾（引用/显示策略指向预设内不存在的表或字段、显示策略引用
 *   停用或非短文本字段）时抛错：应用预设是重建操作，宁可失败也不落一个后续
 *   无法写入的空间结构。
 */

export interface PresetInstantiationIds {
  readonly table: () => MemoryTableId;
  readonly field: () => MemoryFieldId;
}

export interface InstantiatedSpaceStructure {
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
}

export function instantiateTablePreset(
  preset: TablePresetStructure,
  memorySpaceId: MemorySpaceId,
  ids: PresetInstantiationIds,
  now: string,
): InstantiatedSpaceStructure {
  const tableIdByKey = new Map<string, MemoryTableId>();
  for (const table of preset.tables) {
    tableIdByKey.set(table.key, ids.table());
  }
  const fieldIdByKeyByTable = new Map<string, Map<string, MemoryFieldId>>();
  for (const table of preset.tables) {
    const fieldIdByKey = new Map<string, MemoryFieldId>();
    for (const field of table.fields) {
      fieldIdByKey.set(field.key, ids.field());
    }
    fieldIdByKeyByTable.set(table.key, fieldIdByKey);
  }

  const tables: MemoryTable[] = [];
  const fields: MemoryField[] = [];
  for (const [position, table] of preset.tables.entries()) {
    const tableId = tableIdByKey.get(table.key)!;
    const fieldIdByKey = fieldIdByKeyByTable.get(table.key)!;
    tables.push({
      id: tableId,
      memorySpaceId,
      key: memoryTableKey(table.key),
      name: memoryTableName(table.name),
      description: table.description,
      prompt: table.prompt,
      enabled: table.enabled,
      position,
      displayStrategy: instantiatedDisplayStrategy(
        table.key,
        table.displayStrategy,
        table.fields,
        fieldIdByKey,
      ),
      createdAt: now,
      updatedAt: now,
    });
    for (const [fieldPosition, field] of table.fields.entries()) {
      const referenceTableId = instantiatedReference(field.referenceTableKey, tableIdByKey);
      const configuration = memoryFieldConfiguration(
        field.type,
        field.options,
        referenceTableId,
        field.maxChars,
      );
      fields.push({
        id: fieldIdByKey.get(field.key)!,
        memorySpaceId,
        tableId,
        key: memoryFieldKey(field.key),
        name: memoryFieldName(field.name),
        type: field.type,
        required: field.required,
        prompt: field.prompt,
        enabled: field.enabled,
        position: fieldPosition,
        options: configuration.options,
        referenceTableId: configuration.referenceTableId,
        maxChars: configuration.maxChars,
        valuePattern: memoryFieldValuePattern(field.valuePattern),
        valuePatternMessage: field.valuePatternMessage?.trim() || null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  for (const rule of memorySummaryRules(preset.summaryRules)) {
    const source = tables.find((table) => table.key === rule.sourceTableKey);
    const target = tables.find((table) => table.key === rule.targetTableKey);
    const field = fields.find(
      (field) => field.tableId === source?.id && field.key === rule.referenceFieldKey,
    );
    if (
      !source?.enabled ||
      !target?.enabled ||
      !field?.enabled ||
      field.type !== "single_reference" ||
      field.referenceTableId !== target.id
    ) {
      throw new Error(
        `总结规则引用无效：${rule.sourceTableKey}.${rule.referenceFieldKey} → ${rule.targetTableKey}`,
      );
    }
  }
  return { tables, fields };
}

/** 引用目标表 Key → 新表 ID；预设内没有该表 = 预设内容损坏（不静默降级）。 */
function instantiatedReference(
  referenceTableKey: string | null,
  tableIdByKey: ReadonlyMap<string, MemoryTableId>,
): MemoryTableId | null {
  if (referenceTableKey === null) return null;
  const tableId = tableIdByKey.get(referenceTableKey);
  if (!tableId) {
    throw new DomainError({
      type: "table_preset_reference_target_missing",
      param: { tableKey: referenceTableKey },
      humanMsg: `预设中的引用目标表「${referenceTableKey}」不存在，无法创建空间结构`,
    });
  }
  return tableId;
}

/**
 * 显示策略实例化：字段策略换成新字段 ID（必须是表内启用的短文本字段，与
 * MemoryFieldService.setDisplayStrategy 同规则）；模板策略的每个占位符按字段
 * Key 换成新字段 ID（引用字段须启用）。
 */
function instantiatedDisplayStrategy(
  tableKey: string,
  strategy: TablePresetDisplayStrategy | null,
  fields: TablePresetStructure["tables"][number]["fields"],
  fieldIdByKey: ReadonlyMap<string, MemoryFieldId>,
): MemoryTableDisplayStrategy | null {
  if (!strategy) return null;
  if (strategy.type === "field") {
    const field = fields.find((candidate) => candidate.key === strategy.fieldKey);
    if (!field || field.type !== "short_text" || !field.enabled) {
      throw new DomainError({
        type: "table_preset_display_strategy_invalid",
        param: { tableKey, fieldKey: strategy.fieldKey },
        humanMsg: `预设表「${tableKey}」的显示字段必须是表内启用的短文本字段`,
      });
    }
    return { type: "field", fieldId: fieldIdByKey.get(strategy.fieldKey)! };
  }
  const template = strategy.template.replace(/\{([^{}]+)\}/g, (placeholder, fieldKey: string) => {
    const fieldId = fieldIdByKey.get(fieldKey);
    if (!fieldId) {
      throw new DomainError({
        type: "table_preset_display_strategy_invalid",
        param: { tableKey, fieldKey },
        humanMsg: `预设表「${tableKey}」的显示模板引用了不存在的字段「${fieldKey}」`,
      });
    }
    const field = fields.find((candidate) => candidate.key === fieldKey)!;
    if (!field.enabled) {
      throw new DomainError({
        type: "table_preset_display_strategy_invalid",
        param: { tableKey, fieldKey },
        humanMsg: `预设表「${tableKey}」的显示模板引用了停用字段「${fieldKey}」`,
      });
    }
    return `{${fieldId}}`;
  });
  return { type: "template", template };
}
