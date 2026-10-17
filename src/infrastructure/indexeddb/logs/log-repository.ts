import type { LogAppendInput, LogEntry, LogRepository } from "../../../features/logging/log.ts";
import type { SteMemoryLogDatabase } from "./log-database.ts";

import { LOG_LIMIT } from "../../../features/logging/log.ts";

export { LOG_LIMIT };

/**
 * 通用日志仓库（独立数据库）的 Dexie 实现（ADR 0015）。
 *
 * - 行排序：自增主键倒序 = 插入顺序倒序（= 时间倒序）；
 * - 修剪：append 后计数超限时按 id 升序删最旧（同一事务，追加与修剪原子）；
 * - 无空间维度：不提供 byType/bySpace（类型/级别过滤由查询侧在结果上内存完成）。
 */
export class DexieLogRepository implements LogRepository {
  readonly #db: SteMemoryLogDatabase;
  readonly #limit: number;
  readonly #now: () => string;

  constructor(
    db: SteMemoryLogDatabase,
    options: { readonly limit?: number; readonly now?: () => string } = {},
  ) {
    this.#db = db;
    this.#limit = options.limit ?? LOG_LIMIT;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async append(input: LogAppendInput): Promise<void> {
    await this.#db.transaction("rw", this.#db.logs, async () => {
      // id 为自增主键，由数据库生成；add 的类型需要整行，这里省略 id
      const row = {
        type: input.type,
        key: input.key,
        level: input.level,
        text: input.text,
        createdAt: this.#now(),
      } satisfies Omit<LogEntry, "id">;
      await this.#db.logs.add(row as LogEntry);
      const count = await this.#db.logs.count();
      if (count > this.#limit) {
        const excess = count - this.#limit;
        const oldestIds = await this.#db.logs.orderBy("id").limit(excess).primaryKeys();
        await this.#db.logs.bulkDelete(oldestIds);
      }
    });
  }

  async recent(limit: number): Promise<readonly LogEntry[]> {
    // 自增主键倒序 = 插入顺序倒序（= 时间倒序），无需索引
    return this.#db.logs.orderBy("id").reverse().limit(limit).toArray();
  }

  async byKey(key: string, limit: number): Promise<readonly LogEntry[]> {
    // key 索引内按主键排序（同 key 的行），reverse = 插入顺序倒序
    return this.#db.logs.where("key").equals(key).reverse().limit(limit).toArray();
  }

  async clearAll(): Promise<void> {
    await this.#db.logs.clear();
  }
}
