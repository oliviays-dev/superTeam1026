export interface PlatformConfig {
  readonly databaseUrl: string;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly webPort: number;
  readonly fileStoreRoot: string;
  readonly workerPollIntervalMs: number;
  readonly workerLeaseSeconds: number;
  readonly workerLeaseRenewIntervalMs: number;
  readonly workerRecoveryBatchSize: number;
  readonly workerConcurrency: number;
  readonly workerShutdownGraceMs: number;
  readonly workerRetryBaseDelayMs: number;
  readonly workerRetryMaxDelayMs: number;
  readonly workerHeartbeatIntervalMs: number;
  readonly workerHeartbeatStaleAfterSeconds: number;
  readonly idempotencyRetentionSeconds: number;
  readonly idempotencyCleanupBatchSize: number;
  readonly idempotencyCleanupIntervalMs: number;
  readonly workflowSweepIntervalMs: number;
  readonly workflowSweepBatchSize: number;
  readonly workflowSweepLeaseSeconds: number;
  readonly workflowSweepStaleSeconds: number;
  readonly maintenancePollIntervalMs: number;
  readonly maintenanceLeaseSeconds: number;
  readonly approvalSlaBatchSize: number;
  readonly runtimeEffectPollIntervalMs: number;
  readonly runtimeProbePollIntervalMs: number;
  readonly runtimeProbeTimeoutMs: number;
  readonly runtimeProbeLeaseSeconds: number;
  readonly localActorId: string;
  readonly agentWorkspaceRoot: string;
  readonly dshBin: string | undefined;
  readonly dshProfile: string;
  readonly dshHome: string;
  readonly dshProvider: string;
  readonly dshModel: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export function platformRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PLUGINMAX_ROOT ?? env.INIT_CWD ?? process.cwd());
}

export function loadLocalEnv(path = resolve(platformRoot(), ".env")): void {
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
  const root = platformRoot(env);
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
    fileStoreRoot: resolve(root, env.FILE_STORE_ROOT ?? ".tmp/files"),
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
    workerLeaseRenewIntervalMs: integer(
      env.WORKER_LEASE_RENEW_INTERVAL_MS,
      10_000,
      "WORKER_LEASE_RENEW_INTERVAL_MS",
    ),
    workerRecoveryBatchSize: integer(
      env.WORKER_RECOVERY_BATCH_SIZE,
      20,
      "WORKER_RECOVERY_BATCH_SIZE",
    ),
    workerConcurrency: integer(env.WORKER_CONCURRENCY, 4, "WORKER_CONCURRENCY"),
    workerShutdownGraceMs: integer(
      env.WORKER_SHUTDOWN_GRACE_MS,
      30_000,
      "WORKER_SHUTDOWN_GRACE_MS",
    ),
    workerRetryBaseDelayMs: integer(
      env.WORKER_RETRY_BASE_DELAY_MS,
      1_000,
      "WORKER_RETRY_BASE_DELAY_MS",
    ),
    workerRetryMaxDelayMs: integer(
      env.WORKER_RETRY_MAX_DELAY_MS,
      60_000,
      "WORKER_RETRY_MAX_DELAY_MS",
    ),
    workerHeartbeatIntervalMs: integer(
      env.WORKER_HEARTBEAT_INTERVAL_MS,
      5_000,
      "WORKER_HEARTBEAT_INTERVAL_MS",
    ),
    workerHeartbeatStaleAfterSeconds: integer(
      env.WORKER_HEARTBEAT_STALE_AFTER_SECONDS,
      30,
      "WORKER_HEARTBEAT_STALE_AFTER_SECONDS",
    ),
    idempotencyRetentionSeconds: integer(
      env.IDEMPOTENCY_RETENTION_SECONDS,
      604_800,
      "IDEMPOTENCY_RETENTION_SECONDS",
    ),
    idempotencyCleanupBatchSize: integer(
      env.IDEMPOTENCY_CLEANUP_BATCH_SIZE,
      500,
      "IDEMPOTENCY_CLEANUP_BATCH_SIZE",
    ),
    idempotencyCleanupIntervalMs: integer(
      env.IDEMPOTENCY_CLEANUP_INTERVAL_MS,
      3_600_000,
      "IDEMPOTENCY_CLEANUP_INTERVAL_MS",
    ),
    workflowSweepIntervalMs: integer(
      env.WORKFLOW_SWEEP_INTERVAL_MS,
      3_000,
      "WORKFLOW_SWEEP_INTERVAL_MS",
    ),
    workflowSweepBatchSize: integer(
      env.WORKFLOW_SWEEP_BATCH_SIZE,
      20,
      "WORKFLOW_SWEEP_BATCH_SIZE",
    ),
    workflowSweepLeaseSeconds: integer(
      env.WORKFLOW_SWEEP_LEASE_SECONDS,
      30,
      "WORKFLOW_SWEEP_LEASE_SECONDS",
    ),
    workflowSweepStaleSeconds: integer(
      env.WORKFLOW_SWEEP_STALE_SECONDS,
      2,
      "WORKFLOW_SWEEP_STALE_SECONDS",
    ),
    maintenancePollIntervalMs: integer(
      env.MAINTENANCE_POLL_INTERVAL_MS,
      1_000,
      "MAINTENANCE_POLL_INTERVAL_MS",
    ),
    maintenanceLeaseSeconds: integer(
      env.MAINTENANCE_LEASE_SECONDS,
      30,
      "MAINTENANCE_LEASE_SECONDS",
    ),
    approvalSlaBatchSize: integer(
      env.APPROVAL_SLA_BATCH_SIZE,
      100,
      "APPROVAL_SLA_BATCH_SIZE",
    ),
    runtimeEffectPollIntervalMs: integer(
      env.RUNTIME_EFFECT_POLL_INTERVAL_MS,
      500,
      "RUNTIME_EFFECT_POLL_INTERVAL_MS",
    ),
    runtimeProbePollIntervalMs: integer(
      env.RUNTIME_PROBE_POLL_INTERVAL_MS,
      500,
      "RUNTIME_PROBE_POLL_INTERVAL_MS",
    ),
    runtimeProbeTimeoutMs: integer(
      env.RUNTIME_PROBE_TIMEOUT_MS,
      5_000,
      "RUNTIME_PROBE_TIMEOUT_MS",
    ),
    runtimeProbeLeaseSeconds: integer(
      env.RUNTIME_PROBE_LEASE_SECONDS,
      30,
      "RUNTIME_PROBE_LEASE_SECONDS",
    ),
    localActorId: env.LOCAL_ACTOR_ID ?? "local-admin",
    agentWorkspaceRoot: resolve(
      root,
      env.AGENT_WORKSPACE_ROOT ?? ".tmp/agent-workspaces",
    ),
    dshBin: env.DSH_BIN === "" ? undefined : env.DSH_BIN,
    dshProfile: env.DSH_PROFILE ?? "sdk",
    dshHome: resolve(root, env.DSH_HOME ?? ".tmp/dsh-home-platform"),
    dshProvider: env.DSH_PROVIDER ?? "deepseek-official",
    dshModel: env.DSH_MODEL ?? "deepseek-v4-flash",
    logLevel: logLevel as PlatformConfig["logLevel"],
  };
}
import { resolve } from "node:path";
