import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { parseWorkflowMarkdown, evaluateExpression } from "./parser.js";
import {
  nodeStateSchema,
  workflowDefinitionSchema,
  workflowEventSchema,
  workflowGraphSchema,
  workflowInstanceSchema,
  workflowSubmissionSchema,
  type Approver,
  type DeliverableRequirement,
  type DeliverableState,
  type Executor,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInstance,
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowNodeState,
  type WorkflowSubmission,
  type WorkflowVariable,
} from "./types.js";

export type {
  Approver,
  Executor,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowInstance,
  WorkflowNode,
  WorkflowNodeState,
  WorkflowSubmission,
  WorkflowVariable,
};

export const name = "dsh-collab-workflow";
export const inject = ["storageDomain", "commands", "tools", "webServer"];

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

export interface WorkflowDomainLike {
  table(name: "definitions"): KvTableLike<WorkflowDefinition>;
  table(name: "instances"): KvTableLike<WorkflowInstance>;
  table(name: "events"): KvTableLike<WorkflowEvent>;
  table(name: "submissions"): KvTableLike<WorkflowSubmission>;
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

export interface TeamUserLike {
  readonly id: string;
  readonly name?: string;
}

export interface TeamServiceLike {
  resolveToken(token: string):
    | {
        readonly userId: string;
        readonly role: "admin" | "owner" | "member" | "guest";
      }
    | undefined;
  members(workspaceId: string): readonly TeamMemberLike[];
  users(): readonly TeamUserLike[];
}

interface PrincipalRecordLike {
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly status: "active" | "suspended" | "archived";
}

export interface WorkflowPrincipalServiceLike {
  resolveReference(reference: string): PrincipalRecordLike | undefined;
  resolveSubject(
    subjectType: "auth-user" | "employee" | "teammate",
    subjectId: string,
  ): PrincipalRecordLike | undefined;
  preferredSubjectId(
    principalId: string,
    subjectTypes: readonly ("auth-user" | "employee" | "teammate" | "hrm")[],
  ): string | undefined;
}

export interface WorkflowPrincipalRuntimeLike {
  profiles?(input?: {
    readonly principalId?: string | undefined;
    readonly workspaceId?: string | undefined;
  }): readonly {
    readonly id: string;
    readonly principalId: string;
    readonly workspaceId: string;
    readonly agentProfileId: string;
    readonly status: string;
  }[];
  profile(
    principalId: string,
    workspaceId: string,
  ):
    | {
        readonly id: string;
        readonly agentProfileId: string;
        readonly status: string;
      }
    | undefined;
  issueTicket(input: {
    readonly principalId: string;
    readonly workspaceId: string;
    readonly contextType: "workflow";
    readonly contextId: string;
    readonly requestedActions: readonly string[];
    readonly resourceScopes?: readonly string[];
    readonly durationMinutes?: number;
    readonly issuedByUserId: string;
  }): Promise<{ readonly id: string }>;
  authorizeTicket(input: {
    readonly ticketId: string;
    readonly action: string;
    readonly resource?: string;
    readonly workspaceId: string;
    readonly contextType: "workflow";
    readonly contextId: string;
  }): Promise<unknown>;
}

export interface WorkflowEmployeeTarget {
  readonly employee: {
    readonly id: string;
    readonly displayName: string;
    readonly status: string;
    readonly principalId?: string | undefined;
  };
  readonly assignment: {
    readonly role: "viewer" | "member" | "owner";
    readonly permissions: readonly string[];
  };
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly legacyAgentProfileId?: string | undefined;
  };
}

export interface EmployeeServiceLike {
  employeeWorkspaceTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly employee: {
          readonly id: string;
          readonly displayName: string;
          readonly status: string;
        };
        readonly assignment: {
          readonly role: "viewer" | "member" | "owner";
          readonly permissions: readonly string[];
        };
      }
    | undefined;
  workflowTarget(
    employeeId: string,
    workspaceId: string,
  ): WorkflowEmployeeTarget | undefined;
  workflowDispatchBlockReason(
    employeeId: string,
    workspaceId: string,
  ): string | undefined;
  employeeApprovalTarget(
    employeeId: string,
    workspaceId: string,
  ):
    | {
        readonly id: string;
        readonly displayName: string;
        readonly status: string;
      }
    | undefined;
  issueRuntimeTicket(
    actorAuthUserId: string,
    input: {
      readonly actorAuthUserId: string;
      readonly employeeId: string;
      readonly workspaceId: string;
      readonly contextType: "workflow";
      readonly contextId: string;
      readonly requestedActions: readonly string[];
      readonly resourceScopes?: readonly string[] | undefined;
      readonly runId?: string | undefined;
      readonly durationMinutes?: number | undefined;
    },
  ): Promise<{
    readonly id: string;
    readonly principal?: { readonly principalId?: string | undefined };
  }>;
  authorizeTicket(input: {
    readonly ticketId: string;
    readonly action: string;
    readonly resource?: string | undefined;
    readonly workspaceId: string;
    readonly contextType: "workflow";
    readonly contextId: string;
  }): Promise<{
    readonly employeeId: string;
    readonly principalId?: string | undefined;
  }>;
}

export interface AgentRunView {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspacePath?: string | undefined;
  readonly agentProfileId: string;
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
  readonly instanceId: string;
  readonly nodeId: string;
  readonly dispatchKey: string;
  readonly trigger: "manual-dispatch" | "auto-on-ready";
  readonly status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  readonly attempt: number;
  readonly runSeq: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly payload: {
    readonly instanceTitle: string;
    readonly nodeName: string;
    readonly nodeDescription: string;
    readonly profileName: string;
    readonly previousFailure?: string | undefined;
    readonly employeeName?: string | undefined;
    readonly responsibleId?: string | undefined;
    readonly deliverables: ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly type: "file" | "text" | "link";
      readonly required: boolean;
      readonly description: string;
      readonly minTextLength?: number | undefined;
    }>;
    readonly context: Record<string, string | number | boolean>;
  };
  readonly promptSnapshot?: string | undefined;
  readonly execution?:
    | {
        readonly provider: string;
        readonly model: string;
        readonly runtime: string;
        readonly runtimeVersion: string;
        readonly authMode: string;
        readonly sandbox: string;
      }
    | undefined;
  readonly output?:
    | {
        readonly summary: string;
        readonly endedAt?: string | undefined;
        readonly stopReason?: string | undefined;
      }
    | undefined;
  readonly error?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface WorkflowTaskRef {
  readonly id: string;
  readonly receiverType: "unassigned" | "human" | "agent" | "role";
  readonly receiverId?: string | undefined;
  readonly receiverName?: string | undefined;
  readonly status: "todo" | "progress" | "review" | "done" | "cancelled";
  readonly nodeAttempt?: number | undefined;
  readonly reviewRequired?: boolean | undefined;
  readonly autoApproveReview?: boolean | undefined;
  readonly workflow?:
    | {
        readonly outcome?: string | undefined;
        readonly approvalPolicy?: "all" | "any" | undefined;
        readonly approverIds?: readonly string[] | undefined;
      }
    | undefined;
}

export interface WorkflowTaskBridge {
  get(taskId: string): WorkflowTaskRef | undefined;
  create(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    input: Record<string, unknown>,
  ): Promise<WorkflowTaskRef>;
  projectAssigned(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    input: Record<string, unknown>,
  ): Promise<WorkflowTaskRef>;
  projectReceiverDisplay?(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    input: Record<string, unknown>,
  ): Promise<WorkflowTaskRef>;
  projectApprovalApprovers?(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    input: { taskId: string; approverIds: readonly string[] },
  ): Promise<WorkflowTaskRef>;
  settle(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    taskId: string,
    outcome: "approved" | "rejected" | "cancelled" | "superseded",
  ): Promise<WorkflowTaskRef>;
  projectStatus?(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    taskId: string,
    status: "todo" | "progress" | "review",
    message: string,
  ): Promise<WorkflowTaskRef>;
  projectEvent?(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    taskId: string,
    event: {
      readonly id: string;
      readonly instanceId: string;
      readonly nodeId?: string | undefined;
      readonly actorId: string;
      readonly actorKind: "user" | "agent" | "employee" | "system";
      readonly actorName: string;
      readonly message: string;
      readonly at: string;
    },
  ): Promise<WorkflowTaskRef>;
  projectAgentRun?(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "system";
    },
    taskId: string,
    run: {
      readonly id: string;
      readonly nodeId: string;
      readonly status: AgentRunView["status"];
      readonly output?: AgentRunView["output"];
      readonly error?: string | undefined;
      readonly execution?: AgentRunView["execution"];
    },
    receiverName: string,
  ): Promise<WorkflowTaskRef>;
}

export interface AgentServiceLike {
  profile(
    workspaceId: string,
    profileId: string,
  ):
    | {
        readonly id: string;
        readonly name: string;
        readonly runtimeKind: string;
        readonly status: string;
        readonly personaId?: string | undefined;
        readonly execution?: "builtin" | "external" | undefined;
      }
    | undefined;
  runs(instanceId: string, nodeId?: string | undefined): AgentRunView[];
  run(runId: string): AgentRunView | undefined;
  dispatch(input: {
    readonly workspaceId: string;
    readonly workspacePath?: string | undefined;
    readonly profileId: string;
    readonly source: "workflow";
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
    readonly payload: AgentRunView["payload"];
    readonly createdBy: string;
  }): Promise<AgentRunView>;
  cancel(runId: string): Promise<AgentRunView>;
  bindWorkflow(handler: {
    onSettled(run: AgentRunView): Promise<void> | void;
  }): void;
}

export interface WorkflowActor {
  readonly kind: "user" | "agent";
  readonly id: string;
  readonly name?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly globalRole?: "admin" | "owner" | "member" | "guest" | undefined;
  readonly workspaceRole?: "owner" | "member" | "guest" | undefined;
}

interface CommandInvocationLike {
  readonly rawInput: string;
}

interface ToolExecLike {
  signal: { throwIfAborted(): void };
  session?: { readonly id?: string };
}

interface ToolOutputLike {
  readonly schema: { readonly type: "string" };
  render(args: unknown, value: string): Array<{ type: "text"; text: string }>;
}

const stringToolOutput: ToolOutputLike = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

interface WorkflowContextPackLike {
  readonly id: string;
  readonly sessionBindingId: string;
  readonly rendered: {
    readonly systemText: string;
    readonly userText: string;
    readonly flattenedPrompt: string;
  };
}

interface WorkflowContextServiceLike {
  registerAdapter(adapter: {
    readonly scene: "workflow-node";
    resolve(input: {
      readonly workspaceId?: string;
      readonly objectId: string;
      readonly agentPrincipalId: string;
      readonly actorPrincipalId: string;
    }): Promise<{
      readonly allowed: boolean;
      readonly workspaceId?: string;
      readonly sceneRevision: string;
      readonly sourceRefs: readonly {
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
      }[];
    }>;
    loadFacts(input: {
      readonly workspaceId?: string;
      readonly objectId: string;
      readonly agentPrincipalId: string;
      readonly asOf: string;
    }): Promise<{
      readonly text: string;
      readonly structured?: Readonly<Record<string, unknown>>;
      readonly sourceRefs: readonly {
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
      }[];
      readonly historyText?: string;
    }>;
    policy(): Promise<{
      readonly version: string;
      readonly instructions: string;
      readonly allowedWriteback: readonly (
        | "agent-private-memory"
        | "run-evidence"
        | "memory-candidate"
      )[];
    }>;
  }): () => void;
  prepare(input: Record<string, unknown>): Promise<WorkflowContextPackLike>;
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

interface WorkflowContext {
  storageDomain: { open(spec: DomainSpecLike): Promise<WorkflowDomainLike> };
  commands: { register(definition: unknown): unknown };
  tools: { register(definition: unknown): unknown };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: "collabWorkflow", service: WorkflowService): void;
  effect(operation: () => () => void): void;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: WorkflowContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void } | void;
  inject(
    keys: readonly ["collabAgent"],
    callback: (
      child: WorkflowContext & { readonly collabAgent: AgentServiceLike },
    ) => void,
  ): { dispose(): void } | void;
  inject(
    keys: readonly ["collabEmployee"],
    callback: (
      child: WorkflowContext & {
        readonly collabEmployee: EmployeeServiceLike;
      },
    ) => void,
  ): { dispose(): void } | void;
  get(key: "collabTeam"): TeamServiceLike | undefined;
  get(key: "collabAgent"): AgentServiceLike | undefined;
  get(key: "collabEmployee"): EmployeeServiceLike | undefined;
  get(key: "collabTasks"): WorkflowTaskBridge | undefined;
  inject(
    keys: readonly ["collabTasks"],
    callback: (
      child: WorkflowContext & { readonly collabTasks: WorkflowTaskBridge },
    ) => void,
  ): { dispose(): void } | void;
  get(key: "workspaceRegistry"): WorkflowWorkspaceRegistryLike | undefined;
  get(key: "collabTeammateRuntime"): WorkflowTeammateRuntimeLike | undefined;
  get(key: "collabTeammates"): WorkflowTeammateServiceLike | undefined;
  get(key: "collabAssignment"): WorkflowRoleServiceLike | undefined;
  get(key: "collabPrincipal"): WorkflowPrincipalServiceLike | undefined;
  get(key: "collabPrincipalRuntime"): WorkflowPrincipalRuntimeLike | undefined;
  get(key: "collabContext"): WorkflowContextServiceLike | undefined;
  get(key: "collabMemory"):
    | {
        ingestSource(input: {
          readonly sourceType: "workflow";
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
            }[];
            readonly metadata?: Readonly<
              Record<string, string | number | boolean>
            >;
          };
        }): Promise<unknown>;
      }
    | undefined;
  inject(
    keys: readonly ["workspaceRegistry"],
    callback: (
      child: WorkflowContext & {
        readonly workspaceRegistry: WorkflowWorkspaceRegistryLike;
      },
    ) => void,
  ): { dispose(): void } | void;
  inject(
    keys: readonly ["collabContext"],
    callback: (
      child: WorkflowContext & {
        readonly collabContext: WorkflowContextServiceLike;
      },
    ) => void,
  ): { dispose(): void } | void;
}

export const workflowDomainSpec = {
  name: "collab_workflow",
  version: 1,
  tables: {
    definitions: {
      valueSchema: workflowDefinitionSchema as unknown as z.ZodType<unknown>,
    },
    instances: {
      valueSchema: workflowInstanceSchema as unknown as z.ZodType<unknown>,
    },
    events: {
      valueSchema: workflowEventSchema as unknown as z.ZodType<unknown>,
    },
    submissions: {
      valueSchema: workflowSubmissionSchema as unknown as z.ZodType<unknown>,
    },
  },
} as const satisfies DomainSpecLike;

interface WorkflowWorkspaceLike {
  readonly path: string;
  readonly title?: string | undefined;
}

interface WorkflowWorkspaceRegistryLike {
  get(workspaceId: string): WorkflowWorkspaceLike | undefined;
  list?(): readonly (WorkflowWorkspaceLike & { readonly id: string })[];
}

/** AI Teammate 运行时：派发前确保实例在该项目下有可用运行身份。 */
interface WorkflowTeammateRuntimeLike {
  ensureRuntime(input: {
    readonly teammateId: string;
    readonly workspaceId: string;
    readonly actor: {
      readonly userId: string;
      readonly name: string;
      readonly role: "admin" | "owner" | "member" | "guest";
    };
  }): Promise<{
    readonly teammateId: string;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
    readonly profileId: string;
  }>;
}

/** 项目角色目录：角色定义（来自平台按项目类型下发的模版，by 项目物化）。 */
interface WorkflowProjectRoleLike {
  readonly id: string;
  readonly label: string;
  readonly participantKind?: string | undefined;
  readonly personaId?: string | undefined;
  readonly permissions?: readonly string[] | undefined;
}

/**
 * 项目角色服务（dsh-collab-roles 的 `collabAssignment`）：
 * 角色定义 by 项目维护，成员是「当前时刻该角色上的人 / teammate 实例」集合。
 */
interface WorkflowRoleServiceLike {
  config(workspaceId: string): {
    readonly seats: readonly WorkflowProjectRoleLike[];
  };
  members?(
    workspaceId: string,
    seatId: string,
  ): readonly {
    readonly assigneeKind: "user" | "agent";
    readonly assigneeId: string;
    readonly status: string;
  }[];
}

/** AI Teammate 实例清单：仅用于把执行者 id 解析成可读名字。 */
interface WorkflowTeammateServiceLike {
  list(): readonly {
    readonly id: string;
    readonly name: string;
    readonly state?: string | undefined;
    readonly employeeId?: string | undefined;
    readonly ownerUserId?: string | undefined;
    readonly ownerName?: string | undefined;
  }[];
}

/** 实例接口下发的项目名：优先工作区标题，缺省回退到目录名。 */
function workflowWorkspaceName(
  workspace: WorkflowWorkspaceLike | undefined,
): string | undefined {
  if (workspace === undefined) return undefined;
  const title = workspace.title?.trim();
  if (title !== undefined && title !== "") return title;
  const segment = workspace.path
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return segment === undefined || segment === "" ? undefined : segment;
}

/**
 * 执行者可读名：Agent Profile 名（停用时带标记）/ Teammate 名。
 * 解析不到时返回 undefined，调用方保留原始 id。
 */
function resolveWorkflowExecutorLabel(input: {
  readonly executor: { readonly kind: string; readonly id: string };
  readonly workspaceId: string;
  readonly agent?: AgentServiceLike | undefined;
  readonly employees?: EmployeeServiceLike | undefined;
  readonly teammates?: WorkflowTeammateServiceLike | undefined;
  readonly workspaces?: WorkflowWorkspaceRegistryLike | undefined;
}): string | undefined {
  if (input.executor.kind === "agent") {
    const workspaceIds = new Set<string>([input.workspaceId]);
    for (const workspace of input.workspaces?.list?.() ?? []) {
      workspaceIds.add(workspace.id);
    }
    for (const workspaceId of workspaceIds) {
      const profile = input.agent?.profile(workspaceId, input.executor.id);
      if (profile === undefined) continue;
      return profile.status === "active"
        ? profile.name
        : `${profile.name}（已停用）`;
    }
    return undefined;
  }
  if (input.executor.kind === "employee") {
    const teammate = input.teammates
      ?.list()
      .find(
        (item) =>
          item.id === input.executor.id ||
          (item.employeeId !== undefined &&
            item.employeeId === input.executor.id),
      );
    if (teammate !== undefined) return teammate.name;
    const target = input.employees?.workflowTarget(
      input.executor.id,
      input.workspaceId,
    );
    if (target !== undefined) return target.employee.displayName;
    return undefined;
  }
  return undefined;
}

export class WorkflowError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "missing_deliverables"
      | "method_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export function parseDefinitionFixture(
  sourceMd: string,
): ReturnType<typeof parseWorkflowMarkdown> {
  return parseWorkflowMarkdown(sourceMd);
}

function values<V>(table: KvTableLike<V>): V[] {
  return [...table.entries()].map(([, value]) => value);
}

const taskProjectedEventKinds = new Set([
  "node.completed",
  "node.cancelled",
  "approval.approved",
  "approval.rejected",
  "approval.delegated",
  "approval.countersigned",
  "approval.reassigned",
  "decision.resolved",
  "deliverable.submitted",
  "deliverable.rejected",
  "loop.break",
]);

function iso(now: Date): string {
  return now.toISOString();
}

function isManager(actor: WorkflowActor): boolean {
  return (
    actor.kind === "user" &&
    (actor.globalRole === "admin" || actor.workspaceRole === "owner")
  );
}

function taskWorkflowActor(actor: {
  id: string;
  name: string;
  kind: "human" | "agent" | "system";
  role?: "admin" | "owner" | "member" | "guest" | undefined;
}): WorkflowActor {
  return {
    kind: actor.kind === "agent" ? "agent" : "user",
    id: actor.id,
    name: actor.name,
    ...(actor.kind === "human"
      ? {
          globalRole: actor.role,
          workspaceRole: actor.role === "admin" ? undefined : actor.role,
        }
      : {}),
  };
}

type WorkflowTaskServiceCandidate = {
  get: WorkflowTaskBridge["get"];
  create: WorkflowTaskBridge["create"];
  projectAssigned: WorkflowTaskBridge["projectAssigned"];
  projectReceiverDisplay?: NonNullable<
    WorkflowTaskBridge["projectReceiverDisplay"]
  >;
  projectApprovalApprovers?: NonNullable<
    WorkflowTaskBridge["projectApprovalApprovers"]
  >;
  settleProjection: WorkflowTaskBridge["settle"];
  projectStatus: NonNullable<WorkflowTaskBridge["projectStatus"]>;
  projectWorkflowEvent: NonNullable<WorkflowTaskBridge["projectEvent"]>;
  projectAgentRun: NonNullable<WorkflowTaskBridge["projectAgentRun"]>;
  bindWorkflowActions: (handler: unknown) => void;
};

/** Adapt the task service's implementation names to the stable bridge contract. */
export function workflowTaskBridgeFrom(
  value: unknown,
): WorkflowTaskBridge | undefined {
  const candidate = value as Partial<WorkflowTaskServiceCandidate> | undefined;
  if (
    candidate === undefined ||
    typeof candidate.get !== "function" ||
    typeof candidate.create !== "function" ||
    typeof candidate.projectAssigned !== "function" ||
    typeof candidate.settleProjection !== "function" ||
    typeof candidate.projectStatus !== "function" ||
    typeof candidate.projectWorkflowEvent !== "function" ||
    typeof candidate.projectAgentRun !== "function"
  ) {
    return undefined;
  }
  return {
    get: (taskId) => candidate.get!(taskId),
    create: (actor, input) => candidate.create!(actor, input),
    projectAssigned: (actor, input) => candidate.projectAssigned!(actor, input),
    ...(typeof candidate.projectReceiverDisplay === "function"
      ? {
          projectReceiverDisplay: (actor, input) =>
            candidate.projectReceiverDisplay!(actor, input),
        }
      : {}),
    ...(typeof candidate.projectApprovalApprovers === "function"
      ? {
          projectApprovalApprovers: (actor, input) =>
            candidate.projectApprovalApprovers!(actor, input),
        }
      : {}),
    settle: (actor, taskId, outcome) =>
      candidate.settleProjection!(actor, taskId, outcome),
    projectStatus: (actor, taskId, status, message) =>
      candidate.projectStatus!(actor, taskId, status, message),
    projectEvent: (actor, taskId, event) =>
      candidate.projectWorkflowEvent!(actor, taskId, event),
    projectAgentRun: (actor, taskId, run, receiverName) =>
      candidate.projectAgentRun!(actor, taskId, run, receiverName),
  };
}

function isAgentRunActive(run: AgentRunView): boolean {
  return ["queued", "running", "waiting_input"].includes(run.status);
}

function actorMatchesApprover(
  actor: WorkflowActor,
  approver: Approver,
): boolean {
  return (
    actor.kind === (approver.kind === "user" ? "user" : "agent") &&
    actor.id === approver.id
  );
}

function graphContext(
  instance: WorkflowInstance,
): Record<string, string | number | boolean> {
  return { ...instance.context };
}

function safeEvaluate(
  expression: string,
  context: Record<string, string | number | boolean>,
): boolean {
  try {
    return evaluateExpression(expression, context);
  } catch {
    return false;
  }
}

export interface ValidationIssue {
  readonly level: "error" | "warning";
  readonly message: string;
}

function dedupeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.level}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateRuntimeGraph(
  graph: WorkflowGraph,
  activeDefinitions: readonly Pick<
    WorkflowDefinition,
    "key" | "version" | "status"
  >[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = graph.warnings.map((message) => ({
    level: "warning" as const,
    message,
  }));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push({
        level: "error",
        message: `edge references unknown node: ${edge.from} -> ${edge.to}`,
      });
    }
    for (const expression of [edge.condition, edge.breakCondition]) {
      if (expression === undefined) continue;
      try {
        evaluateExpression(
          expression,
          Object.fromEntries(
            graph.variables.map((variable) => [variable.name, variable.value]),
          ),
        );
      } catch (error) {
        issues.push({
          level: "error",
          message: `${expression}: ${error instanceof Error ? error.message : "invalid expression"}`,
        });
      }
    }
  }
  if (graph.startNodeIds.length === 0) {
    issues.push({ level: "error", message: "workflow has no start node" });
  }
  for (const node of graph.nodes) {
    if (node.type !== "subworkflow" || node.subworkflowKey === undefined)
      continue;
    const found = activeDefinitions.some(
      (definition) =>
        definition.key === node.subworkflowKey &&
        (node.subworkflowVersion === undefined ||
          definition.version === node.subworkflowVersion) &&
        definition.status === "active",
    );
    if (!found)
      issues.push({
        level: "error",
        message: `unknown active subworkflow: ${node.subworkflowKey}`,
      });
  }
  return issues;
}

