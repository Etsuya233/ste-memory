import type { MemorySpaceId } from "@ste-memory/core/memory";

/**
 * 填表任务状态（ticket 14 完整生命周期）：
 * - queued → running：提交后立即进入运行（唯一索引兜底并发冲突）；
 * - running → pause_requested → paused：暂停请求先记状态，任务循环在安全点应用；
 * - paused → running：恢复请求（resume）；
 * - 任意非终态 → cancel_requested → cancelled：中止请求同样在安全点应用；
 * - running → succeeded / failed：自然完成或块失败；
 * - 任意非终态 → interrupted：API 重启时标记，不自动重放。
 */
export type FillTaskStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted";

/** 终态：不再占用活动名额，不再被任务循环处理。 */
export const FILL_TASK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly FillTaskStatus[];

export function isFillTaskTerminal(status: FillTaskStatus): boolean {
  return (FILL_TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface FillTask {
  readonly runId: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly from: number;
  readonly to: number;
  readonly blockSize: number;
  readonly status: FillTaskStatus;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 轮询视图：任务行 + 实时进度（processedCount 由消息表统计，totalCount = 范围大小）。 */
export interface FillTaskView extends FillTask {
  readonly processedCount: number;
  readonly totalCount: number;
}

/**
 * 逐消息填表状态（ticket 17 覆盖视图）：
 * - processed：已跑过（status = processed）；
 * - in_task：任务中待跑（untracked 且落在活动任务范围 [from, to] 内）；
 * - error：错误（status = error，无论是否在活动任务范围内）；
 * - unplanned：没计划（其余 untracked，从未被任何活动任务覆盖）。
 */
export type MessageFillState = "processed" | "in_task" | "error" | "unplanned";

/** 覆盖视图：全部消息的四态分类（source_id 升序），供填表任务界面渲染逐消息矩阵。 */
export interface FillTaskCoverageView {
  readonly states: readonly { readonly sourceId: number; readonly state: MessageFillState }[];
}

export interface FillTaskRepository {
  create(task: FillTask): Promise<void>;
  /** 当前非终态任务（status 不是终态）；每个记忆空间最多一个。 */
  findActive(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined>;
  find(runId: string): Promise<FillTask | undefined>;
  /** queued → running（提交后立即，占用活动名额）。 */
  markRunning(runId: string): Promise<void>;
  /** pause_requested → paused（任务循环在安全点应用暂停）。 */
  markPaused(runId: string): Promise<void>;
  /** cancel_requested → cancelled（任务循环在安全点应用中止）。 */
  markCancelled(runId: string): Promise<void>;
  markSucceeded(runId: string): Promise<void>;
  markFailed(runId: string, errorMessage: string): Promise<void>;
  /** 启动时把全部非终态任务标记为 interrupted（API 重启，不自动重放）。 */
  markInterruptedOnStartup(): Promise<void>;
  /** 请求暂停：仅 running → pause_requested；状态不允许时返回 false。 */
  requestPause(runId: string): Promise<boolean>;
  /** 请求中止：任意非终态（含 paused/pause_requested）→ cancel_requested；已请求/终态返回 false。 */
  requestCancel(runId: string): Promise<boolean>;
  /** 恢复：仅 paused → running；状态不允许时返回 false。 */
  resume(runId: string): Promise<boolean>;
}
