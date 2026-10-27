import { z } from "zod";

export const sceneTypeSchema = z.enum([
  "task",
  "workflow-node",
  "meeting",
  "direct-chat",
]);
export type SceneType = z.infer<typeof sceneTypeSchema>;

export const sceneSessionStatusSchema = z.enum(["active", "archived", "reset"]);
export type SceneSessionStatus = z.infer<typeof sceneSessionStatusSchema>;

export const sceneChatChannelStatusSchema = z.enum(["active", "archived"]);
export type SceneChatChannelStatus = z.infer<
  typeof sceneChatChannelStatusSchema
>;

export const sceneContextContributionKindSchema = z.enum([
  "task-comment-consensus",
  "task-dependency",
  "task-attachment",
  "workflow-node",
  "meeting-minutes",
  "meeting-private-note",
  "direct-chat-message",
  "agent-memory",
  "project-memory",
  "manual",
]);
export type SceneContextContributionKind = z.infer<
  typeof sceneContextContributionKindSchema
>;

export const sceneContextAuthoritySchema = z.enum([
  "mandatory",
  "instruction",
  "evidence",
]);
export type SceneContextAuthority = z.infer<typeof sceneContextAuthoritySchema>;

export const sceneContextVisibilitySchema = z.enum([
  "scene",
  "project",
  "private",
]);
export type SceneContextVisibility = z.infer<
  typeof sceneContextVisibilitySchema
>;

export const sceneSourceRefTypeSchema = z.enum([
  "project",
  "task",
  "task-comment",
  "task-dependency",
  "attachment",
  "document",
  "workflow",
  "workflow-node",
  "meeting",
  "meeting-message",
  "minutes-version",
  "meeting-private-briefing",
  "direct-chat",
  "direct-chat-message",
  "memory",
  "agent-episode",
  "run",
]);
export type SceneSourceRefType = z.infer<typeof sceneSourceRefTypeSchema>;

export const sceneSourceRefSchema = z.object({
  type: sceneSourceRefTypeSchema,
  id: z.string().trim().min(1).max(240),
  label: z.string().trim().max(300).optional(),
  version: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
  sceneType: sceneTypeSchema.optional(),
  sceneId: z.string().trim().min(1).max(240).optional(),
  quote: z.string().max(4_000).optional(),
  href: z.string().trim().max(1_000).optional(),
});
export type SceneSourceRef = z.infer<typeof sceneSourceRefSchema>;

