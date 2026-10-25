import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { followTypeSchema, workbenchDomainSpec } from "./models.js";
import { BriefPushHub } from "./push.js";
import {
  MODULE_IDS,
  WorkbenchError,
  WorkbenchService,
  type ModuleId,
  type WorkbenchPrincipal,
} from "./service.js";

export { workbenchDomainSpec } from "./models.js";
export {
  MODULE_IDS,
  MODULE_TITLES,
  WorkbenchError,
  WorkbenchService,
} from "./service.js";
export type {
  ModuleId,
  ModuleOptions,
  WorkbenchDeps,
  WorkbenchModule,
  WorkbenchPrincipal,
} from "./service.js";

export const name = "dsh-collab-workbench";
export const inject = ["storageDomain", "webServer"];

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface TeamServiceLike {
  resolveToken(token: string): TeamPrincipalLike | undefined;
  users(): readonly { readonly id: string; readonly name: string }[];
  members(
    workspaceId: string,
  ): readonly { readonly userId: string; readonly role?: string }[];
}

interface TeamPrincipalLike {
  readonly userId: string;
  readonly role?: "admin" | "owner" | "member" | "guest";
}

interface WorkbenchContext {
  storageDomain: {
    open(spec: unknown): Promise<{
      table(name: string): unknown;
      close(): Promise<void>;
    }>;
  };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: string, value: unknown): void;
  effect(operation: () => () => void): void;
  get(key: string, strict?: boolean): unknown;
  on?(name: string, listener: (payload: unknown) => void): (() => void) | undefined;
  root?: { get(key: string, strict?: boolean): unknown };
}

/**
 * Cordis 的服务可见性依赖 inject 声明与 isolate 作用域；这里先用宽松模式读取，
 * 再回退到根上下文，避免插件装配顺序导致依赖静默缺失。
 */
function lookup<T>(ctx: WorkbenchContext, name: string): T | undefined {
  const direct = ctx.get(name, false);
  if (direct !== undefined) return direct as T;
  return ctx.root?.get(name, false) as T | undefined;
}

const tzOffsetSchema = z
  .number()
  .int()
  .min(-840)
  .max(840)
  .optional();

const readInputSchema = z.object({
  itemId: z.string().min(1).max(320),
  tzOffset: tzOffsetSchema,
});

const followInputSchema = z.object({
  type: followTypeSchema,
  targetId: z.string().min(1).max(200),
});

const metricsInputSchema = z.object({
  selected: z.array(z.string().min(1).max(80)).min(1).max(5),
});

const briefSettingsInputSchema = z
  .object({
    mode: z.enum(["lastLeave", "manual"]),
    manualWindowFrom: z.string().datetime({ precision: 3 }).optional(),
  })
  .refine(
    (value) => value.mode === "lastLeave" || value.manualWindowFrom !== undefined,
    { message: "手动时间窗口必须指定开始时间" },
  );

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://dsh.invalid").searchParams;
}

function assertSameOrigin(request: IncomingMessage): void {
  if (
    request.headers.origin !== undefined &&
    !sameOrigin(request.headers.origin, request.headers.host)
  ) {
    throw new WorkbenchError("forbidden", "same-origin request is required");
  }
}

function tzOffsetFromRaw(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  const parsed = tzOffsetSchema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : 0;
}

