/**
 * 系统表模板共享包（ADR 0020）。
 *
 * 七张系统表 + 世界状态表的字段、固定选项与 v4 提示词，以及系统表安装器，
 * 由 apps/api 与 apps/st-extension 共用，杜绝双份漂移。
 *
 * 边界：仅限无宿主依赖的纯资产。清洗规则变换、填表任务状态机等不收编。
 * 模板仍属宿主资产，core 只区分系统表 kind（词汇表语义不变）。
 */
export {
  SYSTEM_TABLE_PROMPTS,
  SYSTEM_FIELD_PROMPTS,
} from "./system-memory-table-prompts.ts";
export {
  SYSTEM_TABLE_TEMPLATES,
  SystemMemoryTableInstaller,
} from "./system-memory-table-definitions.ts";
export type {
  SystemMemoryTableKey,
  FieldTemplate,
  TableTemplate,
} from "./system-memory-table-definitions.ts";
