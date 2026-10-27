/**
 * 自动、手动和初始化填表共用持久化队列；每批独占一个 SQLite 事务。
 * 每批成功后提交保存；失败或取消仅回滚当前批，楼层台账在保存后更新。
 * 按空间内入队顺序串行执行。
 * queued → running → succeeded / failed / interrupted；失败和切换对话保留阻塞项，
 * 重试沿用原队列位置，取消后释放。任务执行与批次提交保持同一套事务和日志规则。
 */
import type { MemoryEvidenceId, MemorySpaceId } from "../memory/index.ts";
import type { BeginFillTaskSession, FillTaskSession } from "./fill-task-session.ts";
import {
  buildMemorySpaceTableDigest,
  composeProposalAgentMessages,
  type ComposedAgentMessage,
  type LlmPort,
} from "../agent/index.ts";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runFillAgent, systemTextOf } from "../agent/fill-agent-runner.ts";
import {
  composePresetMessages,
  type AgentPromptSnapshot,
} from "../agent-presets/preset-composer.ts";
import { containsMsgReference, type AgentPromptPreset } from "../agent-presets/preset-model.ts";
import {
  buildBlockEvidence,
  buildMergedStoryText,
  composeBlockMessagesText,
  composeBlockPrompt,
} from "./fill-task-block.ts";
import { applyCleaningRule, type CleaningRule } from "../cleaning/cleaning-rules.ts";
import { EVIDENCE_INIT_SOURCE_TYPE } from "../../constants.ts";
import {
  createFillAgentTurnCollector,
  fillAgentContextLog,
  type FillAgentContextText,
} from "./fill-agent-log.ts";
import { fillRunEndLog, fillRunStartLog, fillTaskEndLog, fillTaskStartLog } from "./fill-log.ts";
import type { LogAppendInput, LogRepository } from "../logging/log.ts";
import {
  FillTaskConflictError,
  FillTaskNotFoundError,
  FillTaskRangeError,
  FillTaskStateError,
  isFillTaskTerminal,
  type FillTask,
  type FillTaskRepository,
  type FillTaskSource,
  type FillTaskView,
  type FillTaskRetryState,
  type FloorLedgerEntry,
  type FloorLedgerRepository,
  type FillSourceMessage,
} from "./fill-task.ts";

/** 任务默认分块大小：每块楼层数对应一次 Agent 循环；每批独立事务。 */
export const DEFAULT_FILL_TASK_BLOCK_SIZE = 20;

const DEFAULT_FILL_TASK_RETRY_POLICY = { retries: 2, delaySeconds: 10 };

/** 单块填写 Agent 的默认总超时。 */
const BLOCK_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 本轮输入消息 → 上下文行载荷（文本块拼接为单条文本；runMessages 由本模块构造，必为 user 文本消息）。 */
function fillAgentInputTextOf(message: AgentMessage): FillAgentContextText {
  return {
    role: "user",
    text: (message as { readonly content: readonly { type: "text"; text: string }[] }).content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
  };
}

/**
 * 填表任务编排上下文（ADR 0024 组装迁移）：**纯数据**，宿主在任务开始执行时构造
 * 一次（预设解析 + 世界书扫描 + ST 上下文快照，归属 runtime 装配），块处理时
 * 由 service 直接展开编排消息——无方法，不含块级状态（{{msg}} 按块注入）。
 */
export interface FillTaskPromptContext {
  /** 活动预设（系统默认预设 = undefined，走核心默认提示词）。 */
  readonly preset: AgentPromptPreset;
  /** 占位符展开快照（names/角色卡/Persona/世界书文本；msgText 按块补充）。 */
  readonly snapshot: AgentPromptSnapshot;
}

export interface FillTaskSubmitInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 楼层闭区间 [from, to]（同步楼层 = ST 消息数组下标，0 基） */
  readonly from: number;
  readonly to: number;
  readonly blockSize?: number;
  readonly retryOf?: string;
  readonly automatic?: {
    readonly retries: number;
    readonly delaySeconds: number;
    readonly canContinue: () => boolean;
    readonly interruptionReason?: () => "chat-changed" | undefined;
    readonly onFailure?: (message: string) => void;
  };
}

/** 初始化填表提交输入（spec init-fill）：输入 = 用户初始化文本框内容，无楼层。 */
export interface FillTaskInitInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 初始化输入文本（允许为空串：仅凭预设内容初始化；trim 后为空不拦截）。 */
  readonly text: string;
  readonly retryOf?: string;
}

