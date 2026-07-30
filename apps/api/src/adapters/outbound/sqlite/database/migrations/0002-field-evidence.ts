import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const fieldEvidenceMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `ALTER TABLE memory_records
         ADD COLUMN field_evidence_json TEXT NOT NULL DEFAULT '{}'
         CHECK (json_valid(field_evidence_json))`,
      )
      .execute(database);
    await sql
      .raw(
        `ALTER TABLE memory_record_history
         ADD COLUMN field_evidence_json TEXT NOT NULL DEFAULT '{}'
         CHECK (json_valid(field_evidence_json))`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_evidence (
      memory_space_id TEXT NOT NULL,
      evidence_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id_json TEXT NOT NULL CHECK (json_valid(source_id_json)),
      storage_mode TEXT NOT NULL CHECK (storage_mode IN ('snapshot', 'reference')),
      content TEXT,
      extra_props_json TEXT NOT NULL CHECK (json_valid(extra_props_json)),
      CHECK (
        (storage_mode = 'snapshot' AND content IS NOT NULL) OR
        (storage_mode = 'reference' AND content IS NULL)
      ),
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE,
      UNIQUE (memory_space_id, source_type, source_id_json)
    ) STRICT`,
      )
      .execute(database);
  },
  async down(database) {
    await sql.raw("DROP TABLE memory_evidence").execute(database);
    await sql
      .raw("ALTER TABLE memory_record_history DROP COLUMN field_evidence_json")
      .execute(database);
    await sql.raw("ALTER TABLE memory_records DROP COLUMN field_evidence_json").execute(database);
  },
};
