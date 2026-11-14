import { z } from "zod";

const isoTimeSchema = z.string().datetime({ offset: true });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().trim().min(1).max(180);
const columnNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);

export const DATA_FABRIC_FLAG = "data_fabric";

export const dataConnectionStatusSchema = z.enum(["active", "disabled"]);
export type DataConnectionStatus = z.infer<
  typeof dataConnectionStatusSchema
>;

export const dataConnectionProviderSchema = z.literal("fixture");
export type DataConnectionProvider = z.infer<
  typeof dataConnectionProviderSchema
>;

export const dataConnectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: idSchema,
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  provider: dataConnectionProviderSchema,
  status: dataConnectionStatusSchema,
  revision: z.number().int().positive(),
  allowedRuntimeProfileIds: z.array(idSchema).min(1).max(100),
  maxRows: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  dataCutoffAt: isoTimeSchema.nullable(),
  createdByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type DataConnection = z.infer<typeof dataConnectionSchema>;

export const createDataConnectionInputSchema = z
  .object({
    workspaceId: idSchema,
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    allowedRuntimeProfileIds: z
      .array(idSchema)
      .min(1)
      .max(100)
      .transform((items) => [...new Set(items)]),
    maxRows: z.number().int().min(1).max(1_000).default(500),
    timeoutMs: z.number().int().min(1).max(60_000).default(10_000),
    dataCutoffAt: isoTimeSchema.optional(),
  })
  .strict();
export type CreateDataConnectionInput = z.input<
  typeof createDataConnectionInputSchema
>;
export type CreateDataConnectionValue = z.output<
  typeof createDataConnectionInputSchema
>;

export const datasetStatusSchema = z.enum(["active", "disabled"]);
export type DatasetStatus = z.infer<typeof datasetStatusSchema>;

export const datasetSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  workspaceId: idSchema,
  projectId: z.string().uuid(),
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4_000),
  status: datasetStatusSchema,
  revision: z.number().int().positive(),
  maxRows: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  createdByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type Dataset = z.infer<typeof datasetSchema>;

export const createDatasetInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{1,119}$/),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4_000).default(""),
    maxRows: z.number().int().min(1).max(1_000).default(500),
    timeoutMs: z.number().int().min(1).max(60_000).default(10_000),
  })
  .strict();
export type CreateDatasetInput = z.input<
  typeof createDatasetInputSchema
>;
export type CreateDatasetValue = z.output<
  typeof createDatasetInputSchema
>;

export const datasetColumnTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "date",
]);
export type DatasetColumnType = z.infer<
  typeof datasetColumnTypeSchema
>;

export const datasetColumnSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  name: columnNameSchema,
  dataType: datasetColumnTypeSchema,
  position: z.number().int().nonnegative(),
  sensitive: z.boolean(),
  createdAt: isoTimeSchema,
});
export type DatasetColumn = z.infer<typeof datasetColumnSchema>;

export const createDatasetColumnInputSchema = z
  .object({
    name: columnNameSchema,
    dataType: datasetColumnTypeSchema,
    position: z.number().int().min(0).max(1_000),
    sensitive: z.boolean().default(false),
  })
  .strict();
export type CreateDatasetColumnInput = z.input<
  typeof createDatasetColumnInputSchema
>;
export type CreateDatasetColumnValue = z.output<
  typeof createDatasetColumnInputSchema
>;

export const semanticMetricAggregationSchema = z.enum([
  "count",
  "sum",
  "avg",
  "min",
  "max",
]);
export type SemanticMetricAggregation = z.infer<
  typeof semanticMetricAggregationSchema
>;

export const semanticMetricStatusSchema = z.enum(["active", "retired"]);
export type SemanticMetricStatus = z.infer<
  typeof semanticMetricStatusSchema
>;

export const semanticMetricSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  key: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  currentVersion: z.number().int().positive(),
  status: semanticMetricStatusSchema,
  revision: z.number().int().positive(),
  createdByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type SemanticMetric = z.infer<typeof semanticMetricSchema>;

export const semanticMetricVersionContentSchema = z
  .object({
    aggregation: semanticMetricAggregationSchema,
    column: columnNameSchema,
    description: z.string().trim().max(4_000).default(""),
    format: z.enum(["integer", "decimal", "text"]).default("integer"),
  })
  .strict();
