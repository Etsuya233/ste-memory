import type { SteMemoryRuntime } from "../../runtime.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import { chatIdentityKey } from "../../features/chat-binding/chat-space-manager.ts";
import { captureSpaceStructure } from "../../features/table-presets/space-structure-capture.ts";
import { createBackupFile, serializeBackupFile } from "../../features/backup/backup-codec.ts";
import { buildSpaceExportUnit, spaceExportFilename } from "../../features/backup/space-transfer.ts";
import { saveTextFile } from "../../infrastructure/browser/download.ts";
import type {
  PresetContext,
  PresetSettingsServices,
} from "../pages/settings/preset-settings-services.ts";

export function createPresetSettingsServices(
  runtime: SteMemoryRuntime,
  onRebuilt: (context: PresetContext) => Promise<void>,
  stopQueries: (spaceId: MemorySpaceId) => void,
  onUpdated: (context: PresetContext) => Promise<void>,
): PresetSettingsServices {
  function assertTarget(context: Pick<PresetContext, "spaceId" | "chatIdentity">) {
    runtime.presetApply.assertCurrentChat(context.chatIdentity);
    const status = runtime.manager.getStatus();
    if (
      !runtime.settings.read().enabled ||
      status?.kind !== "active" ||
      status.space.id !== context.spaceId
    )
      throw new Error("当前对话的记忆空间已变化，请重新确认应用目标");
    return status;
  }
  return {
    spaceUpdate: {
      preview: (spaceId, preset, chatIdentity) =>
        runtime.presetUpdate.preview(spaceId, preset, chatIdentity),
      apply: async (plan, selectedIds, chatIdentity) => {
        const target = assertTarget({ spaceId: plan.spaceId, chatIdentity });
        const context = { spaceId: plan.spaceId, chatIdentity, title: target.space.name };
        stopQueries(plan.spaceId);
        const outcome = await runtime.presetUpdate.apply(plan, selectedIds, chatIdentity);
        try {
          await onUpdated(context);
          return outcome;
        } catch (cause) {
          return {
            issues: [
              ...outcome.issues,
              `更新已提交，界面刷新失败：${cause instanceof Error ? cause.message : String(cause)}`,
            ],
          };
        }
      },
      retrySave: async (spaceId, chatIdentity) => {
        const target = assertTarget({ spaceId, chatIdentity });
        const context = { spaceId, chatIdentity, title: target.space.name };
        const outcome = await runtime.presetUpdate.retrySave(spaceId, chatIdentity);
        try {
          await onUpdated(context);
          return outcome;
        } catch (cause) {
          return {
            issues: [
              ...outcome.issues,
              `保存重试已结束，界面刷新失败：${cause instanceof Error ? cause.message : String(cause)}`,
            ],
          };
        }
      },
    },
    agentPreview: runtime.presetPreview,
    currentContext: () => {
      const status = runtime.manager.getStatus();
      const chatIdentity = chatIdentityKey(runtime.adapter.getChatSnapshot());
      return runtime.settings.read().enabled && status?.kind === "active" && chatIdentity
        ? { spaceId: status.space.id, chatIdentity, title: status.space.name }
        : null;
    },
    readCurrentStructure: async (context) => {
      const status = assertTarget(context);
      const structure = await captureSpaceStructure(
        {
          listTables: (id) => runtime.tables.list(id),
          listFields: (spaceId, tableId) => runtime.fields.list(spaceId, tableId),
        },
        context.spaceId,
        status.space.prompt,
        status.space.macros,
      );
      assertTarget(context);
      return structure;
    },
    validateTablePreset: (preset) => runtime.presetApply.validate(preset),
    backupCurrentSpace: (context) => {
      assertTarget(context);
      return saveTextFile(async () => {
        assertTarget(context);
        stopQueries(context.spaceId);
        await runtime.presetApply.stopSpaceWrites(context.spaceId);
        assertTarget(context);
        const macros = runtime.cleaning.readChatScopeMacros();
        const snapshot = await runtime.backup.loadSnapshot();
        assertTarget(context);
        const unit = buildSpaceExportUnit(snapshot, context.spaceId, true, macros);
        if (!unit) throw new Error("目标记忆空间已不存在，无法备份");
        return serializeBackupFile(
          createBackupFile({ spaces: [unit] }, runtime.version, new Date().toISOString()),
        );
      }, spaceExportFilename(new Date().toISOString()));
    },
    applyTablePreset: async (context, preset) => {
      assertTarget(context);
      stopQueries(context.spaceId);
      await runtime.presetApply.stopSpaceWrites(context.spaceId);
      assertTarget(context);
      const outcome = await runtime.presetApply.applyPreset(context.spaceId, preset, {
        chatIdentity: context.chatIdentity,
        refreshMacros: () => runtime.macro.kick(),
        syncMirror: () => runtime.mirror.flushRebuiltSpace(context.spaceId, context.chatIdentity),
      });
      try {
        await onRebuilt(context);
        if (chatIdentityKey(runtime.adapter.getChatSnapshot()) === context.chatIdentity) {
          await runtime.manager.syncToCurrentChat();
        }
        return outcome;
      } catch (cause) {
        const message = `空间已重建，界面刷新失败：${cause instanceof Error ? cause.message : String(cause)}`;
        return {
          kind: "applied-with-sync-issue",
          message:
            outcome.kind === "applied-with-sync-issue" ? `${outcome.message}；${message}` : message,
        };
      }
    },
  };
}
