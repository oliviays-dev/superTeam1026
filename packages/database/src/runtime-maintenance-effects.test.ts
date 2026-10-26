import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { PlatformRepositories } from "./repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("maintenance scheduling and runtime effects", () => {
  const database = new Database(databaseUrl!);
  const repositories = new PlatformRepositories(database);

  beforeAll(async () => {
    await migrate(database);
  });

  beforeEach(async () => {
    await database.query(
      `TRUNCATE TABLE
         runtime_effect_receipts,
         runtime_maintenance_runs,
         job_attempts,
         jobs,
         run_events,
         run_deltas,
         runs,
         tasks,
         projects
       CASCADE`,
    );
    await database.query(
      `UPDATE runtime_maintenance_schedules
       SET
         enabled = TRUE,
         next_run_at = NOW() + INTERVAL '1 hour',
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_status = NULL,
         consecutive_failures = 0`,
    );
  });

  afterAll(async () => {
    await database.query(
      `UPDATE runtime_maintenance_schedules
       SET
         next_run_at = NOW(),
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL`,
    );
    await database.close();
  });

  async function createRun(): Promise<{ runId: string; jobId: string }> {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'Effect test', $2, '', 'active', NOW(), NOW());`,
      [projectId, `EFFECT-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Effect task', 'test', '[]'::jsonb, 'in_progress',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, projectId],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, attempt, created_at, updated_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001', 'running',
         '{"taskTitle":"test","taskDescription":"test","acceptance":[],"instruction":"test","agentName":"Fake","runtimeKind":"fake"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW(), NOW()
       )`,
      [runId, projectId, taskId],
    );
    await database.query(
      `INSERT INTO jobs (
         id, run_id, kind, status, attempts, max_attempts, available_at,
         lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, 'agent.run', 'running', 1, 3, NOW(),
         'worker-effect', NOW() + INTERVAL '1 minute', NOW(), NOW()
       )`,
      [jobId, runId],
    );
    return { runId, jobId };
  }

  it("lets only one worker claim a due maintenance schedule", async () => {
    await database.query(
      `UPDATE runtime_maintenance_schedules
       SET next_run_at = NOW() - INTERVAL '1 second'
       WHERE kind = 'approval_sla'`,
    );
    const claims = await Promise.all([
      repositories.runtimeReliability.claimDueMaintenance({
        owner: "worker-a",
        leaseSeconds: 30,
      }),
      repositories.runtimeReliability.claimDueMaintenance({
        owner: "worker-b",
        leaseSeconds: 30,
      }),
    ]);
    const winner =
      claims[0]!.length > 0
        ? { owner: "worker-a", claim: claims[0]![0]! }
        : claims[1]!.length > 0
          ? { owner: "worker-b", claim: claims[1]![0]! }
          : undefined;
    expect(winner?.claim.kind).toBe("approval_sla");
    expect(claims.flat()).toHaveLength(1);
    const completed =
      await repositories.runtimeReliability.completeMaintenanceClaim(
        "approval_sla",
        winner!.owner,
        winner!.claim.leaseToken,
      );
    expect(completed).toBe(true);
    const schedules =
      await repositories.runtimeReliability.listMaintenanceSchedules();
    expect(
      schedules.find((schedule) => schedule.kind === "approval_sla"),
    ).toMatchObject({
      lastStatus: "completed",
      consecutiveFailures: 0,
      leaseOwner: null,
    });
  });

  it("replays a completed effect across workers", async () => {
    const { runId, jobId } = await createRun();
    const effectKey = `run:${runId}:agent.execute:v1`;
    const first = await repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId,
      operation: "agent.execute",
      owner: "worker-a",
      leaseSeconds: 30,
    });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("effect was not claimed");
    await repositories.runtimeEffects.complete(
      effectKey,
      "worker-a",
      first.leaseToken,
      { output: "persisted output" },
    );
    const replay = await repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId,
      operation: "agent.execute",
      owner: "worker-b",
      leaseSeconds: 30,
    });
    expect(replay).toMatchObject({
      kind: "replay",
      receipt: { result: { output: "persisted output" }, status: "completed" },
    });
  });

  it("persists cancellation intent for another process to acknowledge", async () => {
    const { runId, jobId } = await createRun();
    const effectKey = `run:${runId}:agent.execute:v1`;
    const claimed = await repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId,
      operation: "agent.execute",
      owner: "worker-a",
      leaseSeconds: 30,
    });
    if (claimed.kind !== "claimed") throw new Error("effect was not claimed");
    const busy = await repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId,
      operation: "agent.execute",
      owner: "worker-b",
      leaseSeconds: 30,
    });
    expect(busy.kind).toBe("busy");
    await database.query(
      `UPDATE runtime_effect_receipts
       SET lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE effect_key = $1`,
      [effectKey],
    );
    await repositories.runtimeEffects.requestCancellation(runId);
    const cancelled = await repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId,
      operation: "agent.execute",
      owner: "worker-b",
      leaseSeconds: 30,
    });
    expect(cancelled.kind).toBe("cancelled");
  });
});
