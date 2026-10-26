import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  LogOut,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  SquareTerminal,
  Sun,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentsView } from "./AgentsView.js";
import { OperationsDashboardView } from "./OperationsDashboardView.js";
import {
  MeetingsView,
  WorkbenchView,
  WorkflowsView,
} from "./OperationsViews.js";
import { ProjectsView, TasksView } from "./WorkspaceViews.js";
import { ProjectTemplatesView } from "./ProjectTemplatesView.js";
import { RuntimesView } from "./RuntimesView.js";
import {
  ApiRequestError,
  getViewerCapabilities,
  listAllAgents,
  listProjects,
  logout,
} from "./api.js";
import type { WorkbenchSourceRef } from "@pluginmax/contracts";
import { LoginView } from "./LoginView.js";

type AppView =
  | "workbench"
  | "projects"
  | "tasks"
  | "workflows"
  | "meetings"
  | "agents"
  | "runtimes"
  | "operations"
  | "project-templates";

type Theme = "dark" | "light";

const navItems = [
  { key: "workbench", label: "工作台", icon: LayoutDashboard },
  { key: "projects", label: "项目", icon: FolderKanban },
  { key: "tasks", label: "任务", icon: ListTodo },
  { key: "workflows", label: "工作流", icon: WorkflowIcon },
  { key: "meetings", label: "沟通", icon: MessagesSquare },
  { key: "agents", label: "AI伙伴", icon: Bot },
  { key: "runtimes", label: "运行时", icon: SquareTerminal },
  { key: "operations", label: "运维", icon: Activity },
] as const satisfies ReadonlyArray<{
  key: AppView;
  label: string;
  icon: typeof LayoutDashboard;
}>;

function initialTheme(): Theme {
  const saved = window.localStorage.getItem("pluginmax.theme");
  return saved === "light" ? "light" : "dark";
}

