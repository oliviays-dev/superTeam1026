import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  AgentRegistryService,
  AgentTaskRuntime,
  ExternalAgentRuntimeService,
  createAgentRoutes,
  deliveryReportIssues,
  type AgentActor,
  type AgentProfile,
  type AgentRun,
  type AgentSessionsLike,
  type AgentSessionPersistenceLike,
  type AgentSessionTitleLike,
  type AgentWorkflowHandler,
  type AgentsRegistryLike,
  type AgentSetupContextLike,
  type ExternalAgentRuntime,
  type PersonaServiceLike,
  type SubagentsRuntimeLike,
  type WebRouteLike,
  type WorkspaceLike,
  type WorkspaceRegistryLike,
} from "./index.js";
import type { ExternalAgentRunner, ExternalRunnerRequest } from "./external.js";

class FakeTable<V> {
  readonly records = new Map<string, V>();
  get(key: string): V | undefined {
    return this.records.get(key);
  }
  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }
  keys(): IterableIterator<string> {
    return this.records.keys();
  }
  get size(): number {
    return this.records.size;
  }
  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

function tables() {
  return {
    profiles: new FakeTable<AgentProfile>(),
    runs: new FakeTable<AgentRun>(),
  };
}

const owner: AgentActor = {
  kind: "user",
  id: "ws-owner",
  workspaceId: "main",
  workspaceRole: "owner",
};
const admin: AgentActor = { kind: "user", id: "root", globalRole: "admin" };
const member: AgentActor = {
  kind: "user",
  id: "ws-member",
  workspaceId: "main",
  workspaceRole: "member",
};

interface FakeSubagentRun {
  readonly spec: {
    label?: string;
    prompt: ReadonlyArray<{ type: "text"; text: string }>;
    signal: AbortSignal;
    persona?: string;
    toolFilter?: { allow: readonly string[] };
  };
  outcome?: {
    output?: ReadonlyArray<unknown>;
    stopReason: string;
    diagnostic?: string;
  };
  resolve(): void;
}

function fakeSubagents() {
  const runs: FakeSubagentRun[] = [];
  const runtime: SubagentsRuntimeLike = {
    async start(_name, spec) {
      const run: FakeSubagentRun = {
        spec,
        resolve: () => undefined,
      };
      const promise = new Promise((resolve) => {
        run.resolve = () => resolve(undefined);
      });
      runs.push(run);
      return {
        id: `sub-${runs.length}`,
        result: promise.then(
          () => run.outcome ?? { output: [], stopReason: "completed" },
        ),
        dispose: async () => undefined,
      };
    },
  };
  return { runs, runtime };
}

interface PromptSectionSink {
  readonly sections: Array<{ name: string; order: number; text: string }>;
}

function fakeAgents(sink?: PromptSectionSink) {
  return {
    create: async ({
      sessionId,
      setup,
    }: {
      sessionId: string;
      setup?: (ctx: AgentSetupContextLike) => Promise<void> | void;
    }) => {
      if (setup !== undefined) {
        const ctx = {
          tools: { restrict: () => undefined, get: () => undefined },
          get: (key: string) => {
            if (key === "agentPresets") {
              return { mount: async () => undefined };
            }
            if (key === "systemPrompt") {
              return {
                section: (section: {
                  name: string;
                  order: number;
                  text: string;
                }) => {
                  sink?.sections.push({ ...section });
                  return () => undefined;
                },
                getSectionOrder: () => 7,
              };
            }
            return undefined;
          },
        } as unknown as AgentSetupContextLike;
        await setup(ctx);
      }
      const events: Array<{ type: string; data?: unknown }> = [];
      return {
        agent: {
          session: {
            id: sessionId,
            snapshotEvents: () => events,
          },
          followup: () => {
            events.push({
              type: "assistant/message",
              data: {
                message: {
                  content: [{ type: "text", text: "home session response" }],
                },
              },
            });
          },
          whenIdle: async () => undefined,
          cancel: () => undefined,
        },
        dispose: async () => undefined,
      };
    },
  };
}

function dispatchInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "main",
    profileId: "backend-agent",
    source: "workflow" as const,
    instanceId: "inst-1",
    nodeId: "development",
    dispatchKey: "main:inst-1:development:a1:t0#1",
    trigger: "manual-dispatch" as const,
    attempt: 1,
    runSeq: 1,
    maxAttempts: 2,
    timeoutMs: 1_800_000,
    payload: {
      instanceTitle: "订单导出",
      nodeName: "开发",
      nodeDescription: "",
      profileName: "Backend Agent",
      deliverables: [
        {
          key: "report",
          title: "实现说明",
          type: "text" as const,
          required: true,
          description: "",
          minTextLength: 10,
        },
      ],
      context: {},
    },
    createdBy: "ws-owner",
    ...overrides,
  };
}

interface Harness {
  service: AgentRegistryService;
  store: ReturnType<typeof tables>;
  runtime: AgentTaskRuntime;
  subagents: ReturnType<typeof fakeSubagents>;
  settled: AgentRun[];
}

