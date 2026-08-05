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

/** 消息读取选项：raw 跳过清洗规则返回原文；limit 限制条数（预览用）。 */
export interface MessageReadOptions {
  readonly raw?: boolean;
  readonly limit?: number;
}

export interface MemorySpaceManager {
  create(input: CreateMemorySpaceInput): Promise<MemorySpaceView>;
  delete(id: MemorySpaceId): Promise<boolean>;
  errors(id: MemorySpaceId): Promise<readonly SourceParseError[] | undefined>;
  exists(id: MemorySpaceId): Promise<boolean>;
  list(): Promise<readonly MemorySpaceView[]>;
  messages(
    id: MemorySpaceId,
    options?: MessageReadOptions,
  ): Promise<readonly SourceMessage[] | undefined>;
  rename(id: MemorySpaceId, name: string): Promise<MemorySpaceView | undefined>;
}
