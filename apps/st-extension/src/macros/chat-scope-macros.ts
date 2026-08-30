/**
 * 聊天 Scope 宏存储（双 Scope 宏系统，Phase 1）：
 *
 * - 聊天 Scope 宏存储在 chatMetadata.steMemoryChatMacros，随 .jsonl 导入导出；
 * - 类型复用 MemoryView（声明式配置：表 Key + 筛选 + 投影），与全局视图同构；
 * - 名称全局唯一：内置 > 聊天 Scope > 全局（聊天 Scope 可覆盖全局同名宏）；
 * - 面板创建时实时检查名称冲突（不允许与内置宏或全局宏同名）。
 */
import type { MemoryView } from "../settings/memory-views.ts";
import { mergeMemoryViews, validateMemoryViewName } from "../settings/memory-views.ts";

/** 聊天 Scope 宏存储结构（chatMetadata.steMemoryChatMacros） */
export interface ChatScopeMacroStore {
  readonly version: 1;
  readonly macros: readonly MemoryView[];
}

/** 内置宏名（memoryFull + memory_<表Key>） */
export const BUILTIN_FULL_MACRO = "memoryFull";
export const BUILTIN_TABLE_MACRO_PREFIX = "memory_";

/**
 * 合并聊天 Scope 宏：损坏数据逐项丢弃（保留其余），名称非法/重复丢弃。
 * 与 mergeMemoryViews 同模式，但额外校验名称不与内置宏冲突。
 */
export function mergeChatScopeMacros(raw: unknown): readonly MemoryView[] {
  if (!isRecord(raw)) return [];
  if (raw.version !== 1) return [];
  if (!Array.isArray(raw.macros)) return [];
  return mergeMemoryViews(raw.macros);
}

/**
 * 校验聊天 Scope 宏名是否与内置宏或全局宏冲突。
 * 返回错误文案；undefined = 合法。
 */
export function validateChatScopeMacroName(
  name: string,
  globalMacroNames: readonly string[],
): string | undefined {
  // 先校验基本合法性
  const basicError = validateMemoryViewName(name);
  if (basicError !== undefined) return basicError;

  // 校验内置宏冲突
  if (name === BUILTIN_FULL_MACRO) {
    return "宏名与内置宏 memoryFull 冲突";
  }
  if (name.startsWith(BUILTIN_TABLE_MACRO_PREFIX)) {
    return `宏名与内置表宏前缀 memory_ 冲突`;
  }

  // 校验全局宏冲突
  if (globalMacroNames.includes(name)) {
    return `宏名与全局宏 ${name} 冲突`;
  }

  return undefined;
}

/**
 * 检查聊天 Scope 宏名是否与内置宏冲突（不含全局宏检查，用于内置宏名生成）。
 */
export function isBuiltinMacroName(name: string): boolean {
  return name === BUILTIN_FULL_MACRO || name.startsWith(BUILTIN_TABLE_MACRO_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
