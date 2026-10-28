import type { MemoryField, MemoryRecord, MemoryTableId } from "../../features/memory/index.ts";
import { Input } from "../../ui/primitives/input.tsx";
import { Textarea } from "../../ui/primitives/textarea.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Switch } from "../../ui/primitives/switch.tsx";
import { Checkbox } from "../../ui/primitives/checkbox.tsx";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldLegend,
} from "../../ui/primitives/field.tsx";
import { recordFieldValueText, type RecordFormValue } from "../../ui/memory/record-form-model.ts";

export function RecordFieldInput({
  field,
  value,
  references,
  error,
  onChange,
}: {
  field: MemoryField;
  value: RecordFormValue;
  references: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
  error?: string;
  onChange: (value: RecordFormValue) => void;
}) {
  const id = `ste-field-${field.id}`;
  const isMulti = field.type === "multi_select" || field.type === "multi_reference";
  const options = field.referenceTableId
    ? (references.get(field.referenceTableId) ?? []).map((record) => ({
        value: record.id as string,
        label: record.displayText,
      }))
    : field.options.map((option) => ({ value: option, label: option }));
  const control = {
    id,
    "aria-label": field.name,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${id}-error` : undefined,
    "data-stm-field": `record-value-${field.key}`,
  };
  if (isMulti) {
    const selected = Array.isArray(value) ? value : [];
    const missing = selected.filter((item) => !options.some((option) => option.value === item));
    return (
      <FieldSet data-invalid={!!error}>
        <FieldLegend variant="label">
          {field.name}
          {field.required ? " *" : ""}
        </FieldLegend>
        <div
          role="group"
          aria-label={field.name}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          tabIndex={error ? -1 : undefined}
          className="ste:flex ste:flex-col ste:gap-3"
        >
          {[
            ...options,
            ...missing.map((item) => ({ value: item, label: `${item}（已失效）` })),
          ].map((option, index) => (
            <Field key={option.value} orientation="horizontal">
              <Checkbox
                id={`${id}-${index}`}
                aria-label={option.label}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-${index}`}>{option.label}</FieldLabel>
            </Field>
          ))}
          {options.length === 0 && missing.length === 0 ? (
            <FieldDescription>暂无可选记录</FieldDescription>
          ) : null}
        </div>
        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      </FieldSet>
    );
  }
  let input;
  switch (field.type) {
    case "boolean":
      input = <Switch {...control} checked={value === true} onCheckedChange={onChange} />;
      break;
    case "long_text":
    case "short_text_list":
      input = (
        <Textarea
          {...control}
          className="ste:min-h-32 ste:resize-y"
          value={Array.isArray(value) ? value.join("\n") : String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case "single_select":
    case "single_reference":
      input = (
        <NativeSelect
          {...control}
          className="ste:w-full"
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">请选择</option>
          {value && !options.some((option) => option.value === value) ? (
            <option value={String(value)}>{String(value)}（已失效）</option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      );
      break;
    default:
      input = (
        <Input
          {...control}
          type={
            field.type === "integer" || field.type === "decimal"
              ? "number"
              : field.type === "date"
                ? "date"
                : field.type === "datetime"
                  ? "datetime-local"
                  : "text"
          }
          step={field.type === "decimal" ? "any" : field.type === "integer" ? "1" : undefined}
          maxLength={field.type === "short_text" ? (field.maxChars ?? undefined) : undefined}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>
        {field.name}
        {field.required ? " *" : ""}
      </FieldLabel>
      {input}
      {field.type === "short_text_list" ? (
        <FieldDescription>每行一项，也支持逗号或顿号分隔。</FieldDescription>
      ) : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export function referenceLabels(
  references: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>,
): ReadonlyMap<string, string> {
  return new Map(
    [...references.values()].flatMap((records) =>
      records.map((record) => [record.id, record.displayText]),
    ),
  );
}

export function recordPreview(
  record: MemoryRecord,
  fields: readonly MemoryField[],
  labels: ReadonlyMap<string, string>,
): string {
  return fields
    .filter((field) => field.enabled)
    .map((field) => recordFieldValueText(field, record.payload[field.id], labels))
    .filter((text) => text !== "—" && text.trim() !== record.displayText.trim())
    .slice(0, 2)
    .join(" · ");
}
