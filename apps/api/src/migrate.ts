import { migrateCoreDatabase } from "@ste-memory/core-sqlite";
import { loadConfig } from "./config.ts";
import { migrateSourceStoreDatabase } from "./source-store/migrate.ts";

export function migrateDatabases(environment: NodeJS.ProcessEnv): void {
  const config = loadConfig(environment);
  migrateCoreDatabase(config.coreDatabaseUrl);
  migrateSourceStoreDatabase(config.sourceStoreDatabaseUrl);
}

if (import.meta.main) {
  migrateDatabases(process.env);
  console.log("Core and Source Store migrations completed");
}
