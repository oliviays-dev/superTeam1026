import { randomUUID } from "node:crypto";
import type {
  ArchiveProjectTemplateInput,
  CopyProjectTemplateInput,
  CreateProjectTemplateInput,
  CreateTemplateRoleInput,
  CreateWorkflowTemplateInput,
  Project,
  ProjectTemplate,
  ProjectTemplateAccessPolicy,
  ProjectTemplateRevisionSummary,
  ProjectTemplateWorkflowRef,
  TemplateRole,
  UpdateProjectTemplateInput,
  UpdateTemplateRoleInput,
  UpdateWorkflowTemplateInput,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
} from "@pluginmax/contracts";
import { AuthorizationRepository } from "./authorization-repository.js";
import { workflowTemplateDefinitionSchema } from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { projectFromRow, type ProjectRow } from "./rows.js";

interface TemplateRoleRow {
  id: string;
  code: string;
  name: string;
  category: TemplateRole["category"];
  description: string;
  permissions: TemplateRole["permissions"];
  status: TemplateRole["status"];
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowTemplateRow {
  id: string;
  key: string;
  name: string;
  description: string;
  definition: unknown;
  version: number;
  status: WorkflowTemplate["status"];
  created_at: Date;
  updated_at: Date;
}

interface ProjectTemplateRow {
  id: string;
  name: string;
  code: string;
  type: string;
  description: string;
  status: ProjectTemplate["status"];
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  snapshot: ProjectTemplateSnapshot;
  materialized_project_count: number | string;
}

interface ProjectTemplateRevisionRow {
  template_id: string;
  revision: number;
  snapshot: ProjectTemplateSnapshot;
  change_summary: string;
  status: ProjectTemplate["status"];
  actor_id: string;
  created_at: Date;
}

export interface ProjectTemplateSnapshot {
  readonly name: string;
  readonly code: string;
  readonly type: string;
  readonly description: string;
  readonly roles: readonly TemplateRole[];
  readonly ownerRoleId: string | null;
  readonly workflowTemplates: readonly ProjectTemplateWorkflowRef[];
  readonly accessPolicy: ProjectTemplateAccessPolicy;
  readonly allowedActorIds: readonly string[];
}

export interface CreateProjectTemplateSnapshotInput {
  readonly name: string;
  readonly code: string;
  readonly type: string;
  readonly description: string;
  readonly roleIds: readonly string[];
  readonly ownerRoleId?: string | undefined;
  readonly workflowTemplates: readonly {
    readonly workflowTemplateId: string;
    readonly expectedVersion: number;
  }[];
  readonly accessPolicy: ProjectTemplateAccessPolicy;
  readonly allowedActorIds: readonly string[];
}

export interface MaterializeProjectTemplateInput {
  readonly templateId: string;
  readonly projectName: string;
  readonly projectCode?: string | undefined;
  readonly projectDescription?: string | undefined;
  readonly actorId: string;
  readonly actorName: string;
  readonly administrator: boolean;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface MaterializedProjectTemplate {
  readonly project: Project;
  readonly created: boolean;
  readonly templateRevision: number;
}

export type ProjectTemplateErrorCode =
  | "template_not_found"
  | "template_archived"
  | "template_revision_conflict"
  | "template_code_conflict"
  | "template_forbidden"
  | "template_role_not_found"
  | "template_role_archived"
  | "template_role_code_conflict"
  | "template_role_in_use"
  | "template_role_revision_conflict"
  | "workflow_template_not_found"
  | "workflow_template_archived"
  | "workflow_template_version_conflict"
  | "workflow_template_key_conflict"
  | "project_template_in_use"
  | "materialization_key_conflict";

export class ProjectTemplateRepositoryError extends Error {
  constructor(
    readonly code: ProjectTemplateErrorCode,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProjectTemplateRepositoryError";
  }
}

export class ProjectTemplatesRepository {
  private readonly authorization: AuthorizationRepository;

  constructor(
    private readonly database: Database,
    authorization?: AuthorizationRepository,
  ) {
    this.authorization = authorization ?? new AuthorizationRepository(database);
  }

