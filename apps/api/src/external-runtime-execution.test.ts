import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunExecutor } from "@pluginmax/application";
import type {
  Agent,
  DirectChatSendResult,
  ExternalRuntime,
  Meeting,
  MeetingAiPolicy,
} from "@pluginmax/contracts";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
} from "@pluginmax/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  migrate,
  PlatformRepositories,
  type ClaimedJob,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const fixturePath = fileURLToPath(
  new URL(
    "../../../packages/agent-runtime/test-fixtures/external-cli.mjs",
    import.meta.url,
  ),
);

integration("external runtime execution", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const root = join(process.cwd(), ".tmp");
    await mkdir(root, { recursive: true });
    const fileStoreRoot = await mkdtemp(
      join(root, "pluginmax-external-execution-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(root, "pluginmax-external-execution-workspaces-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 25,
    });
    app = built.app;
    await app.ready();
    executor = new RunExecutor(repositories, {
      workspaceRoot,
      fileStoreRoot,
      dsh: {
        dshBin: "dsh",
        profile: "sdk",
        dshHome: join(workspaceRoot, "dsh-home"),
        provider: "test",
        model: "test",
      },
      runtimeEffectPollIntervalMs: 50,
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: T }> {
    const response = await app.inject({
      method,
      url,
      headers: { "x-pluginmax-actor": "local-admin" },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function createAgent(
    runtimeKind: "codex-jsonl" | "plain-text",
  ): Promise<Agent> {
    const result = await request<Agent>("POST", "/api/v1/agents", {
      name: `External execution agent ${randomUUID().slice(0, 8)}`,
      runtimeKind,
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createActiveRuntime(
    protocol: "codex-jsonl" | "plain-text",
    scenario = "success",
  ): Promise<ExternalRuntime> {
    const runtime = await repositories.externalRuntimes.create(
      {
        name: `External execution runtime ${randomUUID().slice(0, 8)}`,
        provider: protocol === "codex-jsonl" ? "codex" : "command",
        protocol,
        command: process.execPath,
        managedArgs: [fixturePath],
        customArgs: [protocol === "codex-jsonl" ? "codex" : "plain", scenario],
        supportedModels: protocol === "codex-jsonl" ? ["gpt-fixture"] : [],
        defaultModel: protocol === "codex-jsonl" ? "gpt-fixture" : null,
        contextWindowTokens: null,
        supportedTools: [],
        networkMode: "restricted",
        sandboxMode: "read-only",
        visibility: "owner",
      },
      "local-admin",
      "local-admin",
    );
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      actorId: "local-admin",
    });
    expect(requested.kind).toBe("requested");
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "external-execution-worker",
      30,
      runtime.id,
    );
    await repositories.externalRuntimes.completeProbeJob({
      jobId: claimed!.jobId,
      owner: "external-execution-worker",
      leaseToken: claimed!.leaseToken,
      exitCode: 0,
      timedOut: false,
      stdoutExcerpt: "v24.0.0",
      stderrExcerpt: "",
    });
    const enabled = await repositories.externalRuntimes.transition({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      nextStatus: "active",
      actorId: "local-admin",
      requirePassedProbe: true,
    });
    expect(enabled.kind).toBe("updated");
    return enabled.kind === "updated" ? enabled.runtime : runtime;
  }

  async function bind(agentId: string, runtimeId: string): Promise<void> {
    const result = await request(
      "PUT",
      `/api/v1/agents/${agentId}/runtime-binding`,
      {
        runtimeId,
        expectedRevision: 0,
      },
    );
    expect(result.statusCode).toBe(200);
  }

  async function processJob(job: ClaimedJob, workerId: string): Promise<void> {
    await executor.execute(job.runId, {
      jobId: job.id,
      owner: workerId,
      leaseSeconds: 60,
      traceId: job.traceId,
      jobSpanId: job.spanId,
      assertLease: async () => undefined,
    });
    await repositories.jobs.complete(job.id, workerId, job.leaseToken);
  }

  async function taskFixture(agentId: string): Promise<{
    projectId: string;
    taskId: string;
  }> {
    const projectId = randomUUID();
    const taskId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'External Task', $2, '', 'active', NOW(), NOW())`,
      [projectId, `EXT-${projectId.slice(0, 8)}`],
    );
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
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Execute through Codex JSONL', 'fixture task',
         '["final output"]'::jsonb, 'queued', $3, NOW(), NOW()
       )`,
      [taskId, projectId, agentId],
    );
    return { projectId, taskId };
  }

  it("dispatches and executes a task through a bound Codex JSONL runtime", async () => {
    const agent = await createAgent("codex-jsonl");
    const runtime = await createActiveRuntime("codex-jsonl");
    await bind(agent.id, runtime.id);
    const fixture = await taskFixture(agent.id);
    const policy = taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: [runtime.id],
        requiredCapabilities: [],
      },
      toolPolicy: {
        allow: [],
        deny: [],
        requireApproval: [],
      },
      budget: { timeoutMs: 60_000, maxTurns: 2 },
    });
    const savedPolicy = await repositories.taskExecutionPolicies.replace({
      contextType: "task",
      contextId: fixture.taskId,
      projectId: fixture.projectId,
      expectedRevision: 0,
      policy,
      actorId: "local-admin",
    });
    expect(savedPolicy).toMatchObject({
      kind: "saved",
      record: { revision: 1 },
    });

    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${fixture.taskId}/dispatch`,
    );
    expect(dispatched.statusCode).toBe(202);
    const run = await repositories.runs.get(dispatched.body.runId);
    expect(run?.executionSnapshot).toMatchObject({
      runtime: {
        id: runtime.id,
        protocol: "codex-jsonl",
        revision: runtime.revision,
      },
      binding: { revision: 1 },
      model: "gpt-fixture",
      envelope: {
        budget: { timeoutMs: 60_000, maxTurns: 2 },
        resolved: { allowedToolCategories: [] },
      },
    });
    expect(run?.executionEnvelope).toMatchObject({
      contextType: "task",
      policy: { revision: 1, source: "context" },
      binding: { kind: "external", id: expect.any(String), revision: 1 },
      runtime: {
        id: runtime.id,
        revision: runtime.revision,
        capabilitySnapshotId: expect.any(String),
      },
    });
    expect(run?.externalStartedAt).toBeNull();
    const revisedPolicy = await repositories.taskExecutionPolicies.replace({
      contextType: "task",
      contextId: fixture.taskId,
      projectId: fixture.projectId,
      expectedRevision: 1,
      policy: {
        ...policy,
        budget: { timeoutMs: 30_000, maxTurns: 1 },
      },
      actorId: "local-admin",
    });
    expect(revisedPolicy).toMatchObject({
      kind: "saved",
      record: { revision: 2 },
    });
    const job = await repositories.jobs.claimNext(
      "external-task-worker",
      60,
      dispatched.body.runId,
    );
    expect(job).toBeDefined();
    await processJob(job!, "external-task-worker");

    const completed = await repositories.runs.get(dispatched.body.runId);
    expect(completed).toMatchObject({
      status: "completed",
      externalRuntimeId: runtime.id,
      externalRuntimeRevision: runtime.revision,
      externalRuntimeProtocol: "codex-jsonl",
      externalRuntimeProvider: "openai-fixture",
      externalSessionId: "codex-session-fixture",
      externalRuntimeVersion: "9.8.7-fixture",
    });
    expect(completed?.output).toContain("FINAL:");
    expect(completed?.executionEnvelope).toMatchObject({
      policy: { revision: 1 },
      envelope: { budget: { timeoutMs: 60_000, maxTurns: 2 } },
    });
    const events = await repositories.runs.listEvents(dispatched.body.runId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "progress.summary" }),
        expect.objectContaining({ type: "tool.call" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(
      "PRIVATE_REASONING_MUST_NOT_LEAK",
    );
    const task = await repositories.tasks.get(fixture.taskId);
    expect(task?.status).toBe("review");
  });

  it("executes a workflow task through a bound Codex JSONL runtime", async () => {
    const agent = await createAgent("codex-jsonl");
    const runtime = await createActiveRuntime("codex-jsonl");
    await bind(agent.id, runtime.id);
    const project = await request<{ id: string }>("POST", "/api/v1/projects", {
      name: `External workflow ${randomUUID().slice(0, 8)}`,
      description: "",
    });
    expect(project.statusCode).toBe(201);
    const role = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.body.id}/roles`,
      { name: "Workflow external executor", description: "" },
    );
    expect(role.statusCode).toBe(201);
    const member = await request(
      "POST",
      `/api/v1/projects/${project.body.id}/members`,
      {
        kind: "agent",
        agentId: agent.id,
        responsibility: "Execute the workflow task",
        roleIds: [role.body.id],
      },
    );
    expect(member.statusCode).toBe(201);
    const workflow = await request<{ id: string }>(
      "POST",
      "/api/v1/workflows/import",
      {
        projectId: project.body.id,
        markdown: `# 工作流：Workflow external runtime ${randomUUID().slice(0, 8)}

## 元信息

- key: external-workflow-${randomUUID()}
- version: 1

## 节点

### Execute

- id: execute
- type: task
- executor: role:${role.body.id}
- execution: task-worker
- trigger: auto-on-ready

### Review

- id: review
- type: service
- executor: system:manual

## 连接

- execute -> review`,
      },
    );
    expect(workflow.statusCode, JSON.stringify(workflow.body)).toBe(201);
    const started = await request<{
      id: string;
      steps: Array<{ taskId: string | null; runId: string | null }>;
    }>("POST", `/api/v1/workflows/${workflow.body.id}/start`, {
      title: `External workflow run ${randomUUID().slice(0, 8)}`,
    });
    expect(started.statusCode).toBe(201);
    const taskId = started.body.steps[0]?.taskId;
    const runId = started.body.steps[0]?.runId;
    expect(taskId).toBeTruthy();
    expect(runId).toBeTruthy();
    const dispatchSnapshot = await repositories.runs.get(runId!);
    expect(dispatchSnapshot?.executionSnapshot).toMatchObject({
      runtime: {
        id: runtime.id,
        protocol: "codex-jsonl",
        revision: runtime.revision,
      },
      binding: { revision: 1 },
    });
    const job = await repositories.jobs.claimNext(
      "external-workflow-worker",
      60,
      runId!,
    );
    expect(job).toBeDefined();
    await processJob(job!, "external-workflow-worker");
    const completed = await repositories.runs.get(runId!);
    expect(completed).toMatchObject({
      status: "completed",
      externalRuntimeId: runtime.id,
      externalRuntimeProtocol: "codex-jsonl",
      externalSessionId: "codex-session-fixture",
    });
    expect((await repositories.tasks.get(taskId!))?.status).toBe("review");
  });

  it("executes a bound plain-text runtime for AI direct chat", async () => {
    const agent = await createAgent("plain-text");
    const runtime = await createActiveRuntime("plain-text");
    await bind(agent.id, runtime.id);
    const thread = await request<{ id: string }>(
      "POST",
      "/api/v1/direct-chats",
      { agentId: agent.id },
    );
    expect(thread.statusCode).toBe(200);
    const sent = await request<DirectChatSendResult>(
      "POST",
      `/api/v1/direct-chats/${thread.body.id}/messages`,
      {
        content: "Explain the plain runtime",
        clientMessageId: randomUUID(),
      },
    );
    expect(sent.statusCode).toBe(202);
    const job = await repositories.jobs.claimNext(
      "external-direct-chat-worker",
      60,
      sent.body.run.id,
    );
    await processJob(job!, "external-direct-chat-worker");

    const detail = await request<{
      messages: Array<{ senderType: string; content: string }>;
    }>("GET", `/api/v1/direct-chats/${thread.body.id}`);
    expect(detail.statusCode).toBe(200);
    expect(
      detail.body.messages.some(
        (message) =>
          message.senderType === "agent" &&
          message.content.startsWith("PLAIN:") &&
          message.content.includes("Explain the plain runtime"),
      ),
    ).toBe(true);
    const run = await repositories.runs.get(sent.body.run.id);
    expect(run).toMatchObject({
      status: "completed",
      externalRuntimeId: runtime.id,
      externalRuntimeProtocol: "plain-text",
    });
  });

  it("executes a bound Codex runtime for meeting AI participation", async () => {
    const agent = await createAgent("codex-jsonl");
    const runtime = await createActiveRuntime("codex-jsonl");
    await bind(agent.id, runtime.id);
    const project = await request<{ id: string; name: string }>(
      "POST",
      "/api/v1/projects",
      { name: `External meeting ${randomUUID().slice(0, 8)}`, description: "" },
    );
    await request("POST", `/api/v1/projects/${project.body.id}/members`, {
      kind: "agent",
      agentId: agent.id,
      responsibility: "External meeting participant",
      roleIds: [],
    });
    const meeting = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.body.id,
      title: `External meeting ${randomUUID().slice(0, 8)}`,
      agenda: "Use the bound external runtime",
      agentIds: [agent.id],
    });
    expect(meeting.statusCode).toBe(201);
    const policy = await request<MeetingAiPolicy>(
      "GET",
      `/api/v1/meetings/${meeting.body.id}/ai-policy`,
    );
    const enabled = await request<MeetingAiPolicy>(
      "PUT",
      `/api/v1/meetings/${meeting.body.id}/ai-policy`,
      {
        expectedRevision: policy.body.revision,
        status: "active",
        triggerKinds: ["round"],
        cooldownSeconds: 0,
        maxRounds: 3,
        maxMessages: 3,
        runBudgetMs: 5_000,
      },
    );
    expect(enabled.statusCode).toBe(200);
    const triggered = await request<{
      outcome: string;
      turns: Array<{ runId: string | null }>;
    }>("POST", `/api/v1/meetings/${meeting.body.id}/ai-triggers`, {
      kind: "round",
      roundNumber: 1,
      reason: "External runtime participation",
    });
    expect(triggered.statusCode, JSON.stringify(triggered.body)).toBe(202);
    const runId = triggered.body.turns[0]?.runId;
    expect(runId).toBeTruthy();
    const job = await repositories.jobs.claimNext(
      "external-meeting-worker",
      60,
      runId!,
    );
    await processJob(job!, "external-meeting-worker");
    const run = await repositories.runs.get(runId!);
    expect(run).toMatchObject({
      status: "completed",
      externalRuntimeId: runtime.id,
      externalRuntimeProtocol: "codex-jsonl",
      externalSessionId: "codex-session-fixture",
    });
    expect(run?.output).toContain("FINAL:");
  });

  it("cancels a running external direct-chat turn through the runtime effect", async () => {
    const agent = await createAgent("plain-text");
    const runtime = await createActiveRuntime("plain-text", "cancel");
    await bind(agent.id, runtime.id);
    const thread = await request<{ id: string }>(
      "POST",
      "/api/v1/direct-chats",
      { agentId: agent.id },
    );
    const sent = await request<DirectChatSendResult>(
      "POST",
      `/api/v1/direct-chats/${thread.body.id}/messages`,
      {
        content: "Cancel this external run",
        clientMessageId: randomUUID(),
      },
    );
    const job = await repositories.jobs.claimNext(
      "external-cancel-worker",
      60,
      sent.body.run.id,
    );
    expect(job).toBeDefined();
    const running = executor.execute(job!.runId, {
      jobId: job!.id,
      owner: "external-cancel-worker",
      leaseSeconds: 60,
      traceId: job!.traceId,
      jobSpanId: job!.spanId,
      assertLease: async () => undefined,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await repositories.runs.get(job!.runId);
      if (current?.status === "running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    const cancelled = await request(
      "POST",
      `/api/v1/runs/${job!.runId}/cancel`,
    );
    expect(cancelled.statusCode).toBe(202);
    await expect(running).rejects.toMatchObject({ name: "RunCancelledError" });
    const run = await repositories.runs.get(job!.runId);
    expect(run?.status).toBe("cancelled");
  });

  it("times out an external task without creating a successful reply", async () => {
    const agent = await createAgent("plain-text");
    const runtime = await createActiveRuntime("plain-text", "timeout");
    await bind(agent.id, runtime.id);
    const fixture = await taskFixture(agent.id);
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${fixture.taskId}/dispatch`,
    );
    await database.query(
      "UPDATE runs SET timeout_at = NOW() + INTERVAL '150 milliseconds' WHERE id = $1",
      [dispatched.body.runId],
    );
    const job = await repositories.jobs.claimNext(
      "external-timeout-worker",
      60,
      dispatched.body.runId,
    );
    await executor.execute(job!.runId, {
      jobId: job!.id,
      owner: "external-timeout-worker",
      leaseSeconds: 60,
      traceId: job!.traceId,
      jobSpanId: job!.spanId,
      assertLease: async () => undefined,
    });
    const run = await repositories.runs.get(dispatched.body.runId);
    expect(run?.status).toBe("timeout");
    expect(run?.output).toBeNull();
    expect((await repositories.tasks.get(fixture.taskId))?.status).toBe(
      "queued",
    );
  });

  it("refuses to replay an external run after its spawn marker exists", async () => {
    const agent = await createAgent("codex-jsonl");
    const runtime = await createActiveRuntime("codex-jsonl");
    await bind(agent.id, runtime.id);
    const fixture = await taskFixture(agent.id);
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${fixture.taskId}/dispatch`,
    );
    await database.query(
      "UPDATE runs SET external_started_at = NOW() WHERE id = $1",
      [dispatched.body.runId],
    );
    const job = await repositories.jobs.claimNext(
      "external-no-replay-worker",
      60,
      dispatched.body.runId,
    );
    await expect(
      executor.execute(job!.runId, {
        jobId: job!.id,
        owner: "external-no-replay-worker",
        leaseSeconds: 60,
        traceId: job!.traceId,
        jobSpanId: job!.spanId,
        assertLease: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: "RunNonRetryableError" });
    const effects = await database.query<{ status: string }>(
      "SELECT status FROM runtime_effect_receipts WHERE run_id = $1",
      [dispatched.body.runId],
    );
    expect(effects.rows).toEqual([{ status: "failed" }]);
  });
});
