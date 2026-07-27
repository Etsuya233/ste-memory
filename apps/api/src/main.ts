import { CoreDatabaseHealthCheck } from "@ste-memory/core-sqlite";
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { SourceStoreDatabaseHealthCheck } from "./source-store/health.ts";

export async function startApi(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = loadConfig(environment);
  const server = await buildServer({
    coreDatabase: new CoreDatabaseHealthCheck(config.coreDatabaseUrl),
    sourceStoreDatabase: new SourceStoreDatabaseHealthCheck(
      config.sourceStoreDatabaseUrl,
    ),
  });

  await server.listen({ host: config.host, port: config.port });
}

if (import.meta.main) {
  await startApi(process.env);
}
