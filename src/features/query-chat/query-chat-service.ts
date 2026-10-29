import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { StopReason } from "@earendil-works/pi-ai";
import type { SemanticQueryExecutor } from "../semantic-query/semantic-query-session.ts";
import {
  MemoryCommitPersistenceError,
  MemoryRecordSaveError,
  memoryProposalSubmission,
  memoryProposalBatch,
  validateProposalOperations,
  previewProposal,
  type MemoryProposalPorts,
  type MemoryRecordService,
  type MemorySpaceReader,
} from "../memory/index.ts";
import {
  buildMemorySpaceTableDigest,
  composeInteractiveProposalAgentSystemPrompt,
  compileProposalOperations,
  createProposalPreviewTool,
  ProposalState,
  type LlmPort,
} from "../agent/index.ts";
import { runFillAgent } from "../agent/fill-agent-runner.ts";
import {
  completeInterruptedTools,
  type QueryChatStore,
  type AssistantContext,
} from "./session-store.ts";
import {
  errorMessage,
  createPendingAssistantMessage,
  createUserMessage,
  type QueryChatCommitResult,
  type QueryChatEvent,
} from "./query-chat-state.ts";

export const QUERY_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
export const QUERY_CHAT_SPACE_SWITCHED_NOTICE = "对话已切换，变更未提交";
export interface QueryChatServiceOptions {
  readonly store: QueryChatStore;
  readonly semanticQuery?: SemanticQueryExecutor;
  readonly reader: MemorySpaceReader;
  readonly ports: MemoryProposalPorts;
  readonly recordWriter: Pick<MemoryRecordService, "commitProposal">;
  readonly runInTransaction: (work: () => Promise<void>) => Promise<void>;
  readonly createLlm: () => LlmPort;
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

