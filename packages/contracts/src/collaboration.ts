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

export const workflowStepDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["human", "agent"]),
  agentId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
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
});
export type WorkflowStepState = z.infer<typeof workflowStepStateSchema>;

export const workflowInstanceSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  status: z.enum(["active", "completed"]),
  currentStep: z.number().int().nonnegative(),
  steps: z.array(workflowStepStateSchema),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;

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
