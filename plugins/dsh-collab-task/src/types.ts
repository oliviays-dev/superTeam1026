import { z } from "zod";
import { taskExecutionPolicySchema } from "@pluginmax/contracts";

export const taskIdSchema = z.string().min(1).max(160);
export const taskStatusSchema = z.enum([
  "todo",
  "progress",
  "review",
  "done",
  "cancelled",
]);
export const taskPrioritySchema = z.enum(["P1", "P2", "P3"]);
export const taskReceiverTypeSchema = z.enum([
  "unassigned",
  "human",
  "agent",
  "role",
]);
export const taskActorKindSchema = z.enum(["human", "agent", "system"]);
/**
 * 消息投递意图由客户端显式声明：
 * - receiver：只派发任务责任人，mentions 仅作为记录；
 * - collaborators：只派发被 @ 的协作方，不触发责任人；
 * - broadcast：责任人与被 @ 的协作方都派发。
 */
export const taskDeliveryTargetSchema = z.enum([
  "receiver",
  "collaborators",
  "broadcast",
]);
export type TaskDeliveryTarget = z.infer<typeof taskDeliveryTargetSchema>;

/**
 * @ 提及的结构化记录：光有正文里的 `@名字` 文本没法可靠定位到人/实例
 * （同名实例很常见），所以把被 @ 的目标连同类型一起存下来，
 * 用于把上下文和文档分发给被 @ 的 Agent。
 */
export const taskMentionSchema = z.object({
  kind: z.enum(["human", "agent", "role"]),
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
});
export type TaskMention = z.infer<typeof taskMentionSchema>;

export const taskLinkSchema = z.object({
  type: z.enum(["meeting", "workflow"]),
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
});

export const taskWorkflowRefSchema = z.object({
  instanceId: z.string().min(1).max(180),
  nodeId: z.string().min(1).max(160),
  instanceTitle: z.string().min(1).max(180),
  nodeName: z.string().min(1).max(180),
  approvalPolicy: z.enum(["all", "any"]).optional(),
  approverIds: z.array(z.string().min(1).max(160)).max(50).optional(),
  nodeAttempt: z.number().int().positive().optional(),
  reviewRequired: z.boolean().optional(),
  outcome: z
    .enum(["approved", "rejected", "cancelled", "superseded"])
    .optional(),
});

export const taskStepSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(500),
  done: z.boolean(),
});

export const taskEventSchema = z.object({
  id: z.string().min(1).max(160),
  at: z.string().min(1),
  actorId: z.string().min(1).max(160),
  actorPrincipalId: z.string().min(1).max(180).optional(),
  actorName: z.string().min(1).max(200),
  kind: z.enum([
    "created",
    "updated",
    "assigned",
    "claimed",
    "status",
    "step",
    "message",
    "comment",
    "reply",
    "nudge",
    "closed",
    "workflow",
    "archived",
    "restored",
  ]),
  message: z.string().min(1).max(2000),
});

export const taskAttachmentSchema = z.object({
  name: z.string().min(1).max(300),
  size: z.number().int().nonnegative().optional(),
  mimeType: z.string().min(1).max(200).optional(),
  /** Workspace-relative path once the uploaded bytes are stored on disk. */
  storedPath: z.string().min(1).max(500).optional(),
});

export const taskExecutionMetadataSchema = z.object({
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(160),
  reasoningEffort: z.string().trim().min(1).max(40).optional(),
  runtime: z.string().trim().min(1).max(200),
  runtimeVersion: z.string().trim().min(1).max(120),
  authMode: z.string().trim().min(1).max(120),
  sandbox: z.string().trim().min(1).max(240),
  searchEnabled: z.boolean().nullable().optional(),
  networkAccess: z.enum(["none", "restricted", "public", "unknown"]).optional(),
  searchUsed: z.boolean().nullable().optional(),
  planVisibility: z.enum(["structured", "summary", "opaque"]).optional(),
});

export const taskMessageSchema = z.object({
  id: z.string().min(1).max(160),
  at: z.string().min(1),
  authorId: z.string().min(1).max(160),
  authorName: z.string().min(1).max(200),
  kind: taskActorKindSchema,
  content: z.string().min(1).max(20000),
  attachments: z.array(taskAttachmentSchema).default([]),
  mentions: z.array(taskMentionSchema).default([]),
  deliveryTarget: taskDeliveryTargetSchema.optional(),
  runId: z.string().min(1).max(180).optional(),
  runRole: z.enum(["owner", "assist", "fyi"]).optional(),
  execution: taskExecutionMetadataSchema.optional(),
  state: z
    .enum([
      "queued",
      "running",
      /** Agent 判断信息不足，等待人工补充后继续（反馈项）。 */
      "waiting_input",
      "succeeded",
      "failed",
      "timeout",
      "cancelled",
      "interrupted",
    ])
    .optional(),
});