function harness(
  options: {
    now?: () => Date;
    workspaces?: WorkspaceRegistryLike;
    sessions?: AgentSessionsLike;
    sessionPersistence?: AgentSessionPersistenceLike;
    sessionTitle?: AgentSessionTitleLike;
    agents?: () => AgentsRegistryLike;
    personas?: () => PersonaServiceLike | undefined;
  } = {},
): Harness {
  const current = tables();
  const service = new AgentRegistryService(current, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sessions === undefined
      ? {}
      : { sessions: () => options.sessions }),
    ...(options.sessionPersistence === undefined
      ? {}
      : { sessionPersistence: () => options.sessionPersistence }),
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: () => options.workspaces }),
  });
  const subagents = fakeSubagents();
  const settled: AgentRun[] = [];
  const runtime = new AgentTaskRuntime({
    tables: current,
    subagents: () => subagents.runtime,
    agents: options.agents ?? fakeAgents,
    ...(options.personas === undefined ? {} : { personas: options.personas }),
    ...(options.workspaces === undefined
      ? {}
      : { workspaces: () => options.workspaces }),
    ...(options.sessions === undefined
      ? {}
      : { sessions: () => options.sessions }),
    ...(options.sessionPersistence === undefined
      ? {}
      : { sessionPersistence: () => options.sessionPersistence }),
    ...(options.sessionTitle === undefined
      ? {}
      : { sessionTitle: () => options.sessionTitle }),
    onSettled: (run) => {
      settled.push(run);
      return service.onRuntimeSettled(run);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  service.attachRuntime(runtime);
  return { service, store: current, runtime, subagents, settled };
}

const now = () => new Date("2026-09-12T00:00:00.000Z");

async function createProfile(
  service: AgentRegistryService,
  overrides: Record<string, unknown> = {},
): Promise<AgentProfile> {
  return service.createProfile(owner, {
    workspaceId: "main",
    id: "backend-agent",
    name: "Backend Agent",
    ...overrides,
  });
}

describe("agent profile registry", () => {
  it("creates and updates profiles with permission checks", async () => {
    const { service } = harness();
    expect(() =>
      service.createProfile(member, {
        workspaceId: "main",
        id: "backend-agent",
        name: "Backend Agent",
      }),
    ).toThrow("workspace owner or admin is required");
    const profile = await createProfile(service);
    expect(profile.runtimeKind).toBe("task-worker");
    expect(profile.allowedTools).toEqual([]);
    await expect(
      createProfile(service, { id: "backend-agent", name: "Other" }),
    ).rejects.toThrow("already exists");
    const disabled = await service.updateProfile(admin, {
      workspaceId: "main",
      profileId: "backend-agent",
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
  });

  it("keeps the trusted runtime provisioning path separate from HTTP permissions", async () => {
    const { service } = harness();
    const profile = await service.createRuntimeProfile(member, {
      workspaceId: "main",
      id: "runtime-agent",
      name: "Runtime Agent",
    });
    expect(profile.ownerUserId).toBe(member.id);
    const updated = await service.updateRuntimeProfile(member, {
      workspaceId: "main",
      profileId: profile.id,
      allowedTools: ["read"],
    });
    expect(updated.allowedTools).toEqual(["read"]);
  });

  it("backfills output tokens for legacy runs from persisted sessions", async () => {
    const current = tables();
    const persistence = {
      stat: async () => undefined,
      open: async () => ({
        read: async () => [
          {
            type: "assistant/message",
            time: now().getTime(),
            data: { usage: { outputTokens: 34 } },
          },
        ],
        close: async () => undefined,
      }),
    };
    const service = new AgentRegistryService(current, {
      now,
      sessionPersistence: () => persistence,
    });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await current.runs.put(run.id, {
      ...run,
      status: "succeeded" as const,
      sessionId: "legacy-session",
      startedAt: now().toISOString(),
      endedAt: now().toISOString(),
    });
    await service.backfillOutputTokens();
    expect(service.run(run.id)?.outputTokens).toBe(34);
  });

  it("returns conservative execution metadata for legacy runs", async () => {
    const current = tables();
    const runtimes = new FakeTable<ExternalAgentRuntime>();
    await runtimes.put("codex-local", {
      id: "codex-local",
      workspaceId: "main",
      name: "Codex CLI · 搜索只读",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
      args: ["--search"],
      status: "active",
      visibility: "workspace",
      ownerUserId: owner.id,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    const service = new AgentRegistryService(current, {
      now,
      externalRuntimes: () => runtimes,
    });
    await service.createProfile(owner, {
      workspaceId: "main",
      id: "backend-agent",
      name: "Backend Agent",
      execution: "external",
      externalRuntimeId: "codex-local",
    });
    const run = await service.dispatch(dispatchInput());

    expect(service.run(run.id)?.execution).toEqual({
      provider: "codex",
      model: "unknown",
      runtime: "Codex CLI · 搜索只读（历史配置回填）",
      runtimeVersion: "unknown",
      authMode: "unknown",
      sandbox: "read-only / network restricted",
    });
    expect(
      service.runs({ workspaceId: "main", instanceId: "inst-1" })[0]?.execution,
    ).toEqual(service.run(run.id)?.execution);
  });

  it("rejects cross-workspace profile access", async () => {
    const { service } = harness();
    await createProfile(service);
    expect(service.profile("other", "backend-agent")).toBeUndefined();
    expect(service.profiles("other")).toEqual([]);
  });

  it("resolves platform profiles across workspaces", async () => {
    const { service } = harness();
    await service.createProfile(admin, {
      workspaceId: "main",
      id: "backend-agent",
      name: "Backend Agent",
      visibility: "platform",
    });
    expect(service.profile("other", "backend-agent")).toMatchObject({
      id: "backend-agent",
      visibility: "platform",
      status: "active",
    });
    expect(service.profiles("other")).toHaveLength(1);
    await expect(
      service.updateProfile(owner, {
        workspaceId: "other",
        profileId: "backend-agent",
        status: "disabled",
      }),
    ).rejects.toThrow("platform profile requires a platform administrator");
    const disabled = await service.updateProfile(admin, {
      workspaceId: "other",
      profileId: "backend-agent",
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
  });

  it("treats legacy profiles without visibility as platform profiles", async () => {
    const { service, store } = harness();
    const now = new Date("2026-09-20T00:00:00.000Z").toISOString();
    await store.profiles.put("backend-agent", {
      id: "backend-agent",
      workspaceId: "main",
      name: "Backend Agent",
      description: "",
      runtimeKind: "task-worker",
      allowedTools: [],
      ownerUserId: "flow-owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    expect(service.profile("other", "backend-agent")).toMatchObject({
      id: "backend-agent",
      status: "active",
    });
    expect(service.profiles("other")).toHaveLength(1);
  });
});

describe("external agent runtime", () => {
  it("shares platform runtimes across projects while isolating workspace runtimes", async () => {
    const table = new FakeTable<ExternalAgentRuntime>();
    const service = new ExternalAgentRuntimeService(table, { now });
    expect(() =>
      service.create(member, {
        workspaceId: "main",
        name: "Codex",
        provider: "codex",
        protocol: "codex-jsonl",
        command: "codex",
        args: [],
      }),
    ).toThrow("Owner/Admin");
    const runtime = await service.create(owner, {
      workspaceId: "main",
      name: "Codex",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
      args: ["--profile", "work"],
    });
    expect(runtime.status).toBe("active");
    expect(runtime.visibility).toBe("platform");
    expect(service.list("other")).toHaveLength(1);
    expect(service.list("main")).toHaveLength(1);
    const workspaceRuntime = await service.create(owner, {
      workspaceId: "main",
      name: "Workspace Codex",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
      visibility: "workspace",
    });
    expect(service.list("main")).toHaveLength(2);
    expect(service.list("other").map((item) => item.id)).not.toContain(
      workspaceRuntime.id,
    );
    const disabled = await service.update(owner, {
      runtimeId: runtime.id,
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
    const renamed = await service.update(owner, {
      runtimeId: runtime.id,
      name: "Codex Renamed",
    });
    expect(renamed.status).toBe("disabled");
  });

  it("stores runtime tool capabilities and a coherent model pool", async () => {
    const table = new FakeTable<ExternalAgentRuntime>();
    const service = new ExternalAgentRuntimeService(table, { now });
    const runtime = await service.create(owner, {
      workspaceId: "main",
      name: "CodeBuddy Research",
      provider: "workbuddy",
      protocol: "plain-text",
      command: "codebuddy",
      customArgs: ["--include-directory", "docs"],
      supportedTools: ["web_search", "web_fetch", "read_file"],
      supportedModels: ["deepseek-v4-pro", "glm-5.3"],
      defaultModel: "deepseek-v4-pro",
      contextWindowTokens: 128_000,
    });
    expect(runtime).toMatchObject({
      supportedTools: ["web_search", "web_fetch", "read_file"],
      customArgs: ["--include-directory", "docs"],
      supportedModels: ["deepseek-v4-pro", "glm-5.3"],
      defaultModel: "deepseek-v4-pro",
      contextWindowTokens: 128_000,
    });
    const updated = await service.update(owner, {
      runtimeId: runtime.id,
      customArgs: ["--verbose"],
      supportedTools: ["web_fetch", "write_file"],
      supportedModels: ["glm-5.3"],
      defaultModel: "glm-5.3",
      contextWindowTokens: 200_000,
    });
    expect(updated).toMatchObject({
      supportedTools: ["web_fetch", "write_file"],
      customArgs: ["--verbose"],
      supportedModels: ["glm-5.3"],
      defaultModel: "glm-5.3",
      contextWindowTokens: 200_000,
    });
    await expect(
      service.update(owner, {
        runtimeId: runtime.id,
        supportedModels: ["glm-5.3"],
        defaultModel: "deepseek-v4-pro",
      }),
    ).rejects.toThrow("invalid request payload");
  });

  it("notifies the teammate boundary when an unavailable runtime pauses bindings", async () => {
    const runtimeTable = new FakeTable<ExternalAgentRuntime>();
    const runtimeService = new ExternalAgentRuntimeService(runtimeTable, {
      now,
    });
    const runtime = await runtimeService.create(admin, {
      workspaceId: "main",
      name: "Codex CLI 本机",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
    });
    const notifications: Array<{
      runtimeId: string;
      status: string;
      previousStatus?: string | undefined;
    }> = [];
    const routes = createAgentRoutes(
      new AgentRegistryService(tables(), { now }),
      () => ({
        resolveToken: (token) =>
          token === "admin" ? { userId: "root", role: "admin" } : undefined,
        members: () => [{ userId: "root", memberRole: "owner" }],
      }),
      undefined,
      () => runtimeService,
      async ({ runtime: changed, previousStatus }) => {
        notifications.push({
          runtimeId: changed.id,
          status: changed.status,
          previousStatus,
        });
        return ["tm-bound"];
      },
    );
    const route = routes.find(
      (candidate) =>
        candidate.path === "/api/collab/agent/external-runtimes/update",
    )!;
    let finishResponse: (() => void) | undefined;
    const responseFinished = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    const response = {
      status: 0,
      body: "",
      writeHead(status: number) {
        this.status = status;
        return this;
      },
      end(body?: string) {
        if (body !== undefined) this.body = body;
        finishResponse?.();
        return this;
      },
    };
    const request = Readable.from([
      JSON.stringify({
        workspaceId: "main",
        runtimeId: runtime.id,
        status: "disabled",
      }),
    ]);
    Object.assign(request, {
      method: "POST",
      url: "/api/collab/agent/external-runtimes/update",
      headers: {
        host: "127.0.0.1:33117",
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer admin",
        "content-type": "application/json",
      },
    });

    await route.handler(
      request as unknown as Parameters<WebRouteLike["handler"]>[0],
      response as unknown as Parameters<WebRouteLike["handler"]>[1],
    );
    await responseFinished;

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      pausedTeammateIds: ["tm-bound"],
      runtime: { id: runtime.id, status: "disabled" },
    });
    expect(notifications).toEqual([
      {
        runtimeId: runtime.id,
        status: "disabled",
        previousStatus: "active",
      },
    ]);
  });

  it("emits trace events for runtime governance actions", async () => {
    const table = new FakeTable<ExternalAgentRuntime>();
    const events: Array<{
      action: string;
      status: string;
      previousStatus?: string | undefined;
    }> = [];
    const service = new ExternalAgentRuntimeService(table, {
      now,
      onTrace: (event) => {
        events.push({
          action: event.action,
          status: event.runtime.status,
          previousStatus: event.previousStatus,
        });
      },
    });
    const runtime = await service.create(owner, {
      workspaceId: "main",
      name: "WorkBuddy",
      provider: "workbuddy",
      protocol: "plain-text",
      command: "/usr/local/bin/codebuddy",
    });
    await service.markProbe(
      runtime.id,
      {
        ok: true,
        message: "命令可用",
        exitCode: 0,
        durationMs: 42,
      },
      owner,
    );
    await service.update(owner, {
      runtimeId: runtime.id,
      status: "disabled",
    });
    await service.archive(owner, { runtimeId: runtime.id });
    await service.restore(owner, { runtimeId: runtime.id });

    expect(events).toEqual([
      { action: "register", status: "active" },
      {
        action: "probe",
        status: "active",
        previousStatus: "active",
      },
      {
        action: "disable",
        status: "disabled",
        previousStatus: "active",
      },
      {
        action: "archive",
        status: "archived",
        previousStatus: "disabled",
      },
      {
        action: "restore",
        status: "disabled",
        previousStatus: "archived",
      },
    ]);
  });

  it("edits runtime definitions and clears stale probe results", async () => {
    const table = new FakeTable<ExternalAgentRuntime>();
    const service = new ExternalAgentRuntimeService(table, { now });
    const runtime = await service.create(owner, {
      workspaceId: "main",
      name: "Codex",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
      args: ["--profile", "work"],
    });
    await service.markProbe(runtime.id, {
      ok: true,
      message: "命令可用",
    });

    const updated = await service.update(owner, {
      runtimeId: runtime.id,
      name: "WorkBuddy",
      provider: "workbuddy",
      protocol: "plain-text",
      command: "/usr/local/bin/codebuddy",
      args: ["--print", "--max-turns", "8"],
    });
    expect(updated).toMatchObject({
      name: "WorkBuddy",
      provider: "workbuddy",
      protocol: "plain-text",
      command: "/usr/local/bin/codebuddy",
      args: ["--print", "--max-turns", "8"],
      status: "active",
    });
    expect(updated.lastProbeAt).toBeUndefined();
    expect(updated.lastProbeOk).toBeUndefined();
    expect(updated.lastProbeMessage).toBeUndefined();
  });

  it("archives, restores and rejects illegal status transitions", async () => {
    const table = new FakeTable<ExternalAgentRuntime>();
    const service = new ExternalAgentRuntimeService(table, { now });
    const runtime = await service.create(owner, {
      workspaceId: "main",
      name: "Codex",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
    });
    await expect(
      service.archive(member, { runtimeId: runtime.id }),
    ).rejects.toThrow("Owner/Admin");
    const archived = await service.archive(owner, { runtimeId: runtime.id });
    expect(archived.status).toBe("archived");
    // 归档项默认不出现在常规列表，归档视图显式请求后才可见。
    expect(service.list("main")).toEqual([]);
    expect(service.list("main", { includeArchived: true })).toHaveLength(1);
    // 归档为终态：不能直接启用，只能先复原回停用。
    await expect(
      service.update(owner, { runtimeId: runtime.id, status: "active" }),
    ).rejects.toThrow("先复原");
    await expect(
      service.update(owner, { runtimeId: runtime.id, status: "disabled" }),
    ).rejects.toThrow("先复原");
    expect(() => service.requireForManagement(runtime.id, owner)).toThrow(
      "已归档",
    );
    await expect(
      service.restore(owner, { runtimeId: runtime.id }),
    ).resolves.toMatchObject({ status: "disabled" });
    const restored = service.get(runtime.id)!;
    expect(restored.status).toBe("disabled");
    await expect(
      service.restore(owner, { runtimeId: runtime.id }),
    ).rejects.toThrow("只有已归档");
    const enabled = await service.update(owner, {
      runtimeId: runtime.id,
      status: "active",
    });
    expect(enabled.status).toBe("active");
  });

  it("fails dispatch with a status-specific reason for dirty runtimes", async () => {
    const dispatchError = async (
      status: ExternalAgentRuntime["status"],
    ): Promise<string | undefined> => {
      const current = tables();
      const runtimeTable = new FakeTable<ExternalAgentRuntime>();
      await runtimeTable.put("codex-local", {
        id: "codex-local",
        workspaceId: "main",
        name: "Codex 本机",
        provider: "codex",
        protocol: "codex-jsonl",
        command: "codex",
        args: [],
        status,
        visibility: "workspace",
        ownerUserId: "ws-owner",
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      });
      const service = new AgentRegistryService(current, { now });
      await service.createProfile(owner, {
        workspaceId: "main",
        id: "backend-agent",
        name: "Backend Agent",
        execution: "external",
        externalRuntimeId: "codex-local",
      });
      const runtime = new AgentTaskRuntime({
        tables: current,
        subagents: () => undefined,
        agents: fakeAgents,
        externalRuntimes: () => runtimeTable,
        externalRunner: () => ({
          progress: () => undefined,
          execute: async () => ({
            output: [{ type: "text", text: "should not run" }],
            stopReason: "completed" as const,
          }),
        }),
        onSettled: (run) => service.onRuntimeSettled(run),
        now,
      });
      service.attachRuntime(runtime);
      const run = await service.dispatch(
        dispatchInput({ workspacePath: "/tmp/project" }),
      );
      await vi.waitFor(() =>
        expect(["failed"]).toContain(service.run(run.id)?.status),
      );
      return service.run(run.id)?.error;
    };
    const disabled = await dispatchError("disabled");
    expect(disabled).toContain("已停用");
    expect(disabled).toContain("切换为内置执行");
    const archived = await dispatchError("archived");
    expect(archived).toContain("已归档");
    expect(archived).toContain("改绑");
  });

  it("routes a dispatch through the selected external runner", async () => {
    const current = tables();
    const runtimeTable = new FakeTable<ExternalAgentRuntime>();
    await runtimeTable.put("codex-local", {
      id: "codex-local",
      workspaceId: "main",
      name: "Codex 本机",
      provider: "codex",
      protocol: "codex-jsonl",
      command: "codex",
      args: [],
      status: "active",
      visibility: "workspace",
      ownerUserId: "ws-owner",
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    const service = new AgentRegistryService(current, { now });
    await service.createProfile(owner, {
      workspaceId: "main",
      id: "backend-agent",
      name: "Backend Agent",
      personaId: "persona-editor",
      execution: "external",
      externalRuntimeId: "codex-local",
    });
    const execute = vi.fn(async (_request: ExternalRunnerRequest) => ({
      output: [
        {
          type: "text" as const,
          text: "# 交付报告\n\n## 交付说明\n\n外部 Agent 已完成，且满足最少字数要求。",
        },
      ],
      stopReason: "completed" as const,
      sessionId: "provider-session-1",
      execution: {
        provider: "custom",
        model: "deepseek-flash",
        runtime: "Codex 本机",
        runtimeVersion: "0.163.0-alpha.10.2",
        authMode: "api-key",
        sandbox: "read-only / network restricted",
      },
    }));
    const runner: ExternalAgentRunner = {
      progress: () => undefined,
      execute,
    };
    const settled: AgentRun[] = [];
    const runtime = new AgentTaskRuntime({
      tables: current,
      subagents: () => undefined,
      agents: fakeAgents,
      personas: () => ({
        get: async (personaId) =>
          personaId === "persona-editor"
            ? { soul: "你是报告主编，只输出可审核的研究报告。" }
            : undefined,
      }),
      externalRuntimes: () => runtimeTable,
      externalRunner: () => runner,
      onSettled: (run) => {
        settled.push(run);
        return service.onRuntimeSettled(run);
      },
      now,
    });
    service.attachRuntime(runtime);
    await service.dispatch(
      dispatchInput({
        workspacePath: "/tmp/project",
        personaId: "persona-editor",
      }),
    );
    await vi.waitFor(() =>
      expect([...current.runs.records.values()][0]?.status).toBe("succeeded"),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/project",
        prompt: expect.stringContaining("# AI伙伴身份与行为边界"),
      }),
    );
    expect(execute.mock.calls[0]?.[0]?.prompt).toContain(
      "你是报告主编，只输出可审核的研究报告。",
    );
    expect(execute.mock.calls[0]?.[0]?.prompt).toContain("# 当前任务");
    expect(
      current.runs.records.get([...current.runs.records.keys()][0]!),
    ).toMatchObject({
      externalSessionId: "provider-session-1",
      status: "succeeded",
      execution: {
        provider: "custom",
        model: "deepseek-flash",
        runtime: "Codex 本机",
        runtimeVersion: "0.163.0-alpha.10.2",
        authMode: "api-key",
        sandbox: "read-only / network restricted",
      },
      promptSnapshot: expect.stringContaining(
        "你是报告主编，只输出可审核的研究报告。",
      ),
    });
    expect(settled).toHaveLength(1);
  });
});

describe("agent task runtime", () => {
  it("delivers task runs to the task handler with a task-specific prompt", async () => {
    const { service, runtime, subagents } = harness({ now });
    const settled: AgentRun[] = [];
    service.bindTask({
      onSettled: (run) => {
        settled.push(run);
      },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        instanceId: "TSK-1",
        nodeId: "task",
        dispatchKey: "task:TSK-1:1",
        payload: {
          instanceTitle: "处理客户反馈",
          nodeName: "任务执行",
          nodeDescription: "整理风险，并给出下一步建议。",
          profileName: "Backend Agent",
          deliverables: [],
          context: { taskId: "TSK-1" },
        },
      }),
    );
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain(
      "整理风险，并给出下一步建议。",
    );
    subagents.runs[0]!.outcome = {
      output: [{ type: "text", text: "已整理风险，并给出下一步建议。" }],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(settled[0]).toMatchObject({
      id: run.id,
      source: "task",
      instanceId: "TSK-1",
      status: "succeeded",
    });
    expect(service.run(run.id)!.settleDelivered).toBe(true);
  });

  it("attaches live task-worker sessions to the target workspace", async () => {
    const attached: string[] = [];
    const renamed: Array<{ id: string; title: string }> = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => [],
      }),
    };
    const sessionTitle: AgentSessionTitleLike = {
      rename: (session, title) => {
        renamed.push({ id: session.id, title });
      },
    };
    const { service, runtime } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle,
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-2",
        nodeId: "task",
        dispatchKey: "task:TSK-2:1",
      }),
    );
    const sessionId = "de-task-TSK-2-pluginmax-de";
    await vi.waitFor(() => expect(attached).toEqual([sessionId]));
    expect(service.run(run.id)?.sessionId).toBe(sessionId);
    expect(renamed).toEqual([
      {
        id: sessionId,
        title: "Backend Agent-TSK-订单导出-2",
      },
    ]);
    await runtime.waitIdle();
    expect(service.run(run.id)?.output?.summary).toBe("home session response");
  });

  it("records only output tokens emitted during the current run window", async () => {
    const events: Array<{
      type: string;
      time?: number;
      data?: unknown;
    }> = [];
    const agents: AgentsRegistryLike = {
      create: async ({ sessionId }) => ({
        agent: {
          session: {
            id: sessionId,
            snapshotEvents: () => events,
          },
          followup: () => {
            events.push(
              {
                type: "assistant/message",
                time: now().getTime() - 3_600_000,
                data: {
                  usage: { inputTokens: 100, outputTokens: 999 },
                  message: { content: [{ type: "text", text: "old" }] },
                },
              },
              {
                type: "assistant/message",
                time: now().getTime(),
                data: {
                  usage: { inputTokens: 20, outputTokens: 12 },
                  message: { content: [{ type: "text", text: "first" }] },
                },
              },
              {
                type: "assistant/message",
                time: now().getTime(),
                data: {
                  usage: { inputTokens: 5, outputTokens: 8 },
                  message: { content: [{ type: "text", text: "final" }] },
                },
              },
            );
          },
          whenIdle: async () => undefined,
          cancel: () => undefined,
        },
        dispose: async () => undefined,
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => events,
      }),
    };
    const { service, runtime } = harness({
      now,
      agents: () => agents,
      sessions,
      workspaces: {
        create: async (path) => ({
          path,
          attachSession: async () => undefined,
        }),
      },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-TOKENS",
        nodeId: "task",
        dispatchKey: "task:TSK-TOKENS:1",
      }),
    );
    await runtime.waitIdle();
    expect(service.run(run.id)).toMatchObject({
      status: "succeeded",
      outputTokens: 20,
    });
  });

  it("runs workflow task workers in a persistent task session", async () => {
    const attached: string[] = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => [],
      }),
    };
    const { service } = harness({
      now,
      workspaces,
      sessions,
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "wf-instance-1",
        nodeId: "development",
        dispatchKey: "main:wf-instance-1:development:a1:t0#1",
        payload: {
          ...dispatchInput().payload,
          context: { workflowTaskId: "TSK-MULA26AJ-162E" },
        },
      }),
    );
    const sessionId = "de-task-TSK-MULA26AJ-162E-development-backend-agent";
    await vi.waitFor(
      () => {
        expect(service.run(run.id)?.sessionId).toBe(sessionId);
        expect(attached).toContain(sessionId);
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(service.run(run.id)?.sessionId).toBe(sessionId);
  });

  it("republishes a legacy restart-interrupted workflow session", async () => {
    const attached: string[] = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
    };
    const { service, store } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle: { rename: () => undefined },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        workspacePath: "/tmp/pluginmax-workspace",
        maxAttempts: 1,
        payload: {
          ...dispatchInput().payload,
          context: { workflowTaskId: "TSK-LEGACY-0001" },
        },
      }),
    );
    const sessionId = "de-task-TSK-LEGACY-0001-development-backend-agent";
    await vi.waitFor(() => {
      expect(attached).toContain(sessionId);
    });
    expect(attached).toContain(sessionId);

    // 模拟旧版本：sessionId 已回写，但工作区挂载在上次重启窗口丢失。
    await store.runs.put(run.id, {
      ...service.run(run.id)!,
      settleDelivered: true,
      error: "服务重启导致运行中断，可重试或转人工",
      status: "interrupted",
    } as AgentRun);
    const restartRuntime = new AgentTaskRuntime({
      tables: store,
      subagents: () => undefined,
      agents: fakeAgents,
      workspaces: () => workspaces,
      sessions: () => sessions,
      sessionTitle: () => ({ rename: () => undefined }),
      now,
    });
    service.attachRuntime(restartRuntime);
    service.restore();
    await vi.waitFor(() =>
      expect(attached.filter((item) => item === sessionId)).toHaveLength(2),
    );
    expect(service.run(run.id)?.status).toBe("interrupted");
  });

  it("recreates a task session when the recorded one is gone from disk", async () => {
    const sessionId = "de-task-TSK-MV827GO0-8326-digital-e386906a";
    const resumed: string[] = [];
    const created: string[] = [];
    const fallback = fakeAgents();
    const { service, runtime } = harness({
      now,
      // 会话「登记过」，但产物已经被外部清理掉。
      sessionPersistence: {
        stat: async () => ({ header: { id: sessionId }, revision: "r1" }),
      },
      agents: () => ({
        create: async (options) => {
          created.push(options.sessionId);
          return await fallback.create(options);
        },
        resume: async ({ resumeSessionId }) => {
          resumed.push(resumeSessionId);
          const error = new Error(
            `ENOENT: no such file or directory, open '/tmp/sessions/${resumeSessionId}/session.v2.jsonl.zstd'`,
          ) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      }),
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "digital-e386906a",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-MV827GO0-8326",
        nodeId: "task",
        dispatchKey: "task:TSK-MV827GO0-8326:1",
      }),
    );
    await runtime.waitIdle();

    expect(resumed).toEqual([sessionId]);
    expect(created).toEqual([sessionId]);
    expect(service.run(run.id)).toMatchObject({
      status: "succeeded",
      sessionId,
    });
  });

  it("fails the round when the session log disappears mid-run", async () => {
    const sessionId = "de-task-TSK-MV827GO0-8326-digital-e386906a";
    let stats = 0;
    const fallback = fakeAgents();
    const { service, runtime } = harness({
      now,
      // 第一次探测（决定 create/resume）返回快照，之后产物消失。
      sessionPersistence: {
        stat: async () => {
          stats += 1;
          return stats === 1
            ? { header: { id: sessionId }, revision: "r1", sizeBytes: 64 }
            : undefined;
        },
      },
      agents: () => ({
        create: async (options) => await fallback.create(options),
        resume: async ({ resumeSessionId }) => {
          const handle = await fallback.create({
            sessionId: resumeSessionId,
          });
          return handle;
        },
      }),
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "digital-e386906a",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-MV827GO0-8326",
        nodeId: "task",
        dispatchKey: "task:TSK-MV827GO0-8326:1",
      }),
    );
    await runtime.waitIdle();

    const saved = service.run(run.id)!;
    // 不能把「日志已经没了」的轮次当成成功写回任务。
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("会话日志已丢失");
    expect(saved.output?.summary).toBe("home session response");
  });

  it("gives every task its own session for the same DE", async () => {
    const attached: string[] = [];
    const renamed: Array<{ id: string; title: string }> = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => [],
      }),
    };
    const sessionTitle: AgentSessionTitleLike = {
      rename: (session, title) => {
        renamed.push({ id: session.id, title });
      },
    };
    const { service, runtime, subagents } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle,
    });
    await createProfile(service);
    const first = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-A",
        nodeId: "task",
        dispatchKey: "task:TSK-A:1",
      }),
    );
    const second = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-B",
        nodeId: "task",
        dispatchKey: "task:TSK-B:1",
      }),
    );
    await runtime.waitIdle();
    await vi.waitFor(() => expect(attached).toHaveLength(2));
    const firstSession = service.run(first.id)?.sessionId;
    const secondSession = service.run(second.id)?.sessionId;
    expect(firstSession).toBe("de-task-TSK-A-pluginmax-de");
    expect(secondSession).toBe("de-task-TSK-B-pluginmax-de");
    expect(firstSession).not.toBe(secondSession);
    expect(subagents.runs).toHaveLength(0);
    expect(renamed.map((item) => item.title).sort()).toEqual([
      "Backend Agent-TSK-订单导出-A",
      "Backend Agent-TSK-订单导出-B",
    ]);
  });

  it("keeps private chat sessions out of the shared workspace tree", async () => {
    const attached: string[] = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => [],
      }),
    };
    const { service, runtime } = harness({ now, workspaces, sessions });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "chat",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "meeting-ai-1",
        nodeId: "meeting-ai-chat",
        sessionBindingId: "chat:chat-channel-1:principal-ai-pluginmax-de:g0",
        sessionId: "de-chat-main-chat-channel-1-principal-ai-pluginmax-de",
        dispatchKey: "chat:meeting-ai-1:message-1",
        payload: {
          ...dispatchInput().payload,
          context: {
            ...dispatchInput().payload.context,
            chatChannelId: "chat-channel-1",
          },
        },
      }),
    );
    await runtime.waitIdle();
    expect(attached).toEqual([]);
    expect(service.run(run.id)).toMatchObject({
      status: "succeeded",
      sessionId: "de-chat-main-chat-channel-1-principal-ai-pluginmax-de",
      sessionBindingId: "chat:chat-channel-1:principal-ai-pluginmax-de:g0",
    });
    expect(service.run(run.id)?.output?.summary).toBe("home session response");
  });

  it("detaches legacy private chat sessions from shared workspaces on restore", async () => {
    const detached: string[] = [];
    const workspace: WorkspaceLike = {
      path: "/tmp/pluginmax-workspace",
      attachSession: async () => undefined,
      detachSession: async (sessionId) => {
        detached.push(sessionId);
      },
    };
    const workspaces: WorkspaceRegistryLike = {
      create: async () => workspace,
      get: () => workspace,
    };
    const { service, runtime } = harness({ now, workspaces });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "chat",
        employeeId: "pluginmax-de",
        workspacePath: workspace.path,
        workspaceId: "main",
        instanceId: "meeting-ai-legacy",
        nodeId: "meeting-ai-chat",
        dispatchKey: "chat:meeting-ai-legacy:message-1",
        payload: {
          ...dispatchInput().payload,
          context: {
            ...dispatchInput().payload.context,
            chatChannelId: "chat-channel-legacy",
          },
        },
      }),
    );
    await runtime.waitIdle();
    const sessionId = service.run(run.id)?.sessionId;
    service.restore();
    await vi.waitFor(() => expect(detached).toEqual([sessionId]));
  });

  it("routes follow-up instructions to the session of their own task", async () => {
    const attached: string[] = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({
        id: sessionId,
        snapshotEvents: () => [],
      }),
    };
    const { service, runtime } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle: { rename: () => undefined },
    });
    await createProfile(service);
    const dispatchFor = (taskId: string, runSeq: number) =>
      service.dispatch(
        dispatchInput({
          source: "task",
          employeeId: "pluginmax-de",
          workspacePath: "/tmp/pluginmax-workspace",
          instanceId: taskId,
          nodeId: "task",
          attempt: 1,
          runSeq,
          maxAttempts: 1,
          dispatchKey: `task:${taskId}:${String(runSeq)}`,
        }),
      );
    const taskAFirst = await dispatchFor("TSK-A", 1);
    const taskASecond = await dispatchFor("TSK-A", 2);
    const taskBFirst = await dispatchFor("TSK-B", 1);
    await runtime.waitIdle();
    await vi.waitFor(() =>
      expect(new Set(attached)).toEqual(
        new Set(["de-task-TSK-A-pluginmax-de", "de-task-TSK-B-pluginmax-de"]),
      ),
    );
    const sessionsOf = [taskAFirst, taskASecond, taskBFirst].map(
      (run) => service.run(run.id)?.sessionId,
    );
    expect(sessionsOf[0]).toBe("de-task-TSK-A-pluginmax-de");
    expect(sessionsOf[1]).toBe("de-task-TSK-A-pluginmax-de");
    expect(sessionsOf[2]).toBe("de-task-TSK-B-pluginmax-de");
    expect(new Set(sessionsOf).size).toBe(2);
  });

  it("reuses the live handle when the session is already owned", async () => {
    const events: Array<{ type: string; data?: unknown }> = [];
    const liveAgent = {
      session: { id: "session", snapshotEvents: () => events },
      followup: () => {
        events.push({
          type: "assistant/message",
          data: {
            message: {
              content: [{ type: "text", text: "adopted response" }],
            },
          },
        });
      },
      whenIdle: async () => undefined,
      cancel: () => undefined,
    };
    let lookups = 0;
    const agents: AgentsRegistryLike = {
      get: () => {
        lookups += 1;
        return lookups >= 2 ? liveAgent : undefined;
      },
      create: async () => {
        throw new Error(
          'session "de-task-TSK-C-pluginmax-de" is already owned by an active write handle',
        );
      },
    };
    const { service, runtime } = harness({
      now,
      agents: () => agents,
      workspaces: {
        create: async (path) => ({
          path,
          attachSession: async () => undefined,
        }),
      },
      sessions: {
        get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
      },
      sessionTitle: { rename: () => undefined },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        employeeId: "pluginmax-de",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-C",
        nodeId: "task",
        dispatchKey: "task:TSK-C:1",
      }),
    );
    await runtime.waitIdle();
    await vi.waitFor(() =>
      expect(service.run(run.id)?.output?.summary).toBe("adopted response"),
    );
    expect(service.run(run.id)?.status).toBe("succeeded");
  });

  it("starts a fresh session after the task session is reset", async () => {
    const attached: string[] = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async (sessionId) => {
          attached.push(sessionId);
        },
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
    };
    const { service, runtime } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle: { rename: () => undefined },
    });
    await createProfile(service);
    const base = dispatchInput({
      source: "task",
      employeeId: "pluginmax-de",
      workspacePath: "/tmp/pluginmax-workspace",
      instanceId: "TSK-R",
      nodeId: "task",
      dispatchKey: "task:TSK-R:1",
    });
    const first = await service.dispatch(base);
    const second = await service.dispatch({
      ...base,
      runSeq: 2,
      dispatchKey: "task:TSK-R:2",
      payload: { ...base.payload, context: { taskSessionEpoch: "1" } },
    });
    await runtime.waitIdle();
    await vi.waitFor(() => expect(attached).toHaveLength(2));
    expect(service.run(first.id)?.sessionId).toBe("de-task-TSK-R-pluginmax-de");
    expect(service.run(second.id)?.sessionId).toBe(
      "de-task-TSK-R-pluginmax-de-r1",
    );
  });

  it("names the task session as 执行人-TSK-任务名称-任务号后4位", async () => {
    const renamed: Array<{ id: string; title: string }> = [];
    const workspaces: WorkspaceRegistryLike = {
      create: async (path) => ({
        path,
        attachSession: async () => undefined,
      }),
    };
    const sessions: AgentSessionsLike = {
      get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
    };
    const { service, runtime } = harness({
      now,
      workspaces,
      sessions,
      sessionTitle: {
        rename: (session, title) => {
          renamed.push({ id: session.id, title });
        },
      },
    });
    await createProfile(service);
    const base = dispatchInput({
      source: "task",
      employeeId: "pluginmax-de",
      workspacePath: "/tmp/pluginmax-workspace",
      instanceId: "TSK-MUDUHMTX-0089",
      nodeId: "task",
      dispatchKey: "task:TSK-MUDUHMTX-0089:1",
    });
    await service.dispatch({
      ...base,
      payload: {
        ...base.payload,
        instanceTitle: "正在测试 05",
        context: { employeeName: "DE 测小白" },
      },
    });
    await runtime.waitIdle();
    await vi.waitFor(() => expect(renamed).toHaveLength(1));
    expect(renamed[0]?.title).toBe("DE 测小白-TSK-正在测试05-0089");
  });

  it("migrates legacy task session titles without a rerun", async () => {
    const titles = new Map<string, string>();
    const renamed: Array<{ id: string; title: string }> = [];
    const { service, runtime, store } = harness({
      now,
      sessions: {
        get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
      },
      sessionTitle: {
        get: (session) => ({ title: titles.get(session.id) ?? "" }),
        rename: (session, title) => {
          titles.set(session.id, title);
          renamed.push({ id: session.id, title });
        },
      },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        instanceId: "TSK-MUDUHMTX-0089",
        dispatchKey: "main:TSK-MUDUHMTX-0089:development:a1:t0#1",
      }),
    );
    const sessionId = "de-task-TSK-MUDUHMTX-0089-development-backend-agent";
    titles.set(sessionId, "TSK-订单导出-development-agent");
    await store.runs.put(run.id, {
      ...service.run(run.id)!,
      sessionId,
      payload: {
        ...service.run(run.id)!.payload,
        context: {
          employeeName: "DE 测小白",
          workflowTaskId: "TSK-MUDUHMTX-0089",
        },
      },
    });

    await runtime.migrateLegacySessionTitles();

    expect(renamed).toEqual([
      { id: sessionId, title: "DE 测小白-TSK-订单导出-0089" },
    ]);
  });

  it("migrates persisted legacy titles by briefly resuming their sessions", async () => {
    const titles = new Map<string, string>();
    const renamed: Array<{ id: string; title: string }> = [];
    const resumed: string[] = [];
    const disposed: string[] = [];
    const sessionId = "de-task-TSK-MUDUHMTX-0089-development-backend-agent";
    const { service, runtime, store } = harness({
      now,
      sessions: { get: () => undefined },
      sessionPersistence: {
        stat: async (candidate) =>
          candidate === sessionId ? { exists: true } : undefined,
      },
      sessionTitle: {
        get: (session) => ({ title: titles.get(session.id) ?? "" }),
        rename: (session, title) => {
          titles.set(session.id, title);
          renamed.push({ id: session.id, title });
        },
      },
      agents: () => ({
        create: async () => {
          throw new Error("create is not used in this test");
        },
        resume: async ({ resumeSessionId }) => {
          resumed.push(resumeSessionId);
          return {
            agent: {
              session: {
                id: resumeSessionId,
                snapshotEvents: () => [],
              },
            },
            dispose: async () => {
              disposed.push(resumeSessionId);
            },
          };
        },
      }),
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        instanceId: "TSK-MUDUHMTX-0089",
        dispatchKey: "main:TSK-MUDUHMTX-0089:development:a1:t0#1",
      }),
    );
    titles.set(sessionId, "TSK-订单导出-development-agent");
    await store.runs.put(run.id, {
      ...service.run(run.id)!,
      sessionId,
      payload: {
        ...service.run(run.id)!.payload,
        context: {
          employeeName: "DE 测小白",
          workflowTaskId: "TSK-MUDUHMTX-0089",
        },
      },
    });

    await runtime.migrateLegacySessionTitles();

    expect(resumed).toEqual([sessionId]);
    expect(disposed).toEqual([sessionId]);
    expect(renamed).toEqual([
      { id: sessionId, title: "DE 测小白-TSK-订单导出-0089" },
    ]);
  });

  it("syncs system task titles to the task-management executor name", async () => {
    const titles = new Map<string, string>();
    const renamed: Array<{ id: string; title: string }> = [];
    const { service, store } = harness({
      now,
      sessions: {
        get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
      },
      sessionTitle: {
        get: (session) => ({ title: titles.get(session.id) ?? "" }),
        rename: (session, title) => {
          titles.set(session.id, title);
          renamed.push({ id: session.id, title });
        },
      },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "task",
        nodeId: "task",
        instanceId: "TSK-MUDUHMTX-0089",
        dispatchKey: "task:TSK-MUDUHMTX-0089:1",
      }),
    );
    const sessionId = "de-task-TSK-MUDUHMTX-0089-backend-agent";
    await store.runs.put(run.id, { ...service.run(run.id)!, sessionId });
    titles.set(sessionId, "BackendAgent-TSK-旧任务-0089");
    renamed.length = 0;

    await service.syncTaskSessionTitles!(
      new Map([["TSK-MUDUHMTX-0089", "Pluginmax DE"]]),
    );

    expect(renamed).toEqual([
      { id: sessionId, title: "Pluginmax DE-TSK-订单导出-0089" },
    ]);
  });

  it("syncs workflow task titles to the task-management executor name", async () => {
    const titles = new Map<string, string>();
    const renamed: Array<{ id: string; title: string }> = [];
    const { service, store } = harness({
      now,
      sessions: {
        get: (sessionId) => ({ id: sessionId, snapshotEvents: () => [] }),
      },
      sessionTitle: {
        get: (session) => ({ title: titles.get(session.id) ?? "" }),
        rename: (session, title) => {
          titles.set(session.id, title);
          renamed.push({ id: session.id, title });
        },
      },
    });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        instanceId: "workflow-instance",
        dispatchKey: "main:workflow-instance:development:a1:t0#1",
      }),
    );
    const sessionId = "de-task-TSK-MUDUHMTX-0089-development-backend-agent";
    await store.runs.put(run.id, {
      ...service.run(run.id)!,
      sessionId,
      payload: {
        ...service.run(run.id)!.payload,
        context: {
          ...service.run(run.id)!.payload.context,
          workflowTaskId: "TSK-MUDUHMTX-0089",
        },
      },
    });
    titles.set(sessionId, "BackendAgent-TSK-旧任务-0089");
    renamed.length = 0;

    await service.syncTaskSessionTitles!(
      new Map([["TSK-MUDUHMTX-0089", "Pluginmax DE"]]),
    );

    expect(renamed).toEqual([
      { id: sessionId, title: "Pluginmax DE-TSK-订单导出-0089" },
    ]);
  });

  it("is idempotent per dispatch key and records successful output", async () => {
    const { service, runtime, subagents, settled } = harness({ now });
    const handler: AgentWorkflowHandler = { onSettled: () => undefined };
    const onSettled = vi.spyOn(handler, "onSettled");
    service.bindWorkflow(handler);
    await createProfile(service);
    const first = await service.dispatch(
      dispatchInput({
        employeeId: "backend-01",
        principalType: "digital-employee",
        ticketId: "ticket-1",
      }),
    );
    const duplicate = await service.dispatch(dispatchInput());
    expect(duplicate.id).toBe(first.id);
    expect(first.status).toBe("queued");
    expect(first).toMatchObject({
      employeeId: "backend-01",
      principalType: "digital-employee",
      ticketId: "ticket-1",
    });
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain("Task Worker");
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain("# 交付报告");
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain(
      "不要先输出计划、推理、检查步骤或工具调用",
    );
    // 空清单 = 不限制：提示词不再声称「没有工具」，也不下发 toolFilter。
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain(
      "本任务不限制可用工具",
    );
    expect(subagents.runs[0]!.spec.toolFilter).toBeUndefined();
    subagents.runs[0]!.outcome = {
      output: [
        {
          type: "text",
          text: "# 交付报告\n\n## 交付说明\n\n这是实现说明的正文内容，足够长。",
        },
      ],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    const saved = service.run(first.id)!;
    expect(saved.status).toBe("succeeded");
    expect(saved.output?.summary).toContain("实现说明");
    expect(saved.settleDelivered).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(settled.map((run) => run.status)).toEqual(["succeeded"]);
  });

  it("always includes the delivery report contract without formal deliverables", async () => {
    const { service, subagents } = harness({ now });
    await createProfile(service);
    const input = dispatchInput();
    input.payload.deliverables = [];
    await service.dispatch(input);
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    const prompt = subagents.runs[0]!.spec.prompt[0]!.text;
    expect(prompt).toContain("最终回复必须直接从「# 交付报告」开始");
    expect(prompt).toContain("报告必须包含二级标题「## 交付说明」");
    expect(prompt).toContain("## 交付说明");
  });

  it("narrows the tool set only when the profile configures tools", async () => {
    const { service, subagents } = harness({ now });
    service.bindWorkflow({ onSettled: () => undefined });
    await createProfile(service, { allowedTools: ["read", "write"] });
    await service.dispatch(
      dispatchInput({
        employeeId: "backend-01",
        principalType: "digital-employee",
        ticketId: "ticket-1",
      }),
    );
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    expect(subagents.runs[0]!.spec.toolFilter).toEqual({
      allow: ["read", "write"],
    });
    expect(subagents.runs[0]!.spec.prompt[0]!.text).toContain(
      "只能使用这些工具：read、write",
    );
  });

  it("passes the SOUL text, not the persona id, to subagent workers", async () => {
    const { service, runtime, subagents } = harness({
      personas: () => ({
        get: async () => ({ soul: "SOUL-BODY-ABC" }),
      }),
    });
    await createProfile(service);
    await service.dispatch(dispatchInput({ personaId: "persona-tm-2" }));
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    // subagent 的 persona 参数是人设正文，传 id 只会把 identifier 注入系统提示。
    expect(subagents.runs[0]!.spec.persona).toBe("SOUL-BODY-ABC");
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
  });

  it("injects the teammate SOUL into the built-in worker prompt", async () => {
    const sink: PromptSectionSink = { sections: [] };
    const { service, runtime } = harness({
      agents: () => fakeAgents(sink),
      personas: () => ({
        get: async () => ({ soul: "SOUL-BODY-XYZ" }),
      }),
    });
    await createProfile(service);
    await service.dispatch(
      dispatchInput({
        source: "task",
        personaId: "persona-tm-1",
        workspacePath: "/tmp/pluginmax-workspace",
        instanceId: "TSK-SOUL",
        nodeId: "task",
        dispatchKey: "task:TSK-SOUL:1",
      }),
    );
    await runtime.waitIdle();
    const soul = sink.sections.find(
      (section) => section.name === "dsh-collab:teammate-soul",
    );
    expect(soul?.text).toContain("SOUL-BODY-XYZ");
    expect(soul?.order).toBe(7);
  });

  it("runs meeting minutes with the fixed Chinese conclusion prompt", async () => {
    const { service, runtime, subagents } = harness({ now });
    const workflowHandler: AgentWorkflowHandler = {
      onSettled: () => undefined,
    };
    const onWorkflowSettled = vi.spyOn(workflowHandler, "onSettled");
    service.bindWorkflow(workflowHandler);
    service.bindTask({ onSettled: () => undefined });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({
        source: "meeting",
        instanceId: "MTG-1",
        nodeId: "meeting-minutes",
        dispatchKey: "MTG-1:minutes:3:2026-10-09T01:00:00.000Z",
        payload: {
          instanceTitle: "周会",
          nodeName: "会议纪要",
          nodeDescription: "对齐 R4 进度",
          profileName: "会议 Facilitator",
          deliverables: [],
          context: {
            transcript: "Olivia: 替代产能锁定在 11 月底。\n李工: 已确认。",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    const prompt = subagents.runs[0]!.spec.prompt[0]!.text;
    expect(prompt).toContain("会议：周会");
    expect(prompt).toContain("对齐 R4 进度");
    expect(prompt).toContain("替代产能锁定在 11 月底");
    expect(prompt).toContain("用中文 Markdown 输出一份结构化会议纪要");
    expect(prompt).toContain("## 结论");
    expect(prompt).toContain("## 行动项");
    subagents.runs[0]!.outcome = {
      output: [{ type: "text", text: "替代产能锁定在 11 月底；风险已确认。" }],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    const saved = service.run(run.id)!;
    expect(saved.status).toBe("succeeded");
    expect(saved.output?.summary).toBe("替代产能锁定在 11 月底；风险已确认。");
    // 会议来源的 run 不走 workflow/task 的交付报告修补与 handler。
    expect(onWorkflowSettled).not.toHaveBeenCalled();
  });

  it("marks failed workers and keeps settle pending until bound", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    subagents.runs[0]!.outcome = {
      output: [{ type: "text", text: "failed output" }],
      stopReason: "error",
      diagnostic: "model crashed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    const saved = service.run(run.id)!;
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("model crashed");
    expect(saved.settleDelivered).toBe(false);
    const handler: AgentWorkflowHandler = { onSettled: () => undefined };
    const onSettled = vi.spyOn(handler, "onSettled");
    service.bindWorkflow(handler);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(service.run(run.id)!.settleDelivered).toBe(true);
  });

  it("reports a clear failure when a completed worker omits text", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    subagents.runs[0]!.outcome = { output: [], stopReason: "completed" };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    const saved = service.run(run.id)!;
    expect(saved.status).toBe("failed");
    expect(saved.error).toBe("Agent 未返回可用的文本输出");
  });

  it("repairs one invalid delivery report and preserves the original output", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    subagents.runs[0]!.outcome = {
      output: [{ type: "text", text: "我完成了实现，但没有使用交付报告。" }],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await vi.waitFor(() => expect(subagents.runs.length).toBe(2));
    expect(subagents.runs[1]!.spec.prompt[0]!.text).toContain(
      "Task Worker 输出修复",
    );
    expect(subagents.runs[1]!.spec.prompt[0]!.text).toContain(
      "缺少一级标题「# 交付报告」",
    );
    subagents.runs[1]!.outcome = {
      output: [
        {
          type: "text",
          text: "# 交付报告\n\n## 交付说明\n\n修复后的实现说明，内容完整。",
        },
      ],
      stopReason: "completed",
    };
    subagents.runs[1]!.resolve();
    await runtime.waitIdle();
    const saved = service.run(run.id)!;
    expect(saved.status).toBe("succeeded");
    expect(saved.output?.summary).toContain("修复后的实现说明");
    expect(saved.output?.rawOutput).toContain("没有使用交付报告");
    expect(saved.output?.repairAttempt).toBe(1);
  });

  it("fails without an extra repair when the attempt budget is exhausted", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(
      dispatchInput({ runSeq: 2, maxAttempts: 2 }),
    );
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    subagents.runs[0]!.outcome = {
      output: [{ type: "text", text: "缺少契约标题的原始输出。" }],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    expect(subagents.runs).toHaveLength(1);
    const saved = service.run(run.id)!;
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("交付报告格式不合格");
    expect(saved.output?.rawOutput).toContain("缺少契约标题");
  });

  it("validates required delivery length before accepting the report", () => {
    const payload = dispatchInput().payload;
    expect(
      deliveryReportIssues("# 交付报告\n\n## 交付说明\n\n太短", payload),
    ).toContain("「交付说明」不足 10 字（当前 2 字）");
  });

  it("supports workflow-compatible filtering by instance id", async () => {
    const { service } = harness({ now });
    await createProfile(service);
    await service.dispatch(dispatchInput());
    await service.dispatch(
      dispatchInput({
        instanceId: "other-instance",
        nodeId: "review",
        dispatchKey: "other-key",
      }),
    );
    expect(service.runs("inst-1").map((run) => run.instanceId)).toEqual([
      "inst-1",
    ]);
  });

  it("cancels a running worker via abort", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    const cancelled = await service.cancel(run.id);
    expect(cancelled.status).toBe("cancelled");
    await runtime.waitIdle();
    expect(service.run(run.id)!.status).toBe("cancelled");
  });

  it("rejects cancellation after a worker reaches a terminal state", async () => {
    const { service, runtime, subagents } = harness({ now });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));
    subagents.runs[0]!.outcome = {
      output: [
        {
          type: "text",
          text: "# 交付报告\n\n## 交付说明\n\n实现已经完成，并通过了本地回归验证。",
        },
      ],
      stopReason: "completed",
    };
    subagents.runs[0]!.resolve();
    await runtime.waitIdle();
    expect(service.run(run.id)!.status).toBe("succeeded");
    await expect(service.cancel(run.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Agent 运行已完成，无法取消",
    });
  });

  it("delivers cancellation without waiting behind the caller's operation lock", async () => {
    const { service, subagents } = harness({ now });
    let releaseWorkflowLock: () => void = () => undefined;
    const workflowLock = new Promise<void>((resolve) => {
      releaseWorkflowLock = resolve;
    });
    const settled: AgentRun[] = [];
    service.bindWorkflow({
      onSettled: (run) => {
        settled.push(run);
        return workflowLock;
      },
    });
    await createProfile(service);
    const run = await service.dispatch(dispatchInput());
    await vi.waitFor(() => expect(subagents.runs.length).toBe(1));

    const cancellation = service.cancel(run.id);
    void cancellation.finally(() => releaseWorkflowLock());
    await cancellation;
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    releaseWorkflowLock();
    await vi.waitFor(() =>
      expect(service.run(run.id)!.settleDelivered).toBe(true),
    );
  });

  it("times out stuck workers", async () => {
    vi.useFakeTimers();
    try {
      const { service, runtime, subagents } = harness({
        now,
      });
      await createProfile(service);
      const run = await service.dispatch(dispatchInput({ timeoutMs: 1_000 }));
      let started = false;
      for (let index = 0; index < 50 && !started; index += 1) {
        await vi.advanceTimersByTimeAsync(10);
        started = subagents.runs.length > 0;
      }
      expect(started).toBe(true);
      const settledPromise = runtime.waitIdle();
      await vi.advanceTimersByTimeAsync(1_500);
      await settledPromise;
      expect(service.run(run.id)!.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores queued runs and retires running runs after restart", async () => {
    const current = tables();
    const before = new AgentRegistryService(current, { now });
    const beforeRuntime = new AgentTaskRuntime({
      tables: current,
      subagents: () => fakeSubagents().runtime,
      agents: fakeAgents,
      now,
    });
    before.attachRuntime(beforeRuntime);
    await createProfile(before);
    await before.dispatch(dispatchInput({ dispatchKey: "k1", runSeq: 1 }));
    await before.dispatch(dispatchInput({ dispatchKey: "k2", runSeq: 2 }));
    // simulate crash: one queued, one running
    const [first, second] = [...current.runs.records.values()].sort(
      (left, right) => left.dispatchKey.localeCompare(right.dispatchKey),
    );
    await current.runs.put(first!.id, {
      ...first,
      status: "running",
    } as AgentRun);
    await current.runs.put(second!.id, {
      ...second,
      status: "running",
    } as AgentRun);
    await current.runs.put(second!.id, {
      ...second,
      status: "queued",
    } as AgentRun);
    const settled: AgentRun[] = [];
    const after = new AgentRegistryService(current, { now });
    const afterSubagents = fakeSubagents();
    const afterRuntime = new AgentTaskRuntime({
      tables: current,
      subagents: () => afterSubagents.runtime,
      agents: fakeAgents,
      onSettled: (run) => {
        settled.push(run);
        return after.onRuntimeSettled(run);
      },
      now,
    });
    after.attachRuntime(afterRuntime);
    after.restore();
    await vi.waitFor(() => expect(afterSubagents.runs.length).toBe(1));
    afterSubagents.runs[0]!.outcome = {
      output: [
        {
          type: "text",
          text: "# 交付报告\n\n## 交付说明\n\n重启后的重放输出完整有效。",
        },
      ],
      stopReason: "completed",
    };
    afterSubagents.runs[0]!.resolve();
    await vi.waitFor(() =>
      expect(
        [...current.runs.records.values()].every(
          (run) => ["queued", "running"].includes(run.status) === false,
        ),
      ).toBe(true),
    );
    const statuses = [...current.runs.records.values()].map(
      (run) => run.status,
    );
    expect(statuses).toContain("interrupted");
    expect(statuses).toContain("succeeded");
  });
});

describe("agent routes", () => {
  it("requires workspace membership for profile listing", async () => {
    const current = tables();
    const service = new AgentRegistryService(current, { now });
    const members = [{ userId: "ws-owner", memberRole: "owner" as const }];
    const routes = createAgentRoutes(service, () => ({
      resolveToken: (token) =>
        token === "owner"
          ? { userId: "ws-owner", role: "member" as const }
          : token === "stranger"
            ? { userId: "stranger", role: "member" as const }
            : undefined,
      members: () => members,
    }));
    const listRoute = routes.find(
      (route) => route.path === "/api/collab/agent/profiles",
    )!;
    const request = {
      method: "GET",
      url: "/api/collab/agent/profiles?workspaceId=main",
      headers: {
        host: "127.0.0.1:33117",
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer stranger",
      },
    };
    const response = {
      status: 0,
      body: "",
      writeHead(status: number) {
        this.status = status;
        return this;
      },
      end(body?: string) {
        if (body !== undefined) this.body = body;
        return this;
      },
    };
    await listRoute.handler(
      request as unknown as Parameters<WebRouteLike["handler"]>[0],
      response as unknown as Parameters<WebRouteLike["handler"]>[1],
    );
    expect(response.status).toBe(403);
  });
});
