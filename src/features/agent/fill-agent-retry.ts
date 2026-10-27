import {
  runAgentLoop,
  type Agent,
  type AgentContext,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  retryAssistantCall,
  type AssistantMessage,
  type RetryCallbacks,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  type AgentRunSummary,
  type RunHooks,
} from "./agent-run.ts";

/** 每次让 Pi 完成一轮及其工具，再为下一轮建立独立重试预算。 */
export async function runFillAgentWithRetry(
  agent: Agent,
  messages: readonly AgentMessage[],
  hooks: RunHooks,
  timeoutMs: number,
  policy: RetryPolicy,
  callbacks?: RetryCallbacks,
): Promise<AgentRunSummary> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  if (hooks.signal?.aborted) controller.abort();
  const timer = setTimeout(onAbort, timeoutMs);
  const history: AgentMessage[] = [...messages];
  const context: AgentContext = {
    systemPrompt: agent.state.systemPrompt,
    tools: agent.state.tools,
    messages: [...agent.state.messages, ...messages],
  };
  try {
    if (controller.signal.aborted) return abortedAgentRunSummary("填表已取消");
    hooks.onEvent?.({ type: "agent_start" });
    for (const message of messages) {
      hooks.onEvent?.({ type: "message_start", message });
      hooks.onEvent?.({ type: "message_end", message });
    }
    let response: AssistantMessage;
    let continueWithTools: boolean;
    do {
      continueWithTools = false;
      response = await retryAssistantCall(
        async () => {
          const terminations: boolean[] = [];
          const produced = await runAgentLoop(
            [],
            context,
            {
              model: agent.state.model,
              convertToLlm: convertAgentMessagesToLlm,
              getApiKey: agent.getApiKey,
              shouldStopAfterTurn: () => true,
            },
            (event) => {
              // 整次填表只发送一对 agent_start/end；各次尝试的消息与轮次事件原样保留。
              if (event.type === "agent_start" || event.type === "agent_end") return;
              if (event.type === "message_end") history.push(event.message);
              if (event.type === "tool_execution_end")
                terminations.push(event.result.terminate === true);
              hooks.onEvent?.(event);
            },
            controller.signal,
            agent.streamFunction,
          );
          const assistant = produced.find(
            (message): message is AssistantMessage => message.role === "assistant",
          );
          if (!assistant) throw new Error("填表 Agent 未返回助手消息");
          if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
            context.messages.push(...produced);
            continueWithTools =
              produced.some((message) => message.role === "toolResult") &&
              !(terminations.length > 0 && terminations.every((terminated) => terminated));
          }
          return assistant;
        },
        policy,
        controller.signal,
        callbacks,
      );
    } while (continueWithTools && !controller.signal.aborted);
    // 等待期间取消由 retryAssistantCall 返回 aborted 消息，该消息尚未经过 Pi 循环。
    if (history.at(-1) !== response && response.stopReason === "aborted") {
      history.push(response);
      hooks.onEvent?.({ type: "message_start", message: response });
      hooks.onEvent?.({ type: "message_end", message: response });
      hooks.onEvent?.({ type: "turn_end", message: response, toolResults: [] });
    }
    hooks.onEvent?.({ type: "agent_end", messages: history });
    return {
      messages: history,
      stopReason: controller.signal.aborted ? "aborted" : response.stopReason,
      errorMessage: controller.signal.aborted ? "填表已取消或运行超时" : response.errorMessage,
      answer: response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    };
  } finally {
    clearTimeout(timer);
    hooks.signal?.removeEventListener("abort", onAbort);
  }
}
