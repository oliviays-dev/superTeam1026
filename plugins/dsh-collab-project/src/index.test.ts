import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  apply,
  buildProjectReportContent,
  createProjectRoutes,
  inject,
  ProjectError,
  ProjectService,
  projectDomainSpec,
  type ProjectAuditRecord,
  type ProjectRecord,
  type ProjectReportRecord,
  type ProjectRoleRecord,
  type ProjectTemplateRecord,
} from "./index.ts";
import type { KvTableLike } from "./service.ts";

class FakeTable<V> implements KvTableLike<V> {
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

  json(): Record<string, any> {
    return JSON.parse(this.body) as Record<string, any>;
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

type Route = ReturnType<typeof createProjectRoutes>[number];

function findRoute(routes: readonly Route[], path: string): Route {
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`route not found: ${path}`);
  return route;
}

async function call(route: Route, request: unknown): Promise<FakeResponse> {
  const response = new FakeResponse();
  await route.handler(request as never, response as unknown as ServerResponse);
  return response;
}

interface Seat {
  readonly id: string;
  readonly label: string;
  readonly participantKind: string;
  readonly permissions: readonly string[];
}

interface Assignment {
  id: string;
  workspaceId: string;
  seatId: string;
  seatLabel: string;
  assigneeKind: "user" | "agent";
  assigneeId: string;
  status: "assigned" | "released";
  permissions: readonly string[];
}

/** 最小角色指派服务：语义与 dsh-collab-roles 的席位集合一致。 */
class FakeAssignments {
  private sequence = 0;
  private readonly configs = new Map<
    string,
    { workspaceId: string; typeId: string; typeName: string; seats: Seat[] }
  >();
  private readonly assignments: Assignment[] = [];

  config(workspaceId: string) {
    const config = this.configs.get(workspaceId);
    if (config === undefined)
      throw new Error("workspace roles not materialized");
    return config;
  }

  async materialize(
    _actor: unknown,
    workspaceId: string,
    type: {
      id: string;
      name: string;
      seats: readonly Seat[];
    },
  ) {
    const seats = type.seats.map((seat) => ({ ...seat }));
    this.configs.set(workspaceId, {
      workspaceId,
      typeId: type.id,
      typeName: type.name,
      seats,
    });
    const seatIds = new Set(seats.map((seat) => seat.id));
    for (let index = this.assignments.length - 1; index >= 0; index -= 1) {
      const assignment = this.assignments[index];
      if (
        assignment?.workspaceId === workspaceId &&
        !seatIds.has(assignment.seatId)
      ) {
        this.assignments.splice(index, 1);
      }
    }
    const config = this.configs.get(workspaceId);
    if (config === undefined) throw new Error("materialize failed");
    return config;
  }

  seats(workspaceId: string) {
    // 与 dsh-collab-roles 一致：工作区未物化角色时读取席位会抛 not_found。
    this.config(workspaceId);
    return this.assignments
      .filter((assignment) => assignment.workspaceId === workspaceId)
      .map((assignment) => ({ ...assignment }));
  }

  async assign(
    _actor: unknown,
    input: {
      workspaceId: string;
      seatId: string;
      assigneeKind: "user" | "agent";
      assigneeId: string;
    },
  ) {
    const config = this.config(input.workspaceId);
    const seat = config.seats.find(
      (candidate) => candidate.id === input.seatId,
    );
    if (seat === undefined) throw new Error("role seat not found");
    const existing = this.assignments.find(
      (assignment) =>
        assignment.workspaceId === input.workspaceId &&
        assignment.seatId === input.seatId &&
        assignment.assigneeKind === input.assigneeKind &&
        assignment.assigneeId === input.assigneeId &&
        assignment.status === "assigned",
    );
    if (existing !== undefined) return existing;
    this.sequence += 1;
    const assignment: Assignment = {
      id: `assignment-${this.sequence}`,
      workspaceId: input.workspaceId,
      seatId: seat.id,
      seatLabel: seat.label,
      assigneeKind: input.assigneeKind,
      assigneeId: input.assigneeId,
      status: "assigned",
      permissions: seat.permissions,
    };
    this.assignments.push(assignment);
    return assignment;
  }

  async release(
    _actor: unknown,
    workspaceId: string,
    seatId: string,
    target: { assigneeKind: "user" | "agent"; assigneeId: string },
  ) {
    const assignment = this.assignments.find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.seatId === seatId &&
        candidate.assigneeKind === target.assigneeKind &&
        candidate.assigneeId === target.assigneeId &&
        candidate.status === "assigned",
    );
    if (assignment === undefined) throw new Error("active role seat not found");
    assignment.status = "released";
    return assignment;
  }
}

