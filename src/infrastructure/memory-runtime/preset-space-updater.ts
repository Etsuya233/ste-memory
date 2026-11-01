import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { ChatSpaceManager } from "../../features/chat-binding/chat-space-manager.ts";
import type { FillTaskService } from "../../features/fill-tasks/fill-task-service.ts";
import type { MemoryMacroService } from "../../features/macros/memory-macro-service.ts";
import {
  createReadTimeDisplayTextResolver,
  effectiveVectorIndexGroups,
  type MemorySpaceId,
  type MemoryTableId,
  type MemoryRecordId,
} from "../../features/memory/index.ts";
import type { SettingsStore } from "../../features/settings/plugin-settings.ts";
import type { PresetInstantiationIds } from "../../features/table-presets/preset-instantiation.ts";
import type { ResolvedTablePreset } from "../../features/table-presets/preset-model.ts";
import {
  buildPresetUpdate,
  previewPresetUpdate,
  type PresetSpaceUpdateService,
  type PresetUpdatePlan,
  type PresetUpdateOutcome,
} from "../../features/table-presets/preset-space-update.ts";
import type { TablePresetApplyService } from "../../features/table-presets/table-preset-apply-service.ts";
import type {
  VectorIndexService,
  VectorIndexRepository,
} from "../../features/vector-index/index.ts";
import type { VectorRetrievalService } from "../../features/vector-retrieval/vector-retrieval-service.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

interface PresetSpaceUpdaterPorts {
  readonly memory: SqliteMemoryStore;
  readonly manager: ChatSpaceManager;
  readonly settings: SettingsStore;
  readonly tasks: Pick<FillTaskService, "cancelAll">;
  readonly presetApply: Pick<TablePresetApplyService, "assertCurrentChat">;
  readonly forceSync: (id: MemorySpaceId, assertActive: () => void) => Promise<void>;
  readonly saveSnapshot: (unit: MemorySpaceBackup) => Promise<void>;
  readonly retrieval: Pick<VectorRetrievalService, "invalidate">;
  readonly macro: Pick<MemoryMacroService, "kick">;
  readonly vector: Pick<VectorIndexService, "reconcile">;
  readonly vectors: VectorIndexRepository;
  readonly ids: PresetInstantiationIds;
  readonly now: () => string;
  /** 含聊天代次、文件身份和空间 ID；A→B→A 也会产生不同值。 */
  readonly getSelectionKey: () => string;
}

interface UpdateTarget {
  readonly spaceId: MemorySpaceId;
  readonly chatIdentity: string;
  readonly selectionKey: string;
}

/** 增量预设更新拥有比较校验、SQLite 替换、宿主提交与派生数据刷新。
 * SQL 独占区止于提交及同步保存交接，网络等待不会阻挡聊天卸载或下一次编辑。 */
export class PresetSpaceUpdater implements PresetSpaceUpdateService {
  private readonly ports: PresetSpaceUpdaterPorts;

  constructor(ports: PresetSpaceUpdaterPorts) {
    this.ports = ports;
  }

  async preview(
    spaceId: MemorySpaceId,
    preset: ResolvedTablePreset,
    chatIdentity: string,
  ): Promise<PresetUpdatePlan> {
    const target = { spaceId, chatIdentity, selectionKey: this.ports.getSelectionKey() };
    this.assertTarget(target);
    const unit = await this.ports.memory.snapshot(spaceId);
    if (!unit) {
      throw new Error("记忆空间不存在");
    }
    this.assertTarget(target);
    return previewPresetUpdate(unit, preset);
  }

  async apply(
    plan: PresetUpdatePlan,
    selectedIds: readonly string[],
    chatIdentity: string,
  ): Promise<PresetUpdateOutcome> {
    const target = {
      spaceId: plan.spaceId,
      chatIdentity,
      selectionKey: this.ports.getSelectionKey(),
    };
    this.assertTarget(target);
    const previewUnit = await this.ports.memory.snapshot(plan.spaceId);
    if (!previewUnit) {
      throw new Error("记忆空间不存在");
    }
    // 先验证比较仍有效，才停止现有任务；真正提交前还会在独占区重新核对。
    buildPresetUpdate(previewUnit, plan, selectedIds, this.ports.ids, this.ports.now());
    this.assertTarget(target);
    await this.ports.tasks.cancelAll(plan.spaceId);
    await this.ports.memory.whenIdle(plan.spaceId);
    const { saving } = await this.commitUpdate(plan, selectedIds, target);
    return this.finishAfterSave(target, saving);
  }

  async retrySave(spaceId: MemorySpaceId, chatIdentity: string): Promise<PresetUpdateOutcome> {
    const target = { spaceId, chatIdentity, selectionKey: this.ports.getSelectionKey() };
    this.assertTarget(target);
    const saving = this.ports.forceSync(spaceId, () => {
      if (!this.isCurrentTarget(target)) {
        throw new Error("聊天或空间已切换，请在当前聊天重新同步");
      }
    });
    return this.finishAfterSave(target, saving);
  }