export type SemanticMetricVersionContent = z.input<
  typeof semanticMetricVersionContentSchema
>;
export type SemanticMetricVersionContentValue = z.output<
  typeof semanticMetricVersionContentSchema
>;

export const semanticMetricVersionSchema =
  semanticMetricVersionContentSchema.extend({
    id: z.string().uuid(),
    metricId: z.string().uuid(),
    version: z.number().int().positive(),
    digest: digestSchema,
    createdByPrincipalId: idSchema,
    createdAt: isoTimeSchema,
  });
export type SemanticMetricVersion = z.infer<
  typeof semanticMetricVersionSchema
>;

export const createSemanticMetricInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{1,119}$/),
    title: z.string().trim().min(1).max(160),
    content: semanticMetricVersionContentSchema,
  })
  .strict();
export type CreateSemanticMetricInput = z.input<
  typeof createSemanticMetricInputSchema
>;
export type CreateSemanticMetricValue = z.output<
  typeof createSemanticMetricInputSchema
>;

export const createSemanticMetricVersionInputSchema = z
  .object({
    expectedCurrentVersion: z.number().int().positive(),
    content: semanticMetricVersionContentSchema,
  })
  .strict();
export type CreateSemanticMetricVersionInput = z.input<
  typeof createSemanticMetricVersionInputSchema
>;
export type CreateSemanticMetricVersionValue = z.output<
  typeof createSemanticMetricVersionInputSchema
>;

export const dataRowFilterSchema = z
  .object({
    column: columnNameSchema,
    operator: z.enum(["eq", "neq", "in", "gte", "lte"]),
    values: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100),
  })
  .strict();
export type DataRowFilter = z.infer<typeof dataRowFilterSchema>;

export const dataPolicyScopeTypeSchema = z.enum(["workspace", "project"]);
export type DataPolicyScopeType = z.infer<
  typeof dataPolicyScopeTypeSchema
>;

export const dataPolicyStatusSchema = z.enum(["active", "retired"]);
export type DataPolicyStatus = z.infer<typeof dataPolicyStatusSchema>;

export const dataPolicyVersionContentSchema = z
  .object({
    rowFilters: z.array(dataRowFilterSchema).max(50).default([]),
    allowedColumns: z
      .array(columnNameSchema)
      .max(500)
      .default([])
      .transform((items) => [...new Set(items)]),
    deniedColumns: z
      .array(columnNameSchema)
      .max(500)
      .default([])
      .transform((items) => [...new Set(items)]),
    maxRows: z.number().int().min(1).max(1_000),
    timeoutMs: z.number().int().min(1).max(60_000),
    dataCutoffAt: isoTimeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allowed = new Set(value.allowedColumns);
    for (const column of value.deniedColumns) {
      if (allowed.has(column)) {
        context.addIssue({
          code: "custom",
          path: ["deniedColumns"],
          message: `column ${column} cannot be both allowed and denied`,
        });
      }
    }
  });
export type DataPolicyVersionContent = z.input<
  typeof dataPolicyVersionContentSchema
>;
export type DataPolicyVersionContentValue = z.output<
  typeof dataPolicyVersionContentSchema
>;

export const dataPolicyVersionSchema =
  dataPolicyVersionContentSchema.safeExtend({
    id: z.string().uuid(),
    policyId: z.string().uuid(),
    version: z.number().int().positive(),
    dataCutoffAt: isoTimeSchema.nullable(),
    digest: digestSchema,
    createdByPrincipalId: idSchema,
    createdAt: isoTimeSchema,
  });
export type DataPolicyVersion = z.infer<typeof dataPolicyVersionSchema>;

export const dataPolicySchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  scopeType: dataPolicyScopeTypeSchema,
  scopeId: idSchema,
  currentVersion: z.number().int().positive(),
  status: dataPolicyStatusSchema,
  revision: z.number().int().positive(),
  createdByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type DataPolicy = z.infer<typeof dataPolicySchema>;

export const createDataPolicyInputSchema = z
  .object({
    scopeType: dataPolicyScopeTypeSchema,
    scopeId: idSchema,
    content: dataPolicyVersionContentSchema,
  })
  .strict();
