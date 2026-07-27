import { loadConfig } from "./config.ts";
import { SqliteDatabaseHealthCheck } from "./health/sqlite-database-health-check.ts";
import { buildServer } from "./server.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const server = await buildServer({
    coreDatabase: new SqliteDatabaseHealthCheck(config.coreDatabaseUrl),
    sourceStoreDatabase: new SqliteDatabaseHealthCheck(config.sourceStoreDatabaseUrl),
  });

  await server.listen({ host: config.host, port: config.port });
}

if (import.meta.main) {
  await startApi(process.env);
}
