import { describe, expect, it } from "vitest";
import {
  EmployeeService,
  createEmployeeRoutes,
  type WebRouteLike,
} from "./index.js";
import type {
  ActionTicket,
  AuditEvent,
  Delegation,
  DelegationReport,
  Employee,
  RoleAssignment,
  RuntimeProfile,
} from "./models.js";

class Table<V> {
  readonly records = new Map<string, V>();
  get(key: string): V | undefined {
    return this.records.get(key);
  }
  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }
  get size(): number {
    return this.records.size;
  }
  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }
}

interface Tables {
  employees: Table<Employee>;
  roleAssignments: Table<RoleAssignment>;
  runtimeProfiles: Table<RuntimeProfile>;
  delegations: Table<Delegation>;
  delegationReports: Table<DelegationReport>;
  actionTickets: Table<ActionTicket>;
  auditEvents: Table<AuditEvent>;
}

const now = () => new Date("2026-09-12T01:02:03.456Z");

function tables(): Tables {
  return {
    employees: new Table(),
    roleAssignments: new Table(),
    runtimeProfiles: new Table(),
    delegations: new Table(),
    delegationReports: new Table(),
    actionTickets: new Table(),
    auditEvents: new Table(),
  };
}

function team(
  users: Array<[string, string, ("active" | "disabled")?]> = [
    ["gui-owner", "Olivia Yang"],
  ],
) {
  const records = new Map(
    users.map(([id, name, status = "active"]) => [id, { id, name, status }]),
  );
  return {
    users: () => [...records.values()],
    resolveToken: (token: string) =>
      token === "admin"
        ? { userId: "gui-owner", role: "admin" as const }
        : token === "member"
          ? { userId: "gui-member", role: "member" as const }
          : token === "outsider"
            ? { userId: "gui-outsider", role: "member" as const }
            : undefined,
    members: (workspaceId: string) =>
      workspaceId === "ws-core"
        ? [{ userId: "gui-owner", memberRole: "owner" as const }]
        : [],
    updateUser: async (
      _actorId: string,
      targetId: string,
      changes: { status?: "active" | "disabled" },
    ) => {
      const current = records.get(targetId);
      if (current === undefined) throw new Error("user not found");
      const updated = {
        ...current,
        ...(changes.status === undefined ? {} : { status: changes.status }),
      };
      records.set(targetId, updated);
      return updated;
    },
    registerUser: async (
      _actorId: string,
      input: {
        userId: string;
        name: string;
        password: string;
        role: "admin" | "owner" | "member" | "guest";
      },
    ) => {
      if (records.has(input.userId)) throw new Error("user id already exists");
      const user = {
        id: input.userId,
        name: input.name,
        role: input.role,
        status: "active" as const,
      };
      records.set(input.userId, user);
      return user;
    },
  };
}

function personaRegistry(
  ids: readonly string[] = ["backend-engineer", "arch-reviewer"],
) {
  const known = new Set(ids);
  return {
    get: async (personaId: string) => {
      if (!known.has(personaId)) throw new Error("persona is unreadable");
      return { id: personaId, name: personaId };
    },
  };
}

function service(
  users?: Array<[string, string, ("active" | "disabled")?]>,
) {
  const storage = tables();
  const personas = personaRegistry();
  const identity = team(users);
  const principalSyncs: Array<{
    employeeId: string;
    kind: "human" | "digital";
    displayName: string;
    status: string;
    authUserId?: string | undefined;
    authStatus?: "active" | "disabled" | undefined;
  }> = [];
  const principalIds = new Map<string, string>();
  const employeeService = new EmployeeService(storage, {
    now,
    personas: () => personas,
  });
  employeeService.setIdentityService(() => identity);
  employeeService.setPrincipalService(() => ({
    syncEmployee: async (input) => {
      principalSyncs.push(input);
      principalIds.set(
        input.employeeId,
        input.kind === "human" && input.authUserId !== undefined
          ? `principal-human-${input.authUserId}`
          : `principal-${input.kind === "human" ? "human" : "ai"}-${
              input.employeeId
            }`,
      );
    },
    resolveSubject: (_subjectType, subjectId) => {
      const principalId = principalIds.get(subjectId);
      return principalId === undefined
        ? undefined
        : {
            id: principalId,
            kind: subjectId.startsWith("digital-") ? "ai" : "human",
            status: "active" as const,
          };
    },
    syncGrant: async () => undefined,
    revokeMatchingGrants: async () => undefined,
  }));
  return {
    employeeService,
    personas,
    storage,
    team: identity,
    principalSyncs,
  };
}

