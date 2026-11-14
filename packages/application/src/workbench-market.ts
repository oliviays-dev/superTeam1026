import {
  MARKET_FLAG,
  TRUSTED_WORKBENCH_PANELS,
  WORKBENCH_HOST_VERSION,
  WORKBENCH_V2_FLAG,
  isTrustedWorkbenchPanelId,
  marketAssetManifestSchema,
  trustedWorkbenchPanel,
  type CopyMarketTemplateInput,
  type CreateMarketAssetInput,
  type CreateWorkbenchInput,
  type CreateWorkbenchLayoutInput,
  type GrantMarketEntitlementInput,
  type InstallMarketAssetInput,
  type MarketAsset,
  type MarketAssetDetail,
  type MarketAssetKind,
  type MarketAssetManifest,
  type MarketEntitlement,
  type MarketInstallResult,
  type MarketInstallation,
  type MarketTemplate,
  type MarketTemplateCopy,
  type MarketTemplateCopyResult,
  type PublishMarketAssetVersionInput,
  type SaveWorkbenchLayoutInput,
  type SetDefaultWorkbenchLayoutInput,
  type SetMarketAssetStatusInput,
  type SetMarketAssetVersionStatusInput,
  type UpdateWorkbenchInput,
  type Workbench,
  type WorkbenchBootstrap,
  type WorkbenchDetail,
  type WorkbenchPanelData,
  type WorkbenchPanelResolution,
  type WorkbenchLayoutVersion,
  type WorkbenchVersion,
} from "@pluginmax/contracts";
import type {
  AuthorizationRepository,
  MarketRepository,
  MarketRepositoryError,
  WorkbenchConfigurationRepository,
  WorkbenchConfigurationRepositoryError,
  WorkbenchConfigurationRecord,
  PlatformRepositories,
} from "@pluginmax/database";

export interface WorkbenchMarketActor {
  readonly principalId: string;
  readonly authSource: "bearer" | "local-development";
  readonly platformAdministrator: boolean;
}

export type WorkbenchMarketErrorCode =
  | "workbench_v2_disabled"
  | "market_disabled"
  | "workbench_panel_not_found"
  | "workbench_panel_entitlement_required"
  | "workbench_panel_access_denied"
  | "market_forbidden"
  | "market_manifest_has_dynamic_code"
  | "market_manifest_incompatible"
  | "market_template_dependencies_unmet";

export class WorkbenchMarketApplicationError extends Error {
  constructor(
    readonly code: WorkbenchMarketErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkbenchMarketApplicationError";
  }
}

export interface TemplateCopyRecoveryResult {
  readonly scannedWorkbenches: number;
  readonly compensatedWorkbenches: number;
}

export class WorkbenchConfigurationApplication {
  constructor(
    private readonly workbenches: WorkbenchConfigurationRepository,
    private readonly marketRepository: MarketRepository,
    private readonly reports: PlatformRepositories["workbenchReports"],
    private readonly authorization: AuthorizationRepository,
    private readonly featureFlags: PlatformRepositories["featureFlags"],
  ) {}

  async bootstrap(actor: WorkbenchMarketActor): Promise<WorkbenchBootstrap> {
    const enabled = await this.featureFlags.isEnabled(WORKBENCH_V2_FLAG);
    const marketEnabled = await this.featureFlags.isEnabled(MARKET_FLAG);
    if (!enabled) {
      return {
        enabled: false,
        marketEnabled,
        hostVersion: WORKBENCH_HOST_VERSION,
        workbenches: [],
        defaultWorkbench: null,
      };
    }
    const record = await this.workbenches.ensureDefaultWorkbench(
      actor.principalId,
    );
    const workbenches = await this.workbenches.listWorkbenches(
      actor.principalId,
    );
    return {
      enabled: true,
      marketEnabled,
      hostVersion: WORKBENCH_HOST_VERSION,
      workbenches,
      defaultWorkbench: await this.toDetail(actor, record),
    };
  }

