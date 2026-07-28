import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { deleteMemoryRecord, type MemoryRecord } from "../api/memory-records.ts";
import { RecordDialog } from "./RecordDialog.tsx";
import type { RecordSelection } from "./RecordTable.tsx";

interface RecordActionsProps {
  readonly memorySpaceId: string;
  readonly selection: RecordSelection;
  readonly onMutation: (record: MemoryRecord | undefined) => void;
}

export function RecordActions({ memorySpaceId, selection, onMutation }: RecordActionsProps) {
  const [mode, setMode] = useState<"edit" | "delete">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await deleteMemoryRecord(
        memorySpaceId,
        selection.record.tableId,
        selection.record.id,
        selection.record.revisionId,
      );
      setMode(undefined);
      onMutation(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法删除记忆记录");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="record-actions">
      <button
        className="icon-button"
        type="button"
        title="编辑记录"
        aria-label="编辑记录"
        onClick={() => setMode("edit")}
      >
        <Pencil size={14} />
      </button>
      <button
        className="icon-button danger"
        type="button"
        title="删除记录"
        aria-label="删除记录"
        onClick={() => setMode("delete")}
      >
        <Trash2 size={14} />
      </button>
      {mode === "edit" ? (
        <RecordDialog
          memorySpaceId={memorySpaceId}
          tableId={selection.record.tableId}
          fields={selection.fields}
          referenceRecords={selection.referenceRecords}
          record={selection.record}
          onClose={() => setMode(undefined)}
          onSaved={(record) => {
            setMode(undefined);
            onMutation(record);
          }}
        />
      ) : null}
      {mode === "delete" ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setMode(undefined)}>
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2>删除记忆记录</h2>
            </header>
            <div className="record-delete-dialog">
              <p>
                删除“{selection.record.displayText || "未命名记录"}
                ”后，当前记录会被物理删除，旧状态仍保留在只读历史中。
              </p>
              {error ? <p className="form-error">{error}</p> : null}
              <footer>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setMode(undefined)}
                >
                  取消
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {busy ? "删除中..." : "确认删除"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
