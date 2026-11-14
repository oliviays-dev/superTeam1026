import { createHash, randomUUID } from "node:crypto";
import type {
  PlanMaterialization,
  RouterAgent,
  RouterFeatureGate,
  WorkflowGraph,
  WorkflowPlan,
  WorkflowPlanAuditEvent,
  WorkflowPlanDetail,
  WorkflowPlanSettings,
  WorkflowPlanSource,
  WorkflowPlanStatus,
  WorkflowPlanVersion,
  TeammateTemplate,
} from "@pluginmax/contracts";
import {
  planCreationKey,
  planMaterializationSchema,
  ROUTER_TOOL_CONTRACT,
  routerAgentSchema,
  routerFeatureGateSchema,
  ROUTER_WORKER_FLAG,
  teammateDefinitionSchema,
  teammateTemplateSchema,
  workflowPlanAuditEventSchema,
  workflowPlanSchema,
  workflowPlanSettingsSchema,
  workflowPlanVersionSchema,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface WorkflowPlanRow {
  id: string;
  project_id: string;
  root_task_id: string;
  source: WorkflowPlanSource;
  current_version: number;
  status: WorkflowPlanStatus;
  revision: number;
  confirmed_by_principal_id: string | null;
  confirmed_by_role: string | null;
  confirmed_at: Date | null;
  router_agent_id: string | null;
  workflow_definition_id: string | null;
  workflow_instance_id: string | null;
  gate_epoch: number | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowPlanVersionRow {
  id: string;
  plan_id: string;
  version: number;
  graph: WorkflowGraph;
  settings: WorkflowPlanSettings;
  source: WorkflowPlanSource;
  reason: string;
  router_agent_id: string | null;
  router_project_id: string | null;
  router_teammate_id: string | null;
  router_agent_agent_id: string | null;
  router_agent_name: string | null;
  router_ai_principal_id: string | null;
  router_template_id: string | null;
  router_template_version_id: string | null;
  router_template_version: number | null;
  router_contract_tools: string[] | null;
  router_contract_digest: string | null;
  content_digest: string;
  created_by: string;
  created_at: Date;
}

interface PlanMaterializationRow {
  id: string;
  plan_id: string;
  plan_version: number;
  node_id: string;
  creation_key: string;
  status: PlanMaterialization["status"];
  task_id: string | null;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowPlanAuditRow {
  id: string;
  plan_id: string;
  seq: string;
  kind: WorkflowPlanAuditEvent["kind"];
  actor_id: string;
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

interface RouterAgentRow {
  id: string;
  project_id: string;
  teammate_id: string;
  agent_id: string;
  ai_principal_id: string;
  template_id: string;
  template_version_id: string;
  template_version: number;
  contract_tools: string[];
  contract_digest: string;
  status: RouterAgent["status"];
  agent_name: string;
  created_at: Date;
  updated_at: Date;
}

interface RouterAgentCandidateRow extends RouterAgentRow {
  teammate_status: string;
  agent_status: string;
  template_status: string;
  template_protected: boolean;
  template_version_definition: unknown;
}

interface RouterFeatureGateRow {
  flag_key: string;
  scope_type: "platform" | "project";
  scope_id: string;
  enabled: boolean;
  epoch: number;
  revision: number;
  updated_by: string;
  updated_at: Date;
}

export interface PlanOutboxMessageRow {
  message_id: string;
  plan_id: string;
  plan_version: number;
  node_id: string | null;
  kind: "materialize_node" | "dispatch_node" | "final_draft";
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "processed" | "failed" | "cancelled";
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
}

interface TeammateTemplateRow {
  id: string;
  project_id: string;
  workspace_id: string;
  scope: TeammateTemplate["scope"];
  owner_principal_id: string | null;
  status: TeammateTemplate["status"];
  protected: boolean;
  current_version: number;
  definition: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface RouterAgentSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly teammateId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly aiPrincipalId: string;
  readonly templateId: string;
  readonly templateVersionId: string;
  readonly templateVersion: number;
  readonly contractTools: readonly string[];
  readonly contractDigest: string;
}

export interface CreateWorkflowPlanRecordInput {
  readonly planId: string;
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly source: WorkflowPlanSource;
  readonly graph: WorkflowGraph;
  readonly settings: WorkflowPlanSettings;
  readonly reason: string;
  readonly actorId: string;
  readonly routerAgent: RouterAgentSnapshot | null;
}

export interface CreateWorkflowPlanVersionRecordInput {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly graph: WorkflowGraph;
  readonly settings: WorkflowPlanSettings;
  readonly reason: string;
  readonly actorId: string;
  readonly routerAgent: RouterAgentSnapshot | null;
}

export class WorkflowPlanRepositoryError extends Error {
  constructor(
    readonly code:
      | "workflow_plan_not_found"
      | "workflow_plan_revision_conflict"
      | "workflow_plan_state_conflict"
      | "workflow_plan_gate_disabled"
      | "workflow_plan_gate_epoch_conflict"
      | "router_agent_template_not_protected"
      | "router_agent_contract_missing"
      | "router_agent_not_teammate"
      | "router_agent_inactive",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowPlanRepositoryError";
  }
}

export class WorkflowPlanRepository {
  constructor(private readonly database: Database) {}

  async getRouterGate(projectId: string): Promise<RouterFeatureGate> {
    await this.database.query(
      `INSERT INTO workflow_feature_gate_epochs (
         flag_key, scope_type, scope_id, enabled, epoch, revision,
         updated_by, updated_at
       ) VALUES ($1, 'project', $2, FALSE, 1, 1, 'system:migration', NOW())
       ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING`,
      [ROUTER_WORKER_FLAG, projectId],
    );
    const result = await this.database.query<RouterFeatureGateRow>(
      `SELECT *
       FROM workflow_feature_gate_epochs
       WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2`,
      [ROUTER_WORKER_FLAG, projectId],
    );
    return gateFromRow(result.rows[0]!);
  }

  async setRouterGate(input: {
    readonly projectId: string;
    readonly enabled: boolean;
    readonly expectedEpoch: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<RouterFeatureGate> {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO workflow_feature_gate_epochs (
           flag_key, scope_type, scope_id, enabled, epoch, revision,
           updated_by, updated_at
         ) VALUES ($1, 'project', $2, FALSE, 1, 1, $3, NOW())
         ON CONFLICT (flag_key, scope_type, scope_id) DO NOTHING`,
        [ROUTER_WORKER_FLAG, input.projectId, input.actorId],
      );
      const current = await client.query<RouterFeatureGateRow>(
        `SELECT *
         FROM workflow_feature_gate_epochs
         WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2
         FOR UPDATE`,
        [ROUTER_WORKER_FLAG, input.projectId],
      );
      const row = current.rows[0]!;
      if (row.epoch !== input.expectedEpoch) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_gate_epoch_conflict",
          "Router Feature Gate epoch changed",
        );
      }
      const updated = await client.query<RouterFeatureGateRow>(
        `UPDATE workflow_feature_gate_epochs
         SET enabled = $3,
             epoch = epoch + 1,
             revision = revision + 1,
             updated_by = $4,
             updated_at = NOW()
         WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2
         RETURNING *`,
        [
          ROUTER_WORKER_FLAG,
          input.projectId,
          input.enabled,
          input.actorId,
        ],
      );
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
        [
          ROUTER_WORKER_FLAG,
          input.projectId,
          input.enabled ? "on" : "off",
          input.actorId,
        ],
      );
      if (!input.enabled) {
        const plans = await client.query<{ id: string }>(
          `SELECT id
           FROM workflow_plans
           WHERE project_id = $1
             AND status IN ('approved', 'active', 'finalizing')
           FOR UPDATE`,
          [input.projectId],
        );
        for (const plan of plans.rows) {
          await client.query(
            `UPDATE workflow_plans
             SET status = 'resume_required',
                 revision = revision + 1,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [plan.id],
          );
          await client.query(
            `UPDATE workflow_plan_outbox_messages
             SET status = 'cancelled',
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error = $2,
                 updated_at = NOW()
             WHERE plan_id = $1
               AND status IN ('pending', 'processing')`,
            [plan.id, input.reason],
          );
          await appendPlanAuditWithClient(client, {
            planId: plan.id,
            kind: "plan.resume_required",
            actorId: input.actorId,
            summary: "Router Feature Gate 已关闭，计划进入安全停点",
            data: {
              reason: input.reason,
              epoch: updated.rows[0]!.epoch,
            },
          });
        }
      }
      return gateFromRow(updated.rows[0]!);
    });
  }

  async listRouterAgents(projectId: string): Promise<RouterAgent[]> {
    const result = await this.database.query<RouterAgentRow>(
      `SELECT
         router_agent.*,
         agent.name AS agent_name
       FROM router_agents AS router_agent
       JOIN agents AS agent ON agent.id = router_agent.agent_id
       WHERE router_agent.project_id = $1
       ORDER BY router_agent.status, router_agent.updated_at DESC`,
      [projectId],
    );
    return result.rows.map(routerAgentFromRow);
  }

  async getRouterAgent(
    id: string,
    projectId?: string,
  ): Promise<RouterAgent | undefined> {
    const result = await this.database.query<RouterAgentRow>(
      `SELECT
         router_agent.*,
         agent.name AS agent_name
       FROM router_agents AS router_agent
       JOIN agents AS agent ON agent.id = router_agent.agent_id
       WHERE router_agent.id = $1
         AND ($2::uuid IS NULL OR router_agent.project_id = $2)`,
      [id, projectId ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : routerAgentFromRow(row);
  }

  async registerRouterAgent(input: {
    readonly projectId: string;
    readonly teammateId: string;
    readonly actorId: string;
  }): Promise<RouterAgent> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<RouterAgentCandidateRow>(
        `SELECT
           teammate.project_id,
           teammate.id AS teammate_id,
           teammate.agent_id,
           teammate.ai_principal_id,
           teammate.template_id,
           teammate.template_version_id,
           teammate.template_version,
           teammate.status AS teammate_status,
           agent.name AS agent_name,
           agent.status AS agent_status,
           template.status AS template_status,
           template.protected AS template_protected,
           version.definition AS template_version_definition
         FROM teammates AS teammate
         JOIN agents AS agent ON agent.id = teammate.agent_id
         JOIN teammate_templates AS template
           ON template.id = teammate.template_id
         JOIN teammate_template_versions AS version
           ON version.id = teammate.template_version_id
         WHERE teammate.id = $1
         FOR UPDATE OF teammate, template`,
        [input.teammateId],
      );
      const row = candidate.rows[0];
      if (row === undefined) {
        throw new WorkflowPlanRepositoryError(
          "router_agent_not_teammate",
          "Only an AI Teammate can be selected as Router Agent",
        );
      }
      if (row.project_id !== input.projectId) {
        throw new WorkflowPlanRepositoryError(
          "router_agent_inactive",
          "The Router Agent belongs to another project",
        );
      }
      if (
        row.teammate_status !== "active" ||
        row.agent_status !== "active" ||
        row.template_status !== "active"
      ) {
        throw new WorkflowPlanRepositoryError(
          "router_agent_inactive",
          "The Router Agent, Agent, and template must be active",
        );
      }
      if (!row.template_protected) {
        throw new WorkflowPlanRepositoryError(
          "router_agent_template_not_protected",
          "Router Agent selection requires a protected Teammate Template",
        );
      }
      const definition = teammateDefinitionSchema.parse(
        row.template_version_definition,
      );
      const tools = [...ROUTER_TOOL_CONTRACT];
      if (!tools.every((tool) => definition.tools.includes(tool))) {
        throw new WorkflowPlanRepositoryError(
          "router_agent_contract_missing",
          "The protected template must declare the Router Tool Contract",
        );
      }
      const contractDigest = digestValue(tools);
      const result = await client.query<RouterAgentRow>(
        `INSERT INTO router_agents (
           id, project_id, teammate_id, agent_id, ai_principal_id,
           template_id, template_version_id, template_version,
           contract_tools, contract_digest, status, created_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'active',
           $11, NOW(), NOW()
         )
         ON CONFLICT (teammate_id) DO UPDATE SET
           status = 'active',
           template_version_id = EXCLUDED.template_version_id,
           template_version = EXCLUDED.template_version,
           contract_tools = EXCLUDED.contract_tools,
           contract_digest = EXCLUDED.contract_digest,
           updated_at = NOW()
         RETURNING *,
           $12::text AS agent_name`,
        [
          randomUUID(),
          input.projectId,
          row.teammate_id,
          row.agent_id,
          row.ai_principal_id,
          row.template_id,
          row.template_version_id,
          row.template_version,
          JSON.stringify(tools),
          contractDigest,
          input.actorId,
          row.agent_name,
        ],
      );
      return routerAgentFromRow(result.rows[0]!);
    });
  }

  async provisionProtectedRouterTemplate(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly name: string;
  }): Promise<TeammateTemplate> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<TeammateTemplateRow>(
        `SELECT *
         FROM teammate_templates
         WHERE project_id = $1
           AND protected = TRUE
           AND status <> 'archived'
           AND lower(definition ->> 'name') = lower($2)
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE`,
        [input.projectId, input.name],
      );
      if (existing.rows[0] !== undefined) {
        return templateFromRow(existing.rows[0]);
      }
      const definition = teammateDefinitionSchema.parse({
        name: input.name,
        role: "Router Agent",
        description: "Protected dynamic plan Router Agent template",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [...ROUTER_TOOL_CONTRACT],
      });
      const templateId = randomUUID();
      const versionId = randomUUID();
      const inserted = await client.query<TeammateTemplateRow>(
        `INSERT INTO teammate_templates (
           id, project_id, workspace_id, scope, owner_principal_id, status,
           protected, current_version, definition, created_by,
           created_at, updated_at
         ) VALUES (
           $1, $2, $5, 'personal', $3, 'active', TRUE, 1, $4::jsonb,
           $3, NOW(), NOW()
         )
         RETURNING *`,
        [
          templateId,
          input.projectId,
          input.actorId,
          JSON.stringify(definition),
          input.projectId,
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
          digestValue(definition),
          input.actorId,
        ],
      );
      return templateFromRow(inserted.rows[0]!);
    });
  }

  async createPlan(
    input: CreateWorkflowPlanRecordInput,
  ): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      const root = await client.query<{
        project_id: string;
      }>(
        `SELECT project_id
         FROM tasks
         WHERE id = $1
         FOR UPDATE`,
        [input.rootTaskId],
      );
      if (
        root.rows[0] === undefined ||
        root.rows[0].project_id !== input.projectId
      ) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Root Task does not belong to the plan project",
        );
      }
      const definitionId = randomUUID();
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO workflow_plans (
           id, project_id, root_task_id, source, current_version, status,
           revision, router_agent_id, created_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 1, 'proposed', 1, $5, $6, NOW(), NOW()
         )`,
        [
          input.planId,
          input.projectId,
          input.rootTaskId,
          input.source,
          input.routerAgent?.id ?? null,
          input.actorId,
        ],
      );
      await insertPlanDefinitionWithClient(client, {
        definitionId,
        planId: input.planId,
        projectId: input.projectId,
        version: 1,
        source: input.source,
        graph: input.graph,
      });
      await client.query(
        `UPDATE workflow_plans
         SET workflow_definition_id = $2
         WHERE id = $1`,
        [input.planId, definitionId],
      );
      await insertPlanVersionWithClient(client, {
        versionId,
        planId: input.planId,
        version: 1,
        source: input.source,
        graph: input.graph,
        settings: input.settings,
        reason: input.reason,
        actorId: input.actorId,
        routerAgent: input.routerAgent,
      });
      await client.query(
        `INSERT INTO task_origins (
           task_id, source_kind, source_id, parent_task_id, root_task_id,
           created_by_principal_id, idempotency_key, metadata, created_at
         ) VALUES (
           $1, 'manual', $2, NULL, $1, $3, $4, $5::jsonb, NOW()
         )
         ON CONFLICT (task_id) DO NOTHING`,
        [
          input.rootTaskId,
          input.rootTaskId,
          input.actorId,
          `root-task:${input.rootTaskId}`,
          JSON.stringify({ projectId: input.projectId }),
        ],
      );
      await appendPlanAuditWithClient(client, {
        planId: input.planId,
        kind: "plan.created",
        actorId: input.actorId,
        summary: `创建${sourceLabel(input.source)}计划`,
        data: {
          source: input.source,
          version: 1,
          routerAgentId: input.routerAgent?.id ?? null,
        },
      });
    });
    return this.getPlanDetail(input.planId);
  }

  async addPlanVersion(
    input: CreateWorkflowPlanVersionRecordInput,
  ): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (plan.revision !== input.expectedRevision) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_revision_conflict",
          "Workflow plan revision changed",
        );
      }
      if (!["draft", "proposed"].includes(plan.status)) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_state_conflict",
          "Only draft or proposed plans can add an immutable version",
        );
      }
      const version = plan.current_version + 1;
      const definitionId = randomUUID();
      await insertPlanDefinitionWithClient(client, {
        definitionId,
        planId: plan.id,
        projectId: plan.project_id,
        version,
        source: plan.source,
        graph: input.graph,
      });
      await insertPlanVersionWithClient(client, {
        versionId: randomUUID(),
        planId: plan.id,
        version,
        source: plan.source,
        graph: input.graph,
        settings: input.settings,
        reason: input.reason,
        actorId: input.actorId,
        routerAgent: input.routerAgent,
      });
      await client.query(
        `UPDATE workflow_plans
         SET current_version = $2,
             workflow_definition_id = $3,
             revision = revision + 1,
             status = 'proposed',
             updated_at = NOW()
         WHERE id = $1`,
        [plan.id, version, definitionId],
      );
      await appendPlanAuditWithClient(client, {
        planId: plan.id,
        kind: "plan.updated",
        actorId: input.actorId,
        summary: `计划更新到版本 ${version}`,
        data: {
          version,
          reason: input.reason,
          routerAgentId: input.routerAgent?.id ?? null,
        },
      });
    });
    return this.getPlanDetail(input.planId);
  }

  async approvePlan(input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly role: string | null;
  }): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (
        ["approved", "active", "finalizing", "completed"].includes(
          plan.status,
        )
      ) {
        if (plan.workflow_definition_id === null) {
          throw new WorkflowPlanRepositoryError(
            "workflow_plan_state_conflict",
            "Approved plan has no workflow definition",
          );
        }
        await ensurePlanInstanceWithClient(client, plan);
        return;
      }
      if (plan.revision !== input.expectedRevision) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_revision_conflict",
          "Workflow plan revision changed",
        );
      }
      if (!["draft", "proposed"].includes(plan.status)) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_state_conflict",
          "Workflow plan cannot be approved from its current status",
        );
      }
      const updated = await client.query<WorkflowPlanRow>(
        `UPDATE workflow_plans
         SET status = 'approved',
             confirmed_by_principal_id = $2,
             confirmed_by_role = $3,
             confirmed_at = NOW(),
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [plan.id, input.actorId, input.role],
      );
      const approved = updated.rows[0]!;
      await ensurePlanInstanceWithClient(client, approved);
      await appendPlanAuditWithClient(client, {
        planId: plan.id,
        kind: "plan.approved",
        actorId: input.actorId,
        summary: `计划版本 ${plan.current_version} 已确认`,
        data: {
          version: plan.current_version,
          role: input.role,
        },
      });
    });
    return this.getPlanDetail(input.planId);
  }

  async materializePlan(input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedGateEpoch: number;
    readonly actorId: string;
  }): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `plan-materialize:${input.planId}`,
      ]);
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (plan.status === "completed") return;
      if (plan.status === "resume_required") {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_gate_disabled",
          "Workflow plan is at a safe stop; explicit resume is required",
        );
      }
      if (plan.revision !== input.expectedRevision) {
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM plan_materializations WHERE plan_id = $1
           ) AS exists`,
          [plan.id],
        );
        if (plan.status === "active" && existing.rows[0]?.exists === true) {
          return;
        }
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_revision_conflict",
          "Workflow plan revision changed",
        );
      }
      if (!["approved", "active", "finalizing"].includes(plan.status)) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_state_conflict",
          "Workflow plan must be approved before materialization",
        );
      }
      await assertRouterGateWithClient(
        client,
        plan,
        input.expectedGateEpoch,
      );
      const activated = await client.query<WorkflowPlanRow>(
        `UPDATE workflow_plans
         SET status = 'active',
             gate_epoch = $2,
             lease_owner = NULL,
             lease_expires_at = NULL,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [plan.id, input.expectedGateEpoch],
      );
      await materializePlanWithClient(
        client,
        activated.rows[0]!,
        input.actorId,
      );
    });
    return this.getPlanDetail(input.planId);
  }

  async reconcilePlan(input: {
    readonly planId: string;
    readonly actorId: string;
  }): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `plan-materialize:${input.planId}`,
      ]);
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (plan.status === "resume_required") return;
      if (!["approved", "active", "finalizing"].includes(plan.status)) return;
      const gate = await readRouterGateWithClient(client, plan.project_id);
      if (!gate.enabled) {
        await transitionPlanToSafeStopWithClient(
          client,
          plan,
          "gate-disabled-during-reconcile",
        );
        return;
      }
      const active =
        plan.status === "approved"
          ? (
              await client.query<WorkflowPlanRow>(
                `UPDATE workflow_plans
                 SET status = 'active',
                     gate_epoch = $2,
                     lease_owner = NULL,
                     lease_expires_at = NULL,
                     revision = revision + 1,
                     updated_at = NOW()
                 WHERE id = $1
                 RETURNING *`,
                [plan.id, gate.epoch],
              )
            ).rows[0]!
          : plan;
      await materializePlanWithClient(client, active, input.actorId);
    });
    return this.getPlanDetail(input.planId);
  }

  async resumePlan(input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedGateEpoch: number;
    readonly actorId: string;
  }): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (plan.revision !== input.expectedRevision) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_revision_conflict",
          "Workflow plan revision changed",
        );
      }
      if (plan.status !== "resume_required") {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_state_conflict",
          "Only a plan at a safe stop can be resumed",
        );
      }
      await assertRouterGateWithClient(
        client,
        plan,
        input.expectedGateEpoch,
      );
      await client.query(
        `UPDATE workflow_plans
         SET status = 'approved',
             gate_epoch = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [plan.id, input.expectedGateEpoch],
      );
      await appendPlanAuditWithClient(client, {
        planId: plan.id,
        kind: "plan.reconciled",
        actorId: input.actorId,
        summary: "用户显式恢复 Router 计划",
        data: { epoch: input.expectedGateEpoch },
      });
    });
    return this.getPlanDetail(input.planId);
  }

  async finalizePlan(input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedGateEpoch: number;
    readonly actorId: string;
  }): Promise<WorkflowPlanDetail> {
    await this.database.transaction(async (client) => {
      const current = await client.query<WorkflowPlanRow>(
        "SELECT * FROM workflow_plans WHERE id = $1 FOR UPDATE",
        [input.planId],
      );
      const plan = current.rows[0];
      if (plan === undefined) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_not_found",
          "Workflow plan not found",
        );
      }
      if (plan.status === "completed") return;
      if (plan.revision !== input.expectedRevision) {
        throw new WorkflowPlanRepositoryError(
          "workflow_plan_revision_conflict",
          "Workflow plan revision changed",
        );
      }
      await assertRouterGateWithClient(
        client,
        plan,
        input.expectedGateEpoch,
      );
      const tasks = await client.query<{
        task_id: string;
        status: string;
      }>(
        `SELECT materialization.task_id, task.status
         FROM plan_materializations AS materialization
         JOIN tasks AS task ON task.id = materialization.task_id
         WHERE materialization.plan_id = $1
           AND materialization.plan_version = $2`,
        [plan.id, plan.current_version],
      );
      const complete =
        tasks.rows.length > 0 &&
        tasks.rows.every((task) => task.status === "done");
      if (!complete) {
        if (plan.status !== "finalizing") {
          await client.query(
            `UPDATE workflow_plans
             SET status = 'finalizing',
                 revision = revision + 1,
                 updated_at = NOW()
             WHERE id = $1`,
            [plan.id],
          );
        }
        return;
      }
      await client.query(
        `UPDATE workflow_plans
         SET status = 'completed',
             revision = revision + 1,
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [plan.id],
      );
      await client.query(
        `INSERT INTO workflow_plan_outbox_messages (
           message_id, plan_id, plan_version, kind, payload, status,
           attempts, created_at, updated_at
         ) VALUES ($1, $2, $3, 'final_draft', $4::jsonb, 'pending', 0,
           NOW(), NOW())
         ON CONFLICT (message_id) DO NOTHING`,
        [
          `plan-final-draft:${plan.id}:v${plan.current_version}`,
          plan.id,
          plan.current_version,
          JSON.stringify({ rootTaskId: plan.root_task_id }),
        ],
      );
      await appendPlanAuditWithClient(client, {
        planId: plan.id,
        kind: "plan.finalized",
        actorId: input.actorId,
        summary: "计划全部节点任务已完成",
        data: {
          version: plan.current_version,
          nodeCount: tasks.rows.length,
        },
      });
    });
    return this.getPlanDetail(input.planId);
  }

  async claimReconcileCandidates(input: {
    readonly owner: string;
    readonly leaseSeconds: number;
    readonly staleAfterSeconds: number;
    readonly limit: number;
  }): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `WITH candidate AS (
         SELECT id
         FROM workflow_plans
         WHERE status IN ('approved', 'active', 'finalizing')
           AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
           AND updated_at <= NOW() - ($3 || ' seconds')::interval
         ORDER BY updated_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE workflow_plans AS plan
       SET lease_owner = $1,
           lease_expires_at = NOW() + ($2 || ' seconds')::interval
       FROM candidate
       WHERE plan.id = candidate.id
       RETURNING plan.id`,
      [input.owner, input.leaseSeconds, input.staleAfterSeconds, input.limit],
    );
    return result.rows.map((row) => row.id);
  }

  async releaseReconcileLease(planId: string, owner: string): Promise<void> {
    await this.database.query(
      `UPDATE workflow_plans
       SET lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2`,
      [planId, owner],
    );
  }

  async claimDispatchMessages(input: {
    readonly planId: string;
    readonly owner: string;
    readonly leaseSeconds: number;
    readonly limit: number;
  }): Promise<PlanOutboxMessageRow[]> {
    const result = await this.database.query<PlanOutboxMessageRow>(
      `WITH candidate AS (
         SELECT message_id
         FROM workflow_plan_outbox_messages
         WHERE plan_id = $1
           AND kind = 'dispatch_node'
           AND (
             status = 'pending'
             OR (status = 'processing' AND lease_expires_at <= NOW())
           )
         ORDER BY created_at, message_id
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE workflow_plan_outbox_messages AS message
       SET status = 'processing',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + ($3 || ' seconds')::interval,
           updated_at = NOW()
       FROM candidate
       WHERE message.message_id = candidate.message_id
       RETURNING message.*`,
      [input.planId, input.owner, input.leaseSeconds, input.limit],
    );
    return result.rows;
  }

  async completeDispatchMessage(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly runId?: string;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workflow_plan_outbox_messages
       SET status = 'processed',
           lease_owner = NULL,
           lease_expires_at = NULL,
           payload = payload || $3::jsonb,
           processed_at = NOW(),
           updated_at = NOW()
       WHERE message_id = $1
         AND lease_owner = $2
         AND status = 'processing'`,
      [
        input.messageId,
        input.owner,
        JSON.stringify(
          input.runId === undefined ? {} : { runId: input.runId },
        ),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async failDispatchMessage(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly error: string;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workflow_plan_outbox_messages
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $3,
           updated_at = NOW()
       WHERE message_id = $1
         AND lease_owner = $2
         AND status = 'processing'`,
      [input.messageId, input.owner, input.error.slice(0, 4_000)],
    );
  }

  async deferDispatchMessage(input: {
    readonly messageId: string;
    readonly owner: string;
    readonly reason: string;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workflow_plan_outbox_messages
       SET status = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $3,
           updated_at = NOW()
       WHERE message_id = $1
         AND lease_owner = $2
         AND status = 'processing'`,
      [input.messageId, input.owner, input.reason.slice(0, 4_000)],
    );
  }

  async getPlan(id: string): Promise<WorkflowPlan | undefined> {
    const result = await this.database.query<WorkflowPlanRow>(
      "SELECT * FROM workflow_plans WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : planFromRow(row);
  }

  async getPlanDetail(id: string): Promise<WorkflowPlanDetail> {
    const plan = await this.getPlan(id);
    if (plan === undefined) {
      throw new WorkflowPlanRepositoryError(
        "workflow_plan_not_found",
        "Workflow plan not found",
      );
    }
    const [versions, materializations, audit] = await Promise.all([
      this.listPlanVersions(id),
      this.listMaterializations(id),
      this.listPlanAudit(id),
    ]);
    const version = versions.find(
      (candidate) => candidate.version === plan.currentVersion,
    );
    if (version === undefined) {
      throw new WorkflowPlanRepositoryError(
        "workflow_plan_state_conflict",
        "Current workflow plan version is missing",
      );
    }
    return { plan, version, versions, materializations, audit };
  }

  async listPlans(projectId: string): Promise<WorkflowPlan[]> {
    const result = await this.database.query<WorkflowPlanRow>(
      `SELECT *
       FROM workflow_plans
       WHERE project_id = $1
       ORDER BY updated_at DESC, id`,
      [projectId],
    );
    return result.rows.map(planFromRow);
  }

  async listPlanVersions(planId: string): Promise<WorkflowPlanVersion[]> {
    const result = await this.database.query<WorkflowPlanVersionRow>(
      `SELECT *
       FROM workflow_plan_versions
       WHERE plan_id = $1
       ORDER BY version`,
      [planId],
    );
    return result.rows.map(versionFromRow);
  }

  async getPlanVersion(
    planId: string,
    version: number,
  ): Promise<WorkflowPlanVersion | undefined> {
    const result = await this.database.query<WorkflowPlanVersionRow>(
      `SELECT *
       FROM workflow_plan_versions
       WHERE plan_id = $1 AND version = $2`,
      [planId, version],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : versionFromRow(row);
  }

  async listMaterializations(
    planId: string,
  ): Promise<PlanMaterialization[]> {
    const result = await this.database.query<PlanMaterializationRow>(
      `SELECT *
       FROM plan_materializations
       WHERE plan_id = $1
       ORDER BY plan_version, node_id`,
      [planId],
    );
    return result.rows.map(materializationFromRow);
  }

  async failPendingMaterializations(input: {
    readonly planId: string;
    readonly planVersion: number;
    readonly error: string;
  }): Promise<void> {
    await this.database.query(
      `UPDATE plan_materializations
       SET status = 'failed',
           last_error = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
       WHERE plan_id = $1
         AND plan_version = $2
         AND status <> 'materialized'`,
      [input.planId, input.planVersion, input.error.slice(0, 4_000)],
    );
  }

  async listPlanAudit(planId: string): Promise<WorkflowPlanAuditEvent[]> {
    const result = await this.database.query<WorkflowPlanAuditRow>(
      `SELECT *
       FROM workflow_plan_audit_events
       WHERE plan_id = $1
       ORDER BY seq`,
      [planId],
    );
    return result.rows.map((row) =>
      workflowPlanAuditEventSchema.parse({
        id: row.id,
        planId: row.plan_id,
        seq: Number(row.seq),
        kind: row.kind,
        actorId: row.actor_id,
        summary: row.summary,
        data: row.data,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  async assertActivePlanAgents(
    _projectId: string,
    agentIds: readonly string[],
  ): Promise<void> {
    if (agentIds.length === 0) return;
    const result = await this.database.query<{ id: string }>(
      `SELECT id
       FROM agents
       WHERE id = ANY($1::uuid[])
         AND status = 'active'`,
      [[...new Set(agentIds)]],
    );
    const active = new Set(result.rows.map((row) => row.id));
    const missing = [...new Set(agentIds)].filter((id) => !active.has(id));
    if (missing.length > 0) {
      throw new WorkflowPlanRepositoryError(
        "workflow_plan_state_conflict",
        `Plan receivers are unavailable: ${missing.join(", ")}`,
      );
    }
  }
}

async function insertPlanDefinitionWithClient(
  client: PoolClient,
  input: {
    readonly definitionId: string;
    readonly planId: string;
    readonly projectId: string;
    readonly version: number;
    readonly source: WorkflowPlanSource;
    readonly graph: WorkflowGraph;
  },
): Promise<void> {
  const graph = {
    ...input.graph,
    version: input.version,
  };
  await client.query(
    `INSERT INTO workflow_definitions (
       id, project_id, name, description, steps, source_md, graph, status,
       scope, origin, published_by_principal_id, published_at, revision,
       plan_id, plan_version, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, '[]'::jsonb, '', $5::jsonb, 'active',
       'project', $6, NULL, NULL, 1, $7, $8, NOW(), NOW()
     )`,
    [
      input.definitionId,
      input.projectId,
      graph.name,
      graph.description,
      JSON.stringify(graph),
      input.source,
      input.planId,
      input.version,
    ],
  );
}

async function insertPlanVersionWithClient(
  client: PoolClient,
  input: {
    readonly versionId: string;
    readonly planId: string;
    readonly version: number;
    readonly source: WorkflowPlanSource;
    readonly graph: WorkflowGraph;
    readonly settings: WorkflowPlanSettings;
    readonly reason: string;
    readonly actorId: string;
    readonly routerAgent: RouterAgentSnapshot | null;
  },
): Promise<void> {
  const settings = workflowPlanSettingsSchema.parse(input.settings);
  const graph = {
    ...input.graph,
    version: input.version,
  };
  await client.query(
    `INSERT INTO workflow_plan_versions (
       id, plan_id, version, graph, settings, source, reason,
       router_agent_id, router_project_id, router_teammate_id,
       router_agent_agent_id, router_agent_name, router_ai_principal_id,
       router_template_id, router_template_version_id, router_template_version,
       router_contract_tools, router_contract_digest, content_digest,
       created_by, created_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18,
       $19, $20, NOW()
     )`,
    [
      input.versionId,
      input.planId,
      input.version,
      JSON.stringify(graph),
      JSON.stringify(settings),
      input.source,
      input.reason,
      input.routerAgent?.id ?? null,
      input.routerAgent?.projectId ?? null,
      input.routerAgent?.teammateId ?? null,
      input.routerAgent?.agentId ?? null,
      input.routerAgent?.agentName ?? null,
      input.routerAgent?.aiPrincipalId ?? null,
      input.routerAgent?.templateId ?? null,
      input.routerAgent?.templateVersionId ?? null,
      input.routerAgent?.templateVersion ?? null,
      input.routerAgent === null
        ? null
        : JSON.stringify(input.routerAgent.contractTools),
      input.routerAgent?.contractDigest ?? null,
      digestValue({ graph, settings }),
      input.actorId,
    ],
  );
  await client.query(
    `UPDATE workflow_definitions
     SET graph = $3::jsonb,
         description = $4,
         updated_at = NOW()
     WHERE plan_id = $1 AND plan_version = $2`,
    [
      input.planId,
      input.version,
      JSON.stringify(graph),
      graph.description,
    ],
  );
}

async function ensurePlanInstanceWithClient(
  client: PoolClient,
  plan: WorkflowPlanRow,
): Promise<string> {
  if (plan.workflow_instance_id !== null) return plan.workflow_instance_id;
  if (plan.workflow_definition_id === null) {
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_state_conflict",
      "Plan has no workflow definition",
    );
  }
  const version = await client.query<WorkflowPlanVersionRow>(
    `SELECT *
     FROM workflow_plan_versions
     WHERE plan_id = $1 AND version = $2`,
    [plan.id, plan.current_version],
  );
  const versionRow = version.rows[0];
  if (versionRow === undefined) {
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_state_conflict",
      "Plan version is missing",
    );
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM workflow_instances
     WHERE plan_id = $1 AND plan_version = $2`,
    [plan.id, plan.current_version],
  );
  let instanceId = existing.rows[0]?.id;
  if (instanceId === undefined) {
    instanceId = randomUUID();
    const now = new Date().toISOString();
    const graph = versionRow.graph;
    const startIds = planStartNodeIds(graph);
    const runtimeNodes = graph.nodes.map((node) => ({
      nodeId: node.id,
      name: node.name,
      type: node.type,
      status: startIds.has(node.id) ? "ready" : "waiting",
      visits: 0,
      attempt: 0,
      approvalPolicy: node.approvalPolicy,
      selectedEdgeId: null,
      output: null,
      error: null,
      taskId: null,
      runId: null,
      childInstanceId: null,
      startedAt: startIds.has(node.id) ? now : null,
      endedAt: null,
      timeoutAt: null,
    }));
    const runtimeEdges = graph.edges.map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      status: "pending",
      conditionResult: null,
    }));
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO workflow_instances (
         id, workflow_id, project_id, title, status, definition_key,
         definition_version, runtime_context, runtime_nodes, runtime_edges,
         definition_snapshot, revision, start_idempotency_key,
         current_step, steps, plan_id, plan_version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'active', $5, $6, $7::jsonb, $8::jsonb,
         $9::jsonb, $13::jsonb, 1, $10, 0, '[]'::jsonb, $11, $12, NOW(), NOW()
       )
       ON CONFLICT (plan_id, plan_version) WHERE plan_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        instanceId,
        plan.workflow_definition_id,
        plan.project_id,
        graph.name,
        graph.key,
        plan.current_version,
        JSON.stringify({
          planId: plan.id,
          planVersion: plan.current_version,
          planSource: plan.source,
        }),
        JSON.stringify(runtimeNodes),
        JSON.stringify(runtimeEdges),
        `plan-instance:${plan.id}:v${plan.current_version}`,
        plan.id,
        plan.current_version,
        JSON.stringify(graph),
      ],
    );
    instanceId = inserted.rows[0]?.id ?? instanceId;
  }
  await client.query(
    `UPDATE workflow_plans
     SET workflow_instance_id = $2
     WHERE id = $1`,
    [plan.id, instanceId],
  );
  return instanceId;
}

