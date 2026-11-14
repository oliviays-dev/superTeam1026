import { randomUUID } from "node:crypto";
import type {
  AgentTaskToolCategory,
  AgentTaskToolName,
  ToolInvocationRecord,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface ToolInvocationRow {
  id: string;
  run_id: string;
  run_attempt: number;
  scene_session_id: string | null;
  task_id: string | null;
  project_id: string | null;
  agent_id: string;
  agent_principal_id: string | null;
  envelope_id: string | null;
  envelope_digest: string | null;
  ticket_id: string | null;
  gate_id: string | null;
  tool_name: AgentTaskToolName;
  tool_category: AgentTaskToolCategory;
  request_digest: string;
  idempotency_key: string;
  status: ToolInvocationRecord["status"];
  result: Record<string, unknown> | null;
  rejection_code: string | null;
  rejection_reason: string | null;
  path_digest: string | null;
  path_summary: string | null;
  byte_count: string | null;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export type BeginToolInvocationResult =
  | { readonly kind: "claimed"; readonly invocation: ToolInvocationRecord }
  | { readonly kind: "replay"; readonly invocation: ToolInvocationRecord }
  | { readonly kind: "in_progress"; readonly invocation: ToolInvocationRecord }
  | { readonly kind: "failed"; readonly invocation: ToolInvocationRecord }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "gate_already_used" };

export interface ToolInvocationIdentity {
  readonly runId: string;
  readonly runAttempt: number;
  readonly sceneSessionId: string;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly agentId: string;
  readonly agentPrincipalId: string;
  readonly envelopeId: string;
  readonly envelopeDigest: string;
  readonly ticketId: string | null;
  readonly gateId: string | null;
  readonly tool: AgentTaskToolName;
  readonly toolCategory: AgentTaskToolCategory;
  readonly requestDigest: string;
  readonly idempotencyKey: string;
}

export class AgentToolRepositoryError extends Error {
  constructor(
    readonly code:
      | "agent_tool_task_not_found"
      | "agent_tool_task_state_changed",
    message: string,
  ) {
    super(message);
    this.name = "AgentToolRepositoryError";
  }
}

function invocationFromRow(row: ToolInvocationRow): ToolInvocationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    sceneSessionId: row.scene_session_id!,
    taskId: row.task_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    envelopeId: row.envelope_id,
    envelopeDigest: row.envelope_digest,
    ticketId: row.ticket_id,
    gateId: row.gate_id,
    tool: row.tool_name,
    toolCategory: row.tool_category,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    result: row.result,
    rejectionCode: row.rejection_code,
    rejectionReason: row.rejection_reason,
    pathDigest: row.path_digest,
    pathSummary: row.path_summary,
    byteCount: row.byte_count === null ? null : Number(row.byte_count),
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function appendRunEventWithClient(
  client: PoolClient,
  input: {
    readonly runId: string;
    readonly type: "tool.call" | "tool.result";
    readonly summary: string;
    readonly data: Record<string, unknown>;
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
      input.runId,
      input.type,
      input.summary,
      JSON.stringify(input.data),
      randomUUID().replaceAll("-", "").slice(0, 16),
    ],
  );
}

function eventData(
  invocation: ToolInvocationRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    invocationId: invocation.id,
    tool: invocation.tool,
    toolCategory: invocation.toolCategory,
    status: invocation.status,
    pathDigest: invocation.pathDigest,
    pathSummary: invocation.pathSummary,
    byteCount: invocation.byteCount,
    result: invocation.result,
    rejectionCode: invocation.rejectionCode,
    rejectionReason: invocation.rejectionReason,
    ...extra,
  };
}

export class AgentToolRepository {
  constructor(private readonly database: Database) {}

