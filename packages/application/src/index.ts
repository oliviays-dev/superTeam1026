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
  CompleteWorkflowNodeInput,
  DecideWorkflowApprovalInput,
  ImportWorkflowMarkdownInput,
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
  RetryWorkflowNodeInput,
  StartWorkflowInput,
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
  ValidateWorkflowMarkdownInput,
  WorkbenchSummary,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowInstanceStatus,
  WorkflowReasonInput,
  WorkflowRuntimeNode,
  WorkflowRuntimeState,
  WorkflowStepDefinition,
  WorkflowValidationResult,
} from "@pluginmax/contracts";
import {
  assertProjectMemberCanBeRemoved,
  assertValidTaskDependencies,
  canTransitionTask,
  deriveWorkflowInstanceStatus,
  initializeWorkflowRuntime,
  isTerminalRunStatus,
  normalizeProjectRoleIds,
  ProjectMembershipRuleError,
  TaskDependencyRuleError,
  validateWorkflowMarkdown,
  transitionWorkflowNode,
  unresolvedTaskDependencies,
} from "@pluginmax/domain";
import type { PlatformRepositories, TaskAttachment } from "@pluginmax/database";
import type { FileRef, FileStore } from "@pluginmax/files";

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
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
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly files?: FileStore,
  ) {}

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
    const [messages, activity, attachments] = await Promise.all([
      this.repositories.tasks.listMessages(id),
      this.repositories.taskCollaboration.listEvents(id),
      this.repositories.taskCollaboration.listAttachments(id),
    ]);
    return {
      task,
      messages,
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
      activity,
      attachments,
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
    const task = await this.repositories.tasks.create(
      input,
      assignee.agentId,
      assignee.roleId,
    );
    await this.repositories.taskCollaboration.appendEvent({
      taskId: task.id,
      kind: "created",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: `创建任务“${task.title}”`,
    });
    return task;
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
    await this.repositories.taskCollaboration.appendEvent({
      taskId: id,
      kind: input.dependsOn === undefined ? "updated" : "dependency",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary:
        input.dependsOn === undefined
          ? "更新任务内容"
          : `更新前置依赖为 ${input.dependsOn.length} 项`,
      data:
        input.dependsOn === undefined
          ? null
          : { dependsOn: [...input.dependsOn] },
    });
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
    const message = await this.repositories.tasks.addMessage(
      id,
      input,
      "human",
      "local-admin",
      "Local Admin",
    );
    await this.repositories.taskCollaboration.appendEvent({
      taskId: id,
      kind: "message",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: input.replyToId === undefined ? "添加任务评论" : "回复任务评论",
      data: {
        messageId: message.id,
        ...(input.replyToId === undefined
          ? {}
          : { replyToId: input.replyToId }),
      },
    });
    return message;
  }

  async uploadTaskAttachment(
    taskId: string,
    input: {
      readonly name: string;
      readonly mimeType: string;
      readonly content: Uint8Array;
    },
  ) {
    const task = await this.getTask(taskId);
    await this.requireProjectOwner(task.projectId);
    if (this.files === undefined) {
      throw new ApplicationError(
        "file_store_unavailable",
        "FileStore is not configured",
        503,
      );
    }
    const ref = await this.files.put({
      workspaceId: task.projectId,
      name: input.name,
      mimeType: input.mimeType,
      content: input.content,
    });
    const attachment = await this.repositories.taskCollaboration.saveAttachment(
      {
        taskId,
        projectId: task.projectId,
        ref,
        uploadedBy: "Local Admin",
      },
    );
    await this.repositories.taskCollaboration.appendEvent({
      taskId,
      kind: "attachment",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: `上传任务附件“${attachment.name}”`,
      data: { attachmentId: attachment.id },
    });
    return attachment;
  }

  async readTaskAttachment(attachmentId: string): Promise<{
    readonly attachment: TaskAttachment;
    readonly content: Uint8Array;
  }> {
    const attachment =
      await this.repositories.taskCollaboration.getAttachment(attachmentId);
    if (attachment === undefined) {
      throw new ApplicationError(
        "task_attachment_not_found",
        "Task attachment not found",
        404,
      );
    }
    await this.requireProjectOwner(attachment.projectId);
    if (this.files === undefined) {
      throw new ApplicationError(
        "file_store_unavailable",
        "FileStore is not configured",
        503,
      );
    }
    const ref: FileRef = {
      id: attachment.id,
      storageKey: attachment.storageKey,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
    };
    return { attachment, content: await this.files.read(ref) };
  }

  async archiveTaskAttachment(attachmentId: string, archived: boolean) {
    const attachment =
      await this.repositories.taskCollaboration.getAttachment(attachmentId);
    if (attachment === undefined) {
      throw new ApplicationError(
        "task_attachment_not_found",
        "Task attachment not found",
        404,
      );
    }
    await this.requireProjectOwner(attachment.projectId);
    const updated =
      await this.repositories.taskCollaboration.setAttachmentArchived(
        attachmentId,
        archived,
      );
    if (updated === undefined) {
      throw new ApplicationError(
        "task_attachment_not_found",
        "Task attachment not found",
        404,
      );
    }
    await this.repositories.taskCollaboration.appendEvent({
      taskId: attachment.taskId,
      kind: "attachment",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: `${archived ? "归档" : "复原"}任务附件“${attachment.name}”`,
      data: { attachmentId, archived },
    });
    return updated;
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
    await this.repositories.taskCollaboration.appendEvent({
      taskId,
      kind: "dispatch",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: "派发任务执行",
      data: { runId },
    });
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
    await this.repositories.taskCollaboration.appendEvent({
      taskId,
      kind: "review",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: input.decision === "approve" ? "验收通过" : "退回任务并补充说明",
      data: { note: input.note, decision: input.decision },
    });
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

  private async requireProjectOwner(projectId: string): Promise<void> {
    await this.requireProject(projectId);
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const owner = members.some(
      (member) =>
        member.kind === "human" &&
        member.actorId === "local-admin" &&
        member.owner &&
        member.status === "active",
    );
    if (!owner) {
      throw new ApplicationError(
        "forbidden",
        "Project owner permission is required",
        403,
      );
    }
  }

  async listWorkflows(projectId: string): Promise<WorkflowDefinition[]> {
    return this.repositories.workflows.list(projectId);
  }

  validateWorkflowMarkdown(
    input: ValidateWorkflowMarkdownInput,
  ): WorkflowValidationResult {
    return validateWorkflowMarkdown(input.markdown);
  }

  async importWorkflowMarkdown(
    input: ImportWorkflowMarkdownInput,
  ): Promise<WorkflowDefinition> {
    const validation = validateWorkflowMarkdown(input.markdown);
    if (!validation.valid || validation.graph === null) {
      throw new ApplicationError(
        "workflow_validation_failed",
        "Workflow Markdown validation failed",
        400,
        validation,
      );
    }
    await this.requireProject(input.projectId);
    const roles = await this.repositories.projectMemberships.listRoles(
      input.projectId,
    );
    const roleIds = new Set(roles.map((role) => role.id));
    const steps: WorkflowStepDefinition[] = [];
    for (const node of validation.graph.nodes) {
      if (node.executor.kind === "role" && !roleIds.has(node.executor.id)) {
        throw new ApplicationError(
          "project_role_not_found",
          `Workflow role is not in the project: ${node.executor.id}`,
          400,
        );
      }
      const agent =
        node.executor.kind === "agent" && isUuid(node.executor.id)
          ? await this.repositories.agents.get(node.executor.id)
          : undefined;
      steps.push({
        id: randomUUID(),
        name: node.name,
        kind:
          node.executor.kind === "agent" || node.executor.kind === "role"
            ? "agent"
            : "human",
        ...(node.executor.kind === "role" ? { roleId: node.executor.id } : {}),
        ...(agent === undefined ? {} : { agentId: agent.id }),
        autoDispatch: node.autoDispatch,
      });
    }
    if (
      await this.repositories.workflowRuntime.hasSubworkflowCycle(
        input.projectId,
        validation.graph,
        [],
      )
    ) {
      throw new ApplicationError(
        "workflow_subworkflow_cycle",
        "Subworkflow references form a cycle",
        409,
      );
    }
    for (const node of validation.graph.nodes) {
      if (
        node.type === "subworkflow" &&
        (await this.repositories.workflowRuntime.getDefinition(
          input.projectId,
          node.subworkflowKey!,
          node.subworkflowVersion,
        )) === undefined
      ) {
        throw new ApplicationError(
          "workflow_subworkflow_not_found",
          `Subworkflow is not active in this project: ${node.subworkflowKey}`,
          409,
        );
      }
    }
    return this.repositories.workflows.createResolved(
      {
        projectId: input.projectId,
        name: validation.graph.name,
        description: validation.graph.description,
        stepNames: validation.graph.nodes.map((node) => node.name),
        stepRoleIds: [],
      },
      [],
      {
        sourceMarkdown: input.markdown,
        graph: validation.graph,
        steps,
      },
    );
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
    input: StartWorkflowInput | string,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const workflow = await this.repositories.workflows.get(workflowId);
    if (workflow === undefined) {
      throw new ApplicationError(
        "workflow_not_found",
        "Workflow not found",
        404,
      );
    }
    const graph = graphForWorkflow(workflow);
    if (graph === null) {
      throw new ApplicationError(
        "workflow_graph_missing",
        "Workflow has no executable graph",
        409,
      );
    }
    const startInput: StartWorkflowInput =
      typeof input === "string" ? { title: input, context: {} } : input;
    if (workflow.graph === null) {
      await this.repositories.workflows.setGraphIfMissing(workflow.id, graph);
    }
    return this.createWorkflowInstance({
      workflow,
      graph,
      title: startInput.title,
      context: startInput.context,
      actorId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  private async createWorkflowInstance(input: {
    readonly workflow: WorkflowDefinition;
    readonly graph: WorkflowGraph;
    readonly title: string;
    readonly context: Record<string, string | number | boolean | null>;
    readonly actorId: string;
    readonly idempotencyKey?: string;
    readonly parentInstanceId?: string;
    readonly parentNodeId?: string;
  }): Promise<WorkflowInstance> {
    await this.assertWorkflowActor(input.workflow.projectId, input.actorId);
    const ancestors = input.parentInstanceId
      ? await this.workflowAncestorKeys(input.parentInstanceId)
      : [];
    if (
      await this.repositories.workflowRuntime.hasSubworkflowCycle(
        input.workflow.projectId,
        input.graph,
        ancestors,
      )
    ) {
      throw new ApplicationError(
        "workflow_subworkflow_cycle",
        "The subworkflow call chain contains a cycle",
        409,
      );
    }
    const runtime = initializeWorkflowRuntime(input.graph, input.context);
    let instance = await this.repositories.workflowRuntime.createInstance({
      workflow: input.workflow,
      graph: input.graph,
      title: input.title,
      context: input.context,
      runtime,
      status: deriveWorkflowInstanceStatus(runtime),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      ...(input.parentInstanceId === undefined
        ? {}
        : { parentInstanceId: input.parentInstanceId }),
      ...(input.parentNodeId === undefined
        ? {}
        : { parentNodeId: input.parentNodeId }),
    });
    instance = await this.activateWorkflowRuntime(instance, input.actorId);
    return instance;
  }

  async listWorkflowInstances(projectId: string): Promise<WorkflowInstance[]> {
    await this.requireProject(projectId);
    return this.repositories.workflowRuntime.list(projectId);
  }

  async dispatchWorkflowStep(
    instanceId: string,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<{
    readonly instance: WorkflowInstance;
    readonly task: Task;
    readonly runId: string;
  }> {
    const instance = await this.getWorkflowInstance(instanceId);
    if (instance.status !== "active" && instance.status !== "waiting") {
      throw new ApplicationError(
        "workflow_not_active",
        "Workflow instance is not active",
        409,
      );
    }
    const runtime = cloneRuntime(instance.runtime);
    const node = runtime.nodes.find(
      (candidate) => candidate.status === "ready" && candidate.type === "task",
    );
    const graph = instance.graph;
    if (node === undefined || graph === null) {
      throw new ApplicationError(
        "workflow_step_not_agent",
        "No dispatchable workflow task is ready",
        409,
      );
    }
    await this.claimWorkflowCommand(
      instance.id,
      `dispatch:${node.nodeId}:${node.visits}:${node.attempt + 1}`,
      idempotencyKey,
    );
    const definition = graph.nodes.find(
      (candidate) => candidate.id === node.nodeId,
    );
    if (definition === undefined) {
      throw new ApplicationError(
        "workflow_step_not_found",
        "Workflow node definition not found",
        404,
      );
    }
    await this.assertWorkflowActor(instance.projectId, actorId);
    const { task, runId } = await this.startWorkflowNodeTask(
      instance,
      runtime,
      definition,
      actorId,
    );
    const status = deriveWorkflowInstanceStatus(runtime);
    const updated = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime,
        status,
        actorId,
        audits: [
          {
            kind: "node.started",
            nodeId: node.nodeId,
            summary: `派发节点“${node.name}”至 Agent`,
            data: { taskId: task.id, runId, attempt: node.attempt },
          },
        ],
      },
    );
    if (updated === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return {
      instance: await this.activateWorkflowRuntime(updated, actorId),
      task,
      runId,
    };
  }

  async getWorkflowInstance(id: string): Promise<WorkflowInstance> {
    const instance = await this.repositories.workflowRuntime.get(id);
    if (instance === undefined) {
      throw new ApplicationError(
        "workflow_instance_not_found",
        "Workflow instance not found",
        404,
      );
    }
    return instance;
  }

  async getWorkflowInstanceDetail(id: string): Promise<WorkflowInstanceDetail> {
    const instance = await this.getWorkflowInstance(id);
    const [approvals, audit, children] = await Promise.all([
      this.repositories.workflowRuntime.listApprovals(id),
      this.repositories.workflowRuntime.listAudit(id),
      this.repositories.workflowRuntime.listChildren(id),
    ]);
    return { instance, approvals, audit, children };
  }

  async advanceWorkflow(
    id: string,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    await this.reconcileWorkflowInstance(id, actorId);
    const current = await this.getWorkflowInstance(id);
    if (current.status === "blocked" || current.status === "failed") {
      throw new ApplicationError(
        "workflow_not_advanceable",
        current.failureReason ?? "Workflow is blocked or failed",
        409,
      );
    }
    const node = current.runtime.nodes.find(
      (candidate) =>
        candidate.status === "ready" &&
        candidate.type !== "decision" &&
        candidate.type !== "approval" &&
        candidate.type !== "subworkflow",
    );
    if (node === undefined) {
      const waiting = current.runtime.nodes.find(
        (candidate) =>
          candidate.status === "running" ||
          candidate.status === "waiting_approval",
      );
      if (waiting !== undefined) {
        throw new ApplicationError(
          "workflow_gate_blocked",
          `Workflow node “${waiting.name}” is still ${waiting.status}`,
          409,
        );
      }
      return current;
    }
    const updated = await this.completeWorkflowNode(
      id,
      { nodeId: node.nodeId, output: "人工确认完成" },
      actorId,
      idempotencyKey,
    );
    return updated;
  }

  async completeWorkflowNode(
    instanceId: string,
    input: CompleteWorkflowNodeInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    if (instance.status === "paused") {
      throw new ApplicationError(
        "workflow_paused",
        "Resume the workflow before completing a node",
        409,
      );
    }
    if (instance.graph === null) {
      throw new ApplicationError(
        "workflow_graph_missing",
        "Workflow graph is unavailable",
        409,
      );
    }
    const node = requireRuntimeNode(instance.runtime, input.nodeId);
    const definition = requireGraphNode(instance.graph, input.nodeId);
    if (node.type === "approval") {
      throw new ApplicationError(
        "workflow_approval_required",
        "Approval nodes must be decided through the approval endpoint",
        409,
      );
    }
    if (node.type === "decision" || node.type === "subworkflow") {
      throw new ApplicationError(
        "workflow_node_managed",
        "This node is advanced by the workflow runtime",
        409,
      );
    }
    if (!["ready", "running"].includes(node.status)) {
      throw new ApplicationError(
        "workflow_node_not_completable",
        `Node cannot complete from status ${node.status}`,
        409,
      );
    }
    await this.assertWorkflowActor(instance.projectId, actorId);
    await this.assertWorkflowNodeActor(instance.projectId, definition, actorId);
    if (node.taskId !== null) {
      const task = await this.getTask(node.taskId);
      if (task.status !== "done") {
        throw new ApplicationError(
          "workflow_gate_blocked",
          "The linked Agent task must pass review before the workflow can advance",
          409,
        );
      }
      await this.assertWorkflowDeliverable(task.id);
    }
    await this.claimWorkflowCommand(
      instance.id,
      `complete:${node.nodeId}:${node.visits}`,
      idempotencyKey,
    );
    const transition = transitionWorkflowNode({
      graph: instance.graph,
      runtime: instance.runtime,
      nodeId: node.nodeId,
      actorId,
      output: input.output,
    });
    const updated = await this.saveRuntimeTransition(
      instance,
      transition,
      actorId,
    );
    return this.activateWorkflowRuntime(updated, actorId);
  }

  async decideWorkflowApproval(
    instanceId: string,
    input: DecideWorkflowApprovalInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    if (instance.status === "paused") {
      throw new ApplicationError(
        "workflow_paused",
        "Resume the workflow before deciding an approval",
        409,
      );
    }
    if (instance.graph === null) {
      throw new ApplicationError(
        "workflow_graph_missing",
        "Workflow graph is unavailable",
        409,
      );
    }
    const node = requireRuntimeNode(instance.runtime, input.nodeId);
    if (node.type !== "approval" || node.status !== "waiting_approval") {
      throw new ApplicationError(
        "workflow_approval_not_pending",
        "The node is not waiting for approval",
        409,
      );
    }
    await this.assertWorkflowActor(instance.projectId, actorId);
    await this.claimWorkflowCommand(
      instance.id,
      `approval:${node.nodeId}:${node.visits}:${actorId}`,
      idempotencyKey,
    );
    const decided = await this.repositories.workflowRuntime.decideApproval({
      instanceId,
      nodeId: node.nodeId,
      round: node.visits,
      actorId,
      decision: input.decision,
      note: input.note,
    });
    if (!decided) {
      throw new ApplicationError(
        "workflow_approval_forbidden",
        "The actor is not a pending approver for this node",
        403,
      );
    }
    const approvals =
      await this.repositories.workflowRuntime.listApprovals(instanceId);
    const round = approvals.filter(
      (approval) =>
        approval.nodeId === node.nodeId && approval.round === node.visits,
    );
    const rejected = round.some((approval) => approval.status === "rejected");
    const definition = requireGraphNode(instance.graph, node.nodeId);
    const complete =
      rejected ||
      (definition.approvalPolicy === "any"
        ? round.some((approval) => approval.status === "approved")
        : round.every((approval) => approval.status === "approved"));
    if (!complete) {
      const saved = await this.repositories.workflowRuntime.save(
        instance.id,
        instance.revision,
        {
          runtime: instance.runtime,
          status: instance.status,
          actorId,
          audits: [
            {
              kind: "approval.decided",
              nodeId: node.nodeId,
              summary:
                input.decision === "approve"
                  ? `${actorId} 同意了节点“${node.name}”`
                  : `${actorId} 拒绝了节点“${node.name}”`,
              data: { decision: input.decision, note: input.note },
            },
          ],
        },
      );
      if (saved === undefined) {
        throw new ApplicationError(
          "workflow_revision_conflict",
          "Workflow instance changed concurrently",
          409,
        );
      }
      return saved;
    }
    const transition = transitionWorkflowNode({
      graph: instance.graph,
      runtime: instance.runtime,
      nodeId: node.nodeId,
      actorId,
      approvalResult: rejected ? "rejected" : "approved",
      output: input.note,
    });
    const saved = await this.saveRuntimeTransition(
      instance,
      transition,
      actorId,
      [
        {
          kind: "approval.decided",
          nodeId: node.nodeId,
          summary: rejected
            ? `审批节点“${node.name}”被拒绝`
            : `审批节点“${node.name}”通过`,
        },
      ],
    );
    return this.activateWorkflowRuntime(saved, actorId);
  }

  async pauseWorkflow(
    instanceId: string,
    input: WorkflowReasonInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    await this.assertWorkflowActor(instance.projectId, actorId);
    if (instance.status !== "active" && instance.status !== "waiting") {
      throw new ApplicationError(
        "workflow_not_pausable",
        `Workflow cannot be paused from ${instance.status}`,
        409,
      );
    }
    await this.claimWorkflowCommand(instance.id, "pause", idempotencyKey);
    const pausedAt = new Date().toISOString();
    const saved = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime: instance.runtime,
        status: "paused",
        pausedAt,
        failureReason: input.reason || null,
        actorId,
        audits: [
          {
            kind: "instance.paused",
            summary:
              input.reason === ""
                ? "工作流已暂停"
                : `工作流已暂停：${input.reason}`,
          },
        ],
      },
    );
    if (saved === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return saved;
  }

  async resumeWorkflow(
    instanceId: string,
    input: WorkflowReasonInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    await this.assertWorkflowActor(instance.projectId, actorId);
    if (instance.status !== "paused") {
      throw new ApplicationError(
        "workflow_not_paused",
        "Workflow is not paused",
        409,
      );
    }
    await this.claimWorkflowCommand(instance.id, "resume", idempotencyKey);
    const runtime = cloneRuntime(instance.runtime);
    const saved = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime,
        status: deriveWorkflowInstanceStatus(runtime),
        pausedAt: null,
        failureReason: null,
        actorId,
        audits: [
          {
            kind: "instance.resumed",
            summary:
              input.reason === ""
                ? "工作流已恢复"
                : `工作流已恢复：${input.reason}`,
          },
        ],
      },
    );
    if (saved === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return this.activateWorkflowRuntime(saved, actorId);
  }

  async retryWorkflowNode(
    instanceId: string,
    input: RetryWorkflowNodeInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    await this.assertWorkflowActor(instance.projectId, actorId);
    if (instance.graph === null) {
      throw new ApplicationError(
        "workflow_graph_missing",
        "Workflow graph is unavailable",
        409,
      );
    }
    const node = requireRuntimeNode(instance.runtime, input.nodeId);
    const definition = requireGraphNode(instance.graph, input.nodeId);
    if (!["failed", "blocked"].includes(node.status)) {
      throw new ApplicationError(
        "workflow_node_not_retryable",
        `Node cannot be retried from status ${node.status}`,
        409,
      );
    }
    if (node.attempt >= definition.maxAttempts) {
      throw new ApplicationError(
        "workflow_retry_limit_reached",
        `The node already used ${node.attempt} of ${definition.maxAttempts} attempts`,
        409,
      );
    }
    await this.claimWorkflowCommand(
      instance.id,
      `retry:${node.nodeId}:${node.visits}:${node.attempt + 1}`,
      idempotencyKey,
    );
    const runtime = cloneRuntime(instance.runtime);
    const target = requireRuntimeNode(runtime, node.nodeId);
    target.status = "ready";
    target.error = null;
    target.endedAt = null;
    const existingTask =
      target.taskId === null ? undefined : await this.getTask(target.taskId);
    const started = await this.startWorkflowNodeTask(
      instance,
      runtime,
      definition,
      actorId,
      existingTask,
    );
    const saved = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime,
        status: deriveWorkflowInstanceStatus(runtime),
        failureReason: null,
        actorId,
        audits: [
          {
            kind: "node.retried",
            nodeId: node.nodeId,
            summary: `重试节点“${node.name}”，第 ${target.attempt} 次执行`,
            data: { runId: started.runId, reason: input.reason },
          },
          {
            kind: "node.started",
            nodeId: node.nodeId,
            summary: `节点“${node.name}”重新开始执行`,
            data: { taskId: started.task.id, runId: started.runId },
          },
        ],
      },
    );
    if (saved === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return saved;
  }

  async reconcileWorkflowInstance(
    instanceId: string,
    actorId = "system",
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    if (instance.status === "paused") return instance;
    if (instance.graph === null) return instance;
    const runtime = cloneRuntime(instance.runtime);
    const audits: Array<{
      kind: WorkflowInstanceDetail["audit"][number]["kind"];
      nodeId?: string;
      summary: string;
      data?: Record<string, unknown> | null;
    }> = [];
    let changed = false;
    for (const node of runtime.nodes) {
      const definition = instance.graph.nodes.find(
        (candidate) => candidate.id === node.nodeId,
      );
      if (definition === undefined) continue;
      if (node.type === "subworkflow" && node.childInstanceId !== null) {
        const child = await this.repositories.workflowRuntime.get(
          node.childInstanceId,
        );
        if (child === undefined) continue;
        if (child.status === "completed" && node.status === "running") {
          const transition = transitionWorkflowNode({
            graph: instance.graph,
            runtime,
            nodeId: node.nodeId,
            actorId,
            output: "子流程已完成",
          });
          Object.assign(runtime, transition.runtime);
          audits.push({
            kind: "subworkflow.completed",
            nodeId: node.nodeId,
            summary: `子流程“${child.title}”已完成`,
            data: { childInstanceId: child.id },
          });
          audits.push(...transition.audit.map(toRepositoryAudit));
          changed = true;
        } else if (
          ["failed", "cancelled", "blocked"].includes(child.status) &&
          node.status === "running"
        ) {
          node.status = child.status === "blocked" ? "blocked" : "failed";
          node.error = `子流程状态：${child.status}`;
          node.endedAt = new Date().toISOString();
          audits.push({
            kind: "subworkflow.failed",
            nodeId: node.nodeId,
            summary: `子流程“${child.title}”未成功完成`,
            data: { childInstanceId: child.id, status: child.status },
          });
          changed = true;
        }
        continue;
      }
      if (node.type !== "task" || node.runId === null) continue;
      const run = await this.repositories.runs.get(node.runId);
      if (run === undefined) continue;
      if (
        node.status === "running" &&
        node.timeoutAt !== null &&
        new Date(node.timeoutAt).getTime() <= Date.now() &&
        !isTerminalRunStatus(run.status)
      ) {
        await this.repositories.runs.timeout(
          run.id,
          `Workflow node ${node.nodeId} timed out`,
        );
        await this.repositories.tasks.setStatus(run.taskId, "queued");
        node.status = "failed";
        node.error = `节点超时（${definition.timeoutSeconds} 秒）`;
        node.endedAt = new Date().toISOString();
        audits.push({
          kind: "node.timed_out",
          nodeId: node.nodeId,
          summary: `节点“${node.name}”执行超时`,
          data: { runId: run.id, attempt: node.attempt },
        });
        changed = true;
        continue;
      }
      if (
        ["failed", "timeout", "interrupted", "cancelled"].includes(
          run.status,
        ) &&
        node.status === "running"
      ) {
        node.status = "failed";
        node.error = run.error ?? `Run 状态：${run.status}`;
        node.endedAt = new Date().toISOString();
        audits.push({
          kind: run.status === "timeout" ? "node.timed_out" : "node.failed",
          nodeId: node.nodeId,
          summary: `节点“${node.name}”执行失败：${node.error}`,
          data: { runId: run.id, attempt: node.attempt },
        });
        changed = true;
        continue;
      }
      if (run.status === "completed" && node.status === "running") {
        const task = await this.getTask(run.taskId);
        if (task.status === "done") {
          const artifacts = await this.repositories.artifacts.listByRun(run.id);
          if (artifacts.length === 0) {
            node.status = "blocked";
            node.error = "Run 已完成但没有持久化交付物";
            audits.push({
              kind: "node.failed",
              nodeId: node.nodeId,
              summary: `节点“${node.name}”缺少交付物`,
            });
            changed = true;
            continue;
          }
          const transition = transitionWorkflowNode({
            graph: instance.graph,
            runtime,
            nodeId: node.nodeId,
            actorId,
            output: run.output ?? "",
          });
          Object.assign(runtime, transition.runtime);
          audits.push(...transition.audit.map(toRepositoryAudit));
          changed = true;
        }
      }
    }
    if (!changed) return instance;
    const status = deriveWorkflowInstanceStatus(runtime);
    const saved = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime,
        status,
        failureReason:
          status === "blocked" || status === "failed"
            ? (runtime.nodes.find((node) => node.error !== null)?.error ?? null)
            : null,
        actorId,
        audits: [...audits, ...instanceStatusAudit(instance.status, status)],
      },
    );
    if (saved === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return this.activateWorkflowRuntime(saved, actorId);
  }

  private async activateWorkflowRuntime(
    initial: WorkflowInstance,
    actorId: string,
  ): Promise<WorkflowInstance> {
    let instance = await this.getWorkflowInstance(initial.id);
    if (
      instance.status === "paused" ||
      instance.status === "completed" ||
      instance.status === "failed" ||
      instance.status === "cancelled" ||
      instance.status === "blocked"
    ) {
      return instance;
    }
    for (let guard = 0; guard < 200; guard += 1) {
      const graph = instance.graph;
      if (graph === null) return instance;
      const runtime = cloneRuntime(instance.runtime);
      const node = runtime.nodes.find(
        (candidate) => candidate.status === "ready",
      );
      if (node === undefined) {
        const status = deriveWorkflowInstanceStatus(runtime);
        if (status !== instance.status) {
          const saved = await this.repositories.workflowRuntime.save(
            instance.id,
            instance.revision,
            {
              runtime,
              status,
              failureReason:
                status === "blocked" || status === "failed"
                  ? (runtime.nodes.find((candidate) => candidate.error !== null)
                      ?.error ?? null)
                  : null,
              actorId,
            },
          );
          return saved ?? instance;
        }
        return instance;
      }
      const definition = requireGraphNode(graph, node.nodeId);
      if (node.type === "decision") {
        const transition = transitionWorkflowNode({
          graph,
          runtime,
          nodeId: node.nodeId,
          actorId,
        });
        const saved = await this.saveRuntimeTransition(
          instance,
          transition,
          actorId,
        );
        if (
          saved.status === "blocked" ||
          saved.status === "failed" ||
          saved.status === "completed"
        ) {
          return saved;
        }
        instance = saved;
        continue;
      }
      if (node.type === "approval") {
        const approvers = await this.resolveWorkflowApprovers(
          instance.projectId,
          definition,
        );
        if (approvers.length === 0) {
          node.status = "failed";
          node.error = "审批节点没有可用的审批人";
          node.endedAt = new Date().toISOString();
          const status = deriveWorkflowInstanceStatus(runtime);
          const saved = await this.repositories.workflowRuntime.save(
            instance.id,
            instance.revision,
            {
              runtime,
              status,
              failureReason: node.error,
              actorId,
              audits: [
                {
                  kind: "node.failed",
                  nodeId: node.nodeId,
                  summary: node.error,
                },
              ],
            },
          );
          return saved ?? instance;
        }
        node.status = "waiting_approval";
        node.startedAt ??= new Date().toISOString();
        await this.repositories.workflowRuntime.createApprovals(
          instance.id,
          node.nodeId,
          node.visits,
          approvers,
        );
        const status = deriveWorkflowInstanceStatus(runtime);
        const saved = await this.repositories.workflowRuntime.save(
          instance.id,
          instance.revision,
          {
            runtime,
            status,
            actorId,
            audits: [
              {
                kind: "approval.requested",
                nodeId: node.nodeId,
                summary: `节点“${node.name}”等待 ${approvers.length} 位审批人处理`,
                data: {
                  approvers: approvers.map((approver) => approver.actorId),
                  policy: definition.approvalPolicy,
                },
              },
            ],
          },
        );
        if (saved === undefined) {
          throw new ApplicationError(
            "workflow_revision_conflict",
            "Workflow instance changed concurrently",
            409,
          );
        }
        instance = saved;
        continue;
      }
      if (node.type === "subworkflow") {
        const childDefinition =
          await this.repositories.workflowRuntime.getDefinition(
            instance.projectId,
            definition.subworkflowKey!,
            definition.subworkflowVersion,
          );
        if (
          childDefinition?.graph === null ||
          childDefinition?.graph === undefined
        ) {
          node.status = "failed";
          node.error = `子流程不可用：${definition.subworkflowKey}`;
          const status = deriveWorkflowInstanceStatus(runtime);
          const saved = await this.repositories.workflowRuntime.save(
            instance.id,
            instance.revision,
            {
              runtime,
              status,
              failureReason: node.error,
              actorId,
              audits: [
                {
                  kind: "subworkflow.failed",
                  nodeId: node.nodeId,
                  summary: node.error,
                },
              ],
            },
          );
          return saved ?? instance;
        }
        node.status = "running";
        node.startedAt ??= new Date().toISOString();
        node.timeoutAt = timeoutAt(definition.timeoutSeconds);
        const child = await this.createWorkflowInstance({
          workflow: childDefinition,
          graph: childDefinition.graph,
          title: `${instance.title} · ${node.name}`,
          context: { ...instance.runtime.context, parentNodeId: node.nodeId },
          actorId,
          parentInstanceId: instance.id,
          parentNodeId: node.nodeId,
        });
        node.childInstanceId = child.id;
        const status = deriveWorkflowInstanceStatus(runtime);
        const saved = await this.repositories.workflowRuntime.save(
          instance.id,
          instance.revision,
          {
            runtime,
            status,
            actorId,
            audits: [
              {
                kind: "subworkflow.started",
                nodeId: node.nodeId,
                summary: `节点“${node.name}”启动子流程“${child.title}”`,
                data: { childInstanceId: child.id },
              },
            ],
          },
        );
        if (saved === undefined) {
          throw new ApplicationError(
            "workflow_revision_conflict",
            "Workflow instance changed concurrently",
            409,
          );
        }
        instance = saved;
        continue;
      }
      if (
        node.type === "task" &&
        definition.autoDispatch &&
        (definition.executor.kind === "agent" ||
          definition.executor.kind === "role")
      ) {
        const { task, runId } = await this.startWorkflowNodeTask(
          instance,
          runtime,
          definition,
          actorId,
        );
        const status = deriveWorkflowInstanceStatus(runtime);
        const saved = await this.repositories.workflowRuntime.save(
          instance.id,
          instance.revision,
          {
            runtime,
            status,
            actorId,
            audits: [
              {
                kind: "node.started",
                nodeId: node.nodeId,
                summary: `自动派发节点“${node.name}”至 Agent`,
                data: { taskId: task.id, runId },
              },
            ],
          },
        );
        if (saved === undefined) {
          throw new ApplicationError(
            "workflow_revision_conflict",
            "Workflow instance changed concurrently",
            409,
          );
        }
        instance = saved;
        continue;
      }
      return instance;
    }
    throw new ApplicationError(
      "workflow_runtime_guard_exceeded",
      "Workflow activation exceeded the deterministic step guard",
      409,
    );
  }

  private async startWorkflowNodeTask(
    instance: WorkflowInstance,
    runtime: WorkflowRuntimeState,
    definition: WorkflowGraphNode,
    actorId: string,
    existingTask?: Task,
  ): Promise<{ readonly task: Task; readonly runId: string }> {
    const node = requireRuntimeNode(runtime, definition.id);
    const assignee = await this.resolveWorkflowAgent(
      instance.projectId,
      definition,
    );
    const task =
      existingTask ??
      (await this.createTask({
        projectId: instance.projectId,
        title: `${instance.title} · ${definition.name}`,
        description: [
          `工作流节点：${definition.name}`,
          `实例：${instance.id}`,
          `上下文：${JSON.stringify(instance.runtime.context)}`,
          definition.description,
          "完成节点产出后提交任务验收，验收通过后回到工作流推进。",
        ]
          .filter(Boolean)
          .join("\n"),
        acceptance: ["完成节点交付并可供人工验收"],
        dependsOn: [],
        ...(assignee.roleId === undefined
          ? { agentId: assignee.agentId }
          : { roleId: assignee.roleId }),
      }));
    if (existingTask !== undefined) {
      await this.repositories.tasks.setStatus(task.id, "queued");
    }
    const agent = await this.repositories.agents.get(task.agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new ApplicationError(
        "agent_unavailable",
        "Workflow Agent is unavailable",
        409,
      );
    }
    node.attempt += 1;
    if (node.attempt > definition.maxAttempts) {
      throw new ApplicationError(
        "workflow_retry_limit_reached",
        `The node already used ${definition.maxAttempts} attempts`,
        409,
      );
    }
    const runId = randomUUID();
    const inputSnapshot: RunInputSnapshot = {
      taskTitle: task.title,
      taskDescription: task.description,
      acceptance: task.acceptance,
      instruction: task.description,
      agentName: agent.name,
      runtimeKind: agent.runtimeKind,
      runtimeOptions: {
        ...(definition.runtimeFault === undefined
          ? {}
          : { fault: definition.runtimeFault }),
        ...(definition.runtimeDelayMs === undefined
          ? {}
          : { delayMs: definition.runtimeDelayMs }),
      },
    };
    const deadline = timeoutAt(definition.timeoutSeconds);
    await this.repositories.runs.enqueue({
      runId,
      task,
      inputSnapshot,
      attempt: node.attempt,
      timeoutAt: deadline,
      idempotencyKey: `${instance.id}:${node.nodeId}:${node.visits}:${node.attempt}`,
      workflowInstanceId: instance.id,
      workflowNodeId: node.nodeId,
    });
    await this.repositories.runs.appendEvent(
      runId,
      "input.snapshot",
      "已保存工作流节点的运行输入快照",
      { inputSnapshot, workflowInstanceId: instance.id, nodeId: node.nodeId },
    );
    await this.repositories.taskCollaboration.appendEvent({
      taskId: task.id,
      kind: "dispatch",
      actorId,
      actorName: actorId,
      summary: `派发工作流节点“${definition.name}”第 ${node.attempt} 次执行`,
      data: { runId, instanceId: instance.id, nodeId: node.nodeId },
    });
    node.status = "running";
    node.taskId = task.id;
    node.runId = runId;
    node.startedAt ??= new Date().toISOString();
    node.timeoutAt = deadline;
    node.error = null;
    node.endedAt = null;
    return { task, runId };
  }

  private async resolveWorkflowAgent(
    projectId: string,
    node: WorkflowGraphNode,
  ): Promise<{ readonly agentId: string; readonly roleId?: string }> {
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    if (node.executor.kind === "role") {
      const member = members.find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.status === "active" &&
          candidate.roles.some((role) => role.id === node.executor.id),
      );
      if (member === undefined) {
        throw new ApplicationError(
          "workflow_role_has_no_agent",
          "The selected workflow role has no active AI member",
          409,
        );
      }
      return { agentId: member.actorId, roleId: node.executor.id };
    }
    const member = members.find(
      (candidate) =>
        candidate.kind === "agent" &&
        candidate.status === "active" &&
        candidate.actorId === node.executor.id,
    );
    const agent =
      member === undefined
        ? await this.repositories.agents.get(node.executor.id)
        : undefined;
    if (
      member === undefined &&
      (agent === undefined || agent.status !== "active")
    ) {
      throw new ApplicationError(
        "workflow_agent_unavailable",
        "The workflow Agent is not an active project member",
        409,
      );
    }
    return {
      agentId: member?.actorId ?? agent!.id,
    };
  }

  private async resolveWorkflowApprovers(
    projectId: string,
    node: WorkflowGraphNode,
  ): Promise<Array<{ readonly actorId: string; readonly roleId?: string }>> {
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const result = new Map<string, { actorId: string; roleId?: string }>();
    for (const approver of node.approvers) {
      if (approver.kind === "role") {
        for (const member of members) {
          if (
            member.kind === "human" &&
            member.status === "active" &&
            member.roles.some((role) => role.id === approver.id)
          ) {
            result.set(member.actorId, {
              actorId: member.actorId,
              roleId: approver.id,
            });
          }
        }
      } else {
        const member = members.find(
          (candidate) =>
            candidate.status === "active" && candidate.actorId === approver.id,
        );
        if (member !== undefined) {
          result.set(member.actorId, { actorId: member.actorId });
        }
      }
    }
    return [...result.values()];
  }

  private async assertWorkflowActor(
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    if (
      !members.some(
        (member) => member.status === "active" && member.actorId === actorId,
      )
    ) {
      throw new ApplicationError(
        "forbidden",
        "Only an active project member can operate this workflow",
        403,
      );
    }
  }

  private async assertWorkflowNodeActor(
    projectId: string,
    node: WorkflowGraphNode,
    actorId: string,
  ): Promise<void> {
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const member = members.find(
      (candidate) =>
        candidate.status === "active" && candidate.actorId === actorId,
    );
    if (member === undefined) {
      throw new ApplicationError(
        "forbidden",
        "Project membership required",
        403,
      );
    }
    if (node.executor.kind === "system") {
      if (!member.owner) {
        throw new ApplicationError(
          "workflow_node_forbidden",
          "System workflow nodes require the project owner",
          403,
        );
      }
      return;
    }
    if (node.executor.kind === "user" && member.actorId !== node.executor.id) {
      throw new ApplicationError(
        "workflow_node_forbidden",
        "This workflow node is assigned to another user",
        403,
      );
    }
    if (
      node.executor.kind === "role" &&
      !member.roles.some((role) => role.id === node.executor.id)
    ) {
      throw new ApplicationError(
        "workflow_node_forbidden",
        "This workflow node requires a different project role",
        403,
      );
    }
    if (node.executor.kind === "agent" && member.kind !== "agent") {
      throw new ApplicationError(
        "workflow_node_forbidden",
        "Agent-managed workflow nodes are completed through task review",
        403,
      );
    }
  }

  private async assertWorkflowDeliverable(taskId: string): Promise<void> {
    const completedRun = (await this.repositories.runs.listByTask(taskId)).find(
      (run) => run.status === "completed",
    );
    if (completedRun === undefined) {
      throw new ApplicationError(
        "workflow_gate_blocked",
        "The linked Agent run has not completed",
        409,
      );
    }
    const artifacts = await this.repositories.artifacts.listByRun(
      completedRun.id,
    );
    if (artifacts.length === 0) {
      throw new ApplicationError(
        "workflow_deliverable_missing",
        "The linked Agent task must produce a durable deliverable",
        409,
      );
    }
  }

  private async claimWorkflowCommand(
    instanceId: string,
    commandKey: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (idempotencyKey === undefined) return;
    const claimed = await this.repositories.workflowRuntime.claimCommand(
      instanceId,
      commandKey,
      idempotencyKey,
    );
    if (!claimed) {
      throw new ApplicationError(
        "workflow_duplicate_request",
        "This workflow command was already submitted",
        409,
      );
    }
  }

  private async saveRuntimeTransition(
    instance: WorkflowInstance,
    transition: ReturnType<typeof transitionWorkflowNode>,
    actorId: string,
    extraAudits: ReadonlyArray<{
      readonly kind: WorkflowInstanceDetail["audit"][number]["kind"];
      readonly nodeId?: string;
      readonly summary: string;
      readonly data?: Record<string, unknown> | null;
    }> = [],
  ): Promise<WorkflowInstance> {
    const status = deriveWorkflowInstanceStatus(transition.runtime);
    const saved = await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime: transition.runtime,
        status,
        failureReason:
          transition.blockedReason ??
          (status === "blocked" || status === "failed"
            ? (transition.runtime.nodes.find((node) => node.error !== null)
                ?.error ?? null)
            : null),
        actorId,
        audits: [
          ...transition.audit.map(toRepositoryAudit),
          ...extraAudits,
          ...instanceStatusAudit(instance.status, status),
        ],
      },
    );
    if (saved === undefined) {
      throw new ApplicationError(
        "workflow_revision_conflict",
        "Workflow instance changed concurrently",
        409,
      );
    }
    return saved;
  }

  private async workflowAncestorKeys(instanceId: string): Promise<string[]> {
    const keys: string[] = [];
    let current = await this.repositories.workflowRuntime.get(instanceId);
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      keys.push(current.definitionKey);
      current =
        current.parentInstanceId === null
          ? undefined
          : await this.repositories.workflowRuntime.get(
              current.parentInstanceId,
            );
    }
    return keys;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function graphForWorkflow(workflow: WorkflowDefinition): WorkflowGraph | null {
  if (workflow.graph !== null && workflow.graph.nodes.length > 0) {
    return workflow.graph;
  }
  if (workflow.steps.length === 0) return null;
  const nodes: WorkflowGraphNode[] = workflow.steps.map((step) => ({
    id: step.id,
    name: step.name,
    type: step.agentId === undefined ? "service" : "task",
    executor:
      step.roleId !== undefined
        ? { kind: "role", id: step.roleId }
        : step.agentId !== undefined
          ? { kind: "agent", id: step.agentId }
          : { kind: "user", id: "local-admin" },
    description: "",
    approvers: [],
    approvalPolicy: "all",
    autoDispatch: step.autoDispatch ?? false,
    start: false,
    maxAttempts: 1,
    timeoutSeconds: 300,
  }));
  return {
    key: workflow.name,
    version: 1,
    name: workflow.name,
    description: workflow.description,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${nodes[index]!.id}-${node.id}`,
      from: nodes[index]!.id,
      to: node.id,
    })),
    startNodeIds: nodes[0] === undefined ? [] : [nodes[0].id],
    warnings: [],
  };
}

function cloneRuntime(runtime: WorkflowRuntimeState): WorkflowRuntimeState {
  return {
    nodes: runtime.nodes.map((node) => ({ ...node })),
    edges: runtime.edges.map((edge) => ({ ...edge })),
    context: { ...runtime.context },
  };
}

function requireRuntimeNode(
  runtime: WorkflowRuntimeState,
  nodeId: string,
): WorkflowRuntimeNode {
  const node = runtime.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) {
    throw new ApplicationError(
      "workflow_node_not_found",
      `Workflow node not found: ${nodeId}`,
      404,
    );
  }
  return node;
}

function requireGraphNode(
  graph: WorkflowGraph,
  nodeId: string,
): WorkflowGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new ApplicationError(
      "workflow_node_not_found",
      `Workflow node not found: ${nodeId}`,
      404,
    );
  }
  return node;
}

function timeoutAt(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function toRepositoryAudit(
  audit: ReturnType<typeof transitionWorkflowNode>["audit"][number],
): {
  readonly kind: WorkflowInstanceDetail["audit"][number]["kind"];
  readonly nodeId: string;
  readonly summary: string;
} {
  return {
    kind: audit.kind,
    nodeId: audit.nodeId,
    summary: audit.message,
  };
}

function instanceStatusAudit(
  previous: WorkflowInstanceStatus,
  next: WorkflowInstanceStatus,
): ReadonlyArray<{
  readonly kind: WorkflowInstanceDetail["audit"][number]["kind"];
  readonly summary: string;
}> {
  if (previous === next) return [];
  if (next === "completed") {
    return [{ kind: "instance.completed", summary: "工作流已完成" }];
  }
  if (next === "blocked") {
    return [{ kind: "instance.blocked", summary: "工作流已阻塞" }];
  }
  if (next === "failed") {
    return [{ kind: "instance.failed", summary: "工作流执行失败" }];
  }
  if (next === "cancelled") {
    return [{ kind: "instance.cancelled", summary: "工作流已取消" }];
  }
  return [];
}

export * from "./run-executor.js";
