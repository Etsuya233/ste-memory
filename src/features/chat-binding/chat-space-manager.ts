import type { BackupIdFactory, MemorySpaceBackup } from "../backup/index.ts";
import type { MemorySpace, MemorySpaceId } from "../memory/index.ts";
import { cloneMemorySnapshot } from "../memory-snapshot/snapshot-clone.ts";
import type {
  ChatFileTarget,
  ChatSnapshotPersistence,
} from "../chat-mirror/chat-snapshot-persistence.ts";
import {
  buildChatSpaceName,
  chatIdentityKey,
  UNSAVED_CHAT_MESSAGE,
  BINDING_UNRECOGNIZED_MESSAGE,
} from "./chat-space-context.ts";
import type {
  ChatSnapshot,
  ChatBindingStore,
  ChatSpaceBinding,
  ChatSpaceBindingV2,
  SpaceContextStatus,
} from "./chat-space-context.ts";
export * from "./chat-space-context.ts";

export interface ChatSpaceManagerPorts {
  readonly getChat: () => ChatSnapshot;
  readonly captureTarget: () => ChatFileTarget | undefined;
  readonly bindingStore: Pick<ChatBindingStore, "read">;
  readonly persistence: ChatSnapshotPersistence;
  readonly createSnapshot: (name: string) => Promise<MemorySpaceBackup>;
  readonly validateSnapshot: (unit: MemorySpaceBackup) => Promise<void>;
  readonly activateSnapshot: (
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    unit: MemorySpaceBackup,
  ) => Promise<void>;
  readonly unloadSnapshot: (id: MemorySpaceId, target: ChatFileTarget) => Promise<void>;
  readonly stopSpaceWrites: (id: MemorySpaceId) => Promise<void>;
  readonly retireSpace: (id: MemorySpaceId, target: ChatFileTarget) => Promise<void>;
  readonly findSpace: (id: MemorySpaceId) => Promise<MemorySpace | undefined>;
  readonly createIds: BackupIdFactory;
  readonly now: () => string;
}

interface ChatSelection {
  readonly chat: ChatSnapshot;
  readonly target: ChatFileTarget;
}

type ActivationOrigin = "created" | "restored" | "replacement";
interface CandidateRequest {
  readonly selection: ChatSelection;
  readonly oldId: MemorySpaceId | undefined;
}

/** 当前聊天只激活一个空间；候选与待保存状态由 persistence 持有。 */
export class ChatSpaceManager {
  #status: SpaceContextStatus | undefined;
  #selection: ChatSelection | undefined;
  #candidate: CandidateRequest | undefined;
  readonly #listeners = new Set<() => void>();
  private readonly ports: ChatSpaceManagerPorts;

  constructor(ports: ChatSpaceManagerPorts) {
    this.ports = ports;
  }

  getStatus(): SpaceContextStatus | undefined {
    return this.#status;
  }

  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clearCurrent(): void {
    this.#selection = undefined;
    this.#status = undefined;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  reportLoadError(error: unknown): void {
    this.publish({
      kind: "load-error",
      humanMsg: error instanceof Error ? error.message : String(error),
    });
  }

  async refreshSpace(id: MemorySpaceId): Promise<void> {
    const status = this.#status;
    if (status?.kind !== "active" || status.space.id !== id) {
      return;
    }
    const space = await this.ports.findSpace(id);
    if (!space) {
      throw new Error("当前空间尚未加载");
    }
    if (this.#status === status) {
      this.publish({ ...status, space });
    }
  }

