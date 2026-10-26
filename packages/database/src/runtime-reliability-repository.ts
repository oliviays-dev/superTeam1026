import { randomUUID } from "node:crypto";
import type {
  ApprovalSlaItem,
  IdempotencyCleanupInput,
  IdempotencyCleanupResult,
  RuntimeMaintenance,
  RuntimeMetrics,
  WorkerHeartbeat,
  WorkerStatus,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  concurrency: number;
  status: WorkerStatus;
  started_at: Date;
  heartbeat_at: Date;
  stopping_at: Date | null;
  stopped_at: Date | null;
  metadata: Record<string, unknown>;
}

interface MaintenanceRow {
  id: string;
  kind: RuntimeMaintenance["kind"];
  status: RuntimeMaintenance["status"];
  processed_count: number;
  archived_count: number;
  deleted_count: number;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: Date;
  completed_at: Date;
}

function workerFromRow(row: WorkerRow): WorkerHeartbeat {
  return {
    id: row.id,
    hostname: row.hostname,
    pid: row.pid,
    concurrency: row.concurrency,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
    stoppingAt: row.stopping_at?.toISOString() ?? null,
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    metadata: row.metadata,
  };
}

function maintenanceFromRow(row: MaintenanceRow): RuntimeMaintenance {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    processedCount: row.processed_count,
    archivedCount: row.archived_count,
    deletedCount: row.deleted_count,
    error: row.error,
    metrics: row.metrics,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
  };
}

export interface WorkerHeartbeatInput {
  readonly id: string;
  readonly hostname: string;
  readonly pid: number;
  readonly concurrency: number;
  readonly status: WorkerStatus;
  readonly metadata?: Record<string, unknown>;
}

export class RuntimeReliabilityRepository {
  constructor(private readonly database: Database) {}

