import { createHash } from "node:crypto";
import {
  WORKFLOW_ASSIGNMENT_BINDINGS_FLAG,
  WORKFLOW_PLATFORM_TEMPLATES_FLAG,
  type DispatchMode,
  type ProjectRoleMappingPreset,
  type Task,
  type TemplatePortability,
  type UpdateWorkflowDefinitionInput,
  type WorkflowAssignmentSource,
  type WorkflowBindingOverride,
  type WorkflowBlockingRisk,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowInstance,
  type WorkflowInstanceBindings,
  type WorkflowInstancePreflight,
  type WorkflowInstancePreflightInput,
  type WorkflowInstancePreflightNode,
  type WorkflowPrincipalRef,
} from "@pluginmax/contracts";
import type {
  PlatformRepositories,
  WorkflowBindingSeed,
} from "@pluginmax/database";

const implementedRuntimeKinds = new Set([
  "fake",
  "dsh-sdk",
  "codex-jsonl",
  "plain-text",
]);

const fixedKinds = new Set(["user", "agent", "employee"]);

export type WorkflowAssignmentErrorCode =
  | "workflow_assignment_bindings_disabled"
  | "workflow_platform_templates_disabled"
  | "workflow_definition_not_found"
  | "workflow_definition_not_readable"
  | "workflow_definition_not_published"
  | "workflow_definition_manage_forbidden"
  | "workflow_target_project_write_required"
  | "workflow_definition_version_conflict"
  | "workflow_preflight_blocked"
  | "workflow_binding_revision_conflict"
  | "workflow_binding_already_started"
  | "project_role_mapping_preset_role_mismatch"
  | "project_role_mapping_preset_conflict"
  | "workflow_definition_revision_conflict";

export class WorkflowAssignmentError extends Error {
  constructor(
    readonly code: WorkflowAssignmentErrorCode,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowAssignmentError";
  }
}

export interface WorkflowPreflightResolution {
  readonly definition: WorkflowDefinition;
  readonly graph: WorkflowGraph;
  readonly projectId: string;
  readonly preflight: WorkflowInstancePreflight;
  readonly bindingSeed: WorkflowBindingSeed;
}

interface ResolvedNode {
  readonly node: WorkflowGraphNode;
  readonly preflight: WorkflowInstancePreflightNode;
  readonly approverSeeds: WorkflowBindingSeed["approvers"];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function risk(
  code: string,
  message: string,
  actions: readonly string[] = [],
): WorkflowBlockingRisk {
  return { code, message, actions: [...actions] };
}

function roleCodeFor(
  node: WorkflowGraphNode,
  ownerProjectId: string,
  ownerRoles: readonly { id: string; code: string }[],
): string | null {
  if (node.executor.kind !== "role") return null;
  if (node.executor.roleCode !== undefined) return node.executor.roleCode;
  return (
    ownerRoles.find((role) => role.id === node.executor.id)?.code ??
    (node.executor.id.match(/^[A-Z][A-Z0-9_]*$/) ? node.executor.id : null)
  );
}

function sourceFor(
  node: WorkflowGraphNode,
  roleCode: string | null,
  resolvedRoleId?: string,
): WorkflowAssignmentSource {
  return {
    kind: node.executor.kind,
    sourceId: resolvedRoleId ?? node.executor.id,
    roleCode,
    label: node.executor.label ?? null,
  };
}

function portabilityFor(
  node: WorkflowGraphNode,
  definition: WorkflowDefinition,
): TemplatePortability {
  if (node.executor.portability !== undefined) {
    return node.executor.portability;
  }
  return definition.scope === "platform" ? "suggested" : "required";
}

function dispatchModeFor(
  node: WorkflowGraphNode,
  override: WorkflowBindingOverride | undefined,
): DispatchMode {
  if (node.type === "approval") return "assigned";
  return (
    override?.dispatchMode ??
    node.executor.dispatchMode ??
    (node.executor.kind === "role" ? "claim" : "assigned")
  );
}

function principalRef(input: {
  principalId: string;
  actorId: string;
  displayName: string;
  kind: "human" | "agent";
}): WorkflowPrincipalRef {
  return {
    principalId: input.principalId,
    actorId: input.actorId,
    displayName: input.displayName,
    kind: input.kind,
  };
}

export class WorkflowAssignmentService {
  constructor(private readonly repositories: PlatformRepositories) {}

  async isEnabled(projectId: string | null = null): Promise<boolean> {
    return this.repositories.featureFlags.isEnabled(
      WORKFLOW_ASSIGNMENT_BINDINGS_FLAG,
      projectId,
    );
  }

