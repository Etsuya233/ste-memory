import type { MemorySpace, MemorySpaceId } from "@ste-memory/core/memory";
import type { ParsedChat, SourceMessage, SourceParseError } from "./source-chat.ts";

export interface MemorySpaceView extends MemorySpace {
  readonly messageCount: number;
  readonly errorCount: number;
}

export interface CreateMemorySpaceInput {
  readonly name: string;
  readonly chat: ParsedChat;
}

export interface MemorySpaceManager {
  create(input: CreateMemorySpaceInput): Promise<MemorySpaceView>;
  delete(id: MemorySpaceId): Promise<boolean>;
  errors(id: MemorySpaceId): Promise<readonly SourceParseError[] | undefined>;
  exists(id: MemorySpaceId): Promise<boolean>;
  list(): Promise<readonly MemorySpaceView[]>;
  messages(id: MemorySpaceId): Promise<readonly SourceMessage[] | undefined>;
  rename(id: MemorySpaceId, name: string): Promise<MemorySpaceView | undefined>;
}
