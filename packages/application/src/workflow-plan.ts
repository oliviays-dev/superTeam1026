import { randomUUID } from "node:crypto";
import type {
  ApproveWorkflowPlanInput,
  CreateWorkflowPlanInput,
  CreateWorkflowPlanVersionInput,
  FinalizeWorkflowPlanInput,
  MaterializeWorkflowPlanInput,
  ProvisionRouterTemplateInput,
  RegisterRouterAgentInput,
  ResumeWorkflowPlanInput,
  RouterAgent,
  RouterFeatureGate,
  SetRouterFeatureGateInput,
  TeammateTemplate,
  WorkflowGraph,
  WorkflowPlanDetail,
  WorkflowPlanDiff,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import {
  approveWorkflowPlanInputSchema,
  createWorkflowPlanInputSchema,
  createWorkflowPlanVersionInputSchema,
  finalizeWorkflowPlanInputSchema,
  materializeWorkflowPlanInputSchema,
  provisionRouterTemplateInputSchema,
  registerRouterAgentInputSchema,
  resumeWorkflowPlanInputSchema,
  setRouterFeatureGateInputSchema,
} from "@pluginmax/contracts";
import {
  assertValidWorkflowPlanGraph,
  diffWorkflowPlanGraphs,
  WorkflowPlanGraphError,
} from "@pluginmax/domain";
import {
  type PlanOutboxMessageRow,
  type PlatformRepositories,
  type RouterAgentSnapshot,
  WorkflowPlanRepositoryError,
} from "@pluginmax/database";

type DispatchPlanTask = (
  taskId: string,
  actorId: string,
) => Promise<{ readonly runId: string }>;

export class WorkflowPlanApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowPlanApplicationError";
  }
}

export interface WorkflowPlanSweepResult {
  readonly claimed: number;
  readonly reconciled: number;
  readonly dispatched: number;
  readonly fenced: number;
  readonly failed: number;
}

