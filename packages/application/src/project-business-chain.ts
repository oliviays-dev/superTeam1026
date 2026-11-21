import type {
  AcknowledgeProjectAlertInput,
  AssignProjectAlertInput,
  BindProjectBusinessChainValue,
  BusinessChainSourceRef,
  ProjectAlertDetail,
  ProjectBusinessChainNodeBinding,
  ProjectBusinessChainSettings,
  ProjectFeatureFlagState,
  ProjectProgressNode,
  ProjectProgressOverview,
  ProjectSourceFetchResult,
  ProjectSourceRefreshValue,
  ProjectSourceRefreshResult,
  ProjectSourceSnapshot,
  ResolveProjectAlertInput,
  SuppressProjectAlertInput,
  UnbindProjectBusinessChainInput,
  UpdateProjectFeatureFlagsInput,
} from "@pluginmax/contracts";
import {
  BUSINESS_CHAIN_FLAG,
  PROJECT_SOURCE_MOCK_FLAG,
  projectProgressOverviewSchema,
  projectSourceFetchResultSchema,
} from "@pluginmax/contracts";
import {
  ProjectBusinessChainRepositoryError,
  type PlatformRepositories,
} from "@pluginmax/database";

export interface ProjectSourceAdapterInput {
  readonly projectId: string;
  readonly refs: readonly BusinessChainSourceRef[];
  readonly signal: AbortSignal;
  readonly now: Date;
}

export interface ProjectSourceAdapter {
  readonly kind: string;
  inspect(
    input: ProjectSourceAdapterInput,
  ): Promise<readonly ProjectSourceFetchResult[]>;
}

export interface MockProjectSourceFixture {
  readonly sourceRevision?: string;
  readonly payload?: unknown;
  readonly stale?: boolean;
  readonly failureReason?: string;
  readonly delayMs?: number;
}

export class MockProjectSourceAdapter implements ProjectSourceAdapter {
  readonly kind = "mock";

  constructor(
    private readonly fixtures: Readonly<
      Record<string, MockProjectSourceFixture>
    > = {},
  ) {}

  async inspect(
    input: ProjectSourceAdapterInput,
  ): Promise<ProjectSourceFetchResult[]> {
    const results: ProjectSourceFetchResult[] = [];
    for (const ref of input.refs) {
      const fixture = this.fixtures[ref.refKey] ?? {};
      if (fixture.delayMs !== undefined && fixture.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, fixture.delayMs);
          input.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("source adapter aborted"));
            },
            { once: true },
          );
        });
      }
      const status =
        fixture.failureReason !== undefined
          ? "error"
          : fixture.stale === true
            ? "stale"
            : "fresh";
      results.push(
        projectSourceFetchResultSchema.parse({
          refKey: ref.refKey,
          sourceKind: ref.sourceKind,
          sourceSystem: ref.sourceSystem,
          objectType: ref.objectType,
          objectId: ref.objectId,
          sourceRevision: fixture.sourceRevision ?? `mock:${ref.objectId}:v1`,
          observedAt: input.now.toISOString(),
          effectiveAt: input.now.toISOString(),
          freshUntil: new Date(
            input.now.getTime() + (fixture.stale === true ? -60_000 : 300_000),
          ).toISOString(),
          status,
          payload:
            status === "error" ? null : (fixture.payload ?? mockPayload(ref)),
          failureReason: fixture.failureReason ?? null,
          isMock: true,
        }),
      );
    }
    return results;
  }
}

export class ProjectBusinessChainApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProjectBusinessChainApplicationError";
  }
}

export class ProjectBusinessChainApplicationService {
  private readonly adapters = new Map<string, ProjectSourceAdapter>();

