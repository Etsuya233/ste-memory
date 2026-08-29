import type { MemorySpace, MemorySpaceId, MemorySpaceService } from "@ste-memory/core/memory";

/**
 * 对话 → 记忆空间的上下文管理器（插件的纯逻辑层 seam，spec 测试决策）。
 * 不依赖 ST getContext() 与浏览器 IndexedDB：宿主侧（StChatAdapter / Dexie
 * repository）以端口注入，测试用 fake 实现。
 *
 * 职责：
 * - 首次打开对话：自动创建记忆空间 + 安装系统表（模板来自共享包），并把绑定
 *   指针写入 chatMetadata（写绑定在最后——「绑定存在 = 空间与表已就绪」是不变量）；
 * - 再次打开 / 切对话（CHAT_CHANGED）：按绑定指针激活对应空间，不重复创建；
 * - 临时/未保存对话（chatId 无值）：跳过绑定、不建空间、不报错，状态
 *   unsaved-chat 供面板提示「当前对话未保存，暂不支持记忆」；
 * - 绑定存在但空间不在本地库（新设备 / 本地库被清）：保持绑定、不重建——
 *   云同步（ticket 08）拉取后自动恢复（spec「空库期间显示同步中状态而非报错」）。
 *
 * 不变量：
 * - 绑定存在 ⇔ 该对话的空间与系统表已就绪（创建中途失败回滚空间并抛错，下次
 *   打开重试；同步期间切走则回滚，绝不把旧对话的绑定写进新对话的 chatMetadata）；
 * - 空间显示名创建时定死，对话重命名不触发改名（绑定靠指针，名字只是显示，
 *   跨角色同名对话文件互不冲突）。
 */

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
  write(binding: ChatSpaceBinding): void;
}

/** 系统表安装端口（宿主 = SystemMemoryTableInstaller，模板来自共享包，ticket 01） */
export interface SystemTableInstallerPort {
  install(memorySpaceId: MemorySpaceId): Promise<void>;
}

export interface ChatSpaceManagerPorts {
  readonly getChat: () => ChatSnapshot;
  readonly bindingStore: ChatBindingStore;
  readonly spaces: MemorySpaceService;
  readonly installer: SystemTableInstallerPort;
  /** 镜像恢复端口（可选；宿主 = ChatMetadataMirrorSync.restoreFromMirror，ticket 16） */
  readonly mirrorRestore?: { restore(binding: ChatSpaceBinding): Promise<boolean> };
  /** 可选日志（宿主 = ST console）；消息不带前缀，由宿主包装 */
  readonly log?: { info(message: string): void };
  /** Dexie 备份仓库（分支对话分离：cloneSpace 克隆空间） */
  readonly backup?: { cloneSpace(
    sourceSpaceId: MemorySpaceId,
    createId: {
      space: () => MemorySpaceId;
      table: () => import("@ste-memory/core/memory").MemoryTableId;
      field: () => import("@ste-memory/core/memory").MemoryFieldId;
      record: () => import("@ste-memory/core/memory").MemoryRecordId;
      history: () => import("@ste-memory/core/memory").MemoryRecordHistoryId;
      evidence: () => import("@ste-memory/core/memory").MemoryEvidenceId;
    },
  ): Promise<MemorySpaceId> };
  /** ID 工厂（分支对话分离：cloneSpace 需要为新实体生成 ID） */
  readonly createId?: (prefix: string) => string;
}

export const BRANCH_CLONE_MISSING_PORTS = "克隆空间需要 backup 端口和 createId 工厂";

export type SpaceContextStatus =
  | {
      readonly kind: "active";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      /** 本次同步是否新建了空间（首次打开自动创建） */
      readonly created: boolean;
      /** 本次同步是否从对话文件镜像恢复（ticket 16；面板可区分「从文件镜像恢复」） */
      readonly restored: boolean;
    }
  | {
      readonly kind: "branch-detected";
      readonly binding: ChatSpaceBinding;
      readonly space: MemorySpace;
      /** 原始绑定所归属的 chatIdentity */
      readonly originalChatIdentity: string;
    }
  | { readonly kind: "unsaved-chat"; readonly humanMsg: string }
  | {
      readonly kind: "space-missing";
      readonly binding: ChatSpaceBinding;
      readonly humanMsg: string;
    }
  | { readonly kind: "binding-unrecognized"; readonly humanMsg: string };

