import type { MemorySpaceId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import type { DatabaseContext } from "../src/adapters/outbound/sqlite/database/database-context.ts";
import { parseSillyTavernJsonl } from "../src/adapters/inbound/sillytavern-jsonl/parser.ts";
import { DefaultMemorySpaceManager } from "../src/application/memory-spaces/manager.ts";
import { KyselySourceChatRepository } from "../src/adapters/outbound/sqlite/source-store/repository.ts";
import { SILLY_TAVERN_SOURCE_TYPE } from "../src/application/ports/source-chat.ts";
import type {
  ParsedChat,
  SourceChatRepository,
  SourceChatSummary,
  SourceMessage,
  SourceMessageStatus,
  SourceParseError,
} from "../src/application/ports/source-chat.ts";
import { createTestApplication } from "./test-application.ts";

const now = "2026-07-28T00:00:00.000Z";

describe("KyselyUnitOfWork", () => {
  it("commits successful operations and restores the root executor", async () => {
    const app = await createTestApplication("ste-memory-uow-commit-", now);
    const root = app.context.database;
    try {
      await app.unitOfWork.run(async () => {
        expect(app.context.database).not.toBe(root);
        await app.context.database
          .insertInto("memory_spaces")
          .values({
            id: "committed",
            name: "会话",
            created_at: now,
            updated_at: now,
          })
          .execute();
      });
      expect(app.context.database).toBe(root);
      await expect(app.spaceRepository.find("committed" as MemorySpaceId)).resolves.toBeDefined();
    } finally {
      await app.server.close();
    }
  });

  it("rolls back writes and restores the root executor when an operation fails", async () => {
    const app = await createTestApplication("ste-memory-uow-rollback-", now);
    const root = app.context.database;
    try {
      await expect(
        app.unitOfWork.run(async () => {
          await app.context.database
            .insertInto("memory_spaces")
            .values({
              id: "rolled-back",
              name: "会话",
              created_at: now,
              updated_at: now,
            })
            .execute();
          throw new Error("stop transaction");
        }),
      ).rejects.toThrow("stop transaction");
      expect(app.context.database).toBe(root);
      await expect(
        app.spaceRepository.find("rolled-back" as MemorySpaceId),
      ).resolves.toBeUndefined();
    } finally {
      await app.server.close();
    }
  });

  it("joins nested operations and leaves failure handling to the outer operation", async () => {
    const app = await createTestApplication("ste-memory-uow-nested-", now);
    try {
      await app.unitOfWork.run(async () => {
        const transaction = app.context.database;
        try {
          await app.unitOfWork.run(async () => {
            expect(app.context.database).toBe(transaction);
            await app.context.database
              .insertInto("memory_spaces")
              .values({
                id: "inner",
                name: "内部",
                created_at: now,
                updated_at: now,
              })
              .execute();
            throw new Error("handled by outer operation");
          });
        } catch (error) {
          expect(error).toEqual(new Error("handled by outer operation"));
        }
        await app.context.database
          .insertInto("memory_spaces")
          .values({
            id: "outer",
            name: "外部",
            created_at: now,
            updated_at: now,
          })
          .execute();
      });
      await expect(app.spaceRepository.find("inner" as MemorySpaceId)).resolves.toBeDefined();
      await expect(app.spaceRepository.find("outer" as MemorySpaceId)).resolves.toBeDefined();
    } finally {
      await app.server.close();
    }
  });

  it("rolls back space definitions and source rows when source import fails", async () => {
    const app = await createTestApplication("ste-memory-uow-space-", now);
    const sourceChats = new FailingSourceChatRepository(app.context);
    const manager = new DefaultMemorySpaceManager(
      app.spaces,
      app.systemTables,
      sourceChats,
      app.cleaningRuleRepository,
      app.unitOfWork,
    );
    try {
      await expect(
        manager.create({
          name: "会话",
          chat: parseSillyTavernJsonl(
            [
              '{"name":"Alice","is_user":true,"send_date":"2026-07-28T00:00:00.000Z","mes":"hello"}',
              "invalid json",
            ].join("\n"),
          ),
        }),
      ).rejects.toThrow("source import failed");
      for (const table of [
        "memory_spaces",
        "memory_tables",
        "memory_fields",
        "source_store_chats",
        "source_store_messages",
        "source_store_parse_errors",
      ] as const) {
        const row = await app.context.database
          .selectFrom(table)
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow();
        expect(row.count).toBe(0);
      }
    } finally {
      await app.server.close();
    }
  });

  it("imports chats larger than SQLite's bind-variable limit in bounded batches", async () => {
    const app = await createTestApplication("ste-memory-uow-large-chat-", now);
    const repository = new KyselySourceChatRepository(app.context, app.unitOfWork);
    const memorySpaceId = "large-chat" as MemorySpaceId;
    const messages = Array.from({ length: 8_200 }, (_, index) => ({
      source_type: SILLY_TAVERN_SOURCE_TYPE,
      source_id: index + 1,
      content: `message-${index + 1}`,
      extraProps: {},
    }));
    try {
      await app.spaceRepository.create({
        id: memorySpaceId,
        name: "长会话",
        createdAt: now,
        updatedAt: now,
      });
      await repository.create(memorySpaceId, { metadata: {}, messages, errors: [] });
      await expect(repository.summary(memorySpaceId)).resolves.toEqual({
        messageCount: 8_200,
        errorCount: 0,
      });
    } finally {
      await app.server.close();
    }
  });
});

class FailingSourceChatRepository implements SourceChatRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  async create(memorySpaceId: MemorySpaceId, chat: ParsedChat): Promise<void> {
    await this.#context.database
      .insertInto("source_store_chats")
      .values({
        memory_space_id: memorySpaceId,
        source_type: SILLY_TAVERN_SOURCE_TYPE,
        metadata_json: JSON.stringify(chat.metadata),
        created_at: now,
      })
      .execute();
    await this.#context.database
      .insertInto("source_store_messages")
      .values({
        memory_space_id: memorySpaceId,
        source_id: chat.messages[0]!.source_id,
        content: chat.messages[0]!.content,
        extra_props_json: JSON.stringify(chat.messages[0]!.extraProps),
        status: "untracked",
      })
      .execute();
    await this.#context.database
      .insertInto("source_store_parse_errors")
      .values({
        memory_space_id: memorySpaceId,
        line_number: chat.errors[0]!.lineNumber,
        raw_line: chat.errors[0]!.rawLine,
        message: chat.errors[0]!.message,
      })
      .execute();
    throw new Error("source import failed");
  }

  async messages(_memorySpaceId: MemorySpaceId): Promise<SourceMessage[]> {
    return [];
  }
  async messagesInRange(
    _memorySpaceId: MemorySpaceId,
    _from: number,
    _to: number,
  ): Promise<SourceMessage[]> {
    return [];
  }
  async markProcessed(
    _memorySpaceId: MemorySpaceId,
    _sourceIds: readonly number[],
  ): Promise<void> {}
  async markError(_memorySpaceId: MemorySpaceId, _sourceIds: readonly number[]): Promise<void> {}
  async messageStatuses(_memorySpaceId: MemorySpaceId): Promise<SourceMessageStatus[]> {
    return [];
  }
  async processedCount(_memorySpaceId: MemorySpaceId, _from: number, _to: number): Promise<number> {
    return 0;
  }
  async errors(_memorySpaceId: MemorySpaceId): Promise<SourceParseError[]> {
    return [];
  }
  async summary(_memorySpaceId: MemorySpaceId): Promise<SourceChatSummary> {
    return { messageCount: 0, errorCount: 0 };
  }
}
