import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import { z } from "zod";
import {
  ProjectError,
  ProjectService,
  projectDomainSpec,
  type KvTableLike,
} from "./service.js";
import {
  projectHealthSchema,
  projectMemberKindSchema,
  projectRoleDefinitionSchema,
  projectStatusSchema,
  roleCategorySchema,
  rolePermissionSchema,
  type ProjectAuditRecord,
  type ProjectRecord,
  type ProjectRoleDefinition,
  type ProjectReportRecord,
  type ProjectRoleRecord,
  type ProjectTemplateRecord,
  type RolePermission,
} from "./types.js";

export const name = "dsh-collab-project";
export const inject = ["storageDomain", "webServer"];

export { ProjectError, ProjectService, projectDomainSpec };
export type {
  ProjectAuditRecord,
  ProjectRecord,
  ProjectRoleDefinition,
  ProjectReportRecord,
  ProjectRoleRecord,
  ProjectTemplateRecord,
} from "./types.js";

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

type GlobalRole = "admin" | "owner" | "member" | "guest";
type MemberRole = "owner" | "member" | "guest";

interface TeamPrincipalLike {
  readonly userId: string;
  readonly role: GlobalRole;
}

interface WorkspaceUserLike {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

interface WorkspaceMemberLike {
  readonly userId: string;
  readonly name?: string;
  readonly memberRole: MemberRole;
  readonly addedAt?: string;
  readonly addedBy?: string;
}

interface TeamServiceLike {
  resolveToken(token: string): TeamPrincipalLike | undefined;
  users(): readonly WorkspaceUserLike[];
  members(workspaceId: string): readonly WorkspaceMemberLike[];
  addMember(
    actorId: string,
    input: {
      readonly workspaceId: string;
      readonly userId: string;
      readonly role: MemberRole;
    },
    options?: { readonly allowWorkspaceOwner?: boolean },
  ): Promise<unknown>;
  removeMember(
    actorId: string,
    input: { readonly workspaceId: string; readonly userId: string },
    options?: { readonly allowWorkspaceOwner?: boolean },
  ): Promise<unknown>;
  leaveWorkspace?(actorId: string, workspaceId: string): Promise<unknown>;
  audit?(filter: {
    readonly action?: string;
    readonly workspaceId?: string;
    readonly limit?: number;
  }): readonly TeamAuditRecordLike[];
}

interface TeamAuditRecordLike {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly actorRole: string;
  readonly action: string;
  readonly targetId?: string;
  readonly workspaceId?: string;
  readonly detail: Readonly<Record<string, string>>;
}

interface WorkspaceLike {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  setTitle?(title: string): Promise<void>;
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): WorkspaceLike | undefined;
  list(): readonly WorkspaceLike[];
  create?(path: string, title?: string): Promise<WorkspaceLike>;
}

interface WorkspaceViewLike {
  readonly workspaceId?: string;
  readonly id?: string;
}

/**
 * 宿主工作区控制器的变更流：先给一份 baseline，之后逐条增量。
 * 项目管理用它把「项目编号」绑定到项目创建时刻，而不是等页面读取时才补。
 */
interface WorkspaceFollowFrameLike {
  readonly type: "baseline" | "upsert" | "remove" | "order" | "archived";
  readonly value?: { readonly items?: readonly WorkspaceViewLike[] };
  readonly workspace?: WorkspaceViewLike;
}

interface WorkspaceControllerLike {
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrameLike>;
}

interface SeatLike {
  readonly id: string;
  readonly label: string;
  readonly participantKind: string;
  readonly personaId?: string | undefined;
  readonly permissions: readonly string[];
}

interface WorkspaceRoleConfigLike {
  readonly workspaceId: string;
  readonly typeId: string;
  readonly typeName: string;
  readonly seats: readonly SeatLike[];
}

interface AssignmentLike {
  readonly id: string;
  readonly workspaceId: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly assigneeKind: "user" | "agent";
  readonly assigneeId: string;
  readonly principalId?: string | undefined;
  readonly status: "claimed" | "assigned" | "released";
  readonly personaId?: string | undefined;
}

interface RoleActorLike {
  readonly kind: "user" | "agent";
  readonly id: string;
  readonly globalRole?: GlobalRole | undefined;
  readonly workspaceRole?: MemberRole | undefined;
}

interface WorkspaceTypeLike {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly seats: readonly SeatLike[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AssignmentServiceLike {
  config(workspaceId: string): WorkspaceRoleConfigLike;
  seats(workspaceId: string): readonly AssignmentLike[];
  materialize(
    actor: RoleActorLike,
    workspaceId: string,
    type: WorkspaceTypeLike,
  ): Promise<WorkspaceRoleConfigLike>;
  assign(
    actor: RoleActorLike,
    input: {
      readonly workspaceId: string;
      readonly seatId: string;
      readonly assigneeKind: "user" | "agent";
      readonly assigneeId: string;
      readonly personaId?: string;
    },
  ): Promise<AssignmentLike>;
  release(
    actor: RoleActorLike,
    workspaceId: string,
    seatId: string,
    target?: {
      readonly assigneeKind: "user" | "agent";
      readonly assigneeId: string;
    },
  ): Promise<unknown>;
}

interface EmployeeLike {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human" | "digital";
  readonly status: string;
  readonly principalId?: string | undefined;
  readonly authUserId?: string | undefined;
  readonly managerEmployeeId?: string | undefined;
}

interface EmployeeServiceLike {
  list(): readonly EmployeeLike[];
  employeeWorkspaceTarget(
    employeeId: string,
    workspaceId: string,
  ): unknown | undefined;
}

interface TeammateLike {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly source: "platform" | "personal";
  readonly avatar: string;
  readonly employeeId?: string | undefined;
  readonly personaId?: string | undefined;
}

interface TeammateRuntimeLike {
  assignable(actor: {
    readonly userId: string;
    readonly name: string;
    readonly role: GlobalRole;
  }): readonly TeammateLike[];
}

interface TaskLike {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly receiverType: string;
  readonly receiverId?: string | undefined;
  readonly receiverName?: string | undefined;
  readonly due?: string | undefined;
  readonly archivedAt?: string | undefined;
  readonly workflow?:
    | {
        readonly instanceId?: string | undefined;
        readonly instanceTitle?: string | undefined;
        readonly nodeId?: string | undefined;
        readonly nodeName?: string | undefined;
      }
    | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskServiceLike {
  list(workspaceId: string): readonly TaskLike[];
  markRoleUnavailable?(
    workspaceId: string,
    roles: ReadonlyMap<string, string>,
    skipTaskIds?: ReadonlySet<string>,
  ): Promise<number>;
}

interface TaskDocumentLike {
  readonly id: string;
  readonly kind: "produced" | "uploaded";
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mimeType: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly available: boolean;
}

interface TaskDocumentQueryServiceLike {
  list(
    taskId: string,
    options?: {
      readonly includeUploaded?: boolean;
      readonly maxFiles?: number;
    },
  ): Promise<{
    readonly workspaceReady: boolean;
    readonly documents: readonly TaskDocumentLike[];
  }>;
}

interface PrincipalRecordLike {
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly displayName: string;
  readonly status: "active" | "suspended" | "archived";
}

interface PrincipalBindingLike {
  readonly subjectType: "auth-user" | "employee" | "teammate" | "hrm";
  readonly subjectId: string;
}

interface PrincipalServiceLike {
  resolveReference(reference: string): PrincipalRecordLike | undefined;
  resolveSubject(
    subjectType: "auth-user" | "employee" | "teammate",
    subjectId: string,
  ): PrincipalRecordLike | undefined;
  bindings(principalId: string): readonly PrincipalBindingLike[];
  preferredSubjectId(
    principalId: string,
    subjectTypes: readonly ("auth-user" | "employee" | "teammate" | "hrm")[],
  ): string | undefined;
  syncExclusiveGrant(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly grantedByPrincipalId?: string;
  }): Promise<unknown>;
  revokeMatchingGrants(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
  }): Promise<unknown>;
}

interface WorkflowInstanceLike {
  readonly id: string;
  readonly definitionId?: string | undefined;
  readonly definitionKey: string;
  readonly definitionVersion: number;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly roleSnapshot?: Record<
    string,
    { readonly roleId?: string } | undefined
  >;
}

interface WorkflowArtifactLike {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
}

interface WorkflowSubmissionLike {
  readonly id: string;
  readonly instanceId: string;
  readonly nodeId: string;
  readonly requirementKey: string;
  readonly requirementTitle: string;
  readonly type: "file" | "text" | "link";
  readonly artifacts: readonly WorkflowArtifactLike[];
  readonly submittedByName: string;
  readonly submittedAt: string;
  readonly status: "submitted" | "rejected";
}

interface WorkflowNodeLike {
  readonly id: string;
  readonly name: string;
  readonly executor: {
    readonly kind: string;
    readonly id: string;
    readonly label?: string | undefined;
  };
  readonly approvers: readonly {
    readonly kind: string;
    readonly id: string;
    readonly name: string;
  }[];
}

interface WorkflowDefinitionLike {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly workspaceId: string;
  readonly graph?: { readonly nodes: readonly WorkflowNodeLike[] };
}

interface WorkflowServiceLike {
  instances(workspaceId: string): readonly WorkflowInstanceLike[];
  instance?(instanceId: string): WorkflowInstanceLike | undefined;
  submissions?(instanceId: string): readonly WorkflowSubmissionLike[];
  sharedDefinitions?(): readonly WorkflowDefinitionLike[];
}

interface ProjectDependencies {
  readonly team: TeamServiceLike;
  readonly workspaces: WorkspaceRegistryLike;
  readonly assignments: () => AssignmentServiceLike | undefined;
  readonly employees: () => EmployeeServiceLike | undefined;
  readonly teammates: () => TeammateRuntimeLike | undefined;
  readonly tasks: () => TaskServiceLike | undefined;
  readonly taskDocuments?: () => TaskDocumentQueryServiceLike | undefined;
  readonly workflows: () => WorkflowServiceLike | undefined;
  readonly principals?: () => PrincipalServiceLike | undefined;
  readonly now?: () => Date;
}

interface ProjectContext {
  storageDomain: {
    open(spec: typeof projectDomainSpec): Promise<ProjectDomainLike>;
  };
  effect(register: () => () => void): void;
  provide(key: "collabProjects", value: ProjectService): unknown;
  webServer: { register(route: WebRouteLike): unknown };
  get(key: string): unknown;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: ProjectContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabTeam", "workspaceController"],
    callback: (
      child: ProjectContext & {
        readonly collabTeam: TeamServiceLike;
        readonly workspaceController: WorkspaceControllerLike;
      },
    ) => void,
  ): { dispose(): void };
}

interface ProjectDomainLike {
  table(name: "projects"): KvTableLike<ProjectRecord>;
  table(name: "templates"): KvTableLike<ProjectTemplateRecord>;
  table(name: "roles"): KvTableLike<ProjectRoleRecord>;
  table(name: "reports"): KvTableLike<ProjectReportRecord>;
  table(name: "audit"): KvTableLike<ProjectAuditRecord>;
  close(): Promise<void>;
}

const PERMISSION_LABEL: Record<string, string> = {
  read: "查看",
  write: "编辑",
  approve: "审批",
  manage_members: "成员管理",
  manage_roles: "角色管理",
};

const USER_ROLE_LABEL: Record<string, string> = {
  admin: "平台管理员",
  owner: "平台负责人",
  member: "平台成员",
  guest: "平台访客",
};

/** 平台角色只读展示：只取账号的全局角色，不与工作区成员角色混用。 */
function platformRoleLabel(userRole: string | undefined): string {
  return USER_ROLE_LABEL[userRole ?? ""] ?? "平台成员";
}

function scopeLabel(permissions: readonly string[]): string {
  const labels = [...new Set(permissions)]
    .map((permission) => PERMISSION_LABEL[permission] ?? permission)
    .filter((label) => label !== "");
  return labels.length === 0 ? "未分配" : labels.join("、");
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

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
  if (token === undefined) {
    throw new ProjectError("unauthorized", "bearer token is required");
  }
  const resolved = team.resolveToken(token);
  if (resolved === undefined) {
    throw new ProjectError("unauthorized", "invalid or expired token");
  }
  return resolved;
}

function memberRoleOf(
  team: TeamServiceLike,
  workspaceId: string,
  userId: string,
): MemberRole | undefined {
  return team.members(workspaceId).find((member) => member.userId === userId)
    ?.memberRole;
}

