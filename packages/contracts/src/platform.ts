import { z } from "zod";
import {
  externalRunExecutionSnapshotSchema,
  type ExternalRunExecutionSnapshot,
} from "./agent-runtime-binding.js";
import { runExecutionEnvelopeSchema } from "./runtime-execution.js";
import { spanIdSchema, traceIdSchema } from "./trace.js";

export const projectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(1).max(40),
  description: z.string().max(2_000).default(""),
  status: projectStatusSchema.default("active"),
  sourceTemplateId: z.string().uuid().nullable().default(null),
  sourceTemplateRevision: z.number().int().positive().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/)
    .optional(),
  description: z.string().trim().max(2_000).default(""),
  templateId: z.string().uuid().optional(),
  materializationKey: z
    .string()
    .trim()
    .min(8)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/)
    .optional(),
  description: z.string().trim().max(2_000).optional(),
  status: projectStatusSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "in_progress",
  "review",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50),
  status: taskStatusSchema,
  agentId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
  dependsOn: z.array(z.string().uuid()),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Task = z.infer<typeof taskSchema>;

const taskDependencyIdsSchema = z
  .array(z.string().uuid())
  .max(50)
  .default([])
  .transform((ids) => [...new Set(ids)]);

export const createTaskInputSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(20_000),
    acceptance: z
      .array(z.string().trim().min(1).max(1_000))
      .max(50)
      .default([]),
    agentId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
    dependsOn: taskDependencyIdsSchema,
  })
  .superRefine((input, context) => {
    if (input.agentId !== undefined && input.roleId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["roleId"],
        message: "agentId and roleId are mutually exclusive",
      });
    }
  });
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().min(1).max(20_000).optional(),
  acceptance: z.array(z.string().trim().min(1).max(1_000)).max(50).optional(),
  dependsOn: taskDependencyIdsSchema.optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const transferTaskInputSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
  })
  .superRefine((input, context) => {
    if ((input.agentId === undefined) === (input.roleId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of agentId or roleId is required",
      });
    }
  });
export type TransferTaskInput = z.infer<typeof transferTaskInputSchema>;

export const taskMessageSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  authorType: z.enum(["human", "agent", "system"]),
  authorId: z.string(),
  authorName: z.string(),
  content: z.string().min(1).max(20_000),
  replyToId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const createTaskMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  replyToId: z.string().uuid().optional(),
});
export type CreateTaskMessageInput = z.infer<
  typeof createTaskMessageInputSchema
>;

export const taskDetailSchema = z.object({
  task: taskSchema,
  messages: z.array(taskMessageSchema),
  dependencies: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      status: taskStatusSchema,
    }),
  ),
  activity: z.array(
    z.object({
      id: z.string().uuid(),
      taskId: z.string().uuid(),
      kind: z.enum([
        "created",
        "updated",
        "status",
        "message",
        "review",
        "dependency",
        "attachment",
        "dispatch",
        "transfer",
      ]),
      actorId: z.string(),
      actorName: z.string(),
      summary: z.string(),
      data: z.record(z.string(), z.unknown()).nullable(),
      createdAt: z.string().datetime({ offset: true }),
    }),
  ),
  attachments: z.array(
    z.object({
      id: z.string().uuid(),
      taskId: z.string().uuid(),
      projectId: z.string().uuid(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string().length(64),
      storageKey: z.string(),
      uploadedBy: z.string(),
      archivedAt: z.string().datetime({ offset: true }).nullable(),
      createdAt: z.string().datetime({ offset: true }),
    }),
  ),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const uploadTaskAttachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(300),
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default("application/octet-stream"),
  contentBase64: z.string().min(1).max(32_000_000),
});
export type UploadTaskAttachmentInput = z.infer<
  typeof uploadTaskAttachmentInputSchema
>;

export const archiveTaskAttachmentInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveTaskAttachmentInput = z.infer<
  typeof archiveTaskAttachmentInputSchema
>;

