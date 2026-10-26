import {
  Archive,
  Check,
  CirclePause,
  CirclePlay,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  CreateExternalRuntimeInput,
  ExternalRuntime,
  ExternalRuntimeCapabilityName,
  ExternalRuntimeCapabilitySet,
  ExternalRuntimeNetworkMode,
  ExternalRuntimeProtocol,
  ExternalRuntimeProvider,
  ExternalRuntimeSandboxMode,
  ExternalRuntimeVisibility,
  RuntimeToolName,
  UpdateExternalRuntimeInput,
} from "@pluginmax/contracts";
import { externalRuntimeCapabilityNames } from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import {
  createExternalRuntime,
  getExternalRuntime,
  listExternalRuntimeCapabilities,
  listExternalRuntimeEvents,
  listExternalRuntimes,
  probeExternalRuntime,
  transitionExternalRuntime,
  updateExternalRuntime,
} from "./api.js";

interface RuntimeFormState {
  name: string;
  provider: ExternalRuntimeProvider;
  protocol: ExternalRuntimeProtocol;
  command: string;
  managedArgs: string;
  customArgs: string;
  supportedModels: string;
  defaultModel: string;
  contextWindowTokens: string;
  supportedTools: RuntimeToolName[];
  networkMode: ExternalRuntimeNetworkMode;
  sandboxMode: ExternalRuntimeSandboxMode;
  visibility: ExternalRuntimeVisibility;
}

const runtimeTools: ReadonlyArray<{
  value: RuntimeToolName;
  label: string;
}> = [
  { value: "web_search", label: "搜索" },
  { value: "web_fetch", label: "网页读取" },
  { value: "read_file", label: "读取文件" },
  { value: "write_file", label: "写入文件" },
  { value: "run_command", label: "命令" },
  { value: "browser", label: "浏览器" },
  { value: "mcp", label: "MCP" },
  { value: "session_resume", label: "会话恢复" },
  { value: "structured_plan", label: "结构化计划" },
  { value: "structured_tool_events", label: "结构化工具事件" },
  { value: "structured_subagent", label: "子 Agent" },
];

const capabilityLabels: Record<ExternalRuntimeCapabilityName, string> = {
  search: "搜索",
  network: "网络",
  fileRead: "读取文件",
  fileWrite: "写入文件",
  shell: "命令",
  browser: "浏览器",
  mcp: "MCP",
  sessionResume: "会话恢复",
  structuredPlan: "结构化计划",
  structuredToolEvents: "工具事件",
  structuredSubagent: "子 Agent",
};

const emptyForm: RuntimeFormState = {
  name: "",
  provider: "codex",
  protocol: "codex-jsonl",
  command: "codex",
  managedArgs: "",
  customArgs: "",
  supportedModels: "",
  defaultModel: "",
  contextWindowTokens: "128000",
  supportedTools: [],
  networkMode: "unknown",
  sandboxMode: "read-only",
  visibility: "owner",
};

function splitTokens(value: string): string[] {
  return value
    .split("\n")
    .map((token) => token.trim())
    .filter(Boolean);
}

function splitModels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\n|,/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

function protocolForProvider(
  provider: ExternalRuntimeProvider,
): ExternalRuntimeProtocol {
  return provider === "codex" ? "codex-jsonl" : "plain-text";
}

function formFromRuntime(runtime: ExternalRuntime): RuntimeFormState {
  return {
    name: runtime.name,
    provider: runtime.provider,
    protocol: runtime.protocol,
    command: runtime.command,
    managedArgs: runtime.managedArgs.join("\n"),
    customArgs: runtime.customArgs.join("\n"),
    supportedModels: runtime.supportedModels.join("\n"),
    defaultModel: runtime.defaultModel ?? "",
    contextWindowTokens:
      runtime.contextWindowTokens === null
        ? ""
        : String(runtime.contextWindowTokens),
    supportedTools: runtime.supportedTools,
    networkMode: runtime.networkMode,
    sandboxMode: runtime.sandboxMode,
    visibility: runtime.visibility,
  };
}