  async listWorkbenches(actor: WorkbenchMarketActor): Promise<Workbench[]> {
    await this.requireEnabled();
    return this.workbenches.listWorkbenches(actor.principalId);
  }

  async getWorkbench(
    actor: WorkbenchMarketActor,
    workbenchId: string,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    const record = await this.workbenches.getWorkbench(
      actor.principalId,
      workbenchId,
    );
    if (record === undefined) {
      throw new WorkbenchMarketApplicationError(
        "workbench_panel_not_found",
        "Workbench not found",
        404,
      );
    }
    return this.toDetail(actor, record);
  }

  async createWorkbench(
    actor: WorkbenchMarketActor,
    input: CreateWorkbenchInput,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    if (input.template !== undefined) {
      await this.validatePlacements(actor, input.template.panels);
    }
    return this.toDetail(
      actor,
      await this.workbenches.createWorkbench(actor.principalId, input),
    );
  }

  async updateWorkbench(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    input: UpdateWorkbenchInput,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    return this.toDetail(
      actor,
      await this.workbenches.updateWorkbench(
        actor.principalId,
        workbenchId,
        input,
      ),
    );
  }

  async createLayout(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    input: CreateWorkbenchLayoutInput,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    await this.validatePlacements(actor, input.document.panels);
    return this.toDetail(
      actor,
      await this.workbenches.createLayout(
        actor.principalId,
        workbenchId,
        input,
      ),
    );
  }

  async saveLayout(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    layoutId: string,
    input: SaveWorkbenchLayoutInput,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    await this.validatePlacements(actor, input.document.panels);
    return this.toDetail(
      actor,
      await this.workbenches.saveLayout(
        actor.principalId,
        workbenchId,
        layoutId,
        input,
      ),
    );
  }

  async setDefaultLayout(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    layoutId: string,
    input: SetDefaultWorkbenchLayoutInput,
  ): Promise<WorkbenchDetail> {
    await this.requireEnabled();
    return this.toDetail(
      actor,
      await this.workbenches.setDefaultLayout(
        actor.principalId,
        workbenchId,
        layoutId,
        input,
      ),
    );
  }

  async listVersions(
    actor: WorkbenchMarketActor,
    workbenchId: string,
  ): Promise<WorkbenchVersion[]> {
    await this.requireEnabled();
    return this.workbenches.listWorkbenchVersions(
      actor.principalId,
      workbenchId,
    );
  }

  async listLayoutVersions(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    layoutId: string,
  ): Promise<WorkbenchLayoutVersion[]> {
    await this.requireEnabled();
    return this.workbenches.listLayoutVersions(
      actor.principalId,
      workbenchId,
      layoutId,
    );
  }

  async getPanelData(
    actor: WorkbenchMarketActor,
    workbenchId: string,
    panelInstanceId: string,
    projectId?: string,
  ): Promise<WorkbenchPanelData> {
    await this.requireEnabled();
    const record = await this.workbenches.getPanelRecord(
      actor.principalId,
      workbenchId,
      panelInstanceId,
    );
    if (record === undefined) {
      throw new WorkbenchMarketApplicationError(
        "workbench_panel_not_found",
        "Workbench panel not found",
        404,
      );
    }
    const resolution = await this.resolvePanel(actor, record.panel);
    if (resolution.state !== "ready") {
      return {
        state: resolution.state,
        panelInstanceId,
        pluginId: resolution.pluginId,
        data: null,
        fallbackMessage:
          resolution.fallbackMessage ?? "面板暂不可用，页面其他区域不受影响",
      };
    }
    if (projectId !== undefined) {
      const decision = await this.authorization.authorizeProject({
        principalId: actor.principalId,
        authSource: actor.authSource,
        projectId,
        permission: "read",
      });
      if (!decision.allowed) {
        return {
          state: "forbidden",
          panelInstanceId,
          pluginId: resolution.pluginId,
          data: null,
          fallbackMessage: "项目读取权限已撤销，不返回旧业务数据",
        };
      }
    }
    if (resolution.pluginId === "market.sample") {
      return {
        state: "ready",
        panelInstanceId,
        pluginId: resolution.pluginId,
        data: {
          message: "Trusted static market panel is available.",
          grantsAuthorization: false,
        },
        updatedAt: new Date().toISOString(),
      };
    }
    const dashboard = await this.reports.dashboard(actor.principalId);
    const data = panelDashboardData(dashboard, resolution.pluginId, projectId);
    if (data === undefined) {
      return {
        state: "unknown",
        panelInstanceId,
        pluginId: resolution.pluginId,
        data: null,
        fallbackMessage: "面板注册信息已变化，已使用安全占位",
      };
    }
    return {
      state: "ready",
      panelInstanceId,
      pluginId: resolution.pluginId,
      data,
      updatedAt: dashboard.generatedAt,
    };
  }

