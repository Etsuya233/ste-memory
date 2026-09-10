import { Dexie, type Table } from "dexie";
import type { LogEntry } from "../logging/log.ts";

/** 通用日志独立库默认名称（ADR 0015：与记忆主库分离，纯本地）。 */
export const ST_MEMORY_LOG_DB_NAME = "ste-memory-logs";

/**
 * 通用日志独立数据库（ADR 0015）：日志从记忆主库迁出，单独成库。
 *
 * - logs：`++id` 自增主键（插入顺序 = 时间顺序，修剪删最旧）；`key` 索引供
 *   按任务 runId 查询（同 key 内时间倒序由主键排序 reverse 保证）。
 * - 无记忆空间字段：日志独立于记忆空间，不做空间过滤、不做删除空间级联。
 * - 独立库天然不进云同步 / 备份 / 对话文件镜像（三者只读记忆主库）。
 */
export class SteMemoryLogDatabase extends Dexie {
  logs!: Table<LogEntry, number>;

  constructor(name: string = ST_MEMORY_LOG_DB_NAME) {
    super(name);
    this.version(1).stores({
      logs: "++id, key",
    });
  }
}
