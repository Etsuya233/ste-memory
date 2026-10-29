import { hasSemanticSource, type MemoryMacro } from "../../../features/macros/macro-expression.ts";
import type { ExpressionMacroDraft } from "../../models/settings/expression-macro-editor-model.ts";

export function macroEditorDraft(macro: MemoryMacro, tableKey: string): ExpressionMacroDraft {
  return {
    name: macro.name,
    enabled: macro.enabled,
    language: macro.expression.language,
    query: JSON.stringify(
      macro.expression.language === "query"
        ? macro.expression.query
        : { table: tableKey, limit: 10 },
      null,
      2,
    ),
    sql: macro.expression.language === "sql" ? macro.expression.sql : "",
    convertedLegacy: false,
    format: macro.output.format,
    maxChars: macro.output.maxChars?.toString() ?? "",
  };
}

/** Classification adds SQL metadata and disables newly created semantic macros. */
export function macroWasSaved(
  actual: MemoryMacro | undefined,
  desired: MemoryMacro,
  isNew: boolean,
): boolean {
  if (!actual) return false;
  const expression = (macro: MemoryMacro) => {
    if (macro.expression.language === "query") return macro.expression;
    return {
      language: macro.expression.language,
      sql: macro.expression.sql,
      ...(macro.expression.sources ? { sources: macro.expression.sources } : {}),
    };
  };
  return (
    actual.id === desired.id &&
    actual.name === desired.name &&
    JSON.stringify(actual.output) === JSON.stringify(desired.output) &&
    JSON.stringify(expression(actual)) === JSON.stringify(expression(desired)) &&
    (actual.enabled === desired.enabled || (isNew && hasSemanticSource(actual) && !actual.enabled))
  );
}

/** Merge against the latest collection without overwriting another editor's changes. */
export function mergeEditedMacro(
  current: readonly MemoryMacro[],
  original: MemoryMacro | null,
  desired: MemoryMacro,
): readonly MemoryMacro[] {
  const previous = current.find((macro) => macro.id === desired.id);
  if (previous && macroWasSaved(previous, desired, !original)) return current;
  if (original ? JSON.stringify(previous) !== JSON.stringify(original) : previous !== undefined)
    throw new Error("宏定义已变化，请保留草稿并重新打开编辑器。");
  if (current.some((macro) => macro.id !== desired.id && macro.name === desired.name))
    throw new Error("宏名已存在");
  return original
    ? current.map((macro) => (macro.id === desired.id ? desired : macro))
    : [...current, desired];
}
