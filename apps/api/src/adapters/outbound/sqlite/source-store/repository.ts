import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { UnitOfWork } from "@ste-memory/tools";
import type { DatabaseContext } from "../database/database-context.ts";
import { SILLY_TAVERN_SOURCE_TYPE } from "../../../../application/ports/source-chat.ts";
import type {
  ParsedChat,
  SourceChatRepository,
  SourceChatSummary,
  SourceMessage,
  SourceMessageStatus,
  SourceParseError,
} from "../../../../application/ports/source-chat.ts";

const INSERT_BATCH_SIZE = 500;

function toSourceMessage(message: {
  readonly source_id: number;
  readonly content: string;
  readonly extra_props_json: string;
}): SourceMessage {
  return {
    source_type: SILLY_TAVERN_SOURCE_TYPE,
    source_id: message.source_id,
    content: message.content,
    extraProps: JSON.parse(message.extra_props_json) as Record<string, unknown>,
  };
}

export class KyselySourceChatRepository implements SourceChatRepository {
  readonly #context: DatabaseContext;
  readonly #unitOfWork: UnitOfWork;

  constructor(context: DatabaseContext, unitOfWork: UnitOfWork) {
    this.#context = context;
    this.#unitOfWork = unitOfWork;
  }

  async create(memorySpaceId: MemorySpaceId, chat: ParsedChat): Promise<void> {
    await this.#unitOfWork.run(async () => {
      await this.#context.database
        .insertInto("source_store_chats")
        .values({
          memory_space_id: memorySpaceId,
          source_type: SILLY_TAVERN_SOURCE_TYPE,
          metadata_json: JSON.stringify(chat.metadata),
          created_at: new Date().toISOString(),
        })
        .execute();
      for (let offset = 0; offset < chat.messages.length; offset += INSERT_BATCH_SIZE) {
        const messages = chat.messages.slice(offset, offset + INSERT_BATCH_SIZE);
        await this.#context.database
          .insertInto("source_store_messages")
          .values(
            messages.map((message) => ({
              memory_space_id: memorySpaceId,
              source_id: message.source_id,
              content: message.content,
              extra_props_json: JSON.stringify(message.extraProps),
              status: "untracked",
            })),
          )
          .execute();
      }
      for (let offset = 0; offset < chat.errors.length; offset += INSERT_BATCH_SIZE) {
        const errors = chat.errors.slice(offset, offset + INSERT_BATCH_SIZE);
        await this.#context.database
          .insertInto("source_store_parse_errors")
          .values(
            errors.map((error) => ({
              memory_space_id: memorySpaceId,
              line_number: error.lineNumber,
              raw_line: error.rawLine,
              message: error.message,
            })),
          )
          .execute();
      }
    });
  }

  async messages(memorySpaceId: MemorySpaceId): Promise<SourceMessage[]> {
    const rows = await this.#context.database
      .selectFrom("source_store_messages")
      .select(["source_id", "content", "extra_props_json"])
      .where("memory_space_id", "=", memorySpaceId)
      .orderBy("source_id")
      .execute();
    return rows.map(toSourceMessage);
  }

  async messagesInRange(
    memorySpaceId: MemorySpaceId,
    from: number,
    to: number,
  ): Promise<SourceMessage[]> {
    const rows = await this.#context.database
      .selectFrom("source_store_messages")
      .select(["source_id", "content", "extra_props_json"])
      .where("memory_space_id", "=", memorySpaceId)
      .where("source_id", ">=", from)
      .where("source_id", "<=", to)
      .orderBy("source_id")
      .execute();
    return rows.map(toSourceMessage);
  }

  async markProcessed(memorySpaceId: MemorySpaceId, sourceIds: readonly number[]): Promise<void> {
    await this.#updateStatus(memorySpaceId, sourceIds, "processed");
  }

  async markError(memorySpaceId: MemorySpaceId, sourceIds: readonly number[]): Promise<void> {
    await this.#updateStatus(memorySpaceId, sourceIds, "error");
  }

  async #updateStatus(
    memorySpaceId: MemorySpaceId,
    sourceIds: readonly number[],
    status: "processed" | "error",
  ): Promise<void> {
    if (sourceIds.length === 0) return;
    await this.#context.database
      .updateTable("source_store_messages")
      .set({ status })
      .where("memory_space_id", "=", memorySpaceId)
      .where("source_id", "in", [...sourceIds])
      .execute();
  }

  async errors(memorySpaceId: MemorySpaceId): Promise<SourceParseError[]> {
    const rows = await this.#context.database
      .selectFrom("source_store_parse_errors")
      .select(["line_number", "raw_line", "message"])
      .where("memory_space_id", "=", memorySpaceId)
      .orderBy("line_number")
      .execute();
    return rows.map((error) => ({
      lineNumber: error.line_number,
      rawLine: error.raw_line,
      message: error.message,
    }));
  }

  async messageStatuses(memorySpaceId: MemorySpaceId): Promise<SourceMessageStatus[]> {
    const rows = await this.#context.database
      .selectFrom("source_store_messages")
      .select(["source_id", "status"])
      .where("memory_space_id", "=", memorySpaceId)
      .orderBy("source_id")
      .execute();
    return rows.map((row) => ({
      sourceId: row.source_id,
      status: row.status,
    }));
  }

  async processedCount(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<number> {
    const row = await this.#context.database
      .selectFrom("source_store_messages")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("memory_space_id", "=", memorySpaceId)
      .where("source_id", ">=", from)
      .where("source_id", "<=", to)
      .where("status", "=", "processed")
      .executeTakeFirstOrThrow();
    return row.count;
  }

  async summary(memorySpaceId: MemorySpaceId): Promise<SourceChatSummary> {
    const [messages, errors] = await Promise.all([
      this.#context.database
        .selectFrom("source_store_messages")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("memory_space_id", "=", memorySpaceId)
        .executeTakeFirstOrThrow(),
      this.#context.database
        .selectFrom("source_store_parse_errors")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("memory_space_id", "=", memorySpaceId)
        .executeTakeFirstOrThrow(),
    ]);
    return { messageCount: messages.count, errorCount: errors.count };
  }
}
