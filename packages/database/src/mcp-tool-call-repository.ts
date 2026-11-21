import { randomUUID } from "node:crypto";
import type {
  McpProviderAuthKind,
  McpToolCall,
  McpToolCallDetail,
  McpToolCallErrorCategory,
  McpToolCallReceipt,
  McpToolCallStatus,
  McpToolInputSummary,
  McpToolOutputSummary,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface McpToolCallRow {
  readonly id: string;
  readonly run_id: string;
  readonly run_attempt: number;
  readonly task_id: string;
  readonly project_id: string;
  readonly agent_id: string;
  readonly agent_principal_id: string | null;
  readonly provider_id: string;
  readonly provider_key: string;
  readonly provider_version_id: string;
  readonly provider_version: number;
  readonly provider_revision: number;
  readonly tool_catalog_id: string;
  readonly tool_key: string;
  readonly tool_name: string;
  readonly tool_schema_digest: string;
  readonly ticket_id: string;
  readonly gate_id: string;
  readonly policy_id: string | null;
  readonly policy_revision: number;
  readonly envelope_id: string;
  readonly envelope_digest: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly status: McpToolCallStatus;
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

interface McpToolCallReceiptRow {
  readonly id: string;
  readonly call_id: string;
  readonly seq: string | number;
  readonly status: McpToolCallReceipt["status"];
  readonly idempotency_key: string;
  readonly input_summary: McpToolInputSummary;
  readonly output_summary: McpToolOutputSummary | null;
  readonly output_digest: string | null;
  readonly error_category: McpToolCallErrorCategory | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: Date;
}

interface ToolCatalogRow {
  readonly tool_catalog_id: string;
  readonly provider_id: string;
  readonly provider_key: string;
  readonly owner_principal_id: string;
  readonly status: string;
  readonly provider_revision: number;
  readonly current_version_id: string;
  readonly health_status: string;
  readonly discovery_status: string;
  readonly provider_version_id: string;
  readonly provider_version: number;
  readonly endpoint_url: string;
  readonly auth_kind: McpProviderAuthKind;
  readonly credential_ref: string | null;
  readonly credential_header_name: string | null;
  readonly request_timeout_ms: number;
  readonly tool_key: string;
  readonly tool_name: string;
  readonly schema_digest: string;
}

const CALL_SELECT = `
  SELECT
    call.*,
    provider.provider_key
  FROM mcp_tool_calls AS call
  JOIN mcp_providers AS provider ON provider.id = call.provider_id
`;

export interface ClaimedMcpToolCatalog {
  readonly toolCatalogId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerVersionId: string;
  readonly providerVersion: number;
  readonly providerRevision: number;
  readonly toolKey: string;
  readonly toolName: string;
  readonly toolSchemaDigest: string;
  readonly endpointUrl: string;
  readonly authKind: McpProviderAuthKind;
  readonly credentialRef: string | null;
  readonly credentialHeaderName: string | null;
  readonly requestTimeoutMs: number;
}

export interface BeginMcpToolCallInput {
  readonly runId: string;
  readonly runAttempt: number;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly agentPrincipalId: string | null;
  readonly toolKey: string;
  readonly ticketId: string;
  readonly gateId: string;
  readonly policyId: string | null;
  readonly policyRevision: number;
  readonly envelopeId: string;
  readonly envelopeDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly inputSummary: McpToolInputSummary;
  readonly leaseOwner: string;
  readonly leaseSeconds: number;
}

export type BeginMcpToolCallResult =
  | {
      readonly kind: "claimed";
      readonly call: McpToolCallDetail;
      readonly catalog: ClaimedMcpToolCatalog;
      readonly leaseToken: string;
    }
  | {
      readonly kind: "replay";
      readonly call: McpToolCallDetail;
    }
  | {
      readonly kind: "in_progress";
      readonly call: McpToolCallDetail;
    }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "gate_already_used" };

export interface CompleteMcpToolCallInput {
  readonly callId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly status: Exclude<McpToolCallStatus, "running">;
  readonly outputSummary?: McpToolOutputSummary | null;
  readonly outputDigest?: string | null;
  readonly errorCategory?: McpToolCallErrorCategory | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export type CompleteMcpToolCallResult =
  | { readonly kind: "completed"; readonly call: McpToolCallDetail }
  | { readonly kind: "claim_lost" };

export type McpToolCallRepositoryErrorCode =
  | "mcp_tool_not_found"
  | "mcp_tool_revision_conflict"
  | "mcp_tool_not_ready"
  | "mcp_tool_policy_revision_mismatch";

export class McpToolCallRepositoryError extends Error {
  constructor(
    readonly code: McpToolCallRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpToolCallRepositoryError";
  }
}

export class McpToolCallRepository {
  constructor(private readonly database: Database) {}

  async findByRunAndIdempotency(input: {
    readonly runId: string;
    readonly idempotencyKey: string;
  }): Promise<McpToolCallDetail | undefined> {
    const result = await this.database.query<McpToolCallRow>(
      `${CALL_SELECT}
       WHERE call.run_id = $1 AND call.idempotency_key = $2`,
      [input.runId, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : this.detailFromRow(row);
  }

  async begin(input: BeginMcpToolCallInput): Promise<BeginMcpToolCallResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`mcp-tool-idempotency:${input.runId}:${input.idempotencyKey}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`mcp-tool-gate:${input.gateId}`],
      );
      const existing = await client.query<McpToolCallRow>(
        `${CALL_SELECT}
         WHERE call.run_id = $1 AND call.idempotency_key = $2
         FOR UPDATE OF call`,
        [input.runId, input.idempotencyKey],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (current.request_digest !== input.requestDigest) {
          return { kind: "idempotency_conflict" as const };
        }
        return current.status === "running"
          ? {
              kind: "in_progress" as const,
              call: await this.detailFromRowWithClient(client, current),
            }
          : {
              kind: "replay" as const,
              call: await this.detailFromRowWithClient(client, current),
            };
      }

      const [mcpGateUsage, agentGateUsage] = await Promise.all([
        client.query<{ readonly id: string }>(
          "SELECT id FROM mcp_tool_calls WHERE gate_id = $1 FOR UPDATE",
          [input.gateId],
        ),
        client.query<{ readonly id: string }>(
          "SELECT id FROM tool_invocations WHERE gate_id = $1 FOR UPDATE",
          [input.gateId],
        ),
      ]);
      if (mcpGateUsage.rows[0] !== undefined || agentGateUsage.rows[0] !== undefined) {
        return { kind: "gate_already_used" as const };
      }

      const catalog = await this.lockCatalogWithClient(client, input.toolKey);
      if (
        input.policyId !== null &&
        !(await this.policyRevisionExistsWithClient(
          client,
          input.policyId,
          input.policyRevision,
        ))
      ) {
        throw new McpToolCallRepositoryError(
          "mcp_tool_policy_revision_mismatch",
          "The MCP Tool call policy revision is no longer available",
        );
      }
      const callId = randomUUID();
      const now = new Date();
      const leaseToken = randomUUID();
      const inserted = await client.query<McpToolCallRow>(
        `INSERT INTO mcp_tool_calls (
           id, run_id, run_attempt, task_id, project_id, agent_id,
           agent_principal_id, provider_id, provider_key,
           provider_version_id, provider_version, provider_revision,
           tool_catalog_id, tool_key, tool_name, tool_schema_digest,
           ticket_id, gate_id, policy_id, policy_revision, envelope_id,
           envelope_digest, idempotency_key, request_digest, status,
           input_summary, lease_owner, lease_token, lease_expires_at,
           started_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
           'running', $25::jsonb, $26, $27,
           NOW() + ($28::text || ' seconds')::interval, $29, $29, $29
         )
         RETURNING *`,
        [
          callId,
          input.runId,
          input.runAttempt,
          input.taskId,
          input.projectId,
          input.agentId,
          input.agentPrincipalId,
          catalog.provider_id,
          catalog.provider_key,
          catalog.provider_version_id,
          catalog.provider_version,
          catalog.provider_revision,
          catalog.tool_catalog_id,
          catalog.tool_key,
          catalog.tool_name,
          catalog.schema_digest,
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
      const call = inserted.rows[0]!;
      await appendReceiptWithClient(client, {
        call,
        status: "started",
        outputSummary: null,
        outputDigest: null,
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
        now,
      });
      await appendRunToolEventWithClient(client, {
        call,
        type: "tool.call",
        summary: `MCP Tool ${call.tool_name} 开始执行`,
      });
      await appendToolAuditWithClient(client, {
        call,
        action: "mcp.tool.call.started",
        fromState: { status: "authorized" },
        toState: {
          status: "running",
          callId,
          toolKey: catalog.tool_key,
        },
        now,
      });
      return {
        kind: "claimed" as const,
        call: await this.detailFromRowWithClient(client, {
          ...call,
          provider_key: catalog.provider_key,
        }),
        leaseToken,
        catalog: {
          toolCatalogId: catalog.tool_catalog_id,
          providerId: catalog.provider_id,
          providerKey: catalog.provider_key,
          providerVersionId: catalog.provider_version_id,
          providerVersion: catalog.provider_version,
          providerRevision: catalog.provider_revision,
          toolKey: catalog.tool_key,
          toolName: catalog.tool_name,
          toolSchemaDigest: catalog.schema_digest,
          endpointUrl: catalog.endpoint_url,
          authKind: catalog.auth_kind,
          credentialRef: catalog.credential_ref,
          credentialHeaderName: catalog.credential_header_name,
          requestTimeoutMs: catalog.request_timeout_ms,
        },
      };
    });
  }

  async complete(
    input: CompleteMcpToolCallInput,
  ): Promise<CompleteMcpToolCallResult> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<McpToolCallRow>(
        `${CALL_SELECT} WHERE call.id = $1 FOR UPDATE OF call`,
        [input.callId],
      );
      const call = locked.rows[0];
      if (call === undefined) return { kind: "claim_lost" as const };
      const lease = await client.query<{
        readonly lease_owner: string | null;
        readonly lease_token: string | null;
      }>(
        "SELECT lease_owner, lease_token FROM mcp_tool_calls WHERE id = $1",
        [input.callId],
      );
      if (
        call.status !== "running" ||
        lease.rows[0]?.lease_owner !== input.leaseOwner ||
        lease.rows[0]?.lease_token !== input.leaseToken
      ) {
        return { kind: "claim_lost" as const };
      }
      const now = new Date();
      const updated = await client.query<McpToolCallRow>(
        `UPDATE mcp_tool_calls
         SET status = $2,
             output_summary = $3::jsonb,
             output_digest = $4,
             error_category = $5,
             error_code = $6,
             error_message = $7,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = $8,
             updated_at = $8
         WHERE id = $1
           AND status = 'running'
         RETURNING *`,
        [
          input.callId,
          input.status,
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
      await appendReceiptWithClient(client, {
        call: terminal,
        status: input.status,
        outputSummary: input.outputSummary ?? null,
        outputDigest: input.outputDigest ?? null,
        errorCategory: input.errorCategory ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        now,
      });
      await appendRunToolEventWithClient(client, {
        call: terminal,
        type: "tool.result",
        summary: `MCP Tool ${terminal.tool_name} ${input.status}`,
      });
      await appendToolAuditWithClient(client, {
        call: terminal,
        action: `mcp.tool.call.${input.status}`,
        fromState: { status: "running" },
        toState: {
          status: input.status,
          callId: terminal.id,
          errorCategory: input.errorCategory ?? null,
          errorCode: input.errorCode ?? null,
        },
        now,
      });
      return {
        kind: "completed" as const,
        call: await this.detailFromRowWithClient(client, {
          ...terminal,
          provider_key: call.provider_key,
        }),
      };
    });
  }

  async reconcileExpired(limit = 50): Promise<number> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<McpToolCallRow>(
        `${CALL_SELECT}
         WHERE call.status = 'running'
           AND call.lease_expires_at <= NOW()
         ORDER BY call.lease_expires_at, call.id
         FOR UPDATE OF call SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      let reconciled = 0;
      for (const row of expired.rows) {
        const now = new Date();
        const updated = await client.query<McpToolCallRow>(
          `UPDATE mcp_tool_calls
           SET status = 'interrupted',
               error_category = 'unknown',
               error_code = 'mcp_tool_call_lease_expired',
               error_message = 'The MCP Tool call Worker lease expired',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               completed_at = $2,
               updated_at = $2
           WHERE id = $1
             AND status = 'running'
           RETURNING *`,
          [row.id, now],
        );
        const call = updated.rows[0];
        if (call === undefined) continue;
        await appendReceiptWithClient(client, {
          call,
          status: "interrupted",
          outputSummary: null,
          outputDigest: null,
          errorCategory: "unknown",
          errorCode: "mcp_tool_call_lease_expired",
          errorMessage: "The MCP Tool call Worker lease expired",
          now,
        });
        await appendRunToolEventWithClient(client, {
          call,
          type: "tool.result",
          summary: `MCP Tool ${call.tool_name} interrupted`,
        });
        await appendToolAuditWithClient(client, {
          call,
          action: "mcp.tool.call.interrupted",
          fromState: { status: "running" },
          toState: {
            status: "interrupted",
            callId: call.id,
            reason: "lease_expired",
          },
          now,
        });
        reconciled += 1;
      }
      return reconciled;
    });
  }

  async listByRun(runId: string): Promise<McpToolCallDetail[]> {
    const calls = await this.database.query<McpToolCallRow>(
      `${CALL_SELECT}
       WHERE call.run_id = $1
       ORDER BY call.started_at, call.id`,
      [runId],
    );
    if (calls.rows.length === 0) return [];
    const receipts = await this.database.query<McpToolCallReceiptRow>(
      `SELECT receipt.*
       FROM mcp_tool_call_receipts AS receipt
       JOIN mcp_tool_calls AS call ON call.id = receipt.call_id
       WHERE call.run_id = $1
       ORDER BY receipt.call_id, receipt.seq`,
      [runId],
    );
    return calls.rows.map((row) => ({
      call: mcpToolCallFromRow(row),
      receipts: receipts.rows
        .filter((receipt) => receipt.call_id === row.id)
        .map(mcpToolCallReceiptFromRow),
    }));
  }

  async countByRun(runId: string): Promise<number> {
    const result = await this.database.query<{ readonly count: string }>(
      "SELECT COUNT(*)::text AS count FROM mcp_tool_calls WHERE run_id = $1",
      [runId],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  private async lockCatalogWithClient(
    client: PoolClient,
    toolKey: string,
  ): Promise<ToolCatalogRow> {
    const result = await client.query<ToolCatalogRow>(
      `SELECT
         tool.id AS tool_catalog_id,
         provider.id AS provider_id,
         provider.provider_key,
         provider.owner_principal_id,
         provider.status,
         provider.revision AS provider_revision,
         provider.current_version_id,
         provider.health_status,
         provider.discovery_status,
         version.id AS provider_version_id,
         version.version AS provider_version,
         version.endpoint_url,
         version.auth_kind,
         version.credential_ref,
         version.credential_header_name,
         version.request_timeout_ms,
         tool.tool_key,
         tool.tool_name,
         tool.schema_digest
       FROM mcp_provider_tools AS tool
       JOIN mcp_providers AS provider ON provider.id = tool.provider_id
       JOIN mcp_provider_versions AS version
         ON version.id = tool.provider_version_id
        AND version.provider_id = provider.id
       WHERE tool.tool_key = $1
       FOR SHARE OF tool, provider, version`,
      [toolKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new McpToolCallRepositoryError(
        "mcp_tool_not_found",
        "MCP Tool was not found",
      );
    }
    if (row.current_version_id !== row.provider_version_id) {
      throw new McpToolCallRepositoryError(
        "mcp_tool_revision_conflict",
        "The MCP Provider version changed before the Tool call started",
      );
    }
    if (
      row.status !== "active" ||
      row.health_status !== "healthy" ||
      row.discovery_status !== "ready"
    ) {
      throw new McpToolCallRepositoryError(
        "mcp_tool_not_ready",
        "The MCP Provider Tool is not active, current and healthy",
      );
    }
    return row;
  }

  private async policyRevisionExistsWithClient(
    client: PoolClient,
    policyId: string,
    policyRevision: number,
  ): Promise<boolean> {
    const result = await client.query<{ readonly id: string }>(
      `SELECT id
       FROM task_execution_policies
       WHERE id = $1 AND revision = $2`,
      [policyId, policyRevision],
    );
    return result.rows[0] !== undefined;
  }

  private async detailFromRow(
    row: McpToolCallRow,
  ): Promise<McpToolCallDetail> {
    const receipts = await this.database.query<McpToolCallReceiptRow>(
      `SELECT *
       FROM mcp_tool_call_receipts
       WHERE call_id = $1
       ORDER BY seq`,
      [row.id],
    );
    return {
      call: mcpToolCallFromRow(row),
      receipts: receipts.rows.map(mcpToolCallReceiptFromRow),
    };
  }

  private async detailFromRowWithClient(
    client: PoolClient,
    row: McpToolCallRow,
  ): Promise<McpToolCallDetail> {
    const receipts = await client.query<McpToolCallReceiptRow>(
      `SELECT *
       FROM mcp_tool_call_receipts
       WHERE call_id = $1
       ORDER BY seq`,
      [row.id],
    );
    return {
      call: mcpToolCallFromRow(row),
      receipts: receipts.rows.map(mcpToolCallReceiptFromRow),
    };
  }
}

async function appendReceiptWithClient(
  client: PoolClient,
  input: {
    readonly call: McpToolCallRow;
    readonly status: McpToolCallReceipt["status"];
    readonly outputSummary: McpToolOutputSummary | null;
    readonly outputDigest: string | null;
    readonly errorCategory: McpToolCallErrorCategory | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO mcp_tool_call_receipts (
       id, call_id, seq, status, idempotency_key, input_summary,
       output_summary, output_digest, error_category, error_code,
       error_message, created_at
     ) VALUES (
       $1, $2, 1, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11
     )`,
    [
      randomUUID(),
      input.call.id,
      input.status,
      input.call.idempotency_key,
      JSON.stringify(input.call.input_summary),
      input.outputSummary === null ? null : JSON.stringify(input.outputSummary),
      input.outputDigest,
      input.errorCategory,
      input.errorCode?.slice(0, 160) ?? null,
      input.errorMessage?.slice(0, 2_000) ?? null,
      input.now,
    ],
  );
}

async function appendToolAuditWithClient(
  client: PoolClient,
  input: {
    readonly call: McpToolCallRow;
    readonly action: string;
    readonly fromState: Record<string, unknown>;
    readonly toState: Record<string, unknown>;
    readonly now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO mcp_provider_audit_events (
       id, provider_id, seq, action, actor_principal_id, actor_role,
       reason, from_state, to_state, revision, created_at
     ) VALUES (
       $1, $2, 1, $3, $4, 'system', '', $5::jsonb, $6::jsonb, $7, $8
     )`,
    [
      randomUUID(),
      input.call.provider_id,
      input.action,
      input.call.agent_principal_id ?? "system:mcp-tool-worker",
      JSON.stringify(input.fromState),
      JSON.stringify(input.toState),
      input.call.provider_revision,
      input.now,
    ],
  );
}

async function appendRunToolEventWithClient(
  client: PoolClient,
  input: {
    readonly call: McpToolCallRow;
    readonly type: "tool.call" | "tool.result";
    readonly summary: string;
  },
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
      input.call.run_id,
      input.type,
      input.summary,
      JSON.stringify({
        callId: input.call.id,
        providerId: input.call.provider_id,
        providerVersion: input.call.provider_version,
        toolKey: input.call.tool_key,
        toolName: input.call.tool_name,
        status: input.call.status,
        errorCategory: input.call.error_category,
        errorCode: input.call.error_code,
      }),
      randomUUID().replaceAll("-", "").slice(0, 16),
    ],
  );
}

function mcpToolCallFromRow(row: McpToolCallRow): McpToolCall {
  return {
    id: row.id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    taskId: row.task_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    providerVersionId: row.provider_version_id,
    providerVersion: row.provider_version,
    providerRevision: row.provider_revision,
    toolCatalogId: row.tool_catalog_id,
    toolKey: row.tool_key,
    toolName: row.tool_name,
    toolSchemaDigest: row.tool_schema_digest,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
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

function mcpToolCallReceiptFromRow(
  row: McpToolCallReceiptRow,
): McpToolCallReceipt {
  return {
    id: row.id,
    callId: row.call_id,
    seq: Number(row.seq),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    outputDigest: row.output_digest,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  };
}
