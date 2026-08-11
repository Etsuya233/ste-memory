/**
 * 轮询评估骨架（ticket 17 抽取）：记忆宏服务与 Agent 预设宏服务共用的
 * 「排队评估 + 指纹轮询」机制——并发触发串行执行并收敛到最新状态、
 * 单轮异常不毒化队列、stop 后不再轮询。具体评估逻辑（注册/注销/快照重建）
 * 由调用方以 evaluate 回调提供。
 */
import type { SyncTimerPort } from "./cloud/sync-coordinator.ts";

export interface PollingEvaluatorOptions {
  /** 单轮评估：内部自行处理早退（停用/无活动空间）与定时器管理之外的逻辑 */
  readonly evaluate: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly timers: SyncTimerPort;
}

export class PollingEvaluator {
  readonly #evaluate: () => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #timers: SyncTimerPort;
  #pollTimer: unknown = undefined;
  #stopped = false;
  #evaluating: Promise<void> = Promise.resolve();

  constructor(options: PollingEvaluatorOptions) {
    this.#evaluate = options.evaluate;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#timers = options.timers;
  }

  /** 启动（服务 start 调用）：立即评估一轮并保持轮询刷新。 */
  start(): Promise<void> {
    return this.#queueEvaluate();
  }

  /** 停止（测试/拆除）：取消定时器，不再轮询。 */
  stop(): void {
    this.#stopped = true;
    this.clearPollTimer();
  }

  /** 立即评估（幂等）：设置/状态变化后宿主调用（与 sync.kick 同语义）。 */
  kick(): Promise<void> {
    return this.#queueEvaluate();
  }

  /** 评估排队：并发触发串行执行，最终收敛到最新状态；单轮异常不毒化队列。
   *  stop 后入队的轮次直接跳过（与调用方在 evaluate 开头检查 stopped 等价）。 */
  #queueEvaluate(): Promise<void> {
    const run = this.#evaluating.then(() => (this.#stopped ? undefined : this.#evaluate()));
    this.#evaluating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 轮询续期：evaluate 回调正常路径调用——若无定时器则设一个（每次评估续期）。 */
  armPoll(): void {
    if (this.#pollTimer !== undefined || this.#stopped) return;
    this.#pollTimer = this.#timers.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#queueEvaluate();
    }, this.#pollIntervalMs);
  }

  /** 暂停轮询（不清 stopped）：evaluate 回调停用分支调用，重新启用后可恢复。 */
  clearPollTimer(): void {
    if (this.#pollTimer === undefined) return;
    this.#timers.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }
}
