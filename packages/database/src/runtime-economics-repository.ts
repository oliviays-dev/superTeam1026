import { createHash, randomUUID } from "node:crypto";
import type {
  NormalizedRuntimeUsage,
  RawRuntimeUsage,
  RuntimeContextType,
  RuntimeUsageReceipt,
  RuntimeUsageSource,
} from "@pluginmax/contracts";
import {
  normalizeRuntimeUsage,
  runtimeContextTypeSchema,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface UsageReceiptRow {
  id: string;
  run_id: string;
  run_attempt: number;
  job_id: string | null;
  job_attempt: number | null;
  workspace_id: string;
  project_id: string | null;
  context_type: RuntimeContextType;
  context_id: string;
  runtime_id: string;
  runtime_revision: number | null;
  provider: string | null;
  model: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  total_tokens: string | number | null;
  cached_input_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  cost_amount: string | number | null;
  cost_currency: string | null;
  usage_source: RuntimeUsageSource;
  unknown_fields: string[];
  duration_ms: number | null;
  payload_digest: string;
  recorded_at: Date;
}

interface RunEconomicsRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  meeting_turn_id: string | null;
  direct_chat_turn_id: string | null;
  agent_id: string;
  agent_runtime_kind: string;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout"
    | "interrupted";
  execution_context_type: RuntimeContextType | null;
  execution_context_id: string | null;
  execution_snapshot: Record<string, unknown> | null;
  execution_envelope_snapshot: Record<string, unknown> | null;
  external_runtime_id: string | null;
  external_runtime_revision: number | null;
  external_runtime_provider: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

interface JobAttemptSourceRow {
  id: string;
  job_id: string;
  attempt: number;
  worker_id: string;
  status: "running" | "completed" | "failed" | "dead_letter" | "interrupted";
  started_at: Date;
  ended_at: Date | null;
}

interface RunEventSourceRow {
  id: string;
  type: string;
  created_at: Date;
}

interface TaskEventSourceRow {
  id: string;
  kind: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

interface GateSourceRow {
  gate_id: string;
  status: string;
  requested_at: Date;
  decided_at: Date | null;
}

interface EffectSourceRow {
  id: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
}

interface OutboxSourceRow {
  id: string;
  topic: string;
  status: string;
  created_at: Date;
}

export interface RuntimeRunSource {
  readonly run: {
    readonly id: string;
    readonly workspaceId: string;
    readonly projectId: string | null;
    readonly taskId: string | null;
    readonly meetingTurnId: string | null;
    readonly directChatTurnId: string | null;
    readonly agentId: string;
    readonly agentRuntimeKind: string;
    readonly status: RunEconomicsRow["status"];
    readonly contextType: RuntimeContextType;
    readonly contextId: string;
    readonly runtimeId: string | null;
    readonly runtimeRevision: number | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
  };
  readonly jobAttempts: readonly JobAttemptSourceRow[];
  readonly runEvents: readonly RunEventSourceRow[];
  readonly taskEvents: readonly TaskEventSourceRow[];
  readonly gates: readonly GateSourceRow[];
  readonly runtimeEffects: readonly EffectSourceRow[];
  readonly outbox: readonly OutboxSourceRow[];
  readonly receipts: readonly RuntimeUsageReceipt[];
}

export interface RecordRuntimeUsageInput {
  readonly runId: string;
  readonly runAttempt: number;
  readonly jobId?: string | undefined;
  readonly jobAttempt?: number | undefined;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly contextType: RuntimeContextType;
  readonly contextId: string;
  readonly runtimeId: string;
  readonly runtimeRevision?: number | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly usage?: RawRuntimeUsage | undefined;
  readonly durationMs?: number | undefined;
  readonly recordedAt?: Date | undefined;
}

export type RecordRuntimeUsageResult =
  | {
      readonly kind: "recorded" | "replayed";
      readonly receipt: RuntimeUsageReceipt;
    }
  | { readonly kind: "conflict"; readonly receipt: RuntimeUsageReceipt };

export interface ExecutionHistoryBoundary {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ExecutionHistoryFilter {
  readonly workspaceId: string;
  readonly teammateId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly runtimeId?: string | undefined;
  readonly contextType?: RuntimeContextType | undefined;
  readonly status?: RunEconomicsRow["status"] | undefined;
  readonly boundary?: ExecutionHistoryBoundary | undefined;
  readonly limit: number;
}

export interface ExecutionHistoryRow {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly contextType: RuntimeContextType;
  readonly contextId: string;
  readonly status: RunEconomicsRow["status"];
  readonly runtimeId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface ExecutionHistoryResult {
  readonly items: readonly ExecutionHistoryRow[];
  readonly hasMore: boolean;
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function receiptFromRow(row: UsageReceiptRow): RuntimeUsageReceipt {
  return {
    id: row.id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    jobId: row.job_id,
    jobAttempt: row.job_attempt,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    contextType: row.context_type,
    contextId: row.context_id,
    runtimeId: row.runtime_id,
    runtimeRevision: row.runtime_revision,
    provider: row.provider,
    model: row.model,
    inputTokens: numberOrNull(row.input_tokens),
    outputTokens: numberOrNull(row.output_tokens),
    totalTokens: numberOrNull(row.total_tokens),
    cachedInputTokens: numberOrNull(row.cached_input_tokens),
    reasoningTokens: numberOrNull(row.reasoning_tokens),
    costAmount: numberOrNull(row.cost_amount),
    costCurrency: row.cost_currency,
    source: row.usage_source,
    unknownFields: row.unknown_fields,
    durationMs: row.duration_ms,
    payloadDigest: row.payload_digest,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function normalizedPayload(input: {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly contextType: RuntimeContextType;
  readonly contextId: string;
  readonly runtimeId: string;
  readonly runtimeRevision: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly usage: NormalizedRuntimeUsage;
  readonly durationMs: number | null;
}): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    contextType: input.contextType,
    contextId: input.contextId,
    runtimeId: input.runtimeId,
    runtimeRevision: input.runtimeRevision,
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    durationMs: input.durationMs,
  });
}

function payloadDigest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function workspaceExpression(): string {
  return `COALESCE(
    run.execution_envelope_snapshot ->> 'workspaceId',
    run.project_id::text,
    'unknown'
  )`;
}

function contextTypeExpression(): string {
  return `COALESCE(
    run.execution_context_type,
    CASE
      WHEN run.direct_chat_turn_id IS NOT NULL THEN 'direct-chat'
      WHEN run.meeting_turn_id IS NOT NULL THEN 'meeting'
      WHEN run.workflow_instance_id IS NOT NULL THEN 'workflow-task'
      ELSE 'task'
    END
  )`;
}

function contextIdExpression(): string {
  return `COALESCE(
    run.execution_context_id,
    run.task_id::text,
    run.meeting_turn_id::text,
    run.direct_chat_turn_id::text,
    run.id::text
  )`;
}

function providerExpression(): string {
  return `COALESCE(
    run.external_runtime_provider,
    run.execution_envelope_snapshot #>> '{envelope,launch,provider}',
    run.execution_snapshot #>> '{runtime,provider}',
    NULLIF(agents.runtime_kind, '')
  )`;
}

function modelExpression(): string {
  return `COALESCE(
    NULLIF(run.execution_snapshot ->> 'model', 'unknown'),
    NULLIF(
      run.execution_envelope_snapshot #>> '{envelope,launch,model}',
      'unknown'
    )
  )`;
}

export class RuntimeEconomicsRepository {
  constructor(private readonly database: Database) {}

  async recordUsage(
    input: RecordRuntimeUsageInput,
  ): Promise<RecordRuntimeUsageResult> {
    const usage = normalizeRuntimeUsage(input.usage);
    const runtimeRevision = input.runtimeRevision ?? null;
    const provider = input.provider?.trim() || null;
    const model = input.model?.trim() || null;
    const durationMs =
      input.durationMs === undefined
        ? null
        : Math.max(0, Math.trunc(input.durationMs));
    const digest = payloadDigest(
      normalizedPayload({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        contextType: input.contextType,
        contextId: input.contextId,
        runtimeId: input.runtimeId,
        runtimeRevision,
        provider,
        model,
        usage,
        durationMs,
      }),
    );
    return this.database.transaction(async (client) => {
      const inserted = await client.query<UsageReceiptRow>(
        `INSERT INTO run_runtime_usage_receipts (
           id, run_id, run_attempt, job_id, job_attempt, workspace_id,
           project_id, context_type, context_id, runtime_id,
           runtime_revision, provider, model, input_tokens, output_tokens,
           total_tokens, cached_input_tokens, reasoning_tokens, cost_amount,
           cost_currency, usage_source, unknown_fields, duration_ms,
           payload_digest, recorded_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22::text[], $23,
           $24, $25
         )
         ON CONFLICT (run_id, run_attempt) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          input.runId,
          input.runAttempt,
          input.jobId ?? null,
          input.jobAttempt ?? null,
          input.workspaceId,
          input.projectId,
          input.contextType,
          input.contextId,
          input.runtimeId,
          runtimeRevision,
          provider,
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          usage.cachedInputTokens,
          usage.reasoningTokens,
          usage.costAmount,
          usage.costCurrency,
          usage.source,
          usage.unknownFields,
          durationMs,
          digest,
          input.recordedAt ?? new Date(),
        ],
      );
      const existing =
        inserted.rows[0] ??
        (
          await client.query<UsageReceiptRow>(
            `SELECT *
             FROM run_runtime_usage_receipts
             WHERE run_id = $1 AND run_attempt = $2`,
            [input.runId, input.runAttempt],
          )
        ).rows[0];
      if (existing === undefined) {
        throw new Error("runtime usage receipt could not be persisted");
      }
      const receipt = receiptFromRow(existing);
      if (inserted.rows[0] === undefined) {
        return {
          kind:
            existing.payload_digest === digest
              ? ("replayed" as const)
              : ("conflict" as const),
          receipt,
        };
      }
      await client.query(
        `INSERT INTO run_events (
           id, run_id, seq, type, visibility, summary, data,
           trace_id, span_id, parent_span_id, created_at
         )
         SELECT
           $1, run.id, COALESCE(MAX(event.seq), 0) + 1,
           'runtime.usage_recorded', 'public', $2, $3::jsonb,
           run.trace_id, $4, run.trace_root_span_id, NOW()
         FROM runs AS run
         LEFT JOIN run_events AS event ON event.run_id = run.id
         WHERE run.id = $5
         GROUP BY run.id, run.trace_id, run.trace_root_span_id`,
        [
          randomUUID(),
          "Runtime usage receipt 已归一化并记录",
          JSON.stringify({
            usageReceiptId: receipt.id,
            runAttempt: receipt.runAttempt,
            source: receipt.source,
            unknownFields: receipt.unknownFields,
          }),
          randomUUID().replaceAll("-", "").slice(0, 16),
          input.runId,
        ],
      );
      await client.query(
        `INSERT INTO domain_outbox (
           id, topic, payload, status, created_at
         ) VALUES (
           $1, 'runtime.usage.recorded', $2::jsonb, 'pending', NOW()
         )
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          JSON.stringify({
            runId: input.runId,
            runAttempt: input.runAttempt,
            usageReceiptId: receipt.id,
            workspaceId: input.workspaceId,
            digest,
          }),
        ],
      );
      return { kind: "recorded", receipt };
    });
  }

  async listUsage(runId: string): Promise<RuntimeUsageReceipt[]> {
    const result = await this.database.query<UsageReceiptRow>(
      `SELECT *
       FROM run_runtime_usage_receipts
       WHERE run_id = $1
       ORDER BY run_attempt`,
      [runId],
    );
    return result.rows.map(receiptFromRow);
  }

  async listUsageForRuns(
    runIds: readonly string[],
  ): Promise<Map<string, RuntimeUsageReceipt[]>> {
    const grouped = new Map<string, RuntimeUsageReceipt[]>();
    if (runIds.length === 0) return grouped;
    const result = await this.database.query<UsageReceiptRow>(
      `SELECT *
       FROM run_runtime_usage_receipts
       WHERE run_id = ANY($1::uuid[])
       ORDER BY run_id, run_attempt`,
      [runIds],
    );
    for (const row of result.rows) {
      const receipt = receiptFromRow(row);
      const current = grouped.get(receipt.runId) ?? [];
      current.push(receipt);
      grouped.set(receipt.runId, current);
    }
    return grouped;
  }

  async getRunSources(runId: string): Promise<RuntimeRunSource | undefined> {
    const runResult = await this.database.query<
      RunEconomicsRow & {
        workspace_id: string;
        context_type: string;
        context_id: string;
        provider: string | null;
        model: string | null;
      }
    >(
      `SELECT
         run.*,
         agents.runtime_kind AS agent_runtime_kind,
         ${workspaceExpression()} AS workspace_id,
         ${contextTypeExpression()} AS context_type,
         ${contextIdExpression()} AS context_id,
         ${providerExpression()} AS provider,
         ${modelExpression()} AS model
       FROM runs AS run
       JOIN agents ON agents.id = run.agent_id
       WHERE run.id = $1`,
      [runId],
    );
    const row = runResult.rows[0];
    if (row === undefined) return undefined;
    const contextType = runtimeContextTypeSchema.parse(row.context_type);
    const [attempts, runEvents, taskEvents, gates, effects, outbox, receipts] =
      await Promise.all([
        this.database.query<JobAttemptSourceRow>(
          `SELECT attempt.*
         FROM job_attempts AS attempt
         JOIN jobs AS job ON job.id = attempt.job_id
         WHERE job.run_id = $1
         ORDER BY attempt.attempt, attempt.started_at`,
          [runId],
        ),
        this.database.query<RunEventSourceRow>(
          `SELECT id, type, created_at
         FROM run_events
         WHERE run_id = $1
         ORDER BY seq`,
          [runId],
        ),
        row.task_id === null
          ? Promise.resolve({ rows: [] as TaskEventSourceRow[] })
          : this.database.query<TaskEventSourceRow>(
              `SELECT id, kind, data, created_at
             FROM task_events
             WHERE task_id = $1
             ORDER BY created_at, id`,
              [row.task_id],
            ),
        this.database.query<GateSourceRow>(
          `SELECT
           gate.gate_id,
           CASE
             WHEN decision.decision IS NULL THEN 'pending'
             WHEN decision.decision = 'approve' THEN 'approved'
             ELSE decision.decision
           END AS status,
           gate.requested_at,
           decision.decided_at
         FROM execution_gate_requests AS gate
         LEFT JOIN execution_gate_decisions AS decision
           ON decision.gate_id = gate.gate_id
         WHERE gate.run_id = $1
         ORDER BY gate.requested_at, gate.gate_id`,
          [runId],
        ),
        this.database.query<EffectSourceRow>(
          `SELECT id, status, started_at, completed_at
         FROM runtime_effect_receipts
         WHERE run_id = $1
         ORDER BY started_at, id`,
          [runId],
        ),
        this.database.query<OutboxSourceRow>(
          `SELECT id, topic, status, created_at
         FROM domain_outbox
         WHERE payload ->> 'runId' = $1
         ORDER BY created_at, id`,
          [runId],
        ),
        this.listUsage(runId),
      ]);
    return {
      run: {
        id: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        taskId: row.task_id,
        meetingTurnId: row.meeting_turn_id,
        directChatTurnId: row.direct_chat_turn_id,
        agentId: row.agent_id,
        agentRuntimeKind: row.agent_runtime_kind,
        status: row.status,
        contextType,
        contextId: row.context_id,
        runtimeId:
          row.external_runtime_id ??
          (typeof row.execution_envelope_snapshot?.runtime === "object" &&
          row.execution_envelope_snapshot.runtime !== null
            ? String(
                (
                  row.execution_envelope_snapshot.runtime as Record<
                    string,
                    unknown
                  >
                ).id ?? "",
              ) || null
            : null) ??
          `builtin:${row.agent_runtime_kind}`,
        runtimeRevision:
          row.external_runtime_revision ??
          (typeof row.execution_envelope_snapshot?.runtime === "object" &&
          row.execution_envelope_snapshot.runtime !== null
            ? Number(
                (
                  row.execution_envelope_snapshot.runtime as Record<
                    string,
                    unknown
                  >
                ).revision,
              ) || null
            : null),
        provider: row.provider,
        model: row.model,
        createdAt: row.created_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        endedAt: row.ended_at?.toISOString() ?? null,
      },
      jobAttempts: attempts.rows,
      runEvents: runEvents.rows,
      taskEvents: taskEvents.rows,
      gates: gates.rows,
      runtimeEffects: effects.rows,
      outbox: outbox.rows,
      receipts,
    };
  }

  async listExecutionHistory(
    input: ExecutionHistoryFilter,
  ): Promise<ExecutionHistoryResult> {
    const result = await this.database.query<
      RunEconomicsRow & {
        workspace_id: string;
        context_type: string;
        context_id: string;
        provider: string | null;
        model: string | null;
      }
    >(
      `SELECT
         run.*,
         agents.runtime_kind AS agent_runtime_kind,
         ${workspaceExpression()} AS workspace_id,
         ${contextTypeExpression()} AS context_type,
         ${contextIdExpression()} AS context_id,
         ${providerExpression()} AS provider,
         ${modelExpression()} AS model
       FROM runs AS run
       JOIN agents ON agents.id = run.agent_id
       WHERE (
         run.project_id::text = $1::text
         OR run.execution_envelope_snapshot ->> 'workspaceId' = $1::text
       )
         AND ($2::timestamptz IS NULL OR run.created_at >= $2)
         AND ($3::timestamptz IS NULL OR run.created_at <= $3)
         AND (
           $4::text IS NULL
           OR run.external_runtime_id::text = $4
           OR run.execution_envelope_snapshot #>> '{runtime,id}' = $4
         )
         AND ($5::text IS NULL OR ${contextTypeExpression()} = $5)
         AND ($6::text IS NULL OR run.status = $6)
         AND (
           $7::uuid IS NULL
           OR EXISTS (
             SELECT 1
             FROM teammate_run_attributions AS attribution
             WHERE attribution.run_id = run.id
               AND attribution.teammate_id = $7
           )
         )
         AND (
           $8::timestamptz IS NULL
           OR (run.created_at, run.id) < ($8::timestamptz, $9::uuid)
         )
       ORDER BY run.created_at DESC, run.id DESC
       LIMIT $10`,
      [
        input.workspaceId,
        input.from ?? null,
        input.to ?? null,
        input.runtimeId ?? null,
        input.contextType ?? null,
        input.status ?? null,
        input.teammateId ?? null,
        input.boundary?.createdAt ?? null,
        input.boundary?.id ?? null,
        input.limit + 1,
      ],
    );
    const hasMore = result.rows.length > input.limit;
    return {
      items: result.rows.slice(0, input.limit).map((row) => ({
        runId: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        taskId: row.task_id,
        contextType: runtimeContextTypeSchema.parse(row.context_type),
        contextId: row.context_id,
        status: row.status,
        runtimeId:
          row.external_runtime_id ??
          (typeof row.execution_envelope_snapshot?.runtime === "object" &&
          row.execution_envelope_snapshot.runtime !== null
            ? String(
                (
                  row.execution_envelope_snapshot.runtime as Record<
                    string,
                    unknown
                  >
                ).id ?? "",
              ) || null
            : null) ??
          `builtin:${row.agent_runtime_kind}`,
        provider: row.provider,
        model: row.model,
        createdAt: row.created_at.toISOString(),
        endedAt: row.ended_at?.toISOString() ?? null,
      })),
      hasMore,
    };
  }
}