interface HarnessOptions {
  /** 追加一个有成员、但还没有物化项目角色的工作区，用于覆盖降级读路径。 */
  readonly extraWorkspace?: boolean;
  /** 追加一个引用 role-owner 的已启用工作流模版，用于覆盖角色下线阻塞。 */
  readonly roleWorkflow?: boolean;
  /** 为项目产出物聚合测试提供任务文档和工作流提交。 */
  readonly outputs?: boolean;
  /** 追加一个与 TSK-1 产出同名、同大小、同日期但来源不同的任务。 */
  readonly outputCollision?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-10-16T02:00:00.000Z");
  const tables = {
    projects: new FakeTable<ProjectRecord>(),
    templates: new FakeTable<ProjectTemplateRecord>(),
    roles: new FakeTable<ProjectRoleRecord>(),
    reports: new FakeTable<ProjectReportRecord>(),
    audit: new FakeTable<ProjectAuditRecord>(),
  };
  const service = new ProjectService(tables, { now: () => now });
  const workspace = {
    id: "ws-1",
    title: "一切皆插件",
    path: "/tmp/ws-1",
    async setTitle(title: string) {
      workspace.title = title;
    },
  };
  const members: Array<{
    userId: string;
    name: string;
    memberRole: "owner" | "member" | "guest";
    addedAt?: string;
  }> = [
    {
      userId: "olivia",
      name: "Olivia",
      memberRole: "owner",
      addedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      userId: "peter",
      name: "Peter",
      memberRole: "member",
      addedAt: "2026-10-02T00:00:00.000Z",
    },
  ];
  const users = [
    { id: "olivia", name: "Olivia", role: "admin" },
    { id: "peter", name: "Peter", role: "member" },
    { id: "mia", name: "Mia", role: "member" },
  ];
  const addedMembers: Array<{ userId: string; role: string }> = [];
  const identityAudit: Array<{
    id: string;
    at: string;
    actorId: string;
    actorRole: string;
    action: string;
    targetId?: string;
    workspaceId?: string;
    detail: Record<string, string>;
  }> = [];
  const taskMarks: Array<{
    roles: Map<string, string>;
    skip: string[];
  }> = [];
  const team = {
    resolveToken: (token: string) => {
      if (token === "admin-token")
        return { userId: "olivia", role: "admin" as const };
      if (token === "owner-token")
        return { userId: "peter", role: "member" as const };
      if (token === "member-token")
        return { userId: "mia", role: "member" as const };
      return undefined;
    },
    users: () => users,
    members: (workspaceId: string) => (workspaceId === "ws-2" ? [] : members),
    async addMember(
      _actorId: string,
      input: {
        workspaceId: string;
        userId: string;
        role: "owner" | "member" | "guest";
      },
    ) {
      addedMembers.push({ userId: input.userId, role: input.role });
      const next = {
        userId: input.userId,
        name: input.userId,
        memberRole: input.role,
        addedAt: now.toISOString(),
      };
      const existing = members.findIndex(
        (member) => member.userId === input.userId,
      );
      if (existing < 0) members.push(next);
      else members[existing] = next;
      return members;
    },
    async removeMember(
      _actorId: string,
      input: { workspaceId: string; userId: string },
    ) {
      const index = members.findIndex(
        (member) => member.userId === input.userId,
      );
      if (index >= 0) members.splice(index, 1);
      return members;
    },
    async leaveWorkspace(_actorId: string, workspaceId: string) {
      if (workspaceId !== "ws-1") return [];
      const index = members.findIndex((member) => member.userId === "peter");
      if (index >= 0) members.splice(index, 1);
      return members;
    },
    audit: () => identityAudit,
  };
  const workspaces = {
    get: (id: string) =>
      id === workspace.id
        ? workspace
        : options.extraWorkspace === true && id === "ws-2"
          ? {
              id: "ws-2",
              title: "员工平台",
              path: "/tmp/ws-2",
            }
          : undefined,
    list: () =>
      options.extraWorkspace === true
        ? [workspace, { id: "ws-2", title: "员工平台", path: "/tmp/ws-2" }]
        : [workspace],
    create: async (path: string, title?: string) => ({
      id: "ws-2",
      title: title ?? path,
      path,
      setTitle: async () => undefined,
    }),
  };
  const assignments = new FakeAssignments();
  assignments.materialize(null, "ws-1", {
    id: "tpl-plugin-dev",
    name: "插件 / 平台研发",
    seats: [
      {
        id: "role-owner",
        label: "项目负责人",
        participantKind: "any",
        permissions: ["read", "write", "approve"],
      },
      {
        id: "role-dev",
        label: "开发实施",
        participantKind: "any",
        permissions: ["read", "write"],
      },
    ],
  });
  const tasks = [
    {
      id: "TSK-1",
      title: "补全项目视角",
      status: "progress",
      priority: "P1",
      receiverType: "human",
      receiverName: "Peter",
      due: "2026-10-10",
      createdAt: "2026-10-16T01:00:00.000Z",
      updatedAt: "2026-10-16T01:30:00.000Z",
      workspaceId: "ws-1",
      workflow: {
        instanceId: "wf-1",
        instanceTitle: "GUI 回归",
        nodeId: "design",
        nodeName: "设计",
      },
    },
    {
      id: "TSK-0",
      title: "历史归档任务",
      status: "done",
      priority: "P3",
      receiverType: "unassigned",
      archivedAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      workspaceId: "ws-1",
    },
    ...(options.outputCollision === true
      ? [
          {
            id: "TSK-2",
            title: "补全运营视角",
            status: "progress",
            priority: "P1",
            receiverType: "human" as const,
            receiverName: "Mia",
            due: "2026-10-10",
            createdAt: "2026-10-16T01:00:00.000Z",
            updatedAt: "2026-10-16T01:30:00.000Z",
            workspaceId: "ws-1",
          },
        ]
      : []),
  ];
  const workflows = [
    {
      id: "wf-1",
      definitionId: "definition-1",
      definitionKey: "gui-from-zero",
      definitionVersion: 1,
      title: "GUI 回归",
      status: "blocked",
      updatedAt: "2026-10-15T08:00:00.000Z",
      workspaceId: "ws-1",
    },
  ];
  const taskDocuments =
    options.outputs === true
      ? {
          async list(taskId: string) {
            return taskId === "TSK-1" ||
              (options.outputCollision === true && taskId === "TSK-2")
              ? {
                  workspaceReady: true,
                  documents: [
                    {
                      id: "produced:deliverables/design.md",
                      kind: "produced" as const,
                      name: "design.md",
                      relativePath: "deliverables/design.md",
                      size: 2_048,
                      mimeType: "text/markdown; charset=utf-8",
                      updatedBy: "Research Avatar",
                      updatedAt: "2026-10-16T01:10:00.000Z",
                      available: true,
                    },
                    {
                      id: "uploaded:input.pdf",
                      kind: "uploaded" as const,
                      name: "input.pdf",
                      relativePath: "input.pdf",
                      size: 1_024,
                      mimeType: "application/pdf",
                      updatedBy: "Peter",
                      updatedAt: "2026-10-15T01:10:00.000Z",
                      available: true,
                    },
                  ],
                }
              : { workspaceReady: true, documents: [] };
          },
        }
      : undefined;
  const submissions =
    options.outputs === true
      ? [
          {
            id: "submission-old",
            instanceId: "wf-1",
            nodeId: "review",
            requirementKey: "review-report",
            requirementTitle: "评审报告",
            type: "file" as const,
            artifacts: [
              {
                id: "artifact-old",
                fileName: "review-old.pdf",
                mimeType: "application/pdf",
                size: 2_000,
              },
            ],
            submittedByName: "Olivia",
            submittedAt: "2026-10-15T07:00:00.000Z",
            status: "submitted" as const,
          },
          {
            id: "submission-new",
            instanceId: "wf-1",
            nodeId: "review",
            requirementKey: "review-report",
            requirementTitle: "评审报告",
            type: "file" as const,
            artifacts: [
              {
                id: "artifact-new",
                fileName: "review-final.pdf",
                mimeType: "application/pdf",
                size: 3_000,
              },
            ],
            submittedByName: "Olivia",
            submittedAt: "2026-10-16T02:00:00.000Z",
            status: "submitted" as const,
          },
          {
            id: "submission-rejected",
            instanceId: "wf-1",
            nodeId: "review",
            requirementKey: "review-report",
            requirementTitle: "评审报告",
            type: "file" as const,
            artifacts: [
              {
                id: "artifact-rejected",
                fileName: "review-rejected.pdf",
                mimeType: "application/pdf",
                size: 1_000,
              },
            ],
            submittedByName: "Olivia",
            submittedAt: "2026-10-16T03:00:00.000Z",
            status: "rejected" as const,
          },
        ]
      : [];
  const teammates = {
    assignable: () => [
      {
        id: "teammate-1",
        name: "Research Avatar",
        ownerUserId: "olivia",
        ownerName: "Olivia",
        source: "personal" as const,
        avatar: "",
      },
      {
        id: "teammate-2",
        name: "小白PD",
        ownerUserId: "olivia",
        ownerName: "Olivia",
        source: "personal" as const,
        avatar: "",
      },
    ],
  };
  const principals = {
    resolveReference(reference: string) {
      const value = reference.startsWith("principal:")
        ? reference.slice("principal:".length)
        : reference.includes(":")
          ? ""
          : `principal-human-${reference}`;
      if (value === "") return undefined;
      const user = users.find(
        (candidate) => `principal-human-${candidate.id}` === value,
      );
      if (user !== undefined) {
        return {
          id: value,
          kind: "human" as const,
          displayName: user.name,
          status: "active" as const,
        };
      }
      const teammate = teammates
        .assignable()
        .find((candidate) => `principal-ai-${candidate.id}` === value);
      return teammate === undefined
        ? undefined
        : {
            id: value,
            kind: "ai" as const,
            displayName: teammate.name,
            status: "active" as const,
          };
    },
    resolveSubject(
      subjectType: "auth-user" | "employee" | "teammate",
      subjectId: string,
    ) {
      if (subjectType === "auth-user") {
        return this.resolveReference(`principal:principal-human-${subjectId}`);
      }
      if (subjectType === "teammate") {
        return this.resolveReference(`principal:principal-ai-${subjectId}`);
      }
      return undefined;
    },
    bindings(principalId: string) {
      if (principalId.startsWith("principal-human-")) {
        return [
          {
            subjectType: "auth-user" as const,
            subjectId: principalId.slice("principal-human-".length),
          },
        ];
      }
      if (principalId.startsWith("principal-ai-")) {
        return [
          {
            subjectType: "teammate" as const,
            subjectId: principalId.slice("principal-ai-".length),
          },
        ];
      }
      return [];
    },
    preferredSubjectId(
      principalId: string,
      subjectTypes: readonly ("auth-user" | "employee" | "teammate" | "hrm")[],
    ) {
      return this.bindings(principalId).find((binding) =>
        subjectTypes.includes(binding.subjectType),
      )?.subjectId;
    },
    syncExclusiveGrant: async () => undefined,
    revokeMatchingGrants: async () => undefined,
  };
  const routes = createProjectRoutes(service, {
    team,
    workspaces,
    assignments: () => assignments,
    employees: () => undefined,
    teammates: () => teammates,
    tasks: () => ({
      list: (workspaceId: string) => (workspaceId === "ws-2" ? [] : tasks),
      markRoleUnavailable: async (
        _workspaceId: string,
        roles: ReadonlyMap<string, string>,
        skip?: ReadonlySet<string>,
      ) => {
        taskMarks.push({ roles: new Map(roles), skip: [...(skip ?? [])] });
        return 0;
      },
    }),
    taskDocuments: () => taskDocuments,
    workflows: () => ({
      instances: (workspaceId: string) =>
        workspaceId === "ws-2" ? [] : workflows,
      submissions: (instanceId: string) =>
        instanceId === "wf-1" ? submissions : [],
      sharedDefinitions: () => [
        {
          id: "definition-1",
          key: "gui-from-zero",
          version: 1,
          name: "GUI 回归",
          description: "",
          status: "active",
          workspaceId: "ws-1",
          graph: {
            nodes: [
              {
                id: "design",
                name: "设计",
                executor: { kind: "user", id: "olivia" },
                approvers: [],
              },
              {
                id: "review",
                name: "评审",
                executor: { kind: "user", id: "olivia" },
                approvers: [],
              },
            ],
          },
        },
        ...(options.roleWorkflow === true
          ? [
              {
                id: "definition-role",
                key: "role-flow",
                version: 1,
                name: "角色流程",
                description: "",
                status: "active",
                workspaceId: "ws-1",
                graph: {
                  nodes: [
                    {
                      id: "review",
                      name: "评审",
                      executor: { kind: "role", id: "role-owner" },
                      approvers: [],
                    },
                  ],
                },
              },
            ]
          : []),
      ],
    }),
    principals: () => principals,
    now: () => now,
  });
  return {
    now,
    tables,
    service,
    workspace,
    members,
    users,
    addedMembers,
    identityAudit,
    taskMarks,
    team,
    workspaces,
    assignments,
    routes,
  };
}