  private async toDetail(
    actor: WorkbenchMarketActor,
    record: WorkbenchConfigurationRecord,
  ): Promise<WorkbenchDetail> {
    const panels = await Promise.all(
      record.panels.map((panel) => this.resolvePanel(actor, panel)),
    );
    return {
      workbench: record.workbench,
      layout: record.layout,
      layoutVersion: record.layoutVersion,
      panels,
    };
  }

  private async resolvePanel(
    actor: WorkbenchMarketActor,
    panel: WorkbenchConfigurationRecord["panels"][number],
  ): Promise<WorkbenchPanelResolution> {
    const trusted = trustedWorkbenchPanel(panel.pluginId);
    if (trusted === undefined) {
      return {
        instanceId: panel.id,
        pluginId: panel.pluginId,
        title: panel.panelTitle,
        version: panel.panelVersion,
        position: panel.position,
        width: panel.width,
        height: panel.height,
        refreshable: false,
        state: "unknown",
        fallbackMessage: "未知面板已降级，不影响整页加载",
      };
    }
    if (!panel.enabled || panel.panelStatus === "disabled") {
      return {
        instanceId: panel.id,
        pluginId: panel.pluginId,
        title: trusted.title,
        version: trusted.version,
        position: panel.position,
        width: panel.width,
        height: panel.height,
        refreshable: false,
        state: "disabled",
        fallbackMessage: "面板已禁用，页面其他区域不受影响",
      };
    }
    if (trusted.requiresEntitlement) {
      const marketEnabled = await this.featureFlags.isEnabled(MARKET_FLAG);
      if (!marketEnabled) {
        return {
          instanceId: panel.id,
          pluginId: panel.pluginId,
          title: trusted.title,
          version: trusted.version,
          position: panel.position,
          width: panel.width,
          height: panel.height,
          refreshable: false,
          state: "disabled",
          fallbackMessage: "资源市场未启用，面板保持关闭",
        };
      }
      const entitled = await this.marketRepository.hasPanelEntitlement(
        actor.principalId,
        panel.pluginId,
        1,
      );
      if (!entitled) {
        return {
          instanceId: panel.id,
          pluginId: panel.pluginId,
          title: trusted.title,
          version: trusted.version,
          position: panel.position,
          width: panel.width,
          height: panel.height,
          refreshable: false,
          state: "needs_entitlement",
          fallbackMessage: "需要有效的市场 entitlement",
        };
      }
    }
    return {
      instanceId: panel.id,
      pluginId: panel.pluginId,
      title: trusted.title,
      version: trusted.version,
      position: panel.position,
      width: panel.width,
      height: panel.height,
      refreshable: trusted.refreshable,
      state: "ready",
      fallbackMessage: null,
    };
  }

