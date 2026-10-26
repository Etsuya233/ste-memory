import {
  validateMemoryMacro,
  type MacroExpression,
  type MemoryMacro,
} from "../../features/macros/macro-expression.ts";

export interface ExpressionMacroDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly language: "query" | "sql";
  readonly query: string;
  readonly sql: string;
  readonly convertedLegacy: boolean;
  readonly format: MemoryMacro["output"]["format"];
  readonly maxChars: string;
}

/** 旧评分源只有显式转换后才退出原表达式；新 SQL 不再生成 sources 属性。 */
export function macroFromEditorDraft(
  initial: MemoryMacro,
  draft: ExpressionMacroDraft,
  names: readonly string[],
): MemoryMacro {
  const legacySql =
    initial.expression.language === "sql" && (initial.expression.sources?.length ?? 0) > 0;
  const expression: MacroExpression =
    legacySql && !draft.convertedLegacy
      ? initial.expression
      : draft.language === "query"
        ? { language: "query", query: JSON.parse(draft.query) }
        : { language: "sql", sql: draft.sql };
  const macro: MemoryMacro = {
    ...initial,
    name: draft.name.trim(),
    enabled: draft.enabled,
    expression,
    output: {
      format: draft.format,
      maxChars: draft.maxChars === "" ? null : Number(draft.maxChars),
    },
  };
  validateMemoryMacro(macro);
  if (names.includes(macro.name) && macro.name !== initial.name) throw new Error("宏名已存在");
  return macro;
}