async function createBackend(
  employeeService: EmployeeService,
  options: { status?: "active" } = {},
) {
  await employeeService.syncIdentityUsers(team().users());
  const digital = await employeeService.createDigital("gui-owner", {
    employeeId: "backend-01",
    displayName: "Backend Engineer 01",
    personaId: "backend-engineer",
    managerEmployeeId: "gui-owner",
  });
  if (options.status === "active") {
    return employeeService.changeStatus("gui-owner", digital.id, "active");
  }
  return digital;
}

async function response(
  route: WebRouteLike,
  init: { method: string; token?: string; body?: unknown; url?: string },
) {
  const payload = {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
      return this;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
      return this;
    },
  };
  await route.handler(
    {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : {
            [Symbol.asyncIterator]: async function* () {
              yield Buffer.from(JSON.stringify(init.body), "utf8");
            },
          }),
      url: init.url ?? "/",
      headers: {
        host: "127.0.0.1:33117",
        origin: "http://127.0.0.1:33117",
        ...(init.token === undefined
          ? {}
          : { authorization: `Bearer ${init.token}` }),
      },
    } as unknown as Parameters<WebRouteLike["handler"]>[0],
    payload as unknown as Parameters<WebRouteLike["handler"]>[1],
  );
  return {
    status: payload.status,
    body: payload.body === "" ? null : JSON.parse(payload.body),
  };
}

