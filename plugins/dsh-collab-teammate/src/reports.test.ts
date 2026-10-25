import { describe, expect, it } from "vitest";
import type { TeammateAuditEvent, TeammateWorkReport } from "./models.js";
import {
  compactWorkPlanTitle,
  parseWorkPlanDueDate,
  parseWorkPlanInstruction,
  parseWorkPlanPriority,
  taskPriorityForDisplay,
} from "./plan-parser.js";
import {
  localDateString,
  WorkReportService,
  splitReportKeywords,
  type WorkReportTables,
} from "./reports.js";
import {
  buildWorkReportPrompt,
  fallbackWorkReport,
  WorkReportRuntime,
  type WorkReportGenerationContext,
} from "./report-runtime.js";
import type { KvTableLike } from "./service.js";

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

function reportService(
  now: () => Date = () => new Date("2026-10-10T08:30:00.000Z"),
): WorkReportService {
  const tables: WorkReportTables = {
    workReports: memoryTable<TeammateWorkReport>(),
    auditEvents: memoryTable<TeammateAuditEvent>(),
  };
  return new WorkReportService({ tables, now });
}

describe("work plan parsing", () => {
  it("extracts title, priority, due date and workspace", () => {
    const now = new Date("2026-09-23T09:00:00.000Z");
    const parsed = parseWorkPlanInstruction({
      instruction:
        "请预研供应链例外决策材料，汇总安全库存和关键订单影响，9月26日前输出一页结论。优先级 P1，项目 一切皆插件",
      workspaces: [
        { id: "ws-default", title: "默认项目" },
        { id: "ws-main", title: "一切皆插件" },
      ],
      now,
    });
    expect(parsed.workspaceId).toBe("ws-main");
    expect(parsed.workspaceTitle).toBe("一切皆插件");
    expect(parsed.priority).toBe("P1");
    expect(parsed.due).toBe("2026-09-26");
    expect(parsed.title).toBe(
      "预研供应链例外决策材料，汇总安全库存和关键订单影响，9月26日前输出一页结论",
    );
    expect(parsed.matchedPriority).toBe(true);
    expect(parsed.matchedDue).toBe(true);
    expect(parsed.matchedWorkspace).toBe(true);
  });

  it("falls back to P2 and T+1 with the first accessible workspace", () => {
    const now = new Date("2026-09-23T09:00:00.000Z");
    const parsed = parseWorkPlanInstruction({
      instruction: "推进异常件闭环",
      workspaces: [{ id: "ws-default", title: "默认项目" }],
      now,
    });
    expect(parsed.priority).toBe("P2");
    expect(parsed.due).toBe("2026-09-24");
    expect(parsed.workspaceId).toBe("ws-default");
    expect(parsed.matchedWorkspace).toBe(false);
    expect(parsed.matchedPriority).toBe(false);
    expect(parsed.matchedDue).toBe(false);
  });

  it("supports today, tomorrow and short dates", () => {
    const now = new Date("2026-09-23T09:00:00.000Z");
    expect(parseWorkPlanDueDate("今天完成", now)).toBe("2026-09-23");
    expect(parseWorkPlanDueDate("明天完成", now)).toBe("2026-09-24");
    expect(parseWorkPlanDueDate("后天完成", now)).toBe("2026-09-25");
    expect(parseWorkPlanDueDate("09-28 前", now)).toBe("2026-09-28");
    expect(parseWorkPlanDueDate("没有日期", now)).toBeUndefined();
  });

  it("compacts titles and reads explicit priority", () => {
    expect(compactWorkPlanTitle("请帮我处理异常，优先级 P3。")).toBe(
      "处理异常",
    );
    expect(parseWorkPlanPriority("请按 P0 处理")).toBe("P0");
    expect(parseWorkPlanPriority("没有优先级")).toBeUndefined();
    expect(compactWorkPlanTitle("")).toBe("新的 AI伙伴工作计划");
  });

  it("maps display priorities onto the task storage scale", () => {
    expect(taskPriorityForDisplay("P0")).toBe("P1");
    expect(taskPriorityForDisplay("P1")).toBe("P2");
    expect(taskPriorityForDisplay("P2")).toBe("P3");
    expect(taskPriorityForDisplay("P3")).toBe("P3");
  });
});

