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
    key TEXT NOT NULL,
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
    key TEXT NOT NULL,
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

const CREATE_MIGRATED_MEMORY_TABLES_TABLE = CREATE_MEMORY_TABLES_TABLE.replace(
  "memory_tables (",
  "memory_tables_migrated (",
).replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE");

const CREATE_MIGRATED_MEMORY_FIELDS_TABLE = CREATE_MEMORY_FIELDS_TABLE.replace(
  "memory_fields (",
  "memory_fields_migrated (",
).replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE");

const CREATE_MEMORY_RECORDS_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    memory_space_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    display_text TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK (json_valid(source_json)),
    revision_id TEXT NOT NULL,
    revision_source TEXT NOT NULL CHECK (revision_source IN ('agent', 'user')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE
  ) STRICT
`;

const CREATE_MEMORY_RECORD_HISTORY_TABLE = `
  CREATE TABLE IF NOT EXISTS memory_record_history (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL,
    memory_space_id TEXT NOT NULL,
    table_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    display_text TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK (json_valid(source_json)),
    previous_revision_id TEXT NOT NULL,
    previous_revision_source TEXT NOT NULL CHECK (previous_revision_source IN ('agent', 'user')),
    revision_id TEXT NOT NULL,
    revision_source TEXT NOT NULL CHECK (revision_source IN ('agent', 'user')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE
  ) STRICT
`;

export function migrateCoreDatabase(databaseUrl: string): void {
  const database = openSqliteDatabase(databaseUrl);
  try {
    database.exec(CREATE_MIGRATIONS_TABLE);
    database.exec(CREATE_MEMORY_SPACES_TABLE);
    database.exec(CREATE_MEMORY_TABLES_TABLE);
    const existingTableColumns = database.prepare("PRAGMA table_info(memory_tables)").all();
    if (!existingTableColumns.some((column) => column.name === "display_strategy")) {
      database.exec("ALTER TABLE memory_tables ADD COLUMN display_strategy TEXT");
    }
    database.exec(CREATE_MEMORY_FIELDS_TABLE);
    migrateDefinitionKeys(database);
    database.exec(CREATE_MEMORY_RECORDS_TABLE);
    database.exec(CREATE_MEMORY_RECORD_HISTORY_TABLE);
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_tables_space_id ON memory_tables(memory_space_id, id)",
    );
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS memory_tables_space_key ON memory_tables(memory_space_id, key)",
    );
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_fields_table_id ON memory_fields(memory_space_id, table_id, position, id)",
    );
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS memory_fields_table_key ON memory_fields(memory_space_id, table_id, key)",
    );
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_records_table_id ON memory_records(memory_space_id, table_id, created_at, id)",
    );
    database.exec(
      "CREATE INDEX IF NOT EXISTS memory_record_history_filters ON memory_record_history(memory_space_id, table_id, record_id, revision_id, archived_at)",
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
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (4, ?)")
      .run(new Date().toISOString());
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (5, ?)")
      .run(new Date().toISOString());
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (6, ?)")
      .run(new Date().toISOString());
    database
      .prepare("INSERT OR IGNORE INTO core_migrations (version, applied_at) VALUES (7, ?)")
      .run(new Date().toISOString());
  } finally {
    database.close();
  }
}

function migrateDefinitionKeys(database: ReturnType<typeof openSqliteDatabase>): void {
  const tableColumns = database.prepare("PRAGMA table_info(memory_tables)").all();
  const fieldColumns = database.prepare("PRAGMA table_info(memory_fields)").all();
  const tableHasKey = tableColumns.some((column) => column.name === "key");
  const tableHasSystemKey = tableColumns.some((column) => column.name === "system_key");
  const fieldHasKey = fieldColumns.some((column) => column.name === "key");
  if (tableHasKey && !tableHasSystemKey && fieldHasKey) return;

  const tableKeyExpression = tableHasKey
    ? "key"
    : tableHasSystemKey
      ? "COALESCE(system_key, id)"
      : "id";
  const fieldKeyExpression = fieldHasKey ? "key" : "id";
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(CREATE_MIGRATED_MEMORY_TABLES_TABLE);
    database.exec(CREATE_MIGRATED_MEMORY_FIELDS_TABLE);
    database.exec(`INSERT INTO memory_tables_migrated (
      id, memory_space_id, key, kind, name, description, prompt, enabled,
      display_strategy, created_at, updated_at
    ) SELECT
      id, memory_space_id, ${tableKeyExpression}, kind, name, description, prompt, enabled,
      display_strategy, created_at, updated_at
    FROM memory_tables`);
    database.exec(`INSERT INTO memory_fields_migrated (
      id, memory_space_id, table_id, key, name, type, required, prompt, enabled, position,
      options_json, reference_table_id, created_at, updated_at
    ) SELECT
      id, memory_space_id, table_id, ${fieldKeyExpression}, name, type, required, prompt, enabled,
      position, options_json, reference_table_id, created_at, updated_at
    FROM memory_fields`);
    database.exec("DROP TABLE memory_fields");
    database.exec("DROP TABLE memory_tables");
    database.exec("ALTER TABLE memory_tables_migrated RENAME TO memory_tables");
    database.exec("ALTER TABLE memory_fields_migrated RENAME TO memory_fields");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
