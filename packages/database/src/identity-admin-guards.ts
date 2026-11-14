import type { PoolClient } from "pg";

const PLATFORM_ADMIN_MUTATION_LOCK_KEY =
  "pluginmax:identity:platform-admin-mutation";
const WORKSPACE_ADMIN_MUTATION_LOCK_PREFIX =
  "pluginmax:identity:workspace-admin-mutation:";

export async function lockPlatformAdminMutations(
  client: PoolClient,
): Promise<void> {
  await client.query(
    `SELECT id
     FROM role_grants
     WHERE scope_type = 'platform'
       AND scope_id = 'platform'
       AND role_key = 'ADMIN'
       AND status = 'active'
     ORDER BY id
     FOR UPDATE`,
  );
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    PLATFORM_ADMIN_MUTATION_LOCK_KEY,
  ]);
}

export async function lockWorkspaceAdminMutations(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query(
    `SELECT id
     FROM role_grants
     WHERE scope_type = 'workspace'
       AND scope_id = $1
       AND role_key = 'ADMIN'
       AND status = 'active'
     ORDER BY id
     FOR UPDATE`,
    [workspaceId],
  );
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${WORKSPACE_ADMIN_MUTATION_LOCK_PREFIX}${workspaceId}`,
  ]);
}

interface PlatformAdminCountInput {
  readonly now: Date;
  readonly excludePrincipalId?: string | undefined;
  readonly excludeGrantId?: string | undefined;
}

interface WorkspaceAdminCountInput {
  readonly workspaceId: string;
  readonly now: Date;
  readonly excludePrincipalId?: string | undefined;
  readonly excludeGrantId?: string | undefined;
}

async function countUsablePlatformAdmins(
  client: PoolClient,
  input: PlatformAdminCountInput,
): Promise<number> {
  const result = await client.query<{ count: number }>(
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
       AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $1)
       AND principal.kind = 'human'
       AND principal.status = 'active'
       AND account.status = 'active'
       AND ($2::text IS NULL OR grant_row.principal_id <> $2)
       AND ($3::uuid IS NULL OR grant_row.id <> $3)`,
    [input.now, input.excludePrincipalId ?? null, input.excludeGrantId ?? null],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function isUsablePlatformAdmin(
  client: PoolClient,
  principalId: string,
  now: Date,
  grantId?: string,
): Promise<boolean> {
  const result = await client.query<{ count: number }>(
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
     WHERE grant_row.principal_id = $1
       AND ($2::uuid IS NULL OR grant_row.id = $2)
       AND grant_row.scope_type = 'platform'
       AND grant_row.scope_id = 'platform'
       AND grant_row.role_key = 'ADMIN'
       AND grant_row.status = 'active'
       AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $3)
       AND principal.kind = 'human'
       AND principal.status = 'active'
       AND account.status = 'active'`,
    [principalId, grantId ?? null, now],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function countOtherUsablePlatformAdmins(
  client: PoolClient,
  principalId: string,
  now: Date,
  excludeGrantId?: string,
): Promise<number> {
  return countUsablePlatformAdmins(client, {
    now,
    excludePrincipalId: principalId,
    excludeGrantId,
  });
}

async function countUsableWorkspaceAdmins(
  client: PoolClient,
  input: WorkspaceAdminCountInput,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(DISTINCT grant_row.principal_id)::int AS count
     FROM workspace_members AS member
     JOIN role_grants AS grant_row
       ON grant_row.principal_id = member.principal_id
      AND grant_row.scope_type = 'workspace'
      AND grant_row.scope_id = member.workspace_id
     JOIN principals AS principal
       ON principal.id = member.principal_id
     JOIN accounts AS account
       ON account.principal_id = principal.id
     JOIN account_credentials AS credential
       ON credential.account_id = account.id
      AND credential.credential_type = 'password'
      AND credential.status = 'active'
      AND credential.secret_scheme = 'scrypt'
     WHERE member.workspace_id = $1
       AND member.status = 'active'
       AND grant_row.role_key = 'ADMIN'
       AND grant_row.status = 'active'
       AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $2)
       AND principal.kind = 'human'
       AND principal.status = 'active'
       AND account.status = 'active'
       AND ($3::text IS NULL OR grant_row.principal_id <> $3)
       AND ($4::uuid IS NULL OR grant_row.id <> $4)`,
    [
      input.workspaceId,
      input.now,
      input.excludePrincipalId ?? null,
      input.excludeGrantId ?? null,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function isUsableWorkspaceAdmin(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  now: Date,
  grantId?: string,
): Promise<boolean> {
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(DISTINCT grant_row.principal_id)::int AS count
     FROM workspace_members AS member
     JOIN role_grants AS grant_row
       ON grant_row.principal_id = member.principal_id
      AND grant_row.scope_type = 'workspace'
      AND grant_row.scope_id = member.workspace_id
     JOIN principals AS principal
       ON principal.id = member.principal_id
     JOIN accounts AS account
       ON account.principal_id = principal.id
     JOIN account_credentials AS credential
       ON credential.account_id = account.id
      AND credential.credential_type = 'password'
      AND credential.status = 'active'
      AND credential.secret_scheme = 'scrypt'
     WHERE member.workspace_id = $1
       AND member.principal_id = $2
       AND member.status = 'active'
       AND grant_row.principal_id = $2
       AND ($3::uuid IS NULL OR grant_row.id = $3)
       AND grant_row.role_key = 'ADMIN'
       AND grant_row.status = 'active'
       AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $4)
       AND principal.kind = 'human'
       AND principal.status = 'active'
       AND account.status = 'active'`,
    [workspaceId, principalId, grantId ?? null, now],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

export async function countOtherUsableWorkspaceAdmins(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  now: Date,
  excludeGrantId?: string,
): Promise<number> {
  return countUsableWorkspaceAdmins(client, {
    workspaceId,
    now,
    excludePrincipalId: principalId,
    excludeGrantId,
  });
}
