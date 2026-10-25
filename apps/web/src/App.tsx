import type {
  Agent,
  Artifact,
  PlatformRunEvent,
  Project,
  Task,
} from "@pluginmax/contracts";
import { formatDateTime, shortId } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  CircleStop,
  Download,
  FileText,
  FolderKanban,
  LayoutDashboard,
  LoaderCircle,
  MessagesSquare,
  Play,
  Plus,
  RefreshCw,
  Undo2,
  Workflow as WorkflowIcon,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  cancelRun,
  artifactDownloadUrl,
  createProject,
  createTask,
  dispatchTask,
  getRunDetail,
  getRunContext,
  getRunEvents,
  listAgents,
  listArtifacts,
  listProjects,
  listTaskRuns,
  listTasks,
  reviewTask,
  subscribeToRun,
} from "./api.js";
import {
  MeetingsView,
  WorkbenchView,
  WorkflowsView,
} from "./OperationsViews.js";

type AppView = "projects" | "workbench" | "workflows" | "meetings";

const statusText: Record<string, string> = {
  queued: "排队中",
  in_progress: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
  running: "执行中",
  waiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  interrupted: "已中断",
};

const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
]);

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status}`}>
      {statusText[status] ?? status}
    </span>
  );
}

function ProjectForm({ onCreated }: { onCreated: (project: Project) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      createProject({
        name,
        description: "",
      }),
    onSuccess: (project) => {
      setName("");
      onCreated(project);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") mutation.mutate();
      }}
    >
      <input
        aria-label="项目名称"
        placeholder="新建项目"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        className="icon-button"
        type="submit"
        title="新建项目"
        disabled={mutation.isPending || name.trim() === ""}
      >
        {mutation.isPending ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Plus size={16} />
        )}
      </button>
    </form>
  );
}

function TaskForm({
  projectId,
  agents,
  onCreated,
}: {
  projectId: string;
  agents: Agent[];
  onCreated: (task: Task) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState("");
  const selectedAgentId = agentId || agents[0]?.id || "";
  const mutation = useMutation({
    mutationFn: () =>
      createTask({
        projectId,
        title,
        description,
        acceptance: [],
        ...(selectedAgentId === "" ? {} : { agentId: selectedAgentId }),
      }),
    onSuccess: (task) => {
      setTitle("");
      setDescription("");
      onCreated(task);
      void queryClient.invalidateQueries({ queryKey: ["tasks", projectId] });
    },
  });

  return (
    <form
      className="task-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() !== "" && description.trim() !== "") {
          mutation.mutate();
        }
      }}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">Task</span>
          <h2>新建任务</h2>
        </div>
        <button
          className="primary-button"
          type="submit"
          disabled={
            mutation.isPending ||
            title.trim() === "" ||
            description.trim() === ""
          }
        >
          {mutation.isPending ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Plus size={16} />
          )}
          创建
        </button>
      </div>
      <label>
        任务标题
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：分析关键物料延迟影响"
        />
      </label>
      <label>
        任务说明
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="描述目标、范围和期望交付"
          rows={4}
        />
      </label>
      <label>
        执行 AI 伙伴
        <select
          value={selectedAgentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} · {agent.runtimeKind}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}

function RunView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<PlatformRunEvent[]>([]);
  const [liveOutput, setLiveOutput] = useState("");
  const [streamState, setStreamState] = useState<
    "connecting" | "live" | "closed"
  >("connecting");
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRunDetail(runId),
  });
  const contextQuery = useQuery({
    queryKey: ["run-context", runId],
    queryFn: () => getRunContext(runId),
    retry: false,
  });
  const artifactsQuery = useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => listArtifacts(runId),
    enabled: runQuery.data?.run.status === "completed",
  });
  const run = runQuery.data?.run;

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    setEvents([]);
    setLiveOutput("");
    setStreamState("connecting");

    void getRunEvents(runId).then((page) => {
      if (disposed) return;
      const lastEvent = page.items.at(-1)?.seq ?? 0;
      const lastDelta = page.deltas.at(-1)?.seq ?? 0;
      setEvents(page.items);
      setLiveOutput(page.deltas.map((delta) => delta.text).join(""));
      source = subscribeToRun(runId, lastEvent, lastDelta);
      setStreamState("live");

      source.addEventListener("run.event", (message) => {
        const event = JSON.parse(
          (message as MessageEvent<string>).data,
        ) as PlatformRunEvent;
        setEvents((current) =>
          current.some((item) => item.id === event.id)
            ? current
            : [...current, event],
        );
        if (terminal.has(event.type.replace("run.", ""))) {
          void queryClient.invalidateQueries({ queryKey: ["run", runId] });
          void queryClient.invalidateQueries({
            queryKey: ["run-artifacts", runId],
          });
          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
          void queryClient.invalidateQueries({ queryKey: ["task-runs"] });
        }
      });
      source.addEventListener("run.delta", (message) => {
        const delta = JSON.parse((message as MessageEvent<string>).data) as {
          text: string;
        };
        setLiveOutput((current) => current + delta.text);
      });
      source.addEventListener("error", () => {
        if (!disposed) setStreamState("connecting");
      });
    });

    return () => {
      disposed = true;
      source?.close();
      setStreamState("closed");
    };
  }, [queryClient, runId]);

  const plan = useMemo(
    () =>
      events.filter((event) => event.type === "plan.snapshot").at(-1)?.data
        ?.steps as string[] | undefined,
    [events],
  );
  const artifacts: Artifact[] = artifactsQuery.data ?? [];

  if (run === undefined) {
    return (
      <div className="empty-state">
        {runQuery.isError ? (
          <RefreshCw size={22} />
        ) : (
          <LoaderCircle className="spin" size={22} />
        )}
        <span>{runQuery.isError ? "无法加载 Run" : "加载 Run..."}</span>
      </div>
    );
  }

  return (
    <div className="run-view">
      <header className="run-header">
        <div>
          <div className="run-kicker">
            RUN {shortId(run.id)}
            <StatusBadge status={run.status} />
            <span className={`live-dot live-${streamState}`} />
          </div>
          <h2>{run.inputSnapshot.taskTitle}</h2>
        </div>
        {!terminal.has(run.status) && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void cancelRun(run.id)}
          >
            <CircleStop size={15} />
            取消
          </button>
        )}
      </header>

      <section className="run-section">
        <div className="section-title">
          <Bot size={16} />
          <h3>输入</h3>
        </div>
        <div className="input-grid">
          <div>
            <span>AI 伙伴</span>
            <strong>{run.inputSnapshot.agentName}</strong>
          </div>
          <div>
            <span>Runtime</span>
            <strong>{run.inputSnapshot.runtimeKind}</strong>
          </div>
          <div>
            <span>创建时间</span>
            <strong>{formatDateTime(run.createdAt)}</strong>
          </div>
        </div>
        <p className="run-description">{run.inputSnapshot.taskDescription}</p>
        {contextQuery.data !== undefined && (
          <div className="context-sources">
            <span>上下文来源</span>
            <div>
              {contextQuery.data.pack.sources.map((source) => (
                <span
                  className="context-chip"
                  key={`${source.type}-${source.id}`}
                >
                  {source.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="run-section">
        <div className="section-title">
          <Activity size={16} />
          <h3>执行进展</h3>
        </div>
        {plan !== undefined && plan.length > 0 && (
          <ol className="plan-list">
            {plan.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <div className="event-timeline">
          {events
            .filter(
              (event) =>
                event.type !== "run.queued" && event.type !== "plan.snapshot",
            )
            .map((event) => (
              <div className="timeline-row" key={event.id}>
                <span className={`event-icon event-${event.type}`}>
                  {event.type.startsWith("tool.") ? (
                    <Wrench size={13} />
                  ) : event.type === "run.completed" ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <Activity size={13} />
                  )}
                </span>
                <div>
                  <div className="timeline-meta">
                    <span>{event.type}</span>
                    <time>{formatDateTime(event.createdAt)}</time>
                  </div>
                  <p>{event.summary}</p>
                </div>
              </div>
            ))}
          {events.length === 0 && (
            <div className="muted-row">等待 Agent 事件...</div>
          )}
        </div>
      </section>

      <section className="run-section output-section">
        <div className="section-title">
          <FileText size={16} />
          <h3>输出</h3>
        </div>
        <pre className="output-block">
          {run.output ?? liveOutput ?? ""}
          {!run.output && !terminal.has(run.status) && (
            <span className="stream-caret" />
          )}
        </pre>
        {artifacts.length > 0 ? (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <a
                href={artifactDownloadUrl(artifact.id)}
                key={artifact.id}
                download
              >
                <FileText size={14} />
                <span>{artifact.name}</span>
                <Download size={13} />
              </a>
            ))}
          </div>
        ) : (
          events.some((event) => event.type === "artifact.created") && (
            <button
              className="text-button"
              onClick={() => void artifactsQuery.refetch()}
            >
              <RefreshCw size={13} />
              加载交付物
            </button>
          )
        )}
      </section>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });
  const agentsQuery = useQuery({ queryKey: ["agents"], queryFn: listAgents });
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [runId, setRunId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [view, setView] = useState<AppView>("projects");
  const selectedProjectId = projectId || projectsQuery.data?.[0]?.id || "";
  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => listTasks(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const taskRunsQuery = useQuery({
    queryKey: ["task-runs", taskId],
    queryFn: () => listTaskRuns(taskId),
    enabled: taskId !== "",
  });
  const selectedTask = tasksQuery.data?.find((task) => task.id === taskId);
  const dispatchMutation = useMutation({
    mutationFn: () => dispatchTask(taskId),
    onSuccess: ({ runId: createdRunId }) => {
      setRunId(createdRunId);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["task-runs", taskId] });
    },
  });
  const reviewMutation = useMutation({
    mutationFn: (decision: "approve" | "return") =>
      reviewTask(taskId, decision, reviewNote),
    onSuccess: () => {
      setReviewNote("");
      setRunId("");
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
      void queryClient.invalidateQueries({ queryKey: ["workbench-summary"] });
    },
  });

  useEffect(() => {
    if (selectedProjectId !== "" && projectId === "") {
      setProjectId(selectedProjectId);
    }
  }, [projectId, selectedProjectId]);

  useEffect(() => {
    if (taskId === "" && tasksQuery.data?.[0] !== undefined) {
      setTaskId(tasksQuery.data[0].id);
    }
  }, [taskId, tasksQuery.data]);

  useEffect(() => {
    const latestRun = taskRunsQuery.data?.[0];
    if (taskId !== "" && latestRun !== undefined && runId === "") {
      setRunId(latestRun.id);
    }
  }, [runId, taskId, taskRunsQuery.data]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <div>
            <strong>Pluginmax</strong>
            <span>Platform V1</span>
          </div>
        </div>
        <nav className="topnav" aria-label="主导航">
          <button
            className={view === "workbench" ? "active" : undefined}
            onClick={() => setView("workbench")}
          >
            <LayoutDashboard size={15} />
            工作台
          </button>
          <button
            className={view === "projects" ? "active" : undefined}
            onClick={() => setView("projects")}
          >
            <FolderKanban size={15} />
            项目
          </button>
          <button
            className={view === "workflows" ? "active" : undefined}
            onClick={() => setView("workflows")}
          >
            <WorkflowIcon size={15} />
            工作流
          </button>
          <button
            className={view === "meetings" ? "active" : undefined}
            onClick={() => setView("meetings")}
          >
            <MessagesSquare size={15} />
            会议
          </button>
        </nav>
        <div className="topbar-status">
          <span className="pulse-dot" />
          Local workspace
        </div>
      </header>

      {view === "projects" ? (
        <main className="workspace-grid">
          <aside className="project-rail">
            <div className="rail-heading">
              <span className="eyebrow">Workspace</span>
              <h1>项目</h1>
            </div>
            <ProjectForm
              onCreated={(project) => {
                setProjectId(project.id);
                setTaskId("");
                setRunId("");
              }}
            />
            <div className="project-list">
              {projectsQuery.data?.map((project) => (
                <button
                  key={project.id}
                  className={`project-row ${
                    project.id === selectedProjectId ? "active" : ""
                  }`}
                  onClick={() => {
                    setProjectId(project.id);
                    setTaskId("");
                    setRunId("");
                  }}
                >
                  <span>{project.name}</span>
                  <small>{project.code}</small>
                </button>
              ))}
              {projectsQuery.data?.length === 0 && (
                <div className="rail-empty">创建第一个项目</div>
              )}
            </div>
          </aside>

          <section className="task-column">
            {selectedProjectId === "" ? (
              <div className="empty-state">选择或创建项目</div>
            ) : (
              <>
                <div className="task-column-head">
                  <div>
                    <span className="eyebrow">Project</span>
                    <h2>
                      {
                        projectsQuery.data?.find(
                          (project) => project.id === selectedProjectId,
                        )?.name
                      }
                    </h2>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    title="刷新任务"
                    onClick={() => void tasksQuery.refetch()}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                <TaskForm
                  projectId={selectedProjectId}
                  agents={agentsQuery.data ?? []}
                  onCreated={(task) => {
                    setTaskId(task.id);
                    setRunId("");
                  }}
                />
                <div className="task-list">
                  {tasksQuery.data?.map((task) => (
                    <button
                      className={`task-card ${
                        task.id === taskId ? "active" : ""
                      }`}
                      key={task.id}
                      onClick={() => {
                        setTaskId(task.id);
                        setRunId("");
                      }}
                    >
                      <div className="task-card-top">
                        <span>{task.title}</span>
                        <StatusBadge status={task.status} />
                      </div>
                      <p>{task.description}</p>
                      <div className="task-card-foot">
                        <span>{formatDateTime(task.updatedAt)}</span>
                        <span>{task.acceptance.length} 项验收</span>
                      </div>
                    </button>
                  ))}
                  {tasksQuery.data?.length === 0 && (
                    <div className="empty-state compact">
                      当前项目还没有任务
                    </div>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="run-column">
            {selectedTask !== undefined && (
              <div className="task-actionbar">
                <div>
                  <span className="eyebrow">Selected task</span>
                  <strong>{selectedTask.title}</strong>
                </div>
                {selectedTask.status === "review" ? (
                  <div className="review-actions">
                    <input
                      value={reviewNote}
                      onChange={(event) => setReviewNote(event.target.value)}
                      placeholder="验收意见或退回原因"
                    />
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() => reviewMutation.mutate("return")}
                    >
                      <Undo2 size={15} />
                      退回
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={reviewMutation.isPending}
                      onClick={() => reviewMutation.mutate("approve")}
                    >
                      <Check size={15} />
                      验收通过
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      dispatchMutation.isPending ||
                      taskId === "" ||
                      selectedTask.status !== "queued"
                    }
                    onClick={() => dispatchMutation.mutate()}
                  >
                    {dispatchMutation.isPending ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                    派发执行
                  </button>
                )}
              </div>
            )}
            {runId !== "" ? (
              <RunView runId={runId} />
            ) : (
              <div className="empty-state run-empty">
                <Activity size={28} />
                <strong>还没有运行记录</strong>
                <span>选择任务并派发后，这里会显示输入、进展和输出。</span>
              </div>
            )}
          </section>
        </main>
      ) : view === "workbench" ? (
        <WorkbenchView
          projects={projectsQuery.data ?? []}
          agents={agentsQuery.data ?? []}
          projectId={selectedProjectId}
          onProjectChange={(nextProjectId) => {
            setProjectId(nextProjectId);
            setTaskId("");
            setRunId("");
          }}
        />
      ) : view === "workflows" ? (
        <WorkflowsView
          projects={projectsQuery.data ?? []}
          agents={agentsQuery.data ?? []}
          projectId={selectedProjectId}
          onProjectChange={(nextProjectId) => {
            setProjectId(nextProjectId);
            setTaskId("");
            setRunId("");
          }}
        />
      ) : (
        <MeetingsView
          projects={projectsQuery.data ?? []}
          agents={agentsQuery.data ?? []}
          projectId={selectedProjectId}
          onProjectChange={(nextProjectId) => {
            setProjectId(nextProjectId);
            setTaskId("");
            setRunId("");
          }}
        />
      )}
    </div>
  );
}
