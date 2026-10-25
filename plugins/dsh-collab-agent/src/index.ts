import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  sameOrigin,
  sendJson,
  readJsonBody,
} from "@pluginmax/shared";
import {
  type ExecutionGate,
  type ExecutionPreflightResult,
  type RunEvent,
  type TaskExecutionProjection,
  type TaskExecutionPolicy,
  taskExecutionPolicySchema,
} from "@pluginmax/contracts";
import { z } from "zod";
import {
  AgentExecutionService,
  executionDomainSpec,
  executionToolCategory,
  type ExecutionDomainLike,
  type ExecutionPreflightInput,
  type ExecutionProjection,
} from "./execution.js";
import {
  EXTERNAL_AGENT_PROTOCOLS,
  EXTERNAL_AGENT_PROVIDERS,
  RUNTIME_TOOL_NAMES,
  agentProfileSchema,
  agentRunSchema,
  agentExecutionMetadataSchema,
  externalAgentRuntimeSchema,
  runtimeToolNameSchema,
  type AgentProfile,
  type AgentExecutionMetadata,
  type AgentRun,
  type AgentRunStatus,
  type ExternalAgentRuntime,
  type RuntimeToolName,
} from "./types.js";
import {
  ExternalAgentProcessRunner,
  externalSessionId,
  probeExternalRuntime,
  terminalExternalAgentTrace,
  terminalExternalAgentRuntimeTrace,
  type ExternalAgentRunner,
  type ExternalAgentRuntimeTraceAction,
  type ExternalAgentRuntimeTraceListener,
} from "./external.js";

export type { AgentProfile, AgentRun, ExternalAgentRuntime };

export const name = "dsh-collab-agent";
export const inject = ["storageDomain", "webServer", "agentDefaultModel"];

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  get size(): number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly compatibleVersions?: readonly number[];
  readonly tables: Record<string, { readonly valueSchema: z.ZodType<unknown> }>;
}

export interface AgentDomainLike {
  table(name: "profiles"): KvTableLike<AgentProfile>;
  table(name: "runs"): KvTableLike<AgentRun>;
  table(name: "external_runtimes"): KvTableLike<ExternalAgentRuntime>;
  close(): Promise<void>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

export interface TeamMemberLike {
  readonly userId: string;
  readonly name?: string;
  readonly memberRole?: "owner" | "member" | "guest";
}

export interface TeamServiceLike {
  resolveToken(token: string):
    | {
        readonly userId: string;
        readonly role: "admin" | "owner" | "member" | "guest";
      }
    | undefined;
  members(workspaceId: string): readonly TeamMemberLike[];
}

export interface PersonaServiceLike {
  get(personaId: string): Promise<unknown>;
}

export interface AgentHandleLike {
  readonly agent: unknown;
  dispose(): Promise<void>;
}

export interface AgentSetupContextLike {
  readonly tools?: {
    restrict(filter: { readonly allow: readonly string[] }): void;
    get(name: string): unknown;
  };
  get?(key: "agentPresets"):
    | {
        mount(agentCtx: AgentSetupContextLike, presetId: string): Promise<void>;
      }
    | undefined;
  get?(key: "systemPrompt"):
    | {
        section(section: {
          readonly name: string;
          readonly order: number;
          readonly text: string;
        }): unknown;
        getSectionOrder?(name: string): number;
      }
    | undefined;
}

export interface AgentsRegistryLike {
  get?(sessionId: string): unknown;
  create(options: {
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string };
    readonly setup?: (agentCtx: AgentSetupContextLike) => Promise<void> | void;
    readonly agentOptions?: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
  }): Promise<AgentHandleLike>;
  resume?(options: {
    readonly resumeSessionId: string;
    readonly setup?: (agentCtx: AgentSetupContextLike) => Promise<void> | void;
    readonly agentOptions?: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
  }): Promise<AgentHandleLike>;
}

export interface AgentDefaultModelLike {
  currentSelection(): {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  };
}

export interface AgentSessionLike {
  readonly id: string;
  snapshotEvents(): readonly AgentSessionEventLike[];
}

export interface AgentSessionEventLike {
  readonly type: string;
  /** Unix epoch milliseconds. */
  readonly time?: number | undefined;
  readonly data?: unknown;
}

export interface AgentRunProgress {
  readonly text: string;
  readonly updatedAt: string;
}

export interface AgentRunProgress {
  readonly text: string;
  readonly updatedAt: string;
}

export interface AgentSessionsLike {
  get(sessionId: string): AgentSessionLike | undefined;
}

export interface AgentSessionPersistenceLike {
  stat(sessionId: string): Promise<unknown | undefined>;
  open?(
    sessionId: string,
    access: "read",
  ): Promise<{
    read(): Promise<readonly AgentSessionEventLike[]>;
    close(): Promise<void>;
  }>;
}

export interface AgentLike {
  readonly session: AgentSessionLike;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel?(reason: unknown): void;
}

export interface AgentSessionTitleLike {
  get?(session: AgentSessionLike): { readonly title: string } | undefined;
  rename(session: AgentSessionLike, title: string): unknown;
}

export interface WorkspaceLike {
  readonly path: string;
  attachSession(sessionId: string): Promise<void>;
  detachSession?(sessionId: string): Promise<void>;
}

export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>;
  get?(id: string): WorkspaceLike | undefined;
}

export interface SubagentRunLike {
  readonly id: string;
  readonly result: Promise<SubagentResultLike>;
  dispose(): Promise<void>;
}

export interface SubagentResultLike {
  readonly output?: ReadonlyArray<unknown>;
  readonly stopReason: string;
  readonly diagnostic?: string;
}

function subagentOutputText(result: SubagentResultLike): string {
  if (!Array.isArray(result.output)) return "";
  return result.output
    .filter(
      (block): block is { readonly text: string } =>
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function normalizeExecutionMetadata(
  metadata: Partial<AgentExecutionMetadata>,
): AgentExecutionMetadata {
  return agentExecutionMetadataSchema.parse(metadata);
}

function taskSessionId(run: AgentRun): string {
  if (run.sessionId !== undefined) {
    return run.sessionId;
  }
  // 一个「任务 + AI 执行者」对应左侧一条独立会话，重跑同一任务复用同一条。
  // 任务重置执行会话后代数 +1，下一次执行换一条全新会话。
  const epoch = run.payload.context.taskSessionEpoch;
  const generation =
    typeof epoch === "string" && epoch !== "" && epoch !== "0"
      ? `-r${epoch}`
      : "";
  const scope =
    run.source === "chat"
      ? String(run.payload.context.chatChannelId ?? run.instanceId)
      : run.source === "workflow"
        ? `${String(run.payload.context.workflowTaskId ?? run.instanceId)}-${run.nodeId}`
        : run.instanceId;
  const prefix = run.source === "chat" ? "de-chat" : "de-task";
  if (run.source === "meeting") {
    return `de-meeting-${scope}-${run.employeeId ?? run.agentProfileId}`
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 200);
  }
  return `${prefix}-${scope}-${run.employeeId ?? run.agentProfileId}${generation}`
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 200);
}

function desiredTaskSessionTitle(run: AgentRun): string {
  const employeeName =
    typeof run.payload.context.employeeName === "string" &&
    run.payload.context.employeeName.trim() !== ""
      ? run.payload.context.employeeName.trim()
      : run.payload.profileName.replace(/\s+runtime$/i, "");
  // Session 名称：执行人（AI Teammate）-TSK-任务名称-任务号后4位。
  // 执行人名保留原文空格，和任务管理的显示完全一致；任务名仍压缩空白。
  const compact = (value: string): string => value.replace(/\s+/g, "");
  const taskKey =
    (typeof run.payload.context.workflowTaskId === "string"
      ? run.payload.context.workflowTaskId
      : run.instanceId
    )
      .split("-")
      .at(-1) ?? run.id;
  if (run.source === "chat") {
    return [
      employeeName,
      "AI对话",
      compact(run.payload.instanceTitle),
      taskKey.slice(-4),
    ]
      .filter((part) => part !== "")
      .join("-")
      .slice(0, 120);
  }
  return [
    employeeName,
    "TSK",
    compact(run.payload.instanceTitle),
    taskKey.slice(-4),
  ]
    .filter((part) => part !== "")
    .join("-")
    .slice(0, 120);
}

function taskUserMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/**
 * 会话产物已经不在磁盘上时的失败特征。
 * DSH 的 jsonl 持久化只在创建会话时建目录，之后是 `open(path, 'a')`：
 * 目录/文件被外部清掉后，恢复会话与后续落盘都会以 ENOENT / not-found 失败。
 */
function isMissingSessionArtifact(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ((cause as { readonly code?: unknown }).code === "ENOENT") return true;
  const name = String((cause as { readonly name?: unknown }).name ?? "");
  if (name === "SessionPersistenceNotFoundError") return true;
  const message = cause instanceof Error ? cause.message : "";
  return (
    /session/i.test(message) &&
    /ENOENT|no such file or directory|not found/i.test(message)
  );
}

