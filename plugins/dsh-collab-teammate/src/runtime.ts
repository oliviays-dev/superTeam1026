import type { Teammate } from "./models.js";
import {
  canManageInstance,
  TeammateError,
  TeammateService,
  TeammateTemplateService,
  type TeammateActor,
  type TeammateEffectiveDefinition,
} from "./service.js";
import type { PrincipalRuntimeService } from "./principal-runtime.js";

export interface PersonaServiceLike {
  get(personaId: string): Promise<unknown>;
  create(input: {
    readonly id: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly soul?: string | undefined;
  }): Promise<unknown>;
  /** 模版里的 SOUL / 场景行为 / 工作目标变化后，回写人格文件。 */
  updateSoul?(personaId: string, soul: string): Promise<unknown>;
}

export interface EmployeeServiceLike {
  list?(): readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
    readonly title?: string | undefined;
    readonly status: string;
    readonly authUserId?: string | undefined;
    readonly personaId?: string | undefined;
    readonly managerEmployeeId?: string | undefined;
  }[];
  /** 身份用户可能在插件启动后才创建，派发执行身份前需要重新同步人类员工档案。 */
  syncIdentityUsers?(
    users: readonly { readonly id: string; readonly name: string }[],
  ): Promise<void>;
  getByAuthUserId(
    authUserId: string,
  ):
    | { readonly id: string; readonly kind: string; readonly status: string }
    | undefined;
  get?(employeeId: string):
    | {
        readonly id: string;
        readonly kind: string;
        readonly displayName: string;
        readonly status: string;
      }
    | undefined;
  createDigital(
    actorAuthUserId: string,
    input: {
      readonly employeeId?: string | undefined;
      readonly displayName: string;
      readonly department?: string | undefined;
      readonly title?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly personaId: string;
      readonly managerEmployeeId: string;
    },
  ): Promise<{ readonly id: string }>;
  changeStatus(
    actorAuthUserId: string,
    employeeId: string,
    status: "draft" | "active" | "suspended" | "archived",
  ): Promise<unknown>;
  assignRole(
    actorAuthUserId: string,
    input: {
      readonly employeeId: string;
      readonly workspaceId: string;
      readonly role: "viewer" | "member" | "owner";
      readonly permissions?: readonly string[] | undefined;
    },
  ): Promise<unknown>;
  upsertRuntimeProfile(
    actorAuthUserId: string,
    input: {
      readonly id?: string | undefined;
      readonly employeeId: string;
      readonly workspaceId: string;
      readonly name: string;
      readonly status?: "active" | "disabled" | undefined;
      readonly legacyAgentProfileId?: string | undefined;
      /** 员工侧工具动作 id（形如 `tool:read`）；空数组表示未配置。 */
      readonly allowedTools?: readonly string[] | undefined;
    },
  ): Promise<{
    readonly id: string;
    readonly legacyAgentProfileId?: string | undefined;
  }>;
  listProfiles?(input: { readonly employeeId: string }): readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly status: string;
    readonly createdBy: string;
    readonly legacyAgentProfileId?: string | undefined;
  }[];
  /** 工作区角色授权：实例所在项目与角色/权限定义。 */
  listRoles?(input?: {
    readonly employeeId?: string | undefined;
    readonly workspaceId?: string | undefined;
  }): readonly {
    readonly id: string;
    readonly employeeId: string;
    readonly workspaceId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly status: string;
    readonly expiresAt?: string | undefined;
  }[];
  revokeRole?(actorAuthUserId: string, assignmentId: string): Promise<unknown>;
  workflowTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: {
          readonly id: string;
          readonly displayName: string;
          readonly personaId?: string | undefined;
        };
        readonly profile: {
          readonly legacyAgentProfileId?: string | undefined;
        };
      }
    | undefined;
}

export interface AgentServiceLike {
  createProfile(
    actor: {
      readonly kind: "user";
      readonly id: string;
      readonly name?: string | undefined;
      readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
      readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
      readonly workspaceId?: string | undefined;
    },
    input: {
      readonly workspaceId: string;
      readonly name: string;
      readonly description?: string | undefined;
      readonly personaId?: string | undefined;
      readonly execution?: "builtin" | "external" | undefined;
      readonly externalRuntimeId?: string | undefined;
      readonly runtimeKind?:
        "task-worker" | "continuable-session" | "connector" | undefined;
      readonly visibility?: "workspace" | "platform" | undefined;
      /** 允许的工具名；空数组 = 不限制（与模版「未限制工具清单」一致）。 */
      readonly allowedTools?: readonly string[] | undefined;
    },
  ): Promise<{ readonly id: string }>;
  profiles?(workspaceId: string): readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly runtimeKind: string;
    readonly status: string;
    readonly allowedTools: readonly string[];
    readonly personaId?: string | undefined;
    readonly execution?: "builtin" | "external" | undefined;
    readonly externalRuntimeId?: string | undefined;
  }[];
  updateProfile?(
    actor: {
      readonly kind: "user";
      readonly id: string;
      readonly name?: string | undefined;
      readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
      readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
      readonly workspaceId?: string | undefined;
    },
    input: {
      readonly workspaceId: string;
      readonly profileId: string;
      readonly status?: "active" | "disabled" | undefined;
      readonly execution?: "builtin" | "external" | undefined;
      readonly externalRuntimeId?: string | null | undefined;
      readonly allowedTools?: readonly string[] | undefined;
    },
  ): Promise<{ readonly id: string; readonly status: string }>;
  /** Trusted internal path; authorization is enforced by the teammate workflow. */
  createRuntimeProfile?(
    actor: {
      readonly kind: "user";
      readonly id: string;
      readonly name?: string | undefined;
      readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
      readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
      readonly workspaceId?: string | undefined;
    },
    input: {
      readonly workspaceId: string;
      readonly name: string;
      readonly description?: string | undefined;
      readonly personaId?: string | undefined;
      readonly execution?: "builtin" | "external" | undefined;
      readonly externalRuntimeId?: string | undefined;
      readonly runtimeKind?:
        "task-worker" | "continuable-session" | "connector" | undefined;
      readonly visibility?: "workspace" | "platform" | undefined;
      readonly allowedTools?: readonly string[] | undefined;
    },
  ): Promise<{ readonly id: string }>;
  /** Trusted internal path; authorization is enforced by the teammate workflow. */
  updateRuntimeProfile?(
    actor: {
      readonly kind: "user";
      readonly id: string;
      readonly name?: string | undefined;
      readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
      readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
      readonly workspaceId?: string | undefined;
    },
    input: {
      readonly workspaceId: string;
      readonly profileId: string;
      readonly status?: "active" | "disabled" | undefined;
      readonly execution?: "builtin" | "external" | undefined;
      readonly externalRuntimeId?: string | null | undefined;
      readonly allowedTools?: readonly string[] | undefined;
    },
  ): Promise<{ readonly id: string; readonly status: string }>;
  runs?(input: {
    readonly workspaceId: string;
    readonly instanceId?: string | undefined;
  }): readonly {
    readonly id: string;
    readonly instanceId: string;
    readonly agentProfileId?: string | undefined;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
    /** 实际执行该 run 的人格；用于识别「任务接收人是人类、但由该 AI伙伴代跑」的情况。 */
    readonly personaId?: string | undefined;
    readonly status: string;
    readonly runSeq: number;
    readonly nodeId: string;
    readonly error?: string | undefined;
    readonly output?: { readonly summary?: string | undefined } | undefined;
    readonly outputTokens?: number | undefined;
    readonly startedAt?: string | undefined;
    readonly endedAt?: string | undefined;
    readonly createdAt: string;
  }[];
}

