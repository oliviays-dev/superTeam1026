import type {
  Agent,
  Meeting,
  MeetingDetail,
  Project,
  WorkflowDefinition,
  WorkflowInstanceDetail,
  WorkflowRuntimeNode,
  WorkflowValidationResult,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CircleAlert,
  MessageSquare,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  closeMeeting,
  completeWorkflowNode,
  createMeeting,
  createWorkflow,
  decideWorkflowApproval,
  dispatchWorkflowStep,
  getWorkflowInstanceDetail,
  importWorkflowMarkdown,
  getMeeting,
  getWorkbench,
  listMeetings,
  listMemory,
  listProjectRoles,
  listTasks,
  listWorkflowInstances,
  listWorkflows,
  pauseWorkflow,
  postMeetingMessage,
  reconcileWorkflow,
  resumeWorkflow,
  retryWorkflowNode,
  startWorkflow,
  validateWorkflowMarkdown,
} from "./api.js";
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
  "meeting-minutes": 4,
  control: 2,
  supplier: 4,
} as const;

function WorkbenchCard({
  module,
  title,
  meta,
  children,
}: {
  module: keyof typeof workbenchModuleMeta;
  title: string;
  meta?: string;
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
        <h2>{title}</h2>
        {meta !== undefined && <span>{meta}</span>}
      </header>
      <div className="workbench-card-body">{children}</div>
    </section>
  );
}

