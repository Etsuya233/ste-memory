/**
 * FillTaskService：填表后台任务（ticket 13）的应用层编排（浏览器侧）。
 *
 * 行为基准 = apps/api `application/fill-tasks/fill-task-service.ts`（扩展侧状态机
 * 按本票简化：无 queued/pause/cancel_requested，取消与关页同态落 interrupted）：
 * - 提交任务 = { memorySpaceId, [from, to] 闭区间（同步楼层，0 基）, blockSize? }，
 *   默认块大小 20；单空间单活动任务守卫（原子 createIfIdle，冲突携带当前任务）；
 * - 分批循环：每块注入块消息为证据 + 块范围为 messageRange → ProposalAgent →
 *   批次与台账 markProcessed 同一事务原子提交（失败整批回滚）→ 下一块；
 *   空提案（Agent 确认无需变更）按成功处理（仅 markProcessed）；
 * - 任何块失败：出错块楼层 markError（可重试）、任务 failed 并停止，失败原因可读；
 * - 安全点（块开始前、块提交前）：检查任务行——用户取消（markInterrupted）或
 *   页面重开（启动标记）后循环在安全点停止，丢弃未提交提案、楼层不标记；
 * - 任务输入 = 原始消息内容（不套清洗规则，ST Regex 由用户自行负责）。
 */
import type {
  MemoryEvidenceId,
  MemoryRecordMutationContext,
  MemorySpaceId,
} from "@ste-memory/core/memory";
import type { MemoryEvidenceRepository, MemoryProposalPorts } from "@ste-memory/core/memory";
import { commitMemoryProposalBatch } from "@ste-memory/core/memory";
import { ProposalAgent, type LlmPort, type MemorySpaceReader } from "@ste-memory/core/memory/agent";
import { buildBlockEvidence, composeBlockPrompt } from "./fill-task-block.ts";
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
  type FloorLedgerEntry,
  type FloorLedgerRepository,
} from "./fill-task.ts";

/** 任务默认分块大小：每块楼层数 = 一次 Agent 调用 + 一个原子批次（api 同值）。 */
export const DEFAULT_FILL_TASK_BLOCK_SIZE = 20;

/** 单块 Agent run 的总超时（对齐 ProposalAgent 默认 5 分钟）。 */
const BLOCK_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface FillTaskSubmitInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 楼层闭区间 [from, to]（同步楼层 = ST 消息数组下标，0 基） */
  readonly from: number;
  readonly to: number;
  readonly blockSize?: number;
}

export interface FillTaskServiceOptions {
  readonly tasks: FillTaskRepository;
  readonly ledger: FloorLedgerRepository;
  /** 消息来源（楼层 → 原文；同步楼层随时从 ST 对话实时读取） */
  readonly source: FillTaskSource;
  /** 记忆空间只读端口（digest 构建 + query_records 工具共用） */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览/提交所需的领域访问端口（与 ProposalAgent 共用同一组 repository） */
  readonly ports: MemoryProposalPorts;
  /** 证据仓库：块证据复用既有行（memory_evidence 对同源唯一，重复处理不冲突） */
  readonly evidence: MemoryEvidenceRepository;
  /** 批次原子提交上下文（id 生成器 + displayText 等，见 core memory-record-mutations） */
  readonly commitContext: MemoryRecordMutationContext;
  /**
   * 原子事务运行器：批次提交 + 台账标记同一事务（api 语义：失败回滚不产生
   * 半批数据/半批状态）。由组合根注入 Dexie 事务（内部 repo 事务按 zone 合并）。
   */
  readonly runInTransaction: (work: () => Promise<void>) => Promise<void>;
  /** LLM 端口工厂：任务开始时读 ST 当前配置构造一次（模型+参数快照） */
  readonly createLlm: () => LlmPort;
  readonly createRunId?: () => string;
  readonly createEvidenceId: () => MemoryEvidenceId;
  readonly now?: () => string;
  /** 后台循环不允许未处理异常：失败标记出错时只能记录日志。 */
  readonly logError?: (message: string, error: unknown) => void;
}

