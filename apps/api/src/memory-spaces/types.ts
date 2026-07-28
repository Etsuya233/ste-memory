import type { MemorySpace, MemorySpaceId } from "@ste-memory/core";
import type { SourceMessage, SourceParseError } from "../source-store/types.ts";

export interface MemorySpaceView extends MemorySpace {
  readonly messageCount: number;
  readonly errorCount: number;
}

export interface CreateMemorySpaceInput {
  readonly name: string;
  readonly filename: string;
  readonly content: string;
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

export class InvalidChatFileError extends Error {
  readonly errors: readonly SourceParseError[];

  constructor(message: string, errors: readonly SourceParseError[] = []) {
    super(message);
    this.errors = errors;
  }
}
