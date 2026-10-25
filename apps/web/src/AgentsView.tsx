import type {
  Agent,
  AgentDetail,
  CreateAgentInput,
  RuntimeKind,
  UpdateAgentInput,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CirclePause,
  CirclePlay,
  LoaderCircle,
  Plus,
  Save,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  createAgent,
  getAgent,
  listAllAgents,
  setAgentStatus,
  updateAgent,
} from "./api.js";

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
  const detail = creating ? undefined : detailQuery.data;

  useEffect(() => {
    if (detail !== undefined) setForm(formFromAgent(detail.agent));
  }, [detail]);

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

  const busy =
    createMutation.isPending ||
    updateMutation.isPending ||
    statusMutation.isPending;
  const error =
    createMutation.error ?? updateMutation.error ?? statusMutation.error;
  const selectedAgent = detail?.agent;

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
