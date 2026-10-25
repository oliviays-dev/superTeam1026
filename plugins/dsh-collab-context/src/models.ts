import { z } from "zod";

export const sceneTypeSchema = z.enum([
  "project",
  "task",
  "meeting",
  "chat",
  "workflow-node",
]);
export type SceneType = z.infer<typeof sceneTypeSchema>;
export const chatCarrierSchema = z.enum(["native-session", "meeting-ai"]);
export type ChatCarrier = z.infer<typeof chatCarrierSchema>;

export const sourceRefSchema = z.object({
  type: z.enum([
    "task",
    "meeting",
    "minute-version",
    "workflow",
    "document",
    "chat",
    "task-comment",
    "human-edit",
  ]),
  id: z.string().trim().min(1).max(240),
  version: z.string().trim().max(120).optional(),
  quote: z.string().max(4_000).optional(),
  href: z.string().trim().max(1_000).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const agentIdentitySnapshotSchema = z.object({
  id: z.string().trim().min(1).max(180),
  agentPrincipalId: z.string().trim().min(1).max(180),
  teammateId: z.string().trim().min(1).max(180),
  templateId: z.string().trim().min(1).max(180),
  templateVersion: z.string().trim().min(1).max(80),
  personaAlias: z.string().trim().min(1).max(180).optional(),
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().max(300).default(""),
  soul: z.string().max(200_000),
  soulHash: z.string().regex(/^[a-f0-9]{64}$/),
  goals: z.array(z.string().max(4_000)).max(100).default([]),
  scenarios: z.array(z.string().max(4_000)).max(100).default([]),
  source: z.enum(["personal", "platform"]),
  ownerPrincipalId: z.string().trim().min(1).max(180).optional(),
  /** 当前通常只有一个；字段按集合建模，兼容未来多 Owner。 */
  ownerPrincipalIds: z
    .array(z.string().trim().min(1).max(180))
    .max(20)
    .default([]),
  capturedAt: z.string().datetime({ precision: 3 }),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AgentIdentitySnapshot = z.infer<typeof agentIdentitySnapshotSchema>;

export const sceneSessionBindingSchema = z.object({
  id: z.string().trim().min(1).max(240),
  scene: sceneTypeSchema,
  chatCarrier: chatCarrierSchema.optional(),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  objectId: z.string().trim().min(1).max(200),
  agentPrincipalId: z.string().trim().min(1).max(180),
  sessionId: z.string().trim().min(1).max(200),
  generation: z.number().int().nonnegative(),
  status: z.enum(["active", "archived", "reset"]),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
  lastRunId: z.string().trim().min(1).max(180).optional(),
});
export type SceneSessionBinding = z.infer<typeof sceneSessionBindingSchema>;

export const aiChatChannelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  channelKey: z.string().trim().min(1).max(800),
  workspaceId: z.string().trim().min(1).max(200),
  userPrincipalId: z.string().trim().min(1).max(180),
  agentPrincipalId: z.string().trim().min(1).max(180),
  teammateInstanceId: z.string().trim().min(1).max(180),
  carrier: chatCarrierSchema,
  activeCarrierRefId: z.string().trim().min(1).max(200),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});
export type AiChatChannel = z.infer<typeof aiChatChannelSchema>;

export const contextRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(180),
  mode: z.enum(["preview", "execute"]),
  rerunOfRunId: z.string().trim().min(1).max(180).optional(),
  scene: sceneTypeSchema,
  chatCarrier: chatCarrierSchema.optional(),
  chatChannelId: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  projectContextId: z.string().trim().min(1).max(200).optional(),
  objectId: z.string().trim().min(1).max(200),
  agentPrincipalId: z.string().trim().min(1).max(180),
  agentProfileId: z.string().trim().min(1).max(180).optional(),
  teammateId: z.string().trim().min(1).max(180).optional(),
  actorPrincipalId: z.string().trim().min(1).max(180),
  runId: z.string().trim().min(1).max(180).optional(),
  input: z.object({
    type: z.enum([
      "user-message",
      "meeting-message",
      "node-dispatch",
      "system-trigger",
    ]),
    content: z.string().max(100_000),
    messageId: z.string().trim().min(1).max(180).optional(),
    attachments: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(180),
          name: z.string().trim().min(1).max(300),
          mime: z.string().trim().max(200),
          ref: z.string().trim().min(1).max(1_000),
        }),
      )
      .max(50)
      .default([]),
  }),
  explicitRefs: z.array(sourceRefSchema).max(200).default([]),
  pinnedMemoryIds: z
    .array(z.string().trim().min(1).max(180))
    .max(100)
    .default([]),
  excludedSourceIds: z
    .array(z.string().trim().min(1).max(240))
    .max(200)
    .default([]),
  runtimeCapabilities: z.object({
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    supportsSystemSections: z.boolean(),
    isStateless: z.boolean(),
  }),
  asOf: z.string().datetime({ precision: 3 }).optional(),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;

