import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  MarketAsset,
  MarketAssetDetail,
  MarketAssetResourceBinding,
  MarketEntitlement,
  MarketGovernanceView,
  MarketInstallResult,
  MarketInstallation,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M12 Market governance and resource binding", () => {
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const owner = "m12-owner";
  const otherOwner = "m12-other-owner";
  const consumer = "m12-consumer";
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let market: ReturnType<typeof buildApi>["market"];
  let sharedAsset: MarketAssetDetail;
  let privateAsset: MarketAssetDetail;
  let lockAsset: MarketAssetDetail;
  let bindingAsset: MarketAssetDetail;
  let skillVersionId: string;
  let skillDefinitionId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m12-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    market = built.market;
    await app.ready();

    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ('local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($1, 'human', 'M12 Owner', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($2, 'human', 'M12 Other Owner', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($3, 'human', 'M12 Consumer', 'active', 'system', 'local',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [owner, otherOwner, consumer],
    );
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'M12 Governance Project', $2, '', 'active', NOW(), NOW())`,
      [projectId, `M12-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'M12 Workspace', 'active', 'local-admin', 1, NOW(), NOW())`,
      [workspaceId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES
         ($1, $2, $3, 'active', 1, NOW(), NOW()),
         ($4, $2, $5, 'active', 1, NOW(), NOW())`,
      [randomUUID(), workspaceId, owner, randomUUID(), otherOwner],
    );

    skillDefinitionId = randomUUID();
    skillVersionId = randomUUID();
    await database.query(
      `INSERT INTO skill_definitions (
         id, key, name, description, status, current_version,
         created_by_principal_id, created_at, updated_at
       ) VALUES ($1, 'm12.bound.skill', 'M12 Bound Skill', '', 'active', 1,
         $2, NOW(), NOW())`,
      [skillDefinitionId, owner],
    );
    await database.query(
      `INSERT INTO skill_versions (
         id, skill_id, version, digest, publisher_principal_id,
         trust_level, instructions, instructions_hash, manifest, permissions,
         triggers, status, protected, created_at
       ) VALUES (
         $1, $2, 1, repeat('a', 64), $3, 'private',
         'SECRET INSTRUCTION BODY', repeat('b', 64), '{}'::jsonb, '[]'::jsonb,
         '[]'::jsonb, 'published', FALSE, NOW()
       )`,
      [skillVersionId, skillDefinitionId, owner],
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function setFlag(
    flag:
      | "market"
      | "market.governance_v2"
      | "market.shared_supply",
    mode: "on" | "off",
  ) {
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = $1, revision = revision + 1, updated_at = NOW()
       WHERE flag_key = $2
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
      [mode, flag],
    );
  }

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    expectedStatus = 200,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await raw(
      method,
      url,
      payload,
      actorId,
      idempotencyKey,
    );
    expect(
      response.statusCode,
      `${method} ${url}: ${response.body}`,
    ).toBe(expectedStatus);
    return response.body === "" ? (undefined as T) : (response.json() as T);
  }

  async function raw(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    idempotencyKey?: string,
  ) {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    const options: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    return app.inject(options);
  }

  async function createAsset(input: {
    readonly assetKey: string;
    readonly kind?: "panel" | "skill" | "mcp";
    readonly actor: string;
    readonly origin: "platform" | "user";
    readonly sharingScope: "private" | "workspace" | "platform";
    readonly publicationStatus?: "draft" | "published";
  }): Promise<MarketAssetDetail> {
    return request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: input.assetKey,
        kind: input.kind ?? "panel",
        name: input.assetKey,
        description: "",
        origin: input.origin,
        sharingScope: input.sharingScope,
        publicationStatus: input.publicationStatus ?? "published",
        ...(input.sharingScope === "workspace"
          ? { visibilityScopeId: workspaceId }
          : {}),
      },
      input.actor,
      201,
    );
  }

  async function publishPanel(assetId: string, actor = owner) {
    return request<MarketAssetDetail["versions"][number]>(
      "POST",
      `/api/v1/market/assets/${assetId}/versions`,
      {
        manifest: {
          summary: "M12 runtime panel",
          panelPluginId: "market.sample",
        },
        compatibility: { minHostVersion: "2.0.0" },
      },
      actor,
      201,
    );
  }

  async function entitlement(
    assetId: string,
    principalId: string,
    actor = "local-admin",
  ) {
    return request<MarketEntitlement>(
      "POST",
      "/api/v1/market/entitlements",
      { assetId, principalId },
      actor,
      201,
    );
  }

  async function install(assetId: string, actor: string): Promise<MarketInstallResult> {
    return request<MarketInstallResult>(
      "POST",
      "/api/v1/market/installations",
      { assetId, version: 1, config: {} },
      actor,
      201,
      `m12-install-${assetId}-${actor}`,
    );
  }

  it("keeps governance v2 inert while its flag is off and dual-reads legacy fields", async () => {
    await setFlag("market", "on");
    await setFlag("market.governance_v2", "off");
    const legacy = await request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m12.legacy.asset",
        kind: "panel",
        name: "M12 Legacy Asset",
        trustLevel: "official",
        visibility: "public",
      },
      "local-admin",
      201,
    );
    expect(legacy).toMatchObject({
      origin: "platform",
      sharingScope: "platform",
      publicationStatus: "published",
      availabilityStatus: "active",
      legacyVisibility: "public",
      legacyStatus: "active",
    });
    const auditCount = await database.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM market_governance_audit_events
       WHERE asset_id = $1`,
      [legacy.id],
    );
    expect(auditCount.rows[0]?.count).toBe("0");
    const blocked = await raw(
      "POST",
      `/api/v1/market/assets/${legacy.id}/governance/delist`,
      { expectedRevision: legacy.revision, reason: "" },
      "local-admin",
    );
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: "market_governance_disabled" });

    await setFlag("market.governance_v2", "on");
    const sharedSupplyBlocked = await raw(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m12.shared.supply.off",
        kind: "panel",
        name: "M12 Shared Supply Off",
        origin: "user",
        sharingScope: "workspace",
        publicationStatus: "published",
        visibilityScopeId: workspaceId,
      },
      owner,
    );
    expect(sharedSupplyBlocked.statusCode).toBe(403);
    expect(sharedSupplyBlocked.json()).toMatchObject({
      code: "market_shared_supply_disabled",
    });
    await setFlag("market.shared_supply", "on");
  });

  it("enforces owner custody and hides private user resources from administrators", async () => {
    sharedAsset = await createAsset({
      assetKey: "m12.owner.shared.panel",
      actor: owner,
      origin: "user",
      sharingScope: "workspace",
    });
    privateAsset = await createAsset({
      assetKey: "m12.owner.private.panel",
      actor: owner,
      origin: "user",
      sharingScope: "private",
      publicationStatus: "draft",
    });

    const forbidden = await raw(
      "POST",
      `/api/v1/market/assets/${sharedAsset.id}/governance/delist`,
      { expectedRevision: sharedAsset.revision, reason: "not mine" },
      otherOwner,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "market_visibility_denied" });

    const privateRead = await raw(
      "GET",
      `/api/v1/market/assets/${privateAsset.id}`,
      undefined,
      "local-admin",
    );
    expect(privateRead.statusCode).toBe(404);
    expect(privateRead.json()).toMatchObject({
      code: "market_forbidden",
    });
  });

  it("separates delist, uninstall, suspend and archive semantics", async () => {
    await publishPanel(sharedAsset.id);
    await entitlement(sharedAsset.id, consumer);
    await install(sharedAsset.id, consumer);
    sharedAsset = await request<MarketAssetDetail>(
      "GET",
      `/api/v1/market/assets/${sharedAsset.id}`,
      undefined,
      owner,
    );

    const delisted = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${sharedAsset.id}/governance/delist`,
      {
        expectedRevision: sharedAsset.revision,
        reason: "catalog review",
      },
      owner,
    );
    expect(delisted).toMatchObject({
      publicationStatus: "delisted",
      availabilityStatus: "active",
      newInstallAllowed: false,
      existingRunsAllowed: true,
    });
    const existing = await request<{ items: MarketInstallation[] }>(
      "GET",
      "/api/v1/market/installations",
      undefined,
      consumer,
    );
    expect(existing.items[0]).toMatchObject({
      status: "active",
      publicationStatus: "delisted",
      availabilityStatus: "active",
      runtimeAvailable: true,
    });
    const blockedInstall = await raw(
      "POST",
      "/api/v1/market/installations",
      { assetId: sharedAsset.id, version: 1, config: {} },
      consumer,
      "m12-reinstall-after-delist",
    );
    expect(blockedInstall.statusCode).toBe(409);
    expect(blockedInstall.json()).toMatchObject({
      code: "market_asset_not_active",
    });

    const suspended = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${sharedAsset.id}/governance/suspend`,
      {
        expectedRevision: delisted.revision,
        reason: "unsafe panel behavior",
      },
      owner,
    );
    expect(suspended).toMatchObject({
      publicationStatus: "delisted",
      availabilityStatus: "suspended",
      suspendedReason: "unsafe panel behavior",
      existingRunsAllowed: false,
    });
    const blockedRuntime = await request<{ items: MarketInstallation[] }>(
      "GET",
      "/api/v1/market/installations",
      undefined,
      consumer,
    );
    expect(blockedRuntime.items[0]).toMatchObject({
      runtimeAvailable: false,
      blockedReason: "unsafe panel behavior",
    });
    expect(
      await market.hasPanelRuntimeAccess(
        {
          principalId: consumer,
          authSource: "local-development",
          platformAdministrator: false,
        },
        "market.sample",
      ),
    ).toBe(false);

    const resumed = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${sharedAsset.id}/governance/resume`,
      { expectedRevision: suspended.revision, reason: "fixed" },
      owner,
    );
    const archived = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${sharedAsset.id}/governance/archive`,
      { expectedRevision: resumed.revision, reason: "season complete" },
      owner,
    );
    expect(archived).toMatchObject({
      publicationStatus: "archived",
      availabilityStatus: "active",
      existingRunsAllowed: true,
    });
    const uninstalled = await request<MarketInstallation>(
      "DELETE",
      `/api/v1/market/installations/${sharedAsset.id}`,
      undefined,
      consumer,
    );
    expect(uninstalled.status).toBe("uninstalled");
    const afterUninstall = await request<MarketAssetDetail>(
      "GET",
      `/api/v1/market/assets/${sharedAsset.id}`,
      undefined,
      owner,
    );
    expect(afterUninstall).toMatchObject({
      publicationStatus: "archived",
      availabilityStatus: "active",
    });
  });

  it("blocks owner relisting under administrator lock and allows an administrator override", async () => {
    lockAsset = await createAsset({
      assetKey: "m12.lock.panel",
      actor: owner,
      origin: "user",
      sharingScope: "workspace",
    });
    const delisted = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${lockAsset.id}/governance/delist`,
      { expectedRevision: lockAsset.revision, reason: "review" },
      owner,
    );
    const locked = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${lockAsset.id}/governance/lock`,
      { expectedRevision: delisted.revision, reason: "security hold" },
      "local-admin",
    );
    expect(locked.adminLocked).toBe(true);
    const ownerRelist = await raw(
      "POST",
      `/api/v1/market/assets/${lockAsset.id}/governance/relist`,
      { expectedRevision: locked.revision, reason: "owner override" },
      owner,
    );
    expect(ownerRelist.statusCode).toBe(409);
    expect(ownerRelist.json()).toMatchObject({
      code: "market_admin_lock_conflict",
    });
    const adminRelist = await request<MarketAsset>(
      "POST",
      `/api/v1/market/assets/${lockAsset.id}/governance/relist`,
      { expectedRevision: locked.revision, reason: "cleared by admin" },
      "local-admin",
    );
    expect(adminRelist.publicationStatus).toBe("published");
  });

  it("does not grant business authorization through entitlements or installations", async () => {
    const grants = await database.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM role_grants
       WHERE principal_id = $1
         AND scope_type IN ('project', 'workspace')`,
      [consumer],
    );
    const memberships = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_members WHERE principal_id = $1) +
         (SELECT COUNT(*) FROM workspace_members WHERE principal_id = $1)
       )::text AS count`,
      [consumer],
    );
    expect(grants.rows[0]?.count).toBe("0");
    expect(memberships.rows[0]?.count).toBe("0");
    const entitlements = await request<{ items: MarketEntitlement[] }>(
      "GET",
      "/api/v1/market/entitlements",
      undefined,
      consumer,
    );
    expect(entitlements.items[0]?.grantsAuthorization).toBe(false);
  });

  it("binds resources by reference without copying resource content", async () => {
    bindingAsset = await createAsset({
      assetKey: "m12.skill.binding",
      kind: "skill",
      actor: owner,
      origin: "user",
      sharingScope: "workspace",
    });
    const version = await request<MarketAssetDetail["versions"][number]>(
      "POST",
      `/api/v1/market/assets/${bindingAsset.id}/versions`,
      {
        manifest: { summary: "Skill pointer only" },
        compatibility: { minHostVersion: "2.0.0" },
      },
      owner,
      201,
    );
    const binding = await request<MarketAssetResourceBinding>(
      "POST",
      `/api/v1/market/assets/${bindingAsset.id}/bindings`,
      {
        assetVersionId: version.id,
        resourceKind: "skill_version",
        resourceId: skillDefinitionId,
        resourceVersionId: skillVersionId,
      },
      owner,
      201,
    );
    expect(binding).toMatchObject({
      assetId: bindingAsset.id,
      resourceKind: "skill_version",
      resourceId: skillDefinitionId,
      resourceVersionId: skillVersionId,
    });
    const bindingColumns = await database.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
       WHERE table_name = 'market_asset_resource_bindings'
         AND column_name IN (
           'instructions', 'manifest', 'payload', 'content', 'body'
         )`,
    );
    expect(bindingColumns.rows[0]?.count).toBe("0");
    const skill = await database.query<{ readonly instructions: string }>(
      `SELECT instructions FROM skill_versions WHERE id = $1`,
      [skillVersionId],
    );
    expect(skill.rows[0]?.instructions).toBe("SECRET INSTRUCTION BODY");

    const mcpTarget = await createAsset({
      assetKey: "m12.mcp.provider.catalogue",
      kind: "mcp",
      actor: "local-admin",
      origin: "platform",
      sharingScope: "platform",
    });
    const mcpVersion = await request<MarketAssetDetail["versions"][number]>(
      "POST",
      `/api/v1/market/assets/${mcpTarget.id}/versions`,
      {
        manifest: { summary: "M12 MCP catalogue identity" },
        compatibility: { minHostVersion: "2.0.0" },
      },
      "local-admin",
      201,
    );
    const mcpBinding = await request<MarketAssetResourceBinding>(
      "POST",
      `/api/v1/market/assets/${bindingAsset.id}/bindings`,
      {
        assetVersionId: version.id,
        resourceKind: "mcp_provider",
        resourceId: mcpTarget.assetKey,
        resourceVersionId: mcpVersion.id,
      },
      owner,
      201,
    );
    expect(mcpBinding).toMatchObject({
      resourceKind: "mcp_provider",
      resourceId: mcpTarget.assetKey,
      resourceVersionId: mcpVersion.id,
    });

    const duplicate = await raw(
      "POST",
      `/api/v1/market/assets/${bindingAsset.id}/bindings`,
      {
        assetVersionId: version.id,
        resourceKind: "skill_version",
        resourceId: skillDefinitionId,
        resourceVersionId: skillVersionId,
      },
      owner,
    );
    expect(duplicate.statusCode).toBe(409);
  });

  it("serializes concurrent governance with revision CAS", async () => {
    const concurrentAsset = await createAsset({
      assetKey: "m12.concurrent.panel",
      actor: owner,
      origin: "user",
      sharingScope: "workspace",
    });
    const payload = {
      expectedRevision: concurrentAsset.revision,
      reason: "parallel review",
    };
    const responses = await Promise.all([
      raw(
        "POST",
        `/api/v1/market/assets/${concurrentAsset.id}/governance/delist`,
        payload,
        owner,
      ),
      raw(
        "POST",
        `/api/v1/market/assets/${concurrentAsset.id}/governance/delist`,
        payload,
        owner,
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
  });

  it("keeps Market governance audit append-only", async () => {
    const audit = await request<MarketGovernanceView>(
      "GET",
      `/api/v1/market/assets/${sharedAsset.id}/governance`,
      undefined,
      owner,
    );
    expect(audit.audit.length).toBeGreaterThan(0);
    expect(audit.audit[0]).toMatchObject({
      assetId: sharedAsset.id,
      actorRole: "owner",
    });
    const auditId = audit.audit[0]!.id;
    await expect(
      database.query(
        `UPDATE market_governance_audit_events
         SET reason = 'rewritten'
         WHERE id = $1`,
        [auditId],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      database.query(
        "DELETE FROM market_governance_audit_events WHERE id = $1",
        [auditId],
      ),
    ).rejects.toThrow(/append-only/i);
  });
});
