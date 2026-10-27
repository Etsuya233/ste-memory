/**
 * 聊天 Scope 宏存储（双 Scope 宏系统）：
 *
 * - 聊天 Scope 宏存储在 chatMetadata.steMemoryChatMacros，随 .jsonl 导入导出；
 * - 类型复用 MemoryView（声明式配置：表 Key + 筛选 + 投影），与全局视图同构；
 * - 展开走 {{前缀::宏名}} 统一分发（MemoryMacroService），优先级高于全局视图
 *   与内置宏——同名即覆盖（对话级 > 全局 > 内置）；名字只需满足视图名语法。
 */
import type { MemoryView } from "./memory-views.ts";
import { mergeMemoryViews } from "./memory-views.ts";
import { migrateMemoryViews } from "./macro-expression.ts";

/** 聊天 Scope 宏存储结构（chatMetadata.steMemoryChatMacros） */
export interface ChatScopeMacroStore {
  readonly version: 1;
  readonly macros: readonly MemoryView[];
}

/**
 * Read the legacy store strictly: migration must not erase invalid siblings or unknown versions.
 */
export function mergeChatScopeMacros(raw: unknown): readonly MemoryView[] {
  if (raw === undefined) return [];
  if (!isRecord(raw) || raw.version !== 1) throw new Error("无法识别旧对话宏版本，原始数据已保留");
  migrateMemoryViews(raw.macros, "legacy-check");
  return mergeMemoryViews(raw.macros);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
