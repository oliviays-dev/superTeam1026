import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  CirclePause,
  Clock3,
  FileText,
  ListOrdered,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  UserRoundCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  Agent,
  ParsedTeammateWorkPlan,
  Project,
  ProjectCapability,
  Teammate,
  TeammateDefinition,
  TeammateQueueItem,
  TeammateTemplate,
} from "@pluginmax/contracts";
import {
  archiveTeammateTemplate,
  changeTeammateStatus,
  createTeammate,
  createTeammateTemplate,
  createTeammateWorkPlan,
  generateTeammateWeeklyReport,
  getTeammate,
  getTeammateEconomics,
  getTeammateExecutionHistory,
  listProjectMembers,
  listTeammates,
  listTeammateTemplates,
  listTeammateWorkQueue,
  parseTeammateWorkPlan,
  reorderTeammateWorkQueue,
  setTeammateAutoExecute,
  transferTeammate,
  updateTeammateTemplate,
} from "./api.js";

const emptyDefinition: TeammateDefinition = {
  name: "",
  role: "",
  description: "",
  soul: "",
  scenarios: [],
  goals: [],
  tools: [],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMinutes(milliseconds: number): string {
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function statusLabel(status: Teammate["status"]): string {
  if (status === "active") return "生效";
  if (status === "paused") return "暂停";
  if (status === "inactive") return "失效";
  return "归档";
}

function TemplateEditor({
  template,
  projectId,
  onSaved,
}: {
  readonly template?: TeammateTemplate | undefined;
  readonly projectId: string;
  readonly onSaved: () => void;
}) {
  const [definition, setDefinition] = useState<TeammateDefinition>(
    template?.definition ?? { ...emptyDefinition },
  );
  const [scope, setScope] = useState<"personal" | "platform">(
    template?.scope ?? "personal",
  );
  const save = useMutation({
    mutationFn: async () => {
      if (template === undefined) {
        return createTeammateTemplate({
          projectId,
          scope,
          definition,
        });
      }
      return updateTeammateTemplate(template.id, {
        expectedVersion: template.currentVersion,
        definition,
      });
    },
    onSuccess: onSaved,
  });

  return (
    <form
      className="teammate-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label>
        <span>模板名称</span>
        <input
          value={definition.name}
          onChange={(event) =>
            setDefinition({ ...definition, name: event.target.value })
          }
          required
        />
      </label>
      {template === undefined && (
        <label>
          <span>模板归属</span>
          <select
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "personal" | "platform")
            }
          >
            <option value="personal">个人</option>
            <option value="platform">平台</option>
          </select>
        </label>
      )}
      <label>
        <span>岗位</span>
        <input
          value={definition.role}
          onChange={(event) =>
            setDefinition({ ...definition, role: event.target.value })
          }
        />
      </label>
      <label className="wide">
        <span>描述</span>
        <textarea
          value={definition.description}
          onChange={(event) =>
            setDefinition({ ...definition, description: event.target.value })
          }
          rows={2}
        />
      </label>
      <label className="wide">
        <span>SOUL</span>
        <textarea
          value={definition.soul}
          onChange={(event) =>
            setDefinition({ ...definition, soul: event.target.value })
          }
          rows={4}
        />
      </label>
      <label className="wide">
        <span>工具白名单</span>
        <input
          value={definition.tools.join(", ")}
          onChange={(event) =>
            setDefinition({
              ...definition,
              tools: event.target.value
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
          placeholder="file-read, search"
        />
      </label>
      {save.isError && <p className="form-error">{messageOf(save.error)}</p>}
      <button
        className="pm-btn primary"
        type="submit"
        disabled={save.isPending}
      >
        {save.isPending ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <CheckCircle2 size={14} />
        )}
        {template === undefined ? "创建模板版本" : "发布新版本"}
      </button>
    </form>
  );
}

function QueueColumn({
  title,
  icon: Icon,
  items,
  onMove,
}: {
  readonly title: string;
  readonly icon: typeof ListOrdered;
  readonly items: readonly TeammateQueueItem[];
  readonly onMove?: ((taskId: string, direction: -1 | 1) => void) | undefined;
}) {
  return (
    <section className="teammate-queue-column">
      <header>
        <Icon size={14} />
        <strong>{title}</strong>
        <b>{items.length}</b>
      </header>
      <div>
        {items.map((item) => (
          <article className="teammate-queue-card" key={item.taskId}>
            <div>
              <strong>{item.task.title}</strong>
              <small>{item.task.priority}</small>
            </div>
            <p>{item.task.description}</p>
            <footer>
              <span
                className={
                  item.autoEligible ? "teammate-eligible" : "teammate-blocked"
                }
              >
                {item.autoEligible ? "可自动执行" : "需人工处理"}
              </span>
              {item.blockedReasons.length > 0 && (
                <small>{item.blockedReasons.join(" · ")}</small>
              )}
              {onMove !== undefined && (
                <span className="teammate-order-actions">
                  <button
                    type="button"
                    title="上移"
                    onClick={() => onMove(item.taskId, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    title="下移"
                    onClick={() => onMove(item.taskId, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </span>
              )}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TeammatesView({
  projects,
  agents,
  projectId,
  onProjectChange,
  capability,
  viewerPrincipalId,
}: {
  readonly projects: readonly Project[];
  readonly agents: readonly Agent[];
  readonly projectId: string;
  readonly onProjectChange: (projectId: string) => void;
  readonly capability: ProjectCapability | undefined;
  readonly viewerPrincipalId: string;
}) {
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [teammateId, setTeammateId] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [planInstruction, setPlanInstruction] = useState("");
  const [parsedPlan, setParsedPlan] = useState<
    ParsedTeammateWorkPlan | undefined
  >();
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [archiveTemplate, setArchiveTemplate] = useState(false);

  const templatesQuery = useQuery({
    queryKey: ["teammate-templates", projectId],
    queryFn: () => listTeammateTemplates(projectId),
    enabled: projectId !== "",
  });
  const teammatesQuery = useQuery({
    queryKey: ["teammates", projectId],
    queryFn: () => listTeammates(projectId),
    enabled: projectId !== "",
  });
  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => listProjectMembers(projectId),
    enabled: projectId !== "",
  });
  const selectedTeammate =
    teammatesQuery.data?.find((item) => item.id === teammateId) ??
    teammatesQuery.data?.[0];
  const activeTeammateId = selectedTeammate?.id ?? "";
  const detailQuery = useQuery({
    queryKey: ["teammate-detail", activeTeammateId],
    queryFn: () => getTeammate(activeTeammateId),
    enabled: activeTeammateId !== "",
  });
  const queueQuery = useQuery({
    queryKey: ["teammate-queue", activeTeammateId],
    queryFn: () => listTeammateWorkQueue(activeTeammateId),
    enabled: activeTeammateId !== "",
  });
  const economicsQuery = useQuery({
    queryKey: ["teammate-economics", activeTeammateId],
    queryFn: () => getTeammateEconomics(activeTeammateId),
    enabled: activeTeammateId !== "",
  });
  const historyQuery = useQuery({
    queryKey: ["teammate-history", activeTeammateId],
    queryFn: () => getTeammateExecutionHistory(activeTeammateId, { limit: 10 }),
    enabled: activeTeammateId !== "",
  });

  useEffect(() => {
    if (
      teammatesQuery.data !== undefined &&
      teammatesQuery.data.length > 0 &&
      !teammatesQuery.data.some((item) => item.id === teammateId)
    ) {
      setTeammateId(teammatesQuery.data[0]!.id);
    }
    if ((teammatesQuery.data?.length ?? 0) === 0) setTeammateId("");
  }, [teammatesQuery.data, teammateId]);

  useEffect(() => {
    if (
      templatesQuery.data !== undefined &&
      templatesQuery.data.length > 0 &&
      !templatesQuery.data.some((item) => item.id === templateId)
    ) {
      setTemplateId(templatesQuery.data[0]!.id);
    }
  }, [templateId, templatesQuery.data]);

  useEffect(() => {
    if (
      agents.length > 0 &&
      !agents.some((agent) => agent.id === agentId && agent.status === "active")
    ) {
      setAgentId(agents.find((agent) => agent.status === "active")?.id ?? "");
    }
  }, [agentId, agents]);

  const selectedTemplate = templatesQuery.data?.find(
    (item) => item.id === templateId,
  );
  const humanMembers =
    membersQuery.data?.filter(
      (member) =>
        member.kind === "human" &&
        member.status === "active" &&
        member.principalId !== viewerPrincipalId &&
        member.actorId !== viewerPrincipalId &&
        member.principalId !== selectedTeammate?.ownerPrincipalId,
    ) ?? [];
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["teammates"] }),
      queryClient.invalidateQueries({ queryKey: ["teammate-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["teammate-queue"] }),
      queryClient.invalidateQueries({ queryKey: ["teammate-economics"] }),
      queryClient.invalidateQueries({ queryKey: ["teammate-history"] }),
    ]);
  };

  const createInstance = useMutation({
    mutationFn: () =>
      createTeammate({
        projectId,
        templateId,
        agentId,
        autoExecute: false,
      }),
    onSuccess: async (created) => {
      setTeammateId(created.id);
      await refresh();
    },
  });
  const parsePlan = useMutation({
    mutationFn: () => parseTeammateWorkPlan(activeTeammateId, planInstruction),
    onSuccess: setParsedPlan,
  });
  const generatePlan = useMutation({
    mutationFn: () => {
      if (parsedPlan === undefined) {
        throw new Error("先解析工作计划");
      }
      return createTeammateWorkPlan(activeTeammateId, {
        instruction: parsedPlan.instruction,
        items: parsedPlan.items,
        autoExecuteEligible: autoGenerate,
      });
    },
    onSuccess: async () => {
      setPlanInstruction("");
      setParsedPlan(undefined);
      await refresh();
    },
  });
  const lifecycle = useMutation({
    mutationFn: (status: "active" | "paused" | "archived") => {
      if (selectedTeammate === undefined) {
        throw new Error("未选择 AI Teammate");
      }
      return changeTeammateStatus(selectedTeammate.id, {
        status,
        expectedVersion: selectedTeammate.version,
        reason: "Web 工作台生命周期操作",
      });
    },
    onSuccess: refresh,
  });
  const autoExecute = useMutation({
    mutationFn: (enabled: boolean) => {
      if (selectedTeammate === undefined) {
        throw new Error("未选择 AI Teammate");
      }
      return setTeammateAutoExecute(
        selectedTeammate.id,
        enabled,
        selectedTeammate.version,
      );
    },
    onSuccess: refresh,
  });
  const transfer = useMutation({
    mutationFn: () => {
      if (selectedTeammate === undefined || transferTarget === "") {
        throw new Error("选择转派成员");
      }
      return transferTeammate(selectedTeammate.id, {
        toOwnerPrincipalId: transferTarget,
        expectedVersion: selectedTeammate.version,
        reason: "Web 工作台安全转派",
      });
    },
    onSuccess: async () => {
      setTransferTarget("");
      await refresh();
    },
  });
  const report = useMutation({
    mutationFn: () => generateTeammateWeeklyReport(activeTeammateId),
    onSuccess: refresh,
  });
  const reorder = useMutation({
    mutationFn: (taskIds: string[]) =>
      reorderTeammateWorkQueue(activeTeammateId, taskIds),
    onSuccess: refresh,
  });

  const moveQueueItem = (taskId: string, direction: -1 | 1) => {
    const items = queueQuery.data ?? [];
    const index = items.findIndex((item) => item.taskId === taskId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next.map((item) => item.taskId));
  };

  const queueByStatus = useMemo(() => {
    const queue = queueQuery.data ?? [];
    return {
      planned: queue.filter((item) => item.task.status === "queued"),
      running: queue.filter((item) =>
        ["in_progress", "paused", "blocked", "needs_input"].includes(
          item.task.status,
        ),
      ),
      review: queue.filter((item) => item.task.status === "review"),
      finished: queue.filter((item) => item.task.status === "done"),
    };
  }, [queueQuery.data]);

  if (projectId === "") {
    return (
      <main className="pm-page teammate-page">
        <div className="pm-empty">选择项目后管理 AI Teammate</div>
      </main>
    );
  }

  const error =
    templatesQuery.error ??
    teammatesQuery.error ??
    detailQuery.error ??
    queueQuery.error ??
    economicsQuery.error;
  const canManage = capability?.capabilities.write ?? false;

  return (
    <main className="pm-page teammate-page" aria-label="AI Teammate 工作台">
      <header className="pm-page-head teammate-head">
        <div>
          <h1>AI Teammate</h1>
          <p>模板版本、工作队列与执行经济</p>
        </div>
        <div className="teammate-head-actions">
          <label>
            <span>项目</span>
            <select
              aria-label="AI Teammate 项目"
              value={projectId}
              onChange={(event) => {
                onProjectChange(event.target.value);
                setTeammateId("");
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="pm-btn"
            type="button"
            disabled={!canManage}
            onClick={() => {
              setCreatingTemplate(true);
              setArchiveTemplate(false);
            }}
          >
            <Plus size={14} /> 新建模板
          </button>
        </div>
      </header>

      {error !== null && <div className="form-error">{messageOf(error)}</div>}

      <div className="teammate-layout">
        <aside className="teammate-directory pm-panel">
          <header>
            <strong>模板</strong>
            <span>{templatesQuery.data?.length ?? 0}</span>
          </header>
          <div className="teammate-directory-list">
            {templatesQuery.data?.map((template) => (
              <button
                type="button"
                key={template.id}
                className={
                  template.id === templateId && !creatingTemplate
                    ? "active"
                    : undefined
                }
                onClick={() => {
                  setTemplateId(template.id);
                  setCreatingTemplate(false);
                  setArchiveTemplate(false);
                }}
              >
                <span>{template.definition.name.slice(0, 1)}</span>
                <div>
                  <strong>{template.definition.name}</strong>
                  <small>
                    {template.scope === "platform" ? "平台" : "个人"} · v
                    {template.currentVersion}
                  </small>
                </div>
              </button>
            ))}
          </div>
          <header className="teammate-directory-section">
            <strong>实例</strong>
            <span>{teammatesQuery.data?.length ?? 0}</span>
          </header>
          <div className="teammate-directory-list">
            {teammatesQuery.data?.map((teammate) => (
              <button
                type="button"
                key={teammate.id}
                className={
                  teammate.id === activeTeammateId ? "active" : undefined
                }
                onClick={() => setTeammateId(teammate.id)}
              >
                <Bot size={16} />
                <div>
                  <strong>{teammate.name}</strong>
                  <small>
                    {statusLabel(teammate.status)} · {teammate.agent.name}
                  </small>
                </div>
              </button>
            ))}
          </div>
          <label className="teammate-agent-picker">
            <span>执行身份</span>
            <select
              aria-label="实例执行 Agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents
                .filter((agent) => agent.status === "active")
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="pm-btn teammate-create-instance"
            type="button"
            disabled={!canManage || templateId === "" || agentId === ""}
            onClick={() => createInstance.mutate()}
          >
            <Plus size={14} /> 从此模板创建实例
          </button>
          {createInstance.isError && (
            <p className="form-error">{messageOf(createInstance.error)}</p>
          )}
        </aside>

        <section className="teammate-main">
          {(creatingTemplate || selectedTemplate !== undefined) && (
            <section className="pm-panel teammate-template-panel">
              <header>
                <div>
                  <strong>
                    {creatingTemplate
                      ? "新模板"
                      : selectedTemplate?.definition.name}
                  </strong>
                  {!creatingTemplate && selectedTemplate !== undefined && (
                    <small>
                      v{selectedTemplate.currentVersion} ·{" "}
                      {selectedTemplate.status}
                    </small>
                  )}
                </div>
                {!creatingTemplate &&
                  selectedTemplate !== undefined &&
                  selectedTemplate.status !== "archived" && (
                    <button
                      className="pm-icon-btn"
                      type="button"
                      title={archiveTemplate ? "取消归档" : "归档模板"}
                      onClick={() => {
                        if (!archiveTemplate) {
                          setArchiveTemplate(true);
                          return;
                        }
                        void archiveTeammateTemplate(
                          selectedTemplate.id,
                          selectedTemplate.currentVersion,
                        ).then(refresh);
                      }}
                    >
                      <Archive size={15} />
                    </button>
                  )}
              </header>
              <TemplateEditor
                key={creatingTemplate ? "new" : selectedTemplate?.id}
                template={creatingTemplate ? undefined : selectedTemplate}
                projectId={projectId}
                onSaved={async () => {
                  setCreatingTemplate(false);
                  await queryClient.invalidateQueries({
                    queryKey: ["teammate-templates", projectId],
                  });
                }}
              />
            </section>
          )}

          {selectedTeammate !== undefined && (
            <>
              <section className="pm-panel teammate-instance-head">
                <div className="teammate-identity">
                  <span className="teammate-avatar">
                    {selectedTeammate.name.slice(0, 2)}
                  </span>
                  <div>
                    <h2>{selectedTeammate.name}</h2>
                    <p>
                      {selectedTeammate.agent.name} · template v
                      {selectedTeammate.templateVersion} · instance v
                      {selectedTeammate.version}
                    </p>
                  </div>
                </div>
                <div className="teammate-actions">
                  {selectedTeammate.status === "active" ? (
                    <button
                      className="pm-btn"
                      type="button"
                      disabled={!canManage}
                      onClick={() => lifecycle.mutate("paused")}
                    >
                      <Pause size={14} /> 暂停
                    </button>
                  ) : (
                    <button
                      className="pm-btn"
                      type="button"
                      disabled={!canManage}
                      onClick={() => lifecycle.mutate("active")}
                    >
                      <Play size={14} /> 恢复
                    </button>
                  )}
                  <button
                    className="pm-btn"
                    type="button"
                    disabled={!canManage}
                    onClick={() => lifecycle.mutate("archived")}
                  >
                    <Archive size={14} /> 归档
                  </button>
                  <label className="teammate-switch">
                    <input
                      type="checkbox"
                      checked={selectedTeammate.autoExecute}
                      aria-label="自动执行"
                      disabled={!canManage}
                      onChange={(event) =>
                        autoExecute.mutate(event.target.checked)
                      }
                    />
                    <span>自动执行</span>
                  </label>
                </div>
                {lifecycle.isError && (
                  <p className="form-error">{messageOf(lifecycle.error)}</p>
                )}
              </section>

              <section className="teammate-metrics">
                {[
                  {
                    label: "运行",
                    value: economicsQuery.data?.runCount ?? 0,
                    icon: Clock3,
                  },
                  {
                    label: "运行时长",
                    value: formatMinutes(
                      economicsQuery.data?.durations.observedTotalMs ?? 0,
                    ),
                    icon: CirclePause,
                  },
                  {
                    label: "Token",
                    value:
                      economicsQuery.data === undefined
                        ? "unknown"
                        : economicsQuery.data.usage.sampleCount === 0
                          ? "unknown"
                          : economicsQuery.data.usage.totalTokens,
                    icon: Bot,
                  },
                  {
                    label: "待确认",
                    value: queueByStatus.review.length,
                    icon: UserRoundCheck,
                  },
                ].map((metric) => {
                  const Icon = metric.icon;
                  return (
                    <article key={metric.label}>
                      <Icon size={16} />
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </article>
                  );
                })}
              </section>

              <section className="pm-panel teammate-plan-panel">
                <header>
                  <strong>工作计划</strong>
                  <small>{parsedPlan?.items.length ?? 0} 个任务</small>
                </header>
                <div className="teammate-plan-input">
                  <textarea
                    aria-label="工作计划指令"
                    value={planInstruction}
                    onChange={(event) => {
                      setPlanInstruction(event.target.value);
                      setParsedPlan(undefined);
                    }}
                    rows={3}
                    placeholder="明天 P1 完成竞品分析并整理证据"
                  />
                  <div>
                    <label className="teammate-switch">
                      <input
                        type="checkbox"
                        checked={autoGenerate}
                        onChange={(event) =>
                          setAutoGenerate(event.target.checked)
                        }
                      />
                      <span>可自动执行</span>
                    </label>
                    <button
                      className="pm-btn"
                      type="button"
                      disabled={planInstruction.trim() === ""}
                      onClick={() => parsePlan.mutate()}
                    >
                      <FileText size={14} /> 解析
                    </button>
                    <button
                      className="pm-btn primary"
                      type="button"
                      disabled={parsedPlan === undefined}
                      onClick={() => generatePlan.mutate()}
                    >
                      <Send size={14} /> 生成任务
                    </button>
                  </div>
                </div>
                {parsedPlan !== undefined && (
                  <div className="teammate-plan-preview">
                    {parsedPlan.items.map((item, index) => (
                      <article key={`${item.title}-${index}`}>
                        <strong>{item.title}</strong>
                        <span>{item.priority}</span>
                        {item.due !== undefined && <small>{item.due}</small>}
                      </article>
                    ))}
                  </div>
                )}
                {(parsePlan.isError || generatePlan.isError) && (
                  <p className="form-error">
                    {messageOf(parsePlan.error ?? generatePlan.error)}
                  </p>
                )}
              </section>

              <section
                className="teammate-queue"
                aria-label="Teammate 工作队列"
              >
                <QueueColumn
                  title="待启动"
                  icon={ListOrdered}
                  items={queueByStatus.planned}
                  onMove={canManage ? moveQueueItem : undefined}
                />
                <QueueColumn
                  title="执行中"
                  icon={LoaderCircle}
                  items={queueByStatus.running}
                />
                <QueueColumn
                  title="待确认"
                  icon={ShieldAlert}
                  items={queueByStatus.review}
                />
                <QueueColumn
                  title="已完成"
                  icon={CheckCircle2}
                  items={queueByStatus.finished}
                />
              </section>

              <div className="teammate-lower-grid">
                <section className="pm-panel teammate-history-panel">
                  <header>
                    <strong>执行历史</strong>
                    <small>{historyQuery.data?.items.length ?? 0}</small>
                  </header>
                  <div>
                    {historyQuery.data?.items.map((item) => (
                      <article key={item.runId}>
                        <span>{item.status}</span>
                        <strong>{item.runtimeId ?? "unknown"}</strong>
                        <small>
                          {item.provider ?? "unknown"} /{" "}
                          {item.model ?? "unknown"}
                        </small>
                        <b>{formatMinutes(item.durations.observedTotalMs)}</b>
                      </article>
                    ))}
                  </div>
                </section>

                <section
                  className="pm-panel teammate-governance-panel"
                  aria-label="AI Teammate 治理"
                >
                  <header>
                    <strong>治理</strong>
                  </header>
                  <div className="teammate-transfer">
                    <label>
                      <span>安全转派</span>
                      <select
                        value={transferTarget}
                        onChange={(event) =>
                          setTransferTarget(event.target.value)
                        }
                      >
                        <option value="">选择成员</option>
                        {humanMembers.map((member) => (
                          <option
                            key={member.id}
                            value={member.principalId ?? member.actorId}
                          >
                            {member.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="pm-btn"
                      type="button"
                      disabled={!canManage || transferTarget === ""}
                      onClick={() => transfer.mutate()}
                    >
                      <RotateCcw size={14} /> 转派
                    </button>
                  </div>
                  <div className="teammate-report-row">
                    <div>
                      <strong>周报</strong>
                      <small>
                        {detailQuery.data?.weeklyReports[0]?.weekStart ??
                          "尚未生成"}
                      </small>
                    </div>
                    <button
                      className="pm-btn"
                      type="button"
                      onClick={() => report.mutate()}
                    >
                      <FileText size={14} /> 生成
                    </button>
                  </div>
                  {(transfer.isError || report.isError) && (
                    <p className="form-error">
                      {messageOf(transfer.error ?? report.error)}
                    </p>
                  )}
                  <div className="teammate-event-list">
                    {detailQuery.data?.events.slice(0, 5).map((event) => (
                      <div key={event.id}>
                        <span>{event.kind}</span>
                        <p>{event.summary}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}

          {selectedTeammate === undefined && (
            <div className="pm-empty">此项目尚无 AI Teammate 实例</div>
          )}
        </section>
      </div>
    </main>
  );
}
