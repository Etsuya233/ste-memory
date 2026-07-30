import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const initialMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `CREATE TABLE memory_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_tables (
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
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
      UNIQUE (memory_space_id, key)
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_fields (
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
      options_json TEXT NOT NULL CHECK (json_valid(options_json)),
      reference_table_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE,
      FOREIGN KEY (reference_table_id) REFERENCES memory_tables(id) ON DELETE RESTRICT,
      UNIQUE (memory_space_id, table_id, key)
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_records (
      id TEXT PRIMARY KEY,
      memory_space_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      field_evidence_json TEXT NOT NULL CHECK (json_valid(field_evidence_json)),
      display_text TEXT NOT NULL,
      source_json TEXT NOT NULL CHECK (json_valid(source_json)),
      revision_id TEXT NOT NULL,
      revision_source TEXT NOT NULL CHECK (revision_source IN ('agent', 'user')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (table_id) REFERENCES memory_tables(id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_record_history (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      memory_space_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      field_evidence_json TEXT NOT NULL CHECK (json_valid(field_evidence_json)),
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
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_evidence (
      memory_space_id TEXT NOT NULL,
      evidence_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      storage_mode TEXT NOT NULL CHECK (storage_mode IN ('snapshot', 'reference')),
      content TEXT,
      extra_props_json TEXT NOT NULL CHECK (json_valid(extra_props_json)),
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
      UNIQUE (memory_space_id, source_type, source_id)
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE source_store_chats (
      memory_space_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      created_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE source_store_messages (
      memory_space_id TEXT NOT NULL,
      source_id INTEGER NOT NULL CHECK (source_id > 0),
      content TEXT NOT NULL,
      extra_props_json TEXT NOT NULL CHECK (json_valid(extra_props_json)),
      PRIMARY KEY (memory_space_id, source_id),
      FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE source_store_parse_errors (
      memory_space_id TEXT NOT NULL,
      line_number INTEGER NOT NULL CHECK (line_number > 0),
      raw_line TEXT NOT NULL,
      message TEXT NOT NULL,
      PRIMARY KEY (memory_space_id, line_number),
      FOREIGN KEY (memory_space_id) REFERENCES source_store_chats(memory_space_id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw("CREATE INDEX memory_tables_space_id ON memory_tables(memory_space_id, id)")
      .execute(database);
    await sql
      .raw(
        "CREATE INDEX memory_fields_table_id ON memory_fields(memory_space_id, table_id, position, id)",
      )
      .execute(database);
    await sql
      .raw(
        "CREATE INDEX memory_records_table_id ON memory_records(memory_space_id, table_id, created_at, id)",
      )
      .execute(database);
    await sql
      .raw(
        "CREATE INDEX memory_record_history_filters ON memory_record_history(memory_space_id, table_id, record_id, revision_id, archived_at)",
      )
      .execute(database);
  },
  async down(database) {
    for (const table of [
      "source_store_parse_errors",
      "source_store_messages",
      "source_store_chats",
      "memory_record_history",
      "memory_evidence",
      "memory_records",
      "memory_fields",
      "memory_tables",
      "memory_spaces",
    ]) {
      await sql.raw(`DROP TABLE ${table}`).execute(database);
    }
  },
};
