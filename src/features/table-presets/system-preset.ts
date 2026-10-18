import { SYSTEM_TABLE_TEMPLATES } from "../memory/index.ts";
import {
  SYSTEM_TABLE_PRESET_ID,
  SYSTEM_TABLE_PRESET_NAME,
  type ResolvedTablePreset,
} from "./preset-model.ts";

/**
 * 系统自带预设「系统默认」（spec 4.1）：内容由插件模板计算，不落库——插件升级
 * 改变模板时只影响之后基于该内容初始化的空间，已有空间保持原样。
 * 表顺序即模板顺序，字段顺序即模板顺序（显式顺序由此写入空间）。
 */
export const SYSTEM_TABLE_PRESET: ResolvedTablePreset = {
  id: SYSTEM_TABLE_PRESET_ID,
  name: SYSTEM_TABLE_PRESET_NAME,
  description:
    "插件自带的默认表格结构，包含人物、人际关系、地点、物品、剧情、伏笔、待办与世界状态。",
  builtIn: true,
  tables: SYSTEM_TABLE_TEMPLATES.map((template) => ({
    key: template.key,
    name: template.name,
    description: template.description,
    prompt: template.prompt,
    enabled: true,
    displayStrategy: template.displayStrategy,
    fields: template.fields.map((field) => ({
      key: field.key,
      name: field.name,
      type: field.type,
      required: field.required,
      prompt: field.prompt,
      enabled: true,
      options: field.options,
      referenceTableKey: field.referenceTableKey,
      maxChars: field.maxChars,
      valuePattern: field.valuePattern ?? null,
      valuePatternMessage: field.valuePatternMessage ?? null,
    })),
  })),
};
