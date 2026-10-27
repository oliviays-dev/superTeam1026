import { randomUUID } from "node:crypto";
import type {
  Agent,
  CreateExternalRuntimeInput,
  ExternalRuntime,
} from "@pluginmax/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { PlatformRepositories } from "./repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("agent runtime binding repository", () => {
  const database = new Database(databaseUrl!);
  const repositories = new PlatformRepositories(database);
  const owner = "binding-owner";

  beforeAll(async () => {
    await migrate(database);
  });

  beforeEach(async () => {
    await database.query(
      `TRUNCATE TABLE
         agent_runtime_bindings,
         runtime_probe_jobs,
         external_runtime_capabilities,
         external_runtime_probes,
         external_runtime_events,
         external_runtimes
       CASCADE`,
    );
  });

  afterAll(async () => {
    await database.close();
  });

  async function createAgent(name: string): Promise<Agent> {
    return repositories.agents.create(
      {
        name,
        description: "",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind: "plain-text",
        source: "personal",
      },
      owner,
      owner,
    );
  }

  function runtimeInput(
    overrides: Partial<CreateExternalRuntimeInput> = {},
  ): CreateExternalRuntimeInput {
    return {
      name: `Binding runtime ${randomUUID().slice(0, 8)}`,
      provider: "command",
      protocol: "plain-text",
      command: "binding-runtime-fixture",
      managedArgs: [],
      customArgs: ["--stdin"],
      supportedModels: ["fixture-model"],
      defaultModel: "fixture-model",
      contextWindowTokens: 32_000,
      supportedTools: ["structured_plan", "read_file"],
      networkMode: "restricted",
      sandboxMode: "read-only",
      visibility: "owner",
      ...overrides,
    };
  }

  async function createActiveRuntime(
    overrides: Partial<CreateExternalRuntimeInput> = {},
  ): Promise<ExternalRuntime> {
    const runtime = await repositories.externalRuntimes.create(
      runtimeInput(overrides),
      owner,
      owner,
    );
    const requested = await repositories.externalRuntimes.requestProbe({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      actorId: owner,
    });
    expect(requested.kind).toBe("requested");
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "binding-test-worker",
      30,
      runtime.id,
    );
    expect(claimed).toBeDefined();
    await repositories.externalRuntimes.completeProbeJob({
      jobId: claimed!.jobId,
      owner: "binding-test-worker",
      leaseToken: claimed!.leaseToken,
      exitCode: 0,
      timedOut: false,
      stdoutExcerpt: "fixture-runtime 1.0.0",
      stderrExcerpt: "",
    });
    const enabled = await repositories.externalRuntimes.transition({
      runtimeId: runtime.id,
      expectedRevision: runtime.revision,
      nextStatus: "active",
      actorId: owner,
      requirePassedProbe: true,
    });
    expect(enabled.kind).toBe("updated");
    return enabled.kind === "updated" ? enabled.runtime : runtime;
  }

  it("applies current migrations without changing migration 21/22 data", async () => {
    const schema = `batch13c_${randomUUID().replaceAll("-", "")}`;
    await database.query(`CREATE SCHEMA ${schema}`);
    const separator = databaseUrl!.includes("?") ? "&" : "?";
    const isolated = new Database(
      `${databaseUrl!}${separator}options=${encodeURIComponent(
        `-c search_path=${schema}`,
      )}`,
    );
    try {
      await migrate(isolated, 22);
      const before = await isolated.query<{ version: number }>(
        "SELECT MAX(version) AS version FROM platform_migrations",
      );
      expect(before.rows[0]?.version).toBe(22);
      const bindingTable = await isolated.query<{ name: string | null }>(
        "SELECT to_regclass('agent_runtime_bindings')::text AS name",
      );
      expect(bindingTable.rows[0]?.name).toBe("agent_runtime_bindings");
      const executionColumnBefore = await isolated.query<{
        name: string | null;
      }>(
        `SELECT column_name AS name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'runs'
           AND column_name = 'execution_snapshot'`,
        [schema],
      );
      expect(executionColumnBefore.rows[0]?.name).toBeUndefined();

      const runtimeId = randomUUID();
      await isolated.query(
        `INSERT INTO external_runtimes (
           id, name, provider, protocol, command, managed_args, custom_args,
           supported_models, default_model, supported_tools, network_mode,
           sandbox_mode, status, visibility, owner_id, revision,
           command_digest, args_digest, created_at, updated_at
         ) VALUES (
           $1, 'Migration 21 runtime', 'command', 'plain-text',
           'migration-fixture', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
           NULL, '[]'::jsonb, 'unknown', 'read-only', 'disabled', 'owner',
           $2, 1, repeat('a', 64), repeat('b', 64), NOW(), NOW()
         )`,
        [runtimeId, owner],
      );

      await migrate(isolated);
      const after = await isolated.query<{ version: number }>(
        "SELECT MAX(version) AS version FROM platform_migrations",
      );
      expect(after.rows[0]?.version).toBe(32);
      const tableAfter = await isolated.query<{ name: string | null }>(
        "SELECT to_regclass('agent_runtime_bindings')::text AS name",
      );
      expect(tableAfter.rows[0]?.name).toBe("agent_runtime_bindings");
      const executionColumnAfter = await isolated.query<{ name: string }>(
        `SELECT column_name AS name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'runs'
           AND column_name = 'execution_snapshot'`,
        [schema],
      );
      expect(executionColumnAfter.rows[0]?.name).toBe("execution_snapshot");
      const preserved = await isolated.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM external_runtimes WHERE id = $1",
        [runtimeId],
      );
      expect(preserved.rows[0]?.count).toBe("1");
    } finally {
      await isolated.close();
      await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("keeps one active binding per agent and preserves revisioned history", async () => {
    const agent = await createAgent("History agent");
    const runtimeA = await createActiveRuntime();
    const runtimeB = await createActiveRuntime();

    const first = await repositories.agentRuntimeBindings.set({
      agentId: agent.id,
      runtimeId: runtimeA.id,
      expectedRevision: 0,
      actorId: owner,
    });
    expect(first.kind).toBe("bound");
    await expect(
      database.query(
        `INSERT INTO agent_runtime_bindings (
           id, agent_id, runtime_id, execution_mode, status, revision,
           bound_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'external', 'active', 1, $4, NOW(), NOW()
         )`,
        [randomUUID(), agent.id, runtimeB.id, owner],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const switched = await repositories.agentRuntimeBindings.set({
      agentId: agent.id,
      runtimeId: runtimeB.id,
      expectedRevision: 1,
      actorId: owner,
    });
    expect(switched).toMatchObject({
      kind: "bound",
      binding: {
        runtimeId: runtimeB.id,
        status: "active",
        revision: 1,
      },
    });
    const history = await repositories.agentRuntimeBindings.listHistory(
      agent.id,
    );
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      runtimeId: runtimeA.id,
      status: "disabled",
      revision: 2,
      disabledReason: "replaced by a new external runtime binding",
    });

    const removed = await repositories.agentRuntimeBindings.remove({
      agentId: agent.id,
      expectedRevision: 1,
      actorId: owner,
      reason: "test unbind",
    });
    expect(removed).toMatchObject({
      kind: "removed",
      binding: {
        status: "disabled",
        revision: 2,
        disabledReason: "test unbind",
      },
    });
    const bindingEvents = (
      await repositories.externalRuntimes.listEvents(runtimeA.id)
    ).filter((event) => event.kind === "bound" || event.kind === "unbound");
    expect(bindingEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "bound",
          agentId: agent.id,
        }),
        expect.objectContaining({
          kind: "unbound",
          agentId: agent.id,
        }),
      ]),
    );
  });

  it("serializes concurrent bind commands with the same expected revision", async () => {
    const agent = await createAgent("Concurrent agent");
    const runtimeA = await createActiveRuntime();
    const runtimeB = await createActiveRuntime();
    const results = await Promise.all([
      repositories.agentRuntimeBindings.set({
        agentId: agent.id,
        runtimeId: runtimeA.id,
        expectedRevision: 0,
        actorId: owner,
      }),
      repositories.agentRuntimeBindings.set({
        agentId: agent.id,
        runtimeId: runtimeB.id,
        expectedRevision: 0,
        actorId: owner,
      }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "bound",
      "revision_conflict",
    ]);
    const history = await repositories.agentRuntimeBindings.listHistory(
      agent.id,
    );
    expect(
      history.filter((binding) => binding.status === "active"),
    ).toHaveLength(1);
  });

  it("uses a deadlock-safe lock order with runtime disable", async () => {
    const agent = await createAgent("Binding transition race agent");
    const runtime = await createActiveRuntime();
    await repositories.agentRuntimeBindings.set({
      agentId: agent.id,
      runtimeId: runtime.id,
      expectedRevision: 0,
      actorId: owner,
    });
    const results = await Promise.all([
      repositories.agentRuntimeBindings.set({
        agentId: agent.id,
        runtimeId: runtime.id,
        expectedRevision: 1,
        actorId: owner,
      }),
      repositories.externalRuntimes.transition({
        runtimeId: runtime.id,
        expectedRevision: runtime.revision,
        nextStatus: "disabled",
        actorId: owner,
        requirePassedProbe: false,
      }),
    ]);
    expect(["bound", "unchanged", "revision_conflict"]).toContain(
      results[0].kind,
    );
    expect(results[1].kind).toBe("updated");
    expect(
      await repositories.agentRuntimeBindings.getCurrent(agent.id),
    ).toMatchObject({ status: "disabled" });
  });

  it("disables bindings atomically on runtime disable and archive without restoring", async () => {
    const agentA = await createAgent("Disabled runtime agent A");
    const agentB = await createAgent("Disabled runtime agent B");
    const disabledRuntime = await createActiveRuntime();
    for (const agent of [agentA, agentB]) {
      const result = await repositories.agentRuntimeBindings.set({
        agentId: agent.id,
        runtimeId: disabledRuntime.id,
        expectedRevision: 0,
        actorId: owner,
      });
      expect(result.kind).toBe("bound");
    }
    const disabled = await repositories.externalRuntimes.transition({
      runtimeId: disabledRuntime.id,
      expectedRevision: disabledRuntime.revision,
      nextStatus: "disabled",
      actorId: owner,
      requirePassedProbe: false,
    });
    expect(disabled.kind).toBe("updated");
    for (const agent of [agentA, agentB]) {
      expect(
        await repositories.agentRuntimeBindings.getCurrent(agent.id),
      ).toMatchObject({
        status: "disabled",
        revision: 2,
        disabledReason: "runtime disabled",
      });
    }
    const reprobe = await repositories.externalRuntimes.requestProbe({
      runtimeId: disabledRuntime.id,
      expectedRevision: disabledRuntime.revision + 1,
      actorId: owner,
    });
    expect(reprobe.kind).toBe("requested");
    const claimed = await repositories.externalRuntimes.claimProbeJob(
      "binding-test-worker",
      30,
      disabledRuntime.id,
    );
    await repositories.externalRuntimes.completeProbeJob({
      jobId: claimed!.jobId,
      owner: "binding-test-worker",
      leaseToken: claimed!.leaseToken,
      exitCode: 0,
      timedOut: false,
      stdoutExcerpt: "fixture-runtime 1.0.0",
      stderrExcerpt: "",
    });
    const enabled = await repositories.externalRuntimes.transition({
      runtimeId: disabledRuntime.id,
      expectedRevision: disabledRuntime.revision + 1,
      nextStatus: "active",
      actorId: owner,
      requirePassedProbe: true,
    });
    expect(enabled.kind).toBe("updated");
    expect(
      await repositories.agentRuntimeBindings.getCurrent(agentA.id),
    ).toMatchObject({ status: "disabled" });

    const archivedAgent = await createAgent("Archived runtime agent");
    const archivedRuntime = await createActiveRuntime();
    await repositories.agentRuntimeBindings.set({
      agentId: archivedAgent.id,
      runtimeId: archivedRuntime.id,
      expectedRevision: 0,
      actorId: owner,
    });
    const archived = await repositories.externalRuntimes.transition({
      runtimeId: archivedRuntime.id,
      expectedRevision: archivedRuntime.revision,
      nextStatus: "archived",
      actorId: owner,
      requirePassedProbe: false,
    });
    expect(archived.kind).toBe("updated");
    expect(
      await repositories.agentRuntimeBindings.getCurrent(archivedAgent.id),
    ).toMatchObject({
      status: "disabled",
      disabledReason: "runtime archived",
    });
  });
});