export type CreateDataPolicyInput = z.input<
  typeof createDataPolicyInputSchema
>;
export type CreateDataPolicyValue = z.output<
  typeof createDataPolicyInputSchema
>;

export const createDataPolicyVersionInputSchema = z
  .object({
    expectedCurrentVersion: z.number().int().positive(),
    content: dataPolicyVersionContentSchema,
  })
  .strict();
export type CreateDataPolicyVersionInput = z.input<
  typeof createDataPolicyVersionInputSchema
>;
export type CreateDataPolicyVersionValue = z.output<
  typeof createDataPolicyVersionInputSchema
>;

export const dataQueryModeSchema = z.enum(["explain", "metric", "dataset"]);
export type DataQueryMode = z.infer<typeof dataQueryModeSchema>;

export const executeDataQueryInputSchema = z
  .object({
    mode: dataQueryModeSchema,
    datasetId: z.string().uuid().optional(),
    metricId: z.string().uuid().optional(),
    columns: z
      .array(columnNameSchema)
      .max(100)
      .default([])
      .transform((items) => [...new Set(items)]),
    maxRows: z.number().int().min(1).max(1_000).optional(),
    timeoutMs: z.number().int().min(1).max(60_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === "metric" && input.metricId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["metricId"],
        message: "metricId is required for metric queries",
      });
    }
    if (input.mode !== "metric" && input.datasetId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["datasetId"],
        message: "datasetId is required for this query mode",
      });
    }
  });
export type ExecuteDataQueryInput = z.input<
  typeof executeDataQueryInputSchema
>;
export type ExecuteDataQueryValue = z.output<
  typeof executeDataQueryInputSchema
>;

export const queryRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);
export type QueryRunStatus = z.infer<typeof queryRunStatusSchema>;

export const queryPermissionSummarySchema = z.object({
  projectAccess: z.boolean(),
  workspaceAccess: z.boolean(),
  runtimeConnectionScope: z.boolean(),
  datasetScope: z.boolean(),
  guestDenied: z.boolean(),
  rowPolicyVersions: z.array(
    z.object({
      policyId: z.string().uuid(),
      version: z.number().int().positive(),
    }),
  ),
  columnPolicyVersions: z.array(
    z.object({
      policyId: z.string().uuid(),
      version: z.number().int().positive(),
    }),
  ),
  allowedColumns: z.array(z.string()),
  deniedColumns: z.array(z.string()),
  maxRows: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  dataCutoffAt: isoTimeSchema.nullable(),
});
export type QueryPermissionSummary = z.infer<
  typeof queryPermissionSummarySchema
>;

