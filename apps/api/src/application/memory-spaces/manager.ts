import type { MemorySpaceId, MemorySpaceUseCases } from "@ste-memory/core/memory";
import type { UnitOfWork } from "@ste-memory/tools";
import type { SourceChatRepository } from "../ports/source-chat.ts";
import type {
  CreateMemorySpaceInput,
  MemorySpaceManager,
  MemorySpaceView,
} from "../ports/memory-space.ts";
import type { SystemMemoryTableInstaller } from "../system-memory/system-memory-table-definitions.ts";

export class DefaultMemorySpaceManager implements MemorySpaceManager {
  private readonly spaces: MemorySpaceUseCases;
  private readonly systemTables: SystemMemoryTableInstaller;
  private readonly sourceChats: SourceChatRepository;
  private readonly unitOfWork: UnitOfWork;

  constructor(
    spaces: MemorySpaceUseCases,
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
    return this.unitOfWork.run(async () => {
      const memorySpace = await this.spaces.create(input.name);
      await this.systemTables.install(memorySpace.id);
      await this.sourceChats.create(memorySpace.id, input.chat);
      return {
        ...memorySpace,
        messageCount: input.chat.messages.length,
        errorCount: input.chat.errors.length,
      };
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
