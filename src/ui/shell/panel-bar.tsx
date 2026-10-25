import type { ComponentProps, PointerEventHandler, ReactNode } from "react";
import { IconButton, ActionGroup } from "../kit/actions.tsx";

/** Host icon adapter over the portable icon button. */
export function PanelBarAction({
  icon,
  ...props
}: Omit<ComponentProps<typeof IconButton>, "children"> & { readonly icon: string }) {
  return (
    <IconButton {...props}>
      <i className={`fa-solid ${icon}`} />
    </IconButton>
  );
}

export type PanelBarFrame = "auto" | "none" | "always";

export type PanelBarVariant = "root" | "detail" | "record";

/**
 * 面板顶栏：一级页与二级详情共用同一套槽位。
 * PageLayout 负责滚动与内容避让；尺寸与背景材质由顶栏令牌控制。
 */
export function PanelBar(props: {
  readonly variant?: PanelBarVariant;
  readonly leading?: ReactNode;
  readonly leadingFrame?: PanelBarFrame;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly trailingFrame?: PanelBarFrame;
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
        {props.leading ? (
          <ActionGroup frame={props.leadingFrame ?? "auto"}>{props.leading}</ActionGroup>
        ) : null}
      </div>
      <div className="stm-header-title-wrap">
        <div className="stm-header-title">{props.title}</div>
        {props.subtitle ? <div className="stm-header-subtitle">{props.subtitle}</div> : null}
      </div>
      <div className="stm-header-trailing">
        {props.trailing ? (
          <ActionGroup frame={props.trailingFrame ?? "auto"}>{props.trailing}</ActionGroup>
        ) : null}
      </div>
      {props.extension ? <div className="stm-header-extension">{props.extension}</div> : null}
    </header>
  );
}

/** 底部操作栏：主操作组与独立快捷操作共用顶栏材质。 */
export function PanelBottomBar(props: {
  readonly label: string;
  readonly mainFrame?: PanelBarFrame;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly trailingFrame?: PanelBarFrame;
}) {
  return (
    <footer className="stm-bottom-bar" aria-label={props.label}>
      <ActionGroup className="stm-bottom-bar-main" frame={props.mainFrame ?? "auto"}>
        {props.children}
      </ActionGroup>
      {props.trailing ? (
        <ActionGroup frame={props.trailingFrame ?? "auto"}>{props.trailing}</ActionGroup>
      ) : null}
    </footer>
  );
}
