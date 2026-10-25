import { randomUUID } from "node:crypto";
import { PlatformApplication, RunExecutor } from "@pluginmax/application";
import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { Database, PlatformRepositories } from "@pluginmax/database";

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
let stopping = false;
let closing = false;
let sweeping = false;
let sweepTimer: NodeJS.Timeout | null = null;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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

const stop = async () => {
  if (closing) return;
  closing = true;
  stopping = true;
  if (sweepTimer !== null) clearInterval(sweepTimer);
  await database.close();
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

const sweep = async () => {
  if (sweeping || stopping) return;
  sweeping = true;
  try {
    const recovered = await repositories.jobs.recoverExpiredLeases(
      config.workerRecoveryBatchSize,
    );
    if (recovered.length > 0) {
      log("worker.expired_leases_recovered", { count: recovered.length });
    }
    const result = await application.sweepWorkflowInstances(workerId, {
      batchSize: config.workflowSweepBatchSize,
      leaseSeconds: config.workflowSweepLeaseSeconds,
      staleAfterSeconds: config.workflowSweepStaleSeconds,
    });
    if (result.claimed > 0) {
      log("workflow.sweep", result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("workflow.sweep_failed", { error: message });
  } finally {
    sweeping = false;
  }
};

log("worker.started");
await sweep();
sweepTimer = setInterval(() => void sweep(), config.workflowSweepIntervalMs);
while (!stopping) {
  const job = await repositories.jobs.claimNext(
    workerId,
    config.workerLeaseSeconds,
  );
  if (job === undefined) {
    await sleep(config.workerPollIntervalMs);
    continue;
  }

  log("job.started", {
    jobId: job.id,
    runId: job.runId,
    attempt: job.attempts,
  });
  try {
    await executor.execute(job.runId);
    await repositories.jobs.complete(job.id);
    log("job.completed", { jobId: job.id, runId: job.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repositories.jobs.fail(job.id, message);
    log("job.failed", { jobId: job.id, runId: job.runId, error: message });
  }
}
