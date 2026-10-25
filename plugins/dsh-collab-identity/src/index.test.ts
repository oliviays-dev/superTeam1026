import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import {
  apply,
  createIdentityRoutes,
  hashPassword,
  inject,
  PrincipalService,
  teamDomainSpec,
  TeamService,
  verifyPassword,
  type AuditRecord,
  type DomainLike,
  type IdentityContext,
  type MemberRecord,
  type PrincipalDomainLike,
  type SessionRecord,
  type UserRecord,
  type WorkspaceRegistryLike,
  type WebRouteLike,
} from "./index.ts";
import type {
  PrincipalGrant,
  PrincipalLinkRecord,
  PrincipalRecord,
} from "./principal.ts";

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

  values(): IterableIterator<V> {
    return this.records.values();
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

interface Tables {
  users: FakeTable<UserRecord>;
  members: FakeTable<MemberRecord>;
  sessions: FakeTable<SessionRecord>;
  audit: FakeTable<AuditRecord>;
}

function tables(): Tables {
  return {
    users: new FakeTable<UserRecord>(),
    members: new FakeTable<MemberRecord>(),
    sessions: new FakeTable<SessionRecord>(),
    audit: new FakeTable<AuditRecord>(),
  };
}

function service(
  currentTables: Tables = tables(),
  now: () => Date = () => new Date("2026-01-01T00:00:00.000Z"),
) {
  return {
    tables: currentTables,
    service: new TeamService(currentTables, {
      now,
      sessionTtlMs: 1000,
      randomToken: (() => {
        let sequence = 0;
        return () => `token-${String(++sequence).padStart(32, "0")}`;
      })(),
    }),
  };
}

function fakeDomain(currentTables: Tables): DomainLike {
  return {
    table: (name: string) => {
      const key =
        name === "workspace_members"
          ? "members"
          : name === "auth_sessions"
            ? "sessions"
            : name === "audit_log"
              ? "audit"
              : name;
      return currentTables[key as keyof Tables];
    },
    close: async () => undefined,
  } as unknown as DomainLike;
}

const workspaceRegistry: WorkspaceRegistryLike = {
  get: (id) =>
    id === "workspace-1"
      ? { id, path: "/tmp/workspace-1", title: "Workspace 1" }
      : undefined,
  list: () => [
    { id: "workspace-1", path: "/tmp/workspace-1", title: "Workspace 1" },
  ],
};

async function setupPlugin() {
  const currentTables = tables();
  const principalTables = {
    principals: new FakeTable<PrincipalRecord>(),
    links: new FakeTable<PrincipalLinkRecord>(),
    grants: new FakeTable<PrincipalGrant>(),
  };
  const disposers: Array<() => void> = [];
  const provided: unknown[] = [];
  const commands: unknown[] = [];
  const tools: unknown[] = [];
  const routes: WebRouteLike[] = [];
  const ctx: IdentityContext = {
    effect: (register) => disposers.push(register()),
    provide: (_key, value) => provided.push(value),
    commands: { register: (definition) => commands.push(definition) },
    tools: { register: (definition) => tools.push(definition) },
    webServer: { register: (route) => routes.push(route) },
    workspaceRegistry,
    storageDomain: {
      open: async (spec) => {
        if (spec.name === "collab_team") return fakeDomain(currentTables);
        if (spec.name === "collab_principal") {
          return {
            table: (name: "principals" | "principal_links" | "role_grants") =>
              name === "principal_links"
                ? principalTables.links
                : name === "role_grants"
                  ? principalTables.grants
                  : principalTables.principals,
            close: async () => undefined,
          } as unknown as PrincipalDomainLike;
        }
        throw new Error(`unexpected storage domain: ${spec.name}`);
      },
    },
  };
  await apply(ctx);
  return {
    currentTables,
    principalTables,
    disposers,
    provided,
    commands,
    tools,
    routes,
  };
}

class FakeResponse {
  status = 0;
  body = "";
  headers: Record<string, string | number> = {};

  writeHead(
    status: number,
    headers: Record<string, string | number>,
  ): ServerResponse {
    this.status = status;
    this.headers = headers;
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
  options: {
    body?: unknown;
    origin?: string;
    authorization?: string;
    host?: string;
    fetchSite?: string;
  } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    host: options.host ?? "127.0.0.1:33117",
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.authorization === undefined
      ? {}
      : { authorization: options.authorization }),
    ...(options.fetchSite === undefined
      ? {}
      : { "sec-fetch-site": options.fetchSite }),
    ...(body === "" ? {} : { "content-type": "application/json" }),
  };
  const request = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body);
    },
  };
  return request;
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

