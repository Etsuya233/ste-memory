import { getStContext } from "./st-globals.ts";

export const PLUGIN_DISPLAY_NAME = "STE Memory";

export interface PluginLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface BootstrapOptions {
  /** ST 上下文获取器；缺省走全局 SillyTavern.getContext()，测试可注入 */
  getContext?: () => unknown;
  /** 插件版本（构建时注入，与 manifest/package.json 同源） */
  version: string;
  /** 日志输出；缺省 console，测试可注入 */
  log?: PluginLog;
}

export type BootstrapStatus = "loaded" | "unavailable";

/**
 * 插件初始化入口：确认 ST 环境可用并输出初始化日志。
 * 后续 ticket 的初始化（事件订阅、Dexie、面板）都挂在这里。
 */
export function bootstrap(options: BootstrapOptions): BootstrapStatus {
  const log = options.log ?? console;
  const context = options.getContext ? options.getContext() : getStContext();
  if (!context) {
    log.warn(
      `[${PLUGIN_DISPLAY_NAME}] SillyTavern 环境不可用（缺少 SillyTavern.getContext），插件未初始化`,
    );
    return "unavailable";
  }
  log.info(`[${PLUGIN_DISPLAY_NAME}] v${options.version} 已加载（SillyTavern UI Extension）`);
  return "loaded";
}
