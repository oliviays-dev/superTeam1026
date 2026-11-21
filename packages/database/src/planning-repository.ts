import { createHash, randomUUID } from "node:crypto";
import type {
  PlanningArtifact,
  PlanningArtifactKind,
  PlanningContextPackPayload,
  PlanningEvent,
  PlanningFeatureFlag,
  PlanningOverview,
  PlanningPolicy,
  PlanningPolicyConfig,
  PlanningTriggerPolicy,
  PlanningQualityMetric,
  PlanningRun,
  PlanningRunDetail,
  PlanningRunStatus,
  PlanningSettings,
  PlanningTriggerKind,
  PlanningTriggerReceipt,
  TaskDispatchReadiness,
} from "@pluginmax/contracts";
import {
  planningArtifactPayloadSchema,
  planningArtifactSchema,
  planningEventSchema,
  planningFeatureFlagSchema,
  planningPolicyConfigSchema,
  planningPolicySchema,
  planningQualityMetricSchema,
  planningRunSchema,
  planningTriggerReceiptSchema,
  PLANNING_AUTOPILOT_FLAG,
  PLANNING_MANUAL_FLAG,
  PLANNING_RUN_TERMINAL_STATUSES,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface PlanningPolicyRow {
  id: string;
  scope_type: "platform" | "project";
  scope_id: string;
  config: PlanningPolicyConfig;
  revision: number;
  updated_by: string;
  updated_at: Date;
}

interface PlanningFeatureFlagRow {
  flag_key: string;
  mode: "off" | "observe" | "enforce" | "on";
  revision: number;
  updated_by: string;
  updated_at: Date;
}

interface PlanningRunRow {
  id: string;
  project_id: string;
  root_task_id: string;
  status: PlanningRunStatus;
  revision: number;
  trigger_kind: PlanningTriggerKind;
  root_task_revision: number;
  policy_revision: number;
  source_run_id: string | null;
  workflow_plan_id: string | null;
  trigger_count: number;
  created_by_principal_id: string;
  blocked_reason: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  paused_at: Date | null;
  terminal_at: Date | null;
}

interface PlanningTriggerReceiptRow {
  id: string;
  project_id: string;
  root_task_id: string;
  planning_run_id: string;
  trigger_kind: PlanningTriggerKind;
  root_task_revision: number;
  event_key: string;
  request_digest: string;
  status: "accepted" | "merged" | "discarded";
  reason: string;
  created_at: Date;
}

interface PlanningArtifactRow {
  id: string;
  run_id: string;
  kind: PlanningArtifactKind;
  version: number;
  content_digest: string;
  payload: unknown;
  created_by_principal_id: string;
  created_at: Date;
}

interface PlanningEventRow {
  id: string;
  run_id: string;
  seq: string;
  kind: PlanningEvent["kind"];
  event_key: string;
  actor_principal_id: string;
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

interface PlanningQualityMetricRow {
  id: string;
  run_id: string;
  version: number;
  critic_score: string | number | null;
  validator_error_count: number;
  acceptance_coverage: string | number | null;
  node_count: number;
  depth: number;
  human_review_required: boolean;
  auto_approve_eligible: boolean;
  recorded_by_principal_id: string;
  recorded_at: Date;
}

interface PlanningTaskRow {
  project_id: string;
  parent_task_id: string | null;
  revision: number;
}

export type PlanningRepositoryErrorCode =
  | "planning_run_not_found"
  | "planning_run_revision_conflict"
  | "planning_run_state_conflict"
  | "planning_policy_revision_conflict"
  | "planning_root_task_invalid"
  | "planning_task_revision_conflict"
  | "planning_manual_disabled"
  | "planning_autopilot_disabled"
  | "planning_trigger_disabled"
  | "planning_run_scope_mismatch"
  | "planning_run_not_ready"
  | "planning_artifact_invalid";

export class PlanningRepositoryError extends Error {
  constructor(
    readonly code: PlanningRepositoryErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlanningRepositoryError";
  }
}

export interface PlanningRunMutationResult {
  readonly detail: PlanningRunDetail;
  readonly created: boolean;
  readonly merged: boolean;
  readonly replayed: boolean;
}

export interface UpdatePlanningSettingsRecordInput {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly policy?: OptionalPlanningPolicyConfig | undefined;
  readonly flags?:
    | {
        readonly manual?: boolean | undefined;
        readonly autopilot?: boolean | undefined;
      }
    | undefined;
}

export type OptionalPlanningPolicyConfig = {
  readonly [K in Exclude<
    keyof PlanningPolicyConfig,
    "triggerPolicy"
  >]?: PlanningPolicyConfig[K] | undefined;
} & {
  readonly triggerPolicy?: Partial<PlanningTriggerPolicy> | undefined;
};

export interface StartPlanningRunRecordInput {
  readonly taskId: string;
  readonly actorId: string;
  readonly triggerKind: PlanningTriggerKind;
  readonly expectedTaskRevision?: number | undefined;
  readonly reason: string;
  readonly sourceRunId?: string | null;
}

export interface RecordPlanningArtifactInput {
  readonly runId: string;
  readonly actorId: string;
  readonly kind: PlanningArtifactKind;
  readonly payload: unknown;
}

export interface RecordPlanningQualityMetricInput {
  readonly runId: string;
  readonly actorId: string;
  readonly criticScore: number | null;
  readonly validatorErrorCount: number;
  readonly acceptanceCoverage: number | null;
  readonly nodeCount: number;
  readonly depth: number;
  readonly humanReviewRequired: boolean;
  readonly autoApproveEligible: boolean;
}

export interface LockedPlanningRun {
  readonly id: string;
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly revision: number;
  readonly status: PlanningRunStatus;
}

export type PlanningRunContextSnapshot = Omit<
  PlanningContextPackPayload,
  "version" | "platformSafetyRules" | "knowledgeContributions"
> & {
  readonly run: PlanningRun;
};

export interface AdvancePlanningRunInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly toStatus: PlanningRunStatus;
  readonly actorId: string;
  readonly reason: string;
  readonly data?: Record<string, unknown> | null;
}

export class PlanningRepository {
  constructor(private readonly database: Database) {}

  async getSettings(projectId: string): Promise<PlanningSettings> {
    return this.database.transaction(async (client) => {
      const policy = await ensureProjectPolicyWithClient(client, projectId);
      const manual = await effectivePlanningFlagWithClient(
        client,
        projectId,
        PLANNING_MANUAL_FLAG,
      );
      const autopilot = await effectivePlanningFlagWithClient(
        client,
        projectId,
        PLANNING_AUTOPILOT_FLAG,
      );
      return planningSettingsFromRows(projectId, policy, manual, autopilot);
    });
  }

  async updateSettings(
    input: UpdatePlanningSettingsRecordInput,
  ): Promise<PlanningSettings> {
    await this.database.transaction(async (client) => {
      const current = await ensureProjectPolicyWithClient(
        client,
        input.projectId,
        { forUpdate: true },
      );
      if (current.revision !== input.expectedRevision) {
        throw new PlanningRepositoryError(
          "planning_policy_revision_conflict",
          "Planning policy revision changed",
          { expectedRevision: input.expectedRevision, revision: current.revision },
        );
      }
      if (input.policy !== undefined) {
        const triggerPolicy =
          input.policy.triggerPolicy === undefined
            ? current.config.triggerPolicy
            : {
                ...current.config.triggerPolicy,
                ...input.policy.triggerPolicy,
              };
        const config = planningPolicyConfigSchema.parse({
          ...current.config,
          ...input.policy,
          triggerPolicy,
        });
        await client.query(
          `UPDATE planning_policies
           SET config = $2::jsonb,
               revision = revision + 1,
               updated_by = $3,
               updated_at = NOW()
           WHERE id = $1`,
          [current.id, JSON.stringify(config), input.actorId],
        );
      }
      if (input.flags?.manual !== undefined) {
        await setProjectPlanningFlagWithClient(
          client,
          input.projectId,
          PLANNING_MANUAL_FLAG,
          input.flags.manual,
          input.actorId,
        );
      }
      if (input.flags?.autopilot !== undefined) {
        await setProjectPlanningFlagWithClient(
          client,
          input.projectId,
          PLANNING_AUTOPILOT_FLAG,
          input.flags.autopilot,
          input.actorId,
        );
      }
    });
    return this.getSettings(input.projectId);
  }

  async startRun(
    input: StartPlanningRunRecordInput,
  ): Promise<PlanningRunMutationResult> {
    return this.database.transaction(async (client) => {
      const task = await lockPlanningRootTaskWithClient(client, input.taskId);
      if (
        input.expectedTaskRevision !== undefined &&
        input.expectedTaskRevision !== task.revision
      ) {
        throw new PlanningRepositoryError(
          "planning_task_revision_conflict",
          "Root Task revision changed",
          {
            expectedRevision: input.expectedTaskRevision,
            revision: task.revision,
          },
        );
      }
      const policy = await ensureProjectPolicyWithClient(
        client,
        task.project_id,
      );
      await assertPlanningTriggerEnabledWithClient(
        client,
        task.project_id,
        input.triggerKind,
      );
      assertPlanningPolicyTriggerEnabled(policy.config, input.triggerKind);

      const eventKey = planningTriggerEventKey({
        projectId: task.project_id,
        rootTaskId: input.taskId,
        rootTaskRevision: task.revision,
        triggerKind: input.triggerKind,
        actorPrincipalId: input.actorId,
        sourceRunId: input.sourceRunId ?? null,
      });
      const requestDigest = stableDigest({
        taskId: input.taskId,
        taskRevision: task.revision,
        triggerKind: input.triggerKind,
        actorId: input.actorId,
        sourceRunId: input.sourceRunId ?? null,
        reason: input.reason,
      });
      const existingReceipt = await findPlanningReceiptWithClient(
        client,
        task.project_id,
        input.taskId,
        eventKey,
      );
      if (existingReceipt !== undefined) {
        return {
          detail: await this.getRunDetailWithClient(
            client,
            existingReceipt.planning_run_id,
          ),
          created: false,
          merged: false,
          replayed: true,
        };
      }

      const active = await client.query<PlanningRunRow>(
        `SELECT *
         FROM planning_runs
         WHERE root_task_id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled')
         FOR UPDATE`,
        [input.taskId],
      );
      if (active.rows[0] !== undefined) {
        const run = active.rows[0];
        await insertPlanningReceiptWithClient(client, {
          projectId: task.project_id,
          rootTaskId: input.taskId,
          planningRunId: run.id,
          triggerKind: input.triggerKind,
          taskRevision: task.revision,
          eventKey,
          requestDigest,
          status: "merged",
          reason: input.reason,
        });
        const updated = await client.query<PlanningRunRow>(
          `UPDATE planning_runs
           SET trigger_count = trigger_count + 1,
               revision = revision + 1,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [run.id],
        );
        await appendPlanningEventWithClient(client, {
          runId: run.id,
          kind: "trigger.merged",
          eventKey: stableDigest({
            runId: run.id,
            kind: "trigger.merged",
            revision: updated.rows[0]!.revision,
            receipt: eventKey,
          }),
          actorId: input.actorId,
          summary: "新的 Planning Trigger 已合并到活动 Run",
          data: {
            triggerKind: input.triggerKind,
            taskRevision: task.revision,
            receiptEventKey: eventKey,
          },
        });
        return {
          detail: await this.getRunDetailWithClient(client, run.id),
          created: false,
          merged: true,
          replayed: false,
        };
      }

      const runId = randomUUID();
      await client.query<PlanningRunRow>(
        `INSERT INTO planning_runs (
           id, project_id, root_task_id, status, revision, trigger_kind,
           root_task_revision, policy_revision, source_run_id,
           trigger_count, created_by_principal_id, created_at, updated_at,
           started_at
         ) VALUES (
           $1, $2, $3, 'preparing', 1, $4, $5, $6, $7,
           1, $8, NOW(), NOW(), NOW()
         )
         RETURNING *`,
        [
          runId,
          task.project_id,
          input.taskId,
          input.triggerKind,
          task.revision,
          policy.revision,
          input.sourceRunId ?? null,
          input.actorId,
        ],
      );
      await insertPlanningReceiptWithClient(client, {
        projectId: task.project_id,
        rootTaskId: input.taskId,
        planningRunId: runId,
        triggerKind: input.triggerKind,
        taskRevision: task.revision,
        eventKey,
        requestDigest,
        status: "accepted",
        reason: input.reason,
      });
      await appendPlanningEventWithClient(client, {
        runId,
        kind: "run.created",
        eventKey: stableDigest({
          runId,
          kind: "run.created",
          revision: 1,
        }),
        actorId: input.actorId,
        summary: "Planning Run 已创建",
        data: {
          triggerKind: input.triggerKind,
          taskRevision: task.revision,
          sourceRunId: input.sourceRunId ?? null,
        },
      });
      return {
        detail: await this.getRunDetailWithClient(client, runId),
        created: true,
        merged: false,
        replayed: false,
      };
    });
  }

  async pauseRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<PlanningRunDetail> {
    return this.transitionRun({
      ...input,
      action: "pause",
    });
  }

  async resumeRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<PlanningRunDetail> {
    return this.transitionRun({
      ...input,
      action: "resume",
    });
  }

  async cancelRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<PlanningRunDetail> {
    return this.transitionRun({
      ...input,
      action: "cancel",
    });
  }

  async markReviewRequired(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<PlanningRunDetail> {
    return this.transitionRun({
      ...input,
      action: "review",
    });
  }

  async retryRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<PlanningRunMutationResult> {
    return this.database.transaction(async (client) => {
      const current = await lockPlanningRunWithClient(client, input.runId);
      assertPlanningRevision(current, input.expectedRevision);
      if (current.status === "review_required") {
        const updated = await client.query<PlanningRunRow>(
          `UPDATE planning_runs
           SET status = 'preparing',
               revision = revision + 1,
               blocked_reason = NULL,
               paused_at = NULL,
               started_at = COALESCE(started_at, NOW()),
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [current.id],
        );
        await insertPlanningReceiptWithClient(client, {
          projectId: current.project_id,
          rootTaskId: current.root_task_id,
          planningRunId: current.id,
          triggerKind: "replan-requested",
          taskRevision: current.root_task_revision,
          eventKey: planningTriggerEventKey({
            projectId: current.project_id,
            rootTaskId: current.root_task_id,
            rootTaskRevision: current.root_task_revision,
            triggerKind: "replan-requested",
            actorPrincipalId: input.actorId,
            sourceRunId: current.id,
            runRevision: current.revision,
          }),
          requestDigest: stableDigest({
            retryRunId: current.id,
            runRevision: input.expectedRevision,
            reason: input.reason,
          }),
          status: "merged",
          reason: input.reason,
        });
        await appendPlanningEventWithClient(client, {
          runId: current.id,
          kind: "run.retried",
          eventKey: stableDigest({
            runId: current.id,
            kind: "run.retried",
            revision: updated.rows[0]!.revision,
          }),
          actorId: input.actorId,
          summary: "Planning Run 已重新开始",
          data: { reason: input.reason },
        });
        return {
          detail: await this.getRunDetailWithClient(client, current.id),
          created: false,
          merged: true,
          replayed: false,
        };
      }
      if (!isTerminalPlanningRunStatus(current.status)) {
        throw new PlanningRepositoryError(
          "planning_run_state_conflict",
          "An active planning run cannot be retried in place",
        );
      }
      const task = await lockPlanningRootTaskWithClient(
        client,
        current.root_task_id,
      );
      const policy = await ensureProjectPolicyWithClient(
        client,
        current.project_id,
      );
      await assertPlanningTriggerEnabledWithClient(
        client,
        current.project_id,
        "replan-requested",
      );
      assertPlanningPolicyTriggerEnabled(policy.config, "replan-requested");
      const runId = randomUUID();
      await client.query(
        `INSERT INTO planning_runs (
           id, project_id, root_task_id, status, revision, trigger_kind,
           root_task_revision, policy_revision, source_run_id,
           trigger_count, created_by_principal_id, created_at, updated_at,
           started_at
         ) VALUES (
           $1, $2, $3, 'preparing', 1, 'replan-requested', $4, $5, $6,
           1, $7, NOW(), NOW(), NOW()
         )`,
        [
          runId,
          current.project_id,
          current.root_task_id,
          task.revision,
          policy.revision,
          current.id,
          input.actorId,
        ],
      );
      const eventKey = planningTriggerEventKey({
        projectId: current.project_id,
        rootTaskId: current.root_task_id,
        rootTaskRevision: task.revision,
        triggerKind: "replan-requested",
        actorPrincipalId: input.actorId,
        sourceRunId: current.id,
      });
      await insertPlanningReceiptWithClient(client, {
        projectId: current.project_id,
        rootTaskId: current.root_task_id,
        planningRunId: runId,
        triggerKind: "replan-requested",
        taskRevision: task.revision,
        eventKey,
        requestDigest: stableDigest({
          sourceRunId: current.id,
          taskRevision: task.revision,
          reason: input.reason,
        }),
        status: "accepted",
        reason: input.reason,
      });
      await appendPlanningEventWithClient(client, {
        runId,
        kind: "run.created",
        eventKey: stableDigest({
          runId,
          kind: "run.created",
          revision: 1,
        }),
        actorId: input.actorId,
        summary: "Planning Run 已由重试创建",
        data: {
          sourceRunId: current.id,
          taskRevision: task.revision,
        },
      });
      return {
        detail: await this.getRunDetailWithClient(client, runId),
        created: true,
        merged: false,
        replayed: false,
      };
    });
  }

  async getRunDetail(runId: string): Promise<PlanningRunDetail> {
    return this.database.transaction((client) =>
      this.getRunDetailWithClient(client, runId),
    );
  }

  async getOverview(taskId: string): Promise<PlanningOverview> {
    const task = await this.database.query<{
      project_id: string;
      parent_task_id: string | null;
    }>(
      `SELECT project_id, parent_task_id
       FROM tasks
       WHERE id = $1`,
      [taskId],
    );
    const row = task.rows[0];
    if (row === undefined || row.parent_task_id !== null) {
      throw new PlanningRepositoryError(
        "planning_root_task_invalid",
        "Planning status is only available for a root task",
      );
    }
    const active = await this.findActiveRun(taskId);
    const latest = await this.findLatestRun(taskId);
    return {
      projectId: row.project_id,
      rootTaskId: taskId,
      activeRun:
        active === undefined ? null : await this.getRunDetail(active.id),
      latestRun:
        latest === undefined ? null : await this.getRunDetail(latest.id),
    };
  }

  async getRunContextSnapshot(
    runId: string,
  ): Promise<PlanningRunContextSnapshot> {
    return this.database.transaction(async (client) => {
      const runRow = await lockPlanningRunWithClient(client, runId);
      const rootTask = await client.query<{
        id: string;
        project_id: string;
        parent_task_id: string | null;
        title: string;
        description: string;
        acceptance: string[];
        status: PlanningContextPackPayload["rootTask"]["status"];
        priority: PlanningContextPackPayload["rootTask"]["priority"];
        agent_id: string;
        role_id: string | null;
        revision: number;
      }>(
        `SELECT id, project_id, parent_task_id, title, description, acceptance,
                status, priority, agent_id, role_id, revision
         FROM tasks
         WHERE id = $1`,
        [runRow.root_task_id],
      );
      const task = rootTask.rows[0];
      if (task === undefined) {
        throw new PlanningRepositoryError(
          "planning_root_task_invalid",
          "Planning root task does not exist",
        );
      }
      const projectResult = await client.query<{
        id: string;
        name: string;
        status: PlanningContextPackPayload["project"]["status"];
      }>(
        "SELECT id, name, status FROM projects WHERE id = $1",
        [task.project_id],
      );
      const project = projectResult.rows[0];
      if (project === undefined) {
        throw new PlanningRepositoryError(
          "planning_root_task_invalid",
          "Planning project does not exist",
        );
      }
      const members = await client.query<{
        id: string;
        kind: PlanningContextPackPayload["members"][number]["kind"];
        actor_id: string;
        principal_id: string | null;
        name: string;
        responsibility: string;
        status: PlanningContextPackPayload["members"][number]["status"];
        role_ids: string[];
      }>(
        `SELECT member.id, member.kind, member.actor_id, member.principal_id,
                member.name, member.responsibility, member.status,
                COALESCE(
                  array_agg(member_role.role_id)
                    FILTER (WHERE member_role.role_id IS NOT NULL),
                  ARRAY[]::uuid[]
                ) AS role_ids
         FROM project_members AS member
         LEFT JOIN project_member_roles AS member_role
           ON member_role.project_member_id = member.id
         WHERE member.project_id = $1
         GROUP BY member.id
         ORDER BY member.is_owner DESC, member.created_at, member.name
         LIMIT 500`,
        [task.project_id],
      );
      const roles = await client.query<{
        id: string;
        code: string;
        name: string;
        category: string;
        permissions: string[];
      }>(
        `SELECT id, code, name, category, permissions
         FROM project_roles
         WHERE project_id = $1
         ORDER BY created_at, name
         LIMIT 200`,
        [task.project_id],
      );
      const agents = await client.query<{
        agent_id: string;
        name: string;
        runtime_kind: string;
        status: PlanningContextPackPayload["agentCandidates"][number]["status"];
        source: string;
        teammate_id: string | null;
      }>(
        `SELECT agent.id AS agent_id, agent.name, agent.runtime_kind,
                agent.status, agent.source, teammate.id AS teammate_id
         FROM agents AS agent
         LEFT JOIN teammates AS teammate
           ON teammate.agent_id = agent.id
          AND teammate.project_id = $1
          AND teammate.status NOT IN ('archived', 'inactive')
         WHERE agent.status = 'active'
           AND (
             agent.id = $2
             OR teammate.id IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM project_members AS member
               WHERE member.project_id = $1
                 AND member.kind = 'agent'
                 AND member.actor_id = agent.id::text
                 AND member.status = 'active'
             )
           )
         ORDER BY
           CASE WHEN agent.id = $2 THEN 0 ELSE 1 END,
           agent.name
         LIMIT 500`,
        [task.project_id, task.agent_id],
      );
      const meetings = await client.query<{
        id: string;
        title: string;
        status: PlanningContextPackPayload["meetings"][number]["status"];
        updated_at: Date;
      }>(
        `SELECT id, title, status, updated_at
         FROM meetings
         WHERE project_id = $1
         ORDER BY updated_at DESC
         LIMIT 200`,
        [task.project_id],
      );
      const workflows = await client.query<{
        id: string;
        title: string;
        status: PlanningContextPackPayload["workflows"][number]["status"];
        updated_at: Date;
      }>(
        `SELECT id, name AS title, status, updated_at
         FROM workflow_definitions
         WHERE project_id = $1
         ORDER BY updated_at DESC
         LIMIT 200`,
        [task.project_id],
      );
      const documents = await client.query<{
        id: string;
        title: string;
        mime_type: string;
        sha256: string | null;
        updated_at: Date;
      }>(
        `SELECT id, name AS title, mime_type, sha256,
                COALESCE(archived_at, created_at) AS updated_at
         FROM task_attachments
         WHERE task_id = $1 AND archived_at IS NULL
         ORDER BY created_at DESC
         LIMIT 500`,
        [task.id],
      );
      const memories = await client.query<{
        id: string;
        title: string;
        source_type: string;
        source_id: string;
        updated_at: Date;
      }>(
        `SELECT truth.id, topic.title, truth.source_type, truth.source_id,
                truth.created_at AS updated_at
         FROM memory_truths AS truth
         JOIN memory_topics AS topic ON topic.id = truth.topic_id
         WHERE truth.project_id = $1
           AND truth.version = (
             SELECT MAX(current.version)
             FROM memory_truths AS current
             WHERE current.topic_id = truth.topic_id
           )
         ORDER BY truth.created_at DESC
         LIMIT 500`,
        [task.project_id],
      );
      return {
        run: planningRunFromRow(runRow),
        rootTaskRevision: task.revision,
        rootTask: {
          id: task.id,
          projectId: task.project_id,
          parentTaskId: task.parent_task_id,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          status: task.status,
          priority: task.priority,
          agentId: task.agent_id,
          roleId: task.role_id,
          revision: task.revision,
        },
        project,
        members: members.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          actorId: row.actor_id,
          principalId: row.principal_id,
          name: row.name,
          responsibility: row.responsibility,
          status: row.status,
          roleIds: row.role_ids,
        })),
        roles: roles.rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          category: row.category,
          permissions: row.permissions,
        })),
        agentCandidates: agents.rows.map((row) => ({
          agentId: row.agent_id,
          name: row.name,
          runtimeKind: row.runtime_kind,
          status: row.status,
          source: row.source,
          teammateId: row.teammate_id,
        })),
        meetings: meetings.rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
        })),
        workflows: workflows.rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          updatedAt: row.updated_at.toISOString(),
        })),
        documents: documents.rows.map((row) => ({
          id: row.id,
          title: row.title,
          mimeType: row.mime_type,
          sha256: row.sha256,
          updatedAt: row.updated_at.toISOString(),
        })),
        memories: memories.rows.map((row) => ({
          id: row.id,
          title: row.title,
          sourceType: row.source_type,
          sourceId: row.source_id,
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    });
  }

  async listProcessableRunIds(limit = 4): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id
       FROM planning_runs
       WHERE status IN (
         'queued',
         'preparing',
         'understanding',
         'clarifying',
         'drafting',
         'critiquing',
         'validating'
       )
       ORDER BY updated_at, created_at
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }

  async advanceRun(input: AdvancePlanningRunInput): Promise<PlanningRunDetail> {
    return this.database.transaction(async (client) => {
      const current = await lockPlanningRunWithClient(client, input.runId);
      assertPlanningRevision(current, input.expectedRevision);
      assertWorkerTransition(current.status, input.toStatus);
      if (isTerminalPlanningRunStatus(input.toStatus)) {
        throw new PlanningRepositoryError(
          "planning_run_state_conflict",
          "Terminal states require their dedicated transaction",
        );
      }
      const updated = await client.query<PlanningRunRow>(
        `UPDATE planning_runs
         SET status = $2,
             revision = revision + 1,
             blocked_reason =
               CASE WHEN $2 = 'review_required' THEN $3 ELSE NULL END,
             paused_at = NULL,
             started_at = CASE
               WHEN $2 = 'preparing' THEN COALESCE(started_at, NOW())
               ELSE started_at
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [current.id, input.toStatus, input.reason],
      );
      await appendPlanningEventWithClient(client, {
        runId: current.id,
        kind:
          input.toStatus === "review_required"
            ? "run.review_required"
            : "run.started",
        eventKey: stableDigest({
          runId: current.id,
          kind:
            input.toStatus === "review_required"
              ? "run.review_required"
              : "run.started",
          revision: updated.rows[0]!.revision,
          status: input.toStatus,
        }),
        actorId: input.actorId,
        summary: `Planning Run 进入 ${input.toStatus}`,
        data: {
          fromStatus: current.status,
          toStatus: input.toStatus,
          reason: input.reason,
          ...input.data,
        },
      });
      return this.getRunDetailWithClient(client, current.id);
    });
  }

  async failRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly failureCode: string;
    readonly reason: string;
  }): Promise<PlanningRunDetail> {
    return this.database.transaction(async (client) => {
      const current = await lockPlanningRunWithClient(client, input.runId);
      assertPlanningRevision(current, input.expectedRevision);
      if (isTerminalPlanningRunStatus(current.status)) {
        throw new PlanningRepositoryError(
          "planning_run_state_conflict",
          "Terminal Planning Run cannot fail again",
        );
      }
      const updated = await client.query<PlanningRunRow>(
        `UPDATE planning_runs
         SET status = 'failed',
             revision = revision + 1,
             failure_code = $2,
             blocked_reason = $3,
             paused_at = NULL,
             terminal_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [current.id, input.failureCode, input.reason],
      );
      await appendPlanningEventWithClient(client, {
        runId: current.id,
        kind: "run.failed",
        eventKey: stableDigest({
          runId: current.id,
          kind: "run.failed",
          revision: updated.rows[0]!.revision,
        }),
        actorId: input.actorId,
        summary: "Planning Run 执行失败",
        data: {
          failureCode: input.failureCode,
          reason: input.reason,
        },
      });
      return this.getRunDetailWithClient(client, current.id);
    });
  }

  async getTaskDispatchReadiness(
    taskId: string,
  ): Promise<TaskDispatchReadiness> {
    return this.database.transaction(async (client) => {
      const taskResult = await client.query<{
        id: string;
        project_id: string;
        parent_task_id: string | null;
        role_id: string | null;
        agent_id: string;
        claim_owner: string | null;
        origin_kind: string | null;
      }>(
        `SELECT task.id, task.project_id, task.parent_task_id, task.role_id,
                task.agent_id, task.execution_claim_owner AS claim_owner,
                origin.source_kind AS origin_kind
         FROM tasks AS task
         LEFT JOIN task_origins AS origin ON origin.task_id = task.id
         WHERE task.id = $1`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (task === undefined) return { ready: true };
      if (
        task.parent_task_id !== null ||
        task.origin_kind === "router"
      ) {
        return { ready: true };
      }
      const humanAssignment = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM project_members AS member
           JOIN project_member_roles AS member_role
             ON member_role.project_member_id = member.id
           WHERE member.project_id = $1
             AND member.kind = 'human'
             AND member.status = 'active'
             AND $2::uuid IS NOT NULL
             AND member_role.role_id = $2
         ) AS exists`,
        [task.project_id, task.role_id],
      );
      if (humanAssignment.rows[0]?.exists === true) {
        return { ready: true };
      }
      const activeRun = await client.query<PlanningRunRow>(
        `SELECT *
         FROM planning_runs
         WHERE root_task_id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled')
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId],
      );
      const run = activeRun.rows[0];
      const manual = await effectivePlanningFlagWithClient(
        client,
        task.project_id,
        PLANNING_MANUAL_FLAG,
      );
      const autopilot = await effectivePlanningFlagWithClient(
        client,
        task.project_id,
        PLANNING_AUTOPILOT_FLAG,
      );
      if (
        !["on", "enforce"].includes(manual.mode) &&
        !["on", "enforce"].includes(autopilot.mode)
      ) {
        if (run !== undefined) {
          return {
            ready: false,
            code: "planning-blocked",
            message: "Planning Gate 关闭时存在活动 Planning Run，需显式恢复或取消",
            planningRunId: run.id,
            planId: run.workflow_plan_id,
          };
        }
        const unconfirmed = await client.query<{
          id: string;
          planning_run_id: string | null;
        }>(
          `SELECT id, planning_run_id
           FROM workflow_plans
           WHERE root_task_id = $1
             AND planning_run_id IS NOT NULL
             AND confirmed_at IS NULL
           ORDER BY updated_at DESC
           LIMIT 1`,
          [taskId],
        );
        const pendingPlan = unconfirmed.rows[0];
        if (pendingPlan !== undefined) {
          return {
            ready: false,
            code: "planning-blocked",
            message: "Planning Gate 关闭时存在未确认的 Planning Plan",
            planningRunId: pendingPlan.planning_run_id,
            planId: pendingPlan.id,
          };
        }
        return { ready: true };
      }

      if (run !== undefined) {
        if (run.status === "review_required") {
          return {
            ready: false,
            code: "planning-review-required",
            message: "AI 根任务的计划仍在等待人工审核",
            planningRunId: run.id,
            planId: run.workflow_plan_id,
            retryToken: `planning-run:${run.id}:review`,
          };
        }
        if (run.status === "paused") {
          return {
            ready: false,
            code: "planning-blocked",
            message: "AI 根任务的 Planning Run 已暂停",
            planningRunId: run.id,
            planId: run.workflow_plan_id,
          };
        }
        return {
          ready: false,
          code: "planning-running",
          message: "AI 根任务正在生成计划",
          planningRunId: run.id,
          planId: run.workflow_plan_id,
          retryToken: `planning-run:${run.id}:${run.revision}`,
        };
      }

      const latestPlan = await client.query<{
        id: string;
        status: string;
        confirmed_at: Date | null;
        planning_run_id: string | null;
      }>(
        `SELECT id, status, confirmed_at, planning_run_id
         FROM workflow_plans
         WHERE root_task_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [taskId],
      );
      const plan = latestPlan.rows[0];
      if (
        plan !== undefined &&
        (plan.confirmed_at !== null ||
          ["approved", "active", "finalizing", "completed"].includes(
            plan.status,
          ))
      ) {
        return { ready: true };
      }
      if (plan !== undefined) {
        if (["draft", "proposed"].includes(plan.status)) {
          return {
            ready: false,
            code: "planning-review-required",
            message: "AI 根任务的计划尚未确认",
            planningRunId: plan.planning_run_id,
            planId: plan.id,
            retryToken: `plan:${plan.id}:review`,
          };
        }
        return {
          ready: false,
          code: "planning-blocked",
          message: `AI 根任务的最新计划状态为 ${plan.status}`,
          planningRunId: plan.planning_run_id,
          planId: plan.id,
        };
      }

      const terminalRun = await client.query<PlanningRunRow>(
        `SELECT *
         FROM planning_runs
         WHERE root_task_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId],
      );
      const lastRun = terminalRun.rows[0];
      if (lastRun !== undefined) {
        return {
          ready: false,
          code: "planning-blocked",
          message:
            lastRun.status === "succeeded"
              ? "Planning Run 已成功但未绑定 Workflow Plan"
              : "AI 根任务的最近一次规划未成功",
          planningRunId: lastRun.id,
          planId: lastRun.workflow_plan_id,
        };
      }
      return {
        ready: false,
        code: "planning-required",
        message: "AI 根任务必须先完成并确认计划",
        planningRunId: null,
        planId: null,
      };
    });
  }

  async recordArtifact(
    input: RecordPlanningArtifactInput,
  ): Promise<PlanningArtifact> {
    return this.database.transaction(async (client) => {
      const run = await lockPlanningRunWithClient(client, input.runId);
      if (isTerminalPlanningRunStatus(run.status)) {
        throw new PlanningRepositoryError(
          "planning_run_state_conflict",
          "Artifacts cannot be appended to a terminal planning run",
        );
      }
      const payload = planningArtifactPayloadSchema(input.kind).parse(
        input.payload,
      );
      const version = await nextRunChildVersionWithClient(
        client,
        "planning_artifacts",
        run.id,
      );
      const inserted = await client.query<PlanningArtifactRow>(
        `INSERT INTO planning_artifacts (
           id, run_id, kind, version, content_digest, payload,
           created_by_principal_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
         RETURNING *`,
        [
          randomUUID(),
          run.id,
          input.kind,
          version,
          stableDigest(payload),
          JSON.stringify(payload),
          input.actorId,
        ],
      );
      await appendPlanningEventWithClient(client, {
        runId: run.id,
        kind: "artifact.recorded",
        eventKey: stableDigest({
          runId: run.id,
          kind: "artifact.recorded",
          artifactId: inserted.rows[0]!.id,
        }),
        actorId: input.actorId,
        summary: `Planning Artifact 已记录：${input.kind}`,
        data: {
          artifactId: inserted.rows[0]!.id,
          artifactKind: input.kind,
          version,
        },
      });
      return planningArtifactFromRow(inserted.rows[0]!);
    });
  }

  async recordQualityMetric(
    input: RecordPlanningQualityMetricInput,
  ): Promise<PlanningQualityMetric> {
    return this.database.transaction(async (client) => {
      const run = await lockPlanningRunWithClient(client, input.runId);
      if (isTerminalPlanningRunStatus(run.status)) {
        throw new PlanningRepositoryError(
          "planning_run_state_conflict",
          "Quality metrics cannot be appended to a terminal planning run",
        );
      }
      const version = await nextRunChildVersionWithClient(
        client,
        "planning_quality_metrics",
        run.id,
      );
      const inserted = await client.query<PlanningQualityMetricRow>(
        `INSERT INTO planning_quality_metrics (
           id, run_id, version, critic_score, validator_error_count,
           acceptance_coverage, node_count, depth, human_review_required,
           auto_approve_eligible, recorded_by_principal_id, recorded_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
         )
         RETURNING *`,
        [
          randomUUID(),
          run.id,
          version,
          input.criticScore,
          input.validatorErrorCount,
          input.acceptanceCoverage,
          input.nodeCount,
          input.depth,
          input.humanReviewRequired,
          input.autoApproveEligible,
          input.actorId,
        ],
      );
      await appendPlanningEventWithClient(client, {
        runId: run.id,
        kind: "quality.recorded",
        eventKey: stableDigest({
          runId: run.id,
          kind: "quality.recorded",
          metricId: inserted.rows[0]!.id,
        }),
        actorId: input.actorId,
        summary: "Planning 质量指标已记录",
        data: {
          metricId: inserted.rows[0]!.id,
          version,
        },
      });
      return planningQualityMetricFromRow(inserted.rows[0]!);
    });
  }

  private async transitionRun(input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
    readonly action: "pause" | "resume" | "cancel" | "review";
  }): Promise<PlanningRunDetail> {
    return this.database.transaction(async (client) => {
      const run = await lockPlanningRunWithClient(client, input.runId);
      assertPlanningRevision(run, input.expectedRevision);
      let sql: string;
      let kind: PlanningEvent["kind"];
      let summary: string;
      switch (input.action) {
        case "pause":
          if (
            ![
              "queued",
              "preparing",
              "understanding",
              "clarifying",
              "drafting",
              "critiquing",
              "validating",
            ].includes(run.status)
          ) {
            throw new PlanningRepositoryError(
              "planning_run_state_conflict",
              "Planning Run cannot be paused from its current status",
            );
          }
          sql = `UPDATE planning_runs
                 SET status = 'paused',
                     revision = revision + 1,
                     paused_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1`;
          kind = "run.paused";
          summary = "Planning Run 已暂停";
          break;
        case "resume":
          if (!["queued", "paused"].includes(run.status)) {
            throw new PlanningRepositoryError(
              "planning_run_state_conflict",
              "Only queued or paused Planning Runs can be started",
            );
          }
          sql = `UPDATE planning_runs
                 SET status = 'preparing',
                     revision = revision + 1,
                     paused_at = NULL,
                     started_at = COALESCE(started_at, NOW()),
                     updated_at = NOW()
                 WHERE id = $1`;
          kind = "run.started";
          summary = "Planning Run 已开始";
          break;
        case "cancel":
          if (isTerminalPlanningRunStatus(run.status)) {
            throw new PlanningRepositoryError(
              "planning_run_state_conflict",
              "Terminal Planning Runs cannot be cancelled",
            );
          }
          sql = `UPDATE planning_runs
                 SET status = 'cancelled',
                     revision = revision + 1,
                     paused_at = NULL,
                     terminal_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1`;
          kind = "run.cancelled";
          summary = "Planning Run 已取消";
          break;
        case "review":
          if (
            ![
              "preparing",
              "understanding",
              "clarifying",
              "drafting",
              "critiquing",
              "validating",
            ].includes(run.status)
          ) {
            throw new PlanningRepositoryError(
              "planning_run_state_conflict",
              "Planning Run cannot enter review from its current status",
            );
          }
          sql = `UPDATE planning_runs
                 SET status = 'review_required',
                     revision = revision + 1,
                     blocked_reason = $2,
                     updated_at = NOW()
                 WHERE id = $1`;
          kind = "run.review_required";
          summary = "Planning Run 等待人工审核";
          break;
      }
      const values =
        input.action === "review"
          ? [run.id, input.reason]
          : [run.id];
      const updated = await client.query<PlanningRunRow>(
        `${sql} RETURNING *`,
        values,
      );
      await appendPlanningEventWithClient(client, {
        runId: run.id,
        kind,
        eventKey: stableDigest({
          runId: run.id,
          kind,
          revision: updated.rows[0]!.revision,
        }),
        actorId: input.actorId,
        summary,
        data: { reason: input.reason },
      });
      return this.getRunDetailWithClient(client, run.id);
    });
  }

  private async getRunDetailWithClient(
    executor: Pick<PoolClient, "query">,
    runId: string,
  ): Promise<PlanningRunDetail> {
    const runResult = await executor.query<PlanningRunRow>(
      "SELECT * FROM planning_runs WHERE id = $1",
      [runId],
    );
    const runRow = runResult.rows[0];
    if (runRow === undefined) {
      throw new PlanningRepositoryError(
        "planning_run_not_found",
        "Planning Run not found",
      );
    }
    const receipts = await this.listReceiptsWithClient(executor, runId);
    const artifacts = await this.listArtifactsWithClient(executor, runId);
    const events = await this.listEventsWithClient(executor, runId);
    const metrics = await this.listMetricsWithClient(executor, runId);
    return planningDetailFromRows(
      planningRunFromRow(runRow),
      receipts,
      artifacts,
      events,
      metrics,
    );
  }

  private async listReceiptsWithClient(
    executor: Pick<PoolClient, "query">,
    runId: string,
  ): Promise<PlanningTriggerReceipt[]> {
    const result = await executor.query<PlanningTriggerReceiptRow>(
      `SELECT *
       FROM planning_trigger_receipts
       WHERE planning_run_id = $1
       ORDER BY created_at, id`,
      [runId],
    );
    return result.rows.map(planningReceiptFromRow);
  }

  private async listArtifactsWithClient(
    executor: Pick<PoolClient, "query">,
    runId: string,
  ): Promise<PlanningArtifact[]> {
    const result = await executor.query<PlanningArtifactRow>(
      `SELECT *
       FROM planning_artifacts
       WHERE run_id = $1
       ORDER BY kind, version`,
      [runId],
    );
    return result.rows.map(planningArtifactFromRow);
  }

  private async listEventsWithClient(
    executor: Pick<PoolClient, "query">,
    runId: string,
  ): Promise<PlanningEvent[]> {
    const result = await executor.query<PlanningEventRow>(
      `SELECT *
       FROM planning_events
       WHERE run_id = $1
       ORDER BY seq`,
      [runId],
    );
    return result.rows.map(planningEventFromRow);
  }

  private async listMetricsWithClient(
    executor: Pick<PoolClient, "query">,
    runId: string,
  ): Promise<PlanningQualityMetric[]> {
    const result = await executor.query<PlanningQualityMetricRow>(
      `SELECT *
       FROM planning_quality_metrics
       WHERE run_id = $1
       ORDER BY version`,
      [runId],
    );
    return result.rows.map(planningQualityMetricFromRow);
  }

  private async findActiveRun(
    taskId: string,
  ): Promise<PlanningRun | undefined> {
    const result = await this.database.query<PlanningRunRow>(
      `SELECT *
       FROM planning_runs
       WHERE root_task_id = $1
         AND status NOT IN ('succeeded', 'failed', 'cancelled')
       ORDER BY created_at DESC
       LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : planningRunFromRow(row);
  }

  private async findLatestRun(
    taskId: string,
  ): Promise<PlanningRun | undefined> {
    const result = await this.database.query<PlanningRunRow>(
      `SELECT *
       FROM planning_runs
       WHERE root_task_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : planningRunFromRow(row);
  }
}

