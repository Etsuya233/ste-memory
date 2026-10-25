import type { MemorySpaceId } from "../../../features/memory/index.ts";
import type {
  FillTask,
  FillTaskRepository,
  FloorLedgerEntry,
  FloorLedgerRepository,
} from "../../../features/fill-tasks/fill-task.ts";
import type { FloorLedgerRow, SteMemoryDatabase } from "../database.ts";

/**
 * 旧任务行兼容（初始化填表新增 kind/initText 字段前的行）：缺省视为楼层填表任务
 * （kind: "floor"、initText: null）。IndexedDB 行是动态对象，旧行不迁移、读取时
 * 补齐默认——状态转换写回时也保留补齐后的字段，旧数据行为不变。
 */
export function normalizeTaskRow(row: FillTask): FillTask {
  if (row.kind === "init") {
    return { ...row, kind: "init", initText: row.initText };
  }
  return { ...row, kind: "floor", initText: null };
}

/**
 * 填表任务 + 楼层进度台账的 Dexie 实现（ticket 13，ADR 0002）。
 *
 * - 任务行状态转换带守卫（仅 running → 终态）：取消与完成竞态下先落地者胜出，
 *   已取消的任务不会被循环改写为 succeeded/failed——与「用户取消落为 interrupted、
 *   不自动重放」语义一致。守卫用「事务内读 + 条件写」实现（IndexedDB 事务按
 *   表作用域串行，两个并发转换不会交错）。
 * - 楼层台账按（记忆空间, 同步楼层）唯一（`&[memorySpaceId+floor]`），
 *   markProcessed/markError 都是 upsert：error 被后续成功覆盖（可重试语义）；
 *   untracked = 无行，statuses() 查询时补齐。
 */

/** 楼层台账行 id：`${memorySpaceId}:${floor}`（唯一索引键的一部分，防跨空间冲突）。 */
function ledgerRowId(memorySpaceId: MemorySpaceId, floor: number): string {
  return `${memorySpaceId}:${floor}`;
}

/** 任务行排序：createdAt 倒序（id 兜底，保证确定性）——活动任务与最近列表共用。 */
function byCreatedAtDesc(left: FillTask, right: FillTask): number {
  return right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId);
}

export class DexieFloorLedgerRepository implements FloorLedgerRepository {
  readonly #db: SteMemoryDatabase;
  readonly #now: () => string;

  constructor(db: SteMemoryDatabase, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  async markProcessed(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void> {
    await this.#upsert(memorySpaceId, floors, "processed");
  }

  async markError(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void> {
    await this.#upsert(memorySpaceId, floors, "error");
  }

  async statuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]> {
    const rows = await this.#db.floorFillLedger
      .where("[memorySpaceId+floor]")
      // Dexie 4.4：between 默认上界开（includeUpper === true 才闭），闭区间必须显式传 true, true
      .between([memorySpaceId, from], [memorySpaceId, to], true, true)
      .toArray();
    const byFloor = new Map(rows.map((row) => [row.floor, row.status]));
    const entries: FloorLedgerEntry[] = [];
    for (let floor = from; floor <= to; floor += 1) {
      entries.push({ floor, status: byFloor.get(floor) ?? "untracked" });
    }
    return entries;
  }

  async processedCount(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<number> {
    const statuses = await this.statuses(memorySpaceId, from, to);
    return statuses.filter((entry) => entry.status === "processed").length;
  }

  async deleteStatuses(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<void> {
    await this.#db.floorFillLedger
      .where("[memorySpaceId+floor]")
      .between([memorySpaceId, from], [memorySpaceId, to], true, true)
      .delete();
  }

  /** 清除空间记录/重置空间（spec reset-space）：删除该空间全部台账行。 */
  async clear(memorySpaceId: MemorySpaceId): Promise<void> {
    await this.#db.floorFillLedger.where("memorySpaceId").equals(memorySpaceId).delete();
  }

  async #upsert(
    memorySpaceId: MemorySpaceId,
    floors: readonly number[],
    status: Exclude<FloorLedgerEntry["status"], "untracked">,
  ): Promise<void> {
    const updatedAt = this.#now();
    const rows: FloorLedgerRow[] = floors.map((floor) => ({
      id: ledgerRowId(memorySpaceId, floor),
      memorySpaceId,
      floor,
      status,
      updatedAt,
    }));
    await this.#db.floorFillLedger.bulkPut(rows);
  }
}

export class DexieFillTaskRepository implements FillTaskRepository {
  readonly #db: SteMemoryDatabase;
  readonly #now: () => string;

  constructor(db: SteMemoryDatabase, now: () => string = () => new Date().toISOString()) {
    this.#db = db;
    this.#now = now;
  }

  async create(task: FillTask): Promise<void> {
    await this.#db.memoryFillTasks.add(task);
  }

  async enqueue(task: FillTask, replaces?: string): Promise<FillTask> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const rows = await this.#db.memoryFillTasks
        .where("memorySpaceId")
        .equals(task.memorySpaceId)
        .toArray();
      const previous = replaces ? rows.find((row) => row.runId === replaces) : undefined;
      if (replaces && !previous?.blocksQueue) throw new Error("待重试任务已处理，请刷新任务列表");
      const queuePosition =
        previous?.queuePosition ??
        rows.reduce((max, row) => Math.max(max, row.queuePosition ?? 0), 0) + 1;
      if (previous) await this.#db.memoryFillTasks.update(previous.runId, { blocksQueue: false });
      const queued = { ...task, queuePosition };
      await this.#db.memoryFillTasks.add(queued);
      return queued;
    });
  }

