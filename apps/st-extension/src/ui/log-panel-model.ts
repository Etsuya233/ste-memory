/**
 * 日志 Tab 的纯逻辑 seam（ADR 0008）：过滤状态、主查询维度选择、内存过滤、
 * 列表视图模型与类型专属摘要。组件只做「模型 → DOM」投影，本模块独立测试。
 *
 * 数据流：仓库按主维度拉取（key 搜索 → 按 key；否则当前空间 → 按空间；
 * 否则全局最近），列表视图模型在结果上叠加内存过滤（type/level/key 子串）。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { LogEntry, LogLevel } from "../logging/log.ts";
import { FILL_RUN_LOG_TYPE, type FillRunRecord } from "../fill-tasks/fill-run-log.ts";
import { formatSyncTime } from "./space-info.ts";

export interface LogPanelFilters {
  /** 日志类型（null = 全部） */
  readonly type: string | null;
  /** 记忆空间（null = 全部空间；面板默认绑定当前空间） */
  readonly spaceId: MemorySpaceId | null;
  /** 级别（null = 全部） */
  readonly level: LogLevel | null;
  /** key 文本搜索（子串匹配，大小写不敏感） */
  readonly key: string;
}

/** 默认过滤：绑定当前空间，无类型/级别/搜索限制。 */
export function defaultLogFilters(spaceId: MemorySpaceId | null): LogPanelFilters {
  return { type: null, spaceId, level: null, key: "" };
}

/**
 * 主查询维度：key 非空 → 按 key（全局搜索后内存收窄）；否则有空间 → 按空间；
 * 否则全局最近。level/type 始终为内存过滤（1000 条上限内可接受，不扩索引）。
 */
export function logQueryKind(filters: LogPanelFilters): "key" | "space" | "recent" {
  if (filters.key.trim() !== "") return "key";
  if (filters.spaceId !== null) return "space";
  return "recent";
}

/** 内存过滤：叠加 type/spaceId/level/key 子串；输入顺序（时间倒序）保持不变。 */
export function applyLogFilters(
  entries: readonly LogEntry[],
  filters: LogPanelFilters,
): readonly LogEntry[] {
  const key = filters.key.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (filters.type === null || entry.type === filters.type) &&
      (filters.spaceId === null || entry.spaceId === filters.spaceId) &&
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

/** 运行记录状态显示名（摘要与详情共用）。 */
export const FILL_RUN_STATUS_LABELS: Readonly<Record<FillRunRecord["status"], string>> = {
  succeeded: "成功",
  failed: "失败",
  interrupted: "中断",
};

/**
 * 类型专属摘要行：fill = 「楼层 x–y · N 轮 · 状态」；未知类型或数据损坏
 * 返回空串（查看器不因旧/坏数据崩溃）。
 */
export function logEntrySummary(entry: LogEntry): string {
  if (entry.type !== FILL_RUN_LOG_TYPE) return "";
  const run = entry.data;
  if (run === null || typeof run !== "object" || !("block" in run)) return "";
  const record = run as Partial<FillRunRecord>;
  const block = record.block;
  if (block === undefined || !Number.isInteger(block.from) || !Number.isInteger(block.to)) {
    return "";
  }
  const statusLabel =
    record.status !== undefined ? FILL_RUN_STATUS_LABELS[record.status] ?? "未知" : "未知";
  return `楼层 ${block.from}–${block.to} · ${Array.isArray(record.rounds) ? record.rounds.length : 0} 轮 · ${statusLabel}`;
}

export interface LogListItemViewModel {
  readonly id: number;
  readonly type: string;
  readonly key: string;
  readonly level: LogLevel;
  /** 创建时间（ISO → "YYYY-MM-DD HH:mm"，与任务历史同格式） */
  readonly timeText: string;
  /** 类型专属摘要行（未知类型为空串） */
  readonly summary: string;
}

/** 列表视图模型：内存过滤 + 字段投影（顺序保持仓库返回的时间倒序）。 */
export function buildLogListViewModel(
  entries: readonly LogEntry[],
  filters: LogPanelFilters,
): readonly LogListItemViewModel[] {
  return applyLogFilters(entries, filters).map((entry) => ({
    id: entry.id,
    type: entry.type,
    key: entry.key,
    level: entry.level,
    timeText: formatSyncTime(entry.createdAt),
    summary: logEntrySummary(entry),
  }));
}
