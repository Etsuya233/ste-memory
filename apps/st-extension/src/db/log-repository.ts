import { Dexie } from "dexie";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { LogAppendInput, LogEntry, LogRepository } from "../logging/log.ts";
import type { SteMemoryDatabase } from "./database.ts";

/** 全局日志条数上限（超出删最旧；对齐 apps/web 事件缓冲 1000 的先例）。 */
export const LOG_LIMIT = 1000;

/**
 * 通用日志仓库的 Dexie 实现（ADR 0008）。
 *
 * - 行排序：createdAt 倒序（id 兜底）——复合索引 [type+createdAt] / [spaceId+createdAt]
 *   的 reverse 游标即时间倒序，同 createdAt 的平局由主键（id）倒序兜底；
 * - 修剪：append 后计数超限时按 id 升序删最旧（同一事务，追加与修剪原子）。
 */
export class DexieLogRepository implements LogRepository {
  readonly #db: SteMemoryDatabase;
  readonly #limit: number;
  readonly #now: () => string;

  constructor(
    db: SteMemoryDatabase,
    options: { readonly limit?: number; readonly now?: () => string } = {},
  ) {
    this.#db = db;
    this.#limit = options.limit ?? LOG_LIMIT;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async append(input: LogAppendInput): Promise<void> {
    await this.#db.transaction("rw", this.#db.memoryLogs, async () => {
      // id 为自增主键，由数据库生成；add 的类型需要整行，这里省略 id
      const row = {
        type: input.type,
        key: input.key,
        spaceId: input.spaceId ?? null,
        level: input.level,
        data: input.data,
        createdAt: this.#now(),
      } satisfies Omit<LogEntry, "id">;
      await this.#db.memoryLogs.add(row as LogEntry);
      const count = await this.#db.memoryLogs.count();
      if (count > this.#limit) {
        const excess = count - this.#limit;
        const oldestIds = await this.#db.memoryLogs.orderBy("id").limit(excess).primaryKeys();
        await this.#db.memoryLogs.bulkDelete(oldestIds);
      }
    });
  }

  async byType(type: string, limit: number): Promise<readonly LogEntry[]> {
    return this.#byRange("[type+createdAt]", type, limit);
  }

  async byKey(key: string, limit: number): Promise<readonly LogEntry[]> {
    return this.#byRange("[key+createdAt]", key, limit);
  }

  async bySpace(spaceId: MemorySpaceId, limit: number): Promise<readonly LogEntry[]> {
    return this.#byRange("[spaceId+createdAt]", spaceId, limit);
  }

  async recent(limit: number): Promise<readonly LogEntry[]> {
    // 自增主键倒序 = 插入顺序倒序（= 时间倒序），无需索引
    return this.#db.memoryLogs.orderBy("id").reverse().limit(limit).toArray();
  }

  async clearAll(): Promise<void> {
    await this.#db.memoryLogs.clear();
  }

  /** 复合索引前缀范围查询 + reverse 游标 = 时间倒序（平局由主键倒序兜底）。 */
  async #byRange(index: "[type+createdAt]" | "[key+createdAt]" | "[spaceId+createdAt]", prefix: string, limit: number): Promise<readonly LogEntry[]> {
    return this.#db.memoryLogs
      .where(index)
      .between([prefix, Dexie.minKey], [prefix, Dexie.maxKey], true, true)
      .reverse()
      .limit(limit)
      .toArray();
  }
}
