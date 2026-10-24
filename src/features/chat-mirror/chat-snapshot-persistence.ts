import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-manager.ts";
import { createChatMirrorFile, decodeChatMirrorFile } from "./chat-mirror-codec.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";

/** 在旧对话仍活动时捕获；保存过程中不得重新从当前对话推导目标。 */
export type ChatFileTarget =
  | {
      readonly kind: "character";
      readonly identity: string;
      readonly chatId: string;
      readonly avatarUrl: string;
    }
  | { readonly kind: "group"; readonly identity: string; readonly chatId: string };

export interface ChatSnapshotFileStore {
  read(target: ChatFileTarget): Promise<unknown>;
  write(target: ChatFileTarget, file: ChatMirrorFile, binding?: ChatSpaceBinding): Promise<void>;
}

export type ChatSnapshotSaveStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly identity: string }
  | { readonly kind: "saved"; readonly identity: string }
  | { readonly kind: "failed"; readonly identity: string; readonly error: string };

/** 显式保存入口；不轮询、不比较时间戳、不裁剪历史，也不自动重试。 */
export class ChatSnapshotPersistence {
  readonly #store: ChatSnapshotFileStore;
  readonly #appVersion: () => string;
  readonly #listeners = new Set<() => void>();
  #status: ChatSnapshotSaveStatus = { kind: "idle" };
  #saving: Promise<void> = Promise.resolve();

  constructor(store: ChatSnapshotFileStore, appVersion: () => string) {
    this.#store = store;
    this.#appVersion = appVersion;
  }

  getStatus(): ChatSnapshotSaveStatus {
    return this.#status;
  }

  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async load(target: ChatFileTarget, spaceId: string): Promise<MemorySpaceBackup | undefined> {
    // A rapid return to a chat must not read the file before our own queued exit-save.
    await this.#saving;
    const raw = await this.#store.read(target);
    if (raw === undefined) return undefined;
    const file = decodeChatMirrorFile(raw);
    if (!file) throw new Error("对话文件中的记忆快照损坏或版本无法识别");
    if (file.spaceId !== spaceId) throw new Error("对话文件中的记忆快照与空间绑定不一致");
    return file.data;
  }

  save(target: ChatFileTarget, unit: MemorySpaceBackup, binding?: ChatSpaceBinding): Promise<void> {
    // 在排队前持有独立完整快照，允许调用方随后销毁旧空间数据库。
    const file = structuredClone(
      createChatMirrorFile(unit, unit.space.id, unit.space.updatedAt, this.#appVersion()),
    );
    if (!decodeChatMirrorFile(file)) return Promise.reject(new Error("待保存的记忆快照无效"));
    const capturedTarget = { ...target };
    const capturedBinding = binding ? { ...binding } : undefined;
    const run = this.#saving.then(async () => {
      this.#setStatus({ kind: "saving", identity: capturedTarget.identity });
      try {
        await this.#store.write(capturedTarget, file, capturedBinding);
        this.#setStatus({ kind: "saved", identity: capturedTarget.identity });
      } catch (error) {
        this.#setStatus({
          kind: "failed",
          identity: capturedTarget.identity,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    this.#saving = run.catch(() => undefined);
    return run;
  }

  #setStatus(status: ChatSnapshotSaveStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}
