import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
} from "@pluginmax/contracts";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { TaskExecutionPolicyRepository } from "./task-execution-policy-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("task execution policy persistence", () => {
  let database: Database;
  let policies: TaskExecutionPolicyRepository;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    policies = new TaskExecutionPolicyRepository(database);
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         'policy-test-owner', 'human', 'Policy Owner', 'active', 'system',
         'local', 1, NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("uses legacy defaults and stores immutable revisions with optimistic locks", async () => {
    const contextId = randomUUID();
    const projectId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'Policy revision project', $2, '', 'active', NOW(), NOW())`,
      [projectId, `POLICY-${projectId.slice(0, 8)}`],
    );
    const initial = await policies.resolve({
      contextType: "task",
      contextId,
      projectId,
    });
    expect(initial).toMatchObject({
      id: null,
      revision: 0,
      source: "legacy",
    });
    expect(initial.policy).toEqual(legacyTaskExecutionPolicy());

    const policy = taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [
          { key: "structured-plan", necessity: "required" },
        ],
      },
      toolPolicy: {
        allow: ["search.web"],
        deny: ["shell.execute"],
      },
      budget: { timeoutMs: 30_000, maxTurns: 3 },
    });
    const first = await policies.replace({
      contextType: "task",
      contextId,
      projectId,
      expectedRevision: 0,
      policy,
      actorId: "policy-test-owner",
    });
    expect(first).toMatchObject({
      kind: "saved",
      record: { revision: 1 },
    });

    const conflict = await policies.replace({
      contextType: "task",
      contextId,
      projectId,
      expectedRevision: 0,
      policy,
      actorId: "policy-test-owner",
    });
    expect(conflict).toEqual({ kind: "revision_conflict", currentRevision: 1 });

    const second = await policies.replace({
      contextType: "task",
      contextId,
      projectId,
      expectedRevision: 1,
      policy: {
        ...policy,
        budget: { ...policy.budget, maxTurns: 2 },
      },
      actorId: "policy-test-owner",
    });
    expect(second).toMatchObject({
      kind: "saved",
      record: { revision: 2 },
    });
    expect(
      await policies.getRevision(
        first.kind === "saved" ? first.record.id : "missing",
        1,
      ),
    ).toMatchObject({ revision: 1, policy: { budget: { maxTurns: 3 } } });

    await expect(
      database.query(
        "UPDATE task_execution_policies SET revision = revision WHERE context_id = $1",
        [contextId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("falls back from task context to the project default", async () => {
    const projectId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'Policy project', $2, '', 'active', NOW(), NOW())`,
      [projectId, `POL-${projectId.slice(0, 8)}`],
    );
    const policy = taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
      },
    });
    await policies.replace({
      contextType: "project",
      contextId: projectId,
      projectId,
      expectedRevision: 0,
      policy,
      actorId: "policy-test-owner",
    });

    const resolved = await policies.resolve({
      contextType: "task",
      contextId: randomUUID(),
      projectId,
    });
    expect(resolved).toMatchObject({
      revision: 1,
      source: "project-default",
      policy: { runtime: { allowedRuntimeIds: ["builtin:fake"] } },
    });
  });

  it("keeps the persisted Run execution envelope immutable", async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'Envelope project', $2, '', 'active', NOW(), NOW())`,
      [projectId, `ENV-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'Envelope task', 'test', '[]'::jsonb, 'queued',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, projectId],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         execution_context_type, execution_context_id,
         execution_policy_revision, execution_binding_revision,
         execution_runtime_revision, execution_envelope_snapshot,
         observability, attempt, created_at, updated_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001', 'queued',
         '{}'::jsonb, 'task', $4, 0, 1, 1, '{"digest":"fixture"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW(), NOW()
       )`,
      [runId, projectId, taskId, taskId],
    );

    await expect(
      database.query(
        `UPDATE runs
         SET execution_envelope_snapshot = '{"digest":"changed"}'::jsonb
         WHERE id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/immutable/);
  });
});
