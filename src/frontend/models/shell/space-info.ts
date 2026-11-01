import type { ChatSnapshotSaveStatus } from "../../../features/chat-mirror/chat-snapshot-persistence.ts";

/** 保存状态由 runtime.persistence 持有，页面直接展示已提交与候选保存失败的区别。 */
export function snapshotSaveSummary(status: ChatSnapshotSaveStatus): string {
  switch (status.kind) {
    case "idle":
      return "尚未写入对话文件";
    case "saving":
      return "正在保存到对话文件";
    case "failed":
      return status.humanMsg;
    case "saved":
      return `上次写回 ${formatDisplayTime(status.lastWrittenAt)} · ${(status.sizeBytes / 1024).toFixed(1)} KB`;
  }
}

/** ISO 时间 → 展示文本（UTC，确定性切片；「YYYY-MM-DD HH:mm」） */
export function formatDisplayTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