export class FillTaskService {
  readonly #tasks: FillTaskRepository;
  readonly #ledger: FloorLedgerRepository;
  readonly #source: FillTaskSource;
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #evidence: MemoryEvidenceRepository;
  readonly #commitContext: MemoryRecordMutationContext;
  readonly #runInTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly #createLlm: () => LlmPort;
  readonly #createRunId: () => string;
  readonly #createEvidenceId: () => MemoryEvidenceId;
  readonly #now: () => string;
  readonly #logError: (message: string, error: unknown) => void;

  constructor(options: FillTaskServiceOptions) {
    this.#tasks = options.tasks;
    this.#ledger = options.ledger;
    this.#source = options.source;
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#evidence = options.evidence;
    this.#commitContext = options.commitContext;
    this.#runInTransaction = options.runInTransaction;
    this.#createLlm = options.createLlm;
    this.#createRunId = options.createRunId ?? (() => crypto.randomUUID());
    this.#createEvidenceId = options.createEvidenceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#logError = options.logError ?? (() => undefined);
  }

  /**
   * 手动触发填表任务：校验（楼层范围 / 单任务 / LLM 配置）通过后持久化任务行
   * 并启动后台分批循环，立即返回任务视图（状态 running）。
   */
  async submit(input: FillTaskSubmitInput): Promise<FillTaskView> {
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
    // 单空间单活动任务守卫——与 api 基线一致：冲突先于 LLM 配置检查
    // （两者都失败时用户看到冲突原因）；预检只决定报错优先级，
    // 真正防并发的是下面 createIfIdle 的原子检查 + 创建。
    const active = await this.#tasks.findActive(input.memorySpaceId);
    if (active) throw new FillTaskConflictError(active);
    // 配置缺失在提交时立即失败（createLlm 读 ST 当前配置，缺失抛中文错误），
    // 而不是等后台循环启动后才失败。
    const llm = this.#createLlm();

    const now = this.#now();
    const task: FillTask = {
      runId: this.#createRunId(),
      memorySpaceId: input.memorySpaceId,
      from: input.from,
      to: input.to,
      blockSize,
      // 对话身份快照：块开始前检测对话切换（防止把新对话的消息写进旧空间）
      chatId: this.#source.chatId() ?? null,
      status: "running",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    // 原子守卫创建（并发双提交兜底）：预检与写入之间被抢占时仍拒绝
    const conflict = await this.#tasks.createIfIdle(input.memorySpaceId, task);
    if (conflict) throw new FillTaskConflictError(conflict);

    // 后台循环不阻塞提交请求；所有异常在循环内部收口为任务失败。
    void this.#runTask(task, llm);
    return this.#toView(task);
  }

  /** 用户取消：立即置 interrupted（与关 tab 同态）；循环在安全点停止，不自动重放。 */
  async cancel(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const applied = await this.#tasks.markInterrupted(runId);
    if (!applied) throw new FillTaskStateError(task);
    return this.#toView({ ...task, status: "interrupted" });
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

  /** 启动时调用（页面/浏览器重开）：所有非终态任务标记 interrupted，不自动重放。 */
  async markInterruptedOnStartup(): Promise<void> {
    await this.#tasks.markInterruptedOnStartup();
  }

  /** 楼层台账状态（闭区间 [from, to]，untracked = 无行）：触发 UI「未处理范围」提示的数据源。 */
  async ledgerStatuses(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<readonly FloorLedgerEntry[]> {
    return this.#ledger.statuses(memorySpaceId, from, to);
  }

  async #requireTask(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTask> {
    const task = await this.#tasks.find(runId);
    if (task === undefined || task.memorySpaceId !== memorySpaceId) {
      throw new FillTaskNotFoundError();
    }
    return task;
  }

  /** 任务视图：任务行 + 实时已处理计数（台账 processed 楼层数）+ 范围总楼层数。 */
  async #toView(task: FillTask): Promise<FillTaskView> {
    const processedCount = await this.#ledger.processedCount(
      task.memorySpaceId,
      task.from,
      task.to,
    );
    return { ...task, processedCount, totalCount: task.to - task.from + 1 };
  }

