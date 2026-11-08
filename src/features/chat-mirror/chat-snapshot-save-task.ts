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
  readonly retire?: () => Promise<void>;
  private readonly confirmed?: () => Promise<void>;

  constructor(
    content: SavedChatContent,
    operation: SnapshotSaveOperation,
    appVersion: string,
    confirmed?: () => Promise<void>,
    retire?: () => Promise<void>,
  ) {
    this.content = structuredClone(content);
    this.operation = operation;
    this.confirmed = confirmed;
    this.retire = retire;
    this.file = JSON.parse(
      JSON.stringify(
        createChatMirrorFile(
          this.content.snapshot,
          this.content.binding.spaceId,
          this.content.snapshot.space.updatedAt,
          appVersion,
        ),
      ),
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
    // 核验的是实际写入 JSON 的内容；可选 undefined 属性会在序列化时消失。
    const expected = JSON.parse(
      JSON.stringify({
        steMemory: this.content.binding,
        steMemoryMirror: this.file,
      }),
    );
    const difference = firstDifference(
      expected,
      {
        steMemory: metadata.steMemory,
        steMemoryMirror: metadata.steMemoryMirror,
      },
      "chat_metadata",
    );
    if (difference) {
      throw new Error(
        [
          "聊天文件中的完整记忆元数据与本次提交不一致",
          `目标对话：${this.content.target.identity}`,
          `操作：${this.operation}`,
          `首个差异：${difference.path}`,
          `应保存：${describeValue(difference.expected)}`,
          `文件回读：${describeValue(difference.actual)}`,
        ].join("\n"),
      );
    }
  }

  confirm(): Promise<void> {
    return this.confirmed?.() ?? Promise.resolve();
  }
}

interface SnapshotDifference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** 对象忽略键序，数组保留顺序；定位首个真实差异，避免在错误中倾倒整个空间。 */
function firstDifference(
  expected: unknown,
  actual: unknown,
  path: string,
): SnapshotDifference | undefined {
  if (expected === actual) {
    return undefined;
  }
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof actual !== "object" ||
    actual === null
  ) {
    return { path, expected, actual };
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return { path, expected, actual };
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) {
        return difference;
      }
    }
    return undefined;
  }
  const a = expected as Record<string, unknown>;
  const b = actual as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const childPath = `${path}.${key}`;
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
      return { path: childPath, expected: a[key], actual: b[key] };
    }
    const difference = firstDifference(a[key], b[key], childPath);
    if (difference) {
      return difference;
    }
  }
  return undefined;
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return "字段缺失";
  }
  if (Array.isArray(value)) {
    return `数组（${value.length} 项）`;
  }
  if (typeof value === "object" && value !== null) {
    return `对象（键：${Object.keys(value).join("、")}）`;
  }
  return JSON.stringify(value);
}
