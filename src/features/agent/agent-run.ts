import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, StopReason, TextContent } from "@earendil-works/pi-ai";

/** 转换 AgentMessage → LLM 消息：只保留标准角色（自定义消息/通知等过滤掉）。 */
export function convertAgentMessagesToLlm(messages: readonly AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

export interface RunHooks {
  /** 调用方取消信号（如 SSE 客户端断开）；中止以 stopReason "aborted" 收尾，不抛异常。 */
  readonly signal?: AbortSignal;
  /** 转发 Agent 生命周期事件，供宿主翻译为聊天事件/SSE。 */
  readonly onEvent?: (event: AgentEvent) => void;
}

/** 以总超时运行普通 Agent 循环，返回完整对话记录与最后一次助手消息摘要。 */
export async function runAgentWithTimeout(
  agent: Agent,
  messages: readonly AgentMessage[],
  hooks: RunHooks,
  timeoutMs: number,
): Promise<AgentRunSummary> {
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

export interface AgentRunSummary {
  /** run 结束后的完整对话记录（agent_end 事件内容）。 */
  readonly messages: readonly AgentMessage[];
  /** 最后一次助手消息的 stopReason；未产生助手消息时为 undefined。 */
  readonly stopReason: StopReason | undefined;
  /** 失败/中止时最后一次助手消息的 errorMessage。 */
  readonly errorMessage: string | undefined;
  /** 最后一次助手消息的纯文本回答。 */
  readonly answer: string;
}

export function abortedAgentRunSummary(errorMessage: string): AgentRunSummary {
  return { messages: [], stopReason: "aborted", errorMessage, answer: "" };
}

function summarizeRun(messages: readonly AgentMessage[]): AgentRunSummary {
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
