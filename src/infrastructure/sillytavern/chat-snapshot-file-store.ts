import type {
  ChatFileTarget,
  ChatMirrorFile,
  ChatSnapshotFileStore,
} from "../../features/chat-mirror/index.ts";
import { decodeChatMirrorFile } from "../../features/chat-mirror/index.ts";
import type { ChatSpaceBinding } from "../../features/chat-binding/chat-space-manager.ts";

/** ST 指定文件 API：读取最新正文，只替换本插件的快照键。 */
export class StChatSnapshotFileStore implements ChatSnapshotFileStore {
  readonly #fetch: typeof fetch;
  readonly #afterWrite: (
    target: ChatFileTarget,
    file: ChatMirrorFile,
    binding?: ChatSpaceBinding,
  ) => void;

  constructor(
    afterWrite: (target: ChatFileTarget, file: ChatMirrorFile, binding?: ChatSpaceBinding) => void,
    request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.#afterWrite = afterWrite;
    this.#fetch = request;
  }

  async read(target: ChatFileTarget): Promise<unknown> {
    const chat = await this.#readChat(target);
    return (chat[0]!.chat_metadata as Record<string, unknown>).steMemoryMirror;
  }

  async write(
    target: ChatFileTarget,
    file: ChatMirrorFile,
    binding?: ChatSpaceBinding,
  ): Promise<void> {
    if (!decodeChatMirrorFile(file)) throw new Error("待保存的记忆快照无效");
    const chat = await this.#readChat(target);
    const header = chat[0]!;
    const metadata = header.chat_metadata as Record<string, unknown>;
    const previous = metadata.steMemoryMirror;
    if (previous !== undefined && !decodeChatMirrorFile(previous)) {
      throw new Error("目标对话的记忆快照损坏或版本无法识别，已停止覆盖");
    }
    const existingBinding = metadata.steMemory;
    if (
      binding === undefined &&
      (!isObject(existingBinding) || existingBinding.spaceId !== file.spaceId)
    ) {
      throw new Error("目标对话的空间绑定已变化，已停止保存");
    }
    if (
      binding !== undefined &&
      (binding.spaceId !== file.spaceId ||
        (binding.version === 2 && binding.chatIdentity !== target.identity))
    ) {
      throw new Error("待保存的空间绑定与目标对话不一致");
    }
    header.chat_metadata = {
      ...metadata,
      steMemoryMirror: file,
      ...(binding ? { steMemory: binding } : {}),
    };
    const result = await this.#post(
      target.kind === "group" ? "/api/chats/group/save" : "/api/chats/save",
      {
        ...targetRequest(target),
        chat,
      },
    );
    if (!isObject(result) || result.ok !== true) throw new Error("宿主未确认聊天文件保存成功");
    this.#afterWrite(target, file, binding);
  }

  async #readChat(target: ChatFileTarget): Promise<Record<string, unknown>[]> {
    const value = await this.#post(
      target.kind === "group" ? "/api/chats/group/get" : "/api/chats/get",
      targetRequest(target),
    );
    // ST 缺文件/读取异常可能返回 {} 或 []，不能将它们当作空聊天再保存。
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !isObject(value[0]) ||
      !isObject(value[0].chat_metadata) ||
      !value.every(isObject)
    ) {
      throw new Error("目标聊天文件不存在、读取失败或格式无法识别，未写入任何内容");
    }
    if (!value.slice(1).every((message) => typeof message.mes === "string")) {
      throw new Error("目标聊天文件包含无法识别的消息，未写入任何内容");
    }
    return value;
  }

  async #post(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const csrf = await this.#fetch("/csrf-token");
    if (!csrf.ok) throw new Error(`无法获取聊天保存凭证 (${csrf.status})`);
    const credentials: unknown = await csrf.json();
    if (!isObject(credentials) || typeof credentials.token !== "string")
      throw new Error("聊天保存凭证格式无法识别");
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credentials.token !== "disabled" ? { "X-CSRF-Token": credentials.token } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`聊天文件请求失败 (${response.status})`);
    const result: unknown = await response.json();
    if (isObject(result) && result.error)
      throw new Error(`聊天文件请求失败: ${String(result.error)}`);
    return result;
  }
}

function targetRequest(target: ChatFileTarget): Record<string, unknown> {
  return target.kind === "group"
    ? { id: target.chatId }
    : { avatar_url: target.avatarUrl, file_name: target.chatId };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
