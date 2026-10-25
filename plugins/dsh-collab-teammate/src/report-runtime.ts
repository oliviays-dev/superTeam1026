import { randomUUID } from "node:crypto";
import type { Teammate } from "./models.js";

export interface AgentLike {
  readonly id: string;
  readonly session?: { readonly id?: string };
}

export interface AgentHandleLike {
  readonly agent: AgentLike;
  dispose(): Promise<void>;
}

export interface AgentsRegistryLike {
  create(options: {
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string };
    readonly agentOptions?: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
  }): Promise<AgentHandleLike>;
}

export interface SubagentContentLike {
  readonly type: "text";
  readonly text: string;
}

export interface WorkerResultLike {
  readonly output: readonly SubagentContentLike[];
  readonly stopReason: string;
  readonly diagnostic?: string;
}

export interface WorkerRunLike {
  readonly id: string;
  readonly result: Promise<WorkerResultLike>;
  dispose(): Promise<void>;
}

export interface SubagentsRuntimeLike {
  start(
    name: string,
    spec: {
      readonly label?: string;
      readonly prompt: readonly SubagentContentLike[];
      readonly parent: AgentLike;
      readonly signal: AbortSignal;
      readonly persona?: string;
      readonly toolFilter?: { readonly allow: readonly string[] };
    },
  ): Promise<WorkerRunLike>;
}

export interface AgentDefaultModelLike {
  currentSelection(): {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  };
}

