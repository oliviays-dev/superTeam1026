import type {
  MarketAsset,
  MarketAssetKind,
  MarketAssetManifest,
  MarketEntitlement,
  MarketInstallation,
  MarketTemplate,
  WorkbenchPanelPlacement,
  WorkbenchPanelResolution,
} from "@pluginmax/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Download,
  LayoutGrid,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  Star,
  Store,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  copyMarketTemplate,
  createMarketAsset,
  createWorkbenchLayout,
  getMarketAsset,
  getWorkbenchDetail,
  getWorkbenchBootstrap,
  grantMarketEntitlement,
  installMarketAsset,
  listManagedAccounts,
  listMarketAssets,
  listMarketEntitlements,
  listMarketInstallations,
  listMarketTemplates,
  publishMarketAssetVersion,
  revokeMarketEntitlement,
  saveWorkbenchLayout,
  setMarketAssetStatus,
  setMarketAssetVersionStatus,
  setDefaultWorkbenchLayout,
  uninstallMarketAsset,
} from "./api.js";

export function WorkbenchConfigurationPanel({
  platformAdministrator,
  viewerPrincipalId,
  onLayout,
}: {
  readonly platformAdministrator: boolean;
  readonly viewerPrincipalId: string;
  readonly onLayout: (
    workbenchId: string,
    panels: readonly WorkbenchPanelResolution[],
  ) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState("");
  const [layoutName, setLayoutName] = useState("");
  const [panels, setPanels] = useState<WorkbenchPanelPlacement[]>([]);
  const [newLayoutName, setNewLayoutName] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const bootstrapQuery = useQuery({
    queryKey: ["workbench-bootstrap"],
    queryFn: getWorkbenchBootstrap,
  });
  const bootstrap = bootstrapQuery.data;
  const workbenches = bootstrap?.workbenches ?? [];
  const selectedWorkbench =
    workbenches.find((item) => item.id === selectedWorkbenchId) ??
    workbenches[0];
  const detailQuery = useQuery({
    queryKey: ["workbench-detail", selectedWorkbench?.id],
    queryFn: () => getWorkbenchDetail(selectedWorkbench!.id),
    enabled: selectedWorkbench !== undefined,
  });
  const detail = detailQuery.data;

  useEffect(() => {
    if (selectedWorkbenchId === "" && workbenches[0] !== undefined) {
      setSelectedWorkbenchId(workbenches[0].id);
    }
  }, [selectedWorkbenchId, workbenches]);

  useEffect(() => {
    if (detail === undefined || detail === null) return;
    setLayoutName(detail.layout.name);
    setPanels(
      [...detail.layout.document.panels].sort(
        (left, right) => left.position - right.position,
      ),
    );
    onLayout(detail.workbench.id, detail.panels);
  }, [detail?.layout.id, detail?.layout.revision, onLayout]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (detail === undefined || detail === null) {
        throw new Error("Workbench is not ready");
      }
      return saveWorkbenchLayout(
        detail.workbench.id,
        detail.layout.id,
        {
          expectedRevision: detail.layout.revision,
          name: layoutName,
          document: {
            version: 1,
            panels: panels.map((panel, position) => ({
              ...panel,
              position,
            })),
          },
        },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["workbench-bootstrap"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["workbench-detail"],
      });
    },
  });
  const createLayoutMutation = useMutation({
    mutationFn: () => {
      if (detail === undefined || detail === null) {
        throw new Error("Workbench is not ready");
      }
      return createWorkbenchLayout(detail.workbench.id, {
        name: newLayoutName,
        makeDefault: false,
        document: {
          version: 1,
          panels: panels.map((panel, position) => ({
            ...panel,
            position,
          })),
        },
      });
    },
    onSuccess: async () => {
      setNewLayoutName("");
      await queryClient.invalidateQueries({
        queryKey: ["workbench-bootstrap"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["workbench-detail"],
      });
    },
  });
  const defaultMutation = useMutation({
    mutationFn: () => {
      if (detail === undefined || detail === null) {
        throw new Error("Workbench is not ready");
      }
      return setDefaultWorkbenchLayout(
        detail.workbench.id,
        detail.layout.id,
        { expectedRevision: detail.layout.revision },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["workbench-bootstrap"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["workbench-detail"],
      });
    },
  });

  if (!bootstrap?.enabled || detail === undefined || detail === null) {
    return null;
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= panels.length) return;
    const next = [...panels];
    const [item] = next.splice(index, 1);
    if (item !== undefined) next.splice(target, 0, item);
    setPanels(next);
  };
  const resize = (index: number, width: number) => {
    setPanels((current) =>
      current.map((panel, panelIndex) =>
        panelIndex === index ? { ...panel, width } : panel,
      ),
    );
  };
  const error =
    saveMutation.error ??
    createLayoutMutation.error ??
    defaultMutation.error ??
    bootstrapQuery.error ??
    detailQuery.error;

  return (
    <section className="workbench-config-panel">
      <div className="workbench-config-toolbar">
        <span className="workbench-config-title">
          <LayoutGrid size={15} />
          布局
        </span>
        {workbenches.length > 1 && (
          <select
            className="pm-compact-select"
            aria-label="切换工作台"
            value={selectedWorkbench?.id ?? ""}
            onChange={(event) => setSelectedWorkbenchId(event.target.value)}
          >
            {workbenches.map((workbench) => (
              <option value={workbench.id} key={workbench.id}>
                {workbench.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="pm-input workbench-layout-name"
          value={layoutName}
          maxLength={80}
          aria-label="布局名称"
          onChange={(event) => setLayoutName(event.target.value)}
        />
        <span className="workbench-revision">
          r{detail.layout.revision} · v{detail.layoutVersion.revision}
        </span>
        <button
          className="pm-btn secondary"
          type="button"
          disabled={defaultMutation.isPending || detail.layout.isDefault}
          onClick={() => defaultMutation.mutate()}
        >
          <Star size={13} />
          设为默认
        </button>
        <button
          className="pm-btn"
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          <Save size={13} />
          保存布局
        </button>
        {bootstrap.marketEnabled && (
          <button
            className="pm-btn secondary"
            type="button"
            aria-pressed={marketOpen}
            onClick={() => setMarketOpen((open) => !open)}
          >
            <Store size={13} />
            资源市场
          </button>
        )}
      </div>
      <div className="workbench-panel-config-list">
        {panels.map((panel, index) => {
          const resolved = detail.panels.find(
            (item) => item.pluginId === panel.pluginId,
          );
          return (
            <article
              className={`workbench-panel-config-row ${
                resolved?.state === "ready" ? "" : "unavailable"
              }`}
              key={panel.pluginId}
            >
              <span className="workbench-panel-config-name">
                {resolved?.title ?? panel.pluginId}
                {resolved?.state !== "ready" && (
                  <small>{resolved?.fallbackMessage ?? "降级占位"}</small>
                )}
              </span>
              <select
                className="pm-compact-select"
                aria-label={`${resolved?.title ?? panel.pluginId}宽度`}
                value={panel.width}
                onChange={(event) =>
                  resize(index, Number(event.target.value))
                }
              >
                {[1, 2, 3, 4, 5, 6].map((width) => (
                  <option value={width} key={width}>
                    {width}/6
                  </option>
                ))}
              </select>
              <button
                className="pm-icon-btn"
                type="button"
                title="上移面板"
                aria-label={`上移${resolved?.title ?? panel.pluginId}`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                className="pm-icon-btn"
                type="button"
                title="下移面板"
                aria-label={`下移${resolved?.title ?? panel.pluginId}`}
                disabled={index === panels.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} />
              </button>
            </article>
          );
        })}
      </div>
      <div className="workbench-config-secondary">
        <input
          className="pm-input"
          placeholder="新布局名称"
          value={newLayoutName}
          maxLength={80}
          onChange={(event) => setNewLayoutName(event.target.value)}
        />
        <button
          className="pm-btn secondary"
          type="button"
          disabled={
            newLayoutName.trim() === "" || createLayoutMutation.isPending
          }
          onClick={() => createLayoutMutation.mutate()}
        >
          另存为布局
        </button>
      </div>
      {error !== null && (
        <div className="pm-error compact">
          {error instanceof Error ? error.message : "布局操作失败"}
        </div>
      )}
      {marketOpen && bootstrap.marketEnabled && (
        <WorkbenchMarketPanel
          platformAdministrator={platformAdministrator}
          viewerPrincipalId={viewerPrincipalId}
        />
      )}
    </section>
  );
}

function WorkbenchMarketPanel({
  platformAdministrator,
  viewerPrincipalId,
}: {
  readonly platformAdministrator: boolean;
  readonly viewerPrincipalId: string;
}) {
  const queryClient = useQueryClient();
  const [copyNames, setCopyNames] = useState<Record<string, string>>({});
  const assetsQuery = useQuery({
    queryKey: ["market-assets"],
    queryFn: () => listMarketAssets(),
  });
  const entitlementsQuery = useQuery({
    queryKey: ["market-entitlements"],
    queryFn: () => listMarketEntitlements(),
  });
  const installationsQuery = useQuery({
    queryKey: ["market-installations"],
    queryFn: listMarketInstallations,
  });
  const templatesQuery = useQuery({
    queryKey: ["market-templates"],
    queryFn: listMarketTemplates,
  });
  const installMutation = useMutation({
    mutationFn: (asset: MarketAsset) =>
      installMarketAsset({
        assetId: asset.id,
        version: asset.currentVersion,
        config: {},
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["market-installations"],
      });
    },
  });
  const uninstallMutation = useMutation({
    mutationFn: uninstallMarketAsset,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["market-installations"],
      });
    },
  });
  const copyMutation = useMutation({
    mutationFn: (template: MarketTemplate) =>
      copyMarketTemplate(template.id, {
        version: template.currentVersion,
        name:
          copyNames[template.id]?.trim() ||
          `${template.name} copy`,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["workbench-bootstrap"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["market-templates"],
      });
    },
  });
  const assets = assetsQuery.data ?? [];
  const entitlements = entitlementsQuery.data ?? [];
  const installations = installationsQuery.data ?? [];
  const templates = templatesQuery.data ?? [];
  const activeEntitlements = new Set(
    entitlements
      .filter((item: MarketEntitlement) => item.status === "active")
      .map((item) => item.assetId),
  );
  const activeInstallations = new Map(
    installations
      .filter((item: MarketInstallation) => item.status === "active")
      .map((item) => [item.assetId, item]),
  );
  const error =
    assetsQuery.error ??
    entitlementsQuery.error ??
    installationsQuery.error ??
    templatesQuery.error ??
    installMutation.error ??
    uninstallMutation.error ??
    copyMutation.error;

  return (
    <div className="workbench-market-panel">
      <header>
        <strong>资源市场</strong>
        <span>安装只写 entitlement，不扩大项目、数据或工具权限</span>
      </header>
      {error !== null && (
        <div className="pm-error compact">
          {error instanceof Error ? error.message : "市场读取失败"}
        </div>
      )}
      <div className="market-asset-grid">
        {assets.map((asset: MarketAsset) => {
          const entitlement = activeEntitlements.has(asset.id);
          const installation = activeInstallations.get(asset.id);
          return (
            <article className="market-asset-card" key={asset.id}>
              <div className="market-asset-head">
                <span>
                  <strong>{asset.name}</strong>
                  <small>
                    {marketKindLabel(asset.kind)} · {asset.trustLevel}
                  </small>
                </span>
                <span className={`pm-pill ${entitlement ? "progress" : ""}`}>
                  {entitlement ? `v${asset.currentVersion}` : "未授权"}
                </span>
              </div>
              <p>{asset.description || "暂无说明"}</p>
              <footer>
                {!entitlement && (
                  <span className="market-lock">
                    <LockKeyhole size={13} />
                    需要 entitlement
                  </span>
                )}
                {installation === undefined ? (
                  <button
                    className="pm-btn"
                    type="button"
                    disabled={!entitlement || installMutation.isPending}
                    onClick={() => installMutation.mutate(asset)}
                  >
                    <Download size={13} />
                    安装
                  </button>
                ) : (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    disabled={uninstallMutation.isPending}
                    onClick={() => uninstallMutation.mutate(asset.id)}
                  >
                    卸载
                  </button>
                )}
              </footer>
            </article>
          );
        })}
        {assets.length === 0 && !assetsQuery.isLoading && (
          <div className="pm-empty compact">当前没有可见的市场资产</div>
        )}
      </div>
      <div className="market-template-list">
        <h3>工作台方案</h3>
        {templates.map((template) => (
          <article className="market-template-row" key={template.id}>
            <span>
              <strong>{template.name}</strong>
              <small>
                v{template.currentVersion} · {template.dependencies.length} 依赖
              </small>
            </span>
            <input
              className="pm-input"
              placeholder="复制后的工作台名称"
              value={copyNames[template.id] ?? ""}
              onChange={(event) =>
                setCopyNames((current) => ({
                  ...current,
                  [template.id]: event.target.value,
                }))
              }
            />
            <button
              className="pm-btn secondary"
              type="button"
              disabled={
                copyMutation.isPending ||
                !activeEntitlements.has(template.assetId)
              }
              onClick={() => copyMutation.mutate(template)}
            >
              复制方案
            </button>
          </article>
        ))}
        {templates.length === 0 && !templatesQuery.isLoading && (
          <div className="pm-empty compact">当前没有可复制的工作台方案</div>
        )}
      </div>
      {platformAdministrator && (
        <MarketAdministrationPanel viewerPrincipalId={viewerPrincipalId} />
      )}
    </div>
  );
}

function MarketAdministrationPanel({
  viewerPrincipalId,
}: {
  readonly viewerPrincipalId: string;
}) {
  const queryClient = useQueryClient();
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [targetPrincipalId, setTargetPrincipalId] = useState(
    viewerPrincipalId,
  );
  const [manifest, setManifest] = useState(() =>
    defaultMarketManifest("workbench-template"),
  );
  const [maxHostVersion, setMaxHostVersion] = useState("");
  const [draft, setDraft] = useState({
    assetKey: "",
    kind: "workbench-template" as MarketAssetKind,
    name: "",
    description: "",
    trustLevel: "official" as "official" | "verified" | "private",
    visibility: "public" as "public" | "private" | "workspace" | "project",
    visibilityScopeId: "",
  });
  const assetsQuery = useQuery({
    queryKey: ["market-assets"],
    queryFn: () => listMarketAssets(),
  });
  const entitlementsQuery = useQuery({
    queryKey: ["market-entitlements", "all"],
    queryFn: () => listMarketEntitlements(true),
  });
  const accountsQuery = useQuery({
    queryKey: ["managed-accounts", "market-entitlements"],
    queryFn: () =>
      listManagedAccounts({
        status: "active",
        principalStatus: "active",
        limit: 100,
      }),
  });
  const assets = assetsQuery.data ?? [];
  const effectiveAssetId = selectedAssetId || assets[0]?.id || "";
  const selectedAssetQuery = useQuery({
    queryKey: ["market-asset", effectiveAssetId],
    queryFn: () => getMarketAsset(effectiveAssetId),
    enabled: effectiveAssetId !== "",
  });
  const selectedAsset = selectedAssetQuery.data;

  useEffect(() => {
    if (selectedAssetId !== "" || assets[0] === undefined) return;
    setSelectedAssetId(assets[0].id);
  }, [assets, selectedAssetId]);

  useEffect(() => {
    if (selectedAsset === undefined) return;
    setManifest(defaultMarketManifest(selectedAsset.kind));
    setMaxHostVersion("");
  }, [selectedAsset?.id]);

  const refreshMarket = async () => {
    await queryClient.invalidateQueries({ queryKey: ["market-assets"] });
    await queryClient.invalidateQueries({
      queryKey: ["market-entitlements"],
    });
    await queryClient.invalidateQueries({
      queryKey: ["market-templates"],
    });
    await queryClient.invalidateQueries({
      queryKey: ["market-asset", effectiveAssetId],
    });
  };
  const createMutation = useMutation({
    mutationFn: () =>
      createMarketAsset({
        assetKey: draft.assetKey.trim(),
        kind: draft.kind,
        name: draft.name.trim(),
        description: draft.description.trim(),
        trustLevel: draft.trustLevel,
        visibility: draft.visibility,
        ...((draft.visibility === "workspace" ||
          draft.visibility === "project") &&
        draft.visibilityScopeId.trim() !== ""
          ? { visibilityScopeId: draft.visibilityScopeId.trim() }
          : {}),
      }),
    onSuccess: async (asset) => {
      setSelectedAssetId(asset.id);
      setDraft((current) => ({
        ...current,
        assetKey: "",
        name: "",
        description: "",
        visibilityScopeId: "",
      }));
      await refreshMarket();
    },
  });
  const publishMutation = useMutation({
    mutationFn: () => {
      if (selectedAsset === undefined) throw new Error("请先选择市场资产");
      return publishMarketAssetVersion(selectedAsset.id, {
        manifest: parseMarketManifest(manifest),
        compatibility: {
          minHostVersion: "2.0.0",
          ...(maxHostVersion.trim() === ""
            ? {}
            : { maxHostVersion: maxHostVersion.trim() }),
        },
      });
    },
    onSuccess: refreshMarket,
  });
  const assetStatusMutation = useMutation({
    mutationFn: (input: {
      readonly status: "active" | "delisted" | "archived";
    }) => {
      if (selectedAsset === undefined) throw new Error("请先选择市场资产");
      return setMarketAssetStatus(selectedAsset.id, {
        status: input.status,
        expectedRevision: selectedAsset.revision,
      });
    },
    onSuccess: refreshMarket,
  });
  const versionStatusMutation = useMutation({
    mutationFn: (input: {
      readonly version: number;
      readonly status: "published" | "deprecated" | "revoked";
    }) => {
      if (selectedAsset === undefined) throw new Error("请先选择市场资产");
      return setMarketAssetVersionStatus(
        selectedAsset.id,
        input.version,
        { status: input.status },
      );
    },
    onSuccess: refreshMarket,
  });
  const grantMutation = useMutation({
    mutationFn: () => {
      if (selectedAsset === undefined) throw new Error("请先选择市场资产");
      if (targetPrincipalId.trim() === "") {
        throw new Error("请选择 entitlement 目标账号");
      }
      return grantMarketEntitlement({
        assetId: selectedAsset.id,
        principalId: targetPrincipalId.trim(),
      });
    },
    onSuccess: refreshMarket,
  });
  const revokeMutation = useMutation({
    mutationFn: revokeMarketEntitlement,
    onSuccess: refreshMarket,
  });
  const accounts = accountsQuery.data?.items ?? [];
  const entitlements = entitlementsQuery.data ?? [];
  const selectedEntitlements = entitlements.filter(
    (entitlement) => entitlement.assetId === effectiveAssetId,
  );
  const error =
    assetsQuery.error ??
    entitlementsQuery.error ??
    accountsQuery.error ??
    selectedAssetQuery.error ??
    createMutation.error ??
    publishMutation.error ??
    assetStatusMutation.error ??
    versionStatusMutation.error ??
    grantMutation.error ??
    revokeMutation.error;

  return (
    <details className="market-admin" open>
      <summary>
        <ShieldCheck size={14} />
        市场管理
      </summary>
      {error !== null && (
        <div className="pm-error compact">
          {error instanceof Error ? error.message : "市场管理操作失败"}
        </div>
      )}
      <div className="market-admin-form">
        <h3>上架资产</h3>
        <div className="market-admin-grid">
          <label>
            Asset Key
            <input
              className="pm-input"
              value={draft.assetKey}
              placeholder="team.panel.example"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  assetKey: event.target.value,
                }))
              }
            />
          </label>
          <label>
            名称
            <input
              className="pm-input"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label>
            类型
            <select
              className="pm-input"
              value={draft.kind}
              onChange={(event) => {
                const kind = event.target.value as MarketAssetKind;
                setDraft((current) => ({ ...current, kind }));
                setManifest(defaultMarketManifest(kind));
              }}
            >
              <option value="workbench-template">工作台方案</option>
              <option value="panel">静态面板</option>
              <option value="skill">Skill</option>
              <option value="mcp">MCP</option>
              <option value="plugin">插件</option>
            </select>
          </label>
          <label>
            信任级
            <select
              className="pm-input"
              value={draft.trustLevel}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  trustLevel: event.target
                    .value as typeof current.trustLevel,
                }))
              }
            >
              <option value="official">official</option>
              <option value="verified">verified</option>
              <option value="private">private</option>
            </select>
          </label>
          <label>
            可见性
            <select
              className="pm-input"
              value={draft.visibility}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  visibility: event.target
                    .value as typeof current.visibility,
                }))
              }
            >
              <option value="public">public</option>
              <option value="private">private</option>
              <option value="workspace">workspace</option>
              <option value="project">project</option>
            </select>
          </label>
          {(draft.visibility === "workspace" ||
            draft.visibility === "project") && (
            <label>
              Scope ID
              <input
                className="pm-input"
                value={draft.visibilityScopeId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    visibilityScopeId: event.target.value,
                  }))
                }
              />
            </label>
          )}
        </div>
        <label className="market-admin-wide">
          说明
          <textarea
            className="pm-input"
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
        </label>
        <button
          className="pm-btn"
          type="button"
          disabled={
            createMutation.isPending ||
            draft.assetKey.trim() === "" ||
            draft.name.trim() === ""
          }
          onClick={() => createMutation.mutate()}
        >
          <Plus size={13} />
          创建市场资产
        </button>
      </div>

      <div className="market-admin-form">
        <h3>版本与生命周期</h3>
        <label>
          资产
          <select
            className="pm-input"
            value={effectiveAssetId}
            onChange={(event) => setSelectedAssetId(event.target.value)}
          >
            {assets.map((asset) => (
              <option value={asset.id} key={asset.id}>
                {asset.name} · {asset.status}
              </option>
            ))}
          </select>
        </label>
        {selectedAsset !== undefined && (
          <>
            <div className="market-admin-pills">
              <span className="pm-pill">{selectedAsset.status}</span>
              <span className="pm-pill progress">
                v{selectedAsset.currentVersion}
              </span>
              <span className="pm-pill">r{selectedAsset.revision}</span>
            </div>
            <div className="market-admin-actions">
              {selectedAsset.status !== "active" && (
                <button
                  className="pm-btn secondary"
                  type="button"
                  disabled={assetStatusMutation.isPending}
                  onClick={() =>
                    assetStatusMutation.mutate({ status: "active" })
                  }
                >
                  重新上架
                </button>
              )}
              {selectedAsset.status === "active" && (
                <button
                  className="pm-btn secondary"
                  type="button"
                  disabled={assetStatusMutation.isPending}
                  onClick={() =>
                    assetStatusMutation.mutate({ status: "delisted" })
                  }
                >
                  下架
                </button>
              )}
              {selectedAsset.status !== "archived" && (
                <button
                  className="pm-btn secondary"
                  type="button"
                  disabled={assetStatusMutation.isPending}
                  onClick={() =>
                    assetStatusMutation.mutate({ status: "archived" })
                  }
                >
                  归档
                </button>
              )}
            </div>
            <div className="market-version-list">
              {selectedAsset.versions.map((version) => (
                <div className="market-version-row" key={version.id}>
                  <span>
                    <strong>v{version.version}</strong>
                    <small>{version.status}</small>
                  </span>
                  {version.status !== "deprecated" &&
                    version.status !== "revoked" && (
                      <button
                        className="pm-btn secondary"
                        type="button"
                        disabled={versionStatusMutation.isPending}
                        onClick={() =>
                          versionStatusMutation.mutate({
                            version: version.version,
                            status: "deprecated",
                          })
                        }
                      >
                        弃用
                      </button>
                    )}
                  {version.status !== "revoked" && (
                    <button
                      className="pm-btn secondary"
                      type="button"
                      disabled={versionStatusMutation.isPending}
                      onClick={() =>
                        versionStatusMutation.mutate({
                          version: version.version,
                          status: "revoked",
                        })
                      }
                    >
                      撤销版本
                    </button>
                  )}
                </div>
              ))}
            </div>
            <label className="market-admin-wide">
              Manifest JSON
              <textarea
                className="pm-input market-manifest-input"
                aria-label="版本 Manifest"
                value={manifest}
                onChange={(event) => setManifest(event.target.value)}
              />
            </label>
            <label>
              最高 Host 版本（可选）
              <input
                className="pm-input"
                value={maxHostVersion}
                placeholder="3.0.0"
                onChange={(event) => setMaxHostVersion(event.target.value)}
              />
            </label>
            <button
              className="pm-btn"
              type="button"
              disabled={publishMutation.isPending}
              onClick={() => publishMutation.mutate()}
            >
              发布版本
            </button>
          </>
        )}
      </div>

      <div className="market-admin-form">
        <h3>Entitlement</h3>
        <div className="market-entitlement-grant">
          <label>
            目标账号
            <select
              className="pm-input"
              value={targetPrincipalId}
              onChange={(event) => setTargetPrincipalId(event.target.value)}
            >
              {accounts.map((account) => (
                <option value={account.principalId} key={account.id}>
                  {account.displayName} · {account.loginId}
                </option>
              ))}
              {!accounts.some(
                (account) => account.principalId === targetPrincipalId,
              ) && targetPrincipalId !== "" && (
                <option value={targetPrincipalId}>
                  {targetPrincipalId}
                </option>
              )}
            </select>
          </label>
          <button
            className="pm-btn"
            type="button"
            disabled={grantMutation.isPending || effectiveAssetId === ""}
            onClick={() => grantMutation.mutate()}
          >
            授予 entitlement
          </button>
        </div>
        <div className="market-entitlement-list">
          {selectedEntitlements.map((entitlement) => (
            <div className="market-entitlement-row" key={entitlement.id}>
              <span>
                <strong>{entitlement.principalId}</strong>
                <small>
                  {entitlement.status} · r{entitlement.revision} ·
                  grantsAuthorization=false
                </small>
              </span>
              {entitlement.status === "active" && (
                <button
                  className="pm-btn secondary"
                  type="button"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(entitlement.id)}
                >
                  撤销
                </button>
              )}
            </div>
          ))}
          {selectedEntitlements.length === 0 && (
            <div className="pm-empty compact">该资产还没有 entitlement</div>
          )}
        </div>
      </div>
    </details>
  );
}

function defaultMarketManifest(kind: MarketAssetKind): string {
  const manifest =
    kind === "panel"
      ? { summary: "", panelPluginId: "market.sample" }
      : kind === "workbench-template"
        ? {
            summary: "",
            template: {
              version: 1,
              panels: [
                {
                  pluginId: "brief",
                  position: 0,
                  width: 6,
                  height: null,
                  config: {},
                  enabled: true,
                },
              ],
            },
          }
        : { summary: "" };
  return JSON.stringify(manifest, null, 2);
}

function parseMarketManifest(value: string): MarketAssetManifest {
  try {
    return JSON.parse(value) as MarketAssetManifest;
  } catch {
    throw new Error("Manifest 必须是合法 JSON");
  }
}

function marketKindLabel(kind: MarketAsset["kind"]): string {
  switch (kind) {
    case "panel":
      return "静态面板";
    case "skill":
      return "Skill";
    case "mcp":
      return "MCP";
    case "workbench-template":
      return "工作台方案";
    case "plugin":
      return "插件";
  }
}
