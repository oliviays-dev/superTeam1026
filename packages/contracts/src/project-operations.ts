import { z } from "zod";

const isoTimeSchema = z.string().datetime({ offset: true });

export const PROJECT_AI_PM_FLAG = "project.ai_pm";

export const projectAiPmStatusSchema = z.enum([
  "provisioning",
  "ready",
  "failed",
]);
export type ProjectAiPmStatus = z.infer<typeof projectAiPmStatusSchema>;

export const projectAiPmSchema = z.object({
  projectId: z.string().uuid(),
  status: projectAiPmStatusSchema,
  roleId: z.string().uuid().nullable(),
  memberId: z.string().uuid().nullable(),
  agentId: z.string().uuid().nullable(),
  agentPrincipalId: z.string().nullable(),
  teammateId: z.string().uuid().nullable(),
  templateId: z.string().uuid().nullable(),
  templateVersionId: z.string().uuid().nullable(),
  skillId: z.string().uuid().nullable(),
  skillVersionId: z.string().uuid().nullable(),
  skillInstallationId: z.string().uuid().nullable(),
  skillBindingId: z.string().uuid().nullable(),
  runtimeProfileId: z.string().nullable(),
  runtimeProfileKind: z.enum(["builtin", "external"]),
  lastError: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type ProjectAiPm = z.infer<typeof projectAiPmSchema>;

export const provisionProjectAiPmInputSchema = z
  .object({
    runtimeProfileId: z.string().trim().min(1).max(180).optional(),
  })
  .strict();
export type ProvisionProjectAiPmInput = z.infer<
  typeof provisionProjectAiPmInputSchema
>;

export const projectAiPmProvisionResultSchema = z.object({
  manager: projectAiPmSchema,
  created: z.boolean(),
  reused: z.boolean(),
});
export type ProjectAiPmProvisionResult = z.infer<
  typeof projectAiPmProvisionResultSchema
>;
