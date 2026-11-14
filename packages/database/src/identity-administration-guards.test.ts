import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Database } from "./database.js";
import { isUsablePlatformAdmin } from "./identity-admin-guards.js";
import { IdentityAdministrationRepository } from "./identity-administration-repository.js";
import { IdentityRepository } from "./identity-repository.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("identity administration guards", () => {
  let database: Database;
  let administrativeDatabase: Database;
  let identity: IdentityRepository;
  let administration: IdentityAdministrationRepository;
  let schema: string;

  beforeAll(async () => {
    administrativeDatabase = new Database(databaseUrl!);
  });

  beforeEach(async () => {
    schema = `identity_guards_${randomUUID().replaceAll("-", "")}`;
    await administrativeDatabase.query(`CREATE SCHEMA ${schema}`);
    const separator = databaseUrl!.includes("?") ? "&" : "?";
    database = new Database(
      `${databaseUrl!}${separator}options=${encodeURIComponent(
        `-c search_path=${schema}`,
      )}`,
    );
    await migrate(database);
    identity = new IdentityRepository(database);
    administration = new IdentityAdministrationRepository(database);
  });

  afterEach(async () => {
    await database.close();
    await administrativeDatabase.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  afterAll(async () => {
    await administrativeDatabase.close();
  });

  async function bootstrapAdmin(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const principalId = `principal-${label}-${suffix}`;
    const accountId = `account-${label}-${suffix}`;
    await identity.bootstrapAdministrator({
      principalId,
      accountId,
      loginId: `${label}-${suffix}`,
      displayName: label,
      password: `${label}-password`,
    });
    return { principalId, accountId };
  }

  async function createMember(label: string, actorPrincipalId: string) {
    const suffix = randomUUID().slice(0, 8);
    const result = await administration.createAccount(actorPrincipalId, {
      loginId: `${label}-${suffix}`,
      displayName: label,
      credential: {
        mode: "password",
        password: `${label}-password`,
      },
    });
    return {
      accountId: result.account.id,
      principalId: result.account.principalId,
    };
  }

  it("counts only login-capable human platform administrators", async () => {
    const primary = await bootstrapAdmin("usable-primary");
    const secondary = await bootstrapAdmin("usable-secondary");
    const aiPrincipalId = `principal-ai-admin-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES (
         $1, 'ai', 'AI Platform Admin', 'active', 'ai-companion',
         'ai-companion', 1, NOW(), NOW()
       )`,
      [aiPrincipalId],
    );
    await administration.createPlatformGrant(primary.principalId, {
      principalId: aiPrincipalId,
      roleKey: "ADMIN",
      expiresAt: null,
    });

    await administration.issueCredentialActivation(
      primary.principalId,
      secondary.accountId,
      {
        expiresInSeconds: 3_600,
        reason: "test_pending_admin_credential",
      },
    );
    const usable = await database.query<{ count: number }>(
      `SELECT COUNT(DISTINCT grant_row.principal_id)::int AS count
       FROM role_grants AS grant_row
       JOIN principals AS principal
         ON principal.id = grant_row.principal_id
       JOIN accounts AS account
         ON account.principal_id = principal.id
       JOIN account_credentials AS credential
         ON credential.account_id = account.id
        AND credential.credential_type = 'password'
        AND credential.status = 'active'
        AND credential.secret_scheme = 'scrypt'
       WHERE grant_row.scope_type = 'platform'
         AND grant_row.scope_id = 'platform'
         AND grant_row.role_key = 'ADMIN'
         AND grant_row.status = 'active'
         AND principal.kind = 'human'
         AND principal.status = 'active'
         AND account.status = 'active'`,
    );
    expect(usable.rows[0]?.count).toBe(1);

    await expect(
      administration.issueCredentialActivation(
        secondary.principalId,
        primary.accountId,
        {
          expiresInSeconds: 3_600,
          reason: "test_last_usable_admin",
        },
      ),
    ).rejects.toMatchObject({ code: "last_platform_admin" });
    await expect(
      identity.setAccountStatus(secondary.principalId, primary.accountId, {
        status: "disabled",
      }),
    ).rejects.toMatchObject({ code: "last_platform_admin" });
  });

  it("serializes concurrent platform administrator revocations", async () => {
    const first = await bootstrapAdmin("platform-race-first");
    const second = await bootstrapAdmin("platform-race-second");
    const grants = await database.query<{
      id: string;
      principal_id: string;
      version: number;
    }>(
      `SELECT id, principal_id, version
       FROM role_grants
       WHERE principal_id = ANY($1::text[])
         AND scope_type = 'platform'
         AND role_key = 'ADMIN'
         AND status = 'active'`,
      [[first.principalId, second.principalId]],
    );
    const firstGrant = grants.rows.find(
      (grant) => grant.principal_id === first.principalId,
    )!;
    const secondGrant = grants.rows.find(
      (grant) => grant.principal_id === second.principalId,
    )!;
    await expect(
      database.transaction((client) =>
        isUsablePlatformAdmin(
          client,
          first.principalId,
          new Date(),
          firstGrant.id,
        ),
      ),
    ).resolves.toBe(true);
    await expect(
      database.transaction((client) =>
        isUsablePlatformAdmin(
          client,
          second.principalId,
          new Date(),
          secondGrant.id,
        ),
      ),
    ).resolves.toBe(true);

    const results = await Promise.allSettled([
      administration.revokePlatformGrant(first.principalId, secondGrant.id, {
        expectedVersion: secondGrant.version,
        reason: "concurrent_revoke",
      }),
      administration.revokePlatformGrant(second.principalId, firstGrant.id, {
        expectedVersion: firstGrant.version,
        reason: "concurrent_revoke",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "last_platform_admin" },
    });
    const remaining = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM role_grants
       WHERE principal_id = ANY($1::text[])
         AND scope_type = 'platform'
         AND role_key = 'ADMIN'
         AND status = 'active'`,
      [[first.principalId, second.principalId]],
    );
    expect(remaining.rows[0]?.count).toBe(1);
  });

  it("serializes concurrent platform administrator account disables", async () => {
    const first = await bootstrapAdmin("platform-disable-first");
    const second = await bootstrapAdmin("platform-disable-second");

    const results = await Promise.allSettled([
      identity.setAccountStatus(first.principalId, second.accountId, {
        status: "disabled",
      }),
      identity.setAccountStatus(second.principalId, first.accountId, {
        status: "disabled",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "last_platform_admin" },
    });
    const remaining = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM accounts
       WHERE id = ANY($1::text[])
         AND status = 'active'`,
      [[first.accountId, second.accountId]],
    );
    expect(remaining.rows[0]?.count).toBe(1);
  });

  it("rejects new Workspace Grants for archived Principals", async () => {
    const accountCreator = await bootstrapAdmin("grant-account-creator");
    const actor = await createMember("grant-actor", accountCreator.principalId);
    const member = await createMember(
      "archived-grantee",
      accountCreator.principalId,
    );
    const workspace = await administration.createWorkspace(actor.principalId, {
      displayName: "Archived grantee Workspace",
    });
    await administration.addWorkspaceMember(
      actor.principalId,
      workspace.workspace.id,
      { principalId: member.principalId },
    );
    await database.query(
      `UPDATE principals
       SET status = 'archived',
           updated_at = GREATEST(updated_at, created_at, NOW()),
           version = version + 1
       WHERE id = $1`,
      [member.principalId],
    );

    await expect(
      administration.createWorkspaceGrant(
        actor.principalId,
        workspace.workspace.id,
        {
          principalId: member.principalId,
          roleKey: "MEMBER",
          expiresAt: null,
        },
      ),
    ).rejects.toMatchObject({ code: "principal_archived" });
    const archivedMember = (await administration.getWorkspace(
      workspace.workspace.id,
    ))!.members.find((item) => item.principalId === member.principalId)!;
    const inactiveWorkspace = await administration.updateWorkspaceMemberStatus(
      actor.principalId,
      workspace.workspace.id,
      archivedMember.id,
      { status: "inactive", expectedVersion: archivedMember.version },
    );
    const inactiveMember = inactiveWorkspace.members.find(
      (item) => item.principalId === member.principalId,
    )!;
    await expect(
      administration.updateWorkspaceMemberStatus(
        actor.principalId,
        workspace.workspace.id,
        inactiveMember.id,
        { status: "active", expectedVersion: inactiveMember.version },
      ),
    ).rejects.toMatchObject({ code: "principal_archived" });
  });

  it("serializes Workspace admin removal and ignores unusable admins", async () => {
    const accountCreator = await bootstrapAdmin("workspace-account-creator");
    const first = await createMember(
      "workspace-race-first",
      accountCreator.principalId,
    );
    const second = await createMember(
      "workspace-race-second",
      accountCreator.principalId,
    );
    const workspace = await administration.createWorkspace(first.principalId, {
      displayName: "Workspace admin race",
    });
    await administration.addWorkspaceMember(
      first.principalId,
      workspace.workspace.id,
      { principalId: second.principalId },
    );
    await administration.createWorkspaceGrant(
      first.principalId,
      workspace.workspace.id,
      {
        principalId: second.principalId,
        roleKey: "ADMIN",
        expiresAt: null,
      },
    );
    const detail = await administration.getWorkspace(workspace.workspace.id);
    const firstGrant = detail!.grants.find(
      (grant) =>
        grant.principalId === first.principalId && grant.roleKey === "ADMIN",
    )!;
    const secondGrant = detail!.grants.find(
      (grant) =>
        grant.principalId === second.principalId && grant.roleKey === "ADMIN",
    )!;

    const results = await Promise.allSettled([
      administration.revokeWorkspaceGrant(
        first.principalId,
        workspace.workspace.id,
        secondGrant.id,
        {
          expectedVersion: secondGrant.version,
          reason: "concurrent_workspace_revoke",
        },
      ),
      administration.revokeWorkspaceGrant(
        second.principalId,
        workspace.workspace.id,
        firstGrant.id,
        {
          expectedVersion: firstGrant.version,
          reason: "concurrent_workspace_revoke",
        },
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "last_workspace_admin" },
    });
    const afterRace = await administration.getWorkspace(workspace.workspace.id);
    expect(
      afterRace!.grants.filter(
        (grant) => grant.roleKey === "ADMIN" && grant.status === "active",
      ),
    ).toHaveLength(1);
    const remainingAdminGrant = afterRace!.grants.find(
      (grant) => grant.roleKey === "ADMIN" && grant.status === "active",
    )!;
    const remainingAdminMember = afterRace!.members.find(
      (member) => member.principalId === remainingAdminGrant.principalId,
    )!;
    await expect(
      administration.updateWorkspaceMemberStatus(
        first.principalId,
        workspace.workspace.id,
        remainingAdminMember.id,
        {
          status: "inactive",
          expectedVersion: remainingAdminMember.version,
        },
      ),
    ).rejects.toMatchObject({ code: "last_workspace_admin" });

    const pendingOwner = await createMember(
      "workspace-pending-owner",
      accountCreator.principalId,
    );
    const pendingPeer = await createMember(
      "workspace-pending-peer",
      accountCreator.principalId,
    );
    const pendingWorkspace = await administration.createWorkspace(
      pendingOwner.principalId,
      { displayName: "Workspace pending admin" },
    );
    await administration.addWorkspaceMember(
      pendingOwner.principalId,
      pendingWorkspace.workspace.id,
      { principalId: pendingPeer.principalId },
    );
    await administration.createWorkspaceGrant(
      pendingOwner.principalId,
      pendingWorkspace.workspace.id,
      {
        principalId: pendingPeer.principalId,
        roleKey: "ADMIN",
        expiresAt: null,
      },
    );
    const pendingDetail = await administration.getWorkspace(
      pendingWorkspace.workspace.id,
    );
    const ownerGrant = pendingDetail!.grants.find(
      (grant) =>
        grant.principalId === pendingOwner.principalId &&
        grant.roleKey === "ADMIN",
    )!;
    const peerMember = pendingDetail!.members.find(
      (member) => member.principalId === pendingPeer.principalId,
    )!;
    await administration.issueCredentialActivation(
      pendingOwner.principalId,
      pendingPeer.accountId,
      {
        expiresInSeconds: 3_600,
        reason: "test_pending_workspace_admin",
      },
    );

    await expect(
      administration.revokeWorkspaceGrant(
        pendingPeer.principalId,
        pendingWorkspace.workspace.id,
        ownerGrant.id,
        {
          expectedVersion: ownerGrant.version,
          reason: "pending_admin_is_not_usable",
        },
      ),
    ).rejects.toMatchObject({ code: "last_workspace_admin" });
    await expect(
      administration.updateWorkspaceMemberStatus(
        pendingOwner.principalId,
        pendingWorkspace.workspace.id,
        peerMember.id,
        { status: "inactive", expectedVersion: peerMember.version },
      ),
    ).resolves.toBeDefined();
  });
});
