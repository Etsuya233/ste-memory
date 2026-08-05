import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * 后台填表任务（ticket 13）：
 * - source_store_messages 增加逐消息处理状态（untracked 默认 / processed / error）；
 * - memory_fill_tasks 记录每个记忆空间的后台任务（状态机完整扩展见 ticket 14）。
 */
export const fillTaskMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `ALTER TABLE source_store_messages
         ADD COLUMN status TEXT NOT NULL DEFAULT 'untracked'
         CHECK (status IN ('untracked', 'processed', 'error'))`,
      )
      .execute(database);
    await sql
      .raw(
        `CREATE TABLE memory_fill_tasks (
      run_id TEXT PRIMARY KEY,
      memory_space_id TEXT NOT NULL,
      from_source_id INTEGER NOT NULL CHECK (from_source_id > 0),
      to_source_id INTEGER NOT NULL CHECK (to_source_id >= from_source_id),
      block_size INTEGER NOT NULL CHECK (block_size > 0),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw("CREATE INDEX memory_fill_tasks_space ON memory_fill_tasks(memory_space_id, created_at)")
      .execute(database);
    // 每空间最多一个非终态任务的数据库级兜底（并发提交竞态保护）。
    await sql
      .raw(
        `CREATE UNIQUE INDEX memory_fill_tasks_active_space
         ON memory_fill_tasks(memory_space_id)
         WHERE status != 'succeeded' AND status != 'failed'`,
      )
      .execute(database);
  },
  async down(database) {
    await sql.raw("DROP TABLE memory_fill_tasks").execute(database);
    await sql.raw("ALTER TABLE source_store_messages DROP COLUMN status").execute(database);
  },
};