export const UNSAVED_CHAT_MESSAGE = "当前对话未保存，暂不支持记忆";
export const SPACE_MISSING_MESSAGE =
  "记忆空间数据未就绪（本地库中暂无该空间，云同步拉取后自动恢复）";
export const BINDING_UNRECOGNIZED_MESSAGE =
  "记忆空间绑定无法识别（可能来自更新版本的插件），已原样保留未做改动";

/** 空间显示名：群聊 = 「群聊 - 对话文件名」；单人 = 「角色名 - 对话文件名」（spec 决策 3）。
 * 名字只是显示，创建后不随对话重命名变化。core 的 memorySpaceName 上限 120 字符按
 * UTF-16 长度计（core/src/memory/domain/memory-space.ts），此处按同样口径截断——
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

export class ChatSpaceManager {
  readonly #ports: ChatSpaceManagerPorts;
  #status: SpaceContextStatus | undefined;
  readonly #listeners = new Set<() => void>();
  #syncQueue: Promise<unknown> = Promise.resolve();

  constructor(ports: ChatSpaceManagerPorts) {
    this.#ports = ports;
  }

  /** 当前空间上下文；首次同步前为 undefined */
  getStatus(): SpaceContextStatus | undefined {
    return this.#status;
  }

  /** 订阅空间上下文变化（面板用）；返回退订函数 */
  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 把当前对话同步为空间上下文（启动与 CHAT_CHANGED 调用）。幂等；并发调用
   * 串行执行，每次都基于最新快照，最终状态收敛到当前对话。
   */
  syncToCurrentChat(): Promise<SpaceContextStatus> {
    const run = this.#syncQueue.then(() => this.#syncCurrentChat());
    this.#syncQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #syncCurrentChat(): Promise<SpaceContextStatus> {
    const chat = this.#ports.getChat();

    // 临时/未保存对话：跳过绑定，面板提示，不报错
    if (chat.chatId === undefined) {
      return this.#publish({ kind: "unsaved-chat", humanMsg: UNSAVED_CHAT_MESSAGE });
    }

    const read = this.#ports.bindingStore.read();
    if (read.kind === "unrecognized") {
      // 绑定值存在但无法识别：原样保留（不新建覆盖），状态给面板提示
      return this.#publish({
        kind: "binding-unrecognized",
        humanMsg: BINDING_UNRECOGNIZED_MESSAGE,
      });
    }
    if (read.kind === "bound") {
      let binding: ChatSpaceBinding = read.binding;

      // 集中式 v1 → v2 迁移：v1 绑定就地升级，补写当前 chatIdentity
      if (read.binding.version === 1) {
        const currentIdentity = chatIdentityKey(chat);
        if (currentIdentity !== undefined) {
          const upgraded: ChatSpaceBindingV2 = {
            version: 2,
            spaceId: read.binding.spaceId,
            chatIdentity: currentIdentity,
          };
          this.#ports.bindingStore.write(upgraded);
          binding = upgraded;
        }
      }

      // v2 绑定：检查是否为分支对话（chatIdentity 不匹配）
      if (binding.version === 2) {
        const currentIdentity = chatIdentityKey(chat);
        if (currentIdentity !== undefined && binding.chatIdentity !== currentIdentity) {
          const space = await this.#ports.spaces.find(binding.spaceId);
          if (space) {
            // 分支检测：v2 绑定的 chatIdentity 与当前不匹配，空间存在
            return this.#publish({
              kind: "branch-detected",
              binding,
              space,
              originalChatIdentity: binding.chatIdentity,
            });
          }
          // 空间缺失：降级到 space-missing
          return this.#publish({
            kind: "space-missing",
            binding,
            humanMsg: SPACE_MISSING_MESSAGE,
          });
        }
      }

      const space = await this.#ports.spaces.find(binding.spaceId);
      if (!space && this.#ports.mirrorRestore) {
        // 空间缺失（新设备/本地库被清）：先试从对话文件镜像恢复（ticket 16）——
        // 恢复成功且仍是当前对话 → active(restored)，否则维持 space-missing
        const restored = await this.#ports.mirrorRestore.restore(binding);
        if (restored) {
          const restoredSpace = await this.#ports.spaces.find(binding.spaceId);
          if (restoredSpace && this.#isCurrentChat(chat)) {
            return this.#publish({
              kind: "active",
              binding,
              space: restoredSpace,
              created: false,
              restored: true,
            });
          }
        }
      }
      const status = deriveSpaceStatus(binding, space);
      if (!this.#isCurrentChat(chat)) {
        // 同步期间用户已切走：结果属于旧对话，不发布（新对话的同步已在队列里）
        return status;
      }
      return this.#publish(status);
    }

    // 首次打开：自动创建空间 + 安装系统表 + 最后写绑定
    const space = await this.#ports.spaces.create(buildChatSpaceName(chat));
    try {
      await this.#ports.installer.install(space.id);
    } catch (error) {
      // 安装失败：回收空间、不写绑定，保持「绑定存在 = 就绪」不变量，下次打开重试
      await this.#ports.spaces.delete(space.id);
      throw error;
    }
    const identity = chatIdentityKey(chat) ?? "";
    const createdBinding: ChatSpaceBindingV2 = { version: 2, spaceId: space.id, chatIdentity: identity };
    if (!this.#isCurrentChat(chat)) {
      // 同步期间切走：不能把旧对话的绑定写进新对话的 chatMetadata，也不留孤儿空间
      await this.#ports.spaces.delete(space.id);
      return { kind: "active", binding: createdBinding, space, created: true, restored: false };
    }
    this.#ports.bindingStore.write(createdBinding);
    this.#ports.log?.info(`已为对话「${chat.chatId}」创建记忆空间「${space.name}」（${space.id}）`);
    return this.#publish({
      kind: "active",
      binding: createdBinding,
      space,
      created: true,
      restored: false,
    });
  }

  #isCurrentChat(chat: ChatSnapshot): boolean {
    return chatIdentityKey(this.#ports.getChat()) === chatIdentityKey(chat);
  }

  /**
   * 处理分支对话的用户选择：创建空空间或克隆原空间。
   * 操作完成后更新绑定并收敛到 active 状态。
   */
  async resolveBranch(
    option:
      | { readonly action: "create" }
      | { readonly action: "clone"; readonly sourceSpaceId: MemorySpaceId },
  ): Promise<SpaceContextStatus> {
    const chat = this.#ports.getChat();
    const currentIdentity = chatIdentityKey(chat) ?? "";
    const newSpaceName = buildChatSpaceName(chat);

    let newSpaceId: MemorySpaceId;
    if (option.action === "clone") {
      if (!this.#ports.backup || !this.#ports.createId) {
        throw new Error(BRANCH_CLONE_MISSING_PORTS);
      }
      // cloneSpace 内部创建空间行 + 克隆六张表数据，返回新空间 ID
      const id = this.#ports.createId!;
      newSpaceId = await this.#ports.backup.cloneSpace(option.sourceSpaceId, {
        space: () => id("space") as MemorySpaceId,
        table: () => id("table") as import("@ste-memory/core/memory").MemoryTableId,
        field: () => id("field") as import("@ste-memory/core/memory").MemoryFieldId,
        record: () => id("record") as import("@ste-memory/core/memory").MemoryRecordId,
        history: () => id("record-history") as import("@ste-memory/core/memory").MemoryRecordHistoryId,
        evidence: () => id("evidence") as import("@ste-memory/core/memory").MemoryEvidenceId,
      });
      // 克隆的空间继承源空间的名字，重命名为当前对话的命名规则
      await this.#ports.spaces.rename(newSpaceId, newSpaceName);
    } else {
      const space = await this.#ports.spaces.create(newSpaceName);
      try {
        await this.#ports.installer.install(space.id);
      } catch (error) {
        await this.#ports.spaces.delete(space.id);
        throw error;
      }
      newSpaceId = space.id;
    }

    // 写入新绑定
    const newBinding: ChatSpaceBindingV2 = {
      version: 2,
      spaceId: newSpaceId,
      chatIdentity: currentIdentity,
    };
    this.#ports.bindingStore.write(newBinding);
    this.#ports.log?.info(
      `分支对话「${chat.chatId}」已${option.action === "clone" ? "克隆" : "创建"}记忆空间「${newSpaceName}」（${newSpaceId}）`,
    );

    // 重新同步收敛到 active
    return this.syncToCurrentChat();
  }

  #publish(status: SpaceContextStatus): SpaceContextStatus {
    this.#status = status;
    for (const listener of this.#listeners) listener();
    return status;
  }
}

function deriveSpaceStatus(
  binding: ChatSpaceBinding,
  space: MemorySpace | undefined,
): SpaceContextStatus {
  if (!space) {
    // 绑定在、空间不在本地库：不重建（云同步/镜像恢复会恢复），保持绑定
    return { kind: "space-missing", binding, humanMsg: SPACE_MISSING_MESSAGE };
  }
  return { kind: "active", binding, space, created: false, restored: false };
}
