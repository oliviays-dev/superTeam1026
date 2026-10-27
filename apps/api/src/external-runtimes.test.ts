import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface RuntimeResponse {
  readonly id: string;
  readonly ownerId: string;
  readonly status: "disabled" | "active" | "archived";
  readonly revision: number;
  readonly command: string;
  readonly lastProbe: {
    readonly status: "requested" | "running" | "passed" | "failed";
  } | null;
}

interface DetailResponse {
  readonly runtime: RuntimeResponse;
  readonly latestProbe: {
    readonly status: string;
    readonly exitCode: number | null;
    readonly runtimeVersion: string | null;
  } | null;
}

integration("external runtime management API", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  const administrator = "local-admin";
  const ownerA = `runtime-owner-a-${randomUUID()}`;
  const ownerB = `runtime-owner-b-${randomUUID()}`;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(
        join(tmpdir(), "pluginmax-external-runtime-api-"),
      ),
      logger: false,
      localActorId: administrator,
      expectedMigrationVersion: 28,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function createRuntime(
    actorId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<RuntimeResponse> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runtimes",
      headers: { "x-pluginmax-actor": actorId },
      payload: {
        name: `Runtime ${randomUUID().slice(0, 8)}`,
        provider: "command",
        protocol: "plain-text",
        command: "probe-fixture",
        managedArgs: [],
        customArgs: ["--quiet"],
        supportedModels: [],
        defaultModel: null,
        contextWindowTokens: null,
        supportedTools: ["structured_plan"],
        networkMode: "unknown",
        sandboxMode: "read-only",
        visibility: "owner",
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<RuntimeResponse>();
  }

  async function requestProbe(
    runtime: RuntimeResponse,
    actorId: string,
  ): Promise<{
    runtime: RuntimeResponse;
    probe: { id: string; status: string };
    jobId: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/probe`,
      headers: { "x-pluginmax-actor": actorId },
      payload: { expectedRevision: runtime.revision },
    });
    expect(response.statusCode).toBe(202);
    return response.json();
  }

  async function completeProbeSuccessfully(
    runtimeId: string,
  ): Promise<void> {
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "external-runtime-test-worker",
      30,
      runtimeId,
    );
    expect(claimed).toBeDefined();
    const completed =
      await repositories.externalRuntimes.completeProbeJob({
        jobId: claimed!.jobId,
        owner: "external-runtime-test-worker",
        leaseToken: claimed!.leaseToken,
        exitCode: 0,
        timedOut: false,
        stdoutExcerpt: "fixture-cli 1.2.3",
        stderrExcerpt: "",
      });
    expect(completed).toBe(true);
  }

  it("creates disabled runtimes with revision and append-only audit", async () => {
    const runtime = await createRuntime(ownerA);
    expect(runtime).toMatchObject({
      ownerId: ownerA,
      status: "disabled",
      revision: 1,
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${runtime.id}/events`,
      headers: { "x-pluginmax-actor": ownerA },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "registered",
          actorId: ownerA,
          nextStatus: "disabled",
          changedFields: ["runtime"],
        }),
      ]),
    );
    await expect(
      database.query(
        `UPDATE external_runtime_events
         SET message = 'tampered'
         WHERE runtime_id = $1`,
        [runtime.id],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects shell injection and separates command from argv", async () => {
    const injection = await app.inject({
      method: "POST",
      url: "/api/v1/runtimes",
      headers: { "x-pluginmax-actor": ownerA },
      payload: {
        name: "Injected runtime",
        provider: "command",
        protocol: "plain-text",
        command: "probe-fixture --version",
        managedArgs: [],
        customArgs: [],
        supportedModels: [],
        defaultModel: null,
        contextWindowTokens: null,
        supportedTools: [],
        networkMode: "unknown",
        sandboxMode: "read-only",
        visibility: "owner",
      },
    });
    expect(injection.statusCode).toBe(400);
    expect(injection.json().code).toBe("invalid_input");
  });

  it("enforces ownership and cross-account write isolation", async () => {
    const privateRuntime = await createRuntime(ownerA);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/runtimes?includeArchived=1",
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json<{ items: RuntimeResponse[] }>()
        .items.some((runtime) => runtime.id === privateRuntime.id),
    ).toBe(false);
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${privateRuntime.id}`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(get.statusCode).toBe(403);
    expect(get.json().code).toBe("runtime_forbidden");
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/runtimes/${privateRuntime.id}`,
      headers: { "x-pluginmax-actor": ownerB },
      payload: {
        name: "Cross-account edit",
        expectedRevision: privateRuntime.revision,
      },
    });
    expect(patch.statusCode).toBe(403);
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${privateRuntime.id}/events`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(events.statusCode).toBe(403);
    const capabilities = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${privateRuntime.id}/capabilities`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(capabilities.statusCode).toBe(403);
    const adminGet = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${privateRuntime.id}`,
      headers: { "x-pluginmax-actor": administrator },
    });
    expect(adminGet.statusCode).toBe(200);

    const platformRuntime = await createRuntime(ownerA, {
      visibility: "platform",
    });
    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${platformRuntime.id}`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(readable.statusCode).toBe(200);
    const forbiddenProbe = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${platformRuntime.id}/probe`,
      headers: { "x-pluginmax-actor": ownerB },
      payload: { expectedRevision: platformRuntime.revision },
    });
    expect(forbiddenProbe.statusCode).toBe(403);
  });

  it("queues Probe work transactionally and never enables before success", async () => {
    const runtime = await createRuntime(ownerA);
    const enableTooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/enable`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision },
    });
    expect(enableTooEarly.statusCode).toBe(409);
    expect(enableTooEarly.json().code).toBe("runtime_probe_required");

    const requested = await requestProbe(runtime, ownerA);
    expect(requested.runtime.lastProbe?.status).toBe("requested");
    const counts = await database.query<{
      probes: string;
      jobs: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM external_runtime_probes
          WHERE runtime_id = $1 AND status = 'requested') AS probes,
         (SELECT COUNT(*)::text FROM runtime_probe_jobs
          WHERE runtime_id = $1 AND status = 'queued') AS jobs,
         (SELECT COUNT(*)::text FROM domain_outbox
          WHERE topic = 'runtime.probe'
            AND status = 'pending'
            AND payload ->> 'runtimeId' = $1::text) AS outbox`,
      [runtime.id],
    );
    expect(counts.rows[0]).toEqual({
      probes: "1",
      jobs: "1",
      outbox: "1",
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/probe`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("runtime_probe_in_progress");

    await completeProbeSuccessfully(runtime.id);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${runtime.id}`,
      headers: { "x-pluginmax-actor": ownerA },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<DetailResponse>().latestProbe).toMatchObject({
      status: "passed",
      exitCode: 0,
      runtimeVersion: "fixture-cli 1.2.3",
    });
    const capabilities = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${runtime.id}/capabilities`,
      headers: { "x-pluginmax-actor": ownerA },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().items).toHaveLength(1);
    expect(
      capabilities.json().items[0].effectiveProfile.structuredPlan,
    ).toBe("unsupported");
    await expect(
      database.query(
        `UPDATE external_runtime_probes
         SET error_message = 'tampered'
         WHERE runtime_id = $1 AND status = 'passed'`,
        [runtime.id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      database.query(
        `UPDATE external_runtime_capabilities
         SET effective_profile = '{}'::jsonb
         WHERE runtime_id = $1`,
        [runtime.id],
      ),
    ).rejects.toThrow(/immutable/);

    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/enable`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<RuntimeResponse>()).toMatchObject({
      status: "active",
      revision: runtime.revision + 1,
    });
  });

  it("uses optimistic revision checks and clears Probe state after command changes", async () => {
    const runtime = await createRuntime(ownerA);
    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/runtimes/${runtime.id}`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: {
        name: "Stale edit",
        expectedRevision: runtime.revision + 10,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("runtime_revision_conflict");

    await requestProbe(runtime, ownerA);
    await completeProbeSuccessfully(runtime.id);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/runtimes/${runtime.id}`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: {
        command: "probe-fixture-v2",
        customArgs: ["--verbose"],
        expectedRevision: runtime.revision,
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<RuntimeResponse>()).toMatchObject({
      command: "probe-fixture-v2",
      status: "disabled",
      revision: runtime.revision + 1,
      lastProbe: null,
    });
    const remaining = await database.query<{
      probes: string;
      jobs: string;
      capabilities: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM external_runtime_probes
          WHERE runtime_id = $1) AS probes,
         (SELECT COUNT(*)::text FROM runtime_probe_jobs
          WHERE runtime_id = $1) AS jobs,
         (SELECT COUNT(*)::text FROM external_runtime_capabilities
          WHERE runtime_id = $1) AS capabilities`,
      [runtime.id],
    );
    expect(remaining.rows[0]).toEqual({
      probes: "0",
      jobs: "0",
      capabilities: "0",
    });
    const events = await repositories.externalRuntimes.listEvents(runtime.id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "updated",
          changedFields: expect.arrayContaining(["command", "probe"]),
        }),
      ]),
    );
  });

  it("archives and restores through the explicit state machine", async () => {
    const runtime = await createRuntime(ownerA);
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/archive`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<RuntimeResponse>().status).toBe("archived");
    const hidden = await app.inject({
      method: "GET",
      url: "/api/v1/runtimes",
      headers: { "x-pluginmax-actor": ownerA },
    });
    expect(
      hidden
        .json<{ items: RuntimeResponse[] }>()
        .items.some((item) => item.id === runtime.id),
    ).toBe(false);
    const restore = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/restore`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision + 1 },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json<RuntimeResponse>().status).toBe("disabled");
    const enableWithoutNewProbe = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${runtime.id}/enable`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: runtime.revision + 2 },
    });
    expect(enableWithoutNewProbe.statusCode).toBe(409);
    expect(enableWithoutNewProbe.json().code).toBe(
      "runtime_probe_required",
    );
  });
});
