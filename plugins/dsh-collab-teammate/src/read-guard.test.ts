import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { Teammate } from "./models.js";
import { createTeammateRoutes } from "./index.js";
import {
  TeammateService,
  type KvTableLike,
  type TeammateActor,
} from "./service.js";

function memoryTable<V>(): KvTableLike<V> {
  const values = new Map<string, V>();
  return {
    get: (key) => values.get(key),
    entries: () => values.entries(),
    get size() {
      return values.size;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
  };
}

class FakeResponse {
  status = 0;
  body = "";

  writeHead(status: number): ServerResponse {
    this.status = status;
    return this as unknown as ServerResponse;
  }

  end(body?: string): ServerResponse {
    if (body !== undefined) this.body = body;
    return this as unknown as ServerResponse;
  }

  json<T>(): T {
    return JSON.parse(this.body) as T;
  }
}

function fakeRequest(method: string, url: string, token: string): IncomingMessage {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33124",
      authorization: `Bearer ${token}`,
    },
  } as unknown as IncomingMessage;
}

const at = "2026-10-01T00:00:00.000Z";

function teammateFixture(overrides: Partial<Teammate> & { id: string }): Teammate {
  return {
    source: "personal",
    name: overrides.id,
    role: "",
    ownerUserId: "peter",
    ownerName: "Peter",
    description: "",
    soul: "",
    scenarios: [],
    goals: [],
    avatar: "",
    state: "active",
    version: "v1.0",
    createdBy: "peter",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

interface FakeTask {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  receiverType: string;
  receiverId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const principals: Record<string, TeammateActor> = {
  "token-olivia": { userId: "olivia", name: "Olivia", role: "member" },
  "token-peter": { userId: "peter", name: "Peter", role: "member" },
  "token-sam": { userId: "sam", name: "Sam", role: "member" },
  "token-admin": { userId: "admin", name: "Admin", role: "admin" },
};

function setup() {
  const teammates = memoryTable<Teammate>();
  const personal = teammateFixture({ id: "tm-1", name: "Peter 的个人实例" });
  const platform = teammateFixture({
    id: "tm-platform",
    source: "platform",
    ownerUserId: "platform",
    ownerName: "平台",
    name: "平台共享实例",
  });
  const meetingOnly = teammateFixture({
    id: "tm-meeting",
    name: "仅会议协作实例",
  });
  for (const item of [personal, platform, meetingOnly]) {
    void teammates.put(item.id, item);
  }
  const service = new TeammateService({
    tables: { teammates, events: memoryTable() },
  });
  const tasks: FakeTask[] = [
    {
      id: "TSK-1",
      workspaceId: "ws-1",
      title: "任务",
      status: "todo",
      receiverType: "agent",
      receiverId: "tm-1",
      createdBy: "olivia",
      createdAt: at,
      updatedAt: at,
    },
  ];
  const taskService = {
    list: (workspaceId: string) =>
      tasks.filter((task) => task.workspaceId === workspaceId),
    create: async () => {
      throw new Error("not used");
    },
    assign: async () => {
      throw new Error("not used");
    },
  };
  const registry = {
    list: () => [
      { id: "ws-1", title: "项目一" },
      { id: "ws-2", title: "项目二" },
    ],
  };
  const meetings = {
    list: (workspaceId: string) =>
      workspaceId === "ws-1" ? [{ id: "m-1", status: "active" }] : [],
    participants: (meetingId: string) =>
      meetingId === "m-1"
        ? [
            {
              id: "p-1",
              meetingId,
              kind: "agent",
              refId: "tm-meeting",
              status: "active",
              updatedAt: at,
            },
            {
              id: "p-2",
              meetingId,
              kind: "human",
              refId: "olivia",
              status: "active",
              updatedAt: at,
            },
          ]
        : [],
  };
  const team = {
    resolveToken: (token: string) => principals[token],
    users: () =>
      Object.values(principals).map((principal) => ({
        id: principal.userId,
        name: principal.name,
      })),
    members: (workspaceId: string) =>
      workspaceId === "ws-1"
        ? [{ userId: "olivia" }, { userId: "peter" }]
        : [{ userId: "peter" }, { userId: "admin" }],
  };
  const routes = createTeammateRoutes(
    service,
    () => team,
    () => taskService,
    () => registry,
    undefined,
    undefined,
    undefined,
    () => meetings,
  );
  return { routes };
}

async function call(
  routes: ReturnType<typeof setup>["routes"],
  path: string,
  query: string,
  token: string,
  method = "GET",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`missing route: ${path}`);
  const response = new FakeResponse();
  await route.handler(
    fakeRequest(method, `${path}${query}`, token),
    response as unknown as ServerResponse,
  );
  return { status: response.status, json: response.json<Record<string, unknown>>() };
}

describe("AI Teammate 明细接口读取收口", () => {
  it("非所有者、非协作方读取他人个人实例明细会被拒绝", async () => {
    const { routes } = setup();
    const result = await call(
      routes,
      "/api/collab/teammates/detail",
      "?teammateId=tm-1",
      "token-sam",
    );
    expect(result.status).toBe(403);
    expect(result.json.error).toMatchObject({ code: "forbidden" });
  });

  it("所有者、任务协作方、会议协作方、管理员与平台实例均可读取", async () => {
    const { routes } = setup();
    const detail = (id: string, token: string) =>
      call(
        routes,
        "/api/collab/teammates/detail",
        `?teammateId=${id}`,
        token,
      );
    // 所有者
    expect((await detail("tm-1", "token-peter")).status).toBe(200);
    // 任务协作方：olivia 创建了指派给 tm-1 的任务
    expect((await detail("tm-1", "token-olivia")).status).toBe(200);
    // 会议协作方：olivia 与 tm-meeting 同场参会（无任务）
    expect((await detail("tm-meeting", "token-olivia")).status).toBe(200);
    // 平台共享实例对所有登录用户可见
    expect((await detail("tm-platform", "token-sam")).status).toBe(200);
    // 平台管理员
    expect((await detail("tm-1", "token-admin")).status).toBe(200);
  });

  it("会议协作判定不适用于未同场参会的成员", async () => {
    const { routes } = setup();
    const result = await call(
      routes,
      "/api/collab/teammates/detail",
      "?teammateId=tm-meeting",
      "token-sam",
    );
    expect(result.status).toBe(403);
  });

  it("identity / runtime / work-queue / work-reports / audit-events 同样收口", async () => {
    const { routes } = setup();
    const paths = [
      ["/api/collab/teammates/identity", "?teammateId=tm-1"],
      ["/api/collab/teammates/runtime", "?teammateId=tm-1"],
      ["/api/collab/teammates/work-queue", "?teammateId=tm-1"],
      ["/api/collab/teammates/work-reports", "?teammateId=tm-1"],
      ["/api/collab/teammates/audit-events", "?teammateId=tm-1"],
    ] as const;
    for (const [path, search] of paths) {
      const denied = await call(routes, path, search, "token-sam");
      expect({ path, status: denied.status }).toEqual({ path, status: 403 });
    }
    // 所有者可读：identity 无运行时返回 null，work-queue 返回空队列。
    const identity = await call(
      routes,
      "/api/collab/teammates/identity",
      "?teammateId=tm-1",
      "token-peter",
    );
    expect(identity.status).toBe(200);
    expect(identity.json).toMatchObject({ ok: true, identity: null });
    const queue = await call(
      routes,
      "/api/collab/teammates/work-queue",
      "?teammateId=tm-1",
      "token-peter",
    );
    expect(queue.status).toBe(200);
  });
});
