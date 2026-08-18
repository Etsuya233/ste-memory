/**
 * 记忆视图渲染层（ADR 0025 / ticket 02 纯函数 seam）：
 *
 * - 无投影 → 查询结果的显示文本（displayText）单行化；
 * - 有投影 → 「字段名：值」按视图字段顺序拼接（空值省略；引用字段显示为目标
 *   记录显示文本——查询结果 payload 里引用为裸 id，调用方经补充查询传入
 *   referenceLabels 解析；目标缺失显示原 id）；
 * - 输出不含分组标题（视图是单表语义）；
 * - 输出不含 {{...}}（整条 prompt 还会过一次 substituteParams，避免二次展开）；
 * - 字符上限用全局 macroLimit 兜底（视图无独立上限字段），超出尾部截断 + 标记。
 */
import type { MemoryFieldValue, MemoryRecord, MemoryRecordId } from "@ste-memory/core/memory";
import type { MemoryFieldDigest } from "@ste-memory/core/memory/agent";
import type { MemoryView } from "../settings/memory-views.ts";
import { toSingleLine, truncateWithMarker } from "./memory-context-snapshot.ts";

export interface MemoryViewRenderInput {
  readonly view: MemoryView;
  /** 视图表 digest 字段（投影字段名/类型的元数据源） */
  readonly fields: readonly MemoryFieldDigest[];
  /** 查询结果记录（payload 已按投影裁剪；引用字段值为裸记录 id） */
  readonly records: readonly MemoryRecord[];
  /** 引用解析补充查询结果：目标记录 id → 显示文本（跨表收集） */
  readonly referenceLabels: ReadonlyMap<MemoryRecordId, string>;
  /** 全局字符上限（视图无独立上限字段） */
  readonly limit: number;
}

/**
 * 渲染视图快照：每条记录一行；无投影 = 显示文本，有投影 = 「字段名：值」
 * 按视图字段顺序拼接（空值省略）。最终文本过宏语法消毒 + 尾部截断。
 */
export function renderMemoryViewSnapshot(input: MemoryViewRenderInput): string {
  const { view, fields, records, referenceLabels, limit } = input;
  const lines: string[] = [];
  if (view.projection.length === 0) {
    for (const record of records) lines.push(toSingleLine(record.displayText));
  } else {
    const fieldsByKey = new Map<string, MemoryFieldDigest>(
      fields.map((field) => [field.key, field]),
    );
    for (const record of records) {
      const parts: string[] = [];
      for (const fieldKey of view.projection) {
        const field = fieldsByKey.get(fieldKey);
        if (!field) continue;
        const rendered = renderProjectedValue(field, record.payload[field.id], referenceLabels);
        if (rendered === "") continue;
        parts.push(`${field.name}：${rendered}`);
      }
      if (parts.length > 0) lines.push(parts.join("，"));
    }
  }
  return truncateWithMarker(sanitizeMacroSyntax(lines.join("\n")), limit);
}

/** 单字段值渲染：空值省略；引用 → 目标显示文本（缺失显示原 id）；列表顿号拼接；
 * boolean 是/否；长文本单行化。 */
function renderProjectedValue(
  field: MemoryFieldDigest,
  value: MemoryFieldValue | undefined,
  referenceLabels: ReadonlyMap<MemoryRecordId, string>,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && value === "") return "";
  switch (field.type) {
    case "single_reference":
      return referenceLabels.get(value as MemoryRecordId) ?? String(value);
    case "multi_reference": {
      const ids = Array.isArray(value) ? value : [];
      return ids.map((id) => referenceLabels.get(id as MemoryRecordId) ?? String(id)).join("、");
    }
    case "short_text":
    case "long_text":
      return toSingleLine(String(value));
    case "short_text_list":
    case "multi_select":
      return Array.isArray(value) ? value.map(String).join("、") : toSingleLine(String(value));
    case "boolean":
      return value === true ? "是" : "否";
    default:
      return String(value);
  }
}

/**
 * 宏语法消毒：替换 {{ 与 }} 序列——快照文本会被整条 prompt 再过一次
 * substituteParams，残留的成对花括号可能触发二次展开（甚至自递归）；
 * 消毒后不可能再被 ST 宏引擎解析。
 */
export function sanitizeMacroSyntax(text: string): string {
  return text.replaceAll("{{", "〔{").replaceAll("}}", "}〕");
}
