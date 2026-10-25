import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { z } from "zod";
import {
  profileTemplateSchema,
  teammateAuditEventSchema,
  teammateEventSchema,
  teammateSchema,
  teammateSourceSchema,
  teammateStateSchema,
  teammateTemplateSchema,
  teammateTemplateStateSchema,
  teammateWorkReportSchema,
  type Teammate,
  type TeammateAuditEvent,
  type TeammateEvent,
  type ProfileTemplate,
  type TeammateTemplate,
  type TeammateWorkReport,
} from "./models.js";
import {
  canManageInstance,
  migrateTeammateTemplates,
  TeammateError,
  TeammateService,
  TeammateTemplateService,
  type KvTableLike,
  type TeammateActor,
} from "./service.js";
import {
  TeammateRuntime,
  type AgentServiceLike,
  type EmployeeServiceLike,
  type PersonaServiceLike,
  type PrincipalServiceLike,
} from "./runtime.js";
import {
  PrincipalRuntimeService,
  principalRuntimeDomainSpec,
  type PrincipalActionTicket,
  type PrincipalRuntimeProfile,
  type PrincipalRuntimePrincipalServiceLike,
} from "./principal-runtime.js";
import {
  parseWorkPlanInstruction,
  taskPriorityForDisplay,
} from "./plan-parser.js";
import { WorkReportService, localDateString } from "./reports.js";
import {
  fallbackWorkReport,
  WorkReportRuntime,
  type AgentDefaultModelLike,
  type AgentsRegistryLike,
  type SubagentsRuntimeLike,
  type WorkReportGenerationContext,
  type WorkReportRunContext,
  type WorkReportTaskContext,
} from "./report-runtime.js";

export {
  TeammateError,
  TeammateService,
  TeammateTemplateService,
  canManageTeammate,
  canManageTemplate,
  migrateTeammateTemplates,
  nextVersion,
} from "./service.js";
export type { Teammate, TeammateEvent } from "./models.js";
export type {
  TeammateActor,
  TeammateTables,
  TeammateTemplateTables,
  TeammateInstanceView,
} from "./service.js";
export { TeammateRuntime } from "./runtime.js";
export {
  PrincipalRuntimeService,
  principalRuntimeDomainSpec,
} from "./principal-runtime.js";
export type {
  PrincipalActionTicket,
  PrincipalRuntimeProfile,
} from "./principal-runtime.js";
export type {
  EnsuredRuntime,
  EnsureRuntimeInput,
  TeammateRuntimeDeps,
} from "./runtime.js";
export { WorkReportService } from "./reports.js";
export {
  buildWorkReportPrompt,
  fallbackWorkReport,
  WorkReportRuntime,
} from "./report-runtime.js";
export {
  compactWorkPlanTitle,
  parseWorkPlanDueDate,
  parseWorkPlanInstruction,
  parseWorkPlanPriority,
  taskPriorityForDisplay,
} from "./plan-parser.js";

export const name = "dsh-collab-teammate";
export const inject = [
  "storageDomain",
  "webServer",
  "agents",
  "agentDefaultModel",
];

/**
 * 会议 Facilitator 的平台归属默认定义（数据种子）。
 * 固定 id：persona 派生规则 `persona-<teammateId>` 与角色席位共用该 id。
 */
export const MEETING_FACILITATOR_TEAMMATE_ID = "meeting-facilitator";

const MEETING_FACILITATOR_SEED = {
  id: MEETING_FACILITATOR_TEAMMATE_ID,
  name: "会议 Facilitator",
  role: "会议主持人",
  description:
    "每场会议的默认主持人：推进议程、收敛分歧，并在散会或对话变化时输出中文关键结论。",
  soul: [
    "# 会议 Facilitator SOUL",
    "",
    "你负责让每一场会议产生可执行的结论，而不是复述讨论过程。",
    "",
    "## 工作方式",
    "- 用中文工作；结论必须具体、可执行，避免空话。",
    "- 讨论发散时先收敛议题，再给出下一步动作与责任人。",
    "- 信息不足时明确指出缺什么，不编造结论。",
    "- 出纪要时只输出 1-2 句关键结论。",
  ].join("\n"),
  scenarios: ["推进会议议程并控制发散", "散会前用 1-2 句中文收敛关键结论"],
  goals: ["保证每场会议都有明确结论", "结论用中文、可直接进会议纪要"],
} as const;

type TeammateStorageTableName =
  | "teammates"
  | "events"
  | "teammate_templates"
  | "work_reports"
  | "audit_events";
type ProfileStorageTableName = "profile_templates";
type PrincipalRuntimeStorageTableName = "profiles" | "action_tickets";

interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly compatibleVersions?: readonly number[];
  readonly tables: Record<string, { readonly valueSchema: z.ZodType<unknown> }>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

export const teammateDomainSpec: DomainSpecLike = {
  name: "collab_teammate",
  version: 1,
  tables: {
    teammates: { valueSchema: teammateSchema as unknown as z.ZodType<unknown> },
    events: {
      valueSchema: teammateEventSchema as unknown as z.ZodType<unknown>,
    },
    profile_templates: {
      valueSchema: profileTemplateSchema as unknown as z.ZodType<unknown>,
    },
    teammate_templates: {
      valueSchema: teammateTemplateSchema as unknown as z.ZodType<unknown>,
    },
    work_reports: {
      valueSchema: teammateWorkReportSchema as unknown as z.ZodType<unknown>,
    },
    audit_events: {
      valueSchema: teammateAuditEventSchema as unknown as z.ZodType<unknown>,
    },
  },
};

export const profileDomainSpec: DomainSpecLike = {
  name: "collab_teammate_profiles",
  version: 1,
  tables: {
    profile_templates: {
      valueSchema: profileTemplateSchema as unknown as z.ZodType<unknown>,
    },
  },
};

interface TeamMemberLike {
  readonly userId: string;
  readonly memberRole?: "owner" | "member" | "guest";
}

interface TeamServiceLike {
  resolveToken(token: string): TeammateActor | undefined;
  users(): readonly { readonly id: string; readonly name: string }[];
  members(workspaceId: string): readonly TeamMemberLike[];
}

interface TaskRecordLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: string;
  /** 老数据/测试替身可能没有优先级，读取时按默认 P3（展示口径 P2）兜底。 */
  readonly priority?: string | undefined;
  readonly receiverType: string;
  readonly receiverId?: string | undefined;
  readonly receiverPrincipalId?: string | undefined;
  readonly receiverName?: string | undefined;
  readonly description?: string | undefined;
  readonly due?: string | undefined;
  readonly autoSubmitReview?: boolean | undefined;
  readonly queueSeq?: number | undefined;
  readonly queueState?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly autoRunEligible?: boolean | undefined;
  readonly needsInput?: boolean | undefined;
  readonly archivedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages?: readonly TaskMessageLike[] | undefined;
  readonly workflow?:
    | {
        readonly instanceId: string;
        readonly nodeId: string;
      }
    | undefined;
}

interface TaskMessageLike {
  readonly content: string;
  readonly runId?: string | undefined;
  readonly state?: string | undefined;
}

const ACTIVE_RUN_STATES = new Set(["queued", "running", "waiting_input"]);

/**
 * 只有「最近一次 run 仍在进行」才算运行中。
 * 历史里旧的 running 消息、或看板列停留在「进行中」，都不代表 Agent 还在跑。
 */
export function isTaskRunning(task: {
  readonly messages?: readonly TaskMessageLike[] | undefined;
}): boolean {
  const messages = task.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.runId !== undefined && message.state !== undefined) {
      return ACTIVE_RUN_STATES.has(message.state);
    }
  }
  return false;
}

interface TaskServiceLike {
  list(workspaceId: string): readonly TaskRecordLike[];
  /** 共享的队列排序口径（任务模块提供），避免各插件各写一套顺序。 */
  sortQueue?(tasks: readonly TaskRecordLike[]): readonly TaskRecordLike[];
  create(
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "human";
      readonly role?: TeammateActor["role"] | undefined;
    },
    input: {
      readonly workspaceId: string;
      readonly title: string;
      readonly type: string;
      readonly status: string;
      readonly priority: "P1" | "P2" | "P3";
      readonly receiverType: "agent";
      readonly receiverId: string;
      readonly receiverName: string;
      readonly description: string;
      readonly acceptance: readonly string[];
      readonly due?: string | undefined;
      readonly autoSubmitReview: boolean;
    },
  ): Promise<TaskRecordLike>;
  assign(
    actor: TeammateActor,
    input: {
      readonly taskId: string;
      readonly receiverType: "human";
      readonly receiverId: string;
      readonly receiverName: string;
    },
  ): Promise<unknown>;
}

interface WorkspaceRegistryLike {
  list(): readonly {
    readonly id: string;
    readonly title?: string | undefined;
  }[];
}

/**
 * 任务模块提供的派发入口（`collabTaskDispatch`）。
 * 工作计划创建后必须复用这条链路，否则任务只会落库、不会唤起 Agent。
 */
interface TaskDispatchLike {
  dispatch(
    task: TaskRecordLike,
    actor: {
      readonly id: string;
      readonly name: string;
      readonly kind: "human";
      readonly role?: TeammateActor["role"] | undefined;
    },
  ): Promise<{
    readonly task: TaskRecordLike;
    readonly execution: Record<string, string>;
  }>;
}

