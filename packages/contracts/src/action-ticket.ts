import { z } from "zod";
import { runExecutionEnvelopeSchema } from "./runtime-execution.js";

export const actionTicketContextTypeSchema = z.enum([
  "task",
  "workflow-task",
  "meeting",
  "direct-chat",
]);
export type ActionTicketContextType = z.infer<
  typeof actionTicketContextTypeSchema
>;

export const actionTicketActionSchema = z.enum([
  "agent.execute",
  "task.writeback",
  "workflow.writeback",
  "meeting.writeback",
  "direct-chat.writeback",
]);
export type ActionTicketAction = z.infer<typeof actionTicketActionSchema>;

export const executionGateEnforcementSchema = z.enum([
  "blocking",
  "non-blocking",
]);
export type ExecutionGateEnforcement = z.infer<
  typeof executionGateEnforcementSchema
>;

export const executionGateKindSchema = z.enum([
  "preflight",
  "tool-approval",
  "data-source",
  "external-send",
  "budget",
  "runtime-switch",
]);
export type ExecutionGateKind = z.infer<typeof executionGateKindSchema>;

export const executionGateDecisionTypeSchema = z.enum([
  "approve",
  "reject",
  "timeout",
  "cancel",
]);
export type ExecutionGateDecisionType = z.infer<
  typeof executionGateDecisionTypeSchema
>;

export const executionGateStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type ExecutionGateStatus = z.infer<typeof executionGateStatusSchema>;

const scopeValueSchema = z.string().trim().min(1).max(500);

export const actionTicketAuthorizationSnapshotSchema = z.object({
  scope: z.enum(["project", "self"]),
  principalId: z.string().trim().min(1).max(180),
  grantIds: z.array(z.string().uuid()).max(100),
  effectivePermissions: z
    .array(
      z.enum(["read", "write", "approve", "manage_members", "manage_roles"]),
    )
    .max(20),
  membershipId: z.string().uuid().nullable(),
});
export type ActionTicketAuthorizationSnapshot = z.infer<
  typeof actionTicketAuthorizationSnapshotSchema
>;

export const executionGateRequestSchema = z.object({
  gateId: z.string().uuid(),
  ticketId: z.string().uuid(),
  runId: z.string().uuid(),
  taskId: z.string().trim().min(1).max(180),
  projectId: z.string().uuid().nullable(),
  gateKey: z.string().trim().min(1).max(180),
  kind: executionGateKindSchema,
  enforcement: executionGateEnforcementSchema,
  reason: z.string().trim().min(1).max(2_000),
  requestedToolCategory: z.string().trim().min(1).max(160).nullable(),
  requestedSourceClass: z.string().trim().min(1).max(120).nullable(),
  resourceScopes: z.array(scopeValueSchema).min(1).max(100),
  policyId: z.string().uuid().nullable(),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().trim().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedByPrincipalId: z.string().trim().min(1).max(180),
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});
export type ExecutionGateRequest = z.infer<typeof executionGateRequestSchema>;

export const executionGateDecisionSchema = z.object({
  decisionId: z.string().uuid(),
  gateId: z.string().uuid(),
  decision: executionGateDecisionTypeSchema,
  decidedByPrincipalId: z.string().trim().min(1).max(180),
  basis: z.string().trim().min(1).max(4_000),
  decidedAt: z.string().datetime({ offset: true }),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().trim().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExecutionGateDecision = z.infer<
  typeof executionGateDecisionSchema
>;

export const executionGateRecordSchema = executionGateRequestSchema.extend({
  status: executionGateStatusSchema,
  decision: executionGateDecisionSchema.nullable(),
});
export type ExecutionGateRecord = z.infer<typeof executionGateRecordSchema>;

export const actionTicketSchema = z.object({
  schemaVersion: z.literal(1),
  ticketId: z.string().uuid(),
  ticketVersion: z.literal(1),
  principalId: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(180),
  contextType: actionTicketContextTypeSchema,
  contextId: z.string().trim().min(1).max(180),
  taskId: z.string().trim().min(1).max(180),
  runId: z.string().uuid(),
  allowedActions: z.array(actionTicketActionSchema).min(1).max(20),
  deniedActions: z.array(actionTicketActionSchema).max(20),
  resourceScopes: z.array(scopeValueSchema).min(1).max(100),
  policyId: z.string().uuid().nullable(),
  policyRevision: z.number().int().nonnegative(),
  envelopeId: z.string().trim().min(1).max(180),
  envelopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorizationSnapshot: actionTicketAuthorizationSnapshotSchema,
  executionEnvelope: runExecutionEnvelopeSchema,
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  issuedBy: z.string().trim().min(1).max(180),
});
export type ActionTicket = z.infer<typeof actionTicketSchema>;

export const actionTicketBundleSchema = z.object({
  ticket: actionTicketSchema,
  gates: z.array(executionGateRecordSchema),
});
export type ActionTicketBundle = z.infer<typeof actionTicketBundleSchema>;

export const actionTicketUsageSchema = z.object({
  ticketId: z.string().uuid(),
  action: actionTicketActionSchema,
  idempotencyKey: z.string().trim().min(1).max(240),
  runId: z.string().uuid(),
  status: z.enum(["started", "completed", "failed"]),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
export type ActionTicketUsage = z.infer<typeof actionTicketUsageSchema>;

export const decideExecutionGateInputSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    basis: z.string().trim().min(3).max(4_000),
  })
  .strict();
export type DecideExecutionGateInput = z.infer<
  typeof decideExecutionGateInputSchema
>;

export const cancelExecutionGateInputSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();
export type CancelExecutionGateInput = z.infer<
  typeof cancelExecutionGateInputSchema
>;