  private async validatePlacements(
    actor: WorkbenchMarketActor,
    panels: SaveWorkbenchLayoutInput["document"]["panels"],
  ): Promise<void> {
    for (const panel of panels) {
      const trusted = trustedWorkbenchPanel(panel.pluginId);
      if (trusted === undefined) {
        throw new WorkbenchMarketApplicationError(
          "market_manifest_has_dynamic_code",
          `Panel ${panel.pluginId} is not in the trusted static registry`,
          400,
        );
      }
      if (trusted.requiresEntitlement) {
        if (!(await this.featureFlags.isEnabled(MARKET_FLAG))) {
          throw new WorkbenchMarketApplicationError(
            "market_disabled",
            "Resource Market is disabled",
            503,
          );
        }
        if (
          !(await this.marketRepository.hasPanelEntitlement(
            actor.principalId,
            panel.pluginId,
            1,
          ))
        ) {
          throw new WorkbenchMarketApplicationError(
            "workbench_panel_entitlement_required",
            "An active Market entitlement is required for this panel",
            403,
          );
        }
      }
    }
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.featureFlags.isEnabled(WORKBENCH_V2_FLAG))) {
      throw new WorkbenchMarketApplicationError(
        "workbench_v2_disabled",
        "Workbench V2 is disabled",
        503,
      );
    }
  }
}

export class MarketApplication {
  constructor(
    private readonly marketRepository: MarketRepository,
    private readonly workbenches: WorkbenchConfigurationRepository,
    private readonly authorization: AuthorizationRepository,
    private readonly featureFlags: PlatformRepositories["featureFlags"],
  ) {}

  async listAssets(
    actor: WorkbenchMarketActor,
    kind?: MarketAssetKind,
  ): Promise<MarketAsset[]> {
    await this.requireEnabled();
    return this.marketRepository.listAssets(actor, kind);
  }

