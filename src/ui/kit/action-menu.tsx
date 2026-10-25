import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

export interface MenuAction {
  readonly label: string;
  readonly id: string;
  readonly dataAction?: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

/** Native auto popovers handle outside presses and Escape in the panel's top layer. */
export function ActionMenu(props: {
  readonly label?: string;
  readonly actions: readonly MenuAction[];
  readonly renderTrigger?: (props: ComponentProps<"button">) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  function openMenu() {
    const button = trigger.current!;
    const panel = button.closest<HTMLElement>(".ui-theme")!.getBoundingClientRect();
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
  const triggerProps: ComponentProps<"button"> = {
    ref: trigger,
    id: `${id}-button`,
    type: "button",
    disabled: props.actions.every((action) => action.disabled),
    "aria-label": props.label ?? "更多操作",
    "aria-expanded": open,
    "aria-haspopup": "menu",
    "aria-controls": id,
    onClick: openMenu,
  };
  return (
    <>
      {props.renderTrigger ? (
        props.renderTrigger(triggerProps)
      ) : (
        <button {...triggerProps} className="ui-button" aria-label={props.label ?? "更多操作"}>
          •••
        </button>
      )}
      <div
        id={id}
        ref={menu}
        popover="auto"
        role="menu"
        aria-labelledby={`${id}-button`}
        className="ui-action-menu"
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
            key={action.id}
            type="button"
            role="menuitem"
            data-action={action.dataAction}
            disabled={action.disabled}
            className={action.danger ? "ui-menu-danger" : undefined}
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
