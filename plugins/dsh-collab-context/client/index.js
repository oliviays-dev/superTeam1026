window.__ModuleLoader__.load({
  id: "dsh-collab-context",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;

    const TOKEN_KEY = "pluginmax.collab.token";

    const request = async (path, init) => {
      const token = window.localStorage.getItem(TOKEN_KEY) ?? "";
      const response = await fetch(path, {
        ...init,
        headers: {
          ...(init?.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
          ...init?.headers,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? `请求失败 (${response.status})`);
      }
      return body;
    };

    const sceneLabels = {
      project: "项目",
      task: "任务",
      meeting: "会议",
      chat: "AI 对话",
      "workflow-node": "工作流节点",
    };
    const authorityLabels = {
      mandatory: "强制",
      instruction: "指令",
      evidence: "证据",
    };
    const permissionLabels = {
      visible: "可见",
      partial: "部分来源受限",
      redacted: "已脱敏",
    };
    const sourceLabel = (source) =>
      source.title?.trim() ||
      `${source.sourceType} / ${source.sourceId}`;

    const style = {
      section: { display: "grid", gap: 12, maxWidth: 1180 },
      toolbar: {
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
      },
      select: {
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 6,
        color: "inherit",
        minHeight: 32,
        padding: "0 9px",
      },
      grid: {
        display: "grid",
        gap: 12,
        gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)",
      },
      list: {
        alignContent: "start",
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 7,
        display: "grid",
        gap: 5,
        maxHeight: 620,
        overflow: "auto",
        padding: 7,
      },
      row: {
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        gap: 5,
        padding: "9px 10px",
        textAlign: "left",
        width: "100%",
      },
      rowActive: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderColor: "var(--dsw-alias-brand-primary)",
      },
      panel: {
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 7,
        display: "grid",
        gap: 12,
        minHeight: 300,
        padding: 14,
      },
      meta: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 12,
      },
      chip: {
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 999,
        display: "inline-flex",
        fontSize: 11,
        lineHeight: "20px",
        padding: "0 8px",
      },
      source: {
        borderTop:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        display: "grid",
        gap: 7,
        paddingTop: 10,
      },
      sourceHead: {
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 7,
        justifyContent: "space-between",
      },
      code: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderRadius: 5,
        fontSize: 11,
        maxHeight: 180,
        overflow: "auto",
        padding: 8,
        whiteSpace: "pre-wrap",
      },
    };

    function ContextReceiptSection() {
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      const [scene, setScene] = react.useState("");
      const [receipts, setReceipts] = react.useState([]);
      const [selectedRunId, setSelectedRunId] = react.useState("");
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState("");
      const selected =
        receipts.find((item) => item.receipt.runId === selectedRunId) ??
        receipts[0];

      react.useEffect(() => {
        let disposed = false;
        void request("/api/collab/team/workspaces")
          .then((result) => {
            if (disposed) return;
            const list = [
              { id: "system.default", title: "AI 私聊（无项目上下文）" },
              ...(result.workspaces ?? []),
            ];
            setWorkspaces(list);
            setWorkspaceId((current) => current || list[0]?.id || "");
          })
          .catch((cause) => {
            if (!disposed) setError(cause.message);
          });
        return () => {
          disposed = true;
        };
      }, []);

      react.useEffect(() => {
        if (workspaceId === "") return undefined;
        let disposed = false;
        setLoading(true);
        setError("");
        const query = new URLSearchParams({ workspaceId });
        if (scene !== "") query.set("scene", scene);
        void request(`/api/collab/context/receipts?${query}`)
          .then((result) => {
            if (disposed) return;
            const list = result.receipts ?? [];
            setReceipts(list);
            setSelectedRunId((current) =>
              list.some((item) => item.receipt.runId === current)
                ? current
                : (list[0]?.receipt.runId ?? ""),
            );
          })
          .catch((cause) => {
            if (!disposed) setError(cause.message);
          })
          .finally(() => {
            if (!disposed) setLoading(false);
          });
        return () => {
          disposed = true;
        };
      }, [workspaceId, scene]);

      return h("section", { style: style.section }, [
        h("div", { key: "head", style: { display: "grid", gap: 3 } }, [
          h("h2", { key: "title", style: { margin: 0 }, children: "上下文回执" }),
          h("div", {
            key: "desc",
            style: style.meta,
            children:
              "查看每轮 Run 使用的来源、排除原因和当前账号可见层级。",
          }),
        ]),
        h("div", { key: "toolbar", style: style.toolbar }, [
          h(
            "select",
            {
              key: "workspace",
              style: style.select,
              value: workspaceId,
              "aria-label": "上下文回执项目",
              onChange: (event) => setWorkspaceId(event.target.value),
            },
            ...workspaces.map((workspace) =>
              h("option", {
                key: workspace.id,
                value: workspace.id,
                children: workspace.title ?? workspace.id,
              }),
            ),
          ),
          h(
            "select",
            {
              key: "scene",
              style: style.select,
              value: scene,
              "aria-label": "上下文回执场景",
              onChange: (event) => setScene(event.target.value),
            },
            h("option", { value: "", children: "全部场景" }),
            ...Object.entries(sceneLabels).map(([value, label]) =>
              h("option", { key: value, value, children: label }),
            ),
          ),
          h("span", {
            style: style.meta,
            children: loading ? "加载中…" : `共 ${receipts.length} 条回执`,
          }),
        ]),
        error === ""
          ? null
          : h("div", {
              role: "alert",
              style: { color: "var(--dsw-alias-label-error)", fontSize: 12 },
              children: error,
            }),
        h("div", { style: style.grid }, [
          h(
            "div",
            { key: "list", style: style.list },
            receipts.length === 0
              ? h("div", {
                  style: Object.assign({}, style.meta, { padding: 12 }),
                  children: "当前筛选下没有上下文回执。",
                })
              : null,
            ...receipts.map((item) => {
              const receipt = item.receipt;
              const active =
                receipt.runId === (selected?.receipt.runId ?? selectedRunId);
              return h(
                "button",
                {
                  key: receipt.id,
                  type: "button",
                  style: Object.assign(
                    {},
                    style.row,
                    active ? style.rowActive : {},
                  ),
                  onClick: () => setSelectedRunId(receipt.runId ?? ""),
                },
                h("strong", {
                  children: sceneLabels[receipt.scene] ?? receipt.scene,
                }),
                h("span", {
                  style: style.meta,
                  children: receipt.runId ?? receipt.objectId,
                }),
                h("span", {
                  style: style.meta,
                  children: `${item.scope === "full" ? "完整权限" : "共享脱敏"} · ${new Date(receipt.createdAt).toLocaleString()}`,
                }),
              );
            }),
          ),
          h(
            "div",
            { key: "detail", style: style.panel },
            selected === undefined
              ? h("div", {
                  style: style.meta,
                  children: "选择一条回执查看来源与权限。",
                })
              : h("div", { style: { display: "grid", gap: 12 } }, [
                  h("div", { key: "head", style: style.sourceHead }, [
                    h("div", { style: { display: "grid", gap: 4 } }, [
                      h("strong", {
                        children: `${sceneLabels[selected.receipt.scene] ?? selected.receipt.scene} · ${selected.receipt.objectId}`,
                      }),
                      h("span", {
                        style: style.meta,
                        children: `Run ${selected.receipt.runId ?? "preview"} · Pack ${selected.receipt.contextPackId}`,
                      }),
                    ]),
                    h("span", {
                      style: Object.assign({}, style.chip, {
                        color:
                          selected.scope === "full"
                            ? "var(--dsw-alias-label-success)"
                            : "var(--dsw-alias-label-warning)",
                      }),
                      children:
                        selected.scope === "full"
                          ? "完整回执"
                          : `共享投影 · ${selected.redactedCount} 项脱敏`,
                    }),
                  ]),
                  h("div", {
                    key: "meta",
                    style: style.meta,
                    children: `Session ${selected.receipt.session.sessionId} · Identity ${selected.receipt.identity.snapshotId}`,
                  }),
                  h(
                    "div",
                    { key: "sources", style: { display: "grid", gap: 9 } },
                    ...selected.sources.map((source) =>
                      h("div", {
                        key: `${source.sourceType}:${source.sourceId}`,
                        style: style.source,
                      }, [
                        h("div", { key: "head", style: style.sourceHead }, [
                          h("strong", { children: sourceLabel(source) }),
                          h("span", {
                            style: Object.assign({}, style.chip, {
                              color:
                                source.permission === "visible"
                                  ? "var(--dsw-alias-label-success)"
                                  : "var(--dsw-alias-label-warning)",
                            }),
                            children:
                              permissionLabels[source.permission] ??
                              source.permission,
                          }),
                        ]),
                        h("div", {
                          key: "reason",
                          style: style.meta,
                          children: `${authorityLabels[source.authority]} · ${source.compression} · ${String(source.tokens)} tokens${source.redactedRefCount > 0 ? ` · ${String(source.redactedRefCount)} 个受限引用` : ""} · ${source.selectionReason}`,
                        }),
                        source.sourceRefs.length === 0
                          ? null
                          : h("div", {
                              key: "refs",
                              style: style.code,
                              children: source.sourceRefs
                                .map(
                                  (ref) =>
                                    `${ref.type}:${ref.id}${ref.version ? `@${ref.version}` : ""}`,
                                )
                                .join("\n"),
                            }),
                      ]),
                    ),
                  ),
                  selected.receipt.excluded.length === 0
                    ? null
                    : h("div", { key: "excluded", style: style.source }, [
                        h("strong", { children: "排除来源" }),
                        h("div", {
                          style: style.code,
                          children: selected.receipt.excluded
                            .map(
                              (item) =>
                                `${item.safeLabel ?? item.sourceId ?? "unknown"} · ${item.reason}`,
                            )
                            .join("\n"),
                        }),
                      ]),
                ]),
          ),
        ]),
      ]);
    }

    exports.inject = ["slots"];
    exports.apply = (ctx) =>
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "pluginmax-context-center",
            order: 79,
            label: () => "上下文装配",
            inject: () => ({}),
          },
          () => h(ContextReceiptSection),
        ),
      );

    return module.exports;
  },
});
