/**
 * 清洗规则列表纯模型（ticket 22 / ADR 0011）：插件级命名的清洗规则集合。
 *
 * - 规则三模式：保留（捕获组 1 否则整段匹配的全局拼接）/ 去掉（删匹配段）/
 *   替换（JS 替换串语义，$1 / $<name>；导入时 {{match}} 已展开为 $0）；
 * - 读取时变换：原文永不改写，上一条输出是下一条输入（apps ADR 0001 精神）；
 * - 聊天选择 = chatMetadata 小指针 {version:1, listId}（独立键，降级安全）；
 * - 持久化合并逐项丢弃损坏数据（同 mergeAgentConnections 防御惯例）。
 */

export const CLEANING_RULE_MODES = ["keep", "discard", "replace"] as const;
export type CleaningRuleMode = (typeof CLEANING_RULE_MODES)[number];

/** 允许的正则 flags 说明（与 api/web 对齐；ST 条目的 x/X/A/J/U 导入时丢弃） */

export interface CleaningRule {
  readonly id: string;
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  /** 组合后的 flags 字符串，如 "g" / "gi"。 */
  readonly flags: string;
  /** 仅 replace 模式：JS 替换串（$1 / $<name>）。 */
  readonly replacement?: string;
  readonly enabled: boolean;
}

export interface CleaningRuleList {
  readonly id: string;
  readonly name: string;
  /** 规则按数组顺序执行（position = 数组下标，重排即 move）。 */
  readonly rules: readonly CleaningRule[];
}

/** 规则名称上限（与 api/web 同口径） */
export const CLEANING_RULE_NAME_LIMIT = 120;

const VALID_FLAGS_PATTERN = /^[gimsuy]*$/u;

// ---- 持久化合并 ----

/**
 * 把持久化的清洗规则列表原始值合并为合法形状：损坏的列表/规则逐项丢弃
 * （保留其余），未知键不进入结果。规则必须能通过完整校验（含正则编译）。
 */
export function mergeCleaningRuleLists(raw: unknown): readonly CleaningRuleList[] {
  if (!Array.isArray(raw)) return [];
  const lists: CleaningRuleList[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id === "" || typeof item.name !== "string") {
      continue;
    }
    const rules: CleaningRule[] = [];
    if (Array.isArray(item.rules)) {
      for (const rawRule of item.rules) {
        const rule = mergeCleaningRule(rawRule);
        if (rule) rules.push(rule);
      }
    }
    lists.push({ id: item.id, name: item.name, rules });
  }
  return lists;
}

function mergeCleaningRule(raw: unknown): CleaningRule | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    raw.id === "" ||
    typeof raw.name !== "string" ||
    !isCleaningRuleMode(raw.mode) ||
    typeof raw.pattern !== "string" ||
    raw.pattern === "" ||
    typeof raw.flags !== "string" ||
    typeof raw.enabled !== "boolean"
  ) {
    return undefined;
  }
  const replacement =
    raw.mode === "replace" && typeof raw.replacement === "string" && raw.replacement !== ""
      ? raw.replacement
      : undefined;
  const candidate: CleaningRule = {
    id: raw.id,
    name: raw.name,
    mode: raw.mode,
    pattern: raw.pattern,
    flags: raw.flags,
    replacement,
    enabled: raw.enabled,
  };
  return validateCleaningRule(candidate) === undefined ? candidate : undefined;
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

