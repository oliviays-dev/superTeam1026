import { describe, expect, expectTypeOf, it } from "vitest";
import {
  taskDomainSpec,
  TaskService,
  type TaskContext,
  type TaskDispatchService,
  type TaskDocumentQueryService,
  type TaskRecord,
} from "./index.js";
import type { KvTableLike } from "./service.js";

interface TeamPrincipalLike {
  readonly userId: string;
  readonly role?: "admin" | "owner" | "member" | "guest" | undefined;
}

interface TeamServiceLike {
  resolveToken(token: string): TeamPrincipalLike | undefined;
  users(): readonly { readonly id: string; readonly name: string }[];
  members(workspaceId: string): readonly { readonly userId: string }[];
}

interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): WorkspaceLike | undefined;
  list(): readonly WorkspaceLike[];
}

interface ContextServiceLike {
  registerAdapter(adapter: {
    readonly scene: "task";
    readonly resolve: (input: {
      readonly objectId: string;
      readonly workspaceId?: string | undefined;
    }) => Promise<{
      readonly allowed: boolean;
      readonly workspaceId: string;
      readonly sceneRevision: string;
      readonly sourceRefs: readonly { readonly type: "task"; readonly id: string }[];
    }>;
  }): () => void;
}

function kvTable<V extends { id: string }>(): KvTableLike<V> {
  const entries = new Map<string, V>();
  return {
    get: (key) => entries.get(key),
    entries: () => entries.entries(),
    keys: () => entries.keys(),
    get size() {
      return entries.size;
    },
    put: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => entries.delete(key),
  };
}

const team: TeamServiceLike = {
  resolveToken: (token) =>
    token === "contract-token" ? { userId: "user", role: "owner" } : undefined,
  users: () => [{ id: "user", name: "Contract User" }],
  members: () => [{ userId: "user" }],
};

const workspaces: WorkspaceRegistryLike = {
  get: (workspaceId) =>
    workspaceId === "workspace"
      ? { id: "workspace", path: "/tmp/workspace" }
      : undefined,
  list: () => [{ id: "workspace", path: "/tmp/workspace" }],
};

const contextService: ContextServiceLike = {
  registerAdapter: (adapter) => {
    expect(adapter.scene).toBe("task");
    return () => undefined;
  },
};

function openTaskDomain(): Promise<{
  table(name: "tasks"): KvTableLike<TaskRecord>;
  close(): Promise<void>;
}> {
  return Promise.resolve({
    table: () => kvTable<TaskRecord & { id: string }>(),
    close: async () => undefined,
  });
}

function getTaskValue(key: string): unknown;
function getTaskValue(key: "collabContext"): ContextServiceLike | undefined;
function getTaskValue(key: string): unknown {
  const services: Record<string, unknown> = {
    collabContext: contextService,
    workspaceRegistry: workspaces,
    collabTeam: team,
  };
  return services[key];
}

function provideTaskService(
  key: "collabTasks",
  value: TaskService,
): unknown;
function provideTaskService(
  key: "collabTaskDispatch",
  value: TaskDispatchService,
): unknown;
function provideTaskService(
  key: "collabTaskDocuments",
  value: TaskDocumentQueryService,
): unknown;
function provideTaskService(key: string, value: unknown): unknown {
  expect([
    "collabTasks",
    "collabTaskDispatch",
    "collabTaskDocuments",
  ]).toContain(key);
  expect(value).toBeDefined();
  return undefined;
}

function injectTaskServices(
  keys: readonly ["collabTeam"],
  callback: (child: TaskContext & { readonly collabTeam: TeamServiceLike }) => void,
): { dispose(): void };
function injectTaskServices(
  keys: readonly ["collabAgent"],
  callback: (child: TaskContext & { readonly collabAgent: unknown }) => void,
): { dispose(): void };
function injectTaskServices(
  keys: readonly ["collabAgent", "workspaceRegistry"],
  callback: (child: TaskContext & {
    readonly collabAgent: unknown;
    readonly workspaceRegistry: WorkspaceRegistryLike;
  }) => Promise<void> | void,
): { dispose(): void };
function injectTaskServices(
  keys: readonly ["collabContext"],
  callback: (child: TaskContext & {
    readonly collabContext: ContextServiceLike;
  }) => void,
): { dispose(): void };
function injectTaskServices(
  keys: readonly string[],
  callback: (child: unknown) => Promise<void> | void,
): { dispose(): void } {
  expect(keys.length).toBeGreaterThan(0);
  const child = {
    collabTeam: team,
    collabAgent: {},
    workspaceRegistry: workspaces,
    collabContext: contextService,
  } as unknown;
  void callback(child);
  return { dispose: () => undefined };
}

const context = {
  storageDomain: { open: openTaskDomain },
  effect(operation: () => () => void): void {
    expect(operation()).toBeTypeOf("function");
  },
  provide: provideTaskService,
  webServer: { register: () => undefined },
  get: getTaskValue,
  emit(event: string, payload?: unknown): void {
    expect(event).toBe("collab/task-changed");
    expect(payload).toMatchObject({
      taskId: "task",
      workspaceId: "workspace",
      status: "done",
    });
  },
  inject: injectTaskServices,
} satisfies TaskContext;

describe("dsh-collab-task host contract", () => {
  it("H1 keeps subagents out of the task plugin contract", () => {
    expectTypeOf<TaskContext["get"]>().toBeFunction();
    expect(context.get("subagents")).toBeUndefined();
  });

  it("H2 exposes the task collaboration context service", () => {
    const service = context.get("collabContext");
    expect(service).toBe(contextService);
    const dispose = service?.registerAdapter({
      scene: "task",
      resolve: async (input) => ({
        allowed: input.workspaceId === undefined || input.workspaceId === "workspace",
        workspaceId: "workspace",
        sceneRevision: "2026-11-23T00:00:00.000Z",
        sourceRefs: [{ type: "task", id: "task" }],
      }),
    });
    expect(dispose).toBeTypeOf("function");
    dispose?.();
  });

  it("H3 exposes the workspace registry for dispatch", () => {
    expect(context.get("workspaceRegistry")).toBe(workspaces);
    expect(workspaces.get("workspace")?.path).toBe("/tmp/workspace");
  });

  it("H4 opens the task storage domain", async () => {
    const domain = await context.storageDomain.open(taskDomainSpec);
    expect(domain.table("tasks").get("missing")).toBeUndefined();
    await domain.close();
  });

  it("H5 emits the documented task change event", () => {
    expect(() =>
      context.emit("collab/task-changed", {
        taskId: "task",
        workspaceId: "workspace",
        status: "done",
      }),
    ).not.toThrow();
  });

  it("H6 invokes provide, inject, and effect lifecycle hooks", async () => {
    const taskService = {} as TaskService;
    const dispatchService = {} as TaskDispatchService;
    const documentsService = {} as TaskDocumentQueryService;
    expect(context.provide("collabTasks", taskService)).toBeUndefined();
    expect(
      context.provide("collabTaskDispatch", dispatchService),
    ).toBeUndefined();
    expect(
      context.provide("collabTaskDocuments", documentsService),
    ).toBeUndefined();

    expect(() =>
      context.inject(["collabTeam"], (child) => {
        expect(child.collabTeam.resolveToken("contract-token")?.userId).toBe(
          "user",
        );
      }),
    ).not.toThrow();
    await context.inject(["collabAgent", "workspaceRegistry"], async (child) => {
      expect(child.workspaceRegistry.get("workspace")?.id).toBe("workspace");
    });
  });
});
