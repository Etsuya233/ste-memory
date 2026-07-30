import type { Kysely } from "kysely";
import { Migrator, type MigrationProvider } from "kysely/migration";
import { initialMigration } from "./migrations/0001-initial.ts";
import { fieldEvidenceMigration } from "./migrations/0002-field-evidence.ts";
import type { DatabaseSchema } from "./schema/database.ts";

const migrations: MigrationProvider = {
  async getMigrations() {
    return {
      "0001-initial": initialMigration,
      "0002-field-evidence": fieldEvidenceMigration,
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
