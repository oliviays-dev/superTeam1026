import { z } from "zod";

export const delegationContextTypeSchema = z.enum([
  "meeting",
  "task",
  "workflow_instance",
  "workflow_node",
]);
export type DelegationContextType = z.infer<
  typeof delegationContextTypeSchema
>;

export const delegationActionSchema = z.enum([
  "read_context",
  "read_materials",
  "comment",
  "ask_question",
  "record_risk",
  "summarize",
  "submit_draft",
  "submit_deliverable",
  "update_status",
  "reassign",
  "approve",
  "reject",
  "archive",
  "delete",
]);
export type DelegationAction = z.infer<typeof delegationActionSchema>;

export const delegationApprovalPolicySchema = z.enum([
  "suggest-only",
  "require-confirmation",
  "auto-within-rules",
]);
export type DelegationApprovalPolicy = z.infer<
  typeof delegationApprovalPolicySchema
>;

export const delegationAutoParticipationSchema = z.enum([
  "manual",
  "mentions",
  "all",
]);
export type DelegationAutoParticipation = z.infer<
  typeof delegationAutoParticipationSchema
>;

export const delegationStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "revoked",
  "expired",
]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const delegationEventKindSchema = z.enum([
  "created",
  "updated",
  "activated",
  "paused",
  "resumed",
  "extended",
  "completed",
  "revoked",
  "expired",
  "run_started",
  "run_finished",
  "confirmation_requested",
  "confirmation_decided",
  "report_ready",
  "report_failed",
  "expiry_notice",
]);
export type DelegationEventKind = z.infer<typeof delegationEventKindSchema>;

export const delegationReportStatusSchema = z.enum([
  "pending",
  "generating",
  "ready",
  "failed",
]);
export type DelegationReportStatus = z.infer<
  typeof delegationReportStatusSchema
>;

export const delegationNotificationKindSchema = z.enum([
  "expiry_soon",
  "confirmation_required",
  "report_ready",
  "anomaly",
]);
export type DelegationNotificationKind = z.infer<
  typeof delegationNotificationKindSchema
>;

export const delegationConfirmationStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type DelegationConfirmationStatus = z.infer<
  typeof delegationConfirmationStatusSchema
>;

export const delegationMaterialScopeSchema = z.string().trim().min(1).max(240);
export type DelegationMaterialScope = z.infer<
  typeof delegationMaterialScopeSchema
>;

export const delegationSchema = z.object({
  id: z.string().uuid(),
  ownerPrincipalId: z.string().trim().min(1).max(180),
  ownerDisplayName: z.string().trim().min(1).max(240),
  representativePrincipalId: z.string().trim().min(1).max(180),
  representativeDisplayName: z.string().trim().min(1).max(240),
  representativeKind: z.enum(["human", "ai"]),
  representativeAgentId: z.string().uuid().nullable(),
  workspaceId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  contextType: delegationContextTypeSchema,
  contextId: z.string().trim().min(1).max(180),
  displayName: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(4_000),
  stance: z.string().trim().max(4_000),
  watchItems: z.array(z.string().trim().min(1).max(500)).max(50),
  materialScopes: z.array(delegationMaterialScopeSchema).max(100),
  allowedActions: z.array(delegationActionSchema),
  deniedActions: z.array(delegationActionSchema),
  approvalPolicy: delegationApprovalPolicySchema,
  autoParticipation: delegationAutoParticipationSchema,
  status: delegationStatusSchema,
  expiresAt: z.string().datetime({ offset: true }),
  reportRequired: z.boolean(),
  revision: z.number().int().positive(),
  lastFailure: z.string().max(4_000).nullable(),
  createdBy: z.string().trim().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  activatedAt: z.string().datetime({ offset: true }).nullable(),
  pausedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  revokedBy: z.string().trim().min(1).max(180).nullable(),
});
export type Delegation = z.infer<typeof delegationSchema>;

const defaultAllowedActions: DelegationAction[] = [
  "read_context",
  "read_materials",
  "comment",
  "ask_question",
  "record_risk",
  "summarize",
  "submit_draft",
];

const defaultDeniedActions: DelegationAction[] = [
  "update_status",
  "reassign",
  "approve",
  "reject",
  "archive",
  "delete",
];

const uniqueActions = (actions: readonly DelegationAction[]) => [
  ...new Set(actions),
];

