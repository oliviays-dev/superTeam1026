import { describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  type AgentExecutionPlan,
  type ExecutionEnvelope,
  type ExecutionGate,
  type RunEvent,
  type RunExecutionSnapshot,
  type RuntimeCapabilityProfile,
} from "@pluginmax/contracts";
import {
  AgentExecutionService,
  type ExecutionProfileLike,
  type ExecutionRunLike,
  type ExecutionRuntimeLike,
} from "./execution.ts";

class FakeTable<V> {
  private readonly values = new Map<string, V>();

  get(key: string): V | undefined {
    return this.values.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.values.entries();
  }

  async put(key: string, value: V): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  get size(): number {
    return this.values.size;
  }
}

interface TestOutbox {
  readonly id: string;
  readonly type: string;
  readonly version: 1;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly status: "pending";
  readonly attempts: 0;
  readonly createdAt: string;
}

function service(now = "2026-10-25T08:00:00.000Z") {
  return new AgentExecutionService(
    {
      capabilities: new FakeTable<RuntimeCapabilityProfile>(),
      envelopes: new FakeTable<ExecutionEnvelope>(),
      plans: new FakeTable<AgentExecutionPlan>(),
      runEvents: new FakeTable<RunEvent>(),
      gates: new FakeTable<ExecutionGate>(),
      snapshots: new FakeTable<RunExecutionSnapshot>(),
      outbox: new FakeTable<TestOutbox>(),
    },
    { now: () => new Date(now) },
  );
}

const profile: ExecutionProfileLike = {
  id: "profile-1",
  name: "Research Agent",
  execution: "external",
  allowedTools: [],
  defaultModel: {
    provider: "custom",
    model: "deepseek-flash",
  },
};

const runtime: ExecutionRuntimeLike = {
  id: "codex-search",
  name: "Codex CLI · Search",
  provider: "codex",
  protocol: "codex-jsonl",
  args: ["--search"],
  status: "active",
};

const run: ExecutionRunLike = {
  id: "run-1",
  workspaceId: "workspace-1",
  source: "task",
  instanceId: "task-1",
  agentProfileId: "profile-1",
  principalId: "principal-agent",
  status: "running",
  payload: {
    context: {
      taskId: "task-1",
      principalId: "principal-agent",
    },
  },
  createdAt: "2026-10-25T08:00:00.000Z",
};