describe("work report service", () => {
  it("overwrites the same date snapshot and keeps history intact", async () => {
    let now = new Date("2026-10-10T01:00:00.000Z");
    const service = reportService(() => now);
    const first = await service.save({
      teammateId: "tm-1",
      reportDate: "2026-10-10",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-10 工作日报",
      contentMarkdown: "## 今日结论\n\n第一版",
      excerpt: "第一版",
    });
    now = new Date("2026-10-10T02:00:00.000Z");
    const updated = await service.save({
      teammateId: "tm-1",
      reportDate: "2026-10-10",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-10 工作日报",
      contentMarkdown: "## 今日结论\n\n第二版",
      excerpt: "第二版",
    });
    await service.save({
      teammateId: "tm-1",
      reportDate: "2026-10-09",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-09 工作日报",
      contentMarkdown: "## 今日结论\n\n历史快照",
      excerpt: "历史快照",
    });
    expect(updated.id).toBe(first.id);
    expect(updated.generatedAt).not.toBe(first.generatedAt);
    expect(service.get("tm-1", "2026-10-10")?.contentMarkdown).toContain(
      "第二版",
    );
    expect(service.query({ teammateId: "tm-1" })).toHaveLength(2);
    expect(service.query({ teammateId: "tm-1" })[0]?.reportDate).toBe(
      "2026-10-10",
    );
  });

  it("filters by date range and AND keywords across title, excerpt and body", async () => {
    const service = reportService();
    await service.save({
      teammateId: "tm-1",
      reportDate: "2026-10-10",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-10 工作日报",
      contentMarkdown: "## 执行记录\n\nTSK-1 安全库存分析",
      excerpt: "供应链例外",
    });
    await service.save({
      teammateId: "tm-1",
      reportDate: "2026-10-02",
      author: { type: "ai-teammate", id: "tm-1", name: "Researcher" },
      title: "2026-10-02 工作日报",
      contentMarkdown: "## 执行记录\n\n无",
      excerpt: "常规跟进",
    });
    expect(
      service.query({ teammateId: "tm-1", from: "2026-10-05" }),
    ).toHaveLength(1);
    expect(
      service.query({ teammateId: "tm-1", q: "供应链" }),
    ).toHaveLength(1);
    expect(
      service.query({ teammateId: "tm-1", q: "供应链 TSK-1" }),
    ).toHaveLength(1);
    expect(
      service.query({ teammateId: "tm-1", q: "供应链 不存在" }),
    ).toHaveLength(0);
    expect(service.query({ teammateId: "tm-2" })).toHaveLength(0);
    expect(splitReportKeywords("  A   B ")).toEqual(["a", "b"]);
  });

  it("appends audit events and paginates newest first", async () => {
    let tick = 0;
    const service = reportService(
      () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)),
    );
    for (const index of [1, 2, 3]) {
      await service.writeAudit({
        teammateId: "tm-1",
        actor: { type: "user", id: "olivia", name: "Olivia" },
        narrative: `操作 ${index}`,
      });
    }
    const first = service.auditEvents({ teammateId: "tm-1", limit: 2 });
    expect(first.events.map((event) => event.narrative)).toEqual([
      "操作 3",
      "操作 2",
    ]);
    expect(first.nextCursor).toBe("2");
    const second = service.auditEvents({
      teammateId: "tm-1",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.events.map((event) => event.narrative)).toEqual(["操作 1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("derives a local business date", () => {
    expect(localDateString(new Date(2026, 9, 10, 23, 30))).toBe("2026-10-10");
  });
});

function generationContext(): WorkReportGenerationContext {
  return {
    teammate: {
      id: "tm-1",
      name: "Researcher",
      role: "供应链研究",
      description: "",
    },
    reportDate: "2026-10-10",
    tasks: [
      {
        id: "TSK-1",
        title: "安全库存分析",
        workspaceId: "ws-main",
        workspaceTitle: "一切皆插件",
        status: "done",
        priority: "P3",
        due: "2026-10-10",
        latestProgress: "已输出一页结论",
        createdAt: "2026-10-09T01:00:00.000Z",
        updatedAt: "2026-10-10T01:00:00.000Z",
      },
      {
        id: "TSK-2",
        title: "例外决策材料",
        workspaceId: "ws-main",
        workspaceTitle: "一切皆插件",
        status: "progress",
        priority: "P2",
        latestProgress: "正在汇总关键订单",
        createdAt: "2026-10-10T02:00:00.000Z",
        updatedAt: "2026-10-10T03:00:00.000Z",
      },
    ],
    runs: [
      {
        runId: "run-1",
        taskId: "TSK-2",
        taskTitle: "例外决策材料",
        status: "running",
        startedAt: "2026-10-10T03:00:00.000Z",
      },
    ],
  };
}

describe("work report generation", () => {
  it("builds a grounded prompt with task ids and required sections", () => {
    const prompt = buildWorkReportPrompt(generationContext());
    expect(prompt).toContain("## 今日结论");
    expect(prompt).toContain("## 执行记录");
    expect(prompt).toContain("## 风险与待确认");
    expect(prompt).toContain("## 明日计划");
    expect(prompt).toContain("TSK-1");
    expect(prompt).toContain("run-1");
    expect(prompt).toContain("不得编造任务 ID");
  });

  it("falls back to a template snapshot that keeps task references", () => {
    const fallback = fallbackWorkReport(generationContext());
    expect(fallback.contentMarkdown).toContain("## 今日结论");
    expect(fallback.contentMarkdown).toContain("TSK-1");
    expect(fallback.sourceRefs).toEqual(["TSK-1", "TSK-2"]);
    expect(fallback.excerpt).not.toBe("");
  });

  it("uses the default model through a tool-free subagent run", async () => {
    const created: unknown[] = [];
    const started: unknown[] = [];
    const runtime = new WorkReportRuntime({
      agents: () => ({
        create: async (options) => {
          created.push(options);
          return { agent: { id: "host" }, dispose: async () => undefined };
        },
      }),
      defaultModel: () => ({
        currentSelection: () => ({ provider: "spawn", model: "test-model" }),
      }),
      personas: () => ({
        get: async () => ({ soul: "REPORT-SOUL-BODY" }),
      }),
      subagents: () => ({
        start: async (name, spec) => {
          started.push({ name, spec });
          return {
            id: "worker",
            result: Promise.resolve({
              output: [{ type: "text", text: "## 今日结论\n\n完成 TSK-1。" }],
              stopReason: "completed",
            }),
            dispose: async () => undefined,
          };
        },
      }),
    });
    const generated = await runtime.generate(generationContext());
    expect(generated.contentMarkdown).toContain("完成 TSK-1");
    expect(generated.excerpt).toBe("完成 TSK-1。");
    expect(generated.sourceRefs).toContain("run-1");
    expect(created).toHaveLength(1);
    const run = started[0] as {
      name: string;
      spec: {
        toolFilter?: { allow: readonly string[] };
        persona?: string;
      };
    };
    expect(run.name).toBe("spawn");
    expect(run.spec.toolFilter).toEqual({ allow: [] });
    // 日报 worker 也要带上 teammate 的 SOUL，而不是 personaId。
    expect(run.spec.persona).toBe("REPORT-SOUL-BODY");
  });

  it("rejects non-completed worker runs", async () => {
    const runtime = new WorkReportRuntime({
      agents: () => ({
        create: async () => ({
          agent: { id: "host" },
          dispose: async () => undefined,
        }),
      }),
      subagents: () => ({
        start: async () => ({
          id: "worker",
          result: Promise.resolve({
            output: [],
            stopReason: "failed",
            diagnostic: "model exploded",
          }),
          dispose: async () => undefined,
        }),
      }),
    });
    await expect(runtime.generate(generationContext())).rejects.toThrow(
      "model exploded",
    );
  });
});
