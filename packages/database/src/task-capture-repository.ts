import { createHash, randomUUID } from "node:crypto";
import type {
  CreateTaskCaptureCandidateInput,
  CreateTaskCaptureSessionInput,
  CreateTaskDraftBatchInput,
  TaskCaptureCandidate,
  TaskCaptureSession,
  TaskDraft,
  TaskDraftBatch,
  TaskDraftCommitItem,
  TaskDraftCommitResult,
  TaskDraftInput,
  UpdateTaskDraftInput,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import {
  appendAuditEventWithClient,
  AuditEventRepository,
} from "./audit-event-repository.js";

interface CaptureSessionRow {
  id: string;
  project_id: string;
  source_type: TaskCaptureSession["sourceType"];
  source_id: string;
  source_version: string;
  owner_principal_id: string;
  status: TaskCaptureSession["status"];
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface CandidateRow {
  id: string;
  session_id: string;
  project_id: string;
  source_type: TaskCaptureCandidate["sourceType"];
  source_id: string;
  source_version: string;
  source_refs: TaskCaptureCandidate["sourceRefs"];
  excerpt: string;
  excerpt_hash: string;
  status: TaskCaptureCandidate["status"];
  invalidation_reason: string | null;
  invalidated_at: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface DraftRow {
  id: string;
  batch_id: string;
  session_id: string;
  candidate_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance: string[];
  priority: TaskDraft["priority"];
  agent_id: string | null;
  role_id: string | null;
  creation_key: string;
  status: TaskDraft["status"];
  revision: number;
  source_type: TaskDraft["sourceType"];
  source_id: string;
  source_version: string;
  excerpt_hash: string;
  invalidation_reason: string | null;
  invalidated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface BatchRow {
  id: string;
  session_id: string;
  project_id: string;
  status: TaskDraftBatch["status"];
  creation_key: string;
  revision: number;
  created_by_principal_id: string;
  result: {
    readonly status?: TaskDraftCommitResult["status"];
    readonly items?: readonly TaskDraftCommitItem[];
  };
  created_at: Date;
  updated_at: Date;
}

interface ConversionRow {
  id: string;
  draft_id: string;
  creation_key: string;
  status: "processing" | "committed" | "reused" | "failed";
  task_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt: number;
  created_at: Date;
  updated_at: Date;
}

export class TaskCaptureRepositoryError extends Error {
  constructor(
    readonly code:
      | "task_capture_session_not_found"
      | "task_capture_candidate_not_found"
      | "task_capture_batch_not_found"
      | "task_capture_draft_not_found"
      | "task_capture_revision_conflict"
      | "task_capture_candidate_invalid"
      | "task_capture_assignee_required",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TaskCaptureRepositoryError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function sessionFromRow(row: CaptureSessionRow): TaskCaptureSession {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function candidateFromRow(row: CandidateRow): TaskCaptureCandidate {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceRefs: row.source_refs,
    excerpt: row.excerpt,
    excerptHash: row.excerpt_hash,
    status: row.status,
    invalidationReason: row.invalidation_reason,
    invalidatedAt: row.invalidated_at?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function draftFromRow(row: DraftRow): TaskDraft {
  return {
    id: row.id,
    batchId: row.batch_id,
    sessionId: row.session_id,
    candidateId: row.candidate_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptance: row.acceptance,
    priority: row.priority,
    agentId: row.agent_id,
    roleId: row.role_id,
    creationKey: row.creation_key,
    status: row.status,
    revision: row.revision,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    excerptHash: row.excerpt_hash,
    invalidationReason: row.invalidation_reason,
    invalidatedAt: row.invalidated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function assertDraftInput(input: TaskDraftInput): void {
  if (input.agentId !== undefined && input.roleId !== undefined) {
    throw new TaskCaptureRepositoryError(
      "task_capture_assignee_required",
      "A draft cannot specify both agentId and roleId",
    );
  }
}

export class TaskCaptureRepository {
  private readonly auditEvents: AuditEventRepository;

  constructor(private readonly database: Database) {
    this.auditEvents = new AuditEventRepository(database);
  }

  async createSession(input: {
    readonly value: CreateTaskCaptureSessionInput;
    readonly actorId: string;
  }): Promise<TaskCaptureSession> {
    const id = deterministicUuid("task-capture-session", [
      input.value.projectId,
      input.value.sourceType,
      input.value.sourceId,
      input.value.sourceVersion,
      input.actorId,
    ].join(":"));
    const inserted = await this.database.query<CaptureSessionRow>(
      `INSERT INTO task_capture_sessions (
         id, project_id, source_type, source_id, source_version,
         owner_principal_id, status, revision, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, NOW(), NOW())
       ON CONFLICT (
         project_id, source_type, source_id, source_version, owner_principal_id
       ) DO UPDATE SET updated_at = task_capture_sessions.updated_at
       RETURNING *`,
      [
        id,
        input.value.projectId,
        input.value.sourceType,
        input.value.sourceId,
        input.value.sourceVersion,
        input.actorId,
      ],
    );
    const session = sessionFromRow(inserted.rows[0]!);
    await this.auditEvents.append({
      action: "task.capture.session.created",
      actorPrincipalId: input.actorId,
      metadata: {
        sessionId: session.id,
        projectId: session.projectId,
        sourceType: session.sourceType,
        sourceId: session.sourceId,
        sourceVersion: session.sourceVersion,
      },
    });
    return session;
  }

  async getSession(id: string): Promise<TaskCaptureSession | undefined> {
    const result = await this.database.query<CaptureSessionRow>(
      "SELECT * FROM task_capture_sessions WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : sessionFromRow(row);
  }

  async listCandidates(sessionId: string): Promise<TaskCaptureCandidate[]> {
    const result = await this.database.query<CandidateRow>(
      `SELECT *
       FROM task_capture_candidates
       WHERE session_id = $1
       ORDER BY created_at, id`,
      [sessionId],
    );
    return result.rows.map(candidateFromRow);
  }

  async getCandidate(
    candidateId: string,
  ): Promise<TaskCaptureCandidate | undefined> {
    const result = await this.database.query<CandidateRow>(
      "SELECT * FROM task_capture_candidates WHERE id = $1",
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : candidateFromRow(row);
  }

  async addCandidate(input: {
    readonly sessionId: string;
    readonly value: CreateTaskCaptureCandidateInput;
    readonly actorId: string;
  }): Promise<TaskCaptureCandidate> {
    const session = await this.getSession(input.sessionId);
    if (session === undefined) {
      throw new TaskCaptureRepositoryError(
        "task_capture_session_not_found",
        "Task Capture session not found",
      );
    }
    const excerptHash = digest(input.value.excerpt);
    const id = deterministicUuid("task-capture-candidate", [
      session.id,
      input.value.sourceId,
      input.value.sourceVersion,
      excerptHash,
    ].join(":"));
    const inserted = await this.database.query<CandidateRow>(
      `INSERT INTO task_capture_candidates (
         id, session_id, project_id, source_type, source_id, source_version,
         source_refs, excerpt, excerpt_hash, status, invalidation_reason,
         invalidated_at, revision, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'pending',
         NULL, NULL, 1, NOW(), NOW()
       )
       ON CONFLICT (session_id, source_id, source_version, excerpt_hash)
       DO UPDATE SET updated_at = task_capture_candidates.updated_at
       RETURNING *`,
      [
        id,
        session.id,
        session.projectId,
        session.sourceType,
        input.value.sourceId,
        input.value.sourceVersion,
        JSON.stringify(input.value.sourceRefs),
        input.value.excerpt,
        excerptHash,
      ],
    );
    const candidate = candidateFromRow(inserted.rows[0]!);
    await this.auditEvents.append({
      action: "task.capture.candidate.created",
      actorPrincipalId: input.actorId,
      metadata: {
        candidateId: candidate.id,
        sessionId: candidate.sessionId,
        sourceId: candidate.sourceId,
        sourceVersion: candidate.sourceVersion,
        excerptHash: candidate.excerptHash,
      },
    });
    return candidate;
  }

  async invalidateCandidate(input: {
    readonly candidateId: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly actorId: string;
  }): Promise<TaskCaptureCandidate | undefined> {
    const result = await this.database.query<CandidateRow>(
      `UPDATE task_capture_candidates
       SET status = 'invalidated',
           invalidation_reason = $3,
           invalidated_at = NOW(),
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1
         AND revision = $2
         AND status IN ('pending', 'drafting')
       RETURNING *`,
      [input.candidateId, input.expectedRevision, input.reason],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const candidate = candidateFromRow(row);
    await this.auditEvents.append({
      action: "task.capture.candidate.invalidated",
      actorPrincipalId: input.actorId,
      reason: input.reason,
      metadata: {
        candidateId: candidate.id,
        revision: candidate.revision,
        excerptHash: candidate.excerptHash,
      },
    });
    return candidate;
  }

  async createBatch(input: {
    readonly sessionId: string;
    readonly value: CreateTaskDraftBatchInput;
    readonly actorId: string;
  }): Promise<TaskDraftBatch> {
    const session = await this.getSession(input.sessionId);
    if (session === undefined) {
      throw new TaskCaptureRepositoryError(
        "task_capture_session_not_found",
        "Task Capture session not found",
      );
    }
    while (input.value.drafts.length > 0) {
      // Validation happens before opening the transaction so callers receive
      // deterministic contract errors instead of partial batches.
      input.value.drafts.forEach(assertDraftInput);
      break;
    }
    const candidateIds = [
      ...new Set(input.value.drafts.map((draft) => draft.candidateId)),
    ];
    const candidates = await this.database.query<CandidateRow>(
      `SELECT *
       FROM task_capture_candidates
       WHERE session_id = $1 AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [session.id, candidateIds],
    );
    const candidateById = new Map(
      candidates.rows.map((candidate) => [candidate.id, candidate]),
    );
    for (const candidateId of candidateIds) {
      const candidate = candidateById.get(candidateId);
      if (candidate === undefined) {
        throw new TaskCaptureRepositoryError(
          "task_capture_candidate_not_found",
          "A Task Capture candidate does not belong to the session",
          { candidateId },
        );
      }
      if (candidate.status === "invalidated") {
        throw new TaskCaptureRepositoryError(
          "task_capture_candidate_invalid",
          "An invalidated candidate cannot be converted into a Task draft",
          { candidateId },
        );
      }
    }
    const batchId = randomUUID();
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO task_draft_batches (
           id, session_id, project_id, status, creation_key, revision,
           created_by_principal_id, result, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'preparing', $4, 1, $5, '{}'::jsonb, NOW(), NOW()
         )`,
        [
          batchId,
          session.id,
          session.projectId,
          `task-capture-batch:${batchId}`,
          input.actorId,
        ],
      );
      for (const draft of input.value.drafts) {
        const candidate = candidateById.get(draft.candidateId)!;
        const draftId = randomUUID();
        await client.query(
          `INSERT INTO task_drafts (
             id, batch_id, session_id, candidate_id, project_id, title,
             description, acceptance, priority, agent_id, role_id,
             creation_key, status, revision, source_type, source_id,
             source_version, excerpt_hash, invalidation_reason, invalidated_at,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
             'draft', 1, $13, $14, $15, $16, NULL, NULL, NOW(), NOW()
           )`,
          [
            draftId,
            batchId,
            session.id,
            candidate.id,
            session.projectId,
            draft.title,
            draft.description,
            JSON.stringify(draft.acceptance),
            draft.priority,
            draft.agentId ?? null,
            draft.roleId ?? null,
            `task-capture-draft:${draftId}:v1`,
            candidate.source_type,
            candidate.source_id,
            candidate.source_version,
            candidate.excerpt_hash,
          ],
        );
        await client.query(
          `UPDATE task_capture_candidates
           SET status = 'drafting', revision = revision + 1, updated_at = NOW()
           WHERE id = $1 AND status = 'pending'`,
          [candidate.id],
        );
      }
      await appendAuditEventWithClient(client, {
        action: "task.capture.batch.created",
        actorPrincipalId: input.actorId,
        metadata: {
          batchId,
          sessionId: session.id,
          projectId: session.projectId,
          draftCount: input.value.drafts.length,
        },
      });
      return this.batchWithClient(client, batchId);
    });
  }

  async updateDraft(
    draftId: string,
    input: UpdateTaskDraftInput,
  ): Promise<TaskDraft | undefined> {
    const current = await this.database.query<DraftRow>(
      "SELECT * FROM task_drafts WHERE id = $1",
      [draftId],
    );
    const row = current.rows[0];
    if (
      row === undefined ||
      row.revision !== input.expectedRevision ||
      row.status !== "draft"
    ) {
      return undefined;
    }
    if (
      input.agentId !== undefined &&
      input.agentId !== null &&
      input.roleId !== undefined &&
      input.roleId !== null
    ) {
      throw new TaskCaptureRepositoryError(
        "task_capture_assignee_required",
        "A draft cannot specify both agentId and roleId",
      );
    }
    const result = await this.database.query<DraftRow>(
      `UPDATE task_drafts
       SET title = COALESCE($2, title),
           description = COALESCE($3, description),
           acceptance = COALESCE($4::jsonb, acceptance),
           priority = COALESCE($5, priority),
           agent_id = CASE
             WHEN $6::boolean THEN $7::uuid
             ELSE agent_id
           END,
           role_id = CASE
             WHEN $8::boolean THEN $9::uuid
             ELSE role_id
           END,
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1 AND revision = $10 AND status = 'draft'
       RETURNING *`,
      [
        draftId,
        input.title ?? null,
        input.description ?? null,
        input.acceptance === undefined
          ? null
          : JSON.stringify(input.acceptance),
        input.priority ?? null,
        input.agentId !== undefined,
        input.agentId ?? null,
        input.roleId !== undefined,
        input.roleId ?? null,
        input.expectedRevision,
      ],
    );
    const updated = result.rows[0];
    return updated === undefined ? undefined : draftFromRow(updated);
  }

  async getBatch(batchId: string): Promise<TaskDraftBatch | undefined> {
    const result = await this.database.query<BatchRow>(
      "SELECT * FROM task_draft_batches WHERE id = $1",
      [batchId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return this.batchFromRow(row);
  }

  async getDraft(draftId: string): Promise<TaskDraft | undefined> {
    const result = await this.database.query<DraftRow>(
      "SELECT * FROM task_drafts WHERE id = $1",
      [draftId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : draftFromRow(row);
  }

  async commitBatch(input: {
    readonly batchId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly assignees: Readonly<
      Record<string, { readonly agentId: string; readonly roleId?: string }>
    >;
    readonly assigneeErrors?: Readonly<Record<string, string>>;
  }): Promise<TaskDraftCommitResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`task-capture-batch:${input.batchId}`],
      );
      const batchResult = await client.query<BatchRow>(
        "SELECT * FROM task_draft_batches WHERE id = $1 FOR UPDATE",
        [input.batchId],
      );
      const batch = batchResult.rows[0];
      if (batch === undefined) {
        throw new TaskCaptureRepositoryError(
          "task_capture_batch_not_found",
          "Task Draft batch not found",
        );
      }
      const stored = parseStoredResult(batch);
      if (stored !== undefined) {
        return stored;
      }
      if (batch.revision !== input.expectedRevision) {
        throw new TaskCaptureRepositoryError(
          "task_capture_revision_conflict",
          "Task Draft batch changed before commit",
          { expectedRevision: input.expectedRevision, current: batch.revision },
        );
      }
      await client.query(
        `UPDATE task_draft_batches
         SET status = 'committing', revision = revision + 1, updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );
      const drafts = await client.query<DraftRow>(
        `SELECT *
         FROM task_drafts
         WHERE batch_id = $1
         ORDER BY created_at, id`,
        [batch.id],
      );
      const items: TaskDraftCommitItem[] = [];
      for (const draft of drafts.rows) {
        await client.query("SAVEPOINT task_capture_draft");
        try {
          if (draft.status === "invalidated" || draft.status === "discarded") {
            throw new TaskCaptureRepositoryError(
              "task_capture_candidate_invalid",
              "The Task draft is no longer committable",
            );
          }
          const candidate = await client.query<CandidateRow>(
            "SELECT * FROM task_capture_candidates WHERE id = $1 FOR UPDATE",
            [draft.candidate_id],
          );
          if (
            candidate.rows[0] === undefined ||
            candidate.rows[0].status === "invalidated" ||
            candidate.rows[0].source_version !== draft.source_version ||
            candidate.rows[0].excerpt_hash !== draft.excerpt_hash
          ) {
            throw new TaskCaptureRepositoryError(
              "task_capture_candidate_invalid",
              "The Task Capture source is no longer current",
            );
          }
          const assigneeError = input.assigneeErrors?.[draft.id];
          if (assigneeError !== undefined) {
            throw new Error(assigneeError);
          }
          const assignee = input.assignees[draft.id];
          if (assignee === undefined) {
            throw new TaskCaptureRepositoryError(
              "task_capture_assignee_required",
              "The Task draft has no resolved active assignee",
            );
          }
          const conversion = await client.query<ConversionRow>(
            `INSERT INTO task_draft_conversions (
               id, draft_id, creation_key, status, task_id, error_code,
               error_message, attempt, result, created_at, updated_at
             ) VALUES (
               $1, $2, $3, 'processing', NULL, NULL, NULL, 1, '{}'::jsonb,
               NOW(), NOW()
             )
             ON CONFLICT (draft_id) DO UPDATE SET
               status = 'processing',
               task_id = NULL,
               error_code = NULL,
               error_message = NULL,
               attempt = task_draft_conversions.attempt + 1,
               updated_at = NOW()
             RETURNING *`,
            [randomUUID(), draft.id, draft.creation_key],
          );
          const task = await createOrReuseCaptureTask(client, {
            draft,
            assignee,
            actorId: input.actorId,
          });
          await client.query(
            `INSERT INTO task_origins (
               task_id, source_kind, source_id, parent_task_id,
               root_task_id, created_by_principal_id, idempotency_key,
               metadata, created_at
             ) VALUES (
               $1, 'capture', $2, NULL, $1, $3, $4, $5::jsonb, NOW()
             )
             ON CONFLICT DO NOTHING`,
            [
              task.id,
              draft.id,
              input.actorId,
              `task-capture:${draft.id}`,
              JSON.stringify({
                batchId: batch.id,
                candidateId: draft.candidate_id,
                sourceType: draft.source_type,
                sourceId: draft.source_id,
                sourceVersion: draft.source_version,
                excerptHash: draft.excerpt_hash,
              }),
            ],
          );
          await client.query(
            `UPDATE task_drafts
             SET status = 'committed', revision = revision + 1, updated_at = NOW()
             WHERE id = $1`,
            [draft.id],
          );
          await client.query(
            `UPDATE task_capture_candidates
             SET status = 'converted', revision = revision + 1, updated_at = NOW()
             WHERE id = $1`,
            [draft.candidate_id],
          );
          const status = task.reused ? "reused" : "committed";
          await client.query(
            `UPDATE task_draft_conversions
             SET status = $2,
                 task_id = $3,
                 result = $4::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [
              conversion.rows[0]!.id,
              status,
              task.id,
              JSON.stringify({
                status: task.reused ? "reused" : "created",
                taskId: task.id,
              }),
            ],
          );
          items.push({
            draftId: draft.id,
            status: task.reused ? "reused" : "created",
            taskId: task.id,
            errorCode: null,
            errorMessage: null,
          });
          await client.query("RELEASE SAVEPOINT task_capture_draft");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT task_capture_draft");
          await client.query("RELEASE SAVEPOINT task_capture_draft");
          const code =
            error instanceof TaskCaptureRepositoryError
              ? error.code
              : "task_capture_commit_failed";
          const message =
            error instanceof Error ? error.message : "Task conversion failed";
          await client.query(
            `INSERT INTO task_draft_conversions (
               id, draft_id, creation_key, status, task_id, error_code,
               error_message, attempt, result, created_at, updated_at
             ) VALUES (
               $1, $2, $3, 'failed', NULL, $4, $5, 1, $6::jsonb, NOW(), NOW()
             )
             ON CONFLICT (draft_id) DO UPDATE SET
               status = 'failed',
               error_code = EXCLUDED.error_code,
               error_message = EXCLUDED.error_message,
               attempt = task_draft_conversions.attempt + 1,
               result = EXCLUDED.result,
               updated_at = NOW()`,
            [
              randomUUID(),
              draft.id,
              draft.creation_key,
              code,
              message.slice(0, 4_000),
              JSON.stringify({ status: "failed", errorCode: code }),
            ],
          );
          await client.query(
            `UPDATE task_drafts
             SET status = 'failed', revision = revision + 1, updated_at = NOW()
             WHERE id = $1`,
            [draft.id],
          );
          items.push({
            draftId: draft.id,
            status: "failed",
            taskId: null,
            errorCode: code,
            errorMessage: message,
          });
        }
      }
      const status: TaskDraftCommitResult["status"] =
        items.every((item) => item.status !== "failed")
          ? "committed"
          : items.every((item) => item.status === "failed")
            ? "failed"
            : "partial";
      const result: TaskDraftCommitResult = {
        batchId: batch.id,
        status,
        items,
      };
      await client.query(
        `UPDATE task_draft_batches
         SET status = $2,
             revision = revision + 1,
             result = $3::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [batch.id, status, JSON.stringify(result)],
      );
      await appendAuditEventWithClient(client, {
        action: "task.capture.batch.committed",
        actorPrincipalId: input.actorId,
        reason: status,
        metadata: {
          batchId: batch.id,
          projectId: batch.project_id,
          status,
          items,
        },
      });
      return result;
    });
  }

  private async batchWithClient(
    client: PoolClient,
    batchId: string,
  ): Promise<TaskDraftBatch> {
    const result = await client.query<BatchRow>(
      "SELECT * FROM task_draft_batches WHERE id = $1",
      [batchId],
    );
    return this.batchFromRow(result.rows[0]!, client);
  }

  private async batchFromRow(
    row: BatchRow,
    client?: PoolClient,
  ): Promise<TaskDraftBatch> {
    const drafts =
      client === undefined
        ? await this.database.query<DraftRow>(
            `SELECT *
             FROM task_drafts
             WHERE batch_id = $1
             ORDER BY created_at, id`,
            [row.id],
          )
        : await client.query<DraftRow>(
            `SELECT *
             FROM task_drafts
             WHERE batch_id = $1
             ORDER BY created_at, id`,
            [row.id],
          );
    return {
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      status: row.status,
      creationKey: row.creation_key,
      revision: row.revision,
      createdByPrincipalId: row.created_by_principal_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      drafts: drafts.rows.map(draftFromRow),
    };
  }
}

function parseStoredResult(batch: BatchRow): TaskDraftCommitResult | undefined {
  if (
    batch.result.status === undefined ||
    !Array.isArray(batch.result.items)
  ) {
    return undefined;
  }
  return {
    batchId: batch.id,
    status: batch.result.status,
    items: [...batch.result.items],
  };
}

async function createOrReuseCaptureTask(
  client: PoolClient,
  input: {
    readonly draft: DraftRow;
    readonly assignee: { readonly agentId: string; readonly roleId?: string };
    readonly actorId: string;
  },
): Promise<{ readonly id: string; readonly reused: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tasks (
       id, project_id, title, description, acceptance, status, agent_id,
       role_id, priority, auto_submit, auto_accept,
       auto_redispatch_on_return, creation_key, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8, TRUE, FALSE, FALSE,
       $9, NOW(), NOW()
     )
     ON CONFLICT (creation_key)
       WHERE creation_key IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.draft.project_id,
      input.draft.title,
      input.draft.description,
      JSON.stringify(input.draft.acceptance),
      input.assignee.agentId,
      input.assignee.roleId ?? null,
      input.draft.priority,
      input.draft.creation_key,
    ],
  );
  const taskId =
    inserted.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE creation_key = $1",
        [input.draft.creation_key],
      )
    ).rows[0]?.id;
  if (taskId === undefined) {
    throw new Error("Task Capture conversion did not create or reuse a Task");
  }
  const reused = inserted.rows[0] === undefined;
  if (reused) {
    const existing = await client.query<{
      project_id: string;
      title: string;
    }>("SELECT project_id, title FROM tasks WHERE id = $1", [taskId]);
    const row = existing.rows[0];
    if (
      row === undefined ||
      row.project_id !== input.draft.project_id ||
      row.title !== input.draft.title
    ) {
      throw new TaskCaptureRepositoryError(
        "task_capture_revision_conflict",
        "The stable creation key belongs to a different Task payload",
      );
    }
  } else {
    for (const [position, requirement] of input.draft.acceptance.entries()) {
      const itemId = deterministicUuid(
        "task-capture-acceptance",
        `${taskId}:${position}:${requirement}`,
      );
      const contentDigest = digest(requirement);
      await client.query(
        `INSERT INTO task_acceptance_items (
           id, task_id, position, requirement, required, current_revision,
           content_digest, deprecated_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, TRUE, 1, $5, NULL, NOW(), NOW())`,
        [itemId, taskId, position, requirement, contentDigest],
      );
      await client.query(
        `INSERT INTO task_acceptance_item_revisions (
           id, acceptance_item_id, revision, requirement, required,
           content_digest, superseded_at, created_at
         ) VALUES ($1, $2, 1, $3, TRUE, $4, NULL, NOW())`,
        [randomUUID(), itemId, requirement, contentDigest],
      );
    }
    await client.query(
      `INSERT INTO task_events (
         id, task_id, kind, actor_id, actor_name, summary, data, created_at
       ) VALUES (
         $1, $2, 'created', $3, $3, $4, $5::jsonb, NOW()
       )`,
      [
        randomUUID(),
        taskId,
        input.actorId,
        `从 Task Capture 草稿创建任务“${input.draft.title}”`,
        JSON.stringify({
          draftId: input.draft.id,
          creationKey: input.draft.creation_key,
        }),
      ],
    );
  }
  return { id: taskId, reused };
}
