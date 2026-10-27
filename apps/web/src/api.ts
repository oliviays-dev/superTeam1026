import type {
  ActionTicketBundle,
  Agent,
  AgentDetail,
  AgentEpisode,
  AgentRuntimeBindingDetail,
  AgentRuntimePreflightInput,
  AgentRuntimePreflightResult,
  ApprovalSlaSweepResult,
  Artifact,
  AuthenticatedPrincipal,
  ConfirmHandoffCardInput,
  ContextPack,
  ContextReceipt,
  ConvertMeetingActionItemInput,
  CreateAgentInput,
  CreateExternalRuntimeInput,
  CreateHandoffCardInput,
  CreateMeetingActionItemInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateProjectMemberInput,
  CreateProjectRoleInput,
  CreateSupplyExceptionInput,
  CreateSupplierRiskInput,
  CreateTaskMessageInput,
  CompleteWorkflowNodeInput,
  DecideWorkflowApprovalInput,
  ExecutionGateRecord,
  ArchiveTaskAttachmentInput,
  CreateProjectInput,
  CreateProjectTemplateInput,
  CreateTaskInput,
  CreateTemplateRoleInput,
  CreateWorkflowTemplateInput,
  CreateWorkflowInput,
  CosignWorkflowApprovalInput,
  DirectChatDetail,
  DirectChatSendResult,
  DirectChatThread,
  DirectChatThreadListItem,
  DirectChatTurn,
  ExternalRuntime,
  ExternalRuntimeCapabilitySnapshot,
  ExternalRuntimeDetail,
  ExternalRuntimeEvent,
  ExternalRuntimeProbeRequestResult,
  ExecutionHistoryPage,
  ExecutionHistoryQuery,
  ImportWorkflowMarkdownInput,
  IdempotencyCleanupInput,
  IdempotencyCleanupResult,
  Job,
  LoginInput,
  LoginResult,
  HandoffCard,
  Meeting,
  MeetingActionItem,
  MeetingActionItemConversion,
  MeetingAiPolicy,
  MeetingAiPolicyLifecycleInput,
  MeetingDetail,
  MeetingMessage,
  MeetingMinutes,
  MeetingMinutesDraft,
  MeetingMinutesVersion,
  MeetingTraceability,
  MemoryClaim,
  MemoryClaimTrace,
  MemoryReviewQueue,
  MemoryReviewResult,
  MemoryTopic,
  PlatformRunEvent,
  Project,
  ProjectCapability,
  ProjectMember,
  ProjectRole,
  ProjectTemplate,
  ProjectTemplateRevisionSummary,
  SceneContextReplayResult,
  SceneContextSnapshot,
  ProjectReportDetail,
  ProjectReportGenerationResult,
  ProjectReportSummary,
  PublishMemoryTruthInput,
  ReadinessResponse,
  ReviewMemoryClaimsInput,
  RetryWorkflowNodeInput,
  Run,
  RunDelta,
  RunDetail,
  RunExecutionEconomics,
  RuntimeAccessProjection,
  OperationsSnapshot,
  Task,
  TaskDetail,
  TaskDocumentDiscovery,
  TaskMessage,
  TaskQueueItem,
  RevealTaskDocumentResult,
  TransferWorkflowApprovalInput,
  TriggerMeetingAiInput,
  TriggerMeetingAiResult,
  UploadTaskAttachmentInput,
  UpdateAgentInput,
  UpdateExternalRuntimeInput,
  UpdateHandoffCardInput,
  UpdateMeetingAiPolicyInput,
  UpdateMemoryClaimInput,
  UpdateProjectMemberInput,
  UpdateProjectInput,
  UpdateProjectRoleInput,
  UpdateProjectTemplateInput,
  UpdateTemplateRoleInput,
  UpdateWorkflowTemplateInput,
  UpdateTaskInput,
  UpdateWorkbenchBriefSettingsInput,
  ValidateWorkflowMarkdownInput,
  WorkbenchSummary,
  WorkbenchBriefGenerationResult,
  WorkbenchBriefSettings,
  WorkbenchDashboard,
  WorkbenchFollow,
  WorkflowDefinition,
  WorkflowTemplate,
  TemplateRole,
  CopyProjectTemplateInput,
  ArchiveProjectTemplateInput,
  ViewerCapabilities,
  WorkflowAuditPage,
  WorkflowAuditKind,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowReasonInput,
  WorkflowValidationResult,
  WorkspaceRuntimeCatalogItem,
  WorkspaceRuntimeEconomics,
  WorkspaceRuntimeEconomicsQuery,
  ChangeTeammateStatusInput,
  CreateTeammateInput,
  CreateTeammateTemplateInput,
  CreateTeammateWorkPlanInput,
  ParsedTeammateWorkPlan,
  Teammate,
  TeammateDefinition,
  TeammateExecutionHistoryQuery,
  TeammateQueueItem,
  TeammateRuntimeStatistics,
  TeammateTemplate,
  TeammateTemplateVersion,
  TeammateTransfer,
  TeammateEvent,
  TeammateWeeklyReport,
  TransferTeammateInput,
} from "@pluginmax/contracts";

const API_BASE = "/api/v1";
const AUTH_TOKEN_KEY = "pluginmax.auth.token";

interface ListResponse<T> {
  readonly items: T[];
}

export interface MemoryListResponse {
  readonly items: MemoryTopic[];
  readonly canManage: boolean;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function authToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage.getItem(AUTH_TOKEN_KEY) ?? undefined;
}