interface MeetingActivityLike {
  list(workspaceId: string): readonly {
    readonly id: string;
    readonly status: string;
    readonly closedAt?: string | undefined;
  }[];
  participants(meetingId: string): readonly {
    readonly id: string;
    readonly meetingId: string;
    readonly kind: string;
    readonly refId: string;
    readonly status: string;
    /** 新版 AI 参会代表会额外记录所属 teammate 实例 id。 */
    readonly teammateInstanceId?: string | undefined;
    readonly personaId?: string | undefined;
    readonly joinedAt?: string | undefined;
    readonly leftAt?: string | undefined;
    readonly updatedAt: string;
  }[];
  /** Facilitator 席位不占 participants 行，单独读取它的进出记录。 */
  facilitators?(meetingId: string): readonly {
    readonly teammateId: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deactivatedAt?: string | undefined;
  }[];
}

export interface TeammateActivityScope {
  readonly runtimeHours: number;
  readonly meetingCount: number;
  readonly outputTokens: number;
}

export interface TeammateActivity {
  readonly teammateId: string;
  /** 运行态口径：只统计绑定到该实例（数字员工本人）的运行与参会。 */
  readonly instance: TeammateActivityScope;
  /** 定义态口径：按同一 Agent 模版（profile / 人设）汇总，可能被多个实例共享。 */
  readonly template: TeammateActivityScope;
  /** 同一 Agent 模版是否被多个 Teammate 实例共享。 */
  readonly templateShared: boolean;
}

function activeMs(
  run: {
    readonly status: string;
    readonly startedAt?: string | undefined;
    readonly endedAt?: string | undefined;
    readonly updatedAt?: string | undefined;
  },
  windowStart: Date,
  now: Date,
): number {
  if (run.status === "queued") return 0;
  const startedAt =
    run.startedAt ?? (run.status === "running" ? undefined : run.updatedAt);
  if (startedAt === undefined) return 0;
  const started = new Date(startedAt);
  const ended =
    run.endedAt === undefined
      ? run.status === "waiting_input"
        ? new Date(run.updatedAt ?? now.toISOString())
        : now
      : new Date(run.endedAt);
  if (
    Number.isNaN(started.getTime()) ||
    Number.isNaN(ended.getTime()) ||
    ended.getTime() <= started.getTime()
  ) {
    return 0;
  }
  const from = Math.max(started.getTime(), windowStart.getTime());
  const to = Math.min(ended.getTime(), now.getTime());
  return Math.max(0, to - from);
}

function participationOverlapsWindow(input: {
  readonly participant: {
    readonly status: string;
    readonly joinedAt?: string | undefined;
    readonly leftAt?: string | undefined;
    readonly updatedAt: string;
  };
  readonly meeting: {
    readonly status: string;
    readonly closedAt?: string | undefined;
  };
  readonly windowStart: Date;
  readonly now: Date;
}): boolean {
  const startedText = input.participant.joinedAt ?? input.participant.updatedAt;
  const started = new Date(startedText);
  const ended =
    input.participant.leftAt !== undefined
      ? new Date(input.participant.leftAt)
      : input.meeting.closedAt !== undefined
        ? new Date(input.meeting.closedAt)
        : input.meeting.status === "closed" ||
            input.participant.status === "left"
          ? new Date(input.participant.updatedAt)
          : input.now;
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()))
    return false;
  return (
    started.getTime() < input.now.getTime() &&
    ended.getTime() > input.windowStart.getTime()
  );
}

interface ActivityRun {
  readonly id: string;
  readonly instanceId: string;
  readonly agentProfileId?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly status: string;
  readonly nodeId: string;
  readonly outputTokens?: number | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly createdAt: string;
}

interface ActivityRunRef {
  readonly workspaceId: string;
  readonly run: ActivityRun;
}

/**
 * 24 小时负荷与参会统计，分两套口径：
 * - `instance`（运行态）：只认绑定到该数字员工实例的运行（run.employeeId）与指派给它的任务；
 * - `template`（定义态）：按同一 Agent 模版（profile）汇总，多个实例共享时数据一致。
 * 同一会议多次进出只计一次。
 */
export function calculateTeammateActivity(input: {
  readonly teammates: readonly {
    readonly id: string;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
  }[];
  readonly tasks: readonly TaskRecordLike[];
  readonly agents?: Pick<AgentServiceLike, "runs"> | undefined;
  readonly meetings?: MeetingActivityLike | undefined;
  readonly workspaces?: WorkspaceRegistryLike | undefined;
  readonly identities?:
    | ReadonlyMap<
        string,
        {
          readonly profileId?: string | undefined;
          readonly personaId?: string | undefined;
        }
      >
    | undefined;
  readonly now?: Date | undefined;
}): TeammateActivity[] {
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const workspaces = input.workspaces?.list() ?? [];

  // 每个工作区只拉一次运行列表，两套口径复用。
  const workspaceIds = new Set<string>(workspaces.map((item) => item.id));
  for (const task of input.tasks) workspaceIds.add(task.workspaceId);
  const runsByWorkspace = new Map<string, readonly ActivityRun[]>();
  for (const workspaceId of workspaceIds) {
    runsByWorkspace.set(
      workspaceId,
      (input.agents?.runs?.({ workspaceId }) ?? []) as readonly ActivityRun[],
    );
  }

  const profileOwners = new Map<string, number>();
  for (const teammate of input.teammates) {
    const profileId = input.identities?.get(teammate.id)?.profileId;
    if (profileId === undefined) continue;
    profileOwners.set(profileId, (profileOwners.get(profileId) ?? 0) + 1);
  }

  const scopeRuns = (
    teammate: (typeof input.teammates)[number],
    identity:
      | {
          readonly profileId?: string | undefined;
          readonly personaId?: string | undefined;
        }
      | undefined,
    scope: "instance" | "template",
  ): ActivityRunRef[] => {
    const collected: ActivityRunRef[] = [];
    const seen = new Set<string>();
    const push = (workspaceId: string, run: ActivityRun) => {
      const key = `${workspaceId}:${run.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      collected.push({ workspaceId, run });
    };
    const receiverIds = new Set<string>([teammate.id]);
    if (teammate.employeeId !== undefined) {
      receiverIds.add(teammate.employeeId);
    }
    const receiverPrincipalIds = new Set<string>();
    if (teammate.principalId !== undefined) {
      receiverPrincipalIds.add(teammate.principalId);
    }
    if (scope === "template" && identity?.profileId !== undefined) {
      receiverIds.add(identity.profileId);
    }
    for (const task of input.tasks) {
      const assignedByAgentId =
        task.receiverType === "agent" &&
        task.receiverId !== undefined &&
        receiverIds.has(task.receiverId);
      const assignedByPrincipalId =
        task.receiverPrincipalId !== undefined &&
        receiverPrincipalIds.has(task.receiverPrincipalId);
      if (!assignedByAgentId && !assignedByPrincipalId) continue;
      const instanceId = task.workflow?.instanceId ?? task.id;
      for (const run of runsByWorkspace.get(task.workspaceId) ?? []) {
        if (run.instanceId !== instanceId) continue;
        if (
          task.workflow !== undefined &&
          run.nodeId !== task.workflow.nodeId
        ) {
          continue;
        }
        push(task.workspaceId, run);
      }
    }
    for (const [workspaceId, runs] of runsByWorkspace) {
      for (const run of runs) {
        if (scope === "instance") {
          if (
            teammate.employeeId === undefined ||
            run.employeeId !== teammate.employeeId
          ) {
            continue;
          }
        } else if (
          identity?.profileId === undefined ||
          run.agentProfileId !== identity.profileId
        ) {
          continue;
        }
        push(workspaceId, run);
      }
    }
    return collected;
  };

  const runTotals = (refs: readonly ActivityRunRef[]) => {
    let runtimeMs = 0;
    let outputTokens = 0;
    for (const { run } of refs) {
      const active = activeMs(run, windowStart, now);
      if (active === 0) continue;
      runtimeMs += active;
      if (
        typeof run.outputTokens === "number" &&
        Number.isFinite(run.outputTokens) &&
        run.outputTokens > 0
      ) {
        outputTokens += Math.trunc(run.outputTokens);
      }
    }
    return { runtimeMs, outputTokens };
  };

  const meetingCount = (
    teammate: (typeof input.teammates)[number],
    identity:
      | {
          readonly profileId?: string | undefined;
          readonly personaId?: string | undefined;
        }
      | undefined,
    scope: "instance" | "template",
  ): number => {
    const receiverIds = new Set<string>([teammate.id]);
    if (teammate.employeeId !== undefined) {
      receiverIds.add(teammate.employeeId);
    }
    if (scope === "template" && identity?.profileId !== undefined) {
      receiverIds.add(identity.profileId);
    }
    // persona 回退：新版参会代表带 teammateInstanceId，旧数据只有 personaId，
    // 两种口径都要能认出来，否则「实际参加过会议」会显示成 0 次。
    const personaId = identity?.personaId;
    const meetingIds = new Set<string>();
    for (const workspace of workspaces) {
      for (const meeting of input.meetings?.list(workspace.id) ?? []) {
        if (meetingIds.has(meeting.id)) continue;
        const participates = input.meetings
          ?.participants(meeting.id)
          .some((participant) => {
            if (
              participant.kind !== "agent" &&
              participant.kind !== "ai_teammate"
            ) {
              return false;
            }
            const ownerId = participant.teammateInstanceId ?? participant.refId;
            const matched =
              receiverIds.has(ownerId) ||
              (personaId !== undefined && participant.personaId === personaId);
            return (
              matched &&
              participationOverlapsWindow({
                participant,
                meeting,
                windowStart,
                now,
              })
            );
          });
        // Facilitator 是会议服务席位，只落在 facilitators 表，不占 participants 行。
        const facilitated =
          participates === true
            ? false
            : (input.meetings?.facilitators?.(meeting.id) ?? []).some(
                (facilitator) =>
                  receiverIds.has(facilitator.teammateId) &&
                  participationOverlapsWindow({
                    participant: {
                      status:
                        facilitator.status === "active" ? "joined" : "left",
                      joinedAt: facilitator.createdAt,
                      ...(facilitator.deactivatedAt === undefined
                        ? {}
                        : { leftAt: facilitator.deactivatedAt }),
                      updatedAt: facilitator.updatedAt,
                    },
                    meeting,
                    windowStart,
                    now,
                  }),
              );
        if (participates === true || facilitated === true) {
          meetingIds.add(meeting.id);
        }
      }
    }
    return meetingIds.size;
  };

  return input.teammates.map((teammate) => {
    const identity = input.identities?.get(teammate.id);
    const instanceRuns = scopeRuns(teammate, identity, "instance");
    const instanceTotals = runTotals(instanceRuns);
    const instance: TeammateActivityScope = {
      runtimeHours: instanceTotals.runtimeMs / 3_600_000,
      meetingCount: meetingCount(teammate, identity, "instance"),
      outputTokens: instanceTotals.outputTokens,
    };
    if (
      identity?.profileId === undefined &&
      identity?.personaId === undefined
    ) {
      return {
        teammateId: teammate.id,
        instance,
        template: instance,
        templateShared: false,
      };
    }
    const templateRefs = scopeRuns(teammate, identity, "template");
    const seen = new Set(
      templateRefs.map((ref) => `${ref.workspaceId}:${ref.run.id}`),
    );
    for (const ref of instanceRuns) {
      const key = `${ref.workspaceId}:${ref.run.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      templateRefs.push(ref);
    }
    const templateTotals = runTotals(templateRefs);
    return {
      teammateId: teammate.id,
      instance,
      template: {
        runtimeHours: templateTotals.runtimeMs / 3_600_000,
        meetingCount: meetingCount(teammate, identity, "template"),
        outputTokens: templateTotals.outputTokens,
      },
      templateShared:
        identity.profileId !== undefined &&
        (profileOwners.get(identity.profileId) ?? 0) > 1,
    };
  });
}