export function validateWorkspaceActorReferences(
  graph: Pick<WorkflowGraph, "nodes">,
  members: readonly TeamMemberLike[],
): ValidationIssue[] {
  return validateActorReferences(
    graph,
    members.map((member) => member.userId),
    (nodeName, role, id) =>
      `节点「${nodeName}」的${role} ${id} 不是当前工作区成员`,
  );
}

export function validateGlobalActorReferences(
  graph: Pick<WorkflowGraph, "nodes">,
  users: readonly TeamUserLike[],
): ValidationIssue[] {
  return validateActorReferences(
    graph,
    users.map((user) => user.id),
    (nodeName, role, id) => `节点「${nodeName}」的${role} ${id} 不是平台账号`,
  );
}

function validateActorReferences(
  graph: Pick<WorkflowGraph, "nodes">,
  userIds: readonly string[],
  errorMessage: (nodeName: string, role: string, id: string) => string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const memberIds = new Set(userIds);
  const seen = new Set<string>();
  const check = (
    nodeId: string,
    nodeName: string,
    role: string,
    id: string,
  ) => {
    const key = `${nodeId}:${role}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!memberIds.has(id)) {
      issues.push({
        level: "error",
        message: errorMessage(nodeName, role, id),
      });
    }
  };
  for (const node of graph.nodes) {
    if (node.executor.kind === "user") {
      check(node.id, node.name, "执行人", node.executor.id);
    }
    if (node.responsible?.kind === "user") {
      check(node.id, node.name, "负责人", node.responsible.id);
    }
    if (node.type === "approval") {
      for (const approver of node.approvers) {
        if (approver.kind === "user") {
          check(node.id, node.name, "审批人", approver.id);
        }
      }
    }
  }
  return issues;
}

export function extractAgentDeliverableText(summary: string): string {
  const match = /^##\s*交付说明\s*$/m.exec(summary);
  if (match === null) return "";
  return summary.slice(match.index + match[0].length).trim();
}

export interface WorkflowServiceTables {
  definitions: KvTableLike<WorkflowDefinition>;
  instances: KvTableLike<WorkflowInstance>;
  events: KvTableLike<WorkflowEvent>;
  submissions: KvTableLike<WorkflowSubmission>;
}

export interface StartWorkflowInput {
  readonly workspaceId: string;
  readonly definitionId?: string | undefined;
  readonly title: string;
  readonly sessionId?: string | undefined;
  readonly relatedSessionIds?: readonly string[] | undefined;
  readonly context?: Record<string, string | number | boolean> | undefined;
  /**
   * 实例创建时，对「模板里指派给项目角色」的节点指定具体执行人 / teammate 实例。
   * 未列出的角色节点保持「指派给项目角色」，执行时按当刻角色成员展开。
   */
  readonly assignees?:
    | Record<
        string,
        {
          readonly kind: "user" | "agent";
          readonly id: string;
          readonly name?: string | undefined;
        }
      >
    | undefined;
}

export class WorkflowService {
  private queue: Promise<unknown> = Promise.resolve();
  private syncingWorkflowInitiatedTask = false;

  constructor(
    private readonly tables: WorkflowServiceTables,
    private readonly options: {
      readonly now?: () => Date;
      readonly artifactRoot?: string;
      readonly team?: () => TeamServiceLike | undefined;
      readonly agent?: () => AgentServiceLike | undefined;
      readonly employee?: () => EmployeeServiceLike | undefined;
      readonly tasks?: () => WorkflowTaskBridge | undefined;
      readonly workspaces?: () => WorkflowWorkspaceRegistryLike | undefined;
      /** 项目角色目录：解析 role:<id> 执行者与角色成员。 */
      readonly roles?: () => WorkflowRoleServiceLike | undefined;
      /** Principal 引用解析：principal:<id> 在解析模板前降为兼容主体。 */
      readonly principals?: () => WorkflowPrincipalServiceLike | undefined;
      readonly principalRuntime?: () =>
        | WorkflowPrincipalRuntimeLike
        | undefined;
      readonly context?: () => WorkflowContextServiceLike | undefined;
      /** AI Teammate 运行时：Agent 节点派发前按需开通运行身份。 */
      readonly teammateRuntime?: () => WorkflowTeammateRuntimeLike | undefined;
      /** AI Teammate 实例清单：执行者可读名解析。 */
      readonly teammates?: () => WorkflowTeammateServiceLike | undefined;
      /**
       * Best-effort domain hook: fired after every persisted workflow event so
       * sibling plugins (e.g. the workbench brief) can react to transitions.
       */
      readonly onEvent?: (event: WorkflowEvent) => void;
    } = {},
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Phase 3 canonical syntax is `principal:<id>`. The parser and runtime still
   * consume user/employee aliases, so normalize only the actor fields while
   * leaving the original source document untouched for display and audit.
   */
  private normalizePrincipalSource(sourceMd: string): string {
    const principals = this.options.principals?.();
    if (principals === undefined) return sourceMd;
    return sourceMd
      .split(/\r?\n/)
      .map((line) => {
        const match =
          /^(\s*[-*]\s*(executor|responsible|approver)\s*[:：]\s*)(principal:[^\s#]+)(.*)$/i.exec(
            line,
          );
        if (match === null) return line;
        const principal = principals.resolveReference(match[3]!);
        if (principal === undefined || principal.status === "archived") {
          return line;
        }
        const subjectId =
          principal.kind === "human"
            ? principals.preferredSubjectId(principal.id, ["auth-user"])
            : principals.preferredSubjectId(principal.id, ["employee"]);
        if (principal.kind === "human" && subjectId === undefined) return line;
        const teammateId =
          principal.kind === "ai"
            ? principals.preferredSubjectId(principal.id, ["teammate"])
            : undefined;
        const prefix =
          principal.kind === "human"
            ? match[2]!.toLowerCase() === "approver"
              ? "用户"
              : "user"
            : "employee";
        if (principal.kind === "ai" && subjectId === undefined) {
          if (teammateId === undefined) return line;
          return `${match[1]}agent:${teammateId}${match[4]}`;
        }
        return `${match[1]}${prefix}:${subjectId}${match[4]}`;
      })
      .join("\n");
  }

  validate(
    sourceMd: string,
    workspaceId?: string | undefined,
    options?: { checkVersionConflict?: boolean } | undefined,
  ): {
    graph?: WorkflowGraph;
    issues: ValidationIssue[];
  } {
    const parsed = parseWorkflowMarkdown(
      this.normalizePrincipalSource(sourceMd),
    );
    const issues: ValidationIssue[] = [
      ...parsed.errors.map((message) => ({ level: "error" as const, message })),
      ...parsed.warnings.map((message) => ({
        level: "warning" as const,
        message,
      })),
    ];
    if (parsed.graph === undefined) return { issues };
    issues.push(
      ...validateRuntimeGraph(parsed.graph, values(this.tables.definitions)),
    );
    if (options?.checkVersionConflict !== false) {
      issues.push(...this.versionConflictIssues(parsed.graph));
    }
    const team = this.options.team?.();
    if (team !== undefined) {
      issues.push(...validateGlobalActorReferences(parsed.graph, team.users()));
    }
    if (workspaceId !== undefined) {
      issues.push(...this.actorReferenceIssues(parsed.graph, workspaceId));
      issues.push(...this.agentReferenceIssues(parsed.graph, workspaceId));
      issues.push(...this.roleReferenceIssues(parsed.graph, workspaceId));
    }
    return { graph: parsed.graph, issues: dedupeIssues(issues) };
  }

  /**
   * 项目角色引用校验：role:<id> 执行者 / 角色审批人必须在该项目已物化的角色里。
   * 没有任何角色引用的模板不受影响；角色目录不可用时只校验能校验的部分。
   */
  private roleReferenceIssues(
    graph: WorkflowGraph,
    workspaceId: string,
  ): ValidationIssue[] {
    const usesRoles = graph.nodes.some(
      (node) =>
        node.executor.kind === "role" ||
        node.approvers.some((approver) => approver.kind === "role"),
    );
    if (!usesRoles) return [];
    const roles = this.options.roles?.();
    if (roles === undefined) return [];
    let seats: readonly WorkflowProjectRoleLike[];
    try {
      seats = roles.config(workspaceId).seats;
    } catch {
      return [
        {
          level: "error",
          message:
            "该项目的项目角色尚未维护，无法解析 role: 执行者 / 角色审批人；请先在该项目物化角色或改为指定具体执行人",
        },
      ];
    }
    const known = new Set(seats.map((seat) => seat.id));
    const issues: ValidationIssue[] = [];
    for (const node of graph.nodes) {
      if (node.executor.kind === "role" && !known.has(node.executor.id)) {
        issues.push({
          level: "error",
          message: `节点「${node.name}」引用的项目角色「${node.executor.label ?? node.executor.id}」不存在于该项目`,
        });
      }
      for (const approver of node.approvers) {
        if (approver.kind === "role" && !known.has(approver.id)) {
          issues.push({
            level: "error",
            message: `节点「${node.name}」引用的项目角色审批人「${approver.name}」不存在于该项目`,
          });
        }
      }
    }
    return issues;
  }

  private agentReferenceIssues(
    graph: WorkflowGraph,
    workspaceId: string,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const agent = this.options.agent?.();
    const employees = this.options.employee?.();
    for (const node of graph.nodes) {
      const label = `节点「${node.name}」`;
      if (node.executor.kind === "employee") {
        if (node.execution !== "task-worker") {
          issues.push({
            level: "error",
            message: `${label}的 AI伙伴执行者必须启用 task-worker`,
          });
        }
        if (employees === undefined) {
          issues.push({
            level: "warning",
            message: `${label}引用了 AI伙伴，但员工目录暂不可用，无法校验`,
          });
        } else if (node.execution === "task-worker") {
          const target = employees.workflowTarget(
            node.executor.id,
            workspaceId,
          );
          if (target === undefined) {
            // 引用的 AI Teammate 存在时（含已停用）：运行身份可以在首次手动
            // 派发时自动开通；实例已停用时派发会自动转交实例 owner 人工处理。
            // 两者都只给提示，不阻塞实例启动。
            const teammate = this.options
              .teammates?.()
              ?.list()
              .find(
                (item) =>
                  item.id === node.executor.id ||
                  (item.employeeId !== undefined &&
                    item.employeeId === node.executor.id),
              );
            issues.push(
              teammate === undefined
                ? {
                    level: "error",
                    message: `${label}的 AI伙伴「${node.executor.id}」必须启用，且具备显式工作区授权、启用 Runtime Profile 和 Agent Profile 映射`,
                  }
                : teammate.state !== "active"
                  ? {
                      level: "warning",
                      message: `${label}的 AI伙伴「${teammate.name}」当前不可用，派发时会自动转交 AI伙伴负责人人工处理`,
                    }
                  : {
                      level: "warning",
                      message: `${label}的 AI伙伴「${teammate.name}」尚未在该项目开通运行身份，手动派发时会自动开通`,
                    },
            );
          } else {
            const profileId = target.profile.legacyAgentProfileId!;
            this.checkAgentProfile(
              issues,
              label,
              agent,
              workspaceId,
              profileId,
            );
          }
        }
      } else if (node.executor.kind === "agent") {
        if (node.execution !== "task-worker") continue;
        this.checkAgentProfile(
          issues,
          label,
          agent,
          workspaceId,
          node.agentProfileId ?? node.executor.id,
        );
      }
      if (node.type !== "approval") continue;
      for (const approver of node.approvers) {
        if (approver.kind !== "employee") continue;
        if (employees === undefined) {
          issues.push({
            level: "warning",
            message: `${label}引用了 AI伙伴审批人，但员工目录暂不可用，无法校验`,
          });
          continue;
        }
        const target = employees.employeeApprovalTarget(
          approver.id,
          workspaceId,
        );
        if (target === undefined) {
          issues.push({
            level: "error",
            message: `${label}的 AI伙伴审批人「${approver.id}」必须启用并拥有显式 approve 授权`,
          });
        } else {
          issues.push({
            level: "warning",
            message: `${label}的 AI伙伴最终审批将保持等待，直到专用 runtime decision path 可用`,
          });
        }
      }
    }
    return issues;
  }

  private versionConflictIssues(graph: WorkflowGraph): ValidationIssue[] {
    const existingVersions = new Set(
      this.sharedDefinitions()
        .filter((definition) => definition.key === graph.key)
        .map((definition) => definition.version),
    );
    if (!existingVersions.has(graph.version)) return [];
    let nextVersion = 1;
    while (existingVersions.has(nextVersion)) nextVersion += 1;
    return [
      {
        level: "error",
        message: `模板版本已存在：${graph.key} v${graph.version}。请把元信息里的 version 改成未占用的 v${nextVersion}，或更换流程 key。`,
      },
    ];
  }

  private checkAgentProfile(
    issues: ValidationIssue[],
    label: string,
    agent: AgentServiceLike | undefined,
    workspaceId: string,
    profileId: string,
  ): void {
    if (agent === undefined) {
      issues.push({
        level: "warning",
        message: `${label}需要 Agent Profile「${profileId}」，但 Agent 注册表暂不可用，无法校验`,
      });
      return;
    }
    const profile = agent.profile(workspaceId, profileId);
    if (profile === undefined) {
      issues.push({
        level: "error",
        message: `${label}的 Agent Profile「${profileId}」不存在，请先在工作区创建`,
      });
    } else if (profile.status !== "active") {
      issues.push({
        level: "error",
        message: `${label}的 Agent Profile「${profile.name}」已停用`,
      });
    } else if (profile.runtimeKind !== "task-worker") {
      issues.push({
        level: "error",
        message: `${label}的 Agent Profile「${profile.name}」不是 task-worker 类型`,
      });
    }
  }

  private actorReferenceIssues(
    graph: WorkflowGraph,
    workspaceId: string,
  ): ValidationIssue[] {
    const team = this.options.team?.();
    if (team === undefined) return [];
    return validateWorkspaceActorReferences(graph, team.members(workspaceId));
  }

  definitions(workspaceId: string): WorkflowDefinition[] {
    return values(this.tables.definitions)
      .filter((definition) => definition.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.key.localeCompare(right.key) ||
          right.version - left.version,
      );
  }

  sharedDefinitions(): WorkflowDefinition[] {
    return values(this.tables.definitions).sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.key.localeCompare(right.key) ||
        right.version - left.version,
    );
  }

  definition(definitionId: string): WorkflowDefinition | undefined {
    return this.tables.definitions.get(definitionId);
  }

  importDefinition(
    actor: WorkflowActor,
    input: { workspaceId: string; sourceMd: string; activate?: boolean },
  ): Promise<WorkflowDefinition> {
    if (!isManager(actor)) {
      throw new WorkflowError(
        "forbidden",
        "workspace owner or admin is required",
      );
    }
    return this.enqueue(async () => {
      const timestamp = iso(this.now());
      const check = this.validate(input.sourceMd, undefined, {
        checkVersionConflict: false,
      });
      const errors = check.issues.filter((issue) => issue.level === "error");
      if (check.graph === undefined || errors.length > 0) {
        throw new WorkflowError(
          "invalid_input",
          errors.map((issue) => issue.message).join("; ") ||
            "workflow is invalid",
        );
      }
      const graph = workflowGraphSchema.parse(check.graph);
      const existing = this.sharedDefinitions().filter(
        (definition) => definition.key === graph.key,
      );
      if (existing.some((definition) => definition.version === graph.version)) {
        throw new WorkflowError(
          "conflict",
          `definition version already exists: ${graph.key} v${graph.version}`,
        );
      }
      const activate = input.activate ?? true;
      if (activate) {
        for (const definition of existing.filter(
          (item) => item.status === "active",
        )) {
          await this.tables.definitions.put(definition.id, {
            ...definition,
            status: "archived",
            updatedAt: timestamp,
          });
        }
      }
      const record: WorkflowDefinition = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        key: graph.key,
        version: graph.version,
        name: graph.name,
        description: graph.description,
        sourceMd: input.sourceMd,
        graph,
        status: activate ? "active" : "archived",
        createdBy: actor.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.tables.definitions.put(record.id, record);
      return record;
    });
  }

  instances(
    workspaceId: string,
    filter: { sessionId?: string } = {},
  ): WorkflowInstance[] {
    return values(this.tables.instances)
      .filter((instance) => instance.workspaceId === workspaceId)
      .filter(
        (instance) =>
          filter.sessionId === undefined ||
          instance.sessionId === filter.sessionId ||
          instance.relatedSessionIds.includes(filter.sessionId),
      )
      .map((instance) => this.refreshStatus(instance))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  instance(instanceId: string): WorkflowInstance | undefined {
    return this.tables.instances.get(instanceId);
  }

  instanceView(instanceId: string): WorkflowInstance | undefined {
    const instance = this.instance(instanceId);
    return instance === undefined
      ? undefined
      : this.syncDeliverableStates(this.refreshStatus(instance));
  }

  /** Backfills task projections that predate approver visibility. */
  async reconcileTaskProjections(
    instanceId: string,
  ): Promise<WorkflowInstance | undefined> {
    const instance = this.instance(instanceId);
    if (instance === undefined) return undefined;
    return this.enqueue(async () => {
      const backfilled = await this.syncApprovalTaskApprovers(instance);
      return this.syncNodeTasks(backfilled);
    });
  }

  private async syncApprovalTaskApprovers(
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    const bridge = this.taskBridge();
    const definition = this.tables.definitions.get(instance.definitionId);
    if (bridge === undefined || definition === undefined) return instance;

    for (const node of definition.graph.nodes) {
      if (node.type !== "approval") continue;
      const state = instance.nodes[node.id];
      if (state === undefined) continue;
      const approverIds = [...new Set(node.approvers.map((item) => item.id))];
      for (const taskId of state.taskIds) {
        const task = bridge.get(taskId);
        if (task === undefined) continue;
        const currentApproverIds = task.workflow?.approverIds ?? [];
        const changed =
          currentApproverIds.length !== approverIds.length ||
          currentApproverIds.some((id, index) => id !== approverIds[index]);
        if (!changed) continue;
        try {
          await bridge.projectApprovalApprovers?.(this.taskSystemActor(), {
            taskId,
            approverIds,
          });
        } catch {
          // 详情页同步失败不阻塞工作流读取；下一次打开详情会重试。
        }
      }
    }
    return instance;
  }

  events(instanceId: string): WorkflowEvent[] {
    return values(this.tables.events)
      .filter((event) => event.instanceId === instanceId)
      .sort(
        (left, right) =>
          left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
      );
  }

  submissions(
    instanceId: string,
    filter: { nodeId?: string } = {},
  ): WorkflowSubmission[] {
    return values(this.tables.submissions)
      .filter(
        (submission) =>
          submission.instanceId === instanceId &&
          (filter.nodeId === undefined || submission.nodeId === filter.nodeId),
      )
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  }

  submission(submissionId: string): WorkflowSubmission | undefined {
    return this.tables.submissions.get(submissionId);
  }

  private async appendEvent(
    instance: Pick<WorkflowInstance, "id" | "workspaceId">,
    event: {
      nodeId?: string;
      kind: string;
      actor: WorkflowActor | { kind: "system"; id: string; name: string };
      message: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    const actor =
      "kind" in event.actor && event.actor.kind !== "system"
        ? event.actor
        : { kind: "system" as const, id: "workflow", name: "系统" };
    const principals = this.options.principals?.();
    const actorPrincipalId =
      actor.kind === "user"
        ? principals?.resolveSubject("auth-user", actor.id)?.id
        : actor.kind === "agent"
          ? (principals?.resolveSubject("teammate", actor.id)?.id ??
            principals?.resolveSubject("employee", actor.id)?.id)
          : undefined;
    const record: WorkflowEvent = {
      id: randomUUID(),
      workspaceId: instance.workspaceId,
      instanceId: instance.id,
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      kind: event.kind,
      actorId: actor.id,
      ...(actorPrincipalId === undefined ? {} : { actorPrincipalId }),
      actorKind: actor.kind,
      actorName:
        "name" in actor && actor.name !== undefined ? actor.name : actor.id,
      message: event.message,
      data: event.data ?? {},
      at: iso(this.now()),
    };
    await this.tables.events.put(record.id, workflowEventSchema.parse(record));
    try {
      this.options.onEvent?.(record);
    } catch {
      // A failing listener must never break a workflow transition.
    }
    if (taskProjectedEventKinds.has(record.kind)) {
      await this.syncTaskEvent(instance, record);
    }
  }

  private initialState(
    node: WorkflowNode,
    timestamp: string,
  ): WorkflowNodeState {
    const approvals: WorkflowNodeState["approvals"] = {};
    if (node.type === "approval") {
      for (const approver of node.approvers) {
        approvals[`${node.id}:${approver.id}`] = {
          approver,
          status: "pending",
        };
      }
    }
    return nodeStateSchema.parse({
      nodeId: node.id,
      status: "waiting",
      attempts: 1,
      approvals,
      taskIds: [],
      ...(node.type === "approval" || node.type === "task"
        ? { assignedTo: node.executor.label ?? node.executor.id }
        : {}),
      ...(timestamp === "" ? {} : {}),
      deliverables: Object.fromEntries(
        node.deliverables.map((requirement) => [
          requirement.key,
          {
            requirementKey: requirement.key,
            status: "pending",
          },
        ]),
      ),
    });
  }

  private taskBridge(): WorkflowTaskBridge | undefined {
    return this.options.tasks?.();
  }

  private workspacePath(workspaceId: string): string | undefined {
    const workspaces = this.options.workspaces?.();
    return workspaces?.get(workspaceId)?.path;
  }

  private async syncTaskStatus(
    taskId: string | undefined,
    status: "todo" | "progress" | "review",
    message: string,
  ): Promise<void> {
    if (taskId === undefined) return;
    const bridge = this.taskBridge();
    if (bridge?.projectStatus === undefined) return;
    try {
      await bridge.projectStatus(
        this.taskSystemActor(),
        taskId,
        status,
        message,
      );
    } catch {
      // Workflow state remains authoritative; a projection gap is visible in task events.
    }
  }

  private taskIdsForEvent(
    instance: Pick<WorkflowInstance, "nodes">,
    event: Pick<WorkflowEvent, "nodeId" | "data">,
  ): string[] {
    const allTaskIds = Object.values(instance.nodes).flatMap(
      (state) => state.taskIds,
    );
    const explicitTaskId = event.data.taskId;
    if (typeof explicitTaskId === "string") {
      return allTaskIds.includes(explicitTaskId) ? [explicitTaskId] : [];
    }
    if (event.nodeId !== undefined) {
      return instance.nodes[event.nodeId]?.taskIds ?? [];
    }
    return [...new Set(allTaskIds)];
  }

  private async syncTaskEvent(
    instance: Pick<WorkflowInstance, "id">,
    event: WorkflowEvent,
  ): Promise<void> {
    const bridge = this.taskBridge();
    if (bridge?.projectEvent === undefined) return;
    const current = this.instance(instance.id);
    if (current === undefined) return;
    const eventInput = {
      id: event.id,
      instanceId: event.instanceId,
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      actorId: event.actorId,
      actorKind: event.actorKind,
      actorName: event.actorName,
      message: event.message,
      at: event.at,
    };
    for (const taskId of this.taskIdsForEvent(current, event)) {
      try {
        await bridge.projectEvent(this.taskSystemActor(), taskId, eventInput);
      } catch {
        // The workflow action remains authoritative; task projection is best effort.
      }
    }
  }

  private async syncAgentRun(
    instance: WorkflowInstance,
    nodeId: string,
    run: AgentRunView,
  ): Promise<void> {
    const bridge = this.taskBridge();
    if (bridge?.projectAgentRun === undefined) return;
    const receiverName =
      instance.nodes[nodeId]?.assignedTo ?? run.payload.profileName ?? "Agent";
    for (const taskId of instance.nodes[nodeId]?.taskIds ?? []) {
      try {
        await bridge.projectAgentRun(
          this.taskSystemActor(),
          taskId,
          {
            id: run.id,
            nodeId: run.nodeId,
            status: run.status,
            output: run.output,
            error: run.error,
            ...(run.execution === undefined
              ? {}
              : { execution: run.execution }),
          },
          receiverName,
        );
      } catch {
        // Agent execution and workflow advancement must not depend on projection.
      }
    }
  }

  private taskSystemActor() {
    return { id: "workflow", name: "工作流", kind: "system" as const };
  }

  private isTaskSettled(task: Pick<WorkflowTaskRef, "status">): boolean {
    return task.status === "done" || task.status === "cancelled";
  }

  /** 定义里引用到的项目角色 id（执行人 + 角色审批人）。 */
  private referencedRoleIds(graph: WorkflowGraph): string[] {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (node.executor.kind === "role") ids.add(node.executor.id);
      for (const approver of node.approvers) {
        if (approver.kind === "role") ids.add(approver.id);
      }
    }
    return [...ids];
  }

  /** 按定义中引用的角色生成实例快照（角色定义 + 启动时成员）。 */
  private roleSnapshotFor(
    graph: WorkflowGraph,
    workspaceId: string,
  ): WorkflowInstance["roleSnapshot"] {
    return Object.fromEntries(
      this.referencedRoleIds(graph).map((roleId) => {
        const seat = this.projectRole(workspaceId, roleId);
        const members = this.projectRoleMembers(workspaceId, roleId);
        return [
          roleId,
          {
            roleId,
            name: seat?.label ?? roleId,
            permissions: [...(seat?.permissions ?? [])],
            members: members.map((member) => ({
              kind: member.kind,
              id: member.id,
            })),
          },
        ];
      }),
    );
  }

  /**
   * 项目角色定义：
   * - 已启动实例优先使用启动时的快照（角色编辑/删除不影响旧实例）；
   * - 旧实例没有快照时退回实时目录。
   */
  private projectRole(
    workspaceId: string,
    roleId: string,
    instance?: WorkflowInstance,
  ): WorkflowProjectRoleLike | undefined {
    const snapshot = instance?.roleSnapshot?.[roleId];
    if (snapshot !== undefined) {
      return {
        id: roleId,
        label: snapshot.name,
        participantKind: "any",
        permissions: snapshot.permissions,
      };
    }
    try {
      return this.options
        .roles?.()
        ?.config(workspaceId)
        .seats.find((seat) => seat.id === roleId);
    } catch {
      return undefined;
    }
  }

  /**
   * 角色成员：
   * - 实例有快照时使用快照成员（启动时的人员集合）；
   * - 没有快照的旧实例退回实时成员。
   */
  private projectRoleMembers(
    workspaceId: string,
    roleId: string,
    instance?: WorkflowInstance,
  ): readonly { readonly kind: "user" | "agent"; readonly id: string }[] {
    const snapshot = instance?.roleSnapshot?.[roleId];
    if (snapshot !== undefined) {
      return snapshot.members.map((member) => ({
        kind: member.kind,
        id: member.id,
      }));
    }
    const members = (() => {
      try {
        return this.options.roles?.()?.members?.(workspaceId, roleId) ?? [];
      } catch {
        return [];
      }
    })();
    return members
      .filter((member) => member.status !== "released")
      .map((member) => ({ kind: member.assigneeKind, id: member.assigneeId }));
  }

  /**
   * 操作者是不是该项目这个角色的成员。
   * 人类仍须是当前项目成员；角色成员关系按实例快照解析。
   */
  private actorHoldsProjectRole(
    actor: WorkflowActor,
    instance: WorkflowInstance,
    roleId: string,
  ): boolean {
    if (actor.kind !== "user") return false;
    const team = this.options.team?.();
    if (
      team !== undefined &&
      !team
        .members(instance.workspaceId)
        .some((member) => member.userId === actor.id)
    ) {
      return false;
    }
    return this.projectRoleMembers(instance.workspaceId, roleId, instance).some(
      (member) => member.kind === "user" && member.id === actor.id,
    );
  }

  /**
   * 审批人匹配：真人 / Agent / Teammate 按身份匹配；项目角色按实例快照成员匹配。
   * 角色审批是或签：角色上的任意成员给出结论都算数。
   */
  private matchesApprover(
    actor: WorkflowActor,
    approver: Approver,
    instance: WorkflowInstance,
  ): boolean {
    return approver.kind === "role"
      ? this.actorHoldsProjectRole(actor, instance, approver.id)
      : actorMatchesApprover(actor, approver);
  }

  private taskReceiver(
    node: WorkflowNode,
    state: WorkflowNodeState,
    instance: WorkflowInstance,
  ) {
    if (node.type === "approval") {
      const pending = Object.values(state.approvals).find(
        (item) => item.status === "pending",
      )?.approver;
      const approver = pending ?? node.approvers[0];
      if (approver === undefined) return undefined;
      return {
        type:
          approver.kind === "user"
            ? "human"
            : approver.kind === "role"
              ? "role"
              : "agent",
        id: approver.id,
        name:
          approver.kind === "role"
            ? (this.projectRole(instance.workspaceId, approver.id, instance)
                ?.label ?? approver.name)
            : approver.name,
      } as const;
    }
    // 人工改派优先：任务侧把节点任务指派给了谁，节点就投影给谁，
    // 否则下一次刷新的默认执行人/失效兜底会把改派静默覆盖回去。
    const override = state.receiverOverride;
    if (override !== undefined) {
      return {
        type: override.type,
        id: override.id,
        name: override.name ?? override.id,
      } as const;
    }
    // 执行实例失效兜底：节点已改派给实例 owner（真人），任务归属随之切换。
    const fallback = state.executorFallback;
    if (fallback !== undefined) {
      return {
        type: "human",
        id: fallback.id,
        name: fallback.label ?? fallback.id,
      } as const;
    }
    const executor = node.executor;
    if (executor.kind === "user") {
      const responsible =
        node.responsible?.kind === "user" ? node.responsible : undefined;
      return {
        type: "human",
        id: executor.id,
        name: executor.label ?? responsible?.label ?? executor.id,
      } as const;
    }
    if (executor.kind === "role") {
      // 项目角色执行人：任务是角色级的，成员是「可选执行人」，任意一人完成即完成。
      const role = this.projectRole(
        instance.workspaceId,
        executor.id,
        instance,
      );
      return {
        type: "role",
        id: executor.id,
        name: role?.label ?? executor.label ?? executor.id,
      } as const;
    }
    if (["agent", "employee"].includes(executor.kind)) {
      const profileName =
        executor.kind === "agent"
          ? this.options.agent?.()?.profile(instance.workspaceId, executor.id)
              ?.name
          : (this.options
              .teammates?.()
              ?.list()
              .find(
                (item) =>
                  item.id === executor.id ||
                  (item.employeeId !== undefined &&
                    item.employeeId === executor.id),
              )?.name ??
            this.options
              .employee?.()
              ?.workflowTarget(executor.id, instance.workspaceId)?.employee
              .displayName);
      return {
        type: "agent",
        id: executor.id,
        name: profileName ?? executor.label ?? executor.id,
      } as const;
    }
    return undefined;
  }

  private isSerialCountersign(state: WorkflowNodeState): boolean {
    return Object.values(state.approvals).some(
      (item) => item.source === "countersign",
    );
  }

  private serialQueueKey(state: WorkflowNodeState): string | undefined {
    if (!this.isSerialCountersign(state)) return undefined;
    return Object.keys(state.approvals).find(
      (key) => state.approvals[key]!.status === "pending",
    );
  }

  private async ensureNodeTask(
    instance: WorkflowInstance,
    node: WorkflowNode,
  ): Promise<WorkflowInstance> {
    const bridge = this.taskBridge();
    const state = instance.nodes[node.id];
    if (
      bridge === undefined ||
      state === undefined ||
      (!["ready", "running"].includes(state.status) &&
        !(
          node.type === "approval" &&
          state.status === "waiting" &&
          state.enteredAt !== undefined &&
          this.serialQueueKey(state) !== undefined
        ))
    ) {
      return instance;
    }
    const receiver = this.taskReceiver(node, state, instance);
    if (receiver === undefined) return instance;
    const activeTaskIds: string[] = [];
    const reviewRequired =
      node.type === "approval" ? false : node.reviewRequired;
    for (const taskId of state.taskIds) {
      try {
        const task = bridge.get(taskId);
        if (task === undefined) continue;
        if (
          task.nodeAttempt !== undefined &&
          task.nodeAttempt !== state.attempts
        ) {
          await bridge.settle(this.taskSystemActor(), task.id, "superseded");
          continue;
        }
        activeTaskIds.push(task.id);
      } catch {
        continue;
      }
    }
    let current = instance;
    let taskId = activeTaskIds[0];
    if (taskId === undefined) {
      const autoApproveReview =
        node.type !== "approval" && receiver.type === "human";
      const policyLabel =
        node.type === "approval"
          ? node.approvalPolicy === "any"
            ? "或签：任一审批人通过即可"
            : "并签：全部审批人通过后才完成"
          : node.reviewRequired
            ? autoApproveReview
              ? "提交后自动通过 Review，完成节点"
              : "完成后需要人工 Review"
            : "完成后无需人工 Review，直接完成";
      const approverNames =
        node.type === "approval"
          ? node.approvers.map((item) => item.name).join("、")
          : "";
      try {
        const created = await bridge.create(this.taskSystemActor(), {
          workspaceId: instance.workspaceId,
          title: `${instance.title} · ${node.name}`,
          type: "工作流",
          priority: "P2",
          status: node.type === "approval" ? "review" : "progress",
          receiverType: receiver.type,
          receiverId: receiver.id,
          receiverName: receiver.name,
          description: [
            node.description.trim(),
            node.type === "approval"
              ? `审批人：${approverNames}\n审批规则：${policyLabel}`
              : policyLabel,
            `工作流：${instance.title}（${instance.id}）`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          acceptance:
            node.type === "approval"
              ? ["给出明确通过或退回结论", "必要时填写审批意见"]
              : node.deliverables.length > 0
                ? node.deliverables.map((item) => item.title)
                : ["完成节点要求的交付内容"],
          links: [
            {
              type: "workflow",
              id: instance.id,
              label: `${instance.title} · ${node.name}`,
            },
          ],
          autoSubmitReview: node.type === "approval" ? false : true,
          autoApproveReview,
          workflow: {
            instanceId: instance.id,
            nodeId: node.id,
            instanceTitle: instance.title,
            nodeName: node.name,
            nodeAttempt: state.attempts,
            reviewRequired,
            ...(node.type === "approval"
              ? {
                  approvalPolicy: node.approvalPolicy,
                  approverIds: [
                    ...new Set(node.approvers.map((item) => item.id)),
                  ],
                }
              : {}),
          },
        });
        taskId = created.id;
        current = {
          ...current,
          nodes: {
            ...current.nodes,
            [node.id]: {
              ...current.nodes[node.id]!,
              taskIds: [...activeTaskIds, created.id],
              assignedTo: receiver.name,
            },
          },
        };
      } catch (error) {
        const message = `Task 创建失败：${error instanceof Error ? error.message : "unknown error"}`;
        await this.appendEvent(current, {
          nodeId: node.id,
          kind: "task.create_failed",
          actor: this.taskSystemActor(),
          message,
        });
        return current;
      }
    } else {
      const task = bridge.get(taskId);
      if (node.type === "approval" && task !== undefined) {
        const approverIds = [...new Set(node.approvers.map((item) => item.id))];
        const currentApproverIds = task.workflow?.approverIds ?? [];
        const approversChanged =
          currentApproverIds.length !== approverIds.length ||
          currentApproverIds.some((id, index) => id !== approverIds[index]);
        if (approversChanged) {
          try {
            await bridge.projectApprovalApprovers?.(this.taskSystemActor(), {
              taskId: task.id,
              approverIds,
            });
          } catch {
            // 保留工作流原状态；审批人下次同步会重试回填。
          }
        }
      }
      const changed =
        task !== undefined &&
        !this.isTaskSettled(task) &&
        (task.receiverType !== receiver.type ||
          task.receiverId !== receiver.id ||
          task.receiverName !== receiver.name);
      if (task !== undefined && changed) {
        try {
          const assigned = await bridge.projectAssigned(
            this.taskSystemActor(),
            {
              taskId: task.id,
              receiverType: receiver.type,
              receiverId: receiver.id,
              receiverName: receiver.name,
            },
          );
          current = {
            ...current,
            nodes: {
              ...current.nodes,
              [node.id]: {
                ...current.nodes[node.id]!,
                assignedTo: assigned.receiverName ?? assigned.receiverId,
              },
            },
          };
        } catch {
          // 保留工作流原状态；Task 服务已有活动记录，用户可在 Task 侧看到失败原因。
        }
      }
    }
    return this.putInstance(current);
  }

  private async syncNodeTasks(
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    if (this.taskBridge() === undefined) return instance;
    const definition = this.tables.definitions.get(instance.definitionId);
    if (definition === undefined) return instance;
    let current = instance;
    for (const node of definition.graph.nodes) {
      if (node.type !== "approval" && node.type !== "task") continue;
      if (node.type === "task" && node.executor.kind === "system") continue;
      current = await this.ensureNodeTask(current, node);
    }
    return current;
  }

  async handleTaskAssigned(
    task: {
      readonly id: string;
      readonly workspaceId: string;
      readonly receiverType: "unassigned" | "human" | "agent" | "role";
      readonly receiverId?: string | undefined;
      readonly receiverName?: string | undefined;
      readonly workflow?:
        | { readonly instanceId: string; readonly nodeId: string }
        | undefined;
    },
    actor: WorkflowActor,
  ): Promise<void> {
    if (task.workflow === undefined) return;
    if (this.syncingWorkflowInitiatedTask) return;
    this.syncingWorkflowInitiatedTask = true;
    try {
      await this.enqueue(async () => {
        const instance = this.instance(task.workflow!.instanceId);
        if (instance === undefined) return;
        const state = instance.nodes[task.workflow!.nodeId];
        if (state === undefined || !state.taskIds.includes(task.id)) return;
        const definition = this.tables.definitions.get(instance.definitionId);
        const node = definition?.graph.nodes.find(
          (item) => item.id === task.workflow!.nodeId,
        );
        if (node === undefined) return;
        if (node.type === "approval") {
          if (
            task.receiverType === "unassigned" ||
            task.receiverId === undefined
          ) {
            throw new WorkflowError("conflict", "审批 Task 必须保留审批人");
          }
          const key = Object.keys(state.approvals).find((candidate) => {
            const approval = state.approvals[candidate]!;
            return (
              approval.status === "pending" &&
              state.taskIds.includes(task.id) &&
              (actor.kind !== "user" ||
                this.matchesApprover(actor, approval.approver, instance) ||
                isManager(actor))
            );
          });
          const fallbackKey = Object.keys(state.approvals).find(
            (candidate) => state.approvals[candidate]!.status === "pending",
          );
          const selectedKey = key ?? fallbackKey;
          if (selectedKey === undefined) {
            throw new WorkflowError("conflict", "审批已经完成，不能改派");
          }
          const original = state.approvals[selectedKey]!.approver;
          const kind =
            task.receiverType === "human"
              ? "user"
              : task.receiverType === "role"
                ? "role"
                : original.kind === "employee"
                  ? "employee"
                  : "agent";
          const updated = await this.putInstance({
            ...instance,
            nodes: {
              ...instance.nodes,
              [node.id]: {
                ...state,
                approvals: {
                  ...state.approvals,
                  [selectedKey]: {
                    ...state.approvals[selectedKey]!,
                    approver: {
                      kind,
                      id: task.receiverId,
                      name: task.receiverName ?? task.receiverId,
                    },
                  },
                },
              },
            },
          });
          await this.appendEvent(updated, {
            nodeId: node.id,
            kind: "approval.reassigned",
            actor,
            message: `改派审批 Task：${task.receiverName ?? task.receiverId}`,
            data: { taskId: task.id },
          });
          return;
        }
        const receiverOverride =
          task.receiverType === "unassigned" || task.receiverId === undefined
            ? undefined
            : {
                type: task.receiverType,
                id: task.receiverId,
                ...(task.receiverName === undefined
                  ? {}
                  : { name: task.receiverName }),
                at: iso(this.now()),
              };
        // 改派回节点原本的 Agent / Teammate 时，先前的「执行实例失效，已转交
        // owner 人工处理」已经不成立：解除兜底，让节点重新可以派发。
        const requestsAgentExecution =
          receiverOverride !== undefined &&
          receiverOverride.type === "agent" &&
          ["ready", "blocked"].includes(state.status) &&
          this.receiverOverrideMatchesExecutor(node, receiverOverride.id);
        const releasesFallback =
          state.executorFallback !== undefined && requestsAgentExecution;
        await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: {
              ...state,
              assignedTo: task.receiverName ?? task.receiverId,
              receiverOverride,
              ...(releasesFallback
                ? {
                    executorFallback: undefined,
                    status: "ready" as const,
                    note: undefined,
                  }
                : state.status === "blocked" && requestsAgentExecution
                  ? {
                      status: "ready" as const,
                      note: undefined,
                    }
                  : {}),
            },
          },
        });
      });
    } finally {
      this.syncingWorkflowInitiatedTask = false;
    }
  }

  /**
   * 任务改派落库后再启动工作流自己的 Agent run。任务先保存，调度器才能
   * 从最新责任人生成正确的节点标题，也不会再落到一条普通任务会话。
   */
  async handleTaskAssignedAfterPersist(
    task: {
      readonly id: string;
      readonly workflow?:
        | { readonly instanceId: string; readonly nodeId: string }
        | undefined;
    },
    actor: WorkflowActor,
  ): Promise<void> {
    if (task.workflow === undefined) return;
    await this.enqueue(async () => {
      const instance = this.instance(task.workflow!.instanceId);
      if (instance === undefined) return;
      const state = instance.nodes[task.workflow!.nodeId];
      if (state === undefined || !state.taskIds.includes(task.id)) return;
      if (
        state.receiverOverride?.type !== "agent" ||
        state.executorFallback !== undefined ||
        state.status !== "ready"
      ) {
        return;
      }
      const definition = this.tables.definitions.get(instance.definitionId);
      const node = definition?.graph.nodes.find(
        (item) => item.id === task.workflow!.nodeId,
      );
      if (
        node === undefined ||
        node.type !== "task" ||
        node.trigger !== "auto-on-ready" ||
        !this.receiverOverrideMatchesExecutor(node, state.receiverOverride.id)
      ) {
        return;
      }
      await this.autoDispatchAgentNodes(actor, instance);
    });
  }

  /** 改派目标是否就是节点模版里的 Agent / Teammate 执行人（实例 id 与员工身份 id 双向匹配）。 */
  private receiverOverrideMatchesExecutor(
    node: WorkflowNode,
    receiverId: string,
  ): boolean {
    if (node.executor.id === receiverId) return true;
    const teammate = this.options
      .teammates?.()
      ?.list()
      .find(
        (item) =>
          item.id === node.executor.id ||
          (item.employeeId !== undefined &&
            item.employeeId === node.executor.id),
      );
    if (teammate === undefined) return false;
    return teammate.id === receiverId || teammate.employeeId === receiverId;
  }

  async handleTaskDecision(
    task: {
      readonly id: string;
      readonly workflow?:
        | { readonly instanceId: string; readonly nodeId: string }
        | undefined;
    },
    actor: WorkflowActor,
    decision: "approved" | "rejected",
  ): Promise<void> {
    if (task.workflow === undefined) return;
    const instance = this.instance(task.workflow.instanceId);
    const state = instance?.nodes[task.workflow.nodeId];
    if (instance === undefined || state === undefined) return;
    if (!state.taskIds.includes(task.id)) return;
    if (["completed", "skipped"].includes(state.status)) return;
    const definition = this.tables.definitions.get(instance.definitionId);
    const node = definition?.graph.nodes.find(
      (item) => item.id === task.workflow!.nodeId,
    );
    if (node?.type === "approval") {
      await this.decideApproval(actor, {
        instanceId: instance.id,
        nodeId: node.id,
        decision,
      });
      return;
    }
    if (decision === "approved") {
      if (node === undefined) return;
      await this.completeNode(actor, {
        instanceId: instance.id,
        nodeId: node.id,
      });
    }
  }

  async handleTaskSubmitted(
    task: {
      readonly id: string;
      readonly workflow?:
        | { readonly instanceId: string; readonly nodeId: string }
        | undefined;
    },
    actor: WorkflowActor,
  ): Promise<void> {
    if (task.workflow === undefined) return;
    await this.handleTaskDecision(task, actor, "approved");
  }

  private projectionOutcome(
    instance: WorkflowInstance,
    state: WorkflowNodeState,
    task: Pick<WorkflowTaskRef, "id" | "nodeAttempt">,
  ): "approved" | "rejected" | "cancelled" | "superseded" | undefined {
    if (task.nodeAttempt !== undefined && task.nodeAttempt !== state.attempts) {
      return "superseded";
    }
    if (!["completed", "skipped"].includes(state.status)) return undefined;
    if (
      state.status === "skipped" &&
      this.events(instance.id).some(
        (event) =>
          event.kind === "node.cancelled" && event.nodeId === state.nodeId,
      )
    ) {
      return "cancelled";
    }
    if (instance.status === "cancelled") return "cancelled";
    if (instance.status === "failed") return "rejected";
    return "approved";
  }

  async handleTaskReconcile(task: {
    readonly id: string;
    readonly workflow?:
      | { readonly instanceId: string; readonly nodeId: string }
      | undefined;
  }): Promise<
    "approved" | "rejected" | "cancelled" | "superseded" | undefined
  > {
    if (task.workflow === undefined) return;
    const instance = this.instance(task.workflow.instanceId);
    const state = instance?.nodes[task.workflow.nodeId];
    if (instance === undefined || state === undefined) return;
    if (!state.taskIds.includes(task.id)) return;
    const bridge = this.taskBridge();
    const projected = bridge?.get(task.id);
    if (bridge === undefined || projected === undefined) return;
    const definition = this.tables.definitions.get(instance.definitionId);
    const node = definition?.graph.nodes.find(
      (item) => item.id === task.workflow!.nodeId,
    );
    if (node !== undefined) {
      const receiver = this.taskReceiver(node, state, instance);
      if (
        receiver !== undefined &&
        (projected.receiverType !== receiver.type ||
          projected.receiverId !== receiver.id ||
          projected.receiverName !== receiver.name)
      ) {
        try {
          await bridge.projectAssigned(this.taskSystemActor(), {
            taskId: task.id,
            receiverType: receiver.type,
            receiverId: receiver.id,
            receiverName: receiver.name,
          });
        } catch {
          // Keep the next task refresh safe to retry.
        }
      }
    }
    const projectedAfterAssign = bridge.get(task.id);
    if (projectedAfterAssign === undefined) return;
    const outcome = this.projectionOutcome(
      instance,
      state,
      projectedAfterAssign,
    );
    if (this.isTaskSettled(projectedAfterAssign)) {
      if (
        projectedAfterAssign.status === "done" &&
        projectedAfterAssign.workflow?.outcome === "approved" &&
        outcome === "cancelled"
      ) {
        try {
          await bridge.settle(this.taskSystemActor(), task.id, "cancelled");
          return "cancelled";
        } catch {
          // Keep the next refresh safe; task state remains authoritative if it rejects.
        }
      }
      return;
    }
    if (outcome === undefined) {
      const targetStatus = this.projectedTaskStatus(node, state);
      if (projectedAfterAssign.status !== targetStatus) {
        await this.syncTaskStatus(
          task.id,
          targetStatus,
          targetStatus === "review"
            ? "工作流节点等待确认"
            : targetStatus === "progress"
              ? "工作流节点同步为进行中"
              : "工作流节点受阻，等待处理",
        );
      }
    }
    if (outcome === undefined) return;
    try {
      await bridge.settle(this.taskSystemActor(), task.id, outcome);
    } catch {
      // Keep the next task-list refresh safe to retry.
    }
    return outcome;
  }

  async refreshTaskReceiverDisplay(task: {
    readonly id: string;
    readonly workflow?:
      | { readonly instanceId: string; readonly nodeId: string }
      | undefined;
  }): Promise<void> {
    if (task.workflow === undefined) return;
    const instance = this.instance(task.workflow.instanceId);
    const state = instance?.nodes[task.workflow.nodeId];
    if (instance === undefined || state === undefined) return;
    if (!state.taskIds.includes(task.id)) return;
    const bridge = this.taskBridge();
    const projected = bridge?.get(task.id);
    if (bridge === undefined || projected === undefined) return;
    if (
      bridge.projectReceiverDisplay === undefined ||
      !this.isTaskSettled(projected)
    ) {
      return;
    }
    const definition = this.tables.definitions.get(instance.definitionId);
    const node = definition?.graph.nodes.find(
      (item) => item.id === task.workflow!.nodeId,
    );
    const receiver =
      node === undefined ? undefined : this.taskReceiver(node, state, instance);
    if (
      receiver === undefined ||
      (projected.receiverType === receiver.type &&
        projected.receiverId === receiver.id &&
        projected.receiverName === receiver.name)
    ) {
      return;
    }
    try {
      await bridge.projectReceiverDisplay(this.taskSystemActor(), {
        taskId: task.id,
        receiverType: receiver.type,
        receiverId: receiver.id,
        receiverName: receiver.name,
      });
    } catch {
      // The next task refresh retries the display repair without blocking.
    }
  }

  private projectedTaskStatus(
    node: WorkflowNode | undefined,
    state: WorkflowNodeState,
  ): "todo" | "progress" | "review" {
    if (node?.type === "approval") return "review";
    if (state.status === "blocked") return "todo";
    if (
      state.status === "ready" &&
      node !== undefined &&
      node.reviewRequired !== false &&
      node.deliverables.length > 0 &&
      this.missingDeliverables(node, state).length === 0
    ) {
      return "review";
    }
    return "progress";
  }

  private shouldAutoCompleteHumanSubmission(
    node: WorkflowNode,
    state: WorkflowNodeState,
  ): boolean {
    if (node.type !== "task" || node.executor.kind !== "user") return false;
    const bridge = this.taskBridge();
    const task = state.taskIds
      .map((taskId) => bridge?.get(taskId))
      .findLast(
        (item) =>
          item !== undefined &&
          (item.nodeAttempt === undefined ||
            item.nodeAttempt === state.attempts),
      );
    return task?.autoApproveReview === true;
  }

  async workflowTaskOutcome(task: {
    readonly id: string;
    readonly nodeAttempt?: number | undefined;
    readonly workflow?:
      | { readonly instanceId: string; readonly nodeId: string }
      | undefined;
  }): Promise<
    "approved" | "rejected" | "cancelled" | "superseded" | undefined
  > {
    if (task.workflow === undefined) return undefined;
    const instance = this.instance(task.workflow.instanceId);
    const state = instance?.nodes[task.workflow.nodeId];
    if (instance === undefined || state === undefined) return undefined;
    if (!state.taskIds.includes(task.id)) return undefined;
    return this.projectionOutcome(instance, state, task);
  }

  taskEventProjections(task: {
    readonly workflow?:
      | { readonly instanceId: string; readonly nodeId: string }
      | undefined;
  }): WorkflowEvent[] {
    if (task.workflow === undefined) return [];
    return this.events(task.workflow.instanceId)
      .filter((event) => taskProjectedEventKinds.has(event.kind))
      .filter(
        (event) =>
          event.nodeId === undefined || event.nodeId === task.workflow!.nodeId,
      );
  }

  private async settleNodeTasks(
    instance: WorkflowInstance,
    node: WorkflowNode,
    outcome: "approved" | "rejected" | "cancelled" | "superseded" = "approved",
  ): Promise<void> {
    const bridge = this.taskBridge();
    const state = instance.nodes[node.id];
    if (bridge === undefined || state === undefined) return;
    if (!["completed", "skipped"].includes(state.status)) return;
    for (const taskId of state.taskIds) {
      const task = bridge.get(taskId);
      if (task === undefined || this.isTaskSettled(task)) continue;
      try {
        await bridge.settle(this.taskSystemActor(), taskId, outcome);
      } catch {
        // 工作流结论已落库；Task 侧保留失败痕迹，避免反向同步造成循环。
      }
    }
  }

  private async putInstance(
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    const next = workflowInstanceSchema.parse({
      ...instance,
      updatedAt: iso(this.now()),
    });
    await this.tables.instances.put(next.id, next);
    return next;
  }

  startInstance(
    actor: WorkflowActor,
    input: StartWorkflowInput,
  ): Promise<WorkflowInstance> {
    if (
      actor.kind !== "user" &&
      actor.workspaceRole === undefined &&
      actor.globalRole !== "admin"
    ) {
      throw new WorkflowError("forbidden", "workspace member is required");
    }
    if (
      actor.kind === "user" &&
      !isManager(actor) &&
      actor.workspaceRole !== "member" &&
      actor.globalRole !== "admin"
    ) {
      throw new WorkflowError("forbidden", "workspace member is required");
    }
    return this.enqueue(async () => {
      const definitions = this.sharedDefinitions();
      const definition =
        input.definitionId === undefined
          ? definitions.find((item) => item.status === "active")
          : definitions.find((item) => item.id === input.definitionId);
      if (definition === undefined) {
        throw new WorkflowError(
          "not_found",
          "active workflow definition not found",
        );
      }
      const identityErrors = this.actorReferenceIssues(
        definition.graph,
        input.workspaceId,
      ).filter((issue) => issue.level === "error");
      const agentErrors = this.agentReferenceIssues(
        definition.graph,
        input.workspaceId,
      ).filter((issue) => issue.level === "error");
      const roleErrors = this.roleReferenceIssues(
        definition.graph,
        input.workspaceId,
      ).filter((issue) => issue.level === "error");
      if (
        identityErrors.length > 0 ||
        agentErrors.length > 0 ||
        roleErrors.length > 0
      ) {
        throw new WorkflowError(
          "invalid_input",
          [...identityErrors, ...agentErrors, ...roleErrors]
            .map((issue) => issue.message)
            .join("; "),
        );
      }
      const related = [
        ...new Set([
          ...(input.sessionId === undefined ? [] : [input.sessionId]),
          ...(input.relatedSessionIds ?? []),
        ]),
      ];
      const timestamp = iso(this.now());
      /*
       * 启动时快照定义里引用到的项目角色定义与成员。之后项目角色如何编辑/删除，
       * 已启动实例都按这份快照解析角色；新实例才会使用新的角色集。
       */
      const roleSnapshot = this.roleSnapshotFor(
        definition.graph,
        input.workspaceId,
      );
      const instance: WorkflowInstance = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        definitionId: definition.id,
        definitionKey: definition.key,
        definitionVersion: definition.version,
        title: input.title,
        status: "running",
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        relatedSessionIds: related,
        roleSnapshot,
        context: {
          ...Object.fromEntries(
            definition.graph.variables.map((item) => [item.name, item.value]),
          ),
          ...input.context,
        },
        nodes: Object.fromEntries(
          definition.graph.nodes.map((node) => [
            node.id,
            this.initialState(node, timestamp),
          ]),
        ),
        createdBy: actor.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // 实例创建时可对「指派给项目角色」的节点指定具体执行人；
      // 没指定的角色节点保持角色不变，执行时按当刻成员展开。
      for (const [nodeId, assignee] of Object.entries(input.assignees ?? {})) {
        const node = definition.graph.nodes.find((item) => item.id === nodeId);
        if (node === undefined) {
          throw new WorkflowError(
            "invalid_input",
            `指定执行人的节点「${nodeId}」不在该模板里`,
          );
        }
        const nodeRoleIds = [
          ...(node.executor.kind === "role" ? [node.executor.id] : []),
          ...node.approvers
            .filter((approver) => approver.kind === "role")
            .map((approver) => approver.id),
        ];
        if (nodeRoleIds.length === 0) {
          throw new WorkflowError(
            "invalid_input",
            `节点「${node.name}」的执行人不是项目角色，无需在创建实例时指定执行人`,
          );
        }
        if (node.type === "approval") {
          // 审批节点：把「角色审批人」就地换成指定的那个人 / teammate。
          const approver = {
            kind:
              assignee.kind === "user" ? ("user" as const) : ("agent" as const),
            id: assignee.id,
            name: assignee.name ?? assignee.id,
          };
          const state = instance.nodes[nodeId]!;
          instance.nodes[nodeId] = {
            ...state,
            approvals: Object.fromEntries(
              Object.entries(state.approvals).map(([key, approval]) =>
                approval.approver.kind === "role"
                  ? [key, { ...approval, approver }]
                  : [key, approval],
              ),
            ),
            assignedTo: approver.name,
          };
          continue;
        }
        instance.nodes[nodeId] = {
          ...instance.nodes[nodeId]!,
          receiverOverride: {
            type: assignee.kind === "user" ? "human" : "agent",
            id: assignee.id,
            ...(assignee.name === undefined ? {} : { name: assignee.name }),
            at: timestamp,
          },
          assignedTo: assignee.name ?? assignee.id,
        };
      }
      for (const nodeId of definition.graph.startNodeIds) {
        instance.nodes[nodeId] = {
          ...instance.nodes[nodeId]!,
          status: "ready",
          enteredAt: timestamp,
        };
      }
      await this.tables.instances.put(
        instance.id,
        workflowInstanceSchema.parse(instance),
      );
      await this.appendEvent(instance, {
        kind: "instance.started",
        actor,
        message: `启动工作流：${input.title}`,
        data: { definition: `${definition.name} v${definition.version}` },
      });
      const started = await this.putInstance(instance);
      const tasksCreated = await this.syncNodeTasks(started);
      const dispatched = await this.autoDispatchAgentNodes(actor, tasksCreated);
      const synced = await this.syncNodeTasks(dispatched);
      return this.startReadySubworkflows(actor, synced);
    });
  }

  private async startReadySubworkflows(
    actor: WorkflowActor,
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    const definition = this.tables.definitions.get(instance.definitionId);
    if (definition === undefined) return instance;
    let current = instance;
    for (const node of definition.graph.nodes.filter(
      (item) => item.type === "subworkflow",
    )) {
      const state = current.nodes[node.id];
      if (state?.status !== "ready" || node.subworkflowKey === undefined)
        continue;
      const definitions = this.sharedDefinitions();
      const childDefinition = definitions.find(
        (item) =>
          item.key === node.subworkflowKey &&
          item.status === "active" &&
          (node.subworkflowVersion === undefined ||
            item.version === node.subworkflowVersion),
      );
      if (childDefinition === undefined) {
        current.nodes[node.id] = {
          ...state,
          status: "blocked",
          note: "子流程模板不可用",
        };
        current = await this.putInstance(current);
        await this.appendEvent(current, {
          nodeId: node.id,
          kind: "subworkflow.missing",
          actor,
          message: `子流程不可用：${node.subworkflowKey}`,
        });
        continue;
      }
      const child = await this.createChildInstance(
        actor,
        current,
        node,
        childDefinition,
      );
      current.nodes[node.id] = {
        ...current.nodes[node.id]!,
        status: "running",
        childInstanceId: child.id,
      };
      current = await this.putInstance(current);
      await this.appendEvent(current, {
        nodeId: node.id,
        kind: "subworkflow.started",
        actor,
        message: `启动子流程：${child.title}`,
        data: { childInstanceId: child.id },
      });
    }
    return this.refreshStatus(current);
  }

  private async createChildInstance(
    actor: WorkflowActor,
    parent: WorkflowInstance,
    node: WorkflowNode,
    definition: WorkflowDefinition,
  ): Promise<WorkflowInstance> {
    const timestamp = iso(this.now());
    const child: WorkflowInstance = {
      id: randomUUID(),
      workspaceId: parent.workspaceId,
      definitionId: definition.id,
      definitionKey: definition.key,
      definitionVersion: definition.version,
      title: `${parent.title} · ${node.name}`,
      status: "running",
      ...(parent.sessionId === undefined
        ? {}
        : { sessionId: parent.sessionId }),
      relatedSessionIds: [...parent.relatedSessionIds],
      roleSnapshot: this.roleSnapshotFor(definition.graph, parent.workspaceId),
      context: Object.fromEntries(
        definition.graph.variables.map((item) => [item.name, item.value]),
      ),
      nodes: Object.fromEntries(
        definition.graph.nodes.map((item) => [
          item.id,
          this.initialState(item, timestamp),
        ]),
      ),
      parentInstanceId: parent.id,
      parentNodeId: node.id,
      createdBy: actor.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    for (const nodeId of definition.graph.startNodeIds) {
      child.nodes[nodeId] = {
        ...child.nodes[nodeId]!,
        status: "ready",
        enteredAt: timestamp,
      };
    }
    await this.tables.instances.put(
      child.id,
      workflowInstanceSchema.parse(child),
    );
    await this.appendEvent(child, {
      kind: "instance.started",
      actor,
      message: `由父流程启动：${parent.title}`,
    });
    return child;
  }

  private incomingEdges(
    definition: WorkflowDefinition,
    nodeId: string,
  ): WorkflowEdge[] {
    return definition.graph.edges.filter((edge) => edge.to === nodeId);
  }

  private outgoingEdges(
    definition: WorkflowDefinition,
    nodeId: string,
  ): WorkflowEdge[] {
    return definition.graph.edges.filter((edge) => edge.from === nodeId);
  }

  private skipUnmatchedBranch(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    edge: WorkflowEdge,
  ): void {
    const target = instance.nodes[edge.to];
    if (target?.status !== "waiting") return;
    const alternativeRoutes = this.incomingEdges(definition, edge.to).filter(
      (candidate) => candidate.from !== edge.from,
    );
    if (alternativeRoutes.length > 0) return;
    instance.nodes[edge.to] = {
      ...target,
      status: "skipped",
      note: "当前分支未命中",
      completedAt: iso(this.now()),
    };
  }

  private async advance(
    actor: WorkflowActor,
    instance: WorkflowInstance,
    completedNodeId?: string,
  ): Promise<WorkflowInstance> {
    const definition = this.tables.definitions.get(instance.definitionId);
    if (definition === undefined) return instance;
    let current = instance;
    const context = graphContext(current);
    const completed = new Set(
      Object.values(current.nodes)
        .filter(
          (state) => state.status === "completed" || state.status === "skipped",
        )
        .map((state) => state.nodeId),
    );
    for (const edge of definition.graph.edges.filter(
      (item) => item.from === completedNodeId,
    )) {
      const sourceState = current.nodes[edge.from];
      if (sourceState?.status !== "completed") continue;
      if (
        edge.result !== undefined &&
        edge.result !==
          (sourceState.note?.startsWith("rejected") ? "rejected" : "approved")
      ) {
        continue;
      }
      if (edge.condition !== undefined) {
        try {
          if (!evaluateExpression(edge.condition, context)) {
            this.skipUnmatchedBranch(current, definition, edge);
            continue;
          }
        } catch (error) {
          current.nodes[edge.to] = {
            ...current.nodes[edge.to]!,
            status: "blocked",
            note: error instanceof Error ? error.message : "条件表达式无效",
          };
          continue;
        }
      }
      if (
        !edge.default &&
        edge.result === undefined &&
        edge.condition === undefined
      ) {
        const node = definition.graph.nodes.find(
          (item) => item.id === edge.from,
        );
        if (node?.type === "decision") continue;
      }
      if (edge.default) {
        const sourceNode = definition.graph.nodes.find(
          (item) => item.id === edge.from,
        );
        const hasMatchingCondition =
          sourceNode?.type === "decision" &&
          definition.graph.edges.some(
            (candidate) =>
              candidate.from === edge.from &&
              !candidate.default &&
              candidate.condition !== undefined &&
              safeEvaluate(candidate.condition, context),
          );
        if (hasMatchingCondition) {
          this.skipUnmatchedBranch(current, definition, edge);
          continue;
        }
      }
      if (
        edge.breakCondition !== undefined &&
        safeEvaluate(edge.breakCondition, context)
      ) {
        const breakTarget = current.nodes[edge.to];
        current.nodes[edge.to] = {
          ...breakTarget!,
          status: "blocked",
          note: `已触发 break：${edge.breakCondition}`,
        };
        await this.appendEvent(current, {
          nodeId: edge.to,
          kind: "loop.break",
          actor,
          message: `已触发循环保护：${edge.breakCondition}`,
          data: { edgeId: edge.id },
        });
        continue;
      }
      const blockers = this.incomingEdges(definition, edge.to).filter(
        (candidate) => {
          const source = current.nodes[candidate.from];
          return source?.status !== "waiting" && !completed.has(candidate.from);
        },
      );
      if (blockers.length > 0) continue;
      const target = current.nodes[edge.to];
      const isReworkEdge = ["completed", "skipped"].includes(
        target?.status ?? "",
      );
      if (
        target === undefined ||
        (!isReworkEdge &&
          ["completed", "running", "ready"].includes(target.status))
      ) {
        continue;
      }
      if (isReworkEdge) this.incrementLoopVariables(current, definition, edge);
      const visits = Number(context[`visits.${edge.to}`] ?? 0) + 1;
      context[`visits.${edge.to}`] = visits;
      context[`${edge.to}.attempts`] = visits;
      const targetNode = definition.graph.nodes.find(
        (item) => item.id === edge.to,
      );
      if (this.taskBridge() !== undefined) {
        for (const taskId of target?.taskIds ?? []) {
          try {
            await this.taskBridge()?.settle(
              this.taskSystemActor(),
              taskId,
              "superseded",
            );
          } catch {
            // 新一轮任务仍会创建；旧投影保留失败事件，由后续同步收敛。
          }
        }
      }
      current.nodes[edge.to] = {
        ...target,
        ...(isReworkEdge && targetNode !== undefined
          ? this.initialState(targetNode, "")
          : {}),
        status: "ready",
        attempts: isReworkEdge ? Number(target?.attempts ?? 1) + 1 : visits,
        enteredAt: iso(this.now()),
        note: undefined,
        // 新一轮回到模版执行人：上一轮的人工改派与失效兜底都不再沿用。
        ...(isReworkEdge
          ? { receiverOverride: undefined, executorFallback: undefined }
          : {}),
      };
    }
    current = await this.putInstance(current);
    current = await this.putInstance(this.refreshStatus(current));
    current = await this.syncNodeTasks(current);
    current = await this.putInstance(this.refreshStatus(current));
    current = await this.autoDispatchAgentNodes(actor, current);
    current = await this.syncNodeTasks(current);
    return this.startReadySubworkflows(actor, current);
  }

  async agentRuns(instanceId: string): Promise<AgentRunView[]> {
    const instance = this.instance(instanceId);
    if (instance === undefined) return [];
    const agent = this.options.agent?.();
    return agent?.runs(instanceId) ?? [];
  }

  async reconcileAgentRunProjections(
    instanceId: string,
  ): Promise<WorkflowInstance | undefined> {
    const instance = this.instance(instanceId);
    if (instance === undefined) return undefined;
    for (const run of await this.agentRuns(instanceId)) {
      await this.syncAgentRun(instance, run.nodeId, run);
    }
    return this.instance(instanceId);
  }

  dispatchAgentNode(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      trigger: "manual-dispatch" | "auto-on-ready";
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance } = await this.dispatchAgentNodeLocked(actor, input);
      return instance;
    });
  }

  cancelAgentRun(
    actor: WorkflowActor,
    runId: string,
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const agent = this.requireAgentService();
      const run = agent.run(runId);
      if (run === undefined)
        throw new WorkflowError("not_found", "agent run not found");
      if (!isAgentRunActive(run)) {
        throw new WorkflowError(
          "conflict",
          run.status === "succeeded"
            ? "Agent 运行已完成，无法取消"
            : "Agent 运行已结束，无法取消",
        );
      }
      const instance = this.instance(run.instanceId);
      if (instance === undefined)
        throw new WorkflowError("not_found", "workflow instance not found");
      const { node } = this.requireNode(instance, run.nodeId);
      if (
        actor.kind !== "user" ||
        (!isManager(actor) && !this.canSubmit(actor, node, instance))
      )
        throw new WorkflowError(
          "forbidden",
          "只有节点负责人、工作区负责人或管理员可以取消 Agent 运行",
        );
      try {
        await agent.cancel(runId);
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "conflict"
        ) {
          throw new WorkflowError(
            "conflict",
            cause.message || "Agent 运行已结束，无法取消",
          );
        }
        throw cause;
      }
      return this.instance(run.instanceId) ?? instance;
    });
  }

  retryAgentRun(
    actor: WorkflowActor,
    runId: string,
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const agent = this.requireAgentService();
      const run = agent.run(runId);
      if (run === undefined)
        throw new WorkflowError("not_found", "agent run not found");
      const instance = this.instance(run.instanceId);
      if (instance === undefined)
        throw new WorkflowError("not_found", "workflow instance not found");
      const { node } = this.requireNode(instance, run.nodeId);
      if (
        actor.kind !== "user" ||
        (!isManager(actor) && !this.canSubmit(actor, node, instance))
      )
        throw new WorkflowError(
          "forbidden",
          "只有节点负责人、工作区负责人或管理员可以重试 Agent 运行",
        );
      const state = instance.nodes[run.nodeId]!;
      const outputRejected =
        run.status === "succeeded" &&
        state.status === "blocked" &&
        state.note?.startsWith("Agent 未按约定输出「交付说明」") === true;
      const ticketRejected =
        run.status === "succeeded" &&
        state.status === "blocked" &&
        /^(Digital Employee|AI伙伴|Teammate)\s*输出被拒绝/.test(
          state.note ?? "",
        );
      if (
        !["failed", "timeout", "interrupted", "cancelled"].includes(
          run.status,
        ) &&
        !outputRejected &&
        !ticketRejected
      )
        throw new WorkflowError(
          "conflict",
          "只有失败、超时、中断、已取消、输出无效或输出被票据拒绝的运行可以重试",
        );
      const recoveredInterruption =
        run.status === "interrupted" && state.status === "running";
      if (
        !["ready", "blocked"].includes(state.status) &&
        !recoveredInterruption
      )
        throw new WorkflowError("conflict", "节点当前不能重试 Agent 运行");
      const reset = await this.putInstance({
        ...instance,
        nodes: {
          ...instance.nodes,
          [run.nodeId]: { ...state, status: "ready", note: undefined },
        },
      });
      const { instance: updated } = await this.dispatchAgentNodeLocked(actor, {
        instanceId: reset.id,
        nodeId: run.nodeId,
        trigger: "manual-dispatch",
      });
      return updated;
    });
  }

  private requireAgentService(): AgentServiceLike {
    const agent = this.options.agent?.();
    if (agent === undefined)
      throw new WorkflowError("not_found", "Agent 注册表不可用");
    return agent;
  }

  /**
   * 执行实例失效后的兜底接收人：优先实例 owner；owner 不在项目里时交给项目
   * owner（没有项目 owner 再兜回实例 owner）。平台托管实例没有个人 owner，
   * 直接落到项目 owner；都解析不到时返回 undefined。
   */
  private executorFallbackReceiver(
    teammate: {
      readonly ownerUserId?: string | undefined;
      readonly ownerName?: string | undefined;
    },
    workspaceId: string,
  ): { readonly id: string; readonly name: string } | undefined {
    const team = this.options.team?.();
    const members = team?.members(workspaceId) ?? [];
    const nameOf = (userId: string, fallback?: string): string =>
      team
        ?.users()
        .find((user) => user.id === userId)
        ?.name?.trim() ||
      members.find((member) => member.userId === userId)?.name?.trim() ||
      fallback ||
      userId;
    const projectOwner = members.find(
      (member) => member.memberRole === "owner",
    );
    const ownerId = teammate.ownerUserId?.trim();
    if (ownerId === undefined || ownerId === "" || ownerId === "platform") {
      return projectOwner === undefined
        ? undefined
        : { id: projectOwner.userId, name: nameOf(projectOwner.userId) };
    }
    if (members.some((member) => member.userId === ownerId)) {
      return { id: ownerId, name: nameOf(ownerId, teammate.ownerName) };
    }
    return projectOwner === undefined
      ? { id: ownerId, name: nameOf(ownerId, teammate.ownerName) }
      : { id: projectOwner.userId, name: nameOf(projectOwner.userId) };
  }

  /**
   * 执行实例失效兜底：把节点改派给实例 owner（真人）人工处理，任务责任人
   * 同步切换，不产生 Agent 运行。仅在执行者为 Teammate 且能解析出兜底
   * 接收人时生效；返回 undefined 表示维持原有失败处理。
   */
  private async fallbackExecutorToOwner(
    instance: WorkflowInstance,
    node: WorkflowNode,
    state: WorkflowNodeState,
    reason: string,
  ): Promise<{ instance: WorkflowInstance } | undefined> {
    if (node.executor.kind !== "employee") return undefined;
    const teammate = this.options
      .teammates?.()
      ?.list()
      .find(
        (item) =>
          item.id === node.executor.id ||
          (item.employeeId !== undefined &&
            item.employeeId === node.executor.id),
      );
    if (teammate === undefined) return undefined;
    const receiver = this.executorFallbackReceiver(
      teammate,
      instance.workspaceId,
    );
    if (receiver === undefined) return undefined;
    const timestamp = iso(this.now());
    const executorLabel =
      teammate.name || node.executor.label || node.executor.id;
    const note = `执行实例「${executorLabel}」已失效：${reason}；已自动转交「${receiver.name}」人工处理`;
    const updated = await this.putInstance({
      ...instance,
      nodes: {
        ...instance.nodes,
        [node.id]: {
          ...state,
          status: "ready",
          assignedTo: receiver.name,
          note,
          // 系统兜底优先于历史人工改派：执行实例真的失效时重新回到 owner 人工处理。
          receiverOverride: undefined,
          executorFallback: {
            kind: "user",
            id: receiver.id,
            label: receiver.name,
            reason,
            originalExecutorId: node.executor.id,
            originalExecutorLabel: executorLabel,
            at: timestamp,
          },
        },
      },
    });
    await this.appendEvent(updated, {
      nodeId: node.id,
      kind: "executor.fallback",
      actor: { kind: "system", id: "workflow", name: "系统" },
      message: note,
      data: {
        executorId: node.executor.id,
        fallbackUserId: receiver.id,
        reason,
      },
    });
    const synced = await this.syncNodeTasks(updated);
    return { instance: synced };
  }

  private async dispatchAgentNodeLocked(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      trigger: "manual-dispatch" | "auto-on-ready";
    },
  ): Promise<{ instance: WorkflowInstance; run?: AgentRunView }> {
    const { instance, node } = this.requireNode(
      this.instance(input.instanceId),
      input.nodeId,
    );
    const state = instance.nodes[node.id]!;
    if (state.executorFallback !== undefined)
      throw new WorkflowError(
        "conflict",
        `节点已转交「${state.executorFallback.label ?? state.executorFallback.id}」人工处理`,
      );
    const executor = node.executor;
    if (node.type !== "task" || !["agent", "employee"].includes(executor.kind))
      throw new WorkflowError(
        "invalid_input",
        "只有 Agent 或 AI伙伴执行的任务节点可以派发",
      );
    if (node.execution !== "task-worker")
      throw new WorkflowError(
        "invalid_input",
        "该节点未启用 task-worker 执行模式",
      );
    const isAuto = input.trigger === "auto-on-ready";
    const agent = this.requireAgentService();
    if (!isAuto) {
      if (actor.kind !== "user")
        throw new WorkflowError("forbidden", "Agent 派发需要用户操作");
      if (!isManager(actor) && !this.canSubmit(actor, node, instance))
        throw new WorkflowError(
          "forbidden",
          "只有节点负责人、工作区负责人或管理员可以派发 Agent",
        );
    }
    const serviceFailureRecoverable =
      !isAuto &&
      state.status === "blocked" &&
      (state.note?.startsWith("Agent Profile") === true ||
        /^(Digital Employee|AI伙伴|AI Teammate|Teammate)/.test(
          state.note ?? "",
        )) &&
      agent.runs(instance.id, node.id).every((run) => !isAgentRunActive(run));
    const dispatchState = serviceFailureRecoverable
      ? { ...state, status: "ready" as const, note: undefined }
      : state;
    if (dispatchState.status !== "ready")
      throw new WorkflowError("conflict", "节点当前不处于可执行状态");
    const employees = this.options.employee?.();
    let employeeTarget:
      | ReturnType<EmployeeServiceLike["workflowTarget"]>
      | undefined;
    let runtimePrincipalId: string | undefined;
    let provisionFailure: string | undefined;
    let profileId: string;
    if (executor.kind === "employee") {
      employeeTarget = employees?.workflowTarget(
        executor.id,
        instance.workspaceId,
      );
      // 该项目里还没有该实例的运行身份时，像任务派发链路一样先开通一次
      // （仅用户手动派发时触发，自动派发仍按「未授权」直接阻塞）。
      if (employeeTarget === undefined && !isAuto) {
        const runtime = this.options.teammateRuntime?.();
        if (runtime !== undefined) {
          // 执行者可能是 teammate 实例 id，也可能是员工身份 id；统一解析成实例 id。
          const teammate = this.options
            .teammates?.()
            ?.list()
            .find(
              (item) =>
                item.id === executor.id ||
                (item.employeeId !== undefined &&
                  item.employeeId === executor.id),
            );
          try {
            const ensured = await runtime.ensureRuntime({
              teammateId: teammate?.id ?? executor.id,
              workspaceId: instance.workspaceId,
              actor: {
                userId: actor.id,
                name: actor.name ?? actor.id,
                role:
                  actor.globalRole === "admin"
                    ? "admin"
                    : (actor.workspaceRole ?? "member"),
              },
            });
            runtimePrincipalId = ensured.principalId;
            employeeTarget =
              ensured.employeeId === undefined
                ? undefined
                : employees?.workflowTarget(
                    ensured.employeeId,
                    instance.workspaceId,
                  );
          } catch (cause) {
            // 开通失败（如实例已暂停/模版停用）时记下原因，
            // 供「失效兜底」和下方「不可派发」分支复用。
            provisionFailure =
              cause instanceof Error ? cause.message : "运行身份开通失败";
          }
          employeeTarget ??= employees?.workflowTarget(
            executor.id,
            instance.workspaceId,
          );
        }
      }
      // 开通之后复查阻断原因：仍然不满足（成员停用/无映射等）才拒绝或阻塞。
      // 注意：自动开通可能把 teammate 换绑到新的员工身份，复查要用开通后的身份。
      const dispatchBlockReason =
        employeeTarget === undefined
          ? undefined
          : employees?.workflowDispatchBlockReason(
              employeeTarget.employee.id,
              instance.workspaceId,
            );
      if (dispatchBlockReason !== undefined) {
        const fallback = await this.fallbackExecutorToOwner(
          instance,
          node,
          dispatchState,
          dispatchBlockReason,
        );
        if (fallback !== undefined) return fallback;
        if (!isAuto) throw new WorkflowError("forbidden", dispatchBlockReason);
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: {
              ...state,
              status: "blocked",
              note: dispatchBlockReason,
            },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.dispatch_failed",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message: dispatchBlockReason,
          data: { employeeId: executor.id },
        });
        return { instance: blocked };
      }
      if (employeeTarget === undefined) {
        const message =
          provisionFailure ??
          `AI伙伴「${executor.id}」不可派发；请检查实例状态、工作区授权、Runtime Profile 和 Agent Profile 映射`;
        const fallback = await this.fallbackExecutorToOwner(
          instance,
          node,
          dispatchState,
          message,
        );
        if (fallback !== undefined) return fallback;
        if (!isAuto) throw new WorkflowError("invalid_input", message);
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: { ...state, status: "blocked", note: message },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.dispatch_failed",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message,
          data: { employeeId: executor.id },
        });
        return { instance: blocked };
      }
      profileId = employeeTarget.profile.legacyAgentProfileId!;
    } else {
      const teammate = this.options
        .teammates?.()
        ?.list()
        .find(
          (item) =>
            item.id === executor.id ||
            (item.employeeId !== undefined && item.employeeId === executor.id),
        );
      const principal =
        teammate === undefined
          ? undefined
          : this.options
              .principals?.()
              ?.resolveSubject("teammate", teammate.id);
      runtimePrincipalId = principal?.id;
      const existingRuntime =
        principal === undefined
          ? undefined
          : this.options
              .principalRuntime?.()
              ?.profile(principal.id, instance.workspaceId);
      if (existingRuntime !== undefined) {
        profileId = existingRuntime.agentProfileId;
      } else if (teammate !== undefined && !isAuto) {
        const runtime = this.options.teammateRuntime?.();
        if (runtime !== undefined) {
          try {
            const ensured = await runtime.ensureRuntime({
              teammateId: teammate.id,
              workspaceId: instance.workspaceId,
              actor: {
                userId: actor.id,
                name: actor.name ?? actor.id,
                role:
                  actor.globalRole === "admin"
                    ? "admin"
                    : (actor.workspaceRole ?? "member"),
              },
            });
            runtimePrincipalId = ensured.principalId ?? runtimePrincipalId;
            profileId = ensured.profileId;
          } catch (cause) {
            provisionFailure =
              cause instanceof Error ? cause.message : "运行身份开通失败";
            profileId = node.agentProfileId ?? executor.id;
          }
        } else {
          profileId = node.agentProfileId ?? executor.id;
        }
      } else {
        profileId = node.agentProfileId ?? executor.id;
      }
    }
    const profile = agent.profile(instance.workspaceId, profileId);
    if (
      profile === undefined ||
      profile.status !== "active" ||
      profile.runtimeKind !== "task-worker"
    ) {
      const message =
        profile === undefined
          ? `Agent Profile「${profileId}」不存在，请先在工作区创建`
          : profile.status !== "active"
            ? `Agent Profile「${profile.name}」已停用`
            : `Agent Profile「${profile.name}」不是 task-worker 类型`;
      if (executor.kind === "employee") {
        const fallback = await this.fallbackExecutorToOwner(
          instance,
          node,
          dispatchState,
          message,
        );
        if (fallback !== undefined) return fallback;
      }
      if (!isAuto) throw new WorkflowError("invalid_input", message);
      const blocked = await this.putInstance({
        ...instance,
        nodes: {
          ...instance.nodes,
          [node.id]: { ...state, status: "blocked", note: message },
        },
      });
      await this.appendEvent(blocked, {
        nodeId: node.id,
        kind: "agent.dispatch_failed",
        actor: { kind: "system", id: "workflow", name: "系统" },
        message,
        data: { profileId },
      });
      return { instance: blocked };
    }
    const entryPrefix = `${instance.workspaceId}:${instance.id}:${node.id}:a${dispatchState.attempts}:${dispatchState.enteredAt ?? "unknown"}`;
    const previousRuns = agent.runs(instance.id, node.id);
    const previousRun = previousRuns[0];
    const rejectedSubmission = [...this.nodeSubmissions(instance.id, node.id)]
      .reverse()
      .find((submission) => submission.status === "rejected");
    const previousFailureParts: string[] = [];
    const previousRunFailed =
      previousRun !== undefined &&
      (["failed", "timeout", "interrupted", "cancelled"].includes(
        previousRun.status,
      ) ||
        (previousRun.status === "succeeded" &&
          state.status === "blocked" &&
          (state.note?.startsWith("Agent 未按约定输出") === true ||
            /^(Digital Employee|AI伙伴|Teammate)\s*输出被拒绝/.test(
              state.note ?? "",
            ))));
    if (previousRunFailed) {
      if (previousRun.status === "succeeded" && (state.note ?? "") !== "") {
        previousFailureParts.push(state.note ?? "");
      } else {
        previousFailureParts.push(previousRun.error ?? "上一轮运行未成功");
      }
    }
    if (rejectedSubmission !== undefined) {
      previousFailureParts.push(
        `交付物审核不通过：${rejectedSubmission.requirementTitle}${
          rejectedSubmission.note ? `：${rejectedSubmission.note}` : ""
        }`,
      );
    }
    const previousFailure = previousFailureParts.join("\n").slice(0, 2_000);
    const runSeq =
      previousRuns.filter((run) =>
        run.dispatchKey.startsWith(`${entryPrefix}#`),
      ).length + 1;
    if (runSeq > node.maxAttempts) {
      if (isAuto) return { instance };
      if (!isManager(actor))
        throw new WorkflowError(
          "forbidden",
          `已达到派发上限（max-attempts=${node.maxAttempts}）；如需继续，请联系工作区负责人或管理员`,
        );
    }
    const dispatchKey = `${entryPrefix}#${runSeq}`;
    let ticketId: string | undefined;
    let principalId =
      runtimePrincipalId ??
      (employeeTarget === undefined
        ? (this.options
            .principals?.()
            ?.resolveSubject("teammate", node.executor.id)?.id ??
          this.options
            .principals?.()
            ?.resolveSubject("employee", node.executor.id)?.id)
        : this.options
            .principals?.()
            ?.resolveSubject("employee", employeeTarget.employee.id)?.id);
    if (employeeTarget !== undefined) {
      if (employees === undefined || actor.kind !== "user") {
        const message = "AI伙伴运行需要有效的真人操作上下文";
        if (!isAuto) throw new WorkflowError("forbidden", message);
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: { ...state, status: "blocked", note: message },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.dispatch_failed",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message,
          data: { employeeId: employeeTarget.employee.id },
        });
        return { instance: blocked };
      }
      try {
        const ticket = await employees.issueRuntimeTicket(actor.id, {
          actorAuthUserId: actor.id,
          employeeId: employeeTarget.employee.id,
          workspaceId: instance.workspaceId,
          contextType: "workflow",
          contextId: instance.id,
          requestedActions: ["read", "write"],
          resourceScopes: [`workflow/${instance.id}/${node.id}`],
          durationMinutes: Math.min(
            1_440,
            Math.ceil(node.timeoutMs / 60_000) + 1,
          ),
        });
        ticketId = ticket.id;
        principalId = ticket.principal?.principalId ?? principalId;
      } catch (cause) {
        const message =
          cause instanceof Error
            ? `AI伙伴运行票据签发失败：${cause.message}`
            : "AI伙伴运行票据签发失败";
        if (!isAuto) throw new WorkflowError("forbidden", message);
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: { ...state, status: "blocked", note: message },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.dispatch_failed",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message,
          data: { employeeId: employeeTarget.employee.id },
        });
        return { instance: blocked };
      }
    }
    const principalRuntime = this.options.principalRuntime?.();
    if (
      employeeTarget === undefined &&
      principalId === undefined &&
      executor.kind === "agent"
    ) {
      // Legacy workflow templates may reference an Agent Profile directly.
      // Resolve it only when exactly one active Principal Runtime owns that
      // profile, otherwise leaving it unset is safer than guessing an identity.
      const candidates = (principalRuntime?.profiles?.() ?? []).filter(
        (runtime) =>
          runtime.workspaceId === instance.workspaceId &&
          runtime.agentProfileId === profile.id &&
          runtime.status === "active",
      );
      if (candidates.length === 1) {
        principalId = candidates[0]!.principalId;
      }
    }
    if (
      employeeTarget === undefined &&
      principalId !== undefined &&
      principalRuntime?.profile(principalId, instance.workspaceId) !== undefined
    ) {
      try {
        const ticket = await principalRuntime.issueTicket({
          principalId,
          workspaceId: instance.workspaceId,
          contextType: "workflow",
          contextId: instance.id,
          requestedActions: ["read", "write"],
          resourceScopes: [`workflow/${instance.id}/${node.id}`],
          durationMinutes: Math.min(
            1_440,
            Math.ceil(node.timeoutMs / 60_000) + 1,
          ),
          issuedByUserId: actor.id,
        });
        ticketId = ticket.id;
      } catch (cause) {
        const message =
          cause instanceof Error
            ? `AI Principal 运行票据签发失败：${cause.message}`
            : "AI Principal 运行票据签发失败";
        if (!isAuto) throw new WorkflowError("forbidden", message);
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: { ...state, status: "blocked", note: message },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.dispatch_failed",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message,
          data: { principalId },
        });
        return { instance: blocked };
      }
    }
    const contextService = this.options.context?.();
    const contextPack =
      contextService === undefined
        ? undefined
        : await contextService.prepare({
            requestId: `workflow-node:${instance.id}:${node.id}:${dispatchKey}`,
            mode: "execute",
            scene: "workflow-node",
            workspaceId: instance.workspaceId,
            objectId: `${instance.id}:${node.id}`,
            agentPrincipalId: principalId ?? profile.id,
            agentProfileId: profile.id,
            teammateId: node.executor.id,
            actorPrincipalId: actor.id,
            input: {
              type: "node-dispatch",
              content: node.description,
              attachments: [],
            },
            explicitRefs: [
              { type: "workflow", id: instance.id },
              ...(state.taskIds.at(-1) === undefined
                ? []
                : [
                    {
                      type: "task" as const,
                      id: state.taskIds.at(-1)!,
                    },
                  ]),
            ],
            pinnedMemoryIds: [],
            excludedSourceIds: [],
            runtimeCapabilities: {
              contextWindowTokens: 32_000,
              maxOutputTokens: 4_000,
              supportsSystemSections: true,
              isStateless: false,
            },
          });
    const contextSession =
      contextService !== undefined && contextPack !== undefined
        ? contextService.session?.(contextPack.sessionBindingId)
        : undefined;
    const run = await agent.dispatch({
      workspaceId: instance.workspaceId,
      ...(this.workspacePath(instance.workspaceId) === undefined
        ? {}
        : { workspacePath: this.workspacePath(instance.workspaceId) }),
      profileId: profile.id,
      source: "workflow",
      instanceId: instance.id,
      nodeId: node.id,
      dispatchKey,
      trigger: input.trigger,
      attempt: dispatchState.attempts,
      runSeq,
      maxAttempts: node.maxAttempts,
      timeoutMs: node.timeoutMs,
      ...(profile.personaId === undefined
        ? {}
        : { personaId: profile.personaId }),
      ...(employeeTarget === undefined
        ? {
            principalType:
              principalId === undefined
                ? ("transitional-agent" as const)
                : ("principal-runtime" as const),
            ...(ticketId === undefined ? {} : { ticketId }),
          }
        : {
            employeeId: employeeTarget.employee.id,
            principalType: "digital-employee" as const,
            ...(ticketId === undefined ? {} : { ticketId }),
          }),
      ...(principalId === undefined ? {} : { principalId }),
      ...(contextPack === undefined
        ? {}
        : {
            contextPackId: contextPack.id,
            sessionBindingId: contextPack.sessionBindingId,
          }),
      ...(contextSession === undefined
        ? {}
        : { sessionId: contextSession.sessionId }),
      payload: {
        instanceTitle: instance.title,
        nodeName: node.name,
        nodeDescription: node.description,
        profileName: profile.name,
        ...(previousFailure === "" ? {} : { previousFailure }),
        ...(employeeTarget === undefined
          ? {}
          : { employeeName: employeeTarget.employee.displayName }),
        ...(node.responsible === undefined
          ? {}
          : { responsibleId: node.responsible.id }),
        deliverables: node.deliverables.map((item) => ({
          key: item.key,
          title: item.title,
          type: item.type,
          required: item.required,
          description: item.description,
          ...(item.minTextLength === undefined
            ? {}
            : { minTextLength: item.minTextLength }),
        })),
        context: {
          ...instance.context,
          ...(contextPack === undefined
            ? {}
            : {
                instruction: contextPack.rendered.flattenedPrompt,
                contextPackId: contextPack.id,
              }),
          ...(state.taskIds.at(-1) === undefined
            ? {}
            : { workflowTaskId: state.taskIds.at(-1)! }),
        },
      },
      createdBy: actor.kind === "user" ? actor.id : "workflow",
    });
    if (contextService !== undefined && contextPack !== undefined) {
      await contextService.recordRuntime({
        runId: run.id,
        contextPackId: contextPack.id,
        runtime: { kind: "builtin" },
      });
    }
    const updated = await this.putInstance(
      this.syncDeliverableStates({
        ...instance,
        nodes: {
          ...instance.nodes,
          [node.id]: {
            ...state,
            status: "running",
            assignedTo:
              employeeTarget?.employee.displayName ??
              (state.taskIds.at(-1) === undefined
                ? profile.name
                : (this.taskBridge()?.get(state.taskIds.at(-1)!)
                    ?.receiverName ?? profile.name)),
            note: `${employeeTarget === undefined ? "Agent " : "AI伙伴"}${isAuto ? "自动" : ""}运行中 · 第 ${runSeq} 次`,
          },
        },
      }),
    );
    await this.appendEvent(updated, {
      nodeId: node.id,
      kind: "agent.dispatched",
      actor: isAuto ? { kind: "system", id: "workflow", name: "系统" } : actor,
      message: `派发 ${employeeTarget === undefined ? "Agent" : "AI伙伴"}「${employeeTarget?.employee.displayName ?? profile.name}」运行（第 ${runSeq} 次）`,
      data: {
        runId: run.id,
        trigger: input.trigger,
        ...(employeeTarget === undefined
          ? {}
          : { employeeId: employeeTarget.employee.id, ticketId }),
        ...(principalId === undefined
          ? {}
          : {
              principalId,
              ...(ticketId === undefined ? {} : { ticketId }),
            }),
      },
    });
    await this.syncAgentRun(updated, node.id, run);
    return { instance: updated, run };
  }

  private async autoDispatchAgentNodes(
    actor: WorkflowActor,
    instance: WorkflowInstance,
  ): Promise<WorkflowInstance> {
    if (this.options.agent?.() === undefined) return instance;
    const definition = this.tables.definitions.get(instance.definitionId);
    if (definition === undefined) return instance;
    let current = instance;
    for (const node of definition.graph.nodes) {
      if (
        node.type !== "task" ||
        !["agent", "employee"].includes(node.executor.kind)
      )
        continue;
      if (node.execution !== "task-worker" || node.trigger !== "auto-on-ready")
        continue;
      if (current.nodes[node.id]?.status !== "ready") continue;
      // 已转交 owner 人工处理的节点不再自动派发。
      if (current.nodes[node.id]?.executorFallback !== undefined) continue;
      // 人工改派给了真人 / 角色：由那个人处理，不再自动唤起模版里的 Agent。
      const override = current.nodes[node.id]?.receiverOverride;
      if (override !== undefined && override.type !== "agent") continue;
      try {
        const { instance: updated } = await this.dispatchAgentNodeLocked(
          actor,
          { instanceId: current.id, nodeId: node.id, trigger: "auto-on-ready" },
        );
        current = updated;
      } catch {
        current = this.instance(current.id) ?? current;
      }
    }
    return current;
  }

  async handleAgentSettle(run: AgentRunView): Promise<void> {
    await this.enqueue(async () => {
      const instance = this.instance(run.instanceId);
      if (instance === undefined) return;
      const definition = this.tables.definitions.get(instance.definitionId);
      if (definition === undefined) return;
      const node = definition.graph.nodes.find(
        (item) => item.id === run.nodeId,
      );
      const state = instance.nodes[run.nodeId];
      if (node === undefined || state === undefined) return;
      await this.syncAgentRun(instance, node.id, run);
      if (["completed", "skipped"].includes(state.status)) return;
      if (run.status === "succeeded") {
        await this.applyAgentSuccess(instance, node, run);
        return;
      }
      if (run.status === "cancelled") {
        const updated = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: {
              ...state,
              status: "ready",
              note: "Agent 运行已取消，可重新派发或人工代交",
            },
          },
        });
        await this.appendEvent(updated, {
          nodeId: node.id,
          kind: "agent.cancelled",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message: `Agent 运行已取消（第 ${run.runSeq} 次）`,
          data: { runId: run.id },
        });
        return;
      }
      const reason =
        run.error ??
        (run.status === "timeout"
          ? "运行超时"
          : run.status === "interrupted"
            ? "服务重启导致运行中断"
            : "Agent 运行失败");
      const updated = await this.putInstance({
        ...instance,
        nodes: {
          ...instance.nodes,
          [node.id]: {
            ...state,
            status: "blocked",
            note: `Agent 运行未完成：${reason}`,
          },
        },
      });
      await this.appendEvent(updated, {
        nodeId: node.id,
        kind: "agent.failed",
        actor: { kind: "system", id: "workflow", name: "系统" },
        message: `Agent 运行未完成：${reason}`,
        data: { runId: run.id, status: run.status },
      });
    });
  }

  private async applyAgentSuccess(
    instance: WorkflowInstance,
    node: WorkflowNode,
    run: AgentRunView,
  ): Promise<void> {
    const state = instance.nodes[node.id]!;
    const summary = run.output?.summary ?? "";
    const deliverableText = extractAgentDeliverableText(summary);
    if (run.ticketId !== undefined) {
      try {
        if (run.principalType === "principal-runtime") {
          const runtime = this.options.principalRuntime?.();
          if (runtime === undefined) {
            throw new Error("Principal Runtime 服务不可用");
          }
          await runtime.authorizeTicket({
            ticketId: run.ticketId,
            action: "write",
            resource: `workflow/${instance.id}/${node.id}`,
            workspaceId: instance.workspaceId,
            contextType: "workflow",
            contextId: instance.id,
          });
        } else {
          const employees = this.options.employee?.();
          if (employees === undefined) throw new Error("员工目录不可用");
          await employees.authorizeTicket({
            ticketId: run.ticketId,
            action: "write",
            resource: `workflow/${instance.id}/${node.id}`,
            workspaceId: instance.workspaceId,
            contextType: "workflow",
            contextId: instance.id,
          });
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "授权失败";
        const message = `AI伙伴输出被拒绝：运行票据授权失败（${reason}）`;
        const blocked = await this.putInstance({
          ...instance,
          nodes: {
            ...instance.nodes,
            [node.id]: { ...state, status: "blocked", note: message },
          },
        });
        await this.appendEvent(blocked, {
          nodeId: node.id,
          kind: "agent.ticket_denied",
          actor: { kind: "system", id: "workflow", name: "系统" },
          message,
          data: { runId: run.id, ticketId: run.ticketId },
        });
        return;
      }
    }
    const requirement = node.deliverables.find(
      (item) => item.required && item.type === "text",
    );
    if (requirement !== undefined && deliverableText === "") {
      const message =
        "Agent 未按约定输出「交付说明」，内容不写入交付物；可重试或人工提交";
      const blocked = await this.putInstance({
        ...instance,
        nodes: {
          ...instance.nodes,
          [node.id]: {
            ...state,
            status: "blocked",
            note: message,
          },
        },
      });
      await this.appendEvent(blocked, {
        nodeId: node.id,
        kind: "agent.output_invalid",
        actor: { kind: "system", id: "workflow", name: "系统" },
        message,
        data: { runId: run.id },
      });
      return;
    }
    if (
      requirement !== undefined &&
      deliverableText.length >= (requirement.minTextLength ?? 1) &&
      !this.nodeSubmissions(instance.id, node.id).some(
        (submission) => submission.note === `agent-run:${run.id}`,
      )
    ) {
      const record: WorkflowSubmission = {
        id: randomUUID(),
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        nodeId: node.id,
        requirementKey: requirement.key,
        requirementTitle: requirement.title,
        type: "text",
        value: deliverableText.slice(0, 100_000),
        artifacts: [],
        submittedBy:
          run.employeeId === undefined
            ? `agent:${run.agentProfileId}`
            : `employee:${run.employeeId}`,
        submittedByName: run.payload.employeeName ?? run.payload.profileName,
        onBehalfOf: node.executor.id,
        submittedAt: iso(this.now()),
        status: "submitted",
        note: `agent-run:${run.id}`,
      };
      await this.tables.submissions
        .put(record.id, workflowSubmissionSchema.parse(record))
        .then(() => record);
      await this.appendEvent(instance, {
        nodeId: node.id,
        kind: "agent.deliverable",
        actor: { kind: "system", id: "workflow", name: "系统" },
        message: `Agent 提交交付物：${requirement.title}`,
        data: { runId: run.id, requirementKey: requirement.key },
      });
    }
    const actor = { kind: "system" as const, id: "workflow", name: "系统" };
    const responsibleId = run.payload.responsibleId ?? run.createdBy;
    const member = this.options
      .team?.()
      ?.members(instance.workspaceId)
      .find((item) => item.userId === responsibleId);
    const runner: WorkflowActor = {
      kind: "user",
      id: responsibleId,
      name: member?.name ?? responsibleId,
      workspaceRole: member?.memberRole ?? "owner",
    };
    const settled = this.syncDeliverableStates({
      ...instance,
      nodes: {
        ...instance.nodes,
        [node.id]: {
          ...state,
          status: "ready",
          note: "Agent 运行完成，交付物待确认",
        },
      },
    });
    const settledState = settled.nodes[node.id]!;
    const canAutoComplete =
      node.reviewRequired === false &&
      this.missingDeliverables(node, settledState).length === 0;
    if (!canAutoComplete) {
      const awaitingReview = await this.putInstance({
        ...settled,
        nodes: {
          ...settled.nodes,
          [node.id]: {
            ...settledState,
            status: "ready",
            note: `Agent 运行完成，等待人工 Review（第 ${run.runSeq} 次）`,
          },
        },
      });
      await this.appendEvent(awaitingReview, {
        nodeId: node.id,
        kind: "agent.succeeded",
        actor,
        message: `Agent 运行完成，等待人工 Review（第 ${run.runSeq} 次）`,
        data: { runId: run.id },
      });
      await this.syncTaskStatus(
        awaitingReview.nodes[node.id]!.taskIds.at(-1),
        "review",
        "工作流 Agent 已提交交付物，等待人工 Review",
      );
      return;
    }
    const timestamp = iso(this.now());
    const updated = await this.putInstance(
      canAutoComplete
        ? this.refreshStatus({
            ...settled,
            nodes: {
              ...settled.nodes,
              [node.id]: {
                ...settledState,
                status: "completed",
                completedAt: timestamp,
                note: `Agent 自动完成（第 ${run.runSeq} 次）`,
              },
            },
          })
        : settled,
    );
    if (canAutoComplete) {
      await this.appendEvent(updated, {
        nodeId: node.id,
        kind: "node.completed",
        actor,
        message: `Agent 交付通过，自动完成节点：${node.name}`,
        data: { runId: run.id },
      });
      await this.settleNodeTasks(updated, node);
      await this.resumeParentIfCompleted(runner, updated);
      const advanced = await this.advance(runner, updated, node.id);
      await this.appendEvent(advanced, {
        nodeId: node.id,
        kind: "agent.succeeded",
        actor,
        message: `Agent 运行完成（第 ${run.runSeq} 次）`,
        data: { runId: run.id },
      });
      return;
    }
    await this.appendEvent(updated, {
      nodeId: node.id,
      kind: "agent.succeeded",
      actor,
      message: `Agent 运行完成（第 ${run.runSeq} 次）`,
      data: { runId: run.id },
    });
  }

  private incrementLoopVariables(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    edge: WorkflowEdge,
  ): void {
    if (edge.breakCondition === undefined) return;
    const referenced = new Set(
      [...edge.breakCondition.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)].map(
        (match) => match[0],
      ),
    );
    for (const variable of definition.graph.variables) {
      if (!referenced.has(variable.name)) continue;
      const value = instance.context[variable.name];
      if (typeof value === "number") {
        instance.context = {
          ...instance.context,
          [variable.name]: value + 1,
        };
      }
    }
  }

  private nodeCompleted(state: WorkflowNodeState): boolean {
    return state.status === "completed";
  }

  private normalizeDecisionBranches(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
  ): WorkflowInstance {
    const nodes = { ...instance.nodes };
    for (const node of definition.graph.nodes.filter(
      (item) => item.type === "decision",
    )) {
      const sourceState = nodes[node.id];
      if (sourceState?.status !== "completed") continue;
      const context = graphContext(instance);
      for (const edge of this.outgoingEdges(definition, node.id)) {
        if (edge.result !== undefined) continue;
        if (edge.condition !== undefined) {
          if (!safeEvaluate(edge.condition, context)) {
            this.skipUnmatchedBranch({ ...instance, nodes }, definition, edge);
          }
          continue;
        }
        if (!edge.default) continue;
        const hasMatchingCondition = definition.graph.edges.some(
          (candidate) =>
            candidate.from === node.id &&
            !candidate.default &&
            candidate.condition !== undefined &&
            safeEvaluate(candidate.condition, context),
        );
        if (hasMatchingCondition) {
          this.skipUnmatchedBranch({ ...instance, nodes }, definition, edge);
        }
      }
    }
    return { ...instance, nodes };
  }

  private refreshStatus(instance: WorkflowInstance): WorkflowInstance {
    const definition = this.tables.definitions.get(instance.definitionId);
    const normalized =
      definition === undefined
        ? instance
        : this.normalizeDecisionBranches(instance, definition);
    instance = normalized;
    const inconsistentCompletion = definition
      ? Object.entries(instance.nodes).some(([nodeId, state]) => {
          if (state.status !== "completed") return false;
          const incoming = this.incomingEdges(definition, nodeId);
          return (
            incoming.length > 0 &&
            !incoming.some((edge) =>
              ["completed", "skipped", "ready", "running"].includes(
                instance.nodes[edge.from]?.status ?? "",
              ),
            )
          );
        })
      : false;
    if (inconsistentCompletion) return { ...instance, status: "blocked" };
    const states = Object.values(instance.nodes);
    if (states.some((state) => state.status === "blocked")) {
      return { ...instance, status: "blocked" };
    }
    if (states.some((state) => state.status === "failed"))
      return { ...instance, status: "failed" };
    if (
      states.every((state) => ["completed", "skipped"].includes(state.status))
    ) {
      return { ...instance, status: "completed" };
    }
    if (
      states.some((state) =>
        ["ready", "running", "waiting"].includes(state.status),
      )
    ) {
      const pendingApproval = states.some((state) => {
        if (state.status !== "waiting") return false;
        const incoming = definition
          ? this.incomingEdges(definition, state.nodeId)
          : [];
        const reached = incoming.every((edge) =>
          ["completed", "skipped"].includes(
            instance.nodes[edge.from]?.status ?? "",
          ),
        );
        return (
          reached &&
          Object.values(state.approvals).some(
            (item) => item.status === "pending",
          )
        );
      });
      return { ...instance, status: pendingApproval ? "waiting" : "running" };
    }
    return { ...instance, status: "running" };
  }

  private canAct(
    actor: WorkflowActor,
    instance: WorkflowInstance,
    node: WorkflowNode,
  ): boolean {
    if (this.canSubmit(actor, node, instance)) return true;
    // 执行实例失效兜底改派到的 owner 与节点责任人同权。
    if (actor.kind !== "user") return false;
    const fallback = instance.nodes[node.id]?.executorFallback;
    return fallback !== undefined && fallback.id === actor.id;
  }

  private canSubmit(
    actor: WorkflowActor,
    node: WorkflowNode,
    instance: WorkflowInstance,
  ): boolean {
    if (actor.kind !== "user") return false;
    if (isManager(actor)) return true;
    if (node.type === "service" || node.type === "subworkflow") return false;
    // 项目角色执行人 / 审批人：该项目该角色当前任一成员都能操作节点（或签）。
    const roleIds = [
      ...(node.executor.kind === "role" ? [node.executor.id] : []),
      ...node.approvers
        .filter((approver) => approver.kind === "role")
        .map((approver) => approver.id),
    ];
    if (
      roleIds.some((roleId) =>
        this.actorHoldsProjectRole(actor, instance, roleId),
      )
    ) {
      return true;
    }
    const responsible = node.responsible;
    if (["agent", "employee"].includes(node.executor.kind)) {
      return responsible !== undefined && responsible.id === actor.id;
    }
    if (node.executor.kind === "user" && node.executor.id === actor.id)
      return true;
    return (
      responsible !== undefined &&
      responsible.kind === "user" &&
      responsible.id === actor.id
    );
  }

  private isAgentWorkerNode(node: WorkflowNode): boolean {
    return (
      node.type === "task" &&
      ["agent", "employee"].includes(node.executor.kind) &&
      node.execution === "task-worker"
    );
  }

  private canIntervene(actor: WorkflowActor, _node: WorkflowNode): boolean {
    return actor.kind === "user" && isManager(actor);
  }

  private async cancelActiveAgentRuns(
    instance: WorkflowInstance,
    node: WorkflowNode,
  ): Promise<void> {
    const agent = this.options.agent?.();
    if (agent === undefined) return;
    const activeRuns = agent
      .runs(instance.id, node.id)
      .filter((run) => isAgentRunActive(run));
    for (const run of activeRuns) {
      try {
        await agent.cancel(run.id);
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "conflict"
        ) {
          continue;
        }
        throw cause;
      }
    }
  }

  private requireTargetMember(
    instance: WorkflowInstance,
    userId: string,
    action: string,
  ): void {
    const team = this.options.team?.();
    const exists =
      team
        ?.members(instance.workspaceId)
        .some((member) => member.userId === userId) ?? false;
    if (!exists) {
      throw new WorkflowError(
        "invalid_input",
        `${action}目标 ${userId} 不是当前工作区成员`,
      );
    }
  }

  private nodeSubmissions(
    instanceId: string,
    nodeId: string,
  ): WorkflowSubmission[] {
    return this.submissions(instanceId, { nodeId });
  }

  private syncDeliverableStates(instance: WorkflowInstance): WorkflowInstance {
    const definition = this.tables.definitions.get(instance.definitionId);
    if (definition === undefined) return instance;
    const nodes = { ...instance.nodes };
    for (const node of definition.graph.nodes) {
      const state = nodes[node.id];
      if (node.deliverables.length === 0 || state === undefined) continue;
      const latest = new Map(
        (this.hasActiveAgentRun(instance.id, node.id)
          ? []
          : this.nodeSubmissions(instance.id, node.id)
        ).map((submission) => [submission.requirementKey, submission]),
      );
      const deliverables: Record<string, DeliverableState> = {};
      for (const requirement of node.deliverables) {
        const submission = latest.get(requirement.key);
        deliverables[requirement.key] = {
          requirementKey: requirement.key,
          status: submission?.status ?? "pending",
          ...(submission === undefined
            ? {}
            : {
                latestSubmissionId: submission.id,
                submittedAt: submission.submittedAt,
                submittedBy: submission.submittedBy,
                ...(submission.onBehalfOf === undefined
                  ? {}
                  : { onBehalfOf: submission.onBehalfOf }),
              }),
        };
      }
      nodes[node.id] = { ...state, deliverables };
    }
    return { ...instance, nodes };
  }

  private missingDeliverables(
    node: WorkflowNode,
    state: WorkflowNodeState,
  ): DeliverableRequirement[] {
    return node.deliverables.filter((requirement) => {
      if (!requirement.required) return false;
      const current = state.deliverables[requirement.key];
      return current === undefined || current.status !== "submitted";
    });
  }

  private hasActiveAgentRun(instanceId: string, nodeId: string): boolean {
    return (
      this.options
        .agent?.()
        ?.runs(instanceId, nodeId)
        .some((run) =>
          ["queued", "running", "waiting_input"].includes(run.status),
        ) === true
    );
  }

  artifactRoot(): string {
    if (this.options.artifactRoot !== undefined)
      return this.options.artifactRoot;
    const home = process.env.DSH_HOME;
    if (home === undefined || home === "")
      return resolve(".pluginmax/workflow-artifacts");
    return resolve(home, "pluginmax/workflow-artifacts");
  }

  private async storeArtifact(
    instance: WorkflowInstance,
    nodeId: string,
    submissionId: string,
    file: {
      readonly fileName: string;
      readonly mimeType: string;
      readonly data: Buffer;
    },
  ): Promise<WorkflowSubmission["artifacts"][number]> {
    const root = this.artifactRoot();
    const relativePath = join(
      instance.workspaceId,
      instance.id,
      nodeId,
      submissionId,
      file.fileName,
    );
    const lexical = resolve(root, relativePath);
    if (!isAbsolute(root) || !resolve(root).length) {
      throw new WorkflowError("invalid_input", "artifact root is invalid");
    }
    if (
      !lexical.startsWith(
        resolve(root) + (resolve(root).endsWith("/") ? "" : "/"),
      )
    ) {
      throw new WorkflowError(
        "forbidden",
        "artifact path escapes storage root",
      );
    }
    await mkdir(dirname(lexical), { recursive: true });
    const realRoot = await realpath(root);
    const realParent = await realpath(dirname(lexical));
    if (!realParent.startsWith(realRoot)) {
      throw new WorkflowError(
        "forbidden",
        "artifact path escapes storage root",
      );
    }
    await writeFile(lexical, file.data, { flag: "wx" });
    const realFile = await realpath(lexical);
    if (!realFile.startsWith(realRoot)) {
      throw new WorkflowError(
        "forbidden",
        "artifact path escapes storage root",
      );
    }
    return {
      id: randomUUID(),
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.data.byteLength,
      checksum: createHash("sha256").update(file.data).digest("hex"),
      storagePath: relative(realRoot, realFile),
    };
  }

  submitDeliverable(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      requirementKey: string;
      type: "text" | "link";
      value: string;
      note?: string | undefined;
    },
  ): Promise<WorkflowSubmission> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      const requirement = node.deliverables.find(
        (item) => item.key === input.requirementKey,
      );
      if (requirement === undefined)
        throw new WorkflowError(
          "not_found",
          "deliverable requirement not found",
        );
      if (requirement.type !== input.type)
        throw new WorkflowError(
          "invalid_input",
          "deliverable type does not match",
        );
      const state = instance.nodes[input.nodeId]!;
      const agentManualFallback =
        node.type === "task" &&
        ["agent", "employee"].includes(node.executor.kind) &&
        node.execution === "task-worker" &&
        state.status === "blocked";
      if (
        !["ready", "running", "waiting"].includes(state.status) &&
        !agentManualFallback
      )
        throw new WorkflowError(
          "conflict",
          "node is not accepting deliverables",
        );
      if (!this.canAct(actor, instance, node))
        throw new WorkflowError(
          "forbidden",
          "you cannot submit this deliverable",
        );
      const value = input.value.trim();
      if (
        input.type === "text" &&
        value.length < (requirement.minTextLength ?? 1)
      )
        throw new WorkflowError(
          "invalid_input",
          `this deliverable needs at least ${requirement.minTextLength ?? 1} characters`,
        );
      if (input.type === "link") {
        try {
          const url = new URL(value);
          if (!["http:", "https:"].includes(url.protocol))
            throw new Error("protocol");
        } catch {
          throw new WorkflowError(
            "invalid_input",
            "a valid http(s) link is required",
          );
        }
      }
      const onBehalfOf = ["agent", "employee"].includes(node.executor.kind)
        ? node.executor.id
        : undefined;
      const record: WorkflowSubmission = {
        id: randomUUID(),
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        nodeId: node.id,
        requirementKey: requirement.key,
        requirementTitle: requirement.title,
        type: input.type,
        value,
        artifacts: [],
        submittedBy: actor.id,
        submittedByName: actor.name ?? actor.id,
        ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
        submittedAt: iso(this.now()),
        status: "submitted",
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      const saved = await this.tables.submissions
        .put(record.id, workflowSubmissionSchema.parse(record))
        .then(() => record);
      const synced = this.syncDeliverableStates({
        ...instance,
        nodes: agentManualFallback
          ? {
              ...instance.nodes,
              [node.id]: {
                ...state,
                status: "ready",
                note: "人工代交交付物已提交，待确认",
              },
            }
          : instance.nodes,
      });
      await this.putInstance(synced);
      await this.appendEvent(instance, {
        nodeId: node.id,
        kind: "deliverable.submitted",
        actor,
        message: `提交交付物：${requirement.title}`,
        data: {
          requirementKey: requirement.key,
          submissionId: saved.id,
          ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
        },
      });
      if (
        this.shouldAutoCompleteHumanSubmission(node, synced.nodes[node.id]!)
      ) {
        // submitDeliverable 和 completeNode 共用同一把串行队列；
        // 延迟到本次提交落库后调度，避免在队列任务里自等待。
        setTimeout(() => {
          void this.completeNode(actor, {
            instanceId: instance.id,
            nodeId: node.id,
          }).catch(() => undefined);
        }, 0);
      }
      return saved;
    });
  }

  submitDeliverableFiles(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      requirementKey: string;
      note?: string | undefined;
      files: Array<{
        fileName: string;
        mimeType: string;
        data: Buffer;
      }>;
    },
  ): Promise<WorkflowSubmission> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      const requirement = node.deliverables.find(
        (item) => item.key === input.requirementKey,
      );
      if (requirement === undefined)
        throw new WorkflowError(
          "not_found",
          "deliverable requirement not found",
        );
      if (requirement.type !== "file")
        throw new WorkflowError(
          "invalid_input",
          "deliverable type does not match",
        );
      if (input.files.length === 0 || input.files.length > requirement.maxFiles)
        throw new WorkflowError(
          "invalid_input",
          `upload 1-${requirement.maxFiles} file${requirement.maxFiles === 1 ? "" : "s"}`,
        );
      const state = instance.nodes[input.nodeId]!;
      const agentManualFallback =
        node.type === "task" &&
        ["agent", "employee"].includes(node.executor.kind) &&
        node.execution === "task-worker" &&
        state.status === "blocked";
      if (
        !["ready", "running", "waiting"].includes(state.status) &&
        !agentManualFallback
      )
        throw new WorkflowError(
          "conflict",
          "node is not accepting deliverables",
        );
      if (!this.canAct(actor, instance, node))
        throw new WorkflowError(
          "forbidden",
          "you cannot submit this deliverable",
        );
      for (const file of input.files) {
        if (file.data.byteLength > 20 * 1024 * 1024)
          throw new WorkflowError(
            "invalid_input",
            "each file must be 20MB or smaller",
          );
        if (requirement.accept.length > 0) {
          const extension = file.fileName
            .slice(file.fileName.lastIndexOf("."))
            .toLowerCase();
          if (!requirement.accept.includes(extension))
            throw new WorkflowError(
              "invalid_input",
              `allowed file types: ${requirement.accept.join(", ")}`,
            );
        }
      }
      const submissionId = randomUUID();
      const artifacts = [];
      let bytes = 0;
      for (const file of input.files) {
        bytes += file.data.byteLength;
        artifacts.push(
          await this.storeArtifact(instance, node.id, submissionId, file),
        );
      }
      const existingBytes = this.submissions(instance.id).reduce(
        (total, submission) =>
          total +
          submission.artifacts.reduce(
            (sum, artifact) => sum + artifact.size,
            0,
          ),
        0,
      );
      if (existingBytes + bytes > 100 * 1024 * 1024)
        throw new WorkflowError(
          "conflict",
          "workflow artifact storage limit reached",
        );
      const onBehalfOf = ["agent", "employee"].includes(node.executor.kind)
        ? node.executor.id
        : undefined;
      const record: WorkflowSubmission = {
        id: submissionId,
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        nodeId: node.id,
        requirementKey: requirement.key,
        requirementTitle: requirement.title,
        type: "file",
        value: "",
        artifacts,
        submittedBy: actor.id,
        submittedByName: actor.name ?? actor.id,
        ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
        submittedAt: iso(this.now()),
        status: "submitted",
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      await this.tables.submissions.put(
        record.id,
        workflowSubmissionSchema.parse(record),
      );
      const synced = this.syncDeliverableStates({
        ...instance,
        nodes: agentManualFallback
          ? {
              ...instance.nodes,
              [node.id]: {
                ...state,
                status: "ready",
                note: "人工代交交付物已提交，待确认",
              },
            }
          : instance.nodes,
      });
      await this.putInstance(synced);
      await this.appendEvent(instance, {
        nodeId: node.id,
        kind: "deliverable.submitted",
        actor,
        message: `提交交付物：${requirement.title}`,
        data: {
          requirementKey: requirement.key,
          submissionId: record.id,
          fileNames: input.files.map((file) => file.fileName),
          ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
        },
      });
      if (
        this.shouldAutoCompleteHumanSubmission(node, synced.nodes[node.id]!)
      ) {
        // 文件提交同样先确保全部落盘，再进入下一个串行队列任务完成节点。
        setTimeout(() => {
          void this.completeNode(actor, {
            instanceId: instance.id,
            nodeId: node.id,
          }).catch(() => undefined);
        }, 0);
      }
      return record;
    });
  }

  rejectSubmission(
    actor: WorkflowActor,
    input: { submissionId: string; note?: string | undefined },
  ): Promise<WorkflowSubmission> {
    return this.enqueue(async () => {
      if (!isManager(actor))
        throw new WorkflowError(
          "forbidden",
          "workspace owner or admin is required",
        );
      const submission = this.tables.submissions.get(input.submissionId);
      if (submission === undefined)
        throw new WorkflowError("not_found", "submission not found");
      if (submission.status === "rejected")
        throw new WorkflowError("conflict", "submission was already rejected");
      const next: WorkflowSubmission = {
        ...submission,
        status: "rejected",
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      await this.tables.submissions.put(next.id, next);
      const instance = this.instance(submission.instanceId);
      if (instance !== undefined) {
        await this.putInstance(this.syncDeliverableStates(instance));
        await this.appendEvent(instance, {
          nodeId: submission.nodeId,
          kind: "deliverable.rejected",
          actor,
          message: `退回交付物：${submission.requirementTitle}`,
          data: { submissionId: submission.id },
        });
      }
      return next;
    });
  }

  completeNode(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      note?: string | undefined;
      force?: boolean | undefined;
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (node.type === "approval") {
        return this.decideApproval(actor, {
          instanceId: input.instanceId,
          nodeId: input.nodeId,
          decision: "approved",
          note: input.note,
        });
      }
      const synced = this.syncDeliverableStates(instance);
      const currentState = synced.nodes[input.nodeId]!;
      const agentIntervention =
        input.force === true && this.isAgentWorkerNode(node);
      if (currentState.status !== "ready" && !agentIntervention) {
        throw new WorkflowError(
          "conflict",
          currentState.status === "waiting"
            ? "node is waiting for upstream nodes"
            : "node is not actionable",
        );
      }
      if (agentIntervention) {
        if (!this.canIntervene(actor, node)) {
          throw new WorkflowError(
            "forbidden",
            "只有工作区负责人或管理员可以人工完成 Agent 节点",
          );
        }
      } else if (!this.canAct(actor, instance, node)) {
        throw new WorkflowError("forbidden", "you cannot complete this node");
      }
      const missing = this.missingDeliverables(node, currentState);
      if (missing.length > 0) {
        throw new WorkflowError(
          "missing_deliverables",
          `缺少 ${missing.length} 项必交交付物：${missing.map((item) => item.title).join("、")}`,
        );
      }
      if (agentIntervention) {
        await this.cancelActiveAgentRuns(instance, node);
      }
      const timestamp = iso(this.now());
      const interventionNote =
        input.note === undefined || input.note.trim() === ""
          ? agentIntervention
            ? "人工介入完成"
            : undefined
          : agentIntervention
            ? `人工介入完成：${input.note.trim()}`
            : input.note;
      instance.nodes[input.nodeId] = {
        ...currentState,
        status: "completed",
        completedAt: timestamp,
        note: interventionNote,
      };
      const saved = await this.putInstance(this.refreshStatus(instance));
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "node.completed",
        actor,
        message: agentIntervention
          ? `人工完成节点：${node.name}`
          : `完成节点：${node.name}`,
        data: {
          ...(agentIntervention ? { manual: true } : {}),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(node.deliverables.length === 0
            ? {}
            : {
                deliverableSnapshot: node.deliverables.map((requirement) => ({
                  key: requirement.key,
                  status: currentState.deliverables[requirement.key]?.status,
                  submissionId:
                    currentState.deliverables[requirement.key]
                      ?.latestSubmissionId,
                })),
              }),
          ...(["agent", "employee"].includes(node.executor.kind)
            ? { onBehalfOf: node.executor.id }
            : {}),
        },
      });
      await this.settleNodeTasks(saved, node);
      await this.resumeParentIfCompleted(actor, saved);
      return this.advance(actor, saved, node.id);
    });
  }

  cancelNode(
    actor: WorkflowActor,
    input: { instanceId: string; nodeId: string; note?: string | undefined },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (!this.isAgentWorkerNode(node)) {
        throw new WorkflowError(
          "invalid_input",
          "只有 Agent 或 AI伙伴节点支持人工取消",
        );
      }
      if (!this.canIntervene(actor, node)) {
        throw new WorkflowError(
          "forbidden",
          "只有工作区负责人或管理员可以取消 Agent 节点",
        );
      }
      const state = instance.nodes[input.nodeId]!;
      if (["completed", "skipped"].includes(state.status)) {
        throw new WorkflowError("conflict", "node is already closed");
      }
      if (state.status === "waiting") {
        throw new WorkflowError(
          "conflict",
          "node is waiting for upstream nodes",
        );
      }
      await this.cancelActiveAgentRuns(instance, node);
      const timestamp = iso(this.now());
      const cancelledNote =
        input.note === undefined || input.note.trim() === ""
          ? "人工取消"
          : `人工取消：${input.note.trim()}`;
      instance.nodes[input.nodeId] = {
        ...state,
        status: "skipped",
        completedAt: timestamp,
        note: cancelledNote,
      };
      const saved = await this.putInstance(this.refreshStatus(instance));
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "node.cancelled",
        actor,
        message: `人工取消节点：${node.name}`,
        data: {
          manual: true,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });
      await this.settleNodeTasks(saved, node, "cancelled");
      return saved;
    });
  }

  decideApproval(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      decision: "approved" | "rejected";
      note?: string | undefined;
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (node.type !== "approval")
        throw new WorkflowError("invalid_input", "node is not an approval");
      const state = instance.nodes[input.nodeId]!;
      if (state.status !== "ready" && state.status !== "waiting") {
        throw new WorkflowError("conflict", "approval is not actionable");
      }
      const serialQueueKey = this.serialQueueKey(state);
      if (state.status === "waiting") {
        if (state.enteredAt === undefined) {
          throw new WorkflowError(
            "conflict",
            "approval is waiting for upstream nodes",
          );
        }
        if (serialQueueKey === undefined) {
          if (
            !Object.values(state.approvals).some(
              (item) => item.status !== "pending",
            )
          ) {
            throw new WorkflowError(
              "conflict",
              "approval is waiting for upstream nodes",
            );
          }
        }
      }
      const approvalKey = Object.keys(state.approvals).find((key) =>
        this.matchesApprover(actor, state.approvals[key]!.approver, instance),
      );
      if (approvalKey === undefined && !isManager(actor)) {
        throw new WorkflowError("forbidden", "you are not an approver");
      }
      if (approvalKey === undefined) {
        throw new WorkflowError(
          "forbidden",
          "approval delegation does not grant implicit admin approval",
        );
      }
      if (state.approvals[approvalKey]!.status !== "pending") {
        throw new WorkflowError("conflict", "approval was already decided");
      }
      if (serialQueueKey !== undefined && approvalKey !== serialQueueKey) {
        throw new WorkflowError(
          "forbidden",
          "加签后需按顺序审批；当前还未轮到此账号",
        );
      }
      const timestamp = iso(this.now());
      instance.nodes[input.nodeId] = {
        ...state,
        approvals: {
          ...state.approvals,
          [approvalKey]: {
            ...state.approvals[approvalKey]!,
            status: input.decision === "approved" ? "approved" : "rejected",
            at: timestamp,
            note: input.note,
          },
        },
      };
      const nextState = instance.nodes[input.nodeId]!;
      const decisions = Object.values(nextState.approvals);
      const hasCountersign = this.isSerialCountersign(nextState);
      if (
        input.decision === "rejected" ||
        (hasCountersign &&
          decisions.every((item) => item.status === "approved")) ||
        (!hasCountersign &&
          node.approvalPolicy === "any" &&
          decisions.some((item) => item.status === "approved")) ||
        (!hasCountersign &&
          node.approvalPolicy === "all" &&
          decisions.every((item) => item.status === "approved"))
      ) {
        instance.nodes[input.nodeId] = {
          ...nextState,
          status: "completed",
          completedAt: timestamp,
          note:
            input.decision === "rejected"
              ? `rejected:${input.note ?? ""}`
              : input.note,
        };
      } else {
        instance.nodes[input.nodeId] = { ...nextState, status: "waiting" };
      }
      const saved = await this.putInstance(this.refreshStatus(instance));
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: `approval.${input.decision}`,
        actor,
        message: `${input.decision === "approved" ? "通过" : "否决"}审批：${node.name}`,
        ...(input.note === undefined ? {} : { data: { note: input.note } }),
      });
      await this.settleNodeTasks(saved, node, input.decision);
      await this.resumeParentIfCompleted(actor, saved);
      return this.advance(actor, saved, node.id);
    });
  }

  delegateApproval(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      toId: string;
      toName: string;
      note?: string | undefined;
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (node.type !== "approval")
        throw new WorkflowError("invalid_input", "node is not an approval");
      const state = instance.nodes[input.nodeId]!;
      const key = Object.keys(state.approvals).find((candidate) =>
        this.matchesApprover(
          actor,
          state.approvals[candidate]!.approver,
          instance,
        ),
      );
      if (key === undefined)
        throw new WorkflowError(
          "forbidden",
          "only the current approver can delegate",
        );
      if (state.approvals[key]!.status !== "pending") {
        throw new WorkflowError("conflict", "approval was already decided");
      }
      const serialQueueKey = this.serialQueueKey(state);
      if (serialQueueKey !== undefined && key !== serialQueueKey) {
        throw new WorkflowError(
          "forbidden",
          "加签后需按顺序审批；当前还未轮到此账号",
        );
      }
      if (input.toId === actor.id) {
        throw new WorkflowError(
          "invalid_input",
          "不能转交给自己；请选择其他成员",
        );
      }
      this.requireTargetMember(instance, input.toId, "转交");
      if (state.approvals[`${node.id}:${input.toId}`] !== undefined) {
        throw new WorkflowError("conflict", "target approver already exists");
      }
      const timestamp = iso(this.now());
      const newApprover: Approver = {
        kind: "user",
        id: input.toId,
        name: input.toName,
      };
      instance.nodes[input.nodeId] = {
        ...state,
        approvals: {
          ...state.approvals,
          [key]: {
            ...state.approvals[key]!,
            status: "delegated",
            at: timestamp,
            note: input.note,
          },
          [`${node.id}:${input.toId}`]: {
            approver: newApprover,
            status: "pending",
          },
        },
      };
      const saved = await this.putInstance(instance);
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "approval.delegated",
        actor,
        message: `转交审批：${node.name} → ${input.toName}`,
      });
      return this.syncNodeTasks(saved);
    });
  }

  countersignApproval(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      toId: string;
      toName: string;
      note?: string | undefined;
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (node.type !== "approval")
        throw new WorkflowError("invalid_input", "node is not an approval");
      const state = instance.nodes[input.nodeId]!;
      const initiatorKey = Object.keys(state.approvals).find((candidate) => {
        const approval = state.approvals[candidate]!;
        return (
          approval.status === "pending" &&
          this.matchesApprover(actor, approval.approver, instance)
        );
      });
      if (initiatorKey === undefined) {
        throw new WorkflowError(
          "forbidden",
          "only the current pending approver can countersign",
        );
      }
      if (input.toId === actor.id) {
        throw new WorkflowError(
          "invalid_input",
          "不能加签给自己；请选择其他成员",
        );
      }
      this.requireTargetMember(instance, input.toId, "加签");
      if (state.status !== "waiting" && state.status !== "ready") {
        throw new WorkflowError("conflict", "approval is not open");
      }
      const key = `${node.id}:${input.toId}`;
      if (state.approvals[key]?.status !== "delegated") {
        if (state.approvals[key] !== undefined) {
          throw new WorkflowError("conflict", "该成员已在当前审批中");
        }
      }
      const serialQueueKey = this.serialQueueKey(state);
      if (serialQueueKey !== undefined && initiatorKey !== serialQueueKey) {
        throw new WorkflowError(
          "forbidden",
          "加签后需按顺序审批；当前还未轮到此账号",
        );
      }
      const countersignApproval = {
        approver: { kind: "user", id: input.toId, name: input.toName },
        status: "pending",
        source: "countersign",
        note: input.note,
      } as const;
      const queuedApprovals: WorkflowNodeState["approvals"] = {};
      let inserted = false;
      for (const [approvalKey, approval] of Object.entries(state.approvals)) {
        if (approvalKey === key) continue;
        if (approvalKey === initiatorKey) {
          queuedApprovals[key] = countersignApproval;
          inserted = true;
        }
        queuedApprovals[approvalKey] = approval;
      }
      if (!inserted) {
        queuedApprovals[key] = countersignApproval;
      }
      instance.nodes[input.nodeId] = {
        ...state,
        approvals: queuedApprovals,
      };
      const saved = await this.putInstance(instance);
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "approval.countersigned",
        actor,
        message: `加签审批：${node.name} + ${input.toName}`,
      });
      return this.syncNodeTasks(saved);
    });
  }

  resolveDecision(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      nodeId: string;
      values: Record<string, string | number | boolean>;
      note?: string | undefined;
    },
  ): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const { instance, node } = this.requireNode(
        this.instance(input.instanceId),
        input.nodeId,
      );
      if (node.type !== "decision")
        throw new WorkflowError("invalid_input", "node is not a decision");
      const state = instance.nodes[input.nodeId]!;
      if (!["ready", "waiting"].includes(state.status)) {
        throw new WorkflowError("conflict", "decision is not actionable");
      }
      const timestamp = iso(this.now());
      instance.context = { ...instance.context, ...input.values };
      instance.nodes[input.nodeId] = {
        ...state,
        status: "completed",
        completedAt: timestamp,
        note: input.note,
      };
      const saved = await this.putInstance(instance);
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "decision.resolved",
        actor,
        message: `完成判断节点：${node.name}`,
        data: input.values,
      });
      return this.advance(actor, saved, node.id);
    });
  }

  async setDefinitionStatus(
    actor: WorkflowActor,
    input: {
      workspaceId: string;
      definitionId: string;
      status: "active" | "disabled" | "archived";
    },
  ): Promise<WorkflowDefinition> {
    if (!isManager(actor)) {
      throw new WorkflowError(
        "forbidden",
        "workspace owner or admin is required",
      );
    }
    return this.enqueue(async () => {
      const definition = this.definition(input.definitionId);
      if (definition === undefined) {
        throw new WorkflowError("not_found", "workflow definition not found");
      }
      const timestamp = iso(this.now());
      if (input.status === "active") {
        for (const item of this.sharedDefinitions().filter(
          (candidate) =>
            candidate.key === definition.key &&
            candidate.status === "active" &&
            candidate.id !== definition.id,
        )) {
          await this.tables.definitions.put(item.id, {
            ...item,
            status: "archived",
            updatedAt: timestamp,
          });
        }
      }
      const next = {
        ...definition,
        status: input.status,
        updatedAt: timestamp,
      };
      await this.tables.definitions.put(
        next.id,
        workflowDefinitionSchema.parse(next),
      );
      await this.appendEvent(
        {
          id: next.id,
          workspaceId: next.workspaceId,
        },
        {
          kind: `definition.${input.status}`,
          actor,
          message: `${
            input.status === "active"
              ? "启用"
              : input.status === "disabled"
                ? "停用"
                : "归档"
          }模板：${next.name} v${next.version}`,
        },
      );
      return next;
    });
  }

  cancel(actor: WorkflowActor, instanceId: string): Promise<WorkflowInstance> {
    return this.enqueue(async () => {
      const instance = this.instance(instanceId);
      if (instance === undefined)
        throw new WorkflowError("not_found", "workflow instance not found");
      if (
        !isManager(actor) &&
        instance.createdBy !== actor.id &&
        actor.kind !== "agent"
      ) {
        throw new WorkflowError(
          "forbidden",
          "only creator or manager can cancel",
        );
      }
      if (["completed", "cancelled"].includes(instance.status)) {
        throw new WorkflowError("conflict", "workflow is already closed");
      }
      const timestamp = iso(this.now());
      for (const [nodeId, state] of Object.entries(instance.nodes)) {
        if (["completed", "skipped"].includes(state.status)) continue;
        instance.nodes[nodeId] = {
          ...state,
          status: "skipped",
          completedAt: timestamp,
        };
      }
      instance.status = "cancelled";
      const saved = await this.putInstance(instance);
      await this.appendEvent(saved, {
        kind: "instance.cancelled",
        actor,
        message: `取消工作流：${instance.title}`,
      });
      if (this.taskBridge() !== undefined) {
        for (const state of Object.values(saved.nodes)) {
          for (const taskId of state.taskIds) {
            try {
              await this.taskBridge()?.settle(
                this.taskSystemActor(),
                taskId,
                "cancelled",
              );
            } catch {
              // 工作流取消是权威结论；投影可在任务侧通过刷新收敛。
            }
          }
        }
      }
      return saved;
    });
  }

  private async resumeParentIfCompleted(
    actor: WorkflowActor,
    child: WorkflowInstance,
  ): Promise<void> {
    if (
      child.parentInstanceId === undefined ||
      child.parentNodeId === undefined
    )
      return;
    if (
      child.status !== "completed" &&
      child.status !== "failed" &&
      child.status !== "cancelled"
    )
      return;
    const parent = this.instance(child.parentInstanceId);
    const definition =
      parent === undefined
        ? undefined
        : this.tables.definitions.get(parent.definitionId);
    const node = definition?.graph.nodes.find(
      (item) => item.id === child.parentNodeId,
    );
    if (parent === undefined || node === undefined) return;
    const state = parent.nodes[child.parentNodeId]!;
    if (state.status !== "running" || state.childInstanceId !== child.id)
      return;
    if (child.status === "completed") {
      parent.nodes[child.parentNodeId] = {
        ...state,
        status: "completed",
        completedAt: iso(this.now()),
        note: "子流程已完成",
      };
      const saved = await this.putInstance(parent);
      await this.appendEvent(saved, {
        nodeId: node.id,
        kind: "subworkflow.completed",
        actor,
        message: `子流程完成：${child.title}`,
      });
      await this.advance(actor, saved, node.id);
      return;
    }
    parent.nodes[child.parentNodeId] = {
      ...state,
      status: "blocked",
      note: child.status === "failed" ? "子流程失败" : "子流程已取消",
    };
    const saved = await this.putInstance(parent);
    await this.appendEvent(saved, {
      nodeId: node.id,
      kind: "subworkflow.blocked",
      actor,
      message: `子流程${child.status === "failed" ? "失败" : "取消"}：${child.title}`,
    });
    await this.putInstance(this.refreshStatus(saved));
  }

  private requireNode(
    instance: WorkflowInstance | undefined,
    nodeId: string,
  ): {
    instance: WorkflowInstance;
    node: WorkflowNode;
  } {
    if (instance === undefined)
      throw new WorkflowError("not_found", "workflow instance not found");
    const definition = this.tables.definitions.get(instance.definitionId);
    const node = definition?.graph.nodes.find((item) => item.id === nodeId);
    const state = instance.nodes[nodeId];
    if (definition === undefined || node === undefined || state === undefined) {
      throw new WorkflowError("not_found", "workflow node not found");
    }
    return { instance, node };
  }
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): WorkflowActor {
  const headers = request.headers;
  if (
    headers.origin !== undefined &&
    !sameOrigin(headers.origin, headers.host)
  ) {
    throw new WorkflowError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name) =>
      name === "authorization" ? (headers.authorization ?? null) : null,
  });
  if (token === undefined)
    throw new WorkflowError("unauthorized", "bearer token is required");
  const principal = team.resolveToken(token);
  if (principal === undefined)
    throw new WorkflowError("unauthorized", "invalid bearer token");
  const member = team
    .members(workspaceId)
    .find((candidate) => candidate.userId === principal.userId);
  if (member === undefined && principal.role !== "admin") {
    throw new WorkflowError("forbidden", "workspace member role is required");
  }
  return {
    kind: "user",
    id: principal.userId,
    globalRole: principal.role,
    ...(member?.name === undefined ? {} : { name: member.name }),
    ...(member?.memberRole === undefined
      ? {}
      : { workspaceRole: member.memberRole }),
  };
}

