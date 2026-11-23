import { describe, expect, expectTypeOf, it } from "vitest";
import {
  agentDomainSpec,
  type AgentContext,
  type AgentDomainLike,
  type AgentSessionLike,
  type AgentSessionPersistenceLike,
  type AgentSessionTitleLike,
  type AgentSessionsLike,
  type AgentRegistryService,
  type PersonaServiceLike,
  type SubagentRunLike,
  type SubagentsRuntimeLike,
  type TeamServiceLike,
  type WorkspaceRegistryLike,
} from "./index.js";
import {
  executionDomainSpec,
  AgentExecutionService,
  type ExecutionDomainLike,
} from "./execution.js";

function kvTable<V extends { id: string }>(...values: readonly V[]) {
  const entries = new Map(values.map((value) => [value.id, value]));
  return {
    get: (key: string) => entries.get(key),
    entries: () => entries.entries(),
    keys: () => entries.keys(),
    get size() {
      return entries.size;
    },
    put: async (key: string, value: V) => {
      entries.set(key, value);
    },
    delete: async (key: string) => entries.delete(key),
  } satisfies import("./index.js").KvTableLike<V>;
}

function agentDomain(): AgentDomainLike {
  return {
    table(name) {
      if (name === "profiles") return kvTable();
      if (name === "runs") return kvTable();
      return kvTable();
    },
    close: async () => undefined,
  };
}

function executionDomain(): ExecutionDomainLike {
  const table = () => kvTable();
  return {
    table: () => table(),
    close: async () => undefined,
  } as ExecutionDomainLike;
}

const team: TeamServiceLike = {
  resolveToken: () => ({ userId: "user", role: "owner" }),
  members: () => [],
};

const sessions: AgentSessionsLike = {
  get: () => ({
    id: "session",
    snapshotEvents: () => [],
  }),
};

const sessionPersistence: AgentSessionPersistenceLike = {
  stat: async () => undefined,
};

const sessionTitle: AgentSessionTitleLike = {
  rename: () => undefined,
};

const workspaces: WorkspaceRegistryLike = {
  create: async () => ({
    path: "/tmp/workspace",
    attachSession: async () => undefined,
  }),
};

const subagents = {
  async startActivation(spec: {
    readonly provider: string;
    readonly label: string;
    readonly prompt: ReadonlyArray<{ type: "text"; text: string }>;
    readonly parent: unknown;
    readonly signal: AbortSignal;
    readonly delivery: "caller";
  }): Promise<SubagentRunLike> {
    expect(spec.provider).toBe("spawn");
    expect(spec.label).toBe("contract-worker");
    expect(spec.prompt).toEqual([{ type: "text", text: "contract" }]);
    expect(spec.signal).toBeInstanceOf(AbortSignal);
    expect(spec.delivery).toBe("caller");
    return {
      id: "subagent-run",
      result: Promise.resolve({
        output: [{ type: "text", text: "done" }],
        stopReason: "completed",
      }),
      dispose: async () => undefined,
    };
  },
} satisfies SubagentsRuntimeLike;

function get(key: "collabTeam"): TeamServiceLike | undefined;
function get(key: "collabPersonas"): PersonaServiceLike | undefined;
function get(key: "agents"): undefined;
function get(key: "subagents"): SubagentsRuntimeLike;
function get(key: "workspaceRegistry"): WorkspaceRegistryLike;
function get(key: "sessions"): AgentSessionsLike;
function get(key: "sessionPersistence"): AgentSessionPersistenceLike;
function get(key: "sessionTitle"): AgentSessionTitleLike;
function get(key: "collabTeammates"): undefined;
function get(key: string): unknown;
function get(key: string): unknown {
  const services: Record<string, unknown> = {
    collabTeam: team,
    subagents,
    workspaceRegistry: workspaces,
    sessions,
    sessionPersistence,
    sessionTitle,
  };
  return services[key];
}

function openDomain(spec: typeof agentDomainSpec): Promise<AgentDomainLike>;
function openDomain(spec: typeof executionDomainSpec): Promise<ExecutionDomainLike>;
async function openDomain(
  spec: typeof agentDomainSpec | typeof executionDomainSpec,
): Promise<AgentDomainLike | ExecutionDomainLike> {
  return spec === agentDomainSpec ? agentDomain() : executionDomain();
}

function provideService(
  key: "collabAgent",
  service: AgentRegistryService,
): void;
function provideService(
  key: "collabAgentExecution",
  service: AgentExecutionService,
): void;
function provideService(
  key: "collabAgent" | "collabAgentExecution",
  service: AgentRegistryService | AgentExecutionService,
): void {
  expect(["collabAgent", "collabAgentExecution"]).toContain(key);
  expect(service).toBeDefined();
}

