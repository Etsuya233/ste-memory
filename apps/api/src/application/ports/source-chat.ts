import type { MemorySpaceId } from "@ste-memory/core/memory";

export const SILLY_TAVERN_SOURCE_TYPE = "sillytavern_jsonl" as const;

export interface SourceMessage {
  readonly source_type: typeof SILLY_TAVERN_SOURCE_TYPE;
  readonly source_id: number;
  readonly content: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export interface SourceParseError {
  readonly lineNumber: number;
  readonly rawLine: string;
  readonly message: string;
}

export interface ParsedChat {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
}

export interface SourceChatSummary {
  readonly messageCount: number;
  readonly errorCount: number;
}

export interface SourceChatRepository {
  create(memorySpaceId: MemorySpaceId, chat: ParsedChat): Promise<void>;
  messages(memorySpaceId: MemorySpaceId): Promise<SourceMessage[]>;
  /** 闭区间 [from, to] 内的消息（按 source_id 升序），供填表任务分块处理。 */
  messagesInRange(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<SourceMessage[]>;
  errors(memorySpaceId: MemorySpaceId): Promise<SourceParseError[]>;
  summary(memorySpaceId: MemorySpaceId): Promise<SourceChatSummary>;
  /** 把一批消息标记为已填表（与批次提交同一事务，失败回滚不产生半批状态）。 */
  markProcessed(memorySpaceId: MemorySpaceId, sourceIds: readonly number[]): Promise<void>;
  /** 把出错批的消息标记为 error（最后一次运行出错的消息，可重试）。 */
  markError(memorySpaceId: MemorySpaceId, sourceIds: readonly number[]): Promise<void>;
  /** 闭区间 [from, to] 内已标记 processed 的消息数（填表任务轮询进度）。 */
  processedCount(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<number>;
}
