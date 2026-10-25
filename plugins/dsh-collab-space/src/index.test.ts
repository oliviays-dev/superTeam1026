import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  configDomainSpec,
  createSpaceRoutes,
  DigestService,
  inject,
  LockService,
  lockDomainSpec,
  sharingDomainSpec,
  SharingService,
  scanSecrets,
  type GlobalRequestRecord,
  type LockRecord,
  type PolicyRecord,
  type SpaceActor,
  type SpaceAuditRecord,
  type SpaceContext,
  type TeamServiceLike,
  type WebRouteLike,
  type WorkspaceConfigRecord,
  type WorkspaceRegistryLike,
} from "./index.ts";

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

interface SpaceTables {
  policies: FakeTable<PolicyRecord>;
  audit: FakeTable<SpaceAuditRecord>;
  globalRequests: FakeTable<GlobalRequestRecord>;
  configs: FakeTable<WorkspaceConfigRecord>;
  locks: FakeTable<LockRecord>;
}

function tables(): SpaceTables {
  return {
    policies: new FakeTable<PolicyRecord>(),
    audit: new FakeTable<SpaceAuditRecord>(),
    globalRequests: new FakeTable<GlobalRequestRecord>(),
    configs: new FakeTable<WorkspaceConfigRecord>(),
    locks: new FakeTable<LockRecord>(),
  };
}

const admin: SpaceActor = {
  kind: "user",
  id: "admin",
  globalRole: "admin",
  workspaceRole: "owner",
};

const member: SpaceActor = {
  kind: "user",
  id: "member",
  globalRole: "member",
  workspaceRole: "member",
};

const guest: SpaceActor = {
  kind: "user",
  id: "guest",
  globalRole: "guest",
  workspaceRole: "guest",
};

function agent(sessionId: string): SpaceActor {
  return {
    kind: "agent",
    id: sessionId,
    sessionId,
    workspaceRole: "member",
  };
}

