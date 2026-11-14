import { z } from "zod";

export const executionDecisionPermissionSchema = z.enum([
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
]);
export type ExecutionDecisionPermission = z.infer<
  typeof executionDecisionPermissionSchema
>;

export const executionDecisionReasonSchema = z.object({
  code: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2_000),
  source: z.string().trim().min(1).max(160),
});
export type ExecutionDecisionReason = z.infer<
  typeof executionDecisionReasonSchema
>;

export const executionAuthorizationDecisionSchema = z.object({
  allowed: z.boolean(),
  permission: executionDecisionPermissionSchema,
  grantIds: z.array(z.string().uuid()).max(100),
  membershipId: z.string().uuid().optional(),
  reasons: z.array(executionDecisionReasonSchema).max(100),
});
export type ExecutionAuthorizationDecision = z.infer<
  typeof executionAuthorizationDecisionSchema
>;

export const dispatchEligibilityDecisionSchema = z.object({
  allowed: z.boolean(),
  runtimeRevision: z.number().int().positive().optional(),
  policyRevision: z.number().int().nonnegative().optional(),
  bindingRevision: z.number().int().positive().optional(),
  reasons: z.array(executionDecisionReasonSchema).max(100),
});
export type DispatchEligibilityDecision = z.infer<
  typeof dispatchEligibilityDecisionSchema
>;

export const actionDecisionSchema = z.object({
  allowed: z.boolean(),
  action: z.string().trim().min(1).max(160),
  resourceId: z.string().trim().min(1).max(240),
  runId: z.string().uuid(),
  ticketId: z.string().uuid().optional(),
  gateId: z.string().uuid().optional(),
  reasons: z.array(executionDecisionReasonSchema).max(100),
});
export type ActionDecision = z.infer<typeof actionDecisionSchema>;

export const executionDecisionSchema = z.object({
  projectId: z.string().uuid(),
  principalId: z.string().trim().min(1).max(180),
  authorization: executionAuthorizationDecisionSchema,
  dispatchEligibility: dispatchEligibilityDecisionSchema,
  actionDecision: actionDecisionSchema.optional(),
  decidedAt: z.string().datetime({ offset: true }),
  cacheable: z.literal(false),
});
export type ExecutionDecision = z.infer<typeof executionDecisionSchema>;
