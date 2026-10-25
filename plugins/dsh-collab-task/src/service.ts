import { randomUUID } from "node:crypto";
import { z } from "zod";
import { taskExecutionPolicySchema } from "@pluginmax/contracts";
import {
  taskCommentSchema,
  taskEventSchema,
  taskRecordSchema,
  taskReplySchema,
  taskMessageSchema,
  taskMentionSchema,
  taskStepSchema,
  taskStatusSchema,
  taskDeliveryTargetSchema,
  type TaskDeliveryTarget,
  type TaskExecutionMetadata,
  type TaskRecord,
  type TaskStatus,
  taskWorkflowRefSchema,
} from "./types.js";

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  get size(): number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface TaskTables {
  readonly tasks: KvTableLike<TaskRecord>;
}

export interface TaskActor {
  readonly id: string;
  readonly name: string;
  readonly kind: "human" | "agent" | "system";
  readonly role?: "admin" | "owner" | "member" | "guest" | undefined;
  readonly principalId?: string | undefined;
}

interface PrincipalRecordLike {
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly status: "active" | "suspended" | "archived";
}

export interface TaskPrincipalServiceLike {
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

export interface TaskAgentRun {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId?: string | undefined;
  readonly principalId?: string | undefined;
  /** 派发时写入的上下文：run 角色 / 执行者身份，结算回写时要用。 */
  readonly payload?:
    | {
        readonly context?: Record<string, string | number | boolean>;
      }
    | undefined;
  readonly status:
    | "queued"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  readonly execution?: TaskExecutionMetadata | undefined;
  readonly output?: { readonly summary: string } | undefined;
  readonly error?: string | undefined;
}

export interface WorkflowTaskEventProjection {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId?: string | undefined;
  readonly actorId: string;
  readonly actorKind: "user" | "agent" | "employee" | "system";
  readonly actorName: string;
  readonly message: string;
  readonly at: string;
}

export class TaskError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

export interface WorkflowTaskActionHandler {
  assign(task: TaskRecord, actor: TaskActor): Promise<void> | void;
  assigned?(task: TaskRecord, actor: TaskActor): Promise<void> | void;
  decide(
    task: TaskRecord,
    actor: TaskActor,
    decision: "approved" | "rejected",
  ): Promise<void> | void;
  submit(task: TaskRecord, actor: TaskActor): Promise<void> | void;
  reconcile?(
    task: TaskRecord,
  ):
    | Promise<"approved" | "rejected" | "cancelled" | "superseded" | undefined>
    | ("approved" | "rejected" | "cancelled" | "superseded" | undefined);
  refreshReceiver?(task: TaskRecord): Promise<void> | void;
  events?(
    task: TaskRecord,
  ):
    | Promise<readonly WorkflowTaskEventProjection[]>
    | readonly WorkflowTaskEventProjection[];
}

const createInputSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  type: z.string().min(1).max(80).default("任务"),
  priority: z.enum(["P1", "P2", "P3"]),
  status: taskStatusSchema.default("todo"),
  receiverType: z.enum(["unassigned", "human", "agent", "role"]),
  receiverId: z.string().max(240).optional(),
  receiverName: z.string().max(200).optional(),
  description: z.string().min(1).max(20000),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(30),
  executionPolicy: taskExecutionPolicySchema.optional(),
  due: z.string().max(40).optional(),
  links: z
    .array(
      z.object({
        type: z.enum(["meeting", "workflow"]),
        id: z.string().min(1).max(200),
        label: z.string().min(1).max(300),
      }),
    )
    .default([]),
  autoSubmitReview: z.boolean().default(true),
  autoApproveReview: z.boolean().optional(),
  workflow: taskWorkflowRefSchema.optional(),
});

const updateInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  title: z.string().min(1).max(500),
  priority: z.enum(["P1", "P2", "P3"]),
  description: z.string().min(1).max(20000),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(30),
  executionPolicy: taskExecutionPolicySchema.optional(),
  due: z.string().max(40).optional(),
  autoSubmitReview: z.boolean().optional(),
});

const reviewApprovalInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  autoApproveReview: z.boolean(),
});

const assignInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  receiverType: z.enum(["unassigned", "human", "agent", "role"]),
  receiverId: z.string().max(240).optional(),
  receiverName: z.string().max(200).optional(),
});

const statusInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  status: taskStatusSchema,
});

const messageInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  content: z.string().min(1).max(20000),
  mentions: z.array(taskMentionSchema).max(20).default([]),
  deliveryTarget: taskDeliveryTargetSchema.optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(300),
        size: z.number().int().nonnegative().optional(),
        mimeType: z.string().min(1).max(200).optional(),
        storedPath: z.string().min(1).max(500).optional(),
      }),
    )
    .default([]),
});

/**
 * 新客户端显式传 deliveryTarget；旧客户端未传时按历史 @ 语义降级推断。
 * 一旦显式传值，服务端不再从 mentions 猜测责任人是否应被触发。
 */
export function resolveTaskDeliveryTarget(
  task: Pick<TaskRecord, "receiverId">,
  mentions: readonly { readonly id: string }[],
  requested?: TaskDeliveryTarget | undefined,
): TaskDeliveryTarget {
  if (requested !== undefined) return requested;
  if (mentions.length === 0) return "receiver";
  const mentionsReceiver =
    task.receiverId !== undefined &&
    mentions.some((mention) => mention.id === task.receiverId);
  if (!mentionsReceiver) return "collaborators";
  return mentions.length === 1 ? "receiver" : "broadcast";
}

const sessionResetInputSchema = z.object({
  taskId: z.string().min(1).max(160),
});

const commentInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  content: z.string().min(1).max(8000),
  isKeyConsensus: z.boolean().default(false),
});

const replyInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  commentId: z.string().min(1).max(160),
  content: z.string().min(1).max(8000),
});

const stepInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  stepId: z.string().min(1).max(160),
  done: z.boolean(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TaskError("invalid_input", "request input is invalid");
  }
  return result.data;
}

