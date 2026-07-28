import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { MemoryTable, MemoryTableInput } from "../api/memory-tables.ts";

interface CommonDialogProps {
  readonly onClose: () => void;
}

interface CreateTableDialogProps extends CommonDialogProps {
  readonly mode: "create";
  readonly onCreate: (input: MemoryTableInput) => Promise<void>;
}

interface DeleteTableDialogProps extends CommonDialogProps {
  readonly mode: "delete";
  readonly table: MemoryTable;
  readonly onDelete: () => Promise<void>;
}

type TableDialogProps = CreateTableDialogProps | DeleteTableDialogProps;

export function TableDialog(props: TableDialogProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (props.mode === "create") {
        await props.onCreate({ key, name, description, prompt });
      } else {
        await props.onDelete();
      }
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const title = props.mode === "create" ? "创建自定义表" : "删除记忆表格";
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-dialog-title"
      >
        <header className="dialog-header">
          <h2 id="table-dialog-title">{title}</h2>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          {props.mode === "delete" ? (
            <p className="delete-copy">
              将物理删除“{props.table.name}”。删除后无法从历史记录恢复，请确认该表不再需要。
            </p>
          ) : (
            <div className="table-create-fields">
              <label>
                <span>表格 Key</span>
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
              </label>
              <label>
                <span>表格名称</span>
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                <span>描述</span>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                <span>表级 Prompt</span>
                <textarea
                  rows={5}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
            </div>
          )}
          {error ? <p className="form-error">{error}</p> : null}
          <footer className="dialog-footer">
            <button className="secondary-button" type="button" onClick={props.onClose}>
              取消
            </button>
            <button
              className={props.mode === "delete" ? "danger-button" : "primary-button"}
              type="submit"
              disabled={busy}
            >
              {busy ? "处理中..." : props.mode === "delete" ? "确认物理删除" : "创建表格"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
