import { randomUUID } from "node:crypto";
import type {
  CreateMeetingDelegateInput,
  MeetingCollaborationOverview,
  MeetingDelegate,
  MeetingFile,
  MeetingFacilitatorHandoff,
  MeetingMessageDelivery,
  MeetingMinutesConfirmation,
  MeetingPrivateBriefing,
  MeetingReadPosition,
  MeetingTask,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { FileRef } from "@pluginmax/files";
import type { Database } from "./database.js";

interface CollaborationRow {
  meeting_id: string;
  project_id: string;
  facilitator_principal_id: string;
  facilitator_display_name: string | null;
  lifecycle_status: "active" | "archived";
  revision: number;
  facilitator_assigned_by: string | null;
  facilitator_assigned_at: Date;
  archived_by: string | null;
  archived_at: Date | null;
  archive_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FacilitatorHandoffRow {
  id: string;
  meeting_id: string;
  from_principal_id: string | null;
  to_principal_id: string;
  actor_principal_id: string;
  reason: string;
  resulting_revision: number;
  created_at: Date;
}

interface DelegateRow {
  id: string;
  meeting_id: string;
  project_id: string;
  delegator_principal_id: string;
  representative_kind: "human" | "agent";
  representative_principal_id: string;
  representative_name: string | null;
  agent_id: string | null;
  allowed_actions: MeetingDelegate["allowedActions"];
  status: MeetingDelegate["status"];
  reason: string;
  expires_at: Date | null;
  created_by: string;
  created_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
}

interface PrivateBriefingRow {
  id: string;
  meeting_id: string;
  project_id: string;
  owner_principal_id: string;
  audience_principal_id: string;
  audience_agent_id: string | null;
  content: string;
  status: "active" | "archived";
  revision: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface ReadPositionRow {
  meeting_id: string;
  principal_id: string;
  last_read_message_id: string | null;
  last_read_at: Date;
  revision: number;
  updated_at: Date;
}

interface DeliveryRow {
  id: string;
  meeting_id: string;
  message_id: string;
  recipient_principal_id: string;
  status: MeetingMessageDelivery["status"];
  attempts: number;
  idempotency_key: string;
  last_error: string | null;
  delivered_at: Date | null;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MeetingFileRow {
  id: string;
  meeting_id: string;
  project_id: string;
  name: string;
  mime_type: string;
  size: string;
  sha256: string;
  storage_key: string;
  status: "active" | "archived";
  uploaded_by: string;
  archived_by: string | null;
  archived_at: Date | null;
  created_at: Date;
}

interface MeetingTaskRow {
  id: string;
  meeting_id: string;
  project_id: string;
  task_id: string;
  title: string;
  task_status: MeetingTask["taskStatus"];
  assignee_agent_id: string;
  source_type: MeetingTask["sourceType"];
  source_id: string;
  idempotency_key: string;
  created_by: string;
  created_at: Date;
}

interface ConfirmationRow {
  version_id: string;
  meeting_id: string;
  project_id: string;
  confirmed_by: string;
  note: string;
  confirmed_at: Date;
}

export class MeetingCollaborationRepository {
  constructor(private readonly database: Database) {}

  async overview(
    meetingId: string,
  ): Promise<MeetingCollaborationOverview | undefined> {
    const result = await this.database.query<CollaborationRow>(
      `${COLLABORATION_SELECT}
       WHERE state.meeting_id = $1`,
      [meetingId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : collaborationFromRow(row);
  }

  async ensureState(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly facilitatorPrincipalId: string;
    readonly actorPrincipalId: string;
  }): Promise<MeetingCollaborationOverview> {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO meeting_collaboration_states (
           meeting_id, project_id, facilitator_principal_id, lifecycle_status,
           revision, facilitator_assigned_by, facilitator_assigned_at,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 'active', 1, $4, NOW(), NOW(), NOW())
         ON CONFLICT (meeting_id) DO NOTHING`,
        [
          input.meetingId,
          input.projectId,
          input.facilitatorPrincipalId,
          input.actorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO meeting_facilitator_handoffs (
           id, meeting_id, from_principal_id, to_principal_id,
           actor_principal_id, reason, resulting_revision, created_at
         ) VALUES (
           $1, $2, NULL, $3, $4, 'Initial facilitator assignment', 1, NOW()
         )
         ON CONFLICT (meeting_id, resulting_revision) DO NOTHING`,
        [
          randomUUID(),
          input.meetingId,
          input.facilitatorPrincipalId,
          input.actorPrincipalId,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "facilitator",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting facilitator assigned",
        data: { facilitatorPrincipalId: input.facilitatorPrincipalId },
        onlyIfNoEvents: true,
      });
      const result = await client.query<CollaborationRow>(
        `${COLLABORATION_SELECT}
         WHERE state.meeting_id = $1`,
        [input.meetingId],
      );
      return collaborationFromRow(result.rows[0]!);
    });
  }

  async handoffFacilitator(input: {
    readonly meetingId: string;
    readonly expectedRevision: number;
    readonly facilitatorPrincipalId: string;
    readonly actorPrincipalId: string;
    readonly reason: string;
  }): Promise<MeetingCollaborationOverview | undefined> {
    return this.database.transaction(async (client) => {
      const current = await client.query<CollaborationRow>(
        `${COLLABORATION_SELECT}
         WHERE state.meeting_id = $1
         FOR UPDATE OF state`,
        [input.meetingId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.lifecycle_status !== "active" ||
        row.revision !== input.expectedRevision ||
        row.facilitator_principal_id === input.facilitatorPrincipalId
      ) {
        return undefined;
      }
      const nextRevision = row.revision + 1;
      await client.query(
        `UPDATE meeting_collaboration_states
         SET
           facilitator_principal_id = $2,
           facilitator_assigned_by = $3,
           facilitator_assigned_at = NOW(),
           revision = $4,
           updated_at = NOW()
         WHERE meeting_id = $1`,
        [
          input.meetingId,
          input.facilitatorPrincipalId,
          input.actorPrincipalId,
          nextRevision,
        ],
      );
      await client.query(
        `INSERT INTO meeting_facilitator_handoffs (
           id, meeting_id, from_principal_id, to_principal_id,
           actor_principal_id, reason, resulting_revision, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          randomUUID(),
          input.meetingId,
          row.facilitator_principal_id,
          input.facilitatorPrincipalId,
          input.actorPrincipalId,
          input.reason,
          nextRevision,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "facilitator",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting facilitator handed off",
        data: {
          fromPrincipalId: row.facilitator_principal_id,
          toPrincipalId: input.facilitatorPrincipalId,
          reason: input.reason,
          revision: nextRevision,
        },
      });
      return this.overviewWithClient(client, input.meetingId);
    });
  }

  async listFacilitatorHandoffs(
    meetingId: string,
  ): Promise<MeetingFacilitatorHandoff[]> {
    const result = await this.database.query<FacilitatorHandoffRow>(
      `SELECT * FROM meeting_facilitator_handoffs
       WHERE meeting_id = $1
       ORDER BY resulting_revision DESC, created_at DESC`,
      [meetingId],
    );
    return result.rows.map(facilitatorHandoffFromRow);
  }

  async archive(input: {
    readonly meetingId: string;
    readonly expectedRevision: number;
    readonly actorPrincipalId: string;
    readonly reason: string;
  }): Promise<MeetingCollaborationOverview | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<CollaborationRow>(
        `${COLLABORATION_SELECT}
         WHERE state.meeting_id = $1
         FOR UPDATE OF state`,
        [input.meetingId],
      );
      const state = result.rows[0];
      if (
        state === undefined ||
        state.lifecycle_status !== "active" ||
        state.revision !== input.expectedRevision
      ) {
        return undefined;
      }
      await client.query(
        `UPDATE meeting_collaboration_states
         SET
           lifecycle_status = 'archived',
           archived_by = $2,
           archived_at = NOW(),
           archive_reason = $3,
           revision = revision + 1,
           updated_at = NOW()
         WHERE meeting_id = $1`,
        [input.meetingId, input.actorPrincipalId, input.reason],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "archive",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting archived",
        data: { reason: input.reason },
      });
      return this.overviewWithClient(client, input.meetingId);
    });
  }

  async restore(input: {
    readonly meetingId: string;
    readonly expectedRevision: number;
    readonly actorPrincipalId: string;
  }): Promise<MeetingCollaborationOverview | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<CollaborationRow>(
        `${COLLABORATION_SELECT}
         WHERE state.meeting_id = $1
         FOR UPDATE OF state`,
        [input.meetingId],
      );
      const state = result.rows[0];
      if (
        state === undefined ||
        state.lifecycle_status !== "archived" ||
        state.revision !== input.expectedRevision
      ) {
        return undefined;
      }
      await client.query(
        `UPDATE meeting_collaboration_states
         SET
           lifecycle_status = 'active',
           archived_by = NULL,
           archived_at = NULL,
           archive_reason = NULL,
           revision = revision + 1,
           updated_at = NOW()
         WHERE meeting_id = $1`,
        [input.meetingId],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "restore",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting restored from archive",
        data: {},
      });
      return this.overviewWithClient(client, input.meetingId);
    });
  }

  async listDelegates(meetingId: string): Promise<MeetingDelegate[]> {
    await this.expireDelegates(meetingId);
    const result = await this.database.query<DelegateRow>(
      `${DELEGATE_SELECT}
       WHERE delegate.meeting_id = $1
       ORDER BY delegate.created_at DESC, delegate.id DESC`,
      [meetingId],
    );
    return result.rows.map(delegateFromRow);
  }

  async getDelegate(
    meetingId: string,
    delegateId: string,
  ): Promise<MeetingDelegate | undefined> {
    await this.expireDelegates(meetingId);
    const result = await this.database.query<DelegateRow>(
      `${DELEGATE_SELECT}
       WHERE delegate.meeting_id = $1 AND delegate.id = $2`,
      [meetingId, delegateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : delegateFromRow(row);
  }

  async createDelegate(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly delegatorPrincipalId: string;
    readonly actorPrincipalId: string;
    readonly input: CreateMeetingDelegateInput;
    readonly representativePrincipalId: string;
  }): Promise<MeetingDelegate> {
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO meeting_delegates (
           id, meeting_id, project_id, delegator_principal_id,
           representative_kind, representative_principal_id, agent_id,
           allowed_actions, status, reason, expires_at, created_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::text[], 'active', $9, $10, $11,
           NOW(), NOW()
         )`,
        [
          id,
          input.meetingId,
          input.projectId,
          input.delegatorPrincipalId,
          input.input.representativeKind,
          input.representativePrincipalId,
          input.input.agentId ?? null,
          input.input.allowedActions,
          input.input.reason,
          input.input.expiresAt ?? null,
          input.actorPrincipalId,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "delegate",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting delegate authorized",
        data: {
          delegateId: id,
          delegatorPrincipalId: input.delegatorPrincipalId,
          representativePrincipalId: input.representativePrincipalId,
          allowedActions: input.input.allowedActions,
        },
      });
      const result = await client.query<DelegateRow>(
        `${DELEGATE_SELECT}
         WHERE delegate.meeting_id = $1 AND delegate.id = $2`,
        [input.meetingId, id],
      );
      return delegateFromRow(result.rows[0]!);
    });
  }

  async revokeDelegate(input: {
    readonly meetingId: string;
    readonly delegateId: string;
    readonly actorPrincipalId: string;
    readonly reason: string;
  }): Promise<MeetingDelegate | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DelegateRow>(
        `${DELEGATE_SELECT}
         WHERE delegate.meeting_id = $1 AND delegate.id = $2
         FOR UPDATE OF delegate`,
        [input.meetingId, input.delegateId],
      );
      const delegate = result.rows[0];
      if (delegate === undefined || delegate.status !== "active") {
        return undefined;
      }
      await client.query(
        `UPDATE meeting_delegates
         SET
           status = 'revoked',
           revoked_by = $3,
           revoked_at = NOW(),
           updated_at = NOW()
         WHERE meeting_id = $1 AND id = $2`,
        [input.meetingId, input.delegateId, input.actorPrincipalId],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "delegate",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting delegate revoked",
        data: {
          delegateId: input.delegateId,
          representativePrincipalId: delegate.representative_principal_id,
          reason: input.reason,
        },
      });
      const updated = await client.query<DelegateRow>(
        `${DELEGATE_SELECT}
         WHERE delegate.meeting_id = $1 AND delegate.id = $2`,
        [input.meetingId, input.delegateId],
      );
      return delegateFromRow(updated.rows[0]!);
    });
  }

  async listPrivateBriefings(input: {
    readonly meetingId: string;
    readonly principalId: string;
    readonly includeArchived?: boolean;
  }): Promise<MeetingPrivateBriefing[]> {
    const result = await this.database.query<PrivateBriefingRow>(
      `SELECT * FROM meeting_private_briefings
       WHERE meeting_id = $1
         AND (owner_principal_id = $2 OR audience_principal_id = $2)
         AND ($3::boolean OR status = 'active')
       ORDER BY updated_at DESC, id DESC`,
      [input.meetingId, input.principalId, input.includeArchived ?? false],
    );
    return result.rows.map(privateBriefingFromRow);
  }

  async listBriefingsForContext(input: {
    readonly meetingId: string;
    readonly principalId: string;
    readonly agentId: string;
    readonly agentPrincipalId: string | null;
  }): Promise<MeetingPrivateBriefing[]> {
    const result = await this.database.query<PrivateBriefingRow>(
      `SELECT * FROM meeting_private_briefings
       WHERE meeting_id = $1
         AND status = 'active'
         AND (
           audience_principal_id = $2
           OR (
             $4::text IS NOT NULL
             AND audience_principal_id = $4
             AND (audience_agent_id IS NULL OR audience_agent_id = $3)
           )
           OR (
             owner_principal_id = $2
             AND audience_agent_id IS NOT NULL
             AND audience_agent_id = $3
           )
         )
       ORDER BY created_at, id`,
      [
        input.meetingId,
        input.principalId,
        input.agentId,
        input.agentPrincipalId,
      ],
    );
    return result.rows.map(privateBriefingFromRow);
  }

  async getPrivateBriefing(
    meetingId: string,
    briefingId: string,
  ): Promise<MeetingPrivateBriefing | undefined> {
    const result = await this.database.query<PrivateBriefingRow>(
      `SELECT * FROM meeting_private_briefings
       WHERE meeting_id = $1 AND id = $2`,
      [meetingId, briefingId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : privateBriefingFromRow(row);
  }

  async createPrivateBriefing(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly ownerPrincipalId: string;
    readonly audiencePrincipalId: string;
    readonly audienceAgentId: string | null;
    readonly content: string;
  }): Promise<MeetingPrivateBriefing> {
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO meeting_private_briefings (
           id, meeting_id, project_id, owner_principal_id,
           audience_principal_id, audience_agent_id, content, status, revision,
           created_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', 1, $4, NOW(), NOW()
         )`,
        [
          id,
          input.meetingId,
          input.projectId,
          input.ownerPrincipalId,
          input.audiencePrincipalId,
          input.audienceAgentId,
          input.content,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "private-briefing",
        actorPrincipalId: input.ownerPrincipalId,
        summary: "Private meeting briefing created",
        data: {
          briefingId: id,
          audiencePrincipalId: input.audiencePrincipalId,
        },
      });
      const result = await client.query<PrivateBriefingRow>(
        `SELECT * FROM meeting_private_briefings WHERE id = $1`,
        [id],
      );
      return privateBriefingFromRow(result.rows[0]!);
    });
  }

  async updatePrivateBriefing(input: {
    readonly meetingId: string;
    readonly briefingId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
    readonly content: string;
  }): Promise<MeetingPrivateBriefing | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PrivateBriefingRow>(
        `UPDATE meeting_private_briefings
         SET content = $4, revision = revision + 1, updated_at = NOW()
         WHERE meeting_id = $1
           AND id = $2
           AND owner_principal_id = $3
           AND status = 'active'
           AND revision = $5
         RETURNING *`,
        [
          input.meetingId,
          input.briefingId,
          input.ownerPrincipalId,
          input.content,
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "private-briefing",
        actorPrincipalId: input.ownerPrincipalId,
        summary: "Private meeting briefing revised",
        data: {
          briefingId: input.briefingId,
          revision: row.revision,
        },
      });
      return privateBriefingFromRow(row);
    });
  }

  async archivePrivateBriefing(input: {
    readonly meetingId: string;
    readonly briefingId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
  }): Promise<MeetingPrivateBriefing | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<PrivateBriefingRow>(
        `UPDATE meeting_private_briefings
         SET status = 'archived', revision = revision + 1, updated_at = NOW()
         WHERE meeting_id = $1
           AND id = $2
           AND owner_principal_id = $3
           AND status = 'active'
           AND revision = $4
         RETURNING *`,
        [
          input.meetingId,
          input.briefingId,
          input.ownerPrincipalId,
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "private-briefing",
        actorPrincipalId: input.ownerPrincipalId,
        summary: "Private meeting briefing archived",
        data: {
          briefingId: input.briefingId,
          revision: row.revision,
        },
      });
      return privateBriefingFromRow(row);
    });
  }

  async getReadPosition(
    meetingId: string,
    principalId: string,
  ): Promise<MeetingReadPosition | undefined> {
    const result = await this.database.query<ReadPositionRow>(
      `SELECT * FROM meeting_read_positions
       WHERE meeting_id = $1 AND principal_id = $2`,
      [meetingId, principalId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : readPositionFromRow(row);
  }

  async setReadPosition(input: {
    readonly meetingId: string;
    readonly principalId: string;
    readonly messageId: string;
  }): Promise<MeetingReadPosition | undefined> {
    return this.database.transaction(async (client) => {
      const message = await client.query<{ id: string }>(
        `SELECT id FROM meeting_messages
         WHERE meeting_id = $1 AND id = $2`,
        [input.meetingId, input.messageId],
      );
      if (message.rows[0] === undefined) return undefined;
      const result = await client.query<ReadPositionRow>(
        `INSERT INTO meeting_read_positions (
           meeting_id, principal_id, last_read_message_id, last_read_at,
           revision, updated_at
         ) VALUES ($1, $2, $3, NOW(), 1, NOW())
         ON CONFLICT (meeting_id, principal_id) DO UPDATE SET
           last_read_message_id = EXCLUDED.last_read_message_id,
           last_read_at = EXCLUDED.last_read_at,
           revision = meeting_read_positions.revision + 1,
           updated_at = NOW()
         RETURNING *`,
        [input.meetingId, input.principalId, input.messageId],
      );
      await client.query(
        `UPDATE meeting_message_deliveries
         SET status = 'read', read_at = NOW(), updated_at = NOW()
         WHERE meeting_id = $1
           AND message_id = $2
           AND recipient_principal_id = $3
           AND status = 'delivered'`,
        [input.meetingId, input.messageId, input.principalId],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "read-position",
        actorPrincipalId: input.principalId,
        summary: "Meeting read position updated",
        data: { messageId: input.messageId },
      });
      return readPositionFromRow(result.rows[0]!);
    });
  }

  async listDeliveries(
    meetingId: string,
    messageId: string,
  ): Promise<MeetingMessageDelivery[]> {
    const result = await this.database.query<DeliveryRow>(
      `SELECT * FROM meeting_message_deliveries
       WHERE meeting_id = $1 AND message_id = $2
       ORDER BY created_at, recipient_principal_id`,
      [meetingId, messageId],
    );
    return result.rows.map(deliveryFromRow);
  }

  async getDelivery(
    meetingId: string,
    messageId: string,
    deliveryId: string,
  ): Promise<MeetingMessageDelivery | undefined> {
    const result = await this.database.query<DeliveryRow>(
      `SELECT * FROM meeting_message_deliveries
       WHERE meeting_id = $1 AND message_id = $2 AND id = $3`,
      [meetingId, messageId, deliveryId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : deliveryFromRow(row);
  }

  async retryDelivery(input: {
    readonly meetingId: string;
    readonly messageId: string;
    readonly deliveryId: string;
    readonly actorPrincipalId: string;
  }): Promise<
    | { readonly kind: "retried"; readonly delivery: MeetingMessageDelivery }
    | {
        readonly kind: "not_retryable";
        readonly delivery: MeetingMessageDelivery;
      }
    | { readonly kind: "missing" }
  > {
    return this.database.transaction(async (client) => {
      const current = await client.query<DeliveryRow>(
        `SELECT * FROM meeting_message_deliveries
         WHERE meeting_id = $1 AND message_id = $2 AND id = $3
         FOR UPDATE`,
        [input.meetingId, input.messageId, input.deliveryId],
      );
      const delivery = current.rows[0];
      if (delivery === undefined) return { kind: "missing" };
      if (delivery.status !== "failed") {
        return { kind: "not_retryable", delivery: deliveryFromRow(delivery) };
      }
      const updated = await client.query<DeliveryRow>(
        `UPDATE meeting_message_deliveries
         SET
           status = 'delivered',
           attempts = attempts + 1,
           last_error = NULL,
           delivered_at = NOW(),
           updated_at = NOW()
         WHERE id = $1 AND status = 'failed'
         RETURNING *`,
        [delivery.id],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "delivery",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting message delivery retried",
        data: {
          messageId: input.messageId,
          deliveryId: delivery.id,
          recipientPrincipalId: delivery.recipient_principal_id,
        },
      });
      return {
        kind: "retried",
        delivery: deliveryFromRow(updated.rows[0]!),
      };
    });
  }

  async markDeliveryRead(input: {
    readonly meetingId: string;
    readonly messageId: string;
    readonly deliveryId: string;
    readonly principalId: string;
  }): Promise<
    | { readonly kind: "read"; readonly delivery: MeetingMessageDelivery }
    | { readonly kind: "reused"; readonly delivery: MeetingMessageDelivery }
    | {
        readonly kind: "not_readable";
        readonly delivery: MeetingMessageDelivery;
      }
    | { readonly kind: "missing" }
  > {
    return this.database.transaction(async (client) => {
      const current = await client.query<DeliveryRow>(
        `SELECT * FROM meeting_message_deliveries
         WHERE meeting_id = $1
           AND message_id = $2
           AND id = $3
           AND recipient_principal_id = $4
         FOR UPDATE`,
        [input.meetingId, input.messageId, input.deliveryId, input.principalId],
      );
      const delivery = current.rows[0];
      if (delivery === undefined) return { kind: "missing" };
      if (delivery.status === "read") {
        return { kind: "reused", delivery: deliveryFromRow(delivery) };
      }
      if (delivery.status !== "delivered") {
        return { kind: "not_readable", delivery: deliveryFromRow(delivery) };
      }
      const updated = await client.query<DeliveryRow>(
        `UPDATE meeting_message_deliveries
         SET status = 'read', read_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'delivered'
         RETURNING *`,
        [delivery.id],
      );
      return {
        kind: "read",
        delivery: deliveryFromRow(updated.rows[0]!),
      };
    });
  }

  async listFiles(input: {
    readonly meetingId: string;
    readonly includeArchived?: boolean;
  }): Promise<MeetingFile[]> {
    const result = await this.database.query<MeetingFileRow>(
      `SELECT * FROM meeting_files
       WHERE meeting_id = $1
         AND ($2::boolean OR status = 'active')
       ORDER BY created_at DESC, id DESC`,
      [input.meetingId, input.includeArchived ?? false],
    );
    return result.rows.map(meetingFileFromRow);
  }

  async getFile(
    meetingId: string,
    fileId: string,
  ): Promise<MeetingFile | undefined> {
    const result = await this.database.query<MeetingFileRow>(
      `SELECT * FROM meeting_files
       WHERE meeting_id = $1 AND id = $2`,
      [meetingId, fileId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingFileFromRow(row);
  }

  async saveFile(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly uploadedBy: string;
    readonly ref: FileRef;
  }): Promise<MeetingFile> {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO meeting_files (
           id, meeting_id, project_id, name, mime_type, size, sha256,
           storage_key, status, uploaded_by, archived_by, archived_at,
           created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, NULL, NULL, NOW()
         )`,
        [
          input.ref.id,
          input.meetingId,
          input.projectId,
          input.ref.name,
          input.ref.mimeType,
          input.ref.size,
          input.ref.sha256,
          input.ref.storageKey,
          input.uploadedBy,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "file",
        actorPrincipalId: input.uploadedBy,
        summary: "Meeting file uploaded",
        data: {
          fileId: input.ref.id,
          name: input.ref.name,
          sha256: input.ref.sha256,
        },
      });
      const result = await client.query<MeetingFileRow>(
        `SELECT * FROM meeting_files WHERE id = $1`,
        [input.ref.id],
      );
      return meetingFileFromRow(result.rows[0]!);
    });
  }

  async archiveFile(input: {
    readonly meetingId: string;
    readonly fileId: string;
    readonly actorPrincipalId: string;
    readonly archived: boolean;
  }): Promise<MeetingFile | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<MeetingFileRow>(
        `UPDATE meeting_files
         SET
           status = CASE WHEN $4::boolean THEN 'active' ELSE 'archived' END,
           archived_by = CASE WHEN $4::boolean THEN NULL ELSE $3 END,
           archived_at = CASE WHEN $4::boolean THEN NULL ELSE NOW() END
         WHERE meeting_id = $1
           AND id = $2
           AND (
             ($4::boolean AND status = 'archived')
             OR (NOT $4::boolean AND status = 'active')
           )
         RETURNING *`,
        [input.meetingId, input.fileId, input.actorPrincipalId, input.archived],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "file",
        actorPrincipalId: input.actorPrincipalId,
        summary: input.archived
          ? "Meeting file restored"
          : "Meeting file archived",
        data: { fileId: input.fileId },
      });
      return meetingFileFromRow(row);
    });
  }

  async listTasks(meetingId: string): Promise<MeetingTask[]> {
    const result = await this.database.query<MeetingTaskRow>(
      `${MEETING_TASK_SELECT}
       WHERE meeting_task.meeting_id = $1
       ORDER BY meeting_task.created_at DESC, meeting_task.id DESC`,
      [meetingId],
    );
    return result.rows.map(meetingTaskFromRow);
  }

  async getTask(
    meetingId: string,
    meetingTaskId: string,
  ): Promise<MeetingTask | undefined> {
    const result = await this.database.query<MeetingTaskRow>(
      `${MEETING_TASK_SELECT}
       WHERE meeting_task.meeting_id = $1 AND meeting_task.id = $2`,
      [meetingId, meetingTaskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingTaskFromRow(row);
  }

  async createTask(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly priority: "low" | "medium" | "high" | "urgent";
    readonly assigneeAgentId: string;
    readonly sourceType: MeetingTask["sourceType"];
    readonly sourceId: string;
    readonly idempotencyKey: string;
    readonly sourceMessageIds: readonly string[];
    readonly actorPrincipalId: string;
  }): Promise<MeetingTask> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`meeting-task:${input.meetingId}:${input.idempotencyKey}`],
      );
      const existing = await client.query<MeetingTaskRow>(
        `${MEETING_TASK_SELECT}
         WHERE meeting_task.meeting_id = $1
           AND meeting_task.idempotency_key = $2`,
        [input.meetingId, input.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        return {
          ...meetingTaskFromRow(existing.rows[0]),
          reused: true,
        };
      }
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO tasks (
           id, project_id, title, description, acceptance, status, priority,
           agent_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, NOW(), NOW()
         )`,
        [
          taskId,
          input.projectId,
          input.title,
          input.description,
          JSON.stringify([
            "Meeting delivery is complete and verifiable",
            "Meeting, message, minutes, and task traceability is preserved",
          ]),
          input.priority,
          input.assigneeAgentId,
        ],
      );
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES (
           $1, $2, 'created', $3, $3, $4, $5::jsonb, NOW()
         )`,
        [
          randomUUID(),
          taskId,
          input.actorPrincipalId,
          `Task created from meeting "${input.title}"`,
          JSON.stringify({
            meetingId: input.meetingId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceMessageIds: input.sourceMessageIds,
          }),
        ],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO meeting_tasks (
           id, meeting_id, project_id, task_id, source_type, source_id,
           idempotency_key, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          id,
          input.meetingId,
          input.projectId,
          taskId,
          input.sourceType,
          input.sourceId,
          input.idempotencyKey,
          input.actorPrincipalId,
        ],
      );
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "task",
        actorPrincipalId: input.actorPrincipalId,
        summary: "Meeting task created",
        data: { taskId, meetingTaskId: id },
      });
      const result = await client.query<MeetingTaskRow>(
        `${MEETING_TASK_SELECT}
         WHERE meeting_task.meeting_id = $1 AND meeting_task.id = $2`,
        [input.meetingId, id],
      );
      return meetingTaskFromRow(result.rows[0]!);
    });
  }

  async confirmMinutes(input: {
    readonly versionId: string;
    readonly meetingId: string;
    readonly projectId: string;
    readonly confirmedBy: string;
    readonly note: string;
  }): Promise<MeetingMinutesConfirmation> {
    await this.database.query(
      `INSERT INTO meeting_minutes_confirmations (
         version_id, meeting_id, project_id, confirmed_by, note, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (version_id) DO NOTHING`,
      [
        input.versionId,
        input.meetingId,
        input.projectId,
        input.confirmedBy,
        input.note,
      ],
    );
    const result = await this.database.query<ConfirmationRow>(
      `SELECT * FROM meeting_minutes_confirmations WHERE version_id = $1`,
      [input.versionId],
    );
    return confirmationFromRow(result.rows[0]!);
  }

  async listMinutesConfirmations(
    meetingId: string,
  ): Promise<MeetingMinutesConfirmation[]> {
    const result = await this.database.query<ConfirmationRow>(
      `SELECT * FROM meeting_minutes_confirmations
       WHERE meeting_id = $1
       ORDER BY confirmed_at DESC, version_id DESC`,
      [meetingId],
    );
    return result.rows.map(confirmationFromRow);
  }

  async recordMinutesEvent(input: {
    readonly meetingId: string;
    readonly actorPrincipalId: string;
    readonly summary: string;
    readonly data: Record<string, unknown>;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.appendEventWithClient(client, {
        meetingId: input.meetingId,
        kind: "minutes",
        actorPrincipalId: input.actorPrincipalId,
        summary: input.summary,
        data: input.data,
      });
    });
  }

  private async expireDelegates(meetingId: string): Promise<void> {
    await this.database.query(
      `UPDATE meeting_delegates
       SET status = 'expired', updated_at = NOW()
       WHERE meeting_id = $1
         AND status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
      [meetingId],
    );
  }

  private async overviewWithClient(
    client: PoolClient,
    meetingId: string,
  ): Promise<MeetingCollaborationOverview> {
    const result = await client.query<CollaborationRow>(
      `${COLLABORATION_SELECT}
       WHERE state.meeting_id = $1`,
      [meetingId],
    );
    return collaborationFromRow(result.rows[0]!);
  }

  private async appendEventWithClient(
    client: PoolClient,
    input: {
      readonly meetingId: string;
      readonly kind:
        | "facilitator"
        | "delegate"
        | "private-briefing"
        | "delivery"
        | "archive"
        | "restore"
        | "file"
        | "minutes"
        | "task"
        | "read-position";
      readonly actorPrincipalId: string;
      readonly summary: string;
      readonly data: Record<string, unknown>;
      readonly onlyIfNoEvents?: boolean;
    },
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`meeting-collaboration-events:${input.meetingId}`],
    );
    await client.query(
      `INSERT INTO meeting_collaboration_events (
         id, meeting_id, seq, kind, actor_principal_id, summary, data, created_at
       )
       SELECT
         $1,
         $2,
         COALESCE(MAX(event.seq), 0) + 1,
         $3,
         $4,
         $5,
         $6::jsonb,
         NOW()
       FROM meeting_collaboration_events AS event
       WHERE event.meeting_id = $2
         AND (
           NOT $7::boolean
           OR NOT EXISTS (
             SELECT 1
             FROM meeting_collaboration_events AS prior
             WHERE prior.meeting_id = $2
           )
         )`,
      [
        randomUUID(),
        input.meetingId,
        input.kind,
        input.actorPrincipalId,
        input.summary,
        JSON.stringify(input.data),
        input.onlyIfNoEvents ?? false,
      ],
    );
  }
}

const COLLABORATION_SELECT = `SELECT
  state.*,
  principal.display_name AS facilitator_display_name
FROM meeting_collaboration_states AS state
LEFT JOIN principals AS principal
  ON principal.id = state.facilitator_principal_id`;

const DELEGATE_SELECT = `SELECT
  delegate.*,
  principal.display_name AS representative_name
FROM meeting_delegates AS delegate
LEFT JOIN principals AS principal
  ON principal.id = delegate.representative_principal_id`;

const MEETING_TASK_SELECT = `SELECT
  meeting_task.*,
  task.title,
  task.status AS task_status,
  task.agent_id AS assignee_agent_id
FROM meeting_tasks AS meeting_task
JOIN tasks AS task ON task.id = meeting_task.task_id`;

function collaborationFromRow(
  row: CollaborationRow,
): MeetingCollaborationOverview {
  return {
    meetingId: row.meeting_id,
    projectId: row.project_id,
    lifecycleStatus: row.lifecycle_status,
    revision: row.revision,
    facilitator: {
      principalId: row.facilitator_principal_id,
      displayName: row.facilitator_display_name ?? row.facilitator_principal_id,
      assignedBy: row.facilitator_assigned_by,
      assignedAt: row.facilitator_assigned_at.toISOString(),
      revision: row.revision,
    },
    archivedBy: row.archived_by,
    archivedAt: row.archived_at?.toISOString() ?? null,
    archiveReason: row.archive_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function facilitatorHandoffFromRow(
  row: FacilitatorHandoffRow,
): MeetingFacilitatorHandoff {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    fromPrincipalId: row.from_principal_id,
    toPrincipalId: row.to_principal_id,
    actorPrincipalId: row.actor_principal_id,
    reason: row.reason,
    resultingRevision: row.resulting_revision,
    createdAt: row.created_at.toISOString(),
  };
}

function delegateFromRow(row: DelegateRow): MeetingDelegate {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    delegatorPrincipalId: row.delegator_principal_id,
    representativeKind: row.representative_kind,
    representativePrincipalId: row.representative_principal_id,
    representativeName:
      row.representative_name ?? row.representative_principal_id,
    agentId: row.agent_id,
    allowedActions: row.allowed_actions,
    status: row.status,
    reason: row.reason,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

function privateBriefingFromRow(
  row: PrivateBriefingRow,
): MeetingPrivateBriefing {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    ownerPrincipalId: row.owner_principal_id,
    audiencePrincipalId: row.audience_principal_id,
    audienceAgentId: row.audience_agent_id,
    content: row.content,
    status: row.status,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function readPositionFromRow(row: ReadPositionRow): MeetingReadPosition {
  return {
    meetingId: row.meeting_id,
    principalId: row.principal_id,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: row.last_read_at.toISOString(),
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

function deliveryFromRow(row: DeliveryRow): MeetingMessageDelivery {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    messageId: row.message_id,
    recipientPrincipalId: row.recipient_principal_id,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    lastError: row.last_error,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function meetingFileFromRow(row: MeetingFileRow): MeetingFile {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256,
    storageKey: row.storage_key,
    status: row.status,
    uploadedBy: row.uploaded_by,
    archivedBy: row.archived_by,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function meetingTaskFromRow(row: MeetingTaskRow): MeetingTask {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    taskId: row.task_id,
    title: row.title,
    taskStatus: row.task_status,
    assigneeAgentId: row.assignee_agent_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by,
    reused: false,
    createdAt: row.created_at.toISOString(),
  };
}

function confirmationFromRow(row: ConfirmationRow): MeetingMinutesConfirmation {
  return {
    versionId: row.version_id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    confirmedBy: row.confirmed_by,
    note: row.note,
    confirmedAt: row.confirmed_at.toISOString(),
  };
}
