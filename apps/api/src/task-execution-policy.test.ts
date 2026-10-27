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
  type DirectChatThread,
  type Meeting,
  type Project,
  type Task,
  type TaskExecutionPolicyRecord,
  type WorkflowDefinition,
  type WorkflowInstance,
} from "@pluginmax/contracts";
import { Database, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("task execution policy and run execution envelope", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-task-policy-files-"),
    );
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
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    const options: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  function policy(
    overrides: Partial<ReturnType<typeof legacyTaskExecutionPolicy>>,
  ) {
    return taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      ...overrides,
    });
  }

  async function setPolicy(
    path: string,
    expectedRevision: number,
    value = policy({
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [],
      },
      toolPolicy: {
        allow: ["shell.execute"],
        deny: [],
        requireApproval: [],
      },
      budget: { timeoutMs: 30_000, maxTurns: 3 },
    }),
  ): Promise<TaskExecutionPolicyRecord> {
    const result = await request<TaskExecutionPolicyRecord>("PUT", path, {
      expectedRevision,
      policy: value,
    });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return result.body;
  }

  async function createProject(label: string): Promise<Project> {
    const result = await request<Project>("POST", "/api/v1/projects", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      description: "Batch 15A execution policy fixture",
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createAgent(
    label: string,
    runtimeKind: Agent["runtimeKind"] = "fake",
  ): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `${label} ${randomUUID().slice(0, 8)}`,
      runtimeKind,
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function addAgent(
    projectId: string,
    agentId: string,
    roleIds: string[] = [],
  ): Promise<void> {
    const result = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Execution policy fixture",
        roleIds,
      },
    );
    expect(result.statusCode).toBe(201);
  }

  async function envelopeFor(runId: string): Promise<{
    execution_context_type: string;
    execution_policy_revision: number;
    execution_binding_revision: number;
    execution_runtime_revision: number;
    execution_envelope_snapshot: {
      digest: string;
      contextType: string;
      contextId: string;
      authorization: { scope: string; effectivePermissions: string[] };
      policy: { id: string; revision: number; source: string };
      binding: { kind: string; revision: number };
      runtime: {
        id: string;
        revision: number;
        capability: { toolCategories: string[] };
      };
      envelope: { resolved: { allowedToolCategories: string[] } };
    };
  }> {
    const result = await database.query<{
      execution_context_type: string;
      execution_policy_revision: number;
      execution_binding_revision: number;
      execution_runtime_revision: number;
      execution_envelope_snapshot: {
        digest: string;
        contextType: string;
        contextId: string;
        authorization: { scope: string; effectivePermissions: string[] };
        policy: { id: string; revision: number; source: string };
        binding: { kind: string; revision: number };
        runtime: {
          id: string;
          revision: number;
          capability: { toolCategories: string[] };
        };
        envelope: { resolved: { allowedToolCategories: string[] } };
      };
    }>(
      `SELECT execution_context_type, execution_policy_revision,
              execution_binding_revision, execution_runtime_revision,
              execution_envelope_snapshot
       FROM runs
       WHERE id = $1`,
      [runId],
    );
    return result.rows[0]!;
  }

  async function ticketFor(runId: string): Promise<ActionTicketBundle> {
    const result = await request<ActionTicketBundle>(
      "GET",
      `/api/v1/runs/${runId}/action-ticket`,
    );
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(result.body.ticket).toMatchObject({
      runId,
      policyRevision: expect.any(Number),
      envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.body.ticket.executionEnvelope.envelope.ticketId).toBe(
      result.body.ticket.ticketId,
    );
    return result.body;
  }

  it("keeps policy revisions immutable and rejects stale optimistic writes", async () => {
    const project = await createProject("Policy revision");
    const first = await setPolicy(
      `/api/v1/projects/${project.id}/execution-policy`,
      0,
    );
    expect(first.revision).toBe(1);

    const stale = await request<{ code: string; details: unknown }>(
      "PUT",
      `/api/v1/projects/${project.id}/execution-policy`,
      {
        expectedRevision: 0,
        policy: first.policy,
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({
      code: "task_execution_policy_revision_conflict",
      details: { currentRevision: 1 },
    });

    const second = await setPolicy(
      `/api/v1/projects/${project.id}/execution-policy`,
      1,
      policy({
        runtime: {
          selection: "recommended",
          allowedRuntimeIds: ["builtin:fake"],
          requiredCapabilities: [],
        },
        budget: { timeoutMs: 20_000, maxTurns: 2 },
      }),
    );
    expect(second.revision).toBe(2);

    const outsider = await request(
      "PUT",
      `/api/v1/projects/${project.id}/execution-policy`,
      { expectedRevision: 2, policy: second.policy },
      "policy-outsider",
    );
    expect(outsider.statusCode).toBe(403);
  });

  it("applies the same envelope to Task, Workflow Task, Meeting AI and Direct Chat", async () => {
    const project = await createProject("Four entry policy");
    const agent = await createAgent("Execution policy agent");
    await addAgent(project.id, agent.id);
    await setPolicy(`/api/v1/projects/${project.id}/execution-policy`, 0);

    const taskResult = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: "Policy task",
      description: "Verify the task execution envelope",
      agentId: agent.id,
    });
    expect(taskResult.statusCode).toBe(201);
    const taskPolicy = await setPolicy(
      `/api/v1/tasks/${taskResult.body.id}/execution-policy`,
      0,
    );
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${taskResult.body.id}/dispatch`,
    );
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
    const taskEnvelope = await envelopeFor(dispatched.body.runId);
    expect(taskEnvelope).toMatchObject({
      execution_context_type: "task",
      execution_policy_revision: taskPolicy.revision,
      execution_binding_revision: 1,
      execution_runtime_revision: 1,
      execution_envelope_snapshot: {
        contextType: "task",
        authorization: { scope: "project" },
        policy: { revision: taskPolicy.revision, source: "context" },
        binding: { kind: "builtin", revision: 1 },
        runtime: { id: "builtin:fake", revision: 1 },
        envelope: { resolved: { allowedToolCategories: [] } },
      },
    });
    expect(taskEnvelope.execution_envelope_snapshot.digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const envelopeResponse = await request<{
      digest: string;
      policy: { revision: number };
    }>("GET", `/api/v1/runs/${dispatched.body.runId}/execution-envelope`);
    expect(envelopeResponse.statusCode).toBe(200);
    expect(envelopeResponse.body).toMatchObject({
      digest: taskEnvelope.execution_envelope_snapshot.digest,
      policy: { revision: taskPolicy.revision },
    });
    const taskTicket = await ticketFor(dispatched.body.runId);
    expect(taskTicket.ticket).toMatchObject({
      contextType: "task",
      policyRevision: taskPolicy.revision,
      allowedActions: ["agent.execute", "task.writeback"],
    });

    await setPolicy(
      `/api/v1/tasks/${taskResult.body.id}/execution-policy`,
      taskPolicy.revision,
      policy({
        budget: { timeoutMs: 10_000, maxTurns: 1 },
      }),
    );
    expect(await envelopeFor(dispatched.body.runId)).toEqual(taskEnvelope);

    const deniedTask = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: "Denied capability task",
      description: "Policy cannot expand the fake Runtime capability",
      agentId: agent.id,
    });
    await setPolicy(
      `/api/v1/tasks/${deniedTask.body.id}/execution-policy`,
      0,
      policy({
        runtime: {
          selection: "recommended",
          allowedRuntimeIds: ["builtin:fake"],
          requiredCapabilities: [{ key: "shell", necessity: "required" }],
        },
      }),
    );
    const deniedDispatch = await request<{ code: string }>(
      "POST",
      `/api/v1/tasks/${deniedTask.body.id}/dispatch`,
    );
    expect(deniedDispatch.statusCode).toBe(409);
    expect(deniedDispatch.body.code).toBe("runtime_capability_missing");

    const dshAgent = await createAgent("DSH policy agent", "dsh-sdk");
    await addAgent(project.id, dshAgent.id);
    const dshTask = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: "DSH policy task",
      description: "The same policy gate must cover DSH SDK",
      agentId: dshAgent.id,
    });
    await setPolicy(
      `/api/v1/tasks/${dshTask.body.id}/execution-policy`,
      0,
      policy({
        runtime: {
          selection: "recommended",
          allowedRuntimeIds: ["builtin:dsh-sdk"],
          requiredCapabilities: [],
        },
      }),
    );
    const dshDispatch = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${dshTask.body.id}/dispatch`,
    );
    expect(dshDispatch.statusCode, JSON.stringify(dshDispatch.body)).toBe(202);
    expect(await envelopeFor(dshDispatch.body.runId)).toMatchObject({
      execution_context_type: "task",
      execution_envelope_snapshot: {
        binding: { kind: "builtin", revision: 1 },
        runtime: { id: "builtin:dsh-sdk", revision: 1 },
      },
    });

    const role = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.id}/roles`,
      { name: `Workflow executor ${randomUUID().slice(0, 6)}` },
    );
    const workflowAgent = await createAgent("Workflow policy agent");
    await addAgent(project.id, workflowAgent.id, [role.body.id]);
    const workflow = await request<WorkflowDefinition>(
      "POST",
      "/api/v1/workflows/import",
      {
        projectId: project.id,
        markdown: `# 工作流：Policy

## 元信息

- key: policy-${randomUUID().slice(0, 8).toLowerCase()}
- version: 1

## 节点

### Execute

- id: execute
- type: task
- executor: role:${role.body.id}
- execution: task-worker
- trigger: auto-on-ready

## 连接
`,
      },
    );
    expect(workflow.statusCode).toBe(201);
    const workflowRun = await request<WorkflowInstance>(
      "POST",
      `/api/v1/workflows/${workflow.body.id}/start`,
      { title: "Workflow policy run" },
    );
    expect(workflowRun.statusCode).toBe(201);
    const workflowRunId = workflowRun.body.steps[0]?.runId;
    expect(workflowRunId).toBeTruthy();
    expect(await envelopeFor(workflowRunId!)).toMatchObject({
      execution_context_type: "workflow-task",
      execution_envelope_snapshot: {
        contextType: "workflow-task",
        authorization: { scope: "project" },
        policy: { source: "project-default" },
        runtime: { id: "builtin:fake" },
      },
    });
    expect((await ticketFor(workflowRunId!)).ticket).toMatchObject({
      contextType: "workflow-task",
      allowedActions: ["agent.execute", "workflow.writeback"],
    });

    const meeting = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.id,
      title: "Meeting policy",
      agenda: "Verify Meeting AI envelope",
      agentIds: [agent.id],
    });
    expect(meeting.statusCode).toBe(201);
    await setPolicy(`/api/v1/meetings/${meeting.body.id}/execution-policy`, 0);
    const meetingAiPolicy = await request<{ revision: number }>(
      "GET",
      `/api/v1/meetings/${meeting.body.id}/ai-policy`,
    );
    const enabled = await request(
      "PUT",
      `/api/v1/meetings/${meeting.body.id}/ai-policy`,
      {
        expectedRevision: meetingAiPolicy.body.revision,
        status: "active",
        triggerKinds: ["mention", "round"],
        cooldownSeconds: 0,
        maxRounds: 10,
        maxMessages: 20,
        runBudgetMs: 5_000,
      },
    );
    expect(enabled.statusCode).toBe(200);
    const triggered = await request<{
      turns: Array<{ runId: string | null }>;
    }>("POST", `/api/v1/meetings/${meeting.body.id}/ai-triggers`, {
      kind: "round",
      roundNumber: 1,
      agentIds: [agent.id],
    });
    expect(triggered.statusCode).toBe(202);
    const meetingRunId = triggered.body.turns[0]?.runId;
    expect(meetingRunId).toBeTruthy();
    expect(await envelopeFor(meetingRunId!)).toMatchObject({
      execution_context_type: "meeting",
      execution_envelope_snapshot: {
        contextType: "meeting",
        policy: { source: "context" },
        authorization: { scope: "project" },
      },
    });
    expect((await ticketFor(meetingRunId!)).ticket).toMatchObject({
      contextType: "meeting",
      allowedActions: ["agent.execute", "meeting.writeback"],
    });

    const thread = await request<DirectChatThread>(
      "POST",
      "/api/v1/direct-chats",
      { agentId: agent.id },
    );
    expect(thread.statusCode).toBe(200);
    await setPolicy(
      `/api/v1/direct-chats/${thread.body.id}/execution-policy`,
      0,
    );
    const direct = await request<{ run: { id: string } }>(
      "POST",
      `/api/v1/direct-chats/${thread.body.id}/messages`,
      {
        content: "Verify direct chat policy",
        clientMessageId: randomUUID(),
      },
    );
    expect(direct.statusCode, JSON.stringify(direct.body)).toBe(202);
    expect(await envelopeFor(direct.body.run.id)).toMatchObject({
      execution_context_type: "direct-chat",
      execution_envelope_snapshot: {
        contextType: "direct-chat",
        policy: { source: "context" },
        authorization: { scope: "self" },
      },
    });
    expect((await ticketFor(direct.body.run.id)).ticket).toMatchObject({
      contextType: "direct-chat",
      allowedActions: ["agent.execute", "direct-chat.writeback"],
    });
  });
});
