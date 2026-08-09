import type { CloudSyncStatus } from "../cloud/sync-coordinator.ts";
import type { ChatMirrorStatus } from "../chat-mirror/chat-metadata-mirror-sync.ts";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";

/**
 * 面板头部空间信息（纯函数）：当前空间名称 + 真实云同步状态（ticket 08：
 * 最近同步时间、失败提示；ticket 06 的占位文案在此被替换）。
 */

export const SYNC_NOT_CONFIGURED_LABEL = "云同步未配置";
export const SYNC_SYNCING_LABEL = "云同步中…";
export const SYNC_PENDING_LABEL = "云同步已开启（尚未同步）";
export const SYNC_ERROR_PREFIX = "云同步失败：";

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
  syncStatus: CloudSyncStatus,
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
      // 从文件镜像恢复的标记（ticket 16）与云同步状态并列展示
      const restored = status.restored ? "已从文件镜像恢复" : "";
      const detail = [restored, syncStatusDetail(syncStatus)].filter(Boolean).join(" · ");
      return {
        title: status.space.name,
        detail,
        tone: syncStatus.kind === "error" ? "warning" : "normal",
      };
    }
    case "unsaved-chat":
    case "space-missing":
    case "binding-unrecognized":
      return { title: status.humanMsg, detail: "", tone: "warning" };
  }
}

/** 云同步状态 → 面板副标题文案（未配置/同步中/失败提示/最近同步时间） */
export function syncStatusDetail(sync: CloudSyncStatus): string {
  switch (sync.kind) {
    case "unconfigured":
      return SYNC_NOT_CONFIGURED_LABEL;
    case "syncing":
      return SYNC_SYNCING_LABEL;
    case "error":
      return `${SYNC_ERROR_PREFIX}${sync.message}`;
    case "idle":
      return sync.lastSyncAt ? `最近同步 ${formatSyncTime(sync.lastSyncAt)}` : SYNC_PENDING_LABEL;
  }
}

/** 设置面板「对话文件镜像」组状态行文案（ticket 16：体积 + 上次写回时间） */
export function mirrorStatusSummary(status: ChatMirrorStatus): string {
  switch (status.kind) {
    case "disabled":
      return "已停用（开启后随对话文件同步记忆镜像）";
    case "idle": {
      if (status.lastWrittenAt === undefined) return "已启用（尚未写回）";
      const size =
        status.sizeBytes !== undefined ? ` · ${(status.sizeBytes / 1024).toFixed(1)} KB` : "";
      return `上次写回 ${formatSyncTime(status.lastWrittenAt)}${size}`;
    }
  }
}

/** ISO 时间 → 展示文本（UTC，确定性切片；「YYYY-MM-DD HH:mm」） */
export function formatSyncTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
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

/** 设置面板「云同步」组状态行文案（最近同步时间；未配置时提示配置） */
export function syncStatusSummary(sync: CloudSyncStatus): string {
  switch (sync.kind) {
    case "unconfigured":
      return "未配置（填写 R2 四项后自动启用）";
    case "syncing":
      return "同步中…";
    case "idle":
      return sync.lastSyncAt ? `最近同步 ${formatSyncTime(sync.lastSyncAt)}` : SYNC_PENDING_LABEL;
    case "error":
      return `失败：${sync.message}`;
  }
}
