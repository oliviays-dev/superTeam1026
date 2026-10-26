import {
  type AuthorizationPermission,
  type AuthorizationRepository,
  type AuthorizationResourceType,
  type ScopeAuthorizationDecision,
  type ScopedAuthorizationPermission,
} from "@pluginmax/database";

export interface AuthorizedRequestPrincipal {
  readonly principalId: string;
  readonly displayName: string;
  readonly kind: "human" | "ai";
  readonly authSource: "bearer" | "local-development";
  readonly accountId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface RouteAuthorizationInput {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly principal: AuthorizedRequestPrincipal;
  readonly params: Record<string, unknown>;
  readonly body?: unknown;
}

export type RouteAuthorizationResult =
  | {
      readonly required: false;
    }
  | {
      readonly required: true;
      readonly allowed: boolean;
      readonly decision?: ScopeAuthorizationDecision;
      readonly reason?: string;
    };

interface ProjectRouteRequirement {
  readonly projectId?: string | undefined;
  readonly resourceType?: AuthorizationResourceType | undefined;
  readonly resourceId?: string | undefined;
  readonly permission: ScopedAuthorizationPermission;
}

const SELF_WRITE_ROUTES = new Set([
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/change-password",
  "POST /api/v1/direct-chats",
  "POST /api/v1/direct-chats/:threadId/messages",
  "POST /api/v1/direct-chats/:threadId/turns/:turnId/retry",
  "POST /api/v1/direct-chats/:threadId/turns/:turnId/cancel",
  "POST /api/v1/workbench/brief/refresh",
  "POST /api/v1/workbench/brief/:briefId/read",
  "PATCH /api/v1/workbench/brief/settings",
  "POST /api/v1/workbench/follows",
  "POST /api/v1/workflows/validate",
]);

const PLATFORM_ADMIN_WRITE_PREFIXES = [
  "/api/v1/accounts/",
  "/api/v1/jobs/",
  "/api/v1/operations/",
  "/api/v1/project-templates",
  "/api/v1/template-roles",
  "/api/v1/workflow-templates",
] as const;

const PLATFORM_ACCESS_WRITE_PREFIXES = [
  "/api/v1/agents",
  "/api/v1/runtimes",
] as const;

function parameter(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  return typeof value === "string" ? value : undefined;
}

function bodyProjectId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>).projectId;
  return typeof value === "string" ? value : undefined;
}

function actionFor(method: string, route: string): string {
  return `authorization.http.${method.toLowerCase()}.${route
    .replace(/^\/api\/v1\//, "")
    .replaceAll("/", ".")
    .replaceAll(":", "")
    .replaceAll("-", "_")}`;
}

function directProjectRequirement(
  route: string,
  params: Record<string, unknown>,
): ProjectRouteRequirement | undefined {
  const projectId = parameter(params, "projectId");
  if (projectId === undefined) return undefined;
  if (route.includes("/roles")) {
    return { projectId, permission: "manage_roles" };
  }
  if (route.includes("/members")) {
    return { projectId, permission: "manage_members" };
  }
  if (
    route.includes("/memory/reviews") ||
    route.includes("/memory/topics/:topicId/truths") ||
    route.endsWith("/handoffs/:handoffId/confirm")
  ) {
    return { projectId, permission: "approve" };
  }
  if (route.endsWith("/reports/generate")) {
    return { projectId, permission: "approve" };
  }
  return { projectId, permission: "write" };
}

