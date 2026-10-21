import { STORY_MEMORY_PRESET } from "./story-memory-preset.ts";
import {
  DomainError,
  memorySummaryRules,
  type MemorySummaryRule,
  type MemoryFieldType,
} from "../memory/index.ts";

/**
 * 表格预设模型（spec 表格预设）：一整套可复用的表结构、字段、填写规则、引用
 * 关系和显示策略，不含记忆记录。
 *
 * - 预设结构用「表 Key + 字段 Key」表达引用目标与显示策略（不保存来源空间的
 *   实体 ID）；创建空间实例时由预设实例化生成新 ID 并转换引用。
 * - 系统自带预设（系统默认）不落库：由插件模板（SYSTEM_TABLE_TEMPLATES）在
 *   运行时计算——插件升级改变其内容时，仅影响之后基于该内容初始化的空间
 *   （spec 4.1）。
 * - 用户预设存全局插件设置（返回设置值而非就地修改；由设置面板写入）。
 */

/** 系统自带预设的稳定 ID（保留名，用户预设不可使用）。 */
export const SYSTEM_TABLE_PRESET_ID = "systemDefault";

/** 系统自带预设名称（保留名称，用户预设不可使用）。 */
export const SYSTEM_TABLE_PRESET_NAME = "系统默认";

/** 预设内一张表的结构（表 Key 在预设内唯一）。 */
export interface TablePresetTable {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly displayStrategy: TablePresetDisplayStrategy | null;
  readonly fields: readonly TablePresetField[];
}

/** 预设显示策略：字段与模板都写预设内字段 Key（实例化时换成空间内字段 ID）。 */
export type TablePresetDisplayStrategy =
  | { readonly type: "field"; readonly fieldKey: string }
  | { readonly type: "template"; readonly template: string };

/** 预设内一个字段的结构（字段 Key 在同一表内唯一）。 */
export interface TablePresetField {
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly options: readonly string[];
  /** 引用目标表的 Key（仅引用类字段有值；局限在预设内） */
  readonly referenceTableKey: string | null;
  readonly maxChars: number | null;
  readonly valuePattern: string | null;
  readonly valuePatternMessage: string | null;
}

/** 预设结构（系统预设与用户预设共用形态）。 */
export interface TablePresetStructure {
  readonly summaryRules?: readonly MemorySummaryRule[];
  /** 跨表填写规则；早期预设缺省为空。 */
  readonly prompt?: string;
  readonly tables: readonly TablePresetTable[];
}

/** 用户预设：结构 + 稳定 ID、名称、说明与创建/更新时间。 */
export interface TablePreset extends TablePresetStructure {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 解析后的可用预设：系统自带预设与用户预设统一成同一展示/应用形态。 */
export interface ResolvedTablePreset extends TablePresetStructure {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 系统自带预设：不可删除、重命名或覆盖，可复制为用户预设 */
  readonly builtIn: boolean;
}

/** 全局表格预设设置（存插件设置，不随对话切换）。 */
export interface TablePresetSettings {
  readonly userPresets: readonly TablePreset[];
  /** 新空间默认预设 ID（系统默认或某个用户预设） */
  readonly defaultPresetId: string;
}

export const DEFAULT_TABLE_PRESET_SETTINGS: TablePresetSettings = {
  userPresets: [],
  defaultPresetId: SYSTEM_TABLE_PRESET_ID,
};

/** 预设库中的全部预设（系统自带预设恒在首位）。 */
export function listTablePresets(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
): readonly ResolvedTablePreset[] {
  return [
    systemPreset,
    STORY_MEMORY_PRESET,
    ...settings.userPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      prompt: preset.prompt,
      summaryRules: preset.summaryRules,
      tables: preset.tables,
      builtIn: false,
    })),
  ];
}

/** 按 ID 取得用户预设或系统自带预设；未知 ID 明确报错。 */
export function resolveTablePreset(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
  presetId: string,
): ResolvedTablePreset {
  if (presetId === systemPreset.id) return systemPreset;
  if (presetId === STORY_MEMORY_PRESET.id) return STORY_MEMORY_PRESET;
  const userPreset = settings.userPresets.find((preset) => preset.id === presetId);
  if (!userPreset) {
    throw new DomainError({
      type: "table_preset_not_found",
      humanMsg: "预设不存在",
    });
  }
  return {
    id: userPreset.id,
    name: userPreset.name,
    description: userPreset.description,
    prompt: userPreset.prompt,
    summaryRules: userPreset.summaryRules,
    tables: userPreset.tables,
    builtIn: false,
  };
}

/** 新空间默认预设（创建全新记忆空间时使用）。 */
export function resolveDefaultTablePreset(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
): ResolvedTablePreset {
  return resolveTablePreset(settings, systemPreset, settings.defaultPresetId);
}

