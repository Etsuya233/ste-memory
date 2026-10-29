import type { ChatMirrorStatus } from "../../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import type { PluginSettings } from "../../../features/settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../../../features/chat-binding/chat-space-manager.ts";

/**
 * 面板头部空间信息（纯函数）：当前空间名称 + 文件镜像状态细节。
 */

export interface SpaceInfoViewModel {
  /** 主标题（空间名 / 状态短语） */
  readonly title: string;
  /** 副标题（镜像状态等细节；无细节为空串） */
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
    case "active": {
      // 从文件镜像恢复的标记（ticket 16）
      const restored = status.restored ? "已从文件镜像恢复" : "";
      return {
        title: status.space.name,
        detail: restored,
        tone: "normal",
      };
    }
    case "branch-detected":
      return {
        title: status.space.name,
        detail: `检测到分支对话（原归属: ${status.originalChatIdentity}）`,
        tone: "warning",
      };
    case "unsaved-chat":
    case "space-missing":
    case "binding-unrecognized":
    case "load-error":
      return { title: status.humanMsg, detail: "", tone: "warning" };
  }
}

/** 设置面板「对话文件镜像」组状态行文案（ticket 16：体积 + 上次写回时间） */
export function mirrorStatusSummary(status: ChatMirrorStatus): string {
  switch (status.kind) {
    case "disabled":
      return "已停用（开启后随对话文件同步记忆镜像）";
    case "saving":
      return "正在保存到对话文件";
    case "failed":
      return `对话文件保存失败：${status.error}`;
    case "idle": {
      if (status.lastWrittenAt === undefined) return "已启用（尚未写回）";
      const size =
        status.sizeBytes !== undefined ? ` · ${(status.sizeBytes / 1024).toFixed(1)} KB` : "";
      return `上次写回 ${formatDisplayTime(status.lastWrittenAt)}${size}`;
    }
  }
}

/** ISO 时间 → 展示文本（UTC，确定性切片；「YYYY-MM-DD HH:mm」） */
export function formatDisplayTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** 设置面板「运行状态」行文案（基于当前空间上下文） */
export function runtimeStatusLabel(status: SpaceContextStatus | undefined): string {
  if (!status) return "启动中…";
  switch (status.kind) {
    case "active":
      return "已加载 · 空间同步正常";
    case "branch-detected":
      return "已加载 · 检测到分支对话";
    case "unsaved-chat":
      return "已加载 · 当前对话未保存";
    case "space-missing":
      return "已加载 · 空间数据未就绪";
    case "binding-unrecognized":
      return "已加载 · 空间绑定无法识别";
    case "load-error":
      return "记忆空间加载失败";
  }
}
