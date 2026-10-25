import { randomUUID } from "node:crypto";
import {
  type ApiError,
  agentStatusInputSchema,
  archiveTaskAttachmentInputSchema,
  createAgentInputSchema,
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
  decideWorkflowApprovalInputSchema,
  importWorkflowMarkdownInputSchema,
  publishMemoryTruthInputSchema,
  taskReviewInputSchema,
  retryWorkflowNodeInputSchema,
  startWorkflowInputSchema,
  uploadTaskAttachmentInputSchema,
  updateAgentInputSchema,
  updateMemoryClaimInputSchema,
  updateProjectMemberInputSchema,
  updateProjectInputSchema,
  updateProjectRoleInputSchema,
  updateTaskInputSchema,
  validateWorkflowMarkdownInputSchema,
  workflowReasonInputSchema,
} from "@pluginmax/contracts";
import { ApplicationError, PlatformApplication } from "@pluginmax/application";
import { Database, PlatformRepositories } from "@pluginmax/database";
import { LocalFileStore, type FileRef } from "@pluginmax/files";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { ZodError, z } from "zod";

export interface BuildApiOptions {
  readonly databaseUrl: string;
  readonly fileStoreRoot: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly database?: Database;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const runParamsSchema = z.object({ runId: z.string().uuid() });
const artifactParamsSchema = z.object({ artifactId: z.string().uuid() });
const taskAttachmentParamsSchema = z.object({
  attachmentId: z.string().uuid(),
});
const workflowParamsSchema = z.object({ workflowId: z.string().uuid() });
const workflowInstanceParamsSchema = z.object({
  instanceId: z.string().uuid(),
});
const meetingParamsSchema = z.object({ meetingId: z.string().uuid() });
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

export function buildApi(options: BuildApiOptions): {
  app: FastifyInstance;
  database: Database;
} {
  const database = options.database ?? new Database(options.databaseUrl);
  const fileStore = new LocalFileStore(options.fileStoreRoot);
  const application = new PlatformApplication(
    new PlatformRepositories(database),
    fileStore,
  );
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024 * 1024,
  });

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
    await database.ping();
    return reply.send({ ok: true });
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
    return reply.status(202).send(await application.dispatchTask(id));
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
    return reply.send({ items: await application.listMemory(projectId) });
  });

  app.post(
    "/api/v1/projects/:projectId/memory/topics",
    async (request, reply) => {
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = createMemoryTopicInputSchema.parse(request.body);
      return reply
        .status(201)
        .send(await application.createMemoryTopic(projectId, input));
    },
  );

  app.post(
    "/api/v1/projects/:projectId/memory/topics/:topicId/claims",
    async (request, reply) => {
      const { projectId, topicId } = memoryTopicParamsSchema.parse(
        request.params,
      );
      const input = createMemoryClaimInputSchema.parse(request.body);
      return reply
        .status(201)
        .send(await application.addMemoryClaim(projectId, topicId, input));
    },
  );

  app.patch(
    "/api/v1/projects/:projectId/memory/topics/:topicId/claims/:claimId",
    async (request, reply) => {
      const { projectId, topicId, claimId } = memoryClaimParamsSchema.parse(
        request.params,
      );
      const input = updateMemoryClaimInputSchema.parse(request.body);
      return reply.send(
        await application.updateMemoryClaim(projectId, topicId, claimId, input),
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
      return reply
        .status(201)
        .send(await application.publishMemoryTruth(projectId, topicId, input));
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
    return reply
      .status(201)
      .send(
        await application.startWorkflow(
          workflowId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
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
      return reply.send(
        await application.advanceWorkflow(
          instanceId,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/dispatch",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      return reply
        .status(202)
        .send(
          await application.dispatchWorkflowStep(
            instanceId,
            requestActorId(request.headers),
            requestIdempotencyKey(request.headers),
          ),
        );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/nodes/complete",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = completeWorkflowNodeInputSchema.parse(request.body);
      return reply.send(
        await application.completeWorkflowNode(
          instanceId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/approvals",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = decideWorkflowApprovalInputSchema.parse(request.body);
      return reply.send(
        await application.decideWorkflowApproval(
          instanceId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/pause",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = workflowReasonInputSchema.parse(request.body ?? {});
      return reply.send(
        await application.pauseWorkflow(
          instanceId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/resume",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = workflowReasonInputSchema.parse(request.body ?? {});
      return reply.send(
        await application.resumeWorkflow(
          instanceId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/retry",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      const input = retryWorkflowNodeInputSchema.parse(request.body);
      return reply.send(
        await application.retryWorkflowNode(
          instanceId,
          input,
          requestActorId(request.headers),
          requestIdempotencyKey(request.headers),
        ),
      );
    },
  );

  app.post(
    "/api/v1/workflow-instances/:instanceId/reconcile",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      return reply.send(
        await application.reconcileWorkflowInstance(
          instanceId,
          requestActorId(request.headers),
        ),
      );
    },
  );

  app.get("/api/v1/meetings", async (request, reply) => {
    const { projectId } = listTasksQuerySchema.parse(request.query);
    if (projectId === undefined) {
      throw new ApplicationError("invalid_input", "projectId is required", 400);
    }
    return reply.send({ items: await application.listMeetings(projectId) });
  });

  app.post("/api/v1/meetings", async (request, reply) => {
    const input = createMeetingInputSchema.parse(request.body);
    return reply.status(201).send(await application.createMeeting(input));
  });

  app.get("/api/v1/meetings/:meetingId", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    return reply.send(await application.getMeeting(meetingId));
  });

  app.post("/api/v1/meetings/:meetingId/messages", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const input = meetingMessageInputSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.postMeetingMessage(meetingId, input.content));
  });

  app.post("/api/v1/meetings/:meetingId/close", async (request, reply) => {
    const { meetingId } = meetingParamsSchema.parse(request.params);
    const input = meetingCloseInputSchema.parse(request.body);
    return reply.send(await application.closeMeeting(meetingId, input.summary));
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
