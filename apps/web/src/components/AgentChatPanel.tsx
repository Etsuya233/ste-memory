import { Bot, LoaderCircle, RefreshCw, Send, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  fetchLlmConfigInfo,
  loadPersistedLlmConfig,
  savePersistedLlmConfig,
  streamChat,
  type ChatAgentKind,
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
} from "../query-chat-state.ts";
import { LlmConfigForm } from "./LlmConfigForm.tsx";
import { AgentActivityView } from "./AgentActivityView.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";

interface AgentChatPanelProps {
  readonly memorySpaceId?: string;
  /** 点击「刷新表格」时通知外层重取记录（bump recordRefreshVersion）。 */
  readonly onRefreshRecords?: () => void;
}

/** 模式选择项：agent 预设 id → 展示标签。 */
const AGENT_MODES: readonly { readonly kind: ChatAgentKind; readonly label: string }[] = [
  { kind: "query", label: "查询" },
  { kind: "proposal", label: "填写" },
];

const AGENT_LABELS: Readonly<Record<ChatAgentKind, string>> = {
  query: "查询 Agent",
  proposal: "填写 Agent",
};

function newMessageId(): string {
  return crypto.randomUUID();
}

function historyKey(spaceId: string, mode: ChatAgentKind): string {
  return `${spaceId}:${mode}`;
}

/**
 * 每记忆空间每模式一个的 Agent 聊天面板（查询 / 填写）：
 * - 消息历史按（空间 × 模式）保留在页面内（内存 Map，切换空间/模式不丢失）；
 * - 查询模式 = QueryAgent（只读）；填写模式 = 交互式填写（ADR 0019，提交前征得用户同意，自动落库）；
 * - SSE 实时展示思考过程、工具调用参数/结果（结果可展开收起）；
 * - 提问中可取消（AbortController）；错误提示不阻塞继续操作；
 * - 「刷新表格」按钮由用户手动触发重取记录（不自动刷新）；
 * - LLM 配置：API Key / Base URL / Model 均保存在浏览器本地（localStorage），两模式共用。
 */
export function AgentChatPanel({ memorySpaceId, onRefreshRecords }: AgentChatPanelProps) {
  const [config, setConfig] = useState<LlmWebConfig>(loadPersistedLlmConfig);
  const [envInfo, setEnvInfo] = useState<LlmConfigInfo>();
  const [mode, setMode] = useState<ChatAgentKind>("query");
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [input, setInput] = useState("");

  // 按（空间 × 模式）保存的历史（页面内存）；messages 是当前组合的可视列表
  const historyByKeyRef = useRef(new Map<string, ChatUiMessage[]>());
  const activeKeyRef = useRef<string | undefined>(undefined);
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

  // 空间/模式切换：中止进行中的流 → 当前组合历史收尾并保存 → 载入目标组合历史
  useEffect(() => {
    const next = memorySpaceId === undefined ? undefined : historyKey(memorySpaceId, mode);
    if (next === activeKeyRef.current) return;
    const previous = activeKeyRef.current;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
    pendingIdRef.current = undefined;
    if (previous !== undefined) {
      historyByKeyRef.current.set(previous, finalizeInFlight(messagesRef.current));
    }
    activeKeyRef.current = next;
    setMessages(next === undefined ? [] : (historyByKeyRef.current.get(next) ?? []));
  }, [memorySpaceId, mode]);

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
      savePersistedLlmConfig(next);
      return next;
    });
  }

  function switchMode(next: ChatAgentKind) {
    if (next !== mode) setMode(next);
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
        mode,
        controller.signal,
        (event) => setMessages((current) => applyChatEvent(current, pending.id, event)),
      );
    } catch (error) {
      if (controllerRef.current !== controller) return; // 已切换空间/模式，消息已由切换逻辑收尾
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
        <p>请先选择一个记忆空间，再与 Agent 对话</p>
      </div>
    );
  }

  return (
    <div className="query-chat-panel">
      <div className="agent-chat-toolbar">
        <div className="agent-mode-switch" role="tablist" aria-label="Agent 模式">
          {AGENT_MODES.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="tab"
              aria-selected={mode === item.kind}
              className={mode === item.kind ? "active" : ""}
              onClick={() => switchMode(item.kind)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="agent-refresh-btn"
          title="刷新表格（提交变更后手动刷新数据）"
          onClick={onRefreshRecords}
        >
          <RefreshCw size={13} /> 刷新表格
        </button>
      </div>
      <LlmConfigForm config={config} envInfo={envInfo} onChange={updateConfig} />
      <div className="query-chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="query-chat-empty">
            <Bot size={26} />
            <p>
              {mode === "query"
                ? "向记忆空间提问，实时观察查询 Agent 的查询路径"
                : "提出记忆记录变更，填写 Agent 会先征求你的同意再提交"}
            </p>
          </div>
        ) : (
          messages.map((message) =>
            message.kind === "user" ? (
              <div className="chat-bubble chat-bubble-user" key={message.id}>
                {message.text}
              </div>
            ) : (
              <AssistantMessageView key={message.id} message={message} mode={mode} />
            ),
          )
        )}
      </div>
      <form className="query-chat-input-row" onSubmit={send}>
        <input
          type="text"
          placeholder={
            streaming
              ? "Agent 正在回答..."
              : mode === "query"
                ? "向记忆空间提问，Enter 发送"
                : "提出变更请求，Enter 发送"
          }
          value={input}
          disabled={streaming}
          onChange={(event) => setInput(event.target.value)}
        />
        {streaming ? (
          <button
            className="icon-btn"
            type="button"
            title="停止"
            aria-label="停止"
            onClick={cancel}
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            className="btn btn-primary query-chat-send"
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
  mode,
}: {
  message: Extract<ChatUiMessage, { kind: "assistant" }>;
  mode: ChatAgentKind;
}) {
  const statusLabel =
    message.status === "streaming" ? "回答中…" : message.status === "error" ? "出错" : "完成";
  return (
    <div className={`chat-assistant chat-assistant-${message.status}`}>
      <header>
        <Bot size={14} />
        <span>{AGENT_LABELS[mode]}</span>
        {message.status === "streaming" ? <LoaderCircle size={13} className="spinning" /> : null}
        <em>{statusLabel}</em>
      </header>
      <AgentActivityView
        thinking={message.thinking}
        toolCalls={message.toolCalls}
        streaming={message.status === "streaming"}
      />
      {message.text.length > 0 ? (
        <div className="chat-assistant-text">
          <MarkdownContent text={message.text} />
        </div>
      ) : null}
      {message.commit?.status === "committed" ? (
        <p className="chat-commit-banner">
          已应用变更：创建 {message.commit.created} · 更新 {message.commit.updated} · 删除{" "}
          {message.commit.deleted}（可在上方点「刷新表格」查看最新数据）
        </p>
      ) : null}
      {message.commit?.status === "failed" ? (
        <p className="chat-commit-error">提交失败：{message.commit.error}</p>
      ) : null}
      {message.error ? <p className="chat-assistant-error">{message.error}</p> : null}
    </div>
  );
}
