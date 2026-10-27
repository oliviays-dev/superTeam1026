import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { ProjectCapability, ProjectRole } from "@pluginmax/contracts";
import type { Database } from "./database.js";

export const AUTHORIZATION_PERMISSIONS = [
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
  "platform.access",
  "platform.manage",
] as const;

const PROJECT_OWNER_PERMISSIONS = [
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
] as const;

export type AuthorizationPermission =
  (typeof AUTHORIZATION_PERMISSIONS)[number];
export type ScopedAuthorizationPermission = Exclude<
  AuthorizationPermission,
  "platform.access" | "platform.manage"
>;

export type AuthorizationDenialReason =
  | "principal_not_found"
  | "principal_not_active"
  | "account_not_active"
  | "workspace_membership_missing"
  | "workspace_membership_inactive"
  | "project_not_found"
  | "project_archived"
  | "membership_missing"
  | "membership_inactive"
  | "membership_ambiguous"
  | "grant_missing"
  | "permission_missing"
  | "principal_reference_ambiguous"
  | "principal_kind_mismatch";

export interface AuthorizationPrincipal {
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly displayName: string;
  readonly status: "active" | "suspended" | "archived";
  readonly statusAuthority:
    "account" | "ai-companion" | "hrm" | "legacy" | "system";
  readonly source:
    "local" | "account" | "ai-companion" | "agent" | "hrm" | "system";
  readonly accountId: string | null;
  readonly accountStatus: "active" | "pending" | "disabled" | null;
}

export interface ProjectOwnerSourceReport {
  readonly legacy: boolean;
  readonly grant: boolean;
  readonly consistent: boolean;
}

export interface ScopeAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: AuthorizationDenialReason;
  readonly principal: AuthorizationPrincipal | null;
  readonly scopeType: "platform" | "workspace" | "project";
  readonly scopeId: string;
  readonly permission: AuthorizationPermission;
  readonly grantIds: readonly string[];
  readonly effectivePermissions: readonly string[];
  readonly membershipId?: string;
  readonly membershipStatus?: "active" | "inactive";
  readonly ownerSources?: ProjectOwnerSourceReport;
  readonly grantSource: "grant" | "legacy-owner" | "legacy-role" | "none";
}

export interface PrincipalResolution {
  readonly principal: AuthorizationPrincipal;
  readonly aliases: readonly {
    readonly type: string;
    readonly value: string;
  }[];
  readonly resolvedBy:
    | "principal"
    | "auth-user"
    | "employee"
    | "teammate"
    | "agent"
    | "legacy-actor"
    | "external";
}

export interface AuthorizationAuditInput {
  readonly action: string;
  readonly decision: "allowed" | "denied";
  readonly actorPrincipalId?: string | null;
  readonly subjectPrincipalId?: string | null;
  readonly accountId?: string | null;
  readonly sessionId?: string | null;
  readonly grantId?: string | null;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProjectMemberAuthorizationReport {
  readonly memberId: string;
  readonly actorId: string;
  readonly kind: "human" | "agent";
  readonly principalId: string | null;
  readonly status: "active" | "inactive";
  readonly roleIds: readonly string[];
  readonly grantIds: readonly string[];
  readonly permissions: readonly string[];
  readonly owner: ProjectOwnerSourceReport;
}

export interface ProjectAuthorizationReport {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly consistent: boolean;
  readonly ownerPrincipalIds: {
    readonly legacy: readonly string[];
    readonly grant: readonly string[];
  };
  readonly members: readonly ProjectMemberAuthorizationReport[];
}

export interface ProjectCapabilityDecision {
  readonly allowed: boolean;
  readonly reason?: AuthorizationDenialReason;
  readonly principal: AuthorizationPrincipal | null;
  readonly capability?: ProjectCapability;
}

export type AuthorizationResourceType =
  | "task"
  | "run"
  | "workflow"
  | "workflow-instance"
  | "meeting"
  | "task-attachment"
  | "artifact"
  | "trace"
  | "memory-topic"
  | "memory-claim"
  | "report"
  | "handoff"
  | "agent-episode"
  | "meeting-action-item"
  | "execution-gate";

export class AuthorizationRepositoryError extends Error {
  constructor(
    readonly code:
      | "principal_not_found"
      | "principal_reference_ambiguous"
      | "principal_kind_mismatch"
      | "principal_not_active"
      | "project_owner_conflict",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationRepositoryError";
  }
}

interface PrincipalRow {
  id: string;
  kind: "human" | "ai";
  display_name: string;
  status: "active" | "suspended" | "archived";
  status_authority: "account" | "ai-companion" | "hrm" | "legacy" | "system";
  source: "local" | "account" | "ai-companion" | "agent" | "hrm" | "system";
  account_id: string | null;
  account_status: "active" | "pending" | "disabled" | null;
}

interface AliasRow {
  alias_type: string;
  alias_value: string;
  principal_id: string;
}

interface AliasView {
  readonly type: string;
  readonly value: string;
}

interface ProjectMemberAuthorizationRow {
  id: string;
  project_id: string;
  kind: "human" | "agent";
  actor_id: string;
  principal_id: string | null;
  status: "active" | "inactive";
  is_owner: boolean;
}

interface ProjectGrantRow {
  id: string;
  principal_id: string;
  role_key: string;
  permissions: string[];
  source_ref: string | null;
  status: "active" | "revoked" | "expired";
}

interface ProjectMemberRolePermissionRow {
  project_member_id: string;
  role_id: string;
  permissions: ProjectRole["permissions"];
}

interface ProjectAccessEvaluation {
  readonly principal: AuthorizationPrincipal | null;
  readonly reason?: AuthorizationDenialReason;
  readonly projectStatus?: "active" | "archived";
  readonly member?: ProjectMemberAuthorizationRow;
  readonly grants: readonly ProjectGrantRow[];
  readonly effectivePermissions: readonly ScopedAuthorizationPermission[];
  readonly grantSource: ScopeAuthorizationDecision["grantSource"];
  readonly ownerSources?: ProjectOwnerSourceReport;
}

interface QueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: T[];
    readonly rowCount: number | null;
  }>;
}

