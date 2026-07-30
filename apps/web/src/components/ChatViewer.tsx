import { AlertTriangle, LocateFixed, MessageSquareText } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { SourceMessage, SourceParseError } from "../api/memory-spaces.ts";

interface ChatViewerProps {
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
  readonly loading: boolean;
  readonly highlightedSourceIds?: readonly number[];
  readonly missingSourceIds?: readonly (string | number)[];
}

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

  useEffect(() => {
    setTarget("");
    setHighlighted(undefined);
  }, [messages]);

  useEffect(() => {
    const sourceId = highlightedSourceIds[0];
    if (sourceId === undefined) return;
    document
      .getElementById(`source-${sourceId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightedSourceIds]);

  function locate(event: FormEvent) {
    event.preventDefault();
    const sourceId = Number(target);
    if (
      !Number.isInteger(sourceId) ||
      !messages.some((message) => message.source_id === sourceId)
    ) {
      setHighlighted(undefined);
      return;
    }
    setHighlighted(sourceId);
    document
      .getElementById(`source-${sourceId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
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
          <button className="icon-button" type="submit" title="定位消息" aria-label="定位消息">
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
        {messages.map((message) => (
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
    </>
  );
}