export async function lockPlanningRunForPlanWithClient(
  client: PoolClient,
  input: {
    readonly planningRunId: string;
    readonly expectedRevision?: number | undefined;
    readonly projectId: string;
    readonly rootTaskId: string;
  },
): Promise<LockedPlanningRun> {
  const result = await client.query<PlanningRunRow>(
    "SELECT * FROM planning_runs WHERE id = $1 FOR UPDATE",
    [input.planningRunId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new PlanningRepositoryError(
      "planning_run_not_found",
      "Planning Run not found",
    );
  }
  if (
    row.project_id !== input.projectId ||
    row.root_task_id !== input.rootTaskId
  ) {
    throw new PlanningRepositoryError(
      "planning_run_scope_mismatch",
      "Planning Run scope does not match the Workflow Plan",
    );
  }
  if (
    input.expectedRevision !== undefined &&
    row.revision !== input.expectedRevision
  ) {
    throw new PlanningRepositoryError(
      "planning_run_revision_conflict",
      "Planning Run revision changed",
      { expectedRevision: input.expectedRevision, revision: row.revision },
    );
  }
  if (row.status !== "review_required") {
    throw new PlanningRepositoryError(
      "planning_run_not_ready",
      "Planning Run must be review_required before binding a Workflow Plan",
    );
  }
  return {
    id: row.id,
    projectId: row.project_id,
    rootTaskId: row.root_task_id,
    revision: row.revision,
    status: row.status,
  };
}

export async function completePlanningRunForPlanWithClient(
  client: PoolClient,
  input: {
    readonly planningRunId: string;
    readonly workflowPlanId: string;
    readonly actorId: string;
  },
): Promise<void> {
  const current = await client.query<PlanningRunRow>(
    "SELECT * FROM planning_runs WHERE id = $1 FOR UPDATE",
    [input.planningRunId],
  );
  const run = current.rows[0];
  if (run === undefined || run.status !== "review_required") {
    throw new PlanningRepositoryError(
      "planning_run_state_conflict",
      "Planning Run is no longer waiting for a Workflow Plan",
    );
  }
  const updated = await client.query<PlanningRunRow>(
    `UPDATE planning_runs
     SET status = 'succeeded',
         workflow_plan_id = $2,
         revision = revision + 1,
         terminal_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [run.id, input.workflowPlanId],
  );
  await appendPlanningEventWithClient(client, {
    runId: run.id,
    kind: "run.succeeded",
    eventKey: stableDigest({
      runId: run.id,
      kind: "run.succeeded",
      revision: updated.rows[0]!.revision,
    }),
    actorId: input.actorId,
    summary: "Planning Run 已生成 Workflow Plan",
    data: { workflowPlanId: input.workflowPlanId },
  });
}

export async function appendPlanningEventWithClient(
  client: PoolClient,
  input: {
    readonly runId: string;
    readonly kind: PlanningEvent["kind"];
    readonly eventKey: string;
    readonly actorId: string;
    readonly summary: string;
    readonly data: Record<string, unknown> | null;
  },
): Promise<void> {
  const seq = await client.query<{ seq: string }>(
    `SELECT (COALESCE(MAX(seq), 0) + 1)::text AS seq
     FROM planning_events
     WHERE run_id = $1`,
    [input.runId],
  );
  await client.query(
    `INSERT INTO planning_events (
       id, run_id, seq, kind, event_key, actor_principal_id, summary,
       data, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
     ON CONFLICT (event_key) DO NOTHING`,
    [
      randomUUID(),
      input.runId,
      seq.rows[0]!.seq,
      input.kind,
      input.eventKey,
      input.actorId,
      input.summary,
      input.data === null ? null : JSON.stringify(input.data),
    ],
  );
}

async function lockPlanningRootTaskWithClient(
  client: PoolClient,
  taskId: string,
): Promise<PlanningTaskRow> {
  const result = await client.query<PlanningTaskRow>(
    `SELECT project_id, parent_task_id, revision
     FROM tasks
     WHERE id = $1
     FOR UPDATE`,
    [taskId],
  );
  const task = result.rows[0];
  if (task === undefined) {
    throw new PlanningRepositoryError(
      "planning_root_task_invalid",
      "Planning root task does not exist",
    );
  }
  if (task.parent_task_id !== null) {
    throw new PlanningRepositoryError(
      "planning_root_task_invalid",
      "Planning may only start from a root task",
    );
  }
  return task;
}

async function lockPlanningRunWithClient(
  client: PoolClient,
  runId: string,
): Promise<PlanningRunRow> {
  const result = await client.query<PlanningRunRow>(
    "SELECT * FROM planning_runs WHERE id = $1 FOR UPDATE",
    [runId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new PlanningRepositoryError(
      "planning_run_not_found",
      "Planning Run not found",
    );
  }
  return row;
}

function assertPlanningRevision(
  run: PlanningRunRow,
  expectedRevision: number,
): void {
  if (run.revision !== expectedRevision) {
    throw new PlanningRepositoryError(
      "planning_run_revision_conflict",
      "Planning Run revision changed",
      { expectedRevision, revision: run.revision },
    );
  }
}

function isTerminalPlanningRunStatus(
  status: PlanningRunStatus,
): status is (typeof PLANNING_RUN_TERMINAL_STATUSES)[number] {
  return (PLANNING_RUN_TERMINAL_STATUSES as readonly PlanningRunStatus[]).includes(
    status,
  );
}

function assertWorkerTransition(
  from: PlanningRunStatus,
  to: PlanningRunStatus,
): void {
  const allowed: Partial<Record<PlanningRunStatus, PlanningRunStatus[]>> = {
    queued: ["preparing"],
    preparing: ["understanding"],
    understanding: ["clarifying", "drafting"],
    clarifying: ["understanding", "review_required"],
    drafting: ["critiquing"],
    critiquing: ["drafting", "validating"],
    validating: ["review_required"],
  };
  if (!(allowed[from] ?? []).includes(to)) {
    throw new PlanningRepositoryError(
      "planning_run_state_conflict",
      `Planning worker cannot transition ${from} -> ${to}`,
    );
  }
}

async function ensureProjectPolicyWithClient(
  client: PoolClient,
  projectId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PlanningPolicyRow> {
  const platform = await client.query<PlanningPolicyRow>(
    `SELECT *
     FROM planning_policies
     WHERE scope_type = 'platform' AND scope_id = 'platform'`,
  );
  const base = platform.rows[0];
  if (base === undefined) {
    throw new PlanningRepositoryError(
      "planning_policy_revision_conflict",
      "Platform Planning policy is missing",
    );
  }
  await client.query(
    `INSERT INTO planning_policies (
       id, scope_type, scope_id, config, revision, updated_by, updated_at
     ) VALUES ($1, 'project', $2, $3::jsonb, 1, 'system:planning', NOW())
     ON CONFLICT (scope_type, scope_id) DO NOTHING`,
    [
      randomUUID(),
      projectId,
      JSON.stringify(planningPolicyConfigSchema.parse(base.config)),
    ],
  );
  const project = await client.query<PlanningPolicyRow>(
    `SELECT *
     FROM planning_policies
     WHERE scope_type = 'project' AND scope_id = $1
     ${options.forUpdate === true ? "FOR UPDATE" : ""}`,
    [projectId],
  );
  return project.rows[0]!;
}

async function effectivePlanningFlagWithClient(
  client: PoolClient,
  projectId: string,
  flagKey: string,
): Promise<PlanningFeatureFlagRow> {
  const result = await client.query<PlanningFeatureFlagRow>(
    `SELECT flag_key, mode, revision, updated_by, updated_at
     FROM feature_flag_settings
     WHERE flag_key = $1
       AND (
         (scope_type = 'project' AND scope_id = $2)
         OR (scope_type = 'platform' AND scope_id = 'platform')
       )
     ORDER BY CASE scope_type WHEN 'project' THEN 0 ELSE 1 END
     LIMIT 1`,
    [flagKey, projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new PlanningRepositoryError(
      "planning_manual_disabled",
      "Planning Feature Flag is missing",
    );
  }
  return row;
}

async function setProjectPlanningFlagWithClient(
  client: PoolClient,
  projectId: string,
  flagKey: string,
  enabled: boolean,
  actorId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO feature_flag_settings (
       flag_key, scope_type, scope_id, mode, revision, updated_by, updated_at
     ) VALUES ($1, 'project', $2, $3, 1, $4, NOW())
     ON CONFLICT (flag_key, scope_type, scope_id)
     DO UPDATE SET
       mode = EXCLUDED.mode,
       revision = feature_flag_settings.revision + 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [flagKey, projectId, enabled ? "on" : "off", actorId],
  );
}

async function assertPlanningTriggerEnabledWithClient(
  client: PoolClient,
  projectId: string,
  triggerKind: PlanningTriggerKind,
): Promise<void> {
  const automatic =
    triggerKind === "agent-assigned" ||
    triggerKind === "task-spec-changed" ||
    triggerKind === "agent-requested";
  const row = await effectivePlanningFlagWithClient(
    client,
    projectId,
    automatic ? PLANNING_AUTOPILOT_FLAG : PLANNING_MANUAL_FLAG,
  );
  if (row.mode !== "on" && row.mode !== "enforce") {
    throw new PlanningRepositoryError(
      automatic ? "planning_autopilot_disabled" : "planning_manual_disabled",
      automatic
        ? "planning.autopilot Feature Flag is disabled"
        : "planning.manual Feature Flag is disabled",
    );
  }
}

function assertPlanningPolicyTriggerEnabled(
  config: PlanningPolicyConfig,
  triggerKind: PlanningTriggerKind,
): void {
  const enabled =
    triggerKind === "human-manual"
      ? true
      : triggerKind === "agent-assigned"
        ? config.triggerPolicy.agentAssigned
        : triggerKind === "task-spec-changed"
          ? config.triggerPolicy.taskSpecChanged
          : triggerKind === "agent-requested"
            ? config.triggerPolicy.agentRequested
            : config.triggerPolicy.replanRequested;
  if (!enabled) {
    throw new PlanningRepositoryError(
      "planning_trigger_disabled",
      `Planning Trigger ${triggerKind} is disabled by project policy`,
    );
  }
}

async function findPlanningReceiptWithClient(
  client: PoolClient,
  projectId: string,
  rootTaskId: string,
  eventKey: string,
): Promise<PlanningTriggerReceiptRow | undefined> {
  const result = await client.query<PlanningTriggerReceiptRow>(
    `SELECT *
     FROM planning_trigger_receipts
     WHERE project_id = $1 AND root_task_id = $2 AND event_key = $3`,
    [projectId, rootTaskId, eventKey],
  );
  return result.rows[0];
}

async function insertPlanningReceiptWithClient(
  client: PoolClient,
  input: {
    readonly projectId: string;
    readonly rootTaskId: string;
    readonly planningRunId: string;
    readonly triggerKind: PlanningTriggerKind;
    readonly taskRevision: number;
    readonly eventKey: string;
    readonly requestDigest: string;
    readonly status: "accepted" | "merged" | "discarded";
    readonly reason: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO planning_trigger_receipts (
       id, project_id, root_task_id, planning_run_id, trigger_kind,
       root_task_revision, event_key, request_digest, status, reason, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      randomUUID(),
      input.projectId,
      input.rootTaskId,
      input.planningRunId,
      input.triggerKind,
      input.taskRevision,
      input.eventKey,
      input.requestDigest,
      input.status,
      input.reason,
    ],
  );
}

async function nextRunChildVersionWithClient(
  client: PoolClient,
  table: "planning_artifacts" | "planning_quality_metrics",
  runId: string,
): Promise<number> {
  const result = await client.query<{ version: number }>(
    `SELECT (COALESCE(MAX(version), 0) + 1)::integer AS version
     FROM ${table}
     WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0]?.version ?? 1;
}

function planningRunFromRow(row: PlanningRunRow): PlanningRun {
  return planningRunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    rootTaskId: row.root_task_id,
    status: row.status,
    revision: row.revision,
    triggerKind: row.trigger_kind,
    rootTaskRevision: row.root_task_revision,
    policyRevision: row.policy_revision,
    sourceRunId: row.source_run_id,
    workflowPlanId: row.workflow_plan_id,
    triggerCount: row.trigger_count,
    createdByPrincipalId: row.created_by_principal_id,
    blockedReason: row.blocked_reason,
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    pausedAt: row.paused_at?.toISOString() ?? null,
    terminalAt: row.terminal_at?.toISOString() ?? null,
  });
}

