import { z } from "zod";

export const WORKFLOW_ASSIGNMENT_BINDINGS_FLAG =
  "workflow.assignment_bindings";
export const WORKFLOW_PLATFORM_TEMPLATES_FLAG = "workflow.platform_templates";

export const workflowDefinitionScopeSchema = z.enum(["project", "platform"]);
export type WorkflowDefinitionScope = z.infer<
  typeof workflowDefinitionScopeSchema
>;

export const workflowDefinitionOriginSchema = z.enum([
  "template",
  "router",
  "manual",
]);
export type WorkflowDefinitionOrigin = z.infer<
  typeof workflowDefinitionOriginSchema
>;

export const templatePortabilitySchema = z.enum(["required", "suggested"]);
export type TemplatePortability = z.infer<typeof templatePortabilitySchema>;

export const dispatchModeSchema = z.enum(["assigned", "claim"]);
export type DispatchMode = z.infer<typeof dispatchModeSchema>;

export const roleSlotSchema = z.object({
  kind: z.literal("role"),
  roleId: z.string().uuid().optional(),
  roleCode: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().trim().max(160).optional(),
});
export type RoleSlot = z.infer<typeof roleSlotSchema>;

export const fixedSlotSchema = z.object({
  kind: z.enum(["user", "agent", "employee"]),
  id: z.string().trim().min(1).max(180),
  label: z.string().trim().max(160).optional(),
  portability: templatePortabilitySchema.default("required"),
});
export type FixedSlot = z.infer<typeof fixedSlotSchema>;

export const workflowAssignmentSourceSchema = z.object({
  kind: z.enum(["role", "user", "agent", "employee", "system"]),
  sourceId: z.string().trim().min(1).max(180),
  roleCode: z.string().trim().max(80).nullable().default(null),
  label: z.string().trim().max(160).nullable().default(null),
});
export type WorkflowAssignmentSource = z.infer<
  typeof workflowAssignmentSourceSchema
>;

export const workflowAssignmentStatusSchema = z.enum([
  "resolved",
  "unresolved",
  "overridden",
]);
export type WorkflowAssignmentStatus = z.infer<
  typeof workflowAssignmentStatusSchema
>;

export const workflowPrincipalRefSchema = z.object({
  principalId: z.string().trim().min(1).max(180),
  actorId: z.string().trim().min(1).max(180),
  displayName: z.string().trim().min(1).max(160),
  kind: z.enum(["human", "agent"]),
});
export type WorkflowPrincipalRef = z.infer<
  typeof workflowPrincipalRefSchema
>;

export const workflowBlockingRiskSchema = z.object({
  code: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2_000),
  actions: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
});
export type WorkflowBlockingRisk = z.infer<
  typeof workflowBlockingRiskSchema
>;

export const workflowInstancePreflightNodeSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  nodeName: z.string().trim().min(1).max(160),
  nodeType: z.enum(["task", "approval", "service", "decision", "subworkflow"]),
  source: workflowAssignmentSourceSchema,
  dispatchMode: dispatchModeSchema,
  status: workflowAssignmentStatusSchema,
  primaryAssignee: workflowPrincipalRefSchema.nullable(),
  candidatePool: z.array(workflowPrincipalRefSchema),
  approvers: z.array(workflowPrincipalRefSchema),
  blockingRisks: z.array(workflowBlockingRiskSchema),
});
export type WorkflowInstancePreflightNode = z.infer<
  typeof workflowInstancePreflightNodeSchema
>;

export const workflowInstancePreflightSchema = z.object({
  definitionId: z.string().uuid(),
  definitionVersion: z.number().int().positive(),
  definitionRevision: z.number().int().positive(),
  scope: workflowDefinitionScopeSchema,
  projectId: z.string().uuid(),
  bindingRevision: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(workflowInstancePreflightNodeSchema),
  blockingRisks: z.array(workflowBlockingRiskSchema),
  canStart: z.boolean(),
  decisionContext: z.object({
    computedAt: z.string().datetime({ offset: true }),
    authorizationEvidence: z.array(z.string()),
    runtimeRevisions: z.array(z.number().int().nonnegative()),
    policyRevisions: z.array(z.number().int().nonnegative()),
    featureFlags: z.record(z.string(), z.boolean()),
  }),
});
export type WorkflowInstancePreflight = z.infer<
  typeof workflowInstancePreflightSchema
