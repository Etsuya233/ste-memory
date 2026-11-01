import type {
  ChatFileTarget,
  ChatMirrorFile,
  ChatSnapshotFileStore,
} from "../../features/chat-mirror/index.ts";
import type { ChatSpaceBinding } from "../../features/chat-binding/chat-space-manager.ts";
import { chatIdentityKey } from "../../features/chat-binding/chat-space-manager.ts";
import { createInProcessSqliteMemoryClient } from "../sqlite/node-client.ts";
import {
  CHAT_METADATA_BINDING_KEY,
  CHAT_METADATA_MIRROR_KEY,
  StChatAdapter,
  type StContext,
} from "../sillytavern/chat-adapter.ts";

/** 组合根集成测试使用真实 SQLite，仅将宿主文件网络替换为显式内存文件端口。 */
export function createRuntimeTestPorts(getContext: () => unknown) {
  const files = new Map<string, ChatMirrorFile>();
  const bindings = new Map<string, ChatSpaceBinding>();
  const writes: { target: ChatFileTarget; file: ChatMirrorFile }[] = [];
  const context = () => getContext() as StContext;
  const adapter = new StChatAdapter(context);
  const snapshotFiles: ChatSnapshotFileStore = {
    async read(target) {
      if (chatIdentityKey(adapter.getChatSnapshot()) === target.identity) {
        return structuredClone(context().chatMetadata?.[CHAT_METADATA_MIRROR_KEY]);
      }
      return structuredClone(files.get(target.identity));
    },
    async submit(target, file, binding: ChatSpaceBinding) {
      snapshotFiles.restore(target, file, binding);
      if (chatIdentityKey(adapter.getChatSnapshot()) !== target.identity) {
        throw new Error("聊天已切换");
      }
      bindings.set(target.identity, structuredClone(binding));
      const captured = structuredClone(file);
      files.set(target.identity, captured);
      writes.push({ target: { ...target }, file: captured });
    },
    async verify(target) {
      return {
        steMemory: structuredClone(bindings.get(target.identity)),
        steMemoryMirror: structuredClone(files.get(target.identity)),
      };
    },
    restore(target, file, binding) {
      const captured = structuredClone(file);
      if (chatIdentityKey(adapter.getChatSnapshot()) !== target.identity) {
        throw new Error("聊天已切换");
      }
      const metadata = context().chatMetadata!;
      metadata[CHAT_METADATA_MIRROR_KEY] = captured;
      if (binding) {
        metadata[CHAT_METADATA_BINDING_KEY] = structuredClone(binding);
      }
    },
  };
  return { createSqlite: createInProcessSqliteMemoryClient, snapshotFiles, snapshotWrites: writes };
}
