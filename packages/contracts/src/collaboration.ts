import { z } from "zod";
import {
  projectStatusSchema,
  taskStatusSchema,
  type Agent,
} from "./platform.js";
import {
  templateRoleCategorySchema,
  templateRolePermissionSchema,
} from "./project-templates.js";
import { meetingCollaborationOverviewSchema } from "./meeting-collaboration.js";

export const projectRoleSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  code: z.string().trim().max(80).default(""),
  name: z.string().trim().min(1).max(80),
  category: templateRoleCategorySchema.default("execution"),
  description: z.string().trim().max(1_000),
  permissions: z.array(templateRolePermissionSchema).max(5).default(["read"]),
  libraryRoleId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const createProjectRoleInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  name: z.string().trim().min(1).max(80),
  category: templateRoleCategorySchema.default("execution"),
  description: z.string().trim().max(1_000).default(""),
  permissions: z
    .array(templateRolePermissionSchema)
    .min(1)
    .max(5)
    .default(["read"]),
});
export type CreateProjectRoleInput = z.input<
  typeof createProjectRoleInputSchema
>;

export const updateProjectRoleInputSchema =
  createProjectRoleInputSchema.partial();
export type UpdateProjectRoleInput = z.infer<
  typeof updateProjectRoleInputSchema
>;

export const projectMemberKindSchema = z.enum(["human", "agent"]);
export type ProjectMemberKind = z.infer<typeof projectMemberKindSchema>;

export const projectMemberStatusSchema = z.enum(["active", "inactive"]);
export type ProjectMemberStatus = z.infer<typeof projectMemberStatusSchema>;

export const projectMemberSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: projectMemberKindSchema,
  actorId: z.string().trim().min(1).max(180),
  principalId: z.string().trim().min(1).max(180).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  responsibility: z.string().trim().max(2_000),
  status: projectMemberStatusSchema,
  owner: z.boolean(),
  roles: z.array(projectRoleSchema).max(30),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

const roleIdsSchema = z
  .array(z.string().uuid())
  .max(30)
  .default([])
  .transform((roleIds) => [...new Set(roleIds)]);

export const createProjectMemberInputSchema = z
  .object({
    kind: projectMemberKindSchema,
    agentId: z.string().uuid().optional(),
    actorId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_.:-]{1,180}$/)
      .optional(),
    name: z.string().trim().min(1).max(160).optional(),
    responsibility: z.string().trim().max(2_000).default(""),
    roleIds: roleIdsSchema,
  })
  .superRefine((input, context) => {
    if (input.kind === "agent" && input.agentId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "agentId is required for agent members",
      });
    }
    if (input.kind === "human" && input.agentId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "agentId is only valid for agent members",
      });
    }
    if (input.kind === "agent" && input.actorId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "actorId is only valid for human members",
      });
    }
  });
export type CreateProjectMemberInput = z.infer<
  typeof createProjectMemberInputSchema
>;

export const updateProjectMemberInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  responsibility: z.string().trim().max(2_000).optional(),
  status: projectMemberStatusSchema.optional(),
  roleIds: roleIdsSchema.optional(),
});
export type UpdateProjectMemberInput = z.infer<
  typeof updateProjectMemberInputSchema
>;

export const taskReviewInputSchema = z.object({
  decision: z.enum(["approve", "return"]),
  note: z.string().trim().max(4_000).default(""),
  redispatch: z.boolean().default(false),
});
export type TaskReviewInput = z.infer<typeof taskReviewInputSchema>;

export const artifactSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  storageKey: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const memoryTruthSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  content: z.string(),
  version: z.number().int().positive(),
  sourceType: z.string(),
  sourceId: z.string(),
  claimIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime({ offset: true }),
});
export type MemoryTruth = z.infer<typeof memoryTruthSchema>;

export const memoryClaimStatusSchema = z.enum([
  "proposed",
  "confirmed",
  "rejected",
]);
export type MemoryClaimStatus = z.infer<typeof memoryClaimStatusSchema>;

export const memorySourceKindSchema = z.enum([
  "meeting",
  "minutes-version",
  "meeting-message",
  "action-item",
  "task",
  "run",
  "review",
  "memory-claim",
  "handoff",
  "episode",
]);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

export const memorySourceRefSchema = z.object({
  kind: memorySourceKindSchema,
  id: z.string().trim().min(1).max(180),
  projectId: z.string().uuid(),
  label: z.string().trim().max(500).default(""),
  available: z.boolean().default(true),
});
export type MemorySourceRef = z.infer<typeof memorySourceRefSchema>;

