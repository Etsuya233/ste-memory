import type { ChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import { createChatMirrorFile, decodeChatMirrorFile } from "@ste-memory/core/memory/chat-mirror";
import type { MemoryBackupRepository } from "@ste-memory/core/memory/export";
import { resolveCloudLww } from "@ste-memory/core/memory/cloud";
import {
  fingerprintsEqual,
  type SpaceFingerprint,
  type SyncChangeSource,
} from "../cloud/space-fingerprint.ts";
import type { SyncTimerPort } from "../cloud/sync-coordinator.ts";
import {
  chatIdentityKey,
  type ChatBindingStore,
  type ChatSnapshot,
  type ChatSpaceBinding,
} from "../space-binding/chat-space-manager.ts";

/**
 * ChatMetadata 镜像同步（插件纯逻辑 seam，ticket 16 / ADR 0023）：把当前对话
 * 记忆空间的完整快照（结构 + 记录 + 修订历史 + 证据）写进 chat_metadata
 * （随聊天文件走），并在本地空间缺失时从镜像恢复。
 *
 * 同步模型（spec 决策：单通道，不做与 R2 的跨服务协调；本地优先）：
 * - 写回（本地 → 文件）：轮询当前对话绑定空间的指纹（复用 DexieSyncChangeSource）
 *   → 变化后防抖合并 → LWW（本地较新才写）→ mirrorStore.write（宿主 =
 *   chatMetadata 赋值 + saveMetadataDebounced）；
 * - 恢复（文件 → 本地）：ChatSpaceManager 在 space-missing 分支调用
 *   restoreFromMirror——镜像有效 + spaceId 与绑定一致才恢复（按空间事务，
 *   不碰其他空间）；
 * - 守卫：临时/未保存对话不写；绑定无法识别不写（同守则）；文件里已有无法
 *   识别的镜像不覆盖（降级安全，与绑定 unrecognized 同精神）；
 * - 文件身份跟踪：镜像写回按「对话文件身份」（chatIdentityKey）记录，复制的
 *   对话文件共享同一空间也不会互相漏写。
 *
 * 已知限制（v1 接受）：写回失败无失败信号（ST 保存无 CHAT_SAVED 事件，状态
 * 只展示上次写回时间）；本地删除不传播（打开时镜像会复活）；与 R2 各自独立
 * LWW，文件镜像较新而本地空间存在时只 warn 不动作。
 */

/** chatMetadata 镜像读写端口（宿主 = StChatAdapter.mirrorStore）：原始值由 seam 解码 */
export interface ChatMirrorStore {
  /** chatMetadata 里的原始值；undefined = 无镜像 */
  read(): unknown;
  /** 写镜像到 chatMetadata 并触发防抖持久化（随聊天文件走） */
  write(file: ChatMirrorFile): void;
}

/** 镜像同步状态（设置面板展示：体积 + 上次写回时间；无错误态——写回无失败信号） */
export type ChatMirrorStatus =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "idle";
      readonly lastWrittenAt: string | undefined;
      readonly sizeBytes: number | undefined;
    };

export interface ChatMetadataMirrorSyncPorts {
  readonly getChat: () => ChatSnapshot;
  readonly bindingStore: ChatBindingStore;
  readonly mirrorStore: ChatMirrorStore;
  readonly backup: MemoryBackupRepository;
  readonly changes: SyncChangeSource;
  /** 同步开关：插件总开关 && 镜像设置开关（宿主 = settings 读取） */
  readonly isEnabled: () => boolean;
  /** 镜像是否包含修订历史（设置项；关闭时 data.history 裁空，体积主要来源） */
  readonly includeHistory: () => boolean;
  readonly appVersion: () => string;
  /** 时钟（镜像 updatedAt 之外的上次写回时间） */
  readonly now: () => Date;
  readonly log?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** 指纹轮询间隔；缺省 2s（与云同步同节奏，轮询只是读指纹，写由防抖门控） */
  readonly pollIntervalMs?: number;
  /** 脏数据防抖窗口；缺省 3s */
  readonly debounceMs?: number;
  /** 定时器端口（测试注入 fake timers）；缺省 = globalThis */
  readonly timers?: SyncTimerPort;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DEBOUNCE_MS = 3_000;

/** 解析后的端口（可选字段带默认值），运行时只读 */
interface ResolvedChatMetadataMirrorSyncPorts extends ChatMetadataMirrorSyncPorts {
  readonly pollIntervalMs: number;
  readonly debounceMs: number;
  readonly timers: SyncTimerPort;
}

/** 镜像读取三态（解码在 seam：宿主只给原始值，校验归 core codec） */
type MirrorRead =
  | { readonly kind: "mirror"; readonly file: ChatMirrorFile }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "none" };

