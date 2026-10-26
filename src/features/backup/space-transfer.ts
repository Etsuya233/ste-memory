import { restoredMemoryMacros } from "../macros/macro-expression.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type { MemoryMacro } from "../macros/macro-expression.ts";
import type { MemoryBackupRepository, MemoryBackupSnapshot } from "./backup-port.ts";
import type { MemoryBackupData, MemorySpaceBackup } from "./backup-file.ts";
import { parseBackupFile } from "./backup-codec.ts";

/**
 * 备份文件命名的单空间导出/整体导出（纯函数）：文件名带导出日期，
 * 与信封 exportedAt 同源。
 */
export function backupFilename(exportedAt: string): string {
  return `ste-memory-backup-${exportedAt.slice(0, 10)}.json`;
}

export function spaceExportFilename(exportedAt: string): string {
  return `ste-memory-space-export-${exportedAt.slice(0, 10)}.json`;
}

/**
 * 从全库快照提取当前空间的单单元导出（issue 26 纯函数 seam）：只含当前空间单元，
 * 按 includeHistory 裁剪修订历史；找不到当前空间返回 null（导出前校验）。
 *
 * 单空间导出用于「备份并应用」与手动导出，因此带上该单元的任务与楼层进度
 * （loadSnapshot 已含）并写入导出时当前对话的对话级宏，使备份能恢复本次将被
 * 删除的持久化内容（spec 表格预设 6.3）。
 */
export function buildSpaceExportUnit(
  snapshot: MemoryBackupSnapshot,
  spaceId: MemorySpaceId,
  includeHistory: boolean,
  chatScopeMacros?: readonly MemoryMacro[],
): MemorySpaceBackup | null {
  const unit = snapshot.spaces.find((item) => item.space.id === spaceId);
  if (!unit) return null;
  const trimmed = includeHistory ? unit : { ...unit, history: [] };
  return {
    ...trimmed,
    space: {
      ...trimmed.space,
      ...(chatScopeMacros === undefined ? {} : { macros: [...chatScopeMacros] }),
    },
  };
}

/**
 * 全库备份导入的编排（从设置面板抽出）：
 * - 解析校验文件（信封/结构/完整性）：失败不触碰数据库（plan）；
 * - 确认后整体替换原子执行：任一步失败整体回滚，绝不产生半导入状态；
 * - 成功后刷新面板数据、重建记忆宏快照、重同步当前对话绑定。
 */
export type FullBackupImportPlan =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly data: MemoryBackupData;
      readonly spaceCount: number;
      readonly confirmMessage: string;
    };

export interface FullBackupImportDeps {
  readonly backup: Pick<MemoryBackupRepository, "restoreSnapshot">;
  readonly syncToCurrentChat: () => Promise<unknown>;
  /** 记忆宏快照重建（导入即整库数据变更，不等轮询） */
  readonly kickMacros: () => void;
  /** 面板数据刷新（依赖数据的区块重取） */
  readonly onDataChanged: () => void;
}

export function planFullBackupImport(text: string): FullBackupImportPlan {
  let decoded;
  try {
    decoded = parseBackupFile(text);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const spaceCount = decoded.data.spaces.length;
  return {
    kind: "ready",
    data: decoded.data,
    spaceCount,
    confirmMessage: `导入将替换当前全部记忆数据（共 ${spaceCount} 个记忆空间），确定继续？`,
  };
}

export async function executeFullBackupImport(
  plan: Extract<FullBackupImportPlan, { kind: "ready" }>,
  deps: FullBackupImportDeps,
): Promise<void> {
  await deps.backup.restoreSnapshot({
    spaces: plan.data.spaces.map((unit) => ({
      ...unit,
      space: { ...unit.space, macros: restoredMemoryMacros(unit.space.macros ?? []) },
    })),
  });
  deps.onDataChanged();
  deps.kickMacros();
  await deps.syncToCurrentChat();
}