  constructor(
    private readonly repositories: PlatformRepositories,
    adapters?: readonly ProjectSourceAdapter[],
  ) {
    for (const adapter of adapters ?? [new MockProjectSourceAdapter()]) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  async getSettings(projectId: string): Promise<ProjectBusinessChainSettings> {
    const project = await this.requireProject(projectId);
    const [
      businessChainFlag,
      sourceMockFlag,
      template,
      bindingState,
      candidates,
      history,
    ] = await Promise.all([
      this.repositories.projectBusinessChains.getFeatureFlagState(
        BUSINESS_CHAIN_FLAG,
        projectId,
      ),
      this.repositories.projectBusinessChains.getFeatureFlagState(
        PROJECT_SOURCE_MOCK_FLAG,
        projectId,
      ),
      this.repositories.projectBusinessChains.getTemplatePolicy(projectId),
      this.repositories.projectBusinessChains.getBindingState(projectId),
      this.repositories.projectBusinessChains.listCandidates(projectId),
      this.repositories.projectBusinessChains.listBindingHistory(projectId),
    ]);
    const blockedReasons = settingsBlockedReasons({
      projectStatus: project.status,
      businessChainEnabled: businessChainFlag.enabled,
      binding: bindingState.binding,
      templateMode: template?.policy.mode ?? null,
      candidates,
    });
    return {
      projectId,
      projectStatus: project.status,
      featureFlags: {
        businessChain: businessChainFlag,
        sourceMock: sourceMockFlag,
      },
      template:
        template === null
          ? null
          : {
              templateId: template.templateId,
              revision: template.templateRevision,
              policy: template.policy,
            },
      binding: bindingState.binding,
      candidates,
      history,
      blockedReasons,
    };
  }

  async bind(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: BindProjectBusinessChainValue;
  }) {
    await this.requireEnabledProject(input.projectId);
    return this.repositories.projectBusinessChains.bind(input);
  }

