import type {
  Agent,
  AgentDetail,
  AgentEpisode,
  ApprovalSlaSweepResult,
  Artifact,
  ConfirmHandoffCardInput,
  ContextPack,
  ContextReceipt,
  ConvertMeetingActionItemInput,
  CreateAgentInput,
  CreateHandoffCardInput,
  CreateMeetingActionItemInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateProjectMemberInput,
  CreateProjectRoleInput,
  CreateTaskMessageInput,
  CompleteWorkflowNodeInput,
  DecideWorkflowApprovalInput,
  ArchiveTaskAttachmentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkflowInput,
  CosignWorkflowApprovalInput,
  ImportWorkflowMarkdownInput,
  IdempotencyCleanupInput,
  IdempotencyCleanupResult,
  Job,
  HandoffCard,
  Meeting,
  MeetingActionItem,
  MeetingActionItemConversion,
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
  ProjectMember,
  ProjectRole,
  PublishMemoryTruthInput,
  ReadinessResponse,
  ReviewMemoryClaimsInput,
  RetryWorkflowNodeInput,
  Run,
  RunDelta,
  RunDetail,
  OperationsSnapshot,
  Task,
  TaskDetail,
  TaskMessage,
  TransferWorkflowApprovalInput,
  UploadTaskAttachmentInput,
  UpdateAgentInput,
  UpdateHandoffCardInput,
  UpdateMemoryClaimInput,
  UpdateProjectMemberInput,
  UpdateProjectInput,
  UpdateProjectRoleInput,
  UpdateTaskInput,
  ValidateWorkflowMarkdownInput,
  WorkbenchSummary,
  WorkflowDefinition,
  WorkflowAuditPage,
  WorkflowAuditKind,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowReasonInput,
  WorkflowValidationResult,
} from "@pluginmax/contracts";

const API_BASE = "/api/v1";

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

interface EventPage {
  readonly runId: string;
  readonly runStatus: Run["status"];
  readonly items: PlatformRunEvent[];
  readonly deltas: RunDelta[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
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

export async function listProjects(): Promise<Project[]> {
  return (await request<ListResponse<Project>>("/projects")).items;
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return request("/projects", {
    method: "POST",
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

export async function listTasks(projectId?: string): Promise<Task[]> {
  const query =
    projectId === undefined
      ? ""
      : `?projectId=${encodeURIComponent(projectId)}`;
  return (await request<ListResponse<Task>>(`/tasks${query}`)).items;
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

export function taskAttachmentDownloadUrl(attachmentId: string): string {
  return `${API_BASE}/attachments/${attachmentId}/download`;
}

export function dispatchTask(
  taskId: string,
): Promise<{ readonly runId: string }> {
  return request(`/tasks/${taskId}/dispatch`, { method: "POST" });
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

export function getRunContext(
  runId: string,
): Promise<{ pack: ContextPack; receipt: ContextReceipt }> {
  return request(`/runs/${runId}/context`);
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

export function artifactDownloadUrl(artifactId: string): string {
  return `${API_BASE}/artifacts/${artifactId}/download`;
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
): Promise<MeetingMessage> {
  return request(`/meetings/${meetingId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
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

export function subscribeToRun(
  runId: string,
  afterSeq: number,
  afterDeltaSeq: number,
): EventSource {
  return new EventSource(
    `${API_BASE}/runs/${runId}/stream?afterSeq=${afterSeq}&afterDeltaSeq=${afterDeltaSeq}`,
  );
}
