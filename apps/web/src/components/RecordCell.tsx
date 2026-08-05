import { useState } from "react";
import type { MemoryField } from "../api/memory-fields.ts";
import type { MemoryFieldValue, MemoryRecord } from "../api/memory-records.ts";
import { formatMemoryFieldValue } from "./memory-record-value.ts";
import { DateTimeInput } from "./DateTimeInput.tsx";

interface RecordCellProps {
  readonly field: MemoryField;
  readonly value: MemoryFieldValue | undefined;
  readonly referenceRecords: readonly MemoryRecord[];
  readonly disabled?: boolean;
  readonly onBlur?: () => void;
  readonly onChange: (value: MemoryFieldValue | undefined) => void;
}

export function RecordCell({
  field,
  value,
  referenceRecords,
  disabled = false,
  onBlur,
  onChange,
}: RecordCellProps) {
  const [editing, setEditing] = useState(false);
  const label = `${field.name}${field.required ? "（必填）" : ""}`;

  if (!editing) {
    return (
      <div
        className={`record-cell-value ${disabled ? "disabled" : ""}`}
        tabIndex={disabled ? undefined : 0}
        onFocus={() => setEditing(true)}
      >
        {formatMemoryFieldValue(
          value,
          "未填写",
          field.referenceTableId ? referenceRecords : undefined,
        )}
      </div>
    );
  }

  function finishEditing() {
    setEditing(false);
    onBlur?.();
  }

  let control;
  if (field.type === "short_text" || field.type === "long_text") {
    control = (
      <textarea
        aria-label={label}
        autoFocus
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onBlur={finishEditing}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    );
  } else if (field.type === "short_text_list") {
    control = (
      <textarea
        aria-label={label}
        autoFocus
        required={field.required}
        value={Array.isArray(value) ? value.join(", ") : ""}
        onBlur={finishEditing}
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
        aria-label={label}
        autoFocus
        required={field.required}
        step={field.type === "integer" ? 1 : "any"}
        type="number"
        value={typeof value === "number" ? value : ""}
        onBlur={finishEditing}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    );
  } else if (field.type === "boolean") {
    control = (
      <select
        aria-label={label}
        autoFocus
        required={field.required}
        value={typeof value === "boolean" ? String(value) : ""}
        onBlur={finishEditing}
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
    control =
      field.type === "datetime" ? (
        <DateTimeInput
          ariaLabel={label}
          required={field.required}
          autoFocus
          value={typeof value === "string" ? value : undefined}
          onBlur={finishEditing}
          onChange={(next) => onChange(next)}
        />
      ) : (
        <input
          aria-label={label}
          autoFocus
          required={field.required}
          type="date"
          value={typeof value === "string" ? value : ""}
          onBlur={finishEditing}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      );
  } else if (field.type === "single_select" || field.type === "single_reference") {
    const options =
      field.type === "single_select"
        ? field.options.map((option) => ({ value: option, label: option }))
        : referenceRecords.map((record) => ({
            value: record.id,
            label: `${record.displayText || "未命名记录"} · ${record.id}`,
          }));
    control = (
      <select
        aria-label={label}
        autoFocus
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onBlur={finishEditing}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">未填写</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else {
    const options =
      field.type === "multi_select"
        ? field.options.map((option) => ({ value: option, label: option }))
        : referenceRecords.map((record) => ({
            value: record.id,
            label: `${record.displayText || "未命名记录"} · ${record.id}`,
          }));
    control = (
      <select
        aria-label={label}
        autoFocus
        multiple
        required={field.required}
        value={Array.isArray(value) ? [...value] : []}
        onBlur={finishEditing}
        onChange={(event) =>
          onChange([...event.target.selectedOptions].map((option) => option.value))
        }
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return <div className="record-cell-editor">{control}</div>;
}
