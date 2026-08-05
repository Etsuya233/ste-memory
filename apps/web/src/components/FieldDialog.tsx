import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type {
  MemoryField,
  MemoryFieldInput,
  MemoryFieldPatch,
  MemoryFieldType,
} from "../api/memory-fields.ts";
import type { MemoryTable } from "../api/memory-tables.ts";
import { Button, Field, Select, Switch, TextArea, TextInput } from "../ui.tsx";

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
  const [key, setKey] = useState(props.field?.key ?? "");
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
      const common = { key, name, required, enabled, prompt, position };
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

  const typeLabel =
    FIELD_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog field-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <h2>{props.field ? "编辑字段" : "新增字段"}</h2>
            <p>类型创建后不可修改；显示顺序可随时调整。</p>
          </div>
          <button className="icon-btn" type="button" onClick={props.onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-body">
            <div className="form-grid">
              <Field label="字段 Key" htmlFor="field-key" required>
                <TextInput
                  id="field-key"
                  required
                  maxLength={120}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </Field>
              <Field label="字段名称" htmlFor="field-name" required>
                <TextInput
                  id="field-name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <div className="form-grid field-grid-second">
              <Field label="字段类型" htmlFor="field-type" hint={props.field ? "不可修改" : undefined}>
                <Select
                  id="field-type"
                  value={type}
                  disabled={Boolean(props.field)}
                  onChange={(e) => setType(e.target.value as MemoryFieldType)}
                >
                  {FIELD_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="显示顺序" htmlFor="field-position">
                <TextInput
                  id="field-position"
                  type="number"
                  min={0}
                  step={1}
                  value={position}
                  onChange={(e) => setPosition(e.target.valueAsNumber)}
                />
              </Field>
            </div>
            {isSelect ? (
              <Field
                label={`固定选项（每行一个）`}
                htmlFor="field-options"
                className="field-block-gap"
                required
              >
                <TextArea
                  id="field-options"
                  required
                  rows={5}
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                />
              </Field>
            ) : null}
            {isReference ? (
              <Field
                label="引用目标表"
                htmlFor="field-reference"
                className="field-block-gap"
                required
              >
                <Select
                  id="field-reference"
                  required
                  value={referenceTableId}
                  onChange={(e) => setReferenceTableId(e.target.value)}
                >
                  {props.tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field
              label="字段 Prompt"
              htmlFor="field-prompt"
              className="field-block-gap"
              hint={`Agent 如何填写${typeLabel}`}
            >
              <TextArea
                id="field-prompt"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <div className="field-checks field-block-gap">
              <Switch
                id="field-required"
                checked={required}
                onChange={setRequired}
                label="必填"
                hint="缺少时 Agent 无法创建记录"
              />
              <Switch
                id="field-enabled"
                checked={enabled}
                onChange={setEnabled}
                label="参与 Agent 自动填写"
              />
            </div>
            {error ? <p className="form-error">{error}</p> : null}
          </div>
          <footer className="dialog-footer">
            <Button variant="secondary" type="button" onClick={props.onClose}>
              取消
            </Button>
            <Button variant="primary" type="submit" loading={busy}>
              保存字段
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
