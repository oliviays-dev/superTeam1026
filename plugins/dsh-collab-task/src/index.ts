import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  bearerToken,
  readJsonBody,
  resolveWithin,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import {
  legacyTaskExecutionPolicy,
  type ExecutionGate,
  type ExecutionPreflightResult,
  type TaskExecutionPolicy,
  type TaskExecutionProjection,
} from "@pluginmax/contracts";
import {
  TaskError,
  TaskService,
  taskDomainSpec,
  type KvTableLike,
  type TaskActor,
  type TaskAgentRun,
  type TaskPrincipalServiceLike,
} from "./service.js";
import type { TaskRecord } from "./types.js";
import {
  attachmentDocuments,
  collectDocuments,
  materializeAgentOutputDocuments,
  mergeDocuments,
  mimeTypeFor,
  safeFileName,
  toRelativePath,
  uploadDirectory,
  windowsFromRuns,
  type TaskDocumentEntry,
} from "./documents.js";

export { TaskError, TaskService, taskDomainSpec };
export type { TaskActor, TaskRecord };

export const name = "dsh-collab-task";
export const inject = ["storageDomain", "webServer"];

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface WorkspaceUserLike {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

interface WorkspaceMemberLike {
  readonly userId: string;
  readonly memberRole?: string;
}

interface TeamPrincipalLike {
  readonly userId: string;
  readonly role?: "admin" | "owner" | "member" | "guest" | undefined;
}

interface TeamServiceLike {
  resolveToken(token: string): TeamPrincipalLike | undefined;
  users(): readonly WorkspaceUserLike[];
  members(workspaceId: string): readonly WorkspaceMemberLike[];
}

interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): WorkspaceLike | undefined;
  list(): readonly WorkspaceLike[];
}

interface TeammateRuntimeActorLike {
  readonly userId: string;
  readonly name: string;
  readonly role: "admin" | "owner" | "member" | "guest";
}

interface TeammateRuntimeLike {
  assignable(actor: TeammateRuntimeActorLike): readonly {
    readonly id: string;
    readonly name: string;
    readonly ownerUserId: string;
    readonly ownerName: string;
    readonly source: "platform" | "personal";
    readonly avatar: string;
    readonly employeeId?: string | undefined;
    readonly execution?: "builtin" | "external" | undefined;
    readonly externalRuntimeId?: string | undefined;
  }[];
  ownerOf?(
    ref: string,
  ): { readonly userId: string; readonly name: string } | undefined;
  ensureRuntime(input: {
    readonly teammateId: string;
    readonly workspaceId: string;
    readonly actor: TeammateRuntimeActorLike;
  }): Promise<{
    readonly teammateId: string;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
    readonly profileId: string;
    readonly personaId?: string | undefined;
    readonly execution?: "builtin" | "external" | undefined;
    readonly externalRuntimeId?: string | null | undefined;
  }>;
}

interface EmployeeLike {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human" | "digital";
  readonly status: string;
  readonly principalId?: string | undefined;
  readonly authUserId?: string | undefined;
  readonly personaId?: string | undefined;
  readonly managerEmployeeId?: string | undefined;
}

interface EmployeeServiceLike {
  list(): readonly EmployeeLike[];
  employeeWorkspaceTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: EmployeeLike;
        readonly assignment: unknown;
      }
    | undefined;
  workflowTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: EmployeeLike;
        readonly profile: {
          readonly name: string;
          readonly legacyAgentProfileId?: string | undefined;
          readonly budget?:
            { readonly maxMinutes?: number | undefined } | undefined;
        };
      }
    | undefined;
}

interface PrincipalRuntimeServiceLike {
  profile(
    principalId: string,
    workspaceId: string,
  ): { readonly id: string } | undefined;
  issueTicket(input: {
    readonly principalId: string;
    readonly workspaceId: string;
    readonly contextType: "task";
    readonly contextId: string;
    readonly requestedActions: readonly string[];
    readonly resourceScopes?: readonly string[];
    readonly durationMinutes?: number;
    readonly issuedByUserId: string;
  }): Promise<{ readonly id: string }>;
}

interface TaskAgentServiceLike {
  preflightForProfile?(input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly profileId: string;
    readonly principalId: string;
    readonly teammateId?: string | undefined;
    readonly ticketId?: string | undefined;
    readonly policy?: TaskExecutionPolicy | undefined;
  }): ExecutionPreflightResult;
  taskExecution?(
    taskId: string,
    workspaceId?: string | undefined,
  ): TaskExecutionProjection;
  executionGate?(gateId: string): ExecutionGate | undefined;
  decideExecutionGate?(input: {
    readonly gateId: string;
    readonly decision: "approved" | "denied";
    readonly actorPrincipalId: string;
    readonly note?: string | undefined;
  }): Promise<ExecutionGate>;
  run?(runId: string):
    | {
        /** 该轮执行落在哪条 DSH 会话里（会话尚未启动时缺省）。 */
        readonly sessionId?: string | undefined;
        readonly payload?: {
          readonly context?: Record<string, string | number | boolean>;
        };
      }
    | undefined;
  dispatch(input: {
    readonly workspaceId: string;
    readonly workspacePath?: string | undefined;
    readonly profileId: string;
    readonly source: "task" | "meeting";
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
      | "transitional-agent"
      | "digital-employee"
      | "principal-runtime"
      | undefined;
    readonly ticketId?: string | undefined;
    readonly contextPackId?: string | undefined;
    readonly sessionBindingId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly executionPolicy?: TaskExecutionPolicy | undefined;
    readonly payload: {
      readonly instanceTitle: string;
      readonly nodeName: string;
      readonly nodeDescription: string;
      readonly profileName: string;
      readonly responsibleId?: string | undefined;
      readonly deliverables: readonly {
        readonly key: string;
        readonly title: string;
        readonly type: "file" | "text" | "link";
        readonly required: boolean;
        readonly description: string;
        readonly minTextLength?: number | undefined;
      }[];
      readonly context: Record<string, string | number | boolean>;
    };
    readonly createdBy: string;
  }): Promise<TaskAgentRun>;
  bindTask(handler: {
    onSettled(run: TaskAgentRun): Promise<void> | void;
  }): void;
  syncTaskSessionTitles?(titles: ReadonlyMap<string, string>): Promise<void>;
  runs?(filter: {
    readonly workspaceId?: string | undefined;
    readonly instanceId?: string | undefined;
  }): readonly TaskAgentRunSummary[];
}

interface ContextSourceRefLike {
  readonly type:
    | "task"
    | "meeting"
    | "minute-version"
    | "workflow"
    | "document"
    | "chat"
    | "task-comment"
    | "human-edit";
  readonly id: string;
  readonly version?: string;
  readonly quote?: string;
}

export interface TaskContextContribution {
  readonly id: string;
  readonly version: string;
  readonly text: string;
  readonly sourceRefs: readonly ContextSourceRefLike[];
}

interface TaskContextPackLike {
  readonly id: string;
  readonly sessionBindingId: string;
  readonly rendered: {
    readonly systemText: string;
    readonly userText: string;
    readonly flattenedPrompt: string;
  };
}

interface TaskContextServiceLike {
  registerAdapter(adapter: {
    readonly scene: "task";
    resolve(input: {
      readonly workspaceId?: string;
      readonly objectId: string;
      readonly agentPrincipalId: string;
      readonly actorPrincipalId: string;
    }): Promise<{
      readonly allowed: boolean;
      readonly workspaceId?: string;
      readonly sceneRevision: string;
      readonly sourceRefs: readonly ContextSourceRefLike[];
    }>;
    loadFacts(input: {
      readonly workspaceId?: string;
      readonly objectId: string;
      readonly agentPrincipalId: string;
      readonly asOf: string;
    }): Promise<{
      readonly text: string;
      readonly structured?: Readonly<Record<string, unknown>>;
      readonly sourceRefs: readonly ContextSourceRefLike[];
      readonly historyText?: string;
      readonly contributions?: readonly TaskContextContribution[];
    }>;
    policy(input: {
      readonly scene: "task";
      readonly objectId: string;
      readonly agentPrincipalId: string;
    }): Promise<{
      readonly version: string;
      readonly instructions: string;
      readonly allowedWriteback: readonly (
        "agent-private-memory" | "run-evidence" | "memory-candidate"
      )[];
      readonly policySections?: {
        readonly executionPolicy?: string | undefined;
        readonly sourcePolicy?: string | undefined;
      };
    }>;
  }): () => void;
  prepare(input: Record<string, unknown>): Promise<TaskContextPackLike>;
  session?(bindingId: string):
    | {
        readonly sessionId: string;
        readonly generation: number;
      }
    | undefined;
  recordRuntime(input: {
    readonly runId: string;
    readonly contextPackId: string;
    readonly runtime: {
      readonly kind: "builtin" | "external";
      readonly provider?: string;
      readonly model?: string;
      readonly externalSessionId?: string;
    };
  }): Promise<unknown>;
}

interface TaskAgentRunSummary {
  readonly id: string;
  readonly nodeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly status: TaskAgentRun["status"];
  readonly createdAt?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly execution?: TaskAgentRun["execution"] | undefined;
  readonly payload?:
    | {
        readonly profileName?: string | undefined;
        readonly context?:
          Record<string, string | number | boolean> | undefined;
      }
    | undefined;
  readonly output?: TaskAgentRun["output"] | undefined;
  readonly error?: string | undefined;
}

export interface TaskDocumentQueryOptions {
  readonly includeUploaded?: boolean;
  readonly maxFiles?: number;
}

export interface TaskDocumentQueryResult {
  readonly workspaceReady: boolean;
  readonly documents: readonly TaskDocumentEntry[];
}

export interface TaskDocumentQueryService {
  list(
    taskId: string,
    options?: TaskDocumentQueryOptions,
  ): Promise<TaskDocumentQueryResult>;
}

function taskRunActorName(
  task: Pick<TaskRecord, "receiverId" | "receiverName">,
  run: {
    readonly payload?:
      | {
          readonly profileName?: string | undefined;
          readonly context?:
            Record<string, string | number | boolean> | undefined;
        }
      | undefined;
  },
): string {
  const receiverName = run.payload?.context?.taskReceiverName;
  if (typeof receiverName === "string" && receiverName.trim() !== "") {
    return receiverName;
  }
  return (
    run.payload?.profileName?.trim() ||
    task.receiverName ||
    task.receiverId ||
    "Agent"
  );
}

function taskAgentDisplayName(task: TaskRecord): string {
  return task.receiverName ?? task.receiverId ?? "Agent";
}

