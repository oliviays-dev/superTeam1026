import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { z } from "zod";
import {
  contextDomainSpec,
  type AgentIdentitySnapshot,
  type AiChatChannel,
  type ChatCarrier,
  type ContextPack,
  type ContextRequest,
  type ContextReceipt,
  type SceneType,
  type SceneSessionBinding,
} from "./models.js";
import {
  ContextError,
  ContextService,
  type KvTableLike,
  type MemoryRecallerLike,
  type ProjectedContextReceipt,
  type SceneContextAdapter,
} from "./service.js";

export const name = "dsh-collab-context";
export const inject = ["storageDomain", "webServer"];

export {
  ContextError,
  ContextService,
  contextDomainSpec,
  type KvTableLike,
  type MemoryRecallerLike,
  type ProjectedContextReceipt,
  type SceneContextAdapter,
};
export type {
  AgentIdentitySnapshot,
  AiChatChannel,
  ChatCarrier,
  ContextPack,
  ContextRequest,
  ContextReceipt,
  SceneType,
  SceneSessionBinding,
};

interface ContextDomainLike {
  table(name: "sessions"): KvTableLike<SceneSessionBinding>;
  table(name: "identities"): KvTableLike<AgentIdentitySnapshot>;
  table(name: "chat_channels"): KvTableLike<AiChatChannel>;
  table(name: "packs"): KvTableLike<ContextPack>;
  table(name: "receipts"): KvTableLike<ContextReceipt>;
  close(): Promise<void>;
}

interface TeammateDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly soul: string;
  readonly scenarios: readonly string[];
  readonly goals: readonly string[];
  readonly source: "personal" | "platform";
  readonly templateId?: string | undefined;
}

interface TeammateLike {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly ownerUserId: string;
  readonly ownerUserIds?: readonly string[];
  readonly principalId?: string | undefined;
  readonly templateId?: string | undefined;
  readonly version: string;
}

interface TeammateTemplateLike {
  readonly id: string;
  readonly version: string;
}

interface TeammateServiceLike {
  get(teammateId: string): TeammateLike | undefined;
  effectiveDefinitionOf(teammate: TeammateLike): TeammateDefinitionLike;
  templateOf(teammate: TeammateLike): TeammateTemplateLike | undefined;
  list(): readonly TeammateLike[];
}

interface AgentProfileLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly personaId?: string;
  readonly ownerUserId: string;
  readonly visibility?: "workspace" | "platform";
  readonly status: "active" | "disabled";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentServiceLike {
  profile(workspaceId: string, profileId: string): AgentProfileLike | undefined;
}

interface TeamServiceLike {
  resolveToken(token: string):
    | {
        readonly userId: string;
        readonly role: "admin" | "owner" | "member" | "guest";
      }
    | undefined;
  members(workspaceId: string): readonly {
    readonly userId: string;
    readonly memberRole: "owner" | "member" | "guest";
  }[];
}

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface ContextContext {
  storageDomain: {
    open(spec: typeof contextDomainSpec): Promise<ContextDomainLike>;
  };
  provide(key: "collabContext", service: ContextService): unknown;
  webServer: { register(route: WebRouteLike): unknown };
  effect(operation: () => () => void): void;
  get(key: string): unknown;
  get(key: "collabTeammates"): TeammateServiceLike | undefined;
  get(key: "collabAgent"): AgentServiceLike | undefined;
  get(key: "collabMemory"): MemoryRecallerLike | undefined;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: ContextContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function queryValue(request: IncomingMessage, key: string): string {
  return (
    new URL(request.url ?? "/", "http://localhost").searchParams.get(key) ?? ""
  );
}

const PRIVATE_CHAT_WORKSPACE_ID = "system.default";

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): {
  readonly userId: string;
  readonly role: "admin" | "owner" | "member" | "guest";
  readonly workspaceRole: "owner" | "member" | "guest";
  readonly member: boolean;
} {
  if (
    request.headers.origin !== undefined &&
    !sameOrigin(request.headers.origin, request.headers.host)
  ) {
    throw new ContextError("forbidden", "same-origin request is required");
  }
  const token = bearerToken({
    get: (key) =>
      key === "authorization" ? (request.headers.authorization ?? null) : null,
  });
  if (token === undefined) {
    throw new ContextError("forbidden", "bearer token is required");
  }
  const principal = team.resolveToken(token);
  if (principal === undefined) {
    throw new ContextError("forbidden", "invalid bearer token");
  }
  const member = team
    .members(workspaceId)
    .find((candidate) => candidate.userId === principal.userId);
  if (
    member === undefined &&
    principal.role !== "admin" &&
    workspaceId !== PRIVATE_CHAT_WORKSPACE_ID
  ) {
    throw new ContextError("forbidden", "workspace membership is required");
  }
  return {
    userId: principal.userId,
    role: principal.role,
    workspaceRole: member?.memberRole ?? "member",
    member: member !== undefined,
  };
}

