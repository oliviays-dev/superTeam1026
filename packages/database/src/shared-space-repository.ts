import { randomUUID } from "node:crypto";
import type {
  ExecutionGateRequest,
  SharedSpaceAuditAction,
  SharedSpaceAuditEvent,
  SharedSpaceAuditPage,
  SharedSpaceAuditQuery,
  SharedSpaceClaim,
  SharedSpaceDigest,
  SharedSpaceEntry,
  SharedSpaceLock,
  SharedSpaceLockMode,
  SharedSpacePolicy,
  SharedSpacePolicyEffect,
  SharedSpacePolicyPermission,
  SharedSpaceRoot,
  SharedSpaceSubjectKind,
  SharedSpaceVersion,
  SharedSpaceWriteRequest,
  SharedSpaceWriteRequestScope,
} from "@pluginmax/contracts";
import {
  normalizeSharedSpacePath,
  normalizeSharedSpacePathPattern,
} from "@pluginmax/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import { ActionTicketRepository } from "./action-ticket-repository.js";
import type { Database } from "./database.js";

export class SharedSpaceRepositoryError extends Error {
  constructor(
    readonly code:
      | "shared_space_not_found"
      | "shared_space_conflict"
      | "shared_space_version_conflict"
      | "shared_space_lock_conflict"
      | "shared_space_lock_expired"
      | "shared_space_parent_missing"
      | "shared_space_request_conflict"
      | "shared_space_request_expired"
      | "shared_space_request_not_approved"
      | "shared_space_request_consumed",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "SharedSpaceRepositoryError";
  }
}

interface QueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: T[]; readonly rowCount: number | null }>;
}

