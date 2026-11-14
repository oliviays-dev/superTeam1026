import { createHash, randomUUID } from "node:crypto";
import type {
  AcceptanceEvidenceRef,
  TaskAcceptanceConfirmation,
  TaskAcceptanceItem,
  TaskAnomalyMode,
  TaskEvidenceReviewMode,
  TaskExecutionAnomaly,
  TaskExecutionAnomalyCode,
  TaskFeatureFlagMode,
  TaskFeatureFlagSetting,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface FeatureFlagRow {
  flag_key: string;
  scope_type: "platform" | "project";
  scope_id: string;
  mode: TaskFeatureFlagMode;
  revision: number;
  updated_by: string;
  updated_at: Date;
}

interface AcceptanceItemRow {
  id: string;
  task_id: string;
  position: number;
  requirement: string;
  required: boolean;
  current_revision: number;
  content_digest: string;
  deprecated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AcceptanceConfirmationRow {
  id: string;
  acceptance_item_id: string;
  acceptance_item_revision: number;
  task_id: string;
  run_id: string;
  run_attempt: number;
  confirmed_by_principal_id: string;
  confirmation_tool: "task_submit_deliverable";
  evidence_refs: AcceptanceEvidenceRef[];
  confirmed_at: Date;
  superseded_at: Date | null;
  superseded_reason: string | null;
}

interface AnomalyRow {
  id: string;
  task_id: string;
  code: TaskExecutionAnomalyCode;
  message: string;
  run_id: string | null;
  run_attempt: number | null;
  event_id: string | null;
  status: "active" | "cleared";
  occurrence: number;
  detected_at: Date;
  cleared_at: Date | null;
  cleared_reason: string | null;
  revision: number;
}

const DEFAULT_MODES = {
  "task.evidence_review": "observe",
  "task.anomaly": "off",
  "agent.task_tools": "off",
  "agent.workspace_files": "off",
  "project.ai_pm": "off",
} as const satisfies Readonly<Record<string, TaskFeatureFlagMode>>;

function featureFlagFromRow(row: FeatureFlagRow): TaskFeatureFlagSetting {
  return {
    flagKey: row.flag_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    mode: row.mode,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function acceptanceItemFromRow(row: AcceptanceItemRow): TaskAcceptanceItem {
  return {
    id: row.id,
    taskId: row.task_id,
    position: row.position,
    requirement: row.requirement,
    required: row.required,
    revision: row.current_revision,
    contentDigest: row.content_digest,
    deprecatedAt: row.deprecated_at?.toISOString() ?? null,
  };
}

function acceptanceConfirmationFromRow(
  row: AcceptanceConfirmationRow,
): TaskAcceptanceConfirmation {
  return {
    id: row.id,
    acceptanceItemId: row.acceptance_item_id,
    acceptanceItemRevision: row.acceptance_item_revision,
    taskId: row.task_id,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    confirmedByPrincipalId: row.confirmed_by_principal_id,
    confirmationTool: row.confirmation_tool,
    evidenceRefs: row.evidence_refs,
    confirmedAt: row.confirmed_at.toISOString(),
    supersededAt: row.superseded_at?.toISOString() ?? null,
    supersededReason: row.superseded_reason,
  };
}

function anomalyFromRow(row: AnomalyRow): TaskExecutionAnomaly {
  return {
    id: row.id,
    taskId: row.task_id,
    code: row.code,
    message: row.message,
    runId: row.run_id,
    runAttempt: row.run_attempt,
    eventId: row.event_id,
    status: row.status,
    occurrence: row.occurrence,
    detectedAt: row.detected_at.toISOString(),
    clearedAt: row.cleared_at?.toISOString() ?? null,
    clearedReason: row.cleared_reason,
    revision: row.revision,
  };
}

function requirementDigest(requirement: string): string {
  return createHash("sha256").update(requirement).digest("hex");
}

export class FeatureFlagRepositoryError extends Error {
  constructor(
    readonly code: "feature_flag_revision_conflict",
    message: string,
  ) {
    super(message);
    this.name = "FeatureFlagRepositoryError";
  }
}

export class FeatureFlagRepository {
  constructor(private readonly database: Database) {}

  async getSetting(
    flagKey: string,
    projectId?: string | null,
  ): Promise<TaskFeatureFlagSetting | undefined> {
    const scopes =
      projectId === undefined || projectId === null
        ? [{ type: "platform" as const, id: "platform" }]
        : [
            { type: "project" as const, id: projectId },
            { type: "platform" as const, id: "platform" },
          ];
    for (const scope of scopes) {
      const result = await this.database.query<FeatureFlagRow>(
        `SELECT *
         FROM feature_flag_settings
         WHERE flag_key = $1 AND scope_type = $2 AND scope_id = $3`,
        [flagKey, scope.type, scope.id],
      );
      const row = result.rows[0];
      if (row !== undefined) return featureFlagFromRow(row);
    }
    return undefined;
  }

  async evidenceReviewMode(projectId: string): Promise<TaskEvidenceReviewMode> {
    const setting = await this.getSetting("task.evidence_review", projectId);
    const mode = setting?.mode ?? DEFAULT_MODES["task.evidence_review"];
    return mode === "on" ? "enforce" : mode;
  }

  async isEnabled(flagKey: string, projectId?: string | null): Promise<boolean> {
    const setting = await this.getSetting(flagKey, projectId);
    const defaults: Readonly<Record<string, TaskFeatureFlagMode>> = DEFAULT_MODES;
    const mode = setting?.mode ?? defaults[flagKey] ?? "off";
    return mode === "on" || mode === "enforce";
  }

  async anomalyMode(projectId: string): Promise<TaskAnomalyMode> {
    const setting = await this.getSetting("task.anomaly", projectId);
    const mode = setting?.mode ?? DEFAULT_MODES["task.anomaly"];
    return mode === "on" ? "enforce" : mode;
  }

  async set(input: {
    readonly flagKey: string;
    readonly scopeType: "platform" | "project";
    readonly scopeId: string;
    readonly mode: TaskFeatureFlagMode;
    readonly updatedBy: string;
    readonly expectedRevision?: number;
  }): Promise<TaskFeatureFlagSetting> {
    return this.database.transaction(async (client) => {
      const current = await client.query<FeatureFlagRow>(
        `SELECT *
         FROM feature_flag_settings
         WHERE flag_key = $1 AND scope_type = $2 AND scope_id = $3
         FOR UPDATE`,
        [input.flagKey, input.scopeType, input.scopeId],
      );
      const existing = current.rows[0];
      if (
        input.expectedRevision !== undefined &&
        (existing?.revision ?? 0) !== input.expectedRevision
      ) {
        throw new FeatureFlagRepositoryError(
          "feature_flag_revision_conflict",
          "Feature Flag revision changed",
        );
      }
      const result = existing === undefined
        ? await client.query<FeatureFlagRow>(
            `INSERT INTO feature_flag_settings (
               flag_key, scope_type, scope_id, mode, revision, updated_by,
               updated_at
             ) VALUES ($1, $2, $3, $4, 1, $5, NOW())
             RETURNING *`,
            [
              input.flagKey,
              input.scopeType,
              input.scopeId,
              input.mode,
              input.updatedBy,
            ],
          )
        : await client.query<FeatureFlagRow>(
            `UPDATE feature_flag_settings
             SET mode = $4,
                 revision = revision + 1,
                 updated_by = $5,
                 updated_at = NOW()
             WHERE flag_key = $1 AND scope_type = $2 AND scope_id = $3
             RETURNING *`,
            [
              input.flagKey,
              input.scopeType,
              input.scopeId,
              input.mode,
              input.updatedBy,
            ],
          );
      return featureFlagFromRow(result.rows[0]!);
    });
  }
}

export class TaskAcceptanceRepositoryError extends Error {
  constructor(
    readonly code:
      | "acceptance_item_not_found"
      | "acceptance_item_not_current"
      | "acceptance_item_task_mismatch"
      | "acceptance_confirmation_conflict",
    message: string,
  ) {
    super(message);
    this.name = "TaskAcceptanceRepositoryError";
  }
}

export class TaskAcceptanceRepository {
  constructor(private readonly database: Database) {}

  async listItems(
    taskId: string,
    includeDeprecated = false,
  ): Promise<TaskAcceptanceItem[]> {
    const result = await this.database.query<AcceptanceItemRow>(
      `SELECT *
       FROM task_acceptance_items
       WHERE task_id = $1
         AND ($2::boolean OR deprecated_at IS NULL)
       ORDER BY position, created_at, id`,
      [taskId, includeDeprecated],
    );
    return result.rows.map(acceptanceItemFromRow);
  }

  async getItem(id: string): Promise<TaskAcceptanceItem | undefined> {
    const result = await this.database.query<AcceptanceItemRow>(
      "SELECT * FROM task_acceptance_items WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : acceptanceItemFromRow(row);
  }

  async listCurrentConfirmations(
    taskId: string,
  ): Promise<TaskAcceptanceConfirmation[]> {
    const result = await this.database.query<AcceptanceConfirmationRow>(
      `SELECT *
       FROM task_acceptance_confirmations
       WHERE task_id = $1 AND superseded_at IS NULL
       ORDER BY confirmed_at, id`,
      [taskId],
    );
    return result.rows.map(acceptanceConfirmationFromRow);
  }

  async syncItems(
    taskId: string,
    requirements: readonly string[],
  ): Promise<TaskAcceptanceItem[]> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`task-acceptance:${taskId}`],
      );
      const current = await client.query<AcceptanceItemRow>(
        `SELECT *
         FROM task_acceptance_items
         WHERE task_id = $1 AND deprecated_at IS NULL
         ORDER BY position, created_at, id
         FOR UPDATE`,
        [taskId],
      );
      const byPosition = new Map(
        current.rows.map((row) => [row.position, row]),
      );
      for (const [position, requirement] of requirements.entries()) {
        const existing = byPosition.get(position);
        const digest = requirementDigest(requirement);
        if (existing === undefined) {
          const itemId = randomUUID();
          await client.query(
            `INSERT INTO task_acceptance_items (
               id, task_id, position, requirement, required, current_revision,
               content_digest, deprecated_at, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, TRUE, 1, $5, NULL, NOW(), NOW())`,
            [itemId, taskId, position, requirement, digest],
          );
          await client.query(
            `INSERT INTO task_acceptance_item_revisions (
               id, acceptance_item_id, revision, requirement, required,
               content_digest, superseded_at, created_at
             ) VALUES ($1, $2, 1, $3, TRUE, $4, NULL, NOW())`,
            [randomUUID(), itemId, requirement, digest],
          );
          continue;
        }
        if (
          existing.requirement === requirement &&
          existing.required &&
          existing.content_digest === digest
        ) {
          continue;
        }
        const revision = existing.current_revision + 1;
        await client.query(
          `UPDATE task_acceptance_item_revisions
           SET superseded_at = COALESCE(superseded_at, NOW())
           WHERE acceptance_item_id = $1
             AND revision = $2
             AND superseded_at IS NULL`,
          [existing.id, existing.current_revision],
        );
        await client.query(
          `UPDATE task_acceptance_confirmations
           SET superseded_at = NOW(),
               superseded_reason = 'acceptance_item_revision_changed'
           WHERE acceptance_item_id = $1
             AND superseded_at IS NULL`,
          [existing.id],
        );
        await client.query(
          `UPDATE task_acceptance_items
           SET requirement = $2,
               required = TRUE,
               current_revision = $3,
               content_digest = $4,
               updated_at = NOW()
           WHERE id = $1`,
          [existing.id, requirement, revision, digest],
        );
        await client.query(
          `INSERT INTO task_acceptance_item_revisions (
             id, acceptance_item_id, revision, requirement, required,
             content_digest, superseded_at, created_at
           ) VALUES ($1, $2, $3, $4, TRUE, $5, NULL, NOW())`,
          [randomUUID(), existing.id, revision, requirement, digest],
        );
      }
      for (const [position, existing] of byPosition) {
        if (position < requirements.length) continue;
        await client.query(
          `UPDATE task_acceptance_item_revisions
           SET superseded_at = COALESCE(superseded_at, NOW())
           WHERE acceptance_item_id = $1
             AND revision = $2
             AND superseded_at IS NULL`,
          [existing.id, existing.current_revision],
        );
        await client.query(
          `UPDATE task_acceptance_confirmations
           SET superseded_at = NOW(),
               superseded_reason = 'acceptance_item_removed'
           WHERE acceptance_item_id = $1
             AND superseded_at IS NULL`,
          [existing.id],
        );
        await client.query(
          `UPDATE task_acceptance_items
           SET deprecated_at = COALESCE(deprecated_at, NOW()),
               updated_at = NOW()
           WHERE id = $1`,
          [existing.id],
        );
      }
    }).then(() => this.listItems(taskId));
  }

  async saveConfirmation(input: {
    readonly acceptanceItemId: string;
    readonly acceptanceItemRevision: number;
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly confirmedByPrincipalId: string;
    readonly evidenceRefs: readonly AcceptanceEvidenceRef[];
  }): Promise<TaskAcceptanceConfirmation> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`task-acceptance-confirmation:${input.acceptanceItemId}`],
      );
      const itemResult = await client.query<AcceptanceItemRow>(
        `SELECT *
         FROM task_acceptance_items
         WHERE id = $1
         FOR UPDATE`,
        [input.acceptanceItemId],
      );
      const item = itemResult.rows[0];
      if (item === undefined) {
        throw new TaskAcceptanceRepositoryError(
          "acceptance_item_not_found",
          "Acceptance item was not found",
        );
      }
      if (item.task_id !== input.taskId) {
        throw new TaskAcceptanceRepositoryError(
          "acceptance_item_task_mismatch",
          "Acceptance item belongs to another Task",
        );
      }
      if (
        item.deprecated_at !== null ||
        item.current_revision !== input.acceptanceItemRevision
      ) {
        throw new TaskAcceptanceRepositoryError(
          "acceptance_item_not_current",
          "Acceptance item revision is no longer current",
        );
      }
      await client.query(
        `UPDATE task_acceptance_confirmations
         SET superseded_at = NOW(),
             superseded_reason = 'newer_confirmation'
         WHERE acceptance_item_id = $1
           AND superseded_at IS NULL`,
        [input.acceptanceItemId],
      );
      const inserted = await client.query<AcceptanceConfirmationRow>(
        `INSERT INTO task_acceptance_confirmations (
           id, acceptance_item_id, acceptance_item_revision, task_id, run_id,
           run_attempt, confirmed_by_principal_id, confirmation_tool,
           evidence_refs, confirmed_at, superseded_at, superseded_reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'task_submit_deliverable',
           $8::jsonb, NOW(), NULL, NULL
         )
         RETURNING *`,
        [
          randomUUID(),
          input.acceptanceItemId,
          input.acceptanceItemRevision,
          input.taskId,
          input.runId,
          input.runAttempt,
          input.confirmedByPrincipalId,
          JSON.stringify(input.evidenceRefs),
        ],
      );
      return acceptanceConfirmationFromRow(inserted.rows[0]!);
    });
  }
}

