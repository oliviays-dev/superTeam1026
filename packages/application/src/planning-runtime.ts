import { createHash, randomUUID } from "node:crypto";
import type {
  CriticReportPayload,
  FactsLedgerPayload,
  PlanningArtifact,
  PlanningContextPackPayload,
  PlanningKnowledgeContribution,
  PlanningKnowledgeReceiptPayload,
  PlanningPlanDraftPayload,
  PlanningQualityGate,
  PlanningRunDetail,
  PlanningSettings,
  PlanningSkillSnapshotPayload,
  PlanningSubmitPlanInput,
  PlanningWorkerResult,
  RequirementBriefPayload,
  WorkflowGraph,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import {
  PLATFORM_SKILL_SAFETY_RULES,
  planningArtifactPayloadSchema,
  planningContextPackPayloadSchema,
  planningPlanDraftPayloadSchema,
  planningSubmitPlanInputSchema,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import { PlanningRepositoryError } from "@pluginmax/database";
import {
  critiquePlanningGraph,
  evaluatePlanningQualityGate,
  isPlanningHighRiskNode,
} from "./planning-quality.js";

export interface PlanningKnowledgeProviderInput {
  readonly run: PlanningRunDetail["run"];
  readonly context: PlanningContextPackPayload;
}

export interface PlanningKnowledgeProvider {
  readonly id: string;
  readonly version: string;
  provide(
    input: PlanningKnowledgeProviderInput,
  ): Promise<readonly PlanningKnowledgeContribution[]>;
}

export interface PlanningDraft {
  readonly graph: WorkflowGraph;
  readonly settings: WorkflowPlanSettings;
  readonly reason: string;
}

export interface PlanningPlanner {
  readonly id: string;
  readonly version: string;
  draft(input: {
    readonly context: PlanningContextPackPayload;
    readonly settings: PlanningSettings;
  }): Promise<PlanningDraft>;
}

export interface PlanningCritic {
  readonly id: string;
  readonly version: string;
  review(input: {
    readonly context: PlanningContextPackPayload;
    readonly draft: PlanningPlanDraftPayload;
  }): Promise<CriticReportPayload>;
}

export interface PlanningRuntimeWorkerOptions {
  readonly actorId?: string;
  readonly planner?: PlanningPlanner;
  readonly critic?: PlanningCritic;
  readonly knowledgeProvider?: PlanningKnowledgeProvider;
}

export class PlanningRuntimeWorker {
  private readonly actorId: string;
  private readonly planner: PlanningPlanner;
  private readonly critic: PlanningCritic;
  private readonly knowledgeProvider: PlanningKnowledgeProvider;

  constructor(
    private readonly repositories: PlatformRepositories,
    options: PlanningRuntimeWorkerOptions = {},
  ) {
    this.actorId = options.actorId ?? "system:planning-worker";
    this.planner = options.planner ?? new AcceptancePlanningPlanner();
    this.critic = options.critic ?? new DeterministicPlanningCritic();
    this.knowledgeProvider =
      options.knowledgeProvider ?? new EmptyPlanningKnowledgeProvider();
  }

  async runOnce(limit = 4): Promise<PlanningWorkerResult> {
    const runIds =
      await this.repositories.planning.listProcessableRunIds(limit);
    let advanced = 0;
    let reviewRequired = 0;
    let succeeded = 0;
    let failed = 0;
    for (const runId of runIds) {
      const outcome = await this.processRun(runId);
      advanced += outcome.advanced;
      if (outcome.status === "review_required") reviewRequired += 1;
      if (outcome.status === "succeeded") succeeded += 1;
      if (outcome.status === "failed") failed += 1;
    }
    return {
      claimed: runIds.length,
      advanced,
      reviewRequired,
      succeeded,
      failed,
    };
  }

  async processRun(runId: string): Promise<{
    readonly status: PlanningRunDetail["run"]["status"];
    readonly advanced: number;
  }> {
    let advanced = 0;
    for (let step = 0; step < 12; step += 1) {
      const detail = await this.repositories.planning.getRunDetail(runId);
      switch (detail.run.status) {
        case "queued":
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "preparing",
            actorId: detail.run.createdByPrincipalId,
            reason: "Planner Worker 开始准备 Planning Context",
          });
          advanced += 1;
          break;
        case "preparing":
          await this.captureContext(detail);
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "understanding",
            actorId: detail.run.createdByPrincipalId,
            reason: "Planning Context 已固化",
          });
          advanced += 1;
          break;
        case "understanding":
          await this.storeUnderstandingArtifacts(detail);
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "drafting",
            actorId: detail.run.createdByPrincipalId,
            reason: "需求、事实与场景 Skill 已固化",
          });
          advanced += 1;
          break;
        case "clarifying": {
          const brief = latestArtifact(detail, "requirement-brief");
          const blocking =
            brief?.kind === "requirement-brief"
              ? brief.payload.openQuestions.some(
                  (question) => question.blocking,
                )
              : false;
          if (blocking) {
            await this.repositories.planning.advanceRun({
              runId,
              expectedRevision: detail.run.revision,
              toStatus: "review_required",
              actorId: detail.run.createdByPrincipalId,
              reason: "存在阻塞性澄清问题，需要人工补充",
            });
          } else {
            await this.repositories.planning.advanceRun({
              runId,
              expectedRevision: detail.run.revision,
              toStatus: "understanding",
              actorId: detail.run.createdByPrincipalId,
              reason: "澄清问题已满足继续规划条件",
            });
          }
          advanced += 1;
          break;
        }
        case "drafting":
          await this.createDraft(detail);
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "critiquing",
            actorId: detail.run.createdByPrincipalId,
            reason: "Planner 已生成不可变 Plan Draft",
          });
          advanced += 1;
          break;
        case "critiquing": {
          const verdict = await this.reviewDraft(detail);
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "validating",
            actorId: detail.run.createdByPrincipalId,
            reason: "Critic 与 Quality Gate 已记录",
            data: { qualityGate: verdict.gate },
          });
          advanced += 1;
          break;
        }
        case "validating": {
          const gate = await this.currentQualityGate(detail);
          if (!gate.gate.eligible) {
            await this.repositories.planning.advanceRun({
              runId,
              expectedRevision: detail.run.revision,
              toStatus: "review_required",
              actorId: detail.run.createdByPrincipalId,
              reason: gate.gate.reasons.join("；") || "质量门要求人工审核",
            });
            advanced += 1;
            continue;
          }
          await this.repositories.planning.advanceRun({
            runId,
            expectedRevision: detail.run.revision,
            toStatus: "review_required",
            actorId: detail.run.createdByPrincipalId,
            reason: "质量门通过，进入 Plan 绑定确认点",
            data: { qualityGate: gate.gate },
          });
          const reviewed = await this.repositories.planning.getRunDetail(runId);
          await this.bindDraft(reviewed, gate.gate.autoApproveEligible);
          advanced += 1;
          return { status: "succeeded", advanced };
        }
        case "review_required":
          return { status: "review_required", advanced };
        case "paused":
        case "failed":
        case "cancelled":
        case "succeeded":
          return { status: detail.run.status, advanced };
      }
    }
    const current = await this.repositories.planning.getRunDetail(runId);
    return { status: current.run.status, advanced };
  }

  async submitPlan(
    runId: string,
    value: PlanningSubmitPlanInput,
    actorId = this.actorId,
  ): Promise<PlanningRunDetail> {
    const input = planningSubmitPlanInputSchema.parse(value);
    let detail = await this.repositories.planning.getRunDetail(runId);
    if (detail.run.status !== "review_required") {
      throw new PlanningRepositoryError(
        "planning_run_state_conflict",
        "Only a review_required Planning Run accepts a manual plan",
      );
    }
    if (detail.run.revision !== input.expectedRevision) {
      throw new PlanningRepositoryError(
        "planning_run_revision_conflict",
        "Planning Run revision changed",
        {
          expectedRevision: input.expectedRevision,
          revision: detail.run.revision,
        },
      );
    }
    let context = contextPayload(detail);
    if (context === undefined) {
      await this.captureContext(detail);
      detail = await this.repositories.planning.getRunDetail(runId);
      context = contextPayload(detail);
    }
    if (context === undefined) {
      throw new PlanningRepositoryError(
        "planning_artifact_invalid",
        "Planning Context is unavailable",
      );
    }
    const draft: PlanningPlanDraftPayload = planningPlanDraftPayloadSchema.parse({
      contextDigest: digest(context),
      graph: {
        ...input.graph,
        key: `planning:${runId}`,
        version: 1,
      },
      settings: input.settings,
      reason: input.reason,
      plannerId: "human-edited",
      plannerVersion: "1",
    });
    await this.repositories.planning.recordArtifact({
      runId,
      actorId,
      kind: "plan-draft",
      payload: draft,
    });
    detail = await this.repositories.planning.getRunDetail(runId);
    const critic = await this.critic.review({ context, draft });
    await this.repositories.planning.recordArtifact({
      runId,
      actorId,
      kind: "critic",
      payload: critic,
    });
    const settings = await this.repositories.planning.getSettings(
      detail.run.projectId,
    );
    const evaluation = evaluatePlanningQualityGate({
      graph: draft.graph,
      settings: draft.settings,
      rootAcceptance: context.rootTask.acceptance,
      critic,
      policy: settings.policy.config,
      triggerKind: detail.run.triggerKind,
    });
    await this.repositories.planning.recordQualityMetric({
      runId,
      actorId,
      criticScore: critic.score,
      validatorErrorCount: evaluation.inspection.validatorErrorCount,
      acceptanceCoverage: evaluation.inspection.acceptanceCoverage,
      nodeCount: evaluation.inspection.nodeCount,
      depth: evaluation.inspection.depth,
      humanReviewRequired: evaluation.gate.reviewRequired,
      autoApproveEligible: evaluation.gate.autoApproveEligible,
    });
    if (!evaluation.gate.eligible) {
      return this.repositories.planning.getRunDetail(runId);
    }
    await this.repositories.workflowPlans.createPlan({
      planId: randomUUID(),
      projectId: detail.run.projectId,
      rootTaskId: detail.run.rootTaskId,
      source: "router",
      graph: draft.graph,
      settings: draft.settings,
      reason: `人工编辑计划：${input.reason}`,
      actorId,
      routerAgent: null,
      planningRunId: detail.run.id,
      planningRunRevision: detail.run.revision,
    });
    return this.repositories.planning.getRunDetail(runId);
  }

  private async captureContext(
    detail: PlanningRunDetail,
  ): Promise<PlanningContextPackPayload> {
    const snapshot = await this.repositories.planning.getRunContextSnapshot(
      detail.run.id,
    );
    const knowledge = await this.knowledgeProvider.provide({
      run: detail.run,
      context: {
        version: 1,
        rootTaskRevision: snapshot.rootTaskRevision,
        rootTask: snapshot.rootTask,
        project: snapshot.project,
        members: snapshot.members,
        roles: snapshot.roles,
        agentCandidates: snapshot.agentCandidates,
        meetings: snapshot.meetings,
        workflows: snapshot.workflows,
        documents: snapshot.documents,
        memories: snapshot.memories,
        platformSafetyRules: PLATFORM_SKILL_SAFETY_RULES.map(
          (rule) => `${rule.code}: ${rule.description}`,
        ),
        knowledgeContributions: [],
      },
    });
    const context = planningContextPackPayloadSchema.parse({
      version: 1,
      rootTaskRevision: snapshot.rootTaskRevision,
      rootTask: snapshot.rootTask,
      project: snapshot.project,
      members: snapshot.members,
      roles: snapshot.roles,
      agentCandidates: snapshot.agentCandidates,
      meetings: snapshot.meetings,
      workflows: snapshot.workflows,
      documents: snapshot.documents,
      memories: snapshot.memories,
      platformSafetyRules: PLATFORM_SKILL_SAFETY_RULES.map(
        (rule) => `${rule.code}: ${rule.description}`,
      ),
      knowledgeContributions: [...knowledge],
    });
    await this.repositories.planning.recordArtifact({
      runId: detail.run.id,
      actorId: detail.run.createdByPrincipalId,
      kind: "context-pack",
      payload: context,
    });
    return context;
  }

  private async storeUnderstandingArtifacts(
    detail: PlanningRunDetail,
  ): Promise<void> {
    const context = requireContext(detail);
    const brief = buildRequirementBrief(context);
    const facts = buildFactsLedger(context);
    const skillSnapshot = await this.buildSkillSnapshot(context);
    const knowledgeReceipt = buildKnowledgeReceipt(context);
    for (const [kind, payload] of [
      ["requirement-brief", brief],
      ["facts-ledger", facts],
      ["skill-snapshot", skillSnapshot],
      ["knowledge-receipt", knowledgeReceipt],
    ] as const) {
      await this.repositories.planning.recordArtifact({
        runId: detail.run.id,
        actorId: detail.run.createdByPrincipalId,
        kind,
        payload,
      });
    }
  }

  private async buildSkillSnapshot(
    context: PlanningContextPackPayload,
  ): Promise<PlanningSkillSnapshotPayload> {
    const teammate = context.agentCandidates.find(
      (candidate) => candidate.agentId === context.rootTask.agentId,
    )?.teammateId;
    if (teammate === null || teammate === undefined) {
      return {
        contextDigest: digest(context),
        skills: [],
      };
    }
    const effective =
      await this.repositories.skills.resolveEffectiveSkills(teammate);
    return {
      contextDigest: digest(context),
      skills: effective.skills.map((skill) => {
        const included = skill.scenes.includes("task-planning");
        return {
          skillId: skill.skillId,
          skillVersionId: skill.versionId,
          version: skill.version,
          digest: skill.digest,
          instructionsHash: skill.instructionsHash ?? null,
          source:
            skill.source === "instance_extension"
              ? ("instance" as const)
              : skill.trustLevel === "private"
                ? ("user" as const)
                : ("platform" as const),
          required: skill.mode === "required",
          enabled: true,
          mode: skill.mode,
          scenes: skill.scenes,
          grantsAuthorization: false as const,
          inclusion: included ? ("included" as const) : ("excluded" as const),
          reason: included ? null : "Skill is not bound to task-planning",
        };
      }),
    };
  }

  private async createDraft(
    detail: PlanningRunDetail,
  ): Promise<PlanningPlanDraftPayload> {
    const context = requireContext(detail);
    const settings = await this.repositories.planning.getSettings(
      detail.run.projectId,
    );
    const draft = await this.planner.draft({ context, settings });
    const payload = planningPlanDraftPayloadSchema.parse({
      contextDigest: digest(context),
      graph: {
        ...draft.graph,
        key: `planning:${detail.run.id}`,
        version: 1,
      },
      settings: draft.settings,
      reason: draft.reason,
      plannerId: this.planner.id,
      plannerVersion: this.planner.version,
    });
    await this.repositories.planning.recordArtifact({
      runId: detail.run.id,
      actorId: detail.run.createdByPrincipalId,
      kind: "plan-draft",
      payload,
    });
    return payload;
  }

  private async reviewDraft(detail: PlanningRunDetail): Promise<{
    readonly critic: CriticReportPayload;
    readonly gate: PlanningQualityGate;
  }> {
    const context = requireContext(detail);
    const draft = requireArtifact(detail, "plan-draft").payload;
    const critic = await this.critic.review({ context, draft });
    await this.repositories.planning.recordArtifact({
      runId: detail.run.id,
      actorId: detail.run.createdByPrincipalId,
      kind: "critic",
      payload: critic,
    });
    const settings = await this.repositories.planning.getSettings(
      detail.run.projectId,
    );
    const evaluation = evaluatePlanningQualityGate({
      graph: draft.graph,
      settings: draft.settings,
      rootAcceptance: context.rootTask.acceptance,
      critic,
      policy: settings.policy.config,
      triggerKind: detail.run.triggerKind,
    });
    await this.repositories.planning.recordQualityMetric({
      runId: detail.run.id,
      actorId: detail.run.createdByPrincipalId,
      criticScore: critic.score,
      validatorErrorCount: evaluation.inspection.validatorErrorCount,
      acceptanceCoverage: evaluation.inspection.acceptanceCoverage,
      nodeCount: evaluation.inspection.nodeCount,
      depth: evaluation.inspection.depth,
      humanReviewRequired: evaluation.gate.reviewRequired,
      autoApproveEligible: evaluation.gate.autoApproveEligible,
    });
    return { critic, gate: evaluation.gate };
  }

  private async currentQualityGate(
    detail: PlanningRunDetail,
  ): Promise<{
    readonly critic: CriticReportPayload;
    readonly gate: PlanningQualityGate;
  }> {
    const context = requireContext(detail);
    const draft = requireArtifact(detail, "plan-draft").payload;
    const critic = requireArtifact(detail, "critic").payload;
    const settings = await this.repositories.planning.getSettings(
      detail.run.projectId,
    );
    return {
      critic,
      gate: evaluatePlanningQualityGate({
        graph: draft.graph,
        settings: draft.settings,
        rootAcceptance: context.rootTask.acceptance,
        critic,
        policy: settings.policy.config,
        triggerKind: detail.run.triggerKind,
      }).gate,
    };
  }

  private async bindDraft(
    detail: PlanningRunDetail,
    autoApprove: boolean,
  ): Promise<void> {
    const draft = requireArtifact(detail, "plan-draft").payload;
    await this.repositories.workflowPlans.createPlan({
      planId: randomUUID(),
      projectId: detail.run.projectId,
      rootTaskId: detail.run.rootTaskId,
      source: "router",
      graph: draft.graph,
      settings: draft.settings,
      reason: draft.reason,
      actorId: detail.run.createdByPrincipalId,
      routerAgent: null,
      planningRunId: detail.run.id,
      planningRunRevision: detail.run.revision,
      autoApprove,
    });
  }
}