export function createTaskDocumentQueryService(
  service: TaskService,
  agent: () => TaskAgentServiceLike | undefined,
  workspaces: WorkspaceRegistryLike | undefined,
): TaskDocumentQueryService {
  return {
    async list(taskId, options = {}) {
      const task = service.get(taskId);
      const root = workspaces?.get(task.workspaceId)?.path;
      if (root === undefined) {
        return { workspaceReady: false, documents: [] };
      }
      const agentService = agent();
      const taskRuns =
        agentService?.runs?.({
          workspaceId: task.workspaceId,
          instanceId: task.id,
        }) ?? [];
      const taskRunIds = new Set(taskRuns.map((run) => run.id));
      const allRuns =
        agentService?.runs?.({ workspaceId: task.workspaceId }) ?? taskRuns;
      const runs = allRuns.filter(
        (run) =>
          taskRunIds.has(run.id) || run.payload?.context?.taskId === task.id,
      );
      const ownerRuns = runs.filter(
        (run) => (run.payload?.context?.taskRunRole ?? "owner") === "owner",
      );
      const ownerRunIds = new Set(ownerRuns.map((run) => run.id));
      const allWindows = windowsFromRuns(
        allRuns.map((run) => {
          const context = run.payload?.context ?? {};
          return {
            id: run.id,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            createdAt: run.createdAt,
            actor: ownerRunIds.has(run.id)
              ? taskRunActorName(task, run)
              : String(
                  context.taskReceiverName ??
                    run.payload?.profileName ??
                    "Agent",
                ),
          };
        }),
        taskAgentDisplayName(task),
        Date.now(),
      );
      const collectedDocuments = await collectDocuments({
        root,
        windows: allWindows,
        ...(options.maxFiles === undefined
          ? {}
          : { maxFiles: options.maxFiles }),
      });
      const documents = collectedDocuments.filter(
        (document) =>
          document.runId !== undefined && ownerRunIds.has(document.runId),
      );
      const outputDocuments = await materializeAgentOutputDocuments({
        root,
        taskId: task.id,
        runs: ownerRuns.map((run) => ({
          id: run.id,
          status: run.status,
          createdAt: run.createdAt,
          endedAt: run.endedAt,
          actor: taskRunActorName(task, run),
          output: run.output,
        })),
      }).catch(() => []);
      return {
        workspaceReady: true,
        documents: mergeDocuments([
          ...documents,
          ...outputDocuments,
          ...(options.includeUploaded === false
            ? []
            : attachmentDocuments(
                task,
                true,
                new Map(
                  ownerRuns.flatMap((run) => {
                    const messageId = run.payload?.context?.triggerMessageId;
                    return typeof messageId === "string" && messageId !== ""
                      ? [[messageId, run.id] as const]
                      : [];
                  }),
                ),
              )),
        ]),
      };
    },
  };
}

/** Task 模块只提供结构化候选，是否进入某次运行由 Context 决定。 */
export function taskContextContributions(
  task: Pick<TaskRecord, "comments">,
): TaskContextContribution[] {
  return task.comments
    .filter((comment) => comment.isKeyConsensus)
    .slice(-20)
    .map((comment) => ({
      id: `task-consensus:${comment.id}`,
      version: comment.at,
      text: `[${comment.at}] ${comment.authorName}：${contextLine(comment.content, 4_000)}`,
      sourceRefs: [
        {
          type: "task-comment" as const,
          id: comment.id,
          version: comment.at,
          quote: comment.content.slice(0, 4_000),
        },
      ],
    }));
}

interface AssignmentSeatLike {
  readonly id: string;
  readonly label: string;
  readonly participantKind?: string | undefined;
  readonly personaId?: string | undefined;
  readonly permissions?: readonly string[] | undefined;
}

interface AssignmentServiceLike {
  config(workspaceId: string): {
    readonly seats: readonly AssignmentSeatLike[];
  };
  seats?(workspaceId: string): readonly {
    readonly seatId: string;
    readonly assigneeKind: "user" | "agent";
    readonly assigneeId: string;
    readonly status: "claimed" | "assigned" | "released";
  }[];
  /** 项目角色的成员快照：谁在这个角色上，谁就是可选执行人。 */
  members?(
    workspaceId: string,
    seatId: string,
  ): readonly {
    readonly assigneeKind: "user" | "agent";
    readonly assigneeId: string;
    readonly status: "claimed" | "assigned" | "released";
  }[];
}

interface TaskContext {
  storageDomain: {
    open(spec: typeof taskDomainSpec): Promise<{
      table(name: "tasks"): KvTableLike<TaskRecord>;
      close(): Promise<void>;
    }>;
  };
  effect(register: () => () => void): void;
  provide(key: "collabTasks", value: TaskService): unknown;
  provide(key: "collabTaskDispatch", value: TaskDispatchService): unknown;
  provide(key: "collabTaskDocuments", value: TaskDocumentQueryService): unknown;
  webServer: { register(route: WebRouteLike): unknown };
  get(key: string): unknown;
  get(key: "collabContext"): TaskContextServiceLike | undefined;
  emit?(event: string, payload?: unknown): void;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: TaskContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabAgent"],
    callback: (
      child: TaskContext & {
        readonly collabAgent: TaskAgentServiceLike;
      },
    ) => void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabAgent", "workspaceRegistry"],
    callback: (
      child: TaskContext & {
        readonly collabAgent: TaskAgentServiceLike;
        readonly workspaceRegistry: WorkspaceRegistryLike;
      },
    ) => Promise<void> | void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabContext"],
    callback: (
      child: TaskContext & {
        readonly collabContext: TaskContextServiceLike;
      },
    ) => void,
  ): { dispose(): void };
}

interface MemoryIngestLike {
  ingestSource(input: {
    readonly sourceType: "task";
    readonly sourceId: string;
    readonly version: string;
    readonly workspaceId?: string;
    readonly payload?: {
      readonly title: string;
      readonly content: string;
      readonly actorPrincipalId?: string;
      readonly projectId?: string;
      readonly occurredAt?: string;
      readonly sourceRefs?: readonly {
        readonly type:
          | "task"
          | "meeting"
          | "minute-version"
          | "workflow"
          | "document"
          | "chat"
          | "human-edit";
        readonly id: string;
        readonly version?: string;
        readonly quote?: string;
      }[];
      readonly metadata?: Readonly<Record<string, string | number | boolean>>;
    };
  }): Promise<unknown>;
}

const taskQuerySchema = z.object({
  taskId: z.string().min(1).max(160),
});

function principal(
  request: IncomingMessage,
  team: TeamServiceLike,
): TeamPrincipalLike {
  const token = bearerToken({
    get(name) {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
  });
  if (token === undefined)
    throw new TaskError("unauthorized", "bearer token is required");
  const value = team.resolveToken(token);
  if (value === undefined)
    throw new TaskError("unauthorized", "invalid or expired token");
  return value;
}

function actor(
  principalValue: TeamPrincipalLike,
  team: TeamServiceLike,
): TaskActor {
  const user = team
    .users()
    .find((candidate) => candidate.id === principalValue.userId);
  return {
    id: principalValue.userId,
    name: user?.name ?? principalValue.userId,
    kind: "human",
    role: principalValue.role,
  };
}

/**
 * 派发链路需要真实角色：AI Teammate / 员工域在首次开通执行身份时会校验
 * 「workspace owner 或 admin」。内域调用方（会议、工作台…）通常只带 id/name，
 * 所以统一在这里按 team 服务补齐，最后才退化成 member——否则平台管理员经会议
 * 派发 Facilitator 这类「还没开过执行身份」的 Teammate 会被误判成无权限。
 */
function resolveDispatchActor(
  actor: TaskActor,
  team: TeamServiceLike | undefined,
  workspaceId: string,
): TaskActor {
  if (actor.role !== undefined || actor.kind !== "human") return actor;
  const role = team?.users().find((user) => user.id === actor.id)?.role;
  if (
    role === "admin" ||
    role === "owner" ||
    role === "member" ||
    role === "guest"
  ) {
    return { ...actor, role };
  }
  const isWorkspaceOwner = team
    ?.members(workspaceId)
    .some(
      (member) => member.userId === actor.id && member.memberRole === "owner",
    );
  return isWorkspaceOwner === true ? { ...actor, role: "owner" } : actor;
}

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://dsh.invalid").searchParams;
}

function canAccess(
  principalValue: TeamPrincipalLike,
  team: TeamServiceLike,
  workspaceId: string,
): boolean {
  return (
    principalValue.role === "admin" ||
    team
      .members(workspaceId)
      .some((member) => member.userId === principalValue.userId)
  );
}

function requireAccess(
  request: IncomingMessage,
  team: TeamServiceLike,
  workspaceId: string,
): TaskActor {
  const principalValue = principal(request, team);
  if (!canAccess(principalValue, team, workspaceId)) {
    throw new TaskError("forbidden", "workspace membership is required");
  }
  return actor(principalValue, team);
}

function directory(
  team: TeamServiceLike,
  workspaceId: string,
  employees: EmployeeServiceLike | undefined,
  assignments: AssignmentServiceLike | undefined,
  teammates?: TeammateRuntimeLike,
  actor?: TeammateRuntimeActorLike,
): {
  humans: Array<{ id: string; name: string; role: string }>;
  agents: Array<{
    id: string;
    name: string;
    kind: "agent";
    ownerName?: string;
    ownerAuthUserId?: string;
    employeeId?: string;
    personaId?: string;
    source?: "platform" | "personal";
    avatar?: string;
    execution?: "builtin" | "external";
    externalRuntimeId?: string;
  }>;
  roles: Array<{
    id: string;
    name: string;
    personaId?: string;
    assignedUserIds?: string[];
    members?: Array<{
      kind: "user" | "agent";
      id: string;
      name?: string;
    }>;
  }>;
} {
  const memberIds = new Set(
    team.members(workspaceId).map((member) => member.userId),
  );
  const humans = team
    .users()
    .filter((user) => memberIds.has(user.id))
    .map((user) => ({ id: user.id, name: user.name, role: user.role }));
  const employeeDirectory = employees?.list() ?? [];
  const teammateEmployeeIds = new Set(
    teammates !== undefined && actor !== undefined
      ? teammates
          .assignable(actor)
          .map((teammate) => teammate.employeeId)
          .filter((value): value is string => value !== undefined)
      : [],
  );
  const employeeById = new Map(
    employeeDirectory.map((employee) => [employee.id, employee]),
  );
  const agents: Array<{
    id: string;
    name: string;
    kind: "agent";
    ownerName?: string;
    ownerAuthUserId?: string;
    employeeId?: string;
    personaId?: string;
    source?: "platform" | "personal";
    avatar?: string;
    execution?: "builtin" | "external";
    externalRuntimeId?: string;
  }> = employeeDirectory
    .filter(
      (employee) =>
        employee.kind === "digital" &&
        !teammateEmployeeIds.has(employee.id) &&
        employees?.employeeWorkspaceTarget(employee.id, workspaceId) !==
          undefined,
    )
    .map((employee) => {
      const owner =
        employee.managerEmployeeId === undefined
          ? undefined
          : employeeById.get(employee.managerEmployeeId);
      return {
        id: employee.id,
        name: employee.displayName,
        kind: "agent" as const,
        ...(owner?.displayName === undefined
          ? {}
          : { ownerName: owner.displayName }),
        ...(owner?.authUserId === undefined
          ? {}
          : { ownerAuthUserId: owner.authUserId }),
        ...(employee.personaId === undefined
          ? {}
          : { personaId: employee.personaId }),
        source: "platform" as const,
        avatar: "",
      };
    });
  if (teammates !== undefined && actor !== undefined) {
    const memberIds = new Set(team.users().map((user) => user.id));
    for (const teammate of teammates.assignable(actor)) {
      agents.push({
        id: teammate.id,
        name: teammate.name,
        kind: "agent" as const,
        ownerName: teammate.ownerName,
        source: teammate.source,
        avatar: teammate.avatar,
        ...(teammate.execution === undefined
          ? {}
          : { execution: teammate.execution }),
        ...(teammate.externalRuntimeId === undefined
          ? {}
          : { externalRuntimeId: teammate.externalRuntimeId }),
        ...(teammate.employeeId === undefined
          ? {}
          : { employeeId: teammate.employeeId }),
        // 实例归属看实例创建人（不是模版的平台归属）。
        ...(memberIds.has(teammate.ownerUserId)
          ? { ownerAuthUserId: teammate.ownerUserId }
          : {}),
      });
    }
  }
  let roles: Array<{
    id: string;
    name: string;
    personaId?: string;
    assignedUserIds?: string[];
    members?: Array<{
      kind: "user" | "agent";
      id: string;
      name?: string;
    }>;
  }> = [];
  try {
    const activeAssignments =
      assignments
        ?.seats?.(workspaceId)
        .filter((assignment) => assignment.status !== "released") ?? [];
    roles =
      assignments?.config(workspaceId).seats.map((seat) => ({
        id: seat.id,
        name: seat.label,
        ...(seat.personaId === undefined ? {} : { personaId: seat.personaId }),
        assignedUserIds: activeAssignments
          .filter(
            (assignment) =>
              assignment.seatId === seat.id &&
              assignment.assigneeKind === "user",
          )
          .map((assignment) => assignment.assigneeId)
          .filter(
            (assigneeId, index, values) => values.indexOf(assigneeId) === index,
          ),
        // 角色可选执行人：当前时刻该角色上的人与 teammate 实例。
        members: activeAssignments
          .filter((assignment) => assignment.seatId === seat.id)
          .map((assignment) => {
            const name =
              assignment.assigneeKind === "user"
                ? humans.find((user) => user.id === assignment.assigneeId)?.name
                : agents.find(
                    (agent) =>
                      agent.id === assignment.assigneeId ||
                      agent.employeeId === assignment.assigneeId,
                  )?.name;
            return {
              kind: assignment.assigneeKind,
              id: assignment.assigneeId,
              ...(name === undefined ? {} : { name }),
            };
          })
          .filter(
            (member, index, values) =>
              values.findIndex(
                (candidate) =>
                  candidate.kind === member.kind && candidate.id === member.id,
              ) === index,
          ),
      })) ?? [];
  } catch {
    roles = [];
  }
  return { humans, agents, roles };
}