  async unbind(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: UnbindProjectBusinessChainInput;
  }): Promise<ProjectBusinessChainSettings> {
    await this.requireEnabledProject(input.projectId);
    await this.repositories.projectBusinessChains.unbind({
      projectId: input.projectId,
      actorId: input.actorId,
      expectedRevision: input.value.expectedRevision,
      reason: input.value.reason,
    });
    return this.getSettings(input.projectId);
  }

  async updateFeatureFlags(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: UpdateProjectFeatureFlagsInput;
  }): Promise<ProjectFeatureFlagState[]> {
    await this.requireProject(input.projectId);
    const states: ProjectFeatureFlagState[] = [];
    if (input.value.businessChainEnabled !== undefined) {
      states.push(
        await this.repositories.projectBusinessChains.setProjectFeatureFlag({
          flagKey: BUSINESS_CHAIN_FLAG,
          projectId: input.projectId,
          enabled: input.value.businessChainEnabled,
          expectedRevision: input.value.expectedBusinessChainRevision ?? 0,
          actorId: input.actorId,
        }),
      );
    }
    if (input.value.sourceMockEnabled !== undefined) {
      states.push(
        await this.repositories.projectBusinessChains.setProjectFeatureFlag({
          flagKey: PROJECT_SOURCE_MOCK_FLAG,
          projectId: input.projectId,
          enabled: input.value.sourceMockEnabled,
          expectedRevision: input.value.expectedSourceMockRevision ?? 0,
          actorId: input.actorId,
        }),
      );
    }
    return states;
  }

  async refreshSources(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: ProjectSourceRefreshValue;
  }): Promise<ProjectSourceRefreshResult> {
    await this.requireEnabledProject(input.projectId);
    const binding =
      await this.repositories.projectBusinessChains.getActiveBinding(
        input.projectId,
      );
    if (binding === null) {
      throw sourceRefError("The project has no active business chain");
    }
    const mockFlag =
      await this.repositories.projectBusinessChains.getFeatureFlagState(
        PROJECT_SOURCE_MOCK_FLAG,
        input.projectId,
      );
    const refs = sourceRefsFromBinding(binding.nodeBindings);
    const requested = input.value.refKeys;
    const selected =
      requested === undefined
        ? refs
        : refs.filter((ref) => requested.includes(ref.refKey));
    if (selected.length === 0) {
      throw sourceRefError("The business chain has no source refs to refresh");
    }
    if (selected.some((ref) => ref.sourceKind === "mcp")) {
      throw new ProjectBusinessChainApplicationError(
        "project_source_mcp_worker_only",
        "MCP project sources can only be read through the Worker execution chain",
        403,
      );
    }
    const now = new Date();
    const refsByKind = new Map<string, BusinessChainSourceRef[]>();
    for (const ref of selected) {
      const existing = refsByKind.get(ref.sourceKind) ?? [];
      existing.push(ref);
      refsByKind.set(ref.sourceKind, existing);
    }
    if (refsByKind.has("mock") && !mockFlag.enabled) {
      throw mockDisabledError();
    }
    const groups = await Promise.all(
      [...refsByKind.entries()].map(async ([kind, groupRefs]) => {
        const adapter = this.adapters.get(kind);
        if (adapter === undefined) {
          return groupRefs.map((ref) =>
            failedSourceResult(
              ref,
              now,
              `No source adapter is registered for ${kind}`,
            ),
          );
        }
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          input.value.timeoutMs,
        );
        try {
          const results = await Promise.race([
            adapter.inspect({
              projectId: input.projectId,
              refs: groupRefs,
              signal: controller.signal,
              now,
            }),
            new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("source inspection timed out")),
                { once: true },
              );
            }),
          ]);
          return [...results];
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return groupRefs.map((ref) =>
            failedSourceResult(ref, now, `Source refresh failed: ${reason}`),
          );
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const results = groups.flat();
    if (results.some((result) => result.isMock) && !mockFlag.enabled) {
      throw mockDisabledError();
    }
    const snapshots: ProjectSourceSnapshot[] = [];
    for (const result of results) {
      snapshots.push(
        await this.repositories.projectBusinessChains.recordSourceSnapshot({
          projectId: input.projectId,
          actorId: input.actorId,
          result,
        }),
      );
    }
    return {
      projectId: input.projectId,
      fetchedAt: now.toISOString(),
      snapshots,
      partial: results.some((result) => result.status !== "fresh"),
    };
  }

  async getOverview(projectId: string): Promise<ProjectProgressOverview> {
    const project = await this.requireProject(projectId);
    const [
      flag,
      template,
      bindingState,
      snapshots,
      alerts,
      workflowSummary,
      taskSummary,
    ] = await Promise.all([
      this.repositories.projectBusinessChains.getFeatureFlagState(
        BUSINESS_CHAIN_FLAG,
        projectId,
      ),
      this.repositories.projectBusinessChains.getTemplatePolicy(projectId),
      this.repositories.projectBusinessChains.getBindingState(projectId),
      this.repositories.projectBusinessChains.listSourceSnapshots(projectId),
      this.repositories.projectBusinessChains.listAlerts(projectId),
      this.repositories.projectBusinessChains.getWorkflowSummary(projectId),
      this.repositories.projectBusinessChains.getTaskSummary(projectId),
    ]);
    const generatedAt = new Date();
    const binding = bindingState.binding;
    const snapshotGroups = groupSnapshots(snapshots);
    const sources =
      binding === null
        ? []
        : sourceRefsFromBinding(binding.nodeBindings).map((ref) =>
            sourceCoverage(
              ref,
              snapshotGroups.get(ref.refKey) ?? [],
              generatedAt,
            ),
          );
    const nodes =
      binding === null
        ? []
        : projectNodes(
            binding.definitionSnapshot.nodes,
            binding.nodeBindings,
            snapshotGroups,
            generatedAt,
          );
    const blockedReasons = overviewBlockedReasons({
      enabled: flag.enabled,
      projectStatus: project.status,
      bindingMissing: binding === null,
      templateMode: template?.policy.mode ?? null,
      sources,
    });
    const coverageStatus = aggregateCoverageStatus(sources);
    return projectProgressOverviewSchema.parse({
      schemaVersion: "project-progress-overview-v1",
      generatedAt: generatedAt.toISOString(),
      projectId,
      projectStatus: project.status,
      enabled: flag.enabled,
      businessChain:
        binding === null
          ? null
          : {
              chainKey: binding.chainKey,
              definitionId: binding.workflowDefinitionId,
              definitionVersion: binding.workflowDefinitionVersion,
              bindingRevision: binding.revision,
              bindingMode: binding.bindingMode,
              instanceId: workflowSummary.latestInstanceId,
            },
      coverage: {
        status: coverageStatus,
        sources,
      },
      nodes,
      alerts: alerts.filter((alert) => alert.lifecycle !== "resolved"),
      workflowSummary: {
        definitions: workflowSummary.definitions,
        instances: workflowSummary.instances,
        activeInstances: workflowSummary.activeInstances,
        blockedInstances: workflowSummary.blockedInstances,
        pendingApprovals: workflowSummary.pendingApprovals,
        plans: workflowSummary.plans,
        planningReviewRequired: workflowSummary.planningReviewRequired,
      },
      taskSummary,
      blockedReasons,
    });
  }

  async acknowledgeAlert(
    alertId: string,
    actorId: string,
    input: AcknowledgeProjectAlertInput,
  ): Promise<ProjectAlertDetail> {
    return this.repositories.projectBusinessChains.acknowledgeAlert({
      alertId,
      actorId,
      expectedRevision: input.expectedRevision,
      note: input.note,
    });
  }

  async suppressAlert(
    alertId: string,
    actorId: string,
    input: SuppressProjectAlertInput,
  ): Promise<ProjectAlertDetail> {
    return this.repositories.projectBusinessChains.suppressAlert({
      alertId,
      actorId,
      expectedRevision: input.expectedRevision,
      until: input.until,
      note: input.note,
    });
  }

  async resolveAlert(
    alertId: string,
    actorId: string,
    input: ResolveProjectAlertInput,
  ): Promise<ProjectAlertDetail> {
    return this.repositories.projectBusinessChains.resolveAlert({
      alertId,
      actorId,
      expectedRevision: input.expectedRevision,
      note: input.note,
    });
  }

  async assignAlert(
    alertId: string,
    actorId: string,
    input: AssignProjectAlertInput,
  ): Promise<ProjectAlertDetail> {
    return this.repositories.projectBusinessChains.assignAlert({
      alertId,
      actorId,
      expectedRevision: input.expectedRevision,
      assigneePrincipalId: input.assigneePrincipalId,
      note: input.note,
    });
  }

  private async requireProject(projectId: string) {
    const project =
      await this.repositories.projectBusinessChains.getProject(projectId);
    if (project === undefined) {
      throw new ProjectBusinessChainApplicationError(
        "project_not_found",
        "Project not found",
        404,
      );
    }
    return project;
  }

  private async requireEnabledProject(projectId: string) {
    const project = await this.requireProject(projectId);
    if (project.status !== "active") {
      throw new ProjectBusinessChainApplicationError(
        "project_archived",
        "Archived projects cannot change their business chain",
        409,
      );
    }
    const flag =
      await this.repositories.projectBusinessChains.getFeatureFlagState(
        BUSINESS_CHAIN_FLAG,
        projectId,
      );
    if (!flag.enabled) {
      throw new ProjectBusinessChainApplicationError(
        "project_business_chain_disabled",
        "Feature Flag project.business_chain is disabled",
        409,
        { flagKey: BUSINESS_CHAIN_FLAG },
      );
    }
    return { project, flag };
  }
}

