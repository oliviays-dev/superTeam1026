import { randomUUID } from "node:crypto";
import type {
  Agent,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  RunDetail,
  RunInputSnapshot,
  Task,
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

  listAgents(): Promise<Agent[]> {
    return this.repositories.agents.list();
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
}

export * from "./run-executor.js";
