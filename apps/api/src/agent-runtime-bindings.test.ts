import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalRuntime } from "@pluginmax/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface AgentResponse {
  readonly id: string;
  readonly runtimeKind: string;
}

interface BindingResponse {
  readonly agentId: string;
  readonly binding: {
    readonly id: string;
    readonly runtimeId: string;
    readonly status: "active" | "disabled";
    readonly revision: number;
  } | null;
  readonly runtime: {
    readonly id: string;
    readonly status: string;
  } | null;
}

interface PreflightResponse {
  readonly compatible: boolean;
  readonly bindingRevision: number;
  readonly runtimeRevision: number;
  readonly runtime: {
    readonly runtimeId: string;
    readonly capabilities: Record<string, string>;
  };
  readonly envelopePreview: {
    readonly runtimeId: string;
    readonly workspaceId: string;
    readonly launch: {
      readonly model?: string;
      readonly commandDigest?: string;
      readonly argsDigest?: string;
    };
  };
}

integration("agent runtime binding and preflight API", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let workspaceRoot: string;
  const administrator = "local-admin";
  const ownerA = `binding-api-owner-a-${randomUUID()}`;
  const ownerB = `binding-api-owner-b-${randomUUID()}`;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const testRoot = join(process.cwd(), ".tmp");
    await mkdir(testRoot, { recursive: true });
    workspaceRoot = await mkdtemp(join(testRoot, "pluginmax-binding-api-"));
    app = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: workspaceRoot,
      logger: false,
      localActorId: administrator,
      expectedMigrationVersion: 27,
    }).app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function createAgent(
    actorId = ownerA,
    runtimeKind = "plain-text",
  ): Promise<AgentResponse> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { "x-pluginmax-actor": actorId },
      payload: {
        name: `Binding agent ${randomUUID().slice(0, 8)}`,
        description: "",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind,
        source: "personal",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<AgentResponse>();
  }

  async function createActiveRuntime(
    actorId = ownerA,
    overrides: Record<string, unknown> = {},
  ): Promise<ExternalRuntime> {
    const runtime = await repositories.externalRuntimes.create(
      {
        name: `Preflight runtime ${randomUUID().slice(0, 8)}`,
        provider: "codex",
        protocol: "codex-jsonl",
        command: "preflight-fixture",
        managedArgs: [],
        customArgs: ["--json"],
        supportedModels: ["fixture-model"],
        defaultModel: "fixture-model",
        contextWindowTokens: 64_000,
        supportedTools: [
          "structured_plan",
          "structured_tool_events",
          "read_file",
        ],
        networkMode: "restricted",
        sandboxMode: "read-only",
        visibility: "owner",
        ...overrides,
      },
      actorId,
      actorId,
    );
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      actorId,
    });
    expect(requested.kind).toBe("requested");
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "binding-api-worker",
      30,
      runtime.id,
    );
    expect(claimed).toBeDefined();
    await repositories.externalRuntimes.completeProbeJob({
      jobId: claimed!.jobId,
      owner: "binding-api-worker",
      leaseToken: claimed!.leaseToken,
      exitCode: 0,
      timedOut: false,
      stdoutExcerpt: "codex-fixture 1.0.0",
      stderrExcerpt: "",
    });
    const enabled = await repositories.externalRuntimes.transition({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      nextStatus: "active",
      actorId,
      requirePassedProbe: true,
    });
    expect(enabled.kind).toBe("updated");
    return enabled.kind === "updated" ? enabled.runtime : runtime;
  }

  async function bind(
    agentId: string,
    runtime: ExternalRuntime,
    actorId = ownerA,
    expectedRevision = 0,
    idempotencyKey = `bind-${randomUUID()}`,
  ): Promise<BindingResponse> {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agentId}/runtime-binding`,
      headers: {
        "x-pluginmax-actor": actorId,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        runtimeId: runtime.id,
        expectedRevision,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json<BindingResponse>();
  }

  function preflight(
    agentId: string,
    actorId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/runtime-preflight`,
      headers: { "x-pluginmax-actor": actorId },
      payload: {
        expectedRevision: 1,
        workspaceId: "project/agent-safe",
        model: "fixture-model",
        requiredCapabilities: ["structuredPlan"],
        requiredSandboxMode: "read-only",
        requiredNetworkMode: "restricted",
        ...overrides,
      },
    });
  }

  it("enforces runtime ownership for writes while allowing scoped reads", async () => {
    const agent = await createAgent();
    const privateRuntime = await createActiveRuntime(ownerA);
    const binding = await bind(agent.id, privateRuntime);
    expect(binding.binding).toMatchObject({
      runtimeId: privateRuntime.id,
      status: "active",
      revision: 1,
    });
    const runtimeProjection = await app.inject({
      method: "GET",
      url: `/api/v1/runtimes/${privateRuntime.id}`,
      headers: { "x-pluginmax-actor": ownerA },
    });
    expect(runtimeProjection.statusCode).toBe(200);
    expect(runtimeProjection.json()).toMatchObject({
      runtime: {
        id: privateRuntime.id,
        bindingCount: 1,
        activeBindingCount: 1,
      },
    });

    const forbiddenGet = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.id}/runtime-binding`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(forbiddenGet.statusCode).toBe(403);
    expect(forbiddenGet.json().code).toBe("runtime_forbidden");

    const forbiddenPut = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.id}/runtime-binding`,
      headers: { "x-pluginmax-actor": ownerB },
      payload: { runtimeId: privateRuntime.id, expectedRevision: 1 },
    });
    expect(forbiddenPut.statusCode).toBe(403);
    expect(forbiddenPut.json().code).toBe("runtime_forbidden");
    const forbiddenDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agent.id}/runtime-binding`,
      headers: { "x-pluginmax-actor": ownerB },
      payload: { expectedRevision: 1 },
    });
    expect(forbiddenDelete.statusCode).toBe(403);
    expect(forbiddenDelete.json().code).toBe("runtime_forbidden");

    const platformRuntime = await createActiveRuntime(ownerA, {
      visibility: "platform",
    });
    const platformAgent = await createAgent(ownerA);
    await bind(platformAgent.id, platformRuntime);
    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${platformAgent.id}/runtime-binding`,
      headers: { "x-pluginmax-actor": ownerB },
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json<BindingResponse>().binding?.runtimeId).toBe(
      platformRuntime.id,
    );
    const readablePreflight = await preflight(platformAgent.id, ownerB);
    expect(readablePreflight.statusCode, readablePreflight.body).toBe(200);
  });

  it("returns stable preflight errors with remediation", async () => {
    const unboundAgent = await createAgent();
    const unbound = await preflight(unboundAgent.id, ownerA, {
      expectedRevision: 1,
    });
    expect(unbound.statusCode).toBe(409);
    expect(unbound.json()).toMatchObject({
      code: "runtime_binding_missing",
      details: {
        preflightCode: "runtime_binding_missing",
        remediation: expect.any(String),
      },
    });

    const disabledAgent = await createAgent();
    const agentRuntime = await createActiveRuntime(ownerA);
    await bind(disabledAgent.id, agentRuntime);
    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${disabledAgent.id}/status`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { status: "disabled" },
    });
    const disabledAgentPreflight = await preflight(disabledAgent.id, ownerA);
    expect(disabledAgentPreflight.statusCode).toBe(409);
    expect(disabledAgentPreflight.json().code).toBe("agent_unavailable");

    const disabledRuntime = await createActiveRuntime(ownerA);
    const runtimeDisabledAgent = await createAgent();
    await bind(runtimeDisabledAgent.id, disabledRuntime);
    const disableResponse = await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${disabledRuntime.id}/disable`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: disabledRuntime.revision },
    });
    expect(disableResponse.statusCode).toBe(200);
    const disabled = await preflight(runtimeDisabledAgent.id, ownerA);
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().code).toBe("runtime_inactive");

    const archivedRuntime = await createActiveRuntime(ownerA);
    const archivedAgent = await createAgent();
    await bind(archivedAgent.id, archivedRuntime);
    await app.inject({
      method: "POST",
      url: `/api/v1/runtimes/${archivedRuntime.id}/archive`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: archivedRuntime.revision },
    });
    const archived = await preflight(archivedAgent.id, ownerA);
    expect(archived.statusCode).toBe(409);
    expect(archived.json().code).toBe("runtime_archived");
  });

  it("rejects failed probes, digest drift, model, capability, sandbox, and workspace mismatches", async () => {
    const probeRuntime = await createActiveRuntime(ownerA);
    const probeAgent = await createAgent();
    await bind(probeAgent.id, probeRuntime);
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: probeRuntime.id,
      expectedRevision: probeRuntime.revision,
      actorId: ownerA,
    });
    expect(requested.kind).toBe("requested");
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "binding-api-worker",
      30,
      probeRuntime.id,
    );
    await repositories.externalRuntimes.completeProbeJob({
      jobId: claimed!.jobId,
      owner: "binding-api-worker",
      leaseToken: claimed!.leaseToken,
      exitCode: 1,
      timedOut: false,
      stdoutExcerpt: "",
      stderrExcerpt: "fixture probe failed",
      errorCode: "probe_nonzero_exit",
      errorMessage: "fixture probe failed",
    });
    const failedProbe = await preflight(probeAgent.id, ownerA);
    expect(failedProbe.statusCode).toBe(409);
    expect(failedProbe.json().code).toBe("runtime_probe_failed");

    const digestRuntime = await createActiveRuntime(ownerA);
    const digestAgent = await createAgent();
    await bind(digestAgent.id, digestRuntime);
    await database.query(
      "UPDATE external_runtimes SET args_digest = repeat('c', 64) WHERE id = $1",
      [digestRuntime.id],
    );
    const digest = await preflight(digestAgent.id, ownerA);
    expect(digest.statusCode).toBe(409);
    expect(digest.json().code).toBe("runtime_args_digest_mismatch");

    const declarationRuntime = await createActiveRuntime(ownerA);
    const declarationAgent = await createAgent();
    await bind(declarationAgent.id, declarationRuntime);
    await database.query(
      `UPDATE external_runtimes
       SET supported_tools = '["write_file"]'::jsonb
       WHERE id = $1`,
      [declarationRuntime.id],
    );
    const staleCapability = await preflight(declarationAgent.id, ownerA);
    expect(staleCapability.statusCode).toBe(409);
    expect(staleCapability.json().code).toBe("runtime_probe_stale");

    const policyRuntime = await createActiveRuntime(ownerA);
    const policyAgent = await createAgent();
    await bind(policyAgent.id, policyRuntime);
    const model = await preflight(policyAgent.id, ownerA, {
      model: "unsupported-model",
    });
    expect(model.json().code).toBe("runtime_model_unsupported");
    const capability = await preflight(policyAgent.id, ownerA, {
      requiredCapabilities: ["fileWrite"],
    });
    expect(capability.json().code).toBe("runtime_capability_missing");
    const sandbox = await preflight(policyAgent.id, ownerA, {
      requiredSandboxMode: "workspace-write",
    });
    expect(sandbox.json().code, sandbox.body).toBe(
      "runtime_sandbox_unsupported",
    );
    const workspace = await preflight(policyAgent.id, ownerA, {
      workspaceId: "../escape",
    });
    expect(workspace.statusCode).toBe(400);
    expect(workspace.json().code).toBe("runtime_workspace_invalid");
  });

  it("creates a read-only execution snapshot without spawning or writing business state", async () => {
    const markerPath = join(workspaceRoot, "preflight-spawned");
    const scriptPath = join(workspaceRoot, "preflight-marker.mjs");
    await writeFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(markerPath)}, "spawned");`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(scriptPath, 0o755);
    const runtime = await createActiveRuntime(ownerA, {
      command: scriptPath,
    });
    const agent = await createAgent(ownerA, "codex-jsonl");
    await bind(agent.id, runtime);

    const counts = await database.query<Record<string, string>>(`
      SELECT
        (SELECT COUNT(*)::text FROM runs) AS runs,
        (SELECT COUNT(*)::text FROM jobs) AS jobs,
        (SELECT COUNT(*)::text FROM tasks) AS tasks,
        (SELECT COUNT(*)::text FROM meetings) AS meetings,
        (SELECT COUNT(*)::text FROM direct_chat_turns) AS direct_chat_turns,
        (SELECT COUNT(*)::text FROM domain_outbox) AS outbox,
        (SELECT COUNT(*)::text FROM workflow_idempotency_keys) AS idempotency,
        (SELECT COUNT(*)::text FROM agent_runtime_bindings) AS bindings,
        (SELECT COUNT(*)::text FROM external_runtime_probes) AS probes,
        (SELECT COUNT(*)::text FROM external_runtime_events) AS runtime_events
    `);
    const response = await preflight(agent.id, ownerA);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<PreflightResponse>();
    expect(result).toMatchObject({
      compatible: true,
      bindingRevision: 1,
      runtimeRevision: runtime.revision,
      runtime: {
        runtimeId: runtime.id,
        capabilities: {
          structuredPlan: "supported",
          fileWrite: "unsupported",
        },
      },
      envelopePreview: {
        runtimeId: runtime.id,
        workspaceId: "project/agent-safe",
        launch: {
          model: "fixture-model",
          commandDigest: runtime.commandDigest,
          argsDigest: runtime.argsDigest,
        },
      },
    });
    await expect(access(markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const after = await database.query<Record<string, string>>(`
      SELECT
        (SELECT COUNT(*)::text FROM runs) AS runs,
        (SELECT COUNT(*)::text FROM jobs) AS jobs,
        (SELECT COUNT(*)::text FROM tasks) AS tasks,
        (SELECT COUNT(*)::text FROM meetings) AS meetings,
        (SELECT COUNT(*)::text FROM direct_chat_turns) AS direct_chat_turns,
        (SELECT COUNT(*)::text FROM domain_outbox) AS outbox,
        (SELECT COUNT(*)::text FROM workflow_idempotency_keys) AS idempotency,
        (SELECT COUNT(*)::text FROM agent_runtime_bindings) AS bindings,
        (SELECT COUNT(*)::text FROM external_runtime_probes) AS probes,
        (SELECT COUNT(*)::text FROM external_runtime_events) AS runtime_events
    `);
    expect(after.rows[0]).toEqual(counts.rows[0]);
  });

  it("replays binding writes by Idempotency-Key and rejects stale revisions", async () => {
    const agent = await createAgent();
    const runtime = await createActiveRuntime(ownerA);
    const key = `binding-idempotency-${randomUUID()}`;
    const first = await bind(agent.id, runtime, ownerA, 0, key);
    const replay = await bind(agent.id, runtime, ownerA, 0, key);
    expect(replay.binding?.id).toBe(first.binding?.id);
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.id}/runtime-binding`,
      headers: {
        "x-pluginmax-actor": ownerA,
        "idempotency-key": key,
      },
      payload: { runtimeId: runtime.id, expectedRevision: 2 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("idempotency_key_conflict");

    const stale = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agent.id}/runtime-binding`,
      headers: { "x-pluginmax-actor": ownerA },
      payload: { expectedRevision: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("runtime_binding_revision_conflict");
  });
});
