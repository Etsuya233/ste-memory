import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  MessageSquareText,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { SourceMessage, SourceParseError } from "../api/memory-spaces.ts";

interface ChatViewerProps {
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
  readonly loading: boolean;
  readonly highlightedSourceIds?: readonly number[];
  readonly missingSourceIds?: readonly (string | number)[];
}

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
const DEFAULT_PAGE_SIZE = 100;

function speaker(message: SourceMessage): string {
  const name = message.extraProps.name;
  return typeof name === "string" && name.length > 0 ? name : "未知发送者";
}

export function ChatViewer({
  messages,
  errors,
  loading,
  highlightedSourceIds = [],
  missingSourceIds = [],
}: ChatViewerProps) {
  const [target, setTarget] = useState("");
  const [highlighted, setHighlighted] = useState<number>();
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const totalPages = Math.max(1, Math.ceil(messages.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = messages.slice((safePage - 1) * pageSize, safePage * pageSize);

  // 消息变化（空间切换/刷新）或每页条数变化时回到第一页
  useEffect(() => {
    setTarget("");
    setHighlighted(undefined);
    setPage(1);
    setPageInput("1");
  }, [messages, pageSize]);

  // 检查器证据跳转：先切到目标消息所在页，渲染后再滚动定位
  useEffect(() => {
    const sourceId = highlightedSourceIds[0];
    if (sourceId === undefined) return;
    const index = messages.findIndex((message) => message.source_id === sourceId);
    if (index === -1) return;
    setPage(Math.floor(index / pageSize) + 1);
  }, [highlightedSourceIds, messages, pageSize]);

  useEffect(() => {
    const sourceId = highlightedSourceIds[0];
    if (sourceId === undefined) return;
    document
      .getElementById(`source-${sourceId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedSourceIds, page, messages]);

  function jumpToPage(raw: string) {
    const next = Number(raw);
    if (!Number.isInteger(next)) return;
    const clamped = Math.min(Math.max(1, next), totalPages);
    setPage(clamped);
    setPageInput(String(clamped));
  }

  function locate(event: FormEvent) {
    event.preventDefault();
    const sourceId = Number(target);
    if (!Number.isInteger(sourceId) || !messages.some((message) => message.source_id === sourceId)) {
      setHighlighted(undefined);
      return;
    }
    setHighlighted(sourceId);
    const index = messages.findIndex((message) => message.source_id === sourceId);
    setPage(Math.floor(index / pageSize) + 1);
  }

  if (loading) return <div className="viewer-state">正在读取原始聊天...</div>;
  if (messages.length === 0) {
    return (
      <div className="viewer-state">
        <MessageSquareText size={28} />
        <p>
          {missingSourceIds.length > 0
            ? `来源消息 #${missingSourceIds.join(", #")} 不存在`
            : "选择一个记忆空间查看原始聊天"}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="viewer-toolbar">
        <div>
          <h2>原始聊天</h2>
          <p>共 {messages.length} 条已保存消息</p>
        </div>
        <form className="locate-form" onSubmit={locate}>
          <input
            type="number"
            min={1}
            max={messages.length}
            placeholder="source_id"
            aria-label="定位 source_id"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <button className="icon-btn" type="submit" title="定位消息" aria-label="定位消息">
            <LocateFixed size={17} />
          </button>
        </form>
      </div>
      {errors.length > 0 ? (
        <details className="parse-errors">
          <summary>
            <AlertTriangle size={16} /> {errors.length} 行未能解析
          </summary>
          <div>
            {errors.map((error) => (
              <p key={error.lineNumber}>
                第 {error.lineNumber} 行：{error.message}
              </p>
            ))}
          </div>
        </details>
      ) : null}
      <div className="message-list">
        {visible.map((message) => (
          <article
            id={`source-${message.source_id}`}
            className={`message-row ${highlighted === message.source_id || highlightedSourceIds.includes(message.source_id) ? "highlighted" : ""}`}
            key={message.source_id}
          >
            <span className="source-id">#{message.source_id}</span>
            <div>
              <strong>{speaker(message)}</strong>
              <p>{message.content}</p>
            </div>
          </article>
        ))}
        {missingSourceIds.map((sourceId) => (
          <p className="evidence-missing" key={`missing-${sourceId}`}>
            来源消息 #{sourceId} 不存在
          </p>
        ))}
      </div>
      <footer className="viewer-pagination">
        <span>
          第 {safePage}/{totalPages} 页 · 每页 {visible.length} 条
        </span>
        <div className="viewer-pagination-controls">
          <button
            className="icon-btn"
            type="button"
            title="上一页"
            aria-label="上一页"
            disabled={safePage <= 1}
            onClick={() => jumpToPage(String(safePage - 1))}
          >
            <ChevronLeft size={15} />
          </button>
          <form
            className="viewer-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              jumpToPage(pageInput);
            }}
          >
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              aria-label="页码"
              title="输入页码后按 Enter 跳转"
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => jumpToPage(pageInput)}
            />
            <span>/ {totalPages}</span>
          </form>
          <button
            className="icon-btn"
            type="button"
            title="下一页"
            aria-label="下一页"
            disabled={safePage >= totalPages}
            onClick={() => jumpToPage(String(safePage + 1))}
          >
            <ChevronRight size={15} />
          </button>
          <select
            className="viewer-page-size"
            value={pageSize}
            aria-label="每页条数"
            onChange={(event) => setPageSize(Number(event.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} 条/页
              </option>
            ))}
          </select>
        </div>
      </footer>
    </>
  );
}
