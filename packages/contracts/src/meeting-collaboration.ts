import { z } from "zod";

const principalIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/);
const dateTimeSchema = z.string().datetime({ offset: true });

export const meetingCollaborationLifecycleSchema = z.enum([
  "active",
  "archived",
]);
export type MeetingCollaborationLifecycle = z.infer<
  typeof meetingCollaborationLifecycleSchema
>;

export const meetingFacilitatorSchema = z.object({
  principalId: principalIdSchema,
  displayName: z.string().trim().min(1).max(160),
  assignedBy: principalIdSchema.nullable(),
  assignedAt: dateTimeSchema,
  revision: z.number().int().positive(),
});
export type MeetingFacilitator = z.infer<typeof meetingFacilitatorSchema>;

export const meetingFacilitatorHandoffSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  fromPrincipalId: principalIdSchema.nullable(),
  toPrincipalId: principalIdSchema,
  actorPrincipalId: principalIdSchema,
  reason: z.string(),
  resultingRevision: z.number().int().positive(),
  createdAt: dateTimeSchema,
});
export type MeetingFacilitatorHandoff = z.infer<
  typeof meetingFacilitatorHandoffSchema
>;

export const meetingCollaborationOverviewSchema = z.object({
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  lifecycleStatus: meetingCollaborationLifecycleSchema,
  revision: z.number().int().positive(),
  facilitator: meetingFacilitatorSchema,
  archivedBy: principalIdSchema.nullable(),
  archivedAt: dateTimeSchema.nullable(),
  archiveReason: z.string().nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type MeetingCollaborationOverview = z.infer<
  typeof meetingCollaborationOverviewSchema
>;

export const handoffMeetingFacilitatorInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  facilitatorPrincipalId: principalIdSchema,
  reason: z.string().trim().min(1).max(4_000),
});
export type HandoffMeetingFacilitatorInput = z.infer<
  typeof handoffMeetingFacilitatorInputSchema
>;

export const meetingDelegateActionSchema = z.enum([
  "speak",
  "read_private",
  "attach_file",
  "summarize",
]);
export type MeetingDelegateAction = z.infer<typeof meetingDelegateActionSchema>;

export const meetingDelegateStatusSchema = z.enum([
  "active",
  "revoked",
  "expired",
]);
export type MeetingDelegateStatus = z.infer<typeof meetingDelegateStatusSchema>;

export const meetingDelegateSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  delegatorPrincipalId: principalIdSchema,
  representativeKind: z.enum(["human", "agent"]),
  representativePrincipalId: principalIdSchema,
  representativeName: z.string(),
  agentId: z.string().uuid().nullable(),
  allowedActions: z.array(meetingDelegateActionSchema),
  status: meetingDelegateStatusSchema,
  reason: z.string(),
  expiresAt: dateTimeSchema.nullable(),
  createdBy: principalIdSchema,
  createdAt: dateTimeSchema,
  revokedBy: principalIdSchema.nullable(),
  revokedAt: dateTimeSchema.nullable(),
});
export type MeetingDelegate = z.infer<typeof meetingDelegateSchema>;

export const createMeetingDelegateInputSchema = z.object({
  delegatorPrincipalId: principalIdSchema.optional(),
  representativeKind: z.enum(["human", "agent"]),
  representativePrincipalId: principalIdSchema.optional(),
  agentId: z.string().uuid().optional(),
  allowedActions: z
    .array(meetingDelegateActionSchema)
    .min(1)
    .max(4)
    .default(["speak"])
    .transform((actions) => [...new Set(actions)]),
  expiresAt: dateTimeSchema.optional(),
  reason: z.string().trim().min(1).max(4_000),
});
export type CreateMeetingDelegateInput = z.infer<
  typeof createMeetingDelegateInputSchema
>;

export const revokeMeetingDelegateInputSchema = z.object({
  reason: z.string().trim().min(1).max(4_000),
});
export type RevokeMeetingDelegateInput = z.infer<
  typeof revokeMeetingDelegateInputSchema
>;

export const meetingPrivateBriefingSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  ownerPrincipalId: principalIdSchema,
  audiencePrincipalId: principalIdSchema,
  audienceAgentId: z.string().uuid().nullable().default(null),
  content: z.string(),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().positive(),
  createdBy: principalIdSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type MeetingPrivateBriefing = z.infer<
  typeof meetingPrivateBriefingSchema
>;

