window.__ModuleLoader__.load({
  id: "dsh-collab-task",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;
    const Fragment = react.Fragment;

    const TOKEN_KEY = "pluginmax.collab.token";
    const STATUSES = [
      { key: "todo", label: "待处理" },
      { key: "progress", label: "进行中" },
      { key: "review", label: "待验收" },
      { key: "done", label: "已完成" },
      { key: "cancelled", label: "已取消" },
    ];
    const STATUS_LABEL = Object.fromEntries(
      STATUSES.map((status) => [status.key, status.label]),
    );
    /**
     * 任务优先级平移：存储仍是 P1–P3（兼容历史数据），产品口径统一显示为 P0–P2。
     * 存储 P1 = 显示 P0（最高档），P2 = P1，P3 = P2。
     */
    const PRIORITY_DISPLAY = { P1: "P0", P2: "P1", P3: "P2" };
    const priorityLabel = (value) => PRIORITY_DISPLAY[value] ?? value;
    const REASONING_EFFORT_OPTIONS = [
      { value: "minimal", label: "最低" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
      { value: "xhigh", label: "极高" },
      { value: "max", label: "最大" },
    ];

    function buildExecutionPolicy(form) {
      const allowPublicWeb = form.allowPublicWeb === true;
      const runtimeId = String(form.runtimeId ?? "").trim();
      const model = String(form.model ?? "").trim();
      const reasoningEffort = String(form.reasoningEffort ?? "").trim();
      return {
        schemaVersion: 1,
        runtime: {
          selection: runtimeId === "" ? "recommended" : "user-selected",
          allowedRuntimeIds: runtimeId === "" ? [] : [runtimeId],
          requiredCapabilities: allowPublicWeb
            ? [{ key: "search", necessity: "required" }]
            : [],
          ...(model === "" ? {} : { model }),
          ...(reasoningEffort === "" ? {} : { reasoningEffort }),
        },
        sourcePolicy: {
          allow: [
            "workspace",
            "task-attachments",
            "project-memory",
            ...(allowPublicWeb ? ["public-web", "regulatory-filing"] : []),
          ],
          deny: ["private-local-data"],
          citation: allowPublicWeb ? "required-for-factual-claims" : "none",
          requirePublishedAt: allowPublicWeb,
          requireAccessedAt: allowPublicWeb,
        },
        toolPolicy: {
          allow: [],
          deny: [],
          requireApproval:
            form.requireToolApproval === false
              ? []
              : ["fs.write", "shell.execute", "external.publish"],
        },
        evidence: {
          requirePlan: true,
          requireToolEvents: form.requireToolEvents !== false,
          requireCitations: allowPublicWeb,
          requireStructuredSubagents: false,
        },
        humanGates: [],
        budget: {},
      };
    }

    function executionPolicyForm(task) {
      const policy = task.executionPolicy;
      if (policy === undefined || policy === null) {
        return {
          allowPublicWeb: false,
          requireToolApproval: false,
          requireToolEvents: false,
          runtimeId: "",
          model: "",
          reasoningEffort: "",
        };
      }
      return {
        allowPublicWeb:
          policy.sourcePolicy?.allow?.includes("public-web") === true,
        requireToolApproval:
          Array.isArray(policy.toolPolicy?.requireApproval) &&
          policy.toolPolicy.requireApproval.length > 0,
        requireToolEvents: policy.evidence?.requireToolEvents === true,
        runtimeId: policy.runtime?.allowedRuntimeIds?.[0] ?? "",
        model: policy.runtime?.model ?? "",
        reasoningEffort: policy.runtime?.reasoningEffort ?? "",
      };
    }

    /**
     * 「重置会话」入口开关：前期用户还不熟悉这个语义，先在界面上隐藏。
     * 服务端能力（/api/collab/tasks/session/reset）保留，需要时改回 true 即可。
     */
    const SHOW_SESSION_RESET = false;

    /*
     * 「仅看已加入 / 平台全量」是跨模块偏好：任务、会议、工作流、Teammate
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

    const styles = `
      /* 页面内边距由 shell 的 .pmx-page 提供，这里不再叠加，保持与工作台一致的内容宽度。 */
      /* 会议侧边栏展开时任务区会变窄：用容器查询按「可用宽度」而不是视口宽度响应。 */
      .pmtask{min-width:0;max-width:100%;min-height:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);container-type:inline-size;}
      .pmtask *{box-sizing:border-box;}
      .pmtask-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;}
      .pmtask-head h1{margin:0;font-size:19px;line-height:1.3;}
      .pmtask-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmtask-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .pmtask-meeting-toggle{width:32px;height:32px;flex:none;display:grid;place-items:center;padding:0;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer;}
      .pmtask-meeting-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtask-meeting-toggle.active{color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 50%,transparent);}
      .pmtask-meeting-toggle svg{width:15px;height:15px;}
      .pmtask-iconbtn{width:28px;height:28px;flex:none;display:grid;place-items:center;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer;}
      .pmtask-iconbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
      .pmtask-iconbtn svg{width:14px;height:14px;}
      .pmtask-select,.pmtask-input,.pmtask-area{height:34px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 9px;min-width:0;}
      .pmtask-area{height:auto;padding:8px 9px;resize:vertical;}
      .pmtask-btn{height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:0 12px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;}
      .pmtask-btn.secondary{background:transparent;border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);}
      .pmtask-btn.danger{background:transparent;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 45%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-btn:disabled{opacity:.45;cursor:not-allowed;}
      .pmtask-icon-btn:disabled,.pmtask-tool-btn:disabled,.pmtask-assign-trigger:disabled,.pmtask-input:disabled,.pmtask-composer-input:disabled{opacity:.5;cursor:not-allowed;}
      .pmtask-locked-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6;}
      .pmtask-filter{min-width:0;max-width:100%;display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:14px;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-notice{flex:none;min-height:38px;padding:8px 10px;}
      .pmtask-search{display:flex;align-items:center;gap:6px;flex:1 1 260px;min-width:220px;}
      .pmtask-search .pmtask-input{flex:1 1 auto;}
      .pmtask-token{height:28px;border:0;border-radius:6px;padding:0 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;}
      .pmtask-token.active{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      /* 项目范围：两段式，高亮段 = 当前实际视图。 */
      .pmtask-scope-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-scope-seg .pmtask-token{height:24px;padding:0 8px;background:transparent;}
      .pmtask-scope-seg .pmtask-token:not(.active):hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
      .pmtask-board{min-width:0;max-width:100%;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:stretch;flex:1;min-height:max(420px,calc(100vh - 255px));overflow-x:auto;overscroll-behavior-inline:contain;}
      .pmtask-column{min-width:0;min-height:100%;display:flex;flex-direction:column;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-column.drop-ready{border-color:var(--dsw-alias-accent-primary,#4f8ef7);box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-column-head{display:grid;grid-template-columns:8px minmax(0,1fr) auto auto;align-items:center;gap:7px;padding:10px 10px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
      .pmtask-column-head strong{font-size:12.5px;}
      .pmtask-column-count{color:var(--dsw-alias-label-tertiary);font-size:11px;}
      .pmtask-column-add{width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
      .pmtask-column-add:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
      .pmtask-column-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
      .pmtask-column-dot.progress{background:#4f8ef7}.pmtask-column-dot.review{background:#e2a737}.pmtask-column-dot.done{background:#34d47e}.pmtask-column-dot.cancelled{background:var(--dsw-alias-state-error-primary,#e5534b)}
      .pmtask-cards{min-width:0;flex:1;display:grid;gap:7px;align-content:start;padding:8px;}
      .pmtask-card{min-width:0;display:grid;gap:7px;overflow:hidden;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;}
      .pmtask-card:hover{border-color:var(--dsw-alias-border-l4);}
      .pmtask-card.dragging{opacity:.55;}
      .pmtask-card.running{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 38%,transparent);}
      .pmtask-card.archived{opacity:.72;border-style:dashed;}
      .pmtask-card.highlighted{border-color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,var(--dsw-alias-bg-layer-2));}
      .pmtask-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:14px;}
      .pmtask-id{color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtask-spinner{width:14px;height:14px;flex:none;display:inline-block;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 38%,transparent);border-top-color:var(--dsw-alias-accent-primary,#4f8ef7);animation:pmtask-spin .8s linear infinite;}
      .pmtask-spinner.lg{width:16px;height:16px;}
      @keyframes pmtask-spin{to{transform:rotate(360deg);}}
      .pmtask-title{font-size:13px;font-weight:650;line-height:1.35;overflow-wrap:anywhere;}
      .pmtask-desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.45;}
      .pmtask-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmtask-pill{display:inline-flex;align-items:center;height:20px;border-radius:6px;padding:0 6px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));font-size:10.5px;line-height:1;white-space:nowrap;}
      .pmtask-pill.p1{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-pill.progress{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-pill.review{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 14%,transparent);color:var(--dsw-alias-state-warning-primary,#e2a737);}
      .pmtask-pill.done{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 14%,transparent);color:var(--dsw-alias-state-success-primary,#34d47e);}
      .pmtask-pill.cancelled{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-pill.archived{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 18%,transparent);color:var(--dsw-alias-label-secondary);}
      .pmtask-pill.workflow{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-pill.reassign{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 16%,transparent);color:var(--dsw-alias-state-warning-primary,#e2a737);}
      .pmtask-pill.consensus{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 14%,transparent);color:var(--dsw-alias-state-success-primary,#34d47e);}
      .pmtask-workflow-meta{display:flex;align-items:center;gap:6px;min-width:0;}
      .pmtask-workflow-node{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-workflow-action{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:12px;padding:10px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 28%,transparent);border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 7%,transparent);}
      .pmtask-workflow-action-copy{display:grid;gap:4px;min-width:0;}
      .pmtask-workflow-action-copy strong{font-size:12.5px;}
      .pmtask-workflow-action-copy span{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;}
      .pmtask-workflow-action-buttons{display:flex;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;gap:6px;}
      .pmtask-workflow-notice{display:flex;align-items:center;gap:10px;padding:10px 12px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
      .pmtask-workflow-notice strong{flex:0 0 auto;color:var(--dsw-alias-label-primary);font-size:12.5px;}
      .pmtask-workflow-notice span{flex:1;font-size:11.5px;line-height:1.5;}
      .pmtask-detail{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,36%);gap:14px;}
      .pmtask-detail-main,.pmtask-detail-side{min-width:0;display:grid;gap:12px;align-content:start;}
      .pmtask-panel{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));padding:12px;}
      .pmtask-panel h2,.pmtask-panel h3{margin:0;}
      .pmtask-panel h2{font-size:18px;}
      .pmtask-panel h3{font-size:13px;}
      .pmtask-detail-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
      .pmtask-crumb{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .pmtask-crumb b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:700;}
      .pmtask-detail-top .pmtask-assign-select{margin-left:0;}
      .pmtask-detail-top .pmtask-pill{height:auto;padding:2px 6px;border-radius:4px;font-size:10.5px;line-height:1.5;}
      .pmtask-intro{display:grid;gap:12px;margin-top:0;}
      .pmtask-intro-head{display:flex;align-items:flex-start;gap:10px;}
      .pmtask-intro-head h2{flex:1;min-width:0;margin:0;font-size:18px;line-height:1.35;overflow-wrap:anywhere;}
      .pmtask-intro p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;}
      .pmtask-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:10px;}
      .pmtask-grid-demo{grid-template-columns:repeat(3,minmax(0,1fr));}
      .pmtask-grid-demo .pmtask-field{padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-field{display:grid;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;}
      .pmtask-field strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:1.5;}
      .pmtask-review-config{align-content:start;}
      .pmtask-review-config .pmtask-check{align-items:flex-start;margin:0;color:var(--dsw-alias-label-primary);font-size:12.5px;}
      .pmtask-review-config .pmtask-check em{color:var(--dsw-alias-label-secondary);font-size:11px;}
      .pmtask-check{display:flex;align-items:flex-start;gap:7px;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.5;cursor:pointer;}
      .pmtask-check input[type=checkbox]{flex:none;width:14px;height:14px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}
      .pmtask-check[data-disabled=true]{color:var(--dsw-alias-label-tertiary);cursor:not-allowed;}
      .pmtask-check input[type=checkbox]:disabled{cursor:not-allowed;}
      .pmtask-check span{min-width:0;}
      .pmtask-check em{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;font-style:normal;line-height:1.5;}
      .pmtask-edit-form{gap:10px;}
      .pmtask-edit-title-row{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:9px;align-items:end;}
      .pmtask-edit-grow,.pmtask-edit-priority{min-width:0;}
      .pmtask-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}
      .pmtask-acceptance{display:grid;gap:8px;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-acceptance-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmtask-acceptance-head strong{color:var(--dsw-alias-label-primary);font-size:12.5px;}
      .pmtask-acceptance-head span{white-space:nowrap;font-variant-numeric:tabular-nums;}
      .pmtask-steps{display:grid;gap:6px;}
      .pmtask-step{display:flex;align-items:flex-start;gap:8px;border-radius:6px;padding:6px 7px;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}
      .pmtask-step:hover{background:var(--dsw-alias-bg-layer-1);}
      .pmtask-step input{margin:2px 0 0;accent-color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-step.done{color:var(--dsw-alias-label-secondary);text-decoration:line-through;}
      .pmtask-step.disabled{cursor:default;opacity:.72;}
      .pmtask-step.disabled:hover{background:transparent;}
      .pmtask-messages{max-height:360px;overflow:auto;display:grid;gap:8px;padding:2px;}
      .pmtask-message{border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-message.agent{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 42%,transparent);}
      .pmtask-message.streaming{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 65%,transparent);}
      .pmtask-message-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}
      .pmtask-message-head strong{font-size:12.5px;font-weight:700;}
      .pmtask-run-role{flex:none;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:650;line-height:1.4;}
      .pmtask-run-role.owner{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-run-role.assist{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 14%,transparent);color:var(--dsw-alias-state-warning-primary,#e2a737);}
      .pmtask-run-role.fyi{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
      .pmtask-message-body{font-size:12.5px;line-height:1.55;white-space:pre-wrap;}
      .pmtask-stream-caret{display:inline-block;width:6px;height:13px;margin-left:4px;vertical-align:-2px;background:var(--dsw-alias-accent-primary,#4f8ef7);animation:pmtask-blink 1s steps(1) infinite;}
      @keyframes pmtask-blink{50%{opacity:0;}}
      .pmtask-comment{display:grid;gap:6px;padding:9px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}
      .pmtask-comment:last-child{border-bottom:0;}
      .pmtask-reply{margin-left:20px;padding:7px 8px;border-left:2px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);}
      .pmtask-compose{display:grid;gap:7px;margin-top:10px;}
      .pmtask-compose-toolbar{position:relative;display:flex;align-items:center;gap:6px;}
      .pmtask-icon-btn{width:30px;height:30px;display:inline-grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;cursor:pointer;}
      .pmtask-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
      .pmtask-mention-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:35;width:min(330px,100%);max-height:280px;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 14px 34px rgba(0,0,0,.18);}
      .pmtask-mention-group{padding:7px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:650;}
      .pmtask-mention-item{width:100%;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:8px;border:0;border-radius:6px;padding:7px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;font:inherit;cursor:pointer;}
      .pmtask-mention-item:hover{background:var(--dsw-alias-bg-layer-2);}
      .pmtask-mention-item strong,.pmtask-mention-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-mention-item strong{font-size:12px;}
      .pmtask-mention-item small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtask-mention-empty{padding:14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmtask-avatar{width:26px;height:26px;display:grid;place-items:center;border-radius:7px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700;}
      .pmtask-avatar.agents{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-avatar.roles{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 14%,transparent);color:var(--dsw-alias-state-warning-primary,#e2a737);}
      .pmtask-ring{width:20px;height:20px;display:grid;place-items:center;padding:2px;border-radius:50%;flex:none;background:conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff);box-shadow:0 0 0 1px rgba(139,108,255,.26);}
      .pmtask-ring.platform{background:#63b8ff;box-shadow:0 0 0 1px rgba(99,184,255,.55);}
      .pmtask-ring.lg{width:26px;height:26px;}
      .pmtask-avatar-art{width:100%;height:100%;display:block;overflow:hidden;border:2px solid var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border-radius:50%;background:#20242a;object-fit:cover;}
      .pmtask-assignee{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:150px;color:var(--dsw-alias-label-secondary);}
      .pmtask-assignee-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;}
      .pmtask-attachments{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .pmtask-attachment{display:inline-flex;align-items:center;gap:5px;max-width:260px;height:24px;border-radius:6px;padding:0 6px 0 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmtask-attachment>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-attachment button{width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;}
      .pmtask-compose-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;}
      .pmtask-compose-hint{margin-right:auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmtask-mention{border-radius:4px;padding:0 3px;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-timeline{display:grid;gap:7px;}
      .pmtask-event{display:grid;grid-template-columns:70px minmax(0,1fr);gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary);}
      .pmtask-event.error{color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-link{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-menu{position:relative;}
      .pmtask-assign-trigger{height:auto;min-height:32px;display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:400;cursor:pointer;}
      .pmtask-assign-trigger-content{min-width:0;display:flex;align-items:center;gap:7px;flex:1;}
      .pmtask-assign-trigger-copy{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-menu-list{position:absolute;right:auto;left:0;top:calc(100% + 5px);z-index:20;min-width:200px;max-height:300px;overflow-y:auto;display:grid;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 14px 34px rgba(0,0,0,.28);}
      .pmtask-menu-list button{min-height:28px;text-align:left;border:0;border-radius:4px;padding:5px 7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;}
      .pmtask-menu-list button:hover{background:var(--dsw-alias-bg-layer-3);}
      .pmtask-receiver-option{display:flex;align-items:center;gap:8px;min-width:220px;}
      .pmtask-filter-menu{flex:none;}
      .pmtask-filter-trigger{width:156px;justify-content:flex-start;}
      .pmtask-filter-trigger-prefix{flex:none;white-space:nowrap;}
      .pmtask-filter-trigger-copy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
      .pmtask-filter-chevron{width:16px;height:16px;flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);}
      .pmtask-filter-option{width:100%;display:flex;align-items:center;gap:8px;padding:6px 7px;}
      .pmtask-filter-option-copy{min-width:0;flex:1;display:grid;gap:1px;}
      .pmtask-filter-option-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-filter-option-meta{color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtask-filter-group{padding:8px 7px 2px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:650;}
      .pmtask-filter-symbol{width:20px;height:20px;flex:none;display:grid;place-items:center;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700;}
      .pmtask-filter-symbol.all{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 13%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-filter-symbol.p1{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-receiver-option-copy{min-width:0;display:grid;gap:1px;}
      .pmtask-receiver-option-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-receiver-option-meta{color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtask-receiver-option .pmtask-avatar,.pmtask-receiver-option .pmtask-ring{width:24px;height:24px;}
      .pmtask-detail{display:block;}
      .pmtask-detail-page,.pmtask-detail-page *{box-sizing:border-box;}
      .pmtask-detail-page{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));font-size:14px;line-height:1.5;}
      .pmtask-detail-top{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);margin-bottom:0;}
      .pmtask-back-btn{height:auto;min-height:30px;padding:4px 9px;font-size:11px;border-width:1px;}
      .pmtask-detail-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,36%);min-height:520px;}
      .pmtask-detail-main{min-width:0;display:block;padding:16px;border-right:1px solid var(--dsw-alias-border-l2);}
      .pmtask-detail-side{min-width:0;display:flex;flex-direction:column;gap:0;padding:0 18px 18px;background:transparent;}
      .pmtask-side-section{min-width:0;max-width:100%;margin-top:18px;padding:14px 0 0;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-side-section h3{margin:0 0 8px;font-size:13px;}
      .pmtask-assign-select{position:relative;flex:none;}
      .pmtask-assign-select .pmtask-assign-trigger{min-width:190px;max-width:270px;justify-content:space-between;}
      .pmtask-assign-trigger.pending{border-color:var(--dsw-alias-accent-primary,#4f8ef7);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-assign-actions{flex:none;display:flex;align-items:center;gap:5px;}
      .pmtask-confirm-btn{height:24px;padding:0 7px;font-size:11px;}
      .pmtask-detail-main .pmtask-intro{gap:12px;margin-top:0;margin-bottom:14px;}
      .pmtask-intro-head .pmtask-pill{height:auto;padding:2px 6px;border-radius:4px;font-size:10.5px;line-height:1.5;}
      .pmtask-intro-head .pmtask-icon-btn{flex:none;width:30px;height:30px;margin-top:-2px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-intro-head .pmtask-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);}
      .pmtask-intro-head .pmtask-icon-btn svg{width:15px;height:15px;}
      .pmtask-detail-main .pmtask-grid{margin-top:0;}
      .pmtask-detail-main .pmtask-actions{gap:7px;margin-top:0;}
      .pmtask-detail-main .pmtask-actions .pmtask-btn{height:auto;min-height:24px;padding:2px 7px;font-size:11px;font-weight:400;border-width:1px;}
      .pmtask-composer{position:relative;margin-top:0;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:visible;}
      .pmtask-composer-toolbar{position:relative;display:flex;align-items:center;gap:5px;padding:8px 10px 0;}
      .pmtask-tool-btn{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;cursor:pointer;}
      .pmtask-tool-btn:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);}
      .pmtask-tool-btn svg{width:15px;height:15px;}
      .pmtask-composer-input{width:100%;min-height:92px;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:1.5;padding:10px;resize:vertical;}
      .pmtask-composer-input:focus{outline:none;}
      .pmtask-composer .pmtask-attachments{padding:0 10px 7px;}
      .pmtask-composer-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px 10px;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-composer-footer .pmtask-btn{height:32px;padding:0 12px;font-size:12px;}
      .pmtask-composer-footer .pmtask-btn.secondary{height:auto;min-height:24px;padding:2px 7px;font-size:11px;font-weight:400;border-width:1px;}
      .pmtask-composer .pmtask-mention-menu{left:72px;top:38px;bottom:auto;width:min(320px,calc(100% - 84px));}
      .pmtask-detail-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px;}
      .pmtask-history-head h3{margin:0 0 8px;font-size:13px;}
      .pmtask-history-head span{color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;}
      .pmtask-history{display:grid;gap:12px;max-height:240px;overflow-y:auto;padding-right:3px;}
      .pmtask-history-message,.pmtask-history-event{display:grid;grid-template-columns:28px minmax(0,1fr);gap:9px;align-items:start;}
      .pmtask-history-message>*,.pmtask-history-event>*{min-width:0;}
      .pmtask-history-message .pmtask-avatar,.pmtask-history-message .pmtask-ring,.pmtask-history-event .pmtask-event-avatar{width:28px;height:28px;border-radius:50%;}
      .pmtask-history-comment .pmtask-avatar{width:22px;height:22px;border-radius:50%;font-size:9px;}
      .pmtask-reply-list .pmtask-avatar{width:20px;height:20px;border-radius:50%;font-size:9px;}
      .pmtask-avatar.human{background:#2f9e66;color:#fff;}
      .pmtask-avatar.agent{background:#6f53d6;color:#fff;}
      .pmtask-avatar.role{border-radius:5px;background:#37618f;color:#fff;}
      .pmtask-avatar.system{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
      .pmtask-event-avatar{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;}
      .pmtask-event-copy{min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;padding-top:5px;overflow-wrap:anywhere;}
      .pmtask-event-copy time{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:2px;}
      .pmtask-bubble{margin-top:4px;padding:10px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;}
      .pmtask-run-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:6px;padding:7px 9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45;}
      .pmtask-run-meta-item{display:inline-flex;align-items:baseline;gap:4px;min-width:0;max-width:100%;}
      .pmtask-run-meta-item strong{flex:none;color:var(--dsw-alias-label-tertiary);font-size:9.5px;font-weight:650;letter-spacing:0;text-transform:uppercase;}
      .pmtask-run-meta-item span{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
      .pmtask-run-summary{display:grid;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-run-summary-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;padding:7px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1.5;}
      .pmtask-run-summary-row:last-child{border-bottom:0;}
      .pmtask-run-summary-row span{color:var(--dsw-alias-label-tertiary);}
      .pmtask-run-summary-row strong{min-width:0;color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere;}
      .pmtask-run-summary-empty{padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;text-align:center;}
      .pmtask-run-summary-unavailable{display:grid;gap:6px;padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;}
      .pmtask-run-summary-unavailable strong{color:var(--dsw-alias-label-primary);font-size:11.5px;}
      .pmtask-markdown{display:grid;gap:7px;min-width:0;overflow-wrap:anywhere;}
      .pmtask-md-heading{margin:0;font-weight:700;line-height:1.35;color:var(--dsw-alias-label-primary);}
      .pmtask-md-paragraph{margin:0;white-space:pre-wrap;}
      .pmtask-md-list{margin:0;padding-left:20px;display:grid;gap:4px;}
      .pmtask-md-list li{padding-left:1px;}
      .pmtask-md-code{padding:1px 4px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);font:0.92em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
      .pmtask-md-pre{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);overflow-x:auto;}
      .pmtask-md-pre code{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;}
      .pmtask-md-quote{margin:0;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);}
      .pmtask-md-hr{margin:3px 0;border:0;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-md-table-wrap{max-width:100%;overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-md-table{width:100%;border-collapse:collapse;font-size:12px;line-height:1.5;}
      .pmtask-md-table th,.pmtask-md-table td{padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l2);border-right:1px solid var(--dsw-alias-border-l2);text-align:left;vertical-align:top;}
      .pmtask-md-table th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:700;white-space:nowrap;}
      .pmtask-md-table tr:last-child td{border-bottom:0;}
      .pmtask-md-table th:last-child,.pmtask-md-table td:last-child{border-right:0;}
      .pmtask-comment-list{display:grid;gap:8px;margin-top:10px;}
      .pmtask-history-comment{padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-reply-list{display:grid;gap:7px;margin-top:8px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);}
      .pmtask-reply-form,.pmtask-comment-form{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;gap:6px;margin-top:8px;}
      .pmtask-comment-guide{grid-column:1/-1;margin:0 0 1px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;}
      .pmtask-comment-consensus{grid-column:1/-1;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-comment-consensus>span{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}
      .pmtask-comment-consensus em{display:inline;min-width:0;flex:1 1 140px;margin:0;}
      .pmtask-reply-form .pmtask-input,.pmtask-comment-form .pmtask-input{height:auto;padding:7px 9px;border-width:1px;line-height:1.5;}
      .pmtask-reply-form .pmtask-input{min-height:28px;font-size:11.5px;}
      .pmtask-comment-form{gap:7px;margin-top:9px;}
      .pmtask-comment-form .pmtask-input{font-size:14px;}
      .pmtask-reply-form .pmtask-btn,.pmtask-comment-form .pmtask-btn{height:auto;min-height:24px;padding:2px 7px;font-size:11px;font-weight:400;border-width:1px;}
      .pmtask-timeline{display:grid;gap:10px;}
      .pmtask-timeline-event{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmtask-timeline-event time{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;}
      .pmtask-side-section .pmtask-link{padding:9px;border-radius:6px;}
      .pmtask-side-section .pmtask-link+.pmtask-link{margin-top:7px;}
      .pmtask-side-section .pmtask-btn{height:auto;min-height:24px;padding:2px 7px;font-size:11px;font-weight:400;border-width:1px;}
      .pmtask-side-empty{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;white-space:pre-wrap;}
      .pmtask-live-head{display:flex;align-items:center;gap:7px;margin-bottom:9px;}
      .pmtask-live-head h3{margin:0;font-size:13px;}
      .pmtask-live-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-accent-primary,#4f8ef7);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);}
      .pmtask-live-output{max-height:320px;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;}
      .pmtask-doc-list{display:grid;gap:6px;max-height:260px;overflow:auto;padding-right:2px;}
      .pmtask-doc{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-doc-info{min-width:0;}
      .pmtask-doc-name{display:flex;align-items:center;gap:5px;max-width:100%;border:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;text-align:left;cursor:pointer;}
      .pmtask-doc-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-doc-name:hover span{text-decoration:underline;}
      .pmtask-doc-name:disabled{cursor:default;color:var(--dsw-alias-label-secondary);}
      .pmtask-doc-name:disabled:hover span{text-decoration:none;}
      .pmtask-doc-meta{margin-top:3px;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-doc-kind{flex:none;border-radius:4px;padding:1px 5px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 18%,transparent);color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:600;}
      .pmtask-doc-empty{padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;text-align:center;}
      .pmtask-execution-record{min-width:0;max-width:100%;overflow:hidden;}
      .pmtask-execution-runs{min-width:0;max-width:100%;display:grid;gap:6px;margin-bottom:8px;}
      .pmtask-execution-runs-label{color:var(--dsw-alias-label-tertiary);font-size:10px;}
      .pmtask-execution-round-picker{min-width:0;max-width:100%;display:grid;gap:6px;}
      .pmtask-execution-round-trigger{width:100%;max-width:100%;min-width:0;min-height:34px;display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:0 9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
      .pmtask-execution-round-trigger:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));}
      .pmtask-execution-round-trigger span:first-child{min-width:0;max-width:100%;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-execution-round-trigger-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;}
      .pmtask-round-caret{width:7px;height:7px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px);}
      .pmtask-execution-round-trigger[aria-expanded="true"] .pmtask-round-caret{transform:rotate(225deg) translate(-2px,-2px);}
      .pmtask-execution-round-menu{width:100%;max-width:100%;min-width:0;display:grid;gap:7px;max-height:430px;overflow-x:hidden;overflow-y:auto;padding:2px;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-execution-round-option{width:100%;max-width:100%;min-width:0;display:grid;gap:7px;overflow:hidden;padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;}
      .pmtask-execution-round-option.selected{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 8%,var(--dsw-alias-bg-layer-2));}
      .pmtask-execution-round-option-head{width:100%;max-width:100%;min-width:0;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;overflow-wrap:anywhere;border:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:650;line-height:1.45;text-align:left;white-space:normal;cursor:pointer;}
      .pmtask-execution-round-option-head:hover{color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-execution-round-option-title{min-width:0;overflow-wrap:anywhere;}
      .pmtask-execution-round-option-status{white-space:nowrap;}
      .pmtask-execution-round-option-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;}
      .pmtask-round-instruction{width:100%;max-width:100%;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px;overflow:hidden;padding:8px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmtask-round-instruction-label{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500;}
      .pmtask-round-instruction-text{display:block;width:100%;min-width:0;max-width:100%;max-height:4.5em;flex:none;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;white-space:pre-wrap;}
      .pmtask-round-instruction.expanded .pmtask-round-instruction-text{max-height:none;overflow:visible;}
      .pmtask-round-instruction-toggle{justify-self:start;border:0;padding:0;background:transparent;color:var(--dsw-alias-accent-primary,#4f8ef7);font:inherit;font-size:10px;cursor:pointer;}
      .pmtask-execution-blocks{display:grid;gap:14px;margin-top:12px;}
      .pmtask-execution-block{display:grid;gap:8px;padding-top:13px;border-top:1px solid var(--dsw-alias-border-l2);}
      .pmtask-execution-block:first-child{padding-top:0;border-top:0;}
      .pmtask-execution-block h4{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:700;}
      .pmtask-execution-block h4 span{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;text-overflow:ellipsis;white-space:nowrap;}
      .pmtask-plan-list{display:grid;gap:6px;margin:0;padding:0;list-style:none;}
      .pmtask-plan-step{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:start;gap:7px;padding:7px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.45;}
      .pmtask-plan-step-dot{width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
      .pmtask-plan-step.active .pmtask-plan-step-dot{background:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmtask-plan-step.completed .pmtask-plan-step-dot{background:var(--dsw-alias-state-success-primary,#34d47e);}
      .pmtask-plan-step.failed .pmtask-plan-step-dot{background:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmtask-plan-step-title{min-width:0;overflow-wrap:anywhere;}
      .pmtask-plan-step-status{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:10.5px;}
      .pmtask-execution-events{display:grid;gap:5px;margin:0;padding:0;list-style:none;}
      .pmtask-execution-event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:6px 7px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45;}
      .pmtask-execution-event strong{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-weight:500;}
      .pmtask-execution-event time{color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
      .pmtask-gate{display:grid;gap:8px;padding:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 40%,transparent);border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2a737) 8%,transparent);}
      .pmtask-gate strong{font-size:12px;}
      .pmtask-gate p{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;}
      .pmtask-gate-actions{display:flex;gap:7px;flex-wrap:wrap;}
      .pmtask-gate-actions .pmtask-btn{height:30px;padding:0 10px;font-size:11.5px;}
      .pmtask-comment-list>.pmtask-empty,.pmtask-history>.pmtask-empty{padding:36px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:13px;}
      .pmtask-detail-section>.pmtask-empty{padding:28px 10px;}
      .pmtask-mask{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.24);backdrop-filter:blur(2px);}
      .pmtask-modal{width:min(620px,calc(100vw - 40px));max-height:min(720px,calc(100vh - 40px));overflow:auto;display:grid;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 22px 54px rgba(0,0,0,.22);}
      .pmtask-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}
      .pmtask-modal-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;}
      .pmtask-execution-overrides{grid-column:1 / -1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);}
      .pmtask-execution-runtime{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:34px;padding:0 9px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere;cursor:default;user-select:text;}
      .pmtask-readonly-badge{flex:none;padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.2;}
      .pmtask-span-2{grid-column:1 / -1;}
      .pmtask-modal.pmtask-confirm{width:min(440px,calc(100vw - 40px));gap:10px;}
      .pmtask-modal.pmtask-confirm h2{margin:0;font-size:15px;font-weight:700;}
      .pmtask-confirm-text{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.65;overflow-wrap:anywhere;}
      .pmtask-reject-note{min-height:112px;resize:vertical;line-height:1.6;}
      .pmtask-confirm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;}
      .pmtask-confirm-actions .pmtask-btn{height:32px;padding:0 12px;font-size:12px;}
      .pmtask-btn.danger-solid{background:var(--dsw-alias-state-error-primary,#e5534b);color:#fff;}
      .pmtask-empty{padding:46px 18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
      @media(max-width:900px){.pmtask-detail-layout{grid-template-columns:1fr}.pmtask-detail-main{border-right:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);}.pmtask-detail-top .pmtask-crumb{flex-basis:100%;order:3}.pmtask-grid-demo{grid-template-columns:repeat(2,minmax(0,1fr));}}
      @media(max-width:700px){.pmtask-head{flex-direction:column}.pmtask-modal-grid,.pmtask-execution-overrides{grid-template-columns:1fr}}
      @container (max-width:900px){.pmtask-board{grid-template-columns:repeat(4,220px);}}
    `;

    function token() {
      return window.localStorage.getItem(TOKEN_KEY);
    }

    async function request(path, options = {}) {
      const headers = { ...options.headers };
      const current = token();
      if (current !== null) headers.authorization = `Bearer ${current}`;
      if (options.body !== undefined)
        headers["content-type"] = "application/json";
      const response = await fetch(path, {
        ...options,
        headers,
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
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

    function initials(value) {
      return String(value ?? "?")
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }

    // 与 AI Teammates 页保持一致的头像：平台=纯蓝环，个人=炫彩环。
    const AVATAR_PRESETS = [
      {
        id: "sky",
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
        bg: "#d9f4ff",
        shirt: "#2f84a8",
        skin: "#ce9874",
        hair: "#164f6f",
        accent: "#4fc3e8",
        hairStyle: "bun",
        glasses: true,
      },
    ];

    function avatarHair(preset) {
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
          className: "pmtask-avatar-art",
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
        ...avatarHair(preset),
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
          className: "pmtask-avatar-art",
          viewBox: "0 0 64 64",
          "aria-hidden": "true",
        },
        children,
      );
    }

    function ReceiverAvatar({ option, kind, name, className }) {
      if (kind === "agent") {
        const source = option?.source === "personal" ? "personal" : "platform";
        return h(
          "span",
          {
            className: `pmtask-ring ${source}${className === undefined ? "" : ` ${className}`}`,
            title: name,
            role: "img",
            "aria-label": name,
          },
          avatarArt(option?.avatar ?? "", "art"),
        );
      }
      return h(
        "span",
        {
          className: `pmtask-avatar ${kind === "role" ? "role" : "human"}${className === undefined ? "" : ` ${className}`}`,
          title: name,
        },
        kind === "role" ? "R" : initials(name),
      );
    }

    function localTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function statusLabel(status) {
      return STATUS_LABEL[status] ?? status;
    }

    function planVisibilityLabel(value) {
      return (
        {
          structured: "结构化",
          summary: "摘要",
          opaque: "不透明",
        }[value] ??
        value ??
        "未知"
      );
    }

    function planSourceLabel(value) {
      return (
        {
          explicit: "Agent 制定",
          derived: "根据事件整理",
          unavailable: "不可用",
        }[value] ??
        value ??
        "未知"
      );
    }

    function gateEnforcementLabel(value) {
      return (
        {
          blocking: "执行前阻断",
          cooperative: "协作式暂停",
          "observe-only": "仅执行后观察",
        }[value] ??
        value ??
        "未知"
      );
    }

    function executionMetaLabel(value) {
      if (typeof value === "boolean") return value ? "是" : "否";
      if (value === null) return "未知";
      const text = typeof value === "string" ? value.trim() : "";
      return text === "" || text === "unknown" ? "未采集" : text;
    }

    function RunExecutionMeta({ execution }) {
      if (execution === undefined || execution === null) return null;
      return h(
        "div",
        { className: "pmtask-run-meta", "aria-label": "运行信息" },
        ...[
          ["Provider", execution.provider],
          ["模型", execution.model],
          ["推理强度", execution.reasoningEffort],
          ["Runtime", execution.runtime],
          ["版本", execution.runtimeVersion],
          ["认证", execution.authMode],
          ["沙箱", execution.sandbox],
          ["搜索启用", execution.searchEnabled],
          ["网络", execution.networkAccess],
          ["实际搜索", execution.searchUsed],
          ["计划", planVisibilityLabel(execution.planVisibility)],
          ["工具门禁", gateEnforcementLabel(execution.gateEnforcement)],
        ].map(([label, value]) =>
          h(
            "span",
            { className: "pmtask-run-meta-item", key: label },
            h("strong", null, label),
            h("span", null, executionMetaLabel(value)),
          ),
        ),
      );
    }

    function RunExecutionSummary({ execution, state }) {
      if (execution === undefined || execution === null) {
        if (state === "loading" || state === "idle") {
          return h(
            "div",
            {
              className: "pmtask-run-summary-empty",
              role: "status",
            },
            "正在读取运行信息…",
          );
        }
        return h(
          "div",
          {
            className: "pmtask-run-summary-unavailable",
            role: "status",
          },
          h("strong", null, "该轮未记录运行元数据"),
          h(
            "span",
            null,
            "关联的 Agent Run 不存在，或该轮执行早于运行信息采集。任务结果和执行过程仍可查看。",
          ),
        );
      }
      return h(
        "div",
        { className: "pmtask-run-summary", "aria-label": "任务运行信息" },
        ...[
          ["Provider", execution.provider],
          ["模型", execution.model],
          ["推理强度", execution.reasoningEffort],
          ["Runtime", execution.runtime],
          ["版本", execution.runtimeVersion],
          ["认证", execution.authMode],
          ["沙箱", execution.sandbox],
          ["搜索启用", execution.searchEnabled],
          ["网络", execution.networkAccess],
          ["实际搜索", execution.searchUsed],
          ["计划", planVisibilityLabel(execution.planVisibility)],
          ["工具门禁", gateEnforcementLabel(execution.gateEnforcement)],
        ].map(([label, value]) =>
          h(
            "div",
            { className: "pmtask-run-summary-row", key: label },
            h("span", null, label),
            h("strong", null, executionMetaLabel(value)),
          ),
        ),
      );
    }

    function isSettledStatus(status) {
      return status === "done" || status === "cancelled";
    }

    const RUNNING_MESSAGE_STATES = ["queued", "running", "waiting_input"];
    const RUN_STATUS_LABEL = {
      pending: "待执行",
      active: "进行中",
      completed: "已完成",
      failed: "失败",
      queued: "排队中",
      running: "执行中",
      waiting_input: "待补充",
      succeeded: "已完成",
      timeout: "超时",
      cancelled: "已取消",
      interrupted: "已中断",
    };

    function runStatusLabel(status) {
      return RUN_STATUS_LABEL[status] ?? status ?? "未知";
    }

    function runRoleLabel(role) {
      if (role === "owner") return "主执行";
      if (role === "assist") return "协作";
      if (role === "fyi") return "FYI";
      return "参与";
    }

    function taskHasActiveRun(task) {
      return (task?.messages ?? []).some(
        (message) =>
          message?.runId !== undefined &&
          RUNNING_MESSAGE_STATES.includes(message.state),
      );
    }

    function workflowSourceLabel() {
      return "工作流";
    }

    function workflowReviewLabel(task) {
      if (task?.workflow?.approvalPolicy !== undefined) return "审批动作驱动";
      if (task?.autoApproveReview === true) return "提交后自动通过";
      return task?.workflow?.reviewRequired === false
        ? "无需 Review"
        : "需要人工 Review";
    }

    function isArchived(task) {
      const value = task?.archivedAt;
      return value !== undefined && value !== null && value !== "";
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const separator = result.indexOf(",");
          resolve(separator === -1 ? result : result.slice(separator + 1));
        };
        reader.onerror = () =>
          reject(new Error(`读取附件失败：${file.name ?? "未知文件"}`));
        reader.readAsDataURL(file);
      });
    }

    /**
     * 执行身份挂在哪个用户名下。必须写出来：「责任人=我」的口径包含
     * 「指派给我的分身 / 我所在角色」，不显示归属，任务看起来就像别人的。
     */
    function agentOwnerLabel(item) {
      return item?.ownerName && item.ownerAuthUserId !== undefined
        ? `（${item.ownerName}）`
        : "";
    }

    function receiverDisplay(task, directory) {
      if (task.receiverState === "needs_reassignment") {
        const previous = task.previousReceiver?.name;
        return previous ? `需改派（原角色：${previous}）` : "需改派";
      }
      if (task.receiverType === "unassigned") return "待指派";
      if (task.receiverType === "role" && task.status === "todo") {
        return `角色待认领（${task.receiverName ?? task.receiverId ?? "角色"}）`;
      }
      const name = task.receiverName ?? task.receiverId ?? "待指派";
      const receiver =
        task.receiverType === "agent"
          ? directory?.agents.find(
              (item) =>
                item.id === task.receiverId ||
                (item.employeeId !== undefined &&
                  item.employeeId === task.receiverId),
            )
          : undefined;
      return `${name}${agentOwnerLabel(receiver)}`;
    }

    function receiverKindLabel(type) {
      return type === "agent"
        ? "AI伙伴 / 分身"
        : type === "role"
          ? "角色认领"
          : "人员";
    }

    function receiverOptionLabel(item) {
      const name = item?.name ?? "";
      return item?.type === "agent" ? `${name}${agentOwnerLabel(item)}` : name;
    }

    /**
     * 责任人命中口径。
     * scope="any"（默认）：指派给我本人、我的分身（DE / AI Teammate 实例），或我所在角色。
     * scope="self"：只认人类本人，分身和角色都不算。
     */
    function taskBelongsTo(task, currentUser, directory, scope = "any") {
      if (currentUser === null) return false;
      if (task.receiverType === "human") {
        if (task.receiverId === currentUser.id) return true;
      }
      const approverIds = task.workflow?.approverIds ?? [];
      if (approverIds.includes(currentUser.id)) return true;

      if (scope === "self") return false;
      if (task.receiverType === "agent") {
        // 老任务的责任人还是员工身份 id，目录里以 teammate 实例为准，需要按 employeeId 兜底匹配。
        const receiver = directory.agents.find(
          (item) =>
            item.id === task.receiverId ||
            (item.employeeId !== undefined &&
              item.employeeId === task.receiverId),
        );
        return receiver?.ownerAuthUserId === currentUser.id;
      }
      if (task.receiverType === "role") {
        return directory.roles.some(
          (role) =>
            role.id === task.receiverId &&
            (role.assignedUserIds ?? []).includes(currentUser.id),
        );
      }
      return false;
    }

    /**
     * 任务关注按钮由 dsh-collab-workbench 提供：服务端持久化、跨页面同步。
     * 该插件未安装时按钮不渲染，任务页保持原样。
     */
    function TaskFollowButton(props) {
      const [ready, setReady] = react.useState(
        () => typeof window.__pluginmaxFollow?.FollowButton === "function",
      );
      react.useEffect(() => {
        if (ready) return undefined;
        const onReady = () => setReady(true);
        window.addEventListener("pluginmax:follow-ready", onReady);
        return () =>
          window.removeEventListener("pluginmax:follow-ready", onReady);
      }, [ready]);
      const Button = window.__pluginmaxFollow?.FollowButton;
      if (!ready || typeof Button !== "function") return null;
      return h(Button, {
        type: "task",
        id: props.taskId,
        compact: props.compact !== false,
        workspaceId: props.workspaceId,
        workflowInstanceId: props.workflowInstanceId,
      });
    }

    function FilterDropdown({
      value,
      onChange,
      options,
      ariaLabel,
      width = 156,
    }) {
      const [open, setOpen] = react.useState(false);
      const menuRef = react.useRef(null);
      const selected = options.find((option) => option.value === value);

      react.useEffect(() => {
        if (!open) return undefined;
        const close = (event) => {
          if (menuRef.current?.contains(event.target)) return;
          setOpen(false);
        };
        const cancel = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        window.document.addEventListener("pointerdown", close);
        window.document.addEventListener("keydown", cancel);
        return () => {
          window.document.removeEventListener("pointerdown", close);
          window.document.removeEventListener("keydown", cancel);
        };
      }, [open]);

      let lastGroup = "";
      return h(
        "div",
        { className: "pmtask-menu pmtask-filter-menu", ref: menuRef },
        h(
          "button",
          {
            className: "pmtask-assign-trigger pmtask-filter-trigger",
            type: "button",
            style: { width },
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            "aria-label": ariaLabel,
            onClick: () => setOpen(!open),
          },
          h(
            "span",
            { className: "pmtask-assign-trigger-content" },
            selected?.triggerPrefix
              ? h(
                  "span",
                  { className: "pmtask-filter-trigger-prefix" },
                  selected.triggerPrefix,
                )
              : null,
            h(
              "span",
              { className: "pmtask-filter-trigger-copy" },
              selected?.triggerLabel ?? selected?.label ?? "请选择",
            ),
            h(
              "svg",
              {
                className: "pmtask-filter-chevron",
                "aria-hidden": true,
                fill: "none",
                viewBox: "0 0 24 24",
              },
              h("path", {
                d: "m6 9 6 6 6-6",
                stroke: "currentColor",
                strokeLinecap: "round",
                strokeLinejoin: "round",
                strokeWidth: 1.8,
              }),
            ),
          ),
        ),
        open
          ? h(
              "div",
              { className: "pmtask-menu-list", role: "listbox" },
              ...options.map((option, index) => {
                const group =
                  option.group !== undefined && option.group !== lastGroup
                    ? option.group
                    : "";
                lastGroup = option.group ?? lastGroup;
                return h(Fragment, { key: option.value }, [
                  group !== ""
                    ? h("div", { className: "pmtask-filter-group" }, group)
                    : null,
                  h(
                    "button",
                    {
                      className: "pmtask-filter-option",
                      type: "button",
                      role: "option",
                      "aria-selected": option.value === value,
                      onClick: () => {
                        onChange(option.value);
                        setOpen(false);
                      },
                    },
                    h(
                      "span",
                      { className: "pmtask-filter-option-copy" },
                      h(
                        "span",
                        { className: "pmtask-filter-option-name" },
                        option.label,
                      ),
                      option.description !== undefined
                        ? h(
                            "span",
                            { className: "pmtask-filter-option-meta" },
                            option.description,
                          )
                        : null,
                    ),
                  ),
                ]);
              }),
            )
          : null,
      );
    }

    function filterSymbol({ label, className = "", icon = null }) {
      return h(
        "span",
        { className: `pmtask-filter-symbol ${className}`.trim() },
        icon ?? label,
      );
    }

    function RichText({ text }) {
      const value = String(text ?? "");
      return h(
        Fragment,
        null,
        ...value
          .split(/(@[^\s，。,.!？?]+)/g)
          .filter((part) => part !== "")
          .map((part, index) =>
            part.startsWith("@")
              ? h("span", { className: "pmtask-mention", key: index }, part)
              : part,
          ),
      );
    }

    function renderInlineMarkdown(text) {
      const value = String(text ?? "");
      const nodes = [];
      const pattern =
        /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
      let cursor = 0;
      let match = pattern.exec(value);
      let index = 0;
      while (match !== null) {
        if (match.index > cursor) {
          nodes.push(
            h(RichText, {
              text: value.slice(cursor, match.index),
              key: `text-${index}`,
            }),
          );
        }
        const token = match[0];
        if (token.startsWith("`")) {
          nodes.push(
            h(
              "code",
              { className: "pmtask-md-code", key: `code-${index}` },
              token.slice(1, -1),
            ),
          );
        } else if (token.startsWith("**") || token.startsWith("__")) {
          nodes.push(
            h(
              "strong",
              { key: `strong-${index}` },
              ...renderInlineMarkdown(token.slice(2, -2)),
            ),
          );
        } else if (token.startsWith("~~")) {
          nodes.push(
            h(
              "del",
              { key: `del-${index}` },
              ...renderInlineMarkdown(token.slice(2, -2)),
            ),
          );
        } else if (token.startsWith("[")) {
          const separator = token.lastIndexOf("](");
          const label = token.slice(1, separator);
          const href = token.slice(separator + 2, -1);
          let safeHref = null;
          try {
            const url = new URL(href);
            if (url.protocol === "http:" || url.protocol === "https:")
              safeHref = url.href;
          } catch {
            safeHref = null;
          }
          nodes.push(
            safeHref === null
              ? label
              : h(
                  "a",
                  {
                    href: safeHref,
                    rel: "noopener noreferrer",
                    target: "_blank",
                    key: `link-${index}`,
                  },
                  label,
                ),
          );
        } else {
          nodes.push(
            h(
              "em",
              { key: `em-${index}` },
              ...renderInlineMarkdown(token.slice(1, -1)),
            ),
          );
        }
        cursor = match.index + token.length;
        index += 1;
        match = pattern.exec(value);
      }
      if (cursor < value.length) {
        nodes.push(
          h(RichText, { text: value.slice(cursor), key: `text-${index}` }),
        );
      }
      return nodes;
    }

    function splitTableRow(line) {
      let value = String(line ?? "").trim();
      if (value.startsWith("|")) value = value.slice(1);
      if (value.endsWith("|")) value = value.slice(0, -1);
      return value.split("|").map((cell) => cell.trim());
    }

    function isTableDelimiterRow(line) {
      if (!String(line ?? "").includes("-")) return false;
      const cells = splitTableRow(line);
      return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
    }

    function startsTable(lines, index) {
      return (
        lines[index].includes("|") &&
        index + 1 < lines.length &&
        isTableDelimiterRow(lines[index + 1])
      );
    }

    function MarkdownText({ text }) {
      const lines = String(text ?? "").split(/\r?\n/);
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.trim() === "") {
          index += 1;
          continue;
        }
        if (startsTable(lines, index)) {
          const header = splitTableRow(line);
          const aligns = splitTableRow(lines[index + 1]).map((cell) =>
            cell.startsWith(":") && cell.endsWith(":")
              ? "center"
              : cell.endsWith(":")
                ? "right"
                : cell.startsWith(":")
                  ? "left"
                  : undefined,
          );
          index += 2;
          const rows = [];
          while (
            index < lines.length &&
            lines[index].trim() !== "" &&
            lines[index].includes("|")
          ) {
            rows.push(splitTableRow(lines[index]));
            index += 1;
          }
          const cellStyle = (column) =>
            aligns[column] === undefined
              ? undefined
              : { textAlign: aligns[column] };
          blocks.push(
            h(
              "div",
              {
                className: "pmtask-md-table-wrap",
                key: `table-${blocks.length}`,
              },
              h(
                "table",
                { className: "pmtask-md-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    ...header.map((cell, column) =>
                      h(
                        "th",
                        { key: `th-${column}`, style: cellStyle(column) },
                        ...renderInlineMarkdown(cell),
                      ),
                    ),
                  ),
                ),
                rows.length === 0
                  ? null
                  : h(
                      "tbody",
                      null,
                      ...rows.map((row, rowIndex) =>
                        h(
                          "tr",
                          { key: `tr-${rowIndex}` },
                          ...header.map((_, column) =>
                            h(
                              "td",
                              { key: `td-${column}`, style: cellStyle(column) },
                              ...renderInlineMarkdown(row[column] ?? ""),
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
        const fence = line.match(/^```(.*)$/);
        if (fence !== null) {
          const code = [];
          index += 1;
          while (index < lines.length && !/^```\s*$/.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(
            h(
              "pre",
              { className: "pmtask-md-pre", key: `pre-${blocks.length}` },
              h("code", null, code.join("\n")),
            ),
          );
          continue;
        }
        if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(
            h("hr", { className: "pmtask-md-hr", key: `hr-${blocks.length}` }),
          );
          index += 1;
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        if (heading !== null) {
          const level = Math.min(6, heading[1].length + 2);
          blocks.push(
            h(
              `h${level}`,
              {
                className: "pmtask-md-heading",
                key: `heading-${blocks.length}`,
              },
              ...renderInlineMarkdown(heading[2]),
            ),
          );
          index += 1;
          continue;
        }
        const quote = line.match(/^>\s?(.*)$/);
        if (quote !== null) {
          const quoteLines = [quote[1]];
          index += 1;
          while (index < lines.length) {
            const next = lines[index].match(/^>\s?(.*)$/);
            if (next === null) break;
            quoteLines.push(next[1]);
            index += 1;
          }
          blocks.push(
            h(
              "blockquote",
              { className: "pmtask-md-quote", key: `quote-${blocks.length}` },
              ...renderInlineMarkdown(quoteLines.join("\n")),
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
              { className: "pmtask-md-list", key: `ul-${blocks.length}` },
              ...items.map((item, itemIndex) =>
                h(
                  "li",
                  { key: `li-${itemIndex}` },
                  ...renderInlineMarkdown(item),
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
              { className: "pmtask-md-list", key: `ol-${blocks.length}` },
              ...items.map((item, itemIndex) =>
                h(
                  "li",
                  { key: `li-${itemIndex}` },
                  ...renderInlineMarkdown(item),
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
          !/^(#{1,6})\s+/.test(lines[index]) &&
          !/^>\s?/.test(lines[index]) &&
          !/^\s*[-*+]\s+/.test(lines[index]) &&
          !/^\s*\d+[.)]\s+/.test(lines[index]) &&
          !startsTable(lines, index) &&
          !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index]) &&
          !lines[index].startsWith("```")
        ) {
          paragraph.push(lines[index]);
          index += 1;
        }
        blocks.push(
          h(
            "p",
            { className: "pmtask-md-paragraph", key: `p-${blocks.length}` },
            paragraph.flatMap((item, itemIndex) =>
              itemIndex === 0
                ? renderInlineMarkdown(item)
                : [
                    h("br", { key: `br-${itemIndex}` }),
                    ...renderInlineMarkdown(item),
                  ],
            ),
          ),
        );
      }
      return h("div", { className: "pmtask-markdown" }, ...blocks);
    }

    function ExecutionRoundInstruction({
      instruction,
      expanded,
      onToggle,
      extraClassName = "",
    }) {
      return h(
        "div",
        {
          className: `pmtask-round-instruction${expanded ? " expanded" : ""}${extraClassName === "" ? "" : ` ${extraClassName}`}`,
          title: instruction,
        },
        h("span", { className: "pmtask-round-instruction-label" }, "本轮指令"),
        h("span", { className: "pmtask-round-instruction-text" }, instruction),
        h(
          "button",
          {
            className: "pmtask-round-instruction-toggle",
            type: "button",
            "aria-expanded": expanded,
            onClick: (event) => {
              event.stopPropagation();
              onToggle();
            },
          },
          expanded ? "收起指令" : "展开完整指令",
        ),
      );
    }

    function MentionMenu({ directory, query, onPick }) {
      const keyword = query.trim().toLowerCase();
      const groups = [
        { key: "humans", label: "人员", items: directory.humans },
        { key: "agents", label: "DE / 分身", items: directory.agents },
        { key: "roles", label: "角色", items: directory.roles },
      ]
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) =>
              keyword === "" || item.name.toLowerCase().includes(keyword),
          ),
        }))
        .filter((group) => group.items.length > 0);
      return h(
        "div",
        { className: "pmtask-mention-menu", role: "listbox" },
        ...groups.flatMap((group) => [
          h(
            "div",
            { className: "pmtask-mention-group", key: `${group.key}:label` },
            group.label,
          ),
          ...group.items.map((item) =>
            h(
              "button",
              {
                type: "button",
                className: "pmtask-mention-item",
                key: `${group.key}:${item.id}`,
                onClick: () =>
                  onPick({
                    ...item,
                    type:
                      group.key === "agents"
                        ? "agent"
                        : group.key === "roles"
                          ? "role"
                          : "human",
                  }),
              },
              h("span", null),
              h(
                "span",
                null,
                h("strong", null, item.name),
                h(
                  "small",
                  null,
                  item.ownerName
                    ? `Owner ${item.ownerName}`
                    : item.personaId
                      ? `Persona ${item.personaId}`
                      : "可定向提及",
                ),
              ),
            ),
          ),
        ]),
        groups.length === 0
          ? h("div", { className: "pmtask-mention-empty" }, "没有匹配项。")
          : null,
      );
    }

    function byId(items, id) {
      return items.find((item) => item.id === id);
    }

    function TaskGlobalPage(props) {
      const route = props.useShellRoute?.((state) => state.route);
      if (route !== "task") return null;
      return h(TaskWorkspace, props);
    }

    function TaskWorkspace() {
      const [workspaces, setWorkspaces] = react.useState([]);
      // 全部项目（用于标题解析）；workspaces 只放当前范围可见的下拉项。
      const [allWorkspaces, setAllWorkspaces] = react.useState([]);
      const [workspaceFilter, setWorkspaceFilter] = react.useState("");
      const [tasks, setTasks] = react.useState([]);
      const [externalRuntimes, setExternalRuntimes] = react.useState([]);
      const [reviewableTaskIds, setReviewableTaskIds] = react.useState([]);
      const [directory, setDirectory] = react.useState({
        humans: [],
        agents: [],
        roles: [],
      });
      const [currentUser, setCurrentUser] = react.useState(null);
      const [ownership, setOwnership] = react.useState("all");
      const [search, setSearch] = react.useState("");
      const [searchDraft, setSearchDraft] = react.useState("");
      const [priority, setPriority] = react.useState("");
      const [receiver, setReceiver] = react.useState("me");
      const [source, setSource] = react.useState("");
      const [selectedId, setSelectedId] = react.useState("");
      const [highlightedId, setHighlightedId] = react.useState("");
      const [archivedOnly, setArchivedOnly] = react.useState(false);
      const [createOpen, setCreateOpen] = react.useState(false);
      const [createStatus, setCreateStatus] = react.useState("todo");
      const [assignOpen, setAssignOpen] = react.useState(false);
      const [pendingAssignee, setPendingAssignee] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [error, setError] = react.useState("");
      /**
       * 方案 B：项目清单默认只看"已加入"；平台管理员可切到全量视图。
       * 状态来自跨模块共享 store，跳转前后保持同一选择。
       */
      const showAllWorkspaces = react.useSyncExternalStore(
        scopeStore.subscribe,
        scopeStore.getSnapshot,
        scopeStore.getSnapshot,
      );
      const showAllWorkspacesRef = react.useRef(showAllWorkspaces);
      react.useEffect(() => {
        showAllWorkspacesRef.current = showAllWorkspaces;
      }, [showAllWorkspaces]);
      /**
       * 平台全量是管理员的数据范围视图，不应再被默认责任人过滤。
       * 切回默认范围时恢复“我 + 我的分身”，管理员仍可手动选回任意责任人。
       */
      react.useEffect(() => {
        setReceiver(showAllWorkspaces ? "all" : "me");
      }, [showAllWorkspaces]);
      const dragId = react.useRef("");
      const returnRef = react.useRef(null);
      const suppressOpenUntil = react.useRef(0);

      const notify = () => {
        setError("");
      };
      const fail = (cause, _options = {}) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
      };
      // 状态反馈条 3 秒后自动消失，避免过期提示常驻。
      react.useEffect(() => {
        if (error === "") return undefined;
        const timer = window.setTimeout(() => setError(""), 3_000);
        return () => window.clearTimeout(timer);
      }, [error]);

      const load = react.useCallback(
        async (silent = false) => {
          if (token() === null) {
            setError("请先在「账号与权限 → 登录账号」中登录。");
            setLoading(false);
            return;
          }
          try {
            if (!silent) setLoading(true);
            const [meResult, workspaceResult] = await Promise.all([
              request("/api/collab/auth/me"),
              request("/api/collab/team/workspaces"),
            ]);
            const options = workspaceResult.workspaces ?? [];
            const isAdmin = meResult.user?.role === "admin";
            const joinedOptions = options.filter(
              (workspace) => workspace.isMember === true,
            );
            // 项目下拉：默认只看已加入；平台管理员切到全量后列出全部项目。
            const accessibleOptions =
              isAdmin && showAllWorkspacesRef.current === true
                ? options
                : joinedOptions;
            setCurrentUser(meResult.user);
            setWorkspaces(accessibleOptions);
            setAllWorkspaces(options);
            const activeWorkspaceFilter = accessibleOptions.some(
              (workspace) => workspace.id === workspaceFilter,
            )
              ? workspaceFilter
              : "";
            if (activeWorkspaceFilter !== workspaceFilter) {
              setWorkspaceFilter(activeWorkspaceFilter);
            }
            /*
             * 取数范围与下拉范围分开：平台管理员即使停留在「仅看已加入」，也要
             * 把自己在未加入项目里的任务取回来，否则「我负责 / 我派出」的任务会
             * 整页消失；取回后再按 keepInScope 裁剪。普通成员只取已加入项目。
             */
            const fetchOptions = isAdmin ? options : joinedOptions;
            const requested = fetchOptions.filter(
              (workspace) =>
                activeWorkspaceFilter === "" ||
                workspace.id === activeWorkspaceFilter,
            );
            const target = requested.length === 0 ? fetchOptions : requested;
            const [results, runtimeResults] = await Promise.all([
              Promise.all(
                target.map((workspace) =>
                  request(
                    `/api/collab/tasks/bootstrap?workspaceId=${encodeURIComponent(workspace.id)}`,
                  ),
                ),
              ),
              Promise.all(
                target.map((workspace) =>
                  request(
                    `/api/collab/agent/external-runtimes?workspaceId=${encodeURIComponent(workspace.id)}`,
                  ).catch(() => ({ runtimes: [] })),
                ),
              ),
            ]);
            const mergedRuntimes = [];
            for (const result of runtimeResults) {
              for (const runtime of result.runtimes ?? []) {
                if (
                  !mergedRuntimes.some(
                    (candidate) => candidate.id === runtime.id,
                  )
                ) {
                  mergedRuntimes.push(runtime);
                }
              }
            }
            const mergedDirectory = {
              humans: [],
              agents: [],
              roles: [],
            };
            for (const result of results) {
              for (const key of ["humans", "agents", "roles"]) {
                for (const item of result.directory?.[key] ?? []) {
                  if (
                    !mergedDirectory[key].some(
                      (candidate) => candidate.id === item.id,
                    )
                  ) {
                    mergedDirectory[key].push(item);
                  }
                }
              }
            }
            const joinedIds = new Set(
              joinedOptions.map((workspace) => workspace.id),
            );
            // 默认范围＝已加入项目的全部任务 + 未加入项目里「我负责 / 我派出」的任务。
            const keepInScope = (task) => {
              if (isAdmin !== true) return true;
              if (showAllWorkspacesRef.current === true) return true;
              if (joinedIds.has(task.workspaceId)) return true;
              return (
                taskBelongsTo(task, meResult.user, mergedDirectory) ||
                task.createdBy === meResult.user.id
              );
            };
            const mergedTasks = results
              .flatMap((result) => result.tasks ?? [])
              .filter(keepInScope);
            setTasks(mergedTasks);
            setExternalRuntimes(mergedRuntimes);
            setReviewableTaskIds([
              ...new Set(
                results.flatMap((result) => result.reviewableTaskIds ?? []),
              ),
            ]);
            setDirectory(mergedDirectory);
            setError("");
            if (!silent) setLoading(false);
          } catch (cause) {
            setLoading(false);
            fail(cause, { global: true });
          }
        },
        // 共享范围切换后 load 需要重跑，任务列表才会跟随「仅看已加入 / 平台全量」。
        [workspaceFilter, showAllWorkspaces],
      );
      /** 方案 B：在"只看已加入"与"全量（管理员）"之间切换项目清单。 */
      const setShowAllProjects = (next) => {
        showAllWorkspacesRef.current = next;
        scopeStore.setAll(next);
        setWorkspaceFilter("");
      };

      react.useEffect(() => {
        void load();
      }, [load]);

      react.useEffect(() => {
        const synchronize = () => {
          setWorkspaces([]);
          setAllWorkspaces([]);
          setWorkspaceFilter("");
          setTasks([]);
          setReviewableTaskIds([]);
          setDirectory({ humans: [], agents: [], roles: [] });
          setCurrentUser(null);
          setOwnership("all");
          setReceiver("me");
          setPriority("");
          setSource("");
          setSearch("");
          setSearchDraft("");
          setArchivedOnly(false);
          setSelectedId("");
          setHighlightedId("");
          setCreateOpen(false);
          setAssignOpen(false);
          setPendingAssignee(null);
          setLoading(true);
          setError("");
          void load();
        };
        window.addEventListener("pluginmax:collab-token", synchronize);
        return () =>
          window.removeEventListener("pluginmax:collab-token", synchronize);
      }, [load]);

      react.useEffect(() => {
        const pending = window.__pluginmaxPendingTask;
        if (pending === null || typeof pending !== "object") return;
        window.__pluginmaxPendingTask = null;
        if (typeof pending.taskId !== "string" || pending.taskId === "") return;
        returnRef.current =
          pending.returnRoute === "teammates"
            ? {
                teammateId:
                  typeof pending.returnTeammateId === "string"
                    ? pending.returnTeammateId
                    : "",
                tab:
                  pending.returnTab === "definition" ? "definition" : "runtime",
              }
            : null;
        if (
          typeof pending.workspaceId === "string" &&
          pending.workspaceId !== ""
        ) {
          setWorkspaceFilter(pending.workspaceId);
        }
        setArchivedOnly(false);
        setSelectedId(pending.taskId);
        setHighlightedId(pending.taskId);
      }, []);

      const mutate = async (path, body, message, options = {}) => {
        const result = await request(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (result.task !== undefined) {
          setReviewableTaskIds((current) =>
            current.includes(result.task.id) ||
            (result.task.createdBy !== currentUser?.id &&
              currentUser?.role !== "admin")
              ? current
              : [...current, result.task.id],
          );
          setTasks((current) => {
            const next = current.filter((task) => task.id !== result.task.id);
            return [result.task, ...next].sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            );
          });
        }
        if (options.silent !== true) notify(message);
        return result.task;
      };

      const visibleTasks = tasks.filter((task) => {
        const belongsToMe = taskBelongsTo(task, currentUser, directory);
        const assignedToMeOnly = taskBelongsTo(
          task,
          currentUser,
          directory,
          "self",
        );
        const sentByMe =
          currentUser !== null && task.createdBy === currentUser.id;
        if (archivedOnly !== isArchived(task)) return false;
        if (ownership === "sent" && !sentByMe) return false;
        if (priority !== "" && task.priority !== priority) return false;
        if (receiver === "me" && !belongsToMe) return false;
        // 「我（本人）」：只看直接指派给我这个人的任务。
        if (receiver === "me-only" && !assignedToMeOnly) return false;
        if (receiver !== "me" && receiver !== "me-only" && receiver !== "all") {
          const separator = receiver.indexOf(":");
          const receiverType = receiver.slice(0, separator);
          const receiverId = receiver.slice(separator + 1);
          // 选中某个 Agent 时，同时兼容责任人仍是其员工身份 id 的老任务。
          const agentEntry =
            receiverType === "agent"
              ? directory.agents.find((item) => item.id === receiverId)
              : undefined;
          const matchesLegacyId =
            agentEntry?.employeeId !== undefined &&
            task.receiverId === agentEntry.employeeId;
          if (
            task.receiverType !== receiverType ||
            (task.receiverId !== receiverId && !matchesLegacyId)
          ) {
            return false;
          }
        }
        if (source === "workflow" && task.workflow === undefined) return false;
        if (source === "manual" && task.workflow !== undefined) return false;
        if (search.trim() !== "") {
          const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
          const haystack = [
            task.title,
            task.id,
            task.description,
            task.type,
            task.priority,
            receiverDisplay(task, directory),
            statusLabel(task.status),
          ]
            .join(" ")
            .toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) return false;
        }
        return true;
      });

      const selected = byId(tasks, selectedId);
      /**
       * 「我（本人）」以外的部分：我的分身 / 我所在角色承接的任务。
       * Agent 跑完自动提交验收时任务仍挂在我的分身名下，这里必须提示，
       * 否则切到本人口径后验收入口看起来凭空消失了。
       */
      const myAvatarTaskCount = tasks.filter(
        (task) =>
          isArchived(task) === archivedOnly &&
          taskBelongsTo(task, currentUser, directory) &&
          !taskBelongsTo(task, currentUser, directory, "self"),
      ).length;
      const closeDetail = () => {
        setSelectedId("");
        setHighlightedId("");
        setPendingAssignee(null);
        setAssignOpen(false);
        const returnContext = returnRef.current;
        if (returnContext !== null) {
          returnRef.current = null;
          window.__pluginmaxPendingTeammate = returnContext;
          window.dispatchEvent(
            new CustomEvent("pluginmax:navigate", {
              detail: { route: "teammates" },
            }),
          );
        }
      };
      const anyTaskRunning = tasks.some((task) => taskHasActiveRun(task));
      react.useEffect(() => {
        if (!anyTaskRunning) return undefined;
        const timer = window.setInterval(() => void load(true), 2_500);
        return () => window.clearInterval(timer);
      }, [load, anyTaskRunning]);
      react.useEffect(() => {
        const onRouteSelect = (event) => {
          const route = event?.detail?.route;
          if (typeof route === "string" && route !== "task") return;
          setSelectedId("");
          setHighlightedId("");
          setPendingAssignee(null);
          setAssignOpen(false);
          setArchivedOnly(false);
        };
        window.addEventListener("pluginmax:route-select", onRouteSelect);
        return () =>
          window.removeEventListener("pluginmax:route-select", onRouteSelect);
      }, []);
      react.useEffect(() => {
        if (highlightedId === "" || selectedId !== "") return undefined;
        const frame = window.requestAnimationFrame(() => {
          window.document
            .querySelector(`[data-task-id="${highlightedId}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        const timer = window.setTimeout(() => setHighlightedId(""), 2400);
        return () => {
          window.cancelAnimationFrame(frame);
          window.clearTimeout(timer);
        };
      }, [highlightedId, selectedId]);
      const directoryOptions = [
        ...directory.humans.map((item) => ({ ...item, type: "human" })),
        ...directory.agents.map((item) => ({ ...item, type: "agent" })),
        ...directory.roles.map((item) => ({ ...item, type: "role" })),
      ];

      if (loading) {
        return h(
          "section",
          { className: "pmtask" },
          h("style", null, styles),
          h("div", { className: "pmtask-empty" }, "正在加载任务..."),
        );
      }

      return h(
        "section",
        { className: "pmtask", "data-task-management": true },
        h("style", null, styles),
        error !== ""
          ? h(
              "div",
              { className: "pmtask-filter pmtask-notice" },
              h(
                "span",
                {
                  style: {
                    color: "var(--dsw-alias-state-error-primary,#e5534b)",
                  },
                },
                error,
              ),
            )
          : null,
        h(TaskPageHeader, {
          workspaces,
          workspaceFilter,
          setWorkspaceFilter,
          onRefresh: () => load(true),
          onCreate: (status = "todo") => {
            setCreateStatus(status);
            setCreateOpen(true);
          },
          currentUser,
          showAllWorkspaces,
          setShowAllProjects,
        }),
        selectedId !== "" && selected !== undefined
          ? h(TaskDetail, {
              task: selected,
              workspaceTitle:
                (
                  allWorkspaces.find(
                    (workspace) => workspace.id === selected.workspaceId,
                  ) ??
                  workspaces.find(
                    (workspace) => workspace.id === selected.workspaceId,
                  )
                )?.title ?? selected.workspaceId,
              directory,
              externalRuntimes,
              currentUser,
              reviewableTaskIds,
              pendingAssignee,
              setPendingAssignee,
              assignOpen,
              setAssignOpen,
              onBack: closeDetail,
              onRestored: () => {
                setArchivedOnly(false);
                closeDetail();
              },
              mutate,
              notify,
              fail,
            })
          : h(TaskBoard, {
              tasks: visibleTasks,
              currentUser,
              directory,
              myAvatarTaskCount,
              archivedOnly,
              archivedCount: tasks.filter((task) => isArchived(task)).length,
              setArchivedOnly,
              ownership,
              setOwnership,
              searchDraft,
              setSearchDraft,
              applySearch: () => setSearch(searchDraft.trim()),
              priority,
              setPriority,
              receiver,
              setReceiver,
              source,
              setSource,
              directoryOptions,
              onCreate: (status = "todo") => {
                setCreateStatus(status);
                setCreateOpen(true);
              },
              onOpen: (taskId) => {
                if (Date.now() < suppressOpenUntil.current) return;
                setSelectedId(taskId);
                setHighlightedId("");
                setPendingAssignee(null);
              },
              onDrop: async (taskId, status) => {
                try {
                  await mutate(
                    "/api/collab/tasks/status",
                    { taskId, status },
                    `已移动到「${statusLabel(status)}」`,
                    { silent: true },
                  );
                } catch (cause) {
                  fail(cause);
                }
              },
              dragId,
              onDragStart: () => {
                suppressOpenUntil.current = Date.now() + 500;
              },
              highlightedId,
            }),
        createOpen
          ? h(CreateTaskModal, {
              workspaces,
              directory,
              externalRuntimes,
              currentWorkspaceId: workspaceFilter,
              initialStatus: createStatus,
              onClose: () => setCreateOpen(false),
              onCreated: async (input) => {
                try {
                  const task = await mutate(
                    "/api/collab/tasks/create",
                    input,
                    "任务已派发",
                  );
                  setCreateOpen(false);
                  setSelectedId("");
                  if (task?.id !== undefined) setHighlightedId(task.id);
                  if (task?.workspaceId !== undefined) {
                    setWorkspaceFilter(task.workspaceId);
                    setOwnership("sent");
                  }
                  // Agent tasks can hand off to the instance owner as soon as
                  // automatic review starts. Keep the creator-scoped task
                  // visible instead of retaining the pre-handoff assignee.
                  setReceiver("all");
                } catch (cause) {
                  fail(cause);
                }
              },
            })
          : null,
      );
    }

    function TaskPageHeader({
      workspaces,
      workspaceFilter,
      setWorkspaceFilter,
      onRefresh,
      onCreate,
      currentUser,
      showAllWorkspaces,
      setShowAllProjects,
    }) {
      const meetingOpen = react.useSyncExternalStore(
        (listener) =>
          window.__pluginmaxMeeting?.subscribe(() =>
            listener(Boolean(window.__pluginmaxMeeting.open)),
          ) ?? (() => {}),
        () => Boolean(window.__pluginmaxMeeting?.open),
      );
      return h(
        "header",
        { className: "pmtask-head" },
        h(
          "div",
          null,
          h("h1", null, "任务"),
          h(
            "div",
            { className: "pmtask-sub" },
            "看板、派发、认领、执行记录与验收统一管理",
          ),
        ),
        h(
          "div",
          { className: "pmtask-head-actions" },
          currentUser?.role === "admin"
            ? h(
                "div",
                {
                  className: "pmtask-scope-seg",
                  role: "group",
                  "aria-label": "项目范围",
                },
                h(
                  "button",
                  {
                    type: "button",
                    className: `pmtask-token${showAllWorkspaces ? "" : " active"}`,
                    "aria-pressed": !showAllWorkspaces,
                    title: "只看我已加入的项目（默认视图）",
                    onClick: () => {
                      if (showAllWorkspaces) setShowAllProjects(false);
                    },
                  },
                  "仅看已加入",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `pmtask-token${showAllWorkspaces ? " active" : ""}`,
                    "aria-pressed": showAllWorkspaces,
                    title:
                      "平台管理员全量视图：显示全部项目和任务，可继续手动筛选责任人",
                    onClick: () => {
                      if (!showAllWorkspaces) setShowAllProjects(true);
                    },
                  },
                  "平台全量",
                ),
              )
            : null,
          h(
            "select",
            {
              className: "pmtask-select",
              value: workspaceFilter,
              onChange: (event) => setWorkspaceFilter(event.target.value),
              "aria-label": "按项目筛选任务",
            },
            h("option", { value: "" }, "全部项目"),
            ...workspaces.map((workspace) =>
              h(
                "option",
                { value: workspace.id, key: workspace.id },
                workspace.title,
              ),
            ),
          ),
          h(
            "button",
            {
              className: "pmtask-iconbtn",
              type: "button",
              "aria-label": "刷新任务列表",
              title: "刷新",
              onClick: onRefresh,
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
              h("path", { d: "M21 12a9 9 0 1 1-3-6.7" }),
              h("path", { d: "M21 3v6h-6" }),
            ),
          ),
          h(
            "button",
            {
              className: "pmtask-btn",
              type: "button",
              onClick: () => onCreate("todo"),
            },
            "新建任务",
          ),
          h(
            "button",
            {
              className: `pmtask-meeting-toggle${meetingOpen ? " active" : ""}`,
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
          ),
        ),
      );
    }

    function TaskBoard(props) {
      const {
        tasks,
        archivedOnly,
        archivedCount,
        setArchivedOnly,
        ownership,
        setOwnership,
        searchDraft,
        setSearchDraft,
        applySearch,
        priority,
        setPriority,
        receiver,
        setReceiver,
        source,
        setSource,
        directory,
        myAvatarTaskCount,
        directoryOptions,
        currentUser,
        onCreate,
        onOpen,
        onDrop,
        dragId,
        onDragStart,
        highlightedId,
      } = props;
      const currentUserOption = directoryOptions.find(
        (item) => item.type === "human" && item.id === currentUser?.id,
      );
      const senderOptions = [
        {
          value: "all",
          label: "全部",
          description: "查看所有派出方创建的任务",
          triggerPrefix: "派出方：",
          triggerLabel: "全部",
          group: "范围",
        },
      ];
      if (currentUser !== null && currentUserOption !== undefined) {
        senderOptions.push({
          value: "sent",
          label: `我（${currentUser.name}）`,
          description: "只看我派出的任务",
          triggerPrefix: "派出方：",
          triggerLabel: `我（${currentUser.name}）`,
          group: "范围",
        });
      }
      const receiverOptions = [
        {
          value: "all",
          label: "全部",
          description: "查看所有责任人的任务",
          triggerPrefix: "责任人：",
          triggerLabel: "全部",
          group: "范围",
        },
      ];
      if (currentUser !== null) {
        receiverOptions.push({
          value: "me",
          label: "我 + 我的分身",
          description: `指派给 ${currentUser.name}、TA 的分身或 TA 所在角色（默认）`,
          triggerPrefix: "责任人：",
          triggerLabel: "我 + 我的分身",
          group: "常用",
        });
        receiverOptions.push({
          value: "me-only",
          label: "我（本人）",
          description: `只看直接指派给 ${currentUser.name} 本人的任务，不含分身与角色`,
          triggerPrefix: "责任人：",
          triggerLabel: "我（本人）",
          group: "常用",
        });
      }
      for (const item of directoryOptions) {
        receiverOptions.push({
          value: `${item.type}:${item.id}`,
          label: receiverOptionLabel(item),
          description: receiverKindLabel(item.type),
          triggerPrefix: "责任人：",
          triggerLabel: receiverOptionLabel(item),
          group: receiverKindLabel(item.type),
        });
      }
      const priorityOptions = [
        {
          value: "",
          label: "全部",
          description: "不按优先级过滤",
          triggerPrefix: "",
          triggerLabel: "全部优先级",
        },
        ...["P1", "P2", "P3"].map((item) => ({
          value: item,
          label: priorityLabel(item),
          description: item === "P1" ? "最高优先级" : undefined,
          triggerPrefix: "",
          triggerLabel: priorityLabel(item),
        })),
      ];
      return h(
        Fragment,
        null,
        h(
          "div",
          { className: "pmtask-filter", role: "search" },
          h(FilterDropdown, {
            value: ownership,
            onChange: setOwnership,
            options: senderOptions,
            ariaLabel: "按派出方筛选任务",
            width: 203,
          }),
          h(FilterDropdown, {
            value: receiver,
            onChange: setReceiver,
            options: receiverOptions,
            ariaLabel: "按责任人筛选任务",
            width: 203,
          }),
          h(FilterDropdown, {
            value: priority,
            onChange: setPriority,
            options: priorityOptions,
            ariaLabel: "按优先级筛选任务",
            width: 109,
          }),
          h(
            "select",
            {
              className: "pmtask-select",
              value: source,
              onChange: (event) => setSource(event.target.value),
              "aria-label": "按来源筛选任务",
            },
            h("option", { value: "" }, "全部来源"),
            h("option", { value: "workflow" }, "工作流"),
            h("option", { value: "manual" }, "手动"),
          ),
          h(
            "div",
            { className: "pmtask-search" },
            h("input", {
              className: "pmtask-input",
              value: searchDraft,
              onChange: (event) => setSearchDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === "Enter") applySearch();
              },
              placeholder: "搜索任务标题、ID、描述或责任人",
            }),
            h(
              "button",
              {
                className: "pmtask-btn secondary",
                type: "button",
                onClick: applySearch,
              },
              "搜索",
            ),
          ),
          receiver === "me-only" && myAvatarTaskCount > 0
            ? h(
                "span",
                { className: "pmtask-compose-hint" },
                `另有 ${myAvatarTaskCount} 条由我的分身 / 角色承接，切到「我 + 我的分身」查看`,
              )
            : null,
          h(
            "button",
            {
              className: `pmtask-token${archivedOnly ? " active" : ""}`,
              type: "button",
              title: "在任务看板与归档视图之间切换",
              "aria-pressed": archivedOnly,
              style: { marginLeft: "auto" },
              onClick: () => {
                const next = !archivedOnly;
                setArchivedOnly(next);
                if (next) setOwnership("all");
              },
            },
            archivedOnly ? "返回任务看板" : `已归档 ${archivedCount}`,
          ),
        ),
        h(
          "div",
          { className: "pmtask-board" },
          ...STATUSES.filter((status) => status.key !== "cancelled").map(
            (status) =>
              h(TaskColumn, {
                key: status.key,
                status,
                readOnly: false,
                // 已取消不再单独成列：作为「已完成」里的历史记录展示，卡片上仍有「已取消」标记。
                tasks: tasks.filter((task) =>
                  status.key === "done"
                    ? task.status === "done" || task.status === "cancelled"
                    : task.status === status.key,
                ),
                onOpen,
                onCreate,
                onDrop,
                dragId,
                onDragStart,
                highlightedId,
                directory,
              }),
          ),
        ),
      );
    }

    function TaskColumn({
      status,
      readOnly,
      tasks,
      onOpen,
      onCreate,
      onDrop,
      dragId,
      onDragStart,
      highlightedId,
      directory,
    }) {
      const [dropReady, setDropReady] = react.useState(false);
      return h(
        "section",
        {
          className: `pmtask-column ${dropReady ? "drop-ready" : ""}`,
          onDragOver: (event) => {
            if (readOnly) return;
            event.preventDefault();
            setDropReady(true);
          },
          onDragLeave: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setDropReady(false);
          },
          onDrop: (event) => {
            event.preventDefault();
            setDropReady(false);
            if (readOnly) return;
            const taskId =
              event.dataTransfer.getData("text/plain") || dragId.current;
            if (taskId !== "") void onDrop(taskId, status.key);
          },
        },
        h(
          "header",
          { className: "pmtask-column-head" },
          h("span", { className: `pmtask-column-dot ${status.key}` }),
          h("strong", null, status.label),
          h("span", { className: "pmtask-column-count" }, String(tasks.length)),
          h(
            "button",
            {
              className: "pmtask-column-add",
              type: "button",
              hidden: readOnly,
              title: readOnly
                ? "已取消状态不接受新建任务"
                : `在${status.label}新建任务`,
              "aria-label": readOnly
                ? "已取消状态不接受新建任务"
                : `在${status.label}新建任务`,
              onClick: () => {
                if (readOnly) return;
                onCreate(status.key);
              },
            },
            "+",
          ),
        ),
        h(
          "div",
          { className: "pmtask-cards" },
          ...tasks.map((task) =>
            h(
              "article",
              {
                key: task.id,
                className: `pmtask-card${taskHasActiveRun(task) ? " running" : ""}${isArchived(task) ? " archived" : ""}${task.id === highlightedId ? " highlighted" : ""}`,
                "data-task-id": task.id,
                draggable:
                  !isArchived(task) &&
                  task.status !== "cancelled" &&
                  task.workflow === undefined,
                tabIndex: 0,
                role: "button",
                onClick: () => onOpen(task.id),
                onKeyDown: (event) => {
                  if (event.key === "Enter" || event.key === " ")
                    onOpen(task.id);
                },
                onDragStart: (event) => {
                  if (isArchived(task) || task.status === "cancelled") return;
                  dragId.current = task.id;
                  onDragStart();
                  event.dataTransfer.setData("text/plain", task.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.currentTarget.classList.add("dragging");
                },
                onDragEnd: (event) =>
                  event.currentTarget.classList.remove("dragging"),
              },
              h(
                "div",
                { className: "pmtask-card-top" },
                h("span", { className: "pmtask-id" }, task.id),
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: 6 } },
                  taskHasActiveRun(task)
                    ? h("span", {
                        className: "pmtask-spinner",
                        role: "status",
                        title: "Agent 正在执行",
                        "aria-label": "Agent 正在执行",
                      })
                    : null,
                  h(TaskFollowButton, {
                    taskId: task.id,
                    workspaceId: task.workspaceId,
                    workflowInstanceId: task.workflow?.instanceId,
                  }),
                ),
              ),
              h("div", { className: "pmtask-title" }, task.title),
              task.workflow !== undefined
                ? h(
                    "div",
                    { className: "pmtask-workflow-meta" },
                    h(
                      "span",
                      { className: "pmtask-pill workflow" },
                      workflowSourceLabel(task),
                    ),
                    h(
                      "span",
                      { className: "pmtask-workflow-node" },
                      `${task.workflow.nodeName}${task.workflow.nodeAttempt === undefined ? "" : ` · 第 ${task.workflow.nodeAttempt} 轮`}`,
                    ),
                  )
                : null,
              h("div", { className: "pmtask-desc" }, task.description),
              h(
                "div",
                { className: "pmtask-meta" },
                h(
                  "span",
                  {
                    className: `pmtask-pill ${task.priority === "P1" ? "p1" : ""}`,
                  },
                  priorityLabel(task.priority),
                ),
                isArchived(task)
                  ? h("span", { className: "pmtask-pill archived" }, "已归档")
                  : null,
                // 已取消并到「已完成」列后，卡片上仍要能一眼区分出来。
                task.status === "cancelled"
                  ? h("span", { className: "pmtask-pill cancelled" }, "已取消")
                  : null,
                task.receiverState === "needs_reassignment"
                  ? h("span", { className: "pmtask-pill reassign" }, "需改派")
                  : task.receiverType === "unassigned"
                    ? h("span", { className: "pmtask-pill" }, "待指派")
                    : h(
                        "span",
                        { className: "pmtask-assignee" },
                        h(
                          "span",
                          { className: "pmtask-assignee-name" },
                          receiverDisplay(task, directory),
                        ),
                      ),
                h("span", null, task.due ? task.due.slice(5) : "不限"),
              ),
            ),
          ),
          tasks.length === 0
            ? h(
                "div",
                { className: "pmtask-empty", style: { padding: "20px 8px" } },
                "暂无任务",
              )
            : null,
        ),
      );
    }

    function ConfirmDialog({
      title,
      description,
      confirmLabel,
      cancelLabel,
      tone,
      onConfirm,
      onCancel,
    }) {
      react.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [onCancel]);
      return h(
        "div",
        {
          className: "pmtask-mask",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          "div",
          {
            className: "pmtask-modal pmtask-confirm",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": title,
          },
          h("div", { className: "pmtask-modal-head" }, h("h2", null, title)),
          h("p", { className: "pmtask-confirm-text" }, description),
          h(
            "div",
            { className: "pmtask-confirm-actions" },
            h(
              "button",
              {
                className: "pmtask-btn secondary",
                type: "button",
                onClick: onCancel,
              },
              cancelLabel ?? "取消",
            ),
            h(
              "button",
              {
                className: `pmtask-btn${tone === "danger" ? " danger-solid" : ""}`,
                type: "button",
                onClick: onConfirm,
              },
              confirmLabel ?? "确认",
            ),
          ),
        ),
      );
    }

    function RejectDialog({ title, onConfirm, onCancel }) {
      const [note, setNote] = react.useState("");
      react.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [onCancel]);
      return h(
        "div",
        {
          className: "pmtask-mask",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onCancel();
          },
        },
        h(
          "form",
          {
            className: "pmtask-modal pmtask-confirm",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": title,
            onSubmit: (event) => {
              event.preventDefault();
              const value = note.trim();
              if (value !== "") onConfirm(value);
            },
          },
          h("div", { className: "pmtask-modal-head" }, h("h2", null, title)),
          h(
            "p",
            { className: "pmtask-confirm-text" },
            "请填写退回原因和需要补充的内容。说明为必填项，提交后会保留在任务执行历史中。",
          ),
          h("textarea", {
            className: "pmtask-area pmtask-reject-note",
            value: note,
            required: true,
            autoFocus: true,
            maxLength: 8000,
            placeholder: "例如：缺少风险项，请补充风险及应对措施",
            "aria-label": "退回说明",
            onChange: (event) => setNote(event.target.value),
          }),
          h(
            "div",
            { className: "pmtask-confirm-actions" },
            h(
              "button",
              {
                className: "pmtask-btn secondary",
                type: "button",
                onClick: onCancel,
              },
              "取消",
            ),
            h(
              "button",
              {
                className: "pmtask-btn danger-solid",
                type: "submit",
                disabled: note.trim() === "",
              },
              "确认退回",
            ),
          ),
        ),
      );
    }

    function TaskDetail(props) {
      const {
        task,
        workspaceTitle,
        directory,
        externalRuntimes,
        currentUser,
        reviewableTaskIds,
        pendingAssignee,
        setPendingAssignee,
        assignOpen,
        setAssignOpen,
        onBack,
        onRestored,
        mutate,
        fail,
      } = props;
      const [editing, setEditing] = react.useState(false);
      const [message, setMessage] = react.useState("");
      const [attachments, setAttachments] = react.useState([]);
      const [mentionOpen, setMentionOpen] = react.useState(false);
      const [mentionQuery, setMentionQuery] = react.useState("");
      /** 从 @ 菜单里选中的目标（带 id），发送时作为结构化提及提交。 */
      const [pickedMentions, setPickedMentions] = react.useState([]);
      const [comment, setComment] = react.useState("");
      const [commentIsConsensus, setCommentIsConsensus] = react.useState(false);
      const [replyDrafts, setReplyDrafts] = react.useState({});
      const [executionLive, setExecutionLive] = react.useState(null);
      const [executionDetailState, setExecutionDetailState] =
        react.useState("idle");
      const [executionControl, setExecutionControl] = react.useState(null);
      const [taskRuns, setTaskRuns] = react.useState([]);
      const [selectedRunId, setSelectedRunId] = react.useState("");
      const [roundMenuOpen, setRoundMenuOpen] = react.useState(false);
      const [expandedRoundInstructionIds, setExpandedRoundInstructionIds] =
        react.useState([]);
      const [confirmArchive, setConfirmArchive] = react.useState(false);
      const [rejectOpen, setRejectOpen] = react.useState(false);
      const [documents, setDocuments] = react.useState([]);
      const [documentsReady, setDocumentsReady] = react.useState(true);
      const messageRef = react.useRef(null);
      const liveOutputRef = react.useRef(null);
      const directoryOptions = [
        ...directory.humans.map((item) => ({ ...item, type: "human" })),
        ...directory.agents.map((item) => ({ ...item, type: "agent" })),
        ...directory.roles.map((item) => ({ ...item, type: "role" })),
      ];
      const mine = taskBelongsTo(task, currentUser, directory);
      const sent = currentUser !== null && task.createdBy === currentUser.id;
      const canReview = reviewableTaskIds.includes(task.id);
      const archived = isArchived(task);
      const readOnly = archived || task.status === "cancelled";
      const isApprovalTask = task.workflow?.approvalPolicy !== undefined;
      const canClaim = task.receiverType === "role" && task.status === "todo";
      const insertMention = (item) => {
        const name = item.name;
        setPickedMentions((current) =>
          current.some(
            (candidate) =>
              candidate.type === item.type && candidate.id === item.id,
          )
            ? current
            : [...current, { id: item.id, name, type: item.type }],
        );
        const input = messageRef.current;
        const cursor = input?.selectionStart ?? message.length;
        const before = message.slice(0, cursor);
        const after = message.slice(cursor);
        const token = before.match(/@[^@\s]*$/);
        const replacement = `@${name} `;
        const next =
          token === null
            ? `${before}${replacement}${after}`
            : `${before.slice(0, token.index)}${replacement}${after}`;
        const nextCursor = (token?.index ?? before.length) + replacement.length;
        setMessage(next);
        setMentionOpen(false);
        requestAnimationFrame(() => {
          input?.focus();
          input?.setSelectionRange(nextCursor, nextCursor);
        });
      };
      const uploadAttachment = async (file) => {
        const contentBase64 = await readFileAsBase64(file);
        const result = await request("/api/collab/tasks/document/upload", {
          method: "POST",
          body: JSON.stringify({
            taskId: task.id,
            name: file.name,
            ...(file.type === "" ? {} : { mimeType: file.type }),
            contentBase64,
          }),
        });
        return {
          name: file.name,
          size: file.size,
          ...(file.type === "" ? {} : { mimeType: file.type }),
          ...(result?.document?.relativePath === undefined
            ? {}
            : { storedPath: result.document.relativePath }),
        };
      };
      const sendMessage = async () => {
        const content =
          message.trim() === "" && attachments.length > 0
            ? `已上传附件：${attachments.map((file) => file.name).join("、")}`
            : message.trim();
        if (readOnly || content === "") return;
        try {
          const uploaded = [];
          for (const file of attachments) {
            uploaded.push(await uploadAttachment(file));
          }
          // 只提交正文里还留着的 @：用户删掉名字后不该再定向分发。
          const mentions = pickedMentions
            .filter((item) => content.includes(`@${item.name}`))
            .map((item) => ({
              kind: item.type,
              id: item.id,
              name: item.name,
            }));
          const addressesReceiver =
            mentions.length === 0 ||
            (task.receiverId !== undefined &&
              mentions.some((mention) => mention.id === task.receiverId));
          const mentionsCollaborator =
            task.receiverId !== undefined &&
            mentions.some((mention) => mention.id !== task.receiverId);
          const deliveryTarget =
            mentions.length === 0
              ? "receiver"
              : addressesReceiver && mentionsCollaborator
                ? "broadcast"
                : addressesReceiver
                  ? "receiver"
                  : "collaborators";
          const reopensTask =
            task.status === "done" && deliveryTarget !== "collaborators";
          const sentNotice =
            task.status === "done"
              ? reopensTask
                ? "已追加要求并重新开启，指令已发送"
                : "协作消息已发送，任务状态保持不变"
              : task.receiverType === "agent"
                ? "执行指令已发送"
                : `已发送给 ${receiverDisplay(task)}`;
          await mutate(
            "/api/collab/tasks/message",
            {
              taskId: task.id,
              content,
              attachments: uploaded,
              mentions,
              deliveryTarget,
            },
            sentNotice,
          );
          setMessage("");
          setAttachments([]);
          setPickedMentions([]);
          setMentionOpen(false);
        } catch (cause) {
          fail(cause);
        }
      };
      /**
       * 跳到这条任务对应的 Agent 执行会话。会话是懒落盘的：Agent 还没真正
       * 开始跑时 DSH 侧还没有这条会话，这里明确提示而不是让人以为丢了。
       */
      const openAgentSession = async () => {
        try {
          const result = await request(
            `/api/collab/tasks/session?taskId=${encodeURIComponent(task.id)}`,
          );
          const sessionId =
            typeof result?.sessionId === "string" ? result.sessionId : "";
          if (sessionId === "") {
            fail(
              new Error(
                "Agent 还没有真正开始执行，会话尚未创建；稍后重试即可。",
              ),
            );
            return;
          }
          if (window.__pluginmaxOpenSession?.(sessionId) !== true) {
            fail(
              new Error(
                `没能自动切到会话 ${sessionId}，可在左侧项目下查找它。`,
              ),
            );
          }
        } catch (cause) {
          fail(cause);
        }
      };
      const runListKey = task.agentRunIds.join("|");
      react.useEffect(() => {
        if (task.agentRunIds.length === 0) {
          setTaskRuns([]);
          return undefined;
        }
        let disposed = false;
        const loadRuns = async () => {
          try {
            const instanceId = task.workflow?.instanceId ?? task.id;
            const result = await request(
              `/api/collab/agent/runs?workspaceId=${encodeURIComponent(task.workspaceId)}&instanceId=${encodeURIComponent(instanceId)}`,
            );
            if (disposed) return;
            const allowed = new Set(task.agentRunIds);
            const runs = (result?.runs ?? []).filter((run) =>
              allowed.has(run.id),
            );
            runs.sort((left, right) =>
              String(left.createdAt ?? left.startedAt ?? "").localeCompare(
                String(right.createdAt ?? right.startedAt ?? ""),
              ),
            );
            setTaskRuns(runs);
          } catch {
            // Task history still provides a fallback participant list.
          }
        };
        void loadRuns();
        const timer = window.setInterval(() => void loadRuns(), 2_000);
        return () => {
          disposed = true;
          window.clearInterval(timer);
        };
      }, [runListKey, task.id, task.workspaceId, task.workflow?.instanceId]);
      react.useEffect(() => {
        setSelectedRunId(task.agentRunIds.at(-1) ?? "");
      }, [task.id, runListKey]);
      react.useEffect(() => {
        setRoundMenuOpen(false);
        setExpandedRoundInstructionIds([]);
      }, [task.id]);
      react.useEffect(() => {
        if (selectedRunId === "") {
          setExecutionLive(null);
          setExecutionControl(null);
          setExecutionDetailState("idle");
          return undefined;
        }
        setExecutionLive(null);
        setExecutionControl(null);
        setExecutionDetailState("loading");
        let disposed = false;
        const loadExecution = async () => {
          try {
            const [result, controlResult] = await Promise.all([
              request(
                `/api/collab/agent/runs/detail?workspaceId=${encodeURIComponent(task.workspaceId)}&runId=${encodeURIComponent(selectedRunId)}`,
              ),
              request(
                `/api/collab/agent/execution/detail?workspaceId=${encodeURIComponent(task.workspaceId)}&runId=${encodeURIComponent(selectedRunId)}`,
              ).catch(() => ({ execution: null })),
            ]);
            if (!disposed) {
              setExecutionLive(result);
              setExecutionControl(controlResult?.execution ?? null);
              setExecutionDetailState("ready");
            }
          } catch {
            // The task history and run list remain authoritative if live detail is unavailable.
            if (!disposed) setExecutionDetailState("error");
          }
        };
        void loadExecution();
        const timer = window.setInterval(() => void loadExecution(), 1_200);
        return () => {
          disposed = true;
          window.clearInterval(timer);
        };
      }, [selectedRunId, task.workspaceId]);
      const messageByRunId = new Map(
        task.messages
          .filter((item) => item.runId !== undefined)
          .map((item) => [item.runId, item]),
      );
      const messageById = new Map(task.messages.map((item) => [item.id, item]));
      const runById = new Map(taskRuns.map((run) => [run.id, run]));
      const participantMap = new Map();
      for (const runId of task.agentRunIds) {
        const run = runById.get(runId);
        const runMessage = messageByRunId.get(runId);
        if (run === undefined && runMessage === undefined) continue;
        const context = run?.payload?.context ?? {};
        const participantId =
          runMessage?.authorId ??
          context.taskReceiverId ??
          run?.principalId ??
          runId;
        const participantName =
          runMessage?.authorName ??
          context.employeeName ??
          run?.payload?.profileName ??
          "AI伙伴";
        const existing = participantMap.get(participantId) ?? {
          id: participantId,
          name: participantName,
          runs: [],
        };
        existing.runs.push({
          id: runId,
          run,
          message: runMessage,
          status: run?.status ?? runMessage?.state ?? "succeeded",
          role:
            runMessage?.runRole ??
            context.taskRunRole ??
            (runMessage === undefined ? "owner" : "owner"),
          at:
            run?.endedAt ??
            run?.startedAt ??
            run?.createdAt ??
            runMessage?.at ??
            "",
        });
        participantMap.set(participantId, existing);
      }
      const participants = [...participantMap.values()].map((participant) => {
        participant.runs.sort((left, right) =>
          String(left.at).localeCompare(String(right.at)),
        );
        return {
          ...participant,
          latest: participant.runs.at(-1),
          active: participant.runs.some((run) =>
            RUNNING_MESSAGE_STATES.includes(run.status),
          ),
        };
      });
      const executionRunOptions = participants
        .flatMap((participant) =>
          participant.runs.map((run) => {
            const triggerMessageId =
              run.run?.payload?.context?.triggerMessageId;
            const triggerMessage =
              typeof triggerMessageId === "string"
                ? messageById.get(triggerMessageId)
                : undefined;
            const runStartedAt = Date.parse(
              run.run?.startedAt ?? run.run?.createdAt ?? run.at,
            );
            const assignmentEvent = [...task.events].reverse().find((event) => {
              const eventAt = Date.parse(event.at);
              return (
                Number.isFinite(runStartedAt) &&
                Number.isFinite(eventAt) &&
                eventAt <= runStartedAt + 60_000 &&
                runStartedAt - eventAt <= 10 * 60_000 &&
                event.message.includes("调整责任人为")
              );
            });
            const instruction =
              triggerMessage?.content?.trim() ||
              assignmentEvent?.message ||
              task.description.trim();
            // Run 创建即 agent.dispatch 投递时刻，优先用它表示指令真正发送给 Agent 的时间。
            const instructionAt =
              run.run?.createdAt ?? run.run?.startedAt ?? run.at;
            return {
              ...run,
              participantName: participant.name,
              instruction,
              instructionAt,
            };
          }),
        )
        .sort((left, right) => String(left.at).localeCompare(String(right.at)))
        .map((run, index) => ({ ...run, roundNumber: index + 1 }))
        .reverse();
      const selectedRun =
        selectedRunId === "" ? undefined : runById.get(selectedRunId);
      const selectedRunOption = executionRunOptions.find(
        (run) => run.id === selectedRunId,
      );
      const toggleRoundInstruction = (runId) => {
        setExpandedRoundInstructionIds((current) =>
          current.includes(runId)
            ? current.filter((id) => id !== runId)
            : [...current, runId],
        );
      };
      const selectedRunMessage =
        selectedRunId === "" ? undefined : messageByRunId.get(selectedRunId);
      const selectedParticipant = participants.find((participant) =>
        participant.runs.some((run) => run.id === selectedRunId),
      );
      const selectedExecutionBase =
        executionLive?.run?.execution ??
        selectedRun?.execution ??
        selectedRunMessage?.execution;
      const selectedExecutionSnapshot = executionControl?.snapshot;
      const selectedExecution =
        selectedExecutionSnapshot === undefined ||
        selectedExecutionSnapshot === null
          ? selectedExecutionBase
          : {
              ...(selectedExecutionBase ?? {}),
              provider: selectedExecutionSnapshot.provider,
              model: selectedExecutionSnapshot.model,
              reasoningEffort: selectedExecutionSnapshot.reasoningEffort,
              runtime: selectedExecutionSnapshot.runtimeName,
              runtimeVersion: selectedExecutionSnapshot.runtimeVersion,
              authMode: selectedExecutionSnapshot.authMode,
              sandbox: selectedExecutionSnapshot.sandbox,
              searchEnabled: selectedExecutionSnapshot.searchEnabled,
              networkAccess: selectedExecutionSnapshot.networkAccess,
              searchUsed: selectedExecutionSnapshot.searchUsed,
              planVisibility: selectedExecutionSnapshot.planVisibility,
              gateEnforcement: selectedExecutionSnapshot.gateEnforcement,
            };
      const executionSummaryState =
        selectedExecution !== undefined && selectedExecution !== null
          ? "ready"
          : selectedRunId === ""
            ? "idle"
            : executionDetailState === "ready" ||
                executionDetailState === "error"
              ? "unavailable"
              : "loading";
      const executionText =
        executionLive?.progress?.text?.trim() ||
        selectedRunMessage?.content ||
        selectedRun?.output?.summary ||
        "暂无执行输出";
      const executionStatus =
        executionLive?.run?.status ??
        selectedRun?.status ??
        selectedRunMessage?.state ??
        "idle";
      const executionRunning = RUNNING_MESSAGE_STATES.includes(executionStatus);
      const selectedPlan = executionControl?.plan ?? null;
      const selectedExecutionEvents = Array.isArray(executionControl?.events)
        ? executionControl.events.slice(-12).reverse()
        : [];
      const pendingExecutionGates = Array.isArray(executionControl?.gates)
        ? executionControl.gates.filter((gate) => gate.status === "pending")
        : [];
      const decideExecutionGate = async (gateId, decision) => {
        try {
          await request("/api/collab/tasks/execution/gates/decide", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              gateId,
              decision,
            }),
          });
          setExecutionControl((current) =>
            current === null || !Array.isArray(current.gates)
              ? current
              : {
                  ...current,
                  gates: current.gates.map((gate) =>
                    gate.id === gateId
                      ? {
                          ...gate,
                          status: decision,
                          decidedAt: new Date().toISOString(),
                        }
                      : gate,
                  ),
                },
          );
        } catch (cause) {
          fail(cause);
        }
      };
      const selectedRunDocuments = documents.filter(
        (document) => document.runId === selectedRunId,
      );
      const latestRunId = task.agentRunIds.at(-1);
      const taskLevelDocuments = documents.filter(
        (document) =>
          document.runId === undefined && selectedRunId === latestRunId,
      );
      const visibleRunDocuments = [
        ...selectedRunDocuments,
        ...taskLevelDocuments,
      ];
      const documentSignature = `${task.id}:${task.messages.length}:${executionStatus}`;
      react.useEffect(() => {
        let disposed = false;
        const loadDocuments = async () => {
          try {
            const result = await request(
              `/api/collab/tasks/documents?taskId=${encodeURIComponent(task.id)}`,
            );
            if (disposed) return;
            setDocuments(result?.documents ?? []);
            setDocumentsReady(result?.workspaceReady !== false);
          } catch {
            if (disposed) return;
            setDocumentsReady(false);
          }
        };
        void loadDocuments();
        // 子代理可能在主运行 settle 之后才写完文件，所以详情打开期间持续刷新，
        // 而不是运行一结束就停止轮询。
        const timer = window.setInterval(() => void loadDocuments(), 8_000);
        return () => {
          disposed = true;
          if (timer !== undefined) window.clearInterval(timer);
        };
      }, [documentSignature, executionRunning]);
      react.useEffect(() => {
        const node = liveOutputRef.current;
        if (node === null) return undefined;
        const frame = window.requestAnimationFrame(() => {
          node.scrollTop = node.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
      }, [executionText]);
      const action = async (name, label, extra = {}) => {
        try {
          const endpoint =
            name === "claim"
              ? "/api/collab/tasks/claim"
              : "/api/collab/tasks/action";
          await mutate(
            endpoint,
            name === "claim"
              ? { taskId: task.id }
              : { taskId: task.id, action: name, ...extra },
            label,
          );
        } catch (cause) {
          fail(cause);
        }
      };

      const resetSession = async () => {
        if (readOnly) return;
        if (
          !window.confirm(
            "重置执行会话会另起一条新会话，下一次执行重新注入完整任务上下文；旧会话保留为只读。确认继续？",
          )
        ) {
          return;
        }
        try {
          await mutate(
            "/api/collab/tasks/session/reset",
            { taskId: task.id },
            "已重置执行会话",
          );
        } catch (cause) {
          fail(cause);
        }
      };
      const lockedTip = archived
        ? "任务已归档，复原后可操作"
        : task.status === "cancelled"
          ? "任务已取消，仅可查看历史或归档"
          : undefined;
      const archiveTask = async () => {
        try {
          await mutate(
            "/api/collab/tasks/action",
            { taskId: task.id, action: "archive" },
            "任务已归档",
          );
          onBack();
        } catch (cause) {
          fail(cause);
        }
      };
      const restoreTask = async () => {
        try {
          await mutate(
            "/api/collab/tasks/action",
            { taskId: task.id, action: "restore" },
            "任务已复原",
          );
          onRestored?.();
        } catch (cause) {
          fail(cause);
        }
      };
      const downloadDocument = async (document) => {
        try {
          const current = token();
          const response = await fetch(
            `/api/collab/tasks/document/content?taskId=${encodeURIComponent(task.id)}&path=${encodeURIComponent(document.relativePath)}`,
            {
              headers:
                current === null ? {} : { authorization: `Bearer ${current}` },
              cache: "no-store",
            },
          );
          if (!response.ok) {
            throw new Error(`下载失败（HTTP ${response.status}）`);
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const anchor = window.document.createElement("a");
          anchor.href = url;
          anchor.download = document.name;
          window.document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
        } catch (cause) {
          fail(cause);
        }
      };
      const revealDocument = async (document) => {
        try {
          await mutate(
            "/api/collab/tasks/document/reveal",
            { taskId: task.id, path: document.relativePath },
            "已在本地文件夹中打开",
          );
        } catch (cause) {
          fail(cause);
        }
      };
      const chooseAssignee = (type, id) => {
        const item = directoryOptions.find(
          (candidate) => candidate.type === type && candidate.id === id,
        );
        setPendingAssignee({
          type,
          id: type === "unassigned" ? "" : id,
          name: type === "unassigned" ? "待指派" : (item?.name ?? id),
          option: type === "unassigned" ? undefined : item,
        });
        setAssignOpen(false);
      };
      const confirmAssignee = async () => {
        if (pendingAssignee === null) return;
        try {
          await mutate(
            "/api/collab/tasks/assign",
            {
              taskId: task.id,
              receiverType: pendingAssignee.type,
              receiverId: pendingAssignee.id,
              receiverName: pendingAssignee.name,
            },
            pendingAssignee.type === "unassigned"
              ? "责任人已恢复为待指派"
              : task.status === "done"
                ? `已重新开启任务并指派给 ${pendingAssignee.name}`
                : `已确认指派给 ${pendingAssignee.name}`,
          );
          setPendingAssignee(null);
        } catch (cause) {
          fail(cause);
        }
      };

      const openWorkflow = () => {
        const workflowLink = task.links.find(
          (link) => link.type === "workflow",
        );
        const instanceId = task.workflow?.instanceId ?? workflowLink?.id;
        if (!instanceId) return;
        window.__pluginmaxShell?.setRoute("workflow");
        window.dispatchEvent(
          new CustomEvent("pluginmax:collab-navigate", {
            detail: {
              plugin: "workflow",
              instanceId,
              workspaceId: task.workspaceId,
            },
          }),
        );
      };
      const workflowActionCopy = (() => {
        if (task.status === "cancelled") {
          return "工作流节点已取消；此任务保留执行记录，其他操作已锁定，可从任务管理归档。";
        }
        if (isApprovalTask) {
          return task.status === "review"
            ? "当前审批待处理，可以在下方直接给出结论，或进入工作流查看完整审批记录。"
            : "审批结论由工作流控制，请进入工作流查看当前状态。";
        }
        if (task.receiverType === "agent") {
          const latestRun = [...task.messages]
            .reverse()
            .find((item) => item.kind === "agent");
          return ["failed", "timeout", "cancelled", "interrupted"].includes(
            latestRun?.state,
          )
            ? "Agent 最近一次运行未完成；请进入工作流详情查看结果、重试或人工代交。"
            : task.status === "progress"
              ? "Agent 正在执行工作流节点；派发、取消、重试和交付物处理请在工作流详情完成。"
              : "工作流 Agent 产出由工作流节点控制，请进入工作流查看和执行后续动作。";
        }
        if (task.status === "review") {
          return "节点产出已提交，请在工作流详情执行 Review 或使用下方结论操作。";
        }
        return task.workflow?.reviewRequired === false
          ? "请在工作流详情完成节点；任务状态会随工作流自动同步。"
          : "请在工作流详情提交交付物并完成节点；任务状态会随工作流自动同步。";
      })();

      const previewTask =
        pendingAssignee === null
          ? task
          : {
              ...task,
              receiverType: pendingAssignee.type,
              receiverId: pendingAssignee.id,
              receiverName: pendingAssignee.name,
            };
      const receiverPreview = receiverDisplay(previewTask);
      const previewOption =
        pendingAssignee?.option ??
        (task.receiverType === "human"
          ? directory.humans.find((item) => item.id === task.receiverId)
          : task.receiverType === "agent"
            ? directory.agents.find((item) => item.id === task.receiverId)
            : task.receiverType === "role"
              ? directory.roles.find((item) => item.id === task.receiverId)
              : undefined);
      const previewKind = pendingAssignee?.type ?? task.receiverType;
      const previewLabel =
        previewKind === "unassigned"
          ? "待指派"
          : receiverOptionLabel({
              ...(previewOption ?? {}),
              type: previewKind,
              name: receiverPreview,
            });
      const composerHint = archived
        ? "任务已归档 · 复原后可继续发送指令"
        : task.status === "cancelled"
          ? "任务已取消 · 仅可查看历史或归档"
          : task.receiverType === "unassigned"
            ? "暂无责任人 · 任务待指派"
            : task.status === "done"
              ? `任务已完成 · 发送指令会追加要求并在同一条会话重开一轮（${receiverDisplay(task)}）`
              : task.receiverType === "agent"
                ? `发送给 ${receiverDisplay(task)}${task.status === "progress" && taskHasActiveRun(task) ? " · Agent 执行中" : task.status === "progress" ? " · 最近一次 Agent 运行未完成" : ""}`
                : `发送给 ${receiverDisplay(task)}`;
      const commentPlaceholder = archived
        ? "任务已归档，复原后可评论"
        : task.status === "cancelled"
          ? "任务已取消，评论已锁定"
          : task.workflow !== undefined
            ? "普通讨论不触发执行；关键共识会在后续真实执行时作为背景增量同步"
            : task.receiverType === "agent"
              ? "普通讨论不进入执行上下文；关键共识下次执行时增量同步；@ 当前执行人可发起讨论反馈"
              : "普通讨论不进入 Agent 上下文；关键共识会在下次真实执行时作为背景增量同步";
      react.useEffect(() => {
        setComment("");
        setCommentIsConsensus(false);
        setReplyDrafts({});
      }, [task.id]);
      const history = [
        ...task.messages.map((item) => ({
          kind: "message",
          at: item.at,
          item,
        })),
        ...task.events
          .filter((event) => event.kind !== "message")
          .map((event) => ({ kind: "event", at: event.at, event })),
      ].sort(
        (left, right) =>
          right.at.localeCompare(left.at) ||
          (left.kind === right.kind ? 0 : left.kind === "message" ? -1 : 1),
      );
      const historyAvatar = (item) => {
        const kind = item.kind === "agent" ? "agent" : "human";
        const options = kind === "agent" ? directory.agents : directory.humans;
        const option = options.find(
          (candidate) => candidate.id === item.authorId,
        );
        return h(ReceiverAvatar, { option, kind, name: item.authorName });
      };
      return h(
        "div",
        { className: "pmtask-detail" },
        h(
          "section",
          { className: "pmtask-detail-page" },
          h(
            "div",
            { className: "pmtask-detail-top" },
            h(
              "button",
              {
                className: "pmtask-btn secondary pmtask-back-btn",
                type: "button",
                onClick: onBack,
              },
              "← 看板",
            ),
            h(
              "span",
              { className: "pmtask-crumb" },
              "任务 / ",
              h("b", null, `${task.id} ${task.title}`),
            ),
            h(TaskFollowButton, {
              taskId: task.id,
              compact: false,
              workspaceId: task.workspaceId,
              workflowInstanceId: task.workflow?.instanceId,
            }),
            h(
              "div",
              { className: "pmtask-menu pmtask-assign-select" },
              h(
                "button",
                {
                  className: `pmtask-assign-trigger${pendingAssignee === null ? "" : " pending"}`,
                  type: "button",
                  disabled: readOnly,
                  title: archived
                    ? "任务已归档，复原后可调整责任人"
                    : task.status === "cancelled"
                      ? "任务已取消，不可调整责任人"
                      : "调整责任人",
                  "aria-haspopup": "listbox",
                  "aria-expanded": assignOpen,
                  onClick: () => {
                    if (readOnly) return;
                    setAssignOpen(!assignOpen);
                  },
                },
                h(
                  "span",
                  { className: "pmtask-assign-trigger-content" },
                  h(
                    "span",
                    { className: "pmtask-assign-trigger-copy" },
                    `${previewLabel}${pendingAssignee === null ? "" : "（待确认）"}`,
                  ),
                ),
                h("span", { "aria-hidden": "true" }, "⌄"),
              ),
              assignOpen && !readOnly
                ? h(
                    "div",
                    { className: "pmtask-menu-list" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pmtask-receiver-option",
                        onClick: () => chooseAssignee("unassigned", ""),
                      },
                      h(
                        "span",
                        { className: "pmtask-receiver-option-copy" },
                        h(
                          "span",
                          { className: "pmtask-receiver-option-name" },
                          "待指派",
                        ),
                      ),
                    ),
                    ...directoryOptions.map((item) =>
                      h(
                        "button",
                        {
                          type: "button",
                          className: "pmtask-receiver-option",
                          key: `${item.type}:${item.id}`,
                          onClick: () => chooseAssignee(item.type, item.id),
                        },
                        h(
                          "span",
                          { className: "pmtask-receiver-option-copy" },
                          h(
                            "span",
                            { className: "pmtask-receiver-option-name" },
                            receiverOptionLabel(item),
                          ),
                          h(
                            "span",
                            { className: "pmtask-receiver-option-meta" },
                            receiverKindLabel(item.type),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              "div",
              { className: "pmtask-assign-actions" },
              pendingAssignee !== null
                ? h(
                    "button",
                    {
                      className: "pmtask-btn pmtask-confirm-btn",
                      type: "button",
                      onClick: confirmAssignee,
                    },
                    "确认",
                  )
                : null,
            ),
            h(
              "span",
              { className: `pmtask-pill ${task.status}` },
              statusLabel(task.status),
            ),
            archived
              ? h("span", { className: "pmtask-pill archived" }, "已归档")
              : null,
          ),
          h(
            "div",
            { className: "pmtask-detail-layout" },
            h(
              "div",
              { className: "pmtask-detail-main" },
              editing
                ? h(EditTaskForm, {
                    task,
                    workspaceTitle,
                    directory,
                    externalRuntimes,
                    onCancel: () => setEditing(false),
                    onSave: async (input) => {
                      try {
                        await mutate(
                          "/api/collab/tasks/update",
                          { taskId: task.id, ...input },
                          task.status === "done"
                            ? "已追加要求并重新开启任务"
                            : "任务内容已更新",
                        );
                        setEditing(false);
                      } catch (cause) {
                        fail(cause);
                      }
                    },
                  })
                : h(
                    "div",
                    { className: "pmtask-intro" },
                    h(
                      "div",
                      { className: "pmtask-intro-head" },
                      h("h2", null, task.title),
                      h(
                        "span",
                        {
                          className: `pmtask-pill ${task.priority === "P1" ? "p1" : ""}`,
                        },
                        priorityLabel(task.priority),
                      ),
                      task.workflow !== undefined
                        ? h(
                            "span",
                            { className: "pmtask-pill workflow" },
                            workflowSourceLabel(task),
                          )
                        : null,
                      h(
                        "button",
                        {
                          className: "pmtask-icon-btn",
                          type: "button",
                          hidden: task.workflow !== undefined,
                          disabled: readOnly,
                          title: lockedTip ?? "编辑标题、优先级和描述",
                          "aria-label": lockedTip ?? "编辑标题、优先级和描述",
                          onClick: () => setEditing(true),
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
                            "aria-hidden": "true",
                          },
                          h("path", { d: "M12 20h9" }),
                          h("path", {
                            d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
                          }),
                        ),
                      ),
                    ),
                    h("p", null, task.description),
                    h(
                      "div",
                      { className: "pmtask-grid pmtask-grid-demo" },
                      h(
                        "div",
                        { className: "pmtask-field" },
                        "归属项目",
                        h("strong", null, workspaceTitle || task.workspaceId),
                      ),
                      h(
                        "div",
                        { className: "pmtask-field" },
                        "责任人",
                        h(
                          "strong",
                          { className: "pmtask-assignee" },
                          h(
                            "span",
                            { className: "pmtask-assignee-name" },
                            receiverDisplay(task, directory),
                          ),
                        ),
                      ),
                      h(
                        "div",
                        { className: "pmtask-field" },
                        "创建人/创建时间",
                        h(
                          "strong",
                          { className: "pmtask-assignee" },
                          h(
                            "span",
                            { className: "pmtask-assignee-name" },
                            `${task.createdByName} · ${localTime(task.createdAt)}`,
                          ),
                        ),
                      ),
                      h(
                        "div",
                        { className: "pmtask-field" },
                        "优先级/到期时间",
                        h(
                          "strong",
                          null,
                          `${priorityLabel(task.priority)} · ${task.due || "不限"}`,
                        ),
                      ),
                      task.workflow?.approvalPolicy !== undefined
                        ? h(
                            "div",
                            { className: "pmtask-field" },
                            "审批规则",
                            h(
                              "strong",
                              null,
                              task.workflow.approvalPolicy === "any"
                                ? "或签（任一审批人通过即可）"
                                : "并签（全部审批人通过后才完成）",
                            ),
                          )
                        : null,
                      task.workflow !== undefined
                        ? h(
                            "div",
                            { className: "pmtask-field" },
                            "Review 策略",
                            h("strong", null, workflowReviewLabel(task)),
                          )
                        : task.receiverType === "agent"
                          ? h(
                              "div",
                              { className: "pmtask-field" },
                              "完成后自动提交Review",
                              h(
                                "strong",
                                null,
                                task.autoSubmitReview !== false
                                  ? "已开启"
                                  : "已关闭",
                              ),
                            )
                          : null,
                      task.workflow !== undefined
                        ? h(
                            "div",
                            { className: "pmtask-field" },
                            "工作流节点",
                            h(
                              "strong",
                              null,
                              `${task.workflow.nodeName}${task.workflow.nodeAttempt === undefined ? "" : ` · 第 ${task.workflow.nodeAttempt} 轮`}`,
                            ),
                          )
                        : null,
                      task.workflow?.outcome !== undefined
                        ? h(
                            "div",
                            { className: "pmtask-field" },
                            "工作流结论",
                            h(
                              "strong",
                              null,
                              {
                                approved: "已通过",
                                rejected: "已退回",
                                cancelled: "已取消",
                                superseded: "已被新一轮替代",
                              }[task.workflow.outcome] ?? task.workflow.outcome,
                            ),
                          )
                        : null,
                      task.workflow !== undefined &&
                        task.workflow.approvalPolicy === undefined
                        ? h(
                            "div",
                            { className: "pmtask-field pmtask-review-config" },
                            h(
                              "label",
                              { className: "pmtask-check" },
                              h("input", {
                                type: "checkbox",
                                checked: task.autoApproveReview === true,
                                disabled: readOnly || archived,
                                onChange: (event) => {
                                  const enabled = event.target.checked;
                                  void mutate(
                                    "/api/collab/tasks/review/approval",
                                    {
                                      taskId: task.id,
                                      autoApproveReview: enabled,
                                    },
                                    enabled
                                      ? "提交后将自动通过 Review"
                                      : "提交后将等待人工 Review",
                                  ).catch(fail);
                                },
                              }),
                              h(
                                "span",
                                null,
                                "提交后自动通过 Review",
                                h(
                                  "em",
                                  null,
                                  "适用于执行任务；审批任务必须保留明确结论。",
                                ),
                              ),
                            ),
                          )
                        : null,
                    ),
                    task.steps.length > 0
                      ? h(
                          "div",
                          { className: "pmtask-acceptance" },
                          h(
                            "div",
                            { className: "pmtask-acceptance-head" },
                            h("strong", null, "验收标准"),
                            h(
                              "span",
                              null,
                              `${task.steps.filter((step) => step.done).length} / ${task.steps.length} 已完成`,
                            ),
                          ),
                          h(
                            "div",
                            { className: "pmtask-steps" },
                            ...task.steps.map((step) => {
                              const locked =
                                readOnly || task.workflow !== undefined;
                              return h(
                                "label",
                                {
                                  className: `pmtask-step${step.done ? " done" : ""}${locked ? " disabled" : ""}`,
                                  key: step.id,
                                },
                                h("input", {
                                  type: "checkbox",
                                  checked: step.done,
                                  disabled: locked,
                                  onChange: (event) => {
                                    const done = event.target.checked;
                                    void mutate(
                                      "/api/collab/tasks/step",
                                      {
                                        taskId: task.id,
                                        stepId: step.id,
                                        done,
                                      },
                                      done ? "验收项已勾选" : "验收项已取消",
                                    ).catch(fail);
                                  },
                                }),
                                h("span", null, step.label),
                              );
                            }),
                          ),
                        )
                      : null,
                    archived
                      ? h(
                          "p",
                          { className: "pmtask-locked-hint" },
                          "任务已归档：内容、状态、回复与执行指令均已锁定，点「复原」后可继续操作。",
                        )
                      : task.status === "cancelled"
                        ? h(
                            "p",
                            { className: "pmtask-locked-hint" },
                            "任务已取消：内容、状态、回复与执行指令均已锁定；如需从看板收起，可执行「归档」。",
                          )
                        : null,
                    task.workflow !== undefined
                      ? h(
                          "div",
                          { className: "pmtask-workflow-action" },
                          h(
                            "div",
                            { className: "pmtask-workflow-action-copy" },
                            h("strong", null, "由工作流节点驱动"),
                            h("span", null, workflowActionCopy),
                          ),
                          h(
                            "div",
                            { className: "pmtask-workflow-action-buttons" },
                            h(
                              "button",
                              {
                                className: "pmtask-btn",
                                type: "button",
                                onClick: openWorkflow,
                              },
                              "打开工作流节点",
                            ),
                            isApprovalTask &&
                              canReview &&
                              task.status === "review"
                              ? h(
                                  "button",
                                  {
                                    className: "pmtask-btn secondary",
                                    type: "button",
                                    onClick: () =>
                                      void action("approve", "审批已通过"),
                                  },
                                  "通过审批",
                                )
                              : null,
                            isApprovalTask &&
                              canReview &&
                              task.status === "review"
                              ? h(
                                  "button",
                                  {
                                    className: "pmtask-btn secondary",
                                    type: "button",
                                    onClick: () => setRejectOpen(true),
                                  },
                                  "退回审批",
                                )
                              : null,
                            !archived && task.status === "cancelled"
                              ? h(
                                  "button",
                                  {
                                    className: "pmtask-btn secondary",
                                    type: "button",
                                    onClick: () => setConfirmArchive(true),
                                  },
                                  "归档",
                                )
                              : null,
                            archived
                              ? h(
                                  "button",
                                  {
                                    className: "pmtask-btn secondary",
                                    type: "button",
                                    onClick: () => void restoreTask(),
                                  },
                                  "复原",
                                )
                              : null,
                          ),
                        )
                      : h(
                          "div",
                          { className: "pmtask-actions" },
                          canClaim
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () =>
                                    void action("claim", "已认领任务"),
                                },
                                "认领",
                              )
                            : null,
                          mine &&
                            task.receiverType !== "role" &&
                            task.status === "todo"
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () =>
                                    void action("start", "任务已开始"),
                                },
                                "开始",
                              )
                            : null,
                          mine &&
                            task.status === "progress" &&
                            task.workflow?.approvalPolicy === undefined
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () =>
                                    void action("submit", "已提交验收"),
                                },
                                "提交验收",
                              )
                            : null,
                          canReview &&
                            (task.status === "review" ||
                              (task.workflow?.approvalPolicy !== undefined &&
                                task.status === "progress"))
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () =>
                                    void action("approve", "任务已完成"),
                                },
                                isApprovalTask ? "通过审批" : "通过",
                              )
                            : null,
                          canReview &&
                            (task.status === "review" ||
                              (task.workflow?.approvalPolicy !== undefined &&
                                task.status === "progress"))
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () => setRejectOpen(true),
                                },
                                isApprovalTask ? "退回审批" : "退回",
                              )
                            : null,
                          sent &&
                            !isSettledStatus(task.status) &&
                            // 催办只针对「指派给人类」的任务：Agent 的推进靠指令/改派。
                            task.receiverType === "human"
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  disabled: readOnly,
                                  title: lockedTip,
                                  onClick: () =>
                                    void action("nudge", "已提醒责任人"),
                                },
                                "催办",
                              )
                            : null,
                          // 「重置会话」入口先隐藏：前期用户还不熟这个语义，
                          // 需要时把下面这个开关改回 true 即可（服务端能力保留）。
                          SHOW_SESSION_RESET &&
                            task.receiverType === "agent" &&
                            !readOnly
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  title:
                                    "另起一条新会话并重新注入完整任务上下文；旧会话保留为只读",
                                  onClick: () => void resetSession(),
                                },
                                "重置会话",
                              )
                            : null,
                          task.receiverType === "agent" ||
                            task.agentRunIds.length > 0
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  title:
                                    "打开这条任务对应的 Agent 执行会话（左侧项目下的那条会话）",
                                  onClick: () => void openAgentSession(),
                                },
                                "打开会话",
                              )
                            : null,
                          archived
                            ? h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  onClick: () => void restoreTask(),
                                },
                                "复原",
                              )
                            : h(
                                "button",
                                {
                                  className: "pmtask-btn secondary",
                                  type: "button",
                                  onClick: () => setConfirmArchive(true),
                                },
                                "归档",
                              ),
                        ),
                  ),
              task.workflow !== undefined
                ? null
                : h(
                    "div",
                    { className: "pmtask-composer" },
                    h(
                      "div",
                      { className: "pmtask-composer-toolbar" },
                      h(
                        "button",
                        {
                          className: "pmtask-tool-btn",
                          type: "button",
                          disabled: readOnly,
                          title: lockedTip ?? "插入表情",
                          "aria-label": "插入表情",
                          onClick: () => setMessage((current) => `${current}☺`),
                        },
                        "☺",
                      ),
                      h(
                        "label",
                        {
                          className: "pmtask-tool-btn",
                          title: lockedTip ?? "上传附件",
                          style: readOnly
                            ? { opacity: 0.5, pointerEvents: "none" }
                            : undefined,
                          "aria-label": "上传附件",
                        },
                        h(
                          "svg",
                          {
                            viewBox: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: 2,
                            strokeLinecap: "round",
                            "aria-hidden": "true",
                          },
                          h("path", {
                            d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
                          }),
                        ),
                        h("input", {
                          type: "file",
                          multiple: true,
                          hidden: true,
                          disabled: readOnly,
                          onChange: (event) => {
                            const picked = Array.from(event.target.files ?? []);
                            event.target.value = "";
                            if (picked.length === 0) return;
                            setAttachments((current) => [
                              ...current,
                              ...picked,
                            ]);
                          },
                        }),
                      ),
                      h(
                        "button",
                        {
                          className: "pmtask-tool-btn",
                          type: "button",
                          disabled: readOnly,
                          title: lockedTip ?? "插入 @ 提及",
                          "aria-haspopup": "listbox",
                          "aria-expanded": mentionOpen,
                          onClick: () => {
                            if (readOnly) return;
                            setMentionQuery("");
                            setMentionOpen((value) => !value);
                          },
                        },
                        "@",
                      ),
                      mentionOpen
                        ? h(MentionMenu, {
                            directory,
                            query: mentionQuery,
                            onPick: insertMention,
                          })
                        : null,
                    ),
                    h("textarea", {
                      ref: messageRef,
                      className: "pmtask-composer-input",
                      rows: 4,
                      value: message,
                      readOnly: readOnly,
                      placeholder: archived
                        ? "任务已归档，复原后可继续发送指令"
                        : task.status === "cancelled"
                          ? "任务已取消，仅可查看历史或归档"
                          : "输入 / 补充给执行 Agent 的指令，或反馈任务进展。可 @ 人员、DE 和分身",
                      onChange: (event) => {
                        const value = event.target.value;
                        setMessage(value);
                        const cursor =
                          event.target.selectionStart ?? value.length;
                        const token = value
                          .slice(0, cursor)
                          .match(/@([^@\s]*)$/);
                        setMentionOpen(token !== null);
                        setMentionQuery(token?.[1] ?? "");
                      },
                      onKeyDown: (event) => {
                        if (
                          event.key === "Enter" &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault();
                          void sendMessage();
                        }
                        if (event.key === "Escape") setMentionOpen(false);
                      },
                    }),
                    attachments.length > 0
                      ? h(
                          "div",
                          { className: "pmtask-attachments" },
                          ...attachments.map((file, index) =>
                            h(
                              "span",
                              {
                                className: "pmtask-attachment",
                                key: `${file.name}:${index}`,
                              },
                              "📎 ",
                              h("span", null, file.name),
                              h(
                                "button",
                                {
                                  type: "button",
                                  "aria-label": `移除附件 ${file.name}`,
                                  onClick: () =>
                                    setAttachments((current) =>
                                      current.filter(
                                        (_candidate, candidateIndex) =>
                                          candidateIndex !== index,
                                      ),
                                    ),
                                },
                                "×",
                              ),
                            ),
                          ),
                        )
                      : null,
                    h(
                      "div",
                      { className: "pmtask-composer-footer" },
                      h(
                        "span",
                        { className: "pmtask-compose-hint" },
                        composerHint,
                      ),
                      h(
                        "div",
                        { className: "pmtask-compose-actions" },
                        h(
                          "button",
                          {
                            className: "pmtask-btn secondary",
                            type: "button",
                            onClick: () => {
                              setMessage("");
                              setAttachments([]);
                              setPickedMentions([]);
                              setMentionOpen(false);
                            },
                          },
                          "清空",
                        ),
                        h(
                          "button",
                          {
                            className: "pmtask-btn",
                            type: "button",
                            disabled:
                              readOnly ||
                              (message.trim() === "" &&
                                attachments.length === 0) ||
                              task.receiverType === "unassigned",
                            onClick: () => void sendMessage(),
                          },
                          "发送",
                        ),
                      ),
                    ),
                  ),
              h(
                "div",
                { className: "pmtask-detail-section" },
                h(
                  "div",
                  { className: "pmtask-history-head" },
                  h("h3", null, "执行历史"),
                  h(
                    "span",
                    null,
                    `${task.messages.length} 条交互记录 · 当前负责人 ${receiverDisplay(task, directory)}`,
                  ),
                ),
                h(
                  "div",
                  { className: "pmtask-history" },
                  ...history.map((entry) =>
                    entry.kind === "message"
                      ? h(
                          "article",
                          {
                            className: "pmtask-history-message",
                            key: `message:${entry.item.id}`,
                          },
                          historyAvatar(entry.item),
                          h(
                            "div",
                            { className: "pmtask-message-body" },
                            h(
                              "div",
                              { className: "pmtask-message-head" },
                              h("strong", null, entry.item.authorName),
                              entry.item.kind === "agent" &&
                                entry.item.runRole !== undefined
                                ? h(
                                    "span",
                                    {
                                      className: `pmtask-run-role ${entry.item.runRole}`,
                                    },
                                    runRoleLabel(entry.item.runRole),
                                  )
                                : null,
                              h(
                                "span",
                                null,
                                `${localTime(entry.item.at)}${entry.item.kind === "agent" ? " · Agent" : ""}`,
                              ),
                            ),
                            h(
                              "div",
                              { className: "pmtask-bubble" },
                              h(MarkdownText, { text: entry.item.content }),
                              ["queued", "running", "waiting_input"].includes(
                                entry.item.state,
                              )
                                ? h("span", {
                                    className: "pmtask-stream-caret",
                                  })
                                : null,
                            ),
                            entry.item.attachments.length > 0
                              ? h(
                                  "div",
                                  { className: "pmtask-attachments" },
                                  ...entry.item.attachments.map((file) =>
                                    h(
                                      "span",
                                      {
                                        className: "pmtask-attachment",
                                        key: file.name,
                                      },
                                      "📎 ",
                                      h("span", null, file.name),
                                    ),
                                  ),
                                )
                              : null,
                            h(RunExecutionMeta, {
                              execution: entry.item.execution,
                            }),
                          ),
                        )
                      : h(
                          "article",
                          {
                            className: "pmtask-history-event",
                            key: `event:${entry.event.id}`,
                          },
                          h("span", { className: "pmtask-event-avatar" }, "◉"),
                          h(
                            "div",
                            { className: "pmtask-event-copy" },
                            entry.event.kind === "workflow"
                              ? `${entry.event.actorName} ${entry.event.message}`
                              : entry.event.message,
                            h("time", null, localTime(entry.event.at)),
                          ),
                        ),
                  ),
                  history.length === 0
                    ? h(
                        "div",
                        { className: "pmtask-empty" },
                        "任务还没有回复记录。",
                      )
                    : null,
                ),
              ),
              h(
                "div",
                { className: "pmtask-detail-section" },
                h("h3", null, "评论与回复"),
                h(
                  "div",
                  { className: "pmtask-comment-list" },
                  ...task.comments.map((item) =>
                    h(
                      "article",
                      { className: "pmtask-history-comment", key: item.id },
                      h(
                        "div",
                        { className: "pmtask-message-head" },
                        h("strong", null, item.authorName),
                        h("span", null, localTime(item.at)),
                        item.isKeyConsensus
                          ? h(
                              "span",
                              { className: "pmtask-pill consensus" },
                              "关键共识",
                            )
                          : null,
                      ),
                      h("div", { className: "pmtask-bubble" }, item.content),
                      item.replies.length > 0
                        ? h(
                            "div",
                            { className: "pmtask-reply-list" },
                            ...item.replies.map((reply) =>
                              h(
                                "div",
                                { key: reply.id },
                                h(
                                  "div",
                                  { className: "pmtask-message-head" },
                                  h("strong", null, reply.authorName),
                                  h("span", null, localTime(reply.at)),
                                ),
                                h(
                                  "div",
                                  { className: "pmtask-bubble" },
                                  reply.content,
                                ),
                              ),
                            ),
                          )
                        : null,
                      h(
                        "form",
                        {
                          className: "pmtask-reply-form",
                          onSubmit: async (event) => {
                            event.preventDefault();
                            if (readOnly) return;
                            const content = (replyDrafts[item.id] ?? "").trim();
                            if (content === "") return;
                            try {
                              await mutate(
                                "/api/collab/tasks/comment/reply",
                                {
                                  taskId: task.id,
                                  commentId: item.id,
                                  content,
                                },
                                "回复已发送",
                              );
                              setReplyDrafts((current) => ({
                                ...current,
                                [item.id]: "",
                              }));
                            } catch (cause) {
                              fail(cause);
                            }
                          },
                        },
                        h("input", {
                          className: "pmtask-input",
                          value: replyDrafts[item.id] ?? "",
                          disabled: readOnly,
                          placeholder: `回复 ${item.authorName}（仅讨论，不触发执行）`,
                          onChange: (event) =>
                            setReplyDrafts((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            })),
                        }),
                        h(
                          "button",
                          {
                            className: "pmtask-btn secondary",
                            type: "submit",
                            disabled:
                              readOnly ||
                              (replyDrafts[item.id] ?? "").trim() === "",
                          },
                          "回复",
                        ),
                      ),
                    ),
                  ),
                  task.comments.length === 0
                    ? h("div", { className: "pmtask-empty" }, "还没有评论。")
                    : null,
                ),
                h(
                  "form",
                  {
                    className: "pmtask-comment-form",
                    onSubmit: async (event) => {
                      event.preventDefault();
                      if (readOnly) return;
                      const content = comment.trim();
                      if (content === "") return;
                      try {
                        await mutate(
                          "/api/collab/tasks/comment",
                          {
                            taskId: task.id,
                            content,
                            isKeyConsensus: commentIsConsensus,
                          },
                          "评论已添加",
                        );
                        setComment("");
                        setCommentIsConsensus(false);
                      } catch (cause) {
                        fail(cause);
                      }
                    },
                  },
                  h(
                    "p",
                    { className: "pmtask-comment-guide" },
                    "评论用于协作讨论，不会立即触发任务执行。勾选「关键共识」后，将在下次向 Agent 发送执行反馈时作为背景增量同步；普通评论和回复不会进入执行上下文。",
                  ),
                  h("input", {
                    className: "pmtask-input",
                    value: comment,
                    disabled: readOnly,
                    placeholder: commentPlaceholder,
                    onChange: (event) => setComment(event.target.value),
                  }),
                  h(
                    "button",
                    {
                      className: "pmtask-btn secondary",
                      type: "submit",
                      disabled: readOnly || comment.trim() === "",
                    },
                    "评论",
                  ),
                  h(
                    "label",
                    {
                      className: "pmtask-check pmtask-comment-consensus",
                      "data-disabled": readOnly,
                    },
                    h("input", {
                      type: "checkbox",
                      checked: commentIsConsensus,
                      disabled: readOnly,
                      "aria-label": "标记为关键共识",
                      onChange: (event) =>
                        setCommentIsConsensus(event.target.checked),
                    }),
                    h(
                      "span",
                      { className: "pmtask-comment-consensus-copy" },
                      h("span", null, "关键共识"),
                      h(
                        "em",
                        null,
                        "仅标记已经确认的决策、约束或结论，不标记个人提议。",
                      ),
                    ),
                  ),
                ),
              ),
            ),
            h(
              "aside",
              { className: "pmtask-detail-side" },
              h(
                "div",
                { className: "pmtask-side-section" },
                h("h3", null, "关联事项"),
                ...(task.links.length === 0
                  ? [
                      h(
                        "div",
                        { className: "pmtask-side-empty" },
                        "未关联会议或工作流。",
                      ),
                    ]
                  : task.links.map((link) =>
                      h(
                        "div",
                        {
                          className: "pmtask-link",
                          key: `${link.type}:${link.id}`,
                        },
                        h(
                          "div",
                          null,
                          h(
                            "small",
                            null,
                            link.type === "meeting" ? "会议" : "工作流",
                          ),
                          h("div", null, h("strong", null, link.label)),
                        ),
                        h(
                          "button",
                          {
                            className: "pmtask-btn secondary",
                            type: "button",
                            onClick: () => {
                              window.__pluginmaxShell?.setRoute(
                                link.type === "meeting"
                                  ? "meeting"
                                  : "workflow",
                              );
                              window.dispatchEvent(
                                new CustomEvent("pluginmax:collab-navigate", {
                                  detail:
                                    link.type === "meeting"
                                      ? {
                                          plugin: "meeting",
                                          meetingId: link.id,
                                          workspaceId: task.workspaceId,
                                        }
                                      : {
                                          plugin: "workflow",
                                          instanceId: link.id,
                                          workspaceId: task.workspaceId,
                                        },
                                }),
                              );
                            },
                          },
                          link.type === "meeting" ? "打开会议" : "打开工作流",
                        ),
                      ),
                    )),
              ),
              h(
                "div",
                {
                  className: "pmtask-side-section pmtask-execution-record",
                },
                h(
                  "div",
                  { className: "pmtask-live-head" },
                  executionRunning
                    ? h("span", {
                        className: "pmtask-spinner",
                        role: "status",
                        "aria-label": "正在执行",
                      })
                    : h("span", { className: "pmtask-live-dot" }),
                  h("h3", null, "AI执行记录"),
                  h(
                    "span",
                    { className: "pmtask-side-empty" },
                    executionRunOptions.length === 0
                      ? "暂无"
                      : `${executionRunOptions.length} 轮`,
                  ),
                ),
                executionRunOptions.length === 0
                  ? h("div", { className: "pmtask-side-empty" }, "暂无执行记录")
                  : [
                      h(
                        "div",
                        {
                          className: "pmtask-execution-runs",
                        },
                        h(
                          "span",
                          { className: "pmtask-execution-runs-label" },
                          "轮次",
                        ),
                        h(
                          "div",
                          {
                            className: "pmtask-execution-round-picker",
                          },
                          h(
                            "button",
                            {
                              className: "pmtask-execution-round-trigger",
                              type: "button",
                              "aria-expanded": roundMenuOpen,
                              "aria-controls": `pmtask-round-menu-${task.id}`,
                              onClick: () =>
                                setRoundMenuOpen((current) => !current),
                              onKeyDown: (event) => {
                                if (event.key === "Escape") {
                                  setRoundMenuOpen(false);
                                }
                              },
                            },
                            h(
                              "span",
                              null,
                              `第 ${selectedRunOption?.roundNumber ?? 1} 轮 · ${selectedRunOption?.participantName ?? "AI伙伴"} · ${runStatusLabel(executionStatus)}`,
                            ),
                            selectedRunOption === undefined
                              ? null
                              : h(
                                  "time",
                                  {
                                    className:
                                      "pmtask-execution-round-trigger-time",
                                    dateTime: selectedRunOption.instructionAt,
                                    title: "指令发送时间",
                                  },
                                  localTime(selectedRunOption.instructionAt),
                                ),
                            h("span", {
                              className: "pmtask-round-caret",
                              "aria-hidden": "true",
                            }),
                          ),
                          roundMenuOpen
                            ? h(
                                "div",
                                {
                                  id: `pmtask-round-menu-${task.id}`,
                                  className: "pmtask-execution-round-menu",
                                  role: "group",
                                  "aria-label": "轮次与指令",
                                },
                                ...executionRunOptions.map((run) => {
                                  const selected = run.id === selectedRunId;
                                  const instructionExpanded =
                                    expandedRoundInstructionIds.includes(
                                      run.id,
                                    );
                                  const selectRun = () => {
                                    setSelectedRunId(run.id);
                                    setRoundMenuOpen(false);
                                  };
                                  return h(
                                    "div",
                                    {
                                      className: `pmtask-execution-round-option${selected ? " selected" : ""}`,
                                      key: run.id,
                                      onClick: selectRun,
                                    },
                                    h(
                                      "button",
                                      {
                                        className:
                                          "pmtask-execution-round-option-head",
                                        type: "button",
                                        "data-run-id": run.id,
                                        "aria-pressed": selected,
                                        onClick: (event) => {
                                          event.stopPropagation();
                                          selectRun();
                                        },
                                      },
                                      h(
                                        "span",
                                        {
                                          className:
                                            "pmtask-execution-round-option-title",
                                        },
                                        `第 ${run.roundNumber} 轮 · ${run.participantName}`,
                                        h(
                                          "span",
                                          {
                                            className:
                                              "pmtask-execution-round-option-status",
                                          },
                                          ` · ${runStatusLabel(run.status)}`,
                                        ),
                                      ),
                                      h(
                                        "time",
                                        {
                                          className:
                                            "pmtask-execution-round-option-time",
                                          dateTime: run.instructionAt,
                                          title: "指令发送时间",
                                        },
                                        localTime(run.instructionAt),
                                      ),
                                    ),
                                    h(ExecutionRoundInstruction, {
                                      instruction: run.instruction,
                                      expanded: instructionExpanded,
                                      onToggle: () =>
                                        toggleRoundInstruction(run.id),
                                    }),
                                  );
                                }),
                              )
                            : null,
                          !roundMenuOpen && selectedRunOption !== undefined
                            ? h(ExecutionRoundInstruction, {
                                instruction: selectedRunOption.instruction,
                                expanded: expandedRoundInstructionIds.includes(
                                  selectedRunOption.id,
                                ),
                                onToggle: () =>
                                  toggleRoundInstruction(selectedRunOption.id),
                                extraClassName:
                                  "pmtask-selected-round-instruction",
                              })
                            : null,
                        ),
                      ),
                      h(
                        "div",
                        { className: "pmtask-execution-blocks" },
                        h(
                          "section",
                          { className: "pmtask-execution-block" },
                          h(
                            "h4",
                            null,
                            "产出物",
                            h(
                              "span",
                              null,
                              visibleRunDocuments.length === 0
                                ? ""
                                : `${visibleRunDocuments.length}`,
                            ),
                          ),
                          visibleRunDocuments.length === 0
                            ? h(
                                "div",
                                { className: "pmtask-doc-empty" },
                                documentsReady
                                  ? "本轮暂无产出物"
                                  : "任务工作区不可用",
                              )
                            : h(
                                "div",
                                { className: "pmtask-doc-list" },
                                ...visibleRunDocuments.map((document) =>
                                  h(
                                    "div",
                                    {
                                      className: "pmtask-doc",
                                      key: document.id,
                                    },
                                    h(
                                      "div",
                                      { className: "pmtask-doc-info" },
                                      h(
                                        "button",
                                        {
                                          className: "pmtask-doc-name",
                                          type: "button",
                                          disabled: !document.available,
                                          title: document.available
                                            ? `下载 ${document.name}`
                                            : "该附件未存储到工作区",
                                          onClick: () =>
                                            void downloadDocument(document),
                                        },
                                        h(
                                          "span",
                                          { className: "pmtask-doc-kind" },
                                          document.kind === "uploaded"
                                            ? "上传"
                                            : "产出",
                                        ),
                                        h("span", null, document.name),
                                      ),
                                      h(
                                        "div",
                                        { className: "pmtask-doc-meta" },
                                        `${document.updatedBy} · ${localTime(document.updatedAt)}`,
                                      ),
                                    ),
                                    document.available
                                      ? h(
                                          "button",
                                          {
                                            className: "pmtask-tool-btn",
                                            type: "button",
                                            title: "在本地文件夹中显示",
                                            "aria-label": "在本地文件夹中显示",
                                            onClick: () =>
                                              void revealDocument(document),
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
                                              "aria-hidden": "true",
                                            },
                                            h("path", {
                                              d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
                                            }),
                                          ),
                                        )
                                      : null,
                                  ),
                                ),
                              ),
                        ),
                        h(
                          "section",
                          { className: "pmtask-execution-block" },
                          h(
                            "h4",
                            null,
                            "执行过程",
                            h("span", null, runStatusLabel(executionStatus)),
                          ),
                          h(
                            "div",
                            {
                              className: "pmtask-live-output",
                              ref: liveOutputRef,
                            },
                            h(MarkdownText, { text: executionText }),
                          ),
                        ),
                        h(
                          "section",
                          { className: "pmtask-execution-block" },
                          h(
                            "h4",
                            null,
                            "Agent 执行计划",
                            h(
                              "span",
                              null,
                              selectedPlan === null
                                ? "暂无"
                                : `${planVisibilityLabel(selectedPlan.visibility)} · ${planSourceLabel(selectedPlan.source)}`,
                            ),
                          ),
                          selectedExecution?.gateEnforcement === "observe-only"
                            ? h(
                                "div",
                                { className: "pmtask-gate observe-only" },
                                h("strong", null, "仅执行后观察"),
                                h(
                                  "p",
                                  null,
                                  "该 Runtime 无法在工具执行前阻断。平台会记录已观察到的动作，但不能把它展示为已成功拦截。",
                                ),
                              )
                            : null,
                          pendingExecutionGates.length === 0
                            ? null
                            : h(
                                "div",
                                { className: "pmtask-gate" },
                                h("strong", null, "等待执行授权"),
                                h("p", null, pendingExecutionGates[0].reason),
                                h(
                                  "div",
                                  {
                                    className: "pmtask-gate-actions",
                                  },
                                  h(
                                    "button",
                                    {
                                      className: "pmtask-btn",
                                      type: "button",
                                      onClick: () =>
                                        void decideExecutionGate(
                                          pendingExecutionGates[0].id,
                                          "approved",
                                        ),
                                    },
                                    "批准",
                                  ),
                                  h(
                                    "button",
                                    {
                                      className: "pmtask-btn secondary danger",
                                      type: "button",
                                      onClick: () =>
                                        void decideExecutionGate(
                                          pendingExecutionGates[0].id,
                                          "denied",
                                        ),
                                    },
                                    "拒绝",
                                  ),
                                ),
                              ),
                          selectedPlan === null
                            ? h(
                                "div",
                                { className: "pmtask-side-empty" },
                                "当前 Run 尚未产生 Agent Execution Plan。",
                              )
                            : [
                                selectedPlan.summary
                                  ? h(
                                      "p",
                                      {
                                        className: "pmtask-locked-hint",
                                      },
                                      selectedPlan.summary,
                                    )
                                  : null,
                                h(
                                  "ol",
                                  { className: "pmtask-plan-list" },
                                  ...(selectedPlan.steps ?? []).map((step) =>
                                    h(
                                      "li",
                                      {
                                        className: `pmtask-plan-step ${step.status}`,
                                        key: step.id,
                                      },
                                      h("span", {
                                        className: "pmtask-plan-step-dot",
                                        "aria-hidden": "true",
                                      }),
                                      h(
                                        "span",
                                        {
                                          className: "pmtask-plan-step-title",
                                        },
                                        step.title,
                                        step.detail
                                          ? h("small", null, step.detail)
                                          : null,
                                      ),
                                      h(
                                        "span",
                                        {
                                          className: "pmtask-plan-step-status",
                                        },
                                        runStatusLabel(step.status),
                                      ),
                                    ),
                                  ),
                                ),
                                selectedExecutionEvents.length === 0
                                  ? null
                                  : h(
                                      "ul",
                                      {
                                        className: "pmtask-execution-events",
                                      },
                                      ...selectedExecutionEvents.map((item) =>
                                        h(
                                          "li",
                                          {
                                            className: "pmtask-execution-event",
                                            key: item.id,
                                          },
                                          h("strong", null, item.summary),
                                          h(
                                            "time",
                                            {
                                              dateTime: item.createdAt,
                                            },
                                            localTime(item.createdAt),
                                          ),
                                        ),
                                      ),
                                    ),
                              ],
                        ),
                        h(
                          "section",
                          { className: "pmtask-execution-block" },
                          h(
                            "h4",
                            null,
                            "运行信息",
                            h(
                              "span",
                              null,
                              selectedParticipant?.name ?? "AI伙伴",
                            ),
                          ),
                          h(RunExecutionSummary, {
                            execution: selectedExecution,
                            state: executionSummaryState,
                          }),
                        ),
                      ),
                    ],
              ),
              h(
                "div",
                { className: "pmtask-side-section" },
                h("h3", null, "任务动态"),
                h(
                  "div",
                  { className: "pmtask-timeline" },
                  ...task.events
                    .slice(-5)
                    .reverse()
                    .map((event) =>
                      h(
                        "div",
                        { className: "pmtask-timeline-event", key: event.id },
                        h("time", null, localTime(event.at)),
                        h("span", null, event.message),
                      ),
                    ),
                ),
              ),
            ),
          ),
          confirmArchive
            ? h(ConfirmDialog, {
                title: "归档该任务？",
                description: `归档后「${task.title}」将从任务看板移入归档视图，执行历史、评论与验收记录都会保留，之后可以随时复原。`,
                confirmLabel: "确认归档",
                tone: "danger",
                onCancel: () => setConfirmArchive(false),
                onConfirm: () => {
                  setConfirmArchive(false);
                  void archiveTask();
                },
              })
            : null,
          rejectOpen
            ? h(RejectDialog, {
                title: isApprovalTask ? "退回审批" : "退回任务",
                onCancel: () => setRejectOpen(false),
                onConfirm: (note) => {
                  setRejectOpen(false);
                  void action(
                    "reject",
                    isApprovalTask ? "审批已退回" : "已退回",
                    { note },
                  );
                },
              })
            : null,
        ),
      );
    }

    function EditTaskForm({
      task,
      workspaceTitle,
      directory,
      externalRuntimes,
      onCancel,
      onSave,
    }) {
      const initialPolicy = executionPolicyForm(task);
      const responsibleAgent =
        task.receiverType === "agent"
          ? (directory?.agents ?? []).find(
              (agent) => agent.id === task.receiverId,
            )
          : undefined;
      const boundRuntimeId =
        initialPolicy.runtimeId !== ""
          ? initialPolicy.runtimeId
          : responsibleAgent?.execution === "external"
            ? (responsibleAgent.externalRuntimeId ?? "")
            : "";
      const [form, setForm] = react.useState({
        title: task.title,
        priority: task.priority,
        description: task.description,
        acceptance: task.acceptance.join("\n"),
        due: task.due ?? "",
        autoSubmitReview: task.autoSubmitReview !== false,
        ...initialPolicy,
        runtimeId: boundRuntimeId,
        model: boundRuntimeId === "" ? "" : initialPolicy.model,
        reasoningEffort:
          boundRuntimeId === "" ? "" : initialPolicy.reasoningEffort,
      });
      const selectedRuntime = (externalRuntimes ?? []).find(
        (runtime) => runtime.id === form.runtimeId,
      );
      const runtimeDisplayValue =
        selectedRuntime?.name ??
        (boundRuntimeId !== ""
          ? boundRuntimeId
          : responsibleAgent === undefined
            ? "未指派 AI伙伴"
            : responsibleAgent.execution === "external"
              ? (responsibleAgent.externalRuntimeId ?? "外部 Runtime 未绑定")
              : "内置执行");
      const runtimeDisplayHint =
        selectedRuntime?.status === "active"
          ? "来自任务执行 AI伙伴定义，任务内不可修改。"
          : selectedRuntime !== undefined
            ? "该 Runtime 当前不可用。"
            : boundRuntimeId !== ""
              ? "该 Runtime 不存在或已归档。"
              : responsibleAgent === undefined
                ? "运行时会随责任 AI伙伴自动确定。"
                : "来自 AI伙伴定义，任务内不可修改。";
      const modelChoices = [
        ...new Set([
          ...(selectedRuntime?.supportedModels ?? []),
          ...(selectedRuntime?.defaultModel === undefined
            ? []
            : [selectedRuntime.defaultModel]),
        ]),
      ];
      return h(
        "form",
        {
          className: "pmtask-intro pmtask-edit-form",
          onSubmit: (event) => {
            event.preventDefault();
            void onSave({
              title: form.title.trim(),
              priority: form.priority,
              description: form.description.trim(),
              acceptance: form.acceptance
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
              due: form.due || undefined,
              executionPolicy: buildExecutionPolicy(form),
              ...(task.receiverType === "agent" || task.workflow !== undefined
                ? { autoSubmitReview: form.autoSubmitReview }
                : {}),
            });
          },
        },
        // 归属项目在这里只读展示：任务创建后不允许变更项目。
        h(
          "div",
          { className: "pmtask-field pmtask-edit-locked" },
          "归属项目",
          h(
            "strong",
            null,
            `${workspaceTitle || task.workspaceId}（创建后不可变更）`,
          ),
        ),
        h(
          "div",
          { className: "pmtask-edit-title-row" },
          h(
            "label",
            { className: "pmtask-field pmtask-edit-grow" },
            "标题",
            h("input", {
              className: "pmtask-input",
              value: form.title,
              required: true,
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  title: event.target.value,
                })),
            }),
          ),
          h(
            "label",
            { className: "pmtask-field pmtask-edit-priority" },
            "优先级",
            h(
              "select",
              {
                className: "pmtask-select",
                value: form.priority,
                onChange: (event) =>
                  setForm((current) => ({
                    ...current,
                    priority: event.target.value,
                  })),
              },
              h("option", { value: "P1" }, "P0"),
              h("option", { value: "P2" }, "P1"),
              h("option", { value: "P3" }, "P2"),
            ),
          ),
        ),
        h(
          "label",
          { className: "pmtask-field" },
          "描述",
          h("textarea", {
            className: "pmtask-area",
            rows: 5,
            value: form.description,
            required: true,
            placeholder: "补充背景、期望结果、边界和风险。",
            onChange: (event) =>
              setForm((current) => ({
                ...current,
                description: event.target.value,
              })),
          }),
        ),
        h(
          "label",
          { className: "pmtask-field" },
          "验收标准（每行一条）",
          h("textarea", {
            className: "pmtask-area",
            rows: 4,
            value: form.acceptance,
            placeholder: "例如：必须有 md 文档输出",
            onChange: (event) =>
              setForm((current) => ({
                ...current,
                acceptance: event.target.value,
              })),
          }),
        ),
        h(
          "label",
          { className: "pmtask-field" },
          "到期时间",
          h("input", {
            className: "pmtask-input",
            type: "date",
            value: form.due,
            onChange: (event) =>
              setForm((current) => ({ ...current, due: event.target.value })),
          }),
        ),
        h(
          "div",
          { className: "pmtask-field" },
          "执行策略",
          h(
            "label",
            { className: "pmtask-check" },
            h("input", {
              type: "checkbox",
              checked: form.allowPublicWeb,
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  allowPublicWeb: event.target.checked,
                })),
            }),
            h(
              "span",
              null,
              "允许公开网页与监管文件",
              h(
                "em",
                null,
                "启用后要求事实性结论记录来源、发布日期和访问时间。",
              ),
            ),
          ),
          h(
            "label",
            { className: "pmtask-check" },
            h("input", {
              type: "checkbox",
              checked: form.requireToolApproval,
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  requireToolApproval: event.target.checked,
                })),
            }),
            h("span", null, "写文件、执行命令和外部发布前需要人工确认"),
          ),
          h(
            "label",
            { className: "pmtask-check" },
            h("input", {
              type: "checkbox",
              checked: form.requireToolEvents,
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  requireToolEvents: event.target.checked,
                })),
            }),
            h("span", null, "要求记录实际工具调用事件"),
          ),
          h(
            "div",
            { className: "pmtask-execution-overrides" },
            h(
              "div",
              { className: "pmtask-field" },
              "执行运行时（只读）",
              h(
                "div",
                {
                  className: "pmtask-execution-runtime",
                  role: "textbox",
                  "aria-readonly": "true",
                },
                h("span", null, runtimeDisplayValue),
                h("span", { className: "pmtask-readonly-badge" }, "只读"),
              ),
              h(
                "span",
                { className: "pmtask-locked-hint" },
                runtimeDisplayHint,
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "本轮模型",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.model,
                  disabled:
                    selectedRuntime === undefined ||
                    selectedRuntime.status !== "active",
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      model: event.target.value,
                    })),
                },
                h(
                  "option",
                  { value: "" },
                  selectedRuntime?.defaultModel
                    ? `Runtime 默认（${selectedRuntime.defaultModel}）`
                    : "沿用 Runtime 默认模型",
                ),
                ...modelChoices.map((model) =>
                  h("option", { value: model, key: model }, model),
                ),
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "推理强度",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.reasoningEffort,
                  disabled:
                    selectedRuntime === undefined ||
                    selectedRuntime.status !== "active",
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      reasoningEffort: event.target.value,
                    })),
                },
                h("option", { value: "" }, "沿用 Runtime 默认值"),
                ...REASONING_EFFORT_OPTIONS.map((option) =>
                  h(
                    "option",
                    { value: option.value, key: option.value },
                    option.label,
                  ),
                ),
              ),
            ),
          ),
        ),
        task.receiverType === "agent" && task.workflow === undefined
          ? h(
              "label",
              { className: "pmtask-check" },
              h("input", {
                type: "checkbox",
                checked: form.autoSubmitReview,
                onChange: (event) =>
                  setForm((current) => ({
                    ...current,
                    autoSubmitReview: event.target.checked,
                  })),
              }),
              h(
                "span",
                null,
                "Agent 完成指定产出物后，自动将任务状态调整为「待Review」",
                h(
                  "em",
                  null,
                  "默认勾选：完成后即提交 review。取消勾选则保留在执行中，由人工手动提交验收。",
                ),
              ),
            )
          : null,
        h(
          "div",
          { className: "pmtask-compose-actions" },
          h(
            "button",
            {
              className: "pmtask-btn secondary",
              type: "button",
              onClick: onCancel,
            },
            "取消",
          ),
          h(
            "button",
            {
              className: "pmtask-btn",
              type: "submit",
              disabled:
                responsibleAgent?.execution === "external" &&
                selectedRuntime?.status !== "active",
            },
            "保存内容",
          ),
        ),
      );
    }

    function CreateTaskModal({
      workspaces,
      directory,
      externalRuntimes,
      currentWorkspaceId,
      initialStatus,
      onClose,
      onCreated,
    }) {
      const initialReceiverType =
        directory.humans.length > 0
          ? "human"
          : directory.agents.length > 0
            ? "agent"
            : directory.roles.length > 0
              ? "role"
              : "unassigned";
      const initialReceiver =
        initialReceiverType === "human"
          ? directory.humans[0]
          : initialReceiverType === "agent"
            ? directory.agents[0]
            : initialReceiverType === "role"
              ? directory.roles[0]
              : undefined;
      const initialRuntimeId =
        initialReceiverType === "agent" &&
        initialReceiver?.execution === "external"
          ? (initialReceiver.externalRuntimeId ?? "")
          : "";
      const [form, setForm] = react.useState({
        workspaceId: currentWorkspaceId || workspaces[0]?.id || "",
        title: "",
        type: "任务",
        priority: "P2",
        status: initialStatus || "todo",
        receiverType: initialReceiverType,
        receiverId: initialReceiver?.id ?? "",
        receiverName: initialReceiver?.name ?? "",
        description: "",
        acceptance: "",
        due: "",
        autoSubmitReview: true,
        allowPublicWeb: false,
        requireToolApproval: true,
        requireToolEvents: false,
        runtimeId: initialRuntimeId,
        model: "",
        reasoningEffort: "",
      });
      const receiverValue =
        form.receiverType === "unassigned"
          ? "unassigned:"
          : `${form.receiverType}:${form.receiverId}`;
      const chooseReceiver = (value) => {
        const separator = value.indexOf(":");
        const type = value.slice(0, separator);
        const id = value.slice(separator + 1);
        const item =
          type === "human"
            ? directory.humans.find((candidate) => candidate.id === id)
            : type === "agent"
              ? directory.agents.find((candidate) => candidate.id === id)
              : type === "role"
                ? directory.roles.find((candidate) => candidate.id === id)
                : undefined;
        setForm((current) => ({
          ...current,
          receiverType: type,
          receiverId: id,
          receiverName: item?.name ?? "",
          runtimeId:
            type === "agent" && item?.execution === "external"
              ? (item.externalRuntimeId ?? "")
              : "",
          model: "",
          reasoningEffort: "",
        }));
      };
      const selectedAgent =
        form.receiverType === "agent"
          ? directory.agents.find((item) => item.id === form.receiverId)
          : undefined;
      const selectedRuntime = (externalRuntimes ?? []).find(
        (runtime) => runtime.id === form.runtimeId,
      );
      const modelChoices = [
        ...new Set([
          ...(selectedRuntime?.supportedModels ?? []),
          ...(selectedRuntime?.defaultModel === undefined
            ? []
            : [selectedRuntime.defaultModel]),
        ]),
      ];
      return h(
        "div",
        {
          className: "pmtask-mask",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          "form",
          {
            className: "pmtask-modal",
            onSubmit: (event) => {
              event.preventDefault();
              const acceptance = form.acceptance
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean);
              void onCreated({
                ...form,
                title: form.title.trim(),
                description: form.description.trim(),
                acceptance: acceptance.length
                  ? acceptance
                  : ["按描述完成并自查"],
                receiverId:
                  form.receiverType === "unassigned"
                    ? undefined
                    : form.receiverId,
                receiverName:
                  form.receiverType === "unassigned"
                    ? undefined
                    : form.receiverName,
                executionPolicy: buildExecutionPolicy(form),
              });
            },
          },
          h(
            "div",
            { className: "pmtask-modal-head" },
            h("h2", null, "派发任务 / Issue"),
            h(
              "button",
              {
                className: "pmtask-btn secondary",
                type: "button",
                onClick: onClose,
              },
              "关闭",
            ),
          ),
          h(
            "div",
            { className: "pmtask-modal-grid" },
            h(
              "label",
              { className: "pmtask-field" },
              "标题",
              h("input", {
                className: "pmtask-input",
                value: form.title,
                required: true,
                onChange: (event) =>
                  setForm((current) => ({
                    ...current,
                    title: event.target.value,
                  })),
              }),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "类型",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.type,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      type: event.target.value,
                    })),
                },
                h("option", null, "任务"),
                h("option", null, "缺陷"),
                h("option", null, "评审"),
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "项目（必填）",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.workspaceId,
                  required: true,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      workspaceId: event.target.value,
                    })),
                },
                h(
                  "option",
                  { value: "" },
                  workspaces.length === 0 ? "暂无可用项目" : "请选择项目",
                ),
                ...workspaces.map((workspace) =>
                  h(
                    "option",
                    { value: workspace.id, key: workspace.id },
                    workspace.title,
                  ),
                ),
              ),
              workspaces.length === 0
                ? h(
                    "span",
                    { className: "pmtask-locked-hint" },
                    "任务必须归属到一个项目。请先在左侧栏「项目」区域点击 + 新建项目，再回来派发。",
                  )
                : null,
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "优先级",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.priority,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      priority: event.target.value,
                    })),
                },
                h("option", { value: "P1" }, "P0"),
                h("option", { value: "P2" }, "P1"),
                h("option", { value: "P3" }, "P2"),
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "初始状态",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: form.status,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value,
                    })),
                },
                ...STATUSES.filter((status) => status.key !== "cancelled").map(
                  (status) =>
                    h(
                      "option",
                      { value: status.key, key: status.key },
                      status.label,
                    ),
                ),
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "责任人",
              h(
                "select",
                {
                  className: "pmtask-select",
                  value: receiverValue,
                  onChange: (event) => chooseReceiver(event.target.value),
                },
                h("option", { value: "unassigned:" }, "待指派"),
                directory.humans.length > 0
                  ? h(
                      "optgroup",
                      { label: "人员" },
                      ...directory.humans.map((item) =>
                        h(
                          "option",
                          {
                            value: `human:${item.id}`,
                            key: `human:${item.id}`,
                          },
                          item.name,
                        ),
                      ),
                    )
                  : null,
                directory.agents.length > 0
                  ? h(
                      "optgroup",
                      { label: "DE / 分身" },
                      ...directory.agents.map((item) =>
                        h(
                          "option",
                          {
                            value: `agent:${item.id}`,
                            key: `agent:${item.id}`,
                          },
                          item.ownerName
                            ? receiverOptionLabel({ ...item, type: "agent" })
                            : item.name,
                        ),
                      ),
                    )
                  : null,
                directory.roles.length > 0
                  ? h(
                      "optgroup",
                      { label: "角色" },
                      ...directory.roles.map((item) =>
                        h(
                          "option",
                          { value: `role:${item.id}`, key: `role:${item.id}` },
                          item.name,
                        ),
                      ),
                    )
                  : null,
              ),
            ),
            h(
              "label",
              { className: "pmtask-field" },
              "到期时间",
              h("input", {
                className: "pmtask-input",
                type: "date",
                value: form.due,
                onChange: (event) =>
                  setForm((current) => ({
                    ...current,
                    due: event.target.value,
                  })),
              }),
            ),
            form.receiverType === "agent"
              ? h(
                  "label",
                  { className: "pmtask-check pmtask-span-2" },
                  h("input", {
                    type: "checkbox",
                    checked: form.autoSubmitReview,
                    onChange: (event) =>
                      setForm((current) => ({
                        ...current,
                        autoSubmitReview: event.target.checked,
                      })),
                  }),
                  h(
                    "span",
                    null,
                    "Agent 完成指定产出物后，自动将任务状态调整为「待Review」",
                    h(
                      "em",
                      null,
                      "默认勾选：完成后即提交 review。取消勾选则保留在执行中，由人工手动提交验收。",
                    ),
                  ),
                )
              : null,
            h(
              "div",
              { className: "pmtask-field pmtask-span-2" },
              "执行策略",
              h(
                "label",
                { className: "pmtask-check" },
                h("input", {
                  type: "checkbox",
                  checked: form.allowPublicWeb,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      allowPublicWeb: event.target.checked,
                    })),
                }),
                h(
                  "span",
                  null,
                  "允许公开网页与监管文件",
                  h(
                    "em",
                    null,
                    "研究类任务建议开启；事实性结论将要求来源、发布日期和访问时间。",
                  ),
                ),
              ),
              h(
                "label",
                { className: "pmtask-check" },
                h("input", {
                  type: "checkbox",
                  checked: form.requireToolApproval,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      requireToolApproval: event.target.checked,
                    })),
                }),
                h("span", null, "写文件、执行命令和外部发布前需要人工确认"),
              ),
              h(
                "label",
                { className: "pmtask-check" },
                h("input", {
                  type: "checkbox",
                  checked: form.requireToolEvents,
                  onChange: (event) =>
                    setForm((current) => ({
                      ...current,
                      requireToolEvents: event.target.checked,
                    })),
                }),
                h("span", null, "要求记录实际工具调用事件"),
              ),
              h(
                "div",
                { className: "pmtask-execution-overrides" },
                h(
                  "div",
                  { className: "pmtask-field" },
                  "执行运行时（只读）",
                  h(
                    "div",
                    {
                      className: "pmtask-execution-runtime",
                      role: "textbox",
                      "aria-readonly": "true",
                    },
                    h(
                      "span",
                      null,
                      selectedAgent === undefined
                        ? "未指派 AI伙伴"
                        : selectedAgent.execution === "external"
                          ? (selectedRuntime?.name ??
                            selectedAgent.externalRuntimeId ??
                            "外部 Runtime 未绑定")
                          : "内置执行",
                    ),
                    h("span", { className: "pmtask-readonly-badge" }, "只读"),
                  ),
                  h(
                    "span",
                    { className: "pmtask-locked-hint" },
                    selectedAgent === undefined
                      ? "运行时会随责任 AI伙伴自动确定。"
                      : selectedAgent.execution === "external"
                        ? selectedRuntime === undefined
                          ? "AI伙伴绑定的 Runtime 不存在或已归档。"
                          : selectedRuntime.status !== "active"
                            ? "AI伙伴绑定的 Runtime 当前不可用。"
                            : "来自 AI伙伴定义，任务内不可修改。"
                        : "来自 AI伙伴定义，任务内不可修改。",
                  ),
                ),
                h(
                  "label",
                  { className: "pmtask-field" },
                  "本轮模型",
                  h(
                    "select",
                    {
                      className: "pmtask-select",
                      value: form.model,
                      disabled:
                        selectedRuntime === undefined ||
                        selectedRuntime.status !== "active",
                      onChange: (event) =>
                        setForm((current) => ({
                          ...current,
                          model: event.target.value,
                        })),
                    },
                    h(
                      "option",
                      { value: "" },
                      selectedRuntime?.defaultModel
                        ? `Runtime 默认（${selectedRuntime.defaultModel}）`
                        : "沿用 Runtime 默认模型",
                    ),
                    ...modelChoices.map((model) =>
                      h("option", { value: model, key: model }, model),
                    ),
                  ),
                  h(
                    "span",
                    { className: "pmtask-locked-hint" },
                    selectedRuntime === undefined
                      ? selectedAgent?.execution === "external"
                        ? "AI伙伴绑定的 Runtime 当前不可用，无法选择模型。"
                        : "先选择绑定了外部 Runtime 的 AI伙伴，才能指定本轮模型。"
                      : modelChoices.length === 0
                        ? "该 Runtime 尚未声明模型池，将使用 CLI 默认模型。"
                        : "模型必须来自 Runtime 定义中的模型池。",
                  ),
                ),
                h(
                  "label",
                  { className: "pmtask-field" },
                  "推理强度",
                  h(
                    "select",
                    {
                      className: "pmtask-select",
                      value: form.reasoningEffort,
                      disabled:
                        selectedRuntime === undefined ||
                        selectedRuntime.status !== "active",
                      onChange: (event) =>
                        setForm((current) => ({
                          ...current,
                          reasoningEffort: event.target.value,
                        })),
                    },
                    h("option", { value: "" }, "沿用 Runtime 默认值"),
                    ...REASONING_EFFORT_OPTIONS.map((option) =>
                      h(
                        "option",
                        { value: option.value, key: option.value },
                        option.label,
                      ),
                    ),
                  ),
                  h(
                    "span",
                    { className: "pmtask-locked-hint" },
                    selectedRuntime === undefined
                      ? "只有外部 Runtime 任务可以指定推理强度。"
                      : selectedRuntime.provider === "workbuddy"
                        ? "将映射为 CodeBuddy 的 --effort。"
                        : selectedRuntime.provider === "codex"
                          ? "将映射为 Codex 的 model_reasoning_effort 配置。"
                          : "通用命令不自动翻译该参数；仍会写入 Run 快照。",
                  ),
                ),
              ),
            ),
          ),
          h(
            "label",
            { className: "pmtask-field" },
            "描述",
            h("textarea", {
              className: "pmtask-area",
              rows: 4,
              value: form.description,
              required: true,
              placeholder: "补充背景、期望结果、边界和风险。",
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  description: event.target.value,
                })),
            }),
          ),
          h(
            "label",
            { className: "pmtask-field" },
            "验收标准（每行一条）",
            h("textarea", {
              className: "pmtask-area",
              rows: 4,
              value: form.acceptance,
              placeholder: "例如：失败任务能在 3 次内自动重试",
              onChange: (event) =>
                setForm((current) => ({
                  ...current,
                  acceptance: event.target.value,
                })),
            }),
          ),
          h(
            "div",
            { className: "pmtask-compose-actions" },
            h(
              "button",
              {
                className: "pmtask-btn secondary",
                type: "button",
                onClick: onClose,
              },
              "取消",
            ),
            h(
              "button",
              {
                className: "pmtask-btn",
                type: "submit",
                disabled:
                  form.title.trim() === "" ||
                  form.description.trim() === "" ||
                  form.workspaceId === "" ||
                  (form.receiverType !== "unassigned" &&
                    form.receiverId === "") ||
                  (form.receiverType === "agent" &&
                    selectedAgent?.execution === "external" &&
                    selectedRuntime?.status !== "active"),
              },
              "派发",
            ),
          ),
        ),
      );
    }

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      /**
       * 打开任务对应的 Agent 执行会话：走 DSH 的会话控制器切到那条会话，
       * 再把 shell 切到会话视图。DSH 侧会隐藏「空会话」，所以这里只负责
       * 打开，查找失败由调用方提示。
       */
      window.__pluginmaxOpenSession = (sessionId) => {
        if (typeof sessionId !== "string" || sessionId === "") return false;
        const sessions =
          typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
        if (sessions === undefined || typeof sessions.open !== "function") {
          return false;
        }
        try {
          sessions.open(sessionId);
        } catch {
          return false;
        }
        window.__pluginmaxShell?.setRoute?.("session");
        return true;
      };
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          {
            name: "pluginmax.global",
            id: "pluginmax-task",
            order: 25,
          },
          TaskGlobalPage,
        ),
      );
    };

    return module.exports;
  },
});
