import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type {
  AccountStatusInput,
  AccountStatusResult,
  AuthenticatedPrincipal,
  ChangePasswordInput,
  LoginInput,
  LoginResult,
} from "@pluginmax/contracts";
import { evaluateHumanSessionAccess } from "@pluginmax/contracts";
import type { Database } from "./database.js";

const PASSWORD_SCHEME = "scrypt";
const PASSWORD_COST = 16_384;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 1;
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
const dummyPasswordHash = hashIdentityPassword(
  randomBytes(32).toString("base64url"),
);

export class IdentityRepositoryError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "session_invalid"
      | "account_conflict"
      | "last_platform_admin"
      | "forbidden"
      | "not_found",
    message: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "IdentityRepositoryError";
  }
}

export interface IdentityRepositoryOptions {
  readonly now?: () => Date;
  readonly createSessionToken?: () => string;
}

interface SessionRow {
  readonly session_id: string;
  readonly session_status: "active" | "expired" | "revoked";
  readonly expires_at: Date;
  readonly account_id: string;
  readonly account_status: "active" | "pending" | "disabled";
  readonly principal_id: string;
  readonly principal_kind: "human" | "ai";
  readonly principal_status: "active" | "suspended" | "archived";
  readonly principal_status_authority:
    "account" | "ai-companion" | "hrm" | "legacy" | "system";
  readonly display_name: string;
  readonly login_id: string;
  readonly credential_status: "pending" | "active" | "disabled" | "revoked";
}

interface LoginAccountRow extends SessionRow {
  readonly credential_id: string;
  readonly secret_scheme: string;
  readonly secret_hash: string;
}

interface AccountRow {
  readonly account_id: string;
  readonly account_status: "active" | "pending" | "disabled";
  readonly principal_id: string;
  readonly principal_status: "active" | "suspended" | "archived";
  readonly principal_status_authority:
    "account" | "ai-companion" | "hrm" | "legacy" | "system";
}

interface IdentityQueryExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number | null }>;
}

