import { useId, useRef, useState } from "react";
import { PanelBarAction } from "../shell/panel-bar.tsx";

export interface SettingsMenuAction {
  readonly label: string;
  readonly dataAction: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

/** Native auto popovers handle outside presses and Escape in the panel's top layer. */
export function SettingsActionMenu(props: {
  readonly label?: string;
  readonly actions: readonly SettingsMenuAction[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  function openMenu() {
    const button = trigger.current!;
    const panel = button.closest<HTMLElement>(".stm-panel")!.getBoundingClientRect();
    const anchor = button.getBoundingClientRect();
    const width = Math.min(248, panel.width - 32);
    Object.assign(menu.current!.style, {
      width: `${width}px`,
      left: `${Math.max(panel.left + 16, Math.min(anchor.right - width, panel.right - width - 16))}px`,
      top: `${anchor.bottom + 8}px`,
      maxHeight: `${window.innerHeight - anchor.bottom - 24}px`,
    });
    menu.current!.togglePopover();
  }
  return (
    <>
      <PanelBarAction
        ref={trigger}
        id={`${id}-button`}
        icon="fa-ellipsis"
        label={props.label ?? "更多操作"}
        data-action="settings-more"
        disabled={props.actions.every((action) => action.disabled)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={id}
        onClick={openMenu}
      />
      <div
        id={id}
        ref={menu}
        popover="auto"
        role="menu"
        aria-labelledby={`${id}-button`}
        className="stm-settings-action-menu"
        onToggle={(event) => {
          setOpen(event.newState === "open");
          if (event.newState === "open")
            menu.current!.querySelector<HTMLButtonElement>("button:not(:disabled)")!.focus();
          else trigger.current?.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = [
            ...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          ];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]!.focus();
        }}
      >
        {props.actions.map((action) => (
          <button
            key={action.dataAction}
            type="button"
            role="menuitem"
            data-action={action.dataAction}
            disabled={action.disabled}
            className={action.danger ? "stm-settings-menu-danger" : undefined}
            onClick={() => {
              menu.current!.hidePopover();
              action.onSelect();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}
