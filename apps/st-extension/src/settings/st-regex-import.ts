/**
 * ST 正则条目导入转换（ticket 22 / ADR 0011）：把 ST Regex 扩展的脚本对象
 * （全局 extension_settings.regex 或 ST 导出 JSON 中的条目）映射为清洗规则。
 *
 * 映射语义（用户确认）：
 * - replaceString 去空白后为空 → 去掉；其余一律 → 替换（{{match}} 展开为 $0，
 *   $1/$<name> 走 JS 原生语义——与 ST 的 String.replace 行为逐字一致；纯组引用
 *   不映射为「保留」，见 ADR 0011 review 修正）；
 * - findRegex 支持 ST 的 /pattern/flags 包裹写法（regexFromString 同款）；
 *   flags 只保留 JS 合法的 g/i/m/s/u/y（x/X/A/J/U 丢弃并 note），空 flags → 默认 g；
 * - placement 与「用户输入(1)/AI 输出(2)」无交集 → 跳过（对消息清洗无意义）；
 * - trimStrings/宏替换/运行上下文字段不迁移，差异以 notes 逐条说明；
 * - disabled → enabled 取反；永远追加，不记录来源 id（Q6 决策）。
 */
import type { CleaningRule } from "./cleaning-rule-lists.ts";
import { CLEANING_RULE_NAME_LIMIT, validateCleaningRule } from "./cleaning-rule-lists.ts";

/** ST regex_placement 枚举（engine.js）：只有用户输入/AI 输出会作用于聊天消息 */
const ST_PLACEMENT_USER_INPUT = 1;
const ST_PLACEMENT_AI_OUTPUT = 2;

/** JS 合法的 flags 字符集（api/web 同口径）；ST 额外的 x/X/A/J/U 导入时丢弃 */
const VALID_JS_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

export type StRegexImportItem =
  | { readonly kind: "rule"; readonly rule: CleaningRule; readonly notes: readonly string[] }
  | { readonly kind: "skipped"; readonly scriptName: string; readonly reason: string };

/**
 * 转换 ST 导出载荷（对象数组或单对象）为导入条目。
 * 非对象载荷 → 单条跳过（导入报告可见）。
 */
export function convertStRegexScripts(
  payload: unknown,
  createId: () => string,
): readonly StRegexImportItem[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => convertStRegexScript(item, createId));
  }
  if (isRecord(payload)) {
    return [convertStRegexScript(payload, createId)];
  }
  return [
    { kind: "skipped", scriptName: "", reason: "导入内容不是正则条目数据（应为对象或对象数组）" },
  ];
}

/** 转换单条 ST 正则脚本；无法映射时返回 skipped 及原因。 */
export function convertStRegexScript(raw: unknown, createId: () => string): StRegexImportItem {
  if (!isRecord(raw)) return { kind: "skipped", scriptName: "", reason: "条目不是对象" };

  const scriptName = raw.scriptName;
  if (typeof scriptName !== "string" || scriptName.trim() === "") {
    return { kind: "skipped", scriptName: "", reason: "缺少脚本名称" };
  }
  if (scriptName.length > CLEANING_RULE_NAME_LIMIT) {
    return {
      kind: "skipped",
      scriptName,
      reason: `脚本名称超过 ${CLEANING_RULE_NAME_LIMIT} 字符`,
    };
  }

  const findRegex = raw.findRegex;
  if (typeof findRegex !== "string" || findRegex === "") {
    return { kind: "skipped", scriptName, reason: "缺少匹配式（findRegex）" };
  }

  if (!touchesChatMessages(raw.placement)) {
    return {
      kind: "skipped",
      scriptName,
      reason: "作用范围不含用户输入/AI 输出（仅作用于其他场景），跳过",
    };
  }

  // /pattern/flags 包裹解析（ST regexFromString 同款）；未包裹按纯正则
  const parsed = parseStFindRegex(findRegex);
  const notes: string[] = [];
  const flags = mapStFlags(parsed.flags, notes);

  const replaceString = typeof raw.replaceString === "string" ? raw.replaceString : "";
  const mode = mapReplaceMode(replaceString);
  const replacement = mode === "replace" ? expandMatchMacro(replaceString) : undefined;

  if (Array.isArray(raw.trimStrings) && raw.trimStrings.length > 0) {
    notes.push(`trimStrings（${raw.trimStrings.length} 项）未迁移`);
  }
  if (typeof raw.substituteRegex === "number" && raw.substituteRegex !== 0) {
    notes.push(`宏替换未迁移（substituteRegex=${raw.substituteRegex}），匹配式按原文使用`);
  }
  const contextFields = unmigratedStContextFields(raw);
  if (contextFields.length > 0) {
    notes.push(`ST 运行上下文字段（${contextFields.join("/")}）未迁移`);
  }

  const candidate: CleaningRule =
    replacement === undefined
      ? { id: createId(), name: scriptName, mode, pattern: parsed.pattern, flags, enabled: raw.disabled !== true }
      : { id: createId(), name: scriptName, mode, pattern: parsed.pattern, flags, replacement, enabled: raw.disabled !== true };
  const validation = validateCleaningRule(candidate);
  if (validation !== undefined) {
    return { kind: "skipped", scriptName, reason: `正则无法编译：${validation}` };
  }
  return { kind: "rule", rule: candidate, notes };
}