  async listTemplateRoles(includeArchived = false): Promise<TemplateRole[]> {
    const result = await this.database.query<TemplateRoleRow>(
      `SELECT *
       FROM template_roles
       WHERE ($1::boolean OR status = 'active')
       ORDER BY category, name`,
      [includeArchived],
    );
    return result.rows.map(templateRoleFromRow);
  }

  async createTemplateRole(
    input: CreateTemplateRoleInput,
  ): Promise<TemplateRole> {
    try {
      const result = await this.database.query<TemplateRoleRow>(
        `INSERT INTO template_roles (
           id, code, name, category, description, permissions, status,
           revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', 1, NOW(), NOW())
         RETURNING *`,
        [
          randomUUID(),
          input.code,
          input.name,
          input.category,
          input.description,
          JSON.stringify(input.permissions),
        ],
      );
      return templateRoleFromRow(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "template_role_code_conflict",
          "A template role with this code already exists",
        );
      }
      throw error;
    }
  }

  async updateTemplateRole(
    id: string,
    input: UpdateTemplateRoleInput,
  ): Promise<TemplateRole> {
    try {
      const result = await this.database.query<TemplateRoleRow>(
        `UPDATE template_roles
         SET
           code = COALESCE($2, code),
           name = COALESCE($3, name),
           category = COALESCE($4, category),
           description = COALESCE($5, description),
           permissions = COALESCE($6::jsonb, permissions),
           revision = revision + 1,
           updated_at = NOW()
         WHERE id = $1
           AND revision = $7
           AND status = 'active'
         RETURNING *`,
        [
          id,
          input.code ?? null,
          input.name ?? null,
          input.category ?? null,
          input.description ?? null,
          input.permissions === undefined
            ? null
            : JSON.stringify(input.permissions),
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) return templateRoleFromRow(row);
      const existing = await this.database.query<TemplateRoleRow>(
        "SELECT * FROM template_roles WHERE id = $1",
        [id],
      );
      const current = existing.rows[0];
      if (current === undefined) {
        throw new ProjectTemplateRepositoryError(
          "template_role_not_found",
          "Template role not found",
          404,
        );
      }
      if (current.status === "archived") {
        throw new ProjectTemplateRepositoryError(
          "template_role_archived",
          "Archived template roles cannot be edited",
        );
      }
      throw new ProjectTemplateRepositoryError(
        "template_role_revision_conflict",
        "The template role was changed by another request",
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "template_role_code_conflict",
          "A template role with this code already exists",
        );
      }
      throw error;
    }
  }

