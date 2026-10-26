import { z } from "zod";
import {
  externalRuntimeCapabilityNameSchema,
  externalRuntimeNetworkModeSchema,
  externalRuntimeSandboxModeSchema,
  externalRuntimeSchema,
} from "./external-runtime.js";
import {
  executionPreflightResultSchema,
  runtimeCapabilityProfileSchema,
  executionEnvelopeSchema,
} from "./runtime-execution.js";
import { reasoningEffortSchema } from "./task-execution.js";

export const agentRuntimeBindingStatusSchema = z.enum(["active", "disabled"]);
export type AgentRuntimeBindingStatus = z.infer<
  typeof agentRuntimeBindingStatusSchema
>;

export const agentRuntimeBindingExecutionModeSchema = z.literal("external");
export type AgentRuntimeBindingExecutionMode = z.infer<
  typeof agentRuntimeBindingExecutionModeSchema
>;

export const agentRuntimeBindingSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  runtimeId: z.string().uuid(),
  executionMode: agentRuntimeBindingExecutionModeSchema,
  status: agentRuntimeBindingStatusSchema,
  revision: z.number().int().positive(),
  boundBy: z.string().trim().min(1).max(180),
  disabledBy: z.string().trim().min(1).max(180).nullable(),
  disabledReason: z.string().trim().min(1).max(1_000).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  disabledAt: z.string().datetime({ offset: true }).nullable(),
});
export type AgentRuntimeBinding = z.infer<typeof agentRuntimeBindingSchema>;

export const agentRuntimeBindingDetailSchema = z.object({
  agentId: z.string().uuid(),
  binding: agentRuntimeBindingSchema.nullable(),
  runtime: externalRuntimeSchema.nullable(),
});
export type AgentRuntimeBindingDetail = z.infer<
  typeof agentRuntimeBindingDetailSchema
>;

const bindingExpectedRevisionSchema = z.number().int().nonnegative();

export const setAgentRuntimeBindingInputSchema = z
  .object({
    runtimeId: z.string().uuid(),
    expectedRevision: bindingExpectedRevisionSchema,
  })
  .strict();
export type SetAgentRuntimeBindingInput = z.infer<
  typeof setAgentRuntimeBindingInputSchema
>;

export const removeAgentRuntimeBindingInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type RemoveAgentRuntimeBindingInput = z.infer<
  typeof removeAgentRuntimeBindingInputSchema
>;

const workspaceIdSchema = z.string().trim().min(1).max(180);

export const agentRuntimePreflightInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    workspaceId: workspaceIdSchema,
    taskId: z.string().trim().min(1).max(180).optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/)
      .optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    requiredCapabilities: z
      .array(externalRuntimeCapabilityNameSchema)
      .max(30)
      .default([])
      .transform((items) => [...new Set(items)]),
    requiredSandboxMode: externalRuntimeSandboxModeSchema.optional(),
    requiredNetworkMode: externalRuntimeNetworkModeSchema.optional(),
  })
  .strict();
export type AgentRuntimePreflightInput = z.infer<
  typeof agentRuntimePreflightInputSchema
>;

export const runtimePreflightErrorCodeSchema = z.enum([
  "agent_not_found",
  "agent_unavailable",
  "runtime_forbidden",
  "runtime_binding_missing",
  "runtime_binding_disabled",
  "runtime_binding_revision_conflict",
  "runtime_not_found",
  "runtime_inactive",
  "runtime_archived",
  "runtime_probe_missing",
  "runtime_probe_pending",
  "runtime_probe_failed",
  "runtime_probe_stale",
  "runtime_command_digest_mismatch",
  "runtime_args_digest_mismatch",
  "runtime_capability_snapshot_missing",
  "runtime_protocol_unsupported",
  "runtime_model_required",
  "runtime_model_unsupported",
  "runtime_capability_missing",
  "runtime_sandbox_unsupported",
  "runtime_network_unsupported",
  "runtime_workspace_invalid",
]);
export type RuntimePreflightErrorCode = z.infer<
  typeof runtimePreflightErrorCodeSchema
>;

