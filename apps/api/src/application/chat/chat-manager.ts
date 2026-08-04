/**
 * DefaultChatManager：聊天编排（ticket 11.5）。
 *
 * 分层：本模块只做编排（配置合并 → 预检 → 每请求一个 QueryAgent → 事件翻译），
 * 不感知 HTTP/SSE（HTTP 层见 adapters/inbound/http/chat/routes.ts）与厂商协议
 * （provider 构造经 buildLlmPort 注入，见 adapters/outbound/llm）。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { QueryAgent, type LlmPort, type MemorySpaceReader } from "@ste-memory/core/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { MemorySpaceManager } from "../ports/memory-space.ts";
import type { ChatManager, ChatMessageInput, ChatRunHooks, PreparedChat } from "../ports/chat.ts";
import { terminalChatEvent, translateAgentEvent } from "./chat-events.ts";
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
  readonly #buildLlmPort: (config: ResolvedLlmConfig) => LlmPort;
  readonly #timeoutMs: number;

  constructor(options: ChatManagerOptions) {
    this.#envConfig = options.envConfig;
    this.#spaces = options.spaces;
    this.#reader = options.reader;
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
  }): Promise<PreparedChat> {
    const config = resolveLlmConfig(this.#envConfig, input.config);
    if (!(await this.#spaces.exists(input.spaceId))) {
      throw new ChatSpaceNotFoundError();
    }
    return { spaceId: input.spaceId, messages: input.messages, config };
  }

  async runChat(prepared: PreparedChat, hooks: ChatRunHooks): Promise<void> {
    const llm = this.#buildLlmPort(prepared.config);
    const agent = new QueryAgent({
      llm,
      reader: this.#reader,
      timeoutMs: this.#timeoutMs,
    });
    let emittedTextDelta = false;
    const result = await agent.run(
      {
        memorySpaceId: prepared.spaceId,
        messages: toAgentMessages(prepared.messages, prepared.config.model),
      },
      {
        signal: hooks.signal,
        onEvent: (event) => {
          for (const chatEvent of translateAgentEvent(event)) {
            if (chatEvent.type === "message_delta") emittedTextDelta = true;
            hooks.onEvent(chatEvent);
          }
        },
      },
    );
    // 客户端已断开时不再写事件（socket 已死）；其余情况发送终态事件。
    if (!hooks.signal.aborted) {
      // 兼容不吐 text_delta 的 provider/模型：回答全文一次性补发，保证客户端总能收到回答。
      if (!emittedTextDelta && result.answer.length > 0) {
        hooks.onEvent({ type: "message_delta", text: result.answer });
      }
      const terminal = terminalChatEvent(result.stopReason, result.errorMessage);
      if (terminal) hooks.onEvent(terminal);
    }
  }
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
