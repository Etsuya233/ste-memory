/**
 * 记忆助手的应用编排：发送消息、确认提案、放弃提案。
 *
 * 会话模块负责一轮对话的消息、提案检查点与结束状态；这里负责调用 Agent、
 * 准备可供用户确认的提案，以及通过 MemoryRecordService 执行记录变更。
 * LLM 经宿主注入，不在这里处理 HTTP/SSE 或模型厂商协议。
 *
 * 三个入口都在会话独占锁内执行，回调拿到的是持久化的最新会话。
 * 发送消息只准备提案；确认提交会再次检查对话归属、预览内容和记录修订。
 * 模型失败以聊天错误展示；锁、会话加载和保存失败继续向调用方传播。
 */
import type { SemanticQueryExecutor } from "../semantic-query/semantic-query-session.ts";
import {
  MemoryCommitPersistenceError,
  MemoryRecordSaveError,
  memoryProposalSubmission,
  memoryProposalBatch,
  validateProposalOperations,
  previewProposal,
  type MemoryProposalPorts,
  type MemoryProposalSubmission,
  type MemoryRecordService,
  type MemorySpaceReader,
  type MemorySpaceId,
} from "../memory/index.ts";
import {
  buildMemorySpaceTableDigest,
  composeInteractiveProposalAgentSystemPrompt,
  compileProposalOperations,
  ProposalState,
  type LlmPort,
  type ProposalPreviewToolResult,
} from "../agent/index.ts";
import { runFillAgent } from "../agent/fill-agent-runner.ts";
import type { QueryChatStore, AssistantContext } from "./session-store.ts";
import {
  errorMessage,
  terminalQueryChatEvent,
  type QueryChatCommitResult,
  type QueryChatEvent,
} from "./query-chat-state.ts";

/** 一轮 Agent 请求的总超时；取消和超时都保留已经完成的工具及提案检查点。 */
export const QUERY_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
export const QUERY_CHAT_SPACE_SWITCHED_NOTICE = "对话已切换，变更未提交";

export interface QueryChatServiceOptions {
  readonly store: QueryChatStore;
  /** 普通查询和语义 SQL 共用已有查询执行器。 */
  readonly semanticQuery?: SemanticQueryExecutor;
  /** 表和字段摘要、只读记录查询，与 Agent 工具共用。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验和差异预览所需的领域访问，与写入使用相同的数据来源。 */
  readonly ports: MemoryProposalPorts;
  /** 实际事务、引用与修订校验由 MemoryRecordService 管理。 */
  readonly recordWriter: Pick<MemoryRecordService, "commitProposal">;
  /** 每轮创建连接快照，运行中不读取后续连接修改。 */
  readonly createLlm: () => LlmPort;
  /** generation 用来识别确认期间 A→B→A 的对话切换。 */
  readonly getCurrentContext: () =>
    (AssistantContext & { readonly generation?: number }) | undefined;
  readonly timeoutMs?: number;
}
export interface QueryChatRunInput {
  readonly sessionId: string;
  readonly text: string;
}

export class QueryChatService {
  readonly store: QueryChatStore;
  readonly #options: QueryChatServiceOptions;
  constructor(options: QueryChatServiceOptions) {
    this.#options = options;
    this.store = options.store;
  }

