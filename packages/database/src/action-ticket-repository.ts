import { randomUUID } from "node:crypto";
import {
  actionTicketSchema,
  executionGateDecisionSchema,
  executionGateRequestSchema,
  type ActionTicket,
  type ActionTicketAction,
  type ActionTicketBundle,
  type ActionTicketUsage,
  type ExecutionGateDecision,
  type ExecutionGateDecisionType,
  type ExecutionGateRecord,
  type ExecutionGateRequest,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface ActionTicketRow {
  id: string;
  schema_version: number;
  ticket_version: number;
  principal_id: string;
  workspace_id: string;
  context_type: ActionTicket["contextType"];
  context_id: string;
  task_id: string;
  run_id: string;
  allowed_actions: ActionTicketAction[];
  denied_actions: ActionTicketAction[];
  resource_scopes: string[];
  policy_id: string | null;
  policy_revision: number;
  envelope_id: string;
  envelope_digest: string;
  authorization_snapshot: ActionTicket["authorizationSnapshot"];
  execution_envelope: ActionTicket["executionEnvelope"];
  issued_at: Date;
  expires_at: Date;
  issued_by: string;
}

interface ExecutionGateRow {
  gate_id: string;
  ticket_id: string;
  run_id: string;
  task_id: string;
  project_id: string | null;
  gate_key: string;
  kind: ExecutionGateRequest["kind"];
  enforcement: ExecutionGateRequest["enforcement"];
  reason: string;
  requested_tool_category: string | null;
  requested_source_class: string | null;
  resource_scopes: string[];
  policy_id: string | null;
  policy_revision: number;
  envelope_id: string;
  envelope_digest: string;
  requested_by_principal_id: string;
  requested_at: Date;
  expires_at: Date;
  decision_id: string | null;
  decision: ExecutionGateDecisionType | null;
  decided_by_principal_id: string | null;
  basis: string | null;
  decided_at: Date | null;
  decision_policy_revision: number | null;
  decision_envelope_id: string | null;
  decision_envelope_digest: string | null;
}

interface ActionTicketUsageRow {
  ticket_id: string;
  action: ActionTicketAction;
  idempotency_key: string;
  run_id: string;
  status: ActionTicketUsage["status"];
  result: Record<string, unknown> | null;
  started_at: Date;
  completed_at: Date | null;
}

export type GateDecisionResult =
  | {
      readonly kind: "recorded";
      readonly gate: ExecutionGateRecord;
      readonly runStatus: "waiting_approval" | "queued" | "cancelled" | "timeout";
    }
  | { readonly kind: "already_decided"; readonly gate: ExecutionGateRecord }
  | { readonly kind: "expired"; readonly gate: ExecutionGateRecord }
  | { readonly kind: "not_found" };

export type BeginTicketUsageResult =
  | { readonly kind: "claimed"; readonly usage: ActionTicketUsage }
  | { readonly kind: "replay"; readonly usage: ActionTicketUsage }
  | { readonly kind: "in_progress"; readonly usage: ActionTicketUsage }
  | { readonly kind: "ticket_missing" }
  | { readonly kind: "action_denied"; readonly reason: string };

export interface ExpiredExecutionGate {
  readonly gateId: string;
  readonly runId: string;
  readonly ticketId: string;
}

const GATE_SELECT = `
  SELECT
    request.*,
    decision.decision_id,
    decision.decision,
    decision.decided_by_principal_id,
    decision.basis,
    decision.decided_at,
    decision.policy_revision AS decision_policy_revision,
    decision.envelope_id AS decision_envelope_id,
    decision.envelope_digest AS decision_envelope_digest
  FROM execution_gate_requests AS request
  LEFT JOIN execution_gate_decisions AS decision
    ON decision.gate_id = request.gate_id
`;

function ticketFromRow(row: ActionTicketRow): ActionTicket {
  return actionTicketSchema.parse({
    schemaVersion: row.schema_version,
    ticketId: row.id,
    ticketVersion: row.ticket_version,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    contextType: row.context_type,
    contextId: row.context_id,
    taskId: row.task_id,
    runId: row.run_id,
    allowedActions: row.allowed_actions,
    deniedActions: row.denied_actions,
    resourceScopes: row.resource_scopes,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
    authorizationSnapshot: row.authorization_snapshot,
    executionEnvelope: row.execution_envelope,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    issuedBy: row.issued_by,
  });
}

function usageFromRow(row: ActionTicketUsageRow): ActionTicketUsage {
  return {
    ticketId: row.ticket_id,
    action: row.action,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    result: row.result,
  };
}

function gateStatus(
  row: ExecutionGateRow,
  now = new Date(),
): ExecutionGateRecord["status"] {
  if (row.decision === "approve") return "approved";
  if (row.decision === "reject") return "denied";
  if (row.decision === "timeout") return "expired";
  if (row.decision === "cancel") return "cancelled";
  return row.expires_at.getTime() <= now.getTime() ? "expired" : "pending";
}

function gateFromRow(
  row: ExecutionGateRow,
  now = new Date(),
): ExecutionGateRecord {
  const request = executionGateRequestSchema.parse({
    gateId: row.gate_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    taskId: row.task_id,
    projectId: row.project_id,
    gateKey: row.gate_key,
    kind: row.kind,
    enforcement: row.enforcement,
    reason: row.reason,
    requestedToolCategory: row.requested_tool_category,
    requestedSourceClass: row.requested_source_class,
    resourceScopes: row.resource_scopes,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
    requestedByPrincipalId: row.requested_by_principal_id,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
  const decision =
    row.decision_id === null ||
    row.decision === null ||
    row.decided_by_principal_id === null ||
    row.basis === null ||
    row.decided_at === null ||
    row.decision_policy_revision === null ||
    row.decision_envelope_id === null ||
    row.decision_envelope_digest === null
      ? null
      : executionGateDecisionSchema.parse({
          decisionId: row.decision_id,
          gateId: row.gate_id,
          decision: row.decision,
          decidedByPrincipalId: row.decided_by_principal_id,
          basis: row.basis,
          decidedAt: row.decided_at.toISOString(),
          policyRevision: row.decision_policy_revision,
          envelopeId: row.decision_envelope_id,
          envelopeDigest: row.decision_envelope_digest,
        });
  return {
    ...request,
    status: gateStatus(row, now),
    decision,
  };
}

function arrayValue(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",")}}`;
}

async function appendRunEventWithClient(
  client: PoolClient,
  runId: string,
  type:
    | "ticket.issued"
    | "gate.requested"
    | "gate.decided"
    | "gate.expired"
    | "run.recovered"
    | "run.cancelled",
  summary: string,
  data: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO run_events (
       id, run_id, seq, type, visibility, summary, data,
       trace_id, span_id, parent_span_id, created_at
     )
     SELECT
       $1, $2, COALESCE(MAX(event.seq), 0) + 1, $3, 'public', $4,
       $5::jsonb, run.trace_id, $6, run.trace_root_span_id, NOW()
     FROM runs AS run
     LEFT JOIN run_events AS event ON event.run_id = run.id
     WHERE run.id = $2
     GROUP BY run.id, run.trace_id, run.trace_root_span_id`,
    [
      randomUUID(),
      runId,
      type,
      summary,
      JSON.stringify(data),
      randomUUID().replaceAll("-", "").slice(0, 16),
    ],
  );
}

