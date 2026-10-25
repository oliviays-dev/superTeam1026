import { basename } from "node:path";
import {
  briefSummary,
  computeAwayWindow,
  localDayStamp,
  mergeBriefItems,
  priorityScore,
  type AwayWindow,
  type BriefCandidate,
  type BriefLiveState,
} from "./brief.js";
import {
  briefItemKey,
  followKey,
  type BriefItemRecord,
  type BriefReader,
  type FollowRecord,
  type FollowType,
  type MetricsPreference,
} from "./models.js";
import {
  COVERAGE_ITEMS,
  DEFAULT_METRIC_IDS,
  METRIC_DEFINITIONS,
  SUPPLIER_RESILIENCE_NOTE,
  SUPPLIER_RISKS,
  SUPPLY_EXCEPTIONS,
} from "./seed.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 会议纪要 agent run 的节点 id（与 dsh-collab-meeting 的约定保持一致）。 */
const MEETING_MINUTES_NODE_ID = "meeting-minutes";

function normalizedParticipantName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type ModuleId =
  | "metrics"
  | "brief"
  | "todo"
  | "focus"
  | "meeting-minutes"
  | "control"
  | "supplier";

export const MODULE_IDS: readonly ModuleId[] = [
  "metrics",
  "brief",
  "todo",
  "focus",
  "meeting-minutes",
  "control",
  "supplier",
];

export const MODULE_TITLES: Record<ModuleId, string> = {
  metrics: "核心指标",
  brief: "每日简报",
  todo: "我的待办",
  focus: "重点关注",
  "meeting-minutes": "会议纪要",
  control: "供给例外",
  supplier: "供应商风险",
};

export interface WorkbenchPrincipal {
  userId: string;
  name?: string;
  role?: "admin" | "owner" | "member" | "guest";
  /**
   * 方案 B：平台管理员的"全量项目"视图开关。默认（false/缺省）与普通成员一致，
   * 只看自己已加入的工作区；只有显式打开时才聚合全部宿主工作区。
   */
  scopeAll?: boolean;
}

interface FollowIndex {
  tasks: Set<string>;
  workflows: Set<string>;
  meetings: Set<string>;
  projects: Set<string>;
}

/** 聚合视图里标注「这条为什么算已关注」：直接关注或覆盖来源。 */
export interface FollowCoverRef {
  type: FollowType;
  id: string;
}

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface WorkbenchTables {
  readonly follows: KvTableLike<FollowRecord>;
  readonly metrics: KvTableLike<MetricsPreference>;
  readonly briefItems: KvTableLike<BriefItemRecord>;
  readonly briefReaders: KvTableLike<BriefReader>;
}

interface TeamServiceLike {
  users(): readonly { readonly id: string; readonly name: string }[];
  members(
    workspaceId: string,
  ): readonly { readonly userId: string; readonly role?: string }[];
}

interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title?: string;
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[];
}

interface TaskRecordLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly type: string;
  readonly status: "todo" | "progress" | "review" | "done" | "cancelled";
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly receiverType: "unassigned" | "human" | "agent" | "role";
  readonly receiverId?: string;
  readonly receiverName?: string;
  readonly due?: string;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly agentRunIds: readonly string[];
  readonly events?: readonly {
    readonly at: string;
    readonly kind: string;
    readonly message: string;
    readonly actorName?: string;
  }[];
  readonly messages?: readonly {
    readonly at: string;
    readonly content: string;
    readonly authorName?: string;
  }[];
  readonly workflow?: {
    readonly instanceId: string;
    readonly nodeId: string;
    readonly instanceTitle: string;
    readonly nodeName: string;
    readonly reviewRequired: boolean;
    readonly approvalPolicy?: "any" | "all";
  };
  readonly archivedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskServiceLike {
  list(workspaceId: string): readonly TaskRecordLike[];
  get(taskId: string): TaskRecordLike;
}

interface WorkflowInstanceLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status:
    "running" | "waiting" | "blocked" | "completed" | "cancelled" | "failed";
  readonly updatedAt: string;
  readonly createdBy?: string;
  readonly nodes: Record<
    string,
    {
      readonly status: string;
      readonly note?: string;
      readonly assignedTo?: string;
    }
  >;
}

interface WorkflowEventLike {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId?: string;
  readonly kind: string;
  readonly actorId: string;
  readonly actorKind: "user" | "agent" | "system";
  readonly actorName: string;
  readonly message: string;
  readonly at: string;
}

interface WorkflowServiceLike {
  instances(workspaceId: string): readonly WorkflowInstanceLike[];
  instance(instanceId: string): WorkflowInstanceLike | undefined;
  events(instanceId: string): readonly WorkflowEventLike[];
}

interface AgentRunLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentProfileId: string;
  readonly personaId?: string;
  readonly employeeId?: string;
  readonly principalType?: "transitional-agent" | "digital-employee";
  readonly source: "workflow" | "task" | "meeting";
  readonly instanceId: string;
  readonly nodeId: string;
  readonly status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  readonly output?: { readonly summary: string } | undefined;
  readonly error?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentServiceLike {
  runs(filter: {
    workspaceId?: string;
    instanceId?: string;
    nodeId?: string;
    statuses?: readonly AgentRunLike["status"][];
  }): readonly AgentRunLike[];
  profile(
    workspaceId: string,
    profileId: string,
  ): { readonly id: string; readonly name: string } | undefined;
}

interface MeetingRecordLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: string;
  readonly agenda: string;
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MeetingServiceLike {
  list(workspaceId: string): readonly MeetingRecordLike[];
  participants(meetingId: string): readonly MeetingParticipantLike[];
}

/**
 * Read-only view of the meeting domain's single minutes object. Kept minimal so
 * the workbench does not depend on the meeting plugin's storage or runtime
 * internals — only on the version projection the convergence contract needs.
 */
interface MeetingMinutesVersionLike {
  readonly id: string;
  readonly version: number;
  readonly content: string;
  readonly status: string;
  readonly updatedAt?: string;
}

interface MeetingMinutesServiceLike {
  activeVersion(meetingId: string): MeetingMinutesVersionLike | undefined;
  versions(meetingId: string): readonly MeetingMinutesVersionLike[];
}

interface MeetingParticipantLike {
  readonly kind?: string;
  readonly refId?: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly source?: string;
  readonly ownerId?: string;
  readonly personaId?: string;
  readonly leader?: boolean;
}

interface EmployeeLike {
  readonly id: string;
  readonly kind: "human" | "digital";
  readonly displayName: string;
  readonly personaId?: string;
  readonly authUserId?: string;
  readonly managerEmployeeId?: string;
}

interface EmployeeServiceLike {
  list(): readonly EmployeeLike[];
  getByAuthUserId(authUserId: string): EmployeeLike | undefined;
  get(employeeId: string): EmployeeLike;
  activeProfile(
    employeeId: string,
    workspaceId: string,
  ): { readonly name: string } | undefined;
}

/** AI Teammate 实例：任务指派到实例，实例归属看实例创建人（ownerUserId）。 */
interface TeammateInstanceLike {
  readonly id: string;
  readonly ownerUserId: string;
  readonly employeeId?: string | undefined;
}

interface TeammateServiceLike {
  list(): readonly TeammateInstanceLike[];
}

interface AssignmentLike {
  readonly workspaceId: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly assigneeKind: "user" | "agent";
  readonly assigneeId: string;
  readonly sessionId?: string;
  readonly personaId?: string;
  readonly status: "claimed" | "assigned" | "released";
}

interface AssignmentServiceLike {
  seats(workspaceId: string): readonly AssignmentLike[];
}

export interface WorkbenchDeps {
  readonly now?: () => Date;
  readonly team?: () => TeamServiceLike | undefined;
  readonly workspaces?: () => WorkspaceRegistryLike | undefined;
  readonly tasks?: () => TaskServiceLike | undefined;
  readonly workflows?: () => WorkflowServiceLike | undefined;
  readonly meetings?: () => MeetingServiceLike | undefined;
  readonly meetingMinutes?: () => MeetingMinutesServiceLike | undefined;
  readonly agents?: () => AgentServiceLike | undefined;
  readonly employees?: () => EmployeeServiceLike | undefined;
  readonly assignments?: () => AssignmentServiceLike | undefined;
  readonly teammates?: () => TeammateServiceLike | undefined;
}

export interface WorkbenchModule<T> {
  id: ModuleId;
  title: string;
  updatedAt: string;
  refreshable: boolean;
  sourceCount?: number;
  staleAt?: string;
  error?: string;
  data?: T;
}

export interface ModuleOptions {
  tzOffsetMinutes: number;
}

const STATUS_LABEL: Record<TaskRecordLike["status"], string> = {
  todo: "待处理",
  progress: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
};

const AGENT_RUN_STATUS_LABEL: Record<AgentRunLike["status"], string> = {
  queued: "排队中",
  running: "执行中",
  waiting_input: "等待输入",
  succeeded: "已完成",
  failed: "执行失败",
  timeout: "执行超时",
  cancelled: "已取消",
  interrupted: "被中断",
};

/**
 * 任务优先级平移：平台存储仍是 P1–P3（历史数据兼容），产品口径统一显示为 P0–P2。
 * 存储 P1 = 产品 P0（最高档），P2 = P1，P3 = P2。
 */
export const PRIORITY_DISPLAY: Record<string, string> = {
  P1: "P0",
  P2: "P1",
  P3: "P2",
};

export function priorityLabel(priority: string): string {
  return PRIORITY_DISPLAY[priority] ?? priority;
}

/** 工作流实例本身没有短号：用实例 id 生成一个稳定的展示码（仅展示，不落库）。 */
export function workflowDisplayId(instanceId: string): string {
  const compact = instanceId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `WF-${compact.slice(0, 6) || "UNKNOWN"}`;
}

/** 升格准入只看产品口径的最高档（存储 P1 / 产品 P0）。 */
const ESCALATION_PRIORITIES = new Set(["P1"]);