function routeError(response: ServerResponse, cause: unknown): void {
  const error =
    cause instanceof ContextError
      ? cause
      : new ContextError("invalid_input", "context request failed");
  const status =
    error.code === "forbidden"
      ? 403
      : error.code === "not_found"
        ? 404
        : error.code === "conflict"
          ? 409
          : 400;
  sendJson(response, status, {
    ok: false,
    error: { code: error.code, message: error.message },
  });
}

const receiptQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(180).optional(),
  receiptId: z.string().trim().min(1).max(180).optional(),
});

const receiptListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  scene: z
    .enum(["project", "task", "meeting", "chat", "workflow-node"])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

function createContextRoutes(
  service: ContextService,
  team: () => TeamServiceLike | undefined,
): WebRouteLike[] {
  const resolveTeam = (): TeamServiceLike => {
    const current = team();
    if (current === undefined) {
      throw new ContextError("forbidden", "team service is unavailable");
    }
    return current;
  };
  return [
    {
      kind: "exact",
      path: "/api/collab/context/receipts",
      handler: (request, response) => {
        try {
          const query = receiptListQuerySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
            ...(queryValue(request, "scene") === ""
              ? {}
              : { scene: queryValue(request, "scene") }),
            ...(queryValue(request, "limit") === ""
              ? {}
              : { limit: queryValue(request, "limit") }),
          });
          const currentTeam = resolveTeam();
          const actor = browserActor(
            currentTeam,
            request,
            query.workspaceId,
          );
          const receipts = service
            .listReceipts(query)
            .flatMap((receipt) => {
              try {
                return [
                  service.projectReceipt(receipt, {
                    actorPrincipalId: actor.userId,
                    workspaceMember: actor.member,
                    admin: actor.role === "admin",
                    agentOwner: false,
                  }),
                ];
              } catch {
                return [];
              }
            });
          sendJson(response, 200, { ok: true, receipts });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/context/receipt",
      handler: (request, response) => {
        try {
          const query = receiptQuerySchema.parse({
            workspaceId: queryValue(request, "workspaceId"),
            ...(queryValue(request, "runId") === ""
              ? {}
              : { runId: queryValue(request, "runId") }),
            ...(queryValue(request, "receiptId") === ""
              ? {}
              : { receiptId: queryValue(request, "receiptId") }),
          });
          if (query.runId === undefined && query.receiptId === undefined) {
            throw new ContextError(
              "invalid_input",
              "runId or receiptId is required",
            );
          }
          const currentTeam = resolveTeam();
          const actor = browserActor(
            currentTeam,
            request,
            query.workspaceId,
          );
          const receipt =
            query.runId === undefined
              ? service.receiptById(query.receiptId!)
              : service.receipt(query.runId);
          if (receipt === undefined) {
            throw new ContextError("not_found", "context receipt not found");
          }
          if (receipt.workspaceId !== query.workspaceId) {
            throw new ContextError(
              "context_scope_violation",
              "receipt workspace mismatch",
            );
          }
          const projection: ProjectedContextReceipt = service.projectReceipt(
            receipt,
            {
              actorPrincipalId: actor.userId,
              workspaceMember: actor.member,
              admin: actor.role === "admin",
              agentOwner: false,
            },
          );
          sendJson(response, 200, { ok: true, projection });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
  ];
}

export async function apply(ctx: ContextContext): Promise<void> {
  const domain = await ctx.storageDomain.open(contextDomainSpec);
  const service = new ContextService(
    {
      sessions: domain.table("sessions"),
      identities: domain.table("identities"),
      chatChannels: domain.table("chat_channels"),
      packs: domain.table("packs"),
      receipts: domain.table("receipts"),
    },
    {
      memory: () => ctx.get("collabMemory") as MemoryRecallerLike | undefined,
    },
  );
  const disposeResolver = service.registerIdentityResolver((input) => {
    const teammates = ctx.get("collabTeammates");
    const teammate =
      input.teammateId === undefined
        ? undefined
        : teammates?.get(input.teammateId);
    const capturedAt = new Date().toISOString();
    if (teammates !== undefined && teammate !== undefined) {
      const definition = teammates.effectiveDefinitionOf(teammate);
      const template = teammates.templateOf(teammate);
      const templateVersion = template?.version ?? teammate.version;
      const goals = [...definition.goals];
      const scenarios = [...definition.scenarios];
      const ownerPrincipalIds = [
        ...new Set(
          [...(teammate.ownerUserIds ?? []), teammate.ownerUserId].filter(
            (ownerId) =>
              ownerId !== "" && ownerId !== "platform" && ownerId !== "system",
          ),
        ),
      ];
      return {
        id: `identity-${sha256(
          `${teammate.id}:${templateVersion}:${definition.soul}`,
        ).slice(0, 24)}`,
        agentPrincipalId: teammate.principalId ?? input.agentPrincipalId,
        teammateId: teammate.id,
        templateId: template?.id ?? teammate.templateId ?? teammate.id,
        templateVersion,
        name: definition.name,
        role: definition.role,
        soul: definition.soul,
        soulHash: sha256(definition.soul),
        goals,
        scenarios,
        source: definition.source,
        ownerPrincipalIds,
        ...(ownerPrincipalIds[0] === undefined
          ? {}
          : { ownerPrincipalId: ownerPrincipalIds[0] }),
        capturedAt,
        definitionHash: sha256(
          JSON.stringify({
            name: definition.name,
            description: definition.description,
            role: definition.role,
            soul: definition.soul,
            scenarios,
            goals,
          }),
        ),
      };
    }
    const profileId = input.agentProfileId ?? input.agentPrincipalId;
    const workspaceId = input.workspaceId ?? "";
    const profile = ctx.get("collabAgent")?.profile(workspaceId, profileId);
    if (profile === undefined || profile.status !== "active") return undefined;
    const soul = profile.description.trim();
    const ownerPrincipalIds = [profile.ownerUserId];
    return {
      id: `identity-${sha256(
        `${profile.id}:${profile.updatedAt}:${soul}`,
      ).slice(0, 24)}`,
      agentPrincipalId: input.agentPrincipalId,
      teammateId: profile.id,
      templateId: profile.personaId ?? "legacy-agent-profile",
      templateVersion: profile.updatedAt,
      name: profile.name,
      role: "",
      soul,
      soulHash: sha256(soul),
      goals: [],
      scenarios: [],
      source: profile.visibility === "workspace" ? "personal" : "platform",
      ownerPrincipalId: profile.ownerUserId,
      ownerPrincipalIds,
      capturedAt,
      definitionHash: sha256(
        JSON.stringify({
          name: profile.name,
          description: profile.description,
          personaId: profile.personaId ?? "",
        }),
      ),
    };
  });
  ctx.provide("collabContext", service);
  let team: TeamServiceLike | undefined;
  const teamFiber = ctx.inject(["collabTeam"], (child) => {
    team = child.collabTeam;
    for (const route of createContextRoutes(service, () => team)) {
      child.webServer.register(route);
    }
  });
  ctx.effect(() => () => {
    teamFiber.dispose();
    disposeResolver();
    void domain.close();
  });
}