  async begin(
    input: ToolInvocationIdentity & {
      readonly ticketId: string;
      readonly gateId: string;
    },
  ): Promise<BeginToolInvocationResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`agent-tool-idempotency:${input.runId}:${input.idempotencyKey}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`agent-tool-gate:${input.gateId}`],
      );
      const existing = await client.query<ToolInvocationRow>(
        `SELECT *
         FROM tool_invocations
         WHERE run_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.runId, input.idempotencyKey],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        if (current.request_digest !== input.requestDigest) {
          return { kind: "idempotency_conflict" as const };
        }
        const invocation = invocationFromRow(current);
        if (current.status === "succeeded") {
          return { kind: "replay" as const, invocation };
        }
        if (current.status === "failed") {
          return { kind: "failed" as const, invocation };
        }
        return { kind: "in_progress" as const, invocation };
      }

      const gateUsage = await client.query<{ id: string }>(
        "SELECT id FROM tool_invocations WHERE gate_id = $1 FOR UPDATE",
        [input.gateId],
      );
      if (gateUsage.rows[0] !== undefined) {
        return { kind: "gate_already_used" as const };
      }

      const inserted = await client.query<ToolInvocationRow>(
        `INSERT INTO tool_invocations (
           id, run_id, run_attempt, scene_session_id, task_id, project_id,
           agent_id, agent_principal_id, envelope_id, envelope_digest,
           ticket_id, gate_id, tool_name, tool_category, request_digest,
           idempotency_key, status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, 'started', NOW(), NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          input.runId,
          input.runAttempt,
          input.sceneSessionId,
          input.taskId,
          input.projectId,
          input.agentId,
          input.agentPrincipalId,
          input.envelopeId,
          input.envelopeDigest,
          input.ticketId,
          input.gateId,
          input.tool,
          input.toolCategory,
          input.requestDigest,
          input.idempotencyKey,
        ],
      );
      const invocation = invocationFromRow(inserted.rows[0]!);
      await appendRunEventWithClient(client, {
        runId: invocation.runId,
        type: "tool.call",
        summary: `Tool ${invocation.tool} 开始执行`,
        data: eventData(invocation),
      });
      return { kind: "claimed" as const, invocation };
    });
  }

  async recordFailure(input: {
    readonly identity: ToolInvocationIdentity;
    readonly rejectionCode: string;
    readonly rejectionReason: string;
    readonly pathDigest?: string | null;
    readonly pathSummary?: string | null;
    readonly byteCount?: number | null;
  }): Promise<ToolInvocationRecord> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `agent-tool-idempotency:${input.identity.runId}:${input.identity.idempotencyKey}`,
        ],
      );
      if (input.identity.gateId !== null) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`agent-tool-gate:${input.identity.gateId}`],
        );
      }
      const existing = await client.query<ToolInvocationRow>(
        `SELECT *
         FROM tool_invocations
         WHERE run_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.identity.runId, input.identity.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        return invocationFromRow(existing.rows[0]);
      }
      if (input.identity.gateId !== null) {
        const gateUsage = await client.query<{ id: string }>(
          "SELECT id FROM tool_invocations WHERE gate_id = $1 FOR UPDATE",
          [input.identity.gateId],
        );
        if (gateUsage.rows[0] !== undefined) {
          throw new Error("execution gate was already consumed");
        }
      }
      const inserted = await client.query<ToolInvocationRow>(
        `INSERT INTO tool_invocations (
           id, run_id, run_attempt, scene_session_id, task_id, project_id,
           agent_id, agent_principal_id, envelope_id, envelope_digest,
           ticket_id, gate_id, tool_name, tool_category, request_digest,
           idempotency_key, status, rejection_code, rejection_reason,
           path_digest, path_summary, byte_count, created_at, completed_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, 'failed', $17, $18, $19, $20, $21,
           NOW(), NOW(), NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          input.identity.runId,
          input.identity.runAttempt,
          input.identity.sceneSessionId,
          input.identity.taskId,
          input.identity.projectId,
          input.identity.agentId,
          input.identity.agentPrincipalId,
          input.identity.envelopeId,
          input.identity.envelopeDigest,
          input.identity.ticketId,
          input.identity.gateId,
          input.identity.tool,
          input.identity.toolCategory,
          input.identity.requestDigest,
          input.identity.idempotencyKey,
          input.rejectionCode.slice(0, 180),
          input.rejectionReason.slice(0, 4_000),
          input.pathDigest ?? null,
          input.pathSummary?.slice(0, 500) ?? null,
          input.byteCount ?? null,
        ],
      );
      const invocation = invocationFromRow(inserted.rows[0]!);
      await appendRunEventWithClient(client, {
        runId: invocation.runId,
        type: "tool.result",
        summary: `Tool ${invocation.tool} 被拒绝`,
        data: eventData(invocation),
      });
      return invocation;
    });
  }

  async succeed(input: {
    readonly id: string;
    readonly result: Record<string, unknown>;
    readonly eventResult?: Record<string, unknown>;
    readonly pathDigest?: string | null;
    readonly pathSummary?: string | null;
    readonly byteCount?: number | null;
  }): Promise<ToolInvocationRecord> {
    return this.database.transaction(async (client) => {
      const updated = await client.query<ToolInvocationRow>(
        `UPDATE tool_invocations
         SET status = 'succeeded',
             result = $2::jsonb,
             path_digest = COALESCE($3, path_digest),
             path_summary = COALESCE($4, path_summary),
             byte_count = COALESCE($5, byte_count),
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'started'
         RETURNING *`,
        [
          input.id,
          JSON.stringify(input.result),
          input.pathDigest ?? null,
          input.pathSummary?.slice(0, 500) ?? null,
          input.byteCount ?? null,
        ],
      );
      const invocation =
        updated.rows[0] === undefined
          ? await this.get(input.id)
          : invocationFromRow(updated.rows[0]);
      if (invocation === undefined) {
        throw new Error("tool invocation disappeared");
      }
      if (updated.rows[0] !== undefined) {
        await appendRunEventWithClient(client, {
          runId: invocation.runId,
          type: "tool.result",
          summary: `Tool ${invocation.tool} 执行成功`,
          data: eventData(
            invocation,
            input.eventResult === undefined
              ? {}
              : { result: input.eventResult },
          ),
        });
      }
      return invocation;
    });
  }

  async fail(input: {
    readonly id: string;
    readonly rejectionCode: string;
    readonly rejectionReason: string;
    readonly pathDigest?: string | null;
    readonly pathSummary?: string | null;
    readonly byteCount?: number | null;
  }): Promise<ToolInvocationRecord> {
    return this.database.transaction(async (client) => {
      const updated = await client.query<ToolInvocationRow>(
        `UPDATE tool_invocations
         SET status = 'failed',
             rejection_code = $2,
             rejection_reason = $3,
             path_digest = COALESCE($4, path_digest),
             path_summary = COALESCE($5, path_summary),
             byte_count = COALESCE($6, byte_count),
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'started'
         RETURNING *`,
        [
          input.id,
          input.rejectionCode.slice(0, 180),
          input.rejectionReason.slice(0, 4_000),
          input.pathDigest ?? null,
          input.pathSummary?.slice(0, 500) ?? null,
          input.byteCount ?? null,
        ],
      );
      const invocation =
        updated.rows[0] === undefined
          ? await this.get(input.id)
          : invocationFromRow(updated.rows[0]);
      if (invocation === undefined) {
        throw new Error("tool invocation disappeared");
      }
      if (updated.rows[0] !== undefined) {
        await appendRunEventWithClient(client, {
          runId: invocation.runId,
          type: "tool.result",
          summary: `Tool ${invocation.tool} 执行失败`,
          data: eventData(invocation),
        });
      }
      return invocation;
    });
  }

  async get(id: string): Promise<ToolInvocationRecord | undefined> {
    const result = await this.database.query<ToolInvocationRow>(
      "SELECT * FROM tool_invocations WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : invocationFromRow(row);
  }

  async listByRun(runId: string): Promise<ToolInvocationRecord[]> {
    const result = await this.database.query<ToolInvocationRow>(
      `SELECT *
       FROM tool_invocations
       WHERE run_id = $1
       ORDER BY created_at, id`,
      [runId],
    );
    return result.rows.map(invocationFromRow);
  }

  async commentTask(input: {
    readonly taskId: string;
    readonly agentPrincipalId: string;
    readonly agentName: string;
    readonly content: string;
    readonly isKeyConsensus: boolean;
  }): Promise<{ readonly messageId: string }> {
    return this.database.transaction(async (client) => {
      const task = await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE id = $1 FOR SHARE",
        [input.taskId],
      );
      if (task.rows[0] === undefined) {
        throw new AgentToolRepositoryError(
          "agent_tool_task_not_found",
          "Task was not found",
        );
      }
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO task_messages (
           id, task_id, author_type, author_id, author_name, content,
           reply_to_id, is_key_consensus, delivery_target, mention_agent_ids,
           created_at
         ) VALUES (
           $1, $2, 'agent', $3, $4, $5, NULL, $6, 'receiver',
           '{}'::uuid[], NOW()
         )`,
        [
          messageId,
          input.taskId,
          input.agentPrincipalId,
          input.agentName,
          input.content,
          input.isKeyConsensus,
        ],
      );
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES ($1, $2, 'message', $3, $4, $5, $6::jsonb, NOW())`,
        [
          randomUUID(),
          input.taskId,
          input.agentPrincipalId,
          input.agentName,
          "Agent 写入任务评论",
          JSON.stringify({ messageId }),
        ],
      );
      return { messageId };
    });
  }

  async requestTaskInput(input: {
    readonly taskId: string;
    readonly agentPrincipalId: string;
    readonly agentName: string;
    readonly prompt: string;
  }): Promise<{ readonly messageId: string; readonly revision: number }> {
    return this.database.transaction(async (client) => {
      const updated = await client.query<{ revision: number }>(
        `UPDATE tasks
         SET status = 'needs_input',
             needs_input_prompt = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('queued', 'in_progress', 'review', 'paused', 'blocked')
         RETURNING revision`,
        [input.taskId, input.prompt],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM tasks WHERE id = $1",
          [input.taskId],
        );
        if (existing.rows[0] === undefined) {
          throw new AgentToolRepositoryError(
            "agent_tool_task_not_found",
            "Task was not found",
          );
        }
        throw new AgentToolRepositoryError(
          "agent_tool_task_state_changed",
          "Task is no longer eligible for an Agent input request",
        );
      }
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO task_messages (
           id, task_id, author_type, author_id, author_name, content,
           reply_to_id, is_key_consensus, delivery_target, mention_agent_ids,
           created_at
         ) VALUES (
           $1, $2, 'agent', $3, $4, $5, NULL, FALSE, 'receiver',
           '{}'::uuid[], NOW()
         )`,
        [
          messageId,
          input.taskId,
          input.agentPrincipalId,
          input.agentName,
          input.prompt,
        ],
      );
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES ($1, $2, 'input', $3, $4, $5, $6::jsonb, NOW())`,
        [
          randomUUID(),
          input.taskId,
          input.agentPrincipalId,
          input.agentName,
          "Agent 请求补充输入",
          JSON.stringify({ messageId, revision: row.revision }),
        ],
      );
      return { messageId, revision: row.revision };
    });
  }
}
