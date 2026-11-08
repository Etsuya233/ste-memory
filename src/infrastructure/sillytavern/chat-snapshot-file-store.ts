import type {
  ChatFileTarget,
  ChatSnapshotFileStore,
} from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import type { ChatMirrorFile } from "../../features/chat-mirror/chat-mirror-file.ts";
import type { ChatSpaceBinding } from "../../features/chat-binding/chat-space-context.ts";

interface HostSnapshotAccess {
  assertActive(target: ChatFileTarget): void;
  metadata(): Record<string, unknown>;
  saveMetadata(): Promise<void>;
  headers(): Record<string, string>;
}

/** 写入只委托活动宿主；固定文件请求仅用于显式核验，不复制、重写聊天正文。 */
export class StChatSnapshotFileStore implements ChatSnapshotFileStore {
  private readonly host: HostSnapshotAccess;
  private readonly request: typeof fetch;
  constructor(host: HostSnapshotAccess, request: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.host = host;
    this.request = request;
  }

  async read(target: ChatFileTarget): Promise<unknown> {
    this.host.assertActive(target);
    return this.host.metadata().steMemoryMirror;
  }

  restore(target: ChatFileTarget, file: ChatMirrorFile, binding: ChatSpaceBinding): void {
    this.host.assertActive(target);
    const metadata = this.host.metadata();
    metadata.steMemory = structuredClone(binding);
    metadata.steMemoryMirror = structuredClone(file);
  }

  submit(target: ChatFileTarget, file: ChatMirrorFile, binding: ChatSpaceBinding): Promise<void> {
    this.restore(target, file, binding);
    // ST 内部会吞掉保存错误，Promise 完成只表示宿主调用结束。
    return this.host.saveMetadata();
  }

  async verify(target: ChatFileTarget): Promise<Record<string, unknown>> {
    const response = await this.request(
      target.kind === "group" ? "/api/chats/group/get" : "/api/chats/get",
      {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: this.host.headers(),
        body: JSON.stringify(
          target.kind === "group"
            ? { id: target.chatId }
            : { avatar_url: target.avatarUrl, file_name: target.chatId },
        ),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2048);
      throw new Error(
        `聊天文件核验请求失败 (${response.status})\n目标对话：${target.identity}\n响应摘要：${detail}`,
      );
    }
    const chat: unknown = await response.json();
    if (
      !Array.isArray(chat) ||
      !chat[0] ||
      typeof chat[0].chat_metadata !== "object" ||
      chat[0].chat_metadata === null
    ) {
      throw new Error("目标聊天文件缺失或元数据格式无法识别");
    }
    return chat[0].chat_metadata as Record<string, unknown>;
  }
}
