import { Bot, LoaderCircle, Send, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  fetchLlmConfigInfo,
  loadPersistedLlmConfig,
  savePersistedLlmConfig,
  streamChat,
  type LlmConfigInfo,
  type LlmWebConfig,
} from "../api/chat.ts";
import {
  applyChatEvent,
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  finalizeInFlight,
  type ChatUiMessage,
  type ToolCallCard,
} from "../query-chat-state.ts";
import { LlmConfigForm } from "./LlmConfigForm.tsx";

interface QueryChatPanelProps {
  readonly memorySpaceId?: string;
}

function newMessageId(): string {
  return crypto.randomUUID();
}

/**
 * 每记忆空间一个的 Agent 调试聊天面板：
 * - 消息历史保留在页面内（按空间存于内存 Map，切换空间不丢失）；
 * - SSE 实时展示思考过程、工具调用参数/结果（结果可展开收起）；
 * - 提问中可取消（AbortController）；错误提示不阻塞继续操作；
 * - LLM 配置：API Key 仅页面内存，Base URL/Model 存浏览器本地。
 */
export function QueryChatPanel({ memorySpaceId }: QueryChatPanelProps) {
  const [config, setConfig] = useState<LlmWebConfig>(() => {
    const persisted = loadPersistedLlmConfig();
    return { ...persisted, apiKey: "" };
  });
  const [envInfo, setEnvInfo] = useState<LlmConfigInfo>();
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [input, setInput] = useState("");

  // 按记忆空间保存的历史（页面内存）；messages 是当前空间的可视列表
  const historyBySpaceRef = useRef(new Map<string, ChatUiMessage[]>());
  const activeSpaceRef = useRef<string | undefined>(undefined);
  const messagesRef = useRef<ChatUiMessage[]>([]);
  messagesRef.current = messages;
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const pendingIdRef = useRef<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchLlmConfigInfo()
      .then(setEnvInfo)
      .catch(() => setEnvInfo(undefined));
  }, []);

  // 空间切换：中止进行中的流 → 当前空间历史收尾并保存 → 载入目标空间历史
  useEffect(() => {
    const next = memorySpaceId;
    if (next === activeSpaceRef.current) return;
    const previous = activeSpaceRef.current;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    pendingIdRef.current = undefined;
    if (previous !== undefined) {
      historyBySpaceRef.current.set(previous, finalizeInFlight(messagesRef.current));
    }
    activeSpaceRef.current = next;
    setMessages(next === undefined ? [] : (historyBySpaceRef.current.get(next) ?? []));
  }, [memorySpaceId]);

  // 新内容自动滚到底部
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const streaming = messages.some(
    (message) => message.kind === "assistant" && message.status === "streaming",
  );

  function updateConfig(patch: Partial<LlmWebConfig>) {
    setConfig((current) => {
      const next = { ...current, ...patch };
      // 非敏感配置（Base URL / Model）持久化；API Key 只在内存
      savePersistedLlmConfig({ baseUrl: next.baseUrl, model: next.model });
      return next;
    });
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const spaceId = memorySpaceId;
    const text = input.trim();
    if (!spaceId || text.length === 0 || streaming) return;

    const history = chatHistoryMessages(messages);
    const userMessage = createUserMessage(newMessageId(), text);
    const pending = createPendingAssistantMessage(newMessageId());
    setMessages((current) => [...current, userMessage, pending]);
    setInput("");
    pendingIdRef.current = pending.id;

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await streamChat(
        spaceId,
        [...history, { role: "user", content: text }],
        config,
        controller.signal,
        (event) => setMessages((current) => applyChatEvent(current, pending.id, event)),
      );
    } catch (error) {
      if (controllerRef.current !== controller) return; // 已切换空间，消息已由切换逻辑收尾
      const message =
        controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
          ? "已取消"
          : error instanceof Error
            ? error.message
            : "未知错误";
      setMessages((current) =>
        current.map((item) =>
          item.kind === "assistant" && item.id === pending.id
            ? { ...item, status: "error" as const, error: message }
            : item,
        ),
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (pendingIdRef.current === pending.id) pendingIdRef.current = undefined;
    }
  }

  function cancel() {
    controllerRef.current?.abort();
  }

  if (memorySpaceId === undefined) {
    return (
      <div className="query-chat-empty">
        <Bot size={26} />
        <p>请先选择一个记忆空间，再向它提问</p>
      </div>
    );
  }

  return (
    <div className="query-chat-panel">
      <LlmConfigForm config={config} envInfo={envInfo} onChange={updateConfig} />
      <div className="query-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="query-chat-empty">
            <Bot size={26} />
            <p>向记忆空间提问，实时观察 QueryAgent 的查询路径</p>
          </div>
        ) : (
          messages.map((message) =>
            message.kind === "user" ? (
              <div className="chat-bubble chat-bubble-user" key={message.id}>
                {message.text}
              </div>
            ) : (
              <AssistantMessageView key={message.id} message={message} />
            ),
          )
        )}
      </div>
      <form className="query-chat-input-row" onSubmit={send}>
        <input
          type="text"
          placeholder={streaming ? "Agent 正在回答..." : "向记忆空间提问，Enter 发送"}
          value={input}
          disabled={streaming}
          onChange={(event) => setInput(event.target.value)}
        />
        {streaming ? (
          <button
            className="icon-button"
            type="button"
            title="停止"
            aria-label="停止"
            onClick={cancel}
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            className="primary-button"
            type="submit"
            disabled={input.trim().length === 0}
            aria-label="发送"
          >
            <Send size={15} />
          </button>
        )}
      </form>
    </div>
  );
}

function AssistantMessageView({
  message,
}: {
  message: Extract<ChatUiMessage, { kind: "assistant" }>;
}) {
  const statusLabel =
    message.status === "streaming" ? "回答中…" : message.status === "error" ? "出错" : "完成";
  return (
    <div className={`chat-assistant chat-assistant-${message.status}`}>
      <header>
        <Bot size={14} />
        <span>QueryAgent</span>
        {message.status === "streaming" ? <LoaderCircle size={13} className="spinning" /> : null}
        <em>{statusLabel}</em>
      </header>
      {message.thinking.length > 0 ? (
        <details className="thinking-block" open={message.status === "streaming"}>
          <summary>思考过程</summary>
          <p>{message.thinking}</p>
        </details>
      ) : null}
      {message.toolCalls.map((card) => (
        <ToolCallCardView key={card.callId} card={card} />
      ))}
      {message.text.length > 0 ? <p className="chat-assistant-text">{message.text}</p> : null}
      {message.error ? <p className="chat-assistant-error">{message.error}</p> : null}
    </div>
  );
}

function ToolCallCardView({ card }: { card: ToolCallCard }) {
  return (
    <article className={`tool-card ${card.isError ? "tool-card-error" : ""}`}>
      <header>
        <Wrench size={12} />
        <code>{card.name}</code>
        <em>{card.isError ? "执行失败" : card.result === undefined ? "执行中…" : "完成"}</em>
      </header>
      <pre className="tool-card-args">{JSON.stringify(card.args, null, 2)}</pre>
      {card.result !== undefined ? (
        <details className="tool-card-result" open={card.isError}>
          <summary>结果（{card.isError ? "错误" : `${recordCount(card.result)} 条记录`}）</summary>
          <pre>{JSON.stringify(card.result, null, 2)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function recordCount(result: unknown): number {
  if (typeof result === "object" && result !== null && "total" in result) {
    const total = (result as { total: unknown }).total;
    if (typeof total === "number") return total;
  }
  return 0;
}
