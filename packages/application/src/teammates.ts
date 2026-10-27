import type {
  ChangeTeammateStatusInput,
  CreateTeammateInput,
  CreateTeammateTemplateInput,
  CreateTeammateWorkPlanInput,
  ExecutionHistoryPage,
  ParsedTeammateWorkItem,
  ParsedTeammateWorkPlan,
  ReorderTeammateQueueInput,
  RuntimeUsageSummary,
  RunDurationBreakdown,
  Teammate,
  TeammateDefinition,
  TeammateEvent,
  TeammateExecutionHistoryQuery,
  TeammateQueueItem,
  TeammateRuntimeStatistics,
  TeammateStatus,
  TeammateTemplate,
  TeammateTemplateVersion,
  TeammateTransfer,
  TeammateWeeklyReport,
  UpdateTeammateAutoExecuteInput,
  TransferTeammateInput,
} from "@pluginmax/contracts";
import {
  addRuntimeUsageSummaries,
  createTeammateInputSchema,
  createTeammateTemplateInputSchema,
  createTeammateWorkPlanInputSchema,
  parsedTeammateWorkPlanSchema,
  parseTeammateWorkPlanInputSchema,
  reorderTeammateQueueInputSchema,
  transferTeammateInputSchema,
  updateTeammateAutoExecuteInputSchema,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  ScopedAuthorizationPermission,
} from "@pluginmax/database";
import { ApplicationError } from "./errors.js";
import {
  decodeExecutionHistoryCursor,
  encodeExecutionHistoryCursor,
  executionEconomics,
  executionHistoryFingerprint,
  executionHistoryItem,
} from "./runtime-economics.js";

const TEAMMATE_TRANSITIONS: Record<TeammateStatus, readonly TeammateStatus[]> =
  {
    active: ["paused", "inactive", "archived"],
    paused: ["active", "inactive", "archived"],
    inactive: ["active", "archived"],
    archived: ["inactive"],
  };

const EMPTY_USAGE: RuntimeUsageSummary = {
  sampleCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  costAmount: 0,
  costCurrencies: [],
  unknownFields: [],
  unknownSampleCount: 0,
};

const EMPTY_DURATIONS: RunDurationBreakdown = {
  observedTotalMs: 0,
  queuedMs: 0,
  claimedMs: 0,
  waitingApprovalMs: 0,
  runningMs: 0,
  needsInputMs: 0,
  retryWaitMs: 0,
  recoveryMs: 0,
  settlementMs: 0,
  unclassifiedMs: 0,
};

function addDurations(
  left: RunDurationBreakdown,
  right: RunDurationBreakdown,
): RunDurationBreakdown {
  return Object.fromEntries(
    Object.keys(EMPTY_DURATIONS).map((key) => [
      key,
      left[key as keyof RunDurationBreakdown] +
        right[key as keyof RunDurationBreakdown],
    ]),
  ) as unknown as RunDurationBreakdown;
}

function dateText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApplicationError(
      "teammate_week_invalid",
      "weekStart must be an ISO date",
      400,
    );
  }
  return parsed;
}

export function weekRange(weekStart?: string | Date): {
  readonly start: Date;
  readonly endExclusive: Date;
  readonly end: Date;
  readonly startText: string;
  readonly endText: string;
} {
  const value =
    weekStart instanceof Date ? new Date(weekStart) : parseDate(weekStart);
  value.setUTCHours(0, 0, 0, 0);
  const day = value.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  value.setUTCDate(value.getUTCDate() + offset);
  const endExclusive = new Date(value);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 7);
  const end = new Date(endExclusive);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    start: value,
    endExclusive,
    end,
    startText: dateText(value),
    endText: dateText(end),
  };
}

function previousWeekStart(now = new Date()): Date {
  const current = weekRange(now).start;
  current.setUTCDate(current.getUTCDate() - 7);
  return current;
}

function priorityFromInstruction(
  instruction: string,
): ParsedTeammateWorkItem["priority"] {
  const match = instruction.match(/(?:^|[^A-Za-z0-9])(P[0-3])(?![A-Za-z0-9])/i);
  if (match?.[1]?.toUpperCase() === "P0") return "urgent";
  if (match?.[1]?.toUpperCase() === "P1") return "high";
  if (match?.[1]?.toUpperCase() === "P2") return "medium";
  return match === null ? "medium" : "low";
}