describe("digital employee lifecycle", () => {
  it("maps login accounts and creates a Digital Employee without login capability", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    await employeeService.syncIdentityUsers([
      { id: "gui-owner", name: "Olivia" },
    ]);
    expect(employeeService.getByAuthUserId("gui-owner")).toMatchObject({
      id: "gui-owner",
      kind: "human",
      authUserId: "gui-owner",
      displayName: "Olivia",
    });
    const digital = await createBackend(employeeService, { status: "active" });
    expect(digital).toMatchObject({
      id: "backend-01",
      kind: "digital",
      status: "active",
    });
    expect(digital.authUserId).toBeUndefined();
    expect(team.users().some((user) => user.id === digital.id)).toBe(false);
  });

  it("projects login status and disables login when a Human Employee is archived", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers([
      { id: "gui-owner", name: "Olivia Yang", status: "active" },
      { id: "gui-member", name: "Lee Gong", status: "disabled" },
    ]);
    expect(employeeService.getByAuthUserId("gui-member")).toMatchObject({
      authStatus: "disabled",
      status: "active",
    });

    const archived = await employeeService.changeStatus(
      "gui-owner",
      "gui-member",
      "archived",
    );
    expect(archived).toMatchObject({
      authStatus: "disabled",
      status: "archived",
    });
    expect(team.users().find((user) => user.id === "gui-member")?.status).toBe(
      "disabled",
    );
  });

  it("projects human and AI employees into the Principal foundation", async () => {
    const { employeeService, team, principalSyncs } = service([
      ["gui-owner", "Olivia Yang"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    const digital = await createBackend(employeeService, { status: "active" });

    expect(employeeService.getByAuthUserId("gui-owner")?.principalId).toBe(
      "principal-human-gui-owner",
    );
    expect(
      principalSyncs.find(
        (item) => item.employeeId === "gui-owner" && item.kind === "human",
      ),
    ).toMatchObject({
      displayName: "Olivia Yang",
      status: "active",
      authUserId: "gui-owner",
      authStatus: "active",
    });
    expect(
      principalSyncs
        .filter(
          (item) => item.employeeId === digital.id && item.kind === "digital",
        )
        .at(-1),
    ).toMatchObject({
      displayName: "Backend Engineer 01",
      status: "active",
    });
    expect(digital.principalId).toBe("principal-ai-backend-01");
  });

  it("projects only the current Human Employee and preserves its account status", async () => {
    const { employeeService, storage, team, principalSyncs } = service([
      ["gui-owner", "Olivia Yang", "disabled"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    storage.employees.put("legacy-gui-owner", {
      id: "legacy-gui-owner",
      kind: "human",
      displayName: "Legacy Olivia",
      department: "",
      title: "",
      tags: [],
      authUserId: "gui-owner",
      authStatus: "disabled",
      status: "archived",
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      createdBy: "legacy",
    });
    principalSyncs.length = 0;

    await employeeService.syncIdentityUsers(team.users());

    const humanSyncs = principalSyncs.filter(
      (item) => item.kind === "human" && item.authUserId === "gui-owner",
    );
    expect(humanSyncs).toHaveLength(1);
    expect(humanSyncs[0]).toMatchObject({
      employeeId: "gui-owner",
      status: "active",
      authStatus: "disabled",
    });
  });

  it("archives removed identity projections without changing Digital Employees", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    const digital = await employeeService.createDigital("gui-owner", {
      employeeId: "backend-01",
      displayName: "Backend Engineer 01",
      personaId: "backend-engineer",
      managerEmployeeId: "gui-owner",
    });

    await employeeService.syncIdentityUsers([
      { id: "gui-owner", name: "Olivia Yang" },
    ]);
    expect(employeeService.getByAuthUserId("gui-member")).toMatchObject({
      authUserId: "gui-member",
      authStatus: "disabled",
      status: "archived",
    });
    expect(employeeService.get("backend-01")).toMatchObject({
      status: "draft",
    });
  });

  it("creates a fresh identity projection instead of reviving archived history", async () => {
    const { employeeService, storage, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    const original = employeeService.getByAuthUserId("gui-member");
    await employeeService.syncIdentityUsers([
      { id: "gui-owner", name: "Olivia Yang" },
    ]);
    await employeeService.syncIdentityUsers(team.users());

    const restored = employeeService.getByAuthUserId("gui-member");
    expect(restored).toMatchObject({
      authUserId: "gui-member",
      displayName: "Lee Gong",
      status: "active",
    });
    expect(restored?.id).not.toBe(original?.id);
    expect(storage.employees.get(original?.id ?? "")?.status).toBe("archived");
  });

  it("requires Digital Employee personas to exist", async () => {
    const { employeeService } = service();
    await employeeService.syncIdentityUsers(team().users());
    await expect(
      employeeService.createDigital("gui-owner", {
        employeeId: "invalid-persona",
        displayName: "Invalid Persona",
        personaId: "missing-persona",
        managerEmployeeId: "gui-owner",
      }),
    ).rejects.toThrow("persona does not exist: missing-persona");
    expect(
      employeeService.list().find((item) => item.id === "invalid-persona"),
    ).toBeUndefined();
  });

  it("enforces lifecycle transitions and blocks archived dispatch", async () => {
    const { employeeService } = service();
    const digital = await createBackend(employeeService);
    await expect(
      employeeService.changeStatus("gui-owner", digital.id, "active"),
    ).resolves.toMatchObject({ status: "active" });
    const assignment = await employeeService.assignRole("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      role: "member",
    });
    expect(assignment.principalId).toBe("principal-ai-backend-01");
    await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "backend runtime",
    });
    expect(() =>
      employeeService.assertDispatchable(digital.id, "ws-core"),
    ).not.toThrow();
    await employeeService.changeStatus("gui-owner", digital.id, "suspended");
    expect(
      employeeService.workflowDispatchBlockReason(digital.id, "ws-core"),
    ).toBe("AI伙伴「Backend Engineer 01」已暂停，不能派发");
    await expect(
      employeeService.changeStatus("gui-owner", digital.id, "active"),
    ).resolves.toMatchObject({ status: "active" });
    await employeeService.changeStatus("gui-owner", digital.id, "archived");
    await expect(
      employeeService.changeStatus("gui-owner", digital.id, "active"),
    ).rejects.toThrow("cannot change employee from archived to active");
    expect(() =>
      employeeService.assertDispatchable(digital.id, "ws-core"),
    ).toThrow("employee is archived; dispatch is blocked");
  });
});

describe("runtime authorization", () => {
  it("intersects role, runtime, and requested actions; deny wins and tickets stay scoped", async () => {
    const { employeeService } = service();
    await employeeService.syncIdentityUsers(team().users());
    const digital = await createBackend(employeeService, { status: "active" });
    await employeeService.assignRole("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      role: "member",
      permissions: ["read", "write", "tool:read", "tool:danger"],
    });
    await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "scoped backend",
      allowedTools: ["tool:read"],
      deniedTools: ["tool:danger"],
      resourceScopes: ["repo/alpha"],
      maxMinutes: 30,
    });
    const ticket = await employeeService.issueRuntimeTicket("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      contextType: "task",
      contextId: "task-01",
      requestedActions: [
        "read",
        "write",
        "approve",
        "tool:read",
        "tool:danger",
      ],
      resourceScopes: ["repo/alpha/src", "repo/beta"],
    });
    expect(ticket.principal.principalId).toBe("principal-ai-backend-01");
    expect(ticket.allowedActions).toEqual(["read", "write", "tool:read"]);
    expect(ticket.deniedActions).toEqual(["tool:danger"]);
    expect(ticket.resourceScopes).toEqual(["repo/alpha/src"]);
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "read",
        workspaceId: "ws-core",
        contextType: "task",
        contextId: "task-01",
      }),
    ).resolves.toMatchObject({
      employeeId: digital.id,
      principalId: "principal-ai-backend-01",
      source: "runtime",
    });
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "tool:danger",
        workspaceId: "ws-core",
        contextType: "task",
        contextId: "task-01",
      }),
    ).rejects.toThrow("action is explicitly denied");
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "read",
        workspaceId: "ws-other",
        contextType: "task",
        contextId: "task-01",
      }),
    ).rejects.toThrow("ticket is revoked, expired, or outside this context");
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "read",
        workspaceId: "ws-core",
        contextType: "review",
        contextId: "task-01",
      }),
    ).rejects.toThrow("ticket is revoked, expired, or outside this context");
  });

  it("requires an explicit active Runtime Profile and disables the old active profile", async () => {
    const { employeeService } = service();
    const digital = await createBackend(employeeService, { status: "active" });
    await employeeService.assignRole("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      role: "member",
    });
    expect(() =>
      employeeService.assertDispatchable(digital.id, "ws-core"),
    ).toThrow("active Runtime Profile is required");
    const first = await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "first",
    });
    expect(first.principalId).toBe("principal-ai-backend-01");
    const second = await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "second",
    });
    expect(
      employeeService
        .listProfiles({ employeeId: digital.id })
        .find((profile) => profile.id === first.id)?.status,
    ).toBe("disabled");
    expect(
      employeeService
        .listProfiles({ employeeId: digital.id })
        .find((profile) => profile.id === second.id)?.status,
    ).toBe("active");
  });
});