export interface WorkReportTaskContext {
  readonly id: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly workspaceTitle: string;
  readonly status: string;
  readonly priority: string;
  readonly due?: string | undefined;
  readonly latestProgress: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkReportRunContext {
  readonly runId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly status: string;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
}

export interface WorkReportGenerationContext {
  readonly teammate: Pick<
    Teammate,
    "id" | "name" | "role" | "description" | "personaId"
  >;
  readonly reportDate: string;
  readonly tasks: readonly WorkReportTaskContext[];
  readonly runs: readonly WorkReportRunContext[];
}

export interface GeneratedWorkReport {
  readonly title: string;
  readonly excerpt: string;
  readonly contentMarkdown: string;
  readonly sourceRefs: readonly string[];
}

export interface WorkReportRuntimeDeps {
  readonly subagents: () => SubagentsRuntimeLike | undefined;
  readonly agents: () => AgentsRegistryLike | undefined;
  /** 人格服务：日报 worker 也需要读到 teammate 自己的 SOUL。 */
  readonly personas?: () => PersonaServiceLike | undefined;
  readonly defaultModel?: () => AgentDefaultModelLike | undefined;
  readonly provider?: () => string;
  readonly now?: () => Date;
}

export interface PersonaServiceLike {
  get(personaId: string): Promise<unknown>;
}

/** 与 teammate 运行态的 personaId 派生规则保持一致。 */
function personaIdForTeammate(teammateId: string): string {
  return `persona-${teammateId.replace(/[^a-zA-Z0-9._-]/g, "-")}`.slice(0, 120);
}

const REPORT_SECTIONS = [
  "## 今日结论",
  "## 执行记录",
  "## 风险与待确认",
  "## 明日计划",
] as const;

const PRIORITY_LABEL: Record<string, string> = {
  P1: "P0",
  P2: "P1",
  P3: "P2",
};

const STATUS_LABEL: Record<string, string> = {
  todo: "待启动",
  progress: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
};

function priorityLabel(priority: string): string {
  return PRIORITY_LABEL[priority] ?? priority;
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function workerText(result: WorkerResultLike): string {
  return result.output
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function excerptFrom(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const conclusionAt = lines.findIndex(
    (line) => line.replace(/^#+\s*/, "") === "今日结论",
  );
  const body =
    conclusionAt === -1
      ? lines.filter((line) => !line.startsWith("#"))
      : lines
          .slice(conclusionAt + 1)
          .filter((line) => !line.startsWith("#"))
          .slice(0, 1);
  const text = body
    .join(" ")
    .replace(/[*_`>]/g, "")
    .replace(/^[-+]\s+/, "")
    .trim();
  return text.slice(0, 300);
}

function taskLine(task: WorkReportTaskContext): string {
  const due = task.due === undefined ? "无截止日期" : `截止 ${task.due}`;
  const progress =
    task.latestProgress === "" ? "暂无进展" : task.latestProgress.slice(0, 300);
  return `- ${task.id}「${task.title}」｜${statusLabel(task.status)}｜优先级 ${priorityLabel(task.priority)}｜项目 ${task.workspaceTitle}｜${due}｜最新进展：${progress}`;
}

/** 组装日报生成提示词；日期口径与引用全部在服务端完成，模型不自行编造来源。 */
export function buildWorkReportPrompt(
  context: WorkReportGenerationContext,
): string {
  const active = context.tasks.filter(
    (task) => task.status === "progress" || task.status === "review",
  );
  const completed = context.tasks.filter((task) => task.status === "done");
  const planned = context.tasks.filter((task) => task.status === "todo");
  const archived = context.tasks.filter(
    (task) => task.status === "cancelled" || task.status === "archived",
  );
  const runs = context.runs.map((run) => {
    const detail = [
      `${run.taskId}「${run.taskTitle}」(${run.runId})`,
      statusLabel(run.status),
      run.startedAt === undefined ? undefined : `开始 ${run.startedAt}`,
      run.endedAt === undefined ? undefined : `结束 ${run.endedAt}`,
      run.error === undefined ? undefined : `错误：${run.error.slice(0, 200)}`,
      run.summary === undefined
        ? undefined
        : `摘要：${run.summary.slice(0, 300)}`,
    ]
      .filter((item): item is string => item !== undefined)
      .join("｜");
    return `- ${detail}`;
  });
  const lines = (items: readonly string[]): string =>
    items.length > 0 ? items.join("\n") : "- 无";
  return [
    `你是 AI伙伴「${context.teammate.name}」，负责${context.teammate.role || "当前岗位职责"}。`,
    `请基于下面提供的授权上下文，生成 ${context.reportDate} 的工作日报。`,
    "",
    "硬性要求：",
    "1. 只使用给定任务、运行与来源信息，不得编造任务 ID、结论或数据；",
    `2. 必须按以下四级标题输出，标题原样保留：${REPORT_SECTIONS.join("、")}；`,
    "3. 用中文写作，结论具体可执行，每一条结论都要能追溯到任务 ID；",
    "4. 输出 Markdown，不要输出代码块包裹整篇内容。",
    "",
    "## 进行中与待验收",
    lines(active.map(taskLine)),
    "",
    "## 当日已完成",
    lines(completed.map(taskLine)),
    "",
    "## 待启动计划",
    lines(planned.map(taskLine)),
    "",
    "## 已取消 / 归档",
    lines(archived.map(taskLine)),
    "",
    "## 当日运行记录",
    lines(runs),
  ].join("\n");
}

/** 同日期快照的兜底正文，LLM 失败时不覆盖旧快照。 */
export function fallbackWorkReport(
  context: WorkReportGenerationContext,
): GeneratedWorkReport {
  const completed = context.tasks.filter((task) => task.status === "done");
  const active = context.tasks.filter(
    (task) => task.status === "progress" || task.status === "review",
  );
  const planned = context.tasks.filter((task) => task.status === "todo");
  const summary =
    completed.length > 0
      ? `完成 ${completed.length} 项任务：${completed.map((task) => task.id).join("、")}。`
      : active.length > 0
        ? `当日有 ${active.length} 项任务仍在推进，未产生新的完成结论。`
        : "当日没有新的执行结论。";
  const content = [
    "## 今日结论",
    "",
    summary,
    "",
    "## 执行记录",
    "",
    ...(completed.length + active.length > 0
      ? [...completed, ...active].map(taskLine)
      : ["- 今日没有执行记录。"]),
    "",
    "## 风险与待确认",
    "",
    ...(context.runs.some((run) => run.error !== undefined)
      ? context.runs
          .filter((run) => run.error !== undefined)
          .map((run) => `- ${run.taskId} 运行失败：${run.error}`)
      : ["- 暂无需要升级的风险。"]),
    "",
    "## 明日计划",
    "",
    ...(planned.length > 0
      ? planned.map((task) => `- ${task.id} ${task.title}`)
      : ["- 继续跟进当前授权范围内的遗留事项。"]),
  ].join("\n");
  return {
    title: `${context.reportDate} 工作日报`,
    excerpt: summary.slice(0, 300),
    contentMarkdown: content,
    sourceRefs: context.tasks.map((task) => task.id),
  };
}

/**
 * 工作日报生成运行时。
 *
 * 复用会议插件的模型通道：默认模型创建一个宿主 Agent，再用 toolFilter 禁止工具的
 * subagent 执行一次生成；失败向上抛出，由路由决定是否回退模板。
 */
export class WorkReportRuntime {
  private host: Promise<AgentHandleLike> | undefined;

  constructor(private readonly deps: WorkReportRuntimeDeps) {}

  private async hostAgent(): Promise<AgentLike> {
    if (this.host === undefined) {
      const agents = this.deps.agents();
      if (agents === undefined) {
        throw new Error("agent registry is unavailable");
      }
      const model = this.deps.defaultModel?.()?.currentSelection();
      const current = agents
        .create({
          sessionId: randomUUID(),
          meta: { cwd: process.cwd() },
          ...(model === undefined ? {} : { agentOptions: model }),
        })
        .catch((cause: unknown) => {
          if (this.host === current) this.host = undefined;
          throw cause;
        });
      this.host = current;
    }
    return (await this.host).agent;
  }

  private async releaseHost(): Promise<void> {
    const current = this.host;
    this.host = undefined;
    if (current === undefined) return;
    try {
      await (await current).dispose();
    } catch {
      // 宿主清理失败不影响已经落库的日报快照。
    }
  }

  /**
   * 解析 teammate 的人设正文：subagent 的 `persona` 参数是人设文本，
   * 不是 id；日报 worker 也应按该 teammate 的 SOUL 工作。
   */
  private async resolvePersonaSoul(personaId: string): Promise<string> {
    const personas = this.deps.personas?.();
    if (personas === undefined) return "";
    try {
      const persona = await personas.get(personaId);
      if (
        persona !== null &&
        typeof persona === "object" &&
        typeof (persona as { readonly soul?: unknown }).soul === "string"
      ) {
        return (persona as { readonly soul: string }).soul.trim();
      }
    } catch {
      return "";
    }
    return "";
  }

  async generate(
    context: WorkReportGenerationContext,
  ): Promise<GeneratedWorkReport> {
    const subagents = this.deps.subagents();
    if (subagents === undefined) {
      throw new Error("subagent runtime is unavailable");
    }
    const personaSoul = await this.resolvePersonaSoul(
      context.teammate.personaId ?? personaIdForTeammate(context.teammate.id),
    );
    const controller = new AbortController();
    let started: WorkerRunLike | undefined;
    try {
      started = await subagents.start(this.deps.provider?.() ?? "spawn", {
        label: `work-report:${context.teammate.name}`,
        prompt: [{ type: "text", text: buildWorkReportPrompt(context) }],
        parent: await this.hostAgent(),
        ...(personaSoul === "" ? {} : { persona: personaSoul }),
        toolFilter: { allow: [] },
        signal: controller.signal,
      });
      const result = await started.result;
      if (result.stopReason !== "completed") {
        throw new Error(
          result.diagnostic ?? `work report generation stopped: ${result.stopReason}`,
        );
      }
      const markdown = workerText(result);
      if (markdown === "") {
        throw new Error("work report generation returned empty content");
      }
      return {
        title: `${context.reportDate} 工作日报`,
        excerpt: excerptFrom(markdown) || `${context.reportDate} 工作日报`,
        contentMarkdown: markdown,
        sourceRefs: [
          ...context.tasks.map((task) => task.id),
          ...context.runs.map((run) => run.runId),
        ],
      };
    } finally {
      if (started !== undefined) {
        try {
          await started.dispose();
        } catch {
          // Worker cleanup is best effort once the result has settled.
        }
      }
      await this.releaseHost();
    }
  }
}
