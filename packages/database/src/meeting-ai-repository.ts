import { createHash, randomUUID } from "node:crypto";
import {
  createRootTraceContext,
  newSpanId,
  type MeetingAiPolicy,
  type MeetingAiPolicyStatus,
  type MeetingAiTriggerKind,
  type MeetingAiTurnSummary,
  type ExternalRunExecutionSnapshot,
  type RunInputSnapshot,
  type TriggerMeetingAiInput,
  type TriggerMeetingAiResult,
  type UpdateMeetingAiPolicyInput,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import { Database } from "./database.js";

interface MeetingAiPolicyRow {
  id: string;
  meeting_id: string;
  project_id: string;
  status: MeetingAiPolicyStatus;
  trigger_kinds: MeetingAiTriggerKind[];
  cooldown_seconds: number;
  max_rounds: number;
  max_messages: number;
  run_budget_ms: number;
  revision: number;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: Date | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  rounds_used: string;
  messages_sent: string;
  messages_failed: string;
  messages_pending: string;
}

interface MeetingAiTurnRow {
  id: string;
  round_id: string;
  round_number: number;
  meeting_id: string;
  project_id: string;
  agent_id: string;
  agent_name: string;
  policy_id: string;
  policy_revision: number;
  trigger_kind: MeetingAiTriggerKind;
  trigger_reason: string;
  source_message_id: string | null;
  agenda_item: string | null;
  dedupe_key: string;
  status: MeetingAiTurnSummary["status"];
  run_id: string | null;
  message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ParticipantRow {
  agent_id: string;
  agent_name: string;
  status: "active" | "paused" | "removed";
}

export interface MeetingAiTurnRecord {
  readonly id: string;
  readonly roundId: string;
  readonly roundNumber: number;
  readonly meetingId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly triggerKind: MeetingAiTriggerKind;
  readonly triggerReason: string;
  readonly sourceMessageId: string | null;
  readonly agendaItem: string | null;
  readonly status: MeetingAiTurnSummary["status"];
  readonly runId: string | null;
  readonly messageId: string | null;
}

export interface MeetingAiRunContext {
  readonly turn: MeetingAiTurnRecord;
  readonly meeting: {
    readonly id: string;
    readonly title: string;
    readonly agenda: string;
    readonly status: "open" | "closed";
  };
  readonly messages: readonly {
    readonly authorName: string;
    readonly authorType: "human" | "agent";
    readonly content: string;
  }[];
}

export class MeetingAiPreconditionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MeetingAiPreconditionError";
  }
}

