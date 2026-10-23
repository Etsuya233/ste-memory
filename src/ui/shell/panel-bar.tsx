import type { PointerEventHandler, ReactNode } from "react";

export type PanelBarVariant = "root" | "detail";

/**
 * 面板顶栏：一级页与二级详情共用同一套槽位。
 * root 在文档流内；detail 由页面自己放在覆盖容器里，内容可从栏下经过。
 */
export function PanelBar(props: {
  readonly variant?: PanelBarVariant;
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly dataAction?: string;
  readonly onPointerDown?: PointerEventHandler<HTMLElement>;
}) {
  const variant = props.variant ?? "root";
  return (
    <header
      className={`stm-panel-header stm-panel-header--${variant}`}
      data-action={props.dataAction}
      onPointerDown={props.onPointerDown}
    >
      <div className="stm-header-leading">{props.leading}</div>
      <div className="stm-header-title-wrap">
        <div className="stm-header-title">{props.title}</div>
        {props.subtitle ? <div className="stm-header-subtitle">{props.subtitle}</div> : null}
      </div>
      <div className="stm-header-trailing">{props.trailing}</div>
    </header>
  );
}
