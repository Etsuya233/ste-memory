import type { MemorySpaceId } from "@ste-memory/core/memory";

/**
 * 通用日志领域类型与端口（ADR 0008）。
 *
 * - 一张表承载所有日志类型：type 区分种类（填表运行记录等），key 的语义由
 *   各日志类型自行定义（填表 = 任务 runId），spaceId 可空（非空间日志）。
 * - level 由各类型写入时标注，仅用于展示与过滤，不承担领域语义。
 * - 日志是本地审计数据：不参与云同步、备份与对话文件镜像，空间删除时级联清理。
 */

export type LogLevel = "info" | "warn" | "error";

/** 日志行（Dexie 自增主键 id；插入顺序即时间顺序，修剪删最旧）。 */
export interface LogEntry {
  readonly id: number;
  readonly type: string;
  readonly key: string;
  readonly spaceId: MemorySpaceId | null;
  readonly level: LogLevel;
  /** 类型自定义的自由载荷（如填表运行记录）。 */
  readonly data: unknown;
  readonly createdAt: string;
}

export interface LogAppendInput {
  readonly type: string;
  readonly key: string;
  readonly spaceId?: MemorySpaceId | null;
  readonly level: LogLevel;
  readonly data: unknown;
}

/** 通用日志仓库：追加（含全局条数上限修剪）+ 按 type/key/spaceId 查询（时间倒序）。 */
export interface LogRepository {
  /** 追加一条日志；超出全局上限时同一事务删除最旧条目。 */
  append(input: LogAppendInput): Promise<void>;
  /** 指定类型最近 limit 条（createdAt 倒序，id 兜底）。 */
  byType(type: string, limit: number): Promise<readonly LogEntry[]>;
  /** 指定 key 最近 limit 条（createdAt 倒序，id 兜底）。 */
  byKey(key: string, limit: number): Promise<readonly LogEntry[]>;
  /** 指定记忆空间最近 limit 条（createdAt 倒序，id 兜底；spaceId 为 null 的行不匹配）。 */
  bySpace(spaceId: MemorySpaceId, limit: number): Promise<readonly LogEntry[]>;
  /** 全部类型最近 limit 条（插入顺序倒序，= 时间倒序；日志浏览默认视图）。 */
  recent(limit: number): Promise<readonly LogEntry[]>;
  /** 清空全部日志（用户手动清空入口）。 */
  clearAll(): Promise<void>;
}