function resolveMemberIdentity(
  principals: PrincipalServiceLike | undefined,
  memberKind: "human" | "agent",
  memberId: string,
): {
  readonly memberKind: "human" | "agent";
  readonly memberId: string;
  readonly principalId?: string;
} {
  if (principals === undefined) return { memberKind, memberId };
  const principal = principals.resolveReference(memberId);
  if (principal === undefined) return { memberKind, memberId };
  if (principal.status === "archived") {
    throw new ProjectError("conflict", "已归档主体不能加入项目");
  }
  if (principal.kind === "human") {
    const authUserId = principals.preferredSubjectId(principal.id, [
      "auth-user",
    ]);
    if (authUserId === undefined) {
      throw new ProjectError("invalid_input", "该人类主体没有可用的登录账号");
    }
    return {
      memberKind: "human",
      memberId: authUserId,
      principalId: principal.id,
    };
  }
  const agentId = principals.preferredSubjectId(principal.id, [
    "teammate",
    "employee",
  ]);
  if (agentId === undefined) {
    throw new ProjectError("invalid_input", "该 AI 主体没有可用的伙伴实例");
  }
  return {
    memberKind: "agent",
    memberId: agentId,
    principalId: principal.id,
  };
}

function requireWorkspaceAccess(
  request: IncomingMessage,
  team: TeamServiceLike,
  workspaceId: string,
): TeamPrincipalLike {
  const current = principal(request, team);
  if (
    current.role !== "admin" &&
    memberRoleOf(team, workspaceId, current.userId) === undefined
  ) {
    throw new ProjectError("forbidden", "workspace membership is required");
  }
  return current;
}

/**
 * 项目级管理权限：平台管理员或项目（工作区）负责人。
 * 平台级账号与平台角色不在这里维护，因此非管理员只能管理自己负责的项目。
 */
function requireProjectManager(
  request: IncomingMessage,
  team: TeamServiceLike,
  workspaceId: string,
): TeamPrincipalLike {
  const current = requireWorkspaceAccess(request, team, workspaceId);
  if (
    current.role !== "admin" &&
    memberRoleOf(team, workspaceId, current.userId) !== "owner"
  ) {
    throw new ProjectError(
      "forbidden",
      "workspace owner or platform admin is required",
    );
  }
  return current;
}

function requirePlatformAdmin(
  request: IncomingMessage,
  team: TeamServiceLike,
): TeamPrincipalLike {
  const current = principal(request, team);
  if (current.role !== "admin") {
    throw new ProjectError("forbidden", "platform admin is required");
  }
  return current;
}

function actorOf(
  current: TeamPrincipalLike,
  team: TeamServiceLike,
  workspaceId: string,
): RoleActorLike {
  const workspaceRole = memberRoleOf(team, workspaceId, current.userId);
  return {
    kind: "user",
    id: current.userId,
    globalRole: current.role,
    ...(workspaceRole === undefined ? {} : { workspaceRole }),
  };
}

function assertSameOrigin(request: IncomingMessage): void {
  if (
    request.headers.origin !== undefined &&
    !sameOrigin(request.headers.origin, request.headers.host)
  ) {
    throw new ProjectError("forbidden", "same-origin request is required");
  }
}

function query(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://dsh.invalid").searchParams;
}

function routeError(response: ServerResponse, cause: unknown): void {
  if (cause instanceof ProjectError) {
    const status =
      cause.code === "unauthorized"
        ? 401
        : cause.code === "forbidden"
          ? 403
          : cause.code === "not_found"
            ? 404
            : cause.code === "conflict" ||
                cause.code === "member_impact" ||
                cause.code === "workflow_template_blocked" ||
                cause.code === "revision_conflict"
              ? 409
              : 400;
    sendJson(response, status, {
      ok: false,
      error: {
        code: cause.code,
        message: cause.message,
        ...cause.details,
      },
    });
    return;
  }
  sendJson(response, 500, {
    ok: false,
    error: { code: "internal_error", message: "project request failed" },
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request);
  } catch {
    throw new ProjectError("invalid_input", "请求内容不合法");
  }
}

/** zod 校验失败统一转成 400，而不是落到 500。 */
async function readBodyAs<T>(
  request: IncomingMessage,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = schema.safeParse(await readBody(request));
  if (!result.success) {
    throw new ProjectError("invalid_input", "请求内容不合法");
  }
  return result.data;
}

function activeTasks(tasks: readonly TaskLike[]): TaskLike[] {
  return tasks
    .filter((task) => task.archivedAt === undefined)
    .sort((left, right) => {
      const rank: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
      const gap = (rank[left.priority] ?? 9) - (rank[right.priority] ?? 9);
      if (gap !== 0) return gap;
      return String(right.createdAt).localeCompare(String(left.createdAt));
    });
}

type ProjectOutputType =
  | "pdf"
  | "word"
  | "spreadsheet"
  | "presentation"
  | "markdown"
  | "text"
  | "image"
  | "archive"
  | "other";

interface ProjectOutputItem {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly documentType: ProjectOutputType;
  readonly extension: string;
  readonly authorName: string;
  readonly sourceKind: "task" | "workflow";
  readonly sourceId: string;
  readonly sourceName: string;
  readonly taskId?: string;
  readonly workflowInstanceId?: string;
  readonly workflowInstanceTitle?: string;
  readonly workflowNodeId?: string;
  readonly workflowNodeName?: string;
  readonly submissionId?: string;
  readonly artifactId?: string;
  readonly downloadUrl: string;
}

function outputExtension(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,16})$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function outputType(name: string, mimeType: string): ProjectOutputType {
  const extension = outputExtension(name);
  if (extension === "pdf" || mimeType === "application/pdf") return "pdf";
  if (["doc", "docx", "rtf", "odt"].includes(extension)) return "word";
  if (["csv", "xls", "xlsx", "ods"].includes(extension)) return "spreadsheet";
  if (["ppt", "pptx", "odp"].includes(extension)) return "presentation";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "log", "json", "yml", "yaml"].includes(extension)) return "text";
  if (
    mimeType.startsWith("image/") ||
    ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)
  ) {
    return "image";
  }
  if (["zip", "tar", "gz", "rar", "7z"].includes(extension)) return "archive";
  return "other";
}

function outputDateKey(value: string): string {
  return dateOf(value) || value.slice(0, 10);
}

function outputDedupeKey(
  workflowInstanceId: string,
  workflowNodeId: string,
  name: string,
  size: number,
  date: string,
): string {
  return JSON.stringify([workflowInstanceId, workflowNodeId, name, size, date]);
}

async function projectOutputs(
  workspaceId: string,
  tasks: readonly TaskLike[],
  taskDocuments: TaskDocumentQueryServiceLike | undefined,
  workflows: WorkflowServiceLike | undefined,
): Promise<ProjectOutputItem[]> {
  const items: ProjectOutputItem[] = [];
  const definitions = workflows?.sharedDefinitions?.() ?? [];
  const instances = workflows?.instances(workspaceId) ?? [];
  const instanceById = new Map(
    instances.map((instance) => [instance.id, instance]),
  );
  const nodeNameFor = (
    instance: WorkflowInstanceLike,
    nodeId: string,
  ): string | undefined => {
    const definition =
      definitions.find((item) => item.id === instance.definitionId) ??
      definitions.find(
        (item) =>
          item.key === instance.definitionKey &&
          item.version === instance.definitionVersion,
      );
    return definition?.graph?.nodes.find((node) => node.id === nodeId)?.name;
  };

  // 工作流提交是交付物的权威来源；同名同日期的任务扫描结果只保留一份。
  const dedupe = new Set<string>();
  for (const instance of instances) {
    const submissions = [...(workflows?.submissions?.(instance.id) ?? [])]
      .filter(
        (submission) =>
          submission.status === "submitted" &&
          submission.type === "file" &&
          submission.artifacts.length > 0,
      )
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
    const seenRequirements = new Set<string>();
    for (const submission of submissions) {
      const requirementId = `${submission.nodeId}:${submission.requirementKey}`;
      if (seenRequirements.has(requirementId)) continue;
      seenRequirements.add(requirementId);
      const nodeName =
        nodeNameFor(instance, submission.nodeId) ?? submission.nodeId;
      for (const artifact of submission.artifacts) {
        const key = outputDedupeKey(
          instance.id,
          submission.nodeId,
          artifact.fileName,
          artifact.size,
          outputDateKey(submission.submittedAt),
        );
        dedupe.add(key);
        items.push({
          id: `workflow:${submission.id}:${artifact.id}`,
          name: artifact.fileName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          updatedAt: submission.submittedAt,
          documentType: outputType(artifact.fileName, artifact.mimeType),
          extension: outputExtension(artifact.fileName),
          authorName: submission.submittedByName,
          sourceKind: "workflow",
          sourceId: instance.id,
          sourceName: instance.title,
          workflowInstanceId: instance.id,
          workflowInstanceTitle: instance.title,
          workflowNodeId: submission.nodeId,
          workflowNodeName: nodeName,
          submissionId: submission.id,
          artifactId: artifact.id,
          downloadUrl: `/api/collab/workflow/deliverables/download?submissionId=${encodeURIComponent(submission.id)}&artifactId=${encodeURIComponent(artifact.id)}`,
        });
      }
    }
  }

  for (const task of tasks) {
    if (taskDocuments === undefined) break;
    let result: Awaited<ReturnType<TaskDocumentQueryServiceLike["list"]>>;
    try {
      result = await taskDocuments.list(task.id, {
        includeUploaded: false,
        maxFiles: 100,
      });
    } catch {
      continue;
    }
    const workflow = task.workflow;
    const workflowInstance =
      workflow?.instanceId === undefined
        ? undefined
        : instanceById.get(workflow.instanceId);
    const workflowNodeName =
      workflow?.nodeName ??
      (workflowInstance === undefined || workflow?.nodeId === undefined
        ? undefined
        : nodeNameFor(workflowInstance, workflow.nodeId));
    for (const document of result.documents) {
      if (document.kind !== "produced" || !document.available) continue;
      if (
        workflow?.instanceId !== undefined &&
        workflow.nodeId !== undefined &&
        dedupe.has(
          outputDedupeKey(
            workflow.instanceId,
            workflow.nodeId,
            document.name,
            document.size,
            outputDateKey(document.updatedAt),
          ),
        )
      ) {
        continue;
      }
      const workflowInstanceTitle =
        workflow?.instanceTitle ?? workflowInstance?.title;
      const taskWorkflowLink: Pick<
        ProjectOutputItem,
        "workflowInstanceId" | "workflowInstanceTitle"
      > =
        workflow?.instanceId === undefined
          ? {}
          : workflowInstanceTitle === undefined
            ? { workflowInstanceId: workflow.instanceId }
            : {
                workflowInstanceId: workflow.instanceId,
                workflowInstanceTitle,
              };
      items.push({
        id: `task:${task.id}:${document.id}`,
        name: document.name,
        mimeType: document.mimeType,
        size: document.size,
        updatedAt: document.updatedAt,
        documentType: outputType(document.name, document.mimeType),
        extension: outputExtension(document.name),
        authorName: document.updatedBy,
        sourceKind: "task",
        sourceId: task.id,
        sourceName: task.title,
        taskId: task.id,
        ...taskWorkflowLink,
        ...(workflow?.nodeId === undefined
          ? {}
          : {
              workflowNodeId: workflow.nodeId,
              ...(workflowNodeName === undefined ? {} : { workflowNodeName }),
            }),
        downloadUrl: `/api/collab/tasks/document/content?taskId=${encodeURIComponent(task.id)}&path=${encodeURIComponent(document.relativePath)}`,
      });
    }
  }
  return items
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 2_000);
}

interface ProjectNoteSet {
  readonly members: string;
  readonly tasks: string;
  readonly workflows: string;
}

