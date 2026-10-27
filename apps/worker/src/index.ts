import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PlatformApplication, RunExecutor } from "@pluginmax/application";
import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { Database, PlatformRepositories } from "@pluginmax/database";
import { WorkerRuntime } from "./worker-runtime.js";
import { RuntimeMaintenanceService } from "./maintenance-service.js";
import { RuntimeProbeService } from "./runtime-probe-service.js";

loadLocalEnv();
const config = loadConfig();
const database = new Database(config.databaseUrl);
const repositories = new PlatformRepositories(database);
const application = new PlatformApplication(repositories);
const executor = new RunExecutor(repositories, {
  workspaceRoot: config.agentWorkspaceRoot,
  fileStoreRoot: config.fileStoreRoot,
  runtimeEffectPollIntervalMs: config.runtimeEffectPollIntervalMs,
  dsh: {
    dshBin: config.dshBin,
    profile: config.dshProfile,
    dshHome: config.dshHome,
    provider: config.dshProvider,
    model: config.dshModel,
  },
});
const workerId = `worker-${randomUUID()}`;

const log = (event: string, data: Record<string, unknown> = {}) => {
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      workerId,
      event,
      ...data,
    })}\n`,
  );
};

const sweep = async () => {
  const expiredGates = await application.expireExecutionGates(
    config.workerRecoveryBatchSize,
  );
  if (expiredGates.length > 0) {
    log("execution_gate.expired", { count: expiredGates.length });
  }
  const result = await application.sweepWorkflowInstances(workerId, {
    batchSize: config.workflowSweepBatchSize,
    leaseSeconds: config.workflowSweepLeaseSeconds,
    staleAfterSeconds: config.workflowSweepStaleSeconds,
  });
  if (result.claimed > 0) {
    log("workflow.sweep", result);
  }
};

const maintenance = new RuntimeMaintenanceService(
  repositories,
  application,
  {
    owner: workerId,
    claimLeaseSeconds: config.maintenanceLeaseSeconds,
    approvalSlaBatchSize: config.approvalSlaBatchSize,
    recoveryBatchSize: config.workerRecoveryBatchSize,
    retryBaseDelayMs: config.workerRetryBaseDelayMs,
    retryMaxDelayMs: config.workerRetryMaxDelayMs,
    idempotencyRetentionSeconds: config.idempotencyRetentionSeconds,
    idempotencyCleanupBatchSize: config.idempotencyCleanupBatchSize,
  },
  log,
);
const runtimeProbe = new RuntimeProbeService(
  repositories,
  {
    owner: workerId,
    workspaceRoot: resolve(config.agentWorkspaceRoot, "runtime-probes"),
    timeoutMs: config.runtimeProbeTimeoutMs,
    leaseSeconds: config.runtimeProbeLeaseSeconds,
  },
  log,
);

const runtime = new WorkerRuntime(
  {
    workerId,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.workerPollIntervalMs,
    leaseSeconds: config.workerLeaseSeconds,
    leaseRenewIntervalMs: config.workerLeaseRenewIntervalMs,
    shutdownGraceMs: config.workerShutdownGraceMs,
    recoveryBatchSize: config.workerRecoveryBatchSize,
    retryBaseDelayMs: config.workerRetryBaseDelayMs,
    retryMaxDelayMs: config.workerRetryMaxDelayMs,
    heartbeatIntervalMs: config.workerHeartbeatIntervalMs,
    workerHeartbeatStaleAfterSeconds: config.workerHeartbeatStaleAfterSeconds,
    sweepIntervalMs: config.workflowSweepIntervalMs,
    maintenanceIntervalMs: config.maintenancePollIntervalMs,
    runtimeProbePollIntervalMs: config.runtimeProbePollIntervalMs,
  },
  {
    repositories,
    executor,
    sweep,
    maintenance,
    runtimeProbe,
    log,
  },
);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("worker.signal_received", { signal });
  await runtime.stop(signal);
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

try {
  await runtime.run();
} finally {
  await database.close();
}
