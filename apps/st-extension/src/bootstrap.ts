import { getStContext } from "./st-globals.ts";
import { PLUGIN_DISPLAY_NAME } from "./constants.ts";
import { startSteMemory } from "./runtime.ts";
import { mountPanel } from "./ui/index.ts";

export { PLUGIN_DISPLAY_NAME } from "./constants.ts";

export interface PluginLog {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface BootstrapOptions {
  /** ST 上下文获取器；缺省走全局 SillyTavern.getContext()，测试可注入 */
  getContext?: () => unknown;
  /** 插件版本（构建时注入，与 manifest/package.json 同源） */
  version: string;
  /** 日志输出；缺省 console，测试可注入 */
  log?: PluginLog;
  /** 运行时启动器；缺省 = 真实 runtime（bootstrap 测试注入 fake）；
   *   getContext 为可重复调用的工厂（切对话后需重取 ST 上下文） */
  start?: (getContext: () => unknown, log: PluginLog) => Promise<unknown>;
}

export type BootstrapStatus = "loaded" | "unavailable";

/**
 * 插件初始化入口：确认 ST 环境可用、启动运行时（空间绑定 + 事件桥，见 runtime.ts）
 * 并输出初始化日志。
 */
export function bootstrap(options: BootstrapOptions): BootstrapStatus {
  const log = options.log ?? console;
  const getContext = options.getContext ?? getStContext;
  if (!getContext()) {
    log.warn(
      `[${PLUGIN_DISPLAY_NAME}] SillyTavern 环境不可用（缺少 SillyTavern.getContext），插件未初始化`,
    );
    return "unavailable";
  }
  const start =
    options.start ??
    ((getCtx) =>
      startSteMemory(getCtx, { log, version: options.version }).then((runtime) => {
        // 面板挂载（非浏览器环境内部自守卫）；runtime 已含设置存储/服务/版本
        mountPanel(runtime);
        return runtime;
      }));
  void start(getContext, log).catch((error) => {
    log.error(`[${PLUGIN_DISPLAY_NAME}] 运行时启动失败`, error);
  });
  log.info(`[${PLUGIN_DISPLAY_NAME}] v${options.version} 已加载（SillyTavern UI Extension）`);
  return "loaded";
}
