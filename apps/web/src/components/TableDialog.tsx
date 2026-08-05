import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { MemoryTable, MemoryTableInput } from "../api/memory-tables.ts";
import { Button, Field, TextArea, TextInput } from "../ui.tsx";

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
          <div>
            <h2 id="table-dialog-title">{title}</h2>
            <p>
              {props.mode === "create"
                ? "自定义表会参与 Agent 填表，字段稍后在「字段配置」中定义"
                : "删除后无法从历史记录恢复"}
            </p>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-body">
            {props.mode === "delete" ? (
              <p className="delete-copy">
                将物理删除 <strong>「{props.table.name}」</strong>及其全部记录与字段。
                删除后无法从历史记录恢复，请确认该表不再需要。
              </p>
            ) : (
              <div className="table-create-fields">
                <div className="form-grid">
                  <Field label="表格 Key" htmlFor="table-key" required hint="小写字母/数字/下划线">
                    <TextInput
                      id="table-key"
                      autoFocus
                      required
                      maxLength={120}
                      placeholder="如 characters"
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                    />
                  </Field>
                  <Field label="表格名称" htmlFor="table-name" required>
                    <TextInput
                      id="table-name"
                      required
                      maxLength={120}
                      placeholder="如 人物"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                </div>
                <Field label="描述" htmlFor="table-desc" className="table-create-gap">
                  <TextArea
                    id="table-desc"
                    rows={2}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>
                <Field
                  label="表级 Prompt"
                  htmlFor="table-prompt"
                  className="table-create-gap"
                  hint="Agent 填表时如何抽取该表"
                >
                  <TextArea
                    id="table-prompt"
                    rows={5}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </Field>
              </div>
            )}
            {error ? <p className="form-error">{error}</p> : null}
          </div>
          <footer className="dialog-footer">
            <Button variant="secondary" type="button" onClick={props.onClose}>
              取消
            </Button>
            <Button
              variant={props.mode === "delete" ? "danger" : "primary"}
              type="submit"
              loading={busy}
            >
              {props.mode === "delete" ? "确认物理删除" : "创建表格"}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