describe("AgentExecutionService", () => {
  it("turns the five capability layers into an explicit search snapshot", async () => {
    const execution = service();
    const policy = legacyTaskExecutionPolicy();
    policy.sourcePolicy.allow.push("public-web");
    policy.runtime.requiredCapabilities.push({
      key: "search",
      necessity: "required",
    });

    const preflight = execution.preflight({
      taskId: "task-1",
      workspaceId: "workspace-1",
      principalId: "principal-agent",
      policy,
      profile,
      runtime,
    });

    expect(preflight.compatible).toBe(true);
    expect(preflight.runtime.capabilities.search).toBe("supported");
    expect(preflight.envelopePreview.resolved.searchEnabled).toBe(true);

    await execution.beginRun({ run, profile, runtime, policy });
    expect(execution.projection("run-1")?.snapshot.gateEnforcement).toBe(
      "observe-only",
    );
    await execution.recordTrace("run-1", {
      kind: "tool_call",
      data: "web_search industry report",
    });
    const finalized = await execution.finalizeRun({
      ...run,
      status: "succeeded",
      endedAt: "2026-10-25T08:01:00.000Z",
      execution: {
        provider: "custom",
        model: "deepseek-flash",
        runtime: "Codex CLI · Search",
        runtimeVersion: "0.163.0",
        authMode: "api-key",
        sandbox: "read-only",
      },
      output: { summary: "report ready" },
    });

    expect(finalized.snapshot.searchEnabled).toBe(true);
    expect(finalized.snapshot.searchUsed).toBe(true);
    expect(finalized.snapshot.usedTools).toContain("web_search");
    expect(finalized.snapshot.runtimeVersion).toBe("0.163.0");
    expect(finalized.snapshot.model).toBe("deepseek-flash");
    expect(finalized.plan.status).toBe("completed");
    expect(finalized.plan.summary).toBe(
      "执行已完成；以下为根据运行事件整理的执行记录。",
    );
  });

  it("keeps searchUsed unknown when the runtime only exposes partial events", async () => {
    const execution = service();
    const plainRuntime: ExecutionRuntimeLike = {
      ...runtime,
      id: "plain",
      name: "Plain CLI",
      protocol: "plain-text",
      args: [],
    };
    await execution.beginRun({ run, profile, runtime: plainRuntime });
    const finalized = await execution.finalizeRun({
      ...run,
      status: "succeeded",
      completedAt: undefined,
    } as ExecutionRunLike);

    expect(finalized.snapshot.searchUsed).toBeNull();
    expect(finalized.snapshot.planVisibility).toBe("summary");
  });

  it("uses declared runtime tools, model pool, and task-level launch overrides", async () => {
    const execution = service();
    const declaredRuntime: ExecutionRuntimeLike = {
      ...runtime,
      id: "declared-runtime",
      name: "Declared Runtime",
      args: [],
      supportedTools: ["web_search", "read_file", "write_file"],
      supportedModels: ["research-fast", "research-deep"],
      defaultModel: "research-fast",
      contextWindowTokens: 128_000,
    };
    const policy = legacyTaskExecutionPolicy();
    policy.runtime.allowedRuntimeIds = ["declared-runtime"];
    policy.runtime.model = "research-deep";
    policy.runtime.reasoningEffort = "high";
    policy.runtime.requiredCapabilities.push(
      { key: "search", necessity: "required" },
      { key: "file-write", necessity: "required" },
    );

    const preflight = execution.preflight({
      taskId: "task-1",
      workspaceId: "workspace-1",
      principalId: "principal-agent",
      policy,
      profile,
      runtime: declaredRuntime,
    });

    expect(preflight.compatible).toBe(true);
    expect(preflight.runtime.capabilities.search).toBe("supported");
    expect(preflight.runtime.capabilities.fileWrite).toBe("supported");
    expect(preflight.runtime.capabilities.shell).toBe("unsupported");
    expect(preflight.runtime.limits.contextWindowTokens).toBe(128_000);
    expect(preflight.envelopePreview.launch).toMatchObject({
      model: "research-deep",
      reasoningEffort: "high",
    });

    await execution.beginRun({
      run,
      profile,
      runtime: declaredRuntime,
      policy,
    });
    expect(execution.projection("run-1")?.snapshot).toMatchObject({
      model: "research-deep",
      reasoningEffort: "high",
    });
  });

  it("rejects a task model outside the selected runtime model pool", () => {
    const execution = service();
    const policy = legacyTaskExecutionPolicy();
    policy.runtime.allowedRuntimeIds = ["declared-runtime"];
    policy.runtime.model = "not-supported";
    const preflight = execution.preflight({
      taskId: "task-1",
      workspaceId: "workspace-1",
      principalId: "principal-agent",
      policy,
      profile,
      runtime: {
        ...runtime,
        id: "declared-runtime",
        supportedModels: ["research-fast"],
      },
    });
    expect(preflight.compatible).toBe(false);
    expect(preflight.gaps).toContainEqual(
      expect.objectContaining({ key: "model", necessity: "required" }),
    );
  });

  it("projects todo/write into a structured Agent Execution Plan", async () => {
    const execution = service();
    await execution.beginRun({ run, profile });
    await execution.recordSessionEvents(
      "run-1",
      [
        {
          type: "todo/write",
          data: {
            todos: [
              { content: "收集竞品", status: "completed" },
              { content: "分析玩法", status: "in_progress" },
            ],
          },
        },
      ],
      0,
    );

    const projection = execution.projection("run-1");
    expect(projection?.plan.source).toBe("explicit");
    expect(projection?.plan.visibility).toBe("structured");
    expect(projection?.plan.steps.map((step) => step.status)).toEqual([
      "completed",
      "active",
    ]);
  });

  it("blocks a tool on a decision gate and records the final decision", async () => {
    const execution = service();
    const policy = legacyTaskExecutionPolicy();
    policy.toolPolicy.requireApproval = ["fs.write"];
    await execution.beginRun({ run, profile, policy });

    const pending = execution.requestGate({
      runId: "run-1",
      kind: "tool-approval",
      reason: "write report",
      requestedToolCategory: "fs.write",
      timeoutMs: 5_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const projection = execution.projection("run-1");
    const gate = projection?.gates.find((item) => item.status === "pending");
    expect(gate).toBeDefined();

    await execution.decideGate({
      gateId: gate!.id,
      decision: "approved",
      actorPrincipalId: "human-1",
    });

    await expect(pending).resolves.toBe("approved");
    expect(execution.gate(gate!.id)?.status).toBe("approved");
  });
});
