import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  AcceptCredentialActivationInput,
  AccountDirectoryPage,
  AccountDirectoryQuery,
  AddWorkspaceMemberInput,
  CreateManagedAccountInput,
  CreateManagedAccountResult,
  CreatePlatformGrantInput,
  CreateWorkspaceGrantInput,
  CreateWorkspaceInput,
  CredentialActivationResult,
  IdentityAuditPage,
  IdentityAuditQuery,
  IssueCredentialActivationInput,
  ManagedAccount,
  ManagedAccountDetail,
  PlatformGrantPage,
  PlatformGrantQuery,
  PlatformRoleDefinition,
  RevokeGrantInput,
  UpdateGrantExpiryInput,
  UpdateManagedAccountInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberStatusInput,
  Workspace,
  WorkspaceDetail,
  WorkspaceListQuery,
  WorkspaceMemberDetail,
  RoleGrant,
  IdentityAuditEvent,
  WorkspaceMember,
} from "@pluginmax/contracts";
import {
  platformPermissionsForRole,
  workspacePermissionsForRole,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { hashIdentityPassword } from "./identity-repository.js";

const ACTIVATION_TOKEN_SCHEME = "activation-token-sha256";
const ACTIVATION_TOKEN_BYTES = 32;
const DEFAULT_ACTIVATION_TTL_SECONDS = 604_800;

export type IdentityAdministrationErrorCode =
  | "account_exists"
  | "login_id_conflict"
  | "principal_archived"
  | "principal_not_human"
  | "account_disabled"
  | "credential_conflict"
  | "credential_activation_invalid"
  | "grant_exists"
  | "grant_not_found"
  | "grant_not_active"
  | "last_platform_admin"
  | "workspace_exists"
  | "workspace_not_found"
  | "workspace_archived"
  | "membership_exists"
  | "membership_not_found"
  | "last_workspace_admin"
  | "version_conflict"
  | "invalid_cursor"
  | "invalid_expiry"
  | "not_found";

export class IdentityAdministrationRepositoryError extends Error {
  constructor(
    readonly code: IdentityAdministrationErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "IdentityAdministrationRepositoryError";
  }
}

export interface IdentityAdministrationRepositoryOptions {
  readonly now?: () => Date;
  readonly createActivationToken?: () => string;
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

interface ManagedAccountRow {
  account_id: string;
  account_status: "active" | "pending" | "disabled";
  login_id: string;
  account_version: number;
  account_created_at: Date;
  account_updated_at: Date;
  principal_id: string;
  principal_kind: "human" | "ai";
  display_name: string;
  principal_status: "active" | "suspended" | "archived";
  principal_status_authority:
    "account" | "ai-companion" | "hrm" | "legacy" | "system";
  credential_id: string | null;
  credential_status: "pending" | "active" | "disabled" | "revoked" | null;
  credential_expires_at: Date | null;
  last_authenticated_at: Date | null;
  active_session_count: number;
}

interface AccountForUpdateRow {
  account_id: string;
  account_status: "active" | "pending" | "disabled";
  login_id: string;
  account_version: number;
  principal_id: string;
  principal_kind: "human" | "ai";
  display_name: string;
  principal_status: "active" | "suspended" | "archived";
  principal_status_authority:
    "account" | "ai-companion" | "hrm" | "legacy" | "system";
}

interface CredentialRow {
  id: string;
  account_id: string;
  credential_status: "pending" | "active" | "disabled" | "revoked";
  secret_scheme: string;
  secret_hash: string;
  expires_at: Date | null;
  version: number;
}

interface RoleGrantRow {
  id: string;
  principal_id: string;
  scope_type: "platform" | "workspace" | "project";
  scope_id: string;
  role_key: string;
  permissions: string[];
  status: "active" | "revoked" | "expired";
  source_kind:
    | "manual"
    | "platform-role"
    | "workspace-role"
    | "project-role"
    | "employee-role"
    | "template";
  source_ref: string | null;
  granted_by_principal_id: string | null;
  revoked_by_principal_id: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface WorkspaceRow {
  id: string;
  display_name: string;
  status: "active" | "archived";
  created_by_principal_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  member_count: number;
  active_grant_count: number;
}

interface WorkspaceMemberRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  status: "active" | "inactive";
  version: number;
  created_at: Date;
  updated_at: Date;
  display_name: string;
  principal_kind: "human" | "ai";
  principal_status: "active" | "suspended" | "archived";
}

interface AuditRow {
  id: string;
  action: string;
  decision: "allowed" | "denied";
  actor_principal_id: string | null;
  subject_principal_id: string | null;
  account_id: string | null;
  session_id: string | null;
  grant_id: string | null;
  reason: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface AliasRow {
  id: string;
  principal_id: string;
  alias_type:
    | "auth-user"
    | "employee"
    | "teammate"
    | "agent"
    | "runtime-profile"
    | "legacy-actor"
    | "external";
  alias_value: string;
  status: "active" | "retired";
  created_at: Date;
  updated_at: Date;
}

const ACCOUNT_SELECT = `
  SELECT
    a.id AS account_id,
    a.status AS account_status,
    a.login_id,
    a.version AS account_version,
    a.created_at AS account_created_at,
    a.updated_at AS account_updated_at,
    p.id AS principal_id,
    p.kind AS principal_kind,
    p.display_name,
    p.status AS principal_status,
    p.status_authority AS principal_status_authority,
    c.id AS credential_id,
    c.status AS credential_status,
    c.expires_at AS credential_expires_at,
    c.last_authenticated_at,
    (
      SELECT COUNT(*)::int
      FROM auth_sessions AS session
      WHERE session.principal_id = p.id
        AND session.status = 'active'
        AND session.expires_at > $1
    ) AS active_session_count
  FROM accounts AS a
  JOIN principals AS p ON p.id = a.principal_id
  LEFT JOIN LATERAL (
    SELECT
      credential.id,
      credential.status,
      credential.expires_at,
      credential.last_authenticated_at
    FROM account_credentials AS credential
    WHERE credential.account_id = a.id
      AND credential.credential_type = 'password'
    ORDER BY credential.created_at DESC
    LIMIT 1
  ) AS c ON TRUE
`;

function iso(date: Date): string {
  return date.toISOString();
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : iso(date);
}

function numberValue(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new IdentityAdministrationRepositoryError(
      "invalid_cursor",
      "The pagination cursor is invalid",
      400,
    );
  }
  return parsed;
}

function managedAccountFromRow(row: ManagedAccountRow): ManagedAccount {
  return {
    id: row.account_id,
    principalId: row.principal_id,
    loginId: row.login_id,
    status: row.account_status,
    displayName: row.display_name,
    version: row.account_version,
    createdAt: iso(row.account_created_at),
    updatedAt: iso(row.account_updated_at),
    principalKind: row.principal_kind,
    principalStatus: row.principal_status,
    principalStatusAuthority: row.principal_status_authority,
    credentialStatus: row.credential_status ?? "missing",
    credentialExpiresAt: isoOrNull(row.credential_expires_at),
    lastAuthenticatedAt: isoOrNull(row.last_authenticated_at),
    activeSessionCount: numberValue(row.active_session_count),
  };
}

function grantFromRow(row: RoleGrantRow): RoleGrant {
  return {
    id: row.id,
    principalId: row.principal_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    roleKey: row.role_key,
    permissions: row.permissions,
    status: row.status,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    grantedByPrincipalId: row.granted_by_principal_id,
    revokedByPrincipalId: row.revoked_by_principal_id,
    grantedAt: iso(row.granted_at),
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function auditFromRow(row: AuditRow): IdentityAuditEvent {
  return {
    id: row.id,
    action: row.action,
    decision: row.decision,
    actorPrincipalId: row.actor_principal_id,
    subjectPrincipalId: row.subject_principal_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    grantId: row.grant_id,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  };
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    version: row.version,
    createdByPrincipalId: row.created_by_principal_id,
    memberCount: numberValue(row.member_count),
    activeGrantCount: numberValue(row.active_grant_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function workspaceMemberFromRow(row: WorkspaceMemberRow): WorkspaceMember {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function aliasFromRow(row: AliasRow): ManagedAccountDetail["aliases"][number] {
  return {
    id: row.id,
    principalId: row.principal_id,
    type: row.alias_type,
    value: row.alias_value,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function pgConstraint(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    typeof error.constraint === "string"
    ? error.constraint
    : undefined;
}

export function hashCredentialActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function activationToken(): string {
  return randomBytes(ACTIVATION_TOKEN_BYTES).toString("base64url");
}

export class IdentityAdministrationRepository {
  private readonly now: () => Date;
  private readonly createActivationToken: () => string;

  constructor(
    private readonly database: Database,
    options: IdentityAdministrationRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createActivationToken =
      options.createActivationToken ?? activationToken;
  }

  private async audit(
    executor: QueryExecutor,
    input: {
      readonly action: string;
      readonly decision?: "allowed" | "denied";
      readonly actorPrincipalId?: string | null;
      readonly subjectPrincipalId?: string | null;
      readonly accountId?: string | null;
      readonly sessionId?: string | null;
      readonly grantId?: string | null;
      readonly reason?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO identity_audit_events (
         id, action, decision, actor_principal_id, subject_principal_id,
         account_id, session_id, grant_id, reason, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        randomUUID(),
        input.action,
        input.decision ?? "allowed",
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

  private async accountRowById(
    executor: QueryExecutor,
    accountId: string,
  ): Promise<ManagedAccountRow | undefined> {
    const result = await executor.query<ManagedAccountRow>(
      `${ACCOUNT_SELECT} WHERE a.id = $2 LIMIT 1`,
      [this.now(), accountId],
    );
    return result.rows[0];
  }

  async listAccounts(
    input: AccountDirectoryQuery,
  ): Promise<AccountDirectoryPage> {
    const offset = decodeOffset(input.cursor);
    const conditions: string[] = [];
    const values: unknown[] = [this.now()];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("$?", `$${values.length}`));
    };
    if (input.query !== undefined && input.query !== "") {
      values.push(`%${input.query.toLowerCase()}%`);
      conditions.push(
        `(lower(a.login_id) LIKE $${values.length} OR lower(p.display_name) LIKE $${values.length})`,
      );
    }
    if (input.status !== undefined) {
      add("a.status = $?", input.status);
    }
    if (input.principalStatus !== undefined) {
      add("p.status = $?", input.principalStatus);
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    values.push(input.limit + 1, offset);
    const limitPlaceholder = `$${values.length - 1}`;
    const offsetPlaceholder = `$${values.length}`;
    const rows = await this.database.query<ManagedAccountRow>(
      `${ACCOUNT_SELECT}
       ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values,
    );
    const countValues = values.slice(0, -2);
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM accounts AS a
       JOIN principals AS p ON p.id = a.principal_id
       ${where === "" ? "WHERE $1::timestamptz IS NOT NULL" : `${where} AND $1::timestamptz IS NOT NULL`}`,
      countValues,
    );
    const hasNext = rows.rows.length > input.limit;
    const items = rows.rows.slice(0, input.limit).map(managedAccountFromRow);
    return {
      items,
      nextCursor: hasNext ? encodeOffset(offset + items.length) : null,
      total: numberValue(count.rows[0]?.total ?? 0),
    };
  }

  async getAccount(
    accountId: string,
  ): Promise<ManagedAccountDetail | undefined> {
    const account = await this.accountRowById(this.database, accountId);
    if (account === undefined) return undefined;
    const [aliases, grants, memberships, audit] = await Promise.all([
      this.database.query<AliasRow>(
        `SELECT id, principal_id, alias_type, alias_value, status,
                created_at, updated_at
         FROM principal_aliases
         WHERE principal_id = $1
         ORDER BY created_at`,
        [account.principal_id],
      ),
      this.database.query<RoleGrantRow>(
        `SELECT *
         FROM role_grants
         WHERE principal_id = $1
         ORDER BY granted_at DESC
         LIMIT 100`,
        [account.principal_id],
      ),
      this.database.query<WorkspaceMemberRow>(
        `SELECT wm.id, wm.workspace_id, wm.principal_id, wm.status, wm.version,
                wm.created_at, wm.updated_at,
                p.display_name, p.kind AS principal_kind,
                p.status AS principal_status
         FROM workspace_members AS wm
         JOIN principals AS p ON p.id = wm.principal_id
         WHERE wm.principal_id = $1
         ORDER BY wm.workspace_id`,
        [account.principal_id],
      ),
      this.database.query<AuditRow>(
        `SELECT *
         FROM identity_audit_events
         WHERE subject_principal_id = $1 OR account_id = $2
         ORDER BY created_at DESC
         LIMIT 20`,
        [account.principal_id, accountId],
      ),
    ]);
    return {
      ...managedAccountFromRow(account),
      aliases: aliases.rows.map(aliasFromRow),
      platformGrants: grants.rows
        .filter((grant) => grant.scope_type === "platform")
        .map(grantFromRow),
      workspaceMemberships: memberships.rows.map(workspaceMemberFromRow),
      recentAudit: audit.rows.map(auditFromRow),
    };
  }

  async createAccount(
    actorPrincipalId: string,
    input: CreateManagedAccountInput,
  ): Promise<CreateManagedAccountResult> {
    const now = this.now();
    const principalId = input.principalId ?? `principal-human-${randomUUID()}`;
    const accountId = `account-${randomUUID()}`;
    const token =
      input.credential.mode === "invitation"
        ? this.createActivationToken()
        : null;
    const tokenExpiresAt =
      token === null
        ? null
        : new Date(
            now.getTime() +
              (input.credential.mode === "invitation"
                ? input.credential.expiresInSeconds
                : DEFAULT_ACTIVATION_TTL_SECONDS) *
                1_000,
          );
    const passwordHash =
      input.credential.mode === "password"
        ? await hashIdentityPassword(input.credential.password)
        : null;

    try {
      await this.database.transaction(async (client) => {
        const principal = await client.query<{
          kind: "human" | "ai";
          status: "active" | "suspended" | "archived";
        }>("SELECT kind, status FROM principals WHERE id = $1 FOR UPDATE", [
          principalId,
        ]);
        const existingPrincipal = principal.rows[0];
        if (existingPrincipal !== undefined) {
          if (existingPrincipal.kind !== "human") {
            throw new IdentityAdministrationRepositoryError(
              "principal_not_human",
              "A login account can only be created for a human Principal",
              409,
            );
          }
          if (existingPrincipal.status !== "active") {
            throw new IdentityAdministrationRepositoryError(
              "principal_archived",
              "A suspended or archived Principal cannot receive a new account",
              409,
            );
          }
          await client.query(
            `UPDATE principals
             SET display_name = $2, source = 'account',
                 updated_at = $3, version = version + 1
             WHERE id = $1`,
            [principalId, input.displayName, now],
          );
        } else {
          await client.query(
            `INSERT INTO principals (
               id, kind, display_name, status, status_authority, source,
               version, created_at, updated_at
             ) VALUES ($1, 'human', $2, 'active', 'account', 'account',
                       1, $3, $3)`,
            [principalId, input.displayName, now],
          );
        }

        const accountStatus =
          input.credential.mode === "password" ? "active" : "pending";
        await client.query(
          `INSERT INTO accounts (
             id, principal_id, login_id, status, version, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 1, $5, $5)`,
          [accountId, principalId, input.loginId, accountStatus, now],
        );
        await client.query(
          `INSERT INTO account_credentials (
             id, account_id, credential_type, secret_scheme, secret_hash,
             status, expires_at, last_authenticated_at, version,
             created_at, updated_at
           ) VALUES ($1, $2, 'password', $3, $4, $5, $6, NULL, 1, $7, $7)`,
          [
            randomUUID(),
            accountId,
            input.credential.mode === "password"
              ? "scrypt"
              : ACTIVATION_TOKEN_SCHEME,
            input.credential.mode === "password"
              ? passwordHash
              : hashCredentialActivationToken(token!),
            accountStatus === "active" ? "active" : "pending",
            tokenExpiresAt,
            now,
          ],
        );
        const memberGrantId = randomUUID();
        const memberGrant = await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           )
           SELECT
             $1, $2, 'platform', 'platform', 'MEMBER', $3::jsonb,
             'active', 'manual', 'account-created:default-member', $4,
             NULL, $5, NULL, NULL, 1, $5, $5
           WHERE NOT EXISTS (
             SELECT 1
             FROM role_grants
             WHERE principal_id = $2
               AND scope_type = 'platform'
               AND scope_id = 'platform'
               AND role_key = 'MEMBER'
               AND status = 'active'
           )`,
          [
            memberGrantId,
            principalId,
            JSON.stringify(platformPermissionsForRole("MEMBER")),
            actorPrincipalId,
            now,
          ],
        );
        await this.audit(client, {
          action: "identity.account.created",
          actorPrincipalId,
          subjectPrincipalId: principalId,
          accountId,
          metadata: {
            loginId: input.loginId,
            credentialMode: input.credential.mode,
            accountStatus,
          },
        });
        if ((memberGrant.rowCount ?? 0) > 0) {
          await this.audit(client, {
            action: "identity.platform_grant.created",
            actorPrincipalId,
            subjectPrincipalId: principalId,
            accountId,
            grantId: memberGrantId,
            metadata: { roleKey: "MEMBER", source: "account-created" },
          });
        }
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        const constraint = pgConstraint(error);
        if (constraint === "accounts_login_id_unique_idx") {
          throw new IdentityAdministrationRepositoryError(
            "login_id_conflict",
            "The login ID is already in use",
            409,
          );
        }
        throw new IdentityAdministrationRepositoryError(
          "account_exists",
          "An account or active platform role already exists for this Principal",
          409,
        );
      }
      throw error;
    }

    const account = await this.getAccount(accountId);
    if (account === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "not_found",
        "Created account could not be read",
        404,
      );
    }
    return {
      account,
      activation:
        token === null || tokenExpiresAt === null
          ? null
          : {
              accountId,
              status: "pending",
              activationToken: token,
              expiresAt: iso(tokenExpiresAt),
            },
    };
  }

  async updateAccount(
    actorPrincipalId: string,
    accountId: string,
    input: UpdateManagedAccountInput,
  ): Promise<ManagedAccountDetail> {
    try {
      await this.database.transaction(async (client) => {
        const account = await client.query<AccountForUpdateRow>(
          `SELECT
             a.id AS account_id, a.status AS account_status, a.login_id,
             a.version AS account_version, p.id AS principal_id,
             p.kind AS principal_kind, p.display_name,
             p.status AS principal_status,
             p.status_authority AS principal_status_authority
           FROM accounts AS a
           JOIN principals AS p ON p.id = a.principal_id
           WHERE a.id = $1
           FOR UPDATE OF a, p`,
          [accountId],
        );
        const row = account.rows[0];
        if (row === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "not_found",
            "Account not found",
            404,
          );
        }
        if (row.principal_status === "archived") {
          throw new IdentityAdministrationRepositoryError(
            "principal_archived",
            "An archived Principal cannot be updated",
            409,
          );
        }
        if (row.account_version !== input.expectedVersion) {
          throw new IdentityAdministrationRepositoryError(
            "version_conflict",
            "The account changed before this request was applied",
            409,
          );
        }
        const now = this.now();
        if (
          input.loginId !== undefined &&
          input.loginId.toLowerCase() !== row.login_id.toLowerCase()
        ) {
          const login = await client.query(
            `SELECT 1 FROM accounts
             WHERE lower(login_id) = lower($1) AND id <> $2
             LIMIT 1`,
            [input.loginId, accountId],
          );
          if ((login.rowCount ?? 0) > 0) {
            throw new IdentityAdministrationRepositoryError(
              "login_id_conflict",
              "The login ID is already in use",
              409,
            );
          }
        }
        await client.query(
          `UPDATE accounts
           SET login_id = COALESCE($2, login_id),
               version = version + 1,
               updated_at = $3
           WHERE id = $1`,
          [accountId, input.loginId ?? null, now],
        );
        if (input.displayName !== undefined) {
          await client.query(
            `UPDATE principals
             SET display_name = $2, updated_at = $3, version = version + 1
             WHERE id = $1`,
            [row.principal_id, input.displayName, now],
          );
        }
        await this.audit(client, {
          action: "identity.account.updated",
          actorPrincipalId,
          subjectPrincipalId: row.principal_id,
          accountId,
          metadata: {
            loginIdChanged:
              input.loginId !== undefined &&
              input.loginId.toLowerCase() !== row.login_id.toLowerCase(),
            displayNameChanged: input.displayName !== undefined,
          },
        });
      });
    } catch (error) {
      if (
        pgErrorCode(error) === "23505" &&
        pgConstraint(error) === "accounts_login_id_unique_idx"
      ) {
        throw new IdentityAdministrationRepositoryError(
          "login_id_conflict",
          "The login ID is already in use",
          409,
        );
      }
      throw error;
    }
    const account = await this.getAccount(accountId);
    if (account === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "not_found",
        "Account not found",
        404,
      );
    }
    return account;
  }

  async issueCredentialActivation(
    actorPrincipalId: string,
    accountId: string,
    input: IssueCredentialActivationInput,
  ): Promise<CredentialActivationResult> {
    const token = this.createActivationToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1_000);
    await this.database.transaction(async (client) => {
      const account = await client.query<AccountForUpdateRow>(
        `SELECT
           a.id AS account_id, a.status AS account_status, a.login_id,
           a.version AS account_version, p.id AS principal_id,
           p.kind AS principal_kind, p.display_name,
           p.status AS principal_status,
           p.status_authority AS principal_status_authority
         FROM accounts AS a
         JOIN principals AS p ON p.id = a.principal_id
         WHERE a.id = $1
         FOR UPDATE OF a, p`,
        [accountId],
      );
      const row = account.rows[0];
      if (row === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "not_found",
          "Account not found",
          404,
        );
      }
      if (row.principal_status === "archived") {
        throw new IdentityAdministrationRepositoryError(
          "principal_archived",
          "An archived Principal cannot receive a credential",
          409,
        );
      }
      if (row.account_status === "disabled") {
        throw new IdentityAdministrationRepositoryError(
          "account_disabled",
          "Enable the account before issuing a credential",
          409,
        );
      }
      const ownAdmin = await client.query(
        `SELECT 1
         FROM role_grants
         WHERE principal_id = $1
           AND scope_type = 'platform'
           AND scope_id = 'platform'
           AND role_key = 'ADMIN'
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > $2)
         LIMIT 1`,
        [row.principal_id, now],
      );
      if ((ownAdmin.rowCount ?? 0) > 0) {
        const otherAdmins = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM role_grants AS grant_row
           JOIN principals AS principal
             ON principal.id = grant_row.principal_id
           LEFT JOIN accounts AS account
             ON account.principal_id = principal.id
           WHERE grant_row.principal_id <> $1
             AND grant_row.scope_type = 'platform'
             AND grant_row.scope_id = 'platform'
             AND grant_row.role_key = 'ADMIN'
             AND grant_row.status = 'active'
             AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $2)
             AND principal.status = 'active'
             AND (principal.kind = 'ai' OR account.status = 'active')`,
          [row.principal_id, now],
        );
        if (Number(otherAdmins.rows[0]?.count ?? 0) === 0) {
          throw new IdentityAdministrationRepositoryError(
            "last_platform_admin",
            "The last active platform administrator credential cannot be reset",
            409,
          );
        }
      }
      const credential = await client.query<CredentialRow>(
        `SELECT id, account_id, status AS credential_status,
                secret_scheme, secret_hash, expires_at, version
         FROM account_credentials
         WHERE account_id = $1 AND credential_type = 'password'
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [accountId],
      );
      const existing = credential.rows[0];
      if (existing === undefined) {
        await client.query(
          `INSERT INTO account_credentials (
             id, account_id, credential_type, secret_scheme, secret_hash,
             status, expires_at, last_authenticated_at, version,
             created_at, updated_at
           ) VALUES ($1, $2, 'password', $3, $4, 'pending', $5, NULL, 1, $6, $6)`,
          [
            randomUUID(),
            accountId,
            ACTIVATION_TOKEN_SCHEME,
            hashCredentialActivationToken(token),
            expiresAt,
            now,
          ],
        );
      } else {
        await client.query(
          `UPDATE account_credentials
           SET secret_scheme = $2, secret_hash = $3, status = 'pending',
               expires_at = $4, updated_at = $5, version = version + 1
           WHERE id = $1`,
          [
            existing.id,
            ACTIVATION_TOKEN_SCHEME,
            hashCredentialActivationToken(token),
            expiresAt,
            now,
          ],
        );
      }
      const revokedSessions = await client.query(
        `UPDATE auth_sessions
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
         WHERE principal_id = $1 AND status = 'active'`,
        [row.principal_id, now],
      );
      await this.audit(client, {
        action: "identity.credential.reset_issued",
        actorPrincipalId,
        subjectPrincipalId: row.principal_id,
        accountId,
        metadata: {
          reason: input.reason,
          expiresAt: iso(expiresAt),
          sessionsRevoked: revokedSessions.rowCount ?? 0,
        },
      });
    });
    return {
      accountId,
      status: "pending",
      activationToken: token,
      expiresAt: iso(expiresAt),
    };
  }

  async acceptCredentialActivation(
    input: AcceptCredentialActivationInput,
  ): Promise<{ readonly accountId: string; readonly principalId: string }> {
    const now = this.now();
    const tokenHash = hashCredentialActivationToken(input.token);
    const passwordHash = await hashIdentityPassword(input.password);
    return this.database.transaction(async (client) => {
      const result = await client.query<CredentialRow>(
        `SELECT credential.id, credential.account_id,
                credential.status AS credential_status,
                credential.secret_scheme, credential.secret_hash,
                credential.expires_at, credential.version
         FROM account_credentials AS credential
         JOIN accounts AS account ON account.id = credential.account_id
         JOIN principals AS principal ON principal.id = account.principal_id
         WHERE credential.credential_type = 'password'
           AND credential.status = 'pending'
           AND credential.secret_scheme = $1
           AND credential.secret_hash = $2
           AND credential.expires_at > $3
           AND account.status <> 'disabled'
           AND principal.status = 'active'
         LIMIT 1
         FOR UPDATE OF credential, account, principal`,
        [ACTIVATION_TOKEN_SCHEME, tokenHash, now],
      );
      const credential = result.rows[0];
      if (credential === undefined) {
        await this.audit(client, {
          action: "identity.credential.activation",
          decision: "denied",
          reason: "invalid_or_expired_activation",
        });
        throw new IdentityAdministrationRepositoryError(
          "credential_activation_invalid",
          "The activation credential is invalid or expired",
          400,
        );
      }
      const account = await client.query<{
        principal_id: string;
        status: "active" | "pending" | "disabled";
        version: number;
        status_authority:
          "account" | "ai-companion" | "hrm" | "legacy" | "system";
      }>(
        `SELECT p.id AS principal_id, a.status, a.version,
                p.status_authority
         FROM accounts AS a
         JOIN principals AS p ON p.id = a.principal_id
         WHERE a.id = $1
         FOR UPDATE OF a, p`,
        [credential.account_id],
      );
      const accountRow = account.rows[0]!;
      await client.query(
        `UPDATE account_credentials
         SET secret_scheme = 'scrypt', secret_hash = $2, status = 'active',
             expires_at = NULL, updated_at = $3, version = version + 1
         WHERE id = $1 AND status = 'pending'`,
        [credential.id, passwordHash, now],
      );
      await client.query(
        `UPDATE accounts
         SET status = 'active', updated_at = $2, version = version + 1
         WHERE id = $1`,
        [credential.account_id, now],
      );
      if (accountRow.status_authority === "account") {
        await client.query(
          `UPDATE principals
           SET status = 'active', updated_at = $2, version = version + 1
           WHERE id = $1`,
          [accountRow.principal_id, now],
        );
      }
      await this.audit(client, {
        action: "identity.credential.activation",
        subjectPrincipalId: accountRow.principal_id,
        accountId: credential.account_id,
      });
      return {
        accountId: credential.account_id,
        principalId: accountRow.principal_id,
      };
    });
  }

  async listIdentityAudit(
    input: IdentityAuditQuery,
  ): Promise<IdentityAuditPage> {
    const offset = decodeOffset(input.cursor);
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("$?", `$${values.length}`));
    };
    if (input.accountId !== undefined) {
      add("account_id = $?", input.accountId);
    }
    if (input.subjectPrincipalId !== undefined) {
      add("subject_principal_id = $?", input.subjectPrincipalId);
    }
    if (input.actorPrincipalId !== undefined) {
      add("actor_principal_id = $?", input.actorPrincipalId);
    }
    if (input.action !== undefined) {
      add("action = $?", input.action);
    }
    if (input.decision !== undefined) {
      add("decision = $?", input.decision);
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    values.push(input.limit + 1, offset);
    const rows = await this.database.query<AuditRow>(
      `SELECT *
       FROM identity_audit_events
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM identity_audit_events
       ${where}`,
      values.slice(0, -2),
    );
    const hasNext = rows.rows.length > input.limit;
    const items = rows.rows.slice(0, input.limit).map(auditFromRow);
    return {
      items,
      nextCursor: hasNext ? encodeOffset(offset + items.length) : null,
      total: numberValue(count.rows[0]?.total ?? 0),
    };
  }

  private async expirePlatformGrants(): Promise<void> {
    const now = this.now();
    await this.database.query(
      `UPDATE role_grants
       SET status = 'expired', updated_at = $1, version = version + 1
       WHERE scope_type = 'platform'
         AND status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= $1`,
      [now],
    );
  }

  async listPlatformRoles(): Promise<PlatformRoleDefinition[]> {
    await this.expirePlatformGrants();
    const counts = await this.database.query<{
      role_key: "ADMIN" | "MEMBER";
      active_grant_count: number;
    }>(
      `SELECT role_key, COUNT(*)::int AS active_grant_count
       FROM role_grants
       WHERE scope_type = 'platform'
         AND scope_id = 'platform'
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $1)
       GROUP BY role_key`,
      [this.now()],
    );
    const countByRole = new Map(
      counts.rows.map((row) => [
        row.role_key,
        numberValue(row.active_grant_count),
      ]),
    );
    return [
      {
        key: "ADMIN",
        displayName: "平台管理员",
        description: "管理账号、平台 Grant、Workspace 和身份审计",
        permissions: [...platformPermissionsForRole("ADMIN")],
        activeGrantCount: countByRole.get("ADMIN") ?? 0,
      },
      {
        key: "MEMBER",
        displayName: "平台成员",
        description: "创建项目并使用被明确授予的 Project 权限",
        permissions: [...platformPermissionsForRole("MEMBER")],
        activeGrantCount: countByRole.get("MEMBER") ?? 0,
      },
    ];
  }

  async listPlatformGrants(
    input: PlatformGrantQuery,
  ): Promise<PlatformGrantPage> {
    await this.expirePlatformGrants();
    const offset = decodeOffset(input.cursor);
    const conditions = ["scope_type = 'platform'", "scope_id = 'platform'"];
    const values: unknown[] = [];
    if (input.principalId !== undefined) {
      values.push(input.principalId);
      conditions.push(`principal_id = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      conditions.push(`status = $${values.length}`);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    values.push(input.limit + 1, offset);
    const rows = await this.database.query<RoleGrantRow>(
      `SELECT *
       FROM role_grants
       ${where}
       ORDER BY granted_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM role_grants ${where}`,
      values.slice(0, -2),
    );
    const hasNext = rows.rows.length > input.limit;
    const items = rows.rows.slice(0, input.limit).map(grantFromRow);
    return {
      items,
      nextCursor: hasNext ? encodeOffset(offset + items.length) : null,
      total: numberValue(count.rows[0]?.total ?? 0),
    };
  }

  async createPlatformGrant(
    actorPrincipalId: string,
    input: CreatePlatformGrantInput,
  ): Promise<RoleGrant> {
    await this.expirePlatformGrants();
    const now = this.now();
    if (
      input.expiresAt !== null &&
      Date.parse(input.expiresAt) <= now.getTime()
    ) {
      throw new IdentityAdministrationRepositoryError(
        "invalid_expiry",
        "Grant expiry must be in the future",
        400,
      );
    }
    const grantId = randomUUID();
    try {
      await this.database.transaction(async (client) => {
        const principal = await client.query<{
          status: "active" | "suspended" | "archived";
        }>("SELECT status FROM principals WHERE id = $1 FOR UPDATE", [
          input.principalId,
        ]);
        const row = principal.rows[0];
        if (row === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "not_found",
            "Principal not found",
            404,
          );
        }
        if (row.status !== "active") {
          throw new IdentityAdministrationRepositoryError(
            "principal_archived",
            "Suspended or archived Principals cannot receive a new Grant",
            409,
          );
        }
        await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           ) VALUES (
             $1, $2, 'platform', 'platform', $3, $4::jsonb,
             'active', 'platform-role', 'identity-administration:platform', $5,
             NULL, $6, $7, NULL, 1, $6, $6
           )`,
          [
            grantId,
            input.principalId,
            input.roleKey,
            JSON.stringify(platformPermissionsForRole(input.roleKey)),
            actorPrincipalId,
            now,
            input.expiresAt === null ? null : new Date(input.expiresAt),
          ],
        );
        await this.audit(client, {
          action: "identity.platform_grant.created",
          actorPrincipalId,
          subjectPrincipalId: input.principalId,
          grantId,
          metadata: {
            roleKey: input.roleKey,
            expiresAt: input.expiresAt,
          },
        });
      });
    } catch (error) {
      if (
        pgErrorCode(error) === "23505" &&
        pgConstraint(error) === "role_grants_active_scope_role_idx"
      ) {
        throw new IdentityAdministrationRepositoryError(
          "grant_exists",
          "An active platform Grant already exists for this Principal and role",
          409,
        );
      }
      throw error;
    }
    const created = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(created.rows[0]!);
  }

  async updatePlatformGrantExpiry(
    actorPrincipalId: string,
    grantId: string,
    input: UpdateGrantExpiryInput,
  ): Promise<RoleGrant> {
    const now = this.now();
    if (
      input.expiresAt !== null &&
      Date.parse(input.expiresAt) <= now.getTime()
    ) {
      throw new IdentityAdministrationRepositoryError(
        "invalid_expiry",
        "Grant expiry must be in the future",
        400,
      );
    }
    await this.database.transaction(async (client) => {
      const result = await client.query<RoleGrantRow>(
        `SELECT * FROM role_grants
         WHERE id = $1 AND scope_type = 'platform' AND scope_id = 'platform'
         FOR UPDATE`,
        [grantId],
      );
      const grant = result.rows[0];
      if (grant === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_found",
          "Platform Grant not found",
          404,
        );
      }
      if (grant.status !== "active") {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_active",
          "Only an active Grant can change expiry",
          409,
        );
      }
      if (grant.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Grant changed before this request was applied",
          409,
        );
      }
      const currentExpiry = grant.expires_at?.toISOString() ?? null;
      if (currentExpiry === input.expiresAt) return;
      await client.query(
        `UPDATE role_grants
         SET expires_at = $2, updated_at = $3, version = version + 1
         WHERE id = $1`,
        [
          grantId,
          input.expiresAt === null ? null : new Date(input.expiresAt),
          now,
        ],
      );
      await this.audit(client, {
        action: "identity.platform_grant.expiry_updated",
        actorPrincipalId,
        subjectPrincipalId: grant.principal_id,
        grantId,
        metadata: { before: currentExpiry, after: input.expiresAt },
      });
    });
    const updated = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(updated.rows[0]!);
  }

  async revokePlatformGrant(
    actorPrincipalId: string,
    grantId: string,
    input: RevokeGrantInput,
  ): Promise<RoleGrant> {
    await this.expirePlatformGrants();
    await this.database.transaction(async (client) => {
      const result = await client.query<RoleGrantRow>(
        `SELECT * FROM role_grants
         WHERE id = $1 AND scope_type = 'platform' AND scope_id = 'platform'
         FOR UPDATE`,
        [grantId],
      );
      const grant = result.rows[0];
      if (grant === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_found",
          "Platform Grant not found",
          404,
        );
      }
      if (grant.status !== "active") {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_active",
          "The Grant is no longer active",
          409,
        );
      }
      if (grant.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Grant changed before this request was applied",
          409,
        );
      }
      if (grant.role_key === "ADMIN") {
        const otherAdmins = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM role_grants AS grant_row
           JOIN principals AS principal
             ON principal.id = grant_row.principal_id
           LEFT JOIN accounts AS account
             ON account.principal_id = principal.id
           WHERE grant_row.id <> $1
             AND grant_row.scope_type = 'platform'
             AND grant_row.scope_id = 'platform'
             AND grant_row.role_key = 'ADMIN'
             AND grant_row.status = 'active'
             AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $2)
             AND principal.status = 'active'
             AND (principal.kind = 'ai' OR account.status = 'active')`,
          [grantId, this.now()],
        );
        if (numberValue(otherAdmins.rows[0]?.count ?? 0) === 0) {
          throw new IdentityAdministrationRepositoryError(
            "last_platform_admin",
            "The last active platform administrator Grant cannot be revoked",
            409,
          );
        }
      }
      const now = this.now();
      await client.query(
        `UPDATE role_grants
         SET status = 'revoked', revoked_by_principal_id = $2,
             revoked_at = $3, updated_at = $3, version = version + 1
         WHERE id = $1 AND status = 'active'`,
        [grantId, actorPrincipalId, now],
      );
      await this.audit(client, {
        action: "identity.platform_grant.revoked",
        actorPrincipalId,
        subjectPrincipalId: grant.principal_id,
        grantId,
        reason: input.reason,
        metadata: { roleKey: grant.role_key },
      });
    });
    const revoked = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(revoked.rows[0]!);
  }

  private workspaceSelect(): string {
    return `
      SELECT
        workspace.id,
        workspace.display_name,
        workspace.status,
        workspace.created_by_principal_id,
        workspace.version,
        workspace.created_at,
        workspace.updated_at,
        (
          SELECT COUNT(*)::int
          FROM workspace_members AS member
          WHERE member.workspace_id = workspace.id
            AND member.status = 'active'
        ) AS member_count,
        (
          SELECT COUNT(*)::int
          FROM role_grants AS grant_row
          WHERE grant_row.scope_type = 'workspace'
            AND grant_row.scope_id = workspace.id
            AND grant_row.status = 'active'
            AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $1)
        ) AS active_grant_count
      FROM workspaces AS workspace
    `;
  }

  async listWorkspaces(input: {
    readonly principalId: string;
    readonly platformAdministrator: boolean;
    readonly query: WorkspaceListQuery;
  }): Promise<Workspace[]> {
    const values: unknown[] = [this.now()];
    const conditions: string[] = [];
    if (!input.platformAdministrator) {
      values.push(input.principalId);
      conditions.push(
        `EXISTS (
           SELECT 1 FROM workspace_members AS membership
           WHERE membership.workspace_id = workspace.id
             AND membership.principal_id = $${values.length}
             AND membership.status = 'active'
         )`,
      );
    }
    if (input.query.status !== undefined) {
      values.push(input.query.status);
      conditions.push(`workspace.status = $${values.length}`);
    } else if (!input.query.includeArchived) {
      conditions.push("workspace.status = 'active'");
    }
    if (input.query.query !== undefined && input.query.query !== "") {
      values.push(`%${input.query.query.toLowerCase()}%`);
      conditions.push(
        `(lower(workspace.id) LIKE $${values.length} OR lower(workspace.display_name) LIKE $${values.length})`,
      );
    }
    const where =
      conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = await this.database.query<WorkspaceRow>(
      `${this.workspaceSelect()}
       ${where}
       ORDER BY workspace.status = 'active' DESC,
                workspace.display_name, workspace.id`,
      values,
    );
    return rows.rows.map(workspaceFromRow);
  }

  async getWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceDetail | undefined> {
    const workspaceResult = await this.database.query<WorkspaceRow>(
      `${this.workspaceSelect()} WHERE workspace.id = $2 LIMIT 1`,
      [this.now(), workspaceId],
    );
    const workspace = workspaceResult.rows[0];
    if (workspace === undefined) return undefined;
    const [members, grants] = await Promise.all([
      this.database.query<WorkspaceMemberRow>(
        `SELECT wm.id, wm.workspace_id, wm.principal_id, wm.status, wm.version,
                wm.created_at, wm.updated_at,
                p.display_name, p.kind AS principal_kind,
                p.status AS principal_status
         FROM workspace_members AS wm
         JOIN principals AS p ON p.id = wm.principal_id
         WHERE wm.workspace_id = $1
         ORDER BY wm.status = 'active' DESC, p.display_name, wm.id`,
        [workspaceId],
      ),
      this.database.query<RoleGrantRow>(
        `SELECT *
         FROM role_grants
         WHERE scope_type = 'workspace' AND scope_id = $1
         ORDER BY status = 'active' DESC, granted_at DESC, id DESC`,
        [workspaceId],
      ),
    ]);
    const grantsByPrincipal = new Map<string, RoleGrant[]>();
    for (const row of grants.rows) {
      const grant = grantFromRow(row);
      const items = grantsByPrincipal.get(row.principal_id) ?? [];
      items.push(grant);
      grantsByPrincipal.set(row.principal_id, items);
    }
    const memberDetails: WorkspaceMemberDetail[] = members.rows.map((row) => ({
      ...workspaceMemberFromRow(row),
      displayName: row.display_name,
      principalKind: row.principal_kind,
      principalStatus: row.principal_status,
      grants: grantsByPrincipal.get(row.principal_id) ?? [],
    }));
    return {
      workspace: workspaceFromRow(workspace),
      members: memberDetails,
      grants: grants.rows.map(grantFromRow),
    };
  }

  async createWorkspace(
    actorPrincipalId: string,
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceDetail> {
    const workspaceId = input.id ?? `workspace-${randomUUID()}`;
    const now = this.now();
    try {
      await this.database.transaction(async (client) => {
        await client.query(
          `INSERT INTO workspaces (
             id, display_name, status, created_by_principal_id, version,
             created_at, updated_at
           ) VALUES ($1, $2, 'active', $3, 1, $4, $4)`,
          [workspaceId, input.displayName, actorPrincipalId, now],
        );
        const membershipId = randomUUID();
        await client.query(
          `INSERT INTO workspace_members (
             id, workspace_id, principal_id, status, version, created_at, updated_at
           ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
          [membershipId, workspaceId, actorPrincipalId, now],
        );
        const grantId = randomUUID();
        await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           ) VALUES (
             $1, $2, 'workspace', $3, 'ADMIN', $4::jsonb,
             'active', 'workspace-role', 'workspace-created:administrator', $2,
             NULL, $5, NULL, NULL, 1, $5, $5
           )`,
          [
            grantId,
            actorPrincipalId,
            workspaceId,
            JSON.stringify(workspacePermissionsForRole("ADMIN")),
            now,
          ],
        );
        await this.audit(client, {
          action: "identity.workspace.created",
          actorPrincipalId,
          subjectPrincipalId: actorPrincipalId,
          grantId,
          metadata: { workspaceId, displayName: input.displayName },
        });
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        throw new IdentityAdministrationRepositoryError(
          "workspace_exists",
          "A Workspace with this identifier already exists",
          409,
        );
      }
      throw error;
    }
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "workspace_not_found",
        "Created Workspace could not be read",
        404,
      );
    }
    return workspace;
  }

  async updateWorkspace(
    actorPrincipalId: string,
    workspaceId: string,
    input: UpdateWorkspaceInput,
  ): Promise<WorkspaceDetail> {
    await this.database.transaction(async (client) => {
      const result = await client.query<WorkspaceRow>(
        `${this.workspaceSelect()} WHERE workspace.id = $2 FOR UPDATE OF workspace`,
        [this.now(), workspaceId],
      );
      const workspace = result.rows[0];
      if (workspace === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "workspace_not_found",
          "Workspace not found",
          404,
        );
      }
      if (workspace.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Workspace changed before this request was applied",
          409,
        );
      }
      if (
        workspace.status === "archived" &&
        input.status !== undefined &&
        input.status !== "archived"
      ) {
        throw new IdentityAdministrationRepositoryError(
          "workspace_archived",
          "Archived Workspaces must be restored through an explicit compatibility process",
          409,
        );
      }
      await client.query(
        `UPDATE workspaces
         SET display_name = COALESCE($2, display_name),
             status = COALESCE($3, status),
             updated_at = $4,
             version = version + 1
         WHERE id = $1`,
        [
          workspaceId,
          input.displayName ?? null,
          input.status ?? null,
          this.now(),
        ],
      );
      await this.audit(client, {
        action: "identity.workspace.updated",
        actorPrincipalId,
        metadata: {
          workspaceId,
          displayNameChanged: input.displayName !== undefined,
          status: input.status,
        },
      });
    });
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "workspace_not_found",
        "Workspace not found",
        404,
      );
    }
    return workspace;
  }

  async addWorkspaceMember(
    actorPrincipalId: string,
    workspaceId: string,
    input: AddWorkspaceMemberInput,
  ): Promise<WorkspaceDetail> {
    try {
      await this.database.transaction(async (client) => {
        const workspace = await client.query<{
          status: "active" | "archived";
        }>("SELECT status FROM workspaces WHERE id = $1 FOR UPDATE", [
          workspaceId,
        ]);
        if (workspace.rows[0] === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "workspace_not_found",
            "Workspace not found",
            404,
          );
        }
        if (workspace.rows[0].status !== "active") {
          throw new IdentityAdministrationRepositoryError(
            "workspace_archived",
            "Archived Workspaces cannot accept members",
            409,
          );
        }
        const principal = await client.query<{
          status: "active" | "suspended" | "archived";
        }>("SELECT status FROM principals WHERE id = $1 FOR UPDATE", [
          input.principalId,
        ]);
        if (principal.rows[0] === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "not_found",
            "Principal not found",
            404,
          );
        }
        if (principal.rows[0].status !== "active") {
          throw new IdentityAdministrationRepositoryError(
            "principal_archived",
            "Suspended or archived Principals cannot join a Workspace",
            409,
          );
        }
        const membershipId = randomUUID();
        await client.query(
          `INSERT INTO workspace_members (
             id, workspace_id, principal_id, status, version, created_at, updated_at
           ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
          [membershipId, workspaceId, input.principalId, this.now()],
        );
        await this.audit(client, {
          action: "identity.workspace_member.added",
          actorPrincipalId,
          subjectPrincipalId: input.principalId,
          metadata: { workspaceId, membershipId },
        });
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        throw new IdentityAdministrationRepositoryError(
          "membership_exists",
          "The Principal is already a member of this Workspace",
          409,
        );
      }
      throw error;
    }
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "workspace_not_found",
        "Workspace not found",
        404,
      );
    }
    return workspace;
  }

  private async hasWorkspaceAdminGrant(
    client: PoolClient,
    workspaceId: string,
    principalId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'workspace'
         AND scope_id = $2
         AND role_key = 'ADMIN'
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $3)
       LIMIT 1`,
      [principalId, workspaceId, this.now()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async assertNotLastWorkspaceAdmin(
    client: PoolClient,
    workspaceId: string,
    principalId: string,
  ): Promise<void> {
    const others = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM workspace_members AS member
       JOIN role_grants AS grant_row
         ON grant_row.principal_id = member.principal_id
        AND grant_row.scope_type = 'workspace'
        AND grant_row.scope_id = member.workspace_id
       WHERE member.workspace_id = $1
         AND member.principal_id <> $2
         AND member.status = 'active'
         AND grant_row.role_key = 'ADMIN'
         AND grant_row.status = 'active'
         AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $3)`,
      [workspaceId, principalId, this.now()],
    );
    if (numberValue(others.rows[0]?.count ?? 0) === 0) {
      throw new IdentityAdministrationRepositoryError(
        "last_workspace_admin",
        "The last active Workspace administrator cannot be removed",
        409,
      );
    }
  }

  async updateWorkspaceMemberStatus(
    actorPrincipalId: string,
    workspaceId: string,
    memberId: string,
    input: UpdateWorkspaceMemberStatusInput,
  ): Promise<WorkspaceDetail> {
    await this.database.transaction(async (client) => {
      const result = await client.query<WorkspaceMemberRow>(
        `SELECT wm.id, wm.workspace_id, wm.principal_id, wm.status, wm.version,
                wm.created_at, wm.updated_at,
                p.display_name, p.kind AS principal_kind,
                p.status AS principal_status
         FROM workspace_members AS wm
         JOIN principals AS p ON p.id = wm.principal_id
         WHERE wm.workspace_id = $1 AND wm.id = $2
         FOR UPDATE OF wm`,
        [workspaceId, memberId],
      );
      const member = result.rows[0];
      if (member === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "membership_not_found",
          "Workspace membership not found",
          404,
        );
      }
      if (member.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Workspace membership changed before this request was applied",
          409,
        );
      }
      if (input.status === member.status) return;
      if (
        input.status === "inactive" &&
        (await this.hasWorkspaceAdminGrant(
          client,
          workspaceId,
          member.principal_id,
        ))
      ) {
        await this.assertNotLastWorkspaceAdmin(
          client,
          workspaceId,
          member.principal_id,
        );
      }
      const now = this.now();
      await client.query(
        `UPDATE workspace_members
         SET status = $2, updated_at = $3, version = version + 1
         WHERE id = $1`,
        [memberId, input.status, now],
      );
      if (input.status === "inactive") {
        const grants = await client.query<RoleGrantRow>(
          `SELECT * FROM role_grants
           WHERE principal_id = $1
             AND scope_type = 'workspace'
             AND scope_id = $2
             AND status = 'active'
           FOR UPDATE`,
          [member.principal_id, workspaceId],
        );
        for (const grant of grants.rows) {
          await client.query(
            `UPDATE role_grants
             SET status = 'revoked', revoked_by_principal_id = $2,
                 revoked_at = $3, updated_at = $3, version = version + 1
             WHERE id = $1`,
            [grant.id, actorPrincipalId, now],
          );
          await this.audit(client, {
            action: "identity.workspace_grant.revoked",
            actorPrincipalId,
            subjectPrincipalId: grant.principal_id,
            grantId: grant.id,
            reason: "workspace_membership_inactive",
            metadata: { workspaceId, roleKey: grant.role_key },
          });
        }
      }
      await this.audit(client, {
        action: `identity.workspace_member.${input.status}`,
        actorPrincipalId,
        subjectPrincipalId: member.principal_id,
        metadata: { workspaceId, memberId },
      });
    });
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace === undefined) {
      throw new IdentityAdministrationRepositoryError(
        "workspace_not_found",
        "Workspace not found",
        404,
      );
    }
    return workspace;
  }

  async createWorkspaceGrant(
    actorPrincipalId: string,
    workspaceId: string,
    input: CreateWorkspaceGrantInput,
  ): Promise<RoleGrant> {
    const now = this.now();
    if (
      input.expiresAt !== null &&
      Date.parse(input.expiresAt) <= now.getTime()
    ) {
      throw new IdentityAdministrationRepositoryError(
        "invalid_expiry",
        "Grant expiry must be in the future",
        400,
      );
    }
    const grantId = randomUUID();
    try {
      await this.database.transaction(async (client) => {
        const workspace = await client.query<{
          status: "active" | "archived";
        }>("SELECT status FROM workspaces WHERE id = $1 FOR UPDATE", [
          workspaceId,
        ]);
        if (workspace.rows[0] === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "workspace_not_found",
            "Workspace not found",
            404,
          );
        }
        if (workspace.rows[0].status !== "active") {
          throw new IdentityAdministrationRepositoryError(
            "workspace_archived",
            "Archived Workspaces cannot receive Grants",
            409,
          );
        }
        const membership = await client.query<{
          status: "active" | "inactive";
        }>(
          `SELECT status FROM workspace_members
           WHERE workspace_id = $1 AND principal_id = $2
           FOR UPDATE`,
          [workspaceId, input.principalId],
        );
        if (membership.rows[0] === undefined) {
          throw new IdentityAdministrationRepositoryError(
            "membership_not_found",
            "The Principal must join the Workspace before receiving a Grant",
            404,
          );
        }
        if (membership.rows[0].status !== "active") {
          throw new IdentityAdministrationRepositoryError(
            "membership_not_found",
            "An inactive Workspace member cannot receive a Grant",
            409,
          );
        }
        await client.query(
          `INSERT INTO role_grants (
             id, principal_id, scope_type, scope_id, role_key, permissions,
             status, source_kind, source_ref, granted_by_principal_id,
             revoked_by_principal_id, granted_at, expires_at, revoked_at,
             version, created_at, updated_at
           ) VALUES (
             $1, $2, 'workspace', $3, $4, $5::jsonb,
             'active', 'workspace-role', 'identity-administration:workspace', $6,
             NULL, $7, $8, NULL, 1, $7, $7
           )`,
          [
            grantId,
            input.principalId,
            workspaceId,
            input.roleKey,
            JSON.stringify(workspacePermissionsForRole(input.roleKey)),
            actorPrincipalId,
            now,
            input.expiresAt === null ? null : new Date(input.expiresAt),
          ],
        );
        await this.audit(client, {
          action: "identity.workspace_grant.created",
          actorPrincipalId,
          subjectPrincipalId: input.principalId,
          grantId,
          metadata: {
            workspaceId,
            roleKey: input.roleKey,
            expiresAt: input.expiresAt,
          },
        });
      });
    } catch (error) {
      if (
        pgErrorCode(error) === "23505" &&
        pgConstraint(error) === "role_grants_active_scope_role_idx"
      ) {
        throw new IdentityAdministrationRepositoryError(
          "grant_exists",
          "An active Workspace Grant already exists for this Principal and role",
          409,
        );
      }
      throw error;
    }
    const created = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(created.rows[0]!);
  }

  async updateWorkspaceGrantExpiry(
    actorPrincipalId: string,
    workspaceId: string,
    grantId: string,
    input: UpdateGrantExpiryInput,
  ): Promise<RoleGrant> {
    const now = this.now();
    if (
      input.expiresAt !== null &&
      Date.parse(input.expiresAt) <= now.getTime()
    ) {
      throw new IdentityAdministrationRepositoryError(
        "invalid_expiry",
        "Grant expiry must be in the future",
        400,
      );
    }
    await this.database.transaction(async (client) => {
      const workspace = await client.query<{
        status: "active" | "archived";
      }>("SELECT status FROM workspaces WHERE id = $1 FOR UPDATE", [
        workspaceId,
      ]);
      if (workspace.rows[0] === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "workspace_not_found",
          "Workspace not found",
          404,
        );
      }
      if (workspace.rows[0].status !== "active") {
        throw new IdentityAdministrationRepositoryError(
          "workspace_archived",
          "Archived Workspaces cannot change Grants",
          409,
        );
      }
      const result = await client.query<RoleGrantRow>(
        `SELECT * FROM role_grants
         WHERE id = $1 AND scope_type = 'workspace' AND scope_id = $2
         FOR UPDATE`,
        [grantId, workspaceId],
      );
      const grant = result.rows[0];
      if (grant === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_found",
          "Workspace Grant not found",
          404,
        );
      }
      if (grant.status !== "active") {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_active",
          "Only an active Grant can change expiry",
          409,
        );
      }
      if (grant.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Grant changed before this request was applied",
          409,
        );
      }
      const currentExpiry = grant.expires_at?.toISOString() ?? null;
      if (currentExpiry === input.expiresAt) return;
      await client.query(
        `UPDATE role_grants
         SET expires_at = $2, updated_at = $3, version = version + 1
         WHERE id = $1`,
        [
          grantId,
          input.expiresAt === null ? null : new Date(input.expiresAt),
          now,
        ],
      );
      await this.audit(client, {
        action: "identity.workspace_grant.expiry_updated",
        actorPrincipalId,
        subjectPrincipalId: grant.principal_id,
        grantId,
        metadata: {
          workspaceId,
          before: currentExpiry,
          after: input.expiresAt,
        },
      });
    });
    const updated = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(updated.rows[0]!);
  }

  async revokeWorkspaceGrant(
    actorPrincipalId: string,
    workspaceId: string,
    grantId: string,
    input: RevokeGrantInput,
  ): Promise<RoleGrant> {
    await this.database.transaction(async (client) => {
      const result = await client.query<RoleGrantRow>(
        `SELECT * FROM role_grants
         WHERE id = $1 AND scope_type = 'workspace' AND scope_id = $2
         FOR UPDATE`,
        [grantId, workspaceId],
      );
      const grant = result.rows[0];
      if (grant === undefined) {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_found",
          "Workspace Grant not found",
          404,
        );
      }
      if (grant.status !== "active") {
        throw new IdentityAdministrationRepositoryError(
          "grant_not_active",
          "The Grant is no longer active",
          409,
        );
      }
      if (grant.version !== input.expectedVersion) {
        throw new IdentityAdministrationRepositoryError(
          "version_conflict",
          "The Grant changed before this request was applied",
          409,
        );
      }
      if (grant.role_key === "ADMIN") {
        await this.assertNotLastWorkspaceAdmin(
          client,
          workspaceId,
          grant.principal_id,
        );
      }
      const now = this.now();
      await client.query(
        `UPDATE role_grants
         SET status = 'revoked', revoked_by_principal_id = $2,
             revoked_at = $3, updated_at = $3, version = version + 1
         WHERE id = $1 AND status = 'active'`,
        [grantId, actorPrincipalId, now],
      );
      await this.audit(client, {
        action: "identity.workspace_grant.revoked",
        actorPrincipalId,
        subjectPrincipalId: grant.principal_id,
        grantId,
        reason: input.reason,
        metadata: { workspaceId, roleKey: grant.role_key },
      });
    });
    const revoked = await this.database.query<RoleGrantRow>(
      "SELECT * FROM role_grants WHERE id = $1",
      [grantId],
    );
    return grantFromRow(revoked.rows[0]!);
  }
}
