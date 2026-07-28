import type { MemoryField, MemoryFieldType } from "../api/memory-fields.ts";
import type { MemoryFieldValue, MemoryRecord } from "../api/memory-records.ts";

interface RecordFieldInputProps {
  readonly field: MemoryField;
  readonly value: MemoryFieldValue | undefined;
  readonly referenceRecords: readonly MemoryRecord[];
  readonly onChange: (value: MemoryFieldValue | undefined) => void;
}

const textTypes: readonly MemoryFieldType[] = ["short_text", "long_text"];

export function RecordFieldInput({
  field,
  value,
  referenceRecords,
  onChange,
}: RecordFieldInputProps) {
  const id = `record-field-${field.id}`;
  let control;
  if (textTypes.includes(field.type)) {
    const props = {
      id,
      required: field.required,
      value: typeof value === "string" ? value : "",
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value || undefined),
    };
    control = field.type === "long_text" ? <textarea {...props} rows={3} /> : <input {...props} />;
  } else if (field.type === "short_text_list") {
    control = (
      <input
        id={id}
        required={field.required}
        value={Array.isArray(value) ? value.join(", ") : ""}
        placeholder="使用逗号分隔"
        onChange={(event) =>
          onChange(
            event.target.value.trim()
              ? event.target.value.split(",").map((item) => item.trim())
              : undefined,
          )
        }
      />
    );
  } else if (field.type === "integer" || field.type === "decimal") {
    control = (
      <input
        id={id}
        type="number"
        required={field.required}
        step={field.type === "integer" ? 1 : "any"}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    );
  } else if (field.type === "boolean") {
    control = (
      <select
        id={id}
        required={field.required}
        value={typeof value === "boolean" ? String(value) : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : event.target.value === "true")
        }
      >
        <option value="">未填写</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  } else if (field.type === "date" || field.type === "datetime") {
    control = (
      <input
        id={id}
        type={field.type === "date" ? "date" : "datetime-local"}
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    );
  } else if (field.type === "single_select") {
    control = (
      <select
        id={id}
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">未填写</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "single_reference") {
    control = (
      <select
        id={id}
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">未填写</option>
        {referenceRecords.map((record) => (
          <option key={record.id} value={record.id}>
            {record.displayText || "未命名记录"} · {record.id}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "multi_reference") {
    control = (
      <select
        id={id}
        multiple
        required={field.required}
        value={Array.isArray(value) ? [...value] : []}
        onChange={(event) =>
          onChange([...event.target.selectedOptions].map((option) => option.value))
        }
      >
        {referenceRecords.map((record) => (
          <option key={record.id} value={record.id}>
            {record.displayText || "未命名记录"} · {record.id}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <select
        id={id}
        multiple
        required={field.required}
        value={Array.isArray(value) ? [...value] : []}
        onChange={(event) =>
          onChange([...event.target.selectedOptions].map((option) => option.value))
        }
      >
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <label className="record-field-input" htmlFor={id}>
      <span>
        {field.name} {field.required ? <strong>必填</strong> : null}
        {!field.enabled ? <em>已停用</em> : null}
      </span>
      {control}
    </label>
  );
}
