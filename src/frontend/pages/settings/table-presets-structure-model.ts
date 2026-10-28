import {
  memoryFieldKey,
  memoryFieldName,
  memoryFieldValuePattern,
} from "../../../features/memory/index.ts";
import type { MemoryMacro } from "../../../features/macros/macro-expression.ts";
import type {
  ResolvedTablePreset,
  TablePresetField,
  TablePresetTable,
} from "../../../features/table-presets/preset-model.ts";
import {
  parseTablePresetExport,
  serializeTablePresetExport,
} from "../../../features/table-presets/preset-transfer.ts";
import {
  renamePresetDisplayField,
  replacePresetTable,
} from "../../../ui/settings/table-preset-editor-model.ts";
import {
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
  parseOptionsText,
  validateFieldDraft,
} from "../../../ui/memory/field-editor-model.ts";
import type { FieldEditorDraft } from "../tables/tables-workspace.ts";

/** Local drafts use the same import/instantiation validation as saved presets. No storage writes. */
export function checkedPresetDraft(preset: ResolvedTablePreset): ResolvedTablePreset {
  parseTablePresetExport(serializeTablePresetExport(preset, ""));
  return preset;
}

export function replaceDraftTable(
  preset: ResolvedTablePreset,
  index: number,
  table: TablePresetTable,
): ResolvedTablePreset {
  const oldKey = preset.tables[index]!.key;
  const macros = preset.macros?.map((macro): MemoryMacro => {
    const expression = macro.expression;
    if (expression.language === "query")
      return {
        ...macro,
        expression: {
          ...expression,
          query: {
            ...expression.query,
            table: expression.query.table === oldKey ? table.key : expression.query.table,
          },
        },
      };
    return {
      ...macro,
      expression: {
        ...expression,
        sources: expression.sources?.map((source) => ({
          ...source,
          table: source.table === oldKey ? table.key : source.table,
        })),
      },
    };
  });
  return checkedPresetDraft({
    ...preset,
    macros,
    tables: replacePresetTable(preset.tables, index, table),
  });
}

export function fieldFromDraft(
  draft: FieldEditorDraft,
  existing: readonly TablePresetField[],
): TablePresetField {
  const errors = Object.values(
    validateFieldDraft(
      draft,
      existing.map((field) => field.key),
    ),
  );
  if (errors.length) throw new Error(errors.join("；"));
  return {
    key: memoryFieldKey(draft.key),
    name: memoryFieldName(draft.name),
    type: draft.type,
    required: draft.required,
    enabled: draft.enabled,
    prompt: draft.prompt,
    options: fieldTypeNeedsOptions(draft.type) ? parseOptionsText(draft.optionsText) : [],
    referenceTableKey: fieldTypeNeedsReference(draft.type) ? draft.referenceTableId : null,
    maxChars:
      ["short_text", "long_text", "short_text_list"].includes(draft.type) && draft.maxChars !== ""
        ? Number(draft.maxChars)
        : null,
    valuePattern: memoryFieldValuePattern(draft.valuePattern),
    valuePatternMessage: draft.valuePatternMessage.trim() || null,
  };
}

export function replaceDraftField(
  preset: ResolvedTablePreset,
  tableIndex: number,
  fieldIndex: number | null,
  field: TablePresetField,
): ResolvedTablePreset {
  const table = preset.tables[tableIndex]!;
  const previous = fieldIndex === null ? null : table.fields[fieldIndex]!;
  const rename = (key: string) => (key === previous?.key ? field.key : key);
  const next = {
    ...table,
    fields:
      fieldIndex === null
        ? [...table.fields, field]
        : table.fields.map((item, index) => (index === fieldIndex ? field : item)),
    displayStrategy: previous
      ? renamePresetDisplayField(table, previous.key, field.key)
      : table.displayStrategy,
    vectorIndex: table.vectorIndex
      ? {
          ...table.vectorIndex,
          groups: table.vectorIndex.groups.map((group) => ({
            ...group,
            fieldKeys: group.fieldKeys.map(rename),
          })),
        }
      : undefined,
  };
  const macros = preset.macros?.map((macro): MemoryMacro => {
    const expression = macro.expression;
    if (expression.language !== "query" || expression.query.table !== table.key || !previous)
      return macro;
    const query = expression.query;
    return {
      ...macro,
      expression: {
        ...expression,
        query: {
          ...query,
          fields: query.fields?.map(rename),
          conditions: query.conditions?.map((condition) => ({
            ...condition,
            field: rename(condition.field),
          })),
          orderBy: query.orderBy
            ? { ...query.orderBy, field: rename(query.orderBy.field) }
            : undefined,
          semantic: query.semantic
            ? {
                ...query.semantic,
                options: query.semantic.options
                  ? {
                      ...query.semantic.options,
                      textFields: query.semantic.options.textFields?.map(rename),
                    }
                  : undefined,
              }
            : undefined,
        },
      },
    };
  });
  return checkedPresetDraft({
    ...preset,
    macros,
    tables: preset.tables.map((item, index) => (index === tableIndex ? next : item)),
  });
}

export function removeDraftTable(
  preset: ResolvedTablePreset,
  tableIndex: number,
): ResolvedTablePreset {
  const table = preset.tables[tableIndex]!;
  const references = preset.tables.flatMap((other, index) =>
    index === tableIndex
      ? []
      : other.fields
          .filter((field) => field.referenceTableKey === table.key)
          .map((field) => `${other.name}.${field.name}`),
  );
  if (references.length) throw new Error(`请先调整引用字段：${references.join("、")}`);
  return checkedPresetDraft({
    ...preset,
    tables: preset.tables.filter((_, index) => index !== tableIndex),
  });
}

export function removeDraftField(
  preset: ResolvedTablePreset,
  tableIndex: number,
  fieldIndex: number,
): ResolvedTablePreset {
  const table = preset.tables[tableIndex]!;
  return checkedPresetDraft({
    ...preset,
    tables: preset.tables.map((item, index) =>
      index === tableIndex
        ? { ...table, fields: table.fields.filter((_, index) => index !== fieldIndex) }
        : item,
    ),
  });
}
