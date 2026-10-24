/**
 * 记忆宏设置界面纯逻辑（UI 层）：宏名状态、宏表达式、输出体积/截断、预算、
 * 作用域覆盖提示。组件只做投影；规则与宏服务/领域模型同源。
 */
import type { MemoryTable } from "../../features/memory/index.ts";
import type { MacroOverviewRow } from "../../features/macros/macro-overview-model.ts";
import { TRUNCATION_MARKER } from "../../features/macros/memory-context-snapshot.ts";
import { resolveMacroRegistrationName } from "../../features/macros/macro-name.ts";

export type MacroNameStatus =
  | { readonly kind: "valid"; readonly registrationName: string }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" };

/** 设置值 → 界面状态（合法/空/非法），与宿主注册解析同一函数。 */
export function macroNameStatus(raw: string): MacroNameStatus {
  const registrationName = resolveMacroRegistrationName(raw);
  if (registrationName !== undefined) return { kind: "valid", registrationName };
  return raw.trim() === "" ? { kind: "empty" } : { kind: "invalid" };
}

/** 默认快照宏名（{{ste}}）；未配置合法宏名时为空串。 */
export function defaultMacroToken(prefix: string): string {
  return prefix === "" ? "" : `{{${prefix}}}`;
}

/** 带名字的宏表达式（{{ste::名字}}）；未配置合法宏名时为空串。 */
export function macroToken(prefix: string, name: string): string {
  return prefix === "" ? "" : `{{${prefix}::${name}}}`;
}

export interface MacroOutputInfo {
  readonly characters: number;
  readonly empty: boolean;
  readonly truncated: boolean;
}

/** 宏快照输出状态：字符数、空输出、是否带截断标记。 */
export function macroOutputInfo(text: string): MacroOutputInfo {
  const characters = text.length;
  return {
    characters,
    empty: characters === 0,
    truncated: text.endsWith(TRUNCATION_MARKER),
  };
}

/** 列表行输出文案（空/已截断/字数）。 */
export function macroOutputLabel(text: string): string {
  const info = macroOutputInfo(text);
  if (info.empty) return "空输出";
  return info.truncated ? `已截断 · ${info.characters} 字` : `${info.characters} 字`;
}

export interface MacroBudgetInfo {
  /** 默认快照（{{前缀}}）当前字符数 */
  readonly defaultCharacters: number;
  /** 记忆宏家族中带截断标记的宏数量 */
  readonly truncatedCount: number;
  /** 记忆宏家族宏数量（默认 + 全局宏 + 对话宏 + 内置宏） */
  readonly macroCount: number;
}

/**
 * 记忆宏家族预算摘要（只读预计算快照）。宏名非法/为空返回 undefined；
 * Agent 预设宏（{{tablesDigest}} 等）不属于记忆宏家族，不参与统计。
 */
export function macroBudgetInfo(
  rows: readonly MacroOverviewRow[],
  rawMacroName: string,
): MacroBudgetInfo | undefined {
  const status = macroNameStatus(rawMacroName);
  if (status.kind !== "valid") return undefined;
  const prefix = status.registrationName;
  const defaultName = defaultMacroToken(prefix);
  const family = rows.filter(
    (row) => row.name === defaultName || row.name.startsWith(`{{${prefix}::`),
  );
  return {
    defaultCharacters: family.find((row) => row.name === defaultName)?.text.length ?? 0,
    truncatedCount: family.filter((row) => row.text.endsWith(TRUNCATION_MARKER)).length,
    macroCount: family.length,
  };
}

/** 内置宏占用名：full + 当前空间启用表 Key（同名全局/对话宏会覆盖内置宏）。 */
export function builtinMacroNames(tables: readonly MemoryTable[] | undefined): ReadonlySet<string> {
  const names = new Set<string>(["full"]);
  for (const table of tables ?? []) {
    if (table.enabled) names.add(table.key);
  }
  return names;
}

export interface MacroConflictBadge {
  readonly text: string;
  readonly title: string;
  readonly kind: "info" | "warning";
}

/**
 * 同名覆盖提示（展示用）：全局宏被同名对话宏覆盖、全局/对话宏覆盖内置宏；
 * 对话宏覆盖同名全局宏。没有冲突返回空数组。
 */
export function macroConflictBadges(input: {
  readonly scope: "global" | "chat";
  readonly name: string;
  readonly globalNames?: ReadonlySet<string>;
  readonly chatNames?: ReadonlySet<string>;
  readonly builtinNames: ReadonlySet<string>;
}): readonly MacroConflictBadge[] {
  const badges: MacroConflictBadge[] = [];
  if (input.scope === "global") {
    if (input.chatNames?.has(input.name)) {
      badges.push({
        text: "对话宏优先",
        title: "当前对话有同名对话宏，会覆盖此全局宏",
        kind: "warning",
      });
    } else if (input.builtinNames.has(input.name)) {
      badges.push({
        text: "覆盖内置",
        title: "此全局宏会覆盖同名内置宏",
        kind: "warning",
      });
    }
    return badges;
  }
  if (input.globalNames?.has(input.name)) {
    badges.push({
      text: "覆盖全局",
      title: "此对话宏会覆盖同名全局宏",
      kind: "info",
    });
  }
  if (input.builtinNames.has(input.name)) {
    badges.push({
      text: "覆盖内置",
      title: "此对话宏会覆盖同名内置宏",
      kind: "info",
    });
  }
  return badges;
}

/** 列表行摘要：输出体积（有活动空间时，置于最前避免窄屏被截断）+ 表名 + 筛选/条数/投影。 */
export function macroRowMeta(input: {
  readonly tableName: string;
  readonly selectionSummary: string;
  readonly outputText: string;
  readonly hasActiveSpace: boolean;
}): string {
  const parts: string[] = [];
  if (input.hasActiveSpace) parts.push(macroOutputLabel(input.outputText));
  parts.push(input.tableName);
  if (input.selectionSummary !== "") parts.push(input.selectionSummary);
  return parts.join(" · ");
}
