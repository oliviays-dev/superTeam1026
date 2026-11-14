import { randomUUID } from "node:crypto";
import type {
  ProjectRoleMappingPreset,
  WorkflowAssignmentSource,
  WorkflowAssignmentStatus,
  WorkflowInstanceApprover,
  WorkflowInstanceAssignment,
  WorkflowPrincipalRef,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface WorkflowAssignmentRow {
  instance_id: string;
  task_id: string | null;
  node_id: string;
  source_kind: WorkflowAssignmentSource["kind"];
  source_id: string;
  source_role_code: string | null;
  source_label: string | null;
  dispatch_mode: WorkflowInstanceAssignment["dispatchMode"];
  status: WorkflowAssignmentStatus;
  primary_principal_id: string | null;
  candidate_pool: WorkflowPrincipalRef[];
  resolved_by: string;
  resolved_at: Date;
  source_change_reason: string;
  revision: number;
}

interface WorkflowApproverRow {
  instance_id: string;
  node_id: string;
  principal_id: string;
  source_kind: WorkflowAssignmentSource["kind"];
  source_id: string;
  source_role_code: string | null;
  status: WorkflowInstanceApprover["status"];
  resolved_by: string;
  resolved_at: Date;
  revision: number;
}

interface ProjectRoleMappingPresetRow {
  project_id: string;
  role_id: string;
  role_code: string;
  assignees: string[];
  revision: number;
  updated_by_principal_id: string;
  updated_at: Date;
}

export interface WorkflowAssignmentWriteInput {
  readonly instanceId: string;
  readonly taskId?: string | null;
  readonly nodeId: string;
  readonly source: WorkflowAssignmentSource;
  readonly dispatchMode: WorkflowInstanceAssignment["dispatchMode"];
  readonly status: WorkflowAssignmentStatus;
  readonly primaryPrincipalId: string | null;
  readonly candidatePool: readonly WorkflowPrincipalRef[];
  readonly resolvedBy: string;
  readonly sourceChangeReason?: string;
  readonly revision?: number;
}

export interface WorkflowApproverWriteInput {
  readonly instanceId: string;
  readonly nodeId: string;
  readonly principalId: string;
  readonly source: WorkflowAssignmentSource;
  readonly status: WorkflowInstanceApprover["status"];
  readonly resolvedBy: string;
  readonly revision?: number;
}

export interface WorkflowBindingWriteInput {
  readonly assignments: readonly WorkflowAssignmentWriteInput[];
  readonly approvers: readonly WorkflowApproverWriteInput[];
}

export interface WorkflowBindingSeed {
  readonly assignments: readonly Omit<
    WorkflowAssignmentWriteInput,
    "instanceId"
  >[];
  readonly approvers: readonly Omit<
    WorkflowApproverWriteInput,
    "instanceId"
  >[];
}

export interface ReplaceWorkflowBindingsInput extends WorkflowBindingSeed {
  readonly instanceId: string;
  readonly expectedBindingRevision: string;
  readonly bindingRevision: string;
  readonly actorId: string;
  readonly sourceChangeReason: string;
}

export type WorkflowAssignmentRepositoryErrorCode =
  | "workflow_binding_revision_conflict"
  | "workflow_binding_already_started"
  | "project_role_mapping_preset_conflict"
  | "project_role_mapping_preset_role_mismatch";

export class WorkflowAssignmentRepositoryError extends Error {
  constructor(
    readonly code: WorkflowAssignmentRepositoryErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "WorkflowAssignmentRepositoryError";
  }
}

export class WorkflowAssignmentRepository {
  constructor(private readonly database: Database) {}

  async listAssignments(
    instanceId: string,
  ): Promise<WorkflowInstanceAssignment[]> {
    const result = await this.database.query<WorkflowAssignmentRow>(
      `SELECT *
       FROM workflow_instance_assignments
       WHERE instance_id = $1
       ORDER BY created_at, node_id`,
      [instanceId],
    );
    return result.rows.map(assignmentFromRow);
  }

  async listApprovers(instanceId: string): Promise<WorkflowInstanceApprover[]> {
    const result = await this.database.query<WorkflowApproverRow>(
      `SELECT *
       FROM workflow_instance_approvers
       WHERE instance_id = $1
       ORDER BY created_at, node_id, principal_id`,
      [instanceId],
    );
    return result.rows.map(approverFromRow);
  }

  async listPresets(projectId: string): Promise<ProjectRoleMappingPreset[]> {
    const result = await this.database.query<ProjectRoleMappingPresetRow>(
      `SELECT preset.*, role.code AS role_code
       FROM project_role_mapping_presets AS preset
       JOIN project_roles AS role ON role.id = preset.role_id
       WHERE preset.project_id = $1
       ORDER BY role.name, preset.role_id`,
      [projectId],
    );
    return result.rows.map(presetFromRow);
  }

  async upsertPreset(input: {
    readonly projectId: string;
    readonly roleId: string;
    readonly assignees: readonly string[];
    readonly actorId: string;
    readonly expectedRevision?: number;
  }): Promise<ProjectRoleMappingPreset> {
    return this.database.transaction(async (client) => {
      const role = await client.query<{ code: string }>(
        `SELECT code
         FROM project_roles
         WHERE project_id = $1 AND id = $2`,
        [input.projectId, input.roleId],
      );
      if (role.rows[0] === undefined) {
        throw new WorkflowAssignmentRepositoryError(
          "project_role_mapping_preset_role_mismatch",
          "The role does not belong to the target project",
          404,
        );
      }
      const current = await client.query<ProjectRoleMappingPresetRow & {
        role_code: string;
      }>(
        `SELECT preset.*, role.code AS role_code
         FROM project_role_mapping_presets AS preset
         JOIN project_roles AS role ON role.id = preset.role_id
         WHERE preset.project_id = $1 AND preset.role_id = $2
         FOR UPDATE`,
        [input.projectId, input.roleId],
      );
      const existing = current.rows[0];
      if (
        input.expectedRevision !== undefined &&
        (existing?.revision ?? 0) !== input.expectedRevision
      ) {
        throw new WorkflowAssignmentRepositoryError(
          "project_role_mapping_preset_conflict",
          "The role mapping preset revision changed",
        );
      }
      const result =
        existing === undefined
          ? await client.query<ProjectRoleMappingPresetRow>(
              `INSERT INTO project_role_mapping_presets (
                 project_id, role_id, assignees, revision,
                 updated_by_principal_id, updated_at
               ) VALUES ($1, $2, $3::jsonb, 1, $4, NOW())
               RETURNING *, $5::text AS role_code`,
              [
                input.projectId,
                input.roleId,
                JSON.stringify(input.assignees),
                input.actorId,
                role.rows[0].code,
              ],
            )
          : await client.query<ProjectRoleMappingPresetRow>(
              `UPDATE project_role_mapping_presets
               SET assignees = $3::jsonb,
                   revision = revision + 1,
                   updated_by_principal_id = $4,
                   updated_at = NOW()
               WHERE project_id = $1 AND role_id = $2
               RETURNING *, $5::text AS role_code`,
              [
                input.projectId,
                input.roleId,
                JSON.stringify(input.assignees),
                input.actorId,
                role.rows[0].code,
              ],
            );
      return presetFromRow(result.rows[0]!);
    });
  }

  async deletePreset(
    projectId: string,
    roleId: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM project_role_mapping_presets
       WHERE project_id = $1 AND role_id = $2`,
      [projectId, roleId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async attachTask(
    instanceId: string,
    nodeId: string,
    taskId: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE workflow_instance_assignments
       SET task_id = $3, updated_at = NOW()
       WHERE instance_id = $1 AND node_id = $2`,
      [instanceId, nodeId, taskId],
    );
  }

  async findClaimAssignment(
    taskId: string,
  ): Promise<WorkflowInstanceAssignment | undefined> {
    const result = await this.database.query<WorkflowAssignmentRow>(
      `SELECT *
       FROM workflow_instance_assignments
       WHERE task_id = $1 AND dispatch_mode = 'claim'`,
      [taskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : assignmentFromRow(row);
  }

  async replaceBindings(
    input: ReplaceWorkflowBindingsInput,
  ): Promise<number> {
    return this.database.transaction(async (client) => {
      const instance = await client.query<{
        revision: number;
        binding_revision: string | null;
        runtime_nodes: Array<{ taskId?: string | null }>;
      }>(
        `SELECT revision, binding_revision, runtime_nodes
         FROM workflow_instances
         WHERE id = $1
         FOR UPDATE`,
        [input.instanceId],
      );
      const current = instance.rows[0];
      if (current === undefined) {
        throw new WorkflowAssignmentRepositoryError(
          "workflow_binding_revision_conflict",
          "Workflow instance not found",
          404,
        );
      }
      if (current.binding_revision !== input.expectedBindingRevision) {
        throw new WorkflowAssignmentRepositoryError(
          "workflow_binding_revision_conflict",
          "Workflow bindings changed by another request",
        );
      }
      if (
        current.runtime_nodes.some(
          (node) => node.taskId !== null && node.taskId !== undefined,
        )
      ) {
        throw new WorkflowAssignmentRepositoryError(
          "workflow_binding_already_started",
          "Workflow bindings cannot change after node tasks have been created",
        );
      }
      await client.query(
        `DELETE FROM workflow_instance_approvers WHERE instance_id = $1`,
        [input.instanceId],
      );
      await client.query(
        `DELETE FROM workflow_instance_assignments WHERE instance_id = $1`,
        [input.instanceId],
      );
      await insertWorkflowBindingsWithClient(client, {
        assignments: input.assignments.map((assignment) => ({
          ...assignment,
          instanceId: input.instanceId,
        })),
        approvers: input.approvers.map((approver) => ({
          ...approver,
          instanceId: input.instanceId,
        })),
      });
      const updated = await client.query<{ revision: number }>(
        `UPDATE workflow_instances
         SET binding_revision = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING revision`,
        [input.instanceId, input.bindingRevision],
      );
      await appendWorkflowAuditWithClient(client, input.instanceId, input.actorId, [
        {
          kind: "assignment.remapped",
          summary: "实例责任绑定已重新解析",
          data: {
            previousBindingRevision: input.expectedBindingRevision,
            bindingRevision: input.bindingRevision,
            sourceChangeReason: input.sourceChangeReason,
          },
        },
      ]);
      return updated.rows[0]!.revision;
    });
  }
}

export async function insertWorkflowBindingsWithClient(
  client: PoolClient,
  input: WorkflowBindingWriteInput,
): Promise<void> {
  for (const assignment of input.assignments) {
    await client.query(
      `INSERT INTO workflow_instance_assignments (
         id, instance_id, task_id, node_id, source_kind, source_id,
         source_role_code, source_label, dispatch_mode, status,
         primary_principal_id, candidate_pool, resolved_by, resolved_at,
         source_change_reason, revision, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
         NOW(), $14, $15, NOW(), NOW()
       )`,
      [
        randomUUID(),
        assignment.instanceId,
        assignment.taskId ?? null,
        assignment.nodeId,
        assignment.source.kind,
        assignment.source.sourceId,
        assignment.source.roleCode,
        assignment.source.label,
        assignment.dispatchMode,
        assignment.status,
        assignment.primaryPrincipalId,
        JSON.stringify(assignment.candidatePool),
        assignment.resolvedBy,
        assignment.sourceChangeReason ?? "",
        assignment.revision ?? 1,
      ],
    );
  }
  for (const approver of input.approvers) {
    await client.query(
      `INSERT INTO workflow_instance_approvers (
         id, instance_id, node_id, principal_id, source_kind, source_id,
         source_role_code, status, resolved_by, resolved_at, revision,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, NOW(), NOW()
       )`,
      [
        randomUUID(),
        approver.instanceId,
        approver.nodeId,
        approver.principalId,
        approver.source.kind,
        approver.source.sourceId,
        approver.source.roleCode,
        approver.status,
        approver.resolvedBy,
        approver.revision ?? 1,
      ],
    );
  }
}

export async function appendWorkflowAuditWithClient(
  client: PoolClient,
  instanceId: string,
  actorId: string,
  audits: ReadonlyArray<{
    readonly kind: string;
    readonly nodeId?: string;
    readonly summary: string;
    readonly data?: Record<string, unknown> | null;
  }>,
): Promise<void> {
  for (const audit of audits) {
    await client.query(
      `INSERT INTO workflow_audit_events (
         id, instance_id, node_id, seq, kind, actor_id, summary, data,
         created_at
       )
       SELECT $1, $2, $3, COALESCE(MAX(seq), 0) + 1, $4, $5, $6, $7::jsonb, NOW()
       FROM workflow_audit_events
       WHERE instance_id = $2`,
      [
        randomUUID(),
        instanceId,
        audit.nodeId ?? null,
        audit.kind,
        actorId,
        audit.summary,
        audit.data === undefined || audit.data === null
          ? null
          : JSON.stringify(audit.data),
      ],
    );
  }
}

function assignmentFromRow(
  row: WorkflowAssignmentRow,
): WorkflowInstanceAssignment {
  return {
    instanceId: row.instance_id,
    taskId: row.task_id,
    nodeId: row.node_id,
    source: {
      kind: row.source_kind,
      sourceId: row.source_id,
      roleCode: row.source_role_code,
      label: row.source_label,
    },
    dispatchMode: row.dispatch_mode,
    status: row.status,
    primaryPrincipalId: row.primary_principal_id,
    candidatePool: row.candidate_pool,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at.toISOString(),
    sourceChangeReason: row.source_change_reason,
    revision: row.revision,
  };
}
function approverFromRow(row: WorkflowApproverRow): WorkflowInstanceApprover {
  return {
    instanceId: row.instance_id,
    nodeId: row.node_id,
    principalId: row.principal_id,
    source: {
      kind: row.source_kind,
      sourceId: row.source_id,
      roleCode: row.source_role_code,
      label: null,
    },
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at.toISOString(),
    revision: row.revision,
  };
}
function presetFromRow(
  row: ProjectRoleMappingPresetRow,
): ProjectRoleMappingPreset {
  return {
    projectId: row.project_id,
    roleId: row.role_id,
    roleCode: row.role_code,
    assignees: row.assignees,
    revision: row.revision,
    updatedByPrincipalId: row.updated_by_principal_id,
    updatedAt: row.updated_at.toISOString(),
  };
}
