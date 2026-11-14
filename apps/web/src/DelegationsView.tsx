import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  FileWarning,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquareX,
  UserRoundCheck,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  Agent,
  CreateDelegationInput,
  Delegation,
  DelegationAction,
  DelegationContextType,
  Project,
} from "@pluginmax/contracts";
import {
  createDelegation,
  decideDelegationConfirmation,
  dispatchDelegation,
  extendDelegation,
  generateDelegationReport,
  getDelegationPreview,
  listDelegationConfirmations,
  listDelegationEvents,
  listDelegationReports,
  listDelegationRuns,
  listDelegations,
  retryDelegationReport,
  transitionDelegation,
} from "./api.js";

interface DelegationsViewProps {
  readonly projects: readonly Project[];
  readonly agents: readonly Agent[];
  readonly viewerPrincipalId: string;
}

const actionLabels: Record<DelegationAction, string> = {
  read_context: "读取上下文",
  read_materials: "读取材料",
  comment: "评论/发言",
  ask_question: "提问",
  record_risk: "记录风险",
  summarize: "生成摘要",
  submit_draft: "提交草稿",
  submit_deliverable: "提交正式交付物",
  update_status: "修改状态",
  reassign: "改派",
  approve: "审批通过",
  reject: "审批拒绝",
  archive: "归档",
  delete: "删除",
};

const actions = Object.keys(actionLabels) as DelegationAction[];

const contextLabels: Record<DelegationContextType, string> = {
  meeting: "Meeting",
  task: "Task",
  workflow_instance: "Workflow",
  workflow_node: "Workflow 节点",
};

const statusLabels: Record<Delegation["status"], string> = {
  draft: "草稿",
  active: "生效中",
  paused: "已暂停",
  completed: "已完成",
  revoked: "已召回",
  expired: "已过期",
};

const defaultAllowed: DelegationAction[] = [
  "read_context",
  "read_materials",
  "comment",
  "ask_question",
  "record_risk",
  "summarize",
  "submit_draft",
];

const defaultDenied: DelegationAction[] = [
  "update_status",
  "reassign",
  "approve",
  "reject",
  "archive",
  "delete",
];

type Filter = "all" | Delegation["status"] | DelegationContextType;

