/**
 * 日志查询页的纯逻辑 seam（ADR 0015）：过滤状态、主查询维度选择、内存过滤与
 * 列表视图模型。组件只做「模型 → DOM」投影，本模块独立测试。
 *
 * 数据流：仓库按主维度拉取（Key 非空 → 按 Key；否则全局最近），列表视图模型
 * 在结果上叠加内存过滤（type/level/key 子串）。查询侧零业务解析：没有类型
 * 专属摘要、状态文案解码或结构折叠。
 */
import type { LogEntry, LogLevel } from "../logging/log.ts";
import {
  FILL_AGENT_LOG_TYPE,
  FILL_RUN_LOG_TYPE,
  FILL_TASK_LOG_TYPE,
} from "../fill-tasks/fill-log.ts";
import { formatSyncTime } from "./space-info.ts";

export interface LogPanelFilters {
  /** 日志类型（null = 全部；下拉硬编码填表三类） */
  readonly type: string | null;
  /** 级别（null = 全部） */
  readonly level: LogLevel | null;
  /** Key 文本（主查询维度 + 结果上子串过滤，大小写不敏感） */
  readonly key: string;
}

/** 默认过滤：无类型/级别/Key 限制。 */
export function defaultLogFilters(): LogPanelFilters {
  return { type: null, level: null, key: "" };
}

/** 主查询维度：Key 非空 → 按 Key；否则取最近 1000 行。 */
export function logQueryKind(filters: LogPanelFilters): "key" | "recent" {
  return filters.key.trim() !== "" ? "key" : "recent";
}

/** 内存过滤：叠加 type/level/key 子串；输入顺序（时间倒序）保持不变。 */
export function applyLogFilters(
  entries: readonly LogEntry[],
  filters: LogPanelFilters,
): readonly LogEntry[] {
  const key = filters.key.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filters.type === null || entry.type === filters.type) &&
      (filters.level === null || entry.level === filters.level) &&
      (key === "" || entry.key.toLowerCase().includes(key)),
  );
}

/** 级别显示名（列表徽标与过滤下拉共用）。 */
export const LOG_LEVEL_LABELS: Readonly<Record<LogLevel, string>> = {
  info: "信息",
  warn: "警告",
  error: "错误",
};

/** 类型过滤下拉选项：硬编码填表三类（ADR 0015，其他日志类型暂不接入）。 */
export const LOG_TYPE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: FILL_TASK_LOG_TYPE, label: "填表任务" },
  { value: FILL_RUN_LOG_TYPE, label: "填表批" },
  { value: FILL_AGENT_LOG_TYPE, label: "Agent 请求" },
];

/** 类型显示名；未知类型原样展示（查询侧不认识类型也照常显示）。 */
export function logTypeLabel(type: string): string {
  return LOG_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export interface LogListItemViewModel {
  readonly id: number;
  readonly type: string;
  readonly typeLabel: string;
  readonly key: string;
  readonly level: LogLevel;
  /** 创建时间（ISO → "YYYY-MM-DD HH:mm"，与任务历史同格式） */
  readonly timeText: string;
}

/** 列表视图模型：内存过滤 + 字段投影（顺序保持仓库返回的时间倒序）。 */
export function buildLogListViewModel(
  entries: readonly LogEntry[],
  filters: LogPanelFilters,
): readonly LogListItemViewModel[] {
  return applyLogFilters(entries, filters).map((entry) => ({
    id: entry.id,
    type: entry.type,
    typeLabel: logTypeLabel(entry.type),
    key: entry.key,
    level: entry.level,
    timeText: formatSyncTime(entry.createdAt),
  }));
}
