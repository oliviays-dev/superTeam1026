import {
  Archive,
  CirclePause,
  CirclePlay,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  CreateMcpProviderInput,
  CreateMcpProviderVersionInput,
  McpProvider,
  McpProviderAuthKind,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import {
  checkAllMcpProviders,
  createMcpProvider,
  createMcpProviderVersion,
  getMcpProvider,
  getMcpProviderTools,
  listMcpProviders,
  probeMcpProvider,
  transitionMcpProvider,
} from "./api.js";

interface ProviderFormState {
  providerKey: string;
  name: string;
  description: string;
  endpointUrl: string;
  authKind: McpProviderAuthKind;
  credentialRef: string;
  credentialHeaderName: string;
  requestTimeoutMs: string;
}

const emptyForm: ProviderFormState = {
  providerKey: "",
  name: "",
  description: "",
  endpointUrl: "",
  authKind: "none",
  credentialRef: "",
  credentialHeaderName: "",
  requestTimeoutMs: "10000",
};

function statusLabel(status: McpProvider["status"]): string {
  if (status === "active") return "已启用";
  if (status === "disabled") return "已停用";
  if (status === "archived") return "已归档";
  return "草稿";
}

function healthLabel(status: McpProvider["healthStatus"]): string {
  if (status === "healthy") return "健康";
  if (status === "unhealthy") return "异常";
  if (status === "probing") return "探测中";
  return "未探测";
}

function connectionInput(
  form: ProviderFormState,
):
  | Omit<CreateMcpProviderInput, "providerKey">
  | Omit<CreateMcpProviderVersionInput, "expectedRevision"> {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    transport: "streamable-http",
    endpointUrl: form.endpointUrl.trim(),
    authKind: form.authKind,
    credentialRef: form.credentialRef.trim() || null,
    credentialHeaderName:
      form.authKind === "header"
        ? form.credentialHeaderName.trim() || null
        : null,
    requestTimeoutMs: Number(form.requestTimeoutMs),
  };
}

