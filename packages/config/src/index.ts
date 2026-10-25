export interface PlatformConfig {
  readonly databaseUrl: string;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly webPort: number;
  readonly fileStoreRoot: string;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseSeconds: number;
  readonly localActorId: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export function loadLocalEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformConfig {
  const databaseUrl =
    env.DATABASE_URL ??
    "postgres://pluginmax:pluginmax@127.0.0.1:54329/pluginmax";
  const logLevel = env.LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  return {
    databaseUrl,
    apiHost: env.API_HOST ?? "127.0.0.1",
    apiPort: integer(env.API_PORT, 4310, "API_PORT"),
    webPort: integer(env.WEB_PORT, 4311, "WEB_PORT"),
    fileStoreRoot: env.FILE_STORE_ROOT ?? ".tmp/files",
    workerPollIntervalMs: integer(
      env.WORKER_POLL_INTERVAL_MS,
      500,
      "WORKER_POLL_INTERVAL_MS",
    ),
    workerLeaseSeconds: integer(
      env.WORKER_LEASE_SECONDS,
      60,
      "WORKER_LEASE_SECONDS",
    ),
    localActorId: env.LOCAL_ACTOR_ID ?? "local-admin",
    logLevel: logLevel as PlatformConfig["logLevel"],
  };
}
