import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { DatabaseSchema } from "../schema/database.ts";

// 一次性快照：与 @ste-memory/memory-host-shared 的 system-memory-table-definitions.ts 中 plots 模板同时点保持一致。
// 迁移不依赖实时模板，保证迁移历史的确定性；后续模板演进通过新迁移处理。
const PLOT_TIME_FIELDS = [
  { key: "start_time", name: "开始时间", prompt: "只记录证据明确给出的开始时间。" },
  { key: "end_time", name: "结束时间", prompt: "只记录证据明确给出的结束时间。" },
] as const;

export const plotStartEndTimeMigration: Migration = {
  async up(database: Kysely<DatabaseSchema>) {
    const now = new Date().toISOString();
    const plotsTables = await database
      .selectFrom("memory_tables")
      .select(["id", "memory_space_id"])
      .where("key", "=", "plots")
      .where("kind", "=", "system")
      .execute();

    for (const table of plotsTables) {
      const existingKeys = await database
        .selectFrom("memory_fields")
        .select("key")
        .where("table_id", "=", table.id)
        .execute();
      const existing = new Set(existingKeys.map((field) => field.key));
      const maxPosition = await database
        .selectFrom("memory_fields")
        .select(({ fn }) => fn.max("position").as("max_position"))
        .where("table_id", "=", table.id)
        .executeTakeFirst();
      let position = Number(maxPosition?.max_position ?? -1) + 1;

      for (const field of PLOT_TIME_FIELDS) {
        if (existing.has(field.key)) continue;
        await database
          .insertInto("memory_fields")
          .values({
            id: randomUUID(),
            memory_space_id: table.memory_space_id,
            table_id: table.id,
            key: field.key,
            name: field.name,
            type: "datetime",
            required: 0,
            prompt: field.prompt,
            enabled: 1,
            position: position++,
            options_json: "[]",
            reference_table_id: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
    }
  },
  async down(database: Kysely<DatabaseSchema>) {
    await database
      .deleteFrom("memory_fields")
      .where("key", "in", PLOT_TIME_FIELDS.map((field) => field.key))
      .where(
        "table_id",
        "in",
        database
          .selectFrom("memory_tables")
          .select("id")
          .where("key", "=", "plots")
          .where("kind", "=", "system"),
      )
      .execute();
  },
};
