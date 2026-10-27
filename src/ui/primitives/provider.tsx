import { createContext, useContext, useEffect, type ReactNode, type RefObject } from "react";
const ContainerContext = createContext<HTMLElement | null>(null);
const ActiveContext = createContext(true);
/** Keeps overlays inside the caller-owned themed/top-layer surface. */
export function PrimitivesProvider({
  container,
  active = true,
  children,
}: {
  container: HTMLElement | null;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <ContainerContext.Provider value={container}>
      <ActiveContext.Provider value={active}>{children}</ActiveContext.Provider>
    </ContainerContext.Provider>
  );
}
export function usePrimitivesContainer() {
  return useContext(ContainerContext);
}
export function usePrimitivesActive() {
  return useContext(ActiveContext);
}
/** Close through Base UI so controlled consumers receive the real imperative-action event. */
export function useDismissWithSurface(actions: RefObject<{ close: () => void } | null>) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  useEffect(() => {
    if (!container || !active) actions.current?.close();
    if (!container) return;
    const onToggle = (event: Event) => {
      if ((event as Event & { newState?: string }).newState === "closed") actions.current?.close();
    };
    container.addEventListener("beforetoggle", onToggle);
    return () => container.removeEventListener("beforetoggle", onToggle);
  }, [container, active, actions]);
}
/** Never restore focus to a trigger in a hidden native top-layer surface. */
export function canRestoreSurfaceFocus(container: HTMLElement | null): boolean {
  if (
    !container ||
    !container.isConnected ||
    container.hidden ||
    container.getAttribute("aria-hidden") === "true"
  )
    return false;
  return !container.hasAttribute("popover") || container.matches(":popover-open");
}
