import { hostname } from "node:os";
import {
  RunCancelledError,
  RunLeaseLostError,
  type RunExecutor,
} from "@pluginmax/application";
import type { ClaimedJob, PlatformRepositories } from "@pluginmax/database";
import type { WorkerStatus } from "@pluginmax/contracts";

export class WorkerShutdownError extends Error {
  constructor() {
    super("worker shutdown deadline exceeded");
    this.name = "WorkerShutdownError";
  }
}

export interface WorkerRuntimeOptions {
  readonly workerId: string;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly leaseRenewIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly recoveryBatchSize: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly heartbeatIntervalMs: number;
  readonly workerHeartbeatStaleAfterSeconds: number;
  readonly sweepIntervalMs: number;
  readonly maintenanceIntervalMs?: number;
}

export interface WorkerRuntimeDependencies {
  readonly repositories: PlatformRepositories;
  readonly executor: RunExecutor;
  readonly sweep?: () => Promise<void>;
  readonly maintenance?: {
    runOnce(): Promise<number>;
  };
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface ActiveJob {
  readonly job: ClaimedJob;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export class WorkerRuntime {
  private stopping = false;
  private started = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly active = new Map<string, ActiveJob>();
  private readonly loopPromises: Promise<void>[] = [];

  constructor(
    private readonly options: WorkerRuntimeOptions,
    private readonly dependencies: WorkerRuntimeDependencies,
  ) {
    if (
      options.leaseRenewIntervalMs < 100 ||
      options.leaseRenewIntervalMs >= options.leaseSeconds * 1_000
    ) {
      throw new Error(
        "leaseRenewIntervalMs must be at least 100ms and shorter than the lease",
      );
    }
    if (options.concurrency < 1 || options.concurrency > 128) {
      throw new Error("worker concurrency must be between 1 and 128");
    }
  }

  get activeJobCount(): number {
    return this.active.size;
  }

  async run(): Promise<void> {
    if (this.started) throw new Error("worker runtime is already started");
    this.started = true;
    this.log("worker.started", {
      concurrency: this.options.concurrency,
      leaseSeconds: this.options.leaseSeconds,
    });
    await this.heartbeat("starting");
    await this.heartbeat("running");
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat(this.stopping ? "draining" : "running");
    }, this.options.heartbeatIntervalMs);
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.options.sweepIntervalMs);
    void this.sweep();
    for (let index = 0; index < this.options.concurrency; index += 1) {
      this.loopPromises.push(this.claimLoop(index));
    }
    if (this.dependencies.maintenance !== undefined) {
      this.loopPromises.push(this.maintenanceLoop());
    }
    await Promise.all(this.loopPromises);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    await this.heartbeat("stopped");
    this.log("worker.stopped");
  }

  async stop(signal = "SIGTERM"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log("worker.draining", {
      signal,
      activeJobs: this.active.size,
      graceMs: this.options.shutdownGraceMs,
    });
    await this.heartbeat("draining");
    const deadline = Date.now() + this.options.shutdownGraceMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (this.active.size > 0) {
      this.log("worker.shutdown_timeout", {
        activeJobs: this.active.size,
      });
      for (const active of this.active.values()) {
        active.controller.abort(new WorkerShutdownError());
      }
      await Promise.race([
        Promise.allSettled(
          [...this.active.values()].map((job) => job.completion),
        ),
        sleep(5_000),
      ]);
    }
    await Promise.allSettled(this.loopPromises);
    this.log("worker.drained", {
      signal,
      activeJobs: this.active.size,
    });
  }

  private async claimLoop(_slot: number): Promise<void> {
    while (!this.stopping) {
      let job: ClaimedJob | undefined;
      try {
        job = await this.dependencies.repositories.jobs.claimNext(
          this.options.workerId,
          this.options.leaseSeconds,
        );
      } catch (error) {
        this.log("job.claim_failed", { error: this.message(error) });
        await sleep(this.options.pollIntervalMs);
        continue;
      }
      if (job === undefined) {
        await sleep(this.options.pollIntervalMs);
        continue;
      }
      const controller = new AbortController();
      const entry: ActiveJob = {
        job,
        controller,
        completion: Promise.resolve(),
      };
      const completion = this.executeJob(entry);
      this.active.set(job.id, { ...entry, completion });
      this.log("job.claimed", {
        jobId: job.id,
        runId: job.runId,
        traceId: job.traceId,
        traceparent: `00-${job.traceId}-${job.spanId}-01`,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        recovered: job.recoveredRun,
      });
      await completion;
      this.active.delete(job.id);
    }
  }

  private async executeJob(entry: ActiveJob): Promise<void> {
    const { job, controller } = entry;
    let renewing = false;
    const renewTimer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.dependencies.repositories.jobs
        .renewLease(
          job.id,
          this.options.workerId,
          job.leaseToken,
          this.options.leaseSeconds,
          { expectedRenewIntervalMs: this.options.leaseRenewIntervalMs },
        )
        .then(async (renewed) => {
          if (!renewed && !controller.signal.aborted) {
            const current = await this.dependencies.repositories.jobs.get(
              job.id,
            );
            if (current?.status === "cancelled") {
              controller.abort(new RunCancelledError());
              return;
            }
            this.log("job.lease_lost", {
              jobId: job.id,
              runId: job.runId,
            });
            controller.abort(new RunLeaseLostError());
          }
        })
        .catch((error: unknown) => {
          this.log("job.lease_renew_failed", {
            jobId: job.id,
            runId: job.runId,
            error: this.message(error),
          });
        })
        .finally(() => {
          renewing = false;
        });
    }, this.options.leaseRenewIntervalMs);
    try {
      await this.dependencies.executor.execute(job.runId, {
        signal: controller.signal,
        jobId: job.id,
        owner: this.options.workerId,
        leaseSeconds: this.options.leaseSeconds,
        leaseRenewIntervalMs: this.options.leaseRenewIntervalMs,
        traceId: job.traceId,
        jobSpanId: job.spanId,
        assertLease: async () => {
          const owned = await this.dependencies.repositories.jobs.hasLease(
            job.id,
            this.options.workerId,
            job.leaseToken,
          );
          if (!owned) {
            const current = await this.dependencies.repositories.jobs.get(
              job.id,
            );
            if (current?.status === "cancelled") {
              throw new RunCancelledError();
            }
            throw new RunLeaseLostError();
          }
        },
      });
      if (controller.signal.reason instanceof RunCancelledError) {
        this.log("job.cancelled", { jobId: job.id, runId: job.runId });
        return;
      }
      const completed = await this.dependencies.repositories.jobs.complete(
        job.id,
        this.options.workerId,
        job.leaseToken,
      );
      if (completed) {
        this.log("job.completed", {
          jobId: job.id,
          runId: job.runId,
          traceId: job.traceId,
        });
      } else {
        this.log("job.complete_ignored", {
          jobId: job.id,
          runId: job.runId,
        });
      }
    } catch (error) {
      const reason = controller.signal.reason;
      if (
        error instanceof RunCancelledError ||
        reason instanceof RunCancelledError
      ) {
        this.log("job.cancelled", {
          jobId: job.id,
          runId: job.runId,
          traceId: job.traceId,
        });
        return;
      }
      if (reason instanceof WorkerShutdownError) {
        const interrupted = await this.dependencies.repositories.jobs.interrupt(
          job.id,
          this.options.workerId,
          job.leaseToken,
          "worker shutdown deadline exceeded",
        );
        this.log("job.interrupted", {
          jobId: job.id,
          runId: job.runId,
          interrupted,
        });
        return;
      }
      if (
        reason instanceof RunLeaseLostError ||
        error instanceof RunLeaseLostError
      ) {
        this.log("job.abandoned_after_lease_loss", {
          jobId: job.id,
          runId: job.runId,
        });
        return;
      }
      const message = this.message(error);
      try {
        const result = await this.dependencies.repositories.jobs.fail(
          job.id,
          this.options.workerId,
          job.leaseToken,
          message,
          {
            baseBackoffMs: this.options.retryBaseDelayMs,
            maxBackoffMs: this.options.retryMaxDelayMs,
          },
        );
        this.log("job.failed", {
          jobId: job.id,
          runId: job.runId,
          traceId: job.traceId,
          outcome: result.outcome,
          error: message,
          availableAt: result.availableAt,
        });
      } catch (failureError) {
        this.log("job.fail_persistence_error", {
          jobId: job.id,
          runId: job.runId,
          error: this.message(failureError),
        });
      }
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      if (this.dependencies.sweep !== undefined) {
        await this.dependencies.sweep();
      }
    } catch (error) {
      this.log("worker.sweep_failed", { error: this.message(error) });
    } finally {
      this.sweeping = false;
    }
  }

  private async maintenanceLoop(): Promise<void> {
    const intervalMs = this.options.maintenanceIntervalMs ?? 1_000;
    while (!this.stopping) {
      try {
        await this.dependencies.maintenance?.runOnce();
      } catch (error) {
        this.log("maintenance.loop_failed", {
          error: this.message(error),
        });
      }
      await sleep(intervalMs);
    }
  }

  private async heartbeat(status: WorkerStatus): Promise<void> {
    try {
      await this.dependencies.repositories.runtimeReliability.heartbeat({
        id: this.options.workerId,
        hostname: hostname(),
        pid: process.pid,
        concurrency: this.options.concurrency,
        status,
        metadata: {
          activeJobs: this.active.size,
          leaseSeconds: this.options.leaseSeconds,
        },
      });
    } catch (error) {
      this.log("worker.heartbeat_failed", {
        status,
        error: this.message(error),
      });
    }
  }

  private log(event: string, data: Record<string, unknown> = {}): void {
    if (this.dependencies.log !== undefined) {
      this.dependencies.log(event, data);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: event.includes("failed") ? "error" : "info",
        workerId: this.options.workerId,
        event,
        ...data,
      })}\n`,
    );
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
