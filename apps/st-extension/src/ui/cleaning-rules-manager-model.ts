/**
 * 清洗规则设置区块（ticket 22 / ADR 0011）的纯逻辑 seam：导入目标解析、
 * 导入应用（永远追加）、导入报告、规则行编辑草稿。
 * 组件只做「模型 → DOM」投影与事件接线（同 task-panel-model 惯例）。
 */
import type { CleaningRule, CleaningRuleList } from "../settings/cleaning-rule-lists.ts";
import { applyCleaningRule, validateCleaningRule } from "../settings/cleaning-rule-lists.ts";
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

/** 草稿 → 规则（测试运行与新建草稿行渲染共用；replacement 仅 replace 模式携带）。 */
export function draftToRule(draft: CleaningRuleDraft, id: string): CleaningRule {
  return {
    id,
    name: draft.name,
    mode: draft.mode,
    pattern: draft.pattern,
    flags: draft.flags,
    enabled: draft.enabled,
    ...(draft.mode === "replace" ? { replacement: draft.replacement } : {}),
  };
}

// ---- 清洗测试（ticket 27）：弹窗预览当前列表整条流水线 ----

/** 测试载荷中的一条消息（消息列表形态；单条文本形态 = name 为空的一条）。 */
export interface CleaningTestMessage {
  readonly name: string;
  readonly content: string;
}

/** 流水线中的一步：一条规则执行后（或跳过时保持不变）的内容。 */
export interface CleaningTestStep {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly mode: CleaningRule["mode"];
  /** 本条规则本次是否实际执行（false = 停用跳过，内容不变） */
  readonly active: boolean;
  /** 是否来自未保存草稿（覆盖或追加） */
  readonly fromDraft: boolean;
  /** 本条规则执行后的内容 */
  readonly output: string;
}

export interface CleaningTestMessageResult {
  readonly name: string;
  readonly input: string;
  readonly steps: readonly CleaningTestStep[];
  readonly output: string;
}

export type CleaningTestRun =
  | {
      readonly kind: "ok";
      /** 列表是否有启用规则（false = UI 提示「列表没有启用规则」，结果为原文） */
      readonly anyActiveRule: boolean;
      readonly messages: readonly CleaningTestMessageResult[];
    }
  | { readonly kind: "error"; readonly errors: readonly string[] };

/**
 * 清洗测试运行（ticket 27）：把测试载荷按列表流水线执行，收集逐规则中间态。
 * 未保存草稿按 id 覆盖已保存规则；草稿 id 不在列表时追加到末尾（新建未保存
 * 规则）。先校验会执行的草稿（失败收集全部错误并中止，绝不静默回退已保存
 * 版本）；停用规则跳过且不校验。逐消息执行（只清 content，名字原样保留），
 * 规则顺序 = 数组序，上一条输出是下一条输入。
 */
export function runCleaningTest(
  rules: readonly CleaningRule[],
  draftOverrides: ReadonlyMap<string, CleaningRuleDraft>,
  messages: readonly CleaningTestMessage[],
): CleaningTestRun {
  const effective: { readonly rule: CleaningRule; readonly fromDraft: boolean }[] = rules.map((rule) => {
    const draft = draftOverrides.get(rule.id);
    return draft ? { rule: draftToRule(draft, rule.id), fromDraft: true } : { rule, fromDraft: false };
  });
  for (const [id, draft] of draftOverrides) {
    if (!rules.some((rule) => rule.id === id)) {
      effective.push({ rule: draftToRule(draft, id), fromDraft: true });
    }
  }
  const errors: string[] = [];
  for (const { rule, fromDraft } of effective) {
    if (!fromDraft || !rule.enabled) continue;
    const draft = draftOverrides.get(rule.id);
    const error = draft ? validateRuleDraft(draft) : undefined;
    if (error !== undefined) errors.push(`规则「${draft!.name}」：${error}`);
  }
  if (errors.length > 0) return { kind: "error", errors };
  const anyActiveRule = effective.some(({ rule }) => rule.enabled);
  const results = messages.map((message) => {
    const steps: CleaningTestStep[] = [];
    let content = message.content;
    for (const { rule, fromDraft } of effective) {
      if (rule.enabled) content = applyCleaningRule(content, rule);
      steps.push({
        ruleId: rule.id,
        ruleName: rule.name,
        mode: rule.mode,
        active: rule.enabled,
        fromDraft,
        output: content,
      });
    }
    return { name: message.name, input: message.content, steps, output: content };
  });
  return { kind: "ok", anyActiveRule, messages: results };
}
