import type {
  Agent,
  MemoryClaim,
  MemoryTopic,
  Project,
  ProjectRole,
  Task,
  TaskMessage,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  CircleX,
  Edit3,
  FileText,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  Network,
  Plus,
  Search,
  Send,
  Undo2,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  addMemoryClaim,
  createProject,
  createMemoryTopic,
  createTask,
  dispatchTask,
  getTaskDetail,
  listMemory,
  listProjectRoles,
  listTaskRuns,
  listTasks,
  postTaskMessage,
  publishMemoryTruth,
  reviewTask,
  updateProject,
  updateTask,
  updateMemoryClaim,
} from "./api.js";
import { ProjectMembershipPanel } from "./ProjectMembershipPanel.js";
import { RunView } from "./RunView.js";

interface SharedViewProps {
  projects: Project[];
  agents: Agent[];
  projectId: string;
  onProjectChange: (projectId: string) => void;
}

const taskStatusLabel: Record<Task["status"], string> = {
  queued: "待处理",
  in_progress: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
};

const statusTone: Record<Task["status"], string> = {
  queued: "neutral",
  in_progress: "progress",
  review: "review",
  done: "done",
  cancelled: "warn",
};

function ProjectCreateForm({
  onCreated,
}: {
  onCreated: (project: Project) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const mutation = useMutation({
    mutationFn: () => createProject({ name, description }),
    onSuccess: (project) => {
      setName("");
      setDescription("");
      setOpen(false);
      onCreated(project);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  if (!open) {
    return (
      <button
        className="pm-btn primary"
        type="button"
        onClick={() => setOpen(true)}
      >
        <Plus size={14} />
        新建项目
      </button>
    );
  }

  return (
    <form
      className="inline-create-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") mutation.mutate();
      }}
    >
      <div className="inline-create-head">
        <strong>新建项目</strong>
        <button
          className="pm-icon-btn"
          type="button"
          title="关闭"
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </div>
      <input
        autoFocus
        placeholder="项目名称"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <textarea
        rows={2}
        placeholder="项目说明"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <button
        className="pm-btn primary"
        type="submit"
        disabled={mutation.isPending || name.trim() === ""}
      >
        {mutation.isPending ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <Plus size={14} />
        )}
        创建项目
      </button>
    </form>
  );
}

function ProjectEditDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [code, setCode] = useState(project.code);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState<Project["status"]>(project.status);
  const mutation = useMutation({
    mutationFn: () =>
      updateProject(project.id, {
        name,
        code,
        description,
        status,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <div className="pm-modal-layer" role="presentation">
      <form
        className="pm-modal project-edit-modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "" && code.trim() !== "") mutation.mutate();
        }}
      >
        <div className="pm-modal-head">
          <div>
            <h2>项目设置</h2>
            <p>维护项目名称、编码、说明和生命周期状态。</p>
          </div>
          <button
            className="pm-icon-btn"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="pm-form-grid">
          <label className="pm-field">
            <span>项目名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="pm-field">
            <span>项目编码</span>
            <input
              value={code}
              onChange={(event) =>
                setCode(event.target.value.toUpperCase().replace(/\s+/g, "-"))
              }
            />
          </label>
          <label className="pm-field pm-field-wide">
            <span>项目说明</span>
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="项目目标、边界和当前重点"
            />
          </label>
          <label className="pm-field">
            <span>状态</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as Project["status"])
              }
            >
              <option value="active">进行中</option>
              <option value="archived">已归档</option>
            </select>
          </label>
        </div>
        {mutation.error !== null && (
          <div className="pm-error">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "保存项目失败"}
          </div>
        )}
        <div className="pm-modal-actions">
          <button className="pm-btn secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="pm-btn primary"
            type="submit"
            disabled={
              mutation.isPending || name.trim() === "" || code.trim() === ""
            }
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            保存设置
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProjectsView({
  projects,
  agents,
  projectId,
  onProjectChange,
  onOpenTask,
}: SharedViewProps & {
  onOpenTask: (taskId: string, projectId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"tasks" | "memory" | "members" | "overview">(
    "overview",
  );
  const [editOpen, setEditOpen] = useState(false);
  const selectedProjectId = projectId || projects[0]?.id || "";
  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => listTasks(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const memoryQuery = useQuery({
    queryKey: ["memory", selectedProjectId],
    queryFn: () => listMemory(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const project = projects.find((item) => item.id === selectedProjectId);
  const tasks = tasksQuery.data ?? [];
  const memory = memoryQuery.data ?? [];
  const filteredProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (query === "") return projects;
    return projects.filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(query) ||
        item.code.toLocaleLowerCase().includes(query),
    );
  }, [projects, search]);

  return (
    <main className="pm-page">
      <header className="pm-page-head">
        <div>
          <h1>项目</h1>
          <p>按项目组织任务、AI 伙伴和可复用记忆。</p>
        </div>
        <ProjectCreateForm
          onCreated={(created) => onProjectChange(created.id)}
        />
      </header>

      <div className="pm-two-column project-layout">
        <aside className="project-directory">
          <label className="pm-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索项目"
            />
          </label>
          <div className="pm-directory-label">
            <span>项目目录</span>
            <b>{projects.length}</b>
          </div>
          <div className="pm-directory-list">
            {filteredProjects.map((item) => (
              <button
                className={`pm-directory-row ${
                  item.id === selectedProjectId ? "active" : ""
                }`}
                type="button"
                key={item.id}
                onClick={() => onProjectChange(item.id)}
              >
                <span className="pm-directory-mark">
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="pm-directory-copy">
                  <strong>{item.name}</strong>
                  <small>{item.code}</small>
                </span>
                <span className={`pm-pill ${item.status}`}>
                  {item.status === "active" ? "进行中" : "已归档"}
                </span>
              </button>
            ))}
            {filteredProjects.length === 0 && (
              <div className="pm-empty compact">没有匹配的项目</div>
            )}
          </div>
        </aside>

        <section className="project-detail">
          {project === undefined ? (
            <div className="pm-panel pm-empty">创建或选择第一个项目</div>
          ) : (
            <>
              <div className="project-detail-head">
                <div>
                  <div className="project-title-line">
                    <span className="pm-directory-mark large">
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <h2>{project.name}</h2>
                    <span className="pm-pill progress">进行中</span>
                  </div>
                  <div className="project-meta">
                    <code>{project.code}</code>
                    <span>更新于 {formatDateTime(project.updatedAt)}</span>
                  </div>
                  <p className="project-description">
                    {project.description || "尚未填写项目说明。"}
                  </p>
                </div>
                <div className="pm-head-actions">
                  <button
                    className="pm-btn secondary"
                    type="button"
                    onClick={() => setEditOpen(true)}
                  >
                    <Edit3 size={14} />
                    项目设置
                  </button>
                  <button
                    className="pm-btn secondary"
                    type="button"
                    onClick={() => setTab("tasks")}
                  >
                    <ListTodo size={14} />
                    查看任务
                  </button>
                </div>
              </div>

              <div className="project-facts">
                <div>
                  <span>任务总数</span>
                  <strong>{tasks.length}</strong>
                  <small>
                    {
                      tasks.filter((task) => task.status === "in_progress")
                        .length
                    }{" "}
                    项进行中
                  </small>
                </div>
                <div>
                  <span>待验收</span>
                  <strong>
                    {tasks.filter((task) => task.status === "review").length}
                  </strong>
                  <small>Run 完成后进入人工验收</small>
                </div>
                <div>
                  <span>项目记忆</span>
                  <strong>{memory.length}</strong>
                  <small>验收通过后自动沉淀</small>
                </div>
              </div>

              <div className="pm-tabs">
                <button
                  className={tab === "overview" ? "active" : ""}
                  type="button"
                  onClick={() => setTab("overview")}
                >
                  概览
                </button>
                <button
                  className={tab === "tasks" ? "active" : ""}
                  type="button"
                  onClick={() => setTab("tasks")}
                >
                  任务 <span>{tasks.length}</span>
                </button>
                <button
                  className={tab === "memory" ? "active" : ""}
                  type="button"
                  onClick={() => setTab("memory")}
                >
                  项目记忆 <span>{memory.length}</span>
                </button>
                <button
                  className={tab === "members" ? "active" : ""}
                  type="button"
                  onClick={() => setTab("members")}
                >
                  <UsersRound size={13} />
                  成员与角色
                </button>
              </div>

              {tab === "overview" && (
                <div className="project-overview-grid">
                  <section className="pm-panel">
                    <div className="pm-section-head">
                      <h3>项目状态</h3>
                      <Activity size={14} />
                    </div>
                    <dl className="pm-facts-list">
                      <div>
                        <dt>项目编码</dt>
                        <dd>{project.code}</dd>
                      </div>
                      <div>
                        <dt>可用 AI 伙伴</dt>
                        <dd>
                          {
                            agents.filter((agent) => agent.status === "active")
                              .length
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>运行状态</dt>
                        <dd>{project.status === "active" ? "正常" : "归档"}</dd>
                      </div>
                    </dl>
                  </section>
                  <section className="pm-panel">
                    <div className="pm-section-head">
                      <h3>最近任务</h3>
                      <span>{tasks.length}</span>
                    </div>
                    <div className="project-task-preview">
                      {tasks.slice(0, 4).map((task) => (
                        <button
                          type="button"
                          key={task.id}
                          onClick={() => onOpenTask(task.id, project.id)}
                        >
                          <span>{task.title}</span>
                          <small>{taskStatusLabel[task.status]}</small>
                          <ArrowRight size={13} />
                        </button>
                      ))}
                      {tasks.length === 0 && (
                        <div className="pm-empty compact">暂无任务</div>
                      )}
                    </div>
                  </section>
                </div>
              )}

              {tab === "tasks" && (
                <ProjectTaskList
                  tasks={tasks}
                  onOpenTask={(taskId) => onOpenTask(taskId, project.id)}
                />
              )}
              {tab === "memory" && (
                <ProjectMemoryPanel projectId={project.id} memory={memory} />
              )}
              {tab === "members" && (
                <ProjectMembershipPanel
                  projectId={project.id}
                  agents={agents}
                />
              )}
            </>
          )}
        </section>
      </div>
      {editOpen && project !== undefined && (
        <ProjectEditDialog
          project={project}
          onClose={() => setEditOpen(false)}
        />
      )}
    </main>
  );
}

function ProjectTaskList({
  tasks,
  onOpenTask,
}: {
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <div className="pm-table">
      <div className="pm-table-head">
        <span>任务</span>
        <span>状态</span>
        <span>验收标准</span>
        <span>更新时间</span>
      </div>
      {tasks.map((task) => (
        <button
          className="pm-table-row"
          type="button"
          key={task.id}
          onClick={() => onOpenTask(task.id)}
        >
          <span>
            <strong>{task.title}</strong>
            <small>{task.description}</small>
          </span>
          <span>
            <i className={`pm-pill ${statusTone[task.status]}`}>
              {taskStatusLabel[task.status]}
            </i>
          </span>
          <span>{task.acceptance.length} 项</span>
          <span>{formatDateTime(task.updatedAt)}</span>
        </button>
      ))}
      {tasks.length === 0 && <div className="pm-empty">当前项目还没有任务</div>}
    </div>
  );
}

function ProjectMemoryPanel({
  projectId,
  memory,
}: {
  projectId: string;
  memory: MemoryTopic[];
}) {
  const queryClient = useQueryClient();
  const [topicTitle, setTopicTitle] = useState("");
  const [claimDrafts, setClaimDrafts] = useState<Record<string, string>>({});
  const [selectedClaims, setSelectedClaims] = useState<
    Record<string, string[]>
  >({});
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["memory", projectId] });
  const createTopicMutation = useMutation({
    mutationFn: () => createMemoryTopic(projectId, { title: topicTitle }),
    onSuccess: () => {
      setTopicTitle("");
      void invalidate();
    },
  });
  const createClaimMutation = useMutation({
    mutationFn: (topicId: string) =>
      addMemoryClaim(projectId, topicId, {
        content: claimDrafts[topicId] ?? "",
        sourceType: "manual",
        sourceId: "local-admin",
      }),
    onSuccess: (_claim, topicId) => {
      setClaimDrafts((current) => ({ ...current, [topicId]: "" }));
      void invalidate();
    },
  });
  const updateClaimMutation = useMutation({
    mutationFn: (input: {
      topicId: string;
      claim: MemoryClaim;
      status: MemoryClaim["status"];
    }) =>
      updateMemoryClaim(projectId, input.topicId, input.claim.id, {
        status: input.status,
      }),
    onSuccess: () => void invalidate(),
  });
  const publishMutation = useMutation({
    mutationFn: (topicId: string) =>
      publishMemoryTruth(projectId, topicId, {
        claimIds: selectedClaims[topicId] ?? [],
        sourceType: "manual",
        sourceId: "local-admin",
      }),
    onSuccess: (_topic, topicId) => {
      setSelectedClaims((current) => ({ ...current, [topicId]: [] }));
      void invalidate();
    },
  });

  return (
    <div className="project-memory-panel">
      <form
        className="memory-topic-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (topicTitle.trim() !== "") createTopicMutation.mutate();
        }}
      >
        <div>
          <strong>项目记忆</strong>
          <small>
            Topic 汇总讨论，Claim 记录事实，Current Truth 固化当前结论。
          </small>
        </div>
        <input
          value={topicTitle}
          onChange={(event) => setTopicTitle(event.target.value)}
          placeholder="新增主题，例如：供应商交付风险"
        />
        <button
          className="pm-btn primary"
          type="submit"
          disabled={topicTitle.trim() === "" || createTopicMutation.isPending}
        >
          <Plus size={13} />
          新建主题
        </button>
      </form>

      {createTopicMutation.error !== null && (
        <div className="pm-error">{createTopicMutation.error.message}</div>
      )}

      <div className="memory-list">
        {memory.map((topic) => {
          const selected = selectedClaims[topic.id] ?? [];
          return (
            <article className="memory-item memory-topic-card" key={topic.id}>
              <header>
                <div>
                  <strong>{topic.title}</strong>
                  <span>
                    Current Truth v{topic.currentTruth?.version ?? "-"}
                  </span>
                </div>
                <small>{formatDateTime(topic.updatedAt)}</small>
              </header>
              <p className={topic.currentTruth === null ? "muted" : ""}>
                {topic.currentTruth?.content ?? "尚未发布当前结论"}
              </p>

              <div className="memory-claim-list">
                {topic.claims.map((claim) => {
                  const checked = selected.includes(claim.id);
                  return (
                    <div
                      className={`memory-claim claim-${claim.status}`}
                      key={claim.id}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={claim.status === "rejected"}
                          onChange={(event) =>
                            setSelectedClaims((current) => ({
                              ...current,
                              [topic.id]: event.target.checked
                                ? [...selected, claim.id]
                                : selected.filter((id) => id !== claim.id),
                            }))
                          }
                        />
                        <span>{claim.content}</span>
                      </label>
                      <div className="memory-claim-actions">
                        <span className="pm-pill neutral">
                          {claim.status === "proposed"
                            ? "待确认"
                            : claim.status === "confirmed"
                              ? "已确认"
                              : "已拒绝"}
                        </span>
                        <button
                          type="button"
                          title="确认 Claim"
                          aria-label="确认 Claim"
                          onClick={() =>
                            updateClaimMutation.mutate({
                              topicId: topic.id,
                              claim,
                              status: "confirmed",
                            })
                          }
                        >
                          <CircleCheck size={13} />
                        </button>
                        <button
                          type="button"
                          title="拒绝 Claim"
                          aria-label="拒绝 Claim"
                          onClick={() =>
                            updateClaimMutation.mutate({
                              topicId: topic.id,
                              claim,
                              status: "rejected",
                            })
                          }
                        >
                          <CircleX size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {topic.claims.length === 0 && (
                  <div className="pm-empty compact">
                    尚无 Claim，先记录一条可验证的事实或决策。
                  </div>
                )}
              </div>

              <form
                className="memory-claim-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if ((claimDrafts[topic.id] ?? "").trim() !== "") {
                    createClaimMutation.mutate(topic.id);
                  }
                }}
              >
                <input
                  value={claimDrafts[topic.id] ?? ""}
                  onChange={(event) =>
                    setClaimDrafts((current) => ({
                      ...current,
                      [topic.id]: event.target.value,
                    }))
                  }
                  placeholder="记录一条可追溯的 Claim"
                />
                <button
                  className="pm-btn secondary"
                  type="submit"
                  disabled={
                    (claimDrafts[topic.id] ?? "").trim() === "" ||
                    createClaimMutation.isPending
                  }
                >
                  添加 Claim
                </button>
                <button
                  className="pm-btn primary"
                  type="button"
                  disabled={selected.length === 0 || publishMutation.isPending}
                  onClick={() => publishMutation.mutate(topic.id)}
                >
                  发布 Truth
                </button>
              </form>
            </article>
          );
        })}
        {memory.length === 0 && (
          <div className="pm-empty">
            建立 Topic 并记录 Claim 后，可手动发布 Current Truth；任务验收仍会
            自动沉淀一条记忆。
          </div>
        )}
      </div>
    </div>
  );
}

function CreateTaskDialog({
  projectId,
  agents,
  roles,
  tasks,
  onClose,
  onCreated,
}: {
  projectId: string;
  agents: Agent[];
  roles: ProjectRole[];
  tasks: Task[];
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const availableAgents = agents.filter((agent) => agent.status === "active");
  const [agentId, setAgentId] = useState(availableAgents[0]?.id ?? "");
  const [roleId, setRoleId] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const mutation = useMutation({
    mutationFn: () =>
      createTask({
        projectId,
        title,
        description,
        acceptance: acceptance
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        ...(roleId === "" ? (agentId === "" ? {} : { agentId }) : { roleId }),
        dependsOn,
      }),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      onCreated(task);
    },
  });

  return (
    <div className="pm-modal-layer" role="presentation">
      <form
        className="pm-modal task-create-modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            title.trim() !== "" &&
            description.trim() !== "" &&
            (roleId !== "" || agentId !== "")
          ) {
            mutation.mutate();
          }
        }}
      >
        <div className="pm-modal-head">
          <div>
            <h2>新建任务</h2>
            <p>定义目标、执行 AI 伙伴和验收标准。</p>
          </div>
          <button
            className="pm-icon-btn"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="pm-form-grid">
          <label className="pm-field pm-field-wide">
            <span>标题</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：分析关键物料延迟影响"
            />
          </label>
          <label className="pm-field pm-field-wide">
            <span>任务说明</span>
            <textarea
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="描述目标、范围、输入和期望交付"
            />
          </label>
          <label className="pm-field">
            <span>执行 AI 伙伴</span>
            <select
              value={agentId}
              disabled={roleId !== ""}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {availableAgents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name} · {agent.runtimeKind}
                </option>
              ))}
            </select>
          </label>
          <label className="pm-field">
            <span>项目角色</span>
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
            >
              <option value="">直接指派 AI 伙伴</option>
              {roles.map((role) => (
                <option value={role.id} key={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <label className="pm-field">
            <span>验收标准</span>
            <textarea
              rows={3}
              value={acceptance}
              onChange={(event) => setAcceptance(event.target.value)}
              placeholder={"每行一条\n提供结论与证据"}
            />
          </label>
          <fieldset className="pm-field pm-field-wide task-dependency-picker">
            <legend>前置依赖</legend>
            <div>
              {tasks.map((task) => (
                <label key={task.id}>
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(task.id)}
                    onChange={(event) =>
                      setDependsOn((current) =>
                        event.target.checked
                          ? [...current, task.id]
                          : current.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <span>{task.title}</span>
                  <small>{taskStatusLabel[task.status]}</small>
                </label>
              ))}
              {tasks.length === 0 && <small>当前项目还没有可依赖任务</small>}
            </div>
          </fieldset>
        </div>
        {mutation.error !== null && (
          <div className="pm-error">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "创建任务失败"}
          </div>
        )}
        <div className="pm-modal-actions">
          <button className="pm-btn secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="pm-btn primary"
            type="submit"
            disabled={
              mutation.isPending ||
              title.trim() === "" ||
              description.trim() === "" ||
              (roleId === "" && agentId === "")
            }
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Plus size={14} />
            )}
            创建任务
          </button>
        </div>
      </form>
    </div>
  );
}

