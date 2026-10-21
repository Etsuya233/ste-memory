/**
 * FillTaskService：填表后台任务（ticket 13）的应用层编排（浏览器侧）。
 *
 * 浏览器侧状态机
 * 按本票简化：无 queued/pause/cancel_requested，取消与关页同态落 interrupted）：
 * - 提交任务 = { memorySpaceId, [from, to] 闭区间（同步楼层，0 基）, blockSize? }，
 *   默认块大小 20；单空间单活动任务守卫（原子 createIfIdle，冲突携带当前任务）；
 * - 分批循环：每块注入块消息为证据 + 块范围为 messageRange → 组装模块
 *   （src/agent/fill-agent-runner，ADR 0024）→ 批次与台账 markProcessed 同一事务
 *   原子提交（失败整批回滚）→ 下一块；
 *   空提案（Agent 确认无需变更）按成功处理（仅 markProcessed）；
 * - 任何块失败：出错块楼层 markError（可重试）、任务 failed 并停止，失败原因可读；
 * - 安全点（块开始前、块提交前）：检查任务行——用户取消（markInterrupted）或
 *   页面重开（启动标记）后循环在安全点停止，丢弃未提交提案、楼层不标记；
 * - 任务输入 = 原始消息内容；注入 resolveCleaningRules 时按清洗规则列表清洗
 *   （ticket 22 / ADR 0011，块处理时实时读取，改规则追溯生效），缺省不清洗。
 */
import type { MemoryEvidenceId, MemoryRecordService, MemorySpaceId } from "../memory/index.ts";
import type { MemoryEvidenceRepository, MemoryProposalPorts } from "../memory/index.ts";
import {
  buildMemorySpaceTableDigest,
  composeProposalAgentMessages,
  type ComposedAgentMessage,
  type LlmPort,
} from "../agent/index.ts";
import type { MemorySpaceReader } from "../memory/index.ts";
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
} from "./fill-task.ts";

