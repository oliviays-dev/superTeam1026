import { createHash, randomUUID } from "node:crypto";
import {
  type ApiError,
  agentRuntimePreflightInputSchema,
  agentStatusInputSchema,
  accountStatusInputSchema,
  cancelExecutionGateInputSchema,
  approvalSlaSweepInputSchema,
  archiveTaskAttachmentInputSchema,
  blockTaskInputSchema,
  claimTaskInputSchema,
  confirmHandoffCardInputSchema,
  createDirectChatInputSchema,
  createExternalRuntimeInputSchema,
  createAgentInputSchema,
  createAgentEpisodeInputSchema,
  createHandoffCardInputSchema,
  createMeetingActionItemInputSchema,
  createMemoryClaimInputSchema,
  createMemoryTopicInputSchema,
  createMeetingInputSchema,
  createProjectMemberInputSchema,
  createProjectInputSchema,
  createProjectRoleInputSchema,
  createSceneContextContributionInputSchema,
  createProjectTemplateInputSchema,
  createTemplateRoleInputSchema,
  createWorkflowTemplateInputSchema,
  copyProjectTemplateInputSchema,
  archiveProjectTemplateInputSchema,
  createSupplyExceptionInputSchema,
  createSupplierRiskInputSchema,
  createTaskMessageInputSchema,
  createTaskInputSchema,
  createWorkflowInputSchema,
  changePasswordInputSchema,
  completeWorkflowNodeInputSchema,
  convertMeetingActionItemInputSchema,
  cosignWorkflowApprovalInputSchema,
  decideWorkflowApprovalInputSchema,
  decideExecutionGateInputSchema,
  executionHistoryQuerySchema,
  generateProjectReportInputSchema,
  importWorkflowMarkdownInputSchema,
  idempotencyCleanupInputSchema,
  jobListQuerySchema,
  jobRecoveryInputSchema,
  markReportReadInputSchema,
  meetingAiPolicyLifecycleInputSchema,
  loginInputSchema,
  projectReportQuerySchema,
  publishMemoryTruthInputSchema,
  publishMeetingMinutesInputSchema,
  pauseTaskInputSchema,
  provideTaskInputSchema,
  refreshWorkbenchBriefInputSchema,
  removeAgentRuntimeBindingInputSchema,
  reviewMemoryClaimsInputSchema,
  requestTaskInputSchema,
  resetTaskSessionInputSchema,
  resumeTaskInputSchema,
  releaseTaskClaimInputSchema,
  setWorkbenchFollowInputSchema,
  sendDirectChatMessageInputSchema,
  taskReviewInputSchema,
  traceIdSchema,
  triggerMeetingAiInputSchema,
  transferTaskInputSchema,
  retryWorkflowNodeInputSchema,
  runtimeRevisionInputSchema,
  setAgentRuntimeBindingInputSchema,
  startWorkflowInputSchema,
  submitTaskInputSchema,
  uploadTaskAttachmentInputSchema,
  updateAgentInputSchema,
  updateExternalRuntimeInputSchema,
  updateHandoffCardInputSchema,
  updateMeetingActionItemInputSchema,
  updateMeetingAiPolicyInputSchema,
  updateMeetingMinutesDraftInputSchema,
  updateMemoryClaimInputSchema,
  updateProjectMemberInputSchema,
  updateProjectInputSchema,
  updateProjectRoleInputSchema,
  updateProjectTemplateInputSchema,
  updateTemplateRoleInputSchema,
  updateWorkflowTemplateInputSchema,
  updateTaskInputSchema,
  updateTaskExecutionPolicyInputSchema,
  type TaskExecutionPolicyContextType,
  updateWorkbenchBriefSettingsInputSchema,
  transferWorkflowApprovalInputSchema,
  validateWorkflowMarkdownInputSchema,
  workflowAuditQuerySchema,
  workflowReasonInputSchema,
  workspaceRuntimeEconomicsQuerySchema,
  createRootTraceContext,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
} from "@pluginmax/contracts";
import {
  ApplicationError,
  AuthorizationService,
  PlatformApplication,
  renderRuntimePrometheusMetrics,
  type AuthorizedRequestPrincipal,
} from "@pluginmax/application";
import {
  Database,
  IdentityRepository,
  IdentityRepositoryError,
  PlatformRepositories,
} from "@pluginmax/database";
import { LocalFileStore, type FileRef } from "@pluginmax/files";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { ZodError, z } from "zod";

export interface BuildApiOptions {
  readonly databaseUrl: string;
  readonly fileStoreRoot: string;
  readonly localActorId?: string;
  readonly authMode?: "bearer" | "local-development";
  readonly authSessionTtlSeconds?: number;
  readonly identityRepository?: IdentityRepository;
  readonly expectedMigrationVersion?: number;
  readonly workerHeartbeatStaleAfterSeconds?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly database?: Database;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const runParamsSchema = z.object({ runId: z.string().uuid() });
const executionGateParamsSchema = z.object({ gateId: z.string().uuid() });
const traceParamsSchema = z.object({ traceId: traceIdSchema });
const artifactParamsSchema = z.object({ artifactId: z.string().uuid() });
const taskAttachmentParamsSchema = z.object({
  attachmentId: z.string().uuid(),
});
const jobParamsSchema = z.object({ jobId: z.string().uuid() });
const workflowParamsSchema = z.object({ workflowId: z.string().uuid() });
const workflowInstanceParamsSchema = z.object({
  instanceId: z.string().uuid(),
});
const meetingParamsSchema = z.object({ meetingId: z.string().uuid() });
const directChatParamsSchema = z.object({ threadId: z.string().uuid() });
const runtimeParamsSchema = z.object({ runtimeId: z.string().uuid() });
const workspaceParamsSchema = z.object({
  workspaceId: z.string().trim().min(1).max(180),
});
const agentParamsSchema = z.object({ agentId: z.string().uuid() });
const directChatTurnParamsSchema = directChatParamsSchema.extend({
  turnId: z.string().uuid(),
});
const meetingActionItemParamsSchema = meetingParamsSchema.extend({
  actionItemId: z.string().uuid(),
});
const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const projectReportParamsSchema = projectParamsSchema.extend({
  reportId: z.string().uuid(),
});
const workbenchBriefParamsSchema = z.object({
  briefId: z.string().uuid(),
});
const projectMemberParamsSchema = z.object({
  projectId: z.string().uuid(),
  memberId: z.string().uuid(),
});
const projectRoleParamsSchema = z.object({
  projectId: z.string().uuid(),
  roleId: z.string().uuid(),
});
const projectTemplateParamsSchema = z.object({
  templateId: z.string().uuid(),
});
const templateRoleParamsSchema = z.object({
  roleId: z.string().uuid(),
});
const workflowTemplateParamsSchema = z.object({
  workflowTemplateId: z.string().uuid(),
});
const templateListQuerySchema = z.object({
  includeArchived: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});
const memoryTopicParamsSchema = z.object({
  projectId: z.string().uuid(),
  topicId: z.string().uuid(),
});
const memoryClaimParamsSchema = memoryTopicParamsSchema.extend({
  claimId: z.string().uuid(),
});
const projectClaimParamsSchema = projectParamsSchema.extend({
  claimId: z.string().uuid(),
});
const projectHandoffParamsSchema = projectParamsSchema.extend({
  handoffId: z.string().uuid(),
});
const episodeQuerySchema = z.object({
  agentId: z.string().uuid(),
});
const meetingMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  mentions: z
    .array(z.string().uuid())
    .max(20)
    .default([])
    .transform((ids) => [...new Set(ids)]),
});
const meetingCloseInputSchema = z.object({
  summary: z.string().trim().max(20_000).default(""),
});
const listTasksQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});
const taskDocumentsQuerySchema = z.object({
  includeArchived: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});
const listAgentsQuerySchema = z.object({
  includeDisabled: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});