>;

const principalIdsSchema = z
  .array(z.string().trim().min(1).max(180))
  .max(100)
  .default([])
  .transform((values) => [...new Set(values)]);

export const workflowBindingOverrideSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  dispatchMode: dispatchModeSchema.optional(),
  primaryPrincipalId: z.string().trim().min(1).max(180).optional(),
  candidatePrincipalIds: principalIdsSchema,
  approverPrincipalIds: principalIdsSchema,
  sourceChangeReason: z.string().trim().max(2_000).default(""),
});
export type WorkflowBindingOverride = z.infer<
  typeof workflowBindingOverrideSchema
>;

export const workflowInstancePreflightInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(180),
  context: z
    .record(
      z.string().trim().min(1).max(160),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
  expectedDefinitionVersion: z.number().int().positive().optional(),
  bindingOverrides: z.array(workflowBindingOverrideSchema).max(100).default([]),
});
export type WorkflowInstancePreflightInput = z.infer<
  typeof workflowInstancePreflightInputSchema
>;

export const workflowInstanceAssignmentSchema = z.object({
  instanceId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  nodeId: z.string(),
  source: workflowAssignmentSourceSchema,
  dispatchMode: dispatchModeSchema,
  status: workflowAssignmentStatusSchema,
  primaryPrincipalId: z.string().nullable(),
  candidatePool: z.array(workflowPrincipalRefSchema),
  resolvedBy: z.string(),
  resolvedAt: z.string().datetime({ offset: true }),
  sourceChangeReason: z.string(),
  revision: z.number().int().positive(),
});
export type WorkflowInstanceAssignment = z.infer<
  typeof workflowInstanceAssignmentSchema
>;

export const workflowInstanceApproverSchema = z.object({
  instanceId: z.string().uuid(),
  nodeId: z.string(),
  principalId: z.string(),
  source: workflowAssignmentSourceSchema,
  status: z.enum(["resolved", "unresolved", "overridden"]),
  resolvedBy: z.string(),
  resolvedAt: z.string().datetime({ offset: true }),
  revision: z.number().int().positive(),
});
export type WorkflowInstanceApprover = z.infer<
  typeof workflowInstanceApproverSchema
>;

export const workflowInstanceBindingsSchema = z.object({
  instanceId: z.string().uuid(),
  bindingRevision: z.string().regex(/^[a-f0-9]{64}$/),
  assignments: z.array(workflowInstanceAssignmentSchema),
  approvers: z.array(workflowInstanceApproverSchema),
});
export type WorkflowInstanceBindings = z.infer<
  typeof workflowInstanceBindingsSchema
>;

export const replaceWorkflowInstanceBindingsInputSchema = z.object({
  expectedBindingRevision: z.string().regex(/^[a-f0-9]{64}$/),
  bindingOverrides: z.array(workflowBindingOverrideSchema).max(100).default([]),
  sourceChangeReason: z.string().trim().min(1).max(2_000),
});
export type ReplaceWorkflowInstanceBindingsInput = z.infer<
  typeof replaceWorkflowInstanceBindingsInputSchema
>;

export const projectRoleMappingPresetSchema = z.object({
  projectId: z.string().uuid(),
  roleId: z.string().uuid(),
  roleCode: z.string(),
  assignees: z.array(z.string().trim().min(1).max(180)),
  revision: z.number().int().positive(),
  updatedByPrincipalId: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectRoleMappingPreset = z.infer<
  typeof projectRoleMappingPresetSchema
>;

export const upsertProjectRoleMappingPresetInputSchema = z.object({
  roleId: z.string().uuid(),
  assignees: principalIdsSchema,
  expectedRevision: z.number().int().positive().optional(),
});
export type UpsertProjectRoleMappingPresetInput = z.infer<
  typeof upsertProjectRoleMappingPresetInputSchema
>;