function lastAssistantText(session: AgentSessionLike, since = 0): string {
  for (const event of session.snapshotEvents().slice(since).reverse()) {
    if (event.type !== "assistant/message") continue;
    const data = event.data as
      | {
          readonly message?: {
            readonly content?: readonly unknown[];
          };
        }
      | undefined;
    const content = data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .flatMap((block) => {
        if (
          typeof block !== "object" ||
          block === null ||
          !("type" in block) ||
          !("text" in block) ||
          block.type !== "text" ||
          typeof block.text !== "string"
        ) {
          return [];
        }
        return [block.text];
      })
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

function assistantOutputTokens(
  session: AgentSessionLike,
  startedAt: string | undefined,
  endedAt: string,
): number | undefined {
  const start = startedAt === undefined ? undefined : Date.parse(startedAt);
  const end = Date.parse(endedAt);
  let total = 0;
  let found = false;
  for (const event of session.snapshotEvents()) {
    if (event.type !== "assistant/message") continue;
    if (
      typeof event.time === "number" &&
      Number.isFinite(event.time) &&
      ((start !== undefined && event.time < start) ||
        (Number.isFinite(end) && event.time > end))
    ) {
      continue;
    }
    const data = event.data as
      | {
          readonly usage?: {
            readonly outputTokens?: unknown;
          };
        }
      | undefined;
    const value = data?.usage?.outputTokens;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    found = true;
    total += Math.trunc(value);
  }
  return found ? total : undefined;
}

export function deliveryReportIssues(
  output: string,
  payload: AgentRun["payload"],
): string[] {
  const issues: string[] = [];
  if (!/^#\s*交付报告\s*$/m.test(output)) {
    issues.push("缺少一级标题「# 交付报告」");
  }
  const match = /^##\s*交付说明\s*$/m.exec(output);
  if (match === null) {
    issues.push("缺少二级标题「## 交付说明」");
  } else {
    const body = output.slice(match.index + match[0].length).trim();
    if (body === "") {
      issues.push("「交付说明」不能为空");
    } else {
      const required = payload.deliverables.find(
        (item) => item.required && item.type === "text",
      );
      if (
        required?.minTextLength !== undefined &&
        body.length < required.minTextLength
      ) {
        issues.push(
          `「交付说明」不足 ${required.minTextLength} 字（当前 ${body.length} 字）`,
        );
      }
    }
  }
  return issues;
}

function buildRepairPrompt(
  run: AgentRun,
  rawOutput: string,
  issues: readonly string[],
): string {
  return [
    "# Task Worker 输出修复",
    "",
    "你上一次最终回复没有满足工作流交付契约。请重新处理同一个任务，",
    "不要解释修复过程，直接输出符合格式的最终交付报告。",
    "",
    "## 缺陷",
    ...issues.map((issue, index) => `${index + 1}. ${issue}`),
    "",
    "## 输出格式",
    "# 交付报告",
    "",
    "## 交付说明",
    "<完整交付正文；不要省略标题，不要把正文放在代码块中>",
    "",
    "## 上一次输出",
    "<delimiters>",
    rawOutput.slice(0, 40_000),
    "</delimiters>",
  ].join("\n");
}

export interface SubagentsRuntimeLike {
  start(
    name: string,
    spec: {
      readonly label?: string;
      readonly prompt: ReadonlyArray<{ type: "text"; text: string }>;
      readonly parent: unknown;
      readonly persona?: string;
      readonly toolFilter?: { readonly allow: readonly string[] };
      readonly signal: AbortSignal;
    },
  ): Promise<SubagentRunLike>;
}

async function awaitSubagentResult(
  started: SubagentRunLike,
  signal: AbortSignal,
): Promise<SubagentResultLike> {
  return await new Promise<Awaited<SubagentRunLike["result"]>>(
    (resolve, reject) => {
      let finished = false;
      const onAbort = () => {
        if (finished) return;
        finished = true;
        reject(new Error("worker aborted"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      started.result
        .then((value) => {
          if (!finished) {
            finished = true;
            resolve(value);
          }
        })
        .catch((cause: unknown) => {
          if (!finished) {
            finished = true;
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          }
        })
        .finally(() => signal.removeEventListener("abort", onAbort));
    },
  );
}

export interface AgentActor {
  readonly kind: "user";
  readonly id: string;
  readonly name?: string | undefined;
  readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
  readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
  readonly workspaceId?: string | undefined;
}

export class AgentError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "method_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentDispatchInput {
  readonly workspaceId: string;
  readonly workspacePath?: string | undefined;
  readonly profileId: string;
  readonly source: "workflow" | "task" | "meeting" | "chat";
  readonly instanceId: string;
  readonly nodeId: string;
  readonly dispatchKey: string;
  readonly trigger: "manual-dispatch" | "auto-on-ready";
  readonly attempt: number;
  readonly runSeq: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly personaId?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly principalType?:
    "transitional-agent" | "digital-employee" | "principal-runtime" | undefined;
  readonly ticketId?: string | undefined;
  readonly contextPackId?: string | undefined;
  readonly sessionBindingId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly executionPolicy?: TaskExecutionPolicy | undefined;
  readonly payload: AgentRun["payload"];
  readonly createdBy: string;
}

export interface AgentWorkflowHandler {
  onSettled(run: AgentRun): Promise<void> | void;
}

export interface AgentTaskHandler {
  onSettled(run: AgentRun): Promise<void> | void;
}

const ACTIVE_RUN_STATUSES: readonly AgentRunStatus[] = [
  "queued",
  "running",
  "waiting_input",
];
const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = [
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
];

function iso(date: Date): string {
  return date.toISOString();
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AgentError("invalid_input", "invalid request payload");
  }
  return result.data;
}

function isManager(actor: AgentActor): boolean {
  return actor.globalRole === "admin" || actor.workspaceRole === "owner";
}

function values<V>(table: KvTableLike<V>): V[] {
  return [...table.entries()].map(([, value]) => value);
}

export const agentDomainSpec = {
  name: "collab_agent",
  version: 1,
  tables: {
    profiles: {
      valueSchema: agentProfileSchema as unknown as z.ZodType<unknown>,
    },
    runs: {
      valueSchema: agentRunSchema as unknown as z.ZodType<unknown>,
    },
    external_runtimes: {
      valueSchema: externalAgentRuntimeSchema as unknown as z.ZodType<unknown>,
    },
  },
} as const;

const EXTERNAL_RUNTIME_STATUS_LABEL: Record<
  ExternalAgentRuntime["status"],
  string
> = {
  active: "启用",
  disabled: "停用",
  archived: "已归档",
};

const EXTERNAL_RUNTIME_STATUS_TRANSITIONS: Record<
  ExternalAgentRuntime["status"],
  readonly ExternalAgentRuntime["status"][]
> = {
  active: ["active", "disabled", "archived"],
  disabled: ["active", "disabled", "archived"],
  // 归档为终态：只能通过 restore 复原回停用，常规 update 不放行。
  archived: ["archived"],
};

export class ExternalAgentRuntimeService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly table: KvTableLike<ExternalAgentRuntime>,
    private readonly deps: {
      readonly now?: () => Date;
      readonly onTrace?: ExternalAgentRuntimeTraceListener | undefined;
    } = {},
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private trace(
    action: ExternalAgentRuntimeTraceAction,
    runtime: ExternalAgentRuntime,
    options: {
      readonly actorUserId?: string | undefined;
      readonly previousStatus?: ExternalAgentRuntime["status"] | undefined;
      readonly message?: string | undefined;
      readonly fields?: Readonly<Record<string, unknown>> | undefined;
    } = {},
  ): void {
    try {
      this.deps.onTrace?.({
        action,
        runtime,
        ...options,
      });
    } catch {
      // Audit output must never change the result of a runtime operation.
    }
  }

  /**
   * 默认只返回可用运行时（启用/停用）；归档是终态视图，
   * 由 includeArchived 显式请求，避免归档项污染常规选择与列表。
   */
  list(
    workspaceId?: string,
    options?: { readonly includeArchived?: boolean | undefined },
  ): ExternalAgentRuntime[] {
    return values(this.table)
      .filter(
        (runtime) =>
          (options?.includeArchived === true ||
            runtime.status !== "archived") &&
          (workspaceId === undefined ||
            runtime.visibility === "platform" ||
            runtime.workspaceId === undefined ||
            runtime.workspaceId === workspaceId),
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, "zh-Hans-CN") ||
          left.id.localeCompare(right.id),
      );
  }

  get(runtimeId: string): ExternalAgentRuntime | undefined {
    return this.table.get(runtimeId);
  }

  private require(runtimeId: string): ExternalAgentRuntime {
    const runtime = this.get(runtimeId);
    if (runtime === undefined)
      throw new AgentError("not_found", "外部 Agent 运行时不存在");
    return runtime;
  }

  /**
   * 状态流转：启用/停用可互切，归档可从两者进入；归档为终态，
   * 只能先复原回停用，再按常规流程启用（与 Teammate 模版归档口径一致）。
   */
  private assertTransition(
    current: ExternalAgentRuntime,
    next: ExternalAgentRuntime["status"],
  ): void {
    if (EXTERNAL_RUNTIME_STATUS_TRANSITIONS[current.status].includes(next))
      return;
    if (current.status === "archived") {
      throw new AgentError(
        "conflict",
        "外部 Agent 运行时已归档，请先复原为停用状态后再启用",
      );
    }
    throw new AgentError(
      "conflict",
      `外部 Agent 运行时不能从「${EXTERNAL_RUNTIME_STATUS_LABEL[current.status]}」变更为「${EXTERNAL_RUNTIME_STATUS_LABEL[next]}」`,
    );
  }

  /** 探测等管理动作统一入口：校验权限并拒绝已归档运行时。 */
  requireForManagement(
    runtimeId: string,
    actor: AgentActor,
  ): ExternalAgentRuntime {
    const runtime = this.require(runtimeId);
    this.assertCanManage(runtime, actor);
    if (runtime.status === "archived") {
      throw new AgentError(
        "conflict",
        "外部 Agent 运行时已归档，请先复原后再操作",
      );
    }
    return runtime;
  }

  private assertCanManage(
    runtime: ExternalAgentRuntime,
    actor: AgentActor,
  ): void {
    if (actor.globalRole === "admin") return;
    if (
      runtime.workspaceId !== undefined &&
      runtime.workspaceId === actor.workspaceId &&
      actor.workspaceRole === "owner"
    )
      return;
    throw new AgentError(
      "forbidden",
      "平台或项目 Owner/Admin 才能管理外部 Agent 运行时",
    );
  }

  create(
    actor: AgentActor,
    input: {
      readonly workspaceId?: string | undefined;
      readonly id?: string | undefined;
      readonly name: string;
      readonly provider: ExternalAgentRuntime["provider"];
      readonly protocol: ExternalAgentRuntime["protocol"];
      readonly command: string;
      readonly args?: readonly string[] | undefined;
      readonly customArgs?: readonly string[] | undefined;
      readonly supportedTools?: readonly RuntimeToolName[] | undefined;
      readonly supportedModels?: readonly string[] | undefined;
      readonly defaultModel?: string | undefined;
      readonly contextWindowTokens?: number | undefined;
      readonly status?: ExternalAgentRuntime["status"] | undefined;
      readonly visibility?: ExternalAgentRuntime["visibility"] | undefined;
    },
  ): Promise<ExternalAgentRuntime> {
    this.assertCanManage(
      {
        id: input.id ?? "__new__",
        name: input.name,
        provider: input.provider,
        protocol: input.protocol,
        command: input.command,
        args: [],
        customArgs: [],
        supportedTools: [],
        supportedModels: [],
        contextWindowTokens: input.contextWindowTokens,
        status: input.status ?? "active",
        visibility: input.visibility ?? "platform",
        ownerUserId: actor.id,
        ...(input.workspaceId === undefined
          ? {}
          : { workspaceId: input.workspaceId }),
        createdAt: iso(this.now()),
        updatedAt: iso(this.now()),
      },
      actor,
    );
    return this.enqueue(async () => {
      const timestamp = iso(this.now());
      const id = input.id?.trim() || `ext-${randomUUID().slice(0, 8)}`;
      if (this.table.get(id) !== undefined)
        throw new AgentError("conflict", "外部 Agent 运行时已存在");
      const record = parseOrInvalid(externalAgentRuntimeSchema, {
        ...input,
        id,
        ownerUserId: actor.id,
        status: input.status ?? "active",
        visibility: input.visibility ?? "platform",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.table.put(record.id, record);
      this.trace("register", record, {
        actorUserId: actor.id,
        message: "外部 Agent 运行时已注册",
        fields: {
          command: record.command,
          argsCount: record.args.length,
          customArgsCount: (record.customArgs ?? []).length,
          supportedTools: (record.supportedTools ?? []).join(","),
          supportedModels: (record.supportedModels ?? []).join(","),
          defaultModel: record.defaultModel,
          contextWindowTokens: record.contextWindowTokens,
          visibility: record.visibility,
        },
      });
      return record;
    });
  }

  update(
    actor: AgentActor,
    input: {
      readonly runtimeId: string;
      readonly name?: string | undefined;
      readonly provider?: ExternalAgentRuntime["provider"] | undefined;
      readonly protocol?: ExternalAgentRuntime["protocol"] | undefined;
      readonly command?: string | undefined;
      readonly args?: readonly string[] | undefined;
      readonly customArgs?: readonly string[] | undefined;
      readonly supportedTools?: readonly RuntimeToolName[] | undefined;
      readonly supportedModels?: readonly string[] | undefined;
      readonly defaultModel?: string | null | undefined;
      readonly contextWindowTokens?: number | null | undefined;
      readonly status?: ExternalAgentRuntime["status"] | undefined;
    },
  ): Promise<ExternalAgentRuntime> {
    return this.enqueue(async () => {
      const current = this.require(input.runtimeId);
      this.assertCanManage(current, actor);
      if (input.status !== undefined) {
        this.assertTransition(current, input.status);
      }
      const commandChanged =
        input.command !== undefined && input.command !== current.command;
      const argsChanged =
        input.args !== undefined &&
        (input.args.length !== current.args.length ||
          input.args.some((arg, index) => arg !== current.args[index]));
      const customArgsChanged =
        input.customArgs !== undefined &&
        (input.customArgs.length !== (current.customArgs ?? []).length ||
          input.customArgs.some(
            (arg, index) => arg !== (current.customArgs ?? [])[index],
          ));
      const changedFields = [
        input.name !== undefined && input.name !== current.name ? "name" : "",
        input.provider !== undefined && input.provider !== current.provider
          ? "provider"
          : "",
        input.protocol !== undefined && input.protocol !== current.protocol
          ? "protocol"
          : "",
        commandChanged ? "command" : "",
        argsChanged ? "args" : "",
        customArgsChanged ? "customArgs" : "",
        input.supportedTools !== undefined &&
        (input.supportedTools.length !==
          (current.supportedTools ?? []).length ||
          input.supportedTools.some(
            (tool, index) => tool !== (current.supportedTools ?? [])[index],
          ))
          ? "supportedTools"
          : "",
        input.supportedModels !== undefined &&
        (input.supportedModels.length !==
          (current.supportedModels ?? []).length ||
          input.supportedModels.some(
            (model, index) => model !== (current.supportedModels ?? [])[index],
          ))
          ? "supportedModels"
          : "",
        input.defaultModel !== undefined &&
        (input.defaultModel ?? undefined) !== current.defaultModel
          ? "defaultModel"
          : "",
        input.contextWindowTokens !== undefined &&
        (input.contextWindowTokens ?? undefined) !== current.contextWindowTokens
          ? "contextWindowTokens"
          : "",
        input.status !== undefined && input.status !== current.status
          ? "status"
          : "",
      ].filter((field) => field !== "");
      const next = parseOrInvalid(externalAgentRuntimeSchema, {
        ...current,
        name: input.name ?? current.name,
        provider: input.provider ?? current.provider,
        protocol: input.protocol ?? current.protocol,
        command: input.command ?? current.command,
        args: input.args ?? current.args,
        customArgs: input.customArgs ?? current.customArgs ?? [],
        supportedTools: input.supportedTools ?? current.supportedTools ?? [],
        supportedModels: input.supportedModels ?? current.supportedModels ?? [],
        defaultModel:
          input.defaultModel === null
            ? undefined
            : (input.defaultModel ?? current.defaultModel),
        contextWindowTokens:
          input.contextWindowTokens === null
            ? undefined
            : (input.contextWindowTokens ?? current.contextWindowTokens),
        status: input.status ?? current.status,
        updatedAt: iso(this.now()),
        ...(commandChanged || argsChanged || customArgsChanged
          ? {
              lastProbeAt: undefined,
              lastProbeOk: undefined,
              lastProbeMessage: undefined,
            }
          : {}),
      });
      await this.table.put(next.id, next);
      const action: ExternalAgentRuntimeTraceAction =
        current.status !== next.status
          ? next.status === "active"
            ? "enable"
            : next.status === "disabled"
              ? "disable"
              : "update"
          : "update";
      this.trace(action, next, {
        actorUserId: actor.id,
        previousStatus: current.status,
        message:
          action === "update" ? "外部 Agent 运行时定义已更新" : undefined,
        fields: {
          changed:
            changedFields.length === 0 ? "none" : changedFields.join(","),
          command: next.command,
          argsCount: next.args.length,
          customArgsCount: (next.customArgs ?? []).length,
          supportedTools: (next.supportedTools ?? []).join(","),
          supportedModels: (next.supportedModels ?? []).join(","),
          defaultModel: next.defaultModel,
          contextWindowTokens: next.contextWindowTokens,
        },
      });
      return next;
    });
  }

  archive(
    actor: AgentActor,
    input: { readonly runtimeId: string },
  ): Promise<ExternalAgentRuntime> {
    return this.enqueue(async () => {
      const current = this.require(input.runtimeId);
      this.assertCanManage(current, actor);
      if (current.status === "archived") return current;
      const next = parseOrInvalid(externalAgentRuntimeSchema, {
        ...current,
        status: "archived",
        updatedAt: iso(this.now()),
      });
      await this.table.put(next.id, next);
      this.trace("archive", next, {
        actorUserId: actor.id,
        previousStatus: current.status,
        message: "外部 Agent 运行时已归档",
      });
      return next;
    });
  }

  /** 复原：归档 → 停用，不直接生效，避免误把旧绑定当可用运行时派发。 */
  restore(
    actor: AgentActor,
    input: { readonly runtimeId: string },
  ): Promise<ExternalAgentRuntime> {
    return this.enqueue(async () => {
      const current = this.require(input.runtimeId);
      this.assertCanManage(current, actor);
      if (current.status !== "archived") {
        throw new AgentError(
          "conflict",
          "只有已归档的外部 Agent 运行时才能复原",
        );
      }
      const next = parseOrInvalid(externalAgentRuntimeSchema, {
        ...current,
        status: "disabled",
        updatedAt: iso(this.now()),
      });
      await this.table.put(next.id, next);
      this.trace("restore", next, {
        actorUserId: actor.id,
        previousStatus: current.status,
        message: "外部 Agent 运行时已复原为停用",
      });
      return next;
    });
  }

  markProbe(
    runtimeId: string,
    result: {
      readonly ok: boolean;
      readonly message: string;
      readonly command?: string | undefined;
      readonly args?: readonly string[] | undefined;
      readonly exitCode?: number | null | undefined;
      readonly durationMs?: number | undefined;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
    },
    actor?: AgentActor,
  ): Promise<ExternalAgentRuntime | undefined> {
    return this.enqueue(async () => {
      const current = this.get(runtimeId);
      if (current === undefined) return undefined;
      const next = parseOrInvalid(externalAgentRuntimeSchema, {
        ...current,
        lastProbeAt: iso(this.now()),
        lastProbeOk: result.ok,
        lastProbeMessage: result.message.slice(0, 500),
        updatedAt: iso(this.now()),
      });
      await this.table.put(next.id, next);
      this.trace("probe", next, {
        actorUserId: actor?.id,
        previousStatus: current.status,
        message: result.ok
          ? "外部 Agent 运行时探测通过"
          : "外部 Agent 运行时探测失败",
        fields: {
          ok: result.ok,
          command: result.command ?? next.command,
          probe: result.message,
          exit: result.exitCode,
          durationMs: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      });
      return next;
    });
  }
}

/**
 * 派发失败原因要能直接指导用户：不存在 / 已停用 / 已归档三态分开，
 * 并给出「启用、改绑或切回内置执行」的可执行下一步。
 */
function externalRuntimeUnavailableReason(
  runtime: ExternalAgentRuntime | undefined,
): string {
  if (runtime === undefined) {
    return "外部 Agent 运行时不存在，请在 AI伙伴 > 外部 Agent 中重新选择运行时";
  }
  if (runtime.status === "archived") {
    return `外部 Agent 运行时「${runtime.name}」已归档，请复原或改绑其他运行时`;
  }
  return `外部 Agent 运行时「${runtime.name}」已停用，请启用后重试或切换为内置执行`;
}

function buildPrompt(run: AgentRun, profile: AgentProfile): string {
  const payload = run.payload;
  const contextLines = Object.entries(payload.context).map(
    ([key, value]) => `- ${key} = ${String(value)}`,
  );
  const deliverableLines = payload.deliverables.map((item, index) => {
    const flags = [
      item.required ? "必交" : "选交",
      item.type,
      item.minTextLength === undefined
        ? undefined
        : `最少 ${item.minTextLength} 字`,
    ]
      .filter(Boolean)
      .join(" · ");
    const description = item.description === "" ? "" : `：${item.description}`;
    return `${index + 1}. ${item.title}（${flags}）${description}`;
  });
  const hasRequiredText = payload.deliverables.some(
    (item) => item.required && item.type === "text",
  );
  const previousFailure = payload.previousFailure?.trim() ?? "";
  if (run.source === "chat") {
    const instruction =
      typeof payload.context.instruction === "string"
        ? payload.context.instruction.trim()
        : "";
    const transcript =
      typeof payload.context.transcript === "string"
        ? payload.context.transcript.trim()
        : "";
    return [
      "# AI伙伴一对一对话",
      "",
      "你正在与当前用户进行私密的一对一对话。只处理当前对话，不要读取或描述其他会议、其他用户私聊或未显式带入的任务上下文。",
      "",
      ...(transcript === "" ? [] : ["## 最近对话", transcript, ""]),
      "## 当前用户消息",
      instruction === "" ? payload.nodeDescription.trim() : instruction,
      "",
      "直接回复用户，不要输出会议纪要、任务交付报告或执行计划。",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
  if (run.source === "meeting") {
    // 会议纪要：固定输出口径，会议级额外要求走「本次嘱咐」（context.brief）。
    const transcript =
      typeof payload.context.transcript === "string"
        ? payload.context.transcript
        : "";
    const brief =
      typeof payload.context.brief === "string"
        ? payload.context.brief.trim()
        : "";
    const meetingFiles =
      typeof payload.context.files === "string"
        ? payload.context.files.trim()
        : "";
    const agenda = payload.nodeDescription.trim();
    return [
      "# DSH Pluginmax 会议 Facilitator",
      "",
      `会议：${payload.instanceTitle}`,
      agenda === "" ? "" : `议程：${agenda}`,
      "",
      "## 会议记录",
      transcript.trim() === "" ? "（暂无对话）" : transcript,
      "",
      ...(meetingFiles === "" ? [] : ["## 会议文件", meetingFiles, ""]),
      ...(brief === "" ? [] : ["## 本次嘱咐", brief, ""]),
      "## 输出要求",
      "用中文 Markdown 输出一份结构化会议纪要，且只包含以下小节（顺序固定，标题原样保留）：",
      "## 结论",
      "## 决策",
      "## 行动项",
      "## 风险",
      "## 待确认",
      "- 只输出纪要正文本身：不要输出思考过程、推理句、英文或客套话。",
      "- 你没有可调用的工具；需要的信息只来自上面的会议记录与会议文件，不要尝试执行命令或搜索文件。",
      "- 每个小节用简洁的要点列表；该小节没有内容时写「无」。",
      "- 行动项尽量写清负责人与时间点；无法确定的放入「待确认」，不要编造。",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
  if (run.source === "task") {
    const instruction =
      typeof payload.context.instruction === "string"
        ? payload.context.instruction.trim()
        : "";
    const acceptance =
      typeof payload.context.acceptance === "string"
        ? payload.context.acceptance
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    if (instruction !== "") return instruction;
    return [
      payload.nodeDescription.trim() || payload.instanceTitle,
      ...(acceptance.length === 0
        ? []
        : [
            "",
            "验收标准：",
            ...acceptance.map((item, index) => `${index + 1}. ${item}`),
          ]),
    ].join("\n");
  }
  return [
    "# DSH Pluginmax 工作流 Task Worker",
    "",
    "你是当前工作流节点的任务执行者：只处理当前节点内容，不进入会议，不与主会话对话。",
    "",
    "## 任务",
    `完成节点「${payload.nodeName}」的工作并输出可审核的结果。`,
    ...(payload.nodeDescription === "" ? [] : ["", payload.nodeDescription]),
    ...(previousFailure === ""
      ? []
      : [
          "",
          "## 上一轮反馈",
          previousFailure,
          "",
          "请逐条修正上述失败或审核不通过的问题；不要重复同类错误。",
        ]),
    "",
    "## 上下文",
    `- 工作流实例：${payload.instanceTitle}`,
    `- 节点：${payload.nodeName}`,
    ...(payload.responsibleId === undefined
      ? []
      : [`- 责任人：${payload.responsibleId}`]),
    ...(contextLines.length === 0 ? [] : ["- 上下文变量：", ...contextLines]),
    "",
    ...(deliverableLines.length === 0
      ? []
      : ["## 交付要求", ...deliverableLines, ""]),
    "## 输出格式",
    "最终回复必须直接从「# 交付报告」开始；不要先输出计划、推理、检查步骤或工具调用。",
    "报告必须包含二级标题「## 交付说明」；如果上下文不足，也要在该节列出缺失信息。",
    "",
    "## 交付说明",
    hasRequiredText
      ? "<针对必交文本交付物的正文，满足最少字数要求；说明结果、覆盖范围、验证方式和风险>"
      : "<说明交付结果、验证方式和风险；没有形式化交付物时也必须保留此节>",
    "",
    "## 工具",
    profile.allowedTools.length === 0
      ? "本任务不限制可用工具；但最终回复仍必须直接交付报告，不要输出工具调用语法。"
      : `只能使用这些工具：${profile.allowedTools.join("、")}。完成后仍必须直接输出交付报告。`,
    "## 边界",
    "1. 只处理当前节点的内容。",
    "2. 不要修改工作流定义或系统代码。",
    "3. 不要声称完成未提交的交付物。",
    "4. 你的最终回复会写入交付物记录，请保持结构化、可直接审核。",
    "5. 如果信息不足，在交付说明中明确列出缺失项，不要编造。",
  ].join("\n");
}

/** 外部 CLI 没有平台的会话人设层，因此 SOUL 必须作为 Prompt 的前置角色设定注入。 */
function buildExternalAgentPrompt(
  personaSoul: string,
  taskPrompt: string,
): string {
  const soul = personaSoul.trim();
  if (soul === "") return taskPrompt;
  return [
    "# AI伙伴身份与行为边界",
    "",
    "以下定义是你在当前平台中的长期身份，优先于执行工具的默认身份说明。不要把自己描述成通用的 Codex、CodeBuddy 或其他 CLI 助手。",
    "",
    soul,
    "",
    "---",
    "",
    "# 当前任务",
    "",
    taskPrompt.trim(),
  ]
    .join("\n")
    .slice(0, 60_000);
}

export interface AgentTaskTables {
  readonly profiles: KvTableLike<AgentProfile>;
  readonly runs: KvTableLike<AgentRun>;
}

export interface AgentRuntimeDeps {
  readonly tables: AgentTaskTables;
  readonly subagents: () => SubagentsRuntimeLike | undefined;
  readonly agents: () => AgentsRegistryLike | undefined;
  /** 人格服务：把 run 的 personaId 解析成 SOUL 文本，供 worker 注入。 */
  readonly personas?: () => PersonaServiceLike | undefined;
  readonly defaultModel?: () => AgentDefaultModelLike | undefined;
  readonly workspaces?: () => WorkspaceRegistryLike | undefined;
  readonly sessions?: () => AgentSessionsLike | undefined;
  readonly sessionPersistence?: () => AgentSessionPersistenceLike | undefined;
  readonly sessionTitle?: () => AgentSessionTitleLike | undefined;
  readonly provider?: () => string;
  readonly externalRuntimes?: () =>
    KvTableLike<ExternalAgentRuntime> | undefined;
  readonly externalRunner?: () => ExternalAgentRunner | undefined;
  readonly execution?: () => AgentExecutionService | undefined;
  readonly now?: () => Date;
  readonly onSettled?: (run: AgentRun) => Promise<void> | void;
}

interface AgentTask {
  readonly runId: string;
  readonly workspaceId: string;
  readonly controller: AbortController;
  cancelReason: "cancelled" | undefined;
  timedOut: boolean;
}

const MAX_GLOBAL_WORKERS = 4;
const MAX_WORKSPACE_WORKERS = 2;

/**
 * Owns one-shot task-worker execution for workflow agent nodes.
 *
 * Workers are deliberately short-lived: the final reply is the only output,
 * and this runtime is the only component allowed to write it into AgentRun.
 */
export class AgentTaskRuntime {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tasks = new Set<AgentTask>();
  private readonly hosts = new Map<string, Promise<AgentHandleLike>>();
  private readonly homeHandles = new Map<string, Promise<AgentHandleLike>>();
  private readonly homeQueues = new Map<string, Promise<void>>();
  private readonly publishedSessions = new Set<string>();
  private readonly progressBySession = new Map<string, AgentRunProgress>();
  private activeWorkers = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly cancelledRunIds = new Set<string>();

  constructor(private readonly deps: AgentRuntimeDeps) {}

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  recordStream(sessionId: string, frame: unknown): void {
    const current = this.progressBySession.get(sessionId);
    let text = current?.text ?? "";
    let changed = false;
    if (
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === "chunk" &&
      "chunk" in frame &&
      typeof frame.chunk === "object" &&
      frame.chunk !== null &&
      "type" in frame.chunk &&
      frame.chunk.type === "text-delta" &&
      "text" in frame.chunk &&
      typeof frame.chunk.text === "string"
    ) {
      text += frame.chunk.text;
      changed = true;
    }
    if (!changed && current !== undefined) return;
    this.progressBySession.set(sessionId, {
      text,
      updatedAt: iso(this.now()),
    });
  }

  progress(sessionId: string): AgentRunProgress | undefined {
    return this.progressBySession.get(sessionId);
  }

  private enqueueHome<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.homeQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.homeQueues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.homeQueues.get(sessionId) === tail) {
        this.homeQueues.delete(sessionId);
      }
    });
    return result;
  }

  enqueue(run: AgentRun): void {
    const key = `${run.instanceId}:${run.nodeId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(run.id))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
  }

  cancel(runId: string): void {
    this.cancelledRunIds.add(runId);
    for (const task of this.tasks) {
      if (task.runId !== runId) continue;
      task.cancelReason = "cancelled";
      task.controller.abort("cancelled");
    }
  }

  async dispose(): Promise<void> {
    for (const task of this.tasks) {
      task.cancelReason = "cancelled";
      task.controller.abort("runtime disposed");
    }
    this.tasks.clear();
    await this.disposeHosts();
    await this.disposeHomeHandles();
  }

  async waitIdle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled(this.queues.values());
    }
  }

  private async acquire(workspaceId: string): Promise<void> {
    const workspaceActive = () =>
      [...this.tasks].filter((task) => task.workspaceId === workspaceId).length;
    while (
      this.activeWorkers >= MAX_GLOBAL_WORKERS ||
      workspaceActive() >= MAX_WORKSPACE_WORKERS
    ) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.activeWorkers += 1;
  }

  private release(): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.waiting.shift()?.();
  }

  private async disposeHosts(): Promise<void> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.allSettled(
      hosts.map(async (host) => {
        try {
          await (await host).dispose();
        } catch {
          // Host startup failures need no cleanup.
        }
      }),
    );
  }

  private async disposeHomeHandles(): Promise<void> {
    const handles = [...this.homeHandles.values()];
    this.homeHandles.clear();
    await Promise.allSettled(
      handles.map(async (pending) => {
        try {
          const handle = await pending;
          await handle.dispose();
        } catch {
          // Persisted Session logs remain available after handle disposal.
        }
      }),
    );
  }

  private async hostAgent(workspacePath: string): Promise<unknown> {
    let current = this.hosts.get(workspacePath);
    if (current === undefined) {
      const agents = this.deps.agents();
      if (agents === undefined)
        throw new AgentError("not_found", "agent registry is unavailable");
      const model = this.deps.defaultModel?.()?.currentSelection();
      current = agents
        .create({
          sessionId: randomUUID(),
          meta: { cwd: workspacePath },
          ...(model === undefined ? {} : { agentOptions: model }),
        })
        .catch((cause: unknown) => {
          if (this.hosts.get(workspacePath) === current) {
            this.hosts.delete(workspacePath);
          }
          throw cause;
        });
      this.hosts.set(workspacePath, current);
    }
    return (await current).agent;
  }

  /**
   * 把 run 的 personaId 解析成运行时人设文本。
   *
   * teammate / 数字员工的人设（SOUL.md 正文 + 「工作场景」「工作目标」）由
   * teammate 运行态同步进 persona 文件；worker 启动前在这里取回文本，供内置
   * 会话的人设段落注入与外接 subagent 的 persona 参数使用。取不到时返回空串，
   * 维持「没有人设」的原行为，不让解析失败拖垮任务。
   */
  private async resolvePersonaSoul(personaId?: string): Promise<string> {
    if (personaId === undefined || personaId === "") return "";
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

  private async executeHomeSession(
    run: AgentRun,
    profile: AgentProfile,
    prompt: string,
    signal: AbortSignal,
    personaSoul: string,
  ): Promise<SubagentResultLike> {
    if (run.workspacePath === undefined) {
      throw new AgentError(
        "invalid_input",
        "task run is missing workspace path",
      );
    }
    const workspacePath = run.workspacePath;
    const agents = this.deps.agents();
    if (agents === undefined) {
      throw new AgentError("not_found", "agent registry is unavailable");
    }
    const sessionId = taskSessionId(run);
    const handle = await this.ensureHomeHandle(
      run,
      profile,
      workspacePath,
      personaSoul,
    );
    const agent = handle.agent as AgentLike;
    return await this.enqueueHome(sessionId, async () => {
      this.progressBySession.set(sessionId, {
        text: "",
        updatedAt: iso(this.now()),
      });
      // Chat sessions are private to the communication surface. Attaching them
      // to the shared workspace session tree would expose the session title to
      // every project member, even when the meeting transcript itself is
      // access-controlled.
      if (run.source === "chat") {
        await this.saveRun({ ...run, sessionId });
      } else {
        await this.attachSession(run, sessionId);
      }
      if (signal.aborted) {
        agent.cancel?.({ kind: "user" });
        throw new Error("worker aborted");
      }
      const start = agent.session.snapshotEvents().length;
      const onAbort = (): void => {
        agent.cancel?.({ kind: "user" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        agent.followup(taskUserMessage(prompt));
        await agent.whenIdle();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const execution = this.deps.execution?.();
      if (execution !== undefined) {
        execution.bindSession(run.id, sessionId);
        await execution
          .recordSessionEvents(run.id, agent.session.snapshotEvents(), start)
          .catch(() => undefined);
      }
      if (signal.aborted) throw new Error("worker aborted");
      const output = lastAssistantText(agent.session, start);
      const blocks = output === "" ? [] : [{ type: "text", text: output }];
      // 会话日志没了必须显式判失败：harness 在这种情况仍可能返回「完成」，
      // 只有这里拦住，任务卡片才不会出现「日志失败但 run 成功」。
      if (await this.sessionArtifactMissing(sessionId)) {
        return {
          output: blocks,
          stopReason: "failed",
          diagnostic: `会话日志已丢失：磁盘上找不到 ${sessionId} 的会话文件，本轮结果未持久化（目录可能被外部清理或删除）。`,
        };
      }
      return {
        output: blocks,
        stopReason: "completed",
      };
    });
  }

  /**
   * 运行排队阶段就建立确定性任务会话。左侧清单依赖 workspace 的 session
   * 挂载记录；如果等到发送首条消息才挂载，并发排队或重启前的窗口会让用户
   * 看到任务已存在但会话消失。
   */
  private async reserveHomeSession(
    run: AgentRun,
    profile: AgentProfile,
    personaSoul: string,
  ): Promise<AgentRun> {
    if (run.workspacePath === undefined) return run;
    const sessionId = taskSessionId(run);
    await this.ensureHomeHandle(run, profile, run.workspacePath, personaSoul);
    const persistence = this.deps.sessionPersistence?.();
    if (persistence !== undefined) {
      // agents.create 返回时，workspace attach 可能仍读不到首次 checkpoint。
      // 只等会话产物可见，避免左侧清单在创建瞬间丢失挂载。
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await persistence.stat(sessionId)) !== undefined) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    await this.attachSession(run, sessionId);
    return this.deps.tables.runs.get(run.id) ?? run;
  }

  private async ensureHomeHandle(
    run: AgentRun,
    profile: AgentProfile,
    workspacePath: string,
    personaSoul: string,
  ): Promise<AgentHandleLike> {
    const agents = this.deps.agents();
    if (agents === undefined) {
      throw new AgentError("not_found", "agent registry is unavailable");
    }
    const sessionId = taskSessionId(run);
    const existing = this.homeHandles.get(sessionId);
    if (existing !== undefined) return await existing;
    const setup = async (agentCtx: AgentSetupContextLike): Promise<void> => {
      await agentCtx.get?.("agentPresets")?.mount(agentCtx, "standard");
      // 人设注入：standard preset 自己占用了 deployment:persona，这里用独立
      // section 追加本 teammate 的 SOUL，避免同层同名冲突，让 worker 真正读到人设。
      if (personaSoul !== "") {
        const systemPrompt = agentCtx.get?.("systemPrompt");
        if (systemPrompt !== undefined) {
          const order =
            systemPrompt.getSectionOrder?.("DEPLOYMENT_PERSONA") ?? 0;
          systemPrompt.section({
            name: "dsh-collab:teammate-soul",
            order,
            text: `# 你的人设（AI伙伴）\n\n${personaSoul}`,
          });
        }
      }
      const tools = agentCtx.tools;
      // 空清单 = 不限制（与「未限制工具清单」的语义一致）：只有显式配置了工具
      // 才收窄，否则保持挂载预设后的默认工具集。
      const configured = [...new Set(profile.allowedTools)].filter(
        (name) => name.trim() !== "",
      );
      if (tools !== undefined && configured.length > 0) {
        const allow = configured.filter(
          (name) => tools.get(name) !== undefined,
        );
        tools.restrict({ allow });
      }
    };
    const model = this.deps.defaultModel?.()?.currentSelection();
    const pending = (async () => {
      const adoptLive = (): AgentHandleLike | undefined => {
        const live = agents.get?.(sessionId);
        return live === undefined
          ? undefined
          : { agent: live, dispose: async () => undefined };
      };
      const live = adoptLive();
      if (live !== undefined) return live;
      const persisted = await this.deps.sessionPersistence?.()?.stat(sessionId);
      const createSession = () =>
        agents.create({
          sessionId,
          meta: { cwd: workspacePath },
          setup,
          ...(model === undefined ? {} : { agentOptions: model }),
        });
      try {
        if (persisted !== undefined) {
          if (agents.resume === undefined) {
            throw new AgentError(
              "conflict",
              `persisted task session cannot be resumed: ${sessionId}`,
            );
          }
          try {
            return await agents.resume({
              resumeSessionId: sessionId,
              setup,
              ...(model === undefined ? {} : { agentOptions: model }),
            });
          } catch (cause) {
            // 会话「登记过」不等于产物还在：目录被清理/删除后恢复会以
            // ENOENT / not-found 失败。这种情况重建会话，而不是把整轮判死。
            if (!isMissingSessionArtifact(cause)) throw cause;
            return await createSession();
          }
        }
        return await createSession();
      } catch (cause) {
        // 会话可能已被本进程内另一个活跃 handle 占用（例如重复启动或热重载）：
        // 能拿到现存活句柄就复用，避免任务因为写句柄冲突直接失败。
        const adopted = adoptLive();
        if (adopted !== undefined) return adopted;
        throw cause;
      }
    })();
    this.homeHandles.set(sessionId, pending);
    void pending.catch(() => {
      if (this.homeHandles.get(sessionId) === pending) {
        this.homeHandles.delete(sessionId);
      }
    });
    return await pending;
  }

  /** 修复旧版本重启后留下的“任务已启动但从未挂载会话”的窄范围断档。 */
  async republishLegacyRestart(run: AgentRun): Promise<void> {
    if (
      run.source !== "workflow" ||
      run.error !== "服务重启导致运行中断，可重试或转人工" ||
      run.payload.context.workflowTaskId === undefined ||
      run.workspacePath === undefined
    ) {
      return;
    }
    const profile = this.deps.tables.profiles.get(run.agentProfileId);
    if (profile === undefined || profile.execution === "external") return;
    try {
      if (run.sessionId !== undefined) {
        await this.attachSession(run, run.sessionId);
        return;
      }
      const personaSoul = await this.resolvePersonaSoul(run.personaId);
      await this.reserveHomeSession(run, profile, personaSoul);
    } catch {
      // This is compatibility repair for legacy runs; the interrupted result stays.
    }
  }

  /**
   * 本轮结束后确认会话仍然落盘。`stat` 返回 undefined 说明磁盘上已经没有这个
   * 会话（目录被清理/删除），此时后续每次落盘都会 ENOENT；agent 循环却可能已经
   * 返回「完成」——必须显式识别，不能当成成功回写任务。
   */
  private async sessionArtifactMissing(sessionId: string): Promise<boolean> {
    const persistence = this.deps.sessionPersistence?.();
    if (persistence === undefined) return false;
    try {
      return (await persistence.stat(sessionId)) === undefined;
    } catch {
      // 只读探测本身失败不把这一轮判死。
      return false;
    }
  }

  private async saveRun(run: AgentRun): Promise<AgentRun> {
    const next = agentRunSchema.parse({
      ...run,
      updatedAt: iso(this.now()),
    });
    await this.deps.tables.runs.put(next.id, next);
    return next;
  }

  private async attachSession(
    run: AgentRun,
    sessionId: string,
  ): Promise<AgentRun> {
    const saved = await this.saveRun({ ...run, sessionId });
    try {
      const publicationKey = `${run.workspaceId}\u0000${sessionId}`;
      if (this.publishedSessions.has(publicationKey)) return saved;
      const workspaces = this.deps.workspaces?.();
      if (workspaces !== undefined && run.workspacePath !== undefined) {
        const workspace = await workspaces.create(run.workspacePath);
        await workspace.attachSession(sessionId);
      }
      this.publishedSessions.add(publicationKey);
      const session = this.deps.sessions?.()?.get(sessionId);
      const title = this.deps.sessionTitle?.();
      if (session !== undefined && title !== undefined) {
        const runs = [...this.deps.tables.runs.entries()]
          .map(([, item]) => item)
          .filter((item) => item.sessionId === sessionId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        const first = runs[0] ?? run;
        const desired = desiredTaskSessionTitle(first);
        const teammate = desired.includes("-TSK-")
          ? desired.slice(0, desired.indexOf("-TSK-"))
          : desired;
        // 只有新命名（de-task-*）的任务会话才套用新标题；
        // 旧的家会话（de-home-*）保留原有名字，避免「新标题 + 旧 id」。
        if (sessionId.startsWith("de-task-")) {
          const current = title.get?.(session)?.title?.trim();
          const systemGenerated =
            current === undefined ||
            current.startsWith("TSK-") ||
            current.startsWith(`${teammate}-TSK-`) ||
            current.includes(" · ");
          if (systemGenerated) title.rename(session, desired);
        }
      }
    } catch {
      // Session publication is observability; task execution remains authoritative.
    }
    return saved;
  }

  /** 启动时把历史系统命名迁移到新顺序，用户手动改名不会被覆盖。 */
  async migrateLegacySessionTitles(): Promise<void> {
    const sessions = this.deps.sessions?.();
    const title = this.deps.sessionTitle?.();
    if (sessions === undefined || title === undefined) return;
    const agents = this.deps.agents?.();
    const persistence = this.deps.sessionPersistence?.();

    const firstRunBySession = new Map<string, AgentRun>();
    for (const [, run] of this.deps.tables.runs.entries()) {
      if (
        typeof run.sessionId !== "string" ||
        !run.sessionId.startsWith("de-task-")
      )
        continue;
      const first = firstRunBySession.get(run.sessionId);
      if (first === undefined || run.createdAt < first.createdAt) {
        firstRunBySession.set(run.sessionId, run);
      }
    }

    await Promise.allSettled(
      [...firstRunBySession].map(async ([sessionId, run]) => {
        const session = sessions.get(sessionId);
        if (session !== undefined) {
          const current = title.get?.(session)?.title?.trim();
          if (current !== undefined && current.startsWith("TSK-")) {
            title.rename(session, desiredTaskSessionTitle(run));
          }
          return;
        }
        if (agents?.resume === undefined || persistence === undefined) return;
        if ((await persistence.stat(sessionId)) === undefined) return;
        const handle = await agents.resume({ resumeSessionId: sessionId });
        try {
          const persistedSession = (
            handle.agent as {
              session: AgentSessionLike;
            }
          ).session;
          const current = title.get?.(persistedSession)?.title?.trim();
          if (current !== undefined && current.startsWith("TSK-")) {
            title.rename(persistedSession, desiredTaskSessionTitle(run));
          }
        } finally {
          await handle.dispose();
        }
      }),
    );
  }

  /**
   * 任务的执行人显示名归任务管理所有；当它后来修正时，用该名称同步
   * 系统生成的任务会话标题，用户手动改名仍不会被覆盖。
   */
  async syncTaskSessionTitles(
    executorNames: ReadonlyMap<string, string>,
  ): Promise<void> {
    const sessions = this.deps.sessions?.();
    const title = this.deps.sessionTitle?.();
    if (sessions === undefined || title === undefined) return;
    const agents = this.deps.agents?.();
    const persistence = this.deps.sessionPersistence?.();

    const firstRunBySession = new Map<
      string,
      { readonly run: AgentRun; readonly taskId: string }
    >();
    for (const [, run] of this.deps.tables.runs.entries()) {
      const taskId =
        run.source === "task"
          ? run.instanceId
          : run.source === "workflow"
            ? run.payload.context.workflowTaskId
            : undefined;
      if (
        typeof taskId !== "string" ||
        taskId === "" ||
        typeof run.sessionId !== "string" ||
        !run.sessionId.startsWith("de-task-") ||
        !executorNames.has(taskId)
      ) {
        continue;
      }
      const first = firstRunBySession.get(run.sessionId);
      if (first === undefined || run.createdAt < first.run.createdAt) {
        firstRunBySession.set(run.sessionId, { run, taskId });
      }
    }

    await Promise.allSettled(
      [...firstRunBySession].map(async ([sessionId, { run, taskId }]) => {
        const executorName = executorNames.get(taskId) ?? "";
        if (executorName === "") return;
        const desired = desiredTaskSessionTitle({
          ...run,
          payload: {
            ...run.payload,
            context: {
              ...run.payload.context,
              employeeName: executorName,
            },
          },
        });
        const legacyTeammate =
          desiredTaskSessionTitle(run).split("-TSK-")[0] ?? "";
        const legacyCompactTeammate = legacyTeammate.replace(/\s+/g, "");
        const renameIfSystemTitle = (session: AgentSessionLike): void => {
          const current = title.get?.(session)?.title?.trim();
          const systemGenerated =
            current === undefined ||
            current.startsWith("TSK-") ||
            current.startsWith(`${legacyTeammate}-TSK-`) ||
            current.startsWith(`${legacyCompactTeammate}-TSK-`) ||
            current.includes(" · ");
          if (systemGenerated && current !== desired) {
            title.rename(session, desired);
          }
        };
        const session = sessions.get(sessionId);
        if (session !== undefined) {
          renameIfSystemTitle(session);
          return;
        }
        if (agents?.resume === undefined || persistence === undefined) return;
        if ((await persistence.stat(sessionId)) === undefined) return;
        const handle = await agents.resume({ resumeSessionId: sessionId });
        try {
          renameIfSystemTitle(
            (handle.agent as { session: AgentSessionLike }).session,
          );
        } finally {
          await handle.dispose();
        }
      }),
    );
  }

  private async settle(
    run: AgentRun,
    patch: Partial<
      Pick<AgentRun, "status" | "output" | "outputTokens" | "error" | "endedAt">
    >,
  ): Promise<void> {
    const latest = this.deps.tables.runs.get(run.id);
    if (latest !== undefined && TERMINAL_RUN_STATUSES.includes(latest.status)) {
      return;
    }
    const next = { ...(latest ?? run), ...patch };
    const outputTokens =
      next.outputTokens ??
      (next.sessionId === undefined || next.endedAt === undefined
        ? undefined
        : (() => {
            const session = this.deps.sessions?.()?.get(next.sessionId);
            return session === undefined
              ? undefined
              : assistantOutputTokens(session, next.startedAt, next.endedAt);
          })());
    await this.saveRun({
      ...next,
      ...(outputTokens === undefined ? {} : { outputTokens }),
    });
    const saved = this.deps.tables.runs.get(run.id);
    if (saved === undefined) return;
    await this.deps.onSettled?.(saved);
  }

  private async execute(runId: string): Promise<void> {
    let claimed = this.deps.tables.runs.get(runId);
    if (claimed === undefined || claimed.status !== "queued") return;
    if (this.cancelledRunIds.has(runId)) return;
    const profile = this.deps.tables.profiles.get(claimed.agentProfileId);
    if (profile === undefined || profile.status !== "active") {
      await this.settle(claimed, {
        status: "failed",
        error: "Agent Profile 不存在或已停用",
        endedAt: iso(this.now()),
      });
      return;
    }
    const isExternal = profile.execution === "external";
    const subagents = this.deps.subagents();
    if (!isExternal && subagents === undefined) {
      await this.settle(claimed, {
        status: "failed",
        error: "内置 Agent 运行时不可用，可转人工代交",
        endedAt: iso(this.now()),
      });
      return;
    }
    if (isExternal) {
      if (profile.externalRuntimeId === undefined) {
        await this.settle(claimed, {
          status: "failed",
          error: "外部 Agent 运行时未绑定",
          endedAt: iso(this.now()),
        });
        return;
      }
      const runtime = this.deps
        .externalRuntimes?.()
        ?.get(profile.externalRuntimeId);
      if (runtime === undefined || runtime.status !== "active") {
        await this.settle(claimed, {
          status: "failed",
          error: externalRuntimeUnavailableReason(runtime),
          endedAt: iso(this.now()),
        });
        return;
      }
      if (claimed.workspacePath === undefined) {
        await this.settle(claimed, {
          status: "failed",
          error: "外部 Agent 执行需要项目工作区",
          endedAt: iso(this.now()),
        });
        return;
      }
    }
    let reservedPersonaSoul = "";
    if (
      !isExternal &&
      claimed.workspacePath !== undefined &&
      claimed.source !== "chat"
    ) {
      // 会话必须先可见，再进入全局并发/执行队列；否则排队期间左侧清单
      // 会缺项，服务重启后也可能留下「有任务、无 session」的断档。
      reservedPersonaSoul = await this.resolvePersonaSoul(claimed.personaId);
      claimed = await this.reserveHomeSession(
        claimed,
        profile,
        reservedPersonaSoul,
      );
    }
    const task: AgentTask = {
      runId,
      workspaceId: claimed.workspaceId,
      controller: new AbortController(),
      cancelReason: undefined,
      timedOut: false,
    };
    this.tasks.add(task);
    const claimedRun = this.deps.tables.runs.get(runId);
    if (
      claimedRun !== undefined &&
      TERMINAL_RUN_STATUSES.includes(claimedRun.status)
    ) {
      this.tasks.delete(task);
      return;
    }
    if (this.cancelledRunIds.has(runId)) {
      this.tasks.delete(task);
      return;
    }
    const prompt = buildPrompt(claimed, profile);
    await this.saveRun({
      ...claimed,
      status: "running",
      startedAt: iso(this.now()),
      promptSnapshot: prompt,
    });
    const current = this.deps.tables.runs.get(runId)!;
    const workspacePath = current.workspacePath ?? process.cwd();
    const timer = setTimeout(() => {
      task.timedOut = true;
      task.controller.abort("timeout");
    }, current.timeoutMs);
    let started: SubagentRunLike | undefined;
    try {
      await this.acquire(current.workspaceId);
      const signal = task.controller.signal;
      // 人设文本在启动前解析一次：内置会话与 subagent 两条路径共用。
      const personaSoul =
        current.contextPackId !== undefined
          ? ""
          : reservedPersonaSoul !== "" || current.personaId === undefined
            ? reservedPersonaSoul
            : await this.resolvePersonaSoul(current.personaId);
      let result: SubagentResultLike;
      if (isExternal) {
        const runner = this.deps.externalRunner?.();
        const externalRuntime = this.deps
          .externalRuntimes?.()
          ?.get(profile.externalRuntimeId ?? "");
        if (runner === undefined) {
          throw new AgentError(
            "conflict",
            "外部 Agent 执行器不可用，请稍后重试",
          );
        }
        if (
          externalRuntime === undefined ||
          externalRuntime.status !== "active"
        ) {
          throw new AgentError(
            "conflict",
            externalRuntimeUnavailableReason(externalRuntime),
          );
        }
        if (current.workspacePath === undefined) {
          throw new AgentError(
            "invalid_input",
            "外部 Agent 执行需要项目工作区",
          );
        }
        const sessionId = externalSessionId(runId);
        this.progressBySession.set(sessionId, {
          text: "",
          updatedAt: iso(this.now()),
        });
        await this.saveRun({
          ...current,
          status: "running",
          startedAt: iso(this.now()),
          promptSnapshot: prompt,
          sessionId,
        });
        this.deps.execution?.()?.bindSession(runId, sessionId);
        const live = this.deps.tables.runs.get(runId)!;
        const externalPrompt = buildExternalAgentPrompt(personaSoul, prompt);
        await this.saveRun({
          ...live,
          promptSnapshot: externalPrompt,
        });
        const prepared = this.deps.tables.runs.get(runId) ?? live;
        const plannedExecution = this.deps
          .execution?.()
          ?.projection(runId)?.snapshot;
        const requestedModel =
          plannedExecution?.model === undefined ||
          plannedExecution.model === "unknown"
            ? undefined
            : plannedExecution.model;
        const requestedReasoningEffort = plannedExecution?.reasoningEffort;
        const baseExecution = normalizeExecutionMetadata({
          provider: externalRuntime.provider,
          model: requestedModel ?? "unknown",
          ...(requestedReasoningEffort === undefined
            ? {}
            : { reasoningEffort: requestedReasoningEffort }),
          runtime: externalRuntime.name,
          sandbox:
            externalRuntime.protocol === "codex-jsonl"
              ? "read-only / network restricted"
              : "unknown",
        });
        await this.saveRun({
          ...prepared,
          execution: baseExecution,
        });
        const result = await runner.execute({
          runId,
          runtime: externalRuntime,
          ...(requestedModel === undefined ? {} : { model: requestedModel }),
          ...(requestedReasoningEffort === undefined
            ? {}
            : { reasoningEffort: requestedReasoningEffort }),
          prompt: externalPrompt,
          workspacePath: current.workspacePath,
          signal,
          onProgress: (text) => {
            this.progressBySession.set(sessionId, {
              text,
              updatedAt: iso(this.now()),
            });
          },
          onTrace: (event) => {
            void this.deps.execution?.()?.recordTrace(runId, event);
          },
        });
        const execution = normalizeExecutionMetadata({
          ...baseExecution,
          ...result.execution,
          provider: result.execution?.provider ?? baseExecution.provider,
          runtime: result.execution?.runtime ?? baseExecution.runtime,
        });
        const withExecution = this.deps.tables.runs.get(runId) ?? prepared;
        await this.saveRun({
          ...withExecution,
          execution,
        });
        if (result.sessionId !== undefined) {
          const withExternal = this.deps.tables.runs.get(runId) ?? prepared;
          await this.saveRun({
            ...withExternal,
            externalSessionId: result.sessionId,
          });
        }
        if (this.cancelledRunIds.has(runId)) return;
        if (task.cancelReason === "cancelled") {
          await this.settle(this.deps.tables.runs.get(runId) ?? prepared, {
            status: "cancelled",
            endedAt: iso(this.now()),
          });
        } else if (task.timedOut) {
          await this.settle(this.deps.tables.runs.get(runId) ?? prepared, {
            status: "timeout",
            error: "运行超时，已中止",
            endedAt: iso(this.now()),
          });
        } else if (result.stopReason !== "completed") {
          await this.settle(this.deps.tables.runs.get(runId) ?? prepared, {
            status: "failed",
            error: (result.diagnostic ?? "外部 Agent 执行失败").slice(0, 1_000),
            endedAt: iso(this.now()),
          });
        } else {
          const outputText = result.output
            .map((item) => item.text)
            .join("\n")
            .trim();
          if (outputText === "") {
            await this.settle(this.deps.tables.runs.get(runId) ?? live, {
              status: "failed",
              error: "外部 Agent 未返回可用的文本输出",
              endedAt: iso(this.now()),
            });
          } else {
            const issues =
              current.source === "workflow"
                ? deliveryReportIssues(outputText, current.payload)
                : [];
            if (issues.length > 0) {
              await this.settle(this.deps.tables.runs.get(runId) ?? live, {
                status: "failed",
                error: `交付报告格式不合格：${issues.join("；")}`.slice(
                  0,
                  1_000,
                ),
                output: { summary: outputText },
                endedAt: iso(this.now()),
              });
            } else {
              await this.settle(this.deps.tables.runs.get(runId) ?? prepared, {
                status: "succeeded",
                output: {
                  summary: outputText,
                  ...(result.diagnostic === undefined
                    ? {}
                    : { stopReason: result.diagnostic.slice(0, 120) }),
                  endedAt: iso(this.now()),
                },
                endedAt: iso(this.now()),
              });
            }
          }
        }
        return;
      }
      const builtinSubagents = subagents!;
      const modelSelection = this.deps.defaultModel?.()?.currentSelection();
      const latestBuiltin = this.deps.tables.runs.get(runId) ?? current;
      await this.saveRun({
        ...latestBuiltin,
        execution: normalizeExecutionMetadata({
          provider: modelSelection?.provider ?? "platform",
          model: modelSelection?.model ?? "unknown",
          runtime: "DSH built-in",
          authMode: "platform-managed",
          sandbox: "platform-managed",
        }),
      });
      if (current.workspacePath !== undefined) {
        result = await this.executeHomeSession(
          current,
          profile,
          prompt,
          signal,
          personaSoul,
        );
      } else {
        started = await builtinSubagents.start(
          this.deps.provider?.() ?? "spawn",
          {
            label: `workflow-worker:${profile.name}`,
            prompt: [{ type: "text", text: prompt }],
            parent: await this.hostAgent(workspacePath),
            // persona 参数语义是人设文本（会 shadow deployment:persona），
            // 传 personaId 只会把 id 字面量当成人设，这里改成 SOUL 正文。
            ...(personaSoul === "" ? {} : { persona: personaSoul }),
            // 空清单 = 不限制：不传 toolFilter，交给挂载的预设决定工具集。
            ...(profile.allowedTools.length === 0
              ? {}
              : { toolFilter: { allow: profile.allowedTools } }),
            signal,
          },
        );
        result = await awaitSubagentResult(started, signal);
      }
      const rawOutput = subagentOutputText(result);
      const outputIssues =
        current.source === "workflow" &&
        result.stopReason === "completed" &&
        rawOutput.trim() !== ""
          ? deliveryReportIssues(rawOutput, current.payload)
          : [];
      if (outputIssues.length > 0 && !this.cancelledRunIds.has(runId)) {
        // Keep the first reply as evidence even if the repaired reply is lost.
        const latest = this.deps.tables.runs.get(runId) ?? current;
        await this.saveRun({
          ...latest,
          output: {
            summary: rawOutput,
            rawOutput,
            repairAttempt: 1,
          },
        });
        if (current.runSeq + 1 <= current.maxAttempts) {
          const repaired = await builtinSubagents.start(
            this.deps.provider?.() ?? "spawn",
            {
              label: `workflow-worker-repair:${profile.name}`,
              prompt: [
                {
                  type: "text",
                  text: buildRepairPrompt(current, rawOutput, outputIssues),
                },
              ],
              parent: await this.hostAgent(workspacePath),
              ...(personaSoul === "" ? {} : { persona: personaSoul }),
              ...(profile.allowedTools.length === 0
                ? {}
                : { toolFilter: { allow: profile.allowedTools } }),
              signal,
            },
          );
          result = await awaitSubagentResult(repaired, signal);
        }
      }
      if (this.cancelledRunIds.has(runId)) return;
      if (task.cancelReason === "cancelled") {
        await this.settle(current, {
          status: "cancelled",
          endedAt: iso(this.now()),
        });
      } else if (task.timedOut) {
        await this.settle(current, {
          status: "timeout",
          error: "运行超时，已中止",
          endedAt: iso(this.now()),
        });
      } else if (result.stopReason !== "completed") {
        const partialOutput = subagentOutputText(result).trim();
        await this.settle(current, {
          status: "failed",
          error:
            result.diagnostic === undefined
              ? `worker ended with ${result.stopReason}`
              : `${result.stopReason}: ${result.diagnostic}`,
          // 失败也要留住已经产出的文本：任务卡片给原因，执行面板还能看到内容。
          ...(partialOutput === ""
            ? {}
            : { output: { summary: partialOutput } }),
          endedAt: iso(this.now()),
        });
      } else if (subagentOutputText(result).trim() === "") {
        await this.settle(current, {
          status: "failed",
          error: "Agent 未返回可用的文本输出",
          endedAt: iso(this.now()),
        });
      } else {
        const finalOutput = subagentOutputText(result);
        const finalIssues =
          current.source === "workflow"
            ? deliveryReportIssues(finalOutput, current.payload)
            : [];
        if (finalIssues.length > 0) {
          const evidence = this.deps.tables.runs.get(runId)?.output;
          await this.settle(current, {
            status: "failed",
            error: `交付报告格式不合格：${finalIssues.join("；")}`,
            output: {
              summary: finalOutput,
              ...(evidence?.rawOutput === undefined
                ? {}
                : { rawOutput: evidence.rawOutput }),
              ...(evidence?.repairAttempt === undefined
                ? {}
                : { repairAttempt: evidence.repairAttempt }),
            },
            endedAt: iso(this.now()),
          });
          return;
        }
        const repairEvidence = this.deps.tables.runs.get(runId)?.output;
        await this.settle(current, {
          status: "succeeded",
          output: {
            summary: finalOutput,
            ...(repairEvidence?.rawOutput === undefined
              ? {}
              : { rawOutput: repairEvidence.rawOutput }),
            ...(repairEvidence?.repairAttempt === undefined
              ? {}
              : { repairAttempt: repairEvidence.repairAttempt }),
            ...(result.diagnostic === undefined
              ? {}
              : { stopReason: result.stopReason }),
            endedAt: iso(this.now()),
          },
          endedAt: iso(this.now()),
        });
      }
    } catch (cause) {
      if (task.cancelReason === "cancelled") {
        await this.settle(this.deps.tables.runs.get(runId) ?? current, {
          status: "cancelled",
          endedAt: iso(this.now()),
        });
      } else if (task.timedOut) {
        await this.settle(this.deps.tables.runs.get(runId) ?? current, {
          status: "timeout",
          error: "运行超时，已中止",
          endedAt: iso(this.now()),
        });
      } else {
        const message =
          cause instanceof Error ? cause.message : "task worker failed";
        await this.settle(this.deps.tables.runs.get(runId) ?? current, {
          status: "failed",
          error: message.slice(0, 1_000),
          endedAt: iso(this.now()),
        });
      }
    } finally {
      clearTimeout(timer);
      this.cancelledRunIds.delete(runId);
      this.tasks.delete(task);
      this.release();
      if (this.tasks.size === 0) {
        await this.disposeHosts();
      }
      if (started !== undefined) {
        try {
          await started.dispose();
        } catch {
          // A settled worker may race its own cleanup.
        }
      }
    }
  }
}