  async syncToCurrentChat(): Promise<SpaceContextStatus> {
    const chat = this.ports.getChat();
    const target = this.ports.captureTarget();
    if (!target) {
      return this.publish({ kind: "unsaved-chat", humanMsg: UNSAVED_CHAT_MESSAGE });
    }
    // 每次进入聊天都建立新的选择对象；A→B→A 不能让第一次 A 的异步结果重新生效。
    const selection = { chat, target };
    this.#selection = selection;
    if (this.ports.persistence.hasSavedReplacement(target.identity)) {
      await this.ports.persistence.retry(target.identity);
      return this.currentSelectionStatus(selection);
    }
    const read = this.ports.bindingStore.read();
    if (read.kind === "unrecognized") {
      return this.publish({ kind: "binding-unrecognized", humanMsg: BINDING_UNRECOGNIZED_MESSAGE });
    }
    const pending = this.ports.persistence.current(target.identity);
    if (pending && this.ports.persistence.hasPendingReplacement(target.identity)) {
      // 候选尚未写入时恢复原空间；已落盘候选由上面的激活重试路径处理。
      this.ports.persistence.remember(target, pending.snapshot, pending.binding);
      return this.activate(selection, pending.binding, pending.snapshot, "replacement");
    }
    if (read.kind === "none") {
      return this.initializeChat(selection);
    }
    return this.loadBoundChat(selection, pending?.binding ?? read.binding);
  }

  private async initializeChat(selection: ChatSelection): Promise<SpaceContextStatus> {
    const { target, chat } = selection;
    if (this.ports.persistence.hasPendingReplacement(target.identity)) {
      throw new Error("新空间尚未保存，请重试保存候选空间");
    }
    const orphan = await this.ports.persistence.load(target);
    if (this.#selection !== selection) {
      throw new Error("聊天已切换，初始化操作已过期");
    }
    if (orphan) {
      throw new Error("聊天文件已有记忆快照但缺少空间绑定，已停止初始化");
    }
    return this.saveCandidate(
      selection,
      () => this.ports.createSnapshot(buildChatSpaceName(chat)),
      "created",
    );
  }

  private async loadBoundChat(
    selection: ChatSelection,
    binding: ChatSpaceBinding,
  ): Promise<SpaceContextStatus> {
    const { target } = selection;
    const unit = await this.ports.persistence.load(target, binding.spaceId);
    if (this.#selection !== selection) {
      return { kind: "load-error", humanMsg: "聊天已切换" };
    }
    if (!unit) {
      throw new Error("当前聊天文件没有记忆快照，无法加载已绑定空间");
    }
    // 沿用角色聊天的移植兼容约定：角色索引改变但文件名相同时允许升级绑定。
    // 文件名不能保证跨角色唯一；同 ID 被其他文件接管时，由空间生命周期检查 owner。
    const sameImportedFile =
      target.kind === "character" &&
      binding.version === 2 &&
      binding.chatIdentity.replace(/^char:[^:]+:/, "") === target.chatId;
    if (binding.version === 2 && binding.chatIdentity !== target.identity && !sameImportedFile) {
      return this.publish({
        kind: "branch-detected",
        binding,
        space: unit.space,
        originalChatIdentity: binding.chatIdentity,
        source: unit,
      });
    }
    if (binding.version === 1 || binding.chatIdentity !== target.identity) {
      return this.saveCandidate(selection, () => unit, "replacement");
    }
    this.ports.persistence.remember(target, unit, binding);
    return this.activate(selection, binding, unit, "restored");
  }

  async resolveBranch(
    option:
      | { readonly action: "create" }
      | { readonly action: "clone"; readonly sourceSpaceId: MemorySpaceId },
  ): Promise<SpaceContextStatus> {
    const status = this.#status;
    const selection = this.requireSelection();
    if (status?.kind !== "branch-detected") {
      throw new Error("当前聊天没有待处理的分支");
    }
    return this.saveCandidate(
      selection,
      () =>
        option.action === "create"
          ? this.ports.createSnapshot(buildChatSpaceName(selection.chat))
          : cloneMemorySnapshot(
              status.source,
              this.ports.createIds,
              buildChatSpaceName(selection.chat),
              this.ports.now(),
            ),
      "created",
    );
  }

