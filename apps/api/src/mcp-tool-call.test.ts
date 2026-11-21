import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpProviderDetail } from "@pluginmax/contracts";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_TOOL_INVOCATION_FLAG,
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

integration("M13b MCP Tool call API boundary", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  const ownerA = "m13b-api-owner-a";
  const ownerB = "m13b-api-owner-b";

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m13b-api-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    }).app;
    await app.ready();
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ('local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($1, 'human', 'M13b Owner A', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($2, 'human', 'M13b Owner B', 'active', 'system', 'local',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [ownerA, ownerB],
    );
  });

  afterAll(async () => {
    await setFlag(MCP_TOOL_INVOCATION_FLAG, false);
    await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, false);
    await app.close();
    await database.close();
  });

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    await repositories.featureFlags.set({
      flagKey,
      scopeType: "platform",
      scopeId: "platform",
      mode: enabled ? "on" : "off",
      updatedBy: "test:m13b-api",
    });
  }

  async function raw(
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ) {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    return app.inject(options);
  }

  async function createProvider(
    actorId: string,
    providerKey: string,
  ): Promise<McpProviderDetail> {
    const response = await raw(
      "POST",
      "/api/v1/mcp-providers",
      {
        providerKey,
        name: providerKey,
        description: "M13b API provider",
        transport: "streamable-http",
        endpointUrl: `https://${providerKey}.example.test/mcp`,
        authKind: "none",
        credentialRef: null,
        credentialHeaderName: null,
        requestTimeoutMs: 1_000,
      },
      actorId,
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as McpProviderDetail;
  }

  it("is inert while disabled and exposes no browser invocation route", async () => {
    const before = await callRowCount();
    const disabled = await raw(
      "POST",
      "/api/v1/admin/mcp-tool-calls/reconcile",
      { limit: 10 },
    );
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toMatchObject({
      code: "mcp_tool_invocation_disabled",
    });
    expect(await callRowCount()).toBe(before);

    await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, true);
    await setFlag(MCP_TOOL_INVOCATION_FLAG, true);
    const direct = await raw(
      "POST",
      `/api/v1/mcp-providers/${randomUUID()}/tools/${"a".repeat(64)}/call`,
      { arguments: { secret: "browser-must-not-call" } },
      ownerA,
    );
    expect(direct.statusCode).toBe(404);
    expect(await callRowCount()).toBe(before);
  });

  it("restricts platform reconciliation and Provider custody", async () => {
    const providerA = await createProvider(
      ownerA,
      `m13b.api.${randomUUID().slice(0, 8)}`,
    );
    const providerB = await createProvider(
      ownerB,
      `m13b.api.${randomUUID().slice(0, 8)}`,
    );
    const forbiddenTools = await raw(
      "GET",
      `/api/v1/mcp-providers/${providerB.provider.id}/tools`,
      undefined,
      ownerA,
    );
    expect(forbiddenTools.statusCode).toBe(403);
    const forbiddenReconcile = await raw(
      "POST",
      "/api/v1/admin/mcp-tool-calls/reconcile",
      { limit: 10 },
      ownerA,
    );
    expect(forbiddenReconcile.statusCode).toBe(403);
    const adminReconcile = await raw(
      "POST",
      "/api/v1/admin/mcp-tool-calls/reconcile",
      { limit: 10 },
      "local-admin",
    );
    expect(adminReconcile.statusCode).toBe(200);
    expect(adminReconcile.json()).toMatchObject({ reconciled: 0 });
    const tools = await raw(
      "GET",
      `/api/v1/mcp-providers/${providerA.provider.id}/tools`,
      undefined,
      ownerA,
    );
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      items: [],
    });
    const missingRun = await raw(
      "GET",
      `/api/v1/runs/${randomUUID()}/mcp-tool-calls`,
      undefined,
      ownerA,
    );
    expect(missingRun.statusCode).toBe(404);
  });

  async function callRowCount(): Promise<string> {
    const result = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM mcp_tool_calls) +
         (SELECT COUNT(*) FROM mcp_tool_call_receipts)
       )::text AS count`,
    );
    return result.rows[0]?.count ?? "0";
  }
});
