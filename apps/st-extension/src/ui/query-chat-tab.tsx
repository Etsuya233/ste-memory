/**
 * 问答 Tab（ticket 20 / ADR 0009）：与 Agent 聊天的面板区块。
 *
 * 纯逻辑在 query-chat/（QueryChatStore + QueryChatService，有测试兜底），本组件
 * 只做「状态 → DOM」投影与事件接线：
 * - 顶部工具栏：查询/填写模式切换（对齐 api/web 决策 11 标签）+「刷新记录」入口
 *   （web 决策 7：提交后不自动刷新，由用户手动刷新）；
 * - 消息列表：用户气泡 + Agent 卡片（思考折叠展示、工具调用参数/结果可展开、
 *   提交摘要/错误提示）+ 复制回答；
 * - 输入行：发送 / 运行中停止（AbortController）；
 * - 空状态邀请：未绑定空间 / 无消息。
 *
 * 历史按（空间 × 模式）存页面内存（QueryChatStore），切换空间/模式/Tab 不丢失；
 * run 按 key 隔离——切换不影响在途 run（决策 7：查询继续跑完、填写提交前校验）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { QueryChatService } from "../query-chat/query-chat-service.ts";
import {
  chatHistoryMessages,
  createPendingAssistantMessage,
  createUserMessage,
  errorMessage,
  queryChatHistoryKey,
  type QueryChatCommitResult,
  type QueryChatMessage,
  type QueryChatMode,
  type QueryChatStore,
  type QueryChatToolCall,
} from "../query-chat/query-chat-state.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import { activeStatus, Placeholder, reportError, reportSuccess } from "./ui-helpers.tsx";

/** 稳定空数组（useSyncExternalStore 快照必须引用稳定，字面量 [] 会触发无限重渲染）。 */
const EMPTY_MESSAGES: readonly QueryChatMessage[] = [];

/** 模式选择项：显示顺序 = 决策 11 标签「查询/填写」。 */
const QUERY_CHAT_MODES: readonly { readonly mode: QueryChatMode; readonly label: string }[] = [
  { mode: "query", label: "查询" },
  { mode: "fill", label: "填写" },
];

const AGENT_LABELS: Readonly<Record<QueryChatMode, string>> = {
  query: "查询 Agent",
  fill: "填写 Agent",
};

function newMessageId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return "msg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

export interface QueryChatTabRuntime {
  readonly queryChat: Pick<QueryChatService, "run">;
}

