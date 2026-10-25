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

interface ClientHarnessOptions {
  readonly react?: unknown;
  /** 模拟另一个模块已经切到「平台全量」，验证新挂载页面会沿用该选择。 */
  readonly scopeAll?: boolean;
  readonly fetchImpl?: (
    input: string,
    init?: unknown,
  ) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
}

function createScopeStore(initial = false) {
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

type ScopeStore = ReturnType<typeof createScopeStore>;

interface MeetingWindowStub {
  __pluginmaxScope: ScopeStore;
  __pluginmaxMeeting?: {
    openPanel: () => void;
    close: () => void;
    toggle: () => void;
  };
  __pluginmaxPendingMeeting?: {
    meetingId: string;
    workspaceId: string;
  } | null;
  localStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
}

/** Executes the bundle with the smallest window/React stand-ins it needs. */
function loadClientExports(options: ClientHarnessOptions = {}): {
  exports: ClientExports;
  scope: ScopeStore;
  window: MeetingWindowStub;
} {
  let exports: ClientExports = {};
  const fakeReact = options.react ?? {
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
    useRef: (value: unknown) => ({ current: value }),
  };
  const fakeJsx = {
    jsx: (type: unknown, props: unknown) => ({ type, props }),
    jsxs: (type: unknown, props: unknown) => ({ type, props }),
  };
  const fakeFetch =
    options.fetchImpl ??
    (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  // 预先放进 window，模拟其他模块已经加载并设置过范围偏好。
  const scope = createScopeStore(options.scopeAll === true);
  const storage = new Map<string, string>();
  const windowStub = {
    __pluginmaxScope: scope,
    __ModuleLoader__: {
      load: (definition: {
        id: string;
        factory: (require: (id: string) => unknown) => unknown;
      }) => {
        exports = definition.factory((id: string) => {
          if (id === "react") return fakeReact;
          if (id === "react/jsx-runtime") return fakeJsx;
          throw new Error(`unexpected module: ${id}`);
        }) as ClientExports;
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
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
  return { exports, scope, window: windowStub };
}

interface TreeNode {
  readonly type?: unknown;
  readonly props?: Record<string, unknown>;
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

function findAll(
  root: unknown,
  predicate: (node: TreeNode) => boolean,
): TreeNode[] {
  const found: TreeNode[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const candidate = node as TreeNode;
    if (predicate(candidate)) found.push(candidate);
    const children = candidate.props?.children;
    if (children !== undefined) stack.push(children);
  }
  return found;
}

function findAllInOrder(
  root: unknown,
  predicate: (node: TreeNode) => boolean,
): TreeNode[] {
  const found: TreeNode[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const candidate = node as TreeNode;
    if (predicate(candidate)) found.push(candidate);
    visit(candidate.props?.children);
  };
  visit(root);
  return found;
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

/**
 * Minimal hook runtime good enough to render the meetings page: enough to run
 * its `useState`/`useRef`/`useEffect` graph, flush the async data loaders, and
 * inspect the resulting element tree without pulling React itself into tests.
 */
interface HookSlots {
  states: unknown[];
  depList: Array<readonly unknown[] | undefined>;
  cleanups: Array<(() => void) | undefined>;
  refs: Array<{ current: unknown }>;
  cursor: number;
}

function createReactRuntime() {
  const stores = new WeakMap<object, HookSlots>();
  let current: HookSlots | undefined;
  let pending: Array<() => void> = [];

  const slotsFor = (component: object): HookSlots => {
    let slots = stores.get(component);
    if (slots === undefined) {
      slots = { states: [], depList: [], cleanups: [], refs: [], cursor: 0 };
      stores.set(component, slots);
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

  const react = {
    useState(initial: unknown) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (!(index in slots.states)) {
        slots.states[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      }
      const setState = (value: unknown): void => {
        slots.states[index] =
          typeof value === "function"
            ? (value as (previous: unknown) => unknown)(slots.states[index])
            : value;
      };
      return [slots.states[index], setState];
    },
    useRef(initial: unknown) {
      const slots = current as HookSlots;
      const index = slots.cursor;
      slots.cursor += 1;
      if (!(index in slots.refs)) slots.refs[index] = { current: initial };
      return slots.refs[index];
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

/** Expands function components into their rendered host-element subtree. */
function renderTree(node: unknown, runtime: Runtime): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => renderTree(child, runtime));
  }
  if (node === null || typeof node !== "object") return node;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === "function") {
    runtime.beginRender(element.type as object);
    return renderTree(
      (element.type as (props: unknown) => unknown)(element.props ?? {}),
      runtime,
    );
  }
  if (element.props && "children" in element.props) {
    return {
      ...element,
      props: {
        ...element.props,
        children: renderTree(element.props.children, runtime),
      },
    };
  }
  return node;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("meeting client", () => {
  it("registers the meetings page and the meeting overlay", () => {
    const { exports: exported } = loadClientExports();
    expect(exported.inject).toEqual(["slots"]);
    const specs: SlotSpec[] = [];
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => {
          run();
        },
        register: (spec: SlotSpec) => {
          specs.push(spec);
          return () => undefined;
        },
      },
    };
    exported.apply?.(ctx);
    expect(specs.map((spec) => spec.id).sort()).toEqual([
      "pluginmax-meeting-panel",
      "pluginmax-meetings",
    ]);
    expect(specs.map((spec) => spec.name).sort()).toEqual([
      "pluginmax.global",
      "shell.overlay",
    ]);
  });

  it("keeps the global meeting switcher limited to conversations with history", async () => {
    const runtime = createReactRuntime();
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const activeConversation = {
      id: "m-ai",
      workspaceId: "system.default",
      title: "有历史的 AI 对话",
      kind: "ai",
      teammateInstanceId: "tm-1",
      status: "active",
      createdBy: "admin",
      updatedAt: "2026-03-03T00:00:00.000Z",
      messageCount: 1,
      unreadCount: 0,
      lastActivityAt: "2026-03-03T00:00:00.000Z",
      lastMessage: {
        content: "历史消息",
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    };
    const fetchImpl = async (input: string) => {
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            {
              id: "ws-1",
              title: "项目一",
              path: "/p1",
              isMember: true,
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({
          user: { id: "admin", name: "Admin", role: "admin" },
        });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({
          teammates: [
            {
              id: "tm-1",
              name: "AI伙伴一",
              ownerName: "Admin",
              state: "active",
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        const meetingId = new URL(`http://x${input}`).searchParams.get(
          "meetingId",
        );
        const meeting =
          meetingId === "m-closed"
            ? {
                id: "m-closed",
                workspaceId: "ws-1",
                title: "有历史的已结束会议",
                kind: "meeting",
                status: "closed",
                createdBy: "admin",
                updatedAt: "2026-03-02T00:00:00.000Z",
                messageCount: 1,
                unreadCount: 0,
                lastActivityAt: "2026-03-02T00:00:00.000Z",
              }
            : activeConversation;
        const content =
          meetingId === "m-closed" ? "会议历史消息" : "历史消息";
        return payload({
          meeting,
          participants: [],
          transcript: [
            {
              id: `msg-${meetingId}`,
              meetingId,
              sequence: 1,
              senderKind: meetingId === "m-closed" ? "human" : "agent",
              senderId: meetingId === "m-closed" ? "admin" : "tm-1",
              senderName:
                meetingId === "m-closed" ? "Admin" : "AI伙伴一",
              content,
              mentions: [],
              deliveries: [],
              createdAt:
                meetingId === "m-closed"
                  ? "2026-03-02T00:00:00.000Z"
                  : "2026-03-03T00:00:00.000Z",
            },
          ],
          actorId: "admin",
        });
      }
      if (input.startsWith("/api/collab/meetings?")) {
        const workspaceId = new URL(`http://x${input}`).searchParams.get(
          "workspaceId",
        );
        return payload({
          meetings:
            workspaceId === "system.default"
              ? [
                  activeConversation,
                  {
                    id: "m-empty-ai",
                    workspaceId,
                    title: "没有历史的 AI 对话",
                    kind: "ai",
                    teammateInstanceId: "tm-2",
                    status: "active",
                    createdBy: "admin",
                    updatedAt: "2026-03-04T00:00:00.000Z",
                    messageCount: 0,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-04T00:00:00.000Z",
                    lastMessage: null,
                  },
                  {
                    id: "m-auto-test",
                    workspaceId,
                    title: "AUTO-REVIEW 会议 1792669878255",
                    kind: "meeting",
                    status: "archived",
                    createdBy: "admin",
                    updatedAt: "2026-03-05T00:00:00.000Z",
                    messageCount: 1,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-05T00:00:00.000Z",
                    summary: "浏览器自动化验收清理。",
                    lastMessage: {
                      content: "自动化会议消息 1792669878255",
                      createdAt: "2026-03-05T00:00:00.000Z",
                    },
                  },
                ]
              : [
                  {
                    id: "m-closed",
                    workspaceId,
                    title: "有历史的已结束会议",
                    kind: "meeting",
                    status: "closed",
                    createdBy: "admin",
                    updatedAt: "2026-03-02T00:00:00.000Z",
                    messageCount: 1,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-02T00:00:00.000Z",
                    lastMessage: {
                      content: "会议历史消息",
                      createdAt: "2026-03-02T00:00:00.000Z",
                    },
                  },
                ],
        });
      }
      return payload({});
    };

    const harness = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Panel: ((props: Record<string, unknown>) => unknown) | undefined;
    harness.exports.apply?.({
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meeting-panel") {
            Panel = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    });
    harness.window.__pluginmaxMeeting?.openPanel();
    const root = { type: Panel, props: {} };
    const settle = async (passes = 5) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };

    let tree = await settle();
    const initialPanelSearch = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "搜索沟通",
    );
    expect(initialPanelSearch, "每次打开侧栏应先展示沟通列表").toBeDefined();
    expect(
      (
        initialPanelSearch?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.height,
      "搜索框应保持固定单行高度，不能被纵向 flex 拉伸",
    ).toBe(34);
    const communicationLabels = findAllInOrder(
      tree,
      (node) =>
        node.type === "button" &&
        String(node.props?.["aria-label"] ?? "").startsWith("打开沟通"),
    ).map((node) => node.props?.["aria-label"]);
    expect(communicationLabels).toEqual([
      "打开沟通 有历史的 AI 对话",
      "打开沟通 有历史的已结束会议",
    ]);
    expect(
      containsText(tree, "进行中"),
      "右侧沟通列表不再显示进行中状态",
    ).toBe(false);
    expect(
      findAll(tree, (node) => node.type === "time").length,
      "右侧沟通列表应在状态位置显示更新时间",
    ).toBeGreaterThanOrEqual(2);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "有历史的 AI 对话 头像",
      ),
      "列表项应显示头像",
    ).toBeDefined();
    expect(
      findNode(tree, (node) => node.props?.children === "没有历史的 AI 对话"),
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.children === "AUTO-REVIEW 会议 1792669878255",
      ),
      "自动化验收生成的会话不应出现在侧栏",
    ).toBeUndefined();
    expect(
      findNode(tree, (node) => node.props?.children === "查看全部"),
    ).toBeUndefined();

    const panelSearch = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "搜索沟通",
    );
    (
      panelSearch?.props?.onChange as
        | ((event: { target: { value: string } }) => void)
        | undefined
    )?.({ target: { value: "项目一" } });
    tree = await settle(2);
    expect(
      findAllInOrder(
        tree,
        (node) =>
          node.type === "button" &&
          String(node.props?.["aria-label"] ?? "").startsWith("打开沟通"),
      ).map((node) => node.props?.["aria-label"]),
      "侧栏搜索应支持项目名称",
    ).toEqual(["打开沟通 有历史的已结束会议"]);

    (
      findNode(
        tree,
        (node) => node.props?.["aria-label"] === "搜索沟通",
      )?.props?.onChange as
        | ((event: { target: { value: string } }) => void)
        | undefined
    )?.({ target: { value: "Admin" } });
    tree = await settle(2);
    expect(
      findAllInOrder(
        tree,
        (node) =>
          node.type === "button" &&
          String(node.props?.["aria-label"] ?? "").startsWith("打开沟通"),
      ).map((node) => node.props?.["aria-label"]),
      "侧栏搜索应支持 AI伙伴 owner",
    ).toEqual(["打开沟通 有历史的 AI 对话"]);

    (
      findNode(
        tree,
        (node) => node.props?.["aria-label"] === "搜索沟通",
      )?.props?.onChange as
        | ((event: { target: { value: string } }) => void)
        | undefined
    )?.({ target: { value: "" } });
    tree = await settle(2);
    const aiItem = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开沟通 有历史的 AI 对话",
    );
    (aiItem?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(3);
    expect(
      findNode(tree, (node) => node.props?.children === "有历史的 AI 对话"),
    ).toBeDefined();
    const switcherButton = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "切换沟通",
    );
    expect(switcherButton, "详情页应提供快速切换沟通入口").toBeDefined();
    (switcherButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(2);
    const switcherPanel = findNode(
      tree,
      (node) =>
        node.props?.role === "dialog" &&
        node.props?.["aria-label"] === "切换沟通",
    );
    expect(switcherPanel, "切换沟通应显示为浮层下拉").toBeDefined();
    expect(
      (
        switcherPanel?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.background,
      "下拉层应使用更深的背景与前景区分",
    ).toContain("bg-layer-2");
    expect(
      (
        switcherPanel?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.boxShadow,
      "下拉层应提供明显阴影",
    ).toContain("rgba(0,0,0,0.58)");
    expect(
      findNode(
        switcherPanel,
        (node) => node.props?.["aria-label"] === "搜索并切换沟通",
      ),
    ).toBeDefined();
    (
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "切换沟通",
      )?.props?.onClick as (() => void) | undefined
    )?.();
    tree = await settle(2);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.role === "dialog" &&
          node.props?.["aria-label"] === "切换沟通",
      ),
    ).toBeUndefined();
    const backButton = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "返回沟通列表",
    );
    expect(backButton, "具体沟通页应提供返回按钮").toBeDefined();
    (backButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(2);
    expect(
      findNode(tree, (node) => node.props?.["aria-label"] === "搜索沟通"),
    ).toBeDefined();

    const newButton = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "新建沟通",
    );
    expect(newButton, "侧栏应提供圆形加号新建入口").toBeDefined();
    (newButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(2);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "新沟通会议主题",
      ),
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "与 AI伙伴一 开始对话",
      ),
    ).toBeDefined();

    const backFromNew = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "返回沟通列表",
    );
    (backFromNew?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(2);
    const closedItem = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开沟通 有历史的已结束会议",
    );
    (closedItem?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(3);
    expect(
      harness.window.localStorage.getItem(
        "pluginmax.collab.meeting.panel.lastMeetingId",
      ),
      "切换沟通后应记住最后选择",
    ).toBe("m-closed");
    harness.window.__pluginmaxMeeting?.close();
    tree = await settle(1);
    harness.window.__pluginmaxMeeting?.openPanel();
    tree = await settle(4);
    expect(
      findNode(
        tree,
        (node) => node.props?.["aria-label"] === "搜索沟通",
      ),
      "重新打开侧栏应回到沟通列表",
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "返回沟通列表",
      ),
    ).toBeUndefined();
    const restoredClosed = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开沟通 有历史的已结束会议",
    );
    expect(
      (
        restoredClosed?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.border,
      "列表应保留上次选择的会话高亮",
    ).toContain("accent-primary");
  });

  it("shows an admin's own meetings and allows creating one without joined projects", async () => {
    const runtime = createReactRuntime();
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const fetchImpl = async (input: string) => {
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            { id: "ws-1", title: "项目一", path: "/p1", isMember: false },
            { id: "ws-2", title: "项目二", path: "/p2", isMember: false },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({ user: { id: "admin", name: "Admin", role: "admin" } });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({ teammates: [] });
      }
      if (input.startsWith("/api/collab/meetings")) {
        const workspaceId = new URL(`http://x${input}`).searchParams.get(
          "workspaceId",
        );
        if (workspaceId === "ws-1") {
          return payload({
            meetings: [
              {
                id: "m-mine",
                workspaceId: "ws-1",
                title: "我的历史会议",
                status: "active",
                createdBy: "admin",
                updatedAt: "2026-03-02T00:00:00.000Z",
                messageCount: 1,
                unreadCount: 0,
                lastActivityAt: "2026-03-02T00:00:00.000Z",
                lastMessage: {
                  content: "我的历史消息",
                  createdAt: "2026-03-02T00:00:00.000Z",
                },
              },
              {
                id: "m-other",
                workspaceId: "ws-1",
                title: "别人的会议",
                status: "active",
                createdBy: "someone-else",
                updatedAt: "2026-03-01T00:00:00.000Z",
              },
            ],
          });
        }
        if (workspaceId === "ws-2") {
          return payload({
            meetings: [
              {
                id: "m-platform",
                workspaceId: "ws-2",
                title: "平台会议",
                status: "active",
                createdBy: "other",
                updatedAt: "2026-02-01T00:00:00.000Z",
                messageCount: 1,
                unreadCount: 0,
                lastActivityAt: "2026-02-01T00:00:00.000Z",
                lastMessage: {
                  content: "平台会议消息",
                  createdAt: "2026-02-01T00:00:00.000Z",
                },
              },
            ],
          });
        }
        return payload({ meetings: [] });
      }
      return payload({});
    };

    const { exports: exported, scope } = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    };
    exported.apply?.(ctx);
    expect(Meetings).toBeDefined();

    const props = {
      useShellRoute: (select: (state: unknown) => unknown) =>
        select({ route: "meetings" }),
    };
    const root = { type: Meetings, props };
    const settle = async (passes = 4) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };
    let tree = await settle();

    // 首屏默认「仅看已加入」，但要带上自己在未加入项目里创建的会议。
    expect(
      findNode(tree, (node) => node.props?.children === "我的历史会议"),
      "默认视图应包含自己创建的会议",
    ).toBeDefined();
    expect(
      findNode(tree, (node) => node.props?.children === "别人的会议"),
      "默认视图不应包含别人创建的会议",
    ).toBeUndefined();
    expect(
      findNode(tree, (node) => node.props?.children === "平台会议"),
      "默认视图不应包含其他项目的会议",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" && node.props?.children === "仅看已加入",
      )?.props?.["aria-pressed"],
      "默认仍停留在「仅看已加入」",
    ).toBe(true);
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "平台全量",
      )?.props?.["aria-pressed"],
    ).toBe(false);

    // 切换后写入跨模块共享 store，并立即按全量刷新当前列表。
    (
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "平台全量",
      )?.props?.onClick as (() => void) | undefined
    )?.();
    tree = await settle();
    expect(scope.getSnapshot(), "平台全量应写入共享范围 store").toBe(true);
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "平台全量",
      )?.props?.["aria-pressed"],
    ).toBe(true);
    expect(
      findNode(tree, (node) => node.props?.children === "平台会议"),
      "全量视图应包含其他项目的会议",
    ).toBeDefined();

    const createButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "新建会议",
    );
    expect(createButton, "新建会议 按钮应渲染").toBeDefined();
    // 平台管理员对全部项目都有建会权限，未加入项目时按钮也必须可用。
    expect(createButton?.props?.disabled).toBe(false);

    // 打开弹窗后，关联项目下拉应列出全部项目与平台默认项目。
    (createButton?.props?.onClick as (() => void) | undefined)?.();
    tree = renderTree(root, runtime);
    runtime.runEffects();

    const projectSelect = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "新建会议关联项目",
    );
    expect(projectSelect, "新建会议弹窗应有项目下拉").toBeDefined();
    const projectChildren = projectSelect?.props?.children;
    const options = (
      Array.isArray(projectChildren) ? projectChildren : [projectChildren]
    ).filter(Boolean) as TreeNode[];
    expect(options.map((option) => option.props?.children)).toEqual([
      "项目一",
      "项目二",
      "默认项目（system，不关联项目）",
    ]);
  });

  it("keeps the shared project scope when the module mounts from a cross-module jump", async () => {
    const runtime = createReactRuntime();
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const fetchImpl = async (input: string) => {
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            { id: "ws-1", title: "项目一", path: "/p1", isMember: false },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({ user: { id: "admin", name: "Admin", role: "admin" } });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({ teammates: [] });
      }
      if (input.startsWith("/api/collab/meetings")) {
        return payload({
          meetings: [
            {
              id: "m-platform",
              workspaceId: "ws-1",
              title: "平台会议",
              status: "active",
              createdBy: "other",
              updatedAt: "2026-03-02T00:00:00.000Z",
              messageCount: 1,
              unreadCount: 0,
              lastActivityAt: "2026-03-02T00:00:00.000Z",
              lastMessage: {
                content: "平台会议消息",
                createdAt: "2026-03-02T00:00:00.000Z",
              },
            },
          ],
        });
      }
      return payload({});
    };

    // 模拟任务/工作流模块已经把范围切成「平台全量」，再跳转打开会议模块。
    const harness = loadClientExports({
      react: runtime.react,
      fetchImpl,
      scopeAll: true,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    };
    harness.exports.apply?.(ctx);
    expect(
      harness.window.__pluginmaxScope,
      "会议模块应复用其他模块已创建的共享范围 store",
    ).toBe(harness.scope);

    const root = {
      type: Meetings,
      props: {
        useShellRoute: (select: (state: unknown) => unknown) =>
          select({ route: "meetings" }),
      },
    };
    let tree: unknown;
    for (let pass = 0; pass < 4; pass += 1) {
      tree = renderTree(root, runtime);
      runtime.runEffects();
      await tick();
    }

    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "平台全量",
      )?.props?.["aria-pressed"],
      "新挂载的会议页应直接处于平台全量",
    ).toBe(true);
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" && node.props?.children === "仅看已加入",
      )?.props?.["aria-pressed"],
    ).toBe(false);
    expect(
      findNode(tree, (node) => node.props?.children === "平台会议"),
    ).toBeDefined();
  });

  it("opens the target meeting from a workbench pending deep link", async () => {
    const runtime = createReactRuntime();
    const requests: string[] = [];
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const fetchImpl = async (input: string) => {
      requests.push(input);
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
            { id: "ws-2", title: "项目二", path: "/p2", isMember: false },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({ user: { id: "admin", name: "Admin", role: "admin" } });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({ teammates: [] });
      }
      if (input.startsWith("/api/collab/meetings?")) {
        const workspaceId = new URL(`http://x${input}`).searchParams.get(
          "workspaceId",
        );
        return payload({
          meetings:
            workspaceId === "ws-2"
              ? [
                  {
                    id: "m-target",
                    workspaceId: "ws-2",
                    title: "待打开会议",
                    status: "closed",
                    createdBy: "admin",
                    updatedAt: "2026-03-02T00:00:00.000Z",
                  },
                ]
              : [],
        });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        return payload({
          meeting: {
            id: "m-target",
            workspaceId: "ws-2",
            title: "待打开会议",
            status: "closed",
            participants: [],
            transcript: [
              {
                id: "msg-target",
                meetingId: "m-target",
                sequence: 1,
                senderKind: "human",
                senderId: "admin",
                senderName: "Admin",
                content: "待打开会议历史消息",
                mentions: [],
                deliveries: [],
                createdAt: "2026-03-02T00:00:00.000Z",
              },
            ],
          },
          participants: [],
          transcript: [
            {
              id: "msg-target",
              meetingId: "m-target",
              sequence: 1,
              senderKind: "human",
              senderId: "admin",
              senderName: "Admin",
              content: "待打开会议历史消息",
              mentions: [],
              deliveries: [],
              createdAt: "2026-03-02T00:00:00.000Z",
            },
          ],
          actorId: "admin",
          read: { lastReadSeq: 0 },
        });
      }
      if (input.startsWith("/api/collab/meeting/minutes")) {
        return payload({ versions: [], current: null });
      }
      if (input.startsWith("/api/collab/meeting/delegates")) {
        return payload({ delegates: [] });
      }
      if (input.startsWith("/api/collab/meeting/tasks")) {
        return payload({ tasks: [] });
      }
      return payload({});
    };

    const harness = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    harness.window.__pluginmaxPendingMeeting = {
      meetingId: "m-target",
      workspaceId: "ws-2",
    };
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    };
    harness.exports.apply?.(ctx);

    const root = {
      type: Meetings,
      props: {
        useShellRoute: (select: (state: unknown) => unknown) =>
          select({ route: "meetings" }),
      },
    };
    let tree: unknown;
    for (let pass = 0; pass < 6; pass += 1) {
      tree = renderTree(root, runtime);
      runtime.runEffects();
      await tick();
    }

    expect(harness.window.__pluginmaxPendingMeeting).toBeNull();
    expect(requests).toContain("/api/collab/meetings?workspaceId=ws-2");
    expect(requests).toContain("/api/collab/meeting?meetingId=m-target");
    expect(
      findNode(tree, (node) => node.props?.children === "待打开会议"),
    ).toBeDefined();
  });

  it("invite picker defaults to 5 visible rows with in-box fuzzy search and multi-select", async () => {
    const runtime = createReactRuntime();
    const names = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"];
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const fetchImpl = async (input: string) => {
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({
          user: { id: "admin", name: "Admin", role: "member" },
        });
      }
      if (input.startsWith("/api/collab/teammates")) {
        // 一条 AI 候选：验证「名字（AI）」的表达与同一个控件里的多选。
        return payload({
          teammates: [{ id: "tm-1", name: "小助手", state: "active" }],
        });
      }
      if (input.startsWith("/api/collab/meeting/people")) {
        return payload({
          people: names.map((name, index) => ({
            id: `u-${index}`,
            name,
            role: "member",
          })),
        });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        return payload({
          meeting: {
            id: "m-1",
            workspaceId: "ws-1",
            title: "评审会",
            status: "active",
          },
          participants: [
            {
              id: "p-1",
              meetingId: "m-1",
              kind: "human",
              refId: "admin",
              displayName: "用户-admin",
              status: "active",
            },
          ],
          transcript: [],
          actorId: "admin",
          canInvite: true,
          canRemove: true,
        });
      }
      if (input.startsWith("/api/collab/meetings")) {
        return payload({
          meetings: [
            {
              id: "m-1",
              workspaceId: "ws-1",
              title: "评审会",
              status: "active",
              createdBy: "admin",
              updatedAt: "2026-03-02T00:00:00.000Z",
              messageCount: 1,
              unreadCount: 0,
              lastActivityAt: "2026-03-02T00:00:00.000Z",
              lastMessage: {
                content: "评审会历史消息",
                createdAt: "2026-03-02T00:00:00.000Z",
              },
            },
          ],
        });
      }
      return payload({});
    };

    const { exports: exported } = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    const ctx = {
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    };
    exported.apply?.(ctx);

    const props = {
      useShellRoute: (select: (state: unknown) => unknown) =>
        select({ route: "meetings" }),
    };
    const root = { type: Meetings, props };
    const settle = async (passes = 4) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };

    let tree = await settle();
    // 选中列表里的会议 -> 打开「邀请成员」弹窗。
    const meetingItem = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        typeof node.props?.onMouseDown === "function" &&
        containsText(node.props?.children, "评审会"),
    );
    expect(meetingItem, "会议列表应有可点选的会议项").toBeDefined();
    (meetingItem?.props?.onMouseDown as (() => void) | undefined)?.();
    (meetingItem?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle();
    const settingsTab = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "设置",
    );
    expect(settingsTab, "中心会议区应有设置页签").toBeDefined();
    (settingsTab?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle();
    const inviteButton = findNode(
      tree,
      (node) => node.type === "button" && node.props?.children === "邀请成员",
    );
    const buttonLabels = findAll(tree, (node) => node.type === "button")
      .map((node) => node.props?.children)
      .filter((children) => typeof children === "string");
    expect(
      inviteButton,
      `应能打开邀请成员弹窗（当前按钮：${buttonLabels.join(" | ")}）`,
    ).toBeDefined();
    (inviteButton?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle();

    // 默认展开：直接可搜索。
    expect(
      findNode(tree, (node) => node.props?.["aria-label"] === "搜索邀请成员"),
      "下拉框内应有搜索输入",
    ).toBeDefined();
    // 默认可见 10 行：列表容器限高 + 滚动。
    const listBox = findNode(tree, (node) => {
      const style = node.props?.style as
        { maxHeight?: unknown; overflowY?: unknown } | undefined;
      return style?.maxHeight === 338 && style?.overflowY === "auto";
    });
    expect(listBox, "成员列表应限高 10 行并滚动").toBeDefined();

    const options = () =>
      findAll(
        findNode(tree, (node) => {
          const style = node.props?.style as
            { maxHeight?: unknown; overflowY?: unknown } | undefined;
          return style?.maxHeight === 338 && style?.overflowY === "auto";
        }),
        (node) =>
          node.type === "button" &&
          typeof node.props?.["aria-pressed"] === "boolean",
      );
    // 人类候选 + 一条 AI 候选在同一个控件里。
    expect(options()).toHaveLength(names.length + 1);
    expect(
      findNode(tree, (node) => node.props?.children === "小助手（AI）"),
      "agent 参会方应显示为「名字（AI）」",
    ).toBeDefined();

    // 多选：勾选两个后都应保持选中。
    (options()[0]?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);
    (options()[1]?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);
    const selectedStates = options().map(
      (option) => option.props?.["aria-pressed"],
    );
    expect(selectedStates[0]).toBe(true);
    expect(selectedStates[1]).toBe(true);
    expect(selectedStates[2]).toBe(false);

    // 框内模糊搜索：输入片段后只剩匹配项。
    const searchInput = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "搜索邀请成员",
    );
    (searchInput?.props?.onChange as ((event: unknown) => void) | undefined)?.({
      target: { value: "Er" },
    });
    tree = await settle(1);
    expect(options()).toHaveLength(1);
  });

  it("refreshes the invite list after inviting so the member shows as already in the meeting", async () => {
    const runtime = createReactRuntime();
    let invited = false;
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const fetchImpl = async (input: string) => {
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            { id: "ws-1", title: "项目一", path: "/p1", isMember: true },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({
          user: { id: "admin", name: "Admin", role: "member" },
        });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({ teammates: [] });
      }
      if (input.startsWith("/api/collab/meeting/participants/invite")) {
        invited = true;
        return payload({ ok: true });
      }
      if (input.startsWith("/api/collab/meeting/people")) {
        return payload({
          people: [
            {
              id: "demo-admin",
              name: "Demo管理员",
              role: "owner",
              ...(invited ? { state: "active" } : {}),
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        return payload({
          meeting: {
            id: "m-1",
            workspaceId: "ws-1",
            title: "评审会",
            status: "active",
          },
          participants: [
            {
              id: "p-1",
              meetingId: "m-1",
              kind: "human",
              refId: "admin",
              displayName: "用户-admin",
              status: "active",
            },
          ],
          transcript: [],
          actorId: "admin",
          canInvite: true,
          canRemove: true,
        });
      }
      if (input.startsWith("/api/collab/meetings")) {
        return payload({
          meetings: [
            {
              id: "m-1",
              workspaceId: "ws-1",
              title: "评审会",
              status: "active",
              createdBy: "admin",
              updatedAt: "2026-03-02T00:00:00.000Z",
              messageCount: 1,
              unreadCount: 0,
              lastActivityAt: "2026-03-02T00:00:00.000Z",
              lastMessage: {
                content: "评审会历史消息",
                createdAt: "2026-03-02T00:00:00.000Z",
              },
            },
          ],
        });
      }
      return payload({});
    };

    const { exports: exported } = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    exported.apply?.({
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    });
    const props = {
      useShellRoute: (select: (state: unknown) => unknown) =>
        select({ route: "meetings" }),
    };
    const root = { type: Meetings, props };
    const settle = async (passes = 4) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };
    const openInvite = async (currentTree: unknown) => {
      const settings = findNode(
        currentTree,
        (node) => node.type === "button" && node.props?.children === "设置",
      );
      (settings?.props?.onClick as (() => void) | undefined)?.();
      currentTree = await settle();
      const button = findNode(
        currentTree,
        (node) => node.type === "button" && node.props?.children === "邀请成员",
      );
      (button?.props?.onClick as (() => void) | undefined)?.();
    };

    let tree = await settle();
    const meetingItem = findNode(
      tree,
      (node) => node.type === "button" && node.props?.key === "m-1",
    );
    expect(meetingItem, "会议列表应有可点选的会议项").toBeDefined();
    (meetingItem?.props?.onMouseDown as (() => void) | undefined)?.();
    (meetingItem?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle();
    const texts = findAll(
      tree,
      (node) => typeof node.props?.children === "string",
    )
      .map((node) => node.props?.children)
      .slice(0, 40);
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "设置",
      ),
      `会议详情应加载出设置页签（当前文本：${texts.join(" | ")}）`,
    ).toBeDefined();
    await openInvite(tree);
    tree = await settle();

    expect(
      findNode(tree, (node) => node.props?.["aria-label"] === "搜索邀请成员"),
      "邀请弹窗应打开",
    ).toBeDefined();
    // 邀请前：候选成员可勾选，未标记「已在会议中」。
    expect(
      findNode(tree, (node) => node.props?.children === "已在会议中"),
    ).toBeUndefined();
    const demoOption = findNode(
      tree,
      (node) => node.type === "button" && node.props?.key === "demo-admin",
    );
    expect(demoOption, "应能选中 Demo管理员").toBeDefined();
    (demoOption?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);

    // 提交邀请（表单 onSubmit）。
    const form = findNode(
      tree,
      (node) =>
        node.type === "form" && typeof node.props?.onSubmit === "function",
    );
    await (
      form?.props?.onSubmit as ((event: unknown) => Promise<void>) | undefined
    )?.({ preventDefault: () => undefined });
    tree = await settle();

    // 再次打开邀请弹窗：刚邀请的成员应显示为「已在会议中」（禁用）。
    tree = await settle(1);
    await openInvite(tree);
    tree = await settle();
    expect(
      findNode(tree, (node) => node.props?.children === "已在会议中"),
      "重新打开后应加载到刚刚邀请的成员",
    ).toBeDefined();
  });

  it("shows default AI conversations, ranks universal search, and folds closed meetings", async () => {
    const runtime = createReactRuntime();
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const meetingDetails: Record<string, Record<string, unknown>> = {
      "m-exact": {
        id: "m-exact",
        workspaceId: "ws-atlas",
        title: "Atlas 周会",
        status: "active",
      },
      "m-project": {
        id: "m-project",
        workspaceId: "ws-atlas",
        title: "季度评审",
        status: "active",
      },
      "m-closed": {
        id: "m-closed",
        workspaceId: "ws-atlas",
        title: "历史复盘",
        status: "closed",
      },
      "m-chat-codex": {
        id: "m-chat-codex",
        workspaceId: "system.default",
        title: "Codex 助手",
        kind: "ai",
        teammateInstanceId: "tm-codex",
        status: "active",
      },
      "m-chat-design": {
        id: "m-chat-design",
        workspaceId: "system.default",
        title: "设计伙伴",
        kind: "ai",
        teammateInstanceId: "tm-design",
        status: "active",
      },
      "m-chat-new": {
        id: "m-chat-new",
        workspaceId: "system.default",
        title: "新建伙伴",
        kind: "ai",
        teammateInstanceId: "tm-new",
        status: "active",
      },
    };
    const requests: Array<{ input: string; init?: unknown }> = [];
    let codexAgentAvailable = false;
    const fetchImpl = async (input: string, init?: unknown) => {
      requests.push({ input, init });
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            {
              id: "ws-atlas",
              title: "Atlas 项目",
              path: "/atlas",
              isMember: true,
            },
            {
              id: "ws-ops",
              title: "运营项目",
              path: "/ops",
              isMember: true,
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({
          user: { id: "admin", name: "Admin", role: "member" },
        });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({
          teammates: [
            {
              id: "tm-codex",
              name: "Codex 助手",
              ownerName: "林远",
              ownerUserId: "owner-lin",
              state: "active",
              source: "platform",
              availability: {
                available: codexAgentAvailable,
                ...(codexAgentAvailable
                  ? {}
                  : { reason: "Agent Profile 已停用" }),
              },
              updatedAt: "2026-03-06T00:00:00.000Z",
            },
            {
              id: "tm-design",
              name: "设计伙伴",
              ownerName: "王敏",
              ownerUserId: "owner-wang",
              state: "active",
              source: "private",
              updatedAt: "2026-03-04T00:00:00.000Z",
            },
            {
              id: "tm-new",
              name: "新建伙伴",
              ownerName: "Admin",
              ownerUserId: "admin",
              state: "active",
              source: "private",
              updatedAt: "2026-03-05T00:00:00.000Z",
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        const meetingId = new URL(`http://x${input}`).searchParams.get(
          "meetingId",
        );
        const meeting = meetingDetails[meetingId ?? ""];
        return payload({
          meeting,
          participants:
            meetingId === "m-exact" || meetingId === "m-chat-codex"
              ? [
                  {
                    id: "p-admin",
                    meetingId,
                    kind: "human",
                    refId: "admin",
                    displayName: "Admin",
                    status: "active",
                  },
                  ...(meetingId === "m-exact"
                    ? [
                        {
                          id: "p-codex",
                          meetingId,
                          kind: "ai_teammate",
                          refId: "tm-codex",
                          teammateInstanceId: "tm-codex",
                          displayName: "Codex 助手",
                          status: "active",
                        },
                      ]
                    : []),
                ]
              : [],
          transcript: [],
          actorId: "admin",
        });
      }
      if (input.startsWith("/api/collab/meeting/minutes")) {
        return payload({ versions: [], current: null });
      }
      if (input.startsWith("/api/collab/meeting/delegates")) {
        return payload({ delegates: [] });
      }
      if (
        input === "/api/collab/meeting/message" &&
        (init as { method?: string } | undefined)?.method === "POST"
      ) {
        codexAgentAvailable = true;
        return payload({ ok: true });
      }
      if (input.startsWith("/api/collab/meeting/tasks")) {
        return payload({ tasks: [] });
      }
      if (input.startsWith("/api/collab/meetings?")) {
        const workspaceId = new URL(`http://x${input}`).searchParams.get(
          "workspaceId",
        );
        return payload({
          meetings:
            workspaceId === "ws-atlas"
              ? [
                  {
                    id: "m-exact",
                    workspaceId,
                    title: "Atlas 周会",
                    status: "active",
                    createdBy: "admin",
                    updatedAt: "2026-03-08T00:00:00.000Z",
                    messageCount: 4,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-08T00:00:00.000Z",
                    lastMessage: {
                      senderKind: "human",
                      senderName: "Admin",
                      content: "## 发布结果\n**窗口已经确认**",
                      createdAt: "2026-03-08T00:00:00.000Z",
                    },
                  },
                  {
                    id: "m-project",
                    workspaceId,
                    title: "季度评审",
                    status: "active",
                    createdBy: "admin",
                    updatedAt: "2026-03-02T00:00:00.000Z",
                    messageCount: 2,
                    unreadCount: 1,
                    lastActivityAt: "2026-03-02T00:00:00.000Z",
                    lastMessage: {
                      senderKind: "human",
                      senderName: "柯真 01 测试",
                      content: "请补充季度目标",
                      createdAt: "2026-03-02T00:00:00.000Z",
                    },
                  },
                  {
                    id: "m-closed",
                    workspaceId,
                    title: "历史复盘",
                    status: "closed",
                    createdBy: "admin",
                    updatedAt: "2026-03-01T00:00:00.000Z",
                    messageCount: 1,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-01T00:00:00.000Z",
                    lastMessage: {
                      senderKind: "human",
                      senderName: "Admin",
                      content: "复盘完成",
                      createdAt: "2026-03-01T00:00:00.000Z",
                    },
                  },
                  {
                    id: "m-empty",
                    workspaceId,
                    title: "没有消息的会议",
                    status: "active",
                    createdBy: "admin",
                    updatedAt: "2026-03-09T00:00:00.000Z",
                    messageCount: 0,
                    unreadCount: 0,
                    lastActivityAt: "2026-03-09T00:00:00.000Z",
                    lastMessage: null,
                  },
                ]
              : workspaceId === "system.default"
                ? [
                    {
                      id: "m-chat-codex",
                      workspaceId,
                      title: "Codex 助手",
                      kind: "ai",
                      teammateInstanceId: "tm-codex",
                      status: "active",
                      createdBy: "admin",
                      updatedAt: "2026-03-07T00:00:00.000Z",
                      messageCount: 2,
                      unreadCount: 2,
                      lastActivityAt: "2026-03-07T00:00:00.000Z",
                      lastMessage: {
                        senderKind: "agent",
                        senderName: "Codex 助手",
                        content: "今天的风险已整理",
                        createdAt: "2026-03-07T00:00:00.000Z",
                      },
                    },
                    {
                      id: "m-chat-design",
                      workspaceId,
                      title: "设计伙伴",
                      kind: "ai",
                      teammateInstanceId: "tm-design",
                      status: "active",
                      createdBy: "admin",
                      updatedAt: "2026-03-06T00:00:00.000Z",
                      messageCount: 1,
                      unreadCount: 1,
                      lastActivityAt: "2026-03-06T00:00:00.000Z",
                      lastMessage: {
                        senderKind: "agent",
                        senderName: "设计伙伴",
                        content: "设计稿已更新",
                        createdAt: "2026-03-06T00:00:00.000Z",
                      },
                    },
                  ]
                : [],
        });
      }
      if (
        input === "/api/collab/meetings" &&
        (init as { method?: string } | undefined)?.method === "POST"
      ) {
        return payload({
          meeting: {
            id: "m-chat-new",
            workspaceId: "system.default",
            title: "新建伙伴",
            kind: "ai",
            teammateInstanceId: "tm-new",
            status: "active",
            messageCount: 0,
          },
        });
      }
      return payload({});
    };

    const { exports: exported } = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    exported.apply?.({
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    });
    const root = {
      type: Meetings,
      props: {
        useShellRoute: (select: (state: unknown) => unknown) =>
          select({ route: "meetings" }),
      },
    };
    const settle = async (passes = 7) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };

    let tree = await settle();
    expect(
      findAll(
        tree,
        (node) => node.type === "button" && node.props?.children === "AI 对话",
      ),
      "顶部不应再出现 AI 对话按钮",
    ).toHaveLength(0);
    expect(containsText(tree, "筛选 / 搜索"), "应移除列表头部文案").toBe(
      false,
    );
    expect(containsText(tree, "2 场"), "应移除列表数量文案").toBe(false);
    const sidebarToggle = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "会议侧边栏",
    );
    expect(sidebarToggle?.props?.["aria-pressed"]).toBe(false);
    (sidebarToggle?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);
    const activeSidebarToggle = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "会议侧边栏",
    );
    expect(activeSidebarToggle?.props?.["aria-pressed"]).toBe(true);
    expect(
      (
        activeSidebarToggle?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.borderColor,
    ).toContain("accent-primary");
    (activeSidebarToggle?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
      ),
      "每个 AI伙伴都应有默认对话入口",
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 设计伙伴 的默认对话",
      ),
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "打开会议 Atlas 周会" &&
          typeof (
            node.props?.style as Record<string, unknown> | undefined
          )?.borderColor === "string",
      ),
      "列表加载后应自动选中最新有消息的会议",
    ).toBeDefined();
    const selectableMeeting = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开会议 Atlas 周会",
    );
    expect(selectableMeeting, "应存在可选择的会议卡片").toBeDefined();
    (selectableMeeting?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(2);
    const workspaceGrid = findNode(
      tree,
      (node) => {
        const style = node.props?.style as
          | Record<string, unknown>
          | undefined;
        return (
          style?.display === "grid" &&
          String(style.gridTemplateColumns ?? "").includes(
            "minmax(270px,320px)",
          )
        );
      },
    );
    expect(
      (
        workspaceGrid?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.gridTemplateColumns,
      "主页面使用左侧会话与中间详情双栏布局",
    ).toBe("minmax(270px,320px) minmax(0,1fr)");
    expect(
      containsText(
        findNode(
          tree,
          (node) =>
            node.props?.role === "group" &&
            node.props?.["aria-label"] === "当前沟通头部",
        ),
        "M-EXACT",
      ),
      "会议头部不应展示内部会议 ID",
    ).toBe(false);
    const meetingThreadCard = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开会议 Atlas 周会",
    );
    expect(
      (
        meetingThreadCard?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.borderRadius,
    ).toBe(7);
    expect(
      containsText(meetingThreadCard, "进行中"),
      "进行中的会议卡片不再显示状态胶囊",
    ).toBe(false);
    expect(
      findNode(meetingThreadCard, (node) => node.type === "time"),
      "更新时间应移动到标题行右侧",
    ).toBeDefined();
    expect(
      containsText(meetingThreadCard, "Admin："),
      "消息预览应包含发言人",
    ).toBe(true);
    const aiThreadCard = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
    );
    const selectedStyle = meetingThreadCard?.props?.style as
      | Record<string, unknown>
      | undefined;
    const unselectedStyle = aiThreadCard?.props?.style as
      | Record<string, unknown>
      | undefined;
    expect(selectedStyle?.outline).toBe("none");
    expect(unselectedStyle?.outline).toBe("none");
    expect(selectedStyle?.border).toBe(unselectedStyle?.border);
    expect(unselectedStyle?.border).toBe("1px solid #44454a");
    expect(unselectedStyle?.boxShadow).toBe("none");
    expect(typeof selectedStyle?.borderColor).toBe("string");
    expect(unselectedStyle?.borderColor).toBe("#44454a");
    expect(
      findNode(
        aiThreadCard,
        (node) => node.props?.["aria-label"] === "2 条未读消息",
      ),
      "AI 对话应显示未读消息数量",
    ).toBeDefined();
    expect(
      containsText(aiThreadCard, "Codex 助手："),
      "AI 对话预览应包含 AI 发言人",
    ).toBe(true);
    expect(
      containsText(aiThreadCard, "今天的风险已整理"),
      "AI 对话预览应保留最新消息内容",
    ).toBe(true);
    const unavailableListTag = findNode(
      aiThreadCard,
      (node) => node.props?.children === "不可用",
    );
    expect(unavailableListTag, "不可用 AI伙伴应在左侧列表显示标签").toBeDefined();
    expect(unavailableListTag?.props?.title).toBe("Agent Profile 已停用");
    const availableDesignCard = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开与 设计伙伴 的默认对话",
    );
    expect(
      containsText(availableDesignCard, "不可用"),
      "可用 AI伙伴不应显示不可用标签",
    ).toBe(false);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.role === "complementary" &&
          node.props?.["aria-label"] === "会议右侧栏",
      ),
      "主页面不应渲染内嵌会议右侧栏",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) => node.props?.["aria-label"] === "会议侧边栏",
      ),
      "主页面应保留全局会议侧栏入口",
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "对话",
      ),
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "纪要",
      ),
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === "设置",
      ),
    ).toBeDefined();
    (aiThreadCard?.props?.onClick as (() => void) | undefined)?.();
    const transitionTree = renderTree(root, runtime);
    expect(
      findNode(
        transitionTree,
        (node) =>
          node.props?.role === "complementary" &&
          node.props?.["aria-label"] === "会议右侧栏",
      ),
      "切换会话时不应显示内嵌右侧栏",
    ).toBeUndefined();
    tree = await settle(4);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.role === "complementary" &&
          node.props?.["aria-label"] === "AI 伙伴右侧栏",
      ),
      "AI 伙伴对话不应渲染右侧栏",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) => node.props?.["aria-label"] === "会议侧边栏",
      ),
      "AI 伙伴对话仍应保留全局会议侧栏入口",
    ).toBeDefined();
    const aiConversationHeader = findNode(
      tree,
      (node) =>
        node.props?.role === "group" &&
        node.props?.["aria-label"] === "当前沟通头部",
    );
    expect(aiConversationHeader, "AI 对话应渲染独立头部").toBeDefined();
    expect(
      findAllInOrder(
        aiConversationHeader,
        (node) =>
          node.props?.["aria-label"] === "Codex 助手 头像" ||
          node.props?.children === "Codex 助手" ||
          node.props?.children === "AI伙伴" ||
          node.props?.children === "不可用",
      ).map((node) => node.props?.["aria-label"] ?? node.props?.children),
      "AI 头像、名称、AI伙伴标签和不可用标签应按此顺序显示",
    ).toEqual(["Codex 助手 头像", "Codex 助手", "AI伙伴", "不可用"]);
    const aiPartnerTag = findNode(
      aiConversationHeader,
      (node) => node.props?.children === "AI伙伴",
    );
    expect(
      (
        aiPartnerTag?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.background,
      "AI伙伴标签应复用右侧栏标签样式",
    ).toBe("linear-gradient(135deg,#6f53d6,#2f6feb)");
    const unavailableHeaderTag = findNode(
      aiConversationHeader,
      (node) => node.props?.children === "不可用",
    );
    expect(unavailableHeaderTag, "不可用 AI伙伴应在对话标题显示标签").toBeDefined();
    expect(unavailableHeaderTag?.props?.title).toBe("Agent Profile 已停用");
    expect(
      findNode(
        aiConversationHeader,
        (node) =>
          node.type === "time" &&
          String(node.props?.["aria-label"] ?? "").startsWith(
            "最近更新时间",
          ),
      ),
      "AI 对话头部右侧应显示最近更新时间",
    ).toBeDefined();
    expect(
      containsText(aiConversationHeader, "（林远）"),
      "AI 对话头部不应显示 owner 括号字段",
    ).toBe(false);
    expect(
      containsText(aiConversationHeader, "AI 对话"),
      "AI 对话头部不应再显示 AI 对话标签",
    ).toBe(false);
    expect(
      containsText(aiConversationHeader, "林远 的 AI"),
      "AI 对话头部下方不应显示 owner 的 AI 文案",
    ).toBe(false);
    const composer = findNode(
      tree,
      (node) =>
        node.type === "textarea" &&
        node.props?.placeholder === "输入消息，@ 成员…",
    );
    (
      composer?.props?.onChange as
        | ((event: { target: { value: string } }) => void)
        | undefined
    )?.({ target: { value: "对话恢复测试" } });
    tree = await settle(2);
    const composerForm = findNode(
      tree,
      (node) =>
        node.type === "form" &&
        typeof node.props?.onSubmit === "function" &&
        findNode(
          node,
          (child) =>
            child.type === "textarea" &&
            child.props?.placeholder === "输入消息，@ 成员…",
        ) !== undefined,
    );
    expect(composerForm, "应找到中间对话发送表单").toBeDefined();
    await (
      composerForm?.props?.onSubmit as
        | ((event: unknown) => Promise<void>)
        | undefined
    )?.({ preventDefault: () => undefined });
    tree = await settle(6);
    expect(
      requests.some(
        (entry) =>
          entry.input === "/api/collab/meeting/message" &&
          (entry.init as { method?: string } | undefined)?.method === "POST",
      ),
      "发送消息应触发 AI伙伴执行身份修复并重新拉取可用性",
    ).toBe(true);
    expect(
      containsText(
        findNode(
          tree,
          (node) =>
            node.props?.role === "group" &&
            node.props?.["aria-label"] === "当前沟通头部",
        ),
        "不可用",
      ),
      "对话恢复后标题上的不可用标签应自动消失",
    ).toBe(false);
    expect(
      containsText(
        findNode(
          tree,
          (node) =>
            node.type === "button" &&
            node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
        ),
        "不可用",
      ),
      "对话恢复后左侧列表的不可用标签应自动消失",
    ).toBe(false);
    const typeFilter = findNode(
      tree,
      (node) =>
        node.props?.role === "group" &&
        node.props?.["aria-label"] === "沟通类型筛选",
    );
    expect(typeFilter, "应渲染沟通类型筛选标签").toBeDefined();
    for (const label of ["全部", "AI伙伴", "会议"]) {
      expect(
        findNode(
          typeFilter,
          (node) => node.type === "button" && node.props?.children === label,
        ),
        `应包含 ${label} 筛选标签`,
      ).toBeDefined();
    }
    const clickTypeTag = async (label: string) => {
      const button = findNode(
        tree,
        (node) => node.type === "button" && node.props?.children === label,
      );
      (button?.props?.onClick as (() => void) | undefined)?.();
      tree = await settle(1);
    };
    await clickTypeTag("会议");
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
      ),
      "会议筛选下不应显示 AI伙伴",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "打开会议 Atlas 周会",
      ),
    ).toBeDefined();
    await clickTypeTag("AI伙伴");
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "打开会议 Atlas 周会",
      ),
      "AI伙伴筛选下不应显示会议",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
      ),
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 新建伙伴 的默认对话",
      ),
      "AI伙伴筛选应提供尚无历史消息的新会话入口",
    ).toBeDefined();
    await clickTypeTag("全部");
    const sortedConversationLabels = findAllInOrder(
      tree,
      (node) =>
        node.type === "button" &&
        String(node.props?.["aria-label"] ?? "").startsWith("打开"),
    )
      .map((node) => node.props?.["aria-label"])
      .slice(0, 4);
    expect(
      sortedConversationLabels,
      "全部列表应按更新时间倒序排列",
    ).toEqual([
      "打开会议 Atlas 周会",
      "打开与 Codex 助手 的默认对话",
      "打开与 设计伙伴 的默认对话",
      "打开会议 季度评审",
    ]);
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          String(node.props?.["aria-label"] ?? "").includes("没有消息的会议"),
      ),
      "没有历史消息的会议不应进入沟通列表",
    ).toBeUndefined();
    expect(
      containsText(tree, "发布结果 窗口已经确认"),
      "列表应展示最近一条消息作为预览",
    ).toBe(true);

    const searchInput = () =>
      findNode(tree, (node) => node.props?.["aria-label"] === "通用搜索");
    const searchFor = async (value: string) => {
      (
        searchInput()?.props?.onChange as
          | ((event: { target: { value: string } }) => void)
          | undefined
      )?.({ target: { value } });
      tree = await settle(2);
    };

    await searchFor("林远");
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
      ),
      "应支持按 Owner 名称搜索 AI伙伴",
    ).toBeDefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "打开与 设计伙伴 的默认对话",
      ),
      "未命中的 AI伙伴应隐藏",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.type === "button" &&
          node.props?.["aria-label"] === "打开会议 Atlas 周会",
      ),
      "未命中的会议应从结果列表隐藏",
    ).toBeUndefined();

    await searchFor("运营项目");
    expect(
      findNode(tree, (node) => node.props?.children === "运营项目"),
      "项目筛选器仍应展示可搜索的项目名",
    ).toBeDefined();
    expect(
      findAll(
        tree,
        (node) =>
          node.type === "button" &&
          String(node.props?.["aria-label"] ?? "").startsWith("打开会议"),
      ),
      "没有会议命中项目关键词时不应展示会议结果",
    ).toHaveLength(0);

    await searchFor("Atlas");
    const rankedMeetingLabels = findAllInOrder(
      tree,
      (node) =>
        node.type === "button" &&
        String(node.props?.["aria-label"] ?? "").startsWith("打开会议"),
    ).map((node) => node.props?.["aria-label"]);
    expect(rankedMeetingLabels).toEqual([
      "打开会议 Atlas 周会",
      "打开会议 季度评审",
    ]);

    await searchFor("");
    expect(
      findNode(tree, (node) => node.props?.children === "历史复盘"),
      "已关闭会议默认应折叠",
    ).toBeUndefined();
    const closedToggle = findNode(
      tree,
      (node) => node.props?.["aria-label"] === "展开已关闭会议",
    );
    expect(closedToggle?.props?.["aria-expanded"]).toBe(false);
    (closedToggle?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(1);
    expect(
      findNode(tree, (node) => node.props?.children === "历史复盘"),
      "点击后应能展开已关闭会议",
    ).toBeDefined();

    await clickTypeTag("AI伙伴");
    const newPartner = findNode(
      tree,
      (node) =>
        node.props?.["aria-label"] === "打开与 新建伙伴 的默认对话",
    );
    (newPartner?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(4);
    expect(
      requests.some(
        (entry) =>
          entry.input === "/api/collab/meetings" &&
          (entry.init as { method?: string } | undefined)?.method === "POST",
      ),
      "尚无历史消息的 AI伙伴应可通过列表新开默认对话",
    ).toBe(true);
  });

  it("opens an existing one-to-one conversation from an AI partner row", async () => {
    const runtime = createReactRuntime();
    const requests: Array<{ input: string; init?: unknown }> = [];
    const payload = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
    });
    const existingMeeting = {
      id: "m-ai",
      workspaceId: "system.default",
      title: "Codex 助手",
      kind: "ai",
      teammateInstanceId: "tm-codex",
      status: "active",
      createdBy: "admin",
      updatedAt: "2026-03-03T00:00:00.000Z",
      messageCount: 2,
      unreadCount: 1,
      lastActivityAt: "2026-03-03T00:05:00.000Z",
      lastMessage: {
        content: "上一轮对话已完成",
        createdAt: "2026-03-03T00:05:00.000Z",
      },
    };
    const fetchImpl = async (input: string, init?: unknown) => {
      requests.push({ input, init });
      if (input.startsWith("/api/collab/team/workspaces")) {
        return payload({
          workspaces: [
            {
              id: "ws-1",
              title: "项目一",
              path: "/p1",
              isMember: true,
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/auth/me")) {
        return payload({
          user: { id: "admin", name: "Admin", role: "member" },
        });
      }
      if (input.startsWith("/api/collab/teammates")) {
        return payload({
          teammates: [
            {
              id: "tm-codex",
              name: "Codex 助手",
              ownerName: "Admin",
              ownerUserId: "admin",
              state: "active",
              source: "private",
            },
          ],
        });
      }
      if (input.startsWith("/api/collab/meetings?")) {
        return payload({ meetings: [existingMeeting] });
      }
      if (input.startsWith("/api/collab/meeting?")) {
        return payload({
          meeting: existingMeeting,
          participants: [
            {
              id: "p-human",
              meetingId: "m-ai",
              kind: "human",
              refId: "admin",
              displayName: "Admin",
              status: "active",
            },
          ],
          transcript: [
            {
              id: "msg-1",
              meetingId: "m-ai",
              sequence: 1,
              senderKind: "human",
              senderId: "admin",
              senderName: "Admin",
              content: "上一轮对话已完成",
              mentions: [],
              deliveries: [],
              createdAt: "2026-03-03T00:05:00.000Z",
            },
          ],
          actorId: "admin",
        });
      }
      if (input.startsWith("/api/collab/meeting/minutes")) {
        return payload({ versions: [], current: null });
      }
      if (input.startsWith("/api/collab/meeting/delegates")) {
        return payload({ delegates: [] });
      }
      if (input.startsWith("/api/collab/meeting/tasks")) {
        return payload({ tasks: [] });
      }
      return payload({});
    };

    const { exports: exported } = loadClientExports({
      react: runtime.react,
      fetchImpl,
    });
    let Meetings: ((props: Record<string, unknown>) => unknown) | undefined;
    exported.apply?.({
      slots: {
        inject: (_name: string, run: () => void) => run(),
        register: (spec: SlotSpec, component?: unknown) => {
          if (spec.id === "pluginmax-meetings") {
            Meetings = component as (props: Record<string, unknown>) => unknown;
          }
          return () => undefined;
        },
      },
    });
    const root = {
      type: Meetings,
      props: {
        useShellRoute: (select: (state: unknown) => unknown) =>
          select({ route: "meetings" }),
      },
    };
    const settle = async (passes = 6) => {
      let next: unknown;
      for (let pass = 0; pass < passes; pass += 1) {
        next = renderTree(root, runtime);
        runtime.runEffects();
        await tick();
      }
      return next;
    };

    let tree = await settle();
    const aiRow = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
    );
    expect(aiRow).toBeDefined();
    (aiRow?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(10);

    expect(
      requests.some((entry) =>
        entry.input.startsWith("/api/collab/meeting?meetingId=m-ai"),
      ),
      "点击后应直接打开已有的一对一对话",
    ).toBe(true);
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.role === "complementary" &&
          node.props?.["aria-label"] === "AI 伙伴右侧栏",
      ),
      "AI 伙伴对话不应渲染右侧栏",
    ).toBeUndefined();
    expect(
      findNode(
        tree,
        (node) =>
          node.props?.["aria-label"] === "右侧栏 AI 对话输入",
      ),
      "AI 伙伴对话不应出现右侧栏输入框",
    ).toBeUndefined();
    const aiConversationGrid = findNode(
      tree,
      (node) => {
        const style = node.props?.style as
          | Record<string, unknown>
          | undefined;
        return (
          style?.display === "grid" &&
          String(style.gridTemplateColumns ?? "").includes(
            "minmax(270px,320px)",
          )
        );
      },
    );
    expect(
      (
        aiConversationGrid?.props?.style as
          | Record<string, unknown>
          | undefined
      )?.gridTemplateColumns,
      "AI 伙伴对话应只保留列表与对话双栏",
    ).toBe("minmax(270px,320px) minmax(0,1fr)");
    expect(
      findAll(
        tree,
        (node) => node.type === "button" && node.props?.children === "AI 对话",
      ),
    ).toHaveLength(0);

    const reusedRow = findNode(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "打开与 Codex 助手 的默认对话",
    );
    (reusedRow?.props?.onClick as (() => void) | undefined)?.();
    tree = await settle(3);
    expect(
      requests.filter(
        (entry) =>
          entry.input === "/api/collab/meetings" &&
          (entry.init as { method?: string } | undefined)?.method === "POST",
      ),
      "已有记录时再次选择同一 AI伙伴不应重复创建会话",
    ).toHaveLength(0);
  });

  it("supports pointer and keyboard activation for structured AI mentions", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("onClick: () => pickMention(participant)");
    expect(source).toContain("pickPanelMention(participant)");
    expect(source).not.toContain("onMouseDown: (event) =>");
  });
});
