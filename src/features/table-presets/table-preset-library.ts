import { DomainError } from "../memory/index.ts";
import {
  SYSTEM_TABLE_PRESET_ID,
  listTablePresets,
  tablePresetName,
  tablePresetNameAvailable,
  type ResolvedTablePreset,
  type TablePreset,
  type TablePresetSettings,
  type TablePresetStructure,
} from "./preset-model.ts";

/**
 * 预设库操作（纯函数，返回新的设置值；spec 5）：另存、重命名、覆盖、删除、复制
 * 与默认选择。全部操作只改预设库与默认选择：
 *
 * - 不触碰任何已有空间（编辑或删除预设不会改变已有空间）；
 * - 覆盖保留预设 ID（默认选择不变）；
 * - 删除默认用户预设时，在同一次设置更新中把默认选择改为系统自带预设；
 * - 系统自带预设不可删除、重命名或覆盖。
 */

/** 名称唯一性校验（预设库内唯一；系统自带预设名称保留）。 */
function validatedName(
  settings: TablePresetSettings,
  value: string,
  exceptPresetId?: string,
): string {
  const name = tablePresetName(value);
  if (!tablePresetNameAvailable(settings.userPresets, name, exceptPresetId)) {
    throw new DomainError({
      type: "table_preset_name_conflict",
      humanMsg: "预设库中已存在同名预设，请改用其他名称",
    });
  }
  return name;
}

function requireUserPreset(settings: TablePresetSettings, presetId: string): TablePreset {
  const preset = settings.userPresets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new DomainError({
      type: "table_preset_not_found",
      humanMsg: "该预设不存在（系统自带预设不能修改或删除）",
    });
  }
  return preset;
}

/** 另存当前表结构为新用户预设（spec 5.1）：始终新建，不覆盖、不设为默认、不改来源。 */
export function saveUserTablePreset(
  settings: TablePresetSettings,
  input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly structure: TablePresetStructure;
    readonly now: string;
  },
): { readonly settings: TablePresetSettings; readonly preset: TablePreset } {
  const preset: TablePreset = {
    id: input.id,
    name: validatedName(settings, input.name),
    description: input.description.trim(),
    createdAt: input.now,
    updatedAt: input.now,
    prompt: input.structure.prompt,
    tables: input.structure.tables,
  };
  return { settings: { ...settings, userPresets: [...settings.userPresets, preset] }, preset };
}

/** 重命名用户预设（含说明）：预设 ID 与结构内容不变。 */
export function renameUserTablePreset(
  settings: TablePresetSettings,
  presetId: string,
  input: { readonly name: string; readonly description: string; readonly now: string },
): TablePresetSettings {
  const preset = requireUserPreset(settings, presetId);
  const updated: TablePreset = {
    ...preset,
    name: validatedName(settings, input.name, presetId),
    description: input.description.trim(),
    updatedAt: input.now,
  };
  return {
    ...settings,
    userPresets: settings.userPresets.map((candidate) =>
      candidate.id === presetId ? updated : candidate,
    ),
  };
}

/** 用当前表结构覆盖用户预设（spec 5.2）：保留预设 ID（因此默认选择不变）。 */
export function overwriteUserTablePreset(
  settings: TablePresetSettings,
  presetId: string,
  input: { readonly structure: TablePresetStructure; readonly now: string },
): TablePresetSettings {
  const preset = requireUserPreset(settings, presetId);
  const updated: TablePreset = {
    ...preset,
    prompt: input.structure.prompt,
    tables: input.structure.tables,
    updatedAt: input.now,
  };
  return {
    ...settings,
    userPresets: settings.userPresets.map((candidate) =>
      candidate.id === presetId ? updated : candidate,
    ),
  };
}

/**
 * 删除用户预设（spec 5.3）：删除当前默认用户预设时，同一次设置更新把默认选择
 * 改为系统自带预设；已有空间与其来源名称快照不受影响。
 */
export function deleteUserTablePreset(
  settings: TablePresetSettings,
  presetId: string,
): TablePresetSettings {
  requireUserPreset(settings, presetId);
  return {
    userPresets: settings.userPresets.filter((preset) => preset.id !== presetId),
    defaultPresetId:
      settings.defaultPresetId === presetId ? SYSTEM_TABLE_PRESET_ID : settings.defaultPresetId,
  };
}

/** 复制预设为用户预设（spec 5.2：复制系统自带预设时生成内容一致的新用户预设）。 */
export function copyTablePresetAsUserPreset(
  settings: TablePresetSettings,
  source: ResolvedTablePreset,
  input: { readonly id: string; readonly name?: string; readonly now: string },
): { readonly settings: TablePresetSettings; readonly preset: TablePreset } {
  const preset: TablePreset = {
    id: input.id,
    name: validatedName(settings, input.name ?? `${source.name} 副本`),
    description: source.description,
    createdAt: input.now,
    updatedAt: input.now,
    prompt: source.prompt,
    tables: source.tables,
  };
  return { settings: { ...settings, userPresets: [...settings.userPresets, preset] }, preset };
}

/** 设置新空间默认预设（spec 6.1）：只影响之后创建的全新空间。 */
export function setDefaultTablePreset(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
  presetId: string,
): TablePresetSettings {
  if (!listTablePresets(settings, systemPreset).some((preset) => preset.id === presetId)) {
    throw new DomainError({
      type: "table_preset_not_found",
      humanMsg: "选择的预设不存在，请刷新后重试",
    });
  }
  return { ...settings, defaultPresetId: presetId };
}
