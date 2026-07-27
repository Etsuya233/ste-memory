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
  create(input: CreateMemorySpaceInput): MemorySpaceView;
  delete(id: MemorySpaceId): boolean;
  errors(id: MemorySpaceId): readonly SourceParseError[] | undefined;
  list(): readonly MemorySpaceView[];
  messages(id: MemorySpaceId): readonly SourceMessage[] | undefined;
  rename(id: MemorySpaceId, name: string): MemorySpaceView | undefined;
}

export class InvalidChatFileError extends Error {
  readonly errors: readonly SourceParseError[];

  constructor(message: string, errors: readonly SourceParseError[] = []) {
    super(message);
    this.errors = errors;
  }
}
