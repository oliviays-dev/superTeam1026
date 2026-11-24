import { z } from "zod";
import {
  workflowGraphNodeSchema,
  workflowGraphSchema,
} from "./collaboration.js";
import { workflowDefinitionOriginSchema } from "./workflow-assignment.js";

export const ROUTER_WORKER_FLAG = "workflow.router_worker";
export const ROUTER_SUBMIT_PLAN_TOOL = "router_worker_submit_plan";
export const ROUTER_SUBMIT_FINAL_DRAFT_TOOL =
  "router_worker_submit_final_draft";
export const ROUTER_TOOL_CONTRACT = [
  ROUTER_SUBMIT_PLAN_TOOL,
  ROUTER_SUBMIT_FINAL_DRAFT_TOOL,
] as const;

export const workflowPlanSourceSchema = workflowDefinitionOriginSchema;
export type WorkflowPlanSource = z.infer<typeof workflowPlanSourceSchema>;

export const workflowPlanStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "active",
  "finalizing",
  "completed",
  "cancelled",
  "failed",
  "paused",
  "resume_required",
]);
export type WorkflowPlanStatus = z.infer<typeof workflowPlanStatusSchema>;

export const workflowPlanSettingsSchema = z.object({
  maxNodes: z.number().int().min(1).max(200).default(100),
  maxDepth: z.number().int().min(1).max(100).default(32),
  maxOutDegree: z.number().int().min(1).max(100).default(20),
  maxConcurrency: z.number().int().min(1).max(64).default(8),
});
export type WorkflowPlanSettings = z.infer<typeof workflowPlanSettingsSchema>;

export const workflowPlanValidationIssueSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2_000),
  nodeId: z.string().trim().min(1).max(160).optional(),
  edgeId: z.string().trim().min(1).max(160).optional(),
});
export type WorkflowPlanValidationIssue = z.infer<
  typeof workflowPlanValidationIssueSchema
>;

export const workflowPlanValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(workflowPlanValidationIssueSchema),
  topologicalNodeIds: z.array(z.string()),
});
export type WorkflowPlanValidationResult = z.infer<
  typeof workflowPlanValidationResultSchema
>;

