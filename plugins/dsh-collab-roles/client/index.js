window.__ModuleLoader__.load({
  id: "dsh-collab-roles",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");

    const TOKEN_KEY = "pluginmax.collab.token";
    const inputStyle = {
      background: "var(--dsw-alias-bg-base)",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: 6,
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
      minWidth: 0,
      padding: "7px 9px",
      width: "100%",
    };
    const buttonStyle = {
      background: "var(--dsw-alias-button-primary-fill)",
      border: 0,
      borderRadius: 6,
      color: "var(--dsw-alias-label-primary-foreground)",
      cursor: "pointer",
      display: "inline-flex",
      font: "inherit",
      gap: 6,
      padding: "7px 12px",
    };
    const secondaryButtonStyle = {
      ...buttonStyle,
      background: "transparent",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      color: "var(--dsw-alias-label-primary)",
    };
    const iconButtonStyle = {
      alignItems: "center",
      background: "transparent",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: 6,
      color: "var(--dsw-alias-label-secondary)",
      cursor: "pointer",
      display: "inline-flex",
      flex: "0 0 auto",
      height: 36,
      justifyContent: "center",
      width: 36,
    };
    const panelStyle = {
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      display: "grid",
      gap: 12,
      paddingTop: 16,
    };
    const tableStyle = {
      borderCollapse: "collapse",
      fontSize: 13,
      minWidth: "100%",
      tableLayout: "fixed",
      width: "100%",
    };
    const cellStyle = {
      borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
      padding: "7px 9px",
      textAlign: "left",
      verticalAlign: "top",
      overflowWrap: "anywhere",
    };

    function getToken() {
      return window.localStorage.getItem(TOKEN_KEY);
    }

    async function request(path, options = {}) {
      const token = getToken();
      const headers = { ...options.headers };
      if (options.body !== undefined)
        headers["content-type"] = "application/json";
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const response = await fetch(path, {
        ...options,
        headers,
        cache: "no-store",
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const error = new Error(
          body?.error?.message ?? `HTTP ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function Field({ id, label, value, onChange, ...rest }) {
      return jsxRuntime.jsxs("label", {
        htmlFor: id,
        style: {
          color: "var(--dsw-alias-label-secondary)",
          display: "grid",
          fontSize: 13,
          gap: 5,
        },
        children: [
          jsxRuntime.jsx("span", { children: label }),
          jsxRuntime.jsx("input", {
            id,
            name: id,
            style: inputStyle,
            value,
            onChange,
            ...rest,
          }),
        ],
      });
    }

    function Area({ id, label, value, onChange, rows = 6, ...rest }) {
      return jsxRuntime.jsxs("label", {
        htmlFor: id,
        style: {
          color: "var(--dsw-alias-label-secondary)",
          display: "grid",
          fontSize: 13,
          gap: 5,
        },
        children: [
          jsxRuntime.jsx("span", { children: label }),
          jsxRuntime.jsx("textarea", {
            id,
            name: id,
            rows,
            style: { ...inputStyle, resize: "vertical" },
            value,
            onChange,
            ...rest,
          }),
        ],
      });
    }

    function Panel({ title, action, children }) {
      return jsxRuntime.jsxs("section", {
        style: panelStyle,
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              alignItems: "center",
              display: "flex",
              gap: 10,
              justifyContent: "space-between",
            },
            children: [
              jsxRuntime.jsx("h3", {
                style: { fontSize: 15, margin: 0 },
                children: title,
              }),
              action,
            ],
          }),
          children,
        ],
      });
    }

    function Table({ headers, rows, empty }) {
      if (rows.length === 0) {
        return jsxRuntime.jsx("p", {
          style: {
            color: "var(--dsw-alias-label-secondary)",
            fontSize: 13,
            margin: 0,
          },
          children: empty,
        });
      }
      return jsxRuntime.jsxs("table", {
        style: tableStyle,
        children: [
          jsxRuntime.jsx("thead", {
            children: jsxRuntime.jsx("tr", {
              children: headers.map((header) =>
                jsxRuntime.jsx(
                  "th",
                  { style: cellStyle, children: header },
                  header,
                ),
              ),
            }),
          }),
          jsxRuntime.jsx("tbody", { children: rows }),
        ],
      });
    }

    function workspaceLabel(workspace) {
      const title = workspace.title?.trim();
      const path = workspace.path?.trim();
      if (title && path) return `${title} (${path})`;
      if (path) return path;
      if (title) return title;
      return `未知工作区 (${workspace.id.slice(0, 8)})`;
    }

    function localTime(value) {
      const time = new Date(value);
      if (Number.isNaN(time.getTime())) return value;
      return time.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }

    function InfoIcon() {
      return jsxRuntime.jsx("svg", {
        "aria-hidden": true,
        fill: "none",
        height: 16,
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeWidth: 1.8,
        viewBox: "0 0 24 24",
        width: 16,
        children: [
          jsxRuntime.jsx("circle", { cx: 12, cy: 12, r: 9 }, "circle"),
          jsxRuntime.jsx("path", { d: "M12 11v5" }, "stem"),
          jsxRuntime.jsx("path", { d: "M12 8h.01" }, "dot"),
        ],
      });
    }

    function CopyIcon() {
      return jsxRuntime.jsx("svg", {
        "aria-hidden": true,
        fill: "none",
        height: 14,
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeWidth: 1.8,
        viewBox: "0 0 24 24",
        width: 14,
        children: [
          jsxRuntime.jsx(
            "rect",
            { height: 12, rx: 2, width: 12, x: 9, y: 9 },
            "front",
          ),
          jsxRuntime.jsx(
            "path",
            { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" },
            "back",
          ),
        ],
      });
    }

    const RolesSection = () => {
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [message, setMessage] = react.useState("");
      const [workspaceId, setWorkspaceId] = react.useState("main");
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceInfoOpen, setWorkspaceInfoOpen] = react.useState(false);
      const [personas, setPersonas] = react.useState([]);
      const [types, setTypes] = react.useState([]);
      const [config, setConfig] = react.useState(null);
      const [seats, setSeats] = react.useState([]);
      const [viewer, setViewer] = react.useState(null);
      const [currentUser, setCurrentUser] = react.useState(null);
      const [persona, setPersona] = react.useState({
        id: "",
        name: "",
        description: "",
        tags: "",
        soul: "",
      });
      const [personaSaving, setPersonaSaving] = react.useState(false);
      const personaSavingRef = react.useRef(false);
      const [type, setType] = react.useState({
        id: "",
        name: "",
        description: "",
        seatsJson:
          '[{"id":"leader","label":"负责人","participantKind":"human","permissions":["read","write","approve"]}]',
      });
      const [claimSeat, setClaimSeat] = react.useState("");
      const claimableSeats = (config?.seats ?? []).filter((seat) => {
        if (seat.participantKind !== "human" && seat.participantKind !== "any")
          return false;
        // 项目角色是多人集合：已经有人在角色上，也不挡新成员加入。
        return true;
      });
      const seatStatus = (status) => {
        if (status === "claimed") return "已认领";
        if (status === "assigned") return "已指派";
        if (status === "released") return "已释放";
        return status;
      };
      const canRelease = (item) => {
        if (item.status === "released") return false;
        const isManager =
          viewer?.globalRole === "admin" || viewer?.workspaceRole === "owner";
        return (
          isManager ||
          (item.assigneeKind === "user" && item.assigneeId === viewer?.id)
        );
      };
      const [materializeTypeId, setMaterializeTypeId] = react.useState("");
      const [materializeFeedback, setMaterializeFeedback] = react.useState({
        kind: "",
        text: "",
      });
      const [typeCreating, setTypeCreating] = react.useState(false);
      const [typeFeedback, setTypeFeedback] = react.useState({
        kind: "",
        text: "",
      });
      const canManageTypes = currentUser?.role === "admin";

      const notify = (text) => {
        setError("");
        setMessage(text);
      };

      const fail = (cause) => {
        setMessage("");
        setError(cause instanceof Error ? cause.message : String(cause));
      };

      const load = react.useCallback(async () => {
        if (getToken() === null) {
          setPhase("login");
          return;
        }
        const [personaResult, typeResult, workspaceResult, currentUserResult] =
          await Promise.all([
            request("/api/collab/roles/personas"),
            request("/api/collab/roles/types"),
            request("/api/collab/team/workspaces"),
            request("/api/collab/auth/me"),
          ]);
        setPersonas(personaResult.personas);
        setTypes(typeResult.types);
        setWorkspaces(workspaceResult.workspaces);
        setCurrentUser(currentUserResult.user);
        const selected = workspaceResult.workspaces.some(
          (workspace) => workspace.id === workspaceId,
        )
          ? workspaceId
          : (workspaceResult.workspaces[0]?.id ?? workspaceId);
        setWorkspaceId(selected);
        try {
          const seatResult = await request(
            `/api/collab/roles/seats?workspaceId=${encodeURIComponent(selected)}`,
          );
          setConfig(seatResult.config);
          setSeats(seatResult.seats);
          setViewer(seatResult.viewer ?? null);
        } catch {
          setConfig(null);
          setSeats([]);
          setViewer(null);
        }
        setPhase("ready");
      }, [workspaceId]);

      react.useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        load({ signal: controller.signal }).catch((cause) => {
          if (disposed || cause.name === "AbortError") return;
          if (cause.status === 401) setPhase("login");
          fail(cause);
          setPhase("error");
        });
        return () => {
          disposed = true;
          controller.abort();
        };
      }, [load]);

      const submitPersona = async (event) => {
        event.preventDefault();
        if (personaSavingRef.current) return;
        personaSavingRef.current = true;
        setPersonaSaving(true);
        try {
          const result = await request("/api/collab/roles/personas", {
            method: "POST",
            body: JSON.stringify({
              ...persona,
              tags: persona.tags
                .split(",")
                .map((tag) => tag.trim())
                .filter((tag) => tag !== ""),
            }),
          });
          notify(`已创建 ${result.persona.name}`);
          setPersona({ id: "", name: "", description: "", tags: "", soul: "" });
          await load();
        } catch (cause) {
          fail(cause);
        } finally {
          personaSavingRef.current = false;
          setPersonaSaving(false);
        }
      };

      const submitType = async (event) => {
        event.preventDefault();
        setTypeFeedback({ kind: "", text: "" });
        setTypeCreating(true);
        try {
          const parsedSeats = JSON.parse(type.seatsJson);
          const result = await request("/api/collab/roles/types", {
            method: "POST",
            body: JSON.stringify({ ...type, seats: parsedSeats }),
          });
          setTypeFeedback({
            kind: "success",
            text: `已创建 ${result.type.name}`,
          });
          await load();
        } catch (cause) {
          fail(cause);
          setTypeFeedback({
            kind: "error",
            text:
              cause.message === "admin role is required for type creation"
                ? "只有 admin 可以创建工作区类型。"
                : cause.message || "创建失败，请稍后重试。",
          });
        } finally {
          setTypeCreating(false);
        }
      };

      const materialize = async (typeId) => {
        setMaterializeTypeId(typeId);
        setMaterializeFeedback({ kind: "", text: "" });
        try {
          const result = await request("/api/collab/roles/materialize", {
            method: "POST",
            body: JSON.stringify({ workspaceId, typeId }),
          });
          setConfig(result.config);
          const seatResult = await request(
            `/api/collab/roles/seats?workspaceId=${encodeURIComponent(workspaceId)}`,
          );
          setSeats(seatResult.seats);
          notify(`已物化 ${result.config.typeName}`);
          setMaterializeFeedback({
            kind: "success",
            text: `已物化 ${result.config.typeName}，角色席位已刷新`,
          });
        } catch (cause) {
          fail(cause);
          setMaterializeFeedback({
            kind: "error",
            text:
              cause instanceof Error && cause.message !== ""
                ? cause.message
                : "物化失败，请稍后重试",
          });
        } finally {
          setMaterializeTypeId("");
        }
      };

      const claim = async () => {
        if (claimSeat === "") return;
        try {
          const result = await request("/api/collab/roles/seats/claim", {
            method: "POST",
            body: JSON.stringify({ workspaceId, seatId: claimSeat }),
          });
          notify(`已认领 ${result.seat.seatLabel}`);
          await load();
        } catch (cause) {
          fail(cause);
        }
      };

      const release = async (seatId) => {
        try {
          const result = await request("/api/collab/roles/seats/release", {
            method: "POST",
            body: JSON.stringify({ workspaceId, seatId }),
          });
          notify(`已释放 ${result.seat.seatLabel}`);
          await load();
        } catch (cause) {
          fail(cause);
        }
      };

      if (phase === "login") {
        return jsxRuntime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13 },
          children: "请先登录 Pluginmax",
        });
      }
      if (phase !== "ready" && phase !== "error") return null;

      return jsxRuntime.jsxs("div", {
        style: { display: "grid", gap: 12 },
        children: [
          message === "" ? null : jsxRuntime.jsx("p", { children: message }),
          error === ""
            ? null
            : jsxRuntime.jsx("p", {
                style: { color: "var(--dsw-alias-state-error-primary)" },
                children: error,
              }),
          jsxRuntime.jsxs("div", {
            style: { display: "grid", gap: 8 },
            children: [
              jsxRuntime.jsxs("div", {
                style: {
                  alignItems: "end",
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                },
                children: [
                  jsxRuntime.jsxs("label", {
                    htmlFor: "pluginmax-roles-workspace",
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      display: "grid",
                      fontSize: 13,
                      gap: 5,
                      minWidth: 0,
                    },
                    children: [
                      jsxRuntime.jsx("span", { children: "工作区" }),
                      jsxRuntime.jsx("select", {
                        id: "pluginmax-roles-workspace",
                        style: inputStyle,
                        value: workspaceId,
                        onChange: (event) => setWorkspaceId(event.target.value),
                        children: workspaces.map((workspace) =>
                          jsxRuntime.jsx(
                            "option",
                            {
                              value: workspace.id,
                              children: workspaceLabel(workspace),
                            },
                            workspace.id,
                          ),
                        ),
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    "aria-expanded": workspaceInfoOpen,
                    "aria-label": "工作区信息",
                    title: "工作区信息",
                    style: iconButtonStyle,
                    onClick: () => setWorkspaceInfoOpen((open) => !open),
                    children: jsxRuntime.jsx(InfoIcon, {}),
                  }),
                ],
              }),
              workspaceInfoOpen
                ? jsxRuntime.jsxs("div", {
                    "aria-label": "工作区详情",
                    role: "region",
                    style: {
                      alignItems: "start",
                      background: "var(--dsw-alias-bg-layer-2)",
                      border: "0.5px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      display: "grid",
                      gap: 8,
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      padding: 10,
                    },
                    children: [
                      jsxRuntime.jsxs("div", {
                        style: {
                          color: "var(--dsw-alias-label-secondary)",
                          display: "grid",
                          fontSize: 12,
                          gap: 4,
                          minWidth: 0,
                        },
                        children: [
                          jsxRuntime.jsxs("span", {
                            children: [
                              "名称：",
                              workspaces.find(
                                (workspace) => workspace.id === workspaceId,
                              )?.title || "未命名",
                            ],
                          }),
                          jsxRuntime.jsxs("span", {
                            style: { overflowWrap: "anywhere" },
                            children: [
                              "路径：",
                              workspaces.find(
                                (workspace) => workspace.id === workspaceId,
                              )?.path || "未知",
                            ],
                          }),
                          jsxRuntime.jsx("span", {
                            style: { overflowWrap: "anywhere" },
                            children: `工作区 ID：${workspaceId}`,
                          }),
                        ],
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        style: secondaryButtonStyle,
                        onClick: async () => {
                          try {
                            await navigator.clipboard.writeText(workspaceId);
                            notify("已复制工作区 ID");
                          } catch (cause) {
                            fail(cause);
                          }
                        },
                        children: [jsxRuntime.jsx(CopyIcon, {}), "复制 ID"],
                      }),
                    ],
                  })
                : null,
            ],
          }),
          jsxRuntime.jsxs(Panel, {
            title: "人设",
            children: [
              jsxRuntime.jsxs("form", {
                style: { display: "grid", gap: 9 },
                onSubmit: submitPersona,
                children: [
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-persona-id",
                    label: "标识",
                    value: persona.id,
                    onChange: (event) =>
                      setPersona((current) => ({
                        ...current,
                        id: event.target.value,
                      })),
                    required: true,
                  }),
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-persona-name",
                    label: "名称",
                    value: persona.name,
                    onChange: (event) =>
                      setPersona((current) => ({
                        ...current,
                        name: event.target.value,
                      })),
                    required: true,
                  }),
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-persona-tags",
                    label: "标签",
                    value: persona.tags,
                    onChange: (event) =>
                      setPersona((current) => ({
                        ...current,
                        tags: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx(Area, {
                    id: "pluginmax-persona-description",
                    label: "描述",
                    value: persona.description,
                    rows: 2,
                    onChange: (event) =>
                      setPersona((current) => ({
                        ...current,
                        description: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx(Area, {
                    id: "pluginmax-persona-soul",
                    label: "SOUL",
                    value: persona.soul,
                    onChange: (event) =>
                      setPersona((current) => ({
                        ...current,
                        soul: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    style: buttonStyle,
                    disabled: personaSaving,
                    children: personaSaving ? "创建中..." : "创建",
                  }),
                ],
              }),
              jsxRuntime.jsx(Table, {
                headers: ["标识", "名称", "标签", "更新时间"],
                rows: personas.map((item) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.id,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.name,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.tags.join(", "),
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          title: item.updatedAt,
                          children: localTime(item.updatedAt),
                        }),
                      ],
                    },
                    item.id,
                  ),
                ),
                empty: "暂无人设",
              }),
            ],
          }),
          jsxRuntime.jsxs(Panel, {
            title: "工作区类型",
            children: [
              jsxRuntime.jsx("p", {
                role: "note",
                style: {
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 13,
                  margin: 0,
                },
                children:
                  "工作区类型只用于空项目或尚未初始化项目角色的项目；已有项目角色请到「项目设置 → 项目角色」调整。",
              }),
              materializeFeedback.text === ""
                ? null
                : jsxRuntime.jsx("p", {
                    role: "status",
                    style: {
                      color:
                        materializeFeedback.kind === "error"
                          ? "var(--dsw-alias-state-error-primary)"
                          : "var(--dsw-alias-state-success-primary)",
                      fontSize: 13,
                      margin: 0,
                    },
                    children: materializeFeedback.text,
                  }),
              canManageTypes
                ? null
                : jsxRuntime.jsx("p", {
                    role: "note",
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                      margin: 0,
                    },
                    children:
                      "工作区类型是全局模板，只有 admin 可以创建。你可以查看现有类型，并在自己管理工作区时物化。",
                  }),
              typeFeedback.text === ""
                ? null
                : jsxRuntime.jsx("p", {
                    role: "status",
                    style: {
                      color:
                        typeFeedback.kind === "error"
                          ? "var(--dsw-alias-state-error-primary)"
                          : "var(--dsw-alias-state-success-primary)",
                      fontSize: 13,
                      fontWeight: typeFeedback.kind === "error" ? 600 : 500,
                      margin: 0,
                      overflowWrap: "anywhere",
                    },
                    children: typeFeedback.text,
                  }),
              jsxRuntime.jsxs("form", {
                style: {
                  display: "grid",
                  gap: 9,
                  opacity: canManageTypes ? 1 : 0.72,
                },
                onSubmit: submitType,
                children: [
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-type-id",
                    label: "标识",
                    value: type.id,
                    disabled: !canManageTypes || typeCreating,
                    onChange: (event) =>
                      setType((current) => ({
                        ...current,
                        id: event.target.value,
                      })),
                    required: true,
                  }),
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-type-name",
                    label: "名称",
                    value: type.name,
                    disabled: !canManageTypes || typeCreating,
                    onChange: (event) =>
                      setType((current) => ({
                        ...current,
                        name: event.target.value,
                      })),
                    required: true,
                  }),
                  jsxRuntime.jsx(Area, {
                    id: "pluginmax-type-seats",
                    label: "席位 JSON",
                    value: type.seatsJson,
                    rows: 5,
                    disabled: !canManageTypes || typeCreating,
                    onChange: (event) =>
                      setType((current) => ({
                        ...current,
                        seatsJson: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    style: buttonStyle,
                    disabled: !canManageTypes || typeCreating,
                    children: "创建",
                  }),
                ],
              }),
              jsxRuntime.jsx(Table, {
                headers: ["标识", "名称", "席位数", "操作"],
                rows: types.map((item) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.id,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.name,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.seats.length,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: jsxRuntime.jsx("button", {
                            type: "button",
                            style: secondaryButtonStyle,
                            disabled: materializeTypeId !== "",
                            title:
                              "仅用于尚未初始化项目角色的项目；已有项目角色请到项目设置中调整",
                            onClick: () => materialize(item.id),
                            children:
                              materializeTypeId === item.id
                                ? "物化中..."
                                : "物化",
                          }),
                        }),
                      ],
                    },
                    item.id,
                  ),
                ),
                empty: "暂无类型",
              }),
            ],
          }),
          jsxRuntime.jsxs(Panel, {
            title: "角色席位",
            action: jsxRuntime.jsxs("div", {
              style: { display: "flex", gap: 8 },
              children: [
                jsxRuntime.jsx("select", {
                  "aria-label": "选择可认领席位",
                  disabled: config === null || claimableSeats.length === 0,
                  style: { ...inputStyle, width: 180 },
                  value: claimSeat,
                  onChange: (event) => setClaimSeat(event.target.value),
                  children: [
                    jsxRuntime.jsx("option", {
                      value: "",
                      children:
                        config === null
                          ? "请先物化工作区类型"
                          : claimableSeats.length === 0
                            ? "暂无可认领席位"
                            : "选择席位",
                    }),
                    ...claimableSeats.map((seat) =>
                      jsxRuntime.jsx(
                        "option",
                        { value: seat.id, children: seat.label },
                        seat.id,
                      ),
                    ),
                  ],
                }),
                jsxRuntime.jsx("button", {
                  type: "button",
                  style: buttonStyle,
                  disabled: claimSeat === "",
                  onClick: claim,
                  children: "认领",
                }),
              ],
            }),
            children: [
              config === null
                ? jsxRuntime.jsx("p", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                      margin: 0,
                    },
                    children:
                      "当前工作区未物化。上面的「3 个席位」仍是类型模板；点击该类型的「物化」后，这里才会生成可认领席位。",
                  })
                : jsxRuntime.jsx(Table, {
                    headers: [
                      "席位",
                      "状态",
                      "担任者",
                      "人设",
                      "Leader",
                      "操作",
                    ],
                    rows: seats.map((item) =>
                      jsxRuntime.jsxs(
                        "tr",
                        {
                          children: [
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.seatLabel,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: seatStatus(item.status),
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: `${item.assigneeKind}/${item.assigneeId}`,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.personaId ?? "-",
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.leader ? "是" : "否",
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: canRelease(item)
                                ? jsxRuntime.jsx("button", {
                                    type: "button",
                                    style: secondaryButtonStyle,
                                    onClick: () => release(item.seatId),
                                    children: "释放",
                                  })
                                : jsxRuntime.jsx("span", {
                                    style: {
                                      color: "var(--dsw-alias-label-secondary)",
                                    },
                                    children: "-",
                                  }),
                            }),
                          ],
                        },
                        item.id,
                      ),
                    ),
                    empty: "暂无在任者",
                  }),
            ],
          }),
        ],
      });
    };

    exports.inject = ["slots"];
    exports.apply = (ctx) =>
      ctx.slots.inject("pluginmax.account-access.tab", () =>
        ctx.slots.register(
          {
            name: "pluginmax.account-access.tab",
            id: "roles",
            order: 20,
            label: () => "角色",
          },
          () => jsxRuntime.jsx(RolesSection, {}),
        ),
      );

    return module.exports;
  },
});
