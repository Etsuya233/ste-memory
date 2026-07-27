import type { MemorySpaceId } from "@ste-memory/core";
import { openSqliteDatabase } from "@ste-memory/core-sqlite/database";
import { SILLY_TAVERN_SOURCE_TYPE } from "./types.ts";
import type { ParsedChat, SourceChatSummary, SourceMessage, SourceParseError } from "./types.ts";

interface MessageRow {
  readonly source_id: number;
  readonly content: string;
  readonly extra_props_json: string;
}

interface ErrorRow {
  readonly line_number: number;
  readonly raw_line: string;
  readonly message: string;
}

export class SqliteSourceChatRepository {
  private readonly databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  create(memorySpaceId: MemorySpaceId, chat: ParsedChat): void {
    const database = openSqliteDatabase(this.databaseUrl);
    database.exec("PRAGMA foreign_keys = ON");
    try {
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare(
          "INSERT INTO source_store_chats (memory_space_id, source_type, metadata_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          memorySpaceId,
          SILLY_TAVERN_SOURCE_TYPE,
          JSON.stringify(chat.metadata),
          new Date().toISOString(),
        );
      const insertMessage = database.prepare(
        "INSERT INTO source_store_messages (memory_space_id, source_id, content, extra_props_json) VALUES (?, ?, ?, ?)",
      );
      for (const message of chat.messages) {
        insertMessage.run(
          memorySpaceId,
          message.source_id,
          message.content,
          JSON.stringify(message.extraProps),
        );
      }
      const insertError = database.prepare(
        "INSERT INTO source_store_parse_errors (memory_space_id, line_number, raw_line, message) VALUES (?, ?, ?, ?)",
      );
      for (const error of chat.errors) {
        insertError.run(memorySpaceId, error.lineNumber, error.rawLine, error.message);
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  delete(memorySpaceId: MemorySpaceId): void {
    const database = openSqliteDatabase(this.databaseUrl);
    database.exec("PRAGMA foreign_keys = ON");
    try {
      database
        .prepare("DELETE FROM source_store_chats WHERE memory_space_id = ?")
        .run(memorySpaceId);
    } finally {
      database.close();
    }
  }

  messages(memorySpaceId: MemorySpaceId): SourceMessage[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare(
          "SELECT source_id, content, extra_props_json FROM source_store_messages WHERE memory_space_id = ? ORDER BY source_id",
        )
        .all(memorySpaceId)
        .map((row) => {
          const message = row as unknown as MessageRow;
          return {
            source_type: SILLY_TAVERN_SOURCE_TYPE,
            source_id: message.source_id,
            content: message.content,
            extraProps: JSON.parse(message.extra_props_json) as Record<string, unknown>,
          };
        });
    } finally {
      database.close();
    }
  }

  errors(memorySpaceId: MemorySpaceId): SourceParseError[] {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      return database
        .prepare(
          "SELECT line_number, raw_line, message FROM source_store_parse_errors WHERE memory_space_id = ? ORDER BY line_number",
        )
        .all(memorySpaceId)
        .map((row) => {
          const error = row as unknown as ErrorRow;
          return { lineNumber: error.line_number, rawLine: error.raw_line, message: error.message };
        });
    } finally {
      database.close();
    }
  }

  summary(memorySpaceId: MemorySpaceId): SourceChatSummary {
    const database = openSqliteDatabase(this.databaseUrl);
    try {
      const row = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM source_store_messages WHERE memory_space_id = ?) AS message_count,
             (SELECT COUNT(*) FROM source_store_parse_errors WHERE memory_space_id = ?) AS error_count`,
        )
        .get(memorySpaceId, memorySpaceId) as { message_count: number; error_count: number };
      return { messageCount: row.message_count, errorCount: row.error_count };
    } finally {
      database.close();
    }
  }
}
