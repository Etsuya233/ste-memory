/**
 * Agent 运行事件：pi AgentEvent → 应用事件 → SSE data 的翻译点。
 *
 * 11.5 起供聊天（QueryAgent）使用；16 起填表任务（ProposalAgent 循环）共用同一套
 * 类型与翻译实现，避免两套调试 UI 行为漂移。只透传调试 UI 需要的信息：
 * 思考增量、回答增量、工具调用参数/结果；块与任务状态事件由填表循环本身发出。
 *
 * 事件不带 runId（SSE 端点路径已限定），seq 由事件总线附加（见 fill-task-event-bus.ts）。
 * 多轮上下文为无状态回传历史（客户端回传 user/assistant 文本，工具结果不跨轮回传）。
 */
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { FillTaskStatus } from "./ports/fill-task.ts";

/** 聊天宿主自动提交冻结提案的结果（ADR 0019：交互式填写自动落库）。 */
export type ChatCommitResult =
  | {
      readonly status: "committed";
      readonly created: number;
      readonly updated: number;
      readonly deleted: number;
    }
  | { readonly status: "failed"; readonly error: string };

/**
 * 应用层 Agent 运行事件（聊天与填表共用的完整超集）：
 * - 聊天（11.5）只产生 agent 事件 + done/error 终态；
 * - 填表（16）只产生 agent 事件 + block_start/block_done/task_status（终态经 task_status 表达）。
 */
export type AgentRunEvent =
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
  | { readonly type: "block_start"; readonly from: number; readonly to: number }
  | {
      readonly type: "block_done";
      readonly from: number;
      readonly to: number;
      readonly emptyProposal: boolean;
      readonly changedRecords: number;
    }
  | {
      readonly type: "task_status";
      readonly status: FillTaskStatus;
      readonly errorMessage: string | null;
    }
  | {
      readonly type: "done";
      readonly stopReason: string;
      readonly errorMessage: string | null;
      /** 交互式填写自动提交的结果；未产生提案（无提交）时缺省。 */
      readonly commit?: ChatCommitResult;
    }
  | { readonly type: "error"; readonly message: string };

/**
 * 翻译单个 pi Agent 生命周期事件为 0..n 条应用事件。
 * 未映射的事件类型（agent_start/turn_* 等）返回空数组，不产生调试噪音。
 */
export function translateAgentEvent(event: AgentEvent): readonly AgentRunEvent[] {
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
 * run 终态 → 终态事件（聊天用）。返回 undefined 表示无需发送（调用方自行判断，
 * 如客户端已断开时跳过）。
 *
 * - stop / length：正常结束；
 * - error：模型调用失败（网络/鉴权等，pi 以 stopReason "error" + errorMessage 编码）；
 * - aborted：QueryAgent 内部超时中止（客户端断开由调用方在 signal.aborted 时跳过）。
 */
export function terminalAgentRunEvent(
  stopReason: string | undefined,
  errorMessage: string | undefined,
  commit?: ChatCommitResult,
): AgentRunEvent | undefined {
  switch (stopReason) {
    case "stop":
    case "length":
      return { type: "done", stopReason, errorMessage: errorMessage ?? null, commit };
    case "error":
      return { type: "error", message: errorMessage ?? "模型调用失败" };
    case "aborted":
      return { type: "error", message: "Agent 运行超时（默认 5 分钟），请重试或缩小问题范围" };
    default:
      return { type: "error", message: "未产生回答" };
  }
}
