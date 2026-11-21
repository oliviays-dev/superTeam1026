import { z } from "zod";
import { mcpToolKeySchema } from "./mcp-tool-call.js";
import { secretReferenceSchema } from "./secret-reference.js";

export const MCP_PROVIDER_CONTROL_PLANE_FLAG = "mcp.provider_control_plane";

export const mcpProviderKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]+$/);

export const mcpProviderStatusSchema = z.enum([
  "draft",
  "active",
  "disabled",
  "archived",
]);
export type McpProviderStatus = z.infer<typeof mcpProviderStatusSchema>;

export const mcpProviderHealthStatusSchema = z.enum([
  "unknown",
  "probing",
  "healthy",
  "unhealthy",
]);
export type McpProviderHealthStatus = z.infer<
  typeof mcpProviderHealthStatusSchema
>;

export const mcpProviderDiscoveryStatusSchema = z.enum([
  "not_discovered",
  "discovering",
  "ready",
  "failed",
]);
export type McpProviderDiscoveryStatus = z.infer<
  typeof mcpProviderDiscoveryStatusSchema
>;

export const mcpProviderTransportSchema = z.literal("streamable-http");
export type McpProviderTransport = z.infer<
  typeof mcpProviderTransportSchema
>;

export const mcpProviderAuthKindSchema = z.enum(["none", "bearer", "header"]);
export type McpProviderAuthKind = z.infer<typeof mcpProviderAuthKindSchema>;

export const mcpProviderErrorCategorySchema = z.enum([
  "timeout",
  "dns",
  "tls",
  "authentication",
  "authorization",
  "http_status",
  "protocol",
  "schema",
  "network",
  "credential",
  "unknown",
]);
export type McpProviderErrorCategory = z.infer<
  typeof mcpProviderErrorCategorySchema
>;

export const mcpProviderProbeStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
]);
export type McpProviderProbeStatus = z.infer<
  typeof mcpProviderProbeStatusSchema
>;

export const mcpProviderProbeTriggerSchema = z.enum([
  "owner",
  "admin",
  "system",
]);
export type McpProviderProbeTrigger = z.infer<
  typeof mcpProviderProbeTriggerSchema
>;

export const mcpCredentialRefSchema = secretReferenceSchema;

const mcpHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9-]+$/);

const mcpEndpointUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "endpoint must be a URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "endpoint must use http or https",
      });
    }
    if (url.username !== "" || url.password !== "") {
      context.addIssue({
        code: "custom",
        message: "endpoint must not embed credentials",
      });
    }
    if (url.hash !== "") {
      context.addIssue({
        code: "custom",
        message: "endpoint must not contain a fragment",
      });
    }
  });

const mcpProviderConnectionFields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  transport: mcpProviderTransportSchema.default("streamable-http"),
  endpointUrl: mcpEndpointUrlSchema,
  authKind: mcpProviderAuthKindSchema.default("none"),
  credentialRef: mcpCredentialRefSchema.nullable().default(null),
  credentialHeaderName: mcpHeaderNameSchema.nullable().default(null),
  requestTimeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
};

type McpProviderConnectionInput = {
  readonly authKind: McpProviderAuthKind;
  readonly credentialRef: string | null;
  readonly credentialHeaderName: string | null;
};

function validateMcpProviderConnection(
  input: McpProviderConnectionInput,
  context: z.RefinementCtx,
): void {
  if (input.authKind === "none") {
    if (input.credentialRef !== null) {
      context.addIssue({
        code: "custom",
        path: ["credentialRef"],
        message: "credentialRef is not allowed when authKind is none",
      });
    }
    if (input.credentialHeaderName !== null) {
      context.addIssue({
        code: "custom",
        path: ["credentialHeaderName"],
        message: "credentialHeaderName is not allowed when authKind is none",
      });
    }
    return;
  }
  if (input.credentialRef === null) {
    context.addIssue({
      code: "custom",
      path: ["credentialRef"],
      message: "credentialRef is required for authenticated providers",
    });
  }
  if (input.authKind === "bearer" && input.credentialHeaderName !== null) {
    context.addIssue({
      code: "custom",
      path: ["credentialHeaderName"],
      message: "bearer authentication uses the Authorization header",
    });
  }
  if (input.authKind === "header" && input.credentialHeaderName === null) {
    context.addIssue({
      code: "custom",
      path: ["credentialHeaderName"],
      message: "header authentication requires credentialHeaderName",
    });
  }
}

export const createMcpProviderInputSchema = z
  .object({
    providerKey: mcpProviderKeySchema,
    ...mcpProviderConnectionFields,
  })
  .strict()
  .superRefine(validateMcpProviderConnection);
export type CreateMcpProviderInput = z.infer<
  typeof createMcpProviderInputSchema
>;

export const createMcpProviderVersionInputSchema = z
  .object({
    ...mcpProviderConnectionFields,
    expectedRevision: z.number().int().positive(),
  })
  .strict()
  .superRefine(validateMcpProviderConnection);
export type CreateMcpProviderVersionInput = z.infer<
  typeof createMcpProviderVersionInputSchema
