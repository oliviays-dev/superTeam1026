import { z } from "zod";

export const isoTimeSchema = z.string().datetime({ precision: 3 });
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const idSchema = z.string().trim().regex(idPattern);
export const shortTextSchema = z.string().trim().min(1).max(120);
const actionSchema = z.string().trim().min(1).max(120);
const actionListSchema = z.array(actionSchema).max(100).default([]);

export const EMPLOYEE_KINDS = ["human", "digital"] as const;
export const LOGIN_STATUSES = ["active", "disabled"] as const;
export const EMPLOYEE_STATUSES = [
  "draft",
  "active",
  "suspended",
  "archived",
] as const;
export const WORKSPACE_ROLES = ["viewer", "member", "owner"] as const;
export const PROFILE_STATUSES = ["active", "disabled"] as const;
export const CONTEXT_TYPES = ["meeting", "workflow", "task", "review"] as const;
export const PRINCIPAL_SOURCES = ["direct", "delegation", "runtime"] as const;
export const DELEGATION_CONTEXTS = ["meeting", "task", "review"] as const;
export const DELEGATION_STATUSES = [
  "active",
  "paused",
  "revoked",
  "expired",
  "completed",
] as const;
export const SPEAK_POLICIES = ["silent", "manual", "mentions", "all"] as const;
export const APPROVAL_POLICIES = ["never", "suggest", "explicit-only"] as const;
export const REPORT_STATUSES = ["generated", "failed"] as const;

export const employeeKindSchema = z.enum(EMPLOYEE_KINDS);
export const loginStatusSchema = z.enum(LOGIN_STATUSES);
export const employeeStatusSchema = z.enum(EMPLOYEE_STATUSES);
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export const profileStatusSchema = z.enum(PROFILE_STATUSES);
export const contextTypeSchema = z.enum(CONTEXT_TYPES);
export const principalSourceSchema = z.enum(PRINCIPAL_SOURCES);
export const delegationContextSchema = z.enum(DELEGATION_CONTEXTS);
export const delegationStatusSchema = z.enum(DELEGATION_STATUSES);
export const speakPolicySchema = z.enum(SPEAK_POLICIES);
export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);
export const reportStatusSchema = z.enum(REPORT_STATUSES);

export const employeeSchema = z.object({
  id: idSchema,
  kind: employeeKindSchema,
  displayName: shortTextSchema,
  email: z.string().email().max(160).optional(),
  department: z.string().trim().max(120).default(""),
  title: z.string().trim().max(120).default(""),
  tags: z.array(z.string().trim().min(1).max(32)).max(16).default([]),
  personaId: idSchema.optional(),
  authUserId: idSchema.optional(),
  /** 人类员工登录状态的只读投影；认证事实仍由 collab_team.users 拥有。 */
  authStatus: loginStatusSchema.optional(),
  managerEmployeeId: idSchema.optional(),
  status: employeeStatusSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  createdBy: z.string().min(1).max(160),
});

export const roleAssignmentSchema = z.object({
  id: idSchema,
  employeeId: idSchema,
  principalId: z.string().trim().min(1).max(180).optional(),
  workspaceId: idSchema,
  role: workspaceRoleSchema,
  permissions: actionListSchema,
  status: z.enum(["active", "revoked"]).default("active"),
  expiresAt: isoTimeSchema.optional(),
  grantedBy: z.string().min(1).max(160),
  grantedByUserId: idSchema.optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  revokedAt: isoTimeSchema.optional(),
});

