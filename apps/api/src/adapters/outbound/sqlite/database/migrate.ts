import type { Kysely } from "kysely";
import { Migrator, type MigrationProvider } from "kysely/migration";
import { initialMigration } from "./migrations/0001-initial.ts";
import { fieldEvidenceMigration } from "./migrations/0002-field-evidence.ts";
import { plotStartEndTimeMigration } from "./migrations/0003-plot-start-end-time.ts";
import { fillTaskMigration } from "./migrations/0004-fill-tasks.ts";
import { cleaningRulesMigration } from "./migrations/0005-cleaning-rules.ts";
import { fillTaskLifecycleMigration } from "./migrations/0006-fill-task-lifecycle.ts";
import type { DatabaseSchema } from "./schema/database.ts";

export const migrations: MigrationProvider = {
  async getMigrations() {
    return {
      "0001-initial": initialMigration,
      "0002-field-evidence": fieldEvidenceMigration,
      "0003-plot-start-end-time": plotStartEndTimeMigration,
      "0004-fill-tasks": fillTaskMigration,
      "0005-cleaning-rules": cleaningRulesMigration,
      "0006-fill-task-lifecycle": fillTaskLifecycleMigration,
    };
  },
};

export async function migrateDatabase(database: Kysely<DatabaseSchema>): Promise<void> {
  const { error, results } = await new Migrator({
    db: database,
    provider: migrations,
  }).migrateToLatest();
  if (error) throw error;
  const failed = results?.find((result) => result.status === "Error");
  if (failed) throw new Error(`Migration failed: ${failed.migrationName}`);
}
