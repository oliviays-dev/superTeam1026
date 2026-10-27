import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("identity principal migration", () => {
  let database: Database;

  beforeAll(() => {
    database = new Database(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("applies migration 24 and preserves it through migration 25", async () => {
    const schema = `batch14a_${randomUUID().replaceAll("-", "")}`;
    await database.query(`CREATE SCHEMA ${schema}`);
    const separator = databaseUrl!.includes("?") ? "&" : "?";
    const isolated = new Database(
      `${databaseUrl!}${separator}options=${encodeURIComponent(
        `-c search_path=${schema}`,
      )}`,
    );
    try {
      await migrate(isolated, 23);
      const projectId = randomUUID();
      const memberId = randomUUID();
      await isolated.query(
        `INSERT INTO projects (
           id, name, code, description, status, created_at, updated_at
         ) VALUES ($1, 'Identity migration project', $2, '', 'active', NOW(), NOW())`,
        [projectId, `ID-${projectId.slice(0, 8)}`],
      );
      await isolated.query(
        `INSERT INTO project_members (
           id, project_id, kind, actor_id, name, responsibility,
           status, is_owner, created_at, updated_at
         ) VALUES ($1, $2, 'human', 'legacy-admin', 'Legacy Admin', '', 'active', TRUE, NOW(), NOW())`,
        [memberId, projectId],
      );

      await migrate(isolated);

      const version = await isolated.query<{ version: number }>(
        "SELECT MAX(version) AS version FROM platform_migrations",
      );
      expect(version.rows[0]?.version).toBe(30);

      const tables = await isolated.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name = ANY($2::text[])
         ORDER BY table_name`,
        [
          schema,
          [
            "accounts",
            "account_credentials",
            "auth_sessions",
            "external_identity_links",
            "identity_audit_events",
            "principal_aliases",
            "principals",
            "role_grants",
            "workspace_members",
          ],
        ],
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "account_credentials",
        "accounts",
        "auth_sessions",
        "external_identity_links",
        "identity_audit_events",
        "principal_aliases",
        "principals",
        "role_grants",
        "workspace_members",
      ]);

      const preserved = await isolated.query<{
        actor_id: string;
        principal_id: string | null;
      }>(
        `SELECT actor_id, principal_id
         FROM project_members
         WHERE id = $1`,
        [memberId],
      );
      expect(preserved.rows[0]).toEqual({
        actor_id: "legacy-admin",
        principal_id: null,
      });

      const agent = await isolated.query<{ principal_id: string | null }>(
        "SELECT principal_id FROM agents ORDER BY id LIMIT 1",
      );
      expect(agent.rows[0]?.principal_id).toBeNull();

      const runColumns = await isolated.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'runs'
           AND column_name IN (
             'agent_principal_id',
             'initiated_by_principal_id'
           )
         ORDER BY column_name`,
        [schema],
      );
      expect(runColumns.rows.map((row) => row.column_name)).toEqual([
        "agent_principal_id",
        "initiated_by_principal_id",
      ]);

      await isolated.query(
        `INSERT INTO principals (
           id, kind, display_name, status, status_authority, source,
           version, created_at, updated_at
         ) VALUES
           ('principal-human-test', 'human', 'Test Human', 'active',
            'account', 'account', 1, NOW(), NOW()),
           ('principal-ai-test', 'ai', 'Test AI', 'active',
            'ai-companion', 'ai-companion', 1, NOW(), NOW())`,
      );
      await isolated.query(
        `INSERT INTO accounts (
           id, principal_id, login_id, status, version, created_at, updated_at
         ) VALUES (
           'account-test', 'principal-human-test', 'test@example.com',
           'active', 1, NOW(), NOW()
         )`,
      );
      await expect(
        isolated.query(
          `INSERT INTO accounts (
             id, principal_id, login_id, status, version, created_at, updated_at
           ) VALUES (
             'account-ai-test', 'principal-ai-test', 'ai@example.com',
             'active', 1, NOW(), NOW()
           )`,
        ),
      ).rejects.toThrow("accounts require a human principal");

      await expect(
        isolated.query(
          `INSERT INTO auth_sessions (
             id, token_hash, account_id, principal_id, status,
             expires_at, revoked_at, last_seen_at, created_at
           ) VALUES (
             $1, repeat('a', 64), 'account-test', 'principal-ai-test',
             'active', NOW() + INTERVAL '1 hour', NULL, NULL, NOW()
           )`,
          [randomUUID()],
        ),
      ).rejects.toThrow("session principal must match account principal");

      const auditId = randomUUID();
      await isolated.query(
        `INSERT INTO identity_audit_events (
           id, action, decision, actor_principal_id, subject_principal_id,
           reason, metadata, created_at
         ) VALUES (
           $1, 'principal.created', 'allowed', 'principal-human-test',
           'principal-ai-test', '', '{}'::jsonb, NOW()
         )`,
        [auditId],
      );
      await expect(
        isolated.query(
          "UPDATE identity_audit_events SET reason = 'changed' WHERE id = $1",
          [auditId],
        ),
      ).rejects.toThrow("identity_audit_events is append-only");
    } finally {
      await isolated.close();
      await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
