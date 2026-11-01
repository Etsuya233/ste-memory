import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-context.ts";
import { createChatMirrorFile } from "./chat-mirror-codec.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";
import type {
  ChatFileTarget,
  ChatSnapshotFileStore,
  SnapshotSaveOperation,
} from "./chat-snapshot-persistence.ts";

export interface SavedChatContent {
  readonly target: ChatFileTarget;
  readonly snapshot: MemorySpaceBackup;
  readonly binding: ChatSpaceBinding;
}
interface SaveWaiter {
  resolve(): void;
  reject(error: unknown): void;
}
type SaveConfirmation =
  | { readonly operation: "update"; readonly savedBatches: readonly (() => Promise<void>)[] }
  | { readonly operation: "replacement"; readonly activate: () => Promise<void> };

/** 一次固定文件保存拥有其输入、落盘阶段和业务确认；重试沿用同一任务。 */
export class ChatSnapshotSaveTask {
  readonly content: SavedChatContent;
  private readonly file: ChatMirrorFile;
  private confirmation: SaveConfirmation;
  private fileWritten = false;
  private readonly waiters: SaveWaiter[] = [];

  constructor(content: SavedChatContent, confirmation: SaveConfirmation, appVersion: string) {
    this.content = structuredClone(content);
    this.confirmation = confirmation;
    this.file = createChatMirrorFile(
      this.content.snapshot,
      this.content.binding.spaceId,
      this.content.snapshot.space.updatedAt,
      appVersion,
    );
  }

  get operation(): SnapshotSaveOperation {
    return this.confirmation.operation;
  }

  get phase(): "write" | "complete" | "activate" {
    if (!this.fileWritten) {
      return "write";
    }
    return this.operation === "update" ? "complete" : "activate";
  }

  get sizeBytes(): number {
    return new TextEncoder().encode(JSON.stringify(this.file)).length;
  }

  supersede(previous: ChatSnapshotSaveTask | undefined): void {
    if (!previous) {
      return;
    }
    if (this.confirmation.operation !== "update" || previous.confirmation.operation !== "update") {
      previous.rejectWaiters(new Error("保存操作已被新的候选替代"));
      return;
    }
    // 新快照包含较早批次的提交，必须一并确认它们；complete 阶段的旧调用已实际落盘，
    // 保留自己的 waiter。write 阶段的旧调用迁移到最新任务，按最新文件的实际结果结算。
    this.confirmation = {
      operation: "update",
      savedBatches: [...previous.confirmation.savedBatches, ...this.confirmation.savedBatches],
    };
    if (previous.phase === "write") {
      this.waiters.push(...previous.waiters.splice(0));
    }
  }

  waitForCompletion(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async writeAndConfirm(store: ChatSnapshotFileStore, isLatest: () => boolean): Promise<void> {
    const { target, binding } = this.content;
    if (!this.fileWritten) {
      await store.write(target, this.file, binding, this.operation);
      this.fileWritten = true;
    }
    if (!isLatest()) {
      return;
    }
    // 先落盘再发布 metadata，活动聊天绑定才能与磁盘一致；随后确认业务，
    // 填表台账或候选激活失败时才能保留已落盘阶段，重试仅继续确认。
    // 旧文件写入可能迟到，只有最新任务可发布 metadata 或开始业务确认。
    store.publish(target, this.file, binding);
    if (this.confirmation.operation === "replacement") {
      await this.confirmation.activate();
    } else {
      for (const acknowledge of this.confirmation.savedBatches) {
        await acknowledge();
      }
    }
  }

  resolveWaiters(): void {
    // 由队列在同一同步步骤收口状态与调用者，避免 await 的调用者先于 pending 清除恢复。
    // complete/activate 已开始后，新编辑不会撤销这次已落盘结果的确认。
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve();
    }
  }

  rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  failureMessage(reason: string): string {
    if (this.operation === "update") {
      if (this.phase === "write") {
        return `记忆已提交、尚未保存：${reason}`;
      }
      return `记忆已保存，批次确认尚未完成：${reason}`;
    }
    if (this.phase === "activate") {
      return `候选空间已保存，激活尚未完成：${reason}`;
    }
    return `候选空间尚未保存，当前空间未替换：${reason}`;
  }
}
