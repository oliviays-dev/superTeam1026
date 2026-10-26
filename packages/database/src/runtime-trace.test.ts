import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRootTraceContext } from "@pluginmax/contracts";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { PlatformRepositories } from "./repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("runtime trace correlation", () => {
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
  });

  afterAll(async () => {
    await database.close();
  });

  it("joins run, job attempt, runtime effect, events, and maintenance by trace id", async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'Trace test', $2, '', 'active', NOW(), NOW())`,
      [projectId, `TRACE-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Trace task', 'test', '[]'::jsonb, 'queued',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, projectId],
    );
    const task = await repositories.tasks.get(taskId);
    expect(task).toBeDefined();
    const trace = createRootTraceContext();
    const runId = randomUUID();
    await repositories.runs.enqueue({
      runId,
      task: task!,
      inputSnapshot: {
        taskTitle: task!.title,
        taskDescription: task!.description,
        acceptance: [],
        instruction: task!.description,
        agentName: "Fake",
        runtimeKind: "fake",
      },
      trace,
    });
    const job = await repositories.jobs.claimNext("trace-worker", 30);
    expect(job).toMatchObject({ runId, traceId: trace.traceId });
    const effect = await repositories.runtimeEffects.begin({
      effectKey: `run:${runId}:agent.execute:v1`,
      runId,
      jobId: job!.id,
      operation: "agent.execute",
      owner: "trace-worker",
      leaseSeconds: 30,
    });
    expect(effect).toMatchObject({
      kind: "claimed",
      receipt: { traceId: trace.traceId },
    });
    await repositories.runtimeReliability.recordMaintenance({
      kind: "effect_recovery",
      status: "completed",
      processedCount: 1,
      startedAt: new Date(),
      trace,
    });

    const projection = await repositories.traces.get(trace.traceId);
    expect(projection).toMatchObject({
      traceId: trace.traceId,
      runs: [{ id: runId, traceId: trace.traceId }],
      jobs: [{ id: job!.id, traceId: trace.traceId }],
      jobAttempts: [{ jobId: job!.id, traceId: trace.traceId }],
      runtimeEffects: [{ runId, traceId: trace.traceId }],
      maintenanceRuns: [{ traceId: trace.traceId }],
    });
    expect(projection?.runEvents.length).toBeGreaterThan(0);
    expect(
      projection?.runEvents.every((event) => event.traceId === trace.traceId),
    ).toBe(true);
    const migration = await database.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM platform_migrations",
    );
    expect(migration.rows[0]?.version).toBe(23);
  });
});
