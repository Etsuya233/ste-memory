import { useLayoutEffect, useRef, type UIEvent } from "react";

// Page components may unmount when the bottom navigation changes. Keep positions
// with their workspace so they live exactly as long as the current workbench.
const positions = new WeakMap<object, Map<string, number>>();

export function usePageScroll(owner: object, viewKey: string, ready: boolean, remember = true) {
  let saved = positions.get(owner);
  if (!saved) {
    saved = new Map();
    positions.set(owner, saved);
  }
  const cache = saved;
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    restored.current = false;
    if (!ready) return;
    ref.current!.scrollTop = remember ? (cache.get(viewKey) ?? 0) : 0;
    restored.current = true;
  }, [viewKey, ready, remember, cache]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    if (ready && restored.current && remember) cache.set(viewKey, event.currentTarget.scrollTop);
  }
  return { ref, onScroll, forget: (key: string) => cache.delete(key) };
}
