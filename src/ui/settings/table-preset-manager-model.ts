import type { MemorySpace } from "../../features/memory/index.ts";
import {
  SYSTEM_TABLE_PRESET_NAME,
  listTablePresets,
  type ResolvedTablePreset,
  type TablePresetField,
  type TablePresetSettings,
  type TablePresetStructure,
} from "../../features/table-presets/preset-model.ts";
import { FIELD_TYPE_LABELS } from "../memory/table-list-model.ts";
import { formatDisplayTime } from "../shell/space-info.ts";

/**
 * 表格预设设置区的纯逻辑模型（纯函数，spec 6.1–6.3）：预设库行、结构预览、
 * 初始化来源标签、应用按钮与确认文案。组件只渲染这些视图模型。
 */

// ---- 预设库列表 ----

export interface TablePresetRowViewModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 系统自带预设：不可删除、重命名或覆盖，可复制为用户预设 */
  readonly builtIn: boolean;
  readonly isDefault: boolean;
  readonly tableCount: number;
  readonly fieldCount: number;
}

export function tablePresetRows(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
): readonly TablePresetRowViewModel[] {
  return listTablePresets(settings, systemPreset).map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    builtIn: preset.builtIn,
    isDefault: preset.id === settings.defaultPresetId,
    tableCount: preset.tables.length,
    fieldCount: preset.tables.reduce((total, table) => total + table.fields.length, 0),
  }));
}

/** 预设选择器选项（新空间默认选择与当前空间应用目标共用）。 */
export function tablePresetOptions(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
): readonly { readonly id: string; readonly label: string }[] {
  return listTablePresets(settings, systemPreset).map((preset) => ({
    id: preset.id,
    label: preset.builtIn ? `${preset.name}（系统自带）` : preset.name,
  }));
}

/** 设置分组摘要行（折叠态）：用户预设数 + 默认预设名。 */
export function tablePresetsSummary(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
): string {
  const defaultName = listTablePresets(settings, systemPreset).find(
    (preset) => preset.id === settings.defaultPresetId,
  )?.name;
  return `${settings.userPresets.length}个用户预设 · 默认:${defaultName ?? SYSTEM_TABLE_PRESET_NAME}`;
}

// ---- 结构预览（只读） ----

export interface PresetPreviewFieldViewModel {
  readonly key: string;
  readonly name: string;
  readonly typeLabel: string;
  readonly required: boolean;
  readonly enabled: boolean;
  /** 字段填写 Prompt（无则空串） */
  readonly prompt: string;
  /** 配置摘要：选项 / 引用目标 / 长度上限 / 格式校验 */
  readonly detail: string;
}

export interface PresetPreviewTableViewModel {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly prompt: string;
  readonly fieldCount: number;
  readonly fields: readonly PresetPreviewFieldViewModel[];
}

export interface PresetPreviewViewModel {
  readonly description: string;
  readonly tables: readonly PresetPreviewTableViewModel[];
}

export interface PresetPreviewInput extends TablePresetStructure {
  readonly description: string;
}

/** 结构预览：说明 + 表名 + 字段数量 + 字段定义与填写规则详情（spec 6.2）。 */
export function presetPreviewViewModel(preset: PresetPreviewInput): PresetPreviewViewModel {
  const tableNameByKey = new Map(preset.tables.map((table) => [table.key, table.name]));
  return {
    description: preset.description,
    tables: preset.tables.map((table) => ({
      key: table.key,
      name: table.name,
      description: table.description,
      enabled: table.enabled,
      prompt: table.prompt,
      fieldCount: table.fields.length,
      fields: table.fields.map((field) => ({
        key: field.key,
        name: field.name,
        typeLabel: FIELD_TYPE_LABELS[field.type],
        required: field.required,
        enabled: field.enabled,
        prompt: field.prompt,
        detail: fieldDetail(field, tableNameByKey),
      })),
    })),
  };
}

