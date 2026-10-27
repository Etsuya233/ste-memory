import {
  applyCleaningRule,
  validateCleaningRule,
  type CleaningRule,
  type CleaningTagPair,
} from "../../features/cleaning/cleaning-rules.ts";

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

export interface CleaningTestMessage {
  readonly name: string;
  readonly content: string;
}
export interface CleaningTestMessageResult {
  readonly name: string;
  readonly input: string;
  readonly output: string;
}
export type CleaningTestRun =
  | {
      readonly kind: "ok";
      readonly active: boolean;
      readonly messages: readonly CleaningTestMessageResult[];
    }
  | { readonly kind: "error"; readonly errors: readonly string[] };

/** 测试仅执行当前这一份规则；草稿由调用方快照传入。 */
export function runCleaningTest(
  rule: CleaningRule,
  messages: readonly CleaningTestMessage[],
): CleaningTestRun {
  if (rule.enabled) {
    const error = validateCleaningRule(rule);
    if (error) return { kind: "error", errors: [error] };
  }
  return {
    kind: "ok",
    active: rule.enabled,
    messages: messages.map((message) => ({
      name: message.name,
      input: message.content,
      output: applyCleaningRule(message.content, rule),
    })),
  };
}
