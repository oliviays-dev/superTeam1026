window.__ModuleLoader__.load({
  id: "dsh-pluginmax-canary",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");

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

    const CanarySection = () => {
      const [state, setState] = react.useState({
        phase: "loading",
        detail: "",
      });

      react.useEffect(() => {
        const controller = new AbortController();
        fetch("/api/collab/canary/health", {
          cache: "no-store",
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            setState({
              phase: "ready",
              detail: `${body.domain}: ${
                body.records.at(-1)?.startedAt
                  ? formatTime(body.records.at(-1).startedAt)
                  : "unknown"
              }`,
            });
          })
          .catch((error) => {
            if (error.name !== "AbortError")
              setState({
                phase: "error",
                detail: String(error.message ?? error),
              });
          });
        return () => controller.abort();
      }, []);

      return jsxRuntime.jsx("section", {
        "data-pluginmax-canary": true,
        style: { display: "grid", gap: 12, padding: 4 },
        children: [
          jsxRuntime.jsx("h2", { children: "Pluginmax 扩展探针" }),
          jsxRuntime.jsx("p", {
            children:
              "用于验证 DSH 的 out-of-tree 插件、存储、命令、工具、HTTP 路由和设置页槽位。",
          }),
          jsxRuntime.jsx("p", {
            style:
              state.phase === "error"
                ? { color: "var(--dsw-alias-state-error-primary)" }
                : undefined,
            children:
              state.phase === "loading"
                ? "正在检查..."
                : state.phase === "ready"
                  ? `健康：${state.detail}`
                  : `失败：${state.detail}`,
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
            id: "pluginmax-canary",
            order: 90,
            label: () => "Pluginmax",
            inject: () => ({}),
          },
          () => jsxRuntime.jsx(CanarySection, {}),
        ),
      );

    return module.exports;
  },
});