export const createMeetingPrivateBriefingInputSchema = z.object({
  audiencePrincipalId: principalIdSchema.optional(),
  content: z.string().trim().min(1).max(20_000),
});
export type CreateMeetingPrivateBriefingInput = z.infer<
  typeof createMeetingPrivateBriefingInputSchema
>;

export const updateMeetingPrivateBriefingInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  content: z.string().trim().min(1).max(20_000),
});
export type UpdateMeetingPrivateBriefingInput = z.infer<
  typeof updateMeetingPrivateBriefingInputSchema
>;

export const meetingReadPositionSchema = z.object({
  meetingId: z.string().uuid(),
  principalId: principalIdSchema,
  lastReadMessageId: z.string().uuid().nullable(),
  lastReadAt: dateTimeSchema,
  revision: z.number().int().positive(),
  updatedAt: dateTimeSchema,
});
export type MeetingReadPosition = z.infer<typeof meetingReadPositionSchema>;

export const setMeetingReadPositionInputSchema = z.object({
  messageId: z.string().uuid(),
});
export type SetMeetingReadPositionInput = z.infer<
  typeof setMeetingReadPositionInputSchema
>;

export const meetingDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "read",
  "failed",
]);
export type MeetingDeliveryStatus = z.infer<typeof meetingDeliveryStatusSchema>;

export const meetingMessageDeliverySchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  messageId: z.string().uuid(),
  recipientPrincipalId: principalIdSchema,
  status: meetingDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  idempotencyKey: z.string(),
  lastError: z.string().nullable(),
  deliveredAt: dateTimeSchema.nullable(),
  readAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});
export type MeetingMessageDelivery = z.infer<
  typeof meetingMessageDeliverySchema
>;

export const meetingFileSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageKey: z.string(),
  status: z.enum(["active", "archived"]),
  uploadedBy: principalIdSchema,
  archivedBy: principalIdSchema.nullable(),
  archivedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
});
export type MeetingFile = z.infer<typeof meetingFileSchema>;

export const uploadMeetingFileInputSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  contentBase64: z.string().min(1).max(24_000_000),
});
export type UploadMeetingFileInput = z.infer<
  typeof uploadMeetingFileInputSchema
>;

export const archiveMeetingInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000),
});
export type ArchiveMeetingInput = z.infer<typeof archiveMeetingInputSchema>;

export const restoreMeetingInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export type RestoreMeetingInput = z.infer<typeof restoreMeetingInputSchema>;

export const generateMeetingMinutesInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});
export type GenerateMeetingMinutesInput = z.infer<
  typeof generateMeetingMinutesInputSchema
>;

export const confirmMeetingMinutesInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  note: z.string().trim().max(4_000).default(""),
});
export type ConfirmMeetingMinutesInput = z.infer<
  typeof confirmMeetingMinutesInputSchema
>;

export const meetingMinutesConfirmationSchema = z.object({
  versionId: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  confirmedBy: principalIdSchema,
  note: z.string(),
  confirmedAt: dateTimeSchema,
});
export type MeetingMinutesConfirmation = z.infer<
  typeof meetingMinutesConfirmationSchema
>;

export const meetingTaskSourceTypeSchema = z.enum([
  "manual",
  "message",
  "minutes_version",
  "action_item",
]);
export type MeetingTaskSourceType = z.infer<typeof meetingTaskSourceTypeSchema>;

export const meetingTaskSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  title: z.string(),
  taskStatus: z.enum([
    "queued",
    "in_progress",
    "review",
    "paused",
    "blocked",
    "needs_input",
    "done",
    "cancelled",
  ]),
  assigneeAgentId: z.string().uuid(),
  sourceType: meetingTaskSourceTypeSchema,
  sourceId: z.string(),
  idempotencyKey: z.string(),
  createdBy: principalIdSchema,
  reused: z.boolean().default(false),
  createdAt: dateTimeSchema,
});
export type MeetingTask = z.infer<typeof meetingTaskSchema>;

export const createMeetingTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).default(""),
  assigneeAgentId: z.string().uuid(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  sourceType: meetingTaskSourceTypeSchema.default("manual"),
  sourceId: z.string().trim().min(1).max(180).optional(),
  sourceMessageIds: z
    .array(z.string().uuid())
    .max(100)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
  dispatch: z.boolean().default(false),
});
export type CreateMeetingTaskInput = z.infer<
  typeof createMeetingTaskInputSchema
>;

export const delegateMeetingMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  clientMessageId: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .optional(),
});
export type DelegateMeetingMessageInput = z.infer<
  typeof delegateMeetingMessageInputSchema
>;
