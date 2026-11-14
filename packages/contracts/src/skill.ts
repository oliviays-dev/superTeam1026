import { z } from "zod";

const idSchema = z.string().trim().min(1).max(180);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const isoTimeSchema = z.string().datetime({ offset: true });

export const SKILLS_PLATFORM_FLAG = "skills.platform";

export const skillTrustLevelSchema = z.enum([
  "official",
  "verified",
  "private",
]);
export type SkillTrustLevel = z.infer<typeof skillTrustLevelSchema>;

export const skillDefinitionStatusSchema = z.enum([
  "active",
  "disabled",
  "archived",
]);
export type SkillDefinitionStatus = z.infer<
  typeof skillDefinitionStatusSchema
>;

export const skillVersionStatusSchema = z.enum([
  "published",
  "deprecated",
  "revoked",
]);
export type SkillVersionStatus = z.infer<typeof skillVersionStatusSchema>;

export const skillSourceSchema = z.enum([
  "required_template",
  "default_template",
  "instance_extension",
]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillVersionContentSchema = z.object({
  trustLevel: skillTrustLevelSchema,
  instructions: z.string().trim().min(1).max(200_000),
  manifest: z
    .record(z.string(), z.unknown())
    .default({})
    .refine(
      (value) => canonicalSkillJson(value).length <= 200_000,
      "Skill manifest is too large",
    ),
  permissions: z
    .array(z.string().trim().min(1).max(120))
    .max(50)
    .default([]),
  triggers: z
    .array(z.string().trim().min(1).max(500))
    .max(50)
    .default([]),
  status: skillVersionStatusSchema.default("published"),
  protected: z.boolean().default(false),
});
export type SkillVersionContent = z.input<typeof skillVersionContentSchema>;
export type SkillVersionContentValue = z.output<
  typeof skillVersionContentSchema
>;

export const skillDefinitionSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  status: skillDefinitionStatusSchema,
  currentVersion: z.number().int().positive(),
  createdByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

export const skillVersionSchema = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
  version: z.number().int().positive(),
  digest: digestSchema,
  publisherPrincipalId: idSchema,
  trustLevel: skillTrustLevelSchema,
  instructions: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  permissions: z.array(z.string()),
  triggers: z.array(z.string()),
  status: skillVersionStatusSchema,
  protected: z.boolean(),
  createdAt: isoTimeSchema,
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillDetailSchema = z.object({
  definition: skillDefinitionSchema,
  versions: z.array(skillVersionSchema),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const createSkillDefinitionInputSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).default(""),
  content: skillVersionContentSchema,
});
export type CreateSkillDefinitionInput = z.input<
  typeof createSkillDefinitionInputSchema
>;

export const createSkillVersionInputSchema = z.object({
  expectedCurrentVersion: z.number().int().positive(),
  content: skillVersionContentSchema,
});
export type CreateSkillVersionInput = z.input<
  typeof createSkillVersionInputSchema
>;

