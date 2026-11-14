import { createHash, randomUUID } from "node:crypto";
import type {
  CreateDelegationConfirmationInput,
  CreateDelegationInput,
  Delegation,
  DelegationAction,
  DelegationConfirmationRequest,
  DelegationEvent,
  DelegationNotification,
  DelegationReport,
  DelegationRun,
  DelegationStatus,
  ExtendDelegationInput,
  UpdateDelegationInput,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface DelegationRow {
  id: string;
  owner_principal_id: string;
  owner_display_name: string;
  representative_principal_id: string;
  representative_display_name: string;
  representative_kind: Delegation["representativeKind"];
  representative_agent_id: string | null;
  workspace_id: string;
  project_id: string | null;
  context_type: Delegation["contextType"];
  context_id: string;
  display_name: string;
  objective: string;
  stance: string;
  watch_items: string[];
  material_scopes: string[];
  allowed_actions: DelegationAction[];
  denied_actions: DelegationAction[];
  approval_policy: Delegation["approvalPolicy"];
  auto_participation: Delegation["autoParticipation"];
  status: DelegationStatus;
  expires_at: Date;
  report_required: boolean;
  revision: number;
  last_failure: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
  paused_at: Date | null;
  completed_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}

interface DelegationEventRow {
  id: string;
  delegation_id: string;
  kind: DelegationEvent["kind"];
  actor_principal_id: string;
  before_revision: number;
  after_revision: number;
  reason: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}

interface DelegationReportRow {
  delegation_id: string;
  status: DelegationReport["status"];
  summary: string;
  key_process: string[];
  positions: string[];
  risks: string[];
  open_questions: string[];
  next_steps: string[];
  information_gaps: string[];
  source_event_cursor: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  generated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DelegationRunRow {
  delegation_id: string;
  run_id: string;
  scene_session_id: string | null;
  ticket_id: string | null;
  status: DelegationRun["status"];
  started_at: Date | null;
  ended_at: Date | null;
}

interface DelegationNotificationRow {
  id: string;
  owner_principal_id: string;
  delegation_id: string;
  kind: DelegationNotification["kind"];
  dedupe_key: string;
  status: DelegationNotification["status"];
  due_at: Date;
  created_at: Date;
}

interface DelegationConfirmationRow {
  id: string;
  delegation_id: string;
  owner_principal_id: string;
  representative_principal_id: string;
  action: DelegationConfirmationRequest["action"];
  target_type: string;
  target_id: string;
  proposed_payload_hash: string;
  status: DelegationConfirmationRequest["status"];
  decided_by_principal_id: string | null;
  decision_reason: string | null;
  expires_at: Date;
  decided_at: Date | null;
  created_at: Date;
}

const DELEGATION_SELECT = `
  SELECT
    delegation.*,
    owner.display_name AS owner_display_name,
    representative.display_name AS representative_display_name
  FROM delegations AS delegation
  JOIN principals AS owner ON owner.id = delegation.owner_principal_id
  JOIN principals AS representative
    ON representative.id = delegation.representative_principal_id
`;

function arrayValue(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",")}}`;
}

function delegationFromRow(row: DelegationRow): Delegation {
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    ownerDisplayName: row.owner_display_name,
    representativePrincipalId: row.representative_principal_id,
    representativeDisplayName: row.representative_display_name,
    representativeKind: row.representative_kind,
    representativeAgentId: row.representative_agent_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    contextType: row.context_type,
    contextId: row.context_id,
    displayName: row.display_name,
    objective: row.objective,
    stance: row.stance,
    watchItems: row.watch_items,
    materialScopes: row.material_scopes,
    allowedActions: row.allowed_actions,
    deniedActions: row.denied_actions,
    approvalPolicy: row.approval_policy,
    autoParticipation: row.auto_participation,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    reportRequired: row.report_required,
    revision: row.revision,
    lastFailure: row.last_failure,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    activatedAt: row.activated_at?.toISOString() ?? null,
    pausedAt: row.paused_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
  };
}

function eventFromRow(row: DelegationEventRow): DelegationEvent {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    kind: row.kind,
    actorPrincipalId: row.actor_principal_id,
    beforeRevision: row.before_revision,
    afterRevision: row.after_revision,
    reason: row.reason,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

function reportFromRow(row: DelegationReportRow): DelegationReport {
  return {
    id: row.delegation_id,
    delegationId: row.delegation_id,
    status: row.status,
    summary: row.summary,
    keyProcess: row.key_process,
    positions: row.positions,
    risks: row.risks,
    openQuestions: row.open_questions,
    nextSteps: row.next_steps,
    informationGaps: row.information_gaps,
    sourceEventCursor: Number(row.source_event_cursor),
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    generatedAt: row.generated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function runFromRow(row: DelegationRunRow): DelegationRun {
  return {
    delegationId: row.delegation_id,
    runId: row.run_id,
    sceneSessionId: row.scene_session_id,
    ticketId: row.ticket_id,
    status: row.status,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

function notificationFromRow(
  row: DelegationNotificationRow,
): DelegationNotification {
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    delegationId: row.delegation_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    status: row.status,
    dueAt: row.due_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function confirmationFromRow(
  row: DelegationConfirmationRow,
): DelegationConfirmationRequest {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    ownerPrincipalId: row.owner_principal_id,
    representativePrincipalId: row.representative_principal_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    proposedPayloadHash: row.proposed_payload_hash,
    status: row.status,
    decidedByPrincipalId: row.decided_by_principal_id,
    decisionReason: row.decision_reason,
    expiresAt: row.expires_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function delegationContextHash(
  delegation: Pick<
    Delegation,
    | "id"
    | "revision"
    | "ownerPrincipalId"
    | "representativePrincipalId"
    | "projectId"
    | "contextType"
    | "contextId"
    | "allowedActions"
    | "deniedActions"
  >,
): string {
  const value = {
    id: delegation.id,
    revision: delegation.revision,
    ownerPrincipalId: delegation.ownerPrincipalId,
    representativePrincipalId: delegation.representativePrincipalId,
    projectId: delegation.projectId,
    contextType: delegation.contextType,
    contextId: delegation.contextId,
    allowedActions: [...delegation.allowedActions].sort(),
    deniedActions: [...delegation.deniedActions].sort(),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type DelegationTransitionResult =
  | { readonly kind: "updated"; readonly delegation: Delegation }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly kind: "invalid_transition";
      readonly from: DelegationStatus;
    };

export class DelegationRepository {
  constructor(
    private readonly database: Database,
    private readonly options: { readonly now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async listForPrincipal(principalId: string): Promise<Delegation[]> {
    await this.expireDue();
    const result = await this.database.query<DelegationRow>(
      `${DELEGATION_SELECT}
       WHERE delegation.owner_principal_id = $1
          OR delegation.representative_principal_id = $1
       ORDER BY
         CASE delegation.status
           WHEN 'active' THEN 0
           WHEN 'paused' THEN 1
           WHEN 'draft' THEN 2
           ELSE 3
         END,
         delegation.expires_at,
         delegation.updated_at DESC`,
      [principalId],
    );
    return result.rows.map(delegationFromRow);
  }

  async get(id: string): Promise<Delegation | undefined> {
    const result = await this.database.query<DelegationRow>(
      `${DELEGATION_SELECT} WHERE delegation.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : delegationFromRow(row);
  }

  async getByRun(runId: string): Promise<Delegation | undefined> {
    const result = await this.database.query<DelegationRow>(
      `${DELEGATION_SELECT}
       JOIN action_tickets AS ticket
         ON ticket.delegation_id = delegation.id
       WHERE ticket.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : delegationFromRow(row);
  }

  async create(input: {
    readonly ownerPrincipalId: string;
    readonly representativePrincipalId: string;
    readonly representativeKind: Delegation["representativeKind"];
    readonly representativeAgentId: string | null;
    readonly workspaceId: string;
    readonly projectId: string | null;
    readonly actorPrincipalId: string;
    readonly value: CreateDelegationInput;
  }): Promise<Delegation> {
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO delegations (
           id, owner_principal_id, representative_principal_id,
           representative_kind, representative_agent_id, workspace_id,
           project_id, context_type, context_id, display_name, objective,
           stance, watch_items, material_scopes, allowed_actions,
           denied_actions, approval_policy, auto_participation, status,
           expires_at, report_required, revision, created_by, created_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13::jsonb, $14::jsonb, $15::text[], $16::text[],
           $17, $18, 'draft', $19, $20, 1, $21, NOW(), NOW()
         )`,
        [
          id,
          input.ownerPrincipalId,
          input.representativePrincipalId,
          input.representativeKind,
          input.representativeAgentId,
          input.workspaceId,
          input.projectId,
          input.value.contextType,
          input.value.contextId,
          input.value.displayName,
          input.value.objective,
          input.value.stance,
          JSON.stringify(input.value.watchItems),
          JSON.stringify(input.value.materialScopes),
          arrayValue(input.value.allowedActions),
          arrayValue(input.value.deniedActions),
          input.value.approvalPolicy,
          input.value.autoParticipation,
          input.value.expiresAt,
          input.value.reportRequired,
          input.actorPrincipalId,
        ],
      );
      await this.appendEventWithClient(client, {
        delegationId: id,
        kind: "created",
        actorPrincipalId: input.actorPrincipalId,
        beforeRevision: 0,
        afterRevision: 1,
        reason: null,
        data: {
          contextType: input.value.contextType,
          contextId: input.value.contextId,
          representativePrincipalId: input.representativePrincipalId,
        },
      });
      const created = await client.query<DelegationRow>(
        `${DELEGATION_SELECT} WHERE delegation.id = $1`,
        [id],
      );
      return delegationFromRow(created.rows[0]!);
    });
  }

  async update(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly value: UpdateDelegationInput;
  }): Promise<DelegationTransitionResult> {
    return this.database.transaction(async (client) => {
      const current = await this.lockWithClient(client, input.id);
      if (current === undefined) return { kind: "not_found" as const };
      if (current.revision !== input.value.expectedRevision) {
        return {
          kind: "revision_conflict" as const,
          currentRevision: current.revision,
        };
      }
      if (!["draft", "active", "paused"].includes(current.status)) {
        return {
          kind: "invalid_transition" as const,
          from: current.status,
        };
      }
      const updated = await client.query<DelegationRow>(
        `UPDATE delegations AS delegation
         SET
           display_name = COALESCE($3, display_name),
           objective = COALESCE($4, objective),
           stance = COALESCE($5, stance),
           watch_items = COALESCE($6::jsonb, watch_items),
           material_scopes = COALESCE($7::jsonb, material_scopes),
           allowed_actions = COALESCE($8::text[], allowed_actions),
           denied_actions = COALESCE($9::text[], denied_actions),
           approval_policy = COALESCE($10, approval_policy),
           auto_participation = COALESCE($11, auto_participation),
           expires_at = COALESCE($12, expires_at),
           report_required = COALESCE($13, report_required),
           revision = revision + 1,
           updated_at = NOW()
         WHERE delegation.id = $1 AND delegation.revision = $2
         RETURNING delegation.*`,
        [
          input.id,
          input.value.expectedRevision,
          input.value.displayName ?? null,
          input.value.objective ?? null,
          input.value.stance ?? null,
          input.value.watchItems === undefined
            ? null
            : JSON.stringify(input.value.watchItems),
          input.value.materialScopes === undefined
            ? null
            : JSON.stringify(input.value.materialScopes),
          input.value.allowedActions === undefined
            ? null
            : arrayValue(input.value.allowedActions),
          input.value.deniedActions === undefined
            ? null
            : arrayValue(input.value.deniedActions),
          input.value.approvalPolicy ?? null,
          input.value.autoParticipation ?? null,
          input.value.expiresAt ?? null,
          input.value.reportRequired ?? null,
        ],
      );
      if (updated.rows[0] === undefined) {
        return {
          kind: "revision_conflict" as const,
          currentRevision: current.revision,
        };
      }
      await this.appendEventWithClient(client, {
        delegationId: input.id,
        kind: "updated",
        actorPrincipalId: input.actorPrincipalId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: null,
        data: { fields: Object.keys(input.value) },
      });
      return {
        kind: "updated" as const,
        delegation: await this.requireWithClient(client, input.id),
      };
    });
  }

  async activate(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DelegationTransitionResult> {
    return this.transition({
      ...input,
      to: "active",
      event: "activated",
    });
  }

  async pause(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DelegationTransitionResult> {
    return this.transition({ ...input, to: "paused", event: "paused" });
  }

  async resume(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DelegationTransitionResult> {
    return this.transition({ ...input, to: "active", event: "resumed" });
  }

  async complete(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DelegationTransitionResult> {
    return this.transition({
      ...input,
      to: "completed",
      event: "completed",
    });
  }

  async revoke(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DelegationTransitionResult> {
    return this.transition({ ...input, to: "revoked", event: "revoked" });
  }

  async extend(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly value: ExtendDelegationInput;
  }): Promise<DelegationTransitionResult> {
    return this.database.transaction(async (client) => {
      const current = await this.lockWithClient(client, input.id);
      if (current === undefined) return { kind: "not_found" as const };
      if (current.revision !== input.value.expectedRevision) {
        return {
          kind: "revision_conflict" as const,
          currentRevision: current.revision,
        };
      }
      if (!["active", "paused"].includes(current.status)) {
        return {
          kind: "invalid_transition" as const,
          from: current.status,
        };
      }
      const expiresAt = new Date(input.value.expiresAt);
      if (expiresAt.getTime() <= current.expires_at.getTime()) {
        return {
          kind: "invalid_transition" as const,
          from: current.status,
        };
      }
      await client.query(
        `UPDATE delegations
         SET expires_at = $2, revision = revision + 1, updated_at = NOW()
         WHERE id = $1 AND revision = $3`,
        [input.id, expiresAt, input.value.expectedRevision],
      );
      await this.appendEventWithClient(client, {
        delegationId: input.id,
        kind: "extended",
        actorPrincipalId: input.actorPrincipalId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.value.reason,
        data: {
          previousExpiresAt: current.expires_at.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      return {
        kind: "updated" as const,
        delegation: await this.requireWithClient(client, input.id),
      };
    });
  }

  async events(id: string): Promise<DelegationEvent[]> {
    const result = await this.database.query<DelegationEventRow>(
      `SELECT * FROM delegation_events
       WHERE delegation_id = $1
       ORDER BY seq DESC`,
      [id],
    );
    return result.rows.map(eventFromRow);
  }

  async runs(id: string): Promise<DelegationRun[]> {
    const result = await this.database.query<DelegationRunRow>(
      `SELECT
         association.delegation_id,
         association.run_id,
         association.scene_session_id,
         association.ticket_id,
         run.status,
         association.started_at,
         association.ended_at
       FROM delegation_runs AS association
       JOIN runs AS run ON run.id = association.run_id
       WHERE association.delegation_id = $1
       ORDER BY association.created_at DESC`,
      [id],
    );
    return result.rows.map(runFromRow);
  }

  async attachRun(input: {
    readonly delegationId: string;
    readonly runId: string;
    readonly ticketId: string | null;
    readonly status: DelegationRun["status"];
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO delegation_runs (
           delegation_id, run_id, ticket_id, status, started_at,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
         ON CONFLICT (delegation_id, run_id) DO NOTHING`,
        [input.delegationId, input.runId, input.ticketId, input.status],
      );
      await this.appendEventWithClient(client, {
        delegationId: input.delegationId,
        kind: "run_started",
        actorPrincipalId: "system:delegation",
        beforeRevision: 0,
        afterRevision: 0,
        reason: null,
        data: { runId: input.runId, ticketId: input.ticketId },
      });
    });
  }

  async confirmations(
    delegationId: string,
  ): Promise<DelegationConfirmationRequest[]> {
    await this.expireConfirmations();
    const result = await this.database.query<DelegationConfirmationRow>(
      `SELECT * FROM delegation_confirmation_requests
       WHERE delegation_id = $1
       ORDER BY created_at DESC`,
      [delegationId],
    );
    return result.rows.map(confirmationFromRow);
  }

  async createConfirmation(input: {
    readonly delegation: Delegation;
    readonly value: CreateDelegationConfirmationInput;
  }): Promise<DelegationConfirmationRequest> {
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO delegation_confirmation_requests (
           id, delegation_id, owner_principal_id,
           representative_principal_id, action, target_type, target_id,
           proposed_payload_hash, status, expires_at, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NOW()
         )`,
        [
          id,
          input.delegation.id,
          input.delegation.ownerPrincipalId,
          input.delegation.representativePrincipalId,
          input.value.action,
          input.value.targetType,
          input.value.targetId,
          input.value.proposedPayloadHash,
          input.value.expiresAt,
        ],
      );
      await this.appendEventWithClient(client, {
        delegationId: input.delegation.id,
        kind: "confirmation_requested",
        actorPrincipalId: input.delegation.representativePrincipalId,
        beforeRevision: input.delegation.revision,
        afterRevision: input.delegation.revision,
        reason: null,
        data: { confirmationId: id, action: input.value.action },
      });
      await this.insertNotificationWithClient(client, {
        ownerPrincipalId: input.delegation.ownerPrincipalId,
        delegationId: input.delegation.id,
        kind: "confirmation_required",
        dedupeKey: `delegation:${input.delegation.id}:confirmation:${id}`,
        dueAt: this.now(),
      });
      const result = await client.query<DelegationConfirmationRow>(
        "SELECT * FROM delegation_confirmation_requests WHERE id = $1",
        [id],
      );
      return confirmationFromRow(result.rows[0]!);
    });
  }

  async decideConfirmation(input: {
    readonly delegationId: string;
    readonly requestId: string;
    readonly ownerPrincipalId: string;
    readonly decision: "approve" | "reject";
    readonly reason: string;
  }): Promise<
    | DelegationConfirmationRequest
    | { readonly kind: "not_found" | "invalid_state" | "expired" }
  > {
    return this.database.transaction(async (client) => {
      const result = await client.query<DelegationConfirmationRow>(
        `SELECT * FROM delegation_confirmation_requests
         WHERE id = $1 AND delegation_id = $2
         FOR UPDATE`,
        [input.requestId, input.delegationId],
      );
      const current = result.rows[0];
      if (
        current === undefined ||
        current.owner_principal_id !== input.ownerPrincipalId
      ) {
        return { kind: "not_found" as const };
      }
      if (current.status !== "pending") {
        return { kind: "invalid_state" as const };
      }
      if (current.expires_at.getTime() <= this.now().getTime()) {
        await client.query(
          `UPDATE delegation_confirmation_requests
           SET status = 'expired', decided_at = NOW()
           WHERE id = $1`,
          [input.requestId],
        );
        return { kind: "expired" as const };
      }
      const updated = await client.query<DelegationConfirmationRow>(
        `UPDATE delegation_confirmation_requests
         SET status = $2, decided_by_principal_id = $3,
             decision_reason = $4, decided_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          input.requestId,
          input.decision === "approve" ? "approved" : "rejected",
          input.ownerPrincipalId,
          input.reason,
        ],
      );
      await this.appendEventWithClient(client, {
        delegationId: input.delegationId,
        kind: "confirmation_decided",
        actorPrincipalId: input.ownerPrincipalId,
        beforeRevision: 0,
        afterRevision: 0,
        reason: input.reason,
        data: {
          confirmationId: input.requestId,
          decision: input.decision,
        },
      });
      return confirmationFromRow(updated.rows[0]!);
    });
  }

  async notifications(
    principalId: string,
    delegationId?: string,
  ): Promise<DelegationNotification[]> {
    const result = await this.database.query<DelegationNotificationRow>(
      `SELECT * FROM delegation_notifications
       WHERE owner_principal_id = $1
         AND ($2::uuid IS NULL OR delegation_id = $2)
       ORDER BY status, due_at, created_at DESC`,
      [principalId, delegationId ?? null],
    );
    return result.rows.map(notificationFromRow);
  }

  async report(delegationId: string): Promise<DelegationReport | undefined> {
    const result = await this.database.query<DelegationReportRow>(
      "SELECT * FROM delegation_reports WHERE delegation_id = $1",
      [delegationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : reportFromRow(row);
  }

  async ensureReport(input: {
    readonly delegationId: string;
    readonly status?: "pending" | "failed";
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }): Promise<DelegationReport> {
    const result = await this.database.query<DelegationReportRow>(
      `INSERT INTO delegation_reports (
         delegation_id, status, attempt_count, error_code, error_message,
         created_at, updated_at
       ) VALUES ($1, $2, 0, $3, $4, NOW(), NOW())
       ON CONFLICT (delegation_id) DO UPDATE
       SET
         status = CASE
           WHEN delegation_reports.status = 'ready' THEN 'ready'
           ELSE EXCLUDED.status
         END,
         error_code = CASE
           WHEN delegation_reports.status = 'ready' THEN NULL
           ELSE EXCLUDED.error_code
         END,
         error_message = CASE
           WHEN delegation_reports.status = 'ready' THEN NULL
           ELSE EXCLUDED.error_message
         END,
         updated_at = NOW()
       RETURNING *`,
      [
        input.delegationId,
        input.status ?? "pending",
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );
    return reportFromRow(result.rows[0]!);
  }

  async markReportGenerating(delegationId: string): Promise<DelegationReport> {
    const result = await this.database.query<DelegationReportRow>(
      `UPDATE delegation_reports
       SET status = 'generating', attempt_count = attempt_count + 1,
           error_code = NULL, error_message = NULL, updated_at = NOW()
       WHERE delegation_id = $1 AND status IN ('pending', 'failed')
       RETURNING *`,
      [delegationId],
    );
    const row = result.rows[0];
    if (row !== undefined) return reportFromRow(row);
    return (await this.report(delegationId))!;
  }

  async completeReport(input: {
    readonly delegationId: string;
    readonly summary: string;
    readonly keyProcess: readonly string[];
    readonly positions: readonly string[];
    readonly risks: readonly string[];
    readonly openQuestions: readonly string[];
    readonly nextSteps: readonly string[];
    readonly informationGaps: readonly string[];
    readonly sourceEventCursor: number;
  }): Promise<DelegationReport> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DelegationReportRow>(
        `UPDATE delegation_reports
         SET status = 'ready', summary = $2, key_process = $3::jsonb,
             positions = $4::jsonb, risks = $5::jsonb,
             open_questions = $6::jsonb, next_steps = $7::jsonb,
             information_gaps = $8::jsonb, source_event_cursor = $9,
             error_code = NULL, error_message = NULL,
             generated_at = NOW(), updated_at = NOW()
         WHERE delegation_id = $1
         RETURNING *`,
        [
          input.delegationId,
          input.summary,
          JSON.stringify(input.keyProcess),
          JSON.stringify(input.positions),
          JSON.stringify(input.risks),
          JSON.stringify(input.openQuestions),
          JSON.stringify(input.nextSteps),
          JSON.stringify(input.informationGaps),
          input.sourceEventCursor,
        ],
      );
      const delegation = await this.requireWithClient(
        client,
        input.delegationId,
      );
      await this.appendEventWithClient(client, {
        delegationId: input.delegationId,
        kind: "report_ready",
        actorPrincipalId: "system:delegation-report",
        beforeRevision: delegation.revision,
        afterRevision: delegation.revision,
        reason: null,
        data: { reportVersion: result.rows[0]?.attempt_count ?? 0 },
      });
      if (delegation.reportRequired) {
        await this.insertNotificationWithClient(client, {
          ownerPrincipalId: delegation.ownerPrincipalId,
          delegationId: delegation.id,
          kind: "report_ready",
          dedupeKey: `delegation:${delegation.id}:report:${result.rows[0]?.attempt_count ?? 0}`,
          dueAt: this.now(),
        });
      }
      return reportFromRow(result.rows[0]!);
    });
  }

  async failReport(input: {
    readonly delegationId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): Promise<DelegationReport> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DelegationReportRow>(
        `UPDATE delegation_reports
         SET status = 'failed', error_code = $2, error_message = $3,
             updated_at = NOW()
         WHERE delegation_id = $1
         RETURNING *`,
        [input.delegationId, input.errorCode, input.errorMessage],
      );
      const delegation = await this.requireWithClient(
        client,
        input.delegationId,
      );
      await this.appendEventWithClient(client, {
        delegationId: input.delegationId,
        kind: "report_failed",
        actorPrincipalId: "system:delegation-report",
        beforeRevision: delegation.revision,
        afterRevision: delegation.revision,
        reason: input.errorMessage,
        data: { errorCode: input.errorCode },
      });
      return reportFromRow(result.rows[0]!);
    });
  }

  async resetReportForRetry(delegationId: string): Promise<DelegationReport> {
    return this.ensureReport({ delegationId, status: "pending" });
  }

  async ticketRevoked(ticketId: string): Promise<boolean> {
    const result = await this.database.query(
      "SELECT 1 FROM delegation_ticket_revocations WHERE ticket_id = $1",
      [ticketId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async expireDue(limit = 100): Promise<Delegation[]> {
    const expired = await this.database.transaction(async (client) => {
      const due = await client.query<DelegationRow>(
        `${DELEGATION_SELECT}
         WHERE delegation.status IN ('active', 'paused')
           AND delegation.expires_at <= NOW()
         ORDER BY delegation.expires_at
         FOR UPDATE OF delegation SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      const rows: DelegationRow[] = [];
      for (const current of due.rows) {
        const updated = await client.query<DelegationRow>(
          `UPDATE delegations
           SET status = 'expired', revision = revision + 1,
               updated_at = NOW()
           WHERE id = $1 AND status IN ('active', 'paused')
           RETURNING *`,
          [current.id],
        );
        if (updated.rows[0] === undefined) continue;
        rows.push(updated.rows[0]);
        await this.appendEventWithClient(client, {
          delegationId: current.id,
          kind: "expired",
          actorPrincipalId: "system:delegation-sweep",
          beforeRevision: current.revision,
          afterRevision: current.revision + 1,
          reason: "Delegation reached its expiry",
          data: { expiresAt: current.expires_at.toISOString() },
        });
        await client.query(
          `INSERT INTO delegation_reports (
             delegation_id, status, attempt_count, created_at, updated_at
           ) VALUES ($1, 'pending', 0, NOW(), NOW())
           ON CONFLICT (delegation_id) DO NOTHING`,
          [current.id],
        );
        await this.cancelActiveRunsWithClient(client, {
          delegationId: current.id,
          actorPrincipalId: "system:delegation-sweep",
          reason: "Delegation expired",
        });
      }
      return rows;
    });
    const fullRows = await Promise.all(
      expired.map((row) => this.get(row.id)),
    );
    return fullRows.filter((row): row is Delegation => row !== undefined);
  }

  async issueExpiryNotifications(): Promise<number> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DelegationRow>(
        `${DELEGATION_SELECT}
         WHERE delegation.status IN ('active', 'paused')
           AND delegation.expires_at > NOW()
           AND delegation.expires_at <= NOW() + INTERVAL '24 hours'`,
      );
      let inserted = 0;
      for (const delegation of result.rows) {
        const hoursLeft =
          (delegation.expires_at.getTime() - this.now().getTime()) /
            (60 * 60 * 1_000) <=
          1
            ? 1
            : 24;
        const key = `delegation:${delegation.id}:expiry:${hoursLeft}h`;
        const notification = await this.insertNotificationWithClient(client, {
          ownerPrincipalId: delegation.owner_principal_id,
          delegationId: delegation.id,
          kind: "expiry_soon",
          dedupeKey: key,
          dueAt: delegation.expires_at,
        });
        if (notification) inserted += 1;
      }
      return inserted;
    });
  }

  async expireConfirmations(): Promise<number> {
    const result = await this.database.query(
      `UPDATE delegation_confirmation_requests
       SET status = 'expired', decided_at = NOW()
       WHERE status = 'pending' AND expires_at <= NOW()`,
    );
    return result.rowCount ?? 0;
  }

  async pendingReports(limit = 20): Promise<DelegationReport[]> {
    const result = await this.database.query<DelegationReportRow>(
      `SELECT report.*
       FROM delegation_reports AS report
       JOIN delegations AS delegation ON delegation.id = report.delegation_id
       WHERE report.status IN ('pending', 'failed')
         AND report.attempt_count < 5
         AND delegation.report_required = TRUE
       ORDER BY report.updated_at
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(reportFromRow);
  }

  private async transition(input: {
    readonly id: string;
    readonly actorPrincipalId: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly to: DelegationStatus;
    readonly event: DelegationEvent["kind"];
  }): Promise<DelegationTransitionResult> {
    return this.database.transaction(async (client) => {
      const current = await this.lockWithClient(client, input.id);
      if (current === undefined) return { kind: "not_found" as const };
      if (current.revision !== input.expectedRevision) {
        return {
          kind: "revision_conflict" as const,
          currentRevision: current.revision,
        };
      }
      if (!validTransition(current.status, input.to)) {
        return {
          kind: "invalid_transition" as const,
          from: current.status,
        };
      }
      if (
        input.to === "active" &&
        current.expires_at.getTime() <= this.now().getTime()
      ) {
        return {
          kind: "invalid_transition" as const,
          from: "expired",
        };
      }
      const updated = await client.query<DelegationRow>(
        `UPDATE delegations
         SET
           status = $2,
           revision = revision + 1,
           activated_at = CASE
             WHEN $2 = 'active' THEN COALESCE(activated_at, NOW())
             ELSE activated_at
           END,
           paused_at = CASE
             WHEN $2 = 'paused' THEN NOW()
             WHEN $2 = 'active' THEN NULL
             ELSE paused_at
           END,
           completed_at = CASE
             WHEN $2 = 'completed' THEN NOW()
             ELSE completed_at
           END,
           revoked_at = CASE
             WHEN $2 = 'revoked' THEN NOW()
             ELSE revoked_at
           END,
           revoked_by = CASE
             WHEN $2 = 'revoked' THEN $3
             ELSE revoked_by
           END,
           updated_at = NOW()
         WHERE id = $1 AND revision = $4
         RETURNING *`,
        [input.id, input.to, input.actorPrincipalId, input.expectedRevision],
      );
      if (updated.rows[0] === undefined) {
        return {
          kind: "revision_conflict" as const,
          currentRevision: current.revision,
        };
      }
      await this.appendEventWithClient(client, {
        delegationId: input.id,
        kind: input.event,
        actorPrincipalId: input.actorPrincipalId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        data: { from: current.status, to: input.to },
      });
      if (input.to === "revoked") {
        await this.cancelActiveRunsWithClient(client, {
          delegationId: input.id,
          actorPrincipalId: input.actorPrincipalId,
          reason: input.reason,
        });
      }
      if (
        (input.to === "revoked" || input.to === "completed") &&
        current.report_required
      ) {
        await client.query(
          `INSERT INTO delegation_reports (
             delegation_id, status, attempt_count, created_at, updated_at
           ) VALUES ($1, 'pending', 0, NOW(), NOW())
           ON CONFLICT (delegation_id) DO UPDATE
           SET status = 'pending', updated_at = NOW()
           WHERE delegation_reports.status <> 'ready'`,
          [input.id],
        );
      }
      return {
        kind: "updated" as const,
        delegation: await this.requireWithClient(client, input.id),
      };
    });
  }

  private async cancelActiveRunsWithClient(
    client: PoolClient,
    input: {
      readonly delegationId: string;
      readonly actorPrincipalId: string;
      readonly reason: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO delegation_ticket_revocations (
         ticket_id, delegation_id, revoked_by_principal_id, reason, revoked_at
       )
       SELECT ticket.id, ticket.delegation_id, $2, $3, NOW()
       FROM action_tickets AS ticket
       WHERE ticket.delegation_id = $1
       ON CONFLICT (ticket_id) DO NOTHING`,
      [input.delegationId, input.actorPrincipalId, input.reason],
    );
    await client.query(
      `INSERT INTO execution_gate_decisions (
         decision_id, gate_id, decision, decided_by_principal_id, basis,
         decided_at, policy_revision, envelope_id, envelope_digest
       )
       SELECT
         gen_random_uuid(), request.gate_id, 'cancel', $2, $3, NOW(),
         request.policy_revision, request.envelope_id, request.envelope_digest
       FROM execution_gate_requests AS request
       JOIN action_tickets AS ticket ON ticket.id = request.ticket_id
       LEFT JOIN execution_gate_decisions AS decision
         ON decision.gate_id = request.gate_id
       WHERE ticket.delegation_id = $1
         AND decision.gate_id IS NULL
       ON CONFLICT (gate_id) DO NOTHING`,
      [input.delegationId, input.actorPrincipalId, input.reason],
    );
    const runs = await client.query<{ run_id: string }>(
      `UPDATE runs AS run
       SET status = 'cancelled',
           error = $2,
           ended_at = NOW(),
           updated_at = NOW()
       FROM action_tickets AS ticket
       WHERE ticket.run_id = run.id
         AND ticket.delegation_id = $1
         AND run.status IN (
           'queued',
           'running',
           'waiting_approval',
           'interrupted'
         )
       RETURNING run.id AS run_id`,
      [input.delegationId, `delegation_revoked: ${input.reason}`.slice(0, 4_000)],
    );
    await client.query(
      `UPDATE jobs
       SET status = 'cancelled', last_error = $2, updated_at = NOW()
       WHERE run_id = ANY($1::uuid[])
         AND status IN ('queued', 'running')`,
      [
        runs.rows.map((row) => row.run_id),
        `delegation_revoked: ${input.reason}`.slice(0, 4_000),
      ],
    );
    await client.query(
      `UPDATE runtime_effect_receipts
       SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
       WHERE run_id = ANY($1::uuid[]) AND status = 'running'`,
      [runs.rows.map((row) => row.run_id)],
    );
    await client.query(
      `UPDATE delegation_runs AS association
       SET status = 'cancelled', ended_at = NOW(), updated_at = NOW()
       WHERE association.delegation_id = $1
         AND association.run_id = ANY($2::uuid[])`,
      [input.delegationId, runs.rows.map((row) => row.run_id)],
    );
    await client.query(
      `UPDATE meeting_delegates
       SET status = 'revoked', revoked_by = $2, revoked_at = NOW(),
           updated_at = NOW()
       WHERE delegation_id = $1 AND status = 'active'`,
      [input.delegationId, input.actorPrincipalId],
    );
  }

  private async lockWithClient(
    client: PoolClient,
    id: string,
  ): Promise<DelegationRow | undefined> {
    const result = await client.query<DelegationRow>(
      `${DELEGATION_SELECT}
       WHERE delegation.id = $1
       FOR UPDATE OF delegation`,
      [id],
    );
    return result.rows[0];
  }

  private async requireWithClient(
    client: PoolClient,
    id: string,
  ): Promise<Delegation> {
    const result = await client.query<DelegationRow>(
      `${DELEGATION_SELECT} WHERE delegation.id = $1`,
      [id],
    );
    return delegationFromRow(result.rows[0]!);
  }

  private async appendEventWithClient(
    client: PoolClient,
    input: {
      readonly delegationId: string;
      readonly kind: DelegationEvent["kind"];
      readonly actorPrincipalId: string;
      readonly beforeRevision: number;
      readonly afterRevision: number;
      readonly reason: string | null;
      readonly data: Record<string, unknown>;
    },
  ): Promise<void> {
    let beforeRevision = input.beforeRevision;
    let afterRevision = input.afterRevision;
    if (afterRevision <= 0) {
      const current = await client.query<{ revision: number }>(
        "SELECT revision FROM delegations WHERE id = $1",
        [input.delegationId],
      );
      beforeRevision = current.rows[0]?.revision ?? 1;
      afterRevision = beforeRevision;
    }
    await client.query(
      `INSERT INTO delegation_events (
         id, delegation_id, seq, kind, actor_principal_id, before_revision,
         after_revision, reason, data, created_at
       )
       SELECT
         $1, $2, COALESCE(MAX(event.seq), 0) + 1, $3, $4, $5, $6, $7,
         $8::jsonb, NOW()
       FROM delegation_events AS event
       WHERE event.delegation_id = $2`,
      [
        randomUUID(),
        input.delegationId,
        input.kind,
        input.actorPrincipalId,
        beforeRevision,
        afterRevision,
        input.reason,
        JSON.stringify(input.data),
      ],
    );
  }

  private async insertNotificationWithClient(
    client: PoolClient,
    input: {
      readonly ownerPrincipalId: string;
      readonly delegationId: string;
      readonly kind: DelegationNotification["kind"];
      readonly dedupeKey: string;
      readonly dueAt: Date;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO delegation_notifications (
         id, owner_principal_id, delegation_id, kind, dedupe_key,
         status, due_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, NOW())
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        randomUUID(),
        input.ownerPrincipalId,
        input.delegationId,
        input.kind,
        input.dedupeKey,
        input.dueAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function validTransition(
  from: DelegationStatus,
  to: DelegationStatus,
): boolean {
  if (to === "active") return from === "draft" || from === "paused";
  if (to === "paused") return from === "active";
  if (to === "completed") return from === "active" || from === "paused";
  if (to === "revoked") {
    return ["draft", "active", "paused", "completed", "expired"].includes(from);
  }
  return false;
}
