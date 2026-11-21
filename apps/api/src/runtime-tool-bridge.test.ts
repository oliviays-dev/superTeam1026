import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("M13c Runtime Tool Request browser boundary", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ('local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ('m13c-regular', 'human', 'M13c Regular', 'active', 'system', 'local',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
    );
    await setFlag(true);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m13c-api-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await setFlag(false);
    await app.close();
    await database.close();
  });

  async function setFlag(enabled: boolean): Promise<void> {
    await repositories.featureFlags.set({
      flagKey: MCP_RUNTIME_TOOL_BRIDGE_FLAG,
      scopeType: "platform",
      scopeId: "platform",
      mode: enabled ? "on" : "off",
      updatedBy: "test:m13c-api",
    });
  }

  it("exposes no browser Runtime Tool Request submission route", async () => {
    const runId = randomUUID();
    const runScoped = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/runtime-tool-requests`,
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: {
        requestId: randomUUID(),
        toolKey: "a".repeat(64),
        gateId: randomUUID(),
        idempotencyKey: "browser-must-not-submit",
        arguments: { secret: "browser-must-not-call" },
      },
    });
    expect(runScoped.statusCode).toBe(404);

    const global = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-tool-requests",
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: {
        runId,
      },
    });
    expect(global.statusCode).toBe(404);

    const missingRead = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}/runtime-tool-requests`,
      headers: { "x-pluginmax-actor": "local-admin" },
    });
    expect(missingRead.statusCode).toBe(404);
  });

  it("restricts Runtime Tool Request operations to Platform Admin", async () => {
    const summary = await app.inject({
      method: "GET",
      url: "/api/v1/admin/runtime-tool-requests/summary",
      headers: { "x-pluginmax-actor": "local-admin" },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      total: expect.any(Number),
      running: 0,
      staleRunning: 0,
      oldestRunningAgeSeconds: expect.any(Number),
      alertLevel: expect.stringMatching(/^(ok|warning|critical)$/),
      alertReasons: expect.any(Array),
    });
    const metrics = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain(
      '# TYPE pluginmax_runtime_tool_requests gauge',
    );
    expect(metrics.body).toContain(
      'pluginmax_runtime_tool_requests{status="succeeded"}',
    );

    const reconciled = await app.inject({
      method: "POST",
      url: "/api/v1/admin/runtime-tool-requests/reconcile",
      headers: { "x-pluginmax-actor": "local-admin" },
      payload: { limit: 10 },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toEqual({ reconciled: 0 });

    const retention = await app.inject({
      method: "GET",
      url: "/api/v1/admin/runtime-tool-requests/retention?retentionDays=90",
      headers: { "x-pluginmax-actor": "local-admin" },
    });
    expect(retention.statusCode).toBe(200);
    expect(retention.json()).toMatchObject({
      retentionDays: 90,
      eligibleRequests: expect.any(Number),
      eligibleReceipts: expect.any(Number),
      dryRun: true,
      action: "archive-before-delete",
    });

    const forbiddenSummary = await app.inject({
      method: "GET",
      url: "/api/v1/admin/runtime-tool-requests/summary",
      headers: { "x-pluginmax-actor": "m13c-regular" },
    });
    expect(forbiddenSummary.statusCode).toBe(403);
    expect(forbiddenSummary.json()).toMatchObject({
      code: "forbidden",
    });

    const forbiddenReconcile = await app.inject({
      method: "POST",
      url: "/api/v1/admin/runtime-tool-requests/reconcile",
      headers: { "x-pluginmax-actor": "m13c-regular" },
      payload: { limit: 10 },
    });
    expect(forbiddenReconcile.statusCode).toBe(403);

    await setFlag(false);
    const disabled = await app.inject({
      method: "GET",
      url: "/api/v1/admin/runtime-tool-requests/summary",
      headers: { "x-pluginmax-actor": "local-admin" },
    });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toMatchObject({
      code: "mcp_runtime_tool_bridge_disabled",
    });
    await setFlag(true);
  });
});
