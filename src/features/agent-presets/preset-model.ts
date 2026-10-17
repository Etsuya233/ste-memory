/**
 * Agent 提示词预设模型（ticket 17 / ADR 0006 + 消息编排扩展）：预设 CRUD / 消息操作 /
 * 导入导出信封 / digest 引用检测。全部为纯函数，settings 不可变更新；
 * id 由调用方注入（宿主 = runtime 的 createId 工厂）。
 *
 * 形状约定：系统默认预设是**虚拟**预设（不进 settings 数组），
 * activePresetId === BUILTIN_AGENT_PRESET_ID 表示使用核心默认组合器。
 *
 * v2（消息编排）：预设由**消息**组成而非文本片段——每条消息有角色
 * （system/user/assistant）与模板文本；system 合并进系统提示词，
 * user/assistant 进入对话前缀。旧版「片段」（fragments，无角色）按 system 迁移。
 */

/** 内置「系统默认」预设的固定 id（虚拟预设，不在 presets 数组中） */
export const BUILTIN_AGENT_PRESET_ID = "systemDefault";

/** 预设导入导出信封（沿用备份文件信封先例：未知版本明确报错，绝不半导入） */
export const AGENT_PRESET_EXPORT_FORMAT = "ste-memory-agent-preset";
/** v2 = 消息编排（messages + role）；v1 = 文本片段（fragments，解析时迁移为 system 消息） */
export const AGENT_PRESET_EXPORT_VERSION = 2;

/** 预设消息角色：system → 系统提示词；user / assistant → 对话前缀消息 */
export type AgentPresetRole = "system" | "user" | "assistant";

export const AGENT_PRESET_ROLES: readonly AgentPresetRole[] = ["system", "user", "assistant"];

/** 预设内一条命名的消息：可单独开关，顺序决定其在最终消息列表中的位置 */
export interface AgentPresetMessage {
  readonly id: string;
  /** 显示名；空 = 编辑器中回退显示内容首行 */
  readonly name: string;
  /** 消息角色：system（合并进系统提示词）/ user / assistant（进入对话前缀） */
  readonly role: AgentPresetRole;
  /** 消息模板文本（可含占位符，组合时展开） */
  readonly content: string;
  readonly enabled: boolean;
}

/** 一个命名的 Agent 提示词预设档案（内含消息列表） */
export interface AgentPromptPreset {
  readonly id: string;
  readonly name: string;
  readonly messages: readonly AgentPresetMessage[];
}

/** 全局预设设置（存 extension_settings.steMemory.agentPresets） */
export interface AgentPresetSettings {
  readonly presets: readonly AgentPromptPreset[];
  /** 活动预设 id；BUILTIN_AGENT_PRESET_ID = 系统默认（虚拟预设） */
  readonly activePresetId: string;
}

export const DEFAULT_AGENT_PRESET_SETTINGS: AgentPresetSettings = {
  presets: [],
  activePresetId: BUILTIN_AGENT_PRESET_ID,
};

/** 预设导出文件信封（单预设） */
export interface AgentPresetExportFile {
  readonly format: typeof AGENT_PRESET_EXPORT_FORMAT;
  readonly version: typeof AGENT_PRESET_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly preset: AgentPromptPreset;
}

function createMessage(id: string): AgentPresetMessage {
  return { id, name: "", role: "system", content: "", enabled: true };
}

/**
 * 新建预设：一条空启用的 system 消息（用户直接开写），自动设为活动预设。
 * 新建返回新 settings；原 settings 不动。
 */
export function createAgentPreset(
  settings: AgentPresetSettings,
  name: string,
  createId: () => string,
): AgentPresetSettings {
  const preset: AgentPromptPreset = {
    id: createId(),
    name,
    messages: [createMessage(createId())],
  };
  return { ...settings, presets: [...settings.presets, preset], activePresetId: preset.id };
}

/** 复制预设为「原名 (副本)」（含消息与开关状态），设为活动；预设不存在原样返回。 */
export function duplicateAgentPreset(
  settings: AgentPresetSettings,
  presetId: string,
  createId: () => string,
): AgentPresetSettings {
  const source = settings.presets.find((p) => p.id === presetId);
  if (!source) return settings;
  const copy: AgentPromptPreset = {
    id: createId(),
    name: `${source.name} (副本)`,
    messages: source.messages.map((m) => ({
      id: createId(),
      name: m.name,
      role: m.role,
      content: m.content,
      enabled: m.enabled,
    })),
  };
  return { ...settings, presets: [...settings.presets, copy], activePresetId: copy.id };
}

/** 重命名预设；预设不存在原样返回。 */
export function renameAgentPreset(
  settings: AgentPresetSettings,
  presetId: string,
  name: string,
): AgentPresetSettings {
  return updatePreset(settings, presetId, (preset) => ({ ...preset, name }));
}

/**
 * 删除预设；删除的是活动预设时回退到系统默认。
 * 预设不存在原样返回。
 */
