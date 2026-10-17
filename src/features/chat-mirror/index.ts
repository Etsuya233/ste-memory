/** 对话文件镜像模块出口（ADR 0023）：信封 + 编解码纯函数（忽略语义）。 */
export {
  CHAT_MIRROR_FORMAT,
  CHAT_MIRROR_VERSION,
  chatMirrorFileSchema,
} from "./chat-mirror-file.ts";
export type { ChatMirrorFile } from "./chat-mirror-file.ts";
export { createChatMirrorFile, decodeChatMirrorFile } from "./chat-mirror-codec.ts";