function planningReceiptFromRow(
  row: PlanningTriggerReceiptRow,
): PlanningTriggerReceipt {
  return planningTriggerReceiptSchema.parse({
    id: row.id,
    projectId: row.project_id,
    rootTaskId: row.root_task_id,
    planningRunId: row.planning_run_id,
    triggerKind: row.trigger_kind,
    rootTaskRevision: row.root_task_revision,
    eventKey: row.event_key,
    requestDigest: row.request_digest,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  });
}

function planningArtifactFromRow(row: PlanningArtifactRow): PlanningArtifact {
  return planningArtifactSchema.parse({
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    version: row.version,
    contentDigest: row.content_digest,
    payload: planningArtifactPayloadSchema(row.kind).parse(row.payload),
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  });
}

function planningEventFromRow(row: PlanningEventRow): PlanningEvent {
  return planningEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    kind: row.kind,
    eventKey: row.event_key,
    actorPrincipalId: row.actor_principal_id,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  });
}

function planningQualityMetricFromRow(
  row: PlanningQualityMetricRow,
): PlanningQualityMetric {
  return planningQualityMetricSchema.parse({
    id: row.id,
    runId: row.run_id,
    version: row.version,
    criticScore:
      row.critic_score === null ? null : Number(row.critic_score),
    validatorErrorCount: row.validator_error_count,
    acceptanceCoverage:
      row.acceptance_coverage === null
        ? null
        : Number(row.acceptance_coverage),
    nodeCount: row.node_count,
    depth: row.depth,
    humanReviewRequired: row.human_review_required,
    autoApproveEligible: row.auto_approve_eligible,
    recordedByPrincipalId: row.recorded_by_principal_id,
    recordedAt: row.recorded_at.toISOString(),
  });
}

