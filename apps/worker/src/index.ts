import { randomUUID } from "node:crypto";
import { PlatformApplication, RunExecutor } from "@pluginmax/application";
import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { Database, PlatformRepositories } from "@pluginmax/database";
import { WorkerRuntime } from "./worker-runtime.js";

loadLocalEnv();
const config = loadConfig();
const database = new Database(config.databaseUrl);
const repositories = new PlatformRepositories(database);
const application = new PlatformApplication(repositories);
const executor = new RunExecutor(repositories, {
  workspaceRoot: config.agentWorkspaceRoot,
  fileStoreRoot: config.fileStoreRoot,
  dsh: {
    dshBin: config.dshBin,
    profile: config.dshProfile,
    dshHome: config.dshHome,
    provider: config.dshProvider,
    model: config.dshModel,
  },
});
const workerId = `worker-${randomUUID()}`;
let lastIdempotencyCleanupAt = 0;

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
  const approvalSla = await application.sweepApprovalSla(workerId, 100);
  if (
    approvalSla.reminded > 0 ||
    approvalSla.escalated > 0 ||
    approvalSla.expired > 0
  ) {
    log("workflow.approval_sla", approvalSla);
  }
  const result = await application.sweepWorkflowInstances(workerId, {
    batchSize: config.workflowSweepBatchSize,
    leaseSeconds: config.workflowSweepLeaseSeconds,
    staleAfterSeconds: config.workflowSweepStaleSeconds,
  });
  if (result.claimed > 0) {
    log("workflow.sweep", result);
  }
  if (
    Date.now() - lastIdempotencyCleanupAt >=
    config.idempotencyCleanupIntervalMs
  ) {
    lastIdempotencyCleanupAt = Date.now();
    const cleanup =
      await repositories.runtimeReliability.cleanupIdempotencyReceipts({
        olderThanSeconds: config.idempotencyRetentionSeconds,
        batchSize: config.idempotencyCleanupBatchSize,
      });
    if (cleanup.deletedCount > 0) {
      log("idempotency.cleanup", cleanup);
    }
  }
};

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
  },
  {
    repositories,
    executor,
    sweep,
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
