import { createPortal } from "react-dom";
import type { KeyboardEvent } from "react";
import type { EntryPlacement } from "../../features/settings/plugin-settings.ts";

/** ST surfaces use the host's icons, theme and interaction styles. */
export function StEntry({
  placement,
  open,
  onOpen,
}: {
  placement: EntryPlacement;
  open: boolean;
  onOpen: () => void;
}) {
  const toolbar = document.getElementById("top-settings-holder");
  const wand = document.getElementById("extensionsMenu");
  if (!toolbar || !wand) throw new Error("ST 入口容器尚未就绪，无法挂载记忆工作台");

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.click();
    }
  }

  return (
    <>
      {placement !== "wand"
        ? createPortal(
            <div className="drawer" id="ste-memory-top-entry">
              <div
                className={`drawer-icon fa-solid fa-book-open fa-fw ${open ? "openIcon" : "closedIcon"}`}
                role="button"
                tabIndex={0}
                title="记忆工作台"
                aria-label="打开记忆工作台"
                aria-controls="ste-memory-app"
                aria-expanded={open}
                data-action="open-frontend"
                onClick={onOpen}
                onKeyDown={onKeyDown}
              />
            </div>,
            toolbar,
          )
        : null}
      {placement !== "top"
        ? createPortal(
            <div
              id="ste-memory-wand-entry"
              className="list-group-item flex-container flexGap5"
              role="button"
              tabIndex={0}
              title="记忆工作台"
              aria-label="打开记忆工作台"
              aria-controls="ste-memory-app"
              aria-expanded={open}
              data-action="open-frontend"
              onClick={() => {
                const button = document.getElementById("extensionsMenuButton");
                if (!button) throw new Error("ST 魔法棒按钮尚未就绪");
                button.focus();
                onOpen();
              }}
              onKeyDown={onKeyDown}
            >
              <div
                className="fa-solid fa-book-open fa-fw extensionsMenuExtensionButton"
                aria-hidden="true"
              />
              <span>记忆工作台</span>
            </div>,
            wand,
          )
        : null}
    </>
  );
}
