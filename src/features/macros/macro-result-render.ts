import type { MemoryMacro } from "./macro-expression.ts";
import { sanitizeMacroSyntax } from "./memory-view-render.ts";

export interface MacroRenderedResult {
  readonly text: string;
  readonly outputRows: number;
  readonly truncated: boolean;
}

const omitted = "……（已省略后续记录）";
const valueText = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** Render the selected rows without changing their order or silently cutting a JSON value. */
export function renderMacroResult(
  macro: MemoryMacro,
  result: { readonly columns: readonly string[]; readonly rows: readonly (readonly unknown[])[] },
  globalLimit: number,
): MacroRenderedResult {
  const limit = macro.output.maxChars ?? globalLimit;
  const { columns, rows } = result;
  const labelSingleColumn =
    macro.legacyRendering &&
    macro.expression.language === "query" &&
    Boolean(macro.expression.query.fields?.length);
  const displayValue = (value: unknown): string => {
    if (!macro.legacyRendering) return valueText(value);
    const text =
      typeof value === "boolean"
        ? value
          ? "是"
          : "否"
        : Array.isArray(value)
          ? value.map(valueText).join("、")
          : valueText(value);
    return text.replace(/\r?\n/g, " ");
  };
  const render = (selected: readonly (readonly unknown[])[], truncated: boolean): string => {
    if (macro.output.format === "json") {
      const objects = selected.map((row) =>
        Object.fromEntries(columns.map((column, index) => [column, row[index]])),
      );
      return sanitizeMacroSyntax(
        JSON.stringify(truncated ? { rows: objects, omitted: true } : objects, null, 2),
      );
    }
    if (!selected.length) return "";
    const cell = (value: unknown) => valueText(value).replace(/\r?\n/g, " ").replaceAll("|", "\\|");
    const text =
      macro.output.format === "markdown"
        ? [
            `| ${columns.map(cell).join(" | ")} |`,
            `| ${columns.map(() => "---").join(" | ")} |`,
            ...selected.map((row) => `| ${row.map(cell).join(" | ")} |`),
          ].join("\n")
        : selected
            .map((row) =>
              columns.length === 1 && !labelSingleColumn
                ? displayValue(row[0])
                : columns
                    .flatMap((column, index) => {
                      const value = displayValue(row[index]);
                      return value === "" ? [] : [`${column}：${value}`];
                    })
                    .join("，"),
            )
            .join("\n");
    return sanitizeMacroSyntax(truncated ? `${text}\n${omitted}` : text);
  };
  if (macro.legacyRendering && macro.output.format === "text") {
    const text = render(rows, false);
    if (text.length <= limit) return { text, outputRows: rows.length, truncated: false };
    const marker = "……（已截断）";
    if (limit < marker.length) throw new Error("宏输出预算不足以保留截断标记");
    return {
      text: `${text.slice(0, limit - marker.length)}${marker}`,
      outputRows: rows.length,
      truncated: true,
    };
  }
  const full = render(rows, false);
  if (full.length <= limit) return { text: full, outputRows: rows.length, truncated: false };
  // Serialized size is monotone in the row prefix. Include the omission metadata in the budget.
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(rows.slice(0, middle), true).length <= limit) low = middle;
    else high = middle - 1;
  }
  if (!low) throw new Error("宏输出预算不足以容纳首条结果");
  const text = render(rows.slice(0, low), true);
  if (text.length > limit) throw new Error("宏输出预算不足以容纳首条结果");
  return { text, outputRows: low, truncated: true };
}
