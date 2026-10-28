import type { SteMemoryRuntime } from "../../runtime.ts";
import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import {
  chatIdentityKey,
  ImportedSpaceSyncError,
} from "../../features/chat-binding/chat-space-manager.ts";
import { planSpaceImport, executeSpaceImport } from "../../features/chat-binding/space-import.ts";
import {
  planFullBackupImport,
  executeFullBackupImport,
  buildSpaceExportUnit,
  backupFilename,
  spaceExportFilename,
} from "../../features/backup/space-transfer.ts";
import { createBackupFile, serializeBackupFile } from "../../features/backup/backup-codec.ts";
import { MemoryCommitPersistenceError, type MemorySpaceId } from "../../features/memory/index.ts";
import { downloadTextFile } from "../../infrastructure/browser/download.ts";
import type { RecordsContext } from "../pages/records-workspace.ts";
import type {
  MaintenanceServices,
  MaintenanceOutcome,
} from "../pages/maintenance/maintenance-page.tsx";

export function createMaintenanceServices(
  runtime: SteMemoryRuntime,
  onChanged: () => Promise<void>,
  clearHistory: (id: MemorySpaceId) => void,
): MaintenanceServices {
  const currentContext = (): RecordsContext | null => {
    const status = runtime.manager.getStatus();
    const chatKey = chatIdentityKey(runtime.adapter.getChatSnapshot());
    return runtime.settings.read().enabled && status?.kind === "active" && chatKey
      ? { chatKey, spaceId: status.space.id, title: status.space.name }
      : null;
  };
  function assertChat(chatKey: string | undefined, spaceId?: MemorySpaceId) {
    if (
      !runtime.settings.read().enabled ||
      !chatKey ||
      chatIdentityKey(runtime.adapter.getChatSnapshot()) !== chatKey
    )
      throw new Error("当前对话已切换或插件已停用，请重新预览操作");
    if (spaceId && currentContext()?.spaceId !== spaceId)
      throw new Error("当前记忆空间已变化，请重新预览操作");
  }
  async function synchronize(): Promise<void> {
    await runtime.manager.syncToCurrentChat();
    await Promise.all([runtime.macro.kick(), runtime.mirror.kick(), onChanged()]);
  }
  return {
    currentContext,
    canImportCurrent: () =>
      runtime.settings.read().enabled && !!chatIdentityKey(runtime.adapter.getChatSnapshot()),
    exportBackup: async (scope, includeHistory) => {
      const context = currentContext();
      if (scope === "current" && !context) throw new Error("请先打开有记忆空间的对话");
      const macros = scope === "current" ? runtime.cleaning.readChatScopeMacros() : undefined;
      const snapshot = await runtime.backup.loadSnapshot();
      let spaces = snapshot.spaces;
      if (scope === "current") {
        assertChat(context!.chatKey, context!.spaceId);
        const unit = buildSpaceExportUnit(snapshot, context!.spaceId, includeHistory, macros);
        if (!unit) throw new Error("目标空间已不存在，无法导出");
        spaces = [unit];
      } else if (!includeHistory) spaces = spaces.map((unit) => ({ ...unit, history: [] }));
      const file = createBackupFile({ spaces }, runtime.version, new Date().toISOString());
      downloadTextFile(
        serializeBackupFile(file),
        scope === "all" ? backupFilename(file.exportedAt) : spaceExportFilename(file.exportedAt),
      );
      return true;
    },
    previewImport: async (text, scope) => {
      const context = currentContext();
      const chatKey = chatIdentityKey(runtime.adapter.getChatSnapshot());
      assertChat(chatKey, context?.spaceId);
      const readBindingId = () => {
        const status = runtime.manager.getStatus();
        return status?.kind === "active"
          ? status.space.id
          : status?.kind === "space-missing" || status?.kind === "branch-detected"
            ? status.binding.spaceId
            : null;
      };
      const bindingId = readBindingId();
      const assertImportTarget = () => {
        assertChat(chatKey);
        if (readBindingId() !== bindingId)
          throw new Error("当前对话的空间绑定已变化，请重新预览导入文件");
      };
      const full = scope === "all" ? planFullBackupImport(text) : null;
      const single =
        scope === "current" ? planSpaceImport(text, runtime.manager.getStatus()) : null;
      if (full?.kind === "error") throw new Error(full.message);
      if (single?.kind === "error") throw new Error(single.message);
      const units =
        full?.kind === "ready"
          ? full.data.spaces
          : single?.kind === "ready"
            ? [single.action.unit]
            : [];
      let applied = false;
      return {
        scope,
        spaceCount: units.length,
        recordCount: units.reduce((total, unit) => total + unit.records.length, 0),
        summary: units
          .map(
            (unit) =>
              `${unit.space.name}：${unit.tables.length} 张表，${unit.records.length} 条记录`,
          )
          .join("\n"),
        confirmMessage: full?.kind === "ready" ? full.confirmMessage : single!.confirmMessage,
        apply: async () => {
          if (applied) throw new Error("此导入已提交，请重新加载数据，勿重复导入");
          assertImportTarget();
          const affected =
            scope === "all"
              ? (await runtime.backup.loadSnapshot()).spaces.map((unit) => unit.space.id)
              : context
                ? [context.spaceId]
                : [];
          for (const id of new Set([...affected, ...units.map((unit) => unit.space.id)])) {
            await runtime.presetApply.stopSpaceWrites(id);
            clearHistory(id);
          }
          assertImportTarget();
          const normalize = async (
            unit: Parameters<SteMemoryRuntime["normalizeImportedSpace"]>[0],
          ) => {
            const normalized = await runtime.normalizeImportedSpace(unit);
            assertImportTarget();
            return normalized;
          };
          try {
            if (full?.kind === "ready")
              await executeFullBackupImport(full, {
                normalizeImportedSpace: normalize,
                backup: {
                  restoreSnapshot: async (snapshot) => {
                    assertImportTarget();
                    await runtime.backup.restoreSnapshot(snapshot);
                    applied = true;
                  },
                },
                syncToCurrentChat: async () => {},
                kickMacros: () => {},
                onDataChanged: () => {},
              });
            else if (single?.kind === "ready")
              await executeSpaceImport(single, {
                normalizeImportedSpace: normalize,
                backup: {
                  restoreSpace: async (unit) => {
                    assertImportTarget();
                    await runtime.backup.restoreSpace(unit);
                    applied = true;
                  },
                },
                manager: {
                  syncToCurrentChat: async () => undefined,
                  importSpace: async (unit) => {
                    assertImportTarget();
                    const result = await runtime.manager.importSpace(unit);
                    applied = true;
                    return result;
                  },
                },
                kickMacros: () => {},
                kickMirror: () => {},
                onDataChanged: () => {},
                writeChatScopeMacros: async (macros) => {
                  assertChat(chatKey);
                  await runtime.settingsService.setChatScopeMacros(macros);
                },
              });
            await synchronize();
            return { kind: "done", message: `已导入 ${units.length} 个记忆空间。` };
          } catch (cause) {
            if (
              cause instanceof MemoryCommitPersistenceError ||
              cause instanceof ImportedSpaceSyncError
            )
              applied = true;
            if (!applied) throw cause;
            return {
              kind: "applied-with-sync-issue",
              message: `导入数据已提交，后续同步未完成：${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
        },
      };
    },
    clearRecords: async (target) => {
      assertChat(target.chatKey, target.spaceId);
      let applied = false;
      try {
        if (
          !(await runtime.spaceMaintenance.clearRecords(target.spaceId, () => {
            assertChat(target.chatKey, target.spaceId);
            clearHistory(target.spaceId);
          }))
        )
          throw new Error("目标空间已不存在");
        applied = true;
        clearHistory(target.spaceId);
        await synchronize();
        return { kind: "done", message: `已清除「${target.title}」的记录、历史与证据。` };
      } catch (cause) {
        if (
          cause instanceof MemoryCommitPersistenceError ||
          cause instanceof RecordsClearCleanupError
        )
          applied = true;
        if (!applied) throw cause;
        const outcome: MaintenanceOutcome = {
          kind: "applied-with-sync-issue",
          message: `记录已清除，后续同步未完成：${cause instanceof Error ? cause.message : String(cause)}`,
        };
        return outcome;
      }
    },
  };
}
