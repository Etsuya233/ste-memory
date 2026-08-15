/**
 * 面板 UI 共享工具（ticket 11 抽取）：toastr 降级封装 / 占位组件 / 活动空间守卫。
 * 供 panel-shell 与 record-view 共用，避免组件模块循环依赖。
 */
import type { ReactNode } from "react";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { PLUGIN_DISPLAY_NAME } from "../constants.ts";

/** ST 全局 toastr（jquery-toast-plugin，ST 自带）；缺失时降级 console。 */
declare global {
  var toastr:
    | {
        error(message: string, title?: string): void;
        warning(message: string, title?: string): void;
        success(message: string, title?: string): void;
      }
    | undefined;
}

export function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof toastr !== "undefined") {
    toastr.error(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.error(`[${PLUGIN_DISPLAY_NAME}]`, error);
  }
}

export function reportWarning(message: string): void {
  if (typeof toastr !== "undefined") {
    toastr.warning(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.warn(`[${PLUGIN_DISPLAY_NAME}]`, message);
  }
}

export function reportSuccess(message: string): void {
  if (typeof toastr !== "undefined") {
    toastr.success(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.info(`[${PLUGIN_DISPLAY_NAME}]`, message);
  }
}

/** 空状态占位（「空状态是邀请」文案风格，spec §11） */
export function Placeholder(props: { readonly title: string; readonly hint: string }): ReactNode {
  return (
    <div className="stm-empty">
      <div className="stm-empty-title">{props.title}</div>
      <div className="stm-empty-hint">{props.hint}</div>
    </div>
  );
}

/** UI 层 id 工厂（设置写入时分配实体 id；浏览器环境，缺省随机） */
export function createUiId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export type ActiveStatus = Extract<SpaceContextStatus, { kind: "active" }>;

/** 活动空间守卫：非 active 状态返回 undefined（表格/记录区块只在活动空间渲染） */
export function activeStatus(status: SpaceContextStatus | undefined): ActiveStatus | undefined {
  return status?.kind === "active" ? status : undefined;
}
