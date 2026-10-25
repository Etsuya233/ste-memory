/** 填表任务在独占 SQLite 连接上跨分块暂存修改，最终统一提交与保存。
 * 失败或取消回滚整个任务；楼层台账在保存后单独更新。
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
import { applyCleaningRules, type CleaningRule } from "../cleaning/cleaning-rule-lists.ts";
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
  type FloorLedgerEntry,
  type FloorLedgerRepository,
  type FillSourceMessage,
} from "./fill-task.ts";

/** 任务默认分块大小：每块楼层数对应一次 Agent 循环；事务跨越整个任务。 */
export const DEFAULT_FILL_TASK_BLOCK_SIZE = 20;

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
 * 填表任务编排上下文（ADR 0024 组装迁移）：**纯数据**，宿主在任务提交时构造
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
}

/** 初始化填表提交输入（spec init-fill）：输入 = 用户初始化文本框内容，无楼层。 */
export interface FillTaskInitInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 初始化输入文本（允许为空串：仅凭预设内容初始化；trim 后为空不拦截）。 */
  readonly text: string;
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
   * 编排上下文工厂（ADR 0024 组装迁移）：任务提交时构造一次，返回**纯数据**
   * （活动预设 + 占位符展开快照，无方法）；接收任务范围合并剧情文本
   * （{{worldbook}} 扫描输入）；块处理时由 service 直接展开编排消息。
   * 缺省/返回 undefined = 系统默认预设（核心默认提示词）。
   */
  readonly createPromptContext?: (storyText: string) => Promise<FillTaskPromptContext | undefined>;
  /** 通用日志仓库（独立数据库，ADR 0015）：填表开始行在此写入（best-effort，失败不影响任务）。 */
  readonly logs: LogRepository;
  /**
   * 填表任务内容清洗（ticket 22 / ADR 0011）：任务开始时冻结当前对话所选
   * 清洗规则列表的规则；未选择/列表已删 → 空（不清洗）。缺省 = 不清洗。
   */
  readonly resolveCleaningRules?: () => readonly CleaningRule[];
  readonly createRunId?: () => string;
  readonly createEvidenceId: () => MemoryEvidenceId;
  readonly now?: () => string;
  /** 后台循环不允许未处理异常：失败标记出错时只能记录日志。 */
  readonly logError?: (message: string, error: unknown) => void;
}

