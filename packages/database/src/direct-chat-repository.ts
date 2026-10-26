import { randomUUID } from "node:crypto";
import {
  createRootTraceContext,
  type Agent,
  type DirectChatDetail,
  type DirectChatMessage,
  type DirectChatRunSummary,
  type DirectChatSendResult,
  type DirectChatThread,
  type DirectChatThreadListItem,
  type DirectChatTurn,
  type ExternalRunExecutionSnapshot,
  type RunInputSnapshot,
  type SendDirectChatMessageInput,
  type TraceContext,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import { Database } from "./database.js";
import {
  agentFromRow,
  runFromRow,
  type AgentRow,
  type RunRow,
} from "./rows.js";

interface DirectChatThreadRow {
  id: string;
  owner_id: string;
  agent_id: string;
  created_at: Date;
  updated_at: Date;
}

interface DirectChatMessageRow {
  id: string;
  thread_id: string;
  sequence: string;
  sender_type: DirectChatMessage["senderType"];
  sender_id: string;
  sender_name: string;
  content: string;
  client_message_id: string | null;
  turn_id: string | null;
  run_id: string | null;
  trace_id: string | null;
  status: DirectChatMessage["status"];
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
}

interface DirectChatTurnRow {
  id: string;
  thread_id: string;
  source_message_id: string;
  agent_id: string;
  attempt: number;
  status: DirectChatTurn["status"];
  run_id: string | null;
  response_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  run_status: DirectChatRunSummary["status"] | null;
  run_trace_id: string | null;
  run_error: string | null;
  run_created_at: Date | null;
  run_started_at: Date | null;
  run_ended_at: Date | null;
}

export interface DirectChatRunContext {
  readonly turn: {
    readonly id: string;
    readonly threadId: string;
    readonly sourceMessageId: string;
    readonly agentId: string;
    readonly attempt: number;
    readonly status: DirectChatTurn["status"];
  };
  readonly thread: {
    readonly id: string;
    readonly ownerId: string;
  };
  readonly messages: readonly {
    readonly senderName: string;
    readonly senderType: "owner" | "agent" | "system";
    readonly content: string;
  }[];
}

export class DirectChatPreconditionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectChatPreconditionError";
  }
}

const TURN_SELECT = `
  SELECT
    turn.*,
    run.status AS run_status,
    run.trace_id AS run_trace_id,
    run.error AS run_error,
    run.created_at AS run_created_at,
    run.started_at AS run_started_at,
    run.ended_at AS run_ended_at
  FROM direct_chat_turns AS turn
  LEFT JOIN runs AS run ON run.id = turn.run_id
`;

function messageFromRow(row: DirectChatMessageRow): DirectChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: Number(row.sequence),
    senderType: row.sender_type,
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    clientMessageId: row.client_message_id,
    turnId: row.turn_id,
    runId: row.run_id,
    traceId: row.trace_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  };
}

function runSummaryFromTurn(
  row: DirectChatTurnRow,
): DirectChatRunSummary | null {
  if (
    row.run_id === null ||
    row.run_status === null ||
    row.run_created_at === null
  ) {
    return null;
  }
  return {
    id: row.run_id,
    status: row.run_status,
    traceId: row.run_trace_id,
    error: row.run_error,
    createdAt: row.run_created_at.toISOString(),
    startedAt: row.run_started_at?.toISOString() ?? null,
    endedAt: row.run_ended_at?.toISOString() ?? null,
  };
}