/**
 * 项目角色当前的成员（人 / teammate 实例）。角色目录不可用、或该角色的
 * members 接口缺失时返回 undefined：维持旧行为，不因为查不到而锁死认领。
 * 返回空数组表示角色确实还没有成员，此时任何人都不是合法执行人。
 */
function seatMembers(
  assignments: AssignmentServiceLike | undefined,
  workspaceId: string,
  seatId: string,
):
  | readonly { readonly kind: "user" | "agent"; readonly id: string }[]
  | undefined {
  if (assignments?.members === undefined) return undefined;
  try {
    return assignments
      .members(workspaceId, seatId)
      .filter((member) => member.status !== "released")
      .map((member) => ({
        kind: member.assigneeKind,
        id: member.assigneeId,
      }));
  } catch {
    return undefined;
  }
}

function routeError(response: ServerResponse, cause: unknown): void {
  if (cause instanceof TaskError) {
    const status =
      cause.code === "invalid_input"
        ? 400
        : cause.code === "unauthorized"
          ? 401
          : cause.code === "forbidden"
            ? 403
            : cause.code === "not_found"
              ? 404
              : 409;
    sendJson(response, status, {
      ok: false,
      error: { code: cause.code, message: cause.message },
    });
    return;
  }
  const code =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown }).code
      : undefined;
  if (
    cause instanceof Error &&
    typeof code === "string" &&
    [
      "invalid_input",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "missing_deliverables",
      "method_not_allowed",
    ].includes(code)
  ) {
    const status =
      code === "invalid_input" || code === "method_not_allowed"
        ? 400
        : code === "unauthorized"
          ? 401
          : code === "forbidden"
            ? 403
            : code === "not_found"
              ? 404
              : 409;
    sendJson(response, status, {
      ok: false,
      error: { code, message: cause.message },
    });
    return;
  }
  sendJson(response, 500, {
    ok: false,
    error: { code: "internal_error", message: "task request failed" },
  });
}

function contextLine(value: string, limit = 800): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

function mentionNames(task: TaskRecord): readonly string[] {
  const names = new Set<string>();
  const receiver = task.receiverName?.trim();
  if (receiver !== undefined && receiver !== "") {
    names.add(receiver);
    const tail = receiver.split(/\s+/).filter(Boolean).at(-1);
    if (tail !== undefined) names.add(tail);
  }
  if (task.receiverId !== undefined) names.add(task.receiverId);
  return [...names];
}

/** 人类的这条消息是否 @ 了当前执行人；没有 @ 的讨论只进入上下文，不触发执行。 */
export function taskMessageMentionsReceiver(
  task: TaskRecord,
  content: string,
): boolean {
  return mentionNames(task).some(
    (name) => name !== "" && content.includes(`@${name}`),
  );
}

interface TaskContextOptions {
  readonly firstDelivery: boolean;
  readonly deliveredThroughMessageId?: string | undefined;
  readonly triggerMessageId?: string | undefined;
  readonly triggerContent?: string | undefined;
  /** 人类在上次投递之后改写过任务内容，需要把最新定义重新带上。 */
  readonly definitionChanged?: boolean | undefined;
  /** 外部一次性进程没有会话历史；每次派发都注入完整任务上下文。 */
  readonly statelessExternal?: boolean | undefined;
}

/**
 * 任务定义（标题/描述/验收标准等）的指纹。
 * Agent 的会话历史里只有投递过的内容，人类事后改写任务正文不会产生新消息，
 * 所以要用它判断「同一会话的下一轮」该不该重发最新定义。
 */
function taskDefinitionDigest(task: TaskRecord): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        title: task.title,
        type: task.type,
        priority: task.priority,
        due: task.due ?? "",
        description: task.description,
        acceptance: task.acceptance,
        executionPolicy: task.executionPolicy ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function taskSourcePolicyLines(task: TaskRecord): string[] {
  const policy = task.executionPolicy ?? legacyTaskExecutionPolicy();
  return [
    "## 来源策略",
    `- 允许来源：${policy.sourcePolicy.allow.join("、") || "未额外授权主动来源"}`,
    `- 禁止来源：${policy.sourcePolicy.deny.join("、") || "无"}`,
    `- 引用要求：${policy.sourcePolicy.citation}`,
    ...(policy.sourcePolicy.requirePublishedAt
      ? ["- 事实性结论必须记录发布日期"]
      : []),
    ...(policy.sourcePolicy.requireAccessedAt
      ? ["- 网页来源必须记录访问时间"]
      : []),
  ];
}

function taskToolPolicyLines(task: TaskRecord): string[] {
  const policy = task.executionPolicy ?? legacyTaskExecutionPolicy();
  return [
    "## Runtime 执行覆盖",
    `- 指定 Runtime：${policy.runtime.allowedRuntimeIds.join("、") || "由平台与责任人决定"}`,
    `- 指定模型：${policy.runtime.model ?? "沿用 Runtime 默认模型"}`,
    `- 推理强度：${policy.runtime.reasoningEffort ?? "沿用 Runtime 默认值"}`,
    "",
    "## 工具策略",
    `- 允许工具类别：${policy.toolPolicy.allow.join("、") || "由 Runtime 和 Agent Profile 决定"}`,
    `- 禁止工具类别：${policy.toolPolicy.deny.join("、") || "无"}`,
    `- 需审批工具类别：${policy.toolPolicy.requireApproval.join("、") || "无"}`,
    "",
    "如来源或工具未获授权，必须说明缺口并请求人工处理，不能绕过限制或伪造已读取。",
  ];
}

function taskExecutionPolicyLines(task: TaskRecord): string[] {
  return [...taskSourcePolicyLines(task), "", ...taskToolPolicyLines(task)];
}

function appendTaskDefinition(
  lines: string[],
  task: TaskRecord,
  heading: string,
): void {
  lines.push(
    heading,
    "",
    `- 编号：${task.id}`,
    `- 标题：${task.title}`,
    `- 类型：${task.type}`,
    `- 优先级：${task.priority}`,
    `- 项目：${task.workspaceId}`,
    `- 到期：${task.due ?? "不限"}`,
  );
  if (task.description.trim() !== "") {
    lines.push("", "## 描述", task.description.trim());
  }
  if (task.acceptance.length > 0) {
    lines.push(
      "",
      "## 验收标准",
      ...task.acceptance.map((item, index) => `${String(index + 1)}. ${item}`),
    );
  }
  if (task.links.length > 0) {
    lines.push(
      "",
      "## 关联",
      ...task.links.map(
        (link) => `- ${link.type}：${link.label}（${link.id}）`,
      ),
    );
  }
  lines.push("", ...taskExecutionPolicyLines(task));
}

function buildTaskContext(
  task: TaskRecord,
  options: TaskContextOptions,
): string {
  const lines: string[] = [];
  // plain-text / codex-jsonl 外部执行器都是一次性进程，没有内置会话历史。
  // 即使已经派发过，也必须重发任务定义和完整时间线，否则后续反馈会失去基线。
  const firstDelivery =
    options.firstDelivery || options.statelessExternal === true;
  if (firstDelivery) {
    appendTaskDefinition(lines, task, "# 任务");
  } else if (options.definitionChanged === true) {
    lines.push(
      "人类在你上次执行之后改写了任务内容，以下是更新后的任务定义，请以它为准。",
      "",
    );
    appendTaskDefinition(lines, task, "# 任务（已更新）");
  }
  const startIndex =
    firstDelivery || options.deliveredThroughMessageId === undefined
      ? 0
      : task.messages.findIndex(
          (message) => message.id === options.deliveredThroughMessageId,
        ) + 1;
  const fresh = task.messages
    .slice(startIndex)
    .filter((message) => message.kind !== "system")
    // 增量只投人类的新内容：Agent 自己的回复已经在会话历史里，
    // 再投一次既浪费 token，也会让它把自己的旧结论当成新要求。
    .filter((message) => firstDelivery || message.kind !== "agent");
  if (fresh.length > 0) {
    lines.push(
      "",
      firstDelivery ? "## 任务时间线" : "## 上次投递之后的新增讨论",
      ...fresh.map(
        (message) =>
          `- [${message.at}] ${message.authorName}（${message.kind === "human" ? "人类" : "Agent"}）：${contextLine(message.content)}`,
      ),
    );
  } else if (!firstDelivery) {
    lines.push("", "## 上次投递之后的新增讨论", "- 没有新增讨论。");
  }
  // 上一轮成功产出之后、本轮触发之前的人类消息仍然属于当前修改要求。
  // 例如退回说明执行失败后用户只补一句「重试一下」，不能让「重试」覆盖
  // 原退回意见，否则模型会把前面的退回说明误当成已处理背景。
  const lastSuccessfulAgentIndex = task.messages.findLastIndex(
    (message) => message.kind === "agent" && message.state === "succeeded",
  );
  const activeHumanMessages = task.messages
    .slice(lastSuccessfulAgentIndex + 1)
    .filter((message) => message.kind === "human")
    .filter((message) => message.id !== options.triggerMessageId);
  lines.push("", "## 本次需要你响应");
  if (
    options.triggerContent !== undefined &&
    options.triggerContent.trim() !== ""
  ) {
    if (activeHumanMessages.length > 0) {
      lines.push(
        "本轮仍有尚未完成的人类要求，请与本次最新指令一起处理：",
        "",
        ...activeHumanMessages.map(
          (message) => `- ${contextLine(message.content, 4_000)}`,
        ),
        "",
        "本次最新指令：",
        "",
        `> ${contextLine(options.triggerContent, 4_000)}`,
      );
    } else {
      lines.push(
        "以下内容 @ 了你，请针对它行动：",
        "",
        `> ${contextLine(options.triggerContent, 4_000)}`,
      );
    }
  } else {
    lines.push(
      ...(activeHumanMessages.length === 0
        ? []
        : [
            "请先完成以下尚未落实的人类要求：",
            "",
            ...activeHumanMessages.map(
              (message) => `- ${contextLine(message.content, 4_000)}`,
            ),
            "",
          ]),
      "按上面的任务描述与验收标准开始执行；信息不足时先列出缺失项再等补充。",
    );
  }
  lines.push(
    "",
    "## 产出物提交",
    "- 任务需要交付文件时，优先直接写入任务工作区。",
    "- 如果执行环境是只读的，无法写文件，请按下面格式返回每个文件，平台会自动登记为可下载文档：",
    "",
    "<!-- pluginmax-document: 文件名.md -->",
    "<完整文件正文>",
    "<!-- /pluginmax-document -->",
    "",
    "## 边界",
    "- 「本次需要你响应」中列出的人类要求都必须落实；时间线中的其它已处理讨论才是背景。",
    "- 不要重复处理已经完成的内容，也不要声称完成未提交的交付物。",
  );
  return lines.join("\n");
}

