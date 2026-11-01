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

/** 一次宿主提交拥有不可变输入；回读只确认这两个完整 metadata 键。 */
export class ChatSnapshotSaveTask {
  readonly content: SavedChatContent;
  readonly file: ChatMirrorFile;
  readonly operation: SnapshotSaveOperation;
  private readonly confirmed?: () => Promise<void>;

  constructor(
    content: SavedChatContent,
    operation: SnapshotSaveOperation,
    appVersion: string,
    confirmed?: () => Promise<void>,
  ) {
    this.content = structuredClone(content);
    this.operation = operation;
    this.confirmed = confirmed;
    this.file = createChatMirrorFile(
      this.content.snapshot,
      this.content.binding.spaceId,
      this.content.snapshot.space.updatedAt,
      appVersion,
    );
  }

  get sizeBytes(): number {
    return new TextEncoder().encode(JSON.stringify(this.file)).length;
  }

  submit(store: ChatSnapshotFileStore): Promise<void> {
    return store.submit(this.content.target, this.file, this.content.binding);
  }

  async verify(store: ChatSnapshotFileStore): Promise<void> {
    const metadata = await store.verify(this.content.target);
    if (
      !sameStructure(metadata.steMemory, this.content.binding) ||
      !sameStructure(metadata.steMemoryMirror, this.file)
    ) {
      throw new Error("聊天文件中的完整记忆元数据与本次提交不一致");
    }
    await this.confirmed?.();
  }
}

/** JSON 对象键顺序不影响结构相等；数组顺序属于领域内容，必须相同。 */
function sameStructure(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameStructure(value, (right as Record<string, unknown>)[key]),
    )
  );
}
