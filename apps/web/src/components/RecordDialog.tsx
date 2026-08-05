import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { MemoryField } from "../api/memory-fields.ts";
import {
  createMemoryRecord,
  updateMemoryRecord,
  type MemoryFieldValue,
  type MemoryRecord,
  type MemoryRecordsByTable,
} from "../api/memory-records.ts";
import { RecordFieldInput } from "./RecordFieldInput.tsx";
import { Button } from "../ui.tsx";

interface RecordDialogProps {
  readonly memorySpaceId: string;
  readonly tableId: string;
  readonly fields: readonly MemoryField[];
  readonly referenceRecords: MemoryRecordsByTable;
  readonly record?: MemoryRecord;
  readonly onClose: () => void;
  readonly onSaved: (record: MemoryRecord) => void;
}

export function RecordDialog(props: RecordDialogProps) {
  const [payload, setPayload] = useState<Record<string, MemoryFieldValue>>(() => ({
    ...props.record?.payload,
  }));
  const [sourceTime, setSourceTime] = useState("");
  const [sourceLocation, setSourceLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
      if (props.record) {
        const patch = Object.fromEntries(
          props.fields.flatMap((field) => {
            const previous = props.record!.payload[field.id];
            const current = payload[field.id];
            if (JSON.stringify(previous) === JSON.stringify(current)) return [];
            return [[field.id, current === undefined ? null : current]];
          }),
        );
        props.onSaved(
          await updateMemoryRecord(props.memorySpaceId, props.tableId, props.record.id, {
            expectedRevisionId: props.record.revisionId,
            patch,
          }),
        );
      } else {
        props.onSaved(
          await createMemoryRecord(props.memorySpaceId, props.tableId, { payload, source }),
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : props.record
            ? "无法更新记忆记录"
            : "无法创建记忆记录",
      );
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
            <h2>{props.record ? "编辑记忆记录" : "创建记忆记录"}</h2>
            <p>{props.record ? "保存后会归档当前快照。" : "填写结构化字段与可选来源。"}</p>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={props.onClose}>
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
                  field.referenceTableId
                    ? (props.referenceRecords[field.referenceTableId] ?? [])
                    : []
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
          {!props.record ? (
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
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <footer>
            <Button variant="secondary" type="button" onClick={props.onClose}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={busy} loading={busy}>
              {props.record ? "保存变更" : "创建记录"}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