export interface AgentServiceDeps {
  readonly now?: () => Date;
  readonly sessions?: () => AgentSessionsLike | undefined;
  readonly sessionPersistence?: () => AgentSessionPersistenceLike | undefined;
  readonly workspaces?: () => WorkspaceRegistryLike | undefined;
  readonly externalRuntimes?: () =>
    KvTableLike<ExternalAgentRuntime> | undefined;
  readonly execution?: () => AgentExecutionService | undefined;
}

export class AgentRegistryService {
  private queue: Promise<unknown> = Promise.resolve();
  private workflowHandler: AgentWorkflowHandler | undefined;
  private taskHandler: AgentTaskHandler | undefined;
  private readonly pendingSettles = new Set<string>();
  private flushingSettles = false;
  private runtime: AgentTaskRuntime | undefined;

  constructor(
    private readonly tables: AgentTaskTables,
    private readonly deps: AgentServiceDeps = {},
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private withObservedOutputTokens(run: AgentRun): AgentRun {
    if (run.outputTokens !== undefined || run.sessionId === undefined) {
      return run;
    }
    const session = this.deps.sessions?.()?.get(run.sessionId);
    if (session === undefined) return run;
    const outputTokens = assistantOutputTokens(
      session,
      run.startedAt,
      run.endedAt ?? iso(this.now()),
    );
    return outputTokens === undefined ? run : { ...run, outputTokens };
  }

  private withLegacyExecutionMetadata(run: AgentRun): AgentRun {
    if (run.execution !== undefined) return run;
    const profile = this.tables.profiles.get(run.agentProfileId);
    const runtimeId = profile?.externalRuntimeId;
    const externalRuntime =
      runtimeId === undefined
        ? undefined
        : this.deps.externalRuntimes?.()?.get(runtimeId);
    const external =
      profile?.execution === "external" || externalRuntime !== undefined;
    return {
      ...run,
      execution: normalizeExecutionMetadata(
        external
          ? {
              provider: externalRuntime?.provider ?? "unknown",
              model: profile?.defaultModel?.model ?? "unknown",
              runtime:
                externalRuntime === undefined
                  ? "外部 Agent Runtime（历史配置回填）"
                  : `${externalRuntime.name}（历史配置回填）`,
              runtimeVersion: "unknown",
              authMode: "unknown",
              sandbox:
                externalRuntime?.protocol === "codex-jsonl"
                  ? "read-only / network restricted"
                  : "unknown",
            }
          : {
              provider: profile?.defaultModel?.provider ?? "platform",
              model: profile?.defaultModel?.model ?? "unknown",
              runtime: "DSH built-in（历史配置回填）",
              runtimeVersion: "unknown",
              authMode: "platform-managed",
              sandbox: "platform-managed",
            },
      ),
    };
  }

  /** Backfill legacy runs once from their persisted session logs. */
  async backfillOutputTokens(): Promise<void> {
    const persistence = this.deps.sessionPersistence?.();
    if (persistence?.open === undefined) return;
    for (const run of values(this.tables.runs)) {
      if (
        run.outputTokens !== undefined ||
        run.sessionId === undefined ||
        !TERMINAL_RUN_STATUSES.includes(run.status)
      ) {
        continue;
      }
      const live = this.withObservedOutputTokens(run);
      if (live.outputTokens !== undefined) {
        await this.tables.runs.put(run.id, live);
        continue;
      }
      try {
        const handle = await persistence.open(run.sessionId, "read");
        try {
          const events = await handle.read();
          const outputTokens = assistantOutputTokens(
            { id: run.sessionId, snapshotEvents: () => events },
            run.startedAt,
            run.endedAt ?? iso(this.now()),
          );
          if (outputTokens !== undefined) {
            await this.tables.runs.put(run.id, { ...run, outputTokens });
          }
        } finally {
          await handle.close();
        }
      } catch {
        // Missing or unreadable legacy sessions remain observable as zero.
      }
    }
  }

  private isPlatformProfile(profile: AgentProfile): boolean {
    // 旧结构没有 visibility 字段；这些存量执行身份按平台 Profile 兼容。
    return profile.visibility !== "workspace";
  }

  attachRuntime(runtime: AgentTaskRuntime): void {
    this.runtime = runtime;
  }

  /** Keep task-session executor labels aligned with task-management receiver names. */
  syncTaskSessionTitles(
    executorNames: ReadonlyMap<string, string>,
  ): Promise<void> {
    return (
      this.runtime?.syncTaskSessionTitles(executorNames) ?? Promise.resolve()
    );
  }

  private requireManager(actor: AgentActor): void {
    if (!isManager(actor))
      throw new AgentError("forbidden", "workspace owner or admin is required");
  }

  /** Runtime hands finished runs over; workflow replay goes through flush. */
  async onRuntimeSettled(run: AgentRun): Promise<void> {
    const execution = this.deps.execution?.();
    let enriched = run;
    if (execution !== undefined) {
      const projection = await execution
        .finalizeRun(run)
        .catch(() => undefined);
      if (projection !== undefined) {
        const snapshot = projection.snapshot;
        enriched = agentRunSchema.parse({
          ...run,
          execution: {
            ...(run.execution ?? normalizeExecutionMetadata({})),
            provider: snapshot.provider,
            model: snapshot.model,
            runtime: snapshot.runtimeName,
            runtimeVersion: snapshot.runtimeVersion,
            authMode: snapshot.authMode,
            sandbox: snapshot.sandbox,
            searchEnabled: snapshot.searchEnabled,
            networkAccess: snapshot.networkAccess,
            searchUsed: snapshot.searchUsed,
            planVisibility: snapshot.planVisibility,
          },
          updatedAt: iso(this.now()),
        });
        await this.tables.runs.put(enriched.id, enriched);
      }
    }
    await this.deliverSettle(enriched);
  }

  profiles(workspaceId: string): AgentProfile[] {
    return values(this.tables.profiles)
      .filter(
        (profile) =>
          profile.workspaceId === workspaceId ||
          this.isPlatformProfile(profile),
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
  }

  profile(workspaceId: string, profileId: string): AgentProfile | undefined {
    const profile = this.tables.profiles.get(profileId);
    return profile === undefined ||
      (profile.workspaceId !== workspaceId && !this.isPlatformProfile(profile))
      ? undefined
      : profile;
  }

  createProfile(
    actor: AgentActor,
    input: {
      workspaceId: string;
      id?: string | undefined;
      name: string;
      description?: string | undefined;
      personaId?: string | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | undefined;
      runtimeKind?: AgentProfile["runtimeKind"] | undefined;
      defaultModel?: AgentProfile["defaultModel"] | undefined;
      allowedTools?: readonly string[] | undefined;
      visibility?: AgentProfile["visibility"] | undefined;
    },
  ): Promise<AgentProfile> {
    this.requireManager(actor);
    return this.createProfileRecord(actor, input);
  }

  /**
   * Internal provisioning path for a trusted domain module.
   *
   * The caller must authorize the product workflow before invoking this method.
   * It is intentionally not exposed through the HTTP route surface.
   */
  createRuntimeProfile(
    actor: AgentActor,
    input: {
      workspaceId: string;
      id?: string | undefined;
      name: string;
      description?: string | undefined;
      personaId?: string | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | undefined;
      runtimeKind?: AgentProfile["runtimeKind"] | undefined;
      defaultModel?: AgentProfile["defaultModel"] | undefined;
      allowedTools?: readonly string[] | undefined;
      visibility?: AgentProfile["visibility"] | undefined;
    },
  ): Promise<AgentProfile> {
    return this.createProfileRecord(actor, input);
  }

  private createProfileRecord(
    actor: AgentActor,
    input: {
      workspaceId: string;
      id?: string | undefined;
      name: string;
      description?: string | undefined;
      personaId?: string | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | undefined;
      runtimeKind?: AgentProfile["runtimeKind"] | undefined;
      defaultModel?: AgentProfile["defaultModel"] | undefined;
      allowedTools?: readonly string[] | undefined;
      visibility?: AgentProfile["visibility"] | undefined;
    },
  ): Promise<AgentProfile> {
    return this.enqueue(async () => {
      const timestamp = iso(this.now());
      const id = input.id?.trim() || `agent-${randomUUID().slice(0, 8)}`;
      const existing = this.tables.profiles.get(id);
      if (existing !== undefined)
        throw new AgentError("conflict", `agent profile already exists: ${id}`);
      const record = parseOrInvalid(agentProfileSchema, {
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? "",
        ...(input.personaId === undefined
          ? {}
          : { personaId: input.personaId }),
        ...(input.execution === undefined
          ? {}
          : { execution: input.execution }),
        ...(input.externalRuntimeId === undefined
          ? {}
          : { externalRuntimeId: input.externalRuntimeId }),
        runtimeKind: input.runtimeKind ?? "task-worker",
        ...(input.defaultModel === undefined
          ? {}
          : { defaultModel: input.defaultModel }),
        allowedTools: input.allowedTools ?? [],
        ownerUserId: actor.id,
        visibility: input.visibility ?? "workspace",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.tables.profiles.put(record.id, record);
      return record;
    });
  }

  updateProfile(
    actor: AgentActor,
    input: {
      workspaceId: string;
      profileId: string;
      name?: string | undefined;
      description?: string | undefined;
      personaId?: string | null | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | null | undefined;
      allowedTools?: readonly string[] | undefined;
      status?: AgentProfile["status"] | undefined;
    },
  ): Promise<AgentProfile> {
    this.requireManager(actor);
    return this.updateProfileRecord(actor, input);
  }

  /**
   * Internal counterpart of {@link updateProfile}; see createRuntimeProfile.
   */
  updateRuntimeProfile(
    actor: AgentActor,
    input: {
      workspaceId: string;
      profileId: string;
      name?: string | undefined;
      description?: string | undefined;
      personaId?: string | null | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | null | undefined;
      allowedTools?: readonly string[] | undefined;
      status?: AgentProfile["status"] | undefined;
    },
  ): Promise<AgentProfile> {
    return this.updateProfileRecord(actor, input);
  }

  private updateProfileRecord(
    actor: AgentActor,
    input: {
      workspaceId: string;
      profileId: string;
      name?: string | undefined;
      description?: string | undefined;
      personaId?: string | null | undefined;
      execution?: AgentProfile["execution"] | undefined;
      externalRuntimeId?: string | null | undefined;
      allowedTools?: readonly string[] | undefined;
      status?: AgentProfile["status"] | undefined;
    },
  ): Promise<AgentProfile> {
    return this.enqueue(async () => {
      const profile = this.profile(input.workspaceId, input.profileId);
      if (profile === undefined)
        throw new AgentError("not_found", "agent profile not found");
      if (
        profile.workspaceId !== input.workspaceId &&
        actor.globalRole !== "admin"
      ) {
        throw new AgentError(
          "forbidden",
          "platform profile requires a platform administrator",
        );
      }
      const next = parseOrInvalid(agentProfileSchema, {
        ...profile,
        name: input.name ?? profile.name,
        description: input.description ?? profile.description,
        personaId:
          input.personaId === null
            ? undefined
            : (input.personaId ?? profile.personaId),
        execution: input.execution ?? profile.execution,
        externalRuntimeId:
          input.externalRuntimeId === null
            ? undefined
            : (input.externalRuntimeId ?? profile.externalRuntimeId),
        allowedTools: input.allowedTools ?? profile.allowedTools,
        status: input.status ?? profile.status,
        updatedAt: iso(this.now()),
      });
      await this.tables.profiles.put(next.id, next);
      return next;
    });
  }

  runs(
    filter:
      | string
      | {
          workspaceId?: string | undefined;
          instanceId?: string | undefined;
          nodeId?: string | undefined;
          statuses?: readonly AgentRunStatus[] | undefined;
        },
  ): AgentRun[] {
    const criteria =
      typeof filter === "string" ? { instanceId: filter } : filter;
    return values(this.tables.runs)
      .filter(
        (run) =>
          (criteria.workspaceId === undefined ||
            run.workspaceId === criteria.workspaceId) &&
          (criteria.instanceId === undefined ||
            run.instanceId === criteria.instanceId) &&
          (criteria.nodeId === undefined || run.nodeId === criteria.nodeId) &&
          (criteria.statuses === undefined ||
            criteria.statuses.includes(run.status)),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.runSeq - left.runSeq,
      )
      .map((run) =>
        this.withLegacyExecutionMetadata(this.withObservedOutputTokens(run)),
      );
  }

  run(runId: string): AgentRun | undefined {
    const run = this.tables.runs.get(runId);
    return run === undefined
      ? undefined
      : this.withLegacyExecutionMetadata(this.withObservedOutputTokens(run));
  }

  progress(runId: string): AgentRunProgress | undefined {
    const run = this.run(runId);
    return run?.sessionId === undefined
      ? undefined
      : this.runtime?.progress(run.sessionId);
  }

  preflight(input: ExecutionPreflightInput): ExecutionPreflightResult {
    const execution = this.deps.execution?.();
    if (execution === undefined) {
      throw new AgentError("not_found", "Agent Execution Control 服务不可用");
    }
    return execution.preflight(input);
  }

  preflightForProfile(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly profileId: string;
    readonly principalId: string;
    readonly teammateId?: string | undefined;
    readonly ticketId?: string | undefined;
    readonly policy?: TaskExecutionPolicy | undefined;
  }): ExecutionPreflightResult {
    const profile = this.profile(input.workspaceId, input.profileId);
    if (profile === undefined) {
      throw new AgentError("not_found", "agent profile not found");
    }
    const runtime =
      profile.externalRuntimeId === undefined
        ? undefined
        : this.deps.externalRuntimes?.()?.get(profile.externalRuntimeId);
    if (
      profile.externalRuntimeId !== undefined &&
      (runtime === undefined || runtime.status !== "active")
    ) {
      throw new AgentError(
        "conflict",
        externalRuntimeUnavailableReason(runtime),
      );
    }
    return this.preflight({
      ...input,
      profile,
      ...(runtime === undefined ? {} : { runtime }),
    });
  }

  execution(runId: string): ExecutionProjection | undefined {
    return this.deps.execution?.()?.projection(runId);
  }

  executionEvents(
    runId: string,
    afterSeq = 0,
    limit = 500,
  ): readonly RunEvent[] {
    return this.deps.execution?.()?.listEvents(runId, afterSeq, limit) ?? [];
  }

  executionGates(runId: string): readonly ExecutionGate[] {
    return this.deps.execution?.()?.listGates(runId) ?? [];
  }

  executionGate(gateId: string): ExecutionGate | undefined {
    return this.deps.execution?.()?.gate(gateId);
  }

  decideExecutionGate(input: {
    readonly gateId: string;
    readonly decision: "approved" | "denied";
    readonly actorPrincipalId: string;
    readonly note?: string | undefined;
  }): Promise<ExecutionGate> {
    const execution = this.deps.execution?.();
    if (execution === undefined) {
      throw new AgentError("not_found", "Agent Execution Control 服务不可用");
    }
    return execution.decideGate(input);
  }

  taskExecution(
    taskId: string,
    workspaceId?: string | undefined,
  ): TaskExecutionProjection {
    const runs = this.runs({
      instanceId: taskId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    const selectedRun = runs[0];
    const projection =
      selectedRun === undefined
        ? undefined
        : this.deps.execution?.()?.projection(selectedRun.id);
    return {
      taskId,
      runs,
      ...(selectedRun === undefined ? {} : { selectedRunId: selectedRun.id }),
      ...(projection === undefined ? {} : { plan: projection.plan }),
      events: [...(projection?.events ?? [])],
      gates: [...(projection?.gates ?? [])],
      ...(projection === undefined ? {} : { snapshot: projection.snapshot }),
      capabilities: {
        planAvailable: projection !== undefined,
        contextAvailable:
          selectedRun?.contextPackId !== undefined ||
          this.deps.sessions?.()?.get(selectedRun?.sessionId ?? "") !==
            undefined,
        gateAvailable: this.deps.execution !== undefined,
        memoryAvailable: false,
      },
    };
  }

  dispatch(input: AgentDispatchInput): Promise<AgentRun> {
    return this.enqueue(async () => {
      const active = values(this.tables.runs).find(
        (run) =>
          run.dispatchKey === input.dispatchKey &&
          ACTIVE_RUN_STATUSES.includes(run.status),
      );
      if (active !== undefined) return active;
      const timestamp = iso(this.now());
      const run = parseOrInvalid(agentRunSchema, {
        id: `run-${randomUUID()}`,
        workspaceId: input.workspaceId,
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath }),
        agentProfileId: input.profileId,
        ...(input.personaId === undefined
          ? {}
          : { personaId: input.personaId }),
        ...(input.employeeId === undefined
          ? {}
          : { employeeId: input.employeeId }),
        ...(input.principalId === undefined
          ? {}
          : { principalId: input.principalId }),
        ...(input.principalType === undefined
          ? {}
          : { principalType: input.principalType }),
        ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        ...(input.contextPackId === undefined
          ? {}
          : { contextPackId: input.contextPackId }),
        ...(input.sessionBindingId === undefined
          ? {}
          : { sessionBindingId: input.sessionBindingId }),
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        source: input.source,
        instanceId: input.instanceId,
        nodeId: input.nodeId,
        dispatchKey: input.dispatchKey,
        trigger: input.trigger,
        status: "queued",
        attempt: input.attempt,
        runSeq: input.runSeq,
        maxAttempts: input.maxAttempts,
        timeoutMs: input.timeoutMs,
        payload: input.payload,
        createdBy: input.createdBy,
        createdAt: timestamp,
        updatedAt: timestamp,
        settleDelivered: false,
      });
      await this.tables.runs.put(run.id, run);
      const execution = this.deps.execution?.();
      if (execution !== undefined) {
        const profile = this.tables.profiles.get(run.agentProfileId);
        if (profile === undefined) {
          const failed = agentRunSchema.parse({
            ...run,
            status: "failed",
            error: "Agent Profile 不存在，无法创建执行计划",
            endedAt: iso(this.now()),
            updatedAt: iso(this.now()),
          });
          await this.tables.runs.put(failed.id, failed);
          await this.deliverSettle(failed);
          return failed;
        }
        const runtime =
          profile.externalRuntimeId === undefined
            ? undefined
            : this.deps.externalRuntimes?.()?.get(profile.externalRuntimeId);
        try {
          await execution.beginRun({
            run,
            profile,
            ...(runtime === undefined ? {} : { runtime }),
            ...(input.executionPolicy === undefined
              ? {}
              : { policy: input.executionPolicy }),
            ...(run.employeeId === undefined
              ? {}
              : { teammateId: run.employeeId }),
          });
        } catch (cause) {
          const message =
            cause instanceof Error
              ? cause.message
              : "创建 Agent Execution Plan 失败";
          const failed = agentRunSchema.parse({
            ...run,
            status: "failed",
            error: message.slice(0, 1_000),
            endedAt: iso(this.now()),
            updatedAt: iso(this.now()),
          });
          await this.tables.runs.put(failed.id, failed);
          await this.deliverSettle(failed);
          return failed;
        }
      }
      this.runtime?.enqueue(run);
      return run;
    });
  }

  cancel(runId: string): Promise<AgentRun> {
    return this.enqueue(async () => {
      const run = this.tables.runs.get(runId);
      if (run === undefined)
        throw new AgentError("not_found", "agent run not found");
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        throw new AgentError(
          "conflict",
          run.status === "succeeded"
            ? "Agent 运行已完成，无法取消"
            : "Agent 运行已结束，无法取消",
        );
      }
      this.runtime?.cancel(runId);
      await this.tables.runs.put(
        runId,
        agentRunSchema.parse({
          ...run,
          status: "cancelled",
          endedAt: iso(this.now()),
          updatedAt: iso(this.now()),
        }),
      );
      const saved = this.tables.runs.get(runId)!;
      await this.deliverSettle(saved);
      return saved;
    });
  }

  /** Re-enqueue queued runs and retire orphaned running runs after restart. */
  restore(): void {
    void this.detachLegacyChatSessions();
    for (const run of values(this.tables.runs)) {
      if (run.status === "queued") {
        this.runtime?.enqueue(run);
      } else if (run.status === "running") {
        void this.enqueue(async () => {
          await this.tables.runs.put(
            run.id,
            agentRunSchema.parse({
              ...run,
              status: "interrupted",
              error: "服务重启导致运行中断，可重试或转人工",
              endedAt: iso(this.now()),
              updatedAt: iso(this.now()),
            }),
          );
          const saved = this.tables.runs.get(run.id);
          if (saved === undefined) return;
          await this.runtime?.republishLegacyRestart(saved);
          await this.deliverSettle(saved);
        });
      } else if (run.status === "interrupted") {
        void this.enqueue(async () => {
          await this.runtime?.republishLegacyRestart(run);
        });
      }
    }
  }

  /**
   * Older builds attached de-chat sessions to the shared workspace tree.
   * Detach them during startup so project members cannot discover another
   * user's private AI conversation from the sidebar.
   */
  private async detachLegacyChatSessions(): Promise<void> {
    const workspaces = this.deps.workspaces?.();
    if (workspaces === undefined) return;
    const sessions = new Map<string, string>();
    for (const run of values(this.tables.runs)) {
      if (run.source !== "chat" || run.sessionId === undefined) continue;
      sessions.set(run.sessionId, run.workspaceId);
    }
    for (const [sessionId, workspaceId] of sessions) {
      const workspace = workspaces.get?.(workspaceId);
      if (workspace?.detachSession === undefined) continue;
      await workspace.detachSession(sessionId).catch(() => undefined);
    }
  }

  bindWorkflow(handler: AgentWorkflowHandler): void {
    this.workflowHandler = handler;
    for (const run of values(this.tables.runs)) {
      if (
        run.source === "workflow" &&
        !run.settleDelivered &&
        TERMINAL_RUN_STATUSES.includes(run.status)
      ) {
        this.pendingSettles.add(run.id);
      }
    }
    void this.flushSettles();
  }

  bindTask(handler: AgentTaskHandler): void {
    this.taskHandler = handler;
    for (const run of values(this.tables.runs)) {
      if (
        run.source === "task" &&
        !run.settleDelivered &&
        TERMINAL_RUN_STATUSES.includes(run.status)
      ) {
        this.pendingSettles.add(run.id);
      }
    }
    void this.flushSettles();
  }

  private deliverSettle(run: AgentRun): void {
    this.pendingSettles.add(run.id);
    // Never await callbacks: cancellation may originate while the owning
    // service already holds its own operation lock.
    void this.flushSettles();
  }

  private async flushSettles(): Promise<void> {
    if (this.workflowHandler === undefined && this.taskHandler === undefined) {
      return;
    }
    if (this.flushingSettles) return;
    this.flushingSettles = true;
    try {
      for (const runId of Array.from(this.pendingSettles)) {
        const run = this.tables.runs.get(runId);
        if (run === undefined || run.settleDelivered) {
          this.pendingSettles.delete(runId);
          continue;
        }
        const handler =
          run.source === "workflow"
            ? this.workflowHandler
            : run.source === "task"
              ? this.taskHandler
              : undefined;
        if (handler === undefined) continue;
        try {
          await handler.onSettled(run);
          await this.markSettleDelivered(runId);
          this.pendingSettles.delete(runId);
        } catch {
          // Keep pending; replay on next bind.
        }
      }
    } finally {
      this.flushingSettles = false;
    }
  }

  private async markSettleDelivered(runId: string): Promise<void> {
    const run = this.tables.runs.get(runId);
    if (run === undefined || run.settleDelivered) return;
    await this.tables.runs.put(
      runId,
      agentRunSchema.parse({ ...run, settleDelivered: true }),
    );
  }
}

function errorStatus(code: AgentError["code"]): number {
  if (code === "invalid_input") return 400;
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "method_not_allowed") return 405;
  return 409;
}

async function runHandler(
  operation: () => Promise<void>,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof AgentError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "agent operation failed" },
    });
  }
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): AgentActor {
  const headers = request.headers;
  if (
    headers.origin !== undefined &&
    !sameOrigin(headers.origin, headers.host)
  ) {
    throw new AgentError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (header) =>
      header === "authorization" ? (headers.authorization ?? null) : null,
  });
  if (token === undefined)
    throw new AgentError("unauthorized", "bearer token is required");
  const principal = team.resolveToken(token);
  if (principal === undefined)
    throw new AgentError("unauthorized", "invalid bearer token");
  const member = team
    .members(workspaceId)
    .find((candidate) => candidate.userId === principal.userId);
  if (member === undefined && principal.role !== "admin")
    throw new AgentError("forbidden", "workspace member role is required");
  return {
    kind: "user",
    id: principal.userId,
    globalRole: principal.role,
    workspaceId,
    ...(member === undefined
      ? {}
      : { workspaceRole: member.memberRole as AgentActor["workspaceRole"] }),
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request);
  } catch {
    throw new AgentError("invalid_input", "valid JSON body is required");
  }
}