export const sceneSessionBindingSchema = z.object({
  id: z.string().uuid(),
  sceneType: sceneTypeSchema,
  sceneId: z.string().trim().min(1).max(240),
  projectId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  ownerPrincipalId: z.string().trim().min(1).max(180).nullable(),
  channelId: z.string().uuid().nullable(),
  sessionHandle: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  status: sceneSessionStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SceneSessionBinding = z.infer<typeof sceneSessionBindingSchema>;

export const sceneChatChannelSchema = z.object({
  id: z.string().uuid(),
  channelKey: z.string().trim().min(1).max(800),
  sceneType: z.literal("direct-chat"),
  sceneId: z.string().trim().min(1).max(240),
  projectId: z.string().uuid().nullable(),
  ownerPrincipalId: z.string().trim().min(1).max(180),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  status: sceneChatChannelStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SceneChatChannel = z.infer<typeof sceneChatChannelSchema>;

export const sceneContextContributionSchema = z.object({
  id: z.string().uuid(),
  sceneSessionId: z.string().uuid(),
  sceneType: sceneTypeSchema,
  sceneId: z.string().trim().min(1).max(240),
  projectId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  ownerPrincipalId: z.string().trim().min(1).max(180).nullable(),
  sourceKey: z.string().trim().min(1).max(240),
  kind: sceneContextContributionKindSchema,
  version: z.string().trim().min(1).max(120),
  authority: sceneContextAuthoritySchema,
  visibility: sceneContextVisibilitySchema,
  text: z.string().trim().min(1).max(20_000),
  sourceRefs: z.array(sceneSourceRefSchema).max(200).default([]),
  sequence: z.number().int().positive(),
  createdBy: z.string().trim().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
});
export type SceneContextContribution = z.infer<
  typeof sceneContextContributionSchema
>;

export const createSceneContextContributionInputSchema = z
  .object({
    kind: sceneContextContributionKindSchema,
    authority: sceneContextAuthoritySchema.default("evidence"),
    visibility: sceneContextVisibilitySchema.default("scene"),
    sourceKey: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
    version: z.string().trim().min(1).max(120).default("1"),
    text: z.string().trim().min(1).max(20_000),
    sourceRefs: z.array(sceneSourceRefSchema).max(200).default([]),
  })
  .strict();
export type CreateSceneContextContributionInput = z.infer<
  typeof createSceneContextContributionInputSchema
>;

export const sceneContextDeliveryCursorSchema = z.object({
  sceneSessionId: z.string().uuid(),
  cursorSequence: z.number().int().nonnegative(),
  deliveredContributionIds: z.array(z.string().uuid()).max(10_000),
  lastRunId: z.string().uuid().nullable(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SceneContextDeliveryCursor = z.infer<
  typeof sceneContextDeliveryCursorSchema
>;

export const sceneContextDeliveredContributionSchema = z.object({
  id: z.string().uuid(),
  sourceKey: z.string().trim().min(1).max(240),
  kind: sceneContextContributionKindSchema,
  version: z.string().trim().min(1).max(120),
  authority: sceneContextAuthoritySchema,
  visibility: sceneContextVisibilitySchema,
  textDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRefs: z.array(sceneSourceRefSchema).max(200),
  sequence: z.number().int().positive(),
});
export type SceneContextDeliveredContribution = z.infer<
  typeof sceneContextDeliveredContributionSchema
>;

export const sceneContextExcludedSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(240).optional(),
  reason: z.enum([
    "permission",
    "wrong-project",
    "wrong-scene",
    "source-policy",
    "superseded",
    "budget",
    "missing",
  ]),
  safeLabel: z.string().trim().max(300).optional(),
});
export type SceneContextExcludedSource = z.infer<
  typeof sceneContextExcludedSourceSchema
>;

export const sceneContextReceiptSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  contextPackId: z.string().uuid(),
  sceneSessionId: z.string().uuid(),
  sceneType: sceneTypeSchema,
  sceneId: z.string().trim().min(1).max(240),
  projectId: z.string().uuid().nullable(),
  agentId: z.string().uuid(),
  principalId: z.string().trim().min(1).max(180),
  agentPrincipalId: z.string().trim().min(1).max(180).nullable(),
  logicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  rendererVersion: z.string().trim().min(1).max(80),
  runtimeStateful: z.boolean(),
  cursorBefore: z.number().int().nonnegative(),
  cursorAfter: z.number().int().nonnegative(),
  delivered: z.array(sceneContextDeliveredContributionSchema).max(500),
  reused: z.array(sceneContextDeliveredContributionSchema).max(500),
  sourceRefs: z.array(sceneSourceRefSchema).max(500),
  excluded: z.array(sceneContextExcludedSourceSchema).max(500),
  createdAt: z.string().datetime({ offset: true }),
});
export type SceneContextReceipt = z.infer<typeof sceneContextReceiptSchema>;

export const sceneContextSnapshotSchema = z.object({
  binding: sceneSessionBindingSchema,
  channel: sceneChatChannelSchema.nullable(),
  cursor: sceneContextDeliveryCursorSchema.nullable(),
  receipt: sceneContextReceiptSchema.nullable(),
  contributions: z.array(sceneContextContributionSchema),
});
export type SceneContextSnapshot = z.infer<typeof sceneContextSnapshotSchema>;

export const sceneContextReplayResultSchema = z.object({
  replayed: z.literal(true),
  deterministic: z.boolean(),
  logicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contextPackId: z.string().uuid(),
  receiptId: z.string().uuid(),
  snapshot: sceneContextSnapshotSchema,
});
export type SceneContextReplayResult = z.infer<
  typeof sceneContextReplayResultSchema
>;
