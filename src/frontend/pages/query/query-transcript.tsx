import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MessageScroller, useMessageScroller } from "@shadcn/react/message-scroller";
import { ArrowDown } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";

interface ReadingPosition {
  messageId: string;
  offset: number;
  atEnd: boolean;
}

// Conversation reading positions live as long as their workbench store.
const readingPositions = new WeakMap<object, Map<string, ReadingPosition>>();

export function QueryTranscript({
  owner,
  sessionId,
  children,
}: {
  owner: object;
  sessionId: string;
  children: ReactNode;
}) {
  let positions = readingPositions.get(owner);
  if (!positions) {
    positions = new Map();
    readingPositions.set(owner, positions);
  }
  const [position] = useState(() => positions.get(sessionId));
  return (
    <MessageScroller.Provider
      autoScroll
      defaultScrollPosition={position && !position.atEnd ? "start" : "end"}
    >
      <TranscriptViewport positions={positions} sessionId={sessionId} position={position}>
        {children}
      </TranscriptViewport>
    </MessageScroller.Provider>
  );
}

function TranscriptViewport({
  positions,
  sessionId,
  position,
  children,
}: {
  positions: Map<string, ReadingPosition>;
  sessionId: string;
  position: ReadingPosition | undefined;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { scrollToMessage } = useMessageScroller();
  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const content = contentRef.current!;
    if (position && !position.atEnd)
      scrollToMessage(position.messageId, { scrollMargin: position.offset });
    return () => {
      const top = viewport.getBoundingClientRect().top;
      const padding = Number.parseFloat(getComputedStyle(content).paddingBlockStart);
      const visible = Array.from(content.children).find(
        (child) =>
          child.hasAttribute("data-query-turn") && child.getBoundingClientRect().bottom > top,
      );
      if (!visible) {
        positions.delete(sessionId);
        return;
      }
      positions.set(sessionId, {
        messageId: visible.getAttribute("data-message-id")!,
        offset: visible.getBoundingClientRect().top - top - padding,
        atEnd: !viewport.dataset.scrollable?.split(" ").includes("end"),
      });
    };
  }, [positions, sessionId, position, scrollToMessage]);
  return (
    <MessageScroller.Root className="ste:relative ste:flex ste:min-h-0 ste:flex-1 ste:flex-col ste:overflow-hidden">
      <MessageScroller.Viewport
        ref={viewportRef}
        aria-label="记忆助手消息"
        data-action="assistant-transcript"
        className="ste:min-h-0 ste:flex-1 ste:overflow-y-auto ste:overscroll-contain ste:data-pending-scroll:invisible"
      >
        <MessageScroller.Content
          ref={contentRef}
          aria-label="消息记录"
          className="ste:mx-auto ste:flex ste:min-h-full ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-6 ste:p-4"
        >
          {children}
        </MessageScroller.Content>
      </MessageScroller.Viewport>
      <MessageScroller.Button
        render={<Button variant="outline" size="sm" />}
        data-action="assistant-latest"
        className="ste:absolute ste:bottom-3 ste:left-1/2 ste:z-10 ste:-translate-x-1/2 ste:shadow-md ste:data-[active=false]:hidden"
      >
        <ArrowDown data-icon="inline-start" />
        最新消息
      </MessageScroller.Button>
    </MessageScroller.Root>
  );
}