function fieldDetail(field: TablePresetField, tableNameByKey: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  if (field.referenceTableKey) {
    parts.push(`引用：${tableNameByKey.get(field.referenceTableKey) ?? field.referenceTableKey}`);
  }
  if (field.options.length > 0) parts.push(`选项：${field.options.join(" / ")}`);
  if (field.maxChars !== null) parts.push(`上限 ${field.maxChars} 字`);
  if (field.valuePattern) parts.push(`格式校验：${field.valuePattern}`);
  return parts.join(" · ");
}

// ---- 当前空间应用区 ----

/** 初始化来源标签：有来源显示预设名称快照与时间；没有来源不推断（spec 6.2）。 */
export function initializationSourceLabel(space: MemorySpace | undefined): string {
  if (!space) return "无活动记忆空间";
  const source = space.initializationSource;
  if (!source) return "初始化来源未记录";
  return `初始化自：${source.presetName}（${formatDisplayTime(source.appliedAt)}）`;
}

/** 应用按钮与确认标题：目标 ID 与来源 ID 相同时用「按此预设重新初始化」（spec 6.2）。 */
export function applyPresetActionLabel(
  space: MemorySpace | undefined,
  targetPresetId: string | undefined,
): string {
  if (!space || targetPresetId === undefined) return "应用到当前空间";
  return space.initializationSource?.presetId === targetPresetId
    ? "按此预设重新初始化"
    : "应用到当前空间";
}

/** 应用确认文案（spec 6.3 推荐文案：空间名 + 目标预设名 + 删除范围 + 备份提醒）。 */
export function applyPresetConfirmText(spaceName: string, presetName: string): string {
  return [
    `应用「${presetName}」到「${spaceName}」？`,
    "",
    "当前空间的全部表结构、记录、修订历史、证据、填表任务、同步进度和问答历史将被清空，当前对话级宏也将被清除。空间将按所选预设重新创建，对话文件中的记忆镜像将被覆盖。聊天正文、全局设置和预设库保留。",
    "",
    "请先备份当前记忆空间，此操作无法撤销。",
  ].join("\n");
}

/** 应用前的最终确认标题（按此预设重新初始化时用同一判定）。 */
export function applyPresetConfirmTitle(
  space: MemorySpace | undefined,
  targetPresetId: string | undefined,
): string {
  return applyPresetActionLabel(space, targetPresetId) === "按此预设重新初始化"
    ? "按此预设重新初始化"
    : "应用到当前空间";
}

/** 覆盖操作确认文案（明确目标预设，说明已有空间不受影响）。 */
export function overwritePresetConfirmText(presetName: string): string {
  return `用当前表结构覆盖预设「${presetName}」？预设 ID 与默认选择保持不变，已有记忆空间不受影响。`;
}

/** 删除操作确认文案（说明已有空间不受影响；来源名称快照保留）。 */
export function deletePresetConfirmText(presetName: string, isDefault: boolean): string {
  const defaultNote = isDefault
    ? "该预设当前是新空间默认预设，删除后默认选择回到「系统默认」。"
    : "";
  return `删除预设「${presetName}」？已有记忆空间不会受到影响（空间记录的初始化来源名称快照继续保留）。${defaultNote}`;
}

/** 删除用户预设不可用（系统自带预设）的提示。 */
export const BUILTIN_PRESET_READONLY_HINT =
  "系统自带预设不可删除、重命名或覆盖；可复制为用户预设后修改。";

/** 另存为预设的说明（spec 5.1：仅保存表结构与填写规则）。 */
export const SAVE_PRESET_HINT = "仅保存表结构和填写规则，不包含记录；空间备份请使用导出备份。";

/** 当前空间应用区的空态说明（无活动空间/插件停用/空间正在重建）。 */
export function applyPresetUnavailableReason(input: {
  readonly pluginEnabled: boolean;
  readonly hasActiveSpace: boolean;
}): string | undefined {
  if (!input.pluginEnabled) return "插件已停用，无法应用预设";
  if (!input.hasActiveSpace) return "当前对话没有活动的记忆空间";
  return undefined;
}
