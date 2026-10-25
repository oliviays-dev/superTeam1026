import { z } from "zod";
import { sourceClassSchema, toolCategorySchema } from "./task-execution.js";

export const capabilityStateSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const gateEnforcementSchema = z.enum([
  "blocking",
  "cooperative",
  "observe-only",
]);
export type GateEnforcement = z.infer<typeof gateEnforcementSchema>;

export const planVisibilitySchema = z.enum(["structured", "summary", "opaque"]);
export type PlanVisibility = z.infer<typeof planVisibilitySchema>;

export const runtimeCapabilityProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runtimeId: z.string().trim().min(1).max(180),
  runtimeRevision: z.string().trim().min(1).max(180),
  adapterId: z.string().trim().min(1).max(160),
  provider: z.string().trim().min(1).max(120),
  protocol: z.enum(["builtin", "codex-jsonl", "plain-text", "future"]),
  capabilities: z.object({
    search: capabilityStateSchema,
    network: capabilityStateSchema,
    fileRead: capabilityStateSchema,
    fileWrite: capabilityStateSchema,
    shell: capabilityStateSchema,
    browser: capabilityStateSchema,
    mcp: capabilityStateSchema,
    sessionResume: capabilityStateSchema,
    structuredPlan: capabilityStateSchema,
    structuredToolEvents: capabilityStateSchema,
    structuredSubagent: capabilityStateSchema,
  }),
  toolCategories: z.array(toolCategorySchema).max(300).default([]),
  networkModes: z
    .array(z.enum(["none", "restricted", "public"]))
    .max(3)
    .default([]),
  gateEnforcement: gateEnforcementSchema,
  limits: z.object({
    maxDurationMs: z.number().int().positive().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxParallelSubagents: z.number().int().nonnegative().optional(),
  }),
  provenance: z.object({
    adapter: z.boolean(),
    probe: z.boolean(),
    config: z.boolean(),
    observedInRuns: z.boolean(),
  }),
  capturedAt: z.string().trim().min(1),
});
export type RuntimeCapabilityProfile = z.infer<
  typeof runtimeCapabilityProfileSchema
>;

export const capabilityGapSchema = z.object({
  code: z.enum([
    "runtime-capability-missing",
    "policy-not-authorized",
    "launch-parameter-disabled",
    "principal-grant-missing",
    "runtime-unavailable",
  ]),
  key: z.string().trim().min(1).max(160),
  necessity: z.enum(["required", "preferred"]),
  message: z.string().trim().min(1).max(1_000),
  remediation: z.string().trim().max(1_000).optional(),
});
export type CapabilityGap = z.infer<typeof capabilityGapSchema>;

export const executionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1).max(180),
  taskId: z.string().trim().min(1).max(180),
  runId: z.string().trim().min(1).max(180).optional(),
  workspaceId: z.string().trim().min(1).max(180),
  principalId: z.string().trim().min(1).max(180),
  teammateId: z.string().trim().min(1).max(180).optional(),
  runtimeId: z.string().trim().min(1).max(180),
  adapterId: z.string().trim().min(1).max(160),
  runtimeRevision: z.string().trim().min(1).max(180),
  policyVersion: z.string().trim().min(1).max(160),
  ticketId: z.string().trim().min(1).max(180).optional(),
  resolved: z.object({
    searchEnabled: z.boolean().nullable(),
    networkAccess: z.enum(["none", "restricted", "public", "unknown"]),
    allowedToolCategories: z.array(toolCategorySchema).max(300),
    approvalToolCategories: z.array(toolCategorySchema).max(300),
    deniedToolCategories: z.array(toolCategorySchema).max(300),
    sandbox: z.string().trim().min(1).max(240),
    gateEnforcement: gateEnforcementSchema,
    planVisibility: planVisibilitySchema,
  }),
  launch: z.object({
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(160).optional(),
    reasoningEffort: z.string().trim().min(1).max(40).optional(),
    argsDigest: z.string().trim().min(1).max(160).optional(),
    commandDigest: z.string().trim().min(1).max(160).optional(),
    authMode: z.string().trim().min(1).max(120),
  }),
  unresolved: z.array(capabilityGapSchema).max(100).default([]),
  createdAt: z.string().trim().min(1),
});
export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;

export const executionPlanStepSchema = z.object({
  id: z.string().trim().min(1).max(180),
  ordinal: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(500),
  status: z.enum(["pending", "active", "completed", "failed", "skipped"]),
  detail: z.string().trim().max(4_000).optional(),
  startedAt: z.string().trim().min(1).optional(),
  endedAt: z.string().trim().min(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
});
export type ExecutionPlanStep = z.infer<typeof executionPlanStepSchema>;

export const executionSubagentSchema = z.object({
  id: z.string().trim().min(1).max(180),
  role: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "active", "completed", "failed"]),
  inputSummary: z.string().trim().max(4_000).optional(),
  outputSummary: z.string().trim().max(4_000).optional(),
  startedAt: z.string().trim().min(1).optional(),
  endedAt: z.string().trim().min(1).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
});
export type ExecutionSubagent = z.infer<typeof executionSubagentSchema>;

