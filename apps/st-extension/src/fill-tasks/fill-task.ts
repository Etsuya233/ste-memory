import type { MemorySpaceId } from "@ste-memory/core/memory";

/**
 * 填表任务领域类型与端口（ticket 13）。
 *
 * 状态机（扩展侧简化版，api 的 queued/pause/cancel_requested 不进入本实现）：
 * - idle：无任务行（未提交过 / 全部终态）；
 * - running：任务已提交、后台块循环执行中；
 * - running → succeeded / failed：自然完成 / 块失败（携带可读错误信息）；
 * - running → interrupted：用户取消（立即落库，循环在安全点停止）或
 *   页面/浏览器重开（启动标记，不自动重放）。
 *
 * 楼层进度台账：按（记忆空间, 同步楼层）记录 processed / error 行，
 * **untracked = 无行**（消息全文不落库，楼层范围随时从 ST 对话实时读取；
 * api 的 untracked 是消息表的默认状态，本实现不物化）。块成功 markProcessed、
 * 块失败 markError（与 api 的 markProcessed/markError 同语义），
 * 触发 UI 的「未处理范围」与覆盖视图（14）都从台账计算。
 */

export type FillTaskStatus = "running" | "succeeded" | "failed" | "interrupted";

/** 终态：不再占用活动名额，不再被任务循环处理。 */
export const FILL_TASK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
] as const satisfies readonly FillTaskStatus[];

export function isFillTaskTerminal(status: FillTaskStatus): boolean {
  return (FILL_TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface FillTask {
  readonly runId: string;
  readonly memorySpaceId: MemorySpaceId;
  /** 楼层范围（闭区间；同步楼层 = ST 消息数组下标，0 基，ADR 0003） */
  readonly from: number;
  readonly to: number;
  readonly blockSize: number;
  /**
   * 提交时的对话身份（ST chatId；未保存对话为 null）。块开始前的安全点检查：
   * 对话已切换 → 楼层归属的对话已变化，任务失败停止（防止把新对话的消息
   * 写进旧空间的台账/记录）。未保存对话无法识别切换，跳过检查。
   */
  readonly chatId: string | null;
  readonly status: FillTaskStatus;
  /** 失败原因（可读中文；非 failed 为 null） */
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 任务视图：任务行 + 实时已处理计数（台账 processed 楼层数）+ 范围总楼层数。 */
export interface FillTaskView extends FillTask {
  readonly processedCount: number;
  readonly totalCount: number;
}

/** 楼层填表状态（语义与 api SourceMessageStatusValue 一致）。 */
export type FloorFillStatus = "untracked" | "processed" | "error";

export interface FloorLedgerEntry {
  readonly floor: number;
  readonly status: FloorFillStatus;
}

/** 填表任务消息来源：同步楼层（ST 消息数组下标）到消息原文的只读映射。 */
export interface FillSourceMessage {
  readonly floor: number;
  /** 消息正文原文（ST mes 字段，含格式化标记；清洗由 service 层套用，ADR 0011） */
  readonly content: string;
  /** 发送者名（角色名 / 用户侧显示名；缺失为空串） */
  readonly name: string;
}

export interface FillTaskSource {
  /** 当前对话消息总数（楼层上限 = chatLength - 1） */
  chatMessageCount(): number;
  /** 当前对话身份（ST chatId；未保存对话为 undefined）——块开始前对话切换检测 */
  chatId(): string | undefined;
  /** 闭区间 [from, to] 内的消息（楼层升序；越界/缺失楼层跳过——漂移接受，ADR 0003） */
  messagesInRange(from: number, to: number): readonly FillSourceMessage[];
}

export interface FloorLedgerRepository {
  /** 块成功：把楼层标记为 processed（覆盖既有 error，可重试语义）。 */
  markProcessed(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void>;
  /** 块失败：把出错块楼层标记为 error（最后一次运行出错，可重试）。 */
  markError(memorySpaceId: MemorySpaceId, floors: readonly number[]): Promise<void>;
  /** 闭区间 [from, to] 内全部楼层状态（无行 = untracked），floor 升序。 */
  statuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]>;
  /** 闭区间 [from, to] 内已 processed 楼层数（任务轮询进度）。 */
  processedCount(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<number>;
}

export interface FillTaskRepository {
  create(task: FillTask): Promise<void>;
  /**
   * 原子守卫创建（并发提交兜底）：空间内无活动任务才创建并返回 undefined；
   * 有活动任务时拒绝创建并返回该冲突任务（事务内检查 + 写入，防双提交竞态）。
   */
  createIfIdle(memorySpaceId: MemorySpaceId, task: FillTask): Promise<FillTask | undefined>;
  /** 当前非终态任务（单空间单活动任务守卫）；无则 undefined。 */
  findActive(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined>;
  find(runId: string): Promise<FillTask | undefined>;
  /** 仅 running → succeeded；状态不允许时返回 false（取消竞态兜底，不覆盖中断）。 */
  markSucceeded(runId: string): Promise<boolean>;
  /** 仅 running → failed（携带可读错误信息）；状态不允许时返回 false。 */
  markFailed(runId: string, errorMessage: string): Promise<boolean>;
  /** 仅 running → interrupted（用户取消）；状态不允许时返回 false。 */
  markInterrupted(runId: string): Promise<boolean>;
  /** 启动时把所有非终态任务标记 interrupted（页面/浏览器重开，不自动重放）。 */
  markInterruptedOnStartup(): Promise<void>;
  /** 最近任务（createdAt 倒序，id 兜底），供触发 UI 展示最近一次任务结果。 */
  listRecent(memorySpaceId: MemorySpaceId, limit: number): Promise<readonly FillTask[]>;
}

/** 提交冲突：该记忆空间已有非终态任务（守卫，失败原因可读）。 */
export class FillTaskConflictError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`该记忆空间已有正在进行的填表任务（${task.runId}），请等待其结束或取消后重试`);
    this.name = "FillTaskConflictError";
    this.task = task;
  }
}

/** 任务不存在或不属于该记忆空间。 */
export class FillTaskNotFoundError extends Error {
  constructor() {
    super("填表任务不存在");
    this.name = "FillTaskNotFoundError";
  }
}

/** 当前状态不允许该操作（如取消已终态任务）。 */
export class FillTaskStateError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`当前任务状态（${task.status}）不允许该操作`);
    this.name = "FillTaskStateError";
    this.task = task;
  }
}

/** 楼层范围/分块参数无效（如越界、from > to）。 */
export class FillTaskRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillTaskRangeError";
  }
}
