import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { JobRepository, jobRetryDelayMs } from "./repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

describe("jobRetryDelayMs", () => {
  it("uses deterministic exponential backoff with a cap", () => {
    expect(jobRetryDelayMs(1, 1_000, 60_000)).toBe(1_000);
    expect(jobRetryDelayMs(2, 1_000, 60_000)).toBe(2_000);
    expect(jobRetryDelayMs(3, 1_000, 60_000)).toBe(4_000);
    expect(jobRetryDelayMs(10, 1_000, 60_000)).toBe(60_000);
  });
});

integration("JobRepository PostgreSQL semantics", () => {
  const database = new Database(databaseUrl!);
  const jobs = new JobRepository(database);

  beforeAll(async () => {
    await migrate(database);
  });

  beforeEach(async () => {
    await database.query(
      `TRUNCATE TABLE
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
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         'job repository test',
         'JOB-TEST',
         '',
         'active',
         NOW(),
         NOW()
       );
       INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         '10000000-0000-4000-8000-000000000002',
         '10000000-0000-4000-8000-000000000001',
         'job repository task',
         'test',
         '[]'::jsonb,
         'in_progress',
         '00000000-0000-4000-8000-000000000001',
         NOW(),
         NOW()
       );
       INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, attempt, created_at, updated_at
       ) VALUES (
         '10000000-0000-4000-8000-000000000003',
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000002',
         '00000000-0000-4000-8000-000000000001',
         'queued',
         '{"taskTitle":"test","taskDescription":"test","acceptance":[],"instruction":"test","agentName":"Fake","runtimeKind":"fake"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1,
         NOW(),
         NOW()
       );
       INSERT INTO jobs (
         id, run_id, kind, status, attempts, max_attempts, available_at,
         created_at, updated_at
       ) VALUES (
         '10000000-0000-4000-8000-000000000004',
         '10000000-0000-4000-8000-000000000003',
         'agent.run',
         'queued',
         0,
         3,
         NOW(),
         NOW(),
         NOW()
       );`,
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("lets exactly one of many concurrent workers claim a job", async () => {
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new JobRepository(database).claimNext(`worker-${index}`, 30),
      ),
    );
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    const row = await database.query<{ attempts: number; status: string }>(
      "SELECT attempts, status FROM jobs WHERE id = $1",
      ["10000000-0000-4000-8000-000000000004"],
    );
    expect(row.rows[0]).toEqual({ attempts: 1, status: "running" });
  });

  it("fences stale lease tokens after expiry recovery", async () => {
    const first = await jobs.claimNext("worker-expired", 30);
    expect(first).toBeDefined();
    await database.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [first!.id],
    );
    const recovered = await jobs.recoverExpiredLeases(10, {
      baseBackoffMs: 1,
      maxBackoffMs: 1,
    });
    expect(recovered).toMatchObject([
      { jobId: first!.id, outcome: "retry_scheduled" },
    ]);
    const interrupted = await database.query<{ status: string }>(
      "SELECT status FROM runs WHERE id = $1",
      [first!.runId],
    );
    expect(interrupted.rows[0]?.status).toBe("interrupted");
    const second = await jobs.claimNext("worker-recovered", 30);
    expect(second).toMatchObject({
      id: first!.id,
      attempts: 2,
      recoveredRun: true,
    });
    expect(
      await jobs.complete(first!.id, "worker-expired", first!.leaseToken),
    ).toBe(false);
    expect(
      await jobs.complete(second!.id, "worker-recovered", second!.leaseToken),
    ).toBe(true);
    const events = await database.query<{ type: string }>(
      "SELECT type FROM run_events WHERE run_id = $1 ORDER BY seq",
      [first!.runId],
    );
    expect(events.rows.map((row) => row.type)).toEqual([
      "run.interrupted",
      "job.retry_scheduled",
      "run.recovered",
    ]);
  });

  it("moves exhausted jobs to dead letter and supports manual recovery", async () => {
    await database.query("UPDATE jobs SET max_attempts = 1 WHERE id = $1", [
      "10000000-0000-4000-8000-000000000004",
    ]);
    const claimed = await jobs.claimNext("worker-dead", 30);
    await database.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [claimed!.id],
    );
    const recovered = await jobs.recoverExpiredLeases(10);
    expect(recovered[0]?.outcome).toBe("dead_letter");
    expect((await jobs.get(claimed!.id))?.status).toBe("dead_letter");
    const manuallyRecovered = await jobs.recoverDeadLetter(
      claimed!.id,
      "local-admin",
      "operator retry",
    );
    expect(manuallyRecovered).toMatchObject({
      status: "queued",
      attempts: 1,
      maxAttempts: 2,
      manualRecoveryCount: 1,
    });
    expect(await jobs.recoverDeadLetter(randomUUID(), "local-admin", "x")).toBe(
      undefined,
    );
  });
});
