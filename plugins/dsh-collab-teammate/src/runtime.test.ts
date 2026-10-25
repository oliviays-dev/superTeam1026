import { describe, expect, it } from "vitest";
import {
  isTaskRunning,
  normalizeTaskProgress,
  runningTeammateIds,
} from "./index.js";
import type { Teammate, TeammateEvent, TeammateTemplate } from "./models.js";
import { TeammateRuntime } from "./runtime.js";
import {
  PrincipalRuntimeService,
  type PrincipalActionTicket,
  type PrincipalRuntimeProfile,
} from "./principal-runtime.js";
import {
  TeammateService,
  TeammateTemplateService,
  type KvTableLike,
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

const admin = { userId: "admin", name: "Admin", role: "admin" as const };
const olivia = { userId: "olivia", name: "Olivia", role: "member" as const };

describe("teammate task projection", () => {
  it("normalizes stored validation issue lists into readable progress", () => {
    expect(
      normalizeTaskProgress(
        '无法启动执行：[{"path":["tags",1],"message":"Too big: expected string to have <=32 characters"}]',
      ),
    ).toBe("无法启动执行：Too big: expected string to have <=32 characters");
    expect(normalizeTaskProgress("普通执行消息")).toBe("普通执行消息");
  });
});

interface FakeEmployee {
  id: string;
  kind: string;
  status: string;
  authUserId?: string | undefined;
  tags?: readonly string[];
  personaId?: string;
  displayName: string;
  department?: string;
  title?: string;
  managerEmployeeId: string;
}

function setup() {
  const teammateTable = memoryTable<Teammate>();
  const teammateEventTable = memoryTable<TeammateEvent>();
  const templates = new TeammateTemplateService({
    tables: { templates: memoryTable<TeammateTemplate>() },
  });
  const teammates = new TeammateService({
    tables: {
      teammates: teammateTable,
      events: teammateEventTable,
    },
    templates,
  });
  const personas = new Map<string, unknown>();
  const employees = new Map<string, FakeEmployee>();
  const managers = new Map<string, FakeEmployee>([
    [
      "admin",
      {
        id: "human-admin",
        kind: "human",
        status: "active",
        authUserId: "admin",
        displayName: "Admin",
        managerEmployeeId: "",
      },
    ],
    [
      "olivia",
      {
        id: "human-olivia",
        kind: "human",
        status: "active",
        authUserId: "olivia",
        displayName: "Olivia",
        managerEmployeeId: "",
      },
    ],
  ]);
  const roles: Array<{
    employeeId: string;
    workspaceId: string;
    role: string;
  }> = [];
  /** 员工档案上的工作区角色授权（退出项目/角色用）。 */
  const roleAssignments: Array<{
    id: string;
    employeeId: string;
    workspaceId: string;
    role: string;
    permissions: string[];
    status: string;
  }> = [];
  const runtimes: Array<{
    id: string;
    employeeId: string;
    workspaceId: string;
    name: string;
    status: string;
    createdBy: string;
    legacyAgentProfileId?: string | undefined;
    allowedTools?: readonly string[] | undefined;
  }> = [];
  const agentProfiles: Array<{
    id: string;
    status: string;
    personaId?: string;
    visibility?: "workspace" | "platform";
    execution?: "builtin" | "external";
    externalRuntimeId?: string;
    allowedTools: readonly string[];
  }> = [];
  const agentActors: Array<{
    readonly id: string;
    readonly globalRole?: string | undefined;
    readonly workspaceRole?: string | undefined;
    readonly workspaceId?: string | undefined;
  }> = [];
  const agentRuns: Array<{
    id: string;
    employeeId?: string | undefined;
    principalId?: string | undefined;
    status: string;
  }> = [];
  const principalCompanionLinks: Array<{
    teammateId: string;
    employeeId: string;
    displayName?: string | undefined;
  }> = [];
  const principalRecords = new Map<
    string,
    {
      id: string;
      kind: "human" | "ai";
      status: "active" | "suspended" | "archived";
    }
  >();
  const principalGrants: Array<{
    id: string;
    principalId: string;
    scopeType: "platform" | "workspace" | "project";
    scopeId: string;
    role: string;
    permissions: readonly string[];
    status: "active" | "revoked" | "expired";
  }> = [];
  let principalRuntimeSequence = 0;
  const principalService = {
    get: (principalId: string) => {
      const principal = principalRecords.get(principalId);
      if (principal === undefined) throw new Error("principal not found");
      return principal;
    },
    syncPrincipal: async (input: {
      kind: "ai";
      subjectType: "teammate";
      subjectId: string;
      displayName: string;
    }) => {
      const principal = {
        id: `principal-ai-${input.subjectId}`,
        kind: "ai" as const,
        status: "active" as const,
      };
      principalRecords.set(principal.id, principal);
      return principal;
    },
    syncCompanion: async (input: {
      teammateId: string;
      employeeId: string;
      displayName?: string | undefined;
    }) => {
      principalCompanionLinks.push(input);
    },
    resolveSubject: (
      subjectType: "employee" | "teammate" | "auth-user",
      subjectId: string,
    ) => {
      if (subjectType === "teammate") {
        const bound = teammates.get(subjectId).principalId;
        const principal = {
          id: bound ?? `principal-ai-${subjectId}`,
          kind: "ai" as const,
          status: principalRecords.get(bound ?? "")?.status ?? "active",
        };
        principalRecords.set(principal.id, principal);
        return principal;
      }
      if (subjectType === "auth-user") {
        const principal = {
          id: `principal-human-${subjectId}`,
          kind: "human" as const,
          status: "active" as const,
        };
        principalRecords.set(principal.id, principal);
        return principal;
      }
      const principal = {
        id: `principal-ai-${subjectId}`,
        kind: "ai" as const,
        status: "active" as const,
      };
      principalRecords.set(principal.id, principal);
      return principal;
    },
    syncExclusiveGrant: async (input: {
      principalId: string;
      scopeType: "workspace";
      scopeId: string;
      role: string;
      permissions: readonly string[];
    }) => {
      for (const grant of principalGrants) {
        if (
          grant.principalId === input.principalId &&
          grant.scopeType === input.scopeType &&
          grant.scopeId === input.scopeId
        ) {
          grant.status = "revoked";
        }
      }
      const grant = {
        id: `grant-${String(principalGrants.length + 1)}`,
        principalId: input.principalId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        role: input.role,
        permissions: input.permissions,
        status: "active" as const,
      };
      principalGrants.push(grant);
      return grant;
    },
    grants: (principalId?: string) =>
      principalGrants.filter(
        (grant) =>
          principalId === undefined || grant.principalId === principalId,
      ),
    revokeMatchingGrants: async (input: {
      principalId: string;
      scopeType: "workspace";
      scopeId: string;
      role: string;
    }) => {
      for (const grant of principalGrants) {
        if (
          grant.principalId === input.principalId &&
          grant.scopeType === input.scopeType &&
          grant.scopeId === input.scopeId &&
          grant.role === input.role
        ) {
          grant.status = "revoked";
        }
      }
    },
  };
  const principalRuntime = new PrincipalRuntimeService(
    {
      profiles: memoryTable<PrincipalRuntimeProfile>(),
      tickets: memoryTable<PrincipalActionTicket>(),
    },
    () => principalService,
    {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: () => `test-${String(++principalRuntimeSequence)}`,
    },
  );

  const runtime = new TeammateRuntime({
    teammates,
    templates: () => templates,
    personas: () => ({
      get: async (personaId) => {
        if (!personas.has(personaId)) throw new Error("persona not found");
        return personas.get(personaId);
      },
      create: async (input) => {
        personas.set(input.id, input);
        return input;
      },
      updateSoul: async (personaId: string, soul: string) => {
        const existing = personas.get(personaId);
        if (existing === undefined) throw new Error("persona not found");
        const next = { ...(existing as Record<string, unknown>), soul };
        personas.set(personaId, next);
        return next;
      },
    }),
    employees: () => ({
      getByAuthUserId: (authUserId) => managers.get(authUserId),
      list: () => [...managers.values(), ...employees.values()],
      listProfiles({ employeeId }: { employeeId: string }) {
        return runtimes.filter((item) => item.employeeId === employeeId);
      },
      createDigital: async (_actor, input) => {
        const id = input.employeeId ?? `digital-${String(employees.size + 1)}`;
        employees.set(id, {
          id,
          kind: "digital",
          status: "draft",
          tags: input.tags ?? [],
          displayName: input.displayName,
          department: input.department ?? "",
          title: input.title ?? "",
          managerEmployeeId: input.managerEmployeeId,
          ...(input.personaId === undefined
            ? {}
            : { personaId: input.personaId }),
        });
        return { id };
      },
      changeStatus: async (_actor, employeeId, status) => {
        const employee = employees.get(employeeId);
        if (employee === undefined) throw new Error("employee not found");
        employee.status = status;
        return employee;
      },
      assignRole: async (_actor, input) => {
        roles.push({
          employeeId: input.employeeId,
          workspaceId: input.workspaceId,
          role: input.role,
        });
        return input;
      },
      listRoles: ({
        employeeId,
        workspaceId,
      }: {
        employeeId?: string | undefined;
        workspaceId?: string | undefined;
      } = {}) =>
        roleAssignments.filter(
          (item) =>
            (employeeId === undefined || item.employeeId === employeeId) &&
            (workspaceId === undefined || item.workspaceId === workspaceId),
        ),
      revokeRole: async (_actor: string, assignmentId: string) => {
        const assignment = roleAssignments.find(
          (item) => item.id === assignmentId,
        );
        if (assignment === undefined) throw new Error("role not found");
        assignment.status = "revoked";
        return assignment;
      },
      upsertRuntimeProfile: async (_actor, input) => {
        const existing =
          input.id === undefined
            ? undefined
            : runtimes.find((item) => item.id === input.id);
        if (input.id !== undefined && existing === undefined) {
          throw new Error("runtime profile not found");
        }
        const record = {
          ...(existing ?? {
            id: `runtime-${String(runtimes.length + 1)}`,
            createdBy: "human-admin",
          }),
          employeeId: input.employeeId,
          workspaceId: input.workspaceId,
          name: input.name,
          status: input.status ?? "active",
          ...(input.allowedTools === undefined
            ? {}
            : { allowedTools: [...input.allowedTools] }),
          ...(input.legacyAgentProfileId === undefined
            ? {}
            : { legacyAgentProfileId: input.legacyAgentProfileId }),
        };
        if (existing !== undefined) {
          Object.assign(existing, record);
          return existing;
        }
        runtimes.push(record);
        return record;
      },
      workflowTarget: (employeeId, workspaceId) => {
        const employee = employees.get(employeeId);
        const profile = runtimes.find(
          (item) =>
            item.employeeId === employeeId && item.workspaceId === workspaceId,
        );
        if (
          employee === undefined ||
          employee.status !== "active" ||
          profile === undefined ||
          profile.legacyAgentProfileId === undefined
        ) {
          return undefined;
        }
        return { employee, profile };
      },
      runtimes,
    }),
    principals: () => principalService,
    principalRuntime: () => principalRuntime,
    agents: () => ({
      profiles(workspaceId: string) {
        return agentProfiles
          .filter((item) => item.visibility === "platform")
          .map((item) => ({
            ...item,
            workspaceId,
            name: `Agent ${item.id}`,
            runtimeKind: "task-worker",
            status: item.status,
            allowedTools: item.allowedTools,
          }));
      },
      createProfile: async (actor, input) => {
        agentActors.push(actor);
        const record = {
          id: `agent-${String(agentProfiles.length + 1)}`,
          status: "active",
          ...(input.personaId === undefined
            ? {}
            : { personaId: input.personaId }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          ...(input.externalRuntimeId === undefined
            ? {}
            : { externalRuntimeId: input.externalRuntimeId }),
          allowedTools: [...(input.allowedTools ?? [])],
          visibility: input.visibility ?? "workspace",
        };
        agentProfiles.push(record);
        return record;
      },
      updateProfile: async (actor, input) => {
        agentActors.push(actor);
        const profile = agentProfiles.find(
          (item) => item.id === input.profileId,
        );
        if (profile === undefined) throw new Error("agent profile not found");
        if (input.execution !== undefined) profile.execution = input.execution;
        if (input.externalRuntimeId === null) delete profile.externalRuntimeId;
        else if (input.externalRuntimeId !== undefined)
          profile.externalRuntimeId = input.externalRuntimeId;
        if (input.allowedTools !== undefined)
          profile.allowedTools = [...input.allowedTools];
        if (input.status !== undefined) profile.status = input.status;
        return { id: profile.id, status: profile.status };
      },
      // 测试只关心 employeeId / status，这里补齐 runs() 契约要求的字段。
      runs: () =>
        agentRuns.map((run, index) => ({
          instanceId: run.id,
          nodeId: "test",
          runSeq: index + 1,
          createdAt: new Date(0).toISOString(),
          ...run,
        })),
      agentProfiles,
    }),
  });
  return {
    teammates,
    templates,
    teammateTable,
    runtime,
    personas,
    employees,
    roles,
    roleAssignments,
    runtimes,
    agentProfiles,
    agentRuns,
    principalCompanionLinks,
    principalGrants,
    principalRuntime,
    agentActors,
  };
}

async function activeTeammate(
  teammates: TeammateService,
  source: "platform" | "personal",
): Promise<Teammate> {
  const actor = source === "platform" ? admin : olivia;
  const draft = await teammates.create(actor, { source, name: "测小白" });
  const updated = await teammates.update(actor, {
    teammateId: draft.id,
    name: "测小白",
    role: "测试",
    soul: "只做验证。",
  });
  // 新建实例默认生效，只有旧数据/显式改过状态时才需要补一次切换。
  return updated.state === "active"
    ? updated
    : teammates.changeState(actor, { teammateId: draft.id, state: "active" });
}

describe("teammate runtime provisioning", () => {
  it("creates a Principal Runtime without creating an Employee record", async () => {
    const { teammates, runtime, employees, principalRuntime, principalGrants } =
      setup();
    const teammate = await activeTeammate(teammates, "platform");
    const ensured = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
      employee: { displayName: "供应链计划员" },
    });
    expect(ensured.employeeId).toBeUndefined();
    expect(ensured.principalId).toBe(`principal-ai-${teammate.id}`);
    expect(employees.size).toBe(0);
    expect(teammates.get(teammate.id).principalId).toBe(ensured.principalId);
    expect(
      principalRuntime.profile(ensured.principalId!, "workspace-1"),
    ).toMatchObject({
      principalId: ensured.principalId,
      agentProfileId: ensured.profileId,
      status: "active",
    });
    expect(principalGrants).toContainEqual({
      id: "grant-1",
      principalId: ensured.principalId,
      scopeType: "workspace",
      scopeId: "workspace-1",
      role: "workspace-member",
      permissions: ["read", "write"],
      status: "active",
    });
  });

  it("only exposes active teammates that the actor may use", async () => {
    const { teammates, runtime } = setup();
    const platform = await activeTeammate(teammates, "platform");
    const personal = await activeTeammate(teammates, "personal");
    const draft = await teammates.create(admin, { source: "platform" });
    // 未生效的实例不可被派发：显式失效一个来覆盖这条。
    await teammates.changeState(admin, {
      teammateId: draft.id,
      state: "inactive",
    });
    expect(runtime.assignable(admin).map((item) => item.id)).toEqual([
      platform.id,
    ]);
    expect(runtime.assignable(admin)).toEqual([
      {
        id: platform.id,
        name: "测小白",
        ownerUserId: "admin",
        ownerName: "Admin",
        source: "platform",
        avatar: "",
      },
    ]);
    expect(
      runtime
        .assignable(olivia)
        .map((item) => item.id)
        .sort(),
    ).toEqual([platform.id, personal.id].sort());
    expect(runtime.assignable(admin).some((item) => item.id === draft.id)).toBe(
      false,
    );
    const otherPersonal = await teammates.create(
      { userId: "peter", name: "Peter", role: "member" },
      { source: "personal" },
    );
    await teammates.update(
      { userId: "peter", name: "Peter", role: "member" },
      { teammateId: otherPersonal.id, name: "Peter 分身" },
    );
    expect(
      runtime.assignable(olivia).some((item) => item.id === otherPersonal.id),
    ).toBe(false);
  });

  it("refuses to dispatch a teammate that is not active", async () => {
    const { teammates, runtime } = setup();
    const draft = await teammates.create(admin, { source: "platform" });
    // 新建默认生效，这里显式失效来覆盖「未生效不能派发」。
    await teammates.changeState(admin, {
      teammateId: draft.id,
      state: "inactive",
    });
    await expect(
      runtime.ensureRuntime({
        teammateId: draft.id,
        workspaceId: "workspace-1",
        actor: admin,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("blocks new dispatch when a template is disabled without pausing its instances", async () => {
    const { teammates, templates, runtime } = setup();
    const template = await templates.create(admin, {
      source: "platform",
      name: "Night Shift",
      role: "夜班执行",
    });
    const instance = await teammates.create(olivia, {
      templateId: template.id,
    });
    await templates.changeState(admin, {
      templateId: template.id,
      state: "disabled",
    });

    expect(teammates.get(instance.id).state).toBe("active");
    expect(
      runtime.assignable(olivia).some((item) => item.id === instance.id),
    ).toBe(false);
    await expect(
      runtime.ensureRuntime({
        teammateId: instance.id,
        workspaceId: "workspace-1",
        actor: olivia,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("provisions one runtime identity and reuses it for later tasks", async () => {
    const {
      teammates,
      runtime,
      personas,
      employees,
      agentProfiles,
      principalRuntime,
    } = setup();
    const platform = await activeTeammate(teammates, "platform");
    const ensured = await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(ensured.employeeId).toBeUndefined();
    expect(ensured.principalId).toBe(`principal-ai-${platform.id}`);
    expect(ensured.profileId).toBe("agent-1");
    expect(personas.has(`persona-${platform.id}`)).toBe(true);
    expect(agentProfiles).toHaveLength(1);
    expect(agentProfiles[0]?.visibility).toBe("platform");
    expect(employees.size).toBe(0);
    expect(
      principalRuntime.profiles({ principalId: ensured.principalId! }),
    ).toHaveLength(1);
    expect(teammates.get(platform.id).principalId).toBe(ensured.principalId);

    const again = await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(again).toEqual(ensured);
    expect(agentProfiles).toHaveLength(1);
    expect(employees.size).toBe(0);
    expect(
      principalRuntime.profiles({ principalId: ensured.principalId! }),
    ).toHaveLength(1);
  });

  it("reuses the same AI Principal when a second project needs a runtime", async () => {
    const { teammates, runtime, employees, principalRuntime, principalGrants } =
      setup();
    const platform = await activeTeammate(teammates, "platform");
    const first = await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(first.employeeId).toBeUndefined();

    // 第二个项目：只补「授权 + Runtime Profile」，复用同一个 AI Principal。
    const second = await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-2",
      actor: admin,
    });
    expect(second.employeeId).toBe(first.employeeId);
    expect(second.principalId).toBe(first.principalId);
    expect(employees.size).toBe(0);
    expect(teammates.get(platform.id).principalId).toBe(first.principalId);
    expect(principalGrants.map((grant) => grant.scopeId).sort()).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
    const projectProfiles = principalRuntime.profiles({
      principalId: first.principalId!,
    });
    expect(projectProfiles.map((item) => item.workspaceId).sort()).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
    expect(projectProfiles.every((item) => item.agentProfileId !== "")).toBe(
      true,
    );
  });

  it("folds scenarios/goals into the persona SOUL and maps tools to allowedTools", async () => {
    const {
      teammates,
      templates,
      runtime,
      personas,
      principalRuntime,
      agentProfiles,
    } = setup();
    const template = await templates.create(admin, {
      source: "platform",
      name: "小红 QA",
      role: "测试工程师",
      soul: "你是 QA。",
      scenarios: ["补充第一个工作场景", "回归确认修复"],
      goals: ["补充第一个明确目标"],
      tools: ["read", "write"],
    });
    const instance = await teammates.create(admin, {
      templateId: template.id,
    });
    const ensured = await runtime.ensureRuntime({
      teammateId: instance.id,
      workspaceId: "workspace-1",
      actor: admin,
    });

    const persona = personas.get(ensured.personaId ?? "") as {
      readonly soul: string;
    };
    expect(persona.soul).toContain("你是 QA。");
    expect(persona.soul).toContain(
      "## 工作场景\n- 补充第一个工作场景\n- 回归确认修复",
    );
    expect(persona.soul).toContain("## 工作目标\n- 补充第一个明确目标");

    // 工具：Principal Runtime 与 Agent Profile 均保留裸工具名。
    expect(agentProfiles[0]?.allowedTools).toEqual(["read", "write"]);
    expect(
      principalRuntime.profile(ensured.principalId!, "workspace-1")
        ?.allowedTools,
    ).toEqual(["read", "write"]);
  });

  it("re-syncs persona and tools when the template changes", async () => {
    const {
      teammates,
      templates,
      runtime,
      personas,
      principalRuntime,
      agentProfiles,
    } = setup();
    const template = await templates.create(admin, {
      source: "platform",
      name: "小红 QA",
      role: "测试工程师",
      soul: "你是 QA。",
      tools: ["read"],
    });
    const instance = await teammates.create(admin, {
      templateId: template.id,
    });
    await runtime.ensureRuntime({
      teammateId: instance.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(agentProfiles[0]?.allowedTools).toEqual(["read"]);

    await templates.update(admin, {
      templateId: template.id,
      name: "小红 QA",
      tools: ["bash"],
      scenarios: ["按新场景执行"],
    });
    const again = await runtime.ensureRuntime({
      teammateId: instance.id,
      workspaceId: "workspace-1",
      actor: admin,
    });

    const persona = personas.get(again.personaId ?? "") as {
      readonly soul: string;
    };
    expect(persona.soul).toContain("## 工作场景\n- 按新场景执行");
    expect(agentProfiles[0]?.allowedTools).toEqual(["bash"]);
    expect(
      principalRuntime.profile(again.principalId!, "workspace-1")?.allowedTools,
    ).toEqual(["bash"]);
  });

  it("records the owner when provisioning a personal AI Principal", async () => {
    const { teammates, runtime, principalRuntime } = setup();
    const personal = await activeTeammate(teammates, "personal");
    const ensured = await runtime.ensureRuntime({
      teammateId: personal.id,
      workspaceId: "workspace-1",
      actor: olivia,
    });
    expect(
      principalRuntime.profile(ensured.principalId!, "workspace-1")
        ?.createdByUserId,
    ).toBe("olivia");
  });

  it("uses workspace membership authority instead of the platform role", async () => {
    const { teammates, runtime, agentActors } = setup();
    const personal = await activeTeammate(teammates, "personal");
    await runtime.ensureRuntime({
      teammateId: personal.id,
      workspaceId: "workspace-1",
      actor: olivia,
      workspaceRole: "owner",
    });
    expect(agentActors[0]).toMatchObject({
      id: "olivia",
      workspaceRole: "owner",
      workspaceId: "workspace-1",
    });
    expect(agentActors[0]?.globalRole).toBeUndefined();
  });

  it("syncs an existing execution identity when the teammate channel changes", async () => {
    const { teammates, runtime, agentProfiles } = setup();
    const platform = await activeTeammate(teammates, "platform");
    await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    await teammates.update(admin, {
      teammateId: platform.id,
      name: "测小白",
      role: "测试",
      execution: "external",
      externalRuntimeId: "runtime-new",
    });
    const ensured = await runtime.ensureRuntime({
      teammateId: platform.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(ensured.profileId).toBe("agent-1");
    expect(agentProfiles[0]).toMatchObject({
      execution: "external",
      externalRuntimeId: "runtime-new",
    });
  });

  it("migrates a legacy Employee runtime to the Principal path", async () => {
    const {
      teammates,
      runtime,
      employees,
      runtimes,
      agentProfiles,
      principalRuntime,
    } = setup();
    const teammate = await activeTeammate(teammates, "platform");
    employees.set("legacy-digital", {
      id: "legacy-digital",
      kind: "digital",
      status: "active",
      displayName: "Legacy Worker",
      department: "",
      title: "Worker",
      tags: [],
      managerEmployeeId: "human-admin",
      personaId: "persona-legacy",
    });
    await teammates.bindEmployee(admin, teammate.id, "legacy-digital");
    agentProfiles.push({
      id: "agent-legacy-principal",
      status: "active",
      personaId: "persona-legacy",
      visibility: "platform",
      allowedTools: ["read", "write"],
    });
    runtimes.push({
      id: "runtime-legacy",
      employeeId: "legacy-digital",
      workspaceId: "workspace-1",
      name: "Legacy Worker",
      status: "active",
      createdBy: "human-admin",
      legacyAgentProfileId: "agent-legacy-principal",
    });

    const report = await runtime.migrateEmployeeIdentities();
    expect(report).toMatchObject({
      scanned: 1,
      migrated: 1,
      failed: 0,
    });
    const migrated = teammates.get(teammate.id);
    expect(migrated.employeeId).toBe("legacy-digital");
    expect(migrated.principalId).toBe("principal-ai-legacy-digital");
    expect(
      principalRuntime.profile(migrated.principalId!, "workspace-1"),
    ).toMatchObject({
      agentProfileId: "agent-legacy-principal",
      allowedTools: ["read", "write"],
    });

    const ensured = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(ensured).toMatchObject({
      principalId: "principal-ai-legacy-digital",
      profileId: "agent-legacy-principal",
    });
    expect(ensured.employeeId).toBeUndefined();
    const secondWorkspace = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-2",
      actor: admin,
    });
    expect(secondWorkspace).toMatchObject({
      principalId: "principal-ai-legacy-digital",
      profileId: expect.any(String),
    });
    expect(secondWorkspace.employeeId).toBeUndefined();
    expect(await runtime.migrateEmployeeIdentities()).toMatchObject({
      scanned: 1,
      alreadyMigrated: 1,
    });
  });
});

describe("teammate live instance counts", () => {
  it("counts only active identity chains and deduplicates workspaces", async () => {
    const { teammates, runtime, principalRuntime, agentProfiles } = setup();
    const active = await activeTeammate(teammates, "platform");
    const inactiveEmployee = await activeTeammate(teammates, "platform");
    const inactiveRuntime = await activeTeammate(teammates, "platform");
    const inactiveAgent = await activeTeammate(teammates, "platform");
    const duplicated = await activeTeammate(teammates, "platform");
    for (const teammate of [
      active,
      inactiveEmployee,
      inactiveRuntime,
      inactiveAgent,
      duplicated,
    ]) {
      await runtime.ensureRuntime({
        teammateId: teammate.id,
        workspaceId: `workspace-${teammate.id}`,
        actor: admin,
      });
    }

    const teammateIds = {
      active: active.id,
      inactiveEmployee: inactiveEmployee.id,
      inactiveRuntime: inactiveRuntime.id,
      inactiveAgent: inactiveAgent.id,
      duplicated: duplicated.id,
    };
    const runtimeFor = (teammateId: string) =>
      principalRuntime.profiles({
        principalId: `principal-ai-${teammateId}`,
      })[0];
    const inactiveEmployeeRuntime = runtimeFor(teammateIds.inactiveEmployee);
    const inactiveRuntimeProfile = runtimeFor(teammateIds.inactiveRuntime);
    const duplicatedRuntime = runtimeFor(teammateIds.duplicated);
    if (
      inactiveEmployeeRuntime === undefined ||
      inactiveRuntimeProfile === undefined ||
      duplicatedRuntime === undefined
    ) {
      throw new Error("runtime profile not created");
    }
    const inactiveAgentProfile = agentProfiles.find(
      (profile) => profile.id === inactiveEmployeeRuntime.agentProfileId,
    );
    if (inactiveAgentProfile === undefined) {
      throw new Error("agent profile not created");
    }
    inactiveAgentProfile.status = "disabled";
    await principalRuntime.setProfileStatus(
      inactiveRuntimeProfile.id,
      "disabled",
    );
    await teammates.changeState(admin, {
      teammateId: inactiveAgent.id,
      state: "paused",
    });
    agentProfiles.push({
      id: "agent-duplicate",
      status: "active",
      allowedTools: [],
      visibility: "platform",
    });
    await principalRuntime.ensureProfile({
      principalId: `principal-ai-${teammateIds.duplicated}`,
      workspaceId: "workspace-duplicate-2",
      name: "duplicate runtime",
      agentProfileId: "agent-duplicate",
      execution: "builtin",
      allowedTools: [],
      createdByUserId: "admin",
    });

    const counts = await runtime.liveInstanceCounts("admin");
    expect(counts.get(teammateIds.active)).toEqual({
      liveCount: 1,
      ownCount: 1,
    });
    expect(counts.get(teammateIds.inactiveEmployee)).toEqual({
      liveCount: 0,
      ownCount: 0,
    });
    expect(counts.get(teammateIds.inactiveRuntime)).toEqual({
      liveCount: 0,
      ownCount: 0,
    });
    expect(counts.get(teammateIds.inactiveAgent)).toEqual({
      liveCount: 0,
      ownCount: 0,
    });
    expect(counts.get(teammateIds.duplicated)).toEqual({
      liveCount: 2,
      ownCount: 2,
    });
  });

  it("does not count profiles owned by another account", async () => {
    const { teammates, runtime, principalRuntime } = setup();
    const teammate = await activeTeammate(teammates, "platform");
    await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    const profile = principalRuntime.profiles()[0];
    if (profile === undefined) throw new Error("runtime not created");
    (profile as { createdByUserId: string }).createdByUserId = "human-olivia";
    const counts = await runtime.liveInstanceCounts("admin");
    expect(counts.get(teammate.id)).toEqual({ liveCount: 1, ownCount: 0 });
  });

  it("reports a teammate unavailable when its workspace Agent Profile is disabled", async () => {
    const { teammates, runtime, agentProfiles } = setup();
    const teammate = await activeTeammate(teammates, "platform");
    const ensured = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(runtime.availabilityOf(teammate.id, "workspace-1")).toEqual({
      available: true,
    });
    const profile = agentProfiles.find(
      (candidate) => candidate.id === ensured.profileId,
    );
    if (profile === undefined) throw new Error("agent profile not created");
    profile.status = "disabled";
    expect(runtime.availabilityOf(teammate.id, "workspace-1")).toEqual({
      available: false,
      reason: "Agent Profile 已停用",
    });
    await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    expect(profile.status, "生效实例派发前应自动修复停用的执行身份").toBe(
      "active",
    );
    expect(runtime.availabilityOf(teammate.id, "workspace-1")).toEqual({
      available: true,
    });
  });

  it("archives an idle instance and transfers open tasks to its owner", async () => {
    const { teammates, runtime, principalRuntime, agentProfiles, employees } =
      setup();
    const teammate = await activeTeammate(teammates, "platform");
    const ensured = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    const tasks = [
      {
        id: "task-open",
        status: "progress",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: undefined,
        messages: [{ runId: "run-1", state: "succeeded" }],
      },
      {
        id: "task-done",
        status: "done",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: undefined,
        messages: [],
      },
      {
        id: "task-archived",
        status: "progress",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: "2026-01-01T00:00:00.000Z",
        messages: [],
      },
    ] as const;
    const assigned: string[] = [];

    const result = await runtime.archiveInstance({
      teammateId: teammate.id,
      actor: admin,
      tasks,
      ownerName: "Admin",
      assignTask: async (input) => {
        assigned.push(input.taskId);
      },
    });

    expect(result.transferredTaskIds).toEqual(["task-open"]);
    expect(assigned).toEqual(["task-open"]);
    expect(teammates.get(teammate.id).state).toBe("archived");
    expect(agentProfiles[0]?.status).toBe("disabled");
    expect(
      principalRuntime.profiles({ principalId: ensured.principalId! })[0]
        ?.status,
    ).toBe("disabled");
    expect(employees.size).toBe(0);
  });

  it("lets an instance owner leave a project and transfers open tasks", async () => {
    const { teammates, runtime, principalGrants } = setup();
    const teammate = await activeTeammate(teammates, "personal");
    await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: olivia,
    });
    await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-2",
      actor: olivia,
    });
    const tasks = [
      {
        id: "task-open",
        workspaceId: "workspace-1",
        status: "progress",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: undefined,
      },
      {
        id: "task-done",
        workspaceId: "workspace-1",
        status: "done",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: undefined,
      },
      {
        id: "task-other-project",
        workspaceId: "workspace-2",
        status: "progress",
        receiverType: "agent",
        receiverId: teammate.id,
        archivedAt: undefined,
      },
    ] as const;
    const assigned: Array<{ taskId: string; receiverId: string }> = [];

    const result = await runtime.leaveWorkspace({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: olivia,
      canManageWorkspace: false,
      reassignTo: { id: "olivia", name: "Olivia" },
      tasks,
      assignTask: async (input) => {
        assigned.push({ taskId: input.taskId, receiverId: input.receiverId });
      },
    });

    // 只撤销目标项目的授权，其他项目不受影响。
    expect(result.revokedAssignments).toEqual([
      { id: "grant-1", role: "workspace-member" },
    ]);
    expect(principalGrants.map((item) => item.status)).toEqual([
      "revoked",
      "active",
    ]);
    // 未完成任务改派给 owner，已完成/其他项目不动。
    expect(result.reassignedTaskIds).toEqual(["task-open"]);
    expect(assigned).toEqual([{ taskId: "task-open", receiverId: "olivia" }]);
    expect(result.receiver).toEqual({ id: "olivia", name: "Olivia" });
  });

  it("guards project role exits by instance owner or project owner", async () => {
    const { teammates, runtime, principalGrants } = setup();
    const teammate = await activeTeammate(teammates, "personal");
    await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: olivia,
    });
    principalGrants.push({
      id: "grant-2",
      principalId: `principal-ai-${teammate.id}`,
      scopeType: "workspace",
      scopeId: "workspace-1",
      role: "viewer",
      permissions: ["read"],
      status: "active",
    });

    const outsider = {
      userId: "peter",
      name: "Peter",
      role: "member" as const,
    };
    // 既不是实例 owner 也不是项目 owner：拒绝。
    await expect(
      runtime.leaveWorkspace({
        teammateId: teammate.id,
        workspaceId: "workspace-1",
        actor: outsider,
        canManageWorkspace: false,
        assignmentId: "grant-1",
        tasks: [],
        assignTask: async () => {
          throw new Error("should not reassign");
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // 项目 owner（canManageWorkspace）即使不是实例 owner 也可以操作。
    const result = await runtime.leaveWorkspace({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: outsider,
      canManageWorkspace: true,
      assignmentId: "grant-2",
      tasks: [
        {
          id: "task-open",
          workspaceId: "workspace-1",
          status: "progress",
          receiverType: "agent",
          receiverId: teammate.id,
          archivedAt: undefined,
        },
      ],
      assignTask: async () => {
        throw new Error("should not reassign");
      },
    });
    expect(result.revokedAssignments).toEqual([
      { id: "grant-2", role: "viewer" },
    ]);
    expect(result.reassignedTaskIds).toEqual([]);
    expect(principalGrants[0]?.status).toBe("active");

    // 已无可退出授权时报 not_found，避免静默成功。
    await expect(
      runtime.leaveWorkspace({
        teammateId: teammate.id,
        workspaceId: "workspace-1",
        actor: olivia,
        canManageWorkspace: false,
        assignmentId: "role-2",
        tasks: [],
        assignTask: async () => {
          throw new Error("should not reassign");
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets an instance owner archive a platform-sourced instance", async () => {
    const { runtime, teammateTable } = setup();
    const at = new Date(0).toISOString();
    await teammateTable.put("tm-imported", {
      id: "tm-imported",
      source: "platform",
      name: "导入的实例",
      role: "测试",
      ownerUserId: "olivia",
      ownerName: "Olivia",
      description: "",
      soul: "",
      scenarios: [],
      goals: [],
      avatar: "",
      state: "active",
      version: "v1.0",
      createdBy: "olivia",
      createdAt: at,
      updatedAt: at,
    });
    const result = await runtime.archiveInstance({
      teammateId: "tm-imported",
      actor: olivia,
      tasks: [],
      ownerName: "Olivia",
      assignTask: async () => {
        throw new Error("should not transfer");
      },
    });
    expect(result.teammate.state).toBe("archived");
    // 非 owner 的普通成员依旧不能归档。
    const outsider = {
      userId: "peter",
      name: "Peter",
      role: "member" as const,
    };
    await teammateTable.put("tm-other", {
      ...result.teammate,
      id: "tm-other",
      name: "别人的实例",
      state: "active",
    });
    await expect(
      runtime.archiveInstance({
        teammateId: "tm-other",
        actor: outsider,
        tasks: [],
        ownerName: "Peter",
        assignTask: async () => {
          throw new Error("should not transfer");
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses to archive an instance with an active run", async () => {
    const { teammates, runtime, agentRuns } = setup();
    const teammate = await activeTeammate(teammates, "platform");
    const ensured = await runtime.ensureRuntime({
      teammateId: teammate.id,
      workspaceId: "workspace-1",
      actor: admin,
    });
    agentRuns.push({
      id: "run-active",
      principalId: ensured.principalId,
      status: "running",
    });

    await expect(
      runtime.archiveInstance({
        teammateId: teammate.id,
        actor: admin,
        tasks: [],
        ownerName: "Admin",
        assignTask: async () => {
          throw new Error("should not transfer");
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(teammates.get(teammate.id).state).toBe("active");
  });
});

describe("task running state", () => {
  it("only reports running while the latest run is still active", () => {
    expect(
      isTaskRunning({
        messages: [
          { content: "已接收指令，正在执行…", runId: "r1", state: "running" },
          { content: "运行超时，已中止", runId: "r1", state: "timeout" },
        ],
      }),
    ).toBe(false);
    expect(
      isTaskRunning({
        messages: [
          { content: "上一轮完成", runId: "r1", state: "succeeded" },
          { content: "新一轮已接收", runId: "r2", state: "queued" },
        ],
      }),
    ).toBe(true);
    expect(
      isTaskRunning({
        messages: [{ content: "只是讨论", state: "failed" }],
      }),
    ).toBe(false);
    expect(isTaskRunning({ messages: [] })).toBe(false);
    expect(isTaskRunning({})).toBe(false);
  });

  it("marks teammates that own at least one running task", () => {
    expect(
      runningTeammateIds({
        teammates: [
          { id: "tm-1" },
          { id: "tm-2" },
          { id: "tm-3", employeeId: "digital-9" },
        ],
        tasks: [
          {
            receiverType: "agent",
            receiverId: "tm-1",
            messages: [
              {
                content: "已接收指令，正在执行…",
                runId: "r1",
                state: "running",
              },
            ],
          },
          {
            receiverType: "agent",
            receiverId: "tm-2",
            messages: [
              { content: "运行超时，已中止", runId: "r2", state: "cancelled" },
            ],
          },
          {
            receiverType: "agent",
            receiverId: "digital-9",
            messages: [{ content: "排队中", runId: "r3", state: "queued" }],
          },
          {
            receiverType: "human",
            receiverId: "tm-1",
            messages: [{ content: "人类任务", runId: "r4", state: "running" }],
          },
        ],
      }),
    ).toEqual(["tm-1", "tm-3"]);
  });
});
