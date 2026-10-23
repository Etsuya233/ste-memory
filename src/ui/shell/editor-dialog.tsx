import { useEffect, useRef, type ReactNode } from "react";

/** 原生模态层负责焦点约束、Escape 和关闭后的焦点恢复。 */
export function EditorDialog(props: {
  readonly label: string;
  readonly section: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="stm-editor-dialog stm-modal-overlay stm-modal-overlay--sheet"
      aria-label={props.label}
      data-stm-section={props.section}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className="stm-modal stm-modal--editor">{props.children}</div>
    </dialog>
  );
}
