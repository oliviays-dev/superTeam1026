import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(import.meta.dirname, "../client/index.js");

interface SlotSpec {
  readonly id: string;
  readonly name: string;
  readonly order?: number;
}

interface RoleLike {
  id: string;
  name: string;
  code: string;
  category?: string;
  description?: string;
  permissions?: readonly string[];
}

interface ClientExports {
  inject?: readonly string[];
  apply?: (ctx: {
    slots: {
      inject: (name: string, run: () => void) => void;
      register: (spec: SlotSpec, component?: unknown) => () => void;
    };
    get?: (key: string) => unknown;
  }) => void;
  __test?: {
    statusTone(status: string): string;
    priorityLabel(priority: string): string;
    permissionLabels(permissions: readonly string[]): string;
    platformUserOptionLabel(
      member: {
        name: string;
        platformRole?: string;
        kindLabel?: string;
        ownerName?: string;
      },
      kind: "human" | "agent",
    ): string;
    memberScopeForRoles(
      roles: readonly {
        id: string;
        permissions?: readonly string[];
      }[],
      roleIds: readonly string[],
    ): string;
    workspaceRoleLabel(role?: string): string;
    compactWorkspacePath(path?: string, segmentCount?: number): string;
    auditCategoryLabel(category: string): string;
    auditMatches(
      event: {
        summary?: string;
        actorName?: string;
        actorRole?: string;
        targetName?: string;
        action?: string;
        category?: string;
        detail?: Readonly<Record<string, string>>;
      },
      keyword: string,
      category: string,
    ): boolean;
    projectMatches(
      project: {
        name: string;
        code: string;
        ownerName: string;
        status: string;
        health: string;
      },
      keyword: string,
    ): boolean;
    sortProjectTasks(
      tasks: readonly {
        id: string;
        priority: string;
        createdAt: string;
      }[],
    ): readonly { id: string; priority: string; createdAt: string }[];
    outputMatches(
      item: {
        name: string;
        documentType: string;
        updatedAt: string;
        workflowNodeName?: string;
        workflowInstanceTitle?: string;
        sourceName: string;
        authorName: string;
      },
      keyword: string,
      type: string,
      fromDate: string,
      toDate: string,
    ): boolean;
    groupOutputsByDay(
      items: readonly {
        id: string;
        name: string;
        updatedAt: string;
      }[],
    ): readonly {
      date: string;
      items: readonly { id: string; name: string; updatedAt: string }[];
    }[];
    formatFileSize(value: number): string;
    outputLoadErrorMessage(cause: unknown): string;
    parseReportBlocks(content: string): readonly {
      type: string;
      text?: string;
      items?: readonly string[];
    }[];
    roleCodeKey(role: { code?: string }): string;
    roleFieldsDiffer(left: RoleLike, right: RoleLike): boolean;
    computeRoleDiff(
      effective: readonly RoleLike[],
      draft: readonly RoleLike[],
    ): {
      added: readonly RoleLike[];
      updated: readonly RoleLike[];
      removed: readonly RoleLike[];
    };
    nextRoleCopyCode(
      baseCode: string,
      roles: readonly { code: string }[],
    ): string;
    openTask(taskId: string, workspaceId: string): void;
    openWorkflow(instanceId: string, workspaceId: string): void;
  };
}

function fakeWindow(): Record<string, any> {
  const events: Array<{ type: string; detail?: unknown }> = [];
  const windowStub: Record<string, any> = {
    __events: events,
    __ModuleLoader__: {
      load: (definition: {
        id: string;
        factory: (require: (id: string) => unknown) => unknown;
      }) => {
        loaded = definition.factory((id: string) => {
          if (id === "react") return fakeReact;
          throw new Error(`unexpected module: ${id}`);
        }) as ClientExports;
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    __pluginmaxShell: {
      setRoute: (route: string) => {
        windowStub.__route = route;
      },
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      events.push({ type: event.type, detail: event.detail });
      return true;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    CustomEvent: class {
      constructor(
        readonly type: string,
        readonly options?: { detail?: unknown },
      ) {}
      get detail() {
        return this.options?.detail;
      }
    },
  };
  let loaded: ClientExports = {};
  windowStub.__loaded = () => loaded;
  return windowStub;
}

const fakeReact = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: props ?? {},
    children,
  }),
  useState: (initial: unknown) => [initial, () => undefined],
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
  useRef: (value: unknown) => ({ current: value }),
  Fragment: "Fragment",
};

