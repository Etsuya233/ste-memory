import { useState, type ComponentProps } from "react";

/** 标准图标操作；原生按钮属性保留表单、键盘、ref 和页面事件能力。 */
export function IconButton({
  children,
  label,
  emphasis = false,
  danger = false,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onLostPointerCapture,
  ...props
}: Omit<ComponentProps<"button">, "className" | "aria-label"> & {
  readonly label: string;
  readonly emphasis?: boolean;
  readonly danger?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      {...props}
      data-pressed={pressed}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (props.disabled || event.defaultPrevented || event.button !== 0) return;
        setPressed(true);
      }}
      onPointerUp={(event) => {
        setPressed(false);
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        setPressed(false);
        onPointerCancel?.(event);
      }}
      onPointerLeave={(event) => {
        setPressed(false);
        onPointerLeave?.(event);
      }}
      onLostPointerCapture={(event) => {
        setPressed(false);
        onLostPointerCapture?.(event);
      }}
      className={`ui-icon-button${emphasis ? " ui-icon-button--primary" : ""}${danger ? " ui-icon-button--danger" : ""}`}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export function ActionGroup({
  className = "",
  frame = "auto",
  ...props
}: ComponentProps<"div"> & { readonly frame?: "auto" | "none" | "always" }) {
  return <div {...props} className={`ui-action-group ${className}`} data-frame={frame} />;
}
