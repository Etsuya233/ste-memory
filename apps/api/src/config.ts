export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function valueOrDefault(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function parsePort(value: string | undefined): number {
  const port = Number(valueOrDefault(value, "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadConfig(environment: Environment): ApiConfig {
  return {
    host: valueOrDefault(environment.API_HOST, "127.0.0.1"),
    port: parsePort(environment.API_PORT),
    databaseUrl: valueOrDefault(environment.DATABASE_URL, "sqlite:../../data/ste-memory.sqlite"),
  };
}