function loadClientExports(): {
  exports: ClientExports;
  window: Record<string, any>;
} {
  const windowStub = fakeWindow();
  const source = readFileSync(CLIENT_PATH, "utf8");
  const factory = new Function(
    "window",
    "module",
    "exports",
    "CustomEvent",
    source,
  ) as (
    window: unknown,
    module: { exports: unknown },
    exports: unknown,
    customEvent: unknown,
  ) => void;
  const module = { exports: {} };
  factory(windowStub, module, module.exports, windowStub.CustomEvent);
  return {
    exports: windowStub.__loaded() as ClientExports,
    window: windowStub,
  };
}

describe("project management client", () => {
  it("maps project and workflow states to the shared pill tones", () => {
    const { exports: client } = loadClientExports();
    const helpers = client.__test;
    expect(helpers?.statusTone("风险")).toBe("warn");
    expect(helpers?.statusTone("已完成")).toBe("done");
    expect(helpers?.statusTone("关注")).toBe("notice");
    expect(helpers?.statusTone("规划中")).toBe("notice");
    expect(helpers?.statusTone("进行中")).toBe("progress");
    expect(helpers?.priorityLabel("P1")).toBe("P0");
    expect(helpers?.priorityLabel("P2")).toBe("P1");
    expect(helpers?.priorityLabel("P3")).toBe("P2");
  });

  it("renders permission scopes instead of free text", () => {
    const { exports: client } = loadClientExports();
    expect(client.__test?.permissionLabels(["read", "write", "read"])).toBe(
      "查看、编辑",
    );
    expect(client.__test?.permissionLabels([])).toBe("未分配");
    expect(client.__test?.permissionLabels(["manage_members", "approve"])).toBe(
      "成员管理、审批",
    );
  });

  it("formats platform user options with human and AI platform roles", () => {
    const { exports: client } = loadClientExports();
    const label = client.__test?.platformUserOptionLabel;
    expect(
      label?.({ name: "QA Member", platformRole: "平台成员" }, "human"),
    ).toBe("QA Member（平台成员）");
    expect(
      label?.(
        {
          name: "会议 Facilitator",
          kindLabel: "平台 AI Teammate",
          ownerName: "Olivia",
        },
        "agent",
      ),
    ).toBe("会议 Facilitator·AI（by Olivia）");
  });

  it("summarizes authorization from effective project roles", () => {
    const { exports: client } = loadClientExports();
    expect(
      client.__test?.memberScopeForRoles(
        [
          { id: "project-custom", permissions: ["read", "approve"] },
          { id: "project-owner", permissions: ["manage_members"] },
        ],
        ["project-custom"],
      ),
    ).toBe("查看、审批");
  });

  it("labels workspace membership roles independently from platform roles", () => {
    const { exports: client } = loadClientExports();
    expect(client.__test?.workspaceRoleLabel("owner")).toBe("负责人");
    expect(client.__test?.workspaceRoleLabel("guest")).toBe("访客");
    expect(client.__test?.workspaceRoleLabel(undefined)).toBe("不适用");
  });

  it("compacts long workspace paths while preserving copyable input", () => {
    const { exports: client } = loadClientExports();
    expect(
      client.__test?.compactWorkspacePath(
        "/Users/oliviayang/Deepseek Harness/projects/web-team-proj/1017-项目测试",
      ),
    ).toBe(".../projects/web-team-proj/1017-项目测试");
    expect(
      client.__test?.compactWorkspacePath(
        "C:\\Users\\olivia\\projects\\web-team-proj",
        2,
      ),
    ).toBe(".../projects/web-team-proj");
    expect(client.__test?.compactWorkspacePath("")).toBe("未知");
  });

  it("exposes workspace identity, membership role and leave controls", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("工作区 ID");
    expect(source).toContain("工作区路径");
    expect(source).toContain("pmproj-copy-icon");
    expect(source).toContain("复制工作区 ID");
    expect(source).toContain("复制工作区路径");
    expect(source).toContain("工作区角色");
    expect(source).toContain("加入时间");
    expect(source).toContain("pluginmax:follow-change");
    expect(source).toContain("__pluginmaxFollow");
    expect(source).toContain("退出项目");
    expect(source).toContain('"/api/collab/projects/leave"');
    expect(source).toContain("pmproj-avatar human");
    expect(source).toContain("pmproj-avatar-ring");
    expect(source).toContain("memberAvatarArt");
    expect(source).toContain("需改派");
    expect(source).toContain("reassignmentReason");
  });

  it("keeps the project directory text-only without decorative thumbnails", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("const renderProjectList");
    const end = source.indexOf("const renderFacts", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("pmproj-list-mark");
  });

  it("uses the demo interaction feedback for search, rows and actions", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain(".pmproj-search:focus-within");
    expect(source).toContain(".pmproj-list-item.active");
    expect(source).toContain("var(--dsw-alias-accent-primary");
    expect(source).toContain(".pmproj-row:hover");
    expect(source).toContain(".pmproj-btn.secondary:not(:disabled):hover");
  });

  it("uses compact project details and role-setting hierarchy", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const roleEditorStart = source.indexOf("const renderProjectRoleEditor");
    const roleEditorEnd = source.indexOf(
      "const renderTasksTab",
      roleEditorStart,
    );
    const roleEditor = source.slice(roleEditorStart, roleEditorEnd);
    const titleIndex = roleEditor.indexOf("项目角色清单");
    const countIndex = roleEditor.indexOf("${draftRoles.length} 个角色");
    const templateButtonIndex = roleEditor.indexOf("从模版加载");

    expect(source).toContain("pmproj-follow-star");
    expect(source).toContain("pmproj-btn subtle");
    expect(source).toContain("pmproj-settings-basics");
    expect(source).toContain(
      ".pmproj-detail{min-width:0;display:flex;flex-direction:column;gap:8px;}",
    );
    expect(titleIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(titleIndex);
    expect(templateButtonIndex).toBeGreaterThan(countIndex);
  });

  it("filters project audit events by category and searchable detail", () => {
    const { exports: client } = loadClientExports();
    const event = {
      summary: "更新项目设置（1 项）",
      actorName: "Admin",
      actorRole: "admin",
      targetName: "1017-项目测试",
      action: "project.settings.update",
      category: "project",
      detail: { 运行状态: "进行中 → 已完成" },
    };
    expect(client.__test?.auditCategoryLabel("template")).toBe("关联模版");
    expect(client.__test?.auditMatches(event, "已完成", "all")).toBe(true);
    expect(client.__test?.auditMatches(event, "已完成", "member")).toBe(false);
    expect(client.__test?.auditMatches(event, "admin", "project")).toBe(true);
  });

  it("filters projects by name, code, owner and status", () => {
    const { exports: client } = loadClientExports();
    const project = {
      name: "一切皆插件",
      code: "PRJ-001",
      ownerName: "Olivia",
      status: "进行中",
      health: "健康",
    };
    expect(client.__test?.projectMatches(project, "")).toBe(true);
    expect(client.__test?.projectMatches(project, "prj-001")).toBe(true);
    expect(client.__test?.projectMatches(project, "olivia")).toBe(true);
    expect(client.__test?.projectMatches(project, "风险")).toBe(false);
  });

  it("sorts active tasks by priority then recency", () => {
    const { exports: client } = loadClientExports();
    const sorted = client.__test?.sortProjectTasks([
      { id: "b", priority: "P2", createdAt: "2026-10-02T00:00:00.000Z" },
      { id: "a", priority: "P1", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "c", priority: "P1", createdAt: "2026-10-03T00:00:00.000Z" },
    ]);
    expect(sorted?.map((task) => task.id)).toEqual(["c", "a", "b"]);
  });

  it("filters and groups project outputs by search, type and date", () => {
    const { exports: client } = loadClientExports();
    const helpers = client.__test;
    const item = {
      name: "设计评审报告.md",
      documentType: "markdown",
      updatedAt: "2026-10-17T12:00:00.000Z",
      workflowNodeName: "设计评审",
      workflowInstanceTitle: "发布流程",
      sourceName: "完善发布方案",
      authorName: "Research Avatar",
    };
    expect(helpers?.outputMatches(item, "设计评审", "all", "", "")).toBe(true);
    expect(helpers?.outputMatches(item, "发布流程", "all", "", "")).toBe(true);
    expect(helpers?.outputMatches(item, "完善发布方案", "all", "", "")).toBe(
      true,
    );
    expect(helpers?.outputMatches(item, "Research Avatar", "all", "", "")).toBe(
      false,
    );
    expect(
      helpers?.outputMatches(item, "", "markdown", "2026-10-17", "2026-10-17"),
    ).toBe(true);
    expect(
      helpers?.outputMatches(item, "", "pdf", "2026-10-17", "2026-10-17"),
    ).toBe(false);

    const groups = helpers?.groupOutputsByDay([
      { ...item, id: "a", updatedAt: "2026-10-17T08:00:00.000Z" },
      { ...item, id: "b", updatedAt: "2026-10-17T12:00:00.000Z" },
      { ...item, id: "c", updatedAt: "2026-10-16T12:00:00.000Z" },
    ]);
    expect(groups?.map((group) => group.date)).toEqual([
      "2026-10-17",
      "2026-10-16",
    ]);
    expect(groups?.[0]?.items.map((output) => output.id)).toEqual(["b", "a"]);
    expect(helpers?.formatFileSize(900)).toBe("900 B");
    expect(helpers?.formatFileSize(1_536)).toBe("1.5 KB");
    expect(
      helpers?.outputLoadErrorMessage(
        Object.assign(new Error("HTTP 404"), { status: 404 }),
      ),
    ).toBe("产出物服务未加载，请重启当前服务后重试。");
    expect(helpers?.outputLoadErrorMessage(new Error("网络异常"))).toBe(
      "网络异常",
    );
  });

  it("parses report markdown into headings, lists and paragraphs", () => {
    const { exports: client } = loadClientExports();
    const blocks = client.__test?.parseReportBlocks(
      "## 今日结论\n\n项目进度 72%。\n\n- 第一条\n- 第二条\n",
    );
    expect(blocks).toEqual([
      { type: "heading", text: "今日结论" },
      { type: "paragraph", text: "项目进度 72%。" },
      { type: "list", items: ["第一条", "第二条"] },
    ]);
  });

  it("computes project role draft diffs by code", () => {
    const { exports: client } = loadClientExports();
    const helpers = client.__test;
    const effective: RoleLike[] = [
      {
        id: "role-owner",
        name: "项目负责人",
        code: "PROJECT_OWNER",
        category: "管理",
        description: "",
        permissions: ["read", "write"],
      },
      {
        id: "role-dev",
        name: "开发实施",
        code: "IMPLEMENTER",
        category: "执行",
        description: "",
        permissions: ["read", "write"],
      },
    ];
    const draft = [
      {
        ...effective[0]!,
        name: "项目总负责人",
      },
      {
        id: "role-new",
        name: "现场协调",
        code: "SITE_COORDINATOR",
        category: "执行",
        description: "",
        permissions: ["read"],
      },
    ];
    const diff = helpers?.computeRoleDiff(effective, draft);
    expect(diff?.added.map((role) => role.code)).toEqual(["SITE_COORDINATOR"]);
    expect(diff?.updated.map((role) => role.code)).toEqual(["PROJECT_OWNER"]);
    expect(diff?.removed.map((role) => role.code)).toEqual(["IMPLEMENTER"]);
    expect(helpers?.roleCodeKey({ code: " implementer " })).toBe("IMPLEMENTER");
  });

  it("ignores name and permission ordering when nothing changed", () => {
    const { exports: client } = loadClientExports();
    const helpers = client.__test;
    const base = {
      id: "role-owner",
      name: "项目负责人",
      code: "PROJECT_OWNER",
      category: "管理",
      description: "",
      permissions: ["read", "write"],
    };
    const diff = helpers?.computeRoleDiff(
      [base],
      [{ ...base, permissions: ["write", "read"] }],
    );
    expect(diff?.added).toEqual([]);
    expect(diff?.updated).toEqual([]);
    expect(diff?.removed).toEqual([]);
    expect(
      helpers?.roleFieldsDiffer(base, { ...base, description: "变更说明" }),
    ).toBe(true);
  });

  it("generates a fresh code when copying a project role", () => {
    const { exports: client } = loadClientExports();
    const helpers = client.__test;
    expect(helpers?.nextRoleCopyCode("REQUIREMENT_OWNER", [])).toBe(
      "REQUIREMENT_OWNER_COPY",
    );
    expect(
      helpers?.nextRoleCopyCode("REQUIREMENT_OWNER", [
        { code: "REQUIREMENT_OWNER" },
        { code: "REQUIREMENT_OWNER_COPY" },
      ]),
    ).toBe("REQUIREMENT_OWNER_COPY_2");
  });

  it("keeps role definitions in project settings and member management inline", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const membersTabStart = source.indexOf("const renderMembersTab");
    const roleEditorStart = source.indexOf("const renderProjectRoleEditor");
    const tasksStart = source.indexOf("const renderTasksTab");
    const editModalStart = source.indexOf("const renderEditModal");
    const memberModalStart = source.indexOf("const renderMemberModal");

    expect(membersTabStart).toBeGreaterThan(-1);
    expect(roleEditorStart).toBeGreaterThan(-1);
    expect(roleEditorStart).toBeGreaterThan(membersTabStart);
    expect(tasksStart).toBeGreaterThan(roleEditorStart);
    expect(editModalStart).toBeGreaterThan(tasksStart);
    expect(memberModalStart).toBeGreaterThan(editModalStart);

    const membersTab = source.slice(membersTabStart, roleEditorStart);
    const roleEditor = source.slice(roleEditorStart, tasksStart);
    const editModal = source.slice(editModalStart, memberModalStart);

    expect(membersTab).toContain("memberManageMode");
    expect(membersTab).toContain('openMemberModal("add"');
    expect(membersTab).toContain("添加成员");
    expect(roleEditor).toContain("从模版加载");
    expect(roleEditor).toContain("复用其他项目");
    expect(roleEditor).toContain("添加角色");
    expect(editModal).toContain("renderProjectRoleEditor()");
    expect(editModal).toContain("项目设置");
    expect(editModal).toContain("基础信息");
    expect(editModal).toContain("项目角色");
    expect(editModal).not.toContain("编辑项目信息");
    expect(membersTab).not.toContain("openTemplateLoad");
    expect(membersTab).not.toContain("openRoleSources");
    expect(membersTab).not.toContain('openRoleModal("add"');
    expect(membersTab).not.toContain("confirmRoleDraft");
    expect(source).not.toContain("const renderMemberManagement");
  });

  it("clears project data and member edit state when the login token changes", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const listenerStart = source.indexOf(
      'window.addEventListener("pluginmax:collab-token", synchronize)',
    );
    const synchronizeStart = source.lastIndexOf(
      "const synchronize =",
      listenerStart,
    );
    const synchronizeEnd = source.indexOf(
      "}, [loadProjects, loadFollows]);",
      listenerStart,
    );
    expect(synchronizeStart).toBeGreaterThan(-1);
    expect(synchronizeEnd).toBeGreaterThan(synchronizeStart);
    const synchronize = source.slice(synchronizeStart, synchronizeEnd);
    expect(synchronize).toContain("setProjects([])");
    expect(synchronize).toContain("setDetail(null)");
    expect(synchronize).toContain("setMemberManageMode(false)");
    expect(synchronize).toContain("setMemberModal(null)");
  });

  it("deep-links tasks and workflows through the shell conventions", () => {
    const { exports: client, window: windowStub } = loadClientExports();
    client.__test?.openTask("TSK-1", "ws-1");
    expect(windowStub.__pluginmaxPendingTask).toEqual({
      taskId: "TSK-1",
      workspaceId: "ws-1",
    });
    expect(windowStub.__route).toBe("task");
    client.__test?.openWorkflow("wf-1", "ws-1");
    expect(windowStub.__route).toBe("workflow");
    expect(windowStub.__events).toEqual([
      {
        type: "pluginmax:collab-navigate",
        detail: { plugin: "workflow", instanceId: "wf-1", workspaceId: "ws-1" },
      },
    ]);
  });

  it("registers the projects page on the pluginmax.global slot", () => {
    const { exports: client } = loadClientExports();
    const specs: SlotSpec[] = [];
    expect(client.inject).toEqual(["slots"]);
    client.apply?.({
      slots: {
        inject: (_name, run) => run(),
        register: (spec, component) => {
          specs.push(spec);
          expect(typeof component).toBe("function");
          return () => undefined;
        },
      },
      get: () => undefined,
    });
    expect(specs).toEqual([
      { name: "pluginmax.global", id: "pluginmax-project", order: 32 },
    ]);
  });
});
