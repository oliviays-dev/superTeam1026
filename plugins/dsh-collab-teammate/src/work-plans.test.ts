import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { Teammate, TeammateAuditEvent, TeammateWorkReport } from "./models.js";
import { createTeammateRoutes, type TeammateWorkReportRuntimeContext } from "./index.js";
import {
  TeammateService,
  type KvTableLike,
  type TeammateActor,
} from "./service.js";
import { WorkReportService } from "./reports.js";
import type { GeneratedWorkReport, WorkReportGenerationContext } from "./report-runtime.js";

function memoryTable<V>(): KvTableLike<V> {
  const values = new Map<string, V>();
  return {
    get: (key) => values.get(key),
    entries: () => values.entries(),
    get size() {
      return values.size;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
  };
}

interface FakeTask {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  priority: string;
  receiverType: string;
  receiverId?: string;
  receiverName?: string;
  description: string;
  due?: string;
  queueSeq?: number;
  needsInput?: boolean;
  autoSubmitReview: boolean;
  createdAt: string;
  updatedAt: string;
}

class FakeResponse {
  status = 0;
  body = "";

  writeHead(status: number): ServerResponse {
    this.status = status;
    return this as unknown as ServerResponse;
  }

  end(body?: string): ServerResponse {
    if (body !== undefined) this.body = body;
    return this as unknown as ServerResponse;
  }

  json<T>(): T {
    return JSON.parse(this.body) as T;
  }
}

function fakeRequest(
  method: string,
  url: string,
  body?: unknown,
): IncomingMessage {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33124",
      authorization: "Bearer token-olivia",
      ...(text === "" ? {} : { "content-type": "application/json" }),
    },
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text);
    },
  } as unknown as IncomingMessage;
}

function setup(options?: {
  ownerUserId?: string;
  report?: GeneratedWorkReport;
  reportError?: Error;
  dispatchError?: string;
}) {
  const teammatesTable = memoryTable<Teammate>();
  const at = new Date("2026-10-01T00:00:00.000Z").toISOString();
  const teammate: Teammate = {
    id: "tm-1",
    source: "personal",
    name: "Researcher",
    role: "供应链研究",
    ownerUserId: options?.ownerUserId ?? "olivia",
    ownerName: "Olivia",
    description: "",
    soul: "",
    scenarios: [],
    goals: [],
    avatar: "",
    state: "active",
    version: "v1.0",
    createdBy: "olivia",
    createdAt: at,
    updatedAt: at,
  };
  void teammatesTable.put(teammate.id, teammate);
  const service = new TeammateService({
    tables: {
      teammates: teammatesTable,
      events: memoryTable(),
    },
  });
  const tasks: FakeTask[] = [];
  const created: unknown[] = [];
  const taskService = {
    list: (workspaceId: string) =>
      tasks.filter((task) => task.workspaceId === workspaceId),
    assign: async () => {
      throw new Error("assign is not used in work plan tests");
    },
    create: async (
      actor: {
        id: string;
        name: string;
        kind: "human";
        role?: TeammateActor["role"];
      },
      input: unknown,
    ) => {
      created.push({ actor, input });
      const value = input as Omit<FakeTask, "id" | "createdAt" | "updatedAt">;
      const task: FakeTask = {
        id: `TSK-${created.length}`,
        ...value,
        createdAt: "2026-10-10T01:00:00.000Z",
        updatedAt: "2026-10-10T01:00:00.000Z",
      };
      tasks.push(task);
      return task;
    },
  };
  const team = {
    resolveToken: () => ({
      userId: "olivia",
      name: "Olivia",
      role: "member" as const,
    }),
    users: () => [{ id: "olivia", name: "Olivia" }],
    members: () => [{ userId: "olivia", memberRole: "owner" as const }],
  };
  const registry = {
    list: () => [
      { id: "ws-main", title: "一切皆插件" },
      { id: "ws-other", title: "其他项目" },
    ],
  };
  const reports = new WorkReportService({
    tables: {
      workReports: memoryTable<TeammateWorkReport>(),
      auditEvents: memoryTable<TeammateAuditEvent>(),
    },
    now: () => new Date("2026-10-10T08:30:00.000Z"),
  });
  const generationContexts: WorkReportGenerationContext[] = [];
  const dispatches: unknown[] = [];
  const reportRuntime = {
    generate: async (context: WorkReportGenerationContext) => {
      generationContexts.push(context);
      if (options?.reportError !== undefined) throw options.reportError;
      return (
        options?.report ?? {
          title: `${context.reportDate} 工作日报`,
          excerpt: "模型结论",
          contentMarkdown: "## 今日结论\n\n模型结论",
          sourceRefs: context.tasks.map((task) => task.id),
        }
      );
    },
  } as unknown as TeammateWorkReportRuntimeContext["runtime"];
  const reportContext: TeammateWorkReportRuntimeContext = {
    reports,
    runtime: reportRuntime,
    workspaces: () => registry,
  };
  const routes = createTeammateRoutes(
    service,
    () => team,
    () => taskService,
    () => registry,
    undefined,
    undefined,
    undefined,
    undefined,
    reportContext,
    () => ({
      dispatch: async (task: FakeTask) => {
        dispatches.push(task);
        if (options?.dispatchError !== undefined) {
          return {
            task: { ...task, status: "progress" },
            execution: { error: options.dispatchError },
          };
        }
        return {
          task: { ...task, status: "progress" },
          execution: { runId: "run-1", status: "queued" },
        };
      },
    }),
  );
  expect(routes.some((route) => route.path.includes("profile-templates"))).toBe(
    false,
  );
  expect(
    routes.some(
      (route) => route.path === "/api/collab/teammates/switch-template",
    ),
  ).toBe(true);
  return {
    routes,
    service,
    tasks,
    created,
    dispatches,
    reports,
    generationContexts,
    registry,
  };
}

