import { createHash, randomUUID } from "node:crypto";
import type {
  CreateTeammateInput,
  CreateTeammateTemplateInput,
  ParsedTeammateWorkItem,
  Teammate,
  TeammateDefinition,
  TeammateEvent,
  TeammateQueueItem,
  TeammateStatus,
  TeammateTemplate,
  TeammateTemplateStatus,
  TeammateTemplateVersion,
  TeammateTransfer,
  TeammateWeeklyReport,
  TaskPriority,
} from "@pluginmax/contracts";
import {
  taskPrioritySchema,
  teammateDefinitionSchema,
  teammateEventSchema,
  teammateSchema,
  teammateTemplateSchema,
  teammateTemplateVersionSchema,
  teammateTransferSchema,
  teammateWeeklyReportSchema,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { agentFromRow, type AgentRow, type TaskRow } from "./rows.js";

interface TeammateTemplateRow {
  id: string;
  project_id: string;
  workspace_id: string;
  scope: TeammateTemplate["scope"];
  owner_principal_id: string | null;
  status: TeammateTemplateStatus;
  current_version: number;
  definition: TeammateDefinition;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface TeammateTemplateVersionRow {
  id: string;
  template_id: string;
  project_id: string;
  version: number;
  definition: TeammateDefinition;
  content_digest: string;
  created_by: string;
  created_at: Date;
}

interface TeammateRow {
  id: string;
  project_id: string;
  workspace_id: string;
  template_id: string;
  template_version_id: string;
  template_version: number;
  agent_id: string;
  ai_principal_id: string;
  owner_principal_id: string;
  name: string;
  status: TeammateStatus;
  version: number;
  auto_execute: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface TeammateJoinRow extends AgentRow {
  teammate_id: string;
  teammate_project_id: string;
  teammate_workspace_id: string;
  teammate_template_id: string;
  teammate_template_version_id: string;
  teammate_template_version: number;
  teammate_agent_id: string;
  teammate_ai_principal_id: string;
  teammate_owner_principal_id: string;
  teammate_name: string;
  teammate_status: TeammateStatus;
  teammate_version: number;
  teammate_auto_execute: boolean;
  teammate_created_by: string;
  teammate_created_at: Date;
  teammate_updated_at: Date;
}

interface TeammateCandidateRow extends TaskRow {
  teammate_id: string;
}

interface TeammateTransferRow {
  id: string;
  teammate_id: string;
  from_owner_principal_id: string;
  to_owner_principal_id: string;
  transferred_by_principal_id: string;
  reason: string;
  created_at: Date;
}

interface TeammateEventRow {
  id: string;
  teammate_id: string;
  seq: string;
  kind: TeammateEvent["kind"];
  actor_principal_id: string;
  summary: string;
  data: Record<string, unknown>;
  created_at: Date;
}

interface TeammateWorkItemRow {
  id: string;
  teammate_id: string;
  plan_id: string | null;
  task_id: string;
  queue_seq: number;
  auto_execute_eligible: boolean;
  metadata: Record<string, unknown>;
  status: "active" | "removed";
  created_at: Date;
  updated_at: Date;
}

interface TeammateQueueRow extends TeammateWorkItemRow {
  depends_on: string[];
  task_project_id: string;
  task_title: string;
  task_description: string;
  task_acceptance: string[];
  task_status: string;
  task_priority: string;
  task_agent_id: string;
  task_revision: number;
  task_created_at: Date;
  task_updated_at: Date;
  project_status: "active" | "archived";
  active_run: boolean;
  active_claim: boolean;
  dependency_blocked: boolean;
  ai_principal_status: "active" | "suspended" | "archived";
  instance_status: TeammateStatus;
  grant_write: boolean;
}

interface TeammateWeeklyReportRow {
  id: string;
  teammate_id: string;
  project_id: string;
  week_start: Date;
  week_end: Date;
  status: "generated" | "stale";
  summary: TeammateWeeklyReport["summary"];
  statistics: TeammateWeeklyReport["statistics"];
  generated_by: string;
  generated_at: Date;
}

export interface TeammateRunAttribution {
  readonly id: string;
  readonly runId: string;
  readonly teammateId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly templateVersion: number;
  readonly aiPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly sceneSessionId: string | null;
  readonly createdAt: string;
}

interface TeammateRunAttributionRow {
  id: string;
  run_id: string;
  teammate_id: string;
  project_id: string;
  template_id: string;
  template_version_id: string;
  template_version: number;
  ai_principal_id: string;
  owner_principal_id: string;
  scene_session_id: string | null;
  created_at: Date;
}

export interface TeammateTaskStatusSummary {
  readonly queued: number;
  readonly running: number;
  readonly awaitingReview: number;
  readonly completed: number;
  readonly failed: number;
  readonly needsInput: number;
}

function templateFromRow(row: TeammateTemplateRow): TeammateTemplate {
  return teammateTemplateSchema.parse({
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
    currentVersion: row.current_version,
    definition: teammateDefinitionSchema.parse(row.definition),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function templateVersionFromRow(
  row: TeammateTemplateVersionRow,
): TeammateTemplateVersion {
  return teammateTemplateVersionSchema.parse({
    id: row.id,
    templateId: row.template_id,
    projectId: row.project_id,
    version: row.version,
    definition: teammateDefinitionSchema.parse(row.definition),
    contentDigest: row.content_digest,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  });
}

function teammateFromRow(row: TeammateJoinRow): Teammate {
  return teammateSchema.parse({
    id: row.teammate_id,
    projectId: row.teammate_project_id,
    workspaceId: row.teammate_workspace_id,
    templateId: row.teammate_template_id,
    templateVersionId: row.teammate_template_version_id,
    templateVersion: row.teammate_template_version,
    agent: agentFromRow(row),
    aiPrincipalId: row.teammate_ai_principal_id,
    ownerPrincipalId: row.teammate_owner_principal_id,
    name: row.teammate_name,
    status: row.teammate_status,
    version: row.teammate_version,
    autoExecute: row.teammate_auto_execute,
    createdAt: row.teammate_created_at.toISOString(),
    updatedAt: row.teammate_updated_at.toISOString(),
  });
}

function transferFromRow(row: TeammateTransferRow): TeammateTransfer {
  return teammateTransferSchema.parse({
    id: row.id,
    teammateId: row.teammate_id,
    fromOwnerPrincipalId: row.from_owner_principal_id,
    toOwnerPrincipalId: row.to_owner_principal_id,
    transferredByPrincipalId: row.transferred_by_principal_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  });
}

function eventFromRow(row: TeammateEventRow): TeammateEvent {
  return teammateEventSchema.parse({
    id: row.id,
    teammateId: row.teammate_id,
    seq: Number(row.seq),
    kind: row.kind,
    actorPrincipalId: row.actor_principal_id,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  });
}

function weeklyReportFromRow(
  row: TeammateWeeklyReportRow,
): TeammateWeeklyReport {
  const localDateText = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  return teammateWeeklyReportSchema.parse({
    id: row.id,
    teammateId: row.teammate_id,
    projectId: row.project_id,
    weekStart: localDateText(row.week_start),
    weekEnd: localDateText(row.week_end),
    status: row.status,
    summary: row.summary,
    statistics: row.statistics,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at.toISOString(),
  });
}

function runAttributionFromRow(
  row: TeammateRunAttributionRow,
): TeammateRunAttribution {
  return {
    id: row.id,
    runId: row.run_id,
    teammateId: row.teammate_id,
    projectId: row.project_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    templateVersion: row.template_version,
    aiPrincipalId: row.ai_principal_id,
    ownerPrincipalId: row.owner_principal_id,
    sceneSessionId: row.scene_session_id,
    createdAt: row.created_at.toISOString(),
  };
}

function definitionDigest(definition: TeammateDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function teammateSelectSql(): string {
  return `SELECT
    teammate.id AS teammate_id,
    teammate.project_id AS teammate_project_id,
    teammate.workspace_id AS teammate_workspace_id,
    teammate.template_id AS teammate_template_id,
    teammate.template_version_id AS teammate_template_version_id,
    teammate.template_version AS teammate_template_version,
    teammate.agent_id AS teammate_agent_id,
    teammate.ai_principal_id AS teammate_ai_principal_id,
    teammate.owner_principal_id AS teammate_owner_principal_id,
    teammate.name AS teammate_name,
    teammate.status AS teammate_status,
    teammate.version AS teammate_version,
    teammate.auto_execute AS teammate_auto_execute,
    teammate.created_by AS teammate_created_by,
    teammate.created_at AS teammate_created_at,
    teammate.updated_at AS teammate_updated_at,
    agent.*
  FROM teammates AS teammate
  JOIN agents AS agent ON agent.id = teammate.agent_id`;
}

function queuePriority(priority: string): TaskPriority {
  return taskPrioritySchema.parse(priority);
}

function nextQueueSeq(current: number | null | undefined): number {
  return (current ?? 0) + 1_000;
}

export class TeammateRepository {
  constructor(private readonly database: Database) {}

  async listTemplates(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly includeArchived?: boolean;
  }): Promise<TeammateTemplate[]> {
    const result = await this.database.query<TeammateTemplateRow>(
      `SELECT *
       FROM teammate_templates
       WHERE project_id = $1
         AND ($2::boolean OR status <> 'archived')
         AND (scope = 'platform' OR owner_principal_id = $3)
       ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
         lower(definition ->> 'name')`,
      [input.projectId, input.includeArchived ?? false, input.actorPrincipalId],
    );
    return result.rows.map(templateFromRow);
  }

  async getTemplate(id: string): Promise<TeammateTemplate | undefined> {
    const result = await this.database.query<TeammateTemplateRow>(
      "SELECT * FROM teammate_templates WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : templateFromRow(row);
  }

  async listTemplateVersions(
    templateId: string,
  ): Promise<TeammateTemplateVersion[]> {
    const result = await this.database.query<TeammateTemplateVersionRow>(
      `SELECT *
       FROM teammate_template_versions
       WHERE template_id = $1
       ORDER BY version DESC`,
      [templateId],
    );
    return result.rows.map(templateVersionFromRow);
  }

  async getTemplateVersion(
    id: string,
  ): Promise<TeammateTemplateVersion | undefined> {
    const result = await this.database.query<TeammateTemplateVersionRow>(
      "SELECT * FROM teammate_template_versions WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : templateVersionFromRow(row);
  }

  async createTemplate(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly actorPrincipalId: string;
    readonly template: CreateTeammateTemplateInput;
  }): Promise<TeammateTemplate> {
    const definition = teammateDefinitionSchema.parse(
      input.template.definition,
    );
    return this.database.transaction(async (client) => {
      const templateId = randomUUID();
      const versionId = randomUUID();
      const templateResult = await client.query<TeammateTemplateRow>(
        `INSERT INTO teammate_templates (
           id, project_id, workspace_id, scope, owner_principal_id, status,
           current_version, definition, created_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', 1, $6::jsonb, $7, NOW(), NOW()
         )
         RETURNING *`,
        [
          templateId,
          input.projectId,
          input.workspaceId,
          input.template.scope,
          input.template.scope === "personal" ? input.actorPrincipalId : null,
          JSON.stringify(definition),
          input.actorPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO teammate_template_versions (
           id, template_id, project_id, version, definition,
           content_digest, created_by, created_at
         ) VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, NOW())`,
        [
          versionId,
          templateId,
          input.projectId,
          JSON.stringify(definition),
          definitionDigest(definition),
          input.actorPrincipalId,
        ],
      );
      return templateFromRow(templateResult.rows[0]!);
    });
  }

  async updateTemplate(input: {
    readonly templateId: string;
    readonly actorPrincipalId: string;
    readonly expectedVersion: number;
    readonly definition: TeammateDefinition;
  }): Promise<TeammateTemplate | "revision_conflict" | undefined> {
    return this.database.transaction(async (client) => {
      const currentResult = await client.query<TeammateTemplateRow>(
        "SELECT * FROM teammate_templates WHERE id = $1 FOR UPDATE",
        [input.templateId],
      );
      const current = currentResult.rows[0];
      if (current === undefined) return undefined;
      if (current.current_version !== input.expectedVersion) {
        return "revision_conflict" as const;
      }
      if (current.status === "archived") {
        throw new Error("archived teammate template cannot be edited");
      }
      const version = current.current_version + 1;
      const definition = teammateDefinitionSchema.parse(input.definition);
      await client.query<TeammateTemplateVersionRow>(
        `INSERT INTO teammate_template_versions (
           id, template_id, project_id, version, definition,
           content_digest, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
         RETURNING *`,
        [
          randomUUID(),
          current.id,
          current.project_id,
          version,
          JSON.stringify(definition),
          definitionDigest(definition),
          input.actorPrincipalId,
        ],
      );
      const updated = await client.query<TeammateTemplateRow>(
        `UPDATE teammate_templates
         SET current_version = $2, definition = $3::jsonb, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [current.id, version, JSON.stringify(definition)],
      );
      return templateFromRow(updated.rows[0]!);
    });
  }

  async transitionTemplate(input: {
    readonly templateId: string;
    readonly expectedVersion: number;
    readonly status: TeammateTemplateStatus;
  }): Promise<TeammateTemplate | "revision_conflict" | undefined> {
    const result = await this.database.query<TeammateTemplateRow>(
      `UPDATE teammate_templates
       SET status = $3, updated_at = NOW()
       WHERE id = $1
         AND current_version = $2
       RETURNING *`,
      [input.templateId, input.expectedVersion, input.status],
    );
    const row = result.rows[0];
    if (row !== undefined) return templateFromRow(row);
    const existing = await this.getTemplate(input.templateId);
    return existing === undefined ? undefined : "revision_conflict";
  }

  async createTeammate(input: {
    readonly teammate: CreateTeammateInput;
    readonly workspaceId: string;
    readonly actorPrincipalId: string;
    readonly agent: {
      readonly id: string;
      readonly principalId: string;
    };
    readonly name: string;
  }): Promise<Teammate> {
    const template = await this.getTemplate(input.teammate.templateId);
    if (template === undefined) throw new Error("teammate template not found");
    const version = await this.database.query<TeammateTemplateVersionRow>(
      `SELECT *
       FROM teammate_template_versions
       WHERE template_id = $1 AND version = $2`,
      [template.id, template.currentVersion],
    );
    const templateVersion = version.rows[0];
    if (templateVersion === undefined) {
      throw new Error("teammate template version not found");
    }
    const inserted = await this.database.query<TeammateRow>(
      `INSERT INTO teammates (
         id, project_id, workspace_id, template_id, template_version_id,
         template_version, agent_id, ai_principal_id, owner_principal_id,
         name, status, version, auto_execute, created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 1, $11, $12,
         NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.teammate.projectId,
        input.workspaceId,
        template.id,
        templateVersion.id,
        templateVersion.version,
        input.agent.id,
        input.agent.principalId,
        input.actorPrincipalId,
        input.name,
        input.teammate.autoExecute,
        input.actorPrincipalId,
      ],
    );
    const created = await this.getTeammate(inserted.rows[0]!.id);
    if (created === undefined) throw new Error("created teammate is missing");
    return created;
  }

  async listTeammates(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly includeArchived?: boolean;
  }): Promise<Teammate[]> {
    const result = await this.database.query<TeammateJoinRow>(
      `${teammateSelectSql()}
       WHERE teammate.project_id = $1
         AND ($2::boolean OR teammate.status <> 'archived')
         AND (
           teammate.owner_principal_id = $3
           OR teammate.status <> 'archived'
           OR $4::boolean
         )
       ORDER BY
         CASE teammate.status
           WHEN 'active' THEN 0
           WHEN 'paused' THEN 1
           WHEN 'inactive' THEN 2
           ELSE 3
         END,
         lower(teammate.name)`,
      [
        input.projectId,
        input.includeArchived ?? false,
        input.actorPrincipalId,
        input.includeArchived ?? false,
      ],
    );
    return result.rows.map(teammateFromRow);
  }

  async getTeammate(id: string): Promise<Teammate | undefined> {
    const result = await this.database.query<TeammateJoinRow>(
      `${teammateSelectSql()} WHERE teammate.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : teammateFromRow(row);
  }

  async transitionTeammate(input: {
    readonly teammateId: string;
    readonly expectedVersion: number;
    readonly status: TeammateStatus;
    readonly autoExecute?: boolean;
  }): Promise<Teammate | "revision_conflict" | undefined> {
    const result = await this.database.query<TeammateRow>(
      `UPDATE teammates
       SET
         status = $3,
         auto_execute = COALESCE($4, auto_execute),
         version = version + 1,
         updated_at = NOW()
       WHERE id = $1
         AND version = $2
       RETURNING id`,
      [
        input.teammateId,
        input.expectedVersion,
        input.status,
        input.autoExecute ?? null,
      ],
    );
    if (result.rowCount === 0) {
      const existing = await this.getTeammate(input.teammateId);
      return existing === undefined ? undefined : "revision_conflict";
    }
    return this.getTeammate(input.teammateId);
  }

  async transfer(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly expectedVersion: number;
    readonly toOwnerPrincipalId: string;
    readonly reason: string;
  }): Promise<Teammate | "revision_conflict" | undefined> {
    const result = await this.database.transaction(async (client) => {
      const currentResult = await client.query<TeammateRow>(
        "SELECT * FROM teammates WHERE id = $1 FOR UPDATE",
        [input.teammateId],
      );
      const current = currentResult.rows[0];
      if (current === undefined) return undefined;
      if (current.version !== input.expectedVersion) {
        return "revision_conflict" as const;
      }
      if (current.status === "archived") {
        throw new Error("archived teammate cannot be transferred");
      }
      if (current.owner_principal_id === input.toOwnerPrincipalId) {
        throw new Error("teammate is already owned by this Principal");
      }
      await client.query(
        `INSERT INTO teammate_transfers (
           id, teammate_id, from_owner_principal_id, to_owner_principal_id,
           transferred_by_principal_id, reason, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          randomUUID(),
          current.id,
          current.owner_principal_id,
          input.toOwnerPrincipalId,
          input.actorPrincipalId,
          input.reason,
        ],
      );
      await client.query(
        `UPDATE teammates
         SET
           owner_principal_id = $2,
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1`,
        [current.id, input.toOwnerPrincipalId],
      );
      return current.id;
    });
    if (result === "revision_conflict") return result;
    if (result === undefined) return undefined;
    return this.getTeammate(result);
  }

  async listTransfers(teammateId: string): Promise<TeammateTransfer[]> {
    const result = await this.database.query<TeammateTransferRow>(
      `SELECT *
       FROM teammate_transfers
       WHERE teammate_id = $1
       ORDER BY created_at DESC, id DESC`,
      [teammateId],
    );
    return result.rows.map(transferFromRow);
  }

  async recordEvent(input: {
    readonly teammateId: string;
    readonly kind: TeammateEvent["kind"];
    readonly actorPrincipalId: string;
    readonly summary: string;
    readonly data?: Record<string, unknown>;
  }): Promise<TeammateEvent> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`teammate-event:${input.teammateId}`],
      );
      const result = await client.query<TeammateEventRow>(
        `INSERT INTO teammate_events (
           id, teammate_id, seq, kind, actor_principal_id, summary, data,
           created_at
         )
         SELECT
           $1,
           $2,
           COALESCE(MAX(seq), 0) + 1,
           $3,
           $4,
           $5,
           $6::jsonb,
           NOW()
         FROM teammate_events
         WHERE teammate_id = $2
         RETURNING *`,
        [
          randomUUID(),
          input.teammateId,
          input.kind,
          input.actorPrincipalId,
          input.summary,
          JSON.stringify(input.data ?? {}),
        ],
      );
      return eventFromRow(result.rows[0]!);
    });
  }

  async listEvents(teammateId: string): Promise<TeammateEvent[]> {
    const result = await this.database.query<TeammateEventRow>(
      `SELECT *
       FROM teammate_events
       WHERE teammate_id = $1
       ORDER BY seq DESC`,
      [teammateId],
    );
    return result.rows.map(eventFromRow);
  }

  async createWorkPlan(input: {
    readonly teammate: Teammate;
    readonly actorPrincipalId: string;
    readonly instruction: string;
    readonly items: readonly ParsedTeammateWorkItem[];
    readonly autoExecuteEligible: boolean;
  }): Promise<{ readonly planId: string; readonly taskIds: string[] }> {
    return this.database.transaction(async (client) => {
      const planId = randomUUID();
      await client.query(
        `INSERT INTO teammate_work_plans (
           id, teammate_id, project_id, instruction, revision, status,
           created_by, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 1, 'active', $5, NOW(), NOW())`,
        [
          planId,
          input.teammate.id,
          input.teammate.projectId,
          input.instruction,
          input.actorPrincipalId,
        ],
      );
      const currentSeq = await client.query<{ max_seq: number | null }>(
        `SELECT MAX(queue_seq) AS max_seq
         FROM teammate_work_items
         WHERE teammate_id = $1 AND status = 'active'`,
        [input.teammate.id],
      );
      let queueSeq = nextQueueSeq(currentSeq.rows[0]?.max_seq);
      const taskIds: string[] = [];
      for (const item of input.items) {
        const taskId = randomUUID();
        const priority =
          item.priority === "urgent"
            ? "urgent"
            : item.priority === "high"
              ? "high"
              : item.priority === "medium"
                ? "medium"
                : "low";
        await client.query(
          `INSERT INTO tasks (
             id, project_id, title, description, acceptance, status,
             agent_id, priority, auto_submit, auto_accept,
             auto_redispatch_on_return, revision, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, TRUE, FALSE,
             FALSE, 1, NOW(), NOW()
           )`,
          [
            taskId,
            input.teammate.projectId,
            item.title,
            item.description,
            JSON.stringify(item.acceptance),
            input.teammate.agent.id,
            priority,
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
            `AI Teammate「${input.teammate.name}」从工作计划生成任务`,
            JSON.stringify({
              teammateId: input.teammate.id,
              workPlanId: planId,
            }),
          ],
        );
        await client.query(
          `INSERT INTO teammate_work_items (
             id, teammate_id, plan_id, task_id, queue_seq,
             auto_execute_eligible, metadata, status, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, 'active', NOW(), NOW()
           )`,
          [
            randomUUID(),
            input.teammate.id,
            planId,
            taskId,
            queueSeq,
            input.autoExecuteEligible,
            JSON.stringify({
              due: item.due ?? null,
              acceptance: item.acceptance,
            }),
          ],
        );
        taskIds.push(taskId);
        queueSeq += 1_000;
      }
      return { planId, taskIds };
    });
  }

  async listWorkQueue(
    teammateId: string,
  ): Promise<readonly TeammateQueueItem[]> {
    const teammate = await this.getTeammate(teammateId);
    if (teammate === undefined) return [];
    const result = await this.database.query<TeammateQueueRow>(
      `SELECT
         item.*,
         project.status AS project_status,
         teammate.status AS instance_status,
         principal.status AS ai_principal_status,
         EXISTS (
           SELECT 1
           FROM role_grants AS grant_row
           WHERE grant_row.principal_id = teammate.ai_principal_id
             AND grant_row.scope_type = 'project'
             AND grant_row.scope_id = teammate.project_id::text
             AND grant_row.status = 'active'
             AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NOW())
             AND grant_row.permissions ? 'write'
         ) AS grant_write,
         task.project_id AS task_project_id,
         task.title AS task_title,
         task.description AS task_description,
         task.acceptance AS task_acceptance,
         task.status AS task_status,
         task.priority AS task_priority,
         task.agent_id AS task_agent_id,
         task.revision AS task_revision,
         task.created_at AS task_created_at,
         task.updated_at AS task_updated_at,
         ARRAY(
           SELECT dependency.depends_on_task_id::text
           FROM task_dependencies AS dependency
           WHERE dependency.task_id = task.id
           ORDER BY dependency.created_at, dependency.depends_on_task_id
         ) AS depends_on,
         EXISTS (
           SELECT 1
           FROM runs
           WHERE runs.task_id = task.id
             AND runs.status IN (
               'queued', 'running', 'waiting_approval', 'interrupted'
             )
         ) AS active_run,
         (
           task.execution_claim_token IS NOT NULL
           AND task.execution_claim_expires_at > NOW()
         ) AS active_claim,
         EXISTS (
           SELECT 1
           FROM task_dependencies AS dependency
           JOIN tasks AS prerequisite
             ON prerequisite.id = dependency.depends_on_task_id
           WHERE dependency.task_id = task.id
             AND prerequisite.status <> 'done'
         ) AS dependency_blocked
       FROM teammate_work_items AS item
       JOIN teammates AS teammate ON teammate.id = item.teammate_id
       JOIN tasks AS task ON task.id = item.task_id
       JOIN projects AS project ON project.id = task.project_id
       JOIN principals AS principal ON principal.id = teammate.ai_principal_id
       WHERE item.teammate_id = $1
         AND item.status = 'active'
         AND task.status <> 'cancelled'
       ORDER BY item.queue_seq, item.task_id`,
      [teammateId],
    );
    return result.rows.map((row) => {
      const blockedReasons: TeammateQueueItem["blockedReasons"] = [];
      if (row.instance_status !== "active") {
        blockedReasons.push("instance-inactive");
      }
      if (row.project_status !== "active") {
        blockedReasons.push("project-inactive");
      }
      if (row.ai_principal_status !== "active") {
        blockedReasons.push("principal-inactive");
      }
      if (!row.grant_write) blockedReasons.push("grant-missing");
      if (row.task_status !== "queued") blockedReasons.push("task-inactive");
      if (row.dependency_blocked) blockedReasons.push("dependency");
      if (row.active_run) blockedReasons.push("active-run");
      if (row.active_claim) blockedReasons.push("active-claim");
      if (!row.auto_execute_eligible) blockedReasons.push("auto-disabled");
      return {
        taskId: row.task_id,
        queueSeq: row.queue_seq,
        autoEligible: blockedReasons.length === 0,
        blockedReasons,
        task: {
          id: row.task_id,
          projectId: row.task_project_id,
          title: row.task_title,
          description: row.task_description,
          status: row.task_status,
          priority: queuePriority(row.task_priority),
          revision: row.task_revision,
          dependsOn: row.depends_on,
          createdAt: row.task_created_at.toISOString(),
          updatedAt: row.task_updated_at.toISOString(),
        },
      };
    });
  }

  async reorderWorkQueue(
    teammateId: string,
    taskIds: readonly string[],
  ): Promise<TeammateQueueItem[]> {
    await this.database.transaction(async (client) => {
      const existing = await client.query<{ task_id: string }>(
        `SELECT task_id::text
         FROM teammate_work_items
         WHERE teammate_id = $1
           AND status = 'active'
         FOR UPDATE`,
        [teammateId],
      );
      const existingIds = existing.rows.map((row) => row.task_id);
      if (
        taskIds.length !== existingIds.length ||
        new Set(taskIds).size !== taskIds.length ||
        taskIds.some((taskId) => !existingIds.includes(taskId))
      ) {
        throw new Error(
          "teammate queue reorder must include every active item",
        );
      }
      const offset = Math.max(1_000_000, (existingIds.length + 1) * 10_000);
      await client.query(
        `UPDATE teammate_work_items
         SET queue_seq = queue_seq + $2, updated_at = NOW()
         WHERE teammate_id = $1 AND status = 'active'`,
        [teammateId, offset],
      );
      for (const [index, taskId] of taskIds.entries()) {
        await client.query(
          `UPDATE teammate_work_items
           SET queue_seq = $3, updated_at = NOW()
           WHERE teammate_id = $1 AND task_id = $2 AND status = 'active'`,
          [teammateId, taskId, (index + 1) * 1_000],
        );
      }
    });
    return [...(await this.listWorkQueue(teammateId))];
  }

  async claimAutoRunCandidate(input: {
    readonly ownerId: string;
    readonly leaseSeconds: number;
    readonly excludedTeammateIds?: readonly string[];
    readonly teammateId?: string | undefined;
  }): Promise<
    | {
        readonly teammate: Teammate;
        readonly task: TaskRow & { readonly depends_on: string[] };
        readonly claimToken: string;
      }
    | undefined
  > {
    return this.database.transaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET
           execution_claim_token = NULL,
           execution_claim_owner = NULL,
           execution_claim_expires_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
         WHERE execution_claim_token IS NOT NULL
           AND execution_claim_expires_at <= NOW()`,
      );
      const result = await client.query<TeammateCandidateRow>(
        `SELECT
           teammate.id AS teammate_id,
           task.*,
           ARRAY(
             SELECT dependency.depends_on_task_id::text
             FROM task_dependencies AS dependency
             WHERE dependency.task_id = task.id
             ORDER BY dependency.created_at, dependency.depends_on_task_id
           ) AS depends_on
         FROM teammates AS teammate
         JOIN teammate_work_items AS item
           ON item.teammate_id = teammate.id AND item.status = 'active'
         JOIN tasks AS task ON task.id = item.task_id
         JOIN projects AS project ON project.id = teammate.project_id
         JOIN principals AS principal ON principal.id = teammate.ai_principal_id
         WHERE teammate.status = 'active'
           AND NOT (teammate.id = ANY($1::uuid[]))
           AND ($2::uuid IS NULL OR teammate.id = $2)
           AND teammate.auto_execute = TRUE
           AND (
             teammate.auto_run_lease_token IS NULL
             OR teammate.auto_run_lease_expires_at <= NOW()
           )
           AND project.status = 'active'
           AND principal.status = 'active'
           AND item.auto_execute_eligible = TRUE
           AND task.status = 'queued'
           AND NOT EXISTS (
             SELECT 1
             FROM runs
             WHERE runs.task_id = task.id
               AND runs.status IN (
                 'queued', 'running', 'waiting_approval', 'interrupted'
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM teammate_work_items AS running_item
             JOIN runs AS running_run
               ON running_run.task_id = running_item.task_id
             WHERE running_item.teammate_id = teammate.id
               AND running_item.status = 'active'
               AND running_run.status IN (
                 'queued', 'running', 'waiting_approval', 'interrupted'
               )
           )
           AND task.execution_claim_token IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM task_dependencies AS dependency
             JOIN tasks AS prerequisite
               ON prerequisite.id = dependency.depends_on_task_id
             WHERE dependency.task_id = task.id
               AND prerequisite.status <> 'done'
           )
         ORDER BY item.queue_seq, task.created_at, task.id
         FOR UPDATE OF teammate SKIP LOCKED
         LIMIT 1`,
        [input.excludedTeammateIds ?? [], input.teammateId ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const teammateResult = await client.query<TeammateJoinRow>(
        `${teammateSelectSql()} WHERE teammate.id = $1`,
        [row.teammate_id],
      );
      const teammateRow = teammateResult.rows[0];
      if (teammateRow === undefined) return undefined;
      const claimToken = randomUUID();
      await client.query(
        `UPDATE teammates
         SET
           auto_run_lease_token = $2,
           auto_run_lease_expires_at =
             NOW() + ($3 || ' seconds')::interval,
           updated_at = NOW()
         WHERE id = $1
           AND (
             auto_run_lease_token IS NULL
             OR auto_run_lease_expires_at <= NOW()
           )`,
        [row.teammate_id, claimToken, input.leaseSeconds],
      );
      await client.query(
        `UPDATE tasks
         SET
           execution_claim_token = $2,
           execution_claim_owner = $3,
           execution_claim_expires_at =
             NOW() + ($4 || ' seconds')::interval,
           revision = revision + 1,
           updated_at = NOW()
         WHERE id = $1
           AND execution_claim_token IS NULL`,
        [row.id, claimToken, input.ownerId, input.leaseSeconds],
      );
      await client.query(
        `INSERT INTO task_events (
           id, task_id, kind, actor_id, actor_name, summary, data, created_at
         ) VALUES (
           $1, $2, 'claim', $3, $3, $4, $5::jsonb, NOW()
         )`,
        [
          randomUUID(),
          row.id,
          input.ownerId,
          `AI Teammate 自动执行已领取任务`,
          JSON.stringify({
            teammateId: row.teammate_id,
            claimToken,
            leaseSeconds: input.leaseSeconds,
          }),
        ],
      );
      return {
        teammate: teammateFromRow(teammateRow),
        task: { ...row, depends_on: row.depends_on ?? [] },
        claimToken,
      };
    });
  }

  async releaseAutoRunClaim(input: {
    readonly teammateId: string;
    readonly taskId: string;
    readonly claimToken: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE teammates
         SET
           auto_run_lease_token = NULL,
           auto_run_lease_expires_at = NULL,
           updated_at = NOW()
         WHERE id = $1 AND auto_run_lease_token = $2`,
        [input.teammateId, input.claimToken],
      );
      await client.query(
        `UPDATE tasks
         SET
           execution_claim_token = NULL,
           execution_claim_owner = NULL,
           execution_claim_expires_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
         WHERE id = $1 AND execution_claim_token = $2`,
        [input.taskId, input.claimToken],
      );
    });
  }

  async listAttributionRunIds(input: {
    readonly teammateId: string;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
  }): Promise<string[]> {
    const result = await this.database.query<{ run_id: string }>(
      `SELECT attribution.run_id
       FROM teammate_run_attributions AS attribution
       WHERE attribution.teammate_id = $1
         AND ($2::timestamptz IS NULL OR attribution.created_at >= $2)
         AND ($3::timestamptz IS NULL OR attribution.created_at <= $3)
       ORDER BY attribution.created_at DESC, attribution.run_id DESC`,
      [input.teammateId, input.from ?? null, input.to ?? null],
    );
    return result.rows.map((row) => row.run_id);
  }

  async getRunAttribution(
    runId: string,
  ): Promise<TeammateRunAttribution | undefined> {
    const result = await this.database.query<TeammateRunAttributionRow>(
      "SELECT * FROM teammate_run_attributions WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : runAttributionFromRow(row);
  }

  async bindRunSceneSession(
    runId: string,
    sceneSessionId: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE teammate_run_attributions
       SET scene_session_id = $2
       WHERE run_id = $1
         AND scene_session_id IS NULL`,
      [runId, sceneSessionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listRunAttributionsForTask(
    taskId: string,
  ): Promise<TeammateRunAttribution[]> {
    const result = await this.database.query<TeammateRunAttributionRow>(
      `SELECT attribution.*
       FROM teammate_run_attributions AS attribution
       JOIN runs ON runs.id = attribution.run_id
       WHERE runs.task_id = $1
       ORDER BY attribution.created_at`,
      [taskId],
    );
    return result.rows.map(runAttributionFromRow);
  }

  async taskStatusSummary(input: {
    readonly teammateId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<TeammateTaskStatusSummary> {
    const result = await this.database.query<{
      queued: string;
      running: string;
      awaiting_review: string;
      completed: string;
      failed: string;
      needs_input: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE task.status = 'queued')::text AS queued,
         COUNT(*) FILTER (
           WHERE task.status = 'in_progress'
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE runs.task_id = task.id
                 AND runs.status IN ('queued', 'running', 'waiting_approval')
             )
         )::text AS running,
         COUNT(*) FILTER (WHERE task.status = 'review')::text
           AS awaiting_review,
         COUNT(*) FILTER (WHERE task.status = 'done')::text AS completed,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM runs
             WHERE runs.task_id = task.id
               AND runs.status IN ('failed', 'timeout', 'interrupted')
           )
             AND task.status <> 'done'
         )::text AS failed,
         COUNT(*) FILTER (WHERE task.status = 'needs_input')::text
           AS needs_input
       FROM teammate_work_items AS item
       JOIN tasks AS task ON task.id = item.task_id
       WHERE item.teammate_id = $1
         AND task.created_at >= $2
         AND task.created_at < $3`,
      [input.teammateId, input.from, input.to],
    );
    const row = result.rows[0];
    return {
      queued: Number(row?.queued ?? 0),
      running: Number(row?.running ?? 0),
      awaitingReview: Number(row?.awaiting_review ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
      needsInput: Number(row?.needs_input ?? 0),
    };
  }

  async saveWeeklyReport(input: {
    readonly teammateId: string;
    readonly projectId: string;
    readonly weekStart: string;
    readonly weekEnd: string;
    readonly summary: TeammateWeeklyReport["summary"];
    readonly statistics: TeammateWeeklyReport["statistics"];
    readonly generatedBy: string;
  }): Promise<TeammateWeeklyReport> {
    const result = await this.database.query<TeammateWeeklyReportRow>(
      `INSERT INTO teammate_weekly_reports (
         id, teammate_id, project_id, week_start, week_end, status,
         summary, statistics, generated_by, generated_at
       ) VALUES (
         $1, $2, $3, $4::date, $5::date, 'generated',
         $6::jsonb, $7::jsonb, $8, NOW()
       )
       ON CONFLICT (teammate_id, week_start) DO UPDATE
       SET
         week_end = EXCLUDED.week_end,
         status = 'generated',
         summary = EXCLUDED.summary,
         statistics = EXCLUDED.statistics,
         generated_by = EXCLUDED.generated_by,
         generated_at = NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.teammateId,
        input.projectId,
        input.weekStart,
        input.weekEnd,
        JSON.stringify(input.summary),
        JSON.stringify(input.statistics),
        input.generatedBy,
      ],
    );
    return weeklyReportFromRow(result.rows[0]!);
  }

  async listWeeklyReports(teammateId: string): Promise<TeammateWeeklyReport[]> {
    const result = await this.database.query<TeammateWeeklyReportRow>(
      `SELECT *
       FROM teammate_weekly_reports
       WHERE teammate_id = $1
       ORDER BY week_start DESC
       LIMIT 52`,
      [teammateId],
    );
    return result.rows.map(weeklyReportFromRow);
  }

  async listWeeklyReportCandidates(): Promise<Teammate[]> {
    const result = await this.database.query<TeammateJoinRow>(
      `${teammateSelectSql()}
       WHERE teammate.status = 'active'
       ORDER BY teammate.updated_at DESC
       LIMIT 200`,
    );
    return result.rows.map(teammateFromRow);
  }

  static async attributeRunWithClient(
    client: PoolClient,
    runId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO teammate_run_attributions (
         id, run_id, teammate_id, project_id, template_id,
         template_version_id, template_version, ai_principal_id,
         owner_principal_id, scene_session_id, created_at
       )
       SELECT
         $1,
         run.id,
         teammate.id,
         teammate.project_id,
         teammate.template_id,
         teammate.template_version_id,
         teammate.template_version,
         teammate.ai_principal_id,
         teammate.owner_principal_id,
         (
           SELECT session.id
           FROM scene_sessions AS session
           WHERE session.project_id = run.project_id
             AND session.scene_type = 'task'
             AND session.scene_id = run.task_id::text
             AND session.agent_id = run.agent_id
           ORDER BY session.generation DESC, session.created_at DESC
           LIMIT 1
         ),
         NOW()
       FROM runs AS run
       JOIN teammate_work_items AS item
         ON item.task_id = run.task_id AND item.status = 'active'
       JOIN teammates AS teammate ON teammate.id = item.teammate_id
       WHERE run.id = $2
         AND run.task_id IS NOT NULL
         AND run.agent_id = teammate.agent_id
       ON CONFLICT (run_id) DO NOTHING`,
      [randomUUID(), runId],
    );
  }
}
