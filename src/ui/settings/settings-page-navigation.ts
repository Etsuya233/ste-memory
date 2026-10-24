import { useLayoutEffect, useRef } from "react";

/** Keep each settings screen in the shared page scroller without losing its return position. */
export function useSettingsPageNavigation(page: string) {
  const screenRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const scroller = screenRef.current?.closest<HTMLElement>(".stm-page-content");
    if (!scroller) return;
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop = positions.current.get(page) ?? 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [page]);
  function rememberScroll() {
    // Fresh forms always open at the top; only navigation screens restore a return position.
    if (page.startsWith("edit:") || page.startsWith("new:")) return;
    positions.current.set(
      page,
      screenRef.current!.closest<HTMLElement>(".stm-page-content")!.scrollTop,
    );
  }
  return { screenRef, rememberScroll };
}