describe("human avatar delegation", () => {
  it("accepts a verified meeting workspace role without a duplicate employee assignment", async () => {
    const { employeeService } = service();
    await employeeService.syncIdentityUsers(team().users());
    await expect(
      employeeService.createDelegation("gui-owner", {
        workspaceId: "ws-core",
        contextType: "meeting",
        contextId: "meeting-verified-role",
        objective: "验证会议成员身份可以直接派遣",
        allowedActions: ["meeting.read", "meeting.speak"],
        speakPolicy: "mentions",
        approvalPolicy: "never",
      }),
    ).rejects.toThrow("owner must have an active workspace role");

    const delegation = await employeeService.createDelegation("gui-owner", {
      workspaceId: "ws-core",
      ownerWorkspaceRole: "member",
      contextType: "meeting",
      contextId: "meeting-verified-role",
      objective: "验证会议成员身份可以直接派遣",
      allowedActions: ["meeting.read", "meeting.speak"],
      speakPolicy: "mentions",
      approvalPolicy: "never",
    });
    expect(delegation).toMatchObject({
      ownerId: "gui-owner",
      workspaceId: "ws-core",
      status: "active",
    });
  });

  it("creates a restricted delegation, denies final approval, and blocks paused use", async () => {
    const { employeeService } = service();
    const digital = await createBackend(employeeService);
    await employeeService.changeStatus("gui-owner", digital.id, "active");
    await employeeService.assignRole("gui-owner", {
      employeeId: "gui-owner",
      workspaceId: "ws-core",
      role: "member",
      permissions: ["meeting.read", "meeting.speak", "approval.final"],
    });
    await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "unused",
      status: "disabled",
    });
    const delegation = await employeeService.createDelegation("gui-owner", {
      displayName: "Olivia · Reviewer",
      workspaceId: "ws-core",
      contextType: "meeting",
      contextId: "meeting-01",
      objective: "核对新链路的审批边界",
      stance: "先补齐审计，再扩大导出范围",
      watchItems: ["跨工作区导出"],
      allowedActions: ["meeting.read", "meeting.speak", "approval.final"],
      speakPolicy: "mentions",
      approvalPolicy: "never",
    });
    expect(delegation.status).toBe("active");
    expect(delegation.deniedActions).toContain("approval.final");
    const ticket = await employeeService.issueDelegationTicket("gui-owner", {
      delegationId: delegation.id,
      requestedActions: ["meeting.read", "meeting.speak", "approval.final"],
    });
    expect(ticket.allowedActions).toEqual(["meeting.read", "meeting.speak"]);
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "meeting.speak",
        workspaceId: "ws-core",
        contextType: "meeting",
        contextId: "meeting-01",
      }),
    ).resolves.toMatchObject({
      source: "delegation",
      delegationId: delegation.id,
    });
    await expect(
      employeeService.authorizeTicket({
        ticketId: ticket.id,
        action: "approval.final",
        workspaceId: "ws-core",
        contextType: "meeting",
        contextId: "meeting-01",
      }),
    ).rejects.toThrow("action is explicitly denied");
    await employeeService.changeDelegationStatus(
      "gui-owner",
      delegation.id,
      "paused",
    );
    await expect(
      employeeService.issueDelegationTicket("gui-owner", {
        delegationId: delegation.id,
        requestedActions: ["meeting.speak"],
      }),
    ).rejects.toThrow("delegation or owner is unavailable");
  });

  it("does not fake a failed report and can retry with transcript", async () => {
    const { employeeService } = service();
    await employeeService.syncIdentityUsers(team().users());
    await employeeService.assignRole("gui-owner", {
      employeeId: "gui-owner",
      workspaceId: "ws-core",
      role: "member",
      permissions: ["meeting.read", "meeting.speak"],
    });
    const delegation = await employeeService.createDelegation("gui-owner", {
      workspaceId: "ws-core",
      contextType: "meeting",
      contextId: "meeting-01",
      objective: "汇总风险",
      allowedActions: ["meeting.read", "meeting.speak"],
      speakPolicy: "manual",
      approvalPolicy: "never",
    });
    const failed = await employeeService.generateDelegationReport(
      delegation.id,
      "",
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("缺少会议记录，不能生成分身报告");
    const report = await employeeService.generateDelegationReport(
      delegation.id,
      "Olivia: 请补审计字段\nLee: 同意",
      { finalize: true },
    );
    expect(report.status).toBe("generated");
    expect(report.report).toContain("# 分身会议报告");
    expect(employeeService.getDelegation(delegation.id).status).toBe(
      "completed",
    );
  });
});

