import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type {
  MemoryField,
  MemoryFieldInput,
  MemoryFieldPatch,
  MemoryFieldType,
} from "../api/memory-fields.ts";
import type { MemoryTable } from "../api/memory-tables.ts";

export const FIELD_TYPE_OPTIONS: readonly { value: MemoryFieldType; label: string }[] = [
  { value: "short_text", label: "短文本" },
  { value: "long_text", label: "长文本" },
  { value: "short_text_list", label: "自由短文本列表" },
  { value: "integer", label: "整数" },
  { value: "decimal", label: "小数" },
  { value: "boolean", label: "布尔" },
  { value: "date", label: "日期" },
  { value: "datetime", label: "日期时间" },
  { value: "single_select", label: "单选" },
  { value: "multi_select", label: "多选" },
  { value: "single_reference", label: "单引用" },
  { value: "multi_reference", label: "多引用" },
];

interface FieldDialogProps {
  readonly field?: MemoryField;
  readonly nextPosition: number;
  readonly tables: readonly MemoryTable[];
  readonly onClose: () => void;
  readonly onSubmit: (input: MemoryFieldInput | MemoryFieldPatch) => Promise<void>;
}

export function FieldDialog(props: FieldDialogProps) {
  const [name, setName] = useState(props.field?.name ?? "");
  const [type, setType] = useState<MemoryFieldType>(props.field?.type ?? "short_text");
  const [required, setRequired] = useState(props.field?.required ?? false);
  const [enabled, setEnabled] = useState(props.field?.enabled ?? true);
  const [prompt, setPrompt] = useState(props.field?.prompt ?? "");
  const [position, setPosition] = useState(props.field?.position ?? props.nextPosition);
  const [options, setOptions] = useState(props.field?.options.join("\n") ?? "");
  const [referenceTableId, setReferenceTableId] = useState(
    props.field?.referenceTableId ?? props.tables[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isSelect = type === "single_select" || type === "multi_select";
  const isReference = type === "single_reference" || type === "multi_reference";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const common = { name, required, enabled, prompt, position };
      await props.onSubmit(
        props.field
          ? {
              ...common,
              ...(isSelect ? { options: options.split("\n") } : {}),
              ...(isReference ? { referenceTableId } : {}),
            }
          : {
              ...common,
              type,
              ...(isSelect ? { options: options.split("\n") } : {}),
              ...(isReference ? { referenceTableId } : {}),
            },
      );
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存字段");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog field-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header">
          <h2>{props.field ? "编辑字段" : "新增字段"}</h2>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="field-form-grid">
            <label>
              <span>字段名称</span>
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <span>字段类型</span>
              <select
                value={type}
                disabled={Boolean(props.field)}
                onChange={(e) => setType(e.target.value as MemoryFieldType)}
              >
                {FIELD_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>显示顺序</span>
              <input
                type="number"
                min={0}
                step={1}
                value={position}
                onChange={(e) => setPosition(e.target.valueAsNumber)}
              />
            </label>
          </div>
          {isSelect ? (
            <label>
              <span>固定选项</span>
              <textarea
                required
                rows={5}
                value={options}
                onChange={(e) => setOptions(e.target.value)}
              />
            </label>
          ) : null}
          {isReference ? (
            <label>
              <span>引用目标表</span>
              <select
                required
                value={referenceTableId}
                onChange={(e) => setReferenceTableId(e.target.value)}
              >
                {props.tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>字段 Prompt</span>
            <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <div className="field-checks">
            <label>
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              <span>必填</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>参与 Agent 自动填写</span>
            </label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <footer className="dialog-footer">
            <button className="secondary-button" type="button" onClick={props.onClose}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "保存中..." : "保存字段"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
