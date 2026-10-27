import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type ActionTicketBundle,
  type Agent,
  type ExecutionGateRecord,
  type Project,
  type RunDetail,
  type Task,
  type TaskExecutionPolicyRecord,
} from "@pluginmax/contracts";
import { RunExecutor } from "@pluginmax/application";
import {
  Database,
  JobRepository,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("Action Ticket and Execution Gate", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-action-ticket-files-"),
    );
    executor = new RunExecutor(repositories, {
      workspaceRoot: join(fileStoreRoot, "workspaces"),
      fileStoreRoot,
      dsh: {
        dshBin: "dsh",
        profile: "default",
        dshHome: join(fileStoreRoot, "dsh-home"),
        provider: "test",
        model: "test",
      },
    });
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 28,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) options.payload = payload as Record<string, unknown>;
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  function policy(
    humanGates: ReturnType<typeof legacyTaskExecutionPolicy>["humanGates"],
  ) {
    return taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [],
      },
      humanGates,
      budget: { timeoutMs: 30_000 },
    });
  }

  async function createProject(): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `Gate ${randomUUID().slice(0, 8)}`,
      description: "Batch 15B Gate fixture",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createAgent(): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `Gate agent ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function addAgent(projectId: string, agentId: string): Promise<void> {
    const result = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Execution Gate fixture",
        roleIds: [],
      },
    );
    expect(result.statusCode).toBe(201);
  }

  async function setTaskPolicy(
    taskId: string,
    gates: ReturnType<typeof policy>,
    expectedRevision = 0,
  ): Promise<TaskExecutionPolicyRecord> {
    const result = await request<TaskExecutionPolicyRecord>(
      "PUT",
      `/api/v1/tasks/${taskId}/execution-policy`,
      { expectedRevision, policy: gates },
    );
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return result.body;
  }

  async function dispatchTask(
    projectId: string,
    agentId: string,
    gates: ReturnType<typeof policy>,
  ): Promise<string> {
    const task = await request<Task>("POST", "/api/v1/tasks", {
      projectId,
      title: `Gate task ${randomUUID().slice(0, 8)}`,
      description: "Verify Action Ticket and Execution Gate",
      agentId,
    });
    expect(task.statusCode).toBe(201);
    await setTaskPolicy(task.body.id, gates);
    const dispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${task.body.id}/dispatch`,
    );
    expect(dispatch.statusCode, JSON.stringify(dispatch.body)).toBe(202);
    return dispatch.body.runId;
  }

  async function runDetail(runId: string): Promise<RunDetail> {
    const result = await request<RunDetail>("GET", `/api/v1/runs/${runId}`);
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  async function ticketBundle(runId: string): Promise<ActionTicketBundle> {
    const result = await request<ActionTicketBundle>(
      "GET",
      `/api/v1/runs/${runId}/action-ticket`,
    );
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return result.body;
  }

  const gates = policy([
    {
      id: "before-run",
      kind: "preflight",
      reason: "Approve task dispatch",
      enforcement: "blocking",
    },
    {
      id: "observe-run",
      kind: "data-source",
      reason: "Observe source usage",
      enforcement: "non-blocking",
    },
  ]);

  it("persists an immutable ticket and waits for blocking Gate decisions", async () => {
    const project = await createProject();
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const runId = await dispatchTask(project.id, agent.id, gates);

    const detail = await runDetail(runId);
    expect(detail.run.status).toBe("waiting_approval");
    expect(
      await new JobRepository(database).claimNext("gate-worker", 30, runId),
    ).toBeUndefined();

    const bundle = await ticketBundle(runId);
    expect(bundle.ticket).toMatchObject({
      principalId: "local-admin",
      workspaceId: project.id,
      contextType: "task",
      runId,
      allowedActions: ["agent.execute", "task.writeback"],
      policyRevision: detail.run.executionEnvelope?.policy.revision,
      envelopeId: detail.run.executionEnvelope?.id,
      envelopeDigest: detail.run.executionEnvelope?.digest,
    });
    expect(bundle.ticket.executionEnvelope.envelope.ticketId).toBe(
      bundle.ticket.ticketId,
    );
    expect(bundle.ticket.resourceScopes).toContain(`run:${runId}`);
    expect(bundle.gates.map((gate) => gate.status)).toEqual([
      "pending",
      "pending",
    ]);
    await request("GET", "/api/v1/auth/me", undefined, "platform-outsider");
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, 'platform-outsider', 'platform', 'platform', 'ADMIN', '[]'::jsonb,
         'active', 'manual', 'batch15b:admin-no-project', NULL, NULL,
         NOW(), NULL, NULL, 1, NOW(), NOW()
       )
       ON CONFLICT DO NOTHING`,
      [randomUUID()],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, created_at, updated_at
       ) VALUES ($1, $2, 'platform-outsider', 'active', NOW(), NOW())
       ON CONFLICT (workspace_id, principal_id) DO NOTHING`,
      [randomUUID(), project.id],
    );

    await expect(
      database.query(
        "UPDATE action_tickets SET workspace_id = 'tampered' WHERE id = $1",
        [bundle.ticket.ticketId],
      ),
    ).rejects.toThrow(/immutable/);

    const blocking = bundle.gates.find(
      (gate) => gate.enforcement === "blocking",
    )!;
    const outsiderDecision = await request<{ code: string }>(
      "POST",
      `/api/v1/execution-gates/${blocking.gateId}/decisions`,
      { decision: "approve", basis: "Platform ADMIN cannot bypass Project Grant" },
      "platform-outsider",
    );
    expect(outsiderDecision.statusCode).toBe(403);
    const first = await request<ExecutionGateRecord>(
      "POST",
      `/api/v1/execution-gates/${blocking.gateId}/decisions`,
      { decision: "approve", basis: "Task scope and policy revision checked" },
    );
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe("approved");
    expect((await runDetail(runId)).run.status).toBe("queued");

    await expect(
      database.query(
        "UPDATE execution_gate_decisions SET basis = 'changed' WHERE gate_id = $1",
        [blocking.gateId],
      ),
    ).rejects.toThrow(/immutable/);
    const decidedAgain = await request<{ code: string }>(
      "POST",
      `/api/v1/execution-gates/${blocking.gateId}/decisions`,
      { decision: "reject", basis: "second decision attempt" },
    );
    expect(decidedAgain.statusCode).toBe(409);
    expect(decidedAgain.body.code).toBe("execution_gate_not_pending");

    const claimed = await new JobRepository(database).claimNext(
      "gate-worker",
      30,
      runId,
    );
    expect(claimed).toMatchObject({ runId, attempts: 1 });
    await executor.execute(runId, {
      jobId: claimed!.id,
      owner: "gate-worker",
      leaseSeconds: 30,
      traceId: claimed!.traceId,
      jobSpanId: claimed!.spanId,
    });
    expect((await runDetail(runId)).run.status).toBe("completed");
    const usageRows = await database.query<{
      action: string;
      status: string;
    }>(
      `SELECT action, status
       FROM action_ticket_usages
       WHERE run_id = $1
       ORDER BY action`,
      [runId],
    );
    expect(usageRows.rows).toEqual([
      { action: "agent.execute", status: "completed" },
      { action: "task.writeback", status: "completed" },
    ]);
  });

  it("cancels or times out a waiting Run without claiming its Job", async () => {
    const project = await createProject();
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const blocking = policy([
      {
        id: "single-blocking",
        kind: "preflight",
        reason: "Single blocking fixture",
        enforcement: "blocking",
      },
    ]);

    const rejectedRunId = await dispatchTask(project.id, agent.id, blocking);
    const rejectedBundle = await ticketBundle(rejectedRunId);
    const rejected = await request<ExecutionGateRecord>(
      "POST",
      `/api/v1/execution-gates/${rejectedBundle.gates[0]!.gateId}/decisions`,
      { decision: "reject", basis: "Policy evidence is incomplete" },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.body.status).toBe("denied");
    expect((await runDetail(rejectedRunId)).run.status).toBe("cancelled");

    const cancelledRunId = await dispatchTask(project.id, agent.id, blocking);
    const cancelledBundle = await ticketBundle(cancelledRunId);
    const cancelled = await request<ExecutionGateRecord>(
      "POST",
      `/api/v1/execution-gates/${cancelledBundle.gates[0]!.gateId}/cancel`,
      { reason: "Operator cancelled the pending approval" },
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect((await runDetail(cancelledRunId)).run.status).toBe("cancelled");

    const timeoutRunId = await dispatchTask(project.id, agent.id, blocking);
    const timeoutBundle = await ticketBundle(timeoutRunId);
    const expiredGateId = randomUUID();
    await database.query(
      `INSERT INTO execution_gate_requests (
         gate_id, ticket_id, run_id, task_id, project_id, gate_key,
         kind, enforcement, reason, requested_tool_category,
         requested_source_class, resource_scopes, policy_id,
         policy_revision, envelope_id, envelope_digest,
         requested_by_principal_id, requested_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'expired-fixture',
         'budget', 'blocking', 'Expired Gate fixture', NULL, NULL,
         $6::text[], $7, $8, $9, $10, 'local-admin',
         NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'
       )`,
      [
        expiredGateId,
        timeoutBundle.ticket.ticketId,
        timeoutRunId,
        timeoutBundle.ticket.taskId,
        project.id,
        timeoutBundle.ticket.resourceScopes,
        timeoutBundle.ticket.policyId,
        timeoutBundle.ticket.policyRevision,
        timeoutBundle.ticket.envelopeId,
        timeoutBundle.ticket.envelopeDigest,
      ],
    );
    const expired = await repositories.actionTickets.expireDue();
    expect(expired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: expiredGateId,
          runId: timeoutRunId,
        }),
      ]),
    );
    expect((await runDetail(timeoutRunId)).run.status).toBe("timeout");
    const decisions = await database.query<{ decision: string }>(
      `SELECT decision
       FROM execution_gate_decisions
       WHERE gate_id = ANY($1::uuid[])
       ORDER BY decision`,
      [
        [
          expiredGateId,
          timeoutBundle.gates[0]!.gateId,
        ],
      ],
    );
    expect(decisions.rows.map((row) => row.decision)).toEqual([
      "timeout",
      "timeout",
    ]);
  });

  it("enforces a single Action Ticket idempotency boundary per external effect", async () => {
    const project = await createProject();
    const agent = await createAgent();
    await addAgent(project.id, agent.id);
    const runId = await dispatchTask(project.id, agent.id, policy([]));

    expect(
      await repositories.actionTickets.beginUsage({
        runId,
        action: "agent.execute",
        idempotencyKey: "effect-once",
      }),
    ).toMatchObject({ kind: "claimed" });
    expect(
      await repositories.actionTickets.beginUsage({
        runId,
        action: "agent.execute",
        idempotencyKey: "effect-once",
      }),
    ).toMatchObject({ kind: "in_progress" });
    await repositories.actionTickets.completeUsage({
      runId,
      action: "agent.execute",
      idempotencyKey: "effect-once",
      result: { output: "single effect" },
    });
    expect(
      await repositories.actionTickets.beginUsage({
        runId,
        action: "agent.execute",
        idempotencyKey: "effect-once",
      }),
    ).toMatchObject({ kind: "replay" });
    expect(
      await repositories.actionTickets.beginUsage({
        runId,
        action: "task.writeback",
        idempotencyKey: "writeback-once",
      }),
    ).toMatchObject({ kind: "claimed" });
    expect(
      await repositories.actionTickets.beginUsage({
        runId,
        action: "task.writeback",
        idempotencyKey: "writeback-once",
      }),
    ).toMatchObject({ kind: "in_progress" });
  });
});
