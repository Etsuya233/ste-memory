import { ChatSnapshotReplacementSaveError } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import { chatIdentityKey } from "../../features/chat-binding/chat-space-manager.ts";
import { spaceExportFilename } from "../../features/backup/space-transfer.ts";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import { downloadTextFile } from "../../infrastructure/browser/download.ts";
import type { RecordsContext } from "../pages/records-workspace.ts";
import type { MaintenanceServices } from "../pages/maintenance/maintenance-page.tsx";

export function createMaintenanceServices(
  runtime: SteMemoryRuntime,
  onChanged: () => Promise<void>,
): MaintenanceServices {
  const currentContext = (): RecordsContext | null => {
    const status = runtime.manager.getStatus();
    const chatKey = chatIdentityKey(runtime.adapter.getChatSnapshot());
    return runtime.settings.read().enabled && status?.kind === "active" && chatKey
      ? { chatKey, spaceId: status.space.id, title: status.space.name }
      : null;
  };
  function assertTarget(target: RecordsContext) {
    const current = currentContext();
    if (current?.chatKey !== target.chatKey || current.spaceId !== target.spaceId) {
      throw new Error("当前对话已切换或记忆空间已变化，请重新预览操作");
    }
  }
  async function refresh(): Promise<void> {
    await Promise.all([runtime.macro.kick(), onChanged()]);
  }
  return {
    currentContext,
    exportBackup: async () => {
      const target = currentContext();
      if (!target) {
        throw new Error("请先打开有记忆空间的对话");
      }
      const unit = await runtime.backup.exportCurrentSpace();
      assertTarget(target);
      const file = createBackupFile({ spaces: [unit] }, runtime.version, new Date().toISOString());
      downloadTextFile(serializeBackupFile(file), spaceExportFilename(file.exportedAt));
      return true;
    },
    previewImport: async (text) => {
      const target = currentContext();
      if (!target) {
        throw new Error("请先打开有记忆空间的对话");
      }
      const file = parseBackupFile(text);
      if (file.data.spaces.length !== 1) {
        throw new Error("导入文件必须只包含一个记忆空间");
      }
      const unit = file.data.spaces[0]!;
      let applied = false;
      return {
        recordCount: unit.records.length,
        summary: `${unit.space.name}：${unit.tables.length} 张表，${unit.records.length} 条记录`,
        confirmMessage: `将以「${unit.space.name}」替换当前对话「${target.title}」的记忆空间。`,
        apply: async () => {
          if (applied) {
            throw new Error("此导入预览已使用，请重新加载数据，勿重复导入");
          }
          assertTarget(target);
          await runtime.presetApply.stopSpaceWrites(target.spaceId);
          assertTarget(target);
          const normalized = await runtime.normalizeImportedSpace(unit);
          assertTarget(target);
          // 候选先在内存生效；核验失败仍由 persistence 持有，重试不再次导入。
          try {
            await runtime.manager.importSpace(normalized);
          } catch (cause) {
            if (!(cause instanceof ChatSnapshotReplacementSaveError)) {
              throw cause;
            }
            applied = true;
            return { kind: "replacement-unverified", message: cause.humanMsg };
          }
          applied = true;
          try {
            await refresh();
            return { kind: "done", message: "当前对话的记忆空间已替换。" };
          } catch (cause) {
            return {
              kind: "applied-with-sync-issue",
              message: `导入已保存，后续刷新未完成：${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
        },
      };
    },
    clearRecords: async (target) => {
      assertTarget(target);
      let applied = false;
      try {
        if (
          !(await runtime.spaceMaintenance.clearRecords(target.spaceId, () => assertTarget(target)))
        ) {
          throw new Error("目标空间已不存在");
        }
        applied = true;
        await refresh();
        return { kind: "done", message: `已清除「${target.title}」的记录、历史与证据。` };
      } catch (cause) {
        if (cause instanceof ChatSnapshotReplacementSaveError) {
          // 候选已在内存生效，旧辅助数据由核心保留到核验完成；页面不可自行清理或重放清除。
          return { kind: "replacement-unverified", message: cause.humanMsg };
        }
        if (
          cause instanceof MemoryCommitPersistenceError ||
          cause instanceof RecordsClearCleanupError
        ) {
          applied = true;
        }
        if (!applied) {
          throw cause;
        }
        return {
          kind: "applied-with-sync-issue",
          message: `记录清除已提交，后续保存或刷新未完成：${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    },
  };
}