export class AcceptancePlanningPlanner implements PlanningPlanner {
  readonly id = "pluginmax:acceptance-planner";
  readonly version = "1";

  async draft(input: {
    readonly context: PlanningContextPackPayload;
    readonly settings: PlanningSettings;
  }): Promise<PlanningDraft> {
    const { context } = input;
    const root = context.rootTask;
    const candidate = context.agentCandidates.find(
      (agent) => agent.agentId === root.agentId,
    );
    const humanApprover = context.members
      .filter(
        (member) =>
          member.kind === "human" && member.status === "active",
      )
      .sort((left, right) => Number(right.roleIds.length) - Number(left.roleIds.length))[0];
    const acceptance =
      root.acceptance.length === 0
        ? ["Root Task completed with verifiable evidence"]
        : root.acceptance;
    const nodes = acceptance.map((statement, index) => {
      const node: WorkflowGraph["nodes"][number] = {
        id: `step-${index + 1}`,
        name: `${root.title} · 步骤 ${index + 1}`.slice(0, 160),
        type: "task",
        executor: {
          kind: "agent",
          id: root.agentId,
          ...(candidate === undefined ? {} : { label: candidate.name }),
        },
        description: [
          `执行 Root Task“${root.title}”的验收步骤。`,
          `证据要求：${statement}`,
        ].join("\n"),
        acceptance: [statement],
        approvers: [],
        approvalPolicy: "all",
        autoDispatch: false,
        start: index === 0,
        maxAttempts: 1,
        timeoutSeconds: 900,
      };
      if (isPlanningHighRiskNode(node) && humanApprover !== undefined) {
        node.approvers = [
          {
            kind: "user",
            id: humanApprover.actorId,
            label: humanApprover.name,
          },
        ];
      }
      return node;
    });
    const edges = nodes.slice(1).map((node, index) => ({
      id: `edge-${index + 1}-${index + 2}`,
      from: nodes[index]!.id,
      to: node.id,
    }));
    return {
      graph: {
        key: `planning:${root.id}`,
        version: 1,
        name: `${root.title} · Planning Draft`,
        description: root.description,
        nodes,
        edges,
        startNodeIds: nodes.length === 0 ? [] : [nodes[0]!.id],
        warnings: [],
      },
      settings: {
        maxNodes: input.settings.policy.config.maxNodes,
        maxDepth: input.settings.policy.config.maxDepth,
        maxOutDegree: 20,
        maxConcurrency: 8,
      },
      reason: "依据 Root Task Acceptance 生成可检查计划",
    };
  }
}

