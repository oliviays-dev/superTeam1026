import { createHash, randomUUID } from "node:crypto";
import type {
  BusinessChainSourceRef,
  ProjectProgressOverview,
  ProjectSourceFetchResult,
  ProjectSourceMcpReadRecord,
  ProjectSourceMcpReadStatus,
  ProjectSourceMcpReadSummary,
  ProjectSourceMcpRetentionResult,
  ProjectSourceSnapshot,
} from "@pluginmax/contracts";
import {
  projectSourceMcpReadRecordSchema,
  projectSourceSnapshotSchema,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import {
  stableJson,
  type ProjectBusinessChainRepository,
} from "./project-business-chain-repository.js";

interface ProjectSourceMcpReadRow {
  readonly request_id: string;
  readonly runtime_request_id: string | null;
  readonly project_id: string;
  readonly ref_key: string;
  readonly source_kind: string;
  readonly source_system: string;
  readonly source_object_type: string;
  readonly source_object_id: string;
  readonly source_path: string;
  readonly source_binding_revision: number;
  readonly source_binding_digest: string;
  readonly provider_id: string;
  readonly provider_version_id: string;
  readonly provider_revision: number;
  readonly tool_key: string;
  readonly run_id: string;
  readonly run_attempt: number;
  readonly ticket_id: string;
  readonly gate_id: string;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly envelope_id: string;
  readonly envelope_digest: string;
  readonly call_id: string | null;
  readonly snapshot_id: string | null;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly status: ProjectSourceMcpReadStatus;
  readonly source_revision: string | null;
  readonly error_category: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SourceSnapshotRow {
  readonly id: string;
  readonly project_id: string;
  readonly ref_key: string;
  readonly source_kind: string;
  readonly source_system: string;
  readonly source_object_type: string;
  readonly source_object_id: string;
  readonly source_revision: string | null;
  readonly version: number;
  readonly status: ProjectSourceSnapshot["status"];
  readonly observed_at: Date;
  readonly effective_at: Date | null;
  readonly fresh_until: Date | null;
  readonly payload_digest: string | null;
  readonly payload: unknown;
  readonly failure_reason: string | null;
  readonly is_mock: boolean;
  readonly created_by_principal_id: string;
  readonly created_at: Date;
}

interface ProviderBindingRow {
  readonly provider_id: string;
  readonly provider_key: string;
  readonly provider_status: string;
  readonly health_status: string;
  readonly discovery_status: string;
  readonly provider_revision: number;
  readonly current_version_id: string;
  readonly provider_version_id: string;
  readonly provider_version: number;
  readonly tool_key: string;
  readonly tool_name: string;
  readonly schema_digest: string;
}

export interface ResolvedMcpProjectSourceBinding {
  readonly projectId: string;
  readonly ref: BusinessChainSourceRef;
  readonly bindingRevision: number;
  readonly bindingDigest: string;
  readonly sourceBindingDigest: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerVersionId: string;
  readonly providerVersion: number;
  readonly providerRevision: number;
  readonly toolKey: string;
  readonly toolName: string;
  readonly toolSchemaDigest: string;
}

export interface BeginProjectSourceMcpReadInput {
  readonly requestId: string;
  readonly binding: ResolvedMcpProjectSourceBinding;
  readonly runId: string;
  readonly runAttempt: number;
  readonly ticketId: string;
  readonly gateId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly envelopeId: string;
  readonly envelopeDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export type BeginProjectSourceMcpReadResult =
  | {
      readonly kind: "claimed";
      readonly record: ProjectSourceMcpReadRecord;
      readonly leaseToken: string;
    }
  | {
      readonly kind: "replay";
      readonly record: ProjectSourceMcpReadRecord;
    }
  | {
      readonly kind: "in_progress";
      readonly record: ProjectSourceMcpReadRecord;
    }
  | { readonly kind: "idempotency_conflict" };

export interface CompleteProjectSourceMcpReadInput {
  readonly requestId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly status: Exclude<ProjectSourceMcpReadStatus, "running">;
  readonly result: ProjectSourceFetchResult;
  readonly runtimeRequestId: string | null;
  readonly callId: string | null;
  readonly errorCategory: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type CompleteProjectSourceMcpReadResult =
  | {
      readonly kind: "completed";
      readonly record: ProjectSourceMcpReadRecord;
      readonly snapshot: ProjectSourceSnapshot;
    }
  | {
      readonly kind: "claim_lost";
      readonly reason:
        | "missing"
        | "terminal"
        | "owner_mismatch"
        | "token_mismatch"
        | "update_conflict";
    };

export class ProjectSourceMcpRepository {
  constructor(private readonly database: Database) {}

  async get(
    requestId: string,
  ): Promise<ProjectSourceMcpReadRecord | undefined> {
    const result = await this.database.query<ProjectSourceMcpReadRow>(
      "SELECT * FROM project_source_mcp_reads WHERE request_id = $1",
      [requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectSourceMcpReadFromRow(row);
  }

  async resolveBinding(input: {
    readonly projectId: string;
    readonly refKey: string;
    readonly businessChains: ProjectBusinessChainRepository;
  }): Promise<ResolvedMcpProjectSourceBinding | undefined> {
    const project = await input.businessChains.getProject(input.projectId);
    if (project === undefined || project.status !== "active") return undefined;
    const binding = await input.businessChains.getActiveBinding(
      input.projectId,
    );
    if (binding === null) return undefined;
    const ref = sourceRefFromBinding(binding.nodeBindings, input.refKey);
    if (
      ref === undefined ||
      ref.sourceKind !== "mcp" ||
      ref.providerId === undefined ||
      ref.providerVersionId === undefined ||
      ref.providerRevision === undefined ||
      ref.toolKey === undefined ||
      ref.readOnly !== true
    ) {
      return undefined;
    }
    const provider = await this.database.query<ProviderBindingRow>(
      `SELECT
         provider.id AS provider_id,
         provider.provider_key,
         provider.status AS provider_status,
         provider.health_status,
         provider.discovery_status,
         provider.revision AS provider_revision,
         provider.current_version_id,
         version.id AS provider_version_id,
         version.version AS provider_version,
         tool.tool_key,
         tool.tool_name,
         tool.schema_digest
       FROM mcp_providers AS provider
       JOIN mcp_provider_versions AS version
         ON version.id = $2 AND version.provider_id = provider.id
       JOIN mcp_provider_tools AS tool
         ON tool.provider_id = provider.id
        AND tool.provider_version_id = version.id
        AND tool.tool_key = $3
       WHERE provider.id = $1`,
      [ref.providerId, ref.providerVersionId, ref.toolKey],
    );
    const row = provider.rows[0];
    if (
      row === undefined ||
      row.provider_status !== "active" ||
      row.health_status !== "healthy" ||
      row.discovery_status !== "ready" ||
      row.current_version_id !== row.provider_version_id ||
      row.provider_revision !== ref.providerRevision
    ) {
      return undefined;
    }
    return {
      projectId: input.projectId,
      ref,
      bindingRevision: binding.revision,
      bindingDigest: binding.bindingDigest,
      sourceBindingDigest: digest(
        stableJson({
          projectId: input.projectId,
          bindingRevision: binding.revision,
          bindingDigest: binding.bindingDigest,
          ref,
        }),
      ),
      providerId: row.provider_id,
      providerKey: row.provider_key,
      providerVersionId: row.provider_version_id,
      providerVersion: row.provider_version,
      providerRevision: row.provider_revision,
      toolKey: row.tool_key,
      toolName: row.tool_name,
      toolSchemaDigest: row.schema_digest,
    };
  }

  async begin(
    input: BeginProjectSourceMcpReadInput,
  ): Promise<BeginProjectSourceMcpReadResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `project-source-mcp:${input.binding.projectId}:${input.binding.sourceBindingDigest}:${input.binding.ref.refKey}:${input.idempotencyKey}`,
        ],
      );
      const existing = await client.query<ProjectSourceMcpReadRow>(
        `SELECT *
         FROM project_source_mcp_reads
         WHERE project_id = $1
           AND source_binding_digest = $2
           AND ref_key = $3
           AND idempotency_key = $4
         FOR UPDATE`,
        [
          input.binding.projectId,
          input.binding.sourceBindingDigest,
          input.binding.ref.refKey,
          input.idempotencyKey,
        ],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (current.request_digest !== input.requestDigest) {
          return { kind: "idempotency_conflict" as const };
        }
        return current.status === "running"
          ? {
              kind: "in_progress" as const,
              record: projectSourceMcpReadFromRow(current),
            }
          : {
              kind: "replay" as const,
              record: projectSourceMcpReadFromRow(current),
            };
      }
      const now = new Date();
      const leaseToken = randomUUID();
      const inserted = await client.query<ProjectSourceMcpReadRow>(
        `INSERT INTO project_source_mcp_reads (
           request_id, project_id, ref_key, source_kind, source_system,
           source_object_type, source_object_id, source_path,
           source_binding_revision, source_binding_digest, provider_id,
           provider_version_id, provider_revision, tool_key, run_id,
           run_attempt, ticket_id, gate_id, policy_id, policy_revision,
           envelope_id, envelope_digest, idempotency_key, request_digest,
           status, lease_owner, lease_token, lease_expires_at, started_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'mcp', $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
           'running', $24, $25,
           NOW() + ($26::text || ' seconds')::interval, $27, $27, $27
         )
         RETURNING *`,
        [
          input.requestId,
          input.binding.projectId,
          input.binding.ref.refKey,
          input.binding.ref.sourceSystem,
          input.binding.ref.objectType,
          input.binding.ref.objectId,
          input.binding.ref.path,
          input.binding.bindingRevision,
          input.binding.sourceBindingDigest,
          input.binding.providerId,
          input.binding.providerVersionId,
          input.binding.providerRevision,
          input.binding.toolKey,
          input.runId,
          input.runAttempt,
          input.ticketId,
          input.gateId,
          input.policyId,
          input.policyRevision,
          input.envelopeId,
          input.envelopeDigest,
          input.idempotencyKey,
          input.requestDigest,
          input.leaseOwner,
          leaseToken,
          input.leaseSeconds,
          now,
        ],
      );
      return {
        kind: "claimed" as const,
        record: projectSourceMcpReadFromRow(inserted.rows[0]!),
        leaseToken,
      };
    });
  }

  async complete(
    input: CompleteProjectSourceMcpReadInput,
  ): Promise<CompleteProjectSourceMcpReadResult> {
    return this.database.transaction(async (client) => {
      const current = await client.query<ProjectSourceMcpReadRow>(
        `SELECT *
         FROM project_source_mcp_reads
         WHERE request_id = $1
         FOR UPDATE`,
        [input.requestId],
      );
      const record = current.rows[0];
      if (
        record === undefined
      ) {
        return { kind: "claim_lost" as const, reason: "missing" as const };
      }
      if (record.status !== "running") {
        return { kind: "claim_lost" as const, reason: "terminal" as const };
      }
      if (record.lease_owner !== input.leaseOwner) {
        return {
          kind: "claim_lost" as const,
          reason: "owner_mismatch" as const,
        };
      }
      if (record.lease_token !== input.leaseToken) {
        return {
          kind: "claim_lost" as const,
          reason: "token_mismatch" as const,
        };
      }
      const snapshot = await insertSourceSnapshotWithClient(client, {
        projectId: record.project_id,
        actorId: "system:project-source-worker",
        result: input.result,
      });
      const completedAt = new Date();
      const updated = await client.query<ProjectSourceMcpReadRow>(
        `UPDATE project_source_mcp_reads
         SET status = $2,
             runtime_request_id = $3,
             call_id = $4,
             snapshot_id = $5,
             source_revision = $6,
             error_category = $7,
             error_code = $8,
             error_message = $9,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = $10,
             updated_at = $10
         WHERE request_id = $1
           AND status = 'running'
         RETURNING *`,
        [
          input.requestId,
          input.status,
          input.runtimeRequestId,
          input.callId,
          snapshot.id,
          input.result.sourceRevision,
          input.errorCategory?.slice(0, 80) ?? null,
          input.errorCode?.slice(0, 160) ?? null,
          input.errorMessage?.slice(0, 2_000) ?? null,
          completedAt,
        ],
      );
      const terminal = updated.rows[0];
      if (terminal === undefined) {
        return {
          kind: "claim_lost" as const,
          reason: "update_conflict" as const,
        };
      }
      return {
        kind: "completed" as const,
        record: projectSourceMcpReadFromRow(terminal),
        snapshot,
      };
    });
  }

  async reconcileExpired(limit = 50): Promise<number> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<ProjectSourceMcpReadRow>(
        `SELECT *
         FROM project_source_mcp_reads
         WHERE status = 'running'
           AND lease_expires_at <= NOW()
         ORDER BY lease_expires_at, request_id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      for (const row of expired.rows) {
        const result = failedSourceResult(row, {
          category: "unknown",
          code: "project_source_worker_lease_expired",
          message: "The project source Worker lease expired",
        });
        const snapshot = await insertSourceSnapshotWithClient(client, {
          projectId: row.project_id,
          actorId: "system:project-source-worker",
          result,
        });
        await client.query(
          `UPDATE project_source_mcp_reads
           SET status = 'interrupted',
               snapshot_id = $2,
               error_category = 'unknown',
               error_code = 'project_source_worker_lease_expired',
               error_message = 'The project source Worker lease expired',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               completed_at = NOW(),
               updated_at = NOW()
           WHERE request_id = $1
             AND status = 'running'`,
          [row.request_id, snapshot.id],
        );
      }
      return expired.rows.length;
    });
  }

  async summary(): Promise<ProjectSourceMcpReadSummary> {
    const result = await this.database.query<{
      readonly status: ProjectSourceMcpReadStatus;
      readonly error_category: string | null;
      readonly count: string;
      readonly stale: string;
      readonly oldest_running_seconds: string;
    }>(
      `SELECT
         status,
         error_category,
         COUNT(*)::text AS count,
         COUNT(*) FILTER (
           WHERE status = 'running' AND lease_expires_at <= NOW()
         )::text AS stale,
         COALESCE(
           EXTRACT(EPOCH FROM (
             NOW() - MIN(started_at) FILTER (WHERE status = 'running')
           ))::bigint,
           0
         )::text AS oldest_running_seconds
       FROM project_source_mcp_reads
       GROUP BY status, error_category`,
    );
    const counts = new Map<ProjectSourceMcpReadStatus, number>();
    const errors = new Map<string, number>();
    let staleRunning = 0;
    let oldestRunningAgeSeconds = 0;
    for (const row of result.rows) {
      counts.set(
        row.status,
        (counts.get(row.status) ?? 0) + Number(row.count),
      );
      staleRunning += Number(row.stale);
      oldestRunningAgeSeconds = Math.max(
        oldestRunningAgeSeconds,
        Number(row.oldest_running_seconds),
      );
      if (row.error_category !== null) {
        errors.set(
          row.error_category,
          (errors.get(row.error_category) ?? 0) + Number(row.count),
        );
      }
    }
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const failed =
      (counts.get("failed") ?? 0) +
      (counts.get("timed_out") ?? 0) +
      (counts.get("cancelled") ?? 0) +
      (counts.get("interrupted") ?? 0);
    const errorRatio = total === 0 ? 0 : failed / total;
    const alertReasons: ProjectSourceMcpReadSummary["alertReasons"][number][] =
      [];
    if (staleRunning > 0) alertReasons.push("stale_running");
    if (oldestRunningAgeSeconds >= 900) {
      alertReasons.push("oldest_running_critical");
    } else if (oldestRunningAgeSeconds >= 300) {
      alertReasons.push("oldest_running_warning");
    }
    if (total >= 10 && errorRatio >= 0.5) {
      alertReasons.push("error_ratio_critical");
    } else if (total >= 10 && errorRatio >= 0.25) {
      alertReasons.push("error_ratio_warning");
    }
    return {
      total,
      running: counts.get("running") ?? 0,
      staleRunning,
      succeeded: counts.get("succeeded") ?? 0,
      failed: counts.get("failed") ?? 0,
      timedOut: counts.get("timed_out") ?? 0,
      cancelled: counts.get("cancelled") ?? 0,
      interrupted: counts.get("interrupted") ?? 0,
      oldestRunningAgeSeconds,
      alertLevel:
        staleRunning > 0 ||
        alertReasons.includes("oldest_running_critical") ||
        alertReasons.includes("error_ratio_critical")
          ? "critical"
          : alertReasons.length > 0
            ? "warning"
            : "ok",
      alertReasons,
      errorCategories: [...errors]
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => left.category.localeCompare(right.category)),
    };
  }

  async retentionPreview(
    retentionDays: number,
  ): Promise<ProjectSourceMcpRetentionResult> {
    const result = await this.database.query<{
      readonly eligible_reads: string;
      readonly eligible_events: string;
      readonly eligible_snapshots: string;
      readonly oldest_eligible_completed_at: Date | null;
    }>(
      `WITH eligible AS (
         SELECT request_id, snapshot_id, completed_at
         FROM project_source_mcp_reads
         WHERE status <> 'running'
           AND completed_at < NOW() - ($1::text || ' days')::interval
       )
       SELECT
         (SELECT COUNT(*) FROM eligible)::text AS eligible_reads,
         (
           SELECT COUNT(*)
           FROM project_source_mcp_read_events AS event
           JOIN eligible ON eligible.request_id = event.request_id
         )::text AS eligible_events,
         (
           SELECT COUNT(DISTINCT snapshot_id)
           FROM eligible
           WHERE snapshot_id IS NOT NULL
         )::text AS eligible_snapshots,
         (SELECT MIN(completed_at) FROM eligible) AS oldest_eligible_completed_at`,
      [retentionDays],
    );
    const row = result.rows[0];
    return {
      retentionDays,
      eligibleReads: Number(row?.eligible_reads ?? "0"),
      eligibleEvents: Number(row?.eligible_events ?? "0"),
      eligibleSnapshots: Number(row?.eligible_snapshots ?? "0"),
      oldestEligibleCompletedAt:
        row?.oldest_eligible_completed_at?.toISOString() ?? null,
      dryRun: true,
      action: "archive-before-delete",
    };
  }
}

function sourceRefFromBinding(
  nodeBindings: readonly {
    readonly fieldBindings: readonly {
      readonly fieldKey: string;
      readonly sourceKind: string;
      readonly sourceSystem: string;
      readonly objectType: string;
      readonly objectId: string;
      readonly path: string;
      readonly required: boolean;
      readonly providerId?: string | undefined;
      readonly providerVersionId?: string | undefined;
      readonly providerRevision?: number | undefined;
      readonly toolKey?: string | undefined;
      readonly readOnly?: true | undefined;
    }[];
  }[],
  refKey: string,
): BusinessChainSourceRef | undefined {
  for (const node of nodeBindings) {
    for (const field of node.fieldBindings) {
      const candidate = `${field.sourceSystem}:${field.objectType}:${field.objectId}`;
      if (candidate !== refKey) continue;
      return {
        refKey: candidate,
        sourceKind: field.sourceKind,
        sourceSystem: field.sourceSystem,
        objectType: field.objectType,
        objectId: field.objectId,
        path: field.path,
        required: field.required,
        ...(field.providerId === undefined
          ? {}
          : { providerId: field.providerId }),
        ...(field.providerVersionId === undefined
          ? {}
          : { providerVersionId: field.providerVersionId }),
        ...(field.providerRevision === undefined
          ? {}
          : { providerRevision: field.providerRevision }),
        ...(field.toolKey === undefined ? {} : { toolKey: field.toolKey }),
        ...(field.readOnly === undefined
          ? {}
          : { readOnly: field.readOnly }),
      };
    }
  }
  return undefined;
}

async function insertSourceSnapshotWithClient(
  client: PoolClient,
  input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly result: ProjectSourceFetchResult;
  },
): Promise<ProjectSourceSnapshot> {
  const payloadDigest =
    input.result.payload === null || input.result.status === "error"
      ? null
      : digest(stableJson(input.result.payload));
  const inserted = await client.query<SourceSnapshotRow>(
    `INSERT INTO project_source_snapshots (
       id, project_id, ref_key, source_kind, source_system,
       source_object_type, source_object_id, source_revision, version,
       status, observed_at, effective_at, fresh_until, payload_digest,
       payload, failure_reason, is_mock, created_by_principal_id, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13,
       $14::jsonb, $15, $16, $17, NOW()
     )
     RETURNING *`,
    [
      randomUUID(),
      input.projectId,
      input.result.refKey,
      input.result.sourceKind,
      input.result.sourceSystem,
      input.result.objectType,
      input.result.objectId,
      input.result.sourceRevision,
      input.result.status,
      input.result.observedAt,
      input.result.effectiveAt,
      input.result.freshUntil,
      payloadDigest,
      input.result.payload === null
        ? null
        : JSON.stringify(input.result.payload),
      input.result.failureReason,
      input.result.isMock,
      input.actorId,
    ],
  );
  return sourceSnapshotFromRow(inserted.rows[0]!);
}

function projectSourceMcpReadFromRow(
  row: ProjectSourceMcpReadRow,
): ProjectSourceMcpReadRecord {
  return projectSourceMcpReadRecordSchema.parse({
    requestId: row.request_id,
    runtimeRequestId: row.runtime_request_id,
    projectId: row.project_id,
    refKey: row.ref_key,
    sourceKind: row.source_kind,
    sourceSystem: row.source_system,
    sourceObjectType: row.source_object_type,
    sourceObjectId: row.source_object_id,
    sourcePath: row.source_path,
    sourceBindingRevision: row.source_binding_revision,
    sourceBindingDigest: row.source_binding_digest,
    providerId: row.provider_id,
    providerVersionId: row.provider_version_id,
    providerRevision: row.provider_revision,
    toolKey: row.tool_key,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
    callId: row.call_id,
    snapshotId: row.snapshot_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    status: row.status,
    sourceRevision: row.source_revision,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function sourceSnapshotFromRow(row: SourceSnapshotRow): ProjectSourceSnapshot {
  return projectSourceSnapshotSchema.parse({
    id: row.id,
    projectId: row.project_id,
    refKey: row.ref_key,
    sourceKind: row.source_kind,
    sourceSystem: row.source_system,
    sourceObjectType: row.source_object_type,
    sourceObjectId: row.source_object_id,
    sourceRevision: row.source_revision,
    version: row.version,
    status: row.status,
    observedAt: row.observed_at.toISOString(),
    effectiveAt: row.effective_at?.toISOString() ?? null,
    freshUntil: row.fresh_until?.toISOString() ?? null,
    payloadDigest: row.payload_digest,
    payload: row.payload,
    failureReason: row.failure_reason,
    isMock: row.is_mock,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  });
}

function failedSourceResult(
  row: ProjectSourceMcpReadRow,
  failure: {
    readonly category: string;
    readonly code: string;
    readonly message: string;
  },
): ProjectSourceFetchResult {
  return {
    refKey: row.ref_key,
    sourceKind: "mcp",
    sourceSystem: row.source_system,
    objectType: row.source_object_type,
    objectId: row.source_object_id,
    sourceRevision: null,
    observedAt: new Date().toISOString(),
    effectiveAt: null,
    freshUntil: null,
    status: "error",
    payload: null,
    failureReason: `${failure.category}:${failure.code}`,
    isMock: false,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type ProjectSourceSnapshotCoverage =
  ProjectProgressOverview["coverage"]["sources"][number];
