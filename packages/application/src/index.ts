import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentDetail,
  Artifact,
  CreateAgentInput,
  CreateMeetingInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  CreateWorkflowInput,
  Meeting,
  MeetingDetail,
  MeetingMessage,
  MemoryTopic,
  Project,
  RunDetail,
  RunInputSnapshot,
  Task,
  TaskDetail,
  TaskMessage,
  TaskReviewInput,
  UpdateAgentInput,
  UpdateProjectInput,
  UpdateTaskInput,
  WorkbenchSummary,
  WorkflowDefinition,
  WorkflowInstance,
} from "@pluginmax/contracts";
import { canTransitionTask, isTerminalRunStatus } from "@pluginmax/domain";
import type { PlatformRepositories } from "@pluginmax/database";

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export class PlatformApplication {
  constructor(private readonly repositories: PlatformRepositories) {}

  listProjects(): Promise<Project[]> {
    return this.repositories.projects.list();
  }

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.repositories.projects.create(input);
  }

  async updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
    try {
      const project = await this.repositories.projects.update(id, input);
      if (project === undefined) {
        throw new ApplicationError(
          "project_not_found",
          "Project not found",
          404,
        );
      }
      return project;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          "project_code_conflict",
          "Project code already exists",
          409,
        );
      }
      throw error;
    }
  }

  listAgents(): Promise<Agent[]> {
    return this.repositories.agents.list();
  }

  listAllAgents(): Promise<Agent[]> {
    return this.repositories.agents.list(true);
  }

  async getAgent(id: string): Promise<AgentDetail> {
    const agent = await this.repositories.agents.get(id, true);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    return {
      agent,
      events: await this.repositories.agents.listEvents(id),
    };
  }

  createAgent(input: CreateAgentInput): Promise<Agent> {
    return this.repositories.agents.create(input, "local-admin", "local-admin");
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<AgentDetail> {
    const agent = await this.repositories.agents.update(
      id,
      input,
      "local-admin",
    );
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    return this.getAgent(id);
  }

  async setAgentStatus(
    id: string,
    status: Agent["status"],
  ): Promise<AgentDetail> {
    const agent = await this.repositories.agents.setStatus(
      id,
      status,
      "local-admin",
    );
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    return this.getAgent(id);
  }

  listTasks(projectId?: string): Promise<Task[]> {
    return this.repositories.tasks.list(projectId);
  }

  async getTask(id: string): Promise<Task> {
    const task = await this.repositories.tasks.get(id);
    if (task === undefined) {
      throw new ApplicationError("task_not_found", "Task not found", 404);
    }
    return task;
  }

  async getTaskDetail(id: string): Promise<TaskDetail> {
    return {
      task: await this.getTask(id),
      messages: await this.repositories.tasks.listMessages(id),
    };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const project = await this.repositories.projects.get(input.projectId);
    if (project === undefined) {
      throw new ApplicationError("project_not_found", "Project not found", 404);
    }
    const agent =
      input.agentId === undefined
        ? await this.repositories.agents.default()
        : await this.repositories.agents.get(input.agentId);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    return this.repositories.tasks.create(input, agent.id);
  }

  async listTaskRuns(taskId: string) {
    await this.getTask(taskId);
    return this.repositories.runs.listByTask(taskId);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskDetail> {
    const task = await this.repositories.tasks.update(id, input);
    if (task === undefined) {
      throw new ApplicationError("task_not_found", "Task not found", 404);
    }
    return this.getTaskDetail(id);
  }

  async postTaskMessage(
    id: string,
    input: CreateTaskMessageInput,
  ): Promise<TaskMessage> {
    await this.getTask(id);
    if (input.replyToId !== undefined) {
      const messages = await this.repositories.tasks.listMessages(id);
      if (!messages.some((message) => message.id === input.replyToId)) {
        throw new ApplicationError(
          "reply_target_not_found",
          "Reply target was not found on this task",
          400,
        );
      }
    }
    return this.repositories.tasks.addMessage(
      id,
      input,
      "human",
      "local-admin",
      "Local Admin",
    );
  }

  async dispatchTask(taskId: string): Promise<{ runId: string }> {
    const task = await this.getTask(taskId);
    if (!canTransitionTask(task.status, "in_progress")) {
      throw new ApplicationError(
        "invalid_task_status",
        `Task cannot be dispatched from status ${task.status}`,
        409,
      );
    }
    const agent = await this.repositories.agents.get(task.agentId);
    if (agent === undefined) {
      throw new ApplicationError(
        "agent_unavailable",
        "Task agent is unavailable",
        409,
      );
    }

    const inputSnapshot: RunInputSnapshot = {
      taskTitle: task.title,
      taskDescription: task.description,
      acceptance: task.acceptance,
      instruction: task.description,
      agentName: agent.name,
      runtimeKind: agent.runtimeKind,
    };
    const runId = randomUUID();
    await this.repositories.runs.enqueue({ runId, task, inputSnapshot });
    await this.repositories.runs.appendEvent(
      runId,
      "input.snapshot",
      "已保存本次运行的输入快照",
      { inputSnapshot },
    );
    return { runId };
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) {
      throw new ApplicationError("run_not_found", "Run not found", 404);
    }
    const events = await this.repositories.runs.listEvents(runId);
    return { run, events };
  }

  async getRunContext(runId: string) {
    const context = await this.repositories.contexts.getByRun(runId);
    if (context === undefined) {
      throw new ApplicationError(
        "context_not_ready",
        "ContextPack is not available for this run",
        404,
      );
    }
    return context;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) {
      throw new ApplicationError("run_not_found", "Run not found", 404);
    }
    if (isTerminalRunStatus(run.status)) {
      throw new ApplicationError(
        "run_already_finished",
        "Run has already finished",
        409,
      );
    }
    const cancelled = await this.repositories.runs.cancel(runId);
    if (!cancelled) {
      throw new ApplicationError(
        "run_cancel_failed",
        "Run could not be cancelled",
        409,
      );
    }
  }

  async reviewTask(taskId: string, input: TaskReviewInput): Promise<Task> {
    const task = await this.getTask(taskId);
    if (task.status !== "review") {
      throw new ApplicationError(
        "task_not_in_review",
        "Task is not waiting for review",
        409,
      );
    }
    if (input.decision === "return" && input.note.trim() === "") {
      throw new ApplicationError(
        "review_note_required",
        "A return decision requires a note",
        400,
      );
    }
    const runs = await this.repositories.runs.listByTask(taskId);
    const latestRun = runs.find((run) => run.status === "completed");
    await this.repositories.reviews.save(taskId, "local-admin", input);
    if (input.decision === "return") {
      await this.repositories.tasks.setStatus(taskId, "queued");
      return this.getTask(taskId);
    }
    if (latestRun === undefined || latestRun.output === null) {
      throw new ApplicationError(
        "run_output_missing",
        "Completed run output is unavailable",
        409,
      );
    }
    await this.repositories.tasks.setStatus(taskId, "done");
    await this.repositories.memory.publishTask({
      projectId: task.projectId,
      taskId: task.id,
      title: task.title,
      content: latestRun.output,
    });
    return this.getTask(taskId);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return this.repositories.artifacts.listByRun(runId);
  }

  async getArtifact(id: string): Promise<Artifact> {
    const artifact = await this.repositories.artifacts.get(id);
    if (artifact === undefined) {
      throw new ApplicationError(
        "artifact_not_found",
        "Artifact not found",
        404,
      );
    }
    return artifact;
  }

  async listMemory(projectId: string): Promise<MemoryTopic[]> {
    return this.repositories.memory.list(projectId);
  }

  async getWorkbench(): Promise<WorkbenchSummary> {
    return this.repositories.workbench.summary();
  }

  async listWorkflows(projectId: string): Promise<WorkflowDefinition[]> {
    return this.repositories.workflows.list(projectId);
  }

  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDefinition> {
    return this.repositories.workflows.create(input);
  }

  async startWorkflow(
    workflowId: string,
    title: string,
  ): Promise<WorkflowInstance> {
    const workflow = await this.repositories.workflows.get(workflowId);
    if (workflow === undefined) {
      throw new ApplicationError(
        "workflow_not_found",
        "Workflow not found",
        404,
      );
    }
    return this.repositories.workflows.start(workflow, title);
  }

  async getWorkflowInstance(id: string): Promise<WorkflowInstance> {
    const instance = await this.repositories.workflows.getInstance(id);
    if (instance === undefined) {
      throw new ApplicationError(
        "workflow_instance_not_found",
        "Workflow instance not found",
        404,
      );
    }
    return instance;
  }

  async advanceWorkflow(id: string): Promise<WorkflowInstance> {
    const instance = await this.repositories.workflows.advance(id);
    if (instance === undefined) {
      throw new ApplicationError(
        "workflow_instance_not_found",
        "Workflow instance not found",
        404,
      );
    }
    return instance;
  }

  async listMeetings(projectId: string): Promise<Meeting[]> {
    return this.repositories.meetings.list(projectId);
  }

  async createMeeting(input: CreateMeetingInput): Promise<Meeting> {
    const agents = await this.repositories.agents.list();
    return this.repositories.meetings.create(input, agents);
  }

  async getMeeting(id: string): Promise<MeetingDetail> {
    const detail = await this.repositories.meetings.detail(id);
    if (detail === undefined) {
      throw new ApplicationError("meeting_not_found", "Meeting not found", 404);
    }
    return detail;
  }

  async postMeetingMessage(
    meetingId: string,
    content: string,
  ): Promise<MeetingMessage> {
    const detail = await this.getMeeting(meetingId);
    if (detail.meeting.status === "closed") {
      throw new ApplicationError("meeting_closed", "Meeting is closed", 409);
    }
    return this.repositories.meetings.postMessage(
      meetingId,
      "human",
      "local-admin",
      "Local Admin",
      content,
    );
  }

  async closeMeeting(meetingId: string, summary: string): Promise<Meeting> {
    const meeting = await this.repositories.meetings.close(meetingId, summary);
    if (meeting === undefined) {
      throw new ApplicationError("meeting_not_found", "Meeting not found", 404);
    }
    return meeting;
  }
}

export * from "./run-executor.js";
