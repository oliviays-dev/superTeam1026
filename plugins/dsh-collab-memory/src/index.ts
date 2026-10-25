import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { z } from "zod";
import {
  memoryDomainSpec,
  type AgentMemoryEpisode,
  type CurrentTruth,
  type HandoffCard,
  type IngestJob,
  type ProjectClaim,
  type ProjectTopic,
  type ReviewItem,
} from "./models.js";
import { MemoryError, MemoryService, type KvTableLike } from "./service.js";
import { createAgentMemoryExecutor } from "./extractor.js";

export const name = "dsh-collab-memory";
export const inject = ["storageDomain", "webServer"];

export { MemoryError, MemoryService, memoryDomainSpec, type KvTableLike };
export type {
  AgentMemoryEpisode,
  CurrentTruth,
  HandoffCard,
  IngestJob,
  ProjectClaim,
  ProjectTopic,
  ReviewItem,
};

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface MemoryDomainLike {
  table(name: "topics"): KvTableLike<ProjectTopic>;
  table(name: "claims"): KvTableLike<ProjectClaim>;
  table(name: "truths"): KvTableLike<CurrentTruth>;
  table(name: "episodes"): KvTableLike<AgentMemoryEpisode>;
  table(name: "handoffs"): KvTableLike<HandoffCard>;
  table(name: "reviews"): KvTableLike<ReviewItem>;
  table(name: "ingest_jobs"): KvTableLike<IngestJob>;
  close(): Promise<void>;
}

interface TeamMemberLike {
  readonly userId: string;
  readonly name?: string;
  readonly memberRole: "owner" | "member" | "guest";
}

interface TeamServiceLike {
  resolveToken(token: string):
    | {
        readonly userId: string;
        readonly role: "admin" | "owner" | "member" | "guest";
      }
    | undefined;
  members(workspaceId: string): readonly TeamMemberLike[];
}

interface MemoryContext {
  storageDomain: {
    open(spec: typeof memoryDomainSpec): Promise<MemoryDomainLike>;
  };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: "collabMemory", service: MemoryService): unknown;
  effect(operation: () => () => void): void;
  get(key: string): unknown;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: MemoryContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
}

interface BrowserActor {
  readonly userId: string;
  readonly name: string;
  readonly role: "admin" | "owner" | "member" | "guest";
  readonly workspaceRole: "owner" | "member" | "guest";
}

const querySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
});

const truthQuerySchema = querySchema.extend({
  topicId: z.string().trim().min(1).max(180),
});

const reviewInputSchema = z.object({
  reviewId: z.string().trim().min(1).max(180),
  workspaceId: z.string().trim().min(1).max(200),
  decision: z.enum(["approved", "rejected", "superseded"]),
  note: z.string().trim().max(4_000).optional(),
});

const ingestRetrySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
});

function queryValue(request: IncomingMessage, key: string): string {
  return (
    new URL(request.url ?? "/", "http://localhost").searchParams.get(key) ?? ""
  );
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): BrowserActor {
  if (
    request.headers.origin !== undefined &&
    !sameOrigin(request.headers.origin, request.headers.host)
  ) {
    throw new MemoryError("forbidden", "same-origin request is required");
  }
  const token = bearerToken({
    get: (key) =>
      key === "authorization" ? (request.headers.authorization ?? null) : null,
  });
  if (token === undefined) {
    throw new MemoryError("forbidden", "bearer token is required");
  }
  const principal = team.resolveToken(token);
  if (principal === undefined) {
    throw new MemoryError("forbidden", "invalid bearer token");
  }
  const member = team
    .members(workspaceId)
    .find((candidate) => candidate.userId === principal.userId);
  if (member === undefined && principal.role !== "admin") {
    throw new MemoryError("forbidden", "workspace membership is required");
  }
  return {
    userId: principal.userId,
    name: member?.name ?? principal.userId,
    role: principal.role,
    workspaceRole: member?.memberRole ?? "member",
  };
}

function routeError(response: ServerResponse, cause: unknown): void {
  const error =
    cause instanceof MemoryError
      ? cause
      : new MemoryError("invalid_input", "memory request failed");
  const status =
    error.code === "forbidden"
      ? 403
      : error.code === "not_found"
        ? 404
        : error.code === "conflict" || error.code === "revision_conflict"
          ? 409
          : 400;
  sendJson(response, status, {
    ok: false,
    error: { code: error.code, message: error.message },
  });
}

export function canDecideMemoryReview(input: {
  readonly status: ReviewItem["status"];
  readonly actorUserId: string;
  readonly globalRole: BrowserActor["role"];
  readonly workspaceRole: BrowserActor["workspaceRole"];
  readonly reviewOwnerPrincipalId?: string | undefined;
}): boolean {
  return (
    input.status === "pending" &&
    (input.globalRole === "admin" ||
      input.workspaceRole === "owner" ||
      input.reviewOwnerPrincipalId === input.actorUserId)
  );
}

