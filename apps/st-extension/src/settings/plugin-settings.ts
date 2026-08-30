/**
 * 插件设置模型（纯逻辑层 seam 的一部分）：设置形状 + 默认值合并 + 存储端口。
 * 宿主 = StSettingsStore（ST extension_settings 对象，随 ST settings.json 持久化）。
 *
 * 字段演进：新增设置项只改 DEFAULT_SETTINGS 与 mergeSettings，旧数据自动补齐
 * 默认值（向前兼容）；未知键原样丢弃（读取时只取已知形状）。
 */

import {
  AGENT_PRESET_ROLES,
  BUILTIN_AGENT_PRESET_ID,
  DEFAULT_AGENT_PRESET_SETTINGS,
  type AgentPresetRole,
  type AgentPresetSettings,
  type AgentPromptPreset,
  type AgentPresetMessage,
} from "../agent-presets/preset-model.ts";
import type { AgentConnection } from "./agent-connections.ts";
import { mergeCleaningRuleLists, type CleaningRuleList } from "./cleaning-rule-lists.ts";
import { mergeMemoryViews, type MemoryView } from "./memory-views.ts";

/** R2 云同步配置（ticket 08 生效；ticket 06 仅占位展示，UI 控件禁用） */
export interface R2Settings {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/** 对话文件镜像设置（ticket 16）：随聊天文件同步记忆快照的开关与内容范围 */
export interface ChatMirrorSettings {
  /** 镜像总开关（默认开，跟随插件总开关） */
  readonly enabled: boolean;
  /** 镜像是否包含修订历史（默认开；关闭时 data.history 裁空，体积主要来源） */
  readonly includeHistory: boolean;
}

export interface PluginSettings {
  /** 插件总开关：关闭后不建空间/不同步/事件桥不响应（设置面板开关，ticket 06 起生效） */
  readonly enabled: boolean;
  /** R2 云同步配置（ticket 08 生效；ticket 06 仅占位展示） */
  readonly r2: R2Settings;
  /** 记忆宏全局前缀（ticket 15 生效；默认建议 {{ste}}，用户可直接粘贴进提示词预设）：
   * {{前缀}} = 默认快照；{{前缀::名字}} = 内置宏/视图/对话宏（对话 > 全局 > 内置） */
  readonly macroName: string;
  /** 记忆宏输出上限（字符，ticket 15；超出从尾部截断并附标记；默认 2000） */
  readonly macroLimit: number;
  /** 对话文件镜像（ticket 16 生效） */
  readonly mirror: ChatMirrorSettings;
  /** Agent 提示词预设（ticket 17 生效）：全局预设列表 + 活动预设 */
  readonly agentPresets: AgentPresetSettings;
  /** Agent 连接（ADR 0010）：命名 LLM 连接池（Base URL + API Key + 模型名） */
  readonly agentConnections: readonly AgentConnection[];
  /** 表格填写 Agent 的连接选择；undefined = 跟随 ST 当前连接 */
  readonly fillTaskConnectionId?: string;
  /** 查询 Agent 的连接选择；undefined = 跟随 ST 当前连接 */
  readonly queryChatConnectionId?: string;
  /** 清洗规则列表（ticket 22 / ADR 0011）：插件级命名列表，对话选择其一 */
  readonly cleaningRuleLists: readonly CleaningRuleList[];
  /** 记忆视图（ticket 02 / ADR 0025）：插件级命名视图，{{宏名::视图名}} 展开 */
  readonly memoryViews: readonly MemoryView[];
}

/** extension_settings 命名空间键（ST 全局设置对象上的插件私有键，不与其他扩展冲突） */
export const SETTINGS_KEY = "steMemory";

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" },
  macroName: "{{ste}}",
  macroLimit: 2000,
  mirror: { enabled: true, includeHistory: true },
  agentPresets: DEFAULT_AGENT_PRESET_SETTINGS,
  agentConnections: [],
  fillTaskConnectionId: undefined,
  queryChatConnectionId: undefined,
  cleaningRuleLists: [],
  memoryViews: [],
};

/** 设置存储端口：read 每次重取（宿主读 ST 全局对象，保证拿到最新持久化值） */
export interface SettingsStore {
  read(): PluginSettings;
  write(settings: PluginSettings): void;
}

/**
 * 把持久化的原始值合并进默认值：缺失键补默认、类型不符的键回退默认，
 * 未知键不进入结果。损坏/半旧数据（来自旧版本插件或手改）不会让运行时崩溃。
 */