function queryParam(
  request: IncomingMessage,
  name: string,
): string | undefined {
  return (
    new URL(request.url ?? "/", "http://localhost").searchParams.get(name) ??
    undefined
  );
}

function assertMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: "GET" | "POST",
): void {
  if (request.method !== method) {
    throw new AgentError("method_not_allowed", "method not allowed");
  }
}

export function createAgentRoutes(
  service: AgentRegistryService,
  team: () => TeamServiceLike | undefined,
  personas?: () => PersonaServiceLike | undefined,
  externalRuntimes?: () => ExternalAgentRuntimeService | undefined,
  onRuntimeUnavailable?: (input: {
    readonly runtime: ExternalAgentRuntime;
    readonly previousStatus?: ExternalAgentRuntime["status"] | undefined;
    readonly actor: AgentActor;
  }) => Promise<readonly string[]> | readonly string[],
): WebRouteLike[] {
  const requireTeam = (): TeamServiceLike => {
    const value = team();
    if (value === undefined)
      throw new AgentError("not_found", "identity service is unavailable");
    return value;
  };
  const pauseBoundTeammates = async (
    runtime: ExternalAgentRuntime,
    actor: AgentActor,
    previousStatus?: ExternalAgentRuntime["status"],
  ): Promise<readonly string[]> => {
    if (runtime.status === "active" || onRuntimeUnavailable === undefined) {
      return [];
    }
    return await onRuntimeUnavailable({ runtime, previousStatus, actor });
  };
  return [
    {
      kind: "exact",
      path: "/api/collab/agent/profiles",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId") ?? "";
          if (workspaceId === "")
            throw new AgentError("invalid_input", "workspaceId is required");
          browserActor(requireTeam(), request, workspaceId);
          sendJson(response, 200, {
            ok: true,
            profiles: service.profiles(workspaceId),
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId") ?? "";
          if (workspaceId === "")
            throw new AgentError("invalid_input", "workspaceId is required");
          const actor = browserActor(requireTeam(), request, workspaceId);
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const includeArchived = ["1", "true"].includes(
            (queryParam(request, "includeArchived") ?? "").toLowerCase(),
          );
          sendJson(response, 200, {
            ok: true,
            runtimes: runtimeService.list(workspaceId, { includeArchived }),
            canManage: isManager(actor),
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes/create",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              id: z.string().trim().optional(),
              name: z.string().trim().min(1).max(120),
              provider: z.enum(["codex", "workbuddy", "command"]),
              protocol: z.enum(["codex-jsonl", "plain-text"]),
              command: z.string().trim().min(1).max(500),
              args: z.array(z.string().min(1).max(1_000)).max(50).optional(),
              customArgs: z
                .array(z.string().min(1).max(1_000))
                .max(50)
                .optional(),
              supportedTools: z
                .array(runtimeToolNameSchema)
                .max(RUNTIME_TOOL_NAMES.length)
                .optional(),
              supportedModels: z
                .array(z.string().trim().min(1).max(160))
                .max(50)
                .optional(),
              defaultModel: z.string().trim().min(1).max(160).optional(),
              contextWindowTokens: z
                .number()
                .int()
                .min(1_000)
                .max(10_000_000)
                .optional(),
              status: z.enum(["active", "disabled", "archived"]).optional(),
              visibility: z.enum(["workspace", "platform"]).optional(),
            })
            .parse(await readBody(request));
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const runtime = await runtimeService.create(actor, {
            ...body,
            workspaceId: body.workspaceId,
          });
          sendJson(response, 201, { ok: true, runtime });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes/update",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              runtimeId: z.string().min(1),
              name: z.string().trim().min(1).max(120).optional(),
              provider: z.enum(EXTERNAL_AGENT_PROVIDERS).optional(),
              protocol: z.enum(EXTERNAL_AGENT_PROTOCOLS).optional(),
              command: z.string().trim().min(1).max(500).optional(),
              args: z.array(z.string().min(1).max(1_000)).max(50).optional(),
              customArgs: z
                .array(z.string().min(1).max(1_000))
                .max(50)
                .optional(),
              supportedTools: z
                .array(runtimeToolNameSchema)
                .max(RUNTIME_TOOL_NAMES.length)
                .optional(),
              supportedModels: z
                .array(z.string().trim().min(1).max(160))
                .max(50)
                .optional(),
              defaultModel: z
                .string()
                .trim()
                .min(1)
                .max(160)
                .nullable()
                .optional(),
              contextWindowTokens: z
                .number()
                .int()
                .min(1_000)
                .max(10_000_000)
                .nullable()
                .optional(),
              status: z.enum(["active", "disabled", "archived"]).optional(),
            })
            .parse(await readBody(request));
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const previous = runtimeService.get(body.runtimeId);
          const runtime = await runtimeService.update(actor, body);
          const pausedTeammateIds = await pauseBoundTeammates(
            runtime,
            actor,
            previous?.status,
          );
          sendJson(response, 200, { ok: true, runtime, pausedTeammateIds });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes/archive",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              runtimeId: z.string().min(1),
            })
            .parse(await readBody(request));
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const previous = runtimeService.get(body.runtimeId);
          const runtime = await runtimeService.archive(actor, body);
          const pausedTeammateIds = await pauseBoundTeammates(
            runtime,
            actor,
            previous?.status,
          );
          sendJson(response, 200, { ok: true, runtime, pausedTeammateIds });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes/restore",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              runtimeId: z.string().min(1),
            })
            .parse(await readBody(request));
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const previous = runtimeService.get(body.runtimeId);
          const runtime = await runtimeService.restore(actor, body);
          const pausedTeammateIds = await pauseBoundTeammates(
            runtime,
            actor,
            previous?.status,
          );
          sendJson(response, 200, { ok: true, runtime, pausedTeammateIds });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/external-runtimes/probe",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              runtimeId: z.string().min(1),
            })
            .parse(await readBody(request));
          const runtimeService = externalRuntimes?.();
          if (runtimeService === undefined)
            throw new AgentError("not_found", "外部 Agent 服务不可用");
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const current = runtimeService.requireForManagement(
            body.runtimeId,
            actor,
          );
          const probe = await probeExternalRuntime(current.command);
          const runtime = await runtimeService.markProbe(
            body.runtimeId,
            probe,
            actor,
          );
          sendJson(response, 200, { ok: true, runtime, probe });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/profiles/create",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              id: z
                .string()
                .trim()
                .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
                .optional(),
              name: z.string().trim().min(1).max(120),
              description: z.string().trim().max(1_000).optional(),
              personaId: z.string().trim().optional(),
              execution: z.enum(["builtin", "external"]).optional(),
              externalRuntimeId: z.string().trim().optional(),
              runtimeKind: z
                .enum(["task-worker", "continuable-session", "connector"])
                .optional(),
              allowedTools: z
                .array(z.string().trim().min(1))
                .max(50)
                .optional(),
            })
            .parse(await readBody(request));
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          if (body.personaId !== undefined) {
            const personaRegistry = personas?.();
            if (personaRegistry !== undefined) {
              try {
                await personaRegistry.get(body.personaId);
              } catch {
                throw new AgentError(
                  "invalid_input",
                  `persona does not exist: ${body.personaId}`,
                );
              }
            }
          }
          const profile = await service.createProfile(actor, body);
          sendJson(response, 201, { ok: true, profile });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/profiles/update",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              profileId: z.string().min(1),
              name: z.string().trim().min(1).max(120).optional(),
              description: z.string().trim().max(1_000).optional(),
              personaId: z.string().trim().nullable().optional(),
              execution: z.enum(["builtin", "external"]).optional(),
              externalRuntimeId: z.string().trim().nullable().optional(),
              allowedTools: z
                .array(z.string().trim().min(1))
                .max(50)
                .optional(),
              status: z.enum(["active", "disabled"]).optional(),
            })
            .parse(await readBody(request));
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          if (body.personaId !== undefined && body.personaId !== null) {
            const personaRegistry = personas?.();
            if (personaRegistry !== undefined) {
              try {
                await personaRegistry.get(body.personaId);
              } catch {
                throw new AgentError(
                  "invalid_input",
                  `persona does not exist: ${body.personaId}`,
                );
              }
            }
          }
          const profile = await service.updateProfile(actor, body);
          sendJson(response, 200, { ok: true, profile });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/runs",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId");
          if (workspaceId === undefined || workspaceId === "")
            throw new AgentError("invalid_input", "workspaceId is required");
          browserActor(requireTeam(), request, workspaceId);
          const instanceId = queryParam(request, "instanceId");
          const nodeId = queryParam(request, "nodeId");
          sendJson(response, 200, {
            ok: true,
            runs: service.runs({
              workspaceId,
              ...(instanceId === undefined ? {} : { instanceId }),
              ...(nodeId === undefined ? {} : { nodeId }),
            }),
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/runs/detail",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId");
          const runId = queryParam(request, "runId");
          if (workspaceId === undefined || workspaceId === "")
            throw new AgentError("invalid_input", "workspaceId is required");
          if (runId === undefined || runId === "")
            throw new AgentError("invalid_input", "runId is required");
          browserActor(requireTeam(), request, workspaceId);
          const run = service.run(runId);
          if (run === undefined || run.workspaceId !== workspaceId)
            throw new AgentError("not_found", "agent run not found");
          sendJson(response, 200, {
            ok: true,
            run,
            progress: service.progress(runId) ?? null,
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/execution/preflight",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              taskId: z.string().min(1),
              profileId: z.string().min(1),
              principalId: z.string().trim().min(1).optional(),
              teammateId: z.string().trim().min(1).optional(),
              runtimeId: z.string().trim().min(1).optional(),
              policy: taskExecutionPolicySchema.optional(),
            })
            .parse(await readBody(request));
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const profile = service.profile(body.workspaceId, body.profileId);
          if (profile === undefined) {
            throw new AgentError("not_found", "agent profile not found");
          }
          const runtimeId = body.runtimeId ?? profile.externalRuntimeId;
          const runtime =
            runtimeId === undefined
              ? undefined
              : externalRuntimes?.()?.get(runtimeId);
          if (
            runtimeId !== undefined &&
            (runtime === undefined || runtime.status !== "active")
          ) {
            throw new AgentError(
              "conflict",
              externalRuntimeUnavailableReason(runtime),
            );
          }
          const result = service.preflight({
            taskId: body.taskId,
            workspaceId: body.workspaceId,
            principalId: body.principalId ?? actor.id,
            ...(body.teammateId === undefined
              ? {}
              : { teammateId: body.teammateId }),
            ...(body.policy === undefined ? {} : { policy: body.policy }),
            profile,
            ...(runtime === undefined ? {} : { runtime }),
          });
          sendJson(response, 200, { ok: true, result });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/execution/detail",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId");
          const runId = queryParam(request, "runId");
          if (workspaceId === undefined || workspaceId === "") {
            throw new AgentError("invalid_input", "workspaceId is required");
          }
          if (runId === undefined || runId === "") {
            throw new AgentError("invalid_input", "runId is required");
          }
          browserActor(requireTeam(), request, workspaceId);
          const run = service.run(runId);
          if (run === undefined || run.workspaceId !== workspaceId) {
            throw new AgentError("not_found", "agent run not found");
          }
          sendJson(response, 200, {
            ok: true,
            execution: service.execution(runId) ?? null,
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/execution/events",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId");
          const runId = queryParam(request, "runId");
          if (workspaceId === undefined || workspaceId === "") {
            throw new AgentError("invalid_input", "workspaceId is required");
          }
          if (runId === undefined || runId === "") {
            throw new AgentError("invalid_input", "runId is required");
          }
          browserActor(requireTeam(), request, workspaceId);
          const run = service.run(runId);
          if (run === undefined || run.workspaceId !== workspaceId) {
            throw new AgentError("not_found", "agent run not found");
          }
          const afterSeq = Number(queryParam(request, "afterSeq") ?? "0");
          const limit = Number(queryParam(request, "limit") ?? "500");
          sendJson(response, 200, {
            ok: true,
            events: service.executionEvents(
              runId,
              Number.isFinite(afterSeq) ? afterSeq : 0,
              Number.isFinite(limit) ? limit : 500,
            ),
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/execution/task",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "GET");
          const workspaceId = queryParam(request, "workspaceId");
          const taskId = queryParam(request, "taskId");
          if (workspaceId === undefined || workspaceId === "") {
            throw new AgentError("invalid_input", "workspaceId is required");
          }
          if (taskId === undefined || taskId === "") {
            throw new AgentError("invalid_input", "taskId is required");
          }
          browserActor(requireTeam(), request, workspaceId);
          sendJson(response, 200, {
            ok: true,
            execution: service.taskExecution(taskId, workspaceId),
          });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/execution/gates/decide",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              gateId: z.string().min(1),
              decision: z.enum(["approved", "denied"]),
              note: z.string().trim().max(4_000).optional(),
              principalId: z.string().trim().min(1).optional(),
            })
            .parse(await readBody(request));
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          if (actor.globalRole !== "admin" && actor.workspaceRole === "guest") {
            throw new AgentError("forbidden", "guest 不能批准 Agent 执行授权");
          }
          const gate = service.executionGate(body.gateId);
          if (gate === undefined || gate.workspaceId !== body.workspaceId) {
            throw new AgentError("not_found", "execution gate not found");
          }
          const decided = await service.decideExecutionGate({
            gateId: body.gateId,
            decision: body.decision,
            actorPrincipalId: body.principalId ?? actor.id,
            ...(body.note === undefined ? {} : { note: body.note }),
          });
          sendJson(response, 200, { ok: true, gate: decided });
        }, response);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/agent/runs/cancel",
      handler: (request, response) => {
        void runHandler(async () => {
          assertMethod(request, response, "POST");
          const body = z
            .object({
              workspaceId: z.string().min(1),
              runId: z.string().min(1),
            })
            .parse(await readBody(request));
          const actor = browserActor(requireTeam(), request, body.workspaceId);
          const run = service.run(body.runId);
          if (run === undefined || run.workspaceId !== body.workspaceId)
            throw new AgentError("not_found", "agent run not found");
          if (!isManager(actor))
            throw new AgentError(
              "forbidden",
              "workspace owner or admin is required",
            );
          const saved = await service.cancel(body.runId);
          sendJson(response, 200, { ok: true, run: saved });
        }, response);
      },
    },
  ];
}