function turnFromRow(row: DirectChatTurnRow): DirectChatTurn {
  return {
    id: row.id,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    agentId: row.agent_id,
    attempt: row.attempt,
    status: row.status,
    run: runSummaryFromTurn(row),
    responseMessageId: row.response_message_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function threadFromRows(
  thread: DirectChatThreadRow,
  agent: Agent,
): DirectChatThread {
  return {
    id: thread.id,
    ownerId: thread.owner_id,
    agent,
    createdAt: thread.created_at.toISOString(),
    updatedAt: thread.updated_at.toISOString(),
  };
}

function supportedRuntime(runtimeKind: string): boolean {
  return (
    runtimeKind === "fake" ||
    runtimeKind === "dsh-sdk" ||
    runtimeKind === "codex-jsonl" ||
    runtimeKind === "plain-text"
  );
}

function assertDispatchable(agent: Agent): void {
  if (agent.status !== "active") {
    throw new DirectChatPreconditionError(
      "agent_disabled",
      "The AI partner is disabled",
    );
  }
  if (!supportedRuntime(agent.runtimeKind)) {
    throw new DirectChatPreconditionError(
      "runtime_unavailable",
      `Runtime adapter is unavailable: ${agent.runtimeKind}`,
    );
  }
}

export class DirectChatRepository {
  constructor(private readonly database: Database) {}

  async listForOwner(ownerId: string): Promise<DirectChatThreadListItem[]> {
    const threads = await this.database.query<DirectChatThreadRow>(
      `SELECT * FROM direct_chat_threads
       WHERE owner_id = $1
       ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    const agents = await this.database.query<AgentRow>(
      `SELECT * FROM agents
       WHERE owner_id = $1 AND status = 'active'
       ORDER BY name, id`,
      [ownerId],
    );
    const existingAgentIds = new Set(
      threads.rows.map((thread) => thread.agent_id),
    );
    const items: DirectChatThreadListItem[] = [];
    for (const thread of threads.rows) {
      const agent = await this.agentForThread(thread.agent_id);
      if (agent === undefined) continue;
      const [latest, active] = await Promise.all([
        this.latestMessage(thread.id),
        this.activeTurn(thread.id),
      ]);
      items.push({
        threadId: thread.id,
        ownerId: thread.owner_id,
        agent,
        latestMessage: latest,
        activeTurn: active,
        updatedAt: thread.updated_at.toISOString(),
      });
    }
    for (const row of agents.rows) {
      if (existingAgentIds.has(row.id)) continue;
      items.push({
        threadId: null,
        ownerId,
        agent: agentFromRow(row),
        latestMessage: null,
        activeTurn: null,
        updatedAt: null,
      });
    }
    items.sort((left, right) => {
      const leftTime = left.updatedAt ?? "";
      const rightTime = right.updatedAt ?? "";
      if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
      return left.agent.name.localeCompare(right.agent.name);
    });
    return items;
  }

  async ensureThread(
    ownerId: string,
    agentId: string,
  ): Promise<DirectChatThread> {
    const agent = await this.requireAgent(agentId);
    if (agent.ownerId !== ownerId) {
      throw new DirectChatPreconditionError(
        "direct_chat_forbidden",
        "The AI partner belongs to another account",
      );
    }
    const existing = await this.database.query<DirectChatThreadRow>(
      "SELECT * FROM direct_chat_threads WHERE owner_id = $1 AND agent_id = $2",
      [ownerId, agentId],
    );
    if (existing.rows[0] !== undefined) {
      return threadFromRows(existing.rows[0], agent);
    }
    assertDispatchable(agent);
    const inserted = await this.database.query<DirectChatThreadRow>(
      `INSERT INTO direct_chat_threads (
         id, owner_id, agent_id, created_at, updated_at
       ) VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (owner_id, agent_id) DO UPDATE
         SET updated_at = direct_chat_threads.updated_at
       RETURNING *`,
      [randomUUID(), ownerId, agentId],
    );
    return threadFromRows(inserted.rows[0]!, agent);
  }

  async getDetail(
    threadId: string,
    ownerId: string,
  ): Promise<DirectChatDetail> {
    const thread = await this.requireOwnedThread(threadId, ownerId);
    const agent = await this.requireAgent(thread.agent_id);
    const [messages, turns] = await Promise.all([
      this.database.query<DirectChatMessageRow>(
        `SELECT * FROM direct_chat_messages
         WHERE thread_id = $1
         ORDER BY sequence, created_at, id`,
        [threadId],
      ),
      this.database.query<DirectChatTurnRow>(
        `${TURN_SELECT}
         WHERE turn.thread_id = $1
         ORDER BY turn.created_at DESC, turn.id`,
        [threadId],
      ),
    ]);
    return {
      thread: threadFromRows(thread, agent),
      messages: messages.rows.map(messageFromRow),
      turns: turns.rows.map(turnFromRow),
    };
  }

  async sendMessage(
    threadId: string,
    ownerId: string,
    input: SendDirectChatMessageInput,
    trace: TraceContext = createRootTraceContext(),
    resolveExternalExecution?: (
      agent: Agent,
    ) => Promise<ExternalRunExecutionSnapshot | undefined>,
  ): Promise<DirectChatSendResult> {
    return this.database.transaction(async (client) => {
      const thread = await this.lockOwnedThread(client, threadId, ownerId);
      const agent = await this.agentWithClient(client, thread.agent_id, true);
      if (agent === undefined) {
        throw new DirectChatPreconditionError(
          "agent_not_found",
          "Agent not found",
        );
      }
      const existing = await client.query<DirectChatMessageRow>(
        `SELECT * FROM direct_chat_messages
         WHERE thread_id = $1 AND client_message_id = $2`,
        [threadId, input.clientMessageId],
      );
      if (existing.rows[0] !== undefined) {
        return this.sendResultForSource(
          client,
          messageFromRow(existing.rows[0]),
          true,
        );
      }
      assertDispatchable(agent);
      const executionSnapshot = await resolveExternalExecution?.(agent);
      if (
        (agent.runtimeKind === "codex-jsonl" ||
          agent.runtimeKind === "plain-text") &&
        executionSnapshot === undefined
      ) {
        throw new DirectChatPreconditionError(
          "runtime_binding_missing",
          "The AI partner has no prepared external runtime execution",
        );
      }
      const message = await this.insertMessageWithClient(client, {
        threadId,
        senderType: "owner",
        senderId: ownerId,
        senderName: actorName(ownerId),
        content: input.content,
        clientMessageId: input.clientMessageId,
        traceId: trace.traceId,
      });
      const turnId = randomUUID();
      await client.query(
        `INSERT INTO direct_chat_turns (
           id, thread_id, source_message_id, agent_id, attempt, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 1, 'queued', NOW(), NOW())`,
        [turnId, threadId, message.id, agent.id],
      );
      const runId = await this.enqueueRunWithClient(client, {
        thread,
        agent,
        turnId,
        source: message,
        trace,
        ...(executionSnapshot === undefined ? {} : { executionSnapshot }),
      });
      await client.query(
        `UPDATE direct_chat_messages
         SET run_id = $2, trace_id = $3
         WHERE id = $1`,
        [message.id, runId, trace.traceId],
      );
      const refreshedMessage = await this.messageWithClient(client, message.id);
      return this.sendResultForSource(
        client,
        messageFromRow(refreshedMessage),
        false,
      );
    });
  }

  async retryTurn(
    threadId: string,
    turnId: string,
    ownerId: string,
    trace: TraceContext = createRootTraceContext(),
    resolveExternalExecution?: (
      agent: Agent,
    ) => Promise<ExternalRunExecutionSnapshot | undefined>,
  ): Promise<DirectChatSendResult> {
    return this.database.transaction(async (client) => {
      const thread = await this.lockOwnedThread(client, threadId, ownerId);
      const current = await this.turnWithClient(client, turnId, true);
      if (current === undefined || current.thread_id !== threadId) {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_not_found",
          "Direct chat turn not found",
        );
      }
      if (current.status === "completed") {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_completed",
          "A completed direct chat turn cannot be retried",
        );
      }
      if (current.status === "queued" || current.status === "running") {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_active",
          "The direct chat turn is already active",
        );
      }
      const agent = await this.agentWithClient(client, thread.agent_id, true);
      if (agent === undefined) {
        throw new DirectChatPreconditionError(
          "agent_not_found",
          "Agent not found",
        );
      }
      assertDispatchable(agent);
      const executionSnapshot = await resolveExternalExecution?.(agent);
      if (
        (agent.runtimeKind === "codex-jsonl" ||
          agent.runtimeKind === "plain-text") &&
        executionSnapshot === undefined
      ) {
        throw new DirectChatPreconditionError(
          "runtime_binding_missing",
          "The AI partner has no prepared external runtime execution",
        );
      }
      const source = await this.messageWithClient(
        client,
        current.source_message_id,
      );
      const attempt = await client.query<{ next_attempt: number }>(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
         FROM direct_chat_turns
         WHERE thread_id = $1 AND source_message_id = $2`,
        [threadId, current.source_message_id],
      );
      const retryTurnId = randomUUID();
      await client.query(
        `INSERT INTO direct_chat_turns (
           id, thread_id, source_message_id, agent_id, attempt, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW())`,
        [
          retryTurnId,
          threadId,
          current.source_message_id,
          agent.id,
          Number(attempt.rows[0]!.next_attempt),
        ],
      );
      await this.enqueueRunWithClient(client, {
        thread,
        agent,
        turnId: retryTurnId,
        source: messageFromRow(source),
        trace,
        ...(executionSnapshot === undefined ? {} : { executionSnapshot }),
      });
      return this.sendResultForSource(client, messageFromRow(source), false);
    });
  }

  async cancelTurn(
    threadId: string,
    turnId: string,
    ownerId: string,
    reason: string,
  ): Promise<DirectChatTurn> {
    return this.database.transaction(async (client) => {
      await this.lockOwnedThread(client, threadId, ownerId);
      const current = await this.turnWithClient(client, turnId, true);
      if (current === undefined || current.thread_id !== threadId) {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_not_found",
          "Direct chat turn not found",
        );
      }
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_terminal",
          `Direct chat turn is already ${current.status}`,
        );
      }
      await cancelDirectChatTurnWithClient(
        client,
        turnId,
        reason.slice(0, 2_000),
      );
      await appendRunEventWithClient(
        client,
        current.run_id,
        "run.cancelled",
        "用户取消了 AI 私聊回复",
        { threadId, turnId, reason: reason.slice(0, 2_000) },
      );
      const cancelled = await this.turnWithClient(client, turnId);
      if (cancelled === undefined) {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_not_found",
          "Direct chat turn disappeared after cancellation",
        );
      }
      return turnFromRow(cancelled);
    });
  }

  async cancelOpenTurnsForAgent(
    agentId: string,
    reason: string,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const turns = await client.query<DirectChatTurnRow>(
        `${TURN_SELECT}
         WHERE turn.agent_id = $1
           AND turn.status IN ('queued', 'running')
         FOR UPDATE OF turn`,
        [agentId],
      );
      for (const turn of turns.rows) {
        await cancelDirectChatTurnWithClient(
          client,
          turn.id,
          reason.slice(0, 2_000),
        );
      }
    });
  }

  async prepareRun(runId: string): Promise<DirectChatRunContext> {
    return this.database.transaction(async (client) => {
      const result = await client.query<
        DirectChatTurnRow & {
          owner_id: string;
          agent_status: Agent["status"];
          runtime_kind: Agent["runtimeKind"];
        }
      >(
        `SELECT
           turn.*,
           run.status AS run_status,
           run.trace_id AS run_trace_id,
           run.error AS run_error,
           run.created_at AS run_created_at,
           run.started_at AS run_started_at,
           run.ended_at AS run_ended_at,
           thread.owner_id,
           agent.status AS agent_status,
           agent.runtime_kind
         FROM direct_chat_turns AS turn
         JOIN direct_chat_threads AS thread ON thread.id = turn.thread_id
         JOIN agents AS agent ON agent.id = turn.agent_id
         JOIN runs AS run ON run.id = turn.run_id
         WHERE turn.run_id = $1
         FOR UPDATE OF turn`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_not_found",
          "Direct chat turn not found",
        );
      }
      if (row.status === "completed") {
        return {
          turn: {
            id: row.id,
            threadId: row.thread_id,
            sourceMessageId: row.source_message_id,
            agentId: row.agent_id,
            attempt: row.attempt,
            status: row.status,
          },
          thread: { id: row.thread_id, ownerId: row.owner_id },
          messages: [],
        };
      }
      if (row.status === "failed" || row.status === "cancelled") {
        throw new DirectChatPreconditionError(
          "direct_chat_turn_terminal",
          `Direct chat turn is ${row.status}`,
        );
      }
      if (row.agent_status !== "active") {
        throw new DirectChatPreconditionError(
          "agent_disabled",
          "The AI partner was disabled before execution",
        );
      }
      await client.query(
        `UPDATE direct_chat_turns
         SET status = 'running',
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [row.id],
      );
      await client.query(
        `UPDATE runs
         SET timeout_at = NOW() + INTERVAL '120 seconds',
             updated_at = NOW()
         WHERE id = $1 AND timeout_at IS NULL`,
        [runId],
      );
      const messages = await client.query<{
        sender_name: string;
        sender_type: DirectChatRunContext["messages"][number]["senderType"];
        content: string;
      }>(
        `SELECT sender_name, sender_type, content
         FROM direct_chat_messages
         WHERE thread_id = $1
           AND status = 'sent'
           AND sender_type <> 'system'
         ORDER BY sequence DESC
         LIMIT 40`,
        [row.thread_id],
      );
      return {
        turn: {
          id: row.id,
          threadId: row.thread_id,
          sourceMessageId: row.source_message_id,
          agentId: row.agent_id,
          attempt: row.attempt,
          status: "running",
        },
        thread: { id: row.thread_id, ownerId: row.owner_id },
        messages: messages.rows.reverse().map((message) => ({
          senderName: message.sender_name,
          senderType: message.sender_type,
          content: message.content,
        })),
      };
    });
  }

  async getRunContext(
    runId: string,
  ): Promise<DirectChatRunContext | undefined> {
    const result = await this.database.query<
      DirectChatTurnRow & { owner_id: string }
    >(
      `SELECT
         turn.*,
         run.status AS run_status,
         run.trace_id AS run_trace_id,
         run.error AS run_error,
         run.created_at AS run_created_at,
         run.started_at AS run_started_at,
         run.ended_at AS run_ended_at,
         thread.owner_id
       FROM direct_chat_turns AS turn
       JOIN direct_chat_threads AS thread ON thread.id = turn.thread_id
       JOIN runs AS run ON run.id = turn.run_id
       WHERE turn.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const messages = await this.database.query<{
      sender_name: string;
      sender_type: DirectChatRunContext["messages"][number]["senderType"];
      content: string;
    }>(
      `SELECT sender_name, sender_type, content
       FROM direct_chat_messages
       WHERE thread_id = $1
         AND status = 'sent'
         AND sender_type <> 'system'
       ORDER BY sequence DESC
       LIMIT 40`,
      [row.thread_id],
    );
    return {
      turn: {
        id: row.id,
        threadId: row.thread_id,
        sourceMessageId: row.source_message_id,
        agentId: row.agent_id,
        attempt: row.attempt,
        status: row.status,
      },
      thread: { id: row.thread_id, ownerId: row.owner_id },
      messages: messages.rows.reverse().map((message) => ({
        senderName: message.sender_name,
        senderType: message.sender_type,
        content: message.content,
      })),
    };
  }

  async completeTurn(runId: string, output: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await completeDirectChatTurnWithClient(client, runId, output);
    });
  }

  async failTurn(runId: string, code: string, message: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await failDirectChatTurnWithClient(client, runId, code, message);
    });
  }

  async canAccessRun(runId: string, actorId: string): Promise<boolean> {
    const result = await this.database.query<{ owner_id: string | null }>(
      `SELECT thread.owner_id
       FROM runs AS run
       LEFT JOIN direct_chat_turns AS turn ON turn.id = run.direct_chat_turn_id
       LEFT JOIN direct_chat_threads AS thread ON thread.id = turn.thread_id
       WHERE run.id = $1`,
      [runId],
    );
    const ownerId = result.rows[0]?.owner_id;
    return ownerId === null || ownerId === undefined || ownerId === actorId;
  }

  private async sendResultForSource(
    client: PoolClient,
    message: DirectChatMessage,
    replayed: boolean,
  ): Promise<DirectChatSendResult> {
    const turn = await client.query<DirectChatTurnRow>(
      `${TURN_SELECT}
       WHERE turn.source_message_id = $1
       ORDER BY turn.attempt DESC
       LIMIT 1`,
      [message.id],
    );
    const row = turn.rows[0];
    if (row === undefined) {
      throw new DirectChatPreconditionError(
        "direct_chat_turn_not_found",
        "Direct chat turn not found for message",
      );
    }
    const run = runSummaryFromTurn(row);
    if (run === null) {
      throw new DirectChatPreconditionError(
        "direct_chat_run_not_found",
        "Direct chat run not found for turn",
      );
    }
    return {
      message,
      turn: turnFromRow(row),
      run,
      replayed,
    };
  }

  private async enqueueRunWithClient(
    client: PoolClient,
    input: {
      readonly thread: DirectChatThreadRow;
      readonly agent: Agent;
      readonly turnId: string;
      readonly source: DirectChatMessage;
      readonly trace: TraceContext;
      readonly executionSnapshot?: ExternalRunExecutionSnapshot;
    },
  ): Promise<string> {
    const runId = randomUUID();
    const inputSnapshot: RunInputSnapshot = {
      taskTitle: `AI 对话 · ${input.agent.name}`,
      taskDescription: input.source.content,
      acceptance: [],
      instruction: input.source.content,
      agentName: input.agent.name,
      runtimeKind: input.agent.runtimeKind,
      directChat: {
        threadId: input.thread.id,
        turnId: input.turnId,
        ownerId: input.thread.owner_id,
        agentId: input.agent.id,
      },
    };
    const run = await client.query<RunRow>(
      `INSERT INTO runs (
         id, project_id, task_id, meeting_turn_id, direct_chat_turn_id,
         agent_id, status, input_snapshot, execution_snapshot,
         external_runtime_id, external_runtime_revision,
         external_runtime_provider, external_runtime_protocol,
         observability, attempt,
         timeout_at, idempotency_key, trace_id, trace_root_span_id,
         created_at, updated_at
       ) VALUES (
         $1, NULL, NULL, NULL, $2, $3, 'queued', $4::jsonb, $5::jsonb,
         $6, $7, $8, $9, $10::jsonb, 1, NULL, $11, $12, $13,
         NOW(), NOW()
       )
       RETURNING *`,
      [
        runId,
        input.turnId,
        input.agent.id,
        JSON.stringify(inputSnapshot),
        input.executionSnapshot === undefined
          ? null
          : JSON.stringify(input.executionSnapshot),
        input.executionSnapshot?.runtime.id ?? null,
        input.executionSnapshot?.runtime.revision ?? null,
        input.executionSnapshot?.runtime.provider ?? null,
        input.executionSnapshot?.runtime.protocol ?? null,
        JSON.stringify({
          planVisibility:
            input.executionSnapshot?.runtime.protocol === "codex-jsonl"
              ? "summary"
              : input.executionSnapshot === undefined
                ? "summary"
                : "opaque",
          toolEventCompleteness:
            input.executionSnapshot?.runtime.protocol === "codex-jsonl"
              ? "partial"
              : input.executionSnapshot === undefined
                ? "partial"
                : "none",
          textStreaming:
            input.executionSnapshot?.runtime.protocol === "plain-text"
              ? "final-only"
              : "message",
          subagentVisibility: "none",
        }),
        `direct-chat:${input.turnId}`,
        input.trace.traceId,
        input.trace.spanId,
      ],
    );
    if (run.rowCount !== 1) {
      throw new Error("direct chat run was not created");
    }
    await client.query(
      `UPDATE direct_chat_turns SET run_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [input.turnId, runId],
    );
    await client.query(
      `INSERT INTO jobs (
         id, run_id, kind, status, available_at, max_attempts, trace_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'agent.run', 'queued', NOW(), 3, $3, NOW(), NOW()
       )`,
      [randomUUID(), runId, input.trace.traceId],
    );
    await client.query(
      `INSERT INTO run_events (
         id, run_id, seq, type, visibility, summary, data,
         trace_id, span_id, parent_span_id, created_at
       ) VALUES (
         $1, $2, 1, 'run.queued', 'public', $3, $4::jsonb,
         $5, $6, $7, NOW()
       )`,
      [
        randomUUID(),
        runId,
        "AI 私聊回复已进入执行队列",
        JSON.stringify({
          threadId: input.thread.id,
          turnId: input.turnId,
          agentId: input.agent.id,
        }),
        input.trace.traceId,
        randomUUID().replaceAll("-", "").slice(0, 16),
        input.trace.spanId,
      ],
    );
    await client.query(
      `INSERT INTO domain_outbox (
         id, topic, payload, status, created_at
       ) VALUES (
         $1, 'direct.chat.reply', $2::jsonb, 'pending', NOW()
       )`,
      [
        randomUUID(),
        JSON.stringify({
          threadId: input.thread.id,
          ownerId: input.thread.owner_id,
          agentId: input.agent.id,
          turnId: input.turnId,
          runId,
          traceId: input.trace.traceId,
        }),
      ],
    );
    return runFromRow(run.rows[0]!).id;
  }

  private async insertMessageWithClient(
    client: PoolClient,
    input: {
      readonly threadId: string;
      readonly senderType: DirectChatMessage["senderType"];
      readonly senderId: string;
      readonly senderName: string;
      readonly content: string;
      readonly clientMessageId?: string | null;
      readonly turnId?: string | null;
      readonly runId?: string | null;
      readonly traceId?: string | null;
      readonly status?: DirectChatMessage["status"];
      readonly errorCode?: string | null;
      readonly errorMessage?: string | null;
    },
  ): Promise<DirectChatMessage> {
    const sequence = await client.query<{ next_sequence: string }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM direct_chat_messages
       WHERE thread_id = $1`,
      [input.threadId],
    );
    const inserted = await client.query<DirectChatMessageRow>(
      `INSERT INTO direct_chat_messages (
         id, thread_id, sequence, sender_type, sender_id, sender_name,
         content, client_message_id, turn_id, run_id, trace_id, status,
         error_code, error_message, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.threadId,
        Number(sequence.rows[0]!.next_sequence),
        input.senderType,
        input.senderId,
        input.senderName,
        input.content,
        input.clientMessageId ?? null,
        input.turnId ?? null,
        input.runId ?? null,
        input.traceId ?? null,
        input.status ?? "sent",
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );
    return messageFromRow(inserted.rows[0]!);
  }

  private async latestMessage(
    threadId: string,
  ): Promise<DirectChatMessage | null> {
    const result = await this.database.query<DirectChatMessageRow>(
      `SELECT * FROM direct_chat_messages
       WHERE thread_id = $1
       ORDER BY sequence DESC
       LIMIT 1`,
      [threadId],
    );
    return result.rows[0] === undefined ? null : messageFromRow(result.rows[0]);
  }

  private async activeTurn(threadId: string): Promise<DirectChatTurn | null> {
    const result = await this.database.query<DirectChatTurnRow>(
      `${TURN_SELECT}
       WHERE turn.thread_id = $1
         AND turn.status IN ('queued', 'running')
       ORDER BY turn.created_at DESC
       LIMIT 1`,
      [threadId],
    );
    return result.rows[0] === undefined ? null : turnFromRow(result.rows[0]);
  }

  private async agentForThread(agentId: string): Promise<Agent | undefined> {
    return this.agentWithClient(this.database, agentId, true);
  }

  private async requireAgent(agentId: string): Promise<Agent> {
    const agent = await this.agentWithClient(this.database, agentId, true);
    if (agent === undefined) {
      throw new DirectChatPreconditionError(
        "agent_not_found",
        "Agent not found",
      );
    }
    return agent;
  }

  private async agentWithClient(
    client: Database | PoolClient,
    agentId: string,
    includeDisabled: boolean,
  ): Promise<Agent | undefined> {
    const text = `SELECT * FROM agents
      WHERE id = $1 AND ($2::boolean OR status = 'active')`;
    const values = [agentId, includeDisabled];
    const result =
      client instanceof Database
        ? await client.query<AgentRow>(text, values)
        : await client.query<AgentRow>(text, values);
    return result.rows[0] === undefined
      ? undefined
      : agentFromRow(result.rows[0]);
  }

  private async requireOwnedThread(
    threadId: string,
    ownerId: string,
  ): Promise<DirectChatThreadRow> {
    const thread = await this.queryOwnedThread(
      this.database,
      threadId,
      ownerId,
    );
    if (thread === undefined) {
      throw new DirectChatPreconditionError(
        "direct_chat_not_found",
        "Direct chat not found",
      );
    }
    return thread;
  }

  private async lockOwnedThread(
    client: PoolClient,
    threadId: string,
    ownerId: string,
  ): Promise<DirectChatThreadRow> {
    const thread = await this.queryOwnedThread(client, threadId, ownerId, true);
    if (thread === undefined) {
      throw new DirectChatPreconditionError(
        "direct_chat_not_found",
        "Direct chat not found",
      );
    }
    return thread;
  }

  private async queryOwnedThread(
    client: Database | PoolClient,
    threadId: string,
    ownerId: string,
    lock = false,
  ): Promise<DirectChatThreadRow | undefined> {
    const text = `SELECT * FROM direct_chat_threads
      WHERE id = $1 AND owner_id = $2
      ${lock ? "FOR UPDATE" : ""}`;
    const values = [threadId, ownerId];
    const result =
      client instanceof Database
        ? await client.query<DirectChatThreadRow>(text, values)
        : await client.query<DirectChatThreadRow>(text, values);
    return result.rows[0];
  }

  private async messageWithClient(
    client: PoolClient,
    messageId: string,
  ): Promise<DirectChatMessageRow> {
    const result = await client.query<DirectChatMessageRow>(
      "SELECT * FROM direct_chat_messages WHERE id = $1",
      [messageId],
    );
    if (result.rows[0] === undefined) {
      throw new DirectChatPreconditionError(
        "direct_chat_message_not_found",
        "Direct chat message not found",
      );
    }
    return result.rows[0];
  }

  private async turnWithClient(
    client: PoolClient | Database,
    turnId: string,
    lock = false,
  ): Promise<DirectChatTurnRow | undefined> {
    const text = `${TURN_SELECT}
      WHERE turn.id = $1
      ${lock ? "FOR UPDATE OF turn" : ""}`;
    const values = [turnId];
    const result =
      client instanceof Database
        ? await client.query<DirectChatTurnRow>(text, values)
        : await client.query<DirectChatTurnRow>(text, values);
    return result.rows[0];
  }
}

export async function completeDirectChatTurnWithClient(
  client: PoolClient,
  runId: string,
  output: string,
): Promise<void> {
  const result = await client.query<
    DirectChatTurnRow & {
      owner_id: string;
      agent_name: string;
      run_trace_id: string | null;
    }
  >(
    `SELECT
       turn.*,
       thread.owner_id,
       agent.name AS agent_name,
       run.trace_id AS run_trace_id,
       run.status AS run_status,
       run.error AS run_error,
       run.created_at AS run_created_at,
       run.started_at AS run_started_at,
       run.ended_at AS run_ended_at
     FROM direct_chat_turns AS turn
     JOIN direct_chat_threads AS thread ON thread.id = turn.thread_id
     JOIN agents AS agent ON agent.id = turn.agent_id
     JOIN runs AS run ON run.id = turn.run_id
     WHERE turn.run_id = $1
     FOR UPDATE OF turn`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) return;
  if (row.status === "failed" || row.status === "cancelled") return;
  if (row.response_message_id !== null) {
    await client.query(
      `UPDATE direct_chat_turns
       SET status = 'completed', error_code = NULL, error_message = NULL,
           completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [row.id],
    );
    return;
  }
  const content = output.trim();
  if (content === "") {
    await failDirectChatTurnWithClient(
      client,
      runId,
      "direct_chat_empty_output",
      "The Agent returned an empty reply",
    );
    return;
  }
  const message = await insertTurnMessageWithClient(client, {
    row,
    content,
    senderType: "agent",
    status: "sent",
    traceId: row.run_trace_id,
  });
  await client.query(
    `UPDATE direct_chat_turns
     SET status = 'completed', response_message_id = $2, error_code = NULL,
         error_message = NULL, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [row.id, message.id],
  );
  await client.query(
    "UPDATE direct_chat_threads SET updated_at = NOW() WHERE id = $1",
    [row.thread_id],
  );
}

export async function failDirectChatTurnWithClient(
  client: PoolClient,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  const result = await client.query<
    DirectChatTurnRow & {
      agent_name: string;
      run_trace_id: string | null;
    }
  >(
    `SELECT
       turn.*,
       agent.name AS agent_name,
       run.trace_id AS run_trace_id,
       run.status AS run_status,
       run.error AS run_error,
       run.created_at AS run_created_at,
       run.started_at AS run_started_at,
       run.ended_at AS run_ended_at
     FROM direct_chat_turns AS turn
     JOIN agents AS agent ON agent.id = turn.agent_id
     JOIN runs AS run ON run.id = turn.run_id
     WHERE turn.run_id = $1
     FOR UPDATE OF turn`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined || row.status === "completed") return;
  const safeCode = code.slice(0, 180);
  const safeMessage = message.slice(0, 2_000);
  let responseMessageId = row.response_message_id;
  if (responseMessageId === null) {
    const response = await insertTurnMessageWithClient(client, {
      row,
      content: `回复失败：${safeMessage}`,
      senderType: "agent",
      status: "failed",
      traceId: row.run_trace_id,
      errorCode: safeCode,
      errorMessage: safeMessage,
    });
    responseMessageId = response.id;
  }
  await client.query(
    `UPDATE direct_chat_turns
     SET status = 'failed', response_message_id = $2, error_code = $3,
         error_message = $4, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'`,
    [row.id, responseMessageId, safeCode, safeMessage],
  );
  await client.query(
    "UPDATE direct_chat_threads SET updated_at = NOW() WHERE id = $1",
    [row.thread_id],
  );
}

