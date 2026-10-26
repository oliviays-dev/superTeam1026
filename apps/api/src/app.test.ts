import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("runtime operations API contract", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let repositories: PlatformRepositories;
  let deadLetterJobId: string;
  let runId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(join(tmpdir(), "pluginmax-api-test-"));
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 12,
      workerHeartbeatStaleAfterSeconds: 30,
    });
    app = built.app;
    await app.ready();

    const stamp = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    runId = randomUUID();
    deadLetterJobId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'API contract', $2, '', 'active', NOW(), NOW())`,
      [projectId, `API-${stamp.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $2, $1, 'API contract task', 'test', '[]'::jsonb, 'queued',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [projectId, taskId],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, attempt, created_at, updated_at
       ) VALUES (
         $3, $1, $2, '00000000-0000-4000-8000-000000000001',
         'interrupted',
         '{"taskTitle":"test","taskDescription":"test","acceptance":[],"instruction":"test","agentName":"Fake","runtimeKind":"fake"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW(), NOW()
       )`,
      [projectId, taskId, runId],
    );
    await database.query(
      `INSERT INTO jobs (
         id, run_id, kind, status, attempts, max_attempts, available_at,
         last_error, dead_letter_at, created_at, updated_at
       ) VALUES (
         $2, $1, 'agent.run', 'dead_letter', 3, 3, NOW(),
         'injected dead letter', NOW(), NOW(), NOW()
       )`,
      [runId, deadLetterJobId],
    );
    await repositories.runtimeReliability.heartbeat({
      id: "worker-api-contract",
      hostname: "test-host",
      pid: process.pid,
      concurrency: 3,
      status: "running",
    });
    await database.query(
      `INSERT INTO workflow_idempotency_keys (
         id, scope, operation, idempotency_key, request_hash, state,
         response_status, response_body, created_at, updated_at, completed_at
       ) VALUES (
         $1, 'api-test', 'legacy.operation', 'legacy-key', 'hash',
         'completed', 200, '{"ok":true}'::jsonb,
         NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days',
         NOW() - INTERVAL '30 days'
       )`,
      [randomUUID()],
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("keeps liveness independent from readiness dependencies", async () => {
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      service: "pluginmax-api",
    });
    await repositories.runtimeReliability.heartbeat({
      id: "worker-api-contract",
      hostname: "test-host",
      pid: process.pid,
      concurrency: 3,
      status: "stopped",
    });
    const workerDown = await app.inject({
      method: "GET",
      url: "/api/v1/ready",
    });
    expect(workerDown.statusCode).toBe(503);
    expect(workerDown.json()).toMatchObject({
      ok: false,
      checks: { worker: { ok: false } },
    });
    await repositories.runtimeReliability.heartbeat({
      id: "worker-api-contract",
      hostname: "test-host",
      pid: process.pid,
      concurrency: 3,
      status: "running",
    });
    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        database: { ok: true },
        worker: { ok: true },
        migration: { ok: true },
      },
    });
  });

  it("exposes queue, worker, dead-letter and SLA metrics", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      metrics: {
        expectedMigrationVersion: 12,
        migrationVersion: 12,
        activeWorkers: 1,
        deadLetterCount: expect.any(Number),
      },
      workers: expect.arrayContaining([
        expect.objectContaining({ id: "worker-api-contract" }),
      ]),
      deadLetters: expect.arrayContaining([
        expect.objectContaining({ id: deadLetterJobId }),
      ]),
    });
  });

  it("enforces administrator permission and recoverable job state", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${deadLetterJobId}/recover`,
      headers: { "x-pluginmax-actor": "not-an-admin" },
      payload: { reason: "illegal permission test" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("forbidden");

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${deadLetterJobId}/recover`,
      payload: { reason: "operator recovery test" },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      id: deadLetterJobId,
      runId,
      status: "queued",
      attempts: 3,
      maxAttempts: 4,
    });

    const illegal = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${deadLetterJobId}/recover`,
      payload: { reason: "must fail after recovery" },
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().code).toBe("job_not_recoverable");
  });

  it("archives expired idempotency receipts through the admin API", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/operations/idempotency/cleanup",
      payload: { olderThanSeconds: 86_400, batchSize: 50 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      archivedCount: 1,
      deletedCount: 1,
    });
    const remaining = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM workflow_idempotency_keys
       WHERE scope = 'api-test'`,
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });
});
