import { z } from "zod";
import {
  projectAuditRecordSchema,
  projectRecordSchema,
  projectReportRecordSchema,
  projectRoleRecordSchema,
  projectTemplateRecordSchema,
  type ProjectAuditCategory,
  type ProjectAuditRecord,
  type ProjectRecord,
  type ProjectRoleDefinition,
  type ProjectReportRecord,
  type ProjectRoleRecord,
  type ProjectTemplateRecord,
  type RoleCategory,
} from "./types.js";

interface SchemaLike<V> {
  safeParse(value: unknown): { success: boolean; data?: V };
}

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ProjectTables {
  readonly projects: KvTableLike<ProjectRecord>;
  readonly templates: KvTableLike<ProjectTemplateRecord>;
  readonly roles: KvTableLike<ProjectRoleRecord>;
  readonly reports: KvTableLike<ProjectReportRecord>;
  readonly audit: KvTableLike<ProjectAuditRecord>;
}

export class ProjectError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "member_impact"
      | "workflow_template_blocked"
      | "revision_conflict",
    message: string,
    readonly details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

function parseOrInvalid<V>(schema: SchemaLike<V>, value: unknown): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProjectError("invalid_input", "请求内容不合法");
  }
  return result.data as V;
}

function tableValues<V>(table: KvTableLike<V>): V[] {
  return Array.from(table.entries(), ([, value]) => value);
}

/**
 * 角色分类 → 默认权限。项目角色库允许在界面上调整单个角色的权限，
 * 这里只作为新建角色与内置角色库的初始值。
 */
const CATEGORY_PERMISSIONS: Record<RoleCategory, readonly string[]> = {
  管理: ["read", "write", "approve", "manage_members", "manage_roles"],
  执行: ["read", "write"],
  评审: ["read", "write", "approve"],
  审批: ["read", "approve"],
  计划: ["read", "write"],
  采购: ["read", "write"],
  支持: ["read", "write"],
};

interface SeedRole {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly category: RoleCategory;
  readonly description: string;
}

/** 内置项目角色库：与 demo 的 13 个项目角色一致。 */
const SEED_ROLES: readonly SeedRole[] = [
  {
    id: "role-owner",
    name: "项目负责人",
    code: "PROJECT_OWNER",
    category: "管理",
    description: "对项目交付结果负责，可维护成员与权限。",
  },
  {
    id: "role-req",
    name: "需求决策",
    code: "REQUIREMENT_OWNER",
    category: "管理",
    description: "确认需求范围与验收口径，处理需求变更。",
  },
  {
    id: "role-dev",
    name: "开发实施",
    code: "IMPLEMENTER",
    category: "执行",
    description: "承接开发 / 配置类任务并提交产出。",
  },
  {
    id: "role-review",
    name: "代码评审",
    code: "CODE_REVIEWER",
    category: "评审",
    description: "对实现质量做评审并给出结论。",
  },
  {
    id: "role-qa",
    name: "质量验收",
    code: "ACCEPTANCE",
    category: "评审",
    description: "编写与执行验收用例，确认交付口径。",
  },
  {
    id: "role-research",
    name: "会前研究",
    code: "PRE_MEETING_RESEARCH",
    category: "支持",
    description: "会议前整理背景材料与待决策项。",
  },
  {
    id: "role-follow",
    name: "流程跟进",
    code: "PROCESS_FOLLOW_UP",
    category: "执行",
    description: "跟进节点流转、催办与状态同步。",
  },
  {
    id: "role-escalate",
    name: "催办升级",
    code: "ESCALATION",
    category: "执行",
    description: "超时或阻塞时升级到责任人并留痕。",
  },
  {
    id: "role-plan",
    name: "供应计划",
    code: "SUPPLY_PLANNER",
    category: "计划",
    description: "维护供给计划、备料与产能平衡。",
  },
  {
    id: "role-sourcing",
    name: "寻源比价",
    code: "SOURCING",
    category: "采购",
    description: "组织询价、比价与供应商准入。",
  },
  {
    id: "role-contract",
    name: "合同审批",
    code: "CONTRACT_APPROVAL",
    category: "审批",
    description: "审批合同条款、金额与付款计划。",
  },
  {
    id: "role-release",
    name: "发布执行",
    code: "RELEASE_EXECUTOR",
    category: "执行",
    description: "执行发布、回滚与停机窗口操作。",
  },
  {
    id: "role-evidence",
    name: "技术证据",
    code: "TECH_EVIDENCE",
    category: "支持",
    description: "沉淀技术证据链与复盘材料。",
  },
];