describe("project service", () => {
  it("seeds the built-in role library and project templates once", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    await harness.service.seedDefaults();
    expect(harness.service.roles()).toHaveLength(13);
    expect(harness.service.templates()).toHaveLength(3);
    expect(harness.service.role("role-owner")?.name).toBe("项目负责人");
    expect(harness.service.template("tpl-plugin-dev")?.roleIds).toContain(
      "role-review",
    );
  });

  it("rejects duplicate role codes and protects referenced roles", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    await expect(
      harness.service.saveRole({
        id: "role-copy",
        name: "复制角色",
        code: "PROJECT_OWNER",
        category: "管理",
      }),
    ).rejects.toBeInstanceOf(ProjectError);
    await expect(
      harness.service.removeRole("role-owner"),
    ).rejects.toMatchObject({ code: "conflict" });
    await harness.service.saveRole({
      id: "role-extra",
      name: "临时角色",
      code: "TEMP_ROLE",
      category: "支持",
    });
    await harness.service.removeRole("role-extra");
    expect(harness.service.role("role-extra")).toBeUndefined();
  });

  it("keeps project codes unique per project", async () => {
    const harness = createHarness();
    const first = await harness.service.upsertProject({ workspaceId: "ws-1" });
    expect(first.code).toBe("PRJ000001");
    const second = await harness.service.upsertProject({ workspaceId: "ws-2" });
    expect(second.code).toBe("PRJ000002");
  });

  it("assigns stable PRJ codes when auto-provisioning projects", async () => {
    const harness = createHarness();
    const created = await harness.service.ensureProject({
      workspaceId: "ws-1",
      ownerId: "olivia",
      ownerName: "Olivia",
    });
    expect(created.code).toBe("PRJ000001");
    const again = await harness.service.ensureProject({ workspaceId: "ws-1" });
    expect(again.code).toBe(created.code);
    expect(again.ownerName).toBe("Olivia");
    expect(harness.service.projects()).toHaveLength(1);

    const second = await harness.service.ensureProject({ workspaceId: "ws-2" });
    expect(second.code).toBe("PRJ000002");
  });

  it("continues numbering from legacy PRJ-### codes", async () => {
    const harness = createHarness();
    await harness.service.upsertProject({
      workspaceId: "ws-legacy",
      code: "PRJ-007",
    });
    const next = await harness.service.ensureProject({ workspaceId: "ws-new" });
    expect(next.code).toBe("PRJ000008");
  });
});