function inputFromForm(
  form: RuntimeFormState,
): CreateExternalRuntimeInput {
  return {
    name: form.name.trim(),
    provider: form.provider,
    protocol: form.protocol,
    command: form.command.trim(),
    managedArgs: splitTokens(form.managedArgs),
    customArgs: splitTokens(form.customArgs),
    supportedModels: splitModels(form.supportedModels),
    defaultModel: form.defaultModel.trim() || null,
    contextWindowTokens:
      form.contextWindowTokens.trim() === ""
        ? null
        : Number(form.contextWindowTokens),
    supportedTools: form.supportedTools,
    networkMode: form.networkMode,
    sandboxMode: form.sandboxMode,
    visibility: form.visibility,
  };
}

function updateFromForm(
  form: RuntimeFormState,
  runtime: ExternalRuntime,
): UpdateExternalRuntimeInput {
  return {
    ...inputFromForm(form),
    expectedRevision: runtime.revision,
  };
}

function statusLabel(status: ExternalRuntime["status"]): string {
  if (status === "active") return "已启用";
  if (status === "archived") return "已归档";
  return "已停用";
}

function probeLabel(runtime: ExternalRuntime): string {
  const probe = runtime.lastProbe;
  if (probe === null) return "未探测";
  if (probe.status === "requested") return "排队中";
  if (probe.status === "running") return "探测中";
  return probe.status === "passed" ? "Probe 通过" : "Probe 失败";
}

function capabilityTone(state: string): string {
  if (state === "supported") return "supported";
  if (state === "unsupported") return "unsupported";
  return "unknown";
}

function CapabilityGrid({
  profile,
}: {
  profile: ExternalRuntimeCapabilitySet;
}) {
  return (
    <div className="runtime-capability-grid">
      {externalRuntimeCapabilityNames.map((name) => (
        <div
          className={`runtime-capability ${capabilityTone(profile[name])}`}
          key={name}
        >
          <span>{capabilityLabels[name]}</span>
          <strong>
            {profile[name] === "supported"
              ? "支持"
              : profile[name] === "unsupported"
                ? "不支持"
                : "未知"}
          </strong>
        </div>
      ))}
    </div>
  );
}

function RuntimeDirectory({
  runtimes,
  selectedId,
  includeArchived,
  onIncludeArchived,
  onSelect,
  onCreate,
}: {
  runtimes: ExternalRuntime[];
  selectedId: string;
  includeArchived: boolean;
  onIncludeArchived: (value: boolean) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="pm-panel runtime-directory">
      <div className="runtime-directory-head">
        <div>
          <strong>运行时目录</strong>
          <span>{runtimes.length} 个定义</span>
        </div>
        <button
          className="pm-icon-btn"
          type="button"
          title="新建运行时"
          onClick={onCreate}
        >
          <Plus size={15} />
        </button>
      </div>
      <label className="runtime-filter">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => onIncludeArchived(event.target.checked)}
        />
        <span>显示已归档</span>
      </label>
      <div className="runtime-list">
        {runtimes.map((runtime) => (
          <button
            className={`runtime-list-row ${
              selectedId === runtime.id ? "active" : ""
            }`}
            key={runtime.id}
            type="button"
            onClick={() => onSelect(runtime.id)}
          >
            <span className="runtime-list-icon">
              <SquareTerminal size={16} />
            </span>
            <span className="runtime-list-copy">
              <strong>{runtime.name}</strong>
              <small>
                {runtime.provider} · {runtime.protocol}
              </small>
            </span>
            <span className={`runtime-state ${runtime.status}`}>
              {statusLabel(runtime.status)}
            </span>
            <span className={`runtime-probe-state ${capabilityTone(
              runtime.lastProbe?.status === "passed"
                ? "supported"
                : runtime.lastProbe?.status === "failed"
                  ? "unsupported"
                  : "unknown",
            )}`}>
              {probeLabel(runtime)}
            </span>
          </button>
        ))}
        {runtimes.length === 0 && (
          <div className="pm-empty">暂无运行时</div>
        )}
      </div>
    </aside>
  );
}