export function mergeSettings(raw: unknown): PluginSettings {
  const source = isRecord(raw) ? raw : {};
  const agentConnections = mergeAgentConnections(source.agentConnections);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    r2: mergeR2(source.r2),
    macroName: typeof source.macroName === "string" ? source.macroName : DEFAULT_SETTINGS.macroName,
    macroLimit:
      typeof source.macroLimit === "number" &&
      Number.isFinite(source.macroLimit) &&
      source.macroLimit >= 0
        ? source.macroLimit
        : DEFAULT_SETTINGS.macroLimit,
    mirror: mergeMirror(source.mirror),
    agentPresets: mergeAgentPresets(source.agentPresets),
    agentConnections,
    // 悬空选择（指向已丢弃/不存在连接）回退跟随 ST 当前连接
    fillTaskConnectionId: mergeConnectionSelection(source.fillTaskConnectionId, agentConnections),
    queryChatConnectionId: mergeConnectionSelection(source.queryChatConnectionId, agentConnections),
    cleaningRuleLists: mergeCleaningRuleLists(source.cleaningRuleLists),
    memoryViews: mergeMemoryViews(source.memoryViews),
  };
}

/**
 * 合并持久化的预设设置：损坏的预设项/片段项逐项丢弃（保留其余），
 * activePresetId 未知或指向已丢弃项时回退系统默认。
 */
export function mergeAgentPresets(raw: unknown): AgentPresetSettings {
  const source = isRecord(raw) ? raw : {};
  const presets: AgentPromptPreset[] = [];
  if (Array.isArray(source.presets)) {
    for (const item of source.presets) {
      const preset = mergeAgentPreset(item);
      if (preset) presets.push(preset);
    }
  }
  const activePresetId =
    typeof source.activePresetId === "string" &&
    (source.activePresetId === BUILTIN_AGENT_PRESET_ID ||
      presets.some((p) => p.id === source.activePresetId))
      ? source.activePresetId
      : BUILTIN_AGENT_PRESET_ID;
  return { presets, activePresetId };
}

function mergeAgentPreset(raw: unknown): AgentPromptPreset | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    raw.id === "" ||
    typeof raw.name !== "string" ||
    (!Array.isArray(raw.messages) && !Array.isArray(raw.fragments))
  ) {
    return undefined;
  }
  // v2 消息编排：messages 数组；旧版片段（fragments，无角色）按 system 消息迁移
  const items: unknown[] = Array.isArray(raw.messages)
    ? raw.messages
    : Array.isArray(raw.fragments)
      ? raw.fragments
      : [];
  const messages: AgentPresetMessage[] = [];
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.name !== "string" ||
      typeof item.content !== "string" ||
      typeof item.enabled !== "boolean"
    ) {
      continue;
    }
    messages.push({
      id: item.id,
      name: item.name,
      role: isAgentPresetRole(item.role) ? item.role : "system",
      content: item.content,
      enabled: item.enabled,
    });
  }
  return { id: raw.id, name: raw.name, messages };
}

function isAgentPresetRole(value: unknown): value is AgentPresetRole {
  return AGENT_PRESET_ROLES.includes(value as AgentPresetRole);
}

/** R2 四项配置全部非空 = 已配置（面板同步状态占位的判定；ticket 08 接入真实状态） */
export function isR2Configured(settings: PluginSettings): boolean {
  const r2 = settings.r2;
  return (
    r2.accountId.trim() !== "" &&
    r2.accessKeyId.trim() !== "" &&
    r2.secretAccessKey.trim() !== "" &&
    r2.bucket.trim() !== ""
  );
}

function mergeR2(raw: unknown): R2Settings {
  const source = isRecord(raw) ? raw : {};
  const defaults = DEFAULT_SETTINGS.r2;
  return {
    accountId: typeof source.accountId === "string" ? source.accountId : defaults.accountId,
    accessKeyId: typeof source.accessKeyId === "string" ? source.accessKeyId : defaults.accessKeyId,
    secretAccessKey:
      typeof source.secretAccessKey === "string"
        ? source.secretAccessKey
        : defaults.secretAccessKey,
    bucket: typeof source.bucket === "string" ? source.bucket : defaults.bucket,
  };
}

function mergeMirror(raw: unknown): ChatMirrorSettings {
  const source = isRecord(raw) ? raw : {};
  const defaults = DEFAULT_SETTINGS.mirror;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    includeHistory:
      typeof source.includeHistory === "boolean" ? source.includeHistory : defaults.includeHistory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 合并持久化的 Agent 连接：损坏项逐项丢弃（保留其余），id 非空才有效。 */
export function mergeAgentConnections(raw: unknown): readonly AgentConnection[] {
  if (!Array.isArray(raw)) return [];
  const connections: AgentConnection[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.name !== "string" ||
      typeof item.baseUrl !== "string" ||
      typeof item.apiKey !== "string" ||
      typeof item.model !== "string"
    ) {
      continue;
    }
    connections.push({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      apiKey: item.apiKey,
      model: item.model,
    });
  }
  return connections;
}

/** Agent 连接选择合并：非字符串或指向不存在连接的 id → undefined（跟随 ST 当前连接）。 */
function mergeConnectionSelection(
  raw: unknown,
  connections: readonly AgentConnection[],
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return connections.some((c) => c.id === raw) ? raw : undefined;
}