  async run(input: QueryChatRunInput): Promise<void> {
    return this.store.execute(input.sessionId, async (signal) => {
      const store = this.store;
      const session = store.get(input.sessionId);
      this.#assertContext(session);
      if (!input.text.trim()) throw new Error("消息不能为空");
      const pendingId = crypto.randomUUID();
      const userMessage: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: input.text }],
        timestamp: Date.now(),
      };
      store.beginRun(session.id, pendingId);
      store.update(session.id, {
        draft: "",
        title:
          session.messages.length || session.title !== "新会话"
            ? session.title
            : input.text.trim().slice(0, 30),
        messages: [
          ...session.messages,
          createUserMessage(crypto.randomUUID(), input.text),
          createPendingAssistantMessage(pendingId),
        ],
        transcript: [...session.transcript, userMessage],
      });
      const state = new ProposalState(session.proposal);
      const transcript: AgentMessage[] = [userMessage];
      try {
        await store.flush();
        const llm = this.#options.createLlm();
        const digest = await buildMemorySpaceTableDigest(this.#options.reader, session.spaceId);
        if (signal.aborted) throw new Error("已取消");
        const result = await runFillAgent({
          llm,
          reader: this.#options.reader,
          ports: this.#options.ports,
          memorySpaceId: session.spaceId,
          digest,
          state,
          history: session.transcript,
          semanticQuery: this.#options.semanticQuery,
          confirmationRequired: true,
          composedMessages: [
            { role: "system", text: composeInteractiveProposalAgentSystemPrompt(digest) },
          ],
          messages: [userMessage],
          messageRange: { from: 0, to: 0 },
          evidence: [],
          timeoutMs: this.#options.timeoutMs ?? QUERY_CHAT_TIMEOUT_MS,
          signal: signal,
          onEvent: (event) => {
            if (store.getRun(session.id)?.pendingId !== pendingId) return;
            for (const translated of translateAgentEvent(event))
              store.applyEvent(session.id, translated);
            if (event.type === "message_end") {
              if (event.message.role !== "user") transcript.push(event.message);
              store.update(session.id, {
                transcript: [...session.transcript, ...transcript],
                proposal: state.snapshot(),
              });
            }
          },
        });
        if (store.getRun(session.id)?.pendingId !== pendingId) return;
        store.update(session.id, {
          transcript: completeInterruptedTools([...session.transcript, ...transcript]),
          proposal: state.snapshot(),
        });
        if (state.operations.length && result.stopReason === "stop" && !signal.aborted)
          await this.#preview(session.id);
        store.applyEvent(session.id, terminalQueryChatEvent(result, signal, undefined));
      } catch (cause) {
        if (store.getRun(session.id)?.pendingId === pendingId) {
          store.update(session.id, {
            transcript: completeInterruptedTools([...session.transcript, ...transcript]),
            proposal: state.snapshot(),
            preview: undefined,
          });
          store.applyEvent(session.id, { type: "error", message: errorMessage(cause) });
        }
      } finally {
        if (store.getRun(session.id)?.pendingId === pendingId) {
          store.finishRun(session.id);
          await store.flush();
        }
      }
    });
  }

  async #preview(id: string) {
    const session = this.store.get(id);
    const digest = await buildMemorySpaceTableDigest(this.#options.reader, session.spaceId);
    const state = new ProposalState(session.proposal);
    const tool = createProposalPreviewTool({
      digest,
      state,
      validateOperations: (operations) =>
        validateProposalOperations(this.#options.ports, session.spaceId, operations),
      preview: (operations) => previewProposal(this.#options.ports, session.spaceId, operations),
    });
    const result = await tool.execute("preview", {});
    // Deletion during an asynchronous preview must not resurrect the session.
    if (!this.store.getSessions().some((item) => item.id === id)) return;
    this.store.update(id, { preview: result.details, previewId: crypto.randomUUID() });
  }

  async confirm(id: string, previewId: string): Promise<QueryChatCommitResult> {
    const origin = this.#assertContext(this.store.get(id));
    return this.store.execute(id, async (signal) => {
      const session = this.store.get(id);
      this.#assertContext(session, origin.generation);
      if (session.status === "running" || session.status === "committing")
        throw new Error("会话正在执行");
      if (session.commitUncertain)
        throw new Error("上次提交结果待核对，请查询记录并放弃旧提案后重新准备修改");
      if (!session.preview?.valid || session.previewId !== previewId)
        throw new Error("提案已变化，请重新查看变更后确认");
      this.store.update(id, { status: "committing" });
      let commit: QueryChatCommitResult;
      try {
        await this.store.flush();
        const digest = await buildMemorySpaceTableDigest(this.#options.reader, session.spaceId);
        const state = new ProposalState(session.proposal);
        const operations = compileProposalOperations(digest, state);
        if (!operations.length) throw new Error("提案为空");
        const errors = await validateProposalOperations(
          this.#options.ports,
          session.spaceId,
          operations,
        );
        if (errors.length) throw new Error(errors.map((error) => error.message).join("；"));
        const freshPreview = await previewProposal(
          this.#options.ports,
          session.spaceId,
          operations,
        );
        if (JSON.stringify(freshPreview.operations) !== JSON.stringify(session.preview.operations))
          throw new Error("记录或表结构已变化，请让助手重新预览提案后确认");
        const proposal = memoryProposalSubmission(
          { from: 0, to: 0 },
          [],
          session.preview.operations,
          memoryProposalBatch(operations),
        );
        signal.throwIfAborted();
        this.#assertContext(session, origin.generation);
        try {
          await this.#options.runInTransaction(async () => {
            signal.throwIfAborted();
            this.#assertContext(session, origin.generation);
            await this.#options.recordWriter.commitProposal(session.spaceId, proposal, "agent");
          });
          commit = {
            status: "committed",
            created: proposal.batch.create.length,
            updated: proposal.batch.update.length,
            deleted: proposal.batch.delete.length,
          };
        } catch (cause) {
          if (
            !(cause instanceof MemoryCommitPersistenceError) &&
            !(cause instanceof MemoryRecordSaveError)
          )
            throw cause;
          commit = {
            status: "committed",
            created: proposal.batch.create.length,
            updated: proposal.batch.update.length,
            deleted: proposal.batch.delete.length,
            warning: `记录已提交，快照保存失败：${cause.message}。请使用工作台的保存重试。`,
          };
        }
        // 与下方提交回执一起持久保存，磁盘上不会出现“已清空草稿但仍在提交”的中间态。
        this.store.update(
          id,
          {
            proposal: new ProposalState().snapshot(),
            preview: undefined,
            previewId: undefined,
          },
          false,
        );
      } catch (cause) {
        commit = { status: "failed", error: errorMessage(cause) };
        this.store.update(id, { preview: undefined, previewId: undefined });
      }
      const notice = createPendingAssistantMessage(crypto.randomUUID());
      const text =
        commit.status === "committed"
          ? "用户已确认，提案已提交。后续修改请重新查询最新记录。"
          : `提交失败：${commit.error}`;
      const current = this.store.get(id);
      this.store.update(id, {
        status: "idle",
        messages: [
          ...current.messages,
          {
            ...notice,
            kind: "assistant",
            status: "done",
            segments: [{ kind: "text", text }],
            commit,
          },
        ],
        transcript: [...current.transcript, { role: "user", content: text, timestamp: Date.now() }],
      });
      await this.store.flush();
      return commit;
    });
  }

  async discard(id: string): Promise<void> {
    return this.store.execute(id, async () => {
      const session = this.store.get(id);
      if (session.status === "running" || session.status === "committing")
        throw new Error("会话正在执行");
      this.store.update(id, {
        proposal: new ProposalState().snapshot(),
        preview: undefined,
        previewId: undefined,
        commitUncertain: false,
        transcript: [
          ...session.transcript,
          {
            role: "user",
            content: "已放弃当前全部未提交提案，之前的 mutationId 和临时 ID 已失效。",
            timestamp: Date.now(),
          },
        ],
      });
    });
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

/** pi AgentEvent → 问答事件（未映射的事件类型返回空数组，不产生噪音）。 */
export function translateAgentEvent(event: AgentEvent): readonly QueryChatEvent[] {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") return [{ type: "message_delta", text: delta.delta }];
      if (delta.type === "thinking_delta") return [{ type: "thinking_delta", text: delta.delta }];
      return [];
    }
    case "tool_execution_start":
      return [
        { type: "tool_start", callId: event.toolCallId, name: event.toolName, args: event.args },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          callId: event.toolCallId,
          name: event.toolName,
          result: toolResultDetails(event.result),
          isError: event.isError,
        },
      ];
    default:
      return [];
  }
}

