/**
 * DefaultChatManager：聊天编排（ticket 11.5）。
 *
 * 分层：本模块只做编排（配置合并 → 预检 → 每请求一个 QueryAgent → 事件翻译），
 * 不感知 HTTP/SSE（HTTP 层见 adapters/inbound/http/chat/routes.ts）与厂商协议
 * （provider 构造经 buildLlmPort 注入，见 adapters/outbound/llm）。
 */
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ProposalAgent,
  QueryAgent,
  composeInteractiveProposalAgentSystemPrompt,
  type LlmPort,
  type MemorySpaceReader,
} from "@ste-memory/core/memory/agent";
import type { MemoryProposalPorts, MemoryProposalSubmission } from "@ste-memory/core/memory";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { MemorySpaceManager } from "../ports/memory-space.ts";
import type {
  ChatAgentKind,
  ChatManager,
  ChatMessageInput,
  ChatRunHooks,
  PreparedChat,
} from "../ports/chat.ts";
import {
  terminalAgentRunEvent,
  translateAgentEvent,
  type ChatCommitResult,
} from "../agent-events.ts";
import {
  llmConfigInfo,
  resolveLlmConfig,
  type LlmConfigInfo,
  type LlmEnvConfig,
  type LlmWebConfig,
  type ResolvedLlmConfig,
} from "./llm-config.ts";

/** OpenAI 兼容 provider 标识：pi 模型/消息元数据与 provider 构造共用（见 outbound/llm）。 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "ste-memory-openai";

/** 记忆空间不存在（HTTP 层映射为 404）。 */
export class ChatSpaceNotFoundError extends Error {
  constructor() {
    super("记忆空间不存在");
    this.name = "ChatSpaceNotFoundError";
  }
}

export interface ChatManagerOptions {
  /** 服务端环境变量配置（OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL）。 */
  readonly envConfig: LlmEnvConfig;
  /** 记忆空间存在性校验（只读）。 */
  readonly spaces: Pick<MemorySpaceManager, "exists">;
  /** 记忆空间只读端口（digest 构建 + query_records 工具共用）。 */
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览所需的领域访问端口（proposal 预设使用，与填表任务共用同一组 repository）。 */
  readonly ports: MemoryProposalPorts;
  /**
   * 提交冻结提案（ADR 0019：交互式填写自动落库）。由组合根装配：
   * 单事务写入当前记录/历史/证据（revisionSource "agent"），失败抛错由本管理器收口为 commit failed。
   */
  readonly commitProposal: (
    memorySpaceId: MemorySpaceId,
    submission: MemoryProposalSubmission,
  ) => Promise<unknown>;
  /**
   * provider 构造：每次对话按本次解析结果构建一次 LlmPort，
   * API Key 只存在于返回的闭包内存中，不落库/落盘/打日志。
   */
  readonly buildLlmPort: (config: ResolvedLlmConfig) => LlmPort;
  /** 单次 run 总超时（毫秒），默认 5 分钟（参考 11 设计 §5）。 */
  readonly timeoutMs?: number;
}

export class DefaultChatManager implements ChatManager {
  readonly #envConfig: LlmEnvConfig;
  readonly #spaces: Pick<MemorySpaceManager, "exists">;
  readonly #reader: MemorySpaceReader;
  readonly #ports: MemoryProposalPorts;
  readonly #commitProposal: ChatManagerOptions["commitProposal"];
  readonly #buildLlmPort: (config: ResolvedLlmConfig) => LlmPort;
  readonly #timeoutMs: number;