export const memoryClaimSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  content: z.string(),
  status: memoryClaimStatusSchema,
  sourceType: z.string(),
  sourceId: z.string(),
  version: z.number().int().positive().default(1),
  sourceRefs: z.array(memorySourceRefSchema).default([]),
  reviewedAt: z.string().datetime({ offset: true }).nullable().default(null),
  reviewedBy: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MemoryClaim = z.infer<typeof memoryClaimSchema>;

export const memoryTopicSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  currentTruth: memoryTruthSchema.nullable(),
  claims: z.array(memoryClaimSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MemoryTopic = z.infer<typeof memoryTopicSchema>;

export const createMemoryTopicInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
});
export type CreateMemoryTopicInput = z.infer<
  typeof createMemoryTopicInputSchema
>;

export const createMemoryClaimInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  sourceType: z.string().trim().min(1).max(80).default("manual"),
  sourceId: z.string().trim().min(1).max(180).default("local-admin"),
});
export type CreateMemoryClaimInput = z.infer<
  typeof createMemoryClaimInputSchema
>;

export const updateMemoryClaimInputSchema = z.object({
  status: memoryClaimStatusSchema,
  reason: z.string().trim().max(4_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export type UpdateMemoryClaimInput = z.infer<
  typeof updateMemoryClaimInputSchema
>;

export const memoryReviewDecisionSchema = z.enum(["accept", "reject"]);
export type MemoryReviewDecision = z.infer<typeof memoryReviewDecisionSchema>;

export const memoryReviewSelectionSchema = z.object({
  claimId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export type MemoryReviewSelection = z.infer<typeof memoryReviewSelectionSchema>;

export const reviewMemoryClaimsInputSchema = z
  .object({
    items: z
      .array(memoryReviewSelectionSchema)
      .min(1)
      .max(100)
      .transform((items) => {
        const unique = new Map(items.map((item) => [item.claimId, item]));
        return [...unique.values()];
      }),
    decision: memoryReviewDecisionSchema,
    reason: z.string().trim().max(4_000).default(""),
  })
  .superRefine((input, context) => {
    if (input.decision === "reject" && input.reason === "") {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A rejection reason is required",
      });
    }
  });
export type ReviewMemoryClaimsInput = z.infer<
  typeof reviewMemoryClaimsInputSchema
>;

export const memoryClaimReviewSchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  projectId: z.string().uuid(),
  decision: memoryReviewDecisionSchema,
  reason: z.string(),
  actorId: z.string(),
  fromStatus: memoryClaimStatusSchema,
  toStatus: memoryClaimStatusSchema,
  claimVersion: z.number().int().positive(),
  sourceSnapshot: z.array(memorySourceRefSchema),
  createdAt: z.string().datetime({ offset: true }),
});
export type MemoryClaimReview = z.infer<typeof memoryClaimReviewSchema>;

export const memoryReviewResultSchema = z.object({
  claims: z.array(memoryClaimSchema),
  reviews: z.array(memoryClaimReviewSchema),
  topics: z.array(memoryTopicSchema),
});
export type MemoryReviewResult = z.infer<typeof memoryReviewResultSchema>;

export const memoryReviewQueueItemSchema = z.object({
  claim: memoryClaimSchema,
  topicId: z.string().uuid(),
  topicTitle: z.string(),
});
export type MemoryReviewQueueItem = z.infer<typeof memoryReviewQueueItemSchema>;

export const memoryReviewQueueSchema = z.object({
  items: z.array(memoryReviewQueueItemSchema),
  canManage: z.boolean(),
});
export type MemoryReviewQueue = z.infer<typeof memoryReviewQueueSchema>;

export const memoryClaimTraceSchema = z.object({
  claim: memoryClaimSchema,
  topic: memoryTopicSchema,
  reviews: z.array(memoryClaimReviewSchema),
  sources: z.array(memorySourceRefSchema),
});
export type MemoryClaimTrace = z.infer<typeof memoryClaimTraceSchema>;

export const meetingMemoryIngestionResultSchema = z.object({
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()),
  created: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
});
export type MeetingMemoryIngestionResult = z.infer<
  typeof meetingMemoryIngestionResultSchema
>;