  async pending(memorySpaceId: MemorySpaceId): Promise<readonly FillTask[]> {
    const rows = await this.#db.memoryFillTasks
      .where("memorySpaceId")
      .equals(memorySpaceId)
      .toArray();
    return rows
      .map(normalizeTaskRow)
      .filter((row) => row.status === "queued" || row.status === "running" || row.blocksQueue)
      .sort(
        (left, right) =>
          (left.queuePosition ?? 0) - (right.queuePosition ?? 0) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.runId.localeCompare(right.runId),
      );
  }

  async markRunning(runId: string): Promise<boolean> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.#db.memoryFillTasks.get(runId);
      if (task?.status !== "queued") return false;
      const head = (await this.pending(task.memorySpaceId))[0];
      if (head?.runId !== runId) return false;
      await this.#db.memoryFillTasks.update(runId, { status: "running", updatedAt: this.#now() });
      return true;
    });
  }

  async release(runId: string): Promise<void> {
    await this.#db.memoryFillTasks.update(runId, { blocksQueue: false });
  }

  async interruptPending(memorySpaceId: MemorySpaceId): Promise<readonly FillTask[]> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const pending = await this.pending(memorySpaceId);
      for (const task of pending) {
        await this.#db.memoryFillTasks.update(task.runId, {
          status: task.status === "failed" ? "failed" : "interrupted",
          blocksQueue: false,
          updatedAt: this.#now(),
        });
      }
      return pending;
    });
  }

  async findActive(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined> {
    const rows = await this.#db.memoryFillTasks
      .where("memorySpaceId")
      .equals(memorySpaceId)
      .toArray();
    const active = rows
      .map(normalizeTaskRow)
      .filter((row) => row.status === "running")
      .sort(byCreatedAtDesc);
    return active[0];
  }

  async find(runId: string): Promise<FillTask | undefined> {
    const row = await this.#db.memoryFillTasks.get(runId);
    return row === undefined ? undefined : normalizeTaskRow(row);
  }

  async markSucceeded(runId: string): Promise<boolean> {
    return this.#transition(runId, "succeeded", null);
  }

  async markFailed(runId: string, errorMessage: string): Promise<boolean> {
    return this.#transition(runId, "failed", errorMessage);
  }

  async markInterrupted(runId: string, reason?: "chat-changed"): Promise<boolean> {
    return this.#transition(runId, "interrupted", null, reason);
  }

  /** 启动时把 running 任务标记 interrupted 并阻塞，queued 任务保留，
   *  并返回被中断的任务行（调用方据其写入中断结束日志）。 */
  async markInterruptedOnStartup(): Promise<readonly FillTask[]> {
    const interrupted: FillTask[] = [];
    await this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const rows = await this.#db.memoryFillTasks.toArray();
      for (const row of rows) {
        if (row.status !== "running") continue;
        const updated = {
          ...normalizeTaskRow(row),
          status: "interrupted" as const,
          blocksQueue: true,
          updatedAt: this.#now(),
        };
        await this.#db.memoryFillTasks.put(updated);
        interrupted.push(updated);
      }
    });
    return interrupted;
  }

  async listRecent(memorySpaceId: MemorySpaceId, limit: number): Promise<readonly FillTask[]> {
    const rows = await this.#db.memoryFillTasks
      .where("memorySpaceId")
      .equals(memorySpaceId)
      .toArray();
    return rows.map(normalizeTaskRow).sort(byCreatedAtDesc).slice(0, limit);
  }

  /** 清除空间记录/重置空间（spec reset-space）：删除该空间全部任务行（含历史条目）。 */
  async clear(memorySpaceId: MemorySpaceId): Promise<void> {
    await this.#db.memoryFillTasks.where("memorySpaceId").equals(memorySpaceId).delete();
  }

  /** 状态转换守卫：仅 running → 目标终态（事务内读改写，取消竞态先落地者胜出）。 */
  async #transition(
    runId: string,
    status: "succeeded" | "failed" | "interrupted",
    errorMessage: string | null,
    interruptionReason?: "chat-changed",
  ): Promise<boolean> {
    let applied = false;
    await this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const row = await this.#db.memoryFillTasks.get(runId);
      if (
        !row ||
        (row.status !== "running" && !(status === "interrupted" && row.status === "queued"))
      )
        return;
      await this.#db.memoryFillTasks.put({
        ...normalizeTaskRow(row),
        ...(interruptionReason ? { interruptionReason } : {}),
        status,
        blocksQueue: status === "failed" || interruptionReason === "chat-changed",
        errorMessage,
        updatedAt: this.#now(),
      });
      applied = true;
    });
    return applied;
  }
}
