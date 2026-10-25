import { z } from "zod";

export const sceneTypeSchema = z.enum([
  "project",
  "task",
  "meeting",
  "chat",
  "workflow-node",
]);
export const chatCarrierSchema = z.enum(["native-session", "meeting-ai"]);
export const memoryKindSchema = z.enum([
  "fact",
  "decision",
  "constraint",
  "risk",
  "action",
  "term",
  "deliverable",
  "question",
]);
export const claimStatusSchema = z.enum([
  "proposed",
  "active",
  "hold",
  "withdrawn",
  "reopened",
]);
export const publicationStateSchema = z.enum([
  "structured",
  "human_confirmed",
  "system_effective",
  "candidate_high",
  "review_required",
]);
export const reviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);

export const sourceRefSchema = z.object({
  type: z.enum([
    "task",
    "meeting",
    "minute-version",
    "workflow",
    "document",
    "chat",
    "human-edit",
  ]),
  id: z.string().trim().min(1).max(240),
  version: z.string().trim().max(120).optional(),
  quote: z.string().max(4_000).optional(),
  href: z.string().trim().max(1_000).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const topicSchema = z.object({
  id: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  objectRefs: z.array(sourceRefSchema).max(200).default([]),
  canonicalTopicId: z.string().trim().min(1).max(180).optional(),
  status: z.enum(["active", "merged", "archived"]).default("active"),
  createdBy: z.enum(["system", "human"]).default("system"),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});
export type ProjectTopic = z.infer<typeof topicSchema>;

export const conditionSchema = z.object({
  statement: z.string().trim().min(1).max(1_000),
  status: z.enum(["unknown", "met", "unmet"]).default("unknown"),
  evidenceRefs: z.array(sourceRefSchema).max(100).default([]),
});
export type ClaimCondition = z.infer<typeof conditionSchema>;

export const claimSchema = z.object({
  id: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(180),
  kind: memoryKindSchema,
  judgmentKey: z.string().trim().min(1).max(200).optional(),
  statement: z.string().trim().min(1).max(20_000),
  status: claimStatusSchema,
  publication: publicationStateSchema,
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(sourceRefSchema).min(1).max(200),
  recordedAt: z.string().datetime({ precision: 3 }),
  effectiveAt: z.string().datetime({ precision: 3 }),
  sequence: z.number().int().positive(),
  validUntil: z.string().datetime({ precision: 3 }).optional(),
  reason: z.string().trim().max(4_000).optional(),
  resumeCriteria: z.string().trim().max(4_000).optional(),
  reviewOwnerPrincipalId: z.string().trim().min(1).max(180).optional(),
  action: z
    .object({
      ownerPrincipalId: z.string().trim().min(1).max(180).optional(),
      dueAt: z.string().trim().max(80).optional(),
      linkedTaskId: z.string().trim().min(1).max(180).optional(),
      linkedWorkflowNodeId: z.string().trim().min(1).max(180).optional(),
    })
    .optional(),
  conditions: z.array(conditionSchema).max(100).default([]),
  supersedes: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  producerType: z.enum(["agent", "human", "system"]),
  createdByPrincipalId: z.string().trim().min(1).max(180).optional(),
  identitySnapshotId: z.string().trim().min(1).max(180).optional(),
  templateVersion: z.string().trim().max(80).optional(),
  extractorVersion: z.string().trim().max(80).optional(),
});
export type ProjectClaim = z.infer<typeof claimSchema>;

export const currentTruthSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(180),
  status: z.enum([
    "active",
    "hold",
    "withdrawn",
    "reopened",
    "expired",
    "conflict",
    "no_truth",
  ]),
  primaryClaimId: z.string().trim().min(1).max(180).optional(),
  claims: z
    .array(
      z.object({
        claimId: z.string().trim().min(1).max(180),
        kind: memoryKindSchema,
        statement: z.string().trim().min(1).max(20_000),
        status: claimStatusSchema,
        effectiveAt: z.string().datetime({ precision: 3 }),
        conditions: z.array(conditionSchema).max(100).default([]),
        actionStatus: z
          .enum(["open", "in_progress", "done", "cancelled"])
          .optional(),
        sourceRefs: z.array(sourceRefSchema).max(200).default([]),
      }),
    )
    .default([]),
  previousClaimIds: z.array(z.string().min(1).max(180)).default([]),
  statement: z.string().max(20_000).optional(),
  effectiveAt: z.string().datetime({ precision: 3 }).optional(),
  reason: z.string().max(4_000).optional(),
  resumeCriteria: z.string().max(4_000).optional(),
  reviewOwnerPrincipalId: z.string().trim().min(1).max(180).optional(),
  conditions: z.array(conditionSchema).max(100).default([]),
  unresolvedQuestion: z.string().max(4_000).optional(),
  conflicts: z
    .array(
      z.object({
        claimIds: z.array(z.string().min(1).max(180)).min(2),
        reason: z.string().trim().min(1).max(1_000),
      }),
    )
    .default([]),
  recentChange: z
    .object({
      fromClaimId: z.string().min(1).max(180),
      toClaimId: z.string().min(1).max(180),
      reason: z.string().max(4_000),
      changedAt: z.string().datetime({ precision: 3 }),
    })
    .optional(),
  basedOnClaimIds: z.array(z.string().min(1).max(180)).default([]),
  revision: z.number().int().nonnegative(),
  asOf: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});
export type CurrentTruth = z.infer<typeof currentTruthSchema>;

