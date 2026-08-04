/**
 * 聊天事件：pi AgentEvent → 应用 ChatEvent → SSE data 的翻译点（11 设计 §8 归属本票）。
 *
 * 只透传调试 UI 需要的信息：思考增量、回答增量、工具调用参数/结果；
 * 多轮上下文为无状态回传历史（客户端回传 user/assistant 文本，工具结果不跨轮回传）。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type ChatEvent =
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "message_delta"; readonly text: string }
  | {
      readonly type: "tool_start";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly result: unknown;
      readonly isError: boolean;
    }
  | { readonly type: "done"; readonly stopReason: string; readonly errorMessage: string | null }
  | { readonly type: "error"; readonly message: string };

/**
 * 翻译单个 pi Agent 生命周期事件为 0..n 条聊天事件。
 * 未映射的事件类型（agent_start/turn_* 等）返回空数组，不产生聊天噪音。
 */
export function translateAgentEvent(event: AgentEvent): readonly ChatEvent[] {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") return [{ type: "message_delta", text: delta.delta }];
      if (delta.type === "thinking_delta") return [{ type: "thinking_delta", text: delta.delta }];
      return [];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool_start",
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        },
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
 * run 终态 → 终态聊天事件。返回 undefined 表示无需发送（调用方自行判断，
 * 如客户端已断开时跳过）。
 *
 * - stop / length：正常结束；
 * - error：模型调用失败（网络/鉴权等，pi 以 stopReason "error" + errorMessage 编码）；
 * - aborted：QueryAgent 内部超时中止（客户端断开由调用方在 signal.aborted 时跳过）。
 */
export function terminalChatEvent(
  stopReason: string | undefined,
  errorMessage: string | undefined,
): ChatEvent | undefined {
  switch (stopReason) {
    case "stop":
    case "length":
      return { type: "done", stopReason, errorMessage: errorMessage ?? null };
    case "error":
      return { type: "error", message: errorMessage ?? "模型调用失败" };
    case "aborted":
      return { type: "error", message: "查询超时（默认 5 分钟），请重试或缩小问题范围" };
    default:
      return { type: "error", message: "未产生回答" };
  }
}