export const createDelegationInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(240),
    representativeKind: z.enum(["human", "ai"]),
    representativePrincipalId: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .optional(),
    representativeAgentId: z.string().uuid().optional(),
    workspaceId: z.string().trim().min(1).max(180).optional(),
    projectId: z.string().uuid().optional(),
    contextType: delegationContextTypeSchema,
    contextId: z.string().trim().min(1).max(180),
    objective: z.string().trim().min(1).max(4_000),
    stance: z.string().trim().max(4_000).default(""),
    watchItems: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    materialScopes: z.array(delegationMaterialScopeSchema).max(100).default([]),
    allowedActions: z
      .array(delegationActionSchema)
      .default(defaultAllowedActions)
      .transform(uniqueActions),
    deniedActions: z
      .array(delegationActionSchema)
      .default(defaultDeniedActions)
      .transform(uniqueActions),
    approvalPolicy: delegationApprovalPolicySchema.default("suggest-only"),
    autoParticipation: delegationAutoParticipationSchema.default("mentions"),
    expiresAt: z.string().datetime({ offset: true }),
    reportRequired: z.boolean().default(true),
    syncMeetingDelegate: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.representativeKind === "human" &&
      input.representativePrincipalId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["representativePrincipalId"],
        message: "A human representative requires a Principal",
      });
    }
    if (
      input.representativeKind === "ai" &&
      input.representativeAgentId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["representativeAgentId"],
        message: "An AI representative requires an active Agent",
      });
    }
    const allowed = new Set(input.allowedActions);
    for (const action of input.deniedActions) {
      if (allowed.has(action)) {
        // deny wins at execution time, but storing both obscures the preview.
        allowed.delete(action);
      }
    }
    if (
      (allowed.has("approve") || allowed.has("reject")) &&
      input.approvalPolicy !== "auto-within-rules"
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message:
          "approve and reject require the auto-within-rules approval policy",
      });
    }
    if (allowed.has("archive") || allowed.has("delete")) {
      context.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "Destructive actions are not available to Human Avatars",
      });
    }
  });
export type CreateDelegationInput = z.infer<typeof createDelegationInputSchema>;

export const updateDelegationInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(240).optional(),
    objective: z.string().trim().min(1).max(4_000).optional(),
    stance: z.string().trim().max(4_000).optional(),
    watchItems: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    materialScopes: z.array(delegationMaterialScopeSchema).max(100).optional(),
    allowedActions: z.array(delegationActionSchema).optional(),
    deniedActions: z.array(delegationActionSchema).optional(),
    approvalPolicy: delegationApprovalPolicySchema.optional(),
    autoParticipation: delegationAutoParticipationSchema.optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    reportRequired: z.boolean().optional(),
  })
  .strict();
export type UpdateDelegationInput = z.infer<typeof updateDelegationInputSchema>;

export const delegationRevisionCommandSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();
export type DelegationRevisionCommand = z.infer<
  typeof delegationRevisionCommandSchema
>;

export const extendDelegationInputSchema =
  delegationRevisionCommandSchema.extend({
    expiresAt: z.string().datetime({ offset: true }),
  });
export type ExtendDelegationInput = z.infer<
  typeof extendDelegationInputSchema
>;

export const delegationEventSchema = z.object({
  id: z.string().uuid(),
  delegationId: z.string().uuid(),
  kind: delegationEventKindSchema,
  actorPrincipalId: z.string().trim().min(1).max(180),
  beforeRevision: z.number().int().nonnegative(),
  afterRevision: z.number().int().positive(),
  reason: z.string().max(2_000).nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime({ offset: true }),
});
export type DelegationEvent = z.infer<typeof delegationEventSchema>;