function reviewProjection(
  service: MemoryService,
  review: ReviewItem,
  actor: BrowserActor,
): {
  readonly review: ReviewItem;
  readonly topic?: ProjectTopic;
  readonly claim?: ProjectClaim;
  readonly truth?: CurrentTruth;
  readonly canDecide: boolean;
} {
  const claim =
    review.claimId === undefined ? undefined : service.claim(review.claimId);
  const topicId = review.topicId ?? claim?.topicId;
  const topic =
    topicId === undefined
      ? undefined
      : service.listTopics(review.workspaceId).find((item) => item.id === topicId);
  return {
    review,
    ...(topic === undefined ? {} : { topic }),
    ...(claim === undefined ? {} : { claim }),
    ...(topic === undefined ? {} : { truth: service.truth(topic.id) }),
    canDecide: canDecideMemoryReview({
      status: review.status,
      actorUserId: actor.userId,
      globalRole: actor.role,
      workspaceRole: actor.workspaceRole,
      ...(claim?.reviewOwnerPrincipalId === undefined
        ? {}
        : { reviewOwnerPrincipalId: claim.reviewOwnerPrincipalId }),
    }),
  };
}

function createMemoryRoutes(
  service: MemoryService,
  team: () => TeamServiceLike | undefined,
): WebRouteLike[] {
  return [
    {
      kind: "exact",
      path: "/api/collab/memory/topics",
      handler: (request, response) => {
        try {
          const parsed = querySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
          });
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          browserActor(currentTeam, request, parsed.workspaceId);
          sendJson(response, 200, {
            ok: true,
            topics: service.listTopics(parsed.workspaceId),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/memory/truth",
      handler: (request, response) => {
        try {
          const parsed = truthQuerySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
            topicId: queryValue(request, "topicId"),
          });
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          browserActor(currentTeam, request, parsed.workspaceId);
          const topic = service.topic(parsed.topicId);
          if (topic.workspaceId !== parsed.workspaceId) {
            throw new MemoryError("forbidden", "topic workspace mismatch");
          }
          sendJson(response, 200, {
            ok: true,
            topic,
            truth: service.truth(parsed.topicId),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/memory/ingest",
      handler: (request, response) => {
        try {
          const parsed = querySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
          });
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          browserActor(currentTeam, request, parsed.workspaceId);
          sendJson(response, 200, {
            ok: true,
            jobs: service.listIngestJobs(parsed.workspaceId),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/memory/ingest/retry",
      handler: async (request, response) => {
        try {
          const body = ingestRetrySchema.parse(await readJsonBody(request));
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          const actor = browserActor(currentTeam, request, body.workspaceId);
          if (actor.role !== "admin" && actor.workspaceRole !== "owner") {
            throw new MemoryError(
              "forbidden",
              "workspace owner or admin is required",
            );
          }
          sendJson(response, 200, {
            ok: true,
            retried: await service.retryFailedIngestJobs(body.workspaceId),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/memory/review",
      handler: (request, response) => {
        try {
          const parsed = querySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
          });
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          const actor = browserActor(
            currentTeam,
            request,
            parsed.workspaceId,
          );
          sendJson(response, 200, {
            ok: true,
            reviews: service
              .listReview(parsed.workspaceId)
              .map((review) => reviewProjection(service, review, actor)),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/memory/review/decide",
      handler: async (request, response) => {
        try {
          const body = reviewInputSchema.parse(await readJsonBody(request));
          const currentTeam = team();
          if (currentTeam === undefined) {
            throw new MemoryError("forbidden", "team service is unavailable");
          }
          const actor = browserActor(currentTeam, request, body.workspaceId);
          const review = service.review(body.reviewId);
          const projection = reviewProjection(service, review, actor);
          if (!projection.canDecide) {
            throw new MemoryError(
              "forbidden",
              "workspace owner, review owner, or admin is required",
            );
          }
          sendJson(response, 200, {
            ok: true,
            review: await service.decideReview({
              reviewId: body.reviewId,
              decision: body.decision,
              actorPrincipalId: actor.userId,
              ...(body.note === undefined ? {} : { note: body.note }),
            }),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
  ];
}

export async function apply(ctx: MemoryContext): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec);
  const service = new MemoryService({
    topics: domain.table("topics"),
    claims: domain.table("claims"),
    truths: domain.table("truths"),
    episodes: domain.table("episodes"),
    handoffs: domain.table("handoffs"),
    reviews: domain.table("reviews"),
    ingestJobs: domain.table("ingest_jobs"),
  }, {
    executor: () =>
      createAgentMemoryExecutor({
        agents: () => ctx.get("agents") as never,
        defaultModel: () => ctx.get("agentDefaultModel") as never,
        workspaces: () =>
          ctx.get("workspaceRegistry") as
            | { get(id: string): { readonly path: string } | undefined }
            | undefined,
      }),
  });
  ctx.provide("collabMemory", service);
  const ingestTimer = setTimeout(() => {
    void service.drainIngestJobs().catch(() => undefined);
  }, 1_000);
  ctx.effect(() => () => {
    if (ingestTimer !== undefined) clearTimeout(ingestTimer);
    void domain.close();
  });
  let team: TeamServiceLike | undefined;
  const disposers = ctx.inject(["collabTeam"], (child) => {
    team = child.collabTeam;
    for (const route of createMemoryRoutes(service, () => team)) {
      child.webServer.register(route);
    }
  });
  ctx.effect(() => () => disposers.dispose());
}
