import { createHash, randomUUID } from "node:crypto";
import type {
  BusinessChainCandidate,
  BusinessChainDefinitionValue,
  BusinessChainDefinitionSnapshot,
  BusinessChainNodeMetadata,
  BindProjectBusinessChainValue,
  ProjectAlert,
  ProjectAlertDetail,
  ProjectAlertEvent,
  ProjectAlertEventKind,
  ProjectAlertLifecycle,
  ProjectAlertObservation,
  ProjectBusinessChainBinding,
  ProjectBusinessChainBindingRevision,
  ProjectBusinessChainNodeBinding,
  ProjectFeatureFlagState,
  ProjectSourceFetchResult,
  ProjectSourceSnapshot,
  ProjectTemplateBusinessChainPolicy,
} from "@pluginmax/contracts";
import {
  businessChainConditionMaterial,
  businessChainDefinitionSnapshotSchema,
  businessChainMetadataSchema,
  businessChainNodeMetadataSchema,
  emptyProjectTemplateBusinessChainPolicy,
  projectAlertEventSchema,
  projectAlertObservationSchema,
  projectAlertSchema,
  projectBusinessChainBindingRevisionSchema,
  projectBusinessChainBindingSchema,
  projectBusinessChainNodeBindingSchema,
  projectFeatureFlagStateSchema,
  projectSourceSnapshotSchema,
  projectTemplateBusinessChainPolicySchema,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface ProjectRow {
  id: string;
  status: "active" | "archived";
  source_template_id: string | null;
  source_template_revision: number | null;
}

interface ProjectTemplateRow {
  id: string;
  revision: number;
  status: "active" | "archived";
  business_chain_policy: unknown;
  snapshot: {
    businessChainPolicy?: unknown;
  } | null;
}

interface WorkflowDefinitionRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  scope: "project" | "platform";
  origin: "template" | "router" | "manual";
  kind: "workflow" | "business-chain";
  chain_key: string | null;
  business_chain_metadata: unknown;
  business_chain_nodes: unknown;
  status: "active" | "archived";
  published_at: Date | null;
  revision: number;
}

interface BusinessChainTemplateRefRow {
  workflow_definition_id: string;
  workflow_definition_version: number;
  definition_snapshot: unknown;
  required: boolean;
}

interface BindingRow {
  project_id: string;
  project_template_id: string | null;
  source_template_revision: number | null;
  workflow_definition_id: string;
  workflow_definition_version: number;
  definition_snapshot: unknown;
  chain_key: string;
  binding_mode: "template" | "manual" | "upgrade";
  node_bindings: unknown;
  binding_digest: string;
  active: boolean;
  revision: number;
  bound_by_principal_id: string;
  bound_at: Date;
  updated_at: Date;
}

interface BindingRevisionRow {
  id: string;
  project_id: string;
  revision: number;
  operation: "bind" | "upgrade" | "unbind";
  project_template_id: string | null;
  source_template_revision: number | null;
  workflow_definition_id: string | null;
  workflow_definition_version: number | null;
  definition_snapshot: unknown;
  chain_key: string | null;
  binding_mode: "template" | "manual" | "upgrade" | null;
  node_bindings: unknown;
  binding_digest: string | null;
  actor_principal_id: string;
  reason: string;
  created_at: Date;
}

interface SourceSnapshotRow {
  id: string;
  project_id: string;
  ref_key: string;
  source_kind: string;
  source_system: string;
  source_object_type: string;
  source_object_id: string;
  source_revision: string | null;
  version: number;
  status: "fresh" | "stale" | "error";
  observed_at: Date;
  effective_at: Date | null;
  fresh_until: Date | null;
  payload_digest: string | null;
  payload: unknown;
  failure_reason: string | null;
  is_mock: boolean;
  created_by_principal_id: string;
  created_at: Date;
}

