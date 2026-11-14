import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DelegationApplicationService,
  ExecutionGateService,
} from "@pluginmax/application";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("Human Avatar Delegation", () => {
  let administrativeDatabase: Database;
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let schema: string;

  beforeAll(async () => {
    administrativeDatabase = new Database(databaseUrl!);
  });

  beforeEach(async () => {
    schema = `delegation_${randomUUID().replaceAll("-", "")}`;
    await administrativeDatabase.query(`CREATE SCHEMA ${schema}`);
    const separator = databaseUrl!.includes("?") ? "&" : "?";
    database = new Database(
      `${databaseUrl!}${separator}options=${encodeURIComponent(
        `-c search_path=${schema}`,
      )}`,
    );
    await migrate(database);
    repositories = new PlatformRepositories(database);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-delegation-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    }).app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await administrativeDatabase.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  afterAll(async () => {
    await administrativeDatabase.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function fixture(label: string): Promise<{
    readonly projectId: string;
    readonly agentId: string;
    readonly taskId: string;
  }> {
    const stamp = randomUUID().slice(0, 8);
    const project = await request<{ id: string }>(
      "POST",
      "/api/v1/projects",
      {
        name: `Delegation ${label} ${stamp}`,
        description: "Human Avatar integration fixture",
      },
    );
    expect(project.statusCode, JSON.stringify(project.body)).toBe(201);
    const agent = await request<{ id: string }>(
      "POST",
      "/api/v1/agents",
      {
        name: `Delegation representative ${stamp}`,
        description: "Scoped Human Avatar representative",
        runtimeKind: "fake",
      },
    );
    expect(agent.statusCode, JSON.stringify(agent.body)).toBe(201);
    const role = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.body.id}/roles`,
      {
        name: `Delegation writer ${stamp}`,
        permissions: ["read", "write"],
      },
    );
    expect(role.statusCode).toBe(201);
    const member = await request(
      "POST",
      `/api/v1/projects/${project.body.id}/members`,
      {
        kind: "agent",
        agentId: agent.body.id,
        responsibility: "Represent the owner inside one context",
        roleIds: [role.body.id],
      },
    );
    expect(member.statusCode, JSON.stringify(member.body)).toBe(201);
    const task = await request<{ id: string }>("POST", "/api/v1/tasks", {
      projectId: project.body.id,
      title: `Delegated task ${stamp}`,
      description: "Task-scoped Human Avatar context",
      agentId: agent.body.id,
    });
    expect(task.statusCode, JSON.stringify(task.body)).toBe(201);
    return {
      projectId: project.body.id,
      agentId: agent.body.id,
      taskId: task.body.id,
    };
  }

  async function createDelegation(input: {
    readonly projectId: string;
    readonly projectFixture: Awaited<ReturnType<typeof fixture>>;
    readonly contextType?: "task" | "meeting";
    readonly contextId?: string;
    readonly approvalPolicy?: string;
    readonly allowedActions?: string[];
    readonly representativeAgentId?: string;
    readonly suffix: string;
  }) {
    const result = await request<{
      id: string;
      revision: number;
      status: string;
    }>("POST", "/api/v1/delegations", {
      displayName: `Avatar ${input.suffix}`,
      representativeKind: "ai",
      representativeAgentId:
        input.representativeAgentId ?? input.projectFixture.agentId,
      workspaceId: input.projectId,
      projectId: input.projectId,
      contextType: input.contextType ?? "task",
      contextId: input.contextId ?? input.projectFixture.taskId,
      objective: "Review the scoped context and report risks to the owner.",
      stance: "Keep the existing delivery commitments.",
      watchItems: ["scope drift", "approval boundaries"],
      materialScopes: [`task:${input.projectFixture.taskId}`],
      allowedActions: input.allowedActions,
      deniedActions: ["approve", "reject", "archive", "delete"],
      approvalPolicy: input.approvalPolicy,
      autoParticipation: "mentions",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
      reportRequired: true,
      syncMeetingDelegate: true,
    });
    return result;
  }

  it("enforces revisions, deny-wins, Delegation Tickets and worker revalidation", async () => {
    const values = await fixture("execution");
    const created = await createDelegation({
      projectId: values.projectId,
      projectFixture: values,
      suffix: "execution",
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

    const activations = await Promise.all([
      request("POST", `/api/v1/delegations/${created.body.id}/activate`, {
        expectedRevision: created.body.revision,
        reason: "Activate from concurrent request A",
      }),
      request("POST", `/api/v1/delegations/${created.body.id}/activate`, {
        expectedRevision: created.body.revision,
        reason: "Activate from concurrent request B",
      }),
    ]);
    expect(activations.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const active = activations.find(
      (result) => result.statusCode === 200,
    )!.body as { revision: number };

    const preview = await request<{
      effectiveAllowedActions: string[];
      deniedActions: string[];
      canReadNow: boolean;
    }>("GET", `/api/v1/delegations/${created.body.id}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.body.canReadNow).toBe(true);
    expect(preview.body.effectiveAllowedActions).toContain("read_context");
    expect(preview.body.effectiveAllowedActions).not.toContain("approve");
    expect(preview.body.deniedActions).toContain("approve");

    const approvalCheck = await request<{
      allowed: boolean;
      reason: string;
    }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/action-check`,
      { action: "approve", expectedRevision: active.revision },
    );
    expect(approvalCheck.statusCode).toBe(200);
    expect(approvalCheck.body).toMatchObject({
      allowed: false,
      reason: "delegation_action_denied",
    });

    const dispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/dispatch`,
    );
    expect(dispatch.statusCode, JSON.stringify(dispatch.body)).toBe(201);
    const ticket = await request<{
      ticket: {
        principalId: string;
        delegation: {
          delegationId: string;
          delegationRevision: number;
          delegationContextHash: string;
        } | null;
      };
    }>("GET", `/api/v1/runs/${dispatch.body.runId}/action-ticket`);
    expect(ticket.statusCode, JSON.stringify(ticket.body)).toBe(200);
    expect(ticket.body.ticket.delegation).toMatchObject({
      delegationId: created.body.id,
      delegationRevision: active.revision,
    });
    expect(ticket.body.ticket.delegation?.delegationContextHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    const pause = await request<{ revision: number }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/pause`,
      {
        expectedRevision: active.revision,
        reason: "Owner paused the representative",
      },
    );
    expect(pause.statusCode).toBe(200);
    const gate = new ExecutionGateService(repositories);
    await expect(
      gate.assertRunAction({
        runId: dispatch.body.runId,
        action: "agent.execute",
      }),
    ).rejects.toMatchObject({ code: "delegation_paused" });

    const resume = await request<{ revision: number }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/resume`,
      {
        expectedRevision: pause.body.revision,
        reason: "Owner resumed the representative",
      },
    );
    expect(resume.statusCode).toBe(200);
    await expect(
      gate.assertRunAction({
        runId: dispatch.body.runId,
        action: "agent.execute",
      }),
    ).rejects.toMatchObject({ code: "delegation_revision_conflict" });

    const revoke = await request<{ revision: number }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/revoke`,
      {
        expectedRevision: resume.body.revision,
        reason: "Emergency owner recall",
      },
    );
    expect(revoke.statusCode).toBe(200);
    const run = await request<{ run: { status: string } }>(
      "GET",
      `/api/v1/runs/${dispatch.body.runId}`,
    );
    expect(run.body.run.status).toBe("cancelled");
    await expect(
      gate.assertRunAction({
        runId: dispatch.body.runId,
        action: "agent.execute",
      }),
    ).rejects.toMatchObject({ code: "delegation_ticket_revoked" });

    const report = await request<{ status: string }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/reports/generate`,
    );
    expect(report.statusCode).toBe(201);
    expect(report.body.status).toBe("ready");
  });

  it("projects Meeting Delegates, supports confirmation and expires safely", async () => {
    const values = await fixture("meeting");
    const meeting = await request<{ id: string }>("POST", "/api/v1/meetings", {
      projectId: values.projectId,
      title: `Delegation meeting ${randomUUID().slice(0, 8)}`,
      agenda: "Delegation compatibility fixture",
      agentIds: [values.agentId],
    });
    expect(meeting.statusCode).toBe(201);
    const created = await createDelegation({
      projectId: values.projectId,
      projectFixture: values,
      contextType: "meeting",
      contextId: meeting.body.id,
      suffix: "meeting",
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const activated = await request<{ revision: number }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/activate`,
      {
        expectedRevision: created.body.revision,
        reason: "Activate meeting projection",
      },
    );
    expect(activated.statusCode).toBe(200);
    const delegates = await request<{
      items: Array<{ delegationId: string; status: string }>;
    }>("GET", `/api/v1/meetings/${meeting.body.id}/delegates`);
    expect(delegates.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delegationId: created.body.id,
          status: "active",
        }),
      ]),
    );

    const confirmationFixture = await fixture("confirmation");
    const confirmationDelegation = await createDelegation({
      projectId: confirmationFixture.projectId,
      projectFixture: confirmationFixture,
      approvalPolicy: "require-confirmation",
      allowedActions: ["read_context", "submit_deliverable"],
      suffix: "confirmation",
    });
    expect(confirmationDelegation.statusCode).toBe(201);
    const confirmationActive = await request(
      "POST",
      `/api/v1/delegations/${confirmationDelegation.body.id}/activate`,
      {
        expectedRevision: confirmationDelegation.body.revision,
        reason: "Activate confirmation mode",
      },
    );
    expect(confirmationActive.statusCode).toBe(200);
    const requestConfirmation = await request<{
      id: string;
      status: string;
    }>(
      "POST",
      `/api/v1/delegations/${confirmationDelegation.body.id}/confirmations`,
      {
        action: "submit_deliverable",
        targetType: "task",
        targetId: confirmationFixture.taskId,
        proposedPayloadHash: "c".repeat(64),
        expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
      },
    );
    expect(
      requestConfirmation.statusCode,
      JSON.stringify(requestConfirmation.body),
    ).toBe(201);
    const decided = await request<{ status: string }>(
      "POST",
      `/api/v1/delegations/${confirmationDelegation.body.id}/confirmations/${requestConfirmation.body.id}/decision`,
      {
        decision: "approve",
        reason: "Owner reviewed the exact payload",
      },
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.body.status).toBe("approved");

    const expiringFixture = await fixture("expiry");
    const expiring = await createDelegation({
      projectId: expiringFixture.projectId,
      projectFixture: expiringFixture,
      suffix: "expiry",
    });
    const expiringActive = await request(
      "POST",
      `/api/v1/delegations/${expiring.body.id}/activate`,
      {
        expectedRevision: expiring.body.revision,
        reason: "Activate expiry fixture",
      },
    );
    expect(expiringActive.statusCode).toBe(200);
    await database.query(
      `UPDATE delegations
       SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [expiring.body.id],
    );
    const sweep = await new DelegationApplicationService(
      repositories,
    ).sweepDue();
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    const expired = await request<{ status: string }>(
      "GET",
      `/api/v1/delegations/${expiring.body.id}`,
    );
    expect(expired.body.status).toBe("expired");
  });

  it("retries failed reports without fabricating a successful result", async () => {
    const values = await fixture("report");
    const created = await createDelegation({
      projectId: values.projectId,
      projectFixture: values,
      suffix: "report",
    });
    const active = await request<{ revision: number }>(
      "POST",
      `/api/v1/delegations/${created.body.id}/activate`,
      {
        expectedRevision: created.body.revision,
        reason: "Activate report fixture",
      },
    );
    expect(active.statusCode).toBe(200);
    await request(
      "POST",
      `/api/v1/delegations/${created.body.id}/complete`,
      {
        expectedRevision: active.body.revision,
        reason: "Complete and request a report",
      },
    );
    const service = new DelegationApplicationService(repositories);
    const reportSpy = vi
      .spyOn(repositories.delegations, "completeReport")
      .mockRejectedValueOnce(new Error("report backend unavailable"));

    await expect(
      service.retryReport(created.body.id, "local-admin"),
    ).rejects.toMatchObject({ code: "delegation_report_generation_failed" });
    const failed = await repositories.delegations.report(created.body.id);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "delegation_report_generation_failed",
    });

    reportSpy.mockRestore();
    const retried = await service.retryReport(created.body.id, "local-admin");
    expect(retried.status).toBe("ready");
    expect(retried.attemptCount).toBeGreaterThanOrEqual(2);
  });
});
