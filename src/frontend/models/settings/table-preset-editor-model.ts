import type { TablePresetTable } from "../../../features/table-presets/preset-model.ts";

export function replacePresetTable(
  tables: readonly TablePresetTable[],
  index: number,
  replacement: TablePresetTable,
): readonly TablePresetTable[] {
  const previous = tables[index]!;
  if (tables.some((table, i) => i !== index && table.key === replacement.key)) {
    throw new Error(`表格 Key 已存在：${replacement.key}`);
  }
  return tables.map((table, i) => {
    const next = i === index ? replacement : table;
    return previous.key === replacement.key
      ? next
      : {
          ...next,
          fields: next.fields.map((field) =>
            field.referenceTableKey === previous.key
              ? { ...field, referenceTableKey: replacement.key }
              : field,
          ),
        };
  });
}

export function renamePresetDisplayField(
  table: TablePresetTable,
  oldKey: string,
  newKey: string,
): TablePresetTable["displayStrategy"] {
  const strategy = table.displayStrategy;
  if (!strategy) return null;
  if (strategy.type === "field")
    return { ...strategy, fieldKey: strategy.fieldKey === oldKey ? newKey : strategy.fieldKey };
  return {
    ...strategy,
    template: strategy.template.replace(/\{([^{}]+)\}/g, (match, key: string) =>
      key === oldKey ? `{${newKey}}` : match,
    ),
  };
}

/** 显示策略摘要：与真实表格详情使用同一行文案口径。 */
export function presetDisplayStrategySummary(table: TablePresetTable): string {
  const strategy = table.displayStrategy;
  if (!strategy) return "默认";
  if (strategy.type === "field") {
    const field = table.fields.find((candidate) => candidate.key === strategy.fieldKey);
    return `显示字段：${field?.name ?? "未知字段"}`;
  }
  return `显示模板：${strategy.template}`;
}

export function presetFieldUsedForDisplay(table: TablePresetTable, key: string): boolean {
  const strategy = table.displayStrategy;
  return strategy?.type === "field"
    ? strategy.fieldKey === key
    : strategy?.type === "template" &&
        [...strategy.template.matchAll(/\{([^{}]+)\}/g)].some((match) => match[1] === key);
}