  async getAsset(
    actor: WorkbenchMarketActor,
    assetId: string,
  ): Promise<MarketAssetDetail> {
    await this.requireEnabled();
    const asset = await this.marketRepository.getAsset(actor, assetId);
    if (asset === undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "Market asset not found or not visible",
        404,
      );
    }
    return asset;
  }

  async createAsset(
    actor: WorkbenchMarketActor,
    input: CreateMarketAssetInput,
  ): Promise<MarketAssetDetail> {
    await this.requireEnabled();
    await this.requireHuman(actor);
    if (
      (input.trustLevel === "official" || input.trustLevel === "verified") &&
      !actor.platformAdministrator
    ) {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "Only platform administrators can publish official or verified assets",
        403,
      );
    }
    return this.marketRepository.createAsset(actor, input);
  }

  async publishVersion(
    actor: WorkbenchMarketActor,
    assetId: string,
    input: PublishMarketAssetVersionInput,
  ): Promise<MarketAssetDetail["versions"][number]> {
    await this.requireEnabled();
    const asset = await this.marketRepository.getAsset(actor, assetId, false);
    if (asset === undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "Market asset not found",
        404,
      );
    }
    this.validateManifest(asset.kind, input.manifest, input.compatibility);
    return this.marketRepository.publishVersion(actor, assetId, input);
  }

  async setAssetStatus(
    actor: WorkbenchMarketActor,
    assetId: string,
    input: SetMarketAssetStatusInput,
  ): Promise<MarketAsset> {
    await this.requireEnabled();
    return this.marketRepository.setAssetStatus(actor, assetId, input);
  }

  async setVersionStatus(
    actor: WorkbenchMarketActor,
    assetId: string,
    version: number,
    input: SetMarketAssetVersionStatusInput,
  ): Promise<MarketAssetDetail["versions"][number]> {
    await this.requireEnabled();
    return this.marketRepository.setVersionStatus(
      actor,
      assetId,
      version,
      input,
    );
  }

  async grantEntitlement(
    actor: WorkbenchMarketActor,
    input: GrantMarketEntitlementInput,
  ): Promise<MarketEntitlement> {
    await this.requireEnabled();
    return this.marketRepository.grantEntitlement(actor, input);
  }

  async revokeEntitlement(
    actor: WorkbenchMarketActor,
    entitlementId: string,
  ): Promise<MarketEntitlement> {
    await this.requireEnabled();
    return this.marketRepository.revokeEntitlement(actor, entitlementId);
  }

  async listEntitlements(
    actor: WorkbenchMarketActor,
    all = false,
  ): Promise<MarketEntitlement[]> {
    await this.requireEnabled();
    if (all) {
      if (!actor.platformAdministrator) {
        throw new WorkbenchMarketApplicationError(
          "market_forbidden",
          "Only platform administrators can list all entitlements",
          403,
        );
      }
      return this.marketRepository.listAllEntitlements();
    }
    return this.marketRepository.listEntitlements(actor.principalId);
  }

  async install(
    actor: WorkbenchMarketActor,
    input: InstallMarketAssetInput,
    idempotencyKey: string,
  ): Promise<MarketInstallResult> {
    await this.requireEnabled();
    await this.requireHuman(actor);
    return this.marketRepository.installAsset(
      actor.principalId,
      input,
      idempotencyKey,
    );
  }

  async rollback(
    actor: WorkbenchMarketActor,
    input: InstallMarketAssetInput,
    idempotencyKey: string,
  ): Promise<MarketInstallResult> {
    return this.install(actor, input, idempotencyKey);
  }

  async uninstall(
    actor: WorkbenchMarketActor,
    assetId: string,
  ): Promise<MarketInstallation> {
    await this.requireEnabled();
    return this.marketRepository.uninstallAsset(actor.principalId, assetId);
  }

  async listInstallations(
    actor: WorkbenchMarketActor,
  ): Promise<MarketInstallation[]> {
    await this.requireEnabled();
    return this.marketRepository.listInstallations(actor.principalId);
  }

  async listTemplates(
    actor: WorkbenchMarketActor,
  ): Promise<MarketTemplate[]> {
    await this.requireEnabled();
    return this.marketRepository.listTemplates(actor);
  }

  async getTemplate(
    actor: WorkbenchMarketActor,
    templateId: string,
  ): Promise<MarketTemplate> {
    await this.requireEnabled();
    const template = await this.marketRepository.getTemplate(actor, templateId);
    if (template === undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "Market template not found",
        404,
      );
    }
    return template;
  }

  async copyTemplate(
    actor: WorkbenchMarketActor,
    input: CopyMarketTemplateInput,
    idempotencyKey: string,
  ): Promise<MarketTemplateCopyResult> {
    await this.requireEnabled();
    await this.requireHuman(actor);
    if (!(await this.featureFlags.isEnabled(WORKBENCH_V2_FLAG))) {
      throw new WorkbenchMarketApplicationError(
        "workbench_v2_disabled",
        "Workbench V2 is disabled",
        503,
      );
    }
    await this.recoverTemplateCopyOrphans(actor, {
      templateId: input.templateId,
      olderThanSeconds: 60,
    });
    const manifestRecord =
      await this.marketRepository.templateVersionManifest(
        input.templateId,
        input.version,
      );
    const entitlement = await this.marketRepository.activeEntitlement(
      actor.principalId,
      manifestRecord.asset.id,
    );
    if (entitlement === undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "An active entitlement is required to copy this template",
        403,
      );
    }
    const dependencies = await this.marketRepository.dependencyStatus(
      input.templateId,
      manifestRecord.version.id,
    );
    if (
      dependencies.some(
        (dependency) => dependency.required && !dependency.installed,
      )
    ) {
      throw new WorkbenchMarketApplicationError(
        "market_template_dependencies_unmet",
        "Required Market template dependencies are not installed",
        409,
      );
    }
    const existing = await this.marketRepository.existingTemplateCopy(
      actor.principalId,
      input.templateId,
    );
    if (
      existing !== undefined &&
      existing.status === "active" &&
      existing.assetVersion === input.version
    ) {
      return {
        copy: existing,
        workbenchId: existing.workbenchId,
        created: false,
        deduplicated: true,
      };
    }
    const manifest = marketAssetManifestSchema.parse(
      manifestRecord.version.manifest,
    );
    if (manifest.template === undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_manifest_incompatible",
        "Market template manifest is missing its layout",
        409,
      );
    }
    for (const panel of manifest.template.panels) {
      const trusted = trustedWorkbenchPanel(panel.pluginId);
      if (trusted === undefined) {
        throw new WorkbenchMarketApplicationError(
          "market_manifest_has_dynamic_code",
          "Template layout references an untrusted panel",
          409,
        );
      }
      if (
        trusted.requiresEntitlement &&
        !(await this.marketRepository.hasPanelEntitlement(
          actor.principalId,
          panel.pluginId,
          1,
        ))
      ) {
        throw new WorkbenchMarketApplicationError(
          "workbench_panel_entitlement_required",
          "Template requires an entitlement for one of its panels",
          403,
        );
      }
    }
    const workbench = await this.workbenches.createWorkbench(actor.principalId, {
      name: input.name,
      template: manifest.template,
    }, {
      source: "market-template-copy",
      templateId: input.templateId,
      templateVersion: input.version,
      idempotencyKey,
    });
    const copy = await this.marketRepository.recordTemplateCopy(
      actor.principalId,
      input,
      workbench.workbench.id,
      idempotencyKey,
    );
    return {
      copy,
      workbenchId: workbench.workbench.id,
      created: true,
      deduplicated: false,
    };
  }

  async recoverTemplateCopyOrphans(
    actor: WorkbenchMarketActor,
    input: {
      readonly templateId?: string;
      readonly olderThanSeconds?: number;
    } = {},
  ): Promise<TemplateCopyRecoveryResult> {
    await this.requireEnabled();
    await this.requireHuman(actor);
    const olderThanSeconds = input.olderThanSeconds ?? 60;
    const candidates = await this.workbenches.listTemplateCopyCandidates(
      actor.principalId,
      {
        ...(input.templateId === undefined
          ? {}
          : { templateId: input.templateId }),
        olderThanSeconds,
      },
    );
    if (candidates.length === 0) {
      return { scannedWorkbenches: 0, compensatedWorkbenches: 0 };
    }
    const referenced = await this.marketRepository.templateCopyWorkbenchIds(
      candidates.map((candidate) => candidate.workbenchId),
    );
    let compensatedWorkbenches = 0;
    for (const candidate of candidates) {
      if (referenced.has(candidate.workbenchId)) continue;
      if (
        await this.workbenches.compensateTemplateCopyCandidate(
          actor.principalId,
          candidate,
        )
      ) {
        compensatedWorkbenches += 1;
      }
    }
    return {
      scannedWorkbenches: candidates.length,
      compensatedWorkbenches,
    };
  }

  async uninstallTemplateCopy(
    actor: WorkbenchMarketActor,
    templateId: string,
  ): Promise<MarketTemplateCopy> {
    await this.requireEnabled();
    return this.marketRepository.uninstallTemplateCopy(
      actor.principalId,
      templateId,
    );
  }

  private validateManifest(
    kind: MarketAssetKind,
    manifestInput: MarketAssetManifest,
    compatibility: PublishMarketAssetVersionInput["compatibility"],
  ): void {
    const manifest = marketAssetManifestSchema.parse(manifestInput);
    const minimum = parseSemver(compatibility.minHostVersion);
    const maximum =
      compatibility.maxHostVersion === undefined
        ? undefined
        : parseSemver(compatibility.maxHostVersion);
    if (
      minimum === undefined ||
      (compatibility.maxHostVersion !== undefined && maximum === undefined) ||
      (maximum !== undefined && compareSemver(minimum, maximum) > 0)
    ) {
      throw new WorkbenchMarketApplicationError(
        "market_manifest_incompatible",
        "Market compatibility range is invalid",
        400,
      );
    }
    if (kind === "panel") {
      if (
        manifest.panelPluginId === undefined ||
        !isTrustedWorkbenchPanelId(manifest.panelPluginId)
      ) {
        throw new WorkbenchMarketApplicationError(
          "market_manifest_has_dynamic_code",
          "Panel assets must reference the trusted static Workbench registry",
          400,
        );
      }
    } else if (manifest.panelPluginId !== undefined) {
      throw new WorkbenchMarketApplicationError(
        "market_manifest_has_dynamic_code",
        "Only panel assets may reference a panel plugin",
        400,
      );
    }
    if (kind === "workbench-template") {
      if (manifest.template === undefined) {
        throw new WorkbenchMarketApplicationError(
          "market_manifest_incompatible",
          "Workbench template assets require a layout template",
          400,
        );
      }
      for (const panel of manifest.template.panels) {
        if (!isTrustedWorkbenchPanelId(panel.pluginId)) {
          throw new WorkbenchMarketApplicationError(
            "market_manifest_has_dynamic_code",
            "Workbench templates may only reference trusted static panels",
            400,
          );
        }
      }
    } else if (
      manifest.template !== undefined ||
      manifest.dependencies.length > 0
    ) {
      throw new WorkbenchMarketApplicationError(
        "market_manifest_incompatible",
        "Only Workbench template assets may carry template dependencies",
        400,
      );
    }
  }

  private async requireHuman(actor: WorkbenchMarketActor): Promise<void> {
    const principal = await this.authorization.getPrincipal(actor.principalId);
    if (principal?.kind !== "human" || principal.status !== "active") {
      throw new WorkbenchMarketApplicationError(
        "market_forbidden",
        "An active human Principal is required",
        403,
      );
    }
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.featureFlags.isEnabled(MARKET_FLAG))) {
      throw new WorkbenchMarketApplicationError(
        "market_disabled",
        "Resource Market is disabled",
        503,
      );
    }
  }
}