/**
 * 协作轮次的上下文：被 @ 的 Agent 只需要看「任务定义 + 这次点它的那件事 +
 * 相关文档」，并且明确它不是任务责任人——推进任务、提交交付物都不归它。
 */
function buildAssistContext(
  task: TaskRecord,
  options: {
    readonly role: "assist" | "fyi";
    readonly ask: string;
    readonly from: string;
    readonly documents: readonly string[];
  },
): string {
  const lines: string[] = [];
  if (options.role === "assist") {
    lines.push(
      "# 你在任务里被 @ 了",
      "",
      `${options.from} 在任务「${task.title}」里 @ 了你，只有下面这件事需要你的意见；`,
      "任务责任人不是你，请不要改动任务状态，也不要提交交付物。",
    );
  } else {
    lines.push(
      "# 协作进展（本轮不需要你执行）",
      "",
      `${options.from} 在任务「${task.title}」里发起了一次跨 Agent 协作。`,
      "以下是刚发生的事，供你掌握进展；这一轮不是要求你执行任务。",
    );
  }
  lines.push("", "## 本次需要你回应");
  lines.push(
    options.ask.trim() === ""
      ? "没有额外说明，请简短确认你已了解，然后等待进一步指令。"
      : `> ${contextLine(options.ask, 4_000)}`,
  );
  lines.push("");
  appendTaskDefinition(lines, task, "# 任务定义");
  if (options.documents.length > 0) {
    lines.push(
      "",
      "## 相关文档",
      "这些文件在任务工作区里，需要时可以按相对路径读取：",
      ...options.documents.slice(0, 40),
    );
  }
  lines.push(
    "",
    "## 边界",
    "- 只回应「本次需要你回应」的部分；任务定义和其它讨论只是背景。",
    "- 不要代替任务责任人推进任务，也不要声称完成了未提交的交付物。",
  );
  return lines.join("\n");
}

/** 协作分享用的文档清单：任务执行期产出的文件 + 人工上传的附件。 */
async function taskDocumentBrief(
  agent: TaskAgentServiceLike | undefined,
  workspaces: WorkspaceRegistryLike | undefined,
  task: TaskRecord,
): Promise<readonly string[]> {
  const root = workspaces?.get(task.workspaceId)?.path;
  const displayName = task.receiverName ?? task.receiverId ?? "Agent";
  const runs =
    agent?.runs?.({ workspaceId: task.workspaceId, instanceId: task.id }) ?? [];
  const ownerRuns = runs.filter(
    (run) => (run.payload?.context?.taskRunRole ?? "owner") === "owner",
  );
  const produced =
    root === undefined
      ? []
      : await collectDocuments({
          root,
          windows: windowsFromRuns(
            ownerRuns.map((run) => ({
              id: run.id,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              createdAt: run.createdAt,
              actor: taskRunActorName(task, run),
            })),
            displayName,
            Date.now(),
          ),
        }).catch(() => []);
  const outputDocuments =
    root === undefined
      ? []
      : await materializeAgentOutputDocuments({
          root,
          taskId: task.id,
          runs: ownerRuns.map((run) => ({
            id: run.id,
            status: run.status,
            createdAt: run.createdAt,
            endedAt: run.endedAt,
            actor: taskRunActorName(task, run),
            output: run.output,
          })),
        }).catch(() => []);
  return mergeDocuments([
    ...produced,
    ...outputDocuments,
    ...attachmentDocuments(
      task,
      root !== undefined,
      new Map(
        ownerRuns.flatMap((run) => {
          const messageId = run.payload?.context?.triggerMessageId;
          return typeof messageId === "string" && messageId !== ""
            ? [[messageId, run.id] as const]
            : [];
        }),
      ),
    ),
  ]).map(
    (document) =>
      `- ${document.kind === "produced" ? "产出" : "上传"}：${document.name}（${document.relativePath}）${document.available ? "" : " · 当前不可读"}`,
  );
}