export function deleteAgentPreset(
  settings: AgentPresetSettings,
  presetId: string,
): AgentPresetSettings {
  if (!settings.presets.some((p) => p.id === presetId)) return settings;
  const presets = settings.presets.filter((p) => p.id !== presetId);
  return {
    ...settings,
    presets,
    activePresetId:
      settings.activePresetId === presetId ? BUILTIN_AGENT_PRESET_ID : settings.activePresetId,
  };
}

/** 切换活动预设；未知 id 原样返回（含切回系统默认）。 */
export function setActiveAgentPreset(
  settings: AgentPresetSettings,
  presetId: string,
): AgentPresetSettings {
  if (presetId === BUILTIN_AGENT_PRESET_ID) return { ...settings, activePresetId: presetId };
  if (!settings.presets.some((p) => p.id === presetId)) return settings;
  return { ...settings, activePresetId: presetId };
}

/**
 * 移动预设到指定索引（0 基，越界夹紧；展示性排序，活动预设跟随移动）。
 * 目标索引 = 当前位置时原样返回。
 */
export function moveAgentPreset(
  settings: AgentPresetSettings,
  presetId: string,
  toIndex: number,
): AgentPresetSettings {
  const fromIndex = settings.presets.findIndex((p) => p.id === presetId);
  if (fromIndex < 0) return settings;
  const clamped = Math.max(0, Math.min(toIndex, settings.presets.length - 1));
  if (clamped === fromIndex) return settings;
  const presets = [...settings.presets];
  const [moved] = presets.splice(fromIndex, 1);
  presets.splice(clamped, 0, moved!);
  return { ...settings, presets };
}

/**
 * 活动预设解析：系统默认/未知 id → undefined（宿主用核心默认组合器）；
 * 否则返回对应预设。
 */
export function resolveActivePreset(settings: AgentPresetSettings): AgentPromptPreset | undefined {
  if (settings.activePresetId === BUILTIN_AGENT_PRESET_ID) return undefined;
  return settings.presets.find((p) => p.id === settings.activePresetId);
}

/** 追加一条空启用的 system 消息；预设不存在原样返回。 */
export function addAgentPresetMessage(
  settings: AgentPresetSettings,
  presetId: string,
  createId: () => string,
): AgentPresetSettings {
  return updatePreset(settings, presetId, (preset) => ({
    ...preset,
    messages: [...preset.messages, createMessage(createId())],
  }));
}

/** 删除指定消息；预设/消息不存在原样返回。 */
export function removeAgentPresetMessage(
  settings: AgentPresetSettings,
  presetId: string,
  messageId: string,
): AgentPresetSettings {
  return updatePreset(settings, presetId, (preset) => ({
    ...preset,
    messages: preset.messages.filter((m) => m.id !== messageId),
  }));
}

/** 部分更新消息（名称/角色/内容/开关）；预设/消息不存在原样返回。 */
export function updateAgentPresetMessage(
  settings: AgentPresetSettings,
  presetId: string,
  messageId: string,
  patch: Partial<Pick<AgentPresetMessage, "name" | "role" | "content" | "enabled">>,
): AgentPresetSettings {
  return updatePreset(settings, presetId, (preset) => ({
    ...preset,
    messages: preset.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
  }));
}

/**
 * 移动消息到指定索引（0 基，越界夹紧）；目标索引 = 当前位置时原样返回。
 * 拖拽排序（dnd-kit 给出目标索引）与 ↑/↓ 按钮（换算为索引）共用。
 */
export function moveAgentPresetMessage(
  settings: AgentPresetSettings,
  presetId: string,
  messageId: string,
  toIndex: number,
): AgentPresetSettings {
  return updatePreset(settings, presetId, (preset) => {
    const fromIndex = preset.messages.findIndex((m) => m.id === messageId);
    if (fromIndex < 0) return preset;
    const clamped = Math.max(0, Math.min(toIndex, preset.messages.length - 1));
    if (clamped === fromIndex) return preset;
    const messages = [...preset.messages];
    const [moved] = messages.splice(fromIndex, 1);
    messages.splice(clamped, 0, moved!);
    return { ...preset, messages };
  });
}

/** 启用消息按顺序拼接（空行分隔）；停用或内容为空的消息不参与。 */
export function presetPromptText(preset: AgentPromptPreset): string {
  return preset.messages
    .filter((m) => m.enabled && m.content.trim() !== "")
    .map((m) => m.content)
    .join("\n\n");
}

/** 占位符引用检测：任一**启用**消息含该占位符即命中（停用消息不算——不进入最终消息）。 */
export function containsPlaceholderReference(
  preset: AgentPromptPreset,
  placeholder: string,
): boolean {
  return preset.messages.some((m) => m.enabled && m.content.includes(placeholder));
}

/**
 * digest 引用检测：任一**启用**消息含 {{tablesDigest}} 或 {{systemDefaultPrompt}}
 * 即认为预设保留表/字段摘要。
 */
