import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedSpaceApplication } from "@pluginmax/application";
import {
  Database,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { LocalFileStore } from "@pluginmax/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("Shared Space Worker recovery", () => {
  let database: Database;
  let application: SharedSpaceApplication;
  let repositories: PlatformRepositories;
  let workspaceId: string;
  let actor: {
    readonly principalId: string;
    readonly authSource: "local-development";
  };

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    application = new SharedSpaceApplication(
      repositories,
      new LocalFileStore(await mkdtemp(join(tmpdir(), "shared-worker-"))),
    );
    actor = {
      principalId: `shared-worker-admin-${randomUUID().slice(0, 8)}`,
      authSource: "local-development",
    };
    workspaceId = `shared-worker-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Shared Worker Admin', 'active',
                 'system', 'local', 1, NOW(), NOW())`,
      [actor.principalId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, 'platform', 'platform', 'ADMIN',
         '["platform.access","platform.manage"]'::jsonb, 'active', 'manual',
         'shared-worker-fixture', NULL, NULL, NOW(), NULL, NULL, 1,
         NOW(), NOW()
       )`,
      [randomUUID(), actor.principalId],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'Shared Worker', 'active', $2, 1, NOW(), NOW())`,
      [workspaceId, actor.principalId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [randomUUID(), workspaceId, actor.principalId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, 'workspace', $3, 'ADMIN',
         '["read","manage_roles","manage_members"]'::jsonb, 'active',
         'workspace-role', 'shared-worker-fixture', NULL, NULL, NOW(), NULL,
         NULL, 1, NOW(), NOW()
       )`,
      [randomUUID(), actor.principalId, workspaceId],
    );
    await repositories.sharedSpace.ensureRoot(workspaceId);
  });

  afterAll(async () => {
    await database.close();
  });

  it("consumes approved requests once and recovers expired leases", async () => {
    const submitted = await application.createHumanGlobalWriteRequest(
      actor,
      workspaceId,
      {
        path: `reports/worker-${randomUUID().slice(0, 8)}.md`,
        name: "worker.md",
        mimeType: "text/markdown",
        contentBase64: Buffer.from("# Worker recovery\n").toString("base64"),
        expectedVersion: 0,
        purpose: "Verify Worker recovery",
        scope: "global",
        lockId: null,
      },
      `worker-${randomUUID()}`,
    );
    const approved = await application.decideWriteRequest(
      actor,
      workspaceId,
      submitted.request.id,
      { decision: "approve", basis: "Worker integration approval" },
    );
    expect(approved.status).toBe("approved");
    const first = await application.recoverApprovedWrites();
    expect(first.written).toBe(1);
    expect(first.failed).toBe(0);
    const second = await application.recoverApprovedWrites();
    expect(second.written).toBe(0);
    const consumed = await repositories.sharedSpace.getWriteRequest(
      submitted.request.id,
    );
    expect(consumed?.status).toBe("consumed");
  });
});