export class DeterministicPlanningCritic implements PlanningCritic {
  readonly id = "pluginmax:deterministic-critic";
  readonly version = "1";

  async review(input: {
    readonly context: PlanningContextPackPayload;
    readonly draft: PlanningPlanDraftPayload;
  }): Promise<CriticReportPayload> {
    return critiquePlanningGraph({
      graph: input.draft.graph,
      settings: input.draft.settings,
      rootAcceptance: input.context.rootTask.acceptance,
    });
  }
}

export class EmptyPlanningKnowledgeProvider
  implements PlanningKnowledgeProvider
{
  readonly id = "pluginmax:noop-knowledge";
  readonly version = "1";

  async provide(): Promise<readonly PlanningKnowledgeContribution[]> {
    return [];
  }
}

function requireContext(
  detail: PlanningRunDetail,
): PlanningContextPackPayload {
  const artifact = latestArtifact(detail, "context-pack");
  if (artifact === undefined) {
    throw new PlanningRepositoryError(
      "planning_artifact_invalid",
      "Planning Context is missing",
    );
  }
  return artifact.payload;
}

function contextPayload(
  detail: PlanningRunDetail,
): PlanningContextPackPayload | undefined {
  return latestArtifact(detail, "context-pack")?.payload;
}

function latestArtifact<K extends PlanningArtifact["kind"]>(
  detail: PlanningRunDetail,
  kind: K,
): Extract<PlanningArtifact, { kind: K }> | undefined {
  return detail.artifacts
    .filter(
      (artifact): artifact is Extract<PlanningArtifact, { kind: K }> =>
        artifact.kind === kind,
    )
    .sort((left, right) => right.version - left.version)[0];
}

