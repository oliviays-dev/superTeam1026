import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  sameOrigin,
  sendJson,
  readJsonBody,
} from "@pluginmax/shared";
import { z } from "zod";
import {
  actionTicketSchema,
  approvalPolicySchema,
  auditEventSchema,
  contextTypeSchema,
  delegationContextSchema,
  delegationReportSchema,
  delegationSchema,
  delegationStatusSchema,
  employeeSchema,
  employeeStatusSchema,
  profileStatusSchema,
  roleAssignmentSchema,
  runtimeProfileSchema,
  speakPolicySchema,
  workspaceRoleSchema,
} from "./models.js";
import {
  EmployeeError,
  EmployeeService,
  type KvTableLike,
  type PersonaServiceLike,
  type PrincipalServiceLike,
  type PublicEmployee,
} from "./service.js";

export {
  EMPLOYEE_KINDS,
  EMPLOYEE_STATUSES,
  employeeKindSchema,
  employeeStatusSchema,
} from "./models.js";
export type { Employee, EmployeeKind, EmployeeStatus } from "./models.js";
export { EmployeeError, EmployeeService } from "./service.js";

export const name = "dsh-collab-employee";
export const inject = ["storageDomain", "webServer"];

type EmployeeStorageTableName =
  | "employees"
  | "role_assignments"
  | "runtime_profiles"
  | "delegations"
  | "delegation_reports"
  | "action_tickets"
  | "audit_events";

interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly compatibleVersions?: readonly number[];
  readonly tables: Record<string, { readonly valueSchema: z.ZodType<unknown> }>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface TeamMemberLike {
  readonly userId: string;
  readonly memberRole?: "owner" | "member" | "guest";
}

interface TeamServiceLike {
  resolveToken(token: string):
    | {
        readonly userId: string;
        readonly role: "admin" | "owner" | "member" | "guest";
      }
    | undefined;
  users(): readonly {
    readonly id: string;
    readonly name: string;
    readonly status?: "active" | "disabled";
  }[];
  updateUser(
    actorId: string,
    targetId: string,
    changes: { readonly status?: "active" | "disabled" },
  ): Promise<unknown>;
  registerUser(
    actorId: string,
    input: {
      readonly userId: string;
      readonly name: string;
      readonly password: string;
      readonly role: "admin" | "owner" | "member" | "guest";
    },
  ): Promise<{ readonly id: string }>;
  members(workspaceId: string): readonly TeamMemberLike[];
}

export const employeeDomainSpec: DomainSpecLike = {
  name: "collab_employee",
  version: 2,
  compatibleVersions: [1],
  tables: {
    employees: { valueSchema: employeeSchema as unknown as z.ZodType<unknown> },
    role_assignments: {
      valueSchema: roleAssignmentSchema as unknown as z.ZodType<unknown>,
    },
    runtime_profiles: {
      valueSchema: runtimeProfileSchema as unknown as z.ZodType<unknown>,
    },
    delegations: {
      valueSchema: delegationSchema as unknown as z.ZodType<unknown>,
    },
    delegation_reports: {
      valueSchema: delegationReportSchema as unknown as z.ZodType<unknown>,
    },
    action_tickets: {
      valueSchema: actionTicketSchema as unknown as z.ZodType<unknown>,
    },
    audit_events: {
      valueSchema: auditEventSchema as unknown as z.ZodType<unknown>,
    },
  },
};

function requestHeader(
  request: IncomingMessage,
  key: string,
): string | undefined {
  const value = request.headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requireBrowserPrincipal(
  request: IncomingMessage,
  team: TeamServiceLike,
): TeamServiceLike extends never
  ? never
  : {
      userId: string;
      role: "admin" | "owner" | "member" | "guest";
      token: string;
    } {
  const origin = requestHeader(request, "origin");
  const host = requestHeader(request, "host");
  if (origin !== undefined && !sameOrigin(origin, host)) {
    throw new EmployeeError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name) =>
      name === "authorization" ? (request.headers.authorization ?? null) : null,
  });
  if (token === undefined) {
    throw new EmployeeError("unauthorized", "bearer token is required");
  }
  const principal = team.resolveToken(token);
  if (principal === undefined) {
    throw new EmployeeError("unauthorized", "invalid or expired token");
  }
  return { ...principal, token };
}

