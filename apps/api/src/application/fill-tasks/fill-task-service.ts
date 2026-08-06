/**
 * FillTaskService：填表后台任务（ticket 13）的应用层编排。
 *
 * 职责（用户确认的 Spec）：
 * - 提交任务 = { memorySpaceId, [from, to] 闭区间, blockSize, config? }，生成唯一 run_id；
 * - 每个记忆空间最多一个非终态任务，冲突提交携带当前任务信息；
 * - 分批循环由本服务驱动（Adapter Service）：每块注入块消息为证据 + 块范围为
 *   messageRange → 跑 12 的 ProposalAgent → 冻结 batch 完整复核 → 单事务原子提交
 *   （当前记录 + 历史 + 证据 + revision）→ 标记本块 processed → 下一块；
 * - 空提案（Agent 确认无需变更）按成功处理；任何块失败标记该块消息 error 并停止任务；
 * - 批次提交与 processed 标记在同一事务：失败回滚不产生半批数据/半批状态。
 *
 * 状态机（queued/paused/cancelled/interrupted 等，ticket 14）：
 * - 提交 = 任务行创建（queued）→ 提交响应前转为 running → 后台分批循环；
 * - 暂停/恢复/中止经控制端点记请求状态（pause_requested / cancel_requested），
 *   任务循环在安全点（块开始前、块内提交前）应用，不打断正在运行的 LLM 请求或 SQLite 事务；
 * - API 重启时所有非终态任务标记 interrupted，不自动重放。
 */
import { randomUUID } from "node:crypto";
import {
  commitMemoryProposalBatch,
  type MemoryEvidenceId,
  type MemoryEvidenceRepository,
  type MemoryProposalPorts,
  type MemoryRecordMutationContext,
  type MemorySpaceId,
} from "@ste-memory/core/memory";
import { ProposalAgent, type LlmPort, type MemorySpaceReader } from "@ste-memory/core/memory/agent";
import type { UnitOfWork } from "@ste-memory/tools";
import { translateAgentEvent } from "../agent-events.ts";
import type { FillTask, FillTaskRepository, FillTaskView } from "../ports/fill-task.ts";
import { isFillTaskTerminal } from "../ports/fill-task.ts";
import type { AgentRunEventEntry, FillTaskEventBus } from "../ports/fill-task-events.ts";
import type { FillTaskManager } from "../ports/fill-task-manager.ts";
import type { MemorySpaceManager } from "../ports/memory-space.ts";
import type { SourceChatRepository } from "../ports/source-chat.ts";
import type { CleaningRuleRepository } from "../ports/cleaning-rule.ts";
import { buildBlockEvidence, composeBlockPrompt } from "./fill-task-block.ts";
import { applyCleaningRules } from "../cleaning-rules/transform.ts";
import { InMemoryFillTaskEventBus } from "./fill-task-event-bus.ts";
import {
  resolveLlmConfig,
  type LlmEnvConfig,
  type LlmWebConfig,
  type ResolvedLlmConfig,
} from "../chat/llm-config.ts";

/** 任务默认分块大小：每块消息数 = 一次 Agent 调用 + 一个原子批次。 */
export const DEFAULT_FILL_TASK_BLOCK_SIZE = 20;

/** 单块 Agent run 的总超时（对齐 ProposalAgent 默认 5 分钟）。 */
const BLOCK_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

/** 暂停等待恢复时的控制状态轮询间隔（恢复请求最迟在此间隔后生效）。 */
const TASK_CONTROL_POLL_INTERVAL_MS = 500;

/** 同一记忆空间已有非终态任务（提交冲突；HTTP 层映射 409）。 */
export class FillTaskConflictError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`该记忆空间已有正在进行的填表任务（${task.runId}），请等待其结束`);
    this.name = "FillTaskConflictError";
    this.task = task;
  }
}

/** 任务不存在或不属于该记忆空间（HTTP 层映射 404）。 */
export class FillTaskNotFoundError extends Error {
  constructor() {
    super("填表任务不存在");
    this.name = "FillTaskNotFoundError";
  }
}

