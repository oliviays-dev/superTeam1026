import { createHash, randomUUID } from "node:crypto";
import {
  actionTicketSchema,
  auditEventSchema,
  delegationReportSchema,
  delegationSchema,
  employeePrincipalSchema,
  employeeSchema,
  roleAssignmentSchema,
  runtimeProfileSchema,
  type ActionTicket,
  type AuditEvent,
  type ContextType,
  type Delegation,
  type DelegationReport,
  type Employee,
  type EmployeePrincipal,
  type EmployeeStatus,
  type RoleAssignment,
  type RuntimeProfile,
  type WorkspaceRole,
} from "./models.js";

export interface PublicEmployee {
  readonly id: string;
  readonly principalId?: string;
  readonly kind: Employee["kind"];
  readonly displayName: string;
  readonly email?: string;
  readonly department: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly personaId?: string;
  readonly authUserId?: string;
  readonly authStatus?: "active" | "disabled";
  readonly managerEmployeeId?: string;
  readonly status: EmployeeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicIdentityUser {
  readonly id: string;
  readonly name: string;
  readonly status?: "active" | "disabled";
}

export interface TeamPrincipalLike {
  readonly userId: string;
  readonly role: "admin" | "owner" | "member" | "guest";
}

export interface IdentityServiceLike {
  resolveToken(token: string): TeamPrincipalLike | undefined;
  users(): readonly PublicIdentityUser[];
  updateUser(
    actorId: string,
    targetId: string,
    changes: { readonly status?: "active" | "disabled" },
  ): Promise<unknown>;
}

export class EmployeeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "gone",
    message: string,
  ) {
    super(message);
    this.name = "EmployeeError";
  }
}

interface SchemaLike<V> {
  safeParse(value: unknown): { success: boolean; data?: V };
}

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete?(key: string): Promise<boolean>;
}

export interface EmployeeTables {
  readonly employees: KvTableLike<Employee>;
  readonly roleAssignments: KvTableLike<RoleAssignment>;
  readonly runtimeProfiles: KvTableLike<RuntimeProfile>;
  readonly delegations: KvTableLike<Delegation>;
  readonly delegationReports: KvTableLike<DelegationReport>;
  readonly actionTickets: KvTableLike<ActionTicket>;
  readonly auditEvents: KvTableLike<AuditEvent>;
}

export interface EmployeeServiceOptions {
  readonly now?: () => Date;
  readonly personas?: () => PersonaServiceLike | undefined;
}

export interface PersonaServiceLike {
  get(personaId: string): Promise<unknown>;
}

export interface PrincipalServiceLike {
  syncEmployee(input: {
    readonly employeeId: string;
    readonly kind: "human" | "digital";
    readonly displayName: string;
    readonly status: "draft" | "active" | "suspended" | "archived";
    readonly authUserId?: string | undefined;
    readonly authStatus?: "active" | "disabled" | undefined;
  }): Promise<unknown>;
  resolveSubject(
    subjectType: "employee",
    subjectId: string,
  ): {
    readonly id: string;
    readonly kind: "human" | "ai";
    readonly status: "active" | "suspended" | "archived";
  } | undefined;
  syncGrant(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly grantedByPrincipalId?: string;
  }): Promise<unknown>;
  revokeMatchingGrants(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
  }): Promise<unknown>;
  grants?(principalId?: string): readonly {
    readonly principalId: string;
    readonly scopeType: "platform" | "workspace" | "project";
    readonly scopeId: string;
    readonly role: string;
    readonly status: "active" | "revoked" | "expired";
  }[];
}

export type PublicRoleAssignment = RoleAssignment;
export type PublicRuntimeProfile = RuntimeProfile;
export type PublicDelegation = Delegation;
export type PublicDelegationReport = DelegationReport;
export type PublicAuditEvent = AuditEvent;
export type PublicActionTicket = ActionTicket;

export interface EmployeeCompatibilityIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly employeeId?: string;
  readonly principalId?: string;
  readonly recordId?: string;
}

export interface EmployeeCompatibilityReport {
  readonly generatedAt: string;
  readonly readOnly: true;
  readonly summary: {
    readonly employees: number;
    readonly principalsLinked: number;
    readonly roleAssignments: number;
    readonly runtimeProfiles: number;
    readonly actionTickets: number;
    readonly delegations: number;
    readonly auditEvents: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly issues: readonly EmployeeCompatibilityIssue[];
}

export interface EmployeeCompatibilityExport {
  readonly version: 1;
  readonly exportedAt: string;
  readonly compatibilityMode: "read-only";
  readonly employees: readonly PublicEmployee[];
  readonly roleAssignments: readonly RoleAssignment[];
  readonly runtimeProfiles: readonly RuntimeProfile[];
  readonly delegations: readonly Delegation[];
  readonly delegationReports: readonly DelegationReport[];
  readonly actionTickets: readonly ActionTicket[];
  readonly auditEvents: readonly AuditEvent[];
}

const DEFAULT_ROLE_PERMISSIONS: Record<WorkspaceRole, string[]> = {
  viewer: ["read"],
  member: ["read", "write"],
  owner: ["read", "write", "approve", "manage_workspace"],
};

const STATUS_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  draft: ["active", "suspended", "archived"],
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: [],
};

const STATUS_LABELS: Record<EmployeeStatus, string> = {
  draft: "草稿",
  active: "启用",
  suspended: "暂停",
  archived: "归档",
};

const DELEGATION_CONTEXT_LABELS = {
  meeting: "会议委托",
  task: "任务委托",
  review: "评审委托",
} as const;

function parseOrInvalid<T>(schema: SchemaLike<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new EmployeeError("invalid_input", "request input is invalid");
  }
  return result.data;
}

function randomId(): string {
  return `id-${randomUUID()}`;
}

function intersect(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const values = new Set(right);
  return [...new Set(left)].filter((value) => values.has(value));
}

function intersectScopes(
  requested: readonly string[],
  allowed: readonly string[],
): string[] {
  return [...new Set(requested)].filter((scope) =>
    allowed.some(
      (parent) => scope === parent || scope.startsWith(`${parent}/`),
    ),
  );
}