  constructor(options: ChatManagerOptions) {
    this.#envConfig = options.envConfig;
    this.#spaces = options.spaces;
    this.#reader = options.reader;
    this.#ports = options.ports;
    this.#commitProposal = options.commitProposal;
    this.#buildLlmPort = options.buildLlmPort;
    this.#timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  }

  getLlmConfigInfo(): LlmConfigInfo {
    return llmConfigInfo(this.#envConfig);
  }

  async prepareChat(input: {
    readonly spaceId: MemorySpaceId;
    readonly messages: readonly ChatMessageInput[];
    readonly config: LlmWebConfig;
    readonly agent: ChatAgentKind;
  }): Promise<PreparedChat> {
    const config = resolveLlmConfig(this.#envConfig, input.config);
    if (!(await this.#spaces.exists(input.spaceId))) {
      throw new ChatSpaceNotFoundError();
    }
    return { spaceId: input.spaceId, messages: input.messages, config, agent: input.agent };
  }

  async runChat(prepared: PreparedChat, hooks: ChatRunHooks): Promise<void> {
    const llm = this.#buildLlmPort(prepared.config);
    if (prepared.agent === "proposal") {
      await this.#runProposalChat(prepared, llm, hooks);
      return;
    }
    await this.#runQueryChat(prepared, llm, hooks);
  }

  /** 查询预设（原 QueryAgent 行为，保持向后兼容）。 */
  async #runQueryChat(prepared: PreparedChat, llm: LlmPort, hooks: ChatRunHooks): Promise<void> {
    const agent = new QueryAgent({
      llm,
      reader: this.#reader,
      timeoutMs: this.#timeoutMs,
    });
    const emittedTextDelta = { fired: false };
    const result = await agent.run(
      {
        memorySpaceId: prepared.spaceId,
        messages: toAgentMessages(prepared.messages, prepared.config.model),
      },
      this.#runHooks(hooks, emittedTextDelta),
    );
    // 客户端已断开时不再写事件（socket 已死）；其余情况发送终态事件。
    if (!hooks.signal.aborted) {
      this.#emitTerminal(result, hooks, emittedTextDelta);
    }
  }

  /**
   * 交互式填写预设（ADR 0019）：提案管线 + 自动落库。
   * 用户确认经 prompt 软闸门约束（composeInteractiveProposalAgentSystemPrompt）；
   * run 结束后若冻结提案立即提交，结果随 done 事件送达；提交失败收口为 commit failed。
   */
  async #runProposalChat(prepared: PreparedChat, llm: LlmPort, hooks: ChatRunHooks): Promise<void> {
    const agent = new ProposalAgent({
      llm,
      reader: this.#reader,
      ports: this.#ports,
      composeSystemPrompt: composeInteractiveProposalAgentSystemPrompt,
      timeoutMs: this.#timeoutMs,
    });
    const emittedTextDelta = { fired: false };
    const result = await agent.run(
      {
        memorySpaceId: prepared.spaceId,
        messages: toAgentMessages(prepared.messages, prepared.config.model),
        // 聊天无消息范围概念：合成占位（commit 不使用它，仅预览元数据）。
        messageRange: { from: 0, to: 0 },
        // v1 交互式填写不注入证据（领域规则允许零条）。
        evidence: [],
      },
      this.#runHooks(hooks, emittedTextDelta),
    );
    if (hooks.signal.aborted) return;

    // 自动落库：冻结提案 → 宿主提交；失败收口为 commit failed（用户可重新发起）。
    let commit: ChatCommitResult | undefined;
    if (result.proposal) {
      try {
        await this.#commitProposal(prepared.spaceId, result.proposal);
        commit = {
          status: "committed",
          created: result.proposal.batch.create.length,
          updated: result.proposal.batch.update.length,
          deleted: result.proposal.batch.delete.length,
        };
      } catch (error) {
        commit = { status: "failed", error: errorMessage(error) };
      }
    }
    this.#emitTerminal(result, hooks, emittedTextDelta, commit);
  }

  /**
   * 终态收尾：兼容不吐 text_delta 的 provider/模型（回答全文一次性补发，
   * 保证客户端总能收到回答）+ 发送 done/error 终态事件（可携带自动落库结果）。
   */
  #emitTerminal(
    result: {
      readonly stopReason: string | undefined;
      readonly errorMessage: string | undefined;
      readonly answer: string;
    },
    hooks: ChatRunHooks,
    emittedTextDelta: { fired: boolean },
    commit?: ChatCommitResult,
  ): void {
    if (!emittedTextDelta.fired && result.answer.length > 0) {
      hooks.onEvent({ type: "message_delta", text: result.answer });
    }
    const terminal = terminalAgentRunEvent(result.stopReason, result.errorMessage, commit);
    if (terminal) hooks.onEvent(terminal);
  }

  /** run 的事件转发（思考/回答增量、工具调用）；text_delta 记账供兼容补发。 */
  #runHooks(
    hooks: ChatRunHooks,
    emittedTextDelta: { fired: boolean },
  ): { signal: AbortSignal; onEvent: (event: AgentEvent) => void } {
    return {
      signal: hooks.signal,
      onEvent: (event) => {
        for (const chatEvent of translateAgentEvent(event)) {
          if (chatEvent.type === "message_delta") emittedTextDelta.fired = true;
          hooks.onEvent(chatEvent);
        }
      },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 零 usage 占位：历史 assistant 消息的元数据不被 LLM 循环使用（convertToLlm 只按角色过滤）。 */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** 客户端文本历史 → pi AgentMessage（无状态多轮：只回传 user/assistant 文本）。 */
function toAgentMessages(
  messages: readonly ChatMessageInput[],
  model: string,
): readonly AgentMessage[] {
  const timestamp = Date.now();
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: [{ type: "text", text: message.content }], timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: "openai-completions",
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          model,
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp,
        },
  );
}
