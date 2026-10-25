window.__ModuleLoader__.load({
  id: "dsh-collab-space",
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
      alignItems: "center",
      background: "var(--dsw-alias-button-primary-fill)",
      border: 0,
      borderRadius: 6,
      color: "var(--dsw-alias-label-primary-foreground)",
      cursor: "pointer",
      display: "inline-flex",
      font: "inherit",
      gap: 6,
      justifyContent: "center",
      padding: "7px 12px",
      whiteSpace: "nowrap",
    };
    const secondaryButtonStyle = {
      ...buttonStyle,
      background: "transparent",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      color: "var(--dsw-alias-label-primary)",
    };
    const disabledButtonStyle = {
      ...secondaryButtonStyle,
      cursor: "not-allowed",
      opacity: 0.55,
    };
    const panelStyle = {
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      display: "grid",
      gap: 12,
      paddingTop: 16,
    };
    const formStyle = {
      alignItems: "end",
      display: "grid",
      gap: 9,
      gridTemplateColumns: "minmax(120px, 1fr) minmax(120px, 1fr)",
    };
    const tableStyle = {
      borderCollapse: "collapse",
      fontSize: 13,
      tableLayout: "fixed",
      minWidth: "100%",
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
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
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
        error.code = body?.error?.code;
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

    function Area({ id, label, value, onChange, rows = 6 }) {
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
                  {
                    style: cellStyle,
                    children: header,
                  },
                  header,
                ),
              ),
            }),
          }),
          jsxRuntime.jsx("tbody", {
            children: rows,
          }),
        ],
      });
    }

    function workspaceLabel(workspace) {
      const shortId = workspace.id.slice(0, 8);
      const title = workspace.title?.trim();
      const path = workspace.path?.trim();
      if (title && path) return `${title} (${path})`;
      if (path) return `${path} (${shortId})`;
      if (title) return title;
      return `未知工作区 (${shortId})`;
    }

    function formatTime(value) {
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
        height: 14,
        stroke: "currentColor",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeWidth: 1.8,
        viewBox: "0 0 24 24",
        width: 14,
        children: [
          jsxRuntime.jsx("circle", { cx: 12, cy: 12, r: 9 }, "circle"),
          jsxRuntime.jsx("path", { d: "M12 11v5" }, "stem"),
          jsxRuntime.jsx("path", { d: "M12 8h.01" }, "dot"),
        ],
      });
    }

    function shortSession(value) {
      if (typeof value !== "string") return "-";
      const withoutPrefix = value.startsWith("browser:")
        ? value.slice("browser:".length)
        : value;
      return withoutPrefix.slice(0, 8);
    }

    function lockSourceLabel(lock, workspace) {
      const sessionKind = lock.ownerSessionId?.startsWith("browser:")
        ? "浏览器登录会话"
        : "会话";
      const workspaceTitle =
        workspace?.title?.trim() || workspace?.path || lock.workspaceId;
      return `${workspaceTitle} / ${lock.ownerId} / ${sessionKind} (${shortSession(lock.ownerSessionId)})`;
    }

    function friendlyError(cause, context = {}) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("path must use normalized forward-slash segments")) {
        return "路径格式不合法：路径必须是规范化目录，不能包含空段、`.` 或 `..`。";
      }
      if (message === "request input is invalid") return "输入内容格式不正确。";
      if (message.startsWith("global request is already pending: ")) {
        return "这个全局路径已有待审批申请，请等待管理员处理后再提交。";
      }
      if (message === "workspace sharing permission is required") {
        return "当前账号没有这个工作区的共享权限。请到「账号与权限 → 登录账号」确认账号，并在项目管理中加入该工作区。";
      }
      if (message === "invalid or expired token")
        return "登录状态已过期，请到「账号与权限 → 登录账号」重新登录。";
      if (message === "bearer token is required")
        return "请先到「账号与权限 → 登录账号」登录。";
      if (message.startsWith("locked by ")) {
        const match = message.match(/^locked by (.+?) until (.+)$/);
        if (match) {
          const workspaceTitle =
            context.workspaceTitle?.trim() ||
            context.workspaceId ||
            "当前工作区";
          return `这个路径已被「${workspaceTitle} / ${match[1]}」的登录会话锁定，到期时间：${formatTime(match[2])}。请等锁到期，或联系持有者释放。`;
        }
      }
      if (message === "lock owner or admin role is required") {
        return "只有锁持有者或管理员可以释放这个锁。";
      }
      return message;
    }

    const SpaceSection = () => {
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [message, setMessage] = react.useState("");
      const [me, setMe] = react.useState(null);
      const [workspaceId, setWorkspaceId] = react.useState("main");
      const [workspaces, setWorkspaces] = react.useState([]);
      const [config, setConfig] = react.useState(null);
      const [files, setFiles] = react.useState([]);
      const [policies, setPolicies] = react.useState([]);
      const [locks, setLocks] = react.useState([]);
      const [digests, setDigests] = react.useState([]);
      const [events, setEvents] = react.useState([]);
      const [globalRequests, setGlobalRequests] = react.useState([]);
      const [decisionPendingId, setDecisionPendingId] = react.useState("");
      const [fileContent, setFileContent] = react.useState("");
      const [upload, setUpload] = react.useState({
        path: "docs/readme.md",
        scope: "workspace",
        content: "",
      });
      const [uploadFeedback, setUploadFeedback] = react.useState(null);
      const [uploadPending, setUploadPending] = react.useState(false);
      const [policyPending, setPolicyPending] = react.useState(false);
      const policyPendingRef = react.useRef(false);
      const [policy, setPolicy] = react.useState({
        pattern: "workspace/docs/*.md",
        scope: "workspace",
        permissions: "read",
        effect: "allow",
      });
      const [lockPath, setLockPath] = react.useState("docs/readme.md");
      const [lockFeedback, setLockFeedback] = react.useState(null);
      const [lockPendingAction, setLockPendingAction] = react.useState("");
      const [lockInfoKey, setLockInfoKey] = react.useState("");

      const notify = (text) => {
        setError("");
        setMessage(text);
        setUploadFeedback(null);
        setLockFeedback(null);
      };

      const fail = (cause) => {
        setMessage("");
        setError(friendlyError(cause));
      };

      const load = react.useCallback(async () => {
        const token = getToken();
        if (token === null) {
          setPhase("login");
          return;
        }
        const current = await request("/api/collab/auth/me");
        setMe(current.user);
        const workspaceResult = await request("/api/collab/space/workspaces");
        setWorkspaces(workspaceResult.workspaces);
        const selected = workspaceResult.workspaces.some(
          (item) => item.id === workspaceId,
        )
          ? workspaceId
          : (workspaceResult.workspaces[0]?.id ?? workspaceId);
        setWorkspaceId(selected);
        const query = `workspaceId=${encodeURIComponent(selected)}`;
        const [
          configResult,
          fileResult,
          policyResult,
          lockResult,
          digestResult,
          auditResult,
        ] = await Promise.all([
          request(`/api/collab/space/config?${query}`),
          request(`/api/collab/space/files?${query}`),
          request(`/api/collab/space/policies?${query}`),
          request(`/api/collab/space/locks?${query}`),
          request(`/api/collab/space/digests?${query}`),
          request(`/api/collab/space/audit?${query}&limit=100`),
        ]);
        setConfig(configResult.config);
        setFiles(fileResult.files);
        setPolicies(policyResult.policies);
        setLocks(lockResult.locks);
        setDigests(digestResult.digests);
        setEvents(auditResult.events);
        if (current.user.role === "admin") {
          const globalResult = await request(
            "/api/collab/space/global/requests",
          );
          setGlobalRequests(globalResult.requests);
        } else {
          setGlobalRequests([]);
        }
        setPhase("ready");
      }, [workspaceId]);

      react.useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        load({
          signal: controller.signal,
        }).catch((cause) => {
          if (disposed || cause.name === "AbortError") return;
          if (cause.status === 401) {
            setToken(undefined);
            setMe(null);
            setError("");
            setPhase("login");
            return;
          }
          fail(cause);
          setPhase("error");
        });
        return () => {
          disposed = true;
          controller.abort();
        };
      }, [load]);

      const submitUpload = async (event) => {
        event.preventDefault();
        setMessage("");
        setError("");
        setUploadPending(true);
        setUploadFeedback({ kind: "info", message: "正在提交共享内容..." });
        try {
          const result = await request("/api/collab/space/files", {
            method: "POST",
            body: JSON.stringify({ workspaceId, ...upload }),
          });
          setUploadFeedback({
            kind: "success",
            message:
              result.request === undefined
                ? `已共享 ${result.file.path}`
                : `全局共享已提交审批，等待管理员审批。申请 ID：${result.request.id}`,
          });
          setUpload((current) => ({ ...current, content: "" }));
          try {
            await load();
          } catch (refreshCause) {
            setError(friendlyError(refreshCause));
          }
        } catch (cause) {
          setUploadFeedback({
            kind: "error",
            message: friendlyError(cause),
          });
        } finally {
          setUploadPending(false);
        }
      };

      const readFile = async (path) => {
        try {
          const result = await request("/api/collab/space/file/read", {
            method: "POST",
            body: JSON.stringify({ workspaceId, path }),
          });
          setFileContent(result.content);
          notify(`已读取 ${path}`);
        } catch (cause) {
          fail(cause);
        }
      };

      const submitPolicy = async (event) => {
        event.preventDefault();
        if (policyPendingRef.current) return;
        policyPendingRef.current = true;
        setPolicyPending(true);
        try {
          await request("/api/collab/space/policies", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              pattern: policy.pattern,
              scope: policy.scope,
              permissions: policy.permissions.split(","),
              effect: policy.effect,
            }),
          });
          notify("共享策略已添加");
          await load();
        } catch (cause) {
          fail(cause);
        } finally {
          policyPendingRef.current = false;
          setPolicyPending(false);
        }
      };

      const lockAction = async (action) => {
        if (lockPendingAction !== "") return;
        const actionLabel = action === "acquire" ? "加锁" : "释放";
        setMessage("");
        setError("");
        setLockFeedback({ kind: "info", message: `正在${actionLabel}...` });
        setLockPendingAction(action);
        try {
          const result = await request(`/api/collab/space/locks/${action}`, {
            method: "POST",
            body: JSON.stringify({ workspaceId, path: lockPath }),
          });
          if (action === "acquire") {
            setLocks((current) =>
              [
                ...current.filter((lock) => lock.key !== result.lock.key),
                result.lock,
              ].sort((left, right) => left.path.localeCompare(right.path)),
            );
            setLockFeedback({
              kind: "success",
              message: `已锁定 ${result.lock.path}，到期时间：${formatTime(result.lock.expiresAt)}`,
            });
          } else {
            setLocks((current) =>
              current.filter(
                (lock) =>
                  !(
                    lock.workspaceId === workspaceId && lock.path === lockPath
                  ),
              ),
            );
            setLockFeedback({
              kind: "success",
              message: result.released
                ? `已释放 ${lockPath}`
                : `${lockPath} 当前没有活跃锁`,
            });
          }
          try {
            await load();
          } catch (refreshCause) {
            setLockFeedback({
              kind: "info",
              message: `操作已完成，但刷新列表失败：${friendlyError(refreshCause)}`,
            });
          }
        } catch (cause) {
          setLockFeedback({
            kind: "error",
            message: friendlyError(cause, {
              workspaceId,
              workspaceTitle: workspaces.find(
                (workspace) => workspace.id === workspaceId,
              )?.title,
            }),
          });
        } finally {
          setLockPendingAction("");
        }
      };

      const decideGlobal = async (requestId, approve) => {
        setDecisionPendingId(requestId);
        try {
          await request("/api/collab/space/global/requests/decision", {
            method: "POST",
            body: JSON.stringify({ requestId, approve }),
          });
          notify(approve ? "全局共享已批准" : "全局共享已拒绝");
          await load();
        } catch (cause) {
          fail(cause);
        } finally {
          setDecisionPendingId("");
        }
      };

      if (phase === "loading") {
        return jsxRuntime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)" },
          children: "正在加载共享区...",
        });
      }
      if (phase === "login") {
        return jsxRuntime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)" },
          children: "请先在「账号与权限 → 登录账号」登录。",
        });
      }

      return jsxRuntime.jsxs("div", {
        style: { display: "grid", gap: 12 },
        children: [
          error === ""
            ? null
            : jsxRuntime.jsx("p", {
                style: { color: "var(--dsw-alias-state-error-primary)", margin: 0 },
                children: error,
              }),
          me === null
            ? null
            : jsxRuntime.jsxs("p", {
                style: {
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 13,
                  margin: 0,
                },
                children: [
                  "当前身份：",
                  jsxRuntime.jsx("strong", { children: me.name }),
                  `（${me.id} · ${me.role}）`,
                ],
              }),
          message === ""
            ? null
            : jsxRuntime.jsx("p", {
                style: { color: "var(--dsw-alias-state-success-primary)", margin: 0 },
                children: message,
              }),
          jsxRuntime.jsxs("div", {
            style: {
              alignItems: "end",
              display: "flex",
              gap: 9,
              flexWrap: "wrap",
            },
            children: [
              jsxRuntime.jsx("label", {
                style: {
                  color: "var(--dsw-alias-label-secondary)",
                  display: "grid",
                  fontSize: 13,
                  gap: 5,
                },
                children: [
                  jsxRuntime.jsx("span", { children: "工作区" }),
                  jsxRuntime.jsx("select", {
                    style: { ...inputStyle, width: "min(460px, 100%)" },
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
              jsxRuntime.jsx("span", {
                style: {
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 12,
                  minWidth: "100%",
                  overflowWrap: "anywhere",
                },
                children: `当前目录：${
                  workspaces.find((item) => item.id === workspaceId)?.path ??
                  "未知工作区"
                }`,
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                style: secondaryButtonStyle,
                onClick: () => load().catch(fail),
                children: "刷新",
              }),
            ],
          }),
          config === null
            ? null
            : jsxRuntime.jsxs("p", {
                style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13, margin: 0 },
                children: [
                  `默认范围：${config.defaultScope}`,
                  config.enabled ? "，共享已启用" : "，共享已停用",
                ],
              }),
          jsxRuntime.jsxs(Panel, {
            title: "上传与文档",
            children: [
              uploadFeedback === null
                ? null
                : jsxRuntime.jsx("p", {
                    role: uploadFeedback.kind === "error" ? "alert" : "status",
                    style: {
                      color:
                        uploadFeedback.kind === "error"
                          ? "var(--dsw-alias-state-error-primary)"
                          : uploadFeedback.kind === "success"
                            ? "var(--dsw-alias-state-success-primary)"
                            : "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                      fontWeight:
                        uploadFeedback.kind === "info" ? 400 : 600,
                      margin: 0,
                      overflowWrap: "anywhere",
                    },
                    children: uploadFeedback.message,
                  }),
              jsxRuntime.jsxs("form", {
                style: formStyle,
                onSubmit: submitUpload,
                children: [
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-space-path",
                    label: "路径",
                    value: upload.path,
                    onChange: (event) =>
                      setUpload((current) => ({
                        ...current,
                        path: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("label", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      display: "grid",
                      fontSize: 13,
                      gap: 5,
                    },
                    children: [
                      jsxRuntime.jsx("span", { children: "范围" }),
                      jsxRuntime.jsx("select", {
                        style: inputStyle,
                        value: upload.scope,
                        onChange: (event) =>
                          setUpload((current) => ({
                            ...current,
                            scope: event.target.value,
                          })),
                        children: ["session", "workspace", "global"].map(
                          (scope) =>
                            jsxRuntime.jsx(
                              "option",
                              { value: scope, children: scope },
                              scope,
                            ),
                        ),
                      }),
                    ],
                  }),
                  jsxRuntime.jsx(Area, {
                    id: "pluginmax-space-content",
                    label: "内容",
                    value: upload.content,
                    onChange: (event) =>
                      setUpload((current) => ({
                        ...current,
                        content: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    style: buttonStyle,
                    disabled: uploadPending,
                    children: uploadPending ? "提交中..." : "上传",
                  }),
                ],
              }),
              jsxRuntime.jsx(Table, {
                headers: ["路径", "范围", "大小", "更新时间", "来源", "操作"],
                rows: files.map((file) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: file.path,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: file.scope,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: file.size,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          title: file.updatedAt,
                          children: formatTime(file.updatedAt),
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: file.source,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: jsxRuntime.jsx("button", {
                            type: "button",
                            style: secondaryButtonStyle,
                            onClick: () => readFile(file.path),
                            children: "读取",
                          }),
                        }),
                      ],
                    },
                    file.path,
                  ),
                ),
                empty: "暂无共享文档",
              }),
              fileContent === ""
                ? null
                : jsxRuntime.jsx("pre", {
                    style: {
                      background: "var(--dsw-alias-bg-layer-2)",
                      border: "1px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      margin: 0,
                      maxHeight: 260,
                      overflow: "auto",
                      padding: 10,
                      whiteSpace: "pre-wrap",
                    },
                    children: fileContent,
                  }),
            ],
          }),
          jsxRuntime.jsxs(Panel, {
            title: "策略",
            children: [
              jsxRuntime.jsxs("form", {
                style: formStyle,
                onSubmit: submitPolicy,
                children: [
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-policy-pattern",
                    label: "匹配",
                    value: policy.pattern,
                    onChange: (event) =>
                      setPolicy((current) => ({
                        ...current,
                        pattern: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("label", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      display: "grid",
                      fontSize: 13,
                      gap: 5,
                    },
                    children: [
                      jsxRuntime.jsx("span", { children: "范围" }),
                      jsxRuntime.jsx("select", {
                        style: inputStyle,
                        value: policy.scope,
                        onChange: (event) =>
                          setPolicy((current) => ({
                            ...current,
                            scope: event.target.value,
                          })),
                        children: ["session", "workspace", "global"].map(
                          (scope) =>
                            jsxRuntime.jsx(
                              "option",
                              { value: scope, children: scope },
                              scope,
                            ),
                        ),
                      }),
                    ],
                  }),
                  jsxRuntime.jsx(Field, {
                    id: "pluginmax-policy-permissions",
                    label: "权限",
                    value: policy.permissions,
                    onChange: (event) =>
                      setPolicy((current) => ({
                        ...current,
                        permissions: event.target.value,
                      })),
                  }),
                  jsxRuntime.jsx("label", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      display: "grid",
                      fontSize: 13,
                      gap: 5,
                    },
                    children: [
                      jsxRuntime.jsx("span", { children: "效果" }),
                      jsxRuntime.jsx("select", {
                        style: inputStyle,
                        value: policy.effect,
                        onChange: (event) =>
                          setPolicy((current) => ({
                            ...current,
                            effect: event.target.value,
                          })),
                        children: ["allow", "deny"].map((effect) =>
                          jsxRuntime.jsx(
                            "option",
                            { value: effect, children: effect },
                            effect,
                          ),
                        ),
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    style: buttonStyle,
                    disabled: policyPending,
                    children: policyPending ? "添加中..." : "添加",
                  }),
                ],
              }),
              jsxRuntime.jsx(Table, {
                headers: ["匹配", "范围", "权限", "效果", "过期"],
                rows: policies.map((item) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.pattern,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.scope,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.permissions.join(","),
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.effect,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          title: item.expiresAt || undefined,
                          children: item.expiresAt
                            ? formatTime(item.expiresAt)
                            : "-",
                        }),
                      ],
                    },
                    item.id,
                  ),
                ),
                empty: "暂无策略",
              }),
            ],
          }),
          jsxRuntime.jsxs(Panel, {
            title: "咨询锁",
            action: jsxRuntime.jsxs("div", {
              style: { display: "flex", gap: 8 },
              children: [
                jsxRuntime.jsx("button", {
                  type: "button",
                  disabled: lockPendingAction !== "",
                  style:
                    lockPendingAction === "acquire"
                      ? disabledButtonStyle
                      : buttonStyle,
                  onClick: () => lockAction("acquire"),
                  children: lockPendingAction === "acquire" ? "锁定中..." : "加锁",
                }),
                jsxRuntime.jsx("button", {
                  type: "button",
                  disabled: lockPendingAction !== "",
                  style:
                    lockPendingAction === "release"
                      ? disabledButtonStyle
                      : secondaryButtonStyle,
                  onClick: () => lockAction("release"),
                  children: lockPendingAction === "release" ? "释放中..." : "释放",
                }),
              ],
            }),
            children: [
              lockFeedback === null
                ? null
                : jsxRuntime.jsx("p", {
                    role: lockFeedback.kind === "error" ? "alert" : "status",
                    style: {
                      color:
                        lockFeedback.kind === "error"
                          ? "var(--dsw-alias-state-error-primary)"
                          : lockFeedback.kind === "success"
                            ? "var(--dsw-alias-state-success-primary)"
                            : "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                      fontWeight: lockFeedback.kind === "info" ? 400 : 600,
                      margin: 0,
                      overflowWrap: "anywhere",
                    },
                    children: lockFeedback.message,
                  }),
              Field({
                id: "pluginmax-lock-path",
                label: "路径",
                value: lockPath,
                disabled: lockPendingAction !== "",
                onChange: (event) => setLockPath(event.target.value),
              }),
              jsxRuntime.jsx(Table, {
                headers: ["路径", "来源", "到期时间"],
                rows: locks.map((lock) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: { ...cellStyle, width: "30%" },
                          children: lock.path,
                        }),
                        jsxRuntime.jsx("td", {
                          style: { ...cellStyle, width: "54%" },
                          children: jsxRuntime.jsxs("div", {
                            style: { display: "grid", gap: 6 },
                            children: [
                              jsxRuntime.jsxs("div", {
                                style: {
                                  alignItems: "center",
                                  display: "flex",
                                  gap: 6,
                                },
                                children: [
                                  jsxRuntime.jsx("span", {
                                    title: lock.ownerSessionId,
                                    children: lockSourceLabel(
                                      lock,
                                      workspaces.find(
                                        (workspace) =>
                                          workspace.id === lock.workspaceId,
                                      ),
                                    ),
                                  }),
                                  jsxRuntime.jsx("button", {
                                    type: "button",
                                    "aria-expanded": lockInfoKey === lock.key,
                                    "aria-label": "锁来源详情",
                                    title: "锁来源详情",
                                    style: {
                                      ...iconButtonStyle,
                                      height: 24,
                                      width: 24,
                                    },
                                    onClick: () =>
                                      setLockInfoKey((current) =>
                                        current === lock.key ? "" : lock.key,
                                      ),
                                    children: jsxRuntime.jsx(InfoIcon, {}),
                                  }),
                                ],
                              }),
                              lockInfoKey === lock.key
                                ? jsxRuntime.jsxs("div", {
                                    style: {
                                      color:
                                        "var(--dsw-alias-label-secondary)",
                                      display: "grid",
                                      fontSize: 12,
                                      gap: 3,
                                    },
                                    children: [
                                      jsxRuntime.jsx("span", {
                                        children: `来源类型：${
                                          lock.ownerSessionId?.startsWith(
                                            "browser:",
                                          )
                                            ? "浏览器登录会话"
                                            : "Pluginmax 会话"
                                        }`,
                                      }),
                                      jsxRuntime.jsx("span", {
                                        style: { overflowWrap: "anywhere" },
                                        children: `完整会话标识：${lock.ownerSessionId}`,
                                      }),
                                      jsxRuntime.jsx("span", {
                                        children: `加锁时间：${formatTime(lock.acquiredAt)}`,
                                      }),
                                    ],
                                  })
                                : null,
                            ],
                          }),
                        }),
                        jsxRuntime.jsx("td", {
                          style: { ...cellStyle, width: "16%" },
                          children: formatTime(lock.expiresAt),
                        }),
                      ],
                    },
                    lock.key,
                  ),
                ),
                empty: "当前没有活跃锁",
              }),
            ],
          }),
          me?.role === "admin"
            ? jsxRuntime.jsxs(Panel, {
                title: "全局审批",
                children: [
                  jsxRuntime.jsx(Table, {
                    headers: ["路径", "提交者", "大小", "状态", "操作"],
                    rows: globalRequests.map((item) =>
                      jsxRuntime.jsxs(
                        "tr",
                        {
                          children: [
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.path,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.submittedBy,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: item.size,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children:
                                item.status === "pending"
                                  ? "待审批"
                                  : item.status === "approved"
                                    ? "已批准"
                                    : item.status === "rejected"
                                      ? "已拒绝"
                                      : item.status,
                            }),
                            jsxRuntime.jsxs("td", {
                              style: cellStyle,
                              children:
                                item.status === "pending"
                                  ? [
                                      jsxRuntime.jsx(
                                        "button",
                                        {
                                          type: "button",
                                          style:
                                            decisionPendingId === item.id
                                              ? disabledButtonStyle
                                              : secondaryButtonStyle,
                                          disabled: decisionPendingId === item.id,
                                          onClick: () =>
                                            decideGlobal(item.id, true),
                                          children:
                                            decisionPendingId === item.id
                                              ? "处理中..."
                                              : "批准",
                                        },
                                        "approve",
                                      ),
                                      " ",
                                      jsxRuntime.jsx(
                                        "button",
                                        {
                                          type: "button",
                                          style:
                                            decisionPendingId === item.id
                                              ? disabledButtonStyle
                                              : secondaryButtonStyle,
                                          disabled: decisionPendingId === item.id,
                                          onClick: () =>
                                            decideGlobal(item.id, false),
                                          children:
                                            decisionPendingId === item.id
                                              ? "处理中..."
                                              : "拒绝",
                                        },
                                        "reject",
                                      ),
                                    ]
                                  : "-",
                            }),
                          ],
                        },
                        item.id,
                      ),
                    ),
                    empty: "暂无全局共享申请",
                  }),
                ],
              })
            : null,
          jsxRuntime.jsxs(Panel, {
            title: "摘要与审计",
            children: [
              jsxRuntime.jsx(Table, {
                headers: ["摘要", "更新时间", "大小"],
                rows: digests.map((item) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.path,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          title: item.updatedAt,
                          children: formatTime(item.updatedAt),
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: item.size,
                        }),
                      ],
                    },
                    item.path,
                  ),
                ),
                empty: "暂无会话摘要",
              }),
              jsxRuntime.jsx(Table, {
                headers: ["时间", "操作者", "动作", "路径"],
                rows: events.map((event) =>
                  jsxRuntime.jsxs(
                    "tr",
                    {
                      children: [
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          title: event.at,
                          children: formatTime(event.at),
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: event.actorId,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: event.action,
                        }),
                        jsxRuntime.jsx("td", {
                          style: cellStyle,
                          children: event.path ?? "-",
                        }),
                      ],
                    },
                    event.id,
                  ),
                ),
                empty: "暂无共享审计",
              }),
            ],
          }),
        ],
      });
    };

    exports.inject = ["slots"];
    exports.apply = (ctx) =>
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "pluginmax-space",
            order: 81,
            label: () => "共享",
            inject: () => ({}),
          },
          () => jsxRuntime.jsx(SpaceSection, {}),
        ),
      );

    return module.exports;
  },
});