export interface PrincipalServiceLike {
  syncCompanion(input: {
    readonly teammateId: string;
    readonly employeeId: string;
    readonly displayName?: string | undefined;
  }): Promise<unknown>;
  resolveSubject(
    subjectType: "employee" | "teammate" | "auth-user",
    subjectId: string,
  ):
    | {
        readonly id: string;
        readonly status: "active" | "suspended" | "archived";
      }
    | undefined;
  syncPrincipal(input: {
    readonly kind: "ai";
    readonly subjectType: "teammate";
    readonly subjectId: string;
    readonly displayName: string;
    readonly source: "ai-companion";
  }): Promise<{
    readonly id: string;
    readonly status: "active" | "suspended" | "archived";
  }>;
  revokeMatchingGrants(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
  }): Promise<unknown>;
  grants(principalId?: string): readonly {
    readonly id: string;
    readonly principalId: string;
    readonly scopeType: "platform" | "workspace" | "project";
    readonly scopeId: string;
    readonly role: string;
    readonly status: "active" | "revoked" | "expired";
    readonly expiresAt?: string;
  }[];
}

export interface TeammateRuntimeDeps {
  readonly teammates: TeammateService;
  readonly templates?: () => TeammateTemplateService | undefined;
  readonly personas: () => PersonaServiceLike | undefined;
  readonly employees: () => EmployeeServiceLike | undefined;
  readonly agents: () => AgentServiceLike | undefined;
  readonly principals?: () => PrincipalServiceLike | undefined;
  readonly principalRuntime?: () => PrincipalRuntimeService | undefined;
  readonly users?: () => readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

export interface EnsureRuntimeInput {
  readonly teammateId: string;
  readonly workspaceId: string;
  readonly actor: TeammateActor;
  /**
   * Workspace role comes from the project membership relation. Platform
   * `actor.role` must not be reused here because a platform member can own a
   * project and vice versa.
   */
  readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
  readonly employee?: {
    readonly employeeId?: string | undefined;
    readonly displayName?: string | undefined;
    readonly department?: string | undefined;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly managerEmployeeId?: string | undefined;
  };
}

function runtimeAgentActor(input: EnsureRuntimeInput) {
  const workspaceRole =
    input.workspaceRole ??
    (input.actor.role === "admin" ? undefined : "member");
  return {
    kind: "user" as const,
    id: input.actor.userId,
    name: input.actor.name,
    ...(input.actor.role === "admin"
      ? { globalRole: "admin" as const }
      : workspaceRole === undefined
        ? {}
        : { workspaceRole }),
    workspaceId: input.workspaceId,
  };
}

export interface EnsuredRuntime {
  readonly teammateId: string;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly profileId: string;
  readonly personaId?: string | undefined;
  readonly execution?: "builtin" | "external" | undefined;
  readonly externalRuntimeId?: string | null | undefined;
}

export interface TeammateIdentity {
  readonly teammateId: string;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly workspaceId: string;
  readonly runtimeProfileId: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly runtimeKind: string;
  readonly personaId?: string | undefined;
  readonly execution?: "builtin" | "external" | undefined;
  readonly externalRuntimeId?: string | undefined;
  readonly allowedTools: readonly string[];
  readonly agentStatus: string;
  readonly runtimeStatus: string;
}

export interface TeammateAvailability {
  readonly available: boolean;
  readonly reason?: string | undefined;
}

export interface TeammateArchiveTask {
  readonly id: string;
  readonly status: string;
  readonly receiverType: string;
  readonly receiverId?: string | undefined;
  readonly archivedAt?: string | undefined;
  readonly messages?:
    | readonly {
        readonly runId?: string | undefined;
        readonly state?: string | undefined;
      }[]
    | undefined;
}

export interface TeammateArchiveResult {
  readonly teammate: Teammate;
  readonly transferredTaskIds: readonly string[];
}

export interface TeammateLeaveTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly receiverType: string;
  readonly receiverId?: string | undefined;
  readonly archivedAt?: string | undefined;
}

export interface TeammateLeaveResult {
  readonly revokedAssignments: readonly {
    readonly id: string;
    readonly role: string;
  }[];
  readonly reassignedTaskIds: readonly string[];
  readonly receiver?:
    { readonly id: string; readonly name: string } | undefined;
}

export interface TeammateLiveInstanceCounts {
  readonly liveCount: number;
  readonly ownCount: number;
}

const STATE_LABELS: Record<Teammate["state"], string> = {
  draft: "草稿",
  active: "已生效",
  paused: "已暂停",
  inactive: "已失效",
  archived: "已归档",
};

const ACTIVE_AGENT_RUN_STATES = new Set(["queued", "running", "waiting_input"]);

/** 工具清单规范化：去空、去重、保持书写顺序；空数组 = 不限制。 */
function normalizeTools(tools: readonly string[]): string[] {
  return [
    ...new Set(tools.map((tool) => tool.trim()).filter((tool) => tool !== "")),
  ];
}

/** 数字员工侧的工具动作 id 形如 `tool:read`，模版里填的是裸工具名。 */
function toEmployeeToolActions(tools: readonly string[]): string[] {
  return tools.map((tool) =>
    tool.startsWith("tool:") ? tool : `tool:${tool}`,
  );
}

