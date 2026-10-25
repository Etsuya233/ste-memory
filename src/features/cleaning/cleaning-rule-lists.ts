/** 标签清洗配置 v2：旧规则直接丢弃，不执行正则或替换。 */
export const CLEANING_SCHEMA_VERSION = 2;
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

export interface CleaningRuleList {
  readonly id: string;
  readonly name: string;
  /** 上一条规则的输出作为下一条的输入。 */
  readonly rules: readonly CleaningRule[];
}

/** 版本判断由设置入口负责；当前版本的数据必须通过完整校验。 */
export function mergeCleaningRuleLists(raw: unknown): readonly CleaningRuleList[] {
  if (!Array.isArray(raw)) throw new Error("清洗规则列表必须为数组");
  return raw.map((list: CleaningRuleList) => {
    if (!list.id || !list.name.trim() || !Array.isArray(list.rules)) {
      throw new Error("清洗规则列表缺少 ID、名称或规则数组");
    }
    return {
      id: list.id,
      name: list.name,
      rules: list.rules.map((rule) => {
        if (!rule.id || typeof rule.enabled !== "boolean")
          throw new Error("清洗规则缺少 ID 或启用状态");
        const error = validateCleaningRule(rule);
        if (error) throw new Error(error);
        return {
          id: rule.id,
          name: rule.name.trim(),
          enabled: rule.enabled,
          keepTags: rule.keepTags.map(normalizeTag),
          excludeTags: rule.excludeTags.map(normalizeTag),
        };
      }),
    };
  });
}

function normalizeTag(tag: CleaningTagPair): CleaningTagPair {
  return { pre: tag.pre.trim(), post: tag.post.trim() };
}

// ---- 列表 CRUD ----

export function createCleaningRuleList(
  lists: readonly CleaningRuleList[],
  id: string,
  name: string,
): readonly CleaningRuleList[] {
  return [...lists, { id, name, rules: [] }];
}

export function renameCleaningRuleList(
  lists: readonly CleaningRuleList[],
  listId: string,
  name: string,
): readonly CleaningRuleList[] {
  return updateList(lists, listId, (list) => ({ ...list, name }));
}

export function removeCleaningRuleList(
  lists: readonly CleaningRuleList[],
  listId: string,
): readonly CleaningRuleList[] {
  return lists.filter((list) => list.id !== listId);
}

// ---- 规则 CRUD ----

export function addCleaningRule(
  lists: readonly CleaningRuleList[],
  listId: string,
  rule: CleaningRule,
): readonly CleaningRuleList[] {
  return updateList(lists, listId, (list) => ({ ...list, rules: [...list.rules, rule] }));
}

export type CleaningRulePatch = Partial<Omit<CleaningRule, "id">>;

export function updateCleaningRule(
  lists: readonly CleaningRuleList[],
  listId: string,
  ruleId: string,
  patch: CleaningRulePatch,
): readonly CleaningRuleList[] {
  return updateList(lists, listId, (list) => ({
    ...list,
    rules: list.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)),
  }));
}

export function removeCleaningRule(
  lists: readonly CleaningRuleList[],
  listId: string,
  ruleId: string,
): readonly CleaningRuleList[] {
  return updateList(lists, listId, (list) => ({
    ...list,
    rules: list.rules.filter((r) => r.id !== ruleId),
  }));
}

/** 重排：把规则移到目标下标（越界钳制到 [0, len-1]）；列表/规则缺失原样返回。 */
export function moveCleaningRule(
  lists: readonly CleaningRuleList[],
  listId: string,
  ruleId: string,
  toIndex: number,
): readonly CleaningRuleList[] {
  return updateList(lists, listId, (list) => {
    const fromIndex = list.rules.findIndex((r) => r.id === ruleId);
    if (fromIndex < 0) return list;
    const rules = [...list.rules];
    const [moved] = rules.splice(fromIndex, 1);
    const clamped = Math.max(0, Math.min(toIndex, rules.length));
    rules.splice(clamped, 0, moved!);
    return { ...list, rules };
  });
}

/** 按 id 命中列表后应用变换；列表缺失原样返回（防御，与 preset-model 同惯例）。 */
function updateList(
  lists: readonly CleaningRuleList[],
  listId: string,
  mutate: (list: CleaningRuleList) => CleaningRuleList,
): readonly CleaningRuleList[] {
  return lists.map((list) => (list.id === listId ? mutate(list) : list));
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

export function formatCleaningListSelection(listId: string): {
  readonly version: 2;
  readonly listId: string;
} {
  return { version: CLEANING_SCHEMA_VERSION, listId };
}

export function parseCleaningListSelection(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const selection = raw as { version?: unknown; listId?: unknown };
  return selection.version === CLEANING_SCHEMA_VERSION &&
    typeof selection.listId === "string" &&
    selection.listId !== ""
    ? selection.listId
    : undefined;
}

export function resolveSelectedCleaningRules(
  lists: readonly CleaningRuleList[],
  selection: string | undefined,
): readonly CleaningRule[] {
  return lists.find((list) => list.id === selection)?.rules ?? [];
}

export interface CleaningListStore {
  read(): string | undefined;
  write(listId: string | undefined): void;
}

export function applyCleaningRules(content: string, rules: readonly CleaningRule[]): string {
  return rules.reduce(
    (text, rule) => (rule.enabled ? applyCleaningRule(text, rule) : text),
    content,
  );
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

export function applyCleaningRule(content: string, rule: CleaningRule): string {
  if (rule.keepTags.length === 0) return excludeTaggedContent(content, rule.excludeTags);
  const kept = tagSegments(content, rule.keepTags)
    .map((segment) => {
      // 提取时已剥去边界，仍保留标签身份，确保同一标签同时配置时排除优先。
      if (
        rule.excludeTags.some((tag) => tag.pre === segment.tag.pre && tag.post === segment.tag.post)
      )
        return "";
      return content.slice(segment.inner, segment.end);
    })
    .filter((text) => text !== "")
    .join("\n");
  return excludeTaggedContent(kept, rule.excludeTags);
}
