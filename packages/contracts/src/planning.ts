import { z } from "zod";
import {
  skillBindingModeSchema,
  skillBindingSceneSchema,
} from "./skill.js";
import { workflowGraphSchema } from "./collaboration.js";
import { workflowPlanSettingsSchema } from "./workflow-plan.js";

export const PLANNING_MANUAL_FLAG = "planning.manual";
export const PLANNING_AUTOPILOT_FLAG = "planning.autopilot";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const principalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const isoTimeSchema = z.string().datetime({ offset: true });

export const planningTriggerKindSchema = z.enum([
  "human-manual",
  "agent-assigned",
  "task-spec-changed",
  "agent-requested",
  "replan-requested",
]);
export type PlanningTriggerKind = z.infer<typeof planningTriggerKindSchema>;

export const planningRunStatusSchema = z.enum([
  "queued",
  "preparing",
  "understanding",
  "clarifying",
  "drafting",
  "critiquing",
  "validating",
  "review_required",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
]);
export type PlanningRunStatus = z.infer<typeof planningRunStatusSchema>;

export const PLANNING_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly PlanningRunStatus[];

export const PLANNING_RUN_ACTIVE_STATUSES = [
  "queued",
  "preparing",
  "understanding",
  "clarifying",
  "drafting",
  "critiquing",
  "validating",
  "review_required",
  "paused",
] as const satisfies readonly PlanningRunStatus[];

export const planningTriggerPolicySchema = z
  .object({
    agentAssigned: z.boolean().default(false),
    taskSpecChanged: z.boolean().default(false),
    agentRequested: z.boolean().default(false),
    replanRequested: z.boolean().default(true),
  })
  .strict();
export type PlanningTriggerPolicy = z.infer<
  typeof planningTriggerPolicySchema
>;

export const planningPolicyConfigSchema = z
  .object({
    minScore: z.number().int().min(0).max(100).default(80),
    autoApprove: z.boolean().default(false),
    highRiskReview: z.boolean().default(true),
    requireHumanReview: z.boolean().default(true),
    maxNodes: z.number().int().min(1).max(200).default(100),
    maxDepth: z.number().int().min(1).max(100).default(32),
    triggerPolicy: planningTriggerPolicySchema.default({}),
  })
  .strict();
export type PlanningPolicyConfig = z.infer<
  typeof planningPolicyConfigSchema
>;

export const planningPolicyScopeSchema = z.enum(["platform", "project"]);
export type PlanningPolicyScope = z.infer<typeof planningPolicyScopeSchema>;

export const planningPolicySchema = z
  .object({
    id: z.string().uuid(),
    scopeType: planningPolicyScopeSchema,
    scopeId: z.string().trim().min(1).max(180),
    revision: z.number().int().positive(),
    config: planningPolicyConfigSchema,
    updatedBy: principalIdSchema,
    updatedAt: isoTimeSchema,
  })
  .strict();
export type PlanningPolicy = z.infer<typeof planningPolicySchema>;

export const planningFeatureFlagSchema = z
  .object({
    flagKey: z.enum([PLANNING_MANUAL_FLAG, PLANNING_AUTOPILOT_FLAG]),
    enabled: z.boolean(),
    mode: z.enum(["off", "observe", "enforce", "on"]),
    revision: z.number().int().positive(),
    updatedBy: principalIdSchema,
    updatedAt: isoTimeSchema,
  })
  .strict();
export type PlanningFeatureFlag = z.infer<typeof planningFeatureFlagSchema>;

export const planningSettingsSchema = z
  .object({
    projectId: z.string().uuid(),
    policy: planningPolicySchema,
    manual: planningFeatureFlagSchema,
    autopilot: planningFeatureFlagSchema,
  })
  .strict();
export type PlanningSettings = z.infer<typeof planningSettingsSchema>;

const planningSettingsChangeShape = {
  expectedRevision: z.number().int().positive(),
  policy: planningPolicyConfigSchema.partial().optional(),
  flags: z
    .object({
      manual: z.boolean().optional(),
      autopilot: z.boolean().optional(),
    })
    .strict()
    .optional(),
};

