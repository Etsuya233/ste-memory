/** 每份命名清洗规则直接配置标签；v3 丢弃旧版规则列表。 */
export const CLEANING_SCHEMA_VERSION = 3;
export const CLEANING_RULE_NAME_LIMIT = 120;

export interface CleaningTagPair {
  readonly pre: string;
  readonly post: string;
}
export interface CleaningRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly keepTags: readonly CleaningTagPair[];
  readonly excludeTags: readonly CleaningTagPair[];
}

/** 当前版本配置必须通过校验；旧版本在设置入口直接清空。 */
export function mergeCleaningRules(raw: unknown): readonly CleaningRule[] {
  if (!Array.isArray(raw)) throw new Error("清洗规则必须为数组");
  return raw.map((rule: CleaningRule) => {
    if (!rule.id || typeof rule.enabled !== "boolean")
      throw new Error("清洗规则缺少 ID 或启用状态");
    const error = validateCleaningRule(rule);
    if (error) throw new Error(error);
    const normalize = (tag: CleaningTagPair) => ({ pre: tag.pre.trim(), post: tag.post.trim() });
    return {
      id: rule.id,
      name: rule.name.trim(),
      enabled: rule.enabled,
      keepTags: rule.keepTags.map(normalize),
      excludeTags: rule.excludeTags.map(normalize),
    };
  });
}

export function saveCleaningRule(
  rules: readonly CleaningRule[],
  rule: CleaningRule,
): readonly CleaningRule[] {
  return rules.some((item) => item.id === rule.id)
    ? rules.map((item) => (item.id === rule.id ? rule : item))
    : [...rules, rule];
}
export function removeCleaningRule(
  rules: readonly CleaningRule[],
  ruleId: string,
): readonly CleaningRule[] {
  return rules.filter((rule) => rule.id !== ruleId);
}

export type CleaningRuleDraft = Omit<CleaningRule, "id">;

export function validateCleaningRule(input: CleaningRuleDraft): string | undefined {
  if (!input.name.trim()) return "清洗规则名称不能为空";
  if (input.name.length > CLEANING_RULE_NAME_LIMIT)
    return `清洗规则名称不能超过 ${CLEANING_RULE_NAME_LIMIT} 个字符`;
  if (!Array.isArray(input.keepTags) || !Array.isArray(input.excludeTags))
    return "保留标签和排除标签必须为数组";
  if (input.keepTags.length + input.excludeTags.length === 0) return "请至少添加一个保留或排除标签";
  for (const [label, tags] of [
    ["保留", input.keepTags],
    ["排除", input.excludeTags],
  ] as const) {
    for (const tag of tags) {
      if (!tag.pre.trim() || !tag.post.trim()) return `${label}标签的开始和结束标签不能为空`;
    }
  }
  return undefined;
}

export function formatCleaningRuleSelection(ruleId: string): {
  readonly version: 3;
  readonly ruleId: string;
} {
  return { version: CLEANING_SCHEMA_VERSION, ruleId };
}
export function readCleaningRuleSelection(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const selection = raw as { version?: unknown; ruleId?: unknown };
  return selection.version === CLEANING_SCHEMA_VERSION &&
    typeof selection.ruleId === "string" &&
    selection.ruleId !== ""
    ? selection.ruleId
    : undefined;
}
export function findSelectedCleaningRule(
  rules: readonly CleaningRule[],
  selection: string | undefined,
): CleaningRule | undefined {
  return rules.find((rule) => rule.id === selection);
}
export interface CleaningRuleStore {
  read(): string | undefined;
  write(ruleId: string | undefined): void;
}

/** 同组标签一次扫描，按原文顺序匹配；标签都是区分大小写的普通文本。 */
function tagSegments(
  content: string,
  tags: readonly CleaningTagPair[],
): { start: number; inner: number; end: number; after: number; tag: CleaningTagPair }[] {
  const segments = [];
  let cursor = 0;
  while (cursor < content.length) {
    let next:
      | { start: number; inner: number; end: number; after: number; tag: CleaningTagPair }
      | undefined;
    for (const tag of tags) {
      const start = content.indexOf(tag.pre, cursor);
      if (start < 0) continue;
      const inner = start + tag.pre.length;
      const end = content.indexOf(tag.post, inner);
      if (end < 0) continue;
      const after = end + tag.post.length;
      // 同一起点选覆盖更长的完整片段，避免 OR 的结果受配置顺序影响。
      if (!next || start < next.start || (start === next.start && after > next.after))
        next = { start, inner, end, after, tag };
    }
    if (!next) break;
    segments.push(next);
    cursor = next.after;
  }
  return segments;
}

function excludeTaggedContent(content: string, tags: readonly CleaningTagPair[]): string {
  let cursor = 0;
  const pieces: string[] = [];
  for (const segment of tagSegments(content, tags)) {
    pieces.push(content.slice(cursor, segment.start));
    cursor = segment.after;
  }
  pieces.push(content.slice(cursor));
  return pieces.join("");
}

/** 先在原文删除排除段，再从剩余内容提取保留段，避免混入被排除区域的正文。 */
export function applyCleaningRule(content: string, rule: CleaningRule): string {
  if (!rule.enabled) return content;
  const excluded = excludeTaggedContent(content, rule.excludeTags);
  if (rule.keepTags.length === 0) return excluded;
  return tagSegments(excluded, rule.keepTags)
    .map((segment) => excluded.slice(segment.inner, segment.end))
    .filter((text) => text !== "")
    .join("\n");
}
