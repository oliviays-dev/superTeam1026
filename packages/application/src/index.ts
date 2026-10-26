import { createHash, randomUUID } from "node:crypto";
import type {
  Agent,
  AgentDetail,
  AgentEpisode,
  ApprovalSlaSweepResult,
  Artifact,
  ConfirmHandoffCardInput,
  ConvertMeetingActionItemInput,
  CosignWorkflowApprovalInput,
  CreateAgentInput,
  CreateAgentEpisodeInput,
  CreateHandoffCardInput,
  CreateMeetingActionItemInput,
  CreateMeetingInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateProjectMemberInput,
  CreateProjectInput,
  CreateProjectRoleInput,
  CreateTaskInput,
  CreateTaskMessageInput,
  CreateWorkflowInput,
  CreateSupplyExceptionInput,
  CreateSupplierRiskInput,
  CompleteWorkflowNodeInput,
  DecideWorkflowApprovalInput,
  ImportWorkflowMarkdownInput,
  IdempotencyCleanupInput,
  Job,
  JobListQuery,
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
  MeetingMemoryIngestionResult,
  MeetingTraceability,
  MemoryClaim,
  MemoryClaimTrace,
  MemoryReviewQueue,
  MemoryReviewResult,
  MemoryTopic,
  Project,
  ProjectMember,
  ProjectRole,
  ProjectTemplate,
  ProjectTemplateRevisionSummary,
  ProjectReportDetail,
  ProjectReportGenerationResult,
  ProjectReportQuery,
  ProjectReportSummary,
  PublishMemoryTruthInput,
  PublishMeetingMinutesInput,
  ReviewMemoryClaimsInput,
  CreateProjectTemplateInput,
  CreateTemplateRoleInput,
  CreateWorkflowTemplateInput,
  CopyProjectTemplateInput,
  CreateDirectChatInput,
  CreateExternalRuntimeInput,
  DirectChatDetail,
  DirectChatSendResult,
  DirectChatThread,
  DirectChatThreadListItem,
  DirectChatTurn,
  ArchiveProjectTemplateInput,
  TemplateRole,
  UpdateProjectTemplateInput,
  UpdateTemplateRoleInput,
  UpdateWorkflowTemplateInput,
  WorkflowTemplate,
  RunDetail,
  RunInputSnapshot,
  SendDirectChatMessageInput,
  RetryWorkflowNodeInput,
  StartWorkflowInput,
  Task,
  TaskDetail,
  TaskMessage,
  TaskReviewInput,
  TraceContext,
  TriggerMeetingAiInput,
  TriggerMeetingAiResult,
  TransferTaskInput,
  TransferWorkflowApprovalInput,
  UpdateAgentInput,
  UpdateHandoffCardInput,
  UpdateMemoryClaimInput,
  UpdateMeetingActionItemInput,
  UpdateMeetingAiPolicyInput,
  UpdateMeetingMinutesDraftInput,
  UpdateProjectMemberInput,
  UpdateProjectInput,
  UpdateProjectRoleInput,
  UpdateTaskInput,
  UpdateWorkbenchBriefSettingsInput,
  ValidateWorkflowMarkdownInput,
  WorkbenchSummary,
  WorkbenchBriefGenerationResult,
  WorkbenchDashboard,
  WorkbenchFollow,
  WorkbenchBrief,
  WorkbenchBriefSettings,
  SupplyException,
  SupplierRisk,
  SetWorkbenchFollowInput,
  WorkflowDefinition,
  WorkflowAuditPage,
  WorkflowAuditQuery,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowInstanceStatus,
  WorkflowReasonInput,
  WorkflowRuntimeNode,
  WorkflowRuntimeState,
  WorkflowSweepResult,
  WorkflowStepDefinition,
  WorkflowValidationResult,
  OperationsSnapshot,
  ExternalRuntime,
  ExternalRuntimeCapabilitySnapshot,
  ExternalRuntimeDetail,
  ExternalRuntimeEvent,
  ExternalRuntimeProbeRequestResult,
  ExternalRuntimeStatus,
  UpdateExternalRuntimeInput,
} from "@pluginmax/contracts";
import {
  createExternalRuntimeInputSchema,
  createRootTraceContext,
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
  shiftWorkflowDeadlines,
  TaskDependencyRuleError,
  validateWorkflowMarkdown,
  transitionWorkflowNode,
  unresolvedTaskDependencies,
  workflowRetryDelayMs,
} from "@pluginmax/domain";
import {
  DirectChatPreconditionError,
  MeetingAiPreconditionError,
  MemoryReviewConflictError,
  ProjectTemplateRepositoryError,
  type PlatformRepositories,
  type TaskAttachment,
  todayInShanghai,
} from "@pluginmax/database";
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

const implementedRuntimeKinds = new Set<Agent["runtimeKind"]>([
  "fake",
  "dsh-sdk",
]);