export const skillInstallationSchema = z.object({
  id: z.string().uuid(),
  principalId: idSchema,
  skillId: z.string().uuid(),
  versionId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
  revision: z.number().int().positive(),
  installedByPrincipalId: idSchema,
  installedAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type SkillInstallation = z.infer<typeof skillInstallationSchema>;

export const installSkillInputSchema = z.object({
  skillId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export type InstallSkillInput = z.infer<typeof installSkillInputSchema>;

export const teammateTemplateSkillBindingSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  skillId: z.string().uuid(),
  skillVersionId: z.string().uuid(),
  installationId: z.string().uuid(),
  required: z.boolean(),
  enabled: z.boolean(),
  boundByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type TeammateTemplateSkillBinding = z.infer<
  typeof teammateTemplateSkillBindingSchema
>;

export const bindTemplateSkillInputSchema = z.object({
  skillId: z.string().uuid(),
  versionId: z.string().uuid(),
  required: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type BindTemplateSkillInput = z.input<
  typeof bindTemplateSkillInputSchema
>;

export const teammateInstanceSkillExtensionSchema = z.object({
  id: z.string().uuid(),
  teammateId: z.string().uuid(),
  skillId: z.string().uuid(),
  skillVersionId: z.string().uuid(),
  installationId: z.string().uuid(),
  enabled: z.boolean(),
  addedByPrincipalId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});
export type TeammateInstanceSkillExtension = z.infer<
  typeof teammateInstanceSkillExtensionSchema
>;

export const addInstanceSkillExtensionInputSchema = z.object({
  skillId: z.string().uuid(),
  versionId: z.string().uuid(),
  enabled: z.boolean().default(true),
});
export type AddInstanceSkillExtensionInput = z.input<
  typeof addInstanceSkillExtensionInputSchema
>;

export const platformSkillSafetyRuleSchema = z.object({
  code: z.enum([
    "skill.no_secret",
    "skill.no_authorization",
    "skill.append_only",
  ]),
  description: z.string(),
});
export type PlatformSkillSafetyRule = z.infer<
  typeof platformSkillSafetyRuleSchema
>;

export const PLATFORM_SKILL_SAFETY_RULES: readonly PlatformSkillSafetyRule[] = [
  {
    code: "skill.no_secret",
    description:
      "Skills must not carry credentials, tokens, private keys, or secret values.",
  },
  {
    code: "skill.no_authorization",
    description:
      "Skills do not grant project, data, or tool authorization; runtime permissions remain authoritative.",
  },
  {
    code: "skill.append_only",
    description:
      "Instance extensions may append skills only and cannot replace required template or platform rules.",
  },
];

export const effectiveSkillSchema = z.object({
  skillId: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  versionId: z.string().uuid(),
  version: z.number().int().positive(),
  digest: digestSchema,
  publisherPrincipalId: idSchema,
  trustLevel: skillTrustLevelSchema,
  instructions: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  permissions: z.array(z.string()),
  triggers: z.array(z.string()),
  status: skillVersionStatusSchema,
  protected: z.boolean(),
  source: skillSourceSchema,
  grantsAuthorization: z.literal(false),
});
export type EffectiveSkill = z.infer<typeof effectiveSkillSchema>;

export const effectiveSkillsProjectionSchema = z.object({
  teammateId: z.string().uuid(),
  templateId: z.string().uuid(),
  templateVersionId: z.string().uuid(),
  platformSafetyRules: z.array(platformSkillSafetyRuleSchema),
  skills: z.array(effectiveSkillSchema),
  bindings: z.array(teammateTemplateSkillBindingSchema),
  extensions: z.array(teammateInstanceSkillExtensionSchema),
});
export type EffectiveSkillsProjection = z.infer<
  typeof effectiveSkillsProjectionSchema
>;

export const runSkillSnapshotSchema = z.object({
  runId: z.string().uuid(),
  teammateId: z.string().uuid().nullable(),
  templateId: z.string().uuid().nullable(),
  templateVersionId: z.string().uuid().nullable(),
  platformSafetyRules: z.array(platformSkillSafetyRuleSchema),
  skills: z.array(effectiveSkillSchema),
  snapshotDigest: digestSchema,
  capturedAt: isoTimeSchema,
});
export type RunSkillSnapshot = z.infer<typeof runSkillSnapshotSchema>;

export const skillAuditEventSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int().positive(),
  resourceType: z.enum(["skill", "template", "teammate", "run"]),
  resourceId: idSchema,
  kind: z.enum([
    "skill.definition.created",
    "skill.version.published",
    "skill.installed",
    "skill.uninstalled",
    "skills.bound",
    "skills.unbound",
    "skills.extension.added",
    "skills.extension.removed",
    "run.skills.snapshot",
  ]),
  actorPrincipalId: idSchema,
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoTimeSchema,
});
export type SkillAuditEvent = z.infer<typeof skillAuditEventSchema>;

export function canonicalSkillJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSkillJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalSkillJson(item)}`,
    )
    .join(",")}}`;
}

export function skillVersionDigestPayload(input: {
  readonly skillId: string;
  readonly version: number;
  readonly publisherPrincipalId: string;
  readonly trustLevel: SkillTrustLevel;
  readonly instructions: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly permissions: readonly string[];
  readonly triggers: readonly string[];
  readonly status: SkillVersionStatus;
  readonly protected: boolean;
}): string {
  return canonicalSkillJson({
    skillId: input.skillId,
    version: input.version,
    publisherPrincipalId: input.publisherPrincipalId,
    trustLevel: input.trustLevel,
    instructions: input.instructions,
    manifest: input.manifest,
    permissions: input.permissions,
    triggers: input.triggers,
    status: input.status,
    protected: input.protected,
  });
}
