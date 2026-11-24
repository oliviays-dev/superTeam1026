import { randomUUID } from "node:crypto";
import type {
  McpToolCallErrorCategory,
  McpToolInputSummary,
  McpToolOutputSummary,
  RuntimeToolRequestDetail,
  RuntimeToolRequestReceipt,
  RuntimeToolRequestRecord,
  RuntimeToolRequestRetentionResult,
  RuntimeToolRequestSummary,
  RuntimeToolRequestTerminalStatus,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface RuntimeToolRequestRow {
  readonly request_id: string;
  readonly run_id: string;
  readonly run_attempt: number;
  readonly task_id: string;
  readonly project_id: string;
  readonly agent_id: string;
  readonly agent_principal_id: string | null;
  readonly tool_key: string;
  readonly ticket_id: string;
  readonly gate_id: string;
  readonly policy_id: string;
  readonly policy_revision: number;
  readonly envelope_id: string;
  readonly envelope_digest: string;
  readonly call_id: string | null;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly status: RuntimeToolRequestRecord["status"];
  readonly input_summary: McpToolInputSummary;
  readonly output_summary: McpToolOutputSummary | null;
  readonly output_digest: string | null;
  readonly error_category: McpToolCallErrorCategory | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RuntimeToolRequestReceiptRow {
  readonly id: string;
  readonly request_id: string;
  readonly seq: string | number;
  readonly status: RuntimeToolRequestReceipt["status"];
  readonly request_digest: string;
  readonly input_summary: McpToolInputSummary;
  readonly output_summary: McpToolOutputSummary | null;
  readonly output_digest: string | null;
  readonly error_category: McpToolCallErrorCategory | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: Date;
}

export interface BeginRuntimeToolRequestInput {
  readonly requestId: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly agentPrincipalId: string | null;
  readonly toolKey: string;
  readonly ticketId: string;
  readonly gateId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly envelopeId: string;
  readonly envelopeDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly inputSummary: McpToolInputSummary;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export type BeginRuntimeToolRequestResult =
  | {
      readonly kind: "claimed";
      readonly detail: RuntimeToolRequestDetail;
      readonly leaseToken: string;
    }
  | { readonly kind: "replay"; readonly detail: RuntimeToolRequestDetail }
  | {
      readonly kind: "in_progress";
      readonly detail: RuntimeToolRequestDetail;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "gate_already_used" };

export interface CompleteRuntimeToolRequestInput {
  readonly requestId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly status: RuntimeToolRequestTerminalStatus;
  readonly callId?: string | null;
  readonly outputSummary?: McpToolOutputSummary | null;
  readonly outputDigest?: string | null;
  readonly errorCategory?: McpToolCallErrorCategory | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export type CompleteRuntimeToolRequestResult =
  | {
      readonly kind: "completed";
      readonly detail: RuntimeToolRequestDetail;
    }
  | { readonly kind: "claim_lost" };

export type RuntimeToolRequestRepositoryErrorCode =
  | "runtime_tool_request_not_found"
  | "runtime_tool_request_invalid_transition";

export class RuntimeToolRequestRepositoryError extends Error {
  constructor(
    readonly code: RuntimeToolRequestRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeToolRequestRepositoryError";
  }
}

export class RuntimeToolRequestRepository {
  constructor(private readonly database: Database) {}

  async begin(
    input: BeginRuntimeToolRequestInput,
  ): Promise<BeginRuntimeToolRequestResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`runtime-tool-request:${input.requestId}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`runtime-tool-idempotency:${input.runId}:${input.idempotencyKey}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`runtime-tool-gate:${input.gateId}`],
      );

      const existing = await client.query<RuntimeToolRequestRow>(
        `SELECT *
         FROM runtime_tool_requests
         WHERE request_id = $1
            OR (run_id = $2 AND idempotency_key = $3)
         FOR UPDATE`,
        [input.requestId, input.runId, input.idempotencyKey],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (current.request_digest !== input.requestDigest) {
          return { kind: "idempotency_conflict" as const };
        }
        return {
          kind:
            current.status === "running"
              ? ("in_progress" as const)
              : ("replay" as const),
          detail: await this.detailFromRowWithClient(client, current),
        };
      }

      const gateUsage = await client.query<{ readonly used: boolean }>(
        `SELECT (
           EXISTS (
             SELECT 1 FROM runtime_tool_requests
             WHERE gate_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM mcp_tool_calls
             WHERE gate_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM tool_invocations
             WHERE gate_id = $1
           )
         ) AS used`,
        [input.gateId],
      );
      if (gateUsage.rows[0]?.used === true) {
        return { kind: "gate_already_used" as const };
      }

      const now = new Date();
      const leaseToken = randomUUID();
      const inserted = await client.query<RuntimeToolRequestRow>(
        `INSERT INTO runtime_tool_requests (
           request_id, run_id, run_attempt, task_id, project_id, agent_id,
           agent_principal_id, tool_key, ticket_id, gate_id, policy_id,
           policy_revision, envelope_id, envelope_digest, idempotency_key,
           request_digest, status, input_summary, lease_owner, lease_token,
           lease_expires_at, started_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, 'running', $17::jsonb, $18, $19,
           NOW() + ($20::text || ' seconds')::interval, $21, $21, $21
         )
         RETURNING *`,
        [
          input.requestId,
          input.runId,
          input.runAttempt,
          input.taskId,
          input.projectId,
          input.agentId,
          input.agentPrincipalId,
          input.toolKey,
          input.ticketId,
          input.gateId,
          input.policyId,
          input.policyRevision,
          input.envelopeId,
          input.envelopeDigest,
          input.idempotencyKey,
          input.requestDigest,
          JSON.stringify(input.inputSummary),
          input.leaseOwner,
          leaseToken,
          input.leaseSeconds,
          now,
        ],
      );
      return {
        kind: "claimed" as const,
        detail: await this.detailFromRowWithClient(
          client,
          inserted.rows[0]!,
        ),
        leaseToken,
      };
    });
  }

  async complete(
    input: CompleteRuntimeToolRequestInput,
  ): Promise<CompleteRuntimeToolRequestResult> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<RuntimeToolRequestRow>(
        `SELECT *
         FROM runtime_tool_requests
         WHERE request_id = $1
         FOR UPDATE`,
        [input.requestId],
      );
      const request = locked.rows[0];
      if (
        request === undefined ||
        request.status !== "running" ||
        (await this.leaseMatches(client, input))
      ) {
        return { kind: "claim_lost" as const };
      }
      const now = new Date();
      const updated = await client.query<RuntimeToolRequestRow>(
        `UPDATE runtime_tool_requests
         SET status = $2,
             call_id = COALESCE($3, call_id),
             output_summary = $4::jsonb,
             output_digest = $5,
             error_category = $6,
             error_code = $7,
             error_message = $8,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = GREATEST($9, started_at),
             updated_at = GREATEST($9, created_at, started_at)
         WHERE request_id = $1
           AND status = 'running'
         RETURNING *`,
        [
          input.requestId,
          input.status,
          input.callId ?? null,
          input.outputSummary === null || input.outputSummary === undefined
            ? null
            : JSON.stringify(input.outputSummary),
          input.outputDigest ?? null,
          input.errorCategory ?? null,
          input.errorCode?.slice(0, 160) ?? null,
          input.errorMessage?.slice(0, 2_000) ?? null,
          now,
        ],
      );
      const terminal = updated.rows[0];
      if (terminal === undefined) return { kind: "claim_lost" as const };
      return {
        kind: "completed" as const,
        detail: await this.detailFromRowWithClient(client, terminal),
      };
    });
  }

  async reconcileExpired(limit = 50): Promise<number> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<
        RuntimeToolRequestRow & { readonly run_status: string }
      >(
        `SELECT request.*, run.status AS run_status
         FROM runtime_tool_requests AS request
         JOIN runs AS run ON run.id = request.run_id
         WHERE request.status = 'running'
           AND (
             request.lease_expires_at <= NOW()
             OR run.status <> 'running'
           )
         ORDER BY request.lease_expires_at, request.request_id
         FOR UPDATE OF request SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      let reconciled = 0;
      for (const request of expired.rows) {
        const outcome = terminalForRunState({
          runStatus: request.run_status,
          leaseExpired:
            new Date(request.started_at).getTime() < Date.now(),
        });
        const updated = await client.query(
          `UPDATE runtime_tool_requests
           SET status = $2,
               error_category = $3,
               error_code = $4,
               error_message = $5,
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               completed_at = GREATEST(NOW(), started_at),
               updated_at = GREATEST(NOW(), created_at, started_at)
           WHERE request_id = $1
             AND status = 'running'`,
          [
            request.request_id,
            outcome.status,
            outcome.errorCategory,
            outcome.errorCode,
            outcome.errorMessage,
          ],
        );
        reconciled += updated.rowCount ?? 0;
      }
      return reconciled;
    });
  }

  async findByRequestId(
    requestId: string,
  ): Promise<RuntimeToolRequestDetail | undefined> {
    const result = await this.database.query<RuntimeToolRequestRow>(
      "SELECT * FROM runtime_tool_requests WHERE request_id = $1",
      [requestId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.detailFromRow(row);
  }

  async findByRunAndIdempotency(input: {
    readonly runId: string;
    readonly idempotencyKey: string;
  }): Promise<RuntimeToolRequestDetail | undefined> {
    const result = await this.database.query<RuntimeToolRequestRow>(
      `SELECT *
       FROM runtime_tool_requests
       WHERE run_id = $1 AND idempotency_key = $2`,
      [input.runId, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.detailFromRow(row);
  }

  async listByRun(runId: string): Promise<RuntimeToolRequestDetail[]> {
    const requests = await this.database.query<RuntimeToolRequestRow>(
      `SELECT *
       FROM runtime_tool_requests
       WHERE run_id = $1
       ORDER BY started_at, request_id`,
      [runId],
    );
    if (requests.rows.length === 0) return [];
    const receipts = await this.database.query<RuntimeToolRequestReceiptRow>(
      `SELECT receipt.*
       FROM runtime_tool_request_receipts AS receipt
       JOIN runtime_tool_requests AS request
         ON request.request_id = receipt.request_id
       WHERE request.run_id = $1
       ORDER BY receipt.request_id, receipt.seq`,
      [runId],
    );
    return requests.rows.map((row) => ({
      request: runtimeToolRequestFromRow(row),
      receipts: receipts.rows
        .filter((receipt) => receipt.request_id === row.request_id)
        .map(runtimeToolRequestReceiptFromRow),
    }));
  }

  async countByRun(runId: string): Promise<number> {
    const result = await this.database.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM runtime_tool_requests
       WHERE run_id = $1`,
      [runId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async summary(): Promise<RuntimeToolRequestSummary> {
    const [counts, categories] = await Promise.all([
      this.database.query<{
        readonly total: string;
        readonly running: string;
        readonly stale_running: string;
        readonly succeeded: string;
        readonly failed: string;
        readonly timed_out: string;
        readonly cancelled: string;
        readonly interrupted: string;
        readonly oldest_running_age_seconds: string;
      }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE request.status = 'running')::text
             AS running,
           COUNT(*) FILTER (
             WHERE request.status = 'running'
               AND (
                 request.lease_expires_at <= NOW()
                 OR run.status <> 'running'
               )
           )::text AS stale_running,
           COUNT(*) FILTER (WHERE request.status = 'succeeded')::text
             AS succeeded,
           COUNT(*) FILTER (WHERE request.status = 'failed')::text AS failed,
           COUNT(*) FILTER (WHERE request.status = 'timed_out')::text
             AS timed_out,
           COUNT(*) FILTER (WHERE request.status = 'cancelled')::text
             AS cancelled,
           COUNT(*) FILTER (WHERE request.status = 'interrupted')::text
             AS interrupted,
           COALESCE(
             FLOOR(
               EXTRACT(
                 EPOCH FROM (
                   NOW() - MIN(request.started_at)
                     FILTER (WHERE request.status = 'running')
                 )
               )
             )::bigint,
             0
           )::text AS oldest_running_age_seconds
         FROM runtime_tool_requests AS request
         JOIN runs AS run ON run.id = request.run_id`,
      ),
      this.database.query<{
        readonly category: McpToolCallErrorCategory;
        readonly count: string;
      }>(
        `SELECT error_category AS category, COUNT(*)::text AS count
         FROM runtime_tool_requests
         WHERE error_category IS NOT NULL
         GROUP BY error_category
         ORDER BY error_category`,
      ),
    ]);
    const row = counts.rows[0];
    const total = Number(row?.total ?? "0");
    const failed = Number(row?.failed ?? "0");
    const timedOut = Number(row?.timed_out ?? "0");
    const interrupted = Number(row?.interrupted ?? "0");
    const oldestRunningAgeSeconds = Number(
      row?.oldest_running_age_seconds ?? "0",
    );
    const alertReasons: RuntimeToolRequestSummary["alertReasons"] = [];
    let alertLevel: RuntimeToolRequestSummary["alertLevel"] = "ok";
    const raise = (
      level: "warning" | "critical",
      reason: RuntimeToolRequestSummary["alertReasons"][number],
    ) => {
      alertReasons.push(reason);
      if (level === "critical") alertLevel = "critical";
      else if (alertLevel === "ok") alertLevel = "warning";
    };
    if (Number(row?.stale_running ?? "0") > 0) {
      raise("critical", "stale_running");
    }
    if (oldestRunningAgeSeconds >= 900) {
      raise("critical", "oldest_running_critical");
    } else if (oldestRunningAgeSeconds >= 300) {
      raise("warning", "oldest_running_warning");
    }
    const errorCount = failed + timedOut + interrupted;
    if (total >= 10) {
      const errorRatio = errorCount / total;
      if (errorRatio >= 0.5) {
        raise("critical", "error_ratio_critical");
      } else if (errorRatio >= 0.25) {
        raise("warning", "error_ratio_warning");
      }
    }
    return {
      total,
      running: Number(row?.running ?? "0"),
      staleRunning: Number(row?.stale_running ?? "0"),
      succeeded: Number(row?.succeeded ?? "0"),
      failed,
      timedOut,
      cancelled: Number(row?.cancelled ?? "0"),
      interrupted,
      oldestRunningAgeSeconds,
      alertLevel,
      alertReasons,
      errorCategories: categories.rows.map((category) => ({
        category: category.category,
        count: Number(category.count),
      })),
    };
  }

  async retentionPreview(input: {
    readonly retentionDays: number;
  }): Promise<RuntimeToolRequestRetentionResult> {
    const cutoffDays = Math.max(7, input.retentionDays);
    const result = await this.database.query<{
      readonly eligible_requests: string;
      readonly eligible_receipts: string;
      readonly oldest_completed_at: Date | null;
    }>(
      `SELECT
         COUNT(DISTINCT request.request_id) FILTER (
           WHERE request.status <> 'running'
             AND request.completed_at
               < NOW() - ($1::text || ' days')::interval
         )::text AS eligible_requests,
         COUNT(receipt.id) FILTER (
           WHERE request.status <> 'running'
             AND request.completed_at
               < NOW() - ($1::text || ' days')::interval
         )::text AS eligible_receipts,
         MIN(request.completed_at) FILTER (
           WHERE request.status <> 'running'
             AND request.completed_at
               < NOW() - ($1::text || ' days')::interval
         ) AS oldest_completed_at
       FROM runtime_tool_requests AS request
       LEFT JOIN runtime_tool_request_receipts AS receipt
         ON receipt.request_id = request.request_id`,
      [cutoffDays],
    );
    const row = result.rows[0];
    return {
      retentionDays: cutoffDays,
      eligibleRequests: Number(row?.eligible_requests ?? "0"),
      eligibleReceipts: Number(row?.eligible_receipts ?? "0"),
      oldestEligibleCompletedAt:
        row?.oldest_completed_at?.toISOString() ?? null,
      dryRun: true,
      action: "archive-before-delete",
    };
  }

  private async detailFromRow(
    row: RuntimeToolRequestRow,
  ): Promise<RuntimeToolRequestDetail> {
    const receipts = await this.database.query<RuntimeToolRequestReceiptRow>(
      `SELECT *
       FROM runtime_tool_request_receipts
       WHERE request_id = $1
       ORDER BY seq`,
      [row.request_id],
    );
    return {
      request: runtimeToolRequestFromRow(row),
      receipts: receipts.rows.map(runtimeToolRequestReceiptFromRow),
    };
  }

  private async detailFromRowWithClient(
    client: PoolClient,
    row: RuntimeToolRequestRow,
  ): Promise<RuntimeToolRequestDetail> {
    const receipts = await client.query<RuntimeToolRequestReceiptRow>(
      `SELECT *
       FROM runtime_tool_request_receipts
       WHERE request_id = $1
       ORDER BY seq`,
      [row.request_id],
    );
    return {
      request: runtimeToolRequestFromRow(row),
      receipts: receipts.rows.map(runtimeToolRequestReceiptFromRow),
    };
  }

  private async leaseMatches(
    client: PoolClient,
    input: CompleteRuntimeToolRequestInput,
  ): Promise<boolean> {
    const lease = await client.query<{
      readonly lease_owner: string | null;
      readonly lease_token: string | null;
    }>(
      `SELECT lease_owner, lease_token
       FROM runtime_tool_requests
       WHERE request_id = $1`,
      [input.requestId],
    );
    return (
      lease.rows[0]?.lease_owner !== input.leaseOwner ||
      lease.rows[0]?.lease_token !== input.leaseToken
    );
  }
}

export async function closeRuntimeToolRequestsForRunWithClient(
  client: PoolClient,
  input: {
    readonly runId: string;
    readonly status: RuntimeToolRequestTerminalStatus;
    readonly errorCategory: McpToolCallErrorCategory;
    readonly errorCode: string;
    readonly errorMessage: string;
  },
): Promise<number> {
  const result = await client.query(
    `UPDATE runtime_tool_requests
     SET status = $2,
         error_category = $3,
         error_code = $4,
         error_message = $5,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = GREATEST(NOW(), started_at),
         updated_at = GREATEST(NOW(), created_at, started_at)
     WHERE run_id = $1
       AND status = 'running'`,
    [
      input.runId,
      input.status,
      input.errorCategory,
      input.errorCode.slice(0, 160),
      input.errorMessage.slice(0, 2_000),
    ],
  );
  return result.rowCount ?? 0;
}

function terminalForRunState(input: {
  readonly runStatus: string;
  readonly leaseExpired: boolean;
}): {
  readonly status: RuntimeToolRequestTerminalStatus;
  readonly errorCategory: McpToolCallErrorCategory;
  readonly errorCode: string;
  readonly errorMessage: string;
} {
  if (input.runStatus === "cancelled") {
    return {
      status: "cancelled",
      errorCategory: "cancelled",
      errorCode: "runtime_tool_run_cancelled",
      errorMessage: "The Runtime Tool Request was cancelled with its Run",
    };
  }
  if (input.runStatus === "timeout") {
    return {
      status: "timed_out",
      errorCategory: "timeout",
      errorCode: "runtime_tool_run_timed_out",
      errorMessage: "The Runtime Tool Request timed out with its Run",
    };
  }
  if (input.runStatus !== "running") {
    return {
      status: "interrupted",
      errorCategory: "unknown",
      errorCode: "runtime_tool_run_terminated",
      errorMessage: "The Runtime Tool Request stopped with its Run",
    };
  }
  return {
    status: "interrupted",
    errorCategory: "unknown",
    errorCode: "runtime_tool_lease_expired",
    errorMessage: "The Runtime Tool Request Worker lease expired",
  };
}

function runtimeToolRequestFromRow(
  row: RuntimeToolRequestRow,
): RuntimeToolRequestRecord {
  return {
    requestId: row.request_id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    taskId: row.task_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    toolKey: row.tool_key,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
    callId: row.call_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    status: row.status,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    outputDigest: row.output_digest,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function runtimeToolRequestReceiptFromRow(
  row: RuntimeToolRequestReceiptRow,
): RuntimeToolRequestReceipt {
  return {
    id: row.id,
    requestId: row.request_id,
    seq: Number(row.seq),
    status: row.status,
    requestDigest: row.request_digest,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    outputDigest: row.output_digest,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  };
}