interface ToolPreExecutionLike {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly agent?:
    | {
        readonly session?:
          | {
              readonly id?: string | undefined;
            }
          | undefined;
      }
    | undefined;
}

type PreToolDecisionLike =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask"; readonly reason?: string | undefined };

export interface AgentContext {
  storageDomain: {
    open(spec: typeof agentDomainSpec): Promise<AgentDomainLike>;
    open(spec: typeof executionDomainSpec): Promise<ExecutionDomainLike>;
  };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: "collabAgent", service: AgentRegistryService): void;
  provide(key: "collabAgentExecution", service: AgentExecutionService): void;
  effect(operation: () => () => void): void;
  collabTeam?: TeamServiceLike;
  collabPersonas?: PersonaServiceLike;
  agents?: AgentsRegistryLike;
  agentDefaultModel?: AgentDefaultModelLike;
  subagents?: SubagentsRuntimeLike;
  workspaceRegistry?: WorkspaceRegistryLike;
  sessions?: AgentSessionsLike;
  sessionTitle?: AgentSessionTitleLike;
  get(key: "collabTeam"): TeamServiceLike | undefined;
  get(key: "collabPersonas"): PersonaServiceLike | undefined;
  get(key: "agents"): AgentsRegistryLike | undefined;
  get(key: "subagents"): SubagentsRuntimeLike | undefined;
  get(key: "workspaceRegistry"): WorkspaceRegistryLike | undefined;
  get(key: "sessions"): AgentSessionsLike | undefined;
  get(key: "sessionPersistence"): AgentSessionPersistenceLike | undefined;
  get(key: "sessionTitle"): AgentSessionTitleLike | undefined;
  get(key: "collabTeammates"): RuntimeBoundTeammateServiceLike | undefined;
  on?(
    event: "agent/assistant-stream",
    listener: (payload: unknown) => void,
  ): () => void;
  on?(
    event: "tools/pre-execute",
    listener: (
      exec: ToolPreExecutionLike,
      next: () => Promise<PreToolDecisionLike>,
    ) => Promise<PreToolDecisionLike>,
  ): () => void;
  emit?(event: string, payload?: unknown): void;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: AgentContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void } | void;
}

