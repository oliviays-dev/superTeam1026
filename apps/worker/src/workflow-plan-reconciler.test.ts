import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Agent,
  Project,
  ProjectRole,
  RouterFeatureGate,
  Task,
  WorkflowGraph,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import { PlatformApplication } from "@pluginmax/application";
import {
  Database,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;
const settings: WorkflowPlanSettings = {
  maxNodes: 20,
  maxDepth: 10,
  maxOutDegree: 6,
  maxConcurrency: 4,
};

integration("M3 workflow plan Reconciler and Feature Gate fencing", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;
  let project: Project;
  let role: ProjectRole;
  let agent: Agent;
  let rootTask: Task;
  let gate: RouterFeatureGate;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    await repositories.authorization.ensureDevelopmentPrincipal(
      "local-admin",
      true,
    );
    application = new PlatformApplication(repositories);
    project = await application.createProject({
      name: `M3 reconcile ${randomUUID().slice(0, 8)}`,
      description: "",
    });
    role = await application.createProjectRole(project.id, {
      code: "DELIVERY_LEAD",
      name: `Delivery ${randomUUID().slice(0, 5)}`,
      description: "M3 reconcile",
      permissions: ["read", "write"],
    });
    agent = await application.createAgent({
      name: `M3 reconcile worker ${randomUUID().slice(0, 6)}`,
      description: "",
      soul: "",
      scenarios: [],
      goals: [],
      tools: [],
      runtimeKind: "fake",
      source: "personal",
    });
    await application.createProjectMember(project.id, {
      kind: "agent",
      agentId: agent.id,
      responsibility: "M3 reconcile worker",
      roleIds: [role.id],
    });
    gate = await application.getRouterFeatureGate(project.id);
    gate = await application.setRouterFeatureGate(project.id, {
      enabled: true,
      expectedEpoch: gate.epoch,
      reason: "M3 reconciler integration",
    });
    rootTask = await application.createTask({
      projectId: project.id,
      title: "M3 reconcile root",
      description: "Root business task",
      acceptance: ["Root remains business-owned"],
      agentId: agent.id,
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it("G11 fences in-flight dispatch, stays stopped after reopen, and only resumes explicitly", async () => {
    const graph: WorkflowGraph = {
      key: "m3-reconcile",
      version: 1,
      name: "M3 reconcile graph",
      description: "Reconciler graph",
      nodes: ["a", "b", "c"].map((id, index) => ({
        id,
        name: id,
        type: "task" as const,
        executor: { kind: "agent" as const, id: agent.id },
        description: `${id} description`,
        acceptance: [`${id} accepted`],
        approvers: [],
        approvalPolicy: "all" as const,
        autoDispatch: true,
        start: index === 0,
        maxAttempts: 1,
        timeoutSeconds: 300,
      })),
      edges: [
        { id: "ab", from: "a", to: "b" },
        { id: "ac", from: "a", to: "c" },
        { id: "bc", from: "b", to: "c" },
      ],
      startNodeIds: ["a"],
      warnings: [],
    };
    const created = await application.createWorkflowPlan(rootTask.id, {
      rootTaskId: rootTask.id,
      source: "manual",
      graph,
      settings,
      reason: "G11",
    });
    const approved = await application.approveWorkflowPlan(
      created.plan.id,
      {
        expectedRevision: created.plan.revision,
        role: "DELIVERY_LEAD",
      },
    );
    const active = await application.materializeWorkflowPlan(
      approved.plan.id,
      {
        expectedRevision: approved.plan.revision,
        expectedGateEpoch: gate.epoch,
      },
    );
    expect(active.plan.status).toBe("active");
    const runsBefore = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM runs
       WHERE task_id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1
       )`,
      [created.plan.id],
    );
    expect(runsBefore.rows[0]?.count).toBe(0);

    const inFlight =
      await repositories.workflowPlans.claimDispatchMessages({
        planId: created.plan.id,
        owner: "in-flight-worker",
        leaseSeconds: 30,
        limit: 1,
      });
    expect(inFlight).toHaveLength(1);
    const closed = await application.setRouterFeatureGate(project.id, {
      enabled: false,
      expectedEpoch: gate.epoch,
      reason: "G11 close",
    });
    expect(closed.enabled).toBe(false);
    const stopped = await application.getWorkflowPlan(
      created.plan.id,
      "local-admin",
    );
    expect(stopped.plan.status).toBe("resume_required");
    const cancelled = await database.query<{ status: string }>(
      `SELECT status
       FROM workflow_plan_outbox_messages
       WHERE message_id = $1`,
      [inFlight[0]!.message_id],
    );
    expect(cancelled.rows[0]?.status).toBe("cancelled");

    await application.sweepWorkflowPlans("m3-reconciler-off", {
      staleAfterSeconds: 0,
    });
    const runsAfterClose = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM runs
       WHERE task_id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1
       )`,
      [created.plan.id],
    );
    expect(runsAfterClose.rows[0]?.count).toBe(0);

    gate = await application.setRouterFeatureGate(project.id, {
      enabled: true,
      expectedEpoch: closed.epoch,
      reason: "G11 reopen",
    });
    await application.sweepWorkflowPlans("m3-reconciler-reopen", {
      staleAfterSeconds: 0,
    });
    const afterReopen = await application.getWorkflowPlan(
      created.plan.id,
      "local-admin",
    );
    expect(afterReopen.plan.status).toBe("resume_required");
    const runsAfterReopen = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM runs
       WHERE task_id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1
       )`,
      [created.plan.id],
    );
    expect(runsAfterReopen.rows[0]?.count).toBe(0);

    const resumed = await application.resumeWorkflowPlan(
      created.plan.id,
      {
        expectedRevision: afterReopen.plan.revision,
        expectedGateEpoch: gate.epoch,
      },
    );
    expect(resumed.plan.status).toBe("approved");
    const sweep = await application.sweepWorkflowPlans(
      "m3-reconciler-explicit",
      { staleAfterSeconds: 0 },
    );
    expect(sweep.claimed).toBeGreaterThanOrEqual(1);
    const runsAfterResume = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM runs
       WHERE task_id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1
       )`,
      [created.plan.id],
    );
    expect(runsAfterResume.rows[0]?.count).toBe(1);
    const processed = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM workflow_plan_outbox_messages
       WHERE plan_id = $1 AND status = 'processed'`,
      [created.plan.id],
    );
    expect(processed.rows[0]?.count).toBe(1);

    await application.sweepWorkflowPlans("m3-reconciler-replay", {
      staleAfterSeconds: 0,
    });
    const runsAfterReplay = await database.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM runs
       WHERE task_id IN (
         SELECT task_id
         FROM plan_materializations
         WHERE plan_id = $1
       )`,
      [created.plan.id],
    );
    expect(runsAfterReplay.rows[0]?.count).toBe(1);
  });
});