function panelDashboardData(
  dashboard: Awaited<
    ReturnType<PlatformRepositories["workbenchReports"]["dashboard"]>
  >,
  pluginId: string,
  projectId?: string,
): unknown {
  switch (pluginId) {
    case "metrics":
      return {
        todos: dashboard.todos.length,
        focus: dashboard.focus.length,
        exceptions: dashboard.runExceptions.length,
        reports: dashboard.projectReports.length,
      };
    case "brief":
      return dashboard.brief;
    case "todo":
      return projectId === undefined
        ? dashboard.todos
        : dashboard.todos.filter((item) => item.projectId === projectId);
    case "focus":
      return projectId === undefined
        ? dashboard.focus
        : dashboard.focus.filter((item) => item.projectId === projectId);
    case "meeting-minutes":
      return projectId === undefined
        ? dashboard.meetingConclusions
        : dashboard.meetingConclusions.filter(
            (item) => item.projectId === projectId,
          );
    case "control":
      return projectId === undefined
        ? dashboard.runExceptions
        : dashboard.runExceptions.filter(
            (item) => item.projectId === projectId,
          );
    case "supply":
      return projectId === undefined
        ? dashboard.supplyExceptions
        : dashboard.supplyExceptions.filter(
            (item) => item.projectId === projectId,
          );
    case "supplier":
      return projectId === undefined
        ? dashboard.supplierRisks
        : dashboard.supplierRisks.filter(
            (item) => item.projectId === projectId,
          );
    case "reports":
      return projectId === undefined
        ? dashboard.projectReports
        : dashboard.projectReports.filter(
            (item) => item.projectId === projectId,
          );
    default:
      return undefined;
  }
}

function parseSemver(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isWorkbenchRepositoryError(
  error: unknown,
): error is WorkbenchConfigurationRepositoryError {
  return (
    error instanceof Error &&
    error.name === "WorkbenchConfigurationRepositoryError"
  );
}

export function isMarketRepositoryError(
  error: unknown,
): error is MarketRepositoryError {
  return error instanceof Error && error.name === "MarketRepositoryError";
}

export const WORKBENCH_MARKET_TRUSTED_PANEL_IDS =
  TRUSTED_WORKBENCH_PANELS.map((panel) => panel.pluginId);