export function QueryChatTab(props: {
  readonly runtime: QueryChatTabRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 历史与 run 状态的页面内存存储（宿主 = PanelShell，跨 Tab 切换存活） */
  readonly store: QueryChatStore;
  /** 提交变更后手动刷新表格/记录数据（web 决策 7） */
  readonly onDataChanged: () => void;
}) {
  const store = props.store;
  const mode = useSyncExternalStore(
    useCallback((listener: () => void) => store.onStoreChange(listener), [store]),
    () => store.getMode(),
    () => store.getMode(),
  );
  const active = activeStatus(props.status);
  const spaceId = active?.space.id;
  const key = spaceId === undefined ? undefined : queryChatHistoryKey(spaceId, mode);
  const messages = useSyncExternalStore(
    useCallback((listener: () => void) => store.onStoreChange(listener), [store]),
    () => (key === undefined ? EMPTY_MESSAGES : store.getHistory(key)),
    () => (key === undefined ? EMPTY_MESSAGES : store.getHistory(key)),
  );
  const run = useSyncExternalStore(
    useCallback((listener: () => void) => store.onStoreChange(listener), [store]),
    () => (key === undefined ? undefined : store.getRun(key)),
    () => (key === undefined ? undefined : store.getRun(key)),
  );
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const running = run !== undefined;

  // 新内容自动滚到底部（滚动容器 = 面板主体 .stm-panel-body，输入行 sticky 吸底）
  useEffect(() => {
    const scroller = listRef.current?.closest(".stm-panel-body");
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
  }, [messages]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复问答" />;
  }
  if (!active) {
    // 未绑定空间显示空状态邀请（决策 11）：说明为什么不能问 + 怎么做
    return (
      <Placeholder
        title={props.status && props.status.kind !== "active" && props.status.kind !== "branch-detected" ? props.status.humanMsg : "正在加载…"}
        hint="切换到已保存的对话后，即可就当前记忆空间提问或提交变更"
      />
    );
  }
  const currentSpaceId = active.space.id;
  const currentKey = queryChatHistoryKey(currentSpaceId, mode);

  /** 发送：组装多轮历史（无状态回传）→ 服务编排 run → 事件写回 store（按 key）。 */
  async function send(): Promise<void> {
    const text = input.trim();
    // 权威守卫：store 内该 key 已有在途 run 则拒绝（渲染期的 running 快照可能滞后）
    if (text.length === 0 || store.getRun(currentKey) !== undefined) return;
    const history = chatHistoryMessages(store.getHistory(currentKey));
    const userMessage = createUserMessage(newMessageId(), text);
    const pending = createPendingAssistantMessage(newMessageId());
    const controller = new AbortController();
    store.beginRun(currentKey, userMessage, pending, controller);
    setInput("");
    try {
      await props.runtime.queryChat.run({
        mode,
        memorySpaceId: currentSpaceId,
        messages: [...history, { role: "user", text }],
        signal: controller.signal,
        onEvent: (event) => store.applyEvent(currentKey, event),
      });
    } catch (error) {
      // 服务契约：失败都以终态事件编码；此处仅防御（迟到异常不再影响 UI 状态）
      store.applyEvent(currentKey, { type: "error", message: errorMessage(error) });
    }
  }

  return (
    <div className="stm-query-chat" data-stm-field="query-chat">
      <div className="stm-query-chat-toolbar">
        <div className="stm-query-mode-switch" role="tablist" aria-label="问答模式">
          {QUERY_CHAT_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="tab"
              className="stm-query-mode"
              aria-selected={mode === item.mode}
              data-action="query-chat-mode"
              data-mode={item.mode}
              onClick={() => store.setMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="stm-button"
          data-action="refresh-records"
          title="提交变更后手动刷新表格与记录视图"
          onClick={props.onDataChanged}
        >
          <i className="fa-solid fa-rotate" aria-hidden="true"></i> 刷新记录
        </button>
      </div>
      <div className="stm-query-chat-list" ref={listRef} data-stm-field="message-list">
        {messages.length === 0 ? (
          <Placeholder
            title={mode === "query" ? "有什么想问记忆的吗？" : "想记点什么？"}
            hint={
              mode === "query"
                ? "查询 Agent 会基于当前空间的表格记录如实回答"
                : "描述要新增或修改的记录，填写 Agent 会先征求你的同意再提交"
            }
          />
        ) : (
          messages.map((message) =>
            message.kind === "user" ? (
              <UserMessageView key={message.id} message={message} />
            ) : (
              <AssistantMessageView key={message.id} message={message} mode={mode} />
            ),
          )
        )}
      </div>
      <form
        className="stm-query-chat-input-row"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          type="text"
          data-action="query-chat-input"
          placeholder={
            running
              ? "Agent 正在回答…"
              : mode === "query"
                ? "向记忆空间提问，Enter 发送"
                : "描述记录变更，Enter 发送"
          }
          value={input}
          disabled={running}
          onChange={(event) => setInput(event.target.value)}
        />
        {running ? (
          <button
            type="button"
            className="stm-query-chat-send"
            data-action="query-chat-stop"
            title="停止"
            aria-label="停止"
            onClick={() => store.cancel(currentKey)}
          >
            <i className="fa-solid fa-stop" aria-hidden="true"></i>
          </button>
        ) : (
          <button
            type="submit"
            className="stm-query-chat-send"
            data-action="query-chat-send"
            title="发送"
            aria-label="发送"
            disabled={input.trim().length === 0}
          >
            <i className="fa-solid fa-paper-plane" aria-hidden="true"></i>
          </button>
        )}
      </form>
    </div>
  );
}

function UserMessageView(props: { readonly message: Extract<QueryChatMessage, { kind: "user" }> }) {
  return <div className="stm-chat-bubble stm-chat-bubble--user">{props.message.text}</div>;
}

function AssistantMessageView(props: {
  readonly message: Extract<QueryChatMessage, { kind: "assistant" }>;
  readonly mode: QueryChatMode;
}) {
  const { message, mode } = props;
  const statusLabel =
    message.status === "streaming" ? "回答中…" : message.status === "error" ? "出错" : "完成";
  return (
    <div className={"stm-chat-assistant stm-chat-assistant--" + message.status}>
      <header className="stm-chat-assistant-head">
        <i className="fa-solid fa-robot" aria-hidden="true"></i>
        <span className="stm-chat-agent-label">{AGENT_LABELS[mode]}</span>
        <em className="stm-chat-status-label">{statusLabel}</em>
        <button
          type="button"
          className="stm-chat-copy"
          data-action="copy-answer"
          disabled={message.text.length === 0}
          onClick={() => void copyAnswer(message.text)}
        >
          复制回答
        </button>
      </header>
      {message.thinking.length > 0 ? (
        // 思考块折叠展示（决策 6）：流式期间展开实时观察（受控 open，与 apps/web 同语义）
        <details className="stm-chat-thinking" open={message.status === "streaming"}>
          <summary>思考过程</summary>
          <div className="stm-chat-thinking-text">{message.thinking}</div>
        </details>
      ) : null}
      {message.toolCalls.map((card) => (
        <ToolCallCardView key={card.callId} card={card} />
      ))}
      {message.text.length > 0 ? <div className="stm-chat-text">{message.text}</div> : null}
      {message.commit ? <CommitBanner commit={message.commit} /> : null}
      {message.error ? <div className="stm-chat-error">{message.error}</div> : null}
    </div>
  );
}

/** 复制回答（决策 1 入口：不做「发送到对话」；非安全上下文降级 execCommand）。 */
async function copyAnswer(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      if (!ok) throw new Error("复制不可用");
    }
    reportSuccess("已复制回答");
  } catch (error) {
    reportError(new Error("复制失败：" + errorMessage(error)));
  }
}

