import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthorizationRepository,
  AuthorizationRepositoryError,
} from "./authorization-repository.js";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { ProjectMembershipRepository } from "./project-membership-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("authorization repository", () => {
  let database: Database;
  let authorization: AuthorizationRepository;
  let memberships: ProjectMembershipRepository;
  let suffix: string;
  let adminPrincipalId: string;
  let ownerPrincipalId: string;
  let memberPrincipalId: string;
  let outsiderPrincipalId: string;
  let aiPrincipalId: string;
  let adminAccountId: string;
  let memberAccountId: string;
  let projectId: string;
  let otherProjectId: string;
  let workspaceId: string;
  let memberId: string;
  let writeRoleId: string;

  async function insertPrincipal(input: {
    readonly id: string;
    readonly kind: "human" | "ai";
    readonly status?: "active" | "suspended" | "archived";
  }): Promise<void> {
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW())`,
      [
        input.id,
        input.kind,
        `Authorization ${input.kind} ${suffix}`,
        input.status ?? "active",
        input.kind === "ai" ? "ai-companion" : "account",
        input.kind === "ai" ? "ai-companion" : "account",
      ],
    );
  }

  async function insertAccount(
    accountId: string,
    principalId: string,
    status: "active" | "pending" | "disabled" = "active",
  ): Promise<void> {
    await database.query(
      `INSERT INTO accounts (
         id, principal_id, login_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 1, NOW(), NOW())`,
      [accountId, principalId, `${accountId}@authorization.test`, status],
    );
  }

  async function insertProject(id: string, label: string): Promise<void> {
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, $2, $3, '', 'active', NOW(), NOW())`,
      [id, `Authorization ${label}`, `AUTH-${label}-${suffix}`],
    );
  }

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    authorization = new AuthorizationRepository(database);
    memberships = new ProjectMembershipRepository(database, authorization);
    suffix = randomUUID().slice(0, 8);
    adminPrincipalId = `principal-human-admin-${suffix}`;
    ownerPrincipalId = `principal-human-owner-${suffix}`;
    memberPrincipalId = `principal-human-member-${suffix}`;
    outsiderPrincipalId = `principal-human-outsider-${suffix}`;
    aiPrincipalId = `principal-ai-member-${suffix}`;
    adminAccountId = `account-admin-${suffix}`;
    memberAccountId = `account-member-${suffix}`;
    projectId = randomUUID();
    otherProjectId = randomUUID();
    workspaceId = `workspace-${suffix}`;

    await insertPrincipal({
      id: adminPrincipalId,
      kind: "human",
    });
    await insertPrincipal({
      id: ownerPrincipalId,
      kind: "human",
    });
    await insertPrincipal({
      id: memberPrincipalId,
      kind: "human",
    });
    await insertPrincipal({
      id: outsiderPrincipalId,
      kind: "human",
    });
    await insertPrincipal({
      id: aiPrincipalId,
      kind: "ai",
    });
    await insertAccount(adminAccountId, adminPrincipalId);
    await insertAccount(memberAccountId, memberPrincipalId);
    await insertProject(projectId, "primary");
    await insertProject(otherProjectId, "other");
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'platform', 'platform', 'ADMIN', '[]'::jsonb,
         'active', 'manual', 'authorization-test', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), adminPrincipalId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
      [randomUUID(), workspaceId, memberPrincipalId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'workspace', $3, 'member', '["read","write"]'::jsonb,
         'active', 'manual', 'authorization-test', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), memberPrincipalId, workspaceId],
    );

    const ownerRole = await memberships.createRole(projectId, {
      code: "PROJECT_OWNER",
      name: `Owner ${suffix}`,
      description: "Authorization fixture owner",
      permissions: [
        "read",
        "write",
        "approve",
        "manage_members",
        "manage_roles",
      ],
    });
    const writeRole = await memberships.createRole(projectId, {
      code: `WRITER_${suffix.toUpperCase()}`,
      name: `Writer ${suffix}`,
      description: "Authorization fixture writer",
      permissions: ["read", "write"],
    });
    writeRoleId = writeRole.id;
    await memberships.createMember(
      projectId,
      {
        kind: "human",
        actorId: ownerPrincipalId,
        principalId: ownerPrincipalId,
        name: "Project Owner",
        responsibility: "Owns the fixture",
        roleIds: [ownerRole.id],
      },
      ownerPrincipalId,
    );
    const member = await memberships.createMember(
      projectId,
      {
        kind: "human",
        actorId: memberPrincipalId,
        principalId: memberPrincipalId,
        name: "Project Writer",
        responsibility: "Writes fixtures",
        roleIds: [writeRole.id],
      },
      ownerPrincipalId,
    );
    memberId = member.id;
  });

  afterAll(async () => {
    await database.close();
  });

  it("keeps platform ADMIN out of project scope", async () => {
    await expect(
      authorization.authorizePlatform({
        principalId: adminPrincipalId,
        authSource: "bearer",
      }),
    ).resolves.toMatchObject({ allowed: true, grantSource: "grant" });
    await expect(
      authorization.authorizeProject({
        principalId: adminPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "membership_missing",
      scopeType: "project",
    });
  });

  it("consumes workspace membership and grant as a separate scope", async () => {
    await expect(
      authorization.authorizeWorkspace({
        principalId: memberPrincipalId,
        authSource: "bearer",
        workspaceId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      scopeType: "workspace",
      effectivePermissions: expect.arrayContaining(["read", "write"]),
    });
    await expect(
      authorization.authorizeWorkspace({
        principalId: memberPrincipalId,
        authSource: "bearer",
        workspaceId: `${workspaceId}-other`,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "workspace_membership_missing",
    });
    await database.query(
      `UPDATE workspace_members
       SET status = 'inactive', updated_at = NOW()
       WHERE workspace_id = $1 AND principal_id = $2`,
      [workspaceId, memberPrincipalId],
    );
    await expect(
      authorization.authorizeWorkspace({
        principalId: memberPrincipalId,
        authSource: "bearer",
        workspaceId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "workspace_membership_inactive",
    });
    await database.query(
      `UPDATE workspace_members
       SET status = 'active', updated_at = NOW()
       WHERE workspace_id = $1 AND principal_id = $2`,
      [workspaceId, memberPrincipalId],
    );
  });

  it("makes project role permission updates effective immediately", async () => {
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({ allowed: true, grantSource: "grant" });

    await memberships.updateRole(
      projectId,
      writeRoleId,
      { permissions: ["read"] },
      ownerPrincipalId,
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "permission_missing",
    });
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "read",
      }),
    ).resolves.toMatchObject({ allowed: true });

    await memberships.updateRole(
      projectId,
      writeRoleId,
      { permissions: ["read", "write"] },
      ownerPrincipalId,
    );
  });

  it("revokes project write immediately after role removal", async () => {
    await memberships.updateMember(
      projectId,
      memberId,
      { roleIds: [] },
      ownerPrincipalId,
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "grant_missing",
    });
    const audit = await database.query<{ decision: string; reason: string }>(
      `SELECT decision, reason
       FROM identity_audit_events
       WHERE subject_principal_id = $1
         AND action LIKE 'authorization.project_grant.%'
       ORDER BY created_at DESC`,
      [memberPrincipalId],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decision: "allowed" }),
      ]),
    );
    await memberships.updateMember(
      projectId,
      memberId,
      { roleIds: [writeRoleId] },
      ownerPrincipalId,
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      grantSource: "grant",
    });
    const grants = await database.query<{
      status: string;
      count: string;
    }>(
      `SELECT status, COUNT(*)::text AS count
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'project'
         AND scope_id = $2
         AND role_key = $3
       GROUP BY status
       ORDER BY status`,
      [memberPrincipalId, projectId, `project-role:${writeRoleId}`],
    );
    expect(grants.rows).toEqual(
      expect.arrayContaining([
        { status: "active", count: "1" },
        { status: "revoked", count: "1" },
      ]),
    );
    await database.query(
      `UPDATE project_members
       SET status = 'inactive', updated_at = NOW()
       WHERE project_id = $1 AND id = $2`,
      [projectId, memberId],
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "membership_inactive",
    });
    await database.query(
      `UPDATE project_members
       SET status = 'active', updated_at = NOW()
       WHERE project_id = $1 AND id = $2`,
      [projectId, memberId],
    );
  });

  it("rejects cross-project, disabled-account and archived-Principal access", async () => {
    await memberships.createMember(
      otherProjectId,
      {
        kind: "human",
        actorId: memberPrincipalId,
        principalId: memberPrincipalId,
        name: "Other project member",
        responsibility: "Scope isolation",
        roleIds: [],
      },
      ownerPrincipalId,
    );
    await expect(
      authorization.authorizeProject({
        principalId: outsiderPrincipalId,
        authSource: "local-development",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({ reason: "membership_missing" });

    await database.query(
      "UPDATE accounts SET status = 'disabled', updated_at = NOW() WHERE id = $1",
      [memberAccountId],
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "read",
      }),
    ).resolves.toMatchObject({ reason: "account_not_active" });

    await database.query(
      "UPDATE principals SET status = 'archived', updated_at = NOW() WHERE id = $1",
      [memberPrincipalId],
    );
    await expect(
      authorization.authorizeProject({
        principalId: memberPrincipalId,
        authSource: "local-development",
        projectId,
        permission: "read",
      }),
    ).resolves.toMatchObject({ reason: "principal_not_active" });
  });

  it("applies the same explicit project Grant model to AI Principals", async () => {
    await expect(
      authorization.authorizeProject({
        principalId: aiPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "membership_missing",
    });
    await memberships.createMember(
      projectId,
      {
        kind: "agent",
        actorId: aiPrincipalId,
        principalId: aiPrincipalId,
        name: "AI Writer",
        responsibility: "AI project member",
        roleIds: [writeRoleId],
      },
      ownerPrincipalId,
    );
    await expect(
      authorization.authorizeProject({
        principalId: aiPrincipalId,
        authSource: "bearer",
        projectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      grantSource: "grant",
    });
    await memberships.createMember(
      otherProjectId,
      {
        kind: "agent",
        actorId: aiPrincipalId,
        principalId: aiPrincipalId,
        name: "AI Other Project",
        responsibility: "Expired grant fixture",
        roleIds: [],
      },
      ownerPrincipalId,
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, expires_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'project', $3, 'EXPIRED_WRITER', '["read","write"]'::jsonb,
         'active', 'manual', 'authorization-test-expired',
         NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', 1, NOW(), NOW()
       )`,
      [randomUUID(), aiPrincipalId, otherProjectId],
    );
    await expect(
      authorization.authorizeProject({
        principalId: aiPrincipalId,
        authSource: "bearer",
        projectId: otherProjectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "grant_missing",
    });
    await expect(
      authorization.authorizePlatform({
        principalId: aiPrincipalId,
        authSource: "bearer",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("uses legacy owner compatibility only until an explicit owner Grant exists", async () => {
    const legacyProjectId = randomUUID();
    const legacyMemberId = randomUUID();
    const legacyPrincipalId = `principal-human-legacy-${suffix}`;
    await insertPrincipal({ id: legacyPrincipalId, kind: "human" });
    await insertProject(legacyProjectId, `legacy-${suffix}`);
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, principal_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES ($1, $2, 'human', $3, NULL, 'Legacy Owner', '', 'active',
                 TRUE, NOW(), NOW())`,
      [legacyMemberId, legacyProjectId, legacyPrincipalId],
    );
    await expect(
      authorization.authorizeProject({
        principalId: legacyPrincipalId,
        authSource: "local-development",
        projectId: legacyProjectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      grantSource: "legacy-owner",
      ownerSources: {
        legacy: true,
        grant: false,
        consistent: false,
      },
    });
    const report =
      await authorization.getProjectAuthorizationReport(legacyProjectId);
    expect(report).toMatchObject({
      consistent: false,
      ownerPrincipalIds: {
        legacy: [legacyPrincipalId],
        grant: [],
      },
    });

    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, revoked_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'project', $3, 'PROJECT_OWNER',
         '["read","write","approve","manage_members","manage_roles"]'::jsonb,
         'revoked', 'project-role', $4, NOW() - INTERVAL '1 day',
         NOW(), 1, NOW(), NOW()
       )`,
      [
        randomUUID(),
        legacyPrincipalId,
        legacyProjectId,
        `project-member:${legacyMemberId}:owner`,
      ],
    );
    await expect(
      authorization.authorizeProject({
        principalId: legacyPrincipalId,
        authSource: "local-development",
        projectId: legacyProjectId,
        permission: "write",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "grant_missing",
    });
  });

  it("resolves bare aliases uniquely and reports ambiguity", async () => {
    const firstPrincipalId = `principal-human-alias-a-${suffix}`;
    const secondPrincipalId = `principal-human-alias-b-${suffix}`;
    await insertPrincipal({ id: firstPrincipalId, kind: "human" });
    await insertPrincipal({ id: secondPrincipalId, kind: "human" });
    await database.query(
      `INSERT INTO principal_aliases (
         id, principal_id, alias_type, alias_value, status, created_at, updated_at
       ) VALUES
         ($1, $2, 'auth-user', $4, 'active', NOW(), NOW()),
         ($3, $5, 'legacy-actor', $4, 'active', NOW(), NOW())`,
      [
        randomUUID(),
        firstPrincipalId,
        randomUUID(),
        `shared-alias-${suffix}`,
        secondPrincipalId,
      ],
    );
    await expect(
      authorization.resolvePrincipalReference(`shared-alias-${suffix}`),
    ).rejects.toBeInstanceOf(AuthorizationRepositoryError);
    await expect(
      authorization.resolvePrincipalReference(
        `auth-user:shared-alias-${suffix}`,
      ),
    ).resolves.toMatchObject({
      principal: { id: firstPrincipalId },
      resolvedBy: "auth-user",
    });
  });
});
