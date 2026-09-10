/**
 * 通用日志领域类型与端口（ADR 0015）。
 *
 * - 独立于记忆数据的审计日志：存放在独立数据库，不参与云同步、备份与对话
 *   文件镜像，也不随记忆空间删除级联（行内无 spaceId）。
 * - `text` 是不透明文本：内容由写入方自行组织（填表日志写 Pretty JSON），
 *   查询侧原样展示、不解析任何业务结构。
 * - level 由各类型写入时标注，仅用于展示与过滤，不承担领域语义。
 */
export type LogLevel = "info" | "warn" | "error";

/** 日志行（Dexie 自增主键 id；插入顺序即时间顺序，修剪删最旧）。 */
export interface LogEntry {
  readonly id: number;
  readonly type: string;
  /** 语义由各日志类型自行定义（填表 = 任务 runId） */
  readonly key: string;
  readonly level: LogLevel;
  /** 不透明文本载荷（写入方组织，查询侧零解析） */
  readonly text: string;
  readonly createdAt: string;
}

export interface LogAppendInput {
  readonly type: string;
  readonly key: string;
  readonly level: LogLevel;
  readonly text: string;
}

/** 独立日志仓库：追加（含全局条数上限修剪）+ 最近/按 key 查询（时间倒序）+ 清空。 */
export interface LogRepository {
  /** 追加一条日志；超出全局上限时同一事务删除最旧条目。 */
  append(input: LogAppendInput): Promise<void>;
  /** 全部类型最近 limit 条（插入顺序倒序，= 时间倒序；日志浏览默认视图）。 */
  recent(limit: number): Promise<readonly LogEntry[]>;
  /** 指定 key 最近 limit 条（插入顺序倒序，= 时间倒序）。 */
  byKey(key: string, limit: number): Promise<readonly LogEntry[]>;
  /** 清空全部日志（用户手动清空入口）。 */
  clearAll(): Promise<void>;
}