function readMirror(store: ChatMirrorStore): MirrorRead {
  const raw = store.read();
  if (raw === undefined) return { kind: "none" };
  const file = decodeChatMirrorFile(raw);
  return file ? { kind: "mirror", file } : { kind: "unrecognized" };
}

const defaultTimers: SyncTimerPort = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 每个对话文件「上次写回」的指纹跟踪：指纹相同即内容等价（快照构建确定），跳过写回。
 * 不需要字节比较：信封含 updatedAt（指纹键），指纹变化 ⇒ 信封必变 ⇒ 字节必变。 */
interface PushedMirror {
  readonly fingerprint: SpaceFingerprint;
}

export class ChatMetadataMirrorSync {
  readonly #ports: ResolvedChatMetadataMirrorSyncPorts;
  #status: ChatMirrorStatus = { kind: "disabled" };
  #pushed = new Map<string, PushedMirror>();
  #lastWrittenAt: string | undefined;
  #sizeBytes: number | undefined;
  #pollTimer: unknown = undefined;
  #debounceTimer: unknown = undefined;
  #stopped = false;
  #evaluating: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(ports: ChatMetadataMirrorSyncPorts) {
    this.#ports = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      timers: defaultTimers,
      ...ports,
    };
  }

  getStatus(): ChatMirrorStatus {
    return this.#status;
  }

  /** 订阅状态变化（设置面板展示）；返回退订函数 */
  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 启动（runtime 组合根调用）：立即评估一轮，并在启用期间保持轮询。 */
  async start(): Promise<void> {
    if (this.#stopped) return;
    await this.#queueEvaluate();
  }

  /** 停止（测试/卸载）：取消定时器，不再轮询。 */
  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
  }

  /** 设置变化后立即评估（幂等）：开关改动时宿主调用；写仍走防抖窗口（与云同步 kick 同语义）。 */
  kick(): Promise<void> {
    return this.#queueEvaluate();
  }

  /**
   * 镜像恢复（读侧，ChatSpaceManager 的 space-missing 分支调用）：
   * 镜像开关开启 + 镜像有效 + spaceId 与绑定一致 → 按空间恢复；其余情况一律
   * false（不碰库）。关闭开关即停用整个镜像功能（写与恢复都不执行）。
   */
  async restoreFromMirror(binding: ChatSpaceBinding): Promise<boolean> {
    if (!this.#ports.isEnabled()) return false;
    const read = readMirror(this.#ports.mirrorStore);
    if (read.kind !== "mirror") return false;
    if (read.file.spaceId !== binding.spaceId) return false;
    try {
      await this.#ports.backup.restoreSpace(read.file.data);
      this.#ports.log?.info(
        `已从对话文件镜像恢复记忆空间「${read.file.data.space.name}」（${read.file.spaceId}）`,
      );
      return true;
    } catch (error) {
      this.#ports.log?.error(
        `从对话文件镜像恢复失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** 评估排队：并发触发串行执行，最终收敛到最新状态；单轮异常不毒化队列。
   *  expectedIdentity：防抖触发时携带「武装时的对话身份」——防抖期间切走则放弃本轮。 */
  #queueEvaluate(force = false, expectedIdentity?: string): Promise<void> {
    const run = this.#evaluating.then(() => this.#evaluate(force, expectedIdentity));
    this.#evaluating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #evaluate(force = false, expectedIdentity?: string): Promise<void> {
    if (this.#stopped) return;
    if (!this.#ports.isEnabled()) {
      // 开关关闭/插件停用：停止轮询，状态回到 disabled
      this.#clearTimers();
      this.#setStatus({ kind: "disabled" });
      return;
    }
    this.#armPoll();
    // 已启用即处于 idle（lastWrittenAt/sizeBytes 未写回时为空）；相同状态不重复通知
    this.#setIdle();
    try {
      const chat = this.#ports.getChat();
      const identity = chatIdentityKey(chat);
      if (identity === undefined) return; // 临时/未保存对话：无文件可跟
      // 防抖窗口内切走了对话 → 放弃本轮（新对话由下轮自行处理；数据未丢）
      if (force && expectedIdentity !== undefined && identity !== expectedIdentity) return;
      const read = this.#ports.bindingStore.read();
      if (read.kind !== "bound") return; // 无绑定/绑定无法识别：不镜像（同守则）
      const spaceId = read.binding.spaceId;
      const fingerprint = await this.#ports.changes.fingerprint(spaceId);
      // 空指纹 = 该空间在本地库无任何行（绑定在、待恢复/待创建）：无可镜像内容
      if (fingerprint.updatedAt === "") {
        this.#pushed.set(identity, { fingerprint });
        this.#setIdle();
        return;
      }
      const pushed = this.#pushed.get(identity);
      if (pushed !== undefined && fingerprintsEqual(pushed.fingerprint, fingerprint)) {
        this.#setIdle();
        return;
      }
      if (!force) {
        // 防抖：变更窗口内的多次变更合并为一次写回（窗口内不重复武装；
        // 捕获武装时的对话身份，触发时比对——切走则放弃）
        if (this.#debounceTimer === undefined) {
          this.#debounceTimer = this.#ports.timers.setTimeout(() => {
            this.#debounceTimer = undefined;
            void this.#queueEvaluate(true, identity);
          }, this.#ports.debounceMs);
        }
        return;
      }
      await this.#writeMirror(identity, spaceId, fingerprint);
    } catch (error) {
      // 单轮失败只记日志：下轮轮询自然重试（无失败信号通道，状态保持）
      this.#ports.log?.error(
        `记忆镜像同步失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 写回（本地 → 对话文件）：身份/LWW 闸门后写出 */
  async #writeMirror(
    identity: string,
    spaceId: string,
    fingerprint: SpaceFingerprint,
  ): Promise<void> {
    const fileRead = readMirror(this.#ports.mirrorStore);
    if (fileRead.kind === "unrecognized") {
      // 文件里已有无法识别的镜像（未来版本/损坏）：原样保留，绝不覆盖
      this.#ports.log?.warn("对话文件中的记忆镜像无法识别（可能来自更新版本），已原样保留未覆盖");
      this.#pushed.set(identity, { fingerprint });
      return;
    }
    if (fileRead.kind === "mirror") {
      // LWW：本地不比文件新 → 不写（较新版本胜出；相等也不写）
      const decision = resolveCloudLww(fingerprint.updatedAt, fileRead.file.updatedAt);
      if (decision !== "local") {
        if (decision === "cloud") {
          this.#ports.log?.warn(
            `对话文件镜像比本地数据新（${fileRead.file.updatedAt} > ${fingerprint.updatedAt}），未覆盖`,
          );
        }
        this.#pushed.set(identity, { fingerprint });
        return;
      }
    }
    // 构建镜像：全库快照 → 该空间单元 → 按设置裁剪 history
    const snapshot = await this.#ports.backup.loadSnapshot();
    const unit = snapshot.spaces.find((item) => item.space.id === spaceId);
    if (unit === undefined) return; // 空间已被删除：无可镜像内容（下轮指纹为空会收敛）
    const file = createChatMirrorFile(
      unit,
      spaceId,
      fingerprint.updatedAt,
      this.#ports.appVersion(),
      this.#ports.includeHistory(),
    );
    const bytes = JSON.stringify(file);
    // 快照构建期间切走了对话 → 放弃写出（宿主写的是当前对话的 chatMetadata）
    if (chatIdentityKey(this.#ports.getChat()) !== identity) return;
    this.#ports.mirrorStore.write(file);
    this.#pushed.set(identity, { fingerprint });
    this.#lastWrittenAt = this.#nowIso();
    this.#sizeBytes = bytes.length;
    this.#setIdle();
    this.#ports.log?.info(
      `已把记忆镜像写入对话文件（${spaceId}，${(bytes.length / 1024).toFixed(1)} KB）`,
    );
  }

  #setIdle(): void {
    this.#setStatus({
      kind: "idle",
      lastWrittenAt: this.#lastWrittenAt,
      sizeBytes: this.#sizeBytes,
    });
  }

  #nowIso(): string {
    return this.#ports.now().toISOString();
  }

  /** 启用期间保持轮询（每次评估续期；停用/停止时取消） */
  #armPoll(): void {
    if (this.#pollTimer !== undefined || this.#stopped) return;
    this.#pollTimer = this.#ports.timers.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#queueEvaluate();
    }, this.#ports.pollIntervalMs);
  }

  #clearTimers(): void {
    if (this.#pollTimer !== undefined) {
      this.#ports.timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#debounceTimer !== undefined) {
      this.#ports.timers.clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
  }

  #setStatus(next: ChatMirrorStatus): void {
    if (sameStatus(this.#status, next)) return;
    this.#status = next;
    for (const listener of this.#listeners) listener();
  }
}

function sameStatus(left: ChatMirrorStatus, right: ChatMirrorStatus): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "disabled") return true;
  return (
    left.lastWrittenAt === (right as Extract<ChatMirrorStatus, { kind: "idle" }>).lastWrittenAt &&
    left.sizeBytes === (right as Extract<ChatMirrorStatus, { kind: "idle" }>).sizeBytes
  );
}
