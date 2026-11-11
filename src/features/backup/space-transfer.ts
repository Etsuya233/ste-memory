/** 完整当前空间手动导出的文件名，与备份外壳时间一致。 */
export function spaceExportFilename(exportedAt: string): string {
  return `ste-memory-space-export-${exportedAt.slice(0, 10)}.json`;
}

export function historyExportFilename(
  chatName: string,
  versionName: string,
  savedAt: string,
): string {
  const parts = [chatName, versionName].map((name) =>
    name
      .replaceAll(/[<>:"/\\|?*]/g, "-")
      .split("")
      .filter((character) => character.charCodeAt(0) >= 32)
      .join("")
      .trim()
      .slice(0, 48),
  );
  return `ste-memory-${parts.join("-")}-${savedAt.replaceAll(":", "-")}.json`;
}
