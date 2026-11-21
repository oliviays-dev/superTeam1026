import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PlanningArtifact,
  PlanningOverview,
  PlanningRunDetail,
  PlanningSettings,
  Project,
  Task,
  WorkflowGraph,
  WorkflowPlanDetail,
} from "@pluginmax/contracts";
import {
  PlanningRuntimeWorker,
  type PlanningPlanner,
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

integration("M10a Planning Runtime control plane", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m10a-planning-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    expectedStatus?: number,
  ): Promise<T> {
    const response = await inject(method, url, payload);
    if (expectedStatus !== undefined) {
      expect(response.statusCode, response.body).toBe(expectedStatus);
    } else {
      expect(
        response.statusCode,
        `${method} ${url}: ${response.body}`,
      ).toBeLessThan(400);
    }
    return response.body === "" ? (undefined as T) : (response.json() as T);
  }

  async function inject(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
  ) {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": "local-admin" },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    return app.inject(options);
  }

  async function createRootTask(): Promise<{
    project: Project;
    task: Task;
  }> {
    const project = await request<Project>(
      "POST",
      "/api/v1/projects",
      {
        name: `M10a Planning ${randomUUID().slice(0, 8)}`,
        description: "",
      },
      201,
    );
    const task = await request<Task>(
      "POST",
      "/api/v1/tasks",
      {
        projectId: project.id,
        title: `Planning root ${randomUUID().slice(0, 8)}`,
        description: "M10a planning root task",
        acceptance: ["Planning completes under control-plane rules"],
        agentId: "00000000-0000-4000-8000-000000000001",
      },
      201,
    );
    return { project, task };
  }

  async function enableManualPlanning(projectId: string): Promise<void> {
    const settings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${projectId}/planning/settings`,
    );
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${projectId}/planning/settings`,
      {
        expectedRevision: settings.policy.revision,
        flags: { manual: true },
      },
    );
  }

  function planGraph(
    task: Task,
    options: {
      readonly acceptance?: readonly string[];
      readonly description?: string;
      readonly approvers?: WorkflowGraph["nodes"][number]["approvers"];
    } = {},
  ): WorkflowGraph {
    return {
      key: `manual:${task.id}`,
      version: 1,
      name: `Manual plan ${task.id.slice(0, 8)}`,
      description: task.description,
      nodes: [
        {
          id: "deliver",
          name: "Deliver root task",
          type: "task",
          executor: { kind: "agent", id: task.agentId },
          description:
            options.description ??
            `Complete ${task.title} and provide verifiable evidence.`,
          acceptance: [...(options.acceptance ?? task.acceptance)],
          approvers: options.approvers ?? [],
          approvalPolicy: "all",
          autoDispatch: false,
          start: true,
          maxAttempts: 1,
          timeoutSeconds: 900,
        },
      ],
      edges: [],
      startNodeIds: ["deliver"],
      warnings: [],
    };
  }

  it("keeps planning and router worker flags off by default", async () => {
    const { project, task } = await createRootTask();
    const settings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${project.id}/planning/settings`,
    );
    expect(settings.manual.enabled).toBe(false);
    expect(settings.autopilot.enabled).toBe(false);
    expect(settings.policy.config.requireHumanReview).toBe(true);
    const response = await inject(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Flag-off start must fail" },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "planning_manual_disabled" });
    await expect(
      repositories.planning.startRun({
        taskId: task.id,
        actorId: "local-admin",
        triggerKind: "agent-assigned",
        reason: "Autopilot must remain disabled",
      }),
    ).rejects.toMatchObject({ code: "planning_autopilot_disabled" });
    const routerGate = await request<{ enabled: boolean }>(
      "GET",
      `/api/v1/projects/${project.id}/router-gate`,
    );
    expect(routerGate.enabled).toBe(false);
  });

  it("enforces Trigger Policy independently from the autopilot flag", async () => {
    const { project, task } = await createRootTask();
    const settings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${project.id}/planning/settings`,
    );
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${project.id}/planning/settings`,
      {
        expectedRevision: settings.policy.revision,
        flags: { autopilot: true },
      },
    );
    await expect(
      repositories.planning.startRun({
        taskId: task.id,
        actorId: "local-admin",
        triggerKind: "agent-assigned",
        reason: "Policy must reject a disabled trigger",
      }),
    ).rejects.toMatchObject({ code: "planning_trigger_disabled" });
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${project.id}/planning/settings`,
      {
        expectedRevision: settings.policy.revision,
        policy: { triggerPolicy: { agentAssigned: true } },
      },
    );
    const started = await repositories.planning.startRun({
      taskId: task.id,
      actorId: "local-admin",
      triggerKind: "agent-assigned",
      reason: "Policy now allows agent assignment",
    });
    expect(started.created).toBe(true);
  });

  it("deduplicates a stable trigger and keeps one active run per root task", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const starts = await Promise.all(
      Array.from({ length: 6 }, () =>
        request<PlanningRunDetail>(
          "POST",
          `/api/v1/tasks/${task.id}/planning/start`,
          {
            expectedTaskRevision: task.revision,
            reason: "Stable trigger replay",
          },
          201,
        ),
      ),
    );
    expect(new Set(starts.map((item) => item.run.id)).size).toBe(1);
    expect(starts[0]!.receipts).toHaveLength(1);
    expect(starts[0]!.run.status).toBe("preparing");
    const count = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM planning_runs
       WHERE root_task_id = $1
         AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
      [task.id],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("merges a distinct trigger into the active run", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Initial trigger" },
      201,
    );
    const merged = await repositories.planning.startRun({
      taskId: task.id,
      actorId: "local-admin",
      triggerKind: "replan-requested",
      reason: "Merged replan trigger",
    });
    expect(merged.created).toBe(false);
    expect(merged.merged).toBe(true);
    expect(merged.detail.run.id).toBe(started.run.id);
    expect(merged.detail.run.triggerCount).toBe(2);
    expect(merged.detail.receipts).toHaveLength(2);
    expect(merged.detail.events.map((event) => event.kind)).toContain(
      "trigger.merged",
    );
  });

  it("uses revision CAS for pause and cancellation", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "CAS fixture" },
      201,
    );
    const paused = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/pause`,
      {
        expectedRevision: started.run.revision,
        reason: "Pause fixture",
      },
    );
    expect(paused.run.status).toBe("paused");
    const conflict = await inject(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/pause`,
      {
        expectedRevision: started.run.revision,
        reason: "Stale pause",
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "planning_run_revision_conflict",
    });
    const resumed = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/start`,
      {
        expectedRevision: paused.run.revision,
        reason: "Resume fixture",
      },
    );
    const firstReview = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/review-required`,
      {
        expectedRevision: resumed.run.revision,
        reason: "First review fixture",
      },
    );
    const firstRetry = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/retry`,
      {
        expectedRevision: firstReview.run.revision,
        reason: "First in-place retry",
      },
    );
    const secondReview = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/review-required`,
      {
        expectedRevision: firstRetry.run.revision,
        reason: "Second review fixture",
      },
    );
    const secondRetry = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/retry`,
      {
        expectedRevision: secondReview.run.revision,
        reason: "Second in-place retry",
      },
    );
    expect(secondRetry.run.id).toBe(started.run.id);
    const cancelled = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/cancel`,
      {
        expectedRevision: secondRetry.run.revision,
        reason: "Cancel fixture",
      },
    );
    expect(cancelled.run.status).toBe("cancelled");
    const retried = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/retry`,
      {
        expectedRevision: cancelled.run.revision,
        reason: "Retry after terminal",
      },
    );
    expect(retried.run.id).not.toBe(started.run.id);
    expect(retried.run.sourceRunId).toBe(started.run.id);
  });

  it("rejects forged scope fields and router plans without provenance", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    for (const forged of [
      { projectId: project.id },
      { rootTaskId: task.id },
      { planningRunId: randomUUID() },
      { agentPrincipalId: "agent:forged" },
    ]) {
      const response = await inject(
        "POST",
        `/api/v1/tasks/${task.id}/planning/start`,
        { reason: "forged", ...forged },
      );
      expect(response.statusCode).toBe(400);
    }
    const graph: WorkflowGraph = {
      key: "missing-planning-run",
      version: 1,
      name: "Router plan without run",
      description: "",
      nodes: [
        {
          id: "a",
          name: "A",
          type: "task",
          executor: {
            kind: "agent",
            id: "00000000-0000-4000-8000-000000000001",
          },
          description: "A",
          acceptance: ["A accepted"],
          approvers: [],
          approvalPolicy: "all",
          autoDispatch: false,
          start: true,
          maxAttempts: 1,
          timeoutSeconds: 300,
        },
      ],
      edges: [],
      startNodeIds: ["a"],
      warnings: [],
    };
    const response = await inject(
      "POST",
      `/api/v1/tasks/${task.id}/plans`,
      {
        rootTaskId: task.id,
        source: "router",
        graph,
        settings: {
          maxNodes: 20,
          maxDepth: 10,
          maxOutDegree: 5,
          maxConcurrency: 2,
        },
        reason: "must be rejected",
      },
    );
    expect(response.statusCode).toBe(400);
  });

  it("stores immutable artifacts and quality metrics", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Artifact fixture" },
      201,
    );
    const artifact = await repositories.planning.recordArtifact({
      runId: started.run.id,
      actorId: "local-admin",
      kind: "critic",
      payload: {
        verdict: "pass",
        score: 92,
        summary: "Artifact is structurally valid.",
        findings: [],
        checks: [
          {
            code: "structure",
            status: "pass",
            message: "Graph structure is valid.",
          },
        ],
      },
    });
    expect(artifact.version).toBe(1);
    await expect(
      database.query(
        `UPDATE planning_artifacts
         SET payload = '{"tampered":true}'::jsonb
         WHERE id = $1`,
        [artifact.id],
      ),
    ).rejects.toThrow(/immutable/);
    const metric = await repositories.planning.recordQualityMetric({
      runId: started.run.id,
      actorId: "local-admin",
      criticScore: 92,
      validatorErrorCount: 0,
      acceptanceCoverage: 1,
      nodeCount: 1,
      depth: 1,
      humanReviewRequired: true,
      autoApproveEligible: false,
    });
    expect(metric.version).toBe(1);
    const detail = await repositories.planning.getRunDetail(started.run.id);
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.qualityMetrics).toHaveLength(1);
  });

  it("returns status and basis through the task planning overview", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Overview fixture" },
      201,
    );
    const overview = await request<PlanningOverview>(
      "GET",
      `/api/v1/tasks/${task.id}/planning`,
    );
    expect(overview.activeRun?.run.id).toBe(started.run.id);
    expect(overview.latestRun?.run.id).toBe(started.run.id);
    expect(overview.activeRun?.receipts).toHaveLength(1);
    expect(overview.activeRun?.events.map((event) => event.kind)).toContain(
      "run.created",
    );
  });

  it("enforces plan-first for an agent root task and binds the generated plan atomically", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);

    const required = await inject(
      "POST",
      `/api/v1/tasks/${task.id}/dispatch`,
    );
    expect(required.statusCode).toBe(409);
    expect(required.json()).toMatchObject({ code: "planning-required" });

    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Plan-first runtime fixture" },
      201,
    );
    const running = await inject(
      "POST",
      `/api/v1/tasks/${task.id}/dispatch`,
    );
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ code: "planning-running" });

    const completed = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/run`,
    );
    expect(completed.run.status).toBe("succeeded");
    expect(completed.run.workflowPlanId).not.toBeNull();
    expect(
      completed.artifacts.map((artifact) => artifact.kind),
    ).toEqual(
      expect.arrayContaining([
        "context-pack",
        "requirement-brief",
        "facts-ledger",
        "skill-snapshot",
        "knowledge-receipt",
        "plan-draft",
        "critic",
      ]),
    );

    const plan = await request<WorkflowPlanDetail>(
      "GET",
      `/api/v1/task-plans/${completed.run.workflowPlanId}`,
    );
    expect(plan.plan.planningRunId).toBe(completed.run.id);
    expect(plan.version.version).toBe(1);
    expect(plan.plan.source).toBe("router");

    const bound = await database.query<{
      run_status: string;
      plan_id: string;
      version: number;
      planning_run_id: string;
    }>(
      `SELECT run.status AS run_status, plan.id AS plan_id,
              plan.current_version AS version, plan.planning_run_id
       FROM planning_runs AS run
       JOIN workflow_plans AS plan ON plan.id = run.workflow_plan_id
       WHERE run.id = $1`,
      [completed.run.id],
    );
    expect(bound.rows[0]).toMatchObject({
      run_status: "succeeded",
      plan_id: completed.run.workflowPlanId,
      version: 1,
      planning_run_id: completed.run.id,
    });

    const review = await request<{
      ready: boolean;
      code: string;
      planId: string;
    }>(
      "GET",
      `/api/v1/tasks/${task.id}/dispatch-readiness`,
    );
    expect(review).toMatchObject({
      ready: false,
      code: "planning-review-required",
      planId: completed.run.workflowPlanId,
    });
    const unconfirmed = await inject(
      "POST",
      `/api/v1/tasks/${task.id}/dispatch`,
    );
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      code: "planning-review-required",
    });

    const approved = await repositories.workflowPlans.approvePlan({
      planId: plan.plan.id,
      expectedRevision: plan.plan.revision,
      actorId: "local-admin",
      role: "DELIVERY_LEAD",
    });
    expect(approved.plan.status).toBe("approved");
    const ready = await request<{ ready: boolean }>(
      "GET",
      `/api/v1/tasks/${task.id}/dispatch-readiness`,
    );
    expect(ready.ready).toBe(true);
    const materialized = await request<WorkflowPlanDetail>(
      "POST",
      `/api/v1/task-plans/${plan.plan.id}/materialize`,
      {
        expectedRevision: approved.plan.revision,
        expectedGateEpoch: 0,
      },
    );
    expect(materialized.plan.status).toBe("active");
    expect(materialized.materializations).toHaveLength(1);
    expect(materialized.materializations[0]?.taskId).not.toBeNull();
  });

  it("does not force planning for a root task assigned to a human role", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const role = await request<{ id: string }>(
      "POST",
      `/api/v1/projects/${project.id}/roles`,
      {
        code: "HUMAN_OWNER",
        name: "Human Owner",
        category: "execution",
        description: "Human-owned task.",
        permissions: ["read", "write"],
      },
      201,
    );
    const owner = await database.query<{ id: string }>(
      `SELECT id
       FROM project_members
       WHERE project_id = $1 AND kind = 'human' AND is_owner = TRUE
       LIMIT 1`,
      [project.id],
    );
    await database.query(
      `INSERT INTO project_member_roles (project_member_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [owner.rows[0]!.id, role.id],
    );
    await database.query(
      "UPDATE tasks SET role_id = $2 WHERE id = $1",
      [task.id, role.id],
    );

    const readiness = await request<{ ready: boolean }>(
      "GET",
      `/api/v1/tasks/${task.id}/dispatch-readiness`,
    );
    expect(readiness.ready).toBe(true);
  });

  it("blocks dispatch safely when Planning Flags close over an active Run", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Safe-stop fixture" },
      201,
    );
    const settings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${project.id}/planning/settings`,
    );
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${project.id}/planning/settings`,
      {
        expectedRevision: settings.policy.revision,
        flags: { manual: false },
      },
    );
    const readiness = await request<{ ready: boolean; code: string }>(
      "GET",
      `/api/v1/tasks/${task.id}/dispatch-readiness`,
    );
    expect(readiness).toMatchObject({
      ready: false,
      code: "planning-blocked",
    });
  });

  it("does not plan router child tasks and rejects planning on a child", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const child = await request<Task>(
      "POST",
      "/api/v1/tasks",
      {
        projectId: project.id,
        parentTaskId: task.id,
        title: "Router child",
        description: "Materialized child work.",
        acceptance: ["Child evidence"],
        agentId: "00000000-0000-4000-8000-000000000001",
      },
      201,
    );
    await database.query(
      `INSERT INTO task_origins (
         task_id, source_kind, source_id, parent_task_id, root_task_id,
         created_by_principal_id, idempotency_key, metadata, created_at
       ) VALUES (
         $1, 'router', $2, $3, $3, 'local-admin', $4, '{}'::jsonb, NOW()
       )
       ON CONFLICT (task_id) DO NOTHING`,
      [child.id, child.id, task.id, `test-router:${child.id}`],
    );

    const readiness = await request<{ ready: boolean }>(
      "GET",
      `/api/v1/tasks/${child.id}/dispatch-readiness`,
    );
    expect(readiness.ready).toBe(true);
    const selfTrigger = await inject(
      "POST",
      `/api/v1/tasks/${child.id}/planning/start`,
      { reason: "Planner must not trigger on its own child" },
    );
    expect(selfTrigger.statusCode).toBe(404);
    expect(selfTrigger.json()).toMatchObject({
      code: "planning_root_task_invalid",
    });
  });

  it("keeps a rejected or incomplete plan in review without binding a plan", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Quality rejection fixture" },
      201,
    );
    const review = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/review-required`,
      {
        expectedRevision: started.run.revision,
        reason: "Force manual plan fixture",
      },
    );
    const rejected = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${review.run.id}/plan`,
      {
        expectedRevision: review.run.revision,
        graph: planGraph(task, {
          acceptance: ["Acceptance that does not cover the root task"],
        }),
        settings: {
          maxNodes: 20,
          maxDepth: 10,
          maxOutDegree: 5,
          maxConcurrency: 2,
        },
        reason: "Missing root acceptance coverage",
      },
    );
    expect(rejected.run.status).toBe("review_required");
    expect(rejected.run.workflowPlanId).toBeNull();
    expect(rejected.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["plan-draft", "critic", "context-pack"]),
    );
    expect(rejected.qualityMetrics.at(-1)).toMatchObject({
      validatorErrorCount: 0,
      acceptanceCoverage: 0,
      autoApproveEligible: false,
    });
    const plans = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM workflow_plans WHERE root_task_id = $1",
      [task.id],
    );
    expect(plans.rows[0]?.count).toBe(0);
  });

  it("requires a human gate on high-risk nodes", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "High-risk planning fixture" },
      201,
    );
    const review = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/review-required`,
      {
        expectedRevision: started.run.revision,
        reason: "High-risk plan review",
      },
    );
    const missingGate = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${review.run.id}/plan`,
      {
        expectedRevision: review.run.revision,
        graph: planGraph(task, {
          description: "Deploy the change to production.",
        }),
        settings: {
          maxNodes: 20,
          maxDepth: 10,
          maxOutDegree: 5,
          maxConcurrency: 2,
        },
        reason: "High-risk node without gate",
      },
    );
    expect(missingGate.run.workflowPlanId).toBeNull();
    expect(missingGate.qualityMetrics.at(-1)?.humanReviewRequired).toBe(true);

    const gated = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${missingGate.run.id}/plan`,
      {
        expectedRevision: missingGate.run.revision,
        graph: planGraph(task, {
          description: "Deploy the change to production.",
          approvers: [
            {
              kind: "user",
              id: "local-admin",
              label: "Local Admin",
            },
          ],
        }),
        settings: {
          maxNodes: 20,
          maxDepth: 10,
          maxOutDegree: 5,
          maxConcurrency: 2,
        },
        reason: "High-risk node with human gate",
      },
    );
    expect(gated.run.status).toBe("succeeded");
    expect(gated.run.workflowPlanId).not.toBeNull();
    expect(gated.qualityMetrics.at(-1)).toMatchObject({
      validatorErrorCount: 0,
      acceptanceCoverage: 1,
      humanReviewRequired: true,
      autoApproveEligible: false,
    });
    const gatedPlan = await request<WorkflowPlanDetail>(
      "GET",
      `/api/v1/task-plans/${gated.run.workflowPlanId}`,
    );
    expect(gatedPlan.plan.status).toBe("proposed");
    expect(gatedPlan.plan.confirmedAt).toBeNull();
  });

  it("does not bind a plan when Validator finds a graph error", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Validator failure fixture" },
      201,
    );
    const review = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${started.run.id}/review-required`,
      {
        expectedRevision: started.run.revision,
        reason: "Validator failure review",
      },
    );
    const cycle: WorkflowGraph = {
      key: "validator-cycle",
      version: 1,
      name: "Validator cycle",
      description: "Cycle must not become dispatchable.",
      nodes: ["a", "b"].map((id) => ({
        id,
        name: `Cycle ${id}`,
        type: "task" as const,
        executor: { kind: "agent" as const, id: task.agentId },
        description: "Provide verifiable evidence.",
        acceptance: [...task.acceptance],
        approvers: [],
        approvalPolicy: "all" as const,
        autoDispatch: false,
        start: id === "a",
        maxAttempts: 1,
        timeoutSeconds: 300,
      })),
      edges: [
        { id: "a-b", from: "a", to: "b" },
        { id: "b-a", from: "b", to: "a" },
      ],
      startNodeIds: ["a"],
      warnings: [],
    };
    const invalid = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/planning-runs/${review.run.id}/plan`,
      {
        expectedRevision: review.run.revision,
        graph: cycle,
        settings: {
          maxNodes: 20,
          maxDepth: 10,
          maxOutDegree: 5,
          maxConcurrency: 2,
        },
        reason: "Cycle must be rejected",
      },
    );
    expect(invalid.run.workflowPlanId).toBeNull();
    expect(invalid.run.status).toBe("review_required");
    expect(invalid.qualityMetrics.at(-1)).toMatchObject({
      validatorErrorCount: expect.any(Number),
      autoApproveEligible: false,
    });
    expect(invalid.qualityMetrics.at(-1)!.validatorErrorCount).toBeGreaterThan(
      0,
    );
    const plans = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM workflow_plans WHERE root_task_id = $1",
      [task.id],
    );
    expect(plans.rows[0]?.count).toBe(0);
  });

  it("auto-approves only an autopilot plan that passes the full quality gate", async () => {
    const first = await createRootTask();
    const firstSettings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${first.project.id}/planning/settings`,
    );
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${first.project.id}/planning/settings`,
      {
        expectedRevision: firstSettings.policy.revision,
        policy: {
          autoApprove: true,
          requireHumanReview: false,
          triggerPolicy: { agentAssigned: true },
        },
        flags: { autopilot: true },
      },
    );
    const firstRun = await repositories.planning.startRun({
      taskId: first.task.id,
      actorId: "local-admin",
      triggerKind: "agent-assigned",
      reason: "Autopilot quality gate fixture",
    });
    const approvedDetail = await new PlanningRuntimeWorker(
      repositories,
    ).processRun(firstRun.detail.run.id);
    expect(approvedDetail.status).toBe("succeeded");
    const approved = await repositories.planning.getRunDetail(
      firstRun.detail.run.id,
    );
    expect(approved.qualityMetrics.at(-1)?.autoApproveEligible).toBe(true);
    const approvedPlan = await repositories.workflowPlans.getPlanDetail(
      approved.run.workflowPlanId!,
    );
    expect(approvedPlan.plan.status).toBe("approved");
    expect(approvedPlan.plan.confirmedAt).not.toBeNull();

    const second = await createRootTask();
    const secondSettings = await request<PlanningSettings>(
      "GET",
      `/api/v1/projects/${second.project.id}/planning/settings`,
    );
    await request<PlanningSettings>(
      "PATCH",
      `/api/v1/projects/${second.project.id}/planning/settings`,
      {
        expectedRevision: secondSettings.policy.revision,
        policy: {
          autoApprove: true,
          requireHumanReview: false,
          triggerPolicy: { agentAssigned: true },
        },
        flags: { autopilot: true },
      },
    );
    const badPlanner: PlanningPlanner = {
      id: "fixture:rejecting-planner",
      version: "1",
      async draft({ context, settings }) {
        return {
          graph: {
            key: "rejecting-planner",
            version: 1,
            name: "Rejected plan",
            description: "Does not cover acceptance.",
            nodes: [
              {
                id: "incomplete",
                name: "Incomplete node",
                type: "task",
                executor: {
                  kind: "agent",
                  id: context.rootTask.agentId,
                },
                description: "Execute without covering root acceptance.",
                acceptance: ["Unrelated output"],
                approvers: [],
                approvalPolicy: "all",
                autoDispatch: false,
                start: true,
                maxAttempts: 1,
                timeoutSeconds: 300,
              },
            ],
            edges: [],
            startNodeIds: ["incomplete"],
            warnings: [],
          },
          settings: {
            maxNodes: settings.policy.config.maxNodes,
            maxDepth: settings.policy.config.maxDepth,
            maxOutDegree: 5,
            maxConcurrency: 2,
          },
          reason: "Critic must reject uncovered acceptance",
        };
      },
    };
    const secondRun = await repositories.planning.startRun({
      taskId: second.task.id,
      actorId: "local-admin",
      triggerKind: "agent-assigned",
      reason: "Autopilot rejection fixture",
    });
    const rejectedDetail = await new PlanningRuntimeWorker(repositories, {
      planner: badPlanner,
    }).processRun(secondRun.detail.run.id);
    expect(rejectedDetail.status).toBe("review_required");
    const rejected = await repositories.planning.getRunDetail(
      secondRun.detail.run.id,
    );
    expect(rejected.run.workflowPlanId).toBeNull();
    expect(rejected.qualityMetrics.at(-1)?.autoApproveEligible).toBe(false);
    const rejectedPlans = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM workflow_plans WHERE root_task_id = $1",
      [second.task.id],
    );
    expect(rejectedPlans.rows[0]?.count).toBe(0);
  });

  it("fixes Knowledge Provider contributions into context, facts and receipts", async () => {
    const { project, task } = await createRootTask();
    await enableManualPlanning(project.id);
    const started = await request<PlanningRunDetail>(
      "POST",
      `/api/v1/tasks/${task.id}/planning/start`,
      { reason: "Knowledge provider fixture" },
      201,
    );
    const worker = new PlanningRuntimeWorker(repositories, {
      knowledgeProvider: {
        id: "fixture:knowledge",
        version: "1",
        async provide() {
          return [
            {
              providerId: "fixture:knowledge",
              providerVersion: "1",
              sourceId: "policy-42",
              contentDigest: null,
              statement: "Release requires a documented rollback plan.",
              confidence: 0.9,
              verified: true,
              inclusion: "included",
              reason: null,
            },
          ];
        },
      },
    });
    await worker.processRun(started.run.id);
    const detail = await repositories.planning.getRunDetail(started.run.id);
    const context = detail.artifacts.find(
      (artifact): artifact is Extract<PlanningArtifact, { kind: "context-pack" }> =>
        artifact.kind === "context-pack",
    );
    const receipt = detail.artifacts.find(
      (artifact): artifact is Extract<PlanningArtifact, { kind: "knowledge-receipt" }> =>
        artifact.kind === "knowledge-receipt",
    );
    const facts = detail.artifacts.find(
      (artifact): artifact is Extract<PlanningArtifact, { kind: "facts-ledger" }> =>
        artifact.kind === "facts-ledger",
    );
    expect(context?.payload.knowledgeContributions).toHaveLength(1);
    expect(receipt?.payload.receipts[0]).toMatchObject({
      providerId: "fixture:knowledge",
      sourceId: "policy-42",
      inclusion: "included",
    });
    expect(
      facts?.payload.entries.some(
        (entry) =>
          entry.sourceKind === "knowledge" &&
          entry.statement.includes("rollback"),
      ),
    ).toBe(true);
  });
});
