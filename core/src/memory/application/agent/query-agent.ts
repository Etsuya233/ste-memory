import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySpaceId } from "../../domain/index.ts";
import {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  runAgentWithTimeout,
  type AgentRunSummary,
  type RunHooks,
} from "./agent-run.ts";
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

export type QueryAgentRunResult = AgentRunSummary;

/** 与 RunHooks 等价（保留原名，宿主兼容）。 */
export type QueryAgentRunHooks = RunHooks;

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

  async run(input: QueryAgentRunInput, hooks: RunHooks = {}): Promise<QueryAgentRunResult> {
    if (input.messages.length === 0) {
      throw new Error("QueryAgent.run 需要至少一条消息");
    }
    if (input.messages[0]!.role !== "user") {
      throw new Error("QueryAgent.run 的第一条消息必须是用户消息");
    }
    if (hooks.signal?.aborted) {
      return abortedAgentRunSummary("run 启动前调用方已取消");
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

    return runAgentWithTimeout(agent, input.messages, hooks, this.#timeoutMs);
  }
}
