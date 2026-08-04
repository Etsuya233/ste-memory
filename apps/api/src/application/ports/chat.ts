import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { ChatEvent } from "../chat/chat-events.ts";
import type { LlmConfigInfo, LlmWebConfig, ResolvedLlmConfig } from "../chat/llm-config.ts";

/** 客户端回传的对话历史（无状态多轮：只含 user/assistant 文本，工具结果不跨轮回传）。 */
export interface ChatMessageInput {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** 预检通过的对话会话（runChat 只负责执行与事件转发）。 */
export interface PreparedChat {
  readonly spaceId: MemorySpaceId;
  readonly messages: readonly ChatMessageInput[];
  /** 已合并的 LLM 配置；apiKey 仅存在于本次请求内存。 */
  readonly config: ResolvedLlmConfig;
}

export interface ChatRunHooks {
  /** 客户端断开信号（SSE 连接关闭时中止 QueryAgent）。 */
  readonly signal: AbortSignal;
  /** 逐条转发聊天事件（HTTP 层编码为 SSE）。 */
  readonly onEvent: (event: ChatEvent) => void;
}

export interface ChatManager {
  /** 非敏感的环境配置回退信息（供表单标注生效来源；不含 API Key 值）。 */
  getLlmConfigInfo(): LlmConfigInfo;
  /**
   * 预检：校验 LLM 配置（web ?? env 合并）与记忆空间存在性。
   * 失败抛 LlmConfigError（400）/ ChatSpaceNotFoundError（404），
   * 保证预检错误先于 SSE 头返回，客户端能得到结构化 JSON 错误。
   */
  prepareChat(input: {
    readonly spaceId: MemorySpaceId;
    readonly messages: readonly ChatMessageInput[];
    readonly config: LlmWebConfig;
  }): Promise<PreparedChat>;
  /** 执行流式对话：每请求一个 QueryAgent 实例，pi 事件经翻译后逐条送出，终态事件也由本方法发出。 */
  runChat(prepared: PreparedChat, hooks: ChatRunHooks): Promise<void>;
}
