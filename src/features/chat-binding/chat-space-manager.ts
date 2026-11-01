import type { BackupIdFactory, MemorySpaceBackup } from "../backup/index.ts";
import type { MemorySpace, MemorySpaceId } from "../memory/index.ts";
import { cloneMemorySnapshot } from "../memory-snapshot/snapshot-clone.ts";
import type {
  ChatFileTarget,
  ChatSnapshotPersistence,
} from "../chat-mirror/chat-snapshot-persistence.ts";
export interface ChatSnapshot {
  /** 对话文件名（无 .jsonl）；临时/未保存对话为 undefined */
  readonly chatId: string | undefined;
  /** 角色索引；群聊为 undefined */
  readonly characterId?: number | string | undefined;
  /** 群聊 id；非群聊为 null */
  readonly groupId: string | number | null | undefined;
  /** 角色名（ST name2）；群聊为 undefined */
  readonly characterName: string | undefined;
}

/** 记忆空间绑定指针（v1）：只存 spaceId，随对话文件（chatMetadata）走（ADR 0002） */
export interface ChatSpaceBindingV1 {
  readonly version: 1;
  readonly spaceId: MemorySpaceId;
}

/** 记忆空间绑定指针（v2）：新增 chatIdentity 标识绑定归属的对话，用于分支检测 */
export interface ChatSpaceBindingV2 {
  readonly version: 2;
  readonly spaceId: MemorySpaceId;
  readonly chatIdentity: string;
}

export type ChatSpaceBinding = ChatSpaceBindingV1 | ChatSpaceBindingV2;

/**
 * 绑定读取的三态结果：区分「无绑定」与「绑定值存在但无法识别」。
 * 无法识别（损坏 / 来自更新版本插件）时绝不能当作无绑定去新建覆盖——那会丢掉
 * 原指针（如插件降级场景），必须原样保留等待处理。
 */
export type ChatBindingStoreRead =
  | { readonly kind: "bound"; readonly binding: ChatSpaceBinding }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "none" };

/** chatMetadata 读写端口（宿主 = StChatAdapter.bindingStore） */
export interface ChatBindingStore {
  read(): ChatBindingStoreRead;
}

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
export type SpaceContextStatus =
  | {
      readonly kind: "active";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      readonly created: boolean;
      readonly restored: boolean;
    }
  | {
      readonly kind: "branch-detected";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      readonly originalChatIdentity: string;
      readonly source: MemorySpaceBackup;
    }
  | {
      readonly kind: "unsaved-chat" | "binding-unrecognized" | "load-error";
      readonly humanMsg: string;
    };
export const UNSAVED_CHAT_MESSAGE = "当前对话未保存，暂不支持记忆";
export const BINDING_UNRECOGNIZED_MESSAGE = "记忆空间绑定无法识别，已原样保留未做改动";

/** 空间显示名：群聊 = 「群聊 - 对话文件名」；单人 = 「角色名 - 对话文件名」（spec 决策 3）。
 * 名字只是显示，创建后不随对话重命名变化。Memory 的 memorySpaceName 上限 120 字符按
 * UTF-16 长度计（features/memory/domain/memory-space.ts），此处按同样口径截断——
 * 保证空间一定能创建；可能切断代理对，显示层可容忍。 */
export function buildChatSpaceName(chat: ChatSnapshot): string {
  const prefix =
    chat.groupId != null ? "群聊 - " : chat.characterName ? `${chat.characterName} - ` : "对话 - ";
  const full = `${prefix}${chat.chatId ?? ""}`;
  return full.length > 120 ? full.slice(0, 120) : full;
}

/** 对话身份键：群聊与单人对话可存在同名对话文件，身份必须区分（groupId / characterId 双轨）；
 * 临时/未保存对话（chatId 无值）→ undefined。镜像写侧用同一键跟踪「每个文件最后写回」
 * （复制的对话文件可共享同一空间，跟踪键必须是文件身份而非空间）。 */
export function chatIdentityKey(chat: ChatSnapshot): string | undefined {
  if (chat.chatId === undefined) return undefined;
  return chat.groupId != null
    ? `group:${String(chat.groupId)}:${chat.chatId}`
    : `char:${String(chat.characterId)}:${chat.chatId}`;
}

interface ChatSelection {
  readonly chat: ChatSnapshot;
  readonly target: ChatFileTarget;
}

