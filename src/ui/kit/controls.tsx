import { useId, type ComponentProps, type ReactNode } from "react";

/** Native attributes, events and refs pass through; the kit owns only presentation. */
export function Button({
  className = "",
  variant = "default",
  ...props
}: ComponentProps<"button"> & {
  readonly variant?: "default" | "primary" | "danger";
}) {
  return (
    <button type="button" {...props} className={`ui-button ui-button--${variant} ${className}`} />
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...props} className={`ui-input ${className}`} />;
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={`ui-input ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select {...props} className={`ui-input ${className}`} />;
}

export function FormSection({
  title,
  children,
  className = "",
  ...props
}: ComponentProps<"fieldset"> & {
  readonly title: string;
}) {
  return (
    <fieldset {...props} className={`ui-form-section ${className}`}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

/** The label is part of the hit target; disabled semantics stay on the native input. */
export function Switch({
  className = "",
  label,
  title,
  ...props
}: Omit<ComponentProps<"input">, "type" | "children"> & {
  readonly label?: string;
}) {
  return (
    <label className={`ui-switch ${className}`} title={title} data-ui-unframed>
      <input {...props} type="checkbox" aria-label={label ?? props["aria-label"]} />
      <span className="ui-switch-track" aria-hidden="true" />
    </label>
  );
}

/** Owns the label/help/error association while preserving the actual input element. */
export function FormField({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly className?: string;
  readonly children: (attributes: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
}) {
  const id = useId();
  const description = error ?? hint;
  return (
    <div className={`ui-form-field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-describedby": description != null ? `${id}-description` : undefined,
        "aria-invalid": error != null ? true : undefined,
      })}
      {description != null && (
        <div
          id={`${id}-description`}
          className={error != null ? "ui-field-error" : "ui-field-hint"}
        >
          {description}
        </div>
      )}
    </div>
  );
}
