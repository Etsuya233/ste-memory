import { loadConfig } from "./config.ts";
import { createDatabase } from "./adapters/outbound/sqlite/database/database.ts";
import { migrateDatabase } from "./adapters/outbound/sqlite/database/migrate.ts";

export async function migrateDatabases(environment: NodeJS.ProcessEnv): Promise<void> {
  const database = createDatabase(loadConfig(environment).databaseUrl);
  try {
    await migrateDatabase(database);
  } finally {
    await database.destroy();
  }
}

if (import.meta.main) {
  await migrateDatabases(process.env);
  console.log("Database migrations completed");
}
