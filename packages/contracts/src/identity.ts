import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });

export const principalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export type PrincipalId = z.infer<typeof principalIdSchema>;

export const principalKindSchema = z.enum(["human", "ai"]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

export const principalStatusSchema = z.enum([
  "active",
  "suspended",
  "archived",
]);
export type PrincipalStatus = z.infer<typeof principalStatusSchema>;

export const principalStatusAuthoritySchema = z.enum([
  "account",
  "ai-companion",
  "hrm",
  "legacy",
  "system",
]);
export type PrincipalStatusAuthority = z.infer<
  typeof principalStatusAuthoritySchema
>;

export const principalSourceSchema = z.enum([
  "local",
  "account",
  "ai-companion",
  "agent",
  "hrm",
  "system",
]);
export type PrincipalSource = z.infer<typeof principalSourceSchema>;

export const principalSchema = z.object({
  id: principalIdSchema,
  kind: principalKindSchema,
  displayName: z.string().trim().min(1).max(160),
  status: principalStatusSchema,
  statusAuthority: principalStatusAuthoritySchema,
  source: principalSourceSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Principal = z.infer<typeof principalSchema>;

export const principalReferenceSchema = z
  .string()
  .trim()
  .max(190)
  .regex(/^principal:[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export type PrincipalReference = z.infer<typeof principalReferenceSchema>;

export function principalReference(principalId: PrincipalId): string {
  return `principal:${principalIdSchema.parse(principalId)}`;
}

export function parsePrincipalReference(
  reference: string,
): PrincipalId | undefined {
  const match = /^principal:(.+)$/.exec(reference.trim());
  if (match?.[1] === undefined) return undefined;
  const parsed = principalIdSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
}

export const accountStatusSchema = z.enum(["active", "pending", "disabled"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const accountSchema = z.object({
  id: z.string().trim().min(1).max(180),
  principalId: principalIdSchema,
  loginId: z.string().trim().min(1).max(180),
  status: accountStatusSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Account = z.infer<typeof accountSchema>;

export const credentialTypeSchema = z.enum(["password", "sso"]);
export type CredentialType = z.infer<typeof credentialTypeSchema>;

export const credentialStatusSchema = z.enum([
  "pending",
  "active",
  "disabled",
  "revoked",
]);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const accountCredentialSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().trim().min(1).max(180),
  type: credentialTypeSchema,
  status: credentialStatusSchema,
  expiresAt: timestampSchema.nullable(),
  lastAuthenticatedAt: timestampSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type AccountCredential = z.infer<typeof accountCredentialSchema>;

export const sessionStatusSchema = z.enum(["active", "expired", "revoked"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const bearerSessionSchema = z.object({
  id: z.string().uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: z.string().trim().min(1).max(180),
  principalId: principalIdSchema,
  status: sessionStatusSchema,
  expiresAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
  lastSeenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type BearerSession = z.infer<typeof bearerSessionSchema>;

export const workspaceMemberStatusSchema = z.enum(["active", "inactive"]);
export type WorkspaceMemberStatus = z.infer<typeof workspaceMemberStatusSchema>;

export const workspaceMemberSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  principalId: principalIdSchema,
  status: workspaceMemberStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const externalIdentityLinkStatusSchema = z.enum(["active", "retired"]);
export type ExternalIdentityLinkStatus = z.infer<
  typeof externalIdentityLinkStatusSchema
>;

export const externalIdentityLinkSchema = z.object({
  id: z.string().uuid(),
  principalId: principalIdSchema,
  provider: z.string().trim().min(1).max(80),
  externalSubjectId: z.string().trim().min(1).max(240),
  status: externalIdentityLinkStatusSchema,
  syncVersion: z.string().trim().min(1).max(120),
  syncedAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ExternalIdentityLink = z.infer<typeof externalIdentityLinkSchema>;

export const principalAliasTypeSchema = z.enum([
  "auth-user",
  "employee",
  "teammate",
  "agent",
  "runtime-profile",
  "legacy-actor",
  "external",
]);
export type PrincipalAliasType = z.infer<typeof principalAliasTypeSchema>;

export const principalAliasStatusSchema = z.enum(["active", "retired"]);
export type PrincipalAliasStatus = z.infer<typeof principalAliasStatusSchema>;

export const principalAliasSchema = z.object({
  id: z.string().uuid(),
  principalId: principalIdSchema,
  type: principalAliasTypeSchema,
  value: z.string().trim().min(1).max(240),
  status: principalAliasStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type PrincipalAlias = z.infer<typeof principalAliasSchema>;

export const grantScopeTypeSchema = z.enum([
  "platform",
  "workspace",
  "project",
]);
export type GrantScopeType = z.infer<typeof grantScopeTypeSchema>;

export const roleGrantStatusSchema = z.enum(["active", "revoked", "expired"]);
export type RoleGrantStatus = z.infer<typeof roleGrantStatusSchema>;

export const roleGrantSourceKindSchema = z.enum([
  "manual",
  "platform-role",
  "workspace-role",
  "project-role",
  "employee-role",
  "template",
]);
export type RoleGrantSourceKind = z.infer<typeof roleGrantSourceKindSchema>;

const roleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const permissionSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);

export const roleGrantSchema = z
  .object({
    id: z.string().uuid(),
    principalId: principalIdSchema,
    scopeType: grantScopeTypeSchema,
    scopeId: z.string().trim().min(1).max(180),
    roleKey: roleKeySchema,
    permissions: z
      .array(permissionSchema)
      .max(100)
      .default([])
      .transform((items) => [...new Set(items)]),
    status: roleGrantStatusSchema,
    sourceKind: roleGrantSourceKindSchema,
    sourceRef: z.string().trim().min(1).max(240).nullable(),
    grantedByPrincipalId: principalIdSchema.nullable(),
    revokedByPrincipalId: principalIdSchema.nullable(),
    grantedAt: timestampSchema,
    expiresAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((grant, context) => {
    if (grant.scopeType === "platform" && grant.scopeId !== "platform") {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "platform grants must use the platform scope id",
      });
    }
    if (grant.status === "revoked" && grant.revokedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revoked grants require revokedAt",
      });
    }
    if (
      grant.expiresAt !== null &&
      Date.parse(grant.expiresAt) <= Date.parse(grant.grantedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be later than grantedAt",
      });
    }
  });
export type RoleGrant = z.infer<typeof roleGrantSchema>;

export const identityAuditDecisionSchema = z.enum(["allowed", "denied"]);
export type IdentityAuditDecision = z.infer<typeof identityAuditDecisionSchema>;

export const identityAuditEventSchema = z.object({
  id: z.string().uuid(),
  action: z.string().trim().min(1).max(160),
  decision: identityAuditDecisionSchema,
  actorPrincipalId: principalIdSchema.nullable(),
  subjectPrincipalId: principalIdSchema.nullable(),
  accountId: z.string().trim().min(1).max(180).nullable(),
  sessionId: z.string().uuid().nullable(),
  grantId: z.string().uuid().nullable(),
  reason: z.string().trim().max(1_000),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
});
export type IdentityAuditEvent = z.infer<typeof identityAuditEventSchema>;

export const humanAccessDenialReasonSchema = z.enum([
  "principal_inactive",
  "account_inactive",
  "credential_inactive",
  "session_inactive",
]);
export type HumanAccessDenialReason = z.infer<
  typeof humanAccessDenialReasonSchema
>;

export interface HumanSessionAccessInput {
  readonly principalStatus: PrincipalStatus;
  readonly accountStatus: AccountStatus;
  readonly credentialStatus: CredentialStatus;
  readonly sessionStatus: SessionStatus;
  readonly sessionExpiresAt: string;
}

export function evaluateHumanSessionAccess(
  input: HumanSessionAccessInput,
  now: Date = new Date(),
):
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: HumanAccessDenialReason;
    } {
  if (input.principalStatus !== "active") {
    return { allowed: false, reason: "principal_inactive" };
  }
  if (input.accountStatus !== "active") {
    return { allowed: false, reason: "account_inactive" };
  }
  if (input.credentialStatus !== "active") {
    return { allowed: false, reason: "credential_inactive" };
  }
  if (
    input.sessionStatus !== "active" ||
    Date.parse(input.sessionExpiresAt) <= now.getTime()
  ) {
    return { allowed: false, reason: "session_inactive" };
  }
  return { allowed: true };
}

export function principalKindCanOwnAccount(kind: PrincipalKind): boolean {
  return kind === "human";
}