function defaultExpiry(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusClass(status: Delegation["status"]): string {
  return `delegation-status delegation-status-${status}`;
}

function actionSummary(values: readonly DelegationAction[]): string {
  return values.map((value) => actionLabels[value]).join("、");
}

export function DelegationsView({
  projects,
  agents,
  viewerPrincipalId,
}: DelegationsViewProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [extendValue, setExtendValue] = useState("");
  const [form, setForm] = useState(() => ({
    projectId: projects[0]?.id ?? "",
    contextType: "task" as DelegationContextType,
    contextId: "",
    representativeKind: "ai" as "ai" | "human",
    representativeAgentId: agents[0]?.id ?? "",
    representativePrincipalId: "",
    displayName: "",
    objective: "",
    stance: "",
    watchItems: "",
    materialScopes: "",
    expiresAt: defaultExpiry(),
    approvalPolicy: "suggest-only" as Delegation["approvalPolicy"],
    autoParticipation: "mentions" as Delegation["autoParticipation"],
    reportRequired: true,
    allowedActions: [...defaultAllowed],
    deniedActions: [...defaultDenied],
  }));

  const overview = useQuery({
    queryKey: ["delegations"],
    queryFn: listDelegations,
  });
  useEffect(() => {
    setForm((current) => ({
      ...current,
      projectId: current.projectId || projects[0]?.id || "",
      representativeAgentId:
        current.representativeAgentId || agents[0]?.id || "",
    }));
  }, [agents, projects]);
  const selected =
    overview.data?.items.find((item) => item.id === selectedId) ??
    overview.data?.items[0];

  const preview = useQuery({
    queryKey: ["delegation-preview", selected?.id],
    queryFn: () => getDelegationPreview(selected!.id),
    enabled: selected !== undefined,
  });
  const events = useQuery({
    queryKey: ["delegation-events", selected?.id],
    queryFn: () => listDelegationEvents(selected!.id),
    enabled: selected !== undefined,
  });
  const runs = useQuery({
    queryKey: ["delegation-runs", selected?.id],
    queryFn: () => listDelegationRuns(selected!.id),
    enabled: selected !== undefined,
  });
  const reports = useQuery({
    queryKey: ["delegation-reports", selected?.id],
    queryFn: () => listDelegationReports(selected!.id),
    enabled: selected !== undefined,
  });
  const confirmations = useQuery({
    queryKey: ["delegation-confirmations", selected?.id],
    queryFn: () => listDelegationConfirmations(selected!.id),
    enabled: selected !== undefined,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["delegations"] });
    if (selected !== undefined) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["delegation-preview", selected.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["delegation-events", selected.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["delegation-runs", selected.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["delegation-reports", selected.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["delegation-confirmations", selected.id],
        }),
      ]);
    }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const payload: CreateDelegationInput = {
        displayName: form.displayName.trim(),
        representativeKind: form.representativeKind,
        workspaceId: form.projectId,
        projectId: form.projectId,
        contextType: form.contextType,
        contextId: form.contextId.trim(),
        objective: form.objective.trim(),
        stance: form.stance.trim(),
        watchItems: form.watchItems
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        materialScopes: form.materialScopes
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        allowedActions: form.allowedActions,
        deniedActions: form.deniedActions,
        approvalPolicy: form.approvalPolicy,
        autoParticipation: form.autoParticipation,
        expiresAt: form.expiresAt,
        reportRequired: form.reportRequired,
        syncMeetingDelegate: form.contextType === "meeting",
        ...(form.representativeKind === "ai"
          ? { representativeAgentId: form.representativeAgentId }
          : { representativePrincipalId: form.representativePrincipalId }),
      };
      const draft = await createDelegation(payload);
      return transitionDelegation(
        draft.id,
        "activate",
        draft.revision,
        "Activated from the Delegation creation wizard",
      );
    },
    onSuccess: async (delegation) => {
      setSelectedId(delegation.id);
      setWizardOpen(false);
      setStep(0);
      await refresh();
    },
  });

  const transitionMutation = useMutation({
    mutationFn: (action: "pause" | "resume" | "complete" | "revoke") =>
      transitionDelegation(
        selected!.id,
        action,
        selected!.revision,
        action === "revoke"
          ? "Owner recalled the Human Avatar"
          : "Owner changed the Delegation lifecycle",
      ),
    onSuccess: async () => refresh(),
  });

  const extendMutation = useMutation({
    mutationFn: () =>
      extendDelegation(selected!.id, {
        expectedRevision: selected!.revision,
        reason: "Owner extended the Delegation",
        expiresAt: new Date(extendValue).toISOString(),
      }),
    onSuccess: async () => {
      setExtendValue("");
      await refresh();
    },
  });

  const dispatchMutation = useMutation({
    mutationFn: () => dispatchDelegation(selected!.id),
    onSuccess: async () => refresh(),
  });

  const reportMutation = useMutation({
    mutationFn: (retry: boolean) =>
      retry
        ? retryDelegationReport(selected!.id)
        : generateDelegationReport(selected!.id),
    onSuccess: async () => refresh(),
  });

  const confirmMutation = useMutation({
    mutationFn: (input: {
      requestId: string;
      decision: "approve" | "reject";
    }) =>
      decideDelegationConfirmation(selected!.id, input.requestId, {
        decision: input.decision,
        reason:
          input.decision === "approve"
            ? "Owner approved the delegated action"
            : "Owner rejected the delegated action",
      }),
    onSuccess: async () => refresh(),
  });

  const filtered = useMemo(() => {
    const items = overview.data?.items ?? [];
    if (filter === "all") return items;
    if (
      filter === "meeting" ||
      filter === "task" ||
      filter === "workflow_instance" ||
      filter === "workflow_node"
    ) {
      return items.filter((item) => item.contextType === filter);
    }
    return items.filter((item) => item.status === filter);
  }, [filter, overview.data?.items]);

  const activeReport = reports.data?.[0];
  const canDispatch =
    selected?.status === "active" &&
    selected.representativeKind === "ai" &&
    (selected.contextType === "task" ||
      selected.contextType === "workflow_instance" ||
      selected.contextType === "workflow_node");

  const toggleAction = (
    key: "allowedActions" | "deniedActions",
    action: DelegationAction,
  ) => {
    setForm((current) => {
      const selectedValues = current[key];
      const next = selectedValues.includes(action)
        ? selectedValues.filter((value) => value !== action)
        : [...selectedValues, action];
      return {
        ...current,
        [key]: next,
        ...(key === "allowedActions" && next.includes(action)
          ? {
              deniedActions: current.deniedActions.filter(
                (value) => value !== action,
              ),
            }
          : {}),
        ...(key === "deniedActions" && next.includes(action)
          ? {
              allowedActions: current.allowedActions.filter(
                (value) => value !== action,
              ),
            }
          : {}),
      };
    });
  };

  return (
    <section className="workspace-view delegation-center">
      <header className="view-header delegation-head">
        <div>
          <span className="eyebrow">Human Avatar</span>
          <h1>委托中心</h1>
          <p>为明确 Task、Workflow 或 Meeting 指定受限代表。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setWizardOpen(true)}
        >
          <Plus size={15} />
          新建委托
        </button>
      </header>

      <div className="delegation-metrics">
        {[
          ["生效中", overview.data?.counts.active ?? 0],
          ["即将到期", overview.data?.counts.expiringSoon ?? 0],
          ["待处理", overview.data?.counts.attention ?? 0],
          ["已暂停", overview.data?.counts.paused ?? 0],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      {wizardOpen ? (
        <section className="delegation-wizard">
          <header>
            <div>
              <span className="eyebrow">创建向导</span>
              <h2>建立一次有边界的代表关系</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              title="关闭创建向导"
              onClick={() => setWizardOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <ol className="delegation-steps">
            {["上下文", "代表", "目标", "权限"].map((label, index) => (
              <li
                key={label}
                className={index === step ? "active" : index < step ? "done" : ""}
              >
                <span>{index < step ? <Check size={12} /> : index + 1}</span>
                {label}
              </li>
            ))}
          </ol>

          <div className="delegation-wizard-body">
            {step === 0 && (
              <div className="form-grid">
                <label>
                  项目
                  <select
                    value={form.projectId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        projectId: event.target.value,
                      }))
                    }
                  >
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  上下文类型
                  <select
                    value={form.contextType}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        contextType: event.target
                          .value as DelegationContextType,
                      }))
                    }
                  >
                    {Object.entries(contextLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-span-2">
                  {form.contextType === "workflow_node"
                    ? "Workflow 实例 ID:节点 ID"
                    : "上下文 ID"}
                  <input
                    value={form.contextId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        contextId: event.target.value,
                      }))
                    }
                    placeholder={
                      form.contextType === "workflow_node"
                        ? "instance-uuid:node-id"
                        : "UUID"
                    }
                  />
                </label>
              </div>
            )}

            {step === 1 && (
              <div className="form-grid">
                <label>
                  代表类型
                  <select
                    value={form.representativeKind}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        representativeKind: event.target.value as
                          | "ai"
                          | "human",
                      }))
                    }
                  >
                    <option value="ai">AI 代表</option>
                    <option value="human">人类代表</option>
                  </select>
                </label>
                {form.representativeKind === "ai" ? (
                  <label>
                    Teammate / Agent
                    <select
                      value={form.representativeAgentId}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          representativeAgentId: event.target.value,
                        }))
                      }
                    >
                      {agents.map((agent) => (
                        <option value={agent.id} key={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    代表 Principal ID
                    <input
                      value={form.representativePrincipalId}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          representativePrincipalId: event.target.value,
                        }))
                      }
                      placeholder="principal-id"
                    />
                  </label>
                )}
                <label className="form-span-2">
                  展示名称
                  <input
                    value={form.displayName}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                    placeholder="例如：Alice 的评审分身"
                  />
                </label>
              </div>
            )}

            {step === 2 && (
              <div className="form-grid">
                <label className="form-span-2">
                  目标
                  <textarea
                    value={form.objective}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        objective: event.target.value,
                      }))
                    }
                    placeholder="说明代表需要在当前上下文中完成什么。"
                  />
                </label>
                <label className="form-span-2">
                  既有立场
                  <textarea
                    value={form.stance}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        stance: event.target.value,
                      }))
                    }
                    placeholder="代表可以表达、但不可自行改变的立场。"
                  />
                </label>
                <label>
                  关注事项
                  <textarea
                    value={form.watchItems}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        watchItems: event.target.value,
                      }))
                    }
                    placeholder="每行一个"
                  />
                </label>
                <label>
                  材料范围
                  <textarea
                    value={form.materialScopes}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        materialScopes: event.target.value,
                      }))
                    }
                    placeholder="每行一个材料标识"
                  />
                </label>
              </div>
            )}

            {step === 3 && (
              <div className="delegation-permission-editor">
                <div>
                  <h3>允许动作</h3>
                  <div className="delegation-action-grid">
                    {actions.map((action) => (
                      <label key={action}>
                        <input
                          type="checkbox"
                          checked={form.allowedActions.includes(action)}
                          onChange={() =>
                            toggleAction("allowedActions", action)
                          }
                          disabled={
                            action === "archive" ||
                            action === "delete" ||
                            ((action === "approve" || action === "reject") &&
                              form.approvalPolicy !== "auto-within-rules")
                          }
                        />
                        <span>{actionLabels[action]}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <h3>明确禁止</h3>
                  <div className="delegation-action-grid">
                    {actions.map((action) => (
                      <label key={action}>
                        <input
                          type="checkbox"
                          checked={form.deniedActions.includes(action)}
                          onChange={() =>
                            toggleAction("deniedActions", action)
                          }
                        />
                        <span>{actionLabels[action]}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="form-grid">
                  <label>
                    审批策略
                    <select
                      value={form.approvalPolicy}
                      onChange={(event) =>
                        setForm((current) => {
                          const approvalPolicy = event.target
                            .value as Delegation["approvalPolicy"];
                          return {
                            ...current,
                            approvalPolicy,
                            allowedActions:
                              approvalPolicy === "auto-within-rules"
                                ? current.allowedActions
                                : current.allowedActions.filter(
                                    (action) =>
                                      action !== "approve" &&
                                      action !== "reject",
                                  ),
                          };
                        })
                      }
                    >
                      <option value="suggest-only">仅建议</option>
                      <option value="require-confirmation">需主人确认</option>
                      <option value="auto-within-rules">规则内自动</option>
                    </select>
                  </label>
                  <label>
                    参与触发
                    <select
                      value={form.autoParticipation}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          autoParticipation: event.target
                            .value as Delegation["autoParticipation"],
                        }))
                      }
                    >
                      <option value="manual">手动</option>
                      <option value="mentions">被提及时</option>
                      <option value="all">全部事件</option>
                    </select>
                  </label>
                  <label>
                    到期时间
                    <input
                      type="datetime-local"
                      value={new Date(form.expiresAt)
                        .toISOString()
                        .slice(0, 16)}
                      onChange={(event) => {
                        if (event.target.value === "") return;
                        setForm((current) => ({
                          ...current,
                          expiresAt: new Date(
                            event.target.value,
                          ).toISOString(),
                        }));
                      }}
                    />
                  </label>
                  <label className="delegation-checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.reportRequired}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          reportRequired: event.target.checked,
                        }))
                      }
                    />
                    完成或召回时生成报告
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="delegation-permission-preview">
            <ShieldCheck size={18} />
            <div>
              <strong>有效权限预览</strong>
              <p>
                可以：{actionSummary(form.allowedActions)}
              </p>
              <p>明确不可：{actionSummary(form.deniedActions)}</p>
            </div>
          </div>

          {createMutation.error && (
            <p className="form-error">{createMutation.error.message}</p>
          )}
          <footer className="delegation-wizard-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={step === 0}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft size={15} />
              上一步
            </button>
            {step < 3 ? (
              <button
                className="primary-button"
                type="button"
                disabled={
                  (step === 0 && form.contextId.trim() === "") ||
                  (step === 1 &&
                    form.displayName.trim() === "" &&
                    form.representativeKind === "human" &&
                    form.representativePrincipalId === "") ||
                  (step === 2 && form.objective.trim() === "")
                }
                onClick={() => setStep((current) => Math.min(3, current + 1))}
              >
                下一步
                <ChevronRight size={15} />
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={
                  createMutation.isPending ||
                  form.displayName.trim() === "" ||
                  form.objective.trim() === "" ||
                  form.contextId.trim() === "" ||
                  (form.representativeKind === "ai"
                    ? form.representativeAgentId === ""
                    : form.representativePrincipalId === "")
                }
                onClick={() => createMutation.mutate()}
              >
                {createMutation.isPending ? "正在创建" : "创建并激活"}
              </button>
            )}
          </footer>
        </section>
      ) : (
        <div className="delegation-layout">
          <aside className="delegation-list-panel">
            <div className="delegation-filter-row">
              {(
                [
                  ["all", "全部"],
                  ["active", "生效中"],
                  ["paused", "已暂停"],
                  ["meeting", "Meeting"],
                  ["task", "Task"],
                  ["workflow_instance", "Workflow"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="delegation-list">
              {filtered.map((delegation) => (
                <button
                  type="button"
                  className={
                    delegation.id === selected?.id ? "active" : undefined
                  }
                  key={delegation.id}
                  onClick={() => setSelectedId(delegation.id)}
                >
                  <span className="delegation-avatar">
                    {delegation.representativeDisplayName.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{delegation.displayName}</strong>
                    <small>
                      {contextLabels[delegation.contextType]} ·{" "}
                      {delegation.representativeDisplayName}
                    </small>
                  </span>
                  <i className={statusClass(delegation.status)}>
                    {statusLabels[delegation.status]}
                  </i>
                </button>
              ))}
              {overview.isSuccess && filtered.length === 0 && (
                <div className="delegation-empty">
                  <UserRoundCheck size={22} />
                  <strong>暂无委托</strong>
                  <span>创建一个明确上下文与权限边界。</span>
                </div>
              )}
            </div>
          </aside>

          <main className="delegation-detail">
            {selected === undefined ? (
              <div className="delegation-empty">
                <UserRoundCheck size={24} />
                <strong>选择一个委托</strong>
                <span>查看权限、运行时间线和报告。</span>
              </div>
            ) : (
              <>
                <header className="delegation-detail-head">
                  <div>
                    <span className={statusClass(selected.status)}>
                      {statusLabels[selected.status]}
                    </span>
                    <h2>{selected.displayName}</h2>
                    <p>
                      {selected.ownerDisplayName} 的受限代表 ·{" "}
                      {selected.representativeDisplayName}
                    </p>
                  </div>
                  <div className="delegation-actions">
                    {selected.status === "active" && (
                      <button
                        className="icon-button"
                        type="button"
                        title="暂停委托"
                        onClick={() => transitionMutation.mutate("pause")}
                      >
                        <CirclePause size={16} />
                      </button>
                    )}
                    {selected.status === "paused" && (
                      <button
                        className="icon-button"
                        type="button"
                        title="恢复委托"
                        onClick={() => transitionMutation.mutate("resume")}
                      >
                        <CirclePlay size={16} />
                      </button>
                    )}
                    {canDispatch && (
                      <button
                        className="icon-button"
                        type="button"
                        title="启动代表运行"
                        onClick={() => dispatchMutation.mutate()}
                      >
                        <Play size={16} />
                      </button>
                    )}
                    {selected.status === "active" && (
                      <button
                        className="icon-button"
                        type="button"
                        title="完成委托"
                        onClick={() => transitionMutation.mutate("complete")}
                      >
                        <Check size={16} />
                      </button>
                    )}
                    {!["revoked", "completed", "expired"].includes(
                      selected.status,
                    ) && (
                      <button
                        className="icon-button danger"
                        type="button"
                        title="召回委托"
                        onClick={() => transitionMutation.mutate("revoke")}
                      >
                        <SquareX size={16} />
                      </button>
                    )}
                  </div>
                </header>

                {transitionMutation.error && (
                  <p className="form-error">
                    {transitionMutation.error.message}
                  </p>
                )}
                {dispatchMutation.error && (
                  <p className="form-error">
                    {dispatchMutation.error.message}
                  </p>
                )}

                <div className="delegation-summary-grid">
                  <div>
                    <span>上下文</span>
                    <strong>{contextLabels[selected.contextType]}</strong>
                    <small>{selected.contextId}</small>
                  </div>
                  <div>
                    <span>到期</span>
                    <strong>{formatDate(selected.expiresAt)}</strong>
                    <small>revision {selected.revision}</small>
                  </div>
                  <div>
                    <span>审批策略</span>
                    <strong>
                      {
                        {
                          "suggest-only": "仅建议",
                          "require-confirmation": "需主人确认",
                          "auto-within-rules": "规则内自动",
                        }[selected.approvalPolicy]
                      }
                    </strong>
                    <small>{selected.autoParticipation}</small>
                  </div>
                </div>

                <section className="delegation-section">
                  <header>
                    <h3>目标与边界</h3>
                  </header>
                  <p className="delegation-objective">{selected.objective}</p>
                  {selected.stance !== "" && (
                    <p className="delegation-note">
                      <strong>既有立场</strong>
                      {selected.stance}
                    </p>
                  )}
                  {selected.watchItems.length > 0 && (
                    <div className="delegation-tags">
                      {selected.watchItems.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                  )}
                </section>

                <section className="delegation-section">
                  <header>
                    <h3>有效权限</h3>
                    <ShieldCheck size={15} />
                  </header>
                  <div className="delegation-permission-columns">
                    <div>
                      <strong>可以</strong>
                      <ul>
                        {(preview.data?.effectiveAllowedActions ?? []).map(
                          (action) => (
                            <li key={action}>{actionLabels[action]}</li>
                          ),
                        )}
                      </ul>
                    </div>
                    <div>
                      <strong>禁止</strong>
                      <ul>
                        {(preview.data?.deniedActions ?? []).map((action) => (
                          <li key={action}>{actionLabels[action]}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {preview.data?.blockedReason !== null &&
                    preview.data?.blockedReason !== undefined && (
                      <p className="delegation-blocked">
                        <AlertTriangle size={14} />
                        {preview.data.blockedReason}
                      </p>
                    )}
                </section>

                {selected.status === "active" && (
                  <section className="delegation-section">
                    <header>
                      <h3>延期</h3>
                      <CalendarClock size={15} />
                    </header>
                    <div className="delegation-inline-form">
                      <input
                        aria-label="新的到期时间"
                        type="datetime-local"
                        value={extendValue}
                        onChange={(event) => setExtendValue(event.target.value)}
                      />
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={
                          extendValue === "" || extendMutation.isPending
                        }
                        onClick={() => extendMutation.mutate()}
                      >
                        延期
                      </button>
                    </div>
                  </section>
                )}

                {confirmations.data !== undefined &&
                  confirmations.data.length > 0 && (
                    <section className="delegation-section">
                      <header>
                        <h3>主人确认</h3>
                      </header>
                      <div className="delegation-confirmations">
                        {confirmations.data.map((request) => (
                          <div key={request.id}>
                            <span className={statusClass(selected.status)}>
                              {request.status}
                            </span>
                            <strong>{actionLabels[request.action]}</strong>
                            <small>
                              {request.targetType}:{request.targetId}
                            </small>
                            {request.status === "pending" && (
                              <div>
                                <button
                                  className="secondary-button"
                                  type="button"
                                  onClick={() =>
                                    confirmMutation.mutate({
                                      requestId: request.id,
                                      decision: "approve",
                                    })
                                  }
                                >
                                  允许
                                </button>
                                <button
                                  className="ghost-button"
                                  type="button"
                                  onClick={() =>
                                    confirmMutation.mutate({
                                      requestId: request.id,
                                      decision: "reject",
                                    })
                                  }
                                >
                                  拒绝
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                <section className="delegation-section">
                  <header>
                    <h3>运行时间线</h3>
                    <span>{runs.data?.length ?? 0} 次运行</span>
                  </header>
                  <div className="delegation-timeline">
                    {(runs.data ?? []).map((run) => (
                      <div key={run.runId}>
                        <span />
                        <strong>{run.status}</strong>
                        <small>{run.runId}</small>
                      </div>
                    ))}
                    {(events.data ?? []).slice(0, 8).map((event) => (
                      <div key={event.id}>
                        <span />
                        <strong>{event.kind}</strong>
                        <small>
                          revision {event.beforeRevision}→{event.afterRevision}
                        </small>
                      </div>
                    ))}
                    {(runs.data?.length ?? 0) === 0 &&
                      (events.data?.length ?? 0) === 0 && (
                        <p className="delegation-muted">暂无运行记录。</p>
                      )}
                  </div>
                </section>

                <section className="delegation-section">
                  <header>
                    <h3>代表报告</h3>
                    <div>
                      {activeReport?.status === "failed" && (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => reportMutation.mutate(true)}
                        >
                          <RefreshCw size={14} />
                          重试
                        </button>
                      )}
                      {activeReport === undefined && (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => reportMutation.mutate(false)}
                        >
                          生成报告
                        </button>
                      )}
                    </div>
                  </header>
                  {activeReport === undefined ? (
                    <p className="delegation-muted">尚无报告。</p>
                  ) : activeReport.status === "failed" ? (
                    <div className="delegation-report-failed">
                      <FileWarning size={18} />
                      <div>
                        <strong>报告生成失败</strong>
                        <p>{activeReport.errorMessage}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="delegation-report">
                      <span>{activeReport.status}</span>
                      <p>{activeReport.summary}</p>
                      {activeReport.keyProcess.length > 0 && (
                        <>
                          <strong>关键过程</strong>
                          <ul>
                            {activeReport.keyProcess.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {activeReport.risks.length > 0 && (
                        <>
                          <strong>风险与反对意见</strong>
                          <ul>
                            {activeReport.risks.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                  {reportMutation.error && (
                    <p className="form-error">{reportMutation.error.message}</p>
                  )}
                </section>

                <footer className="delegation-detail-footer">
                  创建人 {selected.createdBy} · 代表主体{" "}
                  {selected.representativePrincipalId} · 当前用户{" "}
                  {viewerPrincipalId}
                </footer>
              </>
            )}
          </main>
        </div>
      )}
    </section>
  );
}
