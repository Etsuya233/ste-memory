/** 插件显示名（日志前缀、manifest 同源；避免 bootstrap ↔ runtime 循环依赖的共享常量） */
export const PLUGIN_DISPLAY_NAME = "STE Memory";

/** 同步楼层证据的来源类型（ADR 0003：source_id = ST 消息数组下标）；
 *  证据 chip（ui/evidence-chip-model）与填表任务（fill-tasks）共用，故上移到共享常量 */
export const EVIDENCE_FLOOR_SOURCE_TYPE = "sync_floor";