function requireAdmin(
  request: IncomingMessage,
  team: TeamServiceLike,
): { userId: string; role: "admin" | "owner" | "member" | "guest" } {
  const principal = requireBrowserPrincipal(request, team);
  if (principal.role !== "admin") {
    throw new EmployeeError("forbidden", "admin role is required");
  }
  return principal;
}

function canReadEmployee(
  principal: { readonly role: "admin" | "owner" | "member" | "guest" },
  me: PublicEmployee | undefined,
  employee: PublicEmployee,
): boolean {
  return (
    principal.role === "admin" ||
    me?.id === employee.id ||
    (me !== undefined && employee.managerEmployeeId === me.id)
  );
}

function requireReadableEmployee(
  principal: { readonly role: "admin" | "owner" | "member" | "guest" },
  me: PublicEmployee | undefined,
  employee: PublicEmployee,
): void {
  if (!canReadEmployee(principal, me, employee)) {
    throw new EmployeeError(
      "forbidden",
      "employee detail and authorization require admin, self, or manager access",
    );
  }
}

function canManageWorkspace(
  request: IncomingMessage,
  team: TeamServiceLike,
  workspaceId: string,
): { userId: string; role: "admin" | "owner" | "member" | "guest" } {
  const principal = requireBrowserPrincipal(request, team);
  const workspaceOwner = team
    .members(workspaceId)
    .some(
      (member) =>
        member.userId === principal.userId && member.memberRole === "owner",
    );
  if (principal.role !== "admin" && !workspaceOwner) {
    throw new EmployeeError(
      "forbidden",
      "workspace owner or admin role is required",
    );
  }
  return principal;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request, 256 * 1024);
  } catch {
    throw new EmployeeError("invalid_input", "valid JSON body is required");
  }
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EmployeeError("invalid_input", "request input is invalid");
  }
  return result.data;
}

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

function requireQuery(request: IncomingMessage, key: string): string {
  const value = query(request).get(key);
  if (value === null || value.trim() === "") {
    throw new EmployeeError("invalid_input", `${key} is required`);
  }
  return value;
}

function errorStatus(code: EmployeeError["code"]): number {
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "conflict") return 409;
  if (code === "gone") return 410;
  return 400;
}

async function runHandler(
  operation: () => Promise<void> | void,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof EmployeeError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "employee request failed" },
    });
  }
}