function policyFromRow(row: MeetingAiPolicyRow): MeetingAiPolicy {
  const roundsUsed = Number(row.rounds_used);
  const messagesSent = Number(row.messages_sent);
  const messagesFailed = Number(row.messages_failed);
  const messagesPending = Number(row.messages_pending);
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    status: row.status,
    triggerKinds: row.trigger_kinds,
    cooldownSeconds: row.cooldown_seconds,
    maxRounds: row.max_rounds,
    maxMessages: row.max_messages,
    runBudgetMs: row.run_budget_ms,
    revision: row.revision,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    stats: {
      roundsUsed,
      messagesSent,
      messagesFailed,
      remainingRounds: Math.max(0, row.max_rounds - roundsUsed),
      remainingMessages: Math.max(
        0,
        row.max_messages - messagesSent - messagesFailed - messagesPending,
      ),
    },
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function turnFromRow(row: MeetingAiTurnRow): MeetingAiTurnRecord {
  return {
    id: row.id,
    roundId: row.round_id,
    roundNumber: Number(row.round_number),
    meetingId: row.meeting_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    triggerKind: row.trigger_kind,
    triggerReason: row.trigger_reason,
    sourceMessageId: row.source_message_id,
    agendaItem: row.agenda_item,
    status: row.status,
    runId: row.run_id,
    messageId: row.message_id,
  };
}

function turnSummaryFromRow(row: MeetingAiTurnRow): MeetingAiTurnSummary {
  return {
    id: row.id,
    roundId: row.round_id,
    roundNumber: Number(row.round_number),
    agentId: row.agent_id,
    agentName: row.agent_name,
    triggerKind: row.trigger_kind,
    triggerReason: row.trigger_reason,
    status: row.status,
    runId: row.run_id,
    messageId: row.message_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  };
}

const POLICY_SELECT = `
  SELECT
    policy.*,
    (
      SELECT COUNT(*)::text
      FROM meeting_ai_rounds AS round
      WHERE round.meeting_id = policy.meeting_id
    ) AS rounds_used,
    (
      SELECT COUNT(*)::text
      FROM meeting_ai_turns AS turn
      WHERE turn.meeting_id = policy.meeting_id
        AND turn.status = 'completed'
    ) AS messages_sent,
    (
      SELECT COUNT(*)::text
      FROM meeting_ai_turns AS turn
      WHERE turn.meeting_id = policy.meeting_id
        AND turn.status = 'failed'
    ) AS messages_failed,
    (
      SELECT COUNT(*)::text
      FROM meeting_ai_turns AS turn
      WHERE turn.meeting_id = policy.meeting_id
        AND turn.status IN ('queued', 'running')
    ) AS messages_pending
  FROM meeting_ai_policies AS policy
`;

const TURN_FROM = `
  FROM meeting_ai_turns AS turn
  JOIN meeting_ai_rounds AS round ON round.id = turn.round_id
  JOIN agents AS agent ON agent.id = turn.agent_id
`;

const TURN_SELECT = `
  SELECT
    turn.*,
    round.round_number,
    agent.name AS agent_name
  ${TURN_FROM}
`;

function triggerRoundDedupeKey(input: {
  readonly kind: MeetingAiTriggerKind;
  readonly sourceMessageId?: string | undefined;
  readonly roundNumber?: number | undefined;
  readonly agendaItem?: string | undefined;
  readonly fallbackKey: string;
}): string {
  if (input.kind === "mention") {
    if (input.sourceMessageId === undefined) {
      throw new MeetingAiPreconditionError(
        "meeting_ai_source_required",
        "A mention trigger requires a meeting message",
      );
    }
    return `mention:${input.sourceMessageId}`;
  }
  if (input.kind === "round") {
    if (input.roundNumber === undefined) {
      throw new MeetingAiPreconditionError(
        "meeting_ai_round_required",
        "A round trigger requires a round number",
      );
    }
    return `round:${input.roundNumber}`;
  }
  if (input.kind === "agenda") {
    if (input.agendaItem === undefined || input.agendaItem.trim() === "") {
      throw new MeetingAiPreconditionError(
        "meeting_ai_agenda_required",
        "An agenda trigger requires an agenda item",
      );
    }
    return `agenda:${createHash("sha256")
      .update(input.agendaItem.trim().toLocaleLowerCase())
      .digest("hex")
      .slice(0, 32)}`;
  }
  return `summary:${input.fallbackKey}`;
}

export class MeetingAiRepository {
  constructor(private readonly database: Database) {}

  async getPolicy(meetingId: string): Promise<MeetingAiPolicy | undefined> {
    const result = await this.database.query<MeetingAiPolicyRow>(
      `${POLICY_SELECT} WHERE policy.meeting_id = $1`,
      [meetingId],
    );
    return result.rows[0] === undefined
      ? undefined
      : policyFromRow(result.rows[0]);
  }

  async listParticipants(meetingId: string): Promise<
    readonly {
      agentId: string;
      agentName: string;
      status: "active" | "paused" | "removed";
    }[]
  > {
    const result = await this.database.query<ParticipantRow>(
      `SELECT
         participant.agent_id,
         agent.name AS agent_name,
         participant.status
       FROM meeting_ai_participants AS participant
       JOIN agents AS agent ON agent.id = participant.agent_id
       WHERE participant.meeting_id = $1
       ORDER BY participant.joined_at, agent.name`,
      [meetingId],
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status,
    }));
  }

  async listTurns(meetingId: string): Promise<MeetingAiTurnSummary[]> {
    const result = await this.database.query<MeetingAiTurnRow>(
      `${TURN_SELECT}
       WHERE turn.meeting_id = $1
       ORDER BY round.round_number DESC, turn.created_at DESC`,
      [meetingId],
    );
    return result.rows.map(turnSummaryFromRow);
  }

  async updatePolicy(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly patch: UpdateMeetingAiPolicyInput;
    readonly actorId: string;
  }): Promise<MeetingAiPolicy | undefined> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE meeting_ai_policies
       SET
         status = COALESCE($3, status),
         trigger_kinds = COALESCE($4::jsonb, trigger_kinds),
         cooldown_seconds = COALESCE($5, cooldown_seconds),
         max_rounds = COALESCE($6, max_rounds),
         max_messages = COALESCE($7, max_messages),
         run_budget_ms = COALESCE($8, run_budget_ms),
         revision = revision + 1,
         updated_by = $9,
         updated_at = NOW()
       WHERE id = $1
         AND revision = $2
         AND status <> 'terminated'
       RETURNING id`,
      [
        input.id,
        input.expectedRevision,
        input.patch.status ?? null,
        input.patch.triggerKinds === undefined
          ? null
          : JSON.stringify(input.patch.triggerKinds),
        input.patch.cooldownSeconds ?? null,
        input.patch.maxRounds ?? null,
        input.patch.maxMessages ?? null,
        input.patch.runBudgetMs ?? null,
        input.actorId,
      ],
    );
    if (result.rowCount === 0) return undefined;
    return this.getPolicyById(input.id);
  }

  async transitionPolicy(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly status: MeetingAiPolicyStatus;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<MeetingAiPolicy | undefined> {
    return this.database.transaction(async (client) => {
      const current = await client.query<MeetingAiPolicyRow>(
        `${POLICY_SELECT} WHERE policy.id = $1 FOR UPDATE OF policy`,
        [input.id],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.revision !== input.expectedRevision ||
        row.status === "terminated"
      ) {
        return undefined;
      }
      await client.query(
        `UPDATE meeting_ai_policies
         SET
           status = $2,
           revision = revision + 1,
           updated_by = $3,
           last_error_code = NULL,
           last_error_message = NULL,
           last_error_at = NULL,
           updated_at = NOW()
         WHERE meeting_id = $1`,
        [row.meeting_id, input.status, input.actorId],
      );
      if (input.status !== "active") {
        await this.cancelOpenRunsWithClient(
          client,
          row.meeting_id,
          input.status === "terminated"
            ? "meeting AI participation terminated"
            : "meeting AI participation paused",
        );
      }
      const updated = await client.query<MeetingAiPolicyRow>(
        `${POLICY_SELECT} WHERE policy.meeting_id = $1`,
        [row.meeting_id],
      );
      return policyFromRow(updated.rows[0]!);
    });
  }

  async trigger(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly trigger: TriggerMeetingAiInput;
    readonly fallbackSummaryKey: string;
    readonly resolveExternalExecution?: (input: {
      readonly agentId: string;
      readonly turnId: string;
      readonly projectId: string;
    }) => Promise<ExternalRunExecutionSnapshot | undefined>;
  }): Promise<TriggerMeetingAiResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`meeting-ai:${input.meetingId}`],
      );
      const meeting = await client.query<{
        status: "open" | "closed";
        project_status: "active" | "archived";
      }>(
        `SELECT meeting.status, project.status AS project_status
         FROM meetings AS meeting
         JOIN projects AS project ON project.id = meeting.project_id
         WHERE meeting.id = $1 AND meeting.project_id = $2
         FOR SHARE OF meeting, project`,
        [input.meetingId, input.projectId],
      );
      const meetingRow = meeting.rows[0];
      if (meetingRow === undefined) {
        throw new MeetingAiPreconditionError(
          "meeting_not_found",
          "Meeting not found",
        );
      }
      if (meetingRow.status !== "open") {
        throw new MeetingAiPreconditionError(
          "meeting_closed",
          "A closed meeting cannot trigger AI participation",
        );
      }
      if (meetingRow.project_status !== "active") {
        throw new MeetingAiPreconditionError(
          "project_archived",
          "An archived project cannot trigger AI participation",
        );
      }
      if (input.trigger.sourceMessageId !== undefined) {
        const source = await client.query<{ id: string }>(
          `SELECT id FROM meeting_messages
           WHERE id = $1 AND meeting_id = $2`,
          [input.trigger.sourceMessageId, input.meetingId],
        );
        if (source.rows[0] === undefined) {
          throw new MeetingAiPreconditionError(
            "meeting_ai_source_not_found",
            "The trigger source message does not belong to this meeting",
          );
        }
      }
      const policies = await client.query<MeetingAiPolicyRow>(
        `${POLICY_SELECT}
         WHERE policy.meeting_id = $1
         FOR UPDATE OF policy`,
        [input.meetingId],
      );
      const policyRow = policies.rows[0];
      if (policyRow === undefined) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_policy_not_found",
          "Meeting AI policy not found",
        );
      }
      const policy = policyFromRow(policyRow);
      if (policy.status !== "active") {
        throw new MeetingAiPreconditionError(
          policy.status === "terminated"
            ? "meeting_ai_terminated"
            : "meeting_ai_paused",
          `Meeting AI participation is ${policy.status}`,
        );
      }
      if (!policy.triggerKinds.includes(input.trigger.kind)) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_trigger_disabled",
          `The ${input.trigger.kind} trigger is disabled by policy`,
        );
      }
      const roundDedupeKey = triggerRoundDedupeKey({
        kind: input.trigger.kind,
        sourceMessageId: input.trigger.sourceMessageId,
        roundNumber: input.trigger.roundNumber,
        agendaItem: input.trigger.agendaItem,
        fallbackKey: input.fallbackSummaryKey,
      });
      const existingRound = await client.query<{ id: string }>(
        `SELECT id FROM meeting_ai_rounds
         WHERE meeting_id = $1 AND dedupe_key = $2`,
        [input.meetingId, roundDedupeKey],
      );
      if (existingRound.rows[0] !== undefined) {
        const turns = await client.query<MeetingAiTurnRow>(
          `${TURN_SELECT}
           WHERE turn.round_id = $1
           ORDER BY agent.name`,
          [existingRound.rows[0].id],
        );
        return {
          policy,
          outcome: "reused",
          roundNumber: turns.rows[0]?.round_number ?? null,
          turns: turns.rows.map(turnSummaryFromRow),
          skipped: [],
        };
      }

      const participants = await client.query<
        ParticipantRow & {
          global_agent_status: "active" | "disabled";
          project_member_status: "active" | "inactive";
        }
      >(
        `SELECT
           participant.agent_id,
           agent.name AS agent_name,
           participant.status,
           agent.status AS global_agent_status,
           COALESCE(member.status, 'inactive') AS project_member_status
         FROM meeting_ai_participants AS participant
         JOIN agents AS agent ON agent.id = participant.agent_id
         LEFT JOIN project_members AS member
           ON member.project_id = participant.project_id
          AND member.kind = 'agent'
          AND member.actor_id = participant.agent_id::text
         WHERE participant.meeting_id = $1
           AND (
             $2::uuid[] = '{}'::uuid[]
             OR participant.agent_id = ANY($2::uuid[])
           )
         ORDER BY participant.joined_at, agent.name`,
        [input.meetingId, input.trigger.agentIds],
      );
      if (
        input.trigger.agentIds.length > 0 &&
        participants.rows.length !== input.trigger.agentIds.length
      ) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_agent_not_participant",
          "Every triggered agent must be a meeting participant",
        );
      }
      const skipped: Array<{
        agentId: string;
        agentName: string;
        reason: string;
      }> = [];
      const eligible: ParticipantRow[] = [];
      for (const participant of participants.rows) {
        if (participant.status !== "active") {
          skipped.push({
            agentId: participant.agent_id,
            agentName: participant.agent_name,
            reason: "participant_paused",
          });
          continue;
        }
        if (participant.global_agent_status !== "active") {
          skipped.push({
            agentId: participant.agent_id,
            agentName: participant.agent_name,
            reason: "agent_disabled",
          });
          continue;
        }
        if (participant.project_member_status !== "active") {
          skipped.push({
            agentId: participant.agent_id,
            agentName: participant.agent_name,
            reason: "project_member_inactive",
          });
          continue;
        }
        if (policy.cooldownSeconds > 0) {
          const recent = await client.query<{ cooling_down: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM meeting_ai_turns
               WHERE meeting_id = $1
                 AND agent_id = $2
                 AND created_at > NOW() - ($3 || ' seconds')::interval
             ) AS cooling_down`,
            [input.meetingId, participant.agent_id, policy.cooldownSeconds],
          );
          if (recent.rows[0]?.cooling_down === true) {
            skipped.push({
              agentId: participant.agent_id,
              agentName: participant.agent_name,
              reason: "cooldown_active",
            });
            continue;
          }
        }
        eligible.push(participant);
      }
      if (eligible.length === 0) {
        if (skipped.length === 0) {
          throw new MeetingAiPreconditionError(
            "meeting_ai_no_participants",
            "The meeting has no eligible AI participants",
          );
        }
        return {
          policy,
          outcome: "skipped",
          roundNumber: null,
          turns: [],
          skipped,
        };
      }
      if (policy.stats.remainingRounds <= 0) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_max_rounds",
          "The meeting AI round budget is exhausted",
        );
      }
      const remainingMessages = policy.stats.remainingMessages;
      if (remainingMessages <= 0) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_max_messages",
          "The meeting AI message budget is exhausted",
        );
      }
      const selected = eligible.slice(0, remainingMessages);
      for (const participant of eligible.slice(remainingMessages)) {
        skipped.push({
          agentId: participant.agent_id,
          agentName: participant.agent_name,
          reason: "max_messages",
        });
      }
      const nextRoundResult = await client.query<{ next_round: number }>(
        `SELECT COALESCE(MAX(round_number), 0) + 1 AS next_round
         FROM meeting_ai_rounds
         WHERE meeting_id = $1`,
        [input.meetingId],
      );
      const roundNumber =
        input.trigger.kind === "round" &&
        input.trigger.roundNumber !== undefined
          ? input.trigger.roundNumber
          : Number(nextRoundResult.rows[0]!.next_round);
      const roundId = randomUUID();
      const triggerReason =
        input.trigger.reason.trim() === ""
          ? {
              mention:
                "A meeting participant explicitly mentioned this AI teammate",
              round: `Fixed meeting round ${roundNumber}`,
              agenda: `Agenda node: ${input.trigger.agendaItem ?? ""}`,
              summary: "Deterministic meeting summary preparation",
            }[input.trigger.kind]
          : input.trigger.reason.trim();
      await client.query(
        `INSERT INTO meeting_ai_rounds (
           id, meeting_id, project_id, round_number, trigger_kind,
           trigger_reason, source_message_id, agenda_item, dedupe_key,
           created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()
         )`,
        [
          roundId,
          input.meetingId,
          input.projectId,
          roundNumber,
          input.trigger.kind,
          triggerReason,
          input.trigger.sourceMessageId ?? null,
          input.trigger.agendaItem ?? null,
          roundDedupeKey,
        ],
      );
      const queuedTurns: MeetingAiTurnRow[] = [];
      for (const participant of selected) {
        const turnId = randomUUID();
        const runId = randomUUID();
        const turnDedupeKey = `${roundDedupeKey}:${participant.agent_id}`;
        const trace = createRootTraceContext();
        const inputSnapshot: RunInputSnapshot = {
          taskTitle: "Meeting AI participation",
          taskDescription: triggerReason,
          acceptance: [],
          instruction: triggerReason,
          agentName: participant.agent_name,
          runtimeKind: "fake",
          meeting: {
            meetingId: input.meetingId,
            turnId,
            triggerKind: input.trigger.kind,
            triggerReason,
            agendaItem: input.trigger.agendaItem ?? null,
          },
        };
        await client.query(
          `INSERT INTO meeting_ai_turns (
             id, round_id, meeting_id, project_id, agent_id, policy_id,
             policy_revision, trigger_kind, trigger_reason,
             source_message_id, agenda_item, dedupe_key, status,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             'queued', NOW(), NOW()
           )`,
          [
            turnId,
            roundId,
            input.meetingId,
            input.projectId,
            participant.agent_id,
            policy.id,
            policy.revision,
            input.trigger.kind,
            triggerReason,
            input.trigger.sourceMessageId ?? null,
            input.trigger.agendaItem ?? null,
            turnDedupeKey,
          ],
        );
        const runtime = await client.query<{ runtime_kind: string }>(
          "SELECT runtime_kind FROM agents WHERE id = $1",
          [participant.agent_id],
        );
        const runtimeKind = runtime.rows[0]?.runtime_kind ?? "fake";
        inputSnapshot.runtimeKind =
          runtimeKind as RunInputSnapshot["runtimeKind"];
        const executionSnapshot =
          await input.resolveExternalExecution?.({
            agentId: participant.agent_id,
            turnId,
            projectId: input.projectId,
          });
        if (
          (runtimeKind === "codex-jsonl" || runtimeKind === "plain-text") &&
          executionSnapshot === undefined
        ) {
          throw new MeetingAiPreconditionError(
            "runtime_binding_missing",
            "The AI participant has no prepared external runtime execution",
          );
        }
        const run = await client.query(
          `INSERT INTO runs (
             id, project_id, task_id, meeting_turn_id, agent_id, status,
             input_snapshot, execution_snapshot, external_runtime_id,
             external_runtime_revision, external_runtime_provider,
             external_runtime_protocol, observability, attempt, timeout_at,
             idempotency_key, trace_id, trace_root_span_id,
             created_at, updated_at
           ) VALUES (
             $1, $2, NULL, $3, $4, 'queued', $5::jsonb, $6::jsonb,
             $7, $8, $9, $10, $11::jsonb, 1, NULL, $12, $13, $14,
             NOW(), NOW()
           )`,
          [
            runId,
            input.projectId,
            turnId,
            participant.agent_id,
            JSON.stringify(inputSnapshot),
            executionSnapshot === undefined
              ? null
              : JSON.stringify(executionSnapshot),
            executionSnapshot?.runtime.id ?? null,
            executionSnapshot?.runtime.revision ?? null,
            executionSnapshot?.runtime.provider ?? null,
            executionSnapshot?.runtime.protocol ?? null,
            JSON.stringify({
              planVisibility:
                executionSnapshot?.runtime.protocol === "codex-jsonl"
                  ? "summary"
                  : executionSnapshot === undefined
                    ? "summary"
                    : "opaque",
              toolEventCompleteness:
                executionSnapshot?.runtime.protocol === "codex-jsonl"
                  ? "partial"
                  : executionSnapshot === undefined
                    ? "partial"
                    : "none",
              textStreaming:
                executionSnapshot?.runtime.protocol === "plain-text"
                  ? "final-only"
                  : "message",
              subagentVisibility: "none",
            }),
            `meeting-ai:${turnId}`,
            trace.traceId,
            trace.spanId,
          ],
        );
        if (run.rowCount !== 1)
          throw new Error("meeting AI run was not created");
        await client.query(
          "UPDATE meeting_ai_turns SET run_id = $2 WHERE id = $1",
          [turnId, runId],
        );
        await client.query(
          `INSERT INTO jobs (
             id, run_id, kind, status, available_at, max_attempts, trace_id,
             created_at, updated_at
           ) VALUES (
             $1, $2, 'agent.run', 'queued', NOW(), 3, $3, NOW(), NOW()
           )`,
          [randomUUID(), runId, trace.traceId],
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
            "Meeting AI turn is queued",
            JSON.stringify({
              meetingId: input.meetingId,
              turnId,
              triggerKind: input.trigger.kind,
              roundNumber,
            }),
            trace.traceId,
            newSpanId(),
            trace.spanId,
          ],
        );
        await client.query(
          `INSERT INTO domain_outbox (
             id, topic, payload, status, created_at
           ) VALUES (
             $1, 'meeting.ai.speak', $2::jsonb, 'pending', NOW()
           )`,
          [
            randomUUID(),
            JSON.stringify({
              meetingId: input.meetingId,
              projectId: input.projectId,
              turnId,
              runId,
              agentId: participant.agent_id,
              triggerKind: input.trigger.kind,
              roundNumber,
              traceId: trace.traceId,
            }),
          ],
        );
        queuedTurns.push({
          id: turnId,
          round_id: roundId,
          round_number: roundNumber,
          meeting_id: input.meetingId,
          project_id: input.projectId,
          agent_id: participant.agent_id,
          agent_name: participant.agent_name,
          policy_id: policy.id,
          policy_revision: policy.revision,
          trigger_kind: input.trigger.kind,
          trigger_reason: triggerReason,
          source_message_id: input.trigger.sourceMessageId ?? null,
          agenda_item: input.trigger.agendaItem ?? null,
          dedupe_key: turnDedupeKey,
          status: "queued",
          run_id: runId,
          message_id: null,
          error_code: null,
          error_message: null,
          started_at: null,
          completed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
      const refreshedPolicy = await client.query<MeetingAiPolicyRow>(
        `${POLICY_SELECT} WHERE policy.meeting_id = $1`,
        [input.meetingId],
      );
      return {
        policy: policyFromRow(refreshedPolicy.rows[0]!),
        outcome: "queued",
        roundNumber,
        turns: queuedTurns.map(turnSummaryFromRow),
        skipped,
      };
    });
  }

  async getRunContext(runId: string): Promise<MeetingAiRunContext | undefined> {
    const result = await this.database.query<
      MeetingAiTurnRow & {
        meeting_title: string;
        meeting_agenda: string;
        meeting_status: "open" | "closed";
      }
    >(
      `SELECT
         turn.*,
         round.round_number,
         agent.name AS agent_name,
         meeting.title AS meeting_title,
         meeting.agenda AS meeting_agenda,
         meeting.status AS meeting_status
       ${TURN_FROM}
       JOIN meetings AS meeting ON meeting.id = turn.meeting_id
       WHERE turn.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const messages = await this.database.query<{
      author_name: string;
      author_type: "human" | "agent";
      content: string;
    }>(
      `SELECT author_name, author_type, content
       FROM meeting_messages
       WHERE meeting_id = $1 AND status = 'sent'
       ORDER BY created_at DESC, id DESC
       LIMIT 30`,
      [row.meeting_id],
    );
    return {
      turn: turnFromRow(row),
      meeting: {
        id: row.meeting_id,
        title: row.meeting_title,
        agenda: row.meeting_agenda,
        status: row.meeting_status,
      },
      messages: messages.rows.reverse().map((message) => ({
        authorName: message.author_name,
        authorType: message.author_type,
        content: message.content,
      })),
    };
  }

  async prepareRun(runId: string): Promise<MeetingAiRunContext> {
    return this.database.transaction(async (client) => {
      const result = await client.query<
        MeetingAiTurnRow & {
          meeting_title: string;
          meeting_agenda: string;
          meeting_status: "open" | "closed";
          project_status: "active" | "archived";
          policy_status: MeetingAiPolicyStatus;
          policy_triggers: MeetingAiTriggerKind[];
          run_budget_ms: number;
          agent_status: "active" | "disabled";
          member_status: "active" | "inactive";
        }
      >(
        `SELECT
           turn.*,
           round.round_number,
           agent.name AS agent_name,
           meeting.title AS meeting_title,
           meeting.agenda AS meeting_agenda,
           meeting.status AS meeting_status,
           project.status AS project_status,
           policy.status AS policy_status,
           policy.trigger_kinds AS policy_triggers,
          policy.run_budget_ms AS run_budget_ms,
           agent.status AS agent_status,
           member.status AS member_status
         ${TURN_FROM}
         JOIN meetings AS meeting ON meeting.id = turn.meeting_id
         JOIN projects AS project ON project.id = turn.project_id
         JOIN meeting_ai_policies AS policy ON policy.id = turn.policy_id
         LEFT JOIN project_members AS member
           ON member.project_id = turn.project_id
          AND member.kind = 'agent'
          AND member.actor_id = turn.agent_id::text
         WHERE turn.run_id = $1
         FOR UPDATE OF turn`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_turn_not_found",
          "Meeting AI turn not found",
        );
      }
      if (row.status === "completed") {
        return {
          turn: turnFromRow(row),
          meeting: {
            id: row.meeting_id,
            title: row.meeting_title,
            agenda: row.meeting_agenda,
            status: row.meeting_status,
          },
          messages: [],
        };
      }
      if (row.status === "cancelled" || row.status === "failed") {
        throw new MeetingAiPreconditionError(
          "meeting_ai_turn_terminal",
          `Meeting AI turn is ${row.status}`,
        );
      }
      if (row.meeting_status !== "open") {
        throw new MeetingAiPreconditionError(
          "meeting_closed",
          "A closed meeting cannot continue AI participation",
        );
      }
      if (row.project_status !== "active") {
        throw new MeetingAiPreconditionError(
          "project_archived",
          "An archived project cannot continue AI participation",
        );
      }
      if (row.policy_status !== "active") {
        throw new MeetingAiPreconditionError(
          row.policy_status === "terminated"
            ? "meeting_ai_terminated"
            : "meeting_ai_paused",
          `Meeting AI participation is ${row.policy_status}`,
        );
      }
      if (!row.policy_triggers.includes(row.trigger_kind)) {
        throw new MeetingAiPreconditionError(
          "meeting_ai_trigger_disabled",
          "The meeting AI trigger is no longer enabled",
        );
      }
      if (row.agent_status !== "active") {
        throw new MeetingAiPreconditionError(
          "agent_disabled",
          "The AI participant is disabled",
        );
      }
      if (row.member_status !== "active") {
        throw new MeetingAiPreconditionError(
          "project_member_inactive",
          "The AI participant is not an active project member",
        );
      }
      await client.query(
        `UPDATE meeting_ai_turns
         SET status = 'running', started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1 AND status = 'queued'`,
        [row.id],
      );
      await client.query(
        `UPDATE runs
         SET timeout_at = NOW() + ($2 || ' milliseconds')::interval,
             updated_at = NOW()
         WHERE id = $1 AND timeout_at IS NULL`,
        [runId, row.run_budget_ms],
      );
      return {
        turn: turnFromRow(row),
        meeting: {
          id: row.meeting_id,
          title: row.meeting_title,
          agenda: row.meeting_agenda,
          status: row.meeting_status,
        },
        messages: [],
      };
    });
  }

  async completeTurn(runId: string, output: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.completeTurnWithClient(client, runId, output);
    });
  }

  async failTurn(runId: string, code: string, message: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await failMeetingTurnWithClient(client, runId, code, message);
    });
  }

  async cancelOpenRuns(meetingId: string, reason: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.cancelOpenRunsWithClient(client, meetingId, reason);
    });
  }

  async cancelAgentOpenRuns(agentId: string, reason: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const runs = await client.query<{
        run_id: string;
        turn_id: string;
        meeting_id: string;
      }>(
        `SELECT run_id, id AS turn_id, meeting_id
         FROM meeting_ai_turns
         WHERE agent_id = $1
           AND status IN ('queued', 'running')
           AND run_id IS NOT NULL
         FOR UPDATE`,
        [agentId],
      );
      for (const run of runs.rows) {
        await client.query(
          `UPDATE runs
           SET status = 'cancelled', error = $2, ended_at = NOW(),
               updated_at = NOW()
           WHERE id = $1 AND status IN ('queued', 'running')`,
          [run.run_id, reason.slice(0, 2_000)],
        );
        await client.query(
          `UPDATE jobs
           SET status = 'cancelled', last_error = $2, updated_at = NOW()
           WHERE run_id = $1 AND status IN ('queued', 'running')`,
          [run.run_id, reason.slice(0, 4_000)],
        );
      }
      await client.query(
        `UPDATE meeting_ai_turns
         SET status = 'cancelled', error_code = 'agent_unavailable',
             error_message = $2, completed_at = NOW(), updated_at = NOW()
         WHERE agent_id = $1 AND status IN ('queued', 'running')`,
        [agentId, reason.slice(0, 2_000)],
      );
      await client.query(
        `UPDATE meeting_ai_policies AS policy
         SET last_error_code = 'agent_unavailable',
             last_error_message = $2,
             last_error_at = NOW(),
             updated_at = NOW()
         WHERE policy.meeting_id = ANY(
           SELECT DISTINCT meeting_id
           FROM meeting_ai_turns
           WHERE agent_id = $1
         )`,
        [agentId, reason.slice(0, 2_000)],
      );
    });
  }

  private async getPolicyById(
    id: string,
  ): Promise<MeetingAiPolicy | undefined> {
    const result = await this.database.query<MeetingAiPolicyRow>(
      `${POLICY_SELECT} WHERE policy.id = $1`,
      [id],
    );
    return result.rows[0] === undefined
      ? undefined
      : policyFromRow(result.rows[0]);
  }

  private async cancelOpenRunsWithClient(
    client: PoolClient,
    meetingId: string,
    reason: string,
  ): Promise<void> {
    const runs = await client.query<{ run_id: string }>(
      `SELECT run_id
       FROM meeting_ai_turns
       WHERE meeting_id = $1
         AND status IN ('queued', 'running')
         AND run_id IS NOT NULL
       FOR UPDATE`,
      [meetingId],
    );
    for (const run of runs.rows) {
      await client.query(
        `UPDATE runs
         SET status = 'cancelled', error = $2, ended_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [run.run_id, reason.slice(0, 2_000)],
      );
      await client.query(
        `UPDATE jobs
         SET status = 'cancelled', last_error = $2, updated_at = NOW()
         WHERE run_id = $1 AND status IN ('queued', 'running')`,
        [run.run_id, reason.slice(0, 4_000)],
      );
      await client.query(
        `UPDATE runtime_effect_receipts
         SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
             updated_at = NOW()
         WHERE run_id = $1 AND status = 'running'`,
        [run.run_id],
      );
    }
    await client.query(
      `UPDATE meeting_ai_turns
       SET status = 'cancelled', error_code = 'meeting_ai_cancelled',
           error_message = $2, completed_at = NOW(), updated_at = NOW()
       WHERE meeting_id = $1 AND status IN ('queued', 'running')`,
      [meetingId, reason.slice(0, 2_000)],
    );
  }

  private async completeTurnWithClient(
    client: PoolClient,
    runId: string,
    output: string,
  ): Promise<void> {
    const result = await client.query<
      MeetingAiTurnRow & {
        trace_id: string | null;
        agent_name: string;
      }
    >(
      `SELECT
         turn.*,
         round.round_number,
         agent.name AS agent_name,
         run.trace_id
       ${TURN_FROM}
       JOIN runs AS run ON run.id = turn.run_id
       WHERE turn.run_id = $1
       FOR UPDATE OF turn`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return;
    if (row.message_id !== null) {
      await client.query(
        `UPDATE meeting_ai_turns
         SET status = 'completed', error_code = NULL, error_message = NULL,
             completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      return;
    }
    const content = output.trim();
    if (content === "") {
      await failMeetingTurnWithClient(
        client,
        runId,
        "meeting_ai_empty_output",
        "The Agent returned an empty meeting message",
      );
      return;
    }
    const messageId = randomUUID();
    await client.query(
      `INSERT INTO meeting_messages (
         id, meeting_id, author_type, author_id, author_name, content,
         turn_id, policy_id, policy_revision, trigger_kind, trigger_reason,
         run_id, trace_id, status, created_at
       ) VALUES (
         $1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         'sent', NOW()
       )
       ON CONFLICT (turn_id) WHERE turn_id IS NOT NULL DO NOTHING`,
      [
        messageId,
        row.meeting_id,
        row.agent_id,
        row.agent_name,
        content,
        row.id,
        row.policy_id,
        row.policy_revision,
        row.trigger_kind,
        row.trigger_reason,
        runId,
        row.trace_id,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      "SELECT id FROM meeting_messages WHERE turn_id = $1",
      [row.id],
    );
    const persistedMessageId = inserted.rows[0]?.id;
    await client.query(
      `UPDATE meeting_ai_turns
       SET status = 'completed', message_id = $2, error_code = NULL,
           error_message = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.id, persistedMessageId ?? null],
    );
    await client.query("UPDATE meetings SET updated_at = NOW() WHERE id = $1", [
      row.meeting_id,
    ]);
    await client.query(
      `UPDATE meeting_ai_policies
       SET last_error_code = NULL, last_error_message = NULL,
           last_error_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [row.policy_id],
    );
  }
}

export async function failMeetingTurnWithClient(
  client: PoolClient,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  const result = await client.query<
    MeetingAiTurnRow & {
      trace_id: string | null;
    }
  >(
    `SELECT
       turn.*,
       round.round_number,
       agent.name AS agent_name,
       run.trace_id
     ${TURN_FROM}
     JOIN runs AS run ON run.id = turn.run_id
     WHERE turn.run_id = $1
     FOR UPDATE OF turn`,
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined || row.status === "completed") return;
  const safeMessage = message.slice(0, 2_000);
  const safeCode = code.slice(0, 180);
  if (row.message_id === null) {
    const messageId = randomUUID();
    await client.query(
      `INSERT INTO meeting_messages (
         id, meeting_id, author_type, author_id, author_name, content,
         turn_id, policy_id, policy_revision, trigger_kind, trigger_reason,
         run_id, trace_id, status, error_code, error_message, created_at
       ) VALUES (
         $1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         'failed', $13, $14, NOW()
       )
       ON CONFLICT (turn_id) WHERE turn_id IS NOT NULL DO NOTHING`,
      [
        messageId,
        row.meeting_id,
        row.agent_id,
        row.agent_name,
        `自动发言失败：${safeMessage}`,
        row.id,
        row.policy_id,
        row.policy_revision,
        row.trigger_kind,
        row.trigger_reason,
        runId,
        row.trace_id,
        safeCode,
        safeMessage,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      "SELECT id FROM meeting_messages WHERE turn_id = $1",
      [row.id],
    );
    await client.query(
      `UPDATE meeting_ai_turns
       SET status = 'failed', message_id = $2, error_code = $3,
           error_message = $4, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.id, inserted.rows[0]?.id ?? null, safeCode, safeMessage],
    );
  } else {
    await client.query(
      `UPDATE meeting_ai_turns
       SET status = 'failed', error_code = $2, error_message = $3,
           completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status <> 'completed'`,
      [row.id, safeCode, safeMessage],
    );
  }
  await client.query(
    `UPDATE meeting_ai_policies
     SET last_error_code = $2, last_error_message = $3,
         last_error_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [row.policy_id, safeCode, safeMessage],
  );
  await client.query("UPDATE meetings SET updated_at = NOW() WHERE id = $1", [
    row.meeting_id,
  ]);
}