async function dispatchTaskInstruction(
  agent: TaskAgentServiceLike | undefined,
  team: TeamServiceLike | undefined,
  employees: EmployeeServiceLike | undefined,
  workspaces: WorkspaceRegistryLike | undefined,
  teammates: TeammateRuntimeLike | undefined,
  principalRuntime: PrincipalRuntimeServiceLike | undefined,
  contextService: TaskContextServiceLike | undefined,
  task: TaskRecord,
  actor: TaskActor,
  options?:
    | {
        /** owner=任务责任人本人；assist=被 @ 的协作方；fyi=只通知不执行。 */
        readonly role?: "owner" | "assist" | "fyi" | undefined;
        /** 执行者标识（teammate 实例 id 或员工身份 id）。协作轮次传入被 @ 的对象。 */
        readonly ref?: string | undefined;
        readonly name?: string | undefined;
        readonly trigger?:
          | {
              readonly messageId?: string | undefined;
              readonly content: string;
            }
          | undefined;
        /** 协作轮次「本次需要你回应」的内容（通常是 @ 那句）。 */
        readonly ask?: string | undefined;
        readonly contextOverride?:
          | {
              readonly scene: "task" | "meeting";
              readonly objectId: string;
              readonly content: string;
            }
          | undefined;
      }
    | undefined,
): Promise<TaskAgentRun> {
  const runRole = options?.role ?? "owner";
  const targetRef = options?.ref ?? task.receiverId;
  const trigger = options?.trigger;
  const actingActor = resolveDispatchActor(actor, team, task.workspaceId);
  if (
    targetRef === undefined ||
    (runRole === "owner" && task.receiverType !== "agent")
  ) {
    throw new TaskError("invalid_input", "task receiver is not an agent");
  }
  if (agent === undefined) {
    throw new TaskError("conflict", "Agent 注册表不可用");
  }
  const employeeTarget = employees?.workflowTarget(targetRef, task.workspaceId);
  const ensured =
    teammates !== undefined
      ? await teammates.ensureRuntime({
          teammateId: targetRef,
          workspaceId: task.workspaceId,
          actor: {
            userId: actor.id,
            name: actor.name,
            role: actingActor.role ?? "member",
          },
        })
      : undefined;
  const employeeProfileId =
    ensured?.profileId ?? employeeTarget?.profile.legacyAgentProfileId;
  let target:
    | {
        readonly employeeId?: string;
        readonly principalId?: string;
        readonly ticketId?: string;
        readonly profileId: string;
        readonly profileName: string;
        readonly maxMinutes: number | undefined;
        readonly personaId: string | undefined;
        readonly employeeName: string;
      }
    | undefined;
  if (employeeTarget !== undefined && employeeProfileId !== undefined) {
    // 会话命名和任务管理使用同一个「责任人」显示名；档案名只是执行身份。
    const employeeName =
      options?.name?.trim() ||
      task.receiverName?.trim() ||
      employeeTarget.employee.displayName;
    const principalId =
      task.receiverPrincipalId ?? employeeTarget.employee.principalId;
    target = {
      employeeId: employeeTarget.employee.id,
      ...(principalId === undefined ? {} : { principalId }),
      profileId: employeeProfileId,
      profileName: employeeTarget.profile.name,
      maxMinutes: employeeTarget.profile.budget?.maxMinutes,
      personaId: employeeTarget.employee.personaId ?? ensured?.personaId,
      employeeName,
    };
  } else if (ensured !== undefined) {
    // AI Teammate 首次被指派时，按定义自动开通运行时身份。
    const ensuredName =
      options?.name ?? task.receiverName ?? ensured.teammateId;
    const principalId = task.receiverPrincipalId ?? ensured.principalId;
    target = {
      ...(ensured.employeeId === undefined
        ? {}
        : { employeeId: ensured.employeeId }),
      ...(principalId === undefined ? {} : { principalId }),
      profileId: ensured.profileId,
      profileName: ensuredName,
      maxMinutes: undefined,
      personaId: ensured.personaId,
      employeeName: ensuredName,
    };
  }
  if (target === undefined) {
    throw new TaskError("conflict", "该 AI伙伴缺少可用的 Task Worker Profile");
  }
  if (
    target.principalId !== undefined &&
    target.employeeId === undefined &&
    principalRuntime?.profile(target.principalId, task.workspaceId) !==
      undefined
  ) {
    const ticket = await principalRuntime.issueTicket({
      principalId: target.principalId,
      workspaceId: task.workspaceId,
      contextType: "task",
      contextId: task.id,
      requestedActions: ["read", "write"],
      resourceScopes: [`task/${task.id}`],
      durationMinutes: Math.min(1_440, Math.ceil(target.maxMinutes ?? 30) + 1),
      issuedByUserId: actor.id,
    });
    target = { ...target, ticketId: ticket.id };
  }
  const executionPolicy = task.executionPolicy ?? legacyTaskExecutionPolicy();
  const preflight = agent.preflightForProfile?.({
    workspaceId: task.workspaceId,
    taskId: task.id,
    profileId: target.profileId,
    principalId: target.principalId ?? target.profileId,
    teammateId: targetRef,
    ...(target.ticketId === undefined ? {} : { ticketId: target.ticketId }),
    policy: executionPolicy,
  });
  if (preflight !== undefined && !preflight.compatible) {
    const required = preflight.gaps
      .filter((gap) => gap.necessity === "required")
      .map((gap) => gap.message);
    throw new TaskError(
      "conflict",
      required.length > 0
        ? required.join("；")
        : "当前 Runtime 不满足任务的执行能力要求",
    );
  }
  const sessionEpoch = task.sessionEpoch ?? 0;
  // 协作轮次不参与增量投递：被 @ 的 Agent 每次都要看到完整任务与这次的诉求。
  const previousRunId =
    runRole === "owner"
      ? [...task.agentRunIds].reverse().find((runId) => {
          const run = agent.run?.(runId);
          return (
            run?.payload?.context?.taskReceiverId === targetRef &&
            (run?.payload?.context?.taskRunRole ?? "owner") === "owner" &&
            String(run?.payload?.context?.taskSessionEpoch ?? "0") ===
              String(sessionEpoch)
          );
        })
      : undefined;
  const previousContext =
    previousRunId === undefined
      ? undefined
      : agent.run?.(previousRunId)?.payload?.context;
  const firstDelivery = previousContext === undefined;
  const statelessExternal = ensured?.execution === "external";
  const effectiveFirstDelivery = firstDelivery || statelessExternal;
  const deliveredThroughMessageId =
    firstDelivery || statelessExternal
      ? undefined
      : (previousContext?.deliveredThroughMessageId as string | undefined);
  const deliveredThrough =
    deliveredThroughMessageId === undefined || deliveredThroughMessageId === ""
      ? undefined
      : deliveredThroughMessageId;
  const lastDeliveredMessageId = trigger?.messageId ?? task.messages.at(-1)?.id;
  const definitionDigest = taskDefinitionDigest(task);
  const previousDefinitionDigest = previousContext?.taskDefinitionDigest;
  // 老 run 没有记录指纹时按「改过」处理：宁可多带一次最新定义，也不要漏投。
  const definitionChanged =
    !firstDelivery &&
    (typeof previousDefinitionDigest !== "string" ||
      previousDefinitionDigest !== definitionDigest);
  const runSeq = task.agentRunIds.length + 1;
  const legacyInstruction =
    runRole === "owner"
      ? buildTaskContext(task, {
          firstDelivery,
          ...(statelessExternal ? { statelessExternal: true } : {}),
          ...(deliveredThrough === undefined
            ? {}
            : { deliveredThroughMessageId: deliveredThrough }),
          ...(trigger?.messageId === undefined
            ? {}
            : { triggerMessageId: trigger.messageId }),
          ...(trigger === undefined ? {} : { triggerContent: trigger.content }),
          ...(definitionChanged ? { definitionChanged: true } : {}),
        })
      : buildAssistContext(task, {
          role: runRole,
          ask: options?.ask ?? trigger?.content ?? "",
          from: actor.name,
          documents: await taskDocumentBrief(agent, workspaces, task),
        });
  const contextPack =
    contextService === undefined
      ? undefined
      : await contextService.prepare({
          requestId: `${options?.contextOverride?.scene ?? "task"}:${options?.contextOverride?.objectId ?? task.id}:${runRole}:${targetRef}:${String(runSeq)}`,
          mode: "execute",
          ...(previousRunId === undefined
            ? {}
            : { rerunOfRunId: previousRunId }),
          scene: options?.contextOverride?.scene ?? "task",
          workspaceId: task.workspaceId,
          objectId:
            options?.contextOverride?.objectId ??
            (sessionEpoch === 0 ? task.id : `${task.id}:g${sessionEpoch}`),
          agentPrincipalId: target.principalId ?? target.profileId,
          agentProfileId: target.profileId,
          teammateId: targetRef,
          actorPrincipalId: actor.id,
          input: {
            type: "user-message",
            ...(trigger?.messageId === undefined
              ? {}
              : { messageId: trigger.messageId }),
            content:
              options?.contextOverride?.content ??
              trigger?.content ??
              task.description,
            attachments: [],
          },
          explicitRefs: task.links.flatMap((link) =>
            link.type === "meeting" ||
            link.type === "workflow" ||
            link.type === "document"
              ? [{ type: link.type, id: link.id }]
              : [],
          ),
          pinnedMemoryIds: [],
          excludedSourceIds: [],
          runtimeCapabilities: {
            contextWindowTokens:
              preflight?.runtime.limits.contextWindowTokens ?? 32_000,
            maxOutputTokens: 4_000,
            supportsSystemSections: true,
            isStateless: statelessExternal,
          },
        });
  const contextSession =
    contextService !== undefined && contextPack !== undefined
      ? contextService.session?.(contextPack.sessionBindingId)
      : undefined;
  const instruction =
    contextPack === undefined
      ? legacyInstruction
      : contextPack.rendered.flattenedPrompt;
  const timeoutMinutes = target.maxMinutes ?? 30;
  const workspacePath = workspaces?.get(task.workspaceId)?.path;
  const run = await agent.dispatch({
    workspaceId: task.workspaceId,
    ...(workspacePath === undefined ? {} : { workspacePath }),
    profileId: target.profileId,
    source: options?.contextOverride?.scene ?? "task",
    instanceId: task.id,
    nodeId: "task",
    dispatchKey: `task:${task.id}:${runSeq}`,
    trigger: "manual-dispatch",
    attempt: 1,
    runSeq,
    maxAttempts: 1,
    timeoutMs: Math.min(3_600_000, Math.max(1_000, timeoutMinutes * 60_000)),
    ...(target.personaId === undefined ? {} : { personaId: target.personaId }),
    ...(target.employeeId === undefined
      ? {}
      : { employeeId: target.employeeId }),
    ...(target.principalId === undefined
      ? {}
      : { principalId: target.principalId }),
    ...(target.ticketId === undefined ? {} : { ticketId: target.ticketId }),
    ...(contextPack === undefined
      ? {}
      : {
          contextPackId: contextPack.id,
          sessionBindingId: contextPack.sessionBindingId,
        }),
    ...(contextSession === undefined
      ? {}
      : { sessionId: contextSession.sessionId }),
    principalType:
      target.employeeId === undefined
        ? "principal-runtime"
        : "digital-employee",
    executionPolicy,
    payload: {
      instanceTitle: task.title.slice(0, 160),
      nodeName: "任务执行",
      nodeDescription: task.description.slice(0, 2_000),
      profileName: target.profileName.slice(0, 120),
      responsibleId: actor.id,
      deliverables: [],
      context: {
        workspaceId: task.workspaceId,
        taskId: task.id,
        receiverId: target.employeeId ?? target.principalId ?? targetRef,
        taskReceiverId: targetRef,
        taskReceiverName: target.employeeName,
        taskRunRole: runRole,
        taskSessionEpoch: String(sessionEpoch),
        employeeName: target.employeeName,
        principalId: target.principalId ?? "",
        ticketId: target.ticketId ?? "",
        instruction,
        firstDelivery: effectiveFirstDelivery ? "true" : "false",
        triggerMessageId: trigger?.messageId ?? "",
        deliveredThroughMessageId: lastDeliveredMessageId ?? "",
        taskDefinitionDigest: definitionDigest,
        acceptance: task.acceptance.join("\n"),
        ...(contextPack === undefined ? {} : { contextPackId: contextPack.id }),
      },
    },
    createdBy: actor.id,
  });
  if (contextService !== undefined && contextPack !== undefined) {
    await contextService.recordRuntime({
      runId: run.id,
      contextPackId: contextPack.id,
      runtime: {
        kind: statelessExternal ? "external" : "builtin",
      },
    });
  }
  return run;
}

const uploadInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  name: z.string().min(1).max(300),
  mimeType: z.string().max(200).optional(),
  contentBase64: z.string().min(1).max(32_000_000),
});

function safeResolve(root: string, relativePath: string): string {
  try {
    return resolveWithin(root, relativePath);
  } catch {
    throw new TaskError("forbidden", "路径不在工作区内");
  }
}

function decodeBase64(value: string): Buffer {
  const normalized =
    value.startsWith("data:") && value.includes(",")
      ? value.slice(value.indexOf(",") + 1)
      : value;
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.byteLength === 0) {
    throw new TaskError("invalid_input", "上传内容为空");
  }
  return buffer;
}

function revealInFileManager(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const command =
      platform === "darwin"
        ? "open"
        : platform === "win32"
          ? "explorer"
          : "xdg-open";
    const args =
      platform === "darwin"
        ? ["-R", target]
        : platform === "win32"
          ? [`/select,${target}`]
          : [dirname(target)];
    execFile(command, args, (error) => {
      if (error === null) resolve();
      else
        reject(new TaskError("conflict", `无法打开本地目录：${error.message}`));
    });
  });
}

export interface TaskDispatchDependencies {
  readonly service: TaskService;
  readonly team?: TeamServiceLike | undefined;
  readonly employees?: EmployeeServiceLike | undefined;
  readonly agent?: (() => TaskAgentServiceLike | undefined) | undefined;
  readonly workspaces?: WorkspaceRegistryLike | undefined;
  readonly teammates?: (() => TeammateRuntimeLike | undefined) | undefined;
  readonly principalRuntime?:
    (() => PrincipalRuntimeServiceLike | undefined) | undefined;
  readonly context?: (() => TaskContextServiceLike | undefined) | undefined;
}

export interface TaskDispatchOutcome {
  readonly task: TaskRecord;
  readonly execution: Record<string, string>;
}

/** 供其它模块复用任务派发链路的服务面。 */
export interface TaskDispatchService {
  dispatch(
    task: TaskRecord,
    actor: TaskActor,
    context?: {
      readonly scene: "task" | "meeting";
      readonly objectId: string;
      readonly content: string;
    },
  ): Promise<TaskDispatchOutcome>;
}

export function canReviewTask(input: {
  readonly task: TaskRecord;
  readonly actor: TaskActor;
  readonly team: TeamServiceLike;
  readonly assignments?: AssignmentServiceLike | undefined;
}): boolean {
  const { task, actor, team, assignments } = input;
  if (actor.role === "admin") return true;
  if (task.createdBy === actor.id) return true;
  if (task.workflow?.approverIds?.includes(actor.id) === true) return true;
  if (
    team
      .members(task.workspaceId)
      .some(
        (member) => member.userId === actor.id && member.memberRole === "owner",
      )
  ) {
    return true;
  }
  if (assignments?.members === undefined) return false;
  return assignments
    .config(task.workspaceId)
    .seats.filter((seat) => seat.permissions?.includes("approve") === true)
    .some((seat) =>
      assignments.members!(task.workspaceId, seat.id).some(
        (member) =>
          member.assigneeKind === "user" &&
          member.assigneeId === actor.id &&
          member.status !== "released",
      ),
    );
}

/**
 * Agent 跑完后把任务交回「实例 owner（实例创建人）」确认：
 * 服务层会把状态置为「待验收」，这里只负责解析该交给谁。
 */
function ownerHandoff(
  deps: TaskDispatchDependencies,
  task: TaskRecord,
  run: TaskAgentRun,
): { readonly userId: string; readonly name: string } | undefined {
  return resolveOwnerHandoff(
    { team: deps.team, teammates: deps.teammates },
    task,
    run,
  );
}

/**
 * 解析「执行完成后应交给谁确认」：AI Teammate 实例的 owner（实例创建人）。
 * 派发时（同步返回 queued）和 run 真正结束时（onSettled）都要用同一套规则。
 */
export function resolveOwnerHandoff(
  deps: {
    readonly team?: TeamServiceLike | undefined;
    readonly teammates?: (() => TeammateRuntimeLike | undefined) | undefined;
  },
  task: TaskRecord,
  run: TaskAgentRun,
): { readonly userId: string; readonly name: string } | undefined {
  // 成功 → 交回 owner 验收；waiting_input → 交回 owner 补充信息（反馈项）。
  if (run.status !== "succeeded" && run.status !== "waiting_input") {
    return undefined;
  }
  if (task.receiverType !== "agent" || task.receiverId === undefined) {
    return undefined;
  }
  if (
    run.status === "succeeded" &&
    (task.workflow !== undefined || !task.autoSubmitReview)
  ) {
    return undefined;
  }
  const users = deps.team?.users() ?? [];
  const owner = deps.teammates?.()?.ownerOf?.(task.receiverId);
  const ownerUser =
    owner === undefined
      ? undefined
      : users.find((item) => item.id === owner.userId);
  if (ownerUser !== undefined) {
    return { userId: ownerUser.id, name: ownerUser.name };
  }
  // 兜底：实例 owner 不可用（离职/停用/不存在）→ 工作区 owner → 平台管理员。
  const members = deps.team?.members(task.workspaceId) ?? [];
  const workspaceOwnerId = members.find(
    (member) => member.memberRole === "owner",
  )?.userId;
  const workspaceOwner = users.find((item) => item.id === workspaceOwnerId);
  if (workspaceOwner !== undefined) {
    return { userId: workspaceOwner.id, name: workspaceOwner.name };
  }
  const admin = users.find((item) => item.role === "admin");
  return admin === undefined
    ? undefined
    : { userId: admin.id, name: admin.name };
}