describe("project routes", () => {
  it("lists projects with membership and notes", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const route = findRoute(harness.routes, "/api/collab/projects");
    const response = await call(
      route,
      fakeRequest("GET", "/api/collab/projects", { token: "admin-token" }),
    );
    expect(response.status).toBe(200);
    const body = response.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      workspaceId: "ws-1",
      name: "一切皆插件",
      ownerName: "Olivia",
      isMember: true,
      counts: {
        members: 2,
        humans: 2,
        aiPartners: 0,
        tasks: 1,
        workflows: 1,
      },
    });
    expect(body.projects[0].notes.tasks).toBe("今日新增 1 项");
    expect(body.projects[0].notes.workflows).toBe("1 个阻塞");
  });

  it("lists all projects to platform admins and only joined projects to members", async () => {
    const harness = createHarness({ extraWorkspace: true });
    await harness.service.seedDefaults();
    const route = findRoute(harness.routes, "/api/collab/projects");
    const adminResponse = await call(
      route,
      fakeRequest("GET", "/api/collab/projects", { token: "admin-token" }),
    );
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.json().projects).toHaveLength(2);

    const memberResponse = await call(
      route,
      fakeRequest("GET", "/api/collab/projects", { token: "owner-token" }),
    );
    expect(memberResponse.status).toBe(200);
    expect(
      memberResponse
        .json()
        .projects.map(
          (project: { workspaceId: string }) => project.workspaceId,
        ),
    ).toEqual(["ws-1"]);
  });

  it("denies non-members and reports unknown projects", async () => {
    const harness = createHarness();
    const route = findRoute(harness.routes, "/api/collab/projects/detail");
    const denied = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/detail?workspaceId=ws-1", {
        token: "member-token",
      }),
    );
    expect(denied.status).toBe(403);
    const missing = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/detail?workspaceId=ws-404", {
        token: "admin-token",
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("aggregates current task outputs and latest workflow file deliverables", async () => {
    const harness = createHarness({ outputs: true });
    const route = findRoute(harness.routes, "/api/collab/projects/outputs");
    const response = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/outputs?workspaceId=ws-1", {
        token: "owner-token",
      }),
    );
    expect(response.status).toBe(200);
    const body = response.json();
    expect(body.outputs.map((output: { name: string }) => output.name)).toEqual(
      ["review-final.pdf", "design.md"],
    );
    expect(body.outputs[0]).toMatchObject({
      sourceKind: "workflow",
      sourceName: "GUI 回归",
      workflowNodeName: "评审",
      documentType: "pdf",
      submissionId: "submission-new",
      artifactId: "artifact-new",
    });
    expect(body.outputs[1]).toMatchObject({
      sourceKind: "task",
      sourceName: "补全项目视角",
      workflowNodeName: "设计",
      documentType: "markdown",
      taskId: "TSK-1",
    });
    expect(
      body.outputs.some(
        (output: { name: string }) =>
          output.name === "input.pdf" ||
          output.name === "review-old.pdf" ||
          output.name === "review-rejected.pdf",
      ),
    ).toBe(false);
    expect(body.outputs[0].downloadUrl).toContain(
      "/api/collab/workflow/deliverables/download",
    );
    expect(body.outputs[1].downloadUrl).toContain(
      "/api/collab/tasks/document/content",
    );
  });

  it("does not deduplicate identical task files from different tasks", async () => {
    const harness = createHarness({ outputs: true, outputCollision: true });
    const route = findRoute(harness.routes, "/api/collab/projects/outputs");
    const response = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/outputs?workspaceId=ws-1", {
        token: "owner-token",
      }),
    );
    expect(response.status).toBe(200);
    const designOutputs = response
      .json()
      .outputs.filter(
        (output: { name: string }) => output.name === "design.md",
      );
    expect(designOutputs).toHaveLength(2);
    expect(
      designOutputs.map((output: { sourceName: string }) => output.sourceName),
    ).toEqual(["补全项目视角", "补全运营视角"]);
  });

  it("degrades gracefully when a workspace has no materialized project roles", async () => {
    const harness = createHarness({ extraWorkspace: true });
    await harness.service.seedDefaults();
    const listRoute = findRoute(harness.routes, "/api/collab/projects");
    const listed = await call(
      listRoute,
      fakeRequest("GET", "/api/collab/projects", { token: "admin-token" }),
    );
    expect(listed.status).toBe(200);
    const body = listed.json();
    expect(
      body.projects.map(
        (project: { workspaceId: string }) => project.workspaceId,
      ),
    ).toEqual(["ws-1", "ws-2"]);
    expect(
      body.projects.map((project: { code: string }) => project.code),
    ).toEqual(["PRJ000001", "PRJ000002"]);
    expect(
      body.projects.find(
        (project: { workspaceId: string }) => project.workspaceId === "ws-2",
      ),
    ).toMatchObject({
      name: "员工平台",
      counts: {
        members: 0,
        humans: 0,
        aiPartners: 0,
        tasks: 0,
        workflows: 0,
      },
    });

    const detailRoute = findRoute(
      harness.routes,
      "/api/collab/projects/detail",
    );
    const detail = await call(
      detailRoute,
      fakeRequest("GET", "/api/collab/projects/detail?workspaceId=ws-2", {
        token: "admin-token",
      }),
    );
    expect(detail.status).toBe(200);
    expect(detail.json().roles).toEqual([]);
    expect(detail.json().members).toEqual([]);
    expect(detail.json().viewer.canManage).toBe(true);
  });

  it("returns members, project roles and AI teammates in detail", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    harness.assignments.assign(null, {
      workspaceId: "ws-1",
      seatId: "role-dev",
      assigneeKind: "user",
      assigneeId: "peter",
    });
    harness.assignments.assign(null, {
      workspaceId: "ws-1",
      seatId: "role-owner",
      assigneeKind: "agent",
      assigneeId: "teammate-1",
    });
    const route = findRoute(harness.routes, "/api/collab/projects/detail");
    const response = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/detail?workspaceId=ws-1", {
        token: "admin-token",
      }),
    );
    expect(response.status).toBe(200);
    const body = response.json();
    expect(body.project.counts).toMatchObject({
      members: 3,
      humans: 2,
      aiPartners: 1,
    });
    const peter = body.members.find((member: any) => member.id === "peter");
    expect(peter).toMatchObject({
      principalId: "principal-human-peter",
      kind: "human",
      platformRole: "平台成员",
      workspaceRole: "member",
      joinedAt: "2026-10-02T00:00:00.000Z",
      roleNames: ["开发实施"],
      scope: "查看、编辑",
    });
    const avatar = body.members.find(
      (member: any) => member.id === "teammate-1",
    );
    expect(avatar).toMatchObject({
      principalId: "principal-ai-teammate-1",
      kind: "agent",
      name: "Research Avatar",
      platformRole: "未分配",
      avatar: "",
      source: "personal",
      roleNames: ["项目负责人"],
    });
    expect(body.directory.humans).toEqual([
      {
        id: "mia",
        principalId: "principal-human-mia",
        name: "Mia",
        platformRole: "平台成员",
      },
    ]);
    expect(body.directory.agents).toEqual([
      {
        id: "teammate-2",
        principalId: "principal-ai-teammate-2",
        name: "小白PD",
        kindLabel: "个人分身 · Olivia",
        platformRole: "未分配",
        ownerName: "Olivia",
      },
    ]);
    expect(body.roles.map((role: any) => role.id)).toEqual([
      "role-owner",
      "role-dev",
    ]);
    expect(body.viewer.canManage).toBe(true);
  });

  it("records project settings and merges collaboration identity audit history", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const updateRoute = findRoute(
      harness.routes,
      "/api/collab/projects/update",
    );
    const updated = await call(
      updateRoute,
      fakeRequest("POST", "/api/collab/projects/update", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          status: "已完成",
          health: "关注",
          progress: 80,
        },
      }),
    );
    expect(updated.status).toBe(200);

    const memberSaveRoute = findRoute(
      harness.routes,
      "/api/collab/projects/members/save",
    );
    const memberSaved = await call(
      memberSaveRoute,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "principal:principal-human-mia",
          roleIds: ["role-dev"],
          workspaceRole: "guest",
        },
      }),
    );
    expect(memberSaved.status).toBe(200);
    expect(harness.team.members("ws-1")).toContainEqual(
      expect.objectContaining({
        userId: "mia",
        memberRole: "guest",
      }),
    );

    harness.identityAudit.push({
      id: "identity-audit-1",
      at: "2026-10-16T02:00:01.000Z",
      actorId: "olivia",
      actorRole: "admin",
      action: "update_user",
      targetId: "mia",
      detail: { role: "member" },
    });

    const historyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/history",
    );
    const historyResponse = await call(
      historyRoute,
      fakeRequest(
        "GET",
        "/api/collab/projects/history?workspaceId=ws-1&limit=100",
        { token: "admin-token" },
      ),
    );
    expect(historyResponse.status).toBe(200);
    const events = historyResponse.json().events as Array<Record<string, any>>;
    expect(
      events.some(
        (event) =>
          event.action === "project.settings.update" &&
          event.detail["运行状态"] === "进行中 → 已完成",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.action === "member.add" &&
          event.targetId === "mia" &&
          event.detail["项目角色"] === "开发实施" &&
          event.detail["工作区角色"] === "未加入 → guest",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.source === "identity" &&
          event.action === "identity.update.user" &&
          event.targetName === "Mia",
      ),
    ).toBe(true);

    const forbidden = await call(
      historyRoute,
      fakeRequest("GET", "/api/collab/projects/history?workspaceId=ws-1", {
        token: "member-token",
      }),
    );
    expect(forbidden.status).toBe(403);

    await harness.assignments.assign(null, {
      workspaceId: "ws-1",
      seatId: "role-owner",
      assigneeKind: "user",
      assigneeId: "peter",
    });
    const rolePermissionDoesNotGrantAudit = await call(
      historyRoute,
      fakeRequest("GET", "/api/collab/projects/history?workspaceId=ws-1", {
        token: "owner-token",
      }),
    );
    expect(rolePermissionDoesNotGrantAudit.status).toBe(403);
  });

  it("updates workspace member roles and lets a member leave the project", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    await harness.assignments.assign(null, {
      workspaceId: "ws-1",
      seatId: "role-dev",
      assigneeKind: "user",
      assigneeId: "peter",
    });
    const saveRoute = findRoute(
      harness.routes,
      "/api/collab/projects/members/save",
    );
    const saved = await call(
      saveRoute,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "peter",
          roleIds: ["role-dev"],
          workspaceRole: "guest",
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(harness.team.members("ws-1")).toContainEqual(
      expect.objectContaining({ userId: "peter", memberRole: "guest" }),
    );

    const leaveRoute = findRoute(harness.routes, "/api/collab/projects/leave");
    const left = await call(
      leaveRoute,
      fakeRequest("POST", "/api/collab/projects/leave", {
        token: "owner-token",
        body: { workspaceId: "ws-1" },
      }),
    );
    expect(left.status).toBe(200);
    expect(
      harness.team.members("ws-1").some((member) => member.userId === "peter"),
    ).toBe(false);
    expect(
      harness.assignments
        .seats("ws-1")
        .some(
          (assignment) =>
            assignment.assigneeKind === "user" &&
            assignment.assigneeId === "peter" &&
            assignment.status === "assigned",
        ),
    ).toBe(false);
    expect(
      harness.service
        .audits("ws-1")
        .some(
          (event) =>
            event.action === "member.update" &&
            event.detail["工作区角色"] === "member → guest",
        ),
    ).toBe(true);
    expect(
      harness.service
        .audits("ws-1")
        .some(
          (event) =>
            event.action === "member.leave" && event.targetId === "peter",
        ),
    ).toBe(true);
  });

  it("requires a project manager for edits and validates the owner", async () => {
    const harness = createHarness();
    const route = findRoute(harness.routes, "/api/collab/projects/update");
    const denied = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/update", {
        token: "member-token",
        body: { workspaceId: "ws-1", status: "进行中" },
      }),
    );
    expect(denied.status).toBe(403);
    const invalidOwner = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/update", {
        token: "admin-token",
        body: { workspaceId: "ws-1", ownerId: "mia" },
      }),
    );
    expect(invalidOwner.status).toBe(400);
    const saved = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/update", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          ownerId: "olivia",
          status: "风险",
          health: "关注",
          progress: 72,
          startDate: "2026-09-12",
          targetDate: "2026-10-31",
          description: "统一协作体验",
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.json().project).toMatchObject({
      workspaceId: "ws-1",
      ownerId: "olivia",
      ownerName: "Olivia",
      status: "风险",
      progress: 72,
    });
  });

  it("adds human members without touching platform roles", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const route = findRoute(
      harness.routes,
      "/api/collab/projects/members/save",
    );
    const response = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "mia",
          roleIds: ["role-dev"],
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(harness.addedMembers).toEqual([{ userId: "mia", role: "member" }]);
    expect(
      harness.assignments
        .seats("ws-1")
        .filter((assignment) => assignment.status === "assigned"),
    ).toMatchObject([
      { seatId: "role-dev", assigneeKind: "user", assigneeId: "mia" },
    ]);
    // 平台级账号角色未被修改：users 表保持在原样。
    expect(harness.users.find((user) => user.id === "mia")?.role).toBe(
      "member",
    );
    expect(
      harness.service
        .audits("ws-1")
        .find((event) => event.action === "member.add"),
    ).toMatchObject({
      actorPrincipalId: "principal-human-olivia",
    });
  });

  it("releases removed roles and rejects unknown project roles", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const route = findRoute(
      harness.routes,
      "/api/collab/projects/members/save",
    );
    await call(
      route,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "mia",
          roleIds: ["role-dev", "role-owner"],
        },
      }),
    );
    await call(
      route,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "mia",
          roleIds: ["role-dev"],
        },
      }),
    );
    const active = harness.assignments
      .seats("ws-1")
      .filter((assignment) => assignment.status === "assigned");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ seatId: "role-dev" });
    const invalid = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "mia",
          roleIds: ["role-missing"],
        },
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("applies a project template through the assignment service", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const route = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    const denied = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "member-token",
        body: { workspaceId: "ws-1", templateId: "tpl-procurement" },
      }),
    );
    expect(denied.status).toBe(403);
    const applied = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-procurement" },
      }),
    );
    expect(applied.status).toBe(200);
    expect(
      harness.assignments.config("ws-1").seats.map((seat) => seat.id),
    ).toEqual([
      "role-owner",
      "role-plan",
      "role-sourcing",
      "role-contract",
      "role-follow",
      "role-escalate",
    ]);
    expect(harness.service.project("ws-1")?.templateId).toBe("tpl-procurement");
    expect(
      harness.service
        .audits("ws-1")
        .some(
          (event) =>
            event.action === "template.apply" &&
            event.targetName === "供应链采购",
        ),
    ).toBe(true);
  });

  it("copies template roles into each project and lets projects diverge", async () => {
    const harness = createHarness({ extraWorkspace: true });
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    for (const workspaceId of ["ws-1", "ws-2"]) {
      const applied = await call(
        applyRoute,
        fakeRequest("POST", "/api/collab/projects/templates/apply", {
          token: "admin-token",
          body: { workspaceId, templateId: "tpl-plugin-dev" },
        }),
      );
      expect(applied.status).toBe(200);
    }
    const templateRoleIds = [
      "role-owner",
      "role-req",
      "role-dev",
      "role-review",
      "role-qa",
      "role-research",
    ];
    expect(
      harness.service.project("ws-1")?.projectRoles.map((role) => role.id),
    ).toEqual(templateRoleIds);
    expect(
      harness.service.project("ws-2")?.projectRoles.map((role) => role.id),
    ).toEqual(templateRoleIds);

    const saveRoute = findRoute(
      harness.routes,
      "/api/collab/projects/role/save",
    );
    const saved = await call(
      saveRoute,
      fakeRequest("POST", "/api/collab/projects/role/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          role: {
            id: "role-owner",
            name: "项目总负责人",
            code: "PROJECT_OWNER",
            category: "管理",
            description: "本项目自定义",
            permissions: ["read", "write", "approve"],
          },
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(
      harness.service
        .project("ws-1")
        ?.projectRoles.find((role) => role.id === "role-owner")?.name,
    ).toBe("项目总负责人");
    expect(
      harness.service
        .project("ws-2")
        ?.projectRoles.find((role) => role.id === "role-owner")?.name,
    ).toBe("项目负责人");
    // 模版与全局角色库不受项目内修改影响。
    expect(harness.service.role("role-owner")?.name).toBe("项目负责人");
    expect(
      harness.service
        .template("tpl-plugin-dev")
        ?.roleIds.includes("role-owner"),
    ).toBe(true);
    // 席位跟着项目副本走，两个项目互不影响。
    expect(
      harness.assignments
        .config("ws-1")
        .seats.find((seat) => seat.id === "role-owner")?.label,
    ).toBe("项目总负责人");
    expect(
      harness.assignments
        .config("ws-2")
        .seats.find((seat) => seat.id === "role-owner")?.label,
    ).toBe("项目负责人");
  });

  it("adds and removes project-scoped roles together with seats", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const saveRoute = findRoute(
      harness.routes,
      "/api/collab/projects/role/save",
    );
    const saved = await call(
      saveRoute,
      fakeRequest("POST", "/api/collab/projects/role/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          role: {
            id: "role-custom",
            name: "现场协调",
            code: "SITE_COORDINATOR",
            category: "执行",
            description: "本项目专属角色",
            permissions: ["read", "write"],
          },
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(
      harness.assignments.config("ws-1").seats.map((seat) => seat.id),
    ).toContain("role-custom");

    const memberRoute = findRoute(
      harness.routes,
      "/api/collab/projects/members/save",
    );
    const assigned = await call(
      memberRoute,
      fakeRequest("POST", "/api/collab/projects/members/save", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          memberKind: "human",
          memberId: "peter",
          roleIds: ["role-custom"],
        },
      }),
    );
    expect(assigned.status).toBe(200);
    expect(
      harness.assignments
        .seats("ws-1")
        .some(
          (assignment) =>
            assignment.seatId === "role-custom" &&
            assignment.assigneeId === "peter" &&
            assignment.status === "assigned",
        ),
    ).toBe(true);

    const removeRoute = findRoute(
      harness.routes,
      "/api/collab/projects/role/remove",
    );
    const removed = await call(
      removeRoute,
      fakeRequest("POST", "/api/collab/projects/role/remove", {
        token: "admin-token",
        body: { workspaceId: "ws-1", roleId: "role-custom" },
      }),
    );
    expect(removed.status).toBe(200);
    expect(
      harness.service
        .project("ws-1")
        ?.projectRoles.some((role) => role.id === "role-custom"),
    ).toBe(false);
    expect(
      harness.assignments
        .config("ws-1")
        .seats.some((seat) => seat.id === "role-custom"),
    ).toBe(false);
    expect(
      harness.assignments
        .seats("ws-1")
        .some(
          (assignment) =>
            assignment.seatId === "role-custom" &&
            assignment.status === "assigned",
        ),
    ).toBe(false);
  });

  it("lists reusable role sources from projects the viewer can access", async () => {
    const harness = createHarness({ extraWorkspace: true });
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-plugin-dev" },
      }),
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-2", templateId: "tpl-employee-platform" },
      }),
    );
    const route = findRoute(
      harness.routes,
      "/api/collab/projects/role-sources",
    );
    const asAdmin = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/role-sources?workspaceId=ws-1", {
        token: "admin-token",
      }),
    );
    expect(asAdmin.status).toBe(200);
    const sources = asAdmin.json().sources;
    expect(
      sources.map((source: { workspaceId: string }) => source.workspaceId),
    ).toEqual(["ws-2"]);
    expect(sources[0].roles).toHaveLength(4);

    // peter 是 ws-1 的成员，但不是 ws-2 的成员：不能把 ws-2 当复用来源。
    const asOwner = await call(
      route,
      fakeRequest("GET", "/api/collab/projects/role-sources?workspaceId=ws-1", {
        token: "owner-token",
      }),
    );
    expect(asOwner.status).toBe(200);
    expect(asOwner.json().sources).toEqual([]);
  });

  it("imports selected roles from another project without touching the source", async () => {
    const harness = createHarness({ extraWorkspace: true });
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    for (const [workspaceId, templateId] of [
      ["ws-1", "tpl-plugin-dev"],
      ["ws-2", "tpl-procurement"],
    ] as const) {
      await call(
        applyRoute,
        fakeRequest("POST", "/api/collab/projects/templates/apply", {
          token: "admin-token",
          body: { workspaceId, templateId },
        }),
      );
    }
    const sourceBefore = harness.service
      .project("ws-2")
      ?.projectRoles.map((role) => `${role.id}:${role.name}`);
    const importRoute = findRoute(
      harness.routes,
      "/api/collab/projects/role/import",
    );
    const imported = await call(
      importRoute,
      fakeRequest("POST", "/api/collab/projects/role/import", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          sourceWorkspaceId: "ws-2",
          roleIds: ["role-owner", "role-plan", "role-sourcing"],
        },
      }),
    );
    expect(imported.status).toBe(200);
    expect(imported.json()).toMatchObject({ imported: 2, skipped: 1 });
    const targetRoles = harness.service
      .project("ws-1")
      ?.projectRoles.map((role) => role.id);
    expect(targetRoles).toContain("role-plan");
    expect(targetRoles).toContain("role-sourcing");
    expect(targetRoles).toContain("role-owner");
    expect(
      harness.assignments.config("ws-1").seats.map((seat) => seat.id),
    ).toContain("role-plan");
    // 来源项目、模版与角色库保持不变。
    expect(
      harness.service
        .project("ws-2")
        ?.projectRoles.map((role) => `${role.id}:${role.name}`),
    ).toEqual(sourceBefore);
    expect(
      harness.service
        .template("tpl-procurement")
        ?.roleIds.includes("role-plan"),
    ).toBe(true);
  });

  it("confirms an overwritten role set after acknowledging member impact", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-plugin-dev" },
      }),
    );
    harness.assignments.assign(null, {
      workspaceId: "ws-1",
      seatId: "role-dev",
      assigneeKind: "user",
      assigneeId: "peter",
    });
    const current = harness.service.project("ws-1")!;
    const nextRoles = current.projectRoles.filter(
      (role) => role.code !== "IMPLEMENTER",
    );
    const confirmRoute = findRoute(
      harness.routes,
      "/api/collab/projects/roles/confirm",
    );
    const blocked = await call(
      confirmRoute,
      fakeRequest("POST", "/api/collab/projects/roles/confirm", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          expectedRevision: current.rolesRevision,
          roles: nextRoles,
        },
      }),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json().error).toMatchObject({
      code: "member_impact",
    });
    expect(blocked.json().error.impacts).toEqual([
      {
        memberKind: "human",
        memberId: "peter",
        memberName: "Peter",
        roles: [
          {
            roleId: "role-dev",
            roleCode: "IMPLEMENTER",
            roleName: "开发实施",
          },
        ],
      },
    ]);
    // 未确认前不落库。
    expect(
      harness.service
        .project("ws-1")
        ?.projectRoles.some((role) => role.code === "IMPLEMENTER"),
    ).toBe(true);

    const confirmed = await call(
      confirmRoute,
      fakeRequest("POST", "/api/collab/projects/roles/confirm", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          expectedRevision: current.rolesRevision,
          roles: nextRoles,
          ackMemberLoss: true,
        },
      }),
    );
    expect(confirmed.status).toBe(200);
    const payload = confirmed.json();
    expect(payload.revision).toBe(current.rolesRevision + 1);
    expect(payload.diff.removed).toEqual(["IMPLEMENTER"]);
    expect(
      harness.service
        .project("ws-1")
        ?.projectRoles.some((role) => role.code === "IMPLEMENTER"),
    ).toBe(false);
    expect(
      harness.service
        .audits("ws-1")
        .some((event) => event.action === "roles.confirm"),
    ).toBe(true);
    expect(
      harness.assignments
        .config("ws-1")
        .seats.some((seat) => seat.id === "role-dev"),
    ).toBe(false);
    expect(
      harness.assignments
        .seats("ws-1")
        .some(
          (assignment) =>
            assignment.seatId === "role-dev" &&
            assignment.status === "assigned",
        ),
    ).toBe(false);
    expect(harness.taskMarks).toHaveLength(1);
    expect(harness.taskMarks[0]?.roles.get("role-dev")).toBe("开发实施");
  });

  it("blocks removing a role referenced by a loaded workflow template", async () => {
    const harness = createHarness({ roleWorkflow: true });
    await harness.service.seedDefaults();
    const template = harness.service.template("tpl-plugin-dev")!;
    await harness.service.saveTemplate({
      ...template,
      workflowTemplateIds: ["definition-role"],
    });
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-plugin-dev" },
      }),
    );
    const current = harness.service.project("ws-1")!;
    const nextRoles = current.projectRoles.filter(
      (role) => role.code !== "PROJECT_OWNER",
    );
    const confirmRoute = findRoute(
      harness.routes,
      "/api/collab/projects/roles/confirm",
    );
    const blocked = await call(
      confirmRoute,
      fakeRequest("POST", "/api/collab/projects/roles/confirm", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          expectedRevision: current.rolesRevision,
          roles: nextRoles,
          ackMemberLoss: true,
        },
      }),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json().error).toMatchObject({
      code: "workflow_template_blocked",
      templates: [
        expect.objectContaining({
          templateId: "definition-role",
          nodeId: "review",
          roleCode: "PROJECT_OWNER",
        }),
      ],
    });
    expect(harness.service.project("ws-1")?.rolesRevision).toBe(1);
    expect(
      harness.service
        .project("ws-1")
        ?.projectRoles.some((role) => role.code === "PROJECT_OWNER"),
    ).toBe(true);
  });

  it("rejects stale revisions and keeps role ids stable when renaming", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-plugin-dev" },
      }),
    );
    const current = harness.service.project("ws-1")!;
    const confirmRoute = findRoute(
      harness.routes,
      "/api/collab/projects/roles/confirm",
    );
    const conflict = await call(
      confirmRoute,
      fakeRequest("POST", "/api/collab/projects/roles/confirm", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          expectedRevision: 99,
          roles: current.projectRoles,
        },
      }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json().error.code).toBe("revision_conflict");

    const renamed = current.projectRoles.map((role) =>
      role.code === "PROJECT_OWNER" ? { ...role, name: "项目总负责人" } : role,
    );
    const saved = await call(
      confirmRoute,
      fakeRequest("POST", "/api/collab/projects/roles/confirm", {
        token: "admin-token",
        body: {
          workspaceId: "ws-1",
          expectedRevision: current.rolesRevision,
          roles: renamed,
        },
      }),
    );
    expect(saved.status).toBe(200);
    const owner = harness.service
      .project("ws-1")
      ?.projectRoles.find((role) => role.code === "PROJECT_OWNER");
    expect(owner?.name).toBe("项目总负责人");
    expect(owner?.id).toBe("role-owner");
    expect(
      harness.assignments
        .config("ws-1")
        .seats.find((seat) => seat.id === "role-owner")?.label,
    ).toBe("项目总负责人");
  });

  it("does not resurrect roles after a project clears its role list", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const applyRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/apply",
    );
    await call(
      applyRoute,
      fakeRequest("POST", "/api/collab/projects/templates/apply", {
        token: "admin-token",
        body: { workspaceId: "ws-1", templateId: "tpl-plugin-dev" },
      }),
    );
    const roleIds =
      harness.service.project("ws-1")?.projectRoles.map((role) => role.id) ??
      [];
    const removeRoute = findRoute(
      harness.routes,
      "/api/collab/projects/role/remove",
    );
    for (const roleId of roleIds) {
      await call(
        removeRoute,
        fakeRequest("POST", "/api/collab/projects/role/remove", {
          token: "admin-token",
          body: { workspaceId: "ws-1", roleId },
        }),
      );
    }
    expect(harness.service.project("ws-1")?.projectRoles).toEqual([]);
    const detailRoute = findRoute(
      harness.routes,
      "/api/collab/projects/detail",
    );
    const detail = await call(
      detailRoute,
      fakeRequest("GET", "/api/collab/projects/detail?workspaceId=ws-1", {
        token: "admin-token",
      }),
    );
    expect(detail.status).toBe(200);
    expect(
      detail
        .json()
        .roles.filter((role: { system?: boolean }) => role.system !== true),
    ).toEqual([]);
    expect(harness.service.project("ws-1")?.projectRoles).toEqual([]);
  });

  it("keeps template and role library writes behind the platform admin", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const saveRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates/save",
    );
    const denied = await call(
      saveRoute,
      fakeRequest("POST", "/api/collab/projects/templates/save", {
        token: "owner-token",
        body: {
          id: "tpl-custom",
          name: "自定义模版",
          code: "TPL-CUSTOM",
          type: "研发类",
          status: "启用",
        },
      }),
    );
    expect(denied.status).toBe(403);
    const saved = await call(
      saveRoute,
      fakeRequest("POST", "/api/collab/projects/templates/save", {
        token: "admin-token",
        body: {
          id: "tpl-custom",
          name: "自定义模版",
          code: "TPL-CUSTOM",
          type: "研发类",
          status: "启用",
          roleIds: ["role-owner", "role-dev"],
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.json().template.roleIds).toEqual(["role-owner", "role-dev"]);
    const listRoute = findRoute(
      harness.routes,
      "/api/collab/projects/templates",
    );
    const listed = await call(
      listRoute,
      fakeRequest("GET", "/api/collab/projects/templates", {
        token: "owner-token",
      }),
    );
    expect(listed.status).toBe(200);
    expect(listed.json().workflowTemplates).toHaveLength(1);
  });

  it("generates a deterministic daily report and lists it", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    await harness.service.upsertProject({
      workspaceId: "ws-1",
      ownerId: "olivia",
      ownerName: "Olivia",
      progress: 72,
      status: "风险",
      health: "关注",
      targetDate: "2026-10-31",
    });
    const generate = findRoute(
      harness.routes,
      "/api/collab/projects/reports/generate",
    );
    const response = await call(
      generate,
      fakeRequest("POST", "/api/collab/projects/reports/generate", {
        token: "admin-token",
        body: { workspaceId: "ws-1" },
      }),
    );
    expect(response.status).toBe(200);
    const report = response.json().report;
    expect(report.date).toBe("2026-10-16");
    expect(report.generatedBy).toBe("项目 AI");
    expect(report.content).toContain("## 今日结论");
    expect(report.content).toContain("## 风险与待确认");
    expect(report.content).toContain("工作流「GUI 回归」当前阻塞");
    expect(report.content).toContain("`TSK-1`");
    expect(
      harness.service
        .audits("ws-1")
        .some(
          (event) =>
            event.action === "report.generate" &&
            event.targetId === "2026-10-16",
        ),
    ).toBe(true);

    const list = findRoute(harness.routes, "/api/collab/projects/reports");
    const listed = await call(
      list,
      fakeRequest("GET", "/api/collab/projects/reports?workspaceId=ws-1", {
        token: "owner-token",
      }),
    );
    expect(listed.status).toBe(200);
    expect(listed.json().reports).toHaveLength(1);

    const denied = await call(
      generate,
      fakeRequest("POST", "/api/collab/projects/reports/generate", {
        token: "member-token",
        body: { workspaceId: "ws-1" },
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("registers directories as projects and claims the creator as owner", async () => {
    const harness = createHarness();
    await harness.service.seedDefaults();
    const route = findRoute(harness.routes, "/api/collab/projects/create");
    const response = await call(
      route,
      fakeRequest("POST", "/api/collab/projects/create", {
        token: "owner-token",
        body: {
          path: "/tmp/new-project",
          name: "新项目",
          templateId: "tpl-plugin-dev",
        },
      }),
    );
    expect(response.status).toBe(201);
    expect(response.json().workspaceId).toBe("ws-2");
    expect(harness.service.project("ws-2")).toMatchObject({
      ownerId: "peter",
      ownerName: "Peter",
      templateId: "tpl-plugin-dev",
    });
  });
});

describe("report content", () => {
  it("summarises tasks, workflows and risk items", () => {
    const content = buildProjectReportContent({
      project: {
        workspaceId: "ws-1",
        code: "PRJ-001",
        ownerId: "olivia",
        ownerName: "Olivia",
        status: "进行中",
        health: "健康",
        progress: 40,
        startDate: "2026-10-01",
        targetDate: "2026-10-31",
        description: "",
        projectRoles: [],
        rolesInitialized: true,
        rolesRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      workspace: { id: "ws-1", title: "一切皆插件", path: "/tmp/ws-1" },
      tasks: [
        {
          id: "TSK-9",
          title: "逾期任务",
          status: "progress",
          priority: "P1",
          receiverType: "unassigned",
          due: "2026-10-10",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      workflows: [],
      today: "2026-10-16",
    });
    expect(content).toContain("整体进度 40%");
    expect(content).toContain("已超过截止日期 2026-10-10");
    expect(content).toContain("- 最近更新的任务：");
    const healthy = buildProjectReportContent({
      project: {
        workspaceId: "ws-1",
        code: "PRJ-001",
        ownerId: "olivia",
        ownerName: "Olivia",
        status: "进行中",
        health: "健康",
        progress: 60,
        startDate: "",
        targetDate: "",
        description: "",
        projectRoles: [],
        rolesInitialized: true,
        rolesRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      workspace: { id: "ws-1", title: "一切皆插件", path: "/tmp/ws-1" },
      tasks: [],
      workflows: [],
      today: "2026-10-16",
    });
    expect(healthy).toContain("- 暂无阻塞项");
  });
});

describe("plugin registration", () => {
  interface ApplyHarness {
    readonly ctx: Record<string, unknown>;
    readonly provided: string[];
    readonly registered: string[];
    readonly isDisposed: () => boolean;
  }

  function createApplyHarness(
    harness: ReturnType<typeof createHarness>,
    extraGet: (key: string) => unknown = () => undefined,
  ): ApplyHarness {
    const provided: string[] = [];
    const registered: string[] = [];
    let disposed = false;
    const ctx: Record<string, any> = {
      effect: () => undefined,
      provide: (key: string) => {
        provided.push(key);
      },
      webServer: {
        register: (route: { path: string }) => {
          registered.push(route.path);
          return () => undefined;
        },
      },
      get: (key: string) => {
        const extra = extraGet(key);
        if (extra !== undefined) return extra;
        if (key === "workspaceRegistry") return harness.workspaces;
        if (key === "collabAssignment") return harness.assignments;
        if (key === "collabTasks") return { list: () => [] };
        if (key === "collabWorkflow") return { instances: () => [] };
        return undefined;
      },
      storageDomain: {
        open: async () => ({
          table: (name: string) =>
            harness.tables[name as keyof typeof harness.tables],
          close: async () => {
            disposed = true;
          },
        }),
      },
      inject: (
        _keys: readonly string[],
        callback: (child: unknown) => void,
      ) => {
        callback({
          collabTeam: harness.team,
          get: ctx.get,
          webServer: ctx.webServer,
          effect: (register: () => () => void) => register(),
        });
        return { dispose: () => undefined };
      },
    };
    return {
      ctx,
      provided,
      registered,
      isDisposed: () => disposed,
    };
  }

  it("provides the project service and registers routes in the team fiber", async () => {
    const harness = createHarness();
    const applyHarness = createApplyHarness(harness);
    await apply(applyHarness.ctx as never);
    expect(inject).toEqual(["storageDomain", "webServer"]);
    expect(applyHarness.provided).toEqual(["collabProjects"]);
    expect(applyHarness.registered).toContain("/api/collab/projects");
    expect(applyHarness.registered).toContain(
      "/api/collab/projects/members/save",
    );
    expect(projectDomainSpec.name).toBe("collab_project");
    expect(applyHarness.isDisposed()).toBe(false);
  });

  it("assigns PRJ codes when the workspace stream reports a new project", async () => {
    const harness = createHarness({ extraWorkspace: true });
    async function* follow() {
      yield { type: "baseline", value: { items: [{ workspaceId: "ws-1" }] } };
      yield { type: "upsert", workspace: { workspaceId: "ws-2" } };
    }
    const applyHarness = createApplyHarness(harness, (key) =>
      key === "workspaceController" ? { follow } : undefined,
    );
    await apply(applyHarness.ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.service.project("ws-1")?.code).toBe("PRJ000001");
    expect(harness.service.project("ws-2")?.code).toBe("PRJ000002");
  });
});
