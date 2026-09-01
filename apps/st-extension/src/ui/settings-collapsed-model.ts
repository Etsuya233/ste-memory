/**
 * 设置分组折叠模型（纯逻辑 seam）：分组标识、持久化与切换。
 * 仅展示偏好，不进 PluginSettings/备份/云同步。
 */

import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { CloudSyncStatus } from "../cloud/sync-coordinator.ts";
import type { ChatMirrorStatus } from "../chat-mirror/chat-metadata-mirror-sync.ts";
import { isR2Configured } from "../settings/plugin-settings.ts";
import { FOLLOW_ST_CONNECTION_LABEL } from "./agent-connection-manager.tsx";
import { BUILTIN_AGENT_PRESET_ID } from "../agent-presets/preset-model.ts";
import { mirrorStatusSummary, syncStatusSummary } from "./space-info.ts";

/** 设置分组稳定标识（持久化键）；插件总开关不参与折叠 */
export const SETTINGS_GROUP_KEYS = [
  "macro",
  "agent-connections",
  "agent-presets",
  "cleaning",
  "backup",
  "mirror",
  "r2",
  "version",
  "entry",
  "safe-area",
  "danger",
] as const;

export type SettingsGroupKey = (typeof SETTINGS_GROUP_KEYS)[number];

/** 持久化键（localStorage；与面板几何键同前缀防冲突） */
export const SETTINGS_COLLAPSED_STORAGE_KEY = "steMemory.settingsCollapsed";

/** 存储端口（测试注入 fake；生产传 safeLocalStorage） */
export interface SettingsCollapsedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isSettingsGroupKey(value: unknown): value is SettingsGroupKey {
  return (SETTINGS_GROUP_KEYS as readonly string[]).includes(value as string);
}

export function parseStoredGroups(raw: string | null): ReadonlySet<SettingsGroupKey> {
  if (raw === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const set = new Set<SettingsGroupKey>();
  for (const item of parsed) {
    if (typeof item === "string" && isSettingsGroupKey(item)) {
      set.add(item);
    }
  }
  return set;
}

export function serializeGroups(groups: ReadonlySet<SettingsGroupKey>): string {
  return JSON.stringify([...groups]);
}

export function loadExpandedGroups(
  storage: SettingsCollapsedStorage,
): ReadonlySet<SettingsGroupKey> {
  return parseStoredGroups(storage.getItem(SETTINGS_COLLAPSED_STORAGE_KEY));
}

export function saveExpandedGroups(
  storage: SettingsCollapsedStorage,
  groups: ReadonlySet<SettingsGroupKey>,
): void {
  try {
    storage.setItem(SETTINGS_COLLAPSED_STORAGE_KEY, serializeGroups(groups));
  } catch {
    // 几何持久化同理：失败不影响面板使用
  }
}

export function toggleGroup(
  groups: ReadonlySet<SettingsGroupKey>,
  key: SettingsGroupKey,
): ReadonlySet<SettingsGroupKey> {
  const next = new Set(groups);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function isExpanded(groups: ReadonlySet<SettingsGroupKey>, key: SettingsGroupKey): boolean {
  return groups.has(key);
}

// ---- 折叠头摘要（折叠态一行 12px 副标题） ----

export function macroSummary(settings: PluginSettings, chatScopeMacroCount: number): string {
  const name = settings.macroName.trim() === "" ? "未配置" : settings.macroName;
  const views = settings.memoryViews.length;
  return `${name} · ${views}视图 · ${chatScopeMacroCount}对话宏`;
}

export function agentConnectionsSummary(settings: PluginSettings): string {
  const total = settings.agentConnections.length;
  if (total === 0) return "未配置 · 跟随 ST 当前连接";
  const fillName = resolveConnectionName(settings, settings.fillTaskConnectionId);
  const queryName = resolveConnectionName(settings, settings.queryChatConnectionId);
  return `${total}个 · 填表:${fillName} · 查询:${queryName}`;
}

function resolveConnectionName(settings: PluginSettings, id: string | undefined): string {
  if (id === undefined) return FOLLOW_ST_CONNECTION_LABEL;
  const found = settings.agentConnections.find((c) => c.id === id);
  return found ? found.name : FOLLOW_ST_CONNECTION_LABEL;
}

export function agentPresetsSummary(settings: PluginSettings): string {
  const total = settings.agentPresets.presets.length;
  const activeId = settings.agentPresets.activePresetId;
  let activeName: string;
  if (activeId === BUILTIN_AGENT_PRESET_ID) activeName = "系统默认";
  else {
    const found = settings.agentPresets.presets.find((p) => p.id === activeId);
    activeName = found ? found.name : "系统默认";
  }
  return `${total}个 · 当前:${activeName}`;
}

export function cleaningSummary(
  settings: PluginSettings,
  selectedListId: string | undefined,
): string {
  const total = settings.cleaningRuleLists.length;
  if (total === 0) return "未配置";
  if (selectedListId === undefined) return `${total}列表 · 未选择`;
  const found = settings.cleaningRuleLists.find((l) => l.id === selectedListId);
  const name = found ? found.name : "未选择";
  return `${total}列表 · 当前:${name}`;
}

export function mirrorSummary(settings: PluginSettings, mirrorStatus: ChatMirrorStatus): string {
  if (!settings.mirror.enabled) return "已停用";
  return mirrorStatusSummary(mirrorStatus);
}

export function r2Summary(settings: PluginSettings, syncStatus: CloudSyncStatus): string {
  if (!isR2Configured(settings)) return "未配置";
  return syncStatusSummary(syncStatus);
}