/**
 * 任务对应的 Agent 执行会话：取最近一轮已经启动执行的 run 落下的 sessionId。
 * DSH 的会话是懒落盘的（第一次 append/flush 才建目录），所以排队中的轮次还没
 * 有 sessionId——前端据此提示「尚未开始」，而不是让人以为会话丢了。
 */
function taskAgentSessionId(
  agent: TaskAgentServiceLike | undefined,
  task: TaskRecord,
): string | undefined {
  if (agent?.run === undefined) return undefined;
  for (const runId of [...task.agentRunIds].reverse()) {
    const sessionId = agent.run(runId)?.sessionId;
    if (typeof sessionId === "string" && sessionId !== "") return sessionId;
  }
  return undefined;
}

/**
 * 「改派给同一个 Agent」是否还有它没看到的内容。
 * 任务内容被改写，或者人在上一轮投递之后又发了消息，都必须重新唤起它：
 * 否则改派只会静默变成一次无操作，用户以为推给了 Agent，实际什么都没发生。
 */
function hasUndeliveredTaskContext(
  task: TaskRecord,
  agent: TaskAgentServiceLike | undefined,
): boolean {
  const sessionEpoch = task.sessionEpoch ?? 0;
  const previous = [...task.agentRunIds]
    .reverse()
    .map((runId) => agent?.run?.(runId))
    .find(
      (run) =>
        run !== undefined &&
        run.payload?.context?.taskReceiverId === task.receiverId &&
        String(run.payload?.context?.taskSessionEpoch ?? "0") ===
          String(sessionEpoch),
    );
  if (previous === undefined) return true;
  const context = previous.payload?.context ?? {};
  const deliveredThrough =
    typeof context.deliveredThroughMessageId === "string"
      ? context.deliveredThroughMessageId
      : "";
  const deliveredIndex =
    deliveredThrough === ""
      ? -1
      : task.messages.findIndex((message) => message.id === deliveredThrough);
  // 增量投递只带人类的新内容；系统事件和 Agent 自己的回复不算「没看过」。
  const hasNewHumanMessage = task.messages
    .slice(deliveredIndex + 1)
    .some((message) => message.kind === "human");
  const digestChanged =
    typeof context.taskDefinitionDigest !== "string" ||
    context.taskDefinitionDigest !== taskDefinitionDigest(task);
  return hasNewHumanMessage || digestChanged;
}

/**
 * 任务派发链路：开通/复用执行身份、唤起 Agent、创建会话并回写任务。
 *
 * 独立导出是为了让其它模块（例如 AI Teammate 的「创建计划项」）在创建任务后复用
 * 同一条链路，而不是各自实现一遍派发，避免出现「任务建好了但 Agent 从未被唤起」。
 */
export function createTaskDispatcher(deps: TaskDispatchDependencies): (
  task: TaskRecord,
  actor: TaskActor,
  trigger?: {
    readonly messageId?: string | undefined;
    readonly content: string;
  },
  contextOverride?: {
    readonly scene: "task" | "meeting";
    readonly objectId: string;
    readonly content: string;
  },
) => Promise<TaskDispatchOutcome> {
  return async (task, currentActor, trigger, contextOverride) => {
    try {
      const run = await dispatchTaskInstruction(
        deps.agent?.(),
        deps.team,
        deps.employees,
        deps.workspaces,
        deps.teammates?.(),
        deps.principalRuntime?.(),
        deps.context?.(),
        task,
        currentActor,
        {
          role: "owner",
          ...(trigger === undefined ? {} : { trigger }),
          ...(contextOverride === undefined ? {} : { contextOverride }),
        },
      );
      return {
        task: await deps.service.attachAgentRun(
          task.id,
          run,
          task.receiverName ?? task.receiverId ?? "Agent",
          ownerHandoff(deps, task, run),
        ),
        execution: { runId: run.id, status: run.status },
      };
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Agent 执行通道不可用";
      return {
        task: await deps.service.failAgentDispatch(
          task.id,
          currentActor,
          message,
        ),
        execution: { error: message },
      };
    }
  };
}