export function App() {
  const queryClient = useQueryClient();
  const [sessionVersion, setSessionVersion] = useState(0);
  const viewerQuery = useQuery({
    queryKey: ["viewer", sessionVersion],
    queryFn: getViewerCapabilities,
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", sessionVersion],
    queryFn: listProjects,
    enabled: viewerQuery.isSuccess,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", "all", sessionVersion],
    queryFn: listAllAgents,
    enabled: viewerQuery.isSuccess,
  });
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [workflowInstanceId, setWorkflowInstanceId] = useState("");
  const [projectReportId, setProjectReportId] = useState<string>();
  const [projectTab, setProjectTab] = useState<
    "overview" | "tasks" | "memory" | "members" | "reports"
  >("overview");
  const [view, setView] = useState<AppView>("workbench");
  const [returnView, setReturnView] = useState<AppView | null>(null);
  const [returnProjectId, setReturnProjectId] = useState("");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 760);
  const selectedProjectId = projectId || projectsQuery.data?.[0]?.id || "";
  const consumeInitialTask = useCallback(() => setTaskId(""), []);
  const consumeInitialMeeting = useCallback(() => setMeetingId(""), []);

  const handleLoggedIn = () => {
    setSessionVersion((current) => current + 1);
    void queryClient.invalidateQueries();
  };

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
    setSessionVersion((current) => current + 1);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("pluginmax.theme", theme);
  }, [theme]);

  useEffect(() => {
    const syncSidebar = () => {
      if (window.innerWidth < 760) setLeftOpen(false);
    };
    window.addEventListener("resize", syncSidebar);
    return () => window.removeEventListener("resize", syncSidebar);
  }, []);

  if (viewerQuery.isPending) {
    return (
      <main className="auth-screen auth-loading">
        <LoaderCircle className="auth-spinner" size={24} />
        <span>正在验证会话</span>
      </main>
    );
  }

  if (viewerQuery.isError) {
    if (
      viewerQuery.error instanceof ApiRequestError &&
      viewerQuery.error.status === 401
    ) {
      return <LoginView onLoggedIn={handleLoggedIn} />;
    }
    return (
      <main className="auth-screen auth-loading">
        <strong>无法验证当前会话</strong>
        <span>{viewerQuery.error.message}</span>
        <button type="button" onClick={() => void viewerQuery.refetch()}>
          重试
        </button>
      </main>
    );
  }

  const openTask = (nextTaskId: string, nextProjectId: string) => {
    if (view !== "tasks") {
      setReturnView(view);
      setReturnProjectId(selectedProjectId);
    }
    setProjectId(nextProjectId);
    setTaskId(nextTaskId);
    setView("tasks");
  };
  const openMeeting = (nextMeetingId: string, nextProjectId: string) => {
    if (view !== "meetings") {
      setReturnView(view);
      setReturnProjectId(selectedProjectId);
    }
    setProjectId(nextProjectId);
    setMeetingId(nextMeetingId);
    setView("meetings");
  };
  const openSource = (source: WorkbenchSourceRef, reportId?: string) => {
    if (!source.available) return;
    setProjectId(source.projectId);
    setTaskId("");
    setMeetingId("");
    setWorkflowInstanceId("");
    if (reportId !== undefined) {
      setProjectReportId(reportId);
    }
    if (
      source.route === "task" ||
      source.route === "run" ||
      source.route === "review"
    ) {
      setTaskId(source.targetId);
      if (view !== "tasks") {
        setReturnView(view);
        setReturnProjectId(selectedProjectId);
      }
      setView("tasks");
      return;
    }
    if (source.route === "workflow") {
      setWorkflowInstanceId(source.targetId);
      if (view !== "workflows") {
        setReturnView(view);
        setReturnProjectId(selectedProjectId);
      }
      setView("workflows");
      return;
    }
    if (source.route === "meeting") {
      setMeetingId(source.targetId);
      if (view !== "meetings") {
        setReturnView(view);
        setReturnProjectId(selectedProjectId);
      }
      setView("meetings");
      return;
    }
    if (source.route === "report") {
      setProjectReportId(source.targetId);
      setProjectTab("reports");
      setReturnView(null);
      setView("projects");
      return;
    }
    if (source.route === "memory") {
      setProjectReportId(undefined);
      setProjectTab("memory");
      setReturnView(null);
      setView("projects");
    }
  };

  return (
    <div
      className="app-shell"
      data-theme={theme}
      data-left-closed={leftOpen ? undefined : ""}
    >
      <aside className="app-sidebar">
        <header className="sidebar-head">
          <button
            className="brand"
            type="button"
            title="返回工作台"
            onClick={() => setView("workbench")}
          >
            <span className="brand-mark">P</span>
            <span className="brand-copy">
              <strong>Pluginmax</strong>
              <small>协作工作台</small>
            </span>
          </button>
          <button
            className="sidebar-collapse"
            type="button"
            title={leftOpen ? "收起导航" : "展开导航"}
            onClick={() => setLeftOpen((current) => !current)}
          >
            {leftOpen ? (
              <PanelLeftClose size={15} />
            ) : (
              <PanelLeftOpen size={15} />
            )}
          </button>
        </header>

        <nav className="primary-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.key ? "active" : undefined}
                type="button"
                key={item.key}
                title={item.label}
                onClick={() => {
                  setView(item.key);
                  setReturnView(null);
                }}
              >
                <Icon size={15} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <section className="sidebar-workspaces">
          <div className="sidebar-section-title">
            <span>项目</span>
            <b>{projectsQuery.data?.length ?? 0}</b>
          </div>
          <div className="sidebar-project-list">
            {projectsQuery.data?.slice(0, 8).map((project) => (
              <button
                className={
                  view === "projects" && project.id === selectedProjectId
                    ? "active"
                    : undefined
                }
                type="button"
                key={project.id}
                title={project.name}
                onClick={() => {
                  setProjectId(project.id);
                  setTaskId("");
                  setProjectReportId(undefined);
                  setProjectTab("overview");
                  setView("projects");
                }}
              >
                <span className="sidebar-project-mark">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.code}</small>
                </span>
              </button>
            ))}
            {projectsQuery.data?.length === 0 && (
              <div className="sidebar-empty">尚无项目</div>
            )}
          </div>
          <button
            className="sidebar-all-projects"
            type="button"
            onClick={() => setView("projects")}
          >
            查看全部项目
          </button>
        </section>

        <footer className="sidebar-foot">
          <button
            className="account-row"
            type="button"
            title={
              viewerQuery.data.authSource === "local-development"
                ? "本地开发会话"
                : "退出登录"
            }
            onClick={
              viewerQuery.data.authSource === "local-development"
                ? undefined
                : () => void handleLogout()
            }
          >
            <span className="account-avatar">
              {(viewerQuery.data.displayName ?? viewerQuery.data.actorId)
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span className="account-copy">
              <strong>
                {viewerQuery.data.displayName ?? viewerQuery.data.actorId}
              </strong>
              <small>
                {viewerQuery.data.platformAdministrator
                  ? "平台管理员"
                  : "平台成员"}
              </small>
            </span>
            {viewerQuery.data.authSource === "local-development" ? null : (
              <LogOut size={14} />
            )}
          </button>
          <button
            className="theme-toggle"
            type="button"
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            onClick={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
          >
            {theme === "dark" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </footer>
      </aside>

      <div className="app-stage">
        {returnView !== null && (
          <button
            className="return-context-bar"
            type="button"
            onClick={() => {
              setProjectId(returnProjectId);
              setView(returnView);
              setReturnView(null);
            }}
          >
            返回{returnView === "workbench" ? "工作台" : "项目"}
          </button>
        )}
        {view === "workbench" && (
          <WorkbenchView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
            }}
            onOpenSource={openSource}
          />
        )}
        {view === "projects" && (
          <ProjectsView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
              setMeetingId("");
            }}
            onOpenTask={openTask}
            onOpenMeeting={openMeeting}
            onOpenSource={openSource}
            canManageTemplates={
              viewerQuery.data?.canManageProjectTemplates ?? false
            }
            onOpenTemplates={() => setView("project-templates")}
            {...(projectReportId === undefined
              ? {}
              : { initialReportId: projectReportId })}
            initialTab={projectTab}
          />
        )}
        {view === "project-templates" && (
          <ProjectTemplatesView onBack={() => setView("projects")} />
        )}
        {view === "tasks" && (
          <TasksView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
              setWorkflowInstanceId("");
            }}
            initialTaskId={taskId}
            onInitialTaskConsumed={consumeInitialTask}
          />
        )}
        {view === "workflows" && (
          <WorkflowsView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
            }}
            {...(workflowInstanceId === ""
              ? {}
              : { initialInstanceId: workflowInstanceId })}
          />
        )}
        {view === "meetings" && (
          <MeetingsView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
              setMeetingId("");
            }}
            initialMeetingId={meetingId}
            onInitialMeetingConsumed={consumeInitialMeeting}
            onOpenTask={openTask}
          />
        )}
        {view === "agents" && <AgentsView />}
        {view === "runtimes" && <RuntimesView />}
        {view === "operations" && <OperationsDashboardView />}
      </div>
    </div>
  );
}