interface RootRow {
  workspace_id: string;
  status: "active" | "archived";
  default_read: boolean;
  default_write: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  id: string;
  workspace_id: string;
  subject_kind: SharedSpaceSubjectKind;
  subject_id: string;
  path_pattern: string;
  permissions: SharedSpacePolicyPermission[];
  effect: SharedSpacePolicyEffect;
  status: "active" | "revoked";
  expires_at: Date | null;
  created_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface EntryRow {
  id: string;
  workspace_id: string;
  path: string;
  kind: "file" | "directory";
  status: "active" | "archived";
  current_version: number;
  sha256: string | null;
  size: string | number;
  mime_type: string | null;
  storage_key: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  entry_id: string;
  workspace_id: string;
  path: string;
  version: number;
  sha256: string;
  size: string | number;
  mime_type: string;
  created_by: string;
  source_run_id: string | null;
  ticket_id: string | null;
  gate_id: string | null;
  created_at: Date;
}

interface LockRow {
  id: string;
  workspace_id: string;
  path: string;
  owner_principal_id: string;
  owner_session_id: string | null;
  run_id: string | null;
  mode: SharedSpaceLockMode;
  status: "active" | "released" | "expired";
  lease_expires_at: Date;
  version: number;
  acquired_at: Date;
  released_at: Date | null;
}

interface ClaimRow {
  id: string;
  workspace_id: string;
  path: string;
  owner_principal_id: string;
  owner_session_id: string;
  run_id: string | null;
  note: string;
  status: "active" | "released" | "expired";
  lease_expires_at: Date;
  version: number;
  claimed_at: Date;
  released_at: Date | null;
}

interface WriteRequestRow {
  id: string;
  scope: SharedSpaceWriteRequestScope;
  operation: "write" | "move" | "delete";
  source_workspace_id: string;
  source_entry_id: string | null;
  actor_principal_id: string;
  target_path: string;
  name: string;
  mime_type: string;
  size: string | number;
  sha256: string;
  storage_key: string;
  purpose: string;
  expected_version: number;
  policy_revision: number;
  status: SharedSpaceWriteRequest["status"];
  run_id: string | null;
  scene_session_id: string | null;
  ticket_id: string | null;
  gate_id: string | null;
  requested_at: Date;
  expires_at: Date;
  decided_by_principal_id: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  consumed_at: Date | null;
  result_entry_id: string | null;
  result_version: number | null;
}

interface AuditRow {
  id: string;
  workspace_id: string;
  actor_principal_id: string | null;
  action: SharedSpaceAuditAction;
  path: string | null;
  entry_id: string | null;
  version: number | null;
  decision: "allowed" | "denied";
  reason: string;
  run_id: string | null;
  scene_session_id: string | null;
  ticket_id: string | null;
  gate_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface DigestRow {
  id: string;
  workspace_id: string;
  scene_session_id: string | null;
  digest_date: Date | string;
  content: string;
  event_from: string | null;
  event_to: string | null;
  generated_by: string;
  generated_at: Date;
}

interface WorkspaceRoleRow {
  role_key: string;
  permissions: string[];
}

export interface CreateDirectoryRepositoryInput {
  readonly workspaceId: string;
  readonly path: string;
  readonly actorPrincipalId: string;
}

export interface CommitFileRepositoryInput {
  readonly workspaceId: string;
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly actorPrincipalId: string;
  readonly expectedVersion: number;
  readonly lockId: string | null;
  readonly runId?: string | null;
  readonly sceneSessionId?: string | null;
  readonly ticketId?: string | null;
  readonly gateId?: string | null;
}

export interface CreateWriteRequestRepositoryInput {
  readonly id: string;
  readonly scope: SharedSpaceWriteRequestScope;
  readonly operation: "write" | "move" | "delete";
  readonly sourceWorkspaceId: string;
  readonly sourceEntryId: string | null;
  readonly actorPrincipalId: string;
  readonly targetPath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly purpose: string;
  readonly expectedVersion: number;
  readonly policyRevision: number;
  readonly runId: string | null;
  readonly sceneSessionId: string | null;
  readonly ticketId: string | null;
  readonly gateId: string | null;
  readonly gate: ExecutionGateRequest | null;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
}

export interface ConsumeWriteRequestRepositoryInput {
  readonly requestId: string;
  readonly actorPrincipalId: string;
  readonly lockId: string | null;
}

export interface SharedSpaceAuditInput {
  readonly workspaceId: string;
  readonly actorPrincipalId?: string | null;
  readonly action: SharedSpaceAuditAction;
  readonly path?: string | null;
  readonly entryId?: string | null;
  readonly version?: number | null;
  readonly decision: "allowed" | "denied";
  readonly reason?: string;
  readonly runId?: string | null;
  readonly sceneSessionId?: string | null;
  readonly ticketId?: string | null;
  readonly gateId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface SharedSpaceSceneBinding {
  readonly id: string;
  readonly sceneType: "task" | "workflow-node" | "meeting" | "direct-chat";
  readonly sceneId: string;
  readonly projectId: string | null;
  readonly agentPrincipalId: string | null;
  readonly ownerPrincipalId: string | null;
  readonly status: "active" | "archived" | "reset";
}

function numberValue(value: string | number | null | undefined): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function iso(value: Date): string {
  return value.toISOString();
}

function arrayValue(values: readonly string[]): string {
  return `{${values
    .map(
      (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(",")}}`;
}

function rootFromRow(row: RootRow): SharedSpaceRoot {
  return {
    workspaceId: row.workspace_id,
    status: row.status,
    defaultRead: row.default_read,
    defaultWrite: false,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function policyFromRow(row: PolicyRow): SharedSpacePolicy {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    pathPattern: row.path_pattern,
    permissions: row.permissions,
    effect: row.effect,
    status: row.status,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    createdBy: row.created_by,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function entryFromRow(row: EntryRow): SharedSpaceEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    name: row.path.split("/").at(-1) ?? row.path,
    kind: row.kind,
    status: row.status,
    currentVersion: row.current_version,
    sha256: row.sha256,
    size: numberValue(row.size),
    mimeType: row.mime_type,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    effectivePermissions: {
      list: false,
      read: false,
      write: false,
      delete: false,
    },
    currentLock: null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function versionFromRow(row: VersionRow): SharedSpaceVersion {
  return {
    id: row.id,
    entryId: row.entry_id,
    workspaceId: row.workspace_id,
    path: row.path,
    version: row.version,
    sha256: row.sha256,
    size: numberValue(row.size),
    mimeType: row.mime_type,
    createdBy: row.created_by,
    sourceRunId: row.source_run_id,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    createdAt: iso(row.created_at),
  };
}

function lockFromRow(row: LockRow): SharedSpaceLock {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    ownerPrincipalId: row.owner_principal_id,
    ownerSessionId: row.owner_session_id,
    runId: row.run_id,
    mode: row.mode,
    status: row.status,
    leaseExpiresAt: iso(row.lease_expires_at),
    version: row.version,
    acquiredAt: iso(row.acquired_at),
    releasedAt: row.released_at === null ? null : iso(row.released_at),
  };
}

function claimFromRow(row: ClaimRow): SharedSpaceClaim {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    ownerPrincipalId: row.owner_principal_id,
    ownerSessionId: row.owner_session_id,
    runId: row.run_id,
    note: row.note,
    status: row.status,
    leaseExpiresAt: iso(row.lease_expires_at),
    version: row.version,
    claimedAt: iso(row.claimed_at),
    releasedAt: row.released_at === null ? null : iso(row.released_at),
  };
}

function writeRequestFromRow(row: WriteRequestRow): SharedSpaceWriteRequest {
  return {
    id: row.id,
    scope: row.scope,
    operation: row.operation,
    sourceWorkspaceId: row.source_workspace_id,
    sourceEntryId: row.source_entry_id,
    actorPrincipalId: row.actor_principal_id,
    targetPath: row.target_path,
    name: row.name,
    mimeType: row.mime_type,
    size: numberValue(row.size),
    sha256: row.sha256,
    purpose: row.purpose,
    expectedVersion: row.expected_version,
    policyRevision: row.policy_revision,
    status: row.status,
    runId: row.run_id,
    sceneSessionId: row.scene_session_id,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    requestedAt: iso(row.requested_at),
    expiresAt: iso(row.expires_at),
    decidedByPrincipalId: row.decided_by_principal_id,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at === null ? null : iso(row.decided_at),
    consumedAt: row.consumed_at === null ? null : iso(row.consumed_at),
    resultEntryId: row.result_entry_id,
    resultVersion: row.result_version,
  };
}

function auditFromRow(row: AuditRow): SharedSpaceAuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorPrincipalId: row.actor_principal_id,
    action: row.action,
    path: row.path,
    entryId: row.entry_id,
    version: row.version,
    decision: row.decision,
    reason: row.reason,
    runId: row.run_id,
    sceneSessionId: row.scene_session_id,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  };
}

function digestFromRow(row: DigestRow): SharedSpaceDigest {
  const digestDate =
    row.digest_date instanceof Date
      ? row.digest_date.toISOString().slice(0, 10)
      : row.digest_date;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sceneSessionId: row.scene_session_id,
    digestDate,
    content: row.content,
    eventFrom: row.event_from,
    eventTo: row.event_to,
    generatedBy: row.generated_by,
    generatedAt: iso(row.generated_at),
  };
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  try {
    const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export class SharedSpaceRepository {
  constructor(
    private readonly database: Database,
    private readonly actionTickets: ActionTicketRepository,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async ensureRoot(workspaceId: string): Promise<SharedSpaceRoot> {
    const result = await this.database.query<RootRow>(
      `INSERT INTO shared_space_roots (
         workspace_id, storage_prefix, status, default_read, default_write,
         version, created_at, updated_at
       )
       SELECT id, 'shared/' || md5(id), 'active', TRUE, FALSE, 1, $2, $2
       FROM workspaces
       WHERE id = $1
       ON CONFLICT (workspace_id) DO NOTHING
       RETURNING *`,
      [workspaceId, this.now()],
    );
    if (result.rows[0] !== undefined) return rootFromRow(result.rows[0]);
    const existing = await this.getRoot(workspaceId);
    if (existing === undefined) {
      throw new SharedSpaceRepositoryError(
        "shared_space_not_found",
        "Workspace Shared Space root not found",
        404,
      );
    }
    return existing;
  }

  async getRoot(workspaceId: string): Promise<SharedSpaceRoot | undefined> {
    const result = await this.database.query<RootRow>(
      "SELECT * FROM shared_space_roots WHERE workspace_id = $1",
      [workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : rootFromRow(row);
  }

  async getSceneBinding(
    sceneSessionId: string,
  ): Promise<SharedSpaceSceneBinding | undefined> {
    const result = await this.database.query<{
      id: string;
      scene_type: SharedSpaceSceneBinding["sceneType"];
      scene_id: string;
      project_id: string | null;
      agent_principal_id: string | null;
      owner_principal_id: string | null;
      status: SharedSpaceSceneBinding["status"];
    }>(
      `SELECT
         id, scene_type, scene_id, project_id, agent_principal_id,
         owner_principal_id, status
       FROM scene_sessions
       WHERE id = $1`,
      [sceneSessionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          sceneType: row.scene_type,
          sceneId: row.scene_id,
          projectId: row.project_id,
          agentPrincipalId: row.agent_principal_id,
          ownerPrincipalId: row.owner_principal_id,
          status: row.status,
        };
  }

  async updateRoot(input: {
    readonly workspaceId: string;
    readonly status?: "active" | "archived";
    readonly defaultRead?: boolean;
    readonly expectedVersion: number;
    readonly actorPrincipalId: string;
  }): Promise<SharedSpaceRoot> {
    return this.database.transaction(async (client) => {
      const result = await client.query<RootRow>(
        `UPDATE shared_space_roots
         SET status = COALESCE($2, status),
             default_read = COALESCE($3, default_read),
             version = version + 1,
             updated_at = $4
         WHERE workspace_id = $1 AND version = $5
         RETURNING *`,
        [
          input.workspaceId,
          input.status ?? null,
          input.defaultRead ?? null,
          this.now(),
          input.expectedVersion,
        ],
      );
      if (result.rows[0] === undefined) {
        const existing = await client.query(
          "SELECT 1 FROM shared_space_roots WHERE workspace_id = $1",
          [input.workspaceId],
        );
        if (existing.rowCount === 0) {
          throw new SharedSpaceRepositoryError(
            "shared_space_not_found",
            "Workspace Shared Space root not found",
            404,
          );
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "The Shared Space root changed before this request was applied",
        );
      }
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.update",
        decision: "allowed",
        reason: "shared-space-root-updated",
        metadata: {
          version: result.rows[0].version,
          defaultRead: result.rows[0].default_read,
          status: result.rows[0].status,
        },
      });
      return rootFromRow(result.rows[0]);
    });
  }

  async listPolicies(workspaceId: string): Promise<SharedSpacePolicy[]> {
    const result = await this.database.query<PolicyRow>(
      `SELECT *
       FROM shared_space_policies
       WHERE workspace_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $2)
       ORDER BY created_at, id`,
      [workspaceId, this.now()],
    );
    return result.rows.map(policyFromRow);
  }

  async getPolicy(
    workspaceId: string,
    policyId: string,
  ): Promise<SharedSpacePolicy | undefined> {
    const result = await this.database.query<PolicyRow>(
      `SELECT *
       FROM shared_space_policies
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, policyId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : policyFromRow(row);
  }

  async policyRevision(workspaceId: string): Promise<number> {
    const result = await this.database.query<{ revision: number }>(
      `SELECT COALESCE(MAX(version), 0)::int AS revision
       FROM shared_space_policies
       WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    );
    return numberValue(result.rows[0]?.revision);
  }

  async createPolicy(input: {
    readonly workspaceId: string;
    readonly subjectKind: SharedSpaceSubjectKind;
    readonly subjectId: string;
    readonly pathPattern: string;
    readonly permissions: readonly SharedSpacePolicyPermission[];
    readonly effect: SharedSpacePolicyEffect;
    readonly expiresAt: Date | null;
    readonly actorPrincipalId: string;
  }): Promise<SharedSpacePolicy> {
    const pattern = normalizeSharedSpacePathPattern(input.pathPattern);
    const now = this.now();
    return this.database.transaction(async (client) => {
      const result = await client.query<PolicyRow>(
        `INSERT INTO shared_space_policies (
           id, workspace_id, subject_kind, subject_id, path_pattern,
           permissions, effect, status, expires_at, created_by,
           version, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::text[], $7, 'active', $8, $9, 1, $10, $10
         )
         RETURNING *`,
        [
          randomUUID(),
          input.workspaceId,
          input.subjectKind,
          input.subjectId,
          pattern,
          arrayValue([...new Set(input.permissions)]),
          input.effect,
          input.expiresAt,
          input.actorPrincipalId,
          now,
        ],
      );
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.create",
        path: pattern,
        decision: "allowed",
        metadata: {
          policyId: result.rows[0]!.id,
          effect: input.effect,
          permissions: [...new Set(input.permissions)],
          subjectKind: input.subjectKind,
        },
      });
      return policyFromRow(result.rows[0]!);
    });
  }

  async updatePolicy(input: {
    readonly workspaceId: string;
    readonly policyId: string;
    readonly permissions?: readonly SharedSpacePolicyPermission[];
    readonly effect?: SharedSpacePolicyEffect;
    readonly expiresAt?: Date | null;
    readonly expectedVersion: number;
    readonly actorPrincipalId: string;
  }): Promise<SharedSpacePolicy> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PolicyRow>(
        `UPDATE shared_space_policies
         SET permissions = COALESCE($3::text[], permissions),
             effect = COALESCE($4, effect),
             expires_at = CASE WHEN $5::boolean THEN $6 ELSE expires_at END,
             version = version + 1,
             updated_at = $7
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'active'
           AND version = $8
         RETURNING *`,
        [
          input.workspaceId,
          input.policyId,
          input.permissions === undefined
            ? null
            : arrayValue([...new Set(input.permissions)]),
          input.effect ?? null,
          input.expiresAt !== undefined,
          input.expiresAt ?? null,
          this.now(),
          input.expectedVersion,
        ],
      );
      if (result.rows[0] === undefined) {
        const existing = await client.query(
          `SELECT 1 FROM shared_space_policies
           WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
          [input.workspaceId, input.policyId],
        );
        if (existing.rowCount === 0) {
          throw new SharedSpaceRepositoryError(
            "shared_space_not_found",
            "Shared Space policy not found",
            404,
          );
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "The Shared Space policy changed before this request was applied",
        );
      }
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.update",
        path: result.rows[0].path_pattern,
        decision: "allowed",
        metadata: {
          policyId: input.policyId,
          version: result.rows[0].version,
        },
      });
      return policyFromRow(result.rows[0]);
    });
  }

  async revokePolicy(input: {
    readonly workspaceId: string;
    readonly policyId: string;
    readonly expectedVersion: number;
    readonly actorPrincipalId: string;
  }): Promise<SharedSpacePolicy> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PolicyRow>(
        `UPDATE shared_space_policies
         SET status = 'revoked', version = version + 1, updated_at = $3
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'active'
           AND version = $4
         RETURNING *`,
        [input.workspaceId, input.policyId, this.now(), input.expectedVersion],
      );
      if (result.rows[0] === undefined) {
        const existing = await client.query(
          `SELECT 1 FROM shared_space_policies
           WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
          [input.workspaceId, input.policyId],
        );
        if (existing.rowCount === 0) {
          throw new SharedSpaceRepositoryError(
            "shared_space_not_found",
            "Shared Space policy not found",
            404,
          );
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "The Shared Space policy changed before this request was applied",
        );
      }
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.revoke",
        path: result.rows[0].path_pattern,
        decision: "allowed",
        metadata: { policyId: input.policyId },
      });
      return policyFromRow(result.rows[0]);
    });
  }

  async workspaceRoles(
    workspaceId: string,
    principalId: string,
  ): Promise<readonly WorkspaceRoleRow[]> {
    const result = await this.database.query<WorkspaceRoleRow>(
      `SELECT role_key, permissions
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'workspace'
         AND scope_id = $2
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $3)
       ORDER BY granted_at`,
      [principalId, workspaceId, this.now()],
    );
    return result.rows;
  }

  async listEntries(
    workspaceId: string,
    directoryPath: string,
    includeArchived = false,
  ): Promise<SharedSpaceEntry[]> {
    const result = await this.database.query<EntryRow>(
      `SELECT *
       FROM shared_space_entries
       WHERE workspace_id = $1
         AND ($3::boolean OR status = 'active')
         AND (
           ($2::text = '' AND position('/' in path) = 0)
           OR (
             $2::text <> ''
             AND left(path, length($2) + 1) = $2 || '/'
             AND position('/' in substr(path, length($2) + 2)) = 0
           )
         )
       ORDER BY kind DESC, lower(path), id`,
      [workspaceId, directoryPath, includeArchived],
    );
    const entries = result.rows.map(entryFromRow);
    if (entries.length === 0) return entries;
    const locks = await this.listActiveLocks(workspaceId);
    const locksByPath = new Map(
      locks.map((lock) => [lock.path.toLowerCase(), lock]),
    );
    return entries.map((entry) => ({
      ...entry,
      currentLock: locksByPath.get(entry.path.toLowerCase()) ?? null,
    }));
  }

  async getEntry(
    workspaceId: string,
    entryId: string,
    includeArchived = false,
  ): Promise<SharedSpaceEntry | undefined> {
    const result = await this.database.query<EntryRow>(
      `SELECT *
       FROM shared_space_entries
       WHERE workspace_id = $1
         AND id = $2
         AND ($3::boolean OR status = 'active')`,
      [workspaceId, entryId, includeArchived],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const entry = entryFromRow(row);
    return {
      ...entry,
      currentLock: (await this.getActiveLock(workspaceId, entry.path)) ?? null,
    };
  }

  async getEntryByPath(
    workspaceId: string,
    path: string,
    includeArchived = false,
  ): Promise<SharedSpaceEntry | undefined> {
    const result = await this.database.query<EntryRow>(
      `SELECT *
       FROM shared_space_entries
       WHERE workspace_id = $1
         AND lower(path) = lower($2)
         AND ($3::boolean OR status = 'active')`,
      [workspaceId, path, includeArchived],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const entry = entryFromRow(row);
    return {
      ...entry,
      currentLock: (await this.getActiveLock(workspaceId, entry.path)) ?? null,
    };
  }

  async getEntryStorageKey(
    workspaceId: string,
    entryId: string,
  ): Promise<string | undefined> {
    const result = await this.database.query<{ storage_key: string | null }>(
      `SELECT storage_key
       FROM shared_space_entries
       WHERE workspace_id = $1 AND id = $2 AND kind = 'file'
         AND status = 'active'`,
      [workspaceId, entryId],
    );
    return result.rows[0]?.storage_key ?? undefined;
  }

  async listVersions(
    workspaceId: string,
    entryId: string,
  ): Promise<SharedSpaceVersion[]> {
    const result = await this.database.query<VersionRow>(
      `SELECT
         id, entry_id, workspace_id, path, version, sha256, size, mime_type,
         created_by, source_run_id, ticket_id, gate_id, created_at
       FROM shared_space_versions
       WHERE workspace_id = $1 AND entry_id = $2
       ORDER BY version DESC`,
      [workspaceId, entryId],
    );
    return result.rows.map(versionFromRow);
  }

  async createDirectory(
    input: CreateDirectoryRepositoryInput,
  ): Promise<SharedSpaceEntry> {
    const path = normalizeSharedSpacePath(input.path);
    return this.database.transaction(async (client) => {
      await this.assertParentDirectories(client, input.workspaceId, path);
      const existing = await client.query<EntryRow>(
        `SELECT * FROM shared_space_entries
         WHERE workspace_id = $1 AND lower(path) = lower($2)`,
        [input.workspaceId, path],
      );
      if (existing.rows[0] !== undefined) {
        if (
          existing.rows[0].kind === "directory" &&
          existing.rows[0].status === "active"
        ) {
          return entryFromRow(existing.rows[0]);
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "A file or archived entry already uses this path",
        );
      }
      const now = this.now();
      const result = await client.query<EntryRow>(
        `INSERT INTO shared_space_entries (
           id, workspace_id, path, kind, status, current_version, sha256,
           size, mime_type, storage_key, created_by, updated_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'directory', 'active', 0, NULL, 0, NULL, NULL,
           $4, $4, $5, $5
         )
         RETURNING *`,
        [randomUUID(), input.workspaceId, path, input.actorPrincipalId, now],
      );
      const entry = entryFromRow(result.rows[0]!);
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "directory.create",
        path,
        entryId: entry.id,
        decision: "allowed",
      });
      await this.appendOutboxWithClient(
        client,
        "shared-space.directory.created",
        {
          workspaceId: input.workspaceId,
          entryId: entry.id,
          path,
        },
      );
      return entry;
    });
  }

  async commitFile(
    input: CommitFileRepositoryInput,
  ): Promise<SharedSpaceEntry> {
    const path = normalizeSharedSpacePath(input.path);
    try {
      return await this.database.transaction(async (client) =>
        this.commitFileWithClient(client, {
          ...input,
          path,
        }),
      );
    } catch (error) {
      if (postgresErrorCode(error) === "23505") {
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          "The Shared Space file was created concurrently at a different revision",
        );
      }
      throw error;
    }
  }

  private async commitFileWithClient(
    client: PoolClient,
    input: CommitFileRepositoryInput,
  ): Promise<SharedSpaceEntry> {
    await this.assertParentDirectories(client, input.workspaceId, input.path);
    const lock = await client.query<LockRow>(
      `SELECT *
       FROM shared_space_locks
       WHERE workspace_id = $1 AND lower(path) = lower($2) AND status = 'active'
       FOR UPDATE`,
      [input.workspaceId, input.path],
    );
    const activeLock = lock.rows[0];
    if (activeLock !== undefined) {
      const expired =
        activeLock.lease_expires_at.getTime() <= this.now().getTime();
      if (expired) {
        await this.expireLockWithClient(client, activeLock);
      } else {
        const ownsLock =
          input.lockId === activeLock.id &&
          activeLock.owner_principal_id === input.actorPrincipalId &&
          (input.runId === null ||
            input.runId === undefined ||
            activeLock.run_id === input.runId);
        if (!ownsLock) {
          throw new SharedSpaceRepositoryError(
            "shared_space_lock_conflict",
            "The Shared Space path is locked by another writer",
          );
        }
      }
    } else if (input.lockId !== null) {
      throw new SharedSpaceRepositoryError(
        "shared_space_lock_expired",
        "The Shared Space lock is no longer active",
      );
    }

    const existing = await client.query<EntryRow>(
      `SELECT *
       FROM shared_space_entries
       WHERE workspace_id = $1 AND lower(path) = lower($2)
       FOR UPDATE`,
      [input.workspaceId, input.path],
    );
    const current = existing.rows[0];
    const now = this.now();
    let result: EntryRow;
    let version: number;
    if (current === undefined) {
      if (input.expectedVersion !== 0) {
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          "The Shared Space file does not exist at the expected revision",
        );
      }
      version = 1;
      const inserted = await client.query<EntryRow>(
        `INSERT INTO shared_space_entries (
           id, workspace_id, path, kind, status, current_version, sha256,
           size, mime_type, storage_key, created_by, updated_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'file', 'active', 1, $4, $5, $6, $7, $8, $8, $9, $9
         )
         RETURNING *`,
        [
          randomUUID(),
          input.workspaceId,
          input.path,
          input.sha256,
          input.size,
          input.mimeType,
          input.storageKey,
          input.actorPrincipalId,
          now,
        ],
      );
      result = inserted.rows[0]!;
    } else {
      if (current.kind !== "file") {
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "A directory already uses this Shared Space path",
        );
      }
      if (current.status !== "active") {
        throw new SharedSpaceRepositoryError(
          "shared_space_conflict",
          "Archived Shared Space files cannot receive new versions",
        );
      }
      if (current.current_version !== input.expectedVersion) {
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          `The Shared Space file revision changed; expected ${input.expectedVersion}, current ${current.current_version}`,
        );
      }
      version = current.current_version + 1;
      const updated = await client.query<EntryRow>(
        `UPDATE shared_space_entries
         SET current_version = $3,
             sha256 = $4,
             size = $5,
             mime_type = $6,
             storage_key = $7,
             updated_by = $8,
             updated_at = $9
         WHERE id = $1 AND workspace_id = $2 AND current_version = $10
         RETURNING *`,
        [
          current.id,
          input.workspaceId,
          version,
          input.sha256,
          input.size,
          input.mimeType,
          input.storageKey,
          input.actorPrincipalId,
          now,
          input.expectedVersion,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          "The Shared Space file revision changed concurrently",
        );
      }
      result = updated.rows[0];
    }

    await client.query(
      `INSERT INTO shared_space_versions (
         id, entry_id, workspace_id, path, version, sha256, size, mime_type,
         storage_key, created_by, source_run_id, ticket_id, gate_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       )`,
      [
        randomUUID(),
        result.id,
        input.workspaceId,
        input.path,
        version,
        input.sha256,
        input.size,
        input.mimeType,
        input.storageKey,
        input.actorPrincipalId,
        input.runId ?? null,
        input.ticketId ?? null,
        input.gateId ?? null,
        now,
      ],
    );
    const entry = entryFromRow(result);
    await this.appendAuditWithClient(client, {
      workspaceId: input.workspaceId,
      actorPrincipalId: input.actorPrincipalId,
      action: "file.write",
      path: input.path,
      entryId: entry.id,
      version,
      decision: "allowed",
      runId: input.runId ?? null,
      sceneSessionId: input.sceneSessionId ?? null,
      ticketId: input.ticketId ?? null,
      gateId: input.gateId ?? null,
      metadata: {
        sha256: input.sha256,
        size: input.size,
        mimeType: input.mimeType,
      },
    });
    await this.appendOutboxWithClient(client, "shared-space.file.changed", {
      workspaceId: input.workspaceId,
      entryId: entry.id,
      path: input.path,
      version,
      sha256: input.sha256,
    });
    return entry;
  }

  async archiveFile(input: {
    readonly workspaceId: string;
    readonly entryId: string;
    readonly expectedVersion: number;
    readonly actorPrincipalId: string;
  }): Promise<SharedSpaceEntry> {
    return this.database.transaction(async (client) => {
      const result = await client.query<EntryRow>(
        `UPDATE shared_space_entries
         SET status = 'archived', updated_by = $4, updated_at = $5
         WHERE workspace_id = $1
           AND id = $2
           AND kind = 'file'
           AND status = 'active'
           AND current_version = $3
         RETURNING *`,
        [
          input.workspaceId,
          input.entryId,
          input.expectedVersion,
          input.actorPrincipalId,
          this.now(),
        ],
      );
      if (result.rows[0] === undefined) {
        const existing = await client.query(
          `SELECT 1 FROM shared_space_entries
           WHERE workspace_id = $1 AND id = $2 AND kind = 'file'`,
          [input.workspaceId, input.entryId],
        );
        if (existing.rowCount === 0) {
          throw new SharedSpaceRepositoryError(
            "shared_space_not_found",
            "Shared Space file not found",
            404,
          );
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          "The Shared Space file changed before it was archived",
        );
      }
      const entry = entryFromRow(result.rows[0]);
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "file.archive",
        path: entry.path,
        entryId: entry.id,
        version: entry.currentVersion,
        decision: "allowed",
      });
      await this.appendOutboxWithClient(client, "shared-space.file.archived", {
        workspaceId: input.workspaceId,
        entryId: entry.id,
        path: entry.path,
        version: entry.currentVersion,
      });
      return entry;
    });
  }

  async moveEntry(input: {
    readonly workspaceId: string;
    readonly entryId: string;
    readonly targetPath: string;
    readonly expectedVersion: number;
    readonly actorPrincipalId: string;
    readonly runId: string | null;
  }): Promise<SharedSpaceEntry> {
    return this.database.transaction(async (client) => {
      await this.assertParentDirectories(
        client,
        input.workspaceId,
        input.targetPath,
      );
      const result = await client.query<EntryRow>(
        `UPDATE shared_space_entries
         SET path = $3,
             current_version = current_version + 1,
             updated_by = $4,
             updated_at = $5
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'active'
           AND current_version = $6
         RETURNING *`,
        [
          input.workspaceId,
          input.entryId,
          input.targetPath,
          input.actorPrincipalId,
          this.now(),
          input.expectedVersion,
        ],
      );
      if (result.rows[0] === undefined) {
        const existing = await client.query(
          `SELECT 1 FROM shared_space_entries
           WHERE workspace_id = $1 AND id = $2 AND status = 'active'`,
          [input.workspaceId, input.entryId],
        );
        if (existing.rowCount === 0) {
          throw new SharedSpaceRepositoryError(
            "shared_space_not_found",
            "Shared Space entry not found",
            404,
          );
        }
        throw new SharedSpaceRepositoryError(
          "shared_space_version_conflict",
          "The Shared Space entry changed before it was moved",
        );
      }
      const entry = entryFromRow(result.rows[0]);
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "file.write",
        path: entry.path,
        entryId: entry.id,
        version: entry.currentVersion,
        decision: "allowed",
        runId: input.runId,
        metadata: { operation: "move", path: input.targetPath },
      });
      return entry;
    });
  }

  async listActiveLocks(workspaceId: string): Promise<SharedSpaceLock[]> {
    const result = await this.database.query<LockRow>(
      `SELECT *
       FROM shared_space_locks
       WHERE workspace_id = $1
         AND status = 'active'
         AND lease_expires_at > $2
       ORDER BY lower(path), acquired_at`,
      [workspaceId, this.now()],
    );
    return result.rows.map(lockFromRow);
  }

  async getActiveLock(
    workspaceId: string,
    path: string,
  ): Promise<SharedSpaceLock | undefined> {
    const result = await this.database.query<LockRow>(
      `SELECT *
       FROM shared_space_locks
       WHERE workspace_id = $1
         AND lower(path) = lower($2)
         AND status = 'active'
         AND lease_expires_at > $3`,
      [workspaceId, path, this.now()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : lockFromRow(row);
  }

  async acquireLock(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly ownerPrincipalId: string;
    readonly ownerSessionId: string | null;
    readonly runId: string | null;
    readonly mode: SharedSpaceLockMode;
    readonly leaseSeconds: number;
  }): Promise<SharedSpaceLock> {
    return this.database.transaction(async (client) => {
      await this.expireLocksWithClient(client, input.workspaceId);
      const current = await client.query<LockRow>(
        `SELECT *
         FROM shared_space_locks
         WHERE workspace_id = $1 AND lower(path) = lower($2) AND status = 'active'
         FOR UPDATE`,
        [input.workspaceId, input.path],
      );
      const now = this.now();
      if (current.rows[0] !== undefined) {
        const row = current.rows[0];
        const sameOwner =
          row.owner_principal_id === input.ownerPrincipalId &&
          row.owner_session_id === input.ownerSessionId &&
          row.run_id === input.runId;
        if (!sameOwner || row.mode !== input.mode) {
          throw new SharedSpaceRepositoryError(
            "shared_space_lock_conflict",
            "The Shared Space path is already locked",
          );
        }
        const renewed = await client.query<LockRow>(
          `UPDATE shared_space_locks
           SET lease_expires_at = $2, version = version + 1
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [row.id, new Date(now.getTime() + input.leaseSeconds * 1_000)],
        );
        return lockFromRow(renewed.rows[0]!);
      }
      const acquired = await client.query<LockRow>(
        `INSERT INTO shared_space_locks (
           id, workspace_id, path, owner_principal_id, owner_session_id,
           run_id, mode, status, lease_expires_at, version, acquired_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, 1, $9
         )
         RETURNING *`,
        [
          randomUUID(),
          input.workspaceId,
          input.path,
          input.ownerPrincipalId,
          input.ownerSessionId,
          input.runId,
          input.mode,
          new Date(now.getTime() + input.leaseSeconds * 1_000),
          now,
        ],
      );
      const lock = lockFromRow(acquired.rows[0]!);
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.ownerPrincipalId,
        action: "lock.acquire",
        path: input.path,
        decision: "allowed",
        runId: input.runId,
        metadata: { lockId: lock.id, mode: lock.mode },
      });
      return lock;
    });
  }

  async releaseLock(input: {
    readonly workspaceId: string;
    readonly lockId: string;
    readonly actorPrincipalId: string;
    readonly allowWorkspaceManager: boolean;
  }): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const lock = await client.query<LockRow>(
        `SELECT * FROM shared_space_locks
         WHERE workspace_id = $1 AND id = $2 AND status = 'active'
         FOR UPDATE`,
        [input.workspaceId, input.lockId],
      );
      const row = lock.rows[0];
      if (row === undefined) return false;
      if (
        row.owner_principal_id !== input.actorPrincipalId &&
        !input.allowWorkspaceManager
      ) {
        throw new SharedSpaceRepositoryError(
          "shared_space_lock_conflict",
          "Only the lock owner or a Workspace administrator can release this lock",
          403,
        );
      }
      await client.query(
        `UPDATE shared_space_locks
         SET status = 'released', released_at = $2, version = version + 1
         WHERE id = $1`,
        [row.id, this.now()],
      );
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "lock.release",
        path: row.path,
        decision: "allowed",
        metadata: { lockId: row.id },
      });
      return true;
    });
  }

  async expireLocks(limit = 100): Promise<SharedSpaceLock[]> {
    return this.database.transaction(async (client) => {
      const due = await client.query<LockRow>(
        `SELECT *
         FROM shared_space_locks
         WHERE status = 'active' AND lease_expires_at <= $1
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [this.now(), limit],
      );
      const expired: SharedSpaceLock[] = [];
      for (const row of due.rows) {
        await this.expireLockWithClient(client, row);
        expired.push(lockFromRow({ ...row, status: "expired" }));
      }
      return expired;
    });
  }

  private async expireLockWithClient(
    client: PoolClient,
    row: LockRow,
  ): Promise<void> {
    await client.query(
      `UPDATE shared_space_locks
       SET status = 'expired', released_at = $2, version = version + 1
       WHERE id = $1 AND status = 'active'`,
      [row.id, this.now()],
    );
    await this.appendAuditWithClient(client, {
      workspaceId: row.workspace_id,
      actorPrincipalId: row.owner_principal_id,
      action: "lock.expire",
      path: row.path,
      decision: "allowed",
      runId: row.run_id,
      metadata: { lockId: row.id },
    });
  }

  private async expireLocksWithClient(
    client: PoolClient,
    workspaceId: string,
  ): Promise<void> {
    const due = await client.query<LockRow>(
      `SELECT *
       FROM shared_space_locks
       WHERE workspace_id = $1
         AND status = 'active'
         AND lease_expires_at <= $2
       FOR UPDATE`,
      [workspaceId, this.now()],
    );
    for (const row of due.rows) {
      await this.expireLockWithClient(client, row);
    }
  }

  async listActiveClaims(workspaceId: string): Promise<SharedSpaceClaim[]> {
    const result = await this.database.query<ClaimRow>(
      `SELECT *
       FROM shared_space_claims
       WHERE workspace_id = $1
         AND status = 'active'
         AND lease_expires_at > $2
       ORDER BY lower(path), claimed_at`,
      [workspaceId, this.now()],
    );
    return result.rows.map(claimFromRow);
  }

  async createClaim(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly ownerPrincipalId: string;
    readonly ownerSessionId: string;
    readonly runId: string | null;
    readonly note: string;
    readonly leaseSeconds: number;
  }): Promise<SharedSpaceClaim> {
    return this.database.transaction(async (client) => {
      const now = this.now();
      await client.query(
        `UPDATE shared_space_claims
         SET status = 'expired', released_at = $3, version = version + 1
         WHERE workspace_id = $1
           AND status = 'active'
           AND lease_expires_at <= $2`,
        [input.workspaceId, now, now],
      );
      const existing = await client.query<ClaimRow>(
        `SELECT *
         FROM shared_space_claims
         WHERE workspace_id = $1 AND lower(path) = lower($2) AND status = 'active'
         FOR UPDATE`,
        [input.workspaceId, input.path],
      );
      if (existing.rows[0] !== undefined) {
        throw new SharedSpaceRepositoryError(
          "shared_space_lock_conflict",
          "The Shared Space path already has an active claim",
        );
      }
      const result = await client.query<ClaimRow>(
        `INSERT INTO shared_space_claims (
           id, workspace_id, path, owner_principal_id, owner_session_id,
           run_id, note, status, lease_expires_at, version, claimed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', $8, 1, $9
         )
         RETURNING *`,
        [
          randomUUID(),
          input.workspaceId,
          input.path,
          input.ownerPrincipalId,
          input.ownerSessionId,
          input.runId,
          input.note,
          new Date(now.getTime() + input.leaseSeconds * 1_000),
          now,
        ],
      );
      const claim = claimFromRow(result.rows[0]!);
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.ownerPrincipalId,
        action: "claim.create",
        path: input.path,
        decision: "allowed",
        runId: input.runId,
        metadata: { claimId: claim.id },
      });
      return claim;
    });
  }

  async releaseClaim(input: {
    readonly workspaceId: string;
    readonly claimId: string;
    readonly actorPrincipalId: string;
  }): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query<ClaimRow>(
        `UPDATE shared_space_claims
         SET status = 'released', released_at = $3, version = version + 1
         WHERE workspace_id = $1
           AND id = $2
           AND status = 'active'
           AND owner_principal_id = $4
         RETURNING *`,
        [input.workspaceId, input.claimId, this.now(), input.actorPrincipalId],
      );
      const row = result.rows[0];
      if (row === undefined) return false;
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: "claim.release",
        path: row.path,
        decision: "allowed",
        metadata: { claimId: row.id },
      });
      return true;
    });
  }

  async expireClaims(limit = 100): Promise<SharedSpaceClaim[]> {
    return this.database.transaction(async (client) => {
      const due = await client.query<ClaimRow>(
        `SELECT *
         FROM shared_space_claims
         WHERE status = 'active' AND lease_expires_at <= $1
         ORDER BY lease_expires_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [this.now(), limit],
      );
      const expired: SharedSpaceClaim[] = [];
      for (const row of due.rows) {
        const updated = await client.query<ClaimRow>(
          `UPDATE shared_space_claims
           SET status = 'expired', released_at = $2, version = version + 1
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [row.id, this.now()],
        );
        if (updated.rows[0] !== undefined) {
          expired.push(claimFromRow(updated.rows[0]));
          await this.appendAuditWithClient(client, {
            workspaceId: row.workspace_id,
            actorPrincipalId: row.owner_principal_id,
            action: "claim.expire",
            path: row.path,
            decision: "allowed",
            runId: row.run_id,
            metadata: { claimId: row.id },
          });
        }
      }
      return expired;
    });
  }

  async createWriteRequest(
    input: CreateWriteRequestRepositoryInput,
  ): Promise<SharedSpaceWriteRequest> {
    return this.database.transaction(async (client) => {
      if (input.gate !== null) {
        await this.actionTickets.issueGatesWithClient(client, [input.gate]);
      }
      const inserted = await client.query<WriteRequestRow>(
        `INSERT INTO shared_space_write_requests (
           id, scope, operation, source_workspace_id, source_entry_id,
           actor_principal_id, target_path, name, mime_type, size, sha256,
           storage_key, purpose,
           expected_version, policy_revision, status, run_id,
           scene_session_id, ticket_id, gate_id, idempotency_key,
           requested_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, 'pending', $16, $17, $18, $19, $20, $21, $22
         )
         ON CONFLICT (source_workspace_id, actor_principal_id, idempotency_key)
         DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.scope,
          input.operation,
          input.sourceWorkspaceId,
          input.sourceEntryId,
          input.actorPrincipalId,
          input.targetPath,
          input.name,
          input.mimeType,
          input.size,
          input.sha256,
          input.storageKey,
          input.purpose,
          input.expectedVersion,
          input.policyRevision,
          input.runId,
          input.sceneSessionId,
          input.ticketId,
          input.gateId,
          input.idempotencyKey,
          this.now(),
          input.expiresAt,
        ],
      );
      if (inserted.rows[0] === undefined) {
        throw new SharedSpaceRepositoryError(
          "shared_space_request_conflict",
          "A Shared Space write request with this idempotency key already exists",
        );
      }
      await this.appendAuditWithClient(client, {
        workspaceId: input.sourceWorkspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: input.scope === "global" ? "global.request" : "write.request",
        path: input.targetPath,
        decision: "allowed",
        runId: input.runId,
        sceneSessionId: input.sceneSessionId,
        ticketId: input.ticketId,
        gateId: input.gateId,
        metadata: {
          requestId: input.id,
          scope: input.scope,
          expectedVersion: input.expectedVersion,
          sha256: input.sha256,
        },
      });
      return writeRequestFromRow(inserted.rows[0]);
    });
  }

  async getWriteRequest(
    requestId: string,
  ): Promise<SharedSpaceWriteRequest | undefined> {
    const result = await this.database.query<WriteRequestRow>(
      "SELECT * FROM shared_space_write_requests WHERE id = $1",
      [requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : writeRequestFromRow(row);
  }

  async listWriteRequests(input: {
    readonly workspaceId?: string;
    readonly scope?: SharedSpaceWriteRequestScope;
    readonly status?: SharedSpaceWriteRequest["status"];
    readonly limit?: number;
  }): Promise<SharedSpaceWriteRequest[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("$?", `$${values.length}`));
    };
    if (input.workspaceId !== undefined) {
      add("source_workspace_id = $?", input.workspaceId);
    }
    if (input.scope !== undefined) add("scope = $?", input.scope);
    if (input.status !== undefined) add("status = $?", input.status);
    values.push(input.limit ?? 100);
    const result = await this.database.query<WriteRequestRow>(
      `SELECT *
       FROM shared_space_write_requests
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY requested_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(writeRequestFromRow);
  }

  async recordWriteDecision(input: {
    readonly requestId: string;
    readonly status: "approved" | "rejected" | "expired";
    readonly decidedByPrincipalId: string;
    readonly reason: string;
  }): Promise<SharedSpaceWriteRequest> {
    return this.database.transaction(async (client) => {
      const current = await client.query<WriteRequestRow>(
        `SELECT * FROM shared_space_write_requests WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw new SharedSpaceRepositoryError(
          "shared_space_not_found",
          "Shared Space write request not found",
          404,
        );
      }
      if (row.status === "consumed") {
        throw new SharedSpaceRepositoryError(
          "shared_space_request_consumed",
          "The Shared Space write request has already been consumed",
        );
      }
      if (row.status !== "pending") {
        return writeRequestFromRow(row);
      }
      const result = await client.query<WriteRequestRow>(
        `UPDATE shared_space_write_requests
         SET status = $2,
             decided_by_principal_id = $3,
             decision_reason = $4,
             decided_at = $5
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [
          input.requestId,
          input.status,
          input.decidedByPrincipalId,
          input.reason,
          this.now(),
        ],
      );
      await this.appendAuditWithClient(client, {
        workspaceId: row.source_workspace_id,
        actorPrincipalId: input.decidedByPrincipalId,
        action:
          row.scope === "global"
            ? input.status === "approved"
              ? "global.approve"
              : "global.reject"
            : input.status === "approved"
              ? "write.approve"
              : "write.reject",
        path: row.target_path,
        decision: input.status === "approved" ? "allowed" : "denied",
        reason: input.reason,
        runId: row.run_id,
        sceneSessionId: row.scene_session_id,
        ticketId: row.ticket_id,
        gateId: row.gate_id,
        metadata: { requestId: row.id, scope: row.scope },
      });
      return writeRequestFromRow(result.rows[0]!);
    });
  }

  async consumeWriteRequest(
    input: ConsumeWriteRequestRepositoryInput,
  ): Promise<{
    readonly request: SharedSpaceWriteRequest;
    readonly entry: SharedSpaceEntry | null;
  }> {
    return this.database.transaction(async (client) => {
      const selected = await client.query<WriteRequestRow>(
        `SELECT * FROM shared_space_write_requests
         WHERE id = $1
         FOR UPDATE`,
        [input.requestId],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        throw new SharedSpaceRepositoryError(
          "shared_space_not_found",
          "Shared Space write request not found",
          404,
        );
      }
      if (row.status === "consumed") {
        throw new SharedSpaceRepositoryError(
          "shared_space_request_consumed",
          "The Shared Space write request has already been consumed",
        );
      }
      if (row.status !== "approved") {
        throw new SharedSpaceRepositoryError(
          "shared_space_request_not_approved",
          "The Shared Space write request is not approved",
        );
      }
      if (row.expires_at.getTime() <= this.now().getTime()) {
        await client.query(
          `UPDATE shared_space_write_requests
           SET status = 'expired',
               decision_reason = COALESCE(decision_reason, 'write_request_expired')
           WHERE id = $1`,
          [row.id],
        );
        throw new SharedSpaceRepositoryError(
          "shared_space_request_expired",
          "The Shared Space write request has expired",
        );
      }
      let entry: SharedSpaceEntry | null = null;
      if (row.scope === "global") {
        await client.query(
          `INSERT INTO shared_space_global_files (
             id, request_id, path, name, mime_type, size, sha256, storage_key,
             created_by, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            row.id,
            row.target_path,
            row.name,
            row.mime_type,
            row.size,
            row.sha256,
            row.storage_key,
            row.actor_principal_id,
            this.now(),
          ],
        );
      } else {
        if (row.operation === "write") {
          entry = await this.commitFileWithClient(client, {
            workspaceId: row.source_workspace_id,
            path: row.target_path,
            name: row.name,
            mimeType: row.mime_type,
            size: numberValue(row.size),
            sha256: row.sha256,
            storageKey: row.storage_key,
            actorPrincipalId: row.actor_principal_id,
            expectedVersion: row.expected_version,
            lockId: input.lockId,
            runId: row.run_id,
            sceneSessionId: row.scene_session_id,
            ticketId: row.ticket_id,
            gateId: row.gate_id,
          });
        } else if (row.source_entry_id !== null) {
          const selectedEntry = await client.query<EntryRow>(
            `SELECT * FROM shared_space_entries
             WHERE workspace_id = $1 AND id = $2 AND status = 'active'
             FOR UPDATE`,
            [row.source_workspace_id, row.source_entry_id],
          );
          const source = selectedEntry.rows[0];
          if (
            source === undefined ||
            source.current_version !== row.expected_version
          ) {
            throw new SharedSpaceRepositoryError(
              "shared_space_version_conflict",
              "The Shared Space file revision changed after approval",
            );
          }
          if (row.operation === "delete") {
            const archived = await client.query<EntryRow>(
              `UPDATE shared_space_entries
               SET status = 'archived', updated_by = $3, updated_at = $4
               WHERE id = $1 AND workspace_id = $2
                 AND status = 'active' AND current_version = $5
               RETURNING *`,
              [
                row.source_entry_id,
                row.source_workspace_id,
                row.actor_principal_id,
                this.now(),
                row.expected_version,
              ],
            );
            if (archived.rows[0] === undefined) {
              throw new SharedSpaceRepositoryError(
                "shared_space_version_conflict",
                "The Shared Space file changed before deletion",
              );
            }
            entry = entryFromRow(archived.rows[0]);
            await this.appendAuditWithClient(client, {
              workspaceId: row.source_workspace_id,
              actorPrincipalId: row.actor_principal_id,
              action: "file.archive",
              path: entry.path,
              entryId: entry.id,
              version: entry.currentVersion,
              decision: "allowed",
              runId: row.run_id,
              sceneSessionId: row.scene_session_id,
              ticketId: row.ticket_id,
              gateId: row.gate_id,
            });
          } else {
            await this.assertParentDirectories(
              client,
              row.source_workspace_id,
              row.target_path,
            );
            const moved = await client.query<EntryRow>(
              `UPDATE shared_space_entries
               SET path = $3,
                   current_version = current_version + 1,
                   updated_by = $4,
                   updated_at = $5
               WHERE id = $1 AND workspace_id = $2
                 AND status = 'active' AND current_version = $6
               RETURNING *`,
              [
                row.source_entry_id,
                row.source_workspace_id,
                row.target_path,
                row.actor_principal_id,
                this.now(),
                row.expected_version,
              ],
            );
            if (moved.rows[0] === undefined) {
              throw new SharedSpaceRepositoryError(
                "shared_space_version_conflict",
                "The Shared Space file changed before it was moved",
              );
            }
            entry = entryFromRow(moved.rows[0]);
            await this.appendAuditWithClient(client, {
              workspaceId: row.source_workspace_id,
              actorPrincipalId: row.actor_principal_id,
              action: "file.write",
              path: entry.path,
              entryId: entry.id,
              version: entry.currentVersion,
              decision: "allowed",
              runId: row.run_id,
              sceneSessionId: row.scene_session_id,
              ticketId: row.ticket_id,
              gateId: row.gate_id,
              metadata: { operation: "move" },
            });
          }
        }
      }
      const updated = await client.query<WriteRequestRow>(
        `UPDATE shared_space_write_requests
         SET status = 'consumed',
             consumed_at = $2,
             result_entry_id = $3,
             result_version = $4
         WHERE id = $1 AND status = 'approved'
         RETURNING *`,
        [row.id, this.now(), entry?.id ?? null, entry?.currentVersion ?? null],
      );
      await this.appendAuditWithClient(client, {
        workspaceId: row.source_workspace_id,
        actorPrincipalId: input.actorPrincipalId,
        action: row.scope === "global" ? "global.consume" : "write.consume",
        path: row.target_path,
        entryId: entry?.id ?? null,
        version: entry?.currentVersion ?? null,
        decision: "allowed",
        runId: row.run_id,
        sceneSessionId: row.scene_session_id,
        ticketId: row.ticket_id,
        gateId: row.gate_id,
        metadata: { requestId: row.id, scope: row.scope },
      });
      return {
        request: writeRequestFromRow(updated.rows[0]!),
        entry,
      };
    });
  }

  async expireWriteRequests(limit = 100): Promise<SharedSpaceWriteRequest[]> {
    const result = await this.database.query<WriteRequestRow>(
      `UPDATE shared_space_write_requests
       SET status = 'expired',
           decision_reason = COALESCE(decision_reason, 'write_request_expired')
       WHERE id IN (
         SELECT id
         FROM shared_space_write_requests
         WHERE status IN ('pending', 'approved')
           AND expires_at <= $1
         ORDER BY expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [this.now(), limit],
    );
    return result.rows.map(writeRequestFromRow);
  }

  async failWriteRequest(input: {
    readonly requestId: string;
    readonly actorPrincipalId: string;
    readonly reason: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<WriteRequestRow>(
        `UPDATE shared_space_write_requests
         SET status = 'expired',
             decision_reason = $2
         WHERE id = $1 AND status IN ('pending', 'approved')
         RETURNING *`,
        [input.requestId, input.reason.slice(0, 2000)],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await this.appendAuditWithClient(client, {
          workspaceId: row.source_workspace_id,
          actorPrincipalId: input.actorPrincipalId,
          action: row.scope === "global" ? "global.reject" : "write.reject",
          path: row.target_path,
          decision: "denied",
          reason: input.reason,
          runId: row.run_id,
          sceneSessionId: row.scene_session_id,
          ticketId: row.ticket_id,
          gateId: row.gate_id,
          metadata: { requestId: row.id, recoveryFailure: true },
        });
      }
    });
  }

  async appendAudit(input: SharedSpaceAuditInput): Promise<void> {
    await this.appendAuditWithClient(this.database, input);
  }

  async appendAuditWithClient(
    executor: QueryExecutor,
    input: SharedSpaceAuditInput,
  ): Promise<void> {
    const metadata = sanitizeAuditMetadata(input.metadata ?? {});
    await executor.query(
      `INSERT INTO shared_space_events (
         id, workspace_id, actor_principal_id, action, path, entry_id,
         version, decision, reason, run_id, scene_session_id, ticket_id,
         gate_id, metadata, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::jsonb, $15
       )`,
      [
        randomUUID(),
        input.workspaceId,
        input.actorPrincipalId ?? null,
        input.action,
        input.path ?? null,
        input.entryId ?? null,
        input.version ?? null,
        input.decision,
        input.reason ?? "",
        input.runId ?? null,
        input.sceneSessionId ?? null,
        input.ticketId ?? null,
        input.gateId ?? null,
        JSON.stringify(metadata),
        this.now(),
      ],
    );
  }

  async listAudit(
    workspaceId: string,
    query: SharedSpaceAuditQuery,
  ): Promise<SharedSpaceAuditPage> {
    const offset = decodeOffset(query.cursor);
    const conditions = ["workspace_id = $1"];
    const values: unknown[] = [workspaceId];
    if (query.action !== undefined) {
      values.push(query.action);
      conditions.push(`action = $${values.length}`);
    }
    if (query.decision !== undefined) {
      values.push(query.decision);
      conditions.push(`decision = $${values.length}`);
    }
    values.push(query.limit + 1, offset);
    const rows = await this.database.query<AuditRow>(
      `SELECT *
       FROM shared_space_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM shared_space_events
       WHERE ${conditions.join(" AND ")}`,
      values.slice(0, -2),
    );
    const hasNext = rows.rows.length > query.limit;
    const items = rows.rows.slice(0, query.limit).map(auditFromRow);
    return {
      items,
      nextCursor: hasNext ? encodeOffset(offset + items.length) : null,
      total: numberValue(count.rows[0]?.total),
    };
  }

  async createDigest(input: {
    readonly workspaceId: string;
    readonly sceneSessionId: string | null;
    readonly generatedBy: string;
    readonly digestDate: string;
  }): Promise<SharedSpaceDigest> {
    return this.database.transaction(async (client) => {
      const events = await client.query<AuditRow>(
        `SELECT *
         FROM shared_space_events
         WHERE workspace_id = $1
           AND ($2::uuid IS NULL OR scene_session_id = $2)
           AND decision IN ('allowed', 'denied')
         ORDER BY created_at, id`,
        [input.workspaceId, input.sceneSessionId],
      );
      const lines = events.rows.slice(-200).map((event) => {
        const subject = event.path === null ? "" : ` ${event.path}`;
        const suffix =
          event.reason === "" ? "" : ` - ${redactDigestText(event.reason)}`;
        return `- ${event.created_at.toISOString()}: ${event.action}${subject} (${event.decision})${suffix}`;
      });
      const content = [
        `# Shared Space digest`,
        "",
        `Workspace: ${input.workspaceId}`,
        `Scene session: ${input.sceneSessionId ?? "workspace"}`,
        `Generated: ${this.now().toISOString()}`,
        "",
        lines.length === 0 ? "No Shared Space activity." : lines.join("\n"),
      ].join("\n");
      const result = await client.query<DigestRow>(
        `INSERT INTO shared_space_digests (
           id, workspace_id, scene_session_id, digest_date, content,
           event_from, event_to, generated_by, generated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          randomUUID(),
          input.workspaceId,
          input.sceneSessionId,
          input.digestDate,
          content,
          events.rows[0]?.id ?? null,
          events.rows.at(-1)?.id ?? null,
          input.generatedBy,
          this.now(),
        ],
      );
      await this.appendAuditWithClient(client, {
        workspaceId: input.workspaceId,
        actorPrincipalId: input.generatedBy,
        action: "digest.create",
        decision: "allowed",
        sceneSessionId: input.sceneSessionId,
        metadata: { digestId: result.rows[0]!.id },
      });
      return digestFromRow(result.rows[0]!);
    });
  }

  async listDigests(
    workspaceId: string,
    limit = 50,
  ): Promise<SharedSpaceDigest[]> {
    const result = await this.database.query<DigestRow>(
      `SELECT *
       FROM shared_space_digests
       WHERE workspace_id = $1
       ORDER BY generated_at DESC, id DESC
       LIMIT $2`,
      [workspaceId, limit],
    );
    return result.rows.map(digestFromRow);
  }

  private async assertParentDirectories(
    client: PoolClient,
    workspaceId: string,
    path: string,
  ): Promise<void> {
    const segments = path.split("/");
    const parents = segments
      .slice(0, -1)
      .map((_, index) => segments.slice(0, index + 1).join("/"));
    if (parents.length === 0) return;
    const result = await client.query<{
      path: string;
      kind: "file" | "directory";
      status: "active" | "archived";
    }>(
      `SELECT path, kind, status
       FROM shared_space_entries
       WHERE workspace_id = $1
         AND lower(path) = ANY($2::text[])`,
      [workspaceId, parents.map((parent) => parent.toLowerCase())],
    );
    const byPath = new Map(
      result.rows.map((row) => [row.path.toLowerCase(), row]),
    );
    for (const parent of parents) {
      const row = byPath.get(parent.toLowerCase());
      if (
        row === undefined ||
        row.kind !== "directory" ||
        row.status !== "active"
      ) {
        throw new SharedSpaceRepositoryError(
          "shared_space_parent_missing",
          "Every Shared Space parent must be an active directory",
        );
      }
    }
  }

  private async appendOutboxWithClient(
    client: PoolClient,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO domain_outbox (id, topic, payload, status, created_at)
       VALUES ($1, $2, $3::jsonb, 'pending', $4)`,
      [randomUUID(), topic, JSON.stringify(payload), this.now()],
    );
  }
}

function sanitizeAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      /(content|body|text|storage.?key|absolute|path.?escape|authorization|token|secret|password|credential|cookie)/iu.test(
        key,
      )
    ) {
      continue;
    }
    if (typeof value === "string") {
      safe[key] = redactDigestText(value).slice(0, 500);
    } else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value
        .filter((item) => ["string", "number", "boolean"].includes(typeof item))
        .slice(0, 50)
        .map((item) =>
          typeof item === "string"
            ? redactDigestText(item).slice(0, 200)
            : item,
        );
    }
  }
  return safe;
}

function redactDigestText(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gu,
      "[REDACTED:private-key]",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED:aws-key]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED:api-key]")
    .replace(
      /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/gu,
      "[REDACTED:github-token]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu, "Bearer [REDACTED]")
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/gu, "[REDACTED:absolute-path]")
    .slice(0, 1000);
}