/** 任务默认分块大小：每块楼层数 = 一次 Agent 调用 + 一个原子批次（api 同值）。 */
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
  /** 记忆空间只读端口（digest 构建 + query_records 工具共用） */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览/提交所需的领域访问端口（与 ProposalAgent 共用同一组 repository） */
  readonly ports: MemoryProposalPorts;
  /** 证据仓库：块证据复用既有行（memory_evidence 对同源唯一，重复处理不冲突） */
  readonly evidence: MemoryEvidenceRepository;
  /** 完整提案提交操作；提交细节由 Memory 记录服务管理 */
  readonly recordWriter: Pick<MemoryRecordService, "commitProposal">;
  /**
   * 原子事务运行器：批次提交 + 台账标记同一事务（api 语义：失败回滚不产生
   * 半批数据/半批状态）。由组合根注入 Dexie 事务（内部 repo 事务按 zone 合并）。
   */
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
   * 填表任务内容清洗（ticket 22 / ADR 0011）：块处理时实时读取当前对话所选
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
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #evidence: MemoryEvidenceRepository;
  readonly #recordWriter: Pick<MemoryRecordService, "commitProposal">;
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
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#evidence = options.evidence;
    this.#recordWriter = options.recordWriter;
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
        : await this.#createPromptContext(
            buildMergedStoryText(this.#source.messagesInRange(input.from, input.to)),
          );

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
      chatId: this.#source.chatId() ?? null,
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
    void this.#runTask(task, llm, promptContext);
    return this.#toView(task);
  }

  /** 用户取消：立即置 interrupted（与关 tab 同态），写入任务中断结束行；
   *  循环在安全点停止，不自动重放。 */
  async cancel(memorySpaceId: MemorySpaceId, runId: string): Promise<FillTaskView> {
    const task = await this.#requireTask(memorySpaceId, runId);
    const applied = await this.#tasks.markInterrupted(runId);
    if (!applied) throw new FillTaskStateError(task);
    // 中断结束行在取消落地后立即写入（循环不再负责，避免重复）；
    // 正在运行的批由循环在安全点补写批中断结束行。
    await this.#appendLog(
      fillTaskEndLog({ task, status: "interrupted", errorMessage: null, endedAt: this.#now() }),
      `填表任务 ${task.runId} 结束日志写入失败`,
    );
    return this.#toView({ ...task, status: "interrupted" });
  }

  /**
   * 初始化填表提交（spec init-fill）：输入 = 初始化文本框内容（作为 {{msg}}
   * 语义的 msg，无楼层）。与楼层任务共享单空间单活动任务守卫与 LLM 配置预检；
   * 任务行持久化 initText（retry 依赖）；无楼层校验、不做任何状态干预。
   */
  async submitInit(input: FillTaskInitInput): Promise<FillTaskView> {
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
      chatId: this.#source.chatId() ?? null,
      status: "running",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    // 原子守卫创建（并发双提交兜底，同 submit）
    const conflict = await this.#tasks.createIfIdle(input.memorySpaceId, task);
    if (conflict) throw new FillTaskConflictError(conflict);

    await this.#appendLog(fillTaskStartLog(task), `填表任务 ${task.runId} 开始日志写入失败`);

    void this.#runTask(task, llm, promptContext);
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
    if (task.kind === "init") {
      return { ...task, processedCount: 0, totalCount: 1 };
    }
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
   *
   * 行流日志（ADR 0016）：任务结束行由各终态路径写入（成功/失败在循环内、
   * 中断在取消/启动标记处）；批开始/结束行由 #processBlock 写入。
   */
  async #runTask(
    task: FillTask,
    llm: LlmPort,
    promptContext: FillTaskPromptContext | undefined,
  ): Promise<void> {
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
        const batch = (blockFrom - task.from) / task.blockSize + 1;
        await this.#processBlock(llm, promptContext, task, batch, blockFrom, blockTo);
        // 本块已成功提交：后续失败（如终态标记）不得再把它标记为 error。
        failingBlock = undefined;
      }
      // 全部块提交成功 → 任务结束行（succeeded）。markSucceeded 返回 false =
      // 取消竞态先落地（interrupted）：结束行已由取消路径写入，不重复。
      const succeeded = await this.#tasks.markSucceeded(task.runId);
      if (succeeded) {
        await this.#appendLog(
          fillTaskEndLog({ task, status: "succeeded", errorMessage: null, endedAt: this.#now() }),
          `填表任务 ${task.runId} 结束日志写入失败`,
        );
      }
    } catch (error) {
      // 取消已落地（任务行终态）：不再标记 error/failed——用户取消的楼层保持
      // untracked（天然可重试），任务保持 interrupted，结束行由取消路径写入。
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
      // 输入源：楼层任务 = 对话消息（实时读）；初始化任务 = 合成单条消息
      // （楼层占位 0、名字为空、内容 = initText），无楼层、不进消息流。
      const rawMessages =
        task.kind === "init"
          ? [{ floor: 0, name: "", content: task.initText }]
          : this.#source.messagesInRange(from, to);
      if (rawMessages.length === 0) {
        throw new Error(`消息块 [${from}, ${to}] 内没有可处理的消息`);
      }
      // 清洗规则在块处理时实时读取（ADR 0011）：原文证据不变，喂给 Agent 的是
      // 清洗后内容（初始化文本同路径）；世界书扫描输入（submit 时合并的剧情文本）保持原文。
      const cleaningRules = this.#resolveCleaningRules();
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
                this.#evidence.findEvidence(memorySpaceId, sourceType, sourceId),
              this.#createEvidenceId,
              task.memorySpaceId,
              messages,
            );
      // 编排（ADR 0024 组装迁移）：digest 块内构建一次，同时喂消息展开与工具装配；
      // 活动预设 → composePresetMessages 纯函数展开（{{msg}} 输入 = 本块消息文本）；
      // 缺省 → 核心默认提示词文本函数（composeProposalAgentMessages，与预设展开
      // 同形状——单条 system 消息）。
      const msgText = composeBlockMessagesText(from, to, messages);
      const digest = await buildMemorySpaceTableDigest(this.#reader, task.memorySpaceId);
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
        reader: this.#reader,
        ports: this.#ports,
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
      // 安全点 2：提交前。用户取消已落地 → 丢弃未提交提案（楼层不标记，供重试），
      // 批以 interrupted 收尾（进行中的批也有完整的开始/结束行）。
      if (await this.#isStopped(task.runId)) {
        await this.#appendLog(
          fillRunEndLog({
            task,
            batch,
            from,
            to,
            status: "interrupted",
            errorMessage: null,
            startedAt,
            endedAt: this.#now(),
          }),
          `填表任务 ${task.runId} 批次 ${batch} 结束日志写入失败`,
        );
        return;
      }
      // 安全点 3（事务内）：任务行在写入事务里复检（running 才写入）。重建空间结构
      // 删除任务行与本次提交在任务表上互斥——重建已提交后旧任务不可能再写入
      // （空间结构也已换新，旧表/字段 ID 不再存在）。空提案同路径：只标记台账，
      // 不产生记忆数据，但同样不得落在重建之后。
      // 本批是否真正写入（批结束行状态以此为据）：取消落在提交之后不改写已完成的批。
      let applied = false;
      if (result.proposal) {
        // 批次提交与台账标记同一事务：提交失败回滚时状态也不落库。
        // 初始化任务无楼层：只提交批次，不标记台账。
        await this.#runInTransaction(async () => {
          if (!(await this.#isRunning(task.runId))) return;
          await this.#recordWriter.commitProposal(task.memorySpaceId, result.proposal!, "agent");
          if (task.kind !== "init") {
            await this.#ledger.markProcessed(
              task.memorySpaceId,
              messages.map((message) => message.floor),
            );
          }
          applied = true;
        });
      } else {
        // 空提案：Agent 确认无需变更，本块按成功处理（可再次提交任务重试）。
        await this.#runInTransaction(async () => {
          if (!(await this.#isRunning(task.runId))) return;
          if (task.kind !== "init") {
            await this.#ledger.markProcessed(
              task.memorySpaceId,
              messages.map((message) => message.floor),
            );
          }
          applied = true;
        });
      }
      // 批结束行：本批已写入 → succeeded（info 级）；被安全点 3 拦下（取消落地/任务行消失）
      // → interrupted（warn）——状态取自本批的实际结果，其后的取消不改写已完成的批。
      await this.#appendLog(
        fillRunEndLog({
          task,
          batch,
          from,
          to,
          status: applied ? "succeeded" : "interrupted",
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
      const interrupted = current !== undefined && current.status === "interrupted";
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

  /** 失败收口：任务置 failed + 出错块楼层标记 error，已成功批次保持 processed。
   *  取消竞态（markFailed 未生效）时什么都不做——结束行已由取消路径写入。
   *  初始化任务无楼层：跳过台账标记，只置 failed。 */
  async #failTask(
    task: FillTask,
    failingBlock: { readonly from: number; readonly to: number } | undefined,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const applied = await this.#tasks.markFailed(task.runId, message);
      if (!applied) return;
    } catch (markError) {
      this.#logError(`填表任务 ${task.runId} 失败状态标记出错`, markError);
      return;
    }
    if (failingBlock && task.kind !== "init") {
      try {
        const failing = this.#source.messagesInRange(failingBlock.from, failingBlock.to);
        if (failing.length > 0) {
          await this.#ledger.markError(
            task.memorySpaceId,
            failing.map((item) => item.floor),
          );
        }
      } catch (markError) {
        this.#logError(`填表任务 ${task.runId} 出错楼层标记出错`, markError);
      }
    }
    // 任务结束行（failed，error 级）：出错批的结束行（error 级）已由
    // #processBlock 在抛出前写入，任务结束行随后写入，时间序正确。
    await this.#appendLog(
      fillTaskEndLog({ task, status: "failed", errorMessage: message, endedAt: this.#now() }),
      `填表任务 ${task.runId} 结束日志写入失败`,
    );
  }
}