export interface FillTaskServiceOptions {
  readonly readAgentTimeoutMs?: () => number;
  readonly tasks: FillTaskRepository;
  readonly ledger: FloorLedgerRepository;
  /** 消息来源（楼层 → 原文；同步楼层随时从 ST 对话实时读取） */
  readonly source: FillTaskSource;
  readonly beginTask: BeginFillTaskSession;
  /** 保存完成后，短 IndexedDB 事务更新任务与楼层台账。 */
  readonly runInTransaction: (work: () => Promise<void>) => Promise<void>;
  /** LLM 端口工厂：任务开始时读 ST 当前配置构造一次（模型+参数快照） */
  readonly createLlm: () => LlmPort;
  /**
   * 编排上下文工厂（ADR 0024 组装迁移）：任务开始执行时构造一次，返回**纯数据**
   * （活动预设 + 占位符展开快照，无方法）；接收任务范围合并剧情文本
   * （{{worldbook}} 扫描输入）；块处理时由 service 直接展开编排消息。
   * 缺省/返回 undefined = 系统默认预设（核心默认提示词）。
   */
  readonly createPromptContext?: (storyText: string) => Promise<FillTaskPromptContext | undefined>;
  /** 通用日志仓库（独立数据库，ADR 0015）：填表开始行在此写入（best-effort，失败不影响任务）。 */
  readonly logs: LogRepository;
  /**
   * 填表任务内容清洗（ticket 22 / ADR 0011）：任务开始时冻结当前对话所选
   * 单份清洗规则；未选择或所选规则已删除时不清洗。
   */
  readonly readCleaningRule?: () => CleaningRule | undefined;
  readonly createRunId?: () => string;
  readonly createEvidenceId: () => MemoryEvidenceId;
  readonly now?: () => string;
  /** 后台循环不允许未处理异常：失败标记出错时只能记录日志。 */
  readonly logError?: (message: string, error: unknown) => void;
}

export class FillTaskService {
  readonly #readAgentTimeoutMs: () => number;
  #suspended = false;
  #worker: Promise<void> | undefined;
  #requestedSpace: MemorySpaceId | undefined;
  #currentSpace: MemorySpaceId | undefined;
  #submissions: Promise<unknown> = Promise.resolve();
  readonly #policies = new Map<string, FillTaskSubmitInput["automatic"]>();

  readonly retryStates = new Map<string, FillTaskRetryState>();
  readonly #tasks: FillTaskRepository;
  readonly #ledger: FloorLedgerRepository;
  readonly #source: FillTaskSource;
  readonly #beginTask: BeginFillTaskSession;
  readonly #runs = new Map<
    string,
    {
      controller: AbortController;
      phase: "running" | "saving";
      interruptionReason?: "chat-changed";
      done: Promise<void>;
    }
  >();
  readonly #runInTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly #createLlm: () => LlmPort;
  readonly #createPromptContext:
    ((storyText: string) => Promise<FillTaskPromptContext | undefined>) | undefined;
  readonly #logs: LogRepository;
  readonly #readCleaningRule: () => CleaningRule | undefined;
  readonly #createRunId: () => string;
  readonly #createEvidenceId: () => MemoryEvidenceId;
  readonly #now: () => string;
  readonly #logError: (message: string, error: unknown) => void;

  constructor(options: FillTaskServiceOptions) {
    this.#readAgentTimeoutMs = options.readAgentTimeoutMs ?? (() => BLOCK_AGENT_TIMEOUT_MS);
    this.#tasks = options.tasks;
    this.#ledger = options.ledger;
    this.#source = options.source;
    this.#beginTask = options.beginTask;
    this.#runInTransaction = options.runInTransaction;
    this.#createLlm = options.createLlm;
    this.#createPromptContext = options.createPromptContext;
    this.#logs = options.logs;
    this.#readCleaningRule = options.readCleaningRule ?? (() => undefined);
    this.#createRunId = options.createRunId ?? (() => crypto.randomUUID());
    this.#createEvidenceId = options.createEvidenceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#logError = options.logError ?? (() => undefined);
  }

  /** 暂停启动后续任务；正在执行的批仍通过任务状态检查退出。 */
  suspend(): void {
    this.#suspended = true;
  }