function sameTools(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  const a = new Set(left ?? []);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * 生效人格文件：SOUL.md 正文 + 「工作场景」「工作目标」两个章节。
 * 场景行为 / 工作目标不再作为独立字段注入，统一并进 persona，运行时只有这一份口径。
 */
function effectiveSoul(definition: TeammateEffectiveDefinition): string {
  const sections: string[] = [];
  const base = definition.soul.trim();
  if (base !== "") sections.push(base);
  const list = (items: readonly string[]): string[] =>
    items.map((item) => item.trim()).filter((item) => item !== "");
  const scenarios = list(definition.scenarios);
  if (scenarios.length > 0) {
    sections.push(
      ["## 工作场景", ...scenarios.map((item) => `- ${item}`)].join("\n"),
    );
  }
  const goals = list(definition.goals);
  if (goals.length > 0) {
    sections.push(
      ["## 工作目标", ...goals.map((item) => `- ${item}`)].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function personaIdFor(teammateId: string): string {
  return `persona-${teammateId.replace(/[^a-zA-Z0-9._-]/g, "-")}`.slice(0, 120);
}

function isLatestRunActive(
  messages:
    | readonly {
        readonly runId?: string | undefined;
        readonly state?: string | undefined;
      }[]
    | undefined,
): boolean {
  const items = messages ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index];
    if (message?.runId !== undefined && message.state !== undefined) {
      return ACTIVE_AGENT_RUN_STATES.has(message.state);
    }
  }
  return false;
}

/**
 * AI Teammate 的运行时开通：teammate 是定义，数字员工 + Agent Profile +
 * 工作区角色 + Runtime Profile 才是可执行身份。同一个 teammate 只开通一次，
 * 之后所有任务复用同一个执行身份。
 */
export class TeammateRuntime {
  constructor(private readonly deps: TeammateRuntimeDeps) {}

  private sourceOf(
    teammate: Pick<Teammate, "source" | "templateId">,
  ): Teammate["source"] {
    const templateId = teammate.templateId;
    const templates = this.deps.templates?.();
    const template =
      templateId === undefined || templates === undefined
        ? undefined
        : templates.get(templateId);
    return template?.source ?? teammate.source;
  }

  private templateActive(
    teammate: Pick<Teammate, "source" | "templateId">,
  ): boolean {
    const templateId = teammate.templateId;
    const templates = this.deps.templates?.();
    const template =
      templateId === undefined || templates === undefined
        ? undefined
        : templates.get(templateId);
    return template === undefined || template.state === "active";
  }

  private ownerDisplayName(
    teammate: Pick<Teammate, "ownerUserId" | "ownerName">,
  ): string {
    if (teammate.ownerUserId === "platform") return teammate.ownerName;
    return (
      this.deps.users?.().find((user) => user.id === teammate.ownerUserId)
        ?.name ?? teammate.ownerName
    );
  }

  /**
   * 员工平台里的数字员工等价于平台归属 AI Teammate：
   * 每次读取列表时把还没有对应定义的数字员工补齐（幂等）。
   */
  async syncFromEmployees(): Promise<void> {
    const employees = this.deps.employees();
    if (employees?.list === undefined) return;
    const roster = employees.list();
    const known = new Set(
      this.deps.teammates
        .list()
        .map((teammate) => teammate.employeeId)
        .filter((value): value is string => value !== undefined),
    );
    const personas = this.deps.personas();
    for (const employee of roster) {
      if (employee.kind !== "digital" || known.has(employee.id)) continue;
      // 实例 owner = 创建人：同步进来的实例归属到该数字员工的负责人（人类账号），
      // 解析不到就按平台托管处理，绝不写死具体用户。
      const manager =
        employee.managerEmployeeId === undefined
          ? undefined
          : roster.find((item) => item.id === employee.managerEmployeeId);
      const ownerUserId = manager?.authUserId;
      let soul: string | undefined;
      if (personas !== undefined && employee.personaId !== undefined) {
        try {
          const persona = (await personas.get(employee.personaId)) as {
            readonly soul?: unknown;
          } | null;
          if (
            persona !== null &&
            typeof persona === "object" &&
            typeof persona.soul === "string"
          ) {
            soul = persona.soul;
          }
        } catch {
          soul = undefined;
        }
      }
      try {
        await this.deps.teammates.importFromEmployee({
          employeeId: employee.id,
          name: employee.displayName,
          role: employee.title ?? "",
          state:
            employee.status === "active"
              ? "active"
              : employee.status === "suspended"
                ? "paused"
                : employee.status === "archived"
                  ? "archived"
                  : "draft",
          ...(soul === undefined ? {} : { soul }),
          ...(employee.personaId === undefined
            ? {}
            : { personaId: employee.personaId }),
          ...(ownerUserId === undefined ? {} : { ownerUserId }),
          ...(manager?.displayName === undefined
            ? {}
            : { ownerName: manager.displayName }),
        });
      } catch {
        // 单个数字员工同步失败不应影响其它员工，也不应让列表接口整体不可用。
      }
    }
    for (const teammate of this.deps.teammates.list()) {
      if (teammate.employeeId === undefined) continue;
      try {
        await this.syncCompanionPrincipal(
          teammate.id,
          teammate.employeeId,
          teammate.name,
        );
      } catch {
        // Principal 映射是增量能力；单个失败不阻塞 AI 伙伴列表。
      }
    }
  }

  async migrateEmployeeIdentities(): Promise<{
    readonly scanned: number;
    readonly migrated: number;
    readonly alreadyMigrated: number;
    readonly skipped: number;
    readonly failed: number;
    readonly issues: readonly {
      readonly teammateId: string;
      readonly employeeId: string;
      readonly reason: string;
    }[];
  }> {
    const employees = this.deps.employees();
    const principals = this.deps.principals?.();
    const principalRuntime = this.deps.principalRuntime?.();
    const agents = this.deps.agents();
    const result = {
      scanned: 0,
      migrated: 0,
      alreadyMigrated: 0,
      skipped: 0,
      failed: 0,
      issues: [] as Array<{
        teammateId: string;
        employeeId: string;
        reason: string;
      }>,
    };
    if (
      employees?.listProfiles === undefined ||
      principals === undefined ||
      principalRuntime === undefined ||
      agents?.profiles === undefined
    ) {
      if (this.deps.teammates.list().some((item) => item.employeeId)) {
        result.failed += 1;
        result.issues.push({
          teammateId: "service",
          employeeId: "",
          reason: "Employee 或 Principal Runtime 服务不可用",
        });
      }
      return result;
    }
    const migrationActor = {
      userId: "platform",
      name: "平台迁移",
      role: "admin" as const,
    };
    for (const teammate of this.deps.teammates.list()) {
      if (teammate.employeeId === undefined) continue;
      result.scanned += 1;
      const principal = principals.resolveSubject(
        "employee",
        teammate.employeeId,
      );
      if (principal === undefined) {
        result.skipped += 1;
        result.issues.push({
          teammateId: teammate.id,
          employeeId: teammate.employeeId,
          reason: "Employee 尚未映射到 Principal",
        });
        continue;
      }
      if (principal.status === "archived") {
        result.skipped += 1;
        result.issues.push({
          teammateId: teammate.id,
          employeeId: teammate.employeeId,
          reason: "AI Principal 已归档，无需迁移运行身份",
        });
        continue;
      }
      const existingProfiles = principalRuntime.profiles({
        principalId: principal.id,
      });
      if (existingProfiles.length > 0) {
        if (teammate.principalId !== principal.id) {
          await this.deps.teammates
            .bindPrincipal(migrationActor, teammate.id, principal.id)
            .catch(() => undefined);
        }
        result.alreadyMigrated += 1;
        continue;
      }
      const legacyProfiles = employees.listProfiles({
        employeeId: teammate.employeeId,
      });
      let migratedProfiles = 0;
      for (const legacy of legacyProfiles) {
        if (legacy.legacyAgentProfileId === undefined) continue;
        const agentProfile = agents
          .profiles(legacy.workspaceId)
          .find((item) => item.id === legacy.legacyAgentProfileId);
        if (agentProfile === undefined) continue;
        try {
          await principalRuntime.ensureProfile({
            principalId: principal.id,
            workspaceId: legacy.workspaceId,
            name: legacy.name,
            ...(agentProfile.personaId === undefined
              ? {}
              : { personaId: agentProfile.personaId }),
            agentProfileId: agentProfile.id,
            execution: agentProfile.execution ?? "builtin",
            allowedTools: agentProfile.allowedTools,
            createdByUserId: teammate.ownerUserId,
            ...(principals.resolveSubject("auth-user", teammate.ownerUserId)
              ?.id === undefined
              ? {}
              : {
                  grantedByPrincipalId: principals.resolveSubject(
                    "auth-user",
                    teammate.ownerUserId,
                  )!.id,
                }),
          });
          migratedProfiles += 1;
        } catch (cause) {
          result.failed += 1;
          result.issues.push({
            teammateId: teammate.id,
            employeeId: teammate.employeeId,
            reason:
              cause instanceof Error
                ? cause.message
                : "Principal Runtime Profile 迁移失败",
          });
        }
      }
      if (migratedProfiles > 0) {
        await this.deps.teammates.bindPrincipal(
          migrationActor,
          teammate.id,
          principal.id,
        );
        result.migrated += 1;
      } else {
        result.skipped += 1;
        result.issues.push({
          teammateId: teammate.id,
          employeeId: teammate.employeeId,
          reason: "没有可迁移的 Employee Runtime Profile",
        });
      }
    }
    return result;
  }

  /** 解析 teammate 当前绑定的执行身份（Agent Profile + Runtime Profile）。 */
  async identityOf(teammateId: string): Promise<TeammateIdentity | undefined> {
    const teammate = this.deps.teammates.get(teammateId);
    const agents = this.deps.agents();
    const principalRuntime = this.deps.principalRuntime?.();
    if (
      teammate.principalId !== undefined &&
      principalRuntime !== undefined &&
      agents?.profiles !== undefined
    ) {
      const runtime = principalRuntime
        .profiles({ principalId: teammate.principalId })
        .find((item) => item.status === "active");
      const profile =
        runtime === undefined
          ? undefined
          : agents
              .profiles(runtime.workspaceId)
              .find((item) => item.id === runtime.agentProfileId);
      if (runtime !== undefined && profile !== undefined) {
        return {
          teammateId: teammate.id,
          principalId: teammate.principalId,
          workspaceId: runtime.workspaceId,
          runtimeProfileId: runtime.id,
          profileId: profile.id,
          profileName: profile.name,
          runtimeKind: profile.runtimeKind,
          ...(profile.personaId === undefined
            ? {}
            : { personaId: profile.personaId }),
          ...(profile.execution === undefined
            ? {}
            : { execution: profile.execution }),
          ...(profile.externalRuntimeId === undefined
            ? {}
            : { externalRuntimeId: profile.externalRuntimeId }),
          allowedTools: profile.allowedTools,
          agentStatus: profile.status,
          runtimeStatus: runtime.status,
        };
      }
    }
    if (teammate.employeeId === undefined) return undefined;
    const employees = this.deps.employees();
    if (
      employees?.listProfiles === undefined ||
      agents?.profiles === undefined
    ) {
      return undefined;
    }
    for (const runtime of employees.listProfiles({
      employeeId: teammate.employeeId,
    })) {
      if (runtime.legacyAgentProfileId === undefined) continue;
      const profile = agents
        .profiles(runtime.workspaceId)
        .find((item) => item.id === runtime.legacyAgentProfileId);
      if (profile === undefined) continue;
      return {
        teammateId: teammate.id,
        employeeId: teammate.employeeId,
        workspaceId: runtime.workspaceId,
        runtimeProfileId: runtime.id,
        profileId: profile.id,
        profileName: profile.name,
        runtimeKind: profile.runtimeKind,
        ...(profile.personaId === undefined
          ? {}
          : { personaId: profile.personaId }),
        ...(profile.execution === undefined
          ? {}
          : { execution: profile.execution }),
        ...(profile.externalRuntimeId === undefined
          ? {}
          : { externalRuntimeId: profile.externalRuntimeId }),
        allowedTools: profile.allowedTools,
        agentStatus: profile.status,
        runtimeStatus: runtime.status,
      };
    }
    return undefined;
  }

  /**
   * 判断 AI伙伴能否在指定项目中真实执行。实例状态为 active 并不够：
   * 已存在但停用的 Agent Profile 仍会让消息在派发阶段失败。
   */
  availabilityOf(
    teammateId: string,
    workspaceId: string,
  ): TeammateAvailability {
    const teammate = this.deps.teammates.get(teammateId);
    if (teammate.state !== "active") {
      return {
        available: false,
        reason: `AI伙伴当前为「${STATE_LABELS[teammate.state]}」`,
      };
    }
    if (!this.templateActive(teammate)) {
      return { available: false, reason: "AI伙伴模版不可用" };
    }
    const principals = this.deps.principals?.();
    if (teammate.principalId !== undefined && principals !== undefined) {
      const principal = principals.resolveSubject("teammate", teammate.id);
      if (principal !== undefined && principal.status !== "active") {
        return { available: false, reason: "AI Principal 不可用" };
      }
    }
    const runtimeProfile =
      teammate.principalId === undefined
        ? undefined
        : this.deps
            .principalRuntime?.()
            ?.profile(teammate.principalId, workspaceId);
    if (runtimeProfile === undefined) {
      // 首次对话时 ensureRuntime 会自动补齐运行时身份。
      return { available: true };
    }
    if (runtimeProfile.status !== "active") {
      return { available: false, reason: "运行时身份已停用" };
    }
    const agentProfile = this.deps
      .agents?.()
      ?.profiles?.(workspaceId)
      .find((profile) => profile.id === runtimeProfile.agentProfileId);
    if (agentProfile === undefined) {
      return { available: false, reason: "Agent Profile 不存在" };
    }
    if (agentProfile.status !== "active") {
      return { available: false, reason: "Agent Profile 已停用" };
    }
    return { available: true };
  }

  /**
   * Live instance requires every execution layer to be active; one workspace
   * contributes at most one live runtime even if legacy data has duplicates.
   */
  async liveInstanceCounts(
    actorUserId: string,
  ): Promise<Map<string, TeammateLiveInstanceCounts>> {
    const result = new Map<string, TeammateLiveInstanceCounts>();
    const employees = this.deps.employees();
    const agents = this.deps.agents();
    const principalRuntime = this.deps.principalRuntime?.();
    if (agents?.profiles === undefined) {
      for (const teammate of this.deps.teammates.list()) {
        result.set(teammate.id, { liveCount: 0, ownCount: 0 });
      }
      return result;
    }

    const activeEmployeeIds = new Set(
      (employees?.list?.() ?? [])
        .filter((employee) => employee.status === "active")
        .map((employee) => employee.id),
    );
    const actorEmployeeId = employees
      ?.list?.()
      .find((employee) => employee.authUserId === actorUserId)?.id;

    for (const teammate of this.deps.teammates.list()) {
      const counts = { liveCount: 0, ownCount: 0 };
      if (
        teammate.state === "active" &&
        teammate.principalId !== undefined &&
        principalRuntime !== undefined
      ) {
        const liveWorkspaces = new Set<string>();
        for (const runtime of principalRuntime.profiles({
          principalId: teammate.principalId,
        })) {
          if (
            runtime.status !== "active" ||
            liveWorkspaces.has(runtime.workspaceId)
          ) {
            continue;
          }
          const profile = agents
            .profiles(runtime.workspaceId)
            .find((item) => item.id === runtime.agentProfileId);
          if (profile?.status !== "active") continue;
          liveWorkspaces.add(runtime.workspaceId);
          counts.liveCount += 1;
          if (runtime.createdByUserId === actorUserId) {
            counts.ownCount += 1;
          }
        }
      }
      if (
        counts.liveCount === 0 &&
        teammate.state === "active" &&
        teammate.employeeId !== undefined &&
        employees?.listProfiles !== undefined &&
        (activeEmployeeIds.size === 0 ||
          activeEmployeeIds.has(teammate.employeeId))
      ) {
        const liveWorkspaces = new Set<string>();
        for (const runtime of employees.listProfiles({
          employeeId: teammate.employeeId,
        })) {
          if (
            runtime.status !== "active" ||
            runtime.legacyAgentProfileId === undefined ||
            liveWorkspaces.has(runtime.workspaceId)
          ) {
            continue;
          }
          const profile = agents
            .profiles(runtime.workspaceId)
            .find((item) => item.id === runtime.legacyAgentProfileId);
          if (profile?.status !== "active") continue;
          liveWorkspaces.add(runtime.workspaceId);
          counts.liveCount += 1;
          if (
            actorEmployeeId !== undefined &&
            runtime.createdBy === actorEmployeeId
          ) {
            counts.ownCount += 1;
          }
        }
      }
      result.set(teammate.id, counts);
    }
    return result;
  }

  /** 切换执行身份状态，并让 teammate 状态与之联动。 */
  async setIdentityStatus(input: {
    readonly teammateId: string;
    readonly status: "active" | "disabled";
    readonly actor: TeammateActor;
  }): Promise<TeammateIdentity | undefined> {
    const teammate = this.deps.teammates.get(input.teammateId);
    const identity = await this.identityOf(input.teammateId);
    if (identity === undefined) return undefined;
    await this.deps.agents?.()?.updateProfile?.(
      {
        kind: "user",
        id: input.actor.userId,
        name: input.actor.name,
        globalRole: input.actor.role,
      },
      {
        workspaceId: identity.workspaceId,
        profileId: identity.profileId,
        status: input.status,
      },
    );
    if (identity.principalId !== undefined) {
      const principalRuntime = this.deps.principalRuntime?.();
      if (principalRuntime === undefined) {
        throw new TeammateError("conflict", "Principal Runtime 服务不可用");
      }
      await principalRuntime.setProfileStatus(
        identity.runtimeProfileId,
        input.status,
      );
    } else if (identity.employeeId !== undefined) {
      await this.deps
        .employees?.()
        ?.upsertRuntimeProfile?.(input.actor.userId, {
          id: identity.runtimeProfileId,
          employeeId: identity.employeeId,
          workspaceId: identity.workspaceId,
          name: identity.profileName,
          status: input.status,
          legacyAgentProfileId: identity.profileId,
        });
    }
    const nextState = input.status === "active" ? "active" : "paused";
    if (teammate.state !== nextState) {
      try {
        await this.deps.teammates.changeState(input.actor, {
          teammateId: teammate.id,
          state: nextState,
        });
      } catch {
        // 状态机不允许时忽略，避免身份切换被阻断。
      }
    }
    return this.identityOf(input.teammateId);
  }

  /**
   * 归档运行态实例：先把仍在进行中的工作转给 Owner，再停用执行身份。
   * 已完成或已取消的任务保留原责任人，作为历史归属记录。
   */
  async archiveInstance(input: {
    readonly teammateId: string;
    readonly actor: TeammateActor;
    readonly tasks: readonly TeammateArchiveTask[];
    readonly ownerName?: string | undefined;
    readonly assignTask: (input: {
      readonly taskId: string;
      readonly receiverType: "human";
      readonly receiverId: string;
      readonly receiverName: string;
    }) => Promise<unknown>;
  }): Promise<TeammateArchiveResult> {
    const teammate = this.deps.teammates.get(input.teammateId);
    // 归档的是实例：实例 owner 或平台管理员都可以，不看模版的平台归属。
    if (!canManageInstance(teammate, input.actor)) {
      throw new TeammateError("forbidden", "没有权限归档该 AI伙伴");
    }
    if (teammate.state === "archived") {
      return { teammate, transferredTaskIds: [] };
    }

    const identity = await this.identityOf(teammate.id);
    const runningReceivers = new Set(
      input.tasks
        .filter(
          (task) =>
            task.receiverType === "agent" &&
            task.archivedAt === undefined &&
            isLatestRunActive(task.messages),
        )
        .map((task) => task.receiverId),
    );
    const agentRuns =
      identity === undefined
        ? []
        : (this.deps
            .agents?.()
            ?.runs?.({ workspaceId: identity.workspaceId }) ?? []);
    const hasActiveRun =
      identity !== undefined &&
      (agentRuns ?? []).some(
        (run) =>
          ((identity.employeeId !== undefined &&
            run.employeeId === identity.employeeId) ||
            (identity.principalId !== undefined &&
              run.principalId === identity.principalId)) &&
          ACTIVE_AGENT_RUN_STATES.has(run.status),
      );
    if (
      hasActiveRun ||
      runningReceivers.has(teammate.id) ||
      (teammate.employeeId !== undefined &&
        runningReceivers.has(teammate.employeeId))
    ) {
      throw new TeammateError(
        "conflict",
        `AI伙伴「${teammate.name}」仍在运行中，请等任务结束或先处理等待输入的任务`,
      );
    }

    const receiverId = teammate.ownerUserId;
    const receiverName =
      input.ownerName?.trim() || this.ownerDisplayName(teammate);
    const transferIds: string[] = [];
    for (const task of input.tasks) {
      const ownedByInstance =
        task.receiverType === "agent" &&
        task.archivedAt === undefined &&
        task.status !== "done" &&
        task.status !== "cancelled" &&
        (task.receiverId === teammate.id ||
          (teammate.employeeId !== undefined &&
            task.receiverId === teammate.employeeId));
      if (!ownedByInstance) continue;
      await input.assignTask({
        taskId: task.id,
        receiverType: "human",
        receiverId,
        receiverName,
      });
      transferIds.push(task.id);
    }

    const employees = this.deps.employees();
    const agents = this.deps.agents();
    const principalRuntime = this.deps.principalRuntime?.();
    if (
      identity?.principalId !== undefined &&
      agents?.profiles !== undefined &&
      agents.updateProfile !== undefined &&
      principalRuntime !== undefined
    ) {
      const actor = {
        kind: "user" as const,
        id: input.actor.userId,
        name: input.actor.name,
        globalRole: input.actor.role,
      };
      for (const runtime of principalRuntime.profiles({
        principalId: identity.principalId,
      })) {
        const profile = agents
          .profiles(runtime.workspaceId)
          .find((item) => item.id === runtime.agentProfileId);
        if (profile !== undefined) {
          await agents.updateProfile(actor, {
            workspaceId: runtime.workspaceId,
            profileId: profile.id,
            status: "disabled",
          });
        }
        await principalRuntime.setProfileStatus(runtime.id, "disabled");
        await this.deps.principals?.()?.revokeMatchingGrants({
          principalId: identity.principalId,
          scopeType: "workspace",
          scopeId: runtime.workspaceId,
          role: "workspace-member",
        });
      }
    }
    if (
      identity !== undefined &&
      identity.employeeId !== undefined &&
      agents?.profiles !== undefined &&
      agents.updateProfile !== undefined &&
      employees?.listProfiles !== undefined &&
      employees.upsertRuntimeProfile !== undefined
    ) {
      const actor = {
        kind: "user" as const,
        id: input.actor.userId,
        name: input.actor.name,
        globalRole: input.actor.role,
      };
      for (const runtime of employees.listProfiles({
        employeeId: identity.employeeId,
      })) {
        if (runtime.legacyAgentProfileId === undefined) continue;
        const profile = agents
          .profiles(runtime.workspaceId)
          .find((item) => item.id === runtime.legacyAgentProfileId);
        if (profile === undefined) continue;
        await agents.updateProfile(actor, {
          workspaceId: runtime.workspaceId,
          profileId: profile.id,
          status: "disabled",
        });
        await employees.upsertRuntimeProfile(input.actor.userId, {
          id: runtime.id,
          employeeId: identity.employeeId,
          workspaceId: runtime.workspaceId,
          name: identity.profileName,
          status: "disabled",
          legacyAgentProfileId: profile.id,
        });
      }
    }

    if (identity !== undefined) {
      if (identity.employeeId !== undefined) {
        await employees?.changeStatus(
          input.actor.userId,
          identity.employeeId,
          "archived",
        );
      }
    }

    const archived = await this.deps.teammates.archiveInstanceRecord(
      input.actor,
      teammate.id,
    );
    return { teammate: archived, transferredTaskIds: transferIds };
  }

  /**
   * 让实例退出项目或项目里的某个角色：撤销员工档案上的工作区角色授权。
   * 退出整个项目时，该项目里尚未完成且指派给该实例的任务会改派给指定的人
   * （默认是实例 owner，实例 owner 不是项目成员时由调用方换成项目 owner）。
   */
  async leaveWorkspace(input: {
    readonly teammateId: string;
    readonly workspaceId: string;
    readonly actor: TeammateActor;
    /** 工作区 owner 或平台管理员，可以代替实例 owner 操作。 */
    readonly canManageWorkspace: boolean;
    /** 传入表示只退出这一条角色授权，否则退出该项目下全部生效授权。 */
    readonly assignmentId?: string | undefined;
    /** 未完成任务的改派目标；缺省表示本次不改派任务。 */
    readonly reassignTo?:
      { readonly id: string; readonly name: string } | undefined;
    readonly tasks: readonly TeammateLeaveTask[];
    readonly assignTask: (input: {
      readonly taskId: string;
      readonly receiverType: "human";
      readonly receiverId: string;
      readonly receiverName: string;
    }) => Promise<unknown>;
  }): Promise<TeammateLeaveResult> {
    const teammate = this.deps.teammates.get(input.teammateId);
    // 实例归创建人所有，模版的平台归属不参与这里的判定。
    if (
      !canManageInstance(teammate, input.actor) &&
      !input.canManageWorkspace
    ) {
      throw new TeammateError(
        "forbidden",
        "只有 AI伙伴负责人、项目 owner 或平台管理员可以让它退出项目",
      );
    }
    const nowMs = Date.now();
    const revoked: { id: string; role: string }[] = [];
    if (teammate.principalId !== undefined) {
      const principals = this.deps.principals?.();
      const grants =
        principals
          ?.grants(teammate.principalId)
          .filter(
            (grant) =>
              grant.status === "active" &&
              grant.scopeType === "workspace" &&
              grant.scopeId === input.workspaceId &&
              (grant.expiresAt === undefined ||
                (Number.isFinite(Date.parse(grant.expiresAt)) &&
                  Date.parse(grant.expiresAt) > nowMs)) &&
              (input.assignmentId === undefined ||
                grant.id === input.assignmentId),
          ) ?? [];
      if (grants.length === 0) {
        throw new TeammateError(
          "not_found",
          "该项目下没有可退出的生效角色授权",
        );
      }
      for (const grant of grants) {
        await principals?.revokeMatchingGrants({
          principalId: grant.principalId,
          scopeType: "workspace",
          scopeId: grant.scopeId,
          role: grant.role,
        });
        revoked.push({ id: grant.id, role: grant.role });
      }
    } else {
      const employees = this.deps.employees();
      const employeeId = teammate.employeeId;
      if (
        employeeId === undefined ||
        employees?.listRoles === undefined ||
        employees.revokeRole === undefined
      ) {
        throw new TeammateError(
          "invalid_input",
          "该 AI伙伴还没有绑定执行身份，无法维护项目角色",
        );
      }
      const active = employees
        .listRoles({ employeeId, workspaceId: input.workspaceId })
        .filter(
          (assignment) =>
            assignment.status === "active" &&
            (assignment.expiresAt === undefined ||
              (Number.isFinite(Date.parse(assignment.expiresAt)) &&
                Date.parse(assignment.expiresAt) > nowMs)),
        );
      const targets =
        input.assignmentId === undefined
          ? active
          : active.filter((assignment) => assignment.id === input.assignmentId);
      if (targets.length === 0) {
        throw new TeammateError(
          "not_found",
          "该项目下没有可退出的生效角色授权",
        );
      }
      for (const assignment of targets) {
        await employees.revokeRole(input.actor.userId, assignment.id);
        revoked.push({ id: assignment.id, role: assignment.role });
      }
    }

    const reassignedTaskIds: string[] = [];
    const receiver = input.reassignTo;
    if (receiver !== undefined) {
      for (const task of input.tasks) {
        const ownedByInstance =
          task.workspaceId === input.workspaceId &&
          task.receiverType === "agent" &&
          task.archivedAt === undefined &&
          task.status !== "done" &&
          task.status !== "cancelled" &&
          (task.receiverId === teammate.id ||
            (teammate.employeeId !== undefined &&
              task.receiverId === teammate.employeeId));
        if (!ownedByInstance) continue;
        await input.assignTask({
          taskId: task.id,
          receiverType: "human",
          receiverId: receiver.id,
          receiverName: receiver.name,
        });
        reassignedTaskIds.push(task.id);
      }
    }
    return {
      revokedAssignments: revoked,
      reassignedTaskIds,
      ...(receiver === undefined ? {} : { receiver }),
    };
  }

  /**
   * 可被指派的实例投影。归属看模版；ownerName 永远表示实例创建人。
   * 字段集是 task / workflow 的跨插件契约，不在投影外暴露模版对象。
   */
  assignable(actor: TeammateActor): readonly {
    readonly id: string;
    readonly name: string;
    readonly ownerUserId: string;
    readonly ownerName: string;
    readonly source: Teammate["source"];
    readonly avatar: string;
    readonly employeeId?: string | undefined;
    readonly execution?: "builtin" | "external" | undefined;
    readonly externalRuntimeId?: string | undefined;
  }[] {
    return this.deps.teammates
      .list()
      .filter((teammate) => this.templateActive(teammate))
      .filter(
        (teammate) =>
          teammate.state === "active" &&
          (this.sourceOf(teammate) === "platform" ||
            teammate.ownerUserId === actor.userId),
      )
      .map((teammate) => ({
        id: teammate.id,
        name: teammate.name,
        ownerUserId: teammate.ownerUserId,
        ownerName: this.ownerDisplayName(teammate),
        source: this.sourceOf(teammate),
        avatar: teammate.avatar,
        ...(teammate.employeeId === undefined
          ? {}
          : { employeeId: teammate.employeeId }),
        ...(teammate.execution === undefined
          ? {}
          : { execution: teammate.execution }),
        ...(teammate.externalRuntimeId === undefined
          ? {}
          : { externalRuntimeId: teammate.externalRuntimeId }),
      }));
  }

  /**
   * 任务回写用：按 teammate 实例 id 或员工身份 id 解析该实例的 owner（实例创建人）。
   * 模版的平台归属不代表实例归属，实例归属始终看实例创建人。
   */
  ownerOf(
    ref: string,
  ): { readonly userId: string; readonly name: string } | undefined {
    const teammate = this.deps.teammates
      .list()
      .find((item) => item.id === ref || item.employeeId === ref);
    if (teammate === undefined) return undefined;
    const userId = teammate.ownerUserId.trim();
    if (userId === "" || userId === "platform" || userId === "system") {
      return undefined;
    }
    return { userId, name: this.ownerDisplayName(teammate) };
  }

  /**
   * Owner visibility is modeled as a set even though current data has one
   * owner. Future shared-Agent ownership can add members without changing
   * memory or private-chat authorization callers.
   */
  ownersOf(
    ref: string,
  ): readonly { readonly userId: string; readonly name: string }[] {
    const owner = this.ownerOf(ref);
    return owner === undefined ? [] : [owner];
  }

  /**
   * 人格文件回写：SOUL.md 正文 + 「工作场景」「工作目标」两个章节。
   * 场景行为 / 工作目标不再作为独立字段注入，运行时只有这一个人格口径；
   * 模版改过之后，老实例在下一次派发时自动对齐。
   */
  private async syncPersona(
    personaId: string,
    definition: TeammateEffectiveDefinition,
  ): Promise<void> {
    const personas = this.deps.personas();
    if (personas === undefined) return;
    const soul = effectiveSoul(definition);
    let current: string | undefined;
    try {
      const existing = await personas.get(personaId);
      if (
        existing !== null &&
        typeof existing === "object" &&
        typeof (existing as { readonly soul?: unknown }).soul === "string"
      ) {
        current = (existing as { readonly soul: string }).soul;
      }
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      await personas.create({
        id: personaId,
        name: definition.name,
        description: definition.description,
        tags: [],
        soul,
      });
      return;
    }
    if (current !== soul && personas.updateSoul !== undefined) {
      await personas.updateSoul(personaId, soul);
    }
  }

  /**
   * 数字员工 runtime profile 的工具清单：员工侧用 `tool:xxx` 形态的 action id，
   * 这里把模版里的裸工具名映射过去，保证两侧口径一致。
   */
  private async syncEmployeeTools(
    employees: EmployeeServiceLike,
    actorUserId: string,
    employeeId: string,
    workspaceId: string,
    name: string,
    tools: readonly string[],
  ): Promise<void> {
    if (
      employees.listProfiles === undefined ||
      employees.upsertRuntimeProfile === undefined
    ) {
      return;
    }
    const allowedTools = toEmployeeToolActions(tools);
    for (const runtime of employees.listProfiles({ employeeId })) {
      if (runtime.workspaceId !== workspaceId || runtime.status !== "active") {
        continue;
      }
      await employees.upsertRuntimeProfile(actorUserId, {
        id: runtime.id,
        employeeId,
        workspaceId,
        name,
        allowedTools,
      });
    }
  }

  private async syncCompanionPrincipal(
    teammateId: string,
    employeeId: string,
    displayName?: string,
  ): Promise<void> {
    const principals = this.deps.principals?.();
    if (principals === undefined) return;
    await principals.syncCompanion({
      teammateId,
      employeeId,
      ...(displayName === undefined ? {} : { displayName }),
    });
  }

  async ensureRuntime(input: EnsureRuntimeInput): Promise<EnsuredRuntime> {
    const teammate = this.deps.teammates.get(input.teammateId);
    if (teammate.state !== "active") {
      throw new TeammateError(
        "conflict",
        `AI伙伴「${teammate.name}」当前为「${STATE_LABELS[teammate.state]}」，请先生效后再派发`,
      );
    }
    if (!this.templateActive(teammate)) {
      throw new TeammateError(
        "conflict",
        `AI伙伴「${teammate.name}」使用的模版已停用，不能发起新的派发`,
      );
    }
    const definition = this.deps.teammates.effectiveDefinitionOf(teammate);
    // 模版里的工具清单：空 = 不限制，非空 = 只允许这些（与 UI 文案一致）。
    const allowedTools = normalizeTools(definition.tools);
    const execution = teammate.execution ?? "builtin";
    const externalRuntimeId =
      execution === "external" ? teammate.externalRuntimeId : undefined;
    const personaId =
      teammate.personaId ??
      definition.personaAlias ??
      personaIdFor(teammate.id);
    const personas = this.deps.personas();
    const employees = this.deps.employees();
    const principals = this.deps.principals?.();
    const principalRuntime = this.deps.principalRuntime?.();
    const existingPrincipal =
      teammate.principalId === undefined
        ? undefined
        : principals?.resolveSubject("teammate", teammate.id);
    const existingPrincipalProfile =
      existingPrincipal === undefined
        ? undefined
        : principalRuntime?.profile(existingPrincipal.id, input.workspaceId);
    if (
      existingPrincipal !== undefined &&
      existingPrincipalProfile !== undefined &&
      existingPrincipal.status === "active"
    ) {
      const agents = this.deps.agents();
      const agentProfile = agents
        ?.profiles?.(input.workspaceId)
        .find(
          (profile) => profile.id === existingPrincipalProfile.agentProfileId,
        );
      if (agents !== undefined && agentProfile !== undefined) {
        const updateProfile =
          agents.updateRuntimeProfile ?? agents.updateProfile;
        if (updateProfile !== undefined) {
          await updateProfile.call(agents, runtimeAgentActor(input), {
            workspaceId: input.workspaceId,
            profileId: agentProfile.id,
            status: "active",
            execution,
            ...(externalRuntimeId === undefined
              ? { externalRuntimeId: null }
              : { externalRuntimeId }),
            allowedTools,
          });
        }
        await principalRuntime?.ensureProfile({
          principalId: existingPrincipal.id,
          workspaceId: input.workspaceId,
          name: definition.name,
          ...(existingPrincipalProfile.personaId === undefined
            ? { personaId }
            : { personaId: existingPrincipalProfile.personaId }),
          agentProfileId: agentProfile.id,
          execution,
          allowedTools,
          createdByUserId: input.actor.userId,
          ...(principals?.resolveSubject("auth-user", input.actor.userId)
            ?.id === undefined
            ? {}
            : {
                grantedByPrincipalId: principals!.resolveSubject(
                  "auth-user",
                  input.actor.userId,
                )!.id,
              }),
        });
        if (personas !== undefined) {
          await this.syncPersona(
            existingPrincipalProfile.personaId ?? personaId,
            definition,
          );
        }
        return {
          teammateId: teammate.id,
          principalId: existingPrincipal.id,
          profileId: agentProfile.id,
          execution,
          ...(externalRuntimeId === undefined ? {} : { externalRuntimeId }),
          ...(existingPrincipalProfile.personaId === undefined
            ? { personaId }
            : { personaId: existingPrincipalProfile.personaId }),
        };
      }
    }
    if (
      existingPrincipal !== undefined &&
      existingPrincipal.status !== "active"
    ) {
      throw new TeammateError(
        "conflict",
        `AI Principal 当前状态为 ${existingPrincipal.status}，请先恢复后再派发`,
      );
    }
    if (
      teammate.employeeId !== undefined &&
      teammate.principalId === undefined
    ) {
      if (employees === undefined) {
        throw new TeammateError("conflict", "员工兼容服务不可用，无法派发任务");
      }
      // 身份用户常在本插件启动之后才创建，这里先同步一次人类员工档案。
      await employees.syncIdentityUsers?.(this.deps.users?.() ?? []);
      const existing = employees.workflowTarget(
        teammate.employeeId,
        input.workspaceId,
      );
      const profileId = existing?.profile.legacyAgentProfileId;
      if (existing !== undefined && profileId !== undefined) {
        const agents = this.deps.agents();
        const profile = agents
          ?.profiles?.(input.workspaceId)
          .find((item) => item.id === profileId);
        const toolsChanged = !sameTools(profile?.allowedTools, allowedTools);
        const updateProfile =
          agents?.updateRuntimeProfile ?? agents?.updateProfile;
        if (
          agents !== undefined &&
          updateProfile !== undefined &&
          (profile?.execution !== execution ||
            profile?.externalRuntimeId !== externalRuntimeId ||
            toolsChanged)
        ) {
          await updateProfile.call(agents, runtimeAgentActor(input), {
            workspaceId: input.workspaceId,
            profileId,
            status: "active",
            execution,
            ...(externalRuntimeId === undefined
              ? { externalRuntimeId: null }
              : { externalRuntimeId }),
            allowedTools,
          });
        }
        // 人格（SOUL + 工作场景 + 工作目标）与数字员工 runtime profile 同步：
        // 模版改过之后，老实例在下一次派发时自动对齐。
        await this.syncPersona(
          existing.employee.personaId ?? personaId,
          definition,
        );
        await this.syncEmployeeTools(
          employees,
          input.actor.userId,
          teammate.employeeId,
          input.workspaceId,
          definition.name,
          allowedTools,
        );
        await this.syncCompanionPrincipal(teammate.id, teammate.employeeId);
        const principalId = this.deps
          .principals?.()
          ?.resolveSubject("employee", teammate.employeeId)?.id;
        return {
          teammateId: teammate.id,
          employeeId: teammate.employeeId,
          ...(principalId === undefined ? {} : { principalId }),
          profileId,
          execution,
          ...(externalRuntimeId === undefined ? {} : { externalRuntimeId }),
          ...(existing.employee.personaId === undefined
            ? {}
            : { personaId: existing.employee.personaId }),
        };
      }
      /*
       * 已有员工身份、但目标项目还没有 Runtime Profile：复用同一个员工，
       * 只为该项目补「角色授权 + Runtime Profile（含 Agent Profile 映射）」，
       * 不再新建身份、也不改写 teammate.employeeId，避免同一实例出现多个身份、
       * 把历史任务与会话拆到不同 employeeId 上。
       */
      const employeeId = teammate.employeeId;
      const employeeRecord = employees
        .list?.()
        .find((item) => item.id === employeeId);
      if (employeeRecord !== undefined && employeeRecord.kind === "digital") {
        if (employeeRecord.status !== "active") {
          throw new TeammateError(
            "conflict",
            `AI伙伴「${teammate.name}」的运行身份已停用，请先启用后再派发`,
          );
        }
        const reuseAgents = this.deps.agents();
        if (personas === undefined || reuseAgents === undefined) {
          throw new TeammateError(
            "conflict",
            personas === undefined
              ? "人设服务不可用，无法开通执行身份"
              : "Agent 注册表不可用，无法开通执行身份",
          );
        }
        const ownerAuthUserId =
          teammate.ownerUserId === "platform" ||
          teammate.ownerUserId === "system"
            ? input.actor.userId
            : teammate.ownerUserId;
        const owner = employees.getByAuthUserId(ownerAuthUserId);
        if (
          owner === undefined ||
          owner.kind !== "human" ||
          owner.status !== "active"
        ) {
          throw new TeammateError(
            "conflict",
            teammate.ownerUserId === "platform" ||
              teammate.ownerUserId === "system"
              ? "当前操作者没有可用的员工档案，无法开通执行身份"
              : "该 AI伙伴负责人没有可用的员工档案，无法开通执行身份",
          );
        }
        const workspacePersonaId = employeeRecord.personaId ?? personaId;
        await this.syncPersona(workspacePersonaId, definition);
        // 同一 persona 已有 Profile 时直接复用，避免重复建档。
        const reusableProfile = reuseAgents
          .profiles?.(input.workspaceId)
          .find((item) => item.personaId === workspacePersonaId);
        const createProfile =
          reuseAgents.createRuntimeProfile ?? reuseAgents.createProfile;
        const workspaceProfile =
          reusableProfile ??
          (await createProfile.call(
            reuseAgents,
            {
              ...runtimeAgentActor(input),
              id: ownerAuthUserId,
            },
            {
              workspaceId: input.workspaceId,
              name: definition.name,
              description: definition.description,
              personaId: workspacePersonaId,
              ...(teammate.execution === undefined
                ? {}
                : { execution: teammate.execution }),
              ...(teammate.externalRuntimeId === undefined
                ? {}
                : { externalRuntimeId: teammate.externalRuntimeId }),
              runtimeKind: "task-worker",
              visibility:
                definition.source === "platform" ? "platform" : "workspace",
              allowedTools,
            },
          ));
        await employees.assignRole(ownerAuthUserId, {
          employeeId,
          workspaceId: input.workspaceId,
          role: "member",
        });
        const workspaceRuntime = await employees.upsertRuntimeProfile(
          ownerAuthUserId,
          {
            employeeId,
            workspaceId: input.workspaceId,
            name: definition.name,
            legacyAgentProfileId: workspaceProfile.id,
            allowedTools: toEmployeeToolActions(allowedTools),
          },
        );
        await this.syncEmployeeTools(
          employees,
          input.actor.userId,
          employeeId,
          input.workspaceId,
          definition.name,
          allowedTools,
        );
        await this.syncCompanionPrincipal(
          teammate.id,
          employeeId,
          employeeRecord.displayName,
        );
        const principalId = this.deps
          .principals?.()
          ?.resolveSubject("employee", employeeId)?.id;
        return {
          teammateId: teammate.id,
          employeeId,
          ...(principalId === undefined ? {} : { principalId }),
          profileId:
            workspaceRuntime.legacyAgentProfileId ?? workspaceProfile.id,
          execution,
          ...(externalRuntimeId === undefined ? {} : { externalRuntimeId }),
          ...(employeeRecord.personaId === undefined
            ? {}
            : { personaId: employeeRecord.personaId }),
        };
      }
    }

    const agents = this.deps.agents();
    if (personas === undefined) {
      throw new TeammateError("conflict", "人设服务不可用，无法开通执行身份");
    }
    if (agents === undefined) {
      throw new TeammateError(
        "conflict",
        "Agent 注册表不可用，无法开通执行身份",
      );
    }

    if (principalRuntime === undefined || principals === undefined) {
      throw new TeammateError(
        "conflict",
        "Principal Runtime 服务不可用，无法开通执行身份",
      );
    }
    const managerAuthUserId =
      teammate.ownerUserId === "platform" || teammate.ownerUserId === "system"
        ? input.actor.userId
        : teammate.ownerUserId;
    let principal = principals.resolveSubject("teammate", teammate.id);
    if (principal === undefined) {
      principal = await principals.syncPrincipal({
        kind: "ai",
        subjectType: "teammate",
        subjectId: teammate.id,
        displayName: input.employee?.displayName ?? definition.name,
        source: "ai-companion",
      });
    }
    if (principal.status !== "active") {
      throw new TeammateError(
        "conflict",
        `AI Principal 当前状态为 ${principal.status}，请先恢复后再派发`,
      );
    }
    await this.deps.teammates.bindPrincipal(
      input.actor,
      teammate.id,
      principal.id,
    );

    await this.syncPersona(personaId, definition);

    const existingRuntimeProfile = principalRuntime
      .profiles({ principalId: principal.id })
      .find((runtime) => runtime.workspaceId === input.workspaceId);
    let profileId =
      existingRuntimeProfile === undefined
        ? undefined
        : agents
            .profiles?.(input.workspaceId)
            .find(
              (candidate) =>
                candidate.id === existingRuntimeProfile.agentProfileId,
            )?.id;
    profileId ??= agents
      .profiles?.(input.workspaceId)
      .find((candidate) => candidate.personaId === personaId)?.id;
    const updateProfile = agents.updateRuntimeProfile ?? agents.updateProfile;
    if (profileId !== undefined && updateProfile !== undefined) {
      await updateProfile.call(
        agents,
        {
          ...runtimeAgentActor(input),
          id: managerAuthUserId,
        },
        {
          workspaceId: input.workspaceId,
          profileId,
          status: "active",
          execution,
          ...(externalRuntimeId === undefined
            ? { externalRuntimeId: null }
            : { externalRuntimeId }),
          allowedTools,
        },
      );
    } else if (profileId === undefined) {
      const createProfile = agents.createRuntimeProfile ?? agents.createProfile;
      const created = await createProfile.call(
        agents,
        {
          ...runtimeAgentActor(input),
          id: managerAuthUserId,
        },
        {
          workspaceId: input.workspaceId,
          name: definition.name,
          description: definition.description,
          personaId,
          ...(teammate.execution === undefined
            ? {}
            : { execution: teammate.execution }),
          ...(teammate.externalRuntimeId === undefined
            ? {}
            : { externalRuntimeId: teammate.externalRuntimeId }),
          runtimeKind: "task-worker",
          visibility:
            definition.source === "platform" ? "platform" : "workspace",
          // 空清单 = 不限制；非空才会收窄工具集。
          allowedTools,
        },
      );
      profileId = created.id;
    }
    const grantor = principals.resolveSubject("auth-user", managerAuthUserId);
    const runtime = await principalRuntime.ensureProfile({
      principalId: principal.id,
      workspaceId: input.workspaceId,
      name: definition.name,
      ...(personaId === undefined ? {} : { personaId }),
      agentProfileId: profileId!,
      execution,
      allowedTools,
      createdByUserId: managerAuthUserId,
      ...(grantor === undefined ? {} : { grantedByPrincipalId: grantor.id }),
    });
    return {
      teammateId: teammate.id,
      principalId: principal.id,
      profileId: runtime.agentProfileId,
      execution,
      ...(externalRuntimeId === undefined ? {} : { externalRuntimeId }),
      personaId,
    };
  }
}