export const delegationReportSchema = z.object({
  id: z.string().uuid(),
  delegationId: z.string().uuid(),
  status: delegationReportStatusSchema,
  summary: z.string().max(20_000),
  keyProcess: z.array(z.string().max(4_000)),
  positions: z.array(z.string().max(4_000)),
  risks: z.array(z.string().max(4_000)),
  openQuestions: z.array(z.string().max(4_000)),
  nextSteps: z.array(z.string().max(4_000)),
  informationGaps: z.array(z.string().max(4_000)),
  sourceEventCursor: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.string().max(120).nullable(),
  errorMessage: z.string().max(4_000).nullable(),
  generatedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type DelegationReport = z.infer<typeof delegationReportSchema>;

export const delegationRunSchema = z.object({
  delegationId: z.string().uuid(),
  runId: z.string().uuid(),
  sceneSessionId: z.string().uuid().nullable(),
  ticketId: z.string().uuid().nullable(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "timeout",
    "interrupted",
  ]),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DelegationRun = z.infer<typeof delegationRunSchema>;

export const delegationNotificationSchema = z.object({
  id: z.string().uuid(),
  ownerPrincipalId: z.string().trim().min(1).max(180),
  delegationId: z.string().uuid(),
  kind: delegationNotificationKindSchema,
  dedupeKey: z.string().trim().min(1).max(300),
  status: z.enum(["pending", "acknowledged"]),
  dueAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});
export type DelegationNotification = z.infer<
  typeof delegationNotificationSchema
>;

export const delegationConfirmationRequestSchema = z.object({
  id: z.string().uuid(),
  delegationId: z.string().uuid(),
  ownerPrincipalId: z.string().trim().min(1).max(180),
  representativePrincipalId: z.string().trim().min(1).max(180),
  action: delegationActionSchema,
  targetType: z.string().trim().min(1).max(120),
  targetId: z.string().trim().min(1).max(240),
  proposedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: delegationConfirmationStatusSchema,
  decidedByPrincipalId: z.string().trim().min(1).max(180).nullable(),
  decisionReason: z.string().max(2_000).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type DelegationConfirmationRequest = z.infer<
  typeof delegationConfirmationRequestSchema
>;

export const createDelegationConfirmationInputSchema = z
  .object({
    action: delegationActionSchema,
    targetType: z.string().trim().min(1).max(120),
    targetId: z.string().trim().min(1).max(240),
    proposedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CreateDelegationConfirmationInput = z.infer<
  typeof createDelegationConfirmationInputSchema
>;

export const decideDelegationConfirmationInputSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();
export type DecideDelegationConfirmationInput = z.infer<
  typeof decideDelegationConfirmationInputSchema
>;

export const delegationTicketBindingSchema = z.object({
  delegationId: z.string().uuid(),
  delegationRevision: z.number().int().positive(),
  delegationContextHash: z.string().regex(/^[a-f0-9]{64}$/),
  ownerPrincipalId: z.string().trim().min(1).max(180),
  representativePrincipalId: z.string().trim().min(1).max(180),
});
export type DelegationTicketBinding = z.infer<
  typeof delegationTicketBindingSchema
>;

export const delegationActionCheckInputSchema = z
  .object({
    action: delegationActionSchema,
    expectedRevision: z.number().int().positive().optional(),
    targetType: z.string().trim().min(1).max(120).optional(),
    targetId: z.string().trim().min(1).max(240).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type DelegationActionCheckInput = z.infer<
  typeof delegationActionCheckInputSchema
>;

export const delegationActionCheckResultSchema = z.object({
  allowed: z.boolean(),
  action: delegationActionSchema,
  effectiveRevision: z.number().int().positive(),
  approvalPolicy: delegationApprovalPolicySchema,
  requiresConfirmation: z.boolean(),
  reason: z.string().max(2_000),
  ownerPermissions: z.array(
    z.enum(["read", "write", "approve", "manage_members", "manage_roles"]),
  ),
});
export type DelegationActionCheckResult = z.infer<
  typeof delegationActionCheckResultSchema
>;

export const delegationPermissionPreviewSchema = z.object({
  delegationId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: delegationStatusSchema,
  contextType: delegationContextTypeSchema,
  contextId: z.string(),
  effectiveAllowedActions: z.array(delegationActionSchema),
  deniedActions: z.array(delegationActionSchema),
  approvalPolicy: delegationApprovalPolicySchema,
  ownerPermissions: z.array(
    z.enum(["read", "write", "approve", "manage_members", "manage_roles"]),
  ),
  canReadNow: z.boolean(),
  blockedReason: z.string().max(2_000).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type DelegationPermissionPreview = z.infer<
  typeof delegationPermissionPreviewSchema
>;

export const delegationOverviewSchema = z.object({
  items: z.array(delegationSchema),
  counts: z.object({
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    expiringSoon: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    draft: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
});
export type DelegationOverview = z.infer<typeof delegationOverviewSchema>;