function publicEmployee(
  employee: Employee,
  principalId?: string,
): PublicEmployee {
  return {
    id: employee.id,
    ...(principalId === undefined ? {} : { principalId }),
    kind: employee.kind,
    displayName: employee.displayName,
    ...(employee.email === undefined ? {} : { email: employee.email }),
    department: employee.department,
    title: employee.title,
    tags: employee.tags,
    ...(employee.personaId === undefined
      ? {}
      : { personaId: employee.personaId }),
    ...(employee.kind === "human" && employee.authUserId !== undefined
      ? {
          authUserId: employee.authUserId,
          authStatus: employee.authStatus ?? "active",
        }
      : {}),
    ...(employee.managerEmployeeId === undefined
      ? {}
      : { managerEmployeeId: employee.managerEmployeeId }),
    status: employee.status,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
}

function isExpired(isoTime: string | undefined, at: Date): boolean {
  return isoTime !== undefined && new Date(isoTime).getTime() <= at.getTime();
}

function reportContent(delegation: Delegation, transcript: string): string {
  const statements = transcript
    .split(/\n+/)
    .filter(
      (line) =>
        delegation.displayName !== "" && line.includes(delegation.displayName),
    );
  return [
    "# 分身会议报告",
    "",
    "## 会议关键过程",
    transcript
      ? "会议记录已完成采样；详细过程见上下文 transcript。"
      : "没有可用会议记录。",
    "",
    "## 已表达立场",
    delegation.stance || "分身未获得明确立场指令。",
    ...(statements.length === 0
      ? []
      : [
          "",
          "分身相关记录：",
          ...statements.slice(-10).map((line) => `- ${line}`),
        ]),
    "",
    "## 关键结论",
    "本报告为确定性摘要，不推断 transcript 中不存在的事实。",
    "",
    "## 风险与反对意见",
    delegation.watchItems.length === 0
      ? "未设置重点关注事项。"
      : delegation.watchItems.map((item) => `- ${item}`).join("\n"),
    "",
    "## 待主人确认",
    delegation.approvalPolicy === "never"
      ? "本委托明确禁止最终审批。"
      : "分身未做出最终审批；任何审批仍需委托人确认。",
    "",
    "## 后续建议",
    `委托目标：${delegation.objective}`,
    "",
    "## 信息缺口",
    transcript
      ? "无自动识别缺口；后续版本可接入模型摘要。"
      : "缺少会议 transcript，无法总结过程。",
    "",
  ].join("\n");
}

export class EmployeeService {
  private readonly now: () => Date;
  private readonly personas?:
    (() => PersonaServiceLike | undefined) | undefined;
  private identity: (() => IdentityServiceLike | undefined) | undefined;
  private principals:
    | (() => PrincipalServiceLike | undefined)
    | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly tables: EmployeeTables,
    options: EmployeeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.personas = options.personas;
  }

  setIdentityService(identity: () => IdentityServiceLike | undefined): void {
    this.identity = identity;
  }

  setPrincipalService(
    principals: () => PrincipalServiceLike | undefined,
  ): void {
    this.principals = principals;
  }

  private principalId(employee: Employee): string | undefined {
    return this.principals?.()?.resolveSubject("employee", employee.id)?.id;
  }

  private publicEmployee(employee: Employee): PublicEmployee {
    return publicEmployee(employee, this.principalId(employee));
  }

  private async syncPrincipal(employee: Employee): Promise<void> {
    const principals = this.principals?.();
    if (principals === undefined) return;
    const effective =
      employee.kind === "human" && employee.authUserId !== undefined
        ? (this.byAuthUserId(employee.authUserId) ?? employee)
        : employee;
    await principals.syncEmployee({
      employeeId: effective.id,
      kind: effective.kind,
      displayName: effective.displayName,
      status: effective.status,
      ...(effective.authUserId === undefined
        ? {}
        : {
            authUserId: effective.authUserId,
            authStatus: effective.authStatus ?? "active",
          }),
    });
  }

  private async syncAllPrincipals(): Promise<void> {
    const employees = this.employeeValues();
    const authUserIds = new Set(
      employees.flatMap((employee) =>
        employee.kind === "human" && employee.authUserId !== undefined
          ? [employee.authUserId]
          : [],
      ),
    );
    for (const authUserId of authUserIds) {
      const employee = this.byAuthUserId(authUserId);
      if (employee !== undefined) {
        await this.syncPrincipal(employee);
      }
    }
    for (const employee of employees) {
      if (
        employee.kind === "digital" ||
        employee.authUserId === undefined
      ) {
        await this.syncPrincipal(employee);
      }
    }
    const principals = this.principals?.();
    if (principals === undefined) return;
    for (const [key, assignment] of this.tables.roleAssignments.entries()) {
      const principal = principals.resolveSubject(
        "employee",
        assignment.employeeId,
      );
      if (principal === undefined) continue;
      const next =
        assignment.principalId === principal.id
          ? assignment
          : roleAssignmentSchema.parse({
              ...assignment,
              principalId: principal.id,
              updatedAt: this.timestamp(),
            });
      if (next !== assignment) {
        await this.tables.roleAssignments.put(key, next);
      }
      if (
        principal.status !== "archived" &&
        next.status === "active" &&
        !isExpired(next.expiresAt, this.now())
      ) {
        await principals.syncGrant({
          principalId: principal.id,
          scopeType: "workspace",
          scopeId: next.workspaceId,
          role: next.role,
          permissions: next.permissions,
        });
      } else {
        await principals.revokeMatchingGrants({
          principalId: principal.id,
          scopeType: "workspace",
          scopeId: next.workspaceId,
          role: next.role,
        });
      }
    }
    for (const [key, profile] of this.tables.runtimeProfiles.entries()) {
      const principal = principals.resolveSubject(
        "employee",
        profile.employeeId,
      );
      if (principal === undefined || profile.principalId === principal.id) {
        continue;
      }
      await this.tables.runtimeProfiles.put(
        key,
        runtimeProfileSchema.parse({
          ...profile,
          principalId: principal.id,
          updatedAt: this.timestamp(),
        }),
      );
    }
    for (const [key, ticket] of this.tables.actionTickets.entries()) {
      const principal = principals.resolveSubject(
        "employee",
        ticket.principal.employeeId,
      );
      if (
        principal === undefined ||
        ticket.principal.principalId === principal.id
      ) {
        continue;
      }
      await this.tables.actionTickets.put(
        key,
        actionTicketSchema.parse({
          ...ticket,
          principal: {
            ...ticket.principal,
            principalId: principal.id,
          },
        }),
      );
    }
    for (const [key, delegation] of this.tables.delegations.entries()) {
      const principal = principals.resolveSubject(
        "employee",
        delegation.ownerId,
      );
      if (
        principal === undefined ||
        delegation.ownerPrincipalId === principal.id
      ) {
        continue;
      }
      await this.tables.delegations.put(
        key,
        delegationSchema.parse({
          ...delegation,
          ownerPrincipalId: principal.id,
          updatedAt: this.timestamp(),
        }),
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private values<V>(table: KvTableLike<V>): V[] {
    return [...table.entries()].map(([, value]) => value);
  }

  private employeeValues(): Employee[] {
    return this.values(this.tables.employees);
  }

  private byAuthUserId(authUserId: string): Employee | undefined {
    const matches = this.employeeValues().filter(
      (employee) =>
        employee.kind === "human" && employee.authUserId === authUserId,
    );
    return (
      matches.find((employee) => employee.status === "active") ??
      matches.find((employee) => employee.status !== "archived") ??
      matches[0]
    );
  }

  private requireEmployee(employeeId: string): Employee {
    const employee = this.tables.employees.get(employeeId);
    if (employee === undefined) {
      throw new EmployeeError("not_found", "employee does not exist");
    }
    return employee;
  }

  private async requirePersona(personaId: string): Promise<void> {
    const personas = this.personas?.();
    if (personas === undefined) {
      throw new EmployeeError("not_found", "persona registry is unavailable");
    }
    try {
      await personas.get(personaId);
    } catch {
      throw new EmployeeError(
        "invalid_input",
        `persona does not exist: ${personaId}`,
      );
    }
  }

  private async audit(
    actor: Employee | Pick<Employee, "id" | "authUserId">,
    input: {
      action: string;
      decision?: "allowed" | "denied";
      reason?: string | undefined;
      actorRole?: string | undefined;
      workspaceId?: string | undefined;
      contextType?: ContextType;
      contextId?: string;
      delegationId?: string | undefined;
      runId?: string | undefined;
      ticketId?: string | undefined;
      metadata?: Record<string, string | number | boolean>;
    },
  ): Promise<void> {
    const actorEmployee = this.tables.employees.get(actor.id);
    const actorPrincipalId =
      actorEmployee === undefined ? undefined : this.principalId(actorEmployee);
    const event = auditEventSchema.parse({
      id: randomId(),
      at: this.timestamp(),
      actorEmployeeId: actor.id,
      ...(actorPrincipalId === undefined
        ? {}
        : { actorPrincipalId }),
      ...(actor.authUserId === undefined
        ? {}
        : { actorAuthUserId: actor.authUserId }),
      actorRole: input.actorRole ?? "system",
      ...(input.workspaceId === undefined
        ? {}
        : { workspaceId: input.workspaceId }),
      ...(input.contextType === undefined
        ? {}
        : { contextType: input.contextType }),
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
      ...(input.delegationId === undefined
        ? {}
        : { delegationId: input.delegationId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      action: input.action,
      decision: input.decision ?? "allowed",
      reason: input.reason ?? "",
      metadata: input.metadata ?? {},
    });
    await this.tables.auditEvents.put(event.id, event);
  }

  syncIdentityUsers(users: readonly PublicIdentityUser[]): Promise<void> {
    return this.enqueue(async () => {
      const timestamp = this.timestamp();
      const currentAuthUserIds = new Set(
        users.map((user) => parseOrInvalid(employeeSchema.shape.id, user.id)),
      );
      for (const employee of this.employeeValues()) {
        if (
          employee.kind !== "human" ||
          employee.authUserId === undefined ||
          employee.status === "archived" ||
          currentAuthUserIds.has(employee.authUserId)
        ) {
          continue;
        }
        await this.tables.employees.put(
          employee.id,
          employeeSchema.parse({
            ...employee,
            status: "archived",
            ...(employee.kind === "human" && employee.authUserId !== undefined
              ? { authStatus: "disabled" as const }
              : {}),
            updatedAt: timestamp,
          }),
        );
      }
      for (const user of users) {
        const authUserId = parseOrInvalid(employeeSchema.shape.id, user.id);
        const existing = this.employeeValues().find(
          (employee) =>
            employee.kind === "human" &&
            employee.authUserId === authUserId &&
            employee.status !== "archived",
        );
        if (existing !== undefined) {
          const authStatus = user.status ?? "active";
          if (
            existing.displayName === user.name &&
            (existing.authStatus ?? "active") === authStatus
          ) {
            continue;
          }
          await this.tables.employees.put(
            existing.id,
            employeeSchema.parse({
              ...existing,
              displayName: user.name,
              authStatus,
              updatedAt: timestamp,
            }),
          );
          continue;
        }
        const preferred = authUserId;
        const id =
          this.tables.employees.get(preferred) === undefined
            ? preferred
            : `human-${preferred}-${randomUUID().slice(0, 8)}`;
        const record = employeeSchema.parse({
          id,
          kind: "human",
          displayName: user.name,
          authUserId,
          authStatus: user.status ?? "active",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: "identity-migration",
        });
        await this.tables.employees.put(record.id, record);
      }
      await this.syncAllPrincipals();
    });
  }

  list(): PublicEmployee[] {
    return this.employeeValues()
      .map((employee) => this.publicEmployee(employee))
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          left.displayName.localeCompare(right.displayName) ||
          left.id.localeCompare(right.id),
      );
  }

  get(employeeId: string): PublicEmployee {
    return this.publicEmployee(this.requireEmployee(employeeId));
  }

  getByAuthUserId(authUserId: string): PublicEmployee | undefined {
    const employee = this.byAuthUserId(authUserId);
    return employee === undefined
      ? undefined
      : this.publicEmployee(employee);
  }

  exportCompatibilityData(): EmployeeCompatibilityExport {
    return {
      version: 1,
      exportedAt: this.timestamp(),
      compatibilityMode: "read-only",
      employees: this.list(),
      roleAssignments: this.values(this.tables.roleAssignments),
      runtimeProfiles: this.values(this.tables.runtimeProfiles),
      delegations: this.listDelegations(),
      delegationReports: this.listReports(),
      actionTickets: this.listTickets(),
      auditEvents: this.listAudit({ limit: Number.MAX_SAFE_INTEGER }),
    };
  }

  compatibilityReport(): EmployeeCompatibilityReport {
    const issues: EmployeeCompatibilityIssue[] = [];
    const principals = this.principals?.();
    const employees = this.employeeValues();
    const roleAssignments = this.values(this.tables.roleAssignments);
    const runtimeProfiles = this.values(this.tables.runtimeProfiles);
    const actionTickets = this.values(this.tables.actionTickets);
    const delegations = this.values(this.tables.delegations);
    const auditEvents = this.values(this.tables.auditEvents);
    let principalsLinked = 0;

    const authUsers = new Map<string, string[]>();
    for (const employee of employees) {
      if (employee.authUserId !== undefined) {
        authUsers.set(employee.authUserId, [
          ...(authUsers.get(employee.authUserId) ?? []),
          employee.id,
        ]);
      }
      if (principals === undefined) continue;
      const principal = principals.resolveSubject("employee", employee.id);
      if (principal === undefined) {
        issues.push({
          code: "employee_principal_missing",
          severity: "error",
          message: "Employee 没有对应的 Principal 映射",
          employeeId: employee.id,
        });
        continue;
      }
      principalsLinked += 1;
      const expectedKind = employee.kind === "human" ? "human" : "ai";
      if (principal.kind !== expectedKind) {
        issues.push({
          code: "employee_principal_kind_mismatch",
          severity: "error",
          message: `Employee 类型 ${employee.kind} 与 Principal 类型 ${principal.kind} 不一致`,
          employeeId: employee.id,
          principalId: principal.id,
        });
      }
      const expectedStatus =
        employee.status === "archived"
          ? "archived"
          : employee.status === "active" &&
              (employee.authStatus ?? "active") !== "disabled"
            ? "active"
            : "suspended";
      if (principal.status !== expectedStatus) {
        issues.push({
          code: "employee_principal_status_mismatch",
          severity: "warning",
          message: `Employee 状态投影应为 ${expectedStatus}，当前 Principal 为 ${principal.status}`,
          employeeId: employee.id,
          principalId: principal.id,
        });
      }
    }
    for (const [authUserId, employeeIds] of authUsers) {
      if (employeeIds.length <= 1) continue;
      issues.push({
        code: "duplicate_human_employee_projection",
        severity: "warning",
        message: `登录账号 ${authUserId} 关联了多条 Employee 兼容记录`,
        employeeId: employeeIds[0]!,
      });
    }

    if (principals === undefined) {
      issues.push({
        code: "principal_service_unavailable",
        severity: "error",
        message: "Principal 服务不可用，无法完成兼容一致性检查",
      });
    } else {
      for (const assignment of roleAssignments) {
        const principal = principals.resolveSubject(
          "employee",
          assignment.employeeId,
        );
        if (principal === undefined) continue;
        if (assignment.principalId !== principal.id) {
          issues.push({
            code: "role_assignment_principal_missing",
            severity: "warning",
            message: "历史工作区授权尚未写入 Principal ID",
            employeeId: assignment.employeeId,
            principalId: principal.id,
            recordId: assignment.id,
          });
        }
        if (
          assignment.status !== "active" ||
          isExpired(assignment.expiresAt, this.now())
        ) {
          continue;
        }
        const grant = principals
          .grants?.(principal.id)
          .some(
            (candidate) =>
              candidate.status === "active" &&
              candidate.scopeType === "workspace" &&
              candidate.scopeId === assignment.workspaceId &&
              candidate.role === assignment.role,
          );
        if (grant === false) {
          issues.push({
            code: "role_grant_missing",
            severity: "error",
            message: "有效 Employee 工作区授权缺少对应的 Principal Grant",
            employeeId: assignment.employeeId,
            principalId: principal.id,
            recordId: assignment.id,
          });
        }
      }
      for (const profile of runtimeProfiles) {
        const principal = principals.resolveSubject(
          "employee",
          profile.employeeId,
        );
        if (principal !== undefined && profile.principalId !== principal.id) {
          issues.push({
            code: "runtime_profile_principal_missing",
            severity: "warning",
            message: "Runtime Profile 尚未写入 Principal ID",
            employeeId: profile.employeeId,
            principalId: principal.id,
            recordId: profile.id,
          });
        }
      }
      for (const ticket of actionTickets) {
        const principal = principals.resolveSubject(
          "employee",
          ticket.principal.employeeId,
        );
        if (
          principal !== undefined &&
          ticket.principal.principalId !== principal.id
        ) {
          issues.push({
            code: "action_ticket_principal_missing",
            severity: "warning",
            message: "Action Ticket 尚未写入 Principal ID",
            employeeId: ticket.principal.employeeId,
            principalId: principal.id,
            recordId: ticket.id,
          });
        }
      }
      for (const delegation of delegations) {
        const principal = principals.resolveSubject(
          "employee",
          delegation.ownerId,
        );
        if (
          principal !== undefined &&
          delegation.ownerPrincipalId !== principal.id
        ) {
          issues.push({
            code: "delegation_principal_missing",
            severity: "warning",
            message: "Delegation 尚未写入 owner Principal ID",
            employeeId: delegation.ownerId,
            principalId: principal.id,
            recordId: delegation.id,
          });
        }
      }
    }

    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.length - errors;
    return {
      generatedAt: this.timestamp(),
      readOnly: true,
      summary: {
        employees: employees.length,
        principalsLinked,
        roleAssignments: roleAssignments.length,
        runtimeProfiles: runtimeProfiles.length,
        actionTickets: actionTickets.length,
        delegations: delegations.length,
        auditEvents: auditEvents.length,
        errors,
        warnings,
      },
      issues: issues.slice(0, 1_000),
    };
  }

  createHuman(
    actorAuthUserId: string,
    input: {
      employeeId?: string | undefined;
      displayName: string;
      email?: string | undefined;
      department?: string | undefined;
      title?: string | undefined;
      tags?: readonly string[] | undefined;
      authUserId?: string | undefined;
      managerEmployeeId?: string | undefined;
    },
  ): Promise<PublicEmployee> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const timestamp = this.timestamp();
      const id =
        input.employeeId?.trim() ||
        input.authUserId?.trim() ||
        `human-${randomUUID().slice(0, 8)}`;
      if (this.tables.employees.get(id) !== undefined) {
        throw new EmployeeError(
          "conflict",
          `employee id already exists: ${id}`,
        );
      }
      if (
        input.authUserId !== undefined &&
        this.employeeValues().some(
          (employee) =>
            employee.kind === "human" &&
            employee.authUserId === input.authUserId &&
            employee.status !== "archived",
        )
      ) {
        throw new EmployeeError(
          "conflict",
          `login account is already linked: ${input.authUserId}`,
        );
      }
      if (input.managerEmployeeId !== undefined) {
        const manager = this.tables.employees.get(input.managerEmployeeId);
        if (manager === undefined || manager.status === "archived") {
          throw new EmployeeError(
            "invalid_input",
            "manager employee does not exist",
          );
        }
      }
      const record = employeeSchema.parse({
        id,
        kind: "human",
        displayName: input.displayName,
        ...(input.email === undefined ? {} : { email: input.email }),
        department: input.department ?? "",
        title: input.title ?? "",
        tags: input.tags ?? [],
        ...(input.authUserId === undefined
          ? {}
          : { authUserId: input.authUserId, authStatus: "active" }),
        ...(input.managerEmployeeId === undefined
          ? {}
          : { managerEmployeeId: input.managerEmployeeId }),
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: actor.id,
      });
      await this.tables.employees.put(record.id, record);
      await this.syncPrincipal(record);
      await this.audit(actor, {
        action: "employee.created",
        actorRole: "admin",
        metadata: {
          employeeId: record.id,
          employeeKind: "human",
          ...(record.authUserId === undefined
            ? {}
            : { authUserId: record.authUserId }),
        },
      });
      return this.publicEmployee(record);
    });
  }

  createDigital(
    actorAuthUserId: string,
    input: {
      employeeId?: string | undefined;
      displayName: string;
      email?: string | undefined;
      department?: string | undefined;
      title?: string | undefined;
      tags?: readonly string[] | undefined;
      personaId: string;
      managerEmployeeId: string;
    },
  ): Promise<PublicEmployee> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const timestamp = this.timestamp();
      const id =
        input.employeeId?.trim() || `digital-${randomUUID().slice(0, 8)}`;
      if (this.tables.employees.get(id) !== undefined) {
        throw new EmployeeError(
          "conflict",
          `employee id already exists: ${id}`,
        );
      }
      const manager = this.tables.employees.get(input.managerEmployeeId);
      if (manager === undefined || manager.status === "archived") {
        throw new EmployeeError(
          "invalid_input",
          "manager employee does not exist",
        );
      }
      await this.requirePersona(input.personaId);
      const record = employeeSchema.parse({
        id,
        kind: "digital",
        displayName: input.displayName,
        ...(input.email === undefined ? {} : { email: input.email }),
        department: input.department ?? "",
        title: input.title ?? "",
        tags: input.tags ?? [],
        personaId: input.personaId,
        managerEmployeeId: input.managerEmployeeId,
        status: "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: actor.id,
      });
      if (record.authUserId !== undefined) {
        throw new EmployeeError(
          "invalid_input",
          "digital employees cannot log in",
        );
      }
      await this.tables.employees.put(record.id, record);
      await this.syncPrincipal(record);
      await this.audit(actor, {
        action: "employee.created",
        actorRole: "admin",
        metadata: { employeeId: record.id },
      });
      return this.publicEmployee(record);
    });
  }

  updateDigital(
    actorAuthUserId: string,
    employeeId: string,
    input: {
      displayName?: string | undefined;
      email?: string | null | undefined;
      department?: string | undefined;
      title?: string | undefined;
      tags?: readonly string[] | undefined;
      personaId?: string | undefined;
      managerEmployeeId?: string | undefined;
    },
  ): Promise<PublicEmployee> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const current = this.requireEmployee(employeeId);
      if (current.kind !== "digital") {
        throw new EmployeeError(
          "invalid_input",
          "only Digital Employees can be updated here",
        );
      }
      if (input.personaId !== undefined) {
        await this.requirePersona(input.personaId);
      }
      if (input.managerEmployeeId !== undefined) {
        const manager = this.tables.employees.get(input.managerEmployeeId);
        if (manager === undefined || manager.status === "archived") {
          throw new EmployeeError(
            "invalid_input",
            "manager employee does not exist",
          );
        }
      }
      const updated = employeeSchema.parse({
        ...current,
        displayName: input.displayName ?? current.displayName,
        ...(input.email === undefined
          ? {}
          : input.email === null
            ? { email: undefined }
            : { email: input.email }),
        department: input.department ?? current.department,
        title: input.title ?? current.title,
        tags: input.tags ?? current.tags,
        personaId: input.personaId ?? current.personaId,
        managerEmployeeId: input.managerEmployeeId ?? current.managerEmployeeId,
        updatedAt: this.timestamp(),
      });
      if (updated.authUserId !== undefined) {
        throw new EmployeeError(
          "invalid_input",
          "digital employees cannot log in",
        );
      }
      await this.tables.employees.put(updated.id, updated);
      await this.syncPrincipal(updated);
      await this.audit(actor, {
        action: "employee.updated",
        actorRole: "admin",
        metadata: { employeeId: updated.id },
      });
      return this.publicEmployee(updated);
    });
  }

  changeStatus(
    actorAuthUserId: string,
    employeeId: string,
    status: EmployeeStatus,
  ): Promise<PublicEmployee> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const current = this.requireEmployee(employeeId);
      if (current.status === status) {
        if (status === "archived" && current.kind === "human") {
          await this.disableHumanLogin(actorAuthUserId, current);
          if ((current.authStatus ?? "active") !== "disabled") {
            const reconciled = employeeSchema.parse({
              ...current,
              authStatus: "disabled",
              updatedAt: this.timestamp(),
            });
            await this.tables.employees.put(reconciled.id, reconciled);
            await this.syncPrincipal(reconciled);
            return this.publicEmployee(reconciled);
          }
        }
        return this.publicEmployee(current);
      }
      if (!STATUS_TRANSITIONS[current.status].includes(status)) {
        throw new EmployeeError(
          "conflict",
          `cannot change employee from ${current.status} to ${status}`,
        );
      }
      if (
        status === "active" &&
        (current.personaId === undefined ||
          current.managerEmployeeId === undefined)
      ) {
        throw new EmployeeError(
          "invalid_input",
          "persona and manager are required before activation",
        );
      }
      if (
        status === "archived" &&
        current.kind === "human" &&
        current.authUserId !== undefined
      ) {
        // 先停用登录，避免员工已归档但旧会话仍可继续使用。
        await this.disableHumanLogin(actorAuthUserId, current);
      }
      const updated = employeeSchema.parse({
        ...current,
        status,
        ...(status === "archived" &&
        current.kind === "human" &&
        current.authUserId !== undefined
          ? { authStatus: "disabled" as const }
          : {}),
        updatedAt: this.timestamp(),
      });
      await this.tables.employees.put(updated.id, updated);
      await this.syncPrincipal(updated);
      if (status !== "active") {
        const tickets = this.values(this.tables.actionTickets).filter(
          (ticket) =>
            ticket.principal.employeeId === updated.id &&
            ticket.status === "active",
        );
        for (const ticket of tickets) {
          await this.tables.actionTickets.put(ticket.id, {
            ...ticket,
            status: "revoked",
          });
        }
        const delegations = this.values(this.tables.delegations).filter(
          (item) =>
            item.ownerId === updated.id &&
            ["active", "paused"].includes(item.status),
        );
        for (const delegation of delegations) {
          await this.tables.delegations.put(delegation.id, {
            ...delegation,
            status: "revoked",
            updatedAt: this.timestamp(),
          });
        }
      }
      await this.audit(actor, {
        action: "employee.status_changed",
        actorRole: "admin",
        metadata: { employeeId: updated.id, status },
      });
      return this.publicEmployee(updated);
    });
  }

  private async disableHumanLogin(
    actorAuthUserId: string,
    employee: Employee,
  ): Promise<void> {
    if (employee.kind !== "human" || employee.authUserId === undefined) {
      return;
    }
    const identity = this.identity?.();
    if (identity === undefined) {
      throw new EmployeeError(
        "conflict",
        "identity service is unavailable; cannot archive Human Employee",
      );
    }
    await identity.updateUser(actorAuthUserId, employee.authUserId, {
      status: "disabled",
    });
  }

  assertDispatchable(employeeId: string, workspaceId: string): void {
    const employee = this.requireEmployee(employeeId);
    if (employee.status !== "active") {
      throw new EmployeeError(
        "forbidden",
        `employee is ${employee.status}; dispatch is blocked`,
      );
    }
    const assignment = this.activeRole(employeeId, workspaceId);
    if (assignment === undefined) {
      throw new EmployeeError(
        "forbidden",
        "explicit workspace role is required",
      );
    }
    const profile = this.activeProfile(employeeId, workspaceId);
    if (profile === undefined) {
      throw new EmployeeError(
        "forbidden",
        "active Runtime Profile is required",
      );
    }
  }

  workflowDispatchBlockReason(
    employeeId: string,
    workspaceId: string,
  ): string | undefined {
    const employee = this.tables.employees.get(employeeId);
    if (employee === undefined || employee.kind !== "digital") {
      return `AI伙伴「${employeeId}」不存在`;
    }
    if (employee.status === "suspended") {
      return `AI伙伴「${employee.displayName}」已暂停，不能派发`;
    }
    if (employee.status !== "active") {
      return `AI伙伴「${employee.displayName}」当前状态为${STATUS_LABELS[employee.status]}，不能派发`;
    }
    if (this.activeRole(employeeId, workspaceId) === undefined) {
      return `AI伙伴「${employee.displayName}」缺少目标工作区授权，不能派发`;
    }
    const profile = this.activeProfile(employeeId, workspaceId);
    if (profile === undefined) {
      return `AI伙伴「${employee.displayName}」缺少启用的 Runtime Profile，不能派发`;
    }
    if (profile.legacyAgentProfileId === undefined) {
      return `AI伙伴「${employee.displayName}」的 Runtime Profile 未映射 Task Worker Profile，不能派发`;
    }
    return undefined;
  }

  workflowTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: Employee;
        readonly assignment: RoleAssignment;
        readonly profile: RuntimeProfile;
      }
    | undefined {
    const employee = this.tables.employees.get(employeeId);
    if (
      employee === undefined ||
      employee.kind !== "digital" ||
      employee.status !== "active"
    ) {
      return undefined;
    }
    const assignment = this.activeRole(employeeId, workspaceId);
    const profile = this.activeProfile(employeeId, workspaceId);
    if (
      assignment === undefined ||
      profile === undefined ||
      profile.legacyAgentProfileId === undefined
    ) {
      return undefined;
    }
    return { employee, assignment, profile };
  }

  employeeWorkspaceTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: Employee;
        readonly assignment: RoleAssignment;
      }
    | undefined {
    const employee = this.tables.employees.get(employeeId);
    if (
      employee === undefined ||
      employee.kind !== "digital" ||
      employee.status !== "active"
    ) {
      return undefined;
    }
    const assignment = this.activeRole(employeeId, workspaceId);
    return assignment === undefined ? undefined : { employee, assignment };
  }

  employeeApprovalTarget(
    employeeId: string,
    workspaceId: string,
  ): Employee | undefined {
    const employee = this.tables.employees.get(employeeId);
    if (employee === undefined || employee.kind !== "digital") {
      return undefined;
    }
    const assignment = this.activeRole(employeeId, workspaceId);
    return assignment !== undefined &&
      assignment.permissions.includes("approve")
      ? employee
      : undefined;
  }

  listRoles(
    input: {
      employeeId?: string | undefined;
      workspaceId?: string | undefined;
    } = {},
  ): PublicRoleAssignment[] {
    return this.values(this.tables.roleAssignments)
      .filter(
        (item) =>
          (input.employeeId === undefined ||
            item.employeeId === input.employeeId) &&
          (input.workspaceId === undefined ||
            item.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  activeRole(
    employeeId: string,
    workspaceId: string,
  ): RoleAssignment | undefined {
    const at = this.now();
    return this.listRoles({ employeeId, workspaceId }).find(
      (item) => item.status === "active" && !isExpired(item.expiresAt, at),
    );
  }

  assignRole(
    actorAuthUserId: string,
    input: {
      employeeId: string;
      workspaceId: string;
      role: WorkspaceRole;
      permissions?: readonly string[] | undefined;
      durationMinutes?: number | undefined;
    },
  ): Promise<PublicRoleAssignment> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const employee = this.requireEmployee(input.employeeId);
      const principalId = this.principalId(employee);
      const actorPrincipalId = this.principalId(actor);
      const now = this.now();
      for (const assignment of this.listRoles({
        employeeId: input.employeeId,
        workspaceId: input.workspaceId,
      })) {
        if (
          assignment.status === "active" &&
          (assignment.role === input.role ||
            isExpired(assignment.expiresAt, now))
        ) {
          await this.tables.roleAssignments.put(assignment.id, {
            ...assignment,
            status: "revoked",
            revokedAt: this.timestamp(),
            updatedAt: this.timestamp(),
          });
          const grantPrincipalId =
            assignment.principalId ?? principalId;
          if (grantPrincipalId !== undefined) {
            await this.principals?.()?.revokeMatchingGrants({
              principalId: grantPrincipalId,
              scopeType: "workspace",
              scopeId: assignment.workspaceId,
              role: assignment.role,
            });
          }
        }
      }
      const timestamp = this.timestamp();
      const expiresAt =
        input.durationMinutes === undefined
          ? undefined
          : new Date(
              now.getTime() + input.durationMinutes * 60_000,
            ).toISOString();
      const record = roleAssignmentSchema.parse({
        id: randomId(),
        employeeId: employee.id,
        ...(principalId === undefined ? {} : { principalId }),
        workspaceId: input.workspaceId,
        role: input.role,
        permissions: input.permissions ?? DEFAULT_ROLE_PERMISSIONS[input.role],
        status: "active",
        ...(expiresAt === undefined ? {} : { expiresAt }),
        grantedBy: actor.id,
        grantedByUserId: actor.authUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.tables.roleAssignments.put(record.id, record);
      if (principalId !== undefined) {
        await this.principals?.()?.syncGrant({
          principalId,
          scopeType: "workspace",
          scopeId: record.workspaceId,
          role: record.role,
          permissions: record.permissions,
          ...(actorPrincipalId === undefined
            ? {}
            : { grantedByPrincipalId: actorPrincipalId }),
        });
      }
      await this.audit(actor, {
        action: "employee.role_assigned",
        actorRole: "admin",
        workspaceId: record.workspaceId,
        metadata: {
          employeeId: employee.id,
          role: record.role,
          assignmentId: record.id,
        },
      });
      return record;
    });
  }

  revokeRole(
    actorAuthUserId: string,
    assignmentId: string,
  ): Promise<PublicRoleAssignment> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const assignment = this.tables.roleAssignments.get(assignmentId);
      if (assignment === undefined) {
        throw new EmployeeError("not_found", "role assignment does not exist");
      }
      const updated = roleAssignmentSchema.parse({
        ...assignment,
        status: "revoked",
        revokedAt: this.timestamp(),
        updatedAt: this.timestamp(),
      });
      await this.tables.roleAssignments.put(updated.id, updated);
      const employee = this.tables.employees.get(updated.employeeId);
      const principalId =
        updated.principalId ??
        (employee === undefined ? undefined : this.principalId(employee));
      if (principalId !== undefined) {
        await this.principals?.()?.revokeMatchingGrants({
          principalId,
          scopeType: "workspace",
          scopeId: updated.workspaceId,
          role: updated.role,
        });
      }
      await this.audit(actor, {
        action: "employee.role_revoked",
        actorRole: "admin",
        workspaceId: updated.workspaceId,
        metadata: { employeeId: updated.employeeId, assignmentId: updated.id },
      });
      return updated;
    });
  }

  listProfiles(
    input: {
      employeeId?: string | undefined;
      workspaceId?: string | undefined;
    } = {},
  ): PublicRuntimeProfile[] {
    return this.values(this.tables.runtimeProfiles)
      .filter(
        (item) =>
          (input.employeeId === undefined ||
            item.employeeId === input.employeeId) &&
          (input.workspaceId === undefined ||
            item.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  activeProfile(
    employeeId: string,
    workspaceId: string,
  ): RuntimeProfile | undefined {
    return this.listProfiles({ employeeId, workspaceId }).find(
      (item) => item.status === "active",
    );
  }

  upsertRuntimeProfile(
    actorAuthUserId: string,
    input: {
      id?: string | undefined;
      employeeId: string;
      workspaceId: string;
      name: string;
      provider?: string | undefined;
      model?: string | undefined;
      reasoningEffort?: string | undefined;
      allowedTools?: readonly string[] | undefined;
      deniedTools?: readonly string[] | undefined;
      resourceScopes?: readonly string[] | undefined;
      maxTurns?: number | undefined;
      maxMinutes?: number | undefined;
      status?: RuntimeProfile["status"] | undefined;
      legacyAgentProfileId?: string | undefined;
    },
  ): Promise<PublicRuntimeProfile> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const employee = this.requireEmployee(input.employeeId);
      if (employee.kind !== "digital") {
        throw new EmployeeError(
          "invalid_input",
          "Runtime Profile is for Digital Employees",
        );
      }
      const existing =
        input.id === undefined
          ? undefined
          : this.tables.runtimeProfiles.get(input.id);
      if (input.id !== undefined && existing === undefined) {
        throw new EmployeeError("not_found", "Runtime Profile does not exist");
      }
      const timestamp = this.timestamp();
      const status = input.status ?? existing?.status ?? "active";
      if (status === "active") {
        for (const profile of this.listProfiles({
          employeeId: employee.id,
          workspaceId: input.workspaceId,
        })) {
          if (profile.status === "active" && profile.id !== existing?.id) {
            await this.tables.runtimeProfiles.put(profile.id, {
              ...profile,
              status: "disabled",
              updatedAt: timestamp,
            });
          }
        }
      }
      const principalId = this.principalId(employee) ?? existing?.principalId;
      const record = runtimeProfileSchema.parse({
        ...(existing ?? {
          id: randomId(),
          employeeId: employee.id,
          workspaceId: input.workspaceId,
          createdBy: actor.id,
          createdAt: timestamp,
        }),
        ...(principalId === undefined ? {} : { principalId }),
        name: input.name,
        provider: input.provider ?? existing?.provider ?? "spawn",
        model: input.model ?? existing?.model ?? "",
        reasoningEffort:
          input.reasoningEffort ?? existing?.reasoningEffort ?? "",
        allowedTools: input.allowedTools ?? existing?.allowedTools ?? [],
        deniedTools: input.deniedTools ?? existing?.deniedTools ?? [],
        resourceScopes: input.resourceScopes ?? existing?.resourceScopes ?? [],
        budget: {
          maxTurns: input.maxTurns ?? existing?.budget.maxTurns ?? 50,
          maxMinutes: input.maxMinutes ?? existing?.budget.maxMinutes ?? 30,
        },
        status,
        ...(input.legacyAgentProfileId === undefined
          ? existing?.legacyAgentProfileId === undefined
            ? {}
            : { legacyAgentProfileId: existing.legacyAgentProfileId }
          : { legacyAgentProfileId: input.legacyAgentProfileId }),
        updatedAt: timestamp,
      });
      await this.tables.runtimeProfiles.put(record.id, record);
      await this.audit(actor, {
        action: "employee.runtime.updated",
        actorRole: "admin",
        workspaceId: record.workspaceId,
        metadata: {
          employeeId: employee.id,
          runtimeProfileId: record.id,
          status: record.status,
          ...(record.legacyAgentProfileId === undefined
            ? {}
            : { legacyAgentProfileId: record.legacyAgentProfileId }),
        },
      });
      return record;
    });
  }

  issueRuntimeTicket(
    actorAuthUserId: string,
    input: {
      employeeId: string;
      workspaceId: string;
      contextType: ContextType;
      contextId: string;
      requestedActions: readonly string[];
      resourceScopes?: readonly string[] | undefined;
      runId?: string | undefined;
      durationMinutes?: number | undefined;
    },
  ): Promise<PublicActionTicket> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      if (actor === undefined || actor.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      const employee = this.requireEmployee(input.employeeId);
      if (employee.kind !== "digital") {
        throw new EmployeeError(
          "invalid_input",
          "runtime tickets require a Digital Employee",
        );
      }
      this.assertDispatchable(employee.id, input.workspaceId);
      const assignment = this.activeRole(employee.id, input.workspaceId)!;
      const profile = this.activeProfile(employee.id, input.workspaceId)!;
      const roleAllowed = intersect(
        input.requestedActions,
        assignment.permissions,
      );
      const allowedActions = roleAllowed.filter(
        (action) =>
          !action.startsWith("tool:") || profile.allowedTools.includes(action),
      );
      const deniedActions = intersect(
        input.requestedActions,
        profile.deniedTools,
      );
      const resourceScopes =
        profile.resourceScopes.length === 0
          ? []
          : intersectScopes(input.resourceScopes ?? [], profile.resourceScopes);
      const principalId = this.principalId(employee);
      const now = this.now();
      const expiresAt = new Date(
        now.getTime() +
          (input.durationMinutes ?? profile.budget.maxMinutes) * 60_000,
      ).toISOString();
      const ticket = actionTicketSchema.parse({
        id: randomId(),
        principal: employeePrincipalSchema.parse({
          employeeId: employee.id,
          ...(principalId === undefined ? {} : { principalId }),
          employeeKind: "digital",
          source: "runtime",
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          workspaceId: input.workspaceId,
        }),
        workspaceId: input.workspaceId,
        contextType: input.contextType,
        contextId: input.contextId,
        allowedActions,
        deniedActions,
        resourceScopes,
        status: "active",
        expiresAt,
        createdAt: this.timestamp(),
        issuedBy: actor.id,
      });
      await this.tables.actionTickets.put(ticket.id, ticket);
      await this.audit(actor, {
        action: "employee.ticket.issued",
        actorRole: "admin",
        workspaceId: ticket.workspaceId,
        contextType: ticket.contextType,
        contextId: ticket.contextId,
        runId: input.runId,
        ticketId: ticket.id,
        metadata: {
          employeeId: employee.id,
          allowedActions: allowedActions.join(","),
        },
      });
      return ticket;
    });
  }

  authorizeTicket(input: {
    ticketId: string;
    action: string;
    resource?: string | undefined;
    workspaceId: string;
    contextType: ContextType;
    contextId: string;
  }): Promise<EmployeePrincipal> {
    return this.enqueue(async () => {
      const ticket = this.tables.actionTickets.get(input.ticketId);
      const deny = async (reason: string): Promise<EmployeePrincipal> => {
        const actor =
          ticket === undefined
            ? { id: "system", authUserId: undefined }
            : (this.tables.employees.get(ticket.principal.employeeId) ?? {
                id: ticket.principal.employeeId,
                authUserId: ticket.principal.authUserId,
              });
        await this.audit(actor, {
          action: input.action,
          decision: "denied",
          reason,
          actorRole: ticket?.principal.source ?? "system",
          workspaceId: input.workspaceId,
          contextType: input.contextType,
          contextId: input.contextId,
          ticketId: input.ticketId,
          ...(ticket?.principal.delegationId === undefined
            ? {}
            : { delegationId: ticket.principal.delegationId }),
          ...(ticket?.principal.runId === undefined
            ? {}
            : { runId: ticket.principal.runId }),
        });
        throw new EmployeeError("forbidden", reason);
      };
      if (ticket === undefined) return deny("action ticket does not exist");
      const now = this.now();
      if (
        ticket.status !== "active" ||
        isExpired(ticket.expiresAt, now) ||
        ticket.workspaceId !== input.workspaceId ||
        ticket.contextType !== input.contextType ||
        ticket.contextId !== input.contextId
      ) {
        return deny("ticket is revoked, expired, or outside this context");
      }
      if (ticket.deniedActions.includes(input.action)) {
        return deny("action is explicitly denied");
      }
      if (!ticket.allowedActions.includes(input.action)) {
        return deny("action is not authorized");
      }
      if (
        input.resource !== undefined &&
        ticket.resourceScopes.length > 0 &&
        !ticket.resourceScopes.some(
          (scope) =>
            input.resource === scope || input.resource?.startsWith(`${scope}/`),
        )
      ) {
        return deny("resource is outside the ticket scope");
      }
      const employee = this.tables.employees.get(ticket.principal.employeeId);
      if (employee === undefined || employee.status !== "active") {
        return deny("employee is not active");
      }
      if (
        ticket.principal.source === "delegation" &&
        ticket.principal.delegationId !== undefined
      ) {
        const delegation = this.tables.delegations.get(
          ticket.principal.delegationId,
        );
        if (
          delegation === undefined ||
          delegation.status !== "active" ||
          delegation.ownerId !== employee.id ||
          isExpired(delegation.expiresAt, now)
        ) {
          return deny("delegation is paused, revoked, or expired");
        }
        if (delegation.deniedActions.includes(input.action)) {
          return deny("delegation explicitly denies this action");
        }
        if (!delegation.allowedActions.includes(input.action)) {
          return deny("delegation does not allow this action");
        }
        if (
          input.action.startsWith("approve") &&
          delegation.approvalPolicy === "never"
        ) {
          return deny("delegation forbids final approval");
        }
      }
      const actor = employee;
      await this.audit(actor, {
        action: input.action,
        actorRole: ticket.principal.source,
        workspaceId: input.workspaceId,
        contextType: input.contextType,
        contextId: input.contextId,
        delegationId: ticket.principal.delegationId,
        runId: ticket.principal.runId,
        ticketId: ticket.id,
      });
      return ticket.principal;
    });
  }

  listTickets(
    input: { employeeId?: string; workspaceId?: string } = {},
  ): PublicActionTicket[] {
    return this.values(this.tables.actionTickets)
      .filter(
        (item) =>
          (input.employeeId === undefined ||
            item.principal.employeeId === input.employeeId) &&
          (input.workspaceId === undefined ||
            item.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listDelegations(
    input: {
      ownerId?: string | undefined;
      workspaceId?: string | undefined;
    } = {},
  ): PublicDelegation[] {
    return this.values(this.tables.delegations)
      .filter(
        (item) =>
          (input.ownerId === undefined || item.ownerId === input.ownerId) &&
          (input.workspaceId === undefined ||
            item.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getDelegation(delegationId: string): PublicDelegation {
    const delegation = this.tables.delegations.get(delegationId);
    if (delegation === undefined) {
      throw new EmployeeError("not_found", "delegation does not exist");
    }
    return delegation;
  }

  getDelegationStatus(
    delegationId: string,
  ): { status: string; expiresAt?: string } | undefined {
    const delegation = this.tables.delegations.get(delegationId);
    if (delegation === undefined) return undefined;
    return {
      status: delegation.status,
      ...(delegation.expiresAt === undefined
        ? {}
        : { expiresAt: delegation.expiresAt }),
    };
  }

  listDelegationExpiryNotices(ownerAuthUserId: string) {
    const owner = this.getByAuthUserId(ownerAuthUserId);
    if (owner === undefined) return [];
    return this.listDelegations({ ownerId: owner.id })
      .filter((item) => item.status === "expired")
      .map((item) => ({
        id: `delegation-expired:${item.id}`,
        kind: "delegation.expired" as const,
        delegationId: item.id,
        displayName: item.displayName,
        ownerName: item.ownerName,
        workspaceId: item.workspaceId,
        contextType: item.contextType,
        contextId: item.contextId,
        participantId: item.participantId,
        expiresAt: item.expiresAt,
        impact:
          item.contextType === "meeting"
            ? "该会议中的自动发言和跟进已暂停。"
            : item.contextType === "task"
              ? "该任务的自动化执行和跟进已暂停。"
              : "相关事项的自动化跟进已暂停。",
        suggestedActions: ["extend", "resume", "reassign"],
      }));
  }

  createDelegation(
    ownerAuthUserId: string,
    input: {
      displayName?: string | undefined;
      personaId?: string | undefined;
      teammateId?: string | undefined;
      teammateName?: string | undefined;
      workspaceId: string;
      ownerWorkspaceRole?: WorkspaceRole | undefined;
      contextType: Delegation["contextType"];
      contextId: string;
      objective: string;
      stance?: string | undefined;
      watchItems?: readonly string[] | undefined;
      materialScopes?: readonly string[] | undefined;
      allowedActions: readonly string[];
      deniedActions?: readonly string[] | undefined;
      speakPolicy: Delegation["speakPolicy"];
      approvalPolicy: Delegation["approvalPolicy"];
      durationMinutes?: number | undefined;
    },
  ): Promise<PublicDelegation> {
    return this.enqueue(async () => {
      const owner = this.byAuthUserId(ownerAuthUserId);
      if (owner === undefined || owner.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "active Human Employee is required",
        );
      }
      if (
        input.ownerWorkspaceRole === undefined &&
        this.activeRole(owner.id, input.workspaceId) === undefined
      ) {
        throw new EmployeeError(
          "forbidden",
          "owner must have an active workspace role",
        );
      }
      const timestamp = this.timestamp();
      const ownerPrincipalId = this.principalId(owner);
      const record = delegationSchema.parse({
        id: randomId(),
        ownerId: owner.id,
        ...(ownerPrincipalId === undefined ? {} : { ownerPrincipalId }),
        ownerAuthUserId: ownerAuthUserId,
        ownerName: owner.displayName,
        displayName:
          input.displayName ??
          (input.teammateName === undefined
            ? `${owner.displayName} · 分身`
            : `${input.teammateName} · ${DELEGATION_CONTEXT_LABELS[input.contextType]}`),
        ...(input.personaId === undefined
          ? {}
          : { personaId: input.personaId }),
        ...(input.teammateId === undefined
          ? {}
          : { teammateId: input.teammateId }),
        ...(input.teammateName === undefined
          ? {}
          : { teammateName: input.teammateName }),
        workspaceId: input.workspaceId,
        contextType: input.contextType,
        contextId: input.contextId,
        objective: input.objective,
        stance: input.stance ?? "",
        watchItems: input.watchItems ?? [],
        materialScopes: input.materialScopes ?? [],
        allowedActions: input.allowedActions,
        deniedActions: input.deniedActions ?? [
          "approval.final",
          "employee.manage",
        ],
        speakPolicy: input.speakPolicy,
        approvalPolicy: input.approvalPolicy,
        status: "active",
        ...(input.durationMinutes === undefined
          ? {}
          : {
              expiresAt: new Date(
                this.now().getTime() + input.durationMinutes * 60_000,
              ).toISOString(),
            }),
        createdBy: owner.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.tables.delegations.put(record.id, record);
      await this.audit(owner, {
        action: "delegation.created",
        actorRole: "owner",
        workspaceId: record.workspaceId,
        contextType: record.contextType,
        contextId: record.contextId,
        delegationId: record.id,
      });
      return record;
    });
  }

  changeDelegationStatus(
    ownerAuthUserId: string,
    delegationId: string,
    status: "active" | "paused" | "revoked" | "completed",
    options: { readonly allowAdmin?: boolean } = {},
  ): Promise<PublicDelegation> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(ownerAuthUserId);
      const delegation = this.tables.delegations.get(delegationId);
      if (
        actor === undefined ||
        delegation === undefined ||
        (delegation.ownerId !== actor.id && options.allowAdmin !== true)
      ) {
        throw new EmployeeError(
          "forbidden",
          "only the delegation owner or admin can change it",
        );
      }
      if (
        delegation.status === "revoked" ||
        delegation.status === "completed"
      ) {
        throw new EmployeeError("conflict", "delegation is already closed");
      }
      const updated = delegationSchema.parse({
        ...delegation,
        status,
        updatedAt: this.timestamp(),
      });
      await this.tables.delegations.put(updated.id, updated);
      await this.audit(actor, {
        action: `delegation.${status === "active" ? "resumed" : status}`,
        actorRole: "owner",
        workspaceId: updated.workspaceId,
        contextType: updated.contextType,
        contextId: updated.contextId,
        delegationId: updated.id,
      });
      return updated;
    });
  }

  extendDelegation(
    ownerAuthUserId: string,
    delegationId: string,
    durationMinutes: number,
    options: { readonly allowAdmin?: boolean } = {},
  ): Promise<PublicDelegation> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(ownerAuthUserId);
      const delegation = this.tables.delegations.get(delegationId);
      if (
        actor === undefined ||
        actor.status !== "active" ||
        delegation === undefined ||
        (delegation.ownerId !== actor.id && options.allowAdmin !== true)
      ) {
        throw new EmployeeError(
          "forbidden",
          "only the delegation owner or admin can extend it",
        );
      }
      if (!["active", "paused", "expired"].includes(delegation.status)) {
        throw new EmployeeError(
          "conflict",
          "closed delegations cannot be extended",
        );
      }
      const now = this.now();
      const base =
        delegation.expiresAt === undefined
          ? now
          : new Date(
              Math.max(now.getTime(), new Date(delegation.expiresAt).getTime()),
            );
      const updated = delegationSchema.parse({
        ...delegation,
        ...(delegation.status === "expired" ? { status: "active" } : {}),
        expiresAt: new Date(
          base.getTime() + durationMinutes * 60_000,
        ).toISOString(),
        updatedAt: this.timestamp(),
      });
      await this.tables.delegations.put(updated.id, updated);
      await this.audit(actor, {
        action: "delegation.extended",
        actorRole:
          options.allowAdmin && delegation.ownerId !== actor.id
            ? "admin"
            : "owner",
        workspaceId: updated.workspaceId,
        contextType: updated.contextType,
        contextId: updated.contextId,
        delegationId: updated.id,
        metadata: { durationMinutes },
      });
      return updated;
    });
  }

  attachParticipant(
    delegationId: string,
    participantId: string,
  ): Promise<PublicDelegation> {
    return this.enqueue(async () => {
      const delegation = this.getDelegation(delegationId);
      const updated = delegationSchema.parse({
        ...delegation,
        participantId,
        updatedAt: this.timestamp(),
      });
      await this.tables.delegations.put(updated.id, updated);
      return updated;
    });
  }

  issueDelegationTicket(
    actorAuthUserId: string,
    input: {
      delegationId: string;
      requestedActions: readonly string[];
      resourceScopes?: readonly string[] | undefined;
      durationMinutes?: number | undefined;
    },
    options: { readonly allowAdmin?: boolean } = {},
  ): Promise<PublicActionTicket> {
    return this.enqueue(async () => {
      const actor = this.byAuthUserId(actorAuthUserId);
      const delegation = this.getDelegation(input.delegationId);
      const owner = this.requireEmployee(delegation.ownerId);
      if (
        actor === undefined ||
        actor.status !== "active" ||
        (delegation.ownerId !== actor.id && options.allowAdmin !== true)
      ) {
        throw new EmployeeError(
          "forbidden",
          "only the delegation owner or admin can issue its ticket",
        );
      }
      if (owner.status !== "active" || delegation.status !== "active") {
        throw new EmployeeError(
          "forbidden",
          "delegation or owner is unavailable",
        );
      }
      const role = this.activeRole(owner.id, delegation.workspaceId);
      if (role === undefined) {
        throw new EmployeeError(
          "forbidden",
          "owner no longer has a workspace role",
        );
      }
      const requested = intersect(
        intersect(input.requestedActions, role.permissions),
        delegation.allowedActions,
      );
      const deniedActions = intersect(
        input.requestedActions,
        delegation.deniedActions,
      );
      const allowedActions = requested.filter(
        (action) => !deniedActions.includes(action),
      );
      const now = this.now();
      const maxDuration =
        delegation.expiresAt === undefined
          ? (input.durationMinutes ?? 60)
          : Math.max(
              1,
              Math.ceil(
                (new Date(delegation.expiresAt).getTime() - now.getTime()) /
                  60_000,
              ),
            );
      const ownerPrincipalId = this.principalId(owner);
      const ticket = actionTicketSchema.parse({
        id: randomId(),
        principal: employeePrincipalSchema.parse({
          employeeId: owner.id,
          ...(ownerPrincipalId === undefined
            ? {}
            : { principalId: ownerPrincipalId }),
          employeeKind: "human",
          authUserId: owner.authUserId,
          source: "delegation",
          delegationId: delegation.id,
          workspaceId: delegation.workspaceId,
        }),
        ownerId: owner.id,
        workspaceId: delegation.workspaceId,
        contextType: delegation.contextType,
        contextId: delegation.contextId,
        allowedActions,
        deniedActions,
        resourceScopes: intersect(
          input.resourceScopes ?? [],
          delegation.materialScopes,
        ),
        status: "active",
        expiresAt: new Date(
          now.getTime() +
            Math.min(input.durationMinutes ?? maxDuration, maxDuration) *
              60_000,
        ).toISOString(),
        createdAt: this.timestamp(),
        issuedBy: owner.id,
      });
      await this.tables.actionTickets.put(ticket.id, ticket);
      await this.audit(owner, {
        action: "delegation.ticket.issued",
        actorRole: "delegation",
        workspaceId: delegation.workspaceId,
        contextType: delegation.contextType,
        contextId: delegation.contextId,
        delegationId: delegation.id,
        ticketId: ticket.id,
      });
      return ticket;
    });
  }

  listReports(
    input: {
      ownerId?: string | undefined;
      delegationId?: string | undefined;
    } = {},
  ): PublicDelegationReport[] {
    const delegationIds = new Set(
      this.listDelegations({ ownerId: input.ownerId }).map((item) => item.id),
    );
    return this.values(this.tables.delegationReports)
      .filter(
        (item) =>
          (input.delegationId === undefined ||
            item.delegationId === input.delegationId) &&
          (input.ownerId === undefined || delegationIds.has(item.delegationId)),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  generateDelegationReport(
    delegationId: string,
    transcript: string,
    options: { finalize?: boolean } = {},
  ): Promise<PublicDelegationReport> {
    return this.enqueue(async () => {
      const delegation = this.getDelegation(delegationId);
      const timestamp = this.timestamp();
      const digest = createHash("sha256")
        .update(transcript)
        .digest("hex")
        .slice(0, 24);
      const success = transcript.trim() !== "";
      const record = delegationReportSchema.parse({
        id: randomId(),
        delegationId: delegation.id,
        workspaceId: delegation.workspaceId,
        contextType: delegation.contextType,
        contextId: delegation.contextId,
        status: success ? "generated" : "failed",
        report: success ? reportContent(delegation, transcript) : "",
        ...(success ? {} : { error: "缺少会议记录，不能生成分身报告" }),
        transcriptDigest: digest,
        createdBy: delegation.ownerId,
        createdAt: timestamp,
      });
      await this.tables.delegationReports.put(record.id, record);
      await this.audit(
        { id: delegation.ownerId, authUserId: delegation.ownerAuthUserId },
        {
          action: success
            ? "delegation.report_generated"
            : "delegation.report_failed",
          decision: success ? "allowed" : "denied",
          reason: record.error ?? "",
          actorRole: "delegation",
          workspaceId: delegation.workspaceId,
          contextType: delegation.contextType,
          contextId: delegation.contextId,
          delegationId: delegation.id,
          metadata: { reportId: record.id },
        },
      );
      if (success && options.finalize === true) {
        await this.tables.delegations.put(delegation.id, {
          ...delegation,
          status: "completed",
          updatedAt: timestamp,
        });
      }
      return record;
    });
  }

  listAudit(
    input: {
      employeeId?: string | undefined;
      workspaceId?: string | undefined;
      delegationId?: string | undefined;
      limit?: number;
    } = {},
  ): PublicAuditEvent[] {
    return this.values(this.tables.auditEvents)
      .filter(
        (item) =>
          (input.employeeId === undefined ||
            item.actorEmployeeId === input.employeeId) &&
          (input.workspaceId === undefined ||
            item.workspaceId === input.workspaceId) &&
          (input.delegationId === undefined ||
            item.delegationId === input.delegationId),
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, input.limit ?? 100);
  }

  async sweepExpired(): Promise<{ delegations: number; tickets: number }> {
    return this.enqueue(async () => {
      const now = this.now();
      let expiredDelegations = 0;
      let expiredTickets = 0;
      for (const delegation of this.values(this.tables.delegations)) {
        if (
          ["active", "paused"].includes(delegation.status) &&
          isExpired(delegation.expiresAt, now)
        ) {
          await this.tables.delegations.put(delegation.id, {
            ...delegation,
            status: "expired",
            updatedAt: this.timestamp(),
          });
          await this.audit(
            { id: delegation.ownerId, authUserId: delegation.ownerAuthUserId },
            {
              action: "delegation.expired",
              actorRole: "delegation",
              workspaceId: delegation.workspaceId,
              contextType: delegation.contextType,
              contextId: delegation.contextId,
              delegationId: delegation.id,
            },
          );
          expiredDelegations += 1;
        }
      }
      for (const ticket of this.values(this.tables.actionTickets)) {
        if (ticket.status === "active" && isExpired(ticket.expiresAt, now)) {
          await this.tables.actionTickets.put(ticket.id, {
            ...ticket,
            status: "expired",
          });
          expiredTickets += 1;
        }
      }
      return { delegations: expiredDelegations, tickets: expiredTickets };
    });
  }
}