function runActivityAt(run: ActivityRun): string {
  return run.endedAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt;
}

function laterTimestamp(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (candidate === undefined) return current;
  if (Number.isNaN(new Date(candidate).getTime())) return current;
  if (current === undefined) return candidate;
  return candidate > current ? candidate : current;
}

/**
 * 运行态列表的"最近使用"口径（instance scope）：取以下时间的最大值——
 * 1. 实例自身的编辑时间（`updatedAt`）；
 * 2. 绑定到该实例的运行（按 receiverId 派发的任务所命中的 run，以及
 *    `run.employeeId` 直接匹配的 run）最近一次活动时间；
 * 3. 该实例以 Agent 身份参与会议的最新进出时间。
 * 用于「同状态内按最近使用优先」的排序，纯函数便于单测。
 */
export function calculateInstanceLastUsedAt(input: {
  readonly teammates: readonly {
    readonly id: string;
    readonly employeeId?: string | undefined;
    readonly updatedAt: string;
  }[];
  readonly tasks: readonly TaskRecordLike[];
  readonly agents?: Pick<AgentServiceLike, "runs"> | undefined;
  readonly meetings?: MeetingActivityLike | undefined;
  readonly workspaces?: WorkspaceRegistryLike | undefined;
}): Map<string, string> {
  const workspaces = input.workspaces?.list() ?? [];
  const workspaceIds = new Set(workspaces.map((item) => item.id));
  for (const task of input.tasks) workspaceIds.add(task.workspaceId);
  const runsByWorkspace = new Map<string, readonly ActivityRun[]>();
  for (const workspaceId of workspaceIds) {
    runsByWorkspace.set(
      workspaceId,
      (input.agents?.runs?.({ workspaceId }) ?? []) as readonly ActivityRun[],
    );
  }
  const result = new Map<string, string>();
  for (const teammate of input.teammates) {
    let latest: string | undefined = teammate.updatedAt;
    const receiverIds = new Set<string>([teammate.id]);
    if (teammate.employeeId !== undefined) {
      receiverIds.add(teammate.employeeId);
    }
    // 派发给该实例的任务：沿任务命中的 run 记录取最近活动时间。
    for (const task of input.tasks) {
      if (task.receiverType !== "agent" || task.receiverId === undefined) {
        continue;
      }
      if (!receiverIds.has(task.receiverId)) continue;
      const instanceId = task.workflow?.instanceId ?? task.id;
      for (const run of runsByWorkspace.get(task.workspaceId) ?? []) {
        if (run.instanceId !== instanceId) continue;
        if (
          task.workflow !== undefined &&
          run.nodeId !== task.workflow.nodeId
        ) {
          continue;
        }
        latest = laterTimestamp(latest, runActivityAt(run));
      }
    }
    // 以数字员工身份执行的 run（不依赖任务记录）。
    if (teammate.employeeId !== undefined) {
      for (const runs of runsByWorkspace.values()) {
        for (const run of runs) {
          if (run.employeeId !== teammate.employeeId) continue;
          latest = laterTimestamp(latest, runActivityAt(run));
        }
      }
    }
    // 会议参会记录。
    for (const workspace of workspaces) {
      for (const meeting of input.meetings?.list(workspace.id) ?? []) {
        for (const participant of input.meetings?.participants(meeting.id) ??
          []) {
          if (participant.kind !== "agent") continue;
          if (!receiverIds.has(participant.refId)) continue;
          latest = laterTimestamp(
            latest,
            participant.leftAt ?? participant.updatedAt,
          );
          latest = laterTimestamp(latest, participant.joinedAt);
        }
      }
    }
    if (latest !== undefined) result.set(teammate.id, latest);
  }
  return result;
}

function requestHeader(
  request: IncomingMessage,
  key: string,
): string | undefined {
  const value = request.headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function requirePrincipal(
  request: IncomingMessage,
  team: TeamServiceLike,
): TeammateActor & { readonly token: string } {
  const origin = requestHeader(request, "origin");
  const host = requestHeader(request, "host");
  if (origin !== undefined && !sameOrigin(origin, host)) {
    throw new TeammateError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name) =>
      name === "authorization" ? (request.headers.authorization ?? null) : null,
  });
  if (token === undefined) {
    throw new TeammateError("unauthorized", "bearer token is required");
  }
  const principal = team.resolveToken(token);
  if (principal === undefined) {
    throw new TeammateError("unauthorized", "invalid or expired token");
  }
  const user = team.users().find((item) => item.id === principal.userId);
  return {
    ...principal,
    name: user?.name ?? principal.userId,
    token,
  };
}

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request, 1024 * 1024);
  } catch {
    throw new TeammateError("invalid_input", "valid JSON body is required");
  }
}

function parseOrInvalid<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TeammateError("invalid_input", "request input is invalid");
  }
  return result.data;
}

function errorStatus(code: TeammateError["code"]): number {
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "conflict") return 409;
  return 400;
}

function runtimeError(
  cause: unknown,
): { code: TeammateError["code"]; message: string } | undefined {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("code" in cause) ||
    !("message" in cause) ||
    typeof cause.code !== "string" ||
    typeof cause.message !== "string" ||
    cause.message.trim() === ""
  ) {
    return undefined;
  }
  const code =
    cause.code === "method_not_allowed" ? "invalid_input" : cause.code;
  if (
    code !== "invalid_input" &&
    code !== "unauthorized" &&
    code !== "forbidden" &&
    code !== "not_found" &&
    code !== "conflict"
  ) {
    return undefined;
  }
  return { code, message: cause.message };
}

async function runHandler(
  operation: () => Promise<void> | void,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof TeammateError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    const runtime = runtimeError(cause);
    if (runtime !== undefined) {
      sendJson(response, errorStatus(runtime.code), {
        ok: false,
        error: runtime,
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "AI伙伴请求失败" },
    });
  }
}

const createBodySchema = z.object({
  source: teammateSourceSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  templateId: z.string().trim().min(1).max(160).optional(),
  role: z.string().trim().max(120).optional(),
  profileTemplateId: z.string().trim().min(1).max(160).optional(),
  execution: z.enum(["builtin", "external"]).optional(),
  externalRuntimeId: z.string().trim().min(1).max(160).optional(),
});

const createWithEmployeeBodySchema = createBodySchema.extend({
  templateId: z.string().trim().min(1).max(160),
  workspaceId: z.string().trim().min(1).max(160),
  employeeId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
    .optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  department: z.string().trim().max(120).optional(),
  title: z.string().trim().max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(14).optional(),
  managerEmployeeId: z.string().trim().min(1).max(120).optional(),
});