/** 预设名称规范化：去首尾空白后必须非空，且不得占用系统自带预设名称。 */
export function tablePresetName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new DomainError({
      type: "table_preset_name_required",
      humanMsg: "预设名称不能为空",
    });
  }
  if (name.length > 120) {
    throw new DomainError({
      type: "table_preset_name_too_long",
      param: { maxLength: 120 },
      humanMsg: "预设名称不能超过 120 个字符",
    });
  }
  if ([SYSTEM_TABLE_PRESET_NAME, STORY_MEMORY_PRESET.name].includes(name)) {
    throw new DomainError({
      type: "table_preset_name_reserved",
      humanMsg: `「${name}」是系统自带预设名称，请改用其他名称`,
    });
  }
  return name;
}

/** 预设名称在预设库内唯一（重命名时排除自身）。 */
export function tablePresetNameAvailable(
  userPresets: readonly TablePreset[],
  name: string,
  exceptPresetId?: string,
): boolean {
  return !userPresets.some((preset) => preset.name === name && preset.id !== exceptPresetId);
}

/**
 * 合并持久化的预设设置：损坏的预设逐项丢弃（保留其余），默认选择指向不存在的
 * 预设时回退系统自带预设（与 Agent 预设设置同口径）。
 */
export function mergeTablePresetSettings(raw: unknown): TablePresetSettings {
  const source = isRecord(raw) ? raw : {};
  const userPresets: TablePreset[] = [];
  if (Array.isArray(source.userPresets)) {
    for (const item of source.userPresets) {
      const preset = mergeUserTablePreset(item);
      if (preset) userPresets.push(preset);
    }
  }
  const defaultPresetId =
    typeof source.defaultPresetId === "string" &&
    (source.defaultPresetId === SYSTEM_TABLE_PRESET_ID ||
      source.defaultPresetId === STORY_MEMORY_PRESET.id ||
      userPresets.some((preset) => preset.id === source.defaultPresetId))
      ? source.defaultPresetId
      : SYSTEM_TABLE_PRESET_ID;
  return { userPresets, defaultPresetId };
}

function mergeUserTablePreset(raw: unknown): TablePreset | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    raw.id === "" ||
    raw.id === SYSTEM_TABLE_PRESET_ID ||
    raw.id === STORY_MEMORY_PRESET.id ||
    typeof raw.name !== "string" ||
    !Array.isArray(raw.tables)
  ) {
    return undefined;
  }
  const tables: TablePresetTable[] = [];
  for (const item of raw.tables) {
    const table = mergePresetTable(item);
    if (table) tables.push(table);
  }
  return {
    id: raw.id,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    summaryRules: memorySummaryRules(raw.summaryRules),
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    tables,
  };
}

function mergePresetTable(raw: unknown): TablePresetTable | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.key !== "string" ||
    typeof raw.name !== "string" ||
    !Array.isArray(raw.fields)
  ) {
    return undefined;
  }
  const fields: TablePresetField[] = [];
  for (const item of raw.fields) {
    const field = mergePresetField(item);
    if (field) fields.push(field);
  }
  return {
    key: raw.key,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    enabled: raw.enabled !== false,
    displayStrategy: mergePresetDisplayStrategy(raw.displayStrategy, fields),
    fields,
  };
}

function mergePresetField(raw: unknown): TablePresetField | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.key !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.type !== "string"
  ) {
    return undefined;
  }
  return {
    key: raw.key,
    name: raw.name,
    type: raw.type as MemoryFieldType,
    required: raw.required === true,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    enabled: raw.enabled !== false,
    options: Array.isArray(raw.options)
      ? raw.options.filter((option): option is string => typeof option === "string")
      : [],
    referenceTableKey: typeof raw.referenceTableKey === "string" ? raw.referenceTableKey : null,
    maxChars: typeof raw.maxChars === "number" ? raw.maxChars : null,
    valuePattern: typeof raw.valuePattern === "string" ? raw.valuePattern : null,
    valuePatternMessage:
      typeof raw.valuePatternMessage === "string" ? raw.valuePatternMessage : null,
  };
}

/**
 * 显示策略合并：字段策略的字段 Key 必须仍在表内（字段被删则策略失效），
 * 模板策略原样保留（渲染层对未知占位符按现有读语义兜底）。
 */
function mergePresetDisplayStrategy(
  raw: unknown,
  fields: readonly TablePresetField[],
): TablePresetDisplayStrategy | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "field" && typeof raw.fieldKey === "string") {
    return fields.some((field) => field.key === raw.fieldKey)
      ? { type: "field", fieldKey: raw.fieldKey }
      : null;
  }
  if (raw.type === "template" && typeof raw.template === "string") {
    return { type: "template", template: raw.template };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
