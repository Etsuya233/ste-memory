/**
 * 系统表模板（ADR 0020）：七张系统表 + 世界状态表的字段、固定选项、显示策略与
 * v4 提示词。属 Memory 特性的一部分（模板是纯资产；安装经表格预设的实例化路径，
 * 见 features/table-presets）。
 */
export { SYSTEM_TABLE_PROMPTS, SYSTEM_FIELD_PROMPTS } from "./system-memory-table-prompts.ts";
export { SYSTEM_TABLE_TEMPLATES } from "./system-memory-table-definitions.ts";
export type {
  SystemMemoryTableKey,
  FieldTemplate,
  TableTemplate,
  TableTemplateDisplayStrategy,
} from "./system-memory-table-definitions.ts";
