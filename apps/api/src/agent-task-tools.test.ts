import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type Agent,
  type ExecutionGateRecord,
  type Project,
  type RunExecutionEnvelope,
  type Task,
  type TaskAcceptanceEvidenceProjection,
} from "@pluginmax/contracts";
import {
  AgentTaskToolError,
  AgentTaskToolFacade,
  PlatformApplication,
  SceneContextService,
} from "@pluginmax/application";
import {
  Database,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

type ToolCategory = "task.read" | "task.write" | "fs.read" | "fs.write";

integration("M1b controlled Agent tools and Run workspace", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let app: ReturnType<typeof buildApi>["app"];
  let facade: AgentTaskToolFacade;
  let workspaceRoot: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    application = new PlatformApplication(repositories);
    await migrate(database);
    workspaceRoot = await mkdtemp(join(tmpdir(), "pluginmax-m1b-tools-"));
    facade = new AgentTaskToolFacade(repositories, { workspaceRoot });
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: join(workspaceRoot, "files"),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 37,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await repositories.featureFlags.set({
      flagKey: "agent.task_tools",
      scopeType: "platform",
      scopeId: "platform",
      mode: "off",
      updatedBy: "test:cleanup",
    });
    await repositories.featureFlags.set({
      flagKey: "agent.workspace_files",
      scopeType: "platform",
      scopeId: "platform",
      mode: "off",
      updatedBy: "test:cleanup",
    });
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST",
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

  async function createProject(label: string): Promise<Project> {
    const response = await request<Project>("POST", "/api/v1/projects", {
      name: `M1b ${label} ${randomUUID().slice(0, 8)}`,
      description: "M1b controlled tool fixture",
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function createAgent(
    projectId: string,
  ): Promise<{ agent: Agent; principalId: string }> {
    const principalId = `principal-ai-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'ai', 'M1b AI', 'active', 'ai-companion',
                 'ai-companion', 1, NOW(), NOW())`,
      [principalId],
    );
    const created = await request<Agent>("POST", "/api/v1/agents", {
      name: `M1b Agent ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    await database.query(
      "UPDATE agents SET principal_id = $2, updated_at = NOW() WHERE id = $1",
      [created.body.id, principalId],
    );
    const added = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId: created.body.id,
        responsibility: "M1b tool fixture",
        roleIds: [],
      },
    );
    expect(added.statusCode, JSON.stringify(added.body)).toBe(201);
    return {
      agent: (await repositories.agents.get(created.body.id))!,
      principalId,
    };
  }

  async function enableFlags(projectId: string): Promise<void> {
    for (const flagKey of ["agent.task_tools", "agent.workspace_files"]) {
      await repositories.featureFlags.set({
        flagKey,
        scopeType: "project",
        scopeId: projectId,
        mode: "on",
        updatedBy: "test:m1b",
      });
    }
  }

  function toolPolicy(categories: readonly ToolCategory[]) {
    return taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [],
      },
      toolPolicy: {
        allow: [...categories],
        deny: [],
        requireApproval: [],
      },
      humanGates: categories.flatMap((category) =>
        Array.from({ length: 15 }, (_, index) => ({
          id: `${category.replaceAll(".", "-")}-${index}`,
          kind: "tool-approval" as const,
          toolCategory: category,
          enforcement: "blocking" as const,
          reason: `Approve ${category} tool action ${index}`,
        })),
      ),
      budget: { timeoutMs: 60_000 },
    });
  }

  async function taskForRun(input: {
    readonly projectId: string;
    readonly agentId: string;
    readonly categories: readonly ToolCategory[];
  }): Promise<Task> {
    const response = await request<Task>("POST", "/api/v1/tasks", {
      projectId: input.projectId,
      title: `M1b task ${randomUUID().slice(0, 8)}`,
      description: "Controlled tool integration",
      acceptance: ["Secret acceptance should only be returned to the Run"],
      agentId: input.agentId,
      autoSubmit: false,
    });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    const saved = await repositories.taskExecutionPolicies.replace({
      contextType: "task",
      contextId: response.body.id,
      projectId: input.projectId,
      expectedRevision: 0,
      policy: toolPolicy(input.categories),
      actorId: "local-admin",
    });
    expect(saved.kind).toBe("saved");
    return response.body;
  }

  async function runFor(input: {
    readonly projectId: string;
    readonly agentId: string;
    readonly agentPrincipalId: string;
    readonly taskId: string;
    readonly categories: readonly ToolCategory[];
    readonly approveGates?: boolean;
  }): Promise<{
    readonly runId: string;
    readonly attempt: number;
    readonly sceneSessionId: string;
    readonly gates: readonly ExecutionGateRecord[];
    readonly envelope: RunExecutionEnvelope;
  }> {
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${input.taskId}/dispatch`,
    );
    expect(dispatched.statusCode, JSON.stringify(dispatched.body)).toBe(202);
    const run = (await repositories.runs.get(dispatched.body.runId))!;
    expect(run.executionEnvelope).not.toBeNull();
    const project = (await repositories.projects.get(input.projectId))!;
    const task = (await repositories.tasks.get(input.taskId))!;
    const agent = (await repositories.agents.get(input.agentId))!;
    const sceneContext = new SceneContextService(repositories);
    const prepared = await sceneContext.prepare({
      run,
      project,
      task,
      agent,
      meetingContext: null,
      directChatContext: null,
      episodes: [],
    });
    await sceneContext.commit(prepared);
    await repositories.teammates.bindRunSceneSession(run.id, prepared.binding.id);
    const bundle = (await repositories.actionTickets.getBundle(run.id))!;
    if (input.approveGates ?? true) {
      for (const gate of bundle.gates) {
        const decision = await repositories.actionTickets.decide({
          gateId: gate.gateId,
          decision: "approve",
          decidedByPrincipalId: "local-admin",
          basis: "M1b deterministic test approval",
        });
        expect(decision.kind).toBe("recorded");
      }
      await repositories.runs.markRunning(run.id);
    }
    const current = (await repositories.runs.get(run.id))!;
    if (input.approveGates ?? true) {
      expect(current.status).toBe("running");
    }
    return {
      runId: current.id,
      attempt: current.attempt,
      sceneSessionId: prepared.binding.id,
      gates: await repositories.actionTickets.listGatesByRun(current.id),
      envelope: current.executionEnvelope!,
    };
  }

  async function fixture(
    categories: readonly ToolCategory[],
    options: { readonly approveGates?: boolean } = {},
  ) {
    const project = await createProject(categories.join("-"));
    await enableFlags(project.id);
    const { agent, principalId } = await createAgent(project.id);
    const task = await taskForRun({
      projectId: project.id,
      agentId: agent.id,
      categories,
    });
    const run = await runFor({
      projectId: project.id,
      agentId: agent.id,
      agentPrincipalId: principalId,
      taskId: task.id,
      categories,
      ...(options.approveGates === undefined
        ? {}
        : { approveGates: options.approveGates }),
    });
    const gates = (category: ToolCategory) =>
      run.gates.filter((gate) => gate.requestedToolCategory === category);
    return {
      project,
      agent,
      agentPrincipalId: principalId,
      task,
      run,
      gates,
      proof: {
        runId: run.runId,
        runAttempt: run.attempt,
        sceneSessionId: run.sceneSessionId,
      },
    };
  }

  function filePath(runId: string, relativePath: string): string {
    return join(workspaceRoot, "runs", runId, relativePath);
  }

  it("derives Actor, Run, Task, Scene and Principal from the server and rejects self-reported identity", async () => {
    const current = await fixture(["fs.write"]);
    const gate = current.gates("fs.write")[0]!;
    await expect(
      facade.invoke(current.proof, {
        tool: "write_file",
        idempotencyKey: `forged-${randomUUID()}`,
        gateId: gate.gateId,
        payload: {
          path: "forged.txt",
          content: "must-not-exist",
          actor: "attacker",
          projectId: randomUUID(),
          runId: randomUUID(),
        },
      } as never),
    ).rejects.toMatchObject({
      code: "agent_tool_invalid_arguments",
    } satisfies Partial<AgentTaskToolError>);
    await expect(
      facade.invoke(
        { ...current.proof, sceneSessionId: randomUUID() },
        {
          tool: "write_file",
          idempotencyKey: `scene-${randomUUID()}`,
          gateId: gate.gateId,
          payload: { path: "forged.txt", content: "must-not-exist" },
        },
      ),
    ).rejects.toMatchObject({
      code: "scene_session_identity_mismatch",
    } satisfies Partial<AgentTaskToolError>);
    await expect(
      facade.invoke(
        { ...current.proof, runAttempt: current.proof.runAttempt + 1 },
        {
          tool: "write_file",
          idempotencyKey: `attempt-${randomUUID()}`,
          gateId: gate.gateId,
          payload: { path: "forged.txt", content: "must-not-exist" },
        },
      ),
    ).rejects.toMatchObject({
      code: "agent_tool_run_attempt_mismatch",
    } satisfies Partial<AgentTaskToolError>);
    await expect(readFile(filePath(current.run.runId, "forged.txt"))).rejects.toThrow();
  });

  it("defaults to deny without an Execution Envelope or Gate", async () => {
    const project = await createProject("missing");
    const { agent } = await createAgent(project.id);
    await enableFlags(project.id);
    const task = await taskForRun({
      projectId: project.id,
      agentId: agent.id,
      categories: ["task.read"],
    });
    const missingEnvelopeRunId = randomUUID();
    await repositories.runs.enqueue({
      runId: missingEnvelopeRunId,
      task,
      inputSnapshot: {
        taskTitle: task.title,
        taskDescription: task.description,
        acceptance: task.acceptance,
        instruction: task.description,
        agentName: agent.name,
        runtimeKind: agent.runtimeKind,
      },
    });
    await expect(
      facade.invoke(
        {
          runId: missingEnvelopeRunId,
          runAttempt: 1,
          sceneSessionId: randomUUID(),
        },
        {
          tool: "task_query",
          idempotencyKey: `missing-envelope-${randomUUID()}`,
          payload: { includeRuns: false },
        },
      ),
    ).rejects.toMatchObject({
      code: "execution_envelope_missing",
    } satisfies Partial<AgentTaskToolError>);

    const current = await fixture(["fs.write"]);
    await expect(
      facade.invoke(current.proof, {
        tool: "write_file",
        idempotencyKey: `missing-gate-${randomUUID()}`,
        payload: { path: "missing-gate.txt", content: "blocked" },
      }),
    ).rejects.toMatchObject({
      code: "execution_gate_missing",
    } satisfies Partial<AgentTaskToolError>);
  });

  it("rejects cross-Run and re-used Gate resources", async () => {
    const first = await fixture(["fs.write"]);
    const second = await fixture(["fs.write"]);
    const firstGate = first.gates("fs.write")[0]!;

    await expect(
      facade.invoke(second.proof, {
        tool: "write_file",
        idempotencyKey: `cross-run-${randomUUID()}`,
        gateId: firstGate.gateId,
        payload: { path: "cross-run.txt", content: "blocked" },
      }),
    ).rejects.toMatchObject({
      code: "execution_gate_scope_mismatch",
    } satisfies Partial<AgentTaskToolError>);
    const reusable = await fixture(["fs.write"]);
    const theGate = reusable.gates("fs.write")[0]!;
    const originalKey = `gate-use-${randomUUID()}`;
    const written = await facade.invoke(reusable.proof, {
      tool: "write_file",
      idempotencyKey: originalKey,
      gateId: theGate.gateId,
      payload: { path: "first-resource.txt", content: "first" },
    });
    expect(written.status).toBe("succeeded");
    await expect(
      facade.invoke(reusable.proof, {
        tool: "write_file",
        idempotencyKey: `second-resource-${randomUUID()}`,
        gateId: theGate.gateId,
        payload: { path: "second-resource.txt", content: "second" },
      }),
    ).rejects.toMatchObject({
      code: "execution_gate_already_used",
    } satisfies Partial<AgentTaskToolError>);
    await expect(
      readFile(filePath(reusable.run.runId, "second-resource.txt")),
    ).rejects.toThrow();
  });

  it("cannot bypass denied, expired or cancelled Gates on retry", async () => {
    for (const decision of ["denied", "expired", "cancelled"] as const) {
      const current = await fixture(["fs.write"], { approveGates: false });
      const gate = current.gates("fs.write")[0]!;
      if (decision === "denied") {
        await repositories.actionTickets.decide({
          gateId: gate.gateId,
          decision: "reject",
          decidedByPrincipalId: "local-admin",
          basis: "M1b denied Gate fixture",
        });
      } else if (decision === "cancelled") {
        await repositories.actionTickets.decide({
          gateId: gate.gateId,
          decision: "cancel",
          decidedByPrincipalId: "local-admin",
          basis: "M1b cancelled Gate fixture",
        });
      }
      await database.query(
        "UPDATE runs SET status = 'running', ended_at = NULL WHERE id = $1",
        [current.run.runId],
      );
      const activeFacade =
        decision === "expired"
          ? new AgentTaskToolFacade(repositories, {
              workspaceRoot,
              now: () => new Date("2099-01-01T00:00:00.000Z"),
            })
          : facade;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          activeFacade.invoke(current.proof, {
            tool: "write_file",
            idempotencyKey: `${decision}-retry-${attempt}-${randomUUID()}`,
            gateId: gate.gateId,
            payload: {
              path: `${decision}-${attempt}.txt`,
              content: "must-not-exist",
            },
          }),
        ).rejects.toMatchObject({
          code:
            decision === "denied"
              ? "execution_gate_denied"
              : decision === "expired"
                ? "execution_gate_expired"
                : "execution_gate_cancelled",
        } satisfies Partial<AgentTaskToolError>);
      }
      await expect(
        readFile(filePath(current.run.runId, `${decision}-0.txt`)),
      ).rejects.toThrow();
    }
  });

  it("writes atomically, replays the same idempotency key, and never records sensitive content", async () => {
    const current = await fixture(["fs.write", "fs.read"]);
    const writeGates = current.gates("fs.write");
    const writeGate = writeGates[0]!;
    const secret = `sensitive-body-${randomUUID()}`;
    const key = `write-replay-${randomUUID()}`;
    const first = await facade.invoke(current.proof, {
      tool: "write_file",
      idempotencyKey: key,
      gateId: writeGate.gateId,
      payload: { path: "artifacts/result.txt", content: secret },
    });
    expect(first).toMatchObject({
      status: "succeeded",
      deduplicated: false,
      result: { atomic: true },
    });
    expect(
      await readFile(filePath(current.run.runId, "artifacts/result.txt"), "utf8"),
    ).toBe(secret);
    const replay = await facade.invoke(current.proof, {
      tool: "write_file",
      idempotencyKey: key,
      gateId: writeGate.gateId,
      payload: { path: "artifacts/result.txt", content: secret },
    });
    expect(replay.deduplicated).toBe(true);
    const invocationCount = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tool_invocations WHERE run_id = $1",
      [current.run.runId],
    );
    expect(invocationCount.rows[0]?.count).toBe("1");

    const events = await database.query<{
      summary: string;
      data: Record<string, unknown> | null;
    }>(
      `SELECT summary, data
       FROM run_events
       WHERE run_id = $1 AND type IN ('tool.call', 'tool.result')`,
      [current.run.runId],
    );
    expect(JSON.stringify(events.rows)).not.toContain(secret);
    const invocations = await database.query<{
      result: Record<string, unknown> | null;
    }>(
      "SELECT result FROM tool_invocations WHERE run_id = $1",
      [current.run.runId],
    );
    expect(JSON.stringify(invocations.rows)).not.toContain(secret);
    const auditProjection = await request<{ items: unknown[] }>(
      "GET",
      `/api/v1/runs/${current.run.runId}/tool-invocations`,
    );
    expect(auditProjection.statusCode).toBe(200);
    expect(auditProjection.body.items).toHaveLength(1);

    const readGate = current.gates("fs.read")[0]!;
    const read = await facade.invoke(current.proof, {
      tool: "read_file",
      idempotencyKey: `read-${randomUUID()}`,
      gateId: readGate.gateId,
      payload: { path: "artifacts/result.txt" },
    });
    expect(read.result.content).toBe(secret);
    const list = await facade.invoke(current.proof, {
      tool: "list_files",
      idempotencyKey: `list-${randomUUID()}`,
      gateId: current.gates("fs.read")[1]!.gateId,
      payload: { path: ".", depth: 2 },
    });
    expect(list.result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "artifacts/result.txt",
          type: "file",
        }),
      ]),
    );
    const readEvents = await database.query<{ data: unknown }>(
      `SELECT data FROM run_events
       WHERE run_id = $1 AND type = 'tool.result'`,
      [current.run.runId],
    );
    expect(JSON.stringify(readEvents.rows)).not.toContain(secret);
  });

  it("rejects traversal, symlinks, limit violations and leaves prior content intact", async () => {
    const current = await fixture(["fs.write", "fs.read"]);
    const writeGates = current.gates("fs.write");
    const safeGate = writeGates[0]!;
    await facade.invoke(current.proof, {
      tool: "write_file",
      idempotencyKey: `safe-${randomUUID()}`,
      gateId: safeGate.gateId,
      payload: { path: "safe.txt", content: "safe" },
    });
    const invalidPaths = ["/etc/passwd", "../escape", "a\u0000b", "a\\b"];
    for (const [index, path] of invalidPaths.entries()) {
      await expect(
        facade.invoke(current.proof, {
          tool: "write_file",
          idempotencyKey: `invalid-${index}-${randomUUID()}`,
          gateId: writeGates[index + 1]!.gateId,
          payload: { path, content: "blocked" },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^workspace_path_/) });
    }
    await expect(
      facade.invoke(current.proof, {
        tool: "write_file",
        idempotencyKey: `oversize-${randomUUID()}`,
        gateId: writeGates[10]!.gateId,
        payload: {
          path: "safe.txt",
          content: "x".repeat(1024 * 1024 + 1),
        },
      }),
    ).rejects.toMatchObject({
      code: "workspace_write_limit_exceeded",
    } satisfies Partial<AgentTaskToolError>);
    expect(await readFile(filePath(current.run.runId, "safe.txt"), "utf8")).toBe(
      "safe",
    );

    const outside = join(workspaceRoot, `outside-${randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(
      outside,
      filePath(current.run.runId, "linked-directory"),
    );
    await expect(
      facade.invoke(current.proof, {
        tool: "read_file",
        idempotencyKey: `symlink-${randomUUID()}`,
        gateId: current.gates("fs.read")[0]!.gateId,
        payload: { path: "linked-directory/secret.txt" },
      }),
    ).rejects.toMatchObject({
      code: "workspace_symlink_rejected",
    } satisfies Partial<AgentTaskToolError>);
  });

  it("covers task query, comment, input request and deliverable evidence", async () => {
    const current = await fixture(["task.read", "task.write"]);
    const readGate = current.gates("task.read")[0]!;
    const query = await facade.invoke(current.proof, {
      tool: "task_query",
      idempotencyKey: `query-${randomUUID()}`,
      gateId: readGate.gateId,
      payload: { includeRuns: true },
    });
    expect(query.result.task).toMatchObject({ id: current.task.id });

    const writeGates = current.gates("task.write");
    const comment = await facade.invoke(current.proof, {
      tool: "task_comment",
      idempotencyKey: `comment-${randomUUID()}`,
      gateId: writeGates[0]!.gateId,
      payload: { content: "Sensitive comment body", isKeyConsensus: true },
    });
    expect(comment.result.messageId).toEqual(expect.any(String));
    const input = await facade.invoke(current.proof, {
      tool: "task_request_input",
      idempotencyKey: `input-${randomUUID()}`,
      gateId: writeGates[1]!.gateId,
      payload: { prompt: "Sensitive clarification body" },
    });
    expect(input.result.status).toBe("needs_input");
    await expect(readFile(filePath(current.run.runId, "none.txt"))).rejects.toThrow();

    await repositories.featureFlags.set({
      flagKey: "task.evidence_review",
      scopeType: "project",
      scopeId: current.project.id,
      mode: "enforce",
      updatedBy: "test:m1b",
    });
    await database.query(
      `UPDATE runs
       SET status = 'completed', output = 'deliverable', ended_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [current.run.runId],
    );
    const evidence = await application.getTaskAcceptanceEvidence(current.task.id);
    const item = evidence.items[0]!;
    const delivered = await facade.invoke(current.proof, {
      tool: "task_submit_deliverable",
      idempotencyKey: `deliverable-${randomUUID()}`,
      gateId: writeGates[2]!.gateId,
      payload: {
        summary: "Sensitive deliverable summary",
        items: [
          {
            acceptanceItemId: item.id,
            acceptanceItemRevision: item.revision,
            evidenceRefs: [
              { kind: "run-output", refId: current.run.runId },
            ],
          },
        ],
      },
    });
    expect(delivered.result.allRequiredConfirmed).toBe(true);
    const confirmed: TaskAcceptanceEvidenceProjection =
      await application.getTaskAcceptanceEvidence(current.task.id);
    expect(confirmed.items[0]?.currentConfirmation?.confirmedByPrincipalId).toBe(
      current.agentPrincipalId,
    );
    const eventData = await database.query<{ data: unknown }>(
      `SELECT data FROM run_events
       WHERE run_id = $1 AND type = 'tool.result'`,
      [current.run.runId],
    );
    expect(JSON.stringify(eventData.rows)).not.toContain(
      "Sensitive comment body",
    );
    expect(JSON.stringify(eventData.rows)).not.toContain(
      "Sensitive deliverable summary",
    );
  });

  it("blocks new side effects when its Feature Flag is disabled", async () => {
    const current = await fixture(["fs.write"]);
    const gate = current.gates("fs.write")[0]!;
    await repositories.featureFlags.set({
      flagKey: "agent.workspace_files",
      scopeType: "project",
      scopeId: current.project.id,
      mode: "off",
      updatedBy: "test:m1b",
    });
    await expect(
      facade.invoke(current.proof, {
        tool: "write_file",
        idempotencyKey: `flag-off-${randomUUID()}`,
        gateId: gate.gateId,
        payload: { path: "flag-off.txt", content: "blocked" },
      }),
    ).rejects.toMatchObject({
      code: "agent_tool_feature_disabled",
    } satisfies Partial<AgentTaskToolError>);
    await expect(
      readFile(filePath(current.run.runId, "flag-off.txt")),
    ).rejects.toThrow();
  });
});