export const agentExecutionPlanSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1).max(180),
  runId: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(180),
  source: z.enum(["explicit", "derived", "unavailable"]),
  visibility: planVisibilitySchema,
  revision: z.number().int().positive(),
  status: z.enum(["pending", "active", "completed", "failed", "cancelled"]),
  summary: z.string().trim().max(8_000).optional(),
  steps: z.array(executionPlanStepSchema).max(200).default([]),
  subagents: z.array(executionSubagentSchema).max(100).default([]),
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
});
export type AgentExecutionPlan = z.infer<typeof agentExecutionPlanSchema>;

export const runEventTypeSchema = z.enum([
  "plan.snapshot",
  "step.started",
  "step.completed",
  "step.failed",
  "tool.call",
  "tool.result",
  "subagent.started",
  "subagent.completed",
  "gate.requested",
  "gate.decided",
  "progress.summary",
  "artifact",
  "warning",
  "error",
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1).max(240),
  runId: z.string().trim().min(1).max(180),
  seq: z.number().int().positive(),
  type: runEventTypeSchema,
  source: z.enum([
    "builtin-session",
    "external-jsonl",
    "external-trace",
    "derived",
  ]),
  sourceEventId: z.string().trim().min(1).max(500).optional(),
  visibility: z.enum(["public", "restricted", "admin-only"]),
  summary: z.string().trim().min(1).max(20_000),
  data: z.record(z.string(), z.unknown()).optional(),
  rawRef: z.string().trim().min(1).max(1_000).optional(),
  createdAt: z.string().trim().min(1),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const executionGateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().trim().min(1).max(180),
  runId: z.string().trim().min(1).max(180),
  taskId: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(180),
  kind: z.enum([
    "preflight",
    "tool-approval",
    "data-source",
    "external-send",
    "budget",
    "runtime-switch",
  ]),
  status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
  reason: z.string().trim().min(1).max(2_000),
  requestedToolCategory: toolCategorySchema.optional(),
  requestedSourceClass: sourceClassSchema.optional(),
  requestedScope: z.array(z.string().trim().min(1).max(500)).max(100),
  enforcement: gateEnforcementSchema,
  requestedByPrincipalId: z.string().trim().min(1).max(180).optional(),
  decidedByPrincipalId: z.string().trim().min(1).max(180).optional(),
  decisionNote: z.string().trim().max(4_000).optional(),
  requestedAt: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1).optional(),
  decidedAt: z.string().trim().min(1).optional(),
});
export type ExecutionGate = z.infer<typeof executionGateSchema>;

export const runExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().trim().min(1).max(180),
  taskId: z.string().trim().min(1).max(180),
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(160),
  reasoningEffort: z.string().trim().min(1).max(40).optional(),
  runtimeId: z.string().trim().min(1).max(180),
  runtimeName: z.string().trim().min(1).max(200),
  runtimeVersion: z.string().trim().min(1).max(120),
  adapterId: z.string().trim().min(1).max(160),
  authMode: z.string().trim().min(1).max(120),
  sandbox: z.string().trim().min(1).max(240),
  networkAccess: z.enum(["none", "restricted", "public", "unknown"]),
  gateEnforcement: gateEnforcementSchema.optional(),
  searchEnabled: z.boolean().nullable(),
  searchUsed: z.boolean().nullable(),
  planVisibility: planVisibilitySchema,
  toolEventCompleteness: z.enum(["complete", "partial", "none"]),
  allowedToolCategories: z.array(toolCategorySchema).max(300),
  usedTools: z.array(z.string().trim().min(1).max(240)).max(1_000),
  ticketId: z.string().trim().min(1).max(180).optional(),
  contextPackId: z.string().trim().min(1).max(180).optional(),
  envelopeId: z.string().trim().min(1).max(180),
  policyVersion: z.string().trim().min(1).max(160),
  unknownFields: z
    .array(z.string().trim().min(1).max(200))
    .max(200)
    .default([]),
  capturedAt: z.string().trim().min(1),
  finalizedAt: z.string().trim().min(1).optional(),
});
export type RunExecutionSnapshot = z.infer<typeof runExecutionSnapshotSchema>;

export const executionPreflightResultSchema = z.object({
  compatible: z.boolean(),
  runtime: runtimeCapabilityProfileSchema,
  envelopePreview: executionEnvelopeSchema,
  gaps: z.array(capabilityGapSchema),
  suggestedRuntimeIds: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ExecutionPreflightResult = z.infer<
  typeof executionPreflightResultSchema
>;

export const taskExecutionProjectionSchema = z.object({
  taskId: z.string().trim().min(1).max(180),
  runs: z.array(z.record(z.string(), z.unknown())).default([]),
  selectedRunId: z.string().trim().min(1).max(180).optional(),
  plan: agentExecutionPlanSchema.optional(),
  events: z.array(runEventSchema).default([]),
  gates: z.array(executionGateSchema).default([]),
  snapshot: runExecutionSnapshotSchema.optional(),
  capabilities: z.object({
    planAvailable: z.boolean(),
    contextAvailable: z.boolean(),
    gateAvailable: z.boolean(),
    memoryAvailable: z.boolean(),
  }),
});
export type TaskExecutionProjection = z.infer<
  typeof taskExecutionProjectionSchema
>;
