import { randomUUID } from "node:crypto";
import type { TaskDetail } from "@pluginmax/contracts";
import type { FileRef } from "@pluginmax/files";
import type { Database } from "./database.js";

export type TaskActivity = TaskDetail["activity"][number];
export type TaskAttachment = TaskDetail["attachments"][number];

interface TaskActivityRow {
  id: string;
  task_id: string;
  kind: TaskActivity["kind"];
  actor_id: string;
  actor_name: string;
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

interface TaskAttachmentRow {
  id: string;
  task_id: string;
  project_id: string;
  name: string;
  mime_type: string;
  size: string;
  sha256: string;
  storage_key: string;
  uploaded_by: string;
  archived_at: Date | null;
  created_at: Date;
}

export class TaskCollaborationRepository {
  constructor(private readonly database: Database) {}

  async appendEvent(input: {
    readonly taskId: string;
    readonly kind: TaskActivity["kind"];
    readonly actorId: string;
    readonly actorName: string;
    readonly summary: string;
    readonly data?: Record<string, unknown> | null;
  }): Promise<TaskActivity> {
    const result = await this.database.query<TaskActivityRow>(
      `INSERT INTO task_events (
         id, task_id, kind, actor_id, actor_name, summary, data, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.taskId,
        input.kind,
        input.actorId,
        input.actorName,
        input.summary,
        input.data === undefined || input.data === null
          ? null
          : JSON.stringify(input.data),
      ],
    );
    return taskActivityFromRow(result.rows[0]!);
  }

  async listEvents(taskId: string): Promise<TaskActivity[]> {
    const result = await this.database.query<TaskActivityRow>(
      `SELECT * FROM task_events
       WHERE task_id = $1
       ORDER BY created_at, id`,
      [taskId],
    );
    return result.rows.map(taskActivityFromRow);
  }

  async saveAttachment(input: {
    readonly taskId: string;
    readonly projectId: string;
    readonly ref: FileRef;
    readonly uploadedBy: string;
  }): Promise<TaskAttachment> {
    const result = await this.database.query<TaskAttachmentRow>(
      `INSERT INTO task_attachments (
         id, task_id, project_id, name, mime_type, size,
         sha256, storage_key, uploaded_by, archived_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NOW()
       )
       RETURNING *`,
      [
        input.ref.id,
        input.taskId,
        input.projectId,
        input.ref.name,
        input.ref.mimeType,
        input.ref.size,
        input.ref.sha256,
        input.ref.storageKey,
        input.uploadedBy,
      ],
    );
    return taskAttachmentFromRow(result.rows[0]!);
  }

  async listAttachments(taskId: string): Promise<TaskAttachment[]> {
    const result = await this.database.query<TaskAttachmentRow>(
      `SELECT * FROM task_attachments
       WHERE task_id = $1
       ORDER BY created_at DESC, id`,
      [taskId],
    );
    return result.rows.map(taskAttachmentFromRow);
  }

  async getAttachment(id: string): Promise<TaskAttachment | undefined> {
    const result = await this.database.query<TaskAttachmentRow>(
      "SELECT * FROM task_attachments WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskAttachmentFromRow(row);
  }

  async setAttachmentArchived(
    id: string,
    archived: boolean,
  ): Promise<TaskAttachment | undefined> {
    const result = await this.database.query<TaskAttachmentRow>(
      `UPDATE task_attachments
       SET archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
       WHERE id = $1
       RETURNING *`,
      [id, archived],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskAttachmentFromRow(row);
  }
}

function taskActivityFromRow(row: TaskActivityRow): TaskActivity {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    actorId: row.actor_id,
    actorName: row.actor_name,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}

function taskAttachmentFromRow(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256,
    storageKey: row.storage_key,
    uploadedBy: row.uploaded_by,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
