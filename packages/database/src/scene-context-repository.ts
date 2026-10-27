import { createHash } from "node:crypto";
import type {
  ContextPack,
  ContextReceipt,
  SceneChatChannel,
  SceneContextContribution,
  SceneContextDeliveryCursor,
  SceneContextReceipt,
  SceneContextSnapshot,
  SceneSessionBinding,
  SceneSourceRef,
  SceneType,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface SceneSessionRow {
  id: string;
  scene_type: SceneType;
  scene_id: string;
  project_id: string | null;
  agent_id: string;
  agent_principal_id: string | null;
  owner_principal_id: string | null;
  channel_id: string | null;
  session_handle: string;
  generation: number;
  status: SceneSessionBinding["status"];
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
  agent_id: string;
  principal_id: string;
  agent_principal_id: string | null;
  logical_digest: string;
  content_hash: string;
  renderer_version: string;
  runtime_stateful: boolean;
  cursor_before: string;
  cursor_after: string;
  delivered: SceneContextReceipt["delivered"];
  reused: SceneContextReceipt["reused"];
  source_refs: SceneSourceRef[];
  excluded: SceneContextReceipt["excluded"];
  created_at: Date;
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
): string {
  const prefix =
    sceneType === "task"
      ? "de-task"
      : sceneType === "workflow-node"
        ? "de-flow"
        : sceneType === "meeting"
          ? "de-meeting"
          : "de-chat";
  const readable = sceneId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
  return `${prefix}-${readable}-${digest(`${sceneType}:${sceneId}:${agentId}`).slice(0, 16)}`.slice(
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
    agentId: row.agent_id,
    agentPrincipalId: row.agent_principal_id,
    ownerPrincipalId: row.owner_principal_id,
    channelId: row.channel_id,
    sessionHandle: row.session_handle,
    generation: row.generation,
    status: row.status,
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
    agentId: row.agent_id,
    principalId: row.principal_id,
    agentPrincipalId: row.agent_principal_id,
    logicalDigest: row.logical_digest,
    contentHash: row.content_hash,
    rendererVersion: row.renderer_version,
    runtimeStateful: row.runtime_stateful,
    cursorBefore: Number(row.cursor_before),
    cursorAfter: Number(row.cursor_after),
    delivered: row.delivered,
    reused: row.reused,
    sourceRefs: row.source_refs,
    excluded: row.excluded,
    createdAt: row.created_at.toISOString(),
  };
}

export class SceneContextRepository {
  constructor(private readonly database: Database) {}

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
    readonly channelId?: string | null;
  }): Promise<SceneSessionBinding> {
    const principalScope =
      input.agentPrincipalId ?? input.ownerPrincipalId ?? "";
    const identity = [
      input.sceneType,
      input.sceneId,
      input.agentId,
      principalScope,
      0,
    ].join(":");
    const id = deterministicUuid("scene-session", identity);
    await this.database.query<SceneSessionRow>(
      `INSERT INTO scene_sessions (
         id, scene_type, scene_id, project_id, agent_id,
         agent_principal_id, owner_principal_id, principal_scope, channel_id,
         session_handle, generation, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, 0, 'active', NOW(), NOW()
       )
       ON CONFLICT (scene_type, scene_id, agent_id, principal_scope, generation)
       DO NOTHING`,
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
        sessionHandle(input.sceneType, input.sceneId, input.agentId),
      ],
    );
    const result = await this.database.query<SceneSessionRow>(
      `SELECT * FROM scene_sessions
       WHERE scene_type = $1
         AND scene_id = $2
         AND agent_id = $3
         AND principal_scope = $4
         AND generation = 0`,
      [input.sceneType, input.sceneId, input.agentId, principalScope],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new SceneContextRepositoryError(
        "scene_session_not_found",
        "Scene session could not be created",
      );
    }
    return sessionFromRow(row);
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
         authority, visibility, text, source_refs, created_by, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb, $16, NOW()
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
    return {
      binding,
      channel: channel ?? null,
      cursor: cursor ?? null,
      receipt: receipt ?? null,
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

  async saveDelivery(input: {
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
            "A Run cannot commit a different Scene context receipt",
            { runId: input.receipt.runId },
          );
        }
        return persisted;
      }
      const cursor = await client.query<DeliveryCursorRow>(
        `SELECT * FROM scene_context_delivery_cursors
         WHERE scene_session_id = $1
         FOR UPDATE`,
        [input.receipt.sceneSessionId],
      );
      const currentCursor = cursor.rows[0];
      const currentSequence =
        currentCursor === undefined ? 0 : Number(currentCursor.cursor_sequence);
      if (currentSequence !== input.receipt.cursorBefore) {
        throw new SceneContextRepositoryError(
          "scene_context_cursor_conflict",
          "Scene context delivery cursor changed during assembly",
          {
            expected: input.receipt.cursorBefore,
            actual: currentSequence,
          },
        );
      }
      const insertedPack = await client.query(
        `INSERT INTO context_packs (
           id, run_id, project_id, task_id, meeting_turn_id,
           direct_chat_turn_id, agent_id, pack, receipt, content_hash,
           created_at, scene_session_id, scene_type, scene_id,
           agent_principal_id, logical_digest, renderer_version, as_of
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
           $11, $12, $13, $14, $15, $16, $17, $18
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
           cursor_before, cursor_after, delivered, reused, source_refs,
           excluded, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb,
           $19::jsonb, $20::jsonb, $21
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
          input.receipt.cursorBefore,
          input.receipt.cursorAfter,
          JSON.stringify(input.receipt.delivered),
          JSON.stringify(input.receipt.reused),
          JSON.stringify(input.receipt.sourceRefs),
          JSON.stringify(input.receipt.excluded),
          input.receipt.createdAt,
        ],
      );
      const deliveredIds = [
        ...(currentCursor?.delivered_contribution_ids ?? []),
        ...input.receipt.delivered.map((contribution) => contribution.id),
      ].filter((value, index, values) => values.indexOf(value) === index);
      await client.query(
        `INSERT INTO scene_context_delivery_cursors (
           scene_session_id, cursor_sequence, delivered_contribution_ids,
           last_run_id, revision, updated_at
         ) VALUES ($1, $2, $3::uuid[], $4, 1, NOW())
         ON CONFLICT (scene_session_id) DO UPDATE SET
           cursor_sequence =
             GREATEST(
               scene_context_delivery_cursors.cursor_sequence,
               EXCLUDED.cursor_sequence
             ),
           delivered_contribution_ids = EXCLUDED.delivered_contribution_ids,
           last_run_id = EXCLUDED.last_run_id,
           revision = scene_context_delivery_cursors.revision + 1,
           updated_at = NOW()`,
        [
          input.receipt.sceneSessionId,
          input.receipt.cursorAfter,
          deliveredIds,
          input.receipt.runId,
        ],
      );
      return receiptFromRow(insertedReceipt.rows[0]!);
    });
  }
}
