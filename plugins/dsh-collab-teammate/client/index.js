window.__ModuleLoader__.load({
  id: "dsh-collab-teammate",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;

    const TOKEN_KEY = "pluginmax.collab.token";
    const ACCENT = "var(--dsw-alias-accent-primary,#4f8ef7)";

    /*
     * 「仅看已加入 / 平台全量」是跨模块偏好：任务、会议、工作流、AI伙伴
     * 与工作台共用同一个 window store，点击跨模块跳转时沿用用户当前选择。
     * 这里幂等创建，谁先加载谁初始化。
     */
    function ensureScopeStore() {
      if (window.__pluginmaxScope) return window.__pluginmaxScope;
      let all = false;
      const listeners = new Set();
      window.__pluginmaxScope = {
        getSnapshot: () => all,
        setAll: (next) => {
          const value = next === true;
          if (value === all) return;
          all = value;
          for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      return window.__pluginmaxScope;
    }
    const scopeStore = ensureScopeStore();

    const STATE_LABEL = {
      draft: "草稿",
      active: "已生效",
      disabled: "已停用",
      paused: "已暂停",
      inactive: "已失效",
      archived: "已归档",
    };
    const ROLE_PLACEHOLDER = "角色待定";
    /** 任务优先级平移：存储 P1–P3，产品口径显示 P0–P2。 */
    const PRIORITY_DISPLAY = { P1: "P0", P2: "P1", P3: "P2" };
    const priorityLabel = (value) => PRIORITY_DISPLAY[value] ?? value;
    const STATUS_LABEL = {
      todo: "待处理",
      progress: "进行中",
      review: "待验收",
      done: "已完成",
    };
    const AUDIT_ACTOR_LABEL = {
      user: "人工操作",
      "ai-teammate": "AI伙伴",
      system: "系统",
    };
    /*
     * 外部 Agent 运行时三态。归档沿用 AI伙伴模版口径：默认列表隐藏、
     * 归档视图单独查看、归档项只能复原回停用，不直接生效。
     */
    const EXTERNAL_RUNTIME_STATUS = {
      active: { label: "启用中", tone: "active" },
      disabled: { label: "已停用", tone: "disabled" },
      archived: { label: "已归档", tone: "archived" },
    };
    const externalRuntimeStatusLabel = (status) =>
      EXTERNAL_RUNTIME_STATUS[status]?.label ?? status;
    const externalRuntimeStatusTone = (status) =>
      EXTERNAL_RUNTIME_STATUS[status]?.tone ?? "unknown";
    const EXTERNAL_RUNTIME_PROVIDER_LABEL = {
      codex: "Codex",
      workbuddy: "WorkBuddy",
      command: "通用命令",
    };
    const EXTERNAL_RUNTIME_PROTOCOL_LABEL = {
      "codex-jsonl": "Codex JSONL",
      "plain-text": "stdio 文本",
    };
    const EXTERNAL_RUNTIME_TOOLS = [
      { value: "web_search", label: "网页搜索" },
      { value: "web_fetch", label: "网页抓取" },
      { value: "read_file", label: "读取文件" },
      { value: "write_file", label: "写入文件" },
      { value: "run_command", label: "执行命令" },
      { value: "browser", label: "浏览器" },
      { value: "mcp", label: "MCP" },
    ];
    const EXTERNAL_RUNTIME_TOOL_LABEL = Object.fromEntries(
      EXTERNAL_RUNTIME_TOOLS.map((item) => [item.value, item.label]),
    );
    const EXTERNAL_MODEL_SUGGESTIONS = {
      codex: [
        "gpt-5.2-codex",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex",
        "gpt-5-codex",
        "gpt-5.1",
        "gpt-5",
        "o3",
      ],
      workbuddy: [
        "hy4-preview",
        "hy3",
        "hy3-x",
        "deepseek-v4-pro",
        "deepseek-v4.1-flash",
        "glm-5.3",
        "kimi-k3-1",
        "minimax-m3",
        "step-5-preview",
      ],
      command: ["deepseek-chat", "deepseek-reasoner"],
    };
    const externalRuntimeProviderLabel = (provider) =>
      EXTERNAL_RUNTIME_PROVIDER_LABEL[provider] ?? provider;
    const externalRuntimeProtocolLabel = (protocol) =>
      EXTERNAL_RUNTIME_PROTOCOL_LABEL[protocol] ?? protocol;
    const EXTERNAL_PERMISSION_MODE_LABEL = {
      default: "默认权限",
      plan: "计划模式",
      acceptEdits: "自动接受文件修改",
    };
    const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
    const formatContextWindowTokens = (value) => {
      const tokens = Number(value);
      if (!Number.isFinite(tokens) || tokens <= 0) return "未设置";
      if (tokens >= 1_000_000) {
        return `${Number((tokens / 1_000_000).toFixed(1))}M`;
      }
      if (tokens >= 1_000) {
        return `${Number((tokens / 1_000).toFixed(1))}K`;
      }
      return String(tokens);
    };
    const EXTERNAL_SHELL_OPERATORS = new Set(["|", "&", ";", "<", ">"]);
    let externalArgRowSequence = 0;
    const externalArgRow = (input = {}) => ({
      id: `external-arg-${++externalArgRowSequence}`,
      kind: input.kind ?? "flag",
      name: input.name ?? "",
      value: input.value ?? "",
    });
    const quoteExternalArg = (value) => {
      const token = String(value);
      if (token === "") return '""';
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)
        ? token
        : `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    };
    const formatExternalArgsText = (args) =>
      (Array.isArray(args) ? args : []).map(quoteExternalArg).join(" ");
    const parseExternalArgsText = (value) => {
      const text = String(value ?? "");
      const args = [];
      let current = "";
      let quote = "";
      let escaped = false;
      let tokenStarted = false;
      const pushToken = () => {
        if (!tokenStarted) return;
        args.push(current);
        current = "";
        tokenStarted = false;
      };
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\0") {
          return { args: [], error: "额外参数不能包含空字符。" };
        }
        if (escaped) {
          current += char;
          tokenStarted = true;
          escaped = false;
          continue;
        }
        if (quote === "'") {
          if (char === "'") quote = "";
          else current += char;
          continue;
        }
        if (quote === '"') {
          if (char === '"') quote = "";
          else if (char === "\\") escaped = true;
          else current += char;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          tokenStarted = true;
          continue;
        }
        if (char === "'" || char === '"') {
          quote = char;
          tokenStarted = true;
          continue;
        }
        if (/\s/.test(char)) {
          pushToken();
          continue;
        }
        if (EXTERNAL_SHELL_OPERATORS.has(char)) {
          return {
            args: [],
            error: `不支持 shell 操作符 ${char}；这里只接受 argv 参数。`,
          };
        }
        if (char === "`" || (char === "$" && text[index + 1] === "(")) {
          return {
            args: [],
            error: "不支持命令替换；这里只接受 argv 参数。",
          };
        }
        current += char;
        tokenStarted = true;
      }
      if (escaped) {
        return { args: [], error: "额外参数末尾存在未完成的转义。" };
      }
      if (quote !== "") {
        return { args: [], error: "额外参数中的引号未闭合。" };
      }
      pushToken();
      return { args, error: "" };
    };
    const externalAdvancedArgs = (form) => {
      if (typeof form.customArgsText === "string") {
        const parsed = parseExternalArgsText(form.customArgsText);
        return parsed.error === "" ? parsed.args : [];
      }
      if (Array.isArray(form.customArgs)) return form.customArgs;
      const args = [];
      for (const row of form.advancedArgs ?? []) {
        const name = String(row.name ?? "").trim();
        const value = String(row.value ?? "").trim();
        if (row.kind === "flag" && name !== "") args.push(name);
        if (row.kind === "keyValue" && name !== "" && value !== "") {
          args.push(name, value);
        }
        if (row.kind === "positional" && value !== "") args.push(value);
      }
      return args;
    };
    const advancedArgsFromRows = (rows) => {
      const args = [];
      for (const row of rows ?? []) {
        if (row.kind === "flag" && row.name !== "") args.push(row.name);
        if (row.kind === "keyValue" && row.name !== "" && row.value !== "") {
          args.push(row.name, row.value);
        }
        if (row.kind === "positional" && row.value !== "") args.push(row.value);
      }
      return args;
    };
    const parseExternalRuntimeArgs = (provider, argsValue) => {
      const args = Array.isArray(argsValue)
        ? argsValue.filter((item) => typeof item === "string")
        : [];
      let model = "";
      let searchEnabled = false;
      let permissionMode = "default";
      let maxTurns = "";
      let ignoredOutputFormat = false;
      const advancedArgs = [];
      const isValue = (value) =>
        value !== undefined && (!value.startsWith("-") || value === "-");
      for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--search") {
          searchEnabled = true;
          continue;
        }
        if (token === "--model" && isValue(args[index + 1])) {
          model = args[index + 1];
          index += 1;
          continue;
        }
        if (
          provider === "workbuddy" &&
          token === "--max-turns" &&
          /^\d+$/.test(args[index + 1] ?? "")
        ) {
          maxTurns = args[index + 1];
          index += 1;
          continue;
        }
        if (
          provider === "workbuddy" &&
          token === "--permission-mode" &&
          Object.hasOwn(EXTERNAL_PERMISSION_MODE_LABEL, args[index + 1] ?? "")
        ) {
          permissionMode = args[index + 1];
          index += 1;
          continue;
        }
        if (
          provider === "workbuddy" &&
          token === "--output-format" &&
          isValue(args[index + 1])
        ) {
          ignoredOutputFormat = true;
          index += 1;
          continue;
        }
        if (
          provider === "workbuddy" &&
          (token === "--print" || token === "-p")
        ) {
          continue;
        }
        if (token.startsWith("-")) {
          if (isValue(args[index + 1])) {
            advancedArgs.push(
              externalArgRow({
                kind: "keyValue",
                name: token,
                value: args[index + 1],
              }),
            );
            index += 1;
          } else {
            advancedArgs.push(externalArgRow({ kind: "flag", name: token }));
          }
          continue;
        }
        advancedArgs.push(externalArgRow({ kind: "positional", value: token }));
      }
      return {
        modelMode: model === "" ? "default" : "custom",
        model,
        searchEnabled,
        permissionMode,
        maxTurns,
        advancedArgs,
        ignoredOutputFormat,
      };
    };
    const compileExternalRuntimeArgs = (form) => {
      const customArgsInvalid =
        typeof form.customArgsText === "string" &&
        externalAdvancedArgError(form) !== "";
      const args = customArgsInvalid ? [] : [...externalAdvancedArgs(form)];
      // Keep an executable/script positional argument in the first position.
      // Structured flags are appended so wrappers such as `node script.mjs`
      // continue to receive their own options after the script path.
      const model = String(form.model ?? "").trim();
      const defaultModel =
        String(form.defaultModel ?? "").trim() ||
        (form.modelMode === "custom" ? model : "");
      if (defaultModel !== "") args.push("--model", defaultModel);
      if (
        form.provider === "codex" &&
        ((Array.isArray(form.supportedTools) &&
          form.supportedTools.includes("web_search")) ||
          form.searchEnabled === true)
      ) {
        args.push("--search");
      }
      if (form.provider === "workbuddy") {
        if (
          form.permissionMode !== undefined &&
          form.permissionMode !== "default"
        ) {
          args.push("--permission-mode", form.permissionMode);
        }
        const maxTurns = String(form.maxTurns ?? "").trim();
        if (maxTurns !== "") args.push("--max-turns", maxTurns);
      }
      return args;
    };
    const externalAdvancedArgError = (form) => {
      const parsed = parseExternalArgsText(form.customArgsText ?? "");
      if (parsed.error !== "") return parsed.error;
      for (let index = 0; index < parsed.args.length; index += 1) {
        const token = parsed.args[index];
        if (
          token === "--model" ||
          token === "-m" ||
          token.startsWith("--model=")
        ) {
          return "模型请在任务执行时从 Runtime 模型池选择，不要在额外参数中固定。";
        }
        if (token === "--effort" || token.startsWith("--effort=")) {
          return "推理强度请在任务执行时选择，不要在额外参数中固定。";
        }
        if (token === "--search") {
          return "搜索能力请在上方“网页搜索”工具中声明。";
        }
        if (form.provider === "workbuddy") {
          if (
            [
              "--permission-mode",
              "--max-turns",
              "--print",
              "-p",
              "--output-format",
            ].includes(token) ||
            token.startsWith("--permission-mode=") ||
            token.startsWith("--max-turns=") ||
            token.startsWith("--output-format=")
          ) {
            return `参数 ${token.split("=")[0]} 由平台托管，无需填写。`;
          }
        }
        if (form.provider === "codex") {
          if (
            [
              "exec",
              "--json",
              "--cd",
              "--sandbox",
              "--output-last-message",
            ].includes(token) ||
            token === "-" ||
            token.startsWith("--sandbox=")
          ) {
            return `参数 ${token.split("=")[0]} 由平台托管，无需填写。`;
          }
          if (
            (token === "-c" || token === "--config") &&
            String(parsed.args[index + 1] ?? "").startsWith(
              "model_reasoning_effort=",
            )
          ) {
            return "推理强度请在任务执行时选择，不要在额外参数中固定。";
          }
          if (
            token.startsWith("-c=model_reasoning_effort=") ||
            token.startsWith("--config=model_reasoning_effort=")
          ) {
            return "推理强度请在任务执行时选择，不要在额外参数中固定。";
          }
        }
      }
      return "";
    };
    const externalRuntimeFormError = (form) => {
      if (
        form.protocol !== undefined &&
        ((form.provider === "codex" && form.protocol !== "codex-jsonl") ||
          (form.provider !== "codex" && form.protocol !== "plain-text"))
      ) {
        return "当前 Provider 与协议不匹配，请重新选择 Provider。";
      }
      const supportedModels = Array.isArray(form.supportedModels)
        ? form.supportedModels
        : [];
      const defaultModel = String(form.defaultModel ?? "").trim();
      if (defaultModel !== "" && !supportedModels.includes(defaultModel)) {
        return "默认模型必须来自模型池。";
      }
      if (
        form.provider === "workbuddy" &&
        String(form.maxTurns ?? "").trim() !== "" &&
        (!/^\d+$/.test(String(form.maxTurns).trim()) ||
          Number(form.maxTurns) < 1 ||
          Number(form.maxTurns) > 100)
      ) {
        return "最大回合必须是 1 到 100 之间的整数。";
      }
      const contextWindowTokens = String(form.contextWindowTokens ?? "").trim();
      if (
        contextWindowTokens !== "" &&
        (!/^\d+$/.test(contextWindowTokens) ||
          Number(contextWindowTokens) < 1_000 ||
          Number(contextWindowTokens) > 10_000_000)
      ) {
        return "最大上下文窗口必须是 1,000 到 10,000,000 之间的整数 token。";
      }
      const advancedError = externalAdvancedArgError(form);
      if (advancedError !== "") return advancedError;
      return "";
    };
    const externalPlatformArgs = (form) => {
      if (form.provider === "codex") {
        return [
          "exec",
          "--json",
          "--cd",
          "<workspace>",
          "--sandbox",
          "read-only",
          "--output-last-message",
          "<temp-file>",
          "-",
        ];
      }
      if (form.provider === "workbuddy") {
        return ["--print", "--output-format", "stream-json"];
      }
      return [];
    };
    const formatPreviewToken = (token) =>
      /^<[^>]+>$/.test(token) ? token : quoteExternalArg(token);
    const externalCommandPreview = (form) =>
      [
        String(form.command ?? "").trim() || "<command>",
        ...compileExternalRuntimeArgs(form),
        ...externalPlatformArgs(form),
      ]
        .map(formatPreviewToken)
        .join(" ");
    const externalCustomArgs = (form) => {
      const parsed = parseExternalArgsText(form.customArgsText ?? "");
      return parsed.error === "" ? parsed.args : [];
    };
    const runtimeConfigurationLabels = (runtime) => {
      const config = parseExternalRuntimeArgs(runtime.provider, runtime.args);
      const supportedModels = Array.isArray(runtime.supportedModels)
        ? runtime.supportedModels
        : [];
      const defaultModel =
        runtime.defaultModel ?? (config.model === "" ? "" : config.model);
      const supportedTools = Array.isArray(runtime.supportedTools)
        ? runtime.supportedTools
        : config.searchEnabled
          ? ["web_search"]
          : [];
      const customArgsCount = Array.isArray(runtime.customArgs)
        ? runtime.customArgs.length
        : config.advancedArgs.length;
      const labels = [
        supportedModels.length > 0
          ? `模型池：${supportedModels.length} 个`
          : defaultModel !== ""
            ? `模型：${defaultModel}`
            : "模型：CLI 默认",
        `默认模型：${defaultModel || "CLI 默认"}`,
        supportedTools.length > 0
          ? `工具：${supportedTools.map((tool) => EXTERNAL_RUNTIME_TOOL_LABEL[tool] ?? tool).join("、")}`
          : "工具：未声明",
        `上下文窗口：${formatContextWindowTokens(runtime.contextWindowTokens)} token`,
      ];
      if (runtime.provider === "workbuddy") {
        labels.push(
          `权限：${EXTERNAL_PERMISSION_MODE_LABEL[config.permissionMode] ?? config.permissionMode}`,
        );
        if (config.maxTurns !== "") {
          labels.push(`回合上限：${config.maxTurns}`);
        }
      }
      if (runtime.provider === "codex") labels.push("沙箱：只读");
      if (customArgsCount > 0) {
        labels.push(`额外参数：${customArgsCount} 项`);
      }
      return labels;
    };
    /**
     * 运行时下拉选项：只允许选择启用中的运行时；当前绑定若已停用/归档，
     * 保留为禁用项以便如实展示现状，而不是静默显示成空选。
     */
    const externalRuntimeOptions = (runtimes, boundId) => {
      const list = Array.isArray(runtimes) ? runtimes : [];
      const bound = boundId ?? "";
      return [
        h("option", { key: "__empty", value: "" }, "请选择运行时"),
        ...list
          .filter((item) => item.status === "active")
          .map((item) =>
            h(
              "option",
              { key: item.id, value: item.id },
              `${item.name} · ${externalRuntimeProviderLabel(item.provider)}`,
            ),
          ),
        ...list
          .filter((item) => item.status !== "active" && item.id === bound)
          .map((item) =>
            h(
              "option",
              { key: item.id, value: item.id, disabled: true },
              `${item.name}（${externalRuntimeStatusLabel(item.status)} · 不可用）`,
            ),
          ),
      ];
    };
    /** 当前绑定但不可用的运行时；用于编辑态提示改绑或切回内置。 */
    const unavailableBoundRuntime = (runtimes, boundId) => {
      const bound = (Array.isArray(runtimes) ? runtimes : []).find(
        (item) => item.id === (boundId ?? ""),
      );
      return bound === undefined || bound.status === "active"
        ? undefined
        : bound;
    };
    const splitExternalRuntimes = (runtimes) => {
      const list = Array.isArray(runtimes) ? runtimes : [];
      return {
        active: list.filter((item) => item.status === "active"),
        archived: list.filter((item) => item.status === "archived"),
        defaultView: list.filter((item) => item.status !== "archived"),
      };
    };
    /**
     * AI伙伴卡片的执行方式文案：绑定运行时缺失、停用或归档时，
     * 必须在列表上直接可见，而不是等派发失败才暴露。
     */
    const teammateExecutionPill = (teammate, runtimes) => {
      if ((teammate?.execution ?? "builtin") !== "external") {
        return { text: "内置执行", tone: "builtin" };
      }
      const runtimeId = teammate?.externalRuntimeId;
      if (runtimeId === undefined || runtimeId === "") {
        return { text: "外部 Agent · 未选择", tone: "external warn" };
      }
      const runtime = (Array.isArray(runtimes) ? runtimes : []).find(
        (item) => item.id === runtimeId,
      );
      if (runtime === undefined) {
        return {
          text: `外部 Agent · ${runtimeId}（运行时不存在）`,
          tone: "external warn",
        };
      }
      return runtime.status === "active"
        ? { text: `外部 Agent · ${runtime.name}`, tone: "external" }
        : {
            text: `外部 Agent · ${runtime.name}（${externalRuntimeStatusLabel(runtime.status)}）`,
            tone: "external warn",
          };
    };
    const RUN_STATUS_LABEL = {
      queued: "排队中",
      running: "运行中",
      waiting_input: "等待补充",
      succeeded: "已成功",
      failed: "失败",
      timeout: "超时",
      cancelled: "已取消",
      interrupted: "已中断",
    };
    const AVATAR_PRESETS = [
      {
        id: "sky",
        name: "晴空",
        bg: "#d9efff",
        shirt: "#568fd8",
        skin: "#f1c5a3",
        hair: "#244d77",
        accent: "#ffd166",
        hairStyle: "wave",
        glasses: false,
      },
      {
        id: "sunset",
        name: "晚霞",
        bg: "#ffe5d8",
        shirt: "#db6d65",
        skin: "#d99a76",
        hair: "#743d2d",
        accent: "#ff8d7a",
        hairStyle: "bun",
        glasses: false,
      },
      {
        id: "forest",
        name: "森屿",
        bg: "#def6e8",
        shirt: "#3f9d73",
        skin: "#e3b08d",
        hair: "#245543",
        accent: "#67d4a1",
        hairStyle: "side",
        glasses: false,
      },
      {
        id: "berry",
        name: "莓果",
        bg: "#f1e2ff",
        shirt: "#7d59c6",
        skin: "#efb38f",
        hair: "#533275",
        accent: "#c06cff",
        hairStyle: "bob",
        glasses: false,
      },
      {
        id: "lemon",
        name: "柠光",
        bg: "#fff3c9",
        shirt: "#d7a62e",
        skin: "#d49974",
        hair: "#414554",
        accent: "#f2cb45",
        hairStyle: "wave",
        glasses: true,
      },
      {
        id: "ocean",
        name: "海盐",
        bg: "#d9f4ff",
        shirt: "#2f84a8",
        skin: "#ce9874",
        hair: "#164f6f",
        accent: "#4fc3e8",
        hairStyle: "bun",
        glasses: true,
      },
    ];

    const styles = `
      /* 页面内边距由 shell 的 .pmx-page 提供，这里不再叠加，保持与工作台一致的内容宽度。 */
      .pmtm{container-type:inline-size;min-width:0;min-height:100%;flex:1 1 auto;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);}
      .pmtm *{box-sizing:border-box;}
      .pmtm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}
      .pmtm-head h1{margin:0;font-size:19px;line-height:1.3;}
      .pmtm-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmtm-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .pmtm-meeting-toggle{width:32px;height:32px;flex:none;display:grid;place-items:center;padding:0;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer;}
      .pmtm-meeting-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-meeting-toggle.active{color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 50%,transparent);}
      .pmtm-meeting-toggle svg{width:15px;height:15px;}
      /* 数据范围：两段式，高亮段 = 当前实际视图。 */
      .pmtm-scope-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtm-scope-seg .pmtm-token{height:26px;padding:0 9px;font-size:11px;background:transparent;}
      .pmtm-scope-seg .pmtm-token:not(.active):hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
      .pmtm-btn{height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:0 12px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;}
      .pmtm-btn.secondary{background:transparent;border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:500;}
      .pmtm-btn.danger{background:transparent;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 45%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtm-btn.small{height:26px;padding:0 9px;font-size:11px;}
      .pmtm-btn.quiet{background:transparent;color:var(--dsw-alias-label-tertiary);font-weight:500;}
      .pmtm-btn.quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-task-head-actions{display:grid;grid-template-columns:auto 104px;align-items:center;gap:8px;}
      .pmtm-task-head-actions .pmtm-btn{width:104px;padding:0;}
      .pmtm-btn:disabled{opacity:.45;cursor:not-allowed;}
      .pmtm-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:16px;}
      .pmtm-tabs{display:inline-flex;flex-wrap:wrap;align-items:center;gap:3px;padding:3px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
      .pmtm-tab{min-height:30px;padding:5px 11px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
      .pmtm-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-tab.active{color:#fff;background:${ACCENT};}
      .pmtm-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
      .pmtm-token{height:32px;border:0;border-radius:6px;padding:0 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
      .pmtm-token.active{background:color-mix(in srgb,${ACCENT} 14%,transparent);color:${ACCENT};}
      .pmtm-toolbar-note{max-width:460px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.5;text-align:right;}
      .pmtm-layout{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(230px,280px) minmax(0,1fr);gap:14px;align-items:stretch;margin-top:12px;}
      .pmtm-panel{min-width:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
      .pmtm-directory{padding:9px;align-self:start;}
      .pmtm-group + .pmtm-group{margin-top:12px;padding-top:11px;border-top:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 5px 7px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-weight:700;}
      .pmtm-group-title span{font-weight:500;}
      .pmtm-group-label{display:inline-flex;align-items:center;gap:6px;min-width:0;}
      .pmtm-group-count{color:var(--dsw-alias-label-tertiary);}
      .pmtm-group-metric{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500;white-space:nowrap;}
      .pmtm-item{width:100%;display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px;border:0.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;font:inherit;}
      .pmtm-item:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-item.active{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,${ACCENT} 34%,transparent);background:color-mix(in srgb,${ACCENT} 12%,transparent);}
      .pmtm-item-copy{min-width:0;}
      .pmtm-item-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}
      .pmtm-item-copy small{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtm-load{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:10px;}
      .pmtm-load-value{flex:none;white-space:nowrap;font-weight:700;}
      .pmtm-load-value .runtime{color:${ACCENT};}
      .pmtm-load-value .meetings{color:var(--dsw-alias-label-tertiary);font-weight:600;}
      .pmtm-load-value .tokens{color:var(--dsw-alias-label-secondary);font-weight:600;}
      .pmtm-load-value .live{color:#34d47e;}
      .pmtm-load-value .owned{color:var(--dsw-alias-label-secondary);}
      .pmtm-item-copy .pmtm-state-text{display:block;margin-top:3px;}
      .pmtm-item-metric{display:grid;justify-items:end;gap:3px;min-width:0;}
      .pmtm-metric-group{display:grid;justify-items:end;gap:3px;min-width:0;}
      .pmtm-load-caption{color:var(--dsw-alias-label-tertiary);font-size:9.5px;line-height:1.4;}
      .pmtm-load-stacked{display:grid;gap:1px;justify-items:end;text-align:right;margin-top:0;font-size:10px;line-height:1.5;}
      .pmtm-load-stacked .pmtm-load-value{white-space:nowrap;font-weight:700;}
      .pmtm-load-stacked .pmtm-load-value.runtime{color:${ACCENT};}
      .pmtm-load-stacked .pmtm-load-value.meetings,
      .pmtm-load-stacked .pmtm-load-value.owned{color:var(--dsw-alias-label-tertiary);font-weight:600;}
      .pmtm-load-stacked .pmtm-load-value.tokens{display:inline-flex;align-items:center;gap:3px;color:var(--dsw-alias-label-secondary);font-weight:600;}
      .pmtm-load-stacked .pmtm-load-value.live{color:#34d47e;}
      .pmtm-load-card{flex:0 1 230px;width:230px;max-width:min(230px,100%);min-width:0;margin-left:auto;padding:8px 11px;border:0.5px solid color-mix(in srgb,${ACCENT} 34%,transparent);border-radius:7px;background:color-mix(in srgb,${ACCENT} 10%,transparent);}
      .pmtm-load-card.live{flex:0 1 116px;width:116px;max-width:min(116px,100%);}
      .pmtm-load-card .label{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;}
      .pmtm-load-card .value{margin-top:2px;font-size:16px;line-height:1.25;white-space:nowrap;}
      .pmtm-load-card .value .runtime{color:${ACCENT};font-weight:800;}
      .pmtm-load-card .value .meetings{color:var(--dsw-alias-label-secondary);font-weight:700;}
      .pmtm-load-card .value .tokens{color:var(--dsw-alias-label-secondary);font-weight:700;}
      .pmtm-load-card .value .live{color:#34d47e;font-weight:800;}
      .pmtm-load-card .value .owned{color:var(--dsw-alias-label-secondary);font-weight:700;}
      .pmtm-info{position:relative;display:inline-grid;place-items:center;width:13px;height:13px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:help;}
      .pmtm-info:hover{color:${ACCENT};}
      .pmtm-info svg{width:11px;height:11px;}
      .pmtm-info-glyph,.pmtm-load svg,.pmtm-load-card svg{width:11px;height:11px;flex:none;}
      .pmtm-info-pop{position:fixed;left:-9999px;top:-9999px;z-index:60;width:min(300px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;padding:9px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 26px rgba(0,0,0,.18);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:400;line-height:1.55;text-align:left;white-space:pre-line;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity .12s ease,transform .12s ease,visibility .12s;}
      .pmtm-info:hover .pmtm-info-pop,.pmtm-info:focus-visible .pmtm-info-pop{opacity:1;visibility:visible;transform:translateY(0);}
      .pmtm-state-text{flex:none;font-size:10.5px;white-space:nowrap;}
      .pmtm-state-text.active{color:#34d47e;}
      .pmtm-state-text.paused{color:#e8a33d;}
      .pmtm-state-text.inactive,.pmtm-state-text.archived{color:var(--dsw-alias-label-tertiary);}
      .pmtm-state-text.draft{color:${ACCENT};}
      .pmtm-tick{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid color-mix(in srgb,${ACCENT} 22%,transparent);border-top-color:${ACCENT};animation:pmtmSpin .72s linear infinite;}
      .pmtm-avatar{width:32px;height:32px;display:grid;place-items:center;padding:2px;border-radius:50%;flex:none;color:#fff;font-size:10px;font-weight:800;background:conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff);box-shadow:0 0 0 1px rgba(139,108,255,.26),0 0 14px rgba(79,142,247,.12);}
      .pmtm-avatar.platform{background:#63b8ff;box-shadow:0 0 0 1px rgba(99,184,255,.55);}
      .pmtm-avatar.large{width:42px;height:42px;font-size:12px;}
      .pmtm-avatar-art{width:100%;height:100%;display:block;overflow:hidden;border:2px solid var(--dsw-alias-bg-layer-1);border-radius:50%;background:#20242a;object-fit:cover;}
      .pmtm-editor{padding:16px;min-height:420px;}
      .pmtm-editor-head{display:flex;align-items:flex-start;flex-wrap:wrap;gap:12px;}
      .pmtm-editor-identity{display:flex;align-items:flex-start;gap:12px;flex:1 1 260px;min-width:min(260px,100%);}
      .pmtm-editor-metrics{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap;flex:0 1 auto;min-width:0;}
      .pmtm-editor-actions{flex:none;display:grid;gap:6px;justify-items:stretch;min-width:104px;margin-left:auto;align-self:flex-start;}
      .pmtm-editor-head h2{margin:0;font-size:18px;line-height:1.3;overflow-wrap:anywhere;}
      .pmtm-editor-main{flex:1 1 220px;min-width:0;}
      .pmtm-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-meta.secondary{margin-top:4px;}
      .pmtm-title-row{display:flex;align-items:center;gap:6px;min-width:0;}
      .pmtm-title-row h2{min-width:0;}
      .pmtm-icon-btn{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:0.5px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}
      .pmtm-icon-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-icon-btn svg{width:13px;height:13px;}
      .pmtm-instance-name{font-size:16px;font-weight:600;}
      .pmtm-instance-desc{margin:7px 0 0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap;}
      .pmtm-instance-desc.placeholder{color:var(--dsw-alias-label-tertiary);}
      .pmtm-instance-desc-input{min-height:62px;margin-top:8px;font-size:12px;line-height:1.6;}
      .pmtm-instance-edit-actions{display:flex;gap:7px;margin-top:8px;}
      .pmtm-instance-exec{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;margin-top:8px;}
      .pmtm-instance-exec .pmtm-field{align-self:start;align-content:start;gap:4px;}
      .pmtm-instance-exec .pmtm-select{height:34px;min-height:34px;}
      .pmtm-state{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:4px;font-size:10px;}
      .pmtm-state.active{color:#34d47e;background:rgba(52,212,126,.13);}
      .pmtm-state.paused{color:#e8a33d;background:rgba(232,163,61,.14);}
      .pmtm-state.inactive,.pmtm-state.archived{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-state.draft{color:${ACCENT};background:color-mix(in srgb,${ACCENT} 14%,transparent);}
      .pmtm-notice{display:flex;gap:8px;margin-top:13px;padding:10px 11px;border:0.5px solid rgba(232,163,61,.3);border-radius:7px;color:#e9c68c;background:rgba(232,163,61,.14);font-size:11.5px;line-height:1.6;}
      .pmtm-notice.info{border-color:color-mix(in srgb,${ACCENT} 30%,transparent);color:color-mix(in srgb,${ACCENT} 70%,var(--dsw-alias-label-primary));background:color-mix(in srgb,${ACCENT} 12%,transparent);}
      .pmtm-notice svg{flex:none;width:15px;height:15px;margin-top:1px;}
      .pmtm-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px;}
      .pmtm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:9px;margin-top:14px;}
      .pmtm-grid.three{grid-template-columns:repeat(3,minmax(0,1fr));}
      /* 右列只剩工具清单时，按 2:1 分栏，人格正文留更多宽度。 */
      .pmtm-grid.two-one{grid-template-columns:2fr minmax(0,1fr);}
      .pmtm-grid.wide-gap{gap:12px;}
      .pmtm-grid .wide{grid-column:1 / -1;}
      .pmtm-field{display:grid;align-content:start;gap:4px;min-width:0;}
      .pmtm-field > .label{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-field.card{padding:9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);}
      .pmtm-field .value{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap;}
      .pmtm-code-value{display:flex;align-items:flex-start;gap:4px;min-width:0;}
      .pmtm-code-value > span:first-child{flex:1;min-width:0;overflow-wrap:anywhere;}
      .pmtm-code-info{flex:none;display:inline-grid;place-items:center;width:13px;height:13px;margin-top:1px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:help;}
      .pmtm-code-info:hover{color:${ACCENT};}
      .pmtm-code-info svg{width:11px;height:11px;}
      .pmtm-input,.pmtm-area,.pmtm-select{width:100%;min-width:0;min-height:34px;padding:7px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;}
      .pmtm-input,.pmtm-select{height:34px;padding-top:0;padding-bottom:0;}
      .pmtm-area{min-height:92px;resize:vertical;}
      .pmtm-area.soul{min-height:210px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;}
      .pmtm-block{padding:12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);min-width:0;}
      .pmtm-block h3{margin:0 0 8px;font-size:12.5px;}
      .pmtm-block pre{margin:0;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;}
      .pmtm-md{display:grid;gap:6px;color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.65;}
      .pmtm-md:first-child{margin-top:0;}
      .pmtm-md p{margin:0;}
      .pmtm-md h4,.pmtm-md h5,.pmtm-md h6{margin:2px 0 0;font-size:11.5px;line-height:1.45;}
      .pmtm-md ul,.pmtm-md ol{margin:0;padding-left:17px;display:grid;gap:3px;}
      .pmtm-md code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;}
      .pmtm-md pre{margin:0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;overflow-wrap:anywhere;}
      .pmtm-md-table-wrap{overflow-x:auto;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;}
      .pmtm-md-table{border-collapse:collapse;width:100%;font-size:11px;}
      .pmtm-md-table th,.pmtm-md-table td{padding:5px 8px;border-right:0.5px solid var(--dsw-alias-border-l2);border-bottom:0.5px solid var(--dsw-alias-border-l2);text-align:left;vertical-align:top;overflow-wrap:anywhere;}
      .pmtm-md-table th:last-child,.pmtm-md-table td:last-child{border-right:0;}
      .pmtm-md-table tbody tr:last-child td{border-bottom:0;}
      .pmtm-md-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600;}
      .pmtm-rules{margin:0;padding:0;list-style:none;display:grid;gap:6px;}
      .pmtm-rules li{display:flex;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmtm-rules li::before{content:"";flex:none;width:5px;height:5px;margin-top:6px;border-radius:50%;background:${ACCENT};}
      .pmtm-timeline{display:grid;gap:7px;}
      .pmtm-event{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmtm-event time{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-runtime{display:grid;gap:8px;margin-top:14px;}
      .pmtm-runtime-item{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;padding:11px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);}
      .pmtm-runtime-item > :last-child{grid-row:1;grid-column:2;align-self:start;white-space:nowrap;}
      .pmtm-runtime-item.status-progress{border-left:3px solid ${ACCENT};}
      .pmtm-runtime-item.status-review{border-left:3px solid #a48bff;}
      .pmtm-runtime-item.status-done{border-left:3px solid #34d47e;}
      .pmtm-runtime-item.status-archived{border-left:3px dashed var(--dsw-alias-label-tertiary);opacity:.68;}
      .pmtm-runtime-main{min-width:0;}
      .pmtm-runtime-main strong{display:block;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtm-runtime-main small{display:block;margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-runtime-body{grid-column:1 / -1;min-width:0;}
      .pmtm-runtime-body .pmtm-latest{margin-top:0;}
      .pmtm-latest{min-width:0;display:flex;align-items:flex-start;gap:6px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.45;}
      .pmtm-latest .label{flex:none;color:var(--dsw-alias-label-tertiary);}
      /* Markdown 渲染成块级内容后 line-clamp 失效，改用 max-height 控制 3 行折叠。 */
      .pmtm-latest .text{min-width:0;flex:1 1 auto;max-height:4.4em;overflow:hidden;overflow-wrap:anywhere;}
      .pmtm-latest .text.expanded{max-height:none;overflow:visible;}
      .pmtm-latest .text.pmtm-md{gap:3px;}
      .pmtm-latest-toggle{flex:none;border:0;padding:0;background:transparent;color:${ACCENT};font:inherit;font-size:11.5px;cursor:pointer;}
      .pmtm-latest-toggle:hover{text-decoration:underline;}
      .pmtm-latest.streaming .text{color:transparent;background:linear-gradient(90deg,#73839a 0%,#dcecff 42%,#9cb9dc 65%,#73839a 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;animation:pmtmStream 2.2s linear infinite,pmtmReveal 3.2s ease-in-out infinite;}
      .pmtm-caret{flex:none;width:2px;height:12px;border-radius:2px;background:${ACCENT};animation:pmtmBlink .75s step-end infinite;}
      .pmtm-spinner{position:absolute;top:10px;right:10px;width:13px;height:13px;border:2px solid color-mix(in srgb,${ACCENT} 20%,transparent);border-top-color:${ACCENT};border-radius:50%;animation:pmtmSpin .72s linear infinite;}
      @keyframes pmtmSpin{to{transform:rotate(360deg);}}
      @keyframes pmtmStream{to{background-position:-220% 0;}}
      @keyframes pmtmBlink{50%{opacity:0;}}
      @keyframes pmtmReveal{0%,8%{clip-path:inset(0 100% 0 0);}58%,88%{clip-path:inset(0 0 0 0);}100%{clip-path:inset(0 0 0 0);}}
      .pmtm-pill{display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap;}
      .pmtm-pill.progress{color:${ACCENT};background:color-mix(in srgb,${ACCENT} 14%,transparent);}
      .pmtm-pill.review{color:#a48bff;background:rgba(164,139,255,.14);}
      .pmtm-pill.done{color:#34d47e;background:rgba(52,212,126,.13);}
      .pmtm-pill.todo{color:var(--dsw-alias-label-secondary);}
      .pmtm-count{min-width:20px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;text-align:center;}
      .pmtm-empty{padding:28px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:7px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12.5px;}
      .pmtm-avatar-editor{display:flex;gap:12px;align-items:flex-start;}
      .pmtm-avatar-preview{width:64px;height:64px;display:grid;place-items:center;padding:3px;border-radius:50%;flex:none;background:conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff);box-shadow:0 0 0 1px rgba(139,108,255,.26),0 0 14px rgba(79,142,247,.12);}
      .pmtm-avatar-preview.platform{background:#63b8ff;box-shadow:0 0 0 1px rgba(99,184,255,.55);}
      .pmtm-presets{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px;}
      .pmtm-preset{display:grid;justify-items:center;gap:4px;padding:6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer;}
      .pmtm-preset:hover{border-color:var(--dsw-alias-border-l4);}
      .pmtm-preset.active{border-color:color-mix(in srgb,${ACCENT} 55%,transparent);background:color-mix(in srgb,${ACCENT} 12%,transparent);color:var(--dsw-alias-label-primary);}
      .pmtm-preset .pmtm-avatar{width:38px;height:38px;}
      .pmtm-error{margin-top:12px;padding:9px 11px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 40%,transparent);border-radius:7px;color:var(--dsw-alias-state-error-primary,#e5534b);font-size:11.5px;}
      .pmtm-notice-bar{margin-top:12px;padding:9px 11px;border:0.5px solid color-mix(in srgb,${ACCENT} 30%,transparent);border-radius:7px;background:color-mix(in srgb,${ACCENT} 10%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;}
      .pmtm-mask{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px;background:rgba(8,10,14,.55);}
      .pmtm-dialog{width:min(980px,100%);max-height:min(84vh,900px);display:flex;flex-direction:column;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 60px rgba(0,0,0,.35);}
      .pmtm-dialog-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-dialog-head h2{flex:1;min-width:0;margin:0;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtm-dialog-body{flex:1;min-height:0;overflow:auto;display:grid;gap:12px;align-content:start;padding:14px 16px;}
      .pmtm-dialog-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-top:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-search-row{display:flex;align-items:center;gap:8px;}
      .pmtm-search-row input{flex:1;min-width:0;height:36px;padding:0 11px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;}
      .pmtm-search-btn{width:36px;height:36px;flex:none;display:grid;place-items:center;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;}
      .pmtm-search-btn:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);}
      .pmtm-filter-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .pmtm-filter-row select{height:34px;min-width:150px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
      .pmtm-result-count{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11.5px;}
      .pmtm-assign-list{display:grid;gap:10px;}
      .pmtm-assign-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;text-align:left;cursor:pointer;}
      .pmtm-assign-item:hover{border-color:var(--dsw-alias-border-l4);}
      .pmtm-assign-item.selected{border-color:color-mix(in srgb,${ACCENT} 55%,transparent);background:color-mix(in srgb,${ACCENT} 10%,transparent);}
      .pmtm-assign-item strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}
      .pmtm-assign-meta{display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;}
      .pmtm-assign-trailing{display:flex;align-items:center;gap:8px;}
      .pmtm-check{width:18px;height:18px;display:grid;place-items:center;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;color:transparent;font-size:11px;}
      .pmtm-assign-item.selected .pmtm-check{border-color:${ACCENT};background:${ACCENT};color:#fff;}
      .pmtm-profile-manager{flex:1 1 auto;min-width:0;margin-top:12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
      .pmtm-profile-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 16px;padding:14px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-profile-head h2{margin:0;font-size:16px;}
      .pmtm-profile-head-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-left:auto;}
      .pmtm-profile-sub{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-profile-desc{margin-top:5px;max-width:760px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;}
      .pmtm-profile-state{display:inline-flex;align-items:center;height:26px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmtm-profile-body{display:grid;grid-template-columns:270px minmax(0,1fr);align-items:start;}
      .pmtm-profile-sidebar{min-width:0;padding:10px;border-right:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-profile-search{width:100%;min-height:31px;margin-bottom:8px;padding:6px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;}
      .pmtm-profile-list{display:grid;gap:5px;}
      .pmtm-profile-item{width:100%;display:grid;grid-template-columns:8px minmax(0,1fr);align-items:start;gap:8px;padding:10px;border:0.5px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;}
      .pmtm-profile-item:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtm-profile-item.active{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,${ACCENT} 42%,transparent);background:color-mix(in srgb,${ACCENT} 10%,transparent);}
      .pmtm-profile-dot{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
      .pmtm-profile-dot.enabled{background:#34d47e;box-shadow:0 0 0 3px rgba(52,212,126,.1);}
      .pmtm-profile-copy{min-width:0;}
      .pmtm-profile-copy strong,.pmtm-profile-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtm-profile-copy strong{font-size:12px;}
      .pmtm-profile-copy small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px;}
      /* 运行时卡片：内容 + 操作两列，避免复用侧栏“圆点 + 文案”的 8px 网格。 */
      .pmtm-profile-item.runtime{min-width:0;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:12px 14px;border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);}
      .pmtm-profile-item.runtime:hover{background:var(--dsw-alias-bg-layer-2);}
      .pmtm-profile-item.runtime > div{min-width:0;overflow-wrap:anywhere;}
      .pmtm-profile-item.runtime strong{display:block;font-size:12.5px;color:var(--dsw-alias-label-primary);}
      .pmtm-profile-item.runtime .pmtm-actions{margin-top:0;justify-content:flex-end;}
      .pmtm-profile-item.runtime.disabled{opacity:.9;}
      .pmtm-profile-item.runtime.archived{border-style:dashed;opacity:.72;}
      .pmtm-profile-item.runtime .pmtm-runtime-head-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
      .pmtm-inline-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;overflow-wrap:anywhere;}
      .pmtm-runtime-summary{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:6px;}
      .pmtm-runtime-summary span{display:inline-flex;align-items:center;min-height:22px;padding:2px 7px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.35;}
      .pmtm-config-section{margin-top:14px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-config-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:9px;}
      .pmtm-config-section-head strong{font-size:12.5px;}
      .pmtm-config-section-head span{max-width:560px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.5;}
      .pmtm-choice-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:34px;}
      .pmtm-choice{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:6px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;}
      .pmtm-choice:has(input:checked){border-color:color-mix(in srgb,${ACCENT} 55%,transparent);background:color-mix(in srgb,${ACCENT} 11%,transparent);color:var(--dsw-alias-label-primary);}
      .pmtm-choice input{accent-color:${ACCENT};margin:0;}
      .pmtm-capability-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px;}
      .pmtm-capability-grid.models{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));}
      .pmtm-capability-option{display:flex;align-items:center;gap:6px;min-width:0;min-height:32px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;overflow-wrap:anywhere;}
      .pmtm-capability-option:has(input:checked){border-color:color-mix(in srgb,${ACCENT} 55%,transparent);background:color-mix(in srgb,${ACCENT} 11%,transparent);color:var(--dsw-alias-label-primary);}
      .pmtm-capability-option input{flex:none;accent-color:${ACCENT};margin:0;}
      .pmtm-model-add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;margin-top:8px;}
      .pmtm-config-facts{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:8px;}
      .pmtm-config-facts span{display:inline-flex;min-height:22px;align-items:center;padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.35;}
      .pmtm-config-error{margin-top:8px;color:var(--dsw-alias-state-error-primary,#e5534b);font-size:11px;line-height:1.5;}
      .pmtm-command-preview{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px;padding:9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);}
      .pmtm-command-preview code{display:block;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.55;}
      .pmtm-advanced-config{padding-top:0;border-top:0;}
      .pmtm-advanced-toggle{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto 12px;align-items:center;gap:9px;border:0;padding:11px 0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;}
      .pmtm-advanced-toggle-copy{display:grid;gap:3px;min-width:0;}
      .pmtm-advanced-toggle-copy strong{font-size:12.5px;}
      .pmtm-advanced-toggle-copy small{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.45;}
      .pmtm-advanced-badge{display:inline-flex;align-items:center;min-height:22px;padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap;}
      .pmtm-advanced-caret{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg) translate(-2px,-2px);transition:transform .15s ease;}
      .pmtm-advanced-caret.open{transform:rotate(225deg) translate(-2px,-2px);}
      .pmtm-advanced-body{display:grid;gap:10px;padding:0 0 2px;}
      .pmtm-advanced-args{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;}
      .pmtm-runtime-form-actions{flex-wrap:nowrap;align-items:center;}
      .pmtm-runtime-form-actions > :first-child{margin-right:auto;}
      .pmtm-arg-list{display:grid;gap:7px;margin-top:8px;}
      .pmtm-arg-row{display:grid;grid-template-columns:128px minmax(0,1fr) auto;align-items:center;gap:7px;min-width:0;}
      .pmtm-arg-row.with-value{grid-template-columns:128px minmax(0,0.9fr) minmax(0,1.1fr) auto;}
      .pmtm-arg-remove{width:30px;height:30px;display:grid;place-items:center;padding:0;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;}
      .pmtm-arg-remove:hover{color:var(--dsw-alias-state-error-primary,#e5534b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 42%,transparent);}
      .pmtm-profile-detail{min-width:0;min-height:420px;padding:16px;}
      .pmtm-profile-detail h3,.pmtm-profile-form h3{margin:0;font-size:15px;}
      .pmtm-profile-title{display:grid;gap:4px;}
      .pmtm-profile-title span{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-profile-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin:12px 0;}
      .pmtm-profile-section-title{margin:15px 0 6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:650;}
      .pmtm-profile-code{margin:0;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;}
      .pmtm-profile-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}
      .pmtm-profile-columns ul{margin:0;padding-left:17px;display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;}
      .pmtm-profile-tools{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;}
      .pmtm-profile-form{max-width:980px;}
      .pmtm-profile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0;}
      .pmtm-profile-grid label{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;}
      .pmtm-profile-grid .wide{grid-column:1 / -1;}
      .pmtm-profile-grid input,.pmtm-profile-grid select,.pmtm-profile-grid textarea{width:100%;min-height:32px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
      .pmtm-profile-grid textarea{min-height:78px;resize:vertical;}
      .pmtm-profile-grid textarea.soul{min-height:210px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;}
      .pmtm-profile-empty{padding:24px 12px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;text-align:center;}
      .pmtm-profile-empty.tall{padding-top:70px;}
      /* 运行态四个页签 */
      .pmtm-runtime-tabs{display:flex;align-items:center;gap:2px;margin-top:16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
      .pmtm-runtime-tab{position:relative;min-height:34px;padding:6px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
      .pmtm-runtime-tab:hover{color:var(--dsw-alias-label-primary);}
      .pmtm-runtime-tab.active{color:${ACCENT};font-weight:600;}
      .pmtm-runtime-tab.active::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:${ACCENT};}
      .pmtm-runtime-panel{padding-top:14px;}
      .pmtm-runtime-panel[hidden]{display:none;}
      /* 基础信息编辑态：收起下方运行态页签里的操作位，避免误触发任务/角色动作 */
      .pmtm-runtime-panels.editing .pmtm-btn{display:none;}
      .pmtm-runtime-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:28px;margin-bottom:10px;}
      .pmtm-runtime-head h3{margin:0;font-size:13px;white-space:nowrap;}
      .pmtm-runtime-head-main{display:flex;align-items:center;gap:8px;min-width:0;}
      .pmtm-runtime-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;min-width:0;}
      .pmtm-runtime-summary{color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;}
      /* 工作计划 */
      .pmtm-plan-composer{display:grid;gap:9px;margin-bottom:14px;padding:12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}
      .pmtm-plan-composer textarea{width:100%;min-height:78px;padding:9px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.6;resize:vertical;}
      .pmtm-plan-composer textarea:focus{outline:none;border-color:color-mix(in srgb,${ACCENT} 60%,transparent);}
      .pmtm-plan-parsed{min-height:16px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.5;}
      .pmtm-plan-parsed strong{color:var(--dsw-alias-label-secondary);font-weight:600;}
      .pmtm-plan-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;}
      .pmtm-plan-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;min-width:0;}
      .pmtm-plan-control{display:grid;gap:4px;min-width:0;}
      .pmtm-plan-control > span{color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtm-plan-control select,.pmtm-plan-control input[type="date"]{height:30px;min-width:128px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;}
      .pmtm-plan-check{display:inline-flex;align-items:center;gap:6px;height:30px;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;cursor:pointer;}
      .pmtm-plan-check input{width:14px;height:14px;margin:0;accent-color:${ACCENT};}
      .pmtm-plan-item .pmtm-runtime-main strong{white-space:normal;}
      .pmtm-plan-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;}
      /* 工作队列（P1）：排序、暂停、待确认动作 */
      .pmtm-queue-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;}
      .pmtm-plan-item.pmtm-queue-paused{opacity:.62;}
      .pmtm-queue-reject{grid-column:1 / -1;display:grid;gap:8px;margin-top:2px;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);}
      .pmtm-queue-reject textarea{width:100%;min-height:64px;padding:8px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.55;resize:vertical;}
      .pmtm-queue-reject-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;}
      .pmtm-pill.warn{color:#e8a33d;background:rgba(232,163,61,.14);}
      .pmtm-queue-finished-list{display:grid;gap:6px;}
      .pmtm-queue-finished{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:7px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmtm-queue-finished>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      /* 角色权限：实例所在项目 + 项目角色/权限 + 退出动作 */
      .pmtm-role-list{display:grid;gap:9px;}
      .pmtm-role-card{display:grid;gap:7px;padding:10px 11px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);min-width:0;}
      .pmtm-role-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0;}
      .pmtm-role-head strong{display:block;font-size:12.5px;overflow-wrap:anywhere;}
      .pmtm-role-head small{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-role-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:7px;border-top:0.5px dashed var(--dsw-alias-border-l2);min-width:0;}
      .pmtm-role-main{display:grid;gap:2px;min-width:0;justify-items:start;}
      .pmtm-role-perms{color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere;}
      .pmtm-role-main small{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-pill.role{color:${ACCENT};background:color-mix(in srgb,${ACCENT} 14%,transparent);}
      .pmtm-pill.template{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);}
      .pmtm-pill.execution{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);}
      .pmtm-pill.execution.external{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
      .pmtm-pill.execution.warn{border-color:rgba(232,163,61,.45);color:#e8a33d;background:rgba(232,163,61,.12);}
      .pmtm-pill.runtime-status{font-weight:600;}
      .pmtm-pill.runtime-status.active{border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#34d47e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 12%,transparent);}
      .pmtm-pill.runtime-status.disabled{border:0.5px solid rgba(232,163,61,.45);color:#e8a33d;background:rgba(232,163,61,.12);}
      .pmtm-pill.runtime-status.archived{border:0.5px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);}
      /* 工作日报 */
      /* 日期区间 + 关键词 + 更新日报固定一行：搜索框可压缩，按钮与日期不换行。 */
      .pmtm-report-filters{display:flex;align-items:center;gap:8px;flex:0 1 auto;flex-wrap:nowrap;justify-content:flex-end;min-width:0;}
      .pmtm-report-filters>.pmtm-btn{flex:none;}
      .pmtm-report-range{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;}
      .pmtm-report-range input{height:30px;width:122px;padding:0 7px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;}
      .pmtm-report-search{display:inline-flex;flex:1 1 200px;min-width:120px;max-width:420px;align-items:center;gap:6px;height:30px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);}
      .pmtm-report-notice{margin:-2px 0 10px;padding:6px 10px;border:0.5px solid color-mix(in srgb,${ACCENT} 30%,transparent);border-radius:6px;background:color-mix(in srgb,${ACCENT} 10%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;}
      .pmtm-report-search svg{width:13px;height:13px;flex:none;}
      .pmtm-report-search input{flex:1;min-width:0;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;}
      .pmtm-report-card{padding:12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}
      .pmtm-report-card + .pmtm-report-card{margin-top:10px;}
      .pmtm-report-card h3{margin:0 0 3px;font-size:13px;}
      .pmtm-report-writer{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtm-report-body{margin-top:9px;}
      .pmtm-report-history{margin-top:10px;}
      .pmtm-report-source{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:10px;overflow-wrap:anywhere;}
      .pmtm-report-pending{align-self:center;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      /* 历史执行记录 */
      .pmtm-audit-list{display:grid;gap:8px;}
      .pmtm-audit-item{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;padding:9px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);}
      .pmtm-audit-item time{color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;}
      .pmtm-audit-copy{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;overflow-wrap:anywhere;}
      .pmtm-audit-actor{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtm-audit-more{display:flex;justify-content:center;margin-top:10px;}
      @media (max-width:1080px){
        .pmtm-layout{grid-template-columns:1fr;}
        .pmtm-profile-body{grid-template-columns:1fr;}
        .pmtm-profile-sidebar{border-right:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
        .pmtm-profile-columns,.pmtm-profile-grid{grid-template-columns:1fr;}
        .pmtm-profile-item.runtime{grid-template-columns:1fr;}
        .pmtm-profile-item.runtime .pmtm-actions{justify-content:flex-start;}
        .pmtm-grid,.pmtm-grid.three,.pmtm-grid.two-one{grid-template-columns:1fr;}
        .pmtm-grid .wide{grid-column:auto;}
        .pmtm-instance-exec{grid-template-columns:1fr;}
        .pmtm-arg-row,.pmtm-arg-row.with-value{grid-template-columns:1fr;}
        .pmtm-arg-remove{width:100%;}
        .pmtm-toolbar{flex-direction:column;align-items:flex-start;}
        .pmtm-toolbar-note{max-width:none;text-align:left;}
        .pmtm-presets{grid-template-columns:repeat(3,minmax(0,1fr));}
      }
      @container (max-width:880px){
        .pmtm-layout{grid-template-columns:1fr;}
        .pmtm-profile-body{grid-template-columns:1fr;}
        .pmtm-profile-sidebar{border-right:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
        .pmtm-profile-columns,.pmtm-profile-grid{grid-template-columns:1fr;}
        .pmtm-grid,.pmtm-grid.three,.pmtm-grid.two-one{grid-template-columns:1fr;}
        .pmtm-grid .wide{grid-column:auto;}
        .pmtm-instance-exec{grid-template-columns:1fr;}
        .pmtm-arg-row,.pmtm-arg-row.with-value{grid-template-columns:1fr;}
        .pmtm-arg-remove{width:100%;}
        .pmtm-toolbar{flex-direction:column;align-items:flex-start;}
        .pmtm-toolbar-note{max-width:none;text-align:left;}
        .pmtm-presets{grid-template-columns:repeat(3,minmax(0,1fr));}
      }
    `;

    function token() {
      return window.localStorage.getItem(TOKEN_KEY);
    }

    async function request(path, options = {}) {
      const headers = { "cache-control": "no-store" };
      if (options.body !== undefined)
        headers["content-type"] = "application/json";
      const current = token();
      if (current !== null) headers.authorization = `Bearer ${current}`;
      const response = await fetch(path, {
        ...options,
        headers: { ...headers, ...options.headers },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    function timeShort(value) {
      if (typeof value !== "string" || value.trim() === "") return "";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return value;
      const pad = (input) => String(input).padStart(2, "0");
      return `${pad(parsed.getMonth() + 1)}/${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
    }

    function auditTimeText(value) {
      if (typeof value !== "string" || value.trim() === "") return "";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return value;
      const pad = (input) => String(input).padStart(2, "0");
      const date = `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
      return parsed.getFullYear() === new Date().getFullYear()
        ? date
        : `${parsed.getFullYear()}-${date}`;
    }

    function runtimeHoursText(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        return "0 hr";
      if (value < 0.1) return "<0.1 hr";
      return `${value.toFixed(1)} hr`;
    }

    function outputTokensText(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        return "0";
      if (value >= 10_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
      if (value >= 10_000) return `${(value / 1_000).toFixed(2)} K`;
      return String(Math.trunc(value));
    }

    const WORK_PLAN_PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 };
    const WORK_PLAN_PRIORITY_OPTIONS = ["P0", "P1", "P2", "P3"];
    /** 运行态详情固定四个页签，顺序即为产品口径。 */
    const RUNTIME_TABS = [
      { key: "current", label: "当前工作" },
      { key: "plan", label: "工作计划" },
      { key: "report", label: "工作日报" },
      { key: "roles", label: "角色权限" },
      { key: "audit", label: "历史记录" },
    ];

    /** 工作区角色与权限的展示口径（与员工档案的 role_assignments 对齐）。 */
    const WORKSPACE_ROLE_LABEL = {
      viewer: "只读成员",
      member: "成员",
      owner: "Owner",
    };
    const PERMISSION_LABEL = {
      read: "查看",
      write: "写入",
      approve: "审批",
      manage_workspace: "管理工作区",
      manage_members: "管理成员",
      manage_roles: "管理角色",
    };

    /** 产品展示口径 P0–P2 → 任务存储口径 P1–P3。 */
    function planStoragePriority(display) {
      if (display === "P0") return "P1";
      if (display === "P1") return "P2";
      return "P3";
    }

    /** 计划项排序：优先级升序，同级按创建时间升序，保持稳定。 */
    function sortPlanTasks(tasks) {
      return [...tasks].sort((left, right) => {
        const gap =
          (WORK_PLAN_PRIORITY_RANK[left.priority] ?? 9) -
          (WORK_PLAN_PRIORITY_RANK[right.priority] ?? 9);
        if (gap !== 0) return gap;
        return left.createdAt.localeCompare(right.createdAt);
      });
    }

    /**
     * 运行态详情的「基础信息编辑态」策略：编辑资料时只聚焦基础字段，
     * 收起工作负荷统计，并锁定下方运行态页签里的操作位。
     */
    function runtimeDetailEditPolicy(editing) {
      return {
        showMetrics: !editing,
        panelsClass: `pmtm-runtime-panels${editing ? " editing" : ""}`,
      };
    }

    /**
     * 定义态列表按 Agent 模版聚合：同一模版下的多个实例只占一条记录，
     * 代表取最早创建的实例（其定义即该模版的当前定义）。
     */
    function groupTeammateTemplates(items) {
      if (arguments.length > 1) {
        const templates = arguments[1];
        return templates.map((template) => ({
          item: template,
          instanceIds: items
            .filter((instance) => instance.templateId === template.id)
            .map((instance) => instance.id),
        }));
      }
      const groups = new Map();
      for (const item of items) {
        const key =
          item.profileTemplateId ?? item.personaId ?? `instance:${item.id}`;
        const current = groups.get(key);
        if (current === undefined) {
          groups.set(key, { item, instanceIds: [item.id] });
          continue;
        }
        current.instanceIds.push(item.id);
        if (item.createdAt.localeCompare(current.item.createdAt) < 0) {
          current.item = item;
        }
      }
      return [...groups.values()];
    }

    /** 工作区角色授权是否已过期（到期时间早于当前时间）。 */
    function isRoleExpired(assignment) {
      if (
        typeof assignment?.expiresAt !== "string" ||
        assignment.expiresAt === ""
      ) {
        return false;
      }
      const at = Date.parse(assignment.expiresAt);
      return Number.isFinite(at) && at <= Date.now();
    }

    function localIsoDate(date) {
      const pad = (input) => String(input).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function addLocalDays(date, days) {
      const next = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      next.setDate(next.getDate() + days);
      return localIsoDate(next);
    }

    function defaultReportRange() {
      // 工作日报是历史快照，默认不做时间窗口截断：7 天窗口会让更早的快照
      // 看起来像"消失"了。日期选择器仍可用于手动收窄范围。
      return { from: "", to: "" };
    }

    /** 工作计划的自然语言输入与解析预览；选择器值优先于解析预填值。 */
    function WorkPlanComposer({
      teammate,
      canManagePlatform,
      onCreated,
      onError,
      onNotice,
    }) {
      const [instruction, setInstruction] = react.useState("");
      const [parsed, setParsed] = react.useState(null);
      const [workspaces, setWorkspaces] = react.useState([]);
      const [projectOverride, setProjectOverride] = react.useState("");
      const [priorityOverride, setPriorityOverride] = react.useState("");
      const [dueOverride, setDueOverride] = react.useState("");
      const [autoSubmitReview, setAutoSubmitReview] = react.useState(true);
      const [submitting, setSubmitting] = react.useState(false);
      const [parseError, setParseError] = react.useState("");
      const active = teammate.state === "active";
      const trimmed = instruction.trim();

      react.useEffect(() => {
        setInstruction("");
        setParsed(null);
        setWorkspaces([]);
        setProjectOverride("");
        setPriorityOverride("");
        setDueOverride("");
        setParseError("");
      }, [teammate.id]);

      react.useEffect(() => {
        let cancelled = false;
        void request("/api/collab/team/workspaces")
          .then((result) => {
            if (cancelled) return;
            setWorkspaces(
              (result.workspaces ?? [])
                .filter(
                  (workspace) =>
                    workspace.isMember === true || canManagePlatform === true,
                )
                .map((workspace) => ({
                  id: workspace.id,
                  title: workspace.title ?? workspace.id,
                  isMember: workspace.isMember === true,
                })),
            );
          })
          .catch(() => {
            // 项目选择器保持空态，解析接口返回的工作区仍可兜底。
          });
        return () => {
          cancelled = true;
        };
      }, [teammate.id, canManagePlatform]);

      react.useEffect(() => {
        if (trimmed === "") {
          setParsed(null);
          setParseError("");
          return undefined;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
          void request("/api/collab/teammates/work-plans/parse", {
            method: "POST",
            body: { teammateId: teammate.id, instruction: trimmed },
          })
            .then((result) => {
              if (!cancelled) {
                setParsed(result.parsed ?? null);
                setParseError("");
              }
            })
            .catch((cause) => {
              if (!cancelled) {
                setParseError(
                  cause instanceof Error ? cause.message : "解析失败",
                );
              }
            });
        }, 320);
        return () => {
          cancelled = true;
          window.clearTimeout(timer);
        };
      }, [trimmed, teammate.id]);

      const options = parsed?.workspaces ?? workspaces;
      const effectiveProject =
        projectOverride || parsed?.workspaceId || options[0]?.id || "";
      const effectivePriority = priorityOverride || parsed?.priority || "P2";
      const effectiveDue =
        dueOverride || parsed?.due || addLocalDays(new Date(), 1);
      const recognized = [];
      if (parsed !== null) {
        recognized.push(`优先级 ${parsed.priority}`);
        if (parsed.due) recognized.push(`截止 ${parsed.due}`);
        if (parsed.workspaceTitle)
          recognized.push(`项目 ${parsed.workspaceTitle}`);
      }

      const submit = async (event) => {
        event.preventDefault();
        if (!active || submitting) return;
        if (trimmed === "") {
          setParseError("请先输入计划说明。");
          return;
        }
        if (effectiveProject === "") {
          setParseError("没有可用项目，请先加入一个项目。");
          return;
        }
        try {
          setSubmitting(true);
          const result = await request("/api/collab/teammates/work-plans", {
            method: "POST",
            body: {
              teammateId: teammate.id,
              instruction: trimmed,
              workspaceId: effectiveProject,
              priority: effectivePriority,
              due: effectiveDue,
              autoSubmitReview,
            },
          });
          const task = result.task ?? null;
          const execution = result.execution ?? {};
          setInstruction("");
          setParsed(null);
          setProjectOverride("");
          setPriorityOverride("");
          setDueOverride("");
          setParseError("");
          await onCreated();
          if (execution.error !== undefined) {
            onError(
              new Error(`计划项已创建，但 Agent 未能启动：${execution.error}`),
            );
          } else if (task !== null) {
            onNotice(
              `已创建计划项 ${task.id}，已派发给 ${teammate.name} 执行，可在「当前工作」查看进度。`,
            );
          }
        } catch (cause) {
          onError(cause);
        } finally {
          setSubmitting(false);
        }
      };

      return h(
        "form",
        { className: "pmtm-plan-composer", onSubmit: submit },
        h("textarea", {
          name: "instruction",
          value: instruction,
          placeholder:
            "例如：请预研供应链例外决策材料，汇总安全库存和关键订单影响，9 月 26 日前输出一页结论。",
          disabled: !active,
          onChange: (event) => setInstruction(event.target.value),
          "aria-label": "工作计划说明",
        }),
        h(
          "div",
          { className: "pmtm-plan-parsed", "aria-live": "polite" },
          parseError !== ""
            ? parseError
            : recognized.length > 0
              ? `已识别：${recognized.join(" · ")}`
              : "支持自然语言描述：优先级、项目与截止日期会自动识别，也可以直接修改下方选择器。",
        ),
        h(
          "div",
          { className: "pmtm-plan-toolbar" },
          h(
            "div",
            { className: "pmtm-plan-controls" },
            h(
              "label",
              { className: "pmtm-plan-control" },
              h("span", null, "项目"),
              h(
                "select",
                {
                  value: effectiveProject,
                  disabled: !active,
                  onChange: (event) => setProjectOverride(event.target.value),
                  "aria-label": "项目",
                },
                ...(options.length === 0
                  ? [h("option", { value: "" }, "暂无可创建项目")]
                  : options.map((option) =>
                      h(
                        "option",
                        { key: option.id, value: option.id },
                        option.title,
                      ),
                    )),
              ),
            ),
            h(
              "label",
              { className: "pmtm-plan-control" },
              h("span", null, "优先级"),
              h(
                "select",
                {
                  value: effectivePriority,
                  disabled: !active,
                  onChange: (event) => setPriorityOverride(event.target.value),
                  "aria-label": "优先级",
                },
                ...WORK_PLAN_PRIORITY_OPTIONS.map((value) =>
                  h("option", { key: value, value }, value),
                ),
              ),
            ),
            h(
              "label",
              { className: "pmtm-plan-check" },
              h("input", {
                type: "checkbox",
                checked: autoSubmitReview,
                disabled: !active,
                onChange: (event) => setAutoSubmitReview(event.target.checked),
              }),
              h("span", null, "自动提交 review"),
            ),
            h(
              "label",
              { className: "pmtm-plan-control" },
              h("span", null, "截止日期"),
              h("input", {
                type: "date",
                value: effectiveDue,
                disabled: !active,
                onChange: (event) => setDueOverride(event.target.value),
                "aria-label": "截止日期",
              }),
            ),
          ),
          h(
            "button",
            {
              type: "submit",
              className: "pmtm-btn small",
              disabled: !active || submitting,
              title: active
                ? "创建计划项"
                : "AI伙伴未生效，不能接收新的工作计划",
            },
            submitting ? "创建中…" : "创建计划项",
          ),
        ),
      );
    }

    function activityFor(activity, teammateId) {
      return activity.items.find((item) => item.teammateId === teammateId);
    }

    /**
     * scope = "instance"：运行态口径，只统计绑定到该数字员工实例的数据；
     * scope = "template"：定义态口径，按同一 Agent 模版（profile）汇总，多实例共享时数据一致。
     */
    function activityScopeFor(activity, teammateId, scope) {
      const item = activityFor(activity, teammateId);
      const fallback = { runtimeHours: 0, meetingCount: 0, outputTokens: 0 };
      if (item === undefined) return fallback;
      if (item.instance !== undefined || item.template !== undefined) {
        return (
          (scope === "template" ? item.template : item.instance) ?? fallback
        );
      }
      // 兼容未分口径的旧接口
      return {
        runtimeHours: item.runtimeHours ?? 0,
        meetingCount: item.meetingCount ?? 0,
        outputTokens: item.outputTokens ?? 0,
      };
    }

    const LIVE_INSTANCES_HELP = "我的 / 平台生效 AI伙伴数。";

    /** 近 24 小时统计的口径说明（列表标题与详情卡片共用）。 */
    function loadScopeTitle(scope, generatedAt = "") {
      return [
        scope === "template"
          ? "口径：按同一 Agent 模版（profile）汇总，可能被多个 AI伙伴共享。"
          : "口径：仅统计绑定到该 AI伙伴的运行（AI伙伴绑定的 Run，以及指派给它的任务运行）。",
        `统计周期：最近 24 小时，每 30 秒刷新${generatedAt === "" ? "" : `，截至 ${timeShort(generatedAt)}`}。`,
        "运行时长：Agent 任务运行开始到结束与统计窗口的交集，包含执行和思考时间；排队和等待人工输入不计入。",
        "参会次数：统计周期内实际参与过的 live 会议去重数，同一会议多次进出只计 1 次。",
        "Token：仅统计 Agent 输出的 Token，不包含输入 Token。",
      ].join("\n");
    }

    function InstanceMetric({ liveInstances, teammateId, detailed = false }) {
      const counts = liveInstances[teammateId] ?? {};
      const title = LIVE_INSTANCES_HELP;
      const value = h(
        "span",
        { className: detailed ? "value" : "pmtm-load-value" },
        h("span", { className: "live" }, `${String(counts.ownCount ?? 0)}`),
        h(
          "span",
          { className: "owned" },
          `/${String(counts.liveCount ?? 0)}个`,
        ),
      );
      if (!detailed) {
        return h(
          "span",
          { className: "pmtm-load", title },
          value,
          h(InfoIcon, null),
        );
      }
      return h(
        "div",
        { className: "pmtm-load-card live" },
        h(
          "span",
          { className: "label" },
          "AI伙伴活跃（我的/平台）",
          h(
            "span",
            {
              className: "pmtm-info",
              tabIndex: 0,
              role: "button",
              "aria-label": "AI伙伴活跃统计说明",
              title,
            },
            h(InfoIcon, null),
            h("span", { className: "pmtm-info-pop", role: "tooltip" }, title),
          ),
        ),
        value,
      );
    }

    function LoadMetric({
      activity,
      teammateId,
      detailed = false,
      stacked = false,
      scope = "instance",
      caption = "",
      label = "近24h工作负荷",
    }) {
      const stats = activityScopeFor(activity, teammateId, scope);
      const generatedAt = activity.generatedAt || "";
      const title = loadScopeTitle(scope, generatedAt);
      const value = h(
        "span",
        { className: detailed ? "value" : "pmtm-load-value" },
        h(
          "span",
          { className: "runtime" },
          runtimeHoursText(stats.runtimeHours),
        ),
        " / ",
        h(
          "span",
          { className: "meetings" },
          `${String(stats.meetingCount ?? 0)}次`,
        ),
        " / ",
        h(
          "span",
          { className: "tokens" },
          `${outputTokensText(stats.outputTokens)} Token`,
        ),
      );
      if (stacked) {
        return h(
          "span",
          { className: "pmtm-load pmtm-load-stacked", title },
          caption === ""
            ? null
            : h("span", { className: "pmtm-load-caption" }, caption),
          h(
            "span",
            { className: "pmtm-load-value runtime" },
            runtimeHoursText(stats.runtimeHours),
          ),
          h(
            "span",
            { className: "pmtm-load-value meetings" },
            `${String(stats.meetingCount ?? 0)}次`,
          ),
          h(
            "span",
            { className: "pmtm-load-value tokens" },
            `${outputTokensText(stats.outputTokens)} Token`,
          ),
        );
      }
      if (!detailed) {
        return h(
          "span",
          { className: "pmtm-load", title },
          value,
          h(InfoIcon, null),
        );
      }
      return h(
        "div",
        { className: "pmtm-load-card" },
        h(
          "span",
          { className: "label" },
          label,
          h(
            "span",
            {
              className: "pmtm-info",
              tabIndex: 0,
              role: "button",
              "aria-label": `${label}统计说明`,
              title,
            },
            h(InfoIcon, null),
            h("span", { className: "pmtm-info-pop", role: "tooltip" }, title),
          ),
        ),
        value,
      );
    }

    function InfoIcon() {
      return h(
        "svg",
        {
          className: "pmtm-info-glyph",
          viewBox: "0 0 24 24",
          width: 11,
          height: 11,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: 12, cy: 12, r: 10 }),
        h("path", { d: "M12 16v-5" }),
        h("path", { d: "M12 8h.01" }),
      );
    }

    function CodeInfo({ label, code }) {
      if (code === undefined || code === "") return null;
      return h(
        "span",
        {
          className: "pmtm-code-info",
          tabIndex: 0,
          role: "button",
          "aria-label": `${label}代码：${code}`,
          title: code,
        },
        h(InfoIcon, null),
      );
    }

    function CodeValue({ label, value, code }) {
      return h(
        "span",
        { className: "pmtm-code-value" },
        h("span", null, value),
        h(CodeInfo, { label, code }),
      );
    }

    function markdownInline(text, keyBase) {
      const nodes = [];
      const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
      let cursor = 0;
      let match = pattern.exec(text);
      let index = 0;
      while (match !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        if (match[2] !== undefined) {
          nodes.push(h("strong", { key: `${keyBase}-b-${index}` }, match[2]));
        } else {
          nodes.push(h("code", { key: `${keyBase}-c-${index}` }, match[3]));
        }
        cursor = match.index + match[0].length;
        index += 1;
        match = pattern.exec(text);
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    /** `| a | b |` → ["a", "b"]；首尾竖线可省略。 */
    function markdownTableCells(line) {
      return line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
    }

    function isMarkdownTableSeparator(line) {
      return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(
        line ?? "",
      );
    }

    /**
     * 生效 SOUL.md：正文 + 「工作场景」「工作目标」两个章节。
     * 与服务端 runtime 的 effectiveSoul 同一口径，展示的就是实际注入给 agent 的人格。
     */
    function effectiveSoulText(source) {
      const sections = [];
      const base = String(source?.soul ?? "").trim();
      if (base !== "") sections.push(base);
      const list = (items) =>
        (Array.isArray(items) ? items : [])
          .map((item) => String(item).trim())
          .filter((item) => item !== "");
      const scenarios = list(source?.scenarios);
      if (scenarios.length > 0) {
        sections.push(
          ["## 工作场景", ...scenarios.map((item) => `- ${item}`)].join("\n"),
        );
      }
      const goals = list(source?.goals);
      if (goals.length > 0) {
        sections.push(
          ["## 工作目标", ...goals.map((item) => `- ${item}`)].join("\n"),
        );
      }
      return sections.join("\n\n");
    }

    function renderMarkdown(text) {
      if (typeof text !== "string" || text.trim() === "") {
        return h("span", null, "尚未填写。");
      }
      const lines = text.split(/\r?\n/);
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === "") {
          index += 1;
          continue;
        }
        if (line.startsWith("```")) {
          const code = [];
          index += 1;
          while (index < lines.length && !lines[index].startsWith("```")) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(
            h("pre", { key: `code-${blocks.length}` }, code.join("\n")),
          );
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading !== null) {
          const Tag = heading[1].length <= 2 ? "h4" : "h5";
          blocks.push(
            h(
              Tag,
              { key: `heading-${blocks.length}` },
              markdownInline(heading[2], `h-${blocks.length}`),
            ),
          );
          index += 1;
          continue;
        }
        // GFM 表格：表头 + |---| 分隔行 + 若干数据行。
        if (
          line.includes("|") &&
          index + 1 < lines.length &&
          isMarkdownTableSeparator(lines[index + 1])
        ) {
          const header = markdownTableCells(line);
          const rows = [];
          index += 2;
          while (
            index < lines.length &&
            lines[index].includes("|") &&
            lines[index].trim() !== ""
          ) {
            rows.push(markdownTableCells(lines[index]));
            index += 1;
          }
          const tableKey = `table-${blocks.length}`;
          blocks.push(
            h(
              "div",
              { className: "pmtm-md-table-wrap", key: tableKey },
              h(
                "table",
                { className: "pmtm-md-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    ...header.map((cell, cellIndex) =>
                      h(
                        "th",
                        { key: String(cellIndex) },
                        markdownInline(cell, `${tableKey}-th-${cellIndex}`),
                      ),
                    ),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  ...rows.map((row, rowIndex) =>
                    h(
                      "tr",
                      { key: String(rowIndex) },
                      ...header.map((_, cellIndex) =>
                        h(
                          "td",
                          { key: String(cellIndex) },
                          markdownInline(
                            row[cellIndex] ?? "",
                            `${tableKey}-td-${rowIndex}-${cellIndex}`,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }
        const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
        if (unordered !== null) {
          const items = [];
          while (index < lines.length) {
            const item = lines[index].match(/^\s*[-*+]\s+(.*)$/);
            if (item === null) break;
            items.push(item[1]);
            index += 1;
          }
          blocks.push(
            h(
              "ul",
              { key: `ul-${blocks.length}` },
              ...items.map((item, itemIndex) =>
                h(
                  "li",
                  { key: String(itemIndex) },
                  markdownInline(item, `ul-${blocks.length}-${itemIndex}`),
                ),
              ),
            ),
          );
          continue;
        }
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered !== null) {
          const items = [];
          while (index < lines.length) {
            const item = lines[index].match(/^\s*\d+[.)]\s+(.*)$/);
            if (item === null) break;
            items.push(item[1]);
            index += 1;
          }
          blocks.push(
            h(
              "ol",
              { key: `ol-${blocks.length}` },
              ...items.map((item, itemIndex) =>
                h(
                  "li",
                  { key: String(itemIndex) },
                  markdownInline(item, `ol-${blocks.length}-${itemIndex}`),
                ),
              ),
            ),
          );
          continue;
        }
        const paragraph = [line];
        index += 1;
        while (
          index < lines.length &&
          lines[index].trim() !== "" &&
          !lines[index].startsWith("```") &&
          !/^(#{1,6})\s+/.test(lines[index]) &&
          !/^\s*[-*+]\s+/.test(lines[index]) &&
          !/^\s*\d+[.)]\s+/.test(lines[index]) &&
          !(
            lines[index].includes("|") &&
            isMarkdownTableSeparator(lines[index + 1])
          )
        ) {
          paragraph.push(lines[index]);
          index += 1;
        }
        blocks.push(
          h(
            "p",
            { key: `p-${blocks.length}` },
            ...paragraph.flatMap((part, partIndex) =>
              partIndex === 0
                ? markdownInline(part, `p-${blocks.length}`)
                : [
                    " ",
                    ...markdownInline(part, `p-${blocks.length}-${partIndex}`),
                  ],
            ),
          ),
        );
      }
      return h("div", { className: "pmtm-md" }, ...blocks);
    }

    function readableEventMessage(event, teammate) {
      const match = event.message.match(/^绑定执行身份\s+(\S+)$/);
      if (match !== null) {
        return `绑定执行身份 ${teammate.name}（${match[1]}）`;
      }
      if (
        event.message.startsWith(`${event.actorName} 复原了该定义`) ||
        event.message.startsWith(`${event.actorName} 将定义设为「`)
      ) {
        return event.message.slice(event.actorName.length).trim();
      }
      return event.message;
    }

    function hairMarkup(preset) {
      const fill = preset.hair;
      if (preset.hairStyle === "bun") {
        return [
          h("circle", { key: "bun", cx: 47, cy: 14, r: 6, fill }),
          h("path", {
            key: "bun-body",
            d: "M16 29c0-12 7-19 16-19 9 0 16 7 16 19-5-3-8-8-9-12-5 7-14 11-23 12Z",
            fill,
          }),
        ];
      }
      if (preset.hairStyle === "side") {
        return [
          h("path", {
            key: "side",
            d: "M17 27c1-11 8-17 17-17 8 0 14 5 15 15-7-1-11-5-14-10-4 6-11 10-18 12Z",
            fill,
          }),
        ];
      }
      if (preset.hairStyle === "bob") {
        return [
          h("path", {
            key: "bob",
            d: "M16 28c0-12 7-18 16-18s16 7 16 18v13h-6V30c-7 1-13-1-19-6-1 5-3 8-7 10Z",
            fill,
          }),
        ];
      }
      return [
        h("path", {
          key: "wave",
          d: "M16 29c0-12 7-19 17-19 10 0 16 7 16 19-4-2-7-6-9-10-5 6-14 9-24 10Z",
          fill,
        }),
      ];
    }

    function avatarArt(value, key) {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        return h("img", {
          key,
          className: "pmtm-avatar-art",
          src: value,
          alt: "",
        });
      }
      const preset =
        AVATAR_PRESETS.find((item) => item.id === value) ?? AVATAR_PRESETS[0];
      const children = [
        h("rect", { key: "bg", width: 64, height: 64, fill: preset.bg }),
        h("circle", {
          key: "a1",
          cx: 52,
          cy: 12,
          r: 10,
          fill: preset.accent,
          opacity: 0.28,
        }),
        h("circle", {
          key: "a2",
          cx: 10,
          cy: 52,
          r: 14,
          fill: preset.accent,
          opacity: 0.18,
        }),
        h("rect", {
          key: "neck",
          x: 28,
          y: 39,
          width: 8,
          height: 11,
          rx: 4,
          fill: preset.skin,
        }),
        h("path", {
          key: "shirt",
          d: "M9 64c2-13 11-20 23-20s21 7 23 20Z",
          fill: preset.shirt,
        }),
        h("circle", { key: "ear-l", cx: 18, cy: 30, r: 4, fill: preset.skin }),
        h("circle", { key: "ear-r", cx: 46, cy: 30, r: 4, fill: preset.skin }),
        h("circle", { key: "face", cx: 32, cy: 29, r: 16, fill: preset.skin }),
        ...hairMarkup(preset),
        h("circle", {
          key: "eye-l",
          cx: 25.5,
          cy: 31,
          r: 1.8,
          fill: "#20232a",
        }),
        h("circle", {
          key: "eye-r",
          cx: 38.5,
          cy: 31,
          r: 1.8,
          fill: "#20232a",
        }),
        h("path", {
          key: "mouth",
          d: "M27 38c3 3 7 3 10 0",
          fill: "none",
          stroke: "#9a5c52",
          strokeWidth: 1.8,
          strokeLinecap: "round",
        }),
      ];
      if (preset.glasses) {
        children.push(
          h(
            "g",
            {
              key: "glasses",
              fill: "none",
              stroke: preset.hair,
              strokeWidth: 1.8,
            },
            [
              h("circle", { key: "g1", cx: 25.5, cy: 31, r: 4 }),
              h("circle", { key: "g2", cx: 38.5, cy: 31, r: 4 }),
              h("path", { key: "g3", d: "M29.5 31h5" }),
            ],
          ),
        );
      }
      children.push(
        h("circle", {
          key: "shine",
          cx: 42,
          cy: 24,
          r: 3,
          fill: "#fff",
          opacity: 0.2,
        }),
      );
      return h(
        "svg",
        {
          key,
          className: "pmtm-avatar-art",
          viewBox: "0 0 64 64",
          "aria-hidden": "true",
        },
        children,
      );
    }

    function TeammateAvatar({ teammate, className, label }) {
      return h(
        "span",
        {
          className: `pmtm-avatar ${teammate.source} ${className ?? ""}`,
          role: "img",
          "aria-label": label ?? `${teammate.name} 的头像`,
          title: label ?? teammate.name,
        },
        avatarArt(teammate.avatar, "art"),
      );
    }

    function LatestProgressText({ task, expanded, onToggle }) {
      const textRef = react.useRef(null);
      const [overflowing, setOverflowing] = react.useState(false);

      react.useLayoutEffect(() => {
        const element = textRef.current;
        if (element === null) return undefined;
        const measure = () => {
          if (!expanded) {
            setOverflowing(element.scrollHeight > element.clientHeight + 1);
          }
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
          window.addEventListener("resize", measure);
          return () => window.removeEventListener("resize", measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [task.latestProgress, expanded]);

      return h(
        react.Fragment,
        null,
        h(
          "div",
          {
            ref: textRef,
            className: `text pmtm-md${expanded ? " expanded" : ""}`,
          },
          renderMarkdown(task.latestProgress || "暂无说明。"),
        ),
        overflowing
          ? h(
              "button",
              {
                type: "button",
                className: "pmtm-latest-toggle",
                onClick: onToggle,
                "aria-expanded": expanded,
              },
              expanded ? "折叠" : "展开",
            )
          : null,
      );
    }

    /*
     * 字段说明气泡按视口自适应：默认贴在图标上方，
     * 上方空间不够就翻到下方，左右始终收在可视范围内，避免被窗口裁掉。
     */
    const INFO_POP_MARGIN = 8;

    function positionInfoPop(host, pop) {
      if (host === null || pop === null) return;
      const anchor = host.getBoundingClientRect();
      const width = pop.offsetWidth;
      const height = pop.offsetHeight;
      if (width === 0 || height === 0) return;
      const maxLeft = Math.max(
        INFO_POP_MARGIN,
        window.innerWidth - INFO_POP_MARGIN - width,
      );
      // 默认右缘对齐图标右侧，再整体收进视口。
      const left = Math.min(
        Math.max(INFO_POP_MARGIN, anchor.right + 6 - width),
        maxLeft,
      );
      let top = anchor.top - INFO_POP_MARGIN - height;
      if (top < INFO_POP_MARGIN) top = anchor.bottom + INFO_POP_MARGIN;
      const maxTop = Math.max(
        INFO_POP_MARGIN,
        window.innerHeight - INFO_POP_MARGIN - height,
      );
      top = Math.min(Math.max(INFO_POP_MARGIN, top), maxTop);
      pop.style.left = `${String(Math.round(left))}px`;
      pop.style.top = `${String(Math.round(top))}px`;
    }

    function installInfoPopPositioning() {
      const place = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const host = target.closest(".pmtm-info");
        if (host === null) return;
        positionInfoPop(host, host.querySelector(".pmtm-info-pop"));
      };
      const reposition = () => {
        for (const host of document.querySelectorAll(
          ".pmtm-info:hover, .pmtm-info:focus-visible",
        )) {
          positionInfoPop(host, host.querySelector(".pmtm-info-pop"));
        }
      };
      document.addEventListener("mouseover", place, true);
      document.addEventListener("focusin", place, true);
      document.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition);
      return () => {
        document.removeEventListener("mouseover", place, true);
        document.removeEventListener("focusin", place, true);
        document.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
      };
    }

    function MeetingPanelToggle() {
      const meetingOpen = react.useSyncExternalStore(
        (listener) =>
          window.__pluginmaxMeeting?.subscribe(() =>
            listener(Boolean(window.__pluginmaxMeeting.open)),
          ) ?? (() => {}),
        () => Boolean(window.__pluginmaxMeeting?.open),
      );
      return h(
        "button",
        {
          className: `pmtm-meeting-toggle${meetingOpen ? " active" : ""}`,
          type: "button",
          "aria-label": meetingOpen ? "收起会议侧边栏" : "展开会议侧边栏",
          "aria-pressed": meetingOpen,
          title: meetingOpen ? "收起会议侧边栏" : "展开会议侧边栏",
          onClick: () => window.__pluginmaxMeeting?.toggle(),
        },
        h(
          "svg",
          {
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": true,
          },
          h("path", { d: "m22 8-6 4 6 4V8Z" }),
          h("rect", { x: 2, y: 6, width: 14, height: 12, rx: 2 }),
        ),
      );
    }

    function AiTeammatesPage() {
      const [teammates, setTeammates] = react.useState([]);
      const [canManagePlatform, setCanManagePlatform] = react.useState(false);
      const [teammateTemplates, setTeammateTemplates] = react.useState([]);
      const [definitionTemplateId, setDefinitionTemplateId] =
        react.useState("");
      const [switchTemplateId, setSwitchTemplateId] = react.useState("");
      const [externalRuntimes, setExternalRuntimes] = react.useState([]);
      const [canManageExternal, setCanManageExternal] = react.useState(false);
      const [externalWorkspaceId, setExternalWorkspaceId] = react.useState("");
      const [externalEpoch, setExternalEpoch] = react.useState(0);
      const [workspaces, setWorkspaces] = react.useState([]);
      const [externalEditing, setExternalEditing] = react.useState(false);
      const [externalForm, setExternalForm] = react.useState(null);
      const [externalSelectedId, setExternalSelectedId] = react.useState("");
      const [externalBusy, setExternalBusy] = react.useState(false);
      /** 外部 Agent 归档视图开关：默认列表隐藏归档项，与 AI伙伴模版一致。 */
      const [externalArchivedOnly, setExternalArchivedOnly] =
        react.useState(false);
      const [externalArchiveTarget, setExternalArchiveTarget] =
        react.useState(null);
      const [runningIds, setRunningIds] = react.useState([]);
      const [archivedOnly, setArchivedOnly] = react.useState(false);
      const archivedOnlyRef = react.useRef(false);
      /**
       * 管理员全量视图开关：默认关闭，普通视图只看自己的 + 平台实例。
       * 状态来自跨模块共享 store，跳转前后保持同一选择。
       */
      const scopeAll = react.useSyncExternalStore(
        scopeStore.subscribe,
        scopeStore.getSnapshot,
        scopeStore.getSnapshot,
      );
      const scopeAllRef = react.useRef(scopeAll);
      react.useEffect(() => {
        scopeAllRef.current = scopeAll;
      }, [scopeAll]);
      /**
       * 运行态"新建实例"：实例只能基于已有模版创建，模版的增删改属于定义态，
       * 因此运行态只提供"选模版 + 命名"这一个入口。
       */
      const [createInstanceOpen, setCreateInstanceOpen] = react.useState(false);
      const [createInstanceTemplateId, setCreateInstanceTemplateId] =
        react.useState("");
      const [createInstanceName, setCreateInstanceName] = react.useState("");
      const [createInstanceWorkspaceId, setCreateInstanceWorkspaceId] =
        react.useState("");
      const backgroundRefresh = react.useRef(false);
      const [archiveOpen, setArchiveOpen] = react.useState(false);
      const [activity, setActivity] = react.useState({
        generatedAt: "",
        items: [],
      });
      const [liveInstances, setLiveInstances] = react.useState({});
      const [identity, setIdentity] = react.useState(null);
      const [assignOpen, setAssignOpen] = react.useState(false);
      const [assignTasks, setAssignTasks] = react.useState([]);
      const [assignQuery, setAssignQuery] = react.useState("");
      const [assignStatus, setAssignStatus] = react.useState("");
      const [assignPriority, setAssignPriority] = react.useState("");
      const [assignProject, setAssignProject] = react.useState("");
      const [assignSelected, setAssignSelected] = react.useState([]);
      const [assignBusy, setAssignBusy] = react.useState(false);
      const [assignCreateOpen, setAssignCreateOpen] = react.useState(false);
      const [assignCreateForm, setAssignCreateForm] = react.useState(null);
      const [expandedProgressIds, setExpandedProgressIds] = react.useState([]);
      const [expandedRunIds, setExpandedRunIds] = react.useState([]);
      const [selectedId, setSelectedId] = react.useState("");
      const [detail, setDetail] = react.useState(null);
      const [events, setEvents] = react.useState([]);
      const [runtimeTasks, setRuntimeTasks] = react.useState([]);
      const [queue, setQueue] = react.useState(null);
      const [queueBusy, setQueueBusy] = react.useState(false);
      const [rejectingId, setRejectingId] = react.useState("");
      const [rejectNote, setRejectNote] = react.useState("");
      const [tab, setTab] = react.useState("runtime");
      const [runtimeTab, setRuntimeTab] = react.useState("current");
      const [currentUser, setCurrentUser] = react.useState(null);
      const [workReports, setWorkReports] = react.useState([]);
      const [workReportsLoading, setWorkReportsLoading] = react.useState(false);
      const [workReportGenerating, setWorkReportGenerating] =
        react.useState(false);
      const [reportNotice, setReportNotice] = react.useState("");
      const [reportRange, setReportRange] = react.useState(defaultReportRange);
      const [reportSearch, setReportSearch] = react.useState("");
      const [reportQuery, setReportQuery] = react.useState("");
      const [auditEvents, setAuditEvents] = react.useState([]);
      const [auditCursor, setAuditCursor] = react.useState("");
      const [auditLoading, setAuditLoading] = react.useState(false);
      const [editing, setEditing] = react.useState(false);
      const [form, setForm] = react.useState(null);
      const [instanceEditing, setInstanceEditing] = react.useState(false);
      const [instanceForm, setInstanceForm] = react.useState({
        name: "",
        description: "",
      });
      const [instanceBusy, setInstanceBusy] = react.useState(false);
      const [projectRoles, setProjectRoles] = react.useState([]);
      const [projectRolesLoading, setProjectRolesLoading] =
        react.useState(false);
      const [projectRoleBusy, setProjectRoleBusy] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [loading, setLoading] = react.useState(true);

      react.useEffect(() => installInfoPopPositioning(), []);

      const fail = (cause) => {
        // 后台轮询失败不弹全局错误条，避免服务重启后留下残留提示。
        if (backgroundRefresh.current) return;
        setNotice("");
        setError(cause instanceof Error ? cause.message : String(cause));
      };
      const succeed = (message) => {
        setError("");
        setNotice(message);
      };
      const setArchivedView = (next) => {
        archivedOnlyRef.current = next;
        setArchivedOnly(next);
        if (tab === "definition") {
          // 定义态列表跟随归档视图：把选中模版切到对应集合，
          // 否则右侧详情会停在另一侧的模版上，和列表对不上。
          const pool = teammateTemplates.filter((item) =>
            next ? item.state === "archived" : item.state !== "archived",
          );
          if (!pool.some((item) => item.id === definitionTemplateId)) {
            setDefinitionTemplateId(pool[0]?.id ?? "");
          }
        }
      };
      /** 管理员全量视图：切换后重新拉取实例列表。 */
      const setScopeView = (next) => {
        scopeAllRef.current = next;
        scopeStore.setAll(next);
        void loadList();
      };

      const loadList = react.useCallback(async (targetId) => {
        if (token() === null) {
          setError("请先在「账号与权限 → 登录账号」中登录。");
          setLoading(false);
          return;
        }
        try {
          setLoading(true);
          const result = await request(
            `/api/collab/teammates${scopeAllRef.current ? "?scope=all" : ""}`,
          );
          const list = result.teammates ?? [];
          setTeammates(list);
          setCanManagePlatform(result.canManagePlatform === true);
          setRunningIds(result.runningTeammateIds ?? []);
          setLiveInstances(result.liveInstanceCounts ?? {});
          setSelectedId((current) => {
            const candidates = archivedOnlyRef.current
              ? list.filter((item) => item.state === "archived")
              : list.filter((item) => item.state !== "archived");
            if (
              targetId !== undefined &&
              candidates.some((item) => item.id === targetId)
            ) {
              return targetId;
            }
            if (candidates.some((item) => item.id === current)) {
              return current;
            }
            const personal = candidates.find(
              (item) => item.source === "personal",
            );
            return (personal ?? candidates[0])?.id ?? "";
          });
          setError("");
        } catch (cause) {
          fail(cause);
        } finally {
          setLoading(false);
        }
      }, []);

      const loadDetail = react.useCallback(async (teammateId) => {
        if (teammateId === "") {
          setDetail(null);
          setEvents([]);
          return;
        }
        try {
          const result = await request(
            `/api/collab/teammates/detail?teammateId=${encodeURIComponent(teammateId)}`,
          );
          setDetail(result.teammate ?? null);
          setEvents(result.events ?? []);
        } catch (cause) {
          fail(cause);
        }
      }, []);

      const loadRuntime = react.useCallback(async (teammateId) => {
        if (teammateId === "") {
          setRuntimeTasks([]);
          return;
        }
        try {
          const result = await request(
            `/api/collab/teammates/runtime?teammateId=${encodeURIComponent(teammateId)}`,
          );
          setRuntimeTasks(result.tasks ?? []);
        } catch (cause) {
          fail(cause);
        }
      }, []);

      const loadQueue = react.useCallback(async (teammateId) => {
        if (teammateId === "") {
          setQueue(null);
          return;
        }
        try {
          const result = await request(
            `/api/collab/teammates/work-queue?teammateId=${encodeURIComponent(teammateId)}`,
          );
          setQueue(result.queue ?? null);
        } catch (cause) {
          fail(cause);
        }
      }, []);

      /** 角色权限：读取实例绑定员工档案上的工作区角色授权。 */
      const loadProjectRoles = react.useCallback(async (teammate) => {
        const employeeId = teammate?.employeeId ?? "";
        if (employeeId === "") {
          setProjectRoles([]);
          return;
        }
        try {
          setProjectRolesLoading(true);
          const result = await request(
            `/api/collab/employee/roles?employeeId=${encodeURIComponent(employeeId)}`,
          );
          setProjectRoles(result.roles ?? []);
        } catch (cause) {
          fail(cause);
        } finally {
          setProjectRolesLoading(false);
        }
      }, []);

      const loadWorkReports = react.useCallback(
        async (teammateId, range, query) => {
          if (teammateId === "") {
            setWorkReports([]);
            return;
          }
          try {
            setWorkReportsLoading(true);
            const params = new URLSearchParams({ teammateId });
            if (range.from !== "") params.set("from", range.from);
            if (range.to !== "") params.set("to", range.to);
            if (query !== "") params.set("q", query);
            const result = await request(
              `/api/collab/teammates/work-reports?${params.toString()}`,
            );
            setWorkReports(result.reports ?? []);
          } catch (cause) {
            fail(cause);
          } finally {
            setWorkReportsLoading(false);
          }
        },
        [],
      );

      const loadAuditEvents = react.useCallback(
        async (teammateId, cursor = "") => {
          if (teammateId === "") {
            setAuditEvents([]);
            setAuditCursor("");
            return;
          }
          try {
            setAuditLoading(true);
            const params = new URLSearchParams({
              teammateId,
              limit: "30",
            });
            if (cursor !== "") params.set("cursor", cursor);
            const [eventResult, auditResult] = await Promise.all([
              cursor === ""
                ? request(
                    `/api/collab/teammates/detail?teammateId=${encodeURIComponent(teammateId)}`,
                  )
                : Promise.resolve({ events: [] }),
              request(
                `/api/collab/teammates/audit-events?${params.toString()}`,
              ),
            ]);
            const teammateEvents = (eventResult.events ?? []).map((event) => ({
              id: event.id,
              at: new Date(event.at).toISOString(),
              actorName: event.actorName,
              actorType: "user",
              narrative: readableEventMessage(event, eventResult.teammate),
            }));
            const auditRows = (auditResult.events ?? []).map((event) => ({
              id: event.id,
              at: new Date(event.occurredAt).toISOString(),
              actorName: event.actor?.name ?? "系统",
              actorType: event.actor?.type ?? "system",
              narrative: event.narrative,
            }));
            const merged = [...teammateEvents, ...auditRows].sort(
              (left, right) =>
                right.at.localeCompare(left.at) ||
                right.id.localeCompare(left.id),
            );
            setAuditEvents((current) =>
              cursor === "" ? merged : [...current, ...merged],
            );
            setAuditCursor(auditResult.nextCursor ?? "");
          } catch (cause) {
            fail(cause);
          } finally {
            setAuditLoading(false);
          }
        },
        [],
      );

      const loadActivity = react.useCallback(async () => {
        if (token() === null) return;
        try {
          const result = await request("/api/collab/teammates/activity");
          setActivity({
            generatedAt:
              typeof result.generatedAt === "string" ? result.generatedAt : "",
            items: result.items ?? [],
          });
        } catch {
          // 负荷指标失败时保持页面主体可用，下一次轮询会继续重试。
        }
      }, []);

      const loadIdentity = react.useCallback(async (teammateId) => {
        if (teammateId === "") {
          setIdentity(null);
          return;
        }
        try {
          const result = await request(
            `/api/collab/teammates/identity?teammateId=${encodeURIComponent(teammateId)}`,
          );
          setIdentity(result.identity ?? null);
        } catch {
          setIdentity(null);
        }
      }, []);

      const loadTeammateTemplates = react.useCallback(async (targetId) => {
        if (token() === null) return;
        try {
          const result = await request("/api/collab/teammate-templates");
          const list = result.templates ?? [];
          setTeammateTemplates(list);
          setDefinitionTemplateId((current) => {
            if (
              targetId !== undefined &&
              list.some((item) => item.id === targetId)
            ) {
              return targetId;
            }
            // 默认选择落在当前归档视图对应的模版集合里。
            const pool = list.filter((item) =>
              archivedOnlyRef.current
                ? item.state === "archived"
                : item.state !== "archived",
            );
            if (pool.some((item) => item.id === current)) return current;
            return pool[0]?.id ?? "";
          });
        } catch (cause) {
          fail(cause);
        }
      }, []);

      const loadExternalRuntimes = react.useCallback(async (workspaceId) => {
        if (token() === null || workspaceId === "") return;
        try {
          const result = await request(
            `/api/collab/agent/external-runtimes?workspaceId=${encodeURIComponent(workspaceId)}&includeArchived=1`,
          );
          setExternalRuntimes(result.runtimes ?? []);
          setCanManageExternal(result.canManage === true);
        } catch (cause) {
          fail(cause);
        }
      }, []);

      react.useEffect(() => {
        void loadList();
        void loadTeammateTemplates();
        void loadActivity();
      }, [loadList, loadTeammateTemplates, loadActivity]);

      react.useEffect(() => {
        if (token() === null) return;
        let cancelled = false;
        void (async () => {
          try {
            const result = await request("/api/collab/auth/me");
            if (!cancelled) {
              setCurrentUser(result.user ?? null);
            }
          } catch {
            // 权限判断会回落到“无权限”展示，主体功能不受影响。
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      react.useEffect(() => {
        if (token() === null) return;
        let cancelled = false;
        void (async () => {
          try {
            const result = await request("/api/collab/team/workspaces");
            if (!cancelled) setWorkspaces(result.workspaces ?? []);
          } catch {
            // ID fallback is sufficient when workspace titles cannot be loaded.
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      // 从任务详情返回时恢复到原来的 AI伙伴与页签。
      react.useEffect(() => {
        const pending = window.__pluginmaxPendingTeammate;
        if (pending === null || typeof pending !== "object") return;
        window.__pluginmaxPendingTeammate = null;
        if (
          typeof pending.teammateId === "string" &&
          pending.teammateId !== ""
        ) {
          setSelectedId(pending.teammateId);
        }
        if (pending.tab === "definition" || pending.tab === "runtime") {
          setTab(pending.tab);
        }
        if (
          ["current", "plan", "report", "audit"].includes(
            pending.returnRuntimeTab,
          )
        ) {
          setRuntimeTab(pending.returnRuntimeTab);
        }
        setEditing(false);
        setForm(null);
      }, []);

      // 目录里的运行中转圈需要保持实时，所以列表也定期刷新。
      react.useEffect(() => {
        const timer = window.setInterval(() => {
          backgroundRefresh.current = true;
          void loadList().finally(() => {
            backgroundRefresh.current = false;
          });
        }, 8_000);
        return () => window.clearInterval(timer);
      }, [loadList]);

      react.useEffect(() => {
        const timer = window.setInterval(() => void loadActivity(), 30_000);
        return () => window.clearInterval(timer);
      }, [loadActivity]);

      react.useEffect(() => {
        void loadDetail(selectedId);
        void loadIdentity(selectedId);
        if (tab === "runtime") void loadRuntime(selectedId);
      }, [selectedId, tab, loadDetail, loadIdentity, loadRuntime]);

      react.useEffect(() => {
        setWorkReports([]);
        setAuditEvents([]);
        setAuditCursor("");
        setQueue(null);
        setRejectingId("");
        setRejectNote("");
      }, [selectedId]);

      react.useEffect(() => {
        if (tab !== "runtime" || runtimeTab !== "plan") return;
        void loadQueue(selectedId);
      }, [tab, runtimeTab, selectedId, loadQueue]);

      react.useEffect(() => {
        if (tab !== "runtime" || runtimeTab !== "roles") return undefined;
        void loadProjectRoles(detail);
        // 项目标题随角色一起刷新，拿不到标题时回落到项目 ID。
        void (async () => {
          try {
            const result = await request("/api/collab/team/workspaces");
            setWorkspaces(result.workspaces ?? []);
          } catch {
            // 标题加载失败不影响角色列表。
          }
        })();
        return undefined;
      }, [tab, runtimeTab, detail, loadProjectRoles]);

      react.useEffect(() => {
        if (tab !== "runtime" || runtimeTab !== "report") return undefined;
        const timer = window.setTimeout(
          () => void loadWorkReports(selectedId, reportRange, reportQuery),
          260,
        );
        return () => window.clearTimeout(timer);
      }, [
        tab,
        runtimeTab,
        selectedId,
        reportRange,
        reportQuery,
        loadWorkReports,
      ]);

      react.useEffect(() => {
        const timer = window.setTimeout(
          () => setReportQuery(reportSearch),
          320,
        );
        return () => window.clearTimeout(timer);
      }, [reportSearch]);

      // 日报更新反馈就近显示在工作日报标题下方，3 秒后自动收起。
      react.useEffect(() => {
        if (reportNotice === "") return undefined;
        const timer = window.setTimeout(() => setReportNotice(""), 3_000);
        return () => window.clearTimeout(timer);
      }, [reportNotice]);

      // 错误条自动收起，避免网络抖动后残留一条过期提示。
      react.useEffect(() => {
        if (error === "") return undefined;
        const timer = window.setTimeout(() => setError(""), 3_000);
        return () => window.clearTimeout(timer);
      }, [error]);

      // 顶部状态反馈（如「已归档」「默认已生效」）3 秒后自动收起。
      react.useEffect(() => {
        if (notice === "") return undefined;
        const timer = window.setTimeout(() => setNotice(""), 3_000);
        return () => window.clearTimeout(timer);
      }, [notice]);

      react.useEffect(() => {
        if (tab !== "runtime" || runtimeTab !== "audit") return;
        if (auditEvents.length > 0 || auditLoading) return;
        void loadAuditEvents(selectedId);
      }, [
        tab,
        runtimeTab,
        selectedId,
        auditEvents.length,
        auditLoading,
        loadAuditEvents,
      ]);

      react.useEffect(() => {
        if (externalWorkspaceId !== "") {
          void loadExternalRuntimes(externalWorkspaceId);
          return;
        }
        let cancelled = false;
        void (async () => {
          try {
            const result = await request("/api/collab/team/workspaces");
            const list = result.workspaces ?? [];
            const isMember = (id) =>
              list.some((item) => item.id === id && item.isMember === true);
            // 优先沿用实例身份所在项目，但必须是当前用户已加入的项目；
            // 否则无项目账号会拿到一个不可访问的 workspaceId，显示错误的空状态。
            if (
              identity?.workspaceId !== undefined &&
              isMember(identity.workspaceId)
            ) {
              setExternalWorkspaceId(identity.workspaceId);
              return;
            }
            const memberWorkspace = list.find((item) => item.isMember === true);
            if (!cancelled && memberWorkspace?.id !== undefined) {
              setExternalWorkspaceId(memberWorkspace.id);
            }
          } catch {
            // The runtime manager will show an empty state without a workspace.
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [identity, externalWorkspaceId, externalEpoch, loadExternalRuntimes]);

      // 切换登录账号后会带走旧的外部 Agent 管理状态，这里显式重置，
      // 避免上一位管理员的权限/列表泄漏到下一位只读用户。
      react.useEffect(() => {
        const reset = () => {
          setExternalWorkspaceId("");
          setExternalRuntimes([]);
          setCanManageExternal(false);
          setExternalEditing(false);
          setExternalForm(null);
          // 账号切换时强制重新解析工作区，即使 workspaceId 已是空串。
          setExternalEpoch((current) => current + 1);
        };
        window.addEventListener("pluginmax:collab-token", reset);
        return () =>
          window.removeEventListener("pluginmax:collab-token", reset);
      }, []);

      const selected =
        detail ?? teammates.find((item) => item.id === selectedId) ?? null;
      const selectedTemplate =
        teammateTemplates.find((item) => item.id === definitionTemplateId) ??
        // 定义态严格跟随列表（definitionTemplateId）；运行态才回退到
        // 当前实例所属的模版，避免详情显示列表里没有的模版。
        (tab === "runtime"
          ? teammateTemplates.find(
              (item) => selected !== null && item.id === selected.templateId,
            )
          : undefined) ??
        null;
      const selectedTemplateInstances = teammates.filter(
        (item) =>
          selectedTemplate !== null && item.templateId === selectedTemplate.id,
      );
      const canManageSelectedTemplate =
        selectedTemplate !== null &&
        (selectedTemplate.source === "platform"
          ? canManagePlatform
          : selectedTemplate.ownerUserId === currentUser?.id);

      react.useEffect(() => {
        const available = teammateTemplates.filter(
          (item) => item.state !== "archived",
        );
        setSwitchTemplateId((current) => {
          if (available.some((item) => item.id === current)) return current;
          return selected?.templateId ?? available[0]?.id ?? "";
        });
      }, [selected?.id, selected?.templateId, teammateTemplates]);

      const archivedTeammates = teammates.filter(
        (item) => item.state === "archived",
      );
      const visibleTeammates = archivedOnly
        ? archivedTeammates
        : teammates.filter((item) => item.state !== "archived");

      react.useEffect(() => {
        if (visibleTeammates.some((item) => item.id === selectedId)) return;
        setSelectedId(visibleTeammates[0]?.id ?? "");
      }, [archivedOnly, teammates, selectedId]);

      const selectTeammate = (teammateId) => {
        setSelectedId(teammateId);
        setEditing(false);
        setForm(null);
        setInstanceEditing(false);
        setError("");
        setNotice("");
      };

      const selectTeammateTemplate = (templateId) => {
        setDefinitionTemplateId(templateId);
        const representative = teammates.find(
          (item) => item.templateId === templateId,
        );
        if (representative !== undefined) setSelectedId(representative.id);
        setEditing(false);
        setForm(null);
        setInstanceEditing(false);
        setError("");
        setNotice("");
      };

      const openDefinitionForTeammate = (teammate) => {
        setDefinitionTemplateId(
          teammate?.templateId ?? teammateTemplates[0]?.id ?? "",
        );
        setTab("definition");
        setEditing(false);
        setForm(null);
        setInstanceEditing(false);
        setError("");
        setNotice("");
      };

      /*
       * 定义态：只创建模版本身（草稿状态），随后直接进入模版编辑。
       * 这里不再连带创建实例——实例一律由运行态的「新建实例」显式创建，
       * 否则只想要模版的人会在运行态凭空多出「未命名 AI伙伴」实例。
       */
      const createTeammate = async (source) => {
        try {
          setBusy(true);
          const used = new Set(
            teammateTemplates
              .filter((item) => item.source === source)
              .map((item) => item.name.toLowerCase()),
          );
          const base = "未命名 AI伙伴";
          let name = base;
          for (let index = 2; used.has(name.toLowerCase()); index += 1) {
            name = `${base} (${String(index)})`;
          }
          const created = await request(
            "/api/collab/teammate-templates/create",
            {
              method: "POST",
              body: { source, name, active: false },
            },
          );
          await loadTeammateTemplates(created.template.id);
          setDefinitionTemplateId(created.template.id);
          setEditing(true);
          setForm({
            name: created.template.name,
            role: created.template.role,
            description: created.template.description,
            soul: effectiveSoulText(created.template),
            tools: created.template.tools.join("\n"),
          });
          succeed(
            source === "platform"
              ? "已创建平台模版草稿，保存后生效；需要 AI伙伴时请在「AI伙伴管理」里新建。"
              : "已创建个人模版草稿，保存后生效；需要 AI伙伴时请在「AI伙伴管理」里新建。",
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const switchTemplate = async () => {
        if (selected === null || switchTemplateId === "") return;
        try {
          setBusy(true);
          await request("/api/collab/teammates/switch-template", {
            method: "POST",
            body: { teammateId: selected.id, templateId: switchTemplateId },
          });
          await Promise.all([loadList(selected.id), loadDetail(selected.id)]);
          succeed("已切换 AI伙伴引用的模版。");
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const emptyExternalForm = () => ({
        name: "Codex CLI 本机",
        provider: "codex",
        protocol: "codex-jsonl",
        command: "codex",
        modelMode: "default",
        model: "",
        supportedModels: [],
        defaultModel: "",
        contextWindowTokens: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
        modelDraft: "",
        supportedTools: [],
        searchEnabled: false,
        permissionMode: "default",
        maxTurns: "",
        customArgs: [],
        customArgsText: "",
        advancedOpen: false,
        advancedArgs: [],
      });

      const startExternalCreate = () => {
        setExternalArchivedOnly(false);
        setExternalEditing(true);
        setExternalForm(emptyExternalForm());
      };

      const startExternalEdit = (runtime) => {
        const launch = parseExternalRuntimeArgs(runtime.provider, runtime.args);
        const supportedModels =
          Array.isArray(runtime.supportedModels) &&
          runtime.supportedModels.length > 0
            ? runtime.supportedModels
            : launch.model === ""
              ? []
              : [launch.model];
        const supportedTools =
          Array.isArray(runtime.supportedTools) &&
          runtime.supportedTools.length > 0
            ? runtime.supportedTools
            : launch.searchEnabled
              ? ["web_search"]
              : [];
        const customArgs =
          runtime.customArgs ?? advancedArgsFromRows(launch.advancedArgs);
        setExternalArchivedOnly(false);
        setExternalEditing(true);
        setExternalForm({
          runtimeId: runtime.id,
          name: runtime.name,
          provider: runtime.provider,
          protocol: runtime.protocol,
          command: runtime.command,
          ...launch,
          supportedModels,
          defaultModel: runtime.defaultModel ?? launch.model,
          contextWindowTokens: String(
            runtime.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
          ),
          modelDraft: "",
          supportedTools,
          customArgs,
          customArgsText: formatExternalArgsText(customArgs),
          advancedOpen: customArgs.length > 0,
        });
      };

      const changeExternalProvider = (provider) => {
        setExternalForm((current) =>
          current === null
            ? current
            : {
                ...current,
                provider,
                protocol: provider === "codex" ? "codex-jsonl" : "plain-text",
                modelMode: "default",
                model: "",
                supportedModels: [],
                defaultModel: "",
                contextWindowTokens: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
                modelDraft: "",
                supportedTools: [],
                searchEnabled: false,
                permissionMode: "default",
                maxTurns: "",
                customArgs: [],
                customArgsText: "",
                advancedOpen: false,
                advancedArgs: [],
                ...(current.runtimeId !== undefined
                  ? {}
                  : {
                      name:
                        current.name === "" ||
                        current.name.startsWith("外部 Agent")
                          ? provider === "codex"
                            ? "Codex CLI 本机"
                            : provider === "workbuddy"
                              ? "CodeBuddy CLI 本机"
                              : "自定义 Agent 命令"
                          : current.name,
                      command:
                        current.command === "" ||
                        [
                          "codex",
                          "workbuddy",
                          "/usr/local/bin/custom-agent",
                        ].includes(current.command)
                          ? provider === "codex"
                            ? "codex"
                            : provider === "workbuddy"
                              ? "workbuddy"
                              : "/usr/local/bin/custom-agent"
                          : current.command,
                    }),
              },
        );
      };

      const saveExternalRuntime = async () => {
        if (externalForm === null) return;
        try {
          setExternalBusy(true);
          const formError = externalRuntimeFormError(externalForm);
          if (formError !== "") throw new Error(formError);
          const args = compileExternalRuntimeArgs(externalForm);
          const customArgs = externalCustomArgs(externalForm);
          const defaultModel = String(externalForm.defaultModel ?? "").trim();
          const contextWindowTokens = Number(
            String(
              externalForm.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
            ).trim() || DEFAULT_CONTEXT_WINDOW_TOKENS,
          );
          const definition = {
            name: externalForm.name,
            provider: externalForm.provider,
            protocol: externalForm.protocol,
            command: externalForm.command,
            args,
            customArgs,
            supportedTools: externalForm.supportedTools ?? [],
            supportedModels: externalForm.supportedModels ?? [],
            contextWindowTokens,
            ...(defaultModel === "" ? {} : { defaultModel }),
          };
          const result =
            externalForm.runtimeId === undefined
              ? await request("/api/collab/agent/external-runtimes/create", {
                  method: "POST",
                  body: {
                    workspaceId: externalWorkspaceId,
                    ...definition,
                  },
                })
              : await request("/api/collab/agent/external-runtimes/update", {
                  method: "POST",
                  body: {
                    workspaceId: externalWorkspaceId,
                    runtimeId: externalForm.runtimeId,
                    ...(defaultModel === "" ? { defaultModel: null } : {}),
                    ...definition,
                  },
                });
          setExternalEditing(false);
          setExternalForm(null);
          await Promise.all([
            loadExternalRuntimes(externalWorkspaceId),
            loadList(),
          ]);
          const pausedCount = result.pausedTeammateIds?.length ?? 0;
          succeed(
            externalForm.runtimeId === undefined
              ? `已注册外部 Agent：${result.runtime.name}`
              : pausedCount > 0
                ? `已更新外部 Agent：${result.runtime.name}，${pausedCount} 个绑定的 AI伙伴已暂停`
                : `已更新外部 Agent：${result.runtime.name}`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setExternalBusy(false);
        }
      };

      const changeExternalState = async (runtime, status) => {
        try {
          setExternalBusy(true);
          const result = await request(
            "/api/collab/agent/external-runtimes/update",
            {
              method: "POST",
              body: {
                workspaceId: externalWorkspaceId,
                runtimeId: runtime.id,
                status,
              },
            },
          );
          await Promise.all([
            loadExternalRuntimes(externalWorkspaceId),
            loadList(),
          ]);
          const pausedCount = result.pausedTeammateIds?.length ?? 0;
          succeed(
            status === "active"
              ? `外部 Agent「${runtime.name}」已启用。`
              : `外部 Agent「${runtime.name}」已停用${pausedCount > 0 ? `，${pausedCount} 个绑定的 AI伙伴已暂停` : ""}。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setExternalBusy(false);
        }
      };

      /** 归档影响面：仍绑定该运行时、且未归档的 AI伙伴数量。 */
      const externalRuntimeBindingCount = (runtime) =>
        teammates.filter(
          (item) =>
            (item.execution ?? "builtin") === "external" &&
            item.externalRuntimeId === runtime.id &&
            item.state !== "archived",
        ).length;

      const archiveExternalRuntime = async () => {
        const runtime = externalArchiveTarget;
        if (runtime === null) return;
        try {
          setExternalBusy(true);
          const result = await request(
            "/api/collab/agent/external-runtimes/archive",
            {
              method: "POST",
              body: { workspaceId: externalWorkspaceId, runtimeId: runtime.id },
            },
          );
          setExternalArchiveTarget(null);
          await Promise.all([
            loadExternalRuntimes(externalWorkspaceId),
            loadList(),
          ]);
          const pausedCount = result.pausedTeammateIds?.length ?? 0;
          succeed(
            pausedCount > 0
              ? `外部 Agent「${runtime.name}」已归档，${pausedCount} 个绑定的 AI伙伴已暂停。`
              : `外部 Agent「${runtime.name}」已归档。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setExternalBusy(false);
        }
      };

      const restoreExternalRuntime = async (runtime) => {
        try {
          setExternalBusy(true);
          const result = await request(
            "/api/collab/agent/external-runtimes/restore",
            {
              method: "POST",
              body: { workspaceId: externalWorkspaceId, runtimeId: runtime.id },
            },
          );
          await Promise.all([
            loadExternalRuntimes(externalWorkspaceId),
            loadList(),
          ]);
          const pausedCount = result.pausedTeammateIds?.length ?? 0;
          succeed(
            `外部 Agent「${runtime.name}」已复原为停用${pausedCount > 0 ? `，${pausedCount} 个绑定的 AI伙伴已暂停` : ""}，确认无误后再启用。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setExternalBusy(false);
        }
      };

      const probeExternalRuntime = async (runtime) => {
        try {
          setExternalBusy(true);
          const result = await request(
            "/api/collab/agent/external-runtimes/probe",
            {
              method: "POST",
              body: {
                workspaceId: externalWorkspaceId,
                runtimeId: runtime.id,
              },
            },
          );
          await loadExternalRuntimes(externalWorkspaceId);
          succeed(
            result.probe.ok
              ? "命令探测通过。"
              : `探测失败：${result.probe.message}`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setExternalBusy(false);
        }
      };

      const startInstanceProfileEdit = () => {
        if (selected === null) return;
        if (externalWorkspaceId !== "") {
          void loadExternalRuntimes(externalWorkspaceId);
        }
        setInstanceForm({
          name: selected.name,
          description: selected.description ?? "",
          execution: selected.execution ?? "builtin",
          externalRuntimeId: selected.externalRuntimeId ?? "",
        });
        setInstanceEditing(true);
      };

      const cancelInstanceProfileEdit = () => {
        setInstanceEditing(false);
      };

      /** 可用的实例模版：归档模版不能创建实例，这里直接过滤掉。 */
      const creatableTemplates = teammateTemplates.filter(
        (item) => item.state !== "archived",
      );
      const createInstanceWorkspaces = workspaces.filter(
        (item) => currentUser?.role === "admin" || item.isMember === true,
      );

      const openCreateInstance = () => {
        const preferred =
          creatableTemplates.find((item) => item.id === selected?.templateId) ??
          creatableTemplates[0];
        const preferredWorkspace =
          createInstanceWorkspaces.find(
            (item) => item.id === identity?.workspaceId,
          ) ?? createInstanceWorkspaces[0];
        setCreateInstanceTemplateId(preferred?.id ?? "");
        setCreateInstanceWorkspaceId(preferredWorkspace?.id ?? "");
        setCreateInstanceName("");
        setCreateInstanceOpen(true);
      };

      const createInstance = async () => {
        if (
          createInstanceTemplateId === "" ||
          createInstanceWorkspaceId === "" ||
          busy
        )
          return;
        const template = teammateTemplates.find(
          (item) => item.id === createInstanceTemplateId,
        );
        const name = createInstanceName.trim();
        try {
          setBusy(true);
          const result = await request(
            "/api/collab/teammates/create-with-employee",
            {
              method: "POST",
              body: {
                templateId: createInstanceTemplateId,
                workspaceId: createInstanceWorkspaceId,
                ...(name === "" ? {} : { name }),
              },
            },
          );
          const teammate = result.teammate;
          setCreateInstanceOpen(false);
          await loadList(teammate.id);
          setSelectedId(teammate.id);
          setTab("runtime");
          setArchivedView(false);
          setInstanceForm({
            name: teammate.name,
            description: teammate.description ?? "",
            execution: teammate.execution ?? "builtin",
            externalRuntimeId: teammate.externalRuntimeId ?? "",
          });
          setInstanceEditing(true);
          succeed(
            `已基于${
              template?.source === "platform" ? "平台" : "个人"
            }模版「${template?.name ?? ""}」创建 AI伙伴，并绑定到关联项目。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const saveInstanceProfileEdit = async () => {
        if (selected === null || instanceBusy) return;
        const name = instanceForm.name.trim();
        if (name === "") {
          fail(new Error("AI伙伴名称不能为空。"));
          return;
        }
        const execution = instanceForm.execution ?? "builtin";
        const externalRuntimeId = instanceForm.externalRuntimeId ?? "";
        if (execution === "external" && externalRuntimeId === "") {
          fail(new Error("请选择外部 Agent 运行时。"));
          return;
        }
        try {
          setInstanceBusy(true);
          const result = await request("/api/collab/teammates/update", {
            method: "POST",
            body: {
              teammateId: selected.id,
              name,
              description: instanceForm.description,
              execution,
              externalRuntimeId:
                execution === "external" ? externalRuntimeId : undefined,
            },
          });
          setInstanceEditing(false);
          await loadList(result.teammate.id);
          await loadDetail(result.teammate.id);
          succeed(
            (selected.execution ?? "builtin") === execution
              ? "AI伙伴资料已保存。"
              : execution === "external"
                ? "已切换为外部 Agent 执行。"
                : "已切换为内置执行。",
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setInstanceBusy(false);
        }
      };

      const startEdit = () => {
        if (tab === "definition") {
          if (selectedTemplate === null) return;
          setForm({
            name: selectedTemplate.name,
            role: selectedTemplate.role,
            description: selectedTemplate.description,
            // 场景行为 / 工作目标已并入 SOUL.md：编辑态直接呈现生效人格全文，
            // 不再单独编辑这两个字段。
            soul: effectiveSoulText(selectedTemplate),
            tools: selectedTemplate.tools.join("\n"),
          });
          setEditing(true);
          setError("");
          setNotice("");
          return;
        }
        if (selected === null) return;
        setForm({
          source: selected.source,
          name: selected.name,
          role: selected.role,
          description: selected.description,
          soul: effectiveSoulText(selected),
          avatar: selected.avatar,
          execution: selected.execution ?? "builtin",
          externalRuntimeId: selected.externalRuntimeId ?? "",
        });
        setEditing(true);
        setError("");
        setNotice("");
      };

      const cancelEdit = () => {
        setEditing(false);
        setForm(null);
      };

      const saveEdit = async () => {
        if (tab === "definition") {
          if (selectedTemplate === null || form === null) return;
          try {
            setBusy(true);
            if (
              selectedTemplate.source === "platform" &&
              !window.confirm(
                "这是平台模版。保存后会影响后续使用该模版的 AI伙伴。",
              )
            ) {
              return;
            }
            await request("/api/collab/teammate-templates/update", {
              method: "POST",
              body: {
                templateId: selectedTemplate.id,
                name: form.name,
                role: form.role,
                description: form.description,
                soul: form.soul,
                // 场景行为 / 工作目标已并入 SOUL.md：清空旧字段，避免同一段内容
                // 在生效人格里被追加两次。
                scenarios: [],
                goals: [],
                tools: form.tools
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
              },
            });
            setEditing(false);
            setForm(null);
            await Promise.all([
              loadTeammateTemplates(selectedTemplate.id),
              loadList(selected?.id),
              loadDetail(selected?.id ?? ""),
            ]);
            succeed("模版已保存。");
          } catch (cause) {
            fail(cause);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (selected === null || form === null) return;
        try {
          setBusy(true);
          if (
            form.source === "platform" &&
            !window.confirm(
              "这是平台归属定义。保存后会影响全平台该模版的所有 AI伙伴行为。确认继续？",
            )
          ) {
            return;
          }
          const result = await request("/api/collab/teammates/update", {
            method: "POST",
            body: {
              teammateId: selected.id,
              name: form.name,
              source: form.source,
              role: form.role,
              description: form.description,
              soul: form.soul,
              // 场景行为 / 工作目标已并入 SOUL.md，保存时清空旧字段。
              scenarios: [],
              goals: [],
              avatar: form.avatar,
              execution: form.execution,
              externalRuntimeId:
                form.execution === "external"
                  ? form.externalRuntimeId
                  : undefined,
            },
          });
          setEditing(false);
          setForm(null);
          await loadList(result.teammate.id);
          await loadDetail(result.teammate.id);
          succeed("定义已保存。");
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const changeState = async (nextState) => {
        if (tab === "definition") {
          if (selectedTemplate === null) return;
          const label =
            nextState === "active"
              ? "生效"
              : nextState === "disabled"
                ? "停用"
                : "归档";
          if (
            selectedTemplate.source === "platform" &&
            !window.confirm(`确认${label}这个平台模版吗？`)
          ) {
            return;
          }
          try {
            setBusy(true);
            const result = await request(
              "/api/collab/teammate-templates/state",
              {
                method: "POST",
                body: { templateId: selectedTemplate.id, state: nextState },
              },
            );
            await Promise.all([
              loadTeammateTemplates(result.template.id),
              loadList(selected?.id),
            ]);
            succeed(`${result.template.name} 已${label}`);
          } catch (cause) {
            fail(cause);
          } finally {
            setBusy(false);
          }
          return;
        }
        if (selected === null) return;
        const label =
          nextState === "active"
            ? selected.state === "paused"
              ? "重启"
              : "生效"
            : nextState === "paused"
              ? "暂停"
              : nextState === "inactive"
                ? "失效"
                : "归档";
        try {
          setBusy(true);
          const result = await request("/api/collab/teammates/state", {
            method: "POST",
            body: { teammateId: selected.id, state: nextState },
          });
          await loadList(result.teammate.id);
          await loadDetail(result.teammate.id);
          succeed(`${result.teammate.name} 已${label}`);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const archiveTeammate = async () => {
        if (selected === null) return;
        try {
          setBusy(true);
          const result = await request("/api/collab/teammates/state", {
            method: "POST",
            body: { teammateId: selected.id, state: "archived" },
          });
          setArchiveOpen(false);
          const nextSelected =
            teammates
              .filter(
                (item) => item.id !== selected.id && item.state !== "archived",
              )
              .at(0)?.id ?? "";
          setArchivedView(false);
          setSelectedId(nextSelected);
          await Promise.all([
            loadList(nextSelected),
            loadDetail(nextSelected),
            loadIdentity(nextSelected),
            loadRuntime(nextSelected),
          ]);
          const transferred = result.transferredTaskIds?.length ?? 0;
          succeed(
            transferred > 0
              ? `${result.teammate.name} 已归档，${transferred} 个未完成任务已转给 Owner。`
              : `${result.teammate.name} 已归档。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const toggleIdentity = async () => {
        if (selected === null || identity === null) return;
        const next = identity.agentStatus === "active" ? "disabled" : "active";
        try {
          setBusy(true);
          const result = await request(
            "/api/collab/teammates/identity/status",
            {
              method: "POST",
              body: { teammateId: selected.id, status: next },
            },
          );
          setIdentity(result.identity ?? null);
          await loadList(selected.id);
          await loadDetail(selected.id);
          succeed(next === "active" ? "执行身份已启用" : "执行身份已停用");
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy(false);
        }
      };

      const openTask = (task, returnRuntimeTab = runtimeTab) => {
        window.__pluginmaxPendingTask = {
          taskId: task.id,
          workspaceId: task.workspaceId,
          returnRoute: "teammates",
          returnTeammateId: selected?.id ?? "",
          returnTab: tab,
          returnRuntimeTab,
        };
        window.dispatchEvent(
          new CustomEvent("pluginmax:navigate", { detail: { route: "task" } }),
        );
      };

      const openAssign = async () => {
        setAssignQuery("");
        setAssignStatus("");
        setAssignPriority("");
        setAssignProject("");
        setAssignSelected([]);
        setAssignCreateOpen(false);
        setAssignCreateForm(null);
        setAssignOpen(true);
        try {
          const workspaceResult = await request("/api/collab/team/workspaces");
          const accessible = (workspaceResult.workspaces ?? []).filter(
            (workspace) =>
              workspace.isMember === true || canManagePlatform === true,
          );
          const results = await Promise.all(
            accessible.map((workspace) =>
              request(
                `/api/collab/tasks/bootstrap?workspaceId=${encodeURIComponent(workspace.id)}`,
              ).then((result) => ({ workspace, result })),
            ),
          );
          const merged = [];
          for (const entry of results) {
            for (const task of entry.result.tasks ?? []) {
              merged.push({
                ...task,
                workspaceTitle: entry.workspace.title ?? entry.workspace.id,
              });
            }
          }
          setAssignTasks(merged);
        } catch (cause) {
          fail(cause);
        }
      };

      const confirmAssign = async () => {
        if (selected === null || assignSelected.length === 0) return;
        try {
          setAssignBusy(true);
          for (const taskId of assignSelected) {
            await request("/api/collab/tasks/assign", {
              method: "POST",
              body: {
                taskId,
                receiverType: "agent",
                receiverId: selected.id,
                receiverName: selected.name,
              },
            });
          }
          const count = assignSelected.length;
          setAssignOpen(false);
          setAssignSelected([]);
          await loadList(selected.id);
          await loadDetail(selected.id);
          if (tab === "runtime") await loadRuntime(selected.id);
          succeed(`已将 ${count} 个任务安排给 ${selected.name}，执行已开始。`);
        } catch (cause) {
          fail(cause);
        } finally {
          setAssignBusy(false);
        }
      };

      /** 在「安排任务」弹窗内直接录入一条新任务，负责人固定为当前 AI伙伴。 */
      const openAssignCreate = () => {
        const accessible = workspaces.filter(
          (workspace) =>
            workspace.isMember === true || canManagePlatform === true,
        );
        setAssignCreateForm({
          workspaceId:
            accessible[0]?.id ??
            assignTasks[0]?.workspaceId ??
            workspaces[0]?.id ??
            "",
          title: "",
          type: "任务",
          priority: "P2",
          status: "todo",
          description: "",
          acceptance: "",
          due: "",
        });
        setAssignCreateOpen(true);
      };

      const createAssignedTask = async () => {
        if (selected === null || assignCreateForm === null) return;
        const title = assignCreateForm.title.trim();
        if (title === "" || assignCreateForm.workspaceId === "") return;
        const acceptance = assignCreateForm.acceptance
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean);
        try {
          setAssignBusy(true);
          const result = await request("/api/collab/tasks/create", {
            method: "POST",
            body: {
              workspaceId: assignCreateForm.workspaceId,
              title,
              type: assignCreateForm.type,
              priority: assignCreateForm.priority,
              status: assignCreateForm.status,
              receiverType: "agent",
              receiverId: selected.id,
              receiverName: selected.name,
              description: assignCreateForm.description.trim(),
              acceptance:
                acceptance.length === 0 ? ["按描述完成并自查"] : acceptance,
              due: assignCreateForm.due,
              autoSubmitReview: true,
            },
          });
          setAssignOpen(false);
          setAssignCreateOpen(false);
          setAssignCreateForm(null);
          setAssignSelected([]);
          await loadList(selected.id);
          await loadDetail(selected.id);
          if (tab === "runtime") await loadRuntime(selected.id);
          succeed(
            `任务「${result.task?.title ?? title}」已创建并派发给 ${selected.name}。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setAssignBusy(false);
        }
      };

      const generateWorkReport = async (teammate) => {
        if (workReportGenerating) return;
        try {
          setWorkReportGenerating(true);
          const result = await request(
            "/api/collab/teammates/work-reports/generate",
            {
              method: "POST",
              body: { teammateId: teammate.id },
            },
          );
          const report = result.report ?? null;
          const today = localIsoDate(new Date());
          // 保留当前日期范围与搜索词：更新日报只刷新数据、不重置视图，
          // 否则历史快照会因筛选被重置而在列表里"消失"。
          await loadWorkReports(teammate.id, reportRange, reportQuery);
          await loadAuditEvents(teammate.id);
          setReportNotice(
            result.generation === "fallback"
              ? `${today} 日报模型生成失败，已保存模板快照，可稍后重试。`
              : `已更新 ${today} 工作日报。`,
          );
          if (report === null) {
            setRuntimeTab("report");
          }
        } catch (cause) {
          fail(cause);
        } finally {
          setWorkReportGenerating(false);
        }
      };

      /** 队列视图的公共刷新：队列 + 运行态列表。 */
      const refreshQueueViews = async (teammateId) => {
        await Promise.all([loadQueue(teammateId), loadRuntime(teammateId)]);
      };

      /**
       * 让实例退出项目或项目里的某个角色。
       * 退出整个项目时，该项目下尚未完成的任务会按服务端口径改派，并在提示里回显接收人。
       */
      const leaveProject = async (teammate, workspaceId, assignment) => {
        const workspaceTitle =
          workspaces.find((item) => item.id === workspaceId)?.title ??
          workspaceId;
        const wholeProject = assignment === undefined;
        const activeRoles = projectRoles.filter(
          (item) =>
            item.workspaceId === workspaceId &&
            item.status === "active" &&
            !isRoleExpired(item),
        );
        const pendingTasks = runtimeTasks.filter(
          (task) =>
            task.workspaceId === workspaceId &&
            !task.archived &&
            task.status !== "done" &&
            task.status !== "cancelled",
        );
        const roleLabel = (role) => WORKSPACE_ROLE_LABEL[role] ?? role;
        const confirmed = window.confirm(
          wholeProject
            ? `让「${teammate.name}」退出项目「${workspaceTitle}」？\n\n· 撤销该项目下 ${String(activeRoles.length)} 条生效角色授权（历史记录保留）\n· 该项目下尚未完成的 ${String(pendingTasks.length)} 个任务将改派给 AI伙伴负责人；AI伙伴负责人不是项目成员时改派给项目 owner`
            : `让「${teammate.name}」退出项目「${workspaceTitle}」的角色「${roleLabel(assignment.role)}」？\n\n角色授权会被撤销，历史记录保留；已指派的任务保持不变。`,
        );
        if (!confirmed) return;
        try {
          setProjectRoleBusy(`${workspaceId}:${assignment?.id ?? "*"}`);
          const result = await request(
            "/api/collab/teammates/leave-workspace",
            {
              method: "POST",
              body: {
                teammateId: teammate.id,
                workspaceId,
                scope: wholeProject ? "workspace" : "role",
                ...(assignment === undefined
                  ? {}
                  : { assignmentId: assignment.id }),
              },
            },
          );
          await Promise.all([
            loadProjectRoles(teammate),
            loadList(teammate.id),
            loadDetail(teammate.id),
            loadRuntime(teammate.id),
          ]);
          const moved = (result.reassignedTaskIds ?? []).length;
          const receiverName = result.receiver?.name ?? "AI伙伴负责人";
          succeed(
            moved === 0
              ? wholeProject
                ? `已让「${teammate.name}」退出项目「${workspaceTitle}」。`
                : `已退出角色「${roleLabel(assignment.role)}」。`
              : `已退出项目「${workspaceTitle}」，${String(moved)} 个未完成任务已改派给 ${receiverName}。`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setProjectRoleBusy("");
        }
      };

      /** 队列内上移/下移：只重排同一工作区内的待启动任务。 */
      const moveQueueItem = async (teammate, task, delta) => {
        if (queueBusy || queue === null) return;
        const siblings = queue.planned.filter(
          (item) => item.workspaceId === task.workspaceId,
        );
        const index = siblings.findIndex((item) => item.id === task.id);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= siblings.length) return;
        const ordered = [...siblings];
        const [moved] = ordered.splice(index, 1);
        ordered.splice(next, 0, moved);
        try {
          setQueueBusy(true);
          await request("/api/collab/tasks/queue/reorder", {
            method: "POST",
            body: {
              workspaceId: task.workspaceId,
              orderedTaskIds: ordered.map((item) => item.id),
            },
          });
          await refreshQueueViews(teammate.id);
        } catch (cause) {
          fail(cause);
        } finally {
          setQueueBusy(false);
        }
      };

      /** 暂停 / 恢复出队（不影响正在执行的任务）。 */
      const toggleQueuePause = async (teammate, task) => {
        if (queueBusy) return;
        try {
          setQueueBusy(true);
          await request("/api/collab/tasks/queue/item", {
            method: "POST",
            body: {
              taskId: task.id,
              queueState: task.queueState === "paused" ? "idle" : "paused",
            },
          });
          await refreshQueueViews(teammate.id);
        } catch (cause) {
          fail(cause);
        } finally {
          setQueueBusy(false);
        }
      };

      /**
       * 待确认动作：通过 / 退回并补充。
       * 退回需要填原因：第一次点击展开输入框，填写后再确认。
       */
      const confirmQueueTask = async (teammate, task, action) => {
        if (queueBusy) return;
        if (action === "reject" && rejectNote.trim() === "") {
          setRejectingId(task.id);
          return;
        }
        try {
          setQueueBusy(true);
          await request("/api/collab/tasks/confirm", {
            method: "POST",
            body: {
              taskId: task.id,
              action,
              ...(action === "reject" ? { note: rejectNote.trim() } : {}),
            },
          });
          setRejectingId("");
          setRejectNote("");
          await refreshQueueViews(teammate.id);
          await loadDetail(teammate.id);
          succeed(
            action === "approve"
              ? `已通过 ${task.id}`
              : `已退回 ${task.id}，补充说明后会自动重新执行`,
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setQueueBusy(false);
        }
      };

      const readFile = (file, onLoad) => {
        const reader = new FileReader();
        reader.addEventListener("load", () =>
          onLoad(String(reader.result ?? "")),
        );
        reader.readAsText(file);
      };

      const readImage = (file, onLoad) => {
        const reader = new FileReader();
        reader.addEventListener("load", () =>
          onLoad(String(reader.result ?? "")),
        );
        reader.readAsDataURL(file);
      };

      /**
       * 归属（平台/个人）是模版概念，只用于定义态分组；
       * 运行态列的是实例，实例一律归 owner，按平铺列表展示。
       */
      const directoryGroups =
        tab === "definition"
          ? [
              {
                key: "platform",
                label: "平台模版",
                items: teammateTemplates.filter(
                  (item) => item.source === "platform",
                ),
              },
              {
                key: "personal",
                label: "个人模版",
                items: teammateTemplates.filter(
                  (item) => item.source === "personal",
                ),
              },
            ].map((group) => ({
              ...group,
              entries: groupTeammateTemplates(
                visibleTeammates,
                group.items.filter((item) =>
                  archivedOnly
                    ? item.state === "archived"
                    : item.state !== "archived",
                ),
              ),
            }))
          : [
              {
                key: "instances",
                label: "全部 AI伙伴",
                items: visibleTeammates,
                entries: visibleTeammates.map((item) => ({
                  item,
                  instanceIds: [item.id],
                })),
              },
            ];

      const directory = h(
        "aside",
        {
          className: "pmtm-panel pmtm-directory",
          "aria-label": "AI伙伴列表",
        },
        directoryGroups.map((group) => {
          const groupMetricTitle =
            tab === "definition"
              ? `${loadScopeTitle("template", activity.generatedAt || "")}\n\n${LIVE_INSTANCES_HELP}`
              : loadScopeTitle("instance", activity.generatedAt || "");
          return h(
            "section",
            { className: "pmtm-group", key: group.key },
            h(
              "div",
              { className: "pmtm-group-title" },
              h(
                "span",
                { className: "pmtm-group-label" },
                group.label,
                h(
                  "span",
                  { className: "pmtm-group-count" },
                  String(group.entries.length),
                ),
              ),
              h(
                "span",
                { className: "pmtm-group-metric" },
                "近24小时",
                h(
                  "span",
                  {
                    className: "pmtm-info",
                    tabIndex: 0,
                    role: "button",
                    "aria-label":
                      tab === "definition"
                        ? "模版近24小时统计说明"
                        : "AI伙伴近24小时统计说明",
                    title: groupMetricTitle,
                  },
                  h(InfoIcon, null),
                  h(
                    "span",
                    { className: "pmtm-info-pop", role: "tooltip" },
                    groupMetricTitle,
                  ),
                ),
              ),
            ),
            group.entries.length === 0
              ? h(
                  "div",
                  {
                    className: "pmtm-empty",
                    style: { padding: "14px", fontSize: 11.5 },
                  },
                  "暂无定义",
                )
              : group.entries.map(({ item, instanceIds }) =>
                  h(
                    "button",
                    {
                      key: item.id,
                      type: "button",
                      className: `pmtm-item${
                        tab === "definition"
                          ? item.id === definitionTemplateId
                            ? " active"
                            : ""
                          : instanceIds.includes(selectedId)
                            ? " active"
                            : ""
                      }`,
                      onClick: () =>
                        tab === "definition"
                          ? selectTeammateTemplate(item.id)
                          : selectTeammate(item.id),
                    },
                    h(TeammateAvatar, { teammate: item }),
                    h(
                      "span",
                      { className: "pmtm-item-copy" },
                      h("strong", null, item.name),
                      h(
                        "small",
                        null,
                        tab === "definition"
                          ? `${item.role || ROLE_PLACEHOLDER} · ${String(instanceIds.length)} 个 AI伙伴`
                          : `${item.role || ROLE_PLACEHOLDER} · ${item.ownerName}`,
                      ),
                      h(
                        "span",
                        {
                          className: `pmtm-state-text ${item.state}`,
                          title: STATE_LABEL[item.state] ?? item.state,
                        },
                        STATE_LABEL[item.state] ?? item.state,
                      ),
                    ),
                    h(
                      "span",
                      { className: "pmtm-item-metric" },
                      tab === "runtime" && runningIds.includes(item.id)
                        ? h("span", {
                            className: "pmtm-tick",
                            role: "status",
                            title: "有任务正在执行",
                            "aria-label": "有任务正在执行",
                          })
                        : null,
                      h(LoadMetric, {
                        activity,
                        teammateId:
                          tab === "definition"
                            ? (instanceIds[0] ?? "")
                            : item.id,
                        stacked: true,
                        ...(tab === "definition" ? { scope: "template" } : {}),
                      }),
                    ),
                  ),
                ),
          );
        }),
      );

      const renderCurrentWorkTab = () => {
        const current = runtimeTasks.filter((task) => !task.archived);
        const archived = runtimeTasks.filter((task) => task.archived);
        // 分类统计口径与「工作计划」队列摘要一致：按任务状态分组计数。
        const statusCounts = new Map();
        for (const task of current) {
          const key = typeof task.status === "string" ? task.status : "";
          statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
        }
        const statusSummary = [
          ["todo", STATUS_LABEL.todo],
          ["progress", STATUS_LABEL.progress],
          ["review", STATUS_LABEL.review],
          ["done", STATUS_LABEL.done],
          ["cancelled", "已取消"],
        ]
          .filter(
            ([status]) => status !== "cancelled" || statusCounts.has(status),
          )
          .map(
            ([status, label]) =>
              `${label} ${String(statusCounts.get(status) ?? 0)}`,
          );
        for (const [status, count] of statusCounts) {
          if (
            !["todo", "progress", "review", "done", "cancelled"].includes(
              status,
            )
          ) {
            statusSummary.push(`${status || "未知"} ${String(count)}`);
          }
        }
        const item = (task, isArchived) =>
          h(
            "article",
            {
              key: task.id,
              className: `pmtm-runtime-item status-${isArchived ? "archived" : task.status}`,
            },
            task.running
              ? h("span", {
                  className: "pmtm-spinner",
                  "aria-label": "Agent 正在运行",
                })
              : null,
            h(
              "div",
              { className: "pmtm-runtime-main" },
              h("strong", null, task.title),
              h(
                "small",
                null,
                `${task.id} · 更新 ${timeShort(task.updatedAt)}`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-runtime-body" },
              h(
                "div",
                { className: `pmtm-latest${task.running ? " streaming" : ""}` },
                h("span", { className: "label" }, "最新进展"),
                h(LatestProgressText, {
                  task,
                  expanded: expandedProgressIds.includes(task.id),
                  onToggle: () =>
                    setExpandedProgressIds((current) =>
                      current.includes(task.id)
                        ? current.filter((id) => id !== task.id)
                        : [...current, task.id],
                    ),
                }),
                task.running
                  ? h("span", {
                      className: "pmtm-caret",
                      "aria-hidden": "true",
                    })
                  : null,
              ),
              (task.runs ?? []).length > 0
                ? h(
                    "div",
                    {
                      style: {
                        marginTop: 8,
                        paddingTop: 6,
                        display: "grid",
                        gap: 4,
                        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
                      },
                    },
                    h(
                      "div",
                      {
                        style: {
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        },
                      },
                      h(
                        "span",
                        {
                          style: {
                            color: "var(--dsw-alias-label-tertiary)",
                            fontSize: 10.5,
                          },
                        },
                        `运行明细（${String((task.runs ?? []).length)}）`,
                      ),
                      (task.runs ?? []).length > 1
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "pmtm-latest-toggle",
                              onClick: () =>
                                setExpandedRunIds((current) =>
                                  current.includes(task.id)
                                    ? current.filter((id) => id !== task.id)
                                    : [...current, task.id],
                                ),
                            },
                            expandedRunIds.includes(task.id) ? "折叠" : "展开",
                          )
                        : null,
                    ),
                    ...(expandedRunIds.includes(task.id)
                      ? (task.runs ?? [])
                      : (task.runs ?? []).slice(0, 1)
                    ).map((run) =>
                      h(
                        "div",
                        {
                          key: run.id,
                          style: {
                            display: "grid",
                            gap: 2,
                            fontSize: 11,
                            color: "var(--dsw-alias-label-secondary)",
                          },
                        },
                        h(
                          "span",
                          null,
                          [
                            `第 ${String(run.runSeq)} 次`,
                            RUN_STATUS_LABEL[run.status] ?? run.status,
                            run.startedAt === undefined
                              ? undefined
                              : `开始 ${timeShort(run.startedAt)}`,
                            run.endedAt === undefined
                              ? undefined
                              : `结束 ${timeShort(run.endedAt)}`,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        ),
                        run.error === undefined
                          ? null
                          : h(
                              "span",
                              {
                                style: {
                                  color:
                                    "var(--dsw-alias-state-error-primary,#e5534b)",
                                  overflowWrap: "anywhere",
                                },
                              },
                              run.error,
                            ),
                        run.summary === undefined
                          ? null
                          : expandedRunIds.includes(task.id)
                            ? h(
                                "div",
                                {
                                  className: "pmtm-md",
                                  style: {
                                    gap: 3,
                                    maxHeight: "4.4em",
                                    overflow: "hidden",
                                  },
                                },
                                renderMarkdown(run.summary),
                              )
                            : h(
                                "span",
                                {
                                  style: {
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  },
                                },
                                run.summary,
                              ),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                },
              },
              h(
                "span",
                { className: `pmtm-pill ${task.status}` },
                STATUS_LABEL[task.status] ?? task.status,
              ),
              isArchived
                ? h("span", { className: "pmtm-pill" }, "已归档")
                : null,
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => openTask(task),
                },
                "查看详情",
              ),
            ),
          );
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-runtime-head" },
            h(
              "div",
              { className: "pmtm-runtime-head-main" },
              h("h3", null, "当前跟进事项"),
              h(
                "span",
                { className: "pmtm-runtime-summary" },
                statusSummary.join(" · "),
              ),
            ),
            h(
              "div",
              { className: "pmtm-runtime-head-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn small",
                  onClick: () => void openAssign(),
                },
                "安排任务",
              ),
            ),
          ),
          h(
            "div",
            null,
            current.length === 0
              ? h(
                  "div",
                  { className: "pmtm-empty" },
                  "当前没有进行或已完成的任务。",
                )
              : h(
                  "div",
                  { className: "pmtm-runtime" },
                  current.map((task) => item(task, false)),
                ),
          ),
          archived.length === 0
            ? null
            : h(
                "div",
                {
                  style: {
                    marginTop: 16,
                    paddingTop: 14,
                    borderTop: "0.5px solid var(--dsw-alias-border-l2)",
                  },
                },
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    },
                  },
                  h("h3", { style: { margin: 0, fontSize: 13 } }, "已归档"),
                  h(
                    "span",
                    { className: "pmtm-count" },
                    String(archived.length),
                  ),
                ),
                h(
                  "div",
                  { className: "pmtm-runtime" },
                  archived.map((task) => item(task, true)),
                ),
              ),
        );
      };

      const renderPlanTab = (teammate) => {
        const planned = queue?.planned ?? [];
        const running = queue?.running ?? [];
        const review = queue?.review ?? [];
        const finished = queue?.finished ?? [];
        const pendingInput = new Set(queue?.pendingInput ?? []);
        const targetName = (task) => task.receiverName ?? teammate.name;
        const meta = (task) =>
          [
            priorityLabel(task.priority),
            task.workspaceTitle || task.workspaceId,
            targetName(task),
            task.due === undefined ? "截止不限" : `截止 ${task.due}`,
          ].join(" · ");
        const latestOf = (task, fallback) =>
          h(
            "div",
            { className: "pmtm-latest", style: { marginTop: 0 } },
            h("span", { className: "label" }, fallback),
            h(
              "div",
              { className: "text pmtm-md" },
              renderMarkdown(
                task.description || task.latestProgress || "暂无说明。",
              ),
            ),
          );
        const plannedItem = (task, index) => {
          const siblings = planned.filter(
            (item) => item.workspaceId === task.workspaceId,
          );
          const position = siblings.findIndex((item) => item.id === task.id);
          return h(
            "article",
            {
              key: task.id,
              className: `pmtm-runtime-item status-todo pmtm-plan-item${task.queueState === "paused" ? " pmtm-queue-paused" : ""}`,
            },
            h(
              "div",
              { className: "pmtm-runtime-main" },
              h("strong", null, `${task.id} · ${task.title}`),
              h(
                "small",
                null,
                `队列第 ${String(index + 1)} 位 · ${meta(task)}`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-runtime-body" },
              latestOf(task, "计划说明"),
            ),
            h(
              "div",
              { className: "pmtm-queue-actions" },
              task.queueState === "paused"
                ? h("span", { className: "pmtm-pill warn" }, "已暂停")
                : null,
              task.autoRunEligible === false
                ? h("span", { className: "pmtm-pill" }, "仅人工")
                : null,
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn quiet small",
                  disabled: queueBusy || position <= 0,
                  title: "上移",
                  "aria-label": "上移",
                  onClick: () => void moveQueueItem(teammate, task, -1),
                },
                "↑",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn quiet small",
                  disabled: queueBusy || position === siblings.length - 1,
                  title: "下移",
                  "aria-label": "下移",
                  onClick: () => void moveQueueItem(teammate, task, 1),
                },
                "↓",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  disabled: queueBusy,
                  onClick: () => void toggleQueuePause(teammate, task),
                },
                task.queueState === "paused" ? "恢复" : "暂停",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => openTask(task, "plan"),
                },
                "查看详情",
              ),
            ),
          );
        };
        const reviewItem = (task) =>
          h(
            "article",
            {
              key: task.id,
              className: "pmtm-runtime-item status-review pmtm-plan-item",
            },
            h(
              "div",
              { className: "pmtm-runtime-main" },
              h("strong", null, `${task.id} · ${task.title}`),
              h("small", null, meta(task)),
            ),
            h(
              "div",
              { className: "pmtm-runtime-body" },
              latestOf(task, "最新进展"),
            ),
            h(
              "div",
              { className: "pmtm-queue-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn small",
                  disabled: queueBusy,
                  onClick: () =>
                    void confirmQueueTask(teammate, task, "approve"),
                },
                "通过",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  disabled: queueBusy,
                  onClick: () =>
                    void confirmQueueTask(teammate, task, "reject"),
                },
                "退回并补充",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => openTask(task, "plan"),
                },
                "查看详情",
              ),
            ),
            rejectingId === task.id
              ? h(
                  "div",
                  { className: "pmtm-queue-reject" },
                  h("textarea", {
                    value: rejectNote,
                    placeholder:
                      "说明需要补充什么（必填），确认后任务会重新排队执行",
                    "aria-label": "退回说明",
                    onChange: (event) => setRejectNote(event.target.value),
                  }),
                  h(
                    "div",
                    { className: "pmtm-queue-reject-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn small",
                        disabled: queueBusy || rejectNote.trim() === "",
                        onClick: () =>
                          void confirmQueueTask(teammate, task, "reject"),
                      },
                      "确认退回",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn quiet small",
                        onClick: () => {
                          setRejectingId("");
                          setRejectNote("");
                        },
                      },
                      "取消",
                    ),
                  ),
                )
              : null,
          );
        const runningItem = (task) =>
          h(
            "article",
            {
              key: task.id,
              className: "pmtm-runtime-item status-progress pmtm-plan-item",
            },
            h(
              "div",
              { className: "pmtm-runtime-main" },
              h("strong", null, `${task.id} · ${task.title}`),
              h("small", null, meta(task)),
            ),
            h(
              "div",
              { className: "pmtm-runtime-body" },
              latestOf(task, "最新进展"),
            ),
            h(
              "div",
              { className: "pmtm-queue-actions" },
              pendingInput.has(task.id)
                ? h("span", { className: "pmtm-pill warn" }, "待补充")
                : h("span", { className: "pmtm-pill progress" }, "执行中"),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => openTask(task, "plan"),
                },
                "查看详情",
              ),
            ),
          );
        const finishedItem = (task) =>
          h(
            "div",
            { key: task.id, className: "pmtm-queue-finished" },
            h("span", null, `${task.id} · ${task.title}`),
            h(
              "span",
              { className: `pmtm-pill ${task.status}` },
              STATUS_LABEL[task.status] ?? task.status,
            ),
            h(
              "button",
              {
                type: "button",
                className: "pmtm-btn quiet small",
                onClick: () => openTask(task, "plan"),
              },
              "查看详情",
            ),
          );
        const section = (key, label, count, body, empty) =>
          h(
            "div",
            { key, style: { marginTop: 14 } },
            h(
              "div",
              { className: "pmtm-runtime-head" },
              h(
                "div",
                { className: "pmtm-runtime-head-main" },
                h("h3", null, label),
                h("span", { className: "pmtm-count" }, String(count)),
              ),
            ),
            body ?? h("div", { className: "pmtm-empty" }, empty),
          );
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-runtime-head" },
            h(
              "div",
              { className: "pmtm-runtime-head-main" },
              h("h3", null, "工作队列"),
              h(
                "span",
                { className: "pmtm-runtime-summary" },
                `待启动 ${String(planned.length)} · 执行中 ${String(running.length)} · 待确认 ${String(review.length)}`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-runtime-head-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  disabled: queueBusy,
                  onClick: () => void refreshQueueViews(teammate.id),
                },
                "刷新",
              ),
            ),
          ),
          h(WorkPlanComposer, {
            teammate,
            canManagePlatform,
            onCreated: async () => {
              await Promise.all([
                refreshQueueViews(teammate.id),
                loadDetail(teammate.id),
              ]);
            },
            onError: fail,
            onNotice: succeed,
          }),
          queue === null
            ? h("div", { className: "pmtm-empty" }, "队列加载中…")
            : null,
          section(
            "planned",
            "待启动",
            planned.length,
            planned.length === 0
              ? null
              : h(
                  "div",
                  { className: "pmtm-runtime" },
                  planned.map((task, index) => plannedItem(task, index)),
                ),
            "当前没有待启动的工作计划。",
          ),
          section(
            "review",
            "待确认",
            review.length,
            review.length === 0
              ? null
              : h("div", { className: "pmtm-runtime" }, review.map(reviewItem)),
            "没有等待你确认的任务。",
          ),
          section(
            "running",
            "执行中",
            running.length,
            running.length === 0
              ? null
              : h(
                  "div",
                  { className: "pmtm-runtime" },
                  running.map(runningItem),
                ),
            "当前没有正在执行的任务。",
          ),
          finished.length === 0
            ? null
            : section(
                "finished",
                "已完成 / 已归档",
                finished.length,
                h(
                  "div",
                  { className: "pmtm-queue-finished-list" },
                  finished.slice(0, 10).map(finishedItem),
                ),
              ),
        );
      };

      const renderReportsTab = (teammate) => {
        // 工作日报是实例的产出：实例 owner 或平台管理员可以更新，与模版归属无关。
        const manageable =
          currentUser?.id === teammate.ownerUserId ||
          canManagePlatform === true;
        const defaultRange = defaultReportRange();
        const latest = workReports[0] ?? null;
        const history = workReports.slice(1);
        const filtered =
          reportRange.from !== defaultRange.from ||
          reportRange.to !== defaultRange.to ||
          reportQuery.trim() !== "";
        const emptyText = filtered
          ? "没有匹配的工作日报。"
          : "还没有工作日报，可以点击右侧「更新日报」生成。";
        const reportCard = (report) =>
          h(
            "article",
            { className: "pmtm-report-card", key: report.id },
            h("h3", null, report.title || `${report.reportDate} 工作日报`),
            h(
              "small",
              { className: "pmtm-report-writer" },
              `撰写人：${report.author?.name ?? teammate.name}（${teammate.id}） · 撰写时间：${timeShort(report.generatedAt)}`,
            ),
            h(
              "div",
              { className: "pmtm-md pmtm-report-body" },
              renderMarkdown(report.contentMarkdown ?? ""),
            ),
            (report.sourceRefs ?? []).length === 0
              ? null
              : h(
                  "div",
                  { className: "pmtm-report-source" },
                  `来源引用：${(report.sourceRefs ?? []).join("、")}`,
                ),
          );
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-runtime-head" },
            h(
              "div",
              { className: "pmtm-runtime-head-main" },
              h("h3", null, "工作日报"),
            ),
            h(
              "div",
              { className: "pmtm-report-filters" },
              h(
                "label",
                { className: "pmtm-report-range" },
                h("input", {
                  type: "date",
                  value: reportRange.from,
                  "aria-label": "工作日报开始日期",
                  onChange: (event) =>
                    setReportRange((current) => ({
                      ...current,
                      from: event.target.value,
                    })),
                }),
                h("span", null, "至"),
                h("input", {
                  type: "date",
                  value: reportRange.to,
                  "aria-label": "工作日报结束日期",
                  onChange: (event) =>
                    setReportRange((current) => ({
                      ...current,
                      to: event.target.value,
                    })),
                }),
              ),
              h(
                "label",
                { className: "pmtm-report-search" },
                h(
                  "svg",
                  {
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                    strokeLinecap: "round",
                    "aria-hidden": true,
                  },
                  h("circle", { cx: 11, cy: 11, r: 7 }),
                  h("path", { d: "m20 20-3.6-3.6" }),
                ),
                h("input", {
                  type: "search",
                  value: reportSearch,
                  placeholder: "关键词",
                  "aria-label": "搜索工作日报",
                  onChange: (event) => setReportSearch(event.target.value),
                }),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn small",
                  disabled: workReportGenerating || !manageable,
                  title: manageable
                    ? "生成或更新今日工作日报"
                    : "没有权限更新该 AI伙伴的工作日报",
                  onClick: () => void generateWorkReport(teammate),
                },
                workReportGenerating ? "更新中" : "更新日报",
              ),
            ),
          ),
          reportNotice === ""
            ? null
            : h(
                "div",
                {
                  className: "pmtm-report-notice",
                  role: "status",
                  "aria-live": "polite",
                },
                reportNotice,
              ),
          workReportsLoading
            ? h("div", { className: "pmtm-empty" }, "加载中…")
            : latest === null
              ? h("div", { className: "pmtm-empty" }, emptyText)
              : reportCard(latest),
          h(
            "div",
            { style: { marginTop: 16 } },
            h(
              "div",
              { className: "pmtm-runtime-head" },
              h(
                "div",
                { className: "pmtm-runtime-head-main" },
                h("h3", null, "历史记录"),
                h("span", { className: "pmtm-count" }, String(history.length)),
              ),
            ),
            latest === null
              ? null
              : history.length === 0
                ? h("div", { className: "pmtm-empty" }, "没有更早的历史快照。")
                : h(
                    "div",
                    null,
                    ...history.map((report) => reportCard(report)),
                  ),
          ),
        );
      };

      const renderRolesTab = (teammate) => {
        const employeeId = teammate.employeeId ?? "";
        const active = projectRoles.filter(
          (item) => item.status === "active" && !isRoleExpired(item),
        );
        const groups = new Map();
        for (const item of active) {
          const list = groups.get(item.workspaceId) ?? [];
          list.push(item);
          groups.set(item.workspaceId, list);
        }
        const workspaceTitle = (workspaceId) =>
          workspaces.find((item) => item.id === workspaceId)?.title ??
          workspaceId;
        const pendingCount = (workspaceId) =>
          runtimeTasks.filter(
            (task) =>
              task.workspaceId === workspaceId &&
              !task.archived &&
              task.status !== "done" &&
              task.status !== "cancelled",
          ).length;
        const roleRow = (workspaceId, assignment) => {
          const busyKey = `${workspaceId}:${assignment.id}`;
          return h(
            "div",
            { key: assignment.id, className: "pmtm-role-row" },
            h(
              "div",
              { className: "pmtm-role-main" },
              h(
                "span",
                { className: "pmtm-pill role" },
                WORKSPACE_ROLE_LABEL[assignment.role] ?? assignment.role,
              ),
              h(
                "span",
                { className: "pmtm-role-perms" },
                (assignment.permissions ?? [])
                  .map(
                    (permission) => PERMISSION_LABEL[permission] ?? permission,
                  )
                  .join(" · ") || "无权限项",
              ),
              h(
                "small",
                null,
                assignment.expiresAt === undefined
                  ? `授予于 ${timeShort(assignment.createdAt)} · 长期有效`
                  : `有效期至 ${timeShort(assignment.expiresAt)}`,
              ),
            ),
            h(
              "button",
              {
                type: "button",
                className: "pmtm-btn quiet small",
                disabled: projectRoleBusy !== "",
                onClick: () =>
                  void leaveProject(teammate, workspaceId, assignment),
              },
              projectRoleBusy === busyKey ? "退出中…" : "退出角色",
            ),
          );
        };
        const groupCard = (entry) => {
          const [workspaceId, assignments] = entry;
          const busyKey = `${workspaceId}:*`;
          const pending = pendingCount(workspaceId);
          return h(
            "section",
            { key: workspaceId, className: "pmtm-role-card" },
            h(
              "div",
              { className: "pmtm-role-head" },
              h(
                "div",
                null,
                h("strong", null, workspaceTitle(workspaceId)),
                h(
                  "small",
                  null,
                  `${String(assignments.length)} 个生效角色${
                    pending === 0
                      ? ""
                      : ` · ${String(pending)} 个未完成任务将改派`
                  }`,
                ),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  disabled: projectRoleBusy !== "",
                  onClick: () => void leaveProject(teammate, workspaceId),
                },
                projectRoleBusy === busyKey ? "退出中…" : "退出项目",
              ),
            ),
            ...[...assignments]
              .sort((left, right) => left.role.localeCompare(right.role))
              .map((assignment) => roleRow(workspaceId, assignment)),
          );
        };
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-runtime-head" },
            h(
              "div",
              { className: "pmtm-runtime-head-main" },
              h("h3", null, "项目角色"),
              h(
                "span",
                { className: "pmtm-runtime-summary" },
                groups.size === 0
                  ? "暂无生效角色"
                  : `${String(groups.size)} 个项目 · ${String(active.length)} 个生效角色`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-runtime-head-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  disabled: projectRolesLoading,
                  onClick: () => void loadProjectRoles(teammate),
                },
                projectRolesLoading ? "刷新中…" : "刷新",
              ),
            ),
          ),
          employeeId === ""
            ? h(
                "div",
                { className: "pmtm-empty" },
                "该 AI伙伴还没有绑定员工档案，暂无项目角色。",
              )
            : projectRolesLoading && projectRoles.length === 0
              ? h("div", { className: "pmtm-empty" }, "角色加载中…")
              : groups.size === 0
                ? h(
                    "div",
                    { className: "pmtm-empty" },
                    "该 AI伙伴当前没有参与任何项目。",
                  )
                : h(
                    "div",
                    { className: "pmtm-role-list" },
                    ...[...groups.entries()].map(groupCard),
                  ),
        );
      };

      const renderAuditTab = () =>
        h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-runtime-head" },
            h(
              "div",
              { className: "pmtm-runtime-head-main" },
              h("h3", null, "历史执行记录"),
              h(
                "span",
                { className: "pmtm-count" },
                String(auditEvents.length),
              ),
            ),
          ),
          auditEvents.length === 0
            ? h(
                "div",
                { className: "pmtm-empty" },
                auditLoading ? "加载中…" : "暂无历史执行记录。",
              )
            : h(
                "div",
                { className: "pmtm-audit-list" },
                ...auditEvents.map((event) =>
                  h(
                    "div",
                    { className: "pmtm-audit-item", key: event.id },
                    h("time", null, auditTimeText(event.at)),
                    h(
                      "div",
                      { className: "pmtm-audit-copy" },
                      event.narrative,
                      h(
                        "span",
                        { className: "pmtm-audit-actor" },
                        `${event.actorName} · ${AUDIT_ACTOR_LABEL[event.actorType] ?? "操作"}`,
                      ),
                    ),
                  ),
                ),
                auditCursor === ""
                  ? null
                  : h(
                      "div",
                      { className: "pmtm-audit-more" },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-btn secondary small",
                          disabled: auditLoading,
                          onClick: () =>
                            void loadAuditEvents(selectedId, auditCursor),
                        },
                        auditLoading ? "加载中…" : "加载更多",
                      ),
                    ),
              ),
        );

      const renderRuntime = (teammate) => {
        const editPolicy = runtimeDetailEditPolicy(instanceEditing);
        const executionPill = teammateExecutionPill(teammate, externalRuntimes);
        const template =
          teammate.templateId === undefined
            ? null
            : {
                name: teammate.templateName ?? teammate.templateId,
                kind:
                  (teammate.templateSource ?? teammate.source) === "platform"
                    ? "平台模版"
                    : "个人模版",
                instances: teammates.filter(
                  (item) => item.templateId === teammate.templateId,
                ).length,
              };
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-editor-head" },
            h(
              "div",
              { className: "pmtm-editor-identity" },
              h(TeammateAvatar, { teammate, className: "large" }),
              h(
                "div",
                { className: "pmtm-editor-main" },
                instanceEditing
                  ? h("input", {
                      type: "text",
                      className: "pmtm-input pmtm-instance-name",
                      value: instanceForm.name,
                      maxLength: 120,
                      placeholder: "AI伙伴名称",
                      "aria-label": "AI伙伴名称",
                      onChange: (event) =>
                        setInstanceForm((current) => ({
                          ...current,
                          name: event.target.value,
                        })),
                    })
                  : h(
                      "div",
                      { className: "pmtm-title-row" },
                      h("h2", null, teammate.name),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-icon-btn",
                          title: "编辑 AI伙伴资料与执行方式",
                          "aria-label": "编辑 AI伙伴资料与执行方式",
                          onClick: startInstanceProfileEdit,
                        },
                        h(
                          "svg",
                          {
                            viewBox: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: 1.8,
                            strokeLinecap: "round",
                            strokeLinejoin: "round",
                          },
                          h("path", {
                            d: "M12 20h9",
                          }),
                          h("path", {
                            d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
                          }),
                        ),
                      ),
                    ),
                h(
                  "div",
                  { className: "pmtm-meta" },
                  h(
                    "span",
                    { className: `pmtm-state ${teammate.state}` },
                    STATE_LABEL[teammate.state] ?? teammate.state,
                  ),
                  h("span", null, teammate.role || ROLE_PLACEHOLDER),
                  h(
                    "span",
                    null,
                    `最近同步于 ${timeShort(teammate.updatedAt)}`,
                  ),
                ),
                h(
                  "div",
                  { className: "pmtm-meta secondary" },
                  h(
                    "span",
                    {
                      className: `pmtm-pill execution ${executionPill.tone}`,
                      title:
                        executionPill.tone === "external warn"
                          ? "绑定的外部 Agent 运行时不可用，派发前请改绑可用的运行时或切回内置执行"
                          : undefined,
                    },
                    executionPill.text,
                  ),
                  h(
                    "span",
                    {
                      className: "pmtm-pill template",
                      title:
                        template === null
                          ? "该 AI伙伴没有关联模版，按独立定义运行"
                          : `同模版 AI伙伴 ${String(template.instances)} 个`,
                    },
                    template === null
                      ? "模版：未关联（独立定义）"
                      : `模版：${template.name}（${template.kind}）`,
                  ),
                ),
                instanceEditing
                  ? h(
                      react.Fragment,
                      null,
                      h("textarea", {
                        className: "pmtm-area pmtm-instance-desc-input",
                        value: instanceForm.description,
                        maxLength: 4_000,
                        placeholder:
                          "描述这个 AI伙伴负责什么、边界在哪，供指派和复盘时参考…",
                        "aria-label": "AI伙伴描述",
                        onChange: (event) =>
                          setInstanceForm((current) => ({
                            ...current,
                            description: event.target.value,
                          })),
                      }),
                      h(
                        "div",
                        { className: "pmtm-instance-exec" },
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "执行方式"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              "aria-label": "执行方式",
                              value: instanceForm.execution ?? "builtin",
                              onChange: (event) =>
                                setInstanceForm((current) => ({
                                  ...current,
                                  execution: event.target.value,
                                })),
                            },
                            h("option", { value: "builtin" }, "内置执行"),
                            h("option", { value: "external" }, "外部 Agent"),
                          ),
                        ),
                        (instanceForm.execution ?? "builtin") === "external"
                          ? h(
                              "label",
                              { className: "pmtm-field" },
                              h("span", { className: "label" }, "外部 Agent"),
                              h(
                                "select",
                                {
                                  className: "pmtm-select",
                                  "aria-label": "外部 Agent 运行时",
                                  value: instanceForm.externalRuntimeId ?? "",
                                  onChange: (event) =>
                                    setInstanceForm((current) => ({
                                      ...current,
                                      externalRuntimeId: event.target.value,
                                    })),
                                },
                                externalRuntimeOptions(
                                  externalRuntimes,
                                  instanceForm.externalRuntimeId,
                                ),
                              ),
                              (() => {
                                const bound = unavailableBoundRuntime(
                                  externalRuntimes,
                                  instanceForm.externalRuntimeId,
                                );
                                return bound === undefined
                                  ? null
                                  : h(
                                      "div",
                                      { className: "pmtm-notice" },
                                      `当前绑定的「${bound.name}」${externalRuntimeStatusLabel(bound.status)}，保存前请改绑启用中的运行时，或把执行方式切回内置执行。`,
                                    );
                              })(),
                            )
                          : null,
                      ),
                      h(
                        "div",
                        { className: "pmtm-instance-edit-actions" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn primary small",
                            disabled:
                              instanceBusy ||
                              instanceForm.name.trim() === "" ||
                              ((instanceForm.execution ?? "builtin") ===
                                "external" &&
                                (instanceForm.externalRuntimeId ?? "") === ""),
                            onClick: () => void saveInstanceProfileEdit(),
                          },
                          instanceBusy ? "保存中…" : "保存",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn quiet small",
                            disabled: instanceBusy,
                            onClick: cancelInstanceProfileEdit,
                          },
                          "取消",
                        ),
                      ),
                    )
                  : h(
                      "p",
                      {
                        className: `pmtm-instance-desc${
                          teammate.description ? "" : " placeholder"
                        }`,
                      },
                      teammate.description || "暂无描述",
                    ),
              ),
            ),
            // 基础信息编辑态下隐藏工作负荷统计，编辑时只聚焦基础字段。
            editPolicy.showMetrics
              ? h(
                  "div",
                  { className: "pmtm-editor-metrics" },
                  h(LoadMetric, {
                    activity,
                    teammateId: teammate.id,
                    detailed: true,
                    scope: "instance",
                    label: "AI伙伴近24h工作负荷",
                  }),
                )
              : null,
            h(
              "div",
              { className: "pmtm-editor-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => openDefinitionForTeammate(teammate),
                },
                "人设定义",
              ),
              // 运行态状态开关：生效 / 失效（暂停）· 重启 · 复原。
              // 重建运行态详情时这一行漏掉了状态入口，这里补回来。
              teammate.state === "archived"
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      disabled: busy,
                      onClick: () => void changeState("inactive"),
                    },
                    "复原",
                  )
                : teammate.state === "active"
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn secondary small",
                        disabled: busy,
                        onClick: () =>
                          void changeState(
                            teammate.source === "personal"
                              ? "paused"
                              : "inactive",
                          ),
                      },
                      teammate.source === "personal" ? "暂停" : "失效",
                    )
                  : h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn secondary small",
                        disabled: busy,
                        onClick: () => void changeState("active"),
                      },
                      teammate.state === "paused" ? "重启" : "生效",
                    ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn quiet small",
                  disabled: busy || runningIds.includes(teammate.id),
                  title: runningIds.includes(teammate.id)
                    ? "运行中的 AI伙伴不能归档"
                    : "归档运行态 AI伙伴",
                  onClick: () => setArchiveOpen(true),
                },
                "归档 AI伙伴",
              ),
            ),
          ),
          teammate.state === "paused"
            ? h(
                "div",
                { className: "pmtm-notice" },
                "该分身已暂停，当前不会接收新任务或继续自动跟进。",
              )
            : null,
          h(
            "div",
            {
              className: "pmtm-runtime-tabs",
              role: "tablist",
              "aria-label": "AI伙伴运行态内容",
            },
            ...RUNTIME_TABS.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  role: "tab",
                  id: `pmtm-runtime-tab-${item.key}`,
                  "aria-selected": runtimeTab === item.key,
                  "aria-controls": `pmtm-runtime-panel-${item.key}`,
                  className: `pmtm-runtime-tab${runtimeTab === item.key ? " active" : ""}`,
                  onClick: () => setRuntimeTab(item.key),
                },
                item.label,
              ),
            ),
          ),
          h(
            "div",
            {
              className: editPolicy.panelsClass,
            },
            h(
              "div",
              {
                id: "pmtm-runtime-panel-current",
                role: "tabpanel",
                "aria-labelledby": "pmtm-runtime-tab-current",
                className: "pmtm-runtime-panel",
                hidden: runtimeTab !== "current",
              },
              renderCurrentWorkTab(),
            ),
            h(
              "div",
              {
                id: "pmtm-runtime-panel-plan",
                role: "tabpanel",
                "aria-labelledby": "pmtm-runtime-tab-plan",
                className: "pmtm-runtime-panel",
                hidden: runtimeTab !== "plan",
              },
              renderPlanTab(teammate),
            ),
            h(
              "div",
              {
                id: "pmtm-runtime-panel-report",
                role: "tabpanel",
                "aria-labelledby": "pmtm-runtime-tab-report",
                className: "pmtm-runtime-panel",
                hidden: runtimeTab !== "report",
              },
              renderReportsTab(teammate),
            ),
            h(
              "div",
              {
                id: "pmtm-runtime-panel-roles",
                role: "tabpanel",
                "aria-labelledby": "pmtm-runtime-tab-roles",
                className: "pmtm-runtime-panel",
                hidden: runtimeTab !== "roles",
              },
              renderRolesTab(teammate),
            ),
            h(
              "div",
              {
                id: "pmtm-runtime-panel-audit",
                role: "tabpanel",
                "aria-labelledby": "pmtm-runtime-tab-audit",
                className: "pmtm-runtime-panel",
                hidden: runtimeTab !== "audit",
              },
              renderAuditTab(),
            ),
          ),
        );
      };

      const renderActions = (teammate) => {
        if (tab === "definition") {
          if (selectedTemplate === null || !canManageSelectedTemplate) {
            return null;
          }
          const buttons = [
            h(
              "button",
              {
                key: "edit",
                type: "button",
                className: "pmtm-btn secondary small",
                onClick: startEdit,
                disabled: selectedTemplate.state === "archived",
              },
              "编辑模版",
            ),
          ];
          if (selectedTemplate.state === "active") {
            buttons.push(
              h(
                "button",
                {
                  key: "disable",
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => changeState("disabled"),
                },
                "停用",
              ),
            );
          } else if (selectedTemplate.state === "disabled") {
            buttons.push(
              h(
                "button",
                {
                  key: "activate",
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => changeState("active"),
                },
                "生效",
              ),
              h(
                "button",
                {
                  key: "archive",
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: () => changeState("archived"),
                },
                "归档",
              ),
            );
          }
          return h("div", { className: "pmtm-actions" }, buttons);
        }
        const manageable =
          canManagePlatform === true ||
          teammate.ownerUserId === currentUser?.id;
        if (!manageable) return null;
        const buttons = [];
        if (teammate.state === "archived") {
          buttons.push(
            h(
              "button",
              {
                key: "restore",
                type: "button",
                className: "pmtm-btn secondary small",
                onClick: () => changeState("inactive"),
              },
              "复原",
            ),
          );
          return h("div", { className: "pmtm-actions" }, buttons);
        }
        if (teammate.state === "active") {
          buttons.push(
            h(
              "button",
              {
                key: "deactivate",
                type: "button",
                className: "pmtm-btn secondary small",
                onClick: () =>
                  changeState(
                    teammate.source === "personal" ? "paused" : "inactive",
                  ),
              },
              "暂停",
            ),
          );
        } else {
          buttons.push(
            h(
              "button",
              {
                key: "activate",
                type: "button",
                className: "pmtm-btn secondary small",
                onClick: () => changeState("active"),
              },
              teammate.state === "paused" ? "重启" : "生效",
            ),
          );
        }
        buttons.push(
          h(
            "button",
            {
              key: "archive",
              type: "button",
              className: "pmtm-btn secondary small",
              disabled: busy || runningIds.includes(teammate.id),
              title: runningIds.includes(teammate.id)
                ? "运行中的 AI伙伴不能归档"
                : "归档运行态 AI伙伴",
              onClick: () => setArchiveOpen(true),
            },
            "归档",
          ),
        );
        return h("div", { className: "pmtm-actions" }, buttons);
      };

      const renderEditor = (teammate) => {
        const setField = (key, value) =>
          setForm((current) =>
            current === null ? current : { ...current, [key]: value },
          );
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-editor-head" },
            h(TeammateAvatar, {
              teammate: { ...teammate, avatar: form.avatar },
              className: "large",
            }),
            h(
              "div",
              { className: "pmtm-editor-main" },
              h(
                "h2",
                null,
                teammate.state === "draft"
                  ? "新建 AI伙伴"
                  : `编辑 ${teammate.name}`,
              ),
              h(
                "div",
                { className: "pmtm-meta" },
                `归属：${form.source === "platform" ? "平台" : "本人"} · ${teammate.version}`,
              ),
            ),
          ),
          teammate.source === "platform" || form.source === "platform"
            ? h(
                "div",
                { className: "pmtm-notice" },
                h(
                  "svg",
                  {
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                  },
                  h("path", {
                    d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
                  }),
                  h("path", { d: "M12 8v4M12 16h.01" }),
                ),
                h(
                  "span",
                  null,
                  "平台归属定义会共享给全平台，只有平台管理员可以维护；会议里的额外要求写在该次派遣的「本次嘱咐」上，不会改动这份定义。",
                ),
              )
            : null,
          h(
            "div",
            { className: "pmtm-grid" },
            h(
              "div",
              { className: "pmtm-field wide" },
              h("span", { className: "label" }, "头像"),
              h(
                "div",
                { className: "pmtm-avatar-editor" },
                h(
                  "span",
                  {
                    className: `pmtm-avatar-preview${form.source === "platform" ? " platform" : ""}`,
                  },
                  avatarArt(form.avatar, "preview"),
                ),
                h(
                  "div",
                  { style: { flex: 1, minWidth: 0 } },
                  h(
                    "div",
                    { className: "pmtm-presets" },
                    AVATAR_PRESETS.map((preset) =>
                      h(
                        "button",
                        {
                          key: preset.id,
                          type: "button",
                          className: `pmtm-preset${form.avatar === preset.id ? " active" : ""}`,
                          onClick: () => setField("avatar", preset.id),
                        },
                        h(TeammateAvatar, {
                          teammate: {
                            source: teammate.source,
                            avatar: preset.id,
                            name: preset.name,
                          },
                        }),
                        h("span", null, preset.name),
                      ),
                    ),
                  ),
                  h(
                    "label",
                    {
                      className: "pmtm-btn secondary small",
                      style: { marginTop: 8, cursor: "pointer" },
                    },
                    "上传图片",
                    h("input", {
                      type: "file",
                      accept: "image/*",
                      style: { display: "none" },
                      onChange: (event) => {
                        const file = event.target.files?.[0];
                        if (file !== undefined) {
                          readImage(file, (value) => {
                            setField("avatar", value);
                            succeed(`已载入头像 ${file.name}`);
                          });
                        }
                      },
                    }),
                  ),
                ),
              ),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "名称"),
              h("input", {
                className: "pmtm-input",
                value: form.name,
                onChange: (event) => setField("name", event.target.value),
              }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "专业角色"),
              h("input", {
                className: "pmtm-input",
                value: form.role,
                onChange: (event) => setField("role", event.target.value),
              }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "归属"),
              teammate.state === "draft"
                ? h(
                    "select",
                    {
                      className: "pmtm-select",
                      value: form.source,
                      onChange: (event) =>
                        setField("source", event.target.value),
                    },
                    h("option", { value: "personal" }, "个人归属 · 本人"),
                    canManagePlatform
                      ? h(
                          "option",
                          { value: "platform" },
                          "平台归属 · 全平台共享",
                        )
                      : null,
                  )
                : h("input", {
                    className: "pmtm-input",
                    value:
                      teammate.source === "platform"
                        ? "平台"
                        : teammate.ownerName,
                    disabled: true,
                  }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "执行方式"),
              h(
                "select",
                {
                  className: "pmtm-select",
                  value: form.execution,
                  onChange: (event) =>
                    setField("execution", event.target.value),
                },
                h("option", { value: "builtin" }, "内置执行"),
                h("option", { value: "external" }, "外部 Agent"),
              ),
            ),
            form.execution === "external"
              ? h(
                  "label",
                  { className: "pmtm-field" },
                  h("span", { className: "label" }, "外部 Agent"),
                  h(
                    "select",
                    {
                      className: "pmtm-select",
                      value: form.externalRuntimeId,
                      onChange: (event) =>
                        setField("externalRuntimeId", event.target.value),
                    },
                    externalRuntimeOptions(
                      externalRuntimes,
                      form.externalRuntimeId,
                    ),
                  ),
                  (() => {
                    const bound = unavailableBoundRuntime(
                      externalRuntimes,
                      form.externalRuntimeId,
                    );
                    return bound === undefined
                      ? null
                      : h(
                          "div",
                          { className: "pmtm-notice" },
                          `当前绑定的「${bound.name}」${externalRuntimeStatusLabel(bound.status)}，保存前请改绑启用中的运行时，或把执行方式切回内置执行。`,
                        );
                  })(),
                )
              : null,
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "当前版本"),
              h("input", {
                className: "pmtm-input",
                value: teammate.version,
                disabled: true,
              }),
            ),
            h(
              "label",
              { className: "pmtm-field wide" },
              h("span", { className: "label" }, "基础说明"),
              h("textarea", {
                className: "pmtm-area",
                value: form.description,
                onChange: (event) =>
                  setField("description", event.target.value),
              }),
            ),
            h(
              "div",
              { className: "pmtm-field wide" },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  },
                },
                h("span", { className: "label" }, "SOUL.md"),
                h(
                  "label",
                  {
                    className: "pmtm-btn secondary small",
                    style: { cursor: "pointer" },
                  },
                  "上传 .md",
                  h("input", {
                    type: "file",
                    accept: ".md,text/markdown,text/plain",
                    style: { display: "none" },
                    onChange: (event) => {
                      const file = event.target.files?.[0];
                      if (file !== undefined) {
                        readFile(file, (value) => {
                          setField("soul", value);
                          succeed(`已载入 ${file.name}`);
                        });
                      }
                    },
                  }),
                ),
              ),
              h("textarea", {
                className: "pmtm-area soul",
                value: form.soul,
                onChange: (event) => setField("soul", event.target.value),
              }),
            ),
            h(
              "div",
              {
                className: "pmtm-actions wide",
                style: { gridColumn: "1 / -1" },
              },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: cancelEdit,
                },
                "取消",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn small",
                  disabled:
                    busy ||
                    form.name.trim() === "" ||
                    (form.execution === "external" &&
                      form.externalRuntimeId === ""),
                  onClick: () => void saveEdit(),
                },
                form.source === "platform" ? "保存全局定义" : "保存定义",
              ),
            ),
          ),
        );
      };

      const renderExternalManager = () => {
        const runtimeGroups = splitExternalRuntimes(externalRuntimes);
        const visibleExternalRuntimes = externalArchivedOnly
          ? runtimeGroups.archived
          : runtimeGroups.defaultView;
        const archivedBoundCount =
          externalArchiveTarget === null
            ? 0
            : externalRuntimeBindingCount(externalArchiveTarget);
        const externalArchiveDialog =
          externalArchiveTarget === null
            ? null
            : h(
                "div",
                {
                  className: "pmtm-mask",
                  onClick: (event) => {
                    if (event.target === event.currentTarget && !externalBusy)
                      setExternalArchiveTarget(null);
                  },
                },
                h(
                  "div",
                  {
                    className: "pmtm-dialog",
                    role: "dialog",
                    "aria-modal": "true",
                    "aria-label": `归档 ${externalArchiveTarget.name}`,
                  },
                  h(
                    "div",
                    { className: "pmtm-dialog-head" },
                    h("h2", null, `归档 ${externalArchiveTarget.name}`),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn secondary small",
                        disabled: externalBusy,
                        onClick: () => setExternalArchiveTarget(null),
                      },
                      "关闭",
                    ),
                  ),
                  h(
                    "div",
                    {
                      className: "pmtm-dialog-body",
                      style: {
                        margin: "14px 0 18px",
                        color: "var(--dsw-alias-label-secondary)",
                        fontSize: 12.5,
                        lineHeight: 1.6,
                      },
                    },
                    archivedBoundCount > 0
                      ? `归档后该运行时会从默认列表隐藏，不能再被选择或执行。当前有 ${archivedBoundCount} 个 AI伙伴仍绑定它，需要改绑其他运行时或切回内置执行。归档可以复原，复原后为停用状态。`
                      : "归档后该运行时会从默认列表隐藏，不能再被选择或执行。归档可以复原，复原后为停用状态。",
                  ),
                  h(
                    "div",
                    { className: "pmtm-dialog-foot" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pmtm-btn danger",
                        disabled: externalBusy,
                        onClick: () => void archiveExternalRuntime(),
                      },
                      externalBusy ? "归档中…" : "确认归档",
                    ),
                  ),
                ),
              );
        const selectedExternalRuntime =
          visibleExternalRuntimes.find(
            (runtime) => runtime.id === externalSelectedId,
          ) ??
          visibleExternalRuntimes[0] ??
          null;
        const editFormError =
          externalForm === null ? "" : externalRuntimeFormError(externalForm);
        const advancedArgsState =
          externalForm === null
            ? { args: [], error: "" }
            : parseExternalArgsText(externalForm.customArgsText ?? "");
        const customArgsCount = advancedArgsState.args.length;
        const externalModelChoices =
          externalForm === null
            ? []
            : [
                ...new Set([
                  ...(EXTERNAL_MODEL_SUGGESTIONS[externalForm.provider] ?? []),
                  ...(externalForm.supportedModels ?? []),
                ]),
              ];
        const commandPreview =
          externalForm === null ? "" : externalCommandPreview(externalForm);
        const toggleExternalTool = (tool) =>
          setExternalForm((current) => {
            if (current === null) return current;
            const selected = current.supportedTools ?? [];
            return {
              ...current,
              supportedTools: selected.includes(tool)
                ? selected.filter((item) => item !== tool)
                : [...selected, tool],
            };
          });
        const toggleExternalModel = (model) =>
          setExternalForm((current) => {
            if (current === null) return current;
            const selected = current.supportedModels ?? [];
            const next = selected.includes(model)
              ? selected.filter((item) => item !== model)
              : [...selected, model];
            return {
              ...current,
              supportedModels: next,
              defaultModel: next.includes(current.defaultModel)
                ? current.defaultModel
                : "",
            };
          });
        const addExternalModel = () =>
          setExternalForm((current) => {
            if (current === null) return current;
            const model = String(current.modelDraft ?? "").trim();
            if (model === "") return current;
            const selected = current.supportedModels ?? [];
            return {
              ...current,
              supportedModels: selected.includes(model)
                ? selected
                : [...selected, model],
              defaultModel:
                current.defaultModel === "" ? model : current.defaultModel,
              modelDraft: "",
            };
          });
        const toggleAdvancedOptions = () =>
          setExternalForm((current) =>
            current === null
              ? current
              : {
                  ...current,
                  advancedOpen: current.advancedOpen !== true,
                },
          );
        const resetAdvancedOptions = () =>
          setExternalForm((current) =>
            current === null
              ? current
              : {
                  ...current,
                  customArgs: [],
                  customArgsText: "",
                },
          );
        const copyCommandPreview = async () => {
          try {
            await navigator.clipboard?.writeText(commandPreview);
            succeed("启动命令已复制。");
          } catch {
            fail(new Error("复制失败，请手动选择命令文本。"));
          }
        };
        const externalDirectory = h(
          "aside",
          {
            className: "pmtm-panel pmtm-directory",
            "aria-label": "运行时列表",
          },
          h(
            "section",
            { className: "pmtm-group" },
            h(
              "div",
              { className: "pmtm-group-title" },
              h(
                "span",
                { className: "pmtm-group-label" },
                externalArchivedOnly ? "已归档运行时" : "全部运行时",
                h(
                  "span",
                  { className: "pmtm-group-count" },
                  String(visibleExternalRuntimes.length),
                ),
              ),
            ),
            visibleExternalRuntimes.length === 0
              ? h(
                  "div",
                  {
                    className: "pmtm-empty",
                    style: { padding: "14px", fontSize: 11.5 },
                  },
                  externalArchivedOnly
                    ? "还没有已归档的运行时。"
                    : "还没有外部 Agent 运行时。",
                )
              : visibleExternalRuntimes.map((runtime) =>
                  h(
                    "button",
                    {
                      key: runtime.id,
                      type: "button",
                      className: `pmtm-item${
                        runtime.id === selectedExternalRuntime?.id
                          ? " active"
                          : ""
                      }`,
                      onClick: () => {
                        setExternalSelectedId(runtime.id);
                        setExternalEditing(false);
                        setExternalForm(null);
                      },
                    },
                    h(
                      "span",
                      {
                        className: "pmtm-item-copy",
                        // 运行时列表没有头像列，文本跨满整行避免被 32px 首列挤断。
                        style: { gridColumn: "1 / -1" },
                      },
                      h("strong", null, runtime.name),
                      h(
                        "small",
                        null,
                        `${externalRuntimeProviderLabel(runtime.provider)} · ${externalRuntimeProtocolLabel(runtime.protocol)}`,
                      ),
                      h(
                        "span",
                        { className: "pmtm-runtime-summary" },
                        ...runtimeConfigurationLabels(runtime).map((label) =>
                          h("span", { key: label }, label),
                        ),
                      ),
                      h(
                        "span",
                        {
                          className: `pmtm-state-text ${externalRuntimeStatusTone(runtime.status)}`,
                        },
                        externalRuntimeStatusLabel(runtime.status),
                      ),
                    ),
                  ),
                ),
          ),
        );
        return h(
          "div",
          { className: "pmtm-layout" },
          externalDirectory,
          h(
            "section",
            {
              className: "pmtm-panel pmtm-editor",
              "aria-label": "运行时设置详情",
            },
            externalWorkspaceId === ""
              ? h(
                  "div",
                  { className: "pmtm-profile-empty tall" },
                  "请先加入一个项目，再注册本机外部 Agent。",
                )
              : externalEditing && externalForm !== null
                ? h(
                    "div",
                    { className: "pmtm-profile-form" },
                    h(
                      "div",
                      { className: "pmtm-editor-head" },
                      h(
                        "h2",
                        null,
                        externalForm.runtimeId === undefined
                          ? "注册运行时"
                          : "编辑运行时",
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmtm-field" },
                      h("span", { className: "label" }, "运行时名称"),
                      h("input", {
                        className: "pmtm-input",
                        value: externalForm.name,
                        placeholder: "例如：Codex CLI 本机",
                        onChange: (event) =>
                          setExternalForm({
                            ...externalForm,
                            name: event.target.value,
                          }),
                      }),
                      h(
                        "span",
                        { className: "pmtm-inline-sub" },
                        "Runtime 只描述执行通道、模型或固定能力；Agent 角色、职责和 SOUL 请在定义态配置。",
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmtm-field" },
                      h("span", { className: "label" }, "Provider"),
                      h(
                        "select",
                        {
                          className: "pmtm-select",
                          value: externalForm.provider,
                          onChange: (event) =>
                            changeExternalProvider(event.target.value),
                        },
                        h("option", { value: "codex" }, "Codex"),
                        h("option", { value: "workbuddy" }, "WorkBuddy"),
                        h("option", { value: "command" }, "通用命令"),
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmtm-field" },
                      h("span", { className: "label" }, "协议"),
                      h(
                        "select",
                        {
                          className: "pmtm-select",
                          value: externalForm.protocol,
                          onChange: (event) =>
                            setExternalForm({
                              ...externalForm,
                              protocol: event.target.value,
                            }),
                        },
                        h(
                          "option",
                          {
                            value: "codex-jsonl",
                            disabled: externalForm.provider !== "codex",
                          },
                          "Codex JSONL",
                        ),
                        h(
                          "option",
                          {
                            value: "plain-text",
                            disabled: externalForm.provider === "codex",
                          },
                          "通用 stdin/stdout",
                        ),
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmtm-field" },
                      h("span", { className: "label" }, "命令"),
                      h("input", {
                        className: "pmtm-input",
                        value: externalForm.command,
                        onChange: (event) =>
                          setExternalForm({
                            ...externalForm,
                            command: event.target.value,
                          }),
                      }),
                    ),
                    h(
                      "section",
                      { className: "pmtm-config-section" },
                      h(
                        "div",
                        { className: "pmtm-config-section-head" },
                        h("strong", null, "执行配置"),
                        h(
                          "span",
                          null,
                          "使用可读选项描述 Runtime 的启动方式，平台会自动转换为命令行参数。",
                        ),
                      ),
                      h(
                        "div",
                        { className: "pmtm-grid" },
                        h(
                          "div",
                          { className: "pmtm-field wide" },
                          h("span", { className: "label" }, "支持的常用工具"),
                          h(
                            "div",
                            {
                              className: "pmtm-capability-grid",
                              role: "group",
                              "aria-label": "Runtime 支持的常用工具",
                            },
                            ...EXTERNAL_RUNTIME_TOOLS.map((tool) =>
                              h(
                                "label",
                                {
                                  className: "pmtm-capability-option",
                                  key: tool.value,
                                },
                                h("input", {
                                  type: "checkbox",
                                  checked:
                                    externalForm.supportedTools?.includes(
                                      tool.value,
                                    ) === true,
                                  onChange: () =>
                                    toggleExternalTool(tool.value),
                                }),
                                tool.label,
                              ),
                            ),
                          ),
                          h(
                            "span",
                            { className: "pmtm-inline-sub" },
                            "这里声明 Runtime 的技术能力上限；任务是否获准使用公开网页、写文件或执行命令仍由 Task Execution Policy 决定。",
                          ),
                        ),
                        h(
                          "div",
                          { className: "pmtm-field wide" },
                          h(
                            "span",
                            { className: "label" },
                            "支持的模型池（管理员声明）",
                          ),
                          h(
                            "div",
                            {
                              className: "pmtm-capability-grid models",
                              role: "group",
                              "aria-label": "Runtime 支持的模型",
                            },
                            ...externalModelChoices.map((model) =>
                              h(
                                "label",
                                {
                                  className: "pmtm-capability-option",
                                  key: model,
                                },
                                h("input", {
                                  type: "checkbox",
                                  checked:
                                    externalForm.supportedModels?.includes(
                                      model,
                                    ) === true,
                                  onChange: () => toggleExternalModel(model),
                                }),
                                model,
                              ),
                            ),
                          ),
                          h(
                            "div",
                            { className: "pmtm-model-add" },
                            h("input", {
                              className: "pmtm-input",
                              value: externalForm.modelDraft ?? "",
                              placeholder: "添加自定义模型 ID",
                              "aria-label": "自定义模型 ID",
                              onChange: (event) =>
                                setExternalForm({
                                  ...externalForm,
                                  modelDraft: event.target.value,
                                }),
                              onKeyDown: (event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addExternalModel();
                              },
                            }),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "pmtm-btn secondary small",
                                disabled:
                                  String(
                                    externalForm.modelDraft ?? "",
                                  ).trim() === "",
                                onClick: addExternalModel,
                              },
                              "加入模型池",
                            ),
                          ),
                          h(
                            "span",
                            { className: "pmtm-inline-sub" },
                            "常用候选仅用于快速录入；请添加本机 CLI 实际支持的模型 ID。任务端只会展示这里已勾选的模型。",
                          ),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "默认模型"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              value: externalForm.defaultModel ?? "",
                              onChange: (event) =>
                                setExternalForm({
                                  ...externalForm,
                                  defaultModel: event.target.value,
                                }),
                            },
                            h("option", { value: "" }, "沿用 CLI 默认模型"),
                            ...(externalForm.supportedModels ?? []).map(
                              (model) =>
                                h(
                                  "option",
                                  { value: model, key: model },
                                  model,
                                ),
                            ),
                          ),
                          h(
                            "span",
                            { className: "pmtm-inline-sub" },
                            "未在任务中覆盖时使用；默认模型必须属于上方模型池。",
                          ),
                        ),
                        externalForm.provider === "workbuddy"
                          ? h(
                              "label",
                              { className: "pmtm-field" },
                              h("span", { className: "label" }, "文件修改权限"),
                              h(
                                "select",
                                {
                                  className: "pmtm-select",
                                  value: externalForm.permissionMode,
                                  onChange: (event) =>
                                    setExternalForm({
                                      ...externalForm,
                                      permissionMode: event.target.value,
                                    }),
                                },
                                h("option", { value: "default" }, "默认权限"),
                                h(
                                  "option",
                                  { value: "plan" },
                                  "计划模式，不直接修改",
                                ),
                                h(
                                  "option",
                                  { value: "acceptEdits" },
                                  "自动接受文件修改",
                                ),
                              ),
                            )
                          : h(
                              "div",
                              { className: "pmtm-field" },
                              h("span", { className: "label" }, "执行沙箱"),
                              h(
                                "div",
                                { className: "pmtm-config-facts" },
                                h(
                                  "span",
                                  null,
                                  externalForm.provider === "codex"
                                    ? "只读 / 网络受限"
                                    : "由通用命令自行负责",
                                ),
                              ),
                            ),
                        externalForm.provider === "workbuddy"
                          ? h(
                              "label",
                              { className: "pmtm-field" },
                              h("span", { className: "label" }, "最大执行回合"),
                              h("input", {
                                className: "pmtm-input",
                                type: "number",
                                min: 1,
                                max: 100,
                                value: externalForm.maxTurns,
                                placeholder: "留空使用 CLI 默认值",
                                onChange: (event) =>
                                  setExternalForm({
                                    ...externalForm,
                                    maxTurns: event.target.value,
                                  }),
                              }),
                            )
                          : null,
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "最大上下文窗口"),
                          h("input", {
                            className: "pmtm-input",
                            type: "number",
                            min: 1_000,
                            max: 10_000_000,
                            step: 1_000,
                            value: externalForm.contextWindowTokens ?? "",
                            onChange: (event) =>
                              setExternalForm({
                                ...externalForm,
                                contextWindowTokens: event.target.value,
                              }),
                          }),
                          h(
                            "span",
                            { className: "pmtm-inline-sub" },
                            `输入 token；建议值 ${DEFAULT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}。`,
                          ),
                        ),
                        h(
                          "div",
                          { className: "pmtm-field wide" },
                          h("span", { className: "label" }, "平台托管配置"),
                          h(
                            "div",
                            { className: "pmtm-config-facts" },
                            h(
                              "span",
                              null,
                              `协议：${externalRuntimeProtocolLabel(externalForm.protocol)}`,
                            ),
                            h("span", null, "Prompt：stdin"),
                            h(
                              "span",
                              null,
                              externalForm.provider === "workbuddy"
                                ? "输出：stream-json"
                                : externalForm.provider === "codex"
                                  ? "输出：JSONL"
                                  : "输出：stdout",
                            ),
                          ),
                        ),
                      ),
                    ),
                    h(
                      "section",
                      {
                        className:
                          "pmtm-config-section pmtm-command-preview-section",
                      },
                      h(
                        "div",
                        { className: "pmtm-config-section-head" },
                        h("strong", null, "启动命令预览"),
                        h(
                          "span",
                          null,
                          "根据上方配置自动生成。运行期的工作区、临时文件和任务模型会用占位符或实际值表示。",
                        ),
                      ),
                      h(
                        "div",
                        { className: "pmtm-command-preview" },
                        h("code", null, commandPreview),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn secondary small",
                            onClick: () => void copyCommandPreview(),
                          },
                          "复制",
                        ),
                      ),
                    ),
                    h(
                      "section",
                      {
                        className: "pmtm-config-section pmtm-advanced-config",
                      },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-advanced-toggle",
                          "aria-expanded": externalForm.advancedOpen === true,
                          onClick: toggleAdvancedOptions,
                        },
                        h(
                          "span",
                          { className: "pmtm-advanced-toggle-copy" },
                          h("strong", null, "高级启动参数"),
                          h(
                            "small",
                            null,
                            "通常无需修改；只有 CLI 存在额外选项时才需要配置。",
                          ),
                        ),
                        h(
                          "span",
                          { className: "pmtm-advanced-badge" },
                          customArgsCount === 0
                            ? "推荐配置"
                            : `已自定义 ${String(customArgsCount)} 项`,
                        ),
                        h("span", {
                          className: `pmtm-advanced-caret${externalForm.advancedOpen === true ? " open" : ""}`,
                          "aria-hidden": "true",
                        }),
                      ),
                      externalForm.advancedOpen === true
                        ? h(
                            "div",
                            { className: "pmtm-advanced-body" },
                            h(
                              "label",
                              { className: "pmtm-field" },
                              h("span", { className: "label" }, "额外参数"),
                              h("textarea", {
                                className: "pmtm-area pmtm-advanced-args",
                                rows: 3,
                                value: externalForm.customArgsText ?? "",
                                placeholder:
                                  '例如：--verbose --include-directory "./docs"',
                                spellCheck: false,
                                onChange: (event) =>
                                  setExternalForm({
                                    ...externalForm,
                                    customArgsText: event.target.value,
                                  }),
                              }),
                              h(
                                "span",
                                { className: "pmtm-inline-sub" },
                                "只填写追加参数，不要包含命令本身；支持引号，不支持管道、重定向、命令替换或环境变量展开。",
                              ),
                            ),
                            advancedArgsState.error !== ""
                              ? h(
                                  "div",
                                  { className: "pmtm-config-error" },
                                  advancedArgsState.error,
                                )
                              : null,
                          )
                        : null,
                    ),
                    editFormError === ""
                      ? null
                      : h(
                          "div",
                          { className: "pmtm-config-error" },
                          editFormError,
                        ),
                    h(
                      "div",
                      {
                        className: "pmtm-actions pmtm-runtime-form-actions",
                      },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-btn secondary small",
                          disabled: customArgsCount === 0,
                          onClick: resetAdvancedOptions,
                        },
                        "恢复推荐配置",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-btn secondary small",
                          onClick: () => setExternalEditing(false),
                        },
                        "取消",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtm-btn small",
                          disabled:
                            externalBusy ||
                            externalForm.name.trim() === "" ||
                            externalForm.command.trim() === "" ||
                            editFormError !== "",
                          onClick: () => void saveExternalRuntime(),
                        },
                        externalBusy
                          ? "保存中"
                          : externalForm.runtimeId === undefined
                            ? "保存运行时"
                            : "保存修改",
                      ),
                    ),
                  )
                : visibleExternalRuntimes.length === 0
                  ? h(
                      "div",
                      { className: "pmtm-profile-empty tall" },
                      externalArchivedOnly
                        ? "还没有已归档的外部 Agent 运行时。"
                        : "还没有外部 Agent 运行时。",
                    )
                  : h(
                      "div",
                      { className: "pmtm-profile-list" },
                      visibleExternalRuntimes
                        .filter(
                          (runtime) =>
                            runtime.id === selectedExternalRuntime?.id,
                        )
                        .map((runtime) =>
                          h(
                            "div",
                            {
                              key: runtime.id,
                              className: `pmtm-profile-item runtime ${externalRuntimeStatusTone(runtime.status)}`,
                            },
                            h(
                              "div",
                              null,
                              h(
                                "div",
                                { className: "pmtm-runtime-head-line" },
                                h("strong", null, runtime.name),
                                h(
                                  "span",
                                  {
                                    className: `pmtm-pill runtime-status ${externalRuntimeStatusTone(runtime.status)}`,
                                  },
                                  externalRuntimeStatusLabel(runtime.status),
                                ),
                              ),
                              h(
                                "div",
                                { className: "pmtm-inline-sub" },
                                `${externalRuntimeProviderLabel(runtime.provider)} · ${externalRuntimeProtocolLabel(runtime.protocol)}`,
                              ),
                              h(
                                "div",
                                { className: "pmtm-runtime-summary" },
                                ...runtimeConfigurationLabels(runtime).map(
                                  (label) => h("span", { key: label }, label),
                                ),
                              ),
                              h(
                                "div",
                                { className: "pmtm-inline-sub" },
                                `启动命令：${runtime.command}`,
                              ),
                              externalRuntimeBindingCount(runtime) > 0
                                ? h(
                                    "div",
                                    { className: "pmtm-inline-sub" },
                                    `已绑定 ${externalRuntimeBindingCount(runtime)} 个 AI伙伴`,
                                  )
                                : null,
                              runtime.lastProbeMessage !== undefined
                                ? h(
                                    "div",
                                    { className: "pmtm-inline-sub" },
                                    `${runtime.lastProbeOk === true ? "探测通过" : "探测失败"}：${runtime.lastProbeMessage}`,
                                  )
                                : null,
                            ),
                            canManageExternal
                              ? externalArchivedOnly
                                ? h(
                                    "div",
                                    { className: "pmtm-actions" },
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "pmtm-btn small",
                                        disabled: externalBusy,
                                        onClick: () =>
                                          void restoreExternalRuntime(runtime),
                                      },
                                      "复原",
                                    ),
                                  )
                                : h(
                                    "div",
                                    { className: "pmtm-actions" },
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "pmtm-btn small",
                                        disabled: externalBusy,
                                        onClick: () =>
                                          startExternalEdit(runtime),
                                      },
                                      "编辑",
                                    ),
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "pmtm-btn secondary small",
                                        disabled: externalBusy,
                                        onClick: () =>
                                          void probeExternalRuntime(runtime),
                                      },
                                      "探测",
                                    ),
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "pmtm-btn secondary small",
                                        disabled: externalBusy,
                                        onClick: () =>
                                          void changeExternalState(
                                            runtime,
                                            runtime.status === "active"
                                              ? "disabled"
                                              : "active",
                                          ),
                                      },
                                      runtime.status === "active"
                                        ? "停用"
                                        : "启用",
                                    ),
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "pmtm-btn danger small",
                                        disabled: externalBusy,
                                        onClick: () =>
                                          setExternalArchiveTarget(runtime),
                                      },
                                      "归档",
                                    ),
                                  )
                              : null,
                          ),
                        ),
                    ),
          ),
          externalArchiveDialog,
        );
      };

      const renderTemplateEditor = () => {
        if (selectedTemplate === null)
          return h("div", { className: "pmtm-empty" }, "请选择模版。");
        const setField = (key, value) =>
          setForm((current) =>
            current === null ? current : { ...current, [key]: value },
          );
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-editor-head" },
            h(
              "div",
              { className: "pmtm-editor-main" },
              h("h2", null, `编辑模版：${selectedTemplate.name}`),
              h(
                "div",
                { className: "pmtm-meta" },
                `归属：${selectedTemplate.source === "platform" ? "平台" : "个人"} · ${selectedTemplate.version}`,
              ),
            ),
          ),
          selectedTemplate.source === "platform"
            ? h(
                "div",
                { className: "pmtm-notice" },
                "平台模版由平台管理员维护；任何活跃用户都可以基于它创建自己的 AI伙伴。",
              )
            : null,
          h(
            "div",
            { className: "pmtm-grid" },
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "名称"),
              h("input", {
                className: "pmtm-input",
                value: form.name,
                onChange: (event) => setField("name", event.target.value),
              }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "专业角色"),
              h("input", {
                className: "pmtm-input",
                value: form.role,
                onChange: (event) => setField("role", event.target.value),
              }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h("span", { className: "label" }, "当前版本"),
              h("input", {
                className: "pmtm-input",
                value: selectedTemplate.version,
                disabled: true,
              }),
            ),
            h(
              "label",
              { className: "pmtm-field wide" },
              h("span", { className: "label" }, "基础说明"),
              h("textarea", {
                className: "pmtm-area",
                value: form.description,
                onChange: (event) =>
                  setField("description", event.target.value),
              }),
            ),
            h(
              "div",
              { className: "pmtm-field wide" },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  },
                },
                h("span", { className: "label" }, "SOUL.md"),
                h(
                  "label",
                  {
                    className: "pmtm-btn secondary small",
                    style: { cursor: "pointer" },
                  },
                  "上传 .md",
                  h("input", {
                    type: "file",
                    accept: ".md,text/markdown,text/plain",
                    style: { display: "none" },
                    onChange: (event) => {
                      const file = event.target.files?.[0];
                      if (file !== undefined) {
                        readFile(file, (value) => {
                          setField("soul", value);
                          succeed(`已载入 ${file.name}`);
                        });
                      }
                    },
                  }),
                ),
              ),
              h("textarea", {
                className: "pmtm-area soul",
                value: form.soul,
                onChange: (event) => setField("soul", event.target.value),
              }),
            ),
            h(
              "label",
              { className: "pmtm-field" },
              h(
                "span",
                { className: "label" },
                "工具（每行一项，留空表示不限制）",
              ),
              h("textarea", {
                className: "pmtm-area",
                value: form.tools,
                onChange: (event) => setField("tools", event.target.value),
              }),
            ),
            h(
              "div",
              {
                className: "pmtm-actions wide",
                style: { gridColumn: "1 / -1" },
              },
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn secondary small",
                  onClick: cancelEdit,
                },
                "取消",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pmtm-btn small",
                  disabled: busy || form.name.trim() === "",
                  onClick: () => void saveEdit(),
                },
                selectedTemplate.source === "platform"
                  ? "保存平台模版"
                  : "保存个人模版",
              ),
            ),
          ),
        );
      };

      const renderTemplateDefinition = () => {
        if (selectedTemplate === null) {
          return h("div", { className: "pmtm-empty" }, "暂无 Agent 模版。");
        }
        const instances = selectedTemplateInstances;
        const representative = instances[0];
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-editor-head" },
            h(
              "div",
              { className: "pmtm-editor-identity" },
              h(TeammateAvatar, {
                teammate: selectedTemplate,
                className: "large",
              }),
              h(
                "div",
                { className: "pmtm-editor-main" },
                h("h2", null, selectedTemplate.name),
                h(
                  "div",
                  { className: "pmtm-meta" },
                  h(
                    "span",
                    { className: `pmtm-state ${selectedTemplate.state}` },
                    STATE_LABEL[selectedTemplate.state] ??
                      selectedTemplate.state,
                  ),
                  h(
                    "span",
                    null,
                    `归属：${selectedTemplate.source === "platform" ? "平台" : "个人"}`,
                  ),
                  h("span", null, selectedTemplate.role || ROLE_PLACEHOLDER),
                  h(
                    "span",
                    null,
                    `${String(instances.length)} 个 AI伙伴 · ${selectedTemplate.version}`,
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "pmtm-editor-metrics" },
              h(LoadMetric, {
                activity,
                teammateId: representative?.id ?? "",
                detailed: true,
                scope: "template",
                label: "模版近24h工作负荷",
              }),
            ),
          ),
          renderActions(selectedTemplate),
          h(
            "div",
            { className: "pmtm-grid" },
            h(
              "div",
              { className: "pmtm-field card" },
              h("span", { className: "label" }, "模版状态"),
              h(
                "span",
                { className: "value" },
                selectedTemplate.state === "active"
                  ? "可用于创建新 AI伙伴和派发"
                  : "只阻止新派发，不级联改 AI伙伴状态",
              ),
            ),
            h(
              "div",
              { className: "pmtm-field card" },
              h("span", { className: "label" }, "定义版本"),
              h(
                "span",
                { className: "value" },
                `${selectedTemplate.version} · ${timeShort(selectedTemplate.updatedAt)} 更新`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-field card wide" },
              h("span", { className: "label" }, "基础说明"),
              h(
                "span",
                { className: "value" },
                selectedTemplate.description || "尚未填写。",
              ),
            ),
          ),
          h(
            "div",
            { className: "pmtm-grid two-one wide-gap" },
            h(
              "section",
              { className: "pmtm-block" },
              h("h3", null, "SOUL.md（生效人格）"),
              // 场景行为 / 工作目标已并入人格文件，这里展示的就是实际注入的内容。
              renderMarkdown(effectiveSoulText(selectedTemplate)),
            ),
            h(
              "section",
              { className: "pmtm-block" },
              h("h3", null, "工具"),
              selectedTemplate.tools.length === 0
                ? h(
                    "div",
                    {
                      style: {
                        color: "var(--dsw-alias-label-tertiary)",
                        fontSize: 11.5,
                      },
                    },
                    "未限制工具清单。",
                  )
                : h(
                    "ul",
                    { className: "pmtm-rules" },
                    selectedTemplate.tools.map((item, index) =>
                      h("li", { key: `tool-${String(index)}` }, item),
                    ),
                  ),
            ),
            h(
              "section",
              { className: "pmtm-block", style: { gridColumn: "1 / -1" } },
              h("h3", null, "使用该模版的 AI伙伴"),
              instances.length === 0
                ? h(
                    "div",
                    {
                      style: {
                        color: "var(--dsw-alias-label-tertiary)",
                        fontSize: 11.5,
                      },
                    },
                    "暂无 AI伙伴。",
                  )
                : h(
                    "ul",
                    { className: "pmtm-rules" },
                    instances.map((item) =>
                      h(
                        "li",
                        { key: item.id },
                        `${item.name} · ${item.ownerName} · ${STATE_LABEL[item.state] ?? item.state}`,
                      ),
                    ),
                  ),
            ),
          ),
        );
      };

      const renderDefinition = (teammate) => {
        if (tab === "definition") {
          if (editing && form !== null) return renderTemplateEditor();
          return renderTemplateDefinition();
        }
        if (editing && form !== null) return renderEditor(teammate);
        return h(
          "div",
          null,
          h(
            "div",
            { className: "pmtm-editor-head" },
            h(
              "div",
              { className: "pmtm-editor-identity" },
              h(TeammateAvatar, { teammate, className: "large" }),
              h(
                "div",
                { className: "pmtm-editor-main" },
                h("h2", null, teammate.name),
                h(
                  "div",
                  { className: "pmtm-meta" },
                  h(
                    "span",
                    { className: `pmtm-state ${teammate.state}` },
                    STATE_LABEL[teammate.state] ?? teammate.state,
                  ),
                  h("span", null, `创建人：${teammate.ownerName}`),
                  h("span", null, teammate.role || ROLE_PLACEHOLDER),
                  h("span", null, teammate.version),
                ),
              ),
            ),
            h(
              "div",
              { className: "pmtm-editor-metrics" },
              h(InstanceMetric, {
                liveInstances,
                teammateId: teammate.id,
                detailed: true,
              }),
              h(LoadMetric, {
                activity,
                teammateId: teammate.id,
                detailed: true,
                scope: "template",
                label: "模版近24h工作负荷",
              }),
            ),
          ),
          renderActions(teammate),
          canManagePlatform === true || teammate.ownerUserId === currentUser?.id
            ? h(
                "section",
                { className: "pmtm-block", style: { marginTop: 14 } },
                h("h3", null, "引用模版"),
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    },
                  },
                  h(
                    "select",
                    {
                      className: "pmtm-input",
                      value: switchTemplateId,
                      onChange: (event) =>
                        setSwitchTemplateId(event.target.value),
                      "aria-label": "选择 AI伙伴模版",
                    },
                    teammateTemplates
                      .filter((item) => item.state !== "archived")
                      .map((item) =>
                        h(
                          "option",
                          { value: item.id, key: item.id },
                          `${item.name} · ${
                            item.source === "platform" ? "平台模版" : "个人模版"
                          }`,
                        ),
                      ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      disabled:
                        busy ||
                        switchTemplateId === "" ||
                        switchTemplateId === teammate.templateId,
                      onClick: () => void switchTemplate(),
                    },
                    "切换模版",
                  ),
                ),
              )
            : null,
          teammate.source === "platform"
            ? null
            : h(
                "div",
                { className: "pmtm-notice info" },
                h(
                  "svg",
                  {
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2,
                    strokeLinecap: "round",
                  },
                  h("circle", { cx: 12, cy: 12, r: 9 }),
                  h("path", { d: "M12 8h.01M11 12h1v5h1" }),
                ),
                h(
                  "span",
                  null,
                  "这份定义会被你在会议、任务和评审中的该分身复用。针对某次会议的额外要求，在派遣时填写「本次嘱咐」，不会改动这份定义。",
                ),
              ),
          h(
            "section",
            { className: "pmtm-block", style: { marginTop: 14 } },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                },
              },
              h("h3", { style: { margin: 0 } }, "执行身份"),
              identity === null
                ? null
                : h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      disabled: busy,
                      onClick: () => void toggleIdentity(),
                    },
                    identity.agentStatus === "active" ? "停用" : "启用",
                  ),
            ),
            identity === null
              ? h(
                  "div",
                  {
                    style: {
                      marginTop: 8,
                      color: "var(--dsw-alias-label-tertiary)",
                      fontSize: 11.5,
                    },
                  },
                  "尚未开通执行身份；首次派发任务时会自动创建。",
                )
              : h(
                  "div",
                  { className: "pmtm-grid three", style: { marginTop: 8 } },
                  ...[
                    [
                      "项目",
                      h(CodeValue, {
                        label: "项目",
                        value:
                          workspaces.find(
                            (item) => item.id === identity.workspaceId,
                          )?.title ?? "项目",
                        code: identity.workspaceId,
                      }),
                    ],
                    [
                      "Agent Profile",
                      h(CodeValue, {
                        label: "Agent Profile",
                        value: identity.profileName,
                        code: identity.profileId,
                      }),
                    ],
                    [
                      "执行类型",
                      identity.runtimeKind === "task-worker"
                        ? "任务执行"
                        : identity.runtimeKind === "continuable-session"
                          ? "持续会话"
                          : identity.runtimeKind === "connector"
                            ? "连接通道"
                            : identity.runtimeKind,
                    ],
                    [
                      "执行通道",
                      identity.execution === "external"
                        ? h(CodeValue, {
                            label: "执行通道",
                            value: "外部 Agent",
                            code: identity.externalRuntimeId,
                          })
                        : "内置执行",
                    ],
                    [
                      "Persona",
                      identity.personaId === undefined
                        ? "未设置"
                        : h(CodeValue, {
                            label: "Persona",
                            value: `${teammate.name} 人设`,
                            code: identity.personaId,
                          }),
                    ],
                    [
                      "工具白名单",
                      identity.allowedTools.length === 0
                        ? "无（不允许工具调用）"
                        : identity.allowedTools.join("、"),
                    ],
                    [
                      "Profile 状态",
                      identity.agentStatus === "active" ? "启用" : "停用",
                    ],
                  ].map(([label, value]) =>
                    h(
                      "div",
                      { className: "pmtm-field card", key: label },
                      h("span", { className: "label" }, label),
                      h("span", { className: "value" }, value),
                    ),
                  ),
                ),
          ),
          h(
            "div",
            { className: "pmtm-grid" },
            h(
              "div",
              { className: "pmtm-field card" },
              h("span", { className: "label" }, "创建人"),
              h("span", { className: "value" }, teammate.ownerName),
            ),
            h(
              "div",
              { className: "pmtm-field card" },
              h("span", { className: "label" }, "定义版本"),
              h(
                "span",
                { className: "value" },
                `${teammate.version} · ${events[0]?.actorName ?? teammate.createdBy} ${timeShort(teammate.updatedAt)} 更新`,
              ),
            ),
            h(
              "div",
              { className: "pmtm-field card wide" },
              h("span", { className: "label" }, "基础说明"),
              h(
                "span",
                { className: "value" },
                teammate.description || "尚未填写。",
              ),
            ),
          ),
          h(
            "div",
            { className: "pmtm-grid wide-gap" },
            h(
              "section",
              { className: "pmtm-block wide" },
              h("h3", null, "SOUL.md（生效人格）"),
              // 实例视图没有独立工具清单：场景行为 / 工作目标已并入人格文件。
              renderMarkdown(effectiveSoulText(teammate)),
            ),
            h(
              "section",
              { className: "pmtm-block", style: { gridColumn: "1 / -1" } },
              h("h3", null, "最近变更"),
              events.length === 0
                ? h(
                    "div",
                    {
                      style: {
                        color: "var(--dsw-alias-label-tertiary)",
                        fontSize: 11.5,
                      },
                    },
                    "暂无变更记录。",
                  )
                : h(
                    "div",
                    { className: "pmtm-timeline" },
                    events.map((event) =>
                      h(
                        "div",
                        { className: "pmtm-event", key: event.id },
                        h("time", null, timeShort(event.at)),
                        h(
                          "span",
                          null,
                          `${event.actorName} · ${readableEventMessage(event, teammate)}`,
                        ),
                      ),
                    ),
                  ),
            ),
          ),
        );
      };

      const assignCandidates = assignTasks
        .filter((task) => task.archivedAt === undefined)
        .filter((task) => task.status !== "done")
        .filter((task) => task.receiverId !== selected?.id)
        .filter((task) => assignStatus === "" || task.status === assignStatus)
        .filter(
          (task) => assignPriority === "" || task.priority === assignPriority,
        )
        .filter(
          (task) =>
            assignProject === "" || task.workspaceTitle === assignProject,
        )
        .filter((task) => {
          const keyword = assignQuery.trim().toLowerCase();
          if (keyword === "") return true;
          return [
            task.id,
            task.title,
            task.description,
            task.workspaceTitle,
            task.status,
          ]
            .join(" ")
            .toLowerCase()
            .includes(keyword);
        })
        .sort(
          (left, right) =>
            left.priority.localeCompare(right.priority) ||
            left.id.localeCompare(right.id),
        );

      const archivedToggle = h(
        "button",
        {
          type: "button",
          className: `pmtm-token${archivedOnly ? " active" : ""}`,
          "aria-pressed": archivedOnly,
          title:
            tab === "definition"
              ? "在模版列表与已归档模版之间切换"
              : "在运行列表与已归档 AI伙伴之间切换",
          onClick: () => setArchivedView(!archivedOnlyRef.current),
        },
        archivedOnly
          ? "返回运行列表"
          : `已归档 ${
              tab === "definition"
                ? teammateTemplates.filter((item) => item.state === "archived")
                    .length
                : archivedTeammates.length
            }`,
      );

      /*
       * 运行态只管理 AI伙伴：入口是"选模版新建 AI伙伴"；模版的增删改属于定义态。
       */
      /*
       * 数据范围开关（平台管理员）：两段式，高亮段 = 当前实际视图，
       * 避免"按钮文案写下一步动作、高亮却像当前状态"的歧义。
       */
      const scopeToggle = canManagePlatform
        ? h(
            "div",
            {
              className: "pmtm-scope-seg",
              role: "group",
              "aria-label": "数据范围",
            },
            h(
              "button",
              {
                type: "button",
                className: `pmtm-token${scopeAll ? "" : " active"}`,
                "aria-pressed": !scopeAll,
                title:
                  "默认视图：我创建的 AI伙伴 + 平台共享 AI伙伴（不含其他用户的个人 AI伙伴）",
                onClick: () => {
                  if (scopeAllRef.current) setScopeView(false);
                },
              },
              "仅看我的",
            ),
            h(
              "button",
              {
                type: "button",
                className: `pmtm-token${scopeAll ? " active" : ""}`,
                "aria-pressed": scopeAll,
                title: "平台全量视图：显示全部账号（含其他用户个人）的 AI伙伴",
                onClick: () => {
                  if (!scopeAllRef.current) setScopeView(true);
                },
              },
              "平台全量",
            ),
          )
        : null;

      const createInstanceAction = h(
        "button",
        {
          type: "button",
          className: "pmtm-btn",
          disabled: busy || creatableTemplates.length === 0,
          title:
            creatableTemplates.length === 0
              ? "还没有可用模版，请先到「智能体定义」创建模版"
              : "基于已有模版创建一个新的 AI伙伴",
          onClick: openCreateInstance,
        },
        "新建 AI伙伴",
      );

      const templateCreateActions = canManagePlatform
        ? [
            h(
              "button",
              {
                type: "button",
                className: "pmtm-btn secondary",
                disabled: busy,
                title: "新建个人模版草稿（不会自动创建 AI伙伴）",
                onClick: () => void createTeammate("personal"),
              },
              "新建个人模版",
            ),
            h(
              "button",
              {
                type: "button",
                className: "pmtm-btn",
                disabled: busy,
                title: "新建平台模版草稿（不会自动创建 AI伙伴）",
                onClick: () => void createTeammate("platform"),
              },
              "新建平台模版",
            ),
          ]
        : [
            h(
              "button",
              {
                type: "button",
                className: "pmtm-btn",
                disabled: busy,
                title: "新建个人模版草稿（不会自动创建 AI伙伴）",
                onClick: () => void createTeammate("personal"),
              },
              "新建个人模版",
            ),
          ];

      const externalRuntimeGroups = splitExternalRuntimes(externalRuntimes);
      const externalToolbarActions = h(
        "div",
        { className: "pmtm-toolbar-actions" },
        h(
          "button",
          {
            type: "button",
            className: `pmtm-token${externalArchivedOnly ? " active" : ""}`,
            "aria-pressed": externalArchivedOnly,
            title: "在运行时列表与已归档运行时之间切换",
            disabled: externalEditing,
            onClick: () => setExternalArchivedOnly((current) => !current),
          },
          externalArchivedOnly
            ? "返回运行列表"
            : `已归档 ${externalRuntimeGroups.archived.length}`,
        ),
        canManageExternal
          ? h(
              "button",
              {
                type: "button",
                className: "pmtm-btn small",
                disabled: externalBusy || externalWorkspaceId === "",
                onClick: startExternalCreate,
              },
              "注册运行时",
            )
          : null,
      );

      const createActions = h(
        "div",
        { className: "pmtm-toolbar-actions" },
        tab === "runtime"
          ? createInstanceAction
          : tab === "definition"
            ? templateCreateActions
            : externalToolbarActions,
        tab === "external" ? null : archivedToggle,
      );

      return h(
        "div",
        { className: "pmtm" },
        h("style", null, styles),
        h(
          "div",
          { className: "pmtm-head" },
          h("div", null, h("h1", null, "AI伙伴")),
          h(
            "div",
            { className: "pmtm-head-actions" },
            /* 数据范围开关替代原来的「平台管理员」徽标；运行时设置页不适用。 */
            tab !== "external" ? scopeToggle : null,
            h(MeetingPanelToggle),
          ),
        ),
        h(
          "div",
          { className: "pmtm-toolbar" },
          h(
            "div",
            {
              className: "pmtm-tabs",
              role: "tablist",
              "aria-label": "AI伙伴查看方式",
            },
            h(
              "button",
              {
                type: "button",
                role: "tab",
                className: `pmtm-tab${tab === "runtime" ? " active" : ""}`,
                "aria-selected": tab === "runtime",
                onClick: () => {
                  setTab("runtime");
                  setEditing(false);
                  setForm(null);
                },
              },
              "AI伙伴管理",
            ),
            h(
              "button",
              {
                type: "button",
                role: "tab",
                className: `pmtm-tab${tab === "definition" ? " active" : ""}`,
                "aria-selected": tab === "definition",
                onClick: () => {
                  openDefinitionForTeammate(selected);
                },
              },
              "智能体定义",
            ),
            h(
              "button",
              {
                type: "button",
                role: "tab",
                className: `pmtm-tab${tab === "external" ? " active" : ""}`,
                "aria-selected": tab === "external",
                onClick: () => {
                  setTab("external");
                  setEditing(false);
                  setForm(null);
                  if (externalWorkspaceId !== "") {
                    void loadExternalRuntimes(externalWorkspaceId);
                  }
                },
              },
              "运行时设置",
            ),
          ),
          createActions,
        ),
        error !== "" ? h("div", { className: "pmtm-error" }, error) : null,
        notice !== ""
          ? h("div", { className: "pmtm-notice-bar" }, notice)
          : null,
        tab === "external"
          ? renderExternalManager()
          : h(
              "div",
              { className: "pmtm-layout" },
              directory,
              h(
                "section",
                {
                  className: "pmtm-panel pmtm-editor",
                  "aria-label": "AI伙伴详情",
                },
                loading && teammates.length === 0
                  ? h("div", { className: "pmtm-empty" }, "加载中…")
                  : tab === "definition"
                    ? renderDefinition(null)
                    : selected === null
                      ? h("div", { className: "pmtm-empty" }, "还没有 AI伙伴。")
                      : tab === "runtime"
                        ? renderRuntime(selected)
                        : renderDefinition(selected),
              ),
            ),
        createInstanceOpen
          ? h(
              "div",
              {
                className: "pmtm-mask",
                onClick: (event) => {
                  if (event.target === event.currentTarget)
                    setCreateInstanceOpen(false);
                },
              },
              h(
                "div",
                {
                  className: "pmtm-dialog",
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-label": "新建 AI伙伴",
                },
                h(
                  "div",
                  { className: "pmtm-dialog-head" },
                  h("h2", null, "新建 AI伙伴"),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      "aria-label": "关闭",
                      onClick: () => setCreateInstanceOpen(false),
                    },
                    "×",
                  ),
                ),
                h(
                  "div",
                  {
                    className: "pmtm-dialog-body",
                    style: { fontSize: 12.5 },
                  },
                  h(
                    "div",
                    { style: { color: "var(--dsw-alias-label-secondary)" } },
                    "AI伙伴基于已有模版创建，并绑定一个可参与的项目；模版本身的增删改请在「智能体定义」里操作。",
                  ),
                  h(
                    "label",
                    { className: "pmtm-field" },
                    h("span", { className: "label" }, "关联项目"),
                    h(
                      "select",
                      {
                        className: "pmtm-select",
                        value: createInstanceWorkspaceId,
                        "aria-label": "关联项目",
                        onChange: (event) =>
                          setCreateInstanceWorkspaceId(event.target.value),
                      },
                      createInstanceWorkspaces.length === 0
                        ? h("option", { value: "" }, "请先加入一个项目")
                        : createInstanceWorkspaces.map((item) =>
                            h(
                              "option",
                              { value: item.id, key: item.id },
                              item.title?.trim() || item.path || item.id,
                            ),
                          ),
                    ),
                  ),
                  h(
                    "label",
                    { className: "pmtm-field" },
                    h("span", { className: "label" }, "选择模版"),
                    h(
                      "select",
                      {
                        className: "pmtm-select",
                        value: createInstanceTemplateId,
                        "aria-label": "选择模版",
                        onChange: (event) =>
                          setCreateInstanceTemplateId(event.target.value),
                      },
                      ...creatableTemplates.map((item) =>
                        h(
                          "option",
                          { value: item.id, key: item.id },
                          `${item.name}（${
                            item.source === "platform" ? "平台模版" : "个人模版"
                          }）`,
                        ),
                      ),
                    ),
                  ),
                  h(
                    "label",
                    { className: "pmtm-field" },
                    h("span", { className: "label" }, "AI伙伴名称（可选）"),
                    h("input", {
                      type: "text",
                      className: "pmtm-input",
                      value: createInstanceName,
                      maxLength: 120,
                      placeholder: "留空则沿用模版名称",
                      "aria-label": "AI伙伴名称",
                      onChange: (event) =>
                        setCreateInstanceName(event.target.value),
                    }),
                  ),
                ),
                h(
                  "div",
                  { className: "pmtm-dialog-foot" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary",
                      onClick: () => setCreateInstanceOpen(false),
                    },
                    "取消",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn",
                      disabled:
                        busy ||
                        createInstanceTemplateId === "" ||
                        createInstanceWorkspaceId === "",
                      onClick: () => void createInstance(),
                    },
                    busy ? "创建中…" : "创建 AI伙伴",
                  ),
                ),
              ),
            )
          : null,
        assignOpen
          ? h(
              "div",
              {
                className: "pmtm-mask",
                onClick: (event) => {
                  if (event.target === event.currentTarget) {
                    setAssignOpen(false);
                    setAssignCreateOpen(false);
                    setAssignCreateForm(null);
                  }
                },
              },
              h(
                "div",
                {
                  className: "pmtm-dialog",
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-label": `选择任务安排给 ${selected?.name ?? ""}`,
                },
                h(
                  "div",
                  { className: "pmtm-dialog-head" },
                  h(
                    "h2",
                    null,
                    assignCreateOpen
                      ? `新建任务并安排给 ${selected?.name ?? ""}`
                      : `选择任务安排给 ${selected?.name ?? ""}`,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn small",
                      onClick: () => {
                        if (assignCreateOpen) {
                          setAssignCreateOpen(false);
                          setAssignCreateForm(null);
                        } else {
                          openAssignCreate();
                        }
                      },
                    },
                    assignCreateOpen ? "返回任务列表" : "新建任务",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      "aria-label": "关闭",
                      onClick: () => {
                        setAssignOpen(false);
                        setAssignCreateOpen(false);
                        setAssignCreateForm(null);
                      },
                    },
                    "×",
                  ),
                ),
                h(
                  "div",
                  { className: "pmtm-dialog-body" },
                  assignCreateOpen && assignCreateForm !== null
                    ? h(
                        "div",
                        {
                          style: {
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 12,
                          },
                        },
                        h(
                          "label",
                          {
                            className: "pmtm-field",
                            style: { gridColumn: "1 / -1" },
                          },
                          h("span", { className: "label" }, "标题"),
                          h("input", {
                            className: "pmtm-input",
                            value: assignCreateForm.title,
                            required: true,
                            "aria-label": "新任务标题",
                            onChange: (event) =>
                              setAssignCreateForm((current) =>
                                current === null
                                  ? current
                                  : { ...current, title: event.target.value },
                              ),
                          }),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "类型"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              "aria-label": "新任务类型",
                              value: assignCreateForm.type,
                              onChange: (event) =>
                                setAssignCreateForm((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        type: event.target.value,
                                      },
                                ),
                            },
                            h("option", { value: "任务" }, "任务"),
                            h("option", { value: "缺陷" }, "缺陷"),
                            h("option", { value: "评审" }, "评审"),
                          ),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "项目（必填）"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              "aria-label": "新任务项目",
                              value: assignCreateForm.workspaceId,
                              required: true,
                              onChange: (event) =>
                                setAssignCreateForm((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        workspaceId: event.target.value,
                                      },
                                ),
                            },
                            h(
                              "option",
                              { value: "" },
                              workspaces.length === 0
                                ? "暂无可用项目"
                                : "请选择项目",
                            ),
                            ...workspaces
                              .filter(
                                (workspace) =>
                                  workspace.isMember === true ||
                                  canManagePlatform === true,
                              )
                              .map((workspace) =>
                                h(
                                  "option",
                                  {
                                    key: workspace.id,
                                    value: workspace.id,
                                  },
                                  workspace.title ?? workspace.id,
                                ),
                              ),
                          ),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "优先级"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              "aria-label": "新任务优先级",
                              value: assignCreateForm.priority,
                              onChange: (event) =>
                                setAssignCreateForm((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        priority: event.target.value,
                                      },
                                ),
                            },
                            h("option", { value: "P1" }, "P0"),
                            h("option", { value: "P2" }, "P1"),
                            h("option", { value: "P3" }, "P2"),
                          ),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "初始状态"),
                          h(
                            "select",
                            {
                              className: "pmtm-select",
                              "aria-label": "新任务初始状态",
                              value: assignCreateForm.status,
                              onChange: (event) =>
                                setAssignCreateForm((current) =>
                                  current === null
                                    ? current
                                    : {
                                        ...current,
                                        status: event.target.value,
                                      },
                                ),
                            },
                            h("option", { value: "todo" }, "待处理"),
                            h("option", { value: "progress" }, "进行中"),
                          ),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "负责人"),
                          h("input", {
                            className: "pmtm-input",
                            value: selected?.name ?? "",
                            disabled: true,
                            "aria-label": "新任务负责人",
                          }),
                        ),
                        h(
                          "label",
                          { className: "pmtm-field" },
                          h("span", { className: "label" }, "到期时间"),
                          h("input", {
                            type: "date",
                            className: "pmtm-input",
                            value: assignCreateForm.due,
                            "aria-label": "新任务到期时间",
                            onChange: (event) =>
                              setAssignCreateForm((current) =>
                                current === null
                                  ? current
                                  : { ...current, due: event.target.value },
                              ),
                          }),
                        ),
                        h(
                          "label",
                          {
                            className: "pmtm-field",
                            style: { gridColumn: "1 / -1" },
                          },
                          h("span", { className: "label" }, "描述"),
                          h("textarea", {
                            className: "pmtm-area",
                            value: assignCreateForm.description,
                            "aria-label": "新任务描述",
                            onChange: (event) =>
                              setAssignCreateForm((current) =>
                                current === null
                                  ? current
                                  : {
                                      ...current,
                                      description: event.target.value,
                                    },
                              ),
                          }),
                        ),
                        h(
                          "label",
                          {
                            className: "pmtm-field",
                            style: { gridColumn: "1 / -1" },
                          },
                          h(
                            "span",
                            { className: "label" },
                            "验收标准（每行一条）",
                          ),
                          h("textarea", {
                            className: "pmtm-area",
                            value: assignCreateForm.acceptance,
                            "aria-label": "新任务验收标准",
                            onChange: (event) =>
                              setAssignCreateForm((current) =>
                                current === null
                                  ? current
                                  : {
                                      ...current,
                                      acceptance: event.target.value,
                                    },
                              ),
                          }),
                        ),
                      )
                    : null,
                  assignCreateOpen
                    ? null
                    : h(
                        "div",
                        { className: "pmtm-search-row" },
                        h("input", {
                          value: assignQuery,
                          placeholder: "搜索任务、编号、项目、接收方或状态",
                          onChange: (event) =>
                            setAssignQuery(event.target.value),
                        }),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-search-btn",
                            "aria-label": "搜索任务",
                          },
                          "⌕",
                        ),
                      ),
                  assignCreateOpen
                    ? null
                    : h(
                        "div",
                        { className: "pmtm-filter-row" },
                        h(
                          "select",
                          {
                            "aria-label": "任务状态",
                            value: assignStatus,
                            onChange: (event) =>
                              setAssignStatus(event.target.value),
                          },
                          h("option", { value: "" }, "任务状态"),
                          h("option", { value: "todo" }, "待处理"),
                          h("option", { value: "progress" }, "进行中"),
                          h("option", { value: "review" }, "待验收"),
                        ),
                        h(
                          "select",
                          {
                            "aria-label": "优先级",
                            value: assignPriority,
                            onChange: (event) =>
                              setAssignPriority(event.target.value),
                          },
                          h("option", { value: "" }, "优先级"),
                          h("option", { value: "P1" }, "P0"),
                          h("option", { value: "P2" }, "P1"),
                          h("option", { value: "P3" }, "P2"),
                        ),
                        h(
                          "select",
                          {
                            "aria-label": "项目名称",
                            value: assignProject,
                            onChange: (event) =>
                              setAssignProject(event.target.value),
                          },
                          h("option", { value: "" }, "项目名称"),
                          ...[
                            ...new Set(
                              assignTasks.map((task) => task.workspaceTitle),
                            ),
                          ].map((title) =>
                            h("option", { value: title, key: title }, title),
                          ),
                        ),
                        h(
                          "span",
                          { className: "pmtm-result-count" },
                          `${String(assignCandidates.length)} 个可选任务`,
                        ),
                      ),
                  assignCreateOpen
                    ? null
                    : h(
                        "div",
                        { className: "pmtm-assign-list" },
                        assignCandidates.length === 0
                          ? h(
                              "div",
                              { className: "pmtm-empty" },
                              "没有可安排的现有任务。",
                            )
                          : assignCandidates.map((task) => {
                              const checked = assignSelected.includes(task.id);
                              return h(
                                "button",
                                {
                                  key: task.id,
                                  type: "button",
                                  className: `pmtm-assign-item${checked ? " selected" : ""}`,
                                  "aria-pressed": checked,
                                  onClick: () =>
                                    setAssignSelected((current) =>
                                      current.includes(task.id)
                                        ? current.filter((id) => id !== task.id)
                                        : [...current, task.id],
                                    ),
                                },
                                h(
                                  "span",
                                  null,
                                  h(
                                    "strong",
                                    null,
                                    `${task.id} · ${task.title}`,
                                  ),
                                  h(
                                    "span",
                                    { className: "pmtm-assign-meta" },
                                    h(
                                      "span",
                                      null,
                                      `${task.workspaceTitle ?? task.workspaceId} · 更新 ${timeShort(task.updatedAt)}`,
                                    ),
                                    h(
                                      "span",
                                      { className: `pmtm-pill ${task.status}` },
                                      STATUS_LABEL[task.status] ?? task.status,
                                    ),
                                  ),
                                ),
                                h(
                                  "span",
                                  { className: "pmtm-assign-trailing" },
                                  h(
                                    "span",
                                    { className: "pmtm-pill" },
                                    priorityLabel(task.priority),
                                  ),
                                  h(
                                    "span",
                                    {
                                      className: "pmtm-check",
                                      "aria-hidden": "true",
                                    },
                                    "✓",
                                  ),
                                ),
                              );
                            }),
                      ),
                ),
                h(
                  "div",
                  { className: "pmtm-dialog-foot" },
                  assignCreateOpen
                    ? h(
                        react.Fragment,
                        null,
                        h(
                          "span",
                          {
                            style: {
                              color: "var(--dsw-alias-label-secondary)",
                              fontSize: 12,
                            },
                          },
                          `负责人：${selected?.name ?? ""}`,
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn secondary small",
                            disabled: assignBusy,
                            onClick: () => {
                              setAssignCreateOpen(false);
                              setAssignCreateForm(null);
                            },
                          },
                          "取消",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn small",
                            disabled:
                              assignBusy ||
                              assignCreateForm === null ||
                              assignCreateForm.title.trim() === "" ||
                              assignCreateForm.workspaceId === "",
                            onClick: () => void createAssignedTask(),
                          },
                          assignBusy ? "创建中…" : "创建并派发",
                        ),
                      )
                    : h(
                        react.Fragment,
                        null,
                        h(
                          "span",
                          {
                            style: {
                              color: "var(--dsw-alias-label-secondary)",
                              fontSize: 12,
                            },
                          },
                          assignSelected.length === 0
                            ? "未选择任务"
                            : `已选择 ${String(assignSelected.length)} 个任务`,
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "pmtm-btn small",
                            disabled: assignSelected.length === 0 || assignBusy,
                            onClick: () => void confirmAssign(),
                          },
                          assignBusy ? "指派中…" : "确认指派",
                        ),
                      ),
                ),
              ),
            )
          : null,
        archiveOpen && selected !== null
          ? h(
              "div",
              {
                className: "pmtm-mask",
                onClick: (event) => {
                  if (event.target === event.currentTarget && !busy)
                    setArchiveOpen(false);
                },
              },
              h(
                "div",
                {
                  className: "pmtm-dialog",
                  role: "dialog",
                  "aria-modal": "true",
                  "aria-label": `归档 ${selected.name}`,
                },
                h(
                  "div",
                  { className: "pmtm-dialog-head" },
                  h("h2", null, `归档 ${selected.name}`),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn secondary small",
                      disabled: busy,
                      onClick: () => setArchiveOpen(false),
                    },
                    "关闭",
                  ),
                ),
                h(
                  "div",
                  {
                    className: "pmtm-dialog-body",
                    style: {
                      margin: "14px 0 18px",
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                    },
                  },
                  `归档后该 AI伙伴将从默认列表隐藏。${selected.ownerName} 将接管名下未归档且未完成的任务；历史已完成任务保持原责任人。`,
                ),
                h(
                  "div",
                  { className: "pmtm-dialog-foot" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pmtm-btn danger",
                      disabled: busy,
                      onClick: () => void archiveTeammate(),
                    },
                    busy ? "归档中…" : "确认归档",
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function TeammateGlobalPage(props) {
      const route = props.useShellRoute?.((state) => state.route);
      if (route !== "teammates") return null;
      return h(AiTeammatesPage, props);
    }

    exports.inject = ["slots"];
    // 仅供构建期单元测试使用的纯函数出口，不参与运行时装配。
    exports.__test = {
      runtimeTabs: () => RUNTIME_TABS.map((tab) => ({ ...tab })),
      sortPlanTasks,
      planStoragePriority,
      groupTeammateTemplates,
      markdownTableCells,
      isMarkdownTableSeparator,
      runtimeDetailEditPolicy,
      externalRuntimeStatusLabel,
      splitExternalRuntimes,
      teammateExecutionPill,
      externalRuntimeOptions,
      unavailableBoundRuntime,
      parseExternalArgsText,
      formatExternalArgsText,
      parseExternalRuntimeArgs,
      compileExternalRuntimeArgs,
      externalAdvancedArgError,
      externalRuntimeFormError,
      externalCommandPreview,
      runtimeConfigurationLabels,
    };
    exports.apply = (ctx) => {
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          {
            name: "pluginmax.global",
            id: "pluginmax-teammates",
            order: 36,
          },
          TeammateGlobalPage,
        ),
      );
    };

    return module.exports;
  },
});