/** 工具调用卡（决策 1：参数/结果实时可见可展开；执行中默认展开、结束后折叠）。 */
function ToolCallCardView(props: { readonly card: QueryChatToolCall }) {
  const { card } = props;
  const running = card.result === undefined;
  return (
    <details
      className={card.isError ? "stm-chat-tool stm-chat-tool--error" : "stm-chat-tool"}
      open={running}
      data-stm-field="tool-call"
      data-tool-call-id={card.callId}
    >
      <summary>
        <i className="fa-solid fa-wrench" aria-hidden="true"></i>
        <code className="stm-chat-tool-name">{card.name}</code>
        <em className="stm-chat-tool-status">
          {card.isError ? "执行失败" : running ? "执行中…" : "完成"}
        </em>
      </summary>
      <div className="stm-chat-tool-section">
        <div className="stm-chat-tool-label">参数</div>
        <pre>{JSON.stringify(card.args ?? null, null, 2)}</pre>
      </div>
      {card.result !== undefined ? (
        <div className="stm-chat-tool-section">
          <div className="stm-chat-tool-label">{toolResultLabel(card)}</div>
          <pre>{JSON.stringify(card.result, null, 2)}</pre>
        </div>
      ) : null}
    </details>
  );
}

function toolResultLabel(card: QueryChatToolCall): string {
  if (card.isError) return "结果（错误）";
  const total = recordTotal(card.result);
  return total === undefined ? "结果" : "结果（" + total + " 条记录）";
}

function recordTotal(result: unknown): number | undefined {
  if (typeof result === "object" && result !== null && "total" in result) {
    const total = (result as { total: unknown }).total;
    if (typeof total === "number") return total;
  }
  return undefined;
}

/** 填写模式提交结果横幅（已提交摘要 / 失败 / 空间切换放弃）。 */
function CommitBanner(props: { readonly commit: QueryChatCommitResult }): ReactNode {
  const { commit } = props;
  if (commit.status === "committed") {
    return (
      <div className="stm-chat-commit" data-stm-field="commit-banner">
        已提交：创建 {commit.created} · 更新 {commit.updated} · 删除 {commit.deleted}
        （点「刷新记录」后在记录 Tab 查看最新数据）
      </div>
    );
  }
  if (commit.status === "failed") {
    return (
      <div className="stm-chat-commit stm-chat-commit--error" data-stm-field="commit-banner">
        提交失败：{commit.error}
      </div>
    );
  }
  return (
    <div className="stm-chat-commit stm-chat-commit--warning" data-stm-field="commit-banner">
      {commit.notice}
    </div>
  );
}
