import type { PluginSettings } from "../settings/plugin-settings.ts";
import { isR2Configured } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";

/**
 * 面板头部空间信息（纯函数）：当前空间名称 + 同步状态占位。
 * 同步状态在 ticket 06 是占位（未配置/已配置 R2 的文案），ticket 08 接入
 * 真实同步状态（最近同步时间、失败提示）时只改这里与宿主渲染。
 */

export const SYNC_NOT_CONFIGURED_LABEL = "云同步未配置";
export const SYNC_CONFIGURED_LABEL = "云同步已配置（推送将在后续版本开放）";

export interface SpaceInfoViewModel {
  /** 主标题（空间名 / 状态短语） */
  readonly title: string;
  /** 副标题（同步状态等细节；无细节为空串） */
  readonly detail: string;
  /** 状态基调（宿主映射样式，不直接依赖 ST 主题） */
  readonly tone: "normal" | "warning" | "muted";
}

export function buildSpaceInfo(
  status: SpaceContextStatus | undefined,
  settings: PluginSettings,
): SpaceInfoViewModel {
  // 插件总开关优先：停用时面板头部直接给出停用提示（表格/同步均不工作）
  if (!settings.enabled) {
    return { title: "插件已停用", detail: "在设置中重新启用后恢复空间同步", tone: "muted" };
  }
  if (!status) {
    return { title: "正在加载…", detail: "", tone: "muted" };
  }
  switch (status.kind) {
    case "active":
      return {
        title: status.space.name,
        detail: syncStatusLabel(settings),
        tone: "normal",
      };
    case "unsaved-chat":
    case "space-missing":
    case "binding-unrecognized":
      return { title: status.humanMsg, detail: "", tone: "warning" };
  }
}

/** 同步状态占位文案：R2 四项配置齐了才显示「已配置」（ticket 08 替换为真实状态） */
export function syncStatusLabel(settings: PluginSettings): string {
  return isR2Configured(settings) ? SYNC_CONFIGURED_LABEL : SYNC_NOT_CONFIGURED_LABEL;
}

/** 设置面板「运行状态」行文案（基于当前空间上下文） */
export function runtimeStatusLabel(status: SpaceContextStatus | undefined): string {
  if (!status) return "启动中…";
  switch (status.kind) {
    case "active":
      return "已加载 · 空间同步正常";
    case "unsaved-chat":
      return "已加载 · 当前对话未保存";
    case "space-missing":
      return "已加载 · 空间数据未就绪";
    case "binding-unrecognized":
      return "已加载 · 空间绑定无法识别";
  }
}