export const contextSectionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: z.enum([
    "platform-policy",
    "agent-identity",
    "scene-policy",
    "execution-policy",
    "source-policy",
    "scene-facts",
    "scene-consensus",
    "project-memory",
    "current-truth",
    "agent-private-memory",
    "references",
    "current-input",
  ]),
  authority: z.enum(["mandatory", "instruction", "evidence"]),
  text: z.string().max(200_000),
  sourceRefs: z.array(sourceRefSchema).max(200).default([]),
  tokens: z.number().int().nonnegative(),
  compression: z.enum(["full", "extracted", "referenced"]),
});
export type ContextSection = z.infer<typeof contextSectionSchema>;

export const sceneContextContributionSchema = z.object({
  id: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(120).optional(),
  text: z.string().trim().min(1).max(20_000),
  sourceRefs: z.array(sourceRefSchema).max(200).default([]),
});
export type SceneContextContribution = z.infer<
  typeof sceneContextContributionSchema
>;

export const contextPackSchema = z.object({
  id: z.string().trim().min(1).max(180),
  requestId: z.string().trim().min(1).max(180),
  mode: z.enum(["preview", "execute"]),
  expiresAt: z.string().datetime({ precision: 3 }).optional(),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  projectContextId: z.string().trim().min(1).max(200).optional(),
  scene: sceneTypeSchema,
  chatCarrier: chatCarrierSchema.optional(),
  chatChannelId: z.string().trim().min(1).max(200).optional(),
  objectId: z.string().trim().min(1).max(200),
  actorPrincipalId: z.string().trim().min(1).max(180).optional(),
  agentProfileId: z.string().trim().min(1).max(180).optional(),
  sessionBindingId: z.string().trim().min(1).max(240),
  agent: agentIdentitySnapshotSchema,
  sections: z.array(contextSectionSchema).max(50),
  sessionSupplement: z
    .object({
      reason: z.enum(["stateless-runtime", "session-rebuilt"]),
      text: z.string().max(200_000),
      sourceRefs: z.array(sourceRefSchema).max(200).default([]),
      tokens: z.number().int().nonnegative(),
    })
    .optional(),
  rendered: z.object({
    systemText: z.string().max(300_000),
    userText: z.string().max(300_000),
    flattenedPrompt: z.string().max(500_000),
    rendererVersion: z.string().trim().min(1).max(80),
  }),
  currentTruthIds: z.array(z.string().trim().min(1).max(180)).default([]),
  truths: z
    .array(
      z.object({
        topicId: z.string().trim().min(1).max(180),
        claimId: z.string().trim().min(1).max(180).optional(),
        status: z.string().trim().min(1).max(80),
        effectiveAt: z.string().datetime({ precision: 3 }).optional(),
        conditions: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  contributions: z.array(sceneContextContributionSchema).max(100).default([]),
  handoffIds: z.array(z.string().trim().min(1).max(180)).default([]),
  excluded: z
    .array(
      z.object({
        sourceId: z.string().trim().min(1).max(240).optional(),
        reason: z.enum([
          "permission",
          "wrong-project",
          "irrelevant",
          "superseded",
          "user-excluded",
          "budget",
          "missing",
          "unverified",
        ]),
        safeLabel: z.string().max(300).optional(),
      }),
    )
    .default([]),
  conflicts: z.array(z.array(sourceRefSchema)).default([]),
  allowedWriteback: z
    .array(z.enum(["agent-private-memory", "run-evidence", "memory-candidate"]))
    .default([]),
  logicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  renderDigest: z.object({
    system: z.string().regex(/^[a-f0-9]{64}$/),
    user: z.string().regex(/^[a-f0-9]{64}$/),
    flattened: z.string().regex(/^[a-f0-9]{64}$/),
    supplement: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  assembledAt: z.string().datetime({ precision: 3 }),
  asOf: z.string().datetime({ precision: 3 }),
});
export type ContextPack = z.infer<typeof contextPackSchema>;

export const contextReceiptSchema = z.object({
  id: z.string().trim().min(1).max(180),
  runId: z.string().trim().min(1).max(180).optional(),
  contextPackId: z.string().trim().min(1).max(180),
  logicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scene: sceneTypeSchema,
  chatCarrier: chatCarrierSchema.optional(),
  chatChannelId: z.string().trim().min(1).max(200).optional(),
  objectId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  projectContextId: z.string().trim().min(1).max(200).optional(),
  agentPrincipalId: z.string().trim().min(1).max(180),
  actorPrincipalId: z.string().trim().min(1).max(180).optional(),
  agentProfileId: z.string().trim().min(1).max(180).optional(),
  identity: z.object({
    snapshotId: z.string().trim().min(1).max(180),
    templateVersion: z.string().trim().min(1).max(80),
    soulHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  session: z.object({
    sessionId: z.string().trim().min(1).max(200),
    generation: z.number().int().nonnegative(),
    supplementReason: z
      .enum(["stateless-runtime", "session-rebuilt"])
      .optional(),
  }),
  included: z
    .array(
      z.object({
        sourceType: z.string().trim().min(1).max(120),
        sourceId: z.string().trim().min(1).max(240),
        version: z.string().trim().max(120).optional(),
        title: z.string().max(300).optional(),
        sourceRefs: z.array(sourceRefSchema).max(200).default([]),
        selectionReason: z.string().trim().min(1).max(1_000),
        authority: z.enum(["mandatory", "instruction", "evidence"]),
        compression: z.enum(["full", "extracted", "referenced"]),
        tokens: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  truths: z
    .array(
      z.object({
        topicId: z.string().trim().min(1).max(180),
        claimId: z.string().trim().min(1).max(180).optional(),
        status: z.string().trim().min(1).max(80),
        effectiveAt: z.string().datetime({ precision: 3 }).optional(),
        conditions: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  contributions: z.array(sceneContextContributionSchema).max(100).default([]),
  excluded: contextPackSchema.shape.excluded,
  runtime: z
    .object({
      kind: z.enum(["builtin", "external"]),
      provider: z.string().trim().max(120).optional(),
      model: z.string().trim().max(160).optional(),
      externalSessionId: z.string().trim().min(1).max(200).optional(),
      ambientInstructionPolicy: z
        .enum(["none", "workspace", "sanitized-overlay"])
        .optional(),
    })
    .optional(),
  createdAt: z.string().datetime({ precision: 3 }),
});
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;

export const contextDomainSpec = {
  name: "collab_context",
  version: 1,
  tables: {
    sessions: { valueSchema: sceneSessionBindingSchema },
    identities: { valueSchema: agentIdentitySnapshotSchema },
    chat_channels: { valueSchema: aiChatChannelSchema },
    packs: { valueSchema: contextPackSchema },
    receipts: { valueSchema: contextReceiptSchema },
  },
} as const;
