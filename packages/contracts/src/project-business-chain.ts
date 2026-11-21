import { z } from "zod";
import { projectStatusSchema } from "./platform.js";
import {
  workflowDefinitionOriginSchema,
  workflowDefinitionScopeSchema,
} from "./workflow-assignment.js";
import { mcpToolKeySchema } from "./mcp-tool-call.js";

export const BUSINESS_CHAIN_FLAG = "project.business_chain";
export const PROJECT_SOURCE_MOCK_FLAG = "project.source.mock";

export const businessChainSnapshotPolicySchema = z.enum([
  "pin-at-project-create",
  "latest-active",
]);
export type BusinessChainSnapshotPolicy = z.infer<
  typeof businessChainSnapshotPolicySchema
>;

const businessChainKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Z][A-Z0-9_-]*$/);

const businessChainStageCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/);

const projectSourceProviderBindingFields = {
  providerId: z.string().uuid().optional(),
  providerVersionId: z.string().uuid().optional(),
  providerRevision: z.number().int().positive().optional(),
  toolKey: mcpToolKeySchema.optional(),
  readOnly: z.literal(true).optional(),
};

function validateProjectSourceProviderBinding(
  input: {
    readonly sourceKind: string;
    readonly providerId?: string | undefined;
    readonly providerVersionId?: string | undefined;
    readonly providerRevision?: number | undefined;
    readonly toolKey?: string | undefined;
    readonly readOnly?: true | undefined;
  },
  context: z.RefinementCtx,
): void {
  const configured = [
    input.providerId,
    input.providerVersionId,
    input.providerRevision,
    input.toolKey,
    input.readOnly,
  ].filter((value) => value !== undefined).length;
  if (input.sourceKind === "mcp") {
    if (
      input.providerId === undefined ||
      input.providerVersionId === undefined ||
      input.providerRevision === undefined ||
      input.toolKey === undefined ||
      input.readOnly !== true
    ) {
      context.addIssue({
        code: "custom",
        message:
          "mcp source bindings require provider, version, tool key and readOnly=true",
      });
    }
    return;
  }
  if (configured > 0) {
    context.addIssue({
      code: "custom",
      message: "Provider binding fields are only valid for mcp sources",
    });
  }
}

export const businessChainSourceRefSchema = z
  .object({
    refKey: z.string().trim().min(1).max(160),
    sourceKind: z.string().trim().min(1).max(80),
    sourceSystem: z.string().trim().min(1).max(120),
    objectType: z.string().trim().min(1).max(120),
    objectId: z.string().trim().min(1).max(240),
    path: z.string().trim().min(1).max(300),
    required: z.boolean().default(true),
    ...projectSourceProviderBindingFields,
  })
  .superRefine(validateProjectSourceProviderBinding);
export type BusinessChainSourceRef = z.infer<
  typeof businessChainSourceRefSchema
>;

export const businessChainFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-zA-Z0-9_]*$/),
  label: z.string().trim().min(1).max(160),
  bindings: z.array(businessChainSourceRefSchema).min(1).max(20),
});
export type BusinessChainField = z.infer<typeof businessChainFieldSchema>;