const TERMINAL_RUN_STATUSES = new Set<AgentRunLike["status"]>([
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
]);

const FLOW_BLOCKING_EVENT_KINDS = new Set([
  "agent.ticket_denied",
  "agent.failed",
  "agent.dispatch_failed",
  "agent.output_invalid",
  "agent.cancelled",
  "approval.rejected",
  "loop.break",
  "subworkflow.blocked",
  "subworkflow.missing",
  "task.create_failed",
]);

const WORKFLOW_EVENT_LABEL: Record<string, string> = {
  "agent.ticket_denied": "Action Ticket 越权被拒",
  "agent.failed": "Agent 执行失败",
  "agent.dispatch_failed": "Agent 派发失败",
  "agent.output_invalid": "Agent 输出不合规",
  "agent.cancelled": "Agent Run 已取消",
  "approval.rejected": "审批否决",
  "loop.break": "流程 break 触发",
  "subworkflow.blocked": "子流程阻塞",
  "subworkflow.missing": "子流程缺失",
  "task.create_failed": "节点任务创建失败",
};

interface TaskIndex {
  readonly byId: Map<string, TaskRecordLike>;
}

interface BriefDataSnapshot {
  readonly tasks: TaskIndex;
  readonly instances: Map<string, WorkflowInstanceLike>;
  readonly runs: Map<string, AgentRunLike>;
  readonly newerSuccess: Set<string>;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function values<V>(table: KvTableLike<V>): V[] {
  return Array.from(table.entries(), ([, value]) => value);
}

function parseOrNull(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  return Date.parse(value);
}

function formatHours(millis: number): string {
  const hours = Math.max(1, Math.round(millis / 3_600_000));
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

function clip(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function summarizeSentences(text: string, max = 3): string[] {
  return text
    .split(/[。；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((item) => (/[。！？.!?]$/.test(item) ? item : `${item}。`));
}

export class WorkbenchService {
  constructor(
    private readonly tables: WorkbenchTables,
    private readonly deps: WorkbenchDeps = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private workspaceName(workspace: WorkspaceLike | undefined): string {
    if (workspace === undefined) return "";
    const title = workspace.title?.trim();
    if (title !== undefined && title !== "") return title;
    return basename(workspace.path);
  }

  private userName(userId: string | undefined): string {
    if (userId === undefined || userId === "") return "";
    const team = this.deps.team?.();
    return team?.users().find((user) => user.id === userId)?.name ?? userId;
  }

  private accessibleWorkspaces(principal: WorkbenchPrincipal): WorkspaceLike[] {
    const registry = this.deps.workspaces?.();
    const all = registry === undefined ? [] : [...registry.list()];
    // 方案 B：平台管理员的普通视图与成员一致（只看已加入的工作区）；
    // 全量聚合必须由管理员显式打开"全量项目"开关（scope=all），不再默认放行。
    if (principal.role === "admin" && principal.scopeAll === true) return all;
    const team = this.deps.team?.();
    if (team === undefined) return [];
    return all.filter((workspace) =>
      team
        .members(workspace.id)
        .some((member) => member.userId === principal.userId),
    );
  }

  private workspaceMap(principal: WorkbenchPrincipal): {
    workspaces: WorkspaceLike[];
    byId: Map<string, WorkspaceLike>;
  } {
    const workspaces = this.accessibleWorkspaces(principal);
    return {
      workspaces,
      byId: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    };
  }

  private myAgentIds(principal: WorkbenchPrincipal): Set<string> {
    const owned = new Set<string>();
    const claimedEmployees = new Set<string>();
    // AI Teammate 实例：任务指派到实例，实例归属看实例创建人；
    // 同时登记 teammate id 与员工身份 id，兼容两种历史形态的接收人。
    for (const teammate of this.deps.teammates?.()?.list() ?? []) {
      if (teammate.employeeId !== undefined) {
        claimedEmployees.add(teammate.employeeId);
      }
      if (teammate.ownerUserId !== principal.userId) continue;
      owned.add(teammate.id);
      if (teammate.employeeId !== undefined) owned.add(teammate.employeeId);
    }
    const employees = this.deps.employees?.();
    if (employees === undefined) return owned;
    const me = employees.getByAuthUserId(principal.userId);
    for (const employee of employees.list()) {
      if (employee.kind !== "digital") continue;
      // 已被实例归属判定的员工不再按「负责人」重复归属。
      if (claimedEmployees.has(employee.id)) continue;
      if (
        employee.authUserId === principal.userId ||
        (me !== undefined && employee.managerEmployeeId === me.id)
      ) {
        owned.add(employee.id);
      }
    }
    return owned;
  }

  private myRoleSeats(
    principal: WorkbenchPrincipal,
    workspaceId: string,
  ): Set<string> {
    const assignments = this.deps.assignments?.();
    if (assignments === undefined) return new Set();
    try {
      return new Set(
        assignments
          .seats(workspaceId)
          .filter(
            (seat) =>
              seat.status !== "released" &&
              seat.assigneeKind === "user" &&
              seat.assigneeId === principal.userId,
          )
          .map((seat) => seat.seatId),
      );
    } catch {
      return new Set();
    }
  }

  private ownsTask(
    principal: WorkbenchPrincipal,
    task: TaskRecordLike,
    agentIds: Set<string>,
    roleSeats: Set<string>,
  ): boolean {
    if (task.receiverType === "human") {
      return task.receiverId === principal.userId;
    }
    if (task.receiverType === "agent") {
      return task.receiverId !== undefined && agentIds.has(task.receiverId);
    }
    if (task.receiverType === "role") {
      return task.receiverId !== undefined && roleSeats.has(task.receiverId);
    }
    return false;
  }

  private taskIndex(principal: WorkbenchPrincipal): {
    tasks: TaskRecordLike[];
    byId: Map<string, TaskRecordLike>;
  } {
    const service = this.deps.tasks?.();
    if (service === undefined) return { tasks: [], byId: new Map() };
    const { workspaces } = this.workspaceMap(principal);
    const tasks: TaskRecordLike[] = [];
    for (const workspace of workspaces) {
      try {
        tasks.push(...service.list(workspace.id));
      } catch {
        continue;
      }
    }
    return { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
  }

  private instanceIndex(principal: WorkbenchPrincipal): {
    instances: WorkflowInstanceLike[];
    byId: Map<string, WorkflowInstanceLike>;
  } {
    const service = this.deps.workflows?.();
    if (service === undefined) return { instances: [], byId: new Map() };
    const { workspaces } = this.workspaceMap(principal);
    const instances: WorkflowInstanceLike[] = [];
    for (const workspace of workspaces) {
      try {
        instances.push(...service.instances(workspace.id));
      } catch {
        continue;
      }
    }
    return {
      instances,
      byId: new Map(instances.map((instance) => [instance.id, instance])),
    };
  }

  // ---------------------------------------------------------------- follows

  follows(principal: WorkbenchPrincipal): FollowRecord[] {
    return values(this.tables.follows)
      .filter((record) => record.userId === principal.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  isFollowed(
    principal: WorkbenchPrincipal,
    type: FollowType,
    targetId: string,
  ): boolean {
    return (
      this.tables.follows.get(followKey(principal.userId, type, targetId)) !==
      undefined
    );
  }

  async toggleFollow(
    principal: WorkbenchPrincipal,
    input: { type: FollowType; targetId: string },
  ): Promise<{ followed: boolean }> {
    const key = followKey(principal.userId, input.type, input.targetId);
    const existing = this.tables.follows.get(key);
    if (existing !== undefined) {
      await this.tables.follows.delete(key);
      return { followed: false };
    }
    await this.tables.follows.put(key, {
      userId: principal.userId,
      type: input.type,
      targetId: input.targetId,
      createdAt: nowIso(() => this.now()),
    });
    return { followed: true };
  }

  /**
   * 关注覆盖语义：关注工作流 = 覆盖它生命周期内创建的任务；
   * 关注项目 = 覆盖项目下的工作流、任务与会议。索引只记录直接关注，
   * 覆盖关系在读取时展开，后创建的任务同样生效。
   */
  private followIndex(principal: WorkbenchPrincipal): FollowIndex {
    const index: FollowIndex = {
      tasks: new Set<string>(),
      workflows: new Set<string>(),
      meetings: new Set<string>(),
      projects: new Set<string>(),
    };
    for (const record of this.follows(principal)) {
      if (record.type === "task") index.tasks.add(record.targetId);
      else if (record.type === "workflow") index.workflows.add(record.targetId);
      else if (record.type === "meeting") index.meetings.add(record.targetId);
      else index.projects.add(record.targetId);
    }
    return index;
  }

  private taskFollowRefs(
    task: TaskRecordLike,
    index: FollowIndex,
  ): FollowCoverRef[] {
    const refs: FollowCoverRef[] = [];
    if (index.tasks.has(task.id)) refs.push({ type: "task", id: task.id });
    const instanceId = task.workflow?.instanceId;
    if (instanceId !== undefined && index.workflows.has(instanceId)) {
      refs.push({ type: "workflow", id: instanceId });
    }
    if (index.projects.has(task.workspaceId)) {
      refs.push({ type: "project", id: task.workspaceId });
    }
    return refs;
  }

  private workflowFollowRefs(
    instance: WorkflowInstanceLike,
    index: FollowIndex,
  ): FollowCoverRef[] {
    const refs: FollowCoverRef[] = [];
    if (index.workflows.has(instance.id)) {
      refs.push({ type: "workflow", id: instance.id });
    }
    if (index.projects.has(instance.workspaceId)) {
      refs.push({ type: "project", id: instance.workspaceId });
    }
    return refs;
  }

  /**
   * 首页会议纪要范围：我关注的会议、我指派分身参加的会议、我参与的会议，
   * 以及我关注项目下的会议。
   */
  private meetingInScope(
    meeting: MeetingRecordLike,
    participants: readonly MeetingParticipantLike[],
    index: FollowIndex,
    principal: WorkbenchPrincipal,
  ): boolean {
    if (index.meetings.has(meeting.id)) return true;
    if (index.projects.has(meeting.workspaceId)) return true;
    if (
      participants.some(
        (participant) =>
          participant.kind === "human" &&
          participant.refId === principal.userId,
      )
    ) {
      return true;
    }
    return participants.some(
      (participant) =>
        participant.kind === "agent" &&
        participant.ownerId === principal.userId,
    );
  }

  // ---------------------------------------------------------------- metrics

  private metricPreference(principal: WorkbenchPrincipal): string[] {
    const stored = this.tables.metrics.get(principal.userId);
    const valid = (stored?.selected ?? []).filter((id) =>
      METRIC_DEFINITIONS.some((metric) => metric.id === id),
    );
    if (valid.length > 0) return valid.slice(0, 5);
    return [...DEFAULT_METRIC_IDS];
  }

  async setMetrics(
    principal: WorkbenchPrincipal,
    selected: readonly string[],
  ): Promise<string[]> {
    const unique = [...new Set(selected)].filter((id) =>
      METRIC_DEFINITIONS.some((metric) => metric.id === id),
    );
    if (unique.length === 0) {
      throw new WorkbenchError("invalid_input", "至少选择 1 项核心指标");
    }
    const next = unique.slice(0, 5);
    await this.tables.metrics.put(principal.userId, {
      userId: principal.userId,
      selected: next,
      updatedAt: nowIso(() => this.now()),
    });
    return next;
  }

  metricsModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    selected: string[];
    items: typeof METRIC_DEFINITIONS;
  }> {
    const selected = this.metricPreference(principal);
    return {
      id: "metrics",
      title: MODULE_TITLES.metrics,
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: 1,
      data: { selected, items: METRIC_DEFINITIONS },
    };
  }

  // ------------------------------------------------------------------ todo

  todoModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    items: TodoItemPayload[];
  }> {
    const service = this.deps.tasks?.();
    if (service === undefined) {
      throw new WorkbenchError("unavailable", "任务服务不可用");
    }
    const { byId: workspaces } = this.workspaceMap(principal);
    const agentIds = this.myAgentIds(principal);
    const items: TodoItemPayload[] = [];
    for (const workspace of workspaces.values()) {
      const roleSeats = this.myRoleSeats(principal, workspace.id);
      for (const task of service.list(workspace.id)) {
        if (task.archivedAt !== undefined) continue;
        if (task.status !== "todo" && task.status !== "review") continue;
        if (!this.ownsTask(principal, task, agentIds, roleSeats)) continue;
        items.push({
          id: task.id,
          displayId: task.id,
          title: task.title,
          priority: task.priority,
          priorityLabel: priorityLabel(task.priority),
          status: task.status,
          statusLabel: STATUS_LABEL[task.status],
          source: task.workflow === undefined ? "regular" : "workflow",
          workspaceId: workspace.id,
          workspaceName: this.workspaceName(workspace),
          receiverType: task.receiverType,
          receiverName: task.receiverName ?? task.receiverId ?? "待指派",
          due: task.due ?? "",
          updatedAt: task.updatedAt,
          deepLink: {
            route: "task",
            refId: task.id,
            workspaceId: workspace.id,
          },
        });
      }
    }
    const rank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    items.sort((left, right) => {
      const byPriority =
        (rank[left.priority] ?? 9) - (rank[right.priority] ?? 9);
      if (byPriority !== 0) return byPriority;
      const leftDue = left.due === "" ? "9999-99-99" : left.due;
      const rightDue = right.due === "" ? "9999-99-99" : right.due;
      if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
      return left.id.localeCompare(right.id);
    });
    return {
      id: "todo",
      title: MODULE_TITLES.todo,
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: items.length,
      data: { items },
    };
  }

  // ----------------------------------------------------------------- focus

  focusModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    items: FocusItemPayload[];
  }> {
    const { byId: workspaces } = this.workspaceMap(principal);
    const tasks = this.deps.tasks?.();
    const workflows = this.deps.workflows?.();
    const index = this.followIndex(principal);
    const items = new Map<string, FocusItemPayload>();

    const addTask = (task: TaskRecordLike, refs: FollowCoverRef[]): void => {
      const workspace = workspaces.get(task.workspaceId);
      if (workspace === undefined || task.archivedAt !== undefined) return;
      const key = `task:${task.id}`;
      if (items.has(key)) return;
      // 重点关注强调「最近的关键结论 / 状态更新」，取任务最新一条事件（没有则取最新消息）。
      const latestEvent = [...(task.events ?? [])].sort((left, right) =>
        right.at.localeCompare(left.at),
      )[0];
      const latestMessage = [...(task.messages ?? [])].sort((left, right) =>
        right.at.localeCompare(left.at),
      )[0];
      items.set(key, {
        kind: "task",
        id: task.id,
        displayId: task.id,
        title: task.title,
        priority: task.priority,
        priorityLabel: priorityLabel(task.priority),
        status: task.status,
        statusLabel: STATUS_LABEL[task.status],
        workspaceId: workspace.id,
        workspaceName: this.workspaceName(workspace),
        receiverType: task.receiverType,
        receiverName: task.receiverName ?? task.receiverId ?? "待指派",
        due: task.due ?? "",
        updatedAt: task.updatedAt,
        summary:
          latestEvent?.message ??
          (latestMessage === undefined
            ? ""
            : `${latestMessage.authorName ?? ""}${latestMessage.authorName === undefined ? "" : "："}${latestMessage.content}`),
        coveredBy: refs,
        deepLink: { route: "task", refId: task.id, workspaceId: workspace.id },
      });
    };

    const addWorkflow = (
      instance: WorkflowInstanceLike,
      refs: FollowCoverRef[],
    ): void => {
      const workspace = workspaces.get(instance.workspaceId);
      if (workspace === undefined) return;
      const key = `workflow:${instance.id}`;
      if (items.has(key)) return;
      let latestEventMessage = "";
      try {
        const events =
          workflows === undefined ? [] : workflows.events(instance.id);
        latestEventMessage = events[events.length - 1]?.message ?? "";
      } catch {
        latestEventMessage = "";
      }
      // 负责人：取当前活动节点的执行人，取不到时回落到创建人。
      const activeNode = Object.entries(instance.nodes).find(
        ([, node]) =>
          (node.assignedTo ?? "") !== "" &&
          ["running", "ready", "waiting", "blocked"].includes(node.status),
      );
      const activeAssignee = activeNode?.[1]?.assignedTo;
      const currentNodeLabel = ["running", "waiting", "blocked"].includes(
        instance.status,
      )
        ? activeNode?.[0]
        : undefined;
      const ownerName =
        activeAssignee && activeAssignee !== ""
          ? activeAssignee
          : this.userName(instance.createdBy);
      items.set(key, {
        kind: "workflow",
        id: instance.id,
        displayId: workflowDisplayId(instance.id),
        title: instance.title,
        priority: "",
        priorityLabel: "",
        status: instance.status,
        statusLabel: workflowStatusLabel(instance.status),
        ...(currentNodeLabel === undefined ? {} : { currentNodeLabel }),
        workspaceId: workspace.id,
        workspaceName: this.workspaceName(workspace),
        receiverType: ownerName === "" ? "unassigned" : "human",
        receiverName: ownerName,
        due: "",
        updatedAt: instance.updatedAt,
        summary: latestEventMessage,
        coveredBy: refs,
        deepLink: {
          route: "workflow",
          refId: instance.id,
          workspaceId: workspace.id,
        },
      });
    };

    // 直接关注的任务
    if (tasks !== undefined) {
      for (const taskId of index.tasks) {
        let task: TaskRecordLike | undefined;
        try {
          task = tasks.get(taskId);
        } catch {
          task = undefined;
        }
        if (task === undefined) continue;
        addTask(task, this.taskFollowRefs(task, index));
      }
    }
    // 工作流 / 项目覆盖的任务：扫描可见工作区，工作流后续新建的任务同样生效。
    if (
      tasks !== undefined &&
      (index.workflows.size > 0 || index.projects.size > 0)
    ) {
      for (const task of this.taskIndex(principal).tasks) {
        const refs = this.taskFollowRefs(task, index);
        if (refs.length === 0) continue;
        addTask(task, refs);
      }
    }
    // 直接关注的工作流与项目覆盖的工作流
    if (workflows !== undefined) {
      const candidates = new Map<string, WorkflowInstanceLike>();
      for (const workflowId of index.workflows) {
        const instance = workflows.instance(workflowId);
        if (instance !== undefined) candidates.set(instance.id, instance);
      }
      if (index.projects.size > 0) {
        for (const instance of this.instanceIndex(principal).instances) {
          if (index.projects.has(instance.workspaceId)) {
            candidates.set(instance.id, instance);
          }
        }
      }
      for (const instance of candidates.values()) {
        addWorkflow(instance, this.workflowFollowRefs(instance, index));
      }
    }
    // 直接关注的会议，以及被关注项目覆盖的会议。
    // 会议纪要卡片上的星标写的是 type=meeting，这里必须读回来，
    // 否则「关注会议纪要」在重点关注里永远看不到。
    if (index.meetings.size > 0 || index.projects.size > 0) {
      try {
        for (const meeting of this.meetingsModule(principal).data?.items ?? []) {
          const refs: FollowCoverRef[] = [];
          if (index.meetings.has(meeting.id)) {
            refs.push({ type: "meeting", id: meeting.id });
          }
          if (index.projects.has(meeting.workspaceId)) {
            refs.push({ type: "project", id: meeting.workspaceId });
          }
          if (refs.length === 0) continue;
          const key = `meeting:${meeting.id}`;
          if (items.has(key)) continue;
          // 负责人位放主持人（席位解析后的显示名），没有就留空。
          const host = meeting.agents.find((agent) => agent.isHost);
          items.set(key, {
            kind: "meeting",
            id: meeting.id,
            displayId: "会议",
            title: meeting.title,
            priority: "",
            priorityLabel: "",
            status: meeting.status,
            statusLabel: meeting.statusLabel,
            workspaceId: meeting.workspaceId,
            workspaceName: meeting.workspaceName,
            receiverType: host?.kind ?? "",
            receiverName: host?.name ?? "",
            due: "",
            updatedAt: meeting.updatedAt,
            summary: meeting.summaryText,
            coveredBy: refs,
            deepLink: meeting.deepLink,
          });
        }
      } catch {
        // 会议服务不可用时不影响其余关注条目。
      }
    }

    const sorted = [...items.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
    return {
      id: "focus",
      title: MODULE_TITLES.focus,
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: sorted.length,
      data: { items: sorted },
    };
  }

  // -------------------------------------------------- meetings / seed modules

  /**
   * 会议卡片的参会 agent 行：直接用参与者显示名，不再依赖席位解析
   * （席位已下线）。同名去重优先 active > pending > left；pending 与 left
   * 都保留，交给前端区分展示。
   */
  private meetingAgentRows(
    participants: readonly MeetingParticipantLike[],
    principal: WorkbenchPrincipal,
  ): {
    refId: string;
    name: string;
    kind: "human" | "agent";
    owned: boolean;
    isFacilitator: boolean;
    status: string;
    isHost: boolean;
  }[] {
    const rank: Record<string, number> = { active: 0, pending: 1, left: 2 };
    const rows = new Map<
      string,
      {
        refId: string;
        name: string;
        kind: "human" | "agent";
        owned: boolean;
        isFacilitator: boolean;
        status: string;
        isHost: boolean;
      }
    >();
    for (const participant of participants) {
      const kind = participant.kind === "human" ? "human" : "agent";
      const rawName = participant.displayName ?? participant.refId ?? "";
      if (rawName === "") continue;
      const refId = participant.refId ?? "";
      const status = participant.status ?? "active";
      const name = rawName;
      const owned =
        kind === "human"
          ? refId === principal.userId
          : participant.ownerId === principal.userId;
      const isHost = participant.leader === true;
      const isFacilitator =
        /facilitator/i.test(name) || name.includes("会议 Facilitator");
      const rowKey = normalizedParticipantName(name);
      const existing = rows.get(rowKey);
      if (
        existing === undefined ||
        (rank[status] ?? 3) < (rank[existing.status] ?? 3) ||
        (isHost && !existing.isHost)
      ) {
        rows.set(rowKey, {
          refId,
          name,
          kind,
          owned: owned || (existing?.owned ?? false),
          isFacilitator: isFacilitator || (existing?.isFacilitator ?? false),
          status,
          isHost: isHost || (existing?.isHost ?? false),
        });
      }
    }
    return [...rows.values()];
  }

  meetingsModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    items: MeetingMinutesPayload[];
  }> {
    const service = this.deps.meetings?.();
    if (service === undefined) {
      throw new WorkbenchError("unavailable", "会议服务不可用");
    }
    const { workspaces } = this.workspaceMap(principal);
    const index = this.followIndex(principal);
    const items: MeetingMinutesPayload[] = [];
    for (const workspace of workspaces) {
      for (const meeting of service.list(workspace.id)) {
        let participants: readonly MeetingParticipantLike[] = [];
        try {
          participants = service.participants(meeting.id);
        } catch {
          participants = [];
        }
        // 首页纪要只覆盖：我关注的会议、我指派分身参加的会议、我参与的会议、
        // 以及我关注项目下的会议。
        if (!this.meetingInScope(meeting, participants, index, principal)) {
          continue;
        }
        // 参会 agent 行：席位解析成占用者显示名；pending（待认领 / 未启动）
        // 与 left 都保留并带状态，交给前端区分灰度。
        const agents = this.meetingAgentRows(participants, principal);
        const otherParticipantCount = agents.filter(
          (agent) => !agent.owned && !agent.isFacilitator,
        ).length;
        // 纪要来源收敛：优先读会议域的单一纪要对象，其次才回退旧链路。
        // 顺序：confirmed 生效版本 -> pending_confirm 待确认版本 ->
        //      legacy_run 旧 agent run 摘要 -> close_summary 散会手填。
        let minutesSummary = "";
        let minutesSource: MeetingMinutesPayload["minutesSource"] = "none";
        const minutesService = this.deps.meetingMinutes?.();
        if (minutesService !== undefined) {
          try {
            const active = minutesService.activeVersion(meeting.id);
            const activeText = (active?.content ?? "").trim();
            if (active !== undefined && activeText !== "") {
              minutesSummary = activeText;
              minutesSource = "confirmed";
            } else {
              const pending = minutesService
                .versions(meeting.id)
                .filter(
                  (version) =>
                    version.status === "pending_confirm" &&
                    (version.content ?? "").trim() !== "",
                )
                .sort((left, right) => right.version - left.version)[0];
              if (pending !== undefined) {
                minutesSummary = pending.content.trim();
                minutesSource = "pending_confirm";
              }
            }
          } catch {
            minutesSource = "none";
          }
        }
        if (minutesSource === "none") {
          const agentService = this.deps.agents?.();
          if (agentService !== undefined) {
            try {
              const run = agentService
                .runs({
                  workspaceId: workspace.id,
                  instanceId: meeting.id,
                  nodeId: MEETING_MINUTES_NODE_ID,
                })
                .filter((candidate) => candidate.source === "meeting")
                .sort((left, right) =>
                  right.createdAt.localeCompare(left.createdAt),
                )[0];
              if (run?.status === "succeeded") {
                const text = (run.output?.summary ?? "").trim();
                if (text !== "") {
                  minutesSummary = text;
                  minutesSource = "legacy_run";
                }
              }
            } catch {
              minutesSummary = "";
            }
          }
        }
        const fallbackSummary =
          meeting.summary === undefined
            ? ""
            : clip(summarizeSentences(meeting.summary, 2).join(" "), 180);
        if (minutesSummary === "" && fallbackSummary !== "")
          minutesSource = "close_summary";
        const closedStatus =
          meeting.status === "closed" || meeting.status === "archived";
        // 纪要是结构化 MD；卡片只展示纯文本摘要，去掉标题与列表标记。
        const minutesPlain = minutesSummary
          .replace(/^#{1,6}\s*/gm, "")
          .replace(/^\s*[-*]\s*/gm, "")
          .replace(/\s+/g, " ")
          .trim();
        items.push({
          id: meeting.id,
          title: meeting.title,
          summaryText:
            minutesSummary === ""
              ? fallbackSummary
              : clip(minutesPlain, 180),
          status: closedStatus ? "closed" : "active",
          statusLabel: closedStatus ? "已散会" : "进行中",
          workspaceId: workspace.id,
          workspaceName: this.workspaceName(workspace),
          participantCount: participants.length,
          otherParticipantCount,
          agents,
          updatedAt: meeting.updatedAt,
          minutesSource,
          minutesPending: minutesSource === "pending_confirm",
          aiSummary:
            minutesSource === "confirmed" ||
            minutesSource === "pending_confirm" ||
            minutesSource === "legacy_run",
          deepLink: {
            route: "meeting",
            refId: meeting.id,
            workspaceId: workspace.id,
          },
        });
      }
    }
    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      id: "meeting-minutes",
      title: MODULE_TITLES["meeting-minutes"],
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: items.length,
      data: { items: items.slice(0, 8) },
    };
  }

  // ------------------------------------------------------------- projects

  /** 「项目」页列表：可访问项目 + 关注状态 + 三类对象计数。 */
  projects(principal: WorkbenchPrincipal): ProjectPayload[] {
    const { workspaces } = this.workspaceMap(principal);
    const index = this.followIndex(principal);
    const tasks = this.deps.tasks?.();
    const workflows = this.deps.workflows?.();
    const meetings = this.deps.meetings?.();
    const items: ProjectPayload[] = [];
    for (const workspace of workspaces) {
      let taskCount = 0;
      if (tasks !== undefined) {
        try {
          taskCount = tasks
            .list(workspace.id)
            .filter((task) => task.archivedAt === undefined).length;
        } catch {
          taskCount = 0;
        }
      }
      let workflowCount = 0;
      if (workflows !== undefined) {
        try {
          workflowCount = workflows.instances(workspace.id).length;
        } catch {
          workflowCount = 0;
        }
      }
      let meetingCount = 0;
      if (meetings !== undefined) {
        try {
          meetingCount = meetings.list(workspace.id).length;
        } catch {
          meetingCount = 0;
        }
      }
      items.push({
        id: workspace.id,
        name: this.workspaceName(workspace),
        followed: index.projects.has(workspace.id),
        taskCount,
        workflowCount,
        meetingCount,
        updatedAt: nowIso(() => this.now()),
      });
    }
    items.sort(
      (left, right) =>
        Number(right.followed) - Number(left.followed) ||
        left.name.localeCompare(right.name, "zh-Hans-CN"),
    );
    return items;
  }

  controlModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    items: typeof SUPPLY_EXCEPTIONS;
    coverage: typeof COVERAGE_ITEMS;
    pendingCount: number;
  }> {
    void principal;
    return {
      id: "control",
      title: MODULE_TITLES.control,
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: SUPPLY_EXCEPTIONS.length,
      data: {
        items: SUPPLY_EXCEPTIONS,
        coverage: COVERAGE_ITEMS,
        pendingCount: SUPPLY_EXCEPTIONS.filter(
          (item) => item.severity === "high" || item.severity === "medium",
        ).length,
      },
    };
  }

  supplierModule(principal: WorkbenchPrincipal): WorkbenchModule<{
    items: typeof SUPPLIER_RISKS;
    note: string;
  }> {
    void principal;
    return {
      id: "supplier",
      title: MODULE_TITLES.supplier,
      updatedAt: nowIso(() => this.now()),
      refreshable: true,
      sourceCount: SUPPLIER_RISKS.length,
      data: { items: SUPPLIER_RISKS, note: SUPPLIER_RESILIENCE_NOTE },
    };
  }

  // ----------------------------------------------------------------- brief

  private readerItems(readerId: string): BriefItemRecord[] {
    return values(this.tables.briefItems).filter(
      (item) => item.readerId === readerId,
    );
  }

  /**
   * 历史条目可能还带着旧的 600 字截断，点开「展开全文」看不到后续内容。
   * C 区条目身份已收敛到任务级（C:task:<taskId>），因此按该任务最新一次
   * 源 Run 的完整结论回填，让折叠/展开有真实差异。
   */
  private refreshStoredConclusion(
    item: BriefItemRecord,
    snapshot: BriefDataSnapshot,
  ): BriefItemRecord {
    const prefix = "C:task:";
    if (!item.itemId.startsWith(prefix)) return item;
    const task = snapshot.tasks.byId.get(item.itemId.slice(prefix.length));
    const run =
      task === undefined
        ? undefined
        : [...task.agentRunIds]
            .map((runId) => snapshot.runs.get(runId))
            .filter((candidate): candidate is AgentRunLike => candidate !== undefined)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const summary = run?.output?.summary?.trim() ?? "";
    if (summary === "") return item;
    const conclusion = clip(summary, 4_000);
    if (conclusion === item.conclusion) return item;
    return {
      ...item,
      conclusion,
    };
  }

  /**
   * 口径迁移：早期风险条目按「逐事件 / 逐 Run」生成稳定 id，口径改为按实例聚合后，
   * 这些历史条目要在读者下一次合并时折算成实例级条目，避免同一实例重复成条。
   */
  private migrateLegacyRiskItems(
    items: readonly BriefItemRecord[],
    snapshot: BriefDataSnapshot,
  ): BriefItemRecord[] {
    const merged = new Map<string, BriefItemRecord>();
    const passthrough: BriefItemRecord[] = [];
    for (const item of items) {
      const target = this.aggregateTargetFor(item, snapshot);
      if (target === undefined) {
        passthrough.push(item);
        continue;
      }
      const prior = merged.get(target.itemId);
      if (prior === undefined) {
        merged.set(target.itemId, {
          ...item,
          itemId: target.itemId,
          condition: target.condition,
        });
        continue;
      }
      const readState =
        prior.readState === "unread" || item.readState === "unread"
          ? "unread"
          : "read";
      const readAt = prior.readAt ?? item.readAt;
      const readVia = prior.readVia ?? item.readVia;
      merged.set(target.itemId, {
        ...prior,
        readState,
        ...(readState === "read" && readAt !== undefined ? { readAt } : {}),
        ...(readState === "read" && readVia !== undefined ? { readVia } : {}),
        priorityScore: Math.max(prior.priorityScore, item.priorityScore),
        occurredAt:
          prior.occurredAt > item.occurredAt
            ? prior.occurredAt
            : item.occurredAt,
        createdAt:
          prior.createdAt < item.createdAt ? prior.createdAt : item.createdAt,
        updatedAt:
          prior.updatedAt > item.updatedAt ? prior.updatedAt : item.updatedAt,
      });
    }
    return [...passthrough, ...merged.values()];
  }

  /**
   * C 区条目身份统一到任务级（`C:task:<taskId>`）。
   *
   * 早期按 run 生成 `C:run:<runId>`：同一任务重跑一次就会留下两条「待验收」条目，
   * 而条目的生命周期其实是任务级的（验收一次即闭环），用户会看到
   * 「只处理了一条，未读却掉了两条」。这里把历史条目折算到任务级并去重。
   */
  private migrateLegacyConclusionItems(
    items: readonly BriefItemRecord[],
    snapshot: BriefDataSnapshot,
  ): BriefItemRecord[] {
    const merged = new Map<string, BriefItemRecord>();
    const passthrough: BriefItemRecord[] = [];
    for (const item of items) {
      const targetId = this.conclusionItemId(item, snapshot);
      if (targetId === undefined) {
        passthrough.push(item);
        continue;
      }
      // 待验收条目统一用「待我验收」标签，历史条目一并纠正。
      const normalized = {
        ...item,
        itemId: targetId,
        tag: "review" as const,
        condition: {
          ...item.condition,
          kind: "task-review" as const,
          refId: targetId.slice("C:task:".length),
        },
      };
      const prior = merged.get(targetId);
      if (prior === undefined) {
        merged.set(targetId, normalized);
        continue;
      }
      // 保留较新的那条结论；已读状态只要有一条未读就算未读。
      const newer =
        normalized.occurredAt >= prior.occurredAt ? normalized : prior;
      const readState =
        prior.readState === "unread" || normalized.readState === "unread"
          ? "unread"
          : "read";
      const readAt = prior.readAt ?? normalized.readAt;
      const readVia = prior.readVia ?? normalized.readVia;
      merged.set(targetId, {
        ...newer,
        readState,
        ...(readState === "read" && readAt !== undefined ? { readAt } : {}),
        ...(readState === "read" && readVia !== undefined ? { readVia } : {}),
        priorityScore: Math.max(prior.priorityScore, normalized.priorityScore),
        occurredAt:
          prior.occurredAt > normalized.occurredAt
            ? prior.occurredAt
            : normalized.occurredAt,
        createdAt:
          prior.createdAt < normalized.createdAt
            ? prior.createdAt
            : normalized.createdAt,
        updatedAt:
          prior.updatedAt > normalized.updatedAt
            ? prior.updatedAt
            : normalized.updatedAt,
      });
    }
    return [...passthrough, ...merged.values()];
  }

  /** 结论类条目的任务级身份；已迁移过的直接返回自身。 */
  private conclusionItemId(
    item: BriefItemRecord,
    snapshot: BriefDataSnapshot,
  ): string | undefined {
    if (item.section !== "conclusion") return undefined;
    if (item.itemId.startsWith("C:task:")) return item.itemId;
    const prefix = "C:run:";
    if (!item.itemId.startsWith(prefix)) return undefined;
    const run = snapshot.runs.get(item.itemId.slice(prefix.length));
    const taskId = run?.instanceId ?? item.condition.refId;
    if (taskId === undefined || taskId === "") return undefined;
    return `C:task:${taskId}`;
  }

  private aggregateTargetFor(
    item: BriefItemRecord,
    snapshot: BriefDataSnapshot,
  ): { itemId: string; condition: BriefItemRecord["condition"] } | undefined {
    if (!item.itemId.startsWith("A:run:")) {
      // 旧格式 A:workflow:<instanceId>:<eventId> 会被折叠为 A:workflow:<instanceId>。
      if (
        item.itemId.startsWith("A:workflow:") &&
        item.itemId.split(":").length > 3
      ) {
        const instanceId = item.itemId.split(":")[2] ?? "";
        if (instanceId === "" || !snapshot.instances.has(instanceId)) {
          return undefined;
        }
        return {
          itemId: `A:workflow:${instanceId}`,
          condition: { kind: "workflow-blocked", refId: instanceId },
        };
      }
      return undefined;
    }
    const runId = item.itemId.slice("A:run:".length);
    const run = snapshot.runs.get(runId);
    if (run === undefined) return undefined;
    if (run.source === "workflow") {
      return {
        itemId: `A:workflow:${run.instanceId}`,
        condition: { kind: "workflow-blocked", refId: run.instanceId },
      };
    }
    return {
      itemId: `A:task:${run.instanceId}`,
      condition: { kind: "run-terminal", refId: run.instanceId },
    };
  }

  private briefSnapshot(principal: WorkbenchPrincipal): BriefDataSnapshot {
    const { tasks, byId: taskById } = this.taskIndex(principal);
    void tasks;
    const { byId: instancesById } = this.instanceIndex(principal);
    const agents = this.deps.agents?.();
    const { workspaces } = this.workspaceMap(principal);
    const runs = new Map<string, AgentRunLike>();
    const newerSuccess = new Set<string>();
    if (agents !== undefined) {
      for (const workspace of workspaces) {
        let records: readonly AgentRunLike[] = [];
        try {
          records = agents.runs({ workspaceId: workspace.id });
        } catch {
          continue;
        }
        for (const run of records) {
          runs.set(run.id, run);
        }
        const byDispatch = new Map<string, AgentRunLike[]>();
        for (const run of records) {
          const key = `${run.instanceId}\u0000${run.nodeId}\u0000${run.workspaceId}`;
          const list = byDispatch.get(key) ?? [];
          list.push(run);
          byDispatch.set(key, list);
        }
        for (const list of byDispatch.values()) {
          const sorted = [...list].sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          );
          const firstSuccess = sorted.find((run) => run.status === "succeeded");
          if (firstSuccess === undefined) continue;
          for (const run of sorted) {
            if (run.status === "failed" || run.status === "timeout") {
              if (run.createdAt < firstSuccess.createdAt) {
                newerSuccess.add(run.id);
              }
            }
          }
        }
      }
    }
    return {
      tasks: { byId: taskById },
      instances: instancesById,
      runs,
      newerSuccess,
    };
  }

  private liveStateFor(
    item: BriefItemRecord,
    snapshot: BriefDataSnapshot,
    now: Date,
    tzOffsetMinutes: number,
  ): BriefLiveState {
    const condition = item.condition;
    if (condition.kind === "run-terminal") {
      // 兼容两种口径：早期按 runId 记录，聚合后按 taskId 记录。
      const run = snapshot.runs.get(condition.refId);
      if (run !== undefined) {
        if (snapshot.newerSuccess.has(run.id)) {
          return { active: false, resolved: true };
        }
        return TERMINAL_RUN_STATUSES.has(run.status)
          ? { active: true, resolved: false }
          : { active: false, resolved: true };
      }
      const task = snapshot.tasks.byId.get(condition.refId);
      if (task === undefined) return { active: false, resolved: true };
      const unresolvedFailure = task.agentRunIds
        .map((runId) => snapshot.runs.get(runId))
        .some(
          (candidate) =>
            candidate !== undefined &&
            TERMINAL_RUN_STATUSES.has(candidate.status) &&
            !snapshot.newerSuccess.has(candidate.id),
        );
      if (unresolvedFailure) return { active: true, resolved: false };
      return { active: false, resolved: true };
    }
    if (condition.kind === "workflow-blocked") {
      const instance = snapshot.instances.get(condition.refId);
      if (instance === undefined) return { active: false, resolved: true };
      if (instance.status === "completed" || instance.status === "cancelled") {
        return { active: false, resolved: true };
      }
      return { active: true, resolved: false };
    }
    if (
      condition.kind === "workflow-approval" ||
      condition.kind === "task-escalation"
    ) {
      const task = snapshot.tasks.byId.get(condition.refId);
      if (task === undefined) return { active: false, resolved: true };
      if (
        task.status === "done" ||
        task.status === "cancelled" ||
        task.archivedAt !== undefined
      ) {
        return { active: false, resolved: true };
      }
      const reason = this.escalationFor(task, now, tzOffsetMinutes);
      return { active: reason !== undefined, resolved: false };
    }
    const task = snapshot.tasks.byId.get(condition.refId);
    if (task === undefined) return { active: false, resolved: true };
    if (task.status === "review") return { active: true, resolved: false };
    return { active: false, resolved: true };
  }

  /**
   * 最近 24h 内的催办记录（取最新一条）。
   * 「被催办」= 派我活的人在等我，应该出现在被催办的人自己的简报里。
   */
  private latestNudgeWithinDay(
    task: TaskRecordLike,
    now: Date,
  ): { readonly actorName: string; readonly at: string } | undefined {
    const since = now.getTime() - DAY_MS;
    let latest: { actorName: string; at: string } | undefined;
    for (const event of task.events ?? []) {
      if (event.kind !== "nudge") continue;
      const at = parseOrNull(event.at);
      if (!Number.isFinite(at) || at < since) continue;
      if (latest === undefined || event.at > latest.at) {
        latest = { actorName: event.actorName ?? "派出方", at: event.at };
      }
    }
    return latest;
  }

  private escalationFor(
    task: TaskRecordLike,
    now: Date,
    tzOffsetMinutes: number,
  ): { reason: string; score: number; fromNudge?: boolean } | undefined {
    if (task.archivedAt !== undefined) return undefined;
    if (task.status === "done" || task.status === "cancelled") return undefined;
    const today = localDayStamp(now, tzOffsetMinutes);
    const updated = parseOrNull(task.updatedAt);
    const waitingMs = Number.isFinite(updated) ? now.getTime() - updated : 0;
    if (task.due !== undefined && task.due !== "") {
      if (task.due < today) {
        const dueEnd = Date.parse(`${task.due}T23:59:59.999Z`);
        const overdueMs = Number.isFinite(dueEnd)
          ? now.getTime() - dueEnd
          : waitingMs;
        return {
          reason: `已逾期 ${formatHours(Math.max(overdueMs, 3_600_000))}`,
          score: priorityScore.overdue(Math.max(overdueMs, 0)),
        };
      }
      if (task.due === today) {
        return {
          reason: "今日截止",
          score: priorityScore.priorityTask(waitingMs),
        };
      }
    }
    if (
      task.workflow?.approvalPolicy !== undefined &&
      task.status === "review" &&
      waitingMs > DAY_MS
    ) {
      return {
        reason: `审批已等待 ${formatHours(waitingMs)}`,
        score: priorityScore.blocked(waitingMs),
      };
    }
    // 被催办：不管优先级高低，都要让被催办的人在自己的简报里看到这条任务。
    const nudge = this.latestNudgeWithinDay(task, now);
    if (nudge !== undefined) {
      return {
        reason: `被 ${nudge.actorName} 催办`,
        score: priorityScore.nudged(waitingMs),
        fromNudge: true,
      };
    }
    if (ESCALATION_PRIORITIES.has(task.priority)) {
      return {
        reason: `${priorityLabel(task.priority)} 高优先级任务`,
        score: priorityScore.priorityTask(waitingMs),
      };
    }
    return undefined;
  }

  private briefCandidates(
    principal: WorkbenchPrincipal,
    options: ModuleOptions,
    window: AwayWindow,
    snapshot: BriefDataSnapshot,
  ): BriefCandidate[] {
    const now = this.now();
    const fromMs = Date.parse(window.from);
    const { workspaces, byId: workspaceById } = this.workspaceMap(principal);
    const candidates: BriefCandidate[] = [];
    const agents = this.deps.agents?.();
    const workflows = this.deps.workflows?.();
    void options;

    const executorFor = (run: AgentRunLike): { name: string; role: string } => {
      const employees = this.deps.employees?.();
      if (run.employeeId !== undefined && employees !== undefined) {
        try {
          const employee = employees.get(run.employeeId);
          return {
            name: employee.displayName,
            role:
              run.principalType === "digital-employee"
                ? "数字员工"
                : "执行员工",
          };
        } catch {
          // fall through to profile lookup
        }
      }
      if (agents !== undefined) {
        const profile = agents.profile(run.workspaceId, run.agentProfileId);
        if (profile !== undefined) {
          return { name: profile.name, role: "执行 Profile" };
        }
      }
      return {
        name: run.personaId ?? run.agentProfileId,
        role: "执行角色",
      };
    };

    // A. 风险与异常：按实例聚合（同一实例的多条事件合并为一条，保留可溯源链接）
    const workflowRisks = new Map<
      string,
      {
        instance: WorkflowInstanceLike;
        events: WorkflowEventLike[];
        runs: AgentRunLike[];
      }
    >();
    const taskRunRisks = new Map<
      string,
      { task: TaskRecordLike; runs: AgentRunLike[] }
    >();

    if (agents !== undefined) {
      for (const workspace of workspaces) {
        let runs: readonly AgentRunLike[] = [];
        try {
          runs = agents.runs({
            workspaceId: workspace.id,
            statuses: ["failed", "timeout", "cancelled", "interrupted"],
          });
        } catch {
          continue;
        }
        for (const run of runs) {
          if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
          const atMs = parseOrNull(run.endedAt ?? run.updatedAt);
          if (!Number.isFinite(atMs) || atMs < fromMs) continue;
          if (snapshot.newerSuccess.has(run.id)) continue;
          if (run.source === "workflow") {
            const instance = snapshot.instances.get(run.instanceId);
            if (instance === undefined) continue;
            if (!workspaceById.has(instance.workspaceId)) continue;
            const group = workflowRisks.get(instance.id) ?? {
              instance,
              events: [],
              runs: [],
            };
            group.runs.push(run);
            workflowRisks.set(instance.id, group);
            continue;
          }
          const task = snapshot.tasks.byId.get(run.instanceId);
          if (task === undefined) continue;
          if (!workspaceById.has(task.workspaceId)) continue;
          const group = taskRunRisks.get(task.id) ?? { task, runs: [] };
          group.runs.push(run);
          taskRunRisks.set(task.id, group);
        }
      }
    }

    if (workflows !== undefined) {
      for (const instance of snapshot.instances.values()) {
        if (!workspaceById.has(instance.workspaceId)) continue;
        let events: readonly WorkflowEventLike[] = [];
        try {
          events = workflows.events(instance.id);
        } catch {
          continue;
        }
        for (const event of events) {
          if (!FLOW_BLOCKING_EVENT_KINDS.has(event.kind)) continue;
          const atMs = parseOrNull(event.at);
          if (!Number.isFinite(atMs) || atMs < fromMs) continue;
          const group = workflowRisks.get(instance.id) ?? {
            instance,
            events: [],
            runs: [],
          };
          group.events.push(event);
          workflowRisks.set(instance.id, group);
        }
      }
    }

    for (const group of workflowRisks.values()) {
      const components = [
        ...group.events.map((event) => {
          const at = parseOrNull(event.at) ?? now.getTime();
          const label = WORKFLOW_EVENT_LABEL[event.kind] ?? event.kind;
          return {
            at,
            label,
            detail: clip(event.message, 200),
            actor: event.actorName,
            role:
              event.actorKind === "agent"
                ? "执行角色"
                : event.actorKind === "system"
                  ? "系统"
                  : "执行人",
            nodeId: event.nodeId,
            score:
              event.kind === "agent.ticket_denied"
                ? priorityScore.permissionOrBudget()
                : event.kind.startsWith("agent.")
                  ? priorityScore.runTerminal()
                  : priorityScore.blocked(Math.max(0, now.getTime() - at)),
          };
        }),
        ...group.runs.map((run) => {
          const executor = executorFor(run);
          return {
            at: parseOrNull(run.endedAt ?? run.updatedAt) ?? now.getTime(),
            label: `Agent Run ${AGENT_RUN_STATUS_LABEL[run.status]}`,
            detail: clip(run.error ?? "", 200),
            actor: executor.name,
            role: executor.role,
            nodeId: run.nodeId,
            score: priorityScore.runTerminal(),
          };
        }),
      ].sort((left, right) => right.at - left.at);
      if (components.length === 0) continue;
      const counts = new Map<string, number>();
      for (const component of components) {
        counts.set(component.label, (counts.get(component.label) ?? 0) + 1);
      }
      const kindSummary = [...counts.entries()]
        .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
        .join("、");
      const latest = components[0]!;
      const nodeName =
        latest.nodeId === undefined
          ? undefined
          : this.nodeName(group.instance, latest.nodeId);
      const workspace = workspaceById.get(group.instance.workspaceId);
      candidates.push({
        itemId: `A:workflow:${group.instance.id}`,
        section: "risk",
        tag: "data",
        title: `${group.instance.title}${nodeName === undefined ? "" : ` · ${nodeName}`} · ${
          components.length > 1 ? `异常 ${components.length} 项` : latest.label
        }`,
        conclusion:
          components.length > 1
            ? `${components.length} 条异常记录（${kindSummary}）；最近一条：${latest.detail === "" ? latest.label : latest.detail}`
            : `${latest.label}：${latest.detail === "" ? "见流程详情" : latest.detail}`,
        reason: `入选原因：在你有权访问的项目「${this.workspaceName(workspace)}」中，工作流「${group.instance.title}」在离开窗口内出现 ${components.length} 条异常（${kindSummary}），最近一条发生在约 ${formatHours(Math.max(0, now.getTime() - latest.at))}前。`,
        executorName: latest.actor ?? "系统",
        executorRole: latest.role,
        sourceDomain: "workflow",
        sourceId: group.instance.id,
        statusLabel: latest.label,
        actionLabel: "查看流程",
        priorityScore: Math.max(...components.map((item) => item.score)),
        occurredAt: new Date(latest.at).toISOString(),
        deepLink: {
          route: "workflow",
          refId: group.instance.id,
          workspaceId: group.instance.workspaceId,
          label: "查看流程",
        },
        workspaceId: group.instance.workspaceId,
        workspaceName: this.workspaceName(workspace),
        condition: { kind: "workflow-blocked", refId: group.instance.id },
      });
    }

    for (const group of taskRunRisks.values()) {
      const components = group.runs
        .map((run) => {
          const executor = executorFor(run);
          return {
            at: parseOrNull(run.endedAt ?? run.updatedAt) ?? now.getTime(),
            label: `Agent Run ${AGENT_RUN_STATUS_LABEL[run.status]}`,
            detail: clip(run.error ?? "", 200),
            actor: executor.name,
            role: executor.role,
          };
        })
        .sort((left, right) => right.at - left.at);
      if (components.length === 0) continue;
      const latest = components[0]!;
      const counts = new Map<string, number>();
      for (const component of components) {
        counts.set(component.label, (counts.get(component.label) ?? 0) + 1);
      }
      const kindSummary = [...counts.entries()]
        .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
        .join("、");
      const workspace = workspaceById.get(group.task.workspaceId);
      candidates.push({
        itemId: `A:task:${group.task.id}`,
        section: "risk",
        tag: "data",
        title: `${group.task.title} · ${
          components.length > 1
            ? `执行异常 ${components.length} 次`
            : latest.label
        }`,
        conclusion:
          components.length > 1
            ? `${components.length} 次执行异常（${kindSummary}）；最近一条：${latest.detail === "" ? latest.label : latest.detail}`
            : `${latest.label}：${latest.detail === "" ? "见任务详情" : latest.detail}`,
        reason: `入选原因：任务 ${group.task.id}「${group.task.title}」在离开窗口内出现 ${components.length} 次执行异常（${kindSummary}），且此后没有成功运行；该任务在你有权访问的项目「${this.workspaceName(workspace)}」中。`,
        executorName: latest.actor,
        executorRole: latest.role,
        sourceDomain: "agent-run",
        sourceId: group.task.id,
        statusLabel: latest.label,
        actionLabel: "查看任务",
        priorityScore: priorityScore.runTerminal(),
        occurredAt: new Date(latest.at).toISOString(),
        deepLink: {
          route: "task",
          refId: group.task.id,
          workspaceId: group.task.workspaceId,
          label: "查看任务",
        },
        workspaceId: group.task.workspaceId,
        workspaceName: this.workspaceName(workspace),
        condition: { kind: "run-terminal", refId: group.task.id },
      });
    }

    // B. 需要升级关注的任务（当前快照，与窗口无关）
    const agentIds = this.myAgentIds(principal);
    for (const workspace of workspaces) {
      const roleSeats = this.myRoleSeats(principal, workspace.id);
      for (const task of snapshot.tasks.byId.values()) {
        if (task.workspaceId !== workspace.id) continue;
        if (!this.ownsTask(principal, task, agentIds, roleSeats)) continue;
        const escalation = this.escalationFor(
          task,
          now,
          options.tzOffsetMinutes,
        );
        if (escalation === undefined) continue;
        const approval = task.workflow?.approvalPolicy !== undefined;
        const updated = parseOrNull(task.updatedAt);
        const waitingMs = Number.isFinite(updated)
          ? Math.max(0, now.getTime() - updated)
          : 0;
        candidates.push({
          itemId: `B:task:${task.id}`,
          section: "escalation",
          // 只被催办（不是逾期/审批等待/高优先级）的条目，标签要说清是「被催办」。
          tag: escalation.fromNudge === true ? "nudge" : "decision",
          title: task.title,
          conclusion: `${task.type} · ${STATUS_LABEL[task.status]} · ${escalation.reason}`,
          reason: approval
            ? `入选原因：工作流「${task.workflow?.instanceTitle ?? "—"}」的审批节点「${task.workflow?.nodeName ?? "—"}」已等待约 ${formatHours(waitingMs)}，超过升级阈值（${escalation.reason}），需要你处理。`
            : `入选原因：任务 ${task.id} 当前为「${STATUS_LABEL[task.status]}」，命中升级规则（${escalation.reason}），需要你处置。`,
          executorName: task.receiverName ?? task.receiverId ?? "待指派",
          executorRole: approval ? "审批人" : "接收人",
          sourceDomain: task.workflow === undefined ? "task" : "workflow",
          sourceId: task.id,
          statusLabel: STATUS_LABEL[task.status],
          actionLabel: approval ? "处理审批" : "处置任务",
          escalateReason: escalation.reason,
          suggestion: approval
            ? {
                headline: "建议：今日处理该审批",
                body: `该审批已等待 ${formatHours(waitingMs)}，节点「${task.workflow?.nodeName ?? "审批"}」持续阻塞；处理后将按流程规则自动推进。依据：${task.workflow?.instanceTitle ?? "工作流"}（${task.workflow?.instanceId ?? "—"}）。`,
              }
            : {
                headline: "建议：今日完成并提交验收",
                body: `任务当前为「${STATUS_LABEL[task.status]}」（${escalation.reason}），完成后进入待验收，由你确认交付物。依据：任务 ${task.id} 的截止时间与更新时间。`,
              },
          priorityScore: escalation.score,
          occurredAt: task.updatedAt,
          ...(task.due === undefined || task.due === ""
            ? {}
            : { deadline: task.due }),
          deepLink: {
            route: "task",
            refId: task.id,
            workspaceId: workspace.id,
            label: "打开任务",
          },
          workspaceId: workspace.id,
          workspaceName: this.workspaceName(workspace),
          condition: {
            kind: approval ? "workflow-approval" : "task-escalation",
            refId: task.id,
          },
        });
      }
    }

    // C. 夜间关键结论：离开窗口内完成、交付物仍待人工验收
    for (const task of snapshot.tasks.byId.values()) {
      if (task.status !== "review") continue;
      const workspace = workspaceById.get(task.workspaceId);
      if (workspace === undefined) continue;
      const agentIdsForTask = agentIds;
      const roleSeats = this.myRoleSeats(principal, task.workspaceId);
      if (!this.ownsTask(principal, task, agentIdsForTask, roleSeats)) continue;
      const run = [...task.agentRunIds]
        .map((runId) => snapshot.runs.get(runId))
        .filter((item): item is AgentRunLike => item !== undefined)
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )[0];
      if (run === undefined || run.status !== "succeeded") continue;
      const at = run.endedAt ?? run.updatedAt;
      const atMs = parseOrNull(at);
      if (!Number.isFinite(atMs) || atMs < fromMs) continue;
      if (!this.runHasExplicitProfile(run)) continue;
      const executor = executorFor(run);
      const summary = run.output?.summary?.trim() ?? "";
      const conclusion =
        summary === ""
          ? `${executor.name} 已完成「${task.title}」，交付物等待你验收。`
          : clip(summary, 4_000);
      const relatedInstance =
        run.source === "workflow"
          ? snapshot.instances.get(run.instanceId)
          : undefined;
      candidates.push({
        // 条目身份按任务收敛：同一任务重跑只保留一条待验收结论，
        // 否则验收一次会让多条重复条目同时闭环。
        itemId: `C:task:${task.id}`,
        section: "conclusion",
        // 待验收是任务级状态：标签固定「待我验收」，与右侧「前往验收」按钮一一对应，
        // 不再按结论文本里是否出现「完成」来猜（那会让标签与按钮打架）。
        tag: "review",
        title: task.title,
        conclusion,
        reason: `入选原因：任务 ${task.id}「${task.title}」已由 ${executor.name} 完成并进入待验收，你是它的责任人${
          task.receiverType === "agent" ? "（由你名下的 AI伙伴承接）" : ""
        }，完成时间落在本次离开窗口内。`,
        executorName: executor.name,
        executorRole: executor.role,
        sourceDomain: "agent-run",
        sourceId: run.id,
        statusLabel: "待我验收",
        actionLabel: "前往验收",
        priorityScore: priorityScore.conclusion(
          relatedInstance?.status === "blocked",
        ),
        occurredAt: new Date(atMs).toISOString(),
        deepLink: {
          route: "task",
          refId: task.id,
          workspaceId: workspace.id,
          label: `待验收任务 ${task.id}`,
        },
        workspaceId: workspace.id,
        workspaceName: this.workspaceName(workspace),
        condition: { kind: "task-review", refId: task.id, auxId: run.id },
      });
    }

    return candidates.sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    );
  }

  private nodeName(
    instance: WorkflowInstanceLike,
    nodeId: string,
  ): string | undefined {
    const node = instance.nodes[nodeId];
    if (node === undefined) return undefined;
    return nodeId;
  }

  private runHasExplicitProfile(run: AgentRunLike): boolean {
    if (
      run.principalType === "digital-employee" &&
      run.employeeId !== undefined
    ) {
      const employees = this.deps.employees?.();
      return (
        employees?.activeProfile(run.employeeId, run.workspaceId) !== undefined
      );
    }
    const agents = this.deps.agents?.();
    return agents?.profile(run.workspaceId, run.agentProfileId) !== undefined;
  }

  async briefModule(
    principal: WorkbenchPrincipal,
    options: ModuleOptions,
  ): Promise<
    WorkbenchModule<{
      awayWindow: AwayWindow;
      unreadCount: number;
      summary: string;
      views: { unread: BriefItemRecord[]; all: BriefItemRecord[] };
      settings: {
        mode: "lastLeave" | "manual";
        manualWindowFrom?: string | undefined;
      };
    }>
  > {
    const now = this.now();
    const reader = this.tables.briefReaders.get(principal.userId);
    const window = computeAwayWindow({
      lastMergeAt: reader?.lastMergeAt,
      lastSeenAt: reader?.lastSeenAt,
      manualFrom: reader?.manualWindowFrom,
      now,
      tzOffsetMinutes: options.tzOffsetMinutes,
    });
    const snapshot = this.briefSnapshot(principal);
    const candidates = this.briefCandidates(
      principal,
      options,
      window,
      snapshot,
    );
    const stored = this.readerItems(principal.userId);
    const existing = this.migrateLegacyConclusionItems(
      this.migrateLegacyRiskItems(stored, snapshot),
      snapshot,
    ).map((item) => this.refreshStoredConclusion(item, snapshot));
    const override = new Map(
      candidates.map((candidate) => [
        candidate.itemId,
        { active: true, resolved: false } satisfies BriefLiveState,
      ]),
    );
    const liveState = new Map<string, BriefLiveState>();
    for (const item of existing) {
      liveState.set(
        item.itemId,
        override.get(item.itemId) ??
          this.liveStateFor(item, snapshot, now, options.tzOffsetMinutes),
      );
    }
    const merged = mergeBriefItems({
      readerId: principal.userId,
      existing,
      candidates,
      liveState,
      now,
      tzOffsetMinutes: options.tzOffsetMinutes,
    });
    const retained = new Set(merged.stored.map((item) => item.itemId));
    for (const item of stored) {
      if (retained.has(item.itemId)) continue;
      await this.tables.briefItems.delete(
        briefItemKey(principal.userId, item.itemId),
      );
    }
    for (const item of merged.stored) {
      await this.tables.briefItems.put(
        briefItemKey(principal.userId, item.itemId),
        item,
      );
    }
    await this.tables.briefReaders.put(principal.userId, {
      readerId: principal.userId,
      lastMergeAt: now.toISOString(),
      ...(reader?.lastSeenAt === undefined
        ? {}
        : { lastSeenAt: reader.lastSeenAt }),
      updatedAt: now.toISOString(),
    });
    return {
      id: "brief",
      title: MODULE_TITLES.brief,
      updatedAt: now.toISOString(),
      refreshable: true,
      sourceCount: merged.stored.length,
      staleAt: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      data: {
        awayWindow: window,
        unreadCount: merged.unreadCount,
        summary: briefSummary({ awayWindow: window, items: merged.unread }),
        views: { unread: merged.unread, all: merged.all },
        settings: {
          mode: reader?.briefMode ?? "lastLeave",
          manualWindowFrom: reader?.manualWindowFrom,
        },
      },
    };
  }

  async setBriefSettings(
    principal: WorkbenchPrincipal,
    input: {
      mode: "lastLeave" | "manual";
      manualWindowFrom?: string | undefined;
    },
  ): Promise<{
    mode: "lastLeave" | "manual";
    manualWindowFrom?: string | undefined;
  }> {
    const existing = this.tables.briefReaders.get(principal.userId);
    const now = nowIso(() => this.now());
    await this.tables.briefReaders.put(principal.userId, {
      readerId: principal.userId,
      ...(existing?.lastMergeAt === undefined
        ? {}
        : { lastMergeAt: existing.lastMergeAt }),
      ...(existing?.lastSeenAt === undefined
        ? {}
        : { lastSeenAt: existing.lastSeenAt }),
      briefMode: input.mode,
      ...(input.mode === "manual" && input.manualWindowFrom !== undefined
        ? { manualWindowFrom: input.manualWindowFrom }
        : {}),
      updatedAt: now,
    });
    return {
      mode: input.mode,
      ...(input.mode === "manual" && input.manualWindowFrom !== undefined
        ? { manualWindowFrom: input.manualWindowFrom }
        : {}),
    };
  }

  async markBriefRead(
    principal: WorkbenchPrincipal,
    itemId: string,
    options: ModuleOptions,
  ): Promise<boolean> {
    const key = briefItemKey(principal.userId, itemId);
    const item = this.tables.briefItems.get(key);
    if (item === undefined) return false;
    if (item.readState === "unread") {
      const now = nowIso(() => this.now());
      await this.tables.briefItems.put(key, {
        ...item,
        readState: "read",
        readAt: now,
        readVia: "click",
        updatedAt: now,
      });
    }
    void options;
    return true;
  }

  private touchReader(principal: WorkbenchPrincipal): void {
    const existing = this.tables.briefReaders.get(principal.userId);
    const now = nowIso(() => this.now());
    void this.tables.briefReaders.put(principal.userId, {
      readerId: principal.userId,
      ...(existing?.lastMergeAt === undefined
        ? {}
        : { lastMergeAt: existing.lastMergeAt }),
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  async module<T = unknown>(
    principal: WorkbenchPrincipal,
    moduleId: ModuleId,
    options: ModuleOptions,
  ): Promise<WorkbenchModule<T>> {
    const now = this.now().toISOString();
    try {
      switch (moduleId) {
        case "metrics":
          return this.metricsModule(principal) as WorkbenchModule<T>;
        case "brief":
          return (await this.briefModule(
            principal,
            options,
          )) as WorkbenchModule<T>;
        case "todo":
          return this.todoModule(principal) as WorkbenchModule<T>;
        case "focus":
          return this.focusModule(principal) as WorkbenchModule<T>;
        case "meeting-minutes":
          return this.meetingsModule(principal) as WorkbenchModule<T>;
        case "control":
          return this.controlModule(principal) as WorkbenchModule<T>;
        case "supplier":
          return this.supplierModule(principal) as WorkbenchModule<T>;
        default:
          throw new WorkbenchError("not_found", "unknown workbench module");
      }
    } catch (error) {
      const message =
        error instanceof WorkbenchError
          ? error.message
          : error instanceof Error
            ? error.message
            : "模块加载失败";
      return {
        id: moduleId,
        title: MODULE_TITLES[moduleId],
        updatedAt: now,
        refreshable: true,
        error: message,
      };
    }
  }

  async summary(
    principal: WorkbenchPrincipal,
    options: ModuleOptions,
  ): Promise<{
    userId: string;
    generatedAt: string;
    modules: Record<ModuleId, WorkbenchModule<unknown>>;
  }> {
    this.touchReader(principal);
    const modules = {} as Record<ModuleId, WorkbenchModule<unknown>>;
    for (const moduleId of MODULE_IDS) {
      modules[moduleId] = await this.module(principal, moduleId, options);
    }
    return {
      userId: principal.userId,
      generatedAt: nowIso(() => this.now()),
      modules,
    };
  }
}

export class WorkbenchError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

export interface TodoItemPayload {
  id: string;
  /** 展示用编号（任务即 TSK-…）。 */
  displayId: string;
  title: string;
  priority: string;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  source: "workflow" | "regular";
  workspaceId: string;
  workspaceName: string;
  receiverType: string;
  receiverName: string;
  due: string;
  updatedAt: string;
  deepLink: { route: "task"; refId: string; workspaceId: string };
}

export interface FocusItemPayload {
  kind: "task" | "workflow" | "meeting";
  id: string;
  /** 展示用编号：任务为 TSK-…，工作流为 WF-XXXXXX 短码。 */
  displayId: string;
  title: string;
  priority: string;
  priorityLabel: string;
  status: string;
  statusLabel: string;
  currentNodeLabel?: string | undefined;
  workspaceId: string;
  workspaceName: string;
  receiverType: string;
  receiverName: string;
  due: string;
  updatedAt: string;
  /** 最近一条关键结论 / 状态更新，用于「重点关注」的紧凑展示。 */
  summary: string;
  /** 这条为什么算已关注：直接关注或工作流 / 项目覆盖来源。 */
  coveredBy: FollowCoverRef[];
  deepLink: {
    route: "task" | "workflow" | "meeting";
    refId: string;
    workspaceId: string;
  };
}

export interface MeetingMinutesPayload {
  id: string;
  title: string;
  /** 会议关键信息摘要（取散会纪要的前 1-2 句）。 */
  summaryText: string;
  status: "active" | "closed";
  statusLabel: string;
  workspaceId: string;
  workspaceName: string;
  participantCount: number;
  /** 除用户本人/自己的分身/Facilitator 外的参会人数。 */
  otherParticipantCount: number;
  /**
   * 参会人：席位解析后的显示名 + active/pending/left 状态；owned 标记本人或本人分身。
   */
  agents: {
    refId: string;
    name: string;
    kind: "human" | "agent";
    owned: boolean;
    isFacilitator: boolean;
    status: string;
    isHost: boolean;
  }[];
  updatedAt: string;
  /**
   * Where `summaryText` came from. The convergence order is:
   * `confirmed` -> `pending_confirm` -> `legacy_run` -> `close_summary` -> `none`.
   */
  minutesSource:
    | "confirmed"
    | "pending_confirm"
    | "legacy_run"
    | "close_summary"
    | "none";
  /** True when `summaryText` is an unconfirmed agenda version. */
  minutesPending: boolean;
  /** Backward-compatible flag: the summary came from AI minutes (any source
   * except the hand-written close summary). */
  aiSummary: boolean;
  deepLink: { route: "meeting"; refId: string; workspaceId: string };
}

export interface ProjectPayload {
  id: string;
  name: string;
  followed: boolean;
  taskCount: number;
  workflowCount: number;
  meetingCount: number;
  updatedAt: string;
}

function workflowStatusLabel(status: WorkflowInstanceLike["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待中";
    case "blocked":
      return "阻塞";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