export const publishMemoryTruthInputSchema = z
  .object({
    claimIds: z
      .array(z.string().uuid())
      .max(100)
      .default([])
      .transform((ids) => [...new Set(ids)]),
    content: z.string().trim().min(1).max(40_000).optional(),
    sourceType: z.string().trim().min(1).max(80).default("manual"),
    sourceId: z.string().trim().min(1).max(180).default("local-admin"),
  })
  .superRefine((input, context) => {
    if (input.claimIds.length === 0 && input.content === undefined) {
      context.addIssue({
        code: "custom",
        path: ["claimIds"],
        message: "Select at least one claim or provide content",
      });
    }
  });
export type PublishMemoryTruthInput = z.infer<
  typeof publishMemoryTruthInputSchema
>;

export const handoffStatusSchema = z.enum(["draft", "confirmed"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffConfirmationSchema = z.object({
  id: z.string().uuid(),
  handoffId: z.string().uuid(),
  projectId: z.string().uuid(),
  version: z.number().int().positive(),
  actorId: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
});
export type HandoffConfirmation = z.infer<typeof handoffConfirmationSchema>;

export const handoffCardSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  status: handoffStatusSchema,
  version: z.number().int().positive(),
  sourceRefs: z.array(memorySourceRefSchema),
  createdBy: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
  confirmations: z.array(handoffConfirmationSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type HandoffCard = z.infer<typeof handoffCardSchema>;

export const createHandoffCardInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(20_000),
  sourceRefs: z
    .array(memorySourceRefSchema.omit({ available: true }))
    .max(50)
    .default([]),
});
export type CreateHandoffCardInput = z.infer<
  typeof createHandoffCardInputSchema
>;

export const updateHandoffCardInputSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  summary: z.string().trim().min(1).max(20_000).optional(),
  sourceRefs: z
    .array(memorySourceRefSchema.omit({ available: true }))
    .max(50)
    .optional(),
  expectedVersion: z.number().int().positive(),
});
export type UpdateHandoffCardInput = z.infer<
  typeof updateHandoffCardInputSchema
>;

export const confirmHandoffCardInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
});
export type ConfirmHandoffCardInput = z.infer<
  typeof confirmHandoffCardInputSchema
>;

export const agentEpisodeVisibilitySchema = z.enum(["private", "project"]);
export type AgentEpisodeVisibility = z.infer<
  typeof agentEpisodeVisibilitySchema
>;

export const agentEpisodeKindSchema = z.enum([
  "observation",
  "decision",
  "reflection",
  "handoff",
]);
export type AgentEpisodeKind = z.infer<typeof agentEpisodeKindSchema>;

export const agentEpisodeSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  visibility: agentEpisodeVisibilitySchema,
  kind: agentEpisodeKindSchema,
  summary: z.string(),
  content: z.string(),
  sourceRefs: z.array(memorySourceRefSchema),
  createdBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AgentEpisode = z.infer<typeof agentEpisodeSchema>;

export const createAgentEpisodeInputSchema = z.object({
  agentId: z.string().uuid(),
  visibility: agentEpisodeVisibilitySchema.default("private"),
  kind: agentEpisodeKindSchema.default("observation"),
  summary: z.string().trim().min(1).max(1_000),
  content: z.string().trim().max(40_000).default(""),
  sourceRefs: z
    .array(memorySourceRefSchema.omit({ available: true }))
    .max(50)
    .default([]),
});
export type CreateAgentEpisodeInput = z.infer<
  typeof createAgentEpisodeInputSchema
>;

export const workbenchSummarySchema = z.object({
  projects: z.number().int().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
  reviewTasks: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  memoryTopics: z.number().int().nonnegative(),
  workflows: z.number().int().nonnegative(),
  meetings: z.number().int().nonnegative(),
});
export type WorkbenchSummary = z.infer<typeof workbenchSummarySchema>;

export const workflowNodeTypeSchema = z.enum([
  "task",
  "approval",
  "service",
  "decision",
  "subworkflow",
]);
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;

export const workflowExecutorSchema = z.object({
  kind: z.enum(["system", "user", "agent", "role"]),
  id: z.string().trim().min(1).max(180),
});
export type WorkflowExecutor = z.infer<typeof workflowExecutorSchema>;