function notesOf(
  tasks: readonly TaskLike[],
  workflows: readonly WorkflowInstanceLike[],
  today: string,
): ProjectNoteSet {
  const createdToday = tasks.filter(
    (task) => dateOf(task.createdAt) === today,
  ).length;
  const recentWorkflows = workflows.filter((workflow) => {
    const updated = dateOf(workflow.updatedAt);
    return updated >= shiftDate(today, -7);
  }).length;
  const blocked = workflows.filter(
    (workflow) => workflow.status === "blocked",
  ).length;
  return {
    members: "",
    tasks: createdToday === 0 ? "今日无新增" : `今日新增 ${createdToday} 项`,
    workflows:
      blocked > 0
        ? `${blocked} 个阻塞`
        : recentWorkflows === 0
          ? "近 7 天无新增"
          : `近 7 天新增 ${recentWorkflows} 个`,
  };
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

interface MemberView {
  readonly id: string;
  readonly principalId?: string;
  readonly name: string;
  readonly kind: "human" | "agent";
  readonly kindLabel: string;
  readonly roleIds: readonly string[];
  readonly roleNames: readonly string[];
  readonly platformRole: string;
  readonly workspaceRole?: MemberRole | undefined;
  readonly joinedAt?: string | undefined;
  readonly avatar?: string | undefined;
  readonly source?: "platform" | "personal" | undefined;
  readonly scope: string;
  readonly ownerName?: string;
}

interface MemberDirectory {
  readonly humans: readonly {
    readonly id: string;
    readonly principalId?: string;
    readonly name: string;
    readonly platformRole: string;
  }[];
  readonly agents: readonly {
    readonly id: string;
    readonly principalId?: string;
    readonly name: string;
    readonly kindLabel: string;
    readonly platformRole: string;
    readonly ownerName?: string;
  }[];
}

function teammateDirectory(
  teammates: TeammateRuntimeLike | undefined,
  employees: EmployeeServiceLike | undefined,
  workspaceId: string,
  actor: { userId: string; name: string; role: GlobalRole },
): TeammateLike[] {
  const list: TeammateLike[] = [];
  for (const teammate of teammates?.assignable(actor) ?? []) {
    list.push(teammate);
  }
  const seenEmployees = new Set(
    list
      .map((teammate) => teammate.employeeId)
      .filter((value): value is string => value !== undefined),
  );
  const employeeList = employees?.list() ?? [];
  const employeeById = new Map(
    employeeList.map((employee) => [employee.id, employee]),
  );
  for (const employee of employeeList) {
    if (employee.kind !== "digital") continue;
    if (seenEmployees.has(employee.id)) continue;
    if (
      employees?.employeeWorkspaceTarget(employee.id, workspaceId) === undefined
    ) {
      continue;
    }
    const manager =
      employee.managerEmployeeId === undefined
        ? undefined
        : employeeById.get(employee.managerEmployeeId);
    list.push({
      id: employee.id,
      name: employee.displayName,
      ownerUserId: employee.authUserId ?? "",
      ownerName: manager?.displayName ?? "",
      source: "platform",
      avatar: "",
      employeeId: employee.id,
    });
  }
  return list;
}

/**
 * 项目角色的席位是按需物化的：工作区还没物化过角色时，dsh-collab-roles 的
 * `seats()` 会抛 not_found。列表、详情与成员移除这类读路径要把它降级成
 * 「没有项目角色」，而不是让整个项目页 500。
 */
function activeSeats(
  assignments: AssignmentServiceLike | undefined,
  workspaceId: string,
): readonly AssignmentLike[] {
  if (assignments === undefined) return [];
  try {
    return assignments
      .seats(workspaceId)
      .filter((assignment) => assignment.status !== "released");
  } catch {
    return [];
  }
}

/** 工作区的项目负责人：取工作区成员里的 owner（没有就留空）。 */
function ownerOfWorkspace(
  team: TeamServiceLike,
  workspaceId: string,
): { ownerId?: string; ownerName: string } {
  const owner = team
    .members(workspaceId)
    .find((member) => member.memberRole === "owner");
  const ownerName =
    owner === undefined
      ? ""
      : (team.users().find((user) => user.id === owner.userId)?.name ??
        owner.name ??
        "");
  return {
    ...(owner === undefined ? {} : { ownerId: owner.userId }),
    ownerName,
  };
}

function buildMembers(
  team: TeamServiceLike,
  assignments: AssignmentServiceLike | undefined,
  teammates: TeammateRuntimeLike | undefined,
  employees: EmployeeServiceLike | undefined,
  principals: PrincipalServiceLike | undefined,
  workspaceId: string,
  actor: { userId: string; name: string; role: GlobalRole },
  roleById: Map<string, { name: string; permissions: readonly string[] }>,
): {
  readonly members: readonly MemberView[];
  readonly directory: MemberDirectory;
} {
  const seats = activeSeats(assignments, workspaceId);
  const userById = new Map(team.users().map((user) => [user.id, user]));
  const humans: MemberView[] = team.members(workspaceId).map((member) => {
    const user = userById.get(member.userId);
    const held = seats.filter(
      (assignment) =>
        assignment.assigneeKind === "user" &&
        assignment.assigneeId === member.userId,
    );
    const permissions = held.flatMap((assignment) => {
      const role = roleById.get(assignment.seatId);
      return role?.permissions ?? [];
    });
    const principalId =
      held.find((assignment) => assignment.principalId !== undefined)
        ?.principalId ??
      principals?.resolveSubject("auth-user", member.userId)?.id;
    return {
      id: member.userId,
      ...(principalId === undefined ? {} : { principalId }),
      name: user?.name ?? member.userId,
      kind: "human",
      kindLabel: "Human Principal",
      roleIds: held.map((assignment) => assignment.seatId),
      roleNames: held.map(
        (assignment) =>
          roleById.get(assignment.seatId)?.name ?? assignment.seatLabel,
      ),
      platformRole: platformRoleLabel(user?.role),
      workspaceRole: member.memberRole,
      ...(member.addedAt === undefined ? {} : { joinedAt: member.addedAt }),
      scope: scopeLabel(permissions),
    };
  });
  const agentDirectory = teammateDirectory(
    teammates,
    employees,
    workspaceId,
    actor,
  );
  const agentById = new Map(
    agentDirectory.map((teammate) => [teammate.id, teammate]),
  );
  /**
   * AI 员工暂未接入独立的平台角色授权，因此不再从实例 Owner 隐式继承。
   * Owner 只表示业务负责人，不构成平台管理员或平台成员的授权来源。
   */
  const teammatePlatformRole = (teammate: TeammateLike | undefined) => {
    void teammate;
    return "未分配";
  };
  const agentIds = [
    ...new Set(
      seats
        .filter((assignment) => assignment.assigneeKind === "agent")
        .map((assignment) => assignment.assigneeId),
    ),
  ];
  const agents: MemberView[] = agentIds.map((agentId) => {
    const teammate = agentById.get(agentId);
    const held = seats.filter(
      (assignment) =>
        assignment.assigneeKind === "agent" &&
        assignment.assigneeId === agentId,
    );
    const permissions = held.flatMap((assignment) => {
      const role = roleById.get(assignment.seatId);
      return role?.permissions ?? [];
    });
    const principalId =
      held.find((assignment) => assignment.principalId !== undefined)
        ?.principalId ??
      principals?.resolveSubject("teammate", agentId)?.id ??
      employees?.list().find((employee) => employee.id === agentId)
        ?.principalId;
    return {
      id: agentId,
      ...(principalId === undefined ? {} : { principalId }),
      name: teammate?.name ?? agentId,
      kind: "agent",
      kindLabel: "AI Principal",
      roleIds: held.map((assignment) => assignment.seatId),
      roleNames: held.map(
        (assignment) =>
          roleById.get(assignment.seatId)?.name ?? assignment.seatLabel,
      ),
      platformRole: teammatePlatformRole(teammate),
      ...(teammate === undefined
        ? {}
        : { avatar: teammate.avatar, source: teammate.source }),
      scope: scopeLabel(permissions),
      ...(teammate?.ownerName === undefined || teammate.ownerName === ""
        ? {}
        : { ownerName: teammate.ownerName }),
    };
  });
  const humanMemberIds = new Set(humans.map((member) => member.id));
  const agentMemberIds = new Set(agents.map((member) => member.id));
  const directory: MemberDirectory = {
    humans: team
      .users()
      .filter((user) => !humanMemberIds.has(user.id))
      .map((user) => {
        const principalId = principals?.resolveSubject(
          "auth-user",
          user.id,
        )?.id;
        return {
          id: user.id,
          ...(principalId === undefined ? {} : { principalId }),
          name: user.name,
          platformRole: platformRoleLabel(user.role),
        };
      }),
    agents: agentDirectory
      .filter((teammate) => !agentMemberIds.has(teammate.id))
      .map((teammate) => {
        const principalId =
          principals?.resolveSubject("teammate", teammate.id)?.id ??
          (teammate.employeeId === undefined
            ? undefined
            : employees
                ?.list()
                .find((employee) => employee.id === teammate.employeeId)
                ?.principalId);
        return {
          id: teammate.id,
          ...(principalId === undefined ? {} : { principalId }),
          name: teammate.name,
          kindLabel:
            teammate.source === "personal"
              ? `个人分身 · ${teammate.ownerName}`
              : "平台 AI伙伴",
          platformRole: teammatePlatformRole(teammate),
          ...(teammate.ownerName === ""
            ? {}
            : { ownerName: teammate.ownerName }),
        };
      }),
  };
  return { members: [...humans, ...agents], directory };
}

/** roles 插件自动补齐的系统席位，不属于项目自定义角色。 */
const FACILITATOR_SEAT_ID = "facilitator";
const SYSTEM_SEAT_IDS = new Set([FACILITATOR_SEAT_ID]);
const ROLE_PERMISSION_VALUES: readonly RolePermission[] = [
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
];

/** 项目角色定义 → 席位定义。 */
function seatOfProjectRole(role: ProjectRoleDefinition): SeatLike {
  return {
    id: role.id,
    label: role.name,
    participantKind: "any",
    permissions: [...role.permissions],
  };
}

/** 把模版角色复制成项目自己的角色副本。 */
function templateProjectRoles(
  service: ProjectService,
  template: ProjectTemplateRecord,
): ProjectRoleDefinition[] {
  return template.roleIds
    .map((roleId) => service.role(roleId))
    .filter((role): role is ProjectRoleRecord => role !== undefined)
    .map((role) => ({
      id: role.id,
      name: role.name,
      code: role.code,
      category: role.category,
      description: role.description,
      permissions: [...role.permissions],
    }));
}

/**
 * 把项目自己的角色定义同步成 roles 插件的席位。
 * 项目清空角色时只保留系统 Facilitator 席位（roles 插件本身也会补齐它），
 * 这样已删除角色的指派会被 materialize 自动清理。
 */
async function syncProjectSeats(
  service: ProjectService,
  assignments: AssignmentServiceLike,
  actor: RoleActorLike,
  project: ProjectRecord,
  now: () => Date,
): Promise<WorkspaceRoleConfigLike> {
  return materializeProjectSeats(
    service,
    assignments,
    actor,
    project,
    project.projectRoles.map(seatOfProjectRole),
    now,
  );
}

/** 将一组席位物化到项目；空集合只保留系统 Facilitator 席位。 */
async function materializeProjectSeats(
  service: ProjectService,
  assignments: AssignmentServiceLike,
  actor: RoleActorLike,
  project: ProjectRecord,
  inputSeats: readonly SeatLike[],
  now: () => Date,
): Promise<WorkspaceRoleConfigLike> {
  const seats: SeatLike[] =
    inputSeats.length === 0
      ? [
          {
            id: FACILITATOR_SEAT_ID,
            label: "会议 Facilitator",
            participantKind: "agent",
            permissions: ["read", "write"],
          },
        ]
      : [...inputSeats];
  const template =
    project.templateId === undefined
      ? undefined
      : service.template(project.templateId);
  const timestamp = nowIso(now);
  return assignments.materialize(actor, project.workspaceId, {
    id: template?.id ?? "project-roles",
    name: template?.name ?? "项目角色",
    description: "项目自定义角色清单",
    seats,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/**
 * 确保项目角色已初始化：
 * - 已初始化：原样返回（用户主动清空后不会复活）；
 * - 未初始化但已应用模版：复制模版角色；
 * - 未初始化但已有物化席位：从席位迁移（跳过系统 Facilitator）；
 * - 都没有：保持空清单，由用户添加角色或应用模版。
 */
async function ensureProjectRoleCopy(
  service: ProjectService,
  assignments: AssignmentServiceLike | undefined,
  project: ProjectRecord,
): Promise<ProjectRecord> {
  if (project.rolesInitialized) return project;
  if (project.templateId !== undefined) {
    const template = service.template(project.templateId);
    if (template !== undefined) {
      const roles = templateProjectRoles(service, template);
      if (roles.length > 0) {
        return service.replaceProjectRoles({
          workspaceId: project.workspaceId,
          roles,
          templateId: template.id,
        });
      }
    }
  }
  if (assignments !== undefined) {
    let seats: readonly SeatLike[] = [];
    try {
      seats = assignments.config(project.workspaceId).seats;
    } catch {
      seats = [];
    }
    const roles = seats
      .filter((seat) => !SYSTEM_SEAT_IDS.has(seat.id))
      .map((seat) => {
        const valid = seat.permissions.filter(
          (permission): permission is RolePermission =>
            (ROLE_PERMISSION_VALUES as readonly string[]).includes(permission),
        );
        const permissions: RolePermission[] =
          valid.length === 0 ? ["read", "write"] : valid;
        return {
          id: seat.id,
          name: seat.label,
          code: seat.id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase(),
          category: "执行" as const,
          description: "从既有项目席位迁移",
          permissions,
        };
      });
    if (roles.length > 0) {
      return service.replaceProjectRoles({
        workspaceId: project.workspaceId,
        roles,
      });
    }
  }
  return project;
}

interface ProjectViewInput {
  readonly project: ProjectRecord;
  readonly workspace: WorkspaceLike;
  readonly isMember: boolean;
  readonly memberRole: MemberRole | undefined;
  readonly humanMemberCount: number;
  readonly aiPartnerCount: number;
  readonly tasks: readonly TaskLike[];
  readonly workflows: readonly WorkflowInstanceLike[];
  readonly today: string;
}

function projectView(input: ProjectViewInput): Record<string, unknown> {
  const tasks = activeTasks(input.tasks);
  return {
    ...input.project,
    name: input.workspace.title,
    path: input.workspace.path,
    isMember: input.isMember,
    ...(input.memberRole === undefined ? {} : { memberRole: input.memberRole }),
    counts: {
      members: input.humanMemberCount + input.aiPartnerCount,
      humans: input.humanMemberCount,
      aiPartners: input.aiPartnerCount,
      tasks: tasks.length,
      workflows: input.workflows.length,
    },
    notes: notesOf(tasks, input.workflows, input.today),
  };
}

interface ReportInput {
  readonly project: ProjectRecord;
  readonly workspace: WorkspaceLike;
  readonly tasks: readonly TaskLike[];
  readonly workflows: readonly WorkflowInstanceLike[];
  readonly today: string;
}

const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "待处理",
  progress: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
};

const WORKFLOW_STATUS_LABEL: Record<string, string> = {
  running: "进行中",
  waiting: "等待中",
  blocked: "阻塞",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

/**
 * 项目日报正文：按当前项目快照确定性生成，不依赖模型。
 * 结构与 demo 一致：今日结论 / 关键进展 / 风险与待确认 / 下一步。
 */
export function buildProjectReportContent(input: ReportInput): string {
  const tasks = activeTasks(input.tasks);
  const inProgress = tasks.filter((task) => task.status === "progress");
  const review = tasks.filter((task) => task.status === "review");
  const blockedWorkflows = input.workflows.filter(
    (workflow) => workflow.status === "blocked",
  );
  const runningWorkflows = input.workflows.filter((workflow) =>
    ["running", "waiting"].includes(workflow.status),
  );
  const overdue = tasks.filter(
    (task) =>
      task.due !== undefined &&
      task.due !== "" &&
      task.due.slice(0, 10) < input.today &&
      task.status !== "done" &&
      task.status !== "cancelled",
  );
  const highlights = [...tasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3)
    .map(
      (task) =>
        `- \`${task.id}\` ${task.title}（${TASK_STATUS_LABEL[task.status] ?? task.status}）`,
    );
  const workflowHighlights = [...input.workflows]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3)
    .map(
      (workflow) =>
        `- 工作流「${workflow.title}」（${
          WORKFLOW_STATUS_LABEL[workflow.status] ?? workflow.status
        }）`,
    );
  const risks: string[] = [];
  for (const workflow of blockedWorkflows.slice(0, 3)) {
    risks.push(
      `- 工作流「${workflow.title}」当前阻塞，需要确认责任人与解除条件。`,
    );
  }
  for (const task of overdue.slice(0, 3)) {
    risks.push(
      `- \`${task.id}\` 已超过截止日期 ${task.due?.slice(0, 10) ?? ""}，仍处于 ${
        TASK_STATUS_LABEL[task.status] ?? task.status
      }。`,
    );
  }
  if (input.project.health !== "健康") {
    risks.push(
      `- 项目健康度为「${input.project.health}」，需要关注跨团队依赖。`,
    );
  }
  if (risks.length === 0) {
    risks.push("- 暂无阻塞项，保持当前节奏并继续观察关键路径。");
  }
  return [
    "## 今日结论",
    "",
    `${input.workspace.title} 当前处于「${input.project.status}」状态，整体进度 ${input.project.progress}%，健康度${input.project.health}。`,
    "",
    "## 关键进展",
    "",
    `- 活跃任务 ${tasks.length} 项，其中进行中 ${inProgress.length} 项、待验收 ${review.length} 项。`,
    `- 关联工作流 ${input.workflows.length} 个，其中进行中 ${runningWorkflows.length} 个、阻塞 ${blockedWorkflows.length} 个。`,
    ...(highlights.length === 0 ? [] : ["- 最近更新的任务：", ...highlights]),
    ...(workflowHighlights.length === 0
      ? []
      : ["- 最近更新的工作流：", ...workflowHighlights]),
    "",
    "## 风险与待确认",
    "",
    ...risks,
    "",
    "## 下一步",
    "",
    "- 在项目周会中确认负责人、截止时间和下一检查点。",
    `- 目标日期 ${input.project.targetDate === "" ? "未设置" : input.project.targetDate}，按当前进度校准交付范围。`,
  ].join("\n");
}

const memberSaveSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  memberKind: projectMemberKindSchema,
  memberId: z.string().trim().min(1).max(240),
  roleIds: z.array(z.string().trim().min(1).max(160)).max(50),
  workspaceRole: z.enum(["owner", "member", "guest"]).optional(),
});

const memberRemoveSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  memberKind: projectMemberKindSchema,
  memberId: z.string().trim().min(1).max(240),
});

const templateSaveSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(40),
  status: z.enum(["启用", "停用"]),
  description: z.string().trim().max(500).default(""),
  roleIds: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  workflowTemplateIds: z
    .array(z.string().trim().min(1).max(160))
    .max(50)
    .optional(),
});

const roleSaveSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(80),
  category: roleCategorySchema,
  description: z.string().trim().max(500).default(""),
  permissions: z.array(rolePermissionSchema).max(5).default([]),
});

/** 项目自己的角色定义（模版/角色库只做预填，不被引用修改）。 */
const projectRoleSaveSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  role: z.object({
    id: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().min(1).max(80),
    category: roleCategorySchema,
    description: z.string().trim().max(500).default(""),
    permissions: z.array(rolePermissionSchema).min(1).max(5),
  }),
});

const projectRoleRemoveSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  roleId: z.string().trim().min(1).max(160),
});

/** 从其他项目复用角色定义：默认复制所选角色，按 id / code 去重。 */
const projectRoleImportSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  sourceWorkspaceId: z.string().trim().min(1).max(160),
  roleIds: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
});

/** 草稿确认：整组覆盖生效，不再有单条增删接口的语义。 */
const rolesConfirmSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().positive(),
  roles: z.array(projectRoleDefinitionSchema).max(50),
  ackMemberLoss: z.boolean().default(false),
});

