/**
 * 系统表模板（ADR 0020）：七张系统表 + 世界状态表的字段、固定选项与 v4
 * 提示词，以及系统表安装器。属 Memory 特性的一部分（安装走公开服务，
 * 模板是纯资产）。
 */
export { SYSTEM_TABLE_PROMPTS, SYSTEM_FIELD_PROMPTS } from "./system-memory-table-prompts.ts";
export {
  SYSTEM_TABLE_TEMPLATES,
  SystemMemoryTableInstaller,
} from "./system-memory-table-definitions.ts";
export type {
  SystemMemoryTableKey,
  FieldTemplate,
  TableTemplate,
} from "./system-memory-table-definitions.ts";
