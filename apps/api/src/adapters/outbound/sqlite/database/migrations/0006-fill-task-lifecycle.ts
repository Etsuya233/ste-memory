import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * 填表任务状态机（ticket 14）：重建 memory_fill_tasks 表，把 status 约束从
 * 三态（running/succeeded/failed）扩展为完整生命周期九态，并把"活动任务"
 * 唯一索引的排除集从两态改为四个终态（succeeded/failed/cancelled/interrupted）：
 * 暂停中、请求暂停/中止中的任务仍算活动（只读保持、冲突提交）。
 *
 * SQLite 无法修改 CHECK 约束，按标准做法重建表（建新表 → 拷数据 → 删旧表 → 改名 → 重建索引）。
 * down() 回滚到旧三态表时，非终态行一律落为 running（旧表 CHECK 不接受 interrupted）。
 */
export const fillTaskLifecycleMigration: Migration = {
  async up(database) {
    await sql
      .raw(
        `CREATE TABLE memory_fill_tasks_new (
      run_id TEXT PRIMARY KEY,
      memory_space_id TEXT NOT NULL,
      from_source_id INTEGER NOT NULL CHECK (from_source_id > 0),
      to_source_id INTEGER NOT NULL CHECK (to_source_id >= from_source_id),
      block_size INTEGER NOT NULL CHECK (block_size > 0),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'pause_requested', 'paused',
        'cancel_requested', 'cancelled', 'succeeded', 'failed', 'interrupted'
      )),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_space_id) REFERENCES memory_spaces(id) ON DELETE CASCADE
    ) STRICT`,
      )
      .execute(database);
    await sql
      .raw(
        `INSERT INTO memory_fill_tasks_new (
        run_id, memory_space_id, from_source_id, to_source_id, block_size,
        status, error_message, created_at, updated_at
      )
      SELECT run_id, memory_space_id, from_source_id, to_source_id, block_size,
             status, error_message, created_at, updated_at
      FROM memory_fill_tasks`,
      )
      .execute(database);
    await sql.raw("DROP TABLE memory_fill_tasks").execute(database);
    await sql
      .raw("ALTER TABLE memory_fill_tasks_new RENAME TO memory_fill_tasks")
      .execute(database);
    await sql
      .raw("CREATE INDEX memory_fill_tasks_space ON memory_fill_tasks(memory_space_id, created_at)")
      .execute(database);
    // 每空间最多一个非终态任务的数据库级兜底（并发提交竞态保护）。
    await sql
      .raw(
        `CREATE UNIQUE INDEX memory_fill_tasks_active_space
         ON memory_fill_tasks(memory_space_id)
         WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')`,
      )
      .execute(database);
  },
  async down(database) {
    await sql
      .raw(
        `CREATE TABLE memory_fill_tasks_old (
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
      .raw(
        `INSERT INTO memory_fill_tasks_old (
        run_id, memory_space_id, from_source_id, to_source_id, block_size,
        status, error_message, created_at, updated_at
      )
      SELECT run_id, memory_space_id, from_source_id, to_source_id, block_size,
             'running', error_message, created_at, updated_at
      FROM memory_fill_tasks
      WHERE status NOT IN ('succeeded', 'failed')`,
      )
      .execute(database);
    await sql
      .raw(
        `INSERT INTO memory_fill_tasks_old (
        run_id, memory_space_id, from_source_id, to_source_id, block_size,
        status, error_message, created_at, updated_at
      )
      SELECT run_id, memory_space_id, from_source_id, to_source_id, block_size,
             status, error_message, created_at, updated_at
      FROM memory_fill_tasks
      WHERE status IN ('succeeded', 'failed')`,
      )
      .execute(database);
    await sql.raw("DROP TABLE memory_fill_tasks").execute(database);
    await sql
      .raw("ALTER TABLE memory_fill_tasks_old RENAME TO memory_fill_tasks")
      .execute(database);
    await sql
      .raw("CREATE INDEX memory_fill_tasks_space ON memory_fill_tasks(memory_space_id, created_at)")
      .execute(database);
    await sql
      .raw(
        `CREATE UNIQUE INDEX memory_fill_tasks_active_space
         ON memory_fill_tasks(memory_space_id)
         WHERE status != 'succeeded' AND status != 'failed'`,
      )
      .execute(database);
  },
};