export function McpProvidersView({
  platformAdministrator,
}: {
  platformAdministrator: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderFormState>(emptyForm);

  const providersQuery = useQuery({
    queryKey: ["mcp-providers"],
    queryFn: listMcpProviders,
  });
  const providerId = selectedId || providersQuery.data?.[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["mcp-provider", providerId],
    queryFn: () => getMcpProvider(providerId),
    enabled: providerId !== "" && !creating,
    refetchInterval: (query) => {
      const status = query.state.data?.latestProbe?.status;
      return status === "queued" || status === "running" ? 1_500 : false;
    },
  });
  const toolsQuery = useQuery({
    queryKey: ["mcp-provider-tools", providerId],
    queryFn: () => getMcpProviderTools(providerId),
    enabled: providerId !== "" && !creating,
  });
  const detail = creating ? undefined : detailQuery.data;
  const provider = detail?.provider;

  useEffect(() => {
    if (provider === undefined) return;
    setForm({
      providerKey: provider.providerKey,
      name: provider.name,
      description: provider.description,
      endpointUrl: "",
      authKind: provider.authKind,
      credentialRef: "",
      credentialHeaderName: "",
      requestTimeoutMs: String(provider.requestTimeoutMs),
    });
  }, [provider]);

  useEffect(() => {
    if (
      !creating &&
      selectedId === "" &&
      providersQuery.data?.[0] !== undefined
    ) {
      setSelectedId(providersQuery.data[0].id);
    }
  }, [creating, providersQuery.data, selectedId]);

  const refresh = async (id: string) => {
    setSelectedId(id);
    await queryClient.invalidateQueries({ queryKey: ["mcp-providers"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp-provider", id] });
    await queryClient.invalidateQueries({
      queryKey: ["mcp-provider-tools", id],
    });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createMcpProvider({
        providerKey: form.providerKey.trim(),
        ...connectionInput(form),
      }),
    onSuccess: async (result) => {
      setCreating(false);
      setForm(emptyForm);
      await refresh(result.provider.id);
    },
  });
  const versionMutation = useMutation({
    mutationFn: () => {
      if (provider === undefined) throw new Error("没有可更新的 Provider");
      return createMcpProviderVersion(provider.id, {
        ...connectionInput(form),
        expectedRevision: provider.revision,
      });
    },
    onSuccess: async (result) => {
      setForm((current) => ({
        ...current,
        endpointUrl: "",
        credentialRef: "",
      }));
      await refresh(result.provider.id);
    },
  });
  const probeMutation = useMutation({
    mutationFn: () => {
      if (provider === undefined) throw new Error("没有可探测的 Provider");
      return probeMcpProvider(provider.id, {
        expectedRevision: provider.revision,
      });
    },
    onSuccess: async (result) => {
      await refresh(result.provider.id);
    },
  });
  const transitionMutation = useMutation({
    mutationFn: (action: "activate" | "disable" | "archive") => {
      if (provider === undefined) throw new Error("没有可操作的 Provider");
      return transitionMcpProvider(provider.id, action, {
        expectedRevision: provider.revision,
        reason: "",
      });
    },
    onSuccess: async (result) => {
      await refresh(result.provider.id);
    },
  });
  const healthCheckMutation = useMutation({
    mutationFn: () => checkAllMcpProviders({ providerIds: [] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-providers"] });
      if (providerId !== "") {
        await queryClient.invalidateQueries({
          queryKey: ["mcp-provider", providerId],
        });
      }
    },
  });

  const busy =
    createMutation.isPending ||
    versionMutation.isPending ||
    probeMutation.isPending ||
    transitionMutation.isPending ||
    healthCheckMutation.isPending;
  const error =
    createMutation.error ??
    versionMutation.error ??
    probeMutation.error ??
    transitionMutation.error ??
    healthCheckMutation.error ??
    detailQuery.error ??
    toolsQuery.error;
  const currentFormValid =
    form.name.trim() !== "" &&
    form.endpointUrl.trim() !== "" &&
    Number(form.requestTimeoutMs) >= 1_000;
  const canActivate =
    provider !== undefined &&
    (provider.status === "draft" || provider.status === "disabled") &&
    provider.healthStatus === "healthy" &&
    provider.discoveryStatus === "ready";

  return (
    <main className="pm-page mcp-provider-page">
      <header className="pm-page-head">
        <div>
          <h1>MCP Provider</h1>
          <p>维护服务端连接、版本、健康状态和只读 Tool Schema。</p>
        </div>
        <div className="pm-head-actions">
          {platformAdministrator && (
            <button
              className="pm-btn secondary"
              type="button"
              disabled={busy}
              onClick={() => healthCheckMutation.mutate()}
            >
              <ShieldCheck size={14} />
              平台健康检查
            </button>
          )}
          <button
            className="pm-btn primary"
            type="button"
            onClick={() => {
              setCreating(true);
              setForm(emptyForm);
            }}
          >
            <Plus size={14} />
            注册 Provider
          </button>
        </div>
      </header>

      {error !== null && (
        <div className="pm-inline-error">
          <TriangleAlert size={15} />
          <span>{error.message}</span>
        </div>
      )}

      <div className="mcp-provider-layout">
        <aside className="pm-panel mcp-provider-directory">
          <div className="mcp-provider-directory-head">
            <strong>Provider 目录</strong>
            <span>{providersQuery.data?.length ?? 0}</span>
          </div>
          <div className="mcp-provider-list">
            {providersQuery.data?.map((item) => (
              <button
                className={providerId === item.id && !creating ? "active" : ""}
                type="button"
                key={item.id}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(item.id);
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.providerKey} · v{item.currentVersion}
                  </small>
                </span>
                <span className={`mcp-provider-health ${item.healthStatus}`}>
                  {healthLabel(item.healthStatus)}
                </span>
              </button>
            ))}
            {providersQuery.data?.length === 0 && (
              <div className="pm-empty">暂无 Provider</div>
            )}
          </div>
        </aside>

        <section className="pm-panel mcp-provider-editor">
          <div className="mcp-provider-editor-head">
            <div>
              <h2>{creating ? "注册 Provider" : (provider?.name ?? "Provider")}</h2>
              <p>
                {creating
                  ? "保存后为草稿，必须探测成功后才能启用。"
                  : provider === undefined
                    ? "正在加载"
                    : `${statusLabel(provider.status)} · revision ${provider.revision} · ${healthLabel(provider.healthStatus)}`}
              </p>
            </div>
            {!creating && provider !== undefined && (
              <div className="mcp-provider-actions">
                <button
                  className="pm-icon-btn"
                  type="button"
                  title="发起探测"
                  disabled={busy || provider.status === "archived"}
                  onClick={() => probeMutation.mutate()}
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  className="pm-icon-btn"
                  type="button"
                  title="启用 Provider"
                  disabled={busy || !canActivate}
                  onClick={() => transitionMutation.mutate("activate")}
                >
                  <CirclePlay size={15} />
                </button>
                <button
                  className="pm-icon-btn"
                  type="button"
                  title="停用 Provider"
                  disabled={
                    busy ||
                    (provider.status !== "draft" &&
                      provider.status !== "active")
                  }
                  onClick={() => transitionMutation.mutate("disable")}
                >
                  <CirclePause size={15} />
                </button>
                <button
                  className="pm-icon-btn danger"
                  type="button"
                  title="归档 Provider"
                  disabled={busy || provider.status === "archived"}
                  onClick={() => transitionMutation.mutate("archive")}
                >
                  <Archive size={15} />
                </button>
              </div>
            )}
          </div>

          <form
            className="mcp-provider-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (creating) createMutation.mutate();
              else versionMutation.mutate();
            }}
          >
            <label>
              <span>Provider Key</span>
              <input
                value={form.providerKey}
                disabled={!creating}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    providerKey: event.target.value,
                  }))
                }
                placeholder="catalog.provider"
              />
            </label>
            <label>
              <span>显示名称</span>
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label className="wide">
              <span>说明</span>
              <textarea
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={2}
              />
            </label>
            <label className="wide">
              <span>Endpoint</span>
              <input
                value={form.endpointUrl}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    endpointUrl: event.target.value,
                  }))
                }
                placeholder={
                  creating
                    ? "https://example.com/mcp"
                    : `当前 host: ${provider?.endpointHost ?? ""}`
                }
                autoComplete="off"
              />
            </label>
            <label>
              <span>认证方式</span>
              <select
                value={form.authKind}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    authKind: event.target.value as McpProviderAuthKind,
                  }))
                }
              >
                <option value="none">无</option>
                <option value="bearer">Bearer</option>
                <option value="header">自定义 Header</option>
              </select>
            </label>
            <label>
              <span>超时</span>
              <input
                type="number"
                min={1_000}
                max={30_000}
                step={500}
                value={form.requestTimeoutMs}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    requestTimeoutMs: event.target.value,
                  }))
                }
              />
            </label>
            {form.authKind !== "none" && (
              <>
                <label>
                  <span>凭证引用</span>
                  <input
                    value={form.credentialRef}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        credentialRef: event.target.value,
                      }))
                    }
                    placeholder="env://MCP_TOKEN"
                    autoComplete="off"
                  />
                </label>
                {form.authKind === "header" && (
                  <label>
                    <span>Header 名称</span>
                    <input
                      value={form.credentialHeaderName}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          credentialHeaderName: event.target.value,
                        }))
                      }
                      placeholder="X-API-Key"
                    />
                  </label>
                )}
              </>
            )}
            {!creating && (
              <label className="wide">
                <span>新版本</span>
                <small>
                  保存不会回显已有 URL 或凭证引用；需重新输入完整连接配置。
                </small>
              </label>
            )}
            <div className="mcp-provider-submit wide">
              <button
                className="pm-btn primary"
                type="submit"
                disabled={busy || !currentFormValid}
              >
                {busy ? (
                  <LoaderCircle className="auth-spinner" size={14} />
                ) : (
                  <Save size={14} />
                )}
                {creating ? "保存 Provider" : "创建新版本"}
              </button>
            </div>
          </form>

          {provider !== undefined && (
            <div className="mcp-provider-facts">
              <div>
                <span>连接</span>
                <strong>{provider.endpointHost}</strong>
              </div>
              <div>
                <span>凭证</span>
                <strong>
                  {provider.credentialConfigured ? "已配置安全引用" : "未配置"}
                </strong>
              </div>
              <div>
                <span>Tool 发现</span>
                <strong>
                  {provider.discoveryStatus} · {provider.toolCount}
                </strong>
              </div>
              <div>
                <span>最近检查</span>
                <strong>
                  {provider.healthCheckedAt === null
                    ? "无"
                    : formatDateTime(provider.healthCheckedAt)}
                </strong>
              </div>
            </div>
          )}

          {provider?.lastErrorMessage !== null &&
            provider?.lastErrorMessage !== undefined && (
              <div className="mcp-provider-error">
                <TriangleAlert size={15} />
                <span>
                  {provider.lastErrorCategory ?? "unknown"} ·{" "}
                  {provider.lastErrorCode ?? "probe_failed"} ·{" "}
                  {provider.lastErrorMessage}
                </span>
              </div>
            )}

          <section className="mcp-provider-tools">
            <div className="pm-section-head">
              <div>
                <h3>Tool Schema</h3>
                <p>只读能力发现，不提供 Tool 调用或执行授权。</p>
              </div>
              <span>{toolsQuery.data?.items.length ?? 0}</span>
            </div>
            <div className="mcp-tool-list">
              {toolsQuery.data?.items.map((tool) => (
                <details key={tool.name}>
                  <summary>
                    <strong>{tool.name}</strong>
                    <span>{tool.schemaDigest.slice(0, 12)}</span>
                  </summary>
                  <p>{tool.description || "无说明"}</p>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
              ))}
              {toolsQuery.data?.items.length === 0 && (
                <div className="pm-empty">暂无已发现 Tool</div>
              )}
            </div>
          </section>

          {detail !== undefined && detail.audit.length > 0 && (
            <section className="mcp-provider-audit">
              <div className="pm-section-head">
                <div>
                  <h3>审计</h3>
                  <p>状态、版本和探测结果只追加。</p>
                </div>
              </div>
              <div className="mcp-audit-list">
                {detail.audit.slice(0, 20).map((event) => (
                  <div key={event.id}>
                    <strong>{event.action}</strong>
                    <span>
                      revision {event.revision} · {event.actorRole}
                    </span>
                    <time>{formatDateTime(event.createdAt)}</time>
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