export function createTaskRoutes(
  service: TaskService,
  team: TeamServiceLike,
  employees?: EmployeeServiceLike,
  assignments?: AssignmentServiceLike,
  agent?: () => TaskAgentServiceLike | undefined,
  workspaces?: WorkspaceRegistryLike,
  teammates?: () => TeammateRuntimeLike | undefined,
  principalRuntime?: () => PrincipalRuntimeServiceLike | undefined,
  context?: () => TaskContextServiceLike | undefined,
  documents?: TaskDocumentQueryService,
): WebRouteLike[] {
  const documentQuery =
    documents ??
    createTaskDocumentQueryService(
      service,
      agent ?? (() => undefined),
      workspaces,
    );
  const workspaceRoot = (task: TaskRecord): string | undefined =>
    workspaces?.get(task.workspaceId)?.path;

  const reconcileWorkflowAgentRuns = async (
    workspaceId: string,
  ): Promise<void> => {
    const agentService = agent?.();
    await service.reconcileWorkflowProjections(workspaceId);
    if (agentService?.runs === undefined) return;
    for (const task of service.list(workspaceId)) {
      if (task.workflow === undefined) continue;
      for (const run of agentService.runs({
        instanceId: task.workflow.instanceId,
      })) {
        if (
          task.agentRunIds.includes(run.id) &&
          run.nodeId === task.workflow.nodeId
        ) {
          continue;
        }
        try {
          await service.projectAgentRun(
            { id: "workflow", name: "工作流", kind: "system" },
            task.id,
            run,
            run.payload?.profileName ?? task.receiverName ?? "Agent",
          );
        } catch {
          // A later refresh retries the projection without blocking the list.
        }
      }
    }
    await service.reconcileWorkflowProjections(workspaceId);
  };

  /**
   * 把「任务上下文 + 这次的 @ 诉求 + 相关文档」同步给被 @ 的 Agent：
   * 它会在自己的会话（de-task-<taskId>-<employee>）里回一轮，
   * 产出写回任务历史供人类与任务责任人查看。
   */
  const dispatchMention = async (
    task: TaskRecord,
    actor: TaskActor,
    mention: { readonly id: string; readonly name: string },
    ask: { readonly messageId: string; readonly content: string },
  ): Promise<TaskRecord> => {
    try {
      const run = await dispatchTaskInstruction(
        agent?.(),
        team,
        employees,
        workspaces,
        teammates?.(),
        principalRuntime?.(),
        context?.(),
        task,
        actor,
        {
          role: "assist",
          ref: mention.id,
          name: mention.name,
          ask: ask.content,
          trigger: { messageId: ask.messageId, content: ask.content },
        },
      );
      return await service.attachAgentRun(
        task.id,
        run,
        mention.name,
        undefined,
        {
          role: "assist",
          authorId: mention.id,
          authorName: mention.name,
        },
      );
    } catch (cause) {
      // 协作方派不出去（实例停用 / 缺运行时）不应让整条消息失败，记一条说明即可。
      const message =
        cause instanceof Error ? cause.message : "协作 Agent 不可用";
      return await service.failAgentDispatch(
        task.id,
        actor,
        `${mention.name}：${message}`,
      );
    }
  };

  const bootstrap = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const workspaceId = query(request).get("workspaceId") ?? "";
      const currentActor = requireAccess(request, team, workspaceId);
      await reconcileWorkflowAgentRuns(workspaceId);
      const tasks = service.list(workspaceId);
      sendJson(response, 200, {
        ok: true,
        tasks,
        reviewableTaskIds: tasks
          .filter((task) =>
            canReviewTask({
              task,
              actor: currentActor,
              team,
              assignments,
            }),
          )
          .map((task) => task.id),
        directory: directory(
          team,
          workspaceId,
          employees,
          assignments,
          teammates?.(),
          {
            userId: currentActor.id,
            name: currentActor.name,
            role: currentActor.role ?? "member",
          },
        ),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const mutate =
    (
      handler: (
        request: IncomingMessage,
        actor: TaskActor,
        body: unknown,
      ) => Promise<unknown>,
    ) =>
    async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      try {
        assertSameOrigin(request);
        const body = await readJsonBody(request);
        let workspaceId =
          typeof body === "object" && body !== null && "workspaceId" in body
            ? String((body as { workspaceId?: unknown }).workspaceId ?? "")
            : (query(request).get("workspaceId") ?? "");
        if (
          workspaceId === "" &&
          typeof body === "object" &&
          body !== null &&
          "taskId" in body
        ) {
          workspaceId = service.get(
            String((body as { taskId?: unknown }).taskId ?? ""),
          ).workspaceId;
        }
        if (
          workspaceId === "" ||
          (workspaces !== undefined &&
            workspaces.get(workspaceId) === undefined)
        ) {
          throw new TaskError(
            "invalid_input",
            "任务必须归属到一个已存在的项目",
          );
        }
        const currentActor = requireAccess(request, team, workspaceId);
        const result = await handler(request, currentActor, body);
        sendJson(response, 200, {
          ok: true,
          ...(typeof result === "object" && result !== null
            ? result
            : { result }),
        });
      } catch (cause) {
        routeError(response, cause);
      }
    };

  const dispatchTask = createTaskDispatcher({
    service,
    team,
    employees,
    agent,
    workspaces,
    teammates,
    principalRuntime,
    context,
  });

  return [
    { kind: "exact", path: "/api/collab/tasks/bootstrap", handler: bootstrap },
    {
      kind: "exact",
      path: "/api/collab/tasks",
      handler: bootstrap,
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/session",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const params = taskQuerySchema.parse({
            taskId: query(request).get("taskId") ?? "",
          });
          const task = service.get(params.taskId);
          requireAccess(request, team, task.workspaceId);
          sendJson(response, 200, {
            ok: true,
            sessionId: taskAgentSessionId(agent?.(), task) ?? "",
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/detail",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const params = taskQuerySchema.parse({
            taskId: query(request).get("taskId") ?? "",
          });
          const task = service.get(params.taskId);
          requireAccess(request, team, task.workspaceId);
          sendJson(response, 200, { ok: true, task });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/execution",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const params = taskQuerySchema.parse({
            taskId: query(request).get("taskId") ?? "",
          });
          const task = service.get(params.taskId);
          const currentActor = requireAccess(request, team, task.workspaceId);
          const agentService = agent?.();
          const execution = agentService?.taskExecution?.(
            task.id,
            task.workspaceId,
          );
          sendJson(response, 200, {
            ok: true,
            execution: execution ?? {
              taskId: task.id,
              runs: [],
              events: [],
              gates: [],
              capabilities: {
                planAvailable: false,
                contextAvailable: context !== undefined,
                gateAvailable: agentService?.decideExecutionGate !== undefined,
                memoryAvailable: false,
              },
            },
            actorPrincipalId: currentActor.principalId ?? currentActor.id,
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/execution/gates/decide",
      handler: mutate(async (_request, currentActor, body) => {
        const parsed = z
          .object({
            taskId: z.string().min(1),
            gateId: z.string().min(1),
            decision: z.enum(["approved", "denied"]),
            note: z.string().trim().max(4_000).optional(),
          })
          .parse(body);
        const task = service.get(parsed.taskId);
        const agentService = agent?.();
        if (
          agentService?.executionGate === undefined ||
          agentService.decideExecutionGate === undefined
        ) {
          throw new TaskError("conflict", "Agent Execution Control 不可用");
        }
        const gate = agentService.executionGate(parsed.gateId);
        if (gate === undefined || gate.taskId !== task.id) {
          throw new TaskError("not_found", "执行授权不存在");
        }
        if (
          currentActor.kind === "human" &&
          currentActor.role === "guest" &&
          currentActor.id !== task.createdBy
        ) {
          throw new TaskError("forbidden", "guest 不能批准执行授权");
        }
        return {
          gate: await agentService.decideExecutionGate({
            gateId: parsed.gateId,
            decision: parsed.decision,
            actorPrincipalId: currentActor.principalId ?? currentActor.id,
            ...(parsed.note === undefined ? {} : { note: parsed.note }),
          }),
        };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/create",
      handler: mutate(async (_request, currentActor, body) => {
        const task = await service.create(currentActor, body);
        if (task.receiverType !== "agent" || task.receiverId === undefined) {
          return { task };
        }
        return dispatchTask(task, currentActor);
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/update",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.update(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/review/approval",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.updateReviewApproval(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/confirm",
      handler: mutate(async (_request, currentActor, body) => {
        const parsed = z
          .object({
            taskId: z.string().min(1).max(160),
            action: z.enum(["approve", "reject", "handoff"]),
            note: z.string().trim().max(8_000).optional(),
            assigneeId: z.string().trim().min(1).max(160).optional(),
          })
          .parse(body);
        const task = service.get(parsed.taskId);
        // 待确认权限：实例 owner（实例创建人）→ 工作区 owner → 平台管理员。
        const ownerId =
          task.receiverId === undefined
            ? undefined
            : teammates?.()?.ownerOf?.(task.receiverId)?.userId;
        const isWorkspaceOwner = team
          .members(task.workspaceId)
          .some(
            (member) =>
              member.userId === currentActor.id &&
              member.memberRole === "owner",
          );
        if (
          currentActor.role !== "admin" &&
          ownerId !== currentActor.id &&
          !isWorkspaceOwner
        ) {
          throw new TaskError(
            "forbidden",
            "只有实例 owner 或工作区 owner 可以确认",
          );
        }
        const assigneeName =
          parsed.assigneeId === undefined
            ? undefined
            : (team.users().find((user) => user.id === parsed.assigneeId)
                ?.name ?? parsed.assigneeId);
        const confirmed = await service.confirm(currentActor, {
          taskId: parsed.taskId,
          action: parsed.action,
          ...(parsed.note === undefined ? {} : { note: parsed.note }),
          ...(parsed.assigneeId === undefined
            ? {}
            : { assigneeId: parsed.assigneeId }),
          ...(assigneeName === undefined ? {} : { assigneeName }),
        });
        if (parsed.action !== "reject" || confirmed.status !== "todo") {
          return { task: confirmed };
        }
        // 退回后立刻重新入队执行（P1 由本路由触发；P3 起改由队列执行器统一出队）。
        return dispatchTask(confirmed, currentActor);
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/queue/reorder",
      handler: mutate(async (_request, currentActor, body) => {
        const parsed = z
          .object({
            workspaceId: z.string().min(1).max(200),
            orderedTaskIds: z.array(z.string().min(1).max(160)).max(500),
          })
          .safeParse(body);
        if (!parsed.success) {
          throw new TaskError("invalid_input", "request input is invalid");
        }
        return {
          tasks: await service.reorderQueue(currentActor, {
            taskIds: parsed.data.orderedTaskIds,
          }),
        };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/queue/item",
      handler: mutate(async (_request, currentActor, body) => {
        const parsed = z
          .object({
            taskId: z.string().min(1).max(160),
            queueState: z.enum(["idle", "blocked", "paused"]).optional(),
            autoRunEligible: z.boolean().optional(),
            dependsOn: z.array(z.string().min(1).max(160)).max(50).optional(),
          })
          .safeParse(body);
        if (!parsed.success) {
          throw new TaskError("invalid_input", "request input is invalid");
        }
        return {
          task: await service.updateQueueItem(currentActor, parsed.data),
        };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/assign",
      handler: mutate(async (_request, currentActor, body) => {
        const taskId = String((body as { taskId?: unknown }).taskId ?? "");
        const before = service.get(taskId);
        const task = await service.assign(currentActor, body);
        const changed =
          before.receiverType !== task.receiverType ||
          before.receiverId !== task.receiverId;
        // 已完成任务被指派 = 追加要求并重开一轮，即使人没换也要重新跑。
        const reopened = before.status === "done" && task.status !== "done";
        // 工作流任务由节点执行链路派发；任务层只负责人选和投影，不能再
        // 创建一条 instanceId=taskId 的普通任务会话。
        if (task.workflow !== undefined) {
          return { task };
        }
        if (task.receiverType !== "agent" || task.receiverId === undefined) {
          return { task };
        }
        // 同一个 Agent 也是合法入口：只要还有它没看到的上下文（新消息/改过的
        // 任务内容），改派就应该真的唤起它，而不是静默返回。
        if (
          !changed &&
          !reopened &&
          !hasUndeliveredTaskContext(task, agent?.())
        ) {
          return { task };
        }
        return dispatchTask(task, currentActor);
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/claim",
      handler: mutate(async (_request, currentActor, body) => {
        const task = service.get(
          String((body as { taskId?: unknown }).taskId ?? ""),
        );
        // 项目角色任务：只有该角色当前在册的成员可以认领；任意一人认领
        // 并完成即视为任务完成（或签）。角色目录不可用时保持旧行为。
        const members =
          task.receiverType === "role" && task.receiverId !== undefined
            ? seatMembers(assignments, task.workspaceId, task.receiverId)
            : undefined;
        if (
          members !== undefined &&
          !members.some(
            (member) => member.kind === "user" && member.id === currentActor.id,
          )
        ) {
          throw new TaskError(
            "forbidden",
            `只有「${task.receiverName ?? task.receiverId}」的当前成员可以认领该任务`,
          );
        }
        return { task: await service.claim(currentActor, task.id) };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/status",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.changeStatus(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/action",
      handler: mutate(async (_request, currentActor, body) => {
        const parsedBody = body as {
          taskId?: unknown;
          action?: unknown;
          note?: unknown;
        };
        const taskIdValue = String(parsedBody.taskId ?? "");
        const action = String(parsedBody.action ?? "");
        const note = typeof parsedBody.note === "string" ? parsedBody.note : "";
        if (action === "approve" || action === "reject") {
          const task = service.get(taskIdValue);
          if (
            !canReviewTask({
              task,
              actor: currentActor,
              team,
              assignments,
            })
          ) {
            throw new TaskError(
              "forbidden",
              "只有创建人、项目负责人或具备审批权限的项目角色可以验收任务",
            );
          }
        }
        if (action === "reject") {
          const rejected = await service.reject(
            currentActor,
            taskIdValue,
            note,
          );
          if (
            rejected.receiverType !== "agent" ||
            rejected.receiverId === undefined
          ) {
            return { task: rejected };
          }
          const feedback = rejected.messages.at(-1);
          return dispatchTask(
            rejected,
            currentActor,
            feedback === undefined
              ? undefined
              : { messageId: feedback.id, content: feedback.content },
          );
        }
        const actions: Record<string, () => Promise<TaskRecord>> = {
          start: () => service.start(currentActor, taskIdValue),
          submit: () => service.submit(currentActor, taskIdValue),
          approve: () => service.approve(currentActor, taskIdValue),
          nudge: () => service.nudge(currentActor, taskIdValue),
          archive: () => service.archive(currentActor, taskIdValue),
          restore: () => service.restore(currentActor, taskIdValue),
        };
        const run = actions[action];
        if (run === undefined) {
          throw new TaskError("invalid_input", "unknown task action");
        }
        return { task: await run() };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/message",
      handler: mutate(async (_request, currentActor, body) => {
        const saved = await service.addMessage(currentActor, body);
        const last = saved.messages.at(-1);
        if (last === undefined) return { task: saved };
        const deliveryTarget = last.deliveryTarget ?? "receiver";
        // 被 @ 的其它 Agent：各自在自己的会话里回一轮，产出写回任务历史。
        const mentionedAgents =
          deliveryTarget === "receiver"
            ? []
            : [
                ...new Map(
                  last.mentions
                    .filter(
                      (mention) =>
                        mention.kind === "agent" &&
                        mention.id !== saved.receiverId,
                    )
                    .map((mention) => [mention.id, mention]),
                ).values(),
              ];
        let task = saved;
        for (const mention of mentionedAgents) {
          task = await dispatchMention(task, currentActor, mention, {
            messageId: last.id,
            content: last.content,
          });
        }
        if (saved.receiverType !== "agent" || saved.receiverId === undefined) {
          return { task };
        }
        // 一条消息如果 @ 的是别人、且没 @ 任务责任人，就不是在要求责任人执行：
        // 只把信息同步进它的上下文，不要唤起它跑一轮。
        if (deliveryTarget === "collaborators") {
          return { task, dispatched: false };
        }
        // 指令输入框发出的消息默认就是给执行人的指令，直接触发，不需要 @。
        return dispatchTask(task, currentActor, {
          messageId: last.id,
          content: last.content,
        });
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/comment",
      handler: mutate(async (_request, currentActor, body) => {
        const task = await service.addComment(currentActor, body);
        if (task.workflow !== undefined) {
          return { task, dispatched: false };
        }
        if (task.receiverType !== "agent" || task.receiverId === undefined) {
          return { task };
        }
        const comment = task.comments.at(-1);
        // 评论区是讨论区：只有 @ 了执行人才触发执行。
        if (
          comment === undefined ||
          comment.kind !== "human" ||
          !taskMessageMentionsReceiver(task, comment.content)
        ) {
          return { task, dispatched: false };
        }
        return dispatchTask(task, currentActor, { content: comment.content });
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/session/reset",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.resetSession(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/comment/reply",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.replyComment(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/step",
      handler: mutate(async (_request, currentActor, body) => ({
        task: await service.toggleStep(currentActor, body),
      })),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/documents",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const params = taskQuerySchema.parse({
            taskId: query(request).get("taskId") ?? "",
          });
          const task = service.get(params.taskId);
          requireAccess(request, team, task.workspaceId);
          const result = await documentQuery.list(task.id);
          sendJson(response, 200, {
            ok: true,
            documents: result.documents,
            workspaceReady: result.workspaceReady,
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/document/content",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const params = query(request);
          const task = service.get(params.get("taskId") ?? "");
          requireAccess(request, team, task.workspaceId);
          const root = workspaceRoot(task);
          if (root === undefined) {
            throw new TaskError("conflict", "任务工作区不可用");
          }
          const absolute = safeResolve(root, params.get("path") ?? "");
          const info = await stat(absolute).catch(() => undefined);
          if (info === undefined || !info.isFile()) {
            throw new TaskError("not_found", "文件不存在");
          }
          const name = basename(absolute);
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": mimeTypeFor(name),
            "content-length": String(info.size),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            "x-content-type-options": "nosniff",
          });
          await pipeline(createReadStream(absolute), response);
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/document/reveal",
      handler: mutate(async (_request, _actor, body) => {
        const parsed = body as { taskId?: unknown; path?: unknown };
        const task = service.get(String(parsed.taskId ?? ""));
        const root = workspaceRoot(task);
        if (root === undefined) {
          throw new TaskError("conflict", "任务工作区不可用");
        }
        const relativePath = String(parsed.path ?? "");
        const target =
          relativePath === "" ? root : safeResolve(root, relativePath);
        await revealInFileManager(target);
        return { revealed: relativePath };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/tasks/document/upload",
      handler: async (request, response) => {
        try {
          assertSameOrigin(request);
          const parsed = uploadInputSchema.safeParse(
            await readJsonBody(request, 24 * 1024 * 1024),
          );
          if (!parsed.success) {
            throw new TaskError("invalid_input", "上传内容不合法");
          }
          const task = service.get(parsed.data.taskId);
          const currentActor = requireAccess(request, team, task.workspaceId);
          const root = workspaceRoot(task);
          if (root === undefined) {
            throw new TaskError("conflict", "任务工作区不可用");
          }
          const content = decodeBase64(parsed.data.contentBase64);
          const directory = uploadDirectory(root, task.id);
          await mkdir(directory, { recursive: true });
          const fileName = safeFileName(parsed.data.name);
          const absolute = join(directory, fileName);
          await writeFile(absolute, content);
          sendJson(response, 200, {
            ok: true,
            document: {
              name: fileName,
              relativePath: toRelativePath(root, absolute),
              size: content.byteLength,
              mimeType: parsed.data.mimeType ?? mimeTypeFor(fileName),
              uploadedBy: currentActor.name,
            },
          });
        } catch (cause) {
          routeError(response, cause);
        }
      },
    },
  ];
}

function assertSameOrigin(request: IncomingMessage): void {
  if (
    request.headers.origin !== undefined &&
    !sameOrigin(request.headers.origin, request.headers.host)
  ) {
    throw new TaskError("forbidden", "same-origin request is required");
  }
}

export async function apply(ctx: TaskContext): Promise<void> {
  const domain = await ctx.storageDomain.open(taskDomainSpec);
  const service = new TaskService(
    { tasks: domain.table("tasks") },
    {
      principals: () =>
        ctx.get("collabPrincipal") as TaskPrincipalServiceLike | undefined,
      onChange: (task) => {
        try {
          ctx.emit?.("collab/task-changed", {
            taskId: task.id,
            workspaceId: task.workspaceId,
            status: task.status,
          });
          if (task.status === "done") {
            void (ctx.get("collabMemory") as MemoryIngestLike | undefined)
              ?.ingestSource({
                sourceType: "task",
                sourceId: task.id,
                version: task.updatedAt,
                workspaceId: task.workspaceId,
                payload: {
                  title: task.title,
                  content: [
                    task.description,
                    "",
                    "## 验收标准",
                    ...task.acceptance.map(
                      (item, index) => `${String(index + 1)}. ${item}`,
                    ),
                    "",
                    "## 任务时间线",
                    ...task.messages.map(
                      (message) => `${message.authorName}：${message.content}`,
                    ),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  occurredAt: task.updatedAt,
                  projectId: task.workspaceId,
                  sourceRefs: [
                    { type: "task", id: task.id },
                    ...task.links.flatMap((link) =>
                      link.type === "meeting" ||
                      link.type === "workflow" ||
                      link.type === "document"
                        ? [
                            {
                              type: link.type,
                              id: link.id,
                              ...(link.label === undefined
                                ? {}
                                : { quote: link.label }),
                            },
                          ]
                        : [],
                    ),
                  ],
                  metadata: {
                    type: task.type,
                    status: task.status,
                    priority: task.priority,
                  },
                },
              })
              .catch(() => undefined);
          }
        } catch {
          // Domain events are best-effort.
        }
      },
    },
  );
  ctx.provide("collabTasks", service);
  ctx.effect(() => () => void domain.close());
  ctx.inject(["collabContext"], (child) => {
    const dispose = child.collabContext.registerAdapter({
      scene: "task",
      resolve: async (input) => {
        const task = service.get(input.objectId.replace(/:g\d+$/, ""));
        return {
          allowed:
            input.workspaceId === undefined ||
            input.workspaceId === task.workspaceId,
          workspaceId: task.workspaceId,
          sceneRevision: task.updatedAt,
          sourceRefs: [
            { type: "task" as const, id: task.id },
            ...task.links.flatMap((link) =>
              link.type === "meeting" ||
              link.type === "workflow" ||
              link.type === "document"
                ? [{ type: link.type, id: link.id }]
                : [],
            ),
          ],
        };
      },
      loadFacts: async (input) => {
        const task = service.get(input.objectId.replace(/:g\d+$/, ""));
        const text = buildTaskContext(task, {
          firstDelivery: true,
          statelessExternal: true,
        });
        return {
          text,
          structured: {
            id: task.id,
            title: task.title,
            type: task.type,
            status: task.status,
            priority: task.priority,
            description: task.description,
            acceptance: task.acceptance,
            due: task.due ?? null,
            receiverId: task.receiverId ?? null,
            links: task.links,
          },
          sourceRefs: [
            { type: "task" as const, id: task.id },
            ...task.links.flatMap((link) =>
              link.type === "meeting" ||
              link.type === "workflow" ||
              link.type === "document"
                ? [{ type: link.type, id: link.id }]
                : [],
            ),
          ],
          historyText: task.messages
            .map((message) => `${message.authorName}：${message.content}`)
            .join("\n"),
          contributions: taskContextContributions(task),
        };
      },
      policy: async (input) => {
        const task = service.get(input.objectId.replace(/:g\d+$/, ""));
        const executionPolicy =
          task.executionPolicy ?? legacyTaskExecutionPolicy();
        return {
          version: `task-context-v2:${createHash("sha1")
            .update(JSON.stringify(executionPolicy))
            .digest("hex")
            .slice(0, 12)}`,
          instructions: [
            "你正在执行一个受治理的平台任务。",
            "以任务定义、最新人类指令和 ContextPack 中标记为当前真相的内容为准。",
            "只能使用执行来源策略明确允许的来源；需要公开网页时，按 Runtime 工具能力检索并记录引用。",
            "不得访问未授权的私有来源，也不得伪造已读取的来源。",
            "禁止或需要审批的工具类别必须遵守平台 Gate，不得绕过。",
            "输出格式必须满足任务交付要求。",
            "",
            ...taskExecutionPolicyLines(task),
          ].join("\n"),
          allowedWriteback: ["agent-private-memory", "run-evidence"],
          policySections: {
            sourcePolicy: taskSourcePolicyLines(task).join("\n"),
            executionPolicy: taskToolPolicyLines(task).join("\n"),
          },
        };
      },
    });
    child.effect(() => () => dispose());
  });
  ctx.inject(["collabTeam"], (child) => {
    const employees = child.get("collabEmployee") as
      EmployeeServiceLike | undefined;
    const assignments = child.get("collabAssignment") as
      AssignmentServiceLike | undefined;
    const workspaces = child.get("workspaceRegistry") as
      WorkspaceRegistryLike | undefined;
    const taskDocuments = createTaskDocumentQueryService(
      service,
      () => child.get("collabAgent") as TaskAgentServiceLike | undefined,
      workspaces,
    );
    child.provide("collabTaskDocuments", taskDocuments);
    const dispatchService: TaskDispatchService = {
      dispatch: createTaskDispatcher({
        service,
        team: child.collabTeam,
        employees,
        agent: () =>
          child.get("collabAgent") as TaskAgentServiceLike | undefined,
        workspaces,
        teammates: () =>
          child.get("collabTeammateRuntime") as TeammateRuntimeLike | undefined,
        principalRuntime: () =>
          child.get("collabPrincipalRuntime") as
            PrincipalRuntimeServiceLike | undefined,
        context: () =>
          child.get("collabContext") as TaskContextServiceLike | undefined,
      }),
    };
    child.provide("collabTaskDispatch", dispatchService);
    const disposers = createTaskRoutes(
      service,
      child.collabTeam,
      employees,
      assignments,
      () => child.get("collabAgent") as TaskAgentServiceLike | undefined,
      workspaces,
      () =>
        child.get("collabTeammateRuntime") as TeammateRuntimeLike | undefined,
      () =>
        child.get("collabPrincipalRuntime") as
          PrincipalRuntimeServiceLike | undefined,
      () => child.get("collabContext") as TaskContextServiceLike | undefined,
      taskDocuments,
    ).map((route) => child.webServer.register(route) as () => void);
    child.effect(() => () => {
      for (const dispose of disposers) dispose();
    });
  });
  ctx.inject(["collabAgent", "workspaceRegistry"], async (child) => {
    const workspaces = child.get("workspaceRegistry") as
      WorkspaceRegistryLike | undefined;
    child.collabAgent.bindTask({
      onSettled: async (run) => {
        const task = service.get(run.instanceId);
        const runRole = run.payload?.context?.taskRunRole;
        if (runRole === "assist" || runRole === "fyi") {
          // 被 @ 的协作方 / FYI 轮次只把产出写回任务历史，不推进任务生命周期。
          const name =
            (typeof run.payload?.context?.taskReceiverName === "string" &&
            run.payload.context.taskReceiverName.trim() !== ""
              ? run.payload.context.taskReceiverName
              : undefined) ??
            task.receiverName ??
            task.receiverId ??
            "Agent";
          const authorId =
            typeof run.payload?.context?.taskReceiverId === "string"
              ? run.payload.context.taskReceiverId
              : undefined;
          await service.attachAgentRun(task.id, run, name, undefined, {
            role: runRole,
            authorName: name,
            ...(authorId === undefined ? {} : { authorId }),
          });
          return;
        }
        const root = workspaces?.get(task.workspaceId)?.path;
        if (root !== undefined) {
          await materializeAgentOutputDocuments({
            root,
            taskId: task.id,
            runs: [
              {
                id: run.id,
                status: run.status,
                actor: taskRunActorName(task, run),
                output: run.output,
              },
            ],
          }).catch(() => []);
        }
        await service.attachAgentRun(
          task.id,
          run,
          task.receiverName ?? task.receiverId ?? "Agent",
          // 执行真正结束时把任务交回实例 owner（实例创建人）确认。
          resolveOwnerHandoff(
            {
              team: child.get("collabTeam") as TeamServiceLike | undefined,
              teammates: () =>
                child.get("collabTeammateRuntime") as
                  TeammateRuntimeLike | undefined,
            },
            task,
            run,
          ),
        );
      },
    });
    const taskTitles = new Map<string, string>();
    for (const workspace of workspaces?.list() ?? []) {
      for (const task of service.list(workspace.id)) {
        if (task.receiverType === "agent" && task.receiverName?.trim()) {
          taskTitles.set(task.id, task.receiverName.trim());
        }
      }
    }
    if (taskTitles.size > 0) {
      await child.collabAgent.syncTaskSessionTitles?.(taskTitles);
    }
  });
}