export function storeAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

interface EventPage {
  readonly runId: string;
  readonly runStatus: Run["status"];
  readonly items: PlatformRunEvent[];
  readonly deltas: RunDelta[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = authToken();
  if (token !== undefined && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
      details?: unknown;
    } | null;
    if (response.status === 401 && path !== "/auth/login") {
      clearAuthToken();
    }
    throw new ApiRequestError(
      body?.message ?? `Request failed: ${response.status}`,
      body?.code ?? "request_failed",
      response.status,
      body?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const result = await request<LoginResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  storeAuthToken(result.token);
  return result;
}

export async function logout(): Promise<void> {
  try {
    await request<void>("/auth/logout", { method: "POST" });
  } finally {
    clearAuthToken();
  }
}

export async function currentPrincipal(): Promise<AuthenticatedPrincipal> {
  return request<AuthenticatedPrincipal>("/auth/me");
}

export async function listProjects(): Promise<Project[]> {
  return (await request<ListResponse<Project>>("/projects")).items;
}

export function getProjectCapability(
  projectId: string,
): Promise<ProjectCapability> {
  return request(`/projects/${projectId}/capability`);
}

export function createProject(
  input: CreateProjectInput,
  idempotencyKey?: string,
): Promise<Project> {
  return request("/projects", {
    method: "POST",
    ...(idempotencyKey === undefined
      ? {}
      : { headers: { "idempotency-key": idempotencyKey } }),
    body: JSON.stringify(input),
  });
}

export function getViewerCapabilities(): Promise<ViewerCapabilities> {
  return request("/viewer");
}

export async function listProjectTemplates(
  includeArchived = false,
): Promise<ProjectTemplate[]> {
  return (
    await request<{ items: ProjectTemplate[] }>(
      `/project-templates${includeArchived ? "?includeArchived=1" : ""}`,
    )
  ).items;
}

export function createProjectTemplate(
  input: CreateProjectTemplateInput,
): Promise<ProjectTemplate> {
  return request("/project-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProjectTemplate(
  templateId: string,
  input: UpdateProjectTemplateInput,
): Promise<ProjectTemplate> {
  return request(`/project-templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function copyProjectTemplate(
  templateId: string,
  input: CopyProjectTemplateInput,
): Promise<ProjectTemplate> {
  return request(`/project-templates/${templateId}/copy`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function archiveProjectTemplate(
  templateId: string,
  input: ArchiveProjectTemplateInput,
): Promise<ProjectTemplate> {
  return request(`/project-templates/${templateId}/archive`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listProjectTemplateHistory(
  templateId: string,
): Promise<ProjectTemplateRevisionSummary[]> {
  return (
    await request<{ items: ProjectTemplateRevisionSummary[] }>(
      `/project-templates/${templateId}/history`,
    )
  ).items;
}

export async function listTemplateRoles(
  includeArchived = false,
): Promise<TemplateRole[]> {
  return (
    await request<{ items: TemplateRole[] }>(
      `/template-roles${includeArchived ? "?includeArchived=1" : ""}`,
    )
  ).items;
}

export function createTemplateRole(
  input: CreateTemplateRoleInput,
): Promise<TemplateRole> {
  return request("/template-roles", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTemplateRole(
  roleId: string,
  input: UpdateTemplateRoleInput,
): Promise<TemplateRole> {
  return request(`/template-roles/${roleId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteTemplateRole(roleId: string): Promise<void> {
  await request<void>(`/template-roles/${roleId}`, { method: "DELETE" });
}

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  return (await request<{ items: WorkflowTemplate[] }>("/workflow-templates"))
    .items;
}

export function createWorkflowTemplate(
  input: CreateWorkflowTemplateInput,
): Promise<WorkflowTemplate> {
  return request("/workflow-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateWorkflowTemplate(
  workflowTemplateId: string,
  input: UpdateWorkflowTemplateInput,
): Promise<WorkflowTemplate> {
  return request(`/workflow-templates/${workflowTemplateId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  return request(`/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function listProjectMembers(
  projectId: string,
): Promise<ProjectMember[]> {
  return (
    await request<ListResponse<ProjectMember>>(`/projects/${projectId}/members`)
  ).items;
}

export function createProjectMember(
  projectId: string,
  input: CreateProjectMemberInput,
): Promise<ProjectMember> {
  return request(`/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProjectMember(
  projectId: string,
  memberId: string,
  input: UpdateProjectMemberInput,
): Promise<ProjectMember> {
  return request(`/projects/${projectId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteProjectMember(
  projectId: string,
  memberId: string,
): Promise<void> {
  await request<void>(`/projects/${projectId}/members/${memberId}`, {
    method: "DELETE",
  });
}

export async function listProjectRoles(
  projectId: string,
): Promise<ProjectRole[]> {
  return (
    await request<ListResponse<ProjectRole>>(`/projects/${projectId}/roles`)
  ).items;
}

export function createProjectRole(
  projectId: string,
  input: CreateProjectRoleInput,
): Promise<ProjectRole> {
  return request(`/projects/${projectId}/roles`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateProjectRole(
  projectId: string,
  roleId: string,
  input: UpdateProjectRoleInput,
): Promise<ProjectRole> {
  return request(`/projects/${projectId}/roles/${roleId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteProjectRole(
  projectId: string,
  roleId: string,
): Promise<void> {
  await request<void>(`/projects/${projectId}/roles/${roleId}`, {
    method: "DELETE",
  });
}

export async function listAgents(): Promise<Agent[]> {
  return (await request<ListResponse<Agent>>("/agents")).items;
}

export async function listAllAgents(): Promise<Agent[]> {
  return (await request<ListResponse<Agent>>("/agents?includeDisabled=1"))
    .items;
}

export function getAgent(id: string): Promise<AgentDetail> {
  return request(`/agents/${id}`);
}

export function createAgent(input: CreateAgentInput): Promise<Agent> {
  return request("/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAgent(
  id: string,
  input: UpdateAgentInput,
): Promise<AgentDetail> {
  return request(`/agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setAgentStatus(
  id: string,
  status: Agent["status"],
): Promise<AgentDetail> {
  return request(`/agents/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function getAgentRuntimeBinding(
  agentId: string,
): Promise<AgentRuntimeBindingDetail> {
  return request(`/agents/${agentId}/runtime-binding`);
}

export function setAgentRuntimeBinding(
  agentId: string,
  input: { readonly runtimeId: string; readonly expectedRevision: number },
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentRuntimeBindingDetail> {
  return request(`/agents/${agentId}/runtime-binding`, {
    method: "PUT",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function removeAgentRuntimeBinding(
  agentId: string,
  expectedRevision: number,
  idempotencyKey = crypto.randomUUID(),
): Promise<AgentRuntimeBindingDetail> {
  return request(`/agents/${agentId}/runtime-binding`, {
    method: "DELETE",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ expectedRevision }),
  });
}

export function preflightAgentRuntime(
  agentId: string,
  input: AgentRuntimePreflightInput,
): Promise<AgentRuntimePreflightResult> {
  return request(`/agents/${agentId}/runtime-preflight`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listExternalRuntimes(
  includeArchived = false,
): Promise<ExternalRuntime[]> {
  return (
    await request<{ items: ExternalRuntime[] }>(
      `/runtimes${includeArchived ? "?includeArchived=1" : ""}`,
    )
  ).items;
}

export function createExternalRuntime(
  input: CreateExternalRuntimeInput,
): Promise<ExternalRuntime> {
  return request("/runtimes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getExternalRuntime(
  runtimeId: string,
): Promise<ExternalRuntimeDetail> {
  return request(`/runtimes/${runtimeId}`);
}

export function updateExternalRuntime(
  runtimeId: string,
  input: UpdateExternalRuntimeInput,
): Promise<ExternalRuntime> {
  return request(`/runtimes/${runtimeId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function probeExternalRuntime(
  runtimeId: string,
  expectedRevision: number,
): Promise<ExternalRuntimeProbeRequestResult> {
  return request(`/runtimes/${runtimeId}/probe`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export function transitionExternalRuntime(
  runtimeId: string,
  transition: "enable" | "disable" | "archive" | "restore",
  expectedRevision: number,
): Promise<ExternalRuntime> {
  return request(`/runtimes/${runtimeId}/${transition}`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function listExternalRuntimeEvents(
  runtimeId: string,
): Promise<ExternalRuntimeEvent[]> {
  return (
    await request<{ items: ExternalRuntimeEvent[] }>(
      `/runtimes/${runtimeId}/events`,
    )
  ).items;
}

export async function listExternalRuntimeCapabilities(
  runtimeId: string,
): Promise<ExternalRuntimeCapabilitySnapshot[]> {
  return (
    await request<{ items: ExternalRuntimeCapabilitySnapshot[] }>(
      `/runtimes/${runtimeId}/capabilities`,
    )
  ).items;
}

export async function listTasks(projectId?: string): Promise<Task[]> {
  const query =
    projectId === undefined
      ? ""
      : `?projectId=${encodeURIComponent(projectId)}`;
  return (await request<ListResponse<Task>>(`/tasks${query}`)).items;
}

export async function listTaskQueue(
  projectId: string,
): Promise<TaskQueueItem[]> {
  return (
    await request<{ items: TaskQueueItem[] }>(
      `/projects/${projectId}/task-queue`,
    )
  ).items;
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  return request("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTask(
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskDetail> {
  return request(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function getTaskDetail(taskId: string): Promise<TaskDetail> {
  return request(`/tasks/${taskId}/detail`);
}

export function postTaskMessage(
  taskId: string,
  input: CreateTaskMessageInput,
): Promise<TaskMessage> {
  return request(`/tasks/${taskId}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function uploadTaskAttachment(
  taskId: string,
  input: UploadTaskAttachmentInput,
) {
  return request<NonNullable<TaskDetail["attachments"][number]>>(
    `/tasks/${taskId}/attachments`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function listWorkspaceRuntimeCatalog(
  workspaceId: string,
  includeArchived = false,
): Promise<WorkspaceRuntimeCatalogItem[]> {
  return (
    await request<{ items: WorkspaceRuntimeCatalogItem[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/runtimes?includeArchived=${
        includeArchived ? "1" : "0"
      }`,
    )
  ).items;
}

export function getRuntimeAccess(
  runtimeId: string,
): Promise<RuntimeAccessProjection> {
  return request(`/runtimes/${runtimeId}/access`);
}

function economicsQuery(query: WorkspaceRuntimeEconomicsQuery): string {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  if (query.runtimeId !== undefined) params.set("runtimeId", query.runtimeId);
  const value = params.toString();
  return value === "" ? "" : `?${value}`;
}

export function getWorkspaceRuntimeEconomics(
  workspaceId: string,
  query: WorkspaceRuntimeEconomicsQuery = {},
): Promise<WorkspaceRuntimeEconomics> {
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/runtime-economics${economicsQuery(
      query,
    )}`,
  );
}

export function listExecutionHistory(
  workspaceId: string,
  query: ExecutionHistoryQuery,
): Promise<ExecutionHistoryPage> {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.runtimeId !== undefined) params.set("runtimeId", query.runtimeId);
  if (query.contextType !== undefined) {
    params.set("contextType", query.contextType);
  }
  if (query.status !== undefined) params.set("status", query.status);
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/execution-history?${params.toString()}`,
  );
}

export function getRunEconomics(runId: string): Promise<RunExecutionEconomics> {
  return request(`/runs/${runId}/economics`);
}

export async function listTeammateTemplates(
  projectId: string,
  includeArchived = false,
): Promise<TeammateTemplate[]> {
  const params = new URLSearchParams({ projectId });
  if (includeArchived) params.set("includeArchived", "1");
  return (
    await request<{ items: TeammateTemplate[] }>(
      `/teammate-templates?${params.toString()}`,
    )
  ).items;
}

export function createTeammateTemplate(
  input: CreateTeammateTemplateInput,
): Promise<TeammateTemplate> {
  return request("/teammate-templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateTeammateTemplate(
  templateId: string,
  input: {
    readonly expectedVersion: number;
    readonly definition: TeammateDefinition;
  },
): Promise<TeammateTemplate> {
  return request(`/teammate-templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function archiveTeammateTemplate(
  templateId: string,
  expectedVersion: number,
): Promise<TeammateTemplate> {
  return request(`/teammate-templates/${templateId}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion }),
  });
}

export function getTeammateTemplate(templateId: string): Promise<{
  readonly template: TeammateTemplate;
  readonly versions: TeammateTemplateVersion[];
}> {
  return request(`/teammate-templates/${templateId}`);
}

export async function listTeammates(
  projectId: string,
  includeArchived = false,
): Promise<Teammate[]> {
  const params = new URLSearchParams({ projectId });
  if (includeArchived) params.set("includeArchived", "1");
  return (
    await request<{ items: Teammate[] }>(`/teammates?${params.toString()}`)
  ).items;
}

export function createTeammate(input: CreateTeammateInput): Promise<Teammate> {
  return request("/teammates", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTeammate(teammateId: string): Promise<{
  readonly teammate: Teammate;
  readonly template: TeammateTemplate;
  readonly templateVersion: TeammateTemplateVersion;
  readonly transfers: TeammateTransfer[];
  readonly events: TeammateEvent[];
  readonly weeklyReports: TeammateWeeklyReport[];
}> {
  return request(`/teammates/${teammateId}`);
}

export function changeTeammateStatus(
  teammateId: string,
  input: ChangeTeammateStatusInput,
): Promise<Teammate> {
  return request(`/teammates/${teammateId}/status`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function setTeammateAutoExecute(
  teammateId: string,
  autoExecute: boolean,
  expectedVersion: number,
): Promise<Teammate> {
  return request(`/teammates/${teammateId}/auto-execute`, {
    method: "POST",
    body: JSON.stringify({ autoExecute, expectedVersion }),
  });
}

export function transferTeammate(
  teammateId: string,
  input: TransferTeammateInput,
): Promise<Teammate> {
  return request(`/teammates/${teammateId}/transfer`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listTeammateWorkQueue(
  teammateId: string,
): Promise<TeammateQueueItem[]> {
  return (
    await request<{ items: TeammateQueueItem[] }>(
      `/teammates/${teammateId}/work-queue`,
    )
  ).items;
}

export async function reorderTeammateWorkQueue(
  teammateId: string,
  taskIds: string[],
): Promise<TeammateQueueItem[]> {
  return (
    await request<{ items: TeammateQueueItem[] }>(
      `/teammates/${teammateId}/work-queue/reorder`,
      {
        method: "POST",
        body: JSON.stringify({ taskIds }),
      },
    )
  ).items;
}

export function parseTeammateWorkPlan(
  teammateId: string,
  instruction: string,
): Promise<ParsedTeammateWorkPlan> {
  return request(`/teammates/${teammateId}/work-plans/parse`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
}

export function createTeammateWorkPlan(
  teammateId: string,
  input: CreateTeammateWorkPlanInput,
): Promise<{
  readonly planId: string;
  readonly taskIds: string[];
  readonly queue: TeammateQueueItem[];
}> {
  return request(`/teammates/${teammateId}/work-plans`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTeammateEconomics(
  teammateId: string,
  query: { readonly from?: string; readonly to?: string } = {},
): Promise<TeammateRuntimeStatistics> {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  const suffix = params.toString();
  return request(
    `/teammates/${teammateId}/economics${suffix === "" ? "" : `?${suffix}`}`,
  );
}

export function getTeammateExecutionHistory(
  teammateId: string,
  query: TeammateExecutionHistoryQuery = { limit: 25 },
): Promise<ExecutionHistoryPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return request(
    `/teammates/${teammateId}/execution-history${
      suffix === "" ? "" : `?${suffix}`
    }`,
  );
}

export async function listTeammateWeeklyReports(
  teammateId: string,
): Promise<TeammateWeeklyReport[]> {
  return (
    await request<{ items: TeammateWeeklyReport[] }>(
      `/teammates/${teammateId}/weekly-reports`,
    )
  ).items;
}

export function generateTeammateWeeklyReport(
  teammateId: string,
  weekStart?: string,
): Promise<TeammateWeeklyReport> {
  return request(`/teammates/${teammateId}/weekly-reports/generate`, {
    method: "POST",
    body: JSON.stringify(weekStart === undefined ? {} : { weekStart }),
  });
}

export function archiveTaskAttachment(
  attachmentId: string,
  input: ArchiveTaskAttachmentInput,
) {
  return request<NonNullable<TaskDetail["attachments"][number]>>(
    `/attachments/${attachmentId}/archive`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function downloadTaskAttachment(
  attachmentId: string,
): Promise<Blob> {
  return requestBlob(`/attachments/${attachmentId}/download`);
}

export function dispatchTask(
  taskId: string,
): Promise<{ readonly runId: string }> {
  return request(`/tasks/${taskId}/dispatch`, { method: "POST" });
}

export function pauseTask(
  taskId: string,
  reason: string,
  expectedRevision?: number,
): Promise<Task> {
  return request(`/tasks/${taskId}/pause`, {
    method: "POST",
    body: JSON.stringify({
      reason,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function blockTask(
  taskId: string,
  reason: string,
  expectedRevision?: number,
): Promise<Task> {
  return request(`/tasks/${taskId}/block`, {
    method: "POST",
    body: JSON.stringify({
      reason,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function requestTaskInput(
  taskId: string,
  prompt: string,
  expectedRevision?: number,
): Promise<TaskDetail> {
  return request(`/tasks/${taskId}/request-input`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function provideTaskInput(
  taskId: string,
  content: string,
  expectedRevision?: number,
): Promise<TaskDetail> {
  return request(`/tasks/${taskId}/input`, {
    method: "POST",
    body: JSON.stringify({
      content,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function resumeTask(
  taskId: string,
  note: string,
  expectedRevision?: number,
): Promise<Task> {
  return request(`/tasks/${taskId}/resume`, {
    method: "POST",
    body: JSON.stringify({
      note,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function submitTask(
  taskId: string,
  note: string,
  expectedRevision?: number,
): Promise<Task> {
  return request(`/tasks/${taskId}/submit`, {
    method: "POST",
    body: JSON.stringify({
      note,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  });
}

export function resetTaskSession(
  taskId: string,
  reason: string,
): Promise<{ readonly session: { readonly generation: number } }> {
  return request(`/tasks/${taskId}/session-reset`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function listTaskDocuments(
  taskId: string,
  includeArchived = false,
): Promise<TaskDocumentDiscovery> {
  return request(
    `/tasks/${taskId}/documents${includeArchived ? "?includeArchived=1" : ""}`,
  );
}

export function revealTaskDocument(
  taskId: string,
  attachmentId: string,
): Promise<RevealTaskDocumentResult> {
  return request(`/tasks/${taskId}/documents/${attachmentId}/reveal`, {
    method: "POST",
  });
}

export function reviewTask(
  taskId: string,
  decision: "approve" | "return",
  note: string,
): Promise<Task> {
  return request(`/tasks/${taskId}/review`, {
    method: "POST",
    body: JSON.stringify({ decision, note }),
  });
}

export async function listTaskRuns(taskId: string): Promise<Run[]> {
  return (await request<ListResponse<Run>>(`/tasks/${taskId}/runs`)).items;
}

export function getRunDetail(runId: string): Promise<RunDetail> {
  return request(`/runs/${runId}`);
}

export function getRunActionTicket(runId: string): Promise<ActionTicketBundle> {
  return request(`/runs/${runId}/action-ticket`);
}

export function decideExecutionGate(
  gateId: string,
  decision: "approve" | "reject",
  basis: string,
): Promise<ExecutionGateRecord> {
  return request(`/execution-gates/${gateId}/decisions`, {
    method: "POST",
    body: JSON.stringify({ decision, basis }),
  });
}

export function cancelExecutionGate(
  gateId: string,
  reason: string,
): Promise<ExecutionGateRecord> {
  return request(`/execution-gates/${gateId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function getRunContext(
  runId: string,
): Promise<{ pack: ContextPack; receipt: ContextReceipt }> {
  return request(`/runs/${runId}/context`);
}

export function getRunSceneContext(runId: string): Promise<{
  scene: SceneContextSnapshot;
  pack: ContextPack;
}> {
  return request(`/runs/${runId}/scene-context`);
}

export function replayRunSceneContext(
  runId: string,
): Promise<SceneContextReplayResult> {
  return request(`/runs/${runId}/scene-context/replay`);
}

export function getRunEvents(
  runId: string,
  afterSeq = 0,
  afterDeltaSeq = 0,
): Promise<EventPage> {
  return request(
    `/runs/${runId}/events?afterSeq=${afterSeq}&afterDeltaSeq=${afterDeltaSeq}`,
  );
}

export function cancelRun(runId: string): Promise<{ ok: true }> {
  return request(`/runs/${runId}/cancel`, { method: "POST" });
}

export async function listArtifacts(runId: string): Promise<Artifact[]> {
  return (await request<ListResponse<Artifact>>(`/runs/${runId}/artifacts`))
    .items;
}

export async function downloadArtifact(artifactId: string): Promise<Blob> {
  return requestBlob(`/artifacts/${artifactId}/download`);
}

export function listMemory(projectId: string): Promise<MemoryListResponse> {
  return request<MemoryListResponse>(`/projects/${projectId}/memory`);
}

export function createMemoryTopic(
  projectId: string,
  input: CreateMemoryTopicInput,
): Promise<MemoryTopic> {
  return request(`/projects/${projectId}/memory/topics`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function addMemoryClaim(
  projectId: string,
  topicId: string,
  input: CreateMemoryClaimInput,
): Promise<MemoryClaim> {
  return request(`/projects/${projectId}/memory/topics/${topicId}/claims`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMemoryClaim(
  projectId: string,
  topicId: string,
  claimId: string,
  input: UpdateMemoryClaimInput,
): Promise<MemoryClaim> {
  return request(
    `/projects/${projectId}/memory/topics/${topicId}/claims/${claimId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export function publishMemoryTruth(
  projectId: string,
  topicId: string,
  input: PublishMemoryTruthInput,
): Promise<MemoryTopic> {
  return request(`/projects/${projectId}/memory/topics/${topicId}/truths`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listMemoryReviews(
  projectId: string,
): Promise<MemoryReviewQueue> {
  return request(`/projects/${projectId}/memory/reviews`);
}

export function reviewMemoryClaims(
  projectId: string,
  input: ReviewMemoryClaimsInput,
): Promise<MemoryReviewResult> {
  return request(`/projects/${projectId}/memory/reviews`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getMemoryClaimTrace(
  projectId: string,
  claimId: string,
): Promise<MemoryClaimTrace> {
  return request(`/projects/${projectId}/memory/claims/${claimId}`);
}

export async function listHandoffs(projectId: string): Promise<HandoffCard[]> {
  return (
    await request<ListResponse<HandoffCard>>(`/projects/${projectId}/handoffs`)
  ).items;
}

export function createHandoff(
  projectId: string,
  input: CreateHandoffCardInput,
): Promise<HandoffCard> {
  return request(`/projects/${projectId}/handoffs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateHandoff(
  projectId: string,
  handoffId: string,
  input: UpdateHandoffCardInput,
): Promise<HandoffCard> {
  return request(`/projects/${projectId}/handoffs/${handoffId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function confirmHandoff(
  projectId: string,
  handoffId: string,
  input: ConfirmHandoffCardInput,
): Promise<HandoffCard> {
  return request(`/projects/${projectId}/handoffs/${handoffId}/confirm`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAgentEpisodes(
  projectId: string,
  agentId: string,
): Promise<AgentEpisode[]> {
  return (
    await request<ListResponse<AgentEpisode>>(
      `/projects/${projectId}/agent-episodes?agentId=${encodeURIComponent(agentId)}`,
    )
  ).items;
}

export function getWorkbench(): Promise<WorkbenchSummary> {
  return request("/workbench");
}

export function getWorkbenchDashboard(): Promise<WorkbenchDashboard> {
  return request("/workbench/dashboard");
}

export function refreshWorkbenchBrief(
  briefDate?: string,
): Promise<WorkbenchBriefGenerationResult> {
  return request("/workbench/brief/refresh", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(briefDate === undefined ? {} : { briefDate }),
  });
}

export function markWorkbenchBriefRead(
  briefId: string,
  read: boolean,
): Promise<{ briefId: string; read: boolean }> {
  return request(`/workbench/brief/${briefId}/read`, {
    method: "POST",
    body: JSON.stringify({ read }),
  });
}

export function getWorkbenchBriefSettings(): Promise<WorkbenchBriefSettings> {
  return request("/workbench/brief/settings");
}

export function updateWorkbenchBriefSettings(
  input: UpdateWorkbenchBriefSettingsInput,
): Promise<WorkbenchBriefSettings> {
  return request("/workbench/brief/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function listWorkbenchFollows(): Promise<WorkbenchFollow[]> {
  return (await request<{ items: WorkbenchFollow[] }>("/workbench/follows"))
    .items;
}

export function setWorkbenchFollow(input: {
  readonly targetType: WorkbenchFollow["targetType"];
  readonly targetId: string;
  readonly projectId: string;
  readonly followed: boolean;
}): Promise<{ followed: boolean }> {
  return request("/workbench/follows", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export async function listProjectReports(
  projectId: string,
  query: { from?: string; to?: string; query?: string } = {},
): Promise<ProjectReportSummary[]> {
  const params = new URLSearchParams();
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  if (query.query !== undefined && query.query.trim() !== "") {
    params.set("query", query.query.trim());
  }
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return (
    await request<{ items: ProjectReportSummary[] }>(
      `/projects/${projectId}/reports${suffix}`,
    )
  ).items;
}

export function generateProjectReport(
  projectId: string,
  reportDate?: string,
): Promise<ProjectReportGenerationResult> {
  return request(`/projects/${projectId}/reports/generate`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(reportDate === undefined ? {} : { reportDate }),
  });
}

export function getProjectReport(
  projectId: string,
  reportId: string,
): Promise<ProjectReportDetail> {
  return request(`/projects/${projectId}/reports/${reportId}`);
}

export function markProjectReportRead(
  projectId: string,
  reportId: string,
  read: boolean,
): Promise<{ reportId: string; read: boolean }> {
  return request(`/projects/${projectId}/reports/${reportId}/read`, {
    method: "POST",
    body: JSON.stringify({ read }),
  });
}

export function createSupplyException(
  input: CreateSupplyExceptionInput,
): Promise<unknown> {
  return request("/workbench/supply-exceptions", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function createSupplierRisk(
  input: CreateSupplierRiskInput,
): Promise<unknown> {
  return request("/workbench/supplier-risks", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function getOperationsSnapshot(): Promise<OperationsSnapshot> {
  return request("/operations");
}

export function getReadiness(): Promise<ReadinessResponse> {
  return request("/ready");
}

export async function listJobs(status?: Job["status"]): Promise<Job[]> {
  const query = status === undefined ? "" : `?status=${status}`;
  return (await request<ListResponse<Job>>(`/jobs${query}`)).items;
}

export function recoverDeadLetterJob(
  jobId: string,
  reason: string,
): Promise<Job> {
  return request(`/jobs/${jobId}/recover`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    headers: { "idempotency-key": crypto.randomUUID() },
  });
}

export function cleanupIdempotencyReceipts(
  input: IdempotencyCleanupInput,
): Promise<IdempotencyCleanupResult> {
  return request("/operations/idempotency/cleanup", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "idempotency-key": crypto.randomUUID() },
  });
}

export function sweepApprovalSla(
  batchSize = 100,
): Promise<ApprovalSlaSweepResult> {
  return request("/operations/approval-sla/sweep", {
    method: "POST",
    body: JSON.stringify({ batchSize }),
    headers: { "idempotency-key": crypto.randomUUID() },
  });
}

export async function listWorkflows(
  projectId: string,
): Promise<WorkflowDefinition[]> {
  return (
    await request<ListResponse<WorkflowDefinition>>(
      `/workflows?projectId=${encodeURIComponent(projectId)}`,
    )
  ).items;
}

export function validateWorkflowMarkdown(
  input: ValidateWorkflowMarkdownInput,
): Promise<WorkflowValidationResult> {
  return request("/workflows/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function importWorkflowMarkdown(
  input: ImportWorkflowMarkdownInput,
): Promise<WorkflowDefinition> {
  return request("/workflows/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createWorkflow(
  input: CreateWorkflowInput,
): Promise<WorkflowDefinition> {
  return request("/workflows", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function startWorkflow(
  workflowId: string,
  title: string,
  context: Record<string, string | number | boolean | null> = {},
): Promise<WorkflowInstance> {
  return request(`/workflows/${workflowId}/start`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ title, context }),
  });
}

export async function listWorkflowInstances(
  projectId: string,
): Promise<WorkflowInstance[]> {
  return (
    await request<ListResponse<WorkflowInstance>>(
      `/workflow-instances?projectId=${encodeURIComponent(projectId)}`,
    )
  ).items;
}

export function getWorkflowInstanceDetail(
  instanceId: string,
): Promise<WorkflowInstanceDetail> {
  return request(`/workflow-instances/${instanceId}/detail`);
}

export function completeWorkflowNode(
  instanceId: string,
  input: CompleteWorkflowNodeInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/nodes/complete`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function decideWorkflowApproval(
  instanceId: string,
  input: DecideWorkflowApprovalInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/approvals`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function transferWorkflowApproval(
  instanceId: string,
  input: TransferWorkflowApprovalInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/approvals/transfer`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function cosignWorkflowApproval(
  instanceId: string,
  input: CosignWorkflowApprovalInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/approvals/cosign`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function listWorkflowAudit(input: {
  readonly projectId: string;
  readonly instanceId?: string;
  readonly nodeId?: string;
  readonly kind?: WorkflowAuditKind;
  readonly actorId?: string;
  readonly query?: string;
  readonly failuresOnly?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<WorkflowAuditPage> {
  const params = new URLSearchParams({ projectId: input.projectId });
  for (const [key, value] of Object.entries(input)) {
    if (key === "projectId" || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  return request(`/workflow-audit?${params.toString()}`);
}

export function pauseWorkflow(
  instanceId: string,
  input: WorkflowReasonInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/pause`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function resumeWorkflow(
  instanceId: string,
  input: WorkflowReasonInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/resume`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function retryWorkflowNode(
  instanceId: string,
  input: RetryWorkflowNodeInput,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/retry`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function reconcileWorkflow(
  instanceId: string,
): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/reconcile`, {
    method: "POST",
  });
}

export function advanceWorkflow(instanceId: string): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/advance`, {
    method: "POST",
  });
}

export function dispatchWorkflowStep(instanceId: string): Promise<{
  readonly instance: WorkflowInstance;
  readonly task: Task;
  readonly runId: string;
}> {
  return request(`/workflow-instances/${instanceId}/dispatch`, {
    method: "POST",
  });
}

export async function listDirectChats(): Promise<DirectChatThreadListItem[]> {
  return (
    await request<ListResponse<DirectChatThreadListItem>>("/direct-chats")
  ).items;
}

export function ensureDirectChat(agentId: string): Promise<DirectChatThread> {
  return request("/direct-chats", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
}

export function getDirectChat(threadId: string): Promise<DirectChatDetail> {
  return request(`/direct-chats/${threadId}`);
}

export function sendDirectChatMessage(
  threadId: string,
  content: string,
  clientMessageId: string,
): Promise<DirectChatSendResult> {
  return request(`/direct-chats/${threadId}/messages`, {
    method: "POST",
    headers: { "idempotency-key": clientMessageId },
    body: JSON.stringify({ content, clientMessageId }),
  });
}

export function retryDirectChatTurn(
  threadId: string,
  turnId: string,
): Promise<DirectChatSendResult> {
  return request(`/direct-chats/${threadId}/turns/${turnId}/retry`, {
    method: "POST",
    headers: { "idempotency-key": `direct-chat-retry:${turnId}` },
  });
}

export function cancelDirectChatTurn(
  threadId: string,
  turnId: string,
): Promise<{ readonly turn: DirectChatTurn }> {
  return request(`/direct-chats/${threadId}/turns/${turnId}/cancel`, {
    method: "POST",
  });
}

export async function listMeetings(projectId: string): Promise<Meeting[]> {
  return (
    await request<ListResponse<Meeting>>(
      `/meetings?projectId=${encodeURIComponent(projectId)}`,
    )
  ).items;
}

export function createMeeting(input: {
  projectId: string;
  title: string;
  agenda: string;
  agentIds: string[];
}): Promise<Meeting> {
  return request("/meetings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getMeeting(id: string): Promise<MeetingDetail> {
  return request(`/meetings/${id}`);
}

export function postMeetingMessage(
  meetingId: string,
  content: string,
  mentions: readonly string[] = [],
): Promise<MeetingMessage> {
  return request(`/meetings/${meetingId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, mentions }),
  });
}

export function getMeetingAiPolicy(
  meetingId: string,
): Promise<MeetingAiPolicy> {
  return request(`/meetings/${meetingId}/ai-policy`);
}

export function updateMeetingAiPolicy(
  meetingId: string,
  input: UpdateMeetingAiPolicyInput,
): Promise<MeetingAiPolicy> {
  return request(`/meetings/${meetingId}/ai-policy`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function transitionMeetingAiPolicy(
  meetingId: string,
  transition: "pause" | "resume" | "terminate",
  input: MeetingAiPolicyLifecycleInput,
): Promise<MeetingAiPolicy> {
  return request(`/meetings/${meetingId}/ai-policy/${transition}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function triggerMeetingAi(
  meetingId: string,
  input: TriggerMeetingAiInput,
  idempotencyKey?: string,
): Promise<TriggerMeetingAiResult> {
  return request(`/meetings/${meetingId}/ai-triggers`, {
    method: "POST",
    ...(idempotencyKey === undefined
      ? {}
      : { headers: { "idempotency-key": idempotencyKey } }),
    body: JSON.stringify(input),
  });
}

export function closeMeeting(
  meetingId: string,
  summary: string,
): Promise<Meeting> {
  return request(`/meetings/${meetingId}/close`, {
    method: "POST",
    body: JSON.stringify({ summary }),
  });
}

export function getMeetingMinutes(meetingId: string): Promise<MeetingMinutes> {
  return request(`/meetings/${meetingId}/minutes`);
}

export function saveMeetingMinutesDraft(
  meetingId: string,
  input: {
    content: string;
    decisions: string[];
    sourceMessageIds: string[];
    expectedRevision: number;
  },
): Promise<MeetingMinutesDraft> {
  return request(`/meetings/${meetingId}/minutes/draft`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function publishMeetingMinutes(
  meetingId: string,
  expectedRevision: number,
): Promise<{
  minutes: MeetingMinutes;
  version: MeetingMinutesVersion;
}> {
  return request(`/meetings/${meetingId}/minutes/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function listMeetingActionItems(
  meetingId: string,
): Promise<MeetingActionItem[]> {
  return (
    await request<{ items: MeetingActionItem[] }>(
      `/meetings/${meetingId}/action-items`,
    )
  ).items;
}

export function createMeetingActionItem(
  meetingId: string,
  input: CreateMeetingActionItemInput,
): Promise<MeetingActionItem> {
  return request(`/meetings/${meetingId}/action-items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMeetingActionItem(
  meetingId: string,
  actionItemId: string,
  status: MeetingActionItem["status"],
): Promise<MeetingActionItem> {
  return request(`/meetings/${meetingId}/action-items/${actionItemId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function convertMeetingActionItem(
  meetingId: string,
  actionItemId: string,
  input: ConvertMeetingActionItemInput,
): Promise<MeetingActionItemConversion> {
  return request(
    `/meetings/${meetingId}/action-items/${actionItemId}/convert`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function getMeetingTraceability(
  meetingId: string,
): Promise<MeetingTraceability> {
  return request(`/meetings/${meetingId}/traceability`);
}

async function requestBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  const token = authToken();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { headers });
  if (!response.ok) {
    if (response.status === 401) clearAuthToken();
    throw new ApiRequestError(
      `Request failed: ${response.status}`,
      "request_failed",
      response.status,
    );
  }
  return response.blob();
}

export interface RunStreamHandlers {
  readonly onEvent: (event: PlatformRunEvent) => void;
  readonly onDelta: (delta: RunDelta) => void;
}

export async function streamRun(
  runId: string,
  afterSeq: number,
  afterDeltaSeq: number,
  handlers: RunStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers({ accept: "text/event-stream" });
  const token = authToken();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(
    `${API_BASE}/runs/${runId}/stream?afterSeq=${afterSeq}&afterDeltaSeq=${afterDeltaSeq}`,
    { headers, signal },
  );
  if (!response.ok) {
    if (response.status === 401) clearAuthToken();
    throw new ApiRequestError(
      `Run stream failed: ${response.status}`,
      "request_failed",
      response.status,
    );
  }
  if (response.body === null) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (frame: string) => {
    if (frame.trim() === "") return;
    let eventName = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trimStart());
      }
    }
    if (data.length === 0) return;
    const payload = data.join("\n");
    if (eventName === "run.event") {
      handlers.onEvent(JSON.parse(payload) as PlatformRunEvent);
    } else if (eventName === "run.delta") {
      handlers.onDelta(JSON.parse(payload) as RunDelta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  dispatch(buffer);
}