  async deleteTemplateRole(id: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const roleResult = await client.query<TemplateRoleRow>(
        "SELECT * FROM template_roles WHERE id = $1 FOR UPDATE",
        [id],
      );
      const role = roleResult.rows[0];
      if (role === undefined) {
        throw new ProjectTemplateRepositoryError(
          "template_role_not_found",
          "Template role not found",
          404,
        );
      }
      const references = await this.roleReferences(client, id);
      if (references.templateCount > 0 || references.projectRoleCount > 0) {
        throw new ProjectTemplateRepositoryError(
          "template_role_in_use",
          "The template role is still referenced",
          409,
          references,
        );
      }
      await client.query("DELETE FROM template_roles WHERE id = $1", [id]);
    });
  }

  async listWorkflowTemplates(
    includeArchived = false,
  ): Promise<WorkflowTemplate[]> {
    const result = await this.database.query<WorkflowTemplateRow>(
      `SELECT *
       FROM workflow_templates
       WHERE ($1::boolean OR status = 'active')
       ORDER BY status, name`,
      [includeArchived],
    );
    return result.rows.map(workflowTemplateFromRow);
  }

  async createWorkflowTemplate(
    input: CreateWorkflowTemplateInput,
  ): Promise<WorkflowTemplate> {
    try {
      const result = await this.database.query<WorkflowTemplateRow>(
        `INSERT INTO workflow_templates (
           id, key, name, description, definition, version, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, 1, 'active', NOW(), NOW())
         RETURNING *`,
        [
          randomUUID(),
          input.key,
          input.name,
          input.description,
          JSON.stringify(input.definition),
        ],
      );
      return workflowTemplateFromRow(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_key_conflict",
          "A workflow template with this key already exists",
        );
      }
      throw error;
    }
  }

  async updateWorkflowTemplate(
    id: string,
    input: UpdateWorkflowTemplateInput,
  ): Promise<WorkflowTemplate> {
    try {
      const result = await this.database.query<WorkflowTemplateRow>(
        `UPDATE workflow_templates
         SET
           key = COALESCE($2, key),
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           definition = COALESCE($5::jsonb, definition),
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1
           AND version = $6
           AND status = 'active'
         RETURNING *`,
        [
          id,
          input.key ?? null,
          input.name ?? null,
          input.description ?? null,
          input.definition === undefined
            ? null
            : JSON.stringify(input.definition),
          input.expectedVersion,
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) return workflowTemplateFromRow(row);
      const existing = await this.database.query<WorkflowTemplateRow>(
        "SELECT * FROM workflow_templates WHERE id = $1",
        [id],
      );
      const current = existing.rows[0];
      if (current === undefined) {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_not_found",
          "Workflow template not found",
          404,
        );
      }
      if (current.status === "archived") {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_archived",
          "Archived workflow templates cannot be edited",
        );
      }
      throw new ProjectTemplateRepositoryError(
        "workflow_template_version_conflict",
        "The workflow template version changed",
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_key_conflict",
          "A workflow template with this key already exists",
        );
      }
      throw error;
    }
  }

  async listProjectTemplates(input: {
    readonly actorId: string;
    readonly administrator: boolean;
    readonly includeArchived?: boolean;
  }): Promise<ProjectTemplate[]> {
    const result = await this.database.query<ProjectTemplateRow>(
      `${this.projectTemplateSelectSql}
       WHERE (
         (
           $2::boolean
           AND ($3::boolean OR template.status = 'active')
         )
         OR (
           NOT $2::boolean
           AND template.status = 'active'
           AND (
             revision.snapshot->>'accessPolicy' = 'all-members'
             OR EXISTS (
               SELECT 1
               FROM project_template_grants AS grant_row
               WHERE grant_row.template_id = template.id
                 AND grant_row.actor_id = $1
             )
           )
         )
       )
       ORDER BY template.updated_at DESC, template.name`,
      [input.actorId, input.administrator, input.includeArchived ?? false],
    );
    return result.rows.map(projectTemplateFromRow);
  }

  async getProjectTemplate(id: string): Promise<ProjectTemplate | undefined> {
    const result = await this.database.query<ProjectTemplateRow>(
      `${this.projectTemplateSelectSql}
       WHERE template.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectTemplateFromRow(row);
  }

  async createProjectTemplate(
    input: CreateProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    let templateId: string;
    try {
      templateId = await this.database.transaction(async (client) => {
        const snapshot = await this.buildSnapshot(client, input);
        const id = randomUUID();
        await client.query(
          `INSERT INTO project_templates (
             id, name, code, type, description, status, revision,
             created_by, updated_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6, NOW(), NOW())`,
          [
            id,
            snapshot.name,
            snapshot.code,
            snapshot.type,
            snapshot.description,
            actorId,
          ],
        );
        await this.insertSnapshotRelations(client, id, snapshot);
        await this.insertRevision(
          client,
          id,
          1,
          snapshot,
          "创建项目模板",
          "active",
          actorId,
        );
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "template_code_conflict",
          "A project template with this code already exists",
        );
      }
      throw error;
    }
    return (await this.getProjectTemplate(templateId))!;
  }

  async updateProjectTemplate(
    id: string,
    input: UpdateProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    try {
      await this.database.transaction(async (client) => {
        const current = await this.lockProjectTemplate(client, id);
        if (current.status === "archived") {
          throw new ProjectTemplateRepositoryError(
            "template_archived",
            "Archived project templates are read-only",
          );
        }
        if (current.revision !== input.expectedRevision) {
          throw revisionConflict(id, current.revision, input.expectedRevision);
        }
        const currentSnapshot = current.snapshot;
        const roleIds =
          input.roleIds ??
          currentSnapshot.roles.map((role: TemplateRole) => role.id);
        const workflowTemplates =
          input.workflowTemplates ??
          currentSnapshot.workflowTemplates.map((ref) => ({
            workflowTemplateId: ref.workflowTemplateId,
            expectedVersion: ref.version,
          }));
        const accessPolicy = input.accessPolicy ?? currentSnapshot.accessPolicy;
        const allowedActorIds =
          input.allowedActorIds ?? currentSnapshot.allowedActorIds;
        if (
          accessPolicy === "selected-members" &&
          allowedActorIds.length === 0
        ) {
          throw new ProjectTemplateRepositoryError(
            "template_forbidden",
            "Selected-member templates require at least one actor",
            400,
          );
        }
        const snapshot = await this.buildSnapshot(client, {
          name: input.name ?? current.name,
          code: input.code ?? current.code,
          type: input.type ?? current.type,
          description: input.description ?? current.description,
          roleIds,
          ownerRoleId:
            input.ownerRoleId === undefined
              ? (currentSnapshot.ownerRoleId ?? undefined)
              : (input.ownerRoleId ?? undefined),
          workflowTemplates,
          accessPolicy,
          allowedActorIds,
        });
        const nextRevision = current.revision + 1;
        await client.query(
          `UPDATE project_templates
           SET
             name = $2,
             code = $3,
             type = $4,
             description = $5,
             revision = $6,
             updated_by = $7,
             updated_at = NOW()
           WHERE id = $1`,
          [
            id,
            snapshot.name,
            snapshot.code,
            snapshot.type,
            snapshot.description,
            nextRevision,
            actorId,
          ],
        );
        await this.replaceTemplateRelations(client, id, snapshot);
        await this.insertRevision(
          client,
          id,
          nextRevision,
          snapshot,
          input.changeSummary ??
            `更新模板 · ${snapshot.roles.length} 个角色 · ${snapshot.workflowTemplates.length} 个工作流`,
          "active",
          actorId,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "template_code_conflict",
          "A project template with this code already exists",
        );
      }
      throw error;
    }
    return (await this.getProjectTemplate(id))!;
  }

  async copyProjectTemplate(
    id: string,
    input: CopyProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    let copyId: string;
    try {
      copyId = await this.database.transaction(async (client) => {
        const source = await this.lockProjectTemplate(client, id);
        const nextId = randomUUID();
        const snapshot: ProjectTemplateSnapshot = {
          ...source.snapshot,
          name: input.name,
          code: input.code,
        };
        await client.query(
          `INSERT INTO project_templates (
             id, name, code, type, description, status, revision,
             created_by, updated_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6, NOW(), NOW())`,
          [
            nextId,
            snapshot.name,
            snapshot.code,
            snapshot.type,
            snapshot.description,
            actorId,
          ],
        );
        await this.insertSnapshotRelations(client, nextId, snapshot);
        await this.insertRevision(
          client,
          nextId,
          1,
          snapshot,
          `复制自 ${source.code} · revision ${source.revision}`,
          "active",
          actorId,
        );
        return nextId;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProjectTemplateRepositoryError(
          "template_code_conflict",
          "A project template with this code already exists",
        );
      }
      throw error;
    }
    return (await this.getProjectTemplate(copyId))!;
  }

  async archiveProjectTemplate(
    id: string,
    input: ArchiveProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    await this.database.transaction(async (client) => {
      const current = await this.lockProjectTemplate(client, id);
      if (current.status === "archived") {
        throw new ProjectTemplateRepositoryError(
          "template_archived",
          "The project template is already archived",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict(id, current.revision, input.expectedRevision);
      }
      const usage = await client.query<{
        count: string;
        project_names: string[];
      }>(
        `SELECT
           COUNT(*)::text AS count,
           COALESCE(
             ARRAY_AGG(projects.name ORDER BY projects.created_at) FILTER (
               WHERE projects.id IS NOT NULL
             ),
             '{}'::text[]
           ) AS project_names
         FROM project_template_materializations AS materialization
         LEFT JOIN projects ON projects.id = materialization.project_id
         WHERE materialization.template_id = $1`,
        [id],
      );
      const materializedCount = Number(usage.rows[0]?.count ?? "0");
      if (materializedCount > 0) {
        throw new ProjectTemplateRepositoryError(
          "project_template_in_use",
          "The project template has already materialized projects",
          409,
          {
            materializedProjectCount: materializedCount,
            projectNames: usage.rows[0]?.project_names ?? [],
          },
        );
      }
      const nextRevision = current.revision + 1;
      await client.query(
        `UPDATE project_templates
         SET status = 'archived', revision = $2, updated_by = $3, updated_at = NOW()
         WHERE id = $1`,
        [id, nextRevision, actorId],
      );
      await this.insertRevision(
        client,
        id,
        nextRevision,
        current.snapshot,
        input.reason === "" ? "归档项目模板" : `归档项目模板 · ${input.reason}`,
        "archived",
        actorId,
      );
    });
    return (await this.getProjectTemplate(id))!;
  }

  async listProjectTemplateHistory(
    id: string,
  ): Promise<ProjectTemplateRevisionSummary[]> {
    const template = await this.getProjectTemplate(id);
    if (template === undefined) {
      throw new ProjectTemplateRepositoryError(
        "template_not_found",
        "Project template not found",
        404,
      );
    }
    const result = await this.database.query<ProjectTemplateRevisionRow>(
      `SELECT *
       FROM project_template_revisions
       WHERE template_id = $1
       ORDER BY revision DESC`,
      [id],
    );
    return result.rows.map((row) => ({
      templateId: row.template_id,
      revision: row.revision,
      changeSummary: row.change_summary,
      status: row.status,
      actorId: row.actor_id,
      roleCount: row.snapshot.roles.length,
      workflowCount: row.snapshot.workflowTemplates.length,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async materializeProjectTemplate(
    input: MaterializeProjectTemplateInput,
  ): Promise<MaterializedProjectTemplate> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${input.templateId}:${input.idempotencyKey}`,
      ]);
      const receipt = await client.query<{
        request_hash: string;
        project_id: string;
        template_revision: number;
      }>(
        `SELECT request_hash, project_id, template_revision
         FROM project_template_materializations
         WHERE template_id = $1 AND idempotency_key = $2`,
        [input.templateId, input.idempotencyKey],
      );
      const existing = receipt.rows[0];
      if (existing !== undefined) {
        if (existing.request_hash !== input.requestHash) {
          throw new ProjectTemplateRepositoryError(
            "materialization_key_conflict",
            "The materialization key was already used with a different request",
          );
        }
        const project = await this.projectById(client, existing.project_id);
        return {
          project,
          created: false,
          templateRevision: existing.template_revision,
        };
      }

      const template = await this.lockProjectTemplate(
        client,
        input.templateId,
        true,
      );
      this.assertTemplateUsable(template, input);
      const snapshot = template.snapshot;
      const projectId = randomUUID();
      const projectCode =
        input.projectCode ??
        `PRJ-${projectId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      const projectDescription =
        input.projectDescription ?? snapshot.description;
      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (
           id, name, code, description, status, source_template_id,
           source_template_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW(), NOW())
         RETURNING *`,
        [
          projectId,
          input.projectName,
          projectCode,
          projectDescription,
          input.templateId,
          template.revision,
        ],
      );

      const roleIdByLibraryId = new Map<string, string>();
      const roleIdByCode = new Map<string, string>();
      for (const role of snapshot.roles) {
        const projectRoleId = randomUUID();
        await client.query(
          `INSERT INTO project_roles (
             id, project_id, code, name, category, description, permissions,
             library_role_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
          [
            projectRoleId,
            projectId,
            role.code,
            role.name,
            role.category,
            role.description,
            JSON.stringify(role.permissions),
            role.id,
          ],
        );
        roleIdByLibraryId.set(role.id, projectRoleId);
        roleIdByCode.set(role.code, projectRoleId);
      }

      let ownerRoleId =
        snapshot.ownerRoleId === null
          ? undefined
          : roleIdByLibraryId.get(snapshot.ownerRoleId);
      ownerRoleId ??= roleIdByCode.get("PROJECT_OWNER");
      if (ownerRoleId === undefined) {
        ownerRoleId = randomUUID();
        await client.query(
          `INSERT INTO project_roles (
             id, project_id, code, name, category, description, permissions,
             library_role_id, created_at, updated_at
           ) VALUES (
             $1, $2, 'PROJECT_OWNER', '项目负责人', 'management',
             '负责项目目标、范围、成员和最终验收。',
             '["read","write","approve","manage_members","manage_roles"]'::jsonb,
             NULL, NOW(), NOW()
           )`,
          [ownerRoleId, projectId],
        );
        roleIdByCode.set("PROJECT_OWNER", ownerRoleId);
      }
      const ownerMemberId = randomUUID();
      const ownerPrincipal = await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE id = $1",
        [input.actorId],
      );
      const ownerPrincipalId = ownerPrincipal.rows[0]?.id ?? null;
      if (ownerPrincipalId === null) {
        throw new ProjectTemplateRepositoryError(
          "template_forbidden",
          "Project creator Principal does not exist",
          403,
        );
      }
      await client.query(
        `INSERT INTO project_members (
           id, project_id, kind, actor_id, principal_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES (
           $1, $2, 'human', $3, $5, $4,
           '负责项目目标、范围、成员和最终验收。',
           'active', TRUE, NOW(), NOW()
         )`,
        [
          ownerMemberId,
          projectId,
          input.actorId,
          input.actorName,
          ownerPrincipalId,
        ],
      );
      await client.query(
        `INSERT INTO project_member_roles (project_member_id, role_id)
         VALUES ($1, $2)`,
        [ownerMemberId, ownerRoleId],
      );
      await this.authorization.syncProjectMemberGrantsWithClient(
        client,
        projectId,
        ownerMemberId,
        ownerPrincipalId,
      );

      for (const ref of snapshot.workflowTemplates) {
        const workflowResult = await client.query<WorkflowTemplateRow>(
          "SELECT * FROM workflow_templates WHERE id = $1",
          [ref.workflowTemplateId],
        );
        const workflow = workflowResult.rows[0];
        if (workflow === undefined) {
          throw new ProjectTemplateRepositoryError(
            "workflow_template_not_found",
            `Workflow template ${ref.name} no longer exists`,
          );
        }
        if (workflow.status !== "active") {
          throw new ProjectTemplateRepositoryError(
            "workflow_template_archived",
            `Workflow template ${workflow.name} is archived`,
          );
        }
        if (workflow.version !== ref.version) {
          throw new ProjectTemplateRepositoryError(
            "workflow_template_version_conflict",
            `Workflow template ${workflow.name} changed since the project template revision was saved`,
          );
        }
        const definition = parseWorkflowDefinition(workflow.definition);
        const steps = definition.steps.map((step) => {
          const roleId =
            step.roleCode === undefined
              ? undefined
              : roleIdByCode.get(step.roleCode);
          if (step.roleCode !== undefined && roleId === undefined) {
            throw new ProjectTemplateRepositoryError(
              "template_role_not_found",
              `Workflow role ${step.roleCode} is not part of the project template`,
              400,
              { workflowTemplateId: workflow.id, roleCode: step.roleCode },
            );
          }
          return {
            id: randomUUID(),
            name: step.name,
            kind: step.kind,
            ...(roleId === undefined ? {} : { roleId }),
          };
        });
        await client.query(
          `INSERT INTO workflow_definitions (
             id, project_id, name, description, steps, source_md, graph,
             status, source_template_id, source_template_version,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5::jsonb, '', NULL, 'active', $6, $7, NOW(), NOW()
           )`,
          [
            randomUUID(),
            projectId,
            workflow.name,
            workflow.description,
            JSON.stringify(steps),
            workflow.id,
            workflow.version,
          ],
        );
      }

      await client.query(
        `INSERT INTO project_template_materializations (
           id, template_id, template_revision, idempotency_key, request_hash,
           project_id, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          randomUUID(),
          input.templateId,
          template.revision,
          input.idempotencyKey,
          input.requestHash,
          projectId,
          input.actorId,
        ],
      );
      return {
        project: projectFromRow(projectResult.rows[0]!),
        created: true,
        templateRevision: template.revision,
      };
    });
  }

  private readonly projectTemplateSelectSql = `SELECT
    template.*,
    revision.snapshot,
    (
      SELECT COUNT(*)::integer
      FROM projects AS materialized_project
      WHERE materialized_project.source_template_id = template.id
    ) AS materialized_project_count
  FROM project_templates AS template
  JOIN project_template_revisions AS revision
    ON revision.template_id = template.id
   AND revision.revision = template.revision`;

  private async lockProjectTemplate(
    client: PoolClient,
    id: string,
    share = false,
  ): Promise<ProjectTemplateRow> {
    const result = await client.query<ProjectTemplateRow>(
      `${this.projectTemplateSelectSql}
       WHERE template.id = $1
       FOR ${share ? "SHARE" : "UPDATE"} OF template`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ProjectTemplateRepositoryError(
        "template_not_found",
        "Project template not found",
        404,
      );
    }
    return row;
  }

  private assertTemplateUsable(
    template: ProjectTemplateRow,
    input: MaterializeProjectTemplateInput,
  ): void {
    if (template.status !== "active") {
      throw new ProjectTemplateRepositoryError(
        "template_archived",
        "The project template is archived",
      );
    }
    if (
      template.snapshot.accessPolicy === "selected-members" &&
      !input.administrator &&
      !template.snapshot.allowedActorIds.includes(input.actorId)
    ) {
      throw new ProjectTemplateRepositoryError(
        "template_forbidden",
        "The actor is not allowed to use this project template",
        403,
      );
    }
  }

  private async buildSnapshot(
    client: PoolClient,
    input: CreateProjectTemplateSnapshotInput,
  ): Promise<ProjectTemplateSnapshot> {
    const roleIds = [...new Set(input.roleIds)];
    const rolesResult =
      roleIds.length === 0
        ? { rows: [] as TemplateRoleRow[] }
        : await client.query<TemplateRoleRow>(
            `SELECT *
             FROM template_roles
             WHERE id = ANY($1::uuid[])
             ORDER BY array_position($1::uuid[], id)`,
            [roleIds],
          );
    if (rolesResult.rows.length !== roleIds.length) {
      throw new ProjectTemplateRepositoryError(
        "template_role_not_found",
        "One or more template roles do not exist",
        400,
      );
    }
    if (rolesResult.rows.some((row) => row.status !== "active")) {
      throw new ProjectTemplateRepositoryError(
        "template_role_archived",
        "Archived template roles cannot be added to a project template",
        400,
      );
    }
    const roles = rolesResult.rows.map(templateRoleFromRow);
    const workflowTemplates: ProjectTemplateWorkflowRef[] = [];
    for (const ref of input.workflowTemplates) {
      const workflowResult = await client.query<WorkflowTemplateRow>(
        "SELECT * FROM workflow_templates WHERE id = $1",
        [ref.workflowTemplateId],
      );
      const workflow = workflowResult.rows[0];
      if (workflow === undefined) {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_not_found",
          "A referenced workflow template does not exist",
          400,
        );
      }
      if (workflow.status !== "active") {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_archived",
          "Archived workflow templates cannot be referenced",
          400,
        );
      }
      if (workflow.version !== ref.expectedVersion) {
        throw new ProjectTemplateRepositoryError(
          "workflow_template_version_conflict",
          "A referenced workflow template changed while saving",
        );
      }
      workflowTemplates.push({
        workflowTemplateId: workflow.id,
        key: workflow.key,
        name: workflow.name,
        version: workflow.version,
      });
    }
    const ownerRoleId = normalizeOwnerRole(input.ownerRoleId, roles);
    return {
      name: input.name,
      code: input.code,
      type: input.type,
      description: input.description,
      roles,
      ownerRoleId,
      workflowTemplates,
      accessPolicy: input.accessPolicy,
      allowedActorIds:
        input.accessPolicy === "all-members"
          ? []
          : [...new Set(input.allowedActorIds)],
    };
  }

  private async insertSnapshotRelations(
    client: PoolClient,
    templateId: string,
    snapshot: ProjectTemplateSnapshot,
  ): Promise<void> {
    for (const role of snapshot.roles) {
      await client.query(
        `INSERT INTO project_template_role_refs (template_id, role_id)
         VALUES ($1, $2)`,
        [templateId, role.id],
      );
    }
    for (const workflow of snapshot.workflowTemplates) {
      await client.query(
        `INSERT INTO project_template_workflow_refs (
           template_id, workflow_template_id, workflow_version,
           key_snapshot, name_snapshot
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          templateId,
          workflow.workflowTemplateId,
          workflow.version,
          workflow.key,
          workflow.name,
        ],
      );
    }
    for (const actorId of snapshot.allowedActorIds) {
      await client.query(
        `INSERT INTO project_template_grants (template_id, actor_id)
         VALUES ($1, $2)`,
        [templateId, actorId],
      );
    }
  }

  private async replaceTemplateRelations(
    client: PoolClient,
    templateId: string,
    snapshot: ProjectTemplateSnapshot,
  ): Promise<void> {
    await client.query(
      "DELETE FROM project_template_role_refs WHERE template_id = $1",
      [templateId],
    );
    await client.query(
      "DELETE FROM project_template_workflow_refs WHERE template_id = $1",
      [templateId],
    );
    await client.query(
      "DELETE FROM project_template_grants WHERE template_id = $1",
      [templateId],
    );
    await this.insertSnapshotRelations(client, templateId, snapshot);
  }

  private async insertRevision(
    client: PoolClient,
    templateId: string,
    revision: number,
    snapshot: ProjectTemplateSnapshot,
    changeSummary: string,
    status: ProjectTemplate["status"],
    actorId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO project_template_revisions (
         template_id, revision, snapshot, change_summary, status,
         actor_id, created_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())`,
      [
        templateId,
        revision,
        JSON.stringify(snapshot),
        changeSummary,
        status,
        actorId,
      ],
    );
  }

  private async projectById(
    client: PoolClient,
    id: string,
  ): Promise<ReturnType<typeof projectFromRow>> {
    const result = await client.query<ProjectRow>(
      "SELECT * FROM projects WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("materialized project is missing");
    }
    return projectFromRow(row);
  }

  private async roleReferences(
    client: PoolClient,
    roleId: string,
  ): Promise<{
    templateCount: number;
    templateNames: string[];
    projectRoleCount: number;
  }> {
    const templates = await client.query<{ name: string }>(
      `SELECT template.name
       FROM project_template_role_refs AS ref
       JOIN project_templates AS template ON template.id = ref.template_id
       WHERE ref.role_id = $1
       ORDER BY template.name`,
      [roleId],
    );
    const projectRoles = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM project_roles
       WHERE library_role_id = $1`,
      [roleId],
    );
    return {
      templateCount: templates.rows.length,
      templateNames: templates.rows.map((row) => row.name),
      projectRoleCount: Number(projectRoles.rows[0]?.count ?? "0"),
    };
  }
}

function templateRoleFromRow(row: TemplateRoleRow): TemplateRole {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    permissions: row.permissions,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function workflowTemplateFromRow(row: WorkflowTemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    version: row.version,
    status: row.status,
    definition: parseWorkflowDefinition(row.definition),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function projectTemplateFromRow(row: ProjectTemplateRow): ProjectTemplate {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    type: row.type,
    description: row.description,
    status: row.status,
    revision: row.revision,
    roles: [...row.snapshot.roles],
    ownerRoleId: row.snapshot.ownerRoleId,
    workflowTemplates: [...row.snapshot.workflowTemplates],
    accessPolicy: row.snapshot.accessPolicy,
    allowedActorIds: [...row.snapshot.allowedActorIds],
    materializedProjectCount: Number(row.materialized_project_count),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseWorkflowDefinition(value: unknown): WorkflowTemplateDefinition {
  return workflowTemplateDefinitionSchema.parse(value);
}

function normalizeOwnerRole(
  requestedOwnerRoleId: string | undefined,
  roles: readonly TemplateRole[],
): string | null {
  if (roles.length === 0) return null;
  if (
    requestedOwnerRoleId !== undefined &&
    roles.some((role) => role.id === requestedOwnerRoleId)
  ) {
    return requestedOwnerRoleId;
  }
  return (
    roles.find((role) => role.code === "PROJECT_OWNER")?.id ??
    roles[0]?.id ??
    null
  );
}

function revisionConflict(
  templateId: string,
  currentRevision: number,
  expectedRevision: number,
): ProjectTemplateRepositoryError {
  return new ProjectTemplateRepositoryError(
    "template_revision_conflict",
    "The project template was changed by another request",
    409,
    { templateId, currentRevision, expectedRevision },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