export const runtimeKindSchema = z.enum([
  "fake",
  "dsh-sdk",
  "codex-jsonl",
  "plain-text",
]);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000),
  soul: z.string().max(60_000).default(""),
  scenarios: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  goals: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  tools: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
  runtimeKind: runtimeKindSchema,
  status: z.enum(["active", "disabled"]),
  source: z.enum(["platform", "personal"]).default("personal"),
  ownerId: z.string(),
  principalId: z.string().trim().min(1).max(180).nullable().optional(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Agent = z.infer<typeof agentSchema>;

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  soul: z.string().max(60_000).default(""),
  scenarios: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  goals: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  tools: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
  runtimeKind: runtimeKindSchema.default("fake"),
  source: z.enum(["platform", "personal"]).default("personal"),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = createAgentInputSchema.partial().extend({
  status: z.enum(["active", "disabled"]).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

export const agentStatusInputSchema = z.object({
  status: z.enum(["active", "disabled"]),
});
export type AgentStatusInput = z.infer<typeof agentStatusInputSchema>;

export const agentEventSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  seq: z.number().int().positive(),
  kind: z.enum(["created", "updated", "status"]),
  message: z.string().min(1).max(4_000),
  actorId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentDetailSchema = z.object({
  agent: agentSchema,
  events: z.array(agentEventSchema),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const terminalRunStatuses = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
] as const satisfies readonly RunStatus[];

export const runObservabilitySchema = z.object({
  planVisibility: z.enum(["structured", "summary", "opaque"]),
  toolEventCompleteness: z.enum(["complete", "partial", "none"]),
  textStreaming: z.enum(["delta", "message", "final-only"]),
  subagentVisibility: z.enum(["structured", "summary", "none"]),
});
export type RunObservability = z.infer<typeof runObservabilitySchema>;

export const runInputSnapshotSchema = z.object({
  taskTitle: z.string(),
  taskDescription: z.string(),
  acceptance: z.array(z.string()),
  instruction: z.string(),
  agentName: z.string(),
  runtimeKind: runtimeKindSchema,
  meeting: z
    .object({
      meetingId: z.string().uuid(),
      turnId: z.string().uuid(),
      triggerKind: z.enum(["mention", "round", "agenda", "summary"]),
      triggerReason: z.string(),
      agendaItem: z.string().nullable().optional(),
    })
    .optional(),
  directChat: z
    .object({
      threadId: z.string().uuid(),
      turnId: z.string().uuid(),
      ownerId: z.string(),
      agentId: z.string().uuid(),
    })
    .optional(),
  runtimeOptions: z
    .object({
      fault: z.enum(["fail", "timeout"]).optional(),
      delayMs: z.number().int().min(0).max(60_000).optional(),
    })
    .optional(),
});
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

export const runSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  meetingTurnId: z.string().uuid().nullable(),
  directChatTurnId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  status: runStatusSchema,
  contextPackId: z.string().uuid().nullable(),
  inputSnapshot: runInputSnapshotSchema,
  executionSnapshot: externalRunExecutionSnapshotSchema.nullable(),
  executionEnvelope: runExecutionEnvelopeSchema.nullable().default(null),
  externalRuntimeId: z.string().uuid().nullable(),
  externalRuntimeRevision: z.number().int().positive().nullable(),
  externalRuntimeProvider: z.string().trim().min(1).max(120).nullable(),
  externalRuntimeProtocol: z.string().trim().min(1).max(120).nullable(),
  externalSessionId: z.string().trim().min(1).max(500).nullable(),
  externalRuntimeVersion: z.string().trim().min(1).max(240).nullable(),
  externalStartedAt: z.string().datetime({ offset: true }).nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number().int().positive(),
  timeoutAt: z.string().datetime({ offset: true }).nullable(),
  workflowInstanceId: z.string().uuid().nullable(),
  workflowNodeId: z.string().nullable(),
  traceId: traceIdSchema.nullable(),
  traceRootSpanId: spanIdSchema.nullable(),
  observability: runObservabilitySchema,
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Run = z.infer<typeof runSchema>;
export type { ExternalRunExecutionSnapshot };

export const platformRunEventTypeSchema = z.enum([
  "run.queued",
  "run.started",
  "input.snapshot",
  "context.ready",
  "plan.snapshot",
  "step.started",
  "step.completed",
  "step.failed",
  "tool.call",
  "tool.result",
  "subagent.started",
  "subagent.completed",
  "approval.requested",
  "approval.decided",
  "ticket.issued",
  "gate.requested",
  "gate.decided",
  "gate.expired",
  "artifact.created",
  "progress.summary",
  "warning",
  "error",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.recovered",
  "run.interrupted",
  "runtime.effect_replayed",
  "runtime.effect_cancelled",
  "job.retry_scheduled",
  "job.dead_lettered",
  "job.manually_recovered",
]);
export type PlatformRunEventType = z.infer<typeof platformRunEventTypeSchema>;

export const platformRunEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  type: platformRunEventTypeSchema,
  visibility: z.enum(["public", "restricted", "admin-only"]),
  summary: z.string().min(1).max(20_000),
  data: z.record(z.string(), z.unknown()).nullable(),
  traceId: traceIdSchema.nullable(),
  spanId: spanIdSchema.nullable(),
  parentSpanId: spanIdSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PlatformRunEvent = z.infer<typeof platformRunEventSchema>;

export const runDeltaSchema = z.object({
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  text: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type RunDelta = z.infer<typeof runDeltaSchema>;

export const contextSourceSchema = z.object({
  type: z.enum([
    "project",
    "task",
    "acceptance",
    "attachment",
    "memory",
    "conversation",
  ]),
  id: z.string(),
  label: z.string(),
});
export type ContextSource = z.infer<typeof contextSourceSchema>;

export const contextPackSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  meetingTurnId: z.string().uuid().nullable(),
  directChatTurnId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  identity: z.object({
    name: z.string(),
    runtimeKind: runtimeKindSchema,
  }),
  sources: z.array(contextSourceSchema),
  renderedPrompt: z.string(),
  contentHash: z.string().length(64),
  createdAt: z.string().datetime({ offset: true }),
});
export type ContextPack = z.infer<typeof contextPackSchema>;

export const contextReceiptSchema = z.object({
  contextPackId: z.string().uuid(),
  runId: z.string().uuid(),
  usedSources: z.array(contextSourceSchema),
  excludedSources: z.array(contextSourceSchema),
  reason: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;

export const runDetailSchema = z.object({
  run: runSchema,
  events: z.array(platformRunEventSchema),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