function errorStatus(code: WorkflowError["code"]): number {
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "conflict") return 409;
  if (code === "missing_deliverables") return 409;
  if (code === "method_not_allowed") return 405;
  return 400;
}

async function runHandler(
  operation: () => Promise<void>,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof WorkflowError) {
      sendJson(response, errorStatus(error.code), {
        ok: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "workflow operation failed" },
    });
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request);
  } catch {
    throw new WorkflowError("invalid_input", "valid JSON body is required");
  }
}

interface MultipartBody {
  fields: Map<string, string>;
  files: Array<{
    fieldName: string;
    fileName: string;
    mimeType: string;
    data: Buffer;
  }>;
}

async function readMultipart(
  request: IncomingMessage,
  maxBytes = 22 * 1024 * 1024,
): Promise<MultipartBody> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string")
    throw new WorkflowError("invalid_input", "multipart body is required");
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const delimiter = `--${boundary?.[1] ?? boundary?.[2]?.trim() ?? ""}`;
  if (delimiter === "--")
    throw new WorkflowError("invalid_input", "multipart boundary is required");
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new WorkflowError("invalid_input", "upload is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes)
      throw new WorkflowError("invalid_input", "upload is too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const result: MultipartBody = { fields: new Map(), files: [] };
  const decoder = new TextDecoder();
  let position = body.indexOf(delimiter);
  while (position >= 0) {
    const lineEnd = body.indexOf("\r\n", position);
    if (lineEnd < 0) break;
    const start = lineEnd + 2;
    const next = body.indexOf(delimiter, start);
    if (next < 0) break;
    const part = body.subarray(start, Math.max(start, next - 2));
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const headers = decoder
        .decode(part.subarray(0, headerEnd))
        .split(/\r\n/)
        .filter(Boolean);
      const disposition = headers.find((item) =>
        item.toLowerCase().startsWith("content-disposition:"),
      );
      const nameMatch = /name="([^"]*)"/.exec(disposition ?? "");
      const fileMatch = /filename="([^"]*)"/.exec(disposition ?? "");
      const data = part.subarray(headerEnd + 4);
      const contentTypeHeader = headers
        .find((item) => item.toLowerCase().startsWith("content-type:"))
        ?.split(":")
        .slice(1)
        .join(":")
        .trim();
      const fieldName = nameMatch?.[1]?.trim() ?? "";
      const uploadedName = fileMatch?.[1];
      if (uploadedName !== undefined && uploadedName !== "") {
        let fileName = uploadedName.replaceAll("\\", "/");
        fileName = fileName.slice(fileName.lastIndexOf("/") + 1).trim();
        if (
          fileName === "" ||
          fileName.startsWith(".") ||
          ["\u0000", "\r", "\n"].some((character) =>
            fileName.includes(character),
          )
        )
          throw new WorkflowError(
            "invalid_input",
            "an uploaded file has an invalid name",
          );
        if (fileName.length > 255) fileName = fileName.slice(-255);
        result.files.push({
          fieldName,
          fileName,
          mimeType: contentTypeHeader || "application/octet-stream",
          data,
        });
      } else if (fieldName !== "") {
        result.fields.set(fieldName, decoder.decode(data));
      }
    }
    position = next;
  }
  return result;
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