export const taskReplySchema = z.object({
  id: z.string().min(1).max(160),
  at: z.string().min(1),
  authorId: z.string().min(1).max(160),
  authorName: z.string().min(1).max(200),
  kind: taskActorKindSchema,
  content: z.string().min(1).max(8000),
});

/** 进入 Review 前的执行负责人快照，用于退回时恢复原提交人。 */
export const taskReviewSubmitterSchema = z.object({
  receiverType: taskReceiverTypeSchema,
  receiverId: z.string().min(1).max(160).optional(),
  receiverPrincipalId: z.string().min(1).max(180).optional(),
  receiverName: z.string().min(1).max(200).optional(),
  submittedAt: z.string().min(1).max(40),
});

export const taskCommentSchema = z.object({
  id: z.string().min(1).max(160),
  at: z.string().min(1),
  authorId: z.string().min(1).max(160),
  authorName: z.string().min(1).max(200),
  kind: taskActorKindSchema,
  content: z.string().min(1).max(8000),
  /** 人类显式确认的关键共识；默认评论仅为讨论。 */
  isKeyConsensus: z.boolean().default(false),
  replies: z.array(taskReplySchema).default([]),
});

export const taskRecordSchema = z.object({
  id: taskIdSchema,
  workspaceId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  type: z.string().min(1).max(80).default("任务"),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  receiverType: taskReceiverTypeSchema,
  receiverId: z.string().min(1).max(160).optional(),
  receiverPrincipalId: z.string().min(1).max(180).optional(),
  receiverName: z.string().min(1).max(200).optional(),
  /** 项目角色下线后，任务需要人工改派。 */
  receiverState: z.enum(["active", "needs_reassignment"]).default("active"),
  /** 需要改派的原因（角色下线）。 */
  reassignmentReason: z.string().max(500).optional(),
  /** 下线角色的历史负责人快照，供列表与详情展示。 */
  previousReceiver: z
    .object({
      type: z.literal("role"),
      id: z.string().min(1).max(160),
      name: z.string().min(1).max(200),
    })
    .optional(),
  createdBy: z.string().min(1).max(160),
  createdByName: z.string().min(1).max(200),
  description: z.string().min(1).max(20000),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(30),
  executionPolicy: taskExecutionPolicySchema.optional(),
  due: z.string().max(40).optional(),
  links: z.array(taskLinkSchema).default([]),
  workflow: taskWorkflowRefSchema.optional(),
  progress: z.number().int().min(0).max(100),
  /** 执行会话代数：重置会话后 +1，下一次执行换一条全新会话。 */
  sessionEpoch: z.number().int().nonnegative().default(0),
  /** Agent 完成指定产出物后，是否自动把任务推进到「待验收」。 */
  autoSubmitReview: z.boolean().default(true),
  /** 执行任务提交后，是否自动通过 Review 并完成节点。 */
  autoApproveReview: z.boolean().default(false),
  steps: z.array(taskStepSchema).min(1).max(30),
  agentRunIds: z.array(z.string().min(1).max(180)).default([]),
  messages: z.array(taskMessageSchema).default([]),
  comments: z.array(taskCommentSchema).default([]),
  events: z.array(taskEventSchema).default([]),
  // ---- 队列（工作计划）----
  /** 人工排序序号（越小越先）；缺省表示尚未人工排序，按 draft 顺序。 */
  queueSeq: z.number().int().nonnegative().optional(),
  /** 队列级状态：blocked=依赖未满足，paused=人工暂停出队。 */
  queueState: z.enum(["idle", "blocked", "paused"]).default("idle"),
  /** 前置任务：全部完成前不出队。 */
  dependsOn: z.array(z.string().min(1).max(160)).max(50).default([]),
  /** 是否参与自动执行时段；false=只在人工触发时执行。 */
  autoRunEligible: z.boolean().default(true),
  /** 反馈项：Agent 判断信息不足，等待人工补充后才能继续。 */
  needsInput: z.boolean().default(false),
  /** 最近一次进入 Review 时的执行负责人；退回后恢复并清除。 */
  reviewSubmitter: taskReviewSubmitterSchema.optional(),
  archivedAt: z.string().min(1).max(40).optional(),
  // Reserved hook for the recycle bin: a soft-deleted task keeps `deletedAt`
  // set until it is restored or purged. Nothing writes it yet.
  deletedAt: z.string().min(1).max(40).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type TaskExecutionMetadata = z.infer<typeof taskExecutionMetadataSchema>;
export type TaskComment = z.infer<typeof taskCommentSchema>;
export type TaskStep = z.infer<typeof taskStepSchema>;
export type TaskLink = z.infer<typeof taskLinkSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskReceiverType = z.infer<typeof taskReceiverTypeSchema>;