function requireArtifact<K extends PlanningArtifact["kind"]>(
  detail: PlanningRunDetail,
  kind: K,
): Extract<PlanningArtifact, { kind: K }> {
  const artifact = latestArtifact(detail, kind);
  if (artifact === undefined) {
    throw new PlanningRepositoryError(
      "planning_artifact_invalid",
      `Planning Artifact ${kind} is missing`,
    );
  }
  planningArtifactPayloadSchema(kind).parse(artifact.payload);
  return artifact;
}

function buildRequirementBrief(
  context: PlanningContextPackPayload,
): RequirementBriefPayload {
  return {
    objective: context.rootTask.title,
    scopeIn: context.rootTask.acceptance,
    scopeOut: [],
    assumptions: [
      `Root Task revision ${context.rootTaskRevision}`,
      `Project ${context.project.name}`,
    ],
    constraints: [
      ...context.platformSafetyRules,
      ...context.roles.map(
        (role) => `Role ${role.name}: ${role.permissions.join(", ")}`,
      ),
    ].slice(0, 200),
    openQuestions: [],
  };
}

function buildFactsLedger(
  context: PlanningContextPackPayload,
): FactsLedgerPayload {
  const entries: FactsLedgerPayload["entries"] = [
    {
      id: `task:${context.rootTask.id}:revision`,
      statement: `Root Task revision is ${context.rootTaskRevision}`,
      sourceKind: "task",
      sourceId: context.rootTask.id,
      sourceDigest: null,
      confidence: 1,
      verified: true,
    },
    {
      id: `project:${context.project.id}:status`,
      statement: `Project ${context.project.name} is ${context.project.status}`,
      sourceKind: "project",
      sourceId: context.project.id,
      sourceDigest: null,
      confidence: 1,
      verified: true,
    },
    ...context.meetings.map((meeting) => ({
      id: `meeting:${meeting.id}`,
      statement: `Meeting ${meeting.title} is ${meeting.status}`,
      sourceKind: "meeting" as const,
      sourceId: meeting.id,
      sourceDigest: null,
      confidence: 1,
      verified: true,
    })),
    ...context.workflows.map((workflow) => ({
      id: `workflow:${workflow.id}`,
      statement: `Workflow ${workflow.title} is ${workflow.status}`,
      sourceKind: "workflow" as const,
      sourceId: workflow.id,
      sourceDigest: null,
      confidence: 1,
      verified: true,
    })),
    ...context.documents.map((document) => ({
      id: `document:${document.id}`,
      statement: `Document ${document.title} is available to planning`,
      sourceKind: "document" as const,
      sourceId: document.id,
      sourceDigest: document.sha256,
      confidence: 1,
      verified: true,
    })),
    ...context.memories.map((memory) => ({
      id: `memory:${memory.id}`,
      statement: `Memory source ${memory.title} was captured from ${memory.sourceType}`,
      sourceKind: "memory" as const,
      sourceId: memory.id,
      sourceDigest: null,
      confidence: 0.8,
      verified: true,
    })),
    ...context.knowledgeContributions
      .filter((contribution) => contribution.inclusion === "included")
      .map((contribution) => ({
        id: `knowledge:${contribution.providerId}:${contribution.sourceId}`,
        statement: contribution.statement,
        sourceKind: "knowledge" as const,
        sourceId: contribution.sourceId,
        sourceDigest: contribution.contentDigest,
        confidence: contribution.confidence,
        verified: contribution.verified,
      })),
  ];
  return { entries: entries.slice(0, 1_000) };
}

function buildKnowledgeReceipt(
  context: PlanningContextPackPayload,
): PlanningKnowledgeReceiptPayload {
  return {
    contextDigest: digest(context),
    receipts: context.knowledgeContributions
      .map((contribution) => ({
        providerId: contribution.providerId,
        providerVersion: contribution.providerVersion,
        sourceId: contribution.sourceId,
        contentDigest: contribution.contentDigest,
        inclusion: contribution.inclusion,
        reason: contribution.reason,
      }))
      .slice(0, 1_000),
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