export const workflowGraphNodeSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  type: workflowNodeTypeSchema,
  executor: workflowExecutorSchema,
  description: z.string().max(4_000),
  approvers: z.array(workflowExecutorSchema).max(30),
  approvalPolicy: z.enum(["all", "any"]),
  autoDispatch: z.boolean(),
  start: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  retryBackoffSeconds: z.number().int().min(0).max(86_400).optional(),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(300),
  approvalDueSeconds: z.number().int().min(1).max(2_592_000).optional(),
  approvalRemindSeconds: z.number().int().min(1).max(2_592_000).optional(),
  approvalEscalateAfterSeconds: z
    .number()
    .int()
    .min(1)
    .max(2_592_000)
    .optional(),
  approvalEscalationRoleId: z.string().uuid().optional(),
  approvalExpireSeconds: z.number().int().min(1).max(2_592_000).optional(),
  approvalExpireAction: z.enum(["reject", "block"]).optional(),
  loopLimit: z.number().int().min(1).max(100).optional(),
  subworkflowKey: z.string().trim().min(1).max(160).optional(),
  subworkflowVersion: z.number().int().positive().optional(),
  runtimeFault: z.enum(["fail", "timeout"]).optional(),
  runtimeDelayMs: z.number().int().min(0).max(60_000).optional(),
});
export type WorkflowGraphNode = z.infer<typeof workflowGraphNodeSchema>;

export const workflowGraphEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
  result: z.enum(["approved", "rejected"]).optional(),
  default: z.boolean().optional(),
  breakCondition: z.string().optional(),
  label: z.string().trim().max(160).optional(),
});
export type WorkflowGraphEdge = z.infer<typeof workflowGraphEdgeSchema>;

export const workflowGraphSchema = z.object({
  key: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema),
  startNodeIds: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export const workflowValidationIssueSchema = z.object({
  line: z.number().int().positive().optional(),
  code: z.string(),
  message: z.string(),
});
export type WorkflowValidationIssue = z.infer<
  typeof workflowValidationIssueSchema
>;

export const workflowValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(workflowValidationIssueSchema),
  warnings: z.array(workflowValidationIssueSchema),
  graph: workflowGraphSchema.nullable(),
});
export type WorkflowValidationResult = z.infer<
  typeof workflowValidationResultSchema
>;

export const validateWorkflowMarkdownInputSchema = z.object({
  markdown: z.string().min(1).max(200_000),
});
export type ValidateWorkflowMarkdownInput = z.infer<
  typeof validateWorkflowMarkdownInputSchema
>;

export const importWorkflowMarkdownInputSchema = z.object({
  projectId: z.string().uuid(),
  markdown: z.string().min(1).max(200_000),
});
export type ImportWorkflowMarkdownInput = z.infer<
  typeof importWorkflowMarkdownInputSchema
>;

export const workflowStepDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["human", "agent"]),
  agentId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
  autoDispatch: z.boolean().optional(),
});
export type WorkflowStepDefinition = z.infer<
  typeof workflowStepDefinitionSchema
>;

export const workflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  steps: z.array(workflowStepDefinitionSchema),
  sourceMarkdown: z.string(),
  graph: workflowGraphSchema.nullable(),
  status: z.enum(["active", "archived"]),
  sourceTemplateId: z.string().uuid().nullable().default(null),
  sourceTemplateVersion: z.number().int().positive().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const createWorkflowInputSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).default(""),
    stepNames: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
    stepRoleIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .superRefine((input, context) => {
    if (
      input.stepRoleIds.length > 0 &&
      input.stepRoleIds.length !== input.stepNames.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["stepRoleIds"],
        message: "stepRoleIds must align one-to-one with stepNames",
      });
    }
  });
export type CreateWorkflowInput = z.infer<typeof createWorkflowInputSchema>;

export const workflowStepStateSchema = z.object({
  stepId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["human", "agent"]),
  status: z.enum(["pending", "active", "completed"]),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});
export type WorkflowStepState = z.infer<typeof workflowStepStateSchema>;

