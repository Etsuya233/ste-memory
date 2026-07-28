import type { MemorySpaceId } from "@ste-memory/core";
import type { MemorySpaceService } from "@ste-memory/core";
import { parseSillyTavernJsonl } from "../source-store/jsonl-parser.ts";
import type { SqliteSourceChatRepository } from "../source-store/repository.ts";
import type { CreateMemorySpaceInput, MemorySpaceManager, MemorySpaceView } from "./types.ts";
import { InvalidChatFileError } from "./types.ts";

export class DefaultMemorySpaceManager implements MemorySpaceManager {
  private readonly spaces: MemorySpaceService;
  private readonly sourceChats: SqliteSourceChatRepository;

  constructor(spaces: MemorySpaceService, sourceChats: SqliteSourceChatRepository) {
    this.spaces = spaces;
    this.sourceChats = sourceChats;
  }

  create(input: CreateMemorySpaceInput): MemorySpaceView {
    if (!input.filename.toLowerCase().endsWith(".jsonl")) {
      throw new InvalidChatFileError("必须上传 .jsonl 文件");
    }
    const chat = parseSillyTavernJsonl(input.content);
    if (chat.messages.length === 0) {
      throw new InvalidChatFileError("文件中没有可导入的聊天消息", chat.errors);
    }

    const memorySpace = this.spaces.create(input.name);
    try {
      this.sourceChats.create(memorySpace.id, chat);
    } catch (error) {
      this.spaces.delete(memorySpace.id);
      throw error;
    }
    return { ...memorySpace, messageCount: chat.messages.length, errorCount: chat.errors.length };
  }

  delete(id: MemorySpaceId): boolean {
    if (!this.spaces.find(id)) return false;
    this.sourceChats.delete(id);
    return this.spaces.delete(id);
  }

  errors(id: MemorySpaceId) {
    if (!this.spaces.find(id)) return undefined;
    return this.sourceChats.errors(id);
  }

  exists(id: MemorySpaceId): boolean {
    return this.spaces.find(id) !== undefined;
  }

  list(): MemorySpaceView[] {
    return this.spaces.list().map((space) => ({ ...space, ...this.sourceChats.summary(space.id) }));
  }

  messages(id: MemorySpaceId) {
    if (!this.spaces.find(id)) return undefined;
    return this.sourceChats.messages(id);
  }

  rename(id: MemorySpaceId, name: string): MemorySpaceView | undefined {
    const memorySpace = this.spaces.rename(id, name);
    return memorySpace ? { ...memorySpace, ...this.sourceChats.summary(id) } : undefined;
  }
}