function sourceRefsFromBinding(
  nodeBindings: readonly ProjectBusinessChainNodeBinding[],
): BusinessChainSourceRef[] {
  const refs = new Map<string, BusinessChainSourceRef>();
  for (const node of nodeBindings) {
    for (const field of node.fieldBindings) {
      const refKey = `${field.sourceSystem}:${field.objectType}:${field.objectId}`;
      const existing = refs.get(refKey);
      if (existing === undefined) {
        refs.set(refKey, {
          refKey,
          sourceKind: field.sourceKind,
          sourceSystem: field.sourceSystem,
          objectType: field.objectType,
          objectId: field.objectId,
          path: field.path,
          required: field.required,
          ...(field.providerId === undefined
            ? {}
            : { providerId: field.providerId }),
          ...(field.providerVersionId === undefined
            ? {}
            : { providerVersionId: field.providerVersionId }),
          ...(field.providerRevision === undefined
            ? {}
            : { providerRevision: field.providerRevision }),
          ...(field.toolKey === undefined ? {} : { toolKey: field.toolKey }),
          ...(field.readOnly === undefined
            ? {}
            : { readOnly: field.readOnly }),
        });
      } else if (field.required) {
        existing.required = true;
      }
    }
  }
  return [...refs.values()];
}

function projectNodes(
  definitions: ProjectProgressNodeSource[],
  bindings: readonly ProjectBusinessChainNodeBinding[],
  snapshots: ReadonlyMap<string, readonly ProjectSourceSnapshot[]>,
  now: Date,
): ProjectProgressNode[] {
  return definitions.map((definition) => {
    const binding = bindings.find(
      (candidate) =>
        candidate.sequence === definition.sequence &&
        candidate.stageCode === definition.stageCode,
    );
    const fields = definition.fields.map((field) => {
      const fieldBinding = binding?.fieldBindings.find(
        (candidate) => candidate.fieldKey === field.key,
      );
      if (fieldBinding === undefined) {
        return {
          key: field.key,
          label: field.label,
          value: null,
          sourceSystem: null,
          sourceRevision: null,
          observedAt: null,
          freshUntil: null,
          freshness: "missing" as const,
        };
      }
      const refKey = `${fieldBinding.sourceSystem}:${fieldBinding.objectType}:${fieldBinding.objectId}`;
      const snapshotsForRef = snapshots.get(refKey) ?? [];
      const active = activeSnapshot(snapshotsForRef);
      const latest = latestSnapshot(snapshotsForRef);
      const freshness = snapshotFreshness(active, latest, now);
      return {
        key: field.key,
        label: field.label,
        value:
          active === undefined
            ? null
            : readPath(active.payload, fieldBinding.path),
        sourceSystem: fieldBinding.sourceSystem,
        sourceRevision: active?.sourceRevision ?? null,
        observedAt: active?.observedAt ?? null,
        freshUntil: active?.freshUntil ?? null,
        freshness,
      };
    });
    return {
      sequence: definition.sequence,
      stageCode: definition.stageCode,
      summaryMetric: definition.summaryMetric ?? null,
      status: nodeCoverageStatus(fields),
      fields,
    };
  });
}