interface RuntimeBoundTeammateServiceLike {
  pauseForExternalRuntime(input: {
    readonly runtimeId: string;
    readonly runtimeName: string;
    readonly runtimeStatus: "disabled" | "archived";
    readonly actor: {
      readonly userId: string;
      readonly name: string;
      readonly role: "admin" | "owner" | "member" | "guest";
    };
  }): Promise<readonly { readonly id: string }[]>;
}

export async function apply(ctx: AgentContext): Promise<void | (() => void)> {
  const domain = await ctx.storageDomain.open(agentDomainSpec);
  const executionDomain = await ctx.storageDomain.open(executionDomainSpec);
  const executionService = new AgentExecutionService({
    capabilities: executionDomain.table("capabilities"),
    envelopes: executionDomain.table("envelopes"),
    plans: executionDomain.table("plans"),
    runEvents: executionDomain.table("run_events"),
    gates: executionDomain.table("gates"),
    snapshots: executionDomain.table("snapshots"),
    outbox: executionDomain.table("outbox"),
  });
  const service = new AgentRegistryService(
    {
      profiles: domain.table("profiles"),
      runs: domain.table("runs"),
    },
    {
      sessions: () => ctx.get("sessions"),
      sessionPersistence: () => ctx.get("sessionPersistence"),
      workspaces: () => ctx.get("workspaceRegistry"),
      externalRuntimes: () => domain.table("external_runtimes"),
      execution: () => executionService,
    },
  );
  const externalRuntimeService = new ExternalAgentRuntimeService(
    domain.table("external_runtimes"),
    { onTrace: terminalExternalAgentRuntimeTrace },
  );
  const runtime = new AgentTaskRuntime({
    tables: {
      profiles: domain.table("profiles"),
      runs: domain.table("runs"),
    },
    externalRuntimes: () => domain.table("external_runtimes"),
    externalRunner: () =>
      new ExternalAgentProcessRunner({ onTrace: terminalExternalAgentTrace }),
    subagents: () => ctx.get("subagents"),
    agents: () => ctx.get("agents"),
    personas: () => ctx.get("collabPersonas"),
    defaultModel: () => ctx.agentDefaultModel,
    workspaces: () => ctx.get("workspaceRegistry"),
    sessions: () => ctx.get("sessions"),
    sessionPersistence: () => ctx.get("sessionPersistence"),
    sessionTitle: () => ctx.get("sessionTitle"),
    execution: () => executionService,
    onSettled: async (run) => {
      await service.onRuntimeSettled(run);
      try {
        ctx.emit?.("collab/agent-run-settled", {
          runId: run.id,
          workspaceId: run.workspaceId,
          status: run.status,
          source: run.source,
          instanceId: run.instanceId,
        });
      } catch {
        // Domain events are best-effort.
      }
    },
  });
  service.attachRuntime(runtime);
  await runtime.migrateLegacySessionTitles();
  const streamDisposer = ctx.on?.("agent/assistant-stream", (payload) => {
    const value = payload as
      | {
          readonly agent?: { readonly session?: { readonly id?: string } };
          readonly frame?: unknown;
        }
      | undefined;
    const sessionId = value?.agent?.session?.id;
    if (sessionId !== undefined) runtime.recordStream(sessionId, value?.frame);
  });
  ctx.provide("collabAgent", service);
  ctx.provide("collabAgentExecution", executionService);
  const toolGateDisposer = ctx.on?.(
    "tools/pre-execute",
    async (exec, next): Promise<PreToolDecisionLike> => {
      const sessionId = exec.agent?.session?.id;
      if (sessionId === undefined) return next();
      const runId = executionService.runIdForSession(sessionId);
      if (runId === undefined) return next();
      const category = executionToolCategory(exec.name);
      const disposition = executionService.gateDisposition(runId, category);
      if (disposition === "allow") return next();
      if (disposition === "deny") {
        return {
          kind: "deny",
          reason: `执行策略禁止工具类别：${category}`,
        };
      }
      const envelope = executionService.envelopeForRun(runId);
      if (envelope?.resolved.gateEnforcement !== "blocking") {
        return {
          kind: "deny",
          reason: `Runtime 无法阻断式执行 ${category}，请改用支持的 Runtime`,
        };
      }
      const decision = await executionService.requestGate({
        runId,
        kind: "tool-approval",
        reason: `Agent 请求使用需要审批的工具类别：${category}`,
        requestedToolCategory: category,
        requestedScope: [exec.name],
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      });
      return decision === "approved"
        ? next()
        : {
            kind: "deny",
            reason:
              decision === "expired"
                ? `执行授权已超时：${category}`
                : `用户拒绝执行：${category}`,
          };
    },
  );
  // Let sibling runtime plugins finish mounting before replaying persisted runs.
  const restoreTimer = setTimeout(() => {
    service.restore();
    void service.backfillOutputTokens().catch(() => undefined);
  }, 1_000);
  ctx.effect(() => () => {
    clearTimeout(restoreTimer);
    streamDisposer?.();
    toolGateDisposer?.();
    void runtime.dispose();
    void Promise.allSettled([domain.close(), executionDomain.close()]);
  });
  const identityFiber = ctx.inject(["collabTeam"], (child) => {
    for (const route of createAgentRoutes(
      service,
      () => child.collabTeam,
      () => ctx.get("collabPersonas"),
      () => externalRuntimeService,
      async ({ runtime, actor }) => {
        if (runtime.status === "active") return [];
        const teammates = ctx.get("collabTeammates");
        if (teammates === undefined) return [];
        const paused = await teammates.pauseForExternalRuntime({
          runtimeId: runtime.id,
          runtimeName: runtime.name,
          runtimeStatus: runtime.status,
          actor: {
            userId: actor.id,
            name: actor.name ?? actor.id,
            role: actor.globalRole ?? actor.workspaceRole ?? "member",
          },
        });
        return paused.map((teammate) => teammate.id);
      },
    )) {
      ctx.webServer.register(route);
    }
  });
  return () => {
    identityFiber?.dispose();
  };
}