export const workflowInstanceStatusSchema = z.enum([
  "active",
  "waiting",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkflowInstanceStatus = z.infer<
  typeof workflowInstanceStatusSchema
>;

export const workflowRuntimeNodeStatusSchema = z.enum([
  "waiting",
  "ready",
  "running",
  "waiting_approval",
  "blocked",
  "completed",
  "rejected",
  "skipped",
  "failed",
]);
export type WorkflowRuntimeNodeStatus = z.infer<
  typeof workflowRuntimeNodeStatusSchema
>;

export const workflowRuntimeNodeSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  type: workflowNodeTypeSchema,
  status: workflowRuntimeNodeStatusSchema,
  visits: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  approvalPolicy: z.enum(["all", "any"]),
  selectedEdgeId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  taskId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  childInstanceId: z.string().uuid().nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  timeoutAt: z.string().datetime({ offset: true }).nullable(),
  failureCount: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type WorkflowRuntimeNode = z.infer<typeof workflowRuntimeNodeSchema>;

export const workflowRuntimeEdgeStatusSchema = z.enum([
  "pending",
  "selected",
  "skipped",
  "looped",
]);
export type WorkflowRuntimeEdgeStatus = z.infer<
  typeof workflowRuntimeEdgeStatusSchema
>;

export const workflowRuntimeEdgeSchema = z.object({
  edgeId: z.string(),
  from: z.string(),
  to: z.string(),
  status: workflowRuntimeEdgeStatusSchema,
  conditionResult: z.boolean().nullable(),
});
export type WorkflowRuntimeEdge = z.infer<typeof workflowRuntimeEdgeSchema>;

export const workflowRuntimeStateSchema = z.object({
  nodes: z.array(workflowRuntimeNodeSchema),
  edges: z.array(workflowRuntimeEdgeSchema),
  context: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
export type WorkflowRuntimeState = z.infer<typeof workflowRuntimeStateSchema>;

export const workflowApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "transferred",
  "expired",
]);
export type WorkflowApprovalStatus = z.infer<
  typeof workflowApprovalStatusSchema
>;

export const workflowApprovalSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  nodeId: z.string(),
  round: z.number().int().positive(),
  approverId: z.string(),
  approverRoleId: z.string().uuid().nullable(),
  kind: z.enum(["primary", "cosign", "escalation"]).default("primary"),
  status: workflowApprovalStatusSchema,
  delegatedFrom: z.string().nullable().default(null),
  transferredTo: z.string().nullable().default(null),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  remindAt: z.string().datetime({ offset: true }).nullable().default(null),
  remindedAt: z.string().datetime({ offset: true }).nullable().default(null),
  escalateAt: z.string().datetime({ offset: true }).nullable().default(null),
  escalatedAt: z.string().datetime({ offset: true }).nullable().default(null),
  escalationRoleId: z.string().uuid().nullable().default(null),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  expiredAt: z.string().datetime({ offset: true }).nullable().default(null),
  note: z.string(),
  actedBy: z.string().nullable(),
  actedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkflowApproval = z.infer<typeof workflowApprovalSchema>;

export const workflowAuditKindSchema = z.enum([
  "instance.started",
  "instance.paused",
  "instance.resumed",
  "instance.completed",
  "instance.blocked",
  "instance.failed",
  "instance.cancelled",
  "instance.reconciled",
  "node.ready",
  "node.started",
  "node.completed",
  "node.rejected",
  "node.skipped",
  "node.blocked",
  "node.failed",
  "node.timed_out",
  "node.retried",
  "node.retry_scheduled",
  "node.recovered",
  "branch.selected",
  "branch.skipped",
  "approval.requested",
  "approval.decided",
  "approval.transferred",
  "approval.cosigned",
  "approval.reminded",
  "approval.escalated",
  "approval.expired",
  "run.interrupted",
  "subworkflow.started",
  "subworkflow.completed",
  "subworkflow.failed",
]);
export type WorkflowAuditKind = z.infer<typeof workflowAuditKindSchema>;

export const workflowAuditEventSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  nodeId: z.string().nullable(),
  seq: z.number().int().positive(),
  kind: workflowAuditKindSchema,
  actorId: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkflowAuditEvent = z.infer<typeof workflowAuditEventSchema>;

export const workflowInstanceSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  status: workflowInstanceStatusSchema,
  definitionKey: z.string(),
  definitionVersion: z.number().int().positive(),
  parentInstanceId: z.string().uuid().nullable(),
  parentNodeId: z.string().nullable(),
  failureReason: z.string().nullable(),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  lastReconciledAt: z.string().datetime({ offset: true }).nullable(),
  revision: z.number().int().positive(),
  runtime: workflowRuntimeStateSchema,
  graph: workflowGraphSchema.nullable(),
  currentStep: z.number().int().nonnegative(),
  steps: z.array(workflowStepStateSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;

export const workflowInstanceDetailSchema = z.object({
  instance: workflowInstanceSchema,
  approvals: z.array(workflowApprovalSchema),
  audit: z.array(workflowAuditEventSchema),
  children: z.array(workflowInstanceSchema),
});
export type WorkflowInstanceDetail = z.infer<
  typeof workflowInstanceDetailSchema
>;

export const startWorkflowInputSchema = z.object({
  title: z.string().trim().min(1).max(180),
  context: z
    .record(
      z.string().trim().min(1).max(160),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});
export type StartWorkflowInput = z.infer<typeof startWorkflowInputSchema>;

export const completeWorkflowNodeInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  output: z.string().trim().max(20_000).default(""),
});
export type CompleteWorkflowNodeInput = z.infer<
  typeof completeWorkflowNodeInputSchema
>;

export const decideWorkflowApprovalInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(4_000).default(""),
});
export type DecideWorkflowApprovalInput = z.infer<
  typeof decideWorkflowApprovalInputSchema