async function materializePlanWithClient(
  client: PoolClient,
  plan: WorkflowPlanRow,
  actorId: string,
): Promise<void> {
  if (plan.workflow_definition_id === null) {
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_state_conflict",
      "Plan has no workflow definition",
    );
  }
  const versionResult = await client.query<WorkflowPlanVersionRow>(
    `SELECT *
     FROM workflow_plan_versions
     WHERE plan_id = $1 AND version = $2`,
    [plan.id, plan.current_version],
  );
  const versionRow = versionResult.rows[0];
  if (versionRow === undefined) {
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_state_conflict",
      "Plan version is missing",
    );
  }
  const graph = versionRow.graph;
  for (const node of graph.nodes) {
    await client.query(
      `INSERT INTO plan_materializations (
         id, plan_id, plan_version, node_id, creation_key, status,
         revision, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'pending', 1, NOW(), NOW()
       )
       ON CONFLICT (plan_id, plan_version, node_id) DO NOTHING`,
      [
        randomUUID(),
        plan.id,
        plan.current_version,
        node.id,
        planCreationKey(plan.id, plan.current_version, node.id),
      ],
    );
  }
  const topologicalNodeIds = topologicalPlanNodeIds(graph);
  const tasksByNodeId = new Map<string, string>();
  const creator = plan.confirmed_by_principal_id ?? plan.created_by;
  for (const nodeId of topologicalNodeIds) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
    const creationKey = planCreationKey(
      plan.id,
      plan.current_version,
      node.id,
    );
    await client.query(
      `UPDATE plan_materializations
       SET status = 'materializing',
           lease_owner = $4,
           lease_expires_at = NOW() + INTERVAL '30 seconds',
           revision = revision + 1,
           updated_at = NOW()
       WHERE plan_id = $1
         AND plan_version = $2
         AND node_id = $3
         AND status <> 'materialized'`,
      [plan.id, plan.current_version, node.id, actorId],
    );
    let taskId = (
      await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE creation_key = $1",
        [creationKey],
      )
    ).rows[0]?.id;
    if (taskId === undefined) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO tasks (
           id, project_id, title, description, acceptance, status,
           agent_id, priority, auto_submit, auto_accept,
           auto_redispatch_on_return, creation_key, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, 'queued', $6, 'medium', TRUE, FALSE,
           FALSE, $7, NOW(), NOW()
         )
         ON CONFLICT (creation_key) WHERE creation_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          plan.project_id,
          `${graph.name} · ${node.name}`.slice(0, 240),
          [
            `Plan: ${plan.id}`,
            `Version: ${plan.current_version}`,
            `Node: ${node.id}`,
            node.description,
          ].join("\n"),
          JSON.stringify(node.acceptance ?? []),
          node.executor.id,
          creationKey,
        ],
      );
      taskId =
        inserted.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            "SELECT id FROM tasks WHERE creation_key = $1",
            [creationKey],
          )
        ).rows[0]?.id;
    }
    if (taskId === undefined) {
      throw new Error("plan task materialization did not produce a task");
    }
    tasksByNodeId.set(node.id, taskId);
    await client.query(
      `INSERT INTO task_origins (
         task_id, source_kind, source_id, parent_task_id, root_task_id,
         created_by_principal_id, idempotency_key, metadata, created_at
       ) VALUES (
         $1, $2, $3, $4, $4, $5, $6, $7::jsonb, NOW()
       )
       ON CONFLICT (task_id) DO NOTHING`,
      [
        taskId,
        originKind(plan.source),
        plan.id,
        plan.root_task_id,
        creator,
        creationKey,
        JSON.stringify({
          planId: plan.id,
          planVersion: plan.current_version,
          nodeId: node.id,
        }),
      ],
    );
    await client.query(
      `UPDATE plan_materializations
       SET status = 'materialized',
           task_id = $4,
           last_error = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           revision = revision + 1,
           updated_at = NOW()
       WHERE plan_id = $1
         AND plan_version = $2
         AND node_id = $3`,
      [plan.id, plan.current_version, node.id, taskId],
    );
  }
  for (const edge of graph.edges) {
    const taskId = tasksByNodeId.get(edge.to);
    const dependencyId = tasksByNodeId.get(edge.from);
    if (taskId === undefined || dependencyId === undefined) continue;
    await client.query(
      `INSERT INTO task_dependencies (
         task_id, depends_on_task_id, project_id, created_at
       ) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
      [taskId, dependencyId, plan.project_id],
    );
  }
  const instanceId = await ensurePlanInstanceWithClient(client, plan);
  await syncPlanInstanceTasksWithClient(
    client,
    instanceId,
    graph,
    tasksByNodeId,
  );
  for (const node of graph.nodes) {
    await client.query(
      `INSERT INTO workflow_plan_outbox_messages (
         message_id, plan_id, plan_version, node_id, kind, payload, status,
         attempts, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'dispatch_node',
         $5::jsonb, 'pending', 0, NOW(), NOW()
       )
       ON CONFLICT (message_id) DO UPDATE SET
         status = 'pending',
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = NULL,
         updated_at = NOW()
       WHERE workflow_plan_outbox_messages.status = 'cancelled'`,
      [
        `plan-dispatch:${plan.id}:v${plan.current_version}:${node.id}`,
        plan.id,
        plan.current_version,
        node.id,
        JSON.stringify({ taskId: tasksByNodeId.get(node.id) }),
      ],
    );
  }
  await client.query(
    `UPDATE workflow_plans
     SET lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [plan.id],
  );
  await appendPlanAuditWithClient(client, {
    planId: plan.id,
    kind: "plan.materialized",
    actorId,
    summary: `计划版本 ${plan.current_version} 节点任务已物化`,
    data: {
      version: plan.current_version,
      nodeCount: graph.nodes.length,
      materializationCount: tasksByNodeId.size,
    },
  });
}

