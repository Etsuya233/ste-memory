import { openSqliteDatabase } from "./database.ts";

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS core_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT
`;

const CREATE_MEMORY_SPACES_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT
`;

const CREATE_MEMORY_TABLES_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_tables (
    id TEXT PRIMARY KEY,
    memory_space_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('custom', 'system')),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    display_strategy TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
  ) STRICT
`;

const CREATE_MEMORY_FIELDS_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_fields (
    id TEXT PRIMARY KEY,
    memory_space_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    options_json TEXT NOT NULL,
    reference_table_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE,
    FOREIGN KEY (reference_table_id) REFERENCES memory_tables(id) ON DELETE RESTRICT
  ) STRICT
`;

export function migrateCoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
    database.exec(CREATE_MEMORY_SPACES_TABLE);
    database.exec(CREATE_MEMORY_TABLES_TABLE);
    const tableColumns = database.prepare("PRAGMA table_info(memory_tables)").all();
    if (!tableColumns.some((column) => column.name === "display_strategy")) {
      database.exec("ALTER TABLE memory_tables ADD COLUMN display_strategy TEXT");
    }
    database.exec(CREATE_MEMORY_FIELDS_TABLE);
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_tables_space_id ON memory_tables(memory_space_id, id)",
    );
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_fields_table_id ON memory_fields(memory_space_id, table_id, position, id)",
    );
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (2, ?)")
      .run(new Date().toISOString());
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (3, ?)")
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}
