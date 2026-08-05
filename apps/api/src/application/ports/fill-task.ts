import type { MemorySpaceId } from "@ste-memory/core/memory";

/** 填表任务状态（ticket 13 的最小集合；queued/paused/cancelled/interrupted 等状态机扩展见 ticket 14）。 */
export type FillTaskStatus = "running" | "succeeded" | "failed";

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

export interface FillTaskRepository {
  create(task: FillTask): Promise<void>;
  /** 当前非终态任务（status 不是 succeeded/failed）；每个记忆空间最多一个。 */
  findActive(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined>;
  markSucceeded(runId: string): Promise<void>;
  markFailed(runId: string, errorMessage: string): Promise<void>;
}