export function createEmployeeRoutes(
  service: EmployeeService,
  team: () => TeamServiceLike | undefined,
  options: { readonly compatibilityWrites?: boolean } = {},
): WebRouteLike[] {
  const requireTeam = (): TeamServiceLike => {
    const value = team();
    if (value === undefined) {
      throw new EmployeeError("not_found", "identity service is unavailable");
    }
    return value;
  };
  const methods = (allowed: string, request: IncomingMessage): void => {
    if (request.method !== allowed) {
      throw new EmployeeError("invalid_input", "method not allowed");
    }
  };
  const requireCompatibilityWrite = (): void => {
    if (options.compatibilityWrites === true) return;
    throw new EmployeeError(
      "gone",
      "Employee 产品写入已下线；请通过平台账号、Principal 授权和 AI 伙伴管理完成对应操作",
    );
  };
  const sync = async (): Promise<void> => {
    await service.syncIdentityUsers(requireTeam().users());
  };
  const currentEmployee = async (
    request: IncomingMessage,
  ): Promise<NonNullable<ReturnType<EmployeeService["getByAuthUserId"]>>> => {
    const identity = requireTeam();
    const principal = requireBrowserPrincipal(request, identity);
    await service.syncIdentityUsers(identity.users());
    const employee = service.getByAuthUserId(principal.userId);
    if (employee === undefined) {
      throw new EmployeeError("not_found", "employee record not found");
    }
    return employee;
  };
  return [
    {
      kind: "exact",
      path: "/api/collab/employee",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          requireAdmin(request, identity);
          await sync();
          sendJson(response, 200, { ok: true, employees: service.list() });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/me",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const employee = await currentEmployee(request);
          sendJson(response, 200, { ok: true, employee });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/export",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          requireAdmin(request, requireTeam());
          sendJson(response, 200, {
            ok: true,
            export: service.exportCompatibilityData(),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/compatibility",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          requireAdmin(request, requireTeam());
          sendJson(response, 200, {
            ok: true,
            report: service.compatibilityReport(),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/human",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const actor = requireAdmin(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z
                .string()
                .trim()
                .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
                .optional(),
              displayName: z.string().trim().min(1).max(120),
              email: z.string().email().max(160).optional(),
              department: z.string().trim().max(120).optional(),
              title: z.string().trim().max(120).optional(),
              tags: z
                .array(z.string().trim().min(1).max(32))
                .max(16)
                .optional(),
              managerEmployeeId: z.string().trim().min(1).max(120).optional(),
              account: z
                .object({
                  userId: z
                    .string()
                    .trim()
                    .min(1)
                    .max(64)
                    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
                  password: z.string().min(8).max(256),
                })
                .optional(),
            }),
            await readBody(request),
          );
          if (
            body.employeeId !== undefined &&
            service.list().some((employee) => employee.id === body.employeeId)
          ) {
            throw new EmployeeError(
              "conflict",
              `employee id already exists: ${body.employeeId}`,
            );
          }
          if (body.managerEmployeeId !== undefined) {
            const manager = service
              .list()
              .find((employee) => employee.id === body.managerEmployeeId);
            if (manager === undefined || manager.status === "archived") {
              throw new EmployeeError(
                "invalid_input",
                "manager employee does not exist",
              );
            }
          }
          const user =
            body.account === undefined
              ? undefined
              : await identity.registerUser(actor.userId, {
                  userId: body.account.userId,
                  name: body.displayName,
                  password: body.account.password,
                  role: "member",
                });
          let employee: Awaited<ReturnType<EmployeeService["createHuman"]>>;
          try {
            employee = await service.createHuman(actor.userId, {
              ...(body.employeeId === undefined
                ? {}
                : { employeeId: body.employeeId }),
              displayName: body.displayName,
              ...(body.email === undefined ? {} : { email: body.email }),
              ...(body.department === undefined
                ? {}
                : { department: body.department }),
              ...(body.title === undefined ? {} : { title: body.title }),
              ...(body.tags === undefined ? {} : { tags: body.tags }),
              ...(user === undefined ? {} : { authUserId: user.id }),
              ...(body.managerEmployeeId === undefined
                ? {}
                : { managerEmployeeId: body.managerEmployeeId }),
            });
          } catch (cause) {
            if (user !== undefined) {
              await identity
                .updateUser(actor.userId, user.id, { status: "disabled" })
                .catch(() => undefined);
            }
            throw cause;
          }
          sendJson(response, 201, {
            ok: true,
            employee,
            ...(user === undefined ? {} : { user }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/digital",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const actor = requireAdmin(request, requireTeam());
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z
                .string()
                .trim()
                .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
                .optional(),
              displayName: z.string().trim().min(1).max(120),
              email: z.string().email().max(160).optional(),
              department: z.string().trim().max(120).optional(),
              title: z.string().trim().max(120).optional(),
              tags: z
                .array(z.string().trim().min(1).max(32))
                .max(16)
                .optional(),
              personaId: z.string().trim().min(1).max(120),
              managerEmployeeId: z.string().trim().min(1).max(120),
            }),
            await readBody(request),
          );
          const employee = await service.createDigital(actor.userId, body);
          sendJson(response, 201, { ok: true, employee });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/detail",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          const employee = service.get(requireQuery(request, "employeeId"));
          const me = service.getByAuthUserId(principal.userId);
          requireReadableEmployee(principal, me, employee);
          sendJson(response, 200, {
            ok: true,
            employee,
            roles: service.listRoles({ employeeId: employee.id }),
            runtimeProfiles: service.listProfiles({ employeeId: employee.id }),
            delegations:
              me === undefined
                ? []
                : service.listDelegations({ ownerId: me.id }),
            tickets:
              principal.role === "admin"
                ? service.listTickets({ employeeId: employee.id })
                : [],
            audit:
              principal.role === "admin"
                ? service.listAudit({ employeeId: employee.id })
                : [],
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/update",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const actor = requireAdmin(request, requireTeam());
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z.string().min(1),
              displayName: z.string().trim().min(1).max(120).optional(),
              email: z.string().email().max(160).nullable().optional(),
              department: z.string().trim().max(120).optional(),
              title: z.string().trim().max(120).optional(),
              tags: z
                .array(z.string().trim().min(1).max(32))
                .max(16)
                .optional(),
              personaId: z.string().trim().min(1).max(120).optional(),
              managerEmployeeId: z.string().trim().min(1).max(120).optional(),
            }),
            await readBody(request),
          );
          const employee = await service.updateDigital(
            actor.userId,
            body.employeeId,
            body,
          );
          sendJson(response, 200, { ok: true, employee });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/status",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const actor = requireAdmin(request, requireTeam());
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z.string().min(1),
              status: employeeStatusSchema,
            }),
            await readBody(request),
          );
          const employee = await service.changeStatus(
            actor.userId,
            body.employeeId,
            body.status,
          );
          sendJson(response, 200, { ok: true, employee });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/roles",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          const employee = service.get(requireQuery(request, "employeeId"));
          const me = service.getByAuthUserId(principal.userId);
          requireReadableEmployee(principal, me, employee);
          sendJson(response, 200, {
            ok: true,
            roles: service.listRoles({
              employeeId: employee.id,
              workspaceId: query(request).get("workspaceId") ?? undefined,
            }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/roles/assign",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z.string().min(1),
              workspaceId: z.string().min(1),
              role: workspaceRoleSchema,
              permissions: z
                .array(z.string().trim().min(1).max(120))
                .max(100)
                .optional(),
              durationMinutes: z.number().int().min(1).max(43_200).optional(),
            }),
            await readBody(request),
          );
          const actor = canManageWorkspace(request, identity, body.workspaceId);
          const role = await service.assignRole(actor.userId, body);
          sendJson(response, 201, { ok: true, role });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/roles/revoke",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const actor = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({ assignmentId: z.string().min(1) }),
            await readBody(request),
          );
          const assignment = service
            .listRoles()
            .find((item) => item.id === body.assignmentId);
          if (assignment === undefined) {
            throw new EmployeeError(
              "not_found",
              "role assignment does not exist",
            );
          }
          canManageWorkspace(request, identity, assignment.workspaceId);
          const role = await service.revokeRole(
            actor.userId,
            body.assignmentId,
          );
          sendJson(response, 200, { ok: true, role });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/runtime",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          const employee = service.get(requireQuery(request, "employeeId"));
          const me = service.getByAuthUserId(principal.userId);
          requireReadableEmployee(principal, me, employee);
          sendJson(response, 200, {
            ok: true,
            runtimeProfiles: service.listProfiles({
              employeeId: employee.id,
              workspaceId: query(request).get("workspaceId") ?? undefined,
            }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/runtime/upsert",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              id: z.string().min(1).optional(),
              employeeId: z.string().min(1),
              workspaceId: z.string().min(1),
              name: z.string().trim().min(1).max(120),
              provider: z.string().trim().min(1).max(80).optional(),
              model: z.string().trim().max(160).optional(),
              reasoningEffort: z.string().trim().max(40).optional(),
              allowedTools: z
                .array(z.string().trim().min(1).max(120))
                .max(100)
                .optional(),
              deniedTools: z
                .array(z.string().trim().min(1).max(120))
                .max(100)
                .optional(),
              resourceScopes: z
                .array(z.string().trim().min(1).max(200))
                .max(100)
                .optional(),
              maxTurns: z.number().int().min(1).max(1_000).optional(),
              maxMinutes: z.number().int().min(1).max(1_440).optional(),
              status: profileStatusSchema.optional(),
              legacyAgentProfileId: z
                .string()
                .trim()
                .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
                .optional(),
            }),
            await readBody(request),
          );
          canManageWorkspace(request, identity, body.workspaceId);
          const actor = requireBrowserPrincipal(request, identity);
          const runtimeProfile = await service.upsertRuntimeProfile(
            actor.userId,
            body,
          );
          sendJson(response, 200, { ok: true, runtimeProfile });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/ticket",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const actor = requireAdmin(request, requireTeam());
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              employeeId: z.string().min(1),
              workspaceId: z.string().min(1),
              contextType: contextTypeSchema,
              contextId: z.string().min(1),
              requestedActions: z
                .array(z.string().trim().min(1).max(120))
                .max(100),
              resourceScopes: z
                .array(z.string().trim().min(1).max(200))
                .max(100)
                .optional(),
              runId: z.string().min(1).optional(),
              durationMinutes: z.number().int().min(1).max(1_440).optional(),
            }),
            await readBody(request),
          );
          const ticket = await service.issueRuntimeTicket(actor.userId, body);
          sendJson(response, 201, { ok: true, ticket });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          const me = service.getByAuthUserId(principal.userId);
          if (me === undefined) {
            throw new EmployeeError("not_found", "employee record not found");
          }
          const workspaceId = query(request).get("workspaceId") ?? undefined;
          sendJson(response, 200, {
            ok: true,
            delegations:
              principal.role === "admin"
                ? service.listDelegations({ workspaceId })
                : service.listDelegations({ ownerId: me.id, workspaceId }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/create",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          await sync();
          const body = parseOrInvalid(
            z.object({
              displayName: z.string().trim().min(1).max(80).optional(),
              personaId: z.string().trim().min(1).max(120).optional(),
              teammateId: z.string().trim().min(1).max(120).optional(),
              teammateName: z.string().trim().min(1).max(80).optional(),
              workspaceId: z.string().min(1),
              contextType: delegationContextSchema,
              contextId: z.string().min(1),
              objective: z.string().trim().min(1).max(4_000),
              stance: z.string().trim().max(4_000).optional(),
              watchItems: z
                .array(z.string().trim().min(1).max(500))
                .max(20)
                .optional(),
              materialScopes: z
                .array(z.string().trim().min(1).max(200))
                .max(50)
                .optional(),
              allowedActions: z
                .array(z.string().trim().min(1).max(120))
                .max(100),
              deniedActions: z
                .array(z.string().trim().min(1).max(120))
                .max(100)
                .optional(),
              speakPolicy: speakPolicySchema,
              approvalPolicy: approvalPolicySchema,
              durationMinutes: z.number().int().min(1).max(10_080).optional(),
            }),
            await readBody(request),
          );
          const delegation = await service.createDelegation(
            principal.userId,
            body,
          );
          sendJson(response, 201, { ok: true, delegation });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/detail",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          const delegation = service.getDelegation(
            requireQuery(request, "delegationId"),
          );
          const me = service.getByAuthUserId(principal.userId);
          if (principal.role !== "admin" && delegation.ownerId !== me?.id) {
            throw new EmployeeError(
              "forbidden",
              "only the owner or admin can read this delegation",
            );
          }
          sendJson(response, 200, {
            ok: true,
            delegation,
            reports: service.listReports({ delegationId: delegation.id }),
            audit:
              principal.role === "admin"
                ? service.listAudit({ delegationId: delegation.id })
                : [],
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/extend",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              delegationId: z.string().min(1),
              durationMinutes: z.number().int().min(1).max(10_080),
            }),
            await readBody(request),
          );
          const delegation = await service.extendDelegation(
            principal.userId,
            body.delegationId,
            body.durationMinutes,
            { allowAdmin: principal.role === "admin" },
          );
          sendJson(response, 200, { ok: true, delegation });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/status",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              delegationId: z.string().min(1),
              status: delegationStatusSchema.exclude(["expired"]),
            }),
            await readBody(request),
          );
          const delegation = await service.changeDelegationStatus(
            principal.userId,
            body.delegationId,
            body.status,
            { allowAdmin: principal.role === "admin" },
          );
          sendJson(response, 200, { ok: true, delegation });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/ticket",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          const body = parseOrInvalid(
            z.object({
              delegationId: z.string().min(1),
              requestedActions: z
                .array(z.string().trim().min(1).max(120))
                .max(100),
              resourceScopes: z
                .array(z.string().trim().min(1).max(200))
                .max(100)
                .optional(),
              durationMinutes: z.number().int().min(1).max(10_080).optional(),
            }),
            await readBody(request),
          );
          const ticket = await service.issueDelegationTicket(
            principal.userId,
            body,
            {
              allowAdmin: principal.role === "admin",
            },
          );
          sendJson(response, 201, { ok: true, ticket });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/report",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          await service.sweepExpired();
          const me = service.getByAuthUserId(principal.userId);
          if (me === undefined) {
            throw new EmployeeError("not_found", "employee record not found");
          }
          const delegationId = query(request).get("delegationId");
          if (delegationId !== null) {
            const delegation = service.getDelegation(delegationId);
            if (principal.role !== "admin" && delegation.ownerId !== me.id) {
              throw new EmployeeError(
                "forbidden",
                "only the owner or admin can read this report",
              );
            }
          }
          sendJson(response, 200, {
            ok: true,
            reports: service.listReports({
              ownerId: principal.role === "admin" ? undefined : me.id,
              delegationId: delegationId ?? undefined,
            }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/expiry-notices",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          await sync();
          await service.sweepExpired();
          sendJson(response, 200, {
            ok: true,
            notices: service.listDelegationExpiryNotices(principal.userId),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/delegation/report/retry",
      handler: (request, response) =>
        runHandler(async () => {
          methods("POST", request);
          const identity = requireTeam();
          const principal = requireBrowserPrincipal(request, identity);
          requireCompatibilityWrite();
          await sync();
          const body = parseOrInvalid(
            z.object({
              delegationId: z.string().min(1),
              transcript: z.string().max(100_000),
              finalize: z.boolean().default(false),
            }),
            await readBody(request),
          );
          const delegation = service.getDelegation(body.delegationId);
          const me = service.getByAuthUserId(principal.userId);
          if (principal.role !== "admin" && delegation.ownerId !== me?.id) {
            throw new EmployeeError(
              "forbidden",
              "only the owner or admin can retry the report",
            );
          }
          const report = await service.generateDelegationReport(
            body.delegationId,
            body.transcript,
            { finalize: body.finalize },
          );
          sendJson(response, 201, { ok: true, report });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/audit",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          requireAdmin(request, requireTeam());
          sendJson(response, 200, {
            ok: true,
            audit: service.listAudit({
              employeeId: query(request).get("employeeId") ?? undefined,
              workspaceId: query(request).get("workspaceId") ?? undefined,
              delegationId: query(request).get("delegationId") ?? undefined,
              limit: Number(query(request).get("limit") ?? 100),
            }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/employee/governance",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          requireAdmin(request, requireTeam());
          const workspaceId = query(request).get("workspaceId") ?? undefined;
          const employeeId = query(request).get("employeeId") ?? undefined;
          const roles = service.listRoles({ employeeId, workspaceId });
          const profiles = service.listProfiles({ employeeId, workspaceId });
          const employees = service.list().filter((employee) => {
            if (employeeId !== undefined && employee.id !== employeeId) {
              return false;
            }
            if (workspaceId === undefined) return true;
            return roles.some((role) => role.employeeId === employee.id);
          });
          const tickets = service.listTickets({
            ...(employeeId === undefined ? {} : { employeeId }),
            ...(workspaceId === undefined ? {} : { workspaceId }),
          });
          const delegations = service.listDelegations({ workspaceId });
          const reports = service
            .listReports()
            .filter((report) =>
              workspaceId === undefined
                ? true
                : report.workspaceId === workspaceId,
            )
            .filter((report) =>
              employeeId === undefined
                ? true
                : delegations.some(
                    (delegation) =>
                      delegation.id === report.delegationId &&
                      delegation.ownerId === employeeId,
                  ),
            );
          const audit = service.listAudit({
            employeeId,
            workspaceId,
            delegationId: query(request).get("delegationId") ?? undefined,
            limit: Number(query(request).get("limit") ?? 200),
          });
          sendJson(response, 200, {
            ok: true,
            employees,
            roles,
            profiles,
            tickets,
            delegations,
            reports,
            audit,
          });
        }, response),
    },
  ];
}

export interface EmployeeContext {
  storageDomain: {
    open(spec: typeof employeeDomainSpec): Promise<{
      table<T>(name: EmployeeStorageTableName): KvTableLike<T>;
      close(): Promise<void>;
    }>;
  };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: "collabEmployee", value: EmployeeService): unknown;
  effect(operation: () => () => void): void;
  collabTeam?: TeamServiceLike;
  collabPersonas?: PersonaServiceLike;
  get(
    key: "collabPersonas" | "collabPrincipal",
  ): PersonaServiceLike | PrincipalServiceLike | undefined;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: EmployeeContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void } | void;
}

export async function apply(
  ctx: EmployeeContext,
): Promise<void | (() => void)> {
  const domain = await ctx.storageDomain.open(employeeDomainSpec);
  const service = new EmployeeService(
    {
      employees: domain.table("employees"),
      roleAssignments: domain.table("role_assignments"),
      runtimeProfiles: domain.table("runtime_profiles"),
      delegations: domain.table("delegations"),
      delegationReports: domain.table("delegation_reports"),
      actionTickets: domain.table("action_tickets"),
      auditEvents: domain.table("audit_events"),
    },
    {
      personas: () =>
        ctx.get("collabPersonas") as PersonaServiceLike | undefined,
    },
  );
  service.setPrincipalService(
    () => ctx.get("collabPrincipal") as PrincipalServiceLike | undefined,
  );
  ctx.provide("collabEmployee", service);
  const identityFiber = ctx.inject(["collabTeam"], (child) => {
    service.setIdentityService(() => child.collabTeam);
    void service.syncIdentityUsers(child.collabTeam.users());
    for (const route of createEmployeeRoutes(service, () => child.collabTeam, {
      compatibilityWrites: false,
    })) {
      ctx.webServer.register(route);
    }
  });
  ctx.effect(() => () => {
    identityFiber?.dispose();
    void domain.close();
  });
}