  async listPlatformTemplates(
    actorId: string,
  ): Promise<WorkflowDefinition[]> {
    await this.requireActivePrincipal(actorId);
    if (
      !(await this.repositories.featureFlags.isEnabled(
        WORKFLOW_PLATFORM_TEMPLATES_FLAG,
      ))
    ) {
      throw new WorkflowAssignmentError(
        "workflow_platform_templates_disabled",
        "Platform workflow templates are disabled",
      );
    }
    return this.repositories.workflows.listPlatformTemplates();
  }

  async getReadableDefinition(
    workflowId: string,
    actorId: string,
  ): Promise<WorkflowDefinition> {
    await this.requireActivePrincipal(actorId);
    const definition = await this.requireDefinition(workflowId);
    if (definition.scope === "platform") {
      if (
        !(await this.repositories.featureFlags.isEnabled(
          WORKFLOW_PLATFORM_TEMPLATES_FLAG,
        ))
      ) {
        throw new WorkflowAssignmentError(
          "workflow_platform_templates_disabled",
          "Platform workflow templates are disabled",
        );
      }
      if (definition.status !== "active" || definition.publishedAt === null) {
        throw new WorkflowAssignmentError(
          "workflow_definition_not_published",
          "The platform workflow template is not active and published",
          404,
        );
      }
      return definition;
    }
    await this.requireProjectRead(definition.ownerProjectId, actorId);
    return definition;
  }

