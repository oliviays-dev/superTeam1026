window.__ModuleLoader__.load({
  id: "dsh-collab-identity",
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
      boxSizing: "border-box",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
      fontSize: 13,
      height: 36,
      minWidth: 0,
      padding: "0 10px",
      width: "100%",
    };
    const buttonStyle = {
      alignItems: "center",
      background: "var(--dsw-alias-button-primary-fill)",
      border: 0,
      borderRadius: 6,
      boxSizing: "border-box",
      color: "var(--dsw-alias-label-primary-foreground)",
      cursor: "pointer",
      display: "inline-flex",
      font: "inherit",
      fontSize: 13,
      gap: 6,
      height: 36,
      justifyContent: "center",
      padding: "0 14px",
      whiteSpace: "nowrap",
    };
    const secondaryButtonStyle = {
      ...buttonStyle,
      background: "transparent",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      color: "var(--dsw-alias-label-primary)",
    };
    const panelStyle = {
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
      display: "grid",
      gap: 14,
      paddingTop: 16,
    };
    const formStyle = {
      alignItems: "end",
      display: "grid",
      gap: 9,
      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
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

    function localTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString([], {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function setToken(token) {
      if (token === undefined) window.localStorage.removeItem(TOKEN_KEY);
      else window.localStorage.setItem(TOKEN_KEY, token);
      window.dispatchEvent(new CustomEvent("pluginmax:collab-token"));
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

    function Field({
      id,
      label,
      type = "text",
      value,
      onChange,
      hint,
      ...rest
    }) {
      return jsxRuntime.jsxs("label", {
        htmlFor: id,
        style: {
          color: "var(--dsw-alias-label-secondary)",
          alignContent: "start",
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
            type,
            value,
            onChange,
            ...rest,
          }),
          hint
            ? jsxRuntime.jsx("span", {
                style: { fontSize: 12, opacity: 0.72 },
                children: hint,
              })
            : null,
        ],
      });
    }

    function PasswordField({ id, label, value, onChange, ...rest }) {
      const [visible, setVisible] = react.useState(false);
      return jsxRuntime.jsxs("label", {
        htmlFor: id,
        children: [
          jsxRuntime.jsx("span", { children: label }),
          jsxRuntime.jsxs("span", {
            className: "pmx-auth-password",
            children: [
              jsxRuntime.jsx("input", {
                id,
                name: id,
                style: { ...inputStyle, paddingRight: 44 },
                type: visible ? "text" : "password",
                value,
                onChange,
                ...rest,
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                "aria-label": visible ? "隐藏密码" : "显示密码",
                onClick: () => setVisible((current) => !current),
                children: visible ? "隐藏" : "显示",
              }),
            ],
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

    function friendlyError(cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "invalid user or password")
        return "用户 ID 或密码不正确。";
      if (message === "invalid or expired token")
        return "登录状态已过期，请重新登录。";
      if (message === "bearer token is required") return "请先登录。";
      if (message === "user id already exists") return "用户 ID 已存在。";
      if (message === "account is disabled")
        return "该账号已停用，请联系管理员启用。";
      if (message === "you cannot disable your own account")
        return "不能停用当前登录的管理员账号。";
      if (message === "the last admin role cannot be changed")
        return "最后一个管理员不能被降级或停用。";
      return message;
    }

    const IdentitySection = () => {
      const [phase, setPhase] = react.useState("loading");
      const [message, setMessage] = react.useState("");
      const [error, setError] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const savingRef = react.useRef(false);
      const [me, setMe] = react.useState(null);
      const [users, setUsers] = react.useState([]);
      const [account, setAccount] = react.useState({
        userId: "",
        name: "",
        password: "",
      });
      const [loginDialogOpen, setLoginDialogOpen] = react.useState(false);
      const [passwordForm, setPasswordForm] = react.useState({
        currentPassword: "",
        newPassword: "",
      });
      const [newUser, setNewUser] = react.useState({
        userId: "",
        name: "",
        password: "",
        role: "member",
      });
      /** 账号管理：行内编辑 / 停用启用 / 是否查看已停用。 */
      const [editUserId, setEditUserId] = react.useState("");
      const [editUserForm, setEditUserForm] = react.useState({
        name: "",
        role: "member",
      });
      const [userBusy, setUserBusy] = react.useState("");
      const [showDisabled, setShowDisabled] = react.useState(false);

      const notify = (text) => {
        setError("");
        setMessage(text);
      };

      const fail = (cause) => {
        setMessage("");
        setError(friendlyError(cause));
      };

      const loadAdmin = react.useCallback(
        async (user = me) => {
          if (user?.role !== "admin") return;
          const userResult = await request("/api/collab/team/users");
          setUsers(userResult.users);
        },
        [me],
      );

      react.useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        async function load() {
          try {
            const status = await request("/api/collab/auth/status", {
              signal: controller.signal,
            });
            if (disposed) return;
            const token = getToken();
            if (!status.initialized) {
              setPhase("bootstrap");
              return;
            }
            if (token === null) {
              setPhase("login");
              return;
            }
            const current = await request("/api/collab/auth/me", {
              signal: controller.signal,
            });
            if (disposed) return;
            setMe(current.user);
            setPhase("ready");
          } catch (cause) {
            if (cause.name === "AbortError" || disposed) return;
            if (cause.status === 401) {
              setToken(undefined);
              setPhase("login");
            }
            fail(cause);
          }
        }
        load();
        const handleTokenChange = () => {
          if (getToken() !== null) {
            setMessage("");
            setError("");
          }
          if (!disposed) void load();
        };
        window.addEventListener("pluginmax:collab-token", handleTokenChange);
        return () => {
          disposed = true;
          controller.abort();
          window.removeEventListener(
            "pluginmax:collab-token",
            handleTokenChange,
          );
        };
      }, []);

      react.useEffect(() => {
        if (me?.role !== "admin") return;
        loadAdmin(me).catch(fail);
      }, [loadAdmin, me]);

      react.useEffect(() => {
        if (phase === "login") {
          setLoginDialogOpen(true);
        }
      }, [phase]);

      const submitBootstrap = async (event) => {
        event.preventDefault();
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
          const result = await request("/api/collab/auth/bootstrap", {
            method: "POST",
            body: JSON.stringify(account),
          });
          setToken(result.token);
          setMe(result.user);
          setPhase("ready");
          notify(`已创建管理员 ${result.user.id}`);
          await loadAdmin(result.user);
        } catch (cause) {
          fail(cause);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      const submitLogin = async (event) => {
        event.preventDefault();
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
          const result = await request("/api/collab/auth/login", {
            method: "POST",
            body: JSON.stringify({
              userId: account.userId,
              password: account.password,
            }),
          });
          setToken(result.token);
          setMe(result.user);
          setPhase("ready");
          setLoginDialogOpen(false);
          notify(`已登录 ${result.user.name}`);
          await loadAdmin(result.user);
        } catch (cause) {
          fail(cause);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      const submitPassword = async (event) => {
        event.preventDefault();
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
          await request("/api/collab/auth/change-password", {
            method: "POST",
            body: JSON.stringify(passwordForm),
          });
          setPasswordForm({ currentPassword: "", newPassword: "" });
          notify("密码已更新");
        } catch (cause) {
          fail(cause);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      const submitUser = async (event) => {
        event.preventDefault();
        const userId = newUser.userId.trim();
        const name = newUser.name.trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(userId)) {
          setError(
            "用户 ID 需以字母或数字开头，只能包含字母、数字、点、下划线和中划线。",
          );
          return;
        }
        if (name === "") {
          setError("请填写显示名称。");
          return;
        }
        if (newUser.password.length < 8) {
          setError("初始密码至少需要 8 个字符。");
          return;
        }
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
          await request("/api/collab/team/users/create", {
            method: "POST",
            body: JSON.stringify({ ...newUser, userId, name }),
          });
          setNewUser({ userId: "", name: "", password: "", role: "member" });
          notify("全局账号已创建；请到项目管理中把该账号加入对应项目。");
          await loadAdmin();
        } catch (cause) {
          fail(cause);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };

      /** 账号管理：行内保存「显示名称 / 全局角色」。 */
      const saveUserAccount = async (userId) => {
        const name = editUserForm.name.trim();
        if (name === "") {
          setError("请填写显示名称。");
          return;
        }
        try {
          setUserBusy(userId);
          await request("/api/collab/team/users/update", {
            method: "POST",
            body: JSON.stringify({ userId, name, role: editUserForm.role }),
          });
          setEditUserId("");
          notify("账号已更新。");
          await loadAdmin();
        } catch (cause) {
          fail(cause);
        } finally {
          setUserBusy("");
        }
      };

      /** 账号管理：停用/启用（停用会吊销该账号的登录会话）。 */
      const changeUserStatus = async (userId, status) => {
        try {
          setUserBusy(userId);
          await request("/api/collab/team/users/update", {
            method: "POST",
            body: JSON.stringify({ userId, status }),
          });
          // 停用/启用后都回到「启用账号」列表，避免停留在一个空视图。
          setShowDisabled(false);
          notify(status === "disabled" ? "账号已停用。" : "账号已启用。");
          await loadAdmin();
        } catch (cause) {
          fail(cause);
        } finally {
          setUserBusy("");
        }
      };

      const logout = async () => {
        try {
          await request("/api/collab/auth/logout", { method: "POST" });
        } finally {
          setToken(undefined);
          setMe(null);
          setUsers([]);
          setPhase("login");
          notify("已退出登录");
        }
      };

      const bootstrapFields = jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsx(Field, {
            id: "pluginmax-user-id",
            label: "用户 ID",
            value: account.userId,
            onChange: (event) =>
              setAccount((current) => ({
                ...current,
                userId: event.target.value,
              })),
            autoComplete: "username",
          }),
          jsxRuntime.jsx(Field, {
            id: "pluginmax-user-name",
            label: "显示名称",
            value: account.name,
            onChange: (event) =>
              setAccount((current) => ({
                ...current,
                name: event.target.value,
              })),
            autoComplete: "name",
          }),
          jsxRuntime.jsx(Field, {
            id: "pluginmax-bootstrap-password",
            label: "初始密码",
            type: "password",
            value: account.password,
            onChange: (event) =>
              setAccount((current) => ({
                ...current,
                password: event.target.value,
              })),
            autoComplete: "new-password",
          }),
        ],
      });

      const disabledUserCount = users.filter(
        (user) => user.status === "disabled",
      ).length;
      const visibleUsers = users.filter((user) =>
        showDisabled ? user.status === "disabled" : user.status !== "disabled",
      );
      /** 账号表格行的紧凑按钮，避免操作列换行成两行。 */
      const rowButtonStyle = {
        ...buttonStyle,
        height: 30,
        fontSize: 12,
        padding: "0 10px",
      };

      const loginFields = jsxRuntime.jsxs(jsxRuntime.Fragment, {
        children: [
          jsxRuntime.jsx(Field, {
            id: "pluginmax-user-id",
            label: "用户 ID",
            value: account.userId,
            onChange: (event) =>
              setAccount((current) => ({
                ...current,
                userId: event.target.value,
              })),
            autoComplete: "username",
          }),
          jsxRuntime.jsx(PasswordField, {
            id: "pluginmax-user-password",
            label: "密码",
            value: account.password,
            onChange: (event) =>
              setAccount((current) => ({
                ...current,
                password: event.target.value,
              })),
            autoComplete: "current-password",
          }),
        ],
      });

      if (phase === "loading") {
        return jsxRuntime.jsx("section", {
          "data-pluginmax-identity": true,
          style: { display: "grid", gap: 12, padding: 4 },
          children: jsxRuntime.jsx("p", { children: "正在加载身份..." }),
        });
      }
      return jsxRuntime.jsxs("section", {
        "data-pluginmax-identity": true,
        style: {
          color: "var(--dsw-alias-label-primary)",
          display: "grid",
          gap: 16,
          padding: 4,
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              alignItems: "center",
              display: "flex",
              gap: 10,
              justifyContent: "space-between",
            },
            children: [
              jsxRuntime.jsx("h2", {
                style: { fontSize: 18, margin: 0 },
                children: "登录账号",
              }),
              me === null
                ? null
                : jsxRuntime.jsx("button", {
                    type: "button",
                    style: secondaryButtonStyle,
                    onClick: logout,
                    children: "退出登录",
                  }),
            ],
          }),
          message === ""
            ? null
            : jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-state-success-primary)",
                  margin: 0,
                },
                children: message,
              }),
          error === ""
            ? null
            : jsxRuntime.jsx("p", {
                style: {
                  color: "var(--dsw-alias-state-error-primary)",
                  margin: 0,
                },
                children: error,
              }),
          phase === "bootstrap"
            ? jsxRuntime.jsxs("form", {
                onSubmit: submitBootstrap,
                style: formStyle,
                children: [
                  bootstrapFields,
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    style: {
                      ...buttonStyle,
                      gridColumn: "1 / -1",
                      justifySelf: "start",
                    },
                    disabled: saving,
                    children: saving ? "创建中..." : "创建管理员",
                  }),
                ],
              })
            : null,
          phase === "login"
            ? jsxRuntime.jsxs("div", {
                style: {
                  alignItems: "center",
                  border: "0.5px solid var(--dsw-alias-border-l2)",
                  borderRadius: 8,
                  display: "flex",
                  gap: 10,
                  justifyContent: "space-between",
                  padding: 12,
                },
                children: [
                  jsxRuntime.jsx("span", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                    },
                    children: "当前未登录。",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    style: buttonStyle,
                    onClick: () => setLoginDialogOpen(true),
                    children: "登录账号",
                  }),
                ],
              })
            : null,
          phase !== "ready" || me === null
            ? null
            : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                children: [
                  jsxRuntime.jsxs("div", {
                    style: {
                      alignItems: "center",
                      background: "var(--dsw-alias-bg-layer-2)",
                      border: "0.5px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      display: "grid",
                      gap: 4,
                      padding: 12,
                    },
                    children: [
                      jsxRuntime.jsx("span", {
                        style: {
                          color: "var(--dsw-alias-label-secondary)",
                          fontSize: 12,
                        },
                        children: "当前身份",
                      }),
                      jsxRuntime.jsx("strong", {
                        style: { fontSize: 15 },
                        children: me.name,
                      }),
                      jsxRuntime.jsxs("span", {
                        style: {
                          color: "var(--dsw-alias-label-secondary)",
                          fontSize: 13,
                        },
                        children: [me.id, " · ", me.role],
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("div", {
                    style: {
                      alignItems: "center",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    },
                    children: [
                      jsxRuntime.jsx("span", {
                        style: {
                          color: "var(--dsw-alias-label-secondary)",
                          fontSize: 13,
                        },
                        children:
                          "要使用另一个账号，请先点击右上角「退出登录」，再输入新的用户 ID 和密码。",
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("form", {
                    onSubmit: submitPassword,
                    style: formStyle,
                    children: [
                      jsxRuntime.jsx(Field, {
                        id: "pluginmax-current-password",
                        label: "当前密码",
                        type: "password",
                        value: passwordForm.currentPassword,
                        onChange: (event) =>
                          setPasswordForm((current) => ({
                            ...current,
                            currentPassword: event.target.value,
                          })),
                        autoComplete: "current-password",
                      }),
                      jsxRuntime.jsx(Field, {
                        id: "pluginmax-new-password",
                        label: "新密码",
                        type: "password",
                        value: passwordForm.newPassword,
                        onChange: (event) =>
                          setPasswordForm((current) => ({
                            ...current,
                            newPassword: event.target.value,
                          })),
                        autoComplete: "new-password",
                      }),
                      jsxRuntime.jsx("button", {
                        type: "submit",
                        disabled: saving,
                        style: {
                          ...buttonStyle,
                          justifySelf: "start",
                          opacity: saving ? 0.6 : 1,
                        },
                        children: saving ? "更新中..." : "更新密码",
                      }),
                    ],
                  }),
                ],
              }),
          phase === "login" && loginDialogOpen
            ? jsxRuntime.jsx("div", {
                className: "pmx-auth-layer",
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) {
                    setLoginDialogOpen(false);
                  }
                },
                children: jsxRuntime.jsxs("form", {
                  className: "pmx-auth-card",
                  onSubmit: submitLogin,
                  children: [
                    jsxRuntime.jsxs("div", {
                      className: "pmx-auth-head",
                      children: [
                        jsxRuntime.jsx("h3", { children: "登录账号" }),
                        jsxRuntime.jsx("p", {
                          children: "使用 Pluginmax 用户 ID 和密码登录。",
                        }),
                      ],
                    }),
                    loginFields,
                    error === ""
                      ? null
                      : jsxRuntime.jsx("div", {
                          className: "pmx-auth-error",
                          children: error,
                        }),
                    jsxRuntime.jsxs("div", {
                      className: "pmx-auth-actions",
                      children: [
                        jsxRuntime.jsx("button", {
                          type: "button",
                          onClick: () => setLoginDialogOpen(false),
                          children: "取消",
                        }),
                        jsxRuntime.jsx("button", {
                          type: "submit",
                          className: "primary",
                          disabled:
                            saving ||
                            account.userId === "" ||
                            account.password === "",
                          children: saving ? "处理中…" : "登录",
                        }),
                      ],
                    }),
                  ],
                }),
              })
            : null,
          me?.role !== "admin"
            ? null
            : jsxRuntime.jsxs(jsxRuntime.Fragment, {
                children: [
                  jsxRuntime.jsxs(Panel, {
                    title: "登录账号",
                    action: jsxRuntime.jsx("button", {
                      type: "button",
                      style: secondaryButtonStyle,
                      onClick: () => loadAdmin().catch(fail),
                      children: "刷新",
                    }),
                    children: [
                      jsxRuntime.jsxs("form", {
                        onSubmit: submitUser,
                        style: {
                          ...formStyle,
                          gridTemplateColumns:
                            "minmax(160px, 1fr) minmax(160px, 1fr) minmax(180px, 1fr)",
                        },
                        children: [
                          jsxRuntime.jsx(Field, {
                            id: "pluginmax-new-user-id",
                            label: "用户 ID",
                            hint: "字母或数字开头，最长 64 位",
                            maxLength: 64,
                            value: newUser.userId,
                            onChange: (event) =>
                              setNewUser((current) => ({
                                ...current,
                                userId: event.target.value,
                              })),
                          }),
                          jsxRuntime.jsx(Field, {
                            id: "pluginmax-new-user-name",
                            label: "显示名称",
                            hint: "最长 80 个字符",
                            maxLength: 80,
                            value: newUser.name,
                            onChange: (event) =>
                              setNewUser((current) => ({
                                ...current,
                                name: event.target.value,
                              })),
                          }),
                          jsxRuntime.jsx(Field, {
                            id: "pluginmax-new-user-password",
                            label: "初始密码",
                            type: "password",
                            hint: "至少 8 个字符，最长 256 位",
                            maxLength: 256,
                            value: newUser.password,
                            onChange: (event) =>
                              setNewUser((current) => ({
                                ...current,
                                password: event.target.value,
                              })),
                          }),
                          jsxRuntime.jsx("label", {
                            htmlFor: "pluginmax-new-user-role",
                            style: {
                              color: "var(--dsw-alias-label-secondary)",
                              alignContent: "start",
                              display: "grid",
                              fontSize: 13,
                              gap: 5,
                            },
                            children: [
                              jsxRuntime.jsx("span", {
                                children: "全局角色",
                              }),
                              jsxRuntime.jsx("select", {
                                id: "pluginmax-new-user-role",
                                style: inputStyle,
                                value: newUser.role,
                                onChange: (event) =>
                                  setNewUser((current) => ({
                                    ...current,
                                    role: event.target.value,
                                  })),
                                children: [
                                  "admin",
                                  "owner",
                                  "member",
                                  "guest",
                                ].map((role) =>
                                  jsxRuntime.jsx(
                                    "option",
                                    { value: role, children: role },
                                    role,
                                  ),
                                ),
                              }),
                            ],
                          }),
                          jsxRuntime.jsx("button", {
                            type: "submit",
                            disabled: saving,
                            style: {
                              ...buttonStyle,
                              gridColumn: "1 / -1",
                              justifySelf: "start",
                              opacity: saving ? 0.6 : 1,
                            },
                            children: saving ? "创建中..." : "创建",
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        style: {
                          alignItems: "center",
                          display: "flex",
                          gap: 8,
                          justifyContent: "space-between",
                        },
                        children: [
                          jsxRuntime.jsx("span", {
                            style: {
                              color: "var(--dsw-alias-label-secondary)",
                              fontSize: 12,
                            },
                            children: `共 ${String(users.length)} 个账号 · 已停用 ${String(disabledUserCount)}`,
                          }),
                          jsxRuntime.jsx("button", {
                            type: "button",
                            style: buttonStyle,
                            disabled: disabledUserCount === 0 && !showDisabled,
                            onClick: () => setShowDisabled((value) => !value),
                            children: showDisabled
                              ? "返回启用账号"
                              : `查看已停用 ${String(disabledUserCount)}`,
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("table", {
                        style: tableStyle,
                        children: [
                          jsxRuntime.jsx("thead", {
                            children: jsxRuntime.jsx("tr", {
                              children: [
                                "用户",
                                "名称",
                                "角色",
                                "创建时间",
                                "操作",
                              ].map((title) =>
                                jsxRuntime.jsx(
                                  "th",
                                  { style: cellStyle, children: title },
                                  title,
                                ),
                              ),
                            }),
                          }),
                          jsxRuntime.jsx("tbody", {
                            children: visibleUsers.map((user) => {
                              const editing = editUserId === user.id;
                              const disabled = user.status === "disabled";
                              const rowBusy = userBusy === user.id;
                              return jsxRuntime.jsxs(
                                "tr",
                                {
                                  children: [
                                    jsxRuntime.jsx("td", {
                                      style: cellStyle,
                                      children: user.id,
                                    }),
                                    jsxRuntime.jsx("td", {
                                      style: cellStyle,
                                      children: editing
                                        ? jsxRuntime.jsx("input", {
                                            style: {
                                              ...inputStyle,
                                              width: "150px",
                                            },
                                            maxLength: 80,
                                            value: editUserForm.name,
                                            "aria-label": "编辑显示名称",
                                            onChange: (event) =>
                                              setEditUserForm((current) => ({
                                                ...current,
                                                name: event.target.value,
                                              })),
                                          })
                                        : user.name,
                                    }),
                                    jsxRuntime.jsx("td", {
                                      style: cellStyle,
                                      children: editing
                                        ? jsxRuntime.jsx("select", {
                                            style: {
                                              ...inputStyle,
                                              width: "110px",
                                            },
                                            value: editUserForm.role,
                                            "aria-label": "编辑全局角色",
                                            onChange: (event) =>
                                              setEditUserForm((current) => ({
                                                ...current,
                                                role: event.target.value,
                                              })),
                                            children: [
                                              "admin",
                                              "owner",
                                              "member",
                                              "guest",
                                            ].map((role) =>
                                              jsxRuntime.jsx(
                                                "option",
                                                {
                                                  value: role,
                                                  children: role,
                                                },
                                                role,
                                              ),
                                            ),
                                          })
                                        : user.role,
                                    }),
                                    jsxRuntime.jsx("td", {
                                      style: cellStyle,
                                      title: user.createdAt,
                                      children: localTime(user.createdAt),
                                    }),
                                    jsxRuntime.jsx("td", {
                                      style: cellStyle,
                                      children: jsxRuntime.jsxs("div", {
                                        style: {
                                          display: "flex",
                                          flexWrap: "nowrap",
                                          gap: 6,
                                        },
                                        children: editing
                                          ? [
                                              jsxRuntime.jsx(
                                                "button",
                                                {
                                                  type: "button",
                                                  style: rowButtonStyle,
                                                  disabled: rowBusy,
                                                  onClick: () =>
                                                    void saveUserAccount(
                                                      user.id,
                                                    ),
                                                  children: rowBusy
                                                    ? "保存中…"
                                                    : "保存",
                                                },
                                                "save",
                                              ),
                                              jsxRuntime.jsx(
                                                "button",
                                                {
                                                  type: "button",
                                                  style: rowButtonStyle,
                                                  disabled: rowBusy,
                                                  onClick: () =>
                                                    setEditUserId(""),
                                                  children: "取消",
                                                },
                                                "cancel",
                                              ),
                                            ]
                                          : [
                                              jsxRuntime.jsx(
                                                "button",
                                                {
                                                  type: "button",
                                                  style: rowButtonStyle,
                                                  disabled: rowBusy,
                                                  onClick: () => {
                                                    setEditUserId(user.id);
                                                    setEditUserForm({
                                                      name: user.name,
                                                      role: user.role,
                                                    });
                                                  },
                                                  children: "编辑",
                                                },
                                                "edit",
                                              ),
                                              jsxRuntime.jsx(
                                                "button",
                                                {
                                                  type: "button",
                                                  style: rowButtonStyle,
                                                  disabled: rowBusy,
                                                  onClick: () =>
                                                    void changeUserStatus(
                                                      user.id,
                                                      disabled
                                                        ? "active"
                                                        : "disabled",
                                                    ),
                                                  children: disabled
                                                    ? "启用"
                                                    : "停用",
                                                },
                                                "status",
                                              ),
                                            ],
                                      }),
                                    }),
                                  ],
                                },
                                user.id,
                              );
                            }),
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
        ],
      });
    };

    const ACCESS_TAB_SLOT = "pluginmax.account-access.tab";
    const ACCESS_TAB_EVENT = "pluginmax:account-access-tab";

    const tabLabel = (label) =>
      typeof label === "function" ? label() : String(label ?? "");

    const AUDIT_ACTION_LABELS = {
      bootstrap: "初始化管理员",
      register_user: "创建账号",
      update_user: "更新账号",
      login: "登录",
      login_failed: "登录失败",
      logout: "退出登录",
      change_password: "修改密码",
      member_add: "加入项目",
      member_remove: "移出项目",
      member_leave: "退出项目",
    };

    function AuditSection() {
      const [events, setEvents] = react.useState([]);
      const [query, setQuery] = react.useState("");
      const [loading, setLoading] = react.useState(true);
      const [error, setError] = react.useState("");

      const load = async () => {
        setLoading(true);
        setError("");
        try {
          const result = await request("/api/collab/team/audit?limit=200");
          setEvents(result.events ?? []);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setLoading(false);
        }
      };

      react.useEffect(() => {
        void load();
      }, []);

      const normalizedQuery = query.trim().toLowerCase();
      const visible = events.filter((event) => {
        if (normalizedQuery === "") return true;
        const action = AUDIT_ACTION_LABELS[event.action] ?? event.action;
        const detail = Object.entries(event.detail ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(" ");
        return [
          event.actorId,
          event.targetId,
          event.workspaceId,
          event.action,
          action,
          detail,
        ].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(normalizedQuery),
        );
      });

      return jsxRuntime.jsxs("section", {
        style: { display: "grid", gap: 14 },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              alignItems: "center",
              display: "flex",
              flexWrap: "wrap",
              gap: 9,
              justifyContent: "space-between",
            },
            children: [
              jsxRuntime.jsx("h2", {
                style: { fontSize: 18, margin: 0 },
                children: "账号与权限审计",
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                style: secondaryButtonStyle,
                disabled: loading,
                onClick: () => void load(),
                children: loading ? "加载中…" : "刷新",
              }),
            ],
          }),
          jsxRuntime.jsxs("label", {
            style: { display: "grid", gap: 5, maxWidth: 420 },
            children: [
              jsxRuntime.jsx("span", {
                style: {
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 12,
                },
                children: "搜索操作人、目标账号或动作",
              }),
              jsxRuntime.jsx("input", {
                style: inputStyle,
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }),
            ],
          }),
          error !== ""
            ? jsxRuntime.jsx("div", {
                role: "alert",
                style: {
                  color: "var(--dsw-alias-state-error-primary,#e5534b)",
                  fontSize: 12,
                },
                children: error,
              })
            : null,
          jsxRuntime.jsxs("div", {
            style: { overflowX: "auto" },
            children: [
              jsxRuntime.jsx("table", {
                style: tableStyle,
                children: [
                  jsxRuntime.jsx("thead", {
                    children: jsxRuntime.jsx("tr", {
                      children: [
                        "时间",
                        "操作人",
                        "动作",
                        "目标账号",
                        "影响范围",
                        "详情",
                      ].map((title) =>
                        jsxRuntime.jsx(
                          "th",
                          { style: cellStyle, children: title },
                          title,
                        ),
                      ),
                    }),
                  }),
                  jsxRuntime.jsx("tbody", {
                    children: visible.map((event) =>
                      jsxRuntime.jsxs(
                        "tr",
                        {
                          children: [
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: localTime(event.at),
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: `${event.actorId} · ${event.actorRole}`,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children:
                                AUDIT_ACTION_LABELS[event.action] ??
                                event.action,
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: event.targetId ?? "-",
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children: event.workspaceId ?? "平台",
                            }),
                            jsxRuntime.jsx("td", {
                              style: cellStyle,
                              children:
                                Object.entries(event.detail ?? {})
                                  .map(([key, value]) => `${key}=${value}`)
                                  .join(" · ") || "-",
                            }),
                          ],
                        },
                        event.id,
                      ),
                    ),
                  }),
                ],
              }),
              !loading && visible.length === 0
                ? jsxRuntime.jsx("p", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                    },
                    children:
                      events.length === 0
                        ? "暂无审计记录。"
                        : "没有匹配的审计记录。",
                  })
                : null,
            ],
          }),
        ],
      });
    }

    function AccountAccessSection({ useTabs, renderSlot }) {
      const rows = useTabs ? useTabs((items) => items) : [];
      const [isAdmin, setIsAdmin] = react.useState(false);
      const [selectedId, setSelectedId] = react.useState(
        () =>
          window.localStorage.getItem("pluginmax.accountAccess.activeTab") ??
          "",
      );
      const [visited, setVisited] = react.useState(() => new Set());
      const tabsId = react.useId();
      const visibleRows = isAdmin
        ? rows
        : rows.filter((row) => row.id === "accounts");
      const activeId = visibleRows.some((row) => row.id === selectedId)
        ? selectedId
        : (visibleRows[0]?.id ?? "");

      react.useEffect(() => {
        let disposed = false;
        const load = async () => {
          if (getToken() === null) {
            if (!disposed) setIsAdmin(false);
            return;
          }
          try {
            const result = await request("/api/collab/auth/me");
            if (!disposed) setIsAdmin(result.user?.role === "admin");
          } catch {
            if (!disposed) setIsAdmin(false);
          }
        };
        void load();
        window.addEventListener("pluginmax:collab-token", load);
        return () => {
          disposed = true;
          window.removeEventListener("pluginmax:collab-token", load);
        };
      }, []);

      react.useEffect(() => {
        const selectTab = (event) => {
          const tabId = event?.detail?.tabId;
          if (typeof tabId === "string" && tabId !== "") {
            setSelectedId(tabId);
          }
        };
        window.addEventListener(ACCESS_TAB_EVENT, selectTab);
        return () => window.removeEventListener(ACCESS_TAB_EVENT, selectTab);
      }, []);

      react.useEffect(() => {
        if (activeId === "") return;
        window.localStorage.setItem(
          "pluginmax.accountAccess.activeTab",
          activeId,
        );
        setVisited((current) => {
          if (current.has(activeId)) return current;
          return new Set([...current, activeId]);
        });
      }, [activeId]);

      const tabStyle = (active) => ({
        background: active
          ? "color-mix(in srgb, var(--dsw-alias-accent-primary,#4f8ef7) 12%, transparent)"
          : "transparent",
        border: 0,
        borderBottom: active
          ? "2px solid var(--dsw-alias-accent-primary,#4f8ef7)"
          : "2px solid transparent",
        borderRadius: 0,
        color: active
          ? "var(--dsw-alias-label-primary)"
          : "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        font: "inherit",
        fontSize: 13,
        fontWeight: active ? 650 : 500,
        minHeight: 36,
        padding: "0 12px",
        whiteSpace: "nowrap",
      });

      return jsxRuntime.jsxs("section", {
        "data-pluginmax-account-access": true,
        style: {
          color: "var(--dsw-alias-label-primary)",
          display: "grid",
          gap: 16,
          padding: 4,
        },
        children: [
          jsxRuntime.jsx("h2", {
            style: { fontSize: 18, margin: 0 },
            children: "账号与权限",
          }),
          jsxRuntime.jsx("div", {
            role: "tablist",
            "aria-label": "账号与权限页签",
            style: {
              borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
              display: "flex",
              gap: 2,
              overflowX: "auto",
            },
            children: visibleRows.map((row) =>
              jsxRuntime.jsx(
                "button",
                {
                  type: "button",
                  role: "tab",
                  id: `${tabsId}-tab-${row.id}`,
                  "aria-selected": row.id === activeId,
                  "aria-controls": `${tabsId}-panel-${row.id}`,
                  tabIndex: row.id === activeId ? 0 : -1,
                  style: tabStyle(row.id === activeId),
                  onClick: () => setSelectedId(row.id),
                  children: tabLabel(row.label),
                },
                row.id,
              ),
            ),
          }),
          ...visibleRows
            .filter((row) => row.id === activeId || visited.has(row.id))
            .map((row) =>
              jsxRuntime.jsx(
                "div",
                {
                  role: "tabpanel",
                  id: `${tabsId}-panel-${row.id}`,
                  "aria-labelledby": `${tabsId}-tab-${row.id}`,
                  hidden: row.id !== activeId,
                  children: renderSlot(ACCESS_TAB_SLOT, {}, { only: row.id }),
                },
                row.id,
              ),
            ),
        ],
      });
    }

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      let tabsVersion = -1;
      let identityTabs = [];
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "pluginmax-account-access",
            order: 75,
            label: () => "账号与权限",
            children: {
              [ACCESS_TAB_SLOT]: { kind: "list", scope: "root" },
            },
            inject: () => ({
              hooks: {
                tabs: {
                  getSnapshot: () => {
                    const version = ctx.slots.getVersion(ACCESS_TAB_SLOT);
                    if (version !== tabsVersion) {
                      tabsVersion = version;
                      identityTabs = ctx.slots
                        .entries(ACCESS_TAB_SLOT)
                        .map((entry) => ({
                          id: entry.options.id ?? "",
                          order: entry.options.order ?? 0,
                          label: entry.options.label,
                        }))
                        .sort((left, right) => left.order - right.order);
                    }
                    return identityTabs;
                  },
                  subscribe: (listener) =>
                    ctx.slots.subscribe(ACCESS_TAB_SLOT, listener),
                },
              },
            }),
          },
          AccountAccessSection,
        ),
      );
      ctx.slots.inject(ACCESS_TAB_SLOT, () =>
        ctx.slots.register(
          {
            name: ACCESS_TAB_SLOT,
            id: "accounts",
            order: 10,
            label: () => "登录账号",
          },
          () => jsxRuntime.jsx(IdentitySection, {}),
        ),
      );
      ctx.slots.inject(ACCESS_TAB_SLOT, () =>
        ctx.slots.register(
          {
            name: ACCESS_TAB_SLOT,
            id: "audit",
            order: 30,
            label: () => "审计",
          },
          AuditSection,
        ),
      );
      /*
       * 「协作身份」设置页已下线；项目管理接管工作区成员维护，
       * 身份服务仍保留给账号管理、项目成员和项目审计使用。
       */
    };

    return module.exports;
  },
});