interface SeedTemplate {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly type: string;
  readonly description: string;
  readonly roleIds: readonly string[];
}

/**
 * 内置项目模版。工作流模版引用留空：模版本体由工作流模块拥有，
 * 这里不伪造不存在的引用。
 */
const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    id: "tpl-plugin-dev",
    name: "插件 / 平台研发",
    code: "TPL-PLUGIN",
    type: "研发类",
    description:
      "适用于平台与插件研发，强调需求决策、开发实施与代码评审的闭环。",
    roleIds: [
      "role-owner",
      "role-req",
      "role-dev",
      "role-review",
      "role-qa",
      "role-research",
    ],
  },
  {
    id: "tpl-employee-platform",
    name: "员工平台建设",
    code: "TPL-EMPLOYEE",
    type: "内部系统类",
    description: "面向内部员工系统建设，突出体验评审、质量验收与跨端回归。",
    roleIds: ["role-owner", "role-dev", "role-qa", "role-research"],
  },
  {
    id: "tpl-procurement",
    name: "供应链采购",
    code: "TPL-PROCUREMENT",
    type: "采购类",
    description: "覆盖寻源比价、合同审批与交付跟催，保障采购韧性与承诺兑现。",
    roleIds: [
      "role-owner",
      "role-plan",
      "role-sourcing",
      "role-contract",
      "role-follow",
      "role-escalate",
    ],
  },
];

export interface ProjectUpsertInput {
  readonly workspaceId: string;
  readonly code?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly ownerName?: string | undefined;
  readonly status?: ProjectRecord["status"] | undefined;
  readonly health?: ProjectRecord["health"] | undefined;
  readonly progress?: number | undefined;
  readonly startDate?: string | undefined;
  readonly targetDate?: string | undefined;
  readonly description?: string | undefined;
  readonly templateId?: string | undefined;
  readonly projectRoles?: readonly ProjectRoleDefinition[] | undefined;
  readonly rolesInitialized?: boolean | undefined;
  readonly rolesRevision?: number | undefined;
  readonly rolesUpdatedAt?: string | undefined;
  readonly rolesUpdatedBy?: string | undefined;
}

/**
 * 项目域服务：项目扩展信息、项目角色库、项目模版与项目日报。
 * 成员/席位关系不在这里保存，统一由 dsh-collab-roles 的指派服务拥有。
 */
export class ProjectService {
  constructor(
    private readonly tables: ProjectTables,
    private readonly options: { readonly now: () => Date } = {
      now: () => new Date(),
    },
  ) {}

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  // ---------------------------------------------------------------- projects

  project(workspaceId: string): ProjectRecord | undefined {
    const value = this.tables.projects.get(workspaceId);
    return value === undefined ? undefined : this.normalizeProject(value);
  }

  projects(): ProjectRecord[] {
    return tableValues(this.tables.projects).map((value) =>
      this.normalizeProject(value),
    );
  }

  /** 旧记录没有 projectRoles / rolesInitialized 字段，读取时补齐默认值。 */
  private normalizeProject(value: ProjectRecord): ProjectRecord {
    const parsed = projectRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : value;
  }

  /**
   * 新项目编码：`PRJ` + 6 位数字（PRJ000001 起递增），已存在的编码不重复。
   * 兼容历史 PRJ-001 形式，取两套写法的最大数字继续递增。
   */
  nextProjectCode(): string {
    let max = 0;
    for (const project of this.projects()) {
      const match = /^PRJ-?(\d+)$/.exec(project.code.trim());
      if (match === null) continue;
      max = Math.max(max, Number(match[1]));
    }
    return `PRJ${String(max + 1).padStart(6, "0")}`;
  }