function requireExecutableRuntime(agent: Agent): void {
  if (agent.status !== "active") {
    throw new ApplicationError(
      "agent_unavailable",
      "The assigned agent is disabled",
      409,
    );
  }
  if (!implementedRuntimeKinds.has(agent.runtimeKind)) {
    throw new ApplicationError(
      "runtime_adapter_unavailable",
      `Runtime adapter ${agent.runtimeKind} is not available on this platform worker`,
      409,
    );
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

  createProject(
    input: CreateProjectInput,
    actorId = "local-admin",
    actorName = "Local Admin",
  ): Promise<Project> {
    return this.repositories.projects.create(input, actorId, actorName);
  }

  async createProjectFromTemplate(input: {
    readonly project: CreateProjectInput;
    readonly actorId: string;
    readonly actorName: string;
    readonly administrator: boolean;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<Project> {
    try {
      const materialized =
        await this.repositories.projectTemplates.materializeProjectTemplate({
          templateId: input.project.templateId!,
          projectName: input.project.name,
          projectCode: input.project.code,
          projectDescription: input.project.description,
          actorId: input.actorId,
          actorName: input.actorName,
          administrator: input.administrator,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        });
      return materialized.project;
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async listProjectTemplates(
    actorId: string,
    administrator: boolean,
    includeArchived = false,
  ): Promise<ProjectTemplate[]> {
    try {
      return await this.repositories.projectTemplates.listProjectTemplates({
        actorId,
        administrator,
        includeArchived,
      });
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async getProjectTemplate(
    templateId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<ProjectTemplate> {
    try {
      const template =
        await this.repositories.projectTemplates.getProjectTemplate(templateId);
      if (template === undefined) {
        throw new ApplicationError(
          "template_not_found",
          "Project template not found",
          404,
        );
      }
      if (
        !administrator &&
        (template.status !== "active" ||
          (template.accessPolicy === "selected-members" &&
            !template.allowedActorIds.includes(actorId)))
      ) {
        throw new ApplicationError(
          "template_forbidden",
          "The actor is not allowed to use this project template",
          403,
        );
      }
      return template;
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async createProjectTemplate(
    input: CreateProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    try {
      return await this.repositories.projectTemplates.createProjectTemplate(
        input,
        actorId,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async updateProjectTemplate(
    templateId: string,
    input: UpdateProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    try {
      return await this.repositories.projectTemplates.updateProjectTemplate(
        templateId,
        input,
        actorId,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async copyProjectTemplate(
    templateId: string,
    input: CopyProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    try {
      return await this.repositories.projectTemplates.copyProjectTemplate(
        templateId,
        input,
        actorId,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async archiveProjectTemplate(
    templateId: string,
    input: ArchiveProjectTemplateInput,
    actorId: string,
  ): Promise<ProjectTemplate> {
    try {
      return await this.repositories.projectTemplates.archiveProjectTemplate(
        templateId,
        input,
        actorId,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async listProjectTemplateHistory(
    templateId: string,
  ): Promise<ProjectTemplateRevisionSummary[]> {
    try {
      return await this.repositories.projectTemplates.listProjectTemplateHistory(
        templateId,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async listTemplateRoles(includeArchived = false): Promise<TemplateRole[]> {
    try {
      return await this.repositories.projectTemplates.listTemplateRoles(
        includeArchived,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async createTemplateRole(
    input: CreateTemplateRoleInput,
  ): Promise<TemplateRole> {
    try {
      return await this.repositories.projectTemplates.createTemplateRole(input);
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async updateTemplateRole(
    roleId: string,
    input: UpdateTemplateRoleInput,
  ): Promise<TemplateRole> {
    try {
      return await this.repositories.projectTemplates.updateTemplateRole(
        roleId,
        input,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async deleteTemplateRole(roleId: string): Promise<void> {
    try {
      await this.repositories.projectTemplates.deleteTemplateRole(roleId);
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async listWorkflowTemplates(
    includeArchived = false,
  ): Promise<WorkflowTemplate[]> {
    try {
      return await this.repositories.projectTemplates.listWorkflowTemplates(
        includeArchived,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async createWorkflowTemplate(
    input: CreateWorkflowTemplateInput,
  ): Promise<WorkflowTemplate> {
    try {
      return await this.repositories.projectTemplates.createWorkflowTemplate(
        input,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
  }

  async updateWorkflowTemplate(
    workflowTemplateId: string,
    input: UpdateWorkflowTemplateInput,
  ): Promise<WorkflowTemplate> {
    try {
      return await this.repositories.projectTemplates.updateWorkflowTemplate(
        workflowTemplateId,
        input,
      );
    } catch (error) {
      throw translateProjectTemplateError(error);
    }
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

    let actorId = input.actorId ?? "local-admin";
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
      if (project.status === "archived") {
        const meetings = await this.repositories.meetings.list(project.id);
        for (const meeting of meetings) {
          const policy = await this.repositories.meetingAi.getPolicy(
            meeting.id,
          );
          if (policy?.status === "active") {
            await this.repositories.meetingAi.transitionPolicy({
              id: policy.id,
              expectedRevision: policy.revision,
              status: "paused",
              actorId: "local-admin",
              reason: "project archived",
            });
          }
          await this.repositories.meetingAi.cancelOpenRuns(
            meeting.id,
            "project archived",
          );
        }
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

  createAgent(
    input: CreateAgentInput,
    actorId = "local-admin",
  ): Promise<Agent> {
    return this.repositories.agents.create(input, actorId, actorId);
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    actorId = "local-admin",
  ): Promise<AgentDetail> {
    const agent = await this.repositories.agents.update(id, input, actorId);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    if (agent.status !== "active") {
      await this.repositories.meetingAi.cancelAgentOpenRuns(
        agent.id,
        "agent disabled",
      );
      await this.repositories.directChats.cancelOpenTurnsForAgent(
        agent.id,
        "agent disabled",
      );
    }
    return this.getAgent(id);
  }

  async setAgentStatus(
    id: string,
    status: Agent["status"],
    actorId = "local-admin",
  ): Promise<AgentDetail> {
    const agent = await this.repositories.agents.setStatus(id, status, actorId);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    if (status !== "active") {
      await this.repositories.directChats.cancelOpenTurnsForAgent(
        agent.id,
        "agent disabled",
      );
    }
    return this.getAgent(id);
  }

  listExternalRuntimes(
    actorId: string,
    administrator: boolean,
    includeArchived = false,
  ): Promise<ExternalRuntime[]> {
    return this.repositories.externalRuntimes.list({
      actorId,
      administrator,
      includeArchived,
    });
  }

  async getExternalRuntime(
    runtimeId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntimeDetail> {
    const runtime = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeReadable(runtime, actorId, administrator);
    return {
      runtime,
      latestProbe:
        (await this.repositories.externalRuntimes.latestProbe(runtimeId)) ??
        null,
    };
  }

  createExternalRuntime(
    input: CreateExternalRuntimeInput,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntime> {
    if (
      !administrator &&
      input.ownerId !== undefined &&
      input.ownerId !== actorId
    ) {
      throw new ApplicationError(
        "runtime_owner_forbidden",
        "Only a platform administrator can create a runtime for another owner",
        403,
      );
    }
    const ownerId = administrator ? (input.ownerId ?? actorId) : actorId;
    return this.repositories.externalRuntimes.create(input, ownerId, actorId);
  }

  async updateExternalRuntime(
    runtimeId: string,
    input: UpdateExternalRuntimeInput,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntime> {
    const current = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeManageable(current, actorId, administrator);
    if (current.status === "archived") {
      throw new ApplicationError(
        "runtime_archived",
        "Restore the runtime before editing it",
        409,
      );
    }
    const mergedInput = createExternalRuntimeInputSchema.parse({
      name: input.name ?? current.name,
      provider: input.provider ?? current.provider,
      protocol: input.protocol ?? current.protocol,
      command: input.command ?? current.command,
      managedArgs: input.managedArgs ?? current.managedArgs,
      customArgs: input.customArgs ?? current.customArgs,
      supportedModels: input.supportedModels ?? current.supportedModels,
      defaultModel:
        input.defaultModel === undefined
          ? current.defaultModel
          : input.defaultModel,
      contextWindowTokens:
        input.contextWindowTokens === undefined
          ? current.contextWindowTokens
          : input.contextWindowTokens,
      supportedTools: input.supportedTools ?? current.supportedTools,
      networkMode: input.networkMode ?? current.networkMode,
      sandboxMode: input.sandboxMode ?? current.sandboxMode,
      visibility: input.visibility ?? current.visibility,
    });
    const merged: ExternalRuntime = {
      ...current,
      ...mergedInput,
      ownerId: current.ownerId,
    };
    const result = await this.repositories.externalRuntimes.updateDefinition({
      runtimeId,
      current,
      update: input,
      merged,
      actorId,
    });
    if (result.kind === "not_found") {
      throw new ApplicationError(
        "runtime_not_found",
        "External runtime not found",
        404,
      );
    }
    if (result.kind === "revision_conflict") {
      throw externalRuntimeRevisionConflict();
    }
    return result.runtime;
  }

  async requestExternalRuntimeProbe(
    runtimeId: string,
    expectedRevision: number,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntimeProbeRequestResult> {
    const runtime = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeManageable(runtime, actorId, administrator);
    const result = await this.repositories.externalRuntimes.requestProbe({
      runtimeId,
      expectedRevision,
      actorId,
    });
    switch (result.kind) {
      case "requested":
        return {
          runtime: result.runtime,
          probe: result.probe,
          jobId: result.jobId,
        };
      case "not_found":
        throw new ApplicationError(
          "runtime_not_found",
          "External runtime not found",
          404,
        );
      case "revision_conflict":
        throw externalRuntimeRevisionConflict();
      case "archived":
        throw new ApplicationError(
          "runtime_archived",
          "Archived runtimes cannot be probed",
          409,
        );
      case "probe_in_progress":
        throw new ApplicationError(
          "runtime_probe_in_progress",
          "A probe is already queued or running for this runtime",
          409,
        );
    }
  }

  async transitionExternalRuntime(
    runtimeId: string,
    nextStatus: ExternalRuntimeStatus,
    expectedRevision: number,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntime> {
    const runtime = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeManageable(runtime, actorId, administrator);
    const result = await this.repositories.externalRuntimes.transition({
      runtimeId,
      expectedRevision,
      nextStatus,
      actorId,
      requirePassedProbe: nextStatus === "active",
    });
    switch (result.kind) {
      case "updated":
        return result.runtime;
      case "not_found":
        throw new ApplicationError(
          "runtime_not_found",
          "External runtime not found",
          404,
        );
      case "revision_conflict":
        throw externalRuntimeRevisionConflict();
      case "invalid_transition":
        throw new ApplicationError(
          "runtime_state_conflict",
          `Runtime cannot transition from ${runtime.status} to ${nextStatus}`,
          409,
        );
      case "probe_required":
        throw new ApplicationError(
          "runtime_probe_required",
          "A successful probe for the current runtime revision is required",
          409,
        );
    }
  }

  async listExternalRuntimeEvents(
    runtimeId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntimeEvent[]> {
    const runtime = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeReadable(runtime, actorId, administrator);
    return this.repositories.externalRuntimes.listEvents(runtimeId);
  }

  async listExternalRuntimeCapabilities(
    runtimeId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<ExternalRuntimeCapabilitySnapshot[]> {
    const runtime = await this.requireExternalRuntime(runtimeId);
    assertExternalRuntimeReadable(runtime, actorId, administrator);
    return this.repositories.externalRuntimes.listCapabilities(runtimeId);
  }

  private async requireExternalRuntime(
    runtimeId: string,
  ): Promise<ExternalRuntime> {
    const runtime =
      await this.repositories.externalRuntimes.get(runtimeId);
    if (runtime === undefined) {
      throw new ApplicationError(
        "runtime_not_found",
        "External runtime not found",
        404,
      );
    }
    return runtime;
  }

  async listDirectChats(
    actorId = "local-admin",
  ): Promise<DirectChatThreadListItem[]> {
    return this.repositories.directChats.listForOwner(actorId);
  }

  async ensureDirectChat(
    input: CreateDirectChatInput,
    actorId = "local-admin",
  ): Promise<DirectChatThread> {
    try {
      return await this.repositories.directChats.ensureThread(
        actorId,
        input.agentId,
      );
    } catch (error) {
      throw directChatApplicationError(error);
    }
  }

  async getDirectChat(
    threadId: string,
    actorId = "local-admin",
  ): Promise<DirectChatDetail> {
    try {
      return await this.repositories.directChats.getDetail(threadId, actorId);
    } catch (error) {
      throw directChatApplicationError(error);
    }
  }

  async sendDirectChatMessage(
    threadId: string,
    input: SendDirectChatMessageInput,
    actorId = "local-admin",
    trace: TraceContext = createRootTraceContext(),
  ): Promise<DirectChatSendResult> {
    try {
      return await this.repositories.directChats.sendMessage(
        threadId,
        actorId,
        input,
        trace,
      );
    } catch (error) {
      throw directChatApplicationError(error);
    }
  }

  async retryDirectChatTurn(
    threadId: string,
    turnId: string,
    actorId = "local-admin",
    trace: TraceContext = createRootTraceContext(),
  ): Promise<DirectChatSendResult> {
    try {
      return await this.repositories.directChats.retryTurn(
        threadId,
        turnId,
        actorId,
        trace,
      );
    } catch (error) {
      throw directChatApplicationError(error);
    }
  }

  async cancelDirectChatTurn(
    threadId: string,
    turnId: string,
    actorId = "local-admin",
    reason = "用户取消了 AI 私聊回复",
  ): Promise<DirectChatTurn> {
    try {
      return await this.repositories.directChats.cancelTurn(
        threadId,
        turnId,
        actorId,
        reason,
      );
    } catch (error) {
      throw directChatApplicationError(error);
    }
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
    if (project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Tasks cannot be created in an archived project",
        409,
      );
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

  async transferTask(
    id: string,
    input: TransferTaskInput,
  ): Promise<TaskDetail> {
    const task = await this.getTask(id);
    const project = await this.requireProject(task.projectId);
    if (project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Tasks in an archived project cannot be transferred",
        409,
      );
    }
    if (task.status === "done" || task.status === "cancelled") {
      throw new ApplicationError(
        "task_terminal",
        "A completed or cancelled task cannot be transferred",
        409,
      );
    }
    const runs = await this.repositories.runs.listByTask(id);
    if (
      runs.some((run) =>
        ["queued", "running", "waiting_approval", "interrupted"].includes(
          run.status,
        ),
      )
    ) {
      throw new ApplicationError(
        "task_run_active",
        "A task with an active or recoverable Run cannot be transferred",
        409,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      task.projectId,
    );
    let agentId: string;
    if (input.roleId !== undefined) {
      const member = members.find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.status === "active" &&
          candidate.roles.some((role) => role.id === input.roleId),
      );
      if (member === undefined) {
        throw new ApplicationError(
          "project_role_has_no_agent",
          "The selected project role has no active AI member",
          409,
        );
      }
      agentId = member.actorId;
    } else {
      const member = members.find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.status === "active" &&
          candidate.actorId === input.agentId,
      );
      if (member === undefined) {
        throw new ApplicationError(
          "transfer_target_not_member",
          "The transfer target must be an active AI project member",
          409,
        );
      }
      agentId = member.actorId;
    }
    const agent = await this.repositories.agents.get(agentId);
    if (agent === undefined) {
      throw new ApplicationError(
        "agent_not_found",
        "Transfer target agent was not found",
        404,
      );
    }
    requireExecutableRuntime(agent);
    const updated = await this.repositories.tasks.transferAssignee(
      id,
      agentId,
      input.roleId,
    );
    if (updated === undefined) {
      throw new ApplicationError(
        "task_transfer_conflict",
        "Task state changed while the transfer was being applied",
        409,
      );
    }
    await this.repositories.taskCollaboration.appendEvent({
      taskId: id,
      kind: "transfer",
      actorId: "local-admin",
      actorName: "Local Admin",
      summary: `将任务转移给 AI 伙伴“${agent.name}”`,
      data: {
        agentId,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
      },
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

  async dispatchTask(
    taskId: string,
    trace: TraceContext = createRootTraceContext(),
  ): Promise<{ runId: string }> {
    const task = await this.getTask(taskId);
    if (!canTransitionTask(task.status, "in_progress")) {
      throw new ApplicationError(
        "invalid_task_status",
        `Task cannot be dispatched from status ${task.status}`,
        409,
      );
    }
    const project = await this.requireProject(task.projectId);
    if (project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Tasks in an archived project cannot be dispatched",
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
    requireExecutableRuntime(agent);
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
    await this.repositories.runs.enqueue({
      runId,
      task,
      inputSnapshot,
      trace,
    });
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

  async getRunDetail(
    runId: string,
    actorId = "local-admin",
  ): Promise<RunDetail> {
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) {
      throw new ApplicationError("run_not_found", "Run not found", 404);
    }
    if (!(await this.repositories.directChats.canAccessRun(runId, actorId))) {
      throw new ApplicationError(
        "direct_chat_forbidden",
        "The AI direct chat belongs to another account",
        403,
      );
    }
    const events = await this.repositories.runs.listEvents(runId);
    return { run, events };
  }

  async getRunContext(runId: string, actorId = "local-admin") {
    await this.getRunDetail(runId, actorId);
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

  async cancelRun(runId: string, actorId = "local-admin"): Promise<void> {
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) {
      throw new ApplicationError("run_not_found", "Run not found", 404);
    }
    if (!(await this.repositories.directChats.canAccessRun(runId, actorId))) {
      throw new ApplicationError(
        "direct_chat_forbidden",
        "The AI direct chat belongs to another account",
        403,
      );
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
      await this.repositories.meetingDecisions.syncTaskStatus(taskId, "queued");
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
    await this.repositories.meetingDecisions.syncTaskStatus(taskId, "done");
    await this.repositories.memory.publishTask({
      projectId: task.projectId,
      taskId: task.id,
      title: task.title,
      content: latestRun.output,
    });
    return this.getTask(taskId);
  }

  async listArtifacts(
    runId: string,
    actorId = "local-admin",
  ): Promise<Artifact[]> {
    await this.getRunDetail(runId, actorId);
    return this.repositories.artifacts.listByRun(runId);
  }

  async getArtifact(id: string, actorId = "local-admin"): Promise<Artifact> {
    const artifact = await this.repositories.artifacts.get(id);
    if (artifact === undefined) {
      throw new ApplicationError(
        "artifact_not_found",
        "Artifact not found",
        404,
      );
    }
    await this.getRunDetail(artifact.runId, actorId);
    return artifact;
  }

  async listMemory(
    projectId: string,
    actorId = "local-admin",
  ): Promise<{ readonly items: MemoryTopic[]; readonly canManage: boolean }> {
    const access = await this.requireProjectAccess(projectId, actorId);
    return {
      items: await this.repositories.memory.list(projectId),
      canManage: access.canManage,
    };
  }

  async createMemoryTopic(
    projectId: string,
    input: CreateMemoryTopicInput,
    actorId = "local-admin",
  ): Promise<MemoryTopic> {
    await this.requireActiveProjectOwner(projectId, actorId);
    return this.repositories.memory.createTopic(projectId, input);
  }

  async addMemoryClaim(
    projectId: string,
    topicId: string,
    input: CreateMemoryClaimInput,
    actorId = "local-admin",
  ): Promise<MemoryClaim> {
    await this.requireActiveProjectOwner(projectId, actorId);
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
    actorId = "local-admin",
  ): Promise<MemoryClaim> {
    await this.requireActiveProjectOwner(projectId, actorId);
    let claim: MemoryClaim | undefined;
    try {
      claim = await this.repositories.memoryClosure.updateLegacyClaimStatus({
        projectId,
        topicId,
        claimId,
        status: input.status,
        actorId,
        reason: input.reason ?? "",
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      });
    } catch (error) {
      throw this.memoryClosureError(error);
    }
    if (claim === undefined) {
      throw new ApplicationError(
        "memory_claim_not_found",
        "Memory claim not found",
        404,
      );
    }
    return claim;
  }

  async listMemoryReviews(
    projectId: string,
    actorId = "local-admin",
  ): Promise<MemoryReviewQueue> {
    const access = await this.requireProjectAccess(projectId, actorId);
    return {
      items: await this.repositories.memoryClosure.listReviewQueue(projectId),
      canManage: access.canManage,
    };
  }

  async reviewMemoryClaims(
    projectId: string,
    input: ReviewMemoryClaimsInput,
    actorId = "local-admin",
  ): Promise<MemoryReviewResult> {
    await this.requireActiveProjectOwner(projectId, actorId);
    try {
      return await this.repositories.memoryClosure.reviewClaims({
        projectId,
        actorId,
        items: input.items,
        decision: input.decision,
        reason: input.reason,
      });
    } catch (error) {
      throw this.memoryClosureError(error);
    }
  }

  async getMemoryClaimTrace(
    projectId: string,
    claimId: string,
    actorId = "local-admin",
  ): Promise<MemoryClaimTrace> {
    await this.requireProjectAccess(projectId, actorId);
    const trace = await this.repositories.memoryClosure.claimTrace(
      projectId,
      claimId,
    );
    if (trace === undefined) {
      throw new ApplicationError(
        "memory_claim_not_found",
        "Memory claim not found",
        404,
      );
    }
    return trace;
  }

  async publishMemoryTruth(
    projectId: string,
    topicId: string,
    input: PublishMemoryTruthInput,
    actorId = "local-admin",
  ): Promise<MemoryTopic> {
    await this.requireActiveProjectOwner(projectId, actorId);
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

  async ingestMeetingMinutes(
    meetingId: string,
    actorId = "local-admin",
  ): Promise<MeetingMemoryIngestionResult> {
    const detail = await this.getMeeting(meetingId, actorId);
    await this.requireActiveProjectOwner(detail.meeting.projectId, actorId);
    try {
      return await this.repositories.memoryClosure.ingestMeetingMinutes({
        meetingId,
        projectId: detail.meeting.projectId,
        actorId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "meeting memory source not available"
      ) {
        throw new ApplicationError(
          "meeting_memory_source_unavailable",
          "The meeting minutes source is unavailable",
          409,
        );
      }
      throw error;
    }
  }

  async listHandoffs(
    projectId: string,
    actorId = "local-admin",
  ): Promise<HandoffCard[]> {
    await this.requireProjectAccess(projectId, actorId);
    return this.repositories.memoryClosure.listHandoffs(projectId);
  }

  async getHandoff(
    projectId: string,
    handoffId: string,
    actorId = "local-admin",
  ): Promise<HandoffCard> {
    await this.requireProjectAccess(projectId, actorId);
    const handoff = await this.repositories.memoryClosure.getHandoff(
      projectId,
      handoffId,
    );
    if (handoff === undefined) {
      throw new ApplicationError(
        "handoff_not_found",
        "Handoff card not found",
        404,
      );
    }
    return handoff;
  }

  async createHandoff(
    projectId: string,
    input: CreateHandoffCardInput,
    actorId = "local-admin",
  ): Promise<HandoffCard> {
    await this.requireActiveProjectOwner(projectId, actorId);
    try {
      return await this.repositories.memoryClosure.createHandoff({
        projectId,
        actorId,
        data: input,
      });
    } catch (error) {
      throw this.memoryClosureError(error);
    }
  }

  async updateHandoff(
    projectId: string,
    handoffId: string,
    input: UpdateHandoffCardInput,
    actorId = "local-admin",
  ): Promise<HandoffCard> {
    await this.requireActiveProjectOwner(projectId, actorId);
    try {
      const handoff = await this.repositories.memoryClosure.updateHandoff({
        projectId,
        handoffId,
        data: input,
      });
      if (handoff === undefined) {
        throw new ApplicationError(
          "handoff_not_found",
          "Handoff card not found",
          404,
        );
      }
      return handoff;
    } catch (error) {
      throw this.memoryClosureError(error);
    }
  }

  async confirmHandoff(
    projectId: string,
    handoffId: string,
    input: ConfirmHandoffCardInput,
    actorId = "local-admin",
  ): Promise<HandoffCard> {
    await this.requireActiveProjectOwner(projectId, actorId);
    try {
      const handoff = await this.repositories.memoryClosure.confirmHandoff({
        projectId,
        handoffId,
        actorId,
        expectedVersion: input.expectedVersion,
      });
      if (handoff === undefined) {
        throw new ApplicationError(
          "handoff_not_found",
          "Handoff card not found",
          404,
        );
      }
      return handoff;
    } catch (error) {
      throw this.memoryClosureError(error);
    }
  }

  async listAgentEpisodes(
    projectId: string,
    agentId: string,
    actorId = "local-admin",
  ): Promise<AgentEpisode[]> {
    await this.requireProjectAccess(projectId, actorId);
    await this.requireProjectAgent(projectId, agentId);
    return this.repositories.memoryClosure.listEpisodes({
      projectId,
      agentId,
      actorId,
    });
  }

  async createAgentEpisode(
    projectId: string,
    input: CreateAgentEpisodeInput,
    actorId = "local-admin",
  ): Promise<AgentEpisode> {
    const access = await this.requireProjectAccess(projectId, actorId);
    if (access.project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Episodes cannot be written in an archived project",
        409,
      );
    }
    if (!access.canManage && actorId !== input.agentId) {
      throw new ApplicationError(
        "forbidden",
        "Only the project owner or the target agent can write this episode",
        403,
      );
    }
    await this.requireProjectAgent(projectId, input.agentId);
    try {
      return await this.repositories.memoryClosure.createEpisode({
        projectId,
        actorId,
        data: input,
      });
    } catch (error) {
      throw this.memoryClosureError(error);
    }
  }

  async listProjectReports(
    projectId: string,
    query: ProjectReportQuery,
    actorId: string,
  ): Promise<ProjectReportSummary[]> {
    const access = await this.requireProjectAccess(projectId, actorId);
    return this.repositories.workbenchReports.listProjectReports({
      projectId,
      actorId,
      query,
      readOnly: access.project.status === "archived",
      canGenerate: access.canManage && access.project.status === "active",
    });
  }

  async generateProjectReport(
    projectId: string,
    reportDate: string | undefined,
    actorId: string,
  ): Promise<ProjectReportGenerationResult> {
    const access = await this.requireProjectAccess(projectId, actorId);
    if (access.project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Reports cannot be generated for an archived project",
        409,
      );
    }
    if (!access.canManage) {
      throw new ApplicationError(
        "forbidden",
        "Project owner permission is required to generate reports",
        403,
      );
    }
    const result =
      await this.repositories.workbenchReports.generateProjectReport({
        projectId,
        reportDate: reportDate ?? todayInShanghai(),
        actorId,
      });
    return {
      ...result,
      report: {
        ...result.report,
        readOnly: false,
        canGenerate: true,
      },
    };
  }

  async getProjectReport(
    projectId: string,
    reportId: string,
    actorId: string,
  ): Promise<ProjectReportDetail> {
    const access = await this.requireProjectAccess(projectId, actorId);
    const report = await this.repositories.workbenchReports.getProjectReport(
      projectId,
      reportId,
      actorId,
    );
    if (report === undefined) {
      throw new ApplicationError(
        "project_report_not_found",
        "Project report not found",
        404,
      );
    }
    return {
      ...report,
      readOnly: access.project.status === "archived",
      canGenerate: access.canManage && access.project.status === "active",
    };
  }

  async markProjectReportRead(
    projectId: string,
    reportId: string,
    actorId: string,
    read: boolean,
  ): Promise<{ readonly reportId: string; readonly read: boolean }> {
    await this.requireProjectAccess(projectId, actorId);
    const updated =
      await this.repositories.workbenchReports.markProjectReportRead({
        projectId,
        reportId,
        actorId,
        read,
      });
    if (!updated) {
      throw new ApplicationError(
        "project_report_not_found",
        "Project report not found",
        404,
      );
    }
    return { reportId, read };
  }

  async getWorkbenchDashboard(actorId: string): Promise<WorkbenchDashboard> {
    return this.repositories.workbenchReports.dashboard(actorId);
  }

  async refreshWorkbenchBrief(
    actorId: string,
    briefDate?: string,
  ): Promise<WorkbenchBriefGenerationResult> {
    return this.repositories.workbenchReports.generateWorkbenchBrief({
      actorId,
      briefDate: briefDate ?? todayInShanghai(),
    });
  }

  async getLatestWorkbenchBrief(actorId: string): Promise<WorkbenchBrief> {
    const brief =
      await this.repositories.workbenchReports.getLatestBrief(actorId);
    if (brief === null) {
      const generated =
        await this.repositories.workbenchReports.generateWorkbenchBrief({
          actorId,
          briefDate: todayInShanghai(),
        });
      return generated.brief;
    }
    return brief;
  }

  async markWorkbenchBriefRead(
    actorId: string,
    briefId: string,
    read: boolean,
  ): Promise<{ readonly briefId: string; readonly read: boolean }> {
    const updated = await this.repositories.workbenchReports.markBriefRead({
      actorId,
      briefId,
      read,
    });
    if (!updated) {
      throw new ApplicationError(
        "workbench_brief_not_found",
        "Workbench brief not found",
        404,
      );
    }
    return { briefId, read };
  }

  async getWorkbenchBriefSettings(
    actorId: string,
  ): Promise<WorkbenchBriefSettings> {
    return this.repositories.workbenchReports.getBriefSettings(actorId);
  }

  async updateWorkbenchBriefSettings(
    actorId: string,
    input: UpdateWorkbenchBriefSettingsInput,
  ): Promise<WorkbenchBriefSettings> {
    return this.repositories.workbenchReports.updateBriefSettings(
      actorId,
      input,
    );
  }

  async listWorkbenchFollows(actorId: string): Promise<WorkbenchFollow[]> {
    return this.repositories.workbenchReports.listFollows(actorId);
  }

  async setWorkbenchFollow(
    actorId: string,
    input: SetWorkbenchFollowInput,
  ): Promise<{ readonly followed: boolean }> {
    const access = await this.requireProjectAccess(input.projectId, actorId);
    const belongs =
      await this.repositories.workbenchReports.resourceBelongsToProject(
        input.projectId,
        input.targetType,
        input.targetId,
      );
    if (!belongs) {
      throw new ApplicationError(
        "follow_target_not_found",
        "The follow target does not belong to this project",
        404,
      );
    }
    if (input.followed && access.project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Follows cannot be added in an archived project",
        409,
      );
    }
    const followed = await this.repositories.workbenchReports.setFollow(
      actorId,
      input,
    );
    return { followed };
  }

  async listSupplyExceptions(
    projectId: string,
    actorId: string,
  ): Promise<SupplyException[]> {
    await this.requireProjectAccess(projectId, actorId);
    return this.repositories.workbenchReports.listSupplyExceptions([projectId]);
  }

  async createSupplyException(
    input: CreateSupplyExceptionInput,
    actorId: string,
  ): Promise<SupplyException> {
    const access = await this.requireProjectAccess(input.projectId, actorId);
    if (access.project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Supply exceptions cannot be created in an archived project",
        409,
      );
    }
    if (!access.canManage) {
      throw new ApplicationError(
        "forbidden",
        "Project owner permission is required to create supply exceptions",
        403,
      );
    }
    if (
      input.sourceTaskId !== undefined &&
      input.sourceTaskId !== null &&
      !(await this.repositories.workbenchReports.resourceBelongsToProject(
        input.projectId,
        "task",
        input.sourceTaskId,
      ))
    ) {
      throw new ApplicationError(
        "supply_source_not_found",
        "The source task does not belong to this project",
        404,
      );
    }
    if (
      input.sourceWorkflowInstanceId !== undefined &&
      input.sourceWorkflowInstanceId !== null &&
      !(await this.repositories.workbenchReports.resourceBelongsToProject(
        input.projectId,
        "workflow",
        input.sourceWorkflowInstanceId,
      ))
    ) {
      throw new ApplicationError(
        "supply_source_not_found",
        "The source workflow does not belong to this project",
        404,
      );
    }
    return this.repositories.workbenchReports.createSupplyException(
      actorId,
      input,
    );
  }

  async listSupplierRisks(
    projectId: string,
    actorId: string,
  ): Promise<SupplierRisk[]> {
    await this.requireProjectAccess(projectId, actorId);
    return this.repositories.workbenchReports.listSupplierRisks([projectId]);
  }

  async createSupplierRisk(
    input: CreateSupplierRiskInput,
    actorId: string,
  ): Promise<SupplierRisk> {
    const access = await this.requireProjectAccess(input.projectId, actorId);
    if (access.project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Supplier risks cannot be created in an archived project",
        409,
      );
    }
    if (!access.canManage) {
      throw new ApplicationError(
        "forbidden",
        "Project owner permission is required to create supplier risks",
        403,
      );
    }
    return this.repositories.workbenchReports.createSupplierRisk(
      actorId,
      input,
    );
  }

  async getWorkbench(): Promise<WorkbenchSummary> {
    return this.repositories.workbench.summary();
  }

  async getOperationsSnapshot(input: {
    readonly expectedMigrationVersion: number;
    readonly workerHeartbeatStaleAfterSeconds: number;
  }): Promise<OperationsSnapshot> {
    const [
      metrics,
      workers,
      deadLetters,
      approvalSlaOverdue,
      maintenanceSchedules,
      maintenanceTrend,
      runtimeEffects,
    ] = await Promise.all([
      this.repositories.runtimeReliability.getMetrics(input),
      this.repositories.runtimeReliability.listWorkers(
        input.workerHeartbeatStaleAfterSeconds,
      ),
      this.repositories.jobs.list({ status: "dead_letter", limit: 20 }),
      this.repositories.runtimeReliability.listApprovalSlaOverdue(20),
      this.repositories.runtimeReliability.listMaintenanceSchedules(),
      this.repositories.runtimeReliability.listRecentMaintenance(20),
      this.repositories.runtimeEffects.listRecent(20),
    ]);
    return {
      metrics,
      workers,
      deadLetters,
      approvalSlaOverdue,
      maintenanceSchedules,
      maintenanceTrend,
      runtimeEffects,
    };
  }

  async listJobs(query: JobListQuery): Promise<Job[]> {
    return this.repositories.jobs.list({
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  }

  async recoverDeadLetterJob(
    jobId: string,
    reason: string,
    actorId: string,
  ): Promise<Job> {
    const job = await this.repositories.jobs.get(jobId);
    if (job === undefined) {
      throw new ApplicationError("job_not_found", "Job not found", 404);
    }
    if (job.status !== "dead_letter" && job.status !== "failed") {
      throw new ApplicationError(
        "job_not_recoverable",
        `Job cannot be recovered from status ${job.status}`,
        409,
      );
    }
    const recovered = await this.repositories.jobs.recoverDeadLetter(
      jobId,
      actorId,
      reason,
    );
    if (recovered === undefined) {
      throw new ApplicationError(
        "job_recovery_conflict",
        "Job changed concurrently and could not be recovered",
        409,
      );
    }
    return recovered;
  }

  cleanupIdempotencyReceipts(
    input: IdempotencyCleanupInput,
    options: {
      readonly triggerSource?: "scheduler" | "manual" | "api" | "legacy";
      readonly scheduledFor?: Date;
      readonly trace?: TraceContext;
    } = {},
  ) {
    return this.repositories.runtimeReliability.cleanupIdempotencyReceipts(
      input,
      options,
    );
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.repositories.projects.get(projectId);
    if (project === undefined) {
      throw new ApplicationError("project_not_found", "Project not found", 404);
    }
    return project;
  }

  private async requireProjectAccess(
    projectId: string,
    actorId: string,
  ): Promise<{ readonly project: Project; readonly canManage: boolean }> {
    const project = await this.requireProject(projectId);
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const member = members.find(
      (candidate) =>
        candidate.actorId === actorId && candidate.status === "active",
    );
    if (member === undefined) {
      throw new ApplicationError(
        "forbidden",
        "Active project membership is required",
        403,
      );
    }
    return {
      project,
      canManage: member.kind === "human" && member.owner,
    };
  }

  private async requireProjectAgent(
    projectId: string,
    agentId: string,
  ): Promise<Agent> {
    const agent = await this.repositories.agents.get(agentId, true);
    if (agent === undefined || agent.status !== "active") {
      throw new ApplicationError(
        "agent_unavailable",
        "The target agent is unavailable",
        409,
      );
    }
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const member = members.find(
      (candidate) =>
        candidate.kind === "agent" &&
        candidate.actorId === agentId &&
        candidate.status === "active",
    );
    if (member === undefined) {
      throw new ApplicationError(
        "project_agent_scope_mismatch",
        "The target agent is not an active member of this project",
        409,
      );
    }
    return agent;
  }

  private memoryClosureError(error: unknown): Error {
    if (error instanceof ApplicationError) return error;
    if (error instanceof MemoryReviewConflictError) {
      if (error.message === "project archived") {
        return new ApplicationError(
          "project_archived",
          "The project is archived",
          409,
        );
      }
      if (error.message === "memory review scope mismatch") {
        return new ApplicationError(
          "memory_claim_not_found",
          "One or more memory claims are outside this project",
          404,
        );
      }
      if (error.message === "memory review conflict") {
        return new ApplicationError(
          "memory_review_conflict",
          "Memory claims changed after this review was loaded",
          409,
          error.details,
        );
      }
      if (error.message === "handoff is confirmed") {
        return new ApplicationError(
          "handoff_confirmed",
          "Confirmed handoff cards cannot be modified",
          409,
        );
      }
      if (error.message === "handoff version conflict") {
        return new ApplicationError(
          "handoff_version_conflict",
          "The handoff card changed before this request completed",
          409,
        );
      }
    }
    if (
      error instanceof Error &&
      error.message === "cross project source reference"
    ) {
      return new ApplicationError(
        "source_project_mismatch",
        "All source references must belong to this project",
        409,
      );
    }
    if (
      error instanceof Error &&
      (error.message === "handoff source not available" ||
        error.message === "meeting memory source not available")
    ) {
      return new ApplicationError(
        "source_unavailable",
        "A source reference is unavailable",
        409,
      );
    }
    return error instanceof Error
      ? error
      : new Error("Memory operation failed");
  }

  private async requireProjectOwner(
    projectId: string,
    actorId = "local-admin",
  ): Promise<void> {
    await this.requireProject(projectId);
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const owner = members.some(
      (member) =>
        member.kind === "human" &&
        member.actorId === actorId &&
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

  private async requireActiveProjectOwner(
    projectId: string,
    actorId = "local-admin",
  ): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "The project is archived",
        409,
      );
    }
    await this.requireProjectOwner(projectId, actorId);
    return project;
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

  async listWorkflowAudit(
    query: WorkflowAuditQuery,
  ): Promise<WorkflowAuditPage> {
    await this.requireProject(query.projectId);
    if (query.instanceId !== undefined) {
      const instance = await this.getWorkflowInstance(query.instanceId);
      if (instance.projectId !== query.projectId) {
        throw new ApplicationError(
          "workflow_instance_scope_mismatch",
          "Workflow instance does not belong to the requested project",
          404,
        );
      }
    }
    return this.repositories.workflowRuntime.listAuditPage(query);
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
    if (node.type !== "approval") {
      throw new ApplicationError(
        "workflow_approval_not_pending",
        "The node is not an approval node",
        409,
      );
    }
    await this.assertWorkflowActor(instance.projectId, actorId);
    const expectedStatus =
      input.decision === "approve" ? "approved" : "rejected";
    if (node.status !== "waiting_approval") {
      const existing = (
        await this.repositories.workflowRuntime.listApprovals(instanceId)
      ).find(
        (approval) =>
          approval.nodeId === node.nodeId &&
          approval.round === node.visits &&
          approval.approverId === actorId,
      );
      if (existing?.status === expectedStatus) return instance;
      throw new ApplicationError(
        "workflow_approval_not_pending",
        "The node is not waiting for approval",
        409,
      );
    }
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
      const existing = (
        await this.repositories.workflowRuntime.listApprovals(instanceId)
      ).find(
        (approval) =>
          approval.nodeId === node.nodeId &&
          approval.round === node.visits &&
          approval.approverId === actorId,
      );
      if (existing?.status === expectedStatus) {
        return this.getWorkflowInstance(instanceId);
      }
      if (existing !== undefined) {
        throw new ApplicationError(
          "workflow_approval_already_decided",
          "This approval was already decided",
          409,
        );
      }
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
    const activeRound = round.filter(
      (approval) => approval.status !== "transferred",
    );
    const rejected = activeRound.some(
      (approval) => approval.status === "rejected",
    );
    const definition = requireGraphNode(instance.graph, node.nodeId);
    const complete =
      rejected ||
      (definition.approvalPolicy === "any"
        ? activeRound.some((approval) => approval.status === "approved")
        : activeRound.length > 0 &&
          activeRound.every((approval) => approval.status === "approved"));
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
        return this.resolveWorkflowApprovalConflict({
          instanceId,
          nodeId: node.nodeId,
          round: node.visits,
          actorId,
          decision: input.decision,
          note: input.note,
        });
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
    try {
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
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === "workflow_revision_conflict"
      ) {
        return this.resolveWorkflowApprovalConflict({
          instanceId,
          nodeId: node.nodeId,
          round: node.visits,
          actorId,
          decision: input.decision,
          note: input.note,
        });
      }
      throw error;
    }
  }

  async transferWorkflowApproval(
    instanceId: string,
    input: TransferWorkflowApprovalInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.requirePendingApproval(
      instanceId,
      input.nodeId,
    );
    await this.assertWorkflowActor(instance.projectId, actorId);
    if (input.targetActorId === actorId) {
      throw new ApplicationError(
        "workflow_approval_transfer_self",
        "An approval cannot be transferred to the same actor",
        409,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      instance.projectId,
    );
    const target = members.find(
      (member) =>
        member.kind === "human" &&
        member.status === "active" &&
        member.actorId === input.targetActorId,
    );
    if (target === undefined) {
      throw new ApplicationError(
        "workflow_approval_target_forbidden",
        "The transfer target must be an active human project member",
        403,
      );
    }
    await this.claimWorkflowCommand(
      instance.id,
      `approval-transfer:${input.nodeId}:${actorId}`,
      idempotencyKey,
    );
    const node = requireRuntimeNode(instance.runtime, input.nodeId);
    const result = await this.repositories.workflowRuntime.transferApproval({
      instanceId,
      nodeId: node.nodeId,
      round: node.visits,
      fromActorId: actorId,
      toActorId: target.actorId,
      note: input.note,
      ...(target.roles[0] === undefined
        ? {}
        : { toRoleId: target.roles[0].id }),
    });
    if (result === "not_approver") {
      throw new ApplicationError(
        "workflow_approval_forbidden",
        "Only a pending approver can transfer this approval",
        403,
      );
    }
    if (result === "target_terminal") {
      throw new ApplicationError(
        "workflow_approval_target_terminal",
        "The target already completed this approval round",
        409,
      );
    }
    await this.repositories.workflowRuntime.appendAudit(instance.id, actorId, {
      kind: "approval.transferred",
      nodeId: node.nodeId,
      summary: `审批“${node.name}”已转交给 ${target.name}`,
      data: {
        fromActorId: actorId,
        toActorId: target.actorId,
        note: input.note,
      },
    });
    return this.getWorkflowInstance(instance.id);
  }

  async cosignWorkflowApproval(
    instanceId: string,
    input: CosignWorkflowApprovalInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.requirePendingApproval(
      instanceId,
      input.nodeId,
    );
    if (instance.graph === null) {
      throw new ApplicationError(
        "workflow_graph_missing",
        "Workflow graph is unavailable",
        409,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      instance.projectId,
    );
    const actor = members.find(
      (member) => member.status === "active" && member.actorId === actorId,
    );
    if (actor === undefined) {
      throw new ApplicationError(
        "forbidden",
        "Only an active project member can add approvers",
        403,
      );
    }
    const node = requireRuntimeNode(instance.runtime, input.nodeId);
    const approvals =
      await this.repositories.workflowRuntime.listApprovals(instanceId);
    const actorApproval = approvals.find(
      (approval) =>
        approval.nodeId === node.nodeId &&
        approval.round === node.visits &&
        approval.approverId === actorId &&
        approval.status === "pending",
    );
    if (!actor.owner && actorApproval === undefined) {
      throw new ApplicationError(
        "workflow_approval_forbidden",
        "Only a project owner or pending approver can add approvers",
        403,
      );
    }
    await this.claimWorkflowCommand(
      instance.id,
      `approval-cosign:${input.nodeId}:${actorId}:${JSON.stringify(input.approvers)}`,
      idempotencyKey,
    );
    const definition = requireGraphNode(instance.graph, node.nodeId);
    const resolved = await this.resolveWorkflowApprovers(instance.projectId, {
      ...definition,
      approvers: input.approvers,
    });
    if (resolved.length === 0) {
      throw new ApplicationError(
        "workflow_cosign_target_unavailable",
        "No active human approver matches the co-sign request",
        409,
      );
    }
    await this.repositories.workflowRuntime.createApprovals(
      instance.id,
      node.nodeId,
      node.visits,
      resolved.map((approver) => ({
        actorId: approver.actorId,
        ...(approver.roleId === undefined ? {} : { roleId: approver.roleId }),
        kind: "cosign" as const,
        delegatedFrom: actorId,
      })),
    );
    await this.repositories.workflowRuntime.appendAudit(instance.id, actorId, {
      kind: "approval.cosigned",
      nodeId: node.nodeId,
      summary: `为审批“${node.name}”增加 ${resolved.length} 位审批人`,
      data: {
        approvers: resolved.map((approver) => approver.actorId),
        note: input.note,
      },
    });
    return this.getWorkflowInstance(instance.id);
  }

  async pauseWorkflow(
    instanceId: string,
    input: WorkflowReasonInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    await this.assertWorkflowOwner(instance.projectId, actorId);
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
    await this.assertWorkflowOwner(instance.projectId, actorId);
    if (instance.status !== "paused") {
      throw new ApplicationError(
        "workflow_not_paused",
        "Workflow is not paused",
        409,
      );
    }
    await this.claimWorkflowCommand(instance.id, "resume", idempotencyKey);
    const pausedMs =
      instance.pausedAt === null
        ? 0
        : Math.max(0, Date.now() - new Date(instance.pausedAt).getTime());
    const runtime = shiftWorkflowDeadlines(instance.runtime, pausedMs);
    await this.repositories.runs.extendWorkflowDeadlines(instance.id, pausedMs);
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
    await this.assertWorkflowOwner(instance.projectId, actorId);
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
    target.nextRetryAt = null;
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
      if (run.taskId === null) {
        throw new Error("workflow task run is missing its task id");
      }
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
        audits.push(
          ...this.recordWorkflowNodeFailure({
            node,
            definition,
            error: `节点超时（${definition.timeoutSeconds} 秒）`,
            kind: "node.timed_out",
            runId: run.id,
          }),
        );
        changed = true;
        continue;
      }
      if (
        ["failed", "timeout", "interrupted", "cancelled"].includes(
          run.status,
        ) &&
        node.status === "running"
      ) {
        audits.push(
          ...this.recordWorkflowNodeFailure({
            node,
            definition,
            error: run.error ?? `Run 状态：${run.status}`,
            kind: run.status === "timeout" ? "node.timed_out" : "node.failed",
            runId: run.id,
          }),
        );
        changed = true;
        continue;
      }
      if (run.status === "completed" && node.status === "running") {
        const task = await this.getTask(run.taskId);
        if (task.status === "done") {
          const artifacts = await this.repositories.artifacts.listByRun(run.id);
          if (artifacts.length === 0) {
            audits.push(
              ...this.recordWorkflowNodeFailure({
                node,
                definition,
                error: "Run 已完成但没有持久化交付物",
                kind: "node.failed",
                runId: run.id,
              }),
            );
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
    for (const node of runtime.nodes) {
      if (
        node.status !== "failed" ||
        node.nextRetryAt === null ||
        node.nextRetryAt === undefined ||
        new Date(node.nextRetryAt).getTime() > Date.now()
      ) {
        continue;
      }
      const definition = instance.graph.nodes.find(
        (candidate) => candidate.id === node.nodeId,
      );
      if (definition === undefined) continue;
      node.status = "ready";
      node.error = null;
      node.endedAt = null;
      node.nextRetryAt = null;
      audits.push({
        kind: "node.recovered",
        nodeId: node.nodeId,
        summary: `节点“${node.name}”到达重试时间并恢复`,
        data: {
          runId: node.runId,
          failureCount: node.failureCount ?? 0,
          attempt: node.attempt,
        },
      });
      if (
        node.type === "task" &&
        (definition.executor.kind === "agent" ||
          definition.executor.kind === "role")
      ) {
        const existingTask =
          node.taskId === null ? undefined : await this.getTask(node.taskId);
        const started = await this.startWorkflowNodeTask(
          instance,
          runtime,
          definition,
          actorId,
          existingTask,
        );
        audits.push({
          kind: "node.retried",
          nodeId: node.nodeId,
          summary: `节点“${node.name}”自动重试，第 ${node.attempt} 次执行`,
          data: { runId: started.runId, taskId: started.task.id },
        });
      }
      changed = true;
    }
    if (!changed) {
      await this.repositories.workflowRuntime.touchReconciled(instanceId);
      return instance;
    }
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

  private recordWorkflowNodeFailure(input: {
    readonly node: WorkflowRuntimeNode;
    readonly definition: WorkflowGraphNode;
    readonly error: string;
    readonly kind: "node.timed_out" | "node.failed";
    readonly runId: string;
  }): Array<{
    readonly kind: "node.timed_out" | "node.failed" | "node.retry_scheduled";
    readonly nodeId: string;
    readonly summary: string;
    readonly data: Record<string, unknown>;
  }> {
    const { node, definition } = input;
    node.status = "failed";
    node.error = input.error;
    node.endedAt = new Date().toISOString();
    node.failureCount = (node.failureCount ?? 0) + 1;
    const retryable =
      node.failureCount < definition.maxAttempts &&
      node.attempt < definition.maxAttempts;
    node.nextRetryAt = retryable
      ? new Date(
          Date.now() +
            workflowRetryDelayMs(
              node.failureCount,
              definition.retryBackoffSeconds,
            ),
        ).toISOString()
      : null;
    return [
      {
        kind: input.kind,
        nodeId: node.nodeId,
        summary:
          input.kind === "node.timed_out"
            ? `节点“${node.name}”执行超时`
            : `节点“${node.name}”执行失败：${input.error}`,
        data: {
          runId: input.runId,
          attempt: node.attempt,
          failureCount: node.failureCount,
          retryAt: node.nextRetryAt,
        },
      },
      ...(retryable
        ? [
            {
              kind: "node.retry_scheduled" as const,
              nodeId: node.nodeId,
              summary: `节点“${node.name}”计划于 ${node.nextRetryAt} 自动重试`,
              data: {
                retryAt: node.nextRetryAt,
                failureCount: node.failureCount,
              },
            },
          ]
        : []),
    ];
  }

  private async resolveWorkflowApprovalConflict(input: {
    readonly instanceId: string;
    readonly nodeId: string;
    readonly round: number;
    readonly actorId: string;
    readonly decision: "approve" | "reject";
    readonly note: string;
  }): Promise<WorkflowInstance> {
    const expectedStatus =
      input.decision === "approve" ? "approved" : "rejected";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getWorkflowInstance(input.instanceId);
      const approvals = await this.repositories.workflowRuntime.listApprovals(
        input.instanceId,
      );
      const actorApproval = approvals.find(
        (approval) =>
          approval.nodeId === input.nodeId &&
          approval.round === input.round &&
          approval.approverId === input.actorId,
      );
      if (actorApproval?.status !== expectedStatus) {
        throw new ApplicationError(
          "workflow_approval_already_decided",
          "This approval round changed concurrently",
          409,
        );
      }
      const node = requireRuntimeNode(current.runtime, input.nodeId);
      if (node.status !== "waiting_approval" || current.graph === null) {
        return current;
      }
      const activeRound = approvals.filter(
        (approval) =>
          approval.nodeId === input.nodeId &&
          approval.round === input.round &&
          approval.status !== "transferred",
      );
      const rejected = activeRound.some(
        (approval) => approval.status === "rejected",
      );
      const definition = requireGraphNode(current.graph, input.nodeId);
      const complete =
        rejected ||
        (definition.approvalPolicy === "any"
          ? activeRound.some((approval) => approval.status === "approved")
          : activeRound.length > 0 &&
            activeRound.every((approval) => approval.status === "approved"));
      if (!complete) return current;
      const transition = transitionWorkflowNode({
        graph: current.graph,
        runtime: current.runtime,
        nodeId: input.nodeId,
        actorId: input.actorId,
        approvalResult: rejected ? "rejected" : "approved",
        output: input.note,
      });
      try {
        const saved = await this.saveRuntimeTransition(
          current,
          transition,
          input.actorId,
          [
            {
              kind: "approval.decided",
              nodeId: input.nodeId,
              summary: rejected
                ? `审批节点“${node.name}”被拒绝`
                : `审批节点“${node.name}”通过`,
              data: { concurrentResolution: true },
            },
          ],
        );
        return this.activateWorkflowRuntime(saved, input.actorId);
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.code !== "workflow_revision_conflict"
        ) {
          throw error;
        }
      }
    }
    throw new ApplicationError(
      "workflow_revision_conflict",
      "Workflow instance changed concurrently",
      409,
    );
  }

  async sweepWorkflowInstances(
    owner: string,
    options: {
      readonly batchSize?: number;
      readonly leaseSeconds?: number;
      readonly staleAfterSeconds?: number;
    } = {},
  ): Promise<WorkflowSweepResult> {
    const instanceIds =
      await this.repositories.workflowRuntime.claimReconcileCandidates({
        owner,
        limit: options.batchSize ?? 20,
        leaseSeconds: options.leaseSeconds ?? 30,
        staleAfterSeconds: options.staleAfterSeconds ?? 2,
      });
    let reconciled = 0;
    let skipped = 0;
    let failed = 0;
    for (const instanceId of instanceIds) {
      try {
        await this.reconcileWorkflowInstance(instanceId, `sweep:${owner}`);
        reconciled += 1;
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === "workflow_revision_conflict"
        ) {
          skipped += 1;
        } else {
          failed += 1;
        }
      } finally {
        await this.repositories.workflowRuntime.releaseReconcileLease(
          instanceId,
          owner,
        );
      }
    }
    return {
      claimed: instanceIds.length,
      reconciled,
      skipped,
      failed,
    };
  }

  async sweepApprovalSla(
    actorId: string,
    batchSize = 100,
    options: {
      readonly triggerSource?: "scheduler" | "manual" | "api" | "legacy";
      readonly scheduledFor?: Date;
      readonly trace?: TraceContext;
    } = {},
  ): Promise<ApprovalSlaSweepResult> {
    const startedAt = new Date();
    const affectedInstances = new Set<string>();
    let reminded = 0;
    let escalated = 0;
    let expired = 0;
    try {
      const reminders =
        await this.repositories.workflowRuntime.remindDueApprovals(batchSize);
      for (const group of reminders) {
        reminded += group.count;
        affectedInstances.add(group.instanceId);
        await this.repositories.workflowRuntime.appendAudit(
          group.instanceId,
          actorId,
          {
            kind: "approval.reminded",
            nodeId: group.nodeId,
            summary: `审批 SLA 即将到期，已提醒 ${group.count} 位审批人`,
            data: {
              round: group.round,
              count: group.count,
              policy: "approval_reminder",
            },
          },
        );
      }
      const escalations =
        await this.repositories.workflowRuntime.escalateDueApprovals(batchSize);
      for (const group of escalations) {
        escalated += Math.max(1, group.count);
        affectedInstances.add(group.instanceId);
        await this.repositories.workflowRuntime.appendAudit(
          group.instanceId,
          actorId,
          {
            kind: "approval.escalated",
            nodeId: group.nodeId,
            summary: group.escalationRoleId
              ? `审批已超时，升级至项目角色 ${group.escalationRoleId}`
              : "审批已超时并执行角色升级",
            data: {
              round: group.round,
              count: group.count,
              escalationRoleId: group.escalationRoleId ?? null,
            },
          },
        );
      }
      const expirations =
        await this.repositories.workflowRuntime.expireDueApprovals(batchSize);
      for (const group of expirations) {
        expired += group.count;
        affectedInstances.add(group.instanceId);
        await this.resolveExpiredApproval(group, actorId);
      }
      const result = {
        reminded,
        escalated,
        expired,
        affectedInstances: affectedInstances.size,
      };
      if (reminded + escalated + expired > 0) {
        await this.repositories.runtimeReliability.recordMaintenance({
          kind: "approval_sla",
          status: "completed",
          processedCount: reminded + escalated + expired,
          metrics: result,
          triggerSource: options.triggerSource ?? "manual",
          ...(options.scheduledFor === undefined
            ? {}
            : { scheduledFor: options.scheduledFor }),
          ...(options.trace === undefined ? {} : { trace: options.trace }),
          startedAt,
        });
      }
      return result;
    } catch (error) {
      await this.repositories.runtimeReliability.recordMaintenance({
        kind: "approval_sla",
        status: "failed",
        processedCount: reminded + escalated + expired,
        error: error instanceof Error ? error.message : String(error),
        metrics: {
          reminded,
          escalated,
          expired,
          affectedInstances: affectedInstances.size,
        },
        triggerSource: options.triggerSource ?? "manual",
        ...(options.scheduledFor === undefined
          ? {}
          : { scheduledFor: options.scheduledFor }),
        ...(options.trace === undefined ? {} : { trace: options.trace }),
        startedAt,
      });
      throw error;
    }
  }

  private async resolveExpiredApproval(
    group: {
      readonly instanceId: string;
      readonly nodeId: string;
      readonly round: number;
      readonly count: number;
    },
    actorId: string,
  ): Promise<void> {
    const instance = await this.getWorkflowInstance(group.instanceId);
    if (instance.graph === null) return;
    const node = instance.runtime.nodes.find(
      (candidate) => candidate.nodeId === group.nodeId,
    );
    if (
      node === undefined ||
      node.status !== "waiting_approval" ||
      node.visits !== group.round
    ) {
      return;
    }
    const definition = requireGraphNode(instance.graph, node.nodeId);
    const action = definition.approvalExpireAction ?? "reject";
    if (action === "block") {
      const runtime = cloneRuntime(instance.runtime);
      const runtimeNode = requireRuntimeNode(runtime, node.nodeId);
      runtimeNode.status = "blocked";
      runtimeNode.error = "审批已超过 SLA 截止时间";
      runtimeNode.endedAt = new Date().toISOString();
      await this.repositories.workflowRuntime.save(
        instance.id,
        instance.revision,
        {
          runtime,
          status: "blocked",
          failureReason: runtimeNode.error,
          actorId,
          audits: [
            {
              kind: "approval.expired",
              nodeId: node.nodeId,
              summary: `审批“${node.name}”已过期，流程按策略阻塞`,
              data: { round: group.round, count: group.count, action },
            },
          ],
        },
      );
      return;
    }
    const transition = transitionWorkflowNode({
      graph: instance.graph,
      runtime: instance.runtime,
      nodeId: node.nodeId,
      actorId,
      approvalResult: "rejected",
      output: "审批已超过 SLA 截止时间，按过期策略拒绝",
    });
    const saved = await this.saveRuntimeTransition(
      instance,
      transition,
      actorId,
      [
        {
          kind: "approval.expired",
          nodeId: node.nodeId,
          summary: `审批“${node.name}”已过期，流程按策略拒绝`,
          data: { round: group.round, count: group.count, action },
        },
      ],
    );
    await this.activateWorkflowRuntime(saved, actorId);
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
        const sla = approvalSlaDeadlines(definition);
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
        if (definition.approvalEscalationRoleId !== undefined) {
          const roles = await this.repositories.projectMemberships.listRoles(
            instance.projectId,
          );
          if (
            !roles.some(
              (role) => role.id === definition.approvalEscalationRoleId,
            )
          ) {
            node.status = "failed";
            node.error = "审批升级角色不属于当前项目";
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
        }
        node.status = "waiting_approval";
        node.startedAt ??= new Date().toISOString();
        node.timeoutAt = sla.dueAt;
        await this.repositories.workflowRuntime.createApprovals(
          instance.id,
          node.nodeId,
          node.visits,
          approvers.map((approver) => ({
            ...approver,
            ...sla,
          })),
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
                  dueAt: sla.dueAt,
                  remindAt: sla.remindAt,
                  escalateAt: sla.escalateAt,
                  expiresAt: sla.expiresAt,
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
    const project = await this.requireProject(instance.projectId);
    if (project.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Workflow nodes in an archived project cannot be dispatched",
        409,
      );
    }
    const agent = await this.repositories.agents.get(task.agentId);
    if (agent === undefined) {
      throw new ApplicationError(
        "agent_unavailable",
        "Workflow Agent is unavailable",
        409,
      );
    }
    requireExecutableRuntime(agent);
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
      maxAttempts: definition.maxAttempts,
      idempotencyKey: `${instance.id}:${node.nodeId}:${node.visits}:${node.attempt}`,
      workflowInstanceId: instance.id,
      workflowNodeId: node.nodeId,
      trace: createRootTraceContext(),
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

  private async requirePendingApproval(
    instanceId: string,
    nodeId: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.getWorkflowInstance(instanceId);
    if (instance.status === "paused") {
      throw new ApplicationError(
        "workflow_paused",
        "Resume the workflow before changing approvals",
        409,
      );
    }
    const node = requireRuntimeNode(instance.runtime, nodeId);
    if (node.type !== "approval" || node.status !== "waiting_approval") {
      throw new ApplicationError(
        "workflow_approval_not_pending",
        "The node is not waiting for approval",
        409,
      );
    }
    return instance;
  }

  private async assertWorkflowOwner(
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const members =
      await this.repositories.projectMemberships.listMembers(projectId);
    const member = members.find(
      (candidate) =>
        candidate.status === "active" && candidate.actorId === actorId,
    );
    if (member === undefined || !member.owner) {
      throw new ApplicationError(
        "forbidden",
        "Project owner permission is required to control this workflow",
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

  async listMeetings(
    projectId: string,
    actorId = "local-admin",
  ): Promise<Meeting[]> {
    await this.requireProjectOwner(projectId, actorId);
    return this.repositories.meetings.list(projectId);
  }

  async createMeeting(
    input: CreateMeetingInput,
    actorId = "local-admin",
  ): Promise<Meeting> {
    await this.requireActiveProjectOwner(input.projectId, actorId);
    const members = await this.repositories.projectMemberships.listMembers(
      input.projectId,
    );
    const agents = await this.repositories.agents.list();
    for (const agentId of input.agentIds) {
      const agent = await this.repositories.agents.get(agentId, true);
      if (agent === undefined || agent.status !== "active") {
        throw new ApplicationError(
          "meeting_ai_agent_unavailable",
          "Every meeting AI participant must be active",
          409,
        );
      }
      if (
        !members.some(
          (member) =>
            member.kind === "agent" &&
            member.actorId === agentId &&
            member.status === "active",
        )
      ) {
        throw new ApplicationError(
          "meeting_ai_agent_not_member",
          "Every meeting AI participant must be an active project member",
          409,
        );
      }
    }
    return this.repositories.meetings.create(input, agents);
  }

  async getMeeting(
    id: string,
    actorId = "local-admin",
  ): Promise<MeetingDetail> {
    const detail = await this.repositories.meetings.detail(id);
    if (detail === undefined) {
      throw new ApplicationError("meeting_not_found", "Meeting not found", 404);
    }
    await this.requireProjectOwner(detail.meeting.projectId, actorId);
    return detail;
  }

  async postMeetingMessage(
    meetingId: string,
    content: string,
    actorId = "local-admin",
    mentions: readonly string[] = [],
  ): Promise<MeetingMessage> {
    const detail = await this.getMeeting(meetingId, actorId);
    if (detail.meeting.status === "closed") {
      throw new ApplicationError("meeting_closed", "Meeting is closed", 409);
    }
    const mentionedAgentIds = new Set(mentions);
    for (const participant of detail.meeting.participants) {
      if (participant.kind !== "agent") continue;
      if (content.includes(`@${participant.name}`)) {
        mentionedAgentIds.add(participant.id);
      }
    }
    const agentParticipants = new Set(
      detail.meeting.participants
        .filter((participant) => participant.kind === "agent")
        .map((participant) => participant.id),
    );
    if (
      [...mentionedAgentIds].some((agentId) => !agentParticipants.has(agentId))
    ) {
      throw new ApplicationError(
        "meeting_mention_not_participant",
        "Mentioned AI participants must belong to the meeting",
        409,
      );
    }
    const message = await this.repositories.meetings.postMessage(
      meetingId,
      "human",
      actorId,
      "Local Admin",
      content,
    );
    if (mentionedAgentIds.size > 0) {
      const policy = await this.repositories.meetingAi.getPolicy(meetingId);
      if (
        policy !== undefined &&
        policy.status === "active" &&
        policy.triggerKinds.includes("mention")
      ) {
        try {
          await this.repositories.meetingAi.trigger({
            meetingId,
            projectId: detail.meeting.projectId,
            actorId,
            trigger: {
              kind: "mention",
              agentIds: [...mentionedAgentIds],
              sourceMessageId: message.id,
              reason: "A human participant mentioned the AI teammate",
            },
            fallbackSummaryKey: message.id,
          });
        } catch (error) {
          if (!(error instanceof MeetingAiPreconditionError)) throw error;
        }
      }
    }
    return message;
  }

  async getMeetingAiPolicy(
    meetingId: string,
    actorId = "local-admin",
  ): Promise<MeetingAiPolicy> {
    await this.getMeeting(meetingId, actorId);
    const policy = await this.repositories.meetingAi.getPolicy(meetingId);
    if (policy === undefined) {
      throw new ApplicationError(
        "meeting_ai_policy_not_found",
        "Meeting AI policy not found",
        404,
      );
    }
    return policy;
  }

  async updateMeetingAiPolicy(
    meetingId: string,
    input: UpdateMeetingAiPolicyInput,
    actorId = "local-admin",
  ): Promise<MeetingAiPolicy> {
    const detail = await this.getMeeting(meetingId, actorId);
    await this.requireActiveProjectOwner(detail.meeting.projectId, actorId);
    const current = await this.getMeetingAiPolicy(meetingId, actorId);
    const updated = await this.repositories.meetingAi.updatePolicy({
      id: current.id,
      expectedRevision: input.expectedRevision,
      patch: input,
      actorId,
    });
    if (updated === undefined) {
      throw new ApplicationError(
        "meeting_ai_policy_revision_conflict",
        "Meeting AI policy was revised or terminated",
        409,
        { currentRevision: current.revision },
      );
    }
    if (updated.status !== "active") {
      await this.repositories.meetingAi.cancelOpenRuns(
        meetingId,
        updated.status === "terminated"
          ? "meeting AI participation terminated"
          : "meeting AI participation paused",
      );
    }
    return updated;
  }

  async pauseMeetingAi(
    meetingId: string,
    input: MeetingAiPolicyLifecycleInput,
    actorId = "local-admin",
  ): Promise<MeetingAiPolicy> {
    return this.transitionMeetingAi(meetingId, "paused", input, actorId);
  }

  async resumeMeetingAi(
    meetingId: string,
    input: MeetingAiPolicyLifecycleInput,
    actorId = "local-admin",
  ): Promise<MeetingAiPolicy> {
    return this.transitionMeetingAi(meetingId, "active", input, actorId);
  }

  async terminateMeetingAi(
    meetingId: string,
    input: MeetingAiPolicyLifecycleInput,
    actorId = "local-admin",
  ): Promise<MeetingAiPolicy> {
    return this.transitionMeetingAi(meetingId, "terminated", input, actorId);
  }

  async triggerMeetingAi(
    meetingId: string,
    input: TriggerMeetingAiInput,
    actorId = "local-admin",
  ): Promise<TriggerMeetingAiResult> {
    const detail = await this.getMeeting(meetingId, actorId);
    await this.requireActiveProjectOwner(detail.meeting.projectId, actorId);
    const policy = await this.getMeetingAiPolicy(meetingId, actorId);
    let trigger = input;
    if (trigger.kind === "mention" && trigger.sourceMessageId === undefined) {
      const lastMessage = [...detail.messages]
        .reverse()
        .find((message) => message.status === "sent");
      if (lastMessage === undefined) {
        throw new ApplicationError(
          "meeting_ai_source_required",
          "A mention trigger requires an existing meeting message",
          400,
        );
      }
      trigger = { ...trigger, sourceMessageId: lastMessage.id };
    }
    try {
      return await this.repositories.meetingAi.trigger({
        meetingId,
        projectId: detail.meeting.projectId,
        actorId,
        trigger,
        fallbackSummaryKey:
          trigger.sourceMessageId ?? detail.messages.at(-1)?.id ?? meetingId,
      });
    } catch (error) {
      if (error instanceof MeetingAiPreconditionError) {
        throw new ApplicationError(
          error.code,
          error.message,
          error.code === "meeting_not_found" ? 404 : 409,
          { policyRevision: policy.revision },
        );
      }
      throw error;
    }
  }

  private async transitionMeetingAi(
    meetingId: string,
    status: MeetingAiPolicy["status"],
    input: MeetingAiPolicyLifecycleInput,
    actorId: string,
  ): Promise<MeetingAiPolicy> {
    const detail = await this.getMeeting(meetingId, actorId);
    await this.requireActiveProjectOwner(detail.meeting.projectId, actorId);
    const current = await this.getMeetingAiPolicy(meetingId, actorId);
    const updated = await this.repositories.meetingAi.transitionPolicy({
      id: current.id,
      expectedRevision: input.expectedRevision,
      status,
      actorId,
      reason: input.reason,
    });
    if (updated === undefined) {
      throw new ApplicationError(
        "meeting_ai_policy_revision_conflict",
        "Meeting AI policy was revised or cannot transition",
        409,
        { currentRevision: current.revision },
      );
    }
    return updated;
  }

  async closeMeeting(
    meetingId: string,
    summary: string,
    actorId = "local-admin",
  ): Promise<Meeting> {
    const detail = await this.getMeeting(meetingId, actorId);
    if (detail.meeting.status === "closed") {
      throw new ApplicationError(
        "meeting_closed",
        "Meeting is already closed",
        409,
      );
    }
    const aiPolicy = await this.repositories.meetingAi.getPolicy(meetingId);
    if (aiPolicy?.status === "active") {
      await this.repositories.meetingAi.transitionPolicy({
        id: aiPolicy.id,
        expectedRevision: aiPolicy.revision,
        status: "paused",
        actorId,
        reason: "meeting closed",
      });
    }
    await this.repositories.meetingAi.cancelOpenRuns(
      meetingId,
      "meeting closed",
    );
    if (summary.trim() !== "") {
      const minutes = await this.getMeetingMinutes(meetingId, actorId);
      const saved = await this.repositories.meetingDecisions.saveDraft({
        meetingId,
        projectId: detail.meeting.projectId,
        content: summary.trim(),
        decisions: minutes.draft.decisions,
        sourceMessageIds: minutes.draft.sourceMessageIds,
        expectedRevision: minutes.draft.revision,
        actorId,
      });
      if (saved === undefined) {
        throw new ApplicationError(
          "meeting_minutes_revision_conflict",
          "Meeting minutes changed concurrently while closing the meeting",
          409,
        );
      }
      const published = await this.repositories.meetingDecisions.publish({
        meetingId,
        projectId: detail.meeting.projectId,
        expectedRevision: saved.revision,
        actorId,
      });
      if (published === undefined) {
        throw new ApplicationError(
          "meeting_minutes_revision_conflict",
          "Meeting minutes changed concurrently while closing the meeting",
          409,
        );
      }
      await this.repositories.memoryClosure.ingestMeetingMinutes({
        meetingId,
        projectId: detail.meeting.projectId,
        versionId: published.version.id,
        actorId,
      });
    }
    const meeting = await this.repositories.meetings.close(meetingId, summary);
    if (meeting === undefined) {
      throw new ApplicationError("meeting_not_found", "Meeting not found", 404);
    }
    return meeting;
  }

  async getMeetingMinutes(
    meetingId: string,
    actorId = "local-admin",
  ): Promise<MeetingMinutes> {
    await this.getMeeting(meetingId, actorId);
    const minutes =
      await this.repositories.meetingDecisions.getMinutes(meetingId);
    if (minutes === undefined) {
      throw new ApplicationError(
        "meeting_minutes_not_found",
        "Meeting minutes draft was not initialized",
        404,
      );
    }
    return minutes;
  }

  async saveMeetingMinutesDraft(
    meetingId: string,
    input: UpdateMeetingMinutesDraftInput,
    actorId = "local-admin",
  ): Promise<MeetingMinutesDraft> {
    const detail = await this.getMeeting(meetingId, actorId);
    this.assertMeetingSourceMessages(detail, input.sourceMessageIds);
    const saved = await this.repositories.meetingDecisions.saveDraft({
      meetingId,
      projectId: detail.meeting.projectId,
      content: input.content,
      decisions: input.decisions,
      sourceMessageIds: input.sourceMessageIds,
      expectedRevision: input.expectedRevision,
      actorId,
    });
    if (saved === undefined) {
      const current =
        await this.repositories.meetingDecisions.getMinutes(meetingId);
      throw new ApplicationError(
        "meeting_minutes_revision_conflict",
        "Meeting minutes were revised by another request",
        409,
        { currentRevision: current?.draft.revision ?? null },
      );
    }
    return saved;
  }

  async publishMeetingMinutes(
    meetingId: string,
    input: PublishMeetingMinutesInput,
    actorId = "local-admin",
  ): Promise<{
    readonly minutes: MeetingMinutes;
    readonly version: MeetingMinutesVersion;
  }> {
    const detail = await this.getMeeting(meetingId, actorId);
    try {
      const published = await this.repositories.meetingDecisions.publish({
        meetingId,
        projectId: detail.meeting.projectId,
        expectedRevision: input.expectedRevision,
        actorId,
      });
      if (published === undefined) {
        const current =
          await this.repositories.meetingDecisions.getMinutes(meetingId);
        throw new ApplicationError(
          "meeting_minutes_revision_conflict",
          "Meeting minutes were revised by another request",
          409,
          { currentRevision: current?.draft.revision ?? null },
        );
      }
      await this.repositories.memoryClosure.ingestMeetingMinutes({
        meetingId,
        projectId: detail.meeting.projectId,
        versionId: published.version.id,
        actorId,
      });
      return published;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "meeting minutes content is empty"
      ) {
        throw new ApplicationError(
          "meeting_minutes_empty",
          "Meeting minutes content is required before publishing",
          400,
        );
      }
      throw error;
    }
  }

  async listMeetingActionItems(
    meetingId: string,
    actorId = "local-admin",
  ): Promise<MeetingActionItem[]> {
    await this.getMeeting(meetingId, actorId);
    return this.repositories.meetingDecisions.listActionItems(meetingId);
  }

  async createMeetingActionItem(
    meetingId: string,
    input: CreateMeetingActionItemInput,
    actorId = "local-admin",
  ): Promise<MeetingActionItem> {
    const detail = await this.getMeeting(meetingId, actorId);
    await this.requireActiveProjectOwner(detail.meeting.projectId, actorId);
    this.assertMeetingSourceMessages(detail, input.sourceMessageIds);
    const members = await this.repositories.projectMemberships.listMembers(
      detail.meeting.projectId,
    );
    const owner = members.find(
      (member) =>
        member.actorId === input.ownerActorId && member.status === "active",
    );
    if (
      owner === undefined ||
      (owner.kind !== "human" && owner.kind !== "agent")
    ) {
      throw new ApplicationError(
        "action_item_owner_not_member",
        "The action item owner must be an active project member",
        409,
      );
    }
    const versions =
      await this.repositories.meetingDecisions.listMinutesVersions(meetingId);
    let sourceVersionId = input.sourceVersionId ?? null;
    let sourceId = input.sourceId ?? actorId;
    if (input.sourceType === "minutes_version") {
      const version =
        (sourceVersionId === null
          ? versions[0]
          : versions.find((candidate) => candidate.id === sourceVersionId)) ??
        undefined;
      if (version === undefined) {
        throw new ApplicationError(
          "meeting_minutes_version_not_found",
          "The source minutes version is not published for this meeting",
          409,
        );
      }
      sourceVersionId = version.id;
      sourceId = version.id;
    } else if (input.sourceType === "message") {
      const message = detail.messages.find(
        (candidate) => candidate.id === input.sourceId,
      );
      if (message === undefined) {
        throw new ApplicationError(
          "meeting_source_message_not_found",
          "The source message does not belong to this meeting",
          409,
        );
      }
      sourceId = message.id;
    } else {
      sourceVersionId = null;
    }
    const dedupeKey =
      input.dedupeKey ??
      `auto-${createHash("sha256")
        .update(
          [
            input.title.trim().toLocaleLowerCase(),
            owner.actorId,
            input.dueAt ?? "",
          ].join("\u0000"),
        )
        .digest("hex")
        .slice(0, 32)}`;
    try {
      return await this.repositories.meetingDecisions.createActionItem({
        meetingId,
        projectId: detail.meeting.projectId,
        title: input.title,
        description: input.description,
        ownerKind: owner.kind,
        ownerActorId: owner.actorId,
        ownerName: owner.name,
        dueAt: input.dueAt ?? null,
        priority: input.priority,
        sourceType: input.sourceType,
        sourceId,
        sourceVersionId,
        sourceMessageIds: input.sourceMessageIds,
        dedupeKey,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const items =
          await this.repositories.meetingDecisions.listActionItems(meetingId);
        const existing = items.find(
          (item) =>
            item.dedupeKey.toLocaleLowerCase() ===
            dedupeKey.toLocaleLowerCase(),
        );
        throw new ApplicationError(
          "action_item_duplicate",
          "An action item with this dedupe key already exists",
          409,
          { existingActionItemId: existing?.id ?? null },
        );
      }
      throw error;
    }
  }

  async updateMeetingActionItem(
    meetingId: string,
    actionItemId: string,
    input: UpdateMeetingActionItemInput,
    actorId = "local-admin",
  ): Promise<MeetingActionItem> {
    await this.getMeeting(meetingId, actorId);
    const item = await this.repositories.meetingDecisions.getActionItem(
      meetingId,
      actionItemId,
    );
    if (item === undefined) {
      throw new ApplicationError(
        "action_item_not_found",
        "Meeting action item not found",
        404,
      );
    }
    if (item.taskId !== null) {
      throw new ApplicationError(
        "action_item_managed_by_task",
        "Converted action item status follows its task",
        409,
      );
    }
    const updated =
      await this.repositories.meetingDecisions.updateActionItemStatus(
        meetingId,
        actionItemId,
        input.status,
      );
    if (updated === undefined) {
      throw new ApplicationError(
        "action_item_not_found",
        "Meeting action item not found",
        404,
      );
    }
    return updated;
  }

  async convertMeetingActionItem(
    meetingId: string,
    actionItemId: string,
    input: ConvertMeetingActionItemInput,
    actorId = "local-admin",
  ): Promise<MeetingActionItemConversion> {
    const detail = await this.getMeeting(meetingId, actorId);
    const project = await this.requireActiveProjectOwner(
      detail.meeting.projectId,
      actorId,
    );
    const item = await this.repositories.meetingDecisions.getActionItem(
      meetingId,
      actionItemId,
    );
    if (item === undefined) {
      throw new ApplicationError(
        "action_item_not_found",
        "Meeting action item not found",
        404,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      project.id,
    );
    const requestedAgentId =
      input.assigneeAgentId ??
      (item.ownerKind === "agent" ? item.ownerActorId : undefined);
    if (requestedAgentId === undefined) {
      throw new ApplicationError(
        "action_item_assignee_required",
        "Select an active AI project member for the converted task",
        400,
      );
    }
    const member = members.find(
      (candidate) =>
        candidate.kind === "agent" &&
        candidate.actorId === requestedAgentId &&
        candidate.status === "active",
    );
    if (member === undefined) {
      throw new ApplicationError(
        "action_item_assignee_not_member",
        "The task assignee must be an active AI project member",
        409,
      );
    }
    const agent = await this.repositories.agents.get(member.actorId, true);
    if (agent === undefined) {
      throw new ApplicationError(
        "agent_not_found",
        "Task assignee agent was not found",
        404,
      );
    }
    requireExecutableRuntime(agent);
    let converted: { readonly taskId: string; readonly reused: boolean };
    try {
      converted = await this.repositories.meetingDecisions.convertActionItem({
        meetingId,
        actionItemId,
        projectId: project.id,
        assigneeAgentId: member.actorId,
        actorId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "cancelled action item cannot be converted"
      ) {
        throw new ApplicationError(
          "action_item_cancelled",
          "A cancelled action item cannot be converted",
          409,
        );
      }
      if (error instanceof Error && error.message === "project archived") {
        throw new ApplicationError(
          "project_archived",
          "Action items cannot be converted in an archived project",
          409,
        );
      }
      throw error;
    }
    const task = await this.getTask(converted.taskId);
    let runId: string | null = null;
    if (input.dispatch && task.status === "queued") {
      runId = (await this.dispatchTask(task.id)).runId;
    } else if (task.status === "in_progress" || task.status === "review") {
      const runs = await this.repositories.runs.listByTask(task.id);
      runId = runs[0]?.id ?? null;
    }
    const updatedItem = await this.repositories.meetingDecisions.getActionItem(
      meetingId,
      actionItemId,
    );
    if (updatedItem === undefined) {
      throw new Error("converted action item is missing");
    }
    return {
      actionItem: updatedItem,
      task: {
        id: task.id,
        title: task.title,
        status: (await this.getTask(task.id)).status,
        agentId: task.agentId,
      },
      runId,
      reused: converted.reused,
    };
  }

  async getMeetingTraceability(
    meetingId: string,
    actorId = "local-admin",
  ): Promise<MeetingTraceability> {
    await this.getMeeting(meetingId, actorId);
    return this.repositories.meetingDecisions.traceability(meetingId);
  }

  private assertMeetingSourceMessages(
    detail: MeetingDetail,
    sourceMessageIds: readonly string[],
  ): void {
    const existing = new Set(detail.messages.map((message) => message.id));
    if (sourceMessageIds.some((id) => !existing.has(id))) {
      throw new ApplicationError(
        "meeting_source_message_not_found",
        "All source messages must belong to this meeting",
        409,
      );
    }
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

function approvalSlaDeadlines(definition: WorkflowGraphNode): {
  readonly dueAt: string;
  readonly remindAt: string;
  readonly escalateAt?: string;
  readonly escalationRoleId?: string;
  readonly expiresAt: string;
} {
  const now = Date.now();
  const dueSeconds = definition.approvalDueSeconds ?? 3_600;
  const remindSeconds =
    definition.approvalRemindSeconds ?? Math.max(1, Math.floor(dueSeconds / 2));
  const expireSeconds =
    definition.approvalExpireSeconds ?? Math.max(dueSeconds, dueSeconds * 2);
  return {
    dueAt: new Date(now + dueSeconds * 1_000).toISOString(),
    remindAt: new Date(now + remindSeconds * 1_000).toISOString(),
    ...(definition.approvalEscalateAfterSeconds === undefined
      ? {}
      : {
          escalateAt: new Date(
            now + definition.approvalEscalateAfterSeconds * 1_000,
          ).toISOString(),
        }),
    ...(definition.approvalEscalationRoleId === undefined
      ? {}
      : { escalationRoleId: definition.approvalEscalationRoleId }),
    expiresAt: new Date(now + expireSeconds * 1_000).toISOString(),
  };
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

function translateProjectTemplateError(error: unknown): Error {
  if (error instanceof ApplicationError) return error;
  if (error instanceof ProjectTemplateRepositoryError) {
    return new ApplicationError(
      error.code,
      error.message,
      error.statusCode,
      error.details,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function assertExternalRuntimeReadable(
  runtime: ExternalRuntime,
  actorId: string,
  administrator: boolean,
): void {
  if (
    !administrator &&
    runtime.ownerId !== actorId &&
    runtime.visibility !== "platform"
  ) {
    throw new ApplicationError(
      "runtime_forbidden",
      "The actor cannot access this external runtime",
      403,
    );
  }
}

function assertExternalRuntimeManageable(
  runtime: ExternalRuntime,
  actorId: string,
  administrator: boolean,
): void {
  if (!administrator && runtime.ownerId !== actorId) {
    throw new ApplicationError(
      "runtime_forbidden",
      "Only a platform administrator or the runtime owner can manage this runtime",
      403,
    );
  }
}

function externalRuntimeRevisionConflict(): ApplicationError {
  return new ApplicationError(
    "runtime_revision_conflict",
    "The runtime was changed by another request",
    409,
  );
}

function directChatApplicationError(error: unknown): Error {
  if (error instanceof ApplicationError) return error;
  if (error instanceof DirectChatPreconditionError) {
    const statusCode =
      error.code === "direct_chat_forbidden"
        ? 403
        : error.code === "direct_chat_not_found" ||
            error.code === "direct_chat_turn_not_found" ||
            error.code === "agent_not_found"
          ? 404
          : 409;
    return new ApplicationError(error.code, error.message, statusCode);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export * from "./run-executor.js";
export * from "./runtime-metrics.js";
