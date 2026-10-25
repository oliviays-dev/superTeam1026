import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(import.meta.dirname, "../client/index.js");

interface SlotSpec {
  readonly id: string;
  readonly name: string;
  readonly order?: number;
}

interface ClientExports {
  inject?: readonly string[];
  apply?: (ctx: {
    slots: {
      inject: (name: string, run: () => void) => void;
      register: (spec: SlotSpec, component?: unknown) => () => void;
    };
  }) => void;
}

interface ScopeStore {
  getSnapshot: () => boolean;
  setAll: (next: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

interface ClientHarnessOptions {
  /** 模拟其他模块已经把范围切成「平台全量」，验证共享 store 会被沿用。 */
  readonly scopeAll?: boolean;
  /** DSH 会话控制器替身：验证「打开会话」入口真的切到了那条会话。 */
  readonly sessions?: { open: (sessionId: string) => void };
  readonly fetchImpl?: (
    input: string,
    init?: unknown,
  ) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
}

function createScopeStore(initial = false): ScopeStore {
  let all = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => all,
    setAll: (next: boolean) => {
      const value = next === true;
      if (value === all) return;
      all = value;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Minimal hook runtime: enough to run the task page's useState/useRef/
 * useEffect/useCallback/useSyncExternalStore graph, flush its async data
 * loaders, and inspect the rendered element tree without React itself.
 *
 * Hook slots are keyed by component identity *and* render occurrence, so a
 * component rendered several times (e.g. the filter drop-downs or task cards)
 * keeps independent state per instance.
 */
interface HookSlots {
  states: unknown[];
  depList: Array<readonly unknown[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
  refs: Array<{ current: unknown }>;
  callbacks: Array<unknown>;
  callbackDeps: Array<readonly unknown[] | undefined>;
  cursor: number;
}

function createReactRuntime() {
  const stores = new Map<string, HookSlots>();
  const componentIds = new WeakMap<object, number>();
  let nextComponentId = 0;
  let passCounters = new Map<string, number>();
  let current: HookSlots | undefined;
  let pending: Array<() => void> = [];

  const idFor = (component: object): string => {
    let id = componentIds.get(component);
    if (id === undefined) {
      nextComponentId += 1;
      id = nextComponentId;
      componentIds.set(component, id);
    }
    const occurrence = passCounters.get(String(id)) ?? 0;
    passCounters.set(String(id), occurrence + 1);
    return `${id}#${occurrence}`;
  };

  const slotsFor = (component: object): HookSlots => {
    const key = idFor(component);
    let slots = stores.get(key);
    if (slots === undefined) {
      slots = {
        states: [],
        depList: [],
        cleanups: [],
        refs: [],
        callbacks: [],
        callbackDeps: [],
        cursor: 0,
      };
      stores.set(key, slots);
    }
    return slots;
  };

  const sameDeps = (
    previous: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ): boolean =>
    Array.isArray(previous) &&
    Array.isArray(next) &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]));

  const readState = (slots: HookSlots, index: number, initial: unknown) => {
    if (!(index in slots.states)) {
      slots.states[index] =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
    }
    return slots.states[index];
  };

  const writeState = (
    slots: HookSlots,
    index: number,
    value: unknown,
  ): void => {
    slots.states[index] =
      typeof value === "function"
        ? (value as (previous: unknown) => unknown)(slots.states[index])
        : value;
  };

  const Fragment = "react.fragment";
  const react = {
    Fragment,
    createElement(
      type: unknown,
      props?: Record<string, unknown> | null,
      ...children: unknown[]
    ) {
      const nextProps: Record<string, unknown> = Object.assign({}, props);
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { type, props: nextProps };
    },
    useState(initial: unknown) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      const value = readState(slots, index, initial);
      return [
        value,
        (next: unknown) => writeState(slots, index, next),
      ] as const;
    },
    useRef(initial: unknown) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (!(index in slots.refs)) slots.refs[index] = { current: initial };
      return slots.refs[index];
    },
    useCallback(callback: unknown, next?: readonly unknown[]) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (sameDeps(slots.callbackDeps[index], next)) {
        return slots.callbacks[index];
      }
      slots.callbacks[index] = callback;
      slots.callbackDeps[index] = next;
      return callback;
    },
    useEffect(effect: () => unknown, next?: readonly unknown[]) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (sameDeps(slots.depList[index], next)) return;
      slots.depList[index] = next;
      pending.push(() => {
        slots.cleanups[index]?.();
        const result = effect();
        slots.cleanups[index] =
          typeof result === "function" ? (result as () => void) : undefined;
      });
    },
    useSyncExternalStore(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (!(index in slots.states)) {
        slots.states[index] = getSnapshot();
        slots.cleanups[index] = subscribe(() => {
          slots.states[index] = getSnapshot();
        });
      }
      return slots.states[index];
    },
  };

  return {
    react,
    beginPass(): void {
      passCounters = new Map();
    },
    beginRender(component: object): void {
      current = slotsFor(component);
      current.cursor = 0;
    },
    runEffects(): void {
      const queue = pending;
      pending = [];
      for (const run of queue) run();
    },
  };
}

type Runtime = ReturnType<typeof createReactRuntime>;

interface TreeNode {
  readonly type?: unknown;
  readonly props?: Record<string, unknown>;
}

function expand(node: unknown, runtime: Runtime): unknown {
  if (Array.isArray(node)) return node.map((child) => expand(child, runtime));
  if (node === null || typeof node !== "object") return node;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === "function") {
    runtime.beginRender(element.type as object);
    return expand(
      (element.type as (props: unknown) => unknown)(element.props ?? {}),
      runtime,
    );
  }
  if (element.props && "children" in element.props) {
    return {
      ...element,
      props: {
        ...element.props,
        children: expand(element.props.children, runtime),
      },
    };
  }
  return node;
}

function renderTree(node: unknown, runtime: Runtime): unknown {
  runtime.beginPass();
  return expand(node, runtime);
}

function findNode(
  root: unknown,
  predicate: (node: TreeNode) => boolean,
): TreeNode | undefined {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const candidate = node as TreeNode;
    if (predicate(candidate)) return candidate;
    const children = candidate.props?.children;
    if (children !== undefined) stack.push(children);
  }
  return undefined;
}

function findNodes(
  root: unknown,
  predicate: (node: TreeNode) => boolean,
): TreeNode[] {
  const matches: TreeNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const candidate = value as TreeNode;
    if (predicate(candidate)) matches.push(candidate);
    visit(candidate.props?.children);
  };
  visit(root);
  return matches;
}

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value))
    return value.some((item) => containsText(item, text));
  if (value !== null && typeof value === "object") {
    return containsText((value as TreeNode).props?.children, text);
  }
  return false;
}

