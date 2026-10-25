import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  assignmentDomainSpec,
  AssignmentService,
  createRolesRoutes,
  ensureFacilitatorSeats,
  inject,
  PersonaService,
  type WebRouteLike,
  WorkspaceTypeService,
  type Assignment,
  type AssignmentDomainLike,
  type RolesContext,
  type WorkspaceRoleConfig,
  type WorkspaceType,
} from "./index.ts";

describe("role tool boundary", () => {
  it("only exposes read-only seat inspection to agents", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const tool = source.slice(source.indexOf("ctx.tools.register({"));
    expect(tool).toContain('operation: z.enum(["list"])');
    expect(tool).not.toContain('enum: ["list", "claim"]');
    expect(tool).not.toContain('agentActor("collab-roles-tool")');
  });
});

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

function fakeDomain(
  workspaces: FakeTable<WorkspaceRoleConfig>,
  assignments: FakeTable<Assignment>,
): AssignmentDomainLike {
  return {
    table: ((name: string) =>
      name === "workspaces"
        ? workspaces
        : assignments) as unknown as AssignmentDomainLike["table"],
    close: async () => undefined,
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

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function fakeRequest(
  method: string,
  url: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33117",
      origin: "http://127.0.0.1:33117",
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(body === "" ? {} : { "content-type": "application/json" }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body);
    },
  };
}

async function call(
  route: WebRouteLike,
  request: unknown,
): Promise<FakeResponse> {
  const response = new FakeResponse();
  await route.handler(
    request as Parameters<typeof route.handler>[0],
    response as unknown as ServerResponse,
  );
  return response;
}

function findRoute(
  routes: readonly WebRouteLike[],
  path: string,
): WebRouteLike {
  const found = routes.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`missing route: ${path}`);
  return found;
}