function onHostEvent(
  event: "agent/assistant-stream",
  listener: (payload: unknown) => void,
): () => void;
function onHostEvent(
  event: "tools/pre-execute",
  listener: (
    exec: {
      readonly name: string;
      readonly arguments?: Readonly<Record<string, unknown>> | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly agent?:
        | {
            readonly session?: {
              readonly id?: string | undefined;
            } | undefined;
          } | undefined;
    },
    next: () => Promise<
      | { readonly kind: "allow" }
      | { readonly kind: "deny"; readonly reason: string }
      | { readonly kind: "ask"; readonly reason?: string | undefined }
    >,
  ) => Promise<
    | { readonly kind: "allow" }
    | { readonly kind: "deny"; readonly reason: string }
    | { readonly kind: "ask"; readonly reason?: string | undefined }
  >,
): () => void;
function onHostEvent(
  event: "agent/assistant-stream" | "tools/pre-execute",
  listener: (payload: unknown) => void,
): () => void {
  expect(event).toBe("agent/assistant-stream");
  listener({ text: "contract" });
  return () => undefined;
}

const context = {
  storageDomain: { open: openDomain },
  webServer: { register: () => undefined },
  provide: provideService,
  effect(operation: () => () => void): void {
    expect(operation()).toBeTypeOf("function");
  },
  get,
  on: onHostEvent,
  emit(event: string, payload?: unknown): void {
    expect(event).toBe("collab/agent-run-settled");
    expect(payload).toMatchObject({ runId: "run", status: "succeeded" });
  },
  inject(
    keys: readonly ["collabTeam"],
    callback: (child: AgentContext & { readonly collabTeam: TeamServiceLike }) => void,
  ): void {
    expect(keys).toEqual(["collabTeam"]);
    callback({ ...context, collabTeam: team } as unknown as AgentContext & {
      readonly collabTeam: TeamServiceLike;
    });
  },
} satisfies AgentContext;

describe("dsh-collab-agent host contract", () => {
  it("H1 locks the 0.2.2 activation signature", async () => {
    const resolved = context.get("subagents");
    expect(resolved).toBe(subagents);
    expectTypeOf<
      SubagentsRuntimeLike["startActivation"]
    >().parameters.toEqualTypeOf<
      [
        spec: {
          readonly provider: string;
          readonly label?: string;
          readonly prompt: ReadonlyArray<{ type: "text"; text: string }>;
          readonly parent: unknown;
          readonly signal: AbortSignal;
          readonly delivery: "caller";
        },
      ]
    >();

    const run = await resolved.startActivation({
      provider: "spawn",
      label: "contract-worker",
      prompt: [{ type: "text", text: "contract" }],
      parent: {},
      signal: new AbortController().signal,
      delivery: "caller",
    });
    expect(run.id).toBe("subagent-run");
    await expect(run.result).resolves.toMatchObject({
      stopReason: "completed",
    });
  });

  it("H2 exposes session lookup, persistence, and title services", () => {
    expect(context.get("sessions")).toBe(sessions);
    expect(context.get("sessionPersistence")).toBe(sessionPersistence);
    expect(context.get("sessionTitle")).toBe(sessionTitle);
    const session = sessions.get("session");
    expect(session?.snapshotEvents()).toEqual([]);
  });

  it("H3 exposes the workspace registry", async () => {
    const registry = context.get("workspaceRegistry");
    expect(registry).toBe(workspaces);
    const workspace = await registry.create("/tmp/workspace");
    expect(workspace.path).toBe("/tmp/workspace");
  });

  it("H4 opens both plugin storage domains", async () => {
    const domain = await context.storageDomain.open(agentDomainSpec);
    const execution = await context.storageDomain.open(executionDomainSpec);
    expect(domain.table("profiles").get("missing")).toBeUndefined();
    expect(execution.table("outbox").get("missing")).toBeUndefined();
    await Promise.all([domain.close(), execution.close()]);
  });

  it("H5 accepts the consumed stream and settled event names", () => {
    const dispose = context.on("agent/assistant-stream", () => undefined);
    expect(dispose()).toBeUndefined();
    expect(() =>
      context.emit("collab/agent-run-settled", {
        runId: "run",
        workspaceId: "workspace",
        status: "succeeded",
        source: "task",
      }),
    ).not.toThrow();
  });

  it("H6 invokes provide, inject, and effect lifecycle hooks", () => {
    const agentService = {} as AgentRegistryService;
    const executionService = {} as AgentExecutionService;
    expect(() => context.provide("collabAgent", agentService)).not.toThrow();
    expect(() =>
      context.provide("collabAgentExecution", executionService),
    ).not.toThrow();
    expect(() =>
      context.inject(["collabTeam"], (child) => {
        expect(child.collabTeam.resolveToken("token")?.userId).toBe("user");
      }),
    ).not.toThrow();
  });
});
