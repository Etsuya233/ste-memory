import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PrimitivesProvider } from "../../ui/primitives/provider.tsx";

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
        className="stm-luma ste:fixed ste:inset-0 ste:h-dvh ste:max-h-none ste:w-full ste:max-w-none ste:overflow-hidden ste:bg-background ste:text-foreground ste:outline-none ste:sm:inset-y-6 ste:sm:inset-x-auto ste:sm:left-1/2 ste:sm:h-[calc(100dvh-3rem)] ste:sm:w-[min(760px,calc(100vw-3rem))] ste:sm:-translate-x-1/2 ste:sm:rounded-3xl ste:sm:border ste:sm:border-border ste:sm:shadow-2xl"
      >
        {children}
      </aside>
    </PrimitivesProvider>
  );
}
