/** 完整当前空间手动导出的文件名，与备份外壳时间一致。 */
export function spaceExportFilename(exportedAt: string): string {
  return `ste-memory-space-export-${exportedAt.slice(0, 10)}.json`;
}
