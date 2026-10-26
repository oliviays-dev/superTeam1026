import type {
  Agent,
  AgentDetail,
  AgentRuntimePreflightResult,
  CreateAgentInput,
  ExternalRuntime,
  ExternalRuntimeCapabilityName,
  RuntimeKind,
  UpdateAgentInput,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CirclePause,
  CirclePlay,
  Link2,
  LoaderCircle,
  Plus,
  Save,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  ApiRequestError,
  createAgent,
  getAgent,
  getAgentRuntimeBinding,
  listAllAgents,
  listExternalRuntimes,
  preflightAgentRuntime,
  removeAgentRuntimeBinding,
  setAgentStatus,
  setAgentRuntimeBinding,
  updateAgent,
} from "./api.js";
import {
  PreflightFeedback,
  RuntimeBindingSummary,
  runtimeCapabilityLabels,
} from "./ExternalRuntimeObservability.js";

interface AgentFormState {
  name: string;
  description: string;
  soul: string;
  scenarios: string;
  goals: string;
  tools: string;
  runtimeKind: RuntimeKind;
  source: Agent["source"];
}

const emptyForm: AgentFormState = {
  name: "",
  description: "",
  soul: "",
  scenarios: "",
  goals: "",
  tools: "",
  runtimeKind: "fake",
  source: "personal",
};

function splitLines(value: string): string[] {
  return value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formFromAgent(agent: Agent): AgentFormState {
  return {
    name: agent.name,
    description: agent.description,
    soul: agent.soul,
    scenarios: agent.scenarios.join("\n"),
    goals: agent.goals.join("\n"),
    tools: agent.tools.join("\n"),
    runtimeKind: agent.runtimeKind,
    source: agent.source,
  };
}

function inputFromForm(form: AgentFormState): CreateAgentInput {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    soul: form.soul,
    scenarios: splitLines(form.scenarios),
    goals: splitLines(form.goals),
    tools: splitLines(form.tools),
    runtimeKind: form.runtimeKind,
    source: form.source,
  };
}

