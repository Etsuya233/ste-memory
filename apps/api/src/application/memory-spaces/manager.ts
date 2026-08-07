import type { MemorySpaceId, MemorySpaceUseCases } from "@ste-memory/core/memory";
import type { UnitOfWork } from "@ste-memory/tools";
import type { SourceChatRepository } from "../ports/source-chat.ts";
import type { CleaningRuleRepository } from "../ports/cleaning-rule.ts";
import { applyCleaningRules } from "../cleaning-rules/transform.ts";
import type {
  CreateMemorySpaceInput,
  MemorySpaceManager,
  MemorySpaceView,
  MessageReadOptions,
} from "../ports/memory-space.ts";
import type { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";

export class DefaultMemorySpaceManager implements MemorySpaceManager {
  private readonly spaces: MemorySpaceUseCases;
  private readonly systemTables: SystemMemoryTableInstaller;
  private readonly sourceChats: SourceChatRepository;
  private readonly cleaningRules: CleaningRuleRepository;
  private readonly unitOfWork: UnitOfWork;

  constructor(
    spaces: MemorySpaceUseCases,
    systemTables: SystemMemoryTableInstaller,
    sourceChats: SourceChatRepository,
    cleaningRules: CleaningRuleRepository,
    unitOfWork: UnitOfWork,
  ) {
    this.spaces = spaces;
    this.systemTables = systemTables;
    this.sourceChats = sourceChats;
    this.cleaningRules = cleaningRules;
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

  async messages(id: MemorySpaceId, options: MessageReadOptions = {}) {
    if (!(await this.spaces.find(id))) return undefined;
    const messages = await this.sourceChats.messages(id);
    const limited = options.limit !== undefined ? messages.slice(0, options.limit) : messages;
    // 预览（raw）不需要规则：跳过查询。
    if (options.raw) return limited;
    const rules = await this.cleaningRules.list(id);
    return limited.map((message) => ({
      ...message,
      content: applyCleaningRules(message.content, rules),
    }));
  }

  async rename(id: MemorySpaceId, name: string): Promise<MemorySpaceView | undefined> {
    const memorySpace = await this.spaces.rename(id, name);
    return memorySpace ? { ...memorySpace, ...(await this.sourceChats.summary(id)) } : undefined;
  }
}