/** placement 是否触及聊天消息（用户输入 / AI 输出任一） */
function touchesChatMessages(placement: unknown): boolean {
  return (
    Array.isArray(placement) &&
    placement.some(
      (value) => value === ST_PLACEMENT_USER_INPUT || value === ST_PLACEMENT_AI_OUTPUT,
    )
  );
}

/** 解析 /pattern/flags 包裹：首尾斜杠 + 纯字母 flags；否则整串为纯正则。 */
function parseStFindRegex(findRegex: string): { readonly pattern: string; readonly flags: string } {
  const wrapped = findRegex.match(/^\/(.*)\/([a-z]*)$/is);
  if (wrapped) return { pattern: wrapped[1]!, flags: wrapped[2]! };
  return { pattern: findRegex, flags: "" };
}

/** 过滤 JS 非法的 flags；丢弃的字符进 note；空结果默认 g。 */
function mapStFlags(rawFlags: string, notes: string[]): string {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const flag of rawFlags) {
    if (VALID_JS_FLAGS.has(flag)) {
      if (!kept.includes(flag)) kept.push(flag);
    } else {
      if (!dropped.includes(flag)) dropped.push(flag);
    }
  }
  if (dropped.length > 0) {
    notes.push(`匹配式包含 JS 不支持的 flags（${dropped.join("")}），已忽略`);
  }
  return kept.join("") || "g";
}

/** 替换串 → 模式：空 → 去掉；其余一律 → 替换（JS 原生替换语义 = ST 行为，保真）。
 * 注：纯组引用（$1）与 {{match}} 不映射为「保留」——ST 的替换保留匹配间文本，
 * 而保留模式是「全内容替换为捕获拼接」，两者语义不同（review 2026-08 修正，ADR 0011）。 */
function mapReplaceMode(replaceString: string): CleaningRule["mode"] {
  return replaceString.trim() === "" ? "discard" : "replace";
}

/** 展开 ST 的 {{match}} 宏为 JS 的 $0（大小写不敏感，同 ST /{{match}}/gi）。 */
function expandMatchMacro(replaceString: string): string {
  return replaceString.replace(/{{match}}/gi, "$0");
}

/** 收集已设置的 ST 运行上下文字段（导入后无对应语义，仅报告）。 */
function unmigratedStContextFields(raw: Record<string, unknown>): string[] {
  const present: string[] = [];
  if (raw.markdownOnly === true) present.push("markdownOnly");
  if (raw.promptOnly === true) present.push("promptOnly");
  if (raw.runOnEdit === true) present.push("runOnEdit");
  if (typeof raw.minDepth === "number" && !Number.isNaN(raw.minDepth)) present.push("minDepth");
  if (typeof raw.maxDepth === "number" && !Number.isNaN(raw.maxDepth)) present.push("maxDepth");
  return present;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
