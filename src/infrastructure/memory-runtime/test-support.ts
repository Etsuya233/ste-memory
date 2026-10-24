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
    async write(target, file, binding?: ChatSpaceBinding) {
      const captured = structuredClone(file);
      files.set(target.identity, captured);
      writes.push({ target: { ...target }, file: captured });
      if (chatIdentityKey(adapter.getChatSnapshot()) !== target.identity) return;
      const metadata = context().chatMetadata!;
      metadata[CHAT_METADATA_MIRROR_KEY] = captured;
      if (binding) metadata[CHAT_METADATA_BINDING_KEY] = structuredClone(binding);
    },
  };
  return { createSqlite: createInProcessSqliteMemoryClient, snapshotFiles, snapshotWrites: writes };
}
