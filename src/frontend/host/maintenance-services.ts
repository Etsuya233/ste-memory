import { ChatSnapshotReplacementSaveError } from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import type { SteMemoryRuntime } from "../../runtime.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import {
  buildChatSpaceName,
  chatIdentityKey,
} from "../../features/chat-binding/chat-space-manager.ts";
import { ImportDiagnostic } from "../../features/backup/import-diagnostic.ts";
import { spaceExportFilename } from "../../features/backup/space-transfer.ts";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import { downloadTextFile } from "../../infrastructure/browser/download.ts";
import type {
  MaintenanceContext,
  MaintenanceServices,
} from "../pages/maintenance/maintenance-page.tsx";

export function createMaintenanceServices(
  runtime: SteMemoryRuntime,
  onChanged: () => Promise<void>,
): MaintenanceServices {
  const currentContext = (): MaintenanceContext | null => {
    const status = runtime.manager.getStatus();
    const chatKey = chatIdentityKey(runtime.adapter.getChatSnapshot());
    if (!runtime.settings.read().enabled || !chatKey) {
      return null;
    }
    if (status?.kind === "active") {
      return { chatKey, spaceId: status.space.id, title: status.space.name };
    }
    if (status?.kind === "load-error" && runtime.adapter.captureFileTarget()) {
      return {
        chatKey,
        spaceId: null,
        title: buildChatSpaceName(runtime.adapter.getChatSnapshot()),
      };
    }
    return null;
  };
  function assertTarget(target: MaintenanceContext) {
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
      if (!target?.spaceId) {
        throw new Error("请先打开有记忆空间的对话");
      }
      const unit = await runtime.backup.exportCurrentSpace();
      assertTarget(target);
      const file = createBackupFile({ spaces: [unit] }, runtime.version, new Date().toISOString());
      downloadTextFile(serializeBackupFile(file), spaceExportFilename(file.exportedAt));
      return true;
    },
    previewImport: async (text) => {
      const diagnostic = new ImportDiagnostic(
        runtime.logs,
        chatIdentityKey(runtime.adapter.getChatSnapshot()),
        runtime.version,
      );
      try {
        const target = currentContext();
        if (!target) {
          throw new Error("请先打开有记忆空间的对话");
        }
        const file = parseBackupFile(text);
        if (file.data.spaces.length !== 1) {
          throw new Error("导入文件必须只包含一个记忆空间");
        }
        const unit = file.data.spaces[0]!;
        diagnostic.describe({
          backupVersion: file.version,
          backupAppVersion: file.appVersion,
          schemaVersion: unit.schemaVersion,
          tables: unit.tables.length,
          fields: unit.fields.length,
          records: unit.records.length,
          history: unit.history.length,
          evidence: unit.evidence.length,
        });
        diagnostic.stage("preview");
        let applied = false;
        return {
          recordCount: unit.records.length,
          summary: `${unit.space.name}：${unit.tables.length} 张表，${unit.records.length} 条记录`,
          confirmMessage: `将以「${unit.space.name}」替换当前对话「${target.title}」的记忆空间。`,
          apply: async () => {
            try {
              if (applied) {
                throw new Error("此导入预览已使用，请重新加载数据，勿重复导入");
              }
              assertTarget(target);
              diagnostic.stage("macro-validation");
              const normalized = await runtime.normalizeImportedSpace(unit);
              assertTarget(target);
              // 候选先在内存生效；核验失败仍由 persistence 持有，重试不再次导入。
              try {
                await runtime.manager.importSpace(normalized, (phase) => diagnostic.stage(phase));
              } catch (cause) {
                if (!(cause instanceof ChatSnapshotReplacementSaveError)) {
                  throw cause;
                }
                applied = true;
                const error = await diagnostic.failed(cause);
                return {
                  kind: "replacement-unverified",
                  message: error.message,
                  logKey: diagnostic.id,
                };
              }
              applied = true;
              try {
                diagnostic.stage("refresh");
                await refresh();
                const cleanup = runtime.persistence.getStatus(target.chatKey).cleanup;
                const warning = cleanup.kind === "failed" ? cleanup.message : undefined;
                if (warning) {
                  diagnostic.warning(warning);
                }
                await diagnostic.complete();
                if (warning) {
                  return {
                    kind: "applied-with-sync-issue",
                    message: warning,
                    logKey: diagnostic.id,
                  };
                }
                return {
                  kind: "done",
                  message: "当前对话的记忆空间已替换。",
                  logKey: diagnostic.id,
                };
              } catch (cause) {
                const error = await diagnostic.failed(cause);
                return {
                  kind: "applied-with-sync-issue",
                  logKey: diagnostic.id,
                  message: `导入已保存，后续刷新未完成：${error.message}`,
                };
              }
            } catch (cause) {
              throw await diagnostic.failed(cause);
            }
          },
        };
      } catch (cause) {
        throw await diagnostic.failed(cause);
      }
    },
    clearRecords: async (target) => {
      assertTarget(target);
      if (!target.spaceId) {
        throw new Error("当前空间未加载，无法清除记录");
      }
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
