import { Database, MessageSquareText } from "lucide-react";
import { useState } from "react";
import type { SourceMessage, SourceParseError } from "../api/memory-spaces.ts";
import { ChatViewer } from "./ChatViewer.tsx";
import type { RecordSelection } from "./RecordTable.tsx";
import { formatMemoryFieldValue } from "./memory-record-value.ts";

interface RecordInspectorProps {
  readonly selection?: RecordSelection;
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
  readonly loading: boolean;
}

export function RecordInspector({ selection, messages, errors, loading }: RecordInspectorProps) {
  const [tab, setTab] = useState<"record" | "chat">("record");
  return (
    <>
      <nav className="inspector-tabs" aria-label="检查器视图">
        <button
          type="button"
          className={tab === "record" ? "active" : ""}
          onClick={() => setTab("record")}
        >
          <Database size={15} /> 记录详情
        </button>
        <button
          type="button"
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          <MessageSquareText size={15} /> 原始聊天
        </button>
      </nav>
      {tab === "chat" ? (
        <ChatViewer messages={messages} errors={errors} loading={loading} />
      ) : selection ? (
        <div className="record-inspector-content">
          <header>
            <span>{selection.record.source.type === "manual" ? "手动记录" : "来源记录"}</span>
            <h2>{selection.record.displayText || "未命名记录"}</h2>
            <code>{selection.record.id}</code>
          </header>
          <dl>
            {selection.fields.map((field) => (
              <div key={field.id} className={!field.enabled ? "disabled-field-value" : ""}>
                <dt>
                  {field.name}
                  {!field.enabled ? <em>已停用</em> : null}
                </dt>
                <dd>{formatMemoryFieldValue(selection.record.payload[field.id], "未填写")}</dd>
              </div>
            ))}
          </dl>
          <section className="record-source-detail">
            <h3>来源</h3>
            {selection.record.source.type === "manual" ? (
              <p>手动创建，无来源信息</p>
            ) : (
              <>
                <p>
                  {selection.record.source.sourceTime
                    ? new Date(selection.record.source.sourceTime).toLocaleString()
                    : "未记录来源时间"}
                </p>
                <p>{selection.record.source.sourceLocation || "未记录来源定位"}</p>
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="inspector-empty">
          <Database size={24} />
          <p>选择一条记录查看字段原值与来源。</p>
        </div>
      )}
    </>
  );
}
