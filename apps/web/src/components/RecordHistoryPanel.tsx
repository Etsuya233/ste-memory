import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { listMemoryRecordHistory, type MemoryRecordHistory } from "../api/memory-records.ts";
import type { RecordSelection } from "./RecordTable.tsx";
import { formatMemoryFieldValue } from "./memory-record-value.ts";

interface RecordHistoryPanelProps {
  readonly memorySpaceId: string;
  readonly selection: RecordSelection;
}

export function RecordHistoryPanel({ memorySpaceId, selection }: RecordHistoryPanelProps) {
  const [history, setHistory] = useState<readonly MemoryRecordHistory[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void listMemoryRecordHistory(memorySpaceId, {
      tableId: selection.record.tableId,
      recordId: selection.record.id,
    })
      .then((items) => {
        if (!active) return;
        setHistory(items);
        setSelectedId(items[0]?.id);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取修订历史");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [memorySpaceId, selection.record.id, selection.record.tableId]);

  const snapshot = history.find((item) => item.id === selectedId);
  if (loading) return <div className="inspector-empty">正在读取历史...</div>;
  if (error) return <p className="form-error history-error">{error}</p>;
  if (history.length === 0) {
    return (
      <div className="inspector-empty">
        <History size={24} />
        <p>这条记录还没有历史快照。</p>
      </div>
    );
  }
  return (
    <div className="record-history-panel">
      <div className="record-history-list">
        {history.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === selectedId ? "active" : ""}
            onClick={() => setSelectedId(item.id)}
          >
            <strong>{new Date(item.archivedAt).toLocaleString()}</strong>
            <span>{item.revisionSource === "user" ? "用户变更" : "Agent 变更"}</span>
          </button>
        ))}
      </div>
      {snapshot ? (
        <section className="history-snapshot">
          <header>
            <span>归档前快照</span>
            <h2>{snapshot.displayText || "未命名记录"}</h2>
            <code>{snapshot.previousRevisionId}</code>
          </header>
          <dl>
            {selection.fields.map((field) => (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd>
                  {formatMemoryFieldValue(
                    snapshot.payload[field.id],
                    "未填写",
                    field.referenceTableId
                      ? selection.referenceRecords[field.referenceTableId]
                      : undefined,
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="history-archive-meta">
            由{snapshot.revisionSource === "user" ? "用户" : " Agent"}修订归档 · 修订 ID{" "}
            <code>{snapshot.revisionId}</code>
          </p>
        </section>
      ) : null}
    </div>
  );
}