/** 工具执行结果取结构化 details（query_records 的 QueryRecordsToolResult），没有则回退原值。 */
function toolResultDetails(result: unknown): unknown {
  if (typeof result === "object" && result !== null && "details" in result) {
    return (result as { readonly details: unknown }).details;
  }
  return result;
}

/**
 * run 终态 → 终态事件（对齐 api terminalAgentRunEvent，补取消/超时区分）：
 * - stop/length：正常结束（done，可携带自动提交结果）；
 * - error：模型调用失败（网络/鉴权等，pi 以 stopReason "error" + errorMessage 编码）；
 * - aborted：调用方取消（「已取消」）或内部超时（5 分钟提示）。
 */
export function terminalQueryChatEvent(
  result: {
    readonly stopReason: StopReason | undefined;
    readonly errorMessage: string | undefined;
    readonly answer: string;
  },
  signal: AbortSignal,
  commit: QueryChatCommitResult | undefined,
): QueryChatEvent {
  switch (result.stopReason) {
    case "stop":
    case "length":
      return {
        type: "done",
        stopReason: result.stopReason,
        errorMessage: result.errorMessage ?? null,
        commit,
      };
    case "error":
      return { type: "error", message: result.errorMessage ?? "模型调用失败" };
    case "aborted":
      return {
        type: "error",
        message: signal.aborted ? "已取消" : "Agent 运行超时（默认 5 分钟），请重试或缩小问题范围",
      };
    default:
      return { type: "error", message: "未产生回答" };
  }
}