>;

export const transferWorkflowApprovalInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  targetActorId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.:-]{1,180}$/),
  note: z.string().trim().max(4_000).default(""),
});
export type TransferWorkflowApprovalInput = z.infer<
  typeof transferWorkflowApprovalInputSchema
>;

export const cosignWorkflowApprovalInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  approvers: z.array(workflowExecutorSchema).min(1).max(10),
  note: z.string().trim().max(4_000).default(""),
});
export type CosignWorkflowApprovalInput = z.infer<
  typeof cosignWorkflowApprovalInputSchema
>;

export const workflowAuditQuerySchema = z.object({
  projectId: z.string().uuid(),
  instanceId: z.string().uuid().optional(),
  nodeId: z.string().trim().min(1).max(160).optional(),
  kind: workflowAuditKindSchema.optional(),
  actorId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.:-]{1,180}$/)
    .optional(),
  query: z.string().trim().max(200).optional(),
  failuresOnly: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type WorkflowAuditQuery = z.infer<typeof workflowAuditQuerySchema>;

export const workflowAuditPageSchema = z.object({
  items: z.array(workflowAuditEventSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type WorkflowAuditPage = z.infer<typeof workflowAuditPageSchema>;

export const workflowSweepResultSchema = z.object({
  claimed: z.number().int().nonnegative(),
  reconciled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type WorkflowSweepResult = z.infer<typeof workflowSweepResultSchema>;

export const workflowReasonInputSchema = z.object({
  reason: z.string().trim().max(4_000).default(""),
});
export type WorkflowReasonInput = z.infer<typeof workflowReasonInputSchema>;

export const retryWorkflowNodeInputSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  reason: z.string().trim().max(4_000).default(""),
});
export type RetryWorkflowNodeInput = z.infer<
  typeof retryWorkflowNodeInputSchema
>;

export const meetingStatusSchema = z.enum(["open", "closed"]);
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

export const meetingSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  agenda: z.string(),
  status: meetingStatusSchema,
  participants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["human", "agent"]),
    }),
  ),
  summary: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Meeting = z.infer<typeof meetingSchema>;

export const meetingMessageSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  authorType: z.enum(["human", "agent"]),
  authorId: z.string(),
  authorName: z.string(),
  content: z.string(),
  turnId: z.string().uuid().nullable().default(null),
  policyId: z.string().uuid().nullable().default(null),
  policyRevision: z.number().int().positive().nullable().default(null),
  triggerKind: z
    .enum(["mention", "round", "agenda", "summary"])
    .nullable()
    .default(null),
  triggerReason: z.string().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  traceId: z.string().nullable().default(null),
  status: z.enum(["sent", "failed"]).default("sent"),
  errorCode: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  clientMessageId: z.string().nullable().default(null),
  delegateId: z.string().uuid().nullable().default(null),
  senderPrincipalId: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
});
export type MeetingMessage = z.infer<typeof meetingMessageSchema>;

export const meetingDetailSchema = z.object({
  meeting: meetingSchema,
  messages: z.array(meetingMessageSchema),
  collaboration: meetingCollaborationOverviewSchema.optional(),
});
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

export const meetingAiTriggerKindSchema = z.enum([
  "mention",
  "round",
  "agenda",
  "summary",
]);
export type MeetingAiTriggerKind = z.infer<typeof meetingAiTriggerKindSchema>;

export const meetingAiPolicyStatusSchema = z.enum([
  "active",
  "paused",
  "terminated",
]);
export type MeetingAiPolicyStatus = z.infer<typeof meetingAiPolicyStatusSchema>;

export const meetingAiPolicyStatsSchema = z.object({
  roundsUsed: z.number().int().nonnegative(),
  messagesSent: z.number().int().nonnegative(),
  messagesFailed: z.number().int().nonnegative(),
  remainingRounds: z.number().int().nonnegative(),
  remainingMessages: z.number().int().nonnegative(),
});
export type MeetingAiPolicyStats = z.infer<typeof meetingAiPolicyStatsSchema>;

