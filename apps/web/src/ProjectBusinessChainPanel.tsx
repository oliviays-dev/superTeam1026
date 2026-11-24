import type {
  BusinessChainDefinitionInput,
  ProjectAlert,
  ProjectProgressOverview,
  ProjectTemplateBusinessChainMode,
  WorkflowDefinition,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Check,
  Link2,
  Link2Off,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Timer,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  acknowledgeProjectAlert,
  bindProjectBusinessChain,
  configureWorkflowBusinessChain,
  getProjectBusinessChainSettings,
  getProjectProgressOverview,
  listWorkflows,
  refreshProjectSources,
  resolveProjectAlert,
  suppressProjectAlert,
  unbindProjectBusinessChain,
  updateProjectFeatureFlags,
} from "./api.js";

export function ProjectBusinessChainPanel({
  projectId,
  canWrite,
  platformAdministrator,
  onOpenTask,
}: {
  projectId: string;
  canWrite: boolean;
  platformAdministrator: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["project-business-chain", projectId],
    queryFn: () => getProjectBusinessChainSettings(projectId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const overviewQuery = useQuery({
    queryKey: ["project-progress-overview", projectId],
    queryFn: () => getProjectProgressOverview(projectId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const workflowsQuery = useQuery({
    queryKey: ["workflows", projectId],
    queryFn: () => listWorkflows(projectId),
    enabled: canWrite,
  });
  const [candidateId, setCandidateId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [chainKey, setChainKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sourceObjectId, setSourceObjectId] = useState("");
  const [sourcePath, setSourcePath] = useState("value");
  const settings = settingsQuery.data;
  const overview = overviewQuery.data;
  const candidates = settings?.candidates ?? [];
  const canRefreshFixtures =
    canWrite &&
    overview?.coverage.sources.every(
      (source) => source.sourceKind !== "mcp",
    ) === true;
  const selectedCandidate =
    candidates.find(
      (candidate) => candidate.workflowDefinitionId === candidateId,
    ) ?? candidates[0];
  const availableDefinitions = useMemo(
    () =>
      (workflowsQuery.data ?? []).filter(
        (workflow) => workflow.kind !== "business-chain",
      ),
    [workflowsQuery.data],
  );

  useEffect(() => {
    if (candidateId === "" && candidates[0] !== undefined) {
      setCandidateId(candidates[0].workflowDefinitionId);
    }
  }, [candidateId, candidates]);
  useEffect(() => {
    if (definitionId === "" && availableDefinitions[0] !== undefined) {
      setDefinitionId(availableDefinitions[0].id);
    }
  }, [availableDefinitions, definitionId]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["project-business-chain", projectId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["project-progress-overview", projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ["workflows", projectId] }),
    ]);
  };
  const bindMutation = useMutation({
    mutationFn: () =>
      bindProjectBusinessChain(projectId, {
        workflowDefinitionId: selectedCandidate!.workflowDefinitionId,
        nodeBindings: [],
        expectedRevision:
          settings?.binding?.revision ?? settings?.history[0]?.revision ?? 0,
        reason:
          settings?.binding === null ? "项目业务链路绑定" : "升级业务链路",
        upgrade: settings?.binding !== null,
      }),
    onSuccess: invalidate,
  });
  const unbindMutation = useMutation({
    mutationFn: () =>
      unbindProjectBusinessChain(projectId, {
        expectedRevision: settings!.binding!.revision,
        reason: "项目负责人解除业务链路",
      }),
    onSuccess: invalidate,
  });
  const refreshMutation = useMutation({
    mutationFn: () => refreshProjectSources(projectId, { timeoutMs: 8_000 }),
    onSuccess: invalidate,
  });
  const configureMutation = useMutation({
    mutationFn: () => {
      const workflow = availableDefinitions.find(
        (candidate) => candidate.id === definitionId,
      );
      if (workflow === undefined) {
        throw new Error("请选择要配置的工作流");
      }
      const input = businessChainInput(
        workflow,
        chainKey,
        displayName,
        sourceObjectId,
        sourcePath,
      );
      return configureWorkflowBusinessChain(workflow.id, input);
    },
    onSuccess: async () => {
      setChainKey("");
      setDisplayName("");
      setSourceObjectId("");
      await invalidate();
    },
  });
  const flagsMutation = useMutation({
    mutationFn: (input: Parameters<typeof updateProjectFeatureFlags>[1]) =>
      updateProjectFeatureFlags(projectId, input),
    onSuccess: invalidate,
  });

  if (settingsQuery.isLoading || overviewQuery.isLoading) {
    return (
      <section className="pm-panel project-chain-loading">
        <LoaderCircle className="spin" size={16} />
        正在计算项目概览
      </section>
    );
  }
  if (settingsQuery.isError || overviewQuery.isError) {
    return (
      <section className="pm-panel pm-error">
        {settingsQuery.error?.message ??
          overviewQuery.error?.message ??
          "项目业务链路加载失败"}
      </section>
    );
  }
  if (settings === undefined || overview === undefined) return null;

  return (
    <div className="project-chain-workspace">
      <section className="pm-panel project-chain-summary">
        <div className="pm-section-head">
          <div>
            <h3>业务链路</h3>
            <small>
              {settings.binding === null
                ? "尚未绑定"
                : `${settings.binding.definitionSnapshot.metadata.displayName} · ${settings.binding.chainKey} · v${settings.binding.workflowDefinitionVersion}`}
            </small>
          </div>
          <span
            className={`pm-pill chain-coverage-${overview.coverage.status}`}
          >
            {coverageLabel(overview.coverage.status)}
          </span>
        </div>
        <div className="project-chain-kpis">
          <div>
            <span>来源覆盖</span>
            <strong>
              {
                overview.coverage.sources.filter(
                  (source) => source.status === "fresh",
                ).length
              }
              /{overview.coverage.sources.length}
            </strong>
            <small>新鲜来源</small>
          </div>
          <div>
            <span>工作流实例</span>
            <strong>{overview.workflowSummary.activeInstances}</strong>
            <small>{overview.workflowSummary.blockedInstances} 个阻断</small>
          </div>
          <div>
            <span>待处理 Alert</span>
            <strong>{overview.alerts.length}</strong>
            <small>按严重度排序</small>
          </div>
          <div>
            <span>刷新时间</span>
            <strong className="project-chain-time">
              {formatDateTime(overview.generatedAt)}
            </strong>
            <small>每次读取重新计算</small>
          </div>
        </div>
        {overview.blockedReasons.length > 0 && (
          <div className="project-chain-blockers">
            {overview.blockedReasons.map((reason) => (
              <span key={reason.code}>
                <AlertTriangle size={12} />
                {reason.message}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="project-chain-grid">
        <section className="pm-panel">
          <div className="pm-section-head">
            <h3>链路配置</h3>
            <Workflow size={14} />
          </div>
          {!canWrite && (
            <div className="project-chain-readonly">当前账号只读</div>
          )}
          {platformAdministrator && (
            <div className="project-chain-flags">
              <button
                className={`pm-btn ${
                  settings.featureFlags.businessChain.enabled
                    ? "secondary"
                    : "primary"
                }`}
                type="button"
                disabled={flagsMutation.isPending}
                onClick={() =>
                  flagsMutation.mutate({
                    businessChainEnabled:
                      !settings.featureFlags.businessChain.enabled,
                    expectedBusinessChainRevision:
                      settings.featureFlags.businessChain.revision,
                  })
                }
              >
                业务链路
                <span>
                  {settings.featureFlags.businessChain.enabled
                    ? "已开启"
                    : "已关闭"}
                </span>
              </button>
              <button
                className={`pm-btn ${
                  settings.featureFlags.sourceMock.enabled
                    ? "secondary"
                    : "primary"
                }`}
                type="button"
                disabled={flagsMutation.isPending}
                onClick={() =>
                  flagsMutation.mutate({
                    sourceMockEnabled:
                      !settings.featureFlags.sourceMock.enabled,
                    expectedSourceMockRevision:
                      settings.featureFlags.sourceMock.revision,
                  })
                }
              >
                Mock 来源
                <span>
                  {settings.featureFlags.sourceMock.enabled
                    ? "已开启"
                    : "已关闭"}
                </span>
              </button>
            </div>
          )}
          <div className="project-chain-binding-form">
            <label>
              <span>可用业务链路</span>
              <select
                value={selectedCandidate?.workflowDefinitionId ?? ""}
                onChange={(event) => setCandidateId(event.target.value)}
                disabled={!canWrite || candidates.length === 0}
              >
                <option value="">没有可用候选</option>
                {candidates.map((candidate) => (
                  <option
                    key={candidate.workflowDefinitionId}
                    value={candidate.workflowDefinitionId}
                  >
                    {candidate.displayName} · {candidate.chainKey} · v
                    {candidate.version}
                  </option>
                ))}
              </select>
              <small>
                {settings.template === null
                  ? "直接使用项目内业务链路定义"
                  : `模板策略：${templateModeLabel(settings.template.policy.mode)}`}
              </small>
            </label>
            <div className="project-chain-actions">
              <button
                className="pm-btn primary"
                type="button"
                disabled={
                  !canWrite ||
                  !settings.featureFlags.businessChain.enabled ||
                  selectedCandidate === undefined ||
                  bindMutation.isPending
                }
                onClick={() => bindMutation.mutate()}
              >
                <Link2 size={13} />
                {settings.binding === null ? "绑定链路" : "升级版本"}
              </button>
              <button
                className="pm-btn secondary"
                type="button"
                disabled={
                  !canWrite ||
                  settings.binding === null ||
                  unbindMutation.isPending
                }
                onClick={() => unbindMutation.mutate()}
              >
                <Link2Off size={13} />
                解绑
              </button>
            </div>
          </div>
          {bindMutation.error !== null && (
            <div className="pm-error">{bindMutation.error.message}</div>
          )}
          {unbindMutation.error !== null && (
            <div className="pm-error">{unbindMutation.error.message}</div>
          )}
          {flagsMutation.error !== null && (
            <div className="pm-error">{flagsMutation.error.message}</div>
          )}

          {canWrite && availableDefinitions.length > 0 && (
            <details className="project-chain-definition-editor">
              <summary>将工作流配置为业务链路</summary>
              <div className="project-chain-form-grid">
                <label>
                  <span>工作流</span>
                  <select
                    value={definitionId}
                    onChange={(event) => setDefinitionId(event.target.value)}
                  >
                    {availableDefinitions.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>
                        {workflow.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>链路键</span>
                  <input
                    value={chainKey}
                    onChange={(event) =>
                      setChainKey(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9_-]/g, "_"),
                      )
                    }
                    placeholder="DELIVERY_CHAIN"
                  />
                </label>
                <label>
                  <span>显示名称</span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="项目交付链路"
                  />
                </label>
                <label>
                  <span>来源对象</span>
                  <input
                    value={sourceObjectId}
                    onChange={(event) => setSourceObjectId(event.target.value)}
                    placeholder="可选，例如 project-42"
                  />
                </label>
                <label>
                  <span>来源字段路径</span>
                  <input
                    value={sourcePath}
                    onChange={(event) => setSourcePath(event.target.value)}
                    placeholder="value"
                  />
                </label>
              </div>
              <button
                className="pm-btn secondary"
                type="button"
                disabled={
                  configureMutation.isPending ||
                  !settings.featureFlags.businessChain.enabled ||
                  displayName.trim() === "" ||
                  chainKey.trim() === ""
                }
                onClick={() => configureMutation.mutate()}
              >
                <Check size={13} />
                保存业务链路定义
              </button>
              {configureMutation.error !== null && (
                <div className="pm-error">
                  {configureMutation.error.message}
                </div>
              )}
            </details>
          )}
        </section>

        <section className="pm-panel">
          <div className="pm-section-head">
            <h3>来源新鲜度</h3>
            {canRefreshFixtures && (
              <button
                className="pm-icon-btn"
                type="button"
                title="刷新来源"
                disabled={
                  !settings.featureFlags.businessChain.enabled ||
                  refreshMutation.isPending ||
                  overview.coverage.sources.length === 0
                }
                onClick={() => refreshMutation.mutate()}
              >
                {refreshMutation.isPending ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}
              </button>
            )}
          </div>
          <div className="project-source-list">
            {overview.coverage.sources.map((source) => (
              <div
                className={`project-source-row source-${source.status}`}
                key={source.refKey}
              >
                <span className="project-source-icon">
                  {source.status === "fresh" ? (
                    <ShieldCheck size={14} />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                </span>
                <div>
                  <strong>
                    {source.sourceSystem} · {source.sourceObjectType}
                  </strong>
                  <small>
                    {source.status === "fresh"
                      ? `v${source.activeVersion} · ${formatDateTime(source.observedAt)}`
                      : (source.failureReason ??
                        (source.activeVersion === null
                          ? "尚无有效快照"
                          : `保留 v${source.activeVersion} · ${formatDateTime(source.freshUntil)} 过期`))}
                  </small>
                </div>
                <span>{sourceStatusLabel(source.status)}</span>
              </div>
            ))}
            {overview.coverage.sources.length === 0 && (
              <div className="pm-empty compact">当前链路没有来源字段</div>
            )}
          </div>
          {refreshMutation.error !== null && (
            <div className="pm-error">{refreshMutation.error.message}</div>
          )}
        </section>
      </div>

      <section className="pm-panel project-chain-stages">
        <div className="pm-section-head">
          <h3>业务阶段</h3>
          <span>{overview.nodes.length} 个阶段</span>
        </div>
        <div className="project-stage-grid">
          {overview.nodes.map((node) => (
            <div
              className={`project-stage source-${node.status}`}
              key={`${node.sequence}:${node.stageCode}`}
            >
              <header>
                <span>{String(node.sequence).padStart(2, "0")}</span>
                <div>
                  <strong>{node.stageCode}</strong>
                  <small>{node.summaryMetric ?? node.status}</small>
                </div>
              </header>
              <div className="project-stage-fields">
                {node.fields.map((field) => (
                  <div key={field.key}>
                    <span>{field.label}</span>
                    <strong>{renderBusinessValue(field.value)}</strong>
                    <small className={`freshness-${field.freshness}`}>
                      {sourceStatusLabel(field.freshness)}
                    </small>
                  </div>
                ))}
                {node.fields.length === 0 && (
                  <small className="muted">未配置业务字段</small>
                )}
              </div>
            </div>
          ))}
          {overview.nodes.length === 0 && (
            <div className="pm-empty">绑定业务链路后展示阶段进展</div>
          )}
        </div>
      </section>

      <section className="pm-panel project-chain-alerts">
        <div className="pm-section-head">
          <h3>业务 Alert</h3>
          <span>{overview.alerts.length}</span>
        </div>
        <div className="project-alert-list">
          {overview.alerts.map((alert) => (
            <ProjectAlertRow
              alert={alert}
              canWrite={canWrite}
              key={alert.id}
              onChanged={invalidate}
              onOpenTask={onOpenTask}
            />
          ))}
          {overview.alerts.length === 0 && (
            <div className="pm-empty compact">当前没有未解决业务 Alert</div>
          )}
        </div>
      </section>

      <section className="pm-panel">
        <div className="pm-section-head">
          <h3>工作流与任务摘要</h3>
          <Activity size={14} />
        </div>
        <div className="project-chain-summary-grid">
          <dl className="pm-facts-list">
            <div>
              <dt>活跃工作流</dt>
              <dd>{overview.workflowSummary.activeInstances}</dd>
            </div>
            <div>
              <dt>阻断实例</dt>
              <dd>{overview.workflowSummary.blockedInstances}</dd>
            </div>
            <div>
              <dt>待审批</dt>
              <dd>{overview.workflowSummary.pendingApprovals}</dd>
            </div>
            <div>
              <dt>规划待审核</dt>
              <dd>{overview.workflowSummary.planningReviewRequired}</dd>
            </div>
          </dl>
          <dl className="pm-facts-list">
            <div>
              <dt>任务总数</dt>
              <dd>{overview.taskSummary.total}</dd>
            </div>
            <div>
              <dt>进行中</dt>
              <dd>{overview.taskSummary.inProgress}</dd>
            </div>
            <div>
              <dt>待验收</dt>
              <dd>{overview.taskSummary.review}</dd>
            </div>
            <div>
              <dt>阻断</dt>
              <dd>{overview.taskSummary.blocked}</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}

function ProjectAlertRow({
  alert,
  canWrite,
  onChanged,
  onOpenTask,
}: {
  alert: ProjectAlert;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onOpenTask: (taskId: string) => void;
}) {
  const [suppressUntil, setSuppressUntil] = useState(() =>
    new Date(Date.now() + 60 * 60 * 1_000).toISOString().slice(0, 16),
  );
  const acknowledgeMutation = useMutation({
    mutationFn: () =>
      acknowledgeProjectAlert(alert.id, {
        expectedRevision: alert.revision,
        note: "从项目概览确认",
      }),
    onSuccess: onChanged,
  });
  const resolveMutation = useMutation({
    mutationFn: () =>
      resolveProjectAlert(alert.id, {
        expectedRevision: alert.revision,
        note: "从项目概览解决",
      }),
    onSuccess: onChanged,
  });
  const suppressMutation = useMutation({
    mutationFn: () =>
      suppressProjectAlert(alert.id, {
        expectedRevision: alert.revision,
        until: new Date(suppressUntil).toISOString(),
        note: "从项目概览抑制",
      }),
    onSuccess: onChanged,
  });
  return (
    <article className={`project-alert-row severity-${alert.severity}`}>
      <div className="project-alert-main">
        <AlertTriangle size={15} />
        <div>
          <strong>{alert.title}</strong>
          <small>
            {alert.sourceSystem} · {alert.message || alert.conditionCode}
          </small>
        </div>
        <span>{severityLabel(alert.severity)}</span>
        <span>{lifecycleLabel(alert.lifecycle)}</span>
      </div>
      <div className="project-alert-actions">
        {alert.linkedTaskIds[0] !== undefined && (
          <button
            className="pm-btn secondary"
            type="button"
            onClick={() => onOpenTask(alert.linkedTaskIds[0]!)}
          >
            查看任务
          </button>
        )}
        {canWrite && alert.lifecycle !== "acknowledged" && (
          <button
            className="pm-btn secondary"
            type="button"
            disabled={
              acknowledgeMutation.isPending || alert.lifecycle === "resolved"
            }
            onClick={() => acknowledgeMutation.mutate()}
          >
            确认
          </button>
        )}
        {canWrite && alert.lifecycle !== "resolved" && (
          <>
            <label className="project-alert-suppress">
              <Timer size={12} />
              <input
                type="datetime-local"
                value={suppressUntil}
                onChange={(event) => setSuppressUntil(event.target.value)}
              />
              <button
                className="pm-btn secondary"
                type="button"
                disabled={suppressMutation.isPending}
                onClick={() => suppressMutation.mutate()}
              >
                抑制
              </button>
            </label>
            <button
              className="pm-btn primary"
              type="button"
              disabled={resolveMutation.isPending}
              onClick={() => resolveMutation.mutate()}
            >
              解决
            </button>
          </>
        )}
      </div>
      {(acknowledgeMutation.error ??
        resolveMutation.error ??
        suppressMutation.error) !== null && (
        <div className="pm-error">
          {
            (
              acknowledgeMutation.error ??
              resolveMutation.error ??
              suppressMutation.error
            )?.message
          }
        </div>
      )}
    </article>
  );
}

function businessChainInput(
  workflow: WorkflowDefinition,
  chainKey: string,
  displayName: string,
  sourceObjectId: string,
  sourcePath: string,
): BusinessChainDefinitionInput {
  const nodes =
    workflow.graph?.nodes.map((node, index) => ({
      sequence: index + 1,
      stageCode: `STAGE_${index + 1}`,
      fields:
        sourceObjectId.trim() === ""
          ? []
          : [
              {
                key: "businessValue",
                label: node.name,
                bindings: [
                  {
                    refKey: `mock:${sourceObjectId}:${node.id}`,
                    sourceKind: "mock",
                    sourceSystem: "mock",
                    objectType: "business-record",
                    objectId: sourceObjectId.trim(),
                    path: sourcePath.trim() || "value",
                    required: true,
                  },
                ],
              },
            ],
    })) ??
    workflow.steps.map((step, index) => ({
      sequence: index + 1,
      stageCode: `STAGE_${index + 1}`,
      fields:
        sourceObjectId.trim() === ""
          ? []
          : [
              {
                key: "businessValue",
                label: step.name,
                bindings: [
                  {
                    refKey: `mock:${sourceObjectId}:${step.id}`,
                    sourceKind: "mock",
                    sourceSystem: "mock",
                    objectType: "business-record",
                    objectId: sourceObjectId.trim(),
                    path: sourcePath.trim() || "value",
                    required: true,
                  },
                ],
              },
            ],
    }));
  return {
    chainKey,
    templateKey: `PROJECT_${chainKey}`,
    displayName,
    projectTypeCodes: [],
    snapshotPolicy: "pin-at-project-create",
    allowUnboundSources: sourceObjectId.trim() === "",
    nodes:
      nodes.length === 0
        ? [
            {
              sequence: 1,
              stageCode: "STAGE_1",
              fields: [],
            },
          ]
        : nodes,
    expectedRevision: workflow.revision,
  };
}

function renderBusinessValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function coverageLabel(status: ProjectProgressOverview["coverage"]["status"]) {
  return {
    complete: "完整",
    partial: "部分来源",
    stale: "已过期",
    error: "来源异常",
  }[status];
}

function sourceStatusLabel(
  status: "fresh" | "stale" | "error" | "missing",
): string {
  return {
    fresh: "最新",
    stale: "已过期",
    error: "刷新失败",
    missing: "缺失",
  }[status];
}

function templateModeLabel(mode: ProjectTemplateBusinessChainMode): string {
  return {
    required: "必须绑定",
    optional: "可选绑定",
    none: "不启用",
  }[mode];
}

function severityLabel(alert: ProjectAlert["severity"]): string {
  return { info: "提示", warning: "警告", critical: "严重" }[alert];
}

function lifecycleLabel(alert: ProjectAlert["lifecycle"]): string {
  return {
    open: "待处理",
    acknowledged: "已确认",
    suppressed: "已抑制",
    resolved: "已解决",
  }[alert];
}