export interface RuntimePreflightFailureView {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

export function runtimePreflightFailure(
  error: unknown,
): RuntimePreflightFailureView | null {
  if (error === null || error === undefined) return null;
  if (!(error instanceof ApiRequestError) && !(error instanceof Error)) {
    return {
      code: "request_failed",
      message: "Runtime Preflight failed",
      remediation: "Reload the current binding and retry.",
    };
  }
  const details =
    error instanceof ApiRequestError &&
    typeof error.details === "object" &&
    error.details !== null
      ? (error.details as Record<string, unknown>)
      : {};
  const code =
    typeof details.preflightCode === "string"
      ? details.preflightCode
      : error instanceof ApiRequestError
        ? error.code
        : "request_failed";
  const remediation =
    typeof details.remediation === "string"
      ? details.remediation
      : "Review the Runtime status, Probe and Capability requirements, then retry.";
  return {
    code,
    message: error.message,
    remediation,
  };
}

function runtimeReadyForBinding(runtime: ExternalRuntime): boolean {
  return runtime.status === "active" && runtime.lastProbe?.status === "passed";
}

function runtimeOptionLabel(runtime: ExternalRuntime): string {
  const state =
    runtime.status === "archived"
      ? "已归档"
      : runtime.status === "disabled"
        ? "已停用"
        : runtime.lastProbe?.status === "failed"
          ? "Probe 失败"
          : runtime.lastProbe?.status === "passed"
            ? "可用"
            : "待 Probe";
  return `${runtime.name} · ${runtime.protocol} · ${state} · r${runtime.revision}`;
}

function AgentDirectory({
  agents,
  selectedId,
  onSelect,
  onCreate,
}: {
  agents: Agent[];
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const groups = [
    ["personal", "我的 AI 伙伴"],
    ["platform", "平台 AI 伙伴"],
  ] as const;

  return (
    <aside className="pm-panel agent-directory">
      <div className="agent-directory-head">
        <div>
          <strong>AI 伙伴目录</strong>
          <span>
            {agents.filter((agent) => agent.status === "active").length} 位可用
          </span>
        </div>
        <button
          className="pm-icon-btn"
          title="新建 AI 伙伴"
          type="button"
          onClick={onCreate}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="agent-groups">
        {groups.map(([source, label]) => {
          const items = agents.filter((agent) => agent.source === source);
          return (
            <section className="agent-group" key={source}>
              <div className="agent-group-label">
                <span>{label}</span>
                <b>{items.length}</b>
              </div>
              {items.map((agent) => (
                <button
                  className={`agent-list-row ${
                    selectedId === agent.id ? "active" : ""
                  } ${agent.status === "disabled" ? "disabled" : ""}`}
                  key={agent.id}
                  type="button"
                  onClick={() => onSelect(agent.id)}
                >
                  <span className={`agent-avatar ${source}`}>
                    {agent.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="agent-list-copy">
                    <strong>{agent.name}</strong>
                    <small>
                      {agent.runtimeKind} · v{agent.version}
                    </small>
                  </span>
                  <i
                    className={`agent-state-dot ${
                      agent.status === "active" ? "active" : ""
                    }`}
                  />
                </button>
              ))}
              {items.length === 0 && (
                <div className="agent-group-empty">暂无 AI 伙伴</div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

export function AgentsView() {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents", "all"],
    queryFn: listAllAgents,
  });
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentFormState>(emptyForm);
  const selectedAgentId = selectedId || agentsQuery.data?.[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["agent", selectedAgentId],
    queryFn: () => getAgent(selectedAgentId),
    enabled: selectedAgentId !== "" && !creating,
  });
  const bindingQuery = useQuery({
    queryKey: ["agent-runtime-binding", selectedAgentId],
    queryFn: () => getAgentRuntimeBinding(selectedAgentId),
    enabled: selectedAgentId !== "" && !creating,
  });
  const runtimeOptionsQuery = useQuery({
    queryKey: ["external-runtimes", "binding-options"],
    queryFn: () => listExternalRuntimes(true),
    enabled: !creating,
  });
  const detail = creating ? undefined : detailQuery.data;
  const bindingDetail = creating ? undefined : bindingQuery.data;
  const [bindingRuntimeId, setBindingRuntimeId] = useState("");
  const [bindingModel, setBindingModel] = useState("");
  const [preflightWorkspaceId, setPreflightWorkspaceId] =
    useState("agent/preflight");
  const [requiredCapabilities, setRequiredCapabilities] = useState<
    ExternalRuntimeCapabilityName[]
  >([]);
  const [preflightResult, setPreflightResult] =
    useState<AgentRuntimePreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<unknown>(null);

  useEffect(() => {
    if (detail !== undefined) setForm(formFromAgent(detail.agent));
  }, [detail]);

  useEffect(() => {
    if (bindingDetail === undefined) return;
    setBindingRuntimeId(bindingDetail.runtime?.id ?? "");
    setBindingModel(
      bindingDetail.runtime?.defaultModel ??
        bindingDetail.runtime?.supportedModels[0] ??
        "",
    );
    setPreflightResult(null);
    setPreflightError(null);
  }, [bindingDetail]);

  useEffect(() => {
    if (!creating && selectedId === "" && agentsQuery.data?.[0] !== undefined) {
      setSelectedId(agentsQuery.data[0].id);
    }
  }, [agentsQuery.data, creating, selectedId]);

  const refresh = async (agent: Agent) => {
    await queryClient.invalidateQueries({ queryKey: ["agents"] });
    await queryClient.invalidateQueries({ queryKey: ["agent", agent.id] });
    setSelectedId(agent.id);
  };
  const createMutation = useMutation({
    mutationFn: () => createAgent(inputFromForm(form)),
    onSuccess: async (agent) => {
      setCreating(false);
      await refresh(agent);
    },
  });
  const updateMutation = useMutation({
    mutationFn: () => {
      if (detail === undefined) throw new Error("没有可保存的 AI 伙伴");
      const patch: UpdateAgentInput = {
        ...inputFromForm(form),
        expectedVersion: detail.agent.version,
      };
      return updateAgent(detail.agent.id, patch);
    },
    onSuccess: (updated: AgentDetail) => refresh(updated.agent),
  });
  const statusMutation = useMutation({
    mutationFn: (agent: Agent) =>
      setAgentStatus(
        agent.id,
        agent.status === "active" ? "disabled" : "active",
      ),
    onSuccess: (updated: AgentDetail) => refresh(updated.agent),
  });
  const bindMutation = useMutation({
    mutationFn: () => {
      if (selectedAgent === undefined) {
        throw new Error("没有可绑定的 AI 伙伴");
      }
      if (bindingRuntimeId === "") {
        throw new Error("请选择外部 Runtime");
      }
      const expectedRevision =
        bindingDetail?.binding?.status === "active"
          ? bindingDetail.binding.revision
          : 0;
      return setAgentRuntimeBinding(selectedAgent.id, {
        runtimeId: bindingRuntimeId,
        expectedRevision,
      });
    },
    onSuccess: async () => {
      setPreflightResult(null);
      setPreflightError(null);
      await queryClient.invalidateQueries({
        queryKey: ["agent-runtime-binding", selectedAgentId],
      });
      await queryClient.invalidateQueries({ queryKey: ["external-runtimes"] });
    },
  });
  const unbindMutation = useMutation({
    mutationFn: () => {
      if (selectedAgent === undefined) {
        throw new Error("没有可解绑的 AI 伙伴");
      }
      if (bindingDetail?.binding?.status !== "active") {
        throw new Error("当前没有活动的 Runtime Binding");
      }
      return removeAgentRuntimeBinding(
        selectedAgent.id,
        bindingDetail.binding.revision,
      );
    },
    onSuccess: async () => {
      setPreflightResult(null);
      setPreflightError(null);
      await queryClient.invalidateQueries({
        queryKey: ["agent-runtime-binding", selectedAgentId],
      });
      await queryClient.invalidateQueries({ queryKey: ["external-runtimes"] });
    },
  });
  const preflightMutation = useMutation({
    mutationFn: () => {
      if (selectedAgent === undefined) {
        throw new Error("没有可检查的 AI 伙伴");
      }
      const currentRuntime =
        bindingDetail?.runtime?.id === bindingRuntimeId
          ? bindingDetail.runtime
          : runtimeOptionsQuery.data?.find(
              (runtime) => runtime.id === bindingRuntimeId,
            );
      return preflightAgentRuntime(selectedAgent.id, {
        expectedRevision: bindingDetail?.binding?.revision ?? 1,
        workspaceId: preflightWorkspaceId.trim() || "agent/preflight",
        ...(bindingModel.trim() === "" ? {} : { model: bindingModel.trim() }),
        requiredCapabilities,
        ...(currentRuntime === undefined
          ? {}
          : {
              requiredSandboxMode: currentRuntime.sandboxMode,
              requiredNetworkMode: currentRuntime.networkMode,
            }),
      });
    },
    onMutate: () => {
      setPreflightResult(null);
      setPreflightError(null);
    },
    onSuccess: (result) => {
      setPreflightResult(result);
      setPreflightError(null);
    },
    onError: (error) => {
      setPreflightResult(null);
      setPreflightError(error);
    },
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    statusMutation.isPending ||
    bindMutation.isPending ||
    unbindMutation.isPending ||
    preflightMutation.isPending;
  const error =
    createMutation.error ?? updateMutation.error ?? statusMutation.error;
  const selectedAgent = detail?.agent;
  const allRuntimes = runtimeOptionsQuery.data ?? [];
  const currentBindingRuntime = bindingDetail?.runtime;
  const availableRuntimeChoices = allRuntimes.filter(
    (runtime) =>
      runtimeReadyForBinding(runtime) ||
      runtime.id === currentBindingRuntime?.id,
  );
  const selectedRuntime = allRuntimes.find(
    (runtime) => runtime.id === bindingRuntimeId,
  );
  const selectedRuntimeReady =
    selectedRuntime !== undefined && runtimeReadyForBinding(selectedRuntime);
  const currentBindingActive = bindingDetail?.binding?.status === "active";
  const sameRuntimeActive =
    currentBindingActive &&
    bindingDetail?.binding?.runtimeId === bindingRuntimeId;
  const preflightFailure = runtimePreflightFailure(preflightError);
  const bindingActionError =
    bindMutation.error ?? unbindMutation.error ?? bindingQuery.error;

  useEffect(() => {
    if (
      bindingRuntimeId === "" &&
      bindingDetail !== undefined &&
      bindingDetail.binding === null
    ) {
      const first = allRuntimes.find(runtimeReadyForBinding);
      if (first !== undefined) setBindingRuntimeId(first.id);
    }
  }, [allRuntimes, bindingDetail, bindingRuntimeId]);

  useEffect(() => {
    const models = selectedRuntime?.supportedModels ?? [];
    if (models.length > 0 && !models.includes(bindingModel)) {
      setBindingModel(selectedRuntime?.defaultModel ?? models[0] ?? "");
    }
    if (models.length === 0 && bindingModel !== "") {
      setBindingModel("");
    }
  }, [bindingModel, selectedRuntime]);

  return (
    <main className="pm-page">
      <header className="pm-page-head">
        <div>
          <h1>AI 伙伴</h1>
          <p>维护 Agent 身份、SOUL、工作场景、目标和可用工具。</p>
        </div>
        <button
          className="pm-btn primary"
          type="button"
          onClick={() => {
            setCreating(true);
            setForm(emptyForm);
          }}
        >
          <Plus size={14} />
          新建 AI 伙伴
        </button>
      </header>

      <div className="pm-two-column agent-layout">
        <AgentDirectory
          agents={agentsQuery.data ?? []}
          selectedId={creating ? "" : selectedAgentId}
          onSelect={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
          onCreate={() => {
            setCreating(true);
            setForm(emptyForm);
          }}
        />

        <section className="pm-panel agent-editor">
          <div className="agent-editor-head">
            <span className="agent-editor-avatar">
              {creating ? <Sparkles size={20} /> : <Bot size={20} />}
            </span>
            <div>
              <h2>
                {creating ? "新建 AI 伙伴" : (selectedAgent?.name ?? "AI 伙伴")}
              </h2>
              <p>
                {creating
                  ? "创建后即可在任务和会议中选择"
                  : `${selectedAgent?.runtimeKind ?? ""} · v${selectedAgent?.version ?? "-"}`}
              </p>
            </div>
            {!creating && selectedAgent !== undefined && (
              <button
                className="pm-btn secondary agent-status-action"
                type="button"
                disabled={busy}
                onClick={() => statusMutation.mutate(selectedAgent)}
              >
                {selectedAgent.status === "active" ? (
                  <CirclePause size={14} />
                ) : (
                  <CirclePlay size={14} />
                )}
                {selectedAgent.status === "active" ? "停用" : "启用"}
              </button>
            )}
          </div>

          {error !== null && (
            <div className="pm-error">
              {error instanceof Error ? error.message : "操作失败"}
            </div>
          )}

          {!creating && detailQuery.isLoading ? (
            <div className="pm-empty">
              <LoaderCircle className="spin" size={18} />
              加载 AI 伙伴...
            </div>
          ) : (
            <form
              className="agent-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (form.name.trim() === "" || busy) return;
                if (creating) createMutation.mutate();
                else updateMutation.mutate();
              }}
            >
              <div className="pm-form-grid">
                <label className="pm-field">
                  <span>名称</span>
                  <input
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                    placeholder="例如：供应链研究伙伴"
                  />
                </label>
                <label className="pm-field">
                  <span>Runtime</span>
                  <select
                    value={form.runtimeKind}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        runtimeKind: event.target.value as RuntimeKind,
                      })
                    }
                  >
                    <option value="fake">fake</option>
                    <option value="dsh-sdk">dsh-sdk</option>
                    <option value="plain-text">plain-text</option>
                    <option value="codex-jsonl">codex-jsonl</option>
                  </select>
                </label>
                <label className="pm-field">
                  <span>归属</span>
                  <select
                    value={form.source}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        source: event.target.value as Agent["source"],
                      })
                    }
                  >
                    <option value="personal">个人</option>
                    <option value="platform">平台</option>
                  </select>
                </label>
                <label className="pm-field pm-field-wide">
                  <span>基础说明</span>
                  <textarea
                    rows={2}
                    value={form.description}
                    onChange={(event) =>
                      setForm({ ...form, description: event.target.value })
                    }
                    placeholder="说明这位 AI 伙伴的职责与边界"
                  />
                </label>
                <label className="pm-field pm-field-wide">
                  <span>SOUL</span>
                  <textarea
                    className="agent-soul-input"
                    rows={8}
                    value={form.soul}
                    onChange={(event) =>
                      setForm({ ...form, soul: event.target.value })
                    }
                    placeholder="定义身份、原则、表达方式和工作边界"
                  />
                </label>
                <label className="pm-field">
                  <span>工作场景</span>
                  <textarea
                    rows={5}
                    value={form.scenarios}
                    onChange={(event) =>
                      setForm({ ...form, scenarios: event.target.value })
                    }
                    placeholder={"每行一个场景\n供应商风险分析"}
                  />
                </label>
                <label className="pm-field">
                  <span>工作目标</span>
                  <textarea
                    rows={5}
                    value={form.goals}
                    onChange={(event) =>
                      setForm({ ...form, goals: event.target.value })
                    }
                    placeholder={"每行一个目标\n给出可核验的结论"}
                  />
                </label>
                <label className="pm-field pm-field-wide">
                  <span>可用工具</span>
                  <textarea
                    rows={3}
                    value={form.tools}
                    onChange={(event) =>
                      setForm({ ...form, tools: event.target.value })
                    }
                    placeholder={"每行一个工具\nweb.search\nfile.read"}
                  />
                </label>
              </div>

              <div className="agent-form-actions">
                <span>
                  {creating
                    ? "新定义将从 v1 开始"
                    : selectedAgent === undefined
                      ? "定义加载中"
                      : `最后更新 ${formatDateTime(selectedAgent.updatedAt)}`}
                </span>
                <button
                  className="pm-btn primary"
                  type="submit"
                  disabled={busy || form.name.trim() === ""}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Save size={14} />
                  )}
                  保存定义
                </button>
              </div>
            </form>
          )}

          {!creating && selectedAgent !== undefined && (
            <section
              className="agent-runtime-binding"
              aria-label="AI 伙伴外部 Runtime"
            >
              <div className="pm-section-head agent-runtime-binding-head">
                <div>
                  <h3>外部 Runtime Binding</h3>
                  <span>
                    Binding、revision 与 Preflight 独立于 Agent.runtime_kind
                  </span>
                </div>
                <ShieldCheck size={16} />
              </div>

              {bindingQuery.isLoading ? (
                <div className="pm-empty">
                  <LoaderCircle className="spin" size={16} />
                  加载 Runtime Binding...
                </div>
              ) : bindingDetail === undefined ? (
                <div className="runtime-binding-reason">
                  无法读取 Binding。请检查 Runtime 可见范围与当前操作者权限。
                </div>
              ) : (
                <>
                  <RuntimeBindingSummary
                    detail={bindingDetail}
                    runtimeKind={selectedAgent.runtimeKind}
                  />
                  {bindingActionError !== null && (
                    <div className="pm-error" role="alert">
                      <TriangleAlert size={14} />
                      {bindingActionError instanceof Error
                        ? bindingActionError.message
                        : "Runtime Binding 操作失败"}
                    </div>
                  )}
                  <div className="agent-runtime-binding-controls">
                    <label className="pm-field">
                      <span>外部 Runtime</span>
                      <select
                        aria-label="外部 Runtime"
                        value={bindingRuntimeId}
                        onChange={(event) =>
                          setBindingRuntimeId(event.target.value)
                        }
                      >
                        <option value="">
                          选择 active 且 Probe 通过的 Runtime
                        </option>
                        {availableRuntimeChoices.map((runtime) => (
                          <option value={runtime.id} key={runtime.id}>
                            {runtimeOptionLabel(runtime)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="pm-field">
                      <span>模型</span>
                      {(selectedRuntime?.supportedModels.length ?? 0) > 0 ? (
                        <select
                          aria-label="外部 Runtime 模型"
                          value={bindingModel}
                          onChange={(event) =>
                            setBindingModel(event.target.value)
                          }
                        >
                          {selectedRuntime?.supportedModels.map((model) => (
                            <option value={model} key={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label="外部 Runtime 模型"
                          value="plain-text 无模型参数"
                          readOnly
                        />
                      )}
                    </label>
                    <div className="agent-runtime-binding-actions">
                      <button
                        className="pm-btn primary"
                        type="button"
                        disabled={
                          busy ||
                          selectedAgent.status !== "active" ||
                          bindingRuntimeId === "" ||
                          !selectedRuntimeReady ||
                          sameRuntimeActive
                        }
                        onClick={() => bindMutation.mutate()}
                      >
                        {bindMutation.isPending ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Link2 size={14} />
                        )}
                        {currentBindingActive ? "重新绑定" : "绑定 Runtime"}
                      </button>
                      <button
                        className="pm-btn secondary"
                        type="button"
                        disabled={busy || !currentBindingActive}
                        onClick={() => unbindMutation.mutate()}
                      >
                        {unbindMutation.isPending ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Unlink size={14} />
                        )}
                        解绑
                      </button>
                    </div>
                  </div>
                  {availableRuntimeChoices.length === 0 &&
                    bindingDetail.binding === null && (
                      <p className="runtime-capability-note">
                        暂无其他可用于绑定的 Runtime。请先在运行时页面完成 Probe
                        并启用。
                      </p>
                    )}

                  <div className="agent-preflight">
                    <div className="pm-section-head">
                      <div>
                        <h3>Preflight</h3>
                        <span>只读检查，不创建 Run、Job 或外部进程</span>
                      </div>
                      <ScanSearch size={15} />
                    </div>
                    <div className="agent-preflight-grid">
                      <label className="pm-field pm-field-wide">
                        <span>Workspace 标识</span>
                        <input
                          aria-label="Preflight Workspace"
                          value={preflightWorkspaceId}
                          onChange={(event) =>
                            setPreflightWorkspaceId(event.target.value)
                          }
                          placeholder="agent/preflight"
                        />
                      </label>
                      <fieldset className="agent-preflight-capabilities pm-field-wide">
                        <legend>要求 Capability</legend>
                        {(
                          Object.entries(runtimeCapabilityLabels) as Array<
                            [ExternalRuntimeCapabilityName, string]
                          >
                        ).map(([name, label]) => (
                          <label key={name}>
                            <input
                              type="checkbox"
                              aria-label={`要求 ${label}`}
                              checked={requiredCapabilities.includes(name)}
                              onChange={(event) => {
                                setRequiredCapabilities(
                                  event.target.checked
                                    ? [...requiredCapabilities, name]
                                    : requiredCapabilities.filter(
                                        (candidate) => candidate !== name,
                                      ),
                                );
                                setPreflightResult(null);
                                setPreflightError(null);
                              }}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </fieldset>
                      <div className="agent-preflight-actions pm-field-wide">
                        <span>
                          {selectedRuntime === undefined
                            ? "未选择 Runtime"
                            : `${selectedRuntime.sandboxMode} · ${selectedRuntime.networkMode} · ${selectedRuntime.protocol}`}
                        </span>
                        <button
                          className="pm-btn secondary"
                          type="button"
                          disabled={
                            busy ||
                            selectedAgent.status !== "active" ||
                            selectedRuntime === undefined ||
                            !selectedRuntimeReady
                          }
                          onClick={() => preflightMutation.mutate()}
                        >
                          {preflightMutation.isPending ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <ScanSearch size={14} />
                          )}
                          运行 Preflight
                        </button>
                      </div>
                    </div>
                    <PreflightFeedback
                      result={preflightResult}
                      failure={preflightFailure}
                    />
                  </div>
                </>
              )}
            </section>
          )}

          {detail !== undefined && detail.events.length > 0 && (
            <section className="agent-activity">
              <div className="pm-section-head">
                <h3>最近活动</h3>
                <span>{detail.events.length} 条</span>
              </div>
              <div className="agent-activity-list">
                {detail.events.slice(0, 8).map((event) => (
                  <div className="agent-activity-row" key={event.id}>
                    <time>{formatDateTime(event.createdAt)}</time>
                    <span>{event.message}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
