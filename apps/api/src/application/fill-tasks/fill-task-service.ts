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
 * 状态机（queued/paused/cancelled/interrupted 等）与轮询/暂停/恢复归 ticket 14；
 * 本票只持久化 running/succeeded/failed 三态，供单任务限制与只读检查使用。
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
import type { FillTask, FillTaskRepository } from "../ports/fill-task.ts";
import type { MemorySpaceManager } from "../ports/memory-space.ts";
import type { SourceChatRepository } from "../ports/source-chat.ts";
import type { CleaningRuleRepository } from "../ports/cleaning-rule.ts";
import { buildBlockEvidence, composeBlockPrompt } from "./fill-task-block.ts";
import { applyCleaningRules } from "../cleaning-rules/transform.ts";
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

/** 同一记忆空间已有非终态任务（提交冲突；HTTP 层映射 409）。 */
export class FillTaskConflictError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`该记忆空间已有正在进行的填表任务（${task.runId}），请等待其结束`);
    this.name = "FillTaskConflictError";
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

export class FillTaskService {
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
  }

  /** 当前非终态任务（无则 undefined）。 */
  async activeTask(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined> {
    return this.#tasks.findActive(memorySpaceId);
  }

  /**
   * 提交填表任务：校验（空间存在 / 范围 / 单任务 / LLM 配置）通过后
   * 持久化任务行并启动后台分批循环，立即返回任务视图。
   */
  async submit(input: FillTaskSubmitInput): Promise<FillTask> {
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
      status: "running",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#tasks.create(task);
    } catch (error) {
      // 并发提交竞态：唯一索引兜底；已存在的活动任务按冲突返回。
      const active = await this.#tasks.findActive(input.memorySpaceId);
      if (active) throw new FillTaskConflictError(active);
      throw error;
    }
    const llm = this.#buildLlmPort(config);
    // 后台循环不阻塞提交请求；所有异常在循环内部收口为任务失败。
    void this.#runTask(task, llm);
    return task;
  }

  /** 分批循环：每块一次 Agent 调用 + 一个原子批次；失败标记出错块并停止。 */
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
        const blockTo = Math.min(blockFrom + task.blockSize - 1, task.to);
        failingBlock = { from: blockFrom, to: blockTo };
        await this.#processBlock(agent, task, blockFrom, blockTo);
        // 本块已成功提交：后续失败（如终态标记）不得再把它标记为 error。
        failingBlock = undefined;
      }
      await this.#tasks.markSucceeded(task.runId);
    } catch (error) {
      await this.#failTask(task, failingBlock, error);
    }
  }

  async #processBlock(
    agent: ProposalAgent,
    task: FillTask,
    from: number,
    to: number,
  ): Promise<void> {
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
    const result = await agent.run({
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
    });
    if (result.errorMessage !== undefined) {
      throw new Error(`Agent 运行失败：${result.errorMessage}`);
    }
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
    } catch (markError) {
      this.#logError(`填表任务 ${task.runId} 失败状态标记出错`, markError);
    }
  }
}