  async heartbeat(input: WorkerHeartbeatInput): Promise<void> {
    await this.database.query(
      `INSERT INTO runtime_workers (
         id, hostname, pid, concurrency, status, started_at, heartbeat_at,
         stopping_at, stopped_at, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, NOW(), NOW(),
         CASE WHEN $5 = 'draining' THEN NOW() ELSE NULL END,
         CASE WHEN $5 = 'stopped' THEN NOW() ELSE NULL END,
         $6::jsonb
       )
       ON CONFLICT (id) DO UPDATE
       SET
         hostname = EXCLUDED.hostname,
         pid = EXCLUDED.pid,
         concurrency = EXCLUDED.concurrency,
         status = EXCLUDED.status,
         heartbeat_at = NOW(),
         stopping_at =
           CASE
             WHEN EXCLUDED.status = 'draining' THEN COALESCE(runtime_workers.stopping_at, NOW())
             ELSE runtime_workers.stopping_at
           END,
         stopped_at =
           CASE
             WHEN EXCLUDED.status = 'stopped' THEN NOW()
             ELSE runtime_workers.stopped_at
           END,
         metadata = EXCLUDED.metadata`,
      [
        input.id,
        input.hostname,
        input.pid,
        input.concurrency,
        input.status,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async listWorkers(
    staleAfterSeconds: number,
    limit = 100,
  ): Promise<WorkerHeartbeat[]> {
    const result = await this.database.query<WorkerRow>(
      `SELECT *
       FROM runtime_workers
       WHERE heartbeat_at >= NOW() - (($1::integer * 5) || ' seconds')::interval
       ORDER BY
         CASE status
           WHEN 'running' THEN 0
           WHEN 'draining' THEN 1
           ELSE 2
         END,
         heartbeat_at DESC
       LIMIT $2`,
      [staleAfterSeconds, limit],
    );
    return result.rows.map(workerFromRow);
  }

  async countActiveWorkers(staleAfterSeconds: number): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM runtime_workers
       WHERE status = 'running'
         AND heartbeat_at >= NOW() - ($1 || ' seconds')::interval`,
      [staleAfterSeconds],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getMetrics(input: {
    readonly expectedMigrationVersion: number;
    readonly workerHeartbeatStaleAfterSeconds: number;
  }): Promise<RuntimeMetrics> {
    const stale = input.workerHeartbeatStaleAfterSeconds;
    const [migration, workers, jobs, runs, approvals, archive, maintenance] =
      await Promise.all([
        this.database.query<{ version: number | null }>(
          "SELECT MAX(version) AS version FROM platform_migrations",
        ),
        this.database.query<{
          active_workers: string;
          total_concurrency: string;
          active_jobs: string;
        }>(
          `SELECT
           (SELECT COUNT(*) FROM runtime_workers
            WHERE status = 'running'
              AND heartbeat_at >= NOW() - ($1 || ' seconds')::interval)::text
             AS active_workers,
           (SELECT COALESCE(SUM(concurrency), 0) FROM runtime_workers
            WHERE status = 'running'
              AND heartbeat_at >= NOW() - ($1 || ' seconds')::interval)::text
             AS total_concurrency,
           (SELECT COUNT(*) FROM jobs WHERE status = 'running')::text
             AS active_jobs`,
          [stale],
        ),
        this.database.query<{
          queue_depth: string;
          dead_letter_count: string;
          completed_24h: string;
          failed_24h: string;
        }>(
          `SELECT
           COUNT(*) FILTER (WHERE status = 'queued')::text AS queue_depth,
           COUNT(*) FILTER (WHERE status = 'dead_letter')::text
             AS dead_letter_count,
           COUNT(*) FILTER (
             WHERE status = 'completed'
               AND completed_at >= NOW() - INTERVAL '24 hours'
           )::text AS completed_24h,
           COUNT(*) FILTER (
             WHERE status IN ('failed', 'dead_letter')
               AND updated_at >= NOW() - INTERVAL '24 hours'
           )::text AS failed_24h
         FROM jobs`,
        ),
        this.database.query<{
          timed_out_24h: string;
          completed_24h: string;
        }>(
          `SELECT
           COUNT(*) FILTER (
             WHERE status = 'timeout'
               AND ended_at >= NOW() - INTERVAL '24 hours'
           )::text AS timed_out_24h,
           COUNT(*) FILTER (
             WHERE status = 'completed'
               AND ended_at >= NOW() - INTERVAL '24 hours'
           )::text AS completed_24h
         FROM runs`,
        ),
        this.database.query<{
          backlog: string;
          overdue: string;
          expired_24h: string;
        }>(
          `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::text AS backlog,
           COUNT(*) FILTER (
             WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= NOW()
           )::text AS overdue,
           COUNT(*) FILTER (
             WHERE status = 'expired'
               AND expired_at >= NOW() - INTERVAL '24 hours'
           )::text AS expired_24h
         FROM workflow_approvals`,
        ),
        this.database.query<{ count: string; bytes: string }>(
          `SELECT
           COUNT(*)::text AS count,
           COALESCE(SUM(pg_column_size(row_to_json(archive))), 0)::text AS bytes
         FROM workflow_idempotency_archive AS archive`,
        ),
        this.database.query<MaintenanceRow>(
          `SELECT *
         FROM runtime_maintenance_runs
         ORDER BY completed_at DESC
         LIMIT 1`,
        ),
      ]);
    const jobStats = jobs.rows[0]!;
    const runStats = runs.rows[0]!;
    const approvalStats = approvals.rows[0]!;
    const completedJobs = Number(jobStats.completed_24h);
    const failedJobs = Number(jobStats.failed_24h);
    const completedRuns = Number(runStats.completed_24h);
    const timedOutRuns = Number(runStats.timed_out_24h);
    const terminalJobs = completedJobs + failedJobs;
    const terminalRuns = completedRuns + timedOutRuns;
    return {
      generatedAt: new Date().toISOString(),
      expectedMigrationVersion: input.expectedMigrationVersion,
      migrationVersion: Number(migration.rows[0]?.version ?? 0),
      workerHeartbeatStaleAfterSeconds: stale,
      activeWorkers: Number(workers.rows[0]?.active_workers ?? 0),
      totalWorkerConcurrency: Number(workers.rows[0]?.total_concurrency ?? 0),
      activeJobs: Number(workers.rows[0]?.active_jobs ?? 0),
      queueDepth: Number(jobStats.queue_depth),
      deadLetterCount: Number(jobStats.dead_letter_count),
      jobFailureRate:
        terminalJobs === 0 ? 0 : Number((failedJobs / terminalJobs).toFixed(4)),
      jobSuccessRate:
        terminalJobs === 0
          ? 0
          : Number((completedJobs / terminalJobs).toFixed(4)),
      runTimeoutRate:
        terminalRuns === 0
          ? 0
          : Number((timedOutRuns / terminalRuns).toFixed(4)),
      approvalBacklog: Number(approvalStats.backlog),
      approvalSlaOverdue: Number(approvalStats.overdue),
      approvalSlaExpired24h: Number(approvalStats.expired_24h),
      archivedIdempotencyReceipts: Number(archive.rows[0]?.count ?? 0),
      archiveBytes: Number(archive.rows[0]?.bytes ?? 0),
      completedJobs24h: completedJobs,
      failedJobs24h: failedJobs,
      timedOutRuns24h: timedOutRuns,
      completedRuns24h: completedRuns,
      lastMaintenance:
        maintenance.rows[0] === undefined
          ? null
          : maintenanceFromRow(maintenance.rows[0]),
    };
  }

  async listApprovalSlaOverdue(limit = 20): Promise<ApprovalSlaItem[]> {
    const result = await this.database.query<{
      instance_id: string;
      node_id: string;
      round: number;
      pending_count: number;
      due_at: Date | null;
      expires_at: Date | null;
      overdue: boolean;
    }>(
      `SELECT
         instance_id,
         node_id,
         round,
         COUNT(*)::integer AS pending_count,
         MIN(due_at) AS due_at,
         MIN(expires_at) AS expires_at,
         BOOL_OR(due_at IS NOT NULL AND due_at <= NOW()) AS overdue
       FROM workflow_approvals
       WHERE status = 'pending'
       GROUP BY instance_id, node_id, round
       HAVING BOOL_OR(due_at IS NOT NULL AND due_at <= NOW())
       ORDER BY MIN(due_at)
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      instanceId: row.instance_id,
      nodeId: row.node_id,
      round: row.round,
      pendingCount: row.pending_count,
      dueAt: row.due_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null,
      overdue: row.overdue,
    }));
  }

  async cleanupIdempotencyReceipts(
    input: IdempotencyCleanupInput,
  ): Promise<IdempotencyCleanupResult> {
    return this.database.transaction(async (client) => {
      const maintenanceId = randomUUID();
      const cutoff = new Date(Date.now() - input.olderThanSeconds * 1_000);
      const candidates = await client.query<{ id: string }>(
        `SELECT id
         FROM workflow_idempotency_keys
         WHERE state IN ('completed', 'failed')
           AND COALESCE(completed_at, updated_at) < $1
         ORDER BY COALESCE(completed_at, updated_at)
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [cutoff, input.batchSize],
      );
      let archived = 0;
      let deleted = 0;
      for (const row of candidates.rows) {
        const inserted = await client.query(
          `INSERT INTO workflow_idempotency_archive (
             id, original_id, scope, operation, idempotency_key, request_hash,
             state, response_status, response_body, created_at, updated_at,
             completed_at, archived_at, archive_reason
           )
           SELECT
             $2, id, scope, operation, idempotency_key, request_hash, state,
             response_status, response_body, created_at, updated_at,
             completed_at, NOW(), 'retention_policy'
           FROM workflow_idempotency_keys
           WHERE id = $1
           ON CONFLICT (original_id) DO NOTHING
           RETURNING id`,
          [row.id, randomUUID()],
        );
        archived += inserted.rowCount ?? 0;
        const removed = await client.query(
          "DELETE FROM workflow_idempotency_keys WHERE id = $1",
          [row.id],
        );
        deleted += removed.rowCount ?? 0;
      }
      await client.query(
        `INSERT INTO runtime_maintenance_runs (
           id, kind, status, processed_count, archived_count, deleted_count,
           metrics, started_at, completed_at
         ) VALUES (
           $1, 'idempotency_cleanup', 'completed', $2, $3, $4,
           $5::jsonb, NOW(), NOW()
         )`,
        [
          maintenanceId,
          candidates.rowCount ?? 0,
          archived,
          deleted,
          JSON.stringify({
            olderThanSeconds: input.olderThanSeconds,
            batchSize: input.batchSize,
          }),
        ],
      );
      return {
        processedCount: candidates.rowCount ?? 0,
        archivedCount: archived,
        deletedCount: deleted,
        cutoff: cutoff.toISOString(),
        maintenanceId,
      };
    });
  }

  async recordMaintenance(input: {
    readonly kind: RuntimeMaintenance["kind"];
    readonly status: RuntimeMaintenance["status"];
    readonly processedCount: number;
    readonly archivedCount?: number;
    readonly deletedCount?: number;
    readonly error?: string;
    readonly metrics?: Record<string, unknown>;
    readonly startedAt: Date;
  }): Promise<RuntimeMaintenance> {
    const result = await this.database.query<MaintenanceRow>(
      `INSERT INTO runtime_maintenance_runs (
         id, kind, status, processed_count, archived_count, deleted_count,
         error, metrics, started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.kind,
        input.status,
        input.processedCount,
        input.archivedCount ?? 0,
        input.deletedCount ?? 0,
        input.error ?? null,
        JSON.stringify(input.metrics ?? {}),
        input.startedAt,
      ],
    );
    return maintenanceFromRow(result.rows[0]!);
  }
}
