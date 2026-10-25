import { randomUUID } from "node:crypto";
import { RunExecutor } from "@pluginmax/application";
import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { Database, PlatformRepositories } from "@pluginmax/database";

loadLocalEnv();
const config = loadConfig();
const database = new Database(config.databaseUrl);
const repositories = new PlatformRepositories(database);
const executor = new RunExecutor(repositories, {
  workspaceRoot: config.agentWorkspaceRoot,
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
  stopping = true;
  await database.close();
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

log("worker.started");
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
