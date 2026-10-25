import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentDetail,
  Artifact,
  CreateAgentInput,
  CreateMeetingInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateProjectMemberInput,
  CreateProjectInput,
  CreateProjectRoleInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  CreateWorkflowInput,
  Meeting,
  MeetingDetail,
  MeetingMessage,
  MemoryClaim,
  MemoryTopic,
  Project,
  ProjectMember,
  ProjectRole,
  PublishMemoryTruthInput,
  RunDetail,
  RunInputSnapshot,
  Task,
  TaskDetail,
  TaskMessage,
  TaskReviewInput,
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
import {
  assertProjectMemberCanBeRemoved,
  assertValidTaskDependencies,
  canTransitionTask,
  isTerminalRunStatus,
  normalizeProjectRoleIds,
  ProjectMembershipRuleError,
  TaskDependencyRuleError,
  unresolvedTaskDependencies,
} from "@pluginmax/domain";
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export class PlatformApplication {
  constructor(private readonly repositories: PlatformRepositories) {}

  listProjects(): Promise<Project[]> {
    return this.repositories.projects.list();
  }

  createProject(input: CreateProjectInput): Promise<Project> {
    return this.repositories.projects.create(input);
  }

  async listProjectRoles(projectId: string): Promise<ProjectRole[]> {
    await this.requireProject(projectId);
    return this.repositories.projectMemberships.listRoles(projectId);
  }

  async createProjectRole(
    projectId: string,
    input: CreateProjectRoleInput,
  ): Promise<ProjectRole> {
    await this.requireProject(projectId);
    try {
      return await this.repositories.projectMemberships.createRole(
        projectId,
        input,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApplicationError(
          "project_role_name_conflict",
          "A project role with this name already exists",
          409,
        );
      }
      throw error;
    }
  }

  async updateProjectRole(
    projectId: string,
    roleId: string,
    input: UpdateProjectRoleInput,
  ): Promise<ProjectRole> {
    await this.requireProject(projectId);
    try {
      const role = await this.repositories.projectMemberships.updateRole(
        projectId,
        roleId,
        input,
      );
      if (role === undefined) {
        throw new ApplicationError(
          "project_role_not_found",
          "Project role not found",
          404,
        );
      }
      return role;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApplicationError(
          "project_role_name_conflict",
          "A project role with this name already exists",
          409,
        );
      }
      throw error;
    }
  }

  async deleteProjectRole(projectId: string, roleId: string): Promise<void> {
    await this.requireProject(projectId);
    const result = await this.repositories.projectMemberships.deleteRole(
      projectId,
      roleId,
    );
    if (result === "assigned") {
      throw new ApplicationError(
        "project_role_in_use",
        "Remove the role from project members before deleting it",
        409,
      );
    }
    if (result === "not_found") {
      throw new ApplicationError(
        "project_role_not_found",
        "Project role not found",
        404,
      );
    }
  }

  async listProjectMembers(projectId: string): Promise<ProjectMember[]> {
    await this.requireProject(projectId);
    return this.repositories.projectMemberships.listMembers(projectId);
  }

  async createProjectMember(
    projectId: string,
    input: CreateProjectMemberInput,
  ): Promise<ProjectMember> {
    await this.requireProject(projectId);
    const roles =
      await this.repositories.projectMemberships.listRoles(projectId);
    let roleIds: string[] = [];
    guardMembershipRule(() => {
      roleIds = normalizeProjectRoleIds(projectId, input.roleIds, roles);
    });

    let actorId = "local-admin";
    let name = input.name ?? "Local Admin";
    if (input.kind === "agent") {
      if (input.agentId === undefined) {
        throw new ApplicationError(
          "agent_id_required",
          "agentId is required for agent members",
          400,
        );
      }
      const agent = await this.repositories.agents.get(input.agentId, true);
      if (agent === undefined || agent.status !== "active") {
        throw new ApplicationError(
          "agent_unavailable",
          "Only an active agent can join a project",
          409,
        );
      }
      actorId = agent.id;
      name = agent.name;
    }

    try {
      return await this.repositories.projectMemberships.createMember(
        projectId,
        {
          kind: input.kind,
          actorId,
          name,
          responsibility: input.responsibility,
          roleIds,
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApplicationError(
          "project_member_exists",
          "This actor is already a project member",
          409,
        );
      }
      if (
        error instanceof Error &&
        error.message === "project role scope mismatch"
      ) {
        throw new ApplicationError(
          "project_role_scope_mismatch",
          "All selected roles must belong to the project",
          400,
        );
      }
      throw error;
    }
  }

  async updateProjectMember(
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberInput,
  ): Promise<ProjectMember> {
    await this.requireProject(projectId);
    const member = await this.repositories.projectMemberships.getMember(
      projectId,
      memberId,
    );
    if (member === undefined) {
      throw new ApplicationError(
        "project_member_not_found",
        "Project member not found",
        404,
      );
    }
    if (input.status === "inactive") {
      guardMembershipRule(() => assertProjectMemberCanBeRemoved(member));
    }
    let roleIds: string[] | undefined;
    if (input.roleIds !== undefined) {
      const roles =
        await this.repositories.projectMemberships.listRoles(projectId);
      guardMembershipRule(() => {
        roleIds = normalizeProjectRoleIds(projectId, input.roleIds!, roles);
      });
    }
    try {
      const updated = await this.repositories.projectMemberships.updateMember(
        projectId,
        memberId,
        { ...input, ...(roleIds === undefined ? {} : { roleIds }) },
      );
      if (updated === undefined) {
        throw new ApplicationError(
          "project_member_not_found",
          "Project member not found",
          404,
        );
      }
      return updated;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "project role scope mismatch"
      ) {
        throw new ApplicationError(
          "project_role_scope_mismatch",
          "All selected roles must belong to the project",
          400,
        );
      }
      throw error;
    }
  }

  async deleteProjectMember(
    projectId: string,
    memberId: string,
  ): Promise<void> {
    await this.requireProject(projectId);
    const member = await this.repositories.projectMemberships.getMember(
      projectId,
      memberId,
    );
    if (member === undefined) {
      throw new ApplicationError(
        "project_member_not_found",
        "Project member not found",
        404,
      );
    }
    guardMembershipRule(() => assertProjectMemberCanBeRemoved(member));
    await this.repositories.projectMemberships.deleteMember(
      projectId,
      memberId,
    );
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
    const task = await this.getTask(id);
    const projectTasks = await this.repositories.tasks.list(task.projectId);
    return {
      task,
      messages: await this.repositories.tasks.listMessages(id),
      dependencies: task.dependsOn.map((dependencyId) => {
        const dependency = projectTasks.find(
          (candidate) => candidate.id === dependencyId,
        );
        return {
          id: dependencyId,
          title: dependency?.title ?? "已失效的前置任务",
          status: dependency?.status ?? "cancelled",
        };
      }),
    };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const project = await this.repositories.projects.get(input.projectId);
    if (project === undefined) {
      throw new ApplicationError("project_not_found", "Project not found", 404);
    }
    const projectTasks = await this.repositories.tasks.list(input.projectId);
    const candidateTaskId = randomUUID();
    guardTaskDependencyRule(() =>
      assertValidTaskDependencies({
        taskId: candidateTaskId,
        projectId: input.projectId,
        dependsOn: input.dependsOn,
        tasks: projectTasks,
      }),
    );
    const assignee = await this.resolveTaskAssignee(input);
    return this.repositories.tasks.create(
      input,
      assignee.agentId,
      assignee.roleId,
    );
  }

  async listTaskRuns(taskId: string) {
    await this.getTask(taskId);
    return this.repositories.runs.listByTask(taskId);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskDetail> {
    const existing = await this.getTask(id);
    if (input.dependsOn !== undefined) {
      const projectTasks = await this.repositories.tasks.list(
        existing.projectId,
      );
      guardTaskDependencyRule(() =>
        assertValidTaskDependencies({
          taskId: id,
          projectId: existing.projectId,
          dependsOn: input.dependsOn!,
          tasks: projectTasks,
        }),
      );
    }
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
    const projectTasks = await this.repositories.tasks.list(task.projectId);
    const unresolved = unresolvedTaskDependencies(task, projectTasks);
    if (unresolved.length > 0) {
      throw new ApplicationError(
        "task_dependencies_unresolved",
        "All prerequisite tasks must be done before dispatch",
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

  private async resolveTaskAssignee(input: CreateTaskInput): Promise<{
    readonly agentId: string;
    readonly roleId?: string;
  }> {
    if (input.roleId !== undefined) {
      const roles = await this.repositories.projectMemberships.listRoles(
        input.projectId,
      );
      if (!roles.some((role) => role.id === input.roleId)) {
        throw new ApplicationError(
          "project_role_not_found",
          "Project role not found",
          404,
        );
      }
      const members = await this.repositories.projectMemberships.listMembers(
        input.projectId,
      );
      const agentMember = members.find(
        (member) =>
          member.kind === "agent" &&
          member.status === "active" &&
          member.roles.some((role) => role.id === input.roleId),
      );
      if (agentMember === undefined) {
        throw new ApplicationError(
          "project_role_has_no_agent",
          "The selected project role has no active AI member",
          409,
        );
      }
      return { agentId: agentMember.actorId, roleId: input.roleId };
    }
    const agent =
      input.agentId === undefined
        ? await this.repositories.agents.default()
        : await this.repositories.agents.get(input.agentId);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    return { agentId: agent.id };
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

  async createMemoryTopic(
    projectId: string,
    input: CreateMemoryTopicInput,
  ): Promise<MemoryTopic> {
    await this.requireProject(projectId);
    return this.repositories.memory.createTopic(projectId, input);
  }

  async addMemoryClaim(
    projectId: string,
    topicId: string,
    input: CreateMemoryClaimInput,
  ): Promise<MemoryClaim> {
    await this.requireProject(projectId);
    try {
      return await this.repositories.memory.addClaim(projectId, topicId, input);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "memory topic not found"
      ) {
        throw new ApplicationError(
          "memory_topic_not_found",
          "Memory topic not found",
          404,
        );
      }
      throw error;
    }
  }

  async updateMemoryClaim(
    projectId: string,
    topicId: string,
    claimId: string,
    input: UpdateMemoryClaimInput,
  ): Promise<MemoryClaim> {
    await this.requireProject(projectId);
    const claim = await this.repositories.memory.updateClaim(
      projectId,
      topicId,
      claimId,
      input,
    );
    if (claim === undefined) {
      throw new ApplicationError(
        "memory_claim_not_found",
        "Memory claim not found",
        404,
      );
    }
    return claim;
  }

  async publishMemoryTruth(
    projectId: string,
    topicId: string,
    input: PublishMemoryTruthInput,
  ): Promise<MemoryTopic> {
    await this.requireProject(projectId);
    try {
      return await this.repositories.memory.publishTruth(
        projectId,
        topicId,
        input,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "memory topic not found"
      ) {
        throw new ApplicationError(
          "memory_topic_not_found",
          "Memory topic not found",
          404,
        );
      }
      if (
        error instanceof Error &&
        error.message === "memory claim scope mismatch"
      ) {
        throw new ApplicationError(
          "memory_claim_scope_mismatch",
          "All selected claims must belong to this topic",
          400,
        );
      }
      if (
        error instanceof Error &&
        error.message === "rejected memory claims cannot form current truth"
      ) {
        throw new ApplicationError(
          "memory_claim_rejected",
          "Rejected claims cannot form current truth",
          409,
        );
      }
      throw error;
    }
  }

  async getWorkbench(): Promise<WorkbenchSummary> {
    return this.repositories.workbench.summary();
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.repositories.projects.get(projectId);
    if (project === undefined) {
      throw new ApplicationError("project_not_found", "Project not found", 404);
    }
    return project;
  }

  async listWorkflows(projectId: string): Promise<WorkflowDefinition[]> {
    return this.repositories.workflows.list(projectId);
  }

  async createWorkflow(
    input: CreateWorkflowInput,
  ): Promise<WorkflowDefinition> {
    const stepAgentIds: Array<string | undefined> = [];
    if (input.stepRoleIds.length > 0) {
      const roles = await this.repositories.projectMemberships.listRoles(
        input.projectId,
      );
      const roleIds = new Set(roles.map((role) => role.id));
      if (input.stepRoleIds.some((roleId) => !roleIds.has(roleId))) {
        throw new ApplicationError(
          "project_role_scope_mismatch",
          "Workflow step roles must belong to the project",
          400,
        );
      }
      const members = await this.repositories.projectMemberships.listMembers(
        input.projectId,
      );
      for (const roleId of input.stepRoleIds) {
        const member = members.find(
          (candidate) =>
            candidate.kind === "agent" &&
            candidate.status === "active" &&
            candidate.roles.some((role) => role.id === roleId),
        );
        if (member === undefined) {
          throw new ApplicationError(
            "project_role_has_no_agent",
            "Every workflow role needs an active AI member",
            409,
          );
        }
        stepAgentIds.push(member.actorId);
      }
    }
    return this.repositories.workflows.createResolved(input, stepAgentIds);
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

function guardMembershipRule(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (
      error instanceof ProjectMembershipRuleError &&
      error.code === "project_owner_required"
    ) {
      throw new ApplicationError("project_owner_required", error.message, 409);
    }
    if (
      error instanceof ProjectMembershipRuleError &&
      error.code === "project_role_scope_mismatch"
    ) {
      throw new ApplicationError(
        "project_role_scope_mismatch",
        error.message,
        400,
      );
    }
    throw error;
  }
}

function guardTaskDependencyRule(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof TaskDependencyRuleError) {
      throw new ApplicationError(
        error.code,
        error.path.length === 0
          ? error.message
          : `${error.message}: ${error.path.join(" -> ")}`,
        409,
      );
    }
    throw error;
  }
}

export * from "./run-executor.js";