function principalFromRow(row: PrincipalRow): AuthorizationPrincipal {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    status: row.status,
    statusAuthority: row.status_authority,
    source: row.source,
    accountId: row.account_id,
    accountStatus: row.account_status,
  };
}

function normalizedReference(reference: string): {
  readonly value: string;
  readonly prefix?: string;
} {
  const value = reference.trim();
  const separator = value.indexOf(":");
  if (separator <= 0) return { value };
  return {
    prefix: value.slice(0, separator),
    value: value.slice(separator + 1),
  };
}

const PREFIX_TO_ALIAS = new Map([
  ["auth-user", "auth-user"],
  ["user", "auth-user"],
  ["employee", "employee"],
  ["teammate", "teammate"],
  ["agent", "agent"],
  ["legacy-actor", "legacy-actor"],
  ["external", "external"],
] as const);

const BARE_ALIAS_PRIORITY = [
  "auth-user",
  "legacy-actor",
  "employee",
  "teammate",
  "agent",
  "external",
] as const;

export class AuthorizationRepository {
  constructor(
    private readonly database: Database,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async principalByExactId(
    executor: QueryExecutor,
    principalId: string,
  ): Promise<AuthorizationPrincipal | undefined> {
    const result = await executor.query<PrincipalRow>(
      `SELECT
         p.id, p.kind, p.display_name, p.status, p.status_authority, p.source,
         a.id AS account_id, a.status AS account_status
       FROM principals AS p
       LEFT JOIN accounts AS a ON a.principal_id = p.id
       WHERE p.id = $1
       LIMIT 1`,
      [principalId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : principalFromRow(row);
  }

  async getPrincipal(
    principalId: string,
  ): Promise<AuthorizationPrincipal | undefined> {
    return this.principalByExactId(this.database, principalId);
  }

  private async aliasesForPrincipal(
    executor: QueryExecutor,
    principalId: string,
  ): Promise<AliasView[]> {
    const result = await executor.query<AliasRow>(
      `SELECT alias_type, alias_value, principal_id
       FROM principal_aliases
       WHERE principal_id = $1 AND status = 'active'
       ORDER BY alias_type, alias_value`,
      [principalId],
    );
    return result.rows.map((row) => ({
      type: row.alias_type,
      value: row.alias_value,
    }));
  }

  async resolvePrincipalReference(
    reference: string,
  ): Promise<PrincipalResolution | undefined> {
    const parsed = normalizedReference(reference);
    if (parsed.value === "") return undefined;

    if (parsed.prefix === "principal") {
      const principal = await this.principalByExactId(
        this.database,
        parsed.value,
      );
      if (principal === undefined) return undefined;
      return {
        principal,
        aliases: await this.aliasesForPrincipal(this.database, principal.id),
        resolvedBy: "principal",
      };
    }

    if (parsed.prefix !== undefined) {
      const aliasType = PREFIX_TO_ALIAS.get(
        parsed.prefix as Parameters<typeof PREFIX_TO_ALIAS.get>[0],
      );
      if (aliasType === undefined) return undefined;
      const aliases = await this.database.query<AliasRow>(
        `SELECT alias_type, alias_value, principal_id
         FROM principal_aliases
         WHERE alias_type = $1 AND alias_value = $2 AND status = 'active'
         LIMIT 2`,
        [aliasType, parsed.value],
      );
      if (aliases.rows.length > 1) {
        throw new AuthorizationRepositoryError(
          "principal_reference_ambiguous",
          "Principal reference resolves to more than one identity",
        );
      }
      const alias = aliases.rows[0];
      if (alias === undefined) return undefined;
      const principal = await this.principalByExactId(
        this.database,
        alias.principal_id,
      );
      if (principal === undefined) return undefined;
      return {
        principal,
        aliases: await this.aliasesForPrincipal(this.database, principal.id),
        resolvedBy: aliasType as Exclude<
          PrincipalResolution["resolvedBy"],
          "principal"
        >,
      };
    }

    const exact = await this.principalByExactId(this.database, parsed.value);
    if (exact !== undefined) {
      return {
        principal: exact,
        aliases: await this.aliasesForPrincipal(this.database, exact.id),
        resolvedBy: "principal",
      };
    }

    const aliases = await this.database.query<AliasRow>(
      `SELECT alias_type, alias_value, principal_id
       FROM principal_aliases
       WHERE alias_value = $1
         AND status = 'active'
         AND alias_type = ANY($2::text[])
       ORDER BY array_position($2::text[], alias_type)`,
      [parsed.value, [...BARE_ALIAS_PRIORITY]],
    );
    const first = aliases.rows[0];
    if (first === undefined) return undefined;
    const principals = new Set(aliases.rows.map((row) => row.principal_id));
    if (principals.size > 1) {
      throw new AuthorizationRepositoryError(
        "principal_reference_ambiguous",
        "Bare actor reference resolves to more than one Principal",
      );
    }
    const principal = await this.principalByExactId(
      this.database,
      first.principal_id,
    );
    if (principal === undefined) return undefined;
    return {
      principal,
      aliases: await this.aliasesForPrincipal(this.database, principal.id),
      resolvedBy: first.alias_type as Exclude<
        PrincipalResolution["resolvedBy"],
        "principal"
      >,
    };
  }

  async requirePrincipal(
    reference: string,
    expectedKind?: "human" | "ai",
  ): Promise<PrincipalResolution> {
    const resolved = await this.resolvePrincipalReference(reference);
    if (resolved === undefined) {
      throw new AuthorizationRepositoryError(
        "principal_not_found",
        `Principal reference ${reference} was not found`,
      );
    }
    if (resolved.principal.status !== "active" && expectedKind !== undefined) {
      throw new AuthorizationRepositoryError(
        "principal_not_active",
        `Principal ${resolved.principal.id} is not active`,
      );
    }
    if (
      expectedKind !== undefined &&
      resolved.principal.kind !== expectedKind
    ) {
      throw new AuthorizationRepositoryError(
        "principal_kind_mismatch",
        `Principal ${resolved.principal.id} is not ${expectedKind}`,
      );
    }
    return resolved;
  }

  private principalDenial(
    principal: AuthorizationPrincipal | null,
    authSource: "bearer" | "local-development",
  ): AuthorizationDenialReason | undefined {
    if (principal === null) return "principal_not_found";
    if (principal.status !== "active") return "principal_not_active";
    if (
      principal.kind === "human" &&
      authSource === "bearer" &&
      principal.accountStatus !== "active"
    ) {
      return "account_not_active";
    }
    return undefined;
  }

  private async activeGrants(
    principalId: string,
    scopeType: "platform" | "workspace" | "project",
    scopeId: string,
  ): Promise<ProjectGrantRow[]> {
    const result = await this.database.query<ProjectGrantRow>(
      `SELECT id, principal_id, role_key, permissions, source_ref, status
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = $2
         AND scope_id = $3
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $4)
       ORDER BY granted_at`,
      [principalId, scopeType, scopeId, this.now()],
    );
    return result.rows;
  }

  async authorizePlatform(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly permission?: AuthorizationPermission;
  }): Promise<ScopeAuthorizationDecision> {
    const permission = input.permission ?? "platform.manage";
    const principal = await this.principalByExactId(
      this.database,
      input.principalId,
    );
    const denial = this.principalDenial(principal ?? null, input.authSource);
    if (denial !== undefined || principal === undefined) {
      return {
        allowed: false,
        reason: denial ?? "principal_not_found",
        principal: principal ?? null,
        scopeType: "platform",
        scopeId: "platform",
        permission,
        grantIds: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    const grants = await this.activeGrants(
      principal.id,
      "platform",
      "platform",
    );
    const admin = grants.find((grant) => grant.role_key === "ADMIN");
    const memberAccess =
      permission === "platform.access"
        ? grants.find(
            (grant) =>
              grant.role_key === "MEMBER" &&
              grant.permissions.includes("platform.access"),
          )
        : undefined;
    const matching = admin ?? memberAccess;
    const effectivePermissions =
      admin === undefined
        ? [...new Set(grants.flatMap((grant) => grant.permissions))]
        : ["platform.access", "platform.manage"];
    return {
      allowed: matching !== undefined,
      ...(matching === undefined
        ? {
            reason:
              grants.length === 0
                ? ("grant_missing" as const)
                : ("permission_missing" as const),
          }
        : {}),
      principal,
      scopeType: "platform",
      scopeId: "platform",
      permission,
      grantIds: matching === undefined ? [] : [matching.id],
      effectivePermissions,
      grantSource: matching === undefined ? "none" : "grant",
    };
  }

  async authorizeWorkspace(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly workspaceId: string;
    readonly permission: ScopedAuthorizationPermission;
  }): Promise<ScopeAuthorizationDecision> {
    const principal = await this.principalByExactId(
      this.database,
      input.principalId,
    );
    const denial = this.principalDenial(principal ?? null, input.authSource);
    if (denial !== undefined || principal === undefined) {
      return {
        allowed: false,
        reason: denial ?? "principal_not_found",
        principal: principal ?? null,
        scopeType: "workspace",
        scopeId: input.workspaceId,
        permission: input.permission,
        grantIds: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    const membership = await this.database.query<{
      id: string;
      status: "active" | "inactive";
    }>(
      `SELECT id, status
       FROM workspace_members
       WHERE workspace_id = $1 AND principal_id = $2
       LIMIT 1`,
      [input.workspaceId, principal.id],
    );
    const member = membership.rows[0];
    if (member === undefined) {
      return {
        allowed: false,
        reason: "workspace_membership_missing",
        principal,
        scopeType: "workspace",
        scopeId: input.workspaceId,
        permission: input.permission,
        grantIds: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    if (member.status !== "active") {
      return {
        allowed: false,
        reason: "workspace_membership_inactive",
        principal,
        scopeType: "workspace",
        scopeId: input.workspaceId,
        permission: input.permission,
        grantIds: [],
        effectivePermissions: [],
        membershipId: member.id,
        membershipStatus: member.status,
        grantSource: "none",
      };
    }
    const grants = await this.activeGrants(
      principal.id,
      "workspace",
      input.workspaceId,
    );
    const matching = grants.filter((grant) =>
      grant.permissions.includes(input.permission),
    );
    return {
      allowed: matching.length > 0,
      ...(matching.length === 0
        ? {
            reason:
              grants.length === 0
                ? ("grant_missing" as const)
                : ("permission_missing" as const),
          }
        : {}),
      principal,
      scopeType: "workspace",
      scopeId: input.workspaceId,
      permission: input.permission,
      grantIds: matching.map((grant) => grant.id),
      effectivePermissions: [
        ...new Set(grants.flatMap((grant) => grant.permissions)),
      ],
      membershipId: member.id,
      membershipStatus: member.status,
      grantSource: matching.length === 0 ? "none" : "grant",
    };
  }

  async projectIdsForResource(
    resourceType: AuthorizationResourceType,
    resourceId: string,
  ): Promise<string[] | undefined> {
    const queries: Record<AuthorizationResourceType, { readonly sql: string }> =
      {
        task: {
          sql: "SELECT project_id FROM tasks WHERE id = $1",
        },
        run: {
          sql: "SELECT project_id FROM runs WHERE id = $1",
        },
        workflow: {
          sql: "SELECT project_id FROM workflow_definitions WHERE id = $1",
        },
        "workflow-instance": {
          sql: "SELECT project_id FROM workflow_instances WHERE id = $1",
        },
        meeting: {
          sql: "SELECT project_id FROM meetings WHERE id = $1",
        },
        "task-attachment": {
          sql: "SELECT project_id FROM task_attachments WHERE id = $1",
        },
        artifact: {
          sql: "SELECT project_id FROM artifacts WHERE id = $1",
        },
        trace: {
          sql: "SELECT project_id FROM runs WHERE trace_id = $1",
        },
        "memory-topic": {
          sql: "SELECT project_id FROM memory_topics WHERE id = $1",
        },
        "memory-claim": {
          sql: "SELECT project_id FROM memory_claims WHERE id = $1",
        },
        report: {
          sql: "SELECT project_id FROM project_reports WHERE id = $1",
        },
        handoff: {
          sql: "SELECT project_id FROM handoff_cards WHERE id = $1",
        },
        "agent-episode": {
          sql: "SELECT project_id FROM agent_episodes WHERE id = $1",
        },
        "meeting-action-item": {
          sql: "SELECT project_id FROM meeting_action_items WHERE id = $1",
        },
        "execution-gate": {
          sql: "SELECT project_id FROM execution_gate_requests WHERE gate_id = $1",
        },
      };
    const query = queries[resourceType];
    const result = await this.database.query<{ project_id: string | null }>(
      query.sql,
      [resourceId],
    );
    if (result.rows.length === 0) return undefined;
    return [
      ...new Set(
        result.rows
          .map((row) => row.project_id)
          .filter((projectId): projectId is string => projectId !== null),
      ),
    ];
  }

  async projectIdForResource(
    resourceType: AuthorizationResourceType,
    resourceId: string,
  ): Promise<string | null | undefined> {
    const projectIds = await this.projectIdsForResource(
      resourceType,
      resourceId,
    );
    if (projectIds === undefined) return undefined;
    return projectIds[0] ?? null;
  }

  private async projectMember(
    projectId: string,
    principal: AuthorizationPrincipal,
    aliases: readonly { readonly value: string }[],
  ): Promise<
    | {
        readonly kind: "found";
        readonly member: ProjectMemberAuthorizationRow;
      }
    | {
        readonly kind: "none" | "ambiguous";
      }
  > {
    const candidates = [
      principal.id,
      ...aliases.map((alias) => alias.value),
    ].filter((value, index, values) => values.indexOf(value) === index);
    const matches = await this.database.query<ProjectMemberAuthorizationRow>(
      `SELECT id, project_id, kind, actor_id, principal_id, status, is_owner
       FROM project_members
       WHERE project_id = $1
         AND (
           principal_id = $2
           OR (principal_id IS NULL AND actor_id = ANY($3::text[]))
         )
       ORDER BY created_at
       LIMIT 2`,
      [projectId, principal.id, candidates],
    );
    if (matches.rows.length > 1) return { kind: "ambiguous" };
    return matches.rows[0] === undefined
      ? { kind: "none" }
      : { kind: "found", member: matches.rows[0] };
  }

  private async grantHistoryForPrincipal(
    principalId: string,
    projectId: string,
  ): Promise<ProjectGrantRow[]> {
    const result = await this.database.query<ProjectGrantRow>(
      `SELECT id, principal_id, role_key, permissions, source_ref, status
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'project'
         AND scope_id = $2
       ORDER BY granted_at`,
      [principalId, projectId],
    );
    return result.rows;
  }

  private scopedPermissions(
    permissions: readonly string[],
  ): ScopedAuthorizationPermission[] {
    const projectPermissions = new Set<string>(PROJECT_OWNER_PERMISSIONS);
    return [
      ...new Set(
        permissions.filter((permission): permission is string =>
          projectPermissions.has(permission),
        ),
      ),
    ] as ScopedAuthorizationPermission[];
  }

  private async evaluateProject(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly projectId: string;
  }): Promise<ProjectAccessEvaluation> {
    const resolved = await this.principalByExactId(
      this.database,
      input.principalId,
    );
    const denial = this.principalDenial(resolved ?? null, input.authSource);
    if (denial !== undefined || resolved === undefined) {
      return {
        principal: resolved ?? null,
        reason: denial ?? "principal_not_found",
        grants: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    const project = await this.database.query<{
      status: "active" | "archived";
    }>("SELECT status FROM projects WHERE id = $1", [input.projectId]);
    const projectRow = project.rows[0];
    if (projectRow === undefined) {
      return {
        principal: resolved,
        reason: "project_not_found",
        grants: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    const aliases = await this.aliasesForPrincipal(this.database, resolved.id);
    const memberResult = await this.projectMember(
      input.projectId,
      resolved,
      aliases,
    );
    if (memberResult.kind !== "found") {
      return {
        principal: resolved,
        reason:
          memberResult.kind === "ambiguous"
            ? "membership_ambiguous"
            : "membership_missing",
        projectStatus: projectRow.status,
        grants: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }
    const member = memberResult.member;
    if (member.status !== "active") {
      return {
        principal: resolved,
        reason: "membership_inactive",
        projectStatus: projectRow.status,
        member,
        grants: [],
        effectivePermissions: [],
        grantSource: "none",
      };
    }

    const grants = await this.activeGrants(
      resolved.id,
      "project",
      input.projectId,
    );
    const history = await this.grantHistoryForPrincipal(
      resolved.id,
      input.projectId,
    );
    const ownerGrant = grants.find(
      (grant) => grant.role_key === "PROJECT_OWNER",
    );
    const ownerGrantHistory = history.some(
      (grant) => grant.role_key === "PROJECT_OWNER",
    );
    const ownerSources = {
      legacy: member.is_owner,
      grant: ownerGrant !== undefined,
      consistent: member.is_owner === (ownerGrant !== undefined),
    };

    if (ownerGrant !== undefined) {
      return {
        principal: resolved,
        projectStatus: projectRow.status,
        member,
        grants,
        effectivePermissions: [...PROJECT_OWNER_PERMISSIONS],
        grantSource: "grant",
        ownerSources,
      };
    }

    if (ownerGrantHistory) {
      return {
        principal: resolved,
        projectStatus: projectRow.status,
        member,
        grants,
        effectivePermissions: this.scopedPermissions(
          grants.flatMap((grant) => grant.permissions),
        ),
        grantSource: grants.length === 0 ? "none" : "grant",
        ownerSources,
      };
    }

    if (member.is_owner) {
      return {
        principal: resolved,
        projectStatus: projectRow.status,
        member,
        grants,
        effectivePermissions: [...PROJECT_OWNER_PERMISSIONS],
        grantSource: "legacy-owner",
        ownerSources,
      };
    }

    if (history.length === 0) {
      const legacyRoles =
        await this.database.query<ProjectMemberRolePermissionRow>(
          `SELECT
             member_role.project_member_id,
             role.id AS role_id,
             role.permissions
           FROM project_member_roles AS member_role
           JOIN project_roles AS role ON role.id = member_role.role_id
           WHERE member_role.project_member_id = $1
             AND role.project_id = $2`,
          [member.id, input.projectId],
        );
      if (legacyRoles.rows.length > 0) {
        return {
          principal: resolved,
          projectStatus: projectRow.status,
          member,
          grants,
          effectivePermissions: this.scopedPermissions(
            legacyRoles.rows.flatMap((role) => role.permissions as string[]),
          ),
          grantSource: "legacy-role",
          ownerSources,
        };
      }
    }

    return {
      principal: resolved,
      projectStatus: projectRow.status,
      member,
      grants,
      effectivePermissions: this.scopedPermissions(
        grants.flatMap((grant) => grant.permissions),
      ),
      grantSource: grants.length === 0 ? "none" : "grant",
      ownerSources,
    };
  }

  async getProjectCapability(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly projectId: string;
  }): Promise<ProjectCapabilityDecision> {
    const evaluation = await this.evaluateProject(input);
    if (evaluation.reason !== undefined) {
      return {
        allowed: false,
        reason: evaluation.reason,
        principal: evaluation.principal,
      };
    }
    const allowedPermissions = new Set(evaluation.effectivePermissions);
    const archived = evaluation.projectStatus === "archived";
    const capability: ProjectCapability = {
      projectId: input.projectId,
      principalId: input.principalId,
      capabilities: {
        read: allowedPermissions.has("read"),
        write: !archived && allowedPermissions.has("write"),
        approve: !archived && allowedPermissions.has("approve"),
        manage_members: !archived && allowedPermissions.has("manage_members"),
        manage_roles: !archived && allowedPermissions.has("manage_roles"),
      },
      ownerSources: evaluation.ownerSources ?? {
        legacy: false,
        grant: false,
        consistent: true,
      },
      effectivePermissions: archived
        ? evaluation.effectivePermissions.filter(
            (permission) => permission === "read",
          )
        : [...evaluation.effectivePermissions],
      grantSource: evaluation.grantSource,
      ...(evaluation.member === undefined
        ? {}
        : {
            membershipId: evaluation.member.id,
            membershipStatus: evaluation.member.status,
          }),
    };
    return {
      allowed: capability.capabilities.read,
      ...(capability.capabilities.read
        ? {}
        : {
            reason:
              evaluation.grants.length === 0
                ? ("grant_missing" as const)
                : ("permission_missing" as const),
          }),
      principal: evaluation.principal,
      capability,
    };
  }

  async listReadableProjectIds(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
  }): Promise<string[]> {
    const projects = await this.database.query<{ id: string }>(
      "SELECT id FROM projects ORDER BY updated_at DESC",
    );
    const readable: string[] = [];
    for (const project of projects.rows) {
      const evaluation = await this.evaluateProject({
        principalId: input.principalId,
        authSource: input.authSource,
        projectId: project.id,
      });
      if (
        evaluation.reason === undefined &&
        evaluation.effectivePermissions.includes("read")
      ) {
        readable.push(project.id);
      }
    }
    return readable;
  }

  async authorizeProject(input: {
    readonly principalId: string;
    readonly authSource: "bearer" | "local-development";
    readonly projectId: string;
    readonly permission: ScopedAuthorizationPermission;
  }): Promise<ScopeAuthorizationDecision> {
    const evaluation = await this.evaluateProject(input);
    if (
      evaluation.reason === undefined &&
      evaluation.projectStatus === "archived" &&
      input.permission !== "read"
    ) {
      return {
        allowed: false,
        reason: "project_archived",
        principal: evaluation.principal,
        scopeType: "project",
        scopeId: input.projectId,
        permission: input.permission,
        grantIds: [],
        effectivePermissions: [...evaluation.effectivePermissions],
        ...(evaluation.member === undefined
          ? {}
          : {
              membershipId: evaluation.member.id,
              membershipStatus: evaluation.member.status,
            }),
        ...(evaluation.ownerSources === undefined
          ? {}
          : { ownerSources: evaluation.ownerSources }),
        grantSource: "none",
      };
    }
    const allowed = evaluation.effectivePermissions.includes(input.permission);
    if (evaluation.reason !== undefined || !allowed) {
      const reason =
        evaluation.reason ??
        (evaluation.grants.length === 0
          ? ("grant_missing" as const)
          : ("permission_missing" as const));
      return {
        allowed: false,
        reason,
        principal: evaluation.principal,
        scopeType: "project",
        scopeId: input.projectId,
        permission: input.permission,
        grantIds: [],
        effectivePermissions: [...evaluation.effectivePermissions],
        ...(evaluation.member === undefined
          ? {}
          : {
              membershipId: evaluation.member.id,
              membershipStatus: evaluation.member.status,
            }),
        ...(evaluation.ownerSources === undefined
          ? {}
          : { ownerSources: evaluation.ownerSources }),
        grantSource: "none",
      };
    }

    const ownerGrant = evaluation.grants.find(
      (grant) => grant.role_key === "PROJECT_OWNER",
    );
    const matching =
      ownerGrant === undefined
        ? evaluation.grants.filter((grant) =>
            grant.permissions.includes(input.permission),
          )
        : [ownerGrant];
    return {
      allowed: true,
      principal: evaluation.principal,
      scopeType: "project",
      scopeId: input.projectId,
      permission: input.permission,
      grantIds:
        evaluation.grantSource === "grant"
          ? matching.map((grant) => grant.id)
          : [],
      effectivePermissions: [...evaluation.effectivePermissions],
      ...(evaluation.member === undefined
        ? {}
        : {
            membershipId: evaluation.member.id,
            membershipStatus: evaluation.member.status,
          }),
      ...(evaluation.ownerSources === undefined
        ? {}
        : { ownerSources: evaluation.ownerSources }),
      grantSource: evaluation.grantSource,
    };
  }

  async audit(input: AuthorizationAuditInput): Promise<void> {
    await this.database.query(
      `INSERT INTO identity_audit_events (
         id, action, decision, actor_principal_id, subject_principal_id,
         account_id, session_id, grant_id, reason, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        randomUUID(),
        input.action,
        input.decision,
        input.actorPrincipalId ?? null,
        input.subjectPrincipalId ?? null,
        input.accountId ?? null,
        input.sessionId ?? null,
        input.grantId ?? null,
        input.reason ?? "",
        JSON.stringify(input.metadata ?? {}),
        this.now(),
      ],
    );
  }

  async ensureDevelopmentPrincipal(
    principalId: string,
    grantAdministrator: boolean,
  ): Promise<AuthorizationPrincipal> {
    const now = this.now();
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO principals (
           id, kind, display_name, status, status_authority, source,
           version, created_at, updated_at
         ) VALUES ($1, 'human', $2, 'active', 'system', 'local', 1, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [
          principalId,
          principalId === "local-admin" ? "Local Admin" : principalId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO role_grants (
           id, principal_id, scope_type, scope_id, role_key, permissions,
           status, source_kind, source_ref, granted_by_principal_id,
           revoked_by_principal_id, granted_at, expires_at, revoked_at,
           version, created_at, updated_at
         )
         SELECT $1, $2, 'platform', 'platform', 'MEMBER',
                '["platform.access"]'::jsonb, 'active', 'manual',
                'local-development:auto-member', NULL, NULL, $3, NULL,
                NULL, 1, $3, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM role_grants
           WHERE principal_id = $2
             AND scope_type = 'platform'
             AND scope_id = 'platform'
             AND role_key = 'MEMBER'
             AND status = 'active'
         )`,
        [randomUUID(), principalId, now],
      );
      if (grantAdministrator) {
        await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           )
           SELECT $1, $2, 'platform', 'platform', 'ADMIN', '[]'::jsonb,
                  'active', 'manual', 'local-development:auto-admin', NULL,
                  NULL, $3, NULL, NULL, 1, $3, $3
           WHERE NOT EXISTS (
             SELECT 1
             FROM role_grants
             WHERE principal_id = $2
               AND scope_type = 'platform'
               AND scope_id = 'platform'
               AND role_key = 'ADMIN'
               AND status = 'active'
           )`,
          [randomUUID(), principalId, now],
        );
      }
    });
    const principal = await this.principalByExactId(this.database, principalId);
    if (principal === undefined) {
      throw new AuthorizationRepositoryError(
        "principal_not_found",
        "Development Principal could not be created",
      );
    }
    if (principal.kind !== "human") {
      throw new AuthorizationRepositoryError(
        "principal_kind_mismatch",
        "Development Principal must be human",
      );
    }
    if (principal.status !== "active") {
      throw new AuthorizationRepositoryError(
        "principal_not_active",
        "Development Principal must be active",
      );
    }
    return principal;
  }

  async ensureAgentPrincipal(
    agentId: string,
    displayName: string,
  ): Promise<string> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<{ principal_id: string | null }>(
        "SELECT principal_id FROM agents WHERE id = $1 FOR UPDATE",
        [agentId],
      );
      if (existing.rows[0] === undefined) {
        throw new AuthorizationRepositoryError(
          "principal_not_found",
          "Agent was not found",
        );
      }
      if (existing.rows[0].principal_id !== null) {
        return existing.rows[0].principal_id;
      }
      const alias = await client.query<{ principal_id: string }>(
        `SELECT principal_id
         FROM principal_aliases
         WHERE alias_type = 'agent' AND alias_value = $1 AND status = 'active'
         LIMIT 1`,
        [agentId],
      );
      const principalId =
        alias.rows[0]?.principal_id ?? `principal-ai-agent-${agentId}`;
      const now = this.now();
      if (alias.rows[0] === undefined) {
        await client.query(
          `INSERT INTO principals (
             id, kind, display_name, status, status_authority, source,
             version, created_at, updated_at
           ) VALUES ($1, 'ai', $2, 'active', 'system', 'agent', 1, $3, $3)
           ON CONFLICT (id) DO NOTHING`,
          [principalId, displayName, now],
        );
        await client.query(
          `INSERT INTO principal_aliases (
             id, principal_id, alias_type, alias_value, status,
             created_at, updated_at
           ) VALUES ($1, $2, 'agent', $3, 'active', $4, $4)
           ON CONFLICT (alias_type, alias_value) DO NOTHING`,
          [randomUUID(), principalId, agentId, now],
        );
      }
      await client.query(
        "UPDATE agents SET principal_id = $2, updated_at = $3 WHERE id = $1",
        [agentId, principalId, now],
      );
      return principalId;
    });
  }

  async syncProjectMemberGrants(
    projectId: string,
    memberId: string,
    actorPrincipalId: string | null,
  ): Promise<void> {
    await this.database.transaction((client) =>
      this.syncProjectMemberGrantsWithClient(
        client,
        projectId,
        memberId,
        actorPrincipalId,
      ),
    );
  }

  async syncProjectMemberGrantsWithClient(
    client: PoolClient,
    projectId: string,
    memberId: string,
    actorPrincipalId: string | null,
  ): Promise<void> {
    const member = await client.query<ProjectMemberAuthorizationRow>(
      `SELECT id, project_id, kind, actor_id, principal_id, status, is_owner
       FROM project_members
       WHERE project_id = $1 AND id = $2
       FOR UPDATE`,
      [projectId, memberId],
    );
    const row = member.rows[0];
    if (row === undefined || row.principal_id === null) return;

    const roles = await client.query<{
      id: string;
      code: string;
      permissions: string[];
    }>(
      `SELECT role.id, role.code, role.permissions
       FROM project_member_roles AS member_role
       JOIN project_roles AS role ON role.id = member_role.role_id
       WHERE member_role.project_member_id = $1
         AND role.project_id = $2`,
      [memberId, projectId],
    );
    const desired = new Map<
      string,
      {
        readonly sourceRef: string;
        readonly roleKey: string;
        readonly permissions: readonly string[];
      }
    >();
    for (const role of roles.rows) {
      desired.set(`project-role:${role.id}`, {
        roleKey: `project-role:${role.id}`,
        permissions: role.permissions,
        sourceRef: `project-member:${memberId}:role:${role.id}`,
      });
    }
    const roleOwner = roles.rows.some((role) => role.code === "PROJECT_OWNER");
    const owner = row.is_owner || roleOwner;
    if (owner) {
      desired.set("PROJECT_OWNER", {
        roleKey: "PROJECT_OWNER",
        permissions: PROJECT_OWNER_PERMISSIONS,
        sourceRef: `project-member:${memberId}:owner`,
      });
    }
    if (owner !== row.is_owner) {
      if (owner) {
        const otherOwner = await client.query(
          `SELECT 1
           FROM project_members
           WHERE project_id = $1
             AND id <> $2
             AND is_owner = TRUE
             AND status = 'active'
           LIMIT 1`,
          [projectId, memberId],
        );
        if ((otherOwner.rowCount ?? 0) > 0) {
          throw new AuthorizationRepositoryError(
            "project_owner_conflict",
            "A project can have only one active owner",
          );
        }
      }
      await client.query(
        `UPDATE project_members
         SET is_owner = $2, updated_at = $3
         WHERE project_id = $1 AND id = $4`,
        [projectId, owner, this.now(), memberId],
      );
    }

    const history = await client.query<ProjectGrantRow>(
      `SELECT id, principal_id, role_key, permissions, source_ref, status
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'project'
         AND scope_id = $2
         AND source_ref LIKE $3
       FOR UPDATE`,
      [row.principal_id, projectId, `project-member:${memberId}:%`],
    );
    const activeHistory = history.rows.filter(
      (grant) => grant.status === "active" && desired.has(grant.role_key),
    );
    const byRole = new Map(
      activeHistory.map((grant) => [grant.role_key, grant]),
    );
    const now = this.now();

    for (const [roleKey, spec] of desired) {
      const current = byRole.get(roleKey);
      if (current === undefined) {
        const grantId = randomUUID();
        await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           ) VALUES (
             $1, $2, 'project', $3, $4, $5::jsonb, 'active',
             'project-role', $6, $7, NULL, $8, NULL, NULL, 1, $8, $8
           )`,
          [
            grantId,
            row.principal_id,
            projectId,
            roleKey,
            JSON.stringify(spec.permissions),
            spec.sourceRef,
            actorPrincipalId,
            now,
          ],
        );
        await this.auditWithClient(client, {
          action: "authorization.project_grant.created",
          decision: "allowed",
          actorPrincipalId,
          subjectPrincipalId: row.principal_id,
          grantId,
          metadata: {
            projectId,
            memberId,
            roleKey,
            permissions: spec.permissions,
          },
        });
        continue;
      }
      const currentPermissions = current.permissions ?? [];
      const nextPermissions = [...spec.permissions];
      if (
        currentPermissions.length !== nextPermissions.length ||
        currentPermissions.some(
          (permission, index) => permission !== nextPermissions[index],
        )
      ) {
        await client.query(
          `UPDATE role_grants
           SET permissions = $2::jsonb,
               version = version + 1,
               updated_at = $3
           WHERE id = $1`,
          [current.id, JSON.stringify(nextPermissions), now],
        );
        await this.auditWithClient(client, {
          action: "authorization.project_grant.updated",
          decision: "allowed",
          actorPrincipalId,
          subjectPrincipalId: row.principal_id,
          grantId: current.id,
          metadata: {
            projectId,
            memberId,
            roleKey,
            before: currentPermissions,
            after: nextPermissions,
          },
        });
      }
    }

    for (const grant of history.rows) {
      if (desired.has(grant.role_key)) continue;
      await this.revokeGrantWithClient(client, grant, actorPrincipalId, {
        projectId,
        memberId,
        reason: "project_role_or_membership_changed",
      });
    }
  }

  async syncProjectRoleGrants(
    projectId: string,
    roleId: string,
    actorPrincipalId: string | null,
  ): Promise<void> {
    await this.database.transaction((client) =>
      this.syncProjectRoleGrantsWithClient(
        client,
        projectId,
        roleId,
        actorPrincipalId,
      ),
    );
  }

  async syncProjectRoleGrantsWithClient(
    client: PoolClient,
    projectId: string,
    roleId: string,
    actorPrincipalId: string | null,
  ): Promise<void> {
    const members = await client.query<{ project_member_id: string }>(
      `SELECT project_member_id
       FROM project_member_roles
       WHERE role_id = $1`,
      [roleId],
    );
    for (const member of members.rows) {
      await this.syncProjectMemberGrantsWithClient(
        client,
        projectId,
        member.project_member_id,
        actorPrincipalId,
      );
    }
  }

  private async revokeGrantWithClient(
    client: PoolClient,
    grant: ProjectGrantRow,
    actorPrincipalId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const now = this.now();
    await client.query(
      `UPDATE role_grants
       SET status = 'revoked',
           revoked_by_principal_id = $2,
           revoked_at = $3,
           version = version + 1,
           updated_at = $3
       WHERE id = $1 AND status = 'active'`,
      [grant.id, actorPrincipalId, now],
    );
    await this.auditWithClient(client, {
      action: "authorization.project_grant.revoked",
      decision: "allowed",
      actorPrincipalId,
      subjectPrincipalId: grant.principal_id,
      grantId: grant.id,
      metadata: { ...metadata, roleKey: grant.role_key },
    });
  }

  async revokeProjectMemberGrantsWithClient(
    client: PoolClient,
    projectId: string,
    memberId: string,
    actorPrincipalId: string | null,
  ): Promise<void> {
    const grants = await client.query<ProjectGrantRow>(
      `SELECT grant_row.id, grant_row.principal_id, grant_row.role_key,
              grant_row.permissions, grant_row.source_ref, grant_row.status
       FROM role_grants AS grant_row
       JOIN project_members AS member
         ON member.principal_id = grant_row.principal_id
       WHERE member.project_id = $1
         AND member.id = $2
         AND grant_row.scope_type = 'project'
         AND grant_row.scope_id = $1
         AND grant_row.status = 'active'
         AND grant_row.source_ref LIKE $3`,
      [projectId, memberId, `project-member:${memberId}:%`],
    );
    for (const grant of grants.rows) {
      await this.revokeGrantWithClient(client, grant, actorPrincipalId, {
        projectId,
        memberId,
        reason: "project_member_removed",
      });
    }
  }

  private async auditWithClient(
    client: PoolClient,
    input: AuthorizationAuditInput,
  ): Promise<void> {
    await client.query(
      `INSERT INTO identity_audit_events (
         id, action, decision, actor_principal_id, subject_principal_id,
         account_id, session_id, grant_id, reason, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        randomUUID(),
        input.action,
        input.decision,
        input.actorPrincipalId ?? null,
        input.subjectPrincipalId ?? null,
        input.accountId ?? null,
        input.sessionId ?? null,
        input.grantId ?? null,
        input.reason ?? "",
        JSON.stringify(input.metadata ?? {}),
        this.now(),
      ],
    );
  }

  async getProjectAuthorizationReport(
    projectId: string,
  ): Promise<ProjectAuthorizationReport | undefined> {
    const project = await this.database.query(
      "SELECT 1 FROM projects WHERE id = $1",
      [projectId],
    );
    if ((project.rowCount ?? 0) === 0) return undefined;
    const members = await this.database.query<ProjectMemberAuthorizationRow>(
      `SELECT id, project_id, kind, actor_id, principal_id, status, is_owner
       FROM project_members
       WHERE project_id = $1
       ORDER BY created_at, name`,
      [projectId],
    );
    const memberRoles =
      await this.database.query<ProjectMemberRolePermissionRow>(
        `SELECT
           member_role.project_member_id,
           role.id AS role_id,
           role.permissions
         FROM project_member_roles AS member_role
         JOIN project_roles AS role ON role.id = member_role.role_id
         WHERE role.project_id = $1`,
        [projectId],
      );
    const grants = await this.database.query<ProjectGrantRow>(
      `SELECT id, principal_id, role_key, permissions, source_ref, status
       FROM role_grants
       WHERE scope_type = 'project'
         AND scope_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $2)`,
      [projectId, this.now()],
    );
    const rolesByMember = new Map<string, ProjectMemberRolePermissionRow[]>();
    for (const role of memberRoles.rows) {
      const items = rolesByMember.get(role.project_member_id) ?? [];
      items.push(role);
      rolesByMember.set(role.project_member_id, items);
    }
    const grantsByPrincipal = new Map<string, ProjectGrantRow[]>();
    for (const grant of grants.rows) {
      const items = grantsByPrincipal.get(grant.principal_id) ?? [];
      items.push(grant);
      grantsByPrincipal.set(grant.principal_id, items);
    }

    const rows: ProjectMemberAuthorizationReport[] = [];
    for (const member of members.rows) {
      let principalId = member.principal_id;
      if (principalId === null) {
        try {
          principalId =
            (await this.resolvePrincipalReference(member.actor_id))?.principal
              .id ?? null;
        } catch (error) {
          if (!(error instanceof AuthorizationRepositoryError)) throw error;
          principalId = null;
        }
      }
      const principalGrants =
        principalId === null ? [] : (grantsByPrincipal.get(principalId) ?? []);
      const ownerGrant = principalGrants.some(
        (grant) => grant.role_key === "PROJECT_OWNER",
      );
      const memberSpecificRoles = rolesByMember.get(member.id) ?? [];
      rows.push({
        memberId: member.id,
        actorId: member.actor_id,
        kind: member.kind,
        principalId,
        status: member.status,
        roleIds: memberSpecificRoles.map((role) => role.role_id),
        grantIds: principalGrants.map((grant) => grant.id),
        permissions: [
          ...new Set(principalGrants.flatMap((grant) => grant.permissions)),
        ],
        owner: {
          legacy: member.is_owner,
          grant: ownerGrant,
          consistent: member.is_owner === ownerGrant,
        },
      });
    }
    const legacyOwners = rows
      .filter((row) => row.owner.legacy && row.principalId !== null)
      .map((row) => row.principalId!);
    const grantOwners = rows
      .filter((row) => row.owner.grant && row.principalId !== null)
      .map((row) => row.principalId!);
    const ownerPrincipalIds = {
      legacy: [...new Set(legacyOwners)].sort(),
      grant: [...new Set(grantOwners)].sort(),
    };
    const consistent =
      ownerPrincipalIds.legacy.length === ownerPrincipalIds.grant.length &&
      ownerPrincipalIds.legacy.every(
        (principalId, index) => principalId === ownerPrincipalIds.grant[index],
      ) &&
      rows.every((row) => row.owner.consistent);
    return {
      projectId,
      generatedAt: this.now().toISOString(),
      consistent,
      ownerPrincipalIds,
      members: rows,
    };
  }
}
