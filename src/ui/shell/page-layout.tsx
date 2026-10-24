import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface PageSlots {
  readonly header: HTMLDivElement | null;
  readonly footer: HTMLDivElement | null;
  readonly headerActions: HTMLSpanElement | null;
  readonly setHeaderActions: (element: HTMLSpanElement | null) => void;
  readonly replaceHeader: (active: boolean) => void;
}

const PageSlotContext = createContext<PageSlots | null>(null);

/** 页面提供栏和正文；容器统一负责实际栏高、滚动与玻璃覆盖范围。 */
export function PageLayout(props: {
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly mode?: "scroll" | "contained";
  readonly contentClassName?: string;
  readonly contentAs?: "main" | "div";
  readonly inert?: boolean;
}) {
  const Content = props.contentAs ?? "div";
  const layoutRef = useRef<HTMLDivElement>(null);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [headerActions, setHeaderActions] = useState<HTMLSpanElement | null>(null);
  const [headerOwners, setHeaderOwners] = useState(0);
  const replaceHeader = useCallback((active: boolean) => {
    setHeaderOwners((count) => count + (active ? 1 : -1));
  }, []);

  useLayoutEffect(() => {
    const layout = layoutRef.current!;
    const measure = () => {
      layout.style.setProperty(
        "--stm-page-header-height",
        `${header!.getBoundingClientRect().height}px`,
      );
      layout.style.setProperty(
        "--stm-page-footer-height",
        `${footer!.getBoundingClientRect().height}px`,
      );
    };
    if (!header || !footer) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(footer);
    return () => observer.disconnect();
  }, [header, footer]);

  return (
    <PageSlotContext value={{ header, footer, headerActions, setHeaderActions, replaceHeader }}>
      <div
        className="stm-page-layout"
        data-scroll-mode={props.mode ?? "scroll"}
        ref={layoutRef}
        inert={props.inert}
      >
        <div className="stm-page-header" ref={setHeader}>
          <div hidden={headerOwners > 0}>{props.header}</div>
        </div>
        <Content className={`stm-page-content ${props.contentClassName ?? ""}`}>
          {props.children}
        </Content>
        <div className="stm-page-footer" ref={setFooter}>
          {props.footer}
        </div>
      </div>
    </PageSlotContext>
  );
}

/** 子页面将页面栏挂到所属容器，正文始终保留在同一个滚动区域中。 */
export function PageChrome(props: {
  /** A new screen must not reuse the previous screen's submit-button DOM. */
  readonly pageKey?: string;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly headerTrailing?: ReactNode;
}) {
  const slots = useContext(PageSlotContext)!;
  const replacesHeader = props.header !== undefined;
  const replaceHeader = slots.replaceHeader;
  useLayoutEffect(() => {
    if (replacesHeader) replaceHeader(true);
    return () => {
      if (replacesHeader) replaceHeader(false);
    };
  }, [replaceHeader, replacesHeader]);
  return (
    <>
      {slots.header && props.header
        ? createPortal(props.header, slots.header, props.pageKey)
        : null}
      {slots.footer && props.footer ? createPortal(props.footer, slots.footer) : null}
      {slots.headerActions && props.headerTrailing
        ? createPortal(props.headerTrailing, slots.headerActions)
        : null}
    </>
  );
}

/** 默认顶栏操作组内的页面扩展位置，保留 Shell 的导航与关闭操作。 */
export function PageHeaderActions() {
  const slots = useContext(PageSlotContext)!;
  return <span className="stm-header-actions-slot" ref={slots.setHeaderActions} />;
}
