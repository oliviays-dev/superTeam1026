import { createHash, randomUUID } from "node:crypto";
import {
  type ApiError,
  agentStatusInputSchema,
  approvalSlaSweepInputSchema,
  archiveTaskAttachmentInputSchema,
  confirmHandoffCardInputSchema,
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
  createTaskMessageInputSchema,
  createTaskInputSchema,
  createWorkflowInputSchema,
  completeWorkflowNodeInputSchema,
  convertMeetingActionItemInputSchema,
  cosignWorkflowApprovalInputSchema,
  decideWorkflowApprovalInputSchema,
  importWorkflowMarkdownInputSchema,
  idempotencyCleanupInputSchema,
  jobListQuerySchema,
  jobRecoveryInputSchema,
  publishMemoryTruthInputSchema,
  publishMeetingMinutesInputSchema,
  reviewMemoryClaimsInputSchema,
  taskReviewInputSchema,
  traceIdSchema,
  transferTaskInputSchema,
  retryWorkflowNodeInputSchema,
  startWorkflowInputSchema,
  uploadTaskAttachmentInputSchema,
  updateAgentInputSchema,
  updateHandoffCardInputSchema,
  updateMeetingActionItemInputSchema,
  updateMeetingMinutesDraftInputSchema,
  updateMemoryClaimInputSchema,
  updateProjectMemberInputSchema,
  updateProjectInputSchema,
  updateProjectRoleInputSchema,
  updateTaskInputSchema,
  transferWorkflowApprovalInputSchema,
  validateWorkflowMarkdownInputSchema,
  workflowAuditQuerySchema,
  workflowReasonInputSchema,
  createRootTraceContext,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
} from "@pluginmax/contracts";
import {
  ApplicationError,
  PlatformApplication,
  renderRuntimePrometheusMetrics,
} from "@pluginmax/application";
import { Database, PlatformRepositories } from "@pluginmax/database";
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
  readonly expectedMigrationVersion?: number;
  readonly workerHeartbeatStaleAfterSeconds?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly database?: Database;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const runParamsSchema = z.object({ runId: z.string().uuid() });
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
const meetingActionItemParamsSchema = meetingParamsSchema.extend({
  actionItemId: z.string().uuid(),
});
const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const projectMemberParamsSchema = z.object({
  projectId: z.string().uuid(),
  memberId: z.string().uuid(),
});
const projectRoleParamsSchema = z.object({
  projectId: z.string().uuid(),
  roleId: z.string().uuid(),
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
});
const meetingCloseInputSchema = z.object({
  summary: z.string().trim().max(20_000).default(""),
});
const listTasksQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});
const listAgentsQuerySchema = z.object({
  includeDisabled: z
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

function requestActorId(headers: Record<string, unknown>): string {
  const value = headers["x-pluginmax-actor"];
  const actor = Array.isArray(value) ? value[0] : value;
  return typeof actor === "string" && /^[a-zA-Z0-9_.:-]{1,180}$/.test(actor)
    ? actor
    : "local-admin";
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
  const localActorId = options.localActorId ?? "local-admin";
  const expectedMigrationVersion = options.expectedMigrationVersion ?? 16;
  const workerHeartbeatStaleAfterSeconds =
    options.workerHeartbeatStaleAfterSeconds ?? 30;
  const startedAt = Date.now();
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024 * 1024,
  });
  const requestTraces = new WeakMap<FastifyRequest, TraceContext>();

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

  function assertAdministrator(actorId: string): void {
    if (actorId !== localActorId) {
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
    request.log.error({ error }, "request failed");
    return reply
      .status(500)
      .send(apiError(String(request.id), "internal_error", "Internal error"));
  });

  app.get("/api/v1/health", async (_request, reply) => {
    return reply.send({
      ok: true,
      service: "pluginmax-api",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    });
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
    assertAdministrator(actorId);
    return reply.send(
      await application.recoverDeadLetterJob(jobId, input.reason, actorId),
    );
  });

  app.post("/api/v1/operations/approval-sla/sweep", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    assertAdministrator(actorId);
    const input = approvalSlaSweepInputSchema.parse(request.body ?? {});
    return reply.send(
      await application.sweepApprovalSla(actorId, input.batchSize, {
        triggerSource: "api",
        trace: requestTraces.get(request) ?? createRootTraceContext(),
      }),
    );
  });

  app.post("/api/v1/operations/idempotency/cleanup", async (request, reply) => {
    const actorId = requestActorId(request.headers);
    assertAdministrator(actorId);
    const input = idempotencyCleanupInputSchema.parse(request.body ?? {});
    return reply.send(
      await application.cleanupIdempotencyReceipts(input, {
        triggerSource: "api",
        trace: requestTraces.get(request) ?? createRootTraceContext(),
      }),
    );
  });

  app.get("/api/v1/projects", async (_request, reply) => {
    return reply.send({ items: await application.listProjects() });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const input = createProjectInputSchema.parse(request.body);
    return reply.status(201).send(await application.createProject(input));
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const projects = await application.listProjects();
    const project = projects.find((item) => item.id === projectId);
    if (project === undefined) {
      throw new ApplicationError("project_not_found", "Project not found", 404);
    }
    return reply.send(project);
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = updateProjectInputSchema.parse(request.body);
    return reply.send(await application.updateProject(projectId, input));
  });

  app.get("/api/v1/projects/:projectId/roles", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    return reply.send({
      items: await application.listProjectRoles(projectId),
    });
  });

  app.post("/api/v1/projects/:projectId/roles", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = createProjectRoleInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.createProjectRole(projectId, input));
  });

  app.patch(
    "/api/v1/projects/:projectId/roles/:roleId",
    async (request, reply) => {
      const { projectId, roleId } = projectRoleParamsSchema.parse(
        request.params,
      );
      const input = updateProjectRoleInputSchema.parse(request.body);
      return reply.send(
        await application.updateProjectRole(projectId, roleId, input),
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

  app.post("/api/v1/projects/:projectId/members", async (request, reply) => {
    const { projectId } = projectParamsSchema.parse(request.params);
    const input = createProjectMemberInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.createProjectMember(projectId, input));
  });

  app.patch(
    "/api/v1/projects/:projectId/members/:memberId",
    async (request, reply) => {
      const { projectId, memberId } = projectMemberParamsSchema.parse(
        request.params,
      );
      const input = updateProjectMemberInputSchema.parse(request.body);
      return reply.send(
        await application.updateProjectMember(projectId, memberId, input),
      );
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/members/:memberId",
    async (request, reply) => {
      const { projectId, memberId } = projectMemberParamsSchema.parse(
        request.params,
      );
      await application.deleteProjectMember(projectId, memberId);
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
    return reply.status(201).send(await application.createAgent(input));
  });

  app.get("/api/v1/agents/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send(await application.getAgent(id));
  });

  app.patch("/api/v1/agents/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateAgentInputSchema.parse(request.body);
    return reply.send(await application.updateAgent(id, input));
  });

  app.post("/api/v1/agents/:id/status", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { status } = agentStatusInputSchema.parse(request.body);
    return reply.send(await application.setAgentStatus(id, status));
  });

  app.get("/api/v1/tasks", async (request, reply) => {
    const query = listTasksQuerySchema.parse(request.query);
    return reply.send({ items: await application.listTasks(query.projectId) });
  });

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
    return reply
      .status(202)
      .send(
        await application.dispatchTask(
          id,
          requestTraces.get(request) ?? createRootTraceContext(),
        ),
      );
  });

  app.post("/api/v1/tasks/:id/transfer", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = transferTaskInputSchema.parse(request.body);
    const actorId = requestActorId(request.headers);
    if (actorId !== localActorId) {
      throw new ApplicationError(
        "forbidden",
        "Only the local administrator can transfer tasks",
        403,
      );
    }
    return idempotentRoute({
      request,
      reply,
      scope: `task:${id}`,
      operation: "task.transfer",
      actorId,
      payload: input,
      statusCode: 200,
      execute: () => application.transferTask(id, input),
    });
  });

  app.post("/api/v1/tasks/:id/review", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = taskReviewInputSchema.parse(request.body);
    return reply.send(await application.reviewTask(id, input));
  });

  app.get("/api/v1/tasks/:id/runs", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    return reply.send({ items: await application.listTaskRuns(id) });
  });

  app.post("/api/v1/tasks/:id/messages", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = createTaskMessageInputSchema.parse(request.body);
    return reply.status(201).send(await application.postTaskMessage(id, input));
  });

  app.post("/api/v1/tasks/:id/attachments", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = uploadTaskAttachmentInputSchema.parse(request.body);
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
      await application.uploadTaskAttachment(id, {
        name: input.name,
        mimeType: input.mimeType,
        content,
      }),
    );
  });

  app.get(
    "/api/v1/attachments/:attachmentId/download",
    async (request, reply) => {
      const { attachmentId } = taskAttachmentParamsSchema.parse(request.params);
      const { attachment, content } =
        await application.readTaskAttachment(attachmentId);
      return reply
        .header("content-type", attachment.mimeType)
        .header(
          "content-disposition",
          `attachment; filename="${attachment.name.replaceAll('"', "")}"`,
        )
        .send(Buffer.from(content));
    },
  );

  app.post(
    "/api/v1/attachments/:attachmentId/archive",
    async (request, reply) => {
      const { attachmentId } = taskAttachmentParamsSchema.parse(request.params);
      const { archived } = archiveTaskAttachmentInputSchema.parse(request.body);
      return reply.send(
        await application.archiveTaskAttachment(attachmentId, archived),
      );
    },
  );

  app.get("/api/v1/runs/:runId", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return reply.send(await application.getRunDetail(runId));
  });

  app.get("/api/v1/traces/:traceId", async (request, reply) => {
    const { traceId } = traceParamsSchema.parse(request.params);
    const trace = await repositories.traces.get(traceId);
    if (trace === undefined) {
      throw new ApplicationError("trace_not_found", "Trace was not found", 404);
    }
    return reply.send(trace);
  });

  app.get("/api/v1/runs/:runId/events", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const { afterSeq, afterDeltaSeq } = eventQuerySchema.parse(request.query);
    const detail = await application.getRunDetail(runId);
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
    const detail = await application.getRunDetail(runId);
    return reply.send({ inputSnapshot: detail.run.inputSnapshot });
  });

  app.get("/api/v1/runs/:runId/context", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return reply.send(await application.getRunContext(runId));
  });

  app.get("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return reply.send({ items: await application.listArtifacts(runId) });
  });

  app.get("/api/v1/artifacts/:artifactId/download", async (request, reply) => {
    const { artifactId } = artifactParamsSchema.parse(request.params);
    const artifact = await application.getArtifact(artifactId);
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
    await application.cancelRun(runId);
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
        await application.postMeetingMessage(meetingId, input.content, actorId),
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
