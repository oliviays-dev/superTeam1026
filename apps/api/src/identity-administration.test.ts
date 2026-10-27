import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, IdentityRepository, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("identity administration API", () => {
  let database: Database;
  let administrativeDatabase: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let adminToken: string;
  let adminPrincipalId: string;
  let adminAccountId: string;
  const schema = `batch20a_${randomUUID().replaceAll("-", "")}`;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    administrativeDatabase = new Database(databaseUrl!);
    await administrativeDatabase.query(`CREATE SCHEMA ${schema}`);
    const separator = databaseUrl!.includes("?") ? "&" : "?";
    const isolatedUrl = `${databaseUrl!}${separator}options=${encodeURIComponent(
      `-c search_path=${schema}`,
    )}`;
    database = new Database(isolatedUrl);
    await migrate(database);
    const tempRoot = resolve(process.cwd(), ".tmp", "batch20a-identity-admin");
    await mkdir(tempRoot, { recursive: true });
    const fileStoreRoot = await mkdtemp(join(tempRoot, "files-"));
    adminPrincipalId = `principal-human-identity-admin-${suffix}`;
    adminAccountId = `account-identity-admin-${suffix}`;
    await new IdentityRepository(database).bootstrapAdministrator({
      principalId: adminPrincipalId,
      accountId: adminAccountId,
      loginId: `identity-admin-${suffix}`,
      displayName: "Identity Admin",
      password: "identity-admin-password",
    });
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      authMode: "bearer",
      expectedMigrationVersion: 32,
    });
    app = built.app;
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: `identity-admin-${suffix}`,
        password: "identity-admin-password",
      },
    });
    expect(login.statusCode).toBe(200);
    adminToken = login.json().token as string;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
    await administrativeDatabase.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrativeDatabase.close();
  });

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  async function invite(loginId: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: auth(adminToken),
      payload: {
        loginId,
        displayName: `Member ${loginId}`,
        credential: { mode: "invitation", expiresInSeconds: 3_600 },
      },
    });
  }

  async function activate(token: string, password: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/credential-activations",
      payload: { token, password },
    });
  }

  it("creates pending accounts, activates once, paginates, and rejects duplicates", async () => {
    const loginId = `invitee-${suffix}`;
    const created = await invite(loginId);
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.account).toMatchObject({
      loginId,
      status: "pending",
      credentialStatus: "pending",
      principalKind: "human",
    });
    expect(createdBody.activation.activationToken).toHaveLength(43);
    const activationToken = createdBody.activation.activationToken as string;
    const principalId = createdBody.account.principalId as string;
    const accountId = createdBody.account.id as string;

    const stored = await database.query<{
      id: string;
      secret_hash: string;
      token_is_plaintext: boolean;
    }>(
      `SELECT id, secret_hash, secret_hash = $2 AS token_is_plaintext
       FROM account_credentials
       WHERE account_id = $1`,
      [accountId, activationToken],
    );
    expect(stored.rows[0]?.token_is_plaintext).toBe(false);
    expect(stored.rows[0]?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    const leakedAudit = await database.query<{ leaked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM identity_audit_events
         WHERE subject_principal_id = $1
           AND (metadata::text LIKE $2 OR reason LIKE $2)
       ) AS leaked`,
      [principalId, `%${activationToken}%`],
    );
    expect(leakedAudit.rows[0]?.leaked).toBe(false);

    const duplicatePrincipal = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: auth(adminToken),
      payload: {
        principalId,
        loginId: `other-${suffix}`,
        displayName: "Duplicate Principal",
        credential: { mode: "password", password: "another-password" },
      },
    });
    expect(duplicatePrincipal.statusCode).toBe(409);
    expect(duplicatePrincipal.json().code).toBe("account_exists");

    const duplicateLogin = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: auth(adminToken),
      payload: {
        loginId: loginId.toUpperCase(),
        displayName: "Duplicate Login",
        credential: { mode: "password", password: "another-password" },
      },
    });
    expect(duplicateLogin.statusCode).toBe(409);
    expect(duplicateLogin.json().code).toBe("login_id_conflict");

    const activation = await activate(activationToken, "member-password-1");
    expect(activation.statusCode).toBe(204);
    const replay = await activate(activationToken, "member-password-2");
    expect(replay.statusCode).toBe(400);
    expect(replay.json().code).toBe("credential_activation_invalid");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId, password: "member-password-1" },
    });
    expect(login.statusCode).toBe(200);

    const page = await app.inject({
      method: "GET",
      url: `/api/v1/admin/accounts?query=${encodeURIComponent(loginId)}&limit=1`,
      headers: auth(adminToken),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      items: [{ id: accountId, status: "active" }],
      total: 1,
    });

    const existingPrincipalId = `principal-existing-${suffix}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Existing Member', 'active', 'account',
                 'account', 1, NOW(), NOW())`,
      [existingPrincipalId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, 'platform', 'platform', 'MEMBER',
         '["platform.access"]'::jsonb, 'active', 'manual',
         'existing-member', $3, NULL, NOW(), NULL, NULL, 1, NOW(), NOW()
       )`,
      [randomUUID(), existingPrincipalId, adminPrincipalId],
    );
    const existingAccount = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: auth(adminToken),
      payload: {
        principalId: existingPrincipalId,
        loginId: `existing-${suffix}`,
        displayName: "Existing Member",
        credential: { mode: "password", password: "existing-password" },
      },
    });
    expect(existingAccount.statusCode).toBe(201);
    const memberGrants = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type = 'platform'
         AND role_key = 'MEMBER'
         AND status = 'active'`,
      [existingPrincipalId],
    );
    expect(memberGrants.rows[0]?.count).toBe(1);
  });

  it("updates profiles, rejects stale versions, and securely resets credentials", async () => {
    const loginId = `profile-${suffix}`;
    const created = await invite(loginId);
    const body = created.json();
    const accountId = body.account.id as string;
    const activationToken = body.activation.activationToken as string;
    expect(
      await activate(activationToken, "profile-password-1"),
    ).toHaveProperty("statusCode", 204);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId, password: "profile-password-1" },
    });
    const memberToken = login.json().token as string;
    const current = await app.inject({
      method: "GET",
      url: `/api/v1/admin/accounts/${accountId}`,
      headers: auth(adminToken),
    });
    expect(current.statusCode).toBe(200);
    const currentVersion = current.json().version as number;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${accountId}`,
      headers: auth(adminToken),
      payload: {
        loginId: `${loginId}-renamed`,
        displayName: "Renamed Member",
        expectedVersion: currentVersion,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      loginId: `${loginId}-renamed`,
      displayName: "Renamed Member",
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/accounts/${accountId}`,
      headers: auth(adminToken),
      payload: {
        displayName: "Stale Update",
        expectedVersion: currentVersion,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("version_conflict");

    const reset = await app.inject({
      method: "POST",
      url: `/api/v1/admin/accounts/${accountId}/credential`,
      headers: auth(adminToken),
      payload: { expiresInSeconds: 3_600, reason: "lost_password" },
    });
    expect(reset.statusCode).toBe(200);
    const resetToken = reset.json().activationToken as string;
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(memberToken),
    });
    expect(revoked.statusCode).toBe(401);
    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: `${loginId}-renamed`,
        password: "profile-password-1",
      },
    });
    expect(oldPassword.statusCode).toBe(401);
    expect(await activate(resetToken, "profile-password-2")).toHaveProperty(
      "statusCode",
      204,
    );
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: `${loginId}-renamed`,
        password: "profile-password-2",
      },
    });
    expect(newPassword.statusCode).toBe(200);
    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/status`,
      headers: auth(adminToken),
      payload: { status: "disabled" },
    });
    expect(disabled.statusCode).toBe(200);
    const disabledReset = await app.inject({
      method: "POST",
      url: `/api/v1/admin/accounts/${accountId}/credential`,
      headers: auth(adminToken),
      payload: { expiresInSeconds: 3_600, reason: "disabled_reset" },
    });
    expect(disabledReset.statusCode).toBe(409);
    expect(disabledReset.json().code).toBe("account_disabled");
    const repeatedDisable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${accountId}/status`,
      headers: auth(adminToken),
      payload: { status: "disabled" },
    });
    expect(repeatedDisable.statusCode).toBe(200);
    expect(repeatedDisable.json()).toMatchObject({
      accountStatus: "disabled",
      sessionsRevoked: 0,
    });
  });

  it("creates, expires, renews, and revokes platform Grants with stable conflicts", async () => {
    const ownGrants = await app.inject({
      method: "GET",
      url: `/api/v1/admin/platform-grants?principalId=${encodeURIComponent(adminPrincipalId)}&status=active`,
      headers: auth(adminToken),
    });
    const ownAdminGrant = ownGrants
      .json()
      .items.find((grant: { roleKey: string }) => grant.roleKey === "ADMIN");
    const lastAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/admin/platform-grants/${ownAdminGrant.id}/revoke`,
      headers: auth(adminToken),
      payload: {
        expectedVersion: ownAdminGrant.version,
        reason: "last_admin_guard",
      },
    });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().code).toBe("last_platform_admin");
    const lastAdminDisable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${adminAccountId}/status`,
      headers: auth(adminToken),
      payload: { status: "disabled" },
    });
    expect(lastAdminDisable.statusCode).toBe(409);
    expect(lastAdminDisable.json().code).toBe("last_platform_admin");
    const lastAdminReset = await app.inject({
      method: "POST",
      url: `/api/v1/admin/accounts/${adminAccountId}/credential`,
      headers: auth(adminToken),
      payload: { expiresInSeconds: 3_600, reason: "last_admin_reset" },
    });
    expect(lastAdminReset.statusCode).toBe(409);
    expect(lastAdminReset.json().code).toBe("last_platform_admin");

    const loginId = `grants-${suffix}`;
    const created = await invite(loginId);
    const principalId = created.json().account.principalId as string;
    const grant = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-grants",
      headers: auth(adminToken),
      payload: {
        principalId,
        roleKey: "ADMIN",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(grant.statusCode).toBe(201);
    const grantBody = grant.json();
    expect(grantBody).toMatchObject({
      principalId,
      roleKey: "ADMIN",
      status: "active",
      version: 1,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-grants",
      headers: auth(adminToken),
      payload: { principalId, roleKey: "ADMIN", expiresAt: null },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("grant_exists");

    const renewedExpiry = new Date(Date.now() + 7_200_000).toISOString();
    const renewed = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/platform-grants/${grantBody.id}/expiry`,
      headers: auth(adminToken),
      payload: { expiresAt: renewedExpiry, expectedVersion: 1 },
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({
      expiresAt: renewedExpiry,
      version: 2,
    });
    const staleRenewal = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/platform-grants/${grantBody.id}/expiry`,
      headers: auth(adminToken),
      payload: { expiresAt: null, expectedVersion: 1 },
    });
    expect(staleRenewal.statusCode).toBe(409);
    expect(staleRenewal.json().code).toBe("version_conflict");

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/admin/platform-grants/${grantBody.id}/revoke`,
      headers: auth(adminToken),
      payload: { expectedVersion: 2, reason: "test_cleanup" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "revoked", version: 3 });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/platform-grants/${grantBody.id}/revoke`,
      headers: auth(adminToken),
      payload: { expectedVersion: 3, reason: "repeat" },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().code).toBe("grant_not_active");

    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/platform-roles",
      headers: auth(adminToken),
    });
    expect(roles.statusCode).toBe(200);
    expect(roles.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ADMIN",
          activeGrantCount: expect.any(Number),
        }),
        expect.objectContaining({
          key: "MEMBER",
          activeGrantCount: expect.any(Number),
        }),
      ]),
    );

    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Archived Principal', 'archived',
                 'legacy', 'local', 1, NOW(), NOW())`,
      [`principal-archived-${suffix}`],
    );
    const archivedGrant = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-grants",
      headers: auth(adminToken),
      payload: {
        principalId: `principal-archived-${suffix}`,
        roleKey: "MEMBER",
        expiresAt: null,
      },
    });
    expect(archivedGrant.statusCode).toBe(409);
    expect(archivedGrant.json().code).toBe("principal_archived");

    const expiring = await app.inject({
      method: "POST",
      url: "/api/v1/admin/platform-grants",
      headers: auth(adminToken),
      payload: {
        principalId,
        roleKey: "ADMIN",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(expiring.statusCode).toBe(201);
    await database.query(
      `UPDATE role_grants
       SET granted_at = NOW() - INTERVAL '2 hours',
           expires_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [expiring.json().id],
    );
    const expired = await app.inject({
      method: "GET",
      url: `/api/v1/admin/platform-grants?principalId=${encodeURIComponent(principalId)}&status=expired`,
      headers: auth(adminToken),
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expiring.json().id,
          status: "expired",
        }),
      ]),
    );
  });

  it("manages Workspace membership and Grants with immediate revocation", async () => {
    const workspaceCreated = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: auth(adminToken),
      payload: { displayName: `Workspace ${suffix}` },
    });
    expect(workspaceCreated.statusCode).toBe(201);
    const workspaceBody = workspaceCreated.json();
    const workspaceId = workspaceBody.workspace.id as string;
    expect(workspaceBody.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: adminPrincipalId,
          status: "active",
          grants: [expect.objectContaining({ roleKey: "ADMIN" })],
        }),
      ]),
    );

    const ownAdminGrant = workspaceBody.grants.find(
      (grant: { principalId: string; roleKey: string }) =>
        grant.principalId === adminPrincipalId && grant.roleKey === "ADMIN",
    );
    const lastAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/grants/${ownAdminGrant.id}/revoke`,
      headers: auth(adminToken),
      payload: {
        expectedVersion: ownAdminGrant.version,
        reason: "last_admin_test",
      },
    });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().code).toBe("last_workspace_admin");

    const loginId = `workspace-member-${suffix}`;
    const invited = await invite(loginId);
    const memberPrincipalId = invited.json().account.principalId as string;
    const activationToken = invited.json().activation.activationToken as string;
    await activate(activationToken, "workspace-password");
    const memberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId, password: "workspace-password" },
    });
    const memberToken = memberLogin.json().token as string;

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: auth(adminToken),
      payload: { principalId: memberPrincipalId },
    });
    expect(added.statusCode).toBe(201);
    const repeatedMember = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: auth(adminToken),
      payload: { principalId: memberPrincipalId },
    });
    expect(repeatedMember.statusCode).toBe(409);
    expect(repeatedMember.json().code).toBe("membership_exists");

    const memberGrant = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/grants`,
      headers: auth(adminToken),
      payload: {
        principalId: memberPrincipalId,
        roleKey: "MEMBER",
        expiresAt: null,
      },
    });
    expect(memberGrant.statusCode).toBe(201);
    const memberGrantBody = memberGrant.json();
    expect(memberGrantBody.permissions).toEqual(["read"]);
    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}`,
      headers: auth(memberToken),
    });
    expect(readable.statusCode).toBe(200);

    const updatedExpiry = new Date(Date.now() + 7_200_000).toISOString();
    const renewedGrant = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/grants/${memberGrantBody.id}/expiry`,
      headers: auth(adminToken),
      payload: { expiresAt: updatedExpiry, expectedVersion: 1 },
    });
    expect(renewedGrant.statusCode).toBe(200);
    expect(renewedGrant.json()).toMatchObject({
      expiresAt: updatedExpiry,
      version: 2,
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/grants/${memberGrantBody.id}/revoke`,
      headers: auth(adminToken),
      payload: { expectedVersion: 2, reason: "access_revoked" },
    });
    expect(revoked.statusCode).toBe(200);
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}`,
      headers: auth(memberToken),
    });
    expect(denied.statusCode).toBe(403);
    const adminStillReads = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}`,
      headers: auth(adminToken),
    });
    expect(adminStillReads.statusCode).toBe(200);
  });

  it("keeps duplicate and concurrent identity writes deterministic", async () => {
    const loginId = `concurrent-${suffix}`;
    const responses = await Promise.all([invite(loginId), invite(loginId)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(["account_exists", "login_id_conflict"]).toContain(
      conflict?.json().code,
    );

    const created = responses.find((response) => response.statusCode === 201)!;
    const principalId = created.json().account.principalId as string;
    const grants = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/admin/platform-grants",
          headers: auth(adminToken),
          payload: { principalId, roleKey: "ADMIN", expiresAt: null },
        }),
      ),
    );
    expect(grants.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
  });

  it("fails closed for non-admin account administration", async () => {
    const loginId = `non-admin-${suffix}`;
    const created = await invite(loginId);
    const activationToken = created.json().activation.activationToken as string;
    await activate(activationToken, "non-admin-password");
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId, password: "non-admin-password" },
    });
    const directory = await app.inject({
      method: "GET",
      url: "/api/v1/admin/accounts",
      headers: auth(login.json().token as string),
    });
    expect(directory.statusCode).toBe(403);
  });
});