/** 当前状态不允许该控制操作（HTTP 层映射 409，携带当前任务）。 */
export class FillTaskStateError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`当前任务状态（${task.status}）不允许该操作`);
    this.name = "FillTaskStateError";
    this.task = task;
  }
}

/** 记忆空间不存在（HTTP 层映射 404）。 */
export class FillTaskSpaceNotFoundError extends Error {
  constructor() {
    super("记忆空间不存在");
    this.name = "FillTaskSpaceNotFoundError";
  }
}

/** 消息范围/分块参数无效（HTTP 层映射 400）。 */
export class FillTaskRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillTaskRangeError";
  }
}

export interface FillTaskSubmitInput {
  readonly memorySpaceId: MemorySpaceId;
  readonly from: number;
  readonly to: number;
  readonly blockSize?: number;
  /** 网页 LLM 配置（与 chat 同一协议）：逐字段回退环境变量。 */
  readonly config?: LlmWebConfig;
}

export interface FillTaskServiceOptions {
  readonly tasks: FillTaskRepository;
  readonly sources: SourceChatRepository;
  readonly spaces: Pick<MemorySpaceManager, "exists">;
  /** 清洗规则（ADR apps/0001：读取时套用，喂给 Agent 前去掉多余符号）。 */
  readonly cleaningRules: CleaningRuleRepository;
  /** 服务端环境变量配置（OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL）。 */
  readonly envConfig: LlmEnvConfig;
  /** provider 构造：每个任务构建一次 LlmPort（API Key 只存在于内存闭包）。 */
  readonly buildLlmPort: (config: ResolvedLlmConfig) => LlmPort;
  /** 记忆空间只读端口（digest 构建 + query_records 工具共用）。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览/提交所需的领域访问端口（与 ProposalAgent 共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
  /** 证据仓库：块证据复用既有行（memory_evidence 对同源唯一，重复处理不冲突）。 */
  readonly evidence: MemoryEvidenceRepository;
  /** 批次原子提交上下文（id 生成器 + displayText 等，见 core memory-record-mutations）。 */
  readonly commitContext: MemoryRecordMutationContext;
  readonly unitOfWork: UnitOfWork;
  readonly createRunId?: () => string;
  readonly createEvidenceId: () => MemoryEvidenceId;
  readonly now?: () => string;
  /** 后台循环不允许未处理异常：失败标记出错时只能记录日志。 */
  readonly logError?: (message: string, error: unknown) => void;
}

export class FillTaskService implements FillTaskManager, FillTaskEventBus {
  readonly #tasks: FillTaskRepository;
  readonly #sources: SourceChatRepository;
  readonly #spaces: Pick<MemorySpaceManager, "exists">;
  readonly #cleaningRules: CleaningRuleRepository;
  readonly #envConfig: LlmEnvConfig;
  readonly #buildLlmPort: (config: ResolvedLlmConfig) => LlmPort;
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #evidence: MemoryEvidenceRepository;
  readonly #commitContext: MemoryRecordMutationContext;
  readonly #unitOfWork: UnitOfWork;
  readonly #createRunId: () => string;
  readonly #createEvidenceId: () => MemoryEvidenceId;
  readonly #now: () => string;
  readonly #logError: (message: string, error: unknown) => void;
  /** 事件总线（ticket 16）：缓冲 + 订阅者，HTTP 层经 subscribe 订阅 SSE 流。 */
  readonly #bus: InMemoryFillTaskEventBus;

  constructor(options: FillTaskServiceOptions) {
    this.#tasks = options.tasks;
    this.#sources = options.sources;
    this.#spaces = options.spaces;
    this.#cleaningRules = options.cleaningRules;
    this.#envConfig = options.envConfig;
    this.#buildLlmPort = options.buildLlmPort;
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#evidence = options.evidence;
    this.#commitContext = options.commitContext;
    this.#unitOfWork = options.unitOfWork;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#createEvidenceId = options.createEvidenceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#logError = options.logError ?? (() => undefined);
    this.#bus = new InMemoryFillTaskEventBus((runId) => this.#tasks.find(runId));
  }

  /** 当前非终态任务视图（无则 undefined）。 */
  async activeTask(memorySpaceId: MemorySpaceId): Promise<FillTaskView | undefined> {
    const task = await this.#tasks.findActive(memorySpaceId);
    return task ? this.#toView(task) : undefined;
  }

