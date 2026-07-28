import { X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MemoryField } from "../api/memory-fields.ts";
import {
  createMemoryRecord,
  listMemoryRecords,
  type MemoryFieldValue,
  type MemoryRecord,
} from "../api/memory-records.ts";
import { RecordFieldInput } from "./RecordFieldInput.tsx";

interface RecordDialogProps {
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly fields: readonly MemoryField[];
  readonly onClose: () => void;
  readonly onCreated: (record: MemoryRecord) => void;
}

export function RecordDialog(props: RecordDialogProps) {
  const [payload, setPayload] = useState<Record<string, MemoryFieldValue>>({});
  const [references, setReferences] = useState<Record<string, readonly MemoryRecord[]>>({});
  const [sourceTime, setSourceTime] = useState("");
  const [sourceLocation, setSourceLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const tableIds = [
      ...new Set(
        props.fields.flatMap((field) => (field.referenceTableId ? [field.referenceTableId] : [])),
      ),
    ];
    void Promise.all(
      tableIds.map(
        async (tableId) =>
          [
            tableId,
            (
              await listMemoryRecords(props.memorySpaceId, tableId, {
                page: 1,
                pageSize: 100,
                search: "",
              })
            ).records,
          ] as const,
      ),
    ).then((entries) => setReferences(Object.fromEntries(entries)));
  }, [props.fields, props.memorySpaceId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const source =
        sourceTime || sourceLocation
          ? {
              type: "source" as const,
              sourceTime: sourceTime ? new Date(sourceTime).toISOString() : null,
              sourceLocation: sourceLocation.trim() || null,
            }
          : undefined;
      props.onCreated(
        await createMemoryRecord(props.memorySpaceId, props.tableId, { payload, source }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建记忆记录");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="dialog record-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>创建记忆记录</h2>
            <p>填写结构化字段与可选来源。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={props.onClose}>
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="record-form-fields">
            {props.fields.map((field) => (
              <RecordFieldInput
                key={field.id}
                field={field}
                value={payload[field.id]}
                referenceRecords={
                  field.referenceTableId ? (references[field.referenceTableId] ?? []) : []
                }
                onChange={(value) =>
                  setPayload((current) => {
                    const next = { ...current };
                    if (value === undefined) delete next[field.id];
                    else next[field.id] = value;
                    return next;
                  })
                }
              />
            ))}
          </div>
          <fieldset className="record-source-fields">
            <legend>来源信息</legend>
            <label>
              <span>来源时间</span>
              <input
                type="datetime-local"
                value={sourceTime}
                onChange={(event) => setSourceTime(event.target.value)}
              />
            </label>
            <label>
              <span>来源定位</span>
              <input
                value={sourceLocation}
                placeholder="例如：消息 42"
                onChange={(event) => setSourceLocation(event.target.value)}
              />
            </label>
            <p>
              {sourceTime || sourceLocation ? "将保存来源信息" : "未填写来源，将标记为手动记录"}
            </p>
          </fieldset>
          {error ? <p className="form-error">{error}</p> : null}
          <footer>
            <button type="button" className="secondary-button" onClick={props.onClose}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "创建中..." : "创建记录"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