  async updateDefinition(
    workflowId: string,
    input: UpdateWorkflowDefinitionInput,
    actorId: string,
    administrator: boolean,
  ): Promise<WorkflowDefinition> {
    const definition = await this.requireDefinition(workflowId);
    if (definition.scope === "platform") {
      await this.requirePlatformTemplateManage(actorId, administrator);
    } else {
      await this.requireProjectWrite(definition.ownerProjectId, actorId);
    }
    const updated = await this.repositories.workflows.update(
      workflowId,
      {
        expectedRevision: input.expectedRevision,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.sourceMarkdown === undefined
          ? {}
          : { sourceMarkdown: input.sourceMarkdown }),
      },
    );
    if (updated === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_revision_conflict",
        "Workflow definition revision changed",
      );
    }
    await this.repositories.identityAdministration.appendAuditEvent({
      action: "workflow.template.updated",
      decision: "allowed",
      actorPrincipalId: actorId,
      subjectPrincipalId: actorId,
      metadata: {
        workflowId,
        ownerProjectId: definition.ownerProjectId,
        scope: definition.scope,
        previousRevision: definition.revision,
        revision: updated.revision,
      },
    });
    return updated;
  }

  async publishDefinition(
    workflowId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<WorkflowDefinition> {
    await this.requireActivePrincipal(actorId);
    if (
      !(await this.repositories.featureFlags.isEnabled(
        WORKFLOW_PLATFORM_TEMPLATES_FLAG,
      ))
    ) {
      throw new WorkflowAssignmentError(
        "workflow_platform_templates_disabled",
        "Platform workflow templates are disabled",
      );
    }
    const definition = await this.requireDefinition(workflowId);
    if (definition.scope !== "platform") {
      await this.requirePlatformTemplateManage(actorId, administrator);
    } else {
      await this.requirePlatformTemplateManage(actorId, administrator);
    }
    const published = await this.repositories.workflows.publish(
      workflowId,
      actorId,
    );
    if (published === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_found",
        "Workflow definition not found",
        404,
      );
    }
    await this.repositories.identityAdministration.appendAuditEvent({
      action: "workflow.template.published",
      decision: "allowed",
      actorPrincipalId: actorId,
      subjectPrincipalId: actorId,
      metadata: {
        workflowId,
        ownerProjectId: definition.ownerProjectId,
        definitionVersion: published.graph?.version ?? 1,
        revision: published.revision,
      },
    });
    return published;
  }

  async unpublishDefinition(
    workflowId: string,
    actorId: string,
    administrator: boolean,
  ): Promise<WorkflowDefinition> {
    await this.repositories.featureFlags.isEnabled(
      WORKFLOW_PLATFORM_TEMPLATES_FLAG,
    ).then((enabled) => {
      if (!enabled) {
        throw new WorkflowAssignmentError(
          "workflow_platform_templates_disabled",
          "Platform workflow templates are disabled",
        );
      }
    });
    await this.requirePlatformTemplateManage(actorId, administrator);
    const definition = await this.requireDefinition(workflowId);
    if (definition.scope !== "platform") {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_published",
        "The workflow is not a platform template",
        404,
      );
    }
    const unpublished = await this.repositories.workflows.unpublish(
      workflowId,
      actorId,
    );
    if (unpublished === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_found",
        "Workflow definition not found",
        404,
      );
    }
    await this.repositories.identityAdministration.appendAuditEvent({
      action: "workflow.template.unpublished",
      decision: "allowed",
      actorPrincipalId: actorId,
      subjectPrincipalId: actorId,
      metadata: {
        workflowId,
        ownerProjectId: definition.ownerProjectId,
        definitionVersion: definition.graph?.version ?? 1,
        revision: unpublished.revision,
      },
    });
    return unpublished;
  }

  async preflight(input: {
    readonly workflowId: string;
    readonly actorId: string;
    readonly input: WorkflowInstancePreflightInput;
  }): Promise<WorkflowPreflightResolution> {
    await this.requireActivePrincipal(input.actorId);
    const definition = await this.requireDefinition(input.workflowId);
    const graph = definition.graph;
    if (graph === null) {
      throw new WorkflowAssignmentError(
        "workflow_preflight_blocked",
        "Workflow has no executable graph",
        409,
        [risk("workflow_graph_missing", "Workflow has no executable graph")],
      );
    }
    const targetProjectId = input.input.projectId ?? definition.ownerProjectId;
    return this.resolve({
      definition,
      graph,
      projectId: targetProjectId,
      actorId: input.actorId,
      overrides: input.input.bindingOverrides,
      ...(input.input.expectedDefinitionVersion === undefined
        ? {}
        : {
            expectedDefinitionVersion:
              input.input.expectedDefinitionVersion,
          }),
    });
  }

  async replaceInstanceBindings(input: {
    readonly instance: WorkflowInstance;
    readonly actorId: string;
    readonly expectedBindingRevision: string;
    readonly overrides: readonly WorkflowBindingOverride[];
    readonly sourceChangeReason: string;
  }): Promise<WorkflowInstanceBindings> {
    const definition = await this.requireDefinition(input.instance.workflowId);
    const graph = input.instance.graph;
    if (graph === null) {
      throw new WorkflowAssignmentError(
        "workflow_preflight_blocked",
        "Workflow has no executable graph",
      );
    }
    await this.requireProjectWrite(input.instance.projectId, input.actorId);
    if (!(await this.isEnabled(input.instance.projectId))) {
      throw new WorkflowAssignmentError(
        "workflow_assignment_bindings_disabled",
        "Workflow assignment bindings are disabled",
      );
    }
    const resolved = await this.resolve({
      definition,
      graph,
      projectId: input.instance.projectId,
      actorId: input.actorId,
      overrides: input.overrides,
    });
    this.requireCanStart(resolved.preflight);
    if (
      input.instance.bindingRevision !== input.expectedBindingRevision ||
      resolved.preflight.bindingRevision !== input.expectedBindingRevision
    ) {
      throw new WorkflowAssignmentError(
        "workflow_binding_revision_conflict",
        "Workflow bindings changed by another request",
      );
    }
    try {
      await this.repositories.workflowAssignments.replaceBindings({
        instanceId: input.instance.id,
        expectedBindingRevision: input.expectedBindingRevision,
        bindingRevision: resolved.preflight.bindingRevision,
        actorId: input.actorId,
        sourceChangeReason: input.sourceChangeReason,
        ...resolved.bindingSeed,
      });
    } catch (error) {
      if (error instanceof WorkflowAssignmentError) throw error;
      throw this.translateRepositoryError(error);
    }
    return this.getBindings(input.instance.id);
  }

  async getBindings(instanceId: string): Promise<WorkflowInstanceBindings> {
    const [instance, assignments, approvers] = await Promise.all([
      this.repositories.workflowRuntime.get(instanceId),
      this.repositories.workflowAssignments.listAssignments(instanceId),
      this.repositories.workflowAssignments.listApprovers(instanceId),
    ]);
    if (instance === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_found",
        "Workflow instance not found",
        404,
      );
    }
    return {
      instanceId,
      bindingRevision:
        instance.bindingRevision ??
        digest({ instanceId, assignments, approvers }),
      assignments,
      approvers,
    };
  }

  async listPresets(projectId: string): Promise<ProjectRoleMappingPreset[]> {
    return this.repositories.workflowAssignments.listPresets(projectId);
  }

  async upsertPreset(input: {
    readonly projectId: string;
    readonly roleId: string;
    readonly assignees: readonly string[];
    readonly actorId: string;
    readonly expectedRevision?: number;
  }): Promise<ProjectRoleMappingPreset> {
    if (!(await this.isEnabled(input.projectId))) {
      throw new WorkflowAssignmentError(
        "workflow_assignment_bindings_disabled",
        "Workflow assignment bindings are disabled",
      );
    }
    const members =
      await this.repositories.projectMemberships.listMembers(input.projectId);
    const active = new Set(
      members
        .filter((member) => member.status === "active")
        .map((member) => member.principalId ?? member.actorId),
    );
    if (input.assignees.some((principalId) => !active.has(principalId))) {
      throw new WorkflowAssignmentError(
        "project_role_mapping_preset_role_mismatch",
        "Preset assignees must be active members of the target project",
        400,
      );
    }
    try {
      const preset = await this.repositories.workflowAssignments.upsertPreset(
        input,
      );
      await this.repositories.identityAdministration.appendAuditEvent({
        action: "workflow.role_mapping_preset.updated",
        decision: "allowed",
        actorPrincipalId: input.actorId,
        subjectPrincipalId: input.actorId,
        metadata: {
          projectId: input.projectId,
          roleId: input.roleId,
          assignees: input.assignees,
          revision: preset.revision,
        },
      });
      return preset;
    } catch (error) {
      throw this.translateRepositoryError(error);
    }
  }

  async deletePreset(input: {
    readonly projectId: string;
    readonly roleId: string;
    readonly actorId: string;
  }): Promise<boolean> {
    if (!(await this.isEnabled(input.projectId))) {
      throw new WorkflowAssignmentError(
        "workflow_assignment_bindings_disabled",
        "Workflow assignment bindings are disabled",
      );
    }
    const deleted = await this.repositories.workflowAssignments.deletePreset(
      input.projectId,
      input.roleId,
    );
    if (deleted) {
      await this.repositories.identityAdministration.appendAuditEvent({
        action: "workflow.role_mapping_preset.deleted",
        decision: "allowed",
        actorPrincipalId: input.actorId,
        subjectPrincipalId: input.actorId,
        metadata: {
          projectId: input.projectId,
          roleId: input.roleId,
        },
      });
    }
    return deleted;
  }

  async recordTaskClaim(task: Task, claimantPrincipalId: string): Promise<void> {
    const assignment =
      await this.repositories.workflowAssignments.findClaimAssignment(task.id);
    if (assignment === undefined) return;
    if (
      !assignment.candidatePool.some(
        (candidate) => candidate.principalId === claimantPrincipalId,
      )
    ) {
      await this.repositories.workflowRuntime.appendAudit(
        assignment.instanceId,
        claimantPrincipalId,
        {
          kind: "node.claim_rejected",
          nodeId: assignment.nodeId,
          summary: "认领主体不在候选池",
          data: { taskId: task.id, claimantPrincipalId },
        },
      );
      return;
    }
    const instance = await this.repositories.workflowRuntime.get(
      assignment.instanceId,
    );
    if (instance === undefined) return;
    const runtime = structuredClone(instance.runtime);
    const node = runtime.nodes.find(
      (candidate) => candidate.nodeId === assignment.nodeId,
    );
    if (node === undefined) return;
    node.status = "running";
    node.startedAt ??= new Date().toISOString();
    node.taskId = task.id;
    await this.repositories.workflowRuntime.save(
      instance.id,
      instance.revision,
      {
        runtime,
        status: "active",
        actorId: claimantPrincipalId,
        audits: [
          {
            kind: "node.claimed",
            nodeId: assignment.nodeId,
            summary: `节点“${node.name}”已由 ${claimantPrincipalId} 认领`,
            data: { taskId: task.id, claimantPrincipalId },
          },
        ],
      },
    );
  }

  async resolve(input: {
    readonly definition: WorkflowDefinition;
    readonly graph: WorkflowGraph;
    readonly projectId: string;
    readonly actorId: string;
    readonly overrides: readonly WorkflowBindingOverride[];
    readonly expectedDefinitionVersion?: number;
  }): Promise<WorkflowPreflightResolution> {
    const [project, assignmentsEnabled, platformEnabled, ownerRoles, roles, members, presets, policy] =
      await Promise.all([
        this.repositories.projects.get(input.projectId),
        this.isEnabled(input.projectId),
        this.repositories.featureFlags.isEnabled(
          WORKFLOW_PLATFORM_TEMPLATES_FLAG,
        ),
        this.repositories.projectMemberships.listRoles(
          input.definition.ownerProjectId,
        ),
        this.repositories.projectMemberships.listRoles(input.projectId),
        this.repositories.projectMemberships.listMembers(input.projectId),
        this.repositories.workflowAssignments.listPresets(input.projectId),
        this.repositories.taskExecutionPolicies.resolve({
          contextType: "project",
          contextId: input.projectId,
          projectId: input.projectId,
        }),
      ]);
    if (project === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_found",
        "Target project not found",
        404,
      );
    }
    const globalRisks: WorkflowBlockingRisk[] = [];
    if (!assignmentsEnabled) {
      globalRisks.push(
        risk(
          "workflow_assignment_bindings_disabled",
          "Workflow assignment bindings are disabled",
          ["enable workflow.assignment_bindings"],
        ),
      );
    }
    if (input.definition.scope === "platform") {
      if (!platformEnabled) {
        globalRisks.push(
          risk(
            "workflow_platform_templates_disabled",
            "Platform workflow templates are disabled",
            ["enable workflow.platform_templates"],
          ),
        );
      }
      if (
        input.definition.status !== "active" ||
        input.definition.publishedAt === null
      ) {
        globalRisks.push(
          risk(
            "workflow_definition_not_published",
            "The platform workflow template is not active and published",
          ),
        );
      }
    } else if (input.projectId !== input.definition.ownerProjectId) {
      globalRisks.push(
        risk(
          "workflow_project_scope_mismatch",
          "A project workflow can only be instantiated in its owner project",
        ),
      );
    }
    const authorization = await this.authorizationDecision(
      input.projectId,
      input.actorId,
      "write",
    );
    if (!authorization.allowed) {
      globalRisks.push(
        risk(
          "workflow_target_project_write_required",
          "Target project write permission is required to instantiate this workflow",
          ["grant project write access"],
        ),
      );
    }
    if (
      input.expectedDefinitionVersion !== undefined &&
      input.expectedDefinitionVersion !== input.graph.version
    ) {
      globalRisks.push(
        risk(
          "workflow_definition_version_conflict",
          `Expected definition version ${input.expectedDefinitionVersion}, current version is ${input.graph.version}`,
        ),
      );
    }
    const overrideMap = new Map(
      input.overrides.map((override) => [override.nodeId, override]),
    );
    const nodeIds = new Set(input.graph.nodes.map((node) => node.id));
    for (const nodeId of overrideMap.keys()) {
      if (!nodeIds.has(nodeId)) {
        globalRisks.push(
          risk(
            "workflow_binding_override_node_unknown",
            `Binding override references unknown node ${nodeId}`,
          ),
        );
      }
    }
    const membersByPrincipal = new Map(
      members.map((member) => [
        member.principalId ?? member.actorId,
        member,
      ]),
    );
    const membersByActor = new Map(
      members.map((member) => [member.actorId, member]),
    );
    const presetByRole = new Map(
      presets.map((preset) => [preset.roleId, preset]),
    );
    const runtimeRevisions = new Set<number>();
    const policyRevisions = new Set<number>([policy.revision]);
    const resolvedNodes: ResolvedNode[] = [];

    for (const node of input.graph.nodes) {
      if (!["task", "approval"].includes(node.type)) {
        const source = sourceFor(node, null);
        resolvedNodes.push({
          node,
          preflight: {
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            source,
            dispatchMode: "assigned",
            status: "resolved",
            primaryAssignee: null,
            candidatePool: [],
            approvers: [],
            blockingRisks: [],
          },
          approverSeeds: [],
        });
        continue;
      }
      const override = overrideMap.get(node.id);
      const roleCode = roleCodeFor(
        node,
        input.definition.ownerProjectId,
        ownerRoles,
      );
      const role =
        node.executor.kind === "role"
          ? (roleCode === null
              ? undefined
              : roles.find((candidate) => candidate.code === roleCode))
          : undefined;
      const source = sourceFor(node, roleCode, role?.id);
      const nodeRisks: WorkflowBlockingRisk[] = [];
      if (node.executor.kind === "role" && role === undefined) {
        nodeRisks.push(
          risk(
            "role_slot_unresolved",
            `Role slot ${roleCode ?? node.executor.id} does not exist in the target project`,
            ["create or map the project role", "select an explicit assignee"],
          ),
        );
      }

      if (node.type === "approval") {
        const approverOverride = override?.approverPrincipalIds ?? [];
        const approverRefs: WorkflowPrincipalRef[] = [];
        const approverSeeds: Array<
          WorkflowBindingSeed["approvers"][number]
        > = [];
        for (const approver of node.approvers) {
          const approverRoleCode =
            approver.kind === "role"
              ? (approver.roleCode ??
                ownerRoles.find((candidate) => candidate.id === approver.id)
                  ?.code ??
                (approver.id.match(/^[A-Z][A-Z0-9_]*$/)
                  ? approver.id
                  : null))
              : null;
          const approverRole =
            approver.kind === "role" && approverRoleCode !== null
              ? roles.find((candidate) => candidate.code === approverRoleCode)
              : undefined;
          if (approver.kind === "role" && approverRole === undefined) {
            nodeRisks.push(
              risk(
                "approval_role_unresolved",
                `Approval role ${approverRoleCode ?? approver.id} does not exist in the target project`,
              ),
            );
            continue;
          }
          const candidates =
            approver.kind === "role"
              ? members.filter(
                  (member) =>
                    member.kind === "human" &&
                    member.status === "active" &&
                    member.roles.some(
                      (candidateRole) => candidateRole.id === approverRole?.id,
                    ),
                )
              : members.filter(
                  (member) =>
                    member.kind === "human" &&
                    member.status === "active" &&
                    member.actorId === approver.id,
                );
          if (candidates.length === 0 && approverOverride.length === 0) {
            nodeRisks.push(
              risk(
                "approval_assignee_unresolved",
                `Approval slot ${approverRoleCode ?? approver.id} has no active human member`,
              ),
            );
          }
          for (const candidate of candidates) {
            const ref = principalRef({
              principalId: candidate.principalId ?? candidate.actorId,
              actorId: candidate.actorId,
              displayName: candidate.name,
              kind: candidate.kind,
            });
            approverRefs.push(ref);
          }
        }
        if (approverOverride.length > 0) {
          approverRefs.length = 0;
          for (const principalId of approverOverride) {
            const member = membersByPrincipal.get(principalId);
            if (member === undefined || member.kind !== "human") {
              nodeRisks.push(
                risk(
                  "approval_override_invalid",
                  `Approval override ${principalId} is not an active human project member`,
                ),
              );
              continue;
            }
            approverRefs.push(
              principalRef({
                principalId: member.principalId ?? member.actorId,
                actorId: member.actorId,
                displayName: member.name,
                kind: member.kind,
              }),
            );
          }
        }
        const uniqueApprovers = [
          ...new Map(
            approverRefs.map((approver) => [approver.principalId, approver]),
          ).values(),
        ];
        for (const approver of uniqueApprovers) {
          approverSeeds.push({
            nodeId: node.id,
            principalId: approver.principalId,
            source: sourceFor(node, roleCode, role?.id),
            status: override === undefined ? "resolved" : "overridden",
            resolvedBy: input.actorId,
          });
        }
        const status = uniqueApprovers.length === 0 ? "unresolved" : "resolved";
        resolvedNodes.push({
          node,
          preflight: {
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            source,
            dispatchMode: "assigned",
            status,
            primaryAssignee: uniqueApprovers[0] ?? null,
            candidatePool: uniqueApprovers,
            approvers: uniqueApprovers,
            blockingRisks: nodeRisks,
          },
          approverSeeds,
        });
        continue;
      }

      const dispatchMode = dispatchModeFor(node, override);
      let candidateRefs: WorkflowPrincipalRef[] = [];
      if (node.executor.kind === "role" && role !== undefined) {
        candidateRefs = members
          .filter(
            (member) =>
              member.status === "active" &&
              member.roles.some(
                (candidateRole) => candidateRole.id === role.id,
              ),
          )
          .map((member) =>
            principalRef({
              principalId: member.principalId ?? member.actorId,
              actorId: member.actorId,
              displayName: member.name,
              kind: member.kind,
            }),
          );
        const preset = presetByRole.get(role.id);
        if (preset !== undefined) {
          for (const principalId of preset.assignees) {
            const member = membersByPrincipal.get(principalId);
            if (member === undefined || member.status !== "active") continue;
            if (
              !candidateRefs.some(
                (candidate) => candidate.principalId === principalId,
              )
            ) {
              candidateRefs.push(
                principalRef({
                  principalId,
                  actorId: member.actorId,
                  displayName: member.name,
                  kind: member.kind,
                }),
              );
            }
          }
        }
      } else if (fixedKinds.has(node.executor.kind)) {
        const member = membersByActor.get(node.executor.id);
        if (member !== undefined && member.status === "active") {
          candidateRefs = [
            principalRef({
              principalId: member.principalId ?? member.actorId,
              actorId: member.actorId,
              displayName: member.name,
              kind: member.kind,
            }),
          ];
        }
      }
      if (override?.candidatePrincipalIds.length) {
        candidateRefs = override.candidatePrincipalIds.flatMap(
          (principalId) => {
            const member = membersByPrincipal.get(principalId);
            if (member === undefined || member.status !== "active") {
              nodeRisks.push(
                risk(
                  "candidate_override_invalid",
                  `Candidate ${principalId} is not an active target project member`,
                ),
              );
              return [];
            }
            if (
              node.executor.kind === "role" &&
              role !== undefined &&
              !member.roles.some(
                (candidateRole) => candidateRole.id === role.id,
              )
            ) {
              nodeRisks.push(
                risk(
                  "candidate_role_mismatch",
                  `Candidate ${principalId} does not hold role ${role.code}`,
                ),
              );
              return [];
            }
            return [
              principalRef({
                principalId: member.principalId ?? member.actorId,
                actorId: member.actorId,
                displayName: member.name,
                kind: member.kind,
              }),
            ];
          },
        );
      }
      candidateRefs = [
        ...new Map(
          candidateRefs.map((candidate) => [
            candidate.principalId,
            candidate,
          ]),
        ).values(),
      ];
      let primary: WorkflowPrincipalRef | null = null;
      if (override?.primaryPrincipalId !== undefined) {
        primary =
          candidateRefs.find(
            (candidate) =>
              candidate.principalId === override.primaryPrincipalId,
          ) ?? null;
        if (primary === null) {
          nodeRisks.push(
            risk(
              "assigned_primary_invalid",
              `Primary assignee ${override.primaryPrincipalId} is not an active candidate`,
              ["select a candidate from the target project"],
            ),
          );
        }
      } else if (dispatchMode === "assigned" && candidateRefs.length === 1) {
        primary = candidateRefs[0] ?? null;
      }
      if (dispatchMode === "assigned" && primary === null) {
        nodeRisks.push(
          risk(
            "assigned_primary_required",
            "Assigned dispatch requires exactly one primary assignee",
            ["select one primary assignee"],
          ),
        );
      }
      if (dispatchMode === "claim" && candidateRefs.length === 0) {
        nodeRisks.push(
          risk(
            "claim_candidate_pool_empty",
            "Claim dispatch requires at least one candidate",
            ["select candidate members"],
          ),
        );
      }
      if (
        fixedKinds.has(node.executor.kind) &&
        candidateRefs.length === 0 &&
        portabilityFor(node, input.definition) === "required"
      ) {
        nodeRisks.push(
          risk(
            "fixed_assignee_unavailable",
            "Required fixed assignee is not an active target project member",
            ["remap the node to an active member"],
          ),
        );
      }
      for (const candidate of candidateRefs) {
        if (candidate.kind !== "agent") continue;
        const runtime = await this.runtimeEvidence(
          candidate.actorId,
          input.projectId,
        );
        if (runtime.runtimeRevision !== null) {
          runtimeRevisions.add(runtime.runtimeRevision);
        }
        if (runtime.risk !== undefined) {
          nodeRisks.push(runtime.risk);
        }
      }
      const status =
        nodeRisks.length > 0 || (dispatchMode === "assigned" && primary === null)
          ? "unresolved"
          : override === undefined
            ? "resolved"
            : "overridden";
      resolvedNodes.push({
        node,
        preflight: {
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          source,
          dispatchMode,
          status,
          primaryAssignee: primary,
          candidatePool: candidateRefs,
          approvers: [],
          blockingRisks: nodeRisks,
        },
        approverSeeds: [],
      });
    }

    const bindingRevision = digest({
      definitionId: input.definition.id,
      definitionVersion: input.graph.version,
      projectId: input.projectId,
      nodes: resolvedNodes.map((resolved) => resolved.preflight),
    });
    const canStart =
      globalRisks.length === 0 &&
      resolvedNodes.every(
        (resolved) =>
          !["task", "approval"].includes(resolved.node.type) ||
          (resolved.preflight.status !== "unresolved" &&
            resolved.preflight.blockingRisks.length === 0),
      );
    const preflight: WorkflowInstancePreflight = {
      definitionId: input.definition.id,
      definitionVersion: input.graph.version,
      definitionRevision: input.definition.revision,
      scope: input.definition.scope,
      projectId: input.projectId,
      bindingRevision,
      nodes: resolvedNodes.map((resolved) => resolved.preflight),
      blockingRisks: globalRisks,
      canStart,
      decisionContext: {
        computedAt: new Date().toISOString(),
        authorizationEvidence: [
          `project:${input.projectId}:write:${
            authorization.allowed ? "allowed" : "denied"
          }`,
        ],
        runtimeRevisions: [...runtimeRevisions].sort((left, right) => left - right),
        policyRevisions: [...policyRevisions].sort((left, right) => left - right),
        featureFlags: {
          [WORKFLOW_ASSIGNMENT_BINDINGS_FLAG]: assignmentsEnabled,
          [WORKFLOW_PLATFORM_TEMPLATES_FLAG]: platformEnabled,
        },
      },
    };
    const bindingSeed: WorkflowBindingSeed = {
      assignments: resolvedNodes
        .filter((resolved) => ["task", "approval"].includes(resolved.node.type))
        .map((resolved) => ({
          nodeId: resolved.node.id,
          source: resolved.preflight.source,
          dispatchMode: resolved.preflight.dispatchMode,
          status: resolved.preflight.status,
          primaryPrincipalId:
            resolved.preflight.primaryAssignee?.principalId ?? null,
          candidatePool: resolved.preflight.candidatePool,
          resolvedBy: input.actorId,
          sourceChangeReason:
            overrideMap.get(resolved.node.id)?.sourceChangeReason ?? "",
        })),
      approvers: resolvedNodes.flatMap((resolved) => resolved.approverSeeds),
    };
    return {
      definition: input.definition,
      graph: input.graph,
      projectId: input.projectId,
      preflight,
      bindingSeed,
    };
  }

  requireCanStart(preflight: WorkflowInstancePreflight): void {
    if (preflight.canStart) return;
    const firstRisk =
      preflight.blockingRisks[0] ??
      preflight.nodes.flatMap((node) => node.blockingRisks)[0];
    const code =
      firstRisk?.code === "workflow_assignment_bindings_disabled"
        ? "workflow_assignment_bindings_disabled"
        : firstRisk?.code === "workflow_platform_templates_disabled"
          ? "workflow_platform_templates_disabled"
          : firstRisk?.code === "workflow_target_project_write_required"
            ? "workflow_target_project_write_required"
            : firstRisk?.code === "workflow_definition_version_conflict"
              ? "workflow_definition_version_conflict"
              : "workflow_preflight_blocked";
    throw new WorkflowAssignmentError(
      code,
      firstRisk?.message ?? "Workflow instance preflight is blocked",
      code === "workflow_target_project_write_required" ? 403 : 409,
      preflight,
    );
  }

  private async requireDefinition(
    workflowId: string,
  ): Promise<WorkflowDefinition> {
    const definition = await this.repositories.workflows.get(workflowId);
    if (definition === undefined) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_found",
        "Workflow definition not found",
        404,
      );
    }
    return definition;
  }

  private async requireActivePrincipal(actorId: string): Promise<void> {
    const principal = await this.repositories.authorization.getPrincipal(actorId);
    if (principal?.status !== "active") {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_readable",
        "An active Principal is required",
        403,
      );
    }
  }

  private async requirePlatformTemplateManage(
    actorId: string,
    administrator: boolean,
  ): Promise<void> {
    await this.requireActivePrincipal(actorId);
    if (administrator) return;
    const principal = await this.repositories.authorization.getPrincipal(actorId);
    const decision = await this.repositories.authorization.authorizePlatform({
      principalId: actorId,
      authSource: principal?.source === "local" ? "local-development" : "bearer",
      permission: "manage_workflow_templates",
    });
    if (!decision.allowed) {
      throw new WorkflowAssignmentError(
        "workflow_definition_manage_forbidden",
        "Platform workflow template management permission is required",
        403,
      );
    }
  }

  private async requireProjectRead(
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const decision = await this.authorizationDecision(
      projectId,
      actorId,
      "read",
    );
    if (!decision.allowed) {
      throw new WorkflowAssignmentError(
        "workflow_definition_not_readable",
        "Project read permission is required",
        403,
      );
    }
  }

  private async requireProjectWrite(
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const decision = await this.authorizationDecision(
      projectId,
      actorId,
      "write",
    );
    if (!decision.allowed) {
      throw new WorkflowAssignmentError(
        "workflow_target_project_write_required",
        "Target project write permission is required",
        403,
      );
    }
  }

  private async authorizationDecision(
    projectId: string,
    actorId: string,
    permission: "read" | "write",
  ) {
    const principal = await this.repositories.authorization.getPrincipal(actorId);
    return this.repositories.authorization.authorizeProject({
      principalId: actorId,
      authSource: principal?.source === "local" ? "local-development" : "bearer",
      projectId,
      permission,
    });
  }

  private async runtimeEvidence(
    agentId: string,
    projectId: string,
  ): Promise<{
    readonly runtimeRevision: number | null;
    readonly risk?: WorkflowBlockingRisk;
  }> {
    const agent = await this.repositories.agents.get(agentId);
    if (agent === undefined || agent.status !== "active") {
      return {
        runtimeRevision: null,
        risk: risk(
          "assigned_agent_unavailable",
          `Assigned Agent ${agentId} is not active`,
        ),
      };
    }
    if (!implementedRuntimeKinds.has(agent.runtimeKind)) {
      return {
        runtimeRevision: null,
        risk: risk(
          "runtime_adapter_unavailable",
          `Runtime adapter ${agent.runtimeKind} is unavailable`,
        ),
      };
    }
    const binding = await this.repositories.agentRuntimeBindings.getCurrent(
      agentId,
    );
    if (binding === undefined) {
      return { runtimeRevision: 1 };
    }
    const runtime = await this.repositories.externalRuntimes.get(
      binding.runtimeId,
    );
    if (
      binding.status !== "active" ||
      runtime === undefined ||
      runtime.status !== "active"
    ) {
      return {
        runtimeRevision: runtime?.revision ?? null,
        risk: risk(
          "runtime_binding_unavailable",
          `Runtime binding for ${agentId} in project ${projectId} is unavailable`,
        ),
      };
    }
    return { runtimeRevision: runtime.revision };
  }

  private translateRepositoryError(error: unknown): unknown {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      const statusCode =
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 409;
      return new WorkflowAssignmentError(
        error.code as WorkflowAssignmentErrorCode,
        error.message,
        statusCode,
      );
    }
    return error;
  }
}