interface AlertRow {
  id: string;
  project_id: string;
  condition_key: string;
  source_system: string;
  source_object_type: string;
  source_object_id: string;
  condition_code: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  lifecycle: ProjectAlertLifecycle;
  source_revision: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by_principal_id: string | null;
  suppression_until: Date | null;
  resolved_at: Date | null;
  resolved_by_principal_id: string | null;
  assignee_principal_id: string | null;
  linked_node_ids: string[];
  linked_task_ids: string[];
  follow_target_id: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface AlertEventRow {
  id: string;
  alert_id: string;
  project_id: string;
  seq: string;
  kind: ProjectAlertEventKind;
  actor_principal_id: string;
  from_lifecycle: ProjectAlertLifecycle | null;
  to_lifecycle: ProjectAlertLifecycle | null;
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

interface FeatureFlagRow {
  flag_key: string;
  scope_type: "platform" | "project";
  scope_id: string;
  mode: "off" | "observe" | "enforce" | "on";
  revision: number;
}

export interface ProjectOverviewWorkflowSummary {
  definitions: number;
  instances: number;
  activeInstances: number;
  blockedInstances: number;
  pendingApprovals: number;
  plans: number;
  planningReviewRequired: number;
  latestInstanceId: string | null;
}

export interface ProjectOverviewTaskSummary {
  total: number;
  queued: number;
  inProgress: number;
  review: number;
  blocked: number;
  done: number;
  cancelled: number;
}

export type ProjectBusinessChainRepositoryErrorCode =
  | "project_business_chain_disabled"
  | "project_business_chain_not_found"
  | "project_business_chain_archived"
  | "project_business_chain_revision_conflict"
  | "project_business_chain_candidate_forbidden"
  | "project_business_chain_definition_invalid"
  | "project_business_chain_template_forbidden"
  | "project_business_chain_binding_missing"
  | "project_feature_flag_revision_conflict"
  | "project_source_mock_disabled"
  | "project_source_ref_not_bound"
  | "project_alert_not_found"
  | "project_alert_revision_conflict"
  | "project_alert_lifecycle_conflict";

export class ProjectBusinessChainRepositoryError extends Error {
  constructor(
    readonly code: ProjectBusinessChainRepositoryErrorCode,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProjectBusinessChainRepositoryError";
  }
}

export class ProjectBusinessChainRepository {
  constructor(private readonly database: Database) {}

  async getProject(projectId: string): Promise<ProjectRow | undefined> {
    const result = await this.database.query<ProjectRow>(
      `SELECT id, status, source_template_id, source_template_revision
       FROM projects
       WHERE id = $1`,
      [projectId],
    );
    return result.rows[0];
  }

  async getFeatureFlagState(
    flagKey: string,
    projectId: string,
  ): Promise<ProjectFeatureFlagState> {
    const scopes = [
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
      if (row !== undefined) {
        return projectFeatureFlagStateSchema.parse({
          flagKey: row.flag_key,
          enabled: row.mode === "on" || row.mode === "enforce",
          revision: row.revision,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
        });
      }
    }
    return {
      flagKey,
      enabled: false,
      revision: 0,
      scopeType: "platform",
      scopeId: "platform",
    };
  }

  async setProjectFeatureFlag(input: {
    readonly flagKey: string;
    readonly projectId: string;
    readonly enabled: boolean;
    readonly expectedRevision: number;
    readonly actorId: string;
  }): Promise<ProjectFeatureFlagState> {
    return this.database.transaction(async (client) => {
      const effective = await this.featureFlagRowWithClient(
        client,
        input.flagKey,
        input.projectId,
      );
      const projectRow = await client.query<FeatureFlagRow>(
        `SELECT *
         FROM feature_flag_settings
         WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2
         FOR UPDATE`,
        [input.flagKey, input.projectId],
      );
      const effectiveRevision =
        projectRow.rows[0]?.revision ?? effective?.revision ?? 0;
      if (effectiveRevision !== input.expectedRevision) {
        throw new ProjectBusinessChainRepositoryError(
          "project_feature_flag_revision_conflict",
          "Feature Flag changed before this request completed",
          409,
          {
            flagKey: input.flagKey,
            currentRevision: effectiveRevision,
            expectedRevision: input.expectedRevision,
          },
        );
      }
      const mode = input.enabled ? "on" : "off";
      const row = projectRow.rows[0];
      const saved =
        row === undefined
          ? await client.query<FeatureFlagRow>(
              `INSERT INTO feature_flag_settings (
               flag_key, scope_type, scope_id, mode, revision, updated_by,
               updated_at
             ) VALUES ($1, 'project', $2, $3, 1, $4, NOW())
             RETURNING *`,
              [input.flagKey, input.projectId, mode, input.actorId],
            )
          : await client.query<FeatureFlagRow>(
              `UPDATE feature_flag_settings
             SET mode = $3, revision = revision + 1, updated_by = $4,
                 updated_at = NOW()
             WHERE flag_key = $1 AND scope_type = 'project' AND scope_id = $2
             RETURNING *`,
              [input.flagKey, input.projectId, mode, input.actorId],
            );
      return featureFlagFromRow(saved.rows[0]!);
    });
  }

  async getTemplatePolicy(projectId: string): Promise<{
    templateId: string;
    templateRevision: number;
    policy: ProjectTemplateBusinessChainPolicy;
  } | null> {
    const project = await this.getProject(projectId);
    if (
      project === undefined ||
      project.source_template_id === null ||
      project.source_template_revision === null
    ) {
      return null;
    }
    const result = await this.database.query<ProjectTemplateRow>(
      `SELECT
         template.id,
         revision.revision,
         template.status,
         template.business_chain_policy,
         revision.snapshot
       FROM project_templates AS template
       JOIN project_template_revisions AS revision
         ON revision.template_id = template.id
        AND revision.revision = $2
       WHERE template.id = $1`,
      [project.source_template_id, project.source_template_revision],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      templateId: row.id,
      templateRevision: row.revision,
      policy: projectTemplateBusinessChainPolicySchema.parse(
        row.snapshot?.businessChainPolicy ??
          row.business_chain_policy ??
          emptyProjectTemplateBusinessChainPolicy,
      ),
    };
  }

  async listCandidates(projectId: string): Promise<BusinessChainCandidate[]> {
    const project = await this.getProject(projectId);
    if (project === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_not_found",
        "Project not found",
        404,
      );
    }
    if (
      project.source_template_id !== null &&
      project.source_template_revision !== null
    ) {
      const policy = await this.getTemplatePolicy(projectId);
      if (policy === null || policy.policy.mode === "none") return [];
      const refs = await this.database.query<
        BusinessChainTemplateRefRow & {
          id: string;
          scope: "project" | "platform";
          origin: "template" | "router" | "manual";
        }
      >(
        `SELECT
           reference.workflow_definition_id,
           reference.workflow_definition_version,
           reference.definition_snapshot,
           reference.required,
           definition.id,
           definition.scope,
           definition.origin
         FROM project_template_business_chain_refs AS reference
         JOIN workflow_definitions AS definition
           ON definition.id = reference.workflow_definition_id
         WHERE reference.template_id = $1
           AND definition.kind = 'business-chain'
         ORDER BY reference.required DESC, reference.chain_key_snapshot`,
        [policy.templateId],
      );
      return refs.rows.map((row) => {
        const snapshot = businessChainDefinitionSnapshotSchema.parse(
          row.definition_snapshot,
        );
        return {
          workflowDefinitionId: row.workflow_definition_id,
          version: row.workflow_definition_version,
          chainKey: snapshot.metadata.chainKey,
          displayName: snapshot.metadata.displayName,
          scope: row.scope,
          origin: row.origin,
          projectTypeCodes: [...snapshot.metadata.projectTypeCodes],
          required: row.required,
          pinnedByTemplate: true,
          definitionSnapshot: snapshot,
        };
      });
    }
    const definitions = await this.database.query<WorkflowDefinitionRow>(
      `SELECT *
       FROM workflow_definitions
       WHERE project_id = $1
         AND scope = 'project'
         AND kind = 'business-chain'
         AND status = 'active'
       ORDER BY updated_at DESC`,
      [projectId],
    );
    return definitions.rows.map((row) => {
      const snapshot = definitionSnapshotFromRow(row);
      return {
        workflowDefinitionId: row.id,
        version: row.revision,
        chainKey: snapshot.metadata.chainKey,
        displayName: snapshot.metadata.displayName,
        scope: row.scope,
        origin: row.origin,
        projectTypeCodes: [...snapshot.metadata.projectTypeCodes],
        required: false,
        pinnedByTemplate: false,
        definitionSnapshot: snapshot,
      };
    });
  }

  async getActiveBinding(
    projectId: string,
  ): Promise<ProjectBusinessChainBinding | null> {
    const result = await this.database.query<BindingRow>(
      `SELECT *
       FROM project_business_chain_bindings
       WHERE project_id = $1 AND active = TRUE`,
      [projectId],
    );
    const row = result.rows[0];
    return row === undefined ? null : bindingFromRow(row);
  }

  async configureDefinition(input: {
    readonly workflowDefinitionId: string;
    readonly value: BusinessChainDefinitionValue;
  }): Promise<void> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE workflow_definitions
       SET kind = 'business-chain',
           chain_key = $2,
           business_chain_metadata = $3::jsonb,
           business_chain_nodes = $4::jsonb,
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $1
         AND revision = $5
         AND status = 'active'
       RETURNING id`,
      [
        input.workflowDefinitionId,
        input.value.chainKey,
        JSON.stringify({
          chainKey: input.value.chainKey,
          templateKey: input.value.templateKey,
          displayName: input.value.displayName,
          projectTypeCodes: input.value.projectTypeCodes,
          snapshotPolicy: input.value.snapshotPolicy,
          allowUnboundSources: input.value.allowUnboundSources,
        }),
        JSON.stringify(input.value.nodes),
        input.value.expectedRevision,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_revision_conflict",
        "Workflow definition changed before its business chain metadata was saved",
        409,
      );
    }
  }

  async getBindingState(projectId: string): Promise<{
    revision: number;
    binding: ProjectBusinessChainBinding | null;
  }> {
    const result = await this.database.query<BindingRow>(
      "SELECT * FROM project_business_chain_bindings WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return {
      revision: row?.revision ?? 0,
      binding: row?.active === true ? bindingFromRow(row) : null,
    };
  }

  async listBindingHistory(
    projectId: string,
  ): Promise<ProjectBusinessChainBindingRevision[]> {
    const result = await this.database.query<BindingRevisionRow>(
      `SELECT *
       FROM project_business_chain_binding_revisions
       WHERE project_id = $1
       ORDER BY revision DESC`,
      [projectId],
    );
    return result.rows.map(bindingRevisionFromRow);
  }

  async bind(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: BindProjectBusinessChainValue;
  }): Promise<ProjectBusinessChainBinding> {
    const candidates = await this.listCandidates(input.projectId);
    const candidate = candidates.find(
      (item) => item.workflowDefinitionId === input.value.workflowDefinitionId,
    );
    if (candidate === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_candidate_forbidden",
        "The business chain is not available for this project",
        403,
      );
    }
    const nodeBindings = normalizeNodeBindings(
      candidate.definitionSnapshot.nodes,
      input.value.nodeBindings,
      candidate.definitionSnapshot.metadata.allowUnboundSources,
    );
    const templatePolicy = await this.getTemplatePolicy(input.projectId);
    const project = await this.getProject(input.projectId);
    if (project === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_not_found",
        "Project not found",
        404,
      );
    }
    if (project.status !== "active") {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_archived",
        "Archived projects cannot change their business chain",
        409,
      );
    }
    const bindingMode = input.value.upgrade
      ? "upgrade"
      : candidate.pinnedByTemplate
        ? "template"
        : "manual";
    const digest = bindingDigest({
      workflowDefinitionId: candidate.workflowDefinitionId,
      workflowDefinitionVersion: candidate.version,
      chainKey: candidate.chainKey,
      nodeBindings,
    });
    return this.database.transaction(async (client) => {
      await client.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [
        input.projectId,
      ]);
      const currentResult = await client.query<BindingRow>(
        `SELECT *
         FROM project_business_chain_bindings
         WHERE project_id = $1
         FOR UPDATE`,
        [input.projectId],
      );
      const current = currentResult.rows[0];
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.value.expectedRevision) {
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_revision_conflict",
          "Project business chain changed before this request completed",
          409,
          {
            currentRevision,
            expectedRevision: input.value.expectedRevision,
          },
        );
      }
      if (input.value.upgrade && current?.active !== true) {
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_binding_missing",
          "A business chain must be bound before it can be upgraded",
          409,
        );
      }
      if (!input.value.upgrade && current?.active === true) {
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_definition_invalid",
          "Use the upgrade operation to replace an active binding",
          409,
        );
      }
      const nextRevision = currentRevision + 1;
      await client.query(
        `INSERT INTO project_business_chain_binding_revisions (
           id, project_id, revision, operation, project_template_id,
           source_template_revision, workflow_definition_id,
           workflow_definition_version, definition_snapshot, chain_key,
           binding_mode, node_bindings, binding_digest, actor_principal_id,
           reason, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11,
           $12::jsonb, $13, $14, $15, NOW()
         )`,
        [
          randomUUID(),
          input.projectId,
          nextRevision,
          bindingMode === "upgrade" ? "upgrade" : "bind",
          templatePolicy?.templateId ?? null,
          templatePolicy?.templateRevision ?? null,
          candidate.workflowDefinitionId,
          candidate.version,
          JSON.stringify(candidate.definitionSnapshot),
          candidate.chainKey,
          bindingMode,
          JSON.stringify(nodeBindings),
          digest,
          input.actorId,
          input.value.reason,
        ],
      );
      const saved =
        current === undefined
          ? await client.query<BindingRow>(
              `INSERT INTO project_business_chain_bindings (
               project_id, project_template_id, source_template_revision,
               workflow_definition_id, workflow_definition_version,
               definition_snapshot, chain_key, binding_mode, node_bindings,
               binding_digest, active, revision, bound_by_principal_id,
               bound_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10,
               TRUE, $11, $12, NOW(), NOW()
             )
             RETURNING *`,
              [
                input.projectId,
                templatePolicy?.templateId ?? null,
                templatePolicy?.templateRevision ?? null,
                candidate.workflowDefinitionId,
                candidate.version,
                JSON.stringify(candidate.definitionSnapshot),
                candidate.chainKey,
                bindingMode,
                JSON.stringify(nodeBindings),
                digest,
                nextRevision,
                input.actorId,
              ],
            )
          : await client.query<BindingRow>(
              `UPDATE project_business_chain_bindings
             SET project_template_id = $2,
                 source_template_revision = $3,
                 workflow_definition_id = $4,
                 workflow_definition_version = $5,
                 definition_snapshot = $6::jsonb,
                 chain_key = $7,
                 binding_mode = $8,
                 node_bindings = $9::jsonb,
                 binding_digest = $10,
                 active = TRUE,
                 revision = $11,
                 bound_by_principal_id = $12,
                 bound_at = NOW(),
                 unbound_by_principal_id = NULL,
                 unbound_at = NULL,
                 updated_at = NOW()
             WHERE project_id = $1
             RETURNING *`,
              [
                input.projectId,
                templatePolicy?.templateId ?? null,
                templatePolicy?.templateRevision ?? null,
                candidate.workflowDefinitionId,
                candidate.version,
                JSON.stringify(candidate.definitionSnapshot),
                candidate.chainKey,
                bindingMode,
                JSON.stringify(nodeBindings),
                digest,
                nextRevision,
                input.actorId,
              ],
            );
      return bindingFromRow(saved.rows[0]!);
    });
  }

  async unbind(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<number> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [
        input.projectId,
      ]);
      const currentResult = await client.query<BindingRow>(
        `SELECT *
         FROM project_business_chain_bindings
         WHERE project_id = $1
         FOR UPDATE`,
        [input.projectId],
      );
      const current = currentResult.rows[0];
      if (current === undefined || !current.active) {
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_binding_missing",
          "The project has no active business chain",
          404,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_revision_conflict",
          "Project business chain changed before this request completed",
          409,
          {
            currentRevision: current.revision,
            expectedRevision: input.expectedRevision,
          },
        );
      }
      const nextRevision = current.revision + 1;
      await client.query(
        `INSERT INTO project_business_chain_binding_revisions (
           id, project_id, revision, operation, project_template_id,
           source_template_revision, node_bindings, actor_principal_id,
           reason, created_at
         ) VALUES (
           $1, $2, $3, 'unbind', $4, $5, '[]'::jsonb, $6, $7, NOW()
         )`,
        [
          randomUUID(),
          input.projectId,
          nextRevision,
          current.project_template_id,
          current.source_template_revision,
          input.actorId,
          input.reason,
        ],
      );
      await client.query(
        `UPDATE project_business_chain_bindings
         SET project_template_id = NULL,
             source_template_revision = NULL,
             workflow_definition_id = NULL,
             workflow_definition_version = NULL,
             definition_snapshot = NULL,
             chain_key = NULL,
             binding_mode = NULL,
             node_bindings = '[]'::jsonb,
             binding_digest = NULL,
             active = FALSE,
             revision = $2,
             unbound_by_principal_id = $3,
             unbound_at = NOW(),
             updated_at = NOW()
         WHERE project_id = $1`,
        [input.projectId, nextRevision, input.actorId],
      );
      return nextRevision;
    });
  }

  async recordSourceSnapshot(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly result: ProjectSourceFetchResult;
  }): Promise<ProjectSourceSnapshot> {
    const payloadDigest =
      input.result.payload === null || input.result.status === "error"
        ? null
        : createHash("sha256")
            .update(stableJson(input.result.payload))
            .digest("hex");
    const result = await this.database.query<SourceSnapshotRow>(
      `INSERT INTO project_source_snapshots (
         id, project_id, ref_key, source_kind, source_system,
         source_object_type, source_object_id, source_revision, version,
         status, observed_at, effective_at, fresh_until, payload_digest,
         payload, failure_reason, is_mock, created_by_principal_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13,
         $14::jsonb, $15, $16, $17, NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.result.refKey,
        input.result.sourceKind,
        input.result.sourceSystem,
        input.result.objectType,
        input.result.objectId,
        input.result.sourceRevision,
        input.result.status,
        input.result.observedAt,
        input.result.effectiveAt,
        input.result.freshUntil,
        payloadDigest,
        input.result.payload === null
          ? null
          : JSON.stringify(input.result.payload),
        input.result.failureReason,
        input.result.isMock,
        input.actorId,
      ],
    );
    return sourceSnapshotFromRow(result.rows[0]!);
  }

  async listSourceSnapshots(
    projectId: string,
  ): Promise<ProjectSourceSnapshot[]> {
    const result = await this.database.query<SourceSnapshotRow>(
      `SELECT *
       FROM project_source_snapshots
       WHERE project_id = $1
       ORDER BY ref_key, version DESC`,
      [projectId],
    );
    return result.rows.map(sourceSnapshotFromRow);
  }

  async listAlerts(projectId: string): Promise<ProjectAlert[]> {
    const result = await this.database.query<AlertRow>(
      `SELECT *
       FROM project_alerts
       WHERE project_id = $1
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'warning' THEN 1
           ELSE 2
         END,
         CASE lifecycle
           WHEN 'open' THEN 0
           WHEN 'acknowledged' THEN 1
           WHEN 'suppressed' THEN 2
           ELSE 3
         END,
         updated_at DESC`,
      [projectId],
    );
    return result.rows.map(alertFromRow);
  }

  async getAlertDetail(alertId: string): Promise<ProjectAlertDetail> {
    const alertResult = await this.database.query<AlertRow>(
      "SELECT * FROM project_alerts WHERE id = $1",
      [alertId],
    );
    const row = alertResult.rows[0];
    if (row === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_alert_not_found",
        "Project alert not found",
        404,
      );
    }
    const events = await this.database.query<AlertEventRow>(
      `SELECT *
       FROM project_alert_events
       WHERE alert_id = $1
       ORDER BY seq`,
      [alertId],
    );
    return {
      alert: alertFromRow(row),
      events: events.rows.map(alertEventFromRow),
    };
  }

  async observeAlert(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly observation: ProjectAlertObservation;
  }): Promise<ProjectAlertDetail> {
    const observation = projectAlertObservationSchema.parse(input.observation);
    const conditionKey = alertConditionKey(observation);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `project-alert:${input.projectId}:${conditionKey}`,
      ]);
      const currentResult = await client.query<AlertRow>(
        `SELECT *
         FROM project_alerts
         WHERE project_id = $1 AND condition_key = $2
         FOR UPDATE`,
        [input.projectId, conditionKey],
      );
      const current = currentResult.rows[0];
      if (current === undefined) {
        const inserted = await client.query<AlertRow>(
          `INSERT INTO project_alerts (
             id, project_id, condition_key, source_system,
             source_object_type, source_object_id, condition_code, title,
             message, severity, lifecycle, source_revision, first_seen_at,
             last_seen_at, linked_node_ids, linked_task_ids, follow_target_id,
             revision, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12,
             $12, $13::jsonb, $14::jsonb, $15, 1, NOW(), NOW()
           )
           RETURNING *`,
          [
            randomUUID(),
            input.projectId,
            conditionKey,
            observation.sourceSystem,
            observation.sourceObjectType,
            observation.sourceObjectId,
            observation.conditionCode,
            observation.title,
            observation.message,
            observation.severity,
            observation.sourceRevision,
            observation.observedAt,
            JSON.stringify(observation.linkedNodeIds),
            JSON.stringify(observation.linkedTaskIds),
            observation.followTargetId,
          ],
        );
        const alert = inserted.rows[0]!;
        await appendAlertEvent(client, {
          alert,
          actorId: input.actorId,
          kind: "alert.opened",
          fromLifecycle: null,
          toLifecycle: "open",
          summary: `Alert opened: ${alert.title}`,
          data: {
            conditionCode: alert.condition_code,
            sourceRevision: alert.source_revision,
          },
        });
        return this.alertDetailWithClient(client, alert.id);
      }

      const observedAt = new Date(observation.observedAt);
      if (observedAt.getTime() < current.last_seen_at.getTime()) {
        return this.alertDetailWithClient(client, current.id);
      }
      const reopen = current.lifecycle === "resolved";
      const unsuppress =
        current.lifecycle === "suppressed" &&
        current.suppression_until !== null &&
        current.suppression_until.getTime() <= observedAt.getTime();
      const nextLifecycle: ProjectAlertLifecycle =
        reopen || unsuppress ? "open" : current.lifecycle;
      const severityChanged = current.severity !== observation.severity;
      const updated = await client.query<AlertRow>(
        `UPDATE project_alerts
         SET source_system = $2,
             source_object_type = $3,
             source_object_id = $4,
             condition_code = $5,
             title = $6,
             message = $7,
             severity = $8,
             lifecycle = $9,
             source_revision = $10,
             last_seen_at = GREATEST(last_seen_at, $11::timestamptz),
             acknowledged_at = CASE
               WHEN $9 = 'open' THEN NULL ELSE acknowledged_at
             END,
             acknowledged_by_principal_id = CASE
               WHEN $9 = 'open' THEN NULL ELSE acknowledged_by_principal_id
             END,
             suppression_until = CASE
               WHEN $9 = 'suppressed' THEN suppression_until ELSE NULL
             END,
             resolved_at = CASE
               WHEN $9 = 'open' THEN NULL ELSE resolved_at
             END,
             resolved_by_principal_id = CASE
               WHEN $9 = 'open' THEN NULL ELSE resolved_by_principal_id
             END,
             linked_node_ids = $12::jsonb,
             linked_task_ids = $13::jsonb,
             follow_target_id = $14,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          current.id,
          observation.sourceSystem,
          observation.sourceObjectType,
          observation.sourceObjectId,
          observation.conditionCode,
          observation.title,
          observation.message,
          observation.severity,
          nextLifecycle,
          observation.sourceRevision,
          observation.observedAt,
          JSON.stringify(observation.linkedNodeIds),
          JSON.stringify(observation.linkedTaskIds),
          observation.followTargetId,
        ],
      );
      const alert = updated.rows[0]!;
      if (reopen || unsuppress) {
        await appendAlertEvent(client, {
          alert,
          actorId: input.actorId,
          kind: "alert.reopened",
          fromLifecycle: current.lifecycle,
          toLifecycle: "open",
          summary: `Alert reopened: ${alert.title}`,
          data: { conditionCode: alert.condition_code },
        });
      }
      if (severityChanged) {
        await appendAlertEvent(client, {
          alert,
          actorId: input.actorId,
          kind: "alert.severity_changed",
          fromLifecycle: current.lifecycle,
          toLifecycle: alert.lifecycle,
          summary: `Alert severity changed to ${alert.severity}`,
          data: {
            previousSeverity: current.severity,
            severity: alert.severity,
          },
        });
      }
      await appendAlertEvent(client, {
        alert,
        actorId: input.actorId,
        kind: "alert.observed",
        fromLifecycle: current.lifecycle,
        toLifecycle: alert.lifecycle,
        summary: `Alert observed again: ${alert.title}`,
        data: {
          conditionCode: alert.condition_code,
          sourceRevision: alert.source_revision,
        },
      });
      return this.alertDetailWithClient(client, alert.id);
    });
  }

  async acknowledgeAlert(input: {
    readonly alertId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly note: string;
  }): Promise<ProjectAlertDetail> {
    return this.mutateAlertLifecycle({
      ...input,
      nextLifecycle: "acknowledged",
      eventKind: "alert.acknowledged",
      summary: "Alert acknowledged",
      allowedFrom: ["open", "suppressed"],
    });
  }

  async suppressAlert(input: {
    readonly alertId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly until: string;
    readonly note: string;
  }): Promise<ProjectAlertDetail> {
    return this.mutateAlertLifecycle({
      ...input,
      nextLifecycle: "suppressed",
      eventKind: "alert.suppressed",
      summary: "Alert suppressed",
      allowedFrom: ["open", "acknowledged"],
      suppressionUntil: input.until,
    });
  }

  async resolveAlert(input: {
    readonly alertId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly note: string;
  }): Promise<ProjectAlertDetail> {
    return this.mutateAlertLifecycle({
      ...input,
      nextLifecycle: "resolved",
      eventKind: "alert.resolved",
      summary: "Alert resolved",
      allowedFrom: ["open", "acknowledged", "suppressed"],
    });
  }

  async assignAlert(input: {
    readonly alertId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly assigneePrincipalId: string | null;
    readonly note: string;
  }): Promise<ProjectAlertDetail> {
    return this.database.transaction(async (client) => {
      const alert = await this.lockAlertForMutation(
        client,
        input.alertId,
        input.expectedRevision,
      );
      const updated = await client.query<AlertRow>(
        `UPDATE project_alerts
         SET assignee_principal_id = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [alert.id, input.assigneePrincipalId],
      );
      const saved = updated.rows[0]!;
      await appendAlertEvent(client, {
        alert: saved,
        actorId: input.actorId,
        kind: "alert.assigned",
        fromLifecycle: saved.lifecycle,
        toLifecycle: saved.lifecycle,
        summary:
          input.assigneePrincipalId === null
            ? "Alert assignment cleared"
            : `Alert assigned to ${input.assigneePrincipalId}`,
        data: {
          assigneePrincipalId: input.assigneePrincipalId,
          note: input.note,
        },
      });
      return this.alertDetailWithClient(client, saved.id);
    });
  }

  async getWorkflowSummary(
    projectId: string,
  ): Promise<ProjectOverviewWorkflowSummary> {
    const result = await this.database.query<{
      definitions: string;
      instances: string;
      active_instances: string;
      blocked_instances: string;
      pending_approvals: string;
      plans: string;
      planning_review_required: string;
      latest_instance_id: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text
          FROM workflow_definitions
          WHERE project_id = $1 AND status = 'active') AS definitions,
         (SELECT COUNT(*)::text
          FROM workflow_instances
          WHERE project_id = $1) AS instances,
         (SELECT COUNT(*)::text
          FROM workflow_instances
          WHERE project_id = $1 AND status = 'active') AS active_instances,
         (SELECT COUNT(*)::text
          FROM workflow_instances
          WHERE project_id = $1 AND status = 'blocked') AS blocked_instances,
         (SELECT COUNT(*)::text
          FROM workflow_approvals AS approval
          JOIN workflow_instances AS instance
            ON instance.id = approval.instance_id
          WHERE instance.project_id = $1
            AND approval.status = 'pending') AS pending_approvals,
         (SELECT COUNT(*)::text
          FROM workflow_plans
          WHERE project_id = $1) AS plans,
         (SELECT COUNT(*)::text
          FROM planning_runs
          WHERE project_id = $1 AND status = 'review_required')
           AS planning_review_required,
         (SELECT id::text
          FROM workflow_instances
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 1) AS latest_instance_id`,
      [projectId],
    );
    const row = result.rows[0]!;
    return {
      definitions: Number(row.definitions),
      instances: Number(row.instances),
      activeInstances: Number(row.active_instances),
      blockedInstances: Number(row.blocked_instances),
      pendingApprovals: Number(row.pending_approvals),
      plans: Number(row.plans),
      planningReviewRequired: Number(row.planning_review_required),
      latestInstanceId: row.latest_instance_id,
    };
  }

  async getTaskSummary(projectId: string): Promise<ProjectOverviewTaskSummary> {
    const result = await this.database.query<{
      total: string;
      queued: string;
      in_progress: string;
      review: string;
      blocked: string;
      done: string;
      cancelled: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
         COUNT(*) FILTER (WHERE status = 'in_progress')::text AS in_progress,
         COUNT(*) FILTER (WHERE status = 'review')::text AS review,
         COUNT(*) FILTER (WHERE status = 'blocked')::text AS blocked,
         COUNT(*) FILTER (WHERE status = 'done')::text AS done,
         COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled
       FROM tasks
       WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0]!;
    return {
      total: Number(row.total),
      queued: Number(row.queued),
      inProgress: Number(row.in_progress),
      review: Number(row.review),
      blocked: Number(row.blocked),
      done: Number(row.done),
      cancelled: Number(row.cancelled),
    };
  }

  private async featureFlagRowWithClient(
    client: PoolClient,
    flagKey: string,
    projectId: string,
  ): Promise<FeatureFlagRow | undefined> {
    const result = await client.query<FeatureFlagRow>(
      `SELECT *
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
    return result.rows[0];
  }

  private async lockAlertForMutation(
    client: PoolClient,
    alertId: string,
    expectedRevision: number,
  ): Promise<AlertRow> {
    const result = await client.query<AlertRow>(
      "SELECT * FROM project_alerts WHERE id = $1 FOR UPDATE",
      [alertId],
    );
    const alert = result.rows[0];
    if (alert === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_alert_not_found",
        "Project alert not found",
        404,
      );
    }
    if (alert.revision !== expectedRevision) {
      throw new ProjectBusinessChainRepositoryError(
        "project_alert_revision_conflict",
        "Project alert changed before this request completed",
        409,
        {
          currentRevision: alert.revision,
          expectedRevision,
        },
      );
    }
    return alert;
  }

  private async mutateAlertLifecycle(input: {
    readonly alertId: string;
    readonly actorId: string;
    readonly expectedRevision: number;
    readonly note: string;
    readonly nextLifecycle: ProjectAlertLifecycle;
    readonly eventKind: ProjectAlertEventKind;
    readonly summary: string;
    readonly allowedFrom: readonly ProjectAlertLifecycle[];
    readonly suppressionUntil?: string;
  }): Promise<ProjectAlertDetail> {
    return this.database.transaction(async (client) => {
      const current = await this.lockAlertForMutation(
        client,
        input.alertId,
        input.expectedRevision,
      );
      if (!input.allowedFrom.includes(current.lifecycle)) {
        throw new ProjectBusinessChainRepositoryError(
          "project_alert_lifecycle_conflict",
          `Alert cannot transition from ${current.lifecycle}`,
          409,
        );
      }
      const updated = await client.query<AlertRow>(
        `UPDATE project_alerts
         SET lifecycle = $2,
             acknowledged_at = CASE
               WHEN $2 = 'acknowledged' THEN NOW()
               WHEN $2 = 'open' THEN NULL
               ELSE acknowledged_at
             END,
             acknowledged_by_principal_id = CASE
               WHEN $2 = 'acknowledged' THEN $3
               WHEN $2 = 'open' THEN NULL
               ELSE acknowledged_by_principal_id
             END,
             suppression_until = CASE
               WHEN $2 = 'suppressed' THEN $4::timestamptz
               ELSE NULL
             END,
             resolved_at = CASE
               WHEN $2 = 'resolved' THEN NOW()
               ELSE NULL
             END,
             resolved_by_principal_id = CASE
               WHEN $2 = 'resolved' THEN $3
               ELSE NULL
             END,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          current.id,
          input.nextLifecycle,
          input.actorId,
          input.suppressionUntil ?? null,
        ],
      );
      const saved = updated.rows[0]!;
      await appendAlertEvent(client, {
        alert: saved,
        actorId: input.actorId,
        kind: input.eventKind,
        fromLifecycle: current.lifecycle,
        toLifecycle: saved.lifecycle,
        summary: input.summary,
        data: {
          note: input.note,
          ...(input.suppressionUntil === undefined
            ? {}
            : { suppressionUntil: input.suppressionUntil }),
        },
      });
      return this.alertDetailWithClient(client, saved.id);
    });
  }

  private async alertDetailWithClient(
    client: PoolClient,
    alertId: string,
  ): Promise<ProjectAlertDetail> {
    const alertResult = await client.query<AlertRow>(
      "SELECT * FROM project_alerts WHERE id = $1",
      [alertId],
    );
    const events = await client.query<AlertEventRow>(
      `SELECT *
       FROM project_alert_events
       WHERE alert_id = $1
       ORDER BY seq`,
      [alertId],
    );
    return {
      alert: alertFromRow(alertResult.rows[0]!),
      events: events.rows.map(alertEventFromRow),
    };
  }
}

export function normalizeBindInput(
  input: BindProjectBusinessChainValue,
): BindProjectBusinessChainValue {
  return {
    ...input,
    nodeBindings: input.nodeBindings.map((binding) =>
      projectBusinessChainNodeBindingSchema.parse(binding),
    ),
  };
}

export async function materializeTemplateBusinessChainWithClient(
  client: PoolClient,
  input: {
    readonly projectId: string;
    readonly projectTemplateId: string;
    readonly projectTemplateRevision: number;
    readonly policy: ProjectTemplateBusinessChainPolicy;
    readonly actorId: string;
  },
): Promise<ProjectBusinessChainBinding | null> {
  if (input.policy.mode !== "required") return null;
  const refs = await client.query<{
    definition_snapshot: unknown;
  }>(
    `SELECT definition_snapshot
     FROM project_template_business_chain_refs
     WHERE template_id = $1
     ORDER BY required DESC, chain_key_snapshot`,
    [input.projectTemplateId],
  );
  const snapshots = refs.rows.map((row) =>
    businessChainDefinitionSnapshotSchema.parse(row.definition_snapshot),
  );
  const selected =
    input.policy.defaultBusinessChainKey === null
      ? snapshots[0]
      : snapshots.find(
          (snapshot) =>
            snapshot.metadata.chainKey === input.policy.defaultBusinessChainKey,
        );
  if (selected === undefined) {
    throw new ProjectBusinessChainRepositoryError(
      "project_business_chain_definition_invalid",
      "Required project template has no business chain definition",
      409,
    );
  }
  const nodeBindings = normalizeNodeBindings(
    selected.nodes,
    [],
    selected.metadata.allowUnboundSources,
  );
  const digest = bindingDigest({
    workflowDefinitionId: selected.id,
    workflowDefinitionVersion: selected.version,
    chainKey: selected.metadata.chainKey,
    nodeBindings,
  });
  await client.query(
    `INSERT INTO project_business_chain_binding_revisions (
       id, project_id, revision, operation, project_template_id,
       source_template_revision, workflow_definition_id,
       workflow_definition_version, definition_snapshot, chain_key,
       binding_mode, node_bindings, binding_digest, actor_principal_id,
       reason, created_at
     ) VALUES (
       $1, $2, 1, 'bind', $3, $4, $5, $6, $7::jsonb, $8, 'template',
       $9::jsonb, $10, $11, '项目创建时按模板固定业务链路', NOW()
     )`,
    [
      randomUUID(),
      input.projectId,
      input.projectTemplateId,
      input.projectTemplateRevision,
      selected.id,
      selected.version,
      JSON.stringify(selected),
      selected.metadata.chainKey,
      JSON.stringify(nodeBindings),
      digest,
      input.actorId,
    ],
  );
  const binding = await client.query<BindingRow>(
    `INSERT INTO project_business_chain_bindings (
       project_id, project_template_id, source_template_revision,
       workflow_definition_id, workflow_definition_version,
       definition_snapshot, chain_key, binding_mode, node_bindings,
       binding_digest, active, revision, bound_by_principal_id, bound_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7, 'template', $8::jsonb, $9,
       TRUE, 1, $10, NOW(), NOW()
     )
     RETURNING *`,
    [
      input.projectId,
      input.projectTemplateId,
      input.projectTemplateRevision,
      selected.id,
      selected.version,
      JSON.stringify(selected),
      selected.metadata.chainKey,
      JSON.stringify(nodeBindings),
      digest,
      input.actorId,
    ],
  );
  return bindingFromRow(binding.rows[0]!);
}

function definitionSnapshotFromRow(
  row: WorkflowDefinitionRow,
): BusinessChainDefinitionSnapshot {
  return businessChainDefinitionSnapshotSchema.parse({
    id: row.id,
    version: row.revision,
    name: row.name,
    description: row.description,
    metadata: businessChainMetadataSchema.parse(row.business_chain_metadata),
    nodes: Array.isArray(row.business_chain_nodes)
      ? row.business_chain_nodes.map((node) =>
          businessChainNodeMetadataSchema.parse(node),
        )
      : [],
  });
}

function normalizeNodeBindings(
  nodes: readonly BusinessChainNodeMetadata[],
  input: readonly ProjectBusinessChainNodeBinding[],
  allowUnboundSources: boolean,
): ProjectBusinessChainNodeBinding[] {
  const inputNodes = new Map(
    input.map((node) => [`${node.sequence}:${node.stageCode}`, node]),
  );
  for (const node of input) {
    const metadata = nodes.find(
      (candidate) =>
        candidate.sequence === node.sequence &&
        candidate.stageCode === node.stageCode,
    );
    if (metadata === undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_definition_invalid",
        `Node ${node.stageCode} is not part of the selected business chain`,
        400,
      );
    }
    const fieldKeys = new Set(metadata.fields.map((field) => field.key));
    const unknownField = node.fieldBindings.find(
      (binding) => !fieldKeys.has(binding.fieldKey),
    );
    if (unknownField !== undefined) {
      throw new ProjectBusinessChainRepositoryError(
        "project_business_chain_definition_invalid",
        `Field ${unknownField.fieldKey} is not part of ${node.stageCode}`,
        400,
      );
    }
  }
  return nodes.map((node) => {
    const existing = inputNodes.get(`${node.sequence}:${node.stageCode}`);
    const existingByField = new Map(
      (existing?.fieldBindings ?? []).map((binding) => [
        binding.fieldKey,
        binding,
      ]),
    );
    const fieldBindings = node.fields.flatMap((field) => {
      const bound = existingByField.get(field.key);
      if (bound !== undefined) {
        if (bound.required && bound.objectId.trim() === "") {
          throw new ProjectBusinessChainRepositoryError(
            "project_business_chain_definition_invalid",
            `Required field ${field.key} has no source object`,
            400,
          );
        }
        return [bound];
      }
      const fallback = field.bindings[0];
      if (fallback === undefined) {
        if (allowUnboundSources) return [];
        throw new ProjectBusinessChainRepositoryError(
          "project_business_chain_definition_invalid",
          `Field ${field.key} has no source binding`,
          400,
        );
      }
      return [
        {
          fieldKey: field.key,
          sourceKind: fallback.sourceKind,
          sourceSystem: fallback.sourceSystem,
          objectType: fallback.objectType,
          objectId: fallback.objectId,
          path: fallback.path,
          required: fallback.required,
          ...(fallback.providerId === undefined
            ? {}
            : { providerId: fallback.providerId }),
          ...(fallback.providerVersionId === undefined
            ? {}
            : { providerVersionId: fallback.providerVersionId }),
          ...(fallback.providerRevision === undefined
            ? {}
            : { providerRevision: fallback.providerRevision }),
          ...(fallback.toolKey === undefined
            ? {}
            : { toolKey: fallback.toolKey }),
          ...(fallback.readOnly === undefined
            ? {}
            : { readOnly: fallback.readOnly }),
        },
      ];
    });
    return {
      sequence: node.sequence,
      stageCode: node.stageCode,
      fieldBindings,
    };
  });
}

function bindingDigest(input: {
  readonly workflowDefinitionId: string;
  readonly workflowDefinitionVersion: number;
  readonly chainKey: string;
  readonly nodeBindings: readonly ProjectBusinessChainNodeBinding[];
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        workflowDefinitionId: input.workflowDefinitionId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        chainKey: input.chainKey,
        nodeBindings: input.nodeBindings,
      }),
    )
    .digest("hex");
}

function alertConditionKey(observation: ProjectAlertObservation): string {
  return createHash("sha256")
    .update(
      businessChainConditionMaterial({
        sourceSystem: observation.sourceSystem,
        sourceObjectId: observation.sourceObjectId,
        conditionCode: observation.conditionCode,
      }),
    )
    .digest("hex");
}

async function appendAlertEvent(
  client: PoolClient,
  input: {
    readonly alert: AlertRow;
    readonly actorId: string;
    readonly kind: ProjectAlertEventKind;
    readonly fromLifecycle: ProjectAlertLifecycle | null;
    readonly toLifecycle: ProjectAlertLifecycle | null;
    readonly summary: string;
    readonly data: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO project_alert_events (
       id, alert_id, project_id, seq, kind, actor_principal_id,
       from_lifecycle, to_lifecycle, summary, data, created_at
     ) VALUES (
       $1, $2, $3, 1, $4, $5, $6, $7, $8, $9::jsonb, NOW()
     )`,
    [
      randomUUID(),
      input.alert.id,
      input.alert.project_id,
      input.kind,
      input.actorId,
      input.fromLifecycle,
      input.toLifecycle,
      input.summary,
      JSON.stringify(input.data),
    ],
  );
}

function featureFlagFromRow(row: FeatureFlagRow): ProjectFeatureFlagState {
  return projectFeatureFlagStateSchema.parse({
    flagKey: row.flag_key,
    enabled: row.mode === "on" || row.mode === "enforce",
    revision: row.revision,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
  });
}

function bindingFromRow(row: BindingRow): ProjectBusinessChainBinding {
  return projectBusinessChainBindingSchema.parse({
    projectId: row.project_id,
    projectTemplateId: row.project_template_id,
    sourceTemplateRevision: row.source_template_revision,
    workflowDefinitionId: row.workflow_definition_id,
    workflowDefinitionVersion: row.workflow_definition_version,
    definitionSnapshot: businessChainDefinitionSnapshotSchema.parse(
      row.definition_snapshot,
    ),
    chainKey: row.chain_key,
    bindingMode: row.binding_mode,
    nodeBindings: row.node_bindings,
    bindingDigest: row.binding_digest,
    revision: row.revision,
    boundByPrincipalId: row.bound_by_principal_id,
    boundAt: row.bound_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function bindingRevisionFromRow(
  row: BindingRevisionRow,
): ProjectBusinessChainBindingRevision {
  return projectBusinessChainBindingRevisionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    operation: row.operation,
    projectTemplateId: row.project_template_id,
    sourceTemplateRevision: row.source_template_revision,
    workflowDefinitionId: row.workflow_definition_id,
    workflowDefinitionVersion: row.workflow_definition_version,
    definitionSnapshot:
      row.definition_snapshot === null
        ? null
        : businessChainDefinitionSnapshotSchema.parse(row.definition_snapshot),
    chainKey: row.chain_key,
    bindingMode: row.binding_mode,
    nodeBindings: row.node_bindings,
    bindingDigest: row.binding_digest,
    actorPrincipalId: row.actor_principal_id,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  });
}

function sourceSnapshotFromRow(row: SourceSnapshotRow): ProjectSourceSnapshot {
  return projectSourceSnapshotSchema.parse({
    id: row.id,
    projectId: row.project_id,
    refKey: row.ref_key,
    sourceKind: row.source_kind,
    sourceSystem: row.source_system,
    sourceObjectType: row.source_object_type,
    sourceObjectId: row.source_object_id,
    sourceRevision: row.source_revision,
    version: row.version,
    status: row.status,
    observedAt: row.observed_at.toISOString(),
    effectiveAt: row.effective_at?.toISOString() ?? null,
    freshUntil: row.fresh_until?.toISOString() ?? null,
    payloadDigest: row.payload_digest,
    payload: row.payload,
    failureReason: row.failure_reason,
    isMock: row.is_mock,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  });
}

function alertFromRow(row: AlertRow): ProjectAlert {
  return projectAlertSchema.parse({
    id: row.id,
    projectId: row.project_id,
    conditionKey: row.condition_key,
    sourceSystem: row.source_system,
    sourceObjectType: row.source_object_type,
    sourceObjectId: row.source_object_id,
    conditionCode: row.condition_code,
    title: row.title,
    message: row.message,
    severity: row.severity,
    lifecycle: row.lifecycle,
    sourceRevision: row.source_revision,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    acknowledgedByPrincipalId: row.acknowledged_by_principal_id,
    suppressionUntil: row.suppression_until?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    assigneePrincipalId: row.assignee_principal_id,
    linkedNodeIds: Array.isArray(row.linked_node_ids)
      ? row.linked_node_ids
      : [],
    linkedTaskIds: Array.isArray(row.linked_task_ids)
      ? row.linked_task_ids
      : [],
    followTargetId: row.follow_target_id,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function alertEventFromRow(row: AlertEventRow): ProjectAlertEvent {
  return projectAlertEventSchema.parse({
    id: row.id,
    alertId: row.alert_id,
    projectId: row.project_id,
    seq: Number(row.seq),
    kind: row.kind,
    actorPrincipalId: row.actor_principal_id,
    fromLifecycle: row.from_lifecycle,
    toLifecycle: row.to_lifecycle,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  });
}

export function stableJson(value: unknown): string {
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
