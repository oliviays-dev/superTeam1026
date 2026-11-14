import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Database,
  IdentityAdministrationRepository,
  IdentityRepository,
  migrate,
} from "../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const fixturePath = process.env.RBAC_E2E_FIXTURE_PATH;
const password = process.env.CORE_REGRESSION_PASSWORD;
if (
  databaseUrl === undefined ||
  fixturePath === undefined ||
  password === undefined
) {
  throw new Error(
    "DATABASE_URL, RBAC_E2E_FIXTURE_PATH and CORE_REGRESSION_PASSWORD are required",
  );
}

const stamp = randomUUID().slice(0, 8);
const database = new Database(databaseUrl);
const identity = new IdentityRepository(database);
const administration = new IdentityAdministrationRepository(database);

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
  readonly displayName: string;
}

async function createAdmin(label: string): Promise<AccountFixture> {
  const principalId = `principal-human-${label}-${stamp}`;
  const accountId = `account-${label}-${stamp}`;
  const loginId = `${label}-${stamp}`;
  const displayName = `${label} Core Regression`;
  await identity.bootstrapAdministrator({
    principalId,
    accountId,
    loginId,
    displayName,
    password,
  });
  return { principalId, accountId, loginId, displayName };
}

async function createAccount(label: string): Promise<AccountFixture> {
  const loginId = `${label}-${stamp}`;
  const displayName = `${label} Core Regression`;
  const created = await administration.createAccount(admin.principalId, {
    loginId,
    displayName,
    credential: { mode: "password", password },
  });
  return {
    principalId: created.account.principalId,
    accountId: created.account.id,
    loginId,
    displayName,
  };
}

let admin!: AccountFixture;

try {
  await migrate(database);
  admin = await createAdmin("admin");
  const secondAdmin = await createAdmin("admin-b");
  const owner = await createAccount("owner");
  const member = await createAccount("member");
  const outsider = await createAccount("outsider");
  const workspaceAdmin = await createAccount("workspace-admin");
  const expiredGrant = await createAccount("expired-grant");
  const disabled = await createAccount("disabled");
  const archived = await createAccount("archived");

  const pendingLoginId = `pending-${stamp}`;
  const pendingCreated = await administration.createAccount(admin.principalId, {
    loginId: pendingLoginId,
    displayName: "Pending Core Regression",
    credential: { mode: "invitation", expiresInSeconds: 3_600 },
  });
  const pending: AccountFixture = {
    principalId: pendingCreated.account.principalId,
    accountId: pendingCreated.account.id,
    loginId: pendingLoginId,
    displayName: "Pending Core Regression",
  };

  const adminAiPrincipalId = `principal-ai-admin-${stamp}`;
  await database.query(
    `INSERT INTO principals (
       id, kind, display_name, status, status_authority, source,
       version, created_at, updated_at
     ) VALUES (
       $1, 'ai', 'AI Platform Admin', 'active', 'ai-companion',
       'ai-companion', 1, NOW(), NOW()
     )`,
    [adminAiPrincipalId],
  );
  await administration.createPlatformGrant(admin.principalId, {
    principalId: adminAiPrincipalId,
    roleKey: "ADMIN",
    expiresAt: null,
  });

  const workspaceA = await administration.createWorkspace(admin.principalId, {
    displayName: "Core Regression Workspace A",
  });
  const workspaceB = await administration.createWorkspace(admin.principalId, {
    displayName: "Core Regression Workspace B",
  });
  for (const account of [
    owner,
    member,
    outsider,
    workspaceAdmin,
    expiredGrant,
  ]) {
    await administration.addWorkspaceMember(
      admin.principalId,
      workspaceA.workspace.id,
      { principalId: account.principalId },
    );
  }
  await administration.addWorkspaceMember(
    admin.principalId,
    workspaceB.workspace.id,
    { principalId: outsider.principalId },
  );
  await administration.createWorkspaceGrant(
    admin.principalId,
    workspaceA.workspace.id,
    {
      principalId: workspaceAdmin.principalId,
      roleKey: "ADMIN",
      expiresAt: null,
    },
  );

  const revokedGrant = await administration.createWorkspaceGrant(
    admin.principalId,
    workspaceA.workspace.id,
    {
      principalId: outsider.principalId,
      roleKey: "MEMBER",
      expiresAt: null,
    },
  );
  await administration.revokeWorkspaceGrant(
    admin.principalId,
    workspaceA.workspace.id,
    revokedGrant.id,
    {
      expectedVersion: revokedGrant.version,
      reason: "core_regression_revoked_fixture",
    },
  );
  const expiringGrant = await administration.createWorkspaceGrant(
    admin.principalId,
    workspaceA.workspace.id,
    {
      principalId: expiredGrant.principalId,
      roleKey: "MEMBER",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  );
  await database.query(
    `UPDATE role_grants
     SET status = 'expired',
         granted_at = created_at - INTERVAL '2 hours',
         expires_at = created_at - INTERVAL '1 hour',
         updated_at = GREATEST(updated_at, created_at, NOW())
     WHERE id = $1`,
    [expiringGrant.id],
  );

  await identity.setAccountStatus(admin.principalId, disabled.accountId, {
    status: "disabled",
  });
  await database.transaction(async (client) => {
    await client.query(
      `UPDATE principals
       SET status = 'archived', updated_at = NOW(), version = version + 1
       WHERE id = $1`,
      [archived.principalId],
    );
    await client.query(
      `UPDATE accounts
       SET status = 'disabled', updated_at = NOW(), version = version + 1
       WHERE id = $1`,
      [archived.accountId],
    );
    await client.query(
      `UPDATE account_credentials
       SET status = 'disabled', updated_at = NOW(), version = version + 1
       WHERE account_id = $1`,
      [archived.accountId],
    );
  });

  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(
    fixturePath,
    `${JSON.stringify(
      {
        runId: stamp,
        admin,
        secondAdmin,
        owner,
        member,
        outsider,
        workspaceAdmin,
        pending,
        disabled,
        archived,
        expiredGrant,
        adminAi: { principalId: adminAiPrincipalId },
        workspaces: {
          a: workspaceA.workspace.id,
          b: workspaceB.workspace.id,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
} finally {
  await database.close();
}