export const meetingAiPolicySchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  status: meetingAiPolicyStatusSchema,
  triggerKinds: z.array(meetingAiTriggerKindSchema),
  cooldownSeconds: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  maxMessages: z.number().int().positive(),
  runBudgetMs: z.number().int().positive(),
  revision: z.number().int().positive(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lastErrorAt: z.string().datetime({ offset: true }).nullable(),
  stats: meetingAiPolicyStatsSchema,
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MeetingAiPolicy = z.infer<typeof meetingAiPolicySchema>;

export const updateMeetingAiPolicyInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: meetingAiPolicyStatusSchema.optional(),
  triggerKinds: z
    .array(meetingAiTriggerKindSchema)
    .min(1)
    .max(4)
    .transform((kinds) => [...new Set(kinds)])
    .optional(),
  cooldownSeconds: z.number().int().min(0).max(3600).optional(),
  maxRounds: z.number().int().min(1).max(100).optional(),
  maxMessages: z.number().int().min(1).max(500).optional(),
  runBudgetMs: z.number().int().min(1_000).max(1_800_000).optional(),
});
export type UpdateMeetingAiPolicyInput = z.infer<
  typeof updateMeetingAiPolicyInputSchema
>;

export const meetingAiPolicyLifecycleInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().max(1_000).default(""),
});
export type MeetingAiPolicyLifecycleInput = z.infer<
  typeof meetingAiPolicyLifecycleInputSchema
>;

export const triggerMeetingAiInputSchema = z.object({
  kind: meetingAiTriggerKindSchema,
  agentIds: z
    .array(z.string().uuid())
    .max(20)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  sourceMessageId: z.string().uuid().optional(),
  roundNumber: z.number().int().min(1).max(100).optional(),
  agendaItem: z.string().trim().min(1).max(2_000).optional(),
  reason: z.string().trim().max(2_000).default(""),
});
export type TriggerMeetingAiInput = z.infer<typeof triggerMeetingAiInputSchema>;

export const meetingAiTurnSummarySchema = z.object({
  id: z.string().uuid(),
  roundId: z.string().uuid(),
  roundNumber: z.number().int().positive(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  triggerKind: meetingAiTriggerKindSchema,
  triggerReason: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ]),
  runId: z.string().uuid().nullable(),
  messageId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MeetingAiTurnSummary = z.infer<typeof meetingAiTurnSummarySchema>;

export const triggerMeetingAiResultSchema = z.object({
  policy: meetingAiPolicySchema,
  outcome: z.enum(["queued", "reused", "skipped"]),
  roundNumber: z.number().int().positive().nullable(),
  turns: z.array(meetingAiTurnSummarySchema),
  skipped: z.array(
    z.object({
      agentId: z.string().uuid(),
      agentName: z.string(),
      reason: z.string(),
    }),
  ),
});
export type TriggerMeetingAiResult = z.infer<
  typeof triggerMeetingAiResultSchema
>;

const meetingSourceMessageIdsSchema = z
  .array(z.string().uuid())
  .max(500)
  .default([])
  .transform((ids) => [...new Set(ids)]);

const meetingDecisionsSchema = z
  .array(z.string().trim().min(1).max(2_000))
  .max(100)
  .default([]);

export const meetingMinutesDraftSchema = z.object({
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  content: z.string(),
  decisions: meetingDecisionsSchema,
  sourceMessageIds: meetingSourceMessageIdsSchema,
  revision: z.number().int().nonnegative(),
  updatedBy: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MeetingMinutesDraft = z.infer<typeof meetingMinutesDraftSchema>;

export const meetingMinutesVersionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  version: z.number().int().positive(),
  content: z.string(),
  decisions: meetingDecisionsSchema,
  sourceMessageIds: meetingSourceMessageIdsSchema,
  publishedBy: z.string(),
  publishedAt: z.string().datetime({ offset: true }),
});
export type MeetingMinutesVersion = z.infer<typeof meetingMinutesVersionSchema>;

export const meetingMinutesSchema = z.object({
  draft: meetingMinutesDraftSchema,
  versions: z.array(meetingMinutesVersionSchema),
});
export type MeetingMinutes = z.infer<typeof meetingMinutesSchema>;

export const updateMeetingMinutesDraftInputSchema = z.object({
  content: z.string().max(40_000).default(""),
  decisions: meetingDecisionsSchema,
  sourceMessageIds: meetingSourceMessageIdsSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export type UpdateMeetingMinutesDraftInput = z.infer<
  typeof updateMeetingMinutesDraftInputSchema
>;

export const publishMeetingMinutesInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});
export type PublishMeetingMinutesInput = z.infer<
  typeof publishMeetingMinutesInputSchema
>;

export const meetingActionItemStatusSchema = z.enum([
  "open",
  "in_progress",
  "done",
  "cancelled",
]);
export type MeetingActionItemStatus = z.infer<
  typeof meetingActionItemStatusSchema
>;

export const meetingActionItemPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);
export type MeetingActionItemPriority = z.infer<
  typeof meetingActionItemPrioritySchema