export class TaskExecutionAnomalyRepository {
  constructor(private readonly database: Database) {}

  async detect(input: {
    readonly taskId: string;
    readonly code: TaskExecutionAnomalyCode;
    readonly message: string;
    readonly runId?: string | null;
    readonly runAttempt?: number | null;
    readonly eventId?: string | null;
  }): Promise<TaskExecutionAnomaly> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`task-anomaly:${input.taskId}:${input.runId ?? "task"}:${input.code}`],
      );
      const runId = input.runId ?? null;
      const existing = await client.query<AnomalyRow>(
        `SELECT *
         FROM task_execution_anomalies
         WHERE task_id = $1
           AND run_id IS NOT DISTINCT FROM $2::uuid
           AND code = $3
           AND status = 'active'
         ORDER BY detected_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.taskId, runId, input.code],
      );
      const current = existing.rows[0];
      if (current !== undefined) {
        const updated = await client.query<AnomalyRow>(
          `UPDATE task_execution_anomalies
           SET message = $2,
               run_attempt = COALESCE($3, run_attempt),
               event_id = COALESCE($4, event_id),
               occurrence = occurrence + 1,
               revision = revision + 1
           WHERE id = $1
           RETURNING *`,
          [
            current.id,
            input.message,
            input.runAttempt ?? null,
            input.eventId ?? null,
          ],
        );
        return anomalyFromRow(updated.rows[0]!);
      }
      const inserted = await client.query<AnomalyRow>(
        `INSERT INTO task_execution_anomalies (
           id, task_id, run_id, run_attempt, code, message, event_id, status,
           occurrence, detected_at, cleared_at, cleared_reason, revision
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'active', 1, NOW(), NULL, NULL, 1
         )
         RETURNING *`,
        [
          randomUUID(),
          input.taskId,
          runId,
          input.runAttempt ?? null,
          input.code,
          input.message,
          input.eventId ?? null,
        ],
      );
      return anomalyFromRow(inserted.rows[0]!);
    });
  }

  async clearForRunAttempt(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly reason: string;
  }): Promise<TaskExecutionAnomaly[]> {
    const result = await this.database.query<AnomalyRow>(
      `UPDATE task_execution_anomalies
       SET status = 'cleared',
           cleared_at = NOW(),
           cleared_reason = $4,
           revision = revision + 1
       WHERE task_id = $1
         AND run_id = $2
         AND (run_attempt IS NULL OR run_attempt <= $3)
         AND status = 'active'
       RETURNING *`,
      [input.taskId, input.runId, input.runAttempt, input.reason],
    );
    return result.rows.map(anomalyFromRow);
  }

  async clearReadinessForRun(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly reason: string;
  }): Promise<TaskExecutionAnomaly[]> {
    const result = await this.database.query<AnomalyRow>(
      `UPDATE task_execution_anomalies
       SET status = 'cleared',
           cleared_at = NOW(),
           cleared_reason = $4,
           revision = revision + 1
       WHERE task_id = $1
         AND run_id = $2
         AND (run_attempt IS NULL OR run_attempt <= $3)
         AND code IN ('missing_acceptance', 'missing_execution_evidence')
         AND status = 'active'
       RETURNING *`,
      [input.taskId, input.runId, input.runAttempt, input.reason],
    );
    return result.rows.map(anomalyFromRow);
  }

  async listActive(taskId: string): Promise<TaskExecutionAnomaly[]> {
    const result = await this.database.query<AnomalyRow>(
      `SELECT *
       FROM task_execution_anomalies
       WHERE task_id = $1 AND status = 'active'
       ORDER BY detected_at, id`,
      [taskId],
    );
    return result.rows.map(anomalyFromRow);
  }
}
