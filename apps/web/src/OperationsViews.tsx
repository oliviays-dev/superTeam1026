import type {
  Agent,
  Meeting,
  MeetingAiPolicy,
  MeetingDetail,
  Project,
  WorkbenchSourceRef,
  WorkflowDefinition,
  WorkflowInstanceDetail,
  WorkflowRuntimeNode,
  WorkflowValidationResult,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  Factory,
  FileText,
  MessageSquare,
  PackageX,
  Plus,
  Pause,
  Play,
  RefreshCw,
  Square,
  Star,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  closeMeeting,
  completeWorkflowNode,
  cosignWorkflowApproval,
  createMeeting,
  createWorkflow,
  decideWorkflowApproval,
  dispatchWorkflowStep,
  getWorkflowInstanceDetail,
  importWorkflowMarkdown,
  getMeeting,
  getMeetingAiPolicy,
  getWorkbenchDashboard,
  listMeetings,
  listProjectMembers,
  listProjectRoles,
  listWorkbenchFollows,
  listWorkflowInstances,
  listWorkflows,
  markWorkbenchBriefRead,
  pauseWorkflow,
  postMeetingMessage,
  transitionMeetingAiPolicy,
  triggerMeetingAi,
  reconcileWorkflow,
  refreshWorkbenchBrief,
  resumeWorkflow,
  retryWorkflowNode,
  setWorkbenchFollow,
  startWorkflow,
  transferWorkflowApproval,
  updateWorkbenchBriefSettings,
  updateMeetingAiPolicy,
  validateWorkflowMarkdown,
} from "./api.js";
import { MeetingDecisionsPanel } from "./MeetingDecisionsPanel.js";
import { WorkflowRuntimePanel } from "./WorkflowRuntimePanel.js";

interface ProjectViewProps {
  readonly projects: Project[];
  readonly agents: Agent[];
  readonly projectId: string;
  readonly onProjectChange: (projectId: string) => void;
}

const workbenchModuleMeta = {
  metrics: 6,
  brief: 6,
  todo: 4,
  focus: 2,
  "meeting-minutes": 3,
  control: 3,
  supply: 3,
  supplier: 3,
  reports: 6,
} as const;

function WorkbenchCard({
  module,
  title,
  meta,
  actions,
  children,
}: {
  module: keyof typeof workbenchModuleMeta;
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`workbench-card module-${module}`}
      style={
        {
          "--workbench-cols": workbenchModuleMeta[module],
        } as CSSProperties
      }
    >
      <header className="workbench-card-head">
        <div>
          <h2>{title}</h2>
          {meta !== undefined && <span>{meta}</span>}
        </div>
        {actions !== undefined && (
          <div className="workbench-card-actions">{actions}</div>
        )}
      </header>
      <div className="workbench-card-body">{children}</div>
    </section>
  );
}

function isNavigableSource(source: WorkbenchSourceRef): boolean {
  return !["supply-exception", "supplier-risk"].includes(source.route);
}

