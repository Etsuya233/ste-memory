import { useId } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel } from "../primitives/field.tsx";
import { Switch } from "../primitives/switch.tsx";

/** Labeled switches keep label activation, help text and spacing consistent across pages. */
export function SwitchField({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description ? (
          <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
        ) : null}
      </FieldContent>
      <Switch
        id={id}
        aria-label={label}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}