const taskColumns: Array<{
  key: string;
  label: string;
  statuses: Task["status"][];
}> = [
  { key: "todo", label: "待处理", statuses: ["queued"] },
  { key: "progress", label: "进行中", statuses: ["in_progress"] },
  { key: "review", label: "待验收", statuses: ["review"] },
  { key: "done", label: "已完成", statuses: ["done", "cancelled"] },
];

export function TasksView({
  projects,
  agents,
  projectId,
  onProjectChange,
  initialTaskId,
  onInitialTaskConsumed,
}: SharedViewProps & {
  initialTaskId: string;
  onInitialTaskConsumed: () => void;
}) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const tasksQuery = useQuery({
    queryKey: ["tasks", selectedProjectId],
    queryFn: () => listTasks(selectedProjectId),
    enabled: selectedProjectId !== "",
    refetchInterval: 4_000,
  });
  const rolesQuery = useQuery({
    queryKey: ["project-roles", selectedProjectId],
    queryFn: () => listProjectRoles(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const tasks = tasksQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);

  useEffect(() => {
    if (initialTaskId !== "") {
      setSelectedTaskId(initialTaskId);
      onInitialTaskConsumed();
    }
  }, [initialTaskId, onInitialTaskConsumed]);

  const visibleTasks = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    if (value === "") return tasks;
    return tasks.filter(
      (task) =>
        task.title.toLocaleLowerCase().includes(value) ||
        task.description.toLocaleLowerCase().includes(value),
    );
  }, [query, tasks]);

  return (
    <main className="pm-page task-page">
      <header className="pm-page-head">
        <div>
          <h1>任务</h1>
          <p>从目标、派发、实时进展到人工验收的统一工作队列。</p>
        </div>
        <div className="pm-head-actions">
          <select
            className="pm-compact-select"
            aria-label="任务项目"
            value={selectedProjectId}
            onChange={(event) => {
              setSelectedTaskId("");
              onProjectChange(event.target.value);
            }}
          >
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="pm-btn primary"
            type="button"
            disabled={
              selectedProjectId === "" ||
              !agents.some((agent) => agent.status === "active")
            }
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            新建任务
          </button>
        </div>
      </header>

      <div className="task-filterbar">
        <label className="pm-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
          />
        </label>
        <span>{visibleTasks.length} 项任务</span>
        <span className="task-filter-hint">
          点击任务卡查看 Run 输入、进展与输出
        </span>
      </div>

      <div className="task-board">
        {taskColumns.map((column) => {
          const items = visibleTasks.filter((task) =>
            column.statuses.includes(task.status),
          );
          return (
            <section
              className={`task-column task-column-${column.key}`}
              key={column.key}
            >
              <header className="task-column-head">
                <i />
                <strong>{column.label}</strong>
                <span>{items.length}</span>
                <button
                  title={`在${column.label}中新建任务`}
                  type="button"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus size={13} />
                </button>
              </header>
              <div className="task-card-list">
                {items.map((task) => {
                  const agent = agents.find((item) => item.id === task.agentId);
                  const role = roles.find((item) => item.id === task.roleId);
                  return (
                    <button
                      className={`task-board-card ${
                        task.id === selectedTaskId ? "active" : ""
                      }`}
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <div className="task-board-card-top">
                        <span className={`pm-pill ${statusTone[task.status]}`}>
                          {taskStatusLabel[task.status]}
                        </span>
                        <small>{task.acceptance.length} 项验收</small>
                      </div>
                      <strong>{task.title}</strong>
                      <p>{task.description}</p>
                      <div className="task-board-card-foot">
                        <span>
                          {role === undefined ? (
                            <Bot size={12} />
                          ) : (
                            <UsersRound size={12} />
                          )}
                          {role?.name ?? agent?.name ?? "未分配 AI 伙伴"}
                        </span>
                        <time>{formatDateTime(task.updatedAt)}</time>
                      </div>
                    </button>
                  );
                })}
                {items.length === 0 && (
                  <div className="task-column-empty">暂无任务</div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {selectedTask !== undefined && (
        <TaskDetailDrawer
          task={selectedTask}
          tasks={tasks}
          roles={roles}
          onClose={() => setSelectedTaskId("")}
          onTaskChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
          }}
        />
      )}

      {createOpen && (
        <CreateTaskDialog
          projectId={selectedProjectId}
          agents={agents}
          roles={roles}
          tasks={tasks}
          onClose={() => setCreateOpen(false)}
          onCreated={(task) => {
            setCreateOpen(false);
            setSelectedTaskId(task.id);
          }}
        />
      )}
    </main>
  );
}

function TaskDetailDrawer({
  task,
  tasks,
  roles,
  onClose,
  onTaskChanged,
}: {
  task: Task;
  tasks: Task[];
  roles: ProjectRole[];
  onClose: () => void;
  onTaskChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [acceptanceDraft, setAcceptanceDraft] = useState(
    task.acceptance.join("\n"),
  );
  const [editingAcceptance, setEditingAcceptance] = useState(false);
  const [editingDependencies, setEditingDependencies] = useState(false);
  const [dependencyDraft, setDependencyDraft] = useState<string[]>(
    task.dependsOn,
  );
  const [comment, setComment] = useState("");
  const projectTasks = tasks.filter(
    (candidate) =>
      candidate.projectId === task.projectId && candidate.id !== task.id,
  );
  const dependencies = task.dependsOn
    .map((id) => tasks.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Task => candidate !== undefined);
  const unresolvedDependencies = dependencies.filter(
    (dependency) => dependency.status !== "done",
  );
  const role = roles.find((candidate) => candidate.id === task.roleId);
  const detailQuery = useQuery({
    queryKey: ["task-detail", task.id],
    queryFn: () => getTaskDetail(task.id),
  });
  const runsQuery = useQuery({
    queryKey: ["task-runs", task.id],
    queryFn: () => listTaskRuns(task.id),
    refetchInterval: task.status === "in_progress" ? 2_000 : false,
  });
  useEffect(() => {
    const latest = runsQuery.data?.[0];
    if (latest !== undefined) setRunId(latest.id);
  }, [runsQuery.data]);
  useEffect(() => {
    setAcceptanceDraft(task.acceptance.join("\n"));
  }, [task.acceptance]);
  useEffect(() => {
    setDependencyDraft(task.dependsOn);
    setEditingDependencies(false);
  }, [task.dependsOn, task.updatedAt]);
  const dispatchMutation = useMutation({
    mutationFn: () => dispatchTask(task.id),
    onSuccess: ({ runId: createdRunId }) => {
      setRunId(createdRunId);
      onTaskChanged();
      void queryClient.invalidateQueries({ queryKey: ["task-runs", task.id] });
    },
  });
  const reviewMutation = useMutation({
    mutationFn: (decision: "approve" | "return") =>
      reviewTask(task.id, decision, reviewNote),
    onSuccess: () => {
      setReviewNote("");
      onTaskChanged();
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
      void queryClient.invalidateQueries({ queryKey: ["workbench-summary"] });
    },
  });
  const updateMutation = useMutation({
    mutationFn: () =>
      updateTask(task.id, {
        acceptance: acceptanceDraft
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setEditingAcceptance(false);
      onTaskChanged();
      void queryClient.invalidateQueries({
        queryKey: ["task-detail", task.id],
      });
    },
  });
  const dependencyMutation = useMutation({
    mutationFn: () => updateTask(task.id, { dependsOn: dependencyDraft }),
    onSuccess: () => {
      setEditingDependencies(false);
      onTaskChanged();
      void queryClient.invalidateQueries({
        queryKey: ["task-detail", task.id],
      });
    },
  });
  const commentMutation = useMutation({
    mutationFn: () => postTaskMessage(task.id, { content: comment }),
    onSuccess: () => {
      setComment("");
      void queryClient.invalidateQueries({
        queryKey: ["task-detail", task.id],
      });
    },
  });
  const messages: TaskMessage[] = detailQuery.data?.messages ?? [];

  return (
    <div className="task-detail-layer" role="presentation">
      <section className="task-detail-drawer" aria-label="任务详情">
        <header className="task-detail-head">
          <div>
            <div className="task-detail-meta">
              <span className={`pm-pill ${statusTone[task.status]}`}>
                {taskStatusLabel[task.status]}
              </span>
              <span>{task.acceptance.length} 项验收标准</span>
              {role !== undefined && <span>项目角色 · {role.name}</span>}
            </div>
            <h2>{task.title}</h2>
            <p>{task.description}</p>
          </div>
          <button
            className="pm-icon-btn"
            type="button"
            title="关闭任务详情"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="task-acceptance">
          {editingAcceptance ? (
            <form
              className="task-acceptance-editor"
              onSubmit={(event) => {
                event.preventDefault();
                updateMutation.mutate();
              }}
            >
              <textarea
                autoFocus
                rows={3}
                value={acceptanceDraft}
                onChange={(event) => setAcceptanceDraft(event.target.value)}
                placeholder={"每行一条验收标准"}
              />
              <div>
                <button
                  className="pm-btn secondary"
                  type="button"
                  onClick={() => {
                    setAcceptanceDraft(task.acceptance.join("\n"));
                    setEditingAcceptance(false);
                  }}
                >
                  取消
                </button>
                <button
                  className="pm-btn primary"
                  type="submit"
                  disabled={updateMutation.isPending}
                >
                  保存标准
                </button>
              </div>
            </form>
          ) : (
            <>
              {task.acceptance.map((item) => (
                <span key={item}>
                  <Check size={12} />
                  {item}
                </span>
              ))}
              {task.acceptance.length === 0 && <em>尚未设置验收标准</em>}
              <button
                className="task-acceptance-edit"
                type="button"
                title="编辑验收标准"
                onClick={() => setEditingAcceptance(true)}
              >
                <Edit3 size={12} />
              </button>
            </>
          )}
        </div>

        <div className="task-dependency-panel">
          <header>
            <div>
              <Network size={14} />
              <strong>前置依赖</strong>
              <span>
                {dependencies.length === 0
                  ? "无依赖"
                  : `${dependencies.length} 项，${unresolvedDependencies.length} 项未完成`}
              </span>
            </div>
            {task.status === "queued" && !editingDependencies && (
              <button
                className="pm-btn secondary"
                type="button"
                onClick={() => setEditingDependencies(true)}
              >
                <Edit3 size={12} />
                编辑依赖
              </button>
            )}
          </header>
          {editingDependencies ? (
            <div className="task-dependency-editor">
              {projectTasks.map((candidate) => (
                <label key={candidate.id}>
                  <input
                    type="checkbox"
                    checked={dependencyDraft.includes(candidate.id)}
                    onChange={(event) =>
                      setDependencyDraft((current) =>
                        event.target.checked
                          ? [...current, candidate.id]
                          : current.filter((id) => id !== candidate.id),
                      )
                    }
                  />
                  <span>{candidate.title}</span>
                  <small>{taskStatusLabel[candidate.status]}</small>
                </label>
              ))}
              {projectTasks.length === 0 && (
                <span className="muted">当前项目没有其他任务</span>
              )}
              <div>
                <button
                  className="pm-btn secondary"
                  type="button"
                  onClick={() => {
                    setDependencyDraft(task.dependsOn);
                    setEditingDependencies(false);
                  }}
                >
                  取消
                </button>
                <button
                  className="pm-btn primary"
                  type="button"
                  disabled={dependencyMutation.isPending}
                  onClick={() => dependencyMutation.mutate()}
                >
                  保存依赖
                </button>
              </div>
            </div>
          ) : (
            <div className="task-dependency-list">
              {dependencies.map((dependency) => (
                <span
                  className={`task-dependency-chip ${
                    dependency.status === "done" ? "done" : ""
                  }`}
                  key={dependency.id}
                >
                  <b>{dependency.title}</b>
                  <small>{taskStatusLabel[dependency.status]}</small>
                </span>
              ))}
              {dependencies.length === 0 && (
                <span className="muted">未设置前置任务</span>
              )}
            </div>
          )}
          {dependencyMutation.error !== null && (
            <div className="pm-error">{dependencyMutation.error.message}</div>
          )}
        </div>

        <div className="task-detail-actions">
          {task.status === "queued" && (
            <button
              className="pm-btn primary"
              type="button"
              disabled={
                dispatchMutation.isPending || unresolvedDependencies.length > 0
              }
              title={
                unresolvedDependencies.length === 0
                  ? "派发执行"
                  : `请先完成 ${unresolvedDependencies.map((item) => item.title).join("、")}`
              }
              onClick={() => dispatchMutation.mutate()}
            >
              {dispatchMutation.isPending ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Activity size={14} />
              )}
              派发执行
            </button>
          )}
          {unresolvedDependencies.length > 0 && (
            <span className="task-dispatch-blocked">
              前置任务未完成，暂不能派发
            </span>
          )}
          {task.status === "review" && (
            <>
              <input
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder="验收意见或退回原因"
              />
              <button
                className="pm-btn secondary"
                type="button"
                disabled={reviewMutation.isPending}
                onClick={() => reviewMutation.mutate("return")}
              >
                <Undo2 size={14} />
                退回
              </button>
              <button
                className="pm-btn primary"
                type="button"
                disabled={reviewMutation.isPending}
                onClick={() => reviewMutation.mutate("approve")}
              >
                <Check size={14} />
                验收通过
              </button>
            </>
          )}
          {runsQuery.data !== undefined && runsQuery.data.length > 1 && (
            <select
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              aria-label="选择运行轮次"
            >
              {runsQuery.data.map((run, index) => (
                <option value={run.id} key={run.id}>
                  第 {runsQuery.data!.length - index} 轮 · {run.status}
                </option>
              ))}
            </select>
          )}
        </div>
        {dispatchMutation.error !== null && (
          <div className="pm-error">{dispatchMutation.error.message}</div>
        )}

        <div className="task-run-body">
          <section className="task-discussion">
            <div className="task-discussion-head">
              <div>
                <MessageSquare size={14} />
                <strong>任务讨论</strong>
                <span>{messages.length} 条消息</span>
              </div>
            </div>
            <div className="task-message-list">
              {messages.map((item) => (
                <article
                  className={`task-message message-${item.authorType}`}
                  key={item.id}
                >
                  <header>
                    <strong>{item.authorName}</strong>
                    <time>{formatDateTime(item.createdAt)}</time>
                  </header>
                  <p>{item.content}</p>
                </article>
              ))}
              {messages.length === 0 && (
                <div className="task-message-empty">
                  记录决策、补充上下文或给 Agent 留下后续说明。
                </div>
              )}
            </div>
            <form
              className="task-message-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (comment.trim() !== "") commentMutation.mutate();
              }}
            >
              <textarea
                rows={2}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="添加任务评论"
              />
              <button
                className="pm-btn primary"
                type="submit"
                title="发送评论"
                disabled={comment.trim() === "" || commentMutation.isPending}
              >
                {commentMutation.isPending ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Send size={14} />
                )}
              </button>
            </form>
          </section>
          {runId !== "" ? (
            <RunView runId={runId} />
          ) : (
            <div className="pm-empty run-observation-empty">
              <FileText size={24} />
              <strong>尚未派发 Run</strong>
              <span>
                派发后可在这里查看输入快照、Agent 事件、实时输出和交付物。
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
