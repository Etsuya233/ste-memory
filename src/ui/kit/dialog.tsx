import { useEffect, useRef, type ComponentProps } from "react";

/** Native modal focus containment, Escape handling, and focus restoration. */
export function Dialog({
  label,
  onClose,
  children,
  className = "",
  contentClassName = "",
  ...props
}: Omit<ComponentProps<"dialog">, "open" | "onCancel"> & {
  readonly label: string;
  readonly onClose: () => void;
  readonly contentClassName?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement as HTMLElement;
    dialog.showModal();
    return () => {
      dialog.close();
      // React can remove the dialog before the native close algorithm restores focus.
      opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      {...props}
      ref={ref}
      className={`ui-dialog ${className}`}
      aria-label={label}
      role="dialog"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented && event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`ui-dialog-content ${contentClassName}`}>{children}</div>
    </dialog>
  );
}