export const routerAgentContractSchema = z.object({
  tools: z.array(z.string()).length(ROUTER_TOOL_CONTRACT.length),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RouterAgentContract = z.infer<typeof routerAgentContractSchema>;

export const routerAgentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  teammateId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  aiPrincipalId: z.string(),
  templateId: z.string().uuid(),
  templateVersionId: z.string().uuid(),
  templateVersion: z.number().int().positive(),
  contract: routerAgentContractSchema,
  status: z.enum(["active", "disabled"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RouterAgent = z.infer<typeof routerAgentSchema>;

export const registerRouterAgentInputSchema = z.object({
  teammateId: z.string().uuid(),
});
export type RegisterRouterAgentInput = z.infer<
  typeof registerRouterAgentInputSchema
>;

export const provisionRouterTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Router Agent"),
});
export type ProvisionRouterTemplateInput = z.input<
  typeof provisionRouterTemplateInputSchema
>;

export const workflowPlanVersionSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  version: z.number().int().positive(),
  source: workflowPlanSourceSchema,
  graph: workflowGraphSchema,
  settings: workflowPlanSettingsSchema,
  reason: z.string(),
  createdBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  routerAgent: routerAgentSchema.nullable(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WorkflowPlanVersion = z.infer<typeof workflowPlanVersionSchema>;

export const workflowPlanSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  rootTaskId: z.string().uuid(),
  source: workflowPlanSourceSchema,
  planningRunId: z.string().uuid().nullable(),
  currentVersion: z.number().int().positive(),
  status: workflowPlanStatusSchema,
  revision: z.number().int().positive(),
  confirmedByPrincipalId: z.string().nullable(),
  confirmedByRole: z.string().nullable(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
  routerAgentId: z.string().uuid().nullable(),
  workflowDefinitionId: z.string().uuid(),
  workflowInstanceId: z.string().uuid().nullable(),
  gateEpoch: z.number().int().nonnegative().nullable(),
  createdBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

export const planMaterializationStatusSchema = z.enum([
  "pending",
  "materializing",
  "materialized",
  "failed",
]);
export type PlanMaterializationStatus = z.infer<
  typeof planMaterializationStatusSchema
>;

export const planMaterializationSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  planVersion: z.number().int().positive(),
  nodeId: z.string(),
  creationKey: z.string(),
  status: planMaterializationStatusSchema,
  taskId: z.string().uuid().nullable(),
  lastError: z.string().nullable(),
  leaseOwner: z.string().nullable(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PlanMaterialization = z.infer<typeof planMaterializationSchema>;

export const workflowPlanAuditKindSchema = z.enum([
  "plan.created",
  "plan.updated",
  "plan.approved",
  "plan.materialized",
  "plan.reconciled",
  "plan.finalized",
  "plan.failed",
  "plan.resume_required",
  "router_agent.registered",
  "feature_gate.updated",
]);
export type WorkflowPlanAuditKind = z.infer<
  typeof workflowPlanAuditKindSchema
>;

export const workflowPlanAuditEventSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  seq: z.number().int().positive(),
  kind: workflowPlanAuditKindSchema,
  actorId: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkflowPlanAuditEvent = z.infer<
  typeof workflowPlanAuditEventSchema
>;

export const workflowPlanDetailSchema = z.object({
  plan: workflowPlanSchema,
  version: workflowPlanVersionSchema,
  versions: z.array(workflowPlanVersionSchema),
  materializations: z.array(planMaterializationSchema),
  audit: z.array(workflowPlanAuditEventSchema),
});
export type WorkflowPlanDetail = z.infer<typeof workflowPlanDetailSchema>;

const planGraphNodeChangeSchema = z.object({
  nodeId: z.string(),
  before: workflowGraphNodeSchema.nullable(),
  after: workflowGraphNodeSchema.nullable(),
});

export const workflowPlanDiffSchema = z.object({
  planId: z.string().uuid(),
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  nodes: z.array(planGraphNodeChangeSchema),
  addedEdgeIds: z.array(z.string()),
  removedEdgeIds: z.array(z.string()),
  changedEdgeIds: z.array(z.string()),
});
export type WorkflowPlanDiff = z.infer<typeof workflowPlanDiffSchema>;

export const createWorkflowPlanInputSchema = z.object({
  rootTaskId: z.string().uuid(),
  source: workflowPlanSourceSchema,
  graph: workflowGraphSchema,
  settings: workflowPlanSettingsSchema.default({}),
  reason: z.string().trim().max(4_000).default(""),
  routerAgentId: z.string().uuid().optional(),
  planningRunId: z.string().uuid().optional(),
  planningRunRevision: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (
    value.source === "router" &&
    (value.planningRunId === undefined ||
      value.planningRunRevision === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Router plans require a server-verifiable Planning Run and revision",
      path: ["planningRunId"],
    });
  }
});
export type CreateWorkflowPlanInput = z.input<
  typeof createWorkflowPlanInputSchema
>;

export const createWorkflowPlanVersionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  graph: workflowGraphSchema,
  settings: workflowPlanSettingsSchema.default({}),
  reason: z.string().trim().max(4_000).default(""),
  routerAgentId: z.string().uuid().optional(),
});
export type CreateWorkflowPlanVersionInput = z.input<
  typeof createWorkflowPlanVersionInputSchema
>;

export const approveWorkflowPlanInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedGateEpoch: z.number().int().nonnegative().optional(),
  role: z.string().trim().max(120).optional(),
});
export type ApproveWorkflowPlanInput = z.infer<
  typeof approveWorkflowPlanInputSchema
>;

export const materializeWorkflowPlanInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedGateEpoch: z.number().int().nonnegative(),
});
export type MaterializeWorkflowPlanInput = z.infer<
  typeof materializeWorkflowPlanInputSchema
>;

export const finalizeWorkflowPlanInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedGateEpoch: z.number().int().nonnegative(),
});
export type FinalizeWorkflowPlanInput = z.infer<
  typeof finalizeWorkflowPlanInputSchema
>;

export const resumeWorkflowPlanInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedGateEpoch: z.number().int().nonnegative(),
});
export type ResumeWorkflowPlanInput = z.infer<
  typeof resumeWorkflowPlanInputSchema
>;

export const routerFeatureGateSchema = z.object({
  flagKey: z.literal(ROUTER_WORKER_FLAG),
  scopeType: z.literal("project"),
  scopeId: z.string().uuid(),
  enabled: z.boolean(),
  epoch: z.number().int().positive(),
  revision: z.number().int().positive(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type RouterFeatureGate = z.infer<typeof routerFeatureGateSchema>;

export const setRouterFeatureGateInputSchema = z.object({
  enabled: z.boolean(),
  expectedEpoch: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
});
export type SetRouterFeatureGateInput = z.infer<
  typeof setRouterFeatureGateInputSchema
>;

export const sweepWorkflowPlansInputSchema = z.object({
  batchSize: z.number().int().min(1).max(200).default(20),
  leaseSeconds: z.number().int().min(1).max(3_600).default(30),
  staleAfterSeconds: z.number().int().min(1).max(86_400).default(2),
});
export type SweepWorkflowPlansInput = z.input<
  typeof sweepWorkflowPlansInputSchema
>;

export const planCreationKey = (
  planId: string,
  planVersion: number,
  nodeId: string,
): string => `plan-node:${planId}:v${planVersion}:${nodeId}`;