export const updatePlanningSettingsInputSchema = z
  .object(planningSettingsChangeShape)
  .strict()
  .refine(
    (value) => value.policy !== undefined || value.flags !== undefined,
    "At least one planning setting must be provided",
  );
export type UpdatePlanningSettingsInput = z.input<
  typeof updatePlanningSettingsInputSchema
>;

export const planningRunSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    rootTaskId: z.string().uuid(),
    status: planningRunStatusSchema,
    revision: z.number().int().positive(),
    triggerKind: planningTriggerKindSchema,
    rootTaskRevision: z.number().int().positive(),
    policyRevision: z.number().int().positive(),
    sourceRunId: z.string().uuid().nullable(),
    workflowPlanId: z.string().uuid().nullable(),
    triggerCount: z.number().int().positive(),
    createdByPrincipalId: principalIdSchema,
    blockedReason: z.string().nullable(),
    failureCode: z.string().nullable(),
    createdAt: isoTimeSchema,
    updatedAt: isoTimeSchema,
    startedAt: isoTimeSchema.nullable(),
    pausedAt: isoTimeSchema.nullable(),
    terminalAt: isoTimeSchema.nullable(),
  })
  .strict();
export type PlanningRun = z.infer<typeof planningRunSchema>;

export const planningTriggerReceiptStatusSchema = z.enum([
  "accepted",
  "merged",
  "discarded",
]);
export type PlanningTriggerReceiptStatus = z.infer<
  typeof planningTriggerReceiptStatusSchema
>;

export const planningTriggerReceiptSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    rootTaskId: z.string().uuid(),
    planningRunId: z.string().uuid(),
    triggerKind: planningTriggerKindSchema,
    rootTaskRevision: z.number().int().positive(),
    eventKey: digestSchema,
    requestDigest: digestSchema,
    status: planningTriggerReceiptStatusSchema,
    reason: z.string(),
    createdAt: isoTimeSchema,
  })
  .strict();
export type PlanningTriggerReceipt = z.infer<
  typeof planningTriggerReceiptSchema
>;