function resourceRequirement(
  method: string,
  route: string,
  params: Record<string, unknown>,
  body: unknown,
): ProjectRouteRequirement | "self" | undefined {
  if (route === "/api/v1/tasks" && method === "POST") {
    const projectId = bodyProjectId(body);
    return projectId === undefined
      ? undefined
      : { projectId, permission: "write" };
  }
  if (route === "/api/v1/tasks/:id") {
    return {
      resourceType: "task",
      resourceId: parameter(params, "id"),
      permission: "write",
    };
  }
  if (route === "/api/v1/tasks/:id/dispatch") {
    return {
      resourceType: "task",
      resourceId: parameter(params, "id"),
      permission: "write",
    };
  }
  if (route === "/api/v1/tasks/:id/transfer") {
    return {
      resourceType: "task",
      resourceId: parameter(params, "id"),
      permission: "manage_members",
    };
  }
  if (route === "/api/v1/tasks/:id/review") {
    return {
      resourceType: "task",
      resourceId: parameter(params, "id"),
      permission: "approve",
    };
  }
  if (
    route === "/api/v1/tasks/:id/messages" ||
    route === "/api/v1/tasks/:id/attachments"
  ) {
    return {
      resourceType: "task",
      resourceId: parameter(params, "id"),
      permission: "write",
    };
  }
  if (route === "/api/v1/attachments/:attachmentId/archive") {
    return {
      resourceType: "task-attachment",
      resourceId: parameter(params, "attachmentId"),
      permission: "write",
    };
  }
  if (route === "/api/v1/runs/:runId/cancel") {
    return {
      resourceType: "run",
      resourceId: parameter(params, "runId"),
      permission: "write",
    };
  }
  if (route === "/api/v1/workflows/import") {
    const projectId = bodyProjectId(body);
    return projectId === undefined
      ? undefined
      : { projectId, permission: "write" };
  }
  if (route === "/api/v1/workflows" && method === "POST") {
    const projectId = bodyProjectId(body);
    return projectId === undefined
      ? undefined
      : { projectId, permission: "write" };
  }
  if (route === "/api/v1/workflows/:workflowId/start") {
    return {
      resourceType: "workflow",
      resourceId: parameter(params, "workflowId"),
      permission: "write",
    };
  }
  if (route.startsWith("/api/v1/workflow-instances/:instanceId/")) {
    return {
      resourceType: "workflow-instance",
      resourceId: parameter(params, "instanceId"),
      permission: route.includes("/approvals") ? "approve" : "write",
    };
  }
  if (route === "/api/v1/meetings" && method === "POST") {
    const projectId = bodyProjectId(body);
    return projectId === undefined
      ? undefined
      : { projectId, permission: "write" };
  }
  if (route.startsWith("/api/v1/meetings/:meetingId/")) {
    return {
      resourceType: "meeting",
      resourceId: parameter(params, "meetingId"),
      permission:
        route.endsWith("/minutes/publish") || route.endsWith("/memory/ingest")
          ? "approve"
          : "write",
    };
  }
  if (
    (route === "/api/v1/workbench/supply-exceptions" ||
      route === "/api/v1/workbench/supplier-risks") &&
    method === "POST"
  ) {
    const projectId = bodyProjectId(body);
    return projectId === undefined
      ? undefined
      : { projectId, permission: "write" };
  }
  if (SELF_WRITE_ROUTES.has(`${method} ${route}`)) return "self";
  return undefined;
}

export class AuthorizationService {
  constructor(private readonly repository: AuthorizationRepository) {}

  async isPlatformAdministrator(principalId: string): Promise<boolean> {
    const decision = await this.repository.authorizePlatform({
      principalId,
      authSource: "bearer",
    });
    return decision.allowed;
  }

  async authorizeProject(input: {
    readonly principal: AuthorizedRequestPrincipal;
    readonly projectId: string;
    readonly permission: ScopedAuthorizationPermission;
    readonly action: string;
    readonly requestId: string;
  }): Promise<ScopeAuthorizationDecision> {
    const decision = await this.repository.authorizeProject({
      principalId: input.principal.principalId,
      authSource: input.principal.authSource,
      projectId: input.projectId,
      permission: input.permission,
    });
    await this.auditDecision(
      input.action,
      input.requestId,
      input.principal,
      decision,
    );
    return decision;
  }

  async authorizeWorkspace(input: {
    readonly principal: AuthorizedRequestPrincipal;
    readonly workspaceId: string;
    readonly permission: ScopedAuthorizationPermission;
    readonly action: string;
    readonly requestId: string;
  }): Promise<ScopeAuthorizationDecision> {
    const decision = await this.repository.authorizeWorkspace({
      principalId: input.principal.principalId,
      authSource: input.principal.authSource,
      workspaceId: input.workspaceId,
      permission: input.permission,
    });
    await this.auditDecision(
      input.action,
      input.requestId,
      input.principal,
      decision,
    );
    return decision;
  }

  async authorizePlatform(input: {
    readonly principal: AuthorizedRequestPrincipal;
    readonly permission?: AuthorizationPermission;
    readonly action: string;
    readonly requestId: string;
  }): Promise<ScopeAuthorizationDecision> {
    const decision = await this.repository.authorizePlatform({
      principalId: input.principal.principalId,
      authSource: input.principal.authSource,
      ...(input.permission === undefined
        ? {}
        : { permission: input.permission }),
    });
    await this.auditDecision(
      input.action,
      input.requestId,
      input.principal,
      decision,
    );
    return decision;
  }