const listRuntimesQuerySchema = z.object({
  includeArchived: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
});
const eventQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  afterDeltaSeq: z.coerce.number().int().nonnegative().default(0),
});

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiError(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): ApiError {
  return {
    requestId,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

const AUTHENTICATED_ACTOR_HEADER = "x-pluginmax-authenticated-actor";
const AUTHENTICATED_NAME_HEADER = "x-pluginmax-authenticated-name";
const AUTHENTICATED_ADMIN_HEADER = "x-pluginmax-authenticated-admin";

interface RequestPrincipalContext extends AuthorizedRequestPrincipal {
  readonly loginId: string;
  readonly platformAdministrator: boolean;
  readonly expiresAt: string | null;
}

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

function requestBearerToken(
  headers: Record<string, unknown>,
): string | undefined {
  const authorization = headerValue(headers, "authorization");
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

function requestActorId(headers: Record<string, unknown>): string {
  const actor = headerValue(headers, AUTHENTICATED_ACTOR_HEADER);
  if (actor === undefined || !/^[a-zA-Z0-9_.:-]{1,180}$/.test(actor)) {
    throw new ApplicationError(
      "unauthorized",
      "Authentication is required",
      401,
    );
  }
  return actor;
}

function requestActorName(
  headers: Record<string, unknown>,
  actorId: string,
): string {
  return headerValue(headers, AUTHENTICATED_NAME_HEADER) ?? actorId;
}

function requestIsAdministrator(headers: Record<string, unknown>): boolean {
  return headerValue(headers, AUTHENTICATED_ADMIN_HEADER) === "1";
}

function publicApiPath(path: string): boolean {
  return (
    path === "/api/v1/health" ||
    path === "/api/v1/ready" ||
    path === "/api/v1/metrics" ||
    path === "/api/v1/auth/login"
  );
}

function requestIdempotencyKey(
  headers: Record<string, unknown>,
): string | undefined {
  const value = headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  return typeof key === "string" && key.trim() !== ""
    ? key.trim().slice(0, 200)
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function buildApi(options: BuildApiOptions): {
  app: FastifyInstance;
  database: Database;
} {
  const database = options.database ?? new Database(options.databaseUrl);
  const fileStore = new LocalFileStore(options.fileStoreRoot);
  const repositories = new PlatformRepositories(database);
  const application = new PlatformApplication(repositories, fileStore);
  const authorization = new AuthorizationService(repositories.authorization);
  const localActorId = options.localActorId ?? "local-admin";
  const authMode =
    options.authMode ??
    (process.env.NODE_ENV === "test" ? "local-development" : "bearer");
  const authSessionTtlSeconds = options.authSessionTtlSeconds ?? 604_800;
  const identity =
    options.identityRepository ?? new IdentityRepository(database);
  const expectedMigrationVersion = options.expectedMigrationVersion ?? 29;
  const workerHeartbeatStaleAfterSeconds =
    options.workerHeartbeatStaleAfterSeconds ?? 30;
  const startedAt = Date.now();
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024 * 1024,
  });
  const requestTraces = new WeakMap<FastifyRequest, TraceContext>();
  const requestPrincipals = new WeakMap<
    FastifyRequest,
    RequestPrincipalContext
  >();

  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.traceparent;
    const incoming = Array.isArray(header) ? header[0] : header;
    const parsed = parseTraceparent(incoming);
    const trace = parsed ?? createRootTraceContext();
    requestTraces.set(request, trace);
    reply.header("traceparent", formatTraceparent(trace));
    reply.header("x-pluginmax-trace-id", trace.traceId);
    if (incoming !== undefined && parsed === undefined) {
      reply.header("x-pluginmax-trace-invalid", "1");
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    delete request.headers[AUTHENTICATED_ACTOR_HEADER];
    delete request.headers[AUTHENTICATED_NAME_HEADER];
    delete request.headers[AUTHENTICATED_ADMIN_HEADER];
    if (publicApiPath(request.url.split("?")[0] ?? request.url)) {
      return;
    }
    if (authMode === "local-development") {
      const candidate = headerValue(request.headers, "x-pluginmax-actor");
      const actorId = candidate ?? localActorId;
      if (!/^[a-zA-Z0-9_.:-]{1,180}$/.test(actorId)) {
        return reply
          .status(401)
          .send(
            apiError(
              String(request.id),
              "unauthorized",
              "Authentication is required",
            ),
          );
      }
      await repositories.authorization.ensureDevelopmentPrincipal(
        actorId,
        actorId === localActorId,
      );
      request.headers[AUTHENTICATED_ACTOR_HEADER] = actorId;
      request.headers[AUTHENTICATED_NAME_HEADER] =
        actorId === localActorId ? "Local Admin" : actorId;
      request.headers[AUTHENTICATED_ADMIN_HEADER] =
        actorId === localActorId ? "1" : "0";
      requestPrincipals.set(request, {
        principalId: actorId,
        displayName: actorId === localActorId ? "Local Admin" : actorId,
        kind: "human",
        authSource: "local-development",
        loginId: actorId,
        platformAdministrator: actorId === localActorId,
        expiresAt: null,
      });
      return;
    }
    const token = requestBearerToken(request.headers);
    if (token === undefined) {
      return reply
        .status(401)
        .send(
          apiError(
            String(request.id),
            "unauthorized",
            "Authentication is required",
          ),
        );
    }
    const principal = await identity.resolveSession(token);
    if (principal === undefined) {
      return reply
        .status(401)
        .send(
          apiError(
            String(request.id),
            "unauthorized",
            "Authentication is required",
          ),
        );
    }
    request.headers[AUTHENTICATED_ACTOR_HEADER] = principal.principalId;
    request.headers[AUTHENTICATED_NAME_HEADER] = principal.displayName;
    request.headers[AUTHENTICATED_ADMIN_HEADER] =
      principal.platformAdministrator ? "1" : "0";
    requestPrincipals.set(request, {
      ...principal,
      authSource: "bearer",
    });
  });
  app.addHook("preHandler", async (request, reply) => {
    const principal = requestPrincipals.get(request);
    if (principal === undefined) return;
    const route =
      request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
    const result = await authorization.authorizeRoute({
      requestId: String(request.id),
      method: request.method,
      route,
      principal,
      params: (request.params ?? {}) as Record<string, unknown>,
      query: (request.query ?? {}) as Record<string, unknown>,
      body: request.body,
    });
    if (!result.required || result.allowed) return;
    const reason = result.reason ?? "authorization_denied";
    request.log.info(
      {
        requestId: String(request.id),
        principalId: principal.principalId,
        route,
        reason,
      },
      "authorization.denied",
    );
    if (reason === "project_archived") {
      return reply
        .status(409)
        .send(
          apiError(
            String(request.id),
            "project_archived",
            "Archived projects cannot be modified",
            { reason, projectId: result.decision?.scopeId },
          ),
        );
    }
    if (reason === "project_not_found") {
      return reply
        .status(404)
        .send(
          apiError(
            String(request.id),
            "project_not_found",
            "Project not found",
            { reason },
          ),
        );
    }
    return reply.status(403).send(
      apiError(
        String(request.id),
        "forbidden",
        "The authenticated Principal is not authorized for this operation",
        {
          reason,
          permission: result.decision?.permission,
          scopeType: result.decision?.scopeType,
          scopeId: result.decision?.scopeId,
        },
      ),
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: String(request.id),
        traceId: requestTraces.get(request)?.traceId,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      "request.completed",
    );
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  async function idempotentRoute<T>(input: {
    readonly request: FastifyRequest;
    readonly reply: FastifyReply;
    readonly scope: string;
    readonly operation: string;
    readonly actorId: string;
    readonly payload: unknown;
    readonly statusCode: number;
    readonly execute: () => Promise<T>;
  }): Promise<FastifyReply> {
    const key = requestIdempotencyKey(input.request.headers);
    if (key === undefined) {
      return input.reply.status(input.statusCode).send(await input.execute());
    }
    const hash = requestHash({
      operation: input.operation,
      actorId: input.actorId,
      payload: input.payload,
    });
    const begun = await repositories.workflowIdempotency.begin({
      scope: input.scope,
      operation: input.operation,
      idempotencyKey: key,
      requestHash: hash,
    });
    if (begun.kind === "replay") {
      return input.reply.status(begun.statusCode).send(begun.body);
    }
    if (begun.kind === "conflict") {
      return input.reply
        .status(409)
        .send(
          apiError(
            String(input.request.id),
            "idempotency_key_conflict",
            "The idempotency key was already used with a different request",
          ),
        );
    }
    if (begun.kind === "in_progress") {
      return input.reply
        .status(409)
        .send(
          apiError(
            String(input.request.id),
            "idempotency_request_in_progress",
            "An identical idempotent request is still in progress",
          ),
        );
    }
    try {
      const result = await input.execute();
      await repositories.workflowIdempotency.complete({
        scope: input.scope,
        idempotencyKey: key,
        requestHash: hash,
        statusCode: input.statusCode,
        body: result,
      });
      return input.reply.status(input.statusCode).send(result);
    } catch (error) {
      if (error instanceof ApplicationError) {
        const body = apiError(
          String(input.request.id),
          error.code,
          error.message,
          error.details,
        );
        await repositories.workflowIdempotency.complete({
          scope: input.scope,
          idempotencyKey: key,
          requestHash: hash,
          statusCode: error.statusCode,
          body,
        });
        return input.reply.status(error.statusCode).send(body);
      }
      await repositories.workflowIdempotency.fail({
        scope: input.scope,
        idempotencyKey: key,
        requestHash: hash,
      });
      throw error;
    }
  }

  function assertAdministrator(headers: Record<string, unknown>): void {
    if (!requestIsAdministrator(headers)) {
      throw new ApplicationError(
        "forbidden",
        "Platform administrator permission is required",
        403,
      );
    }
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send(apiError(String(request.id), "invalid_input", error.message));
    }
    if (error instanceof IdentityRepositoryError) {
      return reply
        .status(error.statusCode)
        .send(apiError(String(request.id), error.code, error.message));
    }
    if (error instanceof ApplicationError) {
      return reply
        .status(error.statusCode)
        .send(
          apiError(
            String(request.id),
            error.code,
            error.message,
            error.details,
          ),
        );
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(
          apiError(
            String(request.id),
            "invalid_request",
            error instanceof Error ? error.message : "Invalid request",
          ),
        );
    }
    request.log.error(
      {
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "request failed",
    );
    return reply
      .status(500)
      .send(apiError(String(request.id), "internal_error", "Internal error"));
  });

  function registerExecutionPolicyRoutes(input: {
    readonly path: string;
    readonly contextType: TaskExecutionPolicyContextType;
    readonly contextId: (params: unknown) => string;
  }): void {
    app.get(input.path, async (request, reply) => {
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.getTaskExecutionPolicy(
          input.contextType,
          input.contextId(request.params),
          actorId,
        ),
      );
    });
    app.put(input.path, async (request, reply) => {
      const actorId = requestActorId(request.headers);
      const body = updateTaskExecutionPolicyInputSchema.parse(request.body);
      return reply.send(
        await application.updateTaskExecutionPolicy(
          input.contextType,
          input.contextId(request.params),
          body,
          actorId,
        ),
      );
    });
  }

  registerExecutionPolicyRoutes({
    path: "/api/v1/projects/:projectId/execution-policy",
    contextType: "project",
    contextId: (params) => projectParamsSchema.parse(params).projectId,
  });
  registerExecutionPolicyRoutes({
    path: "/api/v1/tasks/:id/execution-policy",
    contextType: "task",
    contextId: (params) => idParamsSchema.parse(params).id,
  });
  registerExecutionPolicyRoutes({
    path: "/api/v1/meetings/:meetingId/execution-policy",
    contextType: "meeting",
    contextId: (params) => meetingParamsSchema.parse(params).meetingId,
  });
  registerExecutionPolicyRoutes({
    path: "/api/v1/direct-chats/:threadId/execution-policy",
    contextType: "direct-chat",
    contextId: (params) => directChatParamsSchema.parse(params).threadId,
  });

  app.get("/api/v1/health", async (_request, reply) => {
    return reply.send({
      ok: true,
      service: "pluginmax-api",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const input = loginInputSchema.parse(request.body);
    return reply.send(
      await identity.login({
        ...input,
        ttlSeconds: authSessionTtlSeconds,
      }),
    );
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const principal = requestPrincipals.get(request);
    if (principal !== undefined) {
      return reply.send({
        principalId: principal.principalId,
        accountId: principal.accountId ?? null,
        sessionId: principal.sessionId ?? null,
        loginId: principal.loginId,
        displayName: principal.displayName,
        kind: principal.kind,
        platformAdministrator: principal.platformAdministrator,
        expiresAt: principal.expiresAt,
        authSource: principal.authSource,
      });
    }
    const actorId = requestActorId(request.headers);
    return reply.send({
      principalId: `local:${actorId}`,
      accountId: null,
      sessionId: null,
      loginId: actorId,
      displayName: requestActorName(request.headers, actorId),
      kind: "human",
      platformAdministrator: requestIsAdministrator(request.headers),
      expiresAt: null,
      authSource: "local-development",
    });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (authMode === "bearer") {
      const token = requestBearerToken(request.headers);
      if (token === undefined) {
        throw new ApplicationError(
          "unauthorized",
          "Authentication is required",
          401,
        );
      }
      await identity.logout(token);
    }
    return reply.status(204).send();
  });

  app.post("/api/v1/auth/change-password", async (request, reply) => {
    if (authMode !== "bearer") {
      throw new ApplicationError(
        "authentication_mode_unsupported",
        "Password changes require bearer authentication",
        400,
      );
    }
    const token = requestBearerToken(request.headers);
    if (token === undefined) {
      throw new ApplicationError(
        "unauthorized",
        "Authentication is required",
        401,
      );
    }
    const input = changePasswordInputSchema.parse(request.body);
    await identity.changePassword(token, input);
    return reply.status(204).send();
  });

  app.get("/api/v1/viewer", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const platformAdministrator = requestIsAdministrator(request.headers);
    return reply.send({
      actorId,
      principalId: actorId,
      displayName: requestActorName(request.headers, actorId),
      authSource: authMode,
      platformAdministrator,
      canManageProjectTemplates: platformAdministrator,
    });
  });

  app.post("/api/v1/accounts/:accountId/status", async (request, reply) => {
    assertAdministrator(request.headers);
    const { accountId } = z
      .object({
        accountId: z.string().trim().min(1).max(180),
      })
      .parse(request.params);
    const input = accountStatusInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await identity.setAccountStatus(actorId, accountId, input),
    );
  });

  app.get("/api/v1/ready", async (_request, reply) => {
    let databaseReady = false;
    let databaseDetail = "database reachable";
    let metrics:
      | Awaited<ReturnType<typeof repositories.runtimeReliability.getMetrics>>
      | undefined;
    try {
      await database.ping();
      databaseReady = true;
      metrics = await repositories.runtimeReliability.getMetrics({
        expectedMigrationVersion,
        workerHeartbeatStaleAfterSeconds,
      });
    } catch (error) {
      databaseDetail = error instanceof Error ? error.message : String(error);
    }
    const migrationReady =
      metrics !== undefined &&
      metrics.migrationVersion >= expectedMigrationVersion;
    const workerReady = (metrics?.activeWorkers ?? 0) > 0;
    const ready = databaseReady && migrationReady && workerReady;
    return reply.status(ready ? 200 : 503).send({
      ok: ready,
      status: ready ? "ready" : "not_ready",
      checks: {
        database: {
          ok: databaseReady,
          status: databaseReady ? "up" : "down",
          detail: databaseDetail,
        },
        worker: {
          ok: workerReady,
          status: workerReady ? "online" : "unavailable",
          ...(metrics === undefined
            ? {}
            : {
                detail: `${metrics.activeWorkers} active worker(s), heartbeat TTL ${workerHeartbeatStaleAfterSeconds}s`,
              }),
        },
        migration: {
          ok: migrationReady,
          status: migrationReady ? "current" : "behind",
          ...(metrics === undefined
            ? {}
            : {
                detail: `database version ${metrics.migrationVersion}, expected ${expectedMigrationVersion}`,
              }),
        },
      },
    });
  });

  app.get("/api/v1/operations", async (_request, reply) => {
    return reply.send(
      await application.getOperationsSnapshot({
        expectedMigrationVersion,
        workerHeartbeatStaleAfterSeconds,
      }),
    );
  });

  app.get("/api/v1/metrics", async (_request, reply) => {
    const snapshot = await application.getOperationsSnapshot({
      expectedMigrationVersion,
      workerHeartbeatStaleAfterSeconds,
    });
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(renderRuntimePrometheusMetrics(snapshot));
  });

  app.get("/api/v1/jobs", async (request, reply) => {
    const query = jobListQuerySchema.parse(request.query);
    return reply.send({ items: await application.listJobs(query) });
  });

  app.post("/api/v1/jobs/:jobId/recover", async (request, reply) => {
    const { jobId } = jobParamsSchema.parse(request.params);
    const input = jobRecoveryInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    assertAdministrator(request.headers);
    return reply.send(
      await application.recoverDeadLetterJob(jobId, input.reason, actorId),
    );
  });

  app.post("/api/v1/operations/approval-sla/sweep", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    assertAdministrator(request.headers);
    const input = approvalSlaSweepInputSchema.parse(request.body ?? {});
    return reply.send(
      await application.sweepApprovalSla(actorId, input.batchSize, {
        triggerSource: "api",
        trace: requestTraces.get(request) ?? createRootTraceContext(),
      }),
    );
  });

  app.post("/api/v1/operations/idempotency/cleanup", async (request, reply) => {
    assertAdministrator(request.headers);
    const input = idempotencyCleanupInputSchema.parse(request.body ?? {});
    return reply.send(
      await application.cleanupIdempotencyReceipts(input, {
        triggerSource: "api",
        trace: requestTraces.get(request) ?? createRootTraceContext(),
      }),
    );
  });

  app.get("/api/v1/projects", async (request, reply) => {
    const principal = requestPrincipals.get(request);
    if (principal === undefined) {
      throw new ApplicationError(
        "unauthorized",
        "Authentication is required",
        401,
      );
    }
    const readableProjectIds =
      await repositories.authorization.listReadableProjectIds({
        principalId: principal.principalId,
        authSource: principal.authSource,
      });
    return reply.send({
      items: await application.listProjects(readableProjectIds),
    });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const input = createProjectInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    const administrator = requestIsAdministrator(request.headers);
    const actorName = requestActorName(request.headers, actorId);
    if (input.templateId !== undefined) {
      const idempotencyKey =
        requestIdempotencyKey(request.headers) ?? input.materializationKey;
      if (idempotencyKey === undefined) {
        throw new ApplicationError(
          "materialization_key_required",
          "Idempotency-Key or materializationKey is required when creating a project from a template",
          400,
        );
      }
      return reply.status(201).send(
        await application.createProjectFromTemplate({
          project: input,
          actorId,
          actorName,
          administrator,
          idempotencyKey,
          requestHash: requestHash({
            operation: "project.template.materialize",
            actorId,
            payload: input,
          }),
        }),
      );
    }
    return reply
      .status(201)
      .send(await application.createProject(input, actorId, actorName));
  });

  app.get("/api/v1/project-templates", async (request, reply) => {
    const query = templateListQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    const administrator = requestIsAdministrator(request.headers);
    return reply.send({
      items: await application.listProjectTemplates(
        actorId,
        administrator,
        administrator && (query.includeArchived ?? false),
      ),
    });
  });

  app.post("/api/v1/project-templates", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    assertAdministrator(request.headers);
    const input = createProjectTemplateInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.createProjectTemplate(input, actorId));
  });

  app.get("/api/v1/project-templates/:templateId", async (request, reply) => {
    const { templateId } = projectTemplateParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.getProjectTemplate(
        templateId,
        actorId,
        requestIsAdministrator(request.headers),
      ),
    );
  });

  app.patch("/api/v1/project-templates/:templateId", async (request, reply) => {
    const { templateId } = projectTemplateParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    assertAdministrator(request.headers);
    const input = updateProjectTemplateInputSchema.parse(request.body);
    return reply.send(
      await application.updateProjectTemplate(templateId, input, actorId),
    );
  });

  app.post(
    "/api/v1/project-templates/:templateId/copy",
    async (request, reply) => {
      const { templateId } = projectTemplateParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      assertAdministrator(request.headers);
      const input = copyProjectTemplateInputSchema.parse(request.body);
      return reply
        .status(201)
        .send(
          await application.copyProjectTemplate(templateId, input, actorId),
        );
    },
  );

  app.post(
    "/api/v1/project-templates/:templateId/archive",
    async (request, reply) => {
      const { templateId } = projectTemplateParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      assertAdministrator(request.headers);
      const input = archiveProjectTemplateInputSchema.parse(request.body);
      return reply.send(
        await application.archiveProjectTemplate(templateId, input, actorId),
      );
    },
  );

  app.get(
    "/api/v1/project-templates/:templateId/history",
    async (request, reply) => {
      const { templateId } = projectTemplateParamsSchema.parse(request.params);
      assertAdministrator(request.headers);
      return reply.send({
        items: await application.listProjectTemplateHistory(templateId),
      });
    },
  );

  app.get("/api/v1/template-roles", async (request, reply) => {
    const query = templateListQuerySchema.parse(request.query);
    assertAdministrator(request.headers);
    return reply.send({
      items: await application.listTemplateRoles(
        query.includeArchived ?? false,
      ),
    });
  });

  app.post("/api/v1/template-roles", async (request, reply) => {
    assertAdministrator(request.headers);
    const input = createTemplateRoleInputSchema.parse(request.body);
    return reply.status(201).send(await application.createTemplateRole(input));
  });

  app.patch("/api/v1/template-roles/:roleId", async (request, reply) => {
    const { roleId } = templateRoleParamsSchema.parse(request.params);
    assertAdministrator(request.headers);
    const input = updateTemplateRoleInputSchema.parse(request.body);
    return reply.send(await application.updateTemplateRole(roleId, input));
  });

  app.delete("/api/v1/template-roles/:roleId", async (request, reply) => {
    const { roleId } = templateRoleParamsSchema.parse(request.params);
    assertAdministrator(request.headers);
    await application.deleteTemplateRole(roleId);
    return reply.status(204).send();
  });

  app.get("/api/v1/workflow-templates", async (request, reply) => {
    const query = templateListQuerySchema.parse(request.query);
    assertAdministrator(request.headers);
    return reply.send({
      items: await application.listWorkflowTemplates(
        query.includeArchived ?? false,
      ),
    });
  });

  app.post("/api/v1/workflow-templates", async (request, reply) => {
    assertAdministrator(request.headers);
    const input = createWorkflowTemplateInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.createWorkflowTemplate(input));
  });

  app.patch(
    "/api/v1/workflow-templates/:workflowTemplateId",
    async (request, reply) => {
      const { workflowTemplateId } = workflowTemplateParamsSchema.parse(
        request.params,
      );
      assertAdministrator(request.headers);
      const input = updateWorkflowTemplateInputSchema.parse(request.body);
      return reply.send(
        await application.updateWorkflowTemplate(workflowTemplateId, input),
      );
    },
  );

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    return reply.send(await application.getProject(projectId));
  });

  app.get("/api/v1/projects/:projectId/capability", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const principal = requestPrincipals.get(request);
    if (principal === undefined) {
      throw new ApplicationError(
        "unauthorized",
        "Authentication is required",
        401,
      );
    }
    const decision = await repositories.authorization.getProjectCapability({
      principalId: principal.principalId,
      authSource: principal.authSource,
      projectId,
    });
    if (!decision.allowed || decision.capability === undefined) {
      throw new ApplicationError(
        "forbidden",
        "The authenticated Principal is not authorized for this operation",
        403,
        { reason: decision.reason ?? "permission_missing", projectId },
      );
    }
    return reply.send(decision.capability);
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = updateProjectInputSchema.parse(request.body);
    return reply.send(await application.updateProject(projectId, input));
  });

  app.get("/api/v1/projects/:projectId/reports", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const query = projectReportQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listProjectReports(projectId, query, actorId),
    });
  });

  app.post(
    "/api/v1/projects/:projectId/reports/generate",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = generateProjectReportInputSchema.parse(request.body ?? {});
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `project:${projectId}:reports`,
        operation: "project.report.generate",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.generateProjectReport(
            projectId,
            input.reportDate,
            actorId,
          ),
      });
    },
  );

  app.get(
    "/api/v1/projects/:projectId/reports/:reportId",
    async (request, reply) => {
      const { projectId, reportId } = projectReportParamsSchema.parse(
        request.params,
      );
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.getProjectReport(projectId, reportId, actorId),
      );
    },
  );

  app.post(
    "/api/v1/projects/:projectId/reports/:reportId/read",
    async (request, reply) => {
      const { projectId, reportId } = projectReportParamsSchema.parse(
        request.params,
      );
      const input = markReportReadInputSchema.parse(request.body ?? {});
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.markProjectReportRead(
          projectId,
          reportId,
          actorId,
          input.read,
        ),
      );
    },
  );

  app.get("/api/v1/projects/:projectId/roles", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    return reply.send({
      items: await application.listProjectRoles(projectId),
    });
  });

  app.post("/api/v1/projects/:projectId/roles", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = createProjectRoleInputSchema.parse(request.body);
    const actorPrincipalId =
      requestPrincipals.get(request)?.principalId ??
      requestActorId(request.headers);
    return reply
      .status(201)
      .send(
        await application.createProjectRole(projectId, input, actorPrincipalId),
      );
  });

  app.patch(
    "/api/v1/projects/:projectId/roles/:roleId",
    async (request, reply) => {
      const { projectId, roleId } = projectRoleParamsSchema.parse(
        request.params,
      );
      const input = updateProjectRoleInputSchema.parse(request.body);
      const actorPrincipalId =
        requestPrincipals.get(request)?.principalId ??
        requestActorId(request.headers);
      return reply.send(
        await application.updateProjectRole(
          projectId,
          roleId,
          input,
          actorPrincipalId,
        ),
      );
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/roles/:roleId",
    async (request, reply) => {
      const { projectId, roleId } = projectRoleParamsSchema.parse(
        request.params,
      );
      await application.deleteProjectRole(projectId, roleId);
      return reply.status(204).send();
    },
  );

  app.get("/api/v1/projects/:projectId/members", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    return reply.send({
      items: await application.listProjectMembers(projectId),
    });
  });

  app.get(
    "/api/v1/projects/:projectId/authorization-report",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const report =
        await repositories.authorization.getProjectAuthorizationReport(
          projectId,
        );
      if (report === undefined) {
        throw new ApplicationError(
          "project_not_found",
          "Project not found",
          404,
        );
      }
      return reply.send(report);
    },
  );

  app.post("/api/v1/projects/:projectId/members", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = createProjectMemberInputSchema.parse(request.body);
    const actorPrincipalId =
      requestPrincipals.get(request)?.principalId ??
      requestActorId(request.headers);
    return reply
      .status(201)
      .send(
        await application.createProjectMember(
          projectId,
          input,
          actorPrincipalId,
        ),
      );
  });

  app.patch(
    "/api/v1/projects/:projectId/members/:memberId",
    async (request, reply) => {
      const { projectId, memberId } = projectMemberParamsSchema.parse(
        request.params,
      );
      const input = updateProjectMemberInputSchema.parse(request.body);
      const actorPrincipalId =
        requestPrincipals.get(request)?.principalId ??
        requestActorId(request.headers);
      return reply.send(
        await application.updateProjectMember(
          projectId,
          memberId,
          input,
          actorPrincipalId,
        ),
      );
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/members/:memberId",
    async (request, reply) => {
      const { projectId, memberId } = projectMemberParamsSchema.parse(
        request.params,
      );
      const actorPrincipalId =
        requestPrincipals.get(request)?.principalId ??
        requestActorId(request.headers);
      await application.deleteProjectMember(
        projectId,
        memberId,
        actorPrincipalId,
      );
      return reply.status(204).send();
    },
  );

  app.get("/api/v1/agents", async (request, reply) => {
    const { includeDisabled } = listAgentsQuerySchema.parse(request.query);
    return reply.send({
      items: includeDisabled
        ? await application.listAllAgents()
        : await application.listAgents(),
    });
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const input = createAgentInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply
      .status(201)
      .send(await application.createAgent(input, actorId));
  });

  app.get("/api/v1/agents/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send(await application.getAgent(id));
  });

  app.patch("/api/v1/agents/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateAgentInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.updateAgent(id, input, actorId));
  });

  app.post("/api/v1/agents/:id/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { status } = agentStatusInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.setAgentStatus(id, status, actorId));
  });

  app.get("/api/v1/agents/:agentId/runtime-binding", async (request, reply) => {
    const { agentId } = agentParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.getAgentRuntimeBinding(
        agentId,
        actorId,
        requestIsAdministrator(request.headers),
      ),
    );
  });

  app.put("/api/v1/agents/:agentId/runtime-binding", async (request, reply) => {
    const { agentId } = agentParamsSchema.parse(request.params);
    const input = setAgentRuntimeBindingInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `agent-runtime-binding:${agentId}`,
      operation: "runtime.binding.set",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () =>
        application.setAgentRuntimeBinding(
          agentId,
          input,
          actorId,
          requestIsAdministrator(request.headers),
        ),
    });
  });

  app.delete(
    "/api/v1/agents/:agentId/runtime-binding",
    async (request, reply) => {
      const { agentId } = agentParamsSchema.parse(request.params);
      const input = removeAgentRuntimeBindingInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `agent-runtime-binding:${agentId}`,
        operation: "runtime.binding.remove",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.removeAgentRuntimeBinding(
            agentId,
            input,
            actorId,
            requestIsAdministrator(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/agents/:agentId/runtime-preflight",
    async (request, reply) => {
      const { agentId } = agentParamsSchema.parse(request.params);
      const input = agentRuntimePreflightInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.preflightAgentRuntime(
          agentId,
          input,
          actorId,
          requestIsAdministrator(request.headers),
        ),
      );
    },
  );

  app.get("/api/v1/runtimes", async (request, reply) => {
    const query = listRuntimesQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listExternalRuntimes(
        actorId,
        requestIsAdministrator(request.headers),
        query.includeArchived,
      ),
    });
  });

  app.post("/api/v1/runtimes", async (request, reply) => {
    const input = createExternalRuntimeInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: "external-runtimes",
      operation: "runtime.create",
      actorId,
      payload: input,
      statusCode: 201,
      execute: () =>
        application.createExternalRuntime(
          input,
          actorId,
          requestIsAdministrator(request.headers),
        ),
    });
  });

  app.get("/api/v1/runtimes/:runtimeId", async (request, reply) => {
    const { runtimeId } = runtimeParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.getExternalRuntime(
        runtimeId,
        actorId,
        requestIsAdministrator(request.headers),
      ),
    );
  });

  app.patch("/api/v1/runtimes/:runtimeId", async (request, reply) => {
    const { runtimeId } = runtimeParamsSchema.parse(request.params);
    const input = updateExternalRuntimeInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `external-runtime:${runtimeId}`,
      operation: "runtime.update",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () =>
        application.updateExternalRuntime(
          runtimeId,
          input,
          actorId,
          requestIsAdministrator(request.headers),
        ),
    });
  });

  app.post("/api/v1/runtimes/:runtimeId/probe", async (request, reply) => {
    const { runtimeId } = runtimeParamsSchema.parse(request.params);
    const input = runtimeRevisionInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `external-runtime:${runtimeId}`,
      operation: "runtime.probe",
      actorId,
      payload: input,
      statusCode: 202,
      execute: () =>
        application.requestExternalRuntimeProbe(
          runtimeId,
          input.expectedRevision,
          actorId,
          requestIsAdministrator(request.headers),
        ),
    });
  });

  for (const transition of [
    "enable",
    "disable",
    "archive",
    "restore",
  ] as const) {
    app.post(
      `/api/v1/runtimes/:runtimeId/${transition}`,
      async (request, reply) => {
        const { runtimeId } = runtimeParamsSchema.parse(request.params);
        const input = runtimeRevisionInputSchema.parse(request.body);
        const actorId = requestActorId(request.headers);
        const nextStatus =
          transition === "enable"
            ? "active"
            : transition === "restore"
              ? "disabled"
              : transition === "archive"
                ? "archived"
                : "disabled";
        return idempotentRoute({
          request,
          reply,
          scope: `external-runtime:${runtimeId}`,
          operation: `runtime.${transition}`,
          actorId,
          payload: input,
          statusCode: 200,
          execute: () =>
            application.transitionExternalRuntime(
              runtimeId,
              nextStatus,
              input.expectedRevision,
              actorId,
              requestIsAdministrator(request.headers),
            ),
        });
      },
    );
  }

  app.get("/api/v1/runtimes/:runtimeId/events", async (request, reply) => {
    const { runtimeId } = runtimeParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listExternalRuntimeEvents(
        runtimeId,
        actorId,
        requestIsAdministrator(request.headers),
      ),
    });
  });

  app.get(
    "/api/v1/runtimes/:runtimeId/capabilities",
    async (request, reply) => {
      const { runtimeId } = runtimeParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send({
        items: await application.listExternalRuntimeCapabilities(
          runtimeId,
          actorId,
          requestIsAdministrator(request.headers),
        ),
      });
    },
  );

  app.get("/api/v1/runtimes/:runtimeId/access", async (request, reply) => {
    const { runtimeId } = runtimeParamsSchema.parse(request.params);
    return reply.send(
      await application.getRuntimeAccess(
        runtimeId,
        requestActorId(request.headers),
        requestIsAdministrator(request.headers),
      ),
    );
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/runtimes",
    async (request, reply) => {
      const { workspaceId } = workspaceParamsSchema.parse(request.params);
      const query = listRuntimesQuerySchema.parse(request.query);
      return reply.send({
        items: await application.listWorkspaceRuntimeCatalog({
          workspaceId,
          actorId: requestActorId(request.headers),
          administrator: requestIsAdministrator(request.headers),
          includeArchived: query.includeArchived,
        }),
      });
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/runtime-economics",
    async (request, reply) => {
      const { workspaceId } = workspaceParamsSchema.parse(request.params);
      const query = workspaceRuntimeEconomicsQuerySchema.parse(request.query);
      return reply.send(
        await application.getWorkspaceRuntimeEconomics(
          workspaceId,
          query,
          requestActorId(request.headers),
        ),
      );
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/execution-history",
    async (request, reply) => {
      const { workspaceId } = workspaceParamsSchema.parse(request.params);
      const query = executionHistoryQuerySchema.parse(request.query);
      return reply.send(
        await application.listExecutionHistory(
          workspaceId,
          query,
          requestActorId(request.headers),
        ),
      );
    },
  );

  app.get("/api/v1/runs/:runId/economics", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return reply.send(
      await application.getRunEconomics(runId, requestActorId(request.headers)),
    );
  });

  app.get("/api/v1/tasks", async (request, reply) => {
    const query = listTasksQuerySchema.parse(request.query);
    if (query.projectId === undefined) {
      const principal = requestPrincipals.get(request);
      if (principal === undefined) {
        throw new ApplicationError(
          "unauthorized",
          "Authentication is required",
          401,
        );
      }
      const readableProjectIds =
        await repositories.authorization.listReadableProjectIds({
          principalId: principal.principalId,
          authSource: principal.authSource,
        });
      return reply.send({
        items: await application.listTasks(undefined, readableProjectIds),
      });
    }
    return reply.send({ items: await application.listTasks(query.projectId) });
  });

  app.get("/api/v1/projects/:projectId/task-queue", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listTaskQueue(projectId, actorId),
    });
  });

  app.post(
    "/api/v1/projects/:projectId/task-queue/claim",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = claimTaskInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      const claim = await application.claimNextTask(projectId, input, actorId);
      if (claim === undefined) {
        return reply.status(204).send();
      }
      return reply.status(200).send(claim);
    },
  );

  app.post("/api/v1/tasks", async (request, reply) => {
    const input = createTaskInputSchema.parse(request.body);
    return reply.status(201).send(await application.createTask(input));
  });

  app.get("/api/v1/tasks/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send(await application.getTask(id));
  });

  app.get("/api/v1/tasks/:id/detail", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send(await application.getTaskDetail(id));
  });

  app.patch("/api/v1/tasks/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateTaskInputSchema.parse(request.body);
    return reply.send(await application.updateTask(id, input));
  });

  app.post("/api/v1/tasks/:id/dispatch", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply
      .status(202)
      .send(
        await application.dispatchTask(
          id,
          requestTraces.get(request) ?? createRootTraceContext(),
          actorId,
          requestIsAdministrator(request.headers),
        ),
      );
  });

  app.post("/api/v1/tasks/:id/claim/release", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = releaseTaskClaimInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.releaseTaskClaim(id, input, actorId));
  });

  app.post("/api/v1/tasks/:id/pause", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = pauseTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.pause",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.pauseTask(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/block", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = blockTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.block",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.blockTask(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/request-input", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = requestTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.request_input",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.requestTaskInput(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/input", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = provideTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.provide_input",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.provideTaskInput(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/resume", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = resumeTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.resume",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.resumeTask(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/submit", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = submitTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.submit",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.submitTask(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/session-reset", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = resetTaskSessionInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.session_reset",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.resetTaskSession(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/transfer", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = transferTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.transfer",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.transferTask(id, input, actorId),
    });
  });

  app.post("/api/v1/tasks/:id/review", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = taskReviewInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.reviewTask(id, input, actorId));
  });

  app.get("/api/v1/tasks/:id/runs", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send({ items: await application.listTaskRuns(id) });
  });

  app.post("/api/v1/tasks/:id/messages", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = createTaskMessageInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply
      .status(201)
      .send(
        await application.postTaskMessage(
          id,
          input,
          actorId,
          requestActorName(request.headers, actorId),
        ),
      );
  });

  app.post("/api/v1/tasks/:id/attachments", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = uploadTaskAttachmentInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    const encoded =
      input.contentBase64.startsWith("data:") &&
      input.contentBase64.includes(",")
        ? input.contentBase64.slice(input.contentBase64.indexOf(",") + 1)
        : input.contentBase64;
    const content = Buffer.from(encoded, "base64");
    if (content.byteLength === 0) {
      throw new ApplicationError(
        "invalid_input",
        "Attachment content is empty",
        400,
      );
    }
    return reply.status(201).send(
      await application.uploadTaskAttachment(
        id,
        {
          name: input.name,
          mimeType: input.mimeType,
          content,
          ...(input.documentPath === undefined
            ? {}
            : { documentPath: input.documentPath }),
        },
        actorId,
      ),
    );
  });

  app.get(
    "/api/v1/attachments/:attachmentId/download",
    async (request, reply) => {
      const { attachmentId } = taskAttachmentParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      const { attachment, content } = await application.readTaskAttachment(
        attachmentId,
        actorId,
      );
      return reply
        .header("content-type", attachment.mimeType)
        .header(
          "content-disposition",
          `attachment; filename="${attachment.name.replaceAll('"', "")}"`,
        )
        .send(Buffer.from(content));
    },
  );

  app.get("/api/v1/tasks/:id/documents", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const query = taskDocumentsQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.listTaskDocuments(id, query.includeArchived, actorId),
    );
  });

  app.post(
    "/api/v1/tasks/:id/documents/:attachmentId/reveal",
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const { attachmentId } = taskAttachmentParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.revealTaskDocument(id, attachmentId, actorId),
      );
    },
  );

  app.post(
    "/api/v1/attachments/:attachmentId/archive",
    async (request, reply) => {
      const { attachmentId } = taskAttachmentParamsSchema.parse(request.params);
      const { archived } = archiveTaskAttachmentInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.archiveTaskAttachment(
          attachmentId,
          archived,
          actorId,
        ),
      );
    },
  );

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getRunDetail(runId, actorId));
  });

  app.get("/api/v1/traces/:traceId", async (request, reply) => {
    const { traceId } = traceParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    const trace = await repositories.traces.get(traceId);
    if (trace === undefined) {
      throw new ApplicationError("trace_not_found", "Trace was not found", 404);
    }
    for (const run of trace.runs) {
      if (
        run.directChatTurnId !== null &&
        !(await repositories.directChats.canAccessRun(run.id, actorId))
      ) {
        throw new ApplicationError(
          "direct_chat_forbidden",
          "The AI direct chat belongs to another account",
          403,
        );
      }
    }
    return reply.send(trace);
  });

  app.get("/api/v1/runs/:runId/events", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const { afterSeq, afterDeltaSeq } = eventQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    const detail = await application.getRunDetail(runId, actorId);
    const repository = new PlatformRepositories(database).runs;
    return reply.send({
      runId,
      runStatus: detail.run.status,
      items: await repository.listEvents(runId, afterSeq),
      deltas: await repository.listDeltas(runId, afterDeltaSeq),
    });
  });

  app.get("/api/v1/runs/:runId/input", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    const detail = await application.getRunDetail(runId, actorId);
    return reply.send({ inputSnapshot: detail.run.inputSnapshot });
  });

  app.get("/api/v1/runs/:runId/context", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getRunContext(runId, actorId));
  });

  app.get("/api/v1/runs/:runId/scene-context", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getRunSceneContext(runId, actorId));
  });

  app.get(
    "/api/v1/runs/:runId/scene-context/replay",
    async (request, reply) => {
      const { runId } = runParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.replayRunSceneContext(runId, actorId),
      );
    },
  );

  app.post(
    "/api/v1/runs/:runId/scene-context/contributions",
    async (request, reply) => {
      const { runId } = runParamsSchema.parse(request.params);
      const input = createSceneContextContributionInputSchema.parse(
        request.body,
      );
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(
          await application.appendRunSceneContribution(runId, input, actorId),
        );
    },
  );

  app.get("/api/v1/runs/:runId/execution-envelope", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.getRunExecutionEnvelope(runId, actorId),
    );
  });

  app.get("/api/v1/runs/:runId/action-ticket", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getRunActionTicket(runId, actorId));
  });

  app.get("/api/v1/runs/:runId/execution-gates", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listRunExecutionGates(runId, actorId),
    });
  });

  app.post(
    "/api/v1/execution-gates/:gateId/decisions",
    async (request, reply) => {
      const { gateId } = executionGateParamsSchema.parse(request.params);
      const input = decideExecutionGateInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.decideExecutionGate(gateId, input, actorId),
      );
    },
  );

  app.post("/api/v1/execution-gates/:gateId/cancel", async (request, reply) => {
    const { gateId } = executionGateParamsSchema.parse(request.params);
    const input = cancelExecutionGateInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.cancelExecutionGate(gateId, input, actorId),
    );
  });

  app.get("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listArtifacts(runId, actorId),
    });
  });

  app.get("/api/v1/artifacts/:artifactId/download", async (request, reply) => {
    const { artifactId } = artifactParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    const artifact = await application.getArtifact(artifactId, actorId);
    const ref: FileRef = {
      id: artifact.id,
      storageKey: artifact.storageKey,
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      sha256: artifact.sha256,
    };
    const content = await fileStore.read(ref);
    return reply
      .header("content-type", artifact.mimeType)
      .header(
        "content-disposition",
        `attachment; filename="${artifact.name.replaceAll('"', "")}"`,
      )
      .send(Buffer.from(content));
  });

  app.post("/api/v1/runs/:runId/cancel", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    await application.cancelRun(runId, actorId);
    return reply.status(202).send({ ok: true });
  });

  app.get("/api/v1/projects/:projectId/memory", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.listMemory(projectId, actorId));
  });

  app.post(
    "/api/v1/projects/:projectId/memory/topics",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = createMemoryTopicInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(await application.createMemoryTopic(projectId, input, actorId));
    },
  );

  app.post(
    "/api/v1/projects/:projectId/memory/topics/:topicId/claims",
    async (request, reply) => {
      const { projectId, topicId } = memoryTopicParamsSchema.parse(
        request.params,
      );
      const input = createMemoryClaimInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(
          await application.addMemoryClaim(projectId, topicId, input, actorId),
        );
    },
  );

  app.patch(
    "/api/v1/projects/:projectId/memory/topics/:topicId/claims/:claimId",
    async (request, reply) => {
      const { projectId, topicId, claimId } = memoryClaimParamsSchema.parse(
        request.params,
      );
      const input = updateMemoryClaimInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.updateMemoryClaim(
          projectId,
          topicId,
          claimId,
          input,
          actorId,
        ),
      );
    },
  );

  app.post(
    "/api/v1/projects/:projectId/memory/topics/:topicId/truths",
    async (request, reply) => {
      const { projectId, topicId } = memoryTopicParamsSchema.parse(
        request.params,
      );
      const input = publishMemoryTruthInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(
          await application.publishMemoryTruth(
            projectId,
            topicId,
            input,
            actorId,
          ),
        );
    },
  );

  app.get(
    "/api/v1/projects/:projectId/memory/reviews",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.listMemoryReviews(projectId, actorId),
      );
    },
  );

  app.post(
    "/api/v1/projects/:projectId/memory/reviews",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = reviewMemoryClaimsInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.reviewMemoryClaims(projectId, input, actorId),
      );
    },
  );

  app.get(
    "/api/v1/projects/:projectId/memory/claims/:claimId",
    async (request, reply) => {
      const { projectId, claimId } = projectClaimParamsSchema.parse(
        request.params,
      );
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.getMemoryClaimTrace(projectId, claimId, actorId),
      );
    },
  );

  app.get("/api/v1/projects/:projectId/handoffs", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listHandoffs(projectId, actorId),
    });
  });

  app.post("/api/v1/projects/:projectId/handoffs", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = createHandoffCardInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply
      .status(201)
      .send(await application.createHandoff(projectId, input, actorId));
  });

  app.get(
    "/api/v1/projects/:projectId/handoffs/:handoffId",
    async (request, reply) => {
      const { projectId, handoffId } = projectHandoffParamsSchema.parse(
        request.params,
      );
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.getHandoff(projectId, handoffId, actorId),
      );
    },
  );

  app.patch(
    "/api/v1/projects/:projectId/handoffs/:handoffId",
    async (request, reply) => {
      const { projectId, handoffId } = projectHandoffParamsSchema.parse(
        request.params,
      );
      const input = updateHandoffCardInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.updateHandoff(projectId, handoffId, input, actorId),
      );
    },
  );

  app.post(
    "/api/v1/projects/:projectId/handoffs/:handoffId/confirm",
    async (request, reply) => {
      const { projectId, handoffId } = projectHandoffParamsSchema.parse(
        request.params,
      );
      const input = confirmHandoffCardInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.confirmHandoff(projectId, handoffId, input, actorId),
      );
    },
  );

  app.get(
    "/api/v1/projects/:projectId/agent-episodes",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const { agentId } = episodeQuerySchema.parse(request.query);
      const actorId = requestActorId(request.headers);
      return reply.send({
        items: await application.listAgentEpisodes(projectId, agentId, actorId),
      });
    },
  );

  app.post(
    "/api/v1/projects/:projectId/agent-episodes",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = createAgentEpisodeInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(await application.createAgentEpisode(projectId, input, actorId));
    },
  );

  app.get("/api/v1/workbench/dashboard", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getWorkbenchDashboard(actorId));
  });

  app.post("/api/v1/workbench/brief/refresh", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const input = refreshWorkbenchBriefInputSchema.parse(request.body ?? {});
    return idempotentRoute({
      request,
      reply,
      scope: `workbench:${actorId}:brief`,
      operation: "workbench.brief.refresh",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () =>
        application.refreshWorkbenchBrief(actorId, input.briefDate),
    });
  });

  app.get("/api/v1/workbench/brief", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getLatestWorkbenchBrief(actorId));
  });

  app.post("/api/v1/workbench/brief/:briefId/read", async (request, reply) => {
    const { briefId } = workbenchBriefParamsSchema.parse(request.params);
    const input = markReportReadInputSchema.parse(request.body ?? {});
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.markWorkbenchBriefRead(actorId, briefId, input.read),
    );
  });

  app.get("/api/v1/workbench/brief/settings", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getWorkbenchBriefSettings(actorId));
  });

  app.patch("/api/v1/workbench/brief/settings", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const input = updateWorkbenchBriefSettingsInputSchema.parse(request.body);
    return reply.send(
      await application.updateWorkbenchBriefSettings(actorId, input),
    );
  });

  app.get("/api/v1/workbench/follows", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listWorkbenchFollows(actorId),
    });
  });

  app.post("/api/v1/workbench/follows", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const input = setWorkbenchFollowInputSchema.parse(request.body);
    return idempotentRoute({
      request,
      reply,
      scope: `workbench:${actorId}:follows`,
      operation: "workbench.follow.set",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.setWorkbenchFollow(actorId, input),
    });
  });

  const projectRiskQuerySchema = z.object({ projectId: z.string().uuid() });
  app.get("/api/v1/workbench/supply-exceptions", async (request, reply) => {
    const { projectId } = projectRiskQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listSupplyExceptions(projectId, actorId),
    });
  });

  app.post("/api/v1/workbench/supply-exceptions", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const input = createSupplyExceptionInputSchema.parse(request.body);
    return idempotentRoute({
      request,
      reply,
      scope: `project:${input.projectId}:supply-exceptions`,
      operation: "workbench.supply-exception.create",
      actorId,
      payload: input,
      statusCode: 201,
      execute: () => application.createSupplyException(input, actorId),
    });
  });

  app.get("/api/v1/workbench/supplier-risks", async (request, reply) => {
    const { projectId } = projectRiskQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listSupplierRisks(projectId, actorId),
    });
  });

  app.post("/api/v1/workbench/supplier-risks", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    const input = createSupplierRiskInputSchema.parse(request.body);
    return idempotentRoute({
      request,
      reply,
      scope: `project:${input.projectId}:supplier-risks`,
      operation: "workbench.supplier-risk.create",
      actorId,
      payload: input,
      statusCode: 201,
      execute: () => application.createSupplierRisk(input, actorId),
    });
  });

  app.get("/api/v1/workbench", async (_request, reply) => {
    return reply.send(await application.getWorkbench());
  });

  app.get("/api/v1/workflows", async (request, reply) => {
    const { projectId } = listTasksQuerySchema.parse(request.query);
    if (projectId === undefined) {
      throw new ApplicationError("invalid_input", "projectId is required", 400);
    }
    return reply.send({ items: await application.listWorkflows(projectId) });
  });

  app.post("/api/v1/workflows/validate", async (request, reply) => {
    const input = validateWorkflowMarkdownInputSchema.parse(request.body);
    return reply.send(application.validateWorkflowMarkdown(input));
  });

  app.post("/api/v1/workflows/import", async (request, reply) => {
    const input = importWorkflowMarkdownInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.importWorkflowMarkdown(input));
  });

  app.post("/api/v1/workflows", async (request, reply) => {
    const input = createWorkflowInputSchema.parse(request.body);
    return reply.status(201).send(await application.createWorkflow(input));
  });

  app.post("/api/v1/workflows/:workflowId/start", async (request, reply) => {
    const { workflowId } = workflowParamsSchema.parse(request.params);
    const input = startWorkflowInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return idempotentRoute({
      request,
      reply,
      scope: `workflow:${workflowId}`,
      operation: "workflow.start",
      actorId,
      payload: input,
      statusCode: 201,
      execute: () =>
        application.startWorkflow(
          workflowId,
          input,
          actorId,
          requestIdempotencyKey(request.headers),
        ),
    });
  });

  app.get("/api/v1/workflow-instances", async (request, reply) => {
    const { projectId } = listTasksQuerySchema.parse(request.query);
    if (projectId === undefined) {
      throw new ApplicationError("invalid_input", "projectId is required", 400);
    }
    return reply.send({
      items: await application.listWorkflowInstances(projectId),
    });
  });

  app.get("/api/v1/workflow-audit", async (request, reply) => {
    const query = workflowAuditQuerySchema.parse(request.query);
    return reply.send(await application.listWorkflowAudit(query));
  });

  app.get("/api/v1/workflow-instances/:instanceId", async (request, reply) => {
    const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
    return reply.send(await application.getWorkflowInstance(instanceId));
  });

  app.get(
    "/api/v1/workflow-instances/:instanceId/detail",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      return reply.send(
        await application.getWorkflowInstanceDetail(instanceId),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/advance",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.advance",
        actorId,
        payload: {},
        statusCode: 200,
        execute: () =>
          application.advanceWorkflow(
            instanceId,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/dispatch",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.dispatch",
        actorId,
        payload: {},
        statusCode: 202,
        execute: () =>
          application.dispatchWorkflowStep(
            instanceId,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/nodes/complete",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = completeWorkflowNodeInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.node.complete",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.completeWorkflowNode(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/approvals",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = decideWorkflowApprovalInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.approval.decide",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.decideWorkflowApproval(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/approvals/transfer",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = transferWorkflowApprovalInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.approval.transfer",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.transferWorkflowApproval(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/approvals/cosign",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = cosignWorkflowApprovalInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.approval.cosign",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.cosignWorkflowApproval(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/pause",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = workflowReasonInputSchema.parse(request.body ?? {});
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.pause",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.pauseWorkflow(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/resume",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = workflowReasonInputSchema.parse(request.body ?? {});
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.resume",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.resumeWorkflow(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/retry",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = retryWorkflowNodeInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.node.retry",
        actorId,
        payload: input,
        statusCode: 200,
        execute: () =>
          application.retryWorkflowNode(
            instanceId,
            input,
            actorId,
            requestIdempotencyKey(request.headers),
          ),
      });
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/reconcile",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `workflow-instance:${instanceId}`,
        operation: "workflow.reconcile",
        actorId,
        payload: {},
        statusCode: 200,
        execute: () =>
          application.reconcileWorkflowInstance(instanceId, actorId),
      });
    },
  );

  app.get("/api/v1/direct-chats", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listDirectChats(actorId),
    });
  });

  app.post("/api/v1/direct-chats", async (request, reply) => {
    const input = createDirectChatInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.ensureDirectChat(input, actorId));
  });

  app.get("/api/v1/direct-chats/:threadId", async (request, reply) => {
    const { threadId } = directChatParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getDirectChat(threadId, actorId));
  });

  app.post(
    "/api/v1/direct-chats/:threadId/messages",
    async (request, reply) => {
      const { threadId } = directChatParamsSchema.parse(request.params);
      const input = sendDirectChatMessageInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `direct-chat:${threadId}`,
        operation: "direct-chat.message.send",
        actorId,
        payload: input,
        statusCode: 202,
        execute: () =>
          application.sendDirectChatMessage(
            threadId,
            input,
            actorId,
            requestTraces.get(request) ?? createRootTraceContext(),
          ),
      });
    },
  );

  app.post(
    "/api/v1/direct-chats/:threadId/turns/:turnId/retry",
    async (request, reply) => {
      const { threadId, turnId } = directChatTurnParamsSchema.parse(
        request.params,
      );
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `direct-chat:${threadId}`,
        operation: "direct-chat.message.retry",
        actorId,
        payload: { turnId },
        statusCode: 202,
        execute: () =>
          application.retryDirectChatTurn(
            threadId,
            turnId,
            actorId,
            requestTraces.get(request) ?? createRootTraceContext(),
          ),
      });
    },
  );

  app.post(
    "/api/v1/direct-chats/:threadId/turns/:turnId/cancel",
    async (request, reply) => {
      const { threadId, turnId } = directChatTurnParamsSchema.parse(
        request.params,
      );
      const actorId = requestActorId(request.headers);
      return reply.status(202).send({
        turn: await application.cancelDirectChatTurn(threadId, turnId, actorId),
      });
    },
  );

  app.get("/api/v1/meetings", async (request, reply) => {
    const { projectId } = listTasksQuerySchema.parse(request.query);
    if (projectId === undefined) {
      throw new ApplicationError("invalid_input", "projectId is required", 400);
    }
    const actorId = requestActorId(request.headers);
    return reply.send({
      items: await application.listMeetings(projectId, actorId),
    });
  });

  app.post("/api/v1/meetings", async (request, reply) => {
    const input = createMeetingInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply
      .status(201)
      .send(await application.createMeeting(input, actorId));
  });

  app.get("/api/v1/meetings/:meetingId", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getMeeting(meetingId, actorId));
  });

  app.get("/api/v1/meetings/:meetingId/ai-policy", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getMeetingAiPolicy(meetingId, actorId));
  });

  app.put("/api/v1/meetings/:meetingId/ai-policy", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const input = updateMeetingAiPolicyInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.updateMeetingAiPolicy(meetingId, input, actorId),
    );
  });

  for (const transition of ["pause", "resume", "terminate"] as const) {
    app.post(
      `/api/v1/meetings/:meetingId/ai-policy/${transition}`,
      async (request, reply) => {
        const { meetingId } = meetingParamsSchema.parse(request.params);
        const input = meetingAiPolicyLifecycleInputSchema.parse(request.body);
        const actorId = requestActorId(request.headers);
        const method =
          transition === "pause"
            ? application.pauseMeetingAi.bind(application)
            : transition === "resume"
              ? application.resumeMeetingAi.bind(application)
              : application.terminateMeetingAi.bind(application);
        return reply.send(await method(meetingId, input, actorId));
      },
    );
  }

  app.post(
    "/api/v1/meetings/:meetingId/ai-triggers",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const input = triggerMeetingAiInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `meeting:${meetingId}`,
        operation: "meeting.ai.trigger",
        actorId,
        payload: input,
        statusCode: 202,
        execute: () => application.triggerMeetingAi(meetingId, input, actorId),
      });
    },
  );

  app.get("/api/v1/meetings/:meetingId/minutes", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const actorId = requestActorId(request.headers);
    return reply.send(await application.getMeetingMinutes(meetingId, actorId));
  });

  app.put(
    "/api/v1/meetings/:meetingId/minutes/draft",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const input = updateMeetingMinutesDraftInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.saveMeetingMinutesDraft(meetingId, input, actorId),
      );
    },
  );

  app.post(
    "/api/v1/meetings/:meetingId/minutes/publish",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const input = publishMeetingMinutesInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.publishMeetingMinutes(meetingId, input, actorId),
      );
    },
  );

  app.post(
    "/api/v1/meetings/:meetingId/memory/ingest",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.ingestMeetingMinutes(meetingId, actorId),
      );
    },
  );

  app.get(
    "/api/v1/meetings/:meetingId/action-items",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send({
        items: await application.listMeetingActionItems(meetingId, actorId),
      });
    },
  );

  app.post(
    "/api/v1/meetings/:meetingId/action-items",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const input = createMeetingActionItemInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply
        .status(201)
        .send(
          await application.createMeetingActionItem(meetingId, input, actorId),
        );
    },
  );

  app.patch(
    "/api/v1/meetings/:meetingId/action-items/:actionItemId",
    async (request, reply) => {
      const { meetingId, actionItemId } = meetingActionItemParamsSchema.parse(
        request.params,
      );
      const input = updateMeetingActionItemInputSchema.parse(request.body);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.updateMeetingActionItem(
          meetingId,
          actionItemId,
          input,
          actorId,
        ),
      );
    },
  );

  app.post(
    "/api/v1/meetings/:meetingId/action-items/:actionItemId/convert",
    async (request, reply) => {
      const { meetingId, actionItemId } = meetingActionItemParamsSchema.parse(
        request.params,
      );
      const input = convertMeetingActionItemInputSchema.parse(
        request.body ?? {},
      );
      const actorId = requestActorId(request.headers);
      return idempotentRoute({
        request,
        reply,
        scope: `meeting:${meetingId}`,
        operation: "meeting.action-item.convert",
        actorId,
        payload: { actionItemId, ...input },
        statusCode: 200,
        execute: () =>
          application.convertMeetingActionItem(
            meetingId,
            actionItemId,
            input,
            actorId,
          ),
      });
    },
  );

  app.get(
    "/api/v1/meetings/:meetingId/traceability",
    async (request, reply) => {
      const { meetingId } = meetingParamsSchema.parse(request.params);
      const actorId = requestActorId(request.headers);
      return reply.send(
        await application.getMeetingTraceability(meetingId, actorId),
      );
    },
  );

  app.post("/api/v1/meetings/:meetingId/messages", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const input = meetingMessageInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply
      .status(201)
      .send(
        await application.postMeetingMessage(
          meetingId,
          input.content,
          actorId,
          input.mentions,
        ),
      );
  });

  app.post("/api/v1/meetings/:meetingId/close", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const input = meetingCloseInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    return reply.send(
      await application.closeMeeting(meetingId, input.summary, actorId),
    );
  });

  app.get("/api/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const { afterSeq, afterDeltaSeq } = eventQuerySchema.parse(request.query);
    const actorId = requestActorId(request.headers);
    await application.getRunDetail(runId, actorId);
    const repository = new PlatformRepositories(database).runs;
    const initial = await repository.get(runId);
    if (initial === undefined) {
      return reply
        .status(404)
        .send(apiError(String(request.id), "run_not_found", "Run not found"));
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.write("retry: 1000\n\n");

    let eventSeq = afterSeq;
    let deltaSeq = afterDeltaSeq;
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    while (!closed) {
      const [events, deltas, current] = await Promise.all([
        repository.listEvents(runId, eventSeq),
        repository.listDeltas(runId, deltaSeq),
        repository.get(runId),
      ]);
      if (current === undefined) break;

      for (const delta of deltas) {
        deltaSeq = delta.seq;
        response.write(
          `id: d${delta.seq}\nevent: run.delta\ndata: ${JSON.stringify(delta)}\n\n`,
        );
      }
      for (const event of events) {
        eventSeq = event.seq;
        response.write(
          `id: e${event.seq}\nevent: run.event\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }

      if (
        ["completed", "failed", "cancelled", "timeout", "interrupted"].includes(
          current.status,
        ) &&
        events.length === 0 &&
        deltas.length === 0
      ) {
        response.end();
        break;
      }
      await sleep(250);
    }
    return reply;
  });

  app.addHook("onClose", async () => {
    if (options.database === undefined) await database.close();
  });

  return { app, database };
}