export function RuntimesView() {
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RuntimeFormState>(emptyForm);
  const runtimesQuery = useQuery({
    queryKey: ["external-runtimes", includeArchived],
    queryFn: () => listExternalRuntimes(includeArchived),
  });
  const selectedRuntimeId =
    selectedId || runtimesQuery.data?.[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["external-runtime", selectedRuntimeId],
    queryFn: () => getExternalRuntime(selectedRuntimeId),
    enabled: selectedRuntimeId !== "" && !creating,
    refetchInterval: (query) => {
      const status = query.state.data?.latestProbe?.status;
      return status === "requested" || status === "running" ? 1_500 : false;
    },
  });
  const eventsQuery = useQuery({
    queryKey: ["external-runtime-events", selectedRuntimeId],
    queryFn: () => listExternalRuntimeEvents(selectedRuntimeId),
    enabled: selectedRuntimeId !== "" && !creating,
  });
  const capabilitiesQuery = useQuery({
    queryKey: ["external-runtime-capabilities", selectedRuntimeId],
    queryFn: () => listExternalRuntimeCapabilities(selectedRuntimeId),
    enabled: selectedRuntimeId !== "" && !creating,
    refetchInterval: () => {
      const status = detailQuery.data?.latestProbe?.status;
      return status === "requested" || status === "running" ? 1_500 : false;
    },
  });
  const detail = creating ? undefined : detailQuery.data;
  const selectedRuntime = detail?.runtime;

  useEffect(() => {
    if (selectedRuntime !== undefined) {
      setForm(formFromRuntime(selectedRuntime));
    }
  }, [selectedRuntime]);

  useEffect(() => {
    const status = detail?.latestProbe?.status;
    if (status !== "passed" && status !== "failed") return;
    void queryClient.invalidateQueries({
      queryKey: ["external-runtime-events", selectedRuntimeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["external-runtime-capabilities", selectedRuntimeId],
    });
  }, [
    detail?.latestProbe?.status,
    queryClient,
    selectedRuntimeId,
  ]);

  useEffect(() => {
    if (
      !creating &&
      selectedId === "" &&
      runtimesQuery.data?.[0] !== undefined
    ) {
      setSelectedId(runtimesQuery.data[0].id);
    }
  }, [creating, runtimesQuery.data, selectedId]);

  const refresh = async (runtime: ExternalRuntime) => {
    setSelectedId(runtime.id);
    await queryClient.invalidateQueries({ queryKey: ["external-runtimes"] });
    await queryClient.invalidateQueries({
      queryKey: ["external-runtime", runtime.id],
    });
    await queryClient.invalidateQueries({
      queryKey: ["external-runtime-events", runtime.id],
    });
    await queryClient.invalidateQueries({
      queryKey: ["external-runtime-capabilities", runtime.id],
    });
  };

  const createMutation = useMutation({
    mutationFn: () => createExternalRuntime(inputFromForm(form)),
    onSuccess: async (runtime) => {
      setCreating(false);
      await refresh(runtime);
    },
  });
  const updateMutation = useMutation({
    mutationFn: () => {
      if (selectedRuntime === undefined) {
        throw new Error("没有可保存的运行时");
      }
      return updateExternalRuntime(
        selectedRuntime.id,
        updateFromForm(form, selectedRuntime),
      );
    },
    onSuccess: (runtime) => refresh(runtime),
  });
  const probeMutation = useMutation({
    mutationFn: () => {
      if (selectedRuntime === undefined) {
        throw new Error("没有可探测的运行时");
      }
      return probeExternalRuntime(
        selectedRuntime.id,
        selectedRuntime.revision,
      );
    },
    onSuccess: (result) => refresh(result.runtime),
  });
  const transitionMutation = useMutation({
    mutationFn: (
      transition: "enable" | "disable" | "archive" | "restore",
    ) => {
      if (selectedRuntime === undefined) {
        throw new Error("没有可操作的运行时");
      }
      return transitionExternalRuntime(
        selectedRuntime.id,
        transition,
        selectedRuntime.revision,
      );
    },
    onSuccess: (runtime) => refresh(runtime),
  });

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    probeMutation.isPending ||
    transitionMutation.isPending;
  const error =
    createMutation.error ??
    updateMutation.error ??
    probeMutation.error ??
    transitionMutation.error ??
    detailQuery.error;
  const latestProbe = detail?.latestProbe ?? null;
  const latestCapabilities = capabilitiesQuery.data?.[0];

  return (
    <main className="pm-page runtime-page">
      <header className="pm-page-head">
        <div>
          <h1>运行时</h1>
          <p>维护外部 CLI 定义、能力上限、探测状态和治理记录。</p>
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
          新建运行时
        </button>
      </header>

      <div className="runtime-layout">
        <RuntimeDirectory
          runtimes={runtimesQuery.data ?? []}
          selectedId={creating ? "" : selectedRuntimeId}
          includeArchived={includeArchived}
          onIncludeArchived={(value) => {
            setIncludeArchived(value);
            setSelectedId("");
          }}
          onSelect={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
          onCreate={() => {
            setCreating(true);
            setForm(emptyForm);
          }}
        />

        <section className="pm-panel runtime-editor">
          <div className="runtime-editor-head">
            <span className="runtime-editor-mark">
              {creating ? <Plus size={20} /> : <SquareTerminal size={20} />}
            </span>
            <div>
              <h2>
                {creating
                  ? "新建运行时"
                  : (selectedRuntime?.name ?? "运行时")}
              </h2>
              <p>
                {creating
                  ? "保存后默认为停用状态"
                  : selectedRuntime === undefined
                    ? "运行时加载中"
                    : `${statusLabel(selectedRuntime.status)} · revision ${selectedRuntime.revision} · ${probeLabel(selectedRuntime)}`}
              </p>
            </div>
            {!creating && selectedRuntime !== undefined && (
              <div className="runtime-actions">
                {selectedRuntime.status !== "archived" && (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    title="运行异步 Probe"
                    disabled={busy}
                    onClick={() => probeMutation.mutate()}
                  >
                    {probeMutation.isPending ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Probe
                  </button>
                )}
                {selectedRuntime.status === "active" ? (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => transitionMutation.mutate("disable")}
                  >
                    <CirclePause size={14} />
                    停用
                  </button>
                ) : selectedRuntime.status === "disabled" ? (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => transitionMutation.mutate("enable")}
                  >
                    <CirclePlay size={14} />
                    启用
                  </button>
                ) : (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => transitionMutation.mutate("restore")}
                  >
                    <RotateCcw size={14} />
                    复原
                  </button>
                )}
                {selectedRuntime.status !== "archived" && (
                  <button
                    className="pm-btn danger"
                    type="button"
                    title="归档运行时"
                    disabled={busy}
                    onClick={() => transitionMutation.mutate("archive")}
                  >
                    <Archive size={14} />
                  </button>
                )}
              </div>
            )}
          </div>

          {error !== null && (
            <div className="pm-error">
              <TriangleAlert size={14} />
              {error instanceof Error ? error.message : "操作失败"}
            </div>
          )}

          {!creating && detailQuery.isLoading ? (
            <div className="pm-empty">
              <LoaderCircle className="spin" size={18} />
              加载运行时...
            </div>
          ) : (
            <form
              className="runtime-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || form.name.trim() === "") return;
                if (creating) createMutation.mutate();
                else updateMutation.mutate();
              }}
            >
              <div className="pm-form-grid runtime-form-grid">
                <label className="pm-field" htmlFor="runtime-name">
                  <span>名称</span>
                  <input
                    id="runtime-name"
                    value={form.name}
                    onChange={(event) =>
                      setForm({ ...form, name: event.target.value })
                    }
                    placeholder="例如：Codex CLI"
                  />
                </label>
                <label className="pm-field" htmlFor="runtime-provider">
                  <span>Provider</span>
                  <select
                    id="runtime-provider"
                    value={form.provider}
                    onChange={(event) => {
                      const provider = event.target
                        .value as ExternalRuntimeProvider;
                      setForm({
                        ...form,
                        provider,
                        protocol: protocolForProvider(provider),
                      });
                    }}
                  >
                    <option value="codex">codex</option>
                    <option value="workbuddy">workbuddy</option>
                    <option value="command">command</option>
                  </select>
                </label>
                <label className="pm-field" htmlFor="runtime-protocol">
                  <span>Protocol</span>
                  <select
                    id="runtime-protocol"
                    value={form.protocol}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        protocol: event.target
                          .value as ExternalRuntimeProtocol,
                      })
                    }
                  >
                    <option value="codex-jsonl">codex-jsonl</option>
                    <option value="plain-text">plain-text</option>
                  </select>
                </label>
                <label className="pm-field" htmlFor="runtime-command">
                  <span>Command</span>
                  <input
                    id="runtime-command"
                    className="runtime-command-input"
                    value={form.command}
                    onChange={(event) =>
                      setForm({ ...form, command: event.target.value })
                    }
                    placeholder="codex"
                    spellCheck={false}
                  />
                </label>
                <label
                  className="pm-field pm-field-wide"
                  htmlFor="runtime-custom-args"
                >
                  <span>自定义 argv token（每行一个）</span>
                  <textarea
                    id="runtime-custom-args"
                    className="runtime-token-input"
                    rows={4}
                    value={form.customArgs}
                    onChange={(event) =>
                      setForm({ ...form, customArgs: event.target.value })
                    }
                    placeholder={"--model\ngpt-5"}
                    spellCheck={false}
                  />
                </label>
                <label className="pm-field">
                  <span>模型池（每行一个）</span>
                  <textarea
                    rows={4}
                    value={form.supportedModels}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        supportedModels: event.target.value,
                      })
                    }
                    placeholder={"gpt-5\ncodex-mini"}
                  />
                </label>
                <label className="pm-field">
                  <span>默认模型</span>
                  <input
                    value={form.defaultModel}
                    onChange={(event) =>
                      setForm({ ...form, defaultModel: event.target.value })
                    }
                    placeholder="gpt-5"
                  />
                </label>
                <label className="pm-field">
                  <span>上下文窗口</span>
                  <input
                    type="number"
                    min={1}
                    value={form.contextWindowTokens}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        contextWindowTokens: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="pm-field">
                  <span>网络</span>
                  <select
                    value={form.networkMode}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        networkMode: event.target
                          .value as ExternalRuntimeNetworkMode,
                      })
                    }
                  >
                    <option value="unknown">unknown</option>
                    <option value="none">none</option>
                    <option value="restricted">restricted</option>
                    <option value="public">public</option>
                  </select>
                </label>
                <label className="pm-field">
                  <span>沙箱</span>
                  <select
                    value={form.sandboxMode}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        sandboxMode: event.target
                          .value as ExternalRuntimeSandboxMode,
                      })
                    }
                  >
                    <option value="read-only">read-only</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="danger-full-access">
                      danger-full-access
                    </option>
                    <option value="custom">custom</option>
                    <option value="unknown">unknown</option>
                  </select>
                </label>
                <label className="pm-field">
                  <span>可见范围</span>
                  <select
                    value={form.visibility}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        visibility: event.target
                          .value as ExternalRuntimeVisibility,
                      })
                    }
                  >
                    <option value="owner">Owner</option>
                    <option value="platform">平台</option>
                  </select>
                </label>
                <fieldset className="runtime-tools pm-field-wide">
                  <legend>能力声明</legend>
                  {runtimeTools.map((tool) => (
                    <label key={tool.value}>
                      <input
                        type="checkbox"
                        checked={form.supportedTools.includes(tool.value)}
                        onChange={(event) => {
                          const supportedTools = event.target.checked
                            ? [...form.supportedTools, tool.value]
                            : form.supportedTools.filter(
                                (candidate) => candidate !== tool.value,
                              );
                          setForm({ ...form, supportedTools });
                        }}
                      />
                      <span>{tool.label}</span>
                    </label>
                  ))}
                </fieldset>
                <details className="runtime-advanced pm-field-wide">
                  <summary>受控 argv</summary>
                  <label className="pm-field">
                    <span>托管 argv token（每行一个）</span>
                    <textarea
                      className="runtime-token-input"
                      rows={3}
                      value={form.managedArgs}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          managedArgs: event.target.value,
                        })
                      }
                      spellCheck={false}
                    />
                  </label>
                  <div className="runtime-invocation-preview">
                    <code>
                      {[form.command, ...splitTokens(form.managedArgs)]
                        .join(" ")
                        .trim()}
                    </code>
                  </div>
                </details>
              </div>

              <div className="runtime-form-actions">
                <span>
                  {creating
                    ? "保存后从 revision 1 开始"
                    : selectedRuntime === undefined
                      ? "定义加载中"
                      : `更新于 ${formatDateTime(selectedRuntime.updatedAt)}`}
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
                  保存运行时
                </button>
              </div>
            </form>
          )}

          {!creating && selectedRuntime !== undefined && (
            <section className="runtime-probe-panel">
              <div className="pm-section-head">
                <h3>Probe</h3>
                <span>{probeLabel(selectedRuntime)}</span>
              </div>
              <div className="runtime-probe-summary">
                <div>
                  <span>状态</span>
                  <strong>{latestProbe?.status ?? "未探测"}</strong>
                </div>
                <div>
                  <span>退出码</span>
                  <strong>{latestProbe?.exitCode ?? "-"}</strong>
                </div>
                <div>
                  <span>版本</span>
                  <strong>{latestProbe?.runtimeVersion ?? "-"}</strong>
                </div>
                <div>
                  <span>耗时</span>
                  <strong>
                    {latestProbe?.durationMs === null ||
                    latestProbe?.durationMs === undefined
                      ? "-"
                      : `${latestProbe.durationMs} ms`}
                  </strong>
                </div>
              </div>
              {(latestProbe?.errorMessage ??
                selectedRuntime.lastProbe?.message) !== null && (
                <div className="runtime-probe-message">
                  {latestProbe?.errorMessage ??
                    selectedRuntime.lastProbe?.message}
                </div>
              )}
            </section>
          )}

          {!creating &&
            selectedRuntime !== undefined &&
            latestCapabilities !== undefined && (
              <section className="runtime-capability-panel">
                <div className="pm-section-head">
                  <h3>有效能力</h3>
                  <span>
                    revision {latestCapabilities.runtimeRevision} ·{" "}
                    {formatDateTime(latestCapabilities.capturedAt)}
                  </span>
                </div>
                <CapabilityGrid
                  profile={latestCapabilities.effectiveProfile}
                />
              </section>
            )}

          {!creating && (eventsQuery.data?.length ?? 0) > 0 && (
            <section className="runtime-events">
              <div className="pm-section-head">
                <h3>治理事件</h3>
                <span>{eventsQuery.data?.length ?? 0} 条</span>
              </div>
              <div className="runtime-event-list">
                {eventsQuery.data?.slice(0, 12).map((event) => (
                  <div className="runtime-event-row" key={event.id}>
                    <time>{formatDateTime(event.createdAt)}</time>
                    <span className="runtime-event-kind">
                      {event.kind === "probed" && <Check size={12} />}
                      {event.kind}
                    </span>
                    <span>{event.message}</span>
                    <small>{event.actorId}</small>
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
