/**
 * ST 1.18 的官方外部接线 API：`globalThis.SillyTavern = { libs, getContext }`
 * （public/script.js 已核实）。第三方扩展通过该全局对象访问 ST，而不是
 * import 相对路径 —— 保证 bundle 完全自包含。
 */

export interface SillyTavernGlobal {
  libs: Record<string, unknown>;
  getContext: () => unknown;
}

declare global {
  var SillyTavern: SillyTavernGlobal | undefined;
}

export function getSillyTavernGlobal(): SillyTavernGlobal | undefined {
  return typeof SillyTavern !== "undefined" ? SillyTavern : undefined;
}

/** 获取 ST 上下文对象；插件未运行在 ST 环境时返回 undefined */
export function getStContext(): unknown {
  return getSillyTavernGlobal()?.getContext();
}