export const episodeSchema = z.object({
  id: z.string().trim().min(1).max(180),
  agentPrincipalId: z.string().trim().min(1).max(180),
  ownerPrincipalId: z.string().trim().min(1).max(180).optional(),
  ownerPrincipalIds: z
    .array(z.string().trim().min(1).max(180))
    .max(20)
    .default([]),
  projectId: z.string().trim().min(1).max(200).optional(),
  scene: sceneTypeSchema,
  chatCarrier: chatCarrierSchema.optional(),
  chatChannelId: z.string().trim().min(1).max(180).optional(),
  sceneObjectId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(180).optional(),
  kind: z.enum([
    "instruction",
    "episode",
    "feedback",
    "commitment",
    "meeting-note",
    "task-note",
  ]),
  summary: z.string().trim().min(1).max(20_000),
  sourceRefs: z.array(sourceRefSchema).max(200).default([]),
  occurredAt: z.string().datetime({ precision: 3 }),
  recordedAt: z.string().datetime({ precision: 3 }),
  sequence: z.number().int().positive(),
  visibility: z.literal("agent-owner-admin").default("agent-owner-admin"),
  sensitivity: z.enum(["normal", "restricted"]).default("normal"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AgentMemoryEpisode = z.infer<typeof episodeSchema>;

export const handoffSchema = z.object({
  id: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(200),
  kind: z.enum([
    "meeting-result",
    "task-brief",
    "node-handoff",
    "explicit-context",
  ]),
  from: z.object({
    scene: sceneTypeSchema,
    objectId: z.string().trim().min(1).max(200),
  }),
  to: z
    .object({
      scene: sceneTypeSchema,
      objectId: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  title: z.string().trim().min(1).max(300),
  oneLineConclusion: z.string().trim().min(1).max(4_000),
  currentTruthIds: z.array(z.string().min(1).max(180)).default([]),
  actionIds: z.array(z.string().min(1).max(180)).default([]),
  openQuestions: z.array(z.string().max(4_000)).default([]),
  risks: z.array(z.string().max(4_000)).default([]),
  sourceRefs: z.array(sourceRefSchema).max(200).default([]),
  status: z.enum(["draft", "published", "superseded"]).default("draft"),
  generatedBy: z.enum(["system", "human"]),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});
export type HandoffCard = z.infer<typeof handoffSchema>;

export const reviewItemSchema = z.object({
  id: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(180).optional(),
  claimId: z.string().trim().min(1).max(180).optional(),
  reason: z.string().trim().min(1).max(4_000),
  status: reviewStatusSchema.default("pending"),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
  decidedAt: z.string().datetime({ precision: 3 }).optional(),
  decidedByPrincipalId: z.string().trim().min(1).max(180).optional(),
  decisionNote: z.string().trim().max(4_000).optional(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const ingestJobSchema = z.object({
  id: z.string().trim().min(1).max(240),
  sourceKey: z.string().trim().min(1).max(1_000),
  sourceType: z.enum([
    "task",
    "meeting",
    "minute-version",
    "workflow",
    "chat",
    "run",
  ]),
  sourceId: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(120),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  payload: z
    .object({
      title: z.string().trim().min(1).max(300),
      content: z.string().trim().min(1).max(200_000),
      agentPrincipalId: z.string().trim().min(1).max(180).optional(),
      actorPrincipalId: z.string().trim().min(1).max(180).optional(),
      projectId: z.string().trim().min(1).max(200).optional(),
      occurredAt: z.string().datetime({ precision: 3 }).optional(),
      sourceRefs: z.array(sourceRefSchema).max(200).default([]),
      metadata: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .default({}),
    })
    .optional(),
  status: z.enum([
    "queued",
    "processing",
    "completed",
    "failed",
    "unrecoverable",
  ]),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().max(2_000).optional(),
  createdAt: z.string().datetime({ precision: 3 }),
  updatedAt: z.string().datetime({ precision: 3 }),
});
export type IngestJob = z.infer<typeof ingestJobSchema>;

export const memoryExtractionClaimSchema = z.object({
  kind: memoryKindSchema,
  statement: z.string().trim().min(1).max(20_000),
  judgmentKey: z.string().trim().min(1).max(200).optional(),
  confidence: z.number().min(0).max(1),
  effectiveAt: z.string().datetime({ precision: 3 }).optional(),
  reason: z.string().trim().max(4_000).optional(),
  resumeCriteria: z.string().trim().max(4_000).optional(),
  conditions: z.array(conditionSchema).max(100).default([]),
  action: claimSchema.shape.action,
});
export type MemoryExtractionClaim = z.infer<
  typeof memoryExtractionClaimSchema
>;

export const memoryExtractionSchema = z.object({
  topics: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        aliases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
        claims: z.array(memoryExtractionClaimSchema).max(100).default([]),
      }),
    )
    .max(20)
    .default([]),
  episode: z
    .object({
      kind: z.enum([
        "instruction",
        "episode",
        "feedback",
        "commitment",
        "meeting-note",
        "task-note",
      ]),
      summary: z.string().trim().min(1).max(20_000),
      agentPrincipalId: z.string().trim().min(1).max(180).optional(),
      occurredAt: z.string().datetime({ precision: 3 }).optional(),
    })
    .optional(),
  reviewOwnerPrincipalId: z.string().trim().min(1).max(180).optional(),
});
export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>;

export const memoryDomainSpec = {
  name: "collab_memory",
  version: 1,
  tables: {
    topics: { valueSchema: topicSchema },
    claims: { valueSchema: claimSchema },
    truths: { valueSchema: currentTruthSchema },
    episodes: { valueSchema: episodeSchema },
    handoffs: { valueSchema: handoffSchema },
    reviews: { valueSchema: reviewItemSchema },
    ingest_jobs: { valueSchema: ingestJobSchema },
  },
} as const;