export async function cancelDirectChatTurnWithClient(
  client: PoolClient,
  turnId: string,
  reason: string,
): Promise<void> {
  const result = await client.query<
    DirectChatTurnRow & {
      agent_name: string;
      run_trace_id: string | null;
    }
  >(
    `SELECT
       turn.*,
       agent.name AS agent_name,
       run.trace_id AS run_trace_id,
       run.status AS run_status,
       run.error AS run_error,
       run.created_at AS run_created_at,
       run.started_at AS run_started_at,
       run.ended_at AS run_ended_at
     FROM direct_chat_turns AS turn
     JOIN agents AS agent ON agent.id = turn.agent_id
     LEFT JOIN runs AS run ON run.id = turn.run_id
     WHERE turn.id = $1
     FOR UPDATE OF turn`,
    [turnId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled"
  ) {
    return;
  }
  const safeReason = reason.slice(0, 2_000);
  if (row.run_id !== null) {
    await client.query(
      `UPDATE runs
       SET status = 'cancelled', error = $2, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'running', 'interrupted')`,
      [row.run_id, safeReason],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'cancelled', last_error = $2, updated_at = NOW()
       WHERE run_id = $1 AND status IN ('queued', 'running')`,
      [row.run_id, safeReason],
    );
    await client.query(
      `UPDATE runtime_effect_receipts
       SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
       WHERE run_id = $1 AND status = 'running'`,
      [row.run_id],
    );
  }
  let responseMessageId = row.response_message_id;
  if (responseMessageId === null) {
    const response = await insertTurnMessageWithClient(client, {
      row,
      content: "回复已取消。",
      senderType: "agent",
      status: "cancelled",
      traceId: row.run_trace_id,
      errorCode: "direct_chat_cancelled",
      errorMessage: safeReason,
    });
    responseMessageId = response.id;
  }
  await client.query(
    `UPDATE direct_chat_turns
     SET status = 'cancelled', response_message_id = $2,
         error_code = 'direct_chat_cancelled', error_message = $3,
         completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [row.id, responseMessageId, safeReason],
  );
  await client.query(
    "UPDATE direct_chat_threads SET updated_at = NOW() WHERE id = $1",
    [row.thread_id],
  );
}

export async function cancelDirectChatRunWithClient(
  client: PoolClient,
  runId: string,
  reason: string,
): Promise<void> {
  const turn = await client.query<{ id: string }>(
    "SELECT id FROM direct_chat_turns WHERE run_id = $1",
    [runId],
  );
  if (turn.rows[0] !== undefined) {
    await cancelDirectChatTurnWithClient(
      client,
      turn.rows[0].id,
      reason.slice(0, 2_000),
    );
  }
}

async function insertTurnMessageWithClient(
  client: PoolClient,
  input: {
    readonly row: DirectChatTurnRow & { readonly agent_name: string };
    readonly content: string;
    readonly senderType: DirectChatMessage["senderType"];
    readonly status: DirectChatMessage["status"];
    readonly traceId: string | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  },
): Promise<DirectChatMessageRow> {
  const sequence = await client.query<{ next_sequence: string }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM direct_chat_messages
     WHERE thread_id = $1`,
    [input.row.thread_id],
  );
  const inserted = await client.query<DirectChatMessageRow>(
    `INSERT INTO direct_chat_messages (
       id, thread_id, sequence, sender_type, sender_id, sender_name,
       content, client_message_id, turn_id, run_id, trace_id, status,
       error_code, error_message, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13,
       NOW()
     )
     ON CONFLICT (turn_id) WHERE turn_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      input.row.thread_id,
      Number(sequence.rows[0]!.next_sequence),
      input.senderType,
      input.row.agent_id,
      input.row.agent_name,
      input.content,
      input.row.id,
      input.row.run_id,
      input.traceId,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
    ],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0];
  const existing = await client.query<DirectChatMessageRow>(
    "SELECT * FROM direct_chat_messages WHERE turn_id = $1",
    [input.row.id],
  );
  if (existing.rows[0] === undefined) {
    throw new Error("direct chat turn message was not persisted");
  }
  return existing.rows[0];
}

async function appendRunEventWithClient(
  client: PoolClient,
  runId: string | null,
  type: "run.cancelled",
  summary: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (runId === null) return;
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

function actorName(actorId: string): string {
  return actorId === "local-admin" ? "Local Admin" : actorId;
}