export class ActionTicketRepository {
  constructor(
    private readonly database: Database,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async issueWithClient(
    client: PoolClient,
    ticket: ActionTicket,
  ): Promise<void> {
    const parsed = actionTicketSchema.parse(ticket);
    await client.query(
      `INSERT INTO action_tickets (
         id, schema_version, ticket_version, principal_id, workspace_id,
         context_type, context_id, task_id, run_id, allowed_actions,
         denied_actions, resource_scopes, policy_id, policy_revision,
         envelope_id, envelope_digest, authorization_snapshot,
         execution_envelope, issued_at, expires_at, issued_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::text[], $11::text[], $12::text[], $13, $14, $15, $16,
         $17::jsonb, $18::jsonb, $19, $20, $21
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        parsed.ticketId,
        parsed.schemaVersion,
        parsed.ticketVersion,
        parsed.principalId,
        parsed.workspaceId,
        parsed.contextType,
        parsed.contextId,
        parsed.taskId,
        parsed.runId,
        arrayValue(parsed.allowedActions),
        arrayValue(parsed.deniedActions),
        arrayValue(parsed.resourceScopes),
        parsed.policyId,
        parsed.policyRevision,
        parsed.envelopeId,
        parsed.envelopeDigest,
        JSON.stringify(parsed.authorizationSnapshot),
        JSON.stringify(parsed.executionEnvelope),
        parsed.issuedAt,
        parsed.expiresAt,
        parsed.issuedBy,
      ],
    );
    await appendRunEventWithClient(
      client,
      parsed.runId,
      "ticket.issued",
      "Action Ticket 已签发并绑定本次 Run 快照",
      {
        ticketId: parsed.ticketId,
        ticketVersion: parsed.ticketVersion,
        policyRevision: parsed.policyRevision,
        envelopeId: parsed.envelopeId,
        expiresAt: parsed.expiresAt,
      },
    );
  }

  async issueGatesWithClient(
    client: PoolClient,
    gates: readonly ExecutionGateRequest[],
  ): Promise<void> {
    for (const input of gates) {
      const gate = executionGateRequestSchema.parse(input);
      await client.query(
        `INSERT INTO execution_gate_requests (
           gate_id, ticket_id, run_id, task_id, project_id, gate_key,
           kind, enforcement, reason, requested_tool_category,
           requested_source_class, resource_scopes, policy_id,
           policy_revision, envelope_id, envelope_digest,
           requested_by_principal_id, requested_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12::text[], $13, $14, $15, $16, $17, $18, $19
         )
         ON CONFLICT (ticket_id, gate_key) DO NOTHING`,
        [
          gate.gateId,
          gate.ticketId,
          gate.runId,
          gate.taskId,
          gate.projectId,
          gate.gateKey,
          gate.kind,
          gate.enforcement,
          gate.reason,
          gate.requestedToolCategory,
          gate.requestedSourceClass,
          arrayValue(gate.resourceScopes),
          gate.policyId,
          gate.policyRevision,
          gate.envelopeId,
          gate.envelopeDigest,
          gate.requestedByPrincipalId,
          gate.requestedAt,
          gate.expiresAt,
        ],
      );
      await appendRunEventWithClient(
        client,
        gate.runId,
        "gate.requested",
        gate.enforcement === "blocking"
          ? "Execution Gate 正在等待决策"
          : "非阻塞 Execution Gate 已记录",
        {
          gateId: gate.gateId,
          ticketId: gate.ticketId,
          kind: gate.kind,
          enforcement: gate.enforcement,
          reason: gate.reason,
          expiresAt: gate.expiresAt,
        },
      );
    }
  }

  async getByRun(runId: string): Promise<ActionTicket | undefined> {
    const result = await this.database.query<ActionTicketRow>(
      "SELECT * FROM action_tickets WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : ticketFromRow(row);
  }

  async get(ticketId: string): Promise<ActionTicket | undefined> {
    const result = await this.database.query<ActionTicketRow>(
      "SELECT * FROM action_tickets WHERE id = $1",
      [ticketId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : ticketFromRow(row);
  }

  async listGatesByRun(runId: string): Promise<ExecutionGateRecord[]> {
    const result = await this.database.query<ExecutionGateRow>(
      `${GATE_SELECT}
       WHERE request.run_id = $1
       ORDER BY request.requested_at, request.gate_key`,
      [runId],
    );
    const now = this.now();
    return result.rows.map((row) => gateFromRow(row, now));
  }

  async getBundle(runId: string): Promise<ActionTicketBundle | undefined> {
    const ticket = await this.getByRun(runId);
    if (ticket === undefined) return undefined;
    return { ticket, gates: await this.listGatesByRun(runId) };
  }

  async getGate(gateId: string): Promise<ExecutionGateRecord | undefined> {
    const result = await this.database.query<ExecutionGateRow>(
      `${GATE_SELECT} WHERE request.gate_id = $1`,
      [gateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : gateFromRow(row, this.now());
  }

  async beginUsage(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly idempotencyKey: string;
    readonly allowExpired?: boolean;
  }): Promise<BeginTicketUsageResult> {
    return this.database.transaction(async (client) => {
      const ticketResult = await client.query<ActionTicketRow>(
        "SELECT * FROM action_tickets WHERE run_id = $1 FOR SHARE",
        [input.runId],
      );
      const row = ticketResult.rows[0];
      if (row === undefined) return { kind: "ticket_missing" as const };
      const ticket = ticketFromRow(row);
      if (
        !ticket.allowedActions.includes(input.action) ||
        ticket.deniedActions.includes(input.action)
      ) {
        return {
          kind: "action_denied" as const,
          reason: "action_not_allowed_by_ticket",
        };
      }
      if (
        !input.allowExpired &&
        new Date(ticket.expiresAt).getTime() <= this.now().getTime()
      ) {
        return {
          kind: "action_denied" as const,
          reason: "ticket_expired",
        };
      }
      const inserted = await client.query<ActionTicketUsageRow>(
        `INSERT INTO action_ticket_usages (
           ticket_id, action, idempotency_key, run_id, status,
           started_at
         ) VALUES ($1, $2, $3, $4, 'started', NOW())
         ON CONFLICT (ticket_id, action, idempotency_key) DO NOTHING
         RETURNING *`,
        [ticket.ticketId, input.action, input.idempotencyKey, input.runId],
      );
      if (inserted.rows[0] !== undefined) {
        return {
          kind: "claimed" as const,
          usage: usageFromRow(inserted.rows[0]),
        };
      }
      const existing = await client.query<ActionTicketUsageRow>(
        `SELECT *
         FROM action_ticket_usages
         WHERE ticket_id = $1 AND action = $2 AND idempotency_key = $3`,
        [ticket.ticketId, input.action, input.idempotencyKey],
      );
      const usage = existing.rows[0]!;
      return {
        kind: usage.status === "completed" ? "replay" : "in_progress",
        usage: usageFromRow(usage),
      };
    });
  }

  async getUsage(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly idempotencyKey: string;
  }): Promise<ActionTicketUsage | undefined> {
    const result = await this.database.query<ActionTicketUsageRow>(
      `SELECT usage.*
       FROM action_ticket_usages AS usage
       JOIN action_tickets AS ticket ON ticket.id = usage.ticket_id
       WHERE ticket.run_id = $1
         AND usage.action = $2
         AND usage.idempotency_key = $3`,
      [input.runId, input.action, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : usageFromRow(row);
  }

  async completeUsage(input: {
    readonly runId: string;
    readonly action: ActionTicketAction;
    readonly idempotencyKey: string;
    readonly result?: Record<string, unknown>;
  }): Promise<ActionTicketUsage | undefined> {
    const result = await this.database.query<ActionTicketUsageRow>(
      `UPDATE action_ticket_usages AS usage
       SET
         status = 'completed',
         completed_at = NOW(),
         result = COALESCE($4::jsonb, usage.result)
       FROM action_tickets AS ticket
       WHERE ticket.id = usage.ticket_id
         AND ticket.run_id = $1
         AND usage.action = $2
         AND usage.idempotency_key = $3
         AND usage.status = 'started'
       RETURNING usage.*`,
      [
        input.runId,
        input.action,
        input.idempotencyKey,
        input.result === undefined ? null : JSON.stringify(input.result),
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) return usageFromRow(row);
    const existing = await this.database.query<ActionTicketUsageRow>(
      `SELECT usage.*
       FROM action_ticket_usages AS usage
       JOIN action_tickets AS ticket ON ticket.id = usage.ticket_id
       WHERE ticket.run_id = $1
         AND usage.action = $2
         AND usage.idempotency_key = $3`,
      [input.runId, input.action, input.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    return existingRow === undefined ? undefined : usageFromRow(existingRow);
  }

  async decide(input: {
    readonly gateId: string;
    readonly decision: ExecutionGateDecisionType;
    readonly decidedByPrincipalId: string;
    readonly basis: string;
  }): Promise<GateDecisionResult> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<ExecutionGateRow>(
        `${GATE_SELECT}
         WHERE request.gate_id = $1
         FOR UPDATE OF request`,
        [input.gateId],
      );
      const row = locked.rows[0];
      if (row === undefined) return { kind: "not_found" as const };
      if (row.decision_id !== null) {
        return {
          kind: "already_decided" as const,
          gate: gateFromRow(row, this.now()),
        };
      }
      if (row.expires_at.getTime() <= this.now().getTime()) {
        return {
          kind: "expired" as const,
          gate: gateFromRow(row, this.now()),
        };
      }
      await this.insertDecisionWithClient(client, row, input);
      let runStatus: "waiting_approval" | "queued" | "cancelled" | "timeout" =
        "waiting_approval";
      if (input.decision === "approve") {
        const unresolved = await this.unresolvedBlockingGateCountWithClient(
          client,
          row.run_id,
        );
        if (unresolved === 0) {
          await this.resumeRunWithClient(client, row.run_id);
          runStatus = "queued";
        }
      } else {
        const terminalStatus =
          input.decision === "timeout" ? "timeout" : "cancelled";
        await this.blockRunWithClient(
          client,
          row.run_id,
          terminalStatus,
          input.decision === "timeout"
            ? "execution_gate_timeout"
            : input.decision === "cancel"
              ? "execution_gate_cancelled"
              : "execution_gate_denied",
          input.basis,
        );
        runStatus = terminalStatus;
      }
      await appendRunEventWithClient(
        client,
        row.run_id,
        "gate.decided",
        input.decision === "approve"
          ? "Execution Gate 已批准"
          : input.decision === "reject"
            ? "Execution Gate 已拒绝"
            : input.decision === "timeout"
              ? "Execution Gate 已超时"
              : "Execution Gate 已取消",
        {
          gateId: row.gate_id,
          decision: input.decision,
          decidedByPrincipalId: input.decidedByPrincipalId,
          basis: input.basis,
          policyRevision: row.policy_revision,
          envelopeId: row.envelope_id,
        },
      );
      const updated = await client.query<ExecutionGateRow>(
        `${GATE_SELECT} WHERE request.gate_id = $1`,
        [row.gate_id],
      );
      return {
        kind: "recorded" as const,
        gate: gateFromRow(updated.rows[0]!, this.now()),
        runStatus,
      };
    });
  }

  async expireDue(limit = 50): Promise<ExpiredExecutionGate[]> {
    return this.database.transaction(async (client) => {
      const due = await client.query<ExecutionGateRow>(
        `${GATE_SELECT}
         JOIN runs AS run ON run.id = request.run_id
         WHERE request.enforcement = 'blocking'
           AND decision.gate_id IS NULL
           AND request.expires_at <= NOW()
           AND run.status = 'waiting_approval'
         ORDER BY request.expires_at
         FOR UPDATE OF request SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      const expired: ExpiredExecutionGate[] = [];
      const seenRuns = new Set<string>();
      for (const row of due.rows) {
        if (seenRuns.has(row.run_id)) continue;
        seenRuns.add(row.run_id);
        const pending = await client.query<ExecutionGateRow>(
          `${GATE_SELECT}
           WHERE request.run_id = $1 AND decision.gate_id IS NULL
           FOR UPDATE OF request`,
          [row.run_id],
        );
        for (const pendingGate of pending.rows) {
          await this.insertSystemDecisionWithClient(
            client,
            pendingGate,
            "timeout",
            "gate_timeout",
            "Execution Gate expired before a human decision was recorded",
          );
          expired.push({
            gateId: pendingGate.gate_id,
            runId: pendingGate.run_id,
            ticketId: pendingGate.ticket_id,
          });
        }
        await this.blockRunWithClient(
          client,
          row.run_id,
          "timeout",
          "execution_gate_timeout",
          "Execution Gate expired before a human decision was recorded",
        );
        await appendRunEventWithClient(
          client,
          row.run_id,
          "gate.expired",
          "Execution Gate 超时，Run 已停止",
          {
            gateId: row.gate_id,
            expiredGateIds: pending.rows.map((gate) => gate.gate_id),
          },
        );
      }
      return expired;
    });
  }

