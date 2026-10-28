import { useLayoutEffect, useRef } from "react";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const margin = 12;
const interactive =
  'button, input, textarea, select, a, [role="button"], [role="combobox"], [contenteditable="true"]';

/** Geometry stays outside React so dragging does not rerender the active page. */
export function usePanelWindow(surface: HTMLElement | null, open: boolean) {
  const bounds = useRef<WindowBounds | null>(null);
  useLayoutEffect(() => {
    if (!surface || !open) return;
    const panel = surface;
    const desktop = matchMedia("(min-width: 768px)");
    let gesture: {
      pointerId: number;
      x: number;
      y: number;
      start: WindowBounds;
      edge: string;
      capture: Element;
    } | null = null;

    function fit(value: WindowBounds): WindowBounds {
      const width = Math.min(Math.max(560, value.width), innerWidth - margin * 2);
      const height = Math.min(Math.max(400, value.height), innerHeight - margin * 2);
      return {
        width,
        height,
        x: Math.max(margin, Math.min(value.x, innerWidth - width - margin)),
        y: Math.max(margin, Math.min(value.y, innerHeight - height - margin)),
      };
    }
    function paint(value: WindowBounds) {
      bounds.current = value;
      for (const [key, number] of Object.entries(value))
        panel.style.setProperty(`--stm-window-${key}`, `${number}px`);
    }
    function reset() {
      const width = Math.min(960, innerWidth - 48);
      const height = innerHeight - 48;
      paint(fit({ x: (innerWidth - width) / 2, y: 24, width, height }));
    }
    function end() {
      const previous = gesture;
      gesture = null;
      if (previous?.capture.hasPointerCapture(previous.pointerId))
        previous.capture.releasePointerCapture(previous.pointerId);
      panel.removeAttribute("data-window-gesture");
    }
    function viewportChanged() {
      end();
      if (!desktop.matches) return;
      if (bounds.current) paint(fit(bounds.current));
      else reset();
    }
    function dragHeader(target: Element) {
      return target.closest("[data-window-drag]") && !target.closest(interactive);
    }
    function down(event: PointerEvent) {
      if (!desktop.matches || !event.isPrimary || event.button !== 0) return;
      const target = event.target as Element;
      const edge = target.closest<HTMLElement>("[data-window-resize]")?.dataset.windowResize;
      if (!edge && !dragHeader(target)) return;
      const start = bounds.current!;
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start,
        edge: edge ?? "",
        capture: target,
      };
      target.setPointerCapture(event.pointerId);
      panel.setAttribute("data-window-gesture", "");
      event.preventDefault();
    }
    function move(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const { start, edge } = gesture;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!edge) {
        paint(fit({ ...start, x: start.x + dx, y: start.y + dy }));
        return;
      }
      let { x, y, width, height } = start;
      if (edge.includes("e"))
        width = Math.max(560, Math.min(start.width + dx, innerWidth - margin - x));
      if (edge.includes("s"))
        height = Math.max(
          Math.min(400, innerHeight - margin * 2),
          Math.min(start.height + dy, innerHeight - margin - y),
        );
      if (edge.includes("w")) {
        x = Math.max(margin, Math.min(start.x + dx, start.x + start.width - 560));
        width = start.width + start.x - x;
      }
      if (edge.includes("n")) {
        y = Math.max(
          margin,
          Math.min(start.y + dy, start.y + start.height - Math.min(400, innerHeight - margin * 2)),
        );
        height = start.height + start.y - y;
      }
      paint({ x, y, width, height });
    }
    function doubleClick(event: MouseEvent) {
      if (desktop.matches && dragHeader(event.target as Element)) reset();
    }
    function keyboard(event: KeyboardEvent) {
      if (!desktop.matches || !(event.target as Element).matches("[data-window-drag]")) return;
      const horizontal = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
      const vertical = event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0;
      if (!horizontal && !vertical) {
        if (event.key === "Home") {
          event.preventDefault();
          reset();
        }
        return;
      }
      event.preventDefault();
      const current = bounds.current!;
      paint(
        fit(
          event.shiftKey
            ? { ...current, width: current.width + horizontal, height: current.height + vertical }
            : { ...current, x: current.x + horizontal, y: current.y + vertical },
        ),
      );
    }

    viewportChanged();
    window.addEventListener("resize", viewportChanged);
    surface.addEventListener("pointerdown", down);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
    surface.addEventListener("lostpointercapture", end);
    surface.addEventListener("dblclick", doubleClick);
    surface.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("resize", viewportChanged);
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", end);
      surface.removeEventListener("pointercancel", end);
      surface.removeEventListener("lostpointercapture", end);
      surface.removeEventListener("dblclick", doubleClick);
      surface.removeEventListener("keydown", keyboard);
      end();
    };
  }, [surface, open]);
}
