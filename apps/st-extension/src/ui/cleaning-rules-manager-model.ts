/**
 * 清洗规则设置区块（ticket 22 / ADR 0011）的纯逻辑 seam：导入目标解析、
 * 导入应用（永远追加）、导入报告、规则行编辑草稿。
 * 组件只做「模型 → DOM」投影与事件接线（同 task-panel-model 惯例）。
 */
import type { CleaningRule, CleaningRuleList } from "../settings/cleaning-rule-lists.ts";
import { validateCleaningRule } from "../settings/cleaning-rule-lists.ts";
import type { StRegexImportItem } from "../settings/st-regex-import.ts";

// ---- 导入目标 ----

export type ImportTarget =
  | { readonly kind: "existing"; readonly listId: string }
  | { readonly kind: "new"; readonly name: string };

/** 新建列表的默认名（空名/全空白回退）。 */
export const DEFAULT_IMPORT_LIST_NAME = "从 ST 导入";

export function resolveImportTarget(target: ImportTarget): ImportTarget {
  if (target.kind === "existing") return target;
  const name = target.name.trim();
  return { kind: "new", name: name === "" ? DEFAULT_IMPORT_LIST_NAME : name };
}

// ---- 导入应用（永远追加，Q6）----

/**
 * 把导入条目中的规则追加到目标列表末尾（跳过条目忽略）。
 * 新建目标：无规则可导入时不创建空列表。
 */
export function applyImportedRules(
  lists: readonly CleaningRuleList[],
  target: ImportTarget,
  items: readonly StRegexImportItem[],
  createId: () => string,
): readonly CleaningRuleList[] {
  const rules = items
    .filter((item): item is Extract<StRegexImportItem, { kind: "rule" }> => item.kind === "rule")
    .map((item) => item.rule);
  if (rules.length === 0) return lists;
  if (target.kind === "existing") {
    return lists.map((list) =>
      list.id === target.listId ? { ...list, rules: [...list.rules, ...rules] } : list,
    );
  }
  return [...lists, { id: createId(), name: target.name, rules }];
}

// ---- 导入报告 ----

export interface StRegexImportReport {
  readonly created: number;
  readonly skipped: readonly { readonly scriptName: string; readonly reason: string }[];
}

export function buildStRegexImportReport(
  items: readonly StRegexImportItem[],
): StRegexImportReport {
  const skipped = items
    .filter((item): item is Extract<StRegexImportItem, { kind: "skipped" }> => item.kind === "skipped")
    .map((item) => ({ scriptName: item.scriptName, reason: item.reason }));
  return { created: items.length - skipped.length, skipped };
}

// ---- 规则行编辑草稿 ----

export interface CleaningRuleDraft {
  readonly name: string;
  readonly mode: CleaningRule["mode"];
  readonly pattern: string;
  readonly flags: string;
  readonly replacement: string;
  readonly enabled: boolean;
}

export function ruleDraftFromRule(rule: CleaningRule): CleaningRuleDraft {
  return {
    name: rule.name,
    mode: rule.mode,
    pattern: rule.pattern,
    flags: rule.flags,
    replacement: rule.replacement ?? "",
    enabled: rule.enabled,
  };
}

/** 草稿校验（复用规则校验；replacement 空串视为缺省）。 */
export function validateRuleDraft(draft: CleaningRuleDraft): string | undefined {
  return validateCleaningRule({
    name: draft.name,
    mode: draft.mode,
    pattern: draft.pattern,
    flags: draft.flags,
    replacement: draft.mode === "replace" ? draft.replacement : undefined,
  });
}
