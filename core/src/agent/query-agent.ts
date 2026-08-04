import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, StopReason, TextContent } from "@earendil-works/pi-ai";
import type { MemorySpaceId } from "../memory/index.ts";
import { buildMemorySpaceTableDigest } from "./digest.ts";
import type { LlmPort } from "./llm-port.ts";
import type { MemorySpaceReader } from "./memory-space-reader.ts";
import { composeQueryAgentSystemPrompt } from "./prompt-composer.ts";
import { createQueryRecordsTool } from "./query-records-tool.ts";

/** 单次 run 的总超时：5 分钟（参考值，11.5 可按需调整）。 */
export const DEFAULT_QUERY_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface QueryAgentOptions {
  readonly llm: LlmPort;
  /** 记忆空间只读端口（表/字段列表 + 记录查询），由宿主装配。 */
  readonly reader: MemorySpaceReader;
  /** 单次 run 总超时（毫秒），默认 5 分钟；超时按 streamFn 契约以 stopReason "aborted" 收尾。 */
  readonly timeoutMs?: number;
}

export interface QueryAgentRunInput {
  readonly memorySpaceId: MemorySpaceId;
  /** 本轮消息（多轮历史由客户端回传），至少一条用户消息。 */
  readonly messages: readonly AgentMessage[];
}

export interface QueryAgentRunHooks {
  /** 调用方取消信号（如 SSE 客户端断开）；中止以 stopReason "aborted" 收尾，不抛异常。 */
  readonly signal?: AbortSignal;
  /** 转发 Agent 生命周期事件，供宿主翻译为聊天事件/SSE。 */
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface QueryAgentRunResult {
  /** run 结束后的完整对话记录（agent_end 事件内容）。 */
  readonly messages: readonly AgentMessage[];
  /** 最后一次助手消息的 stopReason；未产生助手消息时为 undefined。 */
  readonly stopReason: StopReason | undefined;
  /** 失败/中止时最后一次助手消息的 errorMessage。 */
  readonly errorMessage: string | undefined;
  /** 最后一次助手消息的纯文本回答。 */
  readonly answer: string;
}

/**
 * QueryAgent：对记忆空间内容提问的问答 Agent。
 *
 * - 每请求一个 Agent 实例（多轮历史由客户端回传）；
 * - 只挂只读工具 query_records，模型无 tool_calls 自然停止即结束（普通 Agent 循环，无 terminate）；
 * - MemorySpaceTableDigest 每次 run 构建一次，提示词组合与工具校验共用；
 * - 总超时 timeoutMs（默认 5 分钟），超时/取消经 agent.abort() 按 streamFn 契约收尾。
 */
export class QueryAgent {
  readonly #llm: LlmPort;
  readonly #reader: MemorySpaceReader;
  readonly #timeoutMs: number;

  constructor(options: QueryAgentOptions) {
    this.#llm = options.llm;
    this.#reader = options.reader;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_AGENT_TIMEOUT_MS;
  }

  async run(
    input: QueryAgentRunInput,
    hooks: QueryAgentRunHooks = {},
  ): Promise<QueryAgentRunResult> {
    if (input.messages.length === 0) {
      throw new Error("QueryAgent.run 需要至少一条消息");
    }
    if (input.messages[0]!.role !== "user") {
      throw new Error("QueryAgent.run 的第一条消息必须是用户消息");
    }
    if (hooks.signal?.aborted) {
      return abortedResult("run 启动前调用方已取消");
    }

    const digest = await buildMemorySpaceTableDigest(this.#reader, input.memorySpaceId);
    // 每请求一个 Agent 实例；query_records 只读且相互独立，工具默认并行执行。
    const agent = new Agent({
      initialState: {
        systemPrompt: composeQueryAgentSystemPrompt(digest),
        model: this.#llm.model,
        tools: [createQueryRecordsTool({ reader: this.#reader, digest })],
      },
      streamFn: this.#llm.streamFn,
      getApiKey: this.#llm.getApiKey,
      convertToLlm: convertAgentMessagesToLlm,
    });

    return runWithTimeout(agent, input.messages, hooks, this.#timeoutMs);
  }
}

/** 转换 AgentMessage → LLM 消息：只保留标准角色（自定义消息/通知等过滤掉）。 */
function convertAgentMessagesToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

async function runWithTimeout(
  agent: Agent,
  messages: readonly AgentMessage[],
  hooks: QueryAgentRunHooks,
  timeoutMs: number,
): Promise<QueryAgentRunResult> {
  let finalMessages: readonly AgentMessage[] = [];
  const unsubscribe = agent.subscribe((event) => {
    hooks.onEvent?.(event);
    if (event.type === "agent_end") finalMessages = event.messages;
  });

  const timer = setTimeout(() => agent.abort(), timeoutMs);
  const onAbort = () => agent.abort();
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt([...messages]);
  } finally {
    clearTimeout(timer);
    hooks.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
  return summarizeRun(finalMessages);
}

function summarizeRun(messages: readonly AgentMessage[]): QueryAgentRunResult {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    messages,
    stopReason: lastAssistant?.stopReason,
    errorMessage: lastAssistant?.errorMessage,
    answer: lastAssistant ? assistantText(lastAssistant) : "",
  };
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function abortedResult(errorMessage: string): QueryAgentRunResult {
  return { messages: [], stopReason: "aborted", errorMessage, answer: "" };
}
