import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { type MemorySpaceId, type MemoryTableId, type MemoryFieldId } from "../memory/index.ts";
import { instantiateTablePreset } from "./preset-instantiation.ts";
import {
  listTablePresets,
  type ResolvedTablePreset,
  type TablePresetSettings,
  type TablePresetStructure,
} from "./preset-model.ts";
import { saveUserTablePreset } from "./table-preset-library.ts";

export const TABLE_PRESET_FORMAT = "ste-memory-table-preset";
export const TABLE_PRESET_VERSION = 1;

const nullableText = Type.Union([Type.String(), Type.Null()]);
const displayStrategySchema = Type.Union([
  Type.Null(),
  Type.Object(
    { type: Type.Literal("field"), fieldKey: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("template"), template: Type.String() },
    { additionalProperties: false },
  ),
]);
const fieldSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    type: Type.Enum([
      "short_text",
      "long_text",
      "short_text_list",
      "integer",
      "decimal",
      "boolean",
      "date",
      "datetime",
      "single_select",
      "multi_select",
      "single_reference",
      "multi_reference",
    ]),
    required: Type.Boolean(),
    prompt: Type.String(),
    enabled: Type.Boolean(),
    options: Type.Array(Type.String()),
    referenceTableKey: nullableText,
    maxChars: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    valuePattern: nullableText,
    valuePatternMessage: nullableText,
  },
  { additionalProperties: false },
);
const presetSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    prompt: Type.Optional(Type.String()),
    tables: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          name: Type.String(),
          description: Type.String(),
          prompt: Type.String(),
          enabled: Type.Boolean(),
          displayStrategy: displayStrategySchema,
          fields: Type.Array(fieldSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const fileSchema = Type.Object(
  {
    format: Type.Literal(TABLE_PRESET_FORMAT),
    version: Type.Literal(TABLE_PRESET_VERSION),
    exportedAt: Type.String(),
    preset: presetSchema,
  },
  { additionalProperties: false },
);

export type ImportedTablePreset = Static<typeof presetSchema>;

/** 文件只携带结构与规则；不携带记录、空间身份、预设身份或默认选择。 */
export function serializeTablePresetExport(
  preset: ResolvedTablePreset,
  exportedAt: string,
): string {
  return JSON.stringify(
    {
      format: TABLE_PRESET_FORMAT,
      version: TABLE_PRESET_VERSION,
      exportedAt,
      preset: {
        name: preset.name,
        description: preset.description,
        prompt: preset.prompt ?? "",
        tables: preset.tables,
      },
    },
    null,
    2,
  );
}

export function parseTablePresetExport(text: string): ImportedTablePreset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("表格预设文件不是有效的 JSON");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("format" in raw) ||
    raw.format !== TABLE_PRESET_FORMAT
  ) {
    throw new Error("这不是表格预设文件，请选择导出的表格预设 JSON");
  }
  if (!("version" in raw) || raw.version !== TABLE_PRESET_VERSION) {
    throw new Error(`表格预设文件版本不支持，当前支持 v${TABLE_PRESET_VERSION}`);
  }
  if (!Value.Check(fileSchema, raw)) {
    const issue = [...Value.Errors(fileSchema, raw)][0]!;
    throw new Error(`表格预设结构无效（${issue.instancePath}）：${issue.message}`);
  }
  const preset = raw.preset;
  if (!preset.name.trim() || preset.name.trim().length > 120)
    throw new Error("预设名称须为 1–120 个字符");
  // 引用和显示策略按实例化的真实规则校验，导入阶段失败不会写设置。
  const tableKeys = new Set<string>();
  for (const table of preset.tables) {
    if (table.key !== table.key.trim() || tableKeys.has(table.key))
      throw new Error(`表 Key 重复或含首尾空白：${table.key}`);
    tableKeys.add(table.key);
    const fieldKeys = new Set<string>();
    for (const field of table.fields) {
      if (field.key !== field.key.trim() || fieldKeys.has(field.key))
        throw new Error(`字段 Key 重复或含首尾空白：${table.key}.${field.key}`);
      fieldKeys.add(field.key);
    }
  }
  let nextId = 0;
  instantiateTablePreset(
    preset,
    "preset-validation" as MemorySpaceId,
    {
      table: () => `table-${++nextId}` as MemoryTableId,
      field: () => `field-${++nextId}` as MemoryFieldId,
    },
    "",
  );
  return preset;
}

/** 每次导入新建用户预设；重名追加编号，不覆盖、不切换默认、不应用到空间。 */
export function importTablePreset(
  settings: TablePresetSettings,
  systemPreset: ResolvedTablePreset,
  imported: ImportedTablePreset,
  input: { readonly id: string; readonly now: string },
): ReturnType<typeof saveUserTablePreset> {
  const presets = listTablePresets(settings, systemPreset);
  if (presets.some((preset) => preset.id === input.id)) {
    throw new Error("新预设 ID 已存在");
  }
  const names = new Set(presets.map((preset) => preset.name));
  const base = imported.name.trim();
  let name = base;
  for (let suffix = 2; names.has(name); suffix++) {
    const tail = ` (${suffix})`;
    name = base.slice(0, 120 - tail.length) + tail;
  }
  return saveUserTablePreset(settings, {
    ...input,
    name,
    description: imported.description,
    structure: { prompt: imported.prompt, tables: imported.tables } satisfies TablePresetStructure,
  });
}