  /** 串行化自动建档，避免并发读取时分配出重复编号。 */
  private provisioning: Promise<unknown> = Promise.resolve();

  /**
   * 读取项目记录；不存在时按传入的工作区信息自动建档并分配项目编号。
   * 自动建档只在读路径首次遇到该工作区时发生，之后编号保持稳定。
   */
  ensureProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const existing = this.project(input.workspaceId);
    if (existing !== undefined) return Promise.resolve(existing);
    const run = this.provisioning.then(() => {
      const current = this.project(input.workspaceId);
      return current === undefined ? this.upsertProject(input) : current;
    });
    this.provisioning = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async upsertProject(input: ProjectUpsertInput): Promise<ProjectRecord> {
    const existing = this.project(input.workspaceId);
    const timestamp = this.nowIso();
    const merged = parseOrInvalid(projectRecordSchema, {
      workspaceId: input.workspaceId,
      code: input.code ?? existing?.code ?? this.nextProjectCode(),
      ownerId: input.ownerId ?? existing?.ownerId,
      ownerName: input.ownerName ?? existing?.ownerName ?? "",
      status: input.status ?? existing?.status ?? "进行中",
      health: input.health ?? existing?.health ?? "健康",
      progress: input.progress ?? existing?.progress ?? 0,
      startDate: input.startDate ?? existing?.startDate ?? "",
      targetDate: input.targetDate ?? existing?.targetDate ?? "",
      description: input.description ?? existing?.description ?? "",
      templateId: input.templateId ?? existing?.templateId,
      projectRoles: [...(input.projectRoles ?? existing?.projectRoles ?? [])],
      rolesInitialized:
        input.rolesInitialized ?? existing?.rolesInitialized ?? false,
      rolesRevision: input.rolesRevision ?? existing?.rolesRevision ?? 1,
      rolesUpdatedAt: input.rolesUpdatedAt ?? existing?.rolesUpdatedAt,
      rolesUpdatedBy: input.rolesUpdatedBy ?? existing?.rolesUpdatedBy,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.tables.projects.put(input.workspaceId, merged);
    return merged;
  }

  /**
   * 保存项目自己的角色定义（新增或更新）。只在当前项目内校验 id / code 唯一，
   * 不触碰模版或全局角色库。
   */
  async saveProjectRole(input: {
    readonly workspaceId: string;
    readonly role: ProjectRoleDefinition;
  }): Promise<ProjectRecord> {
    const project = this.project(input.workspaceId);
    if (project === undefined) {
      throw new ProjectError("not_found", "项目不存在");
    }
    const code = input.role.code.trim();
    const duplicate = project.projectRoles.find(
      (role) => role.code === code && role.id !== input.role.id,
    );
    if (duplicate !== undefined) {
      throw new ProjectError("conflict", `项目角色标识已存在：${code}`);
    }
    const others = project.projectRoles.filter(
      (role) => role.id !== input.role.id,
    );
    return this.upsertProject({
      workspaceId: input.workspaceId,
      projectRoles: [...others, input.role],
      rolesInitialized: true,
    });
  }

  /** 删除项目自己的角色定义；席位与指派由调用方同步。 */
  async removeProjectRole(input: {
    readonly workspaceId: string;
    readonly roleId: string;
  }): Promise<ProjectRecord> {
    const project = this.project(input.workspaceId);
    if (project === undefined) {
      throw new ProjectError("not_found", "项目不存在");
    }
    const next = project.projectRoles.filter(
      (role) => role.id !== input.roleId,
    );
    if (next.length === project.projectRoles.length) {
      throw new ProjectError("not_found", "项目角色不存在");
    }
    return this.upsertProject({
      workspaceId: input.workspaceId,
      projectRoles: next,
      rolesInitialized: true,
    });
  }

  /** 用一份完整角色清单替换项目角色（应用模版 / 初始化迁移使用）。 */
  async replaceProjectRoles(input: {
    readonly workspaceId: string;
    readonly roles: readonly ProjectRoleDefinition[];
    readonly templateId?: string | undefined;
  }): Promise<ProjectRecord> {
    return this.upsertProject({
      workspaceId: input.workspaceId,
      projectRoles: input.roles,
      rolesInitialized: true,
      ...(input.templateId === undefined
        ? {}
        : { templateId: input.templateId }),
    });
  }

  // ------------------------------------------------------------------- roles

  roles(): ProjectRoleRecord[] {
    return tableValues(this.tables.roles).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  role(id: string): ProjectRoleRecord | undefined {
    return this.tables.roles.get(id);
  }

  /** 与内置角色分类对应的默认权限，供界面在新建角色时预填。 */
  static defaultPermissions(category: RoleCategory): string[] {
    return [...CATEGORY_PERMISSIONS[category]];
  }

  templatesUsingRole(roleId: string): ProjectTemplateRecord[] {
    return this.templates().filter((template) =>
      template.roleIds.includes(roleId),
    );
  }

  async saveRole(input: {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly category: RoleCategory;
    readonly description?: string | undefined;
    readonly permissions?: readonly string[] | undefined;
  }): Promise<ProjectRoleRecord> {
    const existing = this.role(input.id);
    const duplicate = this.roles().find(
      (role) => role.code === input.code && role.id !== input.id,
    );
    if (duplicate !== undefined) {
      throw new ProjectError("conflict", `角色标识已存在：${input.code}`);
    }
    const timestamp = this.nowIso();
    const record = parseOrInvalid(projectRoleRecordSchema, {
      id: input.id,
      name: input.name,
      code: input.code,
      category: input.category,
      description: input.description ?? existing?.description ?? "",
      permissions:
        input.permissions === undefined || input.permissions.length === 0
          ? (existing?.permissions ?? CATEGORY_PERMISSIONS[input.category])
          : input.permissions,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.tables.roles.put(record.id, record);
    return record;
  }

  async removeRole(id: string): Promise<void> {
    const role = this.role(id);
    if (role === undefined) {
      throw new ProjectError("not_found", "项目角色不存在");
    }
    const used = this.templatesUsingRole(id);
    if (used.length > 0) {
      throw new ProjectError(
        "conflict",
        `该角色仍被 ${used.length} 个项目模版引用，请先在模版中移除`,
      );
    }
    await this.tables.roles.delete(id);
  }

  // --------------------------------------------------------------- templates

  templates(): ProjectTemplateRecord[] {
    return tableValues(this.tables.templates).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  template(id: string): ProjectTemplateRecord | undefined {
    return this.tables.templates.get(id);
  }

  async saveTemplate(input: {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly type: string;
    readonly status: ProjectTemplateRecord["status"];
    readonly description?: string | undefined;
    readonly roleIds?: readonly string[] | undefined;
    readonly workflowTemplateIds?: readonly string[] | undefined;
  }): Promise<ProjectTemplateRecord> {
    const existing = this.template(input.id);
    const duplicate = this.templates().find(
      (template) => template.code === input.code && template.id !== input.id,
    );
    if (duplicate !== undefined) {
      throw new ProjectError("conflict", `模版标识已存在：${input.code}`);
    }
    const roleIds = [...(input.roleIds ?? existing?.roleIds ?? [])];
    for (const roleId of roleIds) {
      if (this.role(roleId) === undefined) {
        throw new ProjectError("invalid_input", `项目角色不存在：${roleId}`);
      }
    }
    const timestamp = this.nowIso();
    const record = parseOrInvalid(projectTemplateRecordSchema, {
      id: input.id,
      name: input.name,
      code: input.code,
      type: input.type,
      status: input.status,
      description: input.description ?? existing?.description ?? "",
      roleIds,
      workflowTemplateIds: [
        ...(input.workflowTemplateIds ?? existing?.workflowTemplateIds ?? []),
      ],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.tables.templates.put(record.id, record);
    return record;
  }

  async removeTemplate(id: string): Promise<void> {
    if (this.template(id) === undefined) {
      throw new ProjectError("not_found", "项目模版不存在");
    }
    await this.tables.templates.delete(id);
  }

  // ----------------------------------------------------------------- reports

  reports(workspaceId: string): ProjectReportRecord[] {
    return tableValues(this.tables.reports)
      .filter((report) => report.workspaceId === workspaceId)
      .sort((left, right) => right.date.localeCompare(left.date));
  }

  report(workspaceId: string, date: string): ProjectReportRecord | undefined {
    return this.reports(workspaceId).find((report) => report.date === date);
  }

  async saveReport(input: {
    readonly workspaceId: string;
    readonly date: string;
    readonly generatedAt: string;
    readonly generatedBy: string;
    readonly content: string;
  }): Promise<ProjectReportRecord> {
    const existing = this.report(input.workspaceId, input.date);
    const record = parseOrInvalid(projectReportRecordSchema, {
      workspaceId: input.workspaceId,
      date: input.date,
      generatedAt: input.generatedAt,
      generatedBy: input.generatedBy,
      content: input.content,
      createdAt: existing?.createdAt ?? this.nowIso(),
    });
    await this.tables.reports.put(
      `${input.workspaceId}::${input.date}`,
      record,
    );
    return record;
  }

  // ------------------------------------------------------------------- audit

  async appendAudit(input: {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly actorPrincipalId?: string | undefined;
    readonly actorName: string;
    readonly actorRole: string;
    readonly category: ProjectAuditCategory;
    readonly action: string;
    readonly targetId?: string | undefined;
    readonly targetName?: string | undefined;
    readonly summary: string;
    readonly detail?: Readonly<Record<string, string>> | undefined;
  }): Promise<ProjectAuditRecord> {
    const timestamp = this.nowIso();
    const sequence = String(this.tables.audit.size + 1).padStart(6, "0");
    const id = `${timestamp}:${sequence}`;
    const record = parseOrInvalid(projectAuditRecordSchema, {
      id,
      workspaceId: input.workspaceId,
      at: timestamp,
      actorId: input.actorId,
      ...(input.actorPrincipalId === undefined
        ? {}
        : { actorPrincipalId: input.actorPrincipalId }),
      actorName: input.actorName,
      actorRole: input.actorRole,
      source: "project",
      category: input.category,
      action: input.action,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.targetName === undefined
        ? {}
        : { targetName: input.targetName }),
      summary: input.summary,
      detail: input.detail ?? {},
      createdAt: timestamp,
    });
    await this.tables.audit.put(
      `${input.workspaceId}::${timestamp}::${sequence}`,
      record,
    );
    return record;
  }

  audits(workspaceId: string, limit = 200): ProjectAuditRecord[] {
    return tableValues(this.tables.audit)
      .filter((event) => event.workspaceId === workspaceId)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit);
  }

  // ------------------------------------------------------------------ seeds

  /** 首次启动写入内置角色库与项目模版；已有数据不做覆盖。 */
  async seedDefaults(): Promise<void> {
    if (this.tables.roles.size === 0) {
      const timestamp = this.nowIso();
      for (const role of SEED_ROLES) {
        await this.tables.roles.put(
          role.id,
          parseOrInvalid(projectRoleRecordSchema, {
            ...role,
            permissions: CATEGORY_PERMISSIONS[role.category],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      }
    }
    if (this.tables.templates.size === 0) {
      const timestamp = this.nowIso();
      for (const template of SEED_TEMPLATES) {
        await this.tables.templates.put(
          template.id,
          parseOrInvalid(projectTemplateRecordSchema, {
            ...template,
            status: "启用",
            workflowTemplateIds: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      }
    }
  }
}

export const projectDomainSpec = {
  name: "collab_project",
  version: 1,
  tables: {
    projects: {
      valueSchema: projectRecordSchema as unknown as z.ZodType<unknown>,
    },
    templates: {
      valueSchema: projectTemplateRecordSchema as unknown as z.ZodType<unknown>,
    },
    roles: {
      valueSchema: projectRoleRecordSchema as unknown as z.ZodType<unknown>,
    },
    reports: {
      valueSchema: projectReportRecordSchema as unknown as z.ZodType<unknown>,
    },
    audit: {
      valueSchema: projectAuditRecordSchema as unknown as z.ZodType<unknown>,
    },
  },
} as const;