export class FillTaskService {
  readonly #readAgentTimeoutMs: () => number;
  readonly #tasks: FillTaskRepository;
  readonly #ledger: FloorLedgerRepository;
  readonly #source: FillTaskSource;
  readonly #beginTask: BeginFillTaskSession;
  readonly #runs = new Map<
    string,
    {
      controller: AbortController;
      phase: "running" | "saving";
      stagedCount: number;
      done: Promise<void>;
    }
  >();
  readonly #runInTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly #createLlm: () => LlmPort;
  readonly #createPromptContext:
    ((storyText: string) => Promise<FillTaskPromptContext | undefined>) | undefined;
  readonly #logs: LogRepository;
  readonly #resolveCleaningRules: () => readonly CleaningRule[];
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
    this.#resolveCleaningRules = options.resolveCleaningRules ?? (() => []);
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
    const frozenInput = structuredClone(this.#source.messagesInRange(input.from, input.to));
    const frozenRules = structuredClone(this.#resolveCleaningRules());
    const chatId = this.#source.chatId() ?? null;
    // 单空间单活动任务守卫——与 api 基线一致：冲突先于 LLM 配置检查
    // （两者都失败时用户看到冲突原因）；预检只决定报错优先级，
    // 真正防并发的是下面 createIfIdle 的原子检查 + 创建。
    const active = await this.#tasks.findActive(input.memorySpaceId);
    if (active) throw new FillTaskConflictError(active);
    // 配置缺失在提交时立即失败（createLlm 读 ST 当前配置，缺失抛中文错误），
    // 而不是等后台循环启动后才失败。
    const llm = this.#createLlm();
    // 合并剧情文本（世界书扫描输入，ADR 0007）：仅当宿主注入编排上下文工厂时
    // 才构建（缺省 = 系统默认预设 → 核心默认提示词，无扫描无构建）。
    const promptContext =
      this.#createPromptContext === undefined
        ? undefined
        : await this.#createPromptContext(buildMergedStoryText(frozenInput));

    const now = this.#now();
    const task: FillTask = {
      runId: this.#createRunId(),
      memorySpaceId: input.memorySpaceId,
      from: input.from,
      to: input.to,
      blockSize,
      kind: "floor",
      initText: null,
      // 对话身份快照：块开始前检测对话切换（防止把新对话的消息写进旧空间）
      chatId,
      status: "running",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    // 原子守卫创建（并发双提交兜底）：预检与写入之间被抢占时仍拒绝
    const conflict = await this.#tasks.createIfIdle(input.memorySpaceId, task);
    if (conflict) throw new FillTaskConflictError(conflict);

    // 任务开始行先落库（best-effort），再启动后台循环：日志按时间序呈现任务起点。
    await this.#appendLog(fillTaskStartLog(task), `填表任务 ${task.runId} 开始日志写入失败`);

    // 后台循环不阻塞提交请求；所有异常在循环内部收口为任务失败。
    this.#startTask(task, llm, promptContext, frozenInput, frozenRules);
    return this.#toView(task);
  }

  /** 中止模型请求，等整任务回滚后再发布 interrupted。提交保存期间拒绝取消。 */
  async cancel(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const run = this.#runs.get(runId);
    if (!run || run.phase === "saving" || task.status !== "running")
      throw new FillTaskStateError(task);
    run.controller.abort(new Error("用户取消填表任务"));
    await run.done;
    return this.#toView(await this.#requireTask(memorySpaceId, runId));
  }

  /** 宿主切换对话时立即取消运行阶段；保存阶段继续使用已捕获的旧对话身份。 */
  async interruptForChatChange(): Promise<void> {
    const runs = [...this.#runs.values()].filter((run) => run.phase === "running");
    for (const run of runs) run.controller.abort(new Error("对话已切换，填表任务已取消"));
    await Promise.all(runs.map((run) => run.done));
  }

  /**
   * 初始化填表提交（spec init-fill）：输入 = 初始化文本框内容（作为 {{msg}}
   * 语义的 msg，无楼层）。与楼层任务共享单空间单活动任务守卫与 LLM 配置预检；
   * 任务行持久化 initText（retry 依赖）；无楼层校验、不做任何状态干预。
   */
  async submitInit(input: FillTaskInitInput): Promise<FillTaskView> {
    const frozenInput = [{ floor: 0, name: "", content: input.text }];
    const frozenRules = structuredClone(this.#resolveCleaningRules());
    const chatId = this.#source.chatId() ?? null;
    // 单空间单活动任务守卫——与 submit 同语义（init 与楼层任务互斥）
    const active = await this.#tasks.findActive(input.memorySpaceId);
    if (active) throw new FillTaskConflictError(active);
    // 配置缺失在提交时立即失败（同 submit）
    const llm = this.#createLlm();
    // 世界书扫描输入 = 初始化文本（{{worldbook}} 展开源，同 submit 的合并剧情文本）
    const promptContext =
      this.#createPromptContext === undefined
        ? undefined
        : await this.#createPromptContext(input.text);

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
      chatId,
      status: "running",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    // 原子守卫创建（并发双提交兜底，同 submit）
    const conflict = await this.#tasks.createIfIdle(input.memorySpaceId, task);
    if (conflict) throw new FillTaskConflictError(conflict);

    await this.#appendLog(fillTaskStartLog(task), `填表任务 ${task.runId} 开始日志写入失败`);

    this.#startTask(task, llm, promptContext, frozenInput, frozenRules);
    return this.#toView(task);
  }

  /**
   * 任务重试（ticket 14）：把任务的楼层范围与分块大小重新提交为新任务——
   * 失败/中断任务的历史条目由此回到运行中；原任务保持终态留在历史列表。
   * 重试运行中任务被活动任务守卫拒绝（冲突原因可读，快速双击重试时第二次
   * 提交落在新任务的活动名额上，不会产生双任务）；重试已成功任务等同于手动
   * 重新触发同一范围（触发 UI 不提供该入口）。
   * 初始化任务（kind=init）重试复用持久化的 initText 走 submitInit。
   */
  async retry(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    if (task.kind === "init") {
      return this.submitInit({ memorySpaceId, text: task.initText });
    }
    return this.submit({
      memorySpaceId,
      from: task.from,
      to: task.to,
      blockSize: task.blockSize,
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
    const progress = run === undefined ? {} : { stagedCount: run.stagedCount, phase: run.phase };
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

  /** 冻结任务输入，并在后台持有单个跨分块事务。 */
  #startTask(
    task: FillTask,
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
    input: readonly FillSourceMessage[],
    rules: readonly CleaningRule[],
  ): void {
    const controller = new AbortController();
    const control = {
      controller,
      phase: "running" as "running" | "saving",
      stagedCount: 0,
      done: Promise.resolve(),
    };
    this.#runs.set(task.runId, control);
    control.done = this.#runTask(
      task,
      llm,
      promptContext === undefined ? undefined : structuredClone(promptContext),
      input,
      rules,
      control,
    );
  }

  async #runTask(
    task: FillTask,
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
    input: readonly FillSourceMessage[],
    rules: readonly CleaningRule[],
    control: { controller: AbortController; phase: "running" | "saving"; stagedCount: number },
  ): Promise<void> {
    let session: FillTaskSession | undefined;
    let committed = false;
    try {
      control.controller.signal.throwIfAborted();
      session = await this.#beginTask(task, control.controller.signal);
      for (let from = task.from; from <= task.to; from += task.blockSize) {
        control.controller.signal.throwIfAborted();
        if (await this.#isStopped(task.runId)) throw new Error("填表任务已停止");
        if (!(await this.#chatUnchanged(task))) {
          control.controller.abort(new Error("对话已切换，填表任务已取消"));
          control.controller.signal.throwIfAborted();
        }
        const to = Math.min(from + task.blockSize - 1, task.to);
        await this.#processBlock(
          llm,
          promptContext,
          task,
          (from - task.from) / task.blockSize + 1,
          from,
          to,
          session,
          input.filter((message) => message.floor >= from && message.floor <= to),
          rules,
          control.controller.signal,
        );
        control.stagedCount += input.filter(
          (message) => message.floor >= from && message.floor <= to,
        ).length;
      }
      if (!(await this.#isRunning(task.runId))) throw new Error("填表任务已停止");
      if (!(await this.#chatUnchanged(task)))
        control.controller.abort(new Error("对话已切换，填表任务已取消"));
      if (
        task.kind !== "init" &&
        JSON.stringify(input) !== JSON.stringify(this.#source.messagesInRange(task.from, task.to))
      )
        throw new Error("填表输入消息已变化，本次修改已撤销，请重新填表");
      // 最后一次取消检查与阶段切换之间没有 await：取消与提交只会选中一个分支。
      control.controller.signal.throwIfAborted();
      control.phase = "saving";
      await session.commitAndSave();
      committed = true;
      await this.#runInTransaction(async () => {
        if (task.kind !== "init")
          await this.#ledger.markProcessed(
            task.memorySpaceId,
            input.map((message) => message.floor),
          );
        await this.#tasks.markSucceeded(task.runId);
      });
      await this.#appendLog(
        fillTaskEndLog({ task, status: "succeeded", errorMessage: null, endedAt: this.#now() }),
        `填表任务 ${task.runId} 结束日志写入失败`,
      );
    } catch (error) {
      try {
        if (!committed) await session?.rollback();
        if (control.controller.signal.aborted) {
          const applied = await this.#tasks.markInterrupted(task.runId);
          if (applied)
            await this.#appendLog(
              fillTaskEndLog({
                task,
                status: "interrupted",
                errorMessage: null,
                endedAt: this.#now(),
              }),
              `填表任务 ${task.runId} 结束日志写入失败`,
            );
        } else {
          const current = await this.#tasks.find(task.runId);
          if (current && !isFillTaskTerminal(current.status)) await this.#failTask(task, error);
        }
      } catch (cleanupError) {
        this.#logError(`填表任务 ${task.runId} 失败收口出错`, cleanupError);
      }
    } finally {
      try {
        await session?.release();
      } catch (error) {
        this.#logError("释放填表写入许可失败", error);
      }
      this.#runs.delete(task.runId);
    }
  }

  /** 安全点检查：任务行不存在或已终态（含取消落库的 interrupted）→ 停止循环。 */
  async #isStopped(runId: string): Promise<boolean> {
    const task = await this.#tasks.find(runId);
    return task === undefined || isFillTaskTerminal(task.status);
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
    cleaningRules: readonly CleaningRule[],
    signal: AbortSignal,
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
      const messages =
        cleaningRules.length === 0
          ? rawMessages
          : rawMessages.map((message) => ({
              ...message,
              content: applyCleaningRules(message.content, cleaningRules),
            }));
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
      });
      // 轮次行已全部入队：批收尾行落库前等写入链清空（行序 = 批内时间序，best-effort 写入不抛）。
      await collector.flush();
      if (result.errorMessage !== undefined) {
        throw new Error(`Agent 运行失败：${result.errorMessage}`);
      }
      signal.throwIfAborted();
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

  /** 失败只更新任务状态，整任务回滚后旧楼层台账保持原样。 */
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
