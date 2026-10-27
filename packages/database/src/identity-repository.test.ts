import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import {
  IdentityRepository,
  hashIdentityPassword,
  verifyIdentityPassword,
} from "./identity-repository.js";
import { migrate } from "./migrate.js";

describe("identity password hashing", () => {
  it("stores scrypt summaries and verifies without plaintext", async () => {
    const hash = await hashIdentityPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("correct horse battery staple");
    await expect(
      verifyIdentityPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
    await expect(verifyIdentityPassword("wrong", hash)).resolves.toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("identity repository authentication", () => {
  let database: Database;
  let identity: IdentityRepository;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    identity = new IdentityRepository(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("bootstraps, authenticates, rotates passwords, and disables access", async () => {
    const suffix = randomUUID().slice(0, 8);
    const principalId = `principal-human-auth-${suffix}`;
    const accountId = `account-auth-${suffix}`;
    const loginId = `auth-${suffix}`;
    await identity.bootstrapAdministrator({
      principalId,
      accountId,
      loginId,
      displayName: "Auth Test",
      password: "initial-password",
    });
    await identity.bootstrapAdministrator({
      principalId,
      accountId,
      loginId,
      displayName: "Auth Test",
      password: "ignored-password",
    });

    const first = await identity.login({
      loginId: loginId.toUpperCase(),
      password: "initial-password",
      ttlSeconds: 3_600,
    });
    const second = await identity.login({
      loginId,
      password: "initial-password",
      ttlSeconds: 3_600,
    });
    expect(first.principalId).toBe(principalId);
    expect(first.platformAdministrator).toBe(true);
    expect(first.token).not.toBe(second.token);
    await expect(identity.resolveSession(first.token)).resolves.toMatchObject({
      principalId,
      accountId,
      platformAdministrator: true,
    });
    await expect(
      identity.resolveSession("x".repeat(43)),
    ).resolves.toBeUndefined();
    await expect(
      identity.login({
        loginId,
        password: "wrong-password",
        ttlSeconds: 3_600,
      }),
    ).rejects.toMatchObject({
      code: "invalid_credentials",
    });

    await identity.changePassword(first.token, {
      currentPassword: "initial-password",
      newPassword: "replacement-password",
    });
    await expect(identity.resolveSession(first.token)).resolves.toBeDefined();
    await expect(
      identity.resolveSession(second.token),
    ).resolves.toBeUndefined();
    await expect(
      identity.login({
        loginId,
        password: "replacement-password",
        ttlSeconds: 3_600,
      }),
    ).resolves.toMatchObject({ principalId });

    await identity.bootstrapAdministrator({
      principalId: `principal-human-auth-backup-${suffix}`,
      accountId: `account-auth-backup-${suffix}`,
      loginId: `auth-backup-${suffix}`,
      displayName: "Backup Admin",
      password: "backup-password",
    });
    const disabled = await identity.setAccountStatus(principalId, accountId, {
      status: "disabled",
    });
    expect(disabled.sessionsRevoked).toBeGreaterThan(0);
    await expect(identity.resolveSession(first.token)).resolves.toBeUndefined();
    await expect(
      identity.login({
        loginId,
        password: "replacement-password",
        ttlSeconds: 3_600,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    await identity.setAccountStatus(principalId, accountId, {
      status: "active",
    });
    const enabled = await identity.login({
      loginId,
      password: "replacement-password",
      ttlSeconds: 3_600,
    });
    expect(enabled.principalId).toBe(principalId);

    const persisted = await database.query<{
      token_hash: string;
      token_plaintext: boolean;
    }>(
      `SELECT token_hash, token_hash = $2 AS token_plaintext
       FROM auth_sessions
       WHERE id = $1`,
      [enabled.sessionId, enabled.token],
    );
    expect(persisted.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.rows[0]?.token_plaintext).toBe(false);
    const audits = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE subject_principal_id = $1`,
      [principalId],
    );
    expect(Number(audits.rows[0]?.count)).toBeGreaterThanOrEqual(6);
  });
});
