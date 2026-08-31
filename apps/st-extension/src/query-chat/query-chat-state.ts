/**
 * 问答面板（ticket 20 / ADR 0009）的纯逻辑 seam：按（空间 × 模式）的页面内存
 * 聊天历史 + 模式 + run 状态（可取消/终止）。与 React 无关，不依赖 ST 与 Dexie，
 * 供 UI 组件投影与单测驱动。
 *
 * 决策落点（ticket 20）：
 * - 历史按（空间 × 模式）各存独立历史，页面内存，刷新即失，不落 Dexie、不进通用日志；
 * - 运行中切换对话/模式不打断 run（查询继续跑完、填写提交前校验）——
 *   run 按 key 记录，事件继续写进该 key 的历史，切换回来可见；
 * - 多轮历史无状态回传：只回传 user/assistant 文本（工具结果与思考块不跨轮回传）；
 * - 单 key 同时只允许一个 run（输入禁用 + 停止按钮由 run 存在性驱动）。
 */
import type { StopReason } from "@earendil-works/pi-ai";
import type { MemorySpaceId } from "@ste-memory/core/memory";

/** 问答模式：查询 = QueryAgent 只读问答；填写 = 交互式填写（软闸门 + 直通 repository）。 */
export type QueryChatMode = "query" | "fill";

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

/** 填写模式自动提交的结果（对齐 apps/api ChatCommitResult + 空间切换放弃分支）。 */
export type QueryChatCommitResult =
  | {
      readonly status: "committed";
      readonly created: number;
      readonly updated: number;
      readonly deleted: number;
    }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "abandoned"; readonly notice: string };

export type QueryChatMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly status: "streaming" | "done" | "error";
      /** 有序片段序列（时间线唯一事实来源；聚合纯文本由文本片段推导）。 */
      readonly segments: readonly QueryChatSegment[];
      readonly error?: string;
      /** 填写模式自动提交的结果（done 事件携带；查询模式恒缺省）。 */
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

/** 稳定空历史：getSnapshot 快照必须引用稳定（新字面量会让 useSyncExternalStore 无限重渲染）。 */
const EMPTY_HISTORY: readonly QueryChatMessage[] = [];

/** 按（空间 × 模式）的历史键。 */
export function queryChatHistoryKey(spaceId: MemorySpaceId, mode: QueryChatMode): string {
  return `${spaceId}:${mode}`;
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
      if (!message.segments.some((segment) => segment.kind === "tool" && segment.callId === event.callId)) {
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

/** 回传历史：user 文本 + 正常完成的 assistant 文本（error/streaming 不回传；思考与工具不跨轮）。 */
export function chatHistoryMessages(
  messages: readonly QueryChatMessage[],
): readonly QueryChatHistoryMessage[] {
  return messages.flatMap<QueryChatHistoryMessage>((message) => {
    if (message.kind === "user") return [{ role: "user", text: message.text }];
    if (message.status !== "done") return [];
    const text = assistantPlainText(message);
    return text.length > 0 ? [{ role: "assistant", text }] : [];
  });
}

/** 单 key 的 run 状态：pendingId 定位流式消息；controller 供 UI 取消。 */
export interface QueryChatRunState {
  readonly pendingId: string;
  readonly controller: AbortController;
}

/**
 * 问答历史与 run 状态的页面内存存储（每（空间 × 模式）一个 key）：
 * - 历史在切换空间/模式/Tab 后保留（页面存活期间）；
 * - run 按 key 记录：事件继续写进该 key 的历史，切换不影响在途 run（决策 7）；
 * - 同一 key 同时只允许一个 run；done/error 事件终止 run；
 * - 纯同步 store（无 ST/Dexie 依赖），React 经 useSyncExternalStore 订阅。
 */
export class QueryChatStore {
  readonly #history = new Map<string, readonly QueryChatMessage[]>();
  readonly #runs = new Map<string, QueryChatRunState>();
  readonly #listeners = new Set<() => void>();
  #mode: QueryChatMode = "query";

  getMode(): QueryChatMode {
    return this.#mode;
  }

  /** 模式切换：历史按 key 隔离（各模式独立历史，决策 4/9），在途 run 不受影响。 */
  setMode(mode: QueryChatMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#notify();
  }

  getHistory(key: string): readonly QueryChatMessage[] {
    return this.#history.get(key) ?? EMPTY_HISTORY;
  }

  getRun(key: string): QueryChatRunState | undefined {
    return this.#runs.get(key);
  }

  /** 开始一次 run：追加用户消息 + 待流式 assistant 消息，记录 run（可取消）。 */
  beginRun(
    key: string,
    user: QueryChatMessage,
    pending: QueryChatMessage,
    controller: AbortController,
  ): void {
    this.#history.set(key, [...this.getHistory(key), user, pending]);
    this.#runs.set(key, { pendingId: pending.id, controller });
    this.#notify();
  }

  /** 应用一条事件到该 key 的流式消息；终态事件同时终止 run。 */
  applyEvent(key: string, event: QueryChatEvent): void {
    const run = this.#runs.get(key);
    if (run === undefined) return;
    const next = applyQueryChatEvent(this.getHistory(key), run.pendingId, event);
    this.#history.set(key, next);
    if (isTerminalQueryChatEvent(event)) this.#runs.delete(key);
    this.#notify();
  }

  /** 取消该 key 的 run（触发 AbortController；服务以「已取消」终态事件收尾）。 */
  cancel(key: string): boolean {
    const run = this.#runs.get(key);
    if (run === undefined) return false;
    run.controller.abort();
    return true;
  }

  /**
   * 清除空间记录/重置空间（spec reset-space）：清空该空间（两种模式）的页面内存
   * 聊天历史并中断在途 run。迟到的事件因 run 已删除而被丢弃（applyEvent 对未知
   * key 返回），不会污染其他空间的历史。
   */
  clearSpaceHistory(spaceId: MemorySpaceId): void {
    const prefix = `${spaceId}:`;
    let changed = false;
    for (const key of [...this.#runs.keys()]) {
      if (key.startsWith(prefix)) {
        this.#runs.get(key)!.controller.abort();
        this.#runs.delete(key);
        changed = true;
      }
    }
    for (const key of [...this.#history.keys()]) {
      if (key.startsWith(prefix)) {
        this.#history.delete(key);
        changed = true;
      }
    }
    if (changed) this.#notify();
  }

  /** 订阅变化（useSyncExternalStore）；返回退订函数。 */
  onStoreChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