function registry(root: string): WorkspaceRegistryLike {
  return {
    get: (id) =>
      id === "main"
        ? { id, path: join(root, "main"), title: "gui-workspace" }
        : undefined,
    list: () => [{ id: "main", path: join(root, "main"), title: "gui-workspace" }],
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${String(++value).padStart(4, "0")}`;
}

describe("dsh-collab-space", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pluginmax-space-"));
    await mkdir(join(root, "main"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares the three storage domains and host services", () => {
    expect(inject).toEqual([
      "storageDomain",
      "commands",
      "tools",
      "webServer",
      "workspaceRegistry",
    ]);
    expect(sharingDomainSpec).toMatchObject({
      name: "collab_sharing",
      version: 1,
    });
    expect(configDomainSpec).toMatchObject({
      name: "collab_config",
      version: 1,
    });
    expect(lockDomainSpec).toMatchObject({ name: "collab_locks", version: 1 });
    expect(scanSecrets("token sk-abcdefghijklmnopqrstuvwx")).toEqual([
      { rule: "openai_api_key", line: 1 },
    ]);
  });

  it("resolves exact, scoped, and deny sharing policies", async () => {
    const current = tables();
    const sharing = new SharingService(
      {
        policies: current.policies,
        audit: current.audit,
        globalRequests: current.globalRequests,
        configs: current.configs,
      },
      registry(root),
      join(root, "global"),
      { randomId: sequence("policy-") },
    );

    await sharing.declarePolicy(admin, {
      workspaceId: "main",
      pattern: "workspace/docs/*.md",
      scope: "workspace",
      permissions: ["read", "write"],
    });
    await sharing.declarePolicy(admin, {
      workspaceId: "main",
      pattern: "workspace/docs/private.md",
      scope: "workspace",
      permissions: ["read"],
      effect: "deny",
    });
    await sharing.declarePolicy(admin, {
      workspaceId: "main",
      pattern: "session/session-a/docs/session.md",
      scope: "session",
      permissions: ["read"],
      sessionId: "session-a",
    });

    expect(
      sharing.resolve({
        workspaceId: "main",
        path: "workspace/docs/readme.md",
        permission: "read",
        actor: member,
      }),
    ).toMatchObject({ effect: "allow" });
    expect(
      sharing.resolve({
        workspaceId: "main",
        path: "workspace/docs/private.md",
        permission: "read",
        actor: member,
      }),
    ).toMatchObject({ effect: "deny", reason: "matched deny policy" });
    expect(
      sharing.resolve({
        workspaceId: "main",
        path: "workspace/docs/readme.md",
        permission: "read",
        actor: guest,
      }),
    ).toMatchObject({ effect: "deny", reason: "no matching sharing policy" });
    expect(
      sharing.resolve({
        workspaceId: "main",
        path: "session/session-a/docs/session.md",
        permission: "read",
        actor: member,
        sessionId: "session-a",
      }),
    ).toMatchObject({ effect: "allow" });
    expect(
      sharing.resolve({
        workspaceId: "main",
        path: "session/session-b/docs/session.md",
        permission: "read",
        actor: member,
        sessionId: "session-b",
      }),
    ).toMatchObject({ effect: "deny" });
  });

  it("uploads atomically, reads through policy, and rejects unsafe paths and secrets", async () => {
    const current = tables();
    const sharing = new SharingService(
      {
        policies: current.policies,
        audit: current.audit,
        globalRequests: current.globalRequests,
        configs: current.configs,
      },
      registry(root),
      join(root, "global"),
      { randomId: sequence("policy-") },
    );

    const uploaded = await sharing.upload(admin, {
      workspaceId: "main",
      path: "docs/readme.md",
      content: "shared content\n",
    });
    expect(uploaded).toMatchObject({
      file: { path: "workspace/docs/readme.md" },
    });
    await expect(
      readFile(
        join(root, "main", ".dsh-shared", "workspace", "docs", "readme.md"),
        "utf8",
      ),
    ).resolves.toBe("shared content\n");
    await expect(
      sharing.read(member, {
        workspaceId: "main",
        path: "workspace/docs/readme.md",
      }),
    ).resolves.toMatchObject({ content: "shared content\n" });
    await expect(
      sharing.read(guest, {
        workspaceId: "main",
        path: "workspace/docs/readme.md",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sharing.upload(admin, {
        workspaceId: "main",
        path: "../escape.md",
        content: "bad path",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      sharing.upload(admin, {
        workspaceId: "main",
        path: "docs/secret.md",
        content: "key = sk-abcdefghijklmnopqrstuvwx\n",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(current.audit.size).toBe(3);

    const unsafeDirectory = join(
      root,
      "main",
      ".dsh-shared",
      "workspace",
      "unsafe",
    );
    await mkdir(unsafeDirectory, { recursive: true });
    await writeFile(join(root, "outside.md"), "outside\n");
    await symlink(join(root, "outside.md"), join(unsafeDirectory, "link.md"));
    await expect(
      sharing.read(member, {
        workspaceId: "main",
        path: "workspace/unsafe/link.md",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("serializes advisory locks by owner and session", async () => {
    const current = tables();
    let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
    const locks = new LockService(current.locks, {
      now: () => new Date(milliseconds),
    });

    const first = await locks.acquire(member, {
      workspaceId: "main",
      path: "docs/readme.md",
      sessionId: "session-a",
    });
    expect(first.ownerSessionId).toBe("session-a");
    await expect(
      locks.acquire(
        { ...member, id: "other-member" },
        { workspaceId: "main", path: "docs/readme.md", sessionId: "session-b" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      locks.acquire(member, {
        workspaceId: "main",
        path: "docs/readme.md",
        sessionId: "session-a",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ownerSessionId: "session-a" });
    await expect(
      locks.release(
        { ...member, id: "other-member" },
        {
          workspaceId: "main",
          path: "docs/readme.md",
          sessionId: "session-b",
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      locks.release(member, {
        workspaceId: "main",
        path: "docs/readme.md",
        sessionId: "session-a",
      }),
    ).resolves.toBe(true);
    expect(locks.status("main")).toEqual([]);

    await locks.acquire(member, {
      workspaceId: "main",
      path: "docs/readme.md",
      sessionId: "session-a",
      ttlMs: 30_000,
    });
    milliseconds += 31_000;
    await expect(
      locks.acquire(
        { ...member, id: "other-member" },
        { workspaceId: "main", path: "docs/readme.md", sessionId: "session-b" },
      ),
    ).resolves.toMatchObject({ ownerSessionId: "session-b" });
  });

  it("writes claims, digests, and redacted session summaries", async () => {
    const current = tables();
    const sharing = new SharingService(
      {
        policies: current.policies,
        audit: current.audit,
        globalRequests: current.globalRequests,
        configs: current.configs,
      },
      registry(root),
      join(root, "global"),
      { randomId: sequence("id-") },
    );
    const digest = new DigestService(registry(root));

    const claim = await sharing.claim(member, {
      workspaceId: "main",
      path: "docs/readme.md",
      sessionId: "session-a",
    });
    expect(claim).toMatchObject({
      ownerId: "member",
      ownerSessionId: "session-a",
      path: "docs/readme.md",
    });
    await expect(
      readFile(join(root, "main", "docs", "readme.md.dsh-claim"), "utf8"),
    ).resolves.toContain('"ownerId": "member"');
    await expect(
      sharing.claimFor("main", "docs/readme.md"),
    ).resolves.toMatchObject({
      ownerSessionId: "session-a",
    });

    const rendered = digest.render("session-a", [
      {
        type: "user",
        text: "Finish the release",
        at: "2026-01-01T00:01:00.000Z",
      },
      {
        type: "assistant",
        title: "Key result",
        text: "token sk-abcdefghijklmnopqrstuvwx",
        at: "2026-01-01T00:02:00.000Z",
      },
      { type: "tool", title: "write", path: "docs/readme.md" },
    ]);
    expect(rendered).toContain("# Session digest: session-a");
    expect(rendered).toContain("[REDACTED:openai_api_key]");
    expect(rendered).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    const saved = await digest.digestFor("main", "session-a", [
      { type: "user", text: "Finish the release" },
    ]);
    expect(saved.path).toBe("logs/session-a.md");
    await expect(
      readFile(
        join(root, "main", ".dsh-shared", "logs", "session-a.md"),
        "utf8",
      ),
    ).resolves.toBe(saved.content);
  });

  it("routes global writes through pending approval and policy-gated tools", async () => {
    const current = tables();
    const globalRoot = join(root, "global");
    const sharing = new SharingService(
      {
        policies: current.policies,
        audit: current.audit,
        globalRequests: current.globalRequests,
        configs: current.configs,
      },
      registry(root),
      globalRoot,
      { randomId: sequence("id-") },
    );

    const request = await sharing.submitGlobal(admin, {
      path: "docs/global.md",
      content: "approved global content\n",
    });
    expect(request.status).toBe("pending");
    expect(sharing.globalRequests()[0]).toMatchObject({
      id: request.id,
      pendingPath: "[pending]",
    });
    await expect(
      sharing.submitGlobal(admin, {
        path: "docs/global.md",
        content: "duplicate global content\n",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "global request is already pending: docs/global.md",
    });
    await expect(
      sharing.decideGlobal(member, request.id, true),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      sharing.decideGlobal(admin, request.id, true),
    ).resolves.toMatchObject({
      status: "approved",
      decidedBy: "admin",
    });
    await expect(
      readFile(join(globalRoot, "docs", "global.md"), "utf8"),
    ).resolves.toBe("approved global content\n");
    await expect(
      sharing.decideGlobal(admin, request.id, true),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    await expect(
      sharing.globalRead(agent("session-a"), "docs/global.md"),
    ).resolves.toBe("approved global content\n");
    await expect(
      sharing.globalRead(agent("session-a"), "docs/missing.md"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sharing.globalWrite(
        agent("session-a"),
        { path: "docs/global.md", content: "no" },
        async () => "rejected",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readFile(join(globalRoot, "docs", "global.md"), "utf8"),
    ).resolves.toBe("approved global content\n");
    await expect(
      sharing.globalWrite(
        agent("session-a"),
        { path: "docs/global.md", content: "agent global content\n" },
        async () => "allowed-once",
      ),
    ).resolves.toMatchObject({ path: "docs/global.md", scope: "global" });
    await expect(
      readFile(join(globalRoot, "docs", "global.md"), "utf8"),
    ).resolves.toBe("agent global content\n");
    expect(
      [...current.audit.entries()]
        .map(([, event]) => event)
        .map((event) => `${event.action}:${event.actorId}`)
        .filter((value) => value.startsWith("global_")),
    ).toEqual([
      "global_submit:admin",
      "global_approve:admin",
      "global_write:session-a",
    ]);
  });
});

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
  options: { body?: unknown; origin?: string; authorization?: string } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const request = {
    method,
    url,
    headers: {
      host: "127.0.0.1:33117",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.authorization === undefined
        ? {}
        : { authorization: options.authorization }),
      ...(body === "" ? {} : { "content-type": "application/json" }),
    },
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

function findRoute(
  routes: readonly WebRouteLike[],
  path: string,
): WebRouteLike {
  const found = routes.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`missing route: ${path}`);
  return found;
}

describe("dsh-collab-space routes and plugin registration", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pluginmax-space-plugin-"));
    await mkdir(join(root, "main"), { recursive: true });
    previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it("protects browser routes and accepts same-origin authenticated requests", async () => {
    const current = tables();
    const sharing = new SharingService(
      {
        policies: current.policies,
        audit: current.audit,
        globalRequests: current.globalRequests,
        configs: current.configs,
      },
      registry(root),
      join(root, "global"),
    );
    const team: TeamServiceLike = {
      resolveToken: (token) =>
        token === "valid-token"
          ? { userId: "admin", role: "admin" }
          : undefined,
      members: () => [],
    };
    const routes = createSpaceRoutes(
      sharing,
      new LockService(current.locks),
      new DigestService(registry(root)),
      team,
      registry(root),
    );
    const workspaces = findRoute(routes, "/api/collab/space/workspaces");
    const missingWorkspaceToken = await call(
      workspaces,
      fakeRequest("GET", "/api/collab/space/workspaces", {
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(missingWorkspaceToken.status).toBe(401);
    const workspaceMetadata = await call(
      workspaces,
      fakeRequest("GET", "/api/collab/space/workspaces", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer valid-token",
      }),
    );
    expect(workspaceMetadata.status).toBe(200);
    expect(workspaceMetadata.json()).toEqual({
      ok: true,
      workspaces: [
        {
          id: "main",
          path: join(root, "main"),
          title: "gui-workspace",
        },
      ],
    });
    const files = findRoute(routes, "/api/collab/space/files");

    const crossOrigin = await call(
      files,
      fakeRequest("GET", "/api/collab/space/files?workspaceId=main", {
        origin: "https://evil.example",
        authorization: "Bearer valid-token",
      }),
    );
    expect(crossOrigin.status).toBe(403);
    const badToken = await call(
      files,
      fakeRequest("GET", "/api/collab/space/files?workspaceId=main", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer invalid",
      }),
    );
    expect(badToken.status).toBe(401);
    const badMethod = await call(
      files,
      fakeRequest("DELETE", "/api/collab/space/files?workspaceId=main", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer valid-token",
      }),
    );
    expect(badMethod.status).toBe(405);
    const valid = await call(
      files,
      fakeRequest("GET", "/api/collab/space/files?workspaceId=main", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer valid-token",
      }),
    );
    expect(valid.status).toBe(200);
    expect(valid.json()).toMatchObject({ ok: true, files: [] });

    const invalidUpload = await call(
      files,
      fakeRequest("POST", "/api/collab/space/files", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer valid-token",
        body: {
          workspaceId: "main",
          path: "../escape.md",
          scope: "workspace",
          content: "bad path",
        },
      }),
    );
    expect(invalidUpload.status).toBe(400);
    expect(invalidUpload.json()).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "path: path must use normalized forward-slash segments",
      },
    });

    const lockAcquire = findRoute(routes, "/api/collab/space/locks/acquire");
    const locked = await call(
      lockAcquire,
      fakeRequest("POST", "/api/collab/space/locks/acquire", {
        origin: "http://127.0.0.1:33117",
        authorization: "Bearer valid-token",
        body: {
          workspaceId: "main",
          path: "docs/kickoff.md",
        },
      }),
    );
    expect(locked.status).toBe(201);
    expect(locked.json()).toMatchObject({
      ok: true,
      lock: {
        ownerId: "admin",
        ownerSessionId: `browser:${createHash("sha256").update("valid-token").digest("hex")}`,
      },
    });
    expect(current.audit.size).toBe(0);
  });

  it("registers services, command, tools, guards, and browser routes", async () => {
    const current = tables();
    const disposers: Array<() => void> = [];
    const provided: Array<[string, unknown]> = [];
    const commands: unknown[] = [];
    const tools: unknown[] = [];
    const routes: WebRouteLike[] = [];
    const listeners: unknown[] = [];
    const team: TeamServiceLike = {
      resolveToken: () => undefined,
      members: () => [],
    };
    const fakeDomains = {
      collab_sharing: {
        table: (name: string) =>
          current[
            name === "policies"
              ? "policies"
              : name === "audit"
                ? "audit"
                : "globalRequests"
          ],
        close: async () => undefined,
      },
      collab_config: {
        table: () => current.configs,
        close: async () => undefined,
      },
      collab_locks: {
        table: () => current.locks,
        close: async () => undefined,
      },
    };
    const ctx: SpaceContext = {
      effect: (register) => disposers.push(register()),
      provide: (key, value) => provided.push([key, value]),
      commands: { register: (definition) => commands.push(definition) },
      tools: { register: (definition) => tools.push(definition) },
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => undefined;
        },
      },
      storageDomain: {
        open: async (spec) =>
          fakeDomains[spec.name as keyof typeof fakeDomains] as never,
      },
      workspaceRegistry: registry(root),
      inject: (_keys, callback) => {
        callback({ ...ctx, collabTeam: team });
        return { dispose: () => undefined };
      },
      on: (_event, listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };

    const dispose = await apply(ctx);
    expect(provided.map(([key]) => key)).toEqual([
      "collabSharing",
      "collabLock",
      "collabDigest",
    ]);
    expect(provided[0]?.[1]).toBeInstanceOf(SharingService);
    expect(provided[1]?.[1]).toBeInstanceOf(LockService);
    expect(provided[2]?.[1]).toBeInstanceOf(DigestService);
    expect(commands).toHaveLength(1);
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([
      "collab_share",
      "collab_global_read",
      "collab_global_write",
    ]);
    expect(listeners).toHaveLength(1);
    expect(routes.map((route) => route.path)).toContain(
      "/api/collab/space/files",
    );
    expect(new Set(routes.map((route) => route.path)).size).toBe(routes.length);

    dispose?.();
    disposers.forEach((dispose) => dispose());
  });

  it("loads without identity while browser routes wait for the optional service", async () => {
    const current = tables();
    const disposers: Array<() => void> = [];
    const provided: Array<[string, unknown]> = [];
    const commands: unknown[] = [];
    const tools: unknown[] = [];
    const routes: WebRouteLike[] = [];
    const listeners: unknown[] = [];
    const fakeDomains = {
      collab_sharing: {
        table: (name: string) =>
          current[
            name === "policies"
              ? "policies"
              : name === "audit"
                ? "audit"
                : "globalRequests"
          ],
        close: async () => undefined,
      },
      collab_config: {
        table: () => current.configs,
        close: async () => undefined,
      },
      collab_locks: {
        table: () => current.locks,
        close: async () => undefined,
      },
    };
    const ctx: SpaceContext = {
      effect: (register) => disposers.push(register()),
      provide: (key, value) => provided.push([key, value]),
      commands: { register: (definition) => commands.push(definition) },
      tools: { register: (definition) => tools.push(definition) },
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => undefined;
        },
      },
      storageDomain: {
        open: async (spec) =>
          fakeDomains[spec.name as keyof typeof fakeDomains] as never,
      },
      workspaceRegistry: registry(root),
      inject: (_keys, _callback) => ({ dispose: () => undefined }),
      on: (_event, listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };

    const dispose = await apply(ctx);
    expect(provided).toHaveLength(3);
    expect(commands).toHaveLength(1);
    expect(tools).toHaveLength(3);
    expect(listeners).toHaveLength(1);
    expect(routes).toEqual([]);

    dispose?.();
    disposers.forEach((dispose) => dispose());
  });
});