  /** 接收消息后先保存输入，再运行模型；结束时统一保存本轮历史、提案和预览。 */
  async run(input: QueryChatRunInput): Promise<void> {
    return this.store.withExclusiveSession(input.sessionId, async (session, signal) => {
      this.#assertContext(session);
      if (!input.text.trim()) throw new Error("消息不能为空");
      const run = this.store.startRun(session.id, input.text);
      let terminal: QueryChatEvent;
      let preview: ProposalPreviewToolResult | undefined;
      try {
        // 即使连接创建失败，用户刚发出的请求也已经保存在会话中。
        await this.store.flush();
        const llm = this.#options.createLlm();
        const digest = await buildMemorySpaceTableDigest(this.#options.reader, session.spaceId);
        if (signal.aborted) throw new Error("已取消");
        const result = await runFillAgent({
          llm,
          reader: this.#options.reader,
          ports: this.#options.ports,
          memorySpaceId: session.spaceId,
          digest,
          state: run.proposal,
          history: session.transcript,
          semanticQuery: this.#options.semanticQuery,
          confirmationRequired: true,
          composedMessages: [
            { role: "system", text: composeInteractiveProposalAgentSystemPrompt(digest) },
          ],
          messages: [run.input],
          // 交互消息不对应 ST 楼层，也不自动附加剧情证据。
          messageRange: { from: 0, to: 0 },
          evidence: [],
          timeoutMs: this.#options.timeoutMs ?? QUERY_CHAT_TIMEOUT_MS,
          signal,
          onEvent: (event) => this.store.recordAgentEvent(session.id, run.pendingId, event),
        });
        terminal = terminalQueryChatEvent(result, signal);
        if (run.proposal.operations.length && result.stopReason === "stop" && !signal.aborted)
          preview = (await this.#prepareProposal(session.spaceId, run.proposal)).preview;
      } catch (cause) {
        terminal = { type: "error", message: errorMessage(cause) };
      }
      // 删除会话会撤销本轮归属；Store 会忽略迟到的结束事件，不重建已删除会话。
      this.store.finishRun(session.id, run.pendingId, terminal, preview);
    });
  }

  /** 确认绑定用户看过的预览；排队等待锁的时间也计入对话切换校验。 */
  async confirm(id: string, previewId: string): Promise<QueryChatCommitResult> {
    const origin = this.#assertContext(this.store.get(id));
    return this.store.withExclusiveSession(id, async (session, signal) => {
      this.#assertContext(session, origin.generation);
      const reviewed = this.store.beginCommit(id, previewId);
      let result: QueryChatCommitResult;
      try {
        // 在实际写入前留下 committing 检查点；页面退出后才能提示核对提交结果。
        await this.store.flush();
        const prepared = await this.#prepareProposal(
          session.spaceId,
          new ProposalState(session.proposal),
        );
        if (!prepared.preview.valid)
          throw new Error(prepared.preview.errors.map((error) => error.message).join("；"));
        if (JSON.stringify(prepared.preview.operations) !== JSON.stringify(reviewed.operations))
          throw new Error("记录或表结构已变化，请让助手重新预览提案后确认");
        signal.throwIfAborted();
        this.#assertContext(session, origin.generation);
        result = await this.#writeProposal(session.spaceId, prepared.proposal);
      } catch (cause) {
        result = { status: "failed", error: errorMessage(cause) };
      }
      // 提交回执、草稿清理与 idle 状态在一个会话快照中保存。
      this.store.finishCommit(id, result);
      return result;
    });
  }

  async discard(id: string): Promise<void> {
    return this.store.withExclusiveSession(id, async () => {
      this.store.discardProposal(id);
    });
  }

  /** 应用编排直接使用领域校验与预览；Agent 工具是同一能力的另一个调用入口。 */
  async #prepareProposal(spaceId: MemorySpaceId, state: ProposalState) {
    const digest = await buildMemorySpaceTableDigest(this.#options.reader, spaceId);
    const operations = compileProposalOperations(digest, state);
    const errors = await validateProposalOperations(this.#options.ports, spaceId, operations);
    const difference = await previewProposal(this.#options.ports, spaceId, operations);
    return {
      preview: {
        ...difference,
        valid: errors.length === 0,
        errors: errors.map((error) => ({ mutationId: error.externalId, message: error.message })),
      },
      proposal: memoryProposalSubmission(
        { from: 0, to: 0 },
        [],
        difference.operations,
        memoryProposalBatch(operations),
      ),
    };
  }

  /** 只在实际写入处识别“已提交但快照保存失败”，避免把它当作可重试的变更。 */
  async #writeProposal(
    spaceId: MemorySpaceId,
    proposal: MemoryProposalSubmission,
  ): Promise<QueryChatCommitResult> {
    let warning: string | undefined;
    try {
      await this.#options.recordWriter.commitProposal(spaceId, proposal, "agent");
    } catch (cause) {
      // 单条 create/update 会被领域层包装为 MemoryRecordSaveError；批量写入保留原错误。
      if (
        !(cause instanceof MemoryCommitPersistenceError) &&
        !(cause instanceof MemoryRecordSaveError)
      )
        throw cause;
      warning = `记录已提交，快照保存失败：${cause.message}。请使用工作台的保存重试。`;
    }
    return {
      status: "committed",
      created: proposal.batch.create.length,
      updated: proposal.batch.update.length,
      deleted: proposal.batch.delete.length,
      ...(warning === undefined ? {} : { warning }),
    };
  }

  #assertContext(context: AssistantContext, generation?: number) {
    const current = this.#options.getCurrentContext();
    if (
      !current ||
      current.chatKey !== context.chatKey ||
      current.spaceId !== context.spaceId ||
      (generation !== undefined && generation !== current.generation)
    )
      throw new Error(QUERY_CHAT_SPACE_SWITCHED_NOTICE);
    return current;
  }
}
