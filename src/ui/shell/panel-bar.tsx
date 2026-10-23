import { useState, type ComponentProps, type PointerEventHandler, type ReactNode } from "react";

/** 标准图标操作；原生按钮属性保留表单、键盘、ref 和页面事件能力。 */
export function PanelBarAction({
  icon,
  label,
  emphasis = false,
  danger = false,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onLostPointerCapture,
  ...props
}: Omit<ComponentProps<"button">, "children" | "className" | "aria-label"> & {
  readonly icon: string;
  readonly label: string;
  readonly emphasis?: boolean;
  readonly danger?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      {...props}
      data-pressed={pressed}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (props.disabled || event.defaultPrevented || event.button !== 0) return;
        setPressed(true);
      }}
      onPointerUp={(event) => {
        setPressed(false);
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        setPressed(false);
        onPointerCancel?.(event);
      }}
      onPointerLeave={(event) => {
        setPressed(false);
        onPointerLeave?.(event);
      }}
      onLostPointerCapture={(event) => {
        setPressed(false);
        onLostPointerCapture?.(event);
      }}
      className={`stm-bar-action${emphasis ? " stm-bar-action--primary" : ""}${danger ? " stm-bar-action--danger" : ""}`}
      aria-label={label}
      title={label}
    >
      <i className={`fa-solid ${icon}`} aria-hidden="true" />
    </button>
  );
}

export type PanelBarVariant = "root" | "detail" | "record";

/**
 * 面板顶栏：一级页与二级详情共用同一套槽位。
 * PageLayout 负责滚动与内容避让；尺寸与背景材质由顶栏令牌控制。
 */
export function PanelBar(props: {
  readonly variant?: PanelBarVariant;
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly extension?: ReactNode;
  readonly dataAction?: string;
  readonly inert?: boolean;
  readonly onPointerDown?: PointerEventHandler<HTMLElement>;
}) {
  const variant = props.variant ?? "root";
  return (
    <header
      className={`stm-panel-header stm-panel-header--${variant}`}
      inert={props.inert}
      data-action={props.dataAction}
      onPointerDown={props.onPointerDown}
    >
      <div className="stm-header-leading">
        {props.leading ? <div className="stm-bar-group">{props.leading}</div> : null}
      </div>
      <div className="stm-header-title-wrap">
        <div className="stm-header-title">{props.title}</div>
        {props.subtitle ? <div className="stm-header-subtitle">{props.subtitle}</div> : null}
      </div>
      <div className="stm-header-trailing">
        {props.trailing ? <div className="stm-bar-group">{props.trailing}</div> : null}
      </div>
      {props.extension ? <div className="stm-header-extension">{props.extension}</div> : null}
    </header>
  );
}

/** 底部操作栏：主操作组与独立快捷操作共用顶栏材质。 */
export function PanelBottomBar(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <footer className="stm-bottom-bar" aria-label={props.label}>
      <div className="stm-bar-group stm-bottom-bar-main">{props.children}</div>
      {props.trailing ? <div className="stm-bar-group">{props.trailing}</div> : null}
    </footer>
  );
}
