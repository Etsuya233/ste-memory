/**
 * Agent 提示词预设组合器（ticket 17 / ADR 0006）：把预设文本展开为 ProposalAgent
 * 的最终 system prompt。
 *
 * 占位符**单遍**展开：一次正则扫描完成全部替换，替换结果不再被扫描（摘要里的
 * 同名 token 不会被二次替换）；未知占位符原样保留（用户决策，与 ST 宏行为一致）。
 * {{systemDefaultPrompt}} / {{tablesDigest}} 的展开内容来自 core 组合器——
 * 摘要格式是工具可用性契约，不在插件侧复制实现（ADR 0006）。
 */
import {
  composeProposalAgentSystemPrompt,
  composeTableDigestSummary,
  type MemorySpaceTableDigest,
  type ProposalSystemPromptComposer,
} from "@ste-memory/core/memory/agent";

/** 占位符白名单（编辑器插入 chips、展开器与 ST 宏注册共用同一份文案） */
export const AGENT_PRESET_PLACEHOLDERS = {
  user: "{{user}}",
  char: "{{char}}",
  tablesDigest: "{{tablesDigest}}",
  systemDefaultPrompt: "{{systemDefaultPrompt}}",
  worldbook: "{{worldbook}}",
} as const;

export type AgentPresetPlaceholderName = keyof typeof AGENT_PRESET_PLACEHOLDERS;

/** 占位符说明（编辑器 chip title 悬停提示；新增占位符需同步白名单/提示/展开器三处，类型强制） */
export const AGENT_PRESET_PLACEHOLDER_HINTS: Record<AgentPresetPlaceholderName, string> = {
  user: "展开为当前对话的用户名（任务提交时快照）",
  char: "展开为当前对话的角色名（群聊 = 群名）",
  tablesDigest: "展开为记忆空间表/字段摘要",
  systemDefaultPrompt: "展开为系统默认提示词全文（指令 + 摘要）",
  worldbook: "展开为与任务剧情匹配的世界书条目（ST 扫描，无匹配为空）",
};

/** 占位符展开时的对话双方名字（任务提交时从 ST 快照，群聊 char = 群名） */
export interface AgentPromptNames {
  readonly user: string;
  readonly char: string;
}

/** 由白名单生成匹配模式（单源：新增占位符只改 AGENT_PRESET_PLACEHOLDERS） */
const PLACEHOLDER_PATTERN = new RegExp(
  `\\{\\{(${Object.keys(AGENT_PRESET_PLACEHOLDERS).join("|")})\\}\\}`,
  "g",
);

/**
 * 展开占位符：{{systemDefaultPrompt}} → 默认提示词全文（指令 + 摘要）、
 * {{tablesDigest}} → 表/字段摘要、{{user}} / {{char}} → 对话双方名字、
 * {{worldbook}} → 提交时快照的世界书扫描文本（ADR 0007）。
 * 未知占位符（不在白名单）原样保留。
 */
export function expandAgentPresetPlaceholders(
  text: string,
  names: AgentPromptNames,
  digest: MemorySpaceTableDigest,
  worldbookText: string,
): string {
  const expanders: Record<AgentPresetPlaceholderName, () => string> = {
    user: () => names.user,
    char: () => names.char,
    tablesDigest: () => composeTableDigestSummary(digest),
    systemDefaultPrompt: () => composeProposalAgentSystemPrompt(digest),
    worldbook: () => worldbookText,
  };
  return text.replace(PLACEHOLDER_PATTERN, (match, name: AgentPresetPlaceholderName) =>
    expanders[name](),
  );
}

/**
 * 由预设文本构造 ProposalAgent 系统提示词组合器（digest → 最终提示词）。
 * names 与 worldbookText 在任务提交时快照（对话切换守卫保证任务内 chat 不变；
 * 世界书扫描提交时一次，ADR 0007）；worldbookText 为空 = 无世界书/无匹配/降级。
 */
export function composePresetSystemPrompt(
  presetText: string,
  names: AgentPromptNames,
  worldbookText: string,
): ProposalSystemPromptComposer {
  return (digest: MemorySpaceTableDigest) =>
    expandAgentPresetPlaceholders(presetText, names, digest, worldbookText);
}
