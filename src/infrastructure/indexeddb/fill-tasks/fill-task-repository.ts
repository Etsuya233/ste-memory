import type { MemorySpaceId } from "../../../features/memory/index.ts";
import type {
  FillTask,
  FillTaskBatchResult,
  FillTaskRepository,
} from "../../../features/fill-tasks/fill-task.ts";
import type { SteMemoryDatabase } from "../database.ts";

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
 * 任务状态与批次提交归属由同一张表管理；SQLite 持有权威楼层进度。
 * 这里的阶段仅记录执行位置，不证明宿主文件已经保存。
 */

/** 任务行排序：createdAt 倒序（id 兜底，保证确定性）——活动任务与最近列表共用。 */
function byCreatedAtDesc(left: FillTask, right: FillTask): number {
  return right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId);
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
      if (replaces && !previous?.blocksQueue) {
        throw new Error("待重试任务已处理，请刷新任务列表");
      }
      const queuePosition =
        previous?.queuePosition ??
        rows.reduce((max, row) => Math.max(max, row.queuePosition ?? 0), 0) + 1;
      if (previous) {
        await this.#db.memoryFillTasks.update(previous.runId, { blocksQueue: false });
      }
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

  async beginBatchCommit(runId: string, batch: FillTaskBatchResult): Promise<boolean> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.find(runId);
      if (task?.status !== "running" || task.pendingCommit) {
        return false;
      }
      await this.#db.memoryFillTasks.put({ ...task, pendingCommit: batch, updatedAt: this.#now() });
      return true;
    });
  }

  async abandonBatchCommit(runId: string, batch: FillTaskBatchResult): Promise<void> {
    await this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.find(runId);
      if (task?.pendingCommit?.from !== batch.from || task.pendingCommit.to !== batch.to) {
        return;
      }
      const remaining = { ...task, pendingCommit: undefined };
      await this.#db.memoryFillTasks.put(remaining);
    });
  }

  async completeBatchCommit(
    runId: string,
    batch: FillTaskBatchResult,
  ): Promise<FillTask | undefined> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.find(runId);
      if (task?.pendingCommit?.from !== batch.from || task.pendingCommit.to !== batch.to) {
        return undefined;
      }
      const remaining = { ...task, pendingCommit: undefined };
      // 提交归执行循环；历史写入失败后不能根据本行重放已提交内容。
      const status =
        task.status === "running"
          ? "running"
          : batch.nextFrom === null
            ? "succeeded"
            : "interrupted";
      const completed: FillTask = {
        ...remaining,
        status,
        nextFrom: batch.nextFrom,
        blocksQueue: status === "interrupted",
        errorMessage: null,
        updatedAt: this.#now(),
      };
      await this.#db.memoryFillTasks.put(completed);
      return completed;
    });
  }

  async markRunning(runId: string): Promise<boolean> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.#db.memoryFillTasks.get(runId);
      if (task?.status !== "queued") {
        return false;
      }
      const head = (await this.pending(task.memorySpaceId))[0];
      if (head?.runId !== runId) {
        return false;
      }
      await this.#db.memoryFillTasks.update(runId, { status: "running", updatedAt: this.#now() });
      return true;
    });
  }

  async release(runId: string): Promise<void> {
    await this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const task = await this.find(runId);
      if (!task) {
        return;
      }
      const remaining = { ...task, pendingCommit: undefined };
      await this.#db.memoryFillTasks.put({ ...remaining, blocksQueue: false });
    });
  }

  async interruptPending(memorySpaceId: MemorySpaceId): Promise<readonly FillTask[]> {
    return this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const pending = await this.pending(memorySpaceId);
      for (const task of pending) {
        const remaining = { ...task, pendingCommit: undefined };
        await this.#db.memoryFillTasks.put({
          ...remaining,
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

  /** 页面重开时保留未完成提交归属；文件中的 SQLite 进度是唯一权威，不由辅助行推定。 */
  async markInterruptedOnStartup(): Promise<readonly FillTask[]> {
    const interrupted: FillTask[] = [];
    await this.#db.transaction("rw", this.#db.memoryFillTasks, async () => {
      const rows = await this.#db.memoryFillTasks.toArray();
      for (const row of rows) {
        if (row.status !== "running" && !row.pendingCommit) {
          continue;
        }
        const updated = {
          ...normalizeTaskRow(row),
          status: "interrupted" as const,
          blocksQueue: true,
          errorMessage: row.pendingCommit
            ? "批次提交结果待核对，请检查当前记忆；初始化可取消队列后重新决定"
            : row.errorMessage,
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
      ) {
        return;
      }
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
