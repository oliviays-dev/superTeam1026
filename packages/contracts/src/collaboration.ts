import { z } from "zod";
import {
  projectStatusSchema,
  taskStatusSchema,
  type Agent,
} from "./platform.js";

export const projectRoleSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const createProjectRoleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000).default(""),
});
export type CreateProjectRoleInput = z.infer<
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

export const memoryClaimSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  content: z.string(),
  status: memoryClaimStatusSchema,
  sourceType: z.string(),
  sourceId: z.string(),
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
});
export type UpdateMemoryClaimInput = z.infer<
  typeof updateMemoryClaimInputSchema
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
  timeoutSeconds: z.number().int().min(1).max(86_400).default(300),
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
  status: workflowApprovalStatusSchema,
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
  "node.ready",
  "node.started",
  "node.completed",
  "node.rejected",
  "node.skipped",
  "node.blocked",
  "node.failed",
  "node.timed_out",
  "node.retried",
  "branch.selected",
  "branch.skipped",
  "approval.requested",
  "approval.decided",
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
  createdAt: z.string().datetime({ offset: true }),
});
export type MeetingMessage = z.infer<typeof meetingMessageSchema>;

export const meetingDetailSchema = z.object({
  meeting: meetingSchema,
  messages: z.array(meetingMessageSchema),
});
export type MeetingDetail = z.infer<typeof meetingDetailSchema>;

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
