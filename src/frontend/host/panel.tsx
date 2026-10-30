import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PrimitivesProvider } from "../primitives/provider.tsx";
import { usePanelWindow } from "./use-panel-window.ts";

/** Native top layer keeps ST transforms from changing viewport positioning. */
export function FrontendPanel({
  open,
  tone,
  children,
}: {
  open: boolean;
  tone: "light" | "dark";
  children: ReactNode;
}) {
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const launcher = useRef<HTMLElement | null>(null);
  usePanelWindow(surface, open);
  useLayoutEffect(() => {
    if (
      open &&
      document.activeElement instanceof HTMLElement &&
      !surface?.contains(document.activeElement)
    )
      launcher.current = document.activeElement;
    surface?.togglePopover(open);
    if (open) surface?.focus();
    else if (launcher.current?.isConnected) launcher.current.focus();
    return () => surface?.hidePopover();
  }, [surface, open]);
  return (
    <PrimitivesProvider container={surface} active={open}>
      <aside
        ref={setSurface}
        id="ste-memory-app"
        popover="manual"
        tabIndex={-1}
        aria-label="记忆工作台"
        aria-hidden={!open}
        data-tone={tone}
        className="stm-luma ste:fixed ste:inset-0 ste:box-border ste:h-dvh ste:max-h-none ste:w-full ste:max-w-none ste:overflow-hidden ste:bg-background ste:text-foreground ste:outline-none ste:md:top-[var(--stm-window-y)] ste:md:right-auto ste:md:bottom-auto ste:md:left-[var(--stm-window-x)] ste:md:h-[var(--stm-window-height)] ste:md:w-[var(--stm-window-width)] ste:md:rounded-3xl ste:md:border ste:md:border-border ste:md:shadow-2xl"
      >
        {children}
        {(["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const).map((edge) => (
          <div key={edge} data-window-resize={edge} aria-hidden="true" />
        ))}
      </aside>
    </PrimitivesProvider>
  );
}
