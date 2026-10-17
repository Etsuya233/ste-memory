/**
 * 浏览器文件下载（导出备份/单空间导出共用）：Blob + 临时 object URL，
 * 触发后即释放；仅在浏览器环境可用（面板交互路径）。
 */
export function downloadTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
