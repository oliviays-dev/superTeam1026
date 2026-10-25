import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(import.meta.dirname, "../client/index.js");

interface ClientExports {
  __test?: {
    navigateTo(link: {
      route: string;
      refId: string;
      workspaceId?: string;
    }): void;
    itemReadSignature(item: {
      id: string;
      kind?: string;
      updatedAt?: string;
    }): string;
    filterUnreadItems<T>(
      items: readonly T[],
      view: "unread" | "all",
      isRead: (item: T) => boolean,
    ): readonly T[];
  };
}

interface ScopeStore {
  getSnapshot(): boolean;
  setAll(next: boolean): void;
  subscribe(listener: () => void): () => void;
}

interface Harness {
  windowStub: {
    __ModuleLoader__: {
      load(definition: {
        factory(require: (id: string) => unknown): unknown;
      }): void;
    };
    __pluginmaxShell: {
      setRoute(route: string): void;
    };
    __pluginmaxPendingTask?: {
      taskId: string;
      workspaceId: string;
    };
    __pluginmaxPendingMeeting?: {
      meetingId: string;
      workspaceId: string;
    };
    __pluginmaxScope?: ScopeStore;
    dispatchEvent(event: unknown): void;
  };
  events: unknown[];
  routes: string[];
  exports: ClientExports;
}

function createHarness(): Harness {
  const events: unknown[] = [];
  const routes: string[] = [];
  let clientExports: ClientExports = {};
  const fakeReact = {
    createElement: () => null,
    Fragment: Symbol("Fragment"),
  };
  const windowStub = {
    __ModuleLoader__: {
      load(definition: { factory(require: (id: string) => unknown): unknown }) {
        clientExports = definition.factory((id) => {
          if (id === "react") return fakeReact;
          throw new Error(`unexpected module: ${id}`);
        }) as ClientExports;
      },
    },
    __pluginmaxShell: {
      setRoute(route: string) {
        routes.push(route);
      },
    },
    dispatchEvent(event: unknown) {
      events.push(event);
    },
  };
  return {
    windowStub,
    events,
    routes,
    get exports() {
      return clientExports;
    },
  };
}

function loadClient(harness: Harness) {
  const source = readFileSync(CLIENT_PATH, "utf8");
  const factory = new Function("window", "module", "exports", source) as (
    window: Harness["windowStub"],
    module: { exports: ClientExports },
    exports: ClientExports,
  ) => void;
  const module = { exports: {} as ClientExports };
  factory(harness.windowStub, module, module.exports);
}

describe("workbench client navigation", () => {
  it("reuses the cross-module scope store instead of creating a second one", () => {
    const harness = createHarness();
    loadClient(harness);

    const scope = harness.windowStub.__pluginmaxScope;
    expect(scope, "工作台应创建共享范围 store").toBeDefined();
    expect(scope?.getSnapshot()).toBe(false);
    scope?.setAll(true);

    // 模拟另一个模块 bundle 加载：它必须复用同一个 store，才能沿用选择。
    loadClient(harness);
    expect(harness.windowStub.__pluginmaxScope).toBe(scope);
    expect(harness.windowStub.__pluginmaxScope?.getSnapshot()).toBe(true);
  });

  it("opens task deep links through the detail route without route-select reset", () => {
    const harness = createHarness();
    loadClient(harness);

    harness.exports.__test?.navigateTo({
      route: "task",
      refId: "TSK-1",
      workspaceId: "WS-1",
    });

    expect(harness.windowStub.__pluginmaxPendingTask).toEqual({
      taskId: "TSK-1",
      workspaceId: "WS-1",
    });
    expect(harness.routes).toEqual(["task"]);
    expect(
      harness.events.map((event) => (event as { type: string }).type),
    ).not.toContain("pluginmax:navigate");
  });

  it("opens meeting deep links through the meetings route with a pending meeting", () => {
    const harness = createHarness();
    loadClient(harness);

    harness.exports.__test?.navigateTo({
      route: "meeting",
      refId: "MTG-1",
      workspaceId: "WS-1",
    });

    expect(harness.windowStub.__pluginmaxPendingMeeting).toEqual({
      meetingId: "MTG-1",
      workspaceId: "WS-1",
    });
    expect(harness.routes).toEqual(["meetings"]);
    expect(
      harness.events.map((event) => (event as { type: string }).type),
    ).toContain("pluginmax:collab-navigate");
  });

  it("reloads shared follow state when another module changes a follow", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain('"pluginmax:follow-change"');
    expect(source).toContain("followStore.loaded = false");
    expect(source).toContain('refreshModule("focus", { silent: true })');
  });

  it("shows only unread cards by default and treats updated items as unread", () => {
    const harness = createHarness();
    loadClient(harness);
    const first = { id: "TSK-1", kind: "task", updatedAt: "v1" };
    const second = { id: "TSK-2", kind: "task", updatedAt: "v1" };
    const read = new Set([harness.exports.__test?.itemReadSignature(first)]);

    const unread = harness.exports.__test?.filterUnreadItems(
      [first, second],
      "unread",
      (item) => read.has(harness.exports.__test?.itemReadSignature(item)),
    );
    const all = harness.exports.__test?.filterUnreadItems(
      [first, second],
      "all",
      () => true,
    );

    expect(unread).toEqual([second]);
    expect(all).toEqual([first, second]);
    expect(
      harness.exports.__test?.itemReadSignature({
        ...first,
        updatedAt: "v2",
      }),
    ).not.toBe(harness.exports.__test?.itemReadSignature(first));
  });

  it("keeps text read actions and persists before navigating away", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).not.toContain("ICONS.check");
    expect(source).toContain('"标为已读"');
    expect(source).toContain("readStateRef.current = next");
    expect(source).toContain(
      "window.localStorage.setItem(READ_STATE_KEY, JSON.stringify(next))",
    );
    expect(source).toContain("ctx.markItemRead(moduleId, item)");
    expect(source).toContain('ctx.markItemRead("meeting-minutes", item)');
  });
});
