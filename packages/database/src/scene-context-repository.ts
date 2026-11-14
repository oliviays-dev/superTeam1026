import { createHash } from "node:crypto";
import type {
  ContextPack,
  ContextReceipt,
  SceneChatChannel,
  SceneContextContribution,
  SceneContextDeliveryCursor,
  SceneContextReceipt,
  SceneContextCommitReceipt,
  SceneContextSnapshot,
  SceneParticipantBinding,
  SceneSessionBinding,
  SceneSourceRef,
  SceneType,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";

interface SceneSessionRow {
  id: string;
  scene_type: SceneType;
  scene_id: string;
  project_id: string | null;
  participant_binding_id: string | null;
  agent_id: string;
  agent_principal_id: string | null;
  owner_principal_id: string | null;
  delegation_id: string | null;
  principal_scope: string;
  channel_id: string | null;
  session_handle: string;
  generation: number;
  status: SceneSessionBinding["status"];
  revision: number;
  last_context_seq: string;
  context_usage_ratio: string | number;
  compaction_count: number;
  created_at: Date;
  updated_at: Date;
}

interface SceneChatChannelRow {
  id: string;
  channel_key: string;
  scene_type: "direct-chat";
  scene_id: string;
  project_id: string | null;
  owner_principal_id: string;
  agent_id: string;
  agent_principal_id: string | null;
  status: SceneChatChannel["status"];
  created_at: Date;
  updated_at: Date;
}

interface SceneContributionRow {
  id: string;
  scene_session_id: string;
  scene_type: SceneType;
  scene_id: string;
  project_id: string | null;
  agent_id: string;
  agent_principal_id: string | null;
  owner_principal_id: string | null;
  delegation_id: string | null;
  source_key: string;
  kind: SceneContextContribution["kind"];
  version: string;
  authority: SceneContextContribution["authority"];
  visibility: SceneContextContribution["visibility"];
  text: string;
  source_refs: SceneSourceRef[];
  delivery_sequence: string;
  created_by: string;
  created_at: Date;
}

interface DeliveryCursorRow {
  scene_session_id: string;
  cursor_sequence: string;
  delivered_contribution_ids: string[];
  last_run_id: string | null;
  revision: number;
  updated_at: Date;
}

interface SceneReceiptRow {
  id: string;
  run_id: string;
  context_pack_id: string;
  scene_session_id: string;
  scene_type: SceneType;
  scene_id: string;
  project_id: string | null;
  delegation_id: string | null;
  agent_id: string;
  principal_id: string;
  agent_principal_id: string | null;
  logical_digest: string;
  content_hash: string;
  renderer_version: string;
  runtime_stateful: boolean;
  context_boundary_seq: string;
  context_policy_version: number;
  context_usage_ratio: string | number;
  cursor_before: string;
  cursor_after: string;
  delivered: SceneContextReceipt["delivered"];
  reused: SceneContextReceipt["reused"];
  source_refs: SceneSourceRef[];
  excluded: SceneContextReceipt["excluded"];
  created_at: Date;
}

interface ParticipantBindingRow {
  id: string;
  scene_type: "group";
  scene_id: string;
  project_id: string;
  participant_kind: "ai";
  agent_id: string;
  agent_principal_id: string;
  principal_id: string;
  status: SceneParticipantBinding["status"];
  revision: number;
  joined_at: Date;
  left_at: Date | null;
  updated_at: Date;
}

interface CommitReceiptRow {
  id: string;
  run_id: string;
  context_pack_id: string;
  scene_session_id: string;
  context_boundary_seq: string;
  previous_context_seq: string;
  context_policy_version: number;
  context_usage_ratio: string | number;
  runtime_success: boolean;
  committed_at: Date;
}

export class SceneContextRepositoryError extends Error {
  constructor(
    readonly code:
      | "scene_session_not_found"
      | "scene_context_conflict"
      | "scene_context_cursor_conflict",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SceneContextRepositoryError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function deterministicUuid(namespace: string, value: string): string {
  const hex = digest(`${namespace}:${value}`);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function sessionHandle(
  sceneType: SceneType,
  sceneId: string,
  agentId: string,
  generation = 0,
): string {
  const prefix =
    sceneType === "task"
      ? "de-task"
      : sceneType === "workflow-node"
        ? "de-flow"
        : sceneType === "meeting"
          ? "de-meeting"
          : sceneType === "delegation"
            ? "de-delegate"
            : sceneType === "group"
              ? "de-group"
          : "de-chat";
  const readable = sceneId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
  const suffix = generation === 0 ? "" : `-r${String(generation).slice(0, 20)}`;
  return `${prefix}-${readable}-${digest(`${sceneType}:${sceneId}:${agentId}`).slice(0, 16)}${suffix}`.slice(
    0,
    240,
  );
}

function sessionFromRow(row: SceneSessionRow): SceneSessionBinding {
  return {
    id: row.id,
    sceneType: row.scene_type,
    sceneId: row.scene_id,
    projectId: row.project_id,
    participantBindingId: row.participant_binding_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    ownerPrincipalId: row.owner_principal_id,
    ...(row.delegation_id === null ? {} : { delegationId: row.delegation_id }),
    channelId: row.channel_id,
    sessionHandle: row.session_handle,
    generation: row.generation,
    status: row.status,
    revision: row.revision,
    lastContextSeq: Number(row.last_context_seq),
    contextUsageRatio: Number(row.context_usage_ratio),
    compactionCount: row.compaction_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function channelFromRow(row: SceneChatChannelRow): SceneChatChannel {
  return {
    id: row.id,
    channelKey: row.channel_key,
    sceneType: row.scene_type,
    sceneId: row.scene_id,
    projectId: row.project_id,
    ownerPrincipalId: row.owner_principal_id,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function contributionFromRow(
  row: SceneContributionRow,
): SceneContextContribution {
  return {
    id: row.id,
    sceneSessionId: row.scene_session_id,
    sceneType: row.scene_type,
    sceneId: row.scene_id,
    projectId: row.project_id,
    ...(row.delegation_id === null ? {} : { delegationId: row.delegation_id }),
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    ownerPrincipalId: row.owner_principal_id,
    sourceKey: row.source_key,
    kind: row.kind,
    version: row.version,
    authority: row.authority,
    visibility: row.visibility,
    text: row.text,
    sourceRefs: row.source_refs,
    sequence: Number(row.delivery_sequence),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function cursorFromRow(row: DeliveryCursorRow): SceneContextDeliveryCursor {
  return {
    sceneSessionId: row.scene_session_id,
    cursorSequence: Number(row.cursor_sequence),
    deliveredContributionIds: row.delivered_contribution_ids,
    lastRunId: row.last_run_id,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  };
}

function receiptFromRow(row: SceneReceiptRow): SceneContextReceipt {
  return {
    id: row.id,
    runId: row.run_id,
    contextPackId: row.context_pack_id,
    sceneSessionId: row.scene_session_id,
    sceneType: row.scene_type,
    sceneId: row.scene_id,
    projectId: row.project_id,
    ...(row.delegation_id === null ? {} : { delegationId: row.delegation_id }),
    agentId: row.agent_id,
    principalId: row.principal_id,
    agentPrincipalId: row.agent_principal_id,
    logicalDigest: row.logical_digest,
    contentHash: row.content_hash,
    rendererVersion: row.renderer_version,
    runtimeStateful: row.runtime_stateful,
    contextBoundarySeq: Number(row.context_boundary_seq),
    contextPolicyVersion: row.context_policy_version,
    contextUsageRatio: Number(row.context_usage_ratio),
    cursorBefore: Number(row.cursor_before),
    cursorAfter: Number(row.cursor_after),
    delivered: row.delivered,
    reused: row.reused,
    sourceRefs: row.source_refs,
    excluded: row.excluded,
    createdAt: row.created_at.toISOString(),
  };
}

function participantBindingFromRow(
  row: ParticipantBindingRow,
): SceneParticipantBinding {
  return {
    id: row.id,
    sceneType: row.scene_type,
    sceneId: row.scene_id,
    projectId: row.project_id,
    participantKind: row.participant_kind,
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    principalId: row.principal_id,
    status: row.status,
    revision: row.revision,
    joinedAt: row.joined_at.toISOString(),
    leftAt: row.left_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

function commitReceiptFromRow(
  row: CommitReceiptRow,
): SceneContextCommitReceipt {
  return {
    id: row.id,
    runId: row.run_id,
    contextPackId: row.context_pack_id,
    sceneSessionId: row.scene_session_id,
    contextBoundarySeq: Number(row.context_boundary_seq),
    previousContextSeq: Number(row.previous_context_seq),
    contextPolicyVersion: row.context_policy_version,
    contextUsageRatio: Number(row.context_usage_ratio),
    runtimeSuccess: row.runtime_success as true,
    committedAt: row.committed_at.toISOString(),
  };
}

export class SceneContextRepository {
  constructor(private readonly database: Database) {}

  async ensureParticipantBinding(input: {
    readonly sceneId: string;
    readonly projectId: string;
    readonly agentId: string;
    readonly agentPrincipalId: string;
    readonly principalId: string;
  }): Promise<SceneParticipantBinding> {
    const id = deterministicUuid("scene-participant-binding", [
      "group",
      input.sceneId,
      input.agentId,
      input.principalId,
    ].join(":"));
    const result = await this.database.query<ParticipantBindingRow>(
      `INSERT INTO scene_participant_bindings (
         id, scene_type, scene_id, project_id, participant_kind, agent_id,
         agent_principal_id, principal_id, status, revision, joined_at,
         left_at, updated_at
       ) VALUES (
         $1, 'group', $2, $3, 'ai', $4, $5, $6, 'active', 1, NOW(), NULL,
         NOW()
       )
       ON CONFLICT (scene_type, scene_id, agent_id, principal_id)
       DO UPDATE SET
         status = CASE
           WHEN scene_participant_bindings.status = 'removed'
             THEN scene_participant_bindings.status
           ELSE 'active'
         END,
         left_at = CASE
           WHEN scene_participant_bindings.status = 'removed'
             THEN scene_participant_bindings.left_at
           ELSE NULL
         END,
         revision = CASE
           WHEN scene_participant_bindings.status = 'active'
             THEN scene_participant_bindings.revision
           ELSE scene_participant_bindings.revision + 1
         END,
         updated_at = NOW()
       RETURNING *`,
      [
        id,
        input.sceneId,
        input.projectId,
        input.agentId,
        input.agentPrincipalId,
        input.principalId,
      ],
    );
    return participantBindingFromRow(result.rows[0]!);
  }

  async participantBinding(
    id: string,
  ): Promise<SceneParticipantBinding | undefined> {
    const result = await this.database.query<ParticipantBindingRow>(
      "SELECT * FROM scene_participant_bindings WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : participantBindingFromRow(row);
  }

  async listParticipantBindings(
    sceneId: string,
    projectId: string,
  ): Promise<SceneParticipantBinding[]> {
    const result = await this.database.query<ParticipantBindingRow>(
      `SELECT *
       FROM scene_participant_bindings
       WHERE scene_type = 'group'
         AND scene_id = $1
         AND project_id = $2
       ORDER BY joined_at, id`,
      [sceneId, projectId],
    );
    return result.rows.map(participantBindingFromRow);
  }

  async updateParticipantBinding(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly status: SceneParticipantBinding["status"];
    readonly actorId: string;
  }): Promise<SceneParticipantBinding | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<ParticipantBindingRow>(
        `UPDATE scene_participant_bindings
         SET status = $3,
             left_at = CASE
               WHEN $3 IN ('left', 'removed') THEN COALESCE(left_at, NOW())
               ELSE NULL
             END,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
           AND revision = $2
           AND NOT (status = 'removed' AND $3 <> 'removed')
         RETURNING *`,
        [input.id, input.expectedRevision, input.status],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      if (
        input.status === "paused" ||
        input.status === "left" ||
        input.status === "removed"
      ) {
        await client.query(
          `UPDATE scene_sessions
           SET status = 'reset',
               revision = revision + 1,
               updated_at = NOW()
           WHERE participant_binding_id = $1
             AND status IN ('preparing', 'active')`,
          [row.id],
        );
      }
      await appendAuditEventWithClient(client, {
        action: "group.scene.participant.updated",
        actorPrincipalId: input.actorId,
        metadata: {
          participantBindingId: row.id,
          sceneId: row.scene_id,
          projectId: row.project_id,
          agentId: row.agent_id,
          status: row.status,
          revision: row.revision,
        },
      });
      return participantBindingFromRow(row);
    });
  }

  async sessionForRun(runId: string): Promise<SceneSessionBinding | undefined> {
    const receipt = await this.database.query<SceneSessionRow>(
      `SELECT session.*
       FROM scene_context_receipts AS receipt
       JOIN scene_sessions AS session
         ON session.id = receipt.scene_session_id
       WHERE receipt.run_id = $1
       ORDER BY receipt.created_at DESC
       LIMIT 1`,
      [runId],
    );
    if (receipt.rows[0] !== undefined) {
      return sessionFromRow(receipt.rows[0]);
    }
    const attribution = await this.database.query<SceneSessionRow>(
      `SELECT session.*
       FROM teammate_run_attributions AS attribution
       JOIN scene_sessions AS session
         ON session.id = attribution.scene_session_id
       WHERE attribution.run_id = $1
       LIMIT 1`,
      [runId],
    );
    if (attribution.rows[0] !== undefined) {
      return sessionFromRow(attribution.rows[0]);
    }
    return undefined;
  }

  async ensureChatChannel(input: {
    readonly sceneId: string;
    readonly projectId: string | null;
    readonly ownerPrincipalId: string;
    readonly agentId: string;
    readonly agentPrincipalId: string | null;
  }): Promise<SceneChatChannel> {
    const channelKey = [
      "direct-chat",
      input.sceneId,
      input.ownerPrincipalId,
      input.agentId,
    ].join(":");
    const id = deterministicUuid("scene-chat-channel", channelKey);
    const result = await this.database.query<SceneChatChannelRow>(
      `INSERT INTO scene_chat_channels (
         id, channel_key, scene_type, scene_id, project_id,
         owner_principal_id, agent_id, agent_principal_id, status,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'direct-chat', $3, $4, $5, $6, $7, 'active', NOW(), NOW()
       )
       ON CONFLICT (scene_type, scene_id, owner_principal_id, agent_id)
       DO UPDATE SET
         status = 'active',
         agent_principal_id = EXCLUDED.agent_principal_id,
         updated_at = NOW()
       RETURNING *`,
      [
        id,
        channelKey,
        input.sceneId,
        input.projectId,
        input.ownerPrincipalId,
        input.agentId,
        input.agentPrincipalId,
      ],
    );
    return channelFromRow(result.rows[0]!);
  }

  async ensureSession(input: {
    readonly sceneType: SceneType;
    readonly sceneId: string;
    readonly projectId: string | null;
    readonly agentId: string;
    readonly agentPrincipalId: string | null;
    readonly ownerPrincipalId?: string | null;
    readonly delegationId?: string | null;
    readonly channelId?: string | null;
    readonly participantBindingId?: string | null;
  }): Promise<SceneSessionBinding> {
    return this.database.transaction(async (client) => {
      const principalScope =
        input.agentPrincipalId ?? input.ownerPrincipalId ?? "";
      const participantBindingId =
        input.participantBindingId ??
        (input.sceneType === "meeting" || input.sceneType === "group"
          ? undefined
          : null);
      const latest = await client.query<SceneSessionRow>(
        `SELECT * FROM scene_sessions
         WHERE scene_type = $1
           AND scene_id = $2
           AND agent_id = $3
           AND principal_scope = $4
           AND participant_binding_id IS NOT DISTINCT FROM $5::uuid
         ORDER BY generation DESC
         LIMIT 1
         FOR UPDATE`,
        [
          input.sceneType,
          input.sceneId,
          input.agentId,
          principalScope,
          participantBindingId ?? null,
        ],
      );
      const latestRow = latest.rows[0];
      if (
        latestRow?.status === "active" ||
        latestRow?.status === "preparing"
      ) {
        return sessionFromRow(latestRow);
      }
      const generation = latestRow === undefined ? 0 : latestRow.generation + 1;
      const identity = [
        input.sceneType,
        input.sceneId,
        input.agentId,
        principalScope,
        participantBindingId ?? "",
        generation,
      ].join(":");
      const id = deterministicUuid("scene-session", identity);
      await client.query<SceneSessionRow>(
        `INSERT INTO scene_sessions (
           id, scene_type, scene_id, project_id, agent_id,
           agent_principal_id, owner_principal_id, principal_scope, channel_id,
           delegation_id, participant_binding_id, session_handle, generation,
           status, revision, last_context_seq, context_usage_ratio,
           compaction_count, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, 'preparing', 1, 0, 0, 0, NOW(), NOW()
         )
         ON CONFLICT DO NOTHING`,
        [
          id,
          input.sceneType,
          input.sceneId,
          input.projectId,
          input.agentId,
          input.agentPrincipalId,
          input.ownerPrincipalId ?? null,
          principalScope,
          input.channelId ?? null,
          input.delegationId ?? null,
          participantBindingId ?? null,
          sessionHandle(
            input.sceneType,
            input.sceneId,
            input.agentId,
            generation,
          ),
          generation,
        ],
      );
      const result = await client.query<SceneSessionRow>(
        `SELECT * FROM scene_sessions
         WHERE scene_type = $1
           AND scene_id = $2
           AND agent_id = $3
           AND principal_scope = $4
           AND participant_binding_id IS NOT DISTINCT FROM $5::uuid
           AND generation = $6`,
        [
          input.sceneType,
          input.sceneId,
          input.agentId,
          principalScope,
          participantBindingId ?? null,
          generation,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new SceneContextRepositoryError(
          "scene_session_not_found",
          "Scene session could not be created",
        );
      }
      return sessionFromRow(row);
    });
  }

  async resetSceneSessions(input: {
    readonly sceneType: SceneType;
    readonly sceneId: string;
    readonly projectId: string | null;
    readonly reason: string;
    readonly actorId: string;
  }): Promise<{
    readonly previousSessionId: string | null;
    readonly sessions: SceneSessionBinding[];
  }> {
    return this.database.transaction(async (client) => {
      const active = await client.query<SceneSessionRow>(
        `SELECT * FROM scene_sessions
         WHERE scene_type = $1
           AND scene_id = $2
           AND project_id IS NOT DISTINCT FROM $3::uuid
           AND status IN ('preparing', 'active')
         ORDER BY generation DESC, id
         FOR UPDATE`,
        [input.sceneType, input.sceneId, input.projectId],
      );
      if (active.rows.length === 0) {
        return { previousSessionId: null, sessions: [] };
      }
      const sessions: SceneSessionBinding[] = [];
      for (const previous of active.rows) {
        await client.query(
          `UPDATE scene_sessions
           SET
             status = 'reset',
             reset_reason = $2,
             reset_by = $3,
             reset_at = NOW(),
             updated_at = NOW()
           WHERE id = $1
             AND status IN ('preparing', 'active')`,
          [previous.id, input.reason, input.actorId],
        );
        const generation = previous.generation + 1;
        const identity = [
          previous.scene_type,
          previous.scene_id,
          previous.agent_id,
          previous.principal_scope,
          previous.participant_binding_id ?? "",
          generation,
        ].join(":");
        const result = await client.query<SceneSessionRow>(
          `INSERT INTO scene_sessions (
             id, scene_type, scene_id, project_id, agent_id,
             agent_principal_id, owner_principal_id, principal_scope,
             channel_id, delegation_id, participant_binding_id, session_handle,
             generation, status, revision, last_context_seq,
             context_usage_ratio, compaction_count, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             'preparing', 1, 0, 0, 0, NOW(), NOW()
           )
           RETURNING *`,
          [
            deterministicUuid("scene-session", identity),
            previous.scene_type,
            previous.scene_id,
            previous.project_id,
            previous.agent_id,
            previous.agent_principal_id,
            previous.owner_principal_id,
            previous.principal_scope,
            previous.channel_id,
            previous.delegation_id,
            previous.participant_binding_id,
            sessionHandle(
              previous.scene_type,
              previous.scene_id,
              previous.agent_id,
              generation,
            ),
            generation,
          ],
        );
        sessions.push(sessionFromRow(result.rows[0]!));
      }
      return {
        previousSessionId: active.rows[0]!.id,
        sessions,
      };
    });
  }

  async session(id: string): Promise<SceneSessionBinding | undefined> {
    const result = await this.database.query<SceneSessionRow>(
      "SELECT * FROM scene_sessions WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : sessionFromRow(row);
  }

  async channel(id: string): Promise<SceneChatChannel | undefined> {
    const result = await this.database.query<SceneChatChannelRow>(
      "SELECT * FROM scene_chat_channels WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : channelFromRow(row);
  }

  async addContribution(input: {
    readonly session: SceneSessionBinding;
    readonly sourceKey: string;
    readonly kind: SceneContextContribution["kind"];
    readonly version: string;
    readonly authority: SceneContextContribution["authority"];
    readonly visibility: SceneContextContribution["visibility"];
    readonly text: string;
    readonly sourceRefs: readonly SceneSourceRef[];
    readonly createdBy: string;
    readonly ownerPrincipalId?: string | null;
  }): Promise<SceneContextContribution> {
    const id = deterministicUuid(
      "scene-context-contribution",
      [input.session.id, input.kind, input.sourceKey, input.version].join(":"),
    );
    await this.database.query(
      `INSERT INTO scene_context_contributions (
         id, scene_session_id, scene_type, scene_id, project_id, agent_id,
         agent_principal_id, owner_principal_id, source_key, kind, version,
         authority, visibility, text, source_refs, delegation_id, created_by,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb, $16, $17, NOW()
       )
       ON CONFLICT DO NOTHING`,
      [
        id,
        input.session.id,
        input.session.sceneType,
        input.session.sceneId,
        input.session.projectId,
        input.session.agentId,
        input.session.agentPrincipalId,
        input.ownerPrincipalId ?? input.session.ownerPrincipalId,
        input.sourceKey,
        input.kind,
        input.version,
        input.authority,
        input.visibility,
        input.text,
        JSON.stringify(input.sourceRefs),
        input.session.delegationId ?? null,
        input.createdBy,
      ],
    );
    const result = await this.database.query<SceneContributionRow>(
      `SELECT * FROM scene_context_contributions
       WHERE scene_session_id = $1
         AND source_key = $2
         AND version = $3`,
      [input.session.id, input.sourceKey, input.version],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new SceneContextRepositoryError(
        "scene_context_conflict",
        "Scene context contribution was not persisted",
      );
    }
    if (
      row.text !== input.text ||
      digest(stableJson(row.source_refs)) !==
        digest(stableJson(input.sourceRefs))
    ) {
      throw new SceneContextRepositoryError(
        "scene_context_conflict",
        "The same contribution version has different content",
        { contributionId: row.id, sourceKey: input.sourceKey },
      );
    }
    return contributionFromRow(row);
  }

  async listContributions(input: {
    readonly session: SceneSessionBinding;
    readonly actorPrincipalId: string;
  }): Promise<SceneContextContribution[]> {
    const result = await this.database.query<SceneContributionRow>(
      `SELECT * FROM scene_context_contributions
       WHERE scene_session_id = $1
         AND (
           visibility = 'scene'
           OR (
             visibility = 'project'
             AND project_id IS NOT DISTINCT FROM $2::uuid
           )
           OR (
             visibility = 'private'
             AND owner_principal_id = $3
             AND agent_principal_id IS NOT DISTINCT FROM $4::text
           )
         )
       ORDER BY delivery_sequence, id`,
      [
        input.session.id,
        input.session.projectId,
        input.actorPrincipalId,
        input.session.agentPrincipalId,
      ],
    );
    return result.rows.map(contributionFromRow);
  }

  async cursor(
    sessionId: string,
  ): Promise<SceneContextDeliveryCursor | undefined> {
    const result = await this.database.query<DeliveryCursorRow>(
      "SELECT * FROM scene_context_delivery_cursors WHERE scene_session_id = $1",
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : cursorFromRow(row);
  }

  async previousReceipt(
    sessionId: string,
    excludeRunId?: string,
  ): Promise<SceneContextReceipt | undefined> {
    const result = await this.database.query<SceneReceiptRow>(
      `SELECT * FROM scene_context_receipts
       WHERE scene_session_id = $1
         AND ($2::uuid IS NULL OR run_id <> $2::uuid)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sessionId, excludeRunId ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : receiptFromRow(row);
  }

  async receiptByRun(runId: string): Promise<SceneContextReceipt | undefined> {
    const result = await this.database.query<SceneReceiptRow>(
      "SELECT * FROM scene_context_receipts WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : receiptFromRow(row);
  }

  async snapshot(
    binding: SceneSessionBinding,
    actorPrincipalId: string,
    runId?: string,
  ): Promise<SceneContextSnapshot> {
    const [channel, cursor, receipt, contributions] = await Promise.all([
      binding.channelId === null
        ? Promise.resolve(undefined)
        : this.channel(binding.channelId),
      this.cursor(binding.id),
      runId === undefined
        ? Promise.resolve(undefined)
        : this.receiptByRun(runId),
      this.listContributions({ session: binding, actorPrincipalId }),
    ]);
    const commitReceipt =
      runId === undefined
        ? undefined
        : await this.commitReceiptByRun(runId);
    return {
      binding,
      channel: channel ?? null,
      cursor: cursor ?? null,
      receipt: receipt ?? null,
      commitReceipt: commitReceipt ?? null,
      contributions,
    };
  }

  async snapshotForRun(
    runId: string,
    actorPrincipalId: string,
  ): Promise<SceneContextSnapshot | undefined> {
    const receipt = await this.receiptByRun(runId);
    if (receipt === undefined) return undefined;
    const binding = await this.session(receipt.sceneSessionId);
    if (binding === undefined) return undefined;
    const snapshot = await this.snapshot(binding, actorPrincipalId, runId);
    return { ...snapshot, receipt };
  }

  async commitReceiptByRun(
    runId: string,
  ): Promise<SceneContextCommitReceipt | undefined> {
    const result = await this.database.query<CommitReceiptRow>(
      "SELECT * FROM scene_context_commit_receipts WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : commitReceiptFromRow(row);
  }

  async savePreparedDelivery(input: {
    readonly pack: ContextPack;
    readonly legacyReceipt: ContextReceipt;
    readonly receipt: SceneContextReceipt;
  }): Promise<SceneContextReceipt> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<SceneReceiptRow>(
        "SELECT * FROM scene_context_receipts WHERE run_id = $1",
        [input.receipt.runId],
      );
      if (existing.rows[0] !== undefined) {
        const persisted = receiptFromRow(existing.rows[0]);
        if (
          persisted.logicalDigest !== input.receipt.logicalDigest ||
          persisted.contentHash !== input.receipt.contentHash ||
          persisted.sceneSessionId !== input.receipt.sceneSessionId
        ) {
          throw new SceneContextRepositoryError(
            "scene_context_conflict",
            "A Run cannot prepare a different Scene context receipt",
            { runId: input.receipt.runId },
          );
        }
        return persisted;
      }
      const insertedPack = await client.query(
        `INSERT INTO context_packs (
           id, run_id, project_id, task_id, meeting_turn_id,
           direct_chat_turn_id, agent_id, pack, receipt, content_hash,
           created_at, scene_session_id, scene_type, scene_id,
           agent_principal_id, logical_digest, renderer_version, as_of,
           context_boundary_seq, context_policy_version,
           context_usage_ratio
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
         )
         ON CONFLICT (run_id) DO NOTHING
         RETURNING id`,
        [
          input.pack.id,
          input.pack.runId,
          input.pack.projectId,
          input.pack.taskId,
          input.pack.meetingTurnId,
          input.pack.directChatTurnId,
          input.pack.agentId,
          JSON.stringify(input.pack),
          JSON.stringify(input.legacyReceipt),
          input.pack.contentHash,
          input.pack.createdAt,
          input.pack.sceneSessionId,
          input.pack.sceneType,
          input.pack.sceneId,
          input.pack.agentPrincipalId ?? null,
          input.pack.logicalDigest ?? input.pack.contentHash,
          input.pack.rendererVersion ?? "scene-context-v1",
          input.pack.asOf ?? input.pack.createdAt,
          input.pack.contextBoundarySeq ?? input.receipt.contextBoundarySeq,
          input.pack.contextPolicyVersion ??
            input.receipt.contextPolicyVersion,
          input.pack.contextUsageRatio ?? input.receipt.contextUsageRatio,
        ],
      );
      if (insertedPack.rowCount === 0) {
        throw new SceneContextRepositoryError(
          "scene_context_conflict",
          "The Run already has a different ContextPack",
          { runId: input.receipt.runId },
        );
      }
      await client.query(
        "UPDATE runs SET context_pack_id = $2, updated_at = NOW() WHERE id = $1",
        [input.pack.runId, input.pack.id],
      );
      const insertedReceipt = await client.query<SceneReceiptRow>(
        `INSERT INTO scene_context_receipts (
           id, run_id, context_pack_id, scene_session_id, scene_type, scene_id,
           project_id, agent_id, principal_id, agent_principal_id,
           logical_digest, content_hash, renderer_version, runtime_stateful,
           context_boundary_seq, context_policy_version,
           context_usage_ratio, cursor_before, cursor_after, delivered,
           reused, source_refs, delegation_id, excluded, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20::jsonb, $21::jsonb, $22::jsonb, $23, $24::jsonb, $25
         )
         RETURNING *`,
        [
          input.receipt.id,
          input.receipt.runId,
          input.receipt.contextPackId,
          input.receipt.sceneSessionId,
          input.receipt.sceneType,
          input.receipt.sceneId,
          input.receipt.projectId,
          input.receipt.agentId,
          input.receipt.principalId,
          input.receipt.agentPrincipalId,
          input.receipt.logicalDigest,
          input.receipt.contentHash,
          input.receipt.rendererVersion,
          input.receipt.runtimeStateful,
          input.receipt.contextBoundarySeq,
          input.receipt.contextPolicyVersion,
          input.receipt.contextUsageRatio,
          input.receipt.cursorBefore,
          input.receipt.cursorAfter,
          JSON.stringify(input.receipt.delivered),
          JSON.stringify(input.receipt.reused),
          JSON.stringify(input.receipt.sourceRefs),
          input.receipt.delegationId ?? null,
          JSON.stringify(input.receipt.excluded),
          input.receipt.createdAt,
        ],
      );
      return receiptFromRow(insertedReceipt.rows[0]!);
    });
  }

  async commitConsumed(runId: string): Promise<SceneContextCommitReceipt> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<CommitReceiptRow>(
        "SELECT * FROM scene_context_commit_receipts WHERE run_id = $1",
        [runId],
      );
      if (existing.rows[0] !== undefined) {
        return commitReceiptFromRow(existing.rows[0]);
      }
      const receiptResult = await client.query<SceneReceiptRow>(
        "SELECT * FROM scene_context_receipts WHERE run_id = $1",
        [runId],
      );
      const receiptRow = receiptResult.rows[0];
      if (receiptRow === undefined) {
        throw new SceneContextRepositoryError(
          "scene_session_not_found",
          "Prepared Scene Context receipt is not available",
        );
      }
      const receipt = receiptFromRow(receiptRow);
      const sessionResult = await client.query<SceneSessionRow>(
        "SELECT * FROM scene_sessions WHERE id = $1 FOR UPDATE",
        [receipt.sceneSessionId],
      );
      const sessionRow = sessionResult.rows[0];
      if (sessionRow === undefined) {
        throw new SceneContextRepositoryError(
          "scene_session_not_found",
          "Scene session is unavailable",
        );
      }
      const session = sessionFromRow(sessionRow);
      if (session.lastContextSeq !== receipt.cursorBefore) {
        throw new SceneContextRepositoryError(
          "scene_context_cursor_conflict",
          "Scene context cursor changed before Runtime consumption committed",
          {
            expected: receipt.cursorBefore,
            actual: session.lastContextSeq,
          },
        );
      }
      const cursorResult = await client.query<DeliveryCursorRow>(
        `SELECT * FROM scene_context_delivery_cursors
         WHERE scene_session_id = $1
         FOR UPDATE`,
        [session.id],
      );
      const currentCursor = cursorResult.rows[0];
      const deliveredIds = [
        ...(currentCursor?.delivered_contribution_ids ?? []),
        ...receipt.delivered.map((contribution) => contribution.id),
      ].filter((value, index, values) => values.indexOf(value) === index);
      await client.query(
        `INSERT INTO scene_context_delivery_cursors (
           scene_session_id, cursor_sequence, delivered_contribution_ids,
           last_run_id, revision, updated_at
         ) VALUES ($1, $2, $3::uuid[], $4, 1, NOW())
         ON CONFLICT (scene_session_id) DO UPDATE SET
           cursor_sequence = EXCLUDED.cursor_sequence,
           delivered_contribution_ids = EXCLUDED.delivered_contribution_ids,
           last_run_id = EXCLUDED.last_run_id,
           revision = scene_context_delivery_cursors.revision + 1,
           updated_at = NOW()`,
        [
          session.id,
          receipt.contextBoundarySeq,
          deliveredIds,
          receipt.runId,
        ],
      );
      const compacted =
        receipt.contextUsageRatio >= 0.85 ? 1 : 0;
      await client.query(
        `UPDATE scene_sessions
         SET status = CASE WHEN status = 'preparing' THEN 'active' ELSE status END,
             last_context_seq = $2,
             context_usage_ratio = $3,
             compaction_count = compaction_count + $4,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [
          session.id,
          receipt.contextBoundarySeq,
          receipt.contextUsageRatio,
          compacted,
        ],
      );
      const inserted = await client.query<CommitReceiptRow>(
        `INSERT INTO scene_context_commit_receipts (
           id, run_id, context_pack_id, scene_session_id,
           context_boundary_seq, previous_context_seq,
           context_policy_version, context_usage_ratio, runtime_success,
           committed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW()
         )
         RETURNING *`,
        [
          deterministicUuid("scene-context-commit", runId),
          runId,
          receipt.contextPackId,
          session.id,
          receipt.contextBoundarySeq,
          receipt.cursorBefore,
          receipt.contextPolicyVersion,
          receipt.contextUsageRatio,
        ],
      );
      await appendAuditEventWithClient(client, {
        action: "context.committed",
        actorPrincipalId: receipt.principalId,
        metadata: {
          runId,
          contextPackId: receipt.contextPackId,
          sceneSessionId: session.id,
          contextBoundarySeq: receipt.contextBoundarySeq,
          previousContextSeq: receipt.cursorBefore,
          contextPolicyVersion: receipt.contextPolicyVersion,
          contextUsageRatio: receipt.contextUsageRatio,
        },
      });
      return commitReceiptFromRow(inserted.rows[0]!);
    });
  }

  async saveDelivery(input: {
    readonly pack: ContextPack;
    readonly legacyReceipt: ContextReceipt;
    readonly receipt: SceneContextReceipt;
  }): Promise<SceneContextReceipt> {
    const receipt = await this.savePreparedDelivery(input);
    await this.commitConsumed(receipt.runId);
    return receipt;
  }
}