function route(routes: readonly WebRouteLike[], path: string): WebRouteLike {
  const found = routes.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`missing route: ${path}`);
  return found;
}

describe("dsh-collab-identity", () => {
  it("declares the domain, service dependencies, and host extensions", () => {
    expect(teamDomainSpec).toMatchObject({
      name: "collab_team",
      version: 1,
    });
    expect(Object.keys(teamDomainSpec.tables)).toEqual([
      "users",
      "workspace_members",
      "auth_sessions",
      "audit_log",
    ]);
    expect(inject).toEqual([
      "storageDomain",
      "workspaceRegistry",
      "commands",
      "tools",
      "webServer",
    ]);
  });

  it("hashes passwords with salted scrypt and rejects bad hashes", () => {
    const first = hashPassword("correct horse battery");
    const second = hashPassword("correct horse battery");
    expect(first).not.toBe(second);
    expect(verifyPassword("correct horse battery", first)).toBe(true);
    expect(verifyPassword("wrong", first)).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
  });

  it("bootstraps one admin, issues hashed sessions, and audits bootstrap", async () => {
    const { tables: current, service: team } = service();
    const result = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });

    expect(result.role).toBe("admin");
    expect(result.token).not.toContain("$");
    expect([...current.sessions.entries()][0]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(current.users.get("admin")?.passwordHash).not.toBe("password-123");
    expect([...current.audit.entries()].map(([, event]) => event)).toEqual([
      expect.objectContaining({ action: "bootstrap", actorId: "admin" }),
    ]);
    await expect(
      team.bootstrap({
        userId: "other",
        name: "Other",
        password: "password-456",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(current.users.size).toBe(1);
  });

  it("rejects duplicate bootstrap even when calls race", async () => {
    const { tables: current, service: team } = service();
    const results = await Promise.allSettled([
      team.bootstrap({ userId: "a", name: "A", password: "password-1" }),
      team.bootstrap({ userId: "b", name: "B", password: "password-2" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(current.users.size).toBe(1);
    expect(current.audit.size).toBe(1);
  });

  it("rejects invalid input before writing records", async () => {
    const { tables: current, service: team } = service();
    await expect(async () =>
      team.bootstrap({
        userId: "../escape",
        name: "Bad",
        password: "short",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(current.users.size).toBe(0);
    expect(current.audit.size).toBe(0);
    expect(() => team.members("bad/id")).toThrow("request input is invalid");
  });

  it("expires, logs out, and rotates sessions on password change", async () => {
    let milliseconds = 0;
    const { tables: current, service: team } = service(
      tables(),
      () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + milliseconds),
    );
    await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    const second = await team.login({
      userId: "admin",
      password: "password-123",
    });

    milliseconds = 1001;
    expect(team.resolveToken(second.token)).toBeUndefined();

    milliseconds = 0;
    const keptSession = await team.login({
      userId: "admin",
      password: "password-123",
    });
    await team.changePassword({
      userId: "admin",
      currentPassword: "password-123",
      newPassword: "password-456",
      keepToken: keptSession.token,
    });
    expect(team.resolveToken(keptSession.token)?.userId).toBe("admin");
    expect(current.sessions.size).toBe(1);
    await team.logout(keptSession.token);
    expect(team.resolveToken(keptSession.token)).toBeUndefined();
    expect(current.sessions.size).toBe(0);
  });

  it("manages users and workspace members with admin checks", async () => {
    const { tables: current, service: team } = service();
    const admin = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    const member = await team.registerUser(admin.userId, {
      userId: "member",
      name: "Member",
      password: "password-456",
      role: "member",
    });
    const memberLogin = await team.login({
      userId: "member",
      password: "password-456",
    });
    expect(member.role).toBe("member");
    await expect(
      team.registerUser(memberLogin.userId, {
        userId: "guest",
        name: "Guest",
        password: "password-789",
        role: "guest",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await team.addMember(admin.userId, {
      workspaceId: "main",
      userId: "member",
      role: "owner",
    });
    expect(team.members("main")).toMatchObject([
      { userId: "member", memberRole: "owner" },
    ]);
    await team.removeMember(admin.userId, {
      workspaceId: "main",
      userId: "member",
    });
    expect(team.members("main")).toEqual([]);
    expect(
      team.audit({ workspaceId: "main" }).map((event) => event.action),
    ).toEqual(["member_remove", "member_add"]);
    await expect(
      team.updateUser(admin.userId, "admin", { role: "member" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(current.users.get("admin")?.role).toBe("admin");
  });

  it("allows workspace owners to manage members only through an explicit project capability", async () => {
    const { service: team } = service();
    const admin = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await team.registerUser(admin.userId, {
      userId: "owner",
      name: "Workspace Owner",
      password: "password-456",
      role: "member",
    });
    await team.registerUser(admin.userId, {
      userId: "target",
      name: "Target",
      password: "password-789",
      role: "member",
    });
    const owner = await team.login({
      userId: "owner",
      password: "password-456",
    });
    await team.addMember(admin.userId, {
      workspaceId: "main",
      userId: owner.userId,
      role: "owner",
    });
    await expect(
      team.addMember(owner.userId, {
        workspaceId: "main",
        userId: "target",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await team.addMember(
      owner.userId,
      {
        workspaceId: "main",
        userId: "target",
        role: "guest",
      },
      { allowWorkspaceOwner: true },
    );
    expect(team.members("main")).toContainEqual(
      expect.objectContaining({
        userId: "target",
        memberRole: "guest",
      }),
    );
    await team.removeMember(
      owner.userId,
      { workspaceId: "main", userId: "target" },
      { allowWorkspaceOwner: true },
    );
    expect(team.members("main")).not.toContainEqual(
      expect.objectContaining({ userId: "target" }),
    );
  });

  it("registers a flat service, command, tool, and HTTP routes", async () => {
    const plugin = await setupPlugin();
    expect(plugin.provided).toHaveLength(2);
    expect(plugin.provided[0]).toBeInstanceOf(TeamService);
    expect(plugin.provided[1]).toBeInstanceOf(PrincipalService);
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.tools).toHaveLength(1);
    expect(inject).toContain("workspaceRegistry");
    expect(plugin.routes.map((item) => item.path)).toContain(
      "/api/collab/auth/login",
    );
    expect(plugin.routes.map((item) => item.path)).toContain(
      "/api/collab/team/workspaces",
    );
    expect(plugin.routes.map((item) => item.path)).toContain(
      "/api/collab/principals",
    );
    expect(new Set(plugin.routes.map((item) => item.path)).size).toBe(
      plugin.routes.length,
    );

    const tool = plugin.tools[0] as {
      output: { schema: unknown; render(): unknown };
      execute(
        args: Record<string, never>,
        exec: { signal: AbortSignal },
      ): Promise<string>;
    };
    expect(tool.output.schema).toEqual({ type: "string" });
    await expect(
      tool.execute({}, { signal: new AbortController().signal }),
    ).resolves.toContain("identity not initialized");

    plugin.disposers.forEach((dispose) => dispose());
  });

  it("protects browser routes with origin, bearer, and admin checks", async () => {
    const currentTables = tables();
    const team = new TeamService(currentTables, {
      sessionTtlMs: 1000,
      randomToken: (() => {
        let sequence = 0;
        return () => `${String(++sequence).padStart(20, "0")}-fixed-token`;
      })(),
    });
    const routes = createIdentityRoutes(team, workspaceRegistry);
    const bootstrap = route(routes, "/api/collab/auth/bootstrap");
    const me = route(routes, "/api/collab/auth/me");
    const users = route(routes, "/api/collab/team/users");
    const userUpdate = route(routes, "/api/collab/team/users/update");
    const workspaces = route(routes, "/api/collab/team/workspaces");

    const crossOrigin = await call(
      bootstrap,
      fakeRequest("POST", "/api/collab/auth/bootstrap", {
        body: { userId: "admin", name: "Admin", password: "password-123" },
        origin: "https://evil.example",
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(currentTables.users.size).toBe(0);

    const badToken = await call(
      me,
      fakeRequest("GET", "/api/collab/auth/me", {
        authorization: "Bearer wrong",
      }),
    );
    expect(badToken.status).toBe(401);

    const created = await call(
      bootstrap,
      fakeRequest("POST", "/api/collab/auth/bootstrap", {
        body: { userId: "admin", name: "Admin", password: "password-123" },
      }),
    );
    expect(created.status).toBe(201);
    const token = (created.json() as { token: string }).token;

    const workspaceResult = await call(
      workspaces,
      fakeRequest("GET", "/api/collab/team/workspaces", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(workspaceResult.status).toBe(200);
    expect(workspaceResult.json()).toMatchObject({
      ok: true,
      workspaces: [{ id: "workspace-1", title: "Workspace 1" }],
    });

    const member = await team.registerUser("admin", {
      userId: "member",
      name: "Member",
      password: "password-456",
      role: "member",
    });
    const memberSession = await team.login({
      userId: member.id,
      password: "password-456",
    });
    const memberResponse = await call(
      users,
      fakeRequest("GET", "/api/collab/team/users", {
        authorization: `Bearer ${memberSession.token}`,
      }),
    );
    expect(memberResponse.status).toBe(403);

    const adminResponse = await call(
      users,
      fakeRequest("GET", "/api/collab/team/users", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(adminResponse.status).toBe(200);
    expect((adminResponse.json() as { users: unknown[] }).users).toHaveLength(
      2,
    );

    const lastAdmin = await call(
      userUpdate,
      fakeRequest("POST", "/api/collab/team/users/update", {
        authorization: `Bearer ${token}`,
        body: { userId: "admin", name: "Admin", role: "member" },
      }),
    );
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "the last admin role cannot be changed",
      },
    });
  });

  it("projects account users into Principal and exposes the mapping", async () => {
    const plugin = await setupPlugin();
    const bootstrap = route(plugin.routes, "/api/collab/auth/bootstrap");
    const created = await call(
      bootstrap,
      fakeRequest("POST", "/api/collab/auth/bootstrap", {
        body: { userId: "admin", name: "Admin", password: "password-123" },
      }),
    );
    const token = (created.json() as { token: string }).token;
    const list = await call(
      route(plugin.routes, "/api/collab/principals"),
      fakeRequest("GET", "/api/collab/principals", {
        authorization: `Bearer ${token}`,
      }),
    );
    expect(list.status).toBe(200);
    expect(list.json()).toMatchObject({
      principals: [
        expect.objectContaining({
          id: "principal-human-admin",
          kind: "human",
          displayName: "Admin",
        }),
      ],
    });
    const resolved = await call(
      route(plugin.routes, "/api/collab/principals/resolve"),
      fakeRequest(
        "GET",
        "/api/collab/principals/resolve?subjectType=auth-user&subjectId=admin",
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(resolved.json()).toMatchObject({
      principal: {
        id: "principal-human-admin",
        kind: "human",
      },
    });

    const createUser = route(
      plugin.routes,
      "/api/collab/team/users/create",
    );
    const member = await call(
      createUser,
      fakeRequest("POST", "/api/collab/team/users/create", {
        authorization: `Bearer ${token}`,
        body: {
          userId: "member",
          name: "Member",
          password: "password-123",
          role: "member",
        },
      }),
    );
    expect(member.status).toBe(201);
    const updateUser = route(
      plugin.routes,
      "/api/collab/team/users/update",
    );
    const disabled = await call(
      updateUser,
      fakeRequest("POST", "/api/collab/team/users/update", {
        authorization: `Bearer ${token}`,
        body: { userId: "member", status: "disabled" },
      }),
    );
    expect(disabled.status).toBe(200);
    expect(
      plugin.principalTables.principals.get("principal-human-member"),
    ).toMatchObject({
      status: "suspended",
    });
    expect(
      [...plugin.principalTables.grants.entries()].map(([, grant]) => grant),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: "principal-human-admin",
          scopeType: "platform",
          scopeId: "platform",
          role: "admin",
          status: "active",
        }),
        expect.objectContaining({
          principalId: "principal-human-member",
          scopeType: "platform",
          scopeId: "platform",
          role: "member",
          status: "active",
        }),
      ]),
    );
  });

  it("does not expose passwords or raw token hashes in audit records", async () => {
    const { tables: current, service: team } = service();
    await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "secret-password",
    });
    await expect(
      team.login({ userId: "admin", password: "wrong" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const serialized = JSON.stringify(
      [...current.audit.entries()].map(([, event]) => event),
    );
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("token-");
  });
});

describe("账号编辑、停用与启用", () => {
  it("更新显示名称与全局角色", async () => {
    const { service: team } = service();
    const admin = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await team.registerUser(admin.userId, {
      userId: "member",
      name: "Member",
      password: "password-456",
      role: "member",
    });
    const updated = await team.updateUser(admin.userId, "member", {
      name: "改名",
      role: "owner",
    });
    expect(updated).toMatchObject({
      id: "member",
      name: "改名",
      role: "owner",
      status: "active",
    });
  });

  it("停用后禁止登录并吊销既有会话，启用后恢复", async () => {
    const { service: team } = service();
    const admin = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await team.registerUser(admin.userId, {
      userId: "member",
      name: "Member",
      password: "password-456",
      role: "member",
    });
    const login = await team.login({
      userId: "member",
      password: "password-456",
    });
    expect(team.resolveToken(login.token)?.userId).toBe("member");

    const disabled = await team.updateUser(admin.userId, "member", {
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
    expect(team.resolveToken(login.token)).toBeUndefined();
    await expect(
      team.login({ userId: "member", password: "password-456" }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "account is disabled",
    });

    await team.updateUser(admin.userId, "member", { status: "active" });
    await expect(
      team.login({ userId: "member", password: "password-456" }),
    ).resolves.toMatchObject({ userId: "member" });
  });

  it("禁止停用当前登录的管理员自身", async () => {
    const { service: team } = service();
    await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await team.registerUser("admin", {
      userId: "admin-2",
      name: "Admin 2",
      password: "password-456",
      role: "admin",
    });
    await expect(
      team.updateUser("admin", "admin", { status: "disabled" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "you cannot disable your own account",
    });
  });

  it("最后一个管理员不能被降级或停用", async () => {
    const { service: team } = service();
    await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await expect(
      team.updateUser("admin", "admin", { role: "member" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      team.updateUser("admin", "admin", { status: "disabled" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "the last admin role cannot be changed",
    });
  });

  it("存在其他管理员时可以停用另一名管理员", async () => {
    const { service: team } = service();
    const first = await team.bootstrap({
      userId: "admin",
      name: "Admin",
      password: "password-123",
    });
    await team.registerUser(first.userId, {
      userId: "admin2",
      name: "Admin 2",
      password: "password-456",
      role: "admin",
    });
    const disabled = await team.updateUser(first.userId, "admin2", {
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
  });
});