export const queryRunSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  projectId: z.string().uuid(),
  workspaceId: idSchema,
  runId: z.string().uuid(),
  contextPackId: z.string().uuid().nullable(),
  skillSnapshotDigest: digestSchema.nullable(),
  connectionId: z.string().uuid(),
  connectionVersion: z.number().int().positive(),
  datasetId: z.string().uuid(),
  datasetVersion: z.number().int().positive(),
  metricId: z.string().uuid().nullable(),
  metricVersion: z.number().int().positive().nullable(),
  runtimeProfileId: idSchema,
  mode: dataQueryModeSchema,
  querySpec: z.record(z.string(), z.unknown()),
  requesterPrincipalId: idSchema,
  agentPrincipalId: idSchema,
  rowFilters: z.array(dataRowFilterSchema),
  deniedColumns: z.array(z.string()),
  allowedColumns: z.array(z.string()),
  maxRows: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  dataCutoffAt: isoTimeSchema.nullable(),
  permissionSummary: queryPermissionSummarySchema,
  policySnapshot: z.array(
    z.object({
      policyId: z.string().uuid(),
      versionId: z.string().uuid(),
      version: z.number().int().positive(),
      digest: digestSchema,
    }),
  ),
  status: queryRunStatusSchema,
  scanCount: z.number().int().nonnegative().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  resultDigest: digestSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: isoTimeSchema.nullable(),
  completedAt: isoTimeSchema.nullable(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type QueryRun = z.infer<typeof queryRunSchema>;

export const queryResultSchema = z.object({
  queryRunId: z.string().uuid(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  digest: digestSchema,
  createdAt: isoTimeSchema,
});
export type QueryResult = z.infer<typeof queryResultSchema>;

export const dataAgentConversationStatusSchema = z.enum([
  "active",
  "archived",
]);
export type DataAgentConversationStatus = z.infer<
  typeof dataAgentConversationStatusSchema
>;

export const dataAgentConversationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  contextPackId: z.string().uuid().nullable(),
  skillSnapshotDigest: digestSchema.nullable(),
  runtimeProfileId: idSchema,
  requesterPrincipalId: idSchema,
  agentId: z.string().uuid(),
  agentPrincipalId: idSchema,
  title: z.string().trim().min(1).max(240),
  status: dataAgentConversationStatusSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type DataAgentConversation = z.infer<
  typeof dataAgentConversationSchema
>;

export const createDataAgentConversationInputSchema = z
  .object({
    runId: z.string().uuid(),
    title: z.string().trim().min(1).max(240).default("Data Agent"),
  })
  .strict();
export type CreateDataAgentConversationInput = z.input<
  typeof createDataAgentConversationInputSchema
>;
export type CreateDataAgentConversationValue = z.output<
  typeof createDataAgentConversationInputSchema
>;

export const dataAgentContextRefKindSchema = z.enum([
  "run",
  "context-pack",
  "skill-snapshot",
  "project-report",
  "query-run",
]);
export type DataAgentContextRefKind = z.infer<
  typeof dataAgentContextRefKindSchema
>;

export const dataAgentContextRefSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().nullable(),
  kind: dataAgentContextRefKindSchema,
  refId: idSchema,
  version: z.number().int().positive().nullable(),
  digest: digestSchema.nullable(),
  cutoffAt: isoTimeSchema.nullable(),
  createdAt: isoTimeSchema,
});
export type DataAgentContextRef = z.infer<typeof dataAgentContextRefSchema>;

export const dataAgentMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  sequence: z.number().int().positive(),
  role: z.enum(["user", "agent", "system"]),
  content: z.string().min(1).max(200_000),
  queryRunId: z.string().uuid().nullable(),
  createdAt: isoTimeSchema,
});
export type DataAgentMessage = z.infer<typeof dataAgentMessageSchema>;

export const createDataAgentMessageInputSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
    queryRunId: z.string().uuid().optional(),
  })
  .strict();
export type CreateDataAgentMessageInput = z.input<
  typeof createDataAgentMessageInputSchema
>;
export type CreateDataAgentMessageValue = z.output<
  typeof createDataAgentMessageInputSchema
>;

export const dataAgentAnswerSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  contextPackId: z.string().uuid().nullable(),
  skillSnapshotDigest: digestSchema.nullable(),
  requesterPrincipalId: idSchema,
  agentPrincipalId: idSchema,
  queryRunIds: z.array(z.string().uuid()).min(1),
  contextRefIds: z.array(z.string().uuid()).min(1),
  projectReportId: z.string().uuid().nullable(),
  content: z.string().min(1).max(200_000),
  digest: digestSchema,
  createdAt: isoTimeSchema,
});
export type DataAgentAnswer = z.infer<typeof dataAgentAnswerSchema>;

export const createDataAgentAnswerInputSchema = z
  .object({
    content: z.string().trim().min(1).max(200_000),
    queryRunIds: z
      .array(z.string().uuid())
      .min(1)
      .max(20)
      .transform((items) => [...new Set(items)]),
    projectReportId: z.string().uuid().optional(),
  })
  .strict();
export type CreateDataAgentAnswerInput = z.input<
  typeof createDataAgentAnswerInputSchema
>;
export type CreateDataAgentAnswerValue = z.output<
  typeof createDataAgentAnswerInputSchema
>;

export const dataAgentConversationDetailSchema = z.object({
  conversation: dataAgentConversationSchema,
  messages: z.array(dataAgentMessageSchema),
  contextRefs: z.array(dataAgentContextRefSchema),
  queryRuns: z.array(queryRunSchema),
  answers: z.array(dataAgentAnswerSchema),
});
export type DataAgentConversationDetail = z.infer<
  typeof dataAgentConversationDetailSchema
>;
