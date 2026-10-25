import type { ClaimedJob, PlatformRepositories } from "@pluginmax/database";
import type { RunExecutor } from "@pluginmax/application";
import { describe, expect, it, vi } from "vitest";
import {
  WorkerShutdownError,
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from "./worker-runtime.js";

const options: WorkerRuntimeOptions = {
  workerId: "worker-test",
  concurrency: 2,
  pollIntervalMs: 5,
  leaseSeconds: 2,
  leaseRenewIntervalMs: 100,
  shutdownGraceMs: 80,
  recoveryBatchSize: 10,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 10,
  heartbeatIntervalMs: 20,
  workerHeartbeatStaleAfterSeconds: 10,
  sweepIntervalMs: 10_000,
};

function claimed(index: number): ClaimedJob {
  return {
    id: `job-${index}`,
    runId: `run-${index}`,
    attempts: 1,
    maxAttempts: 3,
    leaseToken: `token-${index}`,
    recoveredRun: false,
  };
}

function harness(input: {
  readonly jobs: ClaimedJob[];
  readonly execute: RunExecutor["execute"];
  readonly shutdownGraceMs?: number;
}) {
  const complete = vi.fn(async () => true);
  const interrupt = vi.fn(async () => true);
  const fail = vi.fn(async () => ({ outcome: "ignored" as const }));
  const pending = [...input.jobs];
  const repositories = {
    jobs: {
      claimNext: vi.fn(async () => pending.shift()),
      renewLease: vi.fn(async () => true),
      hasLease: vi.fn(async () => true),
      complete,
      interrupt,
      fail,
      recoverExpiredLeases: vi.fn(async () => []),
    },
    runtimeReliability: {
      heartbeat: vi.fn(async () => undefined),
      recordMaintenance: vi.fn(async () => ({})),
    },
  } as unknown as PlatformRepositories;
  const executor = {
    execute: input.execute,
  } as unknown as RunExecutor;
  return {
    runtime: new WorkerRuntime(
      {
        ...options,
        concurrency: 2,
        ...(input.shutdownGraceMs === undefined
          ? {}
          : { shutdownGraceMs: input.shutdownGraceMs }),
      },
      { repositories, executor },
    ),
    complete,
    interrupt,
    fail,
  };
}

describe("WorkerRuntime", () => {
  it("runs jobs through a bounded concurrency pool without duplicate claims", async () => {
    let active = 0;
    let maximum = 0;
    const started: string[] = [];
    const { runtime, complete } = harness({
      jobs: [claimed(1), claimed(2), claimed(3)],
      execute: async (runId) => {
        started.push(runId);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
      },
    });
    const running = runtime.run();
    await vi.waitFor(() => expect(started).toHaveLength(3), {
      timeout: 2_000,
    });
    await runtime.stop();
    await running;
    expect(maximum).toBe(2);
    expect(new Set(started).size).toBe(3);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("stops claiming and waits for in-flight jobs during graceful shutdown", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime, complete, interrupt } = harness({
      jobs: [claimed(1)],
      shutdownGraceMs: 500,
      execute: async () => {
        await waiting;
      },
    });
    const running = runtime.run();
    await vi.waitFor(() => expect(runtime.activeJobCount).toBe(1));
    const stopping = runtime.stop("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupt).not.toHaveBeenCalled();
    release();
    await stopping;
    await running;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("aborts and safely interrupts a job after the shutdown deadline", async () => {
    const { runtime, interrupt } = harness({
      jobs: [claimed(1)],
      shutdownGraceMs: 10,
      execute: async (_runId, execution) => {
        const signal = execution?.signal;
        if (signal === undefined) throw new Error("missing execution signal");
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new WorkerShutdownError()),
            { once: true },
          );
        });
      },
    });
    const running = runtime.run();
    await vi.waitFor(() => expect(runtime.activeJobCount).toBe(1));
    await runtime.stop("SIGTERM");
    await running;
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