describe("employee HTTP surface", () => {
  it("freezes Employee product writes while keeping export and compatibility reads", async () => {
    const { employeeService, team } = service([["gui-owner", "Olivia Yang"]]);
    await employeeService.syncIdentityUsers(team.users());
    const routes = createEmployeeRoutes(employeeService, () => team);
    const create = routes.find(
      (route) => route.path === "/api/collab/employee/digital",
    )!;
    const denied = await response(create, {
      method: "POST",
      token: "admin",
      body: {
        employeeId: "phase4-new-ai",
        displayName: "Phase 4 New AI",
        personaId: "backend-engineer",
        managerEmployeeId: "gui-owner",
      },
    });
    expect(denied.status).toBe(410);
    expect(denied.body).toMatchObject({
      error: { code: "gone" },
    });
    expect(
      employeeService.list().some((employee) => employee.id === "phase4-new-ai"),
    ).toBe(false);

    const exported = await response(
      routes.find((route) => route.path === "/api/collab/employee/export")!,
      { method: "GET", token: "admin" },
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({
      export: {
        version: 1,
        compatibilityMode: "read-only",
      },
    });

    const compatibility = await response(
      routes.find(
        (route) => route.path === "/api/collab/employee/compatibility",
      )!,
      { method: "GET", token: "admin" },
    );
    expect(compatibility.status).toBe(200);
    expect(compatibility.body).toMatchObject({
      report: {
        readOnly: true,
        summary: {
          employees: 1,
          principalsLinked: 1,
          errors: 0,
        },
      },
    });
  });

  it("creates a Human Employee with an optional login account", async () => {
    const { employeeService, team } = service([["gui-owner", "Olivia Yang"]]);
    await employeeService.syncIdentityUsers(team.users());
    const create = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    }).find(
      (route) => route.path === "/api/collab/employee/human",
    )!;
    const created = await response(create, {
      method: "POST",
      token: "admin",
      body: {
        employeeId: "human-designer",
        displayName: "Design Partner",
        department: "设计",
        title: "产品设计师",
        account: {
          userId: "designer",
          password: "password-123",
        },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.employee).toMatchObject({
      id: "human-designer",
      kind: "human",
      authUserId: "designer",
      status: "active",
    });
    expect(team.users()).toContainEqual(
      expect.objectContaining({
        id: "designer",
        name: "Design Partner",
        role: "member",
      }),
    );

    const noAccount = await response(create, {
      method: "POST",
      token: "admin",
      body: {
        employeeId: "human-researcher",
        displayName: "Research Partner",
      },
    });
    expect(noAccount.status).toBe(201);
    expect(noAccount.body.employee.authUserId).toBeUndefined();

    const invalidManager = await response(create, {
      method: "POST",
      token: "admin",
      body: {
        displayName: "Invalid Manager",
        managerEmployeeId: "missing-manager",
        account: {
          userId: "invalid-manager",
          password: "password-123",
        },
      },
    });
    expect(invalidManager.status).toBe(400);
    expect(team.users().some((user) => user.id === "invalid-manager")).toBe(
      false,
    );
  });

  it("limits employee roles to admins, the employee, or their manager", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
      ["gui-outsider", "Peter Zhang"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    const digital = await employeeService.createDigital("gui-owner", {
      employeeId: "role-guard-ai",
      displayName: "Role Guard AI",
      personaId: "backend-engineer",
      managerEmployeeId: "gui-member",
    });
    await employeeService.assignRole("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      role: "member",
      permissions: ["read", "write"],
    });
    const roles = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    }).find(
      (route) => route.path === "/api/collab/employee/roles",
    )!;
    const url = `/api/collab/employee/roles?employeeId=${digital.id}`;

    expect(
      (await response(roles, { method: "GET", token: "admin", url })).status,
    ).toBe(200);
    expect(
      (
        await response(roles, {
          method: "GET",
          token: "member",
          url,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await response(roles, {
          method: "GET",
          token: "outsider",
          url,
        })
      ).status,
    ).toBe(403);

    const detail = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    }).find(
      (route) => route.path === "/api/collab/employee/detail",
    )!;
    const detailUrl = `/api/collab/employee/detail?employeeId=${digital.id}`;
    expect(
      (
        await response(detail, {
          method: "GET",
          token: "member",
          url: detailUrl,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await response(detail, {
          method: "GET",
          token: "outsider",
          url: detailUrl,
        })
      ).status,
    ).toBe(403);
  });

  it("keeps directory admin-only and Digital Employees non-login", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    const routes = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    });
    const create = routes.find(
      (route) => route.path === "/api/collab/employee/digital",
    )!;
    const denied = await response(create, {
      method: "POST",
      token: "member",
      body: {},
    });
    expect(denied.status).toBe(403);
    const created = await response(create, {
      method: "POST",
      token: "admin",
      body: {
        employeeId: "arch-reviewer",
        displayName: "Architecture Reviewer",
        personaId: "arch-reviewer",
        managerEmployeeId: "gui-owner",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.employee.authUserId).toBeUndefined();
    const status = routes.find(
      (route) => route.path === "/api/collab/employee/status",
    )!;
    const activated = await response(status, {
      method: "POST",
      token: "admin",
      body: { employeeId: "arch-reviewer", status: "active" },
    });
    expect(activated.status).toBe(200);
    expect(activated.body.employee.status).toBe("active");
    const directory = routes.find(
      (route) => route.path === "/api/collab/employee",
    )!;
    const forbidden = await response(directory, {
      method: "GET",
      token: "member",
    });
    const allowed = await response(directory, {
      method: "GET",
      token: "admin",
    });
    expect(forbidden.status).toBe(403);
    expect(allowed.body.employees.map((item: Employee) => item.id)).toContain(
      "arch-reviewer",
    );
  });

  it("allows only the delegation owner or admin to issue and close tickets", async () => {
    const { employeeService, team } = service([
      ["gui-owner", "Olivia Yang"],
      ["gui-member", "Lee Gong"],
    ]);
    await employeeService.syncIdentityUsers(team.users());
    await employeeService.assignRole("gui-owner", {
      employeeId: "gui-owner",
      workspaceId: "ws-core",
      role: "member",
      permissions: ["meeting.read", "meeting.speak"],
    });
    const delegation = await employeeService.createDelegation("gui-owner", {
      workspaceId: "ws-core",
      contextType: "meeting",
      contextId: "meeting-guard",
      objective: "验证委托权限边界",
      allowedActions: ["meeting.read", "meeting.speak"],
      speakPolicy: "manual",
      approvalPolicy: "never",
    });
    const routes = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    });
    const issue = routes.find(
      (route) => route.path === "/api/collab/delegation/ticket",
    )!;
    const forbidden = await response(issue, {
      method: "POST",
      token: "member",
      body: {
        delegationId: delegation.id,
        requestedActions: ["meeting.speak"],
      },
    });
    expect(forbidden.status).toBe(403);
    const allowed = await response(issue, {
      method: "POST",
      token: "admin",
      body: {
        delegationId: delegation.id,
        requestedActions: ["meeting.speak"],
      },
    });
    expect(allowed.status).toBe(201);
    await expect(
      employeeService.extendDelegation("gui-owner", delegation.id, 30),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      employeeService.extendDelegation("gui-member", delegation.id, 30),
    ).rejects.toThrow("only the delegation owner or admin can extend it");
    const status = routes.find(
      (route) => route.path === "/api/collab/delegation/status",
    )!;
    const revoked = await response(status, {
      method: "POST",
      token: "admin",
      body: { delegationId: delegation.id, status: "revoked" },
    });
    expect(revoked.status).toBe(200);
    expect(employeeService.getDelegation(delegation.id).status).toBe("revoked");
  });

  it("aggregates governance data for admins only", async () => {
    const { employeeService, team } = service();
    await employeeService.syncIdentityUsers(team.users());
    const digital = await createBackend(employeeService, { status: "active" });
    await employeeService.assignRole("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      role: "member",
      permissions: ["read", "write"],
    });
    const profile = await employeeService.upsertRuntimeProfile("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      name: "task runtime",
      legacyAgentProfileId: "backend-agent",
    });
    await employeeService.issueRuntimeTicket("gui-owner", {
      employeeId: digital.id,
      workspaceId: "ws-core",
      contextType: "workflow",
      contextId: "instance-01",
      requestedActions: ["read", "write"],
    });
    const routes = createEmployeeRoutes(employeeService, () => team, {
      compatibilityWrites: true,
    });
    const route = routes.find(
      (item) => item.path === "/api/collab/employee/governance",
    )!;
    const denied = await response(route, { method: "GET", token: "member" });
    const allowed = await response(route, { method: "GET", token: "admin" });
    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.body.employees.map((item: Employee) => item.id)).toContain(
      digital.id,
    );
    expect(
      allowed.body.profiles.map((item: RuntimeProfile) => item.id),
    ).toContain(profile.id);
    expect(allowed.body.tickets).toHaveLength(1);
    expect(allowed.body.audit.length).toBeGreaterThan(0);
  });

  it("expires delegations and tickets when their validity ends", async () => {
    let current = new Date("2026-09-12T01:00:00.000Z");
    const storage = tables();
    const employeeService = new EmployeeService(storage, {
      now: () => current,
    });
    await employeeService.syncIdentityUsers(team().users());
    await employeeService.assignRole("gui-owner", {
      employeeId: "gui-owner",
      workspaceId: "ws-core",
      role: "member",
      permissions: ["meeting.read", "meeting.speak"],
    });
    const delegation = await employeeService.createDelegation("gui-owner", {
      workspaceId: "ws-core",
      contextType: "meeting",
      contextId: "meeting-expiry",
      objective: "验证到期收敛",
      allowedActions: ["meeting.read", "meeting.speak"],
      speakPolicy: "manual",
      approvalPolicy: "never",
      durationMinutes: 1,
    });
    const ticket = await employeeService.issueDelegationTicket("gui-owner", {
      delegationId: delegation.id,
      requestedActions: ["meeting.speak"],
    });
    current = new Date("2026-09-12T01:02:00.000Z");
    const result = await employeeService.sweepExpired();
    expect(result).toEqual({ delegations: 1, tickets: 1 });
    expect(employeeService.getDelegation(delegation.id).status).toBe("expired");
    expect(storage.actionTickets.get(ticket.id)?.status).toBe("expired");
    expect(
      employeeService.listDelegationExpiryNotices("gui-owner"),
    ).toMatchObject([
      {
        delegationId: delegation.id,
        contextType: "meeting",
        contextId: "meeting-expiry",
        impact: "该会议中的自动发言和跟进已暂停。",
        suggestedActions: ["extend", "resume", "reassign"],
      },
    ]);
  });
});
