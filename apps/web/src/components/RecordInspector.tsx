import { Bot, Database, History, MessageSquareText } from "lucide-react";
import { useState } from "react";
import type { MemoryRecord } from "../api/memory-records.ts";
import type { MemoryEvidence } from "../api/memory-records.ts";
import type { SourceMessage, SourceParseError } from "../api/memory-spaces.ts";
import { ChatViewer } from "./ChatViewer.tsx";
import type { RecordSelection } from "./RecordTable.tsx";
import { formatMemoryFieldValue } from "./memory-record-value.ts";
import { QueryChatPanel } from "./QueryChatPanel.tsx";
import { RecordActions } from "./RecordActions.tsx";
import { RecordHistoryPanel } from "./RecordHistoryPanel.tsx";

interface RecordInspectorProps {
  readonly selection?: RecordSelection;
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
  readonly loading: boolean;
  readonly memorySpaceId?: string;
  readonly onRecordMutation: (record: MemoryRecord | undefined) => void;
  readonly onEvidenceSelect?: (
    sourceIds: readonly number[],
    missingIds: readonly (string | number)[],
  ) => void;
  readonly highlightedSourceIds?: readonly number[];
  readonly missingSourceIds?: readonly (string | number)[];
}

export function RecordInspector(props: RecordInspectorProps) {
  const [tab, setTab] = useState<"record" | "history" | "chat" | "agent">("record");
  const selection = props.selection;
  return (
    <>
      <nav className="inspector-tabs" aria-label="检查器视图">
        <button
          type="button"
          className={tab === "record" ? "active" : ""}
          onClick={() => setTab("record")}
        >
          <Database size={13} /> 记录
        </button>
        <button
          type="button"
          className={tab === "history" ? "active" : ""}
          disabled={!selection}
          onClick={() => setTab("history")}
        >
          <History size={13} /> 历史
        </button>
        <button
          type="button"
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          <MessageSquareText size={13} /> 原聊
        </button>
        <button
          type="button"
          className={tab === "agent" ? "active" : ""}
          onClick={() => setTab("agent")}
        >
          <Bot size={13} /> Agent
        </button>
      </nav>
      {/* Agent 聊天面板保持挂载（隐藏而非卸载）：消息历史保留在页面内，切换标签不中断流 */}
      <div className={tab === "agent" ? "query-chat-panel-wrap" : "inspector-panel-hidden"}>
        <QueryChatPanel memorySpaceId={props.memorySpaceId} />
      </div>
      {tab === "chat" ? (
        <div className="inspector-content-scroll">
          <ChatViewer
            messages={props.messages}
            errors={props.errors}
            loading={props.loading}
            highlightedSourceIds={props.highlightedSourceIds}
            missingSourceIds={props.missingSourceIds}
          />
        </div>
      ) : tab === "history" && selection && props.memorySpaceId ? (
        <div className="inspector-content-scroll">
          <RecordHistoryPanel memorySpaceId={props.memorySpaceId} selection={selection} />
        </div>
      ) : tab === "record" && selection ? (
        <div className="inspector-content-scroll">
          <div className="record-inspector-content">
            <header>
              <div className="record-inspector-heading">
                <span className="record-type">
                  {selection.record.source.type === "manual" ? "手动记录" : "来源记录"}
                </span>
                {props.memorySpaceId ? (
                  <RecordActions
                    memorySpaceId={props.memorySpaceId}
                    selection={selection}
                    onMutation={props.onRecordMutation}
                  />
                ) : null}
              </div>
              <h2>{selection.record.displayText || "未命名记录"}</h2>
              <code>{selection.record.id}</code>
              <p className="record-revision-meta">
                {selection.record.revisionSource === "user" ? "用户修订" : "Agent 修订"} ·{" "}
                {selection.record.revisionId}
              </p>
            </header>
            <dl>
              {selection.fields.map((field) => (
                <div key={field.id} className={!field.enabled ? "disabled-field-value" : ""}>
                  <dt>
                    {field.name}
                    {!field.enabled ? <em>已停用</em> : null}
                  </dt>
                  <dd>
                    {formatMemoryFieldValue(
                      selection.record.payload[field.id],
                      "未填写",
                      field.referenceTableId
                        ? selection.referenceRecords[field.referenceTableId]
                        : undefined,
                    )}
                    <FieldEvidenceList
                      evidence={selection.record.fieldEvidence[field.id] ?? []}
                      messages={props.messages}
                      onSelect={(sourceIds, missingIds) => {
                        setTab("chat");
                        props.onEvidenceSelect?.(sourceIds, missingIds);
                      }}
                    />
                  </dd>
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
        </div>
      ) : tab === "record" ? (
        <div className="inspector-empty">
          <Database size={24} />
          <p>选择一条记录查看字段原值与来源。</p>
        </div>
      ) : null}
    </>
  );
}

function FieldEvidenceList({
  evidence,
  messages,
  onSelect,
}: {
  readonly evidence: readonly MemoryEvidence[];
  readonly messages: readonly { readonly source_id: number }[];
  readonly onSelect?: (
    sourceIds: readonly number[],
    missingIds: readonly (string | number)[],
  ) => void;
}) {
  if (evidence.length === 0)
    return <span className="field-evidence empty">无证据（手动填写）</span>;
  return (
    <div className="field-evidence-list">
      {evidence.map((item) => {
        const sourceId = typeof item.source_id === "number" ? item.source_id : undefined;
        const exists =
          sourceId !== undefined && messages.some((message) => message.source_id === sourceId);
        const select = () =>
          onSelect?.(
            exists && sourceId !== undefined ? [sourceId] : [],
            exists ? [] : [item.source_id],
          );
        return (
          <button className="field-evidence" type="button" key={item.evidence_id} onClick={select}>
            <strong>
              {item.storage_mode === "snapshot" ? "快照" : "引用"} · {item.source_type}:
              {item.source_id}
            </strong>
            <span>
              {item.storage_mode === "snapshot"
                ? item.content
                : exists
                  ? "点击查看原始消息"
                  : "来源消息不存在"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