  /**
   * 分批循环：每块一次 Agent 调用 + 一个原子批次；失败标记出错块并停止。
   *
   * 安全点（不打断正在运行的 LLM 请求）：
   * - 块开始前：任务已非 running（用户取消/页面重开）→ 直接停止；
   * - 块内提交前：任务已非 running → 丢弃未提交提案，块楼层保持原状态。
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
        // 安全点 1：块开始前。用户取消/启动中断已落库 → 直接停止。
        if (await this.#isStopped(task.runId)) return;
        // 安全点 1b：对话已切换（楼层归属的对话变了）→ 失败停止，楼层不标记。
        if (!(await this.#chatUnchanged(task))) {
          await this.#failTask(
            task,
            undefined,
            new Error("对话已切换，填表任务停止：请回到原对话后重新触发"),
          );
          return;
        }
        const blockTo = Math.min(blockFrom + task.blockSize - 1, task.to);
        failingBlock = { from: blockFrom, to: blockTo };
        await this.#processBlock(agent, task, blockFrom, blockTo);
        // 本块已成功提交：后续失败（如终态标记）不得再把它标记为 error。
        failingBlock = undefined;
      }
      await this.#tasks.markSucceeded(task.runId);
    } catch (error) {
      // 取消已落地（任务行终态）：不再标记 error/failed——用户取消的楼层保持
      // untracked（天然可重试），任务保持 interrupted。
      // 收口本身也可能失败（页面/测试拆除期数据库已关闭）：只能记录日志，
      // 绝不能让后台循环产生未处理拒绝（void 链的拒绝无人观察）。
      try {
        const current = await this.#tasks.find(task.runId);
        if (current === undefined || isFillTaskTerminal(current.status)) return;
        await this.#failTask(task, failingBlock, error);
      } catch (teardownError) {
        this.#logError(`填表任务 ${task.runId} 失败收口出错`, teardownError);
      }
    }
  }

  /** 安全点检查：任务行不存在或已终态（含取消落库的 interrupted）→ 停止循环。 */
  async #isStopped(runId: string): Promise<boolean> {
    const task = await this.#tasks.find(runId);
    return task === undefined || isFillTaskTerminal(task.status);
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
    agent: ProposalAgent,
    task: FillTask,
    from: number,
    to: number,
  ): Promise<void> {
    const messages = this.#source.messagesInRange(from, to);
    if (messages.length === 0) {
      throw new Error(`消息块 [${from}, ${to}] 内没有可处理的消息`);
    }
    const evidence = await buildBlockEvidence(
      (memorySpaceId, sourceType, sourceId) =>
        this.#evidence.findEvidence(memorySpaceId, sourceType, sourceId),
      this.#createEvidenceId,
      task.memorySpaceId,
      messages,
    );
    const result = await agent.run(
      {
        memorySpaceId: task.memorySpaceId,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: composeBlockPrompt(from, to, messages) }],
            timestamp: Date.now(),
          },
        ],
        messageRange: { from, to },
        evidence,
      },
      {},
    );
    if (result.errorMessage !== undefined) {
      throw new Error(`Agent 运行失败：${result.errorMessage}`);
    }
    // 安全点 2：提交前。用户取消已落地 → 丢弃未提交提案（楼层不标记，供重试）。
    if (await this.#isStopped(task.runId)) return;
    if (result.proposal) {
      // 批次提交与台账标记同一事务：提交失败回滚时状态也不落库。
      await this.#runInTransaction(async () => {
        await commitMemoryProposalBatch(
          this.#commitContext,
          task.memorySpaceId,
          result.proposal!,
          "agent",
        );
        await this.#ledger.markProcessed(
          task.memorySpaceId,
          messages.map((message) => message.floor),
        );
      });
    } else {
      // 空提案：Agent 确认无需变更，本块按成功处理（可再次提交任务重试）。
      await this.#ledger.markProcessed(
        task.memorySpaceId,
        messages.map((message) => message.floor),
      );
    }
  }

  /** 失败收口：只把出错块的楼层标记 error，已成功批次保持 processed，任务置 failed。 */
  async #failTask(
    task: FillTask,
    failingBlock: { readonly from: number; readonly to: number } | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      if (failingBlock) {
        const failing = this.#source.messagesInRange(failingBlock.from, failingBlock.to);
        if (failing.length > 0) {
          await this.#ledger.markError(
            task.memorySpaceId,
            failing.map((item) => item.floor),
          );
        }
      }
      await this.#tasks.markFailed(task.runId, message);
    } catch (markError) {
      this.#logError(`填表任务 ${task.runId} 失败状态标记出错`, markError);
    }
  }
}
