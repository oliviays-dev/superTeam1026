import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentsView } from "./AgentsView.js";
import {
  MeetingsView,
  WorkbenchView,
  WorkflowsView,
} from "./OperationsViews.js";
import { ProjectsView, TasksView } from "./WorkspaceViews.js";
import { listAllAgents, listProjects } from "./api.js";

type AppView =
  "workbench" | "projects" | "tasks" | "workflows" | "meetings" | "agents";

type Theme = "dark" | "light";

const navItems = [
  { key: "workbench", label: "工作台", icon: LayoutDashboard },
  { key: "projects", label: "项目", icon: FolderKanban },
  { key: "tasks", label: "任务", icon: ListTodo },
  { key: "workflows", label: "工作流", icon: WorkflowIcon },
  { key: "meetings", label: "沟通", icon: MessagesSquare },
  { key: "agents", label: "AI伙伴", icon: Bot },
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
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", "all"],
    queryFn: listAllAgents,
  });
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [view, setView] = useState<AppView>("workbench");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 760);
  const selectedProjectId = projectId || projectsQuery.data?.[0]?.id || "";
  const consumeInitialTask = useCallback(() => setTaskId(""), []);

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

  const openTask = (nextTaskId: string, nextProjectId: string) => {
    setProjectId(nextProjectId);
    setTaskId(nextTaskId);
    setView("tasks");
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
                onClick={() => setView(item.key)}
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
          <button className="account-row" type="button" title="本地工作区账号">
            <span className="account-avatar">LA</span>
            <span className="account-copy">
              <strong>Local Admin</strong>
              <small>本地工作区</small>
            </span>
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
        {view === "workbench" && (
          <WorkbenchView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
            }}
            onOpenTask={openTask}
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
            }}
            onOpenTask={openTask}
          />
        )}
        {view === "tasks" && (
          <TasksView
            projects={projectsQuery.data ?? []}
            agents={agentsQuery.data ?? []}
            projectId={selectedProjectId}
            onProjectChange={(nextProjectId) => {
              setProjectId(nextProjectId);
              setTaskId("");
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
            }}
          />
        )}
        {view === "agents" && <AgentsView />}
      </div>
    </div>
  );
}
