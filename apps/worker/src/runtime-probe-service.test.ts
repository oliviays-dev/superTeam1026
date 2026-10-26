import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Database,
  PlatformRepositories,
  migrate,
} from "@pluginmax/database";
import { RuntimeProbeService } from "./runtime-probe-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("RuntimeProbeService PostgreSQL execution", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let service: RuntimeProbeService;
  const actorId = `probe-worker-${randomUUID()}`;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    service = new RuntimeProbeService(repositories, {
      owner: `worker-${randomUUID()}`,
      workspaceRoot: await mkdtemp(
        join(tmpdir(), "pluginmax-runtime-probes-"),
      ),
      timeoutMs: 5_000,
      leaseSeconds: 30,
    });
  });

  afterAll(async () => {
    await database.close();
  });

  async function createRuntime(command: string) {
    return repositories.externalRuntimes.create(
      {
        name: `Probe runtime ${randomUUID().slice(0, 8)}`,
        provider: "codex",
        protocol: "codex-jsonl",
        command,
        managedArgs: [],
        customArgs: [],
        supportedModels: [],
        defaultModel: null,
        contextWindowTokens: 128_000,
        supportedTools: ["structured_plan", "structured_tool_events"],
        networkMode: "restricted",
        sandboxMode: "read-only",
        visibility: "owner",
      },
      actorId,
      actorId,
    );
  }

  it("executes the controlled --version argv and persists a capability snapshot", async () => {
    const runtime = await createRuntime(process.execPath);
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      actorId,
    });
    expect(requested.kind).toBe("requested");
    expect(await service.runOnce()).toBe(1);
    const probe = await repositories.externalRuntimes.latestProbe(runtime.id);
    expect(probe).toMatchObject({
      status: "passed",
      exitCode: 0,
      timedOut: false,
    });
    expect(probe?.runtimeVersion).toContain("v");
    const capabilities =
      await repositories.externalRuntimes.listCapabilities(runtime.id);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.adapterProfile.structuredPlan).toBe("supported");
    expect(capabilities[0]?.declaredProfile.structuredPlan).toBe("supported");
    expect(capabilities[0]?.effectiveProfile.structuredPlan).toBe("supported");
    const outbox = await database.query<{ status: string }>(
      `SELECT status FROM domain_outbox
       WHERE topic = 'runtime.probe'
         AND payload ->> 'runtimeId' = $1::text
       ORDER BY created_at DESC
       LIMIT 1`,
      [runtime.id],
    );
    expect(outbox.rows[0]?.status).toBe("published");
  });

  it("records a failed Probe without enabling the runtime", async () => {
    const runtime = await createRuntime(
      `/missing-pluginmax-probe-${randomUUID()}`,
    );
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      actorId,
    });
    expect(requested.kind).toBe("requested");
    expect(await service.runOnce()).toBe(1);
    const probe = await repositories.externalRuntimes.latestProbe(runtime.id);
    expect(probe).toMatchObject({
      status: "failed",
      errorCode: "probe_spawn_failed",
    });
    const attemptEnable = await repositories.externalRuntimes.transition({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      nextStatus: "active",
      actorId,
      requirePassedProbe: true,
    });
    expect(attemptEnable.kind).toBe("probe_required");
  });
});
