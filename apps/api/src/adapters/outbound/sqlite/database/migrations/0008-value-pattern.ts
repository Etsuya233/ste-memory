import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * 字段值格式校验（v4 模板实验）：
 * memory_fields 增加 value_pattern（可选正则，非空文本值必须匹配）
 * 与 value_pattern_message（校验失败时回喂 Agent 的人类可读说明）。
 * 时间类字段（story_state.current_time / plots.time_hint）用「第 N 天·时段」
 * 格式校验根治 Agent 不按格式填写的问题：填错 → 提案被拒 → 错误回喂 → 自愈重提。
 */
export const fieldValuePatternMigration: Migration = {
  async up(database) {
    await sql.raw("ALTER TABLE memory_fields ADD COLUMN value_pattern TEXT").execute(database);
    await sql
      .raw("ALTER TABLE memory_fields ADD COLUMN value_pattern_message TEXT")
      .execute(database);
  },
  async down(database) {
    await sql.raw("ALTER TABLE memory_fields DROP COLUMN value_pattern_message").execute(database);
    await sql.raw("ALTER TABLE memory_fields DROP COLUMN value_pattern").execute(database);
  },
};
