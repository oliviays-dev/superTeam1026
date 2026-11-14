import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  MarketAssetDetail,
  MarketEntitlement,
  MarketInstallResult,
  MarketTemplate,
  MarketTemplateCopyResult,
  WorkbenchBootstrap,
  WorkbenchDetail,
  WorkbenchPanelData,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M8 Workbench V2 and Resource Market PostgreSQL integration", () => {
  const projectId = randomUUID();
  const workspaceId = "m8-workspace";
  const ownerActor = "m8-owner";
  const outsiderActor = "m8-outsider";
  const publisherActor = "m8-publisher";
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let market: ReturnType<typeof buildApi>["market"];
  let ownerBootstrap: WorkbenchBootstrap;
  let panelAsset: MarketAssetDetail;
  let dependencyAsset: MarketAssetDetail;
  let templateAsset: MarketAssetDetail;
  let templateId: string;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m8-")),
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
         ($1, 'human', 'M8 Owner', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($2, 'human', 'M8 Outsider', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($3, 'human', 'M8 Publisher', 'active', 'system', 'local',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [ownerActor, outsiderActor, publisherActor],
    );
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, 'M8 Workbench Project', $2, '', 'active', NOW(), NOW())`,
      [projectId, `M8-${projectId.slice(0, 8)}`],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'M8 Workspace', 'active', 'local-admin', 1, NOW(), NOW())`,
      [workspaceId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [randomUUID(), workspaceId, ownerActor],
    );
    await database.query(
      `INSERT INTO project_members (
         id, project_id, kind, actor_id, principal_id, name, responsibility,
         status, is_owner, created_at, updated_at
       ) VALUES ($1, $2, 'human', $3, $3, 'M8 Owner', '', 'active', FALSE,
         NOW(), NOW())`,
      [randomUUID(), projectId, ownerActor],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, 'project', $3, 'MEMBER', '["read","write"]'::jsonb,
         'active', 'manual', 'm8-owner', 'local-admin', NULL, NOW(), NULL,
         NULL, 1, NOW(), NOW()
       )`,
      [randomUUID(), ownerActor, projectId],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status, agent_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'M8 layout task', '', '[]'::jsonb, 'in_progress',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [randomUUID(), projectId],
    );
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function setFlag(flag: "workbench.v2" | "market", mode: "on" | "off") {
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
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    expectedStatus = 200,
    idempotencyKey?: string,
  ): Promise<T> {
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
    const response = await app.inject(options);
    const body =
      response.body === "" ? undefined : (response.json() as unknown);
    expect(
      response.statusCode,
      `${method} ${url}: ${JSON.stringify(body)}`,
    ).toBe(expectedStatus);
    return body as T;
  }

  async function response(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

  it("keeps Workbench V2 and Market disabled by default", async () => {
    const bootstrap = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    expect(bootstrap.enabled).toBe(false);
    expect(bootstrap.marketEnabled).toBe(false);
    expect(bootstrap.defaultWorkbench).toBeNull();
    const market = await response(
      "GET",
      "/api/v1/market/assets",
      undefined,
      ownerActor,
    );
    expect(market.statusCode).toBe(503);
    expect(market.json()).toMatchObject({ code: "market_disabled" });
  });

  it("creates a cross-device default layout and enforces revision CAS", async () => {
    await setFlag("workbench.v2", "on");
    ownerBootstrap = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    expect(ownerBootstrap.enabled).toBe(true);
    expect(ownerBootstrap.defaultWorkbench?.layout.isDefault).toBe(true);
    expect(ownerBootstrap.defaultWorkbench?.layout.isFactoryDefault).toBe(true);
    expect(ownerBootstrap.defaultWorkbench?.layoutVersion.revision).toBe(
      ownerBootstrap.defaultWorkbench?.layout.revision,
    );
    const refreshed = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    expect(refreshed.defaultWorkbench?.layout.id).toBe(
      ownerBootstrap.defaultWorkbench?.layout.id,
    );
    expect(refreshed.defaultWorkbench?.layout.revision).toBe(
      ownerBootstrap.defaultWorkbench?.layout.revision,
    );

    const detail = refreshed.defaultWorkbench!;
    const document = {
      version: 1 as const,
      panels: detail.layout.document.panels.map((panel) => ({
        ...panel,
        width: panel.pluginId === "brief" ? 4 : panel.width,
      })),
    };
    const payload = {
      expectedRevision: detail.layout.revision,
      name: detail.layout.name,
      document,
    };
    const url = `/api/v1/workbenches/${detail.workbench.id}/layouts/${detail.layout.id}`;
    const concurrent = await Promise.all([
      response("PUT", url, payload, ownerActor),
      response("PUT", url, payload, ownerActor),
    ]);
    expect(concurrent.map((item) => item.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const conflict = concurrent.find((item) => item.statusCode === 409);
    expect(conflict?.json()).toMatchObject({
      code: "workbench_revision_conflict",
    });
    const layoutVersions = await request<{
      items: Array<{ revision: number; layoutId: string }>;
    }>(
      "GET",
      `/api/v1/workbenches/${detail.workbench.id}/layouts/${detail.layout.id}/versions`,
      undefined,
      ownerActor,
    );
    expect(layoutVersions.items[0]?.revision).toBeGreaterThan(1);
    expect(layoutVersions.items[0]?.layoutId).toBe(detail.layout.id);

    const createdLayout = await request<WorkbenchDetail>(
      "POST",
      `/api/v1/workbenches/${detail.workbench.id}/layouts`,
      {
        name: "Focused",
        makeDefault: true,
        document,
      },
      ownerActor,
      201,
    );
    expect(createdLayout.layout.isDefault).toBe(true);
    const defaults = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM workbench_layouts
       WHERE owner_principal_id = $1
         AND is_default
         AND status = 'active'`,
      [ownerActor],
    );
    expect(defaults.rows[0]?.count).toBe("1");
  });

  it("degrades unknown and disabled panels without failing the page", async () => {
    const detail = await request<WorkbenchDetail>(
      "GET",
      `/api/v1/workbenches/${ownerBootstrap.defaultWorkbench!.workbench.id}`,
      undefined,
      ownerActor,
    );
    await database.query(
      `UPDATE workbench_panels
       SET status = 'disabled', updated_at = NOW()
       WHERE plugin_id = 'control'`,
    );
    await database.query(
      `INSERT INTO workbench_panels (
         plugin_id, version, title, trusted_build, status, default_width,
         min_height, max_height, refreshable, build_digest, created_at,
         updated_at
       ) VALUES (
         'legacy.removed', '0.8.0', 'Legacy Removed', TRUE, 'active', 2,
         190, 900, TRUE, repeat('a', 64), NOW(), NOW()
       ) ON CONFLICT (plugin_id) DO NOTHING`,
    );
    await database.query(
      `INSERT INTO workbench_panel_instances (
         id, layout_id, plugin_id, position, width, height, config, enabled,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'legacy.removed', 100, 2, NULL, '{}'::jsonb, TRUE,
         NOW(), NOW()
       ) ON CONFLICT (layout_id, plugin_id) DO NOTHING`,
      [randomUUID(), detail.layout.id],
    );
    const degraded = await request<WorkbenchDetail>(
      "GET",
      `/api/v1/workbenches/${detail.workbench.id}`,
      undefined,
      ownerActor,
    );
    expect(
      degraded.panels.find((panel) => panel.pluginId === "control")?.state,
    ).toBe("disabled");
    expect(
      degraded.panels.find((panel) => panel.pluginId === "legacy.removed")
        ?.state,
    ).toBe("unknown");
    expect(degraded.panels.filter((panel) => panel.state === "ready").length).toBeGreaterThan(
      0,
    );
  });

  it("rejects dynamic code and accepts only trusted static panel assets", async () => {
    await setFlag("market", "on");
    const initialCatalog = await request<{ items: MarketAssetDetail[] }>(
      "GET",
      "/api/v1/market/assets",
      undefined,
      "local-admin",
    );
    expect(initialCatalog.items).toEqual([]);
    const rejected = await response(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m8.dynamic.panel",
        kind: "panel",
        name: "Dynamic panel",
        trustLevel: "official",
        visibility: "public",
      },
      "local-admin",
    );
    expect(rejected.statusCode).toBe(201);
    const rejectedAsset = rejected.json() as MarketAssetDetail;
    const populatedCatalog = await request<{ items: MarketAssetDetail[] }>(
      "GET",
      "/api/v1/market/assets",
      undefined,
      "local-admin",
    );
    expect(populatedCatalog.items.map((item) => item.id)).toContain(
      rejectedAsset.id,
    );
    const dynamicVersion = await response(
      "POST",
      `/api/v1/market/assets/${rejectedAsset.id}/versions`,
      {
        manifest: { panelPluginId: "remote.example.panel" },
        compatibility: { minHostVersion: "2.0.0" },
      },
      "local-admin",
    );
    expect(dynamicVersion.statusCode).toBe(400);
    expect(dynamicVersion.json()).toMatchObject({
      code: "market_manifest_has_dynamic_code",
    });

    panelAsset = await request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m8.static.sample",
        kind: "panel",
        name: "Static sample",
        trustLevel: "official",
        visibility: "public",
      },
      "local-admin",
      201,
    );
    const version = await request<MarketAssetDetail["versions"][number]>(
      "POST",
      `/api/v1/market/assets/${panelAsset.id}/versions`,
      {
        manifest: {
          summary: "Trusted static panel",
          panelPluginId: "market.sample",
          permissions: ["project.read"],
          capabilities: ["project.read"],
        },
        compatibility: { minHostVersion: "2.0.0" },
      },
      "local-admin",
      201,
    );
    expect(version.digest).toMatch(/^[a-f0-9]{64}$/);
    panelAsset = await request<MarketAssetDetail>(
      "GET",
      `/api/v1/market/assets/${panelAsset.id}`,
      undefined,
      "local-admin",
    );
  });

  it("keeps asset versions and digests immutable", async () => {
    const version = panelAsset.versions[0]!;
    await expect(
      database.query(
        `UPDATE market_asset_versions SET digest = repeat('b', 64)
         WHERE id = $1`,
        [version.id],
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      database.query("DELETE FROM market_asset_versions WHERE id = $1", [
        version.id,
      ]),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("does not widen project permissions when granting or installing entitlements", async () => {
    const entitlement = await request<MarketEntitlement>(
      "POST",
      "/api/v1/market/entitlements",
      {
        principalId: outsiderActor,
        assetId: panelAsset.id,
      },
      "local-admin",
      201,
    );
    expect(entitlement.grantsAuthorization).toBe(false);
    const install = await request<MarketInstallResult>(
      "POST",
      "/api/v1/market/installations",
      { assetId: panelAsset.id, version: 1, config: {} },
      outsiderActor,
      201,
      "m8-install-outsider",
    );
    expect(install.installation.grantsAuthorization).toBe(false);
    const grants = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM role_grants
       WHERE principal_id = $1 AND scope_type = 'project'`,
      [outsiderActor],
    );
    expect(grants.rows[0]?.count).toBe("0");
    const allEntitlements = await request<{ items: MarketEntitlement[] }>(
      "GET",
      "/api/v1/market/entitlements?all=1",
      undefined,
      "local-admin",
    );
    expect(
      allEntitlements.items.some(
        (item) =>
          item.principalId === outsiderActor && item.assetId === panelAsset.id,
      ),
    ).toBe(true);
    expect(
      (
        await response(
          "GET",
          "/api/v1/market/entitlements?all=1",
          undefined,
          ownerActor,
        )
      ).statusCode,
    ).toBe(403);

    const outsiderWorkbench = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      outsiderActor,
    );
    const detail = outsiderWorkbench.defaultWorkbench!;
    const panel = await request<WorkbenchDetail>(
      "PUT",
      `/api/v1/workbenches/${detail.workbench.id}/layouts/${detail.layout.id}`,
      {
        expectedRevision: detail.layout.revision,
        document: {
          version: 1,
          panels: [
            {
              pluginId: "market.sample",
              position: 0,
              width: 3,
              height: null,
              config: {},
              enabled: true,
            },
          ],
        },
      },
      outsiderActor,
    );
    const marketPanel = panel.panels.find(
      (item) => item.pluginId === "market.sample",
    )!;
    const forbidden = await request<WorkbenchPanelData>(
      "GET",
      `/api/v1/workbenches/${detail.workbench.id}/panels/${marketPanel.instanceId}/data?projectId=${projectId}`,
      undefined,
      outsiderActor,
    );
    expect(forbidden.state).toBe("forbidden");
    expect(forbidden.data).toBeNull();
  });

  it("returns no stale panel data after entitlement or Project revoke", async () => {
    const outsiderWorkbench = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      outsiderActor,
    );
    const detail = outsiderWorkbench.defaultWorkbench!;
    const marketPanel = detail.panels.find(
      (item) => item.pluginId === "market.sample",
    )!;
    const ready = await request<WorkbenchPanelData>(
      "GET",
      `/api/v1/workbenches/${detail.workbench.id}/panels/${marketPanel.instanceId}/data`,
      undefined,
      outsiderActor,
    );
    expect(ready.state).toBe("ready");
    const entitlement = await request<{ items: MarketEntitlement[] }>(
      "GET",
      "/api/v1/market/entitlements",
      undefined,
      outsiderActor,
    );
    await request(
      "DELETE",
      `/api/v1/market/entitlements/${entitlement.items[0]!.id}`,
      undefined,
      "local-admin",
    );
    const revoked = await request<WorkbenchPanelData>(
      "GET",
      `/api/v1/workbenches/${detail.workbench.id}/panels/${marketPanel.instanceId}/data`,
      undefined,
      outsiderActor,
    );
    expect(revoked.state).toBe("needs_entitlement");
    expect(revoked.data).toBeNull();

    const ownerWorkbench = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    const ownerDetail = ownerWorkbench.defaultWorkbench!;
    const todo = ownerDetail.panels.find((item) => item.pluginId === "todo")!;
    const before = await request<WorkbenchPanelData>(
      "GET",
      `/api/v1/workbenches/${ownerDetail.workbench.id}/panels/${todo.instanceId}/data?projectId=${projectId}`,
      undefined,
      ownerActor,
    );
    expect(before.state).toBe("ready");
    await database.query(
      `UPDATE role_grants
       SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
       WHERE principal_id = $1 AND scope_type = 'project' AND scope_id = $2`,
      [ownerActor, projectId],
    );
    const after = await request<WorkbenchPanelData>(
      "GET",
      `/api/v1/workbenches/${ownerDetail.workbench.id}/panels/${todo.instanceId}/data?projectId=${projectId}`,
      undefined,
      ownerActor,
    );
    expect(after.state).toBe("forbidden");
    expect(after.data).toBeNull();
  });

  it("makes install, dependency install, template copy and rollback idempotent", async () => {
    const entitlement = await request<MarketEntitlement>(
      "POST",
      "/api/v1/market/entitlements",
      {
        principalId: publisherActor,
        assetId: panelAsset.id,
      },
      "local-admin",
      201,
    );
    expect(entitlement.status).toBe("active");
    const first = await request<MarketInstallResult>(
      "POST",
      "/api/v1/market/installations",
      { assetId: panelAsset.id, version: 1, config: {} },
      publisherActor,
      201,
      "m8-install-idempotent",
    );
    expect(first.created).toBe(true);
    const replay = await request<MarketInstallResult>(
      "POST",
      "/api/v1/market/installations",
      { assetId: panelAsset.id, version: 1, config: {} },
      publisherActor,
      201,
      "m8-install-idempotent",
    );
    expect(replay.installation.id).toBe(first.installation.id);

    dependencyAsset = await request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m8.template.dependency",
        kind: "skill",
        name: "Template dependency",
        trustLevel: "official",
        visibility: "public",
      },
      "local-admin",
      201,
    );
    await request(
      "POST",
      `/api/v1/market/assets/${dependencyAsset.id}/versions`,
      {
        manifest: { summary: "Required dependency" },
        compatibility: { minHostVersion: "2.0.0" },
      },
      "local-admin",
      201,
    );

    templateAsset = await request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m8.workbench.template",
        kind: "workbench-template",
        name: "M8 Workbench Template",
        trustLevel: "official",
        visibility: "public",
      },
      "local-admin",
      201,
    );
    await request(
      "POST",
      `/api/v1/market/assets/${templateAsset.id}/versions`,
      {
        manifest: {
          summary: "Reusable Workbench layout",
          template: {
            version: 1,
            panels: [
              {
                pluginId: "brief",
                position: 0,
                width: 6,
                height: null,
                config: {},
                enabled: true,
              },
            ],
          },
          dependencies: [
            {
              dependencyAssetKey: dependencyAsset.assetKey,
              minimumVersion: 1,
              required: true,
            },
          ],
        },
        compatibility: { minHostVersion: "2.0.0" },
      },
      "local-admin",
      201,
    );
    const templateEntitlement = await request<MarketEntitlement>(
      "POST",
      "/api/v1/market/entitlements",
      {
        principalId: publisherActor,
        assetId: templateAsset.id,
      },
      "local-admin",
      201,
    );
    expect(templateEntitlement.status).toBe("active");
    const templates = await request<{ items: MarketTemplate[] }>(
      "GET",
      "/api/v1/market/templates",
      undefined,
      publisherActor,
    );
    const template = templates.items.find(
      (item) => item.assetId === templateAsset.id,
    )!;
    templateId = template.id;
    const blocked = await response(
      "POST",
      `/api/v1/market/templates/${template.id}/copy`,
      { version: 1, name: "Blocked copy" },
      publisherActor,
      "m8-copy-blocked",
    );
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: "market_template_dependencies_unmet",
    });

    const dependencyEntitlement = await request<MarketEntitlement>(
      "POST",
      "/api/v1/market/entitlements",
      {
        principalId: publisherActor,
        assetId: dependencyAsset.id,
      },
      "local-admin",
      201,
    );
    await request(
      "POST",
      "/api/v1/market/installations",
      { assetId: dependencyAsset.id, version: 1, config: {} },
      publisherActor,
      201,
      "m8-install-dependency",
    );
    expect(dependencyEntitlement.status).toBe("active");
    const copied = await request<MarketTemplateCopyResult>(
      "POST",
      `/api/v1/market/templates/${template.id}/copy`,
      { version: 1, name: "Copied Workbench" },
      publisherActor,
      201,
      "m8-copy-template",
    );
    expect(copied.copy.status).toBe("active");
    const copyReplay = await request<MarketTemplateCopyResult>(
      "POST",
      `/api/v1/market/templates/${template.id}/copy`,
      { version: 1, name: "Copied Workbench" },
      publisherActor,
      201,
      "m8-copy-template",
    );
    expect(copyReplay.workbenchId).toBe(copied.workbenchId);
    const uninstalled = await request<MarketTemplateCopyResult["copy"]>(
      "DELETE",
      `/api/v1/market/templates/${template.id}/copy`,
      undefined,
      publisherActor,
    );
    expect(uninstalled.status).toBe("uninstalled");
    const rollback = await request<MarketInstallResult>(
      "POST",
      "/api/v1/market/installations/rollback",
      { assetId: panelAsset.id, version: 1 },
      publisherActor,
      200,
      "m8-rollback-panel",
    );
    expect(rollback.installation.assetVersion).toBe(1);

    await database.query(
      `DELETE FROM market_template_copies
       WHERE principal_id = $1 AND template_id = $2`,
      [publisherActor, template.id],
    );
    const recovery = await market.recoverTemplateCopyOrphans(
      {
        principalId: publisherActor,
        authSource: "local-development",
        platformAdministrator: false,
      },
      { templateId: template.id, olderThanSeconds: 0 },
    );
    expect(recovery).toMatchObject({
      scannedWorkbenches: 1,
      compensatedWorkbenches: 1,
    });
    const archived = await database.query<{ status: string }>(
      "SELECT status FROM workbenches WHERE id = $1",
      [copied.workbenchId],
    );
    expect(archived.rows[0]?.status).toBe("archived");
    const compensationAudit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'market.template.copy.compensated'
         AND metadata ->> 'workbenchId' = $1
         AND metadata ->> 'templateId' = $2`,
      [copied.workbenchId, template.id],
    );
    expect(compensationAudit.rows[0]?.count).toBe("1");
  });

  it("fences disabled write paths and does not auto-resume on re-enable", async () => {
    const beforeCounts = await database.query<{
      readonly workbenches: string;
      readonly layouts: string;
      readonly installations: string;
      readonly copies: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM workbenches) AS workbenches,
         (SELECT COUNT(*)::text FROM workbench_layouts) AS layouts,
         (SELECT COUNT(*)::text FROM market_installations) AS installations,
         (SELECT COUNT(*)::text FROM market_template_copies) AS copies`,
    );
    const before = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    await setFlag("workbench.v2", "off");
    await setFlag("market", "off");

    const disabled = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    expect(disabled).toMatchObject({
      enabled: false,
      marketEnabled: false,
      workbenches: [],
      defaultWorkbench: null,
    });
    expect(
      (await response("GET", "/api/v1/market/assets", undefined, ownerActor))
        .statusCode,
    ).toBe(503);
    expect(
      (
        await response(
          "GET",
          `/api/v1/workbenches/${before.defaultWorkbench!.workbench.id}`,
          undefined,
          ownerActor,
        )
      ).statusCode,
    ).toBe(503);

    const writeAttempts = await Promise.all([
      response(
        "POST",
        "/api/v1/workbenches",
        { name: "Must stay fenced" },
        ownerActor,
      ),
      response(
        "POST",
        "/api/v1/market/assets",
        {
          assetKey: `m8.fenced.${Date.now()}`,
          kind: "skill",
          name: "Fenced asset",
          trustLevel: "official",
          visibility: "public",
        },
        "local-admin",
      ),
      response(
        "POST",
        `/api/v1/market/assets/${panelAsset.id}/versions`,
        {
          manifest: {
            panelPluginId: "market.sample",
          },
          compatibility: { minHostVersion: "2.0.0" },
        },
        "local-admin",
      ),
      response(
        "POST",
        `/api/v1/market/assets/${panelAsset.id}/status`,
        { status: "delisted", expectedRevision: panelAsset.revision },
        "local-admin",
      ),
      response(
        "POST",
        `/api/v1/market/assets/${panelAsset.id}/versions/1/status`,
        { status: "deprecated" },
        "local-admin",
      ),
      response(
        "POST",
        "/api/v1/market/entitlements",
        { principalId: outsiderActor, assetId: panelAsset.id },
        "local-admin",
      ),
      response(
        "POST",
        "/api/v1/market/installations",
        { assetId: panelAsset.id, version: 1, config: {} },
        outsiderActor,
        "m8-fenced-install",
      ),
      response(
        "POST",
        `/api/v1/market/templates/${templateId}/copy`,
        { version: 1, name: "Fenced copy" },
        publisherActor,
        "m8-fenced-copy",
      ),
    ]);
    expect(writeAttempts.map((item) => item.statusCode)).toEqual(
      writeAttempts.map(() => 503),
    );

    await setFlag("workbench.v2", "on");
    await setFlag("market", "on");
    const reopened = await request<WorkbenchBootstrap>(
      "GET",
      "/api/v1/workbenches",
      undefined,
      ownerActor,
    );
    expect(reopened.enabled).toBe(true);
    expect(reopened.defaultWorkbench?.workbench.id).toBe(
      before.defaultWorkbench?.workbench.id,
    );
    expect(reopened.defaultWorkbench?.layout.revision).toBe(
      before.defaultWorkbench?.layout.revision,
    );
    const afterCounts = await database.query<{
      readonly workbenches: string;
      readonly layouts: string;
      readonly installations: string;
      readonly copies: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM workbenches) AS workbenches,
         (SELECT COUNT(*)::text FROM workbench_layouts) AS layouts,
         (SELECT COUNT(*)::text FROM market_installations) AS installations,
         (SELECT COUNT(*)::text FROM market_template_copies) AS copies`,
    );
    expect(afterCounts.rows[0]).toEqual(beforeCounts.rows[0]);
  });
});