export function createProjectRoutes(
  service: ProjectService,
  dependencies: ProjectDependencies,
): WebRouteLike[] {
  const now = dependencies.now ?? (() => new Date());
  const { team, workspaces } = dependencies;

  function today(): string {
    return nowIso(now).slice(0, 10);
  }

  function tasksOf(workspaceId: string): TaskLike[] {
    return [...(dependencies.tasks()?.list(workspaceId) ?? [])];
  }

  function workflowsOf(workspaceId: string): WorkflowInstanceLike[] {
    return [...(dependencies.workflows()?.instances(workspaceId) ?? [])];
  }

  function actorName(userId: string): string {
    return team.users().find((user) => user.id === userId)?.name ?? userId;
  }

  const WORKSPACE_ROLE_PERMISSIONS: Record<MemberRole, readonly string[]> = {
    owner: ["read", "write", "approve", "manage_members"],
    member: ["read", "write"],
    guest: ["read"],
  };

  async function syncWorkspaceMembershipGrant(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: MemberRole;
    readonly actorId: string;
  }): Promise<void> {
    const principals = dependencies.principals?.();
    if (principals === undefined) return;
    const principal = principals.resolveSubject("auth-user", input.userId);
    if (principal === undefined) return;
    const actor = principals.resolveSubject("auth-user", input.actorId);
    await principals.syncExclusiveGrant({
      principalId: principal.id,
      scopeType: "workspace",
      scopeId: input.workspaceId,
      role: `workspace-${input.role}`,
      permissions: WORKSPACE_ROLE_PERMISSIONS[input.role],
      ...(actor === undefined ? {} : { grantedByPrincipalId: actor.id }),
    });
  }

  async function revokeWorkspaceMembershipGrant(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: MemberRole;
  }): Promise<void> {
    const principals = dependencies.principals?.();
    if (principals === undefined) return;
    const principal = principals.resolveSubject("auth-user", input.userId);
    if (principal === undefined) return;
    await principals.revokeMatchingGrants({
      principalId: principal.id,
      scopeType: "workspace",
      scopeId: input.workspaceId,
      role: `workspace-${input.role}`,
    });
  }

  const hydratedWorkspaceGrants = new Set<string>();
  async function hydrateWorkspaceMembershipGrants(
    workspaceId: string,
    actorId: string,
  ): Promise<void> {
    if (hydratedWorkspaceGrants.has(workspaceId)) return;
    hydratedWorkspaceGrants.add(workspaceId);
    for (const member of team.members(workspaceId)) {
      await syncWorkspaceMembershipGrant({
        workspaceId,
        userId: member.userId,
        role: member.memberRole,
        actorId,
      });
    }
  }

  async function appendProjectAudit(
    current: TeamPrincipalLike,
    workspaceId: string,
    input: {
      readonly category: ProjectAuditRecord["category"];
      readonly action: string;
      readonly targetId?: string | undefined;
      readonly targetName?: string | undefined;
      readonly summary: string;
      readonly detail?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<void> {
    const actorPrincipalId = dependencies
      .principals?.()
      ?.resolveSubject("auth-user", current.userId)?.id;
    await service.appendAudit({
      workspaceId,
      actorId: current.userId,
      ...(actorPrincipalId === undefined ? {} : { actorPrincipalId }),
      actorName: actorName(current.userId),
      actorRole: current.role,
      category: input.category,
      action: input.action,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.targetName === undefined
        ? {}
        : { targetName: input.targetName }),
      summary: input.summary,
      detail: input.detail ?? {},
    });
  }

  function changedProjectSettings(
    before: ProjectRecord,
    after: ProjectRecord,
  ): Record<string, string> {
    const fields: Array<{
      key: keyof ProjectRecord;
      label: string;
      format?: (value: unknown) => string;
    }> = [
      { key: "ownerName", label: "负责人" },
      { key: "status", label: "运行状态" },
      { key: "health", label: "健康度" },
      { key: "progress", label: "进度", format: (value) => `${value}%` },
      { key: "startDate", label: "开始日期" },
      { key: "targetDate", label: "目标日期" },
      { key: "description", label: "项目说明" },
    ];
    const detail: Record<string, string> = {};
    for (const field of fields) {
      const beforeValue = before[field.key] ?? "";
      const afterValue = after[field.key] ?? "";
      if (beforeValue === afterValue) continue;
      const format =
        field.format ?? ((value: unknown) => String(value || "未设置"));
      detail[field.label] = `${format(beforeValue)} → ${format(afterValue)}`;
    }
    return detail;
  }

  function auditSemantic(action: string): string {
    if (action.endsWith("member.add")) return "member.add";
    if (action.endsWith("member.update")) return "member.add";
    if (action.endsWith("member.remove") || action.endsWith("member.leave")) {
      return "member.remove";
    }
    if (action.endsWith("member.roles.update")) return "member.roles.update";
    return action;
  }

  function identityAuditDetail(
    detail: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const labels: Record<string, string> = {
      memberRole: "工作区角色",
      name: "账号名称",
      role: "平台角色",
      status: "账号状态",
    };
    const workspaceRoleValues: Record<string, string> = {
      owner: "项目负责人",
      member: "项目成员",
      guest: "项目访客",
    };
    const platformRoleValues: Record<string, string> = {
      admin: "平台管理员",
      owner: "平台负责人",
      member: "平台成员",
      guest: "平台访客",
    };
    const statusValues: Record<string, string> = {
      active: "启用",
      disabled: "停用",
    };
    return Object.fromEntries(
      Object.entries(detail).map(([key, value]) => {
        const translated =
          key === "memberRole"
            ? (workspaceRoleValues[value] ?? value)
            : key === "role"
              ? (platformRoleValues[value] ?? value)
              : key === "status"
                ? (statusValues[value] ?? value)
                : value;
        return [labels[key] ?? key, translated];
      }),
    );
  }

  function mergeProjectAudit(
    workspaceId: string,
    limit: number,
  ): ProjectAuditRecord[] {
    const userById = new Map(team.users().map((user) => [user.id, user]));
    const humanMemberIds = new Set(
      team.members(workspaceId).map((member) => member.userId),
    );
    const projectEvents = service.audits(workspaceId, 500);
    const rawIdentityEvents = team.audit?.({ limit: 500 }) ?? [];
    for (const event of projectEvents) {
      if (event.category === "member" && event.targetId !== undefined) {
        humanMemberIds.add(event.targetId);
      }
    }
    for (const event of rawIdentityEvents) {
      if (
        event.workspaceId === workspaceId &&
        ["member_add", "member_remove", "member_leave"].includes(
          event.action,
        ) &&
        event.targetId !== undefined
      ) {
        humanMemberIds.add(event.targetId);
      }
    }
    const identityEvents: ProjectAuditRecord[] = [];
    for (const event of rawIdentityEvents) {
      const action = event.action;
      const projectScoped = event.workspaceId === workspaceId;
      const accountScoped =
        event.workspaceId === undefined &&
        (action === "register_user" || action === "update_user") &&
        event.targetId !== undefined &&
        humanMemberIds.has(event.targetId);
      if (!projectScoped && !accountScoped) continue;
      let category: ProjectAuditRecord["category"] = "identity";
      let mappedAction = `identity.${action.replaceAll("_", ".")}`;
      let summary = "";
      if (action === "member_add") {
        category = "member";
        summary = `协作身份添加成员「${
          userById.get(event.targetId ?? "")?.name ?? event.targetId ?? ""
        }」`;
      } else if (action === "member_remove") {
        category = "member";
        summary = `协作身份移除成员「${
          userById.get(event.targetId ?? "")?.name ?? event.targetId ?? ""
        }」`;
      } else if (action === "member_leave") {
        category = "member";
        mappedAction = "identity.member.leave";
        summary = `成员「${
          userById.get(event.targetId ?? "")?.name ?? event.targetId ?? ""
        }」离开项目`;
      } else if (action === "register_user") {
        summary = `创建平台账号「${
          userById.get(event.targetId ?? "")?.name ?? event.targetId ?? ""
        }」`;
      } else if (action === "update_user") {
        summary = `更新平台账号「${
          userById.get(event.targetId ?? "")?.name ?? event.targetId ?? ""
        }」`;
      } else {
        continue;
      }
      const actorPrincipalId = dependencies
        .principals?.()
        ?.resolveSubject("auth-user", event.actorId)?.id;
      identityEvents.push({
        id: `identity:${event.id}`,
        workspaceId,
        at: event.at,
        actorId: event.actorId,
        ...(actorPrincipalId === undefined ? {} : { actorPrincipalId }),
        actorName: userById.get(event.actorId)?.name ?? event.actorId,
        actorRole: event.actorRole,
        source: "identity",
        category,
        action: mappedAction,
        ...(event.targetId === undefined
          ? {}
          : {
              targetId: event.targetId,
              targetName: userById.get(event.targetId)?.name ?? event.targetId,
            }),
        summary,
        detail: identityAuditDetail(event.detail),
        createdAt: event.at,
      });
    }

    const usedProjectEvents = new Set<string>();
    const uniqueIdentityEvents = identityEvents.filter((identity) => {
      const at = Date.parse(identity.at);
      const duplicate = projectEvents.find((project) => {
        if (usedProjectEvents.has(project.id)) return false;
        if (auditSemantic(project.action) !== auditSemantic(identity.action)) {
          return false;
        }
        if ((project.targetId ?? "") !== (identity.targetId ?? "")) {
          return false;
        }
        const projectAt = Date.parse(project.at);
        return (
          Number.isFinite(at) &&
          Number.isFinite(projectAt) &&
          Math.abs(projectAt - at) <= 5_000
        );
      });
      if (duplicate === undefined) return true;
      usedProjectEvents.add(duplicate.id);
      return false;
    });
    return [...projectEvents, ...uniqueIdentityEvents]
      .sort((left, right) => {
        const byTime = right.at.localeCompare(left.at);
        return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
      })
      .slice(0, limit);
  }

  /**
   * 读取项目记录，缺失时自动建档并分配 `PRJ` + 6 位数字编号，
   * 保证项目清单里不再出现「未编号」。
   */
  function ensureProjectRecord(
    workspace: WorkspaceLike,
  ): Promise<ProjectRecord> {
    return service.ensureProject({
      workspaceId: workspace.id,
      ...ownerOfWorkspace(team, workspace.id),
    });
  }

  function activeAgentIds(workspaceId: string): string[] {
    const assignments = dependencies.assignments();
    return [
      ...new Set(
        activeSeats(assignments, workspaceId)
          .filter((assignment) => assignment.assigneeKind === "agent")
          .map((assignment) => assignment.assigneeId),
      ),
    ];
  }

  /**
   * 应用项目模版：把模版角色复制成项目自己的角色副本，
   * 再同步成 roles 插件的席位，并记录已应用的模版。
   */
  async function applyTemplateToProject(
    current: TeamPrincipalLike,
    workspaceId: string,
    templateId: string,
  ): Promise<ProjectRecord> {
    const template = service.template(templateId);
    if (template === undefined) {
      throw new ProjectError("not_found", "项目模版不存在");
    }
    const roles = templateProjectRoles(service, template);
    if (roles.length === 0) {
      throw new ProjectError("invalid_input", "项目模版没有可用的项目角色");
    }
    const project = await service.replaceProjectRoles({
      workspaceId,
      roles,
      templateId: template.id,
    });
    const assignments = dependencies.assignments();
    if (assignments === undefined) {
      throw new ProjectError("invalid_input", "项目角色服务不可用");
    }
    await syncProjectSeats(
      service,
      assignments,
      actorOf(current, team, workspaceId),
      project,
      now,
    );
    await appendProjectAudit(current, workspaceId, {
      category: "template",
      action: "template.apply",
      targetId: template.id,
      targetName: template.name,
      summary: `应用项目模版「${template.name}」`,
      detail: {
        模版编码: template.code,
        生效角色数: String(roles.length),
        角色清单: roles.map((role) => role.name).join("、"),
      },
    });
    return project;
  }

  async function projectViews(current: TeamPrincipalLike): Promise<unknown[]> {
    const date = today();
    return Promise.all(
      workspaces.list().map(async (workspace) => {
        const memberRole = memberRoleOf(team, workspace.id, current.userId);
        const humanMembers = team.members(workspace.id).length;
        const aiPartners = activeAgentIds(workspace.id).length;
        return projectView({
          project: await ensureProjectRecord(workspace),
          workspace,
          isMember: memberRole !== undefined,
          memberRole,
          humanMemberCount: humanMembers,
          aiPartnerCount: aiPartners,
          tasks: tasksOf(workspace.id),
          workflows: workflowsOf(workspace.id),
          today: date,
        });
      }),
    );
  }

  const list = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const current = principal(request, team);
      const views = await projectViews(current);
      sendJson(response, 200, {
        ok: true,
        projects:
          current.role === "admin"
            ? views
            : views.filter(
                (project) =>
                  (project as { readonly isMember?: boolean }).isMember ===
                  true,
              ),
        viewer: {
          id: current.userId,
          role: current.role,
          name:
            team.users().find((user) => user.id === current.userId)?.name ??
            current.userId,
        },
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const detail = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const workspaceId = query(request).get("workspaceId") ?? "";
      const current = requireWorkspaceAccess(request, team, workspaceId);
      const workspace = workspaces.get(workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      await hydrateWorkspaceMembershipGrants(workspaceId, current.userId);
      const assignments = dependencies.assignments();
      let project = await ensureProjectRecord(workspace);
      project = await ensureProjectRoleCopy(service, assignments, project);
      let config: WorkspaceRoleConfigLike | undefined;
      try {
        config = assignments?.config(workspaceId);
      } catch {
        config = undefined;
      }
      const seats = config?.seats ?? [];
      const catalog = new Map(service.roles().map((role) => [role.id, role]));
      const roleMap = new Map<
        string,
        { name: string; permissions: readonly string[] }
      >();
      for (const role of project.projectRoles) roleMap.set(role.id, role);
      for (const seat of seats) {
        if (roleMap.has(seat.id)) continue;
        const catalogRole = catalog.get(seat.id);
        roleMap.set(seat.id, {
          name: catalogRole?.name ?? seat.label,
          permissions: catalogRole?.permissions ?? seat.permissions,
        });
      }
      const memberCountBySeat = new Map<string, number>();
      for (const assignment of activeSeats(assignments, workspaceId)) {
        memberCountBySeat.set(
          assignment.seatId,
          (memberCountBySeat.get(assignment.seatId) ?? 0) + 1,
        );
      }
      const roleList = [
        ...project.projectRoles.map((role) => ({
          ...role,
          memberCount: memberCountBySeat.get(role.id) ?? 0,
          system: false,
        })),
        ...seats
          .filter((seat) => SYSTEM_SEAT_IDS.has(seat.id))
          .map((seat) => ({
            id: seat.id,
            name: roleMap.get(seat.id)?.name ?? seat.label,
            code: seat.id.toUpperCase(),
            category: "支持",
            description:
              "平台系统席位（会议 Facilitator），不属于项目自定义角色。",
            permissions: roleMap.get(seat.id)?.permissions ?? seat.permissions,
            memberCount: memberCountBySeat.get(seat.id) ?? 0,
            system: true,
          })),
      ];
      const memberDirectory = buildMembers(
        team,
        assignments,
        dependencies.teammates(),
        dependencies.employees(),
        dependencies.principals?.(),
        workspaceId,
        {
          userId: current.userId,
          name:
            team.users().find((user) => user.id === current.userId)?.name ??
            current.userId,
          role: current.role,
        },
        roleMap,
      );
      const tasks = tasksOf(workspaceId);
      const workflows = workflowsOf(workspaceId);
      const memberRole = memberRoleOf(team, workspaceId, current.userId);
      sendJson(response, 200, {
        ok: true,
        project: projectView({
          project,
          workspace,
          isMember: memberRole !== undefined,
          memberRole,
          humanMemberCount: memberDirectory.members.filter(
            (member) => member.kind === "human",
          ).length,
          aiPartnerCount: memberDirectory.members.filter(
            (member) => member.kind === "agent",
          ).length,
          tasks,
          workflows,
          today: today(),
        }),
        members: memberDirectory.members,
        directory: memberDirectory.directory,
        roles: roleList,
        roleLibrary: service.roles(),
        templates: service.templates(),
        tasks: activeTasks(tasks),
        workflows,
        viewer: {
          id: current.userId,
          role: current.role,
          workspaceRole: memberRole ?? null,
          canManage: current.role === "admin" || memberRole === "owner",
        },
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const update = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(
        request,
        z.object({
          workspaceId: z.string().trim().min(1).max(160),
          ownerId: z.string().trim().min(1).max(160).optional(),
          status: projectStatusSchema.optional(),
          health: projectHealthSchema.optional(),
          progress: z.number().int().min(0).max(100).optional(),
          startDate: z.string().trim().max(20).optional(),
          targetDate: z.string().trim().max(20).optional(),
          description: z.string().trim().max(2000).optional(),
        }),
      );
      const current = requireProjectManager(request, team, body.workspaceId);
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const ownerUser =
        body.ownerId === undefined
          ? undefined
          : team.users().find((user) => user.id === body.ownerId);
      if (body.ownerId !== undefined && ownerUser === undefined) {
        throw new ProjectError("invalid_input", "项目负责人不是有效用户");
      }
      if (
        body.ownerId !== undefined &&
        memberRoleOf(team, body.workspaceId, body.ownerId) === undefined
      ) {
        throw new ProjectError("invalid_input", "项目负责人必须是该项目成员");
      }
      const before = await ensureProjectRecord(workspace);
      const project = await service.upsertProject({
        workspaceId: body.workspaceId,
        ...(body.ownerId === undefined
          ? {}
          : { ownerId: body.ownerId, ownerName: ownerUser?.name ?? "" }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.health === undefined ? {} : { health: body.health }),
        ...(body.progress === undefined ? {} : { progress: body.progress }),
        ...(body.startDate === undefined ? {} : { startDate: body.startDate }),
        ...(body.targetDate === undefined
          ? {}
          : { targetDate: body.targetDate }),
        ...(body.description === undefined
          ? {}
          : { description: body.description }),
      });
      const changes = changedProjectSettings(before, project);
      if (Object.keys(changes).length > 0) {
        await appendProjectAudit(current, body.workspaceId, {
          category: "project",
          action: "project.settings.update",
          targetId: body.workspaceId,
          targetName: workspace.title,
          summary: `更新项目设置（${Object.keys(changes).length} 项）`,
          detail: changes,
        });
      }
      sendJson(response, 200, { ok: true, project });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /**
   * 新建项目：把一个已存在的本地目录注册为 DSH 工作区（项目），
   * 创建者成为项目成员与项目负责人；可选同时应用项目模版。
   * 不自动创建磁盘目录，也不会改动任何平台级账号或平台角色。
   */
  const create = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(
        request,
        z.object({
          path: z.string().trim().min(1).max(1024),
          name: z.string().trim().min(1).max(80),
          templateId: z.string().trim().min(1).max(160).optional(),
        }),
      );
      const current = principal(request, team);
      if (workspaces.create === undefined) {
        throw new ProjectError("invalid_input", "工作区服务不可用");
      }
      let created: WorkspaceLike;
      try {
        created = await workspaces.create(body.path, body.name);
      } catch {
        throw new ProjectError(
          "invalid_input",
          "无法把该目录注册为项目：目录不存在或已被占用",
        );
      }
      if (created.setTitle !== undefined && created.title !== body.name) {
        await created.setTitle(body.name);
      }
      const members = team.members(created.id);
      if (
        members.length > 0 &&
        memberRoleOf(team, created.id, current.userId) === undefined
      ) {
        throw new ProjectError("forbidden", "该项目已存在成员，无法认领");
      }
      if (members.length === 0) {
        await team.addMember(current.userId, {
          workspaceId: created.id,
          userId: current.userId,
          role: "owner",
        });
      }
      const userName =
        team.users().find((user) => user.id === current.userId)?.name ??
        current.userId;
      let project = await service.upsertProject({
        workspaceId: created.id,
        ownerId: current.userId,
        ownerName: userName,
      });
      await appendProjectAudit(current, created.id, {
        category: "project",
        action: "project.create",
        targetId: created.id,
        targetName: created.title,
        summary: `创建项目「${created.title}」`,
        detail: {
          项目编号: project.code,
          项目目录: created.path,
          项目负责人: userName,
        },
      });
      if (body.templateId !== undefined) {
        project = await applyTemplateToProject(
          current,
          created.id,
          body.templateId,
        );
      }
      sendJson(response, 201, {
        ok: true,
        workspaceId: created.id,
        project,
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const templateList = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    try {
      assertSameOrigin(request);
      principal(request, team);
      const definitions = dependencies.workflows()?.sharedDefinitions?.() ?? [];
      sendJson(response, 200, {
        ok: true,
        templates: service.templates(),
        roles: service.roles(),
        workflowTemplates: definitions.map((definition) => ({
          id: definition.id,
          key: definition.key,
          version: definition.version,
          name: definition.name,
          description: definition.description,
          status: definition.status,
        })),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const templateSave = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      requirePlatformAdmin(request, team);
      const body = await readBodyAs(request, templateSaveSchema);
      const template = await service.saveTemplate({
        ...body,
        ...(body.roleIds === undefined ? {} : { roleIds: body.roleIds }),
        ...(body.workflowTemplateIds === undefined
          ? {}
          : { workflowTemplateIds: body.workflowTemplateIds }),
      });
      sendJson(response, 200, { ok: true, template });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const templateRemove = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      requirePlatformAdmin(request, team);
      const body = await readBodyAs(
        request,
        z.object({ id: z.string().trim().min(1).max(160) }),
      );
      await service.removeTemplate(body.id);
      sendJson(response, 200, { ok: true });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const templateApply = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(
        request,
        z.object({
          workspaceId: z.string().trim().min(1).max(160),
          templateId: z.string().trim().min(1).max(160),
        }),
      );
      const current = requireProjectManager(request, team, body.workspaceId);
      const project = await applyTemplateToProject(
        current,
        body.workspaceId,
        body.templateId,
      );
      sendJson(response, 200, {
        ok: true,
        project,
        template: service.template(body.templateId),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const roleSave = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      requirePlatformAdmin(request, team);
      const body = await readBodyAs(request, roleSaveSchema);
      const role = await service.saveRole({
        ...body,
        permissions:
          body.permissions.length === 0 ? undefined : body.permissions,
      });
      sendJson(response, 200, { ok: true, role });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const roleRemove = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      requirePlatformAdmin(request, team);
      const body = await readBodyAs(
        request,
        z.object({ id: z.string().trim().min(1).max(160) }),
      );
      await service.removeRole(body.id);
      sendJson(response, 200, { ok: true });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /** 保存项目自己的角色定义（新增/编辑），并同步项目席位。 */
  const projectRoleSave = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      principal(request, team);
      const body = await readBodyAs(request, projectRoleSaveSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const assignments = dependencies.assignments();
      await ensureProjectRoleCopy(
        service,
        assignments,
        await ensureProjectRecord(workspace),
      );
      const project = await service.saveProjectRole({
        workspaceId: body.workspaceId,
        role: body.role,
      });
      if (assignments !== undefined) {
        await syncProjectSeats(
          service,
          assignments,
          actorOf(current, team, body.workspaceId),
          project,
          now,
        );
      }
      await appendProjectAudit(current, body.workspaceId, {
        category: "role",
        action: "role.save",
        targetId: body.role.id,
        targetName: body.role.name,
        summary: `保存项目角色「${body.role.name}」`,
        detail: {
          角色标识: body.role.code,
          角色分类: body.role.category,
          授权范围: body.role.permissions
            .map((permission) => PERMISSION_LABEL[permission] ?? permission)
            .join("、"),
        },
      });
      sendJson(response, 200, { ok: true, project });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /** 删除项目自己的角色定义；席位与指派同步清理。 */
  const projectRoleRemove = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      principal(request, team);
      const body = await readBodyAs(request, projectRoleRemoveSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const assignments = dependencies.assignments();
      const before = await ensureProjectRecord(workspace);
      const removedRole = before.projectRoles.find(
        (role) => role.id === body.roleId,
      );
      const project = await service.removeProjectRole({
        workspaceId: body.workspaceId,
        roleId: body.roleId,
      });
      if (assignments !== undefined) {
        await syncProjectSeats(
          service,
          assignments,
          actorOf(current, team, body.workspaceId),
          project,
          now,
        );
      }
      await appendProjectAudit(current, body.workspaceId, {
        category: "role",
        action: "role.remove",
        targetId: body.roleId,
        targetName: removedRole?.name ?? body.roleId,
        summary: `移除项目角色「${removedRole?.name ?? body.roleId}」`,
        detail: {
          角色标识: removedRole?.code ?? "",
        },
      });
      sendJson(response, 200, { ok: true, project });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /** 可作为角色复用来源的项目：当前用户可访问、且已有项目角色。 */
  const roleSources = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const current = principal(request, team);
      const workspaceId = query(request).get("workspaceId") ?? "";
      requireWorkspaceAccess(request, team, workspaceId);
      const assignments = dependencies.assignments();
      const sources: Array<{
        workspaceId: string;
        name: string;
        code: string;
        roles: readonly ProjectRoleDefinition[];
      }> = [];
      for (const workspace of workspaces.list()) {
        if (workspace.id === workspaceId) continue;
        if (
          current.role !== "admin" &&
          memberRoleOf(team, workspace.id, current.userId) === undefined
        ) {
          continue;
        }
        let project = await ensureProjectRecord(workspace);
        project = await ensureProjectRoleCopy(service, assignments, project);
        if (project.projectRoles.length === 0) continue;
        sources.push({
          workspaceId: workspace.id,
          name: workspace.title,
          code: project.code,
          roles: project.projectRoles,
        });
      }
      sendJson(response, 200, { ok: true, sources });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /** 从另一个项目复用角色定义：合并进当前项目，按 id / code 去重。 */
  const roleImport = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      principal(request, team);
      const body = await readBodyAs(request, projectRoleImportSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      if (body.sourceWorkspaceId === body.workspaceId) {
        throw new ProjectError("invalid_input", "不能从当前项目自身复用角色");
      }
      requireWorkspaceAccess(request, team, body.sourceWorkspaceId);
      const sourceWorkspace = workspaces.get(body.sourceWorkspaceId);
      const targetWorkspace = workspaces.get(body.workspaceId);
      if (sourceWorkspace === undefined || targetWorkspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const assignments = dependencies.assignments();
      let source = await ensureProjectRecord(sourceWorkspace);
      source = await ensureProjectRoleCopy(service, assignments, source);
      let target = await ensureProjectRecord(targetWorkspace);
      target = await ensureProjectRoleCopy(service, assignments, target);
      const selected = new Set(body.roleIds);
      const existingIds = new Set(target.projectRoles.map((role) => role.id));
      const existingCodes = new Set(
        target.projectRoles.map((role) => role.code),
      );
      const next = [...target.projectRoles];
      let imported = 0;
      let skipped = 0;
      for (const role of source.projectRoles) {
        if (!selected.has(role.id)) continue;
        if (existingIds.has(role.id) || existingCodes.has(role.code)) {
          skipped += 1;
          continue;
        }
        next.push({ ...role, permissions: [...role.permissions] });
        existingIds.add(role.id);
        existingCodes.add(role.code);
        imported += 1;
      }
      const project = await service.upsertProject({
        workspaceId: body.workspaceId,
        projectRoles: next,
        rolesInitialized: true,
      });
      if (
        assignments !== undefined &&
        (project.projectRoles.length > 0 || target.projectRoles.length > 0)
      ) {
        await syncProjectSeats(
          service,
          assignments,
          actorOf(current, team, body.workspaceId),
          project,
          now,
        );
      }
      if (imported > 0) {
        const importedNames = next
          .slice(target.projectRoles.length)
          .map((role) => role.name)
          .join("、");
        await appendProjectAudit(current, body.workspaceId, {
          category: "role",
          action: "role.import",
          targetId: body.sourceWorkspaceId,
          targetName: sourceWorkspace.title,
          summary: `从项目「${sourceWorkspace.title}」复用 ${imported} 个项目角色`,
          detail: {
            来源项目: `${sourceWorkspace.title}（${source.code}）`,
            导入角色: importedNames,
            跳过重复角色: String(skipped),
          },
        });
      }
      sendJson(response, 200, { ok: true, project, imported, skipped });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /**
   * 草稿确认：整组覆盖项目角色。
   * 校验 revision → 差异（按 code）→ 工作流模版阻塞 → 成员影响确认 → 原子生效。
   */
  const rolesConfirm = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      principal(request, team);
      const body = await readBodyAs(request, rolesConfirmSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const assignments = dependencies.assignments();
      let project = await ensureProjectRecord(workspace);
      project = await ensureProjectRoleCopy(service, assignments, project);
      if (body.expectedRevision !== project.rolesRevision) {
        throw new ProjectError(
          "revision_conflict",
          "项目角色已被其他人更新，请刷新后重新编辑",
          { currentRevision: project.rolesRevision },
        );
      }

      // 1) 规范化并校验 code / name 唯一。
      const seenCodes = new Set<string>();
      const seenNames = new Set<string>();
      const effectiveByCode = new Map(
        project.projectRoles.map((role) => [
          role.code.trim().toUpperCase(),
          role,
        ]),
      );
      const usedIds = new Set(project.projectRoles.map((role) => role.id));
      let generated = 0;
      const normalized: ProjectRoleDefinition[] = body.roles.map((role) => {
        const code = role.code.trim().toUpperCase();
        const name = role.name.trim();
        const nameKey = name.toLowerCase();
        if (seenCodes.has(code)) {
          throw new ProjectError("invalid_input", `角色标识重复：${code}`);
        }
        if (seenNames.has(nameKey)) {
          throw new ProjectError("invalid_input", `角色名称重复：${name}`);
        }
        seenCodes.add(code);
        seenNames.add(nameKey);
        const existing = effectiveByCode.get(code);
        let id = existing?.id ?? role.id;
        if (existing === undefined && usedIds.has(id)) {
          generated += 1;
          id = `role-${Date.now().toString(36)}-${generated}`;
        }
        usedIds.add(id);
        return {
          id,
          name,
          code,
          category: role.category,
          description: role.description,
          permissions: [...role.permissions],
        };
      });

      // 2) 差异（按 code 匹配，matched 角色保留原 id 与席位）。
      const nextCodes = new Set(normalized.map((role) => role.code));
      const fieldKey = (role: ProjectRoleDefinition) =>
        [
          role.name,
          role.category,
          role.description,
          [...role.permissions].sort().join(","),
        ].join("\u0000");
      const added = normalized.filter(
        (role) => !effectiveByCode.has(role.code),
      );
      const updated = normalized.filter((role) => {
        const existing = effectiveByCode.get(role.code);
        return existing !== undefined && fieldKey(existing) !== fieldKey(role);
      });
      const removed = project.projectRoles.filter(
        (role) => !nextCodes.has(role.code.trim().toUpperCase()),
      );
      const removedIds = new Set(removed.map((role) => role.id));
      const removedById = new Map(removed.map((role) => [role.id, role]));

      // 3) 已加载工作流模版：被引用角色不能下线。
      const template =
        project.templateId === undefined
          ? undefined
          : service.template(project.templateId);
      const loadedDefinitionIds = template?.workflowTemplateIds ?? [];
      const definitions = dependencies.workflows()?.sharedDefinitions?.() ?? [];
      const blockedTemplates: Array<Record<string, string>> = [];
      for (const definitionId of loadedDefinitionIds) {
        const definition = definitions.find(
          (candidate) => candidate.id === definitionId,
        );
        if (
          definition === undefined ||
          definition.status !== "active" ||
          definition.graph === undefined
        ) {
          continue;
        }
        for (const node of definition.graph.nodes) {
          const refs = [
            ...(node.executor.kind === "role"
              ? [
                  {
                    id: node.executor.id,
                    name: node.executor.label ?? node.executor.id,
                  },
                ]
              : []),
            ...node.approvers
              .filter((approver) => approver.kind === "role")
              .map((approver) => ({ id: approver.id, name: approver.name })),
          ];
          for (const ref of refs) {
            if (!removedIds.has(ref.id)) continue;
            const role = removedById.get(ref.id);
            blockedTemplates.push({
              templateId: definition.id,
              templateName: definition.name,
              nodeId: node.id,
              nodeName: node.name,
              roleId: ref.id,
              roleCode: role?.code ?? "",
              roleName: role?.name ?? ref.name,
            });
          }
        }
      }
      if (blockedTemplates.length > 0) {
        throw new ProjectError(
          "workflow_template_blocked",
          "有角色仍被项目已加载的工作流模版引用，不能下线；请先失效或编辑对应工作流模版",
          { templates: blockedTemplates },
        );
      }

      // 4) 成员影响：移除角色上的 active 指派。
      const agentDirectory = new Map(
        teammateDirectory(
          dependencies.teammates(),
          dependencies.employees(),
          body.workspaceId,
          {
            userId: current.userId,
            name:
              team.users().find((user) => user.id === current.userId)?.name ??
              current.userId,
            role: current.role,
          },
        ).map((teammate) => [teammate.id, teammate]),
      );
      const userById = new Map(team.users().map((user) => [user.id, user]));
      const impactsByMember = new Map<
        string,
        {
          memberKind: "human" | "agent";
          memberId: string;
          memberName: string;
          roles: Array<{ roleId: string; roleCode: string; roleName: string }>;
        }
      >();
      for (const assignment of activeSeats(assignments, body.workspaceId)) {
        const role = removedById.get(assignment.seatId);
        if (role === undefined) continue;
        const memberKind =
          assignment.assigneeKind === "user" ? "human" : "agent";
        const memberKey = `${memberKind}:${assignment.assigneeId}`;
        const memberName =
          memberKind === "human"
            ? (userById.get(assignment.assigneeId)?.name ??
              assignment.assigneeId)
            : (agentDirectory.get(assignment.assigneeId)?.name ??
              assignment.assigneeId);
        const impact = impactsByMember.get(memberKey) ?? {
          memberKind,
          memberId: assignment.assigneeId,
          memberName,
          roles: [],
        };
        impact.roles.push({
          roleId: role.id,
          roleCode: role.code,
          roleName: role.name,
        });
        impactsByMember.set(memberKey, impact);
      }
      const memberImpacts = [...impactsByMember.values()];
      if (memberImpacts.length > 0 && !body.ackMemberLoss) {
        throw new ProjectError(
          "member_impact",
          `确认删除后，${memberImpacts.length} 位成员在 ${removed.length} 个角色上的项目角色会被清空`,
          {
            impacts: memberImpacts,
            removedRoles: removed.map((role) => ({
              roleId: role.id,
              roleCode: role.code,
              roleName: role.name,
            })),
          },
        );
      }

      // 5) 席位同步 + 项目记录写入（失败回滚席位）。
      const actor = actorOf(current, team, body.workspaceId);
      let oldSeats: readonly SeatLike[] = [];
      if (assignments !== undefined) {
        try {
          oldSeats = assignments.config(body.workspaceId).seats;
        } catch {
          oldSeats = [];
        }
      }
      if (assignments !== undefined) {
        await materializeProjectSeats(
          service,
          assignments,
          actor,
          project,
          normalized.map(seatOfProjectRole),
          now,
        );
      }
      const timestamp = nowIso(now);
      let saved: ProjectRecord;
      try {
        saved = await service.upsertProject({
          workspaceId: body.workspaceId,
          projectRoles: normalized,
          rolesInitialized: true,
          rolesRevision: project.rolesRevision + 1,
          rolesUpdatedAt: timestamp,
          rolesUpdatedBy: current.userId,
        });
      } catch (cause) {
        if (assignments !== undefined) {
          try {
            await materializeProjectSeats(
              service,
              assignments,
              actor,
              project,
              oldSeats,
              now,
            );
          } catch {
            // rollback is best-effort; surface the original failure.
          }
        }
        throw cause;
      }

      // 6) 进行中任务标记需改派。受实例角色快照保护的工作流任务跳过。
      const removedRoleNames = new Map(
        removed.map((role) => [role.id, role.name]),
      );
      let tasksNeedingReassignment = 0;
      let warning: string | undefined;
      const taskService = dependencies.tasks();
      if (taskService?.markRoleUnavailable !== undefined) {
        const workflowService = dependencies.workflows();
        const skipTaskIds = new Set<string>();
        if (workflowService?.instance !== undefined) {
          for (const task of taskService.list(body.workspaceId)) {
            if (
              task.receiverType !== "role" ||
              task.receiverId === undefined ||
              !removedIds.has(task.receiverId)
            ) {
              continue;
            }
            const instanceId = task.workflow?.instanceId;
            if (instanceId === undefined) continue;
            const instance = workflowService.instance(instanceId);
            if (instance?.roleSnapshot?.[task.receiverId] !== undefined) {
              skipTaskIds.add(task.id);
            }
          }
        }
        try {
          tasksNeedingReassignment = await taskService.markRoleUnavailable(
            body.workspaceId,
            removedRoleNames,
            skipTaskIds,
          );
        } catch {
          warning = "角色已生效，但部分任务未能标记为需改派";
        }
      }
      await appendProjectAudit(current, body.workspaceId, {
        category: "role",
        action: "roles.confirm",
        targetId: body.workspaceId,
        targetName: workspace.title,
        summary: `确认项目角色清单 v${saved.rolesRevision}`,
        detail: {
          新增角色: added.map((role) => role.name).join("、") || "无",
          修改角色: updated.map((role) => role.name).join("、") || "无",
          移除角色: removed.map((role) => role.name).join("、") || "无",
          影响成员: String(memberImpacts.length),
          需改派任务: String(tasksNeedingReassignment),
          ...(warning === undefined ? {} : { 警告: warning }),
        },
      });

      sendJson(response, 200, {
        ok: true,
        project: saved,
        revision: saved.rolesRevision,
        diff: {
          added: added.map((role) => role.code),
          updated: updated.map((role) => role.code),
          removed: removed.map((role) => role.code),
        },
        memberImpacts,
        tasksNeedingReassignment,
        ...(warning === undefined ? {} : { warning }),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const outputs = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const workspaceId = query(request).get("workspaceId") ?? "";
      if (workspaceId === "") {
        throw new ProjectError("invalid_input", "workspaceId is required");
      }
      requireWorkspaceAccess(request, team, workspaceId);
      const workspace = workspaces.get(workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const items = await projectOutputs(
        workspaceId,
        dependencies.tasks()?.list(workspaceId) ?? [],
        dependencies.taskDocuments?.(),
        dependencies.workflows(),
      );
      sendJson(response, 200, {
        ok: true,
        workspaceId,
        generatedAt: nowIso(now),
        outputs: items,
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const membersSave = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(request, memberSaveSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      const resolved = resolveMemberIdentity(
        dependencies.principals?.(),
        body.memberKind,
        body.memberId,
      );
      const memberKind = resolved.memberKind;
      const memberId = resolved.memberId;
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const assignments = dependencies.assignments();
      if (assignments === undefined) {
        throw new ProjectError("invalid_input", "项目角色服务不可用");
      }
      const actor = actorOf(current, team, body.workspaceId);
      let project = await ensureProjectRecord(workspace);
      project = await ensureProjectRoleCopy(service, assignments, project);
      const seatIds = new Set(project.projectRoles.map((role) => role.id));
      for (const roleId of body.roleIds) {
        if (!seatIds.has(roleId)) {
          throw new ProjectError(
            "invalid_input",
            `项目角色不在该项目角色清单内：${roleId}`,
          );
        }
      }
      // 把项目自己的角色定义同步成席位；用户清空角色时也要同步一次以清理指派。
      let hasConfig = true;
      try {
        assignments.config(body.workspaceId);
      } catch {
        hasConfig = false;
      }
      if (project.projectRoles.length > 0 || hasConfig) {
        await syncProjectSeats(service, assignments, actor, project, now);
      }
      const roleNameById = new Map(
        project.projectRoles.map((role) => [role.id, role.name]),
      );
      const assigneeKind = memberKind === "human" ? "user" : "agent";
      const activeBefore = activeSeats(assignments, body.workspaceId).filter(
        (assignment) =>
          assignment.assigneeKind === assigneeKind &&
          assignment.assigneeId === memberId,
      );
      const beforeRoleIds = new Set(
        activeBefore.map((assignment) => assignment.seatId),
      );
      const wasMember =
        memberKind === "human"
          ? memberRoleOf(team, body.workspaceId, memberId) !== undefined
          : activeBefore.length > 0;
      const previousWorkspaceRole =
        memberKind === "human"
          ? memberRoleOf(team, body.workspaceId, memberId)
          : undefined;
      const requestedWorkspaceRole =
        memberKind === "human"
          ? (body.workspaceRole ?? previousWorkspaceRole ?? "member")
          : undefined;
      let targetName = memberId;
      if (memberKind === "human") {
        const user = team
          .users()
          .find((candidate) => candidate.id === memberId);
        if (user === undefined) {
          throw new ProjectError("not_found", "用户不存在");
        }
        targetName = user.name;
        if (
          previousWorkspaceRole === undefined ||
          previousWorkspaceRole !== requestedWorkspaceRole
        ) {
          // 只加入项目（工作区）成员资格，平台角色与账号状态不在这里改动。
          await team.addMember(
            current.userId,
            {
              workspaceId: body.workspaceId,
              userId: memberId,
              role: requestedWorkspaceRole ?? "member",
            },
            { allowWorkspaceOwner: true },
          );
        }
        await syncWorkspaceMembershipGrant({
          workspaceId: body.workspaceId,
          userId: memberId,
          role: requestedWorkspaceRole ?? "member",
          actorId: current.userId,
        });
      } else {
        const teammate = teammateDirectory(
          dependencies.teammates(),
          dependencies.employees(),
          body.workspaceId,
          {
            userId: current.userId,
            name:
              team.users().find((user) => user.id === current.userId)?.name ??
              current.userId,
            role: current.role,
          },
        ).find((candidate) => candidate.id === memberId);
        if (teammate !== undefined) targetName = teammate.name;
        const alreadyAssigned = activeSeats(assignments, body.workspaceId).some(
          (assignment) =>
            assignment.assigneeKind === "agent" &&
            assignment.assigneeId === memberId,
        );
        if (teammate === undefined && !alreadyAssigned) {
          throw new ProjectError(
            "invalid_input",
            "该 AI伙伴当前不可指派到本项目",
          );
        }
      }
      const desired = new Set(body.roleIds);
      for (const roleId of desired) {
        await assignments.assign(actor, {
          workspaceId: body.workspaceId,
          seatId: roleId,
          assigneeKind,
          assigneeId: memberId,
        });
      }
      for (const assignment of activeBefore) {
        if (desired.has(assignment.seatId)) continue;
        await assignments.release(actor, body.workspaceId, assignment.seatId, {
          assigneeKind,
          assigneeId: memberId,
        });
      }
      const afterRoleNames = body.roleIds
        .map((roleId) => roleNameById.get(roleId) ?? roleId)
        .join("、");
      const beforeRoleNames = [...beforeRoleIds]
        .map((roleId) => roleNameById.get(roleId) ?? roleId)
        .join("、");
      const rolesChanged = beforeRoleNames !== afterRoleNames;
      const workspaceRoleChanged =
        requestedWorkspaceRole !== undefined &&
        previousWorkspaceRole !== requestedWorkspaceRole;
      if (!wasMember || rolesChanged || workspaceRoleChanged) {
        await appendProjectAudit(current, body.workspaceId, {
          category: "member",
          action: wasMember ? "member.update" : "member.add",
          targetId: memberId,
          targetName,
          summary: wasMember
            ? `更新成员「${targetName}」的工作区角色或项目角色`
            : `添加项目成员「${targetName}」`,
          detail: {
            成员类型: memberKind === "human" ? "人类成员" : "AI伙伴",
            ...(resolved.principalId === undefined
              ? {}
              : { Principal: resolved.principalId }),
            ...(workspaceRoleChanged
              ? {
                  工作区角色: `${previousWorkspaceRole ?? "未加入"} → ${
                    requestedWorkspaceRole ?? "未加入"
                  }`,
                }
              : {}),
            项目角色:
              wasMember && beforeRoleNames !== ""
                ? `${beforeRoleNames || "未分配"} → ${afterRoleNames || "未分配"}`
                : afterRoleNames || "未分配",
          },
        });
      }
      sendJson(response, 200, { ok: true });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const membersRemove = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(request, memberRemoveSchema);
      const current = requireProjectManager(request, team, body.workspaceId);
      const resolved = resolveMemberIdentity(
        dependencies.principals?.(),
        body.memberKind,
        body.memberId,
      );
      const memberKind = resolved.memberKind;
      const memberId = resolved.memberId;
      const assignments = dependencies.assignments();
      const actor = actorOf(current, team, body.workspaceId);
      const assigneeKind = memberKind === "human" ? "user" : "agent";
      const project = service.project(body.workspaceId);
      const roleNameById = new Map(
        (project?.projectRoles ?? []).map((role) => [role.id, role.name]),
      );
      const active = activeSeats(assignments, body.workspaceId).filter(
        (assignment) =>
          assignment.assigneeKind === assigneeKind &&
          assignment.assigneeId === memberId,
      );
      for (const assignment of active) {
        await assignments?.release(actor, body.workspaceId, assignment.seatId, {
          assigneeKind,
          assigneeId: memberId,
        });
      }
      const targetName =
        memberKind === "human"
          ? (team.users().find((user) => user.id === memberId)?.name ??
            memberId)
          : (teammateDirectory(
              dependencies.teammates(),
              dependencies.employees(),
              body.workspaceId,
              {
                userId: current.userId,
                name: actorName(current.userId),
                role: current.role,
              },
            ).find((candidate) => candidate.id === memberId)?.name ?? memberId);
      if (memberKind === "human") {
        const previousWorkspaceRole = memberRoleOf(
          team,
          body.workspaceId,
          memberId,
        );
        await team.removeMember(
          current.userId,
          {
            workspaceId: body.workspaceId,
            userId: memberId,
          },
          { allowWorkspaceOwner: true },
        );
        if (previousWorkspaceRole !== undefined) {
          await revokeWorkspaceMembershipGrant({
            workspaceId: body.workspaceId,
            userId: memberId,
            role: previousWorkspaceRole,
          });
        }
      }
      await appendProjectAudit(current, body.workspaceId, {
        category: "member",
        action: "member.remove",
        targetId: memberId,
        targetName,
        summary: `移除项目成员「${targetName}」`,
        detail: {
          成员类型: memberKind === "human" ? "人类成员" : "AI伙伴",
          ...(resolved.principalId === undefined
            ? {}
            : { Principal: resolved.principalId }),
          原项目角色:
            active
              .map(
                (assignment) =>
                  roleNameById.get(assignment.seatId) ?? assignment.seatLabel,
              )
              .filter(Boolean)
              .join("、") || "未分配",
        },
      });
      sendJson(response, 200, { ok: true });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /** 当前用户主动退出项目（工作区）成员关系；不涉及平台账号。 */
  const leaveProject = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(
        request,
        z.object({ workspaceId: z.string().trim().min(1).max(160) }),
      );
      const current = principal(request, team);
      const leavingRole = memberRoleOf(team, body.workspaceId, current.userId);
      if (leavingRole === undefined) {
        throw new ProjectError("forbidden", "当前用户不是该项目成员");
      }
      if (team.leaveWorkspace === undefined) {
        throw new ProjectError("invalid_input", "协作身份服务不可用");
      }
      const project = service.project(body.workspaceId);
      const roleNameById = new Map(
        (project?.projectRoles ?? []).map((role) => [role.id, role.name]),
      );
      const assignments = dependencies.assignments();
      const held = activeSeats(assignments, body.workspaceId).filter(
        (assignment) =>
          assignment.assigneeKind === "user" &&
          assignment.assigneeId === current.userId,
      );
      for (const assignment of held) {
        await assignments?.release(
          actorOf(current, team, body.workspaceId),
          body.workspaceId,
          assignment.seatId,
          { assigneeKind: "user", assigneeId: current.userId },
        );
      }
      await team.leaveWorkspace(current.userId, body.workspaceId);
      await revokeWorkspaceMembershipGrant({
        workspaceId: body.workspaceId,
        userId: current.userId,
        role: leavingRole,
      });
      await appendProjectAudit(current, body.workspaceId, {
        category: "member",
        action: "member.leave",
        targetId: current.userId,
        targetName: actorName(current.userId),
        summary: `成员「${actorName(current.userId)}」退出项目`,
        detail: {
          工作区角色: leavingRole,
          原项目角色:
            held
              .map(
                (assignment) =>
                  roleNameById.get(assignment.seatId) ?? assignment.seatLabel,
              )
              .filter(Boolean)
              .join("、") || "未分配",
        },
      });
      sendJson(response, 200, { ok: true });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const reports = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    try {
      assertSameOrigin(request);
      const workspaceId = query(request).get("workspaceId") ?? "";
      requireWorkspaceAccess(request, team, workspaceId);
      sendJson(response, 200, {
        ok: true,
        reports: service.reports(workspaceId),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  const reportsGenerate = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      assertSameOrigin(request);
      const body = await readBodyAs(
        request,
        z.object({
          workspaceId: z.string().trim().min(1).max(160),
          date: z.string().trim().min(8).max(20).optional(),
        }),
      );
      const current = requireProjectManager(request, team, body.workspaceId);
      const workspace = workspaces.get(body.workspaceId);
      if (workspace === undefined) {
        throw new ProjectError("not_found", "项目不存在");
      }
      const date = body.date ?? today();
      const timestamp = nowIso(now);
      const project = await ensureProjectRecord(workspace);
      const report = await service.saveReport({
        workspaceId: body.workspaceId,
        date,
        generatedAt: `${date.slice(5)} ${timestamp.slice(11, 16)}`,
        generatedBy: "项目 AI",
        content: buildProjectReportContent({
          project,
          workspace,
          tasks: tasksOf(body.workspaceId),
          workflows: workflowsOf(body.workspaceId),
          today: date,
        }),
      });
      await appendProjectAudit(current, body.workspaceId, {
        category: "report",
        action: "report.generate",
        targetId: date,
        targetName: `${date} 项目日报`,
        summary: `生成 ${date} 项目日报`,
        detail: {
          日期: date,
          撰写人: report.generatedBy,
        },
      });
      sendJson(response, 200, { ok: true, report });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  /**
   * 审计访问暂不接项目自定义角色权限，沿用平台管理员 / 工作区负责人口径；
   * 后续由平台统一权限体系接管。
   */
  const history = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    try {
      assertSameOrigin(request);
      const workspaceId = query(request).get("workspaceId") ?? "";
      requireProjectManager(request, team, workspaceId);
      const rawLimit = Number(query(request).get("limit") ?? "200");
      const limit = Math.min(
        500,
        Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200),
      );
      sendJson(response, 200, {
        ok: true,
        events: mergeProjectAudit(workspaceId, limit),
      });
    } catch (cause) {
      routeError(response, cause);
    }
  };

  return [
    { kind: "exact", path: "/api/collab/projects", handler: list },
    { kind: "exact", path: "/api/collab/projects/detail", handler: detail },
    { kind: "exact", path: "/api/collab/projects/outputs", handler: outputs },
    { kind: "exact", path: "/api/collab/projects/create", handler: create },
    { kind: "exact", path: "/api/collab/projects/update", handler: update },
    {
      kind: "exact",
      path: "/api/collab/projects/templates",
      handler: templateList,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/templates/save",
      handler: templateSave,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/templates/remove",
      handler: templateRemove,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/templates/apply",
      handler: templateApply,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/roles/save",
      handler: roleSave,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/roles/remove",
      handler: roleRemove,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/role/save",
      handler: projectRoleSave,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/role/remove",
      handler: projectRoleRemove,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/role-sources",
      handler: roleSources,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/role/import",
      handler: roleImport,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/roles/confirm",
      handler: rolesConfirm,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/members/save",
      handler: membersSave,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/members/remove",
      handler: membersRemove,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/leave",
      handler: leaveProject,
    },
    { kind: "exact", path: "/api/collab/projects/reports", handler: reports },
    {
      kind: "exact",
      path: "/api/collab/projects/reports/generate",
      handler: reportsGenerate,
    },
    {
      kind: "exact",
      path: "/api/collab/projects/history",
      handler: history,
    },
  ];
}

/**
 * 为一个工作区补齐项目记录与编号（`PRJ` + 6 位数字）。
 * 已建档的工作区保持原编号不变。
 */
export async function provisionProject(
  service: ProjectService,
  team: TeamServiceLike,
  workspaces: WorkspaceRegistryLike,
  workspaceId: string,
): Promise<ProjectRecord | undefined> {
  const workspace = workspaces.get(workspaceId);
  if (workspace === undefined) return undefined;
  return service.ensureProject({
    workspaceId: workspace.id,
    ...ownerOfWorkspace(team, workspace.id),
  });
}

/**
 * 订阅宿主工作区变更流：baseline 补齐既有项目编号，upsert 时给新建项目立即分配
 * 编号。这样从左侧栏新建的项目在创建那一刻就有编号，不用等页面读取。
 */
export function followWorkspaceProjects(
  service: ProjectService,
  team: TeamServiceLike,
  workspaces: WorkspaceRegistryLike,
  controller: WorkspaceControllerLike,
): () => void {
  const abort = new AbortController();
  void (async () => {
    try {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame.type === "baseline") {
          for (const item of frame.value?.items ?? []) {
            const id = item.workspaceId ?? item.id;
            if (id !== undefined) {
              await provisionProject(service, team, workspaces, id);
            }
          }
          continue;
        }
        if (frame.type === "upsert") {
          const id = frame.workspace?.workspaceId ?? frame.workspace?.id;
          if (id !== undefined) {
            await provisionProject(service, team, workspaces, id);
          }
        }
      }
    } catch {
      // 变更流中断不影响读路径的兜底建档。
    }
  })();
  return () => abort.abort();
}

export async function apply(ctx: ProjectContext): Promise<void> {
  const domain = await ctx.storageDomain.open(projectDomainSpec);
  const service = new ProjectService({
    projects: domain.table("projects"),
    templates: domain.table("templates"),
    roles: domain.table("roles"),
    reports: domain.table("reports"),
    audit: domain.table("audit"),
  });
  await service.seedDefaults();
  ctx.provide("collabProjects", service);
  ctx.effect(() => () => void domain.close());
  ctx.inject(["collabTeam"], (child) => {
    const workspaces = child.get("workspaceRegistry") as
      | WorkspaceRegistryLike
      | undefined;
    if (workspaces === undefined) return;
    /** 启动时为已有工作区补齐项目记录与编号（幂等，已有编号不变）。 */
    void (async () => {
      for (const workspace of workspaces.list()) {
        await provisionProject(
          service,
          child.collabTeam,
          workspaces,
          workspace.id,
        );
      }
    })().catch(() => undefined);
    const disposers = createProjectRoutes(service, {
      team: child.collabTeam,
      workspaces,
      assignments: () =>
        child.get("collabAssignment") as AssignmentServiceLike | undefined,
      employees: () =>
        child.get("collabEmployee") as EmployeeServiceLike | undefined,
      teammates: () =>
        child.get("collabTeammateRuntime") as TeammateRuntimeLike | undefined,
      tasks: () => child.get("collabTasks") as TaskServiceLike | undefined,
      taskDocuments: () =>
        child.get("collabTaskDocuments") as
          | TaskDocumentQueryServiceLike
          | undefined,
      workflows: () =>
        child.get("collabWorkflow") as WorkflowServiceLike | undefined,
      principals: () =>
        child.get("collabPrincipal") as PrincipalServiceLike | undefined,
    }).map((route) => child.webServer.register(route) as () => void);
    child.effect(() => () => {
      for (const dispose of disposers) dispose();
    });
  });
  /*
   * 项目编号在「项目创建」时生效：等 workspaceController 就绪后订阅工作区变更流，
   * 新建 / 注册的项目在 upsert 的那一刻拿到编号，不用等页面读取。
   */
  ctx.inject(["collabTeam", "workspaceController"], (child) => {
    const workspaces = child.get("workspaceRegistry") as
      | WorkspaceRegistryLike
      | undefined;
    const controller =
      child.workspaceController ??
      (child.get("workspaceController") as WorkspaceControllerLike | undefined);
    if (workspaces === undefined || controller?.follow === undefined) return;
    const stop = followWorkspaceProjects(
      service,
      child.collabTeam,
      workspaces,
      controller,
    );
    child.effect(() => stop);
  });
}