  async authorizeRoute(
    input: RouteAuthorizationInput,
  ): Promise<RouteAuthorizationResult> {
    const method = input.method.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return { required: false };
    }
    const action = actionFor(method, input.route);
    if (input.route === "/api/v1/auth/login") {
      return { required: false };
    }

    const resource = resourceRequirement(
      method,
      input.route,
      input.params,
      input.body,
    );
    if (resource === "self") {
      return { required: false };
    }

    const directProject = directProjectRequirement(input.route, input.params);
    let projectRequirement: ProjectRouteRequirement | undefined =
      directProject ?? resource;
    if (
      projectRequirement !== undefined &&
      projectRequirement.projectId === undefined &&
      projectRequirement.resourceType !== undefined
    ) {
      const resourceId = projectRequirement.resourceId;
      if (resourceId === undefined) {
        return {
          required: true,
          allowed: false,
          reason: "resource_id_required",
        };
      }
      const projectId = await this.repository.projectIdForResource(
        projectRequirement.resourceType,
        resourceId,
      );
      if (projectId === null) {
        return { required: false };
      }
      if (projectId === undefined) {
        const principal = await this.repository.getPrincipal(
          input.principal.principalId,
        );
        const decision: ScopeAuthorizationDecision = {
          allowed: false,
          reason: "project_not_found",
          principal: principal ?? null,
          scopeType: "project",
          scopeId: resourceId,
          permission: projectRequirement.permission,
          grantIds: [],
          effectivePermissions: [],
          grantSource: "none",
        };
        await this.auditDecision(
          action,
          input.requestId,
          input.principal,
          decision,
        );
        return {
          required: true,
          allowed: false,
          decision,
          reason: "project_not_found",
        };
      }
      projectRequirement = { ...projectRequirement, projectId };
    }

    if (
      projectRequirement !== undefined &&
      projectRequirement.projectId !== undefined
    ) {
      const decision = await this.authorizeProject({
        principal: input.principal,
        projectId: projectRequirement.projectId,
        permission: projectRequirement.permission,
        action,
        requestId: input.requestId,
      });
      return {
        required: true,
        allowed: decision.allowed,
        decision,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      };
    }

    const platformRoute = PLATFORM_ADMIN_WRITE_PREFIXES.some((prefix) =>
      input.route.startsWith(prefix),
    );
    if (platformRoute) {
      const decision = await this.authorizePlatform({
        principal: input.principal,
        action,
        requestId: input.requestId,
      });
      return {
        required: true,
        allowed: decision.allowed,
        decision,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      };
    }

    const platformAccessRoute =
      (input.route === "/api/v1/projects" && method === "POST") ||
      PLATFORM_ACCESS_WRITE_PREFIXES.some((prefix) =>
        input.route.startsWith(prefix),
      );
    if (platformAccessRoute) {
      const decision = await this.authorizePlatform({
        principal: input.principal,
        permission: "platform.access",
        action,
        requestId: input.requestId,
      });
      return {
        required: true,
        allowed: decision.allowed,
        decision,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      };
    }

    const decision = await this.authorizePlatform({
      principal: input.principal,
      action,
      requestId: input.requestId,
    });
    return {
      required: true,
      allowed: decision.allowed,
      decision,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  }

  private async auditDecision(
    action: string,
    requestId: string,
    principal: AuthorizedRequestPrincipal,
    decision: ScopeAuthorizationDecision,
  ): Promise<void> {
    await this.repository.audit({
      action,
      decision: decision.allowed ? "allowed" : "denied",
      actorPrincipalId: principal.principalId,
      subjectPrincipalId: decision.principal?.id ?? principal.principalId,
      ...(principal.accountId === undefined
        ? {}
        : { accountId: principal.accountId }),
      ...(principal.sessionId === undefined
        ? {}
        : { sessionId: principal.sessionId }),
      ...(decision.grantIds.length === 0
        ? {}
        : { grantId: decision.grantIds[0] }),
      reason: decision.reason ?? "",
      metadata: {
        requestId,
        scopeType: decision.scopeType,
        scopeId: decision.scopeId,
        permission: decision.permission,
        effectivePermissions: decision.effectivePermissions,
        grantIds: decision.grantIds,
        grantSource: decision.grantSource,
        ownerSources: decision.ownerSources,
        membershipId: decision.membershipId,
        membershipStatus: decision.membershipStatus,
      },
    });
  }
}