function tableValues<V>(table: KvTableLike<V>): V[] {
  return Array.from(table.entries(), ([, value]) => value);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function taskId(): string {
  return `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}

function parseTask(value: unknown): TaskRecord {
  const result = taskRecordSchema.safeParse(value);
  if (!result.success) {
    throw new TaskError("invalid_input", "stored task is invalid");
  }
  const task = result.data;
  // 历史人类工作流任务没有这个开关；按新的产品语义推导为提交后自动完成。
  // 显式存成 false 的新数据不会被覆盖，因此用户仍可关闭自动验收。
  if (
    value !== null &&
    typeof value === "object" &&
    !("autoApproveReview" in value) &&
    task.receiverType === "human" &&
    task.workflow !== undefined &&
    task.workflow.approvalPolicy === undefined
  ) {
    return { ...task, autoApproveReview: true };
  }
  return task;
}

function progressForSteps(steps: TaskRecord["steps"]): number {
  if (steps.length === 0) return 0;
  return Math.round(
    (steps.filter((step) => step.done).length / steps.length) * 100,
  );
}

function isSettled(task: TaskRecord): boolean {
  return task.status === "done" || task.status === "cancelled";
}

function requireOpen(task: TaskRecord): TaskRecord {
  if (isSettled(task)) {
    throw new TaskError(
      "conflict",
      task.status === "cancelled" ? "任务已取消" : "任务已完成",
    );
  }
  return task;
}

/**
 * 「追加要求并重开一轮」的入口条件：已完成的任务允许被追加指令 / 改写内容 /
 * 重新指派，这些动作都表示还有下一轮要跑，所以会先重开为待处理；
 * 取消态不可逆，归档态要先复原。
 */
function requireContinuable(task: TaskRecord): TaskRecord {
  if (task.status === "cancelled") {
    throw new TaskError("conflict", "任务已取消");
  }
  return task;
}

// ---------------------------------------------------------------- 队列排序

/**
 * 队列排序与出队判定：纯函数，便于单测与跨模块复用。
 *
 * 排序口径（与产品文档一致）：
 * - 人工 queueSeq 为准；
 * - 没有人工顺序时用 draft：优先级 → 截止时间 → 任务 ID；
 * - 同一队列里「有 queueSeq」的任务排在「没有 queueSeq」的任务之前，
 *   因此新任务默认落到队尾，不会插队。
 */
export interface QueueTaskLike {
  readonly id: string;
  readonly status: string;
  readonly priority: string;
  readonly due?: string | undefined;
  readonly queueSeq?: number | undefined;
  readonly queueState?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly autoRunEligible?: boolean | undefined;
  readonly archivedAt?: string | undefined;
}

const QUEUE_PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };

export function compareDraftQueue(
  left: QueueTaskLike,
  right: QueueTaskLike,
): number {
  const byPriority =
    (QUEUE_PRIORITY_RANK[left.priority] ?? 9) -
    (QUEUE_PRIORITY_RANK[right.priority] ?? 9);
  if (byPriority !== 0) return byPriority;
  const leftDue =
    left.due === undefined || left.due === "" ? "9999-99-99" : left.due;
  const rightDue =
    right.due === undefined || right.due === "" ? "9999-99-99" : right.due;
  if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
  return left.id.localeCompare(right.id);
}

export function orderQueue<T extends QueueTaskLike>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => {
    const leftSeq = left.queueSeq;
    const rightSeq = right.queueSeq;
    if (leftSeq !== undefined && rightSeq !== undefined) {
      return leftSeq - rightSeq || compareDraftQueue(left, right);
    }
    if (leftSeq !== undefined) return -1;
    if (rightSeq !== undefined) return 1;
    return compareDraftQueue(left, right);
  });
}

/** 依赖是否满足：dependsOn 里的任务都必须已完成（cancelled 视为未满足）。 */
export function dependenciesSatisfied<T extends QueueTaskLike>(
  task: T,
  byId: ReadonlyMap<string, QueueTaskLike>,
): boolean {
  return (task.dependsOn ?? []).every(
    (dependencyId) => byId.get(dependencyId)?.status === "done",
  );
}

/** 该任务当前能否出队（状态 / 人工暂停 / 自动执行开关 / 依赖）。 */
export function isQueueRunnable<T extends QueueTaskLike>(
  task: T,
  byId: ReadonlyMap<string, QueueTaskLike>,
  options: { readonly autoRun: boolean },
): boolean {
  if (task.archivedAt !== undefined) return false;
  if (task.status !== "todo") return false;
  if (task.queueState === "paused" || task.queueState === "blocked")
    return false;
  if (options.autoRun && task.autoRunEligible === false) return false;
  return dependenciesSatisfied(task, byId);
}

/**
 * 出队判定：实例空闲时取队首可执行任务。
 * autoRun=true 表示「无人值守自动执行」，会额外过滤掉未开启自动执行的任务。
 */
export function pickNextTask<T extends QueueTaskLike>(input: {
  readonly tasks: readonly T[];
  readonly running: boolean;
  readonly autoRun?: boolean;
}): T | undefined {
  if (input.running) return undefined;
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  for (const task of orderQueue(input.tasks)) {
    if (isQueueRunnable(task, byId, { autoRun: input.autoRun === true })) {
      return task;
    }
  }
  return undefined;
}

export class TaskService {
  private workflowActions: WorkflowTaskActionHandler | undefined;

  constructor(
    private readonly tables: TaskTables,
    private readonly options: {
      readonly now?: () => Date;
      /**
       * Best-effort domain hook: fired after every persisted task write so
       * sibling plugins (e.g. the workbench brief) can react to changes.
       */
      readonly onChange?: (task: TaskRecord) => void;
      readonly principals?: () => TaskPrincipalServiceLike | undefined;
    } = {},
  ) {}

  private now(): string {
    return nowIso(this.options.now ?? (() => new Date()));
  }

  private require(taskIdValue: string): TaskRecord {
    const task = this.tables.tasks.get(taskIdValue);
    if (task === undefined) throw new TaskError("not_found", "task not found");
    return parseTask(task);
  }

  private principalForActor(actor: TaskActor): PrincipalRecordLike | undefined {
    const principals = this.options.principals?.();
    if (principals === undefined) return undefined;
    if (actor.principalId !== undefined) {
      return principals.resolveReference(actor.principalId);
    }
    if (actor.kind === "human") {
      return principals.resolveSubject("auth-user", actor.id);
    }
    if (actor.kind === "agent") {
      return (
        principals.resolveSubject("teammate", actor.id) ??
        principals.resolveSubject("employee", actor.id)
      );
    }
    return undefined;
  }

  private normalizeReceiver(input: {
    readonly receiverType: TaskRecord["receiverType"];
    readonly receiverId?: string | undefined;
  }): {
    readonly receiverType: TaskRecord["receiverType"];
    readonly receiverId?: string;
    readonly receiverPrincipalId?: string;
  } {
    if (input.receiverType === "unassigned" || input.receiverId === undefined) {
      return { receiverType: input.receiverType };
    }
    if (input.receiverType === "role") {
      return {
        receiverType: input.receiverType,
        receiverId: input.receiverId,
      };
    }
    const principals = this.options.principals?.();
    const principal = principals?.resolveReference(input.receiverId);
    if (principals === undefined || principal === undefined) {
      return {
        receiverType: input.receiverType,
        receiverId: input.receiverId,
      };
    }
    if (principal.status === "archived") {
      throw new TaskError("conflict", "已归档主体不能接收任务");
    }
    if (principal.kind === "human") {
      const authUserId = principals.preferredSubjectId(principal.id, [
        "auth-user",
      ]);
      return {
        receiverType: "human",
        receiverId: authUserId ?? input.receiverId,
        receiverPrincipalId: principal.id,
      };
    }
    const agentId = principals.preferredSubjectId(principal.id, [
      "teammate",
      "employee",
    ]);
    return {
      receiverType: "agent",
      receiverId: agentId ?? input.receiverId,
      receiverPrincipalId: principal.id,
    };
  }

  private captureReviewSubmitter(
    task: TaskRecord,
  ): NonNullable<TaskRecord["reviewSubmitter"]> {
    return {
      receiverType: task.receiverType,
      ...(task.receiverId === undefined ? {} : { receiverId: task.receiverId }),
      ...(task.receiverPrincipalId === undefined
        ? {}
        : { receiverPrincipalId: task.receiverPrincipalId }),
      ...(task.receiverName === undefined
        ? {}
        : { receiverName: task.receiverName }),
      submittedAt: this.now(),
    };
  }

  /**
   * 兼容升级前已经处于 Review 的任务：旧数据没有负责人快照时，
   * 从最近一次成功的 Agent 交付消息推断原执行人。
   */
  private inferReviewSubmitter(
    task: TaskRecord,
  ): TaskRecord["reviewSubmitter"] | undefined {
    if (task.reviewSubmitter !== undefined) return task.reviewSubmitter;
    const agentMessage = [...task.messages]
      .reverse()
      .find(
        (message) =>
          message.kind === "agent" &&
          message.runId !== undefined &&
          message.state === "succeeded",
      );
    if (agentMessage === undefined) return undefined;
    return {
      receiverType: "agent",
      receiverId: agentMessage.authorId,
      receiverName: agentMessage.authorName,
      submittedAt: agentMessage.at,
    };
  }

  private restoreReviewSubmitter(task: TaskRecord): Partial<TaskRecord> {
    const submitter = this.inferReviewSubmitter(task);
    if (submitter === undefined) return { reviewSubmitter: undefined };
    return {
      receiverType: submitter.receiverType,
      receiverId: submitter.receiverId,
      receiverPrincipalId: submitter.receiverPrincipalId,
      receiverName: submitter.receiverName,
      reviewSubmitter: undefined,
    };
  }

  /** Archived tasks are read-only until they are restored. */
  private requireActive(task: TaskRecord): TaskRecord {
    if (task.archivedAt !== undefined) {
      throw new TaskError("conflict", "任务已归档，请先复原后再操作");
    }
    return task;
  }

  private async put(task: TaskRecord): Promise<TaskRecord> {
    const parsed = parseTask(task);
    const stored = this.tables.tasks.get(parsed.id);
    // 归属项目创建后不可变更：任务一旦落在某个项目上，任何写入都不许换项目
    // （谁都不能把任务挪到别人的项目里，也不能靠改项目绕过项目权限）。
    if (
      stored !== undefined &&
      parseTask(stored).workspaceId !== parsed.workspaceId
    ) {
      throw new TaskError("conflict", "任务归属项目创建后不可变更");
    }
    await this.tables.tasks.put(parsed.id, parsed);
    try {
      this.options.onChange?.(parsed);
    } catch {
      // A failing listener must never break a task write.
    }
    return parsed;
  }

  bindWorkflowActions(handler: WorkflowTaskActionHandler): void {
    this.workflowActions = handler;
  }

  private event(
    task: TaskRecord,
    actor: TaskActor,
    kind: TaskRecord["events"][number]["kind"],
    message: string,
  ): TaskRecord {
    const principal = this.principalForActor(actor);
    const event = taskEventSchema.parse({
      id: randomUUID(),
      at: this.now(),
      actorId: actor.id,
      ...(principal === undefined ? {} : { actorPrincipalId: principal.id }),
      actorName: actor.name,
      kind,
      message,
    });
    return { ...task, events: [...task.events, event] };
  }

  list(workspaceId: string): TaskRecord[] {
    return tableValues(this.tables.tasks)
      .map(parseTask)
      .filter((task) => task.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * 项目角色下线：把仍活跃、指向该角色的任务转为「需改派」。
   * 已完成 / 已取消 / 已归档任务保留历史快照；受实例快照保护的工作流任务跳过。
   */
  async markRoleUnavailable(
    workspaceId: string,
    roles: ReadonlyMap<string, string>,
    skipTaskIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    let marked = 0;
    for (const task of this.list(workspaceId)) {
      if (skipTaskIds.has(task.id)) continue;
      if (task.archivedAt !== undefined || task.deletedAt !== undefined) {
        continue;
      }
      if (task.receiverType !== "role" || task.receiverId === undefined) {
        continue;
      }
      if (!["todo", "progress", "review"].includes(task.status)) continue;
      const roleName = roles.get(task.receiverId);
      if (roleName === undefined) continue;
      const {
        receiverId,
        receiverName,
        reassignmentReason: _previousReason,
        ...rest
      } = task;
      let next: TaskRecord = {
        ...rest,
        receiverType: "unassigned",
        receiverState: "needs_reassignment",
        reassignmentReason: `项目角色「${roleName}」已下线`,
        previousReceiver: {
          type: "role",
          id: receiverId,
          name: receiverName ?? roleName,
        },
        updatedAt: this.now(),
      };
      next = this.event(
        next,
        { id: "system", name: "项目角色", kind: "system" },
        "updated",
        `项目角色「${roleName}」已下线，任务需改派`,
      );
      await this.put(next);
      marked += 1;
    }
    return marked;
  }

  get(taskIdValue: string): TaskRecord {
    return this.require(taskIdValue);
  }

  async reconcileWorkflowProjections(workspaceId: string): Promise<void> {
    if (this.workflowActions?.reconcile === undefined) return;
    for (const task of this.list(workspaceId)) {
      if (task.workflow === undefined) continue;
      if (isSettled(task)) {
        if (task.status === "done" && task.workflow.outcome === "cancelled") {
          await this.settleProjection(
            { id: "workflow", name: "工作流", kind: "system" },
            task.id,
            "cancelled",
          );
          continue;
        }
        if (
          task.status === "cancelled" &&
          task.workflow.outcome === "cancelled" &&
          (task.progress === 100 || task.steps.some((step) => step.done))
        ) {
          await this.settleProjection(
            { id: "workflow", name: "工作流", kind: "system" },
            task.id,
            "cancelled",
          );
          continue;
        }
        if (
          task.status === "done" &&
          task.workflow.outcome === "approved" &&
          this.workflowActions.reconcile !== undefined
        ) {
          try {
            const outcome = await this.workflowActions.reconcile(task);
            if (outcome === "cancelled") {
              await this.settleProjection(
                { id: "workflow", name: "工作流", kind: "system" },
                task.id,
                "cancelled",
              );
            }
          } catch {
            // A later refresh can retry the explicit cancellation repair.
          }
        }
        try {
          await this.workflowActions.refreshReceiver?.(task);
        } catch {
          // Display-name repair is best effort and retried on the next refresh.
        }
        continue;
      }
      try {
        const outcome = await this.workflowActions.reconcile(task);
        if (this.workflowActions.events !== undefined) {
          const projections = await this.workflowActions.events(task);
          for (const projection of projections) {
            await this.projectWorkflowEvent(
              { id: "workflow", name: "工作流", kind: "system" },
              task.id,
              projection,
            );
          }
        }
        if (outcome !== undefined) {
          await this.settleProjection(
            { id: "workflow", name: "工作流", kind: "system" },
            task.id,
            outcome,
          );
        }
      } catch {
        // The next refresh can retry without blocking the task list.
      }
    }
  }

  async create(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(createInputSchema, input);
    const receiver = this.normalizeReceiver(parsed);
    const at = this.now();
    const steps = parsed.acceptance.map((label) =>
      taskStepSchema.parse({ id: randomUUID(), label, done: false }),
    );
    const task = taskRecordSchema.parse({
      id: taskId(),
      workspaceId: parsed.workspaceId,
      title: parsed.title,
      type: parsed.type,
      status: parsed.status,
      priority: parsed.priority,
      receiverType: receiver.receiverType,
      ...(receiver.receiverId === undefined
        ? {}
        : { receiverId: receiver.receiverId }),
      ...(receiver.receiverPrincipalId === undefined
        ? {}
        : { receiverPrincipalId: receiver.receiverPrincipalId }),
      ...(parsed.receiverName === undefined
        ? {}
        : { receiverName: parsed.receiverName }),
      createdBy: actor.id,
      createdByName: actor.name,
      description: parsed.description,
      acceptance: parsed.acceptance,
      ...(parsed.executionPolicy === undefined
        ? {}
        : { executionPolicy: parsed.executionPolicy }),
      ...(parsed.due === undefined ? {} : { due: parsed.due }),
      links: parsed.links,
      ...(parsed.workflow === undefined ? {} : { workflow: parsed.workflow }),
      autoSubmitReview: parsed.autoSubmitReview,
      ...(parsed.autoApproveReview === undefined
        ? {}
        : { autoApproveReview: parsed.autoApproveReview }),
      progress: 0,
      steps,
      messages: [],
      comments: [],
      events: [],
      createdAt: at,
      updatedAt: at,
    });
    const withEvent = this.event(
      task,
      actor,
      "created",
      `${actor.name} 创建并派发任务`,
    );
    return this.put(withEvent);
  }

  async update(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(updateInputSchema, input);
    // 已完成的任务允许追加/修改要求：这会重开一轮（见 requireContinuable）。
    const task = requireContinuable(
      this.requireActive(this.require(parsed.taskId)),
    );
    const reopened = task.status === "done";
    if (task.workflow !== undefined) {
      throw new TaskError("conflict", "工作流任务内容由工作流节点同步");
    }
    const steps = parsed.acceptance.map((label, index) =>
      taskStepSchema.parse({
        id: task.steps[index]?.id ?? randomUUID(),
        label,
        done: task.steps[index]?.done ?? false,
      }),
    );
    const updated = await this.put(
      this.event(
        {
          ...task,
          status: reopened ? "todo" : task.status,
          title: parsed.title,
          priority: parsed.priority,
          description: parsed.description,
          acceptance: parsed.acceptance,
          ...(parsed.executionPolicy === undefined
            ? {}
            : { executionPolicy: parsed.executionPolicy }),
          steps,
          progress: progressForSteps(steps),
          ...(parsed.due === undefined
            ? { due: undefined }
            : { due: parsed.due }),
          ...(parsed.autoSubmitReview === undefined
            ? {}
            : { autoSubmitReview: parsed.autoSubmitReview }),
          updatedAt: this.now(),
        },
        actor,
        "updated",
        reopened
          ? `${actor.name} 追加要求，任务重新开启`
          : `${actor.name} 更新了任务内容`,
      ),
    );
    return updated;
  }

  async assign(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(assignInputSchema, input);
    const receiverRef = this.normalizeReceiver(parsed);
    // 已完成的任务被重新指派 = 还有人要接着做，重开一轮后继续。
    const task = requireContinuable(
      this.requireActive(this.require(parsed.taskId)),
    );
    const reopened = task.status === "done";
    if (
      task.workflow?.approvalPolicy !== undefined &&
      parsed.receiverType === "unassigned"
    ) {
      throw new TaskError("conflict", "审批 Task 必须保留审批人");
    }
    if (task.workflow !== undefined) {
      await this.workflowActions?.assign(
        {
          ...task,
          receiverType: receiverRef.receiverType,
          receiverId: receiverRef.receiverId,
          receiverPrincipalId: receiverRef.receiverPrincipalId,
          receiverName:
            receiverRef.receiverType === "unassigned"
              ? undefined
              : parsed.receiverName,
        },
        actor,
      );
    }
    const receiverLabel =
      receiverRef.receiverType === "unassigned"
        ? "待指派"
        : parsed.receiverName?.trim() || receiverRef.receiverId || "未知责任人";
    const { reassignmentReason: _previousReason, ...base } = task;
    const updated = await this.put(
      this.event(
        {
          ...base,
          receiverType: receiverRef.receiverType,
          receiverState: "active",
          receiverId: receiverRef.receiverId,
          receiverPrincipalId: receiverRef.receiverPrincipalId,
          receiverName:
            receiverRef.receiverType === "unassigned"
              ? undefined
              : parsed.receiverName,
          status:
            receiverRef.receiverType === "unassigned" || reopened
              ? "todo"
              : task.status,
          updatedAt: this.now(),
        },
        actor,
        "assigned",
        reopened
          ? `${actor.name} 重新开启任务并调整责任人为 ${receiverLabel}`
          : `${actor.name} 调整责任人为 ${receiverLabel}`,
      ),
    );
    if (task.workflow !== undefined) {
      await this.workflowActions?.assigned?.(updated, actor);
    }
    return updated;
  }

  async claim(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    const task = requireOpen(this.requireActive(this.require(taskIdValue)));
    if (task.receiverType !== "role") {
      throw new TaskError("conflict", "only role tasks can be claimed");
    }
    const principal = this.principalForActor(actor);
    const { reassignmentReason: _previousReason, ...base } = task;
    const updated = this.event(
      {
        ...base,
        receiverType: "human",
        receiverState: "active",
        receiverId: actor.id,
        ...(principal === undefined
          ? {}
          : { receiverPrincipalId: principal.id }),
        receiverName: actor.name,
        status: "progress",
        updatedAt: this.now(),
      },
      actor,
      "claimed",
      `${actor.name} 认领了角色任务`,
    );
    return this.put(updated);
  }

  async changeStatus(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(statusInputSchema, input);
    const task = requireOpen(this.require(parsed.taskId));
    if (task.workflow !== undefined) {
      throw new TaskError("conflict", "工作流任务状态由工作流同步");
    }
    return this.setStatus(actor, task, parsed.status, "状态已更新");
  }

  async start(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    const task = requireOpen(this.require(taskIdValue));
    if (task.workflow !== undefined) {
      throw new TaskError("conflict", "工作流任务状态由工作流同步");
    }
    if (task.receiverType === "role") {
      throw new TaskError("conflict", "角色任务必须先由当前角色成员认领");
    }
    return this.setStatus(actor, task, "progress", "开始处理");
  }

  async submit(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    let task = requireOpen(this.require(taskIdValue));
    if (task.workflow !== undefined) {
      const reviewRequired = task.workflow.reviewRequired !== false;
      if (
        task.autoApproveReview !== true &&
        reviewRequired &&
        task.status === "progress"
      ) {
        return this.setStatus(actor, task, "review", "提交验收");
      }
      await this.workflowActions?.submit(task, actor);
      task = this.require(taskIdValue);
      if (isSettled(task)) return task;
      return this.settleProjection(actor, taskIdValue, "approved");
    }
    return this.submitStandaloneTask(actor, task);
  }

  async approve(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    let task = requireOpen(this.require(taskIdValue));
    if (task.workflow !== undefined) {
      await this.workflowActions?.decide(task, actor, "approved");
      task = this.require(taskIdValue);
      if (isSettled(task)) return task;
      return this.settleProjection(actor, taskIdValue, "approved");
    }
    const approved = await this.setStatus(
      actor,
      {
        ...task,
        steps: task.steps.map((step) => ({ ...step, done: true })),
        progress: 100,
      },
      "done",
      "验收通过",
    );
    return approved;
  }

  /** 工作流执行任务允许单独切换自动验收；审批任务必须保留显式结论。 */
  async updateReviewApproval(
    actor: TaskActor,
    input: unknown,
  ): Promise<TaskRecord> {
    const parsed = parse(reviewApprovalInputSchema, input);
    const task = requireOpen(this.requireActive(this.require(parsed.taskId)));
    if (task.workflow?.approvalPolicy !== undefined) {
      throw new TaskError("conflict", "审批任务不能自动通过");
    }
    if (task.autoApproveReview === parsed.autoApproveReview) return task;
    const updated = await this.put(
      this.event(
        {
          ...task,
          autoApproveReview: parsed.autoApproveReview,
          updatedAt: this.now(),
        },
        actor,
        "updated",
        `${actor.name} ${parsed.autoApproveReview ? "开启" : "关闭"}了自动验收`,
      ),
    );
    if (
      !parsed.autoApproveReview ||
      updated.status !== "review" ||
      updated.workflow === undefined
    ) {
      return updated;
    }
    await this.workflowActions?.submit(updated, actor);
    const settled = this.require(parsed.taskId);
    if (isSettled(settled)) return settled;
    return this.settleProjection(actor, parsed.taskId, "approved");
  }

  async reject(
    actor: TaskActor,
    taskIdValue: string,
    noteValue: unknown,
  ): Promise<TaskRecord> {
    const note = typeof noteValue === "string" ? noteValue.trim() : "";
    if (note === "") {
      throw new TaskError("invalid_input", "退回必须填写退回说明");
    }
    if (note.length > 8_000) {
      throw new TaskError("invalid_input", "退回说明不能超过 8000 个字符");
    }
    let task = requireOpen(this.require(taskIdValue));
    const message = taskMessageSchema.parse({
      id: randomUUID(),
      at: this.now(),
      authorId: actor.id,
      authorName: actor.name,
      kind: actor.kind,
      content: note,
      attachments: [],
      deliveryTarget: "receiver",
    });
    if (task.workflow !== undefined) {
      await this.workflowActions?.decide(task, actor, "rejected");
      task = this.require(taskIdValue);
      task = await this.put(
        this.event(
          {
            ...task,
            messages: [...task.messages, message],
            updatedAt: this.now(),
          },
          actor,
          "status",
          `${actor.name} 退回审批：${note}`,
        ),
      );
      if (isSettled(task)) return task;
      return this.settleProjection(actor, taskIdValue, "rejected");
    }
    const reviewSubmitter = this.inferReviewSubmitter(task);
    return this.put(
      this.event(
        {
          ...task,
          ...this.restoreReviewSubmitter(task),
          status: "progress",
          messages: [...task.messages, message],
          updatedAt: this.now(),
        },
        actor,
        "status",
        `${actor.name} 退回并补充说明：${note}${reviewSubmitter === undefined ? "" : `，负责人恢复为 ${reviewSubmitter.receiverName ?? reviewSubmitter.receiverId ?? "原执行人"}`}`,
      ),
    );
  }

  async projectAssigned(
    actor: TaskActor,
    input: {
      taskId: string;
      receiverType: TaskRecord["receiverType"];
      receiverId?: string | undefined;
      receiverName?: string | undefined;
    },
  ): Promise<TaskRecord> {
    const task = this.requireActive(this.require(input.taskId));
    if (isSettled(task)) return task;
    const receiver = this.normalizeReceiver(input);
    return this.put(
      this.event(
        {
          ...task,
          receiverType: receiver.receiverType,
          receiverId: receiver.receiverId,
          receiverPrincipalId: receiver.receiverPrincipalId,
          receiverName:
            receiver.receiverType === "unassigned"
              ? undefined
              : input.receiverName,
          status: receiver.receiverType === "unassigned" ? "todo" : task.status,
          updatedAt: this.now(),
        },
        actor,
        "assigned",
        `工作流同步负责人：${input.receiverName ?? input.receiverId ?? "待指派"}`,
      ),
    );
  }

  /** Refresh stale display fields without recomputing a completed workflow. */
  async projectReceiverDisplay(
    actor: TaskActor,
    input: {
      taskId: string;
      receiverType: TaskRecord["receiverType"];
      receiverId?: string | undefined;
      receiverName?: string | undefined;
    },
  ): Promise<TaskRecord> {
    const task = this.require(input.taskId);
    const receiver = this.normalizeReceiver(input);
    const receiverId = receiver.receiverId;
    const receiverName =
      input.receiverType === "unassigned" ? undefined : input.receiverName;
    if (
      task.receiverType === receiver.receiverType &&
      task.receiverId === receiverId &&
      task.receiverName === receiverName &&
      task.receiverPrincipalId === receiver.receiverPrincipalId
    ) {
      return task;
    }
    return this.put(
      this.event(
        {
          ...task,
          receiverType: receiver.receiverType,
          receiverId,
          receiverPrincipalId: receiver.receiverPrincipalId,
          receiverName,
        },
        actor,
        "assigned",
        `工作流同步负责人：${receiverName ?? receiverId ?? "待指派"}`,
      ),
    );
  }

  /** Approval Tasks can have several readable approvers even though they use one primary receiver. */
  async projectApprovalApprovers(
    actor: TaskActor,
    input: { taskId: string; approverIds: readonly string[] },
  ): Promise<TaskRecord> {
    const task = this.require(input.taskId);
    if (task.workflow?.approvalPolicy === undefined) {
      throw new TaskError("conflict", "只有审批任务支持同步审批人");
    }
    const approverIds = [...new Set(input.approverIds)].filter(
      (id) => id.trim() !== "",
    );
    const previous = task.workflow.approverIds ?? [];
    if (
      previous.length === approverIds.length &&
      previous.every((id, index) => id === approverIds[index])
    ) {
      return task;
    }
    return this.put(
      this.event(
        {
          ...task,
          workflow: { ...task.workflow, approverIds },
        },
        actor,
        "updated",
        "工作流同步审批人",
      ),
    );
  }

  async settleProjection(
    actor: TaskActor,
    taskIdValue: string,
    outcome: "approved" | "rejected" | "cancelled" | "superseded",
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (isSettled(task) && task.workflow?.outcome !== undefined) {
      if (task.workflow.outcome !== outcome) {
        if (
          task.status === "done" &&
          task.workflow.outcome === "approved" &&
          outcome === "cancelled"
        ) {
          return this.put(
            this.event(
              {
                ...task,
                workflow: { ...task.workflow, outcome },
                status: "cancelled",
                progress: 0,
                steps: task.steps.map((step) => ({
                  ...step,
                  done: false,
                })),
                updatedAt: this.now(),
              },
              actor,
              "closed",
              "修正历史取消状态",
            ),
          );
        }
        throw new TaskError("conflict", "任务已有最终结论");
      }
      if (
        outcome === "cancelled" &&
        task.workflow.outcome === "cancelled" &&
        (task.status === "done" ||
          task.progress === 100 ||
          task.steps.some((step) => step.done))
      ) {
        return this.put(
          this.event(
            {
              ...task,
              status: "cancelled",
              progress: 0,
              steps: task.steps.map((step) => ({ ...step, done: false })),
              updatedAt: this.now(),
            },
            actor,
            "closed",
            "修正历史取消状态",
          ),
        );
      }
      return task;
    }
    if (isSettled(task)) {
      throw new TaskError("conflict", "任务已有最终结论");
    }
    const message =
      outcome === "approved"
        ? "工作流节点完成"
        : outcome === "rejected"
          ? "工作流节点驳回"
          : outcome === "cancelled"
            ? "工作流节点已取消"
            : "节点进入新一轮，任务已被替代";
    return this.put(
      this.event(
        {
          ...task,
          workflow: {
            ...task.workflow!,
            outcome,
          },
          ...(outcome === "cancelled"
            ? {}
            : {
                steps: task.steps.map((step) => ({ ...step, done: true })),
                progress: 100,
              }),
          status: outcome === "cancelled" ? "cancelled" : "done",
          updatedAt: this.now(),
        },
        actor,
        "closed",
        message,
      ),
    );
  }

  async projectStatus(
    actor: TaskActor,
    taskIdValue: string,
    status: "todo" | "progress" | "review",
    message: string,
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (task.workflow === undefined) {
      throw new TaskError("conflict", "只有工作流任务支持状态投影");
    }
    if (isSettled(task)) return task;
    if (task.status === status) return task;
    return this.put(
      this.event(
        {
          ...task,
          status,
          progress:
            status === "review"
              ? Math.max(86, task.progress)
              : status === "progress"
                ? Math.max(task.progress, progressForSteps(task.steps))
                : Math.min(5, task.progress),
          updatedAt: this.now(),
        },
        actor,
        "status",
        message,
      ),
    );
  }

  async projectWorkflowEvent(
    _actor: TaskActor,
    taskIdValue: string,
    input: {
      id: string;
      instanceId: string;
      nodeId?: string | undefined;
      actorId: string;
      actorKind: "user" | "agent" | "employee" | "system";
      actorName: string;
      message: string;
      at: string;
    },
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (task.workflow?.instanceId !== input.instanceId) return task;
    if (input.nodeId !== undefined && task.workflow.nodeId !== input.nodeId) {
      return task;
    }
    if (task.events.some((event) => event.id === input.id)) return task;
    const event = taskEventSchema.parse({
      id: input.id,
      at: input.at,
      actorId: input.actorId,
      actorName: input.actorName,
      kind: "workflow",
      message: input.message.slice(0, 2000),
    });
    return this.put({
      ...task,
      events: [...task.events, event],
      updatedAt: this.now(),
    });
  }

  async projectAgentRun(
    _actor: TaskActor,
    taskIdValue: string,
    run: Pick<
      TaskAgentRun,
      "id" | "status" | "output" | "error" | "execution"
    > & {
      readonly nodeId?: string | undefined;
    },
    receiverName: string,
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (task.workflow === undefined) {
      throw new TaskError("conflict", "只有工作流任务支持执行投影");
    }
    if (run.nodeId !== undefined && run.nodeId !== task.workflow.nodeId) {
      const hasProjection =
        task.agentRunIds.includes(run.id) ||
        task.messages.some((message) => message.runId === run.id);
      if (!hasProjection) return task;
      const agentRunIds = task.agentRunIds.filter((id) => id !== run.id);
      const messages = task.messages.filter(
        (message) => message.runId !== run.id,
      );
      const hasActiveRun = messages.some((message) =>
        ["queued", "running", "waiting_input"].includes(message.state ?? ""),
      );
      return this.put(
        this.event(
          {
            ...task,
            agentRunIds,
            messages,
            status:
              task.status === "progress" && !hasActiveRun
                ? "todo"
                : task.status,
            updatedAt: this.now(),
          },
          { id: "workflow", name: "工作流", kind: "system" },
          "workflow",
          "清理不属于当前节点的 Agent 执行记录",
        ),
      );
    }
    const actor: TaskActor = {
      id: task.receiverId ?? "agent",
      name: receiverName,
      kind: "agent",
    };
    const existing = task.messages.find((message) => message.runId === run.id);
    const content =
      run.status === "succeeded"
        ? run.output?.summary?.trim() || "执行完成，但没有返回文本结果。"
        : ["failed", "timeout", "cancelled", "interrupted"].includes(run.status)
          ? run.error?.trim() || "Agent 执行未完成。"
          : "已接收指令，正在执行…";
    if (
      existing !== undefined &&
      existing.state === run.status &&
      existing.content === content &&
      JSON.stringify(existing.execution) === JSON.stringify(run.execution) &&
      task.agentRunIds.includes(run.id)
    ) {
      return task;
    }
    const message = taskMessageSchema.parse({
      id: existing?.id ?? run.id,
      at: existing?.at ?? this.now(),
      authorId: actor.id,
      authorName: receiverName,
      kind: "agent",
      content,
      attachments: [],
      runId: run.id,
      runRole: "owner",
      ...(run.execution === undefined ? {} : { execution: run.execution }),
      state: run.status,
    });
    const messages =
      existing === undefined
        ? [...task.messages, message]
        : task.messages.map((item) => (item.runId === run.id ? message : item));
    return this.put(
      this.event(
        {
          ...task,
          agentRunIds: task.agentRunIds.includes(run.id)
            ? task.agentRunIds
            : [...task.agentRunIds, run.id],
          messages,
          status:
            task.status === "done" ||
            task.status === "cancelled" ||
            !["queued", "running", "waiting_input"].includes(run.status)
              ? task.status === "progress" &&
                ["failed", "timeout", "cancelled", "interrupted"].includes(
                  run.status,
                )
                ? "todo"
                : task.status
              : "progress",
          updatedAt: this.now(),
        },
        actor,
        "message",
        run.status === "succeeded"
          ? `${receiverName} 返回了工作流执行反馈`
          : ["failed", "timeout", "cancelled", "interrupted"].includes(
                run.status,
              )
            ? `${receiverName} 执行未完成`
            : `${receiverName} 开始执行工作流任务`,
      ),
    );
  }

  private submitStandaloneTask(
    actor: TaskActor,
    task: TaskRecord,
  ): Promise<TaskRecord> {
    if (!task.autoSubmitReview) {
      if (!task.steps.every((step) => step.done)) {
        throw new TaskError("conflict", "标记任务完成前需勾选全部验收标准");
      }
      return this.setStatus(
        actor,
        {
          ...task,
          progress: 100,
        },
        "done",
        "节点完成（无需 Review）",
      );
    }
    if (!task.steps.some((step) => step.done)) {
      throw new TaskError("conflict", "提交验收前至少需要完成一项验收标准");
    }
    const progressed = {
      ...task,
      progress: Math.max(86, progressForSteps(task.steps)),
    };
    return this.setStatus(actor, progressed, "review", "提交验收");
  }

  private async setStatus(
    actor: TaskActor,
    task: TaskRecord,
    status: TaskStatus,
    action: string,
  ): Promise<TaskRecord> {
    this.requireActive(task);
    const progress =
      status === "done"
        ? 100
        : status === "review"
          ? Math.max(86, task.progress)
          : status === "todo"
            ? Math.min(5, task.progress)
            : Math.max(task.progress, progressForSteps(task.steps));
    const updated = this.event(
      {
        ...task,
        status,
        progress,
        ...(status === "review" && task.status !== "review"
          ? {
              reviewSubmitter:
                task.reviewSubmitter ?? this.captureReviewSubmitter(task),
            }
          : status === "done" || status === "cancelled"
            ? { reviewSubmitter: undefined }
            : {}),
        updatedAt: this.now(),
      },
      actor,
      status === "done" ? "closed" : "status",
      `${actor.name} ${action}：${task.status} → ${status}`,
    );
    return this.put(updated);
  }

  async toggleStep(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(stepInputSchema, input);
    const task = requireOpen(this.requireActive(this.require(parsed.taskId)));
    if (task.workflow !== undefined) {
      throw new TaskError("conflict", "工作流任务验收项由工作流节点同步");
    }
    const steps = task.steps.map((step) =>
      step.id === parsed.stepId ? { ...step, done: parsed.done } : step,
    );
    const updated = this.event(
      {
        ...task,
        steps,
        progress:
          task.status === "done"
            ? 100
            : Math.min(92, Math.max(task.progress, progressForSteps(steps))),
        updatedAt: this.now(),
      },
      actor,
      "step",
      `${actor.name} 更新了验收项`,
    );
    return this.put(updated);
  }

  async addMessage(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(messageInputSchema, input);
    const task = requireContinuable(
      this.requireActive(this.require(parsed.taskId)),
    );
    if (task.workflow !== undefined) {
      throw new TaskError(
        "conflict",
        "工作流任务执行请进入工作流节点；任务详情仅保留协作评论",
      );
    }
    const deliveryTarget = resolveTaskDeliveryTarget(
      task,
      parsed.mentions,
      parsed.deliveryTarget,
    );
    const message = taskMessageSchema.parse({
      id: randomUUID(),
      at: this.now(),
      authorId: actor.id,
      authorName: actor.name,
      kind: actor.kind,
      content: parsed.content,
      attachments: parsed.attachments,
      mentions: parsed.mentions,
      deliveryTarget,
    });
    const reopened =
      task.status === "done" && deliveryTarget !== "collaborators";
    const status = reopened
      ? actor.kind === "agent"
        ? "progress"
        : "todo"
      : actor.kind === "agent" && task.status === "todo"
        ? "progress"
        : task.status;
    const updated = this.event(
      {
        ...task,
        status,
        messages: [...task.messages, message],
        updatedAt: this.now(),
      },
      actor,
      "message",
      reopened
        ? `${actor.name} 追加要求，任务重新开启`
        : task.status === "done"
          ? `${actor.name} 添加了协作消息`
          : `${actor.name} 添加了执行消息`,
    );
    return this.put(updated);
  }

  /** 重置执行会话：下一次执行换新会话，并重新注入完整上下文。 */
  async resetSession(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(sessionResetInputSchema, input);
    const task = requireOpen(this.requireActive(this.require(parsed.taskId)));
    if (task.workflow !== undefined) {
      throw new TaskError("conflict", "工作流 Agent 会话由工作流节点控制");
    }
    const updated = this.event(
      {
        ...task,
        sessionEpoch: (task.sessionEpoch ?? 0) + 1,
        updatedAt: this.now(),
      },
      actor,
      "updated",
      "重置了执行会话，下一次执行会重新注入完整上下文",
    );
    return this.put(updated);
  }

  async attachAgentRun(
    taskIdValue: string,
    run: TaskAgentRun,
    receiverName: string,
    handoff?: { readonly userId: string; readonly name: string } | undefined,
    options?:
      | {
          /** owner=任务责任人本人的轮次；assist=被 @ 的协作方；fyi=只通知不执行。 */
          readonly role?: "assist" | "fyi" | undefined;
          readonly authorId?: string | undefined;
          readonly authorName?: string | undefined;
        }
      | undefined,
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    const authorId = options?.authorId ?? task.receiverId ?? "agent";
    const authorName = options?.authorName ?? receiverName;
    const existing = task.messages.find((message) => message.runId === run.id);
    const message = taskMessageSchema.parse({
      id: existing?.id ?? run.id,
      at: existing?.at ?? this.now(),
      authorId,
      authorName,
      kind: "agent",
      content:
        run.status === "succeeded"
          ? run.output?.summary?.trim() || "执行完成，但没有返回文本结果。"
          : run.status === "waiting_input"
            ? run.output?.summary?.trim() ||
              run.error?.trim() ||
              "信息不足，等待人工补充后继续。"
            : run.status === "failed" ||
                run.status === "timeout" ||
                run.status === "cancelled" ||
                run.status === "interrupted"
              ? run.error?.trim() || "Agent 执行未完成。"
              : "已接收指令，正在执行…",
      attachments: [],
      runId: run.id,
      runRole: options?.role ?? "owner",
      ...(run.execution === undefined ? {} : { execution: run.execution }),
      state: run.status,
    });
    const messages =
      existing === undefined
        ? [...task.messages, message]
        : task.messages.map((item) => (item.runId === run.id ? message : item));
    const actor: TaskActor = {
      id: authorId,
      name: authorName,
      kind: "agent",
    };
    if (options?.role !== undefined) {
      // 协作方 / FYI 轮次只把反馈写回任务历史：不推进状态、不碰验收、
      // 不因为别人家的产出把任务推进到待验收。
      const progressMessage =
        run.status === "succeeded"
          ? `${authorName} 反馈了协作意见`
          : run.status === "waiting_input"
            ? `${authorName} 协作执行需要补充信息`
            : ["failed", "timeout", "cancelled", "interrupted"].includes(
                  run.status,
                )
              ? `${authorName} 协作执行未完成`
              : `${authorName} 开始协作执行`;
      const collaborated = this.event(
        {
          ...task,
          agentRunIds: task.agentRunIds.includes(run.id)
            ? task.agentRunIds
            : [...task.agentRunIds, run.id],
          messages,
          updatedAt: this.now(),
        },
        actor,
        "message",
        progressMessage,
      );
      return this.put(collaborated);
    }
    const isActive =
      task.archivedAt === undefined &&
      (task.status === "todo" || task.status === "progress");
    // 审批 Task 必须由明确的通过/退回动作驱动，Agent 执行成功不能代表审批结论。
    const isApprovalTask = task.workflow?.approvalPolicy !== undefined;
    const workflowReviewRequired = task.workflow?.reviewRequired !== false;
    const workflowReview =
      run.status === "succeeded" &&
      task.receiverType === "agent" &&
      isActive &&
      task.workflow !== undefined &&
      !isApprovalTask &&
      workflowReviewRequired;
    const workflowDirect =
      run.status === "succeeded" &&
      task.receiverType === "agent" &&
      isActive &&
      task.workflow !== undefined &&
      !isApprovalTask &&
      (!workflowReviewRequired || task.autoApproveReview === true);
    const autoReview =
      run.status === "succeeded" &&
      task.receiverType === "agent" &&
      isActive &&
      task.workflow === undefined &&
      task.autoSubmitReview;
    const steps =
      autoReview || workflowReview || workflowDirect
        ? task.steps.map((step) => ({ ...step, done: true }))
        : task.steps;
    // 反馈项：Agent 判断信息不足时需要人工补充，直接交回实例 owner 并打标。
    const needsInput = run.status === "waiting_input";
    const receiverOverride =
      needsInput && handoff !== undefined
        ? {
            receiverType: "human" as const,
            receiverId: handoff.userId,
            receiverName: handoff.name,
          }
        : {};
    const withRun = this.event(
      {
        ...task,
        ...receiverOverride,
        ...(autoReview || workflowReview
          ? {
              reviewSubmitter:
                task.reviewSubmitter ?? this.captureReviewSubmitter(task),
            }
          : {}),
        agentRunIds: task.agentRunIds.includes(run.id)
          ? task.agentRunIds
          : [...task.agentRunIds, run.id],
        needsInput: needsInput
          ? true
          : run.status === "queued" || run.status === "running"
            ? false
            : task.needsInput,
        messages,
        steps,
        progress: workflowDirect
          ? 100
          : autoReview || workflowReview
            ? Math.max(86, progressForSteps(steps))
            : task.progress,
        status: workflowDirect
          ? "done"
          : autoReview || workflowReview
            ? "review"
            : task.status === "todo"
              ? "progress"
              : task.status,
        updatedAt: this.now(),
      },
      actor,
      "message",
      run.status === "succeeded"
        ? `${receiverName} 返回了执行反馈`
        : needsInput
          ? `${receiverName} 需要补充信息，已转交 ${handoff?.name ?? "负责人"} 处理`
          : ["failed", "timeout", "cancelled", "interrupted"].includes(
                run.status,
              )
            ? `${receiverName} 执行未完成`
            : `${receiverName} 开始执行任务`,
    );
    if (!autoReview && !workflowReview && !workflowDirect)
      return this.put(withRun);
    if (workflowReview) {
      const completed = await this.put(
        this.event(
          withRun,
          actor,
          "status",
          `${receiverName} 完成产出物，等待工作流 Review`,
        ),
      );
      return completed;
    }
    if (workflowDirect) {
      const prepared = await this.put(withRun);
      try {
        await this.workflowActions?.submit(prepared, actor);
        const settled = this.require(taskIdValue);
        return settled.status === "done" || settled.status === "cancelled"
          ? settled
          : this.settleProjection(actor, taskIdValue, "approved");
      } catch (cause) {
        const current = this.require(taskIdValue);
        if (isSettled(current)) return current;
        return this.put(
          this.event(
            {
              ...current,
              status: "progress",
              progress: Math.max(progressForSteps(prepared.steps), 86),
              updatedAt: this.now(),
            },
            actor,
            "status",
            `工作流节点未完成：${cause instanceof Error ? cause.message : "unknown error"}`,
          ),
        );
      }
    }
    // 自动提交验收时把任务交回实例 owner（实例创建人）确认，
    // 这样产出物回写后进入该负责人的「待验收」，而不是继续挂在 Agent 身上。
    const handedOff =
      handoff === undefined
        ? withRun
        : {
            ...withRun,
            receiverType: "human" as const,
            receiverId: handoff.userId,
            receiverName: handoff.name,
          };
    return this.put(
      this.event(
        handedOff,
        actor,
        "status",
        handoff === undefined
          ? `${receiverName} 完成产出物，自动提交验收`
          : `${receiverName} 完成产出物，已提交 ${handoff.name} 确认`,
      ),
    );
  }

  async failAgentDispatch(
    taskIdValue: string,
    actor: TaskActor,
    error: string,
  ): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    const message = taskMessageSchema.parse({
      id: randomUUID(),
      at: this.now(),
      authorId: "system",
      authorName: "系统",
      kind: "system",
      content: `无法启动执行：${error}`,
      attachments: [],
      state: "failed",
    });
    const updated = this.event(
      {
        ...task,
        messages: [...task.messages, message],
        updatedAt: this.now(),
      },
      actor,
      "message",
      `${actor.name} 发送指令，但 Agent 启动失败`,
    );
    return this.put(updated);
  }

  async addComment(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(commentInputSchema, input);
    const task = requireOpen(this.requireActive(this.require(parsed.taskId)));
    const comment = taskCommentSchema.parse({
      id: randomUUID(),
      at: this.now(),
      authorId: actor.id,
      authorName: actor.name,
      kind: actor.kind,
      content: parsed.content,
      isKeyConsensus: parsed.isKeyConsensus,
      replies: [],
    });
    const updated = this.event(
      {
        ...task,
        comments: [...task.comments, comment],
        updatedAt: this.now(),
      },
      actor,
      "comment",
      parsed.isKeyConsensus
        ? `${actor.name} 添加了关键共识`
        : `${actor.name} 添加了评论`,
    );
    return this.put(updated);
  }

  async replyComment(actor: TaskActor, input: unknown): Promise<TaskRecord> {
    const parsed = parse(replyInputSchema, input);
    const task = requireOpen(this.requireActive(this.require(parsed.taskId)));
    if (!task.comments.some((comment) => comment.id === parsed.commentId)) {
      throw new TaskError("not_found", "comment not found");
    }
    const reply = taskReplySchema.parse({
      id: randomUUID(),
      at: this.now(),
      authorId: actor.id,
      authorName: actor.name,
      kind: actor.kind,
      content: parsed.content,
    });
    const comments = task.comments.map((comment) =>
      comment.id === parsed.commentId
        ? { ...comment, replies: [...comment.replies, reply] }
        : comment,
    );
    const updated = this.event(
      { ...task, comments, updatedAt: this.now() },
      actor,
      "reply",
      `${actor.name} 回复了评论`,
    );
    return this.put(updated);
  }

  async nudge(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    const task = requireOpen(this.requireActive(this.require(taskIdValue)));
    // 催办是「提醒某个人」的动作：只有指派给人类的任务才有意义。
    // 交给 Agent 的任务要推进就发指令 / 改派 / 重置会话，别用催办。
    if (task.receiverType !== "human") {
      throw new TaskError("conflict", "只有指派给人类的任务可以催办");
    }
    return this.put(
      this.event(
        { ...task, updatedAt: this.now() },
        actor,
        "nudge",
        `${actor.name} 发送了催办提醒`,
      ),
    );
  }

  async archive(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (task.archivedAt !== undefined) return task;
    const at = this.now();
    const updated = this.event(
      { ...task, archivedAt: at, updatedAt: at },
      actor,
      "archived",
      `${actor.name} 归档了任务`,
    );
    return this.put(updated);
  }

  async restore(actor: TaskActor, taskIdValue: string): Promise<TaskRecord> {
    const task = this.require(taskIdValue);
    if (task.archivedAt === undefined) return task;
    const restored: TaskRecord = { ...task, updatedAt: this.now() };
    delete restored.archivedAt;
    const updated = this.event(
      restored,
      actor,
      "restored",
      `${actor.name} 将任务从归档中复原`,
    );
    return this.put(updated);
  }

  // ------------------------------------------------------------ 队列（P1）

  /**
   * 队列排序口径（与 `pickNextTask` 共用同一实现）。
   * 暴露成服务方法，供其它插件（如 AI Teammate 的队列视图）复用，避免各自实现一套顺序。
   */
  sortQueue<T extends QueueTaskLike>(tasks: readonly T[]): T[] {
    return orderQueue(tasks);
  }

  /** 队列尾部序号：新任务/退回任务默认排队尾，不插队。 */
  private queueTailSeq(workspaceId: string): number {
    let max = 0;
    for (const task of this.tables.tasks.entries()) {
      if (task[1].workspaceId !== workspaceId) continue;
      max = Math.max(max, task[1].queueSeq ?? 0);
    }
    return max + 1_000;
  }

  /** 人工排序：按给定顺序重写 queueSeq（步长 1000），未列出的任务保持原值。 */
  async reorderQueue(
    actor: TaskActor,
    input: { readonly taskIds: readonly string[] },
  ): Promise<readonly TaskRecord[]> {
    const updated: TaskRecord[] = [];
    let seq = 1_000;
    for (const taskId of input.taskIds) {
      const task = requireOpen(this.require(taskId));
      if (task.queueSeq !== seq) {
        updated.push(
          await this.put(
            this.event(
              { ...task, queueSeq: seq, updatedAt: this.now() },
              actor,
              "updated",
              `${actor.name} 将任务调整到队列第 ${Math.ceil(seq / 1_000)} 位`,
            ),
          ),
        );
      }
      seq += 1_000;
    }
    return updated;
  }

  /** 队列项设置：暂停/恢复、是否参与自动执行、前置依赖。 */
  async updateQueueItem(
    actor: TaskActor,
    input: {
      readonly taskId: string;
      readonly queueState?: "idle" | "blocked" | "paused" | undefined;
      readonly autoRunEligible?: boolean | undefined;
      readonly dependsOn?: readonly string[] | undefined;
    },
  ): Promise<TaskRecord> {
    const task = requireOpen(this.require(input.taskId));
    const dependsOn =
      input.dependsOn === undefined
        ? task.dependsOn
        : [...new Set(input.dependsOn)].filter((id) => id !== task.id);
    for (const dependencyId of dependsOn) {
      const dependency = this.require(dependencyId);
      if (dependency.workspaceId !== task.workspaceId) {
        throw new TaskError("invalid_input", "前置任务必须属于同一个项目");
      }
    }
    const notes: string[] = [];
    if (
      input.queueState !== undefined &&
      input.queueState !== task.queueState
    ) {
      notes.push(
        input.queueState === "paused"
          ? "暂停出队"
          : input.queueState === "blocked"
            ? "标记为受阻"
            : "恢复出队",
      );
    }
    if (
      input.autoRunEligible !== undefined &&
      input.autoRunEligible !== task.autoRunEligible
    ) {
      notes.push(input.autoRunEligible ? "允许自动执行" : "不参与自动执行");
    }
    if (input.dependsOn !== undefined) notes.push("更新前置依赖");
    const updated = this.event(
      {
        ...task,
        queueState: input.queueState ?? task.queueState,
        autoRunEligible: input.autoRunEligible ?? task.autoRunEligible,
        dependsOn,
        updatedAt: this.now(),
      },
      actor,
      "updated",
      `${actor.name} 调整队列项：${notes.length === 0 ? "无变化" : notes.join("、")}`,
    );
    return this.put(updated);
  }

  /**
   * 待确认动作（通过 / 退回并补充 / 转人工）。
   * 退回会追加一条人工指令、把任务放回队尾并清除反馈项标记，
   * 由调用方（路由）决定是否立即重新派发。
   */
  async confirm(
    actor: TaskActor,
    input: {
      readonly taskId: string;
      readonly action: "approve" | "reject" | "handoff";
      readonly note?: string | undefined;
      readonly assigneeId?: string | undefined;
      readonly assigneeName?: string | undefined;
    },
  ): Promise<TaskRecord> {
    const task = requireOpen(this.requireActive(this.require(input.taskId)));
    if (input.action === "approve") {
      if (task.status !== "review") {
        throw new TaskError("conflict", "只有待验收的任务可以通过");
      }
      return this.setStatus(actor, task, "done", "确认验收");
    }
    if (input.action === "reject") {
      if (task.status !== "review" && task.needsInput !== true) {
        throw new TaskError("conflict", "只有待验收或待补充的任务可以退回");
      }
      const note = (input.note ?? "").trim();
      if (note === "") {
        throw new TaskError("invalid_input", "退回必须填写补充说明");
      }
      const message = taskMessageSchema.parse({
        id: randomUUID(),
        at: this.now(),
        authorId: actor.id,
        authorName: actor.name,
        kind: actor.kind,
        content: note,
        attachments: [],
        deliveryTarget: "receiver",
      });
      const reviewSubmitter = this.inferReviewSubmitter(task);
      return this.put(
        this.event(
          {
            ...task,
            ...this.restoreReviewSubmitter(task),
            status: "todo",
            progress: Math.min(5, task.progress),
            messages: [...task.messages, message],
            needsInput: false,
            queueState: "idle",
            queueSeq: this.queueTailSeq(task.workspaceId),
            updatedAt: this.now(),
          },
          actor,
          "status",
          `${actor.name} 退回并补充说明：${task.status} → todo${reviewSubmitter === undefined ? "" : `，负责人恢复为 ${reviewSubmitter.receiverName ?? reviewSubmitter.receiverId ?? "原执行人"}`}`,
        ),
      );
    }
    const assigneeId = (input.assigneeId ?? "").trim();
    if (assigneeId === "") {
      throw new TaskError("invalid_input", "转人工必须指定接收人");
    }
    const assigneeName = (input.assigneeName ?? assigneeId).trim();
    return this.put(
      this.event(
        {
          ...task,
          receiverType: "human" as const,
          receiverId: assigneeId,
          receiverName: assigneeName,
          updatedAt: this.now(),
        },
        actor,
        "assigned",
        `${actor.name} 将任务转交 ${assigneeName} 处理`,
      ),
    );
  }
}

export const taskDomainSpec = {
  name: "collab_task",
  version: 1,
  tables: {
    tasks: { valueSchema: taskRecordSchema as unknown as z.ZodType<unknown> },
  },
};
