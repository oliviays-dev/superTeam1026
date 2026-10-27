import { randomUUID } from "node:crypto";
import type {
  MeetingActionItem,
  MeetingActionItemPriority,
  MeetingActionItemSourceType,
  MeetingActionItemStatus,
  MeetingMinutes,
  MeetingMinutesDraft,
  MeetingMinutesVersion,
  MeetingTraceability,
  Task,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface MeetingMinutesDraftRow {
  id: string;
  meeting_id: string;
  project_id: string;
  content: string;
  decisions: string[];
  source_message_ids: string[];
  revision: number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface MeetingMinutesVersionRow {
  id: string;
  meeting_id: string;
  project_id: string;
  version: number;
  content: string;
  decisions: string[];
  source_message_ids: string[];
  published_by: string;
  published_at: Date;
}

interface MeetingActionItemRow {
  id: string;
  meeting_id: string;
  project_id: string;
  title: string;
  description: string;
  owner_kind: MeetingActionItem["ownerKind"];
  owner_actor_id: string;
  owner_name: string;
  due_at: Date | null;
  priority: MeetingActionItemPriority;
  source_type: MeetingActionItemSourceType;
  source_id: string;
  source_version_id: string | null;
  source_message_ids: string[];
  status: MeetingActionItemStatus;
  dedupe_key: string;
  task_id: string | null;
  task_status: Task["status"] | null;
  assignee_agent_id: string | null;
  converted_by: string | null;
  converted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RunTraceRow {
  id: string;
  task_id: string;
  status: string;
  output: string | null;
  started_at: Date | null;
  ended_at: Date | null;
}

interface ReviewTraceRow {
  task_id: string;
  decision: "approve" | "return";
  note: string;
  actor_id: string;
  created_at: Date;
}

interface MemoryTraceRow {
  id: string;
  topic_id: string;
  content: string;
  source_type: string;
  source_id: string;
  created_at: Date;
}

export interface CreateMeetingActionItemRepositoryInput {
  readonly meetingId: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly ownerKind: MeetingActionItem["ownerKind"];
  readonly ownerActorId: string;
  readonly ownerName: string;
  readonly dueAt: string | null;
  readonly priority: MeetingActionItemPriority;
  readonly sourceType: MeetingActionItemSourceType;
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly sourceMessageIds: readonly string[];
  readonly dedupeKey: string;
}

export class MeetingDecisionsRepository {
  constructor(private readonly database: Database) {}

  async getMinutes(meetingId: string): Promise<MeetingMinutes | undefined> {
    const draft = await this.database.query<MeetingMinutesDraftRow>(
      "SELECT * FROM meeting_minutes_drafts WHERE meeting_id = $1",
      [meetingId],
    );
    if (draft.rows[0] === undefined) return undefined;
    const versions = await this.listMinutesVersions(meetingId);
    return {
      draft: meetingMinutesDraftFromRow(draft.rows[0]),
      versions,
    };
  }

  async listMinutesVersions(
    meetingId: string,
  ): Promise<MeetingMinutesVersion[]> {
    const result = await this.database.query<MeetingMinutesVersionRow>(
      `SELECT * FROM meeting_minutes_versions
       WHERE meeting_id = $1
       ORDER BY version DESC`,
      [meetingId],
    );
    return result.rows.map(meetingMinutesVersionFromRow);
  }

  async saveDraft(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly content: string;
    readonly decisions: readonly string[];
    readonly sourceMessageIds: readonly string[];
    readonly expectedRevision: number;
    readonly actorId: string;
  }): Promise<MeetingMinutesDraft | undefined> {
    const result = await this.database.query<MeetingMinutesDraftRow>(
      `UPDATE meeting_minutes_drafts
       SET
         content = $3,
         decisions = $4::jsonb,
         source_message_ids = $5::uuid[],
         revision = revision + 1,
         updated_by = $6,
         updated_at = NOW()
       WHERE meeting_id = $1
         AND project_id = $2
         AND revision = $7
       RETURNING *`,
      [
        input.meetingId,
        input.projectId,
        input.content,
        JSON.stringify(input.decisions),
        [...input.sourceMessageIds],
        input.actorId,
        input.expectedRevision,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingMinutesDraftFromRow(row);
  }

  async publish(input: {
    readonly meetingId: string;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  }): Promise<
    | {
        readonly minutes: MeetingMinutes;
        readonly version: MeetingMinutesVersion;
      }
    | undefined
  > {
    const versionId = await this.database.transaction(async (client) => {
      const draft = await client.query<MeetingMinutesDraftRow>(
        `SELECT * FROM meeting_minutes_drafts
         WHERE meeting_id = $1
         FOR UPDATE`,
        [input.meetingId],
      );
      const row = draft.rows[0];
      if (
        row === undefined ||
        row.project_id !== input.projectId ||
        row.revision !== input.expectedRevision
      ) {
        return undefined;
      }
      if (row.content.trim() === "") {
        throw new Error("meeting minutes content is empty");
      }
      const nextVersion = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
         FROM meeting_minutes_versions
         WHERE meeting_id = $1`,
        [input.meetingId],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO meeting_minutes_versions (
           id, meeting_id, project_id, version, content, decisions,
           source_message_ids, published_by, published_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid[], $8, NOW())`,
        [
          id,
          input.meetingId,
          input.projectId,
          nextVersion.rows[0]!.version,
          row.content,
          JSON.stringify(row.decisions),
          row.source_message_ids,
          input.actorId,
        ],
      );
      await client.query(
        `UPDATE meeting_minutes_drafts
         SET revision = revision + 1, updated_by = $2, updated_at = NOW()
         WHERE meeting_id = $1`,
        [input.meetingId, input.actorId],
      );
      await client.query(
        `UPDATE meetings
         SET summary = $2, updated_at = NOW()
         WHERE id = $1`,
        [input.meetingId, row.content],
      );
      return id;
    });
    if (versionId === undefined) return undefined;
    const minutes = await this.getMinutes(input.meetingId);
    if (minutes === undefined) throw new Error("published minutes are missing");
    const version = minutes.versions.find((item) => item.id === versionId);
    if (version === undefined) throw new Error("published version is missing");
    return { minutes, version };
  }

  async listActionItems(meetingId: string): Promise<MeetingActionItem[]> {
    const result = await this.database.query<MeetingActionItemRow>(
      `${this.actionItemSelectSql}
       WHERE item.meeting_id = $1
       ORDER BY
         CASE item.status
           WHEN 'open' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'done' THEN 2
           ELSE 3
         END,
         item.created_at`,
      [meetingId],
    );
    return result.rows.map(meetingActionItemFromRow);
  }

  async getActionItem(
    meetingId: string,
    actionItemId: string,
  ): Promise<MeetingActionItem | undefined> {
    const result = await this.database.query<MeetingActionItemRow>(
      `${this.actionItemSelectSql}
       WHERE item.meeting_id = $1 AND item.id = $2`,
      [meetingId, actionItemId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingActionItemFromRow(row);
  }

  async createActionItem(
    input: CreateMeetingActionItemRepositoryInput,
  ): Promise<MeetingActionItem> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO meeting_action_items (
         id, meeting_id, project_id, title, description, owner_kind,
         owner_actor_id, owner_name, due_at, priority, source_type,
         source_id, source_version_id, source_message_ids, status,
         dedupe_key, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14::uuid[], 'open', $15, NOW(), NOW()
       )`,
      [
        id,
        input.meetingId,
        input.projectId,
        input.title,
        input.description,
        input.ownerKind,
        input.ownerActorId,
        input.ownerName,
        input.dueAt,
        input.priority,
        input.sourceType,
        input.sourceId,
        input.sourceVersionId,
        [...input.sourceMessageIds],
        input.dedupeKey,
      ],
    );
    const item = await this.getActionItem(input.meetingId, id);
    if (item === undefined) throw new Error("created action item is missing");
    return item;
  }

  async updateActionItemStatus(
    meetingId: string,
    actionItemId: string,
    status: MeetingActionItemStatus,
  ): Promise<MeetingActionItem | undefined> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE meeting_action_items
       SET status = $3, updated_at = NOW()
       WHERE meeting_id = $1 AND id = $2 AND task_id IS NULL
       RETURNING id`,
      [meetingId, actionItemId, status],
    );
    if (result.rowCount === 0) return undefined;
    return this.getActionItem(meetingId, actionItemId);
  }

  async convertActionItem(input: {
    readonly meetingId: string;
    readonly actionItemId: string;
    readonly projectId: string;
    readonly assigneeAgentId: string;
    readonly actorId: string;
  }): Promise<{ readonly taskId: string; readonly reused: boolean }> {
    return this.database.transaction(async (client) => {
      const item = await client.query<MeetingActionItemRow>(
        `SELECT * FROM meeting_action_items
         WHERE meeting_id = $1 AND id = $2 AND project_id = $3
         FOR UPDATE`,
        [input.meetingId, input.actionItemId, input.projectId],
      );
      const row = item.rows[0];
      if (row === undefined) throw new Error("action item not found");
      if (row.task_id !== null) {
        return { taskId: row.task_id, reused: true };
      }
      if (row.status === "cancelled") {
        throw new Error("cancelled action item cannot be converted");
      }
      const project = await client.query<{ status: string }>(
        "SELECT status FROM projects WHERE id = $1 FOR SHARE",
        [input.projectId],
      );
      if (project.rows[0]?.status !== "active") {
        throw new Error("project archived");
      }
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO tasks (
           id, project_id, title, description, acceptance, status,
           agent_id, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, 'queued', $6, NOW(), NOW()
         )`,
        [
          taskId,
          input.projectId,
          row.title,
          row.description,
          JSON.stringify([
            "行动项交付结果可核验",
            "保留会议、纪要和来源消息追溯",
          ]),
          input.assigneeAgentId,
        ],
      );
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES (
           $1, $2, 'created', $3, 'Local Admin', $4, $5::jsonb, NOW()
         )`,
        [
          randomUUID(),
          taskId,
          input.actorId,
          `从会议行动项“${row.title}”创建任务`,
          JSON.stringify({
            meetingId: input.meetingId,
            actionItemId: input.actionItemId,
            minutesVersionId: row.source_version_id,
            sourceMessageIds: row.source_message_ids,
          }),
        ],
      );
      await client.query(
        `UPDATE meeting_action_items
         SET
           task_id = $3,
           status = 'in_progress',
           converted_by = $4,
           converted_at = NOW(),
           updated_at = NOW()
         WHERE meeting_id = $1 AND id = $2`,
        [input.meetingId, input.actionItemId, taskId, input.actorId],
      );
      await client.query(
        `INSERT INTO meeting_tasks (
           id, meeting_id, project_id, task_id, source_type, source_id,
           idempotency_key, created_by, created_at
         ) VALUES (
           $1, $2, $3, $4, 'action_item', $5, $6, $7, NOW()
         )
         ON CONFLICT (meeting_id, idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.meetingId,
          input.projectId,
          taskId,
          input.actionItemId,
          `action-item:${input.actionItemId}`,
          input.actorId,
        ],
      );
      return { taskId, reused: false };
    });
  }

  async syncTaskStatus(taskId: string, status: Task["status"]): Promise<void> {
    const actionStatus =
      status === "done"
        ? "done"
        : status === "cancelled"
          ? "cancelled"
          : "in_progress";
    await this.database.query(
      `UPDATE meeting_action_items
       SET status = $2, updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, actionStatus],
    );
  }

  async traceability(meetingId: string): Promise<MeetingTraceability> {
    const items = await this.listActionItems(meetingId);
    const taskIds = items
      .map((item) => item.taskId)
      .filter((taskId): taskId is string => taskId !== null);
    let runRows: RunTraceRow[] = [];
    let reviewRows: ReviewTraceRow[] = [];
    let memoryRows: MemoryTraceRow[] = [];
    if (taskIds.length > 0) {
      const [runs, reviews, memories] = await Promise.all([
        this.database.query<RunTraceRow>(
          `SELECT id, task_id, status, output, started_at, ended_at
           FROM runs
           WHERE task_id = ANY($1::uuid[])
           ORDER BY created_at`,
          [taskIds],
        ),
        this.database.query<ReviewTraceRow>(
          `SELECT task_id, decision, note, actor_id, created_at
           FROM task_reviews
           WHERE task_id = ANY($1::uuid[])
           ORDER BY created_at`,
          [taskIds],
        ),
        this.database.query<MemoryTraceRow>(
          `SELECT id, topic_id, content, source_type, source_id, created_at
           FROM memory_truths
           WHERE source_type = 'task'
             AND source_id = ANY($1::text[])
           ORDER BY created_at`,
          [taskIds],
        ),
      ]);
      runRows = runs.rows;
      reviewRows = reviews.rows;
      memoryRows = memories.rows;
    }
    const runsByTask = new Map<string, RunTraceRow[]>();
    for (const run of runRows) {
      const list = runsByTask.get(run.task_id) ?? [];
      list.push(run);
      runsByTask.set(run.task_id, list);
    }
    const reviewsByTask = new Map<string, ReviewTraceRow[]>();
    for (const review of reviewRows) {
      const list = reviewsByTask.get(review.task_id) ?? [];
      list.push(review);
      reviewsByTask.set(review.task_id, list);
    }
    const memoriesByTask = new Map<string, MemoryTraceRow[]>();
    for (const memory of memoryRows) {
      const list = memoriesByTask.get(memory.source_id) ?? [];
      list.push(memory);
      memoriesByTask.set(memory.source_id, list);
    }
    const projectId = items[0]?.projectId;
    if (projectId === undefined) {
      const meeting = await this.database.query<{ project_id: string }>(
        "SELECT project_id FROM meetings WHERE id = $1",
        [meetingId],
      );
      if (meeting.rows[0] === undefined) {
        throw new Error("meeting not found");
      }
      return {
        meetingId,
        projectId: meeting.rows[0].project_id,
        minutesVersions: (await this.listMinutesVersions(meetingId)).map(
          (version) => ({
            id: version.id,
            version: version.version,
            publishedAt: version.publishedAt,
          }),
        ),
        actionItems: [],
      };
    }
    return {
      meetingId,
      projectId,
      minutesVersions: (await this.listMinutesVersions(meetingId)).map(
        (version) => ({
          id: version.id,
          version: version.version,
          publishedAt: version.publishedAt,
        }),
      ),
      actionItems: items.map((item) => ({
        ...item,
        runs:
          item.taskId === null
            ? []
            : (runsByTask.get(item.taskId) ?? []).map((run) => ({
                id: run.id,
                status: run.status,
                output: run.output,
                startedAt: run.started_at?.toISOString() ?? null,
                endedAt: run.ended_at?.toISOString() ?? null,
              })),
        reviews:
          item.taskId === null
            ? []
            : (reviewsByTask.get(item.taskId) ?? []).map((review) => ({
                decision: review.decision,
                note: review.note,
                actorId: review.actor_id,
                createdAt: review.created_at.toISOString(),
              })),
        memories:
          item.taskId === null
            ? []
            : (memoriesByTask.get(item.taskId) ?? []).map((memory) => ({
                id: memory.id,
                topicId: memory.topic_id,
                content: memory.content,
                sourceType: memory.source_type,
                sourceId: memory.source_id,
                createdAt: memory.created_at.toISOString(),
              })),
      })),
    };
  }

  private readonly actionItemSelectSql = `SELECT
    item.*,
    task.status AS task_status,
    task.agent_id AS assignee_agent_id
  FROM meeting_action_items AS item
  LEFT JOIN tasks AS task ON task.id = item.task_id`;
}

function meetingMinutesDraftFromRow(
  row: MeetingMinutesDraftRow,
): MeetingMinutesDraft {
  return {
    meetingId: row.meeting_id,
    projectId: row.project_id,
    content: row.content,
    decisions: row.decisions,
    sourceMessageIds: row.source_message_ids,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function meetingMinutesVersionFromRow(
  row: MeetingMinutesVersionRow,
): MeetingMinutesVersion {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    version: row.version,
    content: row.content,
    decisions: row.decisions,
    sourceMessageIds: row.source_message_ids,
    publishedBy: row.published_by,
    publishedAt: row.published_at.toISOString(),
  };
}

function meetingActionItemFromRow(
  row: MeetingActionItemRow,
): MeetingActionItem {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    ownerKind: row.owner_kind,
    ownerActorId: row.owner_actor_id,
    ownerName: row.owner_name,
    dueAt: row.due_at?.toISOString() ?? null,
    priority: row.priority,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    sourceMessageIds: row.source_message_ids,
    status: row.status,
    dedupeKey: row.dedupe_key,
    taskId: row.task_id,
    taskStatus: row.task_status,
    assigneeAgentId: row.assignee_agent_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
