import type { MemorySpaceId } from "@ste-memory/core";
import type { MemorySpaceService } from "@ste-memory/core";
import type { UnitOfWork } from "@ste-memory/tools";
import { parseSillyTavernJsonl } from "../source-store/jsonl-parser.ts";
import type { SourceChatRepository } from "../source-store/types.ts";
import type { CreateMemorySpaceInput, MemorySpaceManager, MemorySpaceView } from "./types.ts";
import { InvalidChatFileError } from "./types.ts";
import type { SystemMemoryTableInstaller } from "../system-memory/system-memory-table-definitions.ts";

export class DefaultMemorySpaceManager implements MemorySpaceManager {
  private readonly spaces: MemorySpaceService;
  private readonly systemTables: SystemMemoryTableInstaller;
  private readonly sourceChats: SourceChatRepository;
  private readonly unitOfWork: UnitOfWork;

  constructor(
    spaces: MemorySpaceService,
    systemTables: SystemMemoryTableInstaller,
    sourceChats: SourceChatRepository,
    unitOfWork: UnitOfWork,
  ) {
    this.spaces = spaces;
    this.systemTables = systemTables;
    this.sourceChats = sourceChats;
    this.unitOfWork = unitOfWork;
  }

  async create(input: CreateMemorySpaceInput): Promise<MemorySpaceView> {
    if (!input.filename.toLowerCase().endsWith(".jsonl")) {
      throw new InvalidChatFileError("必须上传 .jsonl 文件");
    }
    const chat = parseSillyTavernJsonl(input.content);
    if (chat.messages.length === 0) {
      throw new InvalidChatFileError("文件中没有可导入的聊天消息", chat.errors);
    }

    return this.unitOfWork.run(async () => {
      const memorySpace = await this.spaces.create(input.name);
      await this.systemTables.install(memorySpace.id);
      await this.sourceChats.create(memorySpace.id, chat);
      return { ...memorySpace, messageCount: chat.messages.length, errorCount: chat.errors.length };
    });
  }

  async delete(id: MemorySpaceId): Promise<boolean> {
    if (!(await this.spaces.find(id))) return false;
    return this.spaces.delete(id);
  }

  async errors(id: MemorySpaceId) {
    if (!(await this.spaces.find(id))) return undefined;
    return this.sourceChats.errors(id);
  }

  async exists(id: MemorySpaceId): Promise<boolean> {
    return (await this.spaces.find(id)) !== undefined;
  }

  async list(): Promise<MemorySpaceView[]> {
    const spaces = await this.spaces.list();
    return Promise.all(
      spaces.map(async (space) => ({ ...space, ...(await this.sourceChats.summary(space.id)) })),
    );
  }

  async messages(id: MemorySpaceId) {
    if (!(await this.spaces.find(id))) return undefined;
    return this.sourceChats.messages(id);
  }

  async rename(id: MemorySpaceId, name: string): Promise<MemorySpaceView | undefined> {
    const memorySpace = await this.spaces.rename(id, name);
    return memorySpace ? { ...memorySpace, ...(await this.sourceChats.summary(id)) } : undefined;
  }
}
