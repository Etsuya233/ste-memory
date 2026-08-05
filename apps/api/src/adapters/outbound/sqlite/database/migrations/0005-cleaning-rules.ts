import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * 清洗规则（ticket 01，ADR apps/0001）：
 * 记忆空间内按顺序执行的正则规则，以「保留/去掉」模式改写导入消息内容，
 * 影响消息展示与填表任务输入；原文存储不被改写（读取时应用）。
 */
export const cleaningRulesMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `CREATE TABLE cleaning_rules (
      id TEXT PRIMARY KEY,
      memory_space_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('keep', 'discard')),
      pattern TEXT NOT NULL,
      flags TEXT NOT NULL DEFAULT 'g',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw("CREATE INDEX cleaning_rules_space ON cleaning_rules(memory_space_id, position)")
      .execute(database);
  },
  async down(database) {
    await sql.raw("DROP TABLE cleaning_rules").execute(database);
  },
};