/** 当前聊天只激活一个空间；候选与待保存状态由persistence持有。 */
export class ChatSpaceManager {
  #status: SpaceContextStatus | undefined;
  #selection: ChatSelection | undefined;
  #candidate: object | undefined;
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
    for (const listener of this.#listeners) listener();
  }
  reportLoadError(error: unknown): void {
    this.publish({
      kind: "load-error",
      humanMsg: error instanceof Error ? error.message : String(error),
    });
  }
  async refreshSpace(id: MemorySpaceId): Promise<void> {
    const status = this.#status;
    if (status?.kind !== "active" || status.space.id !== id) return;
    const space = await this.ports.findSpace(id);
    if (!space) throw new Error("当前空间尚未加载");
    if (this.#status === status) this.publish({ ...status, space });
  }
  async syncToCurrentChat(): Promise<SpaceContextStatus> {
    const chat = this.ports.getChat();
    const target = this.ports.captureTarget();
    if (!target) return this.publish({ kind: "unsaved-chat", humanMsg: UNSAVED_CHAT_MESSAGE });
    const selection = { chat, target };
    this.#selection = selection;
    if (this.ports.persistence.hasSavedReplacement(target.identity)) {
      await this.ports.persistence.retry(target.identity);
      return this.#status!;
    }
    const pending = this.ports.persistence.current(target.identity);
    const read = this.ports.bindingStore.read();
    if (read.kind === "unrecognized")
      return this.publish({ kind: "binding-unrecognized", humanMsg: BINDING_UNRECOGNIZED_MESSAGE });
    if (pending && this.ports.persistence.hasPendingReplacement(target.identity)) {
      this.ports.persistence.remember(target, pending.snapshot, pending.binding);
      await this.activate(selection, pending.binding, pending.snapshot, false, false);
      return this.#status!;
    }
    if (read.kind === "none") {
      if (this.ports.persistence.hasPendingReplacement(target.identity))
        throw new Error("新空间尚未保存，请重试保存候选空间");
      const orphan = await this.ports.persistence.load(target);
      if (this.#selection !== selection) throw new Error("聊天已切换，初始化操作已过期");
      if (orphan) throw new Error("聊天文件已有记忆快照但缺少空间绑定，已停止初始化");
      return this.saveCandidate(
        selection,
        () => this.ports.createSnapshot(buildChatSpaceName(chat)),
        true,
      );
    }
    const binding = pending?.binding ?? read.binding;
    const unit = await this.ports.persistence.load(target, binding.spaceId);
    if (this.#selection !== selection) return { kind: "load-error", humanMsg: "聊天已切换" };
    if (!unit) throw new Error("当前聊天文件没有记忆快照，无法加载已绑定空间");
    const identity = target.identity;
    const sameImportedFile =
      target.kind === "character" &&
      binding.version === 2 &&
      binding.chatIdentity.replace(/^char:[^:]+:/, "") === target.chatId;
    if (binding.version === 2 && binding.chatIdentity !== identity && !sameImportedFile)
      return this.publish({
        kind: "branch-detected",
        binding,
        space: unit.space,
        originalChatIdentity: binding.chatIdentity,
        source: unit,
      });
    if (binding.version === 1 || binding.chatIdentity !== identity)
      return this.saveCandidate(selection, () => unit, false);
    this.ports.persistence.remember(target, unit, binding);
    await this.activate(selection, binding, unit, false, true);
    return this.#status!;
  }
  async resolveBranch(
    option:
      | { readonly action: "create" }
      | { readonly action: "clone"; readonly sourceSpaceId: MemorySpaceId },
  ): Promise<SpaceContextStatus> {
    const status = this.#status;
    const selection = this.requireSelection();
    if (status?.kind !== "branch-detected") throw new Error("当前聊天没有待处理的分支");
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
      true,
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
      false,
    );
  }

  private requireSelection(): ChatSelection {
    const selection = this.#selection;
    if (!selection || chatIdentityKey(this.ports.getChat()) !== selection.target.identity)
      throw new Error("聊天已切换，请回到原聊天后操作");
    return selection;
  }
  private async saveCandidate(
    selection: ChatSelection,
    build: () => MemorySpaceBackup | Promise<MemorySpaceBackup>,
    created: boolean,
  ): Promise<SpaceContextStatus> {
    const request = {
      selection,
      oldId: this.#status?.kind === "active" ? this.#status.space.id : undefined,
    };
    this.#candidate = request;
    const assertCurrent = () => {
      if (this.#selection !== selection || this.#candidate !== request)
        throw new Error("候选操作已过期，请在当前聊天重新确认");
    };
    assertCurrent();
    const unit = await build();
    assertCurrent();
    await this.ports.validateSnapshot(unit);
    assertCurrent();
    const oldId = request.oldId;
    if (oldId) {
      await this.ports.stopSpaceWrites(oldId);
      assertCurrent();
    }
    const binding: ChatSpaceBindingV2 = {
      version: 2,
      spaceId: unit.space.id,
      chatIdentity: selection.target.identity,
    };
    const status: SpaceContextStatus = {
      kind: "active",
      binding,
      space: unit.space,
      created,
      restored: false,
    };
    await this.ports.persistence.replace(selection.target, unit, binding, async () => {
      try {
        if (oldId && oldId !== unit.space.id) await this.ports.retireSpace(oldId, selection.target);
        // 文件保存可以跨聊天完成，只有返回同一文件时才重新装载SQLite和发布context。
        if (chatIdentityKey(this.ports.getChat()) !== selection.target.identity) return;
        const current = this.#selection;
        if (current?.target.identity === selection.target.identity)
          await this.activate(current, binding, unit, created, false);
      } catch (error) {
        if (chatIdentityKey(this.ports.getChat()) === selection.target.identity)
          this.reportLoadError(error);
        throw error;
      }
    });
    return status;
  }
  private async activate(
    selection: ChatSelection,
    binding: ChatSpaceBinding,
    unit: MemorySpaceBackup,
    created: boolean,
    restored: boolean,
  ): Promise<void> {
    if (this.#selection !== selection) return;
    await this.ports.activateSnapshot(selection.target, binding, unit);
    if (this.#selection !== selection) {
      await this.ports.unloadSnapshot(unit.space.id, selection.target);
      return;
    }
    this.publish({ kind: "active", binding, space: unit.space, created, restored });
  }
  private publish(status: SpaceContextStatus): SpaceContextStatus {
    this.#status = status;
    for (const listener of this.#listeners) listener();
    return status;
  }
}