  /** 暂停：running → pause_requested（任务循环在安全点应用为 paused）。 */
  async pause(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const requested = await this.#tasks.requestPause(runId);
    if (!requested) throw new FillTaskStateError(task);
    return this.#toView({ ...task, status: "pause_requested" });
  }

  /** 恢复：paused → running（任务循环从下一块继续，不重跑已成功批次）。 */
  async resume(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const resumed = await this.#tasks.resume(runId);
    if (!resumed) throw new FillTaskStateError(task);
    this.#bus.emit(runId, { type: "task_status", status: "running", errorMessage: null });
    return this.#toView({ ...task, status: "running" });
  }

  /** 中止：任意非终态 → cancel_requested（任务循环在安全点丢弃未提交提案后置 cancelled）。 */
  async cancel(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const requested = await this.#tasks.requestCancel(runId);
    if (!requested) throw new FillTaskStateError(task);
    return this.#toView({ ...task, status: "cancel_requested" });
  }

  /** 启动时调用：所有非终态任务标记 interrupted（API 重启，不自动重放）。 */
  async markInterruptedOnStartup(): Promise<void> {
    await this.#tasks.markInterruptedOnStartup();
  }

  /**
   * 订阅事件流（ticket 16）：先回放缓冲再实时转发；任务不存在/不属于该空间返回 undefined
   * （HTTP 层映射 404）。客户端断开只退订，绝不中止任务（中止仍走 cancel 控制端点）。
   */
  async subscribe(
    spaceId: MemorySpaceId,
    runId: string,
    afterSeq: number | undefined,
    onEvent: (entry: AgentRunEventEntry) => void,
  ): Promise<(() => void) | undefined> {
    return this.#bus.subscribe(spaceId, runId, afterSeq, onEvent);
  }

