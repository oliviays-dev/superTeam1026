import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  MarketAssetDetail,
  MarketAssetResourceBinding,
  McpProvider,
  McpProviderDetail,
  McpProviderProbeRequestResult,
  McpProviderToolList,
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
const owner = "m13a-owner";
const otherOwner = "m13a-other-owner";
const credentialRef = "env://PLUGINMAX_MCP_TEST_TOKEN";
const rawCredential = `mcp-secret-${randomUUID()}`;

integration("M13a MCP Provider control plane", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let provider: McpProvider;

  beforeAll(async () => {
    process.env.PLUGINMAX_MCP_TEST_TOKEN = rawCredential;
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-m13a-")),
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ('local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($1, 'human', 'M13a Owner', 'active', 'system', 'local',
          1, NOW(), NOW()),
         ($2, 'human', 'M13a Other Owner', 'active', 'system', 'local',
          1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [owner, otherOwner],
    );
  });

  afterAll(async () => {
    delete process.env.PLUGINMAX_MCP_TEST_TOKEN;
    await app.close();
    await database.close();
  });

  async function setFlag(flag: string, mode: "on" | "off") {
    await database.query(
      `UPDATE feature_flag_settings
       SET mode = $1, revision = revision + 1, updated_at = NOW()
       WHERE flag_key = $2
         AND scope_type = 'platform'
         AND scope_id = 'platform'`,
      [mode, flag],
    );
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

  async function request<T>(
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    expectedStatus = 200,
  ): Promise<T> {
    const response = await raw(method, url, payload, actorId);
    expect(
      response.statusCode,
      `${method} ${url}: ${response.body}`,
    ).toBe(expectedStatus);
    return response.body === "" ? (undefined as T) : (response.json() as T);
  }

  async function createProvider(input: {
    readonly providerKey: string;
    readonly actor?: string;
    readonly authKind?: "none" | "bearer" | "header";
  }): Promise<McpProviderDetail> {
    return request<McpProviderDetail>(
      "POST",
      "/api/v1/mcp-providers",
      {
        providerKey: input.providerKey,
        name: input.providerKey,
        description: "M13a integration provider",
        transport: "streamable-http",
        endpointUrl: `https://${input.providerKey}.example.test/mcp`,
        authKind: input.authKind ?? "bearer",
        credentialRef:
          input.authKind === "none" ? null : credentialRef,
        credentialHeaderName: null,
        requestTimeoutMs: 5_000,
      },
      input.actor ?? owner,
      201,
    );
  }

  async function completeProbe(input: {
    readonly detail: McpProviderDetail;
    readonly passed: boolean;
    readonly errorCategory?:
      | "timeout"
      | "dns"
      | "tls"
      | "authentication"
      | "authorization"
      | "http_status"
      | "protocol"
      | "schema"
      | "network"
      | "credential"
      | "unknown";
  }) {
    const requested = await request<McpProviderProbeRequestResult>(
      "POST",
      `/api/v1/mcp-providers/${input.detail.provider.id}/probes`,
      { expectedRevision: input.detail.provider.revision },
      owner,
      202,
    );
    const job = await repositories.mcpProviders.claimProbeJob("m13a-worker", 60);
    expect(job?.probeId).toBe(requested.probe.id);
    await repositories.mcpProviders.completeProbeJob({
      probeId: requested.probe.id,
      owner: "m13a-worker",
      leaseToken: job!.leaseToken,
      passed: input.passed,
      durationMs: 25,
      tools: input.passed
        ? [
            {
              name: "orders.lookup",
              description: "Lookup an order by id",
              inputSchema: {
                type: "object",
                properties: { orderId: { type: "string" } },
              },
              outputSchema: null,
              schemaDigest: "a".repeat(64),
            },
          ]
        : [],
      ...(input.errorCategory === undefined
        ? {}
        : {
            errorCategory: input.errorCategory,
            errorCode: "probe_timeout",
            errorMessage: "MCP Provider probe timed out",
          }),
    });
    return request<McpProviderDetail>(
      "GET",
      `/api/v1/mcp-providers/${input.detail.provider.id}`,
      undefined,
      owner,
    );
  }

  it("is inert while the control-plane flag is off", async () => {
    const before = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM mcp_providers)
         + (SELECT COUNT(*) FROM mcp_provider_versions)
         + (SELECT COUNT(*) FROM mcp_provider_probes)
         + (SELECT COUNT(*) FROM mcp_provider_audit_events)
       )::text AS count`,
    );
    const disabled = await raw(
      "POST",
      "/api/v1/mcp-providers",
      {
        providerKey: "m13a.flag.off",
        name: "Flag off",
        endpointUrl: "https://flag-off.example.test/mcp",
        authKind: "none",
      },
      owner,
    );
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json()).toMatchObject({
      code: "mcp_provider_control_plane_disabled",
    });
    const after = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM mcp_providers)
         + (SELECT COUNT(*) FROM mcp_provider_versions)
         + (SELECT COUNT(*) FROM mcp_provider_probes)
         + (SELECT COUNT(*) FROM mcp_provider_audit_events)
       )::text AS count`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    await setFlag("mcp.provider_control_plane", "on");
  });

  it("redacts credential references and rejects non-admin platform checks", async () => {
    const detail = await createProvider({ providerKey: "m13a.catalogue" });
    provider = detail.provider;
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(credentialRef);
    expect(serialized).not.toContain(rawCredential);
    expect(detail.provider).toMatchObject({
      credentialConfigured: true,
      invocationEnabled: false,
      grantsExecution: false,
      endpointHost: "m13a.catalogue.example.test",
    });
    const stored = await database.query<{
      readonly credential_ref: string;
    }>(
      `SELECT credential_ref
       FROM mcp_provider_versions
       WHERE id = $1`,
      [provider.currentVersionId],
    );
    expect(stored.rows[0]?.credential_ref).toBe(credentialRef);

    const sensitiveRows = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM mcp_provider_versions
          WHERE position($1 in credential_ref) > 0 AND credential_ref <> $2)
         + (SELECT COUNT(*) FROM mcp_provider_probes
          WHERE position($1 in COALESCE(error_message, '')) > 0)
         + (SELECT COUNT(*) FROM mcp_provider_audit_events
          WHERE position($1 in (from_state::text || ' ' || to_state::text)) > 0)
         + (SELECT COUNT(*) FROM market_assets
          WHERE position($1 in (description || ' ' || name)) > 0)
       )::text AS count`,
      [rawCredential, credentialRef],
    );
    expect(sensitiveRows.rows[0]?.count).toBe("0");

    const hidden = await raw(
      "GET",
      `/api/v1/mcp-providers/${provider.id}`,
      undefined,
      otherOwner,
    );
    expect(hidden.statusCode).toBe(403);
    const forbiddenPlatformCheck = await raw(
      "POST",
      "/api/v1/admin/mcp-providers/health-check",
      { providerIds: [] },
      otherOwner,
    );
    expect(forbiddenPlatformCheck.statusCode).toBe(403);
    const adminCheck = await request<{ readonly queued: number }>(
      "POST",
      "/api/v1/admin/mcp-providers/health-check",
      { providerIds: [] },
      "local-admin",
    );
    expect(adminCheck.queued).toBe(0);
  });

  it("enforces owner custody and revision CAS", async () => {
    const forbidden = await raw(
      "POST",
      `/api/v1/mcp-providers/${provider.id}/versions`,
      {
        name: "Other owner overwrite",
        description: "",
        transport: "streamable-http",
        endpointUrl: "https://other-owner.example.test/mcp",
        authKind: "none",
        credentialRef: null,
        credentialHeaderName: null,
        requestTimeoutMs: 5_000,
        expectedRevision: provider.revision,
      },
      otherOwner,
    );
    expect(forbidden.statusCode).toBe(403);

    const concurrent = await createProvider({
      providerKey: "m13a.concurrent",
      authKind: "none",
    });
    const payload = {
      name: "Concurrent Provider",
      description: "",
      transport: "streamable-http",
      authKind: "none",
      credentialRef: null,
      credentialHeaderName: null,
      requestTimeoutMs: 5_000,
      expectedRevision: concurrent.provider.revision,
    };
    const responses = await Promise.all([
      raw(
        "POST",
        `/api/v1/mcp-providers/${concurrent.provider.id}/versions`,
        { ...payload, endpointUrl: "https://one.example.test/mcp" },
        owner,
      ),
      raw(
        "POST",
        `/api/v1/mcp-providers/${concurrent.provider.id}/versions`,
        { ...payload, endpointUrl: "https://two.example.test/mcp" },
        owner,
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)?.json(),
    ).toMatchObject({ code: "mcp_provider_revision_conflict" });
  });

  it("classifies failed probes, recovers health, and exposes schemas read-only", async () => {
    provider = (await completeProbe({
      detail: { provider, versions: [], latestProbe: null, tools: [], audit: [] },
      passed: false,
      errorCategory: "timeout",
    })).provider;
    expect(provider).toMatchObject({
      healthStatus: "unhealthy",
      lastErrorCategory: "timeout",
      lastErrorCode: "probe_timeout",
    });

    provider = (await completeProbe({
      detail: { provider, versions: [], latestProbe: null, tools: [], audit: [] },
      passed: true,
    })).provider;
    expect(provider).toMatchObject({
      healthStatus: "healthy",
      discoveryStatus: "ready",
      toolCount: 1,
    });
    const activated = await request<McpProviderDetail>(
      "POST",
      `/api/v1/mcp-providers/${provider.id}/activate`,
      { expectedRevision: provider.revision, reason: "probe passed" },
      owner,
    );
    provider = activated.provider;
    expect(provider.status).toBe("active");

    const tools = await request<McpProviderToolList>(
      "GET",
      `/api/v1/mcp-providers/${provider.id}/tools`,
      undefined,
      owner,
    );
    expect(tools.items[0]).toMatchObject({
      name: "orders.lookup",
      invocationEnabled: false,
      grantsExecution: false,
    });
    expect(tools.items[0]?.toolKey).toMatch(/^[a-f0-9]{64}$/);
    const invoke = await raw(
      "POST",
      `/api/v1/mcp-providers/${provider.id}/tools/orders.lookup/invoke`,
      {},
      owner,
    );
    expect(invoke.statusCode).toBe(404);
  });

  it("binds Market to Provider identity without copying connection or authorization", async () => {
    await setFlag("market", "on");
    await setFlag("market.governance_v2", "on");
    const asset = await request<MarketAssetDetail>(
      "POST",
      "/api/v1/market/assets",
      {
        assetKey: "m13a.market.provider.reference",
        kind: "skill",
        name: "M13a Market Provider Reference",
        description: "",
        origin: "user",
        sharingScope: "private",
        publicationStatus: "published",
      },
      owner,
      201,
    );
    const version = await request<MarketAssetDetail["versions"][number]>(
      "POST",
      `/api/v1/market/assets/${asset.id}/versions`,
      {
        manifest: { summary: "Provider identity reference only" },
        compatibility: { minHostVersion: "2.0.0" },
      },
      owner,
      201,
    );
    const before = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_members)
         + (SELECT COUNT(*) FROM role_grants)
       )::text AS count`,
    );
    const binding = await request<MarketAssetResourceBinding>(
      "POST",
      `/api/v1/market/assets/${asset.id}/bindings`,
      {
        assetVersionId: version.id,
        resourceKind: "mcp_provider",
        resourceId: provider.providerKey,
        resourceVersionId: provider.currentVersionId,
      },
      owner,
      201,
    );
    expect(binding).toMatchObject({
      resourceKind: "mcp_provider",
      resourceId: provider.providerKey,
      resourceVersionId: provider.currentVersionId,
    });
    const after = await database.query<{ readonly count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM project_members)
         + (SELECT COUNT(*) FROM role_grants)
       )::text AS count`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const marketDetail = await request<MarketAssetDetail>(
      "GET",
      `/api/v1/market/assets/${asset.id}`,
      undefined,
      owner,
    );
    const serialized = JSON.stringify(marketDetail);
    expect(serialized).not.toContain(credentialRef);
    expect(serialized).not.toContain(rawCredential);
    expect(serialized).not.toContain("endpointUrl");
  });

  it("discards probe results for a superseded Provider version", async () => {
    const stale = await createProvider({
      providerKey: "m13a.stale.probe",
      authKind: "none",
    });
    const requested = await request<McpProviderProbeRequestResult>(
      "POST",
      `/api/v1/mcp-providers/${stale.provider.id}/probes`,
      { expectedRevision: stale.provider.revision },
      owner,
      202,
    );
    const versioned = await request<McpProviderDetail>(
      "POST",
      `/api/v1/mcp-providers/${stale.provider.id}/versions`,
      {
        name: "Stale Probe Provider v2",
        description: "",
        transport: "streamable-http",
        endpointUrl: "https://m13a.stale.probe.v2.example.test/mcp",
        authKind: "none",
        credentialRef: null,
        credentialHeaderName: null,
        requestTimeoutMs: 5_000,
        expectedRevision: requested.provider.revision,
      },
      owner,
      201,
    );
    const job = await repositories.mcpProviders.claimProbeJob("m13a-worker", 60);
    expect(job?.probeId).toBe(requested.probe.id);
    await repositories.mcpProviders.completeProbeJob({
      probeId: requested.probe.id,
      owner: "m13a-worker",
      leaseToken: job!.leaseToken,
      passed: true,
      durationMs: 10,
      tools: [
        {
          name: "stale.tool",
          description: "",
          inputSchema: { type: "object" },
          outputSchema: null,
          schemaDigest: "b".repeat(64),
        },
      ],
    });
    const current = await request<McpProviderDetail>(
      "GET",
      `/api/v1/mcp-providers/${stale.provider.id}`,
      undefined,
      owner,
    );
    expect(current.provider).toMatchObject({
      currentVersion: 2,
      healthStatus: "unknown",
      discoveryStatus: "not_discovered",
    });
    expect(current.audit[0]?.action).toBe(
      "mcp.provider.probe.stale_result",
    );
    expect(versioned.provider.currentVersion).toBe(2);
  });

  it("keeps Provider audit append-only", async () => {
    const audit = await database.query<{ readonly id: string }>(
      `SELECT id
       FROM mcp_provider_audit_events
       WHERE provider_id = $1
       ORDER BY seq
       LIMIT 1`,
      [provider.id],
    );
    const auditId = audit.rows[0]?.id;
    expect(auditId).toBeDefined();
    await expect(
      database.query(
        `UPDATE mcp_provider_audit_events SET reason = 'mutated' WHERE id = $1`,
        [auditId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query(`DELETE FROM mcp_provider_audit_events WHERE id = $1`, [
        auditId,
      ]),
    ).rejects.toThrow(/append-only/);
  });
});