export const businessChainNodeMetadataSchema = z
  .object({
    sequence: z.number().int().positive(),
    stageCode: businessChainStageCodeSchema,
    summaryMetric: z.string().trim().min(1).max(160).optional(),
    fields: z.array(businessChainFieldSchema).max(50).default([]),
  })
  .superRefine((node, context) => {
    const fieldKeys = new Set<string>();
    for (const field of node.fields) {
      if (fieldKeys.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate field key ${field.key}`,
          path: ["fields"],
        });
      }
      fieldKeys.add(field.key);
    }
  });
export type BusinessChainNodeMetadata = z.infer<
  typeof businessChainNodeMetadataSchema
>;

const uniqueStringsSchema = (max: number) =>
  z
    .array(z.string().trim().min(1).max(120))
    .max(max)
    .default([])
    .transform((values) => [...new Set(values)]);

export const businessChainMetadataSchema = z.object({
  chainKey: businessChainKeySchema,
  templateKey: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(160),
  projectTypeCodes: uniqueStringsSchema(50),
  snapshotPolicy: businessChainSnapshotPolicySchema,
  allowUnboundSources: z.boolean().default(false),
});
export type BusinessChainMetadata = z.infer<typeof businessChainMetadataSchema>;

export const businessChainDefinitionInputSchema = z
  .object({
    chainKey: businessChainKeySchema,
    templateKey: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(160),
    projectTypeCodes: uniqueStringsSchema(50),
    snapshotPolicy: businessChainSnapshotPolicySchema,
    allowUnboundSources: z.boolean().default(false),
    nodes: z.array(businessChainNodeMetadataSchema).min(1).max(100),
    expectedRevision: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    const stages = new Set<string>();
    const sequences = new Set<number>();
    for (const node of value.nodes) {
      if (stages.has(node.stageCode)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate stageCode ${node.stageCode}`,
          path: ["nodes"],
        });
      }
      if (sequences.has(node.sequence)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate sequence ${node.sequence}`,
          path: ["nodes"],
        });
      }
      stages.add(node.stageCode);
      sequences.add(node.sequence);
    }
  });
export type BusinessChainDefinitionInput = z.input<
  typeof businessChainDefinitionInputSchema
>;
export type BusinessChainDefinitionValue = z.infer<
  typeof businessChainDefinitionInputSchema
>;

export const businessChainDefinitionSnapshotSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000),
  metadata: businessChainMetadataSchema,
  nodes: z.array(businessChainNodeMetadataSchema),
});
export type BusinessChainDefinitionSnapshot = z.infer<
  typeof businessChainDefinitionSnapshotSchema
>;

export const projectTemplateBusinessChainModeSchema = z.enum([
  "required",
  "optional",
  "none",
]);
export type ProjectTemplateBusinessChainMode = z.infer<
  typeof projectTemplateBusinessChainModeSchema
>;

export const projectTemplateBusinessChainPolicySchema = z.object({
  mode: projectTemplateBusinessChainModeSchema.default("none"),
  defaultBusinessChainKey: businessChainKeySchema.nullable().default(null),
  allowedBusinessChainKeys: uniqueStringsSchema(50),
  versionPolicy: businessChainSnapshotPolicySchema.default("latest-active"),
});
export type ProjectTemplateBusinessChainPolicy = z.infer<
  typeof projectTemplateBusinessChainPolicySchema
>;

export const emptyProjectTemplateBusinessChainPolicy: ProjectTemplateBusinessChainPolicy =
  {
    mode: "none",
    defaultBusinessChainKey: null,
    allowedBusinessChainKeys: [],
    versionPolicy: "latest-active",
  };

export const projectTemplateBusinessChainRefInputSchema = z.object({
  workflowDefinitionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  required: z.boolean().default(false),
});
export type ProjectTemplateBusinessChainRefInput = z.infer<
  typeof projectTemplateBusinessChainRefInputSchema
>;

export const projectTemplateBusinessChainRefSchema = z.object({
  workflowDefinitionId: z.string().uuid(),
  version: z.number().int().positive(),
  chainKey: businessChainKeySchema,
  displayName: z.string().trim().min(1).max(160),
  required: z.boolean(),
});
export type ProjectTemplateBusinessChainRef = z.infer<
  typeof projectTemplateBusinessChainRefSchema
>;

export const projectBusinessChainNodeBindingSchema = z.object({
  sequence: z.number().int().positive(),
  stageCode: businessChainStageCodeSchema,
  fieldBindings: z
    .array(
      z
        .object({
          fieldKey: z.string().trim().min(1).max(80),
          sourceKind: z.string().trim().min(1).max(80),
          sourceSystem: z.string().trim().min(1).max(120),
          objectType: z.string().trim().min(1).max(120),
          objectId: z.string().trim().min(1).max(240),
          path: z.string().trim().min(1).max(300),
          required: z.boolean().default(true),
          ...projectSourceProviderBindingFields,
        })
        .superRefine(validateProjectSourceProviderBinding),
    )
    .max(100),
});
export type ProjectBusinessChainNodeBinding = z.infer<
  typeof projectBusinessChainNodeBindingSchema
>;

export const projectBusinessChainBindingSchema = z.object({
  projectId: z.string().uuid(),
  projectTemplateId: z.string().uuid().nullable(),
  sourceTemplateRevision: z.number().int().positive().nullable(),
  workflowDefinitionId: z.string().uuid(),
  workflowDefinitionVersion: z.number().int().positive(),
  definitionSnapshot: businessChainDefinitionSnapshotSchema,
  chainKey: businessChainKeySchema,
  bindingMode: z.enum(["template", "manual", "upgrade"]),
  nodeBindings: z.array(projectBusinessChainNodeBindingSchema),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  boundByPrincipalId: z.string().trim().min(1).max(180),
  boundAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectBusinessChainBinding = z.infer<
  typeof projectBusinessChainBindingSchema
>;

export const projectBusinessChainBindingRevisionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  revision: z.number().int().positive(),
  operation: z.enum(["bind", "upgrade", "unbind"]),
  projectTemplateId: z.string().uuid().nullable(),
  sourceTemplateRevision: z.number().int().positive().nullable(),
  workflowDefinitionId: z.string().uuid().nullable(),
  workflowDefinitionVersion: z.number().int().positive().nullable(),
  definitionSnapshot: businessChainDefinitionSnapshotSchema.nullable(),
  chainKey: businessChainKeySchema.nullable(),
  bindingMode: z.enum(["template", "manual", "upgrade"]).nullable(),
  nodeBindings: z.array(projectBusinessChainNodeBindingSchema),
  bindingDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  actorPrincipalId: z.string().trim().min(1).max(180),
  reason: z.string().max(2_000),
  createdAt: z.string().datetime({ offset: true }),
});
export type ProjectBusinessChainBindingRevision = z.infer<
  typeof projectBusinessChainBindingRevisionSchema
>;

export const businessChainCandidateSchema = z.object({
  workflowDefinitionId: z.string().uuid(),
  version: z.number().int().positive(),
  chainKey: businessChainKeySchema,
  displayName: z.string().trim().min(1).max(160),
  scope: workflowDefinitionScopeSchema,
  origin: workflowDefinitionOriginSchema,
  projectTypeCodes: z.array(z.string()),
  required: z.boolean(),
  pinnedByTemplate: z.boolean(),
  definitionSnapshot: businessChainDefinitionSnapshotSchema,
});
export type BusinessChainCandidate = z.infer<
  typeof businessChainCandidateSchema
>;

export const projectFeatureFlagStateSchema = z.object({
  flagKey: z.string().trim().min(1).max(160),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  scopeType: z.enum(["platform", "project"]),
  scopeId: z.string().trim().min(1).max(180),
});
export type ProjectFeatureFlagState = z.infer<
  typeof projectFeatureFlagStateSchema
>;

export const projectBusinessChainSettingsSchema = z.object({
  projectId: z.string().uuid(),
  projectStatus: projectStatusSchema,
  featureFlags: z.object({
    businessChain: projectFeatureFlagStateSchema,
    sourceMock: projectFeatureFlagStateSchema,
  }),
  template: z
    .object({
      templateId: z.string().uuid(),
      revision: z.number().int().positive(),
      policy: projectTemplateBusinessChainPolicySchema,
    })
    .nullable(),
  binding: projectBusinessChainBindingSchema.nullable(),
  candidates: z.array(businessChainCandidateSchema),
  history: z.array(projectBusinessChainBindingRevisionSchema),
  blockedReasons: z.array(z.string()),
});
export type ProjectBusinessChainSettings = z.infer<
  typeof projectBusinessChainSettingsSchema
>;

export const bindProjectBusinessChainInputSchema = z.object({
  workflowDefinitionId: z.string().uuid(),
  nodeBindings: z.array(projectBusinessChainNodeBindingSchema).default([]),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().max(2_000).default(""),
  upgrade: z.boolean().default(false),
});
export type BindProjectBusinessChainInput = z.input<
  typeof bindProjectBusinessChainInputSchema
>;
export type BindProjectBusinessChainValue = z.infer<
  typeof bindProjectBusinessChainInputSchema
>;

export const unbindProjectBusinessChainInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().max(2_000).default(""),
});
export type UnbindProjectBusinessChainInput = z.infer<
  typeof unbindProjectBusinessChainInputSchema
>;

export const updateProjectFeatureFlagsInputSchema = z
  .object({
    businessChainEnabled: z.boolean().optional(),
    expectedBusinessChainRevision: z.number().int().nonnegative().optional(),
    sourceMockEnabled: z.boolean().optional(),
    expectedSourceMockRevision: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.businessChainEnabled !== undefined &&
      input.expectedBusinessChainRevision === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedBusinessChainRevision"],
        message: "business chain Flag updates require an expected revision",
      });
    }
    if (
      input.sourceMockEnabled !== undefined &&
      input.expectedSourceMockRevision === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedSourceMockRevision"],
        message: "source mock Flag updates require an expected revision",
      });
    }
  });
export type UpdateProjectFeatureFlagsInput = z.infer<
  typeof updateProjectFeatureFlagsInputSchema
>;

export const projectSourceFetchStatusSchema = z.enum([
  "fresh",
  "stale",
  "error",
]);
export type ProjectSourceFetchStatus = z.infer<
  typeof projectSourceFetchStatusSchema
>;

export const projectSourceFetchResultSchema = z.object({
  refKey: z.string().trim().min(1).max(160),
  sourceKind: z.string().trim().min(1).max(80),
  sourceSystem: z.string().trim().min(1).max(120),
  objectType: z.string().trim().min(1).max(120),
  objectId: z.string().trim().min(1).max(240),
  sourceRevision: z.string().trim().min(1).max(240).nullable(),
  observedAt: z.string().datetime({ offset: true }),
  effectiveAt: z.string().datetime({ offset: true }).nullable().default(null),
  freshUntil: z.string().datetime({ offset: true }).nullable(),
  status: projectSourceFetchStatusSchema,
  payload: z.unknown().nullable().default(null),
  failureReason: z.string().max(2_000).nullable().default(null),
  isMock: z.boolean().default(false),
});
export type ProjectSourceFetchResult = z.infer<
  typeof projectSourceFetchResultSchema
>;

export const projectSourceSnapshotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  refKey: z.string(),
  sourceKind: z.string(),
  sourceSystem: z.string(),
  sourceObjectType: z.string(),
  sourceObjectId: z.string(),
  sourceRevision: z.string().nullable(),
  version: z.number().int().positive(),
  status: projectSourceFetchStatusSchema,
  observedAt: z.string().datetime({ offset: true }),
  effectiveAt: z.string().datetime({ offset: true }).nullable(),
  freshUntil: z.string().datetime({ offset: true }).nullable(),
  payloadDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  payload: z.unknown().nullable(),
  failureReason: z.string().nullable(),
  isMock: z.boolean(),
  createdByPrincipalId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ProjectSourceSnapshot = z.infer<typeof projectSourceSnapshotSchema>;

export const projectSourceRefreshInputSchema = z.object({
  refKeys: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
});
export type ProjectSourceRefreshInput = z.input<
  typeof projectSourceRefreshInputSchema
>;
export type ProjectSourceRefreshValue = z.infer<
  typeof projectSourceRefreshInputSchema
>;

export const projectSourceRefreshResultSchema = z.object({
  projectId: z.string().uuid(),
  fetchedAt: z.string().datetime({ offset: true }),
  snapshots: z.array(projectSourceSnapshotSchema),
  partial: z.boolean(),
});
export type ProjectSourceRefreshResult = z.infer<
  typeof projectSourceRefreshResultSchema
>;

export const projectAlertSeveritySchema = z.enum([
  "info",
  "warning",
  "critical",
]);
export type ProjectAlertSeverity = z.infer<typeof projectAlertSeveritySchema>;

export const projectAlertLifecycleSchema = z.enum([
  "open",
  "acknowledged",
  "suppressed",
  "resolved",
]);
export type ProjectAlertLifecycle = z.infer<typeof projectAlertLifecycleSchema>;

export const projectAlertObservationSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(120),
  sourceObjectType: z.string().trim().min(1).max(120),
  sourceObjectId: z.string().trim().min(1).max(240),
  conditionCode: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Z][A-Z0-9_.:-]*$/),
  title: z.string().trim().min(1).max(240),
  message: z.string().trim().max(4_000).default(""),
  severity: projectAlertSeveritySchema.default("warning"),
  sourceRevision: z.string().trim().min(1).max(240).nullable().default(null),
  observedAt: z.string().datetime({ offset: true }),
  linkedNodeIds: z.array(z.string().uuid()).max(100).default([]),
  linkedTaskIds: z.array(z.string().uuid()).max(100).default([]),
  followTargetId: z.string().trim().min(1).max(180).nullable().default(null),
});
export type ProjectAlertObservation = z.infer<
  typeof projectAlertObservationSchema
>;

export const projectAlertSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  conditionKey: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSystem: z.string(),
  sourceObjectType: z.string(),
  sourceObjectId: z.string(),
  conditionCode: z.string(),
  title: z.string(),
  message: z.string(),
  severity: projectAlertSeveritySchema,
  lifecycle: projectAlertLifecycleSchema,
  sourceRevision: z.string().nullable(),
  firstSeenAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  acknowledgedAt: z.string().datetime({ offset: true }).nullable(),
  acknowledgedByPrincipalId: z.string().nullable(),
  suppressionUntil: z.string().datetime({ offset: true }).nullable(),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
  resolvedByPrincipalId: z.string().nullable(),
  assigneePrincipalId: z.string().nullable(),
  linkedNodeIds: z.array(z.string().uuid()),
  linkedTaskIds: z.array(z.string().uuid()),
  followTargetId: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectAlert = z.infer<typeof projectAlertSchema>;

export const projectAlertEventKindSchema = z.enum([
  "alert.opened",
  "alert.observed",
  "alert.acknowledged",
  "alert.suppressed",
  "alert.assigned",
  "alert.resolved",
  "alert.reopened",
  "alert.severity_changed",
]);
export type ProjectAlertEventKind = z.infer<typeof projectAlertEventKindSchema>;

export const projectAlertEventSchema = z.object({
  id: z.string().uuid(),
  alertId: z.string().uuid(),
  projectId: z.string().uuid(),
  seq: z.number().int().positive(),
  kind: projectAlertEventKindSchema,
  actorPrincipalId: z.string(),
  fromLifecycle: projectAlertLifecycleSchema.nullable(),
  toLifecycle: projectAlertLifecycleSchema.nullable(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ProjectAlertEvent = z.infer<typeof projectAlertEventSchema>;

export const acknowledgeProjectAlertInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  note: z.string().trim().max(2_000).default(""),
});
export type AcknowledgeProjectAlertInput = z.infer<
  typeof acknowledgeProjectAlertInputSchema
>;

export const suppressProjectAlertInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  until: z.string().datetime({ offset: true }),
  note: z.string().trim().max(2_000).default(""),
});
export type SuppressProjectAlertInput = z.infer<
  typeof suppressProjectAlertInputSchema
>;

export const resolveProjectAlertInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  note: z.string().trim().max(2_000).default(""),
});
export type ResolveProjectAlertInput = z.infer<
  typeof resolveProjectAlertInputSchema
>;

export const assignProjectAlertInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  assigneePrincipalId: z.string().trim().min(1).max(180).nullable(),
  note: z.string().trim().max(2_000).default(""),
});
export type AssignProjectAlertInput = z.infer<
  typeof assignProjectAlertInputSchema
>;

export const projectProgressNodeSchema = z.object({
  sequence: z.number().int().positive(),
  stageCode: z.string(),
  summaryMetric: z.string().nullable(),
  status: z.enum(["complete", "partial", "stale", "error", "unbound"]),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.unknown().nullable(),
      sourceSystem: z.string().nullable(),
      sourceRevision: z.string().nullable(),
      observedAt: z.string().datetime({ offset: true }).nullable(),
      freshUntil: z.string().datetime({ offset: true }).nullable(),
      freshness: z.enum(["fresh", "stale", "error", "missing"]),
    }),
  ),
});
export type ProjectProgressNode = z.infer<typeof projectProgressNodeSchema>;

export const projectOverviewSourceCoverageSchema = z.object({
  refKey: z.string(),
  sourceKind: z.string(),
  sourceSystem: z.string(),
  sourceObjectType: z.string(),
  sourceObjectId: z.string(),
  status: z.enum(["fresh", "stale", "error", "missing"]),
  activeSnapshotId: z.string().uuid().nullable(),
  activeVersion: z.number().int().positive().nullable(),
  sourceRevision: z.string().nullable(),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  freshUntil: z.string().datetime({ offset: true }).nullable(),
  failureReason: z.string().nullable(),
  isMock: z.boolean(),
});
export type ProjectOverviewSourceCoverage = z.infer<
  typeof projectOverviewSourceCoverageSchema
>;

export const projectProgressOverviewSchema = z.object({
  schemaVersion: z.literal("project-progress-overview-v1"),
  generatedAt: z.string().datetime({ offset: true }),
  projectId: z.string().uuid(),
  projectStatus: projectStatusSchema,
  enabled: z.boolean(),
  businessChain: z
    .object({
      chainKey: z.string(),
      definitionId: z.string().uuid(),
      definitionVersion: z.number().int().positive(),
      bindingRevision: z.number().int().positive(),
      bindingMode: z.enum(["template", "manual", "upgrade"]),
      instanceId: z.string().uuid().nullable(),
    })
    .nullable(),
  coverage: z.object({
    status: z.enum(["complete", "partial", "stale", "error"]),
    sources: z.array(projectOverviewSourceCoverageSchema),
  }),
  nodes: z.array(projectProgressNodeSchema),
  alerts: z.array(projectAlertSchema),
  workflowSummary: z.object({
    definitions: z.number().int().nonnegative(),
    instances: z.number().int().nonnegative(),
    activeInstances: z.number().int().nonnegative(),
    blockedInstances: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    plans: z.number().int().nonnegative(),
    planningReviewRequired: z.number().int().nonnegative(),
  }),
  taskSummary: z.object({
    total: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  blockedReasons: z.array(
    z.object({
      code: z.enum([
        "feature-disabled",
        "project-archived",
        "business-chain-unbound",
        "template-policy-required",
        "source-refs-missing",
        "source-stale",
        "source-error",
      ]),
      message: z.string(),
    }),
  ),
});
export type ProjectProgressOverview = z.infer<
  typeof projectProgressOverviewSchema
>;

export const projectAlertDetailSchema = z.object({
  alert: projectAlertSchema,
  events: z.array(projectAlertEventSchema),
});
export type ProjectAlertDetail = z.infer<typeof projectAlertDetailSchema>;

export const businessChainConditionMaterial = (input: {
  readonly sourceSystem: string;
  readonly sourceObjectId: string;
  readonly conditionCode: string;
}): string =>
  `${input.sourceSystem.trim().toLowerCase()}\u0000${input.sourceObjectId.trim()}\u0000${input.conditionCode.trim().toUpperCase()}`;
