import type { MemoryMacro } from "./macro-expression.ts";
import {
  buildMacroOverviewRows,
  type MacroOverviewInput,
  type MacroOverviewRow,
} from "./macro-overview-model.ts";

/**
 * 宏内容一览读取器（issue 01）：从记忆宏服务与 Agent 预设宏服务的预计算快照
 * 聚合展示行。宿主只注入快照读取函数与设置，聚合规则留在功能内（纯逻辑已单测）。
 */
export interface MacroOverviewSources {
  /** 插件设置里的宏前缀（{{ste}} 形态）与全局视图列表（每次读取重取） */
  readonly readSettings: () => {
    readonly macroName: string;
    readonly macros: readonly Pick<MemoryMacro, "name">[];
  };
  /** 注册名解析（前缀 → 裸标识符；不合法 = undefined） */
  readonly resolveRegistrationName: (macroName: string) => string | undefined;
  readonly readDefaultSnapshot: () => string;
  readonly readViewSnapshot: (viewName: string) => string | undefined;
  readonly readChannelScopeMacros: () => readonly Pick<MemoryMacro, "name">[];
  readonly readChatScopeSnapshot: (name: string) => string | undefined;
  readonly readBuiltinNames: () => readonly string[];
  readonly readBuiltinSnapshot: (name: string) => string | undefined;
  /** Agent 预设宏快照（digest 摘要 + 默认提示词全文 + 花括号宏名） */
  readonly readAgentMacros: () => readonly { readonly name: string; readonly text: string }[];
}

export function createMacroOverviewReader(
  sources: MacroOverviewSources,
): () => readonly MacroOverviewRow[] {
  return () => {
    const settings = sources.readSettings();
    const input: MacroOverviewInput = {
      prefix: sources.resolveRegistrationName(settings.macroName) ?? "",
      defaultSnapshot: sources.readDefaultSnapshot(),
      views: settings.macros.map((view) => ({
        name: view.name,
        text: sources.readViewSnapshot(view.name) ?? "",
      })),
      chatScopeMacros: sources.readChannelScopeMacros().map((chatMacro) => ({
        name: chatMacro.name,
        text: sources.readChatScopeSnapshot(chatMacro.name) ?? "",
      })),
      builtin: sources.readBuiltinNames().map((name) => ({
        name,
        text: sources.readBuiltinSnapshot(name) ?? "",
      })),
      agent: sources.readAgentMacros(),
    };
    return buildMacroOverviewRows(input);
  };
}