  private assertTarget(target: UpdateTarget): void {
    this.ports.presetApply.assertCurrentChat(target.chatIdentity);
    this.ports.memory.assertCanEdit(target.spaceId);
    if (!this.isCurrentTarget(target)) {
      throw new Error("当前空间绑定或插件状态已变化，请重新比较");
    }
  }

  private isCurrentTarget(target: UpdateTarget): boolean {
    const status = this.ports.manager.getStatus();
    return (
      this.ports.getSelectionKey() === target.selectionKey &&
      this.ports.settings.read().enabled &&
      status?.kind === "active" &&
      status.space.id === target.spaceId
    );
  }

  private commitUpdate(
    plan: PresetUpdatePlan,
    selectedIds: readonly string[],
    target: UpdateTarget,
  ): Promise<{ saving: Promise<void> }> {
    return this.ports.memory.exclusive(plan.spaceId, async (token) => {
      this.assertTarget(target);
      const unit = await this.ports.memory.snapshot(plan.spaceId);
      if (!unit) {
        throw new Error("记忆空间不存在");
      }
      const next = await this.updateSnapshot(unit, plan, selectedIds);
      this.assertTarget(target);
      // SQLite 先建库并提交，校验失败保留原库；此处不清除任务或向量。
      await this.ports.memory.replace(next, token);
      // 用对象返回 promise，避免 async 自动等待网络；保存已固定 target/binding/snapshot。
      return { saving: this.ports.saveSnapshot(next) };
    });
  }

  private async updateSnapshot(
    unit: MemorySpaceBackup,
    plan: PresetUpdatePlan,
    selectedIds: readonly string[],
  ): Promise<MemorySpaceBackup> {
    const next = buildPresetUpdate(unit, plan, selectedIds, this.ports.ids, this.ports.now());
    const display = createReadTimeDisplayTextResolver({
      getTable: async (id) => next.tables.find((table) => table.id === id),
      getFields: async (id) => next.fields.filter((field) => field.tableId === id),
      findRecord: async (tableId, recordId) =>
        next.records.find((record) => record.tableId === tableId && record.id === recordId),
    });
    return {
      ...next,
      records: await Promise.all(
        next.records.map(async (record) => ({
          ...record,
          displayText: await display(record),
        })),
      ),
    };
  }

  private async finishAfterSave(
    target: UpdateTarget,
    saving: Promise<void>,
  ): Promise<PresetUpdateOutcome> {
    const issues: string[] = [];
    try {
      await saving;
    } catch (error) {
      issues.push(`宿主提交或核验失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 已进入宿主的请求由宿主完成；后续界面和辅助数据只在原聊天代次仍活动时刷新。
    // 旧结果不能删除另一个文件接管的同 ID 向量。
    const { spaceId } = target;
    if (!this.isCurrentTarget(target)) {
      return { issues };
    }
    try {
      await this.ports.manager.refreshSpace(spaceId);
    } catch (error) {
      issues.push(`空间状态刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!this.isCurrentTarget(target)) {
      return { issues };
    }
    this.ports.retrieval.invalidate(spaceId, "空间已更新，请重新搜索");
    try {
      await this.ports.macro.kick();
    } catch (error) {
      issues.push(`宏刷新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (this.isCurrentTarget(target)) {
        await this.removeObsoleteVectors(target);
      }
    } catch (error) {
      issues.push(`索引处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return { issues };
  }

  private async removeObsoleteVectors(target: UpdateTarget): Promise<void> {
    const { spaceId } = target;
    await this.ports.vector.reconcile({ memorySpaceId: spaceId });
    const latest = await this.ports.memory.snapshot(spaceId);
    if (!latest) {
      throw new Error("记忆空间不存在");
    }
    if (!this.isCurrentTarget(target)) {
      return;
    }
    const groupIds = new Map(
      latest.tables.map((table) => [
        table.id,
        new Set(
          effectiveVectorIndexGroups(
            table.vectorIndex,
            latest.fields.filter((field) => field.tableId === table.id),
          ).map((group) => group.id),
        ),
      ]),
    );
    const recordIds = new Set(latest.records.map((record) => record.id));
    for (const item of await this.ports.vectors.listVectors({ memorySpaceId: spaceId })) {
      if (!this.isCurrentTarget(target)) {
        return;
      }
      if (!recordIds.has(item.recordId) || !groupIds.get(item.tableId)?.has(item.groupId)) {
        await this.ports.vectors.deleteVector(item.id);
      }
    }
    for (const suppression of await this.ports.vectors.listSuppressions()) {
      if (!this.isCurrentTarget(target)) {
        return;
      }
      if (suppression.memorySpaceId !== spaceId) {
        continue;
      }
      const [, tableId, recordId, groupId] = suppression.id.split("\u0000");
      if (
        !recordIds.has(recordId as MemoryRecordId) ||
        !groupIds.get(tableId as MemoryTableId)?.has(groupId!)
      ) {
        await this.ports.vectors.deleteSuppression(suppression.id);
      }
    }
  }
}