>;

export const mcpProviderRevisionInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().max(2_000).default(""),
  })
  .strict();
export type McpProviderRevisionInput = z.infer<
  typeof mcpProviderRevisionInputSchema
>;

export const mcpProviderProbeInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type McpProviderProbeInput = z.infer<
  typeof mcpProviderProbeInputSchema
>;

export const mcpProviderHealthCheckInputSchema = z
  .object({
    providerIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .strict();
export type McpProviderHealthCheckInput = z.infer<
  typeof mcpProviderHealthCheckInputSchema
>;

export const mcpProviderToolSchema = z.object({
  toolKey: mcpToolKeySchema,
  name: z.string().min(1).max(240),
  description: z.string().max(4_000),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  schemaDigest: z.string().length(64),
  schemaRef: z.string().min(1).max(500),
  invocationEnabled: z.literal(false),
  grantsExecution: z.literal(false),
});
export type McpProviderTool = z.infer<typeof mcpProviderToolSchema>;

export const mcpProviderVersionSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string().uuid(),
  version: z.number().int().positive(),
  transport: mcpProviderTransportSchema,
  endpointHost: z.string().min(1).max(500),
  authKind: mcpProviderAuthKindSchema,
  credentialConfigured: z.boolean(),
  requestTimeoutMs: z.number().int().min(1_000).max(30_000),
  configDigest: z.string().length(64),
  createdByPrincipalId: z.string().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
});
export type McpProviderVersion = z.infer<typeof mcpProviderVersionSchema>;

export const mcpProviderProbeSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string().uuid(),
  providerVersionId: z.string().uuid(),
  status: mcpProviderProbeStatusSchema,
  trigger: mcpProviderProbeTriggerSchema,
  requestedByPrincipalId: z.string().min(1).max(180),
  errorCategory: mcpProviderErrorCategorySchema.nullable(),
  errorCode: z.string().max(160).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  toolCount: z.number().int().nonnegative().nullable(),
  requestedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type McpProviderProbe = z.infer<typeof mcpProviderProbeSchema>;

export const mcpProviderAuditSchema = z.object({
  id: z.string().uuid(),
  providerId: z.string().uuid(),
  seq: z.number().int().positive(),
  action: z.string().min(1).max(120),
  actorPrincipalId: z.string().min(1).max(180),
  actorRole: z.enum(["owner", "platform-admin", "system"]),
  reason: z.string().max(2_000),
  fromState: z.record(z.string(), z.unknown()),
  toState: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
});
export type McpProviderAudit = z.infer<typeof mcpProviderAuditSchema>;

export const mcpProviderSchema = z.object({
  id: z.string().uuid(),
  providerKey: z.string().min(2).max(120),
  ownerPrincipalId: z.string().min(1).max(180),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000),
  status: mcpProviderStatusSchema,
  currentVersion: z.number().int().positive(),
  currentVersionId: z.string().uuid(),
  transport: mcpProviderTransportSchema,
  endpointHost: z.string().min(1).max(500),
  authKind: mcpProviderAuthKindSchema,
  credentialConfigured: z.boolean(),
  requestTimeoutMs: z.number().int().min(1_000).max(30_000),
  healthStatus: mcpProviderHealthStatusSchema,
  healthCheckedAt: z.string().datetime({ offset: true }).nullable(),
  healthVersionId: z.string().uuid().nullable(),
  discoveryStatus: mcpProviderDiscoveryStatusSchema,
  toolCount: z.number().int().nonnegative(),
  lastErrorCategory: mcpProviderErrorCategorySchema.nullable(),
  lastErrorCode: z.string().max(160).nullable(),
  lastErrorMessage: z.string().max(2_000).nullable(),
  revision: z.number().int().positive(),
  invocationEnabled: z.literal(false),
  grantsExecution: z.literal(false),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type McpProvider = z.infer<typeof mcpProviderSchema>;

export const mcpProviderDetailSchema = z.object({
  provider: mcpProviderSchema,
  versions: z.array(mcpProviderVersionSchema),
  latestProbe: mcpProviderProbeSchema.nullable(),
  tools: z.array(mcpProviderToolSchema),
  audit: z.array(mcpProviderAuditSchema),
});
export type McpProviderDetail = z.infer<typeof mcpProviderDetailSchema>;

export const mcpProviderProbeRequestResultSchema = z.object({
  provider: mcpProviderSchema,
  probe: mcpProviderProbeSchema,
});
export type McpProviderProbeRequestResult = z.infer<
  typeof mcpProviderProbeRequestResultSchema
>;

export const mcpProviderHealthCheckResultSchema = z.object({
  queued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  probes: z.array(mcpProviderProbeSchema),
});
export type McpProviderHealthCheckResult = z.infer<
  typeof mcpProviderHealthCheckResultSchema
>;

export const mcpProviderToolListSchema = z.object({
  providerId: z.string().uuid(),
  providerVersionId: z.string().uuid(),
  items: z.array(mcpProviderToolSchema),
});
export type McpProviderToolList = z.infer<typeof mcpProviderToolListSchema>;
