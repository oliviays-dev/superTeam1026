import { randomUUID } from "node:crypto";
import type {
  CreateProjectRoleInput,
  ProjectMember,
  ProjectRole,
  UpdateProjectMemberInput,
  UpdateProjectRoleInput,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface ProjectRoleRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

interface ProjectMemberRow {
  id: string;
  project_id: string;
  kind: ProjectMember["kind"];
  actor_id: string;
  name: string;
  responsibility: string;
  status: ProjectMember["status"];
  is_owner: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ProjectMemberRoleRow extends ProjectRoleRow {
  project_member_id: string;
}

export interface ResolvedCreateProjectMemberInput {
  readonly kind: ProjectMember["kind"];
  readonly actorId: string;
  readonly name: string;
  readonly responsibility: string;
  readonly roleIds: readonly string[];
}

export type DeleteProjectRoleResult = "deleted" | "assigned" | "not_found";

export class ProjectMembershipRepository {
  constructor(private readonly database: Database) {}

  async listRoles(projectId: string): Promise<ProjectRole[]> {
    const result = await this.database.query<ProjectRoleRow>(
      `SELECT * FROM project_roles
       WHERE project_id = $1
       ORDER BY created_at, name`,
      [projectId],
    );
    return result.rows.map(projectRoleFromRow);
  }

  async createRole(
    projectId: string,
    input: CreateProjectRoleInput,
  ): Promise<ProjectRole> {
    const result = await this.database.query<ProjectRoleRow>(
      `INSERT INTO project_roles (
         id, project_id, name, description, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [randomUUID(), projectId, input.name, input.description],
    );
    return projectRoleFromRow(result.rows[0]!);
  }

  async updateRole(
    projectId: string,
    roleId: string,
    input: UpdateProjectRoleInput,
  ): Promise<ProjectRole | undefined> {
    const result = await this.database.query<ProjectRoleRow>(
      `UPDATE project_roles
       SET
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         updated_at = NOW()
       WHERE project_id = $1 AND id = $2
       RETURNING *`,
      [projectId, roleId, input.name ?? null, input.description ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectRoleFromRow(row);
  }

  async deleteRole(
    projectId: string,
    roleId: string,
  ): Promise<DeleteProjectRoleResult> {
    return this.database.transaction(async (client) => {
      const deleted = await client.query(
        `DELETE FROM project_roles AS role
         WHERE role.project_id = $1
           AND role.id = $2
           AND NOT EXISTS (
             SELECT 1
             FROM project_member_roles AS member_role
             WHERE member_role.role_id = role.id
           )
         RETURNING role.id`,
        [projectId, roleId],
      );
      if ((deleted.rowCount ?? 0) > 0) return "deleted";
      const existing = await client.query(
        "SELECT 1 FROM project_roles WHERE project_id = $1 AND id = $2",
        [projectId, roleId],
      );
      return existing.rowCount === 1 ? "assigned" : "not_found";
    });
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const members = await this.database.query<ProjectMemberRow>(
      `SELECT * FROM project_members
       WHERE project_id = $1
       ORDER BY is_owner DESC, created_at, name`,
      [projectId],
    );
    const roleRows = await this.database.query<ProjectMemberRoleRow>(
      `SELECT
         member_role.project_member_id,
         role.*
       FROM project_member_roles AS member_role
       JOIN project_roles AS role ON role.id = member_role.role_id
       JOIN project_members AS member ON member.id = member_role.project_member_id
       WHERE member.project_id = $1
       ORDER BY role.created_at, role.name`,
      [projectId],
    );
    const rolesByMember = new Map<string, ProjectRole[]>();
    for (const row of roleRows.rows) {
      const roles = rolesByMember.get(row.project_member_id) ?? [];
      roles.push(projectRoleFromRow(row));
      rolesByMember.set(row.project_member_id, roles);
    }
    return members.rows.map((row) =>
      projectMemberFromRow(row, rolesByMember.get(row.id) ?? []),
    );
  }

  async getMember(
    projectId: string,
    memberId: string,
  ): Promise<ProjectMember | undefined> {
    const members = await this.listMembers(projectId);
    return members.find((member) => member.id === memberId);
  }

  async createMember(
    projectId: string,
    input: ResolvedCreateProjectMemberInput,
  ): Promise<ProjectMember> {
    const memberId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO project_members (
           id, project_id, kind, actor_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', FALSE, NOW(), NOW())`,
        [
          memberId,
          projectId,
          input.kind,
          input.actorId,
          input.name,
          input.responsibility,
        ],
      );
      await this.replaceMemberRoles(client, projectId, memberId, input.roleIds);
    });
    const member = await this.getMember(projectId, memberId);
    if (member === undefined) throw new Error("created project member missing");
    return member;
  }

  async updateMember(
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberInput,
  ): Promise<ProjectMember | undefined> {
    const updated = await this.database.transaction(async (client) => {
      const result = await client.query<ProjectMemberRow>(
        `UPDATE project_members
         SET
           name = COALESCE($3, name),
           responsibility = COALESCE($4, responsibility),
           status = COALESCE($5, status),
           updated_at = NOW()
         WHERE project_id = $1 AND id = $2
         RETURNING *`,
        [
          projectId,
          memberId,
          input.name ?? null,
          input.responsibility ?? null,
          input.status ?? null,
        ],
      );
      if (result.rowCount === 0) return false;
      if (input.roleIds !== undefined) {
        await this.replaceMemberRoles(
          client,
          projectId,
          memberId,
          input.roleIds,
        );
      }
      return true;
    });
    return updated ? this.getMember(projectId, memberId) : undefined;
  }

  async deleteMember(projectId: string, memberId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM project_members
       WHERE project_id = $1 AND id = $2
       RETURNING id`,
      [projectId, memberId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async replaceMemberRoles(
    client: PoolClient,
    projectId: string,
    memberId: string,
    roleIds: readonly string[],
  ): Promise<void> {
    await client.query(
      "DELETE FROM project_member_roles WHERE project_member_id = $1",
      [memberId],
    );
    if (roleIds.length === 0) return;
    const result = await client.query(
      `INSERT INTO project_member_roles (project_member_id, role_id)
       SELECT $2, role.id
       FROM project_roles AS role
       WHERE role.project_id = $1
         AND role.id = ANY($3::uuid[])`,
      [projectId, memberId, [...roleIds]],
    );
    if ((result.rowCount ?? 0) !== roleIds.length) {
      throw new Error("project role scope mismatch");
    }
  }
}

function projectRoleFromRow(row: ProjectRoleRow): ProjectRole {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function projectMemberFromRow(
  row: ProjectMemberRow,
  roles: readonly ProjectRole[],
): ProjectMember {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    actorId: row.actor_id,
    name: row.name,
    responsibility: row.responsibility,
    status: row.status,
    owner: row.is_owner,
    roles: [...roles],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