function dueFromInstruction(
  instruction: string,
  now: Date,
): string | undefined {
  if (/今天/.test(instruction)) return dateText(now);
  if (/明天/.test(instruction)) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + 1);
    return dateText(date);
  }
  if (/后天/.test(instruction)) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + 2);
    return dateText(date);
  }
  const match = instruction.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match === null) return undefined;
  return `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
}

function compactTitle(value: string): string {
  const title = value
    .trim()
    .replace(/^(请|帮我|麻烦|让\s*Agent\s*)+/i, "")
    .replace(/[,，、]?\s*优先级\s*[:：]?\s*P[0-3]/gi, "")
    .replace(/\bP[0-3]\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return (title || "新的 AI Teammate 工作项").slice(0, 240);
}

export function parseTeammateWorkPlan(input: {
  readonly teammate: Teammate;
  readonly instruction: string;
  readonly now?: Date;
}): ParsedTeammateWorkPlan {
  const now = input.now ?? new Date();
  const segments = input.instruction
    .split(/\n|。|；|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const source = segments.length === 0 ? [input.instruction] : segments;
  const items = source.map((line) => {
    const due = dueFromInstruction(line, now);
    return {
      title: compactTitle(line),
      description:
        line === input.instruction
          ? line
          : `${line}\n\n原始工作计划：${input.instruction}`,
      acceptance: ["按任务描述交付可验证结果"],
      priority: priorityFromInstruction(line),
      ...(due === undefined ? {} : { due }),
    } satisfies ParsedTeammateWorkItem;
  });
  return parsedTeammateWorkPlanSchema.parse({
    instruction: input.instruction,
    summary: `${input.teammate.name} · ${items.length} 个受限任务`,
    items,
    restricted: {
      assignee: "teammate",
      projectId: input.teammate.projectId,
      autoAccept: false,
      maxItems: 20,
    },
  });
}

export interface TeammateDetail {
  readonly teammate: Teammate;
  readonly template: TeammateTemplate;
  readonly templateVersion: TeammateTemplateVersion;
  readonly transfers: readonly TeammateTransfer[];
  readonly events: readonly TeammateEvent[];
  readonly weeklyReports: readonly TeammateWeeklyReport[];
}

type DispatchTeammateTask = (
  taskId: string,
  aiPrincipalId: string,
) => Promise<{ readonly runId: string }>;

export class TeammateApplicationService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly dispatchTask?: DispatchTeammateTask,
  ) {}

  private async authSource(
    principalId: string,
  ): Promise<"bearer" | "local-development"> {
    const principal =
      await this.repositories.authorization.getPrincipal(principalId);
    return principal?.source === "local" ? "local-development" : "bearer";
  }

  private async requireProjectPermission(
    projectId: string,
    principalId: string,
    permission: ScopedAuthorizationPermission,
  ): Promise<void> {
    const decision = await this.repositories.authorization.authorizeProject({
      principalId,
      authSource: await this.authSource(principalId),
      projectId,
      permission,
    });
    if (!decision.allowed) {
      throw new ApplicationError(
        decision.reason === "project_archived"
          ? "project_archived"
          : "forbidden",
        decision.reason === "project_archived"
          ? "Archived projects cannot be modified"
          : "Project permission is required",
        decision.reason === "project_archived" ? 409 : 403,
        {
          reason: decision.reason ?? "permission_missing",
          projectId,
          permission,
        },
      );
    }
  }

  private async templateForManage(
    templateId: string,
    actorPrincipalId: string,
    administrator: boolean,
  ): Promise<TeammateTemplate> {
    const template = await this.repositories.teammates.getTemplate(templateId);
    if (template === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    await this.requireProjectPermission(
      template.projectId,
      actorPrincipalId,
      "write",
    );
    const allowed =
      template.scope === "platform"
        ? administrator
        : template.ownerPrincipalId === actorPrincipalId;
    if (!allowed) {
      throw new ApplicationError(
        "teammate_template_forbidden",
        "Only the template owner or platform administrator can manage it",
        403,
      );
    }
    return template;
  }

  async listTemplates(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly includeArchived?: boolean;
  }): Promise<TeammateTemplate[]> {
    await this.requireProjectPermission(
      input.projectId,
      input.actorPrincipalId,
      "read",
    );
    return this.repositories.teammates.listTemplates(input);
  }

  async getTemplate(
    templateId: string,
    actorPrincipalId: string,
  ): Promise<{
    readonly template: TeammateTemplate;
    readonly versions: readonly TeammateTemplateVersion[];
  }> {
    const template = await this.repositories.teammates.getTemplate(templateId);
    if (template === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    await this.requireProjectPermission(
      template.projectId,
      actorPrincipalId,
      "read",
    );
    const versions =
      await this.repositories.teammates.listTemplateVersions(templateId);
    return { template, versions };
  }

  async createTemplate(input: {
    readonly value: CreateTeammateTemplateInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<TeammateTemplate> {
    const parsed = createTeammateTemplateInputSchema.parse(input.value);
    await this.requireProjectPermission(
      parsed.projectId,
      input.actorPrincipalId,
      "write",
    );
    if (parsed.scope === "platform" && !input.administrator) {
      throw new ApplicationError(
        "teammate_template_forbidden",
        "Platform templates require platform administration",
        403,
      );
    }
    try {
      return await this.repositories.teammates.createTemplate({
        projectId: parsed.projectId,
        workspaceId: parsed.projectId,
        actorPrincipalId: input.actorPrincipalId,
        template: parsed,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          "teammate_template_name_conflict",
          "An active template with this name already exists",
          409,
        );
      }
      throw error;
    }
  }

  async updateTemplate(input: {
    readonly templateId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
    readonly expectedVersion: number;
    readonly definition: TeammateDefinition;
  }): Promise<TeammateTemplate> {
    const current = await this.templateForManage(
      input.templateId,
      input.actorPrincipalId,
      input.administrator,
    );
    if (current.status === "archived") {
      throw new ApplicationError(
        "teammate_template_archived",
        "Archived AI Teammate templates cannot be edited",
        409,
      );
    }
    let result;
    try {
      result = await this.repositories.teammates.updateTemplate(input);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          "teammate_template_name_conflict",
          "An active template with this name already exists",
          409,
        );
      }
      throw error;
    }
    if (result === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    if (result === "revision_conflict") {
      throw new ApplicationError(
        "teammate_template_version_conflict",
        "AI Teammate template was revised by another request",
        409,
      );
    }
    return result;
  }

  async archiveTemplate(input: {
    readonly templateId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
    readonly expectedVersion: number;
  }): Promise<TeammateTemplate> {
    await this.templateForManage(
      input.templateId,
      input.actorPrincipalId,
      input.administrator,
    );
    const result = await this.repositories.teammates.transitionTemplate({
      templateId: input.templateId,
      expectedVersion: input.expectedVersion,
      status: "archived",
    });
    if (result === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    if (result === "revision_conflict") {
      throw new ApplicationError(
        "teammate_template_version_conflict",
        "AI Teammate template was revised by another request",
        409,
      );
    }
    return result;
  }

  async createTeammate(input: {
    readonly value: CreateTeammateInput;
    readonly actorPrincipalId: string;
  }): Promise<Teammate> {
    const parsed = createTeammateInputSchema.parse(input.value);
    await this.requireProjectPermission(
      parsed.projectId,
      input.actorPrincipalId,
      "write",
    );
    const template = await this.repositories.teammates.getTemplate(
      parsed.templateId,
    );
    if (template === undefined) {
      throw new ApplicationError(
        "teammate_template_not_found",
        "AI Teammate template not found",
        404,
      );
    }
    if (template.projectId !== parsed.projectId) {
      throw new ApplicationError(
        "teammate_template_cross_project",
        "The template belongs to another workspace",
        403,
      );
    }
    if (template.status !== "active") {
      throw new ApplicationError(
        "teammate_template_inactive",
        "Only an active template can create an AI Teammate",
        409,
      );
    }
    if (
      template.scope === "personal" &&
      template.ownerPrincipalId !== input.actorPrincipalId
    ) {
      throw new ApplicationError(
        "teammate_template_forbidden",
        "Personal templates can only be used by their owner",
        403,
      );
    }

    const agent = await this.repositories.agents.get(parsed.agentId);
    if (agent === undefined) {
      throw new ApplicationError("agent_not_found", "Agent not found", 404);
    }
    const aiPrincipalId =
      await this.repositories.authorization.ensureAgentPrincipal(
        agent.id,
        agent.name,
      );
    const principal =
      await this.repositories.authorization.getPrincipal(aiPrincipalId);
    if (
      principal === undefined ||
      principal.kind !== "ai" ||
      principal.status !== "active"
    ) {
      throw new ApplicationError(
        "teammate_principal_inactive",
        "The execution Principal must be an active AI Principal",
        409,
      );
    }
    await this.requireProjectPermission(
      parsed.projectId,
      aiPrincipalId,
      "write",
    );
    try {
      const teammate = await this.repositories.teammates.createTeammate({
        teammate: parsed,
        workspaceId: parsed.projectId,
        actorPrincipalId: input.actorPrincipalId,
        agent: { id: agent.id, principalId: aiPrincipalId },
        name: parsed.name ?? template.definition.name,
      });
      await this.repositories.teammates.recordEvent({
        teammateId: teammate.id,
        kind: "created",
        actorPrincipalId: input.actorPrincipalId,
        summary: `创建 AI Teammate「${teammate.name}」`,
        data: {
          templateId: template.id,
          templateVersion: teammate.templateVersion,
          agentId: agent.id,
          aiPrincipalId,
        },
      });
      return teammate;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new ApplicationError(
          "teammate_name_or_agent_conflict",
          "The teammate name or execution Agent is already in use",
          409,
        );
      }
      throw error;
    }
  }

  async listTeammates(input: {
    readonly projectId: string;
    readonly actorPrincipalId: string;
    readonly includeArchived?: boolean;
  }): Promise<Teammate[]> {
    await this.requireProjectPermission(
      input.projectId,
      input.actorPrincipalId,
      "read",
    );
    return this.repositories.teammates.listTeammates(input);
  }

  private async teammateForRead(
    teammateId: string,
    actorPrincipalId: string,
  ): Promise<Teammate> {
    const teammate = await this.repositories.teammates.getTeammate(teammateId);
    if (teammate === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    await this.requireProjectPermission(
      teammate.projectId,
      actorPrincipalId,
      "read",
    );
    return teammate;
  }

  private async teammateForManage(
    teammateId: string,
    actorPrincipalId: string,
    administrator: boolean,
  ): Promise<Teammate> {
    const teammate = await this.repositories.teammates.getTeammate(teammateId);
    if (teammate === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    await this.requireProjectPermission(
      teammate.projectId,
      actorPrincipalId,
      "write",
    );
    if (teammate.ownerPrincipalId !== actorPrincipalId && !administrator) {
      throw new ApplicationError(
        "teammate_owner_required",
        "Only the AI Teammate owner can perform this action",
        403,
      );
    }
    return teammate;
  }

  async getTeammate(
    teammateId: string,
    actorPrincipalId: string,
  ): Promise<TeammateDetail> {
    const teammate = await this.teammateForRead(teammateId, actorPrincipalId);
    const [template, templateVersion, transfers, events, weeklyReports] =
      await Promise.all([
        this.repositories.teammates.getTemplate(teammate.templateId),
        this.repositories.teammates.getTemplateVersion(
          teammate.templateVersionId,
        ),
        this.repositories.teammates.listTransfers(teammateId),
        this.repositories.teammates.listEvents(teammateId),
        this.repositories.teammates.listWeeklyReports(teammateId),
      ]);
    if (template === undefined || templateVersion === undefined) {
      throw new ApplicationError(
        "teammate_template_version_missing",
        "The pinned template version is unavailable",
        409,
      );
    }
    return {
      teammate,
      template,
      templateVersion,
      transfers,
      events,
      weeklyReports,
    };
  }

  async changeStatus(input: {
    readonly teammateId: string;
    readonly value: ChangeTeammateStatusInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<Teammate> {
    const teammate = await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    if (!TEAMMATE_TRANSITIONS[teammate.status].includes(input.value.status)) {
      throw new ApplicationError(
        "teammate_status_conflict",
        `AI Teammate cannot transition from ${teammate.status} to ${input.value.status}`,
        409,
      );
    }
    if (input.value.status === "active") {
      const principal = await this.repositories.authorization.getPrincipal(
        teammate.aiPrincipalId,
      );
      if (principal?.status !== "active") {
        throw new ApplicationError(
          "teammate_principal_inactive",
          "An inactive execution Principal cannot be activated",
          409,
        );
      }
      await this.requireProjectPermission(
        teammate.projectId,
        teammate.aiPrincipalId,
        "write",
      );
    }
    const result = await this.repositories.teammates.transitionTeammate({
      teammateId: teammate.id,
      expectedVersion: input.value.expectedVersion,
      status: input.value.status,
      autoExecute:
        input.value.status === "active" ? teammate.autoExecute : false,
    });
    if (result === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    if (result === "revision_conflict") {
      throw new ApplicationError(
        "teammate_revision_conflict",
        "AI Teammate was changed by another request",
        409,
      );
    }
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: input.value.status === "archived" ? "archive" : "status",
      actorPrincipalId: input.actorPrincipalId,
      summary: `AI Teammate 状态：${teammate.status} → ${result.status}`,
      data: {
        from: teammate.status,
        to: result.status,
        reason: input.value.reason,
      },
    });
    return result;
  }

  async setAutoExecute(input: {
    readonly teammateId: string;
    readonly value: UpdateTeammateAutoExecuteInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<Teammate> {
    const value = updateTeammateAutoExecuteInputSchema.parse(input.value);
    const teammate = await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    if (teammate.status !== "active" && value.autoExecute) {
      throw new ApplicationError(
        "teammate_not_active",
        "Only an active AI Teammate can enable automatic execution",
        409,
      );
    }
    const result = await this.repositories.teammates.transitionTeammate({
      teammateId: teammate.id,
      expectedVersion: value.expectedVersion,
      status: teammate.status,
      autoExecute: value.autoExecute,
    });
    if (result === "revision_conflict") {
      throw new ApplicationError(
        "teammate_revision_conflict",
        "AI Teammate was changed by another request",
        409,
      );
    }
    if (result === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: "auto-run",
      actorPrincipalId: input.actorPrincipalId,
      summary: value.autoExecute
        ? "开启 AI Teammate 自动执行"
        : "关闭 AI Teammate 自动执行",
      data: { autoExecute: value.autoExecute },
    });
    return result;
  }

  async transfer(input: {
    readonly teammateId: string;
    readonly value: TransferTeammateInput;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
  }): Promise<Teammate> {
    const value = transferTeammateInputSchema.parse(input.value);
    const teammate = await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    const target = await this.repositories.authorization.getPrincipal(
      value.toOwnerPrincipalId,
    );
    if (
      target === undefined ||
      target.kind !== "human" ||
      target.status !== "active"
    ) {
      throw new ApplicationError(
        "teammate_transfer_target_invalid",
        "The transfer target must be an active Human Principal",
        409,
      );
    }
    const members = await this.repositories.projectMemberships.listMembers(
      teammate.projectId,
    );
    const member = members.find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.principalId === target.id ||
          candidate.actorId === target.id),
    );
    if (member === undefined) {
      throw new ApplicationError(
        "teammate_transfer_target_not_member",
        "The transfer target must be an active project member",
        403,
      );
    }
    const queue = await this.getWorkQueue(teammate.id, input.actorPrincipalId);
    if (queue.some((item) => item.blockedReasons.includes("active-run"))) {
      throw new ApplicationError(
        "teammate_transfer_active_run",
        "An AI Teammate with an active Run cannot be transferred",
        409,
      );
    }
    const result = await this.repositories.teammates.transfer({
      teammateId: teammate.id,
      actorPrincipalId: input.actorPrincipalId,
      expectedVersion: value.expectedVersion,
      toOwnerPrincipalId: value.toOwnerPrincipalId,
      reason: value.reason,
    });
    if (result === undefined) {
      throw new ApplicationError(
        "teammate_not_found",
        "AI Teammate not found",
        404,
      );
    }
    if (result === "revision_conflict") {
      throw new ApplicationError(
        "teammate_revision_conflict",
        "AI Teammate was changed by another request",
        409,
      );
    }
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: "transfer",
      actorPrincipalId: input.actorPrincipalId,
      summary: `AI Teammate 转派给 ${value.toOwnerPrincipalId}`,
      data: {
        from: teammate.ownerPrincipalId,
        to: value.toOwnerPrincipalId,
        reason: value.reason,
      },
    });
    return result;
  }

  async parseWorkPlan(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly value: unknown;
  }): Promise<ParsedTeammateWorkPlan> {
    const parsed = parseTeammateWorkPlanInputSchema.parse(input.value);
    const teammate = await this.teammateForRead(
      input.teammateId,
      input.actorPrincipalId,
    );
    return parseTeammateWorkPlan({
      teammate,
      instruction: parsed.instruction,
    });
  }

  async createWorkPlan(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
    readonly value: CreateTeammateWorkPlanInput;
  }): Promise<{
    readonly planId: string;
    readonly taskIds: readonly string[];
    readonly queue: readonly TeammateQueueItem[];
  }> {
    const value = createTeammateWorkPlanInputSchema.parse(input.value);
    const teammate = await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    if (teammate.status !== "active") {
      throw new ApplicationError(
        "teammate_not_active",
        "Only an active AI Teammate can receive generated tasks",
        409,
      );
    }
    const project = await this.repositories.projects.get(teammate.projectId);
    if (project?.status !== "active") {
      throw new ApplicationError(
        "project_archived",
        "Archived projects cannot receive generated tasks",
        409,
      );
    }
    await this.requireProjectPermission(
      teammate.projectId,
      teammate.aiPrincipalId,
      "write",
    );
    if (value.items.length > 20) {
      throw new ApplicationError(
        "teammate_work_plan_too_large",
        "A work plan can generate at most 20 tasks",
        400,
      );
    }
    const result = await this.repositories.teammates.createWorkPlan({
      teammate,
      actorPrincipalId: input.actorPrincipalId,
      instruction: value.instruction,
      items: value.items,
      autoExecuteEligible: value.autoExecuteEligible,
    });
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: "work-plan",
      actorPrincipalId: input.actorPrincipalId,
      summary: `生成 ${result.taskIds.length} 个受限任务`,
      data: {
        planId: result.planId,
        taskIds: result.taskIds,
        autoExecuteEligible: value.autoExecuteEligible,
      },
    });
    return {
      ...result,
      queue: await this.getWorkQueue(teammate.id, input.actorPrincipalId),
    };
  }

  async getWorkQueue(
    teammateId: string,
    actorPrincipalId: string,
  ): Promise<readonly TeammateQueueItem[]> {
    const teammate = await this.teammateForRead(teammateId, actorPrincipalId);
    const queue = await this.repositories.teammates.listWorkQueue(teammate.id);
    const enriched: TeammateQueueItem[] = [];
    for (const item of queue) {
      const resolved = await this.repositories.taskExecutionPolicies.resolve({
        contextType: "task",
        contextId: item.taskId,
        projectId: teammate.projectId,
      });
      const requiresApproval =
        resolved.policy.toolPolicy.requireApproval.length > 0 ||
        resolved.policy.humanGates.some(
          (gate) => (gate.enforcement ?? "blocking") === "blocking",
        );
      const blockedReasons = [...item.blockedReasons];
      if (requiresApproval) blockedReasons.push("approval-required");
      enriched.push({
        ...item,
        blockedReasons,
        autoEligible: blockedReasons.length === 0,
      });
    }
    return enriched;
  }

  async reorderWorkQueue(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly administrator: boolean;
    readonly value: ReorderTeammateQueueInput;
  }): Promise<readonly TeammateQueueItem[]> {
    const value = reorderTeammateQueueInputSchema.parse(input.value);
    const teammate = await this.teammateForManage(
      input.teammateId,
      input.actorPrincipalId,
      input.administrator,
    );
    try {
      await this.repositories.teammates.reorderWorkQueue(
        teammate.id,
        value.taskIds,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("every active item")
      ) {
        throw new ApplicationError(
          "teammate_queue_reorder_conflict",
          "The queue changed before the reorder was applied",
          409,
        );
      }
      throw error;
    }
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: "queue",
      actorPrincipalId: input.actorPrincipalId,
      summary: "调整 AI Teammate 工作队列顺序",
      data: { taskIds: value.taskIds },
    });
    return this.getWorkQueue(teammate.id, input.actorPrincipalId);
  }

  async statistics(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly from?: Date;
    readonly to?: Date;
  }): Promise<TeammateRuntimeStatistics> {
    const teammate = await this.teammateForRead(
      input.teammateId,
      input.actorPrincipalId,
    );
    const runIds = await this.repositories.teammates.listAttributionRunIds({
      teammateId: teammate.id,
      from: input.from,
      to: input.to,
    });
    const sources = (
      await Promise.all(
        runIds.map((runId) =>
          this.repositories.runtimeEconomics.getRunSources(runId),
        ),
      )
    ).filter(
      (source): source is NonNullable<typeof source> => source !== undefined,
    );
    let usage = EMPTY_USAGE;
    let durations = EMPTY_DURATIONS;
    const reconciliation = {
      reconciled: 0,
      unknown: 0,
      incomplete: 0,
      inconsistent: 0,
    };
    const unknownSamples = {
      provider: 0,
      model: 0,
      token: 0,
      cost: 0,
      duration: 0,
    };
    for (const source of sources) {
      const economics = executionEconomics(source);
      usage = addRuntimeUsageSummaries(usage, economics.usage);
      durations = addDurations(durations, economics.durations);
      reconciliation[economics.reconciliation.status] += 1;
      if (economics.provider === null) unknownSamples.provider += 1;
      if (economics.model === null) unknownSamples.model += 1;
      if (
        source.receipts.some((receipt) =>
          receipt.unknownFields.some((field) =>
            ["inputTokens", "outputTokens", "totalTokens"].includes(field),
          ),
        )
      ) {
        unknownSamples.token += 1;
      }
      if (
        source.receipts.some((receipt) =>
          receipt.unknownFields.includes("costAmount"),
        )
      ) {
        unknownSamples.cost += 1;
      }
      if (economics.durations.observedTotalMs === 0) {
        unknownSamples.duration += 1;
      }
    }
    return {
      teammateId: teammate.id,
      from: input.from?.toISOString() ?? null,
      to: input.to?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
      runCount: sources.length,
      usage,
      durations,
      reconciliation,
      unknownSamples,
    };
  }

  async executionHistory(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly query: TeammateExecutionHistoryQuery;
  }): Promise<ExecutionHistoryPage> {
    const teammate = await this.teammateForRead(
      input.teammateId,
      input.actorPrincipalId,
    );
    const from =
      input.query.from === undefined ? undefined : new Date(input.query.from);
    const to =
      input.query.to === undefined ? undefined : new Date(input.query.to);
    if (
      from !== undefined &&
      to !== undefined &&
      from.getTime() > to.getTime()
    ) {
      throw new ApplicationError(
        "teammate_execution_history_range_invalid",
        "Execution history range start must not be after its end",
        400,
      );
    }
    const fingerprint = executionHistoryFingerprint({
      workspaceId: teammate.workspaceId,
      teammateId: teammate.id,
      from: input.query.from,
      to: input.query.to,
      runtimeId: input.query.runtimeId,
      contextType: input.query.contextType,
      status: input.query.status,
    });
    let boundary;
    if (input.query.cursor !== undefined && input.query.cursor !== "") {
      try {
        const decoded = decodeExecutionHistoryCursor(input.query.cursor);
        if (
          decoded.workspaceId !== teammate.workspaceId ||
          decoded.fingerprint !== fingerprint
        ) {
          throw new Error("teammate_execution_history_cursor_conflict");
        }
        boundary = {
          createdAt: new Date(decoded.createdAt),
          id: decoded.id,
        };
      } catch {
        throw new ApplicationError(
          "teammate_execution_history_cursor_conflict",
          "Execution history cursor does not match this AI Teammate query",
          409,
        );
      }
    }
    const page = await this.repositories.runtimeEconomics.listExecutionHistory({
      workspaceId: teammate.workspaceId,
      teammateId: teammate.id,
      limit: input.query.limit,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(input.query.runtimeId === undefined
        ? {}
        : { runtimeId: input.query.runtimeId }),
      ...(input.query.contextType === undefined
        ? {}
        : { contextType: input.query.contextType }),
      ...(input.query.status === undefined
        ? {}
        : { status: input.query.status }),
      ...(boundary === undefined ? {} : { boundary }),
    });
    const sources = await Promise.all(
      page.items.map((item) =>
        this.repositories.runtimeEconomics.getRunSources(item.runId),
      ),
    );
    const items = sources
      .filter(
        (source): source is NonNullable<typeof source> => source !== undefined,
      )
      .map((source) => executionHistoryItem(source));
    const last = page.items.at(-1);
    return {
      workspaceId: teammate.workspaceId,
      items,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeExecutionHistoryCursor({
              workspaceId: teammate.workspaceId,
              fingerprint,
              createdAt: last.createdAt,
              id: last.runId,
            })
          : null,
      queryFingerprint: fingerprint,
    };
  }

  async weeklyReport(input: {
    readonly teammateId: string;
    readonly actorPrincipalId: string;
    readonly weekStart?: string;
    readonly generatedBy?: string;
  }): Promise<TeammateWeeklyReport> {
    const teammate = await this.teammateForRead(
      input.teammateId,
      input.actorPrincipalId,
    );
    const range = weekRange(input.weekStart);
    const statistics = await this.statistics({
      teammateId: teammate.id,
      actorPrincipalId: input.actorPrincipalId,
      from: range.start,
      to: range.endExclusive,
    });
    const summary = await this.repositories.teammates.taskStatusSummary({
      teammateId: teammate.id,
      from: range.start,
      to: range.endExclusive,
    });
    const report = await this.repositories.teammates.saveWeeklyReport({
      teammateId: teammate.id,
      projectId: teammate.projectId,
      weekStart: range.startText,
      weekEnd: range.endText,
      summary,
      statistics,
      generatedBy: input.generatedBy ?? input.actorPrincipalId,
    });
    await this.repositories.teammates.recordEvent({
      teammateId: teammate.id,
      kind: "report",
      actorPrincipalId: input.generatedBy ?? input.actorPrincipalId,
      summary: `生成 ${range.startText} 周报`,
      data: { weekStart: range.startText, weekEnd: range.endText },
    });
    return report;
  }

  async runAutoQueue(
    limit = 4,
    manual?: {
      readonly teammateId: string;
      readonly actorPrincipalId: string;
      readonly administrator: boolean;
    },
  ): Promise<{
    readonly attempted: number;
    readonly dispatched: number;
    readonly skipped: number;
  }> {
    if (this.dispatchTask === undefined) {
      throw new ApplicationError(
        "teammate_dispatch_unavailable",
        "AI Teammate dispatch is unavailable",
        503,
      );
    }
    if (manual !== undefined) {
      await this.teammateForManage(
        manual.teammateId,
        manual.actorPrincipalId,
        manual.administrator,
      );
    }
    let attempted = 0;
    let dispatched = 0;
    let skipped = 0;
    const excluded = new Set<string>();
    for (let index = 0; index < limit; index += 1) {
      const candidate = await this.repositories.teammates.claimAutoRunCandidate(
        {
          ownerId: "system:teammate-auto",
          leaseSeconds: 60,
          excludedTeammateIds: [...excluded],
          teammateId: manual?.teammateId,
        },
      );
      if (candidate === undefined) {
        break;
      }
      excluded.add(candidate.teammate.id);
      attempted += 1;
      try {
        await this.requireProjectPermission(
          candidate.teammate.projectId,
          candidate.teammate.aiPrincipalId,
          "write",
        );
        const resolved = await this.repositories.taskExecutionPolicies.resolve({
          contextType: "task",
          contextId: candidate.task.id,
          projectId: candidate.teammate.projectId,
        });
        if (
          resolved.policy.toolPolicy.requireApproval.length > 0 ||
          resolved.policy.humanGates.some(
            (gate) => (gate.enforcement ?? "blocking") === "blocking",
          )
        ) {
          skipped += 1;
          await this.repositories.teammates.releaseAutoRunClaim({
            teammateId: candidate.teammate.id,
            taskId: candidate.task.id,
            claimToken: candidate.claimToken,
          });
          await this.repositories.teammates.recordEvent({
            teammateId: candidate.teammate.id,
            kind: "auto-run",
            actorPrincipalId: candidate.teammate.aiPrincipalId,
            summary: "自动执行跳过需要 Execution Gate 的任务",
            data: {
              taskId: candidate.task.id,
              reason: "approval-required",
            },
          });
          continue;
        }
        const { runId } = await this.dispatchTask(
          candidate.task.id,
          candidate.teammate.aiPrincipalId,
        );
        await this.repositories.teammates.releaseAutoRunClaim({
          teammateId: candidate.teammate.id,
          taskId: candidate.task.id,
          claimToken: candidate.claimToken,
        });
        dispatched += 1;
        await this.repositories.teammates.recordEvent({
          teammateId: candidate.teammate.id,
          kind: "auto-run",
          actorPrincipalId: candidate.teammate.aiPrincipalId,
          summary: "AI Teammate 自动派发任务",
          data: { taskId: candidate.task.id, runId },
        });
      } catch (error) {
        skipped += 1;
        await this.repositories.teammates.releaseAutoRunClaim({
          teammateId: candidate.teammate.id,
          taskId: candidate.task.id,
          claimToken: candidate.claimToken,
        });
        await this.repositories.teammates.recordEvent({
          teammateId: candidate.teammate.id,
          kind: "auto-run",
          actorPrincipalId: candidate.teammate.aiPrincipalId,
          summary: "AI Teammate 自动执行未派发",
          data: {
            taskId: candidate.task.id,
            reason:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : "unknown",
          },
        });
      }
    }
    return { attempted, dispatched, skipped };
  }

  async generateDueWeeklyReports(now = new Date()): Promise<{
    readonly generated: number;
    readonly skipped: number;
  }> {
    const range = weekRange(previousWeekStart(now));
    const teammates =
      await this.repositories.teammates.listWeeklyReportCandidates();
    let generated = 0;
    let skipped = 0;
    for (const teammate of teammates) {
      const existing = await this.repositories.teammates.listWeeklyReports(
        teammate.id,
      );
      if (existing.some((report) => report.weekStart === range.startText)) {
        skipped += 1;
        continue;
      }
      try {
        await this.weeklyReport({
          teammateId: teammate.id,
          actorPrincipalId: teammate.aiPrincipalId,
          weekStart: range.startText,
          generatedBy: "system:teammate-worker",
        });
        generated += 1;
      } catch {
        skipped += 1;
      }
    }
    return { generated, skipped };
  }
}
