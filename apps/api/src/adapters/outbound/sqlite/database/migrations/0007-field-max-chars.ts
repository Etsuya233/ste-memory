import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * 字段长度上限（v2 模板实验）：
 * memory_fields 增加 max_chars（字符数上限，可空）。
 * 文本类字段（short_text/long_text/short_text_list）的值在提案校验层
 * 受此上限约束，超限报错回喂 Agent 触发压缩（配合 digest 中的 ≤N字 提示）。
 */
export const fieldMaxCharsMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `ALTER TABLE memory_fields
         ADD COLUMN max_chars INTEGER
         CHECK (max_chars IS NULL OR max_chars > 0)`,
      )
      .execute(database);
  },
  async down(database) {
    await sql.raw("ALTER TABLE memory_fields DROP COLUMN max_chars").execute(database);
  },
};