const teammateTemplateCreateBodySchema = z.object({
  source: teammateSourceSchema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).optional(),
  description: z.string().max(4_000).optional(),
  soul: z.string().max(200_000).optional(),
  scenarios: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  goals: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  tools: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  active: z.boolean().optional(),
});

const teammateTemplateUpdateBodySchema = teammateTemplateCreateBodySchema
  .omit({ source: true, active: true })
  .extend({ templateId: z.string().trim().min(1).max(160) });

const teammateTemplateStateBodySchema = z.object({
  templateId: z.string().trim().min(1).max(160),
  state: teammateTemplateStateSchema,
});

const updateBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  source: teammateSourceSchema.optional(),
  execution: z.enum(["builtin", "external"]).optional(),
  externalRuntimeId: z.string().trim().min(1).max(160).optional(),
  role: z.string().trim().max(120).optional(),
  description: z.string().max(4_000).optional(),
  soul: z.string().max(200_000).optional(),
  scenarios: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  goals: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  avatar: z.string().max(400_000).optional(),
});

const stateBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  state: teammateStateSchema,
});

const instanceProfileBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000),
});

const leaveWorkspaceBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  workspaceId: z.string().trim().min(1).max(64),
  scope: z.enum(["workspace", "role"]).default("workspace"),
  assignmentId: z.string().trim().min(1).max(160).optional(),
});

const workPlanParseBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  instruction: z.string().trim().min(1).max(4_000),
});

const workPlanCreateBodySchema = workPlanParseBodySchema.extend({
  workspaceId: z.string().trim().min(1).max(200),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  due: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  autoSubmitReview: z.boolean().default(true),
});

const workReportGenerateBodySchema = z.object({
  teammateId: z.string().trim().min(1).max(160),
  reportDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * 工作日报的 LLM 通道与路由上下文。
 * 由 apply() 组装；未传入时工作日报相关路由返回服务不可用。
 */
export interface TeammateWorkReportRuntimeContext {
  readonly reports: WorkReportService;
  readonly runtime: WorkReportRuntime;
  readonly workspaces: () => WorkspaceRegistryLike | undefined;
}

interface RuntimeTask {
  readonly id: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly workspaceTitle: string;
  readonly status: string;
  readonly priority: string;
  readonly description: string;
  readonly due?: string | undefined;
  readonly autoSubmitReview: boolean;
  readonly receiverId?: string | undefined;
  readonly receiverName?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestProgress: string;
  readonly queueSeq?: number | undefined;
  readonly queueState: string;
  readonly dependsOn: readonly string[];
  readonly autoRunEligible: boolean;
  readonly needsInput: boolean;
  readonly running: boolean;
  readonly archived: boolean;
  readonly runs: readonly {
    readonly id: string;
    readonly status: string;
    readonly runSeq: number;
    readonly error?: string | undefined;
    readonly summary?: string | undefined;
    readonly startedAt?: string | undefined;
    readonly endedAt?: string | undefined;
    readonly createdAt: string;
  }[];
}

function latestProgress(task: TaskRecordLike): string {
  const messages = task.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.content.trim() !== "") {
      return normalizeTaskProgress(message.content);
    }
  }
  return task.description?.trim() || "暂无最新进展";
}

export function normalizeTaskProgress(content: string): string {
  const prefix = "无法启动执行：";
  if (!content.startsWith(prefix)) return content;
  const detail = content.slice(prefix.length).trim();
  try {
    const issues = JSON.parse(detail) as Array<{ message?: unknown }>;
    if (Array.isArray(issues)) {
      const messages = issues
        .map((issue) =>
          typeof issue?.message === "string" ? issue.message.trim() : "",
        )
        .filter(Boolean);
      if (messages.length > 0) return `${prefix}${messages.join("；")}`;
    }
  } catch {
    // Keep the original text when the stored error is not a JSON issue list.
  }
  return content;
}

