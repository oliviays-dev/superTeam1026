import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  IdentityRepository,
  hashIdentityPassword,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
  readonly password: string;
}

integration("RBAC authorization API", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let suffix: string;
  let adminToken: string;
  let ownerToken: string;
  let memberToken: string;
  let outsiderToken: string;
  let adminAccountId: string;
  let member: AccountFixture;
  let outsider: AccountFixture;
  let projectId: string;
  let otherProjectId: string;
  let memberId: string;
  let writerRoleId: string;

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  async function insertAccountFixture(label: string): Promise<AccountFixture> {
    const principalId = `principal-human-${label}-${suffix}`;
    const accountId = `account-${label}-${suffix}`;
    const loginId = `${label}-${suffix}`;
    const password = `${label}-password-${suffix}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', $2, 'active', 'account', 'account',
                 1, NOW(), NOW())`,
      [principalId, `${label} Principal`],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'platform', 'platform', 'MEMBER',
         '["platform.access"]'::jsonb, 'active', 'manual',
         'rbac-api-test', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), principalId],
    );
    await database.query(
      `INSERT INTO accounts (
         id, principal_id, login_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [accountId, principalId, loginId],
    );
    await database.query(
      `INSERT INTO account_credentials (
         id, account_id, credential_type, secret_scheme, secret_hash,
         status, expires_at, last_authenticated_at, version,
         created_at, updated_at
       ) VALUES ($1, $2, 'password', 'scrypt', $3, 'active',
                 NULL, NULL, 1, NOW(), NOW())`,
      [randomUUID(), accountId, await hashIdentityPassword(password)],
    );
    return { principalId, accountId, loginId, password };
  }

  async function login(fixture: AccountFixture): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: fixture.loginId,
        password: fixture.password,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  }

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    suffix = randomUUID().slice(0, 8);
    adminAccountId = `account-admin-${suffix}`;
    const identity = new IdentityRepository(database);
    await identity.bootstrapAdministrator({
      principalId: `principal-human-admin-${suffix}`,
      accountId: adminAccountId,
      loginId: `admin-${suffix}`,
      displayName: "RBAC Admin",
      password: `admin-password-${suffix}`,
    });
    member = await insertAccountFixture("member");
    outsider = await insertAccountFixture("outsider");
    const owner = await insertAccountFixture("owner");
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-rbac-api-")),
      logger: false,
      authMode: "bearer",
      expectedMigrationVersion: 30,
    });
    app = built.app;
    await app.ready();
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: `admin-${suffix}`,
        password: `admin-password-${suffix}`,
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    adminToken = adminLogin.json().token as string;
    ownerToken = await login(owner);
    memberToken = await login(member);
    outsiderToken = await login(outsider);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("ignores forged trusted headers and platform ADMIN cannot bypass projects", async () => {
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${member.accountId}/status`,
      headers: {
        ...auth(memberToken),
        "x-pluginmax-actor": "principal-human-admin-forged",
        "x-pluginmax-authenticated-actor": "principal-human-admin-forged",
        "x-pluginmax-authenticated-admin": "1",
      },
      payload: { status: "disabled" },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({
      code: "forbidden",
      details: { permission: "platform.manage" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth(ownerToken),
      payload: {
        name: `RBAC project ${suffix}`,
        description: "Project authorization fixture",
      },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id as string;

    const adminProjectWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(adminToken),
      payload: { description: "platform admin must not bypass" },
    });
    expect(adminProjectWrite.statusCode).toBe(403);
    expect(adminProjectWrite.json()).toMatchObject({
      code: "forbidden",
      details: {
        reason: "membership_missing",
        scopeType: "project",
      },
    });
  });

  it("enforces no-membership, cross-project and project permission boundaries", async () => {
    const noMembership = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(outsiderToken),
      payload: { description: "outsider write" },
    });
    expect(noMembership.statusCode).toBe(403);
    expect(noMembership.json()).toMatchObject({
      details: { reason: "membership_missing" },
    });

    const role = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/roles`,
      headers: auth(ownerToken),
      payload: {
        code: "WRITER",
        name: `Writer ${suffix}`,
        category: "execution",
        description: "Can write project data",
        permissions: ["read", "write"],
      },
    });
    expect(role.statusCode).toBe(201);
    writerRoleId = role.json().id as string;

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      headers: auth(ownerToken),
      payload: {
        kind: "human",
        actorId: member.principalId,
        name: "RBAC Member",
        responsibility: "Writes project data",
        roleIds: [writerRoleId],
      },
    });
    expect(added.statusCode).toBe(201);
    memberId = added.json().id as string;
    expect(added.json()).toMatchObject({
      principalId: member.principalId,
      owner: false,
    });

    const allowedWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(memberToken),
      payload: { description: "member write allowed" },
    });
    expect(allowedWrite.statusCode).toBe(200);

    const deniedRoleManagement = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/roles`,
      headers: auth(memberToken),
      payload: {
        name: `Denied ${suffix}`,
        description: "No manage_roles",
        permissions: ["read"],
      },
    });
    expect(deniedRoleManagement.statusCode).toBe(403);
    expect(deniedRoleManagement.json()).toMatchObject({
      details: { reason: "permission_missing" },
    });

    const secondProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth(ownerToken),
      payload: {
        name: `RBAC other ${suffix}`,
        description: "Cross-project fixture",
      },
    });
    expect(secondProject.statusCode).toBe(201);
    otherProjectId = secondProject.json().id as string;
    const crossProject = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${otherProjectId}`,
      headers: auth(memberToken),
      payload: { description: "cross-project write" },
    });
    expect(crossProject.statusCode).toBe(403);
    expect(crossProject.json()).toMatchObject({
      details: { reason: "membership_missing" },
    });
  });

  it("applies role permission changes and Grant revocation to subsequent writes", async () => {
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/roles/${writerRoleId}`,
      headers: auth(ownerToken),
      payload: { permissions: ["read"] },
    });
    expect(changed.statusCode).toBe(200);
    const deniedWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(memberToken),
      payload: { description: "write after permission reduction" },
    });
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.json()).toMatchObject({
      details: { reason: "permission_missing" },
    });

    const report = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/authorization-report`,
      headers: auth(memberToken),
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      projectId,
      consistent: true,
    });

    const restore = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/roles/${writerRoleId}`,
      headers: auth(ownerToken),
      payload: { permissions: ["read", "write"] },
    });
    expect(restore.statusCode).toBe(200);
    const revoked = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${memberId}`,
      headers: auth(ownerToken),
      payload: { roleIds: [] },
    });
    expect(revoked.statusCode).toBe(200);
    const deniedAfterRevoke = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(memberToken),
      payload: { description: "write after revoke" },
    });
    expect(deniedAfterRevoke.statusCode).toBe(403);
    expect(deniedAfterRevoke.json()).toMatchObject({
      details: { reason: "grant_missing" },
    });

    const audits = await database.query<{
      action: string;
      decision: string;
      reason: string;
    }>(
      `SELECT action, decision, reason
       FROM identity_audit_events
       WHERE actor_principal_id = $1
          OR subject_principal_id = $2
       ORDER BY created_at DESC`,
      [member.principalId, member.principalId],
    );
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "authorization.project_grant.updated",
          decision: "allowed",
        }),
        expect.objectContaining({
          action: "authorization.project_grant.revoked",
          decision: "allowed",
        }),
        expect.objectContaining({
          action: expect.stringContaining("authorization.http.patch"),
          decision: "denied",
          reason: "grant_missing",
        }),
      ]),
    );
  });

  it("uses write and manage_members grants for former owner-only project paths", async () => {
    const restoreWriter = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${memberId}`,
      headers: auth(ownerToken),
      payload: { roleIds: [writerRoleId] },
    });
    expect(restoreWriter.statusCode).toBe(200);

    const memory = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/memory/topics`,
      headers: auth(memberToken),
      payload: { title: "Member-authored memory" },
    });
    expect(memory.statusCode).toBe(201);

    const meeting = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      headers: auth(memberToken),
      payload: {
        projectId,
        title: "Member-authored meeting",
        agenda: "Write grant must be sufficient",
        agentIds: [],
      },
    });
    expect(meeting.statusCode).toBe(201);

    const agent = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: auth(ownerToken),
      payload: {
        name: `Transfer target ${suffix}`,
        runtimeKind: "fake",
      },
    });
    expect(agent.statusCode).toBe(201);
    const agentMember = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/members`,
      headers: auth(ownerToken),
      payload: {
        kind: "agent",
        agentId: agent.json().id,
        responsibility: "Transfer target",
        roleIds: [],
      },
    });
    expect(agentMember.statusCode).toBe(201);
    const task = await app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: auth(ownerToken),
      payload: {
        projectId,
        title: "Member-manager transfer",
        description: "Manage-members transfer target",
      },
    });
    expect(task.statusCode).toBe(201);

    const deniedTransfer = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.json().id}/transfer`,
      headers: auth(memberToken),
      payload: { agentId: agent.json().id },
    });
    expect(deniedTransfer.statusCode).toBe(403);
    expect(deniedTransfer.json()).toMatchObject({
      details: { permission: "manage_members" },
    });

    const managerRole = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/roles`,
      headers: auth(ownerToken),
      payload: {
        code: "MEMBER_MANAGER",
        name: `Member manager ${suffix}`,
        permissions: ["read", "write", "manage_members"],
      },
    });
    expect(managerRole.statusCode).toBe(201);
    const grantManagement = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/members/${memberId}`,
      headers: auth(ownerToken),
      payload: { roleIds: [writerRoleId, managerRole.json().id] },
    });
    expect(grantManagement.statusCode).toBe(200);

    const transferred = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.json().id}/transfer`,
      headers: auth(memberToken),
      payload: { agentId: agent.json().id },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({
      task: { id: task.json().id, agentId: agent.json().id },
    });
  });

  it("rejects disabled accounts and archived Principals before project authorization", async () => {
    const disable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${member.accountId}/status`,
      headers: auth(adminToken),
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    const disabledSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(memberToken),
    });
    expect(disabledSession.statusCode).toBe(401);

    await database.query(
      `UPDATE principals
       SET status = 'archived', status_authority = 'hrm', updated_at = NOW()
       WHERE id = $1`,
      [outsider.principalId],
    );
    const archived = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(outsiderToken),
    });
    expect(archived.statusCode).toBe(401);

    const audit = await database.query<{ decision: string; reason: string }>(
      `SELECT decision, reason
       FROM identity_audit_events
       WHERE action = 'auth.login' AND decision = 'allowed'
         AND subject_principal_id = $1
       LIMIT 1`,
      [member.principalId],
    );
    expect(audit.rows[0]).toMatchObject({ decision: "allowed" });
    expect(adminAccountId).toMatch(/^account-admin-/);
    expect(otherProjectId).toBeTruthy();
  });
});
