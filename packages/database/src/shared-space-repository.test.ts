import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionTicketRepository } from "./action-ticket-repository.js";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import {
  SharedSpaceRepository,
  SharedSpaceRepositoryError,
} from "./shared-space-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("SharedSpaceRepository PostgreSQL semantics", () => {
  let database: Database;
  let repository: SharedSpaceRepository;
  let workspaceId: string;
  let principalId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repository = new SharedSpaceRepository(
      database,
      new ActionTicketRepository(database),
    );
    workspaceId = `shared-repo-${randomUUID().slice(0, 8)}`;
    principalId = `principal-shared-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Shared Repository Owner', 'active',
                 'account', 'account', 1, NOW(), NOW())`,
      [principalId],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'Shared Repository', 'active', $2, 1, NOW(), NOW())`,
      [workspaceId, principalId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [randomUUID(), workspaceId, principalId],
    );
    await repository.ensureRoot(workspaceId);
  });

  afterAll(async () => {
    await database.close();
  });

  it("applies compare-and-swap across concurrent writers", async () => {
    await repository.createDirectory({
      workspaceId,
      path: "concurrent",
      actorPrincipalId: principalId,
    });
    const base = {
      workspaceId,
      path: "concurrent/report.md",
      name: "report.md",
      mimeType: "text/markdown",
      size: 4,
      actorPrincipalId: principalId,
      expectedVersion: 0,
      lockId: null,
    } as const;
    const results = await Promise.allSettled([
      repository.commitFile({
        ...base,
        sha256: "a".repeat(64),
        storageKey: "staged/one",
      }),
      repository.commitFile({
        ...base,
        sha256: "b".repeat(64),
        storageKey: "staged/two",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(SharedSpaceRepositoryError);
      expect(rejected.reason.code).toBe("shared_space_version_conflict");
    }
    const entry = await repository.getEntryByPath(
      workspaceId,
      "concurrent/report.md",
    );
    expect(entry?.currentVersion).toBe(1);
  });

  it("serializes active locks and recovers expired leases", async () => {
    await repository.createDirectory({
      workspaceId,
      path: "locks",
      actorPrincipalId: principalId,
    });
    const lock = await repository.acquireLock({
      workspaceId,
      path: "locks/report.md",
      ownerPrincipalId: principalId,
      ownerSessionId: "session-one",
      runId: null,
      mode: "exclusive",
      leaseSeconds: 60,
    });
    await expect(
      repository.acquireLock({
        workspaceId,
        path: "locks/report.md",
        ownerPrincipalId: principalId,
        ownerSessionId: "session-two",
        runId: null,
        mode: "exclusive",
        leaseSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "shared_space_lock_conflict" });

    await database.query(
      `UPDATE shared_space_locks
       SET acquired_at = NOW() - INTERVAL '2 minutes',
           lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [lock.id],
    );
    const expired = await repository.expireLocks();
    expect(expired.map((item) => item.id)).toContain(lock.id);
    const recovered = await repository.acquireLock({
      workspaceId,
      path: "locks/report.md",
      ownerPrincipalId: principalId,
      ownerSessionId: "session-two",
      runId: null,
      mode: "exclusive",
      leaseSeconds: 60,
    });
    expect(recovered.status).toBe("active");
    expect(recovered.id).not.toBe(lock.id);
  });

  it("keeps versions, events and digests append-only", async () => {
    await repository.createDirectory({
      workspaceId,
      path: "audit",
      actorPrincipalId: principalId,
    });
    const entry = await repository.commitFile({
      workspaceId,
      path: "audit/report.md",
      name: "report.md",
      mimeType: "text/markdown",
      size: 7,
      sha256: "c".repeat(64),
      storageKey: "staged/audit",
      actorPrincipalId: principalId,
      expectedVersion: 0,
      lockId: null,
    });
    await expect(
      database.query(
        `UPDATE shared_space_versions SET size = 8 WHERE entry_id = $1`,
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/u);
    await expect(
      database.query(
        `UPDATE shared_space_events SET reason = 'tampered'
         WHERE workspace_id = $1`,
        [workspaceId],
      ),
    ).rejects.toThrow(/append-only/u);
    const digest = await repository.createDigest({
      workspaceId,
      sceneSessionId: null,
      generatedBy: principalId,
      digestDate: "2026-10-28",
    });
    await expect(
      database.query(
        `UPDATE shared_space_digests SET content = 'tampered' WHERE id = $1`,
        [digest.id],
      ),
    ).rejects.toThrow(/append-only/u);
  });
});
