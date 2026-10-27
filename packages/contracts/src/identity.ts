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
  version: z.number().int().positive(),
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

export const loginInputSchema = z.object({
  loginId: z.string().trim().min(1).max(180),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const authenticatedPrincipalSchema = z.object({
  principalId: principalIdSchema,
  accountId: z.string().trim().min(1).max(180),
  sessionId: z.string().uuid(),
  loginId: z.string().trim().min(1).max(180),
  displayName: z.string().trim().min(1).max(160),
  kind: z.literal("human"),
  platformAdministrator: z.boolean(),
  expiresAt: timestampSchema,
});
export type AuthenticatedPrincipal = z.infer<
  typeof authenticatedPrincipalSchema
>;

export const loginResultSchema = authenticatedPrincipalSchema.extend({
  token: z.string().min(32).max(512),
});
export type LoginResult = z.infer<typeof loginResultSchema>;

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export const accountStatusInputSchema = z.object({
  status: z.enum(["active", "disabled"]),
});
export type AccountStatusInput = z.infer<typeof accountStatusInputSchema>;

export const accountStatusResultSchema = z.object({
  accountId: z.string().trim().min(1).max(180),
  principalId: principalIdSchema,
  accountStatus: accountStatusSchema,
  principalStatus: principalStatusSchema,
  sessionsRevoked: z.number().int().nonnegative(),
});
export type AccountStatusResult = z.infer<typeof accountStatusResultSchema>;

export const platformRoleKeySchema = z.enum(["ADMIN", "MEMBER"]);
export type PlatformRoleKey = z.infer<typeof platformRoleKeySchema>;

export const platformRoleDefinitionSchema = z.object({
  key: platformRoleKeySchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  permissions: z.array(z.string().trim().min(1).max(160)).max(20),
  activeGrantCount: z.number().int().nonnegative(),
});
export type PlatformRoleDefinition = z.infer<
  typeof platformRoleDefinitionSchema
>;

export const workspaceRoleKeySchema = z.enum(["ADMIN", "MEMBER"]);
export type WorkspaceRoleKey = z.infer<typeof workspaceRoleKeySchema>;

export const workspaceRoleDefinitionSchema = z.object({
  key: workspaceRoleKeySchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  permissions: z.array(z.string().trim().min(1).max(160)).max(20),
});
export type WorkspaceRoleDefinition = z.infer<
  typeof workspaceRoleDefinitionSchema
>;

export const PLATFORM_ROLE_DEFINITIONS = [
  {
    key: "ADMIN",
    displayName: "平台管理员",
    description: "管理账号、平台 Grant、Workspace 和身份审计",
    permissions: ["platform.access", "platform.manage"],
  },
  {
    key: "MEMBER",
    displayName: "平台成员",
    description: "创建项目并使用被明确授予的 Project 权限",
    permissions: ["platform.access"],
  },
] as const satisfies ReadonlyArray<{
  key: PlatformRoleKey;
  displayName: string;
  description: string;
  permissions: readonly string[];
}>;

export const WORKSPACE_ROLE_DEFINITIONS = [
  {
    key: "ADMIN",
    displayName: "Workspace 管理员",
    description: "管理当前 Workspace 的成员和 Grant",
    permissions: ["read", "manage_members", "manage_roles"],
  },
  {
    key: "MEMBER",
    displayName: "Workspace 成员",
    description: "使用当前 Workspace 中显式授权的资源",
    permissions: ["read"],
  },
] as const satisfies ReadonlyArray<{
  key: WorkspaceRoleKey;
  displayName: string;
  description: string;
  permissions: readonly string[];
}>;

export function platformPermissionsForRole(
  roleKey: PlatformRoleKey,
): readonly string[] {
  return (
    PLATFORM_ROLE_DEFINITIONS.find((role) => role.key === roleKey)
      ?.permissions ?? []
  );
}

export function workspacePermissionsForRole(
  roleKey: WorkspaceRoleKey,
): readonly string[] {
  return (
    WORKSPACE_ROLE_DEFINITIONS.find((role) => role.key === roleKey)
      ?.permissions ?? []
  );
}

export const workspaceStatusSchema = z.enum(["active", "archived"]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const workspaceSchema = z.object({
  id: z.string().trim().min(1).max(180),
  displayName: z.string().trim().min(1).max(160),
  status: workspaceStatusSchema,
  version: z.number().int().positive(),
  createdByPrincipalId: principalIdSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  activeGrantCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const adminCredentialStatusSchema = z.enum([
  "pending",
  "active",
  "disabled",
  "revoked",
  "missing",
]);
export type AdminCredentialStatus = z.infer<typeof adminCredentialStatusSchema>;

export const managedAccountSchema = accountSchema.extend({
  displayName: z.string().trim().min(1).max(160),
  principalKind: principalKindSchema,
  principalStatus: principalStatusSchema,
  principalStatusAuthority: principalStatusAuthoritySchema,
  credentialStatus: adminCredentialStatusSchema,
  credentialExpiresAt: timestampSchema.nullable(),
  lastAuthenticatedAt: timestampSchema.nullable(),
  activeSessionCount: z.number().int().nonnegative(),
});
export type ManagedAccount = z.infer<typeof managedAccountSchema>;

export const managedAccountDetailSchema = managedAccountSchema.extend({
  aliases: z.array(principalAliasSchema),
  platformGrants: z.array(roleGrantSchema),
  workspaceMemberships: z.array(workspaceMemberSchema),
  recentAudit: z.array(identityAuditEventSchema),
});
export type ManagedAccountDetail = z.infer<typeof managedAccountDetailSchema>;

export const accountDirectoryQuerySchema = z.object({
  query: z.string().trim().max(180).optional(),
  status: accountStatusSchema.optional(),
  principalStatus: principalStatusSchema.optional(),
  cursor: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AccountDirectoryQuery = z.infer<typeof accountDirectoryQuerySchema>;

export const accountDirectoryPageSchema = z.object({
  items: z.array(managedAccountSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type AccountDirectoryPage = z.infer<typeof accountDirectoryPageSchema>;

const managedPasswordSchema = z.string().min(8).max(256);
const credentialActivationLifetimeSchema = z.coerce
  .number()
  .int()
  .min(300)
  .max(2_592_000)
  .default(604_800);

export const createManagedAccountInputSchema = z
  .object({
    principalId: principalIdSchema.optional(),
    loginId: z.string().trim().min(1).max(180),
    displayName: z.string().trim().min(1).max(160),
    credential: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("password"),
        password: managedPasswordSchema,
      }),
      z.object({
        mode: z.literal("invitation"),
        expiresInSeconds: credentialActivationLifetimeSchema,
      }),
    ]),
  })
  .strict();
export type CreateManagedAccountInput = z.infer<
  typeof createManagedAccountInputSchema
>;

export const credentialActivationResultSchema = z.object({
  accountId: z.string().trim().min(1).max(180),
  status: z.literal("pending"),
  activationToken: z.string().min(32).max(512),
  expiresAt: timestampSchema,
});
export type CredentialActivationResult = z.infer<
  typeof credentialActivationResultSchema
>;

export const createManagedAccountResultSchema = z.object({
  account: managedAccountSchema,
  activation: credentialActivationResultSchema.nullable(),
});
export type CreateManagedAccountResult = z.infer<
  typeof createManagedAccountResultSchema
>;

export const updateManagedAccountInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    loginId: z.string().trim().min(1).max(180).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (input) => input.displayName !== undefined || input.loginId !== undefined,
    { message: "At least one profile field is required" },
  );
export type UpdateManagedAccountInput = z.infer<
  typeof updateManagedAccountInputSchema
>;

export const issueCredentialActivationInputSchema = z.object({
  expiresInSeconds: credentialActivationLifetimeSchema,
  reason: z.string().trim().min(1).max(240).default("administrator_reset"),
});
export type IssueCredentialActivationInput = z.infer<
  typeof issueCredentialActivationInputSchema
>;

export const acceptCredentialActivationInputSchema = z.object({
  token: z.string().min(32).max(512),
  password: managedPasswordSchema,
});
export type AcceptCredentialActivationInput = z.infer<
  typeof acceptCredentialActivationInputSchema
>;

export const platformGrantQuerySchema = z.object({
  principalId: principalIdSchema.optional(),
  status: roleGrantStatusSchema.optional(),
  cursor: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PlatformGrantQuery = z.infer<typeof platformGrantQuerySchema>;

export const platformGrantPageSchema = z.object({
  items: z.array(roleGrantSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type PlatformGrantPage = z.infer<typeof platformGrantPageSchema>;

export const createPlatformGrantInputSchema = z
  .object({
    principalId: principalIdSchema,
    roleKey: platformRoleKeySchema,
    expiresAt: timestampSchema.nullable().default(null),
  })
  .strict();
export type CreatePlatformGrantInput = z.infer<
  typeof createPlatformGrantInputSchema
>;

export const updateGrantExpiryInputSchema = z.object({
  expiresAt: timestampSchema.nullable(),
  expectedVersion: z.number().int().positive(),
});
export type UpdateGrantExpiryInput = z.infer<
  typeof updateGrantExpiryInputSchema
>;

export const revokeGrantInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).default("administrator_revoke"),
});
export type RevokeGrantInput = z.infer<typeof revokeGrantInputSchema>;

export const workspaceListQuerySchema = z.object({
  query: z.string().trim().max(180).optional(),
  status: workspaceStatusSchema.optional(),
  includeArchived: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});
export type WorkspaceListQuery = z.infer<typeof workspaceListQuerySchema>;

export const createWorkspaceInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
    .optional(),
  displayName: z.string().trim().min(1).max(160),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const updateWorkspaceInputSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  status: workspaceStatusSchema.optional(),
  expectedVersion: z.number().int().positive(),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;

export const workspaceMemberDetailSchema = workspaceMemberSchema.extend({
  displayName: z.string().trim().min(1).max(160),
  principalKind: principalKindSchema,
  principalStatus: principalStatusSchema,
  grants: z.array(roleGrantSchema),
});
export type WorkspaceMemberDetail = z.infer<typeof workspaceMemberDetailSchema>;

export const workspaceDetailSchema = z.object({
  workspace: workspaceSchema,
  members: z.array(workspaceMemberDetailSchema),
  grants: z.array(roleGrantSchema),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const addWorkspaceMemberInputSchema = z.object({
  principalId: principalIdSchema,
});
export type AddWorkspaceMemberInput = z.infer<
  typeof addWorkspaceMemberInputSchema
>;

export const updateWorkspaceMemberStatusInputSchema = z.object({
  status: workspaceMemberStatusSchema,
  expectedVersion: z.number().int().positive(),
});
export type UpdateWorkspaceMemberStatusInput = z.infer<
  typeof updateWorkspaceMemberStatusInputSchema
>;

export const createWorkspaceGrantInputSchema = z.object({
  principalId: principalIdSchema,
  roleKey: workspaceRoleKeySchema,
  expiresAt: timestampSchema.nullable().default(null),
});
export type CreateWorkspaceGrantInput = z.infer<
  typeof createWorkspaceGrantInputSchema
>;

export const identityAuditQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(180).optional(),
  subjectPrincipalId: principalIdSchema.optional(),
  actorPrincipalId: principalIdSchema.optional(),
  action: z.string().trim().min(1).max(160).optional(),
  decision: identityAuditDecisionSchema.optional(),
  cursor: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type IdentityAuditQuery = z.infer<typeof identityAuditQuerySchema>;

export const identityAuditPageSchema = z.object({
  items: z.array(identityAuditEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type IdentityAuditPage = z.infer<typeof identityAuditPageSchema>;
