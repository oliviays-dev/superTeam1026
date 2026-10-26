import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Database,
  IdentityRepository,
  hashIdentityPassword,
  migrate,
} from "../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const fixturePath = process.env.RBAC_E2E_FIXTURE_PATH;
if (databaseUrl === undefined || fixturePath === undefined) {
  throw new Error("DATABASE_URL and RBAC_E2E_FIXTURE_PATH are required");
}

const stamp = randomUUID().slice(0, 8);
const password = `rbac-e2e-password-${stamp}`;
const database = new Database(databaseUrl);

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
}

async function createMemberAccount(label: string): Promise<AccountFixture> {
  const principalId = `principal-human-${label}-${stamp}`;
  const accountId = `account-${label}-${stamp}`;
  const loginId = `${label}-${stamp}`;
  await database.query(
    `INSERT INTO principals (
       id, kind, display_name, status, status_authority, source,
       version, created_at, updated_at
     ) VALUES ($1, 'human', $2, 'active', 'account', 'account',
               1, NOW(), NOW())`,
    [principalId, `${label} E2E Principal`],
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
       status, expires_at, last_authenticated_at, version, created_at, updated_at
     ) VALUES ($1, $2, 'password', 'scrypt', $3, 'active',
               NULL, NULL, 1, NOW(), NOW())`,
    [randomUUID(), accountId, await hashIdentityPassword(password)],
  );
  await database.query(
    `INSERT INTO role_grants (
       id, principal_id, scope_type, scope_id, role_key, permissions,
       status, source_kind, source_ref, granted_at, version, created_at, updated_at
     ) VALUES (
       $1, $2, 'platform', 'platform', 'MEMBER',
       '["platform.access"]'::jsonb, 'active', 'manual',
       'batch14c-e2e', NOW(), 1, NOW(), NOW()
     )`,
    [randomUUID(), principalId],
  );
  return { principalId, accountId, loginId };
}

try {
  await migrate(database);
  await new IdentityRepository(database).bootstrapAdministrator({
    principalId: `principal-human-admin-${stamp}`,
    accountId: `account-admin-${stamp}`,
    loginId: `admin-${stamp}`,
    displayName: "RBAC E2E Admin",
    password,
  });
  const admin = {
    principalId: `principal-human-admin-${stamp}`,
    accountId: `account-admin-${stamp}`,
    loginId: `admin-${stamp}`,
  };
  const owner = await createMemberAccount("owner");
  const member = await createMemberAccount("member");
  const outsider = await createMemberAccount("outsider");
  await mkdir(dirname(fixturePath), { recursive: true });
  await writeFile(
    fixturePath,
    `${JSON.stringify({ password, admin, owner, member, outsider }, null, 2)}\n`,
    "utf8",
  );
} finally {
  await database.close();
}