async function syncPlanInstanceTasksWithClient(
  client: PoolClient,
  instanceId: string,
  graph: WorkflowGraph,
  tasksByNodeId: ReadonlyMap<string, string>,
): Promise<void> {
  const current = await client.query<{
    runtime_nodes: Array<Record<string, unknown>>;
  }>(
    `SELECT runtime_nodes
     FROM workflow_instances
     WHERE id = $1
     FOR UPDATE`,
    [instanceId],
  );
  const row = current.rows[0];
  if (row === undefined) return;
  const startIds = planStartNodeIds(graph);
  const now = new Date().toISOString();
  const runtimeNodes = row.runtime_nodes.map((node) => {
    const nodeId = String(node.nodeId);
    const taskId = tasksByNodeId.get(nodeId);
    if (taskId === undefined) return node;
    return {
      ...node,
      taskId,
      status:
        node.status === "running" || node.status === "completed"
          ? node.status
          : startIds.has(nodeId)
            ? "ready"
            : "waiting",
      ...(startIds.has(nodeId) && node.startedAt === null
        ? { startedAt: now }
        : {}),
    };
  });
  await client.query(
    `UPDATE workflow_instances
     SET runtime_nodes = $2::jsonb,
         status = 'active',
         revision = revision + 1,
         last_reconciled_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [instanceId, JSON.stringify(runtimeNodes)],
  );
}

async function assertRouterGateWithClient(
  client: PoolClient,
  plan: WorkflowPlanRow,
  expectedGateEpoch: number,
): Promise<void> {
  const gate = await readRouterGateWithClient(client, plan.project_id);
  if (!gate.enabled) {
    await transitionPlanToSafeStopWithClient(
      client,
      plan,
      "gate-disabled-before-side-effect",
    );
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_gate_disabled",
      "Router Feature Gate is disabled",
    );
  }
  if (gate.epoch !== expectedGateEpoch) {
    throw new WorkflowPlanRepositoryError(
      "workflow_plan_gate_epoch_conflict",
      "Router Feature Gate epoch changed before side effect",
    );
  }
}

async function readRouterGateWithClient(
  client: PoolClient,
  projectId: string,
): Promise<RouterFeatureGateRow> {
  const result = await client.query<RouterFeatureGateRow>(
    `SELECT *
     FROM workflow_feature_gate_epochs
     WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2`,
    [ROUTER_WORKER_FLAG, projectId],
  );
  if (result.rows[0] === undefined) {
    return {
      flag_key: ROUTER_WORKER_FLAG,
      scope_type: "project",
      scope_id: projectId,
      enabled: false,
      epoch: 1,
      revision: 1,
      updated_by: "system:migration",
      updated_at: new Date(),
    };
  }
  return result.rows[0];
}

async function transitionPlanToSafeStopWithClient(
  client: PoolClient,
  plan: WorkflowPlanRow,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE workflow_plans
     SET status = 'resume_required',
         revision = revision + 1,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [plan.id],
  );
  await client.query(
    `UPDATE workflow_plan_outbox_messages
     SET status = 'cancelled',
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = $2,
         updated_at = NOW()
     WHERE plan_id = $1
       AND status IN ('pending', 'processing')`,
    [plan.id, reason],
  );
  await appendPlanAuditWithClient(client, {
    planId: plan.id,
    kind: "plan.resume_required",
    actorId: "system",
    summary: "Feature Gate fencing stopped the plan before side effects",
    data: { reason },
  });
}

async function appendPlanAuditWithClient(
  client: PoolClient,
  input: {
    readonly planId: string;
    readonly kind: WorkflowPlanAuditEvent["kind"];
    readonly actorId: string;
    readonly summary: string;
    readonly data?: Record<string, unknown> | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO workflow_plan_audit_events (
       id, plan_id, seq, kind, actor_id, summary, data, created_at
     )
     SELECT
       $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, $6::jsonb, NOW()
     FROM workflow_plan_audit_events
     WHERE plan_id = $2`,
    [
      randomUUID(),
      input.planId,
      input.kind,
      input.actorId,
      input.summary,
      input.data === undefined || input.data === null
        ? null
        : JSON.stringify(input.data),
    ],
  );
}