  async #requireTask(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTask> {
    const task = await this.#tasks.find(runId);
    if (task === undefined || task.memorySpaceId !== memorySpaceId) {
      throw new FillTaskNotFoundError();
    }
    return task;
  }

  /** 任务视图：行数据 + 实时已处理计数 + 范围总消息数。 */
  async #toView(task: FillTask): Promise<FillTaskView> {
    const processedCount = await this.#sources.processedCount(
      task.memorySpaceId,
      task.from,
      task.to,
    );
    return { ...task, processedCount, totalCount: task.to - task.from + 1 };
  }

  /**
   * 提交填表任务：校验（空间存在 / 范围 / 单任务 / LLM 配置）通过后
   * 持久化任务行并启动后台分批循环，立即返回任务视图。
   */
  async submit(input: FillTaskSubmitInput): Promise<FillTaskView> {
    if (!(await this.#spaces.exists(input.memorySpaceId))) {
      throw new FillTaskSpaceNotFoundError();
    }
    const { messageCount } = await this.#sources.summary(input.memorySpaceId);
    const blockSize = input.blockSize ?? DEFAULT_FILL_TASK_BLOCK_SIZE;
    if (
      !Number.isInteger(input.from) ||
      !Number.isInteger(input.to) ||
      !Number.isInteger(blockSize) ||
      blockSize < 1 ||
      input.from < 1 ||
      input.to < input.from ||
      input.to > messageCount
    ) {
      throw new FillTaskRangeError(
        `消息范围无效：请选择 [1, ${messageCount}] 内的闭区间，分块大小必须 >= 1`,
      );
    }
    const active = await this.#tasks.findActive(input.memorySpaceId);
    if (active) throw new FillTaskConflictError(active);
    // 配置缺失在提交时立即 400，而不是等后台循环启动后才失败。
    const config = resolveLlmConfig(this.#envConfig, input.config ?? {});

    const now = this.#now();
    const task: FillTask = {
      runId: this.#createRunId(),
      memorySpaceId: input.memorySpaceId,
      from: input.from,
      to: input.to,
      blockSize,
      status: "queued",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#tasks.create(task);
      // 提交响应返回前完成 queued → running（占用活动名额；状态机完整走一遍）。
      await this.#tasks.markRunning(task.runId);
    } catch (error) {
      // 并发提交竞态：唯一索引兜底；已存在的活动任务按冲突返回。
      const active = await this.#tasks.findActive(input.memorySpaceId);
      if (active) throw new FillTaskConflictError(active);
      throw error;
    }
    const llm = this.#buildLlmPort(config);
    // 后台循环不阻塞提交请求；所有异常在循环内部收口为任务失败。
    void this.#runTask(task, llm);
    // 内存对象仍是 queued：返回视图前反映 markRunning 已完成的 running 状态。
    return this.#toView({ ...task, status: "running" });
  }

  /**
   * 分批循环：每块一次 Agent 调用 + 一个原子批次；失败标记出错块并停止。
   *
   * 安全点（不打断正在运行的 LLM 请求或 SQLite 事务）：
   * - 块开始前：应用暂停（pause_requested → paused，等待恢复）与中止（→ cancelled）；
   * - 块内提交前：应用中止（未提交提案被丢弃，块消息保持原状态）。
   */
  async #runTask(task: FillTask, llm: LlmPort): Promise<void> {
    const agent = new ProposalAgent({
      llm,
      reader: this.#reader,
      ports: this.#ports,
      timeoutMs: BLOCK_AGENT_TIMEOUT_MS,
    });
    let failingBlock: { readonly from: number; readonly to: number } | undefined;
    try {
      for (let blockFrom = task.from; blockFrom <= task.to; blockFrom += task.blockSize) {
        // 安全点 1：块开始前。取消 → 直接终态；暂停 → 等待恢复后继续本块。
        if ((await this.#controlBeforeBlock(task.runId)) === "cancelled") return;
        const blockTo = Math.min(blockFrom + task.blockSize - 1, task.to);
        failingBlock = { from: blockFrom, to: blockTo };
        await this.#processBlock(agent, task, blockFrom, blockTo);
        // 本块已成功提交：后续失败（如终态标记）不得再把它标记为 error。
        failingBlock = undefined;
      }
      await this.#tasks.markSucceeded(task.runId);
      this.#bus.emit(task.runId, { type: "task_status", status: "succeeded", errorMessage: null });
    } catch (error) {
      if (error instanceof FillTaskCancelledSignal) {
        // 提交前安全点发现中止请求：提案未提交、消息未标记，按取消收口。
        await this.#markCancelled(task.runId);
        return;
      }
      await this.#failTask(task, failingBlock, error);
    } finally {
      // 循环结束：无订阅者时释放缓冲（仍有订阅者时由其退订清理兜底）。
      this.#bus.release(task.runId);
    }
  }

  /** 块开始前的控制检查：返回 cancelled 时任务已置终态，循环应直接结束。 */
  async #controlBeforeBlock(runId: string): Promise<"continue" | "cancelled"> {
    for (;;) {
      const task = await this.#tasks.find(runId);
      if (task === undefined || isFillTaskTerminal(task.status)) return "cancelled";
      if (task.status === "cancel_requested") {
        await this.#markCancelled(runId);
        return "cancelled";
      }
      if (task.status === "pause_requested") {
        await this.#tasks.markPaused(runId);
        this.#bus.emit(runId, { type: "task_status", status: "paused", errorMessage: null });
        await this.#waitWhilePaused(runId);
        continue; // 醒来后重新检查（可能已恢复、又被中止、或异常终态）。
      }
      return "continue";
    }
  }

  /** 暂停期间轮询控制状态：恢复（running）或中止（cancel_requested）后返回。 */
  async #waitWhilePaused(runId: string): Promise<void> {
    for (;;) {
      await sleep(TASK_CONTROL_POLL_INTERVAL_MS);
      const task = await this.#tasks.find(runId);
      if (task === undefined) return;
      if (task.status === "running" || task.status === "cancel_requested") return;
      if (isFillTaskTerminal(task.status)) return;
    }
  }

  async #processBlock(
    agent: ProposalAgent,
    task: FillTask,
    from: number,
    to: number,
  ): Promise<void> {
    this.#bus.emit(task.runId, { type: "block_start", from, to });
    const messages = await this.#sources.messagesInRange(task.memorySpaceId, from, to);
    if (messages.length === 0) {
      throw new Error(`消息块 [${from}, ${to}] 内没有可处理的消息`);
    }
    // 清洗规则在读取时套用：原文存储不变，喂给 Agent 的是清洗后内容。
    const rules = await this.#cleaningRules.list(task.memorySpaceId);
    const cleanedMessages = messages.map((message) => ({
      ...message,
      content: applyCleaningRules(message.content, rules),
    }));
    const evidence = await buildBlockEvidence(
      (memorySpaceId, sourceType, sourceId) =>
        this.#evidence.findEvidence(memorySpaceId, sourceType, sourceId),
      this.#createEvidenceId,
      task.memorySpaceId,
      cleanedMessages,
    );
    const result = await agent.run(
      {
        memorySpaceId: task.memorySpaceId,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: composeBlockPrompt(from, to, cleanedMessages) }],
            timestamp: Date.now(),
          },
        ],
        messageRange: { from, to },
        evidence,
      },
      {
        // 实时输出（ticket 16）：pi 事件 → 应用事件 → 总线缓冲 + SSE 扇出。
        onEvent: (event) => {
          for (const translated of translateAgentEvent(event)) {
            this.#bus.emit(task.runId, translated);
          }
        },
      },
    );
    if (result.errorMessage !== undefined) {
      throw new Error(`Agent 运行失败：${result.errorMessage}`);
    }
    // 安全点 2：提交前。中止请求到达时丢弃未提交提案（消息不标记，供重试）。
    await this.#checkCancelledBeforeCommit(task.runId);
    if (result.proposal) {
      const proposal = result.proposal;
      // 批次提交与 processed 标记同一事务：提交失败回滚时状态也不落库。
      await this.#unitOfWork.run(async () => {
        await commitMemoryProposalBatch(this.#commitContext, task.memorySpaceId, proposal, "agent");
        await this.#sources.markProcessed(
          task.memorySpaceId,
          messages.map((message) => message.source_id),
        );
      });
    } else {
      // 空提案：Agent 确认无需变更，本块按成功处理（可再次提交任务重试）。
      await this.#sources.markProcessed(
        task.memorySpaceId,
        messages.map((message) => message.source_id),
      );
    }
    // 块结果摘要（提交成功或空提案都算块成功；失败块由 task_status failed 表达）。
    this.#bus.emit(task.runId, {
      type: "block_done",
      from,
      to,
      emptyProposal: result.proposal === undefined,
      changedRecords: result.proposal?.operations.length ?? 0,
    });
  }

  /** 提交前安全点：任务已请求中止时抛信号，调用方丢弃提案并不标记消息。 */
  async #checkCancelledBeforeCommit(runId: string): Promise<void> {
    const task = await this.#tasks.find(runId);
    if (task?.status === "cancel_requested") throw new FillTaskCancelledSignal();
  }

  /** 中止收口：标记 cancelled 并发出终态事件（安全点与取消信号两处共用）。 */
  async #markCancelled(runId: string): Promise<void> {
    await this.#tasks.markCancelled(runId);
    this.#bus.emit(runId, { type: "task_status", status: "cancelled", errorMessage: null });
  }

  /** 失败收口：只把出错块的消息标记 error，已成功批次保持 processed，任务置为 failed。 */
  async #failTask(
    task: FillTask,
    failingBlock: { readonly from: number; readonly to: number } | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (failingBlock) {
        const failing = await this.#sources.messagesInRange(
          task.memorySpaceId,
          failingBlock.from,
          failingBlock.to,
        );
        if (failing.length > 0) {
          await this.#sources.markError(
            task.memorySpaceId,
            failing.map((item) => item.source_id),
          );
        }
      }
      await this.#tasks.markFailed(task.runId, message);
      this.#bus.emit(task.runId, { type: "task_status", status: "failed", errorMessage: message });
    } catch (markError) {
      this.#logError(`填表任务 ${task.runId} 失败状态标记出错`, markError);
    }
  }
}

/** 提交前安全点发现中止请求的内部信号（不视为错误，不标记消息为 error）。 */
class FillTaskCancelledSignal extends Error {
  constructor() {
    super("任务已请求中止，未提交提案被丢弃");
    this.name = "FillTaskCancelledSignal";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