export function updateCleaningRule(
  lists: readonly CleaningRuleList[],
  listId: string,
  ruleId: string,
  patch: Partial<CleaningRule>,
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

// ---- 校验 ----

export interface CleaningRuleDraft {
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  readonly flags: string;
  readonly replacement?: string;
}

/** 全量校验规则输入（编辑/导入/合并共用）；返回错误消息（undefined 表示通过）。 */
export function validateCleaningRule(input: CleaningRuleDraft): string | undefined {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return "清洗规则名称不能为空";
  }
  if (input.name.length > CLEANING_RULE_NAME_LIMIT) {
    return `清洗规则名称不能超过 ${CLEANING_RULE_NAME_LIMIT} 个字符`;
  }
  if (!isCleaningRuleMode(input.mode)) {
    return "清洗规则模式必须是 keep、discard 或 replace";
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return "正则表达式不能为空";
  }
  if (
    typeof input.flags !== "string" ||
    !VALID_FLAGS_PATTERN.test(input.flags) ||
    new Set(input.flags).size !== input.flags.length
  ) {
    return "正则 flags 只能是 g/i/m/s/u/y 且不能重复";
  }
  if (input.mode === "replace" && (typeof input.replacement !== "string" || input.replacement === "")) {
    return "替换模式必须提供替换串";
  }
  try {
    new RegExp(input.pattern, input.flags);
  } catch {
    return "正则表达式语法错误";
  }
  return undefined;
}

function isCleaningRuleMode(value: unknown): value is CleaningRuleMode {
  return value === "keep" || value === "discard" || value === "replace";
}

// ---- 聊天选择（chatMetadata 小指针，ADR 0011）----

/** 聊天选择写入 chatMetadata 的形态：{version:1, listId}（版本信封，未来演进）。 */
export function formatCleaningListSelection(listId: string): {
  readonly version: 1;
  readonly listId: string;
} {
  return { version: 1, listId };
}

/** 解析聊天选择：{version:1, listId} → listId；缺失/版本不符/垃圾 → undefined（视为未选择）。 */
export function parseCleaningListSelection(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.listId !== "string" || raw.listId === "") {
    return undefined;
  }
  return raw.listId;
}

/** 解析当前对话选中的清洗规则：未选择或列表已删除（悬空引用）→ 空（不清洗）。 */
export function resolveSelectedCleaningRules(
  lists: readonly CleaningRuleList[],
  selection: string | undefined,
): readonly CleaningRule[] {
  if (selection === undefined) return [];
  const list = lists.find((candidate) => candidate.id === selection);
  return list ? list.rules : [];
}

/** 聊天选择读写端口（宿主 = StChatAdapter.cleaningListStore，chatMetadata 小指针）。 */
export interface CleaningListStore {
  /** 当前对话所选列表 id；未选择/无法识别为 undefined */
  read(): string | undefined;
  /** 写入选择（undefined = 清除，删除键）；写即触发防抖持久化 */
  write(listId: string | undefined): void;
}

// ---- 变换（读取时应用，apps ADR 0001 语义 + replace 模式）----

/**
 * 按传入顺序执行（调用方保证有序——列表数组序），只应用启用规则；
 * 上一条的输出是下一条的输入。
 */
export function applyCleaningRules(content: string, rules: readonly CleaningRule[]): string {
  let result = content;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    result = applyCleaningRule(result, rule);
  }
  return result;
}

/**
 * 单条规则变换：
 * - 去掉 = 删除所有匹配段（flags 不含 g 只删第一处）；无匹配原样不动；
 * - 替换 = 以替换串替换匹配（JS $1 / $<name> 语义；flags 不含 g 只替第一处）；
 * - 保留 = 内容替换为「捕获组 1（若有）否则整段匹配」的全局拼接；
 *   flags 不含 g 只取第一处；无匹配原样不动；
 * - 能匹配空串的正则允许（JS 引擎对零长匹配自动推进 lastIndex，不会死循环）。
 */
export function applyCleaningRule(content: string, rule: CleaningRule): string {
  const regex = new RegExp(rule.pattern, rule.flags);
  if (rule.mode === "discard") {
    return content.replace(regex, "");
  }
  if (rule.mode === "replace") {
    return content.replace(regex, rule.replacement ?? "");
  }
  const matches: readonly RegExpMatchArray[] = regex.global
    ? [...content.matchAll(regex)]
    : (() => {
        const match = content.match(regex);
        return match ? [match] : [];
      })();
  if (matches.length === 0) return content;
  return matches.map(cleaningCapture).join("");
}

/** 有捕获组 1 时输出捕获组 1（即使捕获到空串），否则输出整段匹配。 */
function cleaningCapture(match: RegExpMatchArray): string {
  const group = match[1];
  return group !== undefined ? group : match[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