export function containsDigestReference(preset: AgentPromptPreset): boolean {
  return (
    containsPlaceholderReference(preset, "{{tablesDigest}}") ||
    containsPlaceholderReference(preset, "{{systemDefaultPrompt}}")
  );
}

/**
 * {{worldbook}} 引用检测：任一**启用**消息含 {{worldbook}} 即需要世界书扫描
 * （停用消息不算）。宿主据此决定是否调用 ST 扫描。
 */
export function containsWorldbookReference(preset: AgentPromptPreset): boolean {
  return containsPlaceholderReference(preset, "{{worldbook}}");
}

/**
 * {{msg}} 引用检测：任一**启用**消息含 {{msg}} 即认为用户接管了块消息编排
 * （不再自动追加块提示词；块内容只出现在 {{msg}} 展开处）。
 */
export function containsMsgReference(preset: AgentPromptPreset): boolean {
  return containsPlaceholderReference(preset, "{{msg}}");
}

/** 序列化预设导出文件（信封：format/version/exportedAt/preset）。 */
export function serializeAgentPresetExport(preset: AgentPromptPreset, exportedAt: string): string {
  const file: AgentPresetExportFile = {
    format: AGENT_PRESET_EXPORT_FORMAT,
    version: AGENT_PRESET_EXPORT_VERSION,
    exportedAt,
    preset,
  };
  return JSON.stringify(file, null, 2);
}

/** 解析预设导出文件：格式/版本/结构任一不合法即抛错（绝不半导入）。 */
export function parseAgentPresetExport(text: string): AgentPromptPreset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("预设文件格式不合法：不是合法 JSON");
  }
  if (!isRecord(raw) || raw.format !== AGENT_PRESET_EXPORT_FORMAT) {
    throw new Error("预设文件格式不匹配（ste-memory-agent-preset）");
  }
  if (raw.version !== 1 && raw.version !== AGENT_PRESET_EXPORT_VERSION) {
    throw new Error(
      `预设文件版本 ${String(raw.version)} 不受支持（当前支持 v${AGENT_PRESET_EXPORT_VERSION}）`,
    );
  }
  const preset = raw.preset;
  if (!isRecord(preset) || typeof preset.name !== "string") {
    throw new Error("预设文件结构损坏，无法导入");
  }
  const items = Array.isArray(preset.messages) ? preset.messages : preset.fragments;
  if (!Array.isArray(items)) {
    throw new Error("预设文件结构损坏，无法导入");
  }
  if (
    items.some(
      (m) =>
        !isRecord(m) ||
        typeof m.content !== "string" ||
        typeof m.enabled !== "boolean" ||
        (m.role !== undefined && !AGENT_PRESET_ROLES.includes(m.role as AgentPresetRole)),
    )
  ) {
    throw new Error("预设文件结构损坏，无法导入");
  }
  return {
    id: typeof preset.id === "string" && preset.id !== "" ? preset.id : "imported",
    name: preset.name,
    messages: items.map((m) => ({
      id: typeof m.id === "string" && m.id !== "" ? m.id : "message",
      name: typeof m.name === "string" ? m.name : "",
      // v1 片段无角色字段 → 按 system 迁移（旧行为：全部进系统提示词）
      role: isAgentPresetRole(m.role) ? m.role : "system",
      content: m.content,
      enabled: m.enabled,
    })),
  };
}

/**
 * 导入预设：追加并设为活动；重名自动改名（原名 (2)/(3)…，不覆盖现有）；
 * 导入 id 与现有冲突时重新分配。返回新 settings。
 */
export function importAgentPreset(
  settings: AgentPresetSettings,
  imported: AgentPromptPreset,
): AgentPresetSettings {
  const existingIds = new Set(settings.presets.map((p) => p.id));
  let id = imported.id;
  while (existingIds.has(id)) id = `${id}-imported`;
  let name = imported.name;
  const nameTaken = (candidate: string) => settings.presets.some((p) => p.name === candidate);
  if (nameTaken(name)) {
    let suffix = 2;
    while (nameTaken(`${name} (${suffix})`)) suffix += 1;
    name = `${name} (${suffix})`;
  }
  const preset: AgentPromptPreset = { ...imported, id, name };
  return { ...settings, presets: [...settings.presets, preset], activePresetId: id };
}

function updatePreset(
  settings: AgentPresetSettings,
  presetId: string,
  update: (preset: AgentPromptPreset) => AgentPromptPreset,
): AgentPresetSettings {
  const preset = settings.presets.find((p) => p.id === presetId);
  if (!preset) return settings;
  return {
    ...settings,
    presets: settings.presets.map((p) => (p.id === presetId ? update(p) : p)),
  };
}

function isAgentPresetRole(value: unknown): value is AgentPresetRole {
  return AGENT_PRESET_ROLES.includes(value as AgentPresetRole);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
