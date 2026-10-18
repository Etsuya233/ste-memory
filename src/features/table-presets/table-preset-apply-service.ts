import type { MemorySpaceId } from "../memory/index.ts";
import type { SpaceStructureRebuild } from "../space-maintenance/space-structure-rebuild.ts";
import { instantiateTablePreset, type PresetInstantiationIds } from "./preset-instantiation.ts";
import type { ResolvedTablePreset } from "./preset-model.ts";

/**
 * 应用表格预设（spec 6.3 / 6.4 / 10.1）：
 *
 * 1. 停止目标空间的进行中填表写入（stopSpaceWrites 在备份之前调用——备份后不会
 *    再有旧任务写入，防止最后一次写入未被备份便被清空）；
 * 2. 原子重建空间结构与数据（首次创建同一路径，见 installDefaultStructure）；
 * 3. 重建已提交后的同步阶段：清除本次操作所属对话的对话级宏、重建宏快照、
 *    同步当前对话记忆镜像（后两者由调用方按现有编排模式注入）。
 *
 * 失败区分：重建本身失败整体回滚（原持久化内容保留，不更新来源）；重建成功后
 * 的同步失败不重做重建、不再清空空间，错误按同步失败明确回报给界面。
 */

export interface TablePresetApplyPorts {
  /** 取消该空间进行中的填表任务（安全点停止、未提交提案丢弃） */
  readonly cancelActiveTask: (id: MemorySpaceId) => Promise<void>;
  /** 空间结构重建（单事务：结构/数据/任务与进度/来源） */
  readonly rebuild: SpaceStructureRebuild;
  /** 新空间默认预设（首次创建记忆空间时复制的内容） */
  readonly defaultPreset: () => ResolvedTablePreset;
  /** 本次操作所属对话身份（对话切换后不再触碰新对话的元数据） */
  readonly currentChatIdentity: () => string | undefined;
  /** 清除当前对话的对话级宏（写 chatMetadata） */
  readonly clearChatScopeMacros: () => void;
  readonly createIds: PresetInstantiationIds;
  readonly now: () => string;
}

/** 应用预设成功后的同步动作（调用方注入现有服务；失败不影响已提交的重建）。 */
export interface TablePresetSyncActions {
  /** 用户打开确认框时固定的对话身份，不能在执行时重新捕获。 */
  readonly chatIdentity: string;
  readonly refreshMacros: () => Promise<void>;
  readonly syncMirror: () => Promise<void>;
}

export type ApplyTablePresetOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "applied-with-sync-issue"; readonly message: string };

export class TablePresetApplyService {
  readonly #ports: TablePresetApplyPorts;

  constructor(ports: TablePresetApplyPorts) {
    this.#ports = ports;
  }

  /**
   * 首次创建记忆空间：复制当时的默认预设并记录初始化来源。与「应用预设」共用
   * 实例化与原子重建路径；失败上抛（调用方回收空间、不发布绑定）。
   */
  async installDefaultStructure(memorySpaceId: MemorySpaceId): Promise<void> {
    const preset = this.#ports.defaultPreset();
    const rebuilt = await this.#rebuildWithPreset(memorySpaceId, preset);
    if (!rebuilt) {
      throw new Error(`记忆空间不存在，无法初始化结构（预设「${preset.name}」）`);
    }
  }

  /** 应用预设前的写入停止：备份必须发生在这一步之后（spec 6.3）。 */
  async stopSpaceWrites(memorySpaceId: MemorySpaceId): Promise<void> {
    await this.#ports.cancelActiveTask(memorySpaceId);
  }

  assertCurrentChat(chatIdentity: string): void {
    if (this.#ports.currentChatIdentity() !== chatIdentity) {
      throw new Error("对话已切换，请回到原对话后重新确认");
    }
  }

  /**
   * 应用预设到指定空间：原子重建 + 成功后同步。空间不存在（已被删除）时抛错，
   * 不做任何写入。操作全过程使用同一份预设内容，且固定作用到传入的空间。
   */
  async applyPreset(
    memorySpaceId: MemorySpaceId,
    preset: ResolvedTablePreset,
    sync: TablePresetSyncActions,
  ): Promise<ApplyTablePresetOutcome> {
    const chatIdentity = sync.chatIdentity;
    this.assertCurrentChat(chatIdentity);
    const rebuilt = await this.#rebuildWithPreset(memorySpaceId, preset);
    if (!rebuilt) {
      throw new Error(`记忆空间不存在，无法应用预设「${preset.name}」`);
    }
    // 以下为重建后的同步阶段：空间已重建并提交，失败只回报，不重复清空
    const issues: string[] = [];
    if (this.#ports.currentChatIdentity() === chatIdentity) {
      try {
        this.#ports.clearChatScopeMacros();
      } catch (error) {
        issues.push(`对话级宏清除失败：${messageOf(error)}`);
      }
    } else {
      issues.push("对话已切换，未清理当前对话的对话级宏");
    }
    try {
      await sync.refreshMacros();
    } catch (error) {
      issues.push(`宏快照重建失败：${messageOf(error)}`);
    }
    try {
      this.assertCurrentChat(chatIdentity);
      await sync.syncMirror();
    } catch (error) {
      issues.push(`记忆镜像同步失败：${messageOf(error)}`);
    }
    return issues.length > 0
      ? { kind: "applied-with-sync-issue", message: issues.join("；") }
      : { kind: "applied" };
  }

  async #rebuildWithPreset(
    memorySpaceId: MemorySpaceId,
    preset: ResolvedTablePreset,
  ): Promise<boolean> {
    const now = this.#ports.now();
    const structure = instantiateTablePreset(preset, memorySpaceId, this.#ports.createIds, now);
    return this.#ports.rebuild.rebuild({
      memorySpaceId,
      tables: structure.tables,
      fields: structure.fields,
      initializationSource: { presetId: preset.id, presetName: preset.name, appliedAt: now },
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
