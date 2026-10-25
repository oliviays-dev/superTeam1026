window.__ModuleLoader__.load({
  id: "dsh-collab-agent",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const TOKEN_KEY = "pluginmax.collab.token";

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
        error.code = body?.error?.code;
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function friendly(cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "bearer token is required") return "请先登录。";
      if (message === "invalid bearer token") return "登录状态已过期，请重新登录。";
      if (message === "workspace member role is required")
        return "需要工作区成员身份。";
      return message;
    }

    const style = {
      display: "grid",
      gap: 10,
      fontSize: 13,
      color: "var(--dsw-alias-label-primary)",
    };
    const panel = {
      display: "grid",
      gap: 8,
      padding: "10px 12px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 6,
      background: "var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))",
    };
    const muted = {
      color: "var(--dsw-alias-label-secondary)",
      fontSize: 11.5,
      lineHeight: 1.5,
      overflowWrap: "anywhere",
    };
    const input = {
      minWidth: 0,
      padding: "6px 8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 4,
      background: "var(--dsw-alias-bg-base)",
      color: "inherit",
      fontSize: 12.5,
    };
    const button = {
      padding: "5px 9px",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 4,
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    };

    function statusLabel(value) {
      return (
        {
          queued: "排队中",
          running: "运行中",
          waiting_input: "等待补充",
          succeeded: "已成功",
          failed: "失败",
          timeout: "超时",
          cancelled: "已取消",
          interrupted: "已中断",
        }[value] ?? value
      );
    }

    function timeShort(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const sameYear = date.getFullYear() === new Date().getFullYear();
      return date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(sameYear ? {} : { year: "numeric" }),
      });
    }

    function AgentSettings() {
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      const [profiles, setProfiles] = react.useState([]);
      const [runs, setRuns] = react.useState([]);
      const [reloadKey, setReloadKey] = react.useState(0);
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState("");
      const [formError, setFormError] = react.useState("");
      const [form, setForm] = react.useState({
        id: "backend-agent",
        name: "Backend Agent",
        description: "",
        personaId: "",
      });

      react.useEffect(() => {
        if (getToken() === null) {
          setPhase("login");
          return;
        }
        let disposed = false;
        (async () => {
          try {
            const result = await request("/api/collab/team/workspaces");
            if (disposed) return;
            const options = result.workspaces ?? [];
            setWorkspaces(options);
            setWorkspaceId(
              options.find((item) => item.isMember)?.id ??
                options[0]?.id ??
                "",
            );
            setPhase("ready");
          } catch (cause) {
            if (!disposed) {
              setError(friendly(cause));
              setPhase(cause.status === 401 ? "login" : "error");
            }
          }
        })();
        return () => {
          disposed = true;
        };
      }, []);

      react.useEffect(() => {
        if (phase !== "ready" || !workspaceId) return;
        let disposed = false;
        (async () => {
          try {
            const [profileResult, runResult] = await Promise.all([
              request(
                `/api/collab/agent/profiles?workspaceId=${encodeURIComponent(workspaceId)}`,
              ),
              request(
                `/api/collab/agent/runs?workspaceId=${encodeURIComponent(workspaceId)}`,
              ),
            ]);
            if (disposed) return;
            setProfiles(profileResult.profiles ?? []);
            setRuns((runResult.runs ?? []).slice(0, 8));
            setError("");
          } catch (cause) {
            if (!disposed) setError(friendly(cause));
          }
        })();
        return () => {
          disposed = true;
        };
      }, [phase, workspaceId, reloadKey]);

      async function createProfile() {
        if (busy) return;
        setBusy(true);
        setFormError("");
        setNotice("");
        try {
          await request("/api/collab/agent/profiles/create", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              id: form.id.trim(),
              name: form.name.trim(),
              description: form.description.trim() || undefined,
              personaId: form.personaId.trim() || undefined,
            }),
          });
          setForm({ id: "", name: "", description: "", personaId: "" });
          setNotice("Agent Profile 已创建。");
          setReloadKey((value) => value + 1);
        } catch (cause) {
          setFormError(friendly(cause));
        } finally {
          setBusy(false);
        }
      }

      async function toggleProfile(profile) {
        if (busy) return;
        setBusy(true);
        setNotice("");
        setFormError("");
        try {
          const status = profile.status === "active" ? "disabled" : "active";
          await request("/api/collab/agent/profiles/update", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              profileId: profile.id,
              status,
            }),
          });
          setNotice(status === "active" ? "Profile 已启用。" : "Profile 已停用。");
          setReloadKey((value) => value + 1);
        } catch (cause) {
          setFormError(friendly(cause));
        } finally {
          setBusy(false);
        }
      }

      if (phase === "login")
        return jsxRuntime.jsx("div", {
          style,
          children: "请先在「账号与权限 → 登录账号」登录。",
        });
      if (phase === "loading")
        return jsxRuntime.jsx("div", { style, children: "正在加载 Agent 设置…" });
      if (phase === "error")
        return jsxRuntime.jsx("div", { style, children: error });
      return jsxRuntime.jsxs("div", {
        style,
        children: [
          jsxRuntime.jsx("div", {
            style: { fontWeight: 600, fontSize: 14 },
            children: "Agent",
          }),
          workspaces.length > 0
            ? jsxRuntime.jsx("label", {
                style: { display: "grid", gap: 4 },
                children: [
                  jsxRuntime.jsx("span", { children: "当前工作区" }),
                  jsxRuntime.jsx("select", {
                    value: workspaceId,
                    onChange: (event) => setWorkspaceId(event.target.value),
                    style: { ...input, maxWidth: 320 },
                    children: workspaces.map((item) =>
                      jsxRuntime.jsx(
                        "option",
                        {
                          value: item.id,
                          children: item.title || "未命名工作区",
                        },
                        item.id,
                      ),
                    ),
                  }),
                ],
              })
            : null,
          error
            ? jsxRuntime.jsx("div", { style: { color: "#e26d6d" }, children: error })
            : null,
          notice ? jsxRuntime.jsx("div", { style: muted, children: notice }) : null,
          jsxRuntime.jsx("div", {
            style: { fontWeight: 600 },
            children: "Agent Profiles",
          }),
          profiles.length === 0
            ? jsxRuntime.jsx("div", {
                style: muted,
                children: "当前工作区还没有 Agent Profile。",
              })
            : profiles.map((profile) =>
                jsxRuntime.jsxs(
                  "div",
                  {
                    style: panel,
                    children: [
                      jsxRuntime.jsxs("div", {
                        style: { display: "flex", gap: 8, alignItems: "center" },
                        children: [
                          jsxRuntime.jsx("strong", { children: profile.name }),
                          jsxRuntime.jsx(
                            "span",
                            {
                              style: muted,
                              children: profile.status === "active" ? "启用" : "停用",
                            },
                          ),
                        ],
                      }),
                      profile.description
                        ? jsxRuntime.jsx("div", { style: muted, children: profile.description })
                        : null,
                      jsxRuntime.jsxs("div", {
                        style: muted,
                        children: [
                          `类型：${profile.runtimeKind}`,
                          profile.personaId === undefined
                            ? ""
                            : ` · 人设：${profile.personaId}`,
                          ` · 工具白名单：${profile.allowedTools.length} 项`,
                        ],
                      }),
                      jsxRuntime.jsx("div", {
                        children: jsxRuntime.jsx(
                          "button",
                          {
                            type: "button",
                            disabled: busy,
                            onClick: () => toggleProfile(profile),
                            style: button,
                            children:
                              profile.status === "active" ? "停用" : "启用",
                          },
                          `toggle-${profile.id}`,
                        ),
                      }),
                    ],
                  },
                  profile.id,
                ),
              ),
          jsxRuntime.jsxs("div", {
            style: panel,
            children: [
              jsxRuntime.jsx("div", {
                style: { fontWeight: 600 },
                children: "新建 Task Worker Profile",
              }),
              formError
                ? jsxRuntime.jsx(
                    "div",
                    { style: { color: "#e26d6d" }, children: formError },
                    "form-error",
                  )
                : null,
              jsxRuntime.jsxs(
                "label",
                {
                  style: { ...muted, display: "grid", gap: 4 },
                  children: [
                    "Profile ID",
                    jsxRuntime.jsx("input", {
                      value: form.id,
                      onChange: (event) =>
                        setForm({ ...form, id: event.target.value }),
                      placeholder: "backend-agent",
                      style: input,
                    }),
                  ],
                },
                "id",
              ),
              jsxRuntime.jsxs(
                "label",
                {
                  style: { ...muted, display: "grid", gap: 4 },
                  children: [
                    "显示名称",
                    jsxRuntime.jsx("input", {
                      value: form.name,
                      onChange: (event) =>
                        setForm({ ...form, name: event.target.value }),
                      placeholder: "后端开发 Agent",
                      style: input,
                    }),
                  ],
                },
                "name",
              ),
              jsxRuntime.jsxs(
                "label",
                {
                  style: { ...muted, display: "grid", gap: 4 },
                  children: [
                    "描述（可选）",
                    jsxRuntime.jsx("input", {
                      value: form.description,
                      onChange: (event) =>
                        setForm({ ...form, description: event.target.value }),
                      style: input,
                    }),
                  ],
                },
                "description",
              ),
              jsxRuntime.jsxs(
                "label",
                {
                  style: { ...muted, display: "grid", gap: 4 },
                  children: [
                    "Persona ID（可选）",
                    jsxRuntime.jsx("input", {
                      value: form.personaId,
                      onChange: (event) =>
                        setForm({ ...form, personaId: event.target.value }),
                      style: input,
                    }),
                  ],
                },
                "persona",
              ),
              jsxRuntime.jsx("button", {
                type: "button",
                disabled:
                  busy || form.id.trim() === "" || form.name.trim() === "",
                onClick: createProfile,
                style: button,
                children: "创建 Profile",
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            style: { fontWeight: 600 },
            children: "最近运行",
          }),
          runs.length === 0
            ? jsxRuntime.jsx("div", { style: muted, children: "暂无运行记录。" })
            : runs.map((run) =>
                jsxRuntime.jsxs(
                  "div",
                  {
                    style: panel,
                    children: [
                      jsxRuntime.jsxs("div", {
                        style: { display: "flex", gap: 8, flexWrap: "wrap" },
                        children: [
                          jsxRuntime.jsx("strong", { children: run.payload.profileName }),
                          jsxRuntime.jsx("span", { children: statusLabel(run.status) }),
                          jsxRuntime.jsx(
                            "span",
                            { style: muted, children: timeShort(run.createdAt) },
                          ),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        style: muted,
                        children: [
                          `${run.payload.instanceTitle} · ${run.payload.nodeName} · 第 ${run.runSeq} 次`,
                        ],
                      }),
                      run.error
                        ? jsxRuntime.jsx("div", { style: muted, children: run.error })
                        : run.output?.summary
                          ? jsxRuntime.jsx(
                              "div",
                              {
                                style: muted,
                                children: run.output.summary.slice(0, 160),
                              },
                            )
                          : null,
                    ],
                  },
                  run.id,
                ),
              ),
        ],
      });
    }

    // 设置 > Agent 页面已下线。实现保留在 AgentSettings 里，
    // 如需恢复把 AGENT_SETTINGS_ENABLED 改成 true 即可。
    const AGENT_SETTINGS_ENABLED = false;
    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      if (!AGENT_SETTINGS_ENABLED) return;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "pluginmax-agent",
            order: 85,
            label: () => "Agent",
            inject: () => ({}),
          },
          () => jsxRuntime.jsx(AgentSettings, {}),
        ),
      );
    };

    return module.exports;
  },
});
