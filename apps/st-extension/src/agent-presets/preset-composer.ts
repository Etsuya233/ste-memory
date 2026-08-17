/**
 * Agent 提示词预设组合器（ticket 17 / ADR 0006 + 消息编排扩展）：把预设消息列表
 * 展开为 ProposalAgent 的编排消息（ComposedAgentMessage[]：system 合并进系统
 * 提示词，user/assistant 进入对话前缀）。
 *
 * 占位符**单遍**展开：一次正则扫描完成全部替换，替换结果不再被扫描（摘要里的
 * 同名 token 不会被二次替换）；未知占位符原样保留（用户决策，与 ST 宏行为一致）。
 * {{systemDefaultPrompt}} / {{tablesDigest}} 的展开内容来自 core 组合器——
 * 摘要格式是工具可用性契约，不在插件侧复制实现（ADR 0006）。
 * {{char_card}} / {{user_card}} / {{msg}} 来自任务提交时快照的 ST 上下文
 * （角色卡描述 / 当前 Persona 描述 / 本块需要总结的消息内容）。
 */
import type {
  ComposedAgentMessage,
  MemorySpaceTableDigest,
  ProposalMessagesComposer,
} from "@ste-memory/core/memory/agent";
import {
  composeProposalAgentSystemPrompt,
  composeTableDigestSummary,
} from "@ste-memory/core/memory/agent";
import type { AgentPromptPreset } from "./preset-model.ts";

/** 占位符白名单（编辑器插入 chips、展开器与 ST 宏注册共用同一份文案） */
export const AGENT_PRESET_PLACEHOLDERS = {
  user: "{{user}}",
  char: "{{char}}",
  char_card: "{{char_card}}",
  user_card: "{{user_card}}",
  msg: "{{msg}}",
  tablesDigest: "{{tablesDigest}}",
  systemDefaultPrompt: "{{systemDefaultPrompt}}",
  worldbook: "{{worldbook}}",
} as const;

export type AgentPresetPlaceholderName = keyof typeof AGENT_PRESET_PLACEHOLDERS;

/** 占位符说明（编辑器 chip title 悬停提示；新增占位符需同步白名单/提示/展开器三处，类型强制） */
export const AGENT_PRESET_PLACEHOLDER_HINTS: Record<AgentPresetPlaceholderName, string> = {
  user: "展开为当前对话的用户名（任务提交时快照）",
  char: "展开为当前对话的角色名（群聊 = 群名）",
  char_card: "展开为当前角色卡描述（群聊 = 群成员角色卡逐条拼接）",
  user_card: "展开为当前 Persona 描述（ST 用户设定）",
  msg: "展开为本块需要总结的消息内容（填表任务；引用后不再自动追加块提示词）",
  tablesDigest: "展开为记忆空间表/字段摘要",
  systemDefaultPrompt: "展开为系统默认提示词全文（指令 + 摘要）",
  worldbook: "展开为与任务剧情匹配的世界书条目（ST 扫描，无匹配为空）",
};

/** 占位符展开时的对话双方名字（任务提交时从 ST 快照，群聊 char = 群名） */
export interface AgentPromptNames {
  readonly user: string;
  readonly char: string;
}

/**
 * 占位符展开快照（任务提交时一次快照，块级 {{msg}} 除外）：
 * names = 对话双方名字；charCard / userCard = 角色卡 / Persona 描述文本；
 * worldbookText = 世界书扫描文本（空 = 无世界书/无匹配/降级）；
 * msgText = 本块消息文本（{{msg}} 展开输入，非填表任务 = 空）。
 */
export interface AgentPromptSnapshot {
  readonly names: AgentPromptNames;
  readonly charCard: string;
  readonly userCard: string;
  readonly worldbookText: string;
  readonly msgText: string;
}

/** 由白名单生成匹配模式（单源：新增占位符只改 AGENT_PRESET_PLACEHOLDERS） */
const PLACEHOLDER_PATTERN = new RegExp(
  `\\{\\{(${Object.keys(AGENT_PRESET_PLACEHOLDERS).join("|")})\\}\\}`,
  "g",
);

/**
 * 展开占位符：{{systemDefaultPrompt}} → 默认提示词全文（指令 + 摘要）、
 * {{tablesDigest}} → 表/字段摘要、{{user}} / {{char}} → 对话双方名字、
 * {{char_card}} / {{user_card}} → 角色卡 / Persona 描述、{{msg}} → 块消息文本、
 * {{worldbook}} → 提交时快照的世界书扫描文本（ADR 0007）。
 * 未知占位符（不在白名单）原样保留。
 */
export function expandAgentPresetPlaceholders(
  text: string,
  snapshot: AgentPromptSnapshot,
  digest: MemorySpaceTableDigest,
): string {
  const expanders: Record<AgentPresetPlaceholderName, () => string> = {
    user: () => snapshot.names.user,
    char: () => snapshot.names.char,
    char_card: () => snapshot.charCard,
    user_card: () => snapshot.userCard,
    msg: () => snapshot.msgText,
    tablesDigest: () => composeTableDigestSummary(digest),
    systemDefaultPrompt: () => composeProposalAgentSystemPrompt(digest),
    worldbook: () => snapshot.worldbookText,
  };
  return text.replace(PLACEHOLDER_PATTERN, (match, name: AgentPresetPlaceholderName) =>
    expanders[name](),
  );
}

/**
 * 由预设消息列表构造编排消息组合器（digest → ComposedAgentMessage[]）。
 * 快照在任务提交时一次构造（{{msg}} 由宿主按块传入）；每条启用且非空的消息
 * 展开为一条编排消息，角色与顺序原样保留。
 */
export function composePresetMessages(
  preset: AgentPromptPreset,
  snapshot: AgentPromptSnapshot,
): ProposalMessagesComposer {
  return (digest: MemorySpaceTableDigest): readonly ComposedAgentMessage[] =>
    preset.messages
      .filter((message) => message.enabled && message.content.trim() !== "")
      .map((message) => ({
        role: message.role,
        text: expandAgentPresetPlaceholders(message.content, snapshot, digest),
      }));
}
