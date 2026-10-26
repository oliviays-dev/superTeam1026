import { randomUUID } from "node:crypto";
import type {
  AgentEpisode,
  AgentEpisodeKind,
  AgentEpisodeVisibility,
  CreateAgentEpisodeInput,
  CreateHandoffCardInput,
  HandoffCard,
  HandoffConfirmation,
  MemoryClaim,
  MemoryClaimReview,
  MemoryClaimStatus,
  MemoryReviewDecision,
  MemoryReviewQueueItem,
  MemoryReviewResult,
  MemoryReviewSelection,
  MemorySourceKind,
  MemorySourceRef,
  MemoryTopic,
  MeetingMemoryIngestionResult,
  UpdateHandoffCardInput,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import type { MemoryRepository } from "./collaboration-repositories.js";

interface MemoryClaimRow {
  id: string;
  topic_id: string;
  project_id: string;
  content: string;
  status: MemoryClaimStatus;
  source_type: string;
  source_id: string;
  version: number;
  source_refs: MemorySourceRef[];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemoryReviewRow {
  id: string;
  claim_id: string;
  project_id: string;
  decision: MemoryReviewDecision;
  reason: string;
  actor_id: string;
  from_status: MemoryClaimStatus;
  to_status: MemoryClaimStatus;
  claim_version: number;
  source_snapshot: MemorySourceRef[];
  created_at: Date;
}

interface MemoryReviewQueueRow extends MemoryClaimRow {
  topic_title: string;
}

interface HandoffRow {
  id: string;
  project_id: string;
  title: string;
  summary: string;
  status: HandoffCard["status"];
  version: number;
  source_refs: MemorySourceRef[];
  created_by: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface HandoffConfirmationRow {
  id: string;
  handoff_id: string;
  project_id: string;
  version: number;
  actor_id: string;
  snapshot: Record<string, unknown>;
  created_at: Date;
}

interface EpisodeRow {
  id: string;
  project_id: string;
  agent_id: string;
  visibility: AgentEpisodeVisibility;
  kind: AgentEpisodeKind;
  summary: string;
  content: string;
  source_refs: MemorySourceRef[];
  created_by: string;
  created_at: Date;
}

interface MeetingVersionIngestionRow {
  meeting_id: string;
  project_id: string;
  meeting_title: string;
  version_id: string;
  version: number;
  content: string;
  decisions: string[];
  source_message_ids: string[];
}

interface ActionTraceRow {
  id: string;
  title: string;
  task_id: string | null;
}

interface RunTraceRow {
  id: string;
  task_id: string;
  status: string;
}

interface ReviewTraceRow {
  id: string;
  task_id: string;
  decision: string;
}

export class MemoryReviewConflictError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "MemoryReviewConflictError";
  }
}

export class MemoryClosureRepository {
  constructor(
    private readonly database: Database,
    private readonly memory: MemoryRepository,
  ) {}

  async ingestMeetingMinutes(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly versionId?: string;
    readonly actorId: string;
  }): Promise<MeetingMemoryIngestionResult> {
    return this.database.transaction(async (client) => {
      const versionResult = await client.query<MeetingVersionIngestionRow>(
        input.versionId === undefined
          ? `SELECT
               meeting.id AS meeting_id,
               meeting.project_id,
               meeting.title AS meeting_title,
               version.id AS version_id,
               version.version,
               version.content,
               version.decisions,
               version.source_message_ids
             FROM meetings AS meeting
             JOIN projects AS project ON project.id = meeting.project_id
             JOIN meeting_minutes_versions AS version
               ON version.meeting_id = meeting.id
             WHERE meeting.id = $1
               AND meeting.project_id = $2
               AND project.status = 'active'
             ORDER BY version.version DESC
             LIMIT 1
             FOR SHARE OF meeting, project, version`
          : `SELECT
               meeting.id AS meeting_id,
               meeting.project_id,
               meeting.title AS meeting_title,
               version.id AS version_id,
               version.version,
               version.content,
               version.decisions,
               version.source_message_ids
             FROM meetings AS meeting
             JOIN projects AS project ON project.id = meeting.project_id
             JOIN meeting_minutes_versions AS version
               ON version.meeting_id = meeting.id
             WHERE meeting.id = $1
               AND meeting.project_id = $2
               AND version.id = $3
               AND project.status = 'active'
             FOR SHARE OF meeting, project, version`,
        [
          input.meetingId,
          input.projectId,
          ...(input.versionId === undefined ? [] : [input.versionId]),
        ],
      );
      const version = versionResult.rows[0];
      if (version === undefined) {
        throw new Error("meeting memory source not available");
      }

      const messageIds = version.source_message_ids;
      if (messageIds.length > 0) {
        const messages = await client.query<{ id: string }>(
          `SELECT id FROM meeting_messages
           WHERE meeting_id = $1 AND id = ANY($2::uuid[])`,
          [version.meeting_id, messageIds],
        );
        if (messages.rows.length !== new Set(messageIds).size) {
          throw new Error("meeting memory source message is unavailable");
        }
      }

      const topics = await client.query<{ id: string }>(
        `INSERT INTO memory_topics (
           id, project_id, title, origin_type, origin_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'meeting', $4, NOW(), NOW())
         ON CONFLICT (project_id, origin_type, origin_id)
           WHERE origin_type IS NOT NULL AND origin_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          version.project_id,
          `会议：${version.meeting_title}`,
          version.meeting_id,
        ],
      );
      const topicId =
        topics.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `SELECT id FROM memory_topics
             WHERE project_id = $1
               AND origin_type = 'meeting'
               AND origin_id = $2`,
            [version.project_id, version.meeting_id],
          )
        ).rows[0]?.id;
      if (topicId === undefined)
        throw new Error("meeting memory topic missing");

      const actions = await client.query<ActionTraceRow>(
        `SELECT id, title, task_id
         FROM meeting_action_items
         WHERE project_id = $1
           AND meeting_id = $2
           AND source_version_id = $3
         ORDER BY created_at, id`,
        [version.project_id, version.meeting_id, version.version_id],
      );
      const taskIds = actions.rows
        .map((row) => row.task_id)
        .filter((id): id is string => id !== null);
      const runs =
        taskIds.length === 0
          ? { rows: [] as RunTraceRow[], rowCount: 0 }
          : await client.query<RunTraceRow>(
              `SELECT id, task_id, status
               FROM runs
               WHERE project_id = $1 AND task_id = ANY($2::uuid[])
               ORDER BY created_at, id`,
              [version.project_id, taskIds],
            );
      const reviews =
        taskIds.length === 0
          ? { rows: [] as ReviewTraceRow[], rowCount: 0 }
          : await client.query<ReviewTraceRow>(
              `SELECT review.id, review.task_id, review.decision
               FROM task_reviews AS review
               JOIN tasks AS task ON task.id = review.task_id
               WHERE task.project_id = $1
                 AND review.task_id = ANY($2::uuid[])
               ORDER BY review.created_at, review.id`,
              [version.project_id, taskIds],
            );

      const sourceRefs: MemorySourceRef[] = [
        {
          kind: "meeting",
          id: version.meeting_id,
          projectId: version.project_id,
          label: version.meeting_title,
          available: true,
        },
        {
          kind: "minutes-version",
          id: version.version_id,
          projectId: version.project_id,
          label: `会议纪要 v${version.version}`,
          available: true,
        },
        ...messageIds.map((id) => ({
          kind: "meeting-message" as const,
          id,
          projectId: version.project_id,
          label: "会议来源消息",
          available: true,
        })),
        ...actions.rows.map((row) => ({
          kind: "action-item" as const,
          id: row.id,
          projectId: version.project_id,
          label: row.title,
          available: true,
        })),
        ...actions.rows
          .filter((row) => row.task_id !== null)
          .map((row) => ({
            kind: "task" as const,
            id: row.task_id!,
            projectId: version.project_id,
            label: `会议行动项任务`,
            available: true,
          })),
        ...runs.rows.map((row) => ({
          kind: "run" as const,
          id: row.id,
          projectId: version.project_id,
          label: `Run ${row.status}`,
          available: true,
        })),
        ...reviews.rows.map((row) => ({
          kind: "review" as const,
          id: row.id,
          projectId: version.project_id,
          label: `任务验收 ${row.decision}`,
          available: true,
        })),
      ];
      const claimTexts =
        version.decisions.length > 0
          ? version.decisions.map((decision, index) => ({
              key: `decision:${index}`,
              content: decision,
            }))
          : [{ key: "minutes", content: version.content.trim() }];

      const claimIds: string[] = [];
      let created = 0;
      for (const claimText of claimTexts) {
        if (claimText.content === "") continue;
        const dedupeKey = `meeting-minutes:${version.version_id}:${claimText.key}`;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO memory_claims (
             id, topic_id, project_id, content, status, source_type, source_id,
             version, dedupe_key, source_refs, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, 'proposed', 'meeting_minutes_version', $5,
             1, $6, $7::jsonb, NOW(), NOW()
           )
           ON CONFLICT (project_id, dedupe_key)
             WHERE dedupe_key IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            topicId,
            version.project_id,
            claimText.content,
            version.version_id,
            dedupeKey,
            JSON.stringify(sourceRefs),
          ],
        );
        if (inserted.rows[0] !== undefined) {
          claimIds.push(inserted.rows[0].id);
          created += 1;
          continue;
        }
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM memory_claims
           WHERE project_id = $1 AND dedupe_key = $2`,
          [version.project_id, dedupeKey],
        );
        if (existing.rows[0] !== undefined) {
          claimIds.push(existing.rows[0].id);
          await client.query(
            `UPDATE memory_claims
             SET source_refs = $2::jsonb, updated_at = NOW()
             WHERE project_id = $1 AND id = $3`,
            [
              version.project_id,
              JSON.stringify(sourceRefs),
              existing.rows[0].id,
            ],
          );
        }
      }
      await client.query(
        "UPDATE memory_topics SET updated_at = NOW() WHERE id = $1",
        [topicId],
      );
      return {
        meetingId: version.meeting_id,
        projectId: version.project_id,
        claimIds,
        created,
        reused: claimIds.length - created,
      };
    });
  }

  async listReviewQueue(projectId: string): Promise<MemoryReviewQueueItem[]> {
    const result = await this.database.query<MemoryReviewQueueRow>(
      `SELECT claim.*, topic.title AS topic_title
       FROM memory_claims AS claim
       JOIN memory_topics AS topic ON topic.id = claim.topic_id
       WHERE claim.project_id = $1
         AND claim.status = 'proposed'
       ORDER BY claim.created_at, claim.id`,
      [projectId],
    );
    return result.rows.map((row) => ({
      claim: memoryClaimFromRow(row),
      topicId: row.topic_id,
      topicTitle: row.topic_title,
    }));
  }

  async getClaim(
    projectId: string,
    claimId: string,
  ): Promise<MemoryClaim | undefined> {
    const result = await this.database.query<MemoryClaimRow>(
      "SELECT * FROM memory_claims WHERE project_id = $1 AND id = $2",
      [projectId, claimId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : memoryClaimFromRow(row);
  }

  async claimTrace(
    projectId: string,
    claimId: string,
  ): Promise<
    | {
        readonly claim: MemoryClaim;
        readonly topic: MemoryTopic;
        readonly reviews: MemoryClaimReview[];
        readonly sources: MemorySourceRef[];
      }
    | undefined
  > {
    const claim = await this.getClaim(projectId, claimId);
    if (claim === undefined) return undefined;
    const topics = await this.memory.list(projectId);
    const topic = topics.find((candidate) => candidate.id === claim.topicId);
    if (topic === undefined) return undefined;
    const reviews = await this.listClaimReviews(projectId, claimId);
    const dynamicSources = await this.claimLinkedSources(projectId, claim);
    const mergedSources = new Map(
      [...claim.sourceRefs, ...dynamicSources].map((ref) => [
        `${ref.kind}:${ref.id}`,
        ref,
      ]),
    );
    return {
      claim,
      topic,
      reviews,
      sources: await this.resolveSourceAvailability(projectId, [
        ...mergedSources.values(),
      ]),
    };
  }

  async reviewClaims(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly items: readonly MemoryReviewSelection[];
    readonly decision: MemoryReviewDecision;
    readonly reason: string;
  }): Promise<MemoryReviewResult> {
    const reviews = await this.database.transaction(async (client) => {
      const project = await client.query<{ status: string }>(
        "SELECT status FROM projects WHERE id = $1 FOR SHARE",
        [input.projectId],
      );
      if (project.rows[0]?.status !== "active") {
        throw new MemoryReviewConflictError("project archived");
      }
      const claimIds = input.items.map((item) => item.claimId);
      const claims = await client.query<MemoryClaimRow>(
        `SELECT * FROM memory_claims
         WHERE project_id = $1 AND id = ANY($2::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [input.projectId, claimIds],
      );
      if (claims.rows.length !== claimIds.length) {
        throw new MemoryReviewConflictError("memory review scope mismatch");
      }
      const expectedVersions = new Map(
        input.items.map((item) => [item.claimId, item.expectedVersion]),
      );
      const conflict = claims.rows.find(
        (claim) =>
          claim.status !== "proposed" ||
          claim.version !== expectedVersions.get(claim.id),
      );
      if (conflict !== undefined) {
        throw new MemoryReviewConflictError("memory review conflict", {
          claimId: conflict.id,
          status: conflict.status,
          version: conflict.version,
        });
      }
      const topicIds = [
        ...new Set(claims.rows.map((claim) => claim.topic_id)),
      ].sort();
      await client.query(
        "SELECT id FROM memory_topics WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [topicIds],
      );
      const reviewRows: MemoryReviewRow[] = [];
      const nextStatus = input.decision === "accept" ? "confirmed" : "rejected";
      for (const claim of claims.rows) {
        const reviewId = randomUUID();
        const updated = await client.query<MemoryClaimRow>(
          `UPDATE memory_claims
           SET
             status = $3,
             version = version + 1,
             reviewed_by = $4,
             reviewed_at = NOW(),
             updated_at = NOW()
           WHERE project_id = $1 AND id = $2
           RETURNING *`,
          [input.projectId, claim.id, nextStatus, input.actorId],
        );
        const updatedClaim = updated.rows[0]!;
        const inserted = await client.query<MemoryReviewRow>(
          `INSERT INTO memory_claim_reviews (
             id, claim_id, project_id, decision, reason, actor_id,
             from_status, to_status, claim_version, source_snapshot, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW()
           )
           RETURNING *`,
          [
            reviewId,
            claim.id,
            input.projectId,
            input.decision,
            input.reason,
            input.actorId,
            claim.status,
            nextStatus,
            updatedClaim.version,
            JSON.stringify(claim.source_refs),
          ],
        );
        reviewRows.push(inserted.rows[0]!);
      }
      if (input.decision === "accept") {
        for (const topicId of topicIds) {
          await this.publishReviewedTruth(
            client,
            input.projectId,
            topicId,
            input.decision,
            input.actorId,
          );
        }
      }
      return reviewRows;
    });
    const topics = await this.memory.list(input.projectId);
    const claimIds = new Set(input.items.map((item) => item.claimId));
    return {
      claims: topics
        .flatMap((topic) => topic.claims)
        .filter((claim) => claimIds.has(claim.id)),
      reviews: reviews.map(memoryReviewFromRow),
      topics: topics.filter((topic) =>
        topic.claims.some((claim) => claimIds.has(claim.id)),
      ),
    };
  }

  async updateLegacyClaimStatus(input: {
    readonly projectId: string;
    readonly topicId: string;
    readonly claimId: string;
    readonly status: MemoryClaimStatus;
    readonly actorId: string;
    readonly reason: string;
    readonly expectedVersion?: number;
  }): Promise<MemoryClaim | undefined> {
    if (input.status === "proposed") {
      const result = await this.database.query<MemoryClaimRow>(
        `UPDATE memory_claims
         SET
           status = 'proposed',
           version = version + 1,
           reviewed_by = NULL,
           reviewed_at = NULL,
           updated_at = NOW()
         WHERE project_id = $1
           AND topic_id = $2
           AND id = $3
           AND ($4::integer IS NULL OR version = $4)
         RETURNING *`,
        [
          input.projectId,
          input.topicId,
          input.claimId,
          input.expectedVersion ?? null,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : memoryClaimFromRow(row);
    }
    const claim = await this.getClaim(input.projectId, input.claimId);
    if (
      claim === undefined ||
      claim.topicId !== input.topicId ||
      claim.status !== "proposed"
    ) {
      throw new MemoryReviewConflictError("memory review conflict", {
        claimId: input.claimId,
        status: claim?.status ?? null,
        version: claim?.version ?? null,
      });
    }
    const result = await this.reviewClaims({
      projectId: input.projectId,
      actorId: input.actorId,
      items: [
        {
          claimId: input.claimId,
          expectedVersion: input.expectedVersion ?? claim.version,
        },
      ],
      decision: input.status === "confirmed" ? "accept" : "reject",
      reason:
        input.reason === ""
          ? "Status changed through the legacy claim endpoint"
          : input.reason,
    });
    return result.claims.find((candidate) => candidate.id === input.claimId);
  }

  async listClaimReviews(
    projectId: string,
    claimId: string,
  ): Promise<MemoryClaimReview[]> {
    const result = await this.database.query<MemoryReviewRow>(
      `SELECT * FROM memory_claim_reviews
       WHERE project_id = $1 AND claim_id = $2
       ORDER BY created_at DESC, id`,
      [projectId, claimId],
    );
    return result.rows.map(memoryReviewFromRow);
  }

  async listHandoffs(projectId: string): Promise<HandoffCard[]> {
    const rows = await this.database.query<HandoffRow>(
      `SELECT * FROM handoff_cards
       WHERE project_id = $1
       ORDER BY updated_at DESC, id`,
      [projectId],
    );
    if (rows.rowCount === 0) return [];
    const confirmations = await this.database.query<HandoffConfirmationRow>(
      `SELECT * FROM handoff_confirmations
       WHERE project_id = $1 AND handoff_id = ANY($2::uuid[])
       ORDER BY created_at DESC`,
      [projectId, rows.rows.map((row) => row.id)],
    );
    const byHandoff = new Map<string, HandoffConfirmation[]>();
    for (const row of confirmations.rows) {
      const items = byHandoff.get(row.handoff_id) ?? [];
      items.push(handoffConfirmationFromRow(row));
      byHandoff.set(row.handoff_id, items);
    }
    return Promise.all(
      rows.rows.map(async (row) =>
        handoffFromRow(
          {
            ...row,
            source_refs: await this.resolveSourceAvailability(
              projectId,
              row.source_refs,
            ),
          },
          byHandoff.get(row.id) ?? [],
        ),
      ),
    );
  }

  async getHandoff(
    projectId: string,
    handoffId: string,
  ): Promise<HandoffCard | undefined> {
    const handoffs = await this.listHandoffs(projectId);
    return handoffs.find((handoff) => handoff.id === handoffId);
  }

  async createHandoff(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly data: CreateHandoffCardInput;
  }): Promise<HandoffCard> {
    const sourceRefs = await this.resolveSourceRefs(
      input.projectId,
      input.data.sourceRefs,
    );
    const result = await this.database.query<HandoffRow>(
      `INSERT INTO handoff_cards (
         id, project_id, title, summary, status, version, source_refs,
         created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'draft', 1, $5::jsonb, $6, NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.data.title,
        input.data.summary,
        JSON.stringify(sourceRefs),
        input.actorId,
      ],
    );
    return handoffFromRow(result.rows[0]!, []);
  }

  async updateHandoff(input: {
    readonly projectId: string;
    readonly handoffId: string;
    readonly data: UpdateHandoffCardInput;
  }): Promise<HandoffCard | undefined> {
    const current = await this.getHandoff(input.projectId, input.handoffId);
    if (current === undefined) return undefined;
    if (current.status === "confirmed") {
      throw new MemoryReviewConflictError("handoff is confirmed");
    }
    const sourceRefs =
      input.data.sourceRefs === undefined
        ? undefined
        : await this.resolveSourceRefs(input.projectId, input.data.sourceRefs);
    const result = await this.database.query<HandoffRow>(
      `UPDATE handoff_cards
       SET
         title = COALESCE($4, title),
         summary = COALESCE($5, summary),
         source_refs = COALESCE($6::jsonb, source_refs),
         version = version + 1,
         updated_at = NOW()
       WHERE project_id = $1
         AND id = $2
         AND version = $3
         AND status = 'draft'
       RETURNING *`,
      [
        input.projectId,
        input.handoffId,
        input.data.expectedVersion,
        input.data.title ?? null,
        input.data.summary ?? null,
        sourceRefs === undefined ? null : JSON.stringify(sourceRefs),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new MemoryReviewConflictError("handoff version conflict");
    }
    return handoffFromRow(row, current.confirmations);
  }

  async confirmHandoff(input: {
    readonly projectId: string;
    readonly handoffId: string;
    readonly actorId: string;
    readonly expectedVersion: number;
  }): Promise<HandoffCard | undefined> {
    const found = await this.database.transaction(async (client) => {
      const locked = await client.query<HandoffRow>(
        `SELECT * FROM handoff_cards
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [input.projectId, input.handoffId],
      );
      const row = locked.rows[0];
      if (row === undefined) return undefined;
      if (row.status === "confirmed") {
        return true;
      }
      if (row.version !== input.expectedVersion) {
        throw new MemoryReviewConflictError("handoff version conflict");
      }
      const snapshot = {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        summary: row.summary,
        version: row.version,
        sourceRefs: row.source_refs,
      };
      await client.query(
        `INSERT INTO handoff_confirmations (
           id, handoff_id, project_id, version, actor_id, snapshot, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
        [
          randomUUID(),
          row.id,
          row.project_id,
          row.version,
          input.actorId,
          JSON.stringify(snapshot),
        ],
      );
      await client.query(
        `UPDATE handoff_cards
         SET
           status = 'confirmed',
           confirmed_by = $3,
           confirmed_at = NOW(),
           updated_at = NOW()
         WHERE project_id = $1 AND id = $2`,
        [input.projectId, input.handoffId, input.actorId],
      );
      return true;
    });
    return found === undefined
      ? undefined
      : this.getHandoff(input.projectId, input.handoffId);
  }

  async createEpisode(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly data: CreateAgentEpisodeInput;
  }): Promise<AgentEpisode> {
    const sources = await this.resolveSourceRefs(
      input.projectId,
      input.data.sourceRefs,
    );
    const result = await this.database.query<EpisodeRow>(
      `INSERT INTO agent_episodes (
         id, project_id, agent_id, visibility, kind, summary, content,
         source_refs, created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.data.agentId,
        input.data.visibility,
        input.data.kind,
        input.data.summary,
        input.data.content,
        JSON.stringify(sources),
        input.actorId,
      ],
    );
    return episodeFromRow(result.rows[0]!);
  }

  async listEpisodes(input: {
    readonly projectId: string;
    readonly agentId: string;
    readonly actorId: string;
  }): Promise<AgentEpisode[]> {
    const result = await this.database.query<EpisodeRow>(
      `SELECT * FROM agent_episodes
       WHERE project_id = $1
         AND agent_id = $2
         AND (
           visibility = 'project'
           OR ($2::text = $3::text AND visibility = 'private')
         )
       ORDER BY created_at DESC, id`,
      [input.projectId, input.agentId, input.actorId],
    );
    return result.rows.map(episodeFromRow);
  }

  async listEpisodesForContext(
    projectId: string,
    agentId: string,
  ): Promise<AgentEpisode[]> {
    const result = await this.database.query<EpisodeRow>(
      `SELECT * FROM agent_episodes
       WHERE project_id = $1
         AND agent_id = $2
         AND visibility IN ('private', 'project')
       ORDER BY created_at DESC, id
       LIMIT 30`,
      [projectId, agentId],
    );
    return result.rows.map(episodeFromRow);
  }

  private async publishReviewedTruth(
    client: PoolClient,
    projectId: string,
    topicId: string,
    decision: MemoryReviewDecision,
    actorId: string,
  ): Promise<void> {
    const claims = await client.query<MemoryClaimRow>(
      `SELECT * FROM memory_claims
       WHERE project_id = $1 AND topic_id = $2 AND status = 'confirmed'
       ORDER BY created_at, id`,
      [projectId, topicId],
    );
    if (claims.rows.length === 0) return;
    const version = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
       FROM memory_truths
       WHERE topic_id = $1`,
      [topicId],
    );
    const truthId = randomUUID();
    await client.query(
      `INSERT INTO memory_truths (
         id, topic_id, project_id, content, version, source_type, source_id,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, 'memory-review', $6, NOW())`,
      [
        truthId,
        topicId,
        projectId,
        claims.rows.map((claim) => claim.content).join("\n"),
        version.rows[0]!.version,
        `${decision}:${actorId}`,
      ],
    );
    for (const claim of claims.rows) {
      await client.query(
        `INSERT INTO memory_truth_claims (truth_id, claim_id)
         VALUES ($1, $2)`,
        [truthId, claim.id],
      );
    }
    await client.query(
      "UPDATE memory_topics SET updated_at = NOW() WHERE id = $1",
      [topicId],
    );
  }

  private async resolveSourceRefs(
    projectId: string,
    refs: readonly Omit<MemorySourceRef, "available">[],
  ): Promise<MemorySourceRef[]> {
    const normalized: MemorySourceRef[] = [];
    for (const ref of refs) {
      if (ref.projectId !== projectId) {
        throw new Error("cross project source reference");
      }
      const available = await this.sourceExists(projectId, ref.kind, ref.id);
      if (!available) throw new Error("handoff source not available");
      normalized.push({ ...ref, projectId, available: true });
    }
    return normalized;
  }

  private async sourceExists(
    projectId: string,
    kind: MemorySourceKind,
    id: string,
  ): Promise<boolean> {
    const query = sourceExistsSql(kind);
    const result = await this.database.query<{ id: string }>(query.sql, [
      projectId,
      id,
    ]);
    return result.rowCount === 1;
  }

  private async resolveSourceAvailability(
    projectId: string,
    refs: readonly MemorySourceRef[],
  ): Promise<MemorySourceRef[]> {
    return Promise.all(
      refs.map(async (ref) => ({
        ...ref,
        projectId,
        available:
          ref.projectId === projectId
            ? await this.sourceExists(projectId, ref.kind, ref.id)
            : false,
      })),
    );
  }

  private async claimLinkedSources(
    projectId: string,
    claim: MemoryClaim,
  ): Promise<MemorySourceRef[]> {
    if (claim.sourceType !== "meeting_minutes_version") return [];
    const version = await this.database.query<{
      id: string;
      meeting_id: string;
      version: number;
      meeting_title: string;
      source_message_ids: string[];
    }>(
      `SELECT
         version.id,
         version.meeting_id,
         version.version,
         meeting.title AS meeting_title,
         version.source_message_ids
       FROM meeting_minutes_versions AS version
       JOIN meetings AS meeting ON meeting.id = version.meeting_id
       WHERE version.project_id = $1 AND version.id = $2`,
      [projectId, claim.sourceId],
    );
    const source = version.rows[0];
    if (source === undefined) return [];
    const actions = await this.database.query<ActionTraceRow>(
      `SELECT id, title, task_id
       FROM meeting_action_items
       WHERE project_id = $1
         AND meeting_id = $2
         AND source_version_id = $3
       ORDER BY created_at, id`,
      [projectId, source.meeting_id, source.id],
    );
    const taskIds = actions.rows
      .map((row) => row.task_id)
      .filter((id): id is string => id !== null);
    const runs =
      taskIds.length === 0
        ? { rows: [] as RunTraceRow[], rowCount: 0 }
        : await this.database.query<RunTraceRow>(
            `SELECT id, task_id, status
             FROM runs
             WHERE project_id = $1 AND task_id = ANY($2::uuid[])
             ORDER BY created_at, id`,
            [projectId, taskIds],
          );
    const reviews =
      taskIds.length === 0
        ? { rows: [] as ReviewTraceRow[], rowCount: 0 }
        : await this.database.query<ReviewTraceRow>(
            `SELECT review.id, review.task_id, review.decision
             FROM task_reviews AS review
             JOIN tasks AS task ON task.id = review.task_id
             WHERE task.project_id = $1 AND review.task_id = ANY($2::uuid[])
             ORDER BY review.created_at, review.id`,
            [projectId, taskIds],
          );
    return [
      {
        kind: "meeting",
        id: source.meeting_id,
        projectId,
        label: source.meeting_title,
        available: true,
      },
      {
        kind: "minutes-version",
        id: source.id,
        projectId,
        label: `会议纪要 v${source.version}`,
        available: true,
      },
      ...source.source_message_ids.map((id) => ({
        kind: "meeting-message" as const,
        id,
        projectId,
        label: "会议来源消息",
        available: true,
      })),
      ...actions.rows.map((row) => ({
        kind: "action-item" as const,
        id: row.id,
        projectId,
        label: row.title,
        available: true,
      })),
      ...actions.rows
        .filter((row) => row.task_id !== null)
        .map((row) => ({
          kind: "task" as const,
          id: row.task_id!,
          projectId,
          label: "会议行动项任务",
          available: true,
        })),
      ...runs.rows.map((row) => ({
        kind: "run" as const,
        id: row.id,
        projectId,
        label: `Run ${row.status}`,
        available: true,
      })),
      ...reviews.rows.map((row) => ({
        kind: "review" as const,
        id: row.id,
        projectId,
        label: `任务验收 ${row.decision}`,
        available: true,
      })),
    ];
  }
}

function sourceExistsSql(kind: MemorySourceKind): { sql: string } {
  switch (kind) {
    case "meeting":
      return {
        sql: "SELECT id::text AS id FROM meetings WHERE project_id = $1 AND id::text = $2",
      };
    case "minutes-version":
      return {
        sql: "SELECT id::text AS id FROM meeting_minutes_versions WHERE project_id = $1 AND id::text = $2",
      };
    case "meeting-message":
      return {
        sql: `SELECT message.id::text AS id
              FROM meeting_messages AS message
              JOIN meetings AS meeting ON meeting.id = message.meeting_id
              WHERE meeting.project_id = $1 AND message.id::text = $2`,
      };
    case "action-item":
      return {
        sql: "SELECT id::text AS id FROM meeting_action_items WHERE project_id = $1 AND id::text = $2",
      };
    case "task":
      return {
        sql: "SELECT id::text AS id FROM tasks WHERE project_id = $1 AND id::text = $2",
      };
    case "run":
      return {
        sql: "SELECT id::text AS id FROM runs WHERE project_id = $1 AND id::text = $2",
      };
    case "review":
      return {
        sql: `SELECT review.id::text AS id
              FROM task_reviews AS review
              JOIN tasks AS task ON task.id = review.task_id
              WHERE task.project_id = $1 AND review.id::text = $2`,
      };
    case "memory-claim":
      return {
        sql: "SELECT id::text AS id FROM memory_claims WHERE project_id = $1 AND id::text = $2",
      };
    case "handoff":
      return {
        sql: "SELECT id::text AS id FROM handoff_cards WHERE project_id = $1 AND id::text = $2",
      };
    case "episode":
      return {
        sql: "SELECT id::text AS id FROM agent_episodes WHERE project_id = $1 AND id::text = $2",
      };
  }
}

function memoryClaimFromRow(row: MemoryClaimRow): MemoryClaim {
  return {
    id: row.id,
    topicId: row.topic_id,
    content: row.content,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    sourceRefs: row.source_refs,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function memoryReviewFromRow(row: MemoryReviewRow): MemoryClaimReview {
  return {
    id: row.id,
    claimId: row.claim_id,
    projectId: row.project_id,
    decision: row.decision,
    reason: row.reason,
    actorId: row.actor_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    claimVersion: row.claim_version,
    sourceSnapshot: row.source_snapshot,
    createdAt: row.created_at.toISOString(),
  };
}

function handoffConfirmationFromRow(
  row: HandoffConfirmationRow,
): HandoffConfirmation {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    projectId: row.project_id,
    version: row.version,
    actorId: row.actor_id,
    snapshot: row.snapshot,
    createdAt: row.created_at.toISOString(),
  };
}

function handoffFromRow(
  row: HandoffRow,
  confirmations: readonly HandoffConfirmation[],
): HandoffCard {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    version: row.version,
    sourceRefs: row.source_refs,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmations: [...confirmations],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function episodeFromRow(row: EpisodeRow): AgentEpisode {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    visibility: row.visibility,
    kind: row.kind,
    summary: row.summary,
    content: row.content,
    sourceRefs: row.source_refs,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