async function call(
  routes: ReturnType<typeof setup>["routes"],
  path: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`missing route: ${path}`);
  const response = new FakeResponse();
  await route.handler(
    fakeRequest(method, url, body),
    response as unknown as ServerResponse,
  );
  return {
    status: response.status,
    json: response.json<Record<string, unknown>>(),
  };
}

describe("work plan routes", () => {
  it("parses an instruction into a preview", async () => {
    const context = setup();
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-plans/parse",
      "POST",
      "/api/collab/teammates/work-plans/parse",
      {
        teammateId: "tm-1",
        instruction: "请处理安全库存，9月26日前完成，优先级 P1",
      },
    );
    expect(result.status).toBe(200);
    const parsed = result.json.parsed as Record<string, unknown>;
    expect(parsed.priority).toBe("P1");
    expect(parsed.due).toBe("2026-09-26");
    expect(parsed.workspaceId).toBe("ws-main");
    expect(parsed.workspaces).toHaveLength(2);
  });

  it("creates a planned task for the teammate and writes an audit event", async () => {
    const context = setup();
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-plans",
      "POST",
      "/api/collab/teammates/work-plans",
      {
        teammateId: "tm-1",
        instruction: "请预研供应链例外决策材料，9月26日前输出一页结论。",
        workspaceId: "ws-main",
        priority: "P0",
        due: "2026-09-26",
        autoSubmitReview: true,
      },
    );
    expect(result.status).toBe(200);
    expect(context.created).toHaveLength(1);
    const input = (context.created[0] as { input: Record<string, unknown> })
      .input;
    expect(input.receiverId).toBe("tm-1");
    expect(input.receiverName).toBe("Researcher");
    expect(input.status).toBe("todo");
    expect(input.priority).toBe("P1");
    expect(input.due).toBe("2026-09-26");
    expect(input.description).toContain("预研供应链例外决策材料");
    expect(input.acceptance).toEqual(["按计划说明完成交付"]);
    const actor = (context.created[0] as { actor: Record<string, unknown> })
      .actor;
    expect(actor).toEqual({
      id: "olivia",
      name: "Olivia",
      kind: "human",
      role: "member",
    });
    const audit = context.reports.auditEvents({ teammateId: "tm-1" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.refs?.taskId).toBe("TSK-1");
    // 创建后必须复用任务模块的派发链路：Agent 被唤起、任务进入执行态。
    expect(context.dispatches).toHaveLength(1);
    expect(result.json.execution).toEqual({
      runId: "run-1",
      status: "queued",
    });
    const returned = result.json.task as Record<string, unknown>;
    expect(returned.status).toBe("progress");
  });

  it("keeps the created task when agent dispatch fails", async () => {
    const context = setup({ dispatchError: "Agent 注册表不可用" });
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-plans",
      "POST",
      "/api/collab/teammates/work-plans",
      {
        teammateId: "tm-1",
        instruction: "请整理例外决策材料，明天前给出结论。",
        workspaceId: "ws-main",
        priority: "P2",
      },
    );
    expect(result.status).toBe(200);
    expect(result.json.execution).toEqual({ error: "Agent 注册表不可用" });
    const returned = result.json.task as Record<string, unknown>;
    expect(returned.id).toBe("TSK-1");
    const audit = context.reports.auditEvents({ teammateId: "tm-1" });
    expect(audit.events[0]?.narrative).toContain("Agent 启动失败");
  });

  it("rejects workspaces the caller cannot create tasks in", async () => {
    const context = setup();
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-plans",
      "POST",
      "/api/collab/teammates/work-plans",
      {
        teammateId: "tm-1",
        instruction: "创建计划",
        workspaceId: "ws-forbidden",
        priority: "P2",
      },
    );
    expect(result.status).toBe(403);
    expect(context.created).toHaveLength(0);
  });

  it("rejects invalid input without creating a partial task", async () => {
    const context = setup();
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-plans",
      "POST",
      "/api/collab/teammates/work-plans",
      {
        teammateId: "tm-1",
        instruction: "",
        workspaceId: "ws-main",
        priority: "P9",
      },
    );
    expect(result.status).toBe(400);
    expect(context.created).toHaveLength(0);
  });

  it("lists reports with filters", async () => {
    const context = setup();
    await context.reports.save({
      teammateId: "tm-1",
      reportDate: "2026-10-10",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-10 工作日报",
      contentMarkdown: "## 今日结论\n\n安全库存",
      excerpt: "安全库存",
    });
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-reports",
      "GET",
      "/api/collab/teammates/work-reports?teammateId=tm-1&from=2026-10-01&to=2026-10-10&q=安全",
    );
    expect(result.status).toBe(200);
    const reports = result.json.reports as Array<Record<string, unknown>>;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.contentMarkdown).toContain("安全库存");
    expect(reports[0]?.contentMarkdown).not.toContain("excerpt");
  });

  it("generates a report for the owner and records the audit trail", async () => {
    const context = setup();
    context.tasks.push({
      id: "TSK-9",
      workspaceId: "ws-main",
      title: "安全库存",
      status: "progress",
      priority: "P3",
      receiverType: "agent",
      receiverId: "tm-1",
      description: "分析",
      autoSubmitReview: true,
      createdAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
    });
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-reports/generate",
      "POST",
      "/api/collab/teammates/work-reports/generate",
      { teammateId: "tm-1", reportDate: "2026-10-10" },
    );
    expect(result.status).toBe(200);
    expect(result.json.generation).toBe("llm");
    const report = result.json.report as Record<string, unknown>;
    expect(report.contentMarkdown).toContain("模型结论");
    expect(context.generationContexts[0]?.tasks[0]?.id).toBe("TSK-9");
    const audit = context.reports.auditEvents({ teammateId: "tm-1" });
    expect(audit.events[0]?.actor.type).toBe("ai-teammate");
  });

  it("falls back to a template snapshot when the model fails", async () => {
    const context = setup({ reportError: new Error("model unavailable") });
    context.tasks.push({
      id: "TSK-3",
      workspaceId: "ws-main",
      title: "安全库存",
      status: "done",
      priority: "P3",
      receiverType: "agent",
      receiverId: "tm-1",
      description: "分析",
      autoSubmitReview: true,
      createdAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
    });
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-reports/generate",
      "POST",
      "/api/collab/teammates/work-reports/generate",
      { teammateId: "tm-1" },
    );
    expect(result.status).toBe(200);
    expect(result.json.generation).toBe("fallback");
    const report = result.json.report as Record<string, unknown>;
    expect(report.contentMarkdown).toContain("TSK-3");
    const audit = context.reports.auditEvents({ teammateId: "tm-1" });
    expect(audit.events[0]?.actor.type).toBe("system");
    expect(audit.events[0]?.narrative).toContain("模型生成失败");
  });

  it("rejects report generation from a non-owner", async () => {
    const context = setup({ ownerUserId: "peter" });
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-reports/generate",
      "POST",
      "/api/collab/teammates/work-reports/generate",
      { teammateId: "tm-1" },
    );
    expect(result.status).toBe(403);
  });

  it("groups the work queue by status and flags feedback items", async () => {
    const context = setup();
    const base = {
      workspaceId: "ws-main",
      priority: "P2",
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "Researcher",
      description: "计划说明",
      autoSubmitReview: true,
      createdAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
    };
    context.tasks.push(
      { ...base, id: "TSK-todo", title: "待启动", status: "todo", queueSeq: 1000 },
      { ...base, id: "TSK-review", title: "待确认", status: "review" },
      {
        ...base,
        id: "TSK-feedback",
        title: "待补充",
        status: "progress",
        needsInput: true,
      },
      { ...base, id: "TSK-done", title: "已完成", status: "done" },
    );
    const result = await call(
      context.routes,
      "/api/collab/teammates/work-queue",
      "GET",
      "/api/collab/teammates/work-queue?teammateId=tm-1",
    );
    expect(result.status).toBe(200);
    const queue = result.json.queue as {
      planned: Array<{ id: string; queueState: string }>;
      running: Array<{ id: string; needsInput: boolean }>;
      review: Array<{ id: string }>;
      finished: Array<{ id: string }>;
      counts: Record<string, number>;
      pendingInput: string[];
    };
    expect(queue.planned.map((task) => task.id)).toEqual(["TSK-todo"]);
    expect(queue.planned[0]?.queueState).toBe("idle");
    expect(queue.review.map((task) => task.id)).toEqual(["TSK-review"]);
    expect(queue.running.map((task) => task.id)).toEqual(["TSK-feedback"]);
    expect(queue.running[0]?.needsInput).toBe(true);
    expect(queue.finished.map((task) => task.id)).toEqual(["TSK-done"]);
    expect(queue.pendingInput).toEqual(["TSK-feedback"]);
    expect(queue.counts).toMatchObject({
      planned: 1,
      running: 1,
      review: 1,
      finished: 1,
    });
  });

  it("returns the audit trail with a cursor", async () => {
    const context = setup();
    await context.reports.writeAudit({
      teammateId: "tm-1",
      actor: { type: "user", id: "olivia", name: "Olivia" },
      narrative: "创建工作计划",
    });
    const result = await call(
      context.routes,
      "/api/collab/teammates/audit-events",
      "GET",
      "/api/collab/teammates/audit-events?teammateId=tm-1&limit=10",
    );
    expect(result.status).toBe(200);
    const events = result.json.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.narrative).toBe("创建工作计划");
    expect(result.json.nextCursor).toBeUndefined();
  });
});