function planFromRow(row: WorkflowPlanRow): WorkflowPlan {
  if (row.workflow_definition_id === null) {
    throw new Error("workflow plan definition id is missing");
  }
  return workflowPlanSchema.parse({
    id: row.id,
    projectId: row.project_id,
    rootTaskId: row.root_task_id,
    source: row.source,
    currentVersion: row.current_version,
    status: row.status,
    revision: row.revision,
    confirmedByPrincipalId: row.confirmed_by_principal_id,
    confirmedByRole: row.confirmed_by_role,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    routerAgentId: row.router_agent_id,
    workflowDefinitionId: row.workflow_definition_id,
    workflowInstanceId: row.workflow_instance_id,
    gateEpoch: row.gate_epoch,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function versionFromRow(row: WorkflowPlanVersionRow): WorkflowPlanVersion {
  const routerAgent =
    row.router_agent_id === null ||
    row.router_project_id === null ||
    row.router_teammate_id === null ||
    row.router_agent_agent_id === null ||
    row.router_agent_name === null ||
    row.router_ai_principal_id === null ||
    row.router_template_id === null ||
    row.router_template_version_id === null ||
    row.router_template_version === null ||
    row.router_contract_tools === null ||
    row.router_contract_digest === null
      ? null
      : routerAgentSchema.parse({
          id: row.router_agent_id,
          projectId: row.router_project_id,
          teammateId: row.router_teammate_id,
          agentId: row.router_agent_agent_id,
          agentName: row.router_agent_name,
          aiPrincipalId: row.router_ai_principal_id,
          templateId: row.router_template_id,
          templateVersionId: row.router_template_version_id,
          templateVersion: row.router_template_version,
          contract: {
            tools: row.router_contract_tools,
            digest: row.router_contract_digest,
          },
          status: "active",
          createdAt: row.created_at.toISOString(),
          updatedAt: row.created_at.toISOString(),
        });
  return workflowPlanVersionSchema.parse({
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    source: row.source,
    graph: row.graph,
    settings: row.settings,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    routerAgent,
    contentDigest: row.content_digest,
  });
}

function materializationFromRow(
  row: PlanMaterializationRow,
): PlanMaterialization {
  return planMaterializationSchema.parse({
    id: row.id,
    planId: row.plan_id,
    planVersion: row.plan_version,
    nodeId: row.node_id,
    creationKey: row.creation_key,
    status: row.status,
    taskId: row.task_id,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function routerAgentFromRow(row: RouterAgentRow): RouterAgent {
  return routerAgentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    teammateId: row.teammate_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    aiPrincipalId: row.ai_principal_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    templateVersion: row.template_version,
    contract: {
      tools: row.contract_tools,
      digest: row.contract_digest,
    },
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function gateFromRow(row: RouterFeatureGateRow): RouterFeatureGate {
  return routerFeatureGateSchema.parse({
    flagKey: row.flag_key,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    enabled: row.enabled,
    epoch: row.epoch,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}

function templateFromRow(row: TeammateTemplateRow): TeammateTemplate {
  return teammateTemplateSchema.parse({
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
    protected: row.protected,
    currentVersion: row.current_version,
    definition: teammateDefinitionSchema.parse(row.definition),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function originKind(
  source: WorkflowPlanSource,
): "manual" | "workflow" | "router" {
  if (source === "router") return "router";
  if (source === "template") return "workflow";
  return "manual";
}

function sourceLabel(source: WorkflowPlanSource): string {
  if (source === "router") return " Router 动态";
  if (source === "template") return "模板";
  return "手工";
}

function planStartNodeIds(graph: WorkflowGraph): Set<string> {
  return new Set([
    ...graph.startNodeIds,
    ...graph.nodes.filter((node) => node.start).map((node) => node.id),
  ]);
}

function topologicalPlanNodeIds(graph: WorkflowGraph): string[] {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  const result: string[] = [];
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    result.push(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      const count = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, count);
      if (count === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  return result;
}

function digestValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
