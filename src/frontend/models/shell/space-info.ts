/** ISO 时间 → 展示文本（UTC，确定性切片；「YYYY-MM-DD HH:mm」） */
export function formatDisplayTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