export function WorkbenchView({
  onOpenSource,
}: ProjectViewProps & {
  onOpenSource: (source: WorkbenchSourceRef) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"personal" | "cockpit">("personal");
  const dashboardQuery = useQuery({
    queryKey: ["workbench-dashboard"],
    queryFn: getWorkbenchDashboard,
    refetchInterval: 15_000,
  });
  const dashboard = dashboardQuery.data;
  const refreshMutation = useMutation({
    mutationFn: () => refreshWorkbenchBrief(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });
  const readMutation = useMutation({
    mutationFn: (briefId: string) => markWorkbenchBriefRead(briefId, true),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });
  const settingsMutation = useMutation({
    mutationFn: updateWorkbenchBriefSettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });
  const followMutation = useMutation({
    mutationFn: setWorkbenchFollow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });

  useEffect(() => {
    const brief = dashboard?.brief;
    if (brief !== null && brief !== undefined && !brief.read) {
      readMutation.mutate(brief.id);
    }
  }, [dashboard?.brief?.id, dashboard?.brief?.read]);

  const openSource = (source: WorkbenchSourceRef) => {
    if (source.available) onOpenSource(source);
  };
  const taskSource = (input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
  }): WorkbenchSourceRef => ({
    kind: "task",
    id: input.id,
    projectId: input.projectId,
    label: input.title,
    route: "task",
    targetId: input.id,
    available: true,
  });
  const followSource = (input: {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly type: "task" | "workflow";
  }): WorkbenchSourceRef => ({
    kind: input.type,
    id: input.id,
    projectId: input.projectId,
    label: input.title,
    route: input.type,
    targetId: input.id,
    available: true,
  });
  const busy = dashboardQuery.isFetching || refreshMutation.isPending;
  const error = dashboardQuery.error ?? refreshMutation.error;

  return (
    <main className="pm-page workbench-page">
      <header className="pm-page-head workbench-head">
        <div className="workbench-mode" role="group" aria-label="工作台模式">
          <button
            type="button"
            aria-pressed={mode === "personal"}
            className={mode === "personal" ? "active" : ""}
            onClick={() => setMode("personal")}
          >
            我的工作台
          </button>
          <button
            type="button"
            aria-pressed={mode === "cockpit"}
            className={mode === "cockpit" ? "active" : ""}
            onClick={() => setMode("cockpit")}
          >
            管理驾驶舱
          </button>
        </div>
        <div className="pm-head-actions">
          <span className="workbench-updated">
            {dashboard === undefined
              ? "正在读取工作台"
              : `更新于 ${formatDateTime(dashboard.generatedAt)}`}
          </span>
          <button
            className="pm-icon-btn"
            type="button"
            title="刷新每日简报"
            aria-label="刷新每日简报"
            disabled={mode !== "personal" || busy || dashboard?.readOnly}
            onClick={() => refreshMutation.mutate()}
          >
            <RefreshCw size={14} className={busy ? "spin" : undefined} />
          </button>
        </div>
      </header>

      {mode === "cockpit" ? (
        <section className="workbench-cockpit-placeholder">
          <strong>管理驾驶舱</strong>
          <p>全局经营与组织分析将在后续批次接入。</p>
        </section>
      ) : (
        <>
          {dashboardQuery.isLoading && (
            <div className="workbench-loading-grid" aria-busy="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <div className="workbench-skeleton" key={index} />
              ))}
            </div>
          )}
          {error !== null && (
            <div className="pm-error workbench-error">
              {error instanceof Error
                ? `工作台刷新失败：${error.message}。已保留上次成功内容。`
                : "工作台刷新失败，已保留上次成功内容。"}
              <button
                className="pm-btn secondary"
                type="button"
                onClick={() => void dashboardQuery.refetch()}
              >
                重试
              </button>
            </div>
          )}
          {dashboard !== undefined && (
            <div className="workbench-canvas" aria-busy={busy}>
              <WorkbenchCard
                module="brief"
                title="每日简报"
                meta={
                  dashboard.brief === null
                    ? "尚未生成"
                    : `v${dashboard.brief.version} · ${dashboard.brief.read ? "已读" : "未读"}`
                }
                actions={
                  <select
                    className="pm-compact-select workbench-frequency"
                    aria-label="简报更新频次"
                    value={dashboard.settings.frequency}
                    disabled={settingsMutation.isPending || dashboard.readOnly}
                    onChange={(event) =>
                      settingsMutation.mutate({
                        frequency: event.target.value as
                          | "daily-0800"
                          | "daily-0800-1300"
                          | "every-4-hours"
                          | "weekly-monday-0800",
                      })
                    }
                  >
                    <option value="daily-0800">每天 08:00</option>
                    <option value="daily-0800-1300">每天 08:00 / 13:00</option>
                    <option value="every-4-hours">每 4 小时</option>
                    <option value="weekly-monday-0800">周一 08:00</option>
                  </select>
                }
              >
                {dashboard.readOnly && (
                  <div className="pm-readonly-notice">
                    当前账号没有可访问的活动项目，工作台为只读空态。
                  </div>
                )}
                {dashboard.brief?.snapshot.items.length ? (
                  <div className="workbench-brief-list">
                    {dashboard.brief.snapshot.items.slice(0, 6).map((item) => {
                      const source = item.sourceRefs.find(isNavigableSource);
                      return (
                        <article
                          className={`workbench-brief-item ${item.severity}`}
                          key={item.id}
                        >
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.body}</p>
                          </div>
                          {source !== undefined && (
                            <button
                              className="source-link"
                              type="button"
                              onClick={() => openSource(source)}
                            >
                              来源
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="pm-empty compact">当前周期没有新增简报</div>
                )}
              </WorkbenchCard>

              <WorkbenchCard
                module="todo"
                title="我的待办"
                meta={`${dashboard.todos.length} 项`}
              >
                <div className="workbench-list">
                  {dashboard.todos.slice(0, 6).map((todo) => (
                    <button
                      className="workbench-item"
                      type="button"
                      key={todo.taskId}
                      onClick={() =>
                        openSource(
                          taskSource({
                            id: todo.taskId,
                            projectId: todo.projectId,
                            title: todo.title,
                          }),
                        )
                      }
                    >
                      <span>
                        <strong>{todo.title}</strong>
                        <small>
                          {todo.projectName} · {todo.priority}
                        </small>
                      </span>
                      <i
                        className={`pm-pill ${
                          todo.status === "review" ? "review" : "progress"
                        }`}
                      >
                        {todo.status === "review" ? "待验收" : "待处理"}
                      </i>
                    </button>
                  ))}
                  {dashboard.todos.length === 0 && (
                    <div className="pm-empty compact">
                      当前没有待处理或待验收事项
                    </div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="focus"
                title="重点关注"
                meta={`${dashboard.focus.length} 项`}
              >
                <div className="workbench-list">
                  {dashboard.focus.slice(0, 6).map((item) => (
                    <div
                      className="workbench-focus-row"
                      key={`${item.type}:${item.id}`}
                    >
                      <button
                        className="workbench-focus-open"
                        type="button"
                        onClick={() => openSource(followSource(item))}
                      >
                        <Star
                          size={14}
                          fill={item.directFollow ? "currentColor" : "none"}
                        />
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.followReason}</small>
                        </span>
                        <ArrowRight size={13} />
                      </button>
                      {item.directFollow && (
                        <button
                          className="pm-icon-btn"
                          type="button"
                          title={`取消关注${item.title}`}
                          aria-label={`取消关注${item.title}`}
                          aria-pressed="true"
                          disabled={
                            followMutation.isPending || dashboard.readOnly
                          }
                          onClick={() =>
                            followMutation.mutate({
                              targetType: item.type,
                              targetId: item.id,
                              projectId: item.projectId,
                              followed: false,
                            })
                          }
                        >
                          <Star size={13} fill="currentColor" />
                        </button>
                      )}
                    </div>
                  ))}
                  {dashboard.focus.length === 0 && (
                    <div className="pm-empty compact">
                      在任务或工作流详情中点击星标即可关注
                    </div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="meeting-minutes"
                title="会议结论"
                meta={`${dashboard.meetingConclusions.length} 场`}
              >
                <div className="workbench-list">
                  {dashboard.meetingConclusions.slice(0, 5).map((meeting) => (
                    <button
                      className="workbench-minutes"
                      type="button"
                      key={meeting.meetingId}
                      onClick={() =>
                        openSource({
                          kind: "meeting",
                          id: meeting.meetingId,
                          projectId: meeting.projectId,
                          label: meeting.title,
                          route: "meeting",
                          targetId: meeting.meetingId,
                          available: true,
                        })
                      }
                    >
                      <span>
                        <strong>{meeting.title}</strong>
                        <small>{meeting.conclusion}</small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  ))}
                  {dashboard.meetingConclusions.length === 0 && (
                    <div className="pm-empty compact">暂无会议结论</div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="control"
                title="运行异常"
                meta={`${dashboard.runExceptions.length} 个`}
              >
                <div className="workbench-list">
                  {dashboard.runExceptions.slice(0, 5).map((run) => (
                    <button
                      className="workbench-focus-item"
                      type="button"
                      key={run.runId}
                      onClick={() =>
                        openSource(
                          taskSource({
                            id: run.taskId,
                            projectId: run.projectId,
                            title: run.title,
                          }),
                        )
                      }
                    >
                      <TriangleAlert size={14} />
                      <span>
                        <strong>{run.title}</strong>
                        <small>
                          {run.projectName} · {run.status}
                        </small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  ))}
                  {dashboard.runExceptions.length === 0 && (
                    <div className="pm-empty compact">当前没有运行异常</div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="supply"
                title="供给例外"
                meta={`${dashboard.supplyExceptions.length} 项`}
              >
                <div className="workbench-list">
                  {dashboard.supplyExceptions.slice(0, 5).map((exception) => (
                    <article
                      className={`workbench-risk ${exception.severity}`}
                      key={exception.id}
                    >
                      <PackageX size={15} />
                      <span>
                        <strong>{exception.title}</strong>
                        <small>
                          {exception.impactScope || "影响范围待确认"}
                        </small>
                        {exception.suggestedAction !== "" && (
                          <em>{exception.suggestedAction}</em>
                        )}
                      </span>
                    </article>
                  ))}
                  {dashboard.supplyExceptions.length === 0 && (
                    <div className="pm-empty compact">
                      当前没有持久化供给例外
                    </div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="supplier"
                title="供应商风险"
                meta={`${dashboard.supplierRisks.length} 项`}
              >
                <div className="workbench-list">
                  {dashboard.supplierRisks.slice(0, 5).map((risk) => (
                    <article className="workbench-risk" key={risk.id}>
                      <Factory size={15} />
                      <span>
                        <strong>{risk.supplierName}</strong>
                        <small>
                          {risk.riskType} · 评分 {risk.riskScore}
                        </small>
                        {risk.suggestedAction !== "" && (
                          <em>{risk.suggestedAction}</em>
                        )}
                      </span>
                    </article>
                  ))}
                  {dashboard.supplierRisks.length === 0 && (
                    <div className="pm-empty compact">
                      当前没有持久化供应商风险
                    </div>
                  )}
                </div>
              </WorkbenchCard>

              <WorkbenchCard
                module="reports"
                title="项目日报"
                meta={`${dashboard.projectReports.length} 份`}
              >
                <div className="workbench-report-grid">
                  {dashboard.projectReports.slice(0, 8).map((report) => (
                    <button
                      className="workbench-report-link"
                      type="button"
                      key={report.id}
                      onClick={() =>
                        openSource({
                          kind: "project",
                          id: report.id,
                          projectId: report.projectId,
                          label: report.projectName,
                          route: "report",
                          targetId: report.id,
                          available: true,
                        })
                      }
                    >
                      <FileText size={15} />
                      <span>
                        <strong>{report.projectName}</strong>
                        <small>
                          {report.reportDate} · v{report.version}
                        </small>
                      </span>
                      <ArrowRight size={13} />
                    </button>
                  ))}
                  {dashboard.projectReports.length === 0 && (
                    <div className="pm-empty compact">
                      项目内生成日报后会汇总到这里
                    </div>
                  )}
                </div>
              </WorkbenchCard>
            </div>
          )}
        </>
      )}
    </main>
  );
}

export function WorkflowsView({
  projects,
  projectId,
  onProjectChange,
  initialInstanceId,
}: ProjectViewProps & {
  initialInstanceId?: string;
}) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [roleId, setRoleId] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(
    null,
  );
  const [instanceId, setInstanceId] = useState(initialInstanceId ?? "");
  const workflowsQuery = useQuery({
    queryKey: ["workflows", selectedProjectId],
    queryFn: () => listWorkflows(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const instancesQuery = useQuery({
    queryKey: ["workflow-instances", selectedProjectId],
    queryFn: () => listWorkflowInstances(selectedProjectId),
    enabled: selectedProjectId !== "",
    refetchInterval: 4_000,
  });
  const detailQuery = useQuery({
    queryKey: ["workflow-instance-detail", instanceId],
    queryFn: () => getWorkflowInstanceDetail(instanceId),
    enabled: instanceId !== "",
    refetchInterval: 2_000,
  });
  useEffect(() => {
    if (initialInstanceId !== undefined) {
      setInstanceId(initialInstanceId);
    }
  }, [initialInstanceId, selectedProjectId]);
  const rolesQuery = useQuery({
    queryKey: ["project-roles", selectedProjectId],
    queryFn: () => listProjectRoles(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const membersQuery = useQuery({
    queryKey: ["project-members", selectedProjectId],
    queryFn: () => listProjectMembers(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const createMutation = useMutation({
    mutationFn: () => {
      const stepNames = steps
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
      return createWorkflow({
        projectId: selectedProjectId,
        name,
        description: "",
        stepNames,
        stepRoleIds: roleId === "" ? [] : stepNames.map(() => roleId),
      });
    },
    onSuccess: () => {
      setName("");
      setSteps("");
      setRoleId("");
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const startMutation = useMutation({
    mutationFn: (workflow: WorkflowDefinition) =>
      startWorkflow(
        workflow.id,
        `${workflow.name} · ${new Date().toLocaleString("zh-CN")}`,
      ),
    onSuccess: (instance) => {
      setInstanceId(instance.id);
      void queryClient.invalidateQueries({ queryKey: ["workflow-instances"] });
    },
  });
  const validateMutation = useMutation({
    mutationFn: () => validateWorkflowMarkdown({ markdown }),
    onSuccess: setValidation,
  });
  const importMutation = useMutation({
    mutationFn: () =>
      importWorkflowMarkdown({
        projectId: selectedProjectId,
        markdown,
      }),
    onSuccess: () => {
      setMarkdown("");
      setValidation(null);
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const completeMutation = useMutation({
    mutationFn: (node: WorkflowRuntimeNode) =>
      completeWorkflowNode(instanceId, {
        nodeId: node.nodeId,
        output: "界面人工确认完成",
      }),
    onSuccess: refreshWorkflowQueries,
  });
  const approvalMutation = useMutation({
    mutationFn: (input: {
      readonly node: WorkflowRuntimeNode;
      readonly decision: "approve" | "reject";
    }) =>
      decideWorkflowApproval(instanceId, {
        nodeId: input.node.nodeId,
        decision: input.decision,
        note: input.decision === "approve" ? "界面审批通过" : "界面审批拒绝",
      }),
    onSuccess: refreshWorkflowQueries,
  });
  const transferMutation = useMutation({
    mutationFn: (input: {
      readonly node: WorkflowRuntimeNode;
      readonly targetActorId: string;
      readonly note: string;
    }) =>
      transferWorkflowApproval(instanceId, {
        nodeId: input.node.nodeId,
        targetActorId: input.targetActorId,
        note: input.note,
      }),
    onSuccess: refreshWorkflowQueries,
  });
  const cosignMutation = useMutation({
    mutationFn: (input: {
      readonly node: WorkflowRuntimeNode;
      readonly approverId: string;
      readonly note: string;
    }) =>
      cosignWorkflowApproval(instanceId, {
        nodeId: input.node.nodeId,
        approvers: [{ kind: "user", id: input.approverId }],
        note: input.note,
      }),
    onSuccess: refreshWorkflowQueries,
  });
  const retryMutation = useMutation({
    mutationFn: (node: WorkflowRuntimeNode) =>
      retryWorkflowNode(instanceId, {
        nodeId: node.nodeId,
        reason: "界面人工重试",
      }),
    onSuccess: refreshWorkflowQueries,
  });
  const dispatchMutation = useMutation({
    mutationFn: () => dispatchWorkflowStep(instanceId),
    onSuccess: refreshWorkflowQueries,
  });
  const pauseMutation = useMutation({
    mutationFn: () => pauseWorkflow(instanceId, { reason: "界面暂停" }),
    onSuccess: refreshWorkflowQueries,
  });
  const resumeMutation = useMutation({
    mutationFn: () => resumeWorkflow(instanceId, { reason: "界面恢复" }),
    onSuccess: refreshWorkflowQueries,
  });
  const reconcileMutation = useMutation({
    mutationFn: () => reconcileWorkflow(instanceId),
    onSuccess: refreshWorkflowQueries,
  });
  const panelPending =
    completeMutation.isPending ||
    approvalMutation.isPending ||
    transferMutation.isPending ||
    cosignMutation.isPending ||
    retryMutation.isPending ||
    dispatchMutation.isPending ||
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    reconcileMutation.isPending;

  function refreshWorkflowQueries() {
    void queryClient.invalidateQueries({
      queryKey: ["workflow-instance-detail", instanceId],
    });
    void queryClient.invalidateQueries({ queryKey: ["workflow-instances"] });
    void queryClient.invalidateQueries({ queryKey: ["workbench-summary"] });
  }
  const detail: WorkflowInstanceDetail | undefined = detailQuery.data;
  const followsQuery = useQuery({
    queryKey: ["workbench-follows"],
    queryFn: listWorkbenchFollows,
  });
  const workflowFollowed =
    detail !== undefined &&
    (followsQuery.data?.some(
      (follow) =>
        follow.targetType === "workflow" &&
        follow.targetId === detail.instance.id,
    ) ??
      false);
  const workflowFollowMutation = useMutation({
    mutationFn: (input: {
      readonly projectId: string;
      readonly workflowId: string;
      readonly followed: boolean;
    }) =>
      setWorkbenchFollow({
        targetType: "workflow",
        targetId: input.workflowId,
        projectId: input.projectId,
        followed: input.followed,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workbench-follows"] });
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });
  const panelError =
    detailQuery.error ??
    completeMutation.error ??
    approvalMutation.error ??
    transferMutation.error ??
    cosignMutation.error ??
    retryMutation.error ??
    dispatchMutation.error ??
    pauseMutation.error ??
    resumeMutation.error ??
    reconcileMutation.error;

  return (
    <main className="pm-page">
      <header className="pm-page-head">
        <div>
          <h1>工作流</h1>
          <p>用可追踪步骤串联人工节点、Agent 节点和交付门禁。</p>
        </div>
        <select
          className="pm-compact-select"
          aria-label="工作流项目"
          value={selectedProjectId}
          onChange={(event) => {
            onProjectChange(event.target.value);
            setInstanceId("");
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>

      <div className="pm-two-column workflow-layout">
        <section className="pm-panel workflow-library">
          <div className="pm-section-head">
            <div>
              <h2>工作流定义</h2>
              <p>选择定义即可启动新的运行实例。</p>
            </div>
            <Workflow size={16} />
          </div>
          <form
            className="workflow-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                name.trim() !== "" &&
                steps
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean).length > 0
              ) {
                createMutation.mutate();
              }
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="工作流名称"
            />
            <textarea
              value={steps}
              onChange={(event) => setSteps(event.target.value)}
              placeholder={"每行一个步骤\n需求确认\n方案分析\n人工验收"}
              rows={4}
            />
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              aria-label="工作流执行角色"
            >
              <option value="">按人工 / Agent 默认执行</option>
              {(rolesQuery.data ?? []).map((role) => (
                <option value={role.id} key={role.id}>
                  项目角色 · {role.name}
                </option>
              ))}
            </select>
            <button className="pm-btn secondary" type="submit">
              <Plus size={14} />
              创建定义
            </button>
          </form>
          <details className="workflow-markdown-import">
            <summary>从 Markdown 导入</summary>
            <textarea
              rows={8}
              value={markdown}
              onChange={(event) => {
                setMarkdown(event.target.value);
                setValidation(null);
              }}
              placeholder={
                "# 工作流：发布流程\n\n## 元信息\n- key: release\n- version: 1..."
              }
            />
            <div>
              <button
                className="pm-btn secondary"
                type="button"
                disabled={markdown.trim() === "" || validateMutation.isPending}
                onClick={() => validateMutation.mutate()}
              >
                校验 Markdown
              </button>
              <button
                className="pm-btn primary"
                type="button"
                disabled={
                  validation?.valid !== true || importMutation.isPending
                }
                onClick={() => importMutation.mutate()}
              >
                导入定义
              </button>
            </div>
            {validation !== null && (
              <div
                className={`workflow-validation${
                  validation.valid ? " valid" : " invalid"
                }`}
              >
                <strong>
                  {validation.valid
                    ? `校验通过 · ${validation.graph?.nodes.length ?? 0} 个节点`
                    : `${validation.errors.length} 个错误`}
                </strong>
                {validation.errors.map((error, index) => (
                  <span key={`error-${index}`}>
                    {error.line === undefined ? "" : `第 ${error.line} 行 · `}
                    {error.message}
                  </span>
                ))}
                {validation.warnings.map((warning, index) => (
                  <em key={`warning-${index}`}>{warning.message}</em>
                ))}
              </div>
            )}
            {(validateMutation.error !== null ||
              importMutation.error !== null) && (
              <div className="pm-error">
                {(validateMutation.error ?? importMutation.error)?.message}
              </div>
            )}
          </details>
          <div className="pm-directory-list">
            {workflowsQuery.data?.map((workflow) => (
              <button
                className="pm-directory-row"
                type="button"
                key={workflow.id}
                onClick={() => startMutation.mutate(workflow)}
              >
                <span className="pm-directory-mark">
                  <Workflow size={13} />
                </span>
                <span className="pm-directory-copy">
                  <strong>{workflow.name}</strong>
                  <small>{workflow.steps.length} 个步骤</small>
                </span>
                <ArrowRight size={13} />
              </button>
            ))}
            {workflowsQuery.data?.length === 0 && (
              <div className="pm-empty compact">尚未创建工作流</div>
            )}
          </div>
          <div className="pm-directory-label">
            <span>运行实例</span>
            <b>{instancesQuery.data?.length ?? 0}</b>
          </div>
          <div className="pm-directory-list workflow-instance-list">
            {instancesQuery.data?.map((workflowInstance) => (
              <button
                className={`pm-directory-row ${
                  workflowInstance.id === instanceId ? "active" : ""
                }`}
                type="button"
                key={workflowInstance.id}
                onClick={() => setInstanceId(workflowInstance.id)}
              >
                <span className="pm-directory-mark">
                  <Workflow size={13} />
                </span>
                <span className="pm-directory-copy">
                  <strong>{workflowInstance.title}</strong>
                  <small>
                    {workflowInstance.status} ·{" "}
                    {formatDateTime(workflowInstance.updatedAt)}
                  </small>
                </span>
                <ArrowRight size={13} />
              </button>
            ))}
            {instancesQuery.data?.length === 0 && (
              <div className="pm-empty compact">尚未启动运行实例</div>
            )}
          </div>
        </section>

        <section className="pm-panel workflow-runtime">
          <div className="pm-section-head">
            <div>
              <h2>运行实例</h2>
              <p>节点状态、分支、审批和运行审计集中展示。</p>
            </div>
            <div className="workflow-runtime-head-actions">
              <span className="pm-pill">
                {instancesQuery.data?.length ?? 0} 个实例
              </span>
              {detail !== undefined && (
                <button
                  className="pm-icon-btn follow-toggle"
                  type="button"
                  title={workflowFollowed ? "取消关注工作流" : "关注工作流"}
                  aria-label={
                    workflowFollowed ? "取消关注工作流" : "关注工作流"
                  }
                  aria-pressed={workflowFollowed}
                  disabled={workflowFollowMutation.isPending}
                  onClick={() =>
                    workflowFollowMutation.mutate({
                      projectId: detail.instance.projectId,
                      workflowId: detail.instance.id,
                      followed: !workflowFollowed,
                    })
                  }
                >
                  <Star
                    size={14}
                    fill={workflowFollowed ? "currentColor" : "none"}
                  />
                </button>
              )}
            </div>
          </div>
          {detail === undefined ? (
            <div className="pm-empty workflow-empty">
              <Workflow size={28} />
              <strong>选择定义或实例</strong>
              <span>运行进度、审批和审计会保留在实例中。</span>
            </div>
          ) : (
            <WorkflowRuntimePanel
              detail={detail}
              pending={panelPending}
              onComplete={(node) => completeMutation.mutate(node)}
              onDispatch={() => dispatchMutation.mutate()}
              onApproval={(node, decision) =>
                approvalMutation.mutate({ node, decision })
              }
              members={membersQuery.data ?? []}
              onTransfer={(node, targetActorId, note) =>
                transferMutation.mutate({ node, targetActorId, note })
              }
              onCosign={(node, approverId, note) =>
                cosignMutation.mutate({ node, approverId, note })
              }
              onRetry={(node) => retryMutation.mutate(node)}
              onPause={() => pauseMutation.mutate()}
              onResume={() => resumeMutation.mutate()}
              onReconcile={() => reconcileMutation.mutate()}
            />
          )}
          {panelError !== null && (
            <div className="pm-error">{panelError.message}</div>
          )}
        </section>
      </div>
    </main>
  );
}

export function MeetingsView({
  projects,
  agents,
  projectId,
  onProjectChange,
  onOpenTask,
  initialMeetingId,
  onInitialMeetingConsumed,
}: ProjectViewProps & {
  onOpenTask: (taskId: string, projectId: string) => void;
  initialMeetingId: string;
  onInitialMeetingConsumed: () => void;
}) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [meetingId, setMeetingId] = useState("");
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [agentId, setAgentId] = useState("");
  const [message, setMessage] = useState("");
  const [mentionAgentIds, setMentionAgentIds] = useState<string[]>([]);
  useEffect(() => {
    if (initialMeetingId === "") return;
    setMeetingId(initialMeetingId);
    onInitialMeetingConsumed();
  }, [initialMeetingId, onInitialMeetingConsumed]);
  const meetingsQuery = useQuery({
    queryKey: ["meetings", selectedProjectId],
    queryFn: () => listMeetings(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const detailQuery = useQuery({
    queryKey: ["meeting", meetingId],
    queryFn: () => getMeeting(meetingId),
    enabled: meetingId !== "",
    refetchInterval: 2_000,
  });
  const membersQuery = useQuery({
    queryKey: ["project-members", selectedProjectId],
    queryFn: () => listProjectMembers(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const createMutation = useMutation({
    mutationFn: () =>
      createMeeting({
        projectId: selectedProjectId,
        title,
        agenda,
        agentIds: agentId === "" ? [] : [agentId],
      }),
    onSuccess: (meeting) => {
      setTitle("");
      setAgenda("");
      setMeetingId(meeting.id);
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
  const messageMutation = useMutation({
    mutationFn: () => postMeetingMessage(meetingId, message, mentionAgentIds),
    onSuccess: () => {
      setMessage("");
      setMentionAgentIds([]);
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-ai-policy", meetingId],
      });
    },
  });
  const closeMutation = useMutation({
    mutationFn: () =>
      closeMeeting(meetingId, "会议由本地用户结束，纪要等待补充。"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
  const detail: MeetingDetail | undefined = detailQuery.data;

  return (
    <main className="pm-page">
      <header className="pm-page-head">
        <div>
          <h1>沟通</h1>
          <p>围绕项目和 AI 伙伴保留可追溯的会议过程与结论。</p>
        </div>
        <select
          className="pm-compact-select"
          aria-label="会议项目"
          value={selectedProjectId}
          onChange={(event) => {
            onProjectChange(event.target.value);
            setMeetingId("");
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>

      <div className="meeting-layout">
        <section className="pm-panel meeting-list-panel">
          <div className="pm-section-head">
            <div>
              <h2>会议</h2>
              <p>{meetingsQuery.data?.length ?? 0} 场会议</p>
            </div>
            <MessageSquare size={16} />
          </div>
          <form
            className="meeting-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim() !== "") createMutation.mutate();
            }}
          >
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="会议主题"
            />
            <textarea
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
              placeholder="会议议程"
              rows={2}
            />
            <select
              aria-label="邀请 AI 伙伴"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">仅本地用户</option>
              {agents
                .filter((agent) => agent.status === "active")
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
            <button className="pm-btn secondary" type="submit">
              <Plus size={14} />
              新建会议
            </button>
          </form>
          <div className="meeting-list">
            {meetingsQuery.data?.map((meeting: Meeting) => (
              <button
                key={meeting.id}
                className={`meeting-row ${
                  meeting.id === meetingId ? "active" : ""
                }`}
                type="button"
                onClick={() => setMeetingId(meeting.id)}
              >
                <span className="meeting-row-icon">
                  <CalendarClock size={14} />
                </span>
                <span>
                  <strong>{meeting.title}</strong>
                  <small>{formatDateTime(meeting.updatedAt)}</small>
                </span>
                <i
                  className={`pm-pill ${meeting.status === "open" ? "progress" : "done"}`}
                >
                  {meeting.status === "open" ? "进行中" : "已结束"}
                </i>
              </button>
            ))}
          </div>
        </section>

        <section className="pm-panel meeting-room">
          {detail === undefined ? (
            <div className="pm-empty meeting-empty">
              <MessageSquare size={28} />
              <strong>选择或创建会议</strong>
              <span>会议消息、AI 参会人和纪要将在这里汇总。</span>
            </div>
          ) : (
            <>
              <div className="instance-head meeting-room-head">
                <div>
                  <strong>{detail.meeting.title}</strong>
                  <span>{detail.meeting.agenda || "无议程"}</span>
                </div>
                <div className="pm-head-actions">
                  <span
                    className={`pm-pill ${detail.meeting.status === "open" ? "progress" : "done"}`}
                  >
                    {detail.meeting.status === "open" ? "进行中" : "已结束"}
                  </span>
                  {detail.meeting.status === "open" && (
                    <button
                      className="pm-btn secondary"
                      type="button"
                      onClick={() => closeMutation.mutate()}
                    >
                      结束会议
                    </button>
                  )}
                </div>
              </div>
              <div className="participant-row">
                {detail.meeting.participants.map((participant) => (
                  <span key={`${participant.kind}-${participant.id}`}>
                    {participant.kind === "agent" && (
                      <span className="bot-mini">AI</span>
                    )}
                    {participant.name}
                  </span>
                ))}
              </div>
              <div className="message-stream">
                {detail.messages.map((item) => (
                  <article
                    className={`meeting-message message-${item.authorType}`}
                    key={item.id}
                  >
                    <div>
                      <strong>{item.authorName}</strong>
                      <time>{formatDateTime(item.createdAt)}</time>
                    </div>
                    <p>{item.content}</p>
                    {item.triggerKind !== null && (
                      <div className="meeting-ai-message-meta">
                        <span>自动发言</span>
                        <span>{item.triggerKind}</span>
                        {item.status === "failed" && <span>失败</span>}
                        {item.runId !== null && (
                          <code>{item.runId.slice(0, 8)}</code>
                        )}
                      </div>
                    )}
                  </article>
                ))}
                {detail.messages.length === 0 && (
                  <div className="pm-empty compact">会议尚未产生消息</div>
                )}
              </div>
              <MeetingAiParticipationPanel
                meeting={detail}
                agents={agents}
                projectArchived={
                  projects.find((project) => project.id === selectedProjectId)
                    ?.status === "archived"
                }
                selectedMentionAgentIds={mentionAgentIds}
                onMentionAgentIdsChange={setMentionAgentIds}
              />
              {detail.meeting.status === "open" && (
                <form
                  className="message-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim() !== "") messageMutation.mutate();
                  }}
                >
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="发送会议消息"
                    rows={2}
                  />
                  <button
                    className="pm-btn primary"
                    type="submit"
                    disabled={
                      message.trim() === "" || messageMutation.isPending
                    }
                  >
                    发送
                  </button>
                </form>
              )}
              <MeetingDecisionsPanel
                meeting={detail}
                members={membersQuery.data ?? []}
                agents={agents}
                onOpenTask={onOpenTask}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function MeetingAiParticipationPanel({
  meeting,
  agents,
  projectArchived,
  selectedMentionAgentIds,
  onMentionAgentIdsChange,
}: {
  readonly meeting: MeetingDetail;
  readonly agents: Agent[];
  readonly projectArchived: boolean;
  readonly selectedMentionAgentIds: string[];
  readonly onMentionAgentIdsChange: (agentIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const meetingId = meeting.meeting.id;
  const policyQuery = useQuery({
    queryKey: ["meeting-ai-policy", meetingId],
    queryFn: () => getMeetingAiPolicy(meetingId),
    refetchInterval: 2_500,
  });
  const [draft, setDraft] = useState<{
    readonly triggerKinds: MeetingAiPolicy["triggerKinds"];
    readonly cooldownSeconds: number;
    readonly maxRounds: number;
    readonly maxMessages: number;
    readonly runBudgetMs: number;
  } | null>(null);
  const [agendaItem, setAgendaItem] = useState(meeting.meeting.agenda);
  useEffect(() => {
    const policy = policyQuery.data;
    if (policy === undefined) return;
    setDraft({
      triggerKinds: policy.triggerKinds,
      cooldownSeconds: policy.cooldownSeconds,
      maxRounds: policy.maxRounds,
      maxMessages: policy.maxMessages,
      runBudgetMs: policy.runBudgetMs,
    });
  }, [policyQuery.data?.revision]);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["meeting-ai-policy", meetingId],
    });
    void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
  };
  const lifecycleMutation = useMutation({
    mutationFn: (transition: "pause" | "resume" | "terminate") => {
      const policy = policyQuery.data;
      if (policy === undefined) throw new Error("AI 发言策略尚未加载");
      return transitionMeetingAiPolicy(meetingId, transition, {
        expectedRevision: policy.revision,
        reason: `会议界面${transition}`,
      });
    },
    onSuccess: refresh,
  });
  const saveMutation = useMutation({
    mutationFn: () => {
      const policy = policyQuery.data;
      if (policy === undefined || draft === null) {
        throw new Error("AI 发言策略尚未加载");
      }
      return updateMeetingAiPolicy(meetingId, {
        expectedRevision: policy.revision,
        triggerKinds: draft.triggerKinds,
        cooldownSeconds: draft.cooldownSeconds,
        maxRounds: draft.maxRounds,
        maxMessages: draft.maxMessages,
        runBudgetMs: draft.runBudgetMs,
      });
    },
    onSuccess: refresh,
  });
  const triggerMutation = useMutation({
    mutationFn: (kind: "round" | "agenda" | "summary") => {
      const currentRound = policyQuery.data?.stats.roundsUsed ?? 0;
      const lastMessage = meeting.messages.at(-1);
      const reason =
        kind === "round"
          ? "界面发起固定轮次"
          : kind === "agenda"
            ? `界面触发议程：${agendaItem.trim()}`
            : "界面请求确定性会议总结";
      return triggerMeetingAi(
        meetingId,
        {
          kind,
          agentIds: [],
          reason,
          ...(kind === "round" ? { roundNumber: currentRound + 1 } : {}),
          ...(kind === "agenda"
            ? {
                agendaItem: agendaItem.trim(),
              }
            : {}),
          ...(kind === "summary" && lastMessage !== undefined
            ? { sourceMessageId: lastMessage.id }
            : {}),
        },
        `batch12a:${meetingId}:${kind}:${
          kind === "round"
            ? currentRound + 1
            : agendaItem.trim() || lastMessage?.id || "summary"
        }`,
      );
    },
    onSuccess: refresh,
  });
  const policy = policyQuery.data;
  const participationBlocked =
    projectArchived || meeting.meeting.status === "closed";
  const busy =
    lifecycleMutation.isPending ||
    saveMutation.isPending ||
    triggerMutation.isPending;
  const error =
    policyQuery.error?.message ??
    lifecycleMutation.error?.message ??
    saveMutation.error?.message ??
    triggerMutation.error?.message;
  const agentParticipants = meeting.meeting.participants.filter(
    (participant) =>
      participant.kind === "agent" &&
      agents.some(
        (agent) => agent.id === participant.id && agent.status === "active",
      ),
  );
  const triggerLabels = {
    mention: "被 @ 时",
    round: "固定轮次",
    agenda: "议程节点",
    summary: "会议总结",
  } as const;

  return (
    <section className="meeting-ai-panel" aria-label="AI 自动发言">
      <div className="meeting-ai-head">
        <div>
          <strong>
            <Bot size={14} />
            AI 自动发言
          </strong>
          <span>
            {policy === undefined
              ? "加载中…"
              : `${policy.stats.remainingRounds} 轮 · ${policy.stats.remainingMessages} 条剩余`}
          </span>
        </div>
        {policy !== undefined && (
          <div className="meeting-ai-actions">
            <label className="meeting-ai-switch">
              <input
                type="checkbox"
                role="switch"
                checked={policy.status === "active"}
                disabled={
                  busy || policy.status === "terminated" || participationBlocked
                }
                onChange={() =>
                  lifecycleMutation.mutate(
                    policy.status === "active" ? "pause" : "resume",
                  )
                }
              />
              <span>自动发言</span>
            </label>
            <button
              className="pm-icon-button"
              type="button"
              title={policy.status === "active" ? "暂停" : "恢复"}
              aria-label={
                policy.status === "active" ? "暂停自动发言" : "恢复自动发言"
              }
              disabled={
                busy || policy.status === "terminated" || participationBlocked
              }
              onClick={() =>
                lifecycleMutation.mutate(
                  policy.status === "active" ? "pause" : "resume",
                )
              }
            >
              {policy.status === "active" ? (
                <Pause size={13} />
              ) : (
                <Play size={13} />
              )}
            </button>
            <button
              className="pm-icon-button danger"
              type="button"
              title="终止自动发言"
              aria-label="终止自动发言"
              disabled={
                busy || policy.status === "terminated" || participationBlocked
              }
              onClick={() => lifecycleMutation.mutate("terminate")}
            >
              <Square size={12} />
            </button>
          </div>
        )}
      </div>
      {error !== undefined && <div className="pm-error">{error}</div>}
      {participationBlocked && (
        <div className="meeting-ai-last-error">
          {projectArchived ? "项目已归档" : "会议已关闭"}，自动发言已停止。
        </div>
      )}
      {policy?.lastErrorMessage !== null &&
        policy?.lastErrorMessage !== undefined && (
          <div className="meeting-ai-last-error">
            {policy.lastErrorCode} · {policy.lastErrorMessage}
          </div>
        )}
      {draft !== null && policy !== undefined && (
        <>
          <div className="meeting-ai-trigger-grid">
            {(
              Object.keys(triggerLabels) as Array<keyof typeof triggerLabels>
            ).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={draft.triggerKinds.includes(kind)}
                  disabled={
                    busy ||
                    policy.status === "terminated" ||
                    participationBlocked
                  }
                  onChange={() =>
                    setDraft({
                      ...draft,
                      triggerKinds: draft.triggerKinds.includes(kind)
                        ? draft.triggerKinds.filter((item) => item !== kind)
                        : [...draft.triggerKinds, kind],
                    })
                  }
                />
                {triggerLabels[kind]}
              </label>
            ))}
          </div>
          <div className="meeting-ai-fields">
            <label>
              <span>冷却秒数</span>
              <input
                type="number"
                min={0}
                max={3600}
                value={draft.cooldownSeconds}
                disabled={
                  busy || policy.status === "terminated" || participationBlocked
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    cooldownSeconds: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>最大轮次</span>
              <input
                type="number"
                min={1}
                max={100}
                value={draft.maxRounds}
                disabled={
                  busy || policy.status === "terminated" || participationBlocked
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    maxRounds: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>最大消息</span>
              <input
                type="number"
                min={1}
                max={500}
                value={draft.maxMessages}
                disabled={
                  busy || policy.status === "terminated" || participationBlocked
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    maxMessages: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>单次预算（秒）</span>
              <input
                type="number"
                min={1}
                max={1800}
                value={Math.round(draft.runBudgetMs / 1_000)}
                disabled={
                  busy || policy.status === "terminated" || participationBlocked
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    runBudgetMs: Number(event.target.value) * 1_000,
                  })
                }
              />
            </label>
          </div>
          <div className="meeting-ai-mentions">
            <span>会议中 @</span>
            {agentParticipants.length === 0 ? (
              <em>当前会议没有活跃 AI 伙伴</em>
            ) : (
              agentParticipants.map((participant) => {
                const selected = selectedMentionAgentIds.includes(
                  participant.id,
                );
                return (
                  <button
                    key={participant.id}
                    type="button"
                    className={selected ? "active" : ""}
                    aria-pressed={selected}
                    disabled={participationBlocked}
                    onClick={() =>
                      onMentionAgentIdsChange(
                        selected
                          ? selectedMentionAgentIds.filter(
                              (agentId) => agentId !== participant.id,
                            )
                          : [...selectedMentionAgentIds, participant.id],
                      )
                    }
                  >
                    {participant.name}
                  </button>
                );
              })
            )}
          </div>
          <div className="meeting-ai-footer">
            <button
              className="pm-btn secondary small"
              type="button"
              disabled={
                busy || policy.status === "terminated" || participationBlocked
              }
              onClick={() => saveMutation.mutate()}
            >
              保存策略
            </button>
            <button
              className="pm-btn secondary small"
              type="button"
              disabled={
                busy || policy.status !== "active" || participationBlocked
              }
              onClick={() => triggerMutation.mutate("round")}
            >
              发起一轮
            </button>
            <button
              className="pm-btn secondary small"
              type="button"
              disabled={
                busy ||
                policy.status !== "active" ||
                participationBlocked ||
                agendaItem.trim() === ""
              }
              onClick={() => triggerMutation.mutate("agenda")}
            >
              触发议程
            </button>
            <button
              className="pm-btn secondary small"
              type="button"
              disabled={
                busy ||
                policy.status !== "active" ||
                meeting.messages.length === 0 ||
                participationBlocked
              }
              onClick={() => triggerMutation.mutate("summary")}
            >
              生成总结
            </button>
          </div>
          <input
            className="meeting-ai-agenda-input"
            aria-label="AI 议程节点"
            value={agendaItem}
            disabled={
              busy || policy.status !== "active" || participationBlocked
            }
            onChange={(event) => setAgendaItem(event.target.value)}
            placeholder="用于 AI 触发的议程节点"
          />
        </>
      )}
    </section>
  );
}