function requireWorkspace(request: IncomingMessage): string {
  const value = queryParam(request, "workspaceId");
  if (value === undefined || value === "") {
    throw new WorkflowError("invalid_input", "workspaceId is required");
  }
  return value;
}

const actionBodySchema = z
  .object({
    instanceId: z.string().min(1),
    nodeId: z.string().min(1),
  })
  .loose();

export function createWorkflowRoutes(
  service: WorkflowService,
  team: () => TeamServiceLike | undefined,
  dependencies: {
    readonly agent?: () => AgentServiceLike | undefined;
    readonly employees?: () => EmployeeServiceLike | undefined;
    readonly teammates?: () => WorkflowTeammateServiceLike | undefined;
    readonly workspaces?: () => WorkflowWorkspaceRegistryLike | undefined;
  } = {},
): WebRouteLike[] {
  const requireTeam = (): TeamServiceLike => {
    const value = team();
    if (value === undefined)
      throw new WorkflowError("not_found", "identity service is unavailable");
    return value;
  };
  /** 列表/详情统一带上项目名，前端不再依赖"当前范围内的项目清单"解析。 */
  const projectNameOf = (workspaceId: string): string | undefined =>
    workflowWorkspaceName(dependencies.workspaces?.()?.get(workspaceId));
  /** 节点执行者换成可读名字（Agent Profile 名 / Teammate 名），解析不到保留原始 id。 */
  const enrichExecutorLabels = <T extends WorkflowDefinition>(
    definition: T,
    workspaceId: string,
  ): T => {
    const nodes = definition.graph.nodes.map((node) => {
      const label = resolveWorkflowExecutorLabel({
        executor: node.executor,
        workspaceId,
        agent: dependencies.agent?.(),
        employees: dependencies.employees?.(),
        teammates: dependencies.teammates?.(),
        workspaces: dependencies.workspaces?.(),
      });
      if (label === undefined || label === node.executor.label) return node;
      return { ...node, executor: { ...node.executor, label } };
    });
    return { ...definition, graph: { ...definition.graph, nodes } };
  };
  const routes: WebRouteLike[] = [
    {
      kind: "exact",
      path: "/api/collab/workflow/definitions",
      handler: (request, response) => {
        assertMethod(request, response, "GET");
        const workspaceId = requireWorkspace(request);
        const actor = browserActor(requireTeam(), request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          definitions: service
            .sharedDefinitions()
            .map((definition) => enrichExecutorLabels(definition, workspaceId)),
          actor,
        });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/definitions/validate",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({ workspaceId: z.string(), sourceMd: z.string() })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        if (!isManager(actor))
          throw new WorkflowError(
            "forbidden",
            "workspace owner or admin is required",
          );
        const result = service.validate(body.sourceMd);
        sendJson(response, 200, { ok: true, ...result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/definitions/import",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            workspaceId: z.string(),
            sourceMd: z.string(),
            activate: z.boolean().default(true),
          })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const definition = await service.importDefinition(actor, body);
        sendJson(response, 201, { ok: true, definition });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/instances",
      handler: (request, response) => {
        assertMethod(request, response, "GET");
        const workspaceId = requireWorkspace(request);
        const actor = browserActor(requireTeam(), request, workspaceId);
        const sessionId = queryParam(request, "sessionId");
        sendJson(response, 200, {
          ok: true,
          instances: service
            .instances(
              workspaceId,
              sessionId === undefined ? {} : { sessionId },
            )
            .map((instance) => {
              const workspaceTitle = projectNameOf(instance.workspaceId);
              // 列表「更新」行需要最后一次操作人：从事件流派生，只读展示，不落库。
              const lastEvent = service.events(instance.id).at(-1);
              return {
                ...instance,
                ...(workspaceTitle === undefined ? {} : { workspaceTitle }),
                ...(lastEvent === undefined
                  ? {}
                  : {
                      updatedBy: lastEvent.actorId,
                      updatedByName: lastEvent.actorName,
                    }),
              };
            }),
          actor,
        });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/instances/detail",
      handler: async (request, response) => {
        assertMethod(request, response, "GET");
        const workspaceId = requireWorkspace(request);
        const actor = browserActor(requireTeam(), request, workspaceId);
        const instanceId = queryParam(request, "instanceId");
        if (instanceId === undefined)
          throw new WorkflowError("invalid_input", "instanceId is required");
        const preSyncInstance = service.instanceView(instanceId);
        if (
          preSyncInstance === undefined ||
          preSyncInstance.workspaceId !== workspaceId
        ) {
          throw new WorkflowError("not_found", "workflow instance not found");
        }
        await service.reconcileTaskProjections(instanceId);
        const instance = service.instanceView(instanceId);
        if (instance === undefined) {
          throw new WorkflowError("not_found", "workflow instance not found");
        }
        await service.reconcileAgentRunProjections(instanceId);
        const agent = dependencies.agent?.();
        const agentRuns = agent?.runs(instanceId) ?? [];
        const workspaceTitle = projectNameOf(instance.workspaceId);
        const rawDefinition = service.definition(instance.definitionId);
        sendJson(response, 200, {
          ok: true,
          instance:
            workspaceTitle === undefined
              ? instance
              : { ...instance, workspaceTitle },
          definition:
            rawDefinition === undefined
              ? undefined
              : enrichExecutorLabels(rawDefinition, instance.workspaceId),
          submissions: service.submissions(instanceId),
          events: service.events(instanceId),
          agentRuns,
          actor,
        });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/agent-runs/dispatch",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            workspaceId: z.string().min(1),
            instanceId: z.string().min(1),
            nodeId: z.string().min(1),
          })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const instance = await service.dispatchAgentNode(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          trigger: "manual-dispatch",
        });
        sendJson(response, 200, { ok: true, instance });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/agent-runs/cancel",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({ workspaceId: z.string().min(1), runId: z.string().min(1) })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const instance = await service.cancelAgentRun(actor, body.runId);
        sendJson(response, 200, { ok: true, instance });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/agent-runs/retry",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({ workspaceId: z.string().min(1), runId: z.string().min(1) })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const instance = await service.retryAgentRun(actor, body.runId);
        sendJson(response, 200, { ok: true, instance });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/deliverables/text",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            instanceId: z.string().min(1),
            nodeId: z.string().min(1),
            requirementKey: z.string().min(1),
            value: z.string().max(100_000),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const submission = await service.submitDeliverable(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          requirementKey: body.requirementKey,
          type: "text",
          value: body.value,
          note: body.note,
        });
        sendJson(response, 201, { ok: true, submission });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/deliverables/link",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            instanceId: z.string().min(1),
            nodeId: z.string().min(1),
            requirementKey: z.string().min(1),
            value: z.string().min(1).max(2_048),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const submission = await service.submitDeliverable(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          requirementKey: body.requirementKey,
          type: "link",
          value: body.value,
          note: body.note,
        });
        sendJson(response, 201, { ok: true, submission });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/deliverables/file",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const multipart = await readMultipart(request);
        const instanceId = multipart.fields.get("instanceId") ?? "";
        const nodeId = multipart.fields.get("nodeId") ?? "";
        const requirementKey = multipart.fields.get("requirementKey") ?? "";
        const note = multipart.fields.get("note") || undefined;
        if (instanceId === "" || nodeId === "" || requirementKey === "")
          throw new WorkflowError("invalid_input", "missing upload fields");
        const instance = service.instance(instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const submission = await service.submitDeliverableFiles(actor, {
          instanceId,
          nodeId,
          requirementKey,
          note,
          files: multipart.files.map((file) => ({
            fileName: file.fileName,
            mimeType: file.mimeType,
            data: file.data,
          })),
        });
        sendJson(response, 201, { ok: true, submission });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/deliverables/download",
      handler: async (request, response) => {
        assertMethod(request, response, "GET");
        const submissionId = queryParam(request, "submissionId");
        const artifactId = queryParam(request, "artifactId");
        if (submissionId === undefined)
          throw new WorkflowError("invalid_input", "submissionId is required");
        const record = service.submission(submissionId);
        if (record === undefined)
          throw new WorkflowError("not_found", "submission not found");
        browserActor(requireTeam(), request, record.workspaceId);
        const artifact =
          record.artifacts.find((item) => item.id === artifactId) ??
          record.artifacts[0];
        if (artifact === undefined)
          throw new WorkflowError("not_found", "artifact not found");
        const root = resolve(service.artifactRoot());
        const target = resolve(root, artifact.storagePath);
        const realRoot = await realpath(root);
        const realFile = await realpath(target);
        if (!realFile.startsWith(realRoot))
          throw new WorkflowError(
            "forbidden",
            "artifact path escapes storage root",
          );
        const data = await readFile(realFile);
        const asciiName = artifact.fileName
          .replace(/[^\x20-\x7e]/g, "_")
          .replace(/"/g, "_");
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(data.byteLength),
          "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        response.end(data);
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/deliverables/reject",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            submissionId: z.string().min(1),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const record = service.submission(body.submissionId);
        if (record === undefined)
          throw new WorkflowError("not_found", "submission not found");
        const actor = browserActor(requireTeam(), request, record.workspaceId);
        const submission = await service.rejectSubmission(actor, body);
        sendJson(response, 200, { ok: true, submission });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/instances/start",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            workspaceId: z.string(),
            definitionId: z.string().optional(),
            title: z.string().min(1).max(160),
            sessionId: z.string().optional(),
            relatedSessionIds: z.array(z.string()).default([]),
            context: z
              .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean()]),
              )
              .default({}),
            // 角色节点在实例创建时可选指定具体执行人；未指定则保持指派给项目角色。
            assignees: z
              .record(
                z.string().min(1).max(120),
                z.object({
                  kind: z.enum(["user", "agent"]),
                  id: z.string().min(1).max(160),
                  name: z.string().min(1).max(160).optional(),
                }),
              )
              .default({}),
          })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const instance = await service.startInstance(actor, body);
        sendJson(response, 201, { ok: true, instance });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/nodes/complete",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema.parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.completeNode(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          note: typeof body.note === "string" ? body.note : undefined,
          force: body.force === true,
        });
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/nodes/cancel",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema.parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.cancelNode(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          note: typeof body.note === "string" ? body.note : undefined,
        });
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/approvals/decide",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema
          .extend({
            decision: z.enum(["approved", "rejected"]),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.decideApproval(actor, body);
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/approvals/delegate",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema
          .extend({
            toId: z.string().min(1),
            toName: z.string().min(1),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.delegateApproval(actor, body);
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/approvals/countersign",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema
          .extend({
            toId: z.string().min(1),
            toName: z.string().min(1),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.countersignApproval(actor, body);
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/decisions/resolve",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = actionBodySchema
          .extend({
            values: z.record(
              z.string(),
              z.union([z.string(), z.number(), z.boolean()]),
            ),
            note: z.string().max(500).optional(),
          })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.resolveDecision(actor, {
          instanceId: body.instanceId,
          nodeId: body.nodeId,
          values: body.values,
          note: body.note,
        });
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/instances/cancel",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({ instanceId: z.string() })
          .parse(await readBody(request));
        const instance = service.instance(body.instanceId);
        if (instance === undefined)
          throw new WorkflowError("not_found", "workflow instance not found");
        const actor = browserActor(
          requireTeam(),
          request,
          instance.workspaceId,
        );
        const result = await service.cancel(actor, body.instanceId);
        sendJson(response, 200, { ok: true, instance: result });
      },
    },
    {
      kind: "exact",
      path: "/api/collab/workflow/definitions/status",
      handler: async (request, response) => {
        assertMethod(request, response, "POST");
        const body = z
          .object({
            workspaceId: z.string(),
            definitionId: z.string(),
            status: z.enum(["active", "disabled", "archived"]),
          })
          .parse(await readBody(request));
        const actor = browserActor(requireTeam(), request, body.workspaceId);
        const definition = await service.setDefinitionStatus(actor, body);
        sendJson(response, 200, { ok: true, definition });
      },
    },
  ];

  return routes.map((route) => ({
    ...route,
    handler: (request: IncomingMessage, response: ServerResponse) =>
      runHandler(async () => route.handler(request, response), response),
  }));
}

function assertMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
): void {
  if (request.method !== method) {
    throw new WorkflowError("method_not_allowed", "method not allowed");
  }
}

function agentActor(exec: ToolExecLike): WorkflowActor {
  return {
    kind: "agent",
    id: exec.session?.id ?? "agent",
    name: "Agent",
    sessionId: exec.session?.id,
    workspaceRole: "member",
  };
}

async function agentWorkflowAction(
  service: WorkflowService,
  exec: ToolExecLike,
  input: string,
): Promise<string> {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const command = parts.shift();
  const actor = agentActor(exec);
  if (command === "list") {
    const workspaceId = parts.shift();
    if (workspaceId === undefined)
      throw new WorkflowError(
        "invalid_input",
        "usage: /workflow list <workspaceId>",
      );
    return (
      service
        .instances(workspaceId)
        .slice(0, 20)
        .map(
          (instance) => `${instance.title}\t${instance.status}\t${instance.id}`,
        )
        .join("\n") || "no workflow instances"
    );
  }
  if (command === undefined)
    throw new WorkflowError(
      "invalid_input",
      "usage: /workflow <list|complete|approve|reject> ...",
    );
  if (command === "complete" || command === "approve" || command === "reject") {
    const [instanceId, nodeId] = parts;
    if (instanceId === undefined || nodeId === undefined) {
      throw new WorkflowError(
        "invalid_input",
        `usage: /workflow ${command} <instanceId> <nodeId>`,
      );
    }
    const result =
      command === "complete"
        ? await service.completeNode(actor, { instanceId, nodeId })
        : await service.decideApproval(actor, {
            instanceId,
            nodeId,
            decision: command === "reject" ? "rejected" : "approved",
          });
    return `updated ${result.title}: ${nodeId} ${result.status}`;
  }
  throw new WorkflowError(
    "invalid_input",
    `unknown workflow action: ${command}`,
  );
}

export async function apply(
  ctx: WorkflowContext,
): Promise<void | (() => void)> {
  const domain = await ctx.storageDomain.open(workflowDomainSpec);
  let injectedTeam: TeamServiceLike | undefined;
  let injectedTasks: WorkflowTaskBridge | undefined;
  let injectedWorkspaces: WorkflowWorkspaceRegistryLike | undefined;
  let injectedContext: WorkflowContextServiceLike | undefined;
  const service = new WorkflowService(
    {
      definitions: domain.table("definitions"),
      instances: domain.table("instances"),
      events: domain.table("events"),
      submissions: domain.table("submissions"),
    },
    {
      team: () => injectedTeam,
      agent: () => ctx.get("collabAgent"),
      employee: () => ctx.get("collabEmployee"),
      tasks: () => injectedTasks,
      workspaces: () => injectedWorkspaces,
      context: () => injectedContext,
      teammateRuntime: () => ctx.get("collabTeammateRuntime"),
      teammates: () => ctx.get("collabTeammates"),
      roles: () => ctx.get("collabAssignment"),
      principals: () => ctx.get("collabPrincipal"),
      principalRuntime: () => ctx.get("collabPrincipalRuntime"),
      onEvent: (event) => {
        try {
          (
            ctx as {
              emit?: (name: string, payload?: unknown) => void;
            }
          ).emit?.("collab/workflow-changed", {
            instanceId: event.instanceId,
            workspaceId: event.workspaceId,
            kind: event.kind,
          });
          if (event.kind === "node.completed" && event.nodeId !== undefined) {
            const instance = service.instance(event.instanceId);
            if (instance !== undefined) {
              const node = instance.nodes[event.nodeId];
              const definition = service.definition(instance.definitionId);
              const nodeDefinition = definition?.graph.nodes.find(
                (item) => item.id === event.nodeId,
              );
              void ctx
                .get("collabMemory")
                ?.ingestSource({
                  sourceType: "workflow",
                  sourceId: instance.id,
                  version: event.at,
                  workspaceId: instance.workspaceId,
                  payload: {
                    title: `${instance.title} · ${nodeDefinition?.name ?? event.nodeId}`,
                    content: [
                      nodeDefinition?.description ?? "",
                      "",
                      "## 节点事件",
                      ...service
                        .events(instance.id)
                        .filter((item) => item.nodeId === event.nodeId)
                        .map((item) => `${item.kind}: ${item.message ?? ""}`),
                    ]
                      .filter(Boolean)
                      .join("\n"),
                    actorPrincipalId: instance.createdBy,
                    projectId: instance.workspaceId,
                    occurredAt: event.at,
                    sourceRefs: [
                      { type: "workflow", id: instance.id },
                      ...(node?.taskIds.at(-1) === undefined
                        ? []
                        : [
                            {
                              type: "task" as const,
                              id: node.taskIds.at(-1)!,
                            },
                          ]),
                    ],
                    metadata: {
                      nodeId: event.nodeId,
                      status: node?.status ?? "unknown",
                    },
                  },
                })
                .catch(() => undefined);
            }
          }
        } catch {
          // Domain events are best-effort.
        }
      },
    },
  );
  ctx.provide("collabWorkflow", service);
  ctx.effect(() => () => void domain.close());
  ctx.inject(["collabContext"], (child) => {
    injectedContext = child.collabContext;
    const dispose = child.collabContext.registerAdapter({
      scene: "workflow-node",
      resolve: async (input: {
        readonly workspaceId?: string;
        readonly objectId: string;
        readonly agentPrincipalId: string;
        readonly actorPrincipalId: string;
      }) => {
        const [instanceId, nodeId] = input.objectId.split(":", 2);
        const instance =
          instanceId === undefined ? undefined : service.instance(instanceId);
        const node =
          instance === undefined || nodeId === undefined
            ? undefined
            : instance.nodes[nodeId];
        return {
          allowed:
            instance !== undefined &&
            node !== undefined &&
            (input.workspaceId === undefined ||
              input.workspaceId === instance.workspaceId),
          ...(instance === undefined
            ? {}
            : { workspaceId: instance.workspaceId }),
          sceneRevision: instance?.updatedAt ?? new Date(0).toISOString(),
          sourceRefs:
            instance === undefined
              ? []
              : [
                  { type: "workflow" as const, id: instance.id },
                  ...(node?.taskIds.at(-1) === undefined
                    ? []
                    : [
                        {
                          type: "task" as const,
                          id: node.taskIds.at(-1)!,
                        },
                      ]),
                ],
        };
      },
      loadFacts: async (input: {
        readonly workspaceId?: string;
        readonly objectId: string;
        readonly agentPrincipalId: string;
        readonly asOf: string;
      }) => {
        const [instanceId, nodeId] = input.objectId.split(":", 2);
        const instance =
          instanceId === undefined ? undefined : service.instance(instanceId);
        if (instance === undefined || nodeId === undefined) {
          throw new WorkflowError("not_found", "workflow node not found");
        }
        const node = instance.nodes[nodeId];
        if (node === undefined) {
          throw new WorkflowError("not_found", "workflow node not found");
        }
        const definition = service.definition(instance.definitionId);
        const nodeDefinition = definition?.graph.nodes.find(
          (item) => item.id === nodeId,
        );
        const text = [
          `# 工作流 ${instance.title}`,
          `节点: ${nodeDefinition?.name ?? nodeId}`,
          `状态: ${node.status}`,
          `执行者: ${nodeDefinition?.executor?.kind ?? "unknown"}:${nodeDefinition?.executor?.id ?? "unknown"}`,
          "",
          "## 节点说明",
          nodeDefinition?.description ?? "未填写",
          "",
          "## 工作流上下文",
          JSON.stringify(instance.context, null, 2),
        ].join("\n");
        return {
          text,
          structured: {
            instanceId: instance.id,
            nodeId,
            title: instance.title,
            status: node.status,
            context: instance.context,
            taskIds: node.taskIds,
          },
          sourceRefs: [
            { type: "workflow" as const, id: instance.id },
            ...(node.taskIds.at(-1) === undefined
              ? []
              : [{ type: "task" as const, id: node.taskIds.at(-1)! }]),
          ],
          historyText: service
            .events(instance.id)
            .filter((event) => event.nodeId === nodeId)
            .map((event) => `${event.kind}: ${event.message ?? ""}`)
            .join("\n"),
        };
      },
      policy: async () => ({
        version: "workflow-node-context-v1",
        instructions: [
          "你正在执行工作流中的一个受控节点。",
          "只处理当前节点的目标、上下文和交付要求。",
          "不得读取其他工作流实例或其他项目的事实。",
          "最终输出必须满足节点交付契约。",
        ].join("\n"),
        allowedWriteback: ["agent-private-memory", "run-evidence"],
      }),
    } as never);
    child.effect(() => () => {
      if (injectedContext === child.collabContext) {
        injectedContext = undefined;
      }
      dispose();
    });
  });
  ctx.inject(["collabAgent"], (child) => {
    const agent = (
      child as WorkflowContext & { collabAgent?: AgentServiceLike }
    ).collabAgent;
    if (agent === undefined) return;
    agent.bindWorkflow({
      onSettled: (run) => service.handleAgentSettle(run),
    });
  });
  ctx.inject(["collabTasks"], (child) => {
    const tasks = (child as WorkflowContext & { collabTasks?: unknown })
      .collabTasks;
    const bridge = workflowTaskBridgeFrom(tasks);
    if (bridge === undefined) return;
    injectedTasks = bridge;
    (tasks as WorkflowTaskServiceCandidate).bindWorkflowActions({
      assign: (
        task: Parameters<WorkflowService["handleTaskAssigned"]>[0],
        actor: {
          id: string;
          name: string;
          kind: "human" | "agent" | "system";
          role?: WorkflowActor["globalRole"];
        },
      ) => service.handleTaskAssigned(task, taskWorkflowActor(actor)),
      assigned: (
        task: Parameters<WorkflowService["handleTaskAssignedAfterPersist"]>[0],
        actor: {
          id: string;
          name: string;
          kind: "human" | "agent" | "system";
          role?: WorkflowActor["globalRole"];
        },
      ) =>
        service.handleTaskAssignedAfterPersist(task, taskWorkflowActor(actor)),
      decide: (
        task: Parameters<WorkflowService["handleTaskDecision"]>[0],
        actor: {
          id: string;
          name: string;
          kind: "human" | "agent" | "system";
          role?: WorkflowActor["globalRole"];
        },
        decision: "approved" | "rejected",
      ) => service.handleTaskDecision(task, taskWorkflowActor(actor), decision),
      reconcile: (
        task: Parameters<WorkflowService["handleTaskReconcile"]>[0],
      ) => service.handleTaskReconcile(task),
      refreshReceiver: (
        task: Parameters<WorkflowService["handleTaskReconcile"]>[0],
      ) => service.refreshTaskReceiverDisplay(task),
      events: (task: {
        readonly workflow?:
          | { readonly instanceId: string; readonly nodeId: string }
          | undefined;
      }) => service.taskEventProjections(task),
      submit: (
        task: Parameters<WorkflowService["handleTaskSubmitted"]>[0],
        actor: {
          id: string;
          name: string;
          kind: "human" | "agent" | "system";
          role?: WorkflowActor["globalRole"];
        },
      ) => service.handleTaskSubmitted(task, taskWorkflowActor(actor)),
    });
  });
  ctx.inject(["collabTeam"], (child) => {
    injectedTeam = child.collabTeam;
    const team = injectedTeam;
    for (const route of createWorkflowRoutes(service, () => team, {
      agent: () => ctx.get("collabAgent"),
      employees: () => ctx.get("collabEmployee"),
      teammates: () => ctx.get("collabTeammates"),
      workspaces: () => injectedWorkspaces,
    })) {
      ctx.webServer.register(route);
    }
  });
  ctx.inject(["workspaceRegistry"], (child) => {
    injectedWorkspaces = child.workspaceRegistry;
  });
  ctx.commands.register({
    name: "workflow",
    description: "inspect and advance Pluginmax workflows",
    input: { hint: "[list|complete|approve|reject] ...", attachments: false },
    handler: async (invocation: CommandInvocationLike) => {
      try {
        return {
          kind: "success",
          text: await agentWorkflowAction(
            service,
            { signal: { throwIfAborted: () => undefined } },
            invocation.rawInput,
          ),
        };
      } catch (error) {
        return {
          kind: "error",
          text:
            error instanceof Error ? error.message : "workflow command failed",
        };
      }
    },
  });
  ctx.tools.register({
    name: "collab_workflow",
    description:
      "List workspace workflow instances or complete/approve/reject a node.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "complete", "approve"] },
        workspaceId: { type: "string" },
        instanceId: { type: "string" },
        nodeId: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: stringToolOutput,
    execute: async (args: unknown, exec: ToolExecLike) => {
      exec.signal.throwIfAborted();
      const parsed = z
        .object({
          action: z.enum(["list", "complete", "approve", "reject"]),
          workspaceId: z.string().optional(),
          instanceId: z.string().optional(),
          nodeId: z.string().optional(),
        })
        .parse(args);
      if (parsed.action === "list") {
        if (parsed.workspaceId === undefined)
          throw new WorkflowError("invalid_input", "workspaceId is required");
        return agentWorkflowAction(service, exec, `list ${parsed.workspaceId}`);
      }
      if (parsed.instanceId === undefined || parsed.nodeId === undefined) {
        throw new WorkflowError(
          "invalid_input",
          "instanceId and nodeId are required",
        );
      }
      return agentWorkflowAction(
        service,
        exec,
        `${parsed.action} ${parsed.instanceId} ${parsed.nodeId}`,
      );
    },
  });
}
