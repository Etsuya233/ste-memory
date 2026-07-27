import { FileJson, Upload, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MemorySpace } from "../api/memory-spaces.ts";

interface SpaceDialogProps {
  readonly mode: "create" | "rename" | "delete";
  readonly space?: MemorySpace;
  readonly busy: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onCreate: (name: string, file: File) => Promise<void>;
  readonly onDelete: () => Promise<void>;
  readonly onRename: (name: string) => Promise<void>;
}

export function SpaceDialog(props: SpaceDialogProps) {
  const [name, setName] = useState(props.space?.name ?? "");
  const [file, setFile] = useState<File>();

  useEffect(() => setName(props.space?.name ?? ""), [props.space?.name]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (props.mode === "create" && file) await props.onCreate(name, file);
    if (props.mode === "rename") await props.onRename(name);
    if (props.mode === "delete") await props.onDelete();
  }

  const title =
    props.mode === "create" ? "创建记忆空间" : props.mode === "rename" ? "重命名" : "删除记忆空间";

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          {props.mode === "delete" ? (
            <p className="delete-copy">
              将删除“{props.space?.name}”及其完整原始聊天，此操作无法撤销。
            </p>
          ) : (
            <label>
              <span>空间名称</span>
              <input
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {props.mode === "create" ? (
            <label className="file-field">
              <span>聊天 JSONL</span>
              <input
                required
                type="file"
                accept=".jsonl,application/jsonl"
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  setFile(selected);
                  if (selected && name.length === 0)
                    setName(selected.name.replace(/\.jsonl$/iu, ""));
                }}
              />
              <div className="file-picker">
                <FileJson size={20} />
                <span>{file?.name ?? "选择 .jsonl 文件"}</span>
                <Upload size={16} />
              </div>
            </label>
          ) : null}
          {props.error ? <p className="form-error">{props.error}</p> : null}
          <footer className="dialog-footer">
            <button className="secondary-button" type="button" onClick={props.onClose}>
              取消
            </button>
            <button
              className={props.mode === "delete" ? "danger-button" : "primary-button"}
              type="submit"
              disabled={props.busy || (props.mode === "create" && !file)}
            >
              {props.busy ? "处理中..." : props.mode === "delete" ? "确认删除" : "保存"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
