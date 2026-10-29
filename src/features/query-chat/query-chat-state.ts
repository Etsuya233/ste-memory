import type { StopReason } from "@earendil-works/pi-ai";

/**
 * 片段时间线片段（ADR 0013）：一条 Agent 回复按真实发生顺序排列的条目。
 * - thinking：思考片段（累积文本，纯文本渲染）；
 * - text：文本片段（累积文本，Markdown 渲染）；
 * - tool：工具调用卡（callId、工具名、参数、结果/错误、执行中标记 running）。
 */
export type QueryChatSegment =
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
      /** 执行中标记：tool_start 置 true，tool_result 到达置 false（结果可能合法为 undefined）。 */
      readonly running: boolean;
      readonly result: unknown | undefined;
      readonly isError: boolean;
    };

/** 用户确认提交后的结果，包含数据已提交但快照保存失败的情况。 */
export type QueryChatCommitResult =
  | {
      readonly status: "committed";
      readonly created: number;
      readonly updated: number;
      readonly deleted: number;
      readonly warning?: string;
    }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "abandoned"; readonly notice: string };

export type QueryChatMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly status: "streaming" | "done" | "error" | "interrupted";
      /** 有序片段序列（时间线唯一事实来源；聚合纯文本由文本片段推导）。 */
      readonly segments: readonly QueryChatSegment[];
      readonly error?: string;
      /** 用户确认提交后的结果。 */
      readonly commit?: QueryChatCommitResult;
    };

/** 服务 → 状态的事件（pi AgentEvent 的应用层翻译，见 query-chat-service）。 */
export type QueryChatEvent =
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
  | {
      readonly type: "done";
      readonly stopReason: StopReason;
      readonly errorMessage: string | null;
      readonly commit?: QueryChatCommitResult;
    }
  | { readonly type: "error"; readonly message: string };

/** 多轮回传历史：user/assistant 纯文本（工具结果与思考块不跨轮回传，ticket 19 决策 5）。 */
export interface QueryChatHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function createUserMessage(id: string, text: string): QueryChatMessage {
  return { kind: "user", id, text };
}

/** 异常 → 可读信息（service 与 UI 共用，避免各处重复内联）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPendingAssistantMessage(id: string): QueryChatMessage {
  return { kind: "assistant", id, status: "streaming", segments: [] };
}

/** 聚合回答纯文本：全部文本片段拼接（回传历史与「复制回答」共用，行为与扁平模型等价）。 */
export function assistantPlainText(
  message: Extract<QueryChatMessage, { kind: "assistant" }>,
): string {
  let text = "";
  for (const segment of message.segments) {
    if (segment.kind === "text") text += segment.text;
  }
  return text;
}

/** 终态事件：done/error 会同时终止 run（run 状态由 QueryChatStore 消费此判定）。 */
export function isTerminalQueryChatEvent(event: QueryChatEvent): boolean {
  return event.type === "done" || event.type === "error";
}

/**
 * 把一条事件应用到 pendingId 对应的 assistant 消息（找不到时原样返回，
 * 避免 run 结束后迟到的增量污染历史——按 key 隔离的防御）。
 */
export function applyQueryChatEvent(
  messages: readonly QueryChatMessage[],
  pendingId: string,
  event: QueryChatEvent,
): readonly QueryChatMessage[] {
  const index = messages.findIndex(
    (message) => message.kind === "assistant" && message.id === pendingId,
  );
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = applyToAssistant(
    messages[index] as Extract<QueryChatMessage, { kind: "assistant" }>,
    event,
  );
  return next;
}

/**
 * 片段构建规则（ADR 0013）：增量追加进末端片段（同类型合并）；类型切换开新片段；
 * 工具卡独立条目、结果按 callId 回填。事件流无轮次边界，分段全部由类型切换驱动。
 */
function appendDelta(
  segments: readonly QueryChatSegment[],
  kind: "thinking" | "text",
  text: string,
): readonly QueryChatSegment[] {
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === kind) {
    return [...segments.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...segments, { kind, text }];
}

/** 单条 assistant 消息的事件应用（纯函数；pendingId 匹配后调用）。 */
function applyToAssistant(
  message: Extract<QueryChatMessage, { kind: "assistant" }>,
  event: QueryChatEvent,
): Extract<QueryChatMessage, { kind: "assistant" }> {
  switch (event.type) {
    case "thinking_delta":
      return { ...message, segments: appendDelta(message.segments, "thinking", event.text) };
    case "message_delta":
      return { ...message, segments: appendDelta(message.segments, "text", event.text) };
    case "tool_start":
      return {
        ...message,
        segments: [
          ...message.segments,
          {
            kind: "tool",
            callId: event.callId,
            name: event.name,
            args: event.args,
            running: true,
            result: undefined,
            isError: false,
          },
        ],
      };
    case "tool_result":
      if (
        !message.segments.some(
          (segment) => segment.kind === "tool" && segment.callId === event.callId,
        )
      ) {
        // 未知/迟到 callId：不产生新条目，原样返回
        return message;
      }
      return {
        ...message,
        segments: message.segments.map((segment) =>
          segment.kind === "tool" && segment.callId === event.callId
            ? { ...segment, running: false, result: event.result, isError: event.isError }
            : segment,
        ),
      };
    case "done":
      return { ...message, status: "done", commit: event.commit };
    case "error":
      return { ...message, status: "error", error: event.message };
  }
}

export { QueryChatStore } from "./session-store.ts";
