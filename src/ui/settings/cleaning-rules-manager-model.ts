import {
  applyCleaningRule,
  validateCleaningRule,
  type CleaningRule,
  type CleaningTagPair,
} from "../../features/cleaning/cleaning-rule-lists.ts";

export type CleaningRuleDraft = Omit<CleaningRule, "id">;
export function ruleDraftFromRule(rule: CleaningRule): CleaningRuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    keepTags: rule.keepTags,
    excludeTags: rule.excludeTags,
  };
}
export const validateRuleDraft = validateCleaningRule;
export function draftToRule(draft: CleaningRuleDraft, id: string): CleaningRule {
  const normalize = (tag: CleaningTagPair) => ({ pre: tag.pre.trim(), post: tag.post.trim() });
  return {
    id,
    ...draft,
    name: draft.name.trim(),
    keepTags: draft.keepTags.map(normalize),
    excludeTags: draft.excludeTags.map(normalize),
  };
}

/** 测试载荷中的一条消息（消息列表形态；单条文本形态 = name 为空的一条）。 */
export interface CleaningTestMessage {
  readonly name: string;
  readonly content: string;
}

/** 流水线中的一步：一条规则执行后（或跳过时保持不变）的内容。 */
export interface CleaningTestStep {
  readonly ruleId: string;
  readonly ruleName: string;
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
  const effective: { readonly rule: CleaningRule; readonly fromDraft: boolean }[] = rules.map(
    (rule) => {
      const draft = draftOverrides.get(rule.id);
      return draft
        ? { rule: draftToRule(draft, rule.id), fromDraft: true }
        : { rule, fromDraft: false };
    },
  );
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
        active: rule.enabled,
        fromDraft,
        output: content,
      });
    }
    return { name: message.name, input: message.content, steps, output: content };
  });
  return { kind: "ok", anyActiveRule, messages: results };
}
