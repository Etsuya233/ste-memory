import { openSqliteDatabase } from "@ste-memory/core-sqlite/database";

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS source_store_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

const CREATE_CHATS_TABLE = `
  CREATE TABLE IF NOT EXISTS source_store_chats (
    memory_space_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT
`;

const CREATE_MESSAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS source_store_messages (
    memory_space_id TEXT NOT NULL,
    source_id INTEGER NOT NULL CHECK (source_id > 0),
    content TEXT NOT NULL,
    extra_props_json TEXT NOT NULL,
    PRIMARY KEY (memory_space_id, source_id),
    FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
  ) STRICT
`;

const CREATE_PARSE_ERRORS_TABLE = `
  CREATE TABLE IF NOT EXISTS source_store_parse_errors (
    memory_space_id TEXT NOT NULL,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    raw_line TEXT NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (memory_space_id, line_number),
    FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
  ) STRICT
`;

export function migrateSourceStoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
    database.exec(CREATE_CHATS_TABLE);
    database.exec(CREATE_MESSAGES_TABLE);
    database.exec(CREATE_PARSE_ERRORS_TABLE);
    database
      .prepare("INSERT OR IGNORE INTO source_store_migrations (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}
