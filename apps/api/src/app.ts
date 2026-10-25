import { randomUUID } from "node:crypto";
import {
  type ApiError,
  createMeetingInputSchema,
  createProjectInputSchema,
  createTaskInputSchema,
  createWorkflowInputSchema,
  taskReviewInputSchema,
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
const workflowParamsSchema = z.object({ workflowId: z.string().uuid() });
const workflowInstanceParamsSchema = z.object({
  instanceId: z.string().uuid(),
});
const meetingParamsSchema = z.object({ meetingId: z.string().uuid() });
const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const workflowStartSchema = z.object({
  title: z.string().trim().min(1).max(180),
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
const eventQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  afterDeltaSeq: z.coerce.number().int().nonnegative().default(0),
});

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiError(requestId: string, code: string, message: string): ApiError {
  return { requestId, code, message };
}

export function buildApi(options: BuildApiOptions): {
  app: FastifyInstance;
  database: Database;
} {
  const database = options.database ?? new Database(options.databaseUrl);
  const fileStore = new LocalFileStore(options.fileStoreRoot);
  const application = new PlatformApplication(
    new PlatformRepositories(database),
  );
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: () => randomUUID(),
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
        .send(apiError(String(request.id), error.code, error.message));
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

  app.get("/api/v1/agents", async (_request, reply) => {
    return reply.send({ items: await application.listAgents() });
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

  app.post("/api/v1/workflows", async (request, reply) => {
    const input = createWorkflowInputSchema.parse(request.body);
    return reply.status(201).send(await application.createWorkflow(input));
  });

  app.post("/api/v1/workflows/:workflowId/start", async (request, reply) => {
    const { workflowId } = workflowParamsSchema.parse(request.params);
    const { title } = workflowStartSchema.parse(request.body);
    return reply
      .status(201)
      .send(await application.startWorkflow(workflowId, title));
  });

  app.get("/api/v1/workflow-instances/:instanceId", async (request, reply) => {
    const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
    return reply.send(await application.getWorkflowInstance(instanceId));
  });

  app.post(
    "/api/v1/workflow-instances/:instanceId/advance",
    async (request, reply) => {
      const { instanceId } = workflowInstanceParamsSchema.parse(request.params);
      return reply.send(await application.advanceWorkflow(instanceId));
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
