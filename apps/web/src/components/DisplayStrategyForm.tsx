import { Braces, Save, Type } from "lucide-react";
import { useState, type FormEvent } from "react";
import { updateDisplayStrategy, type MemoryField } from "../api/memory-fields.ts";
import type { MemoryTable } from "../api/memory-tables.ts";

interface DisplayStrategyFormProps {
  readonly fields: readonly MemoryField[];
  readonly memorySpaceId: string;
  readonly table: MemoryTable;
  readonly onSaved: (table: MemoryTable) => void;
}

export function DisplayStrategyForm(props: DisplayStrategyFormProps) {
  const initial = props.table.displayStrategy;
  const [mode, setMode] = useState<"field" | "template">(initial?.type ?? "field");
  const enabledFields = props.fields.filter((field) => field.enabled);
  const shortTextFields = enabledFields.filter((field) => field.type === "short_text");
  const [fieldId, setFieldId] = useState(
    initial?.type === "field" ? initial.fieldId : (shortTextFields[0]?.id ?? ""),
  );
  const [template, setTemplate] = useState(initial?.type === "template" ? initial.template : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const updated = await updateDisplayStrategy(
        props.memorySpaceId,
        props.table.id,
        mode === "field" ? { type: "field", fieldId } : { type: "template", template },
      );
      props.onSaved(updated as MemoryTable);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存显示策略");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="display-strategy" onSubmit={(event) => void save(event)}>
      <header className="definition-section-heading">
        <div>
          <h3>记录显示策略</h3>
          <span>{props.table.displayStrategy ? "已配置" : "待配置"}</span>
        </div>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || (mode === "field" && !fieldId)}
        >
          <Save size={14} /> {busy ? "保存中..." : "保存策略"}
        </button>
      </header>
      <div className="strategy-modes" role="group" aria-label="显示策略类型">
        <button
          className={mode === "field" ? "active" : ""}
          type="button"
          onClick={() => setMode("field")}
        >
          <Type size={14} /> 短文本字段
        </button>
        <button
          className={mode === "template" ? "active" : ""}
          type="button"
          onClick={() => setMode("template")}
        >
          <Braces size={14} /> 派生模板
        </button>
      </div>
      {mode === "field" ? (
        <label>
          <span>显示字段</span>
          <select required value={fieldId} onChange={(event) => setFieldId(event.target.value)}>
            <option value="" disabled>
              选择短文本字段
            </option>
            {shortTextFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="template-editor">
          <label>
            <span>显示模板</span>
            <input
              required
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
            />
          </label>
          <div className="template-fields">
            {enabledFields.map((field) => (
              <button
                key={field.id}
                type="button"
                onClick={() => setTemplate((current) => `${current}{${field.id}}`)}
              >
                {field.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