>;

export const meetingActionItemSourceTypeSchema = z.enum([
  "manual",
  "message",
  "minutes_version",
]);
export type MeetingActionItemSourceType = z.infer<
  typeof meetingActionItemSourceTypeSchema
>;

export const meetingActionItemSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  ownerKind: z.enum(["human", "agent"]),
  ownerActorId: z.string(),
  ownerName: z.string(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  priority: meetingActionItemPrioritySchema,
  sourceType: meetingActionItemSourceTypeSchema,
  sourceId: z.string(),
  sourceVersionId: z.string().uuid().nullable(),
  sourceMessageIds: meetingSourceMessageIdsSchema,
  status: meetingActionItemStatusSchema,
  dedupeKey: z.string(),
  taskId: z.string().uuid().nullable(),
  taskStatus: taskStatusSchema.nullable(),
  assigneeAgentId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MeetingActionItem = z.infer<typeof meetingActionItemSchema>;

export const createMeetingActionItemInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).default(""),
  ownerActorId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.:-]{1,180}$/),
  dueAt: z.string().datetime({ offset: true }).optional(),
  priority: meetingActionItemPrioritySchema.default("medium"),
  sourceType: meetingActionItemSourceTypeSchema.default("manual"),
  sourceId: z.string().trim().min(1).max(180).optional(),
  sourceVersionId: z.string().uuid().optional(),
  sourceMessageIds: meetingSourceMessageIdsSchema,
  dedupeKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .optional(),
});
export type CreateMeetingActionItemInput = z.infer<
  typeof createMeetingActionItemInputSchema
>;

export const updateMeetingActionItemInputSchema = z.object({
  status: meetingActionItemStatusSchema,
});
export type UpdateMeetingActionItemInput = z.infer<
  typeof updateMeetingActionItemInputSchema
>;

export const convertMeetingActionItemInputSchema = z.object({
  assigneeAgentId: z.string().uuid().optional(),
  dispatch: z.boolean().default(false),
});
export type ConvertMeetingActionItemInput = z.infer<
  typeof convertMeetingActionItemInputSchema
>;

export const meetingActionItemConversionSchema = z.object({
  actionItem: meetingActionItemSchema,
  task: z.object({
    id: z.string().uuid(),
    title: z.string(),
    status: taskStatusSchema,
    agentId: z.string().uuid(),
  }),
  runId: z.string().uuid().nullable(),
  reused: z.boolean(),
});
export type MeetingActionItemConversion = z.infer<
  typeof meetingActionItemConversionSchema
>;

export const meetingTraceabilitySchema = z.object({
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  minutesVersions: z.array(
    z.object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      publishedAt: z.string().datetime({ offset: true }),
    }),
  ),
  actionItems: z.array(
    meetingActionItemSchema.extend({
      runs: z.array(
        z.object({
          id: z.string().uuid(),
          status: z.string(),
          output: z.string().nullable(),
          startedAt: z.string().datetime({ offset: true }).nullable(),
          endedAt: z.string().datetime({ offset: true }).nullable(),
        }),
      ),
      reviews: z.array(
        z.object({
          decision: z.enum(["approve", "return"]),
          note: z.string(),
          actorId: z.string(),
          createdAt: z.string().datetime({ offset: true }),
        }),
      ),
      memories: z.array(
        z.object({
          id: z.string().uuid(),
          topicId: z.string().uuid(),
          content: z.string(),
          sourceType: z.string(),
          sourceId: z.string(),
          createdAt: z.string().datetime({ offset: true }),
        }),
      ),
    }),
  ),
});
export type MeetingTraceability = z.infer<typeof meetingTraceabilitySchema>;

export const createMeetingInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  agenda: z.string().trim().max(4_000).default(""),
  agentIds: z.array(z.string().uuid()).max(20).default([]),
});
export type CreateMeetingInput = z.infer<typeof createMeetingInputSchema>;

export type AgentParticipant = Pick<Agent, "id" | "name">;
export type ProjectStatusForUi = z.infer<typeof projectStatusSchema>;
export type TaskStatusForUi = z.infer<typeof taskStatusSchema>;