function runtimeTask(
  task: TaskRecordLike,
  workspaceTitle?: string | undefined,
): Omit<RuntimeTask, "runs"> {
  return {
    id: task.id,
    title: task.title,
    workspaceId: task.workspaceId,
    workspaceTitle: workspaceTitle ?? task.workspaceId,
    status: task.status,
    priority: task.priority ?? "P3",
    description: task.description ?? "",
    ...(task.due === undefined ? {} : { due: task.due }),
    autoSubmitReview: task.autoSubmitReview !== false,
    ...(task.receiverId === undefined ? {} : { receiverId: task.receiverId }),
    ...(task.receiverName === undefined
      ? {}
      : { receiverName: task.receiverName }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestProgress: latestProgress(task),
    ...(task.queueSeq === undefined ? {} : { queueSeq: task.queueSeq }),
    queueState: task.queueState ?? "idle",
    dependsOn: [...(task.dependsOn ?? [])],
    autoRunEligible: task.autoRunEligible !== false,
    needsInput: task.needsInput === true,
    running: isTaskRunning(task),
    archived: task.archivedAt !== undefined,
  };
}

/** 工作区标题用于计划项展示；注册表没有提供时回落到 ID。 */
function workspaceTitleOf(
  workspaces: WorkspaceRegistryLike | undefined,
  workspaceId: string,
): string {
  const found = workspaces?.list().find((item) => item.id === workspaceId);
  return found?.title ?? workspaceId;
}

/** 收集调用者能看到的全部任务（管理员可见全部工作区）。 */
function collectAccessibleTasks(input: {
  readonly team: TeamServiceLike;
  readonly actor: TeammateActor;
  readonly tasks: TaskServiceLike | undefined;
  readonly workspaces: WorkspaceRegistryLike | undefined;
}): readonly TaskRecordLike[] {
  const taskService = input.tasks;
  const registry = input.workspaces;
  if (taskService === undefined || registry === undefined) return [];
  const collected: TaskRecordLike[] = [];
  for (const workspace of registry.list()) {
    const isMember =
      input.actor.role === "admin" ||
      input.team
        .members(workspace.id)
        .some((member) => member.userId === input.actor.userId);
    if (!isMember) continue;
    for (const task of taskService.list(workspace.id)) collected.push(task);
  }
  return collected;
}

/** 收集指派给该 Teammate 的可见任务（兼容通过 employeeId 派发的老任务）。 */
function tasksForTeammate(
  teammate: Teammate,
  collected: readonly TaskRecordLike[],
): readonly TaskRecordLike[] {
  return collected.filter(
    (task) =>
      task.receiverType === "agent" &&
      (task.receiverId === teammate.id ||
        (teammate.employeeId !== undefined &&
          task.receiverId === teammate.employeeId)),
  );
}

/**
 * 任务接收人可能是人类（例如对话/会议代跑），但实际 run 用的是某个 AI伙伴的
 * persona。返回这些 run 对应的任务 id，用于补齐「当前工作」列表。
 */
export function taskIdsExecutedByPersona(
  runs: readonly {
    readonly instanceId: string;
    readonly personaId?: string | undefined;
  }[],
  personaId: string | undefined,
): Set<string> {
  const result = new Set<string>();
  if (personaId === undefined) return result;
  for (const run of runs) {
    if (run.personaId === personaId) result.add(run.instanceId);
  }
  return result;
}

/**
 * 只有实例专属 persona（`persona-<teammateId>`）才能用于任务归属兜底。
 *
 * 平台模版可能让多个实例共用同一个 persona（例如 `architect`）；此时按 persona
 * 匹配会把历史上别人的运行也算到新实例头上，必须排除。
 */
export function isInstanceOwnedPersona(
  teammateId: string,
  personaId: string | undefined,
): boolean {
  if (personaId === undefined) return false;
  const expected =
    `persona-${teammateId.replace(/[^a-zA-Z0-9._-]/g, "-")}`.slice(0, 120);
  return personaId === expected;
}

/**
 * 退出项目时未完成任务的改派目标：优先交回实例 owner；
 * 实例 owner 不是项目成员时交给项目 owner（没有项目 owner 再兜回实例 owner）。
 */
function resolveLeaveReceiver(
  teammate: Teammate,
  members: readonly TeamMemberLike[],
  users: readonly { readonly id: string; readonly name: string }[],
): { readonly id: string; readonly name: string } {
  const ownerId = teammate.ownerUserId;
  const ownerName =
    users.find((user) => user.id === ownerId)?.name ?? teammate.ownerName;
  if (members.some((member) => member.userId === ownerId)) {
    return { id: ownerId, name: ownerName };
  }
  const projectOwner = members.find((member) => member.memberRole === "owner");
  if (projectOwner === undefined) {
    return { id: ownerId, name: ownerName };
  }
  return {
    id: projectOwner.userId,
    name:
      users.find((user) => user.id === projectOwner.userId)?.name ??
      projectOwner.userId,
  };
}

function workReportTaskContext(
  task: TaskRecordLike,
  workspaceTitle: string,
): WorkReportTaskContext {
  return {
    id: task.id,
    title: task.title,
    workspaceId: task.workspaceId,
    workspaceTitle,
    status: task.status,
    priority: task.priority ?? "P3",
    ...(task.due === undefined ? {} : { due: task.due }),
    latestProgress: latestProgress(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** 收集当日运行记录：来自任务消息与 agent run 明细的交集。 */
export function collectWorkReportRuns(input: {
  readonly tasks: readonly TaskRecordLike[];
  readonly runsFor: (
    workspaceId: string,
    instanceId: string,
  ) =>
    | readonly {
        readonly id: string;
        readonly status: string;
        readonly summary?: string | undefined;
        readonly error?: string | undefined;
        readonly startedAt?: string | undefined;
        readonly endedAt?: string | undefined;
        readonly createdAt?: string | undefined;
      }[]
    | undefined;
  readonly reportDate: string;
}): readonly WorkReportRunContext[] {
  const results: WorkReportRunContext[] = [];
  const seen = new Set<string>();
  for (const task of input.tasks) {
    const instanceId = task.workflow?.instanceId ?? task.id;
    for (const run of input.runsFor(task.workspaceId, instanceId) ?? []) {
      const key = `${task.workspaceId}:${run.id}`;
      if (seen.has(key)) continue;
      const at = run.startedAt ?? run.createdAt ?? task.updatedAt;
      if (!at.startsWith(input.reportDate)) continue;
      seen.add(key);
      results.push({
        runId: run.id,
        taskId: task.id,
        taskTitle: task.title,
        status: run.status,
        ...(run.summary === undefined ? {} : { summary: run.summary }),
        ...(run.error === undefined ? {} : { error: run.error }),
        ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      });
    }
  }
  results.sort((left, right) =>
    (right.startedAt ?? "").localeCompare(left.startedAt ?? ""),
  );
  return results;
}

/** 至少有一个任务在运行的 teammate id（兼容通过 employeeId 派发的老任务）。 */
export function runningTeammateIds(input: {
  readonly teammates: readonly {
    readonly id: string;
    readonly employeeId?: string | undefined;
  }[];
  readonly tasks: readonly {
    readonly receiverType: string;
    readonly receiverId?: string | undefined;
    readonly messages?: readonly TaskMessageLike[] | undefined;
  }[];
}): readonly string[] {
  const runningReceivers = new Set(
    input.tasks
      .filter(
        (task) =>
          task.receiverType === "agent" &&
          task.receiverId !== undefined &&
          isTaskRunning(task),
      )
      .map((task) => task.receiverId as string),
  );
  return input.teammates
    .filter(
      (teammate) =>
        runningReceivers.has(teammate.id) ||
        (teammate.employeeId !== undefined &&
          runningReceivers.has(teammate.employeeId)),
    )
    .map((teammate) => teammate.id);
}

export function createTeammateRoutes(
  service: TeammateService,
  team: () => TeamServiceLike | undefined,
  tasks: () => TaskServiceLike | undefined,
  workspaces: () => WorkspaceRegistryLike | undefined,
  beforeList?: () => Promise<void>,
  teammateRuntime?: TeammateRuntime,
  agentRuns?: () => AgentServiceLike | undefined,
  meetings?: () => MeetingActivityLike | undefined,
  reportRuntime?: TeammateWorkReportRuntimeContext,
  taskDispatch?: () => TaskDispatchLike | undefined,
  teammateTemplates?: TeammateTemplateService,
  employees?: () => EmployeeServiceLike | undefined,
): WebRouteLike[] {
  const requireTeam = (): TeamServiceLike => {
    const value = team();
    if (value === undefined) {
      throw new TeammateError("not_found", "identity service is unavailable");
    }
    return value;
  };
  const methods = (allowed: string, request: IncomingMessage): void => {
    if (request.method !== allowed) {
      throw new TeammateError("invalid_input", "method not allowed");
    }
  };
  const mutate =
    (
      handler: (
        actor: TeammateActor,
        body: unknown,
      ) => Promise<unknown> | unknown,
    ) =>
    async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      await runHandler(async () => {
        const actor = requirePrincipal(request, requireTeam());
        const body = await readBody(request);
        const result = await handler(actor, body);
        sendJson(response, 200, {
          ok: true,
          ...(typeof result === "object" && result !== null
            ? result
            : { result }),
        });
      }, response);
    };
  /** 员工平台同步是尽力而为的补偿动作，失败不应让列表接口整体失败。 */
  const runBeforeList = async (): Promise<void> => {
    if (beforeList === undefined) return;
    try {
      await beforeList();
    } catch {
      // 单个数字员工同步失败时保持列表可用，下一次请求会继续重试。
    }
  };
  const requireTaskService = (): TaskServiceLike => {
    const value = tasks();
    if (value === undefined) {
      throw new TeammateError("not_found", "任务服务不可用，无法创建工作计划");
    }
    return value;
  };
  const requireReportRuntime = (): TeammateWorkReportRuntimeContext => {
    if (reportRuntime === undefined) {
      throw new TeammateError("not_found", "工作日报服务不可用");
    }
    return reportRuntime;
  };
  const accessibleWorkspaceIds = (
    actor: TeammateActor,
    identity: TeamServiceLike,
  ): Set<string> => {
    const registry = workspaces();
    const result = new Set<string>();
    for (const workspace of registry?.list() ?? []) {
      const isMember =
        actor.role === "admin" ||
        identity
          .members(workspace.id)
          .some((member) => member.userId === actor.userId);
      if (isMember) result.add(workspace.id);
    }
    return result;
  };
  /**
   * 明细类接口的统一读取口径：实例 owner、平台实例（团队共享）、平台管理员，
   * 以及在任务/会议中与该实例共同参与的协作方可以读取；其余登录用户拒绝。
   */
  const canReadTeammate = (
    actor: TeammateActor,
    teammate: Teammate,
    identity: TeamServiceLike,
  ): boolean => {
    if (actor.role === "admin") return true;
    if (teammate.ownerUserId === actor.userId) return true;
    if (
      (service.templateOf(teammate)?.source ?? teammate.source) === "platform"
    ) {
      return true;
    }
    const receiverIds = new Set<string>([teammate.id]);
    if (teammate.employeeId !== undefined) {
      receiverIds.add(teammate.employeeId);
    }
    // 任务协作：在该实例可见的工作区里，actor 创建/派发过指派给它的任务。
    const collected = collectAccessibleTasks({
      team: identity,
      actor,
      tasks: tasks(),
      workspaces: workspaces(),
    });
    for (const task of collected) {
      if (task.receiverType !== "agent" || task.receiverId === undefined) {
        continue;
      }
      if (!receiverIds.has(task.receiverId)) continue;
      const createdBy = (task as { readonly createdBy?: string | undefined })
        .createdBy;
      if (createdBy === actor.userId) return true;
    }
    // 会议协作：与实例同场参会的成员。
    const meetingService = meetings?.();
    if (meetingService !== undefined) {
      for (const workspaceId of accessibleWorkspaceIds(actor, identity)) {
        for (const meeting of meetingService.list(workspaceId)) {
          const participants = meetingService.participants(meeting.id);
          const teammateIn = participants.some(
            (participant) =>
              participant.kind === "agent" &&
              receiverIds.has(participant.refId),
          );
          if (!teammateIn) continue;
          const actorIn = participants.some(
            (participant) =>
              participant.kind === "human" &&
              participant.refId === actor.userId,
          );
          if (actorIn) return true;
        }
      }
    }
    return false;
  };
  const requireReadableTeammate = (
    request: IncomingMessage,
  ): { actor: TeammateActor; teammate: Teammate } => {
    const actor = requirePrincipal(request, requireTeam());
    const identity = requireTeam();
    const teammate = service.get(query(request).get("teammateId") ?? "");
    if (!canReadTeammate(actor, teammate, identity)) {
      throw new TeammateError("forbidden", "无权查看该 AI伙伴的详细数据");
    }
    return { actor, teammate };
  };
  const requireTeammateTemplates = (): TeammateTemplateService => {
    if (teammateTemplates === undefined) {
      throw new TeammateError("not_found", "AI伙伴模版服务不可用");
    }
    return teammateTemplates;
  };

  return [
    {
      kind: "exact",
      path: "/api/collab/teammates",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const actor = requirePrincipal(request, requireTeam());
          await runBeforeList();
          const scopeParam = query(request).get("scope");
          const availabilityWorkspaceId =
            query(request).get("workspaceId")?.trim() ?? "";
          const identity = requireTeam();
          const accessibleTasks = collectAccessibleTasks({
            team: identity,
            actor,
            tasks: tasks(),
            workspaces: workspaces(),
          });
          const teammates = service.listInstances(actor, {
            scope: scopeParam === "all" ? "all" : "mine",
            lastUsedAt: calculateInstanceLastUsedAt({
              teammates: service.list(),
              tasks: accessibleTasks,
              agents: agentRuns?.(),
              meetings: meetings?.(),
              workspaces: workspaces(),
            }),
          });
          const liveInstanceCounts = await teammateRuntime?.liveInstanceCounts(
            actor.userId,
          );
          const teammatesWithAvailability =
            availabilityWorkspaceId === "" ||
            teammateRuntime?.availabilityOf === undefined
              ? teammates
              : teammates.map((teammate) => ({
                  ...teammate,
                  availability: teammateRuntime.availabilityOf(
                    teammate.id,
                    availabilityWorkspaceId,
                  ),
                }));
          sendJson(response, 200, {
            ok: true,
            teammates: teammatesWithAvailability,
            canManagePlatform: actor.role === "admin",
            liveInstanceCounts: Object.fromEntries(
              liveInstanceCounts?.entries() ?? [],
            ),
            runningTeammateIds: runningTeammateIds({
              teammates,
              tasks: accessibleTasks,
            }),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/activity",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const actor = requirePrincipal(request, requireTeam());
          await runBeforeList();
          const teammates = service.list();
          const identity = requireTeam();
          const collected = collectAccessibleTasks({
            team: identity,
            actor,
            tasks: tasks(),
            workspaces: workspaces(),
          });
          const identities = new Map<
            string,
            {
              readonly profileId?: string | undefined;
              readonly personaId?: string | undefined;
            }
          >();
          await Promise.all(
            teammates.map(async (teammate) => {
              const found = await teammateRuntime?.identityOf(teammate.id);
              if (found !== undefined) identities.set(teammate.id, found);
            }),
          );
          const items = calculateTeammateActivity({
            teammates,
            tasks: collected,
            agents: agentRuns?.(),
            meetings: meetings?.(),
            workspaces: workspaces(),
            identities,
            now: new Date(),
          });
          sendJson(response, 200, {
            ok: true,
            generatedAt: new Date().toISOString(),
            windowHours: 24,
            items,
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/detail",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { teammate } = requireReadableTeammate(request);
          const instance = service.viewOf(teammate);
          sendJson(response, 200, {
            ok: true,
            teammate: instance,
            events: service.events(teammate.id),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammate-templates",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const actor = requirePrincipal(request, requireTeam());
          const templates = requireTeammateTemplates();
          sendJson(response, 200, {
            ok: true,
            templates: templates.list(actor),
            canManagePlatform: actor.role === "admin",
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammate-templates/create",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(teammateTemplateCreateBodySchema, body);
        return requireTeammateTemplates()
          .create(actor, input)
          .then((template) => ({ template }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammate-templates/update",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(teammateTemplateUpdateBodySchema, body);
        return requireTeammateTemplates()
          .update(actor, input)
          .then((template) => ({ template }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammate-templates/state",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(teammateTemplateStateBodySchema, body);
        return requireTeammateTemplates()
          .changeState(actor, input)
          .then((template) => ({ template }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/switch-template",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(
          z.object({
            teammateId: z.string().trim().min(1).max(160),
            templateId: z.string().trim().min(1).max(160),
          }),
          body,
        );
        return service.switchTemplate(actor, input).then((teammate) => ({
          teammate,
        }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/create",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(createBodySchema, body);
        return service.create(actor, input).then((teammate) => ({ teammate }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/migrate-principals",
      handler: mutate(async (actor) => {
        if (actor.role !== "admin") {
          throw new TeammateError(
            "forbidden",
            "只有平台管理员可以执行 Principal 迁移",
          );
        }
        if (teammateRuntime === undefined) {
          throw new TeammateError("conflict", "AI伙伴运行时服务不可用");
        }
        return {
          migration: await teammateRuntime.migrateEmployeeIdentities(),
        };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/create-with-employee",
      handler: mutate(async (actor, body) => {
        if (actor.role === "guest") {
          throw new TeammateError("forbidden", "访客不能创建 AI伙伴");
        }
        if (teammateRuntime === undefined) {
          throw new TeammateError("conflict", "AI伙伴运行时服务不可用");
        }
        const input = parseOrInvalid(createWithEmployeeBodySchema, body);
        const identity = requireTeam();
        const workspace = workspaces?.()
          ?.list()
          .find((item) => item.id === input.workspaceId);
        if (workspace === undefined) {
          throw new TeammateError("not_found", "关联项目不存在");
        }
        const member = identity
          .members(input.workspaceId)
          .find((item) => item.userId === actor.userId);
        if (actor.role !== "admin" && member === undefined) {
          throw new TeammateError(
            "forbidden",
            "只能在自己加入的项目中创建 AI伙伴",
          );
        }
        if (actor.role !== "admin" && member?.memberRole === "guest") {
          throw new TeammateError("forbidden", "项目访客不能创建 AI伙伴");
        }
        const teammate = await service.create(actor, {
          templateId: input.templateId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.execution === undefined
            ? {}
            : { execution: input.execution }),
          ...(input.externalRuntimeId === undefined
            ? {}
            : { externalRuntimeId: input.externalRuntimeId }),
        });
        try {
          const ensured = await teammateRuntime.ensureRuntime({
            teammateId: teammate.id,
            workspaceId: input.workspaceId,
            actor,
            ...(member?.memberRole === undefined
              ? {}
              : { workspaceRole: member.memberRole }),
            employee: {
              ...(input.employeeId === undefined
                ? {}
                : { employeeId: input.employeeId }),
              ...(input.displayName === undefined
                ? {}
                : { displayName: input.displayName }),
              ...(input.department === undefined
                ? {}
                : { department: input.department }),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.managerEmployeeId === undefined
                ? {}
                : { managerEmployeeId: input.managerEmployeeId }),
            },
          });
          return {
            teammate: service.get(teammate.id),
            employee:
              ensured.employeeId === undefined
                ? undefined
                : employees?.()?.get?.(ensured.employeeId),
            ensured,
          };
        } catch (cause) {
          const failed = service.get(teammate.id);
          const employeeService = employees?.();
          if (
            employeeService !== undefined &&
            failed.employeeId !== undefined
          ) {
            await employeeService
              .changeStatus(actor.userId, failed.employeeId, "archived")
              .catch(() => undefined);
          }
          await service
            .changeState(actor, {
              teammateId: teammate.id,
              state: "archived",
            })
            .catch(() => undefined);
          throw cause;
        }
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/update",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(updateBodySchema, body);
        return service.update(actor, input).then((teammate) => ({ teammate }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/profile",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(instanceProfileBodySchema, body);
        return service
          .updateInstanceProfile(actor, input)
          .then((teammate) => ({ teammate }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/leave-workspace",
      handler: mutate(async (actor, body) => {
        const input = parseOrInvalid(leaveWorkspaceBodySchema, body);
        if (teammateRuntime === undefined) {
          throw new TeammateError("conflict", "运行态服务不可用，无法退出项目");
        }
        const identity = requireTeam();
        const teammate = service.get(input.teammateId);
        const members = identity.members(input.workspaceId);
        const canManageWorkspace =
          actor.role === "admin" ||
          members.some(
            (member) =>
              member.userId === actor.userId && member.memberRole === "owner",
          );
        const reassignTo =
          input.scope === "workspace"
            ? resolveLeaveReceiver(teammate, members, identity.users())
            : undefined;
        const taskService = tasks();
        const workspaceTasks =
          taskService === undefined ? [] : taskService.list(input.workspaceId);
        const result = await teammateRuntime.leaveWorkspace({
          teammateId: input.teammateId,
          workspaceId: input.workspaceId,
          actor,
          canManageWorkspace,
          ...(input.assignmentId === undefined
            ? {}
            : { assignmentId: input.assignmentId }),
          ...(reassignTo === undefined ? {} : { reassignTo }),
          tasks: workspaceTasks,
          assignTask: (assignment) => {
            if (taskService === undefined) {
              throw new TeammateError(
                "conflict",
                "任务服务不可用，无法改派任务",
              );
            }
            return taskService.assign(actor, assignment);
          },
        });
        return { ...result };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/state",
      handler: mutate((actor, body) => {
        const input = parseOrInvalid(stateBodySchema, body);
        if (input.state === "archived") {
          const taskService = tasks();
          const registry = workspaces();
          if (
            teammateRuntime === undefined ||
            taskService === undefined ||
            registry === undefined
          ) {
            throw new TeammateError(
              "conflict",
              "任务或工作区服务不可用，无法归档运行态 AI伙伴",
            );
          }
          const owner = requireTeam()
            .users()
            .find(
              (user) => user.id === service.get(input.teammateId).ownerUserId,
            );
          return teammateRuntime
            .archiveInstance({
              teammateId: input.teammateId,
              actor,
              tasks: collectAccessibleTasks({
                team: requireTeam(),
                actor,
                tasks: taskService,
                workspaces: registry,
              }),
              ...(owner === undefined ? {} : { ownerName: owner.name }),
              assignTask: (assignment) => taskService.assign(actor, assignment),
            })
            .then((result) => ({
              teammate: result.teammate,
              transferredTaskIds: result.transferredTaskIds,
            }));
        }
        return service
          .changeState(actor, input)
          .then((teammate) => ({ teammate }));
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/identity",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { teammate } = requireReadableTeammate(request);
          const identity =
            teammateRuntime === undefined
              ? undefined
              : await teammateRuntime.identityOf(teammate.id);
          sendJson(response, 200, { ok: true, identity: identity ?? null });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/identity/status",
      handler: mutate(async (actor, body) => {
        const input = parseOrInvalid(
          z.object({
            teammateId: z.string().trim().min(1).max(160),
            status: z.enum(["active", "disabled"]),
          }),
          body,
        );
        const teammate = service.get(input.teammateId);
        // 执行身份属于实例：实例 owner 或平台管理员都能启停。
        if (!canManageInstance(teammate, actor)) {
          throw new TeammateError(
            "forbidden",
            "没有权限管理该 AI伙伴的执行身份",
          );
        }
        const identity =
          teammateRuntime === undefined
            ? undefined
            : await teammateRuntime.setIdentityStatus({
                teammateId: input.teammateId,
                status: input.status,
                actor,
              });
        return {
          teammate: service.get(input.teammateId),
          identity: identity ?? null,
        };
      }),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/runtime",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { actor, teammate } = requireReadableTeammate(request);
          const registry = workspaces();
          const accessibleTasks = collectAccessibleTasks({
            team: requireTeam(),
            actor,
            tasks: tasks(),
            workspaces: registry,
          });
          const agent = agentRuns?.();
          // 任务接收人可能仍是人类（例如从对话/会议代跑），但实际执行 run 用的是
          // 该 AI伙伴的 persona；这类任务也要出现在「当前工作」里。
          const identity = await teammateRuntime?.identityOf(teammate.id);
          const personaId = identity?.personaId ?? teammate.personaId;
          const executedTaskIds = new Set<string>();
          // 共享 persona（如模版别名 architect）不能用于归属：它会被多个实例共用，
          // 否则新建实例会把历史运行一起算进来。
          if (isInstanceOwnedPersona(teammate.id, personaId)) {
            const workspaceIds = new Set(
              accessibleTasks.map((task) => task.workspaceId),
            );
            const personaRuns: Array<{
              instanceId: string;
              personaId?: string | undefined;
            }> = [];
            for (const workspaceId of workspaceIds) {
              for (const run of agent?.runs?.({ workspaceId }) ?? []) {
                personaRuns.push(run);
              }
            }
            for (const id of taskIdsExecutedByPersona(personaRuns, personaId)) {
              executedTaskIds.add(id);
            }
          }
          const collected = accessibleTasks
            .filter(
              (task) =>
                tasksForTeammate(teammate, [task]).length > 0 ||
                executedTaskIds.has(task.id),
            )
            .map((task) => {
              return {
              ...runtimeTask(
                task,
                workspaceTitleOf(registry, task.workspaceId),
              ),
              runs: (
                agent?.runs?.({
                  workspaceId: task.workspaceId,
                  instanceId: task.id,
                }) ?? []
              ).map((run) => ({
                id: run.id,
                status: run.status,
                runSeq: run.runSeq,
                ...(run.error === undefined ? {} : { error: run.error }),
                ...(run.output?.summary === undefined
                  ? {}
                  : { summary: run.output.summary }),
                ...(run.startedAt === undefined
                  ? {}
                  : { startedAt: run.startedAt }),
                ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
                createdAt: run.createdAt,
              })),
            };
          });
          collected.sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          );
          sendJson(response, 200, { ok: true, tasks: collected });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/work-plans/parse",
      handler: (request, response) =>
        runHandler(async () => {
          const actor = requirePrincipal(request, requireTeam());
          const input = parseOrInvalid(
            workPlanParseBodySchema,
            await readBody(request),
          );
          service.get(input.teammateId);
          const available = accessibleWorkspaceIds(actor, requireTeam());
          const registry = workspaces();
          const options = (registry?.list() ?? [])
            .filter((workspace) => available.has(workspace.id))
            .map((workspace) => ({
              id: workspace.id,
              title: workspace.title ?? workspace.id,
            }));
          const parsed = parseWorkPlanInstruction({
            instruction: input.instruction,
            workspaces: options,
          });
          sendJson(response, 200, {
            ok: true,
            parsed: {
              ...parsed,
              workspaces: options,
            },
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/work-queue",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { actor, teammate } = requireReadableTeammate(request);
          const registry = workspaces();
          const taskService = tasks();
          const collected = tasksForTeammate(
            teammate,
            collectAccessibleTasks({
              team: requireTeam(),
              actor,
              tasks: taskService,
              workspaces: registry,
            }),
          );
          const titleOf = (workspaceId: string): string =>
            workspaceTitleOf(registry, workspaceId);
          const active = collected.filter(
            (task) => task.archivedAt === undefined,
          );
          // 队列顺序统一由任务模块的排序口径给出（人工 queueSeq 优先，其次 draft）。
          const ordered = (taskService?.sortQueue?.(active) ?? active).map(
            (task) => runtimeTask(task, titleOf(task.workspaceId)),
          );
          const archived = collected
            .filter((task) => task.archivedAt !== undefined)
            .map((task) => runtimeTask(task, titleOf(task.workspaceId)));
          const planned = ordered.filter((task) => task.status === "todo");
          const running = ordered.filter((task) => task.status === "progress");
          const review = ordered.filter((task) => task.status === "review");
          const finished = [
            ...ordered.filter(
              (task) => task.status === "done" || task.status === "cancelled",
            ),
            ...archived,
          ];
          sendJson(response, 200, {
            ok: true,
            queue: {
              teammateId: teammate.id,
              teammateName: teammate.name,
              planned,
              running,
              review,
              finished,
              counts: {
                planned: planned.length,
                running: running.length,
                review: review.length,
                finished: finished.length,
              },
              pendingInput: ordered
                .filter((task) => task.needsInput)
                .map((task) => task.id),
            },
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/work-plans",
      handler: (request, response) =>
        runHandler(async () => {
          const actor = requirePrincipal(request, requireTeam());
          const input = parseOrInvalid(
            workPlanCreateBodySchema,
            await readBody(request),
          );
          const teammate = service.get(input.teammateId);
          const taskService = requireTaskService();
          const registry = workspaces();
          const available = accessibleWorkspaceIds(actor, requireTeam());
          if (!available.has(input.workspaceId)) {
            throw new TeammateError("forbidden", "没有权限在该项目创建任务");
          }
          const parsed = parseWorkPlanInstruction({
            instruction: input.instruction,
            workspaces: [
              {
                id: input.workspaceId,
                title: workspaceTitleOf(registry, input.workspaceId),
              },
            ],
          });
          if (parsed.title.trim() === "") {
            throw new TeammateError(
              "invalid_input",
              "无法识别计划标题，请补充说明后重试",
            );
          }
          const actorName =
            requireTeam()
              .users()
              .find((user) => user.id === actor.userId)?.name ?? actor.name;
          const created = await taskService.create(
            {
              id: actor.userId,
              name: actorName,
              kind: "human",
              role: actor.role,
            },
            {
              workspaceId: input.workspaceId,
              title: parsed.title,
              type: "任务",
              status: "todo",
              priority: taskPriorityForDisplay(input.priority),
              receiverType: "agent",
              receiverId: teammate.id,
              receiverName: teammate.name,
              description: input.instruction,
              acceptance: ["按计划说明完成交付"],
              ...(input.due === undefined ? {} : { due: input.due }),
              autoSubmitReview: input.autoSubmitReview,
            },
          );
          // 创建任务后必须走任务模块的派发链路，否则 Agent 不会被唤起、也不会创建会话。
          const dispatched = await taskDispatch?.()?.dispatch(created, {
            id: actor.userId,
            name: actorName,
            kind: "human",
            role: actor.role,
          });
          const task = dispatched?.task ?? created;
          const execution = dispatched?.execution ?? {};
          await reportRuntime?.reports.writeAudit({
            teammateId: teammate.id,
            actor: { type: "user", id: actor.userId, name: actor.name },
            narrative:
              execution.error === undefined
                ? `${actor.name} 创建工作计划「${task.title}」（${task.id}），发送给 ${teammate.name}。`
                : `${actor.name} 创建工作计划「${task.title}」（${task.id}），发送给 ${teammate.name}，但 Agent 启动失败：${execution.error.slice(0, 200)}`,
            refs: { taskId: task.id },
          });
          sendJson(response, 200, {
            ok: true,
            task,
            execution,
            workspaceTitle: workspaceTitleOf(registry, input.workspaceId),
          });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/work-reports",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { teammate } = requireReadableTeammate(request);
          const teammateId = teammate.id;
          const reports = requireReportRuntime().reports.query({
            teammateId,
            from: query(request).get("from") ?? undefined,
            to: query(request).get("to") ?? undefined,
            q: query(request).get("q") ?? undefined,
          });
          sendJson(response, 200, { ok: true, reports });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/work-reports/generate",
      handler: (request, response) =>
        runHandler(async () => {
          const actor = requirePrincipal(request, requireTeam());
          const input = parseOrInvalid(
            workReportGenerateBodySchema,
            await readBody(request),
          );
          const teammate = service.get(input.teammateId);
          // 工作日报是实例的产出：实例 owner 或平台管理员可以更新。
          if (!canManageInstance(teammate, actor)) {
            throw new TeammateError(
              "forbidden",
              "没有权限更新该 AI伙伴的工作日报",
            );
          }
          const reportDate = input.reportDate ?? localDateString();
          const contextOwner = requireReportRuntime();
          const registry = contextOwner.workspaces();
          const accessible = collectAccessibleTasks({
            team: requireTeam(),
            actor,
            tasks: tasks(),
            workspaces: registry,
          });
          const assigned = tasksForTeammate(teammate, accessible);
          const runsFor = (
            workspaceId: string,
            instanceId: string,
          ): readonly {
            readonly id: string;
            readonly status: string;
            readonly summary?: string | undefined;
            readonly error?: string | undefined;
            readonly startedAt?: string | undefined;
            readonly endedAt?: string | undefined;
            readonly createdAt?: string | undefined;
          }[] =>
            (agentRuns?.()?.runs?.({ workspaceId, instanceId }) ?? []).map(
              (run) => ({
                id: run.id,
                status: run.status,
                ...(run.output?.summary === undefined
                  ? {}
                  : { summary: run.output.summary }),
                ...(run.error === undefined ? {} : { error: run.error }),
                ...(run.startedAt === undefined
                  ? {}
                  : { startedAt: run.startedAt }),
                ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
                createdAt: run.createdAt,
              }),
            );
          const context: WorkReportGenerationContext = {
            teammate,
            reportDate,
            tasks: assigned.map((task) =>
              workReportTaskContext(
                task,
                workspaceTitleOf(registry, task.workspaceId),
              ),
            ),
            runs: collectWorkReportRuns({
              tasks: assigned,
              runsFor,
              reportDate,
            }),
          };
          const author = {
            type: "ai-teammate" as const,
            id: teammate.id,
            name: teammate.name,
          };
          let generated = fallbackWorkReport(context);
          let generation: "llm" | "fallback" = "fallback";
          let failure: string | undefined;
          try {
            generated = await contextOwner.runtime.generate(context);
            generation = "llm";
          } catch (cause) {
            failure = cause instanceof Error ? cause.message : "模型调用失败";
          }
          const report = await contextOwner.reports.save({
            teammateId: teammate.id,
            reportDate,
            author,
            title: generated.title,
            contentMarkdown: generated.contentMarkdown,
            excerpt: generated.excerpt,
            sourceRefs: generated.sourceRefs,
          });
          await contextOwner.reports.writeAudit({
            teammateId: teammate.id,
            actor:
              generation === "llm"
                ? { type: "ai-teammate", id: teammate.id, name: teammate.name }
                : { type: "system", id: "system", name: "系统" },
            narrative:
              generation === "llm"
                ? `${teammate.name} 生成并保存了 ${reportDate} 工作日报（${report.id}）。`
                : `${teammate.name} 的 ${reportDate} 工作日报模型生成失败，已回退为模板快照（${report.id}）：${String(failure).slice(0, 200)}`,
            refs: { reportId: report.id },
          });
          sendJson(response, 200, { ok: true, report, generation });
        }, response),
    },
    {
      kind: "exact",
      path: "/api/collab/teammates/audit-events",
      handler: (request, response) =>
        runHandler(async () => {
          methods("GET", request);
          const { teammate } = requireReadableTeammate(request);
          const teammateId = teammate.id;
          const limitText = query(request).get("limit") ?? "";
          const limit =
            limitText === "" ? undefined : Number.parseInt(limitText, 10);
          const page = requireReportRuntime().reports.auditEvents({
            teammateId,
            ...(limit === undefined || Number.isNaN(limit) ? {} : { limit }),
            ...(query(request).get("cursor") === null
              ? {}
              : { cursor: query(request).get("cursor") ?? undefined }),
          });
          sendJson(response, 200, { ok: true, ...page });
        }, response),
    },
  ];
}

export interface TeammateContext {
  storageDomain: {
    open(
      spec:
        | typeof teammateDomainSpec
        | typeof profileDomainSpec
        | typeof principalRuntimeDomainSpec,
    ): Promise<{
      table<T>(
        name:
          | TeammateStorageTableName
          | ProfileStorageTableName
          | PrincipalRuntimeStorageTableName,
      ): KvTableLike<T>;
      close(): Promise<void>;
    }>;
  };
  webServer: { register(route: WebRouteLike): unknown };
  provide(key: "collabTeammates", value: TeammateService): unknown;
  provide(
    key: "collabTeammateTemplates",
    value: TeammateTemplateService,
  ): unknown;
  provide(key: "collabTeammateRuntime", value: TeammateRuntime): unknown;
  provide(
    key: "collabPrincipalRuntime",
    value: PrincipalRuntimeService,
  ): unknown;
  effect(operation: () => () => void): void;
  collabTeam?: TeamServiceLike;
  collabTasks?: TaskServiceLike;
  workspaceRegistry?: WorkspaceRegistryLike;
  collabMeeting?: MeetingActivityLike;
  agents?: AgentsRegistryLike;
  agentDefaultModel?: AgentDefaultModelLike;
  subagents?: SubagentsRuntimeLike;
  get(key: "collabTeam"): TeamServiceLike | undefined;
  get(key: "collabTasks"): TaskServiceLike | undefined;
  get(key: "collabTaskDispatch"): TaskDispatchLike | undefined;
  get(key: "workspaceRegistry"): WorkspaceRegistryLike | undefined;
  get(key: "collabMeeting"): MeetingActivityLike | undefined;
  get(key: "collabPersonas"): PersonaServiceLike | undefined;
  get(key: "collabEmployee"): EmployeeServiceLike | undefined;
  get(key: "collabAgent"): AgentServiceLike | undefined;
  get(key: "collabPrincipal"): PrincipalServiceLike | undefined;
  get(key: "agents"): AgentsRegistryLike | undefined;
  get(key: "subagents"): SubagentsRuntimeLike | undefined;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: TeammateContext & { readonly collabTeam: TeamServiceLike },
    ) => Promise<void> | void,
  ): { dispose(): void } | void;
}

export async function apply(ctx: TeammateContext): Promise<void> {
  const domain = await ctx.storageDomain.open(teammateDomainSpec);
  const profileDomain = await ctx.storageDomain.open(profileDomainSpec);
  const principalRuntimeDomain = await ctx.storageDomain.open(
    principalRuntimeDomainSpec,
  );
  const teammateTemplateService = new TeammateTemplateService({
    tables: {
      templates: domain.table<TeammateTemplate>("teammate_templates"),
    },
  });
  const migrate = (
    users: readonly { readonly id: string; readonly name: string }[] = [],
  ) =>
    migrateTeammateTemplates({
      teammates: domain.table<Teammate>("teammates"),
      templates: domain.table<TeammateTemplate>("teammate_templates"),
      events: domain.table<TeammateEvent>("events"),
      profileTemplates:
        profileDomain.table<ProfileTemplate>("profile_templates"),
      users,
    });
  await migrate();
  const service = new TeammateService({
    tables: {
      teammates: domain.table<Teammate>("teammates"),
      events: domain.table<TeammateEvent>("events"),
    },
    templates: teammateTemplateService,
    users: () => ctx.get("collabTeam")?.users() ?? [],
  });
  const principalRuntime = new PrincipalRuntimeService(
    {
      profiles:
        principalRuntimeDomain.table<PrincipalRuntimeProfile>("profiles"),
      tickets:
        principalRuntimeDomain.table<PrincipalActionTicket>("action_tickets"),
    },
    () =>
      ctx.get("collabPrincipal") as
        PrincipalRuntimePrincipalServiceLike | undefined,
  );
  // 平台内置数据：会议 Facilitator 开箱定义（只在缺失时写入，不覆盖平台维护）。
  await service.ensureSeededPlatformTeammate(MEETING_FACILITATOR_SEED);
  ctx.provide("collabTeammates", service);
  ctx.provide("collabTeammateTemplates", teammateTemplateService);
  const runtimeService = new TeammateRuntime({
    teammates: service,
    templates: () => teammateTemplateService,
    users: () => ctx.get("collabTeam")?.users() ?? [],
    personas: () => ctx.get("collabPersonas"),
    employees: () => ctx.get("collabEmployee"),
    agents: () => ctx.get("collabAgent"),
    principals: () => ctx.get("collabPrincipal"),
    principalRuntime: () => principalRuntime,
  });
  ctx.provide("collabTeammateRuntime", runtimeService);
  ctx.provide("collabPrincipalRuntime", principalRuntime);
  const reportService = new WorkReportService({
    tables: {
      workReports: domain.table<TeammateWorkReport>("work_reports"),
      auditEvents: domain.table<TeammateAuditEvent>("audit_events"),
    },
  });
  const reportRuntime = new WorkReportRuntime({
    subagents: () => ctx.get("subagents"),
    agents: () => ctx.agents,
    personas: () => ctx.get("collabPersonas"),
    defaultModel: () => ctx.agentDefaultModel,
  });
  const reportContext: TeammateWorkReportRuntimeContext = {
    reports: reportService,
    runtime: reportRuntime,
    workspaces: () => ctx.get("workspaceRegistry"),
  };
  const syncRuntimeIdentities = async (): Promise<void> => {
    await runtimeService.syncFromEmployees();
    await runtimeService.migrateEmployeeIdentities();
  };
  const identityFiber = ctx.inject(["collabTeam"], async (child) => {
    await migrate(
      child.collabTeam.users().map((user) => ({
        id: user.id,
        name: user.name ?? user.id,
      })),
    );
    const routes = createTeammateRoutes(
      service,
      () => child.collabTeam,
      () => ctx.get("collabTasks"),
      () => ctx.get("workspaceRegistry"),
      syncRuntimeIdentities,
      runtimeService,
      () => ctx.get("collabAgent"),
      () => ctx.get("collabMeeting"),
      reportContext,
      () => ctx.get("collabTaskDispatch"),
      teammateTemplateService,
      () => ctx.get("collabEmployee"),
    );
    for (const route of routes) ctx.webServer.register(route);
    void syncRuntimeIdentities().catch(() => undefined);
  });
  ctx.effect(() => () => {
    identityFiber?.dispose();
    void domain.close();
    void profileDomain.close();
    void principalRuntimeDomain.close();
  });
}