describe("dsh-collab-roles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pluginmax-roles-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares host services and the assignment storage domain", () => {
    expect(inject).toEqual(["storageDomain", "commands", "tools", "webServer"]);
    expect(assignmentDomainSpec).toMatchObject({
      name: "collab_assignment",
      version: 1,
    });
    expect(Object.keys(assignmentDomainSpec.tables)).toEqual([
      "workspaces",
      "assignments",
    ]);
  });

  it("stores persona assets, edits SOUL, and generates a preset", async () => {
    const personas = new PersonaService(join(root, "personas"));
    const created = await personas.create({
      id: "architect",
      name: "架构师",
      description: "负责模块边界",
      tags: ["architecture"],
      soul: "保持克制和工程判断。",
    });
    expect(created.soul).toContain("工程判断");
    expect((await personas.list()).map((persona) => persona.id)).toEqual([
      "architect",
    ]);
    await personas.updateSoul("architect", "新的 SOUL。\n");
    const preset = await personas.preset("architect", "当前任务：R3");
    expect(preset).toContain("# 架构师 SOUL");
    expect(preset).toContain("Runtime context");
    expect(preset).toContain("新的 SOUL。");
    await expect(personas.get("../escape")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("stores workspace types and materializes their seats", async () => {
    const types = new WorkspaceTypeService(join(root, "workspace-types"));
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const service = new AssignmentService(
      { workspaces, assignments },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    const type: WorkspaceType = await types.create({
      id: "product",
      name: "产品协作",
      description: "",
      seats: [
        {
          id: "owner",
          label: "负责人",
          participantKind: "human",
          personaId: "architect",
          permissions: ["read", "write", "approve"],
        },
        {
          id: "builder",
          label: "执行者",
          participantKind: "agent",
          permissions: ["read", "write"],
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect((await types.list()).map((item) => item.id)).toEqual(["product"]);
    await expect(
      service.materialize(
        { kind: "user", id: "member", workspaceRole: "member" },
        "main",
        type,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const config = await service.materialize(
      { kind: "user", id: "admin", globalRole: "admin" },
      "main",
      type,
    );
    expect(config.seats).toHaveLength(3);
    expect(
      config.seats.find((seat) => seat.id === "facilitator"),
    ).toMatchObject({
      label: "会议 Facilitator",
      participantKind: "agent",
      personaId: "persona-meeting-facilitator",
      permissions: ["read", "write"],
    });
    expect(service.seats("main")).toEqual([]);
  });

  it("backfills the facilitator seat into already materialized workspaces", async () => {
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const service = new AssignmentService({ workspaces, assignments });
    const timestamp = "2026-01-01T00:00:00.000Z";
    await workspaces.put("main", {
      workspaceId: "main",
      typeId: "product",
      typeName: "产品协作",
      seats: [
        {
          id: "owner",
          label: "负责人",
          participantKind: "human",
          permissions: ["read"],
        },
      ],
      materializedAt: timestamp,
      materializedBy: "admin",
    });
    await ensureFacilitatorSeats(workspaces);
    expect(service.config("main").seats.map((seat) => seat.id)).toEqual([
      "owner",
      "facilitator",
    ]);
    // 幂等：再跑一次不重复。
    await ensureFacilitatorSeats(workspaces);
    expect(service.config("main").seats).toHaveLength(2);
  });

  it("keeps every claimant as a role member and elects the first leader", async () => {
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const service = new AssignmentService(
      { workspaces, assignments },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    const type: WorkspaceType = {
      id: "team",
      name: "团队",
      description: "",
      seats: [
        {
          id: "human",
          label: "真人",
          participantKind: "human",
          permissions: ["read", "write", "approve"] as const,
        },
        {
          id: "agent",
          label: "Agent",
          participantKind: "agent",
          personaId: "architect",
          permissions: ["read", "write"] as const,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await service.materialize(
      { kind: "user", id: "owner", workspaceRole: "owner" },
      "main",
      type,
    );
    const first = await service.claim(
      { kind: "user", id: "alice", workspaceRole: "member" },
      "main",
      "human",
    );
    expect(first.leader).toBe(true);
    const same = await service.claim(
      { kind: "user", id: "alice", workspaceRole: "member" },
      "main",
      "human",
    );
    expect(same.id).toBe(first.id);
    // 项目角色是多人集合：第二个成员加入不会把先到的人挤掉。
    const second = await service.claim(
      { kind: "user", id: "bob", workspaceRole: "member" },
      "main",
      "human",
    );
    expect(second).toMatchObject({
      assigneeKind: "user",
      assigneeId: "bob",
      leader: false,
    });
    expect(
      service
        .members("main", "human")
        .map((assignment) => assignment.assigneeId)
        .sort(),
    ).toEqual(["alice", "bob"]);
    const agent = await service.claim(
      {
        kind: "agent",
        id: "session-a",
        sessionId: "session-a",
        workspaceRole: "member",
      },
      "main",
      "agent",
    );
    expect(agent).toMatchObject({
      assigneeKind: "agent",
      assigneeId: "session-a",
      personaId: "architect",
      leader: false,
    });
    expect(service.seats("main")).toHaveLength(3);

    const released = await service.release(
      { kind: "user", id: "alice", workspaceRole: "member" },
      "main",
      "human",
    );
    expect(released.status).toBe("released");
    expect(
      service.members("main", "human").map((item) => item.assigneeId),
    ).toEqual(["bob"]);
  });

  it("migrates single-occupant seat records into members", async () => {
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const service = new AssignmentService(
      { workspaces, assignments },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    const type: WorkspaceType = {
      id: "team",
      name: "团队",
      description: "",
      seats: [
        {
          id: "reviewer",
          label: "评审",
          participantKind: "human",
          permissions: ["read", "approve"] as const,
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await service.materialize(
      { kind: "user", id: "owner", workspaceRole: "owner" },
      "main",
      type,
    );
    await assignments.put("main:reviewer", {
      id: "legacy",
      workspaceId: "main",
      seatId: "reviewer",
      seatLabel: "评审",
      participantKind: "human",
      assigneeKind: "user",
      assigneeId: "alice",
      permissions: ["read", "approve"],
      leader: true,
      status: "claimed",
      claimedAt: "2026-01-01T00:00:00.000Z",
      claimedBy: "alice",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await service.migrateLegacyAssignments()).toBe(1);
    expect(assignments.get("main:reviewer")).toBeUndefined();
    expect(service.members("main", "reviewer")).toMatchObject([
      { id: "legacy", assigneeId: "alice", leader: true },
    ]);
    expect(await service.migrateLegacyAssignments()).toBe(0);
  });

  it("projects active project roles to Principal grants", async () => {
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const grants: Array<Record<string, unknown>> = [];
    const revoked: Array<Record<string, unknown>> = [];
    const service = new AssignmentService(
      { workspaces, assignments },
      {
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        principals: () => ({
          resolveSubject: (subjectType, subjectId) => {
            if (subjectType === "auth-user" && subjectId === "alice") {
              return { id: "principal-human-alice", status: "active" };
            }
            if (subjectType === "auth-user" && subjectId === "owner") {
              return { id: "principal-human-owner", status: "active" };
            }
            return undefined;
          },
          syncGrant: async (input) => {
            grants.push(input);
          },
          revokeMatchingGrants: async (input) => {
            revoked.push(input);
          },
        }),
      },
    );
    await service.materialize(
      { kind: "user", id: "owner", workspaceRole: "owner" },
      "main",
      {
        id: "team",
        name: "团队",
        description: "",
        seats: [
          {
            id: "developer",
            label: "开发",
            participantKind: "human",
            permissions: ["read", "write"],
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const assigned = await service.assign(
      { kind: "user", id: "owner", workspaceRole: "owner" },
      {
        workspaceId: "main",
        seatId: "developer",
        assigneeKind: "user",
        assigneeId: "alice",
      },
    );
    expect(assigned.principalId).toBe("principal-human-alice");
    expect(grants.at(-1)).toMatchObject({
      principalId: "principal-human-alice",
      scopeType: "project",
      scopeId: "main",
      role: "developer",
      permissions: ["read", "write"],
      grantedByPrincipalId: "principal-human-owner",
    });

    await service.release(
      { kind: "user", id: "owner", workspaceRole: "owner" },
      "main",
      "developer",
      { assigneeKind: "user", assigneeId: "alice" },
    );
    expect(revoked.at(-1)).toMatchObject({
      principalId: "principal-human-alice",
      scopeType: "project",
      scopeId: "main",
      role: "developer",
    });
  });

  it("loads without identity and only provides browser routes in the identity fiber", async () => {
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const provided: string[] = [];
    const disposers: Array<() => void> = [];
    const commands: unknown[] = [];
    const tools: unknown[] = [];
    const ctx: RolesContext = {
      effect: (register) => disposers.push(register()),
      provide: (key) => provided.push(key),
      commands: { register: (definition) => commands.push(definition) },
      tools: { register: (definition) => tools.push(definition) },
      webServer: { register: () => () => undefined },
      storageDomain: {
        open: async () => fakeDomain(workspaces, assignments),
      },
      get: () => undefined,
      inject: (_keys, _callback) => ({ dispose: () => undefined }),
    };
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const dispose = await apply(ctx);
    process.env.DSH_HOME = previousHome;
    expect(provided).toEqual([
      "collabPersonas",
      "collabWorkspaceType",
      "collabAssignment",
    ]);
    expect(commands).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(typeof dispose).toBe("function");
  });

  it("allows global role assets but requires membership for workspace seats", async () => {
    const personas = new PersonaService(join(root, "personas"));
    const types = new WorkspaceTypeService(join(root, "workspace-types"));
    const workspaces = new FakeTable<WorkspaceRoleConfig>();
    const assignments = new FakeTable<Assignment>();
    const team = {
      resolveToken: (token: string) => {
        if (token === "outsider-token")
          return { userId: "outsider", role: "member" };
        if (token === "member-token")
          return { userId: "member", role: "member" };
        if (token === "admin-token") return { userId: "admin", role: "admin" };
        return undefined;
      },
      members: (workspaceId: string) =>
        workspaceId === "main"
          ? [{ userId: "member", memberRole: "member" }]
          : [],
    };
    const routes = createRolesRoutes(
      personas,
      types,
      new AssignmentService({ workspaces, assignments }),
      team,
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    await types.create({
      id: "team",
      name: "团队",
      description: "",
      seats: [
        {
          id: "owner",
          label: "负责人",
          participantKind: "human",
          permissions: ["read", "write", "approve"],
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const personaRoute = findRoute(routes, "/api/collab/roles/personas");
    const persona = await call(
      personaRoute,
      fakeRequest("POST", "/api/collab/roles/personas", {
        token: "outsider-token",
        body: {
          id: "architect",
          name: "架构师",
          description: "",
          soul: "保持工程判断。",
        },
      }),
    );
    expect(persona.status).toBe(201);

    const materialize = findRoute(routes, "/api/collab/roles/materialize");
    const materializeBody = { workspaceId: "main", typeId: "team" };
    const denied = await call(
      materialize,
      fakeRequest("POST", "/api/collab/roles/materialize", {
        token: "outsider-token",
        body: materializeBody,
      }),
    );
    expect(denied.status).toBe(403);
    const materialized = await call(
      materialize,
      fakeRequest("POST", "/api/collab/roles/materialize", {
        token: "admin-token",
        body: materializeBody,
      }),
    );
    expect(materialized.status).toBe(201);

    const claim = findRoute(routes, "/api/collab/roles/seats/claim");
    const claimed = await call(
      claim,
      fakeRequest("POST", "/api/collab/roles/seats/claim", {
        token: "member-token",
        body: { workspaceId: "main", seatId: "owner" },
      }),
    );
    expect(claimed.status).toBe(201);
    expect(claimed.json()).toMatchObject({ ok: true });
  });

  it("does not overwrite initialized project roles through workspace type materialization", async () => {
    const personas = new PersonaService(join(root, "personas"));
    const types = new WorkspaceTypeService(join(root, "workspace-types"));
    const assignments = new AssignmentService({
      workspaces: new FakeTable<WorkspaceRoleConfig>(),
      assignments: new FakeTable<Assignment>(),
    });
    const team = {
      resolveToken: () => ({ userId: "admin", role: "admin" }),
      members: () => [],
    };
    const routes = createRolesRoutes(
      personas,
      types,
      assignments,
      team,
      () => ({
        project: () => ({
          rolesInitialized: true,
          projectRoles: [{ code: "PROJECT_OWNER" }],
        }),
      }),
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    await types.create({
      id: "team",
      name: "团队",
      description: "",
      seats: [
        {
          id: "owner",
          label: "负责人",
          participantKind: "human",
          permissions: ["read", "write"],
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const response = await call(
      findRoute(routes, "/api/collab/roles/materialize"),
      fakeRequest("POST", "/api/collab/roles/materialize", {
        token: "admin-token",
        body: { workspaceId: "main", typeId: "team" },
      }),
    );
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining("只能用于初始化"),
      },
    });
  });
});