function principalFor(
  request: IncomingMessage,
  team: TeamServiceLike,
): WorkbenchPrincipal {
  const token = bearerToken({
    get(name) {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
  });
  if (token === undefined) {
    throw new WorkbenchError("unauthorized", "bearer token is required");
  }
  const resolved = team.resolveToken(token);
  if (resolved === undefined) {
    throw new WorkbenchError("unauthorized", "invalid or expired token");
  }
  const user = team
    .users()
    .find((candidate) => candidate.id === resolved.userId);
  return {
    userId: resolved.userId,
    ...(user?.name === undefined ? {} : { name: user.name }),
    ...(resolved.role === undefined ? {} : { role: resolved.role }),
  };
}

/**
 * 方案 B：工作台默认只看"已加入"的工作区；`scope=all` 请求全量聚合，
 * 该参数只对平台管理员生效，其他角色传了也会被忽略。
 */
function scopedPrincipal(
  request: IncomingMessage,
  team: TeamServiceLike,
): WorkbenchPrincipal {
  const principal = principalFor(request, team);
  if (query(request).get("scope") !== "all") return principal;
  if (principal.role !== "admin") return principal;
  return { ...principal, scopeAll: true };
}

function routeError(response: ServerResponse, cause: unknown): void {
  if (cause instanceof WorkbenchError) {
    const status =
      cause.code === "invalid_input"
        ? 400
        : cause.code === "unauthorized"
          ? 401
          : cause.code === "forbidden"
            ? 403
            : cause.code === "not_found"
              ? 404
              : 503;
    sendJson(response, status, {
      ok: false,
      error: { code: cause.code, message: cause.message },
    });
    return;
  }
  const message =
    cause instanceof Error ? cause.message : "unexpected workbench failure";
  sendJson(response, 500, {
    ok: false,
    error: { code: "internal_error", message },
  });
}

function moduleIdFrom(raw: string | null): ModuleId {
  const value = raw ?? "";
  if ((MODULE_IDS as readonly string[]).includes(value)) {
    return value as ModuleId;
  }
  throw new WorkbenchError("not_found", "unknown workbench module");
}

function createWorkbenchRoutes(
  service: WorkbenchService,
  ctx: WorkbenchContext,
  hub: BriefPushHub,
): WebRouteLike[] {
  const requireTeam = (): TeamServiceLike => {
    const team = lookup<TeamServiceLike>(ctx, "collabTeam");
    if (team === undefined) {
      throw new WorkbenchError("unavailable", "协作身份服务不可用");
    }
    return team;
  };
  return [
    {
      kind: "exact",
      path: "/api/collab/workbench/summary",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const tzOffset = tzOffsetFromRaw(query(request).get("tzOffset"));
          const summary = await service.summary(principal, {
            tzOffsetMinutes: tzOffset,
          });
          sendJson(response, 200, { ok: true, ...summary });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/module",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const params = query(request);
          const moduleId = moduleIdFrom(params.get("moduleId"));
          const tzOffset = tzOffsetFromRaw(params.get("tzOffset"));
          const module = await service.module(principal, moduleId, {
            tzOffsetMinutes: tzOffset,
          });
          sendJson(response, 200, { ok: true, module });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/brief/read",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const parsed = readInputSchema.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            throw new WorkbenchError("invalid_input", "请求内容不合法");
          }
          const marked = await service.markBriefRead(
            principal,
            parsed.data.itemId,
            { tzOffsetMinutes: parsed.data.tzOffset ?? 0 },
          );
          const module = await service.module(principal, "brief", {
            tzOffsetMinutes: parsed.data.tzOffset ?? 0,
          });
          sendJson(response, 200, { ok: true, marked, module });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/brief/stream",
      handler: (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const tzOffset = tzOffsetFromRaw(query(request).get("tzOffset"));
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/event-stream; charset=utf-8",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          response.write(": connected\n\n");
          const unregister = hub.register({
            principal,
            tzOffsetMinutes: tzOffset,
            send: (payload) => {
              if (response.writableEnded) return;
              response.write(`data: ${JSON.stringify(payload)}\n\n`);
            },
            close: () => {
              if (!response.writableEnded) response.end();
            },
          });
          const heartbeat = setInterval(() => {
            if (response.writableEnded) return;
            response.write(": ping\n\n");
          }, 25_000);
          const cleanup = () => {
            clearInterval(heartbeat);
            unregister();
          };
          response.on("close", cleanup);
          response.on("error", cleanup);
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/follows",
      handler: (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = principalFor(request, requireTeam());
          sendJson(response, 200, {
            ok: true,
            follows: service.follows(principal),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/follows/toggle",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = principalFor(request, requireTeam());
          const parsed = followInputSchema.safeParse(
            await readJsonBody(request),
          );
          if (!parsed.success) {
            throw new WorkbenchError("invalid_input", "请求内容不合法");
          }
          const result = await service.toggleFollow(principal, parsed.data);
          sendJson(response, 200, { ok: true, ...result });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/projects",
      handler: (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          sendJson(response, 200, {
            ok: true,
            projects: service.projects(principal),
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/metrics",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const parsed = metricsInputSchema.safeParse(
            await readJsonBody(request),
          );
          if (!parsed.success) {
            throw new WorkbenchError("invalid_input", "最多选择 5 项核心指标");
          }
          const selected = await service.setMetrics(
            principal,
            parsed.data.selected,
          );
          const module = service.metricsModule(principal);
          sendJson(response, 200, { ok: true, selected, module });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workbench/brief/settings",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const principal = scopedPrincipal(request, requireTeam());
          const parsed = briefSettingsInputSchema.safeParse(
            await readJsonBody(request),
          );
          if (!parsed.success) {
            throw new WorkbenchError(
              "invalid_input",
              "手动时间窗口必须指定开始时间",
            );
          }
          const settings = await service.setBriefSettings(
            principal,
            parsed.data,
          );
          const module = await service.module(principal, "brief", {
            tzOffsetMinutes: tzOffsetFromRaw(query(request).get("tzOffset")),
          });
          sendJson(response, 200, { ok: true, settings, module });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
  ];
}

export async function apply(ctx: WorkbenchContext): Promise<void> {
  const domain = await ctx.storageDomain.open(workbenchDomainSpec);
  const service = new WorkbenchService(
    {
      follows: domain.table("follows") as never,
      metrics: domain.table("metrics") as never,
      briefItems: domain.table("brief_items") as never,
      briefReaders: domain.table("brief_readers") as never,
    },
    {
      team: () => lookup(ctx, "collabTeam") as never,
      workspaces: () => lookup(ctx, "workspaceRegistry") as never,
      tasks: () => lookup(ctx, "collabTasks") as never,
      workflows: () => lookup(ctx, "collabWorkflow") as never,
      meetings: () => lookup(ctx, "collabMeeting") as never,
      meetingMinutes: () => lookup(ctx, "collabMeetingMinutes") as never,
      agents: () => lookup(ctx, "collabAgent") as never,
      employees: () => lookup(ctx, "collabEmployee") as never,
      assignments: () => lookup(ctx, "collabAssignment") as never,
      teammates: () => lookup(ctx, "collabTeammates") as never,
    },
  );
  const hub = new BriefPushHub({
    computeBrief: (principal, tzOffsetMinutes) =>
      service.module(principal, "brief", { tzOffsetMinutes }),
    onError: () => undefined,
  });
  ctx.provide("collabWorkbench", service);
  ctx.effect(() => () => void domain.close());
  ctx.effect(() => {
    const disposers = createWorkbenchRoutes(service, ctx, hub).map(
      (route) => ctx.webServer.register(route) as () => void,
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  ctx.effect(() => {
    const triggers = [
      "collab/task-changed",
      "collab/workflow-changed",
      "collab/agent-run-settled",
    ];
    const disposers = triggers
      .map((name) => ctx.on?.(name, () => hub.notify()))
      .filter((dispose): dispose is () => void => typeof dispose === "function");
    return () => {
      for (const dispose of disposers) dispose();
      hub.dispose();
    };
  });
}
