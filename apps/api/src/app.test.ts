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
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
         1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
    );
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(join(tmpdir(), "pluginmax-api-test-"));
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 29,
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
    await insertLocalOwner(projectId);
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
      "DELETE FROM workflow_idempotency_keys WHERE scope = 'api-test'",
    );
    await database.query(
      "DELETE FROM workflow_idempotency_archive WHERE scope = 'api-test'",
    );
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

  async function createTaskFixture(
    input: {
      readonly projectId?: string;
      readonly projectStatus?: "active" | "archived";
      readonly agentId?: string;
      readonly taskStatus?: "queued" | "in_progress" | "review" | "done";
    } = {},
  ): Promise<{ projectId: string; taskId: string }> {
    const projectId = input.projectId ?? randomUUID();
    const taskId = randomUUID();
    if (input.projectId === undefined) {
      await database.query(
        `INSERT INTO projects (
           id, name, code, description, status, created_at, updated_at
         ) VALUES ($1, 'Negative fixture', $2, '', $3, NOW(), NOW())`,
        [
          projectId,
          `NEG-${projectId.slice(0, 8)}`,
          input.projectStatus ?? "active",
        ],
      );
      await insertLocalOwner(projectId);
    }
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Negative task', 'test', '[]'::jsonb, $3, $4, NOW(), NOW()
       )`,
      [
        taskId,
        projectId,
        input.taskStatus ?? "queued",
        input.agentId ?? "00000000-0000-4000-8000-000000000001",
      ],
    );
    return { projectId, taskId };
  }

  async function insertLocalOwner(projectId: string): Promise<void> {
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, principal_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES (
         $1, $2, 'human', 'local-admin', 'local-admin', 'Local Admin', '',
         'active', TRUE, NOW(), NOW()
       )
       ON CONFLICT (project_id, kind, actor_id) DO NOTHING`,
      [randomUUID(), projectId],
    );
  }

  async function createAgent(
    runtimeKind: "fake" | "codex-jsonl" | "plain-text" = "fake",
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      payload: {
        name: `Negative agent ${randomUUID().slice(0, 8)}`,
        runtimeKind,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

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
        expectedMigrationVersion: 29,
        migrationVersion: 29,
        activeWorkers: 1,
        deadLetterCount: expect.any(Number),
      },
      workers: expect.arrayContaining([
        expect.objectContaining({ id: "worker-api-contract" }),
      ]),
      deadLetters: expect.arrayContaining([
        expect.objectContaining({ id: deadLetterJobId }),
      ]),
      maintenanceSchedules: expect.arrayContaining([
        expect.objectContaining({ kind: "approval_sla" }),
        expect.objectContaining({ kind: "idempotency_cleanup" }),
      ]),
      maintenanceTrend: expect.any(Array),
      runtimeEffects: expect.any(Array),
    });
  });

  it("renders Prometheus metrics for runtime operations", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain(
      "# TYPE pluginmax_runtime_queue_wait_seconds gauge",
    );
    expect(response.body).toContain(
      'pluginmax_runtime_maintenance_next_run_timestamp_seconds{kind="approval_sla"}',
    );
    expect(response.body).toContain("pluginmax_runtime_effects_stale");
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

  it("propagates W3C trace context and rejects forged trace headers", async () => {
    const fixture = await createTaskFixture();
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const spanId = "bbbbbbbbbbbbbbbb";
    const dispatched = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${fixture.taskId}/dispatch`,
      headers: {
        traceparent: `00-${traceId}-${spanId}-01`,
      },
    });
    expect(dispatched.statusCode).toBe(202);
    expect(dispatched.headers["x-pluginmax-trace-id"]).toBe(traceId);
    const runId = dispatched.json().runId as string;
    const run = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
    });
    expect(run.headers["cache-control"]).toBe("no-store");
    expect(run.json()).toMatchObject({
      run: { id: runId, traceId, traceRootSpanId: spanId },
    });
    const trace = await app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}`,
    });
    expect(trace.statusCode).toBe(200);
    expect(trace.json()).toMatchObject({
      traceId,
      runs: [{ id: runId }],
      jobs: [{ runId, traceId }],
    });
    expect(trace.json().runEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run.queued", traceId }),
      ]),
    );

    const forgedFixture = await createTaskFixture();
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${forgedFixture.taskId}/dispatch`,
      headers: { traceparent: "forged-token" },
    });
    expect(forged.statusCode).toBe(202);
    expect(forged.headers["x-pluginmax-trace-invalid"]).toBe("1");
    expect(forged.headers["x-pluginmax-trace-id"]).not.toBe("forged-token");
  });

  it("rejects archived projects, disabled agents, and unavailable runtime adapters", async () => {
    const archived = await createTaskFixture({ projectStatus: "archived" });
    const archivedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${archived.taskId}/dispatch`,
    });
    expect(archivedResponse.statusCode).toBe(409);
    expect(archivedResponse.json().code).toBe("project_archived");

    const disabledAgentId = await createAgent();
    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${disabledAgentId}/status`,
      payload: { status: "disabled" },
    });
    const disabledTask = await createTaskFixture({
      agentId: disabledAgentId,
    });
    const disabledResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${disabledTask.taskId}/dispatch`,
    });
    expect(disabledResponse.statusCode).toBe(409);
    expect(disabledResponse.json().code).toBe("agent_unavailable");

    for (const runtimeKind of ["codex-jsonl", "plain-text"] as const) {
      const externalAgentId = await createAgent(runtimeKind);
      const externalTask = await createTaskFixture({
        agentId: externalAgentId,
      });
      const externalResponse = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${externalTask.taskId}/dispatch`,
      });
      expect(externalResponse.statusCode).toBe(409);
      expect(externalResponse.json().code).toBe("runtime_binding_missing");
    }
  });

  it("transfers queued tasks only to active AI project members", async () => {
    const targetAgentId = await createAgent();
    const fixture = await createTaskFixture();
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES (
         $1, $2, 'agent', $3, 'Transfer target', '',
         'active', FALSE, NOW(), NOW()
       )`,
      [randomUUID(), fixture.projectId, targetAgentId],
    );
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${fixture.taskId}/transfer`,
      headers: { "x-pluginmax-actor": "not-an-admin" },
      payload: { agentId: targetAgentId },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("forbidden");
    const transferred = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${fixture.taskId}/transfer`,
      payload: { agentId: targetAgentId },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({
      task: { id: fixture.taskId, agentId: targetAgentId },
      activity: expect.arrayContaining([
        expect.objectContaining({ kind: "transfer" }),
      ]),
    });

    const terminal = await createTaskFixture({
      projectId: fixture.projectId,
      taskStatus: "done",
    });
    const terminalResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${terminal.taskId}/transfer`,
      payload: { agentId: targetAgentId },
    });
    expect(terminalResponse.statusCode).toBe(409);
    expect(terminalResponse.json().code).toBe("task_terminal");

    const archived = await createTaskFixture({ projectStatus: "archived" });
    const archivedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${archived.taskId}/transfer`,
      payload: { agentId: targetAgentId },
    });
    expect(archivedResponse.statusCode).toBe(409);
    expect(archivedResponse.json().code).toBe("project_archived");
  });
});
