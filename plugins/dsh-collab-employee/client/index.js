window.__ModuleLoader__.load({
  id: "dsh-collab-employee",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const { createElement: h } = require("react");

    const TOKEN_KEY = "pluginmax.collab.token";
    const input = {
      width: "100%",
      minWidth: 0,
      padding: "7px 9px",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: 6,
      background: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
    };
    const primary = {
      padding: "7px 12px",
      border: 0,
      borderRadius: 6,
      background: "var(--dsw-alias-button-primary-fill)",
      color: "var(--dsw-alias-label-primary-foreground)",
      font: "inherit",
      cursor: "pointer",
    };
    const ghost = {
      padding: "5px 9px",
      border: "0.5px solid var(--dsw-alias-border-l3)",
      borderRadius: 6,
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
      cursor: "pointer",
    };
    const danger = { ...ghost, color: "#e26d6d" };
    const muted = {
      color: "var(--dsw-alias-label-secondary)",
      fontSize: 12,
      lineHeight: 1.5,
      overflowWrap: "anywhere",
    };
    const panel = {
      display: "grid",
      gap: 16,
      paddingTop: 16,
      borderTop: "0.5px solid var(--dsw-alias-border-l2)",
    };
    const card = {
      display: "grid",
      gap: 10,
      padding: 12,
      border: "0.5px solid var(--dsw-alias-border-l2)",
      borderRadius: 6,
      background: "var(--dsw-alias-bg-layer-2)",
    };
    const table = {
      width: "100%",
      minWidth: "100%",
      tableLayout: "fixed",
      borderCollapse: "collapse",
      fontSize: 13,
    };
    const cell = {
      padding: "7px 9px",
      textAlign: "left",
      verticalAlign: "top",
      borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
      overflowWrap: "anywhere",
    };
    const field = { display: "grid", gap: 4 };
    const grid2 = {
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gap: 10,
    };
    const row = {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    };
    const textarea = {
      ...input,
      minHeight: 70,
      resize: "vertical",
    };
    const formEntries = (event) => {
      const data = new FormData(event.currentTarget);
      const csvList = (name) =>
        data.getAll(name).flatMap((value) => csv(value));
      return {
        text: (name) => String(data.get(name) ?? "").trim(),
        number: (name) => {
          const value = Number(data.get(name));
          return Number.isFinite(value) && value > 0 ? value : undefined;
        },
        list: csvList,
      };
    };
    const workspaceLabel = (workspace) =>
      workspace?.title?.trim() ||
      workspace?.path?.split("/").filter(Boolean).at(-1) ||
      workspace?.id ||
      "-";
    const checkboxGroup = (name, values, checked = []) =>
      h(
        "div",
        { style: { display: "grid", gap: 6 } },
        values.map((value) =>
          h(
            "label",
            {
              key: value,
              style: {
                display: "flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                color: "var(--dsw-alias-label-primary)",
              },
            },
            h("input", {
              type: "checkbox",
              name,
              value,
              defaultChecked: checked.includes(value),
            }),
            value,
          ),
        ),
      );

    const token = () => window.localStorage.getItem(TOKEN_KEY);
    async function request(path, options = {}) {
      const headers = { ...options.headers };
      const requestBody =
        options.body === undefined || typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
      if (requestBody !== undefined)
        headers["content-type"] = "application/json";
      const value = token();
      if (value !== null) headers.authorization = `Bearer ${value}`;
      const response = await fetch(path, {
        ...options,
        body: requestBody,
        headers,
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(
          body?.error?.message ?? `HTTP ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }
      return body;
    }
    const formData = (event) =>
      Object.fromEntries(new FormData(event.currentTarget).entries());
    const csv = (value) =>
      String(value ?? "")
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    const kindLabel = (kind) => (kind === "human" ? "真人员工" : "数字员工");
    const statusLabel = (status) =>
      ({
        draft: "草稿",
        active: "启用",
        suspended: "暂停",
        archived: "归档",
        pending: "待处理",
        paused: "暂停",
        revoked: "已召回",
        completed: "已完成",
        approved: "已通过",
        rejected: "已否决",
        delegated: "已转交",
        skipped: "已跳过",
        running: "运行中",
        waiting: "等待",
        blocked: "阻塞",
        cancelled: "已取消",
        expired: "已到期",
        generated: "已生成",
        failed: "失败",
      })[status] ?? status;
    const loginStatusLabel = (status) =>
      status === "disabled" ? "登录已停用" : "登录正常";
    const runStatusLabel = (status) =>
      ({
        queued: "排队中",
        running: "运行中",
        waiting_input: "等待补充",
        succeeded: "已成功",
        failed: "失败",
        timeout: "超时",
        cancelled: "已取消",
        interrupted: "已中断",
      })[status] ?? status;
    const localTime = (value) =>
      value
        ? new Date(value).toLocaleString([], {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "-";
    const workflowDotStyle = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      flex: "0 0 auto",
    };
    const workflowPillStyle = {
      borderRadius: 4,
      padding: "3px 6px",
      fontSize: 11,
      whiteSpace: "nowrap",
    };
    const workflowPill = (status) => {
      const palette = {
        running: { color: "#37b76a", background: "rgba(55,183,106,0.14)" },
        waiting: { color: "#d99a26", background: "rgba(217,154,38,0.14)" },
        blocked: { color: "#e26d6d", background: "rgba(226,109,109,0.14)" },
        failed: { color: "#e26d6d", background: "rgba(226,109,109,0.14)" },
        completed: { color: "#4c9aff", background: "rgba(76,154,255,0.14)" },
        cancelled: {
          color: "var(--dsw-alias-label-secondary)",
          background: "var(--dsw-alias-bg-layer-2)",
        },
      };
      return {
        ...workflowPillStyle,
        ...(palette[status] ?? palette.cancelled),
      };
    };
    const workflowDot = (status) => ({
      ...workflowDotStyle,
      background:
        {
          running: "#37b76a",
          waiting: "#d99a26",
          blocked: "#e26d6d",
          failed: "#e26d6d",
          completed: "#4c9aff",
        }[status] ?? "var(--dsw-alias-label-secondary)",
    });
    const friendly = (error) =>
      error?.message === "bearer token is required"
        ? "请先登录。"
        : error?.message === "invalid or expired token"
          ? "登录状态已过期，请重新登录。"
          : error?.message === "admin role is required"
            ? "此区域需要全局管理员权限。"
            : (error?.message ?? "请求失败");

    function statusButton(employee, status, onAction, disabled = false) {
      const labels = { active: "启用", suspended: "暂停", archived: "归档" };
      const allowed =
        (employee.status === "draft" &&
          ["active", "suspended", "archived"].includes(status)) ||
        (employee.status === "active" &&
          ["suspended", "archived"].includes(status)) ||
        (employee.status === "suspended" &&
          ["active", "archived"].includes(status));
      return h(
        "button",
        {
          style:
            allowed && !disabled
              ? ghost
              : { ...ghost, opacity: 0.4, cursor: "not-allowed" },
          disabled: !allowed || disabled,
          onClick: () => onAction(status),
        },
        labels[status],
      );
    }

    function shortId(value) {
      return typeof value === "string" && value.length > 12
        ? `${value.slice(0, 8)}…`
        : value || "-";
    }

    const contextTypeLabel = (type) =>
      ({
        meeting: "会议",
        workflow: "工作流",
        task: "任务",
        review: "评审",
      })[type] ??
      type ??
      "-";

    const actionLabel = (action) =>
      ({
        read: "读取资料",
        write: "写入交付物",
        "meeting.read": "阅读会议内容",
        "meeting.speak": "会议发言",
        "meeting.approval.final": "最终审批",
        "meeting.approval.suggest": "提出审批建议",
        "approval.final": "最终审批",
        "approval.suggest": "提出审批建议",
        "tool:read": "读取工具",
        "tool:write": "写入工具",
      })[action] ?? action;

    const actionListLabel = (items) =>
      (items ?? []).map(actionLabel).join("、") || "无";

    const speakPolicyLabel = (policy) =>
      ({
        silent: "静默",
        manual: "手动触发",
        mentions: "被 @ 时发言",
        all: "自动参与发言",
      })[policy] ?? policy;

    const approvalPolicyLabel = (policy) =>
      ({
        never: "不参与审批",
        suggest: "仅提出审批建议",
        "explicit-only": "显式请求时审批",
      })[policy] ?? policy;

    function actorDisplay(ref, employeeNames = new Map()) {
      if (!ref) return "系统";
      const name =
        employeeNames.get(ref.id) ?? ref.label ?? ref.name ?? ref.id ?? "-";
      const kind =
        ref.kind === "employee"
          ? "数字员工"
          : ref.kind === "agent"
            ? "Task Worker"
            : ref.kind === "system"
              ? "系统"
              : "真人员工";
      return `${name} · ${kind}`;
    }

    function fieldRow(label, value, options = {}) {
      const preserveLines = options.preserveLines === true;
      const isLongId =
        !preserveLines && typeof value === "string" && value.length >= 32;
      return h(
        "div",
        { key: label, style: { display: "grid", gap: 3 } },
        h("span", { style: { fontSize: 12, opacity: 0.72 } }, label),
        h(
          "span",
          {
            style: {
              fontSize: 13,
              overflowWrap: "anywhere",
              whiteSpace: preserveLines ? "pre-wrap" : undefined,
              ...(isLongId
                ? {
                    cursor: "pointer",
                    textDecoration: "underline dotted",
                    textUnderlineOffset: 3,
                  }
                : {}),
            },
            title: isLongId ? `${value}（点击复制）` : undefined,
            onClick: isLongId
              ? () => {
                  navigator.clipboard.writeText(value).then(
                    () => {},
                    () => {},
                  );
                }
              : undefined,
          },
          isLongId ? `${value.slice(0, 8)}…` : value,
        ),
      );
    }

    function openRolesSettings() {
      const controls = Array.from(
        document.querySelectorAll('button, a, [role="button"]'),
      ).filter((control) => (control.textContent ?? "").trim() === "角色");
      const scoped = controls.filter((control) =>
        control.closest('aside, nav, [role="navigation"], [role="dialog"]'),
      );
      const target = (scoped.length ? scoped : controls).at(-1);
      target?.click();
    }

    function personaSelectOptions(options, currentValue) {
      const items = options.map((persona) =>
        h(
          "option",
          { key: persona.id, value: persona.id },
          `${persona.name || persona.id}（${persona.id}）`,
        ),
      );
      if (
        currentValue &&
        !options.some((persona) => persona.id === currentValue)
      ) {
        items.unshift(
          h(
            "option",
            { key: currentValue, value: currentValue },
            `${currentValue}（未找到 / 待配置）`,
          ),
        );
      }
      return items;
    }

    function personaGuide({ personas, refresh, currentValue } = {}) {
      return h(
        "div",
        { style: field },
        h(
          "label",
          null,
          "Persona ID",
          h(
            "select",
            {
              key: currentValue || personas[0]?.id || "no-persona",
              name: "personaId",
              style: input,
              required: true,
              defaultValue: currentValue || personas[0]?.id || "",
            },
            personaSelectOptions(personas, currentValue),
          ),
        ),
        personas.length
          ? null
          : h(
              "div",
              { style: { ...muted, marginTop: 5 } },
              "暂无 Persona。请先在 Settings >「角色」创建。",
            ),
        h(
          "div",
          { style: { display: "flex", gap: 6, marginTop: 5 } },
          h(
            "button",
            {
              type: "button",
              style: ghost,
              onClick: openRolesSettings,
            },
            "新增 Persona",
          ),
          h(
            "button",
            {
              type: "button",
              style: ghost,
              onClick: refresh,
            },
            "刷新 Persona",
          ),
        ),
      );
    }

    function WorkstationTab(props) {
      const sessionId = props?.sessionId;
      const openView = props?.openView;
      const workspaceSnapshot = props?.useWorkspaces?.((state) => state);
      const nativeWorkspace = workspaceSnapshot?.items?.find((item) =>
        item.sessionIds.includes(sessionId),
      );

      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [me, setMe] = react.useState(null);
      const [employees, setEmployees] = react.useState([]);
      const [members, setMembers] = react.useState([]);
      const [isAdmin, setIsAdmin] = react.useState(false);
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      const [delegations, setDelegations] = react.useState([]);
      const [reports, setReports] = react.useState([]);
      const [expiryNotices, setExpiryNotices] = react.useState([]);
      const [instances, setInstances] = react.useState([]);
      const [contextMeetings, setContextMeetings] = react.useState([]);
      const [contextWorkflows, setContextWorkflows] = react.useState([]);
      const [definitions, setDefinitions] = react.useState([]);
      const [selectedEmployee, setSelectedEmployee] = react.useState("");
      const [employeeDetail, setEmployeeDetail] = react.useState(null);
      const [selectedDelegation, setSelectedDelegation] = react.useState("");
      const [selectedSubject, setSelectedSubject] = react.useState("");
      const [selectedInstance, setSelectedInstance] = react.useState("");
      const [selectedNodeId, setSelectedNodeId] = react.useState("");
      const [workflowDetail, setWorkflowDetail] = react.useState(null);
      const [workflowDetailLoading, setWorkflowDetailLoading] =
        react.useState(false);
      const [governance, setGovernance] = react.useState(null);
      const [reportQuery, setReportQuery] = react.useState("");
      const [reportBusy, setReportBusy] = react.useState("");
      const [tokenVersion, setTokenVersion] = react.useState(0);

      const effectiveWorkspaceId =
        workspaces.find((item) => item.id === nativeWorkspace?.workspaceId)
          ?.id ?? workspaceId;
      const employeeNames = react.useMemo(
        () => new Map(employees.map((item) => [item.id, item.displayName])),
        [employees],
      );
      const memberNames = react.useMemo(
        () =>
          new Map(
            members.map((item) => [item.userId, item.name ?? item.userId]),
          ),
        [members],
      );
      const workflowActorNames = react.useMemo(
        () => new Map([...employeeNames, ...memberNames]),
        [employeeNames, memberNames],
      );
      const selectedSubjectValue =
        selectedSubject ||
        (selectedEmployee ? `employee:${selectedEmployee}` : "");
      const [selectedSubjectType, selectedSubjectId] =
        selectedSubjectValue.split(":");
      const showAvatarDetail = selectedSubjectType === "avatar";
      const selectedDefinition = definitions.find(
        (item) => item.id === workflowDetail?.instance?.definitionId,
      );
      const selectedNode = selectedDefinition?.graph.nodes.find(
        (item) => item.id === selectedNodeId,
      );
      const selectedState =
        workflowDetail?.instance?.nodes?.[selectedNodeId] ?? null;
      const selectedDelegationItem = delegations.find(
        (item) => item.id === selectedDelegation,
      );
      const reportMatches = reports.filter((item) => {
        const value = reportQuery.trim().toLowerCase();
        if (!value) return true;
        const delegation = delegations.find(
          (candidate) => candidate.id === item.delegationId,
        );
        return [
          delegation?.displayName,
          delegation?.ownerName,
          item.report,
          item.error,
        ]
          .filter(Boolean)
          .some((text) => text.toLowerCase().includes(value));
      });
      const selectedWorkspace = workspaces.find(
        (item) => item.id === selectedDelegationItem?.workspaceId,
      );
      const selectedContextMeeting =
        selectedDelegationItem?.contextType === "meeting"
          ? contextMeetings.find(
              (item) => item.id === selectedDelegationItem.contextId,
            )
          : undefined;
      const selectedContextWorkflow =
        selectedDelegationItem?.contextType === "workflow"
          ? contextWorkflows.find(
              (item) => item.id === selectedDelegationItem.contextId,
            )
          : undefined;
      const relatedItems = selectedDelegationItem
        ? [
            {
              key: "workspace",
              type: "workspace",
              title: workspaceLabel(selectedWorkspace),
              meta: "项目 / 工作区",
            },
            {
              key: "context",
              type: selectedDelegationItem.contextType,
              title:
                selectedContextMeeting?.title ??
                selectedContextWorkflow?.title ??
                "标题不可用",
              status:
                selectedContextMeeting?.status ??
                selectedContextWorkflow?.status,
              meta: `${contextTypeLabel(selectedDelegationItem.contextType)}事项`,
              workspaceId: selectedDelegationItem.workspaceId,
              contextId: selectedDelegationItem.contextId,
            },
          ]
        : [];

      const fail = (cause) => {
        setError(cause?.message ?? "请求失败");
        setNotice("");
      };

      const loadCore = react.useCallback(
        async (silent = true) => {
          if (!silent) setPhase("loading");
          if (token() === null) {
            setPhase("login");
            return;
          }
          try {
            const [employeeMe, workspaceResult] = await Promise.all([
              request("/api/collab/employee/me"),
              request("/api/collab/team/workspaces"),
            ]);
            const [delegationResult, reportResult, expiryResult] =
              await Promise.all([
                request("/api/collab/delegation"),
                request("/api/collab/delegation/report"),
                request("/api/collab/delegation/expiry-notices").catch(() => ({
                  notices: [],
                })),
              ]);
            const directory = await request("/api/collab/employee").catch(
              () => null,
            );
            const options = workspaceResult.workspaces ?? [];
            setMe(employeeMe.employee);
            setWorkspaces(options);
            const nextDelegations = delegationResult.delegations ?? [];
            setDelegations(nextDelegations);
            setReports(reportResult.reports ?? []);
            setExpiryNotices(expiryResult.notices ?? []);
            setEmployees(directory?.employees ?? [employeeMe.employee]);
            setIsAdmin(directory !== null);
            setWorkspaceId((current) => {
              const nativeId = options.find(
                (item) => item.id === nativeWorkspace?.workspaceId,
              )?.id;
              if (nativeId) return nativeId;
              return options.some((item) => item.id === current)
                ? current
                : (options.find((item) => item.isMember)?.id ??
                    options[0]?.id ??
                    "");
            });
            const contextWorkspaceIds = [
              ...new Set(nextDelegations.map((item) => item.workspaceId)),
            ].filter(Boolean);
            const contextResults = await Promise.all(
              contextWorkspaceIds.map(async (workspaceId) => {
                const [meetingResult, workflowResult] = await Promise.all([
                  request(
                    `/api/collab/meetings?workspaceId=${encodeURIComponent(workspaceId)}`,
                  ).catch(() => null),
                  request(
                    `/api/collab/workflow/instances?workspaceId=${encodeURIComponent(workspaceId)}`,
                  ).catch(() => null),
                ]);
                return {
                  workspaceId,
                  meetings: meetingResult?.meetings ?? [],
                  workflows: workflowResult?.instances ?? [],
                };
              }),
            );
            setContextMeetings(contextResults.flatMap((item) => item.meetings));
            setContextWorkflows(
              contextResults.flatMap((item) => item.workflows),
            );
            setError("");
            setPhase("ready");
          } catch (cause) {
            fail(cause);
            setPhase(cause.status === 401 ? "login" : "ready");
          }
        },
        [nativeWorkspace?.workspaceId],
      );

      react.useEffect(() => {
        void loadCore(false);
      }, [loadCore, tokenVersion]);

      react.useEffect(() => {
        const synchronize = () => setTokenVersion((value) => value + 1);
        window.addEventListener("pluginmax:collab-token", synchronize);
        return () =>
          window.removeEventListener("pluginmax:collab-token", synchronize);
      }, []);

      react.useEffect(() => {
        if (!isAdmin) {
          setGovernance(null);
          return;
        }
        let disposed = false;
        request("/api/collab/employee/governance")
          .then((result) => {
            if (!disposed) setGovernance(result);
          })
          .catch((cause) => {
            if (!disposed) fail(cause);
          });
        return () => {
          disposed = true;
        };
      }, [isAdmin, tokenVersion]);

      react.useEffect(() => {
        if (!effectiveWorkspaceId) return;
        let disposed = false;
        Promise.all([
          request(
            `/api/collab/workflow/definitions?workspaceId=${encodeURIComponent(effectiveWorkspaceId)}`,
          ),
          request(
            `/api/collab/workflow/instances?workspaceId=${encodeURIComponent(effectiveWorkspaceId)}`,
          ),
          request(
            `/api/collab/team/members?workspaceId=${encodeURIComponent(effectiveWorkspaceId)}`,
          ).catch(() => ({ members: [] })),
        ])
          .then(([definitionResult, instanceResult, memberResult]) => {
            if (disposed) return;
            const nextInstances = instanceResult.instances ?? [];
            setDefinitions(definitionResult.definitions ?? []);
            setInstances(nextInstances);
            setMembers(memberResult?.members ?? []);
            setSelectedInstance((current) =>
              nextInstances.some((item) => item.id === current)
                ? current
                : (nextInstances[0]?.id ?? ""),
            );
          })
          .catch((cause) => {
            if (!disposed) fail(cause);
          });
        return () => {
          disposed = true;
        };
      }, [effectiveWorkspaceId, tokenVersion]);

      react.useEffect(() => {
        if (!employees.length || selectedEmployee) return;
        const preferred =
          employees.find((item) => item.id === me?.id)?.id ??
          employees.find((item) => item.kind === "digital")?.id ??
          employees[0]?.id ??
          "";
        setSelectedEmployee(preferred);
      }, [employees, me?.id, selectedEmployee]);

      react.useEffect(() => {
        if (!selectedEmployee) return;
        let disposed = false;
        setEmployeeDetail(null);
        request(
          `/api/collab/employee/detail?employeeId=${encodeURIComponent(selectedEmployee)}`,
        )
          .then((result) => {
            if (!disposed) setEmployeeDetail(result);
          })
          .catch((cause) => {
            if (!disposed) {
              setEmployeeDetail(null);
              fail(cause);
            }
          });
        return () => {
          disposed = true;
        };
      }, [selectedEmployee, tokenVersion]);

      const loadWorkflowDetail = react.useCallback(async () => {
        if (!selectedInstance || !effectiveWorkspaceId) return;
        setWorkflowDetailLoading(true);
        try {
          const result = await request(
            `/api/collab/workflow/instances/detail?workspaceId=${encodeURIComponent(effectiveWorkspaceId)}&instanceId=${encodeURIComponent(selectedInstance)}`,
          );
          setWorkflowDetail(result);
          const nodeIds = Object.keys(result.instance.nodes ?? {});
          setSelectedNodeId((current) =>
            nodeIds.includes(current) ? current : (nodeIds[0] ?? ""),
          );
        } catch (cause) {
          setWorkflowDetail(null);
          fail(cause);
        } finally {
          setWorkflowDetailLoading(false);
        }
      }, [effectiveWorkspaceId, selectedInstance]);

      const toggleWorkflow = (instanceId) => {
        const next = selectedInstance === instanceId ? "" : instanceId;
        setSelectedInstance(next);
        setWorkflowDetail(null);
        setSelectedNodeId("");
      };

      react.useEffect(() => {
        void loadWorkflowDetail();
      }, [loadWorkflowDetail]);

      const delegationAction = async (delegationId, status) => {
        try {
          await request("/api/collab/delegation/status", {
            method: "POST",
            body: { delegationId, status },
          });
          setNotice(`委托已${statusLabel(status)}。`);
          setError("");
          await loadCore();
        } catch (cause) {
          fail(cause);
        }
      };

      const extendDelegation = async (delegationId) => {
        const value = window.prompt("延长多少分钟？", "30");
        const minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes <= 0) return;
        try {
          await request("/api/collab/delegation/extend", {
            method: "POST",
            body: { delegationId, durationMinutes: minutes },
          });
          setNotice("委托有效期已延长。");
          setError("");
          await loadCore();
        } catch (cause) {
          fail(cause);
        }
      };

      const openRelatedItem = (item) => {
        if (item.type === "workflow") {
          openView?.("pluginmax-workflow", item.contextId);
          return;
        }
        if (item.type !== "meeting") return;
        window.dispatchEvent(
          new CustomEvent("pluginmax:collab-navigate", {
            detail: {
              plugin: item.type,
              workspaceId: item.workspaceId,
              [item.type === "meeting" ? "meetingId" : "instanceId"]:
                item.contextId,
            },
          }),
        );
      };

      const generateReport = async (delegation) => {
        if (reportBusy) return;
        if (delegation.contextType !== "meeting") {
          fail(new Error("当前仅支持为会议分身手动生成报告。"));
          return;
        }
        setReportBusy(delegation.id);
        try {
          const detail = await request(
            `/api/collab/meeting?meetingId=${encodeURIComponent(delegation.contextId)}`,
          );
          const transcript = [
            ...(detail.transcript ?? []).map(
              (item) =>
                `${localTime(item.createdAt)} · ${item.senderName}: ${item.content}`,
            ),
            detail.meeting?.summary?.trim()
              ? `会议摘要：${detail.meeting.summary.trim()}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          if (!transcript.trim()) {
            throw new Error("该会议还没有可用的记录或摘要。");
          }
          await request("/api/collab/delegation/report/retry", {
            method: "POST",
            body: {
              delegationId: delegation.id,
              transcript,
              finalize: false,
            },
          });
          setNotice("分身报告已生成。");
          setError("");
          await loadCore();
        } catch (cause) {
          fail(cause);
        } finally {
          setReportBusy("");
        }
      };

      const workflowAction = async (path, body, message) => {
        try {
          await request(path, { method: "POST", body });
          setNotice(message);
          setError("");
          await loadWorkflowDetail();
          return true;
        } catch (cause) {
          fail(cause);
          return false;
        }
      };

      const employeePanel = h(
        "div",
        { style: card },
        h("strong", null, "员工与数字分身"),
        h(
          "select",
          {
            style: input,
            value: selectedSubjectValue,
            onChange: (event) => {
              const [type, id] = event.target.value.split(":");
              setSelectedSubject(event.target.value);
              if (type === "employee") setSelectedEmployee(id);
              if (type === "avatar") setSelectedDelegation(id);
            },
          },
          h(
            "optgroup",
            { label: "员工" },
            employees.map((item) =>
              h(
                "option",
                { key: `employee:${item.id}`, value: `employee:${item.id}` },
                `${item.displayName} · ${kindLabel(item.kind)} · ${statusLabel(item.status)}`,
              ),
            ),
          ),
          h(
            "optgroup",
            { label: "数字分身" },
            delegations.map((item) =>
              h(
                "option",
                { key: `avatar:${item.id}`, value: `avatar:${item.id}` },
                `${item.displayName} · ${item.ownerName} · ${statusLabel(item.status)}`,
              ),
            ),
          ),
        ),
        !showAvatarDetail && employeeDetail
          ? h(
              "div",
              { style: { display: "grid", gap: 8 } },
              h(
                "div",
                { style: grid2 },
                fieldRow("显示名", employeeDetail.employee.displayName),
                fieldRow(
                  "主体类型",
                  `${kindLabel(employeeDetail.employee.kind)} · ${statusLabel(employeeDetail.employee.status)}`,
                ),
                fieldRow(
                  "部门 / 岗位",
                  `${employeeDetail.employee.department || "-"} / ${employeeDetail.employee.title || "-"}`,
                ),
                fieldRow("Employee ID", employeeDetail.employee.id),
              ),
              h(
                "details",
                null,
                h(
                  "summary",
                  { style: muted },
                  `工作区授权（${employeeDetail.roles.length}）`,
                ),
                employeeDetail.roles.length === 0
                  ? h("div", { style: muted }, "暂无授权。")
                  : employeeDetail.roles.map((role) =>
                      h(
                        "div",
                        {
                          key: role.id,
                          style: {
                            ...muted,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            justifyContent: "space-between",
                          },
                        },
                        h(
                          "span",
                          null,
                          `${workspaceLabel(workspaces.find((item) => item.id === role.workspaceId))} · ${role.role} · ${role.permissions.join("、") || "无权限"} · 到期 ${localTime(role.expiresAt)}`,
                        ),
                        isAdmin && role.status === "active"
                          ? h(
                              "button",
                              {
                                style: { ...ghost, fontSize: 12, minWidth: 48 },
                                onClick: async () => {
                                  try {
                                    await request(
                                      "/api/collab/employee/roles/revoke",
                                      {
                                        method: "POST",
                                        body: { assignmentId: role.id },
                                      },
                                    );
                                    setNotice("授权已撤销。");
                                    const refreshed = await request(
                                      `/api/collab/employee/detail?employeeId=${encodeURIComponent(employeeDetail.employee.id)}`,
                                    );
                                    setEmployeeDetail(refreshed);
                                  } catch (cause) {
                                    fail(cause);
                                  }
                                },
                              },
                              "撤销",
                            )
                          : null,
                      ),
                    ),
                isAdmin
                  ? h(
                      "div",
                      { style: { ...muted, marginTop: 6 } },
                      "新增授权请前往 Settings >「员工」>「数字员工 / 真人员工」管理页。",
                    )
                  : null,
              ),
              h(
                "details",
                null,
                h(
                  "summary",
                  { style: muted },
                  `Runtime Profile（${employeeDetail.runtimeProfiles.length}）`,
                ),
                employeeDetail.runtimeProfiles.length === 0
                  ? h("div", { style: muted }, "暂无运行配置。")
                  : employeeDetail.runtimeProfiles.map((profile) =>
                      h(
                        "div",
                        { key: profile.id, style: muted },
                        `${profile.name} · ${workspaceLabel(workspaces.find((item) => item.id === profile.workspaceId))} · ${profile.provider}/${profile.model || "默认模型"} · Task Worker ${profile.legacyAgentProfileId || "未映射"}`,
                      ),
                    ),
              ),
              isAdmin && employeeDetail.audit.length > 0
                ? h(
                    "details",
                    null,
                    h(
                      "summary",
                      { style: muted },
                      `审计（${employeeDetail.audit.length}）`,
                    ),
                    employeeDetail.audit
                      .slice(0, 20)
                      .map((item) =>
                        h(
                          "div",
                          { key: item.id, style: muted },
                          `${localTime(item.at)} · ${item.action} · ${item.decision}`,
                        ),
                      ),
                  )
                : null,
            )
          : showAvatarDetail && selectedDelegationItem
            ? h(
                "div",
                { style: { display: "grid", gap: 8 } },
                h(
                  "div",
                  { style: grid2 },
                  fieldRow("分身名称", selectedDelegationItem.displayName),
                  fieldRow("所属员工", selectedDelegationItem.ownerName),
                  fieldRow(
                    "有效期",
                    selectedDelegationItem.expiresAt
                      ? localTime(selectedDelegationItem.expiresAt)
                      : "不限",
                  ),
                ),
                fieldRow("目标", selectedDelegationItem.objective, {
                  preserveLines: true,
                }),
                fieldRow(
                  "立场与指令",
                  selectedDelegationItem.stance || "未设置",
                  { preserveLines: true },
                ),
                h(
                  "div",
                  { style: grid2 },
                  fieldRow("所在项目", workspaceLabel(selectedWorkspace)),
                  fieldRow(
                    "当前状态",
                    statusLabel(selectedDelegationItem.status),
                  ),
                ),
                selectedDelegationItem.status === "expired"
                  ? h(
                      "div",
                      {
                        style: {
                          background: "rgba(217,154,38,0.14)",
                          borderRadius: 6,
                          color: "#d99a26",
                          display: "grid",
                          fontSize: 12,
                          gap: 8,
                          lineHeight: 1.5,
                          padding: "9px 10px",
                        },
                      },
                      h(
                        "span",
                        null,
                        "分身已到期：相关事项的自动跟进已暂停。可恢复并延期继续使用，也可以另派分身接手。",
                      ),
                      h(
                        "div",
                        { style: row },
                        h(
                          "button",
                          {
                            style: ghost,
                            onClick: () =>
                              delegationAction(
                                selectedDelegationItem.id,
                                "active",
                              ),
                          },
                          "恢复",
                        ),
                        h(
                          "button",
                          {
                            style: ghost,
                            onClick: () =>
                              extendDelegation(selectedDelegationItem.id),
                          },
                          "延期",
                        ),
                      ),
                    )
                  : null,
                h(
                  "div",
                  { style: { display: "grid", gap: 8 } },
                  h("strong", { style: { fontSize: 13 } }, "参与事项"),
                  relatedItems.map((item) =>
                    h(
                      "div",
                      {
                        key: item.key,
                        style: {
                          alignItems: "center",
                          border: "0.5px solid var(--dsw-alias-border-l2)",
                          borderRadius: 6,
                          display: "flex",
                          gap: 8,
                          padding: "8px 10px",
                        },
                      },
                      h(
                        "div",
                        { style: { flex: 1, minWidth: 0 } },
                        h(
                          "div",
                          {
                            style: {
                              fontSize: 13,
                              fontWeight: 600,
                              overflowWrap: "anywhere",
                            },
                          },
                          `${item.meta} · ${item.title}`,
                        ),
                        h(
                          "div",
                          { style: muted },
                          item.status ? statusLabel(item.status) : "可参与",
                        ),
                      ),
                      ["meeting", "workflow"].includes(item.type)
                        ? h(
                            "button",
                            {
                              style: ghost,
                              onClick: () => openRelatedItem(item, openView),
                            },
                            "详情 / 编辑",
                          )
                        : null,
                    ),
                  ),
                ),
                h(
                  "div",
                  { style: grid2 },
                  fieldRow(
                    "授权动作",
                    actionListLabel(selectedDelegationItem.allowedActions),
                    { preserveLines: true },
                  ),
                  fieldRow(
                    "禁止动作",
                    actionListLabel(selectedDelegationItem.deniedActions),
                    { preserveLines: true },
                  ),
                ),
                h(
                  "div",
                  { style: grid2 },
                  fieldRow(
                    "发言策略",
                    speakPolicyLabel(selectedDelegationItem.speakPolicy),
                  ),
                  fieldRow(
                    "审批策略",
                    approvalPolicyLabel(selectedDelegationItem.approvalPolicy),
                  ),
                ),
                ["active", "paused"].includes(selectedDelegationItem.status)
                  ? h(
                      "div",
                      { style: row },
                      h(
                        "button",
                        {
                          style: ghost,
                          onClick: () =>
                            extendDelegation(selectedDelegationItem.id),
                        },
                        "延期",
                      ),
                      h(
                        "button",
                        {
                          style: ghost,
                          onClick: () =>
                            delegationAction(
                              selectedDelegationItem.id,
                              selectedDelegationItem.status === "active"
                                ? "paused"
                                : "active",
                            ),
                        },
                        selectedDelegationItem.status === "active"
                          ? "暂停"
                          : "恢复",
                      ),
                      h(
                        "button",
                        {
                          style: danger,
                          onClick: () =>
                            delegationAction(
                              selectedDelegationItem.id,
                              "revoked",
                            ),
                        },
                        "召回",
                      ),
                    )
                  : null,
                (() => {
                  const delegationReports = reports.filter(
                    (item) => item.delegationId === selectedDelegationItem.id,
                  );
                  const report = delegationReports[0];
                  return h(
                    "div",
                    { style: { display: "grid", gap: 8 } },
                    h(
                      "div",
                      { style: row },
                      h(
                        "strong",
                        { style: { fontSize: 13 } },
                        `分身报告（${delegationReports.length}）`,
                      ),
                      selectedDelegationItem.contextType === "meeting"
                        ? h(
                            "button",
                            {
                              style: ghost,
                              disabled:
                                reportBusy === selectedDelegationItem.id,
                              onClick: () =>
                                void generateReport(selectedDelegationItem),
                            },
                            reportBusy === selectedDelegationItem.id
                              ? "生成中..."
                              : report
                                ? "刷新报告"
                                : "生成报告",
                          )
                        : null,
                    ),
                    !report
                      ? h("div", { style: muted }, "暂无分身报告。")
                      : h(
                          "details",
                          null,
                          h(
                            "summary",
                            { style: muted },
                            `最新报告 · ${statusLabel(report.status)} · ${localTime(report.createdAt)}`,
                          ),
                          h(
                            "pre",
                            {
                              style: {
                                ...muted,
                                whiteSpace: "pre-wrap",
                                margin: "8px 0 0",
                              },
                            },
                            report.status === "failed"
                              ? report.error
                              : report.report,
                          ),
                        ),
                  );
                })(),
              )
            : h("div", { style: muted }, "选择员工或数字分身后显示详情。"),
      );

      const workflowPanel = h(
        "div",
        { style: card },
        h(
          "div",
          { style: { ...row, justifyContent: "space-between" } },
          h("strong", null, "工作流"),
          h(
            "button",
            { style: ghost, onClick: () => void loadWorkflowDetail() },
            "刷新",
          ),
        ),
        instances.length === 0
          ? h("div", { style: muted }, "当前工作区暂无工作流。")
          : h(
              "div",
              { style: { display: "grid", gap: 8 } },
              instances.map((item) => {
                const definition = definitions.find(
                  (candidate) => candidate.id === item.definitionId,
                );
                const isOpen = selectedInstance === item.id;
                const summaryButton = {
                  alignItems: "center",
                  background: "transparent",
                  border: 0,
                  color: "inherit",
                  cursor: "pointer",
                  display: "grid",
                  font: "inherit",
                  gap: 8,
                  gridTemplateColumns: "10px minmax(0,1fr) auto",
                  padding: "8px 0",
                  textAlign: "left",
                  width: "100%",
                };
                return h(
                  "div",
                  {
                    key: item.id,
                    style: {
                      border: "0.5px solid var(--dsw-alias-border-l2)",
                      borderRadius: 6,
                      padding: isOpen ? "4px 10px 10px" : "2px 10px",
                    },
                  },
                  h(
                    "button",
                    {
                      style: summaryButton,
                      onClick: () => toggleWorkflow(item.id),
                    },
                    [
                      h("span", { style: workflowDot(item.status) }),
                      h(
                        "span",
                        { style: { display: "grid", gap: 3, minWidth: 0 } },
                        h(
                          "span",
                          {
                            style: {
                              fontSize: 13,
                              fontWeight: 600,
                              overflowWrap: "anywhere",
                            },
                          },
                          item.title,
                        ),
                        h(
                          "span",
                          { style: muted },
                          `${definition?.name ?? item.definitionKey} v${item.definitionVersion} · ${localTime(item.updatedAt)}`,
                        ),
                      ),
                      h(
                        "span",
                        { style: workflowPill(item.status) },
                        statusLabel(item.status),
                      ),
                    ],
                  ),
                  isOpen
                    ? h(
                        "div",
                        {
                          style: {
                            display: "grid",
                            gap: 9,
                            borderTop: "0.5px solid var(--dsw-alias-border-l2)",
                            paddingTop: 9,
                          },
                        },
                        h(
                          "div",
                          {
                            style: { ...row, justifyContent: "space-between" },
                          },
                          h(
                            "span",
                            { style: { ...muted, fontWeight: 600 } },
                            "节点状态明细",
                          ),
                          h(
                            "button",
                            {
                              style: ghost,
                              onClick: () =>
                                openView?.("pluginmax-workflow", item.id),
                            },
                            "详情 / 编辑",
                          ),
                        ),
                        workflowDetailLoading && !workflowDetail
                          ? h("div", { style: muted }, "正在加载节点明细…")
                          : (definition?.graph.nodes ?? []).map((node) => {
                              const state =
                                workflowDetail?.instance?.nodes?.[node.id];
                              const isSelected = selectedNodeId === node.id;
                              const nodeRuns = (
                                workflowDetail?.agentRuns ?? []
                              ).filter((run) => run.nodeId === node.id);
                              const runSeq = Math.max(
                                0,
                                ...nodeRuns.map((run) => run.runSeq ?? 0),
                              );
                              const attemptLabel =
                                runSeq > 0
                                  ? `第 ${state?.attempts ?? 0} 次激活 · 本轮第 ${runSeq} 次派发`
                                  : `第 ${state?.attempts ?? 0} 次激活`;
                              return h(
                                "div",
                                {
                                  key: node.id,
                                  style: { display: "grid", gap: 8 },
                                },
                                h(
                                  "button",
                                  {
                                    style: {
                                      alignItems: "center",
                                      background: isSelected
                                        ? "var(--dsw-alias-bg-layer-2)"
                                        : "transparent",
                                      border:
                                        "0.5px solid var(--dsw-alias-border-l2)",
                                      borderRadius: 6,
                                      color: "inherit",
                                      cursor: "pointer",
                                      display: "grid",
                                      font: "inherit",
                                      gap: 8,
                                      gridTemplateColumns: "70px minmax(0,1fr)",
                                      padding: "8px 9px",
                                      textAlign: "left",
                                    },
                                    onClick: () => setSelectedNodeId(node.id),
                                  },
                                  [
                                    h(
                                      "span",
                                      {
                                        style: workflowPill(
                                          state?.status ?? "waiting",
                                        ),
                                      },
                                      statusLabel(state?.status ?? "waiting"),
                                    ),
                                    h(
                                      "span",
                                      {
                                        style: {
                                          display: "grid",
                                          gap: 3,
                                          minWidth: 0,
                                        },
                                      },
                                      h(
                                        "span",
                                        {
                                          style: {
                                            fontSize: 13,
                                            fontWeight: 600,
                                            overflowWrap: "anywhere",
                                          },
                                        },
                                        node.name,
                                      ),
                                      h(
                                        "span",
                                        { style: muted },
                                        `${actorDisplay(node.executor, workflowActorNames)} · ${attemptLabel}`,
                                      ),
                                    ),
                                  ],
                                ),
                                isSelected && state
                                  ? h(
                                      "div",
                                      {
                                        style: {
                                          display: "grid",
                                          gap: 8,
                                          padding: "0 2px",
                                        },
                                      },
                                      (() => {
                                        const executorEmployee =
                                          node.executor.kind === "employee"
                                            ? employees.find(
                                                (candidate) =>
                                                  candidate.id ===
                                                  node.executor.id,
                                              )
                                            : null;
                                        const executorBlocked =
                                          executorEmployee &&
                                          ["paused", "archived"].includes(
                                            executorEmployee.status,
                                          );
                                        return h(
                                          "div",
                                          {
                                            style: {
                                              alignItems: "flex-start",
                                              display: "flex",
                                              flexWrap: "wrap",
                                              gap: 10,
                                              justifyContent: "space-between",
                                            },
                                          },
                                          h(
                                            "div",
                                            {
                                              style: {
                                                ...grid2,
                                                flex: "1 1 260px",
                                                minWidth: 0,
                                              },
                                            },
                                            fieldRow(
                                              "执行者",
                                              actorDisplay(
                                                node.executor,
                                                workflowActorNames,
                                              ),
                                            ),
                                            fieldRow(
                                              "责任人",
                                              actorDisplay(
                                                node.responsible,
                                                workflowActorNames,
                                              ),
                                            ),
                                          ),
                                          h(
                                            "div",
                                            {
                                              style: {
                                                ...row,
                                                flex: "0 0 auto",
                                                justifyContent: "flex-end",
                                              },
                                            },
                                            executorBlocked
                                              ? h(
                                                  "span",
                                                  { style: muted },
                                                  "执行者已停用",
                                                )
                                              : [
                                                  node.type === "approval"
                                                    ? h(
                                                        "button",
                                                        {
                                                          style: ghost,
                                                          onClick: () =>
                                                            openView?.(
                                                              "pluginmax-workflow",
                                                              item.id,
                                                            ),
                                                        },
                                                        "去审批",
                                                      )
                                                    : null,
                                                  node.type !== "approval" &&
                                                  node.execution ===
                                                    "task-worker" &&
                                                  state.status === "ready"
                                                    ? h(
                                                        "button",
                                                        {
                                                          style: ghost,
                                                          onClick: () =>
                                                            workflowAction(
                                                              "/api/collab/workflow/agent-runs/dispatch",
                                                              {
                                                                workspaceId:
                                                                  effectiveWorkspaceId,
                                                                instanceId:
                                                                  item.id,
                                                                nodeId: node.id,
                                                              },
                                                              "已派发运行。",
                                                            ),
                                                        },
                                                        "派发",
                                                      )
                                                    : null,
                                                  state.status === "ready"
                                                    ? h(
                                                        "button",
                                                        {
                                                          style: ghost,
                                                          onClick: () =>
                                                            workflowAction(
                                                              "/api/collab/workflow/nodes/complete",
                                                              {
                                                                workspaceId:
                                                                  effectiveWorkspaceId,
                                                                instanceId:
                                                                  item.id,
                                                                nodeId: node.id,
                                                              },
                                                              "节点已尝试完成。",
                                                            ),
                                                        },
                                                        "完成",
                                                      )
                                                    : null,
                                                ],
                                          ),
                                        );
                                      })(),
                                      state.note
                                        ? fieldRow("说明", state.note, {
                                            preserveLines: true,
                                          })
                                        : null,
                                      nodeRuns.length > 0
                                        ? h(
                                            "details",
                                            null,
                                            h(
                                              "summary",
                                              { style: muted },
                                              `运行记录（${nodeRuns.length}）`,
                                            ),
                                            nodeRuns
                                              .slice(0, 10)
                                              .map((run) =>
                                                h(
                                                  "div",
                                                  { key: run.id, style: muted },
                                                  `${run.principalType === "digital-employee" ? "Digital Employee" : "Task Worker"} · ${runStatusLabel(run.status)} · ${run.employeeId ? (employeeNames.get(run.employeeId) ?? run.employeeId) : run.profileId || "未指定执行者"}`,
                                                ),
                                              ),
                                          )
                                        : null,
                                    )
                                  : null,
                              );
                            }),
                      )
                    : null,
                );
              }),
            ),
      );

      const reportPanel = h(
        "div",
        { style: card },
        h("strong", null, "分身报告"),
        h("input", {
          style: input,
          value: reportQuery,
          placeholder: "搜索分身、主人或报告内容",
          onChange: (event) => setReportQuery(event.target.value),
        }),
        reportMatches.length === 0
          ? h("div", { style: muted }, "没有匹配的分身报告。")
          : reportMatches.map((report) => {
              const delegation = delegations.find(
                (item) => item.id === report.delegationId,
              );
              return h(
                "details",
                { key: report.id },
                h(
                  "summary",
                  { style: muted },
                  `${delegation?.displayName ?? "分身报告"} · ${statusLabel(report.status)} · ${localTime(report.createdAt)}`,
                ),
                h(
                  "div",
                  { style: muted },
                  delegation
                    ? `${delegation.ownerName} · ${delegation.contextType} · ${delegation.contextId}`
                    : report.delegationId,
                ),
                h(
                  "pre",
                  {
                    style: {
                      ...muted,
                      whiteSpace: "pre-wrap",
                      margin: "8px 0 0",
                    },
                  },
                  report.status === "failed" ? report.error : report.report,
                ),
              );
            }),
      );

      const permissionPanel = h(
        "div",
        { style: card },
        h("strong", null, "管理员权限面板"),
        isAdmin && governance
          ? h(
              "div",
              { style: { display: "grid", gap: 8 } },
              h(
                "div",
                { style: grid2 },
                fieldRow("员工", String(governance.employees?.length ?? 0)),
                fieldRow("授权记录", String(governance.roles?.length ?? 0)),
                fieldRow(
                  "Runtime Profile",
                  String(governance.profiles?.length ?? 0),
                ),
                fieldRow(
                  "有效票据",
                  String(
                    (governance.tickets ?? []).filter(
                      (item) => item.status === "active",
                    ).length,
                  ),
                ),
              ),
              h(
                "div",
                { style: { maxHeight: 240, overflow: "auto" } },
                h(
                  "table",
                  { style: table },
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      ["员工", "工作区", "角色", "权限", "到期"].map((label) =>
                        h("th", { key: label, style: cell }, label),
                      ),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    (governance.roles ?? [])
                      .slice(0, 50)
                      .map((role) =>
                        h(
                          "tr",
                          { key: role.id },
                          h(
                            "td",
                            { style: cell },
                            employeeNames.get(role.employeeId) ??
                              role.employeeId,
                          ),
                          h(
                            "td",
                            { style: cell },
                            workspaceLabel(
                              workspaces.find(
                                (item) => item.id === role.workspaceId,
                              ),
                            ),
                          ),
                          h("td", { style: cell }, role.role),
                          h(
                            "td",
                            { style: cell },
                            role.permissions.join("、") || "无",
                          ),
                          h("td", { style: cell }, localTime(role.expiresAt)),
                        ),
                      ),
                  ),
                ),
              ),
            )
          : h(
              "div",
              { style: muted },
              isAdmin ? "治理数据加载中。" : "此面板需要全局管理员权限。",
            ),
      );

      const expiryNoticePanel = expiryNotices.length
        ? h(
            "div",
            {
              style: {
                background: "rgba(217,154,38,0.14)",
                border: "0.5px solid rgba(217,154,38,0.42)",
                borderRadius: 6,
                display: "grid",
                gap: 10,
                padding: 12,
              },
            },
            h("strong", null, `分身到期提醒（${expiryNotices.length}）`),
            expiryNotices.map((notice) => {
              const contextTitle =
                notice.contextType === "meeting"
                  ? contextMeetings.find((item) => item.id === notice.contextId)
                      ?.title
                  : notice.contextType === "workflow"
                    ? contextWorkflows.find(
                        (item) => item.id === notice.contextId,
                      )?.title
                    : undefined;
              const relatedItem = {
                type: notice.contextType,
                workspaceId: notice.workspaceId,
                contextId: notice.contextId,
              };
              return h(
                "div",
                {
                  key: notice.id,
                  style: {
                    background: "var(--dsw-alias-bg-layer-2)",
                    border: "0.5px solid var(--dsw-alias-border-l2)",
                    borderRadius: 6,
                    display: "grid",
                    gap: 8,
                    padding: "9px 10px",
                  },
                },
                h(
                  "div",
                  { style: { fontSize: 13, fontWeight: 600 } },
                  `${notice.displayName} 已到期 · ${contextTypeLabel(notice.contextType)}${contextTitle ? `「${contextTitle}」` : ""}`,
                ),
                h(
                  "div",
                  { style: muted },
                  `${notice.impact} 到期时间：${notice.expiresAt ? localTime(notice.expiresAt) : "不限"}。可延期或恢复当前分身；若不适合继续使用，请另派分身接手。`,
                ),
                h(
                  "div",
                  { style: row },
                  h(
                    "button",
                    {
                      style: ghost,
                      onClick: () => extendDelegation(notice.delegationId),
                    },
                    "延期并恢复",
                  ),
                  h(
                    "button",
                    {
                      style: ghost,
                      onClick: () =>
                        delegationAction(notice.delegationId, "active"),
                    },
                    "恢复",
                  ),
                  h(
                    "button",
                    {
                      style: ghost,
                      onClick: () => {
                        setSelectedDelegation(notice.delegationId);
                        setSelectedSubject(`avatar:${notice.delegationId}`);
                        if (
                          ["meeting", "workflow"].includes(notice.contextType)
                        )
                          openRelatedItem(relatedItem, openView);
                      },
                    },
                    "查看事项",
                  ),
                ),
              );
            }),
          )
        : null;

      if (phase === "loading") return h("div", { style: muted }, "加载工作台…");
      if (phase === "login")
        return h(
          "div",
          { style: muted },
          "请先在「账号与权限 → 登录账号」登录。",
        );

      return h(
        "div",
        { style: { display: "grid", gap: 14, minHeight: 0 } },
        h(
          "div",
          { style: row },
          h("strong", { style: { fontSize: 16 } }, "工作台"),
          h(
            "span",
            { style: muted },
            `${workspaceLabel(workspaces.find((item) => item.id === effectiveWorkspaceId))}${sessionId ? ` · 会话 ${shortId(sessionId)}` : ""}`,
          ),
          h(
            "select",
            {
              style: { ...input, width: "auto", minWidth: 180 },
              value: effectiveWorkspaceId,
              onChange: (event) => setWorkspaceId(event.target.value),
            },
            workspaces.map((item) =>
              h(
                "option",
                { key: item.id, value: item.id },
                workspaceLabel(item),
              ),
            ),
          ),
          h("button", { style: ghost, onClick: () => void loadCore() }, "刷新"),
        ),
        error
          ? h("div", { style: { ...muted, color: "#e26d6d" } }, error)
          : null,
        notice
          ? h("div", { style: { ...muted, color: "#4fc487" } }, notice)
          : null,
        expiryNoticePanel,
        employeePanel,
        workflowPanel,
        reportPanel,
        permissionPanel,
      );
    }

    function EmployeeSection(props = {}) {
      const auditOnly = props.surface === "audit";
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [me, setMe] = react.useState(null);
      const [employees, setEmployees] = react.useState([]);
      const [personas, setPersonas] = react.useState([]);
      const [aiTemplates, setAiTemplates] = react.useState([]);
      const [isAdmin, setIsAdmin] = react.useState(false);
      const [detail, setDetail] = react.useState(null);
      const [delegations, setDelegations] = react.useState([]);
      const [reports, setReports] = react.useState([]);
      const [audit, setAudit] = react.useState([]);
      const [workflowInstances, setWorkflowInstances] = react.useState([]);
      const [workspaces, setWorkspaces] = react.useState([]);
      const [reload, setReload] = react.useState(0);
      const [governance, setGovernance] = react.useState(null);
      const [agentRuns, setAgentRuns] = react.useState([]);
      const [govWorkspace, setGovWorkspace] = react.useState("all");
      const [govEmployee, setGovEmployee] = react.useState("all");
      const [govFrom, setGovFrom] = react.useState("");
      const [govTo, setGovTo] = react.useState("");
      const [govSearch, setGovSearch] = react.useState("");
      const [createKind, setCreateKind] = react.useState("");
      const [createLogin, setCreateLogin] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const savingRef = react.useRef(false);
      const [openPanels, setOpenPanels] = react.useState({
        edit: false,
        auth: false,
        runtime: false,
        delegation: false,
      });
      const [formVersion, setFormVersion] = react.useState(0);

      const refresh = async () => {
        if (token() === null) {
          setPhase("login");
          return;
        }
        try {
          const meResult = await request("/api/collab/employee/me");
          setMe(meResult.employee);
          const directory = await request("/api/collab/employee").catch(
            () => null,
          );
          setIsAdmin(directory !== null);
          setEmployees(directory?.employees ?? [meResult.employee]);
          const [
            delegationResult,
            reportResult,
            workspaceResult,
            personaResult,
            templateResult,
          ] = await Promise.all([
            request("/api/collab/delegation"),
            request("/api/collab/delegation/report"),
            request("/api/collab/team/workspaces"),
            request("/api/collab/roles/personas").catch(() => null),
            request("/api/collab/teammate-templates").catch(() => null),
          ]);
          setDelegations(delegationResult.delegations ?? []);
          setReports(reportResult.reports ?? []);
          setWorkspaces(workspaceResult.workspaces ?? []);
          setPersonas(personaResult?.personas ?? []);
          setAiTemplates(templateResult?.templates ?? []);
          if (directory !== null) {
            const [auditResult, instanceResults] = await Promise.all([
              request("/api/collab/employee/audit?limit=100").catch(() => null),
              Promise.all(
                (workspaceResult.workspaces ?? []).map((workspace) =>
                  request(
                    `/api/collab/workflow/instances?workspaceId=${encodeURIComponent(workspace.id)}`,
                  ).catch(() => null),
                ),
              ),
            ]);
            setAudit(auditResult?.audit ?? []);
            setWorkflowInstances(
              instanceResults.flatMap((result) => result?.instances ?? []),
            );
          }
          setError("");
          setPhase("ready");
        } catch (cause) {
          setError(friendly(cause));
          setPhase(cause.status === 401 ? "login" : "ready");
        }
      };

      react.useEffect(() => {
        void refresh();
      }, [reload]);

      const loadDetail = async (employeeId) => {
        try {
          const result = await request(
            `/api/collab/employee/detail?employeeId=${encodeURIComponent(employeeId)}`,
          );
          setDetail(result);
          setError("");
        } catch (cause) {
          setError(friendly(cause));
        }
      };
      const panelToggle = (key) => (event) =>
        setOpenPanels((current) => ({
          ...current,
          [key]: event.target.open,
        }));
      const runBusy = async (action, successMessage) => {
        if (savingRef.current) return false;
        savingRef.current = true;
        setSaving(true);
        try {
          await action();
          if (successMessage) setNotice(successMessage);
          setError("");
          return true;
        } catch (cause) {
          setError(friendly(cause));
          setNotice("");
          return false;
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      };
      const submit = (action, successMessage) => async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const ok = await runBusy(
          () => action(formData({ currentTarget: form })),
          successMessage,
        );
        if (ok) {
          form.reset();
          setDetail(null);
          await refresh();
        }
      };
      const createHumanEmployee = async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const values = formEntries(event);
        let employeeId = "";
        const ok = await runBusy(async () => {
          const result = await request("/api/collab/employee/human", {
            method: "POST",
            body: {
              employeeId: values.text("employeeId") || undefined,
              displayName: values.text("displayName"),
              email: values.text("email") || undefined,
              department: values.text("department"),
              title: values.text("title"),
              tags: values.list("tags"),
              managerEmployeeId: values.text("managerEmployeeId") || undefined,
              account: createLogin
                ? {
                    userId: values.text("accountUserId"),
                    password: values.text("accountPassword"),
                  }
                : undefined,
            },
          });
          employeeId = result.employee.id;
        }, "人类员工已创建。");
        if (!ok) return;
        form.reset();
        setCreateLogin(false);
        setCreateKind("");
        await refresh();
        if (employeeId !== "") await loadDetail(employeeId);
      };
      const createAiEmployee = async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const values = formEntries(event);
        let employeeId = "";
        const ok = await runBusy(async () => {
          const result = await request(
            "/api/collab/teammates/create-with-employee",
            {
              method: "POST",
              body: {
                templateId: values.text("templateId"),
                workspaceId: values.text("workspaceId"),
                name: values.text("displayName"),
                employeeId: values.text("employeeId") || undefined,
                displayName: values.text("displayName"),
                department: values.text("department"),
                title: values.text("title"),
                tags: values.list("tags"),
                managerEmployeeId: values.text("managerEmployeeId"),
              },
            },
          );
          employeeId = result.employee.id;
        }, "AI 员工与 AI 伙伴已创建并绑定。");
        if (!ok) return;
        form.reset();
        setCreateKind("");
        await refresh();
        if (employeeId !== "") await loadDetail(employeeId);
      };
      const changeStatus = async (employeeId, status) =>
        runBusy(
          async () => {
            await request("/api/collab/employee/status", {
              method: "POST",
              body: { employeeId, status },
            });
            await refresh();
            if (detail?.employee.id === employeeId)
              await loadDetail(employeeId);
          },
          `员工状态已更新为${statusLabel(status)}。`,
        );
      const delegationStatus = async (delegationId, status) =>
        runBusy(async () => {
          await request("/api/collab/delegation/status", {
            method: "POST",
            body: { delegationId, status },
          });
          await refresh();
        }, "委托状态已更新。");
      const extendDelegation = async (delegationId) => {
        if (saving) return;
        const value = window.prompt("延长多少分钟？", "30");
        const minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes <= 0) return;
        await post(
          "/api/collab/delegation/extend",
          { delegationId, durationMinutes: minutes },
          "委托有效期已延长。",
        );
      };
      const post = async (path, body, successMessage, employeeId) =>
        runBusy(async () => {
          await request(path, { method: "POST", body });
          await refresh();
          if (employeeId) await loadDetail(employeeId);
        }, successMessage);
      const revokeRole = async (assignmentId) => {
        await post(
          "/api/collab/employee/roles/revoke",
          { assignmentId },
          "授权已回收。",
          detail.employee.id,
        );
      };
      const updateEmployee = async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const parsed = formEntries(event);
        const ok = await post(
          "/api/collab/employee/update",
          {
            employeeId: detail.employee.id,
            displayName: parsed.text("displayName"),
            email: parsed.text("email") || null,
            department: parsed.text("department"),
            title: parsed.text("title"),
            tags: parsed.list("tags"),
            personaId: parsed.text("personaId"),
            managerEmployeeId: parsed.text("managerEmployeeId"),
          },
          "员工资料已更新。",
          detail.employee.id,
        );
        if (ok) {
          form.reset();
          setFormVersion((value) => value + 1);
          setOpenPanels((current) => ({ ...current, edit: false }));
        }
      };
      const assignRole = async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const parsed = formEntries(event);
        const ok = await post(
          "/api/collab/employee/roles/assign",
          {
            employeeId: detail.employee.id,
            workspaceId: parsed.text("workspaceId"),
            role: parsed.text("role"),
            permissions: parsed.list("permissions"),
            durationMinutes: parsed.number("durationMinutes"),
          },
          "工作区授权已保存。",
          detail.employee.id,
        );
        if (ok) {
          form.reset();
          setFormVersion((value) => value + 1);
          setOpenPanels((current) => ({ ...current, auth: false }));
        }
      };
      const saveRuntime = async (event) => {
        event.preventDefault();
        if (saving) return;
        const form = event.currentTarget;
        const parsed = formEntries(event);
        const ok = await post(
          "/api/collab/employee/runtime/upsert",
          {
            employeeId: detail.employee.id,
            workspaceId: parsed.text("workspaceId"),
            name: parsed.text("name"),
            provider: parsed.text("provider"),
            model: parsed.text("model"),
            reasoningEffort: parsed.text("reasoningEffort"),
            allowedTools: parsed.list("allowedTools"),
            deniedTools: parsed.list("deniedTools"),
            resourceScopes: parsed.list("resourceScopes"),
            maxTurns: parsed.number("maxTurns"),
            maxMinutes: parsed.number("maxMinutes"),
            status: parsed.text("status") || undefined,
            legacyAgentProfileId:
              parsed.text("legacyAgentProfileId") || undefined,
          },
          "Runtime Profile 已保存。",
          detail.employee.id,
        );
        if (ok) {
          form.reset();
          setFormVersion((value) => value + 1);
          setOpenPanels((current) => ({ ...current, runtime: false }));
        }
      };
      const createDelegation = async (event) => {
        event.preventDefault();
        if (saving) return;
        const parsed = formEntries(event);
        const form = event.currentTarget;
        const ok = await post(
          "/api/collab/delegation/create",
          {
            displayName: parsed.text("displayName") || undefined,
            personaId: parsed.text("personaId") || undefined,
            workspaceId: parsed.text("workspaceId"),
            contextType: parsed.text("contextType"),
            contextId: parsed.text("contextId"),
            objective: parsed.text("objective"),
            stance: parsed.text("stance"),
            watchItems: parsed.list("watchItems"),
            materialScopes: parsed.list("materialScopes"),
            allowedActions: parsed.list("allowedActions"),
            deniedActions: parsed.list("deniedActions"),
            speakPolicy: parsed.text("speakPolicy"),
            approvalPolicy: parsed.text("approvalPolicy"),
            durationMinutes: parsed.number("durationMinutes"),
          },
          "委托已创建。",
        );
        if (ok) {
          form.reset();
          setFormVersion((value) => value + 1);
          setOpenPanels((current) => ({ ...current, delegation: false }));
        }
      };

      const employeeById = new Map(
        employees.map((employee) => [employee.id, employee]),
      );
      const instanceById = new Map(
        workflowInstances.map((instance) => [instance.id, instance]),
      );
      const auditEmployee = (id) => {
        const employee = employeeById.get(id);
        const kind = employee?.kind === "digital" ? "数字员工" : "真人员工";
        return `${employee?.displayName ?? id} · ${kind}`;
      };
      const auditActionTitle = (item) =>
        ({
          "employee.created": "创建数字员工",
          "employee.updated": "更新数字员工资料",
          "employee.status_changed": "变更员工状态",
          "employee.role_assigned": "授予工作区权限",
          "employee.role_revoked": "撤销工作区权限",
          "employee.runtime.updated": "更新 Runtime Profile",
          "employee.ticket.issued": "签发数字员工运行票据",
          "delegation.created": "创建分身委托",
          "delegation.paused": "暂停分身委托",
          "delegation.resumed": "恢复分身委托",
          "delegation.revoked": "召回分身委托",
          "delegation.completed": "完成分身委托",
          "delegation.expired": "分身委托到期",
          "delegation.extended": "延长分身委托",
          "delegation.ticket.issued": "签发分身运行票据",
          "delegation.report_generated": "生成分身报告",
          "delegation.report_failed": "分身报告生成失败",
          read: "读取工作流资料",
          write: "写入工作流交付物",
        })[item.action] ?? item.action;
      const auditContextType = (type) =>
        ({
          workflow: "工作流实例",
          meeting: "会议",
          task: "任务",
          review: "评审",
        })[type] ?? type;
      const auditTarget = (item) => {
        if (item.contextType === "workflow" && item.contextId) {
          const instance = instanceById.get(item.contextId);
          return `工作流实例 · ${instance?.title ?? "标题不可用"}`;
        }
        if (item.contextType && item.contextId) {
          return `${auditContextType(item.contextType)} · ${item.contextId}`;
        }
        if (item.delegationId) return `分身委托 · ${item.delegationId}`;
        return "-";
      };
      const auditActionSummary = (item) => {
        const allowed = String(item.metadata.allowedActions ?? "")
          .split(",")
          .filter(Boolean)
          .join("、");
        if (item.action === "employee.ticket.issued") {
          return `为执行对象签发运行票据${allowed ? `，授权：${allowed}` : ""}`;
        }
        if (item.action === "employee.runtime.updated") {
          return `保存 Runtime Profile，状态：${statusLabel(item.metadata.status)}`;
        }
        if (item.action === "employee.status_changed") {
          return `将员工状态变更为「${statusLabel(item.metadata.status)}」`;
        }
        if (item.action === "employee.role_assigned") {
          return `授予工作区角色：${item.metadata.role}`;
        }
        if (item.action === "employee.role_revoked") {
          return "撤销员工在该工作区的授权";
        }
        if (item.action === "read") return "请求读取工作流资料";
        if (item.action === "write") return "请求写入工作流交付物";
        if (item.action.startsWith("delegation.")) {
          return `${auditActionTitle(item)}${item.metadata.durationMinutes ? ` · ${item.metadata.durationMinutes} 分钟` : ""}`;
        }
        return auditActionTitle(item);
      };
      const auditMechanism = (item) => {
        if (item.action === "employee.ticket.issued") {
          return "工作流派发数字员工前，先签发限定范围和有效期的运行票据";
        }
        if (item.ticketId && item.decision === "denied") {
          return "数字员工运行完成后回写输出，运行票据校验未通过";
        }
        if (item.ticketId && item.decision === "allowed") {
          return "数字员工运行输出通过运行票据校验";
        }
        if (item.delegationId) return "分身委托上下文中的操作";
        return "-";
      };
      const auditReason = (item) => {
        if (item.decision === "allowed") return "";
        if (item.reason === "action is explicitly denied") {
          return `运行票据把「${item.action}」显式列入禁止动作；deny 优先于 allow`;
        }
        if (item.reason === "action is not authorized") {
          return `运行票据没有授权「${item.action}」`;
        }
        if (item.reason === "resource is outside the ticket scope") {
          return "目标资源超出运行票据的 resource scope";
        }
        if (item.reason === "employee is not active") {
          return "执行对象不是启用状态";
        }
        if (item.reason.includes("ticket")) {
          return "运行票据不存在、已失效或上下文不匹配";
        }
        return item.reason || "未提供原因";
      };
      const auditField = (label, value) =>
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "76px minmax(0, 1fr)",
              gap: 8,
            },
          },
          h("span", { style: { ...muted, flexShrink: 0 } }, label),
          h(
            "span",
            { style: { fontSize: 12, overflowWrap: "anywhere" } },
            value,
          ),
        );
      const auditCard = (item) => {
        const denied = item.decision === "denied";
        const actorKind =
          employeeById.get(item.actorEmployeeId)?.kind === "digital"
            ? "数字员工"
            : "真人员工";
        const actorRole =
          item.actorRole === "runtime"
            ? "Runtime 身份"
            : item.actorRole === "delegation"
              ? "分身身份"
              : item.actorRole === "admin"
                ? "全局管理员"
                : item.actorRole === "owner"
                  ? "负责人"
                  : item.actorRole;
        const subjectId = item.metadata.employeeId ?? item.actorEmployeeId;
        const technical = [
          `Employee：${item.metadata.employeeId ?? item.actorEmployeeId}`,
          item.workspaceId && `Workspace：${item.workspaceId}`,
          item.contextType && `Context：${item.contextType}/${item.contextId}`,
          item.delegationId && `Delegation：${item.delegationId}`,
          item.ticketId && `Ticket：${item.ticketId}`,
          item.runId && `Run：${item.runId}`,
        ].filter(Boolean);
        return h(
          "div",
          { key: item.id, style: card },
          h(
            "div",
            { style: row },
            h("strong", { style: { fontSize: 14 } }, auditActionTitle(item)),
            h(
              "span",
              {
                style: {
                  color: denied ? "#e26d6d" : "#4f8a5b",
                  fontWeight: 600,
                },
              },
              denied ? "拒绝" : "允许",
            ),
          ),
          h(
            "div",
            { style: { display: "grid", gap: 7 } },
            auditField("时间", localTime(item.at)),
            auditField(
              "操作人",
              `${auditEmployee(item.actorEmployeeId)}（${actorKind} · ${actorRole}）`,
            ),
            auditField("执行主体", auditEmployee(subjectId)),
            auditField("目标", auditTarget(item)),
            auditField("动作", auditActionSummary(item)),
            auditField("机制", auditMechanism(item)),
            auditField(
              "结果",
              denied ? `拒绝 · ${auditReason(item)}` : "允许 · 校验通过",
            ),
          ),
          h(
            "details",
            null,
            h("summary", { style: muted }, "技术标识"),
            h(
              "div",
              { style: { ...muted, display: "grid", gap: 3, marginTop: 5 } },
              technical.map((value) => h("div", { key: value }, value)),
            ),
          ),
        );
      };

      if (phase === "loading")
        return h(
          "div",
          { style: muted },
          auditOnly ? "加载审计…" : "加载员工平台…",
        );
      if (phase === "login")
        return h(
          "div",
          { style: muted },
          "请先在「账号与权限 → 登录账号」登录。",
        );

      const humans = employees.filter(
        (item) => item.kind === "human" && item.status !== "archived",
      );
      const directoryView = h(
        "div",
        { style: { display: "grid", gap: 16 } },
        (() => {
          const workspaceOptions = workspaces.map((workspace) =>
            h(
              "option",
              { key: workspace.id, value: workspace.id },
              `${workspaceLabel(workspace)}（${workspace.id}）`,
            ),
          );
          const activeTemplates = aiTemplates.filter(
            (template) => template.state === "active",
          );
          const createToolbar = h(
            "div",
            {
              style: {
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                justifyContent: "space-between",
              },
            },
            h(
              "div",
              { style: { display: "grid", gap: 3 } },
              h("strong", { style: { fontSize: 14 } }, "员工目录"),
              h(
                "span",
                { style: muted },
                `${employees.length} 名员工 · 人类 ${humans.length} · AI ${employees.filter((item) => item.kind === "digital").length}`,
              ),
            ),
            isAdmin
              ? h(
                  "div",
                  { style: row },
                  h(
                    "button",
                    {
                      type: "button",
                      style: ghost,
                      onClick: () => {
                        setCreateKind("human");
                        setCreateLogin(false);
                      },
                    },
                    "新增人类员工",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      style: primary,
                      onClick: () => setCreateKind("digital"),
                    },
                    "新增 AI 员工",
                  ),
                )
              : null,
          );
          const cancelCreate = h(
            "button",
            {
              type: "button",
              style: ghost,
              onClick: () => {
                setCreateKind("");
                setCreateLogin(false);
              },
            },
            "取消",
          );
          const createForm =
            createKind === "human"
              ? h(
                  "form",
                  {
                    style: { ...card, gap: 12 },
                    onSubmit: createHumanEmployee,
                  },
                  h(
                    "div",
                    { style: row },
                    h("strong", null, "新增人类员工"),
                    h("div", { style: { flex: 1 } }),
                    cancelCreate,
                  ),
                  h(
                    "div",
                    { style: grid2 },
                    h(
                      "label",
                      { style: field },
                      "Employee ID（可选）",
                      h("input", {
                        name: "employeeId",
                        style: input,
                        placeholder: "默认使用登录账号或自动生成",
                      }),
                    ),
                    h(
                      "label",
                      { style: field },
                      "姓名",
                      h("input", {
                        name: "displayName",
                        style: input,
                        required: true,
                      }),
                    ),
                    h(
                      "label",
                      { style: field },
                      "部门",
                      h("input", { name: "department", style: input }),
                    ),
                    h(
                      "label",
                      { style: field },
                      "岗位",
                      h("input", { name: "title", style: input }),
                    ),
                    h(
                      "label",
                      { style: field },
                      "邮箱",
                      h("input", {
                        name: "email",
                        type: "email",
                        style: input,
                      }),
                    ),
                    h(
                      "label",
                      { style: field },
                      "直属负责人",
                      h(
                        "select",
                        { name: "managerEmployeeId", style: input },
                        h("option", { value: "" }, "暂不指定"),
                        humans.map((employee) =>
                          h(
                            "option",
                            { key: employee.id, value: employee.id },
                            `${employee.displayName}（${employee.id}）`,
                          ),
                        ),
                      ),
                    ),
                  ),
                  h(
                    "label",
                    { style: field },
                    "标签（逗号分隔）",
                    h("input", { name: "tags", style: input }),
                  ),
                  h(
                    "label",
                    {
                      style: {
                        alignItems: "center",
                        display: "flex",
                        gap: 7,
                        fontSize: 12,
                      },
                    },
                    h("input", {
                      type: "checkbox",
                      checked: createLogin,
                      onChange: (event) => setCreateLogin(event.target.checked),
                    }),
                    "同时创建登录账号",
                  ),
                  createLogin
                    ? h(
                        "div",
                        { style: grid2 },
                        h(
                          "label",
                          { style: field },
                          "登录 ID",
                          h("input", {
                            name: "accountUserId",
                            style: input,
                            required: true,
                          }),
                        ),
                        h(
                          "label",
                          { style: field },
                          "初始密码",
                          h("input", {
                            name: "accountPassword",
                            type: "password",
                            minLength: 8,
                            style: input,
                            required: true,
                          }),
                        ),
                      )
                    : null,
                  h(
                    "div",
                    { style: row },
                    h(
                      "button",
                      { style: primary, disabled: saving },
                      saving ? "创建中…" : "创建人类员工",
                    ),
                  ),
                )
              : createKind === "digital"
                ? h(
                    "form",
                    { style: { ...card, gap: 12 }, onSubmit: createAiEmployee },
                    h(
                      "div",
                      { style: row },
                      h("strong", null, "新增 AI 员工"),
                      h("div", { style: { flex: 1 } }),
                      cancelCreate,
                    ),
                    h(
                      "div",
                      { style: muted },
                      "创建后会同时开通数字员工、Runtime Profile，并绑定到所选 AI 伙伴。",
                    ),
                    h(
                      "div",
                      { style: grid2 },
                      h(
                        "label",
                        { style: field },
                        "AI 伙伴模版",
                        h(
                          "select",
                          {
                            name: "templateId",
                            style: input,
                            required: true,
                            defaultValue: activeTemplates[0]?.id ?? "",
                          },
                          activeTemplates.length === 0
                            ? h("option", { value: "" }, "暂无可用模版")
                            : activeTemplates.map((template) =>
                                h(
                                  "option",
                                  { key: template.id, value: template.id },
                                  template.name,
                                ),
                              ),
                        ),
                      ),
                      h(
                        "label",
                        { style: field },
                        "首个工作区",
                        h(
                          "select",
                          {
                            name: "workspaceId",
                            style: input,
                            required: true,
                            defaultValue: workspaces[0]?.id ?? "",
                          },
                          workspaces.map((workspace) =>
                            h(
                              "option",
                              { key: workspace.id, value: workspace.id },
                              workspaceLabel(workspace),
                            ),
                          ),
                        ),
                      ),
                      h(
                        "label",
                        { style: field },
                        "Employee ID（可选）",
                        h("input", {
                          name: "employeeId",
                          style: input,
                          placeholder: "例如 ai-supply-planner",
                        }),
                      ),
                      h(
                        "label",
                        { style: field },
                        "姓名",
                        h("input", {
                          name: "displayName",
                          style: input,
                          required: true,
                        }),
                      ),
                      h(
                        "label",
                        { style: field },
                        "部门",
                        h("input", { name: "department", style: input }),
                      ),
                      h(
                        "label",
                        { style: field },
                        "岗位",
                        h("input", { name: "title", style: input }),
                      ),
                      h(
                        "label",
                        { style: field },
                        "直属负责人",
                        h(
                          "select",
                          {
                            name: "managerEmployeeId",
                            style: input,
                            required: true,
                            defaultValue: me?.id ?? "",
                          },
                          humans.map((employee) =>
                            h(
                              "option",
                              { key: employee.id, value: employee.id },
                              `${employee.displayName}（${employee.id}）`,
                            ),
                          ),
                        ),
                      ),
                      h(
                        "label",
                        { style: field },
                        "标签（逗号分隔）",
                        h("input", { name: "tags", style: input }),
                      ),
                    ),
                    h(
                      "div",
                      { style: row },
                      h(
                        "button",
                        {
                          style: primary,
                          disabled:
                            saving ||
                            activeTemplates.length === 0 ||
                            workspaces.length === 0 ||
                            humans.length === 0,
                        },
                        saving ? "创建中…" : "创建 AI 员工",
                      ),
                    ),
                  )
                : null;
          return [
            createToolbar,
            createForm,
            detail
              ? h(
                  "div",
                  { style: card },
                  h(
                    "div",
                    { style: row },
                    h("strong", null, detail.employee.displayName),
                    h(
                      "span",
                      { style: muted },
                      `${kindLabel(detail.employee.kind)} · ${statusLabel(detail.employee.status)}`,
                    ),
                    h(
                      "button",
                      { style: ghost, onClick: () => setDetail(null) },
                      "关闭",
                    ),
                  ),
                  h(
                    "div",
                    { style: muted },
                    `${detail.employee.title || "未设岗位"} · ${detail.employee.department || "未设部门"} · Employee ID：${detail.employee.id}`,
                  ),
                  h(
                    "div",
                    { style: muted },
                    detail.employee.kind === "human"
                      ? `登录账号：${detail.employee.authUserId} · ${loginStatusLabel(detail.employee.authStatus)}`
                      : `Persona：${detail.employee.personaId}${personas.some((persona) => persona.id === detail.employee.personaId) ? "" : " · 未找到 / 待配置"} · 负责人：${detail.employee.managerEmployeeId} · 无密码登录`,
                  ),
                  detail.employee.kind === "digital" && isAdmin
                    ? h(
                        "div",
                        { style: row },
                        statusButton(
                          detail.employee,
                          "active",
                          (status) => changeStatus(detail.employee.id, status),
                          saving,
                        ),
                        statusButton(
                          detail.employee,
                          "suspended",
                          (status) => changeStatus(detail.employee.id, status),
                          saving,
                        ),
                        statusButton(
                          detail.employee,
                          "archived",
                          (status) => changeStatus(detail.employee.id, status),
                          saving,
                        ),
                      )
                    : null,
                  detail.employee.kind === "digital" && isAdmin
                    ? h(
                        "details",
                        {
                          key: `edit-${formVersion}`,
                          open: openPanels.edit,
                          onToggle: panelToggle("edit"),
                        },
                        h("summary", { style: muted }, "编辑员工资料"),
                        h(
                          "form",
                          {
                            style: { ...card, marginTop: 8 },
                            onSubmit: updateEmployee,
                          },
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "姓名",
                              h("input", {
                                name: "displayName",
                                style: input,
                                defaultValue: detail.employee.displayName,
                                required: true,
                              }),
                            ),
                            h(
                              "label",
                              { style: field },
                              "邮箱",
                              h("input", {
                                name: "email",
                                type: "email",
                                style: input,
                                defaultValue: detail.employee.email ?? "",
                              }),
                            ),
                          ),
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "岗位",
                              h("input", {
                                name: "title",
                                style: input,
                                defaultValue: detail.employee.title,
                              }),
                            ),
                            h(
                              "label",
                              { style: field },
                              "部门",
                              h("input", {
                                name: "department",
                                style: input,
                                defaultValue: detail.employee.department,
                              }),
                            ),
                          ),
                          h(
                            "div",
                            { style: { ...grid2, alignItems: "start" } },
                            personaGuide({
                              personas,
                              refresh,
                              currentValue: detail.employee.personaId ?? "",
                            }),
                            h(
                              "label",
                              { style: field },
                              "负责人",
                              h(
                                "select",
                                {
                                  name: "managerEmployeeId",
                                  style: input,
                                  defaultValue:
                                    detail.employee.managerEmployeeId,
                                  required: true,
                                },
                                humans.map((item) =>
                                  h(
                                    "option",
                                    { key: item.id, value: item.id },
                                    `${item.displayName}（${item.id}）`,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          h(
                            "label",
                            { style: field },
                            "标签（逗号分隔）",
                            h("input", {
                              name: "tags",
                              style: input,
                              defaultValue: detail.employee.tags.join(", "),
                            }),
                          ),
                          h(
                            "button",
                            { style: primary, disabled: saving },
                            saving ? "保存中..." : "保存资料",
                          ),
                        ),
                      )
                    : null,
                  detail.employee.kind === "digital" && isAdmin
                    ? h(
                        "details",
                        {
                          key: `auth-${formVersion}`,
                          open: openPanels.auth,
                          onToggle: panelToggle("auth"),
                        },
                        h("summary", { style: muted }, "新增工作区授权"),
                        h(
                          "form",
                          {
                            style: { ...card, marginTop: 8 },
                            onSubmit: assignRole,
                          },
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "工作区",
                              h(
                                "select",
                                {
                                  name: "workspaceId",
                                  style: input,
                                  required: true,
                                },
                                workspaceOptions,
                              ),
                            ),
                            h(
                              "label",
                              { style: field },
                              "角色",
                              h(
                                "select",
                                {
                                  name: "role",
                                  style: input,
                                  defaultValue: "member",
                                },
                                ["viewer", "member", "owner"].map((role) =>
                                  h("option", { key: role, value: role }, role),
                                ),
                              ),
                            ),
                          ),
                          h(
                            "label",
                            { style: field },
                            "显式权限（逗号分隔）",
                            h("input", {
                              name: "permissions",
                              style: input,
                              defaultValue: "read, write",
                            }),
                          ),
                          h(
                            "label",
                            { style: field },
                            "有效期（分钟，留空长期）",
                            h("input", {
                              name: "durationMinutes",
                              type: "number",
                              min: 1,
                              style: input,
                            }),
                          ),
                          h(
                            "button",
                            { style: primary, disabled: saving },
                            saving ? "保存中..." : "保存授权",
                          ),
                        ),
                      )
                    : null,
                  detail.employee.kind === "digital" && isAdmin
                    ? h(
                        "details",
                        {
                          key: `runtime-${formVersion}`,
                          open: openPanels.runtime,
                          onToggle: panelToggle("runtime"),
                        },
                        h("summary", { style: muted }, "新增 Runtime Profile"),
                        h(
                          "div",
                          { style: { ...muted, marginTop: 4 } },
                          "决定该员工被工作流派发后如何运行：使用哪个模型与工具范围、预算上限，并通过映射的 Task Worker Profile 派发；未配置时不能被派发。",
                        ),
                        h(
                          "form",
                          {
                            style: { ...card, marginTop: 8 },
                            onSubmit: saveRuntime,
                          },
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "配置名",
                              h("input", {
                                name: "name",
                                style: input,
                                required: true,
                                placeholder: "task-worker",
                              }),
                            ),
                            h(
                              "label",
                              { style: field },
                              "工作区",
                              h(
                                "select",
                                {
                                  name: "workspaceId",
                                  style: input,
                                  required: true,
                                },
                                workspaceOptions,
                              ),
                            ),
                          ),
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "Provider",
                              h("input", {
                                name: "provider",
                                style: input,
                                defaultValue: "spawn",
                              }),
                              h(
                                "div",
                                { style: muted },
                                "运行方式：spawn 表示派发时启动一个子 Agent 会话执行任务。",
                              ),
                            ),
                            h(
                              "label",
                              { style: field },
                              "模型（留空默认）",
                              h("input", { name: "model", style: input }),
                            ),
                          ),
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "允许工具（逗号分隔）",
                              h("input", {
                                name: "allowedTools",
                                style: input,
                                placeholder: "默认为空",
                              }),
                            ),
                            h(
                              "label",
                              { style: field },
                              "禁止工具（逗号分隔）",
                              h("input", { name: "deniedTools", style: input }),
                            ),
                          ),
                          h(
                            "div",
                            { style: grid2 },
                            h(
                              "label",
                              { style: field },
                              "最大轮次",
                              h("input", {
                                name: "maxTurns",
                                type: "number",
                                min: 1,
                                style: input,
                                defaultValue: 50,
                              }),
                            ),
                            h(
                              "label",
                              { style: field },
                              "最大分钟",
                              h("input", {
                                name: "maxMinutes",
                                type: "number",
                                min: 1,
                                style: input,
                                defaultValue: 30,
                              }),
                            ),
                          ),
                          h(
                            "label",
                            { style: field },
                            "映射 Task Worker Profile（必填）",
                            h("input", {
                              name: "legacyAgentProfileId",
                              style: input,
                              required: true,
                              placeholder: "backend-agent",
                            }),
                          ),
                          h(
                            "button",
                            { style: primary, disabled: saving },
                            saving ? "保存中..." : "保存 Runtime",
                          ),
                        ),
                      )
                    : null,
                  detail.roles.map((item) =>
                    h(
                      "div",
                      { key: item.id, style: { ...card, padding: 8 } },
                      h(
                        "div",
                        { style: row },
                        h("strong", null, item.role),
                        h("span", { style: muted }, item.workspaceId),
                        item.status !== "active"
                          ? h(
                              "span",
                              { style: muted },
                              statusLabel(item.status),
                            )
                          : null,
                      ),
                      h(
                        "div",
                        { style: muted },
                        `权限：${item.permissions.join("、")} · 到期：${localTime(item.expiresAt)}`,
                      ),
                      item.status === "active" && isAdmin
                        ? h(
                            "button",
                            {
                              style: danger,
                              disabled: saving,
                              onClick: () => revokeRole(item.id),
                            },
                            "回收",
                          )
                        : null,
                    ),
                  ),
                  detail.runtimeProfiles.map((item) =>
                    h(
                      "div",
                      { key: item.id, style: { ...card, padding: 8 } },
                      h("strong", null, item.name),
                      h(
                        "div",
                        { style: muted },
                        `${item.workspaceId} · ${item.status === "active" ? "启用" : "停用"} · ${item.provider}/${item.model || "默认模型"}`,
                      ),
                      h(
                        "div",
                        { style: muted },
                        `工具：${item.allowedTools.join("、") || "无"} · 禁止：${item.deniedTools.join("、") || "无"}`,
                      ),
                      item.legacyAgentProfileId
                        ? h(
                            "div",
                            { style: muted },
                            `Task Worker 映射：${item.legacyAgentProfileId}`,
                          )
                        : h(
                            "div",
                            { style: muted, color: "#e26d6d" },
                            "缺少 Task Worker 映射；工作流不能派发。",
                          ),
                      h(
                        "div",
                        { style: muted },
                        `预算：${item.budget.maxTurns} 轮 / ${item.budget.maxMinutes} 分钟`,
                      ),
                    ),
                  ),
                  isAdmin && detail.audit.length > 0
                    ? h(
                        "div",
                        { style: { display: "grid", gap: 8 } },
                        h("strong", null, "审计"),
                        detail.audit
                          .slice(0, 20)
                          .map((item) =>
                            h(
                              "div",
                              { key: item.id, style: muted },
                              `${localTime(item.at)} · ${item.action} · ${item.decision === "allowed" ? "允许" : "拒绝"}${item.reason ? ` · ${item.reason}` : ""}`,
                            ),
                          ),
                      )
                    : null,
                )
              : null,
            h(
              "table",
              { style: table },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ["员工", "类型 / 登录", "岗位 / 部门", "状态", "操作"].map(
                    (title) => h("th", { key: title, style: cell }, title),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                employees.map((employee) =>
                  h(
                    "tr",
                    { key: employee.id },
                    h(
                      "td",
                      { style: cell },
                      h(
                        "strong",
                        null,
                        employee.displayName,
                        (employee.tags ?? []).some((tag) =>
                          tag.startsWith("ai-teammate:"),
                        )
                          ? h(
                              "span",
                              {
                                style: {
                                  marginLeft: 6,
                                  padding: "1px 6px",
                                  borderRadius: 999,
                                  border:
                                    "0.5px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 40%,transparent)",
                                  background:
                                    "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent)",
                                  color:
                                    "var(--dsw-alias-accent-primary,#4f8ef7)",
                                  fontSize: 10,
                                  fontWeight: 500,
                                },
                              },
                              "AI伙伴托管",
                            )
                          : null,
                      ),
                      h("div", { style: muted }, `Employee ID：${employee.id}`),
                    ),
                    h(
                      "td",
                      { style: cell },
                      kindLabel(employee.kind),
                      h(
                        "div",
                        { style: muted },
                        employee.kind === "human"
                          ? `登录：${employee.authUserId}`
                          : employee.personaId
                            ? `Persona：${employee.personaId}${
                                personas.some(
                                  (persona) =>
                                    persona.id === employee.personaId,
                                )
                                  ? ""
                                  : " · 未找到 / 待配置"
                              } · 无密码登录`
                            : "无密码登录",
                      ),
                    ),
                    h(
                      "td",
                      { style: cell },
                      employee.title || "-",
                      h("div", { style: muted }, employee.department || "-"),
                    ),
                    h(
                      "td",
                      { style: cell },
                      statusLabel(employee.status),
                      employee.kind === "human"
                        ? h(
                            "div",
                            {
                              style:
                                employee.authStatus === "disabled"
                                  ? { ...muted, color: "#e26d6d" }
                                  : muted,
                            },
                            loginStatusLabel(employee.authStatus),
                          )
                        : null,
                    ),
                    h(
                      "td",
                      { style: cell },
                      h(
                        "div",
                        { style: row },
                        h(
                          "button",
                          {
                            style: ghost,
                            onClick: () => loadDetail(employee.id),
                          },
                          "详情",
                        ),
                        employee.kind === "digital" && isAdmin
                          ? statusButton(
                              employee,
                              "active",
                              (status) => changeStatus(employee.id, status),
                              saving,
                            )
                          : null,
                        employee.kind === "digital" && isAdmin
                          ? statusButton(
                              employee,
                              "suspended",
                              (status) => changeStatus(employee.id, status),
                              saving,
                            )
                          : null,
                        employee.kind === "digital" && isAdmin
                          ? statusButton(
                              employee,
                              "archived",
                              (status) => changeStatus(employee.id, status),
                              saving,
                            )
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ];
        })(),
      );

      const digitalView = isAdmin
        ? h(
            "form",
            {
              style: card,
              onSubmit: submit(async (value) => {
                await request("/api/collab/employee/digital", {
                  method: "POST",
                  body: {
                    employeeId: value.employeeId || undefined,
                    displayName: value.displayName,
                    email: value.email || undefined,
                    department: value.department,
                    title: value.title,
                    personaId: value.personaId,
                    managerEmployeeId: value.managerEmployeeId,
                    tags: csv(value.tags),
                  },
                });
              }, "数字员工已创建为草稿。"),
            },
            h("strong", null, "创建数字员工"),
            h(
              "div",
              { style: muted },
              "数字员工是正式授权主体，但没有密码登录。Persona 只约束行为，不授予权限。",
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "Employee ID（可留空）",
                h("input", {
                  name: "employeeId",
                  style: input,
                  placeholder: "backend-engineer-01",
                }),
              ),
              h(
                "label",
                { style: field },
                "姓名",
                h("input", {
                  name: "displayName",
                  style: input,
                  required: true,
                }),
              ),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "岗位",
                h("input", { name: "title", style: input }),
              ),
              h(
                "label",
                { style: field },
                "部门",
                h("input", { name: "department", style: input }),
              ),
            ),
            h(
              "div",
              { style: { ...grid2, alignItems: "start" } },
              personaGuide({ personas, refresh }),
              h(
                "label",
                { style: field },
                "负责人",
                h(
                  "select",
                  {
                    name: "managerEmployeeId",
                    style: input,
                    required: true,
                  },
                  humans.map((item) =>
                    h(
                      "option",
                      { value: item.id },
                      `${item.displayName}（${item.id}）`,
                    ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "邮箱",
                h("input", { name: "email", type: "email", style: input }),
              ),
              h(
                "label",
                { style: field },
                "标签",
                h("input", { name: "tags", style: input }),
              ),
            ),
            h(
              "button",
              {
                style: primary,
                disabled: saving || personas.length === 0,
                title:
                  personas.length === 0 ? "请先创建一个 Persona" : undefined,
              },
              saving ? "创建中..." : "创建草稿",
            ),
          )
        : h("div", { style: muted }, "数字员工管理需要全局管理员权限。");

      const delegationView = h(
        "div",
        { style: { display: "grid", gap: 14 } },
        h(
          "div",
          { style: muted },
          "Human Avatar 是真人派出的受限代表，不进入员工目录。会议里新派遣的分身会自动创建委托单。",
        ),
        h(
          "details",
          {
            key: `delegation-${formVersion}`,
            open: openPanels.delegation,
            onToggle: panelToggle("delegation"),
          },
          h(
            "summary",
            {
              style: {
                alignItems: "center",
                background: "var(--dsw-alias-bg-layer-2)",
                border: "0.5px solid var(--dsw-alias-border-l2)",
                borderRadius: 6,
                cursor: "pointer",
                display: "flex",
                fontSize: 13,
                fontWeight: 600,
                gap: 8,
                justifyContent: "space-between",
                listStyle: "none",
                padding: "10px 14px",
              },
            },
            h(
              "span",
              { style: { display: "grid", gap: 2 } },
              "创建独立委托",
              h(
                "span",
                {
                  style: {
                    color: "var(--dsw-alias-label-secondary)",
                    fontSize: 11,
                    fontWeight: 400,
                  },
                },
                "为任务、会议或评审派出一个受限 Human Avatar",
              ),
            ),
            h(
              "span",
              {
                style: {
                  ...primary,
                  fontSize: 12,
                  padding: "4px 10px",
                  pointerEvents: "none",
                },
              },
              openPanels.delegation ? "收起 ▲" : "＋ 创建 ▼",
            ),
          ),
          h(
            "form",
            { style: { ...card, marginTop: 8 }, onSubmit: createDelegation },
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "分身名称（留空自动命名）",
                h("input", { name: "displayName", style: input }),
              ),
              h(
                "label",
                { style: field },
                "Persona ID（可选）",
                h("input", { name: "personaId", style: input }),
              ),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "工作区",
                h(
                  "select",
                  { name: "workspaceId", style: input, required: true },
                  workspaces.map((workspace) =>
                    h(
                      "option",
                      { key: workspace.id, value: workspace.id },
                      `${workspaceLabel(workspace)}（${workspace.id}）`,
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { style: field },
                "上下文类型",
                h(
                  "select",
                  { name: "contextType", style: input, defaultValue: "task" },
                  ["meeting", "task", "review"].map((value) =>
                    h("option", { key: value, value }, value),
                  ),
                ),
              ),
            ),
            h(
              "label",
              { style: field },
              "上下文 ID",
              h("input", {
                name: "contextId",
                style: input,
                required: true,
                placeholder: "例如任务或会议 ID",
              }),
            ),
            h(
              "label",
              { style: field },
              "任务目标",
              h("textarea", {
                name: "objective",
                style: textarea,
                required: true,
              }),
            ),
            h(
              "label",
              { style: field },
              "立场与指令",
              h("textarea", { name: "stance", style: textarea }),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "重点关注（每行或逗号一项）",
                h("textarea", { name: "watchItems", style: textarea }),
              ),
              h(
                "label",
                { style: field },
                "资料范围（逗号分隔）",
                h("textarea", { name: "materialScopes", style: textarea }),
              ),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "允许动作",
                checkboxGroup(
                  "allowedActions",
                  [
                    "meeting.read",
                    "meeting.speak",
                    "material.read",
                    "draft.report",
                  ],
                  ["meeting.read", "material.read", "draft.report"],
                ),
              ),
              h(
                "label",
                { style: field },
                "禁止动作",
                checkboxGroup(
                  "deniedActions",
                  ["meeting.speak", "approval.final", "employee.manage"],
                  ["approval.final", "employee.manage"],
                ),
              ),
            ),
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "发言策略",
                h(
                  "select",
                  { name: "speakPolicy", style: input, defaultValue: "manual" },
                  ["silent", "manual", "mentions", "all"].map((value) =>
                    h("option", { key: value, value }, value),
                  ),
                ),
              ),
              h(
                "label",
                { style: field },
                "审批策略",
                h(
                  "select",
                  {
                    name: "approvalPolicy",
                    style: input,
                    defaultValue: "never",
                  },
                  ["never", "suggest", "explicit-only"].map((value) =>
                    h("option", { key: value, value }, value),
                  ),
                ),
              ),
            ),
            h(
              "label",
              { style: field },
              "有效期（分钟，留空不限）",
              h("input", {
                name: "durationMinutes",
                type: "number",
                min: 1,
                style: input,
              }),
            ),
            h(
              "button",
              { style: primary, disabled: saving },
              saving ? "创建中..." : "创建委托",
            ),
          ),
        ),
        delegations.length === 0
          ? h("div", { style: muted }, "暂无委托单。")
          : delegations.map((item) => {
              const report = reports.find(
                (candidate) => candidate.delegationId === item.id,
              );
              return h(
                "div",
                { key: item.id, style: card },
                h(
                  "div",
                  { style: row },
                  h("strong", null, item.displayName),
                  h(
                    "span",
                    { style: muted },
                    `${statusLabel(item.status)} · 主人：${item.ownerName}`,
                  ),
                ),
                h(
                  "div",
                  {
                    style:
                      item.teammateName === undefined
                        ? muted
                        : {
                            ...muted,
                            color: "var(--dsw-alias-accent-primary,#4f8ef7)",
                          },
                  },
                  item.teammateName === undefined
                    ? "来源：未关联 AI伙伴"
                    : `来自：${item.teammateName}`,
                ),
                h("div", { style: muted }, `目标：${item.objective}`),
                h(
                  "div",
                  { style: muted },
                  `授权：${item.allowedActions.join("、") || "无"} · 禁止：${item.deniedActions.join("、") || "无"}`,
                ),
                h(
                  "div",
                  { style: muted },
                  `发言：${item.speakPolicy} · 审批：${item.approvalPolicy} · 到期：${localTime(item.expiresAt)}`,
                ),
                item.status === "active"
                  ? h(
                      "div",
                      { style: row },
                      h(
                        "button",
                        {
                          style: ghost,
                          onClick: () => extendDelegation(item.id),
                        },
                        "延期",
                      ),
                      h(
                        "button",
                        {
                          style: ghost,
                          onClick: () => delegationStatus(item.id, "paused"),
                        },
                        "暂停",
                      ),
                      h(
                        "button",
                        {
                          style: danger,
                          onClick: () => delegationStatus(item.id, "revoked"),
                        },
                        "召回",
                      ),
                    )
                  : item.status === "paused"
                    ? h(
                        "div",
                        { style: row },
                        h(
                          "button",
                          {
                            style: ghost,
                            onClick: () => extendDelegation(item.id),
                          },
                          "延期",
                        ),
                        h(
                          "button",
                          {
                            style: ghost,
                            onClick: () => delegationStatus(item.id, "active"),
                          },
                          "恢复",
                        ),
                        h(
                          "button",
                          {
                            style: danger,
                            onClick: () => delegationStatus(item.id, "revoked"),
                          },
                          "召回",
                        ),
                      )
                    : null,
                report
                  ? h(
                      "details",
                      null,
                      h(
                        "summary",
                        { style: muted },
                        `分身报告 · ${statusLabel(report.status)} · ${localTime(report.createdAt)}`,
                      ),
                      h(
                        "pre",
                        {
                          style: {
                            ...muted,
                            whiteSpace: "pre-wrap",
                            margin: "8px 0 0",
                          },
                        },
                        report.status === "failed"
                          ? report.error
                          : report.report,
                      ),
                    )
                  : null,
              );
            }),
      );

      const employeeNameById = new Map(
        (governance?.employees ?? employees).map((item) => [item.id, item]),
      );
      const displayName = (id, fallback = id) =>
        employeeNameById.get(id)?.displayName ?? fallback;
      const workspaceName = (id) => {
        const workspace = workspaces.find((item) => item.id === id);
        return (
          workspace?.title?.trim() || workspace?.path || id || "全部工作区"
        );
      };
      const inTimeRange = (value) => {
        if (!value) return true;
        const time = new Date(value).getTime();
        if (Number.isNaN(time)) return true;
        if (govFrom && time < new Date(`${govFrom}T00:00:00`).getTime())
          return false;
        if (govTo && time > new Date(`${govTo}T23:59:59.999`).getTime())
          return false;
        return true;
      };
      const matchesSearch = (values) => {
        const needle = govSearch.trim().toLowerCase();
        return (
          needle === "" ||
          values.filter(Boolean).join(" ").toLowerCase().includes(needle)
        );
      };
      const govEmployees = governance?.employees ?? [];
      const govRoles = governance?.roles ?? [];
      const govProfiles = governance?.profiles ?? [];
      const govTickets = governance?.tickets ?? [];
      const govDelegations = governance?.delegations ?? [];
      const govReports = (governance?.reports ?? []).filter((report) =>
        matchesSearch([
          report.report,
          report.error,
          report.status,
          statusLabel(report.status),
          report.delegationId,
        ]),
      );
      const govAudit = (governance?.audit ?? []).filter(
        (item) =>
          inTimeRange(item.at) &&
          matchesSearch([
            item.action,
            item.reason,
            item.contextId,
            item.actorEmployeeId,
            item.actorAuthUserId,
            item.ticketId,
            item.decision === "allowed" ? "允许" : "拒绝",
          ]),
      );
      const govRuns = agentRuns.filter(
        (run) =>
          inTimeRange(run.createdAt) &&
          matchesSearch([
            run.payload.employeeName,
            run.payload.profileName,
            run.payload.instanceTitle,
            run.payload.nodeName,
            run.error,
            run.status,
            runStatusLabel(run.status),
            run.employeeId,
            run.profileId,
            run.principalType === "digital-employee"
              ? "数字员工"
              : "Task Worker",
          ]),
      );
      const riskItems = [
        ...govAudit
          .filter((item) => item.decision === "denied")
          .map((item) => ({
            key: `audit-${item.id}`,
            title: "越权或拒绝",
            detail: `${displayName(item.actorEmployeeId)} · ${item.action}${item.reason ? ` · ${item.reason}` : ""}`,
            time: item.at,
          })),
        ...govRuns
          .filter((run) =>
            ["failed", "timeout", "interrupted"].includes(run.status),
          )
          .map((run) => ({
            key: `run-${run.id}`,
            title: "运行异常",
            detail: `${run.payload.employeeName ?? run.payload.profileName} · ${run.payload.instanceTitle} · ${run.error ?? run.status}`,
            time: run.updatedAt,
          })),
        ...govReports
          .filter((report) => report.status === "failed")
          .map((report) => ({
            key: `report-${report.id}`,
            title: "分身报告失败",
            detail: report.error ?? "报告生成失败",
            time: report.createdAt,
          })),
        ...govProfiles
          .filter((profile) => !profile.legacyAgentProfileId)
          .map((profile) => ({
            key: `profile-${profile.id}`,
            title: "运行配置不完整",
            detail: `${displayName(profile.employeeId)}缺少 Task Worker 映射`,
            time: profile.updatedAt,
          })),
        ...govEmployees
          .filter((employee) =>
            ["suspended", "archived"].includes(employee.status),
          )
          .map((employee) => ({
            key: `employee-${employee.id}`,
            title: "员工受限",
            detail: `${employee.displayName} · ${statusLabel(employee.status)}`,
            time: employee.updatedAt,
          })),
        ...govTickets
          .filter(
            (ticket) =>
              ticket.status !== "active" ||
              (ticket.expiresAt && new Date(ticket.expiresAt) <= new Date()),
          )
          .map((ticket) => ({
            key: `ticket-${ticket.id}`,
            title: "运行票据失效",
            detail: `${displayName(ticket.principal.employeeId)} · ${ticket.status}`,
            time: ticket.expiresAt ?? ticket.createdAt,
          })),
      ].sort((left, right) => right.time.localeCompare(left.time));
      const activity = [
        ...govAudit.map((item) => ({
          key: `audit-${item.id}`,
          time: item.at,
          actor: displayName(item.actorEmployeeId),
          action: item.action,
          status: item.decision === "allowed" ? "允许" : "拒绝",
          source: `权限票据：${item.ticketId || "无"}`,
        })),
        ...govRuns.map((run) => ({
          key: `run-${run.id}`,
          time: run.updatedAt,
          actor: run.payload.employeeName ?? run.payload.profileName,
          action: `${run.payload.instanceTitle} · ${run.payload.nodeName}`,
          status: runStatusLabel(run.status),
          source: run.ticketId
            ? `运行票据：${run.ticketId}`
            : "过渡 Task Worker",
        })),
      ]
        .filter((item) => inTimeRange(item.time))
        .sort((left, right) => right.time.localeCompare(left.time));
      const metric = (label, value) =>
        h(
          "div",
          { key: label, style: card },
          h("div", { style: muted }, label),
          h("strong", { style: { fontSize: 20 } }, String(value)),
        );
      const governanceView = isAdmin
        ? h(
            "div",
            { style: { display: "grid", gap: 16 } },
            h(
              "div",
              { style: grid2 },
              h(
                "label",
                { style: field },
                "工作区",
                h(
                  "select",
                  {
                    style: input,
                    value: govWorkspace,
                    onChange: (event) => setGovWorkspace(event.target.value),
                  },
                  h("option", { value: "all" }, "全部工作区"),
                  workspaces.map((workspace) =>
                    h(
                      "option",
                      { key: workspace.id, value: workspace.id },
                      workspace.title?.trim() || workspace.path,
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { style: field },
                "员工",
                h(
                  "select",
                  {
                    style: input,
                    value: govEmployee,
                    onChange: (event) => setGovEmployee(event.target.value),
                  },
                  h("option", { value: "all" }, "全部员工"),
                  employees.map((employee) =>
                    h(
                      "option",
                      { key: employee.id, value: employee.id },
                      employee.displayName,
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { style: field },
                "开始日期",
                h("input", {
                  type: "date",
                  style: input,
                  value: govFrom,
                  onChange: (event) => setGovFrom(event.target.value),
                }),
              ),
              h(
                "label",
                { style: field },
                "结束日期",
                h("input", {
                  type: "date",
                  style: input,
                  value: govTo,
                  onChange: (event) => setGovTo(event.target.value),
                }),
              ),
            ),
            h(
              "label",
              { style: field },
              "搜索操作、报告、异常或上下文",
              h("input", {
                style: input,
                value: govSearch,
                onChange: (event) => setGovSearch(event.target.value),
                placeholder: "例如：审批、失败、报告标题",
              }),
            ),
            h(
              "div",
              { style: grid2 },
              metric("员工", govEmployees.length),
              metric("授权记录", govRoles.length),
              metric("运行票据", govTickets.length),
              metric("分身委托", govDelegations.length),
            ),
            h(
              "div",
              { style: card },
              h("strong", null, `风险与异常（${riskItems.length}）`),
              h(
                "div",
                { style: { display: "grid", gap: 8, marginTop: 10 } },
                riskItems.length === 0
                  ? h("div", { style: muted }, "当前过滤范围内没有风险项。")
                  : riskItems
                      .slice(0, 30)
                      .map((item) =>
                        h(
                          "div",
                          { key: item.key },
                          h(
                            "div",
                            { style: row },
                            h("strong", null, item.title),
                            h("span", { style: muted }, localTime(item.time)),
                          ),
                          h("div", { style: muted }, item.detail),
                        ),
                      ),
              ),
            ),
            h(
              "div",
              { style: card },
              h("strong", null, `员工活动时间线（${activity.length}）`),
              h(
                "div",
                { style: { display: "grid", gap: 10, marginTop: 10 } },
                activity.length === 0
                  ? h("div", { style: muted }, "暂无活动。")
                  : activity
                      .slice(0, 80)
                      .map((item) =>
                        h(
                          "div",
                          { key: item.key },
                          h(
                            "div",
                            { style: row },
                            h("strong", null, item.actor),
                            h("span", { style: muted }, localTime(item.time)),
                          ),
                          h(
                            "div",
                            { style: muted },
                            `${item.action} · ${item.status}`,
                          ),
                          h("div", { style: muted }, item.source),
                        ),
                      ),
              ),
            ),
            h(
              "div",
              { style: card },
              h("strong", null, "权限矩阵与运行配置"),
              h(
                "div",
                { style: { display: "grid", gap: 8, marginTop: 10 } },
                govRoles.length === 0
                  ? h("div", { style: muted }, "暂无显式授权。")
                  : govRoles.map((role) =>
                      h(
                        "div",
                        { key: role.id },
                        h(
                          "strong",
                          null,
                          `${displayName(role.employeeId)} · ${role.role}`,
                        ),
                        h(
                          "div",
                          { style: muted },
                          `${workspaceName(role.workspaceId)} · ${role.permissions.join("、")} · 到期：${localTime(role.expiresAt)}`,
                        ),
                      ),
                    ),
                govProfiles.map((profile) =>
                  h(
                    "div",
                    { key: profile.id },
                    h(
                      "strong",
                      null,
                      `${displayName(profile.employeeId)} · ${profile.name}`,
                    ),
                    h(
                      "div",
                      { style: muted },
                      `预算 ${profile.budget.maxTurns} 轮 / ${profile.budget.maxMinutes} 分钟 · 映射 ${profile.legacyAgentProfileId || "未配置"}`,
                    ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { style: card },
              h("strong", null, `分身报告中心（${govReports.length}）`),
              h(
                "div",
                { style: { display: "grid", gap: 10, marginTop: 10 } },
                govReports.length === 0
                  ? h("div", { style: muted }, "暂无报告。")
                  : govReports.map((report) =>
                      h(
                        "details",
                        { key: report.id },
                        h(
                          "summary",
                          { style: muted },
                          `${localTime(report.createdAt)} · ${statusLabel(report.status)}`,
                        ),
                        h(
                          "pre",
                          { style: { ...muted, whiteSpace: "pre-wrap" } },
                          report.status === "failed"
                            ? report.error
                            : report.report,
                        ),
                      ),
                    ),
              ),
            ),
          )
        : h("div", { style: muted }, "治理中心需要全局管理员权限。");

      const auditView = isAdmin
        ? h(
            "div",
            { style: { display: "grid", gap: 10 } },
            audit.length === 0
              ? h("div", { style: muted }, "暂无审计。")
              : audit.map((item) => auditCard(item)),
          )
        : h("div", { style: muted }, "审计需要全局管理员权限。");

      if (auditOnly) {
        return h(
          "div",
          { style: panel },
          h(
            "div",
            { style: row },
            h("strong", { style: { fontSize: 15 } }, "审计"),
            h(
              "button",
              { style: ghost, onClick: () => setReload((value) => value + 1) },
              "刷新",
            ),
          ),
          me
            ? h(
                "div",
                { style: muted },
                `当前身份：${me.displayName} · ${kindLabel(me.kind)} · Employee ID：${me.id}${isAdmin ? " · 全局管理员" : ""}`,
              )
            : null,
          error
            ? h("div", { style: { ...muted, color: "#e26d6d" } }, error)
            : null,
          auditView,
        );
      }

      // 数字员工 / 分身委托 / 治理中心 已下线，实现暂时保留，
      // 待后续「新建员工 / 调整汇报关系」复用。
      void digitalView;
      void delegationView;
      void governanceView;
      void setGovernance;
      void setAgentRuns;

      return h(
        "div",
        { style: panel },
        h(
          "div",
          { style: row },
          h("strong", { style: { fontSize: 15 } }, "员工平台"),
          h("div", { style: { flex: 1 } }),
          h(
            "button",
            { style: ghost, onClick: () => setReload((value) => value + 1) },
            "刷新",
          ),
        ),
        h(
          "div",
          {
            style: {
              marginTop: 10,
              color: "var(--dsw-alias-label-tertiary)",
              fontSize: 11.5,
              lineHeight: 1.6,
            },
          },
          "数字员工与分身委托已统一到左侧「AI伙伴」管理。",
        ),
        me
          ? h(
              "div",
              { style: muted },
              `当前身份：${me.displayName} · ${kindLabel(me.kind)} · Employee ID：${me.id}${isAdmin ? " · 全局管理员" : ""}`,
            )
          : null,
        error
          ? h("div", { style: { ...muted, color: "#e26d6d" } }, error)
          : null,
        notice
          ? h("div", { style: { ...muted, color: "#4fc487" } }, notice)
          : null,
        directoryView,
      );
    }

    function WorkstationGlobalPage(props) {
      const { useShellRoute, ...tabProps } = props;
      const route = useShellRoute?.((state) => state.route);
      if (route !== "workbench") return null;
      return h(WorkstationTab, tabProps);
    }

    /**
     * 「工作台」全局路由已由 dsh-collab-workbench 插件承接
     * （工作台与管理驾驶舱 PRD）。员工平台页（WorkstationTab）的实现与接口
     * 全部保留，仅不再注册到 pluginmax.global，避免与工作台页面叠加渲染；
     * 待后续「新建员工 / 调整汇报关系」复用时可重新接入。
     */
    function registerWorkstationGlobalPage(ctx) {
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          {
            name: "pluginmax.global",
            id: "pluginmax-workstation",
            order: 34,
          },
          WorkstationGlobalPage,
        ),
      );
    }
    void registerWorkstationGlobalPage;

    exports.inject = ["slots"];
    exports.apply = () => {
      // Employee 产品写入口与页面已冻结；账号审计由身份主路径提供。
    };

    return module.exports;
  },
});