function loadClientExports(options: ClientHarnessOptions = {}) {
  let exports: ClientExports = {};
  const runtime = createReactRuntime();
  const scope = createScopeStore(options.scopeAll === true);
  const shellRoutes: string[] = [];
  const fakeFetch =
    options.fetchImpl ??
    (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const windowStub: Record<string, unknown> = {
    __pluginmaxScope: scope,
    __pluginmaxShell: {
      setRoute: (route: string) => {
        shellRoutes.push(route);
      },
    },
    __ModuleLoader__: {
      load: (definition: {
        id: string;
        factory: (require: (id: string) => unknown) => unknown;
      }) => {
        exports = definition.factory((id: string) => {
          if (id === "react") return runtime.react;
          throw new Error(`unexpected module: ${id}`);
        }) as ClientExports;
      },
    },
    localStorage: { getItem: () => "token", setItem: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // 详情页打开后会起轮询与滚动定位，这里给最朴素的替身。
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    document: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
      createElement: () => ({ style: {}, click: () => undefined }),
      body: { appendChild: () => undefined, removeChild: () => undefined },
    },
    fetch: fakeFetch,
  };
  const source = readFileSync(CLIENT_PATH, "utf8");
  const factory = new Function(
    "window",
    "module",
    "exports",
    "fetch",
    source,
  ) as (
    window: unknown,
    module: { exports: unknown },
    exports: unknown,
    fetch: unknown,
  ) => void;
  const module = { exports: {} };
  factory(windowStub, module, module.exports, fakeFetch);
  return { exports, scope, runtime, shellRoutes, sessions: options.sessions };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const payload = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** 任务记录的后端形状：详情页会读 agentRunIds / steps / messages 等字段。 */
function makeTask(overrides: Record<string, unknown>) {
  return {
    type: "任务",
    description: "任务描述",
    acceptance: ["验收标准"],
    links: [],
    progress: 0,
    sessionEpoch: 0,
    autoSubmitReview: true,
    steps: [{ id: "s-1", label: "执行", done: false }],
    agentRunIds: [],
    messages: [],
    comments: [],
    events: [],
    dependsOn: [],
    queueState: "idle",
    autoRunEligible: true,
    needsInput: false,
    createdByName: "Admin",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

async function settle(
  root: unknown,
  runtime: Runtime,
  passes = 5,
): Promise<unknown> {
  let tree: unknown;
  for (let pass = 0; pass < passes; pass += 1) {
    tree = renderTree(root, runtime);
    runtime.runEffects();
    await tick();
  }
  return tree;
}

/** 平台管理员不是任何项目的成员，但任务分布在未加入项目里。 */
function adminFetch(input: string) {
  if (input.startsWith("/api/collab/auth/me")) {
    return Promise.resolve(
      payload({ user: { id: "admin", name: "Admin", role: "admin" } }),
    );
  }
  if (input.startsWith("/api/collab/team/workspaces")) {
    return Promise.resolve(
      payload({
        workspaces: [
          { id: "ws-1", title: "项目一", path: "/p1", isMember: false },
          { id: "ws-2", title: "项目二", path: "/p2", isMember: true },
        ],
      }),
    );
  }
  if (input.startsWith("/api/collab/tasks/bootstrap")) {
    const workspaceId = new URL(`http://x${input}`).searchParams.get(
      "workspaceId",
    );
    // 目录里带上我自己的分身：既让「责任人=我」的口径可验证，
    // 也让“派我的分身执行”这类快捷动作有可渲染的前提。
    const directory = {
      humans: [],
      agents: [
        {
          id: "tm-admin",
          name: "小白 PD",
          kind: "agent",
          ownerName: "平台 Admin",
          ownerAuthUserId: "admin",
          source: "personal",
          avatar: "",
        },
      ],
      roles: [],
    };
    if (workspaceId === "ws-1") {
      return Promise.resolve(
        payload({
          tasks: [
            makeTask({
              id: "t-mine",
              workspaceId: "ws-1",
              title: "我的任务",
              status: "todo",
              priority: "P2",
              receiverType: "human",
              receiverId: "admin",
              receiverName: "Admin",
              createdBy: "someone",
              updatedAt: "2026-03-02T00:00:00.000Z",
            }),
            makeTask({
              id: "t-others",
              workspaceId: "ws-1",
              title: "别人的任务",
              status: "todo",
              priority: "P2",
              receiverType: "human",
              receiverId: "someone",
              receiverName: "Someone",
              createdBy: "someone",
              updatedAt: "2026-03-01T00:00:00.000Z",
            }),
          ],
          directory,
        }),
      );
    }
    if (workspaceId === "ws-2") {
      return Promise.resolve(
        payload({
          tasks: [
            makeTask({
              id: "t-joined",
              workspaceId: "ws-2",
              title: "同项目别人的任务",
              status: "todo",
              priority: "P2",
              receiverType: "human",
              receiverId: "someone",
              receiverName: "Someone",
              createdBy: "someone",
              updatedAt: "2026-02-01T00:00:00.000Z",
            }),
          ],
          directory,
        }),
      );
    }
    return Promise.resolve(payload({ tasks: [], directory }));
  }
  return Promise.resolve(payload({}));
}

function mountTaskPage(harness: {
  exports: ClientExports;
  runtime: Runtime;
  sessions?: { open: (sessionId: string) => void } | undefined;
}): unknown {
  let Task: ((props: Record<string, unknown>) => unknown) | undefined;
  const ctx = {
    get: (key: string) => (key === "sessions" ? harness.sessions : undefined),
    slots: {
      inject: (_name: string, run: () => void) => run(),
      register: (spec: SlotSpec, component?: unknown) => {
        if (spec.id === "pluginmax-task") {
          Task = component as (props: Record<string, unknown>) => unknown;
        }
        return () => undefined;
      },
    },
  };
  harness.exports.apply?.(ctx);
  expect(Task, "任务管理页应注册到 pluginmax.global").toBeDefined();
  return {
    type: Task,
    props: {
      useShellRoute: (select: (state: unknown) => unknown) =>
        select({ route: "task" }),
    },
  };
}

function titleNode(tree: unknown, title: string): TreeNode | undefined {
  return findNode(
    tree,
    (node) =>
      node.type === "div" &&
      node.props?.className === "pmtask-title" &&
      node.props?.children === title,
  );
}

describe("task client", () => {
  it("clears task data and edit state when the login token changes", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const listenerStart = source.indexOf(
      'window.addEventListener("pluginmax:collab-token", synchronize)',
    );
    const synchronizeStart = source.lastIndexOf(
      "const synchronize =",
      listenerStart,
    );
    const synchronizeEnd = source.indexOf("}, [load]);", listenerStart);
    expect(synchronizeStart).toBeGreaterThan(-1);
    expect(synchronizeEnd).toBeGreaterThan(synchronizeStart);
    const synchronize = source.slice(synchronizeStart, synchronizeEnd);
    expect(synchronize).toContain("setTasks([])");
    expect(synchronize).toContain("setCurrentUser(null)");
    expect(synchronize).toContain('setOwnership("all")');
    expect(synchronize).toContain('setReceiver("me")');
    expect(synchronize).toContain('setPriority("")');
    expect(synchronize).toContain('setSource("")');
    expect(synchronize).toContain('setSearch("")');
    expect(synchronize).toContain("setCreateOpen(false)");
    expect(synchronize).toContain("setAssignOpen(false)");
  });

  it("uses server-projected review authority instead of assignment alone", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("reviewableTaskIds");
    expect(source).toContain(
      "const canReview = reviewableTaskIds.includes(task.id)",
    );
    expect(source).toContain("canReview &&");
  });

  it("only says a completed task reopens when the message addresses its receiver", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain(
      'const reopensTask =\n            task.status === "done" && deliveryTarget !== "collaborators"',
    );
    expect(source).toContain(
      '? "receiver"\n              : addressesReceiver && mentionsCollaborator',
    );
    expect(source).toContain("deliveryTarget,\n            },");
    expect(source).toContain("协作消息已发送，任务状态保持不变");
  });

  it("renders mixed built-in/external runtimes, human reassignment and round instructions", async () => {
    const primaryExecution = {
      provider: "custom",
      model: "deepseek-flash",
      runtime: "Codex CLI",
      runtimeVersion: "0.163.0-alpha.10.2",
      authMode: "api-key",
      sandbox: "read-only / network restricted",
    };
    const collaboratorExecution = {
      provider: "workbuddy",
      model: "hunyuan-code",
      runtime: "WorkBuddy CLI",
      runtimeVersion: "2.161.0",
      authMode: "cli-login",
      sandbox: "accept-edits",
    };
    const secondaryExternalExecution = {
      provider: "workbuddy",
      model: "hy4-reasoning",
      runtime: "CodeBuddy CLI · hy4 标准",
      runtimeVersion: "3.0.1",
      authMode: "cli-login",
      sandbox: "workspace-write",
    };
    const task = makeTask({
      id: "TSK-RUN-META-1",
      workspaceId: "ws-1",
      title: "运行信息展示",
      status: "progress",
      priority: "P1",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "Admin",
      createdBy: "admin",
      updatedAt: "2026-10-23T03:00:00.000Z",
      agentRunIds: ["run-meta-1", "run-meta-2", "run-meta-3"],
      messages: [
        {
          id: "ask-meta-1",
          at: "2026-10-23T02:59:00.000Z",
          authorId: "admin",
          authorName: "Admin",
          kind: "human",
          content: "先使用内置运行时梳理初稿。",
          attachments: [],
          mentions: [],
        },
        {
          id: "run-meta-1",
          at: "2026-10-23T03:00:00.000Z",
          authorId: "tm-1",
          authorName: "Codex 调研架构师",
          kind: "agent",
          content: "调研已完成。",
          attachments: [],
          mentions: [],
          runId: "run-meta-1",
          runRole: "owner",
          state: "succeeded",
          execution: primaryExecution,
        },
        {
          id: "ask-meta-2",
          at: "2026-10-23T03:00:30.000Z",
          authorId: "admin",
          authorName: "Admin",
          kind: "human",
          content: "改派给 WorkBuddy 复核供应链风险。",
          attachments: [],
          mentions: [],
        },
        {
          id: "run-meta-2",
          at: "2026-10-23T03:01:00.000Z",
          authorId: "tm-2",
          authorName: "WorkBuddy 风险官",
          kind: "agent",
          content: "风险意见已补充。",
          attachments: [],
          mentions: [],
          runId: "run-meta-2",
          runRole: "assist",
          state: "succeeded",
          execution: collaboratorExecution,
        },
        {
          id: "run-meta-3",
          at: "2026-10-23T03:02:00.000Z",
          authorId: "tm-3",
          authorName: "CodeBuddy 总结员",
          kind: "agent",
          content: "最终结论已汇总。",
          attachments: [],
          mentions: [],
          runId: "run-meta-3",
          runRole: "owner",
          state: "succeeded",
          execution: secondaryExternalExecution,
        },
      ],
      events: [
        {
          id: "assignment-human-1",
          at: "2026-10-23T03:00:15.000Z",
          actorId: "admin",
          actorName: "Admin",
          kind: "assignment",
          message: "Admin 调整责任人为 人类审核员甲",
        },
        {
          id: "assignment-human-2",
          at: "2026-10-23T03:01:15.000Z",
          actorId: "admin",
          actorName: "Admin",
          kind: "assignment",
          message: "Admin 调整责任人为 人类审核员乙",
        },
        {
          id: "assignment-agent-3",
          at: "2026-10-23T03:01:50.000Z",
          actorId: "admin",
          actorName: "Admin",
          kind: "assignment",
          message: "Admin 调整责任人为 CodeBuddy 总结员",
        },
      ],
    });
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            directory: {
              humans: [],
              agents: [
                {
                  id: "tm-1",
                  name: "Codex 调研架构师",
                  source: "platform",
                },
              ],
              roles: [],
            },
          }),
        );
      }
      if (input.startsWith("/api/collab/agent/runs?")) {
        return Promise.resolve(
          payload({
            runs: [
              {
                id: "run-meta-1",
                status: "succeeded",
                createdAt: "2026-10-23T03:00:00.000Z",
                execution: primaryExecution,
                payload: {
                  profileName: "Codex 调研架构师",
                  context: {
                    taskRunRole: "owner",
                    triggerMessageId: "ask-meta-1",
                  },
                },
              },
              {
                id: "run-meta-2",
                status: "succeeded",
                createdAt: "2026-10-23T03:01:00.000Z",
                execution: collaboratorExecution,
                payload: {
                  profileName: "WorkBuddy 风险官",
                  context: {
                    taskRunRole: "owner",
                    triggerMessageId: "ask-meta-2",
                  },
                },
              },
              {
                id: "run-meta-3",
                status: "succeeded",
                createdAt: "2026-10-23T03:02:00.000Z",
                execution: secondaryExternalExecution,
                payload: {
                  profileName: "CodeBuddy 总结员",
                  context: {
                    taskRunRole: "owner",
                  },
                },
              },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/agent/runs/detail")) {
        const runId = new URL(`http://x${input}`).searchParams.get("runId");
        const executions = new Map([
          ["run-meta-1", primaryExecution],
          ["run-meta-2", collaboratorExecution],
          ["run-meta-3", secondaryExternalExecution],
        ]);
        const selected = {
          id: runId ?? "run-meta-3",
          status: "succeeded",
          execution: executions.get(runId ?? "") ?? secondaryExternalExecution,
        };
        return Promise.resolve(
          payload({
            run: selected,
            progress: null,
          }),
        );
      }
      if (input.startsWith("/api/collab/agent/execution/detail")) {
        const selectedRunId =
          new URL(`http://x${input}`).searchParams.get("runId") ?? "run-meta-3";
        const snapshots = new Map([
          [
            "run-meta-1",
            {
              provider: "custom",
              model: "deepseek-flash",
              runtimeName: "Codex CLI",
              runtimeVersion: "0.163.0-alpha.10.2",
              authMode: "api-key",
              sandbox: "read-only / network restricted",
              searchEnabled: false,
              networkAccess: "restricted",
              searchUsed: false,
              planVisibility: "summary",
            },
          ],
          [
            "run-meta-2",
            {
              provider: "workbuddy",
              model: "hunyuan-code",
              runtimeName: "WorkBuddy CLI",
              runtimeVersion: "2.161.0",
              authMode: "cli-login",
              sandbox: "accept-edits",
              searchEnabled: false,
              networkAccess: "unknown",
              searchUsed: null,
              planVisibility: "summary",
            },
          ],
          [
            "run-meta-3",
            {
              provider: "workbuddy",
              model: "hy4-reasoning",
              runtimeName: "CodeBuddy CLI · hy4 标准",
              runtimeVersion: "3.0.1",
              authMode: "cli-login",
              sandbox: "workspace-write",
              searchEnabled: true,
              networkAccess: "restricted",
              searchUsed: true,
              planVisibility: "structured",
            },
          ],
        ]);
        return Promise.resolve(
          payload({
            execution: {
              runId: selectedRunId,
              plan: {
                id: "plan-1",
                runId: "run-meta-3",
                workspaceId: "ws-1",
                source: "explicit",
                visibility: "structured",
                revision: 2,
                status: "active",
                summary: "先检索来源，再汇总报告",
                steps: [
                  {
                    id: "step-1",
                    ordinal: 0,
                    title: "检索公开来源",
                    status: "completed",
                    evidenceRefs: [],
                  },
                  {
                    id: "step-2",
                    ordinal: 1,
                    title: "汇总最终结论",
                    status: "active",
                    evidenceRefs: [],
                  },
                ],
                subagents: [],
                lastEventSeq: 2,
                createdAt: "2026-10-23T03:02:00.000Z",
                updatedAt: "2026-10-23T03:03:00.000Z",
              },
              events: [
                {
                  id: "event-1",
                  runId: "run-meta-3",
                  seq: 1,
                  type: "tool.call",
                  source: "external-trace",
                  visibility: "public",
                  summary: "调用工具：web_search",
                  createdAt: "2026-10-23T03:02:10.000Z",
                },
              ],
              gates: [
                {
                  id: "gate-1",
                  runId: "run-meta-3",
                  taskId: "TSK-RUN-META-1",
                  workspaceId: "ws-1",
                  kind: "tool-approval",
                  status: "pending",
                  reason: "请求写入最终报告文件",
                  requestedScope: ["write"],
                  enforcement: "blocking",
                  requestedAt: "2026-10-23T03:02:20.000Z",
                },
              ],
              snapshot: {
                runId: selectedRunId,
                ...(snapshots.get(selectedRunId) ??
                  snapshots.get("run-meta-3")),
              },
            },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/documents")) {
        return Promise.resolve(
          payload({
            workspaceReady: true,
            documents: [
              {
                id: "doc-meta-1",
                runId: "run-meta-1",
                kind: "produced",
                name: "primary.md",
                relativePath: "outputs/run-meta-1/primary.md",
                size: 10,
                mimeType: "text/markdown",
                updatedBy: "Codex 调研架构师",
                updatedAt: "2026-10-23T03:00:00.000Z",
                available: true,
              },
              {
                id: "doc-meta-2",
                runId: "run-meta-2",
                kind: "produced",
                name: "collaborator.md",
                relativePath: "outputs/run-meta-2/collaborator.md",
                size: 10,
                mimeType: "text/markdown",
                updatedBy: "WorkBuddy 风险官",
                updatedAt: "2026-10-23T03:01:00.000Z",
                available: true,
              },
              {
                id: "doc-meta-3",
                runId: "run-meta-3",
                kind: "produced",
                name: "summary.md",
                relativePath: "outputs/run-meta-3/summary.md",
                size: 10,
                mimeType: "text/markdown",
                updatedBy: "CodeBuddy 总结员",
                updatedAt: "2026-10-23T03:02:00.000Z",
                available: true,
              },
            ],
          }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-RUN-META-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const meta = findNode(
      tree,
      (node) => node.props?.className === "pmtask-run-meta",
    );
    expect(meta, "Agent 回复下应展示结构化运行信息").toBeDefined();
    expect(containsText(meta?.props?.children, "deepseek-flash")).toBe(true);
    expect(containsText(meta?.props?.children, "api-key")).toBe(true);
    expect(
      containsText(meta?.props?.children, "read-only / network restricted"),
    ).toBe(true);

    const executionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    expect(executionRecord, "轮次与二级内容应统一收在执行记录中").toBeDefined();
    expect(containsText(executionRecord?.props?.children, "AI执行记录")).toBe(
      true,
    );
    expect(
      findNode(
        executionRecord,
        (node) => node.type === "h4" && node.props?.children === "AI伙伴",
      ),
      "执行记录内不再重复展示 AI伙伴区块",
    ).toBeUndefined();
    expect(containsText(executionRecord?.props?.children, "产出物")).toBe(true);
    expect(containsText(executionRecord?.props?.children, "执行过程")).toBe(
      true,
    );
    expect(
      containsText(executionRecord?.props?.children, "Agent 执行计划"),
    ).toBe(true);
    expect(containsText(executionRecord?.props?.children, "检索公开来源")).toBe(
      true,
    );
    expect(
      containsText(executionRecord?.props?.children, "调用工具：web_search"),
    ).toBe(true);
    expect(containsText(executionRecord?.props?.children, "运行信息")).toBe(
      true,
    );
    expect(containsText(executionRecord?.props?.children, "实际搜索")).toBe(
      true,
    );
    expect(containsText(executionRecord?.props?.children, "等待执行授权")).toBe(
      true,
    );
    expect(
      containsText(executionRecord?.props?.children, "请求写入最终报告文件"),
    ).toBe(true);

    const executionRuns = findNode(
      executionRecord,
      (node) => node.props?.className === "pmtask-execution-runs",
    );
    expect(executionRuns, "轮次选择应位于执行记录顶部").toBeDefined();

    const roundTrigger = findNode(
      executionRuns,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-execution-round-trigger",
    );
    expect(roundTrigger, "轮次应通过紧凑下拉框切换").toBeDefined();
    expect(roundTrigger?.props?.["aria-expanded"]).toBe(false);
    const collapsedRoundLabel = findNode(
      roundTrigger,
      (node) =>
        typeof node.props?.children === "string" &&
        /^第 \d+ 轮 · .+ · .+$/.test(node.props.children),
    )?.props?.children;
    expect(collapsedRoundLabel, "收起态只展示轮次、伙伴和状态").toMatch(
      /^第 \d+ 轮 · .+ · .+$/,
    );
    const collapsedRoundTime = findNode(
      roundTrigger,
      (node) =>
        node.type === "time" &&
        node.props?.className === "pmtask-execution-round-trigger-time",
    );
    expect(
      collapsedRoundTime?.props?.dateTime,
      "收起态右侧应展示当前轮的指令发送时间",
    ).toBe("2026-10-23T03:02:00.000Z");
    expect(
      containsText(
        roundTrigger?.props?.children,
        "调整责任人为 CodeBuddy 总结员",
      ),
      "收起态只展示轮次、伙伴和状态，不拼接指令",
    ).toBe(false);
    const selectedRoundInstruction = findNode(
      executionRuns,
      (node) =>
        typeof node.props?.className === "string" &&
        node.props.className.includes("pmtask-selected-round-instruction"),
    );
    expect(
      selectedRoundInstruction,
      "下拉框收起时应在触发器下方展示当前轮指令卡",
    ).toBeDefined();
    expect(
      containsText(
        selectedRoundInstruction?.props?.children,
        "调整责任人为 CodeBuddy 总结员",
      ),
    ).toBe(true);
    const selectedInstructionToggle = findNode(
      selectedRoundInstruction,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-round-instruction-toggle",
    );
    expect(
      containsText(selectedInstructionToggle?.props?.children, "展开完整指令"),
    ).toBe(true);
    (
      selectedInstructionToggle?.props?.onClick as
        ((event: { stopPropagation: () => void }) => void) | undefined
    )?.({
      stopPropagation: () => undefined,
    });
    tree = await settle(root, harness.runtime);
    let refreshedExecutionRuns = findNode(
      tree,
      (node) => node.props?.className === "pmtask-execution-runs",
    );
    expect(
      findNode(
        refreshedExecutionRuns,
        (node) =>
          typeof node.props?.className === "string" &&
          node.props.className.includes("pmtask-selected-round-instruction") &&
          node.props.className.includes("expanded"),
      ),
      "固定指令卡应复用三行指令的展开交互",
    ).toBeDefined();

    const refreshedRoundTrigger = findNode(
      refreshedExecutionRuns,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-execution-round-trigger",
    );
    (refreshedRoundTrigger?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);
    let refreshedExecutionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    refreshedExecutionRuns = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-execution-runs",
    );
    expect(
      findNode(
        refreshedExecutionRuns,
        (node) =>
          typeof node.props?.className === "string" &&
          node.props.className.includes("pmtask-selected-round-instruction"),
      ),
      "展开下拉框后应隐藏固定指令卡，避免与各轮指令重复",
    ).toBeUndefined();
    const openMenu = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-execution-round-menu",
    );
    expect(openMenu, "展开后应展示全部轮次及指令").toBeDefined();
    const orderedRoundOptions = findNodes(
      openMenu,
      (node) =>
        typeof node.props?.className === "string" &&
        node.props.className
          .split(/\s+/)
          .includes("pmtask-execution-round-option"),
    );
    expect(
      orderedRoundOptions.map((option) =>
        ["第 3 轮", "第 2 轮", "第 1 轮"].find((label) =>
          containsText(option.props?.children, label),
        ),
      ),
      "轮次卡片应按最新在前排列",
    ).toEqual(["第 3 轮", "第 2 轮", "第 1 轮"]);
    expect(
      orderedRoundOptions.map(
        (option) =>
          findNode(
            option,
            (node) =>
              node.type === "time" &&
              node.props?.className === "pmtask-execution-round-option-time",
          )?.props?.dateTime,
      ),
      "卡片右侧应展示 Agent Run 实际创建/投递时间",
    ).toEqual([
      "2026-10-23T03:02:00.000Z",
      "2026-10-23T03:01:00.000Z",
      "2026-10-23T03:00:00.000Z",
    ]);
    expect(
      containsText(openMenu?.props?.children, "先使用内置运行时梳理初稿"),
    ).toBe(true);
    expect(
      containsText(
        openMenu?.props?.children,
        "改派给 WorkBuddy 复核供应链风险",
      ),
    ).toBe(true);
    expect(
      containsText(openMenu?.props?.children, "调整责任人为 CodeBuddy 总结员"),
    ).toBe(true);
    const builtinOption = findNode(
      openMenu,
      (node) =>
        node.props?.className === "pmtask-execution-round-option" &&
        containsText(node.props?.children, "第 1 轮"),
    );
    const builtinInstruction = findNode(
      builtinOption,
      (node) => node.props?.className === "pmtask-round-instruction",
    );
    expect(builtinInstruction?.props?.className).not.toContain("expanded");
    expect(readFileSync(CLIENT_PATH, "utf8")).toContain("max-height:4.5em;");
    const expandInstruction = findNode(
      builtinInstruction,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-round-instruction-toggle",
    );
    expect(
      containsText(expandInstruction?.props?.children, "展开完整指令"),
    ).toBe(true);
    let instructionClickStopped = false;
    (
      expandInstruction?.props?.onClick as
        ((event: { stopPropagation: () => void }) => void) | undefined
    )?.({
      stopPropagation: () => {
        instructionClickStopped = true;
      },
    });
    expect(
      instructionClickStopped,
      "展开指令不应冒泡触发整卡选中并收起菜单",
    ).toBe(true);
    tree = await settle(root, harness.runtime);
    refreshedExecutionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    const refreshedOpenMenu = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-execution-round-menu",
    );
    const refreshedBuiltinOption = findNode(
      refreshedOpenMenu,
      (node) =>
        node.props?.className === "pmtask-execution-round-option" &&
        containsText(node.props?.children, "第 1 轮"),
    );
    const expandedBuiltinInstruction = findNode(
      refreshedBuiltinOption,
      (node) => node.props?.className === "pmtask-round-instruction expanded",
    );
    expect(expandedBuiltinInstruction?.props?.className).toContain("expanded");
    expect(
      containsText(
        expandedBuiltinInstruction?.props?.children,
        "先使用内置运行时梳理初稿",
      ),
    ).toBe(true);
    const initialSummary = findNode(
      tree,
      (node) => node.props?.className === "pmtask-run-summary",
    );
    expect(initialSummary, "默认应展示最新一轮运行信息").toBeDefined();
    expect(containsText(initialSummary?.props?.children, "workbuddy")).toBe(
      true,
    );
    expect(containsText(initialSummary?.props?.children, "hy4-reasoning")).toBe(
      true,
    );
    expect(containsText(initialSummary?.props?.children, "CodeBuddy CLI")).toBe(
      true,
    );
    expect(
      containsText(initialSummary?.props?.children, "workspace-write"),
    ).toBe(true);
    expect(
      findNode(
        executionRecord,
        (node) => node.props?.className === "pmtask-participant-list",
      ),
    ).toBeUndefined();
    const initialDocuments = findNode(
      executionRecord,
      (node) => node.props?.className === "pmtask-doc-list",
    );
    expect(containsText(initialDocuments?.props?.children, "summary.md")).toBe(
      true,
    );
    expect(
      containsText(initialDocuments?.props?.children, "collaborator.md"),
    ).toBe(false);
    expect(containsText(tree, "调整责任人为 人类审核员甲")).toBe(true);
    expect(containsText(tree, "调整责任人为 人类审核员乙")).toBe(true);

    const externalOption = findNode(
      refreshedExecutionRecord,
      (node) =>
        node.props?.className === "pmtask-execution-round-option" &&
        containsText(node.props?.children, "第 2 轮"),
    );
    expect(externalOption, "应能定位整张轮次卡片").toBeDefined();
    (externalOption?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);
    refreshedExecutionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    const externalSummary = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-run-summary",
    );
    expect(containsText(externalSummary?.props?.children, "hunyuan-code")).toBe(
      true,
    );
    expect(
      containsText(externalSummary?.props?.children, "WorkBuddy CLI"),
    ).toBe(true);
    expect(containsText(externalSummary?.props?.children, "cli-login")).toBe(
      true,
    );
    expect(containsText(externalSummary?.props?.children, "accept-edits")).toBe(
      true,
    );
    expect(
      findNode(
        refreshedExecutionRecord,
        (node) => node.props?.className === "pmtask-execution-round-menu",
      ),
      "选择轮次后下拉框应收起，不再展示指令详情",
    ).toBeUndefined();
    const externalTrigger = findNode(
      refreshedExecutionRecord,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-execution-round-trigger",
    );
    expect(
      containsText(
        externalTrigger?.props?.children,
        "第 2 轮 · WorkBuddy 风险官 · 已完成",
      ),
    ).toBe(true);
    expect(
      findNode(
        externalTrigger,
        (node) =>
          node.type === "time" &&
          node.props?.className === "pmtask-execution-round-trigger-time",
      )?.props?.dateTime,
      "切换轮次后收起态时间应同步更新",
    ).toBe("2026-10-23T03:01:00.000Z");
    expect(
      containsText(
        externalTrigger?.props?.children,
        "改派给 WorkBuddy 复核供应链风险",
      ),
    ).toBe(false);
    const externalSelectedInstruction = findNode(
      refreshedExecutionRecord,
      (node) =>
        typeof node.props?.className === "string" &&
        node.props.className.includes("pmtask-selected-round-instruction"),
    );
    expect(
      containsText(
        externalSelectedInstruction?.props?.children,
        "改派给 WorkBuddy 复核供应链风险",
      ),
      "切换轮次后固定指令卡应同步为新轮次指令",
    ).toBe(true);
    const externalDocuments = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-doc-list",
    );
    expect(
      containsText(externalDocuments?.props?.children, "collaborator.md"),
    ).toBe(true);
    expect(containsText(externalDocuments?.props?.children, "summary.md")).toBe(
      false,
    );

    (externalTrigger?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);
    refreshedExecutionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    const reopenedMenu = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-execution-round-menu",
    );
    const openRun1Button = findNode(
      reopenedMenu,
      (node) =>
        node.type === "button" && node.props?.["data-run-id"] === "run-meta-1",
    );
    (
      openRun1Button?.props?.onClick as
        ((event: { stopPropagation: () => void }) => void) | undefined
    )?.({
      stopPropagation: () => undefined,
    });
    tree = await settle(root, harness.runtime);
    refreshedExecutionRecord = findNode(
      tree,
      (node) =>
        node.props?.className === "pmtask-side-section pmtask-execution-record",
    );
    const selectedSummary = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-run-summary",
    );
    expect(
      containsText(selectedSummary?.props?.children, "deepseek-flash"),
    ).toBe(true);
    expect(containsText(selectedSummary?.props?.children, "Codex CLI")).toBe(
      true,
    );
    expect(containsText(selectedSummary?.props?.children, "api-key")).toBe(
      true,
    );
    expect(
      containsText(
        selectedSummary?.props?.children,
        "read-only / network restricted",
      ),
    ).toBe(true);

    expect(
      findNode(
        refreshedExecutionRecord,
        (node) => node.props?.className === "pmtask-participant-list",
      ),
    ).toBeUndefined();
    const refreshedDocuments = findNode(
      refreshedExecutionRecord,
      (node) => node.props?.className === "pmtask-doc-list",
    );
    expect(
      containsText(refreshedDocuments?.props?.children, "primary.md"),
    ).toBe(true);
    expect(
      containsText(refreshedDocuments?.props?.children, "collaborator.md"),
    ).toBe(false);
    const builtinTrigger = findNode(
      refreshedExecutionRecord,
      (node) =>
        node.type === "button" &&
        node.props?.className === "pmtask-execution-round-trigger",
    );
    expect(
      containsText(
        builtinTrigger?.props?.children,
        "第 1 轮 · Codex 调研架构师 · 已完成",
      ),
    ).toBe(true);
    expect(
      containsText(builtinTrigger?.props?.children, "先使用内置运行时梳理初稿"),
    ).toBe(false);
    expect(
      findNode(
        refreshedExecutionRecord,
        (node) => node.props?.className === "pmtask-execution-round-menu",
      ),
    ).toBeUndefined();
  });

  it("distinguishes loading from missing legacy run metadata", async () => {
    const task = makeTask({
      id: "TSK-RUN-META-MISSING-1",
      workspaceId: "ws-1",
      title: "历史运行信息缺失",
      status: "progress",
      priority: "P1",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
      agentRunIds: ["run-meta-missing-1"],
      messages: [
        {
          id: "run-meta-missing-1",
          at: "2026-03-07T00:01:00.000Z",
          authorId: "tm-legacy",
          authorName: "历史 AI伙伴",
          kind: "agent",
          content: "历史执行结果",
          attachments: [],
          mentions: [],
          runId: "run-meta-missing-1",
          state: "succeeded",
        },
      ],
    });
    let resolveDetail:
      | ((response: {
          ok: boolean;
          status?: number;
          json: () => Promise<unknown>;
        }) => void)
      | undefined;
    const fetchImpl = (
      input: string,
    ): Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<unknown>;
    }> => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/agent/runs?")) {
        return Promise.resolve(
          payload({
            runs: [
              {
                id: "run-meta-missing-1",
                status: "succeeded",
                createdAt: "2026-03-07T00:01:00.000Z",
                payload: { profileName: "历史 AI伙伴" },
              },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/agent/runs/detail")) {
        return new Promise((resolve) => {
          resolveDetail = resolve;
        });
      }
      if (input.startsWith("/api/collab/tasks/documents")) {
        return Promise.resolve(
          payload({ workspaceReady: true, documents: [] }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-RUN-META-MISSING-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      findNode(
        tree,
        (node) =>
          node.props?.className === "pmtask-run-summary-empty" &&
          containsText(node.props?.children, "正在读取运行信息"),
      ),
      "Run 详情返回前应显示加载状态",
    ).toBeDefined();

    resolveDetail?.(
      payload({
        run: {
          id: "run-meta-missing-1",
          status: "succeeded",
          createdAt: "2026-03-07T00:01:00.000Z",
        },
        progress: null,
      }),
    );
    tree = await settle(root, harness.runtime);
    const unavailable = findNode(
      tree,
      (node) => node.props?.className === "pmtask-run-summary-unavailable",
    );
    expect(
      containsText(unavailable?.props?.children, "该轮未记录运行元数据"),
    ).toBe(true);
    expect(
      containsText(
        unavailable?.props?.children,
        "关联的 Agent Run 不存在，或该轮执行早于运行信息采集",
      ),
    ).toBe(true);
    expect(containsText(tree, "暂无运行信息")).toBe(false);
  });

  it("renders acceptance criteria as checkable items in task detail", async () => {
    const stepCalls: Array<{ path: string; body: unknown }> = [];
    const task = makeTask({
      id: "TSK-ACCEPTANCE-1",
      workspaceId: "ws-1",
      title: "验收项交互",
      status: "progress",
      priority: "P1",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
      steps: [
        { id: "step-scope", label: "完成范围核对", done: false },
        { id: "step-risk", label: "记录风险", done: true },
      ],
    });
    const fetchImpl = (
      input: string,
      init?: unknown,
    ): Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<unknown>;
    }> => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/step")) {
        stepCalls.push({
          path: input,
          body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
        });
        return Promise.resolve(
          payload({
            task: {
              ...task,
              steps: [
                { id: "step-scope", label: "完成范围核对", done: true },
                { id: "step-risk", label: "记录风险", done: true },
              ],
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-ACCEPTANCE-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const acceptance = findNode(
      tree,
      (node) => node.props?.className === "pmtask-acceptance",
    );
    expect(acceptance, "任务详情应展示验收标准").toBeDefined();
    expect(containsText(acceptance?.props?.children, "完成范围核对")).toBe(
      true,
    );
    expect(containsText(acceptance?.props?.children, "记录风险")).toBe(true);

    const firstStep = findNode(
      acceptance,
      (node) =>
        node.type === "input" &&
        node.props?.type === "checkbox" &&
        node.props?.checked === false,
    );
    (firstStep?.props?.onChange as ((event: unknown) => void) | undefined)?.({
      target: { checked: true },
    });
    await settle(root, harness.runtime);

    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0]?.path).toBe("/api/collab/tasks/step");
    expect(stepCalls[0]?.body).toEqual({
      taskId: "TSK-ACCEPTANCE-1",
      stepId: "step-scope",
      done: true,
    });
  });

  it("requires a rejection note before submitting a return", async () => {
    const actionCalls: Array<{ path: string; body: unknown }> = [];
    const task = makeTask({
      id: "TSK-REJECT-1",
      workspaceId: "ws-1",
      title: "退回必须填写说明",
      status: "review",
      priority: "P1",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
    const fetchImpl = (
      input: string,
      init?: unknown,
    ): Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<unknown>;
    }> => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            reviewableTaskIds: ["TSK-REJECT-1"],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/action")) {
        actionCalls.push({
          path: input,
          body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
        });
        return Promise.resolve(
          payload({ task: { ...task, status: "progress" } }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-REJECT-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);
    const rejectButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "退回",
    );
    (rejectButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const dialog = findNode(
      tree,
      (node) =>
        node.type === "form" &&
        node.props?.role === "dialog" &&
        node.props?.["aria-label"] === "退回任务",
    );
    expect(dialog, "点击退回应打开说明输入框").toBeDefined();
    const noteInput = findNode(
      dialog,
      (node) =>
        node.type === "textarea" && node.props?.["aria-label"] === "退回说明",
    );
    expect(noteInput).toBeDefined();
    const confirmButton = () =>
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "确认退回",
      );
    expect(confirmButton()?.props?.disabled).toBe(true);

    (noteInput?.props?.onChange as ((event: unknown) => void) | undefined)?.({
      target: { value: "缺少风险项，请补充影响范围" },
    });
    tree = await settle(root, harness.runtime);
    expect(confirmButton()?.props?.disabled).toBe(false);
    const updatedDialog = findNode(
      tree,
      (node) =>
        node.type === "form" &&
        node.props?.role === "dialog" &&
        node.props?.["aria-label"] === "退回任务",
    );
    (
      updatedDialog?.props?.onSubmit as
        ((event: { preventDefault: () => void }) => void) | undefined
    )?.({ preventDefault: () => undefined });
    await settle(root, harness.runtime);

    expect(actionCalls).toEqual([
      {
        path: "/api/collab/tasks/action",
        body: {
          taskId: "TSK-REJECT-1",
          action: "reject",
          note: "缺少风险项，请补充影响范围",
        },
      },
    ]);
  });

  it("registers the task page into the global slot", () => {
    const { exports: exported } = loadClientExports();
    expect(exported.inject).toEqual(["slots"]);
    const specs: SlotSpec[] = [];
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec) => {
          specs.push(spec);
          return () => undefined;
        },
      },
    };
    exported.apply?.(ctx);
    expect(specs.map((spec) => spec.id)).toEqual(["pluginmax-task"]);
    expect(specs.map((spec) => spec.name)).toEqual(["pluginmax.global"]);
  });

  it("keeps my own tasks from projects I have not joined in the default scope", async () => {
    const harness = loadClientExports({ fetchImpl: adminFetch });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);

    // 默认「责任人=我」：只应看到指派给我的任务，即使它在我未加入的项目里。
    expect(
      titleNode(tree, "我的任务"),
      "默认视图应包含我负责的任务",
    ).toBeDefined();
    expect(titleNode(tree, "别人的任务")).toBeUndefined();
    expect(titleNode(tree, "同项目别人的任务")).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" && node.props?.children === "仅看已加入",
      )?.props?.["aria-pressed"],
      "默认停留在「仅看已加入」",
    ).toBe(true);

    // 把责任人切到「全部」，暴露范围裁剪：已加入项目全看，未加入项目只看我的。
    const receiverTrigger = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "按责任人筛选任务",
    );
    expect(receiverTrigger, "责任人下拉应渲染").toBeDefined();
    (receiverTrigger?.props?.onClick as (() => void) | undefined)?.();
    tree = renderTree(root, harness.runtime);
    harness.runtime.runEffects();

    const allReceiverOption = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.role === "option" &&
        containsText(node.props?.children, "查看所有责任人的任务"),
    );
    expect(allReceiverOption, "「全部责任人」选项应渲染").toBeDefined();
    (allReceiverOption?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      titleNode(tree, "我的任务"),
      "未加入项目里我负责的任务仍在",
    ).toBeDefined();
    expect(
      titleNode(tree, "同项目别人的任务"),
      "已加入项目照常展示",
    ).toBeDefined();
    expect(
      titleNode(tree, "别人的任务"),
      "未加入项目里别人的任务不应出现在默认范围",
    ).toBeUndefined();

    // 切到「平台全量」后，未加入项目里别人的任务也应出现。
    const platformButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "平台全量",
    );
    expect(platformButton, "平台全量切换应渲染").toBeDefined();
    (platformButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      titleNode(tree, "别人的任务"),
      "平台全量应包含全部项目",
    ).toBeDefined();
    expect(harness.scope.getSnapshot(), "切换应写回共享范围 store").toBe(true);
  });

  it("adopts the platform-wide scope chosen by another module", async () => {
    const harness = loadClientExports({
      fetchImpl: adminFetch,
      scopeAll: true,
    });
    const root = mountTaskPage(harness);
    const tree = await settle(root, harness.runtime);
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "平台全量",
      )?.props?.["aria-pressed"],
      "新挂载的任务页应直接处于平台全量",
    ).toBe(true);
  });

  it("labels an avatar-assigned task with its owner so it is clear whose it is", async () => {
    // 平台管理员自己的分身（ownerAuthUserId === admin）承接了任务，工作区已加入。
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-AVATAR-1",
                workspaceId: "ws-1",
                title: "给出一个一句话的联调确认结论",
                status: "review",
                priority: "P2",
                receiverType: "agent",
                receiverId: "tm-x",
                receiverName: "小白 PD",
                createdBy: "admin",
                updatedAt: "2026-03-02T00:00:00.000Z",
              }),
            ],
            directory: {
              humans: [],
              agents: [
                {
                  id: "tm-x",
                  name: "小白 PD",
                  kind: "agent",
                  ownerName: "平台 Admin",
                  ownerAuthUserId: "admin",
                  source: "personal",
                  avatar: "",
                },
              ],
              roles: [],
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    const tree = await settle(root, harness.runtime);

    expect(
      titleNode(tree, "给出一个一句话的联调确认结论"),
      "我的分身承接的任务应出现在默认视图",
    ).toBeDefined();
    const assigneeName = findNode(
      tree,
      (node) =>
        node.type === "span" &&
        node.props?.className === "pmtask-assignee-name",
    );
    expect(
      assigneeName?.props?.children,
      "看板卡片应像详情页一样带上分身归属，避免看起来像别人的任务",
    ).toBe("小白 PD（平台 Admin）");
  });

  it("no longer offers the dispatch-to-my-avatar shortcut, reassign stays", async () => {
    const harness = loadClientExports({ fetchImpl: adminFetch });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);

    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "t-mine",
    );
    expect(card, "看板卡片应可打开详情").toBeDefined();
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" && node.props?.children === "派我的分身执行",
      ),
      "「派我的分身执行」快捷按钮应已下线",
    ).toBeUndefined();
    expect(
      findNode(tree, (node) => node.props?.title === "调整责任人"),
      "改派入口应保留，用户通过它选择分身",
    ).toBeDefined();
  });

  it("shows the owner for a platform avatar matched by employee id", async () => {
    // 「Pluginmax DE」是平台型 teammate 实例，任务里存的还是员工身份 id
    // （pluginmax-de）。它挂在当前用户名下，所以「责任人=我」会命中它，
    // 卡片必须把归属写出来，否则看起来像别人的任务。
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-MUC9XLQ-7B6A",
                workspaceId: "ws-1",
                title: "subagent 会话终验",
                status: "progress",
                priority: "P1",
                receiverType: "agent",
                receiverId: "pluginmax-de",
                receiverName: "Pluginmax DE",
                createdBy: "admin",
                updatedAt: "2026-03-03T00:00:00.000Z",
              }),
            ],
            directory: {
              humans: [],
              agents: [
                {
                  id: "tm-842b0fc6-c4b3-43c2-a32f-24dd2d8d6bc5",
                  name: "Pluginmax DE",
                  kind: "agent",
                  employeeId: "pluginmax-de",
                  ownerName: "平台 Admin",
                  ownerAuthUserId: "admin",
                  source: "platform",
                  avatar: "",
                },
              ],
              roles: [],
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    const tree = await settle(root, harness.runtime);

    expect(
      titleNode(tree, "subagent 会话终验"),
      "我名下平台的执行身份承接的任务，默认视图应能看到",
    ).toBeDefined();
    const assigneeName = findNode(
      tree,
      (node) =>
        node.type === "span" &&
        node.props?.className === "pmtask-assignee-name",
    );
    expect(
      assigneeName?.props?.children,
      "平台型分身也要写出归属，列表才不会看起来混进了别人的任务",
    ).toBe("Pluginmax DE（平台 Admin）");
  });

  it("splits the receiver filter into 我（本人） and 我 + 我的分身", async () => {
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-MINE",
                workspaceId: "ws-1",
                title: "直接指派给我的任务",
                status: "todo",
                priority: "P2",
                receiverType: "human",
                receiverId: "admin",
                receiverName: "平台 Admin",
                createdBy: "someone",
                updatedAt: "2026-03-04T00:00:00.000Z",
              }),
              makeTask({
                id: "TSK-AVATAR",
                workspaceId: "ws-1",
                title: "我分身承接的任务",
                status: "todo",
                priority: "P2",
                receiverType: "agent",
                receiverId: "pluginmax-de",
                receiverName: "Pluginmax DE",
                createdBy: "admin",
                updatedAt: "2026-03-03T00:00:00.000Z",
              }),
            ],
            directory: {
              humans: [],
              agents: [
                {
                  id: "tm-842b0fc6-c4b3-43c2-a32f-24dd2d8d6bc5",
                  name: "Pluginmax DE",
                  kind: "agent",
                  employeeId: "pluginmax-de",
                  ownerName: "平台 Admin",
                  ownerAuthUserId: "admin",
                  source: "platform",
                  avatar: "",
                },
              ],
              roles: [],
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);

    // 默认口径 = 我 + 我的分身：两条都在。
    expect(titleNode(tree, "直接指派给我的任务")).toBeDefined();
    expect(titleNode(tree, "我分身承接的任务")).toBeDefined();

    // 切到「我（本人）」：分身承接的那条必须消失。
    const receiverTrigger = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "按责任人筛选任务",
    );
    (receiverTrigger?.props?.onClick as (() => void) | undefined)?.();
    tree = renderTree(root, harness.runtime);
    harness.runtime.runEffects();

    const selfOption = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.role === "option" &&
        containsText(node.props?.children, "我（本人）"),
    );
    expect(selfOption, "「我（本人）」选项应渲染").toBeDefined();
    (selfOption?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(titleNode(tree, "直接指派给我的任务")).toBeDefined();
    expect(
      titleNode(tree, "我分身承接的任务"),
      "「我（本人）」不应包含我分身承接的任务",
    ).toBeUndefined();
    expect(
      containsText(
        findNode(
          tree,
          (node) => node.props?.["aria-label"] === "按责任人筛选任务",
        )?.props?.children,
        "我（本人）",
      ),
      "筛选器应停在「我（本人）」",
    ).toBe(true);
    expect(
      findNode(
        tree,
        (node) =>
          typeof node.props?.children === "string" &&
          node.props.children.includes("另有 1 条由我的分身"),
      ),
      "本人口径下要提示还有分身承接的任务，避免验收列表看起来凭空消失",
    ).toBeDefined();
  });

  it("opens the task's agent session from the detail", async () => {
    const opened: string[] = [];
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-SESSION-1",
                workspaceId: "ws-1",
                title: "需要跳到执行会话的任务",
                status: "progress",
                priority: "P2",
                receiverType: "agent",
                receiverId: "pluginmax-de",
                receiverName: "Pluginmax DE",
                createdBy: "admin",
                updatedAt: "2026-03-05T00:00:00.000Z",
              }),
            ],
            directory: {
              humans: [],
              agents: [
                {
                  id: "tm-842b0fc6-c4b3-43c2-a32f-24dd2d8d6bc5",
                  name: "Pluginmax DE",
                  kind: "agent",
                  employeeId: "pluginmax-de",
                  ownerName: "平台 Admin",
                  ownerAuthUserId: "admin",
                  source: "platform",
                  avatar: "",
                },
              ],
              roles: [],
            },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/session")) {
        return Promise.resolve(
          payload({ sessionId: "de-task-TSK-SESSION-1-pluginmax-de" }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({
      fetchImpl,
      sessions: { open: (sessionId) => opened.push(sessionId) },
    });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);

    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-SESSION-1",
    );
    expect(card, "看板卡片应可打开详情").toBeDefined();
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const openButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "打开会话",
    );
    expect(openButton, "详情页应提供打开执行会话的入口").toBeDefined();
    (openButton?.props?.onClick as (() => void) | undefined)?.();
    await settle(root, harness.runtime);

    expect(opened, "应切到任务对应的那条 Agent 会话").toEqual([
      "de-task-TSK-SESSION-1-pluginmax-de",
    ]);
    expect(harness.shellRoutes, "shell 应切到会话视图").toContain("session");
  });

  it("keeps the execution session reachable after handoff to the owner", async () => {
    const opened: string[] = [];
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-SESSION-HANDOFF",
                workspaceId: "ws-1",
                title: "Agent 完成后交回 owner",
                status: "review",
                priority: "P2",
                receiverType: "human",
                receiverId: "admin",
                receiverName: "平台 Admin",
                createdBy: "admin",
                agentRunIds: ["run-handoff"],
                updatedAt: "2026-03-05T00:00:00.000Z",
              }),
            ],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/session")) {
        return Promise.resolve(
          payload({ sessionId: "de-task-TSK-SESSION-HANDOFF-agent" }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({
      fetchImpl,
      sessions: { open: (sessionId) => opened.push(sessionId) },
    });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-SESSION-HANDOFF",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const openButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "打开会话",
    );
    expect(
      openButton,
      "任务交回 owner 后仍应能打开产生过的 Agent 会话",
    ).toBeDefined();
    (openButton?.props?.onClick as (() => void) | undefined)?.();
    await settle(root, harness.runtime);
    expect(opened).toEqual(["de-task-TSK-SESSION-HANDOFF-agent"]);
  });

  it("requires claiming a role task before showing the start action", async () => {
    const claimedPaths: string[] = [];
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({
            user: { id: "member", name: "平台 Member", role: "member" },
          }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-ROLE-1",
                workspaceId: "ws-1",
                title: "角色待认领任务",
                status: "todo",
                priority: "P1",
                receiverType: "role",
                receiverId: "builder",
                receiverName: "Builder",
                createdBy: "admin",
                updatedAt: "2026-03-07T00:00:00.000Z",
              }),
            ],
            directory: {
              humans: [],
              agents: [],
              roles: [
                {
                  id: "builder",
                  name: "Builder",
                  assignedUserIds: ["member"],
                },
              ],
            },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/claim")) {
        claimedPaths.push(input);
        return Promise.resolve(
          payload({
            task: makeTask({
              id: "TSK-ROLE-1",
              workspaceId: "ws-1",
              title: "角色待认领任务",
              status: "progress",
              priority: "P1",
              receiverType: "human",
              receiverId: "member",
              receiverName: "平台 Member",
              createdBy: "admin",
              updatedAt: "2026-03-07T00:01:00.000Z",
            }),
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-ROLE-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const button = (label: string) =>
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === label,
      );
    expect(button("认领"), "角色成员应能认领任务").toBeDefined();
    expect(
      button("开始"),
      "角色任务认领前不应提供绕过认领的开始入口",
    ).toBeUndefined();
    (button("认领")?.props?.onClick as (() => void) | undefined)?.();
    await settle(root, harness.runtime);
    expect(claimedPaths).toEqual(["/api/collab/tasks/claim"]);
  });

  it("explains comment semantics while scoping 催办 and session actions", async () => {
    const directory = {
      humans: [],
      agents: [
        {
          id: "tm-842b0fc6-c4b3-43c2-a32f-24dd2d8d6bc5",
          name: "Pluginmax DE",
          kind: "agent",
          employeeId: "pluginmax-de",
          ownerName: "平台 Admin",
          ownerAuthUserId: "admin",
          source: "platform",
          avatar: "",
        },
      ],
      roles: [],
    };
    const renderDetail = async (task: Record<string, unknown>) => {
      const fetchImpl = (input: string) => {
        if (input.startsWith("/api/collab/auth/me")) {
          return Promise.resolve(
            payload({
              user: { id: "admin", name: "平台 Admin", role: "admin" },
            }),
          );
        }
        if (input.startsWith("/api/collab/team/workspaces")) {
          return Promise.resolve(
            payload({
              workspaces: [
                { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
              ],
            }),
          );
        }
        if (input.startsWith("/api/collab/tasks/bootstrap")) {
          return Promise.resolve(
            payload({ tasks: [makeTask(task)], directory }),
          );
        }
        return Promise.resolve(payload({}));
      };
      const harness = loadClientExports({ fetchImpl });
      const root = mountTaskPage(harness);
      const tree = await settle(root, harness.runtime);
      const card = findNode(
        tree,
        (node) => node.props?.["data-task-id"] === task.id,
      );
      (card?.props?.onClick as (() => void) | undefined)?.();
      return await settle(root, harness.runtime);
    };
    const button = (tree: unknown, label: string) =>
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === label,
      );
    const commentPlaceholder = (tree: unknown) =>
      findNode(
        tree,
        (node) =>
          node.type === "input" &&
          String(node.props?.placeholder ?? "").startsWith("普通讨论"),
      )?.props?.placeholder;

    const humanTree = await renderDetail({
      id: "TSK-HUMAN-1",
      workspaceId: "ws-1",
      title: "指派给人的任务",
      status: "todo",
      priority: "P2",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
    expect(button(humanTree, "催办"), "指派给人类的任务应有催办").toBeDefined();
    expect(button(humanTree, "重置会话"), "重置会话入口先隐藏").toBeUndefined();
    expect(commentPlaceholder(humanTree)).toBe(
      "普通讨论不进入 Agent 上下文；关键共识会在下次真实执行时作为背景增量同步",
    );

    const agentTree = await renderDetail({
      id: "TSK-AGENT-1",
      workspaceId: "ws-1",
      title: "交给分身执行的任务",
      status: "progress",
      priority: "P2",
      receiverType: "agent",
      receiverId: "pluginmax-de",
      receiverName: "Pluginmax DE",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
      comments: [
        {
          id: "comment-1",
          at: "2026-03-07T00:00:00.000Z",
          authorId: "admin",
          authorName: "平台 Admin",
          kind: "human",
          content: "先记录一条讨论",
          replies: [],
        },
      ],
    });
    expect(
      button(agentTree, "催办"),
      "Agent 承接的任务不应有催办",
    ).toBeUndefined();
    expect(button(agentTree, "重置会话")).toBeUndefined();
    // 「人工回复」已下线：用户直接在下方输入框录入即可，避免按钮语义误解。
    expect(
      button(agentTree, "人工回复"),
      "人工回复按钮应已下线",
    ).toBeUndefined();
    expect(
      findNode(agentTree, (node) => node.type === "textarea"),
      "下方指令输入框应保留",
    ).toBeDefined();
    expect(button(agentTree, "发送"), "发送按钮应保留").toBeDefined();
    expect(commentPlaceholder(agentTree)).toBe(
      "普通讨论不进入执行上下文；关键共识下次执行时增量同步；@ 当前执行人可发起讨论反馈",
    );
    expect(
      findNode(
        agentTree,
        (node) =>
          node.type === "input" &&
          node.props?.placeholder === "回复 平台 Admin（仅讨论，不触发执行）",
      ),
      "评论回复只记录讨论，不应暗示会触发执行",
    ).toBeDefined();

    const workflowTree = await renderDetail({
      id: "TSK-WORKFLOW-1",
      workspaceId: "ws-1",
      title: "工作流任务",
      status: "review",
      priority: "P2",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
      workflow: {
        instanceId: "wf-1",
        nodeId: "node-1",
        instanceTitle: "发布流程",
        nodeName: "人工发布",
      },
    });
    expect(commentPlaceholder(workflowTree)).toBe(
      "普通讨论不触发执行；关键共识会在后续真实执行时作为背景增量同步",
    );
  });

  it("records a key consensus tag without triggering task execution", async () => {
    const commentCalls: Array<{ path: string; body: unknown }> = [];
    const task = makeTask({
      id: "TSK-CONSENSUS-1",
      workspaceId: "ws-1",
      title: "关键共识录入",
      status: "progress",
      priority: "P2",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
    });
    const fetchImpl = (
      input: string,
      init?: unknown,
    ): Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<unknown>;
    }> => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/comment")) {
        const body = JSON.parse(
          String((init as { body?: unknown })?.body ?? "{}"),
        ) as { content: string; isKeyConsensus: boolean };
        commentCalls.push({ path: input, body });
        return Promise.resolve(
          payload({
            task: {
              ...task,
              comments: [
                {
                  id: "comment-consensus-1",
                  at: "2026-03-07T00:01:00.000Z",
                  authorId: "admin",
                  authorName: "平台 Admin",
                  kind: "human",
                  content: body.content,
                  isKeyConsensus: body.isKeyConsensus,
                  replies: [],
                },
              ],
              updatedAt: "2026-03-07T00:01:00.000Z",
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-CONSENSUS-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      containsText(tree, "将在下次向 Agent 发送执行反馈时作为背景增量同步"),
      "评论区应说明关键共识的增量同步时机",
    ).toBe(true);
    const consensusCheckbox = findNode(
      tree,
      (node) =>
        node.type === "input" &&
        node.props?.["aria-label"] === "标记为关键共识",
    );
    expect(consensusCheckbox).toBeDefined();
    const consensusCopy = findNode(
      tree,
      (node) => node.props?.className === "pmtask-comment-consensus-copy",
    );
    expect(
      findNode(
        consensusCopy,
        (node) =>
          node.type === "em" &&
          String(node.props?.children ?? "").startsWith("仅标记已经确认"),
      ),
      "关键共识说明应与标题在同一行布局容器中",
    ).toBeDefined();
    expect(
      readFileSync(CLIENT_PATH, "utf8"),
      "同一行说明使用可换行的 flex 布局",
    ).toContain(".pmtask-comment-consensus>span{display:flex;");
    expect(
      readFileSync(CLIENT_PATH, "utf8"),
      "说明占据标题后的剩余宽度并在本行内折行",
    ).toContain("flex:1 1 140px;");
    (
      consensusCheckbox?.props?.onChange as
        ((event: unknown) => void) | undefined
    )?.({
      target: { checked: true },
    });
    tree = await settle(root, harness.runtime);

    const commentInput = findNode(
      tree,
      (node) =>
        node.type === "input" &&
        String(node.props?.placeholder ?? "").startsWith("普通讨论"),
    );
    (commentInput?.props?.onChange as ((event: unknown) => void) | undefined)?.(
      {
        target: { value: "正文控制在 1000 字以内。" },
      },
    );
    tree = await settle(root, harness.runtime);

    const form = findNode(
      tree,
      (node) =>
        node.type === "form" &&
        String(node.props?.className ?? "").includes("pmtask-comment-form"),
    );
    expect(
      findNodes(
        form,
        (node) =>
          (node.type === "input" &&
            String(node.props?.placeholder ?? "").startsWith("普通讨论")) ||
          node.props?.className === "pmtask-check pmtask-comment-consensus",
      ).map((node) =>
        node.type === "input" ? "comment-input" : "key-consensus",
      ),
      "评论输入应在关键共识选项之前",
    ).toEqual(["comment-input", "key-consensus"]);
    (
      form?.props?.onSubmit as
        ((event: { preventDefault: () => void }) => void) | undefined
    )?.({ preventDefault: () => undefined });
    tree = await settle(root, harness.runtime);

    expect(commentCalls).toEqual([
      {
        path: "/api/collab/tasks/comment",
        body: {
          taskId: "TSK-CONSENSUS-1",
          content: "正文控制在 1000 字以内。",
          isKeyConsensus: true,
        },
      },
    ]);
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "span" &&
          node.props?.className === "pmtask-pill consensus" &&
          node.props?.children === "关键共识",
      ),
      "关键共识评论应显示标签",
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "input" &&
          node.props?.["aria-label"] === "标记为关键共识",
      )?.props?.checked,
      "提交后应重置关键共识复选框",
    ).toBe(false);
  });

  it("folds cancelled tasks into the done column and drops the cancelled column", async () => {
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-DONE-1",
                workspaceId: "ws-1",
                title: "已完成的任务",
                status: "done",
                priority: "P2",
                receiverType: "human",
                receiverId: "admin",
                receiverName: "平台 Admin",
                createdBy: "admin",
                updatedAt: "2026-03-08T00:00:00.000Z",
              }),
              makeTask({
                id: "TSK-CANCELLED-1",
                workspaceId: "ws-1",
                title: "已取消的任务",
                status: "cancelled",
                priority: "P2",
                receiverType: "human",
                receiverId: "admin",
                receiverName: "平台 Admin",
                createdBy: "admin",
                updatedAt: "2026-03-07T00:00:00.000Z",
              }),
            ],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    const tree = await settle(root, harness.runtime);

    const doneColumn = findNode(
      tree,
      (node) =>
        node.type === "section" &&
        String(node.props?.className ?? "").includes("pmtask-column") &&
        containsText(node.props?.children, "已完成") &&
        containsText(node.props?.children, "已完成的任务") &&
        containsText(node.props?.children, "已取消的任务"),
    );
    expect(doneColumn, "已取消的历史任务应并入「已完成」列").toBeDefined();
    expect(
      findNode(
        tree,
        (node) => node.type === "strong" && node.props?.children === "已取消",
      ),
      "不应再有「已取消」状态列",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "span" &&
          node.props?.className === "pmtask-pill cancelled",
      ),
      "已取消任务卡片应有标记",
    ).toBeDefined();
  });

  it("allows cancelled workflow tasks to be archived while keeping other actions locked", async () => {
    const actionCalls: Array<{ path: string; body: unknown }> = [];
    const task = makeTask({
      id: "TSK-CANCELLED-WORKFLOW-1",
      workspaceId: "ws-1",
      title: "工作流取消的任务",
      status: "cancelled",
      priority: "P2",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "平台 Admin",
      createdBy: "admin",
      updatedAt: "2026-03-07T00:00:00.000Z",
      workflow: {
        instanceId: "wf-1",
        nodeId: "node-1",
        instanceTitle: "发布流程",
        nodeName: "人工发布",
        outcome: "cancelled",
      },
    });
    const fetchImpl = (
      input: string,
      init?: unknown,
    ): Promise<{
      ok: boolean;
      status?: number;
      json: () => Promise<unknown>;
    }> => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [task],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/action")) {
        actionCalls.push({
          path: input,
          body: JSON.parse(String((init as { body?: unknown })?.body ?? "{}")),
        });
        return Promise.resolve(
          payload({
            task: {
              ...task,
              archivedAt: "2026-03-07T01:00:00.000Z",
              updatedAt: "2026-03-07T01:00:00.000Z",
            },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };

    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);
    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-CANCELLED-WORKFLOW-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    const archiveButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "归档",
    );
    expect(archiveButton, "已取消的工作流任务应提供归档入口").toBeDefined();
    expect(archiveButton?.props?.disabled).not.toBe(true);
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "input" &&
          node.props?.placeholder === "任务已取消，评论已锁定",
      )?.props?.disabled,
      "取消态仍应锁定评论等其他写操作",
    ).toBe(true);

    (archiveButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);
    const confirmButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "确认归档",
    );
    expect(confirmButton, "归档前应要求确认").toBeDefined();
    (confirmButton?.props?.onClick as (() => void) | undefined)?.();
    await settle(root, harness.runtime);

    expect(actionCalls).toEqual([
      {
        path: "/api/collab/tasks/action",
        body: {
          taskId: "TSK-CANCELLED-WORKFLOW-1",
          action: "archive",
        },
      },
    ]);
  });

  it("keeps all four board columns inside the desktop pane", () => {
    // 宽屏下四列必须等分可用宽度；只有窄于最小可读宽度时，
    // 才切换成固定列宽并交给看板自身横向滚动。
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("container-type:inline-size");
    expect(source).toContain("grid-template-columns:repeat(4,minmax(0,1fr))");
    expect(source).toContain("@container (max-width:900px)");
    expect(source).toContain("grid-template-columns:repeat(4,220px)");
    expect(source).not.toContain("grid-auto-columns:260px");
  });

  it("lets users define the phase-one execution policy when creating a task", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("允许公开网页与监管文件");
    expect(source).toContain("写文件、执行命令和外部发布前需要人工确认");
    expect(source).toContain("executionPolicy: buildExecutionPolicy(form)");
    expect(source).toContain("本轮模型");
    expect(source).toContain("推理强度");
    expect(source).toContain("沿用 Runtime 默认模型");
    expect(source).toContain("supportedModels");
    expect(source).toContain("reasoningEffort");
    expect(source).toContain("/api/collab/agent/external-runtimes");
    expect(source).toContain("执行运行时（只读）");
    expect(source).toContain('"aria-readonly": "true"');
    expect(source).not.toContain("value: form.runtimeId");
    expect(source).not.toContain("沿用责任人运行时 / 平台推荐");
    expect(source).toContain("searchEnabled");
    expect(source).toContain("searchUsed");
  });

  it("keeps newly created agent tasks visible after review handoff", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain('setOwnership("sent");');
    expect(source).toContain('setReceiver("all");');
    expect(source).not.toContain("receiverFilterKey(task)");
  });

  it("uses product-language labels for plan visibility and source", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain('structured: "结构化"');
    expect(source).toContain('summary: "摘要"');
    expect(source).toContain('derived: "根据事件整理"');
    expect(source).toContain("planVisibilityLabel(selectedPlan.visibility)");
    expect(source).toContain("planSourceLabel(selectedPlan.source)");
    expect(source).toContain('"observe-only": "仅执行后观察"');
    expect(source).toContain(
      'selectedExecution?.gateEnforcement === "observe-only"',
    );
  });

  it("shows the owning project and never offers to change it", async () => {
    const fetchImpl = (input: string) => {
      if (input.startsWith("/api/collab/auth/me")) {
        return Promise.resolve(
          payload({ user: { id: "admin", name: "平台 Admin", role: "admin" } }),
        );
      }
      if (input.startsWith("/api/collab/team/workspaces")) {
        return Promise.resolve(
          payload({
            workspaces: [
              { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            ],
          }),
        );
      }
      if (input.startsWith("/api/collab/tasks/bootstrap")) {
        return Promise.resolve(
          payload({
            tasks: [
              makeTask({
                id: "TSK-PROJECT-1",
                workspaceId: "ws-1",
                title: "归属项目只读展示",
                status: "todo",
                priority: "P2",
                receiverType: "human",
                receiverId: "admin",
                receiverName: "平台 Admin",
                createdBy: "admin",
                updatedAt: "2026-03-06T00:00:00.000Z",
              }),
            ],
            directory: { humans: [], agents: [], roles: [] },
          }),
        );
      }
      return Promise.resolve(payload({}));
    };
    const harness = loadClientExports({ fetchImpl });
    const root = mountTaskPage(harness);
    let tree = await settle(root, harness.runtime);

    const card = findNode(
      tree,
      (node) => node.props?.["data-task-id"] === "TSK-PROJECT-1",
    );
    (card?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    // 详情页展示归属项目（用项目标题，不是 id）。
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "div" &&
          node.props?.className === "pmtask-field" &&
          containsText(node.props?.children, "归属项目") &&
          containsText(node.props?.children, "项目一"),
      ),
      "详情页应展示任务归属的项目",
    ).toBeDefined();

    // 进入编辑态：项目只读展示，且没有任何项目选择控件可以被改。
    const editButton = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "编辑标题、优先级和描述",
    );
    expect(editButton, "详情页应有编辑入口").toBeDefined();
    (editButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(root, harness.runtime);

    expect(
      findNode(
        tree,
        (node) =>
          node.type === "div" &&
          node.props?.className === "pmtask-field pmtask-edit-locked" &&
          containsText(node.props?.children, "创建后不可变更") &&
          containsText(node.props?.children, "项目一"),
      ),
      "编辑态应只读展示归属项目并说明不可变更",
    ).toBeDefined();
    const editForm = findNode(
      tree,
      (node) =>
        node.type === "form" &&
        String(node.props?.className ?? "").includes("pmtask-edit-form"),
    );
    expect(editForm, "编辑表单应渲染").toBeDefined();
    expect(
      findNode(
        editForm?.props?.children,
        (node) =>
          node.type === "select" &&
          containsText(node.props?.children, "项目一"),
      ),
      "编辑表单里不应出现可切换的项目选项",
    ).toBeUndefined();
  });
});