export const runtimePreflightErrorDetailsSchema = z.object({
  preflightCode: runtimePreflightErrorCodeSchema,
  remediation: z.string().trim().min(1).max(1_000),
  bindingRevision: z.number().int().positive().nullable(),
  runtimeRevision: z.number().int().positive().nullable(),
});
export type RuntimePreflightErrorDetails = z.infer<
  typeof runtimePreflightErrorDetailsSchema
>;

export const agentRuntimePreflightResultSchema =
  executionPreflightResultSchema.extend({
    bindingRevision: z.number().int().positive(),
    runtimeRevision: z.number().int().positive(),
    capabilitySnapshotId: z.string().uuid(),
    checkedAt: z.string().datetime({ offset: true }),
  });
export type AgentRuntimePreflightResult = z.infer<
  typeof agentRuntimePreflightResultSchema
>;

export const externalRunExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  runtime: externalRuntimeSchema.pick({
    id: true,
    name: true,
    revision: true,
    provider: true,
    protocol: true,
    command: true,
    managedArgs: true,
    customArgs: true,
    supportedModels: true,
    defaultModel: true,
    sandboxMode: true,
    networkMode: true,
    commandDigest: true,
    argsDigest: true,
  }),
  binding: agentRuntimeBindingSchema.pick({
    id: true,
    revision: true,
  }),
  capabilitySnapshotId: z.string().uuid(),
  capability: runtimeCapabilityProfileSchema,
  envelope: executionEnvelopeSchema,
  model: z.string().trim().min(1).max(160).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  capturedAt: z.string().datetime({ offset: true }),
});
export type ExternalRunExecutionSnapshot = z.infer<
  typeof externalRunExecutionSnapshotSchema
>;

export {
  executionEnvelopeSchema,
  executionPreflightResultSchema,
  runtimeCapabilityProfileSchema,
};

export function runtimePreflightRemediation(
  code: RuntimePreflightErrorCode,
): string {
  switch (code) {
    case "agent_not_found":
      return "Select an existing agent before configuring an external runtime binding.";
    case "agent_unavailable":
      return "Enable the agent before binding or running preflight checks.";
    case "runtime_forbidden":
      return "Use a platform-visible runtime or ask its owner or a platform administrator for access.";
    case "runtime_binding_missing":
      return "Create an external runtime binding for this agent before dispatch.";
    case "runtime_binding_disabled":
      return "Bind the agent to an active, successfully probed runtime again.";
    case "runtime_binding_revision_conflict":
      return "Reload the current binding revision and retry the command.";
    case "runtime_not_found":
      return "Select an existing external runtime.";
    case "runtime_inactive":
      return "Probe and enable the runtime before creating a new dispatch.";
    case "runtime_archived":
      return "Restore the runtime, probe its current revision, and enable it before rebinding.";
    case "runtime_probe_missing":
      return "Run a probe for the current runtime revision.";
    case "runtime_probe_pending":
      return "Wait for the current runtime probe to finish successfully.";
    case "runtime_probe_failed":
      return "Review the probe diagnostics, fix the command or environment, and probe again.";
    case "runtime_probe_stale":
      return "Probe the current runtime revision after the pending probe settles.";
    case "runtime_command_digest_mismatch":
      return "Probe the runtime again so its command digest matches the current definition.";
    case "runtime_args_digest_mismatch":
      return "Probe the runtime again so its argument digest matches the current definition.";
    case "runtime_capability_snapshot_missing":
      return "Run a successful probe to capture the runtime capability snapshot.";
    case "runtime_protocol_unsupported":
      return "Choose a runtime whose protocol is supported by this worker.";
    case "runtime_model_required":
      return "Provide a model or configure a default model for the runtime.";
    case "runtime_model_unsupported":
      return "Choose a model from the runtime model pool.";
    case "runtime_capability_missing":
      return "Select a runtime with the required capabilities or remove the unsupported requirement.";
    case "runtime_sandbox_unsupported":
      return "Use a runtime whose sandbox mode exactly matches the dispatch policy.";
    case "runtime_network_unsupported":
      return "Use a runtime whose network mode exactly matches the dispatch policy.";
    case "runtime_workspace_invalid":
      return "Use a relative workspace identifier inside the configured workspace root.";
  }
}
