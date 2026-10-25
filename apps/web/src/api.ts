import type {
  Agent,
  ContextPack,
  ContextReceipt,
  CreateProjectInput,
  CreateTaskInput,
  PlatformRunEvent,
  Project,
  Run,
  RunDelta,
  RunDetail,
  Task,
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
  return (await response.json()) as T;
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

export async function listAgents(): Promise<Agent[]> {
  return (await request<ListResponse<Agent>>("/agents")).items;
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

export function dispatchTask(
  taskId: string,
): Promise<{ readonly runId: string }> {
  return request(`/tasks/${taskId}/dispatch`, { method: "POST" });
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

export function subscribeToRun(
  runId: string,
  afterSeq: number,
  afterDeltaSeq: number,
): EventSource {
  return new EventSource(
    `${API_BASE}/runs/${runId}/stream?afterSeq=${afterSeq}&afterDeltaSeq=${afterDeltaSeq}`,
  );
}
