import type {
  Job,
  RuntimeEffectReceipt,
  RuntimeJobAttempt,
  RuntimeMaintenance,
  RuntimeTrace,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import {
  runEventFromRow,
  runFromRow,
  type RunEventRow,
  type RunRow,
} from "./rows.js";

interface TraceJobRow {
  id: string;
  run_id: string;
  kind: string;
  status: Job["status"];
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  last_error: string | null;
  recovery_count: number;
  manual_recovery_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  dead_letter_at: Date | null;
}

interface TraceJobAttemptRow {
  id: string;
  job_id: string;
  attempt: number;
  worker_id: string;
  status: RuntimeJobAttempt["status"];
  trace_id: string | null;
  span_id: string | null;
  error: string | null;
  started_at: Date;
  heartbeat_at: Date;
  ended_at: Date | null;
}

interface TraceEffectRow {
  id: string;
  effect_key: string;
  run_id: string;
  trace_id: string | null;
  job_id: string | null;
  operation: string;
  status: RuntimeEffectReceipt["status"];
  attempt: number;
  replay_count: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  cancel_requested_at: Date | null;
  cancel_acknowledged_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

interface TraceMaintenanceRow {
  id: string;
  kind: RuntimeMaintenance["kind"];
  status: RuntimeMaintenance["status"];
  trace_id: string | null;
  trigger_source: RuntimeMaintenance["triggerSource"];
  scheduled_for: Date | null;
  duration_ms: number | null;
  processed_count: number;
  archived_count: number;
  deleted_count: number;
  error: string | null;
  metrics: Record<string, unknown>;
  started_at: Date;
  completed_at: Date;
}

function jobFromRow(row: TraceJobRow): Job {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    traceId: row.trace_id,
    availableAt: row.available_at.toISOString(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    lastError: row.last_error,
    recoveryCount: row.recovery_count,
    manualRecoveryCount: row.manual_recovery_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    deadLetterAt: row.dead_letter_at?.toISOString() ?? null,
  };
}

function attemptFromRow(row: TraceJobAttemptRow): RuntimeJobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attempt: row.attempt,
    workerId: row.worker_id,
    status: row.status,
    traceId: row.trace_id,
    spanId: row.span_id,
    error: row.error,
    startedAt: row.started_at.toISOString(),
    heartbeatAt: row.heartbeat_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

function effectFromRow(row: TraceEffectRow): RuntimeEffectReceipt {
  return {
    id: row.id,
    effectKey: row.effect_key,
    runId: row.run_id,
    traceId: row.trace_id,
    jobId: row.job_id,
    operation: row.operation,
    status: row.status,
    attempt: row.attempt,
    replayCount: row.replay_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    result: row.result,
    error: row.error,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    cancelAcknowledgedAt: row.cancel_acknowledged_at?.toISOString() ?? null,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function maintenanceFromRow(row: TraceMaintenanceRow): RuntimeMaintenance {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    traceId: row.trace_id,
    triggerSource: row.trigger_source,
    scheduledFor: row.scheduled_for?.toISOString() ?? null,
    durationMs: row.duration_ms,
    processedCount: row.processed_count,
    archivedCount: row.archived_count,
    deletedCount: row.deleted_count,
    error: row.error,
    metrics: row.metrics,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at.toISOString(),
  };
}

export class RuntimeTraceRepository {
  constructor(private readonly database: Database) {}

  async get(traceId: string): Promise<RuntimeTrace | undefined> {
    const [runs, runEvents, jobs, jobAttempts, runtimeEffects, maintenance] =
      await Promise.all([
        this.database.query<RunRow>(
          "SELECT * FROM runs WHERE trace_id = $1 ORDER BY created_at",
          [traceId],
        ),
        this.database.query<RunEventRow>(
          `SELECT * FROM run_events
           WHERE trace_id = $1
           ORDER BY created_at, run_id, seq`,
          [traceId],
        ),
        this.database.query<TraceJobRow>(
          "SELECT * FROM jobs WHERE trace_id = $1 ORDER BY created_at",
          [traceId],
        ),
        this.database.query<TraceJobAttemptRow>(
          `SELECT * FROM job_attempts
           WHERE trace_id = $1
           ORDER BY started_at, attempt`,
          [traceId],
        ),
        this.database.query<TraceEffectRow>(
          `SELECT * FROM runtime_effect_receipts
           WHERE trace_id = $1
           ORDER BY started_at`,
          [traceId],
        ),
        this.database.query<TraceMaintenanceRow>(
          `SELECT * FROM runtime_maintenance_runs
           WHERE trace_id = $1
           ORDER BY started_at`,
          [traceId],
        ),
      ]);
    if (
      runs.rows.length === 0 &&
      runEvents.rows.length === 0 &&
      jobs.rows.length === 0 &&
      jobAttempts.rows.length === 0 &&
      runtimeEffects.rows.length === 0 &&
      maintenance.rows.length === 0
    ) {
      return undefined;
    }
    return {
      traceId,
      runs: runs.rows.map(runFromRow),
      runEvents: runEvents.rows.map(runEventFromRow),
      jobs: jobs.rows.map(jobFromRow),
      jobAttempts: jobAttempts.rows.map(attemptFromRow),
      runtimeEffects: runtimeEffects.rows.map(effectFromRow),
      maintenanceRuns: maintenance.rows.map(maintenanceFromRow),
    };
  }
}
