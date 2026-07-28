import type { MemorySpaceId } from "@ste-memory/core";
import type { UnitOfWork } from "@ste-memory/tools";
import type { DatabaseContext } from "../database/database-context.ts";
import { SILLY_TAVERN_SOURCE_TYPE } from "./types.ts";
import type {
  ParsedChat,
  SourceChatRepository,
  SourceChatSummary,
  SourceMessage,
  SourceParseError,
} from "./types.ts";

const INSERT_BATCH_SIZE = 500;

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
    return rows.map((message) => ({
      source_type: SILLY_TAVERN_SOURCE_TYPE,
      source_id: message.source_id,
      content: message.content,
      extraProps: JSON.parse(message.extra_props_json) as Record<string, unknown>,
    }));
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