  kick(memorySpaceId: MemorySpaceId): void {
    this.#suspended = false;
    this.#requestedSpace = memorySpaceId;
    this.#currentSpace = memorySpaceId;
    if (this.#worker) return;
    this.#worker = this.#drain()
      .catch((error) => this.#logError("填表队列执行失败", error))
      .finally(() => {
        this.#worker = undefined;
        const pending = this.#requestedSpace;
        if (pending && !this.#suspended) this.kick(pending);
      });
  }

  async pendingTasks(memorySpaceId: MemorySpaceId): Promise<readonly FillTaskView[]> {
    return Promise.all(
      (await this.#tasks.pending(memorySpaceId)).map((task) => this.#toView(task)),
    );
  }

  async #drain(): Promise<void> {
    while (!this.#suspended && this.#requestedSpace) {
      const spaceId = this.#requestedSpace;
      this.#requestedSpace = undefined;
      while (!this.#suspended && this.#currentSpace === spaceId) {
        const task = (await this.#tasks.pending(spaceId))[0];
        if (this.#suspended || this.#currentSpace !== spaceId || !task || task.status !== "queued")
          break;
        if (!(await this.#tasks.markRunning(task.runId))) break;
        const running: FillTask = { ...task, status: "running" };
        try {
          if (!(await this.#chatUnchanged(running))) {
            await this.cancel(spaceId, task.runId, "chat-changed");
            break;
          }
          const llm = this.#createLlm();
          const input = structuredClone(
            task.kind === "init"
              ? [
                  {
                    floor: 0,
                    name: "",
                    content: task.initText,
                    options: { needCleaning: false },
                  },
                ]
              : this.#source.messagesInRange(task.from, task.to),
          );
          const rule = structuredClone(this.#readCleaningRule());
          const promptContext = await this.#createPromptContext?.(
            task.kind === "init" ? task.initText : buildMergedStoryText(input),
          );
          const automatic =
            this.#policies.get(task.runId) ??
            (task.retryPolicy
              ? {
                  ...task.retryPolicy,
                  canContinue: () => this.#source.chatId() === (task.chatId ?? undefined),
                  interruptionReason: () => "chat-changed" as const,
                }
              : undefined);
          await this.#appendLog(
            fillTaskStartLog(running),
            `填表任务 ${task.runId} 开始日志写入失败`,
          );
          await this.#startTask(running, llm, promptContext, input, rule, automatic);
        } catch (error) {
          await this.#failTask(running, error);
        } finally {
          this.#policies.delete(task.runId);
        }
      }
    }
  }

  /** 校验楼层范围并入队；返回 queued 视图，配置与编排上下文在执行时读取。 */
  submit(input: FillTaskSubmitInput): Promise<FillTaskView> {
    const chatId = this.#source.chatId();
    const submitted = this.#submissions.then(async () => {
      if (this.#source.chatId() !== chatId) throw new Error("对话已切换，请重新提交");
      return this.#submitFloor(input);
    });
    this.#submissions = submitted.catch(() => undefined);
    return submitted;
  }

  async #submitFloor(input: FillTaskSubmitInput): Promise<FillTaskView> {
    const chatLength = this.#source.chatMessageCount();
    const blockSize = input.blockSize ?? DEFAULT_FILL_TASK_BLOCK_SIZE;
    if (
      !Number.isInteger(input.from) ||
      !Number.isInteger(input.to) ||
      !Number.isInteger(blockSize) ||
      blockSize < 1 ||
      input.from < 0 ||
      input.to < input.from ||
      input.to >= chatLength
    ) {
      throw new FillTaskRangeError(
        `消息楼层范围无效：请选择 [0, ${Math.max(chatLength - 1, 0)}] 内的闭区间（同步楼层从 0 开始），分块大小必须 >= 1`,
      );
    }
    if (input.automatic && !input.automatic.canContinue())
      throw new Error("对话或自动填表模式已变化，请重新触发");
    const now = this.#now();
    const task: FillTask = {
      ...(input.automatic
        ? {
            automatic: true,
            retryPolicy: {
              retries: input.automatic.retries,
              delaySeconds: input.automatic.delaySeconds,
            },
          }
        : {}),
      runId: this.#createRunId(),
      memorySpaceId: input.memorySpaceId,
      from: input.from,
      to: input.to,
      blockSize,
      kind: "floor",
      initText: null,
      // 对话身份快照：块开始前检测对话切换（防止把新对话的消息写进旧空间）
      chatId: this.#source.chatId() ?? null,
      status: "queued",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    const queued = await this.#tasks.enqueue(task, input.retryOf);
    this.#policies.set(task.runId, input.automatic);
    if (!this.#suspended) this.kick(task.memorySpaceId);
    return this.#toView(queued);
  }

  async cancel(
    memorySpaceId: MemorySpaceId,
    runId: string,
    reason?: "chat-changed",
  ): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const run = this.#runs.get(runId);
    if (run) {
      if (run.phase === "saving") {
        if (reason) {
          run.interruptionReason = reason;
          await run.done;
          return this.#toView(await this.#requireTask(memorySpaceId, runId));
        }
        throw new FillTaskStateError(task);
      }
      run.controller.abort(new Error(reason ? "对话已切换" : "用户取消填表任务"));
      run.interruptionReason = reason;
      await run.done;
      if (reason) await this.#tasks.markInterrupted(runId, reason);
      else await this.#tasks.release(runId);
    } else if (task.blocksQueue && isFillTaskTerminal(task.status)) {
      if (!reason) await this.#tasks.release(runId);
    } else {
      const applied = await this.#tasks.markInterrupted(runId, reason);
      if (!applied && !reason) throw new FillTaskStateError(task);
      if (applied)
        await this.#appendLog(
          fillTaskEndLog({ task, status: "interrupted", errorMessage: null, endedAt: this.#now() }),
          `填表任务 ${runId} 结束日志写入失败`,
        );
    }
    this.#policies.delete(runId);
    if (!this.#suspended && !reason) this.kick(memorySpaceId);
    return this.#toView(await this.#requireTask(memorySpaceId, runId));
  }

  async interruptForChatChange(): Promise<void> {
    this.suspend();
    await Promise.all(
      [...this.#runs.keys()].map(async (runId) => {
        const task = await this.#tasks.find(runId);
        if (task) await this.cancel(task.memorySpaceId, runId, "chat-changed");
      }),
    );
  }

  /** 空间清理前原子取消全部待处理项，避免取消运行项后启动等待项。 */
  async cancelAll(memorySpaceId: MemorySpaceId): Promise<void> {
    this.suspend();
    const active = await this.#tasks.findActive(memorySpaceId);
    const run = active && this.#runs.get(active.runId);
    if (run) {
      if (run.phase === "running") {
        run.controller.abort(new Error("空间任务已取消"));
      }
      await run.done;
    }
    await this.#tasks.interruptPending(memorySpaceId);
  }

  /** 初始化文本与楼层任务共用队列；文本持久化，供后续执行和重试。 */
  submitInit(input: FillTaskInitInput): Promise<FillTaskView> {
    const chatId = this.#source.chatId();
    const submitted = this.#submissions.then(async () => {
      if (this.#source.chatId() !== chatId) throw new Error("对话已切换，请重新提交");
      return this.#submitInit(input);
    });
    this.#submissions = submitted.catch(() => undefined);
    return submitted;
  }

  async #submitInit(input: FillTaskInitInput): Promise<FillTaskView> {
    const now = this.#now();
    const task: FillTask = {
      runId: this.#createRunId(),
      memorySpaceId: input.memorySpaceId,
      from: 0,
      to: 0,
      blockSize: 1,
      kind: "init",
      initText: input.text,
      // 对话身份快照：与楼层任务同语义（块开始前检测对话切换）
      chatId: this.#source.chatId() ?? null,
      status: "queued",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    const queued = await this.#tasks.enqueue(task, input.retryOf);
    if (!this.#suspended) this.kick(task.memorySpaceId);
    return this.#toView(queued);
  }

  /** 重试生成新任务并保留历史；阻塞项沿用原位置，自动任务跳过已完成楼层。 */
  async retry(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    if (!isFillTaskTerminal(task.status)) throw new FillTaskStateError(task);
    const retryOf = task.blocksQueue ? task.runId : undefined;
    if (task.kind === "init") {
      return this.submitInit({ memorySpaceId, text: task.initText, retryOf });
    }
    let from = task.from;
    const to = task.automatic ? Math.min(task.to, this.#source.chatMessageCount() - 1) : task.to;
    if (task.automatic) {
      const ledger = await this.#ledger.statuses(
        memorySpaceId,
        0,
        this.#source.chatMessageCount() - 1,
      );
      from = ledger.reduce(
        (first, entry) => (entry.status === "processed" ? Math.max(first, entry.floor + 1) : first),
        from,
      );
      if (from > to) {
        if (task.blocksQueue) await this.#tasks.release(runId);
        if (!this.#suspended) this.kick(memorySpaceId);
        return this.#toView({ ...task, blocksQueue: false });
      }
    }
    return this.submit({
      memorySpaceId,
      from,
      to,
      blockSize: task.blockSize,
      retryOf,
      automatic: task.retryPolicy
        ? {
            ...task.retryPolicy,
            canContinue: () => this.#source.chatId() === (task.chatId ?? undefined),
            interruptionReason: () => "chat-changed",
          }
        : undefined,
    });
  }

  /** 当前非终态任务视图（无则 undefined；单空间单活动任务守卫的 UI 侧查询）。 */
  async activeTask(memorySpaceId: MemorySpaceId): Promise<FillTaskView | undefined> {
    const task = await this.#tasks.findActive(memorySpaceId);
    return task ? this.#toView(task) : undefined;
  }

  /** 最近任务（createdAt 倒序，limit 截断）：触发 UI 展示最近一次任务结果。 */
  async recentTasks(memorySpaceId: MemorySpaceId, limit: number): Promise<readonly FillTaskView[]> {
    const tasks = await this.#tasks.listRecent(memorySpaceId, limit);
    return Promise.all(tasks.map((task) => this.#toView(task)));
  }

  /** 启动时调用（页面/浏览器重开）：所有非终态任务标记 interrupted，不自动重放。
   *  每个被中断的任务写入中断结束行（结束时刻 = 标记时刻，best-effort）。 */
  async markInterruptedOnStartup(): Promise<void> {
    const interrupted = await this.#tasks.markInterruptedOnStartup();
    for (const task of interrupted) {
      await this.#appendLog(
        fillTaskEndLog({ task, status: "interrupted", errorMessage: null, endedAt: this.#now() }),
        `填表任务 ${task.runId} 结束日志写入失败`,
      );
    }
  }

  /** 楼层台账状态（闭区间 [from, to]，untracked = 无行）：触发 UI「未处理范围」提示的数据源。 */
  async ledgerStatuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]> {
    return this.#ledger.statuses(memorySpaceId, from, to);
  }

  /**
   * 手动标记楼层进度（ticket 25）：对指定楼层区间批量设置台账状态。
   * - processed / error：upsert 对应状态行；
   * - untracked：删除范围内台账行（目标 untracked 语义）。
   * 运行中任务时拒绝操作（FillTaskConflictError）。
   */
  async markFloorStatuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
    status: "processed" | "untracked" | "error",
  ): Promise<void> {
    // 运行中任务守卫（与 submit 同语义）
    const active = await this.#tasks.findActive(memorySpaceId);
    if (active) throw new FillTaskConflictError(active);
    // 范围校验（与 submit 一致）
    const chatLength = this.#source.chatMessageCount();
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to >= chatLength
    ) {
      throw new FillTaskRangeError(
        `消息楼层范围无效：请选择 [0, ${Math.max(chatLength - 1, 0)}] 内的闭区间（同步楼层从 0 开始）`,
      );
    }
    const floors = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    switch (status) {
      case "processed":
        await this.#ledger.markProcessed(memorySpaceId, floors);
        break;
      case "error":
        await this.#ledger.markError(memorySpaceId, floors);
        break;
      case "untracked":
        await this.#ledger.deleteStatuses(memorySpaceId, from, to);
        break;
    }
  }

  async #requireTask(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTask> {
    const task = await this.#tasks.find(runId);
    if (task === undefined || task.memorySpaceId !== memorySpaceId) {
      throw new FillTaskNotFoundError();
    }
    return task;
  }

  /** 任务视图：任务行 + 实时已处理计数（台账 processed 楼层数）+ 范围总楼层数。
   *  初始化任务无楼层：totalCount = 1（单块），进度不查台账。 */
  async #toView(task: FillTask): Promise<FillTaskView> {
    const run = this.#runs.get(task.runId);
    const progress =
      run === undefined
        ? {}
        : {
            phase: run.phase,
            retryState: this.retryStates.get(task.runId),
          };
    if (task.kind === "init") {
      return { ...task, ...progress, processedCount: 0, totalCount: 1 };
    }
    const processedCount = await this.#ledger.processedCount(
      task.memorySpaceId,
      task.from,
      task.to,
    );
    return { ...task, ...progress, processedCount, totalCount: task.to - task.from + 1 };
  }

  /** 冻结任务输入，后台按批次持有事务。 */
  #startTask(
    task: FillTask,
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
    input: readonly FillSourceMessage[],
    rule: CleaningRule | undefined,
    automatic?: FillTaskSubmitInput["automatic"],
  ): Promise<void> {
    const controller = new AbortController();
    const control = {
      controller,
      phase: "running" as "running" | "saving",
      done: Promise.resolve(),
    };
    this.#runs.set(task.runId, control);
    control.done = this.#runTask(
      task,
      llm,
      promptContext === undefined ? undefined : structuredClone(promptContext),
      input,
      rule,
      control,
      automatic,
    );
    return control.done;
  }

  async #runTask(
    task: FillTask,
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
    input: readonly FillSourceMessage[],
    rule: CleaningRule | undefined,
    control: {
      controller: AbortController;
      phase: "running" | "saving";
      interruptionReason?: "chat-changed";
    },
    automatic?: FillTaskSubmitInput["automatic"],
  ): Promise<void> {
    let failingBlock: { from: number; to: number } | undefined;
    try {
      for (let from = task.from; from <= task.to; from += task.blockSize) {
        const to = Math.min(from + task.blockSize - 1, task.to);
        const messages = input.filter((message) => message.floor >= from && message.floor <= to);
        failingBlock = { from, to };
        let session: FillTaskSession | undefined;
        try {
          control.controller.signal.throwIfAborted();
          if (!(await this.#isRunning(task.runId))) throw new Error("填表任务已停止");
          if (!(await this.#chatUnchanged(task))) {
            control.interruptionReason = "chat-changed";
            control.controller.abort(new Error("对话已切换"));
          }
          if (automatic && !automatic.canContinue())
            control.controller.abort(new Error("自动填表已停止"));
          control.controller.signal.throwIfAborted();
          session = await this.#beginTask(task, control.controller.signal);
          await this.#processBlock(
            llm,
            promptContext,
            task,
            (from - task.from) / task.blockSize + 1,
            from,
            to,
            session,
            messages,
            rule,
            control.controller.signal,
            async () => {
              if (!(await this.#chatUnchanged(task))) {
                control.interruptionReason = "chat-changed";
                control.controller.abort(new Error("对话已切换"));
              }
              if (automatic && !automatic.canContinue())
                control.controller.abort(new Error("自动填表已停止"));
              if (
                task.kind !== "init" &&
                JSON.stringify(messages) !== JSON.stringify(this.#source.messagesInRange(from, to))
              )
                throw new Error("填表输入消息已变化，本批修改已撤销，请重新填表");
              if (!(await this.#isRunning(task.runId))) throw new Error("填表任务已停止");
              // 从此处开始禁止取消；保存成功后才发布本批楼层进度。
              control.controller.signal.throwIfAborted();
              control.phase = "saving";
              await session!.commitAndSave();
              failingBlock = undefined;
              if (task.kind !== "init")
                await this.#runInTransaction(() =>
                  this.#ledger.markProcessed(
                    task.memorySpaceId,
                    messages.map((message) => message.floor),
                  ),
                );
            },
            async () => {
              if (!(await this.#chatUnchanged(task))) {
                control.interruptionReason = "chat-changed";
                control.controller.abort(new Error("对话已切换"));
              }
              if (automatic && !automatic.canContinue())
                control.controller.abort(new Error("自动填表已停止"));
              control.controller.signal.throwIfAborted();
            },
          );
        } catch (error) {
          await session?.rollback();
          throw error;
        } finally {
          this.retryStates.delete(task.runId);
          await session?.release();
          control.phase = "running";
        }
        if (control.interruptionReason) {
          control.controller.abort(new Error("对话已切换"));
          control.controller.signal.throwIfAborted();
        }
      }
      control.controller.signal.throwIfAborted();
      if (await this.#tasks.markSucceeded(task.runId))
        await this.#appendLog(
          fillTaskEndLog({ task, status: "succeeded", errorMessage: null, endedAt: this.#now() }),
          "填表任务 " + task.runId + " 结束日志写入失败",
        );
    } catch (error) {
      try {
        if (control.controller.signal.aborted) {
          const applied = await this.#tasks.markInterrupted(
            task.runId,
            control.interruptionReason ?? automatic?.interruptionReason?.(),
          );
          if (applied)
            await this.#appendLog(
              fillTaskEndLog({
                task,
                status: "interrupted",
                errorMessage: null,
                endedAt: this.#now(),
              }),
              "填表任务 " + task.runId + " 结束日志写入失败",
            );
        } else {
          const current = await this.#tasks.find(task.runId);
          if (current && !isFillTaskTerminal(current.status)) {
            if (failingBlock && task.kind !== "init")
              await this.#ledger.markError(
                task.memorySpaceId,
                input
                  .filter(
                    (message) =>
                      message.floor >= failingBlock!.from && message.floor <= failingBlock!.to,
                  )
                  .map((message) => message.floor),
              );
            automatic?.onFailure?.(error instanceof Error ? error.message : String(error));
            await this.#failTask(task, error);
          }
        }
      } catch (cleanupError) {
        this.#logError("填表任务 " + task.runId + " 失败收口出错", cleanupError);
      }
    } finally {
      this.#runs.delete(task.runId);
    }
  }

  /**
   * 提交写入守卫（在提交事务内复查）：任务行存在且仍为 running 才允许写入。
   * 用户取消、页面重开与空间结构重建（删除任务行）都会让本检查失败。
   */
  async #isRunning(runId: string): Promise<boolean> {
    const task = await this.#tasks.find(runId);
    return task?.status === "running";
  }

  /**
   * 对话切换检测：提交时的 chatId 与当前一致才继续。
   * 未保存对话（chatId = null）无法识别切换，跳过检查（漂移接受）。
   */
  async #chatUnchanged(task: FillTask): Promise<boolean> {
    if (task.chatId === null) return true;
    return this.#source.chatId() === task.chatId;
  }

  async #processBlock(
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
    task: FillTask,
    batch: number,
    from: number,
    to: number,
    session: FillTaskSession,
    rawMessages: readonly FillSourceMessage[],
    cleaningRule: CleaningRule | undefined,
    signal: AbortSignal,
    commitBatch: () => Promise<void>,
    checkRetry: () => Promise<void>,
  ): Promise<void> {
    // 批开始行在块处理前先落库（边跑边写）：运行中查询即可见已完成/进行中批。
    const startedAt = this.#now();
    await this.#appendLog(
      fillRunStartLog({ task, batch, from, to, startedAt }),
      `填表任务 ${task.runId} 批次 ${batch} 开始日志写入失败`,
    );
    // turn 采集器（ADR 0016「上下文 + 轮次」形态）：循环每轮 turn_end 事件写一条 turn 行。
    const collector = createFillAgentTurnCollector({
      task,
      batch,
      from,
      to,
      appendLog: (input) =>
        this.#appendLog(input, `填表任务 ${task.runId} 批次 ${batch} Agent 轮次日志写入失败`),
    });
    try {
      // 输入源：楼层任务 = 任务开始时冻结的对话消息；初始化任务 = 合成单条消息
      // （楼层占位 0、名字为空、内容 = initText），无楼层、不进消息流。
      if (rawMessages.length === 0) throw new Error(`消息块 [${from}, ${to}] 内没有可处理的消息`);
      // 清洗只作用于来源层标记为 AI 输出的消息；用户消息、系统消息与初始化文本保持原文。
      const messages =
        cleaningRule === undefined
          ? rawMessages
          : rawMessages.map((message) =>
              message.options?.needCleaning === true
                ? {
                    ...message,
                    content: applyCleaningRule(message.content, cleaningRule),
                  }
                : message,
            );
      // 证据：楼层任务 = 同源唯一 reference（楼层）；初始化任务 = 单条 snapshot
      // （source_type init、source_id runId、内容 = initText 原文——清洗只作用于
      // Agent 输入，证据永远存原文；重复初始化每次生成新证据，同源唯一不冲突）。
      const evidence =
        task.kind === "init"
          ? [
              {
                evidence_id: this.#createEvidenceId(),
                source_type: EVIDENCE_INIT_SOURCE_TYPE,
                source_id: task.runId,
                storage_mode: "snapshot" as const,
                content: task.initText,
                extraProps: {},
              },
            ]
          : await buildBlockEvidence(
              (memorySpaceId, sourceType, sourceId) =>
                session.evidence.findEvidence(memorySpaceId, sourceType, sourceId),
              this.#createEvidenceId,
              task.memorySpaceId,
              messages,
            );
      // 编排（ADR 0024 组装迁移）：digest 块内构建一次，同时喂消息展开与工具装配；
      // 活动预设 → composePresetMessages 纯函数展开（{{msg}} 输入 = 本块消息文本）；
      // 缺省 → 核心默认提示词文本函数（composeProposalAgentMessages，与预设展开
      // 同形状——单条 system 消息）。
      const msgText = composeBlockMessagesText(from, to, messages);
      const digest = await buildMemorySpaceTableDigest(session.reader, task.memorySpaceId);
      const composed: readonly ComposedAgentMessage[] =
        promptContext === undefined
          ? composeProposalAgentMessages(digest)
          : composePresetMessages(promptContext.preset, {
              ...promptContext.snapshot,
              msgText,
            })(digest);
      // 预设引用 {{msg}} = 用户接管消息编排：块内容只出现在占位符展开处，本轮
      // 消息为空；未引用保持旧行为：块提示词作为本轮用户消息。
      const runMessages: AgentMessage[] =
        promptContext !== undefined && containsMsgReference(promptContext.preset)
          ? []
          : [
              {
                role: "user",
                content: [{ type: "text", text: composeBlockPrompt(from, to, messages) }],
                timestamp: Date.now(),
              },
            ];
      // 上下文行：批输入快照（系统提示词 + 预设 + 本批消息），批开始即写——
      // 运行中/中断时系统提示词与预设内容仍可复盘。
      await this.#appendLog(
        fillAgentContextLog({
          task,
          batch,
          from,
          to,
          systemPrompt: systemTextOf(composed),
          preset: composed.filter(
            (message): message is ComposedAgentMessage & { role: "user" | "assistant" } =>
              message.role !== "system",
          ),
          input: runMessages.map(fillAgentInputTextOf),
        }),
        `填表任务 ${task.runId} 批次 ${batch} Agent 上下文日志写入失败`,
      );
      // 组装模块 run（每个块一次完整 Agent 循环；result 形状对齐 ProposalAgentRunResult）。
      const result = await runFillAgent({
        llm,
        reader: session.reader,
        ports: session.ports,
        taskWriter: session.recordWriter,
        signal,
        memorySpaceId: task.memorySpaceId,
        digest,
        composedMessages: composed,
        messages: runMessages,
        messageRange: { from, to },
        evidence,
        timeoutMs: this.#readAgentTimeoutMs(),
        onEvent: collector.listener,
        retryPolicy: {
          enabled: true,
          maxRetries: (task.retryPolicy ?? DEFAULT_FILL_TASK_RETRY_POLICY).retries,
          baseDelayMs: (task.retryPolicy ?? DEFAULT_FILL_TASK_RETRY_POLICY).delaySeconds * 1000,
        },
        retryCallbacks: {
          onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
            this.retryStates.set(task.runId, {
              from,
              to,
              attempt,
              maxAttempts,
              errorMessage,
              retryAt: Date.now() + delayMs,
            });
          },
          onRetryAttemptStart: async () => {
            this.retryStates.delete(task.runId);
            await checkRetry();
          },
          onRetryFinished: () => {
            this.retryStates.delete(task.runId);
          },
        },
      });
      // 轮次行已全部入队：批收尾行落库前等写入链清空（行序 = 批内时间序，best-effort 写入不抛）。
      await collector.flush();
      if (result.errorMessage !== undefined || result.stopReason === "aborted") {
        throw new Error(`Agent 运行失败：${result.errorMessage ?? "运行已中止"}`);
      }
      signal.throwIfAborted();
      await commitBatch();
      await this.#appendLog(
        fillRunEndLog({
          task,
          batch,
          from,
          to,
          status: "succeeded",
          errorMessage: null,
          startedAt,
          endedAt: this.#now(),
        }),
        `填表任务 ${task.runId} 批次 ${batch} 结束日志写入失败`,
      );
    } catch (error) {
      // 出错批结束行：任务已被取消（批中途中断）→ interrupted（warn）；
      // 否则 failed（error 级），携带可读失败原因后向外抛，由调用方收口任务。
      // 异常发生在 run 中时轮次行可能仍在写：先排空队列再收尾（不阻断报错传播）。
      await collector.flush();
      const current = await this.#tasks.find(task.runId);
      const interrupted =
        signal.aborted || (current !== undefined && current.status === "interrupted");
      await this.#appendLog(
        fillRunEndLog({
          task,
          batch,
          from,
          to,
          status: interrupted ? "interrupted" : "failed",
          errorMessage: interrupted ? null : error instanceof Error ? error.message : String(error),
          startedAt,
          endedAt: this.#now(),
        }),
        `填表任务 ${task.runId} 批次 ${batch} 结束日志写入失败`,
      );
      throw error;
    }
  }

  /**
   * 日志行写入（best-effort，ADR 0015/0016）：审计数据，写入失败只记警告，
   * 绝不影响任务提交、批处理与终态标记。
   */
  async #appendLog(input: LogAppendInput, failMessage: string): Promise<void> {
    try {
      await this.#logs.append(input);
    } catch (error) {
      this.#logError(failMessage, error);
    }
  }

  /** 失败阻塞队列，保留此前成功批次。 */
  async #failTask(task: FillTask, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const applied = await this.#tasks.markFailed(task.runId, message);
      if (!applied) return;
    } catch (markError) {
      this.#logError(`填表任务 ${task.runId} 失败状态标记出错`, markError);
      return;
    }
    // 任务结束行（failed，error 级）：出错批的结束行（error 级）已由
    // #processBlock 在抛出前写入，任务结束行随后写入，时间序正确。
    await this.#appendLog(
      fillTaskEndLog({ task, status: "failed", errorMessage: message, endedAt: this.#now() }),
      `填表任务 ${task.runId} 结束日志写入失败`,
    );
  }
}