interface ProjectProgressNodeSource {
  readonly sequence: number;
  readonly stageCode: string;
  readonly summaryMetric?: string | undefined;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly bindings: readonly BusinessChainSourceRef[];
  }[];
}

function groupSnapshots(
  snapshots: readonly ProjectSourceSnapshot[],
): Map<string, ProjectSourceSnapshot[]> {
  const groups = new Map<string, ProjectSourceSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = groups.get(snapshot.refKey) ?? [];
    existing.push(snapshot);
    groups.set(snapshot.refKey, existing);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => right.version - left.version);
  }
  return groups;
}

function latestSnapshot(
  snapshots: readonly ProjectSourceSnapshot[],
): ProjectSourceSnapshot | undefined {
  return snapshots[0];
}

function activeSnapshot(
  snapshots: readonly ProjectSourceSnapshot[],
): ProjectSourceSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.status !== "error");
}

function snapshotFreshness(
  active: ProjectSourceSnapshot | undefined,
  latest: ProjectSourceSnapshot | undefined,
  now: Date,
): "fresh" | "stale" | "error" | "missing" {
  if (latest?.status === "error") return "error";
  if (active === undefined) return "missing";
  if (
    active.status === "stale" ||
    active.freshUntil === null ||
    new Date(active.freshUntil).getTime() <= now.getTime()
  ) {
    return "stale";
  }
  return "fresh";
}

function sourceCoverage(
  ref: BusinessChainSourceRef,
  snapshots: readonly ProjectSourceSnapshot[],
  now: Date,
): ProjectProgressOverview["coverage"]["sources"][number] {
  const active = activeSnapshot(snapshots);
  const latest = latestSnapshot(snapshots);
  const freshness = snapshotFreshness(active, latest, now);
  return {
    refKey: ref.refKey,
    sourceKind: ref.sourceKind,
    sourceSystem: ref.sourceSystem,
    sourceObjectType: ref.objectType,
    sourceObjectId: ref.objectId,
    status: freshness,
    activeSnapshotId: active?.id ?? null,
    activeVersion: active?.version ?? null,
    sourceRevision: active?.sourceRevision ?? null,
    observedAt: active?.observedAt ?? null,
    freshUntil: active?.freshUntil ?? null,
    failureReason: latest?.status === "error" ? latest.failureReason : null,
    isMock: active?.isMock ?? latest?.isMock ?? false,
  };
}

function aggregateCoverageStatus(
  sources: readonly ProjectProgressOverview["coverage"]["sources"][number][],
): "complete" | "partial" | "stale" | "error" {
  if (sources.some((source) => source.status === "error")) return "error";
  if (sources.some((source) => source.status === "stale")) return "stale";
  if (sources.some((source) => source.status === "missing")) return "partial";
  return "complete";
}

function nodeCoverageStatus(
  fields: readonly {
    readonly freshness: "fresh" | "stale" | "error" | "missing";
  }[],
): "complete" | "partial" | "stale" | "error" | "unbound" {
  if (fields.every((field) => field.freshness === "missing")) return "unbound";
  if (fields.some((field) => field.freshness === "error")) return "error";
  if (fields.some((field) => field.freshness === "stale")) return "stale";
  if (fields.some((field) => field.freshness === "missing")) return "partial";
  return "complete";
}

function readPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split(".").filter(Boolean)) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function mockPayload(ref: BusinessChainSourceRef): unknown {
  const root: Record<string, unknown> = {};
  const segments = ref.path.split(".").filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index === segments.length - 1) {
      cursor[segment] = `Mock ${ref.objectType} ${ref.objectId}`;
      break;
    }
    const next: Record<string, unknown> = {};
    cursor[segment] = next;
    cursor = next;
  }
  return root;
}

function failedSourceResult(
  ref: BusinessChainSourceRef,
  now: Date,
  failureReason: string,
): ProjectSourceFetchResult {
  return {
    refKey: ref.refKey,
    sourceKind: ref.sourceKind,
    sourceSystem: ref.sourceSystem,
    objectType: ref.objectType,
    objectId: ref.objectId,
    sourceRevision: null,
    observedAt: now.toISOString(),
    effectiveAt: null,
    freshUntil: null,
    status: "error",
    payload: null,
    failureReason,
    isMock: false,
  };
}

function settingsBlockedReasons(input: {
  readonly projectStatus: "active" | "archived";
  readonly businessChainEnabled: boolean;
  readonly binding: unknown | null;
  readonly templateMode: "required" | "optional" | "none" | null;
  readonly candidates: readonly unknown[];
}): string[] {
  const reasons: string[] = [];
  if (!input.businessChainEnabled) reasons.push("feature-disabled");
  if (input.projectStatus === "archived") reasons.push("project-archived");
  if (input.binding === null) reasons.push("business-chain-unbound");
  if (
    input.binding === null &&
    input.templateMode === "required" &&
    input.candidates.length === 0
  ) {
    reasons.push("template-policy-required");
  }
  return reasons;
}

function overviewBlockedReasons(input: {
  readonly enabled: boolean;
  readonly projectStatus: "active" | "archived";
  readonly bindingMissing: boolean;
  readonly templateMode: "required" | "optional" | "none" | null;
  readonly sources: ProjectProgressOverview["coverage"]["sources"];
}): ProjectProgressOverview["blockedReasons"] {
  const reasons: ProjectProgressOverview["blockedReasons"] = [];
  if (!input.enabled) {
    reasons.push({
      code: "feature-disabled",
      message: "项目业务链路功能尚未开启",
    });
  }
  if (input.projectStatus === "archived") {
    reasons.push({
      code: "project-archived",
      message: "项目已归档，业务链路只读",
    });
  }
  if (input.bindingMissing) {
    reasons.push({
      code: "business-chain-unbound",
      message: "项目尚未绑定业务链路",
    });
    if (input.templateMode === "required") {
      reasons.push({
        code: "template-policy-required",
        message: "项目模板要求绑定业务链路",
      });
    }
  }
  if (input.sources.some((source) => source.status === "missing")) {
    reasons.push({
      code: "source-refs-missing",
      message: "部分业务来源尚无有效快照",
    });
  }
  if (input.sources.some((source) => source.status === "stale")) {
    reasons.push({
      code: "source-stale",
      message: "部分业务来源已过期，当前展示最后有效值",
    });
  }
  if (input.sources.some((source) => source.status === "error")) {
    reasons.push({
      code: "source-error",
      message: "部分业务来源刷新失败，已保留最后有效快照",
    });
  }
  return reasons;
}

function sourceRefError(message: string): ProjectBusinessChainApplicationError {
  return new ProjectBusinessChainApplicationError(
    "project_source_refs_missing",
    message,
    409,
  );
}

function mockDisabledError(): ProjectBusinessChainApplicationError {
  return new ProjectBusinessChainApplicationError(
    "project_source_mock_disabled",
    "Feature Flag project.source.mock is disabled",
    409,
    { flagKey: PROJECT_SOURCE_MOCK_FLAG },
  );
}

export function translateProjectBusinessChainError(error: unknown): unknown {
  if (
    error instanceof ProjectBusinessChainApplicationError ||
    error instanceof ProjectBusinessChainRepositoryError
  ) {
    return new ProjectBusinessChainApplicationError(
      error.code,
      error.message,
      error.statusCode,
      "details" in error ? error.details : undefined,
    );
  }
  return error;
}
