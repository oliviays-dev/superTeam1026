import { randomUUID } from "node:crypto";
import {
  type ApiError,
  createProjectInputSchema,
  createTaskInputSchema,
} from "@pluginmax/contracts";
import { ApplicationError, PlatformApplication } from "@pluginmax/application";
import { Database, PlatformRepositories } from "@pluginmax/database";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { ZodError, z } from "zod";

export interface BuildApiOptions {
  readonly databaseUrl: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly database?: Database;
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const runParamsSchema = z.object({ runId: z.string().uuid() });
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
    const detail = await application.getRunDetail(runId);
    return reply.send({
      runId,
      sources: [
        {
          type: "task",
          id: detail.run.taskId,
          label: detail.run.inputSnapshot.taskTitle,
        },
      ],
      status: "ready",
    });
  });

  app.get("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const detail = await application.getRunDetail(runId);
    return reply.send({
      items: detail.events
        .filter((event) => event.type === "artifact.created")
        .map((event) => ({ ...event.data, createdAt: event.createdAt })),
    });
  });

  app.post("/api/v1/runs/:runId/cancel", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    await application.cancelRun(runId);
    return reply.status(202).send({ ok: true });
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