function derivePassword(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export async function hashIdentityPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELIZATION,
  });
  return [
    PASSWORD_SCHEME,
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyIdentityPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, rawCost, rawBlockSize, rawParallelization, rawSalt, rawHash] =
    stored.split("$");
  if (
    scheme !== PASSWORD_SCHEME ||
    rawCost === undefined ||
    rawBlockSize === undefined ||
    rawParallelization === undefined ||
    rawSalt === undefined ||
    rawHash === undefined
  ) {
    return false;
  }
  const cost = Number(rawCost);
  const blockSize = Number(rawBlockSize);
  const parallelization = Number(rawParallelization);
  if (
    !Number.isSafeInteger(cost) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    cost < PASSWORD_COST ||
    cost > 2 ** 20 ||
    blockSize < 1 ||
    parallelization < 1 ||
    parallelization > 16
  ) {
    return false;
  }
  try {
    const expected = Buffer.from(rawHash, "base64url");
    const actual = await derivePassword(
      password,
      Buffer.from(rawSalt, "base64url"),
      expected.length,
      { N: cost, r: blockSize, p: parallelization },
    );
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isoTimestamp(date: Date): string {
  return date.toISOString();
}

export class IdentityRepository {
  private readonly now: () => Date;
  private readonly createSessionToken: () => string;

  constructor(
    private readonly database: Database,
    options: IdentityRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createSessionToken =
      options.createSessionToken ??
      (() => randomBytes(SESSION_TOKEN_BYTES).toString("base64url"));
  }

  private async audit(
    client: IdentityQueryExecutor,
    input: {
      readonly action: string;
      readonly decision: "allowed" | "denied";
      readonly actorPrincipalId?: string | null;
      readonly subjectPrincipalId?: string | null;
      readonly accountId?: string | null;
      readonly sessionId?: string | null;
      readonly grantId?: string | null;
      readonly reason?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO identity_audit_events (
         id, action, decision, actor_principal_id, subject_principal_id,
         account_id, session_id, grant_id, reason, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        randomUUID(),
        input.action,
        input.decision,
        input.actorPrincipalId ?? null,
        input.subjectPrincipalId ?? null,
        input.accountId ?? null,
        input.sessionId ?? null,
        input.grantId ?? null,
        input.reason ?? "",
        JSON.stringify(input.metadata ?? {}),
        this.now(),
      ],
    );
  }

  private async platformAdministrator(principalId: string): Promise<boolean> {
    const result = await this.database.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM role_grants
         WHERE principal_id = $1
           AND scope_type = 'platform'
           AND scope_id = 'platform'
           AND role_key = 'ADMIN'
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > $2)
       ) AS allowed`,
      [principalId, this.now()],
    );
    return result.rows[0]?.allowed === true;
  }

  private async revokeSessions(
    client: PoolClient,
    principalId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE auth_sessions
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
       WHERE principal_id = $1
         AND status = 'active'
         AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [principalId, this.now(), exceptSessionId ?? null],
    );
    return result.rowCount ?? 0;
  }

  async login(
    input: LoginInput & { readonly ttlSeconds: number },
  ): Promise<LoginResult> {
    const now = this.now();
    const account = await this.database.query<LoginAccountRow>(
      `SELECT
         a.id AS account_id,
         a.status AS account_status,
         a.login_id,
         p.id AS principal_id,
         p.kind AS principal_kind,
         p.status AS principal_status,
         p.status_authority AS principal_status_authority,
         p.display_name,
         c.id AS credential_id,
         c.status AS credential_status,
         c.secret_scheme,
         c.secret_hash
       FROM accounts a
       JOIN principals p ON p.id = a.principal_id
       JOIN LATERAL (
         SELECT id, status, secret_scheme, secret_hash
         FROM account_credentials
         WHERE account_id = a.id
           AND credential_type = 'password'
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1
       ) c ON TRUE
       WHERE lower(a.login_id) = lower($1)
       LIMIT 1`,
      [input.loginId],
    );
    const row = account.rows[0];
    const passwordValid = await verifyIdentityPassword(
      input.password,
      row?.secret_hash ?? (await dummyPasswordHash),
    );
    const valid = row !== undefined && passwordValid;
    if (!valid || row === undefined) {
      await this.audit(this.database, {
        action: "auth.login",
        decision: "denied",
        reason: "invalid_credentials",
        metadata: { loginId: input.loginId },
      });
      throw new IdentityRepositoryError(
        "invalid_credentials",
        "Login ID or password is invalid",
        401,
      );
    }
    const access = evaluateHumanSessionAccess(
      {
        principalStatus: row.principal_status,
        accountStatus: row.account_status,
        credentialStatus: row.credential_status,
        sessionStatus: "active",
        sessionExpiresAt: isoTimestamp(
          new Date(now.getTime() + input.ttlSeconds * 1_000),
        ),
      },
      now,
    );
    if (row.principal_kind !== "human" || !access.allowed) {
      await this.audit(this.database, {
        action: "auth.login",
        decision: "denied",
        subjectPrincipalId: row.principal_id,
        accountId: row.account_id,
        reason: access.allowed ? "non_human_principal" : access.reason,
        metadata: { loginId: input.loginId },
      });
      throw new IdentityRepositoryError(
        "invalid_credentials",
        "Login ID or password is invalid",
        401,
      );
    }

    const token = this.createSessionToken();
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO auth_sessions (
           id, token_hash, account_id, principal_id, status,
           expires_at, revoked_at, last_seen_at, created_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, NULL, NULL, $6)`,
        [
          sessionId,
          tokenHash(token),
          row.account_id,
          row.principal_id,
          expiresAt,
          now,
        ],
      );
      await client.query(
        `UPDATE account_credentials
         SET last_authenticated_at = $2, updated_at = $2, version = version + 1
         WHERE id = $1`,
        [row.credential_id, now],
      );
      await this.audit(client, {
        action: "auth.login",
        decision: "allowed",
        actorPrincipalId: row.principal_id,
        subjectPrincipalId: row.principal_id,
        accountId: row.account_id,
        sessionId,
      });
    });
    return {
      principalId: row.principal_id,
      accountId: row.account_id,
      sessionId,
      loginId: row.login_id,
      displayName: row.display_name,
      kind: "human",
      platformAdministrator: await this.platformAdministrator(row.principal_id),
      expiresAt: isoTimestamp(expiresAt),
      token,
    };
  }

  async resolveSession(
    token: string,
  ): Promise<AuthenticatedPrincipal | undefined> {
    const result = await this.database.query<SessionRow>(
      `SELECT
         s.id AS session_id,
         s.status AS session_status,
         s.expires_at,
         a.id AS account_id,
         a.status AS account_status,
         a.login_id,
         p.id AS principal_id,
         p.kind AS principal_kind,
         p.status AS principal_status,
         p.status_authority AS principal_status_authority,
         p.display_name,
         c.status AS credential_status
       FROM auth_sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN principals p ON p.id = s.principal_id
       JOIN LATERAL (
         SELECT status
         FROM account_credentials
         WHERE account_id = a.id
           AND credential_type = 'password'
           AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1
       ) c ON TRUE
       WHERE s.token_hash = $1
       LIMIT 1`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const now = this.now();
    const access = evaluateHumanSessionAccess(
      {
        principalStatus: row.principal_status,
        accountStatus: row.account_status,
        credentialStatus: row.credential_status,
        sessionStatus: row.session_status,
        sessionExpiresAt: row.expires_at.toISOString(),
      },
      now,
    );
    if (!access.allowed || row.principal_kind !== "human") {
      if (row.session_status === "active") {
        const expired = row.expires_at.getTime() <= now.getTime();
        await this.database.query(
          `UPDATE auth_sessions
           SET status = $2,
               revoked_at = CASE WHEN $2 = 'revoked' THEN COALESCE(revoked_at, $3) ELSE revoked_at END
           WHERE id = $1 AND status = 'active'`,
          [row.session_id, expired ? "expired" : "revoked", now],
        );
      }
      return undefined;
    }
    await this.database.query(
      `UPDATE auth_sessions
       SET last_seen_at = $2
       WHERE id = $1 AND status = 'active'`,
      [row.session_id, now],
    );
    return {
      principalId: row.principal_id,
      accountId: row.account_id,
      sessionId: row.session_id,
      loginId: row.login_id,
      displayName: row.display_name,
      kind: "human",
      platformAdministrator: await this.platformAdministrator(row.principal_id),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async logout(token: string): Promise<void> {
    const session = await this.database.query<{
      id: string;
      principal_id: string;
      account_id: string;
    }>(
      `SELECT id, principal_id, account_id
       FROM auth_sessions
       WHERE token_hash = $1`,
      [tokenHash(token)],
    );
    const row = session.rows[0];
    if (row === undefined) return;
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE auth_sessions
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
         WHERE id = $1 AND status = 'active'`,
        [row.id, this.now()],
      );
      await this.audit(client, {
        action: "auth.logout",
        decision: "allowed",
        actorPrincipalId: row.principal_id,
        subjectPrincipalId: row.principal_id,
        accountId: row.account_id,
        sessionId: row.id,
      });
    });
  }

  async changePassword(
    token: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const resolved = await this.resolveSession(token);
    if (resolved === undefined) {
      throw new IdentityRepositoryError(
        "session_invalid",
        "Session is invalid or expired",
        401,
      );
    }
    const credential = await this.database.query<{
      id: string;
      secret_hash: string;
    }>(
      `SELECT id, secret_hash
       FROM account_credentials
       WHERE account_id = $1
         AND credential_type = 'password'
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [resolved.accountId],
    );
    const row = credential.rows[0];
    if (
      row === undefined ||
      !(await verifyIdentityPassword(input.currentPassword, row.secret_hash))
    ) {
      throw new IdentityRepositoryError(
        "invalid_credentials",
        "Current password is invalid",
        401,
      );
    }
    const nextHash = await hashIdentityPassword(input.newPassword);
    const now = this.now();
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE account_credentials
         SET secret_scheme = $2, secret_hash = $3, updated_at = $4,
             version = version + 1
         WHERE id = $1`,
        [row.id, PASSWORD_SCHEME, nextHash, now],
      );
      const revoked = await this.revokeSessions(
        client,
        resolved.principalId,
        resolved.sessionId,
      );
      await this.audit(client, {
        action: "auth.password.changed",
        decision: "allowed",
        actorPrincipalId: resolved.principalId,
        subjectPrincipalId: resolved.principalId,
        accountId: resolved.accountId,
        sessionId: resolved.sessionId,
        metadata: { revokedSessions: revoked },
      });
    });
  }

  async setAccountStatus(
    actorPrincipalId: string,
    accountId: string,
    input: AccountStatusInput,
  ): Promise<AccountStatusResult> {
    const now = this.now();
    return this.database.transaction(async (client) => {
      const account = await client.query<AccountRow>(
        `SELECT
           a.id AS account_id,
           a.status AS account_status,
           p.id AS principal_id,
           p.status AS principal_status,
           p.status_authority AS principal_status_authority
         FROM accounts a
         JOIN principals p ON p.id = a.principal_id
         WHERE a.id = $1
         FOR UPDATE OF a, p`,
        [accountId],
      );
      const row = account.rows[0];
      if (row === undefined) {
        throw new IdentityRepositoryError(
          "not_found",
          "Account not found",
          404,
        );
      }
      if (row.account_status === input.status) {
        return {
          accountId,
          principalId: row.principal_id,
          accountStatus: row.account_status,
          principalStatus: row.principal_status,
          sessionsRevoked: 0,
        };
      }
      if (row.account_status === "pending" && input.status === "active") {
        throw new IdentityRepositoryError(
          "account_conflict",
          "A pending account must complete credential activation before it can be enabled",
          409,
        );
      }
      if (
        input.status === "active" &&
        (row.principal_status === "archived" ||
          row.principal_status_authority === "hrm")
      ) {
        throw new IdentityRepositoryError(
          "account_conflict",
          "Archived or HRM-controlled Principal cannot be reactivated",
          409,
        );
      }
      if (input.status === "disabled") {
        const ownAdmin = await client.query(
          `SELECT 1
           FROM role_grants
           WHERE principal_id = $1
             AND scope_type = 'platform'
             AND scope_id = 'platform'
             AND role_key = 'ADMIN'
             AND status = 'active'
             AND (expires_at IS NULL OR expires_at > $2)
           LIMIT 1`,
          [row.principal_id, now],
        );
        if ((ownAdmin.rowCount ?? 0) > 0) {
          const otherAdmins = await client.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM role_grants AS grant_row
             JOIN principals AS principal
               ON principal.id = grant_row.principal_id
             LEFT JOIN accounts AS account
               ON account.principal_id = principal.id
             WHERE grant_row.principal_id <> $1
               AND grant_row.scope_type = 'platform'
               AND grant_row.scope_id = 'platform'
               AND grant_row.role_key = 'ADMIN'
               AND grant_row.status = 'active'
               AND (grant_row.expires_at IS NULL OR grant_row.expires_at > $2)
               AND principal.status = 'active'
               AND (principal.kind = 'ai' OR account.status = 'active')`,
            [row.principal_id, now],
          );
          if (Number(otherAdmins.rows[0]?.count ?? 0) === 0) {
            throw new IdentityRepositoryError(
              "last_platform_admin",
              "The last active platform administrator account cannot be disabled",
              409,
            );
          }
        }
      }
      const principalStatus =
        input.status === "active"
          ? row.principal_status_authority === "account"
            ? "active"
            : row.principal_status
          : row.principal_status === "archived"
            ? "archived"
            : "suspended";
      const principalAuthority =
        input.status === "disabled" ||
        row.principal_status_authority === "account"
          ? "account"
          : row.principal_status_authority;
      await client.query(
        `UPDATE accounts
         SET status = $2, updated_at = $3, version = version + 1
         WHERE id = $1`,
        [accountId, input.status, now],
      );
      await client.query(
        input.status === "disabled"
          ? `UPDATE account_credentials
             SET status = 'disabled', updated_at = $2, version = version + 1
             WHERE account_id = $1
               AND credential_type = 'password'
               AND status = 'active'`
          : `UPDATE account_credentials
             SET status = 'active', updated_at = $2, version = version + 1
             WHERE account_id = $1
               AND credential_type = 'password'
               AND status = 'disabled'
               AND secret_scheme = 'scrypt'`,
        [accountId, now],
      );
      if (principalStatus !== row.principal_status) {
        await client.query(
          `UPDATE principals
           SET status = $2, status_authority = $3, updated_at = $4,
               version = version + 1
           WHERE id = $1`,
          [row.principal_id, principalStatus, principalAuthority, now],
        );
      }
      const revoked =
        input.status === "disabled"
          ? await this.revokeSessions(client, row.principal_id)
          : 0;
      await this.audit(client, {
        action: `auth.account.${input.status}`,
        decision: "allowed",
        actorPrincipalId,
        subjectPrincipalId: row.principal_id,
        accountId,
        metadata: { sessionsRevoked: revoked },
      });
      return {
        accountId,
        principalId: row.principal_id,
        accountStatus: input.status,
        principalStatus,
        sessionsRevoked: revoked,
      };
    });
  }

  async bootstrapAdministrator(input: {
    readonly principalId: string;
    readonly accountId: string;
    readonly loginId: string;
    readonly displayName: string;
    readonly password: string;
  }): Promise<void> {
    const now = this.now();
    const passwordHash = await hashIdentityPassword(input.password);
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO principals (
           id, kind, display_name, status, status_authority, source,
           version, created_at, updated_at
         ) VALUES ($1, 'human', $2, 'active', 'account', 'local', 1, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [input.principalId, input.displayName, now],
      );
      const principal = await client.query<{
        kind: string;
        status: string;
      }>("SELECT kind, status FROM principals WHERE id = $1", [
        input.principalId,
      ]);
      if (principal.rows[0]?.kind !== "human") {
        throw new IdentityRepositoryError(
          "account_conflict",
          "Bootstrap Principal is not human",
          409,
        );
      }
      await client.query(
        `INSERT INTO accounts (
           id, principal_id, login_id, status, version, created_at, updated_at
         ) VALUES ($1, $2, $3, 'active', 1, $4, $4)
         ON CONFLICT (id) DO NOTHING`,
        [input.accountId, input.principalId, input.loginId, now],
      );
      const credential = await client.query<{ id: string }>(
        `SELECT id FROM account_credentials
         WHERE account_id = $1 AND credential_type = 'password'
         LIMIT 1`,
        [input.accountId],
      );
      if (credential.rows[0] === undefined) {
        await client.query(
          `INSERT INTO account_credentials (
             id, account_id, credential_type, secret_scheme, secret_hash,
             status, expires_at, last_authenticated_at, version,
             created_at, updated_at
           ) VALUES ($1, $2, 'password', $3, $4, 'active', NULL, NULL, 1, $5, $5)`,
          [randomUUID(), input.accountId, PASSWORD_SCHEME, passwordHash, now],
        );
      }
      await client.query(
        `INSERT INTO role_grants (
           id, principal_id, scope_type, scope_id, role_key, permissions,
           status, source_kind, source_ref, granted_by_principal_id,
           revoked_by_principal_id, granted_at, expires_at, revoked_at,
           version, created_at, updated_at
         )
         SELECT $1, $2, 'platform', 'platform', 'ADMIN', '[]'::jsonb,
                'active', 'manual', 'bootstrap:administrator', NULL,
                NULL, $3, NULL, NULL, 1, $3, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM role_grants
           WHERE principal_id = $2
             AND scope_type = 'platform'
             AND scope_id = 'platform'
             AND role_key = 'ADMIN'
             AND status = 'active'
         )`,
        [randomUUID(), input.principalId, now],
      );
      await this.audit(client, {
        action: "auth.bootstrap.administrator",
        decision: "allowed",
        subjectPrincipalId: input.principalId,
        accountId: input.accountId,
      });
    });
  }
}