function planningPolicyFromRow(row: PlanningPolicyRow): PlanningPolicy {
  return planningPolicySchema.parse({
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    revision: row.revision,
    config: planningPolicyConfigSchema.parse(row.config),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}

function planningFlagFromRow(
  row: PlanningFeatureFlagRow,
): PlanningFeatureFlag {
  return planningFeatureFlagSchema.parse({
    flagKey: row.flag_key,
    enabled: row.mode === "on" || row.mode === "enforce",
    mode: row.mode,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}

function planningSettingsFromRows(
  projectId: string,
  policy: PlanningPolicyRow,
  manual: PlanningFeatureFlagRow,
  autopilot: PlanningFeatureFlagRow,
): PlanningSettings {
  return {
    projectId,
    policy: planningPolicyFromRow(policy),
    manual: planningFlagFromRow(manual),
    autopilot: planningFlagFromRow(autopilot),
  };
}

function planningDetailFromRows(
  run: PlanningRun,
  receipts: PlanningTriggerReceipt[],
  artifacts: PlanningArtifact[],
  events: PlanningEvent[],
  qualityMetrics: PlanningQualityMetric[],
): PlanningRunDetail {
  return { run, receipts, artifacts, events, qualityMetrics };
}

function stableDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPlanningValue(value)))
    .digest("hex");
}

function planningTriggerEventKey(input: {
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly rootTaskRevision: number;
  readonly triggerKind: PlanningTriggerKind;
  readonly actorPrincipalId: string;
  readonly sourceRunId?: string | null;
  readonly runRevision?: number | null;
}): string {
  return stableDigest([
    input.projectId,
    input.rootTaskId,
    input.rootTaskRevision,
    input.triggerKind,
    input.actorPrincipalId,
    input.sourceRunId ?? null,
    input.runRevision ?? null,
  ]);
}

function canonicalPlanningValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalPlanningValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalPlanningValue(item)]),
    );
  }
  return value;
}
