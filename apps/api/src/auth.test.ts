import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
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

integration("bearer authentication API", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let adminToken: string;
  let adminAccountId: string;
  let adminPrincipalId: string;
  let memberToken: string;
  let memberAccountId: string;
  let memberPrincipalId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const tempRoot = resolve(process.cwd(), ".tmp", "batch14b-auth-api");
    await mkdir(tempRoot, { recursive: true });
    const fileStoreRoot = await mkdtemp(join(tempRoot, "files-"));
    const suffix = randomUUID().slice(0, 8);
    adminPrincipalId = `principal-human-admin-${suffix}`;
    adminAccountId = `account-admin-${suffix}`;
    const memberHash = await hashIdentityPassword("member-password");
    memberPrincipalId = `principal-human-member-${suffix}`;
    memberAccountId = `account-member-${suffix}`;
    const identity = new IdentityRepository(database);
    await identity.bootstrapAdministrator({
      principalId: adminPrincipalId,
      accountId: adminAccountId,
      loginId: `admin-${suffix}`,
      displayName: "Admin",
      password: "admin-password",
    });
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Member', 'active', 'account', 'account',
                 1, NOW(), NOW())`,
      [memberPrincipalId],
    );
    await database.query(
      `INSERT INTO accounts (
         id, principal_id, login_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [memberAccountId, memberPrincipalId, `member-${suffix}`],
    );
    await database.query(
      `INSERT INTO account_credentials (
         id, account_id, credential_type, secret_scheme, secret_hash,
         status, expires_at, last_authenticated_at, version,
         created_at, updated_at
       ) VALUES ($1, $2, 'password', 'scrypt', $3, 'active',
                 NULL, NULL, 1, NOW(), NOW())`,
      [randomUUID(), memberAccountId, memberHash],
    );

    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      authMode: "bearer",
      expectedMigrationVersion: 29,
    });
    app = built.app;
    await app.ready();
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId: `admin-${suffix}`, password: "admin-password" },
    });
    expect(adminLogin.statusCode).toBe(200);
    adminToken = adminLogin.json().token as string;
    const memberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { loginId: `member-${suffix}`, password: "member-password" },
    });
    expect(memberLogin.statusCode).toBe(200);
    memberToken = memberLogin.json().token as string;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  it("fails closed without a Bearer session and ignores spoofed trusted headers", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
    });
    expect(unauthenticated.statusCode).toBe(401);
    const spoofed = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: {
        "x-pluginmax-actor": adminPrincipalId,
        "x-pluginmax-authenticated-actor": adminPrincipalId,
        "x-pluginmax-authenticated-admin": "1",
      },
    });
    expect(spoofed.statusCode).toBe(401);
    const health = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(health.statusCode).toBe(200);
  });

  it("returns only the authenticated Principal and rejects non-admin account management", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(memberToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      principalId: memberPrincipalId,
      accountId: memberAccountId,
      kind: "human",
      platformAdministrator: false,
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${adminAccountId}/status`,
      headers: auth(memberToken),
      payload: { status: "disabled" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("revokes a disabled account immediately and permits an explicit re-enable", async () => {
    const disable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${memberAccountId}/status`,
      headers: auth(adminToken),
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({
      accountId: memberAccountId,
      principalId: memberPrincipalId,
      accountStatus: "disabled",
      principalStatus: "suspended",
    });
    const rejected = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(memberToken),
    });
    expect(rejected.statusCode).toBe(401);
    const enable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${memberAccountId}/status`,
      headers: auth(adminToken),
      payload: { status: "active" },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({
      accountStatus: "active",
      principalStatus: "active",
    });
  });

  it("changes password without invalidating the current session, then logout revokes it", async () => {
    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: auth(adminToken),
      payload: {
        currentPassword: "admin-password",
        newPassword: "new-admin-password",
      },
    });
    expect(changed.statusCode).toBe(204);
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(adminToken),
    });
    expect(current.statusCode).toBe(200);
    const loggedOut = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: auth(adminToken),
    });
    expect(loggedOut.statusCode).toBe(204);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: auth(adminToken),
    });
    expect(revoked.statusCode).toBe(401);
  });
});