  async cancelPendingForRunWithClient(
    client: PoolClient,
    input: {
      readonly runId: string;
      readonly decidedByPrincipalId: string;
      readonly basis: string;
    },
  ): Promise<number> {
    const pending = await client.query<ExecutionGateRow>(
      `${GATE_SELECT}
       WHERE request.run_id = $1 AND decision.gate_id IS NULL
       FOR UPDATE OF request`,
      [input.runId],
    );
    for (const gate of pending.rows) {
      await this.insertDecisionWithClient(client, gate, {
        decision: "cancel",
        decidedByPrincipalId: input.decidedByPrincipalId,
        basis: input.basis,
      });
    }
    return pending.rows.length;
  }

  private async insertDecisionWithClient(
    client: PoolClient,
    gate: ExecutionGateRow,
    input: {
      readonly decision: ExecutionGateDecisionType;
      readonly decidedByPrincipalId: string;
      readonly basis: string;
    },
  ): Promise<ExecutionGateDecision> {
    const decision = executionGateDecisionSchema.parse({
      decisionId: randomUUID(),
      gateId: gate.gate_id,
      decision: input.decision,
      decidedByPrincipalId: input.decidedByPrincipalId,
      basis: input.basis,
      decidedAt: this.now().toISOString(),
      policyRevision: gate.policy_revision,
      envelopeId: gate.envelope_id,
      envelopeDigest: gate.envelope_digest,
    });
    await client.query(
      `INSERT INTO execution_gate_decisions (
         decision_id, gate_id, decision, decided_by_principal_id, basis,
         decided_at, policy_revision, envelope_id, envelope_digest
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        decision.decisionId,
        decision.gateId,
        decision.decision,
        decision.decidedByPrincipalId,
        decision.basis,
        decision.decidedAt,
        decision.policyRevision,
        decision.envelopeId,
        decision.envelopeDigest,
      ],
    );
    return decision;
  }

  private async insertSystemDecisionWithClient(
    client: PoolClient,
    gate: ExecutionGateRow,
    decision: "timeout" | "cancel",
    actor: string,
    basis: string,
  ): Promise<void> {
    await this.insertDecisionWithClient(client, gate, {
      decision,
      decidedByPrincipalId: `system:${actor}`,
      basis,
    });
  }

  private async unresolvedBlockingGateCountWithClient(
    client: PoolClient,
    runId: string,
  ): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM execution_gate_requests AS request
       LEFT JOIN execution_gate_decisions AS decision
         ON decision.gate_id = request.gate_id
       WHERE request.run_id = $1
         AND request.enforcement = 'blocking'
         AND decision.gate_id IS NULL`,
      [runId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  private async resumeRunWithClient(
    client: PoolClient,
    runId: string,
  ): Promise<void> {
    const resumed = await client.query(
      `UPDATE runs
       SET status = 'queued', error = NULL, ended_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'waiting_approval'`,
      [runId],
    );
    if ((resumed.rowCount ?? 0) === 0) return;
    await client.query(
      `UPDATE jobs
       SET status = 'queued', available_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND status = 'queued'`,
      [runId],
    );
    await appendRunEventWithClient(
      client,
      runId,
      "run.recovered",
      "Execution Gate 已批准，Run 恢复排队",
      { reason: "execution_gate_approved" },
    );
  }

  private async blockRunWithClient(
    client: PoolClient,
    runId: string,
    status: "cancelled" | "timeout",
    reasonCode: string,
    reason: string,
  ): Promise<void> {
    const run = await client.query<{
      task_id: string | null;
      direct_chat_turn_id: string | null;
      meeting_turn_id: string | null;
    }>(
      `UPDATE runs
       SET status = $2, error = $3, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND status IN ('queued', 'running', 'waiting_approval', 'interrupted')
       RETURNING task_id, direct_chat_turn_id, meeting_turn_id`,
      [runId, status, `${reasonCode}: ${reason}`.slice(0, 4_000)],
    );
    if ((run.rowCount ?? 0) === 0) return;
    await client.query(
      `UPDATE jobs
       SET status = 'cancelled', last_error = $2, updated_at = NOW()
       WHERE run_id = $1 AND status IN ('queued', 'running')`,
      [runId, `${reasonCode}: ${reason}`.slice(0, 4_000)],
    );
    await client.query(
      `UPDATE runtime_effect_receipts
       SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
       WHERE run_id = $1 AND status = 'running'`,
      [runId],
    );
    const row = run.rows[0]!;
    if (row.task_id !== null) {
      await client.query(
        `UPDATE tasks
         SET status = 'queued', updated_at = NOW()
         WHERE id = $1 AND status = 'in_progress'`,
        [row.task_id],
      );
    }
    if (row.direct_chat_turn_id !== null) {
      await client.query(
        `UPDATE direct_chat_turns
         SET status = 'failed', error_code = $2, error_message = $3,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [
          row.direct_chat_turn_id,
          reasonCode,
          reason.slice(0, 2_000),
        ],
      );
    }
    if (row.meeting_turn_id !== null) {
      await client.query(
        `UPDATE meeting_ai_turns
         SET status = 'failed', error_code = $2, error_message = $3,
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [row.meeting_turn_id, reasonCode, reason.slice(0, 2_000)],
      );
    }
    if (status === "cancelled") {
      await appendRunEventWithClient(
        client,
        runId,
        "run.cancelled",
        "Execution Gate 阻止了本次 Run",
        { reasonCode, reason },
      );
    }
  }
}
