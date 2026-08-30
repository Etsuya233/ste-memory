/**
 * 聊天 Scope 宏存储（双 Scope 宏系统）：
 *
 * - 聊天 Scope 宏存储在 chatMetadata.steMemoryChatMacros，随 .jsonl 导入导出；
 * - 类型复用 MemoryView（声明式配置：表 Key + 筛选 + 投影），与全局视图同构；
 * - 展开走 {{前缀::宏名}} 统一分发（MemoryMacroService），优先级高于全局视图
 *   与内置宏——同名即覆盖（对话级 > 全局 > 内置）；名字只需满足视图名语法。
 */
import type { MemoryView } from "../settings/memory-views.ts";
import { mergeMemoryViews } from "../settings/memory-views.ts";

/** 聊天 Scope 宏存储结构（chatMetadata.steMemoryChatMacros） */
export interface ChatScopeMacroStore {
  readonly version: 1;
  readonly macros: readonly MemoryView[];
}

/**
 * 合并聊天 Scope 宏：损坏数据逐项丢弃（保留其余），名称非法/重复丢弃。
 * 与 mergeMemoryViews 同模式（名字不与任何作用域冲突——同名即覆盖由分发层处理）。
 */
export function mergeChatScopeMacros(raw: unknown): readonly MemoryView[] {
  if (!isRecord(raw)) return [];
  if (raw.version !== 1) return [];
  if (!Array.isArray(raw.macros)) return [];
  return mergeMemoryViews(raw.macros);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