export const requirementBriefPayloadSchema = z
  .object({
    objective: z.string().trim().min(1).max(20_000),
    scopeIn: z.array(z.string().trim().min(1).max(2_000)).max(200),
    scopeOut: z.array(z.string().trim().min(1).max(2_000)).max(200),
    assumptions: z.array(z.string().trim().min(1).max(2_000)).max(200),
    constraints: z.array(z.string().trim().min(1).max(2_000)).max(200),
    openQuestions: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            question: z.string().trim().min(1).max(4_000),
            required: z.boolean(),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type RequirementBriefPayload = z.infer<
  typeof requirementBriefPayloadSchema
>;

export const factsLedgerPayloadSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            statement: z.string().trim().min(1).max(20_000),
            sourceKind: z.enum([
              "task",
              "project",
              "meeting",
              "workflow",
              "document",
              "memory",
              "knowledge",
            ]),
            sourceId: z.string().trim().min(1).max(240),
            sourceDigest: digestSchema.nullable(),
            confidence: z.number().min(0).max(1),
            verified: z.boolean(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();
export type FactsLedgerPayload = z.infer<typeof factsLedgerPayloadSchema>;

export const criticReportPayloadSchema = z
  .object({
    verdict: z.enum(["pass", "revise", "reject"]),
    score: z.number().min(0).max(100),
    summary: z.string().trim().max(20_000),
    findings: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(120),
            severity: z.enum(["info", "warning", "error"]),
            message: z.string().trim().min(1).max(4_000),
            nodeId: z.string().trim().min(1).max(160).nullable(),
          })
          .strict(),
      )
      .max(500),
    checks: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(120),
            status: z.enum(["pass", "warning", "fail"]),
            message: z.string().trim().min(1).max(4_000),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type CriticReportPayload = z.infer<typeof criticReportPayloadSchema>;

export const planningSkillSnapshotPayloadSchema = z
  .object({
    contextDigest: digestSchema,
    skills: z
      .array(
        z
          .object({
            skillId: z.string().uuid(),
            skillVersionId: z.string().uuid(),
            version: z.number().int().positive(),
            digest: digestSchema,
            instructionsHash: digestSchema.nullable(),
            source: z.enum(["platform", "user", "instance"]),
            required: z.boolean(),
            enabled: z.boolean(),
            mode: skillBindingModeSchema,
            scenes: z.array(skillBindingSceneSchema),
            grantsAuthorization: z.literal(false),
            inclusion: z.enum(["included", "excluded"]),
            reason: z.string().trim().max(2_000).nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type PlanningSkillSnapshotPayload = z.infer<
  typeof planningSkillSnapshotPayloadSchema
>;

export const planningKnowledgeReceiptPayloadSchema = z
  .object({
    contextDigest: digestSchema,
    receipts: z
      .array(
        z
          .object({
            providerId: z.string().trim().min(1).max(180),
            providerVersion: z.string().trim().min(1).max(120).nullable(),
            sourceId: z.string().trim().min(1).max(240),
            contentDigest: digestSchema.nullable(),
            inclusion: z.enum(["included", "excluded"]),
            reason: z.string().trim().max(2_000).nullable(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();
export type PlanningKnowledgeReceiptPayload = z.infer<
  typeof planningKnowledgeReceiptPayloadSchema
>;

export const planningKnowledgeContributionSchema = z
  .object({
    providerId: z.string().trim().min(1).max(180),
    providerVersion: z.string().trim().min(1).max(120).nullable(),
    sourceId: z.string().trim().min(1).max(240),
    contentDigest: digestSchema.nullable(),
    statement: z.string().trim().min(1).max(20_000),
    confidence: z.number().min(0).max(1),
    verified: z.boolean(),
    inclusion: z.enum(["included", "excluded"]),
    reason: z.string().trim().max(2_000).nullable(),
  })
  .strict();
export type PlanningKnowledgeContribution = z.infer<
  typeof planningKnowledgeContributionSchema
>;

const planningContextSourceBaseShape = {
  id: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(500),
  updatedAt: isoTimeSchema,
};

export const planningContextPackPayloadSchema = z
  .object({
    version: z.literal(1),
    rootTaskRevision: z.number().int().positive(),
    rootTask: z
      .object({
        id: z.string().uuid(),
        projectId: z.string().uuid(),
        parentTaskId: z.string().uuid().nullable(),
        title: z.string().trim().min(1).max(240),
        description: z.string().trim().min(1).max(20_000),
        acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50),
        status: z.enum([
          "queued",
          "in_progress",
          "review",
          "paused",
          "blocked",
          "needs_input",
          "done",
          "cancelled",
        ]),
        priority: z.enum(["low", "medium", "high", "urgent"]),
        agentId: z.string().uuid(),
        roleId: z.string().uuid().nullable(),
        revision: z.number().int().positive(),
      })
      .strict(),
    project: z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(160),
        status: z.enum(["active", "archived"]),
      })
      .strict(),
    members: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            kind: z.enum(["human", "agent"]),
            actorId: z.string().trim().min(1).max(180),
            principalId: z.string().trim().min(1).max(180).nullable(),
            name: z.string().trim().min(1).max(160),
            responsibility: z.string().max(2_000),
            status: z.enum(["active", "inactive"]),
            roleIds: z.array(z.string().uuid()),
          })
          .strict(),
      )
      .max(500),
    roles: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            code: z.string().max(80),
            name: z.string().trim().min(1).max(80),
            category: z.string().trim().min(1).max(80),
            permissions: z.array(z.string().trim().min(1).max(80)),
          })
          .strict(),
      )
      .max(200),
    agentCandidates: z
      .array(
        z
          .object({
            agentId: z.string().uuid(),
            name: z.string().trim().min(1).max(160),
            runtimeKind: z.string().trim().min(1).max(80),
            status: z.enum(["active", "disabled"]),
            source: z.string().trim().min(1).max(80),
            teammateId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .max(500),
    meetings: z
      .array(
        z
          .object({
            ...planningContextSourceBaseShape,
            status: z.enum(["open", "closed"]),
          })
          .strict(),
      )
      .max(200),
    workflows: z
      .array(
        z
          .object({
            ...planningContextSourceBaseShape,
            status: z.enum(["active", "archived"]),
          })
          .strict(),
      )
      .max(200),
    documents: z
      .array(
        z
          .object({
            ...planningContextSourceBaseShape,
            mimeType: z.string().min(1).max(240),
            sha256: digestSchema.nullable(),
          })
          .strict(),
      )
      .max(500),
    memories: z
      .array(
        z
          .object({
            ...planningContextSourceBaseShape,
            sourceType: z.string().trim().min(1).max(80),
            sourceId: z.string().trim().min(1).max(180),
          })
          .strict(),
      )
      .max(500),
    platformSafetyRules: z.array(z.string().trim().min(1).max(4_000)).max(100),
    knowledgeContributions: z
      .array(planningKnowledgeContributionSchema)
      .max(1_000),
  })
  .strict();
export type PlanningContextPackPayload = z.infer<
  typeof planningContextPackPayloadSchema
>;

export const planningPlanDraftPayloadSchema = z
  .object({
    contextDigest: digestSchema,
    graph: workflowGraphSchema,
    settings: workflowPlanSettingsSchema,
    reason: z.string().trim().max(4_000),
    plannerId: z.string().trim().min(1).max(180),
    plannerVersion: z.string().trim().min(1).max(120),
  })
  .strict();
export type PlanningPlanDraftPayload = z.infer<
  typeof planningPlanDraftPayloadSchema
>;

export const planningQualityCheckSchema = z
  .object({
    code: z.string().trim().min(1).max(120),
    status: z.enum(["pass", "warning", "fail"]),
    message: z.string().trim().min(1).max(4_000),
    nodeId: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();
export type PlanningQualityCheck = z.infer<
  typeof planningQualityCheckSchema
>;

export const planningQualityGateSchema = z
  .object({
    eligible: z.boolean(),
    reviewRequired: z.boolean(),
    autoApproveEligible: z.boolean(),
    criticVerdict: z.enum(["pass", "revise", "reject"]),
    criticScore: z.number().min(0).max(100),
    acceptanceCoverage: z.number().min(0).max(1),
    validatorErrorCount: z.number().int().nonnegative(),
    highRiskNodeIds: z.array(z.string().trim().min(1).max(160)),
    reasons: z.array(z.string().trim().min(1).max(4_000)),
    checks: z.array(planningQualityCheckSchema),
  })
  .strict();
export type PlanningQualityGate = z.infer<typeof planningQualityGateSchema>;

export const planningArtifactKindSchema = z.enum([
  "requirement-brief",
  "facts-ledger",
  "critic",
  "context-pack",
  "plan-draft",
  "skill-snapshot",
  "knowledge-receipt",
]);
export type PlanningArtifactKind = z.infer<
  typeof planningArtifactKindSchema
>;

const planningArtifactBaseShape = {
  id: z.string().uuid(),
  runId: z.string().uuid(),
  version: z.number().int().positive(),
  contentDigest: digestSchema,
  createdByPrincipalId: principalIdSchema,
  createdAt: isoTimeSchema,
};

export const planningArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("requirement-brief"),
      payload: requirementBriefPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("facts-ledger"),
      payload: factsLedgerPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("critic"),
      payload: criticReportPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("context-pack"),
      payload: planningContextPackPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("plan-draft"),
      payload: planningPlanDraftPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("skill-snapshot"),
      payload: planningSkillSnapshotPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...planningArtifactBaseShape,
      kind: z.literal("knowledge-receipt"),
      payload: planningKnowledgeReceiptPayloadSchema,
    })
    .strict(),
]);
export type PlanningArtifact = z.infer<typeof planningArtifactSchema>;

export const planningEventKindSchema = z.enum([
  "run.created",
  "trigger.merged",
  "run.started",
  "run.paused",
  "run.cancelled",
  "run.review_required",
  "run.retried",
  "run.succeeded",
  "run.failed",
  "artifact.recorded",
  "quality.recorded",
]);
export type PlanningEventKind = z.infer<typeof planningEventKindSchema>;

export const planningEventSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    seq: z.number().int().positive(),
    kind: planningEventKindSchema,
    eventKey: digestSchema,
    actorPrincipalId: principalIdSchema,
    summary: z.string().trim().min(1).max(4_000),
    data: z.record(z.string(), z.unknown()).nullable(),
    createdAt: isoTimeSchema,
  })
  .strict();
export type PlanningEvent = z.infer<typeof planningEventSchema>;

export const planningQualityMetricSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    version: z.number().int().positive(),
    criticScore: z.number().min(0).max(100).nullable(),
    validatorErrorCount: z.number().int().nonnegative(),
    acceptanceCoverage: z.number().min(0).max(1).nullable(),
    nodeCount: z.number().int().nonnegative(),
    depth: z.number().int().nonnegative(),
    humanReviewRequired: z.boolean(),
    autoApproveEligible: z.boolean(),
    recordedByPrincipalId: principalIdSchema,
    recordedAt: isoTimeSchema,
  })
  .strict();
export type PlanningQualityMetric = z.infer<
  typeof planningQualityMetricSchema
>;

export const planningRunDetailSchema = z
  .object({
    run: planningRunSchema,
    receipts: z.array(planningTriggerReceiptSchema),
    artifacts: z.array(planningArtifactSchema),
    events: z.array(planningEventSchema),
    qualityMetrics: z.array(planningQualityMetricSchema),
  })
  .strict();
export type PlanningRunDetail = z.infer<typeof planningRunDetailSchema>;

export const planningOverviewSchema = z
  .object({
    projectId: z.string().uuid(),
    rootTaskId: z.string().uuid(),
    activeRun: planningRunDetailSchema.nullable(),
    latestRun: planningRunDetailSchema.nullable(),
  })
  .strict();
export type PlanningOverview = z.infer<typeof planningOverviewSchema>;

export const planningStartInputSchema = z
  .object({
    expectedTaskRevision: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(2_000).default("Manual planning start"),
  })
  .strict();
export type PlanningStartInput = z.input<typeof planningStartInputSchema>;

export const planningRunRevisionInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type PlanningRunRevisionInput = z.infer<
  typeof planningRunRevisionInputSchema
>;

export const planningReviewRequiredInputSchema =
  planningRunRevisionInputSchema;
export type PlanningReviewRequiredInput = z.infer<
  typeof planningReviewRequiredInputSchema
>;

export const planningRetryInputSchema = planningRunRevisionInputSchema;
export type PlanningRetryInput = z.infer<typeof planningRetryInputSchema>;

export const planningSubmitPlanInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    graph: workflowGraphSchema,
    settings: workflowPlanSettingsSchema.default({}),
    reason: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type PlanningSubmitPlanInput = z.input<
  typeof planningSubmitPlanInputSchema
>;

export const planningRunOnceInputSchema = z
  .object({
    limit: z.number().int().min(1).max(50).default(4),
  })
  .strict();
export type PlanningRunOnceInput = z.input<typeof planningRunOnceInputSchema>;

export const planningWorkerResultSchema = z
  .object({
    claimed: z.number().int().nonnegative(),
    advanced: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type PlanningWorkerResult = z.infer<typeof planningWorkerResultSchema>;

export const taskDispatchReadinessSchema = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }).strict(),
  z
    .object({
      ready: z.literal(false),
      code: z.enum([
        "planning-required",
        "planning-running",
        "planning-review-required",
        "planning-blocked",
      ]),
      message: z.string().trim().min(1).max(4_000),
      planningRunId: z.string().uuid().nullable(),
      planId: z.string().uuid().nullable(),
      retryToken: z.string().trim().min(1).max(240).optional(),
    })
    .strict(),
]);
export type TaskDispatchReadiness = z.infer<
  typeof taskDispatchReadinessSchema
>;

export function planningArtifactPayloadSchema(
  kind: PlanningArtifactKind,
): z.ZodType<unknown> {
  switch (kind) {
    case "requirement-brief":
      return requirementBriefPayloadSchema;
    case "facts-ledger":
      return factsLedgerPayloadSchema;
    case "critic":
      return criticReportPayloadSchema;
    case "context-pack":
      return planningContextPackPayloadSchema;
    case "plan-draft":
      return planningPlanDraftPayloadSchema;
    case "skill-snapshot":
      return planningSkillSnapshotPayloadSchema;
    case "knowledge-receipt":
      return planningKnowledgeReceiptPayloadSchema;
  }
}