export class WorkflowPlanApplicationService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly dispatchTask: DispatchPlanTask,
  ) {}

  async provisionRouterTemplate(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: ProvisionRouterTemplateInput;
  }): Promise<TeammateTemplate> {
    const parsed = provisionRouterTemplateInputSchema.parse(input.value);
    return this.repositories.workflowPlans.provisionProtectedRouterTemplate({
      projectId: input.projectId,
      actorId: input.actorId,
      name: parsed.name,
    });
  }

  listRouterAgents(projectId: string): Promise<RouterAgent[]> {
    return this.repositories.workflowPlans.listRouterAgents(projectId);
  }

  async registerRouterAgent(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: RegisterRouterAgentInput;
  }): Promise<RouterAgent> {
    const parsed = registerRouterAgentInputSchema.parse(input.value);
    return this.repositories.workflowPlans.registerRouterAgent({
      projectId: input.projectId,
      teammateId: parsed.teammateId,
      actorId: input.actorId,
    });
  }

  getRouterGate(projectId: string): Promise<RouterFeatureGate> {
    return this.repositories.workflowPlans.getRouterGate(projectId);
  }

  setRouterGate(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: SetRouterFeatureGateInput;
  }): Promise<RouterFeatureGate> {
    const parsed = setRouterFeatureGateInputSchema.parse(input.value);
    return this.repositories.workflowPlans.setRouterGate({
      projectId: input.projectId,
      actorId: input.actorId,
      enabled: parsed.enabled,
      expectedEpoch: parsed.expectedEpoch,
      reason: parsed.reason,
    });
  }

  async createPlan(input: {
    readonly taskId: string;
    readonly actorId: string;
    readonly value: CreateWorkflowPlanInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = createWorkflowPlanInputSchema.parse(input.value);
    const task = await this.repositories.tasks.get(input.taskId);
    if (task === undefined || task.id !== parsed.rootTaskId) {
      throw new WorkflowPlanApplicationError(
        "task_not_found",
        "Root Task not found",
        404,
      );
    }
    if (parsed.source === "router") {
      if (parsed.routerAgentId !== undefined) {
        await this.assertRouterGate(task.projectId);
      }
    }
    if (parsed.source === "router" && parsed.planningRunId === undefined) {
      throw new WorkflowPlanApplicationError(
        "planning_run_required",
        "Router plans require a Planning Run",
        400,
      );
    }
    if (parsed.planningRunId !== undefined) {
      const planning = await this.repositories.planning.getRunDetail(
        parsed.planningRunId,
      );
      if (
        planning.run.projectId !== task.projectId ||
        planning.run.rootTaskId !== task.id
      ) {
        throw new WorkflowPlanApplicationError(
          "planning_run_scope_mismatch",
          "Planning Run scope does not match the Root Task",
          409,
        );
      }
      if (planning.run.status !== "review_required") {
        throw new WorkflowPlanApplicationError(
          "planning_run_not_ready",
          "Planning Run must be review_required before binding a plan",
          409,
        );
      }
      if (
        parsed.planningRunRevision !== undefined &&
        planning.run.revision !== parsed.planningRunRevision
      ) {
        throw new WorkflowPlanApplicationError(
          "planning_run_revision_conflict",
          "Planning Run revision changed",
          409,
          {
            expectedRevision: parsed.planningRunRevision,
            revision: planning.run.revision,
          },
        );
      }
    }
    const routerAgent =
      parsed.source === "router" && parsed.routerAgentId !== undefined
        ? await this.resolveRouterAgent(
            task.projectId,
            parsed.routerAgentId,
          )
        : null;
    const planId = randomUUID();
    const graph = await this.validateGraph({
      projectId: task.projectId,
      graph: {
        ...parsed.graph,
        key: `plan:${planId}`,
        version: 1,
      },
      settings: parsed.settings,
    });
    return this.repositories.workflowPlans.createPlan({
      planId,
      projectId: task.projectId,
      rootTaskId: task.id,
      source: parsed.source,
      graph,
      settings: parsed.settings,
      reason: parsed.reason,
      actorId: input.actorId,
      routerAgent: routerAgent === null ? null : routerSnapshot(routerAgent),
      planningRunId: parsed.planningRunId ?? null,
      planningRunRevision: parsed.planningRunRevision ?? null,
    });
  }

  getPlan(id: string): Promise<WorkflowPlanDetail> {
    return this.repositories.workflowPlans.getPlanDetail(id);
  }

  listPlans(projectId: string) {
    return this.repositories.workflowPlans.listPlans(projectId);
  }

  async addVersion(input: {
    readonly planId: string;
    readonly actorId: string;
    readonly value: CreateWorkflowPlanVersionInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = createWorkflowPlanVersionInputSchema.parse(input.value);
    const current =
      await this.repositories.workflowPlans.getPlanDetail(input.planId);
    const plan = current.plan;
    const routerAgent =
      plan.source === "router" && plan.routerAgentId !== null
        ? await this.resolveRouterAgent(
            plan.projectId,
            parsed.routerAgentId ?? plan.routerAgentId ?? undefined,
          )
        : null;
    if (
      plan.source === "router" &&
      parsed.routerAgentId !== undefined &&
      parsed.routerAgentId !== plan.routerAgentId
    ) {
      throw new WorkflowPlanApplicationError(
        "router_agent_frozen",
        "A plan's Router Agent cannot change after creation",
      );
    }
    const graph = await this.validateGraph({
      projectId: plan.projectId,
      graph: {
        ...parsed.graph,
        key: current.version.graph.key,
        version: plan.currentVersion + 1,
      },
      settings: parsed.settings,
    });
    return this.repositories.workflowPlans.addPlanVersion({
      planId: plan.id,
      expectedRevision: parsed.expectedRevision,
      graph,
      settings: parsed.settings,
      reason: parsed.reason,
      actorId: input.actorId,
      routerAgent: routerAgent === null ? null : routerSnapshot(routerAgent),
    });
  }

  async diff(
    planId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<WorkflowPlanDiff> {
    const [from, to] = await Promise.all([
      this.repositories.workflowPlans.getPlanVersion(planId, fromVersion),
      this.repositories.workflowPlans.getPlanVersion(planId, toVersion),
    ]);
    if (from === undefined || to === undefined) {
      throw new WorkflowPlanApplicationError(
        "workflow_plan_version_not_found",
        "One or both plan versions do not exist",
        404,
      );
    }
    return diffWorkflowPlanGraphs(
      planId,
      fromVersion,
      toVersion,
      from.graph,
      to.graph,
    );
  }

  async approve(input: {
    readonly planId: string;
    readonly actorId: string;
    readonly value: ApproveWorkflowPlanInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = approveWorkflowPlanInputSchema.parse(input.value);
    const current =
      await this.repositories.workflowPlans.getPlanDetail(input.planId);
    await this.validateGraph({
      projectId: current.plan.projectId,
      graph: current.version.graph,
      settings: current.version.settings,
    });
    if (!isPlanningGeneratedPlan(current.plan)) {
      await this.assertRouterGate(
        current.plan.projectId,
        parsed.expectedGateEpoch,
      );
    }
    return this.repositories.workflowPlans.approvePlan({
      planId: current.plan.id,
      expectedRevision: parsed.expectedRevision,
      actorId: input.actorId,
      role: parsed.role ?? null,
    });
  }

  async materialize(input: {
    readonly planId: string;
    readonly actorId: string;
    readonly value: MaterializeWorkflowPlanInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = materializeWorkflowPlanInputSchema.parse(input.value);
    const current =
      await this.repositories.workflowPlans.getPlanDetail(input.planId);
    await this.validateGraph({
      projectId: current.plan.projectId,
      graph: current.version.graph,
      settings: current.version.settings,
    });
    if (!isPlanningGeneratedPlan(current.plan)) {
      await this.assertRouterGate(
        current.plan.projectId,
        parsed.expectedGateEpoch,
      );
    }
    try {
      return await this.repositories.workflowPlans.materializePlan({
        planId: current.plan.id,
        expectedRevision: parsed.expectedRevision,
        expectedGateEpoch: parsed.expectedGateEpoch,
        actorId: input.actorId,
      });
    } catch (error) {
      if (!isExpectedPlanConflict(error)) {
        await this.repositories.workflowPlans.failPendingMaterializations({
          planId: current.plan.id,
          planVersion: current.plan.currentVersion,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async finalize(input: {
    readonly planId: string;
    readonly actorId: string;
    readonly value: FinalizeWorkflowPlanInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = finalizeWorkflowPlanInputSchema.parse(input.value);
    const current =
      await this.repositories.workflowPlans.getPlanDetail(input.planId);
    if (!isPlanningGeneratedPlan(current.plan)) {
      await this.assertRouterGate(
        current.plan.projectId,
        parsed.expectedGateEpoch,
      );
    }
    return this.repositories.workflowPlans.finalizePlan({
      planId: current.plan.id,
      expectedRevision: parsed.expectedRevision,
      expectedGateEpoch: parsed.expectedGateEpoch,
      actorId: input.actorId,
    });
  }

  async resume(input: {
    readonly planId: string;
    readonly actorId: string;
    readonly value: ResumeWorkflowPlanInput;
  }): Promise<WorkflowPlanDetail> {
    const parsed = resumeWorkflowPlanInputSchema.parse(input.value);
    const current =
      await this.repositories.workflowPlans.getPlanDetail(input.planId);
    if (!isPlanningGeneratedPlan(current.plan)) {
      await this.assertRouterGate(
        current.plan.projectId,
        parsed.expectedGateEpoch,
      );
    }
    return this.repositories.workflowPlans.resumePlan({
      planId: current.plan.id,
      expectedRevision: parsed.expectedRevision,
      expectedGateEpoch: parsed.expectedGateEpoch,
      actorId: input.actorId,
    });
  }

  async sweep(
    owner: string,
    options: {
      readonly batchSize?: number;
      readonly leaseSeconds?: number;
      readonly staleAfterSeconds?: number;
    } = {},
  ): Promise<WorkflowPlanSweepResult> {
    const planIds =
      await this.repositories.workflowPlans.claimReconcileCandidates({
        owner,
        limit: options.batchSize ?? 20,
        leaseSeconds: options.leaseSeconds ?? 30,
        staleAfterSeconds: options.staleAfterSeconds ?? 2,
      });
    let reconciled = 0;
    let dispatched = 0;
    let fenced = 0;
    let failed = 0;
    for (const planId of planIds) {
      try {
        const before =
          await this.repositories.workflowPlans.getPlanDetail(planId);
        const gate = await this.repositories.workflowPlans.getRouterGate(
          before.plan.projectId,
        );
        await this.repositories.workflowPlans.reconcilePlan({
          planId,
          actorId: `sweep:${owner}`,
        });
        const after =
          await this.repositories.workflowPlans.getPlanDetail(planId);
        if (after.plan.status === "resume_required" || !gate.enabled) {
          fenced += 1;
        } else {
          reconciled += 1;
          dispatched += await this.processDispatchMessages(planId, owner);
        }
      } catch (error) {
        if (
          error instanceof WorkflowPlanRepositoryError &&
          error.code === "workflow_plan_gate_disabled"
        ) {
          fenced += 1;
        } else {
          failed += 1;
          const detail =
            await this.repositories.workflowPlans.getPlanDetail(planId);
          await this.repositories.workflowPlans.failPendingMaterializations({
            planId,
            planVersion: detail.plan.currentVersion,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        await this.repositories.workflowPlans.releaseReconcileLease(
          planId,
          owner,
        );
      }
    }
    return {
      claimed: planIds.length,
      reconciled,
      dispatched,
      fenced,
      failed,
    };
  }

  private async processDispatchMessages(
    planId: string,
    owner: string,
  ): Promise<number> {
    const messages =
      await this.repositories.workflowPlans.claimDispatchMessages({
        planId,
        owner,
        leaseSeconds: 30,
        limit: 50,
      });
    let dispatched = 0;
    for (const message of messages) {
      if (!(await this.canDispatchMessage(message, owner))) continue;
      const taskId = await this.messageTaskId(message);
      if (taskId === null) {
        await this.repositories.workflowPlans.failDispatchMessage({
          messageId: message.message_id,
          owner,
          error: "dispatch message has no task",
        });
        continue;
      }
      const task = await this.repositories.tasks.get(taskId);
      if (task === undefined) {
        await this.repositories.workflowPlans.failDispatchMessage({
          messageId: message.message_id,
          owner,
          error: "dispatch task is missing",
        });
        continue;
      }
      if (task.status !== "queued") {
        await this.repositories.workflowPlans.completeDispatchMessage({
          messageId: message.message_id,
          owner,
        });
        continue;
      }
      const projectTasks = await this.repositories.tasks.list(task.projectId);
      const byId = new Map(projectTasks.map((item) => [item.id, item]));
      const unresolved = task.dependsOn.filter(
        (dependencyId) => byId.get(dependencyId)?.status !== "done",
      );
      if (unresolved.length > 0) {
        await this.repositories.workflowPlans.deferDispatchMessage({
          messageId: message.message_id,
          owner,
          reason: `dependencies unresolved: ${unresolved.join(",")}`,
        });
        continue;
      }
      const runs = await this.repositories.runs.listByTask(task.id);
      const activeRun = runs.find((run) =>
        ["queued", "running", "waiting_approval", "interrupted"].includes(
          run.status,
        ),
      );
      if (activeRun !== undefined) {
        await this.repositories.workflowPlans.completeDispatchMessage({
          messageId: message.message_id,
          owner,
          runId: activeRun.id,
        });
        continue;
      }
      if (!(await this.canDispatchMessage(message, owner))) continue;
      try {
        const detail =
          await this.repositories.workflowPlans.getPlanDetail(message.plan_id);
        const result = await this.dispatchTask(
          task.id,
          detail.plan.confirmedByPrincipalId ?? "system:router-reconciler",
        );
        await this.repositories.workflowPlans.completeDispatchMessage({
          messageId: message.message_id,
          owner,
          runId: result.runId,
        });
        dispatched += 1;
      } catch (error) {
        const latestRuns = await this.repositories.runs.listByTask(task.id);
        const existing = latestRuns.find((run) =>
          ["queued", "running", "waiting_approval", "interrupted"].includes(
            run.status,
          ),
        );
        if (existing !== undefined) {
          await this.repositories.workflowPlans.completeDispatchMessage({
            messageId: message.message_id,
            owner,
            runId: existing.id,
          });
        } else {
          await this.repositories.workflowPlans.failDispatchMessage({
            messageId: message.message_id,
            owner,
            error:
              error instanceof Error ? error.message : "dispatch failed",
          });
        }
      }
    }
    return dispatched;
  }

  private async canDispatchMessage(
    message: PlanOutboxMessageRow,
    owner: string,
  ): Promise<boolean> {
    const detail = await this.repositories.workflowPlans.getPlanDetail(
      message.plan_id,
    );
    const gate = await this.repositories.workflowPlans.getRouterGate(
      detail.plan.projectId,
    );
    if (
      detail.plan.status !== "active" ||
      (!isPlanningGeneratedPlan(detail.plan) &&
        (!gate.enabled || detail.plan.gateEpoch !== gate.epoch))
    ) {
      await this.repositories.workflowPlans.deferDispatchMessage({
        messageId: message.message_id,
        owner,
        reason: "feature gate or plan state changed before dispatch",
      });
      return false;
    }
    return true;
  }

  private async messageTaskId(
    message: PlanOutboxMessageRow,
  ): Promise<string | null> {
    const payloadTaskId = message.payload.taskId;
    if (typeof payloadTaskId === "string") return payloadTaskId;
    const detail = await this.repositories.workflowPlans.getPlanDetail(
      message.plan_id,
    );
    return (
      detail.materializations.find(
        (item) =>
          item.planVersion === message.plan_version &&
          item.nodeId === message.node_id &&
          item.status === "materialized",
      )?.taskId ?? null
    );
  }

  private async resolveRouterAgent(
    projectId: string,
    routerAgentId: string | undefined,
  ): Promise<RouterAgent> {
    if (routerAgentId === undefined) {
      throw new WorkflowPlanApplicationError(
        "router_agent_required",
        "A registered Router Agent is required",
        400,
      );
    }
    const agent =
      await this.repositories.workflowPlans.getRouterAgent(
        routerAgentId,
        projectId,
      );
    if (agent === undefined || agent.status !== "active") {
      throw new WorkflowPlanApplicationError(
        "router_agent_unavailable",
        "The Router Agent is unavailable in this project",
        409,
      );
    }
    return agent;
  }

  private async assertRouterGate(
    projectId: string,
    expectedEpoch?: number,
  ): Promise<RouterFeatureGate> {
    const gate = await this.repositories.workflowPlans.getRouterGate(projectId);
    if (!gate.enabled) {
      throw new WorkflowPlanApplicationError(
        "router_worker_disabled",
        "The workflow.router_worker Feature Gate is disabled",
        409,
        { epoch: gate.epoch },
      );
    }
    if (expectedEpoch !== undefined && expectedEpoch !== gate.epoch) {
      throw new WorkflowPlanApplicationError(
        "router_gate_epoch_conflict",
        "Router Feature Gate epoch changed",
        409,
        { expectedEpoch, epoch: gate.epoch },
      );
    }
    return gate;
  }

  private async validateGraph(input: {
    readonly projectId: string;
    readonly graph: WorkflowGraph;
    readonly settings: WorkflowPlanSettings;
  }): Promise<WorkflowGraph> {
    try {
      assertValidWorkflowPlanGraph(input.graph, input.settings);
    } catch (error) {
      if (error instanceof WorkflowPlanGraphError) {
        throw new WorkflowPlanApplicationError(
          "workflow_plan_graph_invalid",
          "Workflow plan graph is invalid",
          422,
          { issues: error.issues },
        );
      }
      throw error;
    }
    await this.repositories.workflowPlans.assertActivePlanAgents(
      input.projectId,
      input.graph.nodes
        .filter((node) => node.type === "task")
        .map((node) => node.executor.id),
    );
    return input.graph;
  }
}

function routerSnapshot(agent: RouterAgent): RouterAgentSnapshot {
  return {
    id: agent.id,
    projectId: agent.projectId,
    teammateId: agent.teammateId,
    agentId: agent.agentId,
    agentName: agent.agentName,
    aiPrincipalId: agent.aiPrincipalId,
    templateId: agent.templateId,
    templateVersionId: agent.templateVersionId,
    templateVersion: agent.templateVersion,
    contractTools: agent.contract.tools,
    contractDigest: agent.contract.digest,
  };
}

function isExpectedPlanConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowPlanRepositoryError &&
    [
      "workflow_plan_revision_conflict",
      "workflow_plan_state_conflict",
      "workflow_plan_gate_disabled",
      "workflow_plan_gate_epoch_conflict",
    ].includes(error.code)
  );
}

function isPlanningGeneratedPlan(plan: {
  readonly source: string;
  readonly planningRunId: string | null;
  readonly routerAgentId: string | null;
}): boolean {
  return (
    plan.source === "router" &&
    plan.planningRunId !== null &&
    plan.routerAgentId === null
  );
}