export const runtimeProfileSchema = z.object({
  id: idSchema,
  employeeId: idSchema,
  principalId: z.string().trim().min(1).max(180).optional(),
  workspaceId: idSchema,
  name: shortTextSchema,
  provider: z.string().trim().min(1).max(80).default("spawn"),
  model: z.string().trim().max(160).default(""),
  reasoningEffort: z.string().trim().max(40).default(""),
  allowedTools: actionListSchema,
  deniedTools: actionListSchema,
  resourceScopes: actionListSchema,
  budget: z
    .object({
      maxTurns: z.number().int().min(1).max(1_000).default(50),
      maxMinutes: z.number().int().min(1).max(1_440).default(30),
    })
    .default({ maxTurns: 50, maxMinutes: 30 }),
  status: profileStatusSchema,
  legacyAgentProfileId: idSchema.optional(),
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const employeePrincipalSchema = z.object({
  employeeId: idSchema,
  principalId: z.string().trim().min(1).max(180).optional(),
  employeeKind: employeeKindSchema,
  authUserId: idSchema.optional(),
  source: principalSourceSchema,
  delegationId: idSchema.optional(),
  runId: idSchema.optional(),
  workspaceId: idSchema,
});

export const actionTicketSchema = z.object({
  id: idSchema,
  principal: employeePrincipalSchema,
  ownerId: idSchema.optional(),
  workspaceId: idSchema,
  contextType: contextTypeSchema,
  contextId: idSchema,
  allowedActions: actionListSchema,
  deniedActions: actionListSchema,
  resourceScopes: actionListSchema,
  status: z.enum(["active", "revoked", "expired"]).default("active"),
  expiresAt: isoTimeSchema,
  createdAt: isoTimeSchema,
  issuedBy: z.string().min(1).max(160),
});

export const delegationSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  ownerPrincipalId: z.string().trim().min(1).max(180).optional(),
  ownerAuthUserId: idSchema,
  ownerName: shortTextSchema,
  displayName: shortTextSchema,
  personaId: idSchema.optional(),
  /** 委托来源的 AI Teammate（会议/任务派遣时写入，用于与 AI Teammates 对齐）。 */
  teammateId: idSchema.optional(),
  teammateName: shortTextSchema.optional(),
  workspaceId: idSchema,
  contextType: delegationContextSchema,
  contextId: idSchema,
  objective: z.string().trim().min(1).max(4_000),
  stance: z.string().trim().max(4_000).default(""),
  watchItems: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  materialScopes: actionListSchema,
  allowedActions: actionListSchema,
  deniedActions: actionListSchema,
  speakPolicy: speakPolicySchema,
  approvalPolicy: approvalPolicySchema,
  status: delegationStatusSchema,
  expiresAt: isoTimeSchema.optional(),
  participantId: idSchema.optional(),
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const delegationReportSchema = z.object({
  id: idSchema,
  delegationId: idSchema,
  workspaceId: idSchema,
  contextType: delegationContextSchema,
  contextId: idSchema,
  status: reportStatusSchema,
  report: z.string().max(60_000).default(""),
  error: z.string().max(1_000).optional(),
  transcriptDigest: z.string().max(180).default(""),
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
});

export const auditEventSchema = z.object({
  id: idSchema,
  at: isoTimeSchema,
  actorEmployeeId: idSchema,
  actorPrincipalId: z.string().trim().min(1).max(180).optional(),
  actorAuthUserId: idSchema.optional(),
  actorRole: z.string().min(1).max(40),
  workspaceId: idSchema.optional(),
  contextType: contextTypeSchema.optional(),
  contextId: idSchema.optional(),
  delegationId: idSchema.optional(),
  runId: idSchema.optional(),
  ticketId: idSchema.optional(),
  action: z.string().trim().min(1).max(120),
  decision: z.enum(["allowed", "denied"]),
  reason: z.string().trim().max(500).default(""),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

export type EmployeeKind = z.infer<typeof employeeKindSchema>;
export type LoginStatus = z.infer<typeof loginStatusSchema>;
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type ContextType = z.infer<typeof contextTypeSchema>;
export type PrincipalSource = z.infer<typeof principalSourceSchema>;
export type EmployeePrincipal = z.infer<typeof employeePrincipalSchema>;
export type ActionTicket = z.infer<typeof actionTicketSchema>;
export type DelegationContext = z.infer<typeof delegationContextSchema>;
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationReport = z.infer<typeof delegationReportSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
