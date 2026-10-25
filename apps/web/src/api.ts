import type {
  Agent,
  AgentDetail,
  Artifact,
  ContextPack,
  ContextReceipt,
  CreateAgentInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateProjectMemberInput,
  CreateProjectRoleInput,
  CreateTaskMessageInput,
  ArchiveTaskAttachmentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkflowInput,
  Meeting,
  MeetingDetail,
  MeetingMessage,
  MemoryClaim,
  MemoryTopic,
  PlatformRunEvent,
  Project,
  ProjectMember,
  ProjectRole,
  PublishMemoryTruthInput,
  Run,
  RunDelta,
  RunDetail,
  Task,
  TaskDetail,
  TaskMessage,
  UploadTaskAttachmentInput,
  UpdateAgentInput,
  UpdateMemoryClaimInput,
  UpdateProjectMemberInput,
  UpdateProjectInput,
  UpdateProjectRoleInput,
  UpdateTaskInput,
  WorkbenchSummary,
  WorkflowDefinition,
  WorkflowInstance,
} from "@pluginmax/contracts";

const API_BASE = "/api/v1";

interface ListResponse<T> {
  readonly items: T[];
}

interface EventPage {
  readonly runId: string;
  readonly runStatus: Run["status"];
  readonly items: PlatformRunEvent[];
  readonly deltas: RunDelta[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Request failed: ${response.status}`);
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

export async function listMemory(projectId: string): Promise<MemoryTopic[]> {
  return (
    await request<ListResponse<MemoryTopic>>(`/projects/${projectId}/memory`)
  ).items;
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

export function getWorkbench(): Promise<WorkbenchSummary> {
  return request("/workbench");
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
): Promise<WorkflowInstance> {
  return request(`/workflows/${workflowId}/start`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function advanceWorkflow(instanceId: string): Promise<WorkflowInstance> {
  return request(`/workflow-instances/${instanceId}/advance`, {
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

export function subscribeToRun(
  runId: string,
  afterSeq: number,
  afterDeltaSeq: number,
): EventSource {
  return new EventSource(
    `${API_BASE}/runs/${runId}/stream?afterSeq=${afterSeq}&afterDeltaSeq=${afterDeltaSeq}`,
  );
}