  async importSpace(unit: MemorySpaceBackup): Promise<SpaceContextStatus> {
    const selection = this.requireSelection();
    return this.saveCandidate(
      selection,
      () =>
        cloneMemorySnapshot(
          unit,
          this.ports.createIds,
          buildChatSpaceName(selection.chat),
          this.ports.now(),
        ),
      "replacement",
    );
  }

  private requireSelection(): ChatSelection {
    const selection = this.#selection;
    if (!selection || chatIdentityKey(this.ports.getChat()) !== selection.target.identity) {
      throw new Error("聊天已切换，请回到原聊天后操作");
    }
    return selection;
  }

  private assertCandidateCurrent(request: CandidateRequest): void {
    // 请求身份同时约束聊天选择与本次候选，较早的导入/克隆不能覆盖后来的操作。
    if (this.#selection !== request.selection || this.#candidate !== request) {
      throw new Error("候选操作已过期，请在当前聊天重新确认");
    }
  }

  private async saveCandidate(
    selection: ChatSelection,
    build: () => MemorySpaceBackup | Promise<MemorySpaceBackup>,
    origin: "created" | "replacement",
  ): Promise<SpaceContextStatus> {
    const request = {
      selection,
      oldId: this.#status?.kind === "active" ? this.#status.space.id : undefined,
    };
    this.#candidate = request;
    this.assertCandidateCurrent(request);
    const unit = await build();
    this.assertCandidateCurrent(request);
    await this.ports.validateSnapshot(unit);
    this.assertCandidateCurrent(request);
    if (request.oldId) {
      await this.ports.stopSpaceWrites(request.oldId);
      this.assertCandidateCurrent(request);
    }
    const binding: ChatSpaceBindingV2 = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: selection.target.identity,
    };
    await this.ports.persistence.replace(selection.target, unit, binding, () =>
      this.activateSavedCandidate(request, binding, unit, origin),
    );
    return {
      kind: "active",
      binding,
      space: unit.space,
      created: origin === "created",
      restored: false,
    };
  }

  private async activateSavedCandidate(
    request: CandidateRequest,
    binding: ChatSpaceBinding,
    unit: MemorySpaceBackup,
    origin: "created" | "replacement",
  ): Promise<void> {
    const { selection, oldId } = request;
    try {
      if (oldId && oldId !== unit.space.id) {
        await this.ports.retireSpace(oldId, selection.target);
      }
      // 保存可跨聊天完成，退休按原文件归属执行；仅当前文件可重新装载 SQLite。
      if (chatIdentityKey(this.ports.getChat()) !== selection.target.identity) {
        return;
      }
      const current = this.#selection;
      if (current?.target.identity === selection.target.identity) {
        await this.activate(current, binding, unit, origin);
      }
    } catch (error) {
      if (chatIdentityKey(this.ports.getChat()) === selection.target.identity) {
        this.reportLoadError(error);
      }
      throw error;
    }
  }

  private currentSelectionStatus(selection: ChatSelection): SpaceContextStatus {
    if (this.#selection !== selection) {
      return { kind: "load-error", humanMsg: "聊天已切换" };
    }
    if (!this.#status) {
      throw new Error("候选保存完成后未发布空间状态");
    }
    return this.#status;
  }

  private async activate(
    selection: ChatSelection,
    binding: ChatSpaceBinding,
    unit: MemorySpaceBackup,
    origin: ActivationOrigin,
  ): Promise<SpaceContextStatus> {
    if (this.#selection !== selection) {
      return { kind: "load-error", humanMsg: "聊天已切换" };
    }
    await this.ports.activateSnapshot(selection.target, binding, unit);
    if (this.#selection !== selection) {
      await this.ports.unloadSnapshot(unit.space.id, selection.target);
      return { kind: "load-error", humanMsg: "聊天已切换" };
    }
    return this.publish({
      kind: "active",
      binding,
      space: unit.space,
      created: origin === "created",
      restored: origin === "restored",
    });
  }

  private publish(status: SpaceContextStatus): SpaceContextStatus {
    this.#status = status;
    for (const listener of this.#listeners) {
      listener();
    }
    return status;
  }
}