export function WorkbenchView({
  projects,
  agents,
  projectId,
  onProjectChange,
  onOpenTask,
}: ProjectViewProps & {
  onOpenTask: (taskId: string, projectId: string) => void;
}) {
  const selectedProjectId = projectId || projects[0]?.id || "";
  const summaryQuery = useQuery({
    queryKey: ["workbench-summary"],
    queryFn: getWorkbench,
    refetchInterval: 5_000,
  });
  const memoryQuery = useQuery({
    queryKey: ["memory", selectedProjectId],
    queryFn: () => listMemory(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => listTasks(selectedProjectId),
    enabled: selectedProjectId !== "",
    refetchInterval: 5_000,
  });
  const meetingsQuery = useQuery({
    queryKey: ["meetings", selectedProjectId],
    queryFn: () => listMeetings(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const summary = summaryQuery.data;
  const tasks = tasksQuery.data ?? [];
  const pendingTasks = tasks.filter(
    (task) => task.status === "queued" || task.status === "in_progress",
  );
  const reviewTasks = tasks.filter((task) => task.status === "review");
  const memory = memoryQuery.data ?? [];
  const meetings = meetingsQuery.data ?? [];
  const metrics = [
    ["项目", summary?.projects, "个"],
    ["执行中任务", summary?.activeTasks, "项"],
    ["待验收", summary?.reviewTasks, "项"],
    ["运行中 Run", summary?.activeRuns, "个"],
    ["项目记忆", summary?.memoryTopics, "条"],
    ["未结束会议", summary?.meetings, "场"],
  ] as const;

  return (
    <main className="pm-page workbench-page">
      <header className="pm-page-head workbench-head">
        <div>
          <h1>工作台</h1>
          <p>项目状态、待办、风险和 AI 协作进展的统一视图。</p>
        </div>
        <div className="pm-head-actions">
          <select
            className="pm-compact-select"
            aria-label="工作台项目"
            value={selectedProjectId}
            onChange={(event) => onProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="pm-icon-btn"
            type="button"
            title="刷新工作台"
            onClick={() => {
              void summaryQuery.refetch();
              void tasksQuery.refetch();
              void memoryQuery.refetch();
            }}
          >
            <RefreshCw
              size={14}
              className={summaryQuery.isFetching ? "spin" : undefined}
            />
          </button>
        </div>
      </header>

      <div className="workbench-canvas">
        <WorkbenchCard
          module="metrics"
          title="核心指标"
          meta={`更新于 ${formatDateTime(new Date().toISOString())}`}
        >
          <div className="workbench-metric-grid">
            {metrics.map(([label, value, unit]) => (
              <div className="workbench-metric" key={label}>
                <span>{label}</span>
                <strong>
                  {value ?? "-"}
                  <small>{unit}</small>
                </strong>
              </div>
            ))}
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="brief"
          title="每日简报"
          meta={`${agents.filter((agent) => agent.status === "active").length} 位 AI 伙伴可用`}
        >
          <div className="workbench-brief">
            <div className="workbench-brief-mark">
              <BookOpen size={17} />
            </div>
            <div>
              <strong>
                {reviewTasks.length > 0
                  ? `${reviewTasks.length} 项任务等待验收`
                  : pendingTasks.length > 0
                    ? `${pendingTasks.length} 项任务正在推进`
                    : "当前项目运行平稳"}
              </strong>
              <p>
                工作台数据直接来自平台 API。任务派发、Agent 事件和输出会通过 Run
                事件流持续更新。
              </p>
            </div>
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="todo"
          title="我的待办"
          meta={`${pendingTasks.length} 项`}
        >
          <div className="workbench-list">
            {pendingTasks.slice(0, 5).map((task) => (
              <button
                className="workbench-item"
                type="button"
                key={task.id}
                onClick={() => onOpenTask(task.id, selectedProjectId)}
              >
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.description}</small>
                </span>
                <i
                  className={`pm-pill ${task.status === "queued" ? "neutral" : "progress"}`}
                >
                  {task.status === "queued" ? "待处理" : "进行中"}
                </i>
              </button>
            ))}
            {pendingTasks.length === 0 && (
              <div className="pm-empty compact">当前没有待办任务</div>
            )}
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="focus"
          title="重点关注"
          meta={`${reviewTasks.length} 项`}
        >
          <div className="workbench-list">
            {reviewTasks.slice(0, 4).map((task) => (
              <button
                className="workbench-focus-item"
                type="button"
                key={task.id}
                onClick={() => onOpenTask(task.id, selectedProjectId)}
              >
                <CircleAlert size={14} />
                <span>{task.title}</span>
                <ArrowRight size={13} />
              </button>
            ))}
            {reviewTasks.length === 0 && (
              <div className="preview-empty">暂无待验收事项</div>
            )}
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="meeting-minutes"
          title="会议纪要"
          meta={`${meetings.length} 场会议`}
        >
          <div className="workbench-list">
            {meetings.slice(0, 4).map((meeting) => (
              <div className="workbench-minutes" key={meeting.id}>
                <span>
                  <strong>{meeting.title}</strong>
                  <small>
                    {meeting.summary || meeting.agenda || "纪要待补充"}
                  </small>
                </span>
                <span
                  className={`pm-pill ${meeting.status === "open" ? "progress" : "done"}`}
                >
                  {meeting.status === "open" ? "进行中" : "已结束"}
                </span>
              </div>
            ))}
            {meetings.length === 0 && (
              <div className="pm-empty compact">当前项目暂无会议</div>
            )}
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="control"
          title="运行关注"
          meta={`${summary?.activeRuns ?? 0} 个`}
        >
          <div className="workbench-control">
            <ActivityMini
              label="执行中 Run"
              value={summary?.activeRuns ?? 0}
              tone="progress"
            />
            <ActivityMini
              label="待验收任务"
              value={summary?.reviewTasks ?? 0}
              tone={reviewTasks.length > 0 ? "warn" : "done"}
            />
            <ActivityMini
              label="运行中流程"
              value={summary?.workflows ?? 0}
              tone="neutral"
            />
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          module="supplier"
          title="项目记忆"
          meta={`${memory.length} 条`}
        >
          <div className="workbench-list">
            {memory.slice(0, 4).map((topic) => (
              <div className="workbench-memory" key={topic.id}>
                <span>
                  <strong>{topic.title}</strong>
                  <small>{topic.currentTruth?.content ?? "尚未发布结论"}</small>
                </span>
                <em>v{topic.currentTruth?.version ?? "-"}</em>
              </div>
            ))}
            {memory.length === 0 && (
              <div className="pm-empty compact">
                任务验收通过后会沉淀项目记忆
              </div>
            )}
          </div>
        </WorkbenchCard>
      </div>
    </main>
  );
}

function ActivityMini({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`activity-mini ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function WorkflowsView({
  projects,
  projectId,
  onProjectChange,
}: ProjectViewProps) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [roleId, setRoleId] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(
    null,
  );
  const [instanceId, setInstanceId] = useState("");
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
  const rolesQuery = useQuery({
    queryKey: ["project-roles", selectedProjectId],
    queryFn: () => listProjectRoles(selectedProjectId),
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
  const panelError =
    detailQuery.error ??
    completeMutation.error ??
    approvalMutation.error ??
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
            <span className="pm-pill">
              {instancesQuery.data?.length ?? 0} 个实例
            </span>
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
}: ProjectViewProps) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [meetingId, setMeetingId] = useState("");
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [agentId, setAgentId] = useState("");
  const [message, setMessage] = useState("");
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
    mutationFn: () => postMeetingMessage(meetingId, message),
    onSuccess: () => {
      setMessage("");
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
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
                  </article>
                ))}
                {detail.messages.length === 0 && (
                  <div className="pm-empty compact">会议尚未产生消息</div>
                )}
              </div>
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
            </>
          )}
        </section>
      </div>
    </main>
  );
}
