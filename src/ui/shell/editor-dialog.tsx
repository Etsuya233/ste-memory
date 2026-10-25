import type { ReactNode } from "react";
import { Dialog } from "../kit/dialog.tsx";

/** The shell supplies editor geometry; the kit owns native modal behavior. */
export function EditorDialog(props: {
  readonly label: string;
  readonly section: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      label={props.label}
      onClose={props.onClose}
      data-stm-section={props.section}
      className="stm-modal-overlay--sheet"
      contentClassName="stm-modal stm-modal--editor"
    >
      {props.children}
    </Dialog>
  );
}
