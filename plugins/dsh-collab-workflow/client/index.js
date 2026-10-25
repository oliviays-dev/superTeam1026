window.__ModuleLoader__.load({
  id: "dsh-collab-workflow",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");

    const TOKEN_KEY = "pluginmax.collab.token";

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

    const RefreshIcon = () =>
      jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children: [
          jsxRuntime.jsx("path", { d: "M21 12a9 9 0 1 1-3-6.7" }),
          jsxRuntime.jsx("path", { d: "M21 3v6h-6" }),
        ],
      });
    const css = `
.pmwf{container-type:inline-size;color:var(--dsw-alias-label-primary);font-family:inherit}
.pmwf *{box-sizing:border-box}
/* 页面内边距由 shell 的 .pmx-page 提供，这里不再叠加，保持与工作台一致的内容宽度。 */
.pmwf-page{max-width:none;margin:0;padding:0}
.pmwf-context{display:flex;align-items:center;gap:8px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.pmwf-context strong{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:600}
.pmwf-context span{overflow:hidden;text-overflow:ellipsis}
.pmwf-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin:0 0 14px}
.pmwf-heading h1{margin:0;font-size:19px;line-height:1.25;white-space:nowrap}
.pmwf-heading-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pmwf-meeting-toggle{width:32px;height:32px;flex:none;display:grid;place-items:center;padding:0;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer}
.pmwf-meeting-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pmwf-meeting-toggle.active{color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 50%,transparent)}
.pmwf-meeting-toggle svg{width:15px;height:15px}
.pmwf-filter{flex:none;border:0.5px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 34%,transparent);border-radius:999px;padding:4px 8px;color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent);font-size:11px;white-space:nowrap}
.pmwf-inline-feedback{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-success-primary,#1f8f53);font-size:11.5px}
.pmwf-inline-feedback.error{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.pmwf-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0 0 12px}
.pmwf-kpi{display:grid;gap:3px;min-width:0;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-kpi>span{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-kpi>strong{font-size:22px;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.pmwf-kpi>strong.up{color:var(--dsw-alias-state-success-primary,#34d47e)}
.pmwf-kpi>strong.down{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-kpi>small{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-toolbar-clear{flex:none;margin-left:0;white-space:nowrap}
.pmwf-overview{display:grid;gap:6px;margin:0 0 12px;padding:10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-overview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.pmwf-overview-head-left{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}
.pmwf-overview-head h3{margin:0;font-size:12.5px;line-height:1.4}
.pmwf-overview-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pmwf-overview-legend span{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.pmwf-overview-legend i{width:9px;height:9px;display:inline-block;border:1px solid var(--dsw-alias-border-l3)}
.pmwf-overview-legend i.task{border-radius:0;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 18%,transparent)}
.pmwf-overview-legend i.approval{border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-agent-primary,#9b8cff) 20%,transparent)}
.pmwf-overview-legend i.decision{transform:skewX(-12deg);background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.pmwf-overview-legend i.subworkflow{border-style:dashed;background:transparent}
.pmwf-overview-track{display:flex;align-items:center;gap:4px;overflow-x:auto;padding:2px 0 4px}
.pmwf-overview-stage{display:flex;flex-direction:column;gap:5px;flex:none}
.pmwf-overview-stage.parallel{align-self:center;padding:5px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base)}
.pmwf-overview-stage.branch{align-self:center;padding:5px;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-base)}
.pmwf-overview-stage.branch .pmwf-overview-stage-title{color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-overview-stage-title{color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;line-height:1.3;white-space:nowrap}
.pmwf-overview-lane{display:flex;min-width:0}
.pmwf-overview-node{flex:1 1 auto;display:grid;gap:4px;min-width:124px;max-width:170px;padding:7px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);text-align:left;font:inherit}
.pmwf-overview-select{display:grid;gap:4px;min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.pmwf-overview-select:focus-visible,.pmwf-overview-delivery:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#4f8ef7);outline-offset:2px;border-radius:3px}
.pmwf-overview-node:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3))}
.pmwf-overview-node.approval{border-radius:10px}
.pmwf-overview-node.decision{clip-path:polygon(5% 0,100% 0,95% 100%,0 100%)}
.pmwf-overview-node.subworkflow{border-style:dashed}
.pmwf-overview-node.current{box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-overview-node.completed{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 45%,transparent)}
.pmwf-overview-node.blocked,.pmwf-overview-node.failed{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 45%,transparent)}
.pmwf-overview-node-title{display:flex;align-items:flex-start;gap:5px;min-width:0}
.pmwf-overview-node-index{flex:none;display:inline-grid;place-items:center;min-width:17px;height:15px;padding:0 3px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700;line-height:1}
.pmwf-overview-kind{flex:none;padding:0 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:8.5px;font-weight:600;line-height:1.7}
.pmwf-overview-node-title strong{min-width:0;font-size:11.5px;line-height:1.35;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-overview-node-meta{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-overview-branch-label{color:var(--dsw-alias-label-tertiary);font-size:8.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-overview-subflow{align-self:flex-start;padding:0 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:8.5px;line-height:1.7;white-space:nowrap}
.pmwf-overview-node-foot{display:flex;align-items:center;justify-content:space-between;gap:4px;min-width:0}
.pmwf-overview-state{margin-left:auto;font-size:9.5px;line-height:1.3;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.pmwf-overview-state.completed{color:var(--dsw-alias-state-success-primary,#34d47e)}
.pmwf-overview-state.current{color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-overview-state.blocked,.pmwf-overview-state.failed{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-overview-state.waiting{color:var(--dsw-alias-state-warning-primary,#d99a26)}
.pmwf-overview-delivery{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:9.5px;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;cursor:pointer;white-space:nowrap}
.pmwf-overview-delivery:hover{color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-overview-arrow{flex:none;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;user-select:none}
.pmwf-overview-reset{margin-left:auto}
.pmwf-overview-loop{display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--dsw-alias-state-warning-primary,#d99a26);font-size:10.5px;line-height:1.4}
.pmwf-overview-loop small{color:var(--dsw-alias-label-tertiary)}
.pmwf-overview-template{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10.5px;cursor:pointer}
.pmwf-overview-template b{color:var(--dsw-alias-accent-primary,#4f8ef7);font-weight:600;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}
.pmwf-overview-template:hover b{color:var(--dsw-alias-label-primary)}
.pmwf-delivery-popover{position:fixed;z-index:60;width:min(320px,calc(100vw - 24px));max-height:min(280px,calc(100vh - 24px));overflow:auto;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 12px 28px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}
.pmwf-delivery-popover h4{margin:0 0 6px;font-size:12px}
.pmwf-delivery-popover ul{display:grid;gap:4px;margin:0;padding:0;list-style:none}
.pmwf-delivery-popover li{display:grid;grid-template-columns:minmax(80px,.9fr) minmax(0,1.1fr);gap:8px;padding:5px 0;border-top:0.5px solid var(--dsw-alias-border-l2);font-size:11px}
.pmwf-delivery-popover li span:first-child{color:var(--dsw-alias-label-secondary)}
.pmwf-delivery-popover li span:last-child{text-align:right;overflow-wrap:anywhere}
.pmwf-delivery-popover .pending{color:var(--dsw-alias-label-tertiary)}
.pmwf-delivery-popover .submitted{color:var(--dsw-alias-state-success-primary,#34d47e)}
.pmwf-delivery-popover .rejected{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-delivery-popover .pmwf-delivery-time{display:inline;color:var(--dsw-alias-label-tertiary);font-size:9.5px;font-weight:400;white-space:nowrap}
.pmwf-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:2px 0 8px}
.pmwf-list-head h2{margin:0;font-size:14px;line-height:1.4}
.pmwf-list-head span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pmwf.is-detail-mode .pmwf-kpis,.pmwf.is-detail-mode .pmwf-toolbar,.pmwf.is-detail-mode .pmwf-list-head,.pmwf.is-detail-mode .pmwf-toolbar-note{display:none}
.pmwf-list.detail-mode{grid-template-columns:minmax(0,1fr)}
.pmwf-list.detail-mode .pmwf-summary-row,.pmwf-list.detail-mode .pmwf-placeholder{display:none}
.pmwf-list.detail-mode .pmwf-detail{grid-column:1;grid-row:auto}
.pmwf-list.detail-mode .pmwf-detail-inner{position:static;max-height:none}
.pmwf-detail-back{flex:none}
.pmwf-detail-page-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
@media(max-width:960px){.pmwf-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pmwf-project-filter,.pmwf-status-multi,.pmwf-owner-filter{flex:0 0 180px;width:180px;min-width:0}
.pmwf-search{width:auto;min-width:180px;flex:1 1 240px}
.pmwf-search-submit{flex:0 0 auto;min-width:96px;margin-left:0}
.pmwf-select,.pmwf-input,.pmwf-area{border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:7px 9px;font:inherit;font-size:13px;min-width:0;width:100%;box-sizing:border-box}
.pmwf-select{width:auto;min-width:112px}
.pmwf-status-multi{position:relative}
.pmwf-status-multi summary{display:flex;align-items:center;justify-content:space-between;gap:7px;min-height:33px;padding:7px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;list-style:none;user-select:none}
.pmwf-status-multi summary span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmwf-status-multi summary::-webkit-details-marker{display:none}
.pmwf-status-multi[open] summary{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 58%,transparent)}
.pmwf-status-multi-arrow{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
.pmwf-status-menu{position:absolute;z-index:24;top:calc(100% + 5px);left:0;width:max(100%,190px);display:grid;gap:3px;padding:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 12px 28px rgba(0,0,0,.18)}
.pmwf-status-option{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:5px;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}
.pmwf-status-option:hover{background:var(--dsw-alias-bg-layer-2)}
.pmwf-status-option input{margin:0;accent-color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-status-clear{justify-self:end;min-height:24px;padding:2px 7px;font-size:11.5px}
.pmwf-btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;min-height:33px;padding:7px 11px;font:inherit;font-size:13px;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pmwf-btn.secondary{background:transparent;border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.pmwf-scope-seg{display:inline-flex;flex:none;align-items:center;gap:2px;padding:2px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));white-space:nowrap}
.pmwf-scope-seg .pmwf-btn{min-height:26px;flex:none;padding:4px 9px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.pmwf-scope-seg .pmwf-btn:not(.active):hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pmwf-scope-seg .pmwf-btn.active{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-btn.small{min-height:27px;padding:4px 8px;font-size:12px}
.pmwf-iconbtn{width:28px;height:28px;flex:none;display:grid;place-items:center;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer}
.pmwf-iconbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pmwf-iconbtn svg{width:14px;height:14px}
.pmwf-input.small{min-height:27px;padding:4px 8px;font-size:12px;width:auto}
.pmwf-btn:disabled{opacity:.45;cursor:not-allowed}
.pmwf-mask{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.24);backdrop-filter:blur(2px)}
.pmwf-dialog{width:min(720px,calc(100vw - 40px));height:min(640px,calc(100vh - 40px));overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:13px;padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 22px 54px rgba(0,0,0,.22)}
.pmwf-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.pmwf-dialog-head h3{margin:0;font-size:16px}
.pmwf-dialog .pmwf-form{min-height:0;overflow:auto;align-content:start;margin-top:0;padding-top:12px;padding-right:2px}
.pmwf-dialog-field{display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.pmwf-dialog-field>span{font-weight:600;color:var(--dsw-alias-label-primary)}
.pmwf-template-preview{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:220px;gap:7px;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}
.pmwf-template-preview h4{margin:0;font-size:12.5px}
.pmwf-template-preview-list{display:grid;align-content:start;gap:8px;height:218px;overflow:auto;padding-right:3px}
.pmwf-template-preview-node{position:relative;display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base)}
.pmwf-template-preview-node:not(:last-child)::after{content:"";position:absolute;left:29px;top:38px;bottom:-9px;width:1px;background:var(--dsw-alias-border-l3);}
.pmwf-template-preview-node.branch{margin-left:18px;border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 22%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 5%,var(--dsw-alias-bg-base));}
.pmwf-template-preview-index{position:relative;z-index:1;width:36px;height:28px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 35%,transparent);border-radius:7px;color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent);font-size:10px;font-weight:700;}
.pmwf-template-preview-index.branch{color:var(--dsw-alias-state-warning-primary,#d99a26);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 10%,transparent);}
.pmwf-template-preview-main{min-width:0}
.pmwf-template-preview-title{display:flex;align-items:center;flex-wrap:wrap;gap:7px}
.pmwf-template-preview-title strong{font-size:12.5px}
.pmwf-template-preview-type{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap}
.pmwf-template-preview-meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.45}
.pmwf-template-preview-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.pmwf-template-preview-desc{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.pmwf-dialog-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.pmwf-dialog-actions .pmwf-btn{min-width:88px}
.pmwf-name-field{margin-top:5px}
.pmwf-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.pmwf-page-head h1{margin:0;font-size:19px;line-height:1.25}
.pmwf-page-sub{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.pmwf-template-inline{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-template-inline-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pmwf-template-inline-head h2{margin:0;font-size:16px}
.pmwf-template-inline-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pmwf-template-inline-desc{max-width:760px;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5}
.pmwf-template-inline-body{display:grid;grid-template-columns:270px minmax(0,1fr);align-items:start}
.pmwf-template-sidebar{min-width:0;height:100%;overflow:auto;padding:10px;border-right:1px solid var(--dsw-alias-border-l2)}
.pmwf-profile-search{display:flex;align-items:center;gap:7px;margin-bottom:8px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base)}
.pmwf-profile-search input{min-height:0;padding:0;border:0;background:transparent;font-size:11.5px}
.pmwf-profile-list{display:grid;gap:5px}
.pmwf-profile-list-item{width:100%;display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:start;gap:8px;padding:10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}
.pmwf-profile-list-item:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pmwf-profile-list-item.active{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent)}
.pmwf-profile-list-dot{width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.pmwf-profile-list-dot.enabled{background:var(--dsw-alias-state-success-primary,#34d47e);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 10%,transparent)}
.pmwf-profile-list-copy{min-width:0}.pmwf-profile-list-copy strong,.pmwf-profile-list-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pmwf-profile-list-copy strong{font-size:12px}.pmwf-profile-list-copy small{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px}
.pmwf-archived-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin-top:5px;padding:7px 8px;border:1px dashed var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;text-align:left;cursor:pointer}
.pmwf-archived-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pmwf-archived-toggle .chevron{display:inline-block;transition:transform .16s ease}
.pmwf-archived-toggle.open .chevron{transform:rotate(90deg)}
.pmwf-archived-count{flex:none;min-width:18px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);text-align:center}
.pmwf-profile-list-item.archived{opacity:.72}
.pmwf-profile-workspace{color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}
.pmwf-profile-detail{min-width:0;min-height:420px;padding:16px}
.pmwf-profile-detail-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l3)}
.pmwf-profile-detail-section:first-child{margin-top:0;padding-top:0;border-top:0}
.pmwf-profile-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.pmwf-node-section-head{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pmwf-profile-detail-head h3{margin:0;font-size:15px}
.pmwf-profile-meta{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pmwf-profile-preview-title{margin-bottom:6px;color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:700}
.pmwf-profile-node-list{display:grid;gap:8px;padding-top:10px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.pmwf-profile-node-card{position:relative;display:grid;grid-template-columns:40px minmax(0,1fr);gap:10px;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base)}
.pmwf-profile-node-card:not(:last-child)::after{content:"";position:absolute;left:35px;top:38px;bottom:-9px;width:1px;background:var(--dsw-alias-border-l3)}
.pmwf-profile-node-card:last-child::after{content:"";position:absolute;left:35px;top:38px;bottom:-18px;width:1px;background:var(--dsw-alias-border-l3)}
.pmwf-profile-node-list{margin-bottom:18px}
.pmwf-profile-node-card.branch{margin-left:18px;border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 23%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 7%,var(--dsw-alias-bg-base))}
.pmwf-profile-node-index{position:relative;z-index:1;width:36px;height:28px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 35%,transparent);border-radius:7px;color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent);font-size:10px;font-weight:700}
.pmwf-profile-node-index.branch{color:var(--dsw-alias-state-warning-primary,#d99a26);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 10%,transparent)}
.pmwf-profile-node-main{min-width:0}.pmwf-profile-node-title{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.pmwf-profile-node-title strong{font-size:12.5px}
.pmwf-profile-node-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:10.5px}.pmwf-profile-node-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.pmwf-profile-node-main p{margin:7px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55}
.pmwf-list{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;align-items:start;align-content:start}
.pmwf-placeholder{display:none}
/* 左列表 + 右详情：流程卡片用 display:contents 把行与详情面板变成同一网格的两列。 */
.pmwf-flow{display:contents;min-width:0}
.pmwf-summary-row{grid-column:1;min-width:0;max-width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-summary-row:hover{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3))}
.pmwf-summary-row.active{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 8%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)))}
.pmwf-summary-row>.pmwf-summary{flex:1 1 auto;min-width:0}
.pmwf-summary{display:grid;grid-template-columns:auto minmax(240px,.8fr) minmax(280px,1.2fr) 160px;gap:10px;align-items:center;width:100%;min-height:56px;padding:9px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.pmwf-summary:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}
.pmwf-chevron{display:none}
.pmwf-dot{width:8px;height:8px;border-radius:50%;flex:none}
.pmwf-dot.running{background:#37b76a}.pmwf-dot.blocked,.pmwf-dot.failed{background:#e26d6d}.pmwf-dot.waiting{background:#d99a26}.pmwf-dot.completed{background:#4c9aff}
.pmwf-name{display:grid;min-width:0;gap:3px}
.pmwf-row-meta{display:grid;gap:2px;min-width:0;justify-items:start;text-align:left;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.pmwf-row-meta>span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmwf-current-line{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.pmwf-current-line b{color:var(--dsw-alias-label-secondary);font-weight:600}
.pmwf-current-line.overdue{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-title-line{display:flex;align-items:center;gap:5px;min-width:0}
.pmwf-title-line strong{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.pmwf-current-due{white-space:nowrap}
.pmwf-current-due.overdue{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-follow-bare{display:inline-flex;align-items:center;flex:none;margin-left:2px}
.pmwf-follow-bare>button{border:0!important;background:transparent!important;padding:0!important;min-width:0!important;min-height:0!important;border-radius:0!important;box-shadow:none!important}
.pmwf-name>span:not(.pmwf-title-line){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.pmwf-time-separator{margin:0 4px;color:var(--dsw-alias-label-tertiary)}
.pmwf-time{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:1.45;text-align:right;overflow-wrap:anywhere}
.pmwf-detail-head>.pmwf-time{flex:none;max-width:150px}
.pmwf-status-note{width:160px;min-width:0;max-width:160px;display:grid;gap:1px;justify-items:center;justify-self:stretch;align-self:center;font-size:11.5px;font-weight:600;line-height:1.35;text-align:center}
.pmwf-status-note>span{max-width:100%;overflow-wrap:anywhere}
.pmwf-status-meta{color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-weight:400;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-status-note.running,.pmwf-status-note.completed{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 72%,var(--dsw-alias-label-primary))}
.pmwf-status-note.waiting{color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 78%,var(--dsw-alias-label-primary))}
.pmwf-status-note.blocked,.pmwf-status-note.failed{color:var(--dsw-alias-state-error-primary,#e5534b)}
.pmwf-pill{min-width:48px;border-radius:999px;padding:3px 8px;text-align:center;font-size:10.5px;white-space:nowrap}
.pmwf-pill.running{color:#37b76a;background:#16301f}.pmwf-pill.blocked,.pmwf-pill.failed{color:#e26d6d;background:#3d2222}.pmwf-pill.waiting{color:#d99a26;background:#372c14}.pmwf-pill.completed,.pmwf-pill.cancelled{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.pmwf-status-action{display:inline-flex;align-items:center;justify-content:center;min-width:64px;min-height:30px;padding:4px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.pmwf-status-action.running,.pmwf-status-action.completed{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 72%,var(--dsw-alias-label-primary))}
.pmwf-status-action.waiting{color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 78%,var(--dsw-alias-label-primary))}
.pmwf-status-action.blocked,.pmwf-status-action.failed{color:var(--dsw-alias-state-error-primary,#e5534b)}
/* 详情面板跨所有列表行：用 size containment 让它不参与行高计算，
   否则选到内容高的流程会把左侧列表的行距一起撑开（点击时列表上下跳动）。 */
.pmwf-detail{grid-column:2;grid-row:1;min-width:0;height:100%;pointer-events:auto;contain:size}
/* 面板自身滚动：高度限制在首屏可见范围内，避免内容底部被视口裁掉。 */
.pmwf-detail-inner{position:sticky;top:14px;max-height:calc(100vh - 140px);overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));padding:14px 16px}
.pmwf-placeholder{grid-column:2;grid-row:1;align-self:start;padding:30px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.6;text-align:center}
.pmwf-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pmwf-detail-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.pmwf-detail-title strong{font-size:15px;line-height:1.35}
.pmwf-crumb{display:inline-flex;align-items:center;gap:4px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden}
.pmwf-crumb-root{flex:none}
.pmwf-crumb b{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-detail-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.pmwf-detail-meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.pmwf-detail-meta span{min-width:0;overflow-wrap:anywhere}
.pmwf-detail-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.pmwf-detail-meta-right{margin-left:auto;display:inline-flex;gap:6px 14px;flex-wrap:wrap;justify-content:flex-end}
.pmwf-nodes{display:grid;gap:10px;margin:0;padding:0;list-style:none}
.pmwf-node{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-node-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;cursor:pointer;user-select:none}
.pmwf-node-index{order:0}
.pmwf-node-card-head h3{order:1}
.pmwf-type-tag{order:2}
.pmwf-node-head-fields{order:3}
.pmwf-node-card-head .pmwf-state{order:4}
.pmwf-node-arrow{order:5}
.pmwf-node-card-head h3{margin:0;min-width:0;font-size:14px;line-height:1.35;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-node-card-head .pmwf-state{margin-left:auto}
.pmwf-node-index{flex:none;display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700;line-height:1}
.pmwf-type-tag{flex:none;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.7}
.pmwf-type-tag.join{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent);color:var(--dsw-alias-label-secondary)}
.pmwf-type-tag.branch-condition{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 9%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7)}
.pmwf-node-head-fields{display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.pmwf-node-head-fields>span{white-space:nowrap}
.pmwf-node-head-fields b{color:var(--dsw-alias-label-primary);font-weight:600}
.pmwf-node-arrow{margin-left:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;transform:rotate(-90deg);transition:transform .16s ease}
.pmwf-node-arrow.open{transform:rotate(0)}
.pmwf-node.collapsed>:not(.pmwf-node-card-head){display:none}
.pmwf-node-facts{display:none}
.pmwf-fact{display:grid;gap:2px;min-width:0}
.pmwf-fact>span{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.4}
.pmwf-fact>strong{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmwf-node-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.pmwf-node-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:14px 0 8px}
.pmwf-node-section-title h2{margin:0;font-size:14px;line-height:1.4}
.pmwf-node-section-title span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pmwf-state{justify-self:start;border-radius:999px;padding:3px 8px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);font-size:10.5px;white-space:nowrap}
.pmwf-node.completed .pmwf-state{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 78%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 14%,transparent)}
.pmwf-node.current .pmwf-state{color:var(--dsw-alias-accent-primary,#4f8ef7);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent)}
.pmwf-node.waiting .pmwf-state{color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 78%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 14%,transparent)}
.pmwf-node.blocked .pmwf-state,.pmwf-node.failed .pmwf-state{color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 80%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent)}
.pmwf-node-main{min-width:0}.pmwf-node-main strong{display:block;font-size:12.5px}.pmwf-node-main span{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4}
.pmwf-child-title{display:flex;align-items:center;gap:6px;min-width:0}
.pmwf-child-code{flex:none;display:inline-block;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:700;line-height:1.5}
.pmwf-child-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pmwf-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.pmwf-nested{margin-top:9px;background:var(--dsw-alias-bg-base)}
.pmwf-subflow-preview{margin-top:9px;border-style:dashed}
.pmwf-subflow-preview>.pmwf-nodes{margin-top:8px}
.pmwf-nested-summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:8px;align-items:center}
.pmwf-subflow-preview>.pmwf-nested-summary{grid-template-columns:auto minmax(0,1fr) auto}
.pmwf-nested-summary span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.pmwf-form{display:grid;gap:7px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l3)}
.pmwf-deliverables{display:grid;gap:8px;margin-top:9px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l3)}
.pmwf-deliverable-heading{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.02em}
.pmwf-deliverable{display:grid;gap:5px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base))}
.pmwf-deliverable-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}.pmwf-deliverable-title strong{font-size:12.5px}.pmwf-deliverable-title span{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.pmwf-deliverable-state{border-radius:999px;padding:2px 7px !important;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);color:var(--dsw-alias-label-secondary)}.pmwf-deliverable-state.submitted{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 78%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 14%,transparent)}.pmwf-deliverable-state.rejected{color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 80%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent)}
.pmwf-deliverable-description,.pmwf-deliverable-value,.pmwf-deliverable-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45;overflow-wrap:anywhere}
.pmwf-md{display:grid;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.pmwf-md-heading{margin:2px 0 0;color:var(--dsw-alias-label-primary);font-weight:600;font-size:12px}
.pmwf-md-para{margin:0}
.pmwf-md-list{margin:0;padding-left:18px;display:grid;gap:2px}
.pmwf-md-code{margin:0;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;font-family:ui-monospace,monospace;white-space:pre-wrap;overflow-x:auto}
.pmwf-md code:not(pre code){padding:1px 4px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,monospace;font-size:11px}
.pmwf-deliverable-value{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.pmwf-deliverable-form{display:grid;gap:6px}.pmwf-file{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary)}
.pmwf-approval-list{display:grid;gap:5px;margin-top:6px}
.pmwf-approval-row{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px}
/* 审批人头像与任务管理/ AI Teammates 页保持一致：人类=色块首字母，AI=环+形象图。 */
.pmwf-actor-avatar{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700}
.pmwf-actor-avatar.human{background:#2f9e66;color:#fff}
.pmwf-actor-avatar.role{border-radius:6px;background:#37618f;color:#fff}
.pmwf-actor-avatar.system{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}
.pmwf-actor-ring{width:22px;height:22px;flex:none;display:grid;place-items:center;padding:2px;border-radius:50%;background:conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff);box-shadow:0 0 0 1px rgba(139,108,255,.26)}
.pmwf-actor-ring.platform{background:#63b8ff;box-shadow:0 0 0 1px rgba(99,184,255,.55)}
.pmwf-actor-art{width:100%;height:100%;display:block;overflow:hidden;border:2px solid var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border-radius:50%;background:#20242a;object-fit:cover}
.pmwf-approval-copy{display:flex;align-items:center;gap:6px;min-width:0}
.pmwf-approval-copy strong{color:var(--dsw-alias-label-primary);font-size:11.5px}
.pmwf-approval-status{border-radius:999px;padding:2px 7px;background:var(--dsw-alias-bg-layer-2);font-size:10px;white-space:nowrap}
.pmwf-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pmwf-note{box-sizing:border-box;padding:8px 10px;border:1px solid transparent;border-radius:6px;font-size:12px;line-height:1.45;overflow-wrap:anywhere;width:100%}
.pmwf-validation-issues{display:grid;gap:3px;margin:5px 0 0;padding-left:16px}
.pmwf-note.success{color:var(--dsw-alias-state-success-primary,#1f8f53);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f8f53) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f8f53) 28%,transparent)}.pmwf-note.error{color:var(--dsw-alias-state-error-primary,#e5534b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 28%,transparent)}.pmwf-note.warning{color:var(--dsw-alias-state-warning-primary,#d99a26);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a26) 28%,transparent)}.pmwf-note.info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pmwf-empty{padding:34px 16px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;line-height:1.6}
.pmwf-section{border-top:0;padding-top:0;display:grid;gap:12px;min-width:0;max-width:100%}
.pmwf-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:11px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));display:grid;gap:9px;min-width:0;max-width:100%}
.pmwf-title{margin:0;font-size:15px}.pmwf-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.pmwf-grid{display:grid;gap:9px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.pmwf-section .pmwf-row{align-items:center;min-width:0;max-width:100%}
.pmwf-section .pmwf-select{flex:1 1 260px;width:auto;min-width:0;max-width:100%}
.pmwf-section input[type=file]{max-width:100%;min-width:0}
.pmwf-issues{margin:0;padding-left:18px;font-size:12px;line-height:1.55}
.pmwf-graph{display:grid;gap:6px}.pmwf-graph-node{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.pmwf-graph-node.branch{margin-left:16px}.pmwf-type{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.pmwf-definition-list{display:grid;gap:9px}
.pmwf-template-layout{display:grid;grid-template-columns:minmax(210px,270px) minmax(0,1fr);gap:12px;min-width:0}
.pmwf-template-directory{min-width:0;display:grid;align-content:start;gap:6px;padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-template-directory-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 4px 7px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650}
.pmwf-template-item{width:100%;display:grid;gap:2px;border:0.5px solid transparent;border-radius:6px;padding:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.pmwf-template-item:hover{background:var(--dsw-alias-bg-layer-2)}
.pmwf-template-item.active{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent)}
.pmwf-template-item strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.pmwf-template-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.pmwf-template-editor{min-width:0;display:grid;align-content:start;gap:12px}
.pmwf-template-summary{display:grid;gap:8px;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-template-summary h4{margin:0;font-size:14px}
.pmwf-template-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}
.pmwf-definition{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:9px;padding:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
.pmwf-definition strong{font-size:13px}.pmwf-definition span{color:var(--dsw-alias-label-secondary);font-size:11px}
.pmwf-definition-main{min-width:0}.pmwf-definition-main>div{margin-top:3px;line-height:1.45;overflow-wrap:anywhere}.pmwf-actions-right{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
@media(max-width:900px){.pmwf-toolbar{flex-wrap:wrap}.pmwf-project-filter,.pmwf-status-multi,.pmwf-owner-filter{flex:1 1 calc(33.333% - 6px);width:auto}.pmwf-search{flex-basis:100%}.pmwf-search-submit{flex:1 1 100%;margin-left:0;}}
@media(max-width:760px){.pmwf-template-layout,.pmwf-template-inline-body{grid-template-columns:1fr}.pmwf-template-sidebar{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}}
@media(max-width:760px){.pmwf-summary{grid-template-columns:auto minmax(0,1fr) auto;align-items:start}.pmwf-name{grid-column:2;grid-row:1}.pmwf-row-meta{grid-column:2 / 4;grid-row:2;display:grid;gap:2px;justify-items:start;text-align:left}.pmwf-status-note{grid-column:3;grid-row:1;width:auto;max-width:140px}.pmwf-node-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.pmwf-heading{flex-direction:column;gap:8px}.pmwf-name span{white-space:normal}.pmwf-select{width:100%}.pmwf-detail-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 10px}.pmwf-detail-title{grid-column:1/-1;flex-wrap:nowrap;gap:6px}.pmwf-crumb{flex:1 1 auto}.pmwf-detail-head>.pmwf-time{grid-column:2;grid-row:2;justify-self:end;max-width:none}.pmwf-detail-meta-right{margin-left:0;justify-content:flex-start}}
@media(max-width:960px){.pmwf-list{grid-template-columns:1fr}.pmwf-placeholder{grid-column:1;grid-row:auto !important}.pmwf-detail{grid-column:1;grid-row:auto !important}.pmwf-detail-inner{position:static;max-height:none;overflow:visible}}
@container (max-width:780px){.pmwf-list{grid-template-columns:1fr}.pmwf-placeholder{grid-column:1;grid-row:auto !important}.pmwf-detail{grid-column:1;grid-row:auto !important}.pmwf-detail-inner{position:static;max-height:none;overflow:visible}}
`;

    function getToken() {
      return window.localStorage.getItem(TOKEN_KEY);
    }

    async function request(path, options = {}) {
      const token = getToken();
      const headers = { ...options.headers };
      if (options.body instanceof FormData) {
        if (token !== null) headers.authorization = `Bearer ${token}`;
        const response = await fetch(path, {
          ...options,
          headers,
          cache: "no-store",
        });
        return await parseJsonResponse(response);
      }
      if (options.body !== undefined)
        headers["content-type"] = "application/json";
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const response = await fetch(path, {
        ...options,
        headers,
        cache: "no-store",
      });
      return await parseJsonResponse(response);
    }

    async function parseJsonResponse(response) {
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

    async function startWorkflowFromTab(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(".pmwf-start-submit");
      if (!button || button.disabled) return;
      const form = button.closest(".pmwf-dialog")?.querySelector(".pmwf-form");
      if (!form) return;
      const workspaceId = form.getAttribute("data-workspace-id") ?? "";
      const sessionId = form.getAttribute("data-session-id") ?? "";
      const definitionId =
        form.getAttribute("data-definition-id") ??
        form.querySelector(".pmwf-start-definition")?.value ??
        "";
      const title = form.querySelector(".pmwf-start-title")?.value.trim() ?? "";
      if (!workspaceId || !definitionId || !title) return;

      const original = button.textContent;
      button.disabled = true;
      button.textContent = "启动中";
      try {
        const result = await request("/api/collab/workflow/instances/start", {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
            definitionId,
            title,
            sessionId: sessionId || undefined,
            relatedSessionIds: [],
          }),
        });
        form.querySelector(".pmwf-start-title").value = "";
        const instanceId =
          typeof result?.instance?.id === "string" ? result.instance.id : "";
        window.dispatchEvent(
          new CustomEvent("pluginmax:workflow-refresh", {
            detail: {
              kind: "success",
              message: "已启动工作流",
              workspaceId,
              instanceId,
            },
          }),
        );
      } catch (cause) {
        window.dispatchEvent(
          new CustomEvent("pluginmax:workflow-refresh", {
            detail: { kind: "start-error", message: friendly(cause) },
          }),
        );
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }

    function renderMarkdown(text, jsx) {
      if (typeof text !== "string" || text.trim() === "") return null;
      const lines = text.split("\n");
      const blocks = [];
      let listItems = [];
      let ordered = false;
      let inCode = false;
      let codeLines = [];
      const flushList = () => {
        if (listItems.length === 0) return;
        const Tag = ordered ? "ol" : "ul";
        blocks.push(
          jsx(
            Tag,
            {
              key: blocks.length,
              className: "pmwf-md-list",
            },
            ...listItems.map((item, i) =>
              jsx(
                "li",
                { key: `li-${blocks.length}-${i}` },
                ...inline(item, blocks.length * 100 + i),
              ),
            ),
          ),
        );
        listItems = [];
      };
      const inline = (raw, keyBase) => {
        const parts = [];
        const pattern = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
        let last = 0;
        let match;
        let i = 0;
        while ((match = pattern.exec(raw)) !== null) {
          if (match.index > last) parts.push(raw.slice(last, match.index));
          if (match[2] !== undefined) {
            parts.push(jsx("strong", { key: `${keyBase}-b${i}` }, match[2]));
          } else if (match[3] !== undefined) {
            parts.push(jsx("code", { key: `${keyBase}-c${i}` }, match[3]));
          }
          last = pattern.lastIndex;
          i += 1;
        }
        if (last < raw.length) parts.push(raw.slice(last));
        return parts;
      };
      for (const line of lines) {
        if (line.trim().startsWith("```")) {
          if (inCode) {
            blocks.push(
              jsx(
                "pre",
                { key: `code-${blocks.length}`, className: "pmwf-md-code" },
                codeLines.join("\n"),
              ),
            );
            codeLines = [];
            inCode = false;
          } else {
            flushList();
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
        if (headingMatch) {
          flushList();
          const level = headingMatch[1].length;
          const Tag = level === 1 ? "h4" : level === 2 ? "h5" : "h6";
          blocks.push(
            jsx(
              Tag,
              { key: `h-${blocks.length}`, className: "pmwf-md-heading" },
              ...inline(headingMatch[2], blocks.length),
            ),
          );
          continue;
        }
        const unorderedMatch = line.match(/^\s*[-·]\s+(.*)/);
        const orderedMatch = line.match(/^\s*\d+[.．]\s+(.*)/);
        if (unorderedMatch) {
          if (ordered) flushList();
          ordered = false;
          listItems.push(unorderedMatch[1]);
          continue;
        }
        if (orderedMatch) {
          if (!ordered) flushList();
          ordered = true;
          listItems.push(orderedMatch[1]);
          continue;
        }
        if (line.trim() === "") {
          flushList();
          continue;
        }
        flushList();
        blocks.push(
          jsx(
            "p",
            { key: `p-${blocks.length}`, className: "pmwf-md-para" },
            ...inline(line, blocks.length),
          ),
        );
      }
      flushList();
      if (inCode && codeLines.length > 0) {
        blocks.push(
          jsx(
            "pre",
            { key: `code-${blocks.length}`, className: "pmwf-md-code" },
            codeLines.join("\n"),
          ),
        );
      }
      return jsx("div", { className: "pmwf-md" }, ...blocks);
    }

    function friendly(cause) {
      if (cause instanceof Error) {
        if (
          cause.code === "conflict" &&
          /^definition version already exists:/i.test(cause.message)
        ) {
          return "该模板版本已存在。请把 Markdown 元信息里的 version 改成新版本号，或换一个流程 key。";
        }
        if (
          cause instanceof Error &&
          cause.message === "active workflow definition not found"
        ) {
          return "所选工作流模板不存在或未启用。请刷新页面后重新选择模板。";
        }
        return cause.message;
      }
      return String(cause);
    }

    function statusText(value) {
      return (
        {
          running: "运行中",
          waiting: "等待",
          blocked: "阻塞",
          completed: "完成",
          failed: "失败",
          cancelled: "已取消",
          delegated: "已转交",
          ready: "可执行",
          skipped: "跳过",
        }[value] ?? value
      );
    }

    const workflowStatusFilterValues = [
      "running",
      "waiting",
      "blocked",
      "failed",
      "completed",
      "cancelled",
    ];
    function statusFilterLabel(selected) {
      if (
        selected.size === 0 ||
        selected.size === workflowStatusFilterValues.length
      ) {
        return "全部";
      }
      const names = workflowStatusFilterValues
        .filter((value) => selected.has(value))
        .map((value) => statusText(value));
      if (names.length <= 2) return names.join("、");
      return `${names[0]} 等${names.length}项`;
    }

    function pillClass(value) {
      return [
        "running",
        "waiting",
        "blocked",
        "completed",
        "failed",
        "cancelled",
      ].includes(value)
        ? value
        : "cancelled";
    }

    function timeShort(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const sameYear = date.getFullYear() === new Date().getFullYear();
      return date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(sameYear ? {} : { year: "numeric" }),
      });
    }

    function formatDuration(value) {
      if (!Number.isFinite(value) || value <= 0) return "未知";
      if (value < 60_000) {
        const seconds = Math.round(value / 1000);
        return `${seconds} 秒`;
      }
      if (value < 3_600_000) {
        const minutes = Math.round(value / 60_000);
        return `${minutes} 分钟`;
      }
      const hours = Math.round(value / 3_600_000);
      return `${hours} 小时`;
    }

    function nodeTypeLabel(value) {
      return (
        {
          task: "任务",
          service: "服务",
          approval: "审批",
          decision: "判断",
          subworkflow: "子流程",
        }[value] ?? value
      );
    }

    function workspaceLabel(workspace) {
      const title = workspace.title?.trim();
      const path = workspace.path?.trim();
      if (title && path) return `${title} · ${path}`;
      if (path) return path;
      if (title) return title;
      return "未命名工作区";
    }

    function workspaceName(workspace) {
      return workspace.title?.trim() || workspace.path?.trim() || "未命名项目";
    }

    function workflowNodeKey(nodes, index) {
      return String(index + 1).padStart(2, "0");
    }

    function workflowNodeDependencyLabel(node, nodes, edges) {
      const incoming = (edges ?? []).filter((edge) => edge.to === node.id);
      if (incoming.length === 0) return "无前置依赖";
      return incoming
        .map((edge) => {
          const index = nodes.findIndex(
            (candidate) => candidate.id === edge.from,
          );
          const source = nodes[index];
          return source === undefined
            ? edge.from
            : `${workflowNodeKey(nodes, index)} ${source.name}`;
        })
        .join(incoming.length > 1 ? " AND " : "");
    }

    function workflowNodeOwnerLabel(node) {
      const owner = node.responsible ?? node.executor;
      if (owner === undefined) return "待指定";
      return owner.label ?? owner.name ?? owner.id ?? owner.kind;
    }

    function workflowNodeApprovalLabel(node) {
      if ((node.approvers ?? []).length <= 1) return "";
      return node.approvalPolicy === "any" ? "OR · 任一通过" : "AND · 全部通过";
    }

    function dedupeWorkflowDefinitions(definitions) {
      const byVersion = new Map();
      for (const definition of definitions) {
        const key = `${definition.key}:${definition.version}`;
        const current = byVersion.get(key);
        if (current === undefined || definition.updatedAt > current.updatedAt) {
          byVersion.set(key, definition);
        }
      }
      return [...byVersion.values()];
    }

    function executorLabel(node) {
      const kind =
        { system: "系统", user: "用户", agent: "Agent", employee: "AI伙伴" }[
          node.executor.kind
        ] ?? node.executor.kind;
      return `${kind} · ${node.executor.label ?? node.executor.id}`;
    }

    function approverLabel(approver, memberNames) {
      const name = memberNames.get(approver.id) ?? approver.name ?? approver.id;
      const kind =
        approver.kind === "agent"
          ? "Agent"
          : approver.kind === "employee"
            ? "AI伙伴"
            : "用户";
      return `${kind} · ${name}`;
    }

    /*
     * 头像渲染与任务管理页同源：人类取姓名首字母色块，AI Teammate / 数字员工
     * 取平台蓝环或个人炫彩环 + 形象图；形象图与任务管理页共用同一套预设。
     */
    const h = react.createElement;

    function actorInitials(value) {
      return String(value ?? "?")
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }

    const ACTOR_AVATAR_PRESETS = [
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

    function actorAvatarHair(preset) {
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

    function actorAvatarArt(value, key) {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        return h("img", {
          key,
          className: "pmwf-actor-art",
          src: value,
          alt: "",
        });
      }
      const preset =
        ACTOR_AVATAR_PRESETS.find((item) => item.id === value) ??
        ACTOR_AVATAR_PRESETS[0];
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
        ...actorAvatarHair(preset),
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
          className: "pmwf-actor-art",
          viewBox: "0 0 64 64",
          "aria-hidden": "true",
        },
        children,
      );
    }

    function WorkflowActorAvatar({ approver, name, teammateById }) {
      const kind =
        approver?.kind === "user"
          ? "human"
          : approver?.kind === "role"
            ? "role"
            : approver?.kind === "agent" || approver?.kind === "employee"
              ? "agent"
              : "system";
      if (kind === "agent") {
        const teammate = teammateById?.get(approver?.id);
        const source =
          teammate?.source === "personal" ? "personal" : "platform";
        return h(
          "span",
          {
            className: `pmwf-actor-ring ${source}`,
            title: name,
            role: "img",
            "aria-label": name,
          },
          actorAvatarArt(teammate?.avatar ?? "", "art"),
        );
      }
      return h(
        "span",
        {
          className: `pmwf-actor-avatar ${kind}`,
          title: name,
          role: "img",
          "aria-label": name,
        },
        kind === "role" ? "R" : kind === "system" ? "◉" : actorInitials(name),
      );
    }

    function WorkflowApprovalList({ approvals, memberNames, teammateById }) {
      const entries = Object.values(approvals ?? {});
      if (entries.length === 0) return null;
      const serialCountersign = entries.some(
        (approval) => approval.source === "countersign",
      );
      let queueHeadSeen = false;
      return jsxRuntime.jsx("div", {
        className: "pmwf-approval-list",
        children: entries.map((approval, index) => {
          const name =
            memberNames.get(approval.approver.id) ??
            approval.approver.name ??
            approval.approver.id;
          const isQueueHead =
            serialCountersign &&
            approval.status === "pending" &&
            !queueHeadSeen;
          if (approval.status === "pending") queueHeadSeen = true;
          const approvalState = isQueueHead
            ? "当前审批"
            : serialCountersign && approval.status === "pending"
              ? "等待中"
              : statusText(approval.status);
          return jsxRuntime.jsxs(
            "div",
            {
              className: "pmwf-approval-row",
              children: [
                jsxRuntime.jsx(WorkflowActorAvatar, {
                  approver: approval.approver,
                  name,
                  teammateById,
                }),
                jsxRuntime.jsxs("span", {
                  className: "pmwf-approval-copy",
                  children: [
                    jsxRuntime.jsx("strong", { children: name }),
                    jsxRuntime.jsx("span", {
                      className: "pmwf-approval-status",
                      children: approvalState,
                    }),
                  ],
                }),
              ],
            },
            `${approval.approver.id}:${index}`,
          );
        }),
      });
    }

    function deliverableTypeLabel(value) {
      return { file: "文件", text: "文本", link: "链接" }[value] ?? value;
    }

    function deliverableStatusLabel(value) {
      return (
        { pending: "待提交", submitted: "已提交", rejected: "已退回" }[value] ??
        "待提交"
      );
    }

    function missingDeliverables(node, state) {
      return (node.deliverables ?? []).filter((requirement) => {
        if (!requirement.required) return false;
        const current = state?.deliverables?.[requirement.key];
        return current?.status !== "submitted";
      });
    }

    function canSubmitDeliverable(node, actor, manager, state) {
      if (!actor || (actor.kind !== "user" && !actor.id)) return false;
      if (manager) return true;
      // 执行实例失效兜底改派到的 owner 与节点责任人同权。
      if (state?.executorFallback?.id === actor.id) return true;
      if (node.type === "service" || node.type === "subworkflow") return false;
      const responsibleId = ["agent", "employee"].includes(node.executor.kind)
        ? node.responsible?.id
        : (node.responsible?.id ?? node.executor.id);
      if (node.executor.kind === "user" && node.executor.id === actor.id)
        return true;
      return responsibleId === actor.id;
    }

    function canCompleteNode(node, actor, manager, state) {
      if (!actor || actor.kind !== "user") return false;
      if (manager) return true;
      if (state?.executorFallback?.id === actor.id) return true;
      if (node.type === "service" || node.type === "subworkflow") return false;
      const responsible = node.responsible;
      if (["agent", "employee"].includes(node.executor.kind)) {
        return responsible?.kind === "user" && responsible.id === actor.id;
      }
      if (node.executor.kind === "user" && node.executor.id === actor.id) {
        return true;
      }
      return responsible?.kind === "user" && responsible.id === actor.id;
    }

    function isSystemServiceNode(node) {
      return node.type === "service" && node.executor.kind === "system";
    }

    function workflowNodeStatusText(node, state) {
      if (
        isSystemServiceNode(node) &&
        ["ready", "running"].includes(state?.status ?? "")
      ) {
        return "等待系统执行";
      }
      return statusText(state?.status ?? "waiting");
    }

    function workflowNodeTypeLabel(type) {
      return (
        {
          task: "执行",
          approval: "审批",
          decision: "决策",
          subworkflow: "子流程",
          service: "服务",
        }[type] ?? type
      );
    }

    function systemServiceHint(node, state, manager) {
      if (!isSystemServiceNode(node) || state?.status !== "ready") return null;
      const service = node.executor.label ?? node.executor.id;
      return manager
        ? `系统服务「${service}」尚未接入自动执行；请确认外部动作已完成，再由 Owner/Admin 手动完成。`
        : `该节点由系统服务「${service}」执行，不创建个人任务；当前等待系统执行或 Owner/Admin 手动完成。`;
    }

    function completeButtonLabel(node, actor, manager, memberNames, state) {
      const missing = missingDeliverables(node, state);
      if (missing.length > 0) return `缺少 ${missing.length} 项交付物`;
      if (isSystemServiceNode(node)) {
        return canCompleteNode(node, actor, manager, state)
          ? "管理员完成"
          : "等待 Owner/Admin 完成";
      }
      if (canCompleteNode(node, actor, manager, state)) return "完成";
      if (
        ["agent", "employee"].includes(node.executor.kind) &&
        node.responsible === undefined
      ) {
        return "Owner/Admin 可完成";
      }
      const responsibleId = ["agent", "employee"].includes(node.executor.kind)
        ? node.responsible?.id
        : (node.responsible?.id ?? node.executor.id);
      const name = memberNames.get(responsibleId) ?? responsibleId;
      return name ? `由 ${name} 完成` : "无完成权限";
    }

    function DeliverablePanel(props) {
      const [rejectingId, setRejectingId] = react.useState("");
      const [rejectNote, setRejectNote] = react.useState("");
      const { node, state, detail, instance } = props;
      if ((node.deliverables ?? []).length === 0) return null;
      const manager = props.isManager;
      const agentWorker =
        ["agent", "employee"].includes(node.executor.kind) &&
        node.execution === "task-worker";
      const runnerLabel =
        node.executor.kind === "employee" ? "AI伙伴" : "Agent";
      const ticketRejected =
        state?.status === "blocked" &&
        /^(Digital Employee|AI伙伴|Teammate)\s*输出被拒绝/.test(
          state.note ?? "",
        );
      const latestRun = props.runs?.[0];
      const staleInterruptedRun =
        ["interrupted", "cancelled", "failed", "timeout"].includes(
          latestRun?.status ?? "",
        ) && state?.status === "running";
      const activeAgentRun = (props.runs ?? []).some((run) =>
        ["queued", "running", "waiting_input"].includes(run.status),
      );
      const baseEditable =
        ["ready", "running", "waiting"].includes(state?.status) &&
        canSubmitDeliverable(node, detail.actor, manager, state);
      const fallbackEditable =
        agentWorker &&
        (state?.status === "blocked" || staleInterruptedRun) &&
        !activeAgentRun &&
        canSubmitDeliverable(node, detail.actor, manager, state);
      return jsxRuntime.jsxs("div", {
        className: "pmwf-deliverables",
        children: [
          ["agent", "employee"].includes(node.executor.kind) &&
          node.execution !== "task-worker"
            ? jsxRuntime.jsx("div", {
                className: "pmwf-note info",
                children: "本节点暂不自动运行；当前由人类代交交付物。",
              })
            : null,
          fallbackEditable
            ? jsxRuntime.jsx("div", {
                className: "pmwf-note info",
                children: ticketRejected
                  ? `${runnerLabel} 的输出未获授权写入交付物；节点负责人可以人工代交交付物，或在调整 Runtime 后重新派发 ${runnerLabel}。`
                  : `${runnerLabel} 未完成本次运行；节点负责人可以人工代交交付物，或重新派发 ${runnerLabel}。`,
              })
            : null,
          jsxRuntime.jsx("div", {
            className: "pmwf-deliverable-heading",
            children: "交付要求",
          }),
          node.deliverables.map((requirement) => {
            const key = `${instance.id}:${node.id}:${requirement.key}`;
            const currentState = state?.deliverables?.[requirement.key];
            const agentOutputAccepted =
              agentWorker &&
              state?.status === "ready" &&
              !activeAgentRun &&
              currentState?.status === "submitted";
            const editable =
              (baseEditable && !activeAgentRun && !agentOutputAccepted) ||
              fallbackEditable;
            const submissions = (detail.submissions ?? []).filter(
              (item) =>
                item.nodeId === node.id &&
                item.requirementKey === requirement.key,
            );
            const latest =
              submissions.find(
                (item) => item.id === currentState?.latestSubmissionId,
              ) ?? submissions.at(-1);
            const draft = props.drafts[key] ?? "";
            const selected = props.files[key] ?? [];
            const submitDisabled =
              props.busy !== "" ||
              !editable ||
              (requirement.type === "text" &&
                draft.trim().length < (requirement.minTextLength ?? 1)) ||
              (requirement.type === "link" && draft.trim() === "") ||
              (requirement.type === "file" && selected.length === 0);
            return jsxRuntime.jsxs(
              "div",
              {
                className: "pmwf-deliverable",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-deliverable-title",
                    children: [
                      jsxRuntime.jsx("strong", { children: requirement.title }),
                      jsxRuntime.jsxs("span", {
                        children: [
                          requirement.required ? "必交" : "选交",
                          " · ",
                          deliverableTypeLabel(requirement.type),
                        ],
                      }),
                      jsxRuntime.jsx("span", {
                        className: `pmwf-deliverable-state ${currentState?.status ?? "pending"}`,
                        children: deliverableStatusLabel(
                          currentState?.status ?? "pending",
                        ),
                      }),
                    ],
                  }),
                  requirement.description
                    ? jsxRuntime.jsx("span", {
                        className: "pmwf-deliverable-description",
                        children: requirement.description,
                      })
                    : null,
                  latest
                    ? jsxRuntime.jsxs("span", {
                        className: "pmwf-deliverable-value",
                        children: [
                          latest.type === "file"
                            ? (latest.artifacts ?? [])
                                .map((artifact) => artifact.fileName)
                                .join("、") || "文件已提交"
                            : renderMarkdown(latest.value, jsxRuntime.jsx),
                          jsxRuntime.jsx("span", {
                            className: "pmwf-deliverable-meta",
                            children: ` · ${latest.submittedByName}${
                              latest.onBehalfOf
                                ? ` 代 ${latest.onBehalfOf}`
                                : ""
                            } · ${timeShort(latest.submittedAt)}`,
                          }),
                          latest.type === "file" &&
                          (latest.artifacts ?? []).length > 0
                            ? jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                onClick: () =>
                                  props.onDownload(
                                    latest.id,
                                    latest.artifacts[0]?.id,
                                  ),
                                children: "下载",
                              })
                            : null,
                          props.onReject &&
                          latest.status === "submitted" &&
                          manager &&
                          ["ready", "running", "waiting"].includes(
                            state?.status ?? "",
                          )
                            ? jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled: props.busy !== "",
                                onClick: () => {
                                  setRejectingId(latest.id);
                                  setRejectNote("");
                                },
                                children: "退回",
                              })
                            : null,
                        ],
                      })
                    : null,
                  latest && rejectingId === latest.id
                    ? jsxRuntime.jsxs("div", {
                        className: "pmwf-deliverable-form",
                        children: [
                          jsxRuntime.jsx("textarea", {
                            className: "pmwf-area",
                            rows: 2,
                            value: rejectNote,
                            placeholder:
                              "退回原因（会作为下一轮 Agent 重试反馈）",
                            "aria-label": "退回原因",
                            onChange: (event) =>
                              setRejectNote(event.target.value),
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-row",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn small",
                                disabled:
                                  props.busy !== "" || rejectNote.trim() === "",
                                onClick: () =>
                                  props.onReject(latest.id, rejectNote),
                                children: "确认退回",
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled: props.busy !== "",
                                onClick: () => {
                                  setRejectingId("");
                                  setRejectNote("");
                                },
                                children: "取消",
                              }),
                            ],
                          }),
                        ],
                      })
                    : null,
                  editable
                    ? jsxRuntime.jsxs("div", {
                        className: "pmwf-deliverable-form",
                        children: [
                          requirement.type === "text"
                            ? jsxRuntime.jsx("textarea", {
                                className: "pmwf-area",
                                rows: 3,
                                value: draft,
                                placeholder: requirement.description,
                                onChange: (event) =>
                                  props.onDraft(key, event.target.value),
                              })
                            : null,
                          requirement.type === "link"
                            ? jsxRuntime.jsx("input", {
                                className: "pmwf-input",
                                value: draft,
                                placeholder: "https://...",
                                onChange: (event) =>
                                  props.onDraft(key, event.target.value),
                              })
                            : null,
                          requirement.type === "file"
                            ? jsxRuntime.jsx("input", {
                                className: "pmwf-file",
                                type: "file",
                                multiple: requirement.maxFiles > 1,
                                accept: requirement.accept.join(","),
                                onChange: (event) =>
                                  props.onFile(
                                    key,
                                    Array.from(event.target.files ?? []),
                                  ),
                              })
                            : null,
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-row",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled: submitDisabled,
                                onClick: () =>
                                  props.onSubmit(node, requirement),
                                children:
                                  props.busy === `deliverable:${key}`
                                    ? "提交中"
                                    : fallbackEditable
                                      ? "人工代交"
                                      : "提交交付物",
                              }),
                              requirement.type === "text"
                                ? jsxRuntime.jsxs("span", {
                                    className: "pmwf-label",
                                    children: [
                                      draft.trim().length,
                                      "/",
                                      requirement.minTextLength,
                                      " 字",
                                    ],
                                  })
                                : null,
                            ],
                          }),
                        ],
                      })
                    : null,
                ],
              },
              requirement.key,
            );
          }),
        ],
      });
    }

    const AGENT_RUN_STATUS = {
      queued: { label: "排队中", tone: "waiting" },
      running: { label: "运行中", tone: "current" },
      waiting_input: { label: "等待补充", tone: "waiting" },
      succeeded: { label: "已成功", tone: "completed" },
      failed: { label: "失败", tone: "blocked" },
      timeout: { label: "超时", tone: "blocked" },
      cancelled: { label: "已取消", tone: "waiting" },
      interrupted: { label: "已中断", tone: "blocked" },
    };

    function agentRunStatusLabel(value) {
      return AGENT_RUN_STATUS[value]?.label ?? value;
    }

    function AgentRunPanel(props) {
      const {
        node,
        state,
        runs,
        busy,
        act,
        workspaceId,
        instanceId,
        actor,
        isManager,
        notes,
        onNoteChange,
      } = props;
      const runnerKind =
        node.executor.kind === "employee" ||
        runs.some((run) => run.principalType === "digital-employee")
          ? "AI伙伴"
          : "Agent";
      const runnerName = (run) =>
        run.payload.employeeName ?? run.payload.profileName;
      if (node.execution !== "task-worker") return null;
      const active =
        runs.find((run) =>
          ["queued", "running", "waiting_input"].includes(run.status),
        ) ?? null;
      const latest = runs[0] ?? null;
      const responsibleId = node.responsible?.id;
      const canOperate =
        actor?.kind === "user" &&
        (isManager === true ||
          (node.responsible?.kind === "user" && responsibleId === actor.id));
      const retryable =
        latest !== null &&
        ["failed", "timeout", "interrupted", "cancelled"].includes(
          latest.status,
        );
      const outputRejected =
        state?.status === "blocked" &&
        state.note?.startsWith("Agent 未按约定输出「交付说明」") === true;
      const ticketRejected =
        latest?.status === "succeeded" &&
        state?.status === "blocked" &&
        /^(Digital Employee|AI伙伴|Teammate)\s*输出被拒绝/.test(
          state.note ?? "",
        );
      const latestRunLabel =
        latest?.status === "succeeded" && outputRejected
          ? "已成功 · 输出未通过交付校验"
          : latest?.status === "succeeded" && ticketRejected
            ? "已成功 · 输出被票据拒绝"
            : agentRunStatusLabel(latest?.status);
      const serviceRecoverable =
        active === null &&
        latest === null &&
        state?.status === "blocked" &&
        /^(Agent Profile|Digital Employee|AI伙伴|AI Teammate|Teammate)/.test(
          state.note || "",
        );
      // 执行实例失效兜底：节点已转交 owner 人工处理，不再提供派发/重试入口。
      const fallback = state?.executorFallback ?? null;
      const canDispatch =
        fallback === null &&
        (state?.status === "ready" || serviceRecoverable) &&
        active === null &&
        canOperate;
      const loopBreakBlocked =
        state !== null &&
        state.status === "blocked" &&
        (state.note ?? "").startsWith("已触发 break：");
      const canRetry =
        fallback === null &&
        canOperate &&
        !loopBreakBlocked &&
        (retryable ||
          (latest?.status === "succeeded" &&
            (outputRejected || ticketRejected))) &&
        active === null &&
        state !== null &&
        (["ready", "blocked"].includes(state.status) ||
          (latest?.status === "interrupted" && state.status === "running"));
      const triggerLabel =
        latest?.trigger === "auto-on-ready" ? "自动派发" : "手动派发";
      const canIntervene =
        ["ready", "running", "blocked"].includes(state?.status ?? "") &&
        actor?.kind === "user" &&
        isManager === true;
      const missingCount = missingDeliverables(node, state).length;
      const noteKey = `${instanceId}:${node.id}`;
      const interventionNote = notes?.[noteKey] ?? "";
      const dispatchOutcome = (result) => {
        const applied = result?.instance?.nodes?.[node.id]?.executorFallback;
        return applied
          ? `执行实例已失效，已转交 ${applied.label ?? applied.id} 人工处理`
          : `已派发 ${runnerKind} 运行`;
      };
      return jsxRuntime.jsxs("div", {
        className: "pmwf-deliverables",
        children: [
          jsxRuntime.jsx("div", {
            className: "pmwf-deliverable-heading",
            children: `${runnerKind} 运行`,
          }),
          fallback !== null
            ? jsxRuntime.jsx("div", {
                className: "pmwf-note info",
                children: `原执行实例「${fallback.originalExecutorLabel ?? fallback.originalExecutorId}」已失效：${fallback.reason}。节点已转交「${fallback.label ?? fallback.id}」人工处理。`,
              })
            : null,
          active !== null
            ? jsxRuntime.jsxs("div", {
                className: "pmwf-deliverable",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-deliverable-title",
                    children: [
                      jsxRuntime.jsx("strong", {
                        children: runnerName(active),
                      }),
                      jsxRuntime.jsx("span", {
                        className: "pmwf-deliverable-state",
                        children: agentRunStatusLabel(active.status),
                      }),
                      jsxRuntime.jsx("span", {
                        children: `第 ${active.runSeq} 次`,
                      }),
                    ],
                  }),
                  jsxRuntime.jsx("div", {
                    className: "pmwf-deliverable-meta",
                    children: `开始 ${timeShort(active.startedAt)} · 超时上限 ${formatDuration(active.timeoutMs)}`,
                  }),
                ],
              })
            : latest !== null
              ? jsxRuntime.jsxs("div", {
                  className: "pmwf-deliverable",
                  children: [
                    jsxRuntime.jsxs("div", {
                      className: "pmwf-deliverable-title",
                      children: [
                        jsxRuntime.jsx("strong", {
                          children: runnerName(latest),
                        }),
                        jsxRuntime.jsx("span", {
                          className: "pmwf-deliverable-state",
                          children: latestRunLabel,
                        }),
                        jsxRuntime.jsx("span", {
                          children: `第 ${latest.runSeq} 次 · ${triggerLabel}`,
                        }),
                      ],
                    }),
                    latest.error
                      ? jsxRuntime.jsx("div", {
                          className: "pmwf-deliverable-meta",
                          children: latest.error,
                        })
                      : latest.output?.summary
                        ? jsxRuntime.jsx("div", {
                            className: "pmwf-deliverable-meta",
                            children: renderMarkdown(
                              latest.output.summary,
                              jsxRuntime.jsx,
                            ),
                          })
                        : null,
                    latest.startedAt || latest.endedAt
                      ? jsxRuntime.jsx(
                          "div",
                          {
                            className: "pmwf-deliverable-meta",
                            children: `开始 ${timeShort(latest.startedAt) || "—"} · 结束 ${timeShort(latest.endedAt) || "—"}`,
                          },
                          "latest-time",
                        )
                      : null,
                    latest.promptSnapshot
                      ? jsxRuntime.jsx("details", {
                          children: [
                            jsxRuntime.jsx(
                              "summary",
                              {
                                className: "pmwf-deliverable-meta",
                                children: "查看运行提示词",
                              },
                              "summary",
                            ),
                            jsxRuntime.jsx(
                              "pre",
                              {
                                className: "pmwf-deliverable-meta",
                                style: {
                                  whiteSpace: "pre-wrap",
                                  margin: "4px 0 0",
                                },
                                children: latest.promptSnapshot.slice(0, 2_000),
                              },
                              "prompt",
                            ),
                          ],
                        })
                      : null,
                  ],
                })
              : jsxRuntime.jsx("div", {
                  className: "pmwf-deliverable-meta",
                  children: `尚未派发过 ${runnerKind} 运行。`,
                }),
          !canOperate && active === null && latest !== null
            ? jsxRuntime.jsx("div", {
                className: "pmwf-note info",
                children: `当前账号不能重新派发。该 Agent 节点责任人是 ${responsibleId ?? "未指定"}；只有责任人和工作区负责人/管理员可操作。`,
              })
            : null,
          jsxRuntime.jsxs("div", {
            className: "pmwf-actions",
            children: [
              canDispatch && !canRetry
                ? jsxRuntime.jsx(
                    "button",
                    {
                      type: "button",
                      className: "pmwf-btn small",
                      disabled: busy !== "",
                      onClick: () =>
                        act(
                          `agent-dispatch:${instanceId}:${node.id}`,
                          "/api/collab/workflow/agent-runs/dispatch",
                          { workspaceId, instanceId, nodeId: node.id },
                          dispatchOutcome,
                        ),
                      children: `派发 ${runnerKind}`,
                    },
                    "dispatch",
                  )
                : null,
              active !== null
                ? jsxRuntime.jsx(
                    "button",
                    {
                      type: "button",
                      className: "pmwf-btn secondary small",
                      disabled: busy !== "",
                      onClick: () =>
                        act(
                          `agent-cancel:${active.id}`,
                          "/api/collab/workflow/agent-runs/cancel",
                          { workspaceId, runId: active.id },
                          `已取消 ${runnerKind} 运行`,
                        ),
                      children: "取消运行",
                    },
                    "cancel",
                  )
                : null,
              canRetry
                ? jsxRuntime.jsx(
                    "button",
                    {
                      type: "button",
                      className: "pmwf-btn secondary small",
                      disabled: busy !== "",
                      onClick: () =>
                        act(
                          `agent-retry:${latest.id}`,
                          "/api/collab/workflow/agent-runs/retry",
                          { workspaceId, runId: latest.id },
                          (result) => {
                            const applied =
                              result?.instance?.nodes?.[node.id]
                                ?.executorFallback;
                            return applied
                              ? `执行实例已失效，已转交 ${applied.label ?? applied.id} 人工处理`
                              : `已重新派发 ${runnerKind} 运行`;
                          },
                        ),
                      children: `重新派发 ${runnerKind}`,
                    },
                    "retry",
                  )
                : null,
            ],
          }),
          canIntervene
            ? jsxRuntime.jsxs("div", {
                className: "pmwf-deliverable",
                children: [
                  jsxRuntime.jsx("div", {
                    className: "pmwf-deliverable-heading",
                    children: "Owner/Admin 人工介入",
                  }),
                  jsxRuntime.jsx("input", {
                    type: "text",
                    className: "pmwf-input small",
                    placeholder: "接管备注（选填）",
                    value: interventionNote,
                    onChange: (event) =>
                      onNoteChange?.(noteKey, event.target.value),
                  }),
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-actions",
                    children: [
                      jsxRuntime.jsx(
                        "button",
                        {
                          type: "button",
                          className: "pmwf-btn small",
                          disabled: busy !== "" || missingCount > 0,
                          onClick: async () => {
                            const succeeded = await act(
                              `agent-complete:${node.id}`,
                              "/api/collab/workflow/nodes/complete",
                              {
                                workspaceId,
                                instanceId,
                                nodeId: node.id,
                                force: true,
                                note: interventionNote.trim() || undefined,
                              },
                              `已人工完成「${node.name}」`,
                            );
                            if (succeeded) onNoteChange?.(noteKey, "");
                          },
                          children:
                            missingCount > 0
                              ? `补齐 ${missingCount} 项交付物后可完成`
                              : "人工完成",
                        },
                        "manual-complete",
                      ),
                      jsxRuntime.jsx(
                        "button",
                        {
                          type: "button",
                          className: "pmwf-btn secondary small",
                          disabled: busy !== "",
                          onClick: async () => {
                            if (
                              !window.confirm(
                                `取消「${node.name}」后，该节点会标记为已跳过，关联任务会关闭。继续吗？`,
                              )
                            )
                              return;
                            const succeeded = await act(
                              `agent-cancel-node:${node.id}`,
                              "/api/collab/workflow/nodes/cancel",
                              {
                                workspaceId,
                                instanceId,
                                nodeId: node.id,
                                note: interventionNote.trim() || undefined,
                              },
                              `已人工取消「${node.name}」`,
                            );
                            if (succeeded) onNoteChange?.(noteKey, "");
                          },
                          children: "取消节点",
                        },
                        "manual-cancel",
                      ),
                    ],
                  }),
                ],
              })
            : null,
        ],
      });
    }

    function WorkflowTemplateDialog({ definition, onClose }) {
      return jsxRuntime.jsxs("div", {
        className: "pmwf-mask",
        role: "dialog",
        "aria-modal": true,
        "aria-label": "工作流模版详情",
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose();
        },
        children: [
          jsxRuntime.jsxs("div", {
            className: "pmwf-dialog",
            children: [
              jsxRuntime.jsxs("div", {
                children: [
                  jsxRuntime.jsx("h3", {
                    children: `${definition.name} v${definition.version}`,
                  }),
                  jsxRuntime.jsxs("p", {
                    style: {
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 12,
                      margin: "4px 0 0",
                    },
                    children: [
                      `${definition.key} · ${definition.status === "active" ? "启用" : "已归档"}`,
                      definition.description
                        ? ` · ${definition.description}`
                        : "",
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsx("div", {
                style: { overflow: "auto", minHeight: 0 },
                children: jsxRuntime.jsxs(react.Fragment, {
                  children: [
                    jsxRuntime.jsx("div", {
                      className: "pmwf-profile-preview-title",
                      children: "节点",
                    }),
                    jsxRuntime.jsx("div", {
                      style: { display: "grid", gap: 8 },
                      children: (definition.graph?.nodes ?? []).map(
                        (node, index) =>
                          jsxRuntime.jsxs(
                            "div",
                            {
                              className: "pmwf-template-preview-node",
                              children: [
                                jsxRuntime.jsx("span", {
                                  className: "pmwf-template-preview-index",
                                  children: String(index + 1).padStart(2, "0"),
                                }),
                                jsxRuntime.jsxs("div", {
                                  className: "pmwf-template-preview-main",
                                  children: [
                                    jsxRuntime.jsxs("div", {
                                      className: "pmwf-template-preview-title",
                                      children: [
                                        jsxRuntime.jsx("strong", {
                                          children: node.name,
                                        }),
                                        jsxRuntime.jsx("span", {
                                          className:
                                            "pmwf-template-preview-type",
                                          children:
                                            node.type === "approval"
                                              ? "审批"
                                              : node.type === "service"
                                                ? "服务"
                                                : node.type === "subworkflow"
                                                  ? "子流程"
                                                  : "任务",
                                        }),
                                      ],
                                    }),
                                    jsxRuntime.jsx("div", {
                                      className: "pmwf-template-preview-meta",
                                      children: `负责人：${
                                        node.responsible?.id ??
                                        node.executor?.id ??
                                        "—"
                                      }`,
                                    }),
                                    node.description
                                      ? jsxRuntime.jsx("p", {
                                          className:
                                            "pmwf-template-preview-desc",
                                          children: node.description,
                                        })
                                      : null,
                                  ],
                                }),
                              ],
                            },
                            node.id,
                          ),
                      ),
                    }),
                    jsxRuntime.jsx("div", {
                      className: "pmwf-profile-preview-title",
                      style: { marginTop: 14 },
                      children: "工作流定义",
                    }),
                    jsxRuntime.jsx("pre", {
                      className: "pmwf-md-pre",
                      style: { whiteSpace: "pre-wrap" },
                      children: definition.sourceMd,
                    }),
                  ],
                }),
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-dialog-actions",
                children: [
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-btn secondary",
                    onClick: onClose,
                    children: "关闭",
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    function currentStates(instance) {
      return Object.values(instance.nodes).filter((node) =>
        ["ready", "running", "blocked"].includes(node.status),
      );
    }

    function currentSummary(instance, definition) {
      if (["completed", "cancelled"].includes(instance.status)) {
        return statusText(instance.status);
      }
      const states = currentStates(instance);
      if (states.length === 0) {
        return instance.status === "blocked"
          ? "数据状态异常，请联系管理员检查"
          : "无可执行节点";
      }
      if (definition?.graph.nodes?.length) {
        const currentNodeId = states[0].nodeId;
        return definition.graph.nodes
          .map((node) =>
            node.id === currentNodeId ? `【${node.name}】` : node.name,
          )
          .join("-");
      }
      return `当前：${states
        .map(
          (state) =>
            definition?.graph.nodes.find((node) => node.id === state.nodeId)
              ?.name ?? state.nodeId,
        )
        .join("、")}`;
    }

    function statusBadgeText(instance, definition) {
      if (["completed", "cancelled"].includes(instance.status)) {
        return statusText(instance.status);
      }
      const current = currentStates(instance)[0];
      if (!current) {
        return instance.status === "blocked"
          ? `${statusText(instance.status)} · 数据状态异常`
          : statusText(instance.status);
      }
      const name =
        definition?.graph.nodes.find((node) => node.id === current.nodeId)
          ?.name ?? current.nodeId;
      return `${statusText(instance.status)} · ${name}`;
    }

    /** 列表行状态按「状态 · 阶段」分段换行，长阶段名不再把行挤变形。 */
    function statusNoteLines(instance, definition) {
      return statusBadgeText(instance, definition)
        .split(" · ")
        .map((part, index) =>
          jsxRuntime.jsx("span", { children: part }, `status-${index}`),
        );
    }

    function parseLoopLimit(expression) {
      const match =
        /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(>=|<=|>|<|==|===)\s*(\d+)\s*$/.exec(
          expression ?? "",
        );
      if (match === null) return null;
      if (match[2] !== ">=" && match[2] !== "===") return null;
      const limit = Number(match[3]);
      return Number.isFinite(limit) && limit > 0 ? limit : null;
    }

    function loopRules(definition) {
      return (definition?.graph.edges ?? [])
        .filter((edge) => edge.breakCondition !== undefined)
        .map((edge) => {
          const nodeById = (id) =>
            definition?.graph.nodes.find((node) => node.id === id);
          return {
            edge,
            source: nodeById(edge.from),
            target: nodeById(edge.to),
            limit: parseLoopLimit(edge.breakCondition),
          };
        });
    }

    function loopHint(rule, instance) {
      const targetName = rule.target?.name ?? rule.edge.to;
      const sourceName = rule.source?.name ?? rule.edge.from;
      const current = Number(instance?.nodes?.[rule.edge.to]?.attempts ?? 1);
      if (rule.limit === null) {
        return `循环保护：${sourceName}未通过时返回「${targetName}」。触发条件：${rule.edge.breakCondition}`;
      }
      return `循环保护：${sourceName}未通过时返回「${targetName}」，最多尝试 ${rule.limit} 次；超出后流程阻断。当前第 ${current} / ${rule.limit} 次。`;
    }

    function triggeredLoopRule(rules, nodeId, state) {
      if (state?.note?.startsWith("已触发 break") !== true) return undefined;
      return rules.find((rule) => rule.edge.to === nodeId);
    }

    function nodeClass(state) {
      if (state.status === "ready" || state.status === "running")
        return "current";
      if (state.status === "waiting") return "waiting";
      if (["blocked", "failed"].includes(state.status)) return state.status;
      if (state.status === "completed") return "completed";
      return "waiting";
    }

    /** 工作流关键指标：全部由现有实例数据派生，不新增任何后端能力。 */
    function workflowKpis(instances) {
      const total = instances.length;
      const running = instances.filter(
        (item) => item.status === "running",
      ).length;
      const blocked = instances.filter((item) =>
        ["blocked", "failed"].includes(item.status),
      ).length;
      const completed = instances.filter(
        (item) => item.status === "completed",
      ).length;
      const projects = new Set(instances.map((item) => item.workspaceId)).size;
      return [
        { label: "实例总数", value: total, note: `${projects} 个项目` },
        {
          label: "进行中",
          value: running,
          note: running > 0 ? "节点持续流转" : "暂无进行中实例",
        },
        {
          label: "阻塞 / 失败",
          value: blocked,
          note: blocked > 0 ? "需优先处理" : "当前无阻塞",
          tone: blocked > 0 ? "down" : "",
        },
        {
          label: "已完成",
          value: completed,
          note:
            total > 0
              ? `${Math.round((completed / total) * 100)}% 完成率`
              : "暂无实例",
          tone: completed > 0 ? "up" : "",
        },
      ];
    }

    const WORKFLOW_HUMAN_SLA_MS = 3 * 60 * 60 * 1000;

    /** 节点相对 SLA：Agent / Teammate 用配置的运行上限，人工节点统一 T+3h。 */
    function workflowSlaMs(node) {
      if (!["agent", "employee"].includes(node?.executor?.kind)) {
        return WORKFLOW_HUMAN_SLA_MS;
      }
      const configured = Number(node?.timeoutMs);
      return Number.isFinite(configured) && configured > 0
        ? configured
        : WORKFLOW_HUMAN_SLA_MS;
    }

    function workflowSlaLabel(node) {
      return `T+${formatDuration(workflowSlaMs(node))}`;
    }

    /** DDL 按「进入节点时刻 + 相对 SLA」换算；已完成节点显示完成时间。 */
    function workflowNodeDeadline(node, state) {
      const start = Date.parse(state?.enteredAt ?? "");
      if (!Number.isFinite(start)) return undefined;
      return new Date(start + workflowSlaMs(node)).toISOString();
    }

    function workflowNodeDue(node, state) {
      if (!state) return undefined;
      if (state.status === "completed" || state.status === "skipped") {
        return state.completedAt
          ? {
              at: state.completedAt,
              completed: true,
              skipped: state.status === "skipped",
            }
          : undefined;
      }
      const at = workflowNodeDeadline(node, state);
      return at === undefined ? undefined : { at, completed: false };
    }

    function workflowDateTime(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      const pad = (part) => String(part).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours(),
      )}:${pad(date.getMinutes())}`;
    }

    function workflowOverdueSpan(deadline, completedAt) {
      const diff = Date.parse(completedAt ?? "") - Date.parse(deadline ?? "");
      if (!Number.isFinite(diff) || diff <= 0) return "";
      const days = Math.floor(diff / 86_400_000);
      const hours = Math.floor((diff % 86_400_000) / 3_600_000);
      if (days > 0) return `逾期${days}天`;
      if (hours > 0) return `逾期${hours}小时`;
      return "逾期不足1小时";
    }

    function workflowNodeExecutionTime(node, state) {
      if (!state) return "—";
      const deadline = workflowNodeDeadline(node, state);
      if (state.status === "completed" || state.status === "skipped") {
        if (!state.completedAt) return "—";
        const overdue =
          deadline === undefined
            ? ""
            : workflowOverdueSpan(deadline, state.completedAt);
        return `${workflowDateTime(state.completedAt)}${overdue ? `（${overdue}）` : ""}`;
      }
      return deadline === undefined
        ? "—"
        : `${workflowDateTime(deadline)}（计划）`;
    }

    function formatDueLabel(due) {
      if (due === undefined) return "";
      if (due.completed) return due.skipped ? "已跳过" : "已完成";
      const target = Date.parse(due.at);
      if (!Number.isFinite(target)) return "";
      const diff = target - Date.now();
      const minutes = Math.max(1, Math.round(Math.abs(diff) / 60_000));
      const text =
        minutes < 60
          ? `${minutes}m`
          : minutes < 1_440
            ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
            : `${Math.floor(minutes / 1_440)}d`;
      return diff >= 0 ? `剩余 ${text}` : `已超时 ${text}`;
    }

    function workflowDueOverdue(due) {
      if (due === undefined || due.completed) return false;
      const target = Date.parse(due.at);
      return Number.isFinite(target) && target < Date.now();
    }

    /** 交付物汇总：供流程节点上的 x/y 与浮层使用。 */
    function workflowDeliverableSummary(node, state, submissions) {
      const rows = (node?.deliverables ?? []).map((requirement) => {
        const current = state?.deliverables?.[requirement.key];
        const matches = (submissions ?? []).filter(
          (item) =>
            item.nodeId === node.id && item.requirementKey === requirement.key,
        );
        const latest =
          matches.find((item) => item.id === current?.latestSubmissionId) ??
          matches.at(-1);
        const done = current?.status === "submitted";
        const value = !done
          ? "NA"
          : latest?.type === "file"
            ? (latest.artifacts ?? [])
                .map((artifact) => artifact.fileName)
                .join("、") || "文件已提交"
            : (latest?.value ?? "已提交");
        return {
          key: requirement.key,
          title: requirement.title,
          status: current?.status ?? "pending",
          done,
          value: String(value).replace(/\s+/g, " ").slice(0, 120),
          submittedAt: latest?.submittedAt ?? "",
        };
      });
      return {
        rows,
        done: rows.filter((row) => row.done).length,
        total: rows.length,
      };
    }

    /** 按边关系分层：同层是并行分支，回边作为循环标注。 */
    function workflowFlowLayout(definition) {
      const nodes = definition?.graph?.nodes ?? [];
      const edges = definition?.graph?.edges ?? [];
      if (nodes.length === 0)
        return { stages: [], loops: [], backKeys: new Set() };
      const ids = new Set(nodes.map((node) => node.id));
      const outgoing = new Map(nodes.map((node) => [node.id, []]));
      const incoming = new Map(nodes.map((node) => [node.id, []]));
      for (const edge of edges) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
        outgoing.get(edge.from).push(edge);
        incoming.get(edge.to).push(edge);
      }
      const backKeys = new Set();
      const loops = [];
      const visitState = new Map();
      const visit = (id) => {
        visitState.set(id, 1);
        for (const edge of outgoing.get(id) ?? []) {
          const next = visitState.get(edge.to) ?? 0;
          if (next === 1) {
            const key = `${edge.from}->${edge.to}`;
            if (!backKeys.has(key)) {
              backKeys.add(key);
              loops.push(edge);
            }
          } else if (next === 0) {
            visit(edge.to);
          }
        }
        visitState.set(id, 2);
      };
      const starts = (definition?.graph?.startNodeIds ?? []).filter((id) =>
        ids.has(id),
      );
      const roots =
        starts.length > 0
          ? starts
          : nodes
              .filter((node) => (incoming.get(node.id)?.length ?? 0) === 0)
              .map((node) => node.id);
      for (const id of roots) if (!visitState.get(id)) visit(id);
      for (const node of nodes) {
        if (!visitState.get(node.id)) visit(node.id);
      }
      const forward = edges.filter(
        (edge) =>
          ids.has(edge.from) &&
          ids.has(edge.to) &&
          !backKeys.has(`${edge.from}->${edge.to}`),
      );
      const layer = new Map(nodes.map((node) => [node.id, 0]));
      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      for (const edge of forward) {
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
      }
      const queue = nodes
        .filter((node) => (indegree.get(node.id) ?? 0) === 0)
        .map((node) => node.id);
      while (queue.length > 0) {
        const id = queue.shift();
        for (const edge of forward.filter((item) => item.from === id)) {
          layer.set(
            edge.to,
            Math.max(layer.get(edge.to) ?? 0, (layer.get(id) ?? 0) + 1),
          );
          indegree.set(edge.to, (indegree.get(edge.to) ?? 1) - 1);
          if (indegree.get(edge.to) === 0) queue.push(edge.to);
        }
      }
      const stages = [];
      for (const node of nodes) {
        const index = layer.get(node.id) ?? 0;
        if (stages[index] === undefined) stages[index] = [];
        stages[index].push(node);
      }
      return {
        stages: stages.filter(
          (stage) => stage !== undefined && stage.length > 0,
        ),
        loops,
        backKeys,
      };
    }

    /**
     * 节点展示模型：编码、缩进层级、并行/汇合/子流程标识。
     *
     * - `-` 表示同层并行分支；
     * - `.` 表示进入子流程后的层级；
     * - 只有子流程增加 depth；并行分支与汇合节点都不缩进。
     */
    function workflowNodePresentation(definition, options = {}) {
      const prefix = options.prefix ?? "";
      const depth = options.depth ?? 0;
      const layout = workflowFlowLayout(definition);
      const nodes = definition?.graph?.nodes ?? [];
      const ids = new Set(nodes.map((node) => node.id));
      const forwardIn = new Map();
      for (const edge of definition?.graph?.edges ?? []) {
        if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
        // 循环回边不参与汇合判定。
        if (layout.backKeys?.has(`${edge.from}->${edge.to}`)) continue;
        forwardIn.set(edge.to, (forwardIn.get(edge.to) ?? 0) + 1);
      }
      const entries = [];
      const byId = new Map();
      const negateCondition = (expression) => {
        const trimmed = expression.trim();
        const match = /^(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/.exec(trimmed);
        if (match === null) return `不满足 ${trimmed}`;
        const opposites = {
          ">=": "<",
          "<=": ">",
          "==": "!=",
          "!=": "==",
          ">": "<=",
          "<": ">=",
        };
        return `${match[1].trim()} ${opposites[match[2]]} ${match[3].trim()}`;
      };
      const branchLabelOf = (edge, allEdges = []) => {
        if ((edge?.label ?? "").trim() !== "") return edge.label.trim();
        if ((edge?.condition ?? "").trim() !== "") {
          return edge.condition.trim();
        }
        if (edge?.default === true) {
          // 默认分支没有显式条件：用其他分支条件的反面表达进入条件。
          const others = allEdges.filter(
            (item) => item !== edge && (item.condition ?? "").trim() !== "",
          );
          if (others.length === 1) {
            return negateCondition(others[0].condition);
          }
          if (others.length > 1) {
            return `其他情况（${others
              .map((item) => `不满足 ${item.condition.trim()}`)
              .join(" 且 ")}）`;
          }
          return "其他情况";
        }
        if (edge?.result === "approved") return "审批通过";
        if (edge?.result === "rejected") return "审批退回";
        return "";
      };
      const push = (node, localCode, mode, branchLabel = "") => {
        const entry = {
          node,
          code: prefix === "" ? localCode : `${prefix}.${localCode}`,
          depth,
          parallel: mode === "parallel",
          branch: mode === "branch",
          branchLabel,
          join: (forwardIn.get(node.id) ?? 0) > 1,
          subflow: node.type === "subworkflow",
        };
        entries.push(entry);
        byId.set(node.id, entry);
      };
      layout.stages.forEach((stage, stageIndex) => {
        const stageNo = stageIndex + 1;
        if (stage.length === 1) {
          push(stage[0], String(stageNo), "sequence");
          return;
        }
        const targetIds = new Set(stage.map((node) => node.id));
        const incoming = (definition?.graph?.edges ?? []).filter(
          (edge) =>
            targetIds.has(edge.to) &&
            !layout.backKeys?.has(`${edge.from}->${edge.to}`),
        );
        const sources = new Set(incoming.map((edge) => edge.from));
        const source =
          sources.size === 1
            ? nodes.find((node) => node.id === [...sources][0])
            : undefined;
        const hasCondition = incoming.some(
          (edge) =>
            (edge.condition ?? "").trim() !== "" || edge.default === true,
        );
        const distinctResults = new Set(
          incoming.map((edge) => edge.result ?? "").filter(Boolean),
        );
        // 决策节点、条件边、默认边或不同 result 表示 N 选 1 分叉；
        // 普通多出边（例如审批通过后同时启动开发与测试）才是并行流程。
        const isBranch =
          source?.type === "decision" ||
          hasCondition ||
          distinctResults.size > 1;
        stage.forEach((node, laneIndex) => {
          const edge = incoming.find((item) => item.to === node.id);
          if (isBranch) {
            const letter = String.fromCharCode(97 + laneIndex);
            push(
              node,
              `${stageNo}${letter}`,
              "branch",
              branchLabelOf(edge, incoming),
            );
          } else {
            push(node, `${stageNo}-${laneIndex + 1}`, "parallel");
          }
        });
      });
      return { entries, byId, layout, depth };
    }

    /**
     * 只读流程图：分层展示并行分支、汇合与循环。
     * 点击节点会滚动到下方节点卡片；交付物按钮打开只读清单浮层。
     */
    function WorkflowFlowOverview({
      definition,
      states,
      submissions,
      onDeliverableOpen,
      onTemplateOpen,
      onSelectNode,
      resolveSubflow,
    }) {
      const presentation = workflowNodePresentation(definition);
      const layout = presentation.layout;
      if (layout.stages.length === 0) return null;
      const legend = [
        ["task", "执行"],
        ["approval", "审批"],
        ["decision", "决策"],
        ["subworkflow", "子流程"],
        ["service", "服务"],
      ];
      const renderNode = (node) => {
        const state = states?.[node.id];
        const info = presentation.byId.get(node.id);
        const subflowDefinition = info?.subflow
          ? resolveSubflow?.(node)
          : undefined;
        const subflowCount = subflowDefinition?.graph?.nodes?.length ?? 0;
        const due = workflowNodeDue(node, state);
        const dueLabel = formatDueLabel(due);
        const delivery = workflowDeliverableSummary(node, state, submissions);
        const executor =
          state?.assignedTo ?? node.executor.label ?? node.executor.id;
        const statusLabel = workflowNodeStatusText(node, state);
        const selectNode = () => {
          onSelectNode?.(node.id);
          const target = document.getElementById(`pmwf-node-${node.id}`);
          target?.scrollIntoView({ behavior: "smooth", block: "center" });
        };
        return jsxRuntime.jsxs(
          "div",
          {
            className: `pmwf-overview-node ${node.type} ${nodeClass(state)}`,
            title: `${node.name} · ${statusLabel}`,
            children: [
              jsxRuntime.jsxs("button", {
                type: "button",
                className: "pmwf-overview-select",
                "aria-label": `${node.name} · ${statusLabel}`,
                onClick: selectNode,
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-overview-node-title",
                    children: [
                      jsxRuntime.jsx("span", {
                        className: "pmwf-overview-node-index",
                        children: info?.code ?? "?",
                      }),
                      jsxRuntime.jsx("strong", { children: node.name }),
                    ],
                  }),
                  jsxRuntime.jsx("small", {
                    className: "pmwf-overview-node-meta",
                    children: `${executor}${dueLabel ? ` · ${dueLabel}` : ""}`,
                  }),
                  info?.branch && info.branchLabel
                    ? jsxRuntime.jsx("small", {
                        className: "pmwf-overview-branch-label",
                        children: `进入条件：${info.branchLabel}`,
                      })
                    : null,
                  info?.subflow
                    ? jsxRuntime.jsx("small", {
                        className: "pmwf-overview-subflow",
                        children:
                          subflowCount > 0
                            ? `子流程 · ${subflowCount} 个节点`
                            : "子流程 · 模板未找到",
                      })
                    : null,
                ],
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-overview-node-foot",
                children: [
                  delivery.total > 0
                    ? jsxRuntime.jsxs("button", {
                        type: "button",
                        className: "pmwf-overview-delivery",
                        "aria-label": `查看${node.name}交付物清单`,
                        onClick: (event) => {
                          event.stopPropagation();
                          onDeliverableOpen?.(
                            node.id,
                            event.currentTarget.getBoundingClientRect(),
                          );
                        },
                        children: [`交付 ${delivery.done}/${delivery.total}`],
                      })
                    : null,
                  jsxRuntime.jsx("span", {
                    className: `pmwf-overview-state ${nodeClass(state)}`,
                    children: statusLabel,
                  }),
                ],
              }),
            ],
          },
          node.id,
        );
      };
      const nodeName = (id) =>
        definition?.graph?.nodes.find((node) => node.id === id)?.name ?? id;
      return jsxRuntime.jsxs("div", {
        className: "pmwf-overview",
        children: [
          jsxRuntime.jsxs("div", {
            className: "pmwf-overview-head",
            children: [
              jsxRuntime.jsxs("div", {
                className: "pmwf-overview-head-left",
                children: [
                  jsxRuntime.jsx("h3", { children: "流程概览" }),
                  jsxRuntime.jsxs("button", {
                    type: "button",
                    className: "pmwf-overview-template",
                    disabled: definition === undefined,
                    onClick: onTemplateOpen,
                    title: "查看工作流模版详情",
                    children: [
                      "模板：",
                      jsxRuntime.jsx("b", {
                        children:
                          definition === undefined
                            ? "不可用"
                            : `${definition.name} v${definition.version}`,
                      }),
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsx("div", {
                className: "pmwf-overview-legend",
                children: legend.map(([kind, label]) =>
                  jsxRuntime.jsxs(
                    "span",
                    {
                      children: [
                        jsxRuntime.jsx("i", { className: kind }),
                        label,
                      ],
                    },
                    kind,
                  ),
                ),
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "pmwf-overview-track",
            children: layout.stages.flatMap((stage, index) => {
              const parts = [];
              if (index > 0) {
                parts.push(
                  jsxRuntime.jsx(
                    "span",
                    {
                      className: "pmwf-overview-arrow",
                      "aria-hidden": true,
                      children: "→",
                    },
                    `arrow-${index}`,
                  ),
                );
              }
              const stageEntries = stage.map((node) =>
                presentation.byId.get(node.id),
              );
              const branchStage = stageEntries.some((entry) => entry?.branch);
              const parallelStage = stage.length > 1 && !branchStage;
              parts.push(
                jsxRuntime.jsxs(
                  "div",
                  {
                    className: `pmwf-overview-stage${branchStage ? " branch" : parallelStage ? " parallel" : ""}`,
                    children: [
                      branchStage || parallelStage
                        ? jsxRuntime.jsx("span", {
                            className: "pmwf-overview-stage-title",
                            children: branchStage
                              ? `分支流程 · ${stage.length} 选 1`
                              : "并行流程",
                          })
                        : null,
                      ...stage.map((node) =>
                        jsxRuntime.jsx(
                          "div",
                          {
                            className: "pmwf-overview-lane",
                            children: renderNode(node),
                          },
                          node.id,
                        ),
                      ),
                    ],
                  },
                  `stage-${index}`,
                ),
              );
              return parts;
            }),
          }),
          ...layout.loops.map((edge) =>
            jsxRuntime.jsxs(
              "div",
              {
                className: "pmwf-overview-loop",
                children: [
                  jsxRuntime.jsx("span", { children: "↺" }),
                  jsxRuntime.jsx("strong", {
                    children: edge.label ?? edge.condition ?? "循环",
                  }),
                  jsxRuntime.jsxs("small", {
                    children: [nodeName(edge.from), " → ", nodeName(edge.to)],
                  }),
                ],
              },
              `loop-${edge.from}-${edge.to}`,
            ),
          ),
        ],
      });
    }

    function Feedback({ error, notice }) {
      if (error)
        return jsxRuntime.jsx("div", {
          className: "pmwf-note error",
          role: "alert",
          children: error,
        });
      if (notice)
        return jsxRuntime.jsx("div", {
          className: "pmwf-note success",
          children: notice,
        });
      return null;
    }

    const EMPTY_WORKFLOW_MARKDOWN = `# 工作流：新工作流模版

## 触发条件
- 补充触发说明。

## 执行节点
1. 定义第一个节点。

## 完成条件
- 补充完成条件。
`;

    function WorkflowTemplateManager({
      workspaceOptions,
      currentWorkspaceId,
      canManage,
      onClose,
    }) {
      const [definitions, setDefinitions] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState(
        (workspaceOptions.some((item) => item.id === currentWorkspaceId)
          ? currentWorkspaceId
          : workspaceOptions.find((item) => item.isMember)?.id) ??
          workspaceOptions[0]?.id ??
          "",
      );
      const [selectedId, setSelectedId] = react.useState("");
      const [query, setQuery] = react.useState("");
      const [editing, setEditing] = react.useState(false);
      const [sourceMd, setSourceMd] = react.useState("");
      const [draftWorkspaceId, setDraftWorkspaceId] = react.useState("");
      const [validation, setValidation] = react.useState(null);
      const [validatedSourceMd, setValidatedSourceMd] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [archivedExpanded, setArchivedExpanded] = react.useState(false);

      react.useEffect(() => {
        if (notice === "" && error === "") return undefined;
        const timer = window.setTimeout(() => {
          setNotice("");
          setError("");
        }, 3_000);
        return () => window.clearTimeout(timer);
      }, [notice, error]);

      const load = react.useCallback(async () => {
        const workspaceIds =
          workspaceId === ""
            ? workspaceOptions.map((item) => item.id)
            : [workspaceId];
        if (workspaceIds.length === 0) {
          setDefinitions([]);
          return;
        }
        try {
          setBusy("load");
          const results = await Promise.all(
            workspaceIds.map((id) =>
              request(
                `/api/collab/workflow/definitions?workspaceId=${encodeURIComponent(id)}`,
              ),
            ),
          );
          setDefinitions(results.flatMap((item) => item.definitions ?? []));
          setError("");
        } catch (cause) {
          setError(friendly(cause));
        } finally {
          setBusy("");
        }
      }, [workspaceId, workspaceOptions]);

      react.useEffect(() => {
        void load();
      }, [load]);

      const globalDefinitions = dedupeWorkflowDefinitions(definitions);
      const visible = globalDefinitions.filter((item) => {
        const keyword = query.trim().toLowerCase();
        if (keyword === "") return true;
        return [
          item.name,
          item.key,
          item.description,
          item.sourceMd,
          ...(item.graph?.nodes ?? []).flatMap((node) => [
            node.name,
            node.description,
            workflowNodeOwnerLabel(node),
          ]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      });
      const activeDefinitions = visible.filter(
        (item) => item.status !== "archived",
      );
      const archivedDefinitions = visible.filter(
        (item) => item.status === "archived",
      );
      const listable = archivedExpanded
        ? [...activeDefinitions, ...archivedDefinitions]
        : activeDefinitions;
      const selected =
        selectedId === "__new__"
          ? null
          : (listable.find((item) => item.id === selectedId) ??
            listable[0] ??
            null);

      react.useEffect(() => {
        if (editing && selectedId === "__new__") return;
        if (selected !== null && selected.id !== selectedId) {
          setSelectedId(selected.id);
        }
      }, [editing, selected, selectedId]);

      const renderTemplateItem = (item) =>
        jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            className: `pmwf-profile-list-item${item.id === selected?.id ? " active" : ""}${
              item.status === "archived" ? " archived" : ""
            }`,
            onClick: () => {
              setSelectedId(item.id);
              setEditing(false);
              setValidation(null);
            },
            children: [
              jsxRuntime.jsx("span", {
                className: `pmwf-profile-list-dot${item.status === "active" ? " enabled" : ""}`,
              }),
              jsxRuntime.jsxs("span", {
                className: "pmwf-profile-list-copy",
                children: [
                  jsxRuntime.jsx("strong", {
                    children: item.name,
                  }),
                  jsxRuntime.jsx("small", {
                    children: `${item.key} · v${item.version} · ${
                      item.status === "active"
                        ? "已启用"
                        : item.status === "disabled"
                          ? "已停用"
                          : "已归档"
                    }`,
                  }),
                ],
              }),
            ],
          },
          item.id,
        );

      const startEditing = (definition) => {
        setSelectedId(definition?.id ?? "");
        setSourceMd(definition?.sourceMd ?? EMPTY_WORKFLOW_MARKDOWN);
        setValidation(null);
        setValidatedSourceMd("");
        setEditing(true);
      };

      const chooseMarkdownFile = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          setSourceMd(String(reader.result ?? ""));
          setValidation(null);
          setValidatedSourceMd("");
        };
        reader.readAsText(file);
        event.target.value = "";
      };

      const validate = async () => {
        const targetWorkspaceId =
          workspaceId || draftWorkspaceId || workspaceOptions[0]?.id || "";
        if (!targetWorkspaceId) return;
        setBusy("validate");
        try {
          const result = await request(
            "/api/collab/workflow/definitions/validate",
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: targetWorkspaceId,
                sourceMd,
              }),
            },
          );
          setValidation(result);
          setValidatedSourceMd(sourceMd);
          const hasErrors = (result.issues ?? []).some(
            (issue) => issue.level === "error",
          );
          setError(hasErrors ? "校验发现错误" : "");
          setNotice(hasErrors ? "" : "校验通过");
        } catch (cause) {
          const message = friendly(cause);
          setValidation({
            issues: [{ level: "error", message }],
          });
          setValidatedSourceMd(sourceMd);
          setError("校验失败");
        } finally {
          setBusy("");
        }
      };

      const save = async (event) => {
        event.preventDefault();
        const targetWorkspaceId =
          workspaceId || draftWorkspaceId || workspaceOptions[0]?.id || "";
        if (!targetWorkspaceId) return;
        setBusy("save");
        try {
          const result = await request(
            "/api/collab/workflow/definitions/import",
            {
              method: "POST",
              body: JSON.stringify({
                workspaceId: targetWorkspaceId,
                sourceMd,
                activate: true,
              }),
            },
          );
          setEditing(false);
          setNotice(
            `已保存「${result.definition.name}」v${result.definition.version}`,
          );
          setValidation(null);
          setValidatedSourceMd("");
          await load();
          setSelectedId(result.definition.id);
        } catch (cause) {
          const message = friendly(cause);
          setValidation({
            issues: [{ level: "error", message }],
          });
          setValidatedSourceMd(sourceMd);
          setError("保存失败");
        } finally {
          setBusy("");
        }
      };

      const setStatus = async (status) => {
        if (!selected) return;
        setBusy(`status:${selected.id}`);
        try {
          await request("/api/collab/workflow/definitions/status", {
            method: "POST",
            body: JSON.stringify({
              workspaceId:
                workspaceId || draftWorkspaceId || selected.workspaceId,
              definitionId: selected.id,
              status,
            }),
          });
          setNotice(
            status === "active"
              ? "已启用模版"
              : status === "disabled"
                ? "已停用模版"
                : "已归档模版",
          );
          await load();
        } catch (cause) {
          setError(friendly(cause));
        } finally {
          setBusy("");
        }
      };

      const nodes = selected?.graph?.nodes ?? [];
      const edges = selected?.graph?.edges ?? [];

      return jsxRuntime.jsxs("div", {
        className: "pmwf-template-inline",
        children: [
          jsxRuntime.jsxs("div", {
            className: "pmwf-template-inline-head",
            children: [
              jsxRuntime.jsxs("div", {
                children: [
                  jsxRuntime.jsx("h2", { children: "工作流模版管理" }),
                  jsxRuntime.jsx("div", {
                    className: "pmwf-template-inline-sub",
                    children: selected?.description
                      ? `可复用工作流定义、节点编排与版本管理，${selected.description}`
                      : "可复用工作流定义、节点编排与版本管理",
                  }),
                ],
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-heading-actions",
                children: [
                  jsxRuntime.jsx("span", {
                    className: "pmwf-filter",
                    children: "全平台共享",
                  }),
                  notice !== "" || error !== ""
                    ? jsxRuntime.jsx("span", {
                        className: `pmwf-inline-feedback${error !== "" ? " error" : ""}`,
                        children: error !== "" ? error : notice,
                      })
                    : null,
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-iconbtn",
                    onClick: () => void load(),
                    disabled: busy !== "",
                    "aria-label": "刷新工作流模版",
                    title: "刷新",
                    children: jsxRuntime.jsx(RefreshIcon, {}),
                  }),
                  selectedId === "__new__"
                    ? null
                    : jsxRuntime.jsx("button", {
                        type: "button",
                        className: "pmwf-btn small",
                        disabled: !canManage || busy !== "",
                        onClick: () => {
                          setEditing(true);
                          setSelectedId("__new__");
                          setDraftWorkspaceId(
                            workspaceId || workspaceOptions[0]?.id || "",
                          );
                          setSourceMd(EMPTY_WORKFLOW_MARKDOWN);
                          setValidation(null);
                        },
                        children: "新建模版",
                      }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-btn secondary small",
                    onClick: onClose,
                    "aria-label": "关闭工作流模版管理",
                    children: "×",
                  }),
                ],
              }),
            ],
          }),
          jsxRuntime.jsxs("div", {
            className: "pmwf-template-inline-body",
            children: [
              jsxRuntime.jsxs("div", {
                className: "pmwf-template-sidebar",
                children: [
                  jsxRuntime.jsx("label", {
                    className: "pmwf-profile-search",
                    children: jsxRuntime.jsx("input", {
                      value: query,
                      onChange: (event) => setQuery(event.target.value),
                      placeholder: "搜索模版名称或节点",
                    }),
                  }),
                  jsxRuntime.jsx("div", {
                    className: "pmwf-profile-list",
                    children:
                      selectedId === "__new__" ||
                      listable.length > 0 ||
                      archivedDefinitions.length > 0
                        ? [
                            selectedId === "__new__"
                              ? jsxRuntime.jsxs(
                                  "button",
                                  {
                                    type: "button",
                                    className: "pmwf-profile-list-item active",
                                    children: [
                                      jsxRuntime.jsx("span", {
                                        className: "pmwf-profile-list-dot",
                                      }),
                                      jsxRuntime.jsxs("span", {
                                        className: "pmwf-profile-list-copy",
                                        children: [
                                          jsxRuntime.jsx("strong", {
                                            children: "新工作流模版",
                                          }),
                                          jsxRuntime.jsx("small", {
                                            children: "临时模版 · 待保存",
                                          }),
                                        ],
                                      }),
                                    ],
                                  },
                                  "__new__",
                                )
                              : null,
                            ...activeDefinitions.map(renderTemplateItem),
                            archivedDefinitions.length > 0
                              ? jsxRuntime.jsxs(
                                  "button",
                                  {
                                    type: "button",
                                    className: `pmwf-archived-toggle${archivedExpanded ? " open" : ""}`,
                                    onClick: () =>
                                      setArchivedExpanded(!archivedExpanded),
                                    "aria-expanded": archivedExpanded,
                                    children: [
                                      jsxRuntime.jsxs("span", {
                                        children: [
                                          jsxRuntime.jsx("span", {
                                            className: "chevron",
                                            children: "→",
                                          }),
                                          ` 已归档模版`,
                                        ],
                                      }),
                                      jsxRuntime.jsx("span", {
                                        className: "pmwf-archived-count",
                                        children: archivedDefinitions.length,
                                      }),
                                    ],
                                  },
                                  "archived-section",
                                )
                              : null,
                            ...(archivedExpanded
                              ? archivedDefinitions.map(renderTemplateItem)
                              : []),
                          ]
                        : jsxRuntime.jsx("div", {
                            className: "pmwf-empty",
                            children: "没有匹配的工作流模版。",
                          }),
                  }),
                ],
              }),
              jsxRuntime.jsx("main", {
                className: "pmwf-profile-detail",
                children: editing
                  ? jsxRuntime.jsxs("form", {
                      onSubmit: save,
                      children: [
                        jsxRuntime.jsxs("div", {
                          className: "pmwf-profile-detail-head",
                          children: [
                            jsxRuntime.jsx("h3", {
                              children: selected
                                ? `编辑 ${selected.name}`
                                : "新建工作流模版",
                            }),
                            selected
                              ? jsxRuntime.jsx("span", {
                                  className: "pmwf-label",
                                  children: `v${selected.version}`,
                                })
                              : null,
                          ],
                        }),
                        jsxRuntime.jsxs("div", {
                          className: "pmwf-row",
                          children: [
                            jsxRuntime.jsx("label", {
                              className: "pmwf-btn secondary small",
                              htmlFor: "pmwf-template-markdown-file",
                              children: "选择 MD 文档",
                            }),
                            jsxRuntime.jsx("input", {
                              id: "pmwf-template-markdown-file",
                              type: "file",
                              accept: ".md,.markdown,text/markdown,text/plain",
                              style: { display: "none" },
                              onChange: chooseMarkdownFile,
                            }),
                          ],
                        }),
                        jsxRuntime.jsx("textarea", {
                          className: "pmwf-area",
                          rows: 16,
                          value: sourceMd,
                          onChange: (event) => setSourceMd(event.target.value),
                          required: true,
                        }),
                        validation && validatedSourceMd === sourceMd
                          ? (() => {
                              const issues = validation.issues ?? [];
                              const errors = issues.filter(
                                (issue) => issue.level === "error",
                              );
                              const warnings = issues.filter(
                                (issue) => issue.level === "warning",
                              );
                              const renderIssues = (label, items) =>
                                items.length === 0
                                  ? null
                                  : jsxRuntime.jsxs("div", {
                                      className: `pmwf-note ${label === "错误" ? "error" : "warning"}`,
                                      children: [
                                        jsxRuntime.jsx("strong", {
                                          children: label,
                                        }),
                                        jsxRuntime.jsx("ul", {
                                          className: "pmwf-validation-issues",
                                          children: items.map((issue, index) =>
                                            jsxRuntime.jsx(
                                              "li",
                                              { children: issue.message },
                                              `${issue.level}:${index}`,
                                            ),
                                          ),
                                        }),
                                      ],
                                    });
                              return jsxRuntime.jsxs(react.Fragment, {
                                children: [
                                  renderIssues("错误", errors),
                                  renderIssues("警告", warnings),
                                  errors.length === 0 && warnings.length === 0
                                    ? jsxRuntime.jsx("div", {
                                        className: "pmwf-note success",
                                        children: "校验通过",
                                      })
                                    : null,
                                ],
                              });
                            })()
                          : null,
                        jsxRuntime.jsxs("div", {
                          className: "pmwf-dialog-actions",
                          children: [
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "pmwf-btn secondary",
                              onClick: () => setEditing(false),
                              children: "取消",
                            }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              className: "pmwf-btn secondary",
                              disabled:
                                !canManage ||
                                busy !== "" ||
                                sourceMd.trim() === "",
                              onClick: () => void validate(),
                              children: busy === "validate" ? "校验中" : "校验",
                            }),
                            jsxRuntime.jsx("button", {
                              type: "submit",
                              className: "pmwf-btn",
                              disabled:
                                !canManage ||
                                busy !== "" ||
                                sourceMd.trim() === "",
                              children:
                                busy === "save" ? "保存中" : "保存新版本",
                            }),
                          ],
                        }),
                      ],
                    })
                  : selected
                    ? jsxRuntime.jsxs(react.Fragment, {
                        children: [
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-profile-detail-head",
                            children: [
                              jsxRuntime.jsxs("div", {
                                children: [
                                  jsxRuntime.jsx("h3", {
                                    children: selected.name,
                                  }),
                                  jsxRuntime.jsx("div", {
                                    className: "pmwf-profile-meta",
                                    children: `${selected.key} · v${selected.version} · 更新 ${timeShort(selected.updatedAt)}`,
                                  }),
                                ],
                              }),
                              jsxRuntime.jsx("span", {
                                className: `pmwf-pill ${selected.status === "active" ? "completed" : selected.status === "disabled" ? "waiting" : "cancelled"}`,
                                children:
                                  selected.status === "active"
                                    ? "已启用"
                                    : selected.status === "disabled"
                                      ? "已停用"
                                      : "已归档",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-heading-actions",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled: !canManage,
                                onClick: () => startEditing(selected),
                                children: "编辑",
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled: !canManage || busy !== "",
                                onClick: () =>
                                  void setStatus(
                                    selected.status === "active"
                                      ? "disabled"
                                      : "active",
                                  ),
                                children:
                                  selected.status === "active"
                                    ? "停用"
                                    : "启用",
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                disabled:
                                  !canManage ||
                                  selected.status === "archived" ||
                                  busy !== "",
                                onClick: () => void setStatus("archived"),
                                children: "归档",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("section", {
                            className: "pmwf-profile-detail-section",
                            children: [
                              jsxRuntime.jsx("div", {
                                className: "pmwf-profile-preview-title",
                                children: "模版说明",
                              }),
                              jsxRuntime.jsx("p", {
                                className: "pmwf-label",
                                children: selected.description || "暂无说明。",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("section", {
                            className: "pmwf-profile-detail-section",
                            children: [
                              jsxRuntime.jsxs("div", {
                                className: "pmwf-node-section-head",
                                children: [
                                  jsxRuntime.jsx("div", {
                                    className: "pmwf-profile-preview-title",
                                    children: "节点说明",
                                  }),
                                  jsxRuntime.jsxs("span", {
                                    className: "pmwf-filter",
                                    children: [nodes.length, " 个节点"],
                                  }),
                                ],
                              }),
                              jsxRuntime.jsx("div", {
                                className: "pmwf-profile-node-list",
                                children:
                                  nodes.length > 0
                                    ? nodes.map((node, index) =>
                                        jsxRuntime.jsxs(
                                          "article",
                                          {
                                            className: `pmwf-profile-node-card${edges.filter((edge) => edge.to === node.id).length > 1 ? " branch" : ""}`,
                                            children: [
                                              jsxRuntime.jsx("span", {
                                                className: `pmwf-profile-node-index${edges.filter((edge) => edge.to === node.id).length > 1 ? " branch" : ""}`,
                                                children: workflowNodeKey(
                                                  nodes,
                                                  index,
                                                ),
                                              }),
                                              jsxRuntime.jsxs("div", {
                                                className:
                                                  "pmwf-profile-node-main",
                                                children: [
                                                  jsxRuntime.jsxs("div", {
                                                    className:
                                                      "pmwf-profile-node-title",
                                                    children: [
                                                      jsxRuntime.jsx("strong", {
                                                        children: node.name,
                                                      }),
                                                      jsxRuntime.jsx("span", {
                                                        className:
                                                          "pmwf-profile-workspace",
                                                        children: nodeTypeLabel(
                                                          node.type,
                                                        ),
                                                      }),
                                                    ],
                                                  }),
                                                  jsxRuntime.jsxs("div", {
                                                    className:
                                                      "pmwf-profile-node-meta",
                                                    children: [
                                                      jsxRuntime.jsxs("span", {
                                                        children: [
                                                          "负责人 / 角色：",
                                                          jsxRuntime.jsx("b", {
                                                            children:
                                                              workflowNodeOwnerLabel(
                                                                node,
                                                              ),
                                                          }),
                                                        ],
                                                      }),
                                                      jsxRuntime.jsxs("span", {
                                                        children: [
                                                          "依赖：",
                                                          jsxRuntime.jsx("b", {
                                                            children:
                                                              workflowNodeDependencyLabel(
                                                                node,
                                                                nodes,
                                                                edges,
                                                              ),
                                                          }),
                                                        ],
                                                      }),
                                                      workflowNodeApprovalLabel(
                                                        node,
                                                      )
                                                        ? jsxRuntime.jsxs(
                                                            "span",
                                                            {
                                                              children: [
                                                                "审批逻辑：",
                                                                jsxRuntime.jsx(
                                                                  "b",
                                                                  {
                                                                    children:
                                                                      workflowNodeApprovalLabel(
                                                                        node,
                                                                      ),
                                                                  },
                                                                ),
                                                              ],
                                                            },
                                                          )
                                                        : null,
                                                    ],
                                                  }),
                                                  node.description
                                                    ? jsxRuntime.jsx("p", {
                                                        children:
                                                          node.description,
                                                      })
                                                    : null,
                                                ],
                                              }),
                                            ],
                                          },
                                          node.id,
                                        ),
                                      )
                                    : jsxRuntime.jsx("div", {
                                        className: "pmwf-empty",
                                        children: "尚未定义节点。",
                                      }),
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("section", {
                            className: "pmwf-profile-detail-section",
                            children: [
                              jsxRuntime.jsx("div", {
                                className: "pmwf-profile-preview-title",
                                children: "工作流定义",
                              }),
                              jsxRuntime.jsx("pre", {
                                className: "pmwf-md-pre",
                                children: selected.sourceMd,
                              }),
                            ],
                          }),
                        ],
                      })
                    : jsxRuntime.jsx("div", {
                        className: "pmwf-empty",
                        children: "请选择一个工作流模版。",
                      }),
              }),
            ],
          }),
        ],
      });
    }

    function WorkflowTab(props) {
      const sessionId = props.sessionId;
      const { viewRequest, completeViewRequest } = props;
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [me, setMe] = react.useState(null);
      const [members, setMembers] = react.useState([]);
      const [directoryMembers, setDirectoryMembers] = react.useState([]);
      const [teammates, setTeammates] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      const [workspaceOptions, setWorkspaceOptions] = react.useState([]);
      /** 未按页面范围过滤的完整项目清单：供「新建工作流」弹窗选择项目用。 */
      const [allWorkspaces, setAllWorkspaces] = react.useState([]);
      /**
       * 方案 B：项目清单默认只看"已加入"；平台管理员可切全量视图。
       * 状态来自跨模块共享 store，跳转前后保持同一选择。
       */
      const showAllWorkspaces = react.useSyncExternalStore(
        scopeStore.subscribe,
        scopeStore.getSnapshot,
        scopeStore.getSnapshot,
      );
      const showAllWorkspacesRef = react.useRef(showAllWorkspaces);
      /** 数据范围切换会产生多次并发加载，只允许最后一次结果落到页面。 */
      const loadGeneration = react.useRef(0);
      react.useEffect(() => {
        showAllWorkspacesRef.current = showAllWorkspaces;
      }, [showAllWorkspaces]);
      const [definitions, setDefinitions] = react.useState([]);
      const [instances, setInstances] = react.useState([]);
      const [statusFilters, setStatusFilters] = react.useState(
        // 默认不过滤状态：与任务管理、会议等页面一致，先看到全部记录再按需筛选。
        () => new Set(),
      );
      const [statusMenuOpen, setStatusMenuOpen] = react.useState(false);
      const [query, setQuery] = react.useState("");
      const [searchInput, setSearchInput] = react.useState("");
      const [ownerFilter, setOwnerFilter] = react.useState("all");
      const [openId, setOpenId] = react.useState("");
      const [detail, setDetail] = react.useState(null);
      const [nestedDetails, setNestedDetails] = react.useState({});
      const [busy, setBusy] = react.useState("");
      const [decisionValues, setDecisionValues] = react.useState("{}");
      const [gateForm, setGateForm] = react.useState(null);
      const [tokenVersion, setTokenVersion] = react.useState(0);
      const [deliverableDrafts, setDeliverableDrafts] = react.useState({});
      const [deliverableFiles, setDeliverableFiles] = react.useState({});
      const [startDefinitionId, setStartDefinitionId] = react.useState("");
      const [startWorkspaceId, setStartWorkspaceId] = react.useState("");
      const [startOpen, setStartOpen] = react.useState(false);
      const [startError, setStartError] = react.useState("");
      /** 新建工作流成功后要定位的目标：切项目筛选、列表中选中并打开右侧详情。 */
      const [focusRequest, setFocusRequest] = react.useState(null);
      const [templateMode, setTemplateMode] = react.useState(false);
      const [approvalNote, setApprovalNote] = react.useState("");
      const [agentInterventionNotes, setAgentInterventionNotes] =
        react.useState({});
      const [templatePreview, setTemplatePreview] = react.useState(null);
      /** 流程节点交付物浮层：{ nodeId, left, top }；只读展示，不触发提交。 */
      const [deliveryPopover, setDeliveryPopover] = react.useState(null);
      /** 已展开的节点：默认全部折叠，多个节点可以同时展开。 */
      const [expandedNodeIds, setExpandedNodeIds] = react.useState(
        () => new Set(),
      );
      const toggleNodeExpanded = (nodeId) => {
        setExpandedNodeIds((current) => {
          const next = new Set(current);
          if (next.has(nodeId)) next.delete(nodeId);
          else next.add(nodeId);
          return next;
        });
      };

      const notify = (text) => {
        setError("");
        setNotice(text);
      };
      const fail = (cause) => {
        setNotice("");
        setError(friendly(cause));
      };
      /** 状态反馈条 3 秒后自动消失；整页加载失败（phase=error）时保留提示不自动清。 */
      react.useEffect(() => {
        if (phase !== "ready") return undefined;
        if (notice === "" && error === "") return undefined;
        const timer = window.setTimeout(() => {
          setNotice("");
          setError("");
        }, 3_000);
        return () => window.clearTimeout(timer);
      }, [phase, notice, error]);
      const toggleStatusFilter = (value) => {
        setStatusFilters((current) => {
          const next = new Set(current);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          return next;
        });
      };
      react.useEffect(() => {
        if (!statusMenuOpen) return undefined;
        const close = (event) => {
          if (!event.target.closest?.(".pmwf-status-multi")) {
            setStatusMenuOpen(false);
          }
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
      }, [statusMenuOpen]);
      react.useEffect(() => {
        if (deliveryPopover === null) return undefined;
        const close = (event) => {
          if (
            event.target.closest?.(".pmwf-delivery-popover") ||
            event.target.closest?.(".pmwf-overview-delivery")
          ) {
            return;
          }
          setDeliveryPopover(null);
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
      }, [deliveryPopover]);
      react.useEffect(() => {
        setExpandedNodeIds(new Set());
      }, [openId]);
      // 数据范围切换后，原详情可能已不在列表里：自动回到列表，避免只剩空白页。
      react.useEffect(() => {
        if (openId === "" || instances.length === 0) return;
        if (instances.some((item) => item.id === openId)) return;
        setOpenId("");
        setDetail(null);
        setExpandedNodeIds(new Set());
        setDeliveryPopover(null);
      }, [instances, openId]);
      const memberNames = react.useMemo(
        () =>
          new Map(
            members.map((item) => [item.userId, item.name ?? item.userId]),
          ),
        [members],
      );
      const directoryMemberNames = react.useMemo(
        () =>
          new Map(
            directoryMembers.map((item) => [
              item.userId,
              item.name ?? item.userId,
            ]),
          ),
        [directoryMembers],
      );
      const workspaceById = react.useMemo(
        () => new Map(workspaceOptions.map((item) => [item.id, item])),
        [workspaceOptions],
      );
      /** 解析子流程模板：优先匹配 subworkflowVersion，找不到时回退同 key 的最新定义。 */
      const resolveSubflowDefinition = (node) => {
        const key = node?.subworkflowKey;
        if (key === undefined || key === "") return undefined;
        return (
          definitions.find(
            (item) =>
              item.key === key &&
              (node.subworkflowVersion === undefined ||
                item.version === node.subworkflowVersion),
          ) ?? definitions.find((item) => item.key === key)
        );
      };
      /**
       * 「新建工作流」可选项目：不受页面范围开关影响——管理员可选全部项目，
       * 成员只能选已加入的项目。否则管理员在"仅看已加入"且未加入项目时，
       * 弹窗会因为页面列表为空而两个下拉都是空的。
       */
      const selectableWorkspaces = react.useMemo(
        () =>
          allWorkspaces.filter((item) => item.isMember || me?.role === "admin"),
        [allWorkspaces, me?.role],
      );
      const teammateById = react.useMemo(
        () => new Map(teammates.map((item) => [item.id, item])),
        [teammates],
      );
      const effectiveWorkspaceId = workspaceId;
      const startWorkspace =
        selectableWorkspaces.find((item) => item.id === startWorkspaceId) ??
        selectableWorkspaces.find((item) => item.isMember) ??
        selectableWorkspaces[0] ??
        null;
      const loadWorkspaceIds =
        workspaceId === ""
          ? workspaceOptions.map((item) => item.id)
          : [workspaceId];
      const startDefinitions = definitions.filter(
        (item) => item.status === "active",
      );
      const selectedDefinition =
        startDefinitions.find((item) => item.id === startDefinitionId) ??
        startDefinitions[0];
      const canStart = Boolean(
        (selectedDefinition &&
          ["owner", "member"].includes(me?.workspaceRole ?? "")) ||
        me?.role === "admin",
      );
      const canManage = me?.role === "admin" || me?.workspaceRole === "owner";
      const projectName = (instance) => {
        const workspace = workspaceById.get(instance.workspaceId);
        if (workspace !== undefined) return workspaceName(workspace);
        // 项目不在当前页面范围内时，用服务端随实例下发的项目名兜底，
        // 避免详情/列表退化成显示工作区 UUID。
        const fromServer = instance.workspaceTitle;
        return typeof fromServer === "string" && fromServer !== ""
          ? fromServer
          : instance.workspaceId;
      };
      const creatorName = (instance) =>
        directoryMemberNames.get(instance.createdBy) ?? instance.createdBy;

      react.useEffect(() => {
        if (getToken() === null) {
          setPhase("login");
          return;
        }
        let disposed = false;
        (async () => {
          try {
            const [meResult, workspaceResult] = await Promise.all([
              request("/api/collab/auth/me"),
              request("/api/collab/team/workspaces"),
            ]);
            if (disposed) return;
            setMe(meResult.user);
            const allOptions = workspaceResult.workspaces ?? [];
            const options =
              meResult.user?.role === "admin" &&
              showAllWorkspacesRef.current === true
                ? allOptions
                : allOptions.filter((workspace) => workspace.isMember === true);
            setAllWorkspaces(allOptions);
            setWorkspaceOptions(options);
            // 每次进入工作流页，项目筛选默认「全部项目」；仅外部指定项目时才定位过去。
            const initial =
              options.find((item) => item.id === viewRequest?.workspaceId)
                ?.id ?? "";
            setWorkspaceId(initial);
            setStartWorkspaceId(initial);
            setPhase("ready");
          } catch (cause) {
            if (!disposed) {
              fail(cause);
              if (cause.status === 401) setPhase("login");
              else setPhase("error");
            }
          }
        })();
        return () => {
          disposed = true;
        };
      }, [tokenVersion, showAllWorkspaces]);

      react.useEffect(() => {
        const synchronize = () => {
          setTokenVersion((version) => version + 1);
          setDetail(null);
          setNestedDetails({});
          setOpenId("");
          setBusy("");
          setNotice("");
          setError("");
        };
        window.addEventListener("pluginmax:collab-token", synchronize);
        return () =>
          window.removeEventListener("pluginmax:collab-token", synchronize);
      }, []);

      react.useEffect(() => {
        const returnToRoot = (event) => {
          if (event?.detail?.route !== "workflow") return;
          setOpenId("");
          setDetail(null);
          setNestedDetails({});
          setExpandedNodeIds(new Set());
          setDeliveryPopover(null);
          setTemplateMode(false);
          setTemplatePreview(null);
          setStartOpen(false);
          setStartError("");
          setGateForm(null);
          window.scrollTo({ top: 0, behavior: "auto" });
        };
        window.addEventListener("pluginmax:route-select", returnToRoot);
        return () =>
          window.removeEventListener("pluginmax:route-select", returnToRoot);
      }, []);

      const load = react.useCallback(
        async (silent = true) => {
          const generation = ++loadGeneration.current;
          // 共享模版是全局数据：即使当前页面范围为 0 个项目，
          // 也要为「新建工作流」弹窗把模版列表加载出来。
          const definitionWorkspaceIds = [
            ...new Set(
              [...selectableWorkspaces, ...workspaceOptions].map(
                (workspace) => workspace.id,
              ),
            ),
          ];
          if (
            loadWorkspaceIds.length === 0 &&
            definitionWorkspaceIds.length === 0
          ) {
            setDefinitions([]);
            setInstances([]);
            setMembers([]);
            setDirectoryMembers([]);
            setTeammates([]);
            return;
          }
          try {
            const [definitionResults, results, teammateResult] =
              await Promise.all([
                Promise.all(
                  definitionWorkspaceIds.map((definitionWorkspaceId) =>
                    request(
                      `/api/collab/workflow/definitions?workspaceId=${encodeURIComponent(definitionWorkspaceId)}`,
                    )
                      .then((result) => result.definitions ?? [])
                      .catch(() => []),
                  ),
                ),
                Promise.all(
                  loadWorkspaceIds.map(async (currentWorkspaceId) => {
                    const [instanceResult, memberResult] = await Promise.all([
                      request(
                        `/api/collab/workflow/instances?workspaceId=${encodeURIComponent(currentWorkspaceId)}`,
                      ).catch(() => ({ instances: [] })),
                      request(
                        `/api/collab/team/members?workspaceId=${encodeURIComponent(currentWorkspaceId)}`,
                      ).catch(() => ({ members: [] })),
                    ]);
                    return {
                      workspaceId: currentWorkspaceId,
                      instances: instanceResult.instances ?? [],
                      members: memberResult.members ?? [],
                    };
                  }),
                ),
                // 审批人头像与任务管理页对齐：需要 AI Teammate 的形象图与归属。
                request("/api/collab/teammates").catch(() => ({
                  teammates: [],
                })),
              ]);
            // 范围切换后，旧请求可能晚于新请求返回；丢弃过期结果。
            if (generation !== loadGeneration.current) return;
            setDefinitions(dedupeWorkflowDefinitions(definitionResults.flat()));
            setInstances(results.flatMap((item) => item.instances));
            setDirectoryMembers(results.flatMap((item) => item.members));
            setTeammates(teammateResult.teammates ?? []);
            const memberResult =
              results.find((item) => item.workspaceId === workspaceId) ??
              results[0];
            if (memberResult !== null) {
              setMembers(memberResult.members);
              setMe((current) => {
                if (!current) return current;
                const workspaceRole = memberResult.members.find(
                  (member) => member.userId === current.id,
                )?.memberRole;
                return workspaceRole ? { ...current, workspaceRole } : current;
              });
            }
            if (!silent) notify("已刷新");
          } catch (cause) {
            if (cause.status === 401) setPhase("login");
            if (!silent) fail(cause);
          }
        },
        [
          loadWorkspaceIds.join("|"),
          workspaceId,
          workspaceOptions,
          selectableWorkspaces,
        ],
      );

      react.useEffect(() => {
        const synchronize = async (event) => {
          const detail = event.detail ?? {};
          if (detail.kind === "start-error") {
            setNotice("");
            setError("");
            setStartError(detail.message ?? "操作失败");
            return;
          }
          if (detail.kind === "error") {
            setNotice("");
            setError(detail.message ?? "操作失败");
          } else {
            if (detail.kind === "success") {
              setStartOpen(false);
              const focusWorkspaceId =
                typeof detail.workspaceId === "string"
                  ? detail.workspaceId
                  : "";
              const focusInstanceId =
                typeof detail.instanceId === "string" ? detail.instanceId : "";
              if (focusWorkspaceId !== "" && focusInstanceId !== "") {
                setFocusRequest({
                  workspaceId: focusWorkspaceId,
                  instanceId: focusInstanceId,
                });
              }
            }
            setStartError("");
            setError("");
            setNotice(detail.message ?? "已刷新");
          }
          await load();
        };
        window.addEventListener("pluginmax:workflow-refresh", synchronize);
        return () =>
          window.removeEventListener("pluginmax:workflow-refresh", synchronize);
      }, [load]);

      const loadDetail = react.useCallback(
        async (instanceId, targetWorkspaceId = effectiveWorkspaceId) => {
          if (!instanceId || !targetWorkspaceId) return;
          try {
            const result = await request(
              `/api/collab/workflow/instances/detail?workspaceId=${encodeURIComponent(targetWorkspaceId)}&instanceId=${encodeURIComponent(instanceId)}`,
            );
            setDetail(result);
            return result;
          } catch (cause) {
            fail(cause);
          }
        },
        [effectiveWorkspaceId],
      );

      /**
       * 新建工作流成功后的定位：切到所属项目筛选 → 列表中选中 → 打开右侧详情。
       * 若该项目不在当前范围内（例如管理员处于"仅看已加入"），先切到平台全量。
       */
      react.useEffect(() => {
        if (focusRequest === null) return;
        const target = focusRequest;
        const inOptions = workspaceOptions.some(
          (item) => item.id === target.workspaceId,
        );
        if (!inOptions) {
          // 该项目可能不在当前范围内的项目清单里：管理员先切到平台全量，
          // 然后等异步加载出来的清单包含它再继续；中途不要清掉待定位请求。
          const canReveal =
            me?.role === "admin" &&
            selectableWorkspaces.some((item) => item.id === target.workspaceId);
          if (canReveal && !showAllWorkspaces) {
            scopeStore.setAll(true);
            return;
          }
          if (canReveal) return;
          setFocusRequest(null);
          return;
        }
        if (workspaceId !== target.workspaceId) {
          setWorkspaceId(target.workspaceId);
          return;
        }
        setFocusRequest(null);
        setOpenId(target.instanceId);
        void loadDetail(target.instanceId, target.workspaceId);
      }, [
        focusRequest,
        workspaceOptions,
        workspaceId,
        me?.role,
        showAllWorkspaces,
        selectableWorkspaces,
        loadDetail,
      ]);

      const loadNestedDetail = react.useCallback(
        async (instanceId, targetWorkspaceId = effectiveWorkspaceId) => {
          if (!instanceId || !targetWorkspaceId) return null;
          try {
            const result = await request(
              `/api/collab/workflow/instances/detail?workspaceId=${encodeURIComponent(targetWorkspaceId)}&instanceId=${encodeURIComponent(instanceId)}`,
            );
            setNestedDetails((current) => ({
              ...current,
              [instanceId]: result,
            }));
            return result;
          } catch (cause) {
            fail(cause);
            return null;
          }
        },
        [effectiveWorkspaceId],
      );

      const refreshOpenDetail = react.useCallback(async () => {
        if (!openId) return;
        const instance = instances.find((item) => item.id === openId);
        const targetWorkspaceId = instance?.workspaceId ?? effectiveWorkspaceId;
        const loaded = await loadDetail(openId, targetWorkspaceId);
        if (!loaded) return;
        const childIds = Object.values(loaded.instance.nodes ?? {})
          .map((state) => state.childInstanceId)
          .filter(Boolean);
        await Promise.all(
          childIds.map((childId) =>
            loadNestedDetail(childId, targetWorkspaceId),
          ),
        );
      }, [
        effectiveWorkspaceId,
        instances,
        loadDetail,
        loadNestedDetail,
        openId,
      ]);

      react.useEffect(() => {
        if (phase !== "ready") return;
        // 页面范围为 0 个项目时也要继续 load：共享模版列表要供「新建工作流」弹窗使用。
        if (loadWorkspaceIds.length === 0 && selectableWorkspaces.length === 0)
          return;
        load();
        const timer = setInterval(() => {
          if (document.visibilityState !== "visible") return;
          load();
          refreshOpenDetail();
        }, 8000);
        return () => clearInterval(timer);
      }, [
        load,
        refreshOpenDetail,
        phase,
        loadWorkspaceIds.join("|"),
        selectableWorkspaces,
      ]);

      react.useEffect(() => {
        setDetail(null);
        setGateForm(null);
      }, [effectiveWorkspaceId]);

      const expand = async (instanceId) => {
        // 左列表 + 右详情：点击即选中（再点同一项只是保持，不收起详情）。
        const alreadyLoaded =
          openId === instanceId && detail?.instance?.id === instanceId;
        const next = instanceId;
        setOpenId(next);
        if (alreadyLoaded) return;
        setDetail(null);
        setGateForm(null);
        if (next) {
          const instance = instances.find((item) => item.id === next);
          const targetWorkspaceId =
            instance?.workspaceId ?? effectiveWorkspaceId;
          const loaded = await loadDetail(next, targetWorkspaceId);
          const childIds = Object.values(loaded?.instance?.nodes ?? {})
            .map((state) => state.childInstanceId)
            .filter(Boolean);
          await Promise.all(
            childIds.map((childId) =>
              loadNestedDetail(childId, targetWorkspaceId),
            ),
          );
        }
      };

      react.useEffect(() => {
        if (viewRequest?.view !== "pluginmax-workflow") return;
        const instanceId = String(viewRequest.focus ?? "");
        const requestedWorkspaceId = String(viewRequest.workspaceId ?? "");
        if (requestedWorkspaceId) setWorkspaceId(requestedWorkspaceId);
        if (
          requestedWorkspaceId &&
          requestedWorkspaceId !== effectiveWorkspaceId
        ) {
          return;
        }
        if (instanceId) {
          setStatusFilters(new Set());
          setQuery("");
          const requestedNodeId = String(viewRequest.nodeId ?? "");
          void expand(instanceId).then(() => {
            if (requestedNodeId !== "") {
              setExpandedNodeIds((current) => {
                const next = new Set(current);
                next.add(requestedNodeId);
                return next;
              });
            }
          });
        }
        completeViewRequest?.();
      }, [completeViewRequest, effectiveWorkspaceId, expand, viewRequest]);

      const act = async (key, path, body, message) => {
        if (busy) {
          setError("请等待当前操作完成。");
          return;
        }
        setBusy(key);
        try {
          const result = await request(path, {
            method: "POST",
            body: JSON.stringify(body),
          });
          notify(typeof message === "function" ? message(result) : message);
          await load();
          const loaded = openId ? await loadDetail(openId) : null;
          if (loaded) {
            const childIds = Object.values(loaded.instance.nodes ?? {})
              .map((state) => state.childInstanceId)
              .filter(Boolean);
            await Promise.all(
              childIds.map((childId) => loadNestedDetail(childId)),
            );
          }
          setGateForm(null);
          setDecisionValues("{}");
          setApprovalNote("");
        } catch (cause) {
          fail(cause);
          return false;
        } finally {
          setBusy("");
        }
        return true;
      };

      const openWorkflowTemplateSettings = () => {
        setTemplateMode(true);
        setStartOpen(false);
        setError("");
        setNotice("");
      };

      const setDeliverableDraft = (key, value) =>
        setDeliverableDrafts((current) => ({ ...current, [key]: value }));
      const setAgentInterventionNote = (key, value) =>
        setAgentInterventionNotes((current) => ({ ...current, [key]: value }));
      const setDeliverableFile = (key, files) =>
        setDeliverableFiles((current) => ({ ...current, [key]: files }));
      const submitDeliverable = async (node, requirement) => {
        const key = `${openId}:${node.id}:${requirement.key}`;
        if (busy !== "") return;
        setBusy(`deliverable:${key}`);
        try {
          if (requirement.type === "file") {
            const form = new FormData();
            form.append("instanceId", openId);
            form.append("nodeId", node.id);
            form.append("requirementKey", requirement.key);
            for (const file of deliverableFiles[key] ?? [])
              form.append("files", file, file.name);
            await request("/api/collab/workflow/deliverables/file", {
              method: "POST",
              body: form,
            });
            setDeliverableFile(key, []);
          } else {
            await request(
              `/api/collab/workflow/deliverables/${requirement.type}`,
              {
                method: "POST",
                body: JSON.stringify({
                  instanceId: openId,
                  nodeId: node.id,
                  requirementKey: requirement.key,
                  value: (deliverableDrafts[key] ?? "").trim(),
                }),
              },
            );
          }
          setDeliverableDraft(key, "");
          notify(`已提交「${requirement.title}」`);
          await load();
          await loadDetail(openId);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };
      const downloadDeliverable = async (submissionId, artifactId) => {
        if (busy !== "") return;
        setBusy(`download:${submissionId}`);
        try {
          const token = getToken();
          const query = new URLSearchParams({ submissionId });
          if (artifactId) query.set("artifactId", artifactId);
          const response = await fetch(
            `/api/collab/workflow/deliverables/download?${query}`,
            {
              cache: "no-store",
              headers: token ? { authorization: `Bearer ${token}` } : {},
            },
          );
          if (!response.ok) {
            let message = `HTTP ${response.status}`;
            try {
              const body = await response.json();
              message = body.error?.message ?? message;
            } catch {
              // Keep the HTTP status as the fallback message.
            }
            throw new Error(message);
          }
          const blob = await response.blob();
          const disposition = response.headers.get("content-disposition") ?? "";
          const utfName =
            /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? "";
          const asciiName =
            /filename="([^"]+)"/.exec(disposition)?.[1] ?? "deliverable";
          const fileName = utfName ? decodeURIComponent(utfName) : asciiName;
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
          notify("已下载交付物");
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };
      const rejectDeliverable = async (submissionId, note) => {
        if (busy !== "") return;
        const reason = (note ?? "").trim();
        if (reason === "") return;
        setBusy(`deliverable-reject:${submissionId}`);
        try {
          await request("/api/collab/workflow/deliverables/reject", {
            method: "POST",
            body: JSON.stringify({ submissionId, note: reason }),
          });
          notify("已退回交付物");
          await load();
          await loadDetail(openId);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const pendingApproverKey = (state, actor) => {
        const entries = Object.entries(state.approvals ?? {});
        const serialQueueKey = entries.some(
          ([, approval]) => approval.source === "countersign",
        )
          ? entries.find(([, approval]) => approval.status === "pending")?.[0]
          : undefined;
        return entries.find(([key, approval]) => {
          if (
            approval.status !== "pending" ||
            approval.approver.kind !== "user" ||
            approval.approver.id !== actor?.id
          ) {
            return false;
          }
          return serialQueueKey === undefined || key === serialQueueKey;
        })?.[0];
      };
      const isManager = me?.role === "admin" || me?.workspaceRole === "owner";

      const nestedChildCard = (
        childInstanceId,
        parentCode = "",
        parentDepth = 0,
      ) => {
        const childDetail = nestedDetails[childInstanceId];
        const childInstance = childDetail?.instance;
        const childDefinition = childInstance
          ? definitions.find((item) => item.id === childInstance.definitionId)
          : definitions.find(
              (item) =>
                instances.find((instance) => instance.id === childInstanceId)
                  ?.definitionId === item.id,
            );
        const childStatus =
          childInstance?.status ??
          instances.find((instance) => instance.id === childInstanceId)
            ?.status ??
          "running";
        const childPresentation = workflowNodePresentation(childDefinition, {
          prefix: parentCode,
          depth: parentDepth + 1,
        });
        return jsxRuntime.jsxs("div", {
          className: "pmwf-card pmwf-nested",
          children: [
            jsxRuntime.jsxs("div", {
              className: "pmwf-nested-summary",
              children: [
                jsxRuntime.jsx("span", {
                  className: `pmwf-dot ${pillClass(childStatus)}`,
                }),
                jsxRuntime.jsxs("strong", {
                  children: childInstance?.title ?? "子流程实例加载中…",
                }),
                jsxRuntime.jsx("span", {
                  children: childDefinition
                    ? `${childDefinition.name} v${childDefinition.version}`
                    : "",
                }),
                jsxRuntime.jsx("span", {
                  className: `pmwf-pill ${pillClass(childStatus)}`,
                  children: statusText(childStatus),
                }),
              ],
            }),
            childInstance === undefined
              ? jsxRuntime.jsx("div", {
                  className: "pmwf-note info",
                  children: "加载子流程详情…",
                })
              : jsxRuntime.jsx("ol", {
                  className: "pmwf-nodes",
                  children: (childDefinition?.graph.nodes ?? []).map((node) => {
                    const state = childInstance.nodes[node.id];
                    const childInfo = childPresentation.byId.get(node.id);
                    const approvalKey = pendingApproverKey(state, detail.actor);
                    const actionable =
                      state?.status === "ready" ||
                      (approvalKey !== undefined &&
                        state?.status === "waiting" &&
                        state?.enteredAt !== undefined);
                    const pendingApproverNames =
                      node.type === "approval"
                        ? Object.values(state?.approvals ?? {})
                            .filter((approval) => approval.status === "pending")
                            .map((approval) =>
                              approverLabel(approval.approver, memberNames),
                            )
                            .join("、")
                        : "";
                    return jsxRuntime.jsxs(
                      "li",
                      {
                        className: `pmwf-node ${nodeClass(state)}`,
                        children: [
                          jsxRuntime.jsx("span", {
                            className: "pmwf-state",
                            children: statusText(state?.status ?? "waiting"),
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-node-main",
                            children: [
                              jsxRuntime.jsxs("div", {
                                className: "pmwf-child-title",
                                children: [
                                  jsxRuntime.jsx("span", {
                                    className: "pmwf-child-code",
                                    children: childInfo?.code ?? "",
                                  }),
                                  jsxRuntime.jsx("strong", {
                                    children: node.name,
                                  }),
                                ],
                              }),
                              jsxRuntime.jsx("span", {
                                children: executorLabel(node),
                              }),
                              node.type === "approval"
                                ? jsxRuntime.jsx(WorkflowApprovalList, {
                                    approvals: state?.approvals,
                                    memberNames,
                                    teammateById,
                                  })
                                : null,
                              node.type === "approval" &&
                              actionable &&
                              !approvalKey &&
                              pendingApproverNames
                                ? jsxRuntime.jsx("div", {
                                    className: "pmwf-note info",
                                    children: `当前账号不是该审批的审批人。请切换到 ${pendingApproverNames} 登录，或由当前审批人加签给你。`,
                                  })
                                : null,
                              node.type === "approval" &&
                              actionable &&
                              approvalKey
                                ? jsxRuntime.jsxs("div", {
                                    className: "pmwf-actions",
                                    children: [
                                      jsxRuntime.jsx("button", {
                                        type: "button",
                                        className: "pmwf-btn small",
                                        disabled: busy !== "",
                                        onClick: () =>
                                          act(
                                            `approve:${childInstanceId}:${node.id}`,
                                            "/api/collab/workflow/approvals/decide",
                                            {
                                              instanceId: childInstanceId,
                                              nodeId: node.id,
                                              decision: "approved",
                                              note: approvalNote || undefined,
                                            },
                                            `已通过「${node.name}」`,
                                          ),
                                        children: "通过",
                                      }),
                                      jsxRuntime.jsx("button", {
                                        type: "button",
                                        className: "pmwf-btn secondary small",
                                        disabled: busy !== "",
                                        onClick: () =>
                                          act(
                                            `reject:${childInstanceId}:${node.id}`,
                                            "/api/collab/workflow/approvals/decide",
                                            {
                                              instanceId: childInstanceId,
                                              nodeId: node.id,
                                              decision: "rejected",
                                              note: approvalNote || undefined,
                                            },
                                            `已否决「${node.name}」`,
                                          ),
                                        children: "否决",
                                      }),
                                    ],
                                  })
                                : null,
                            ],
                          }),
                        ],
                      },
                      node.id,
                    );
                  }),
                }),
          ],
        });
      };

      /**
       * 子流程未启动时的模板预览：分支未命中 / 子流程尚未创建实例时，
       * 仍可展开查看内部节点与层级编码。
       */
      const subflowTemplatePreview = (node, parentCode, parentDepth) => {
        const subflowDefinition = resolveSubflowDefinition(node);
        if (subflowDefinition === undefined) {
          return jsxRuntime.jsx("div", {
            className: "pmwf-note info",
            children: "子流程模板暂不可用，无法预览内部节点。",
          });
        }
        const presentation = workflowNodePresentation(subflowDefinition, {
          prefix: parentCode,
          depth: parentDepth + 1,
        });
        return jsxRuntime.jsxs("div", {
          className: "pmwf-card pmwf-nested pmwf-subflow-preview",
          children: [
            jsxRuntime.jsxs("div", {
              className: "pmwf-nested-summary",
              children: [
                jsxRuntime.jsx("span", {
                  className: "pmwf-dot waiting",
                }),
                jsxRuntime.jsxs("strong", {
                  children: [
                    subflowDefinition.name,
                    " v",
                    subflowDefinition.version,
                  ],
                }),
                jsxRuntime.jsxs("span", {
                  children: [
                    String(subflowDefinition.graph.nodes.length),
                    " 个节点",
                  ],
                }),
              ],
            }),
            jsxRuntime.jsx("div", {
              className: "pmwf-note info",
              children:
                "当前分支未命中，子流程尚未启动；以下为子流程模板内容。",
            }),
            jsxRuntime.jsx("ol", {
              className: "pmwf-nodes",
              children: subflowDefinition.graph.nodes.map((childNode) => {
                const childInfo = presentation.byId.get(childNode.id);
                return jsxRuntime.jsxs(
                  "li",
                  {
                    className: "pmwf-node",
                    children: [
                      jsxRuntime.jsxs("div", {
                        className: "pmwf-node-card-head",
                        style: { cursor: "default" },
                        children: [
                          jsxRuntime.jsx("span", {
                            className: "pmwf-node-index",
                            children: childInfo?.code ?? "?",
                          }),
                          jsxRuntime.jsx("h3", {
                            children: childNode.name,
                          }),
                          jsxRuntime.jsx("span", {
                            className: `pmwf-type-tag ${childNode.type}`,
                            children: workflowNodeTypeLabel(childNode.type),
                          }),
                          jsxRuntime.jsx("span", {
                            className: "pmwf-state waiting",
                            style: { marginLeft: "auto" },
                            children: "未启动",
                          }),
                        ],
                      }),
                      childNode.description
                        ? jsxRuntime.jsx("p", {
                            className: "pmwf-node-desc",
                            children: childNode.description,
                          })
                        : null,
                    ],
                  },
                  childNode.id,
                );
              }),
            }),
          ],
        });
      };

      const currentOwnerIds = (instance) => {
        const definition =
          definitions.find(
            (item) => item.definitionId === instance.definitionId,
          ) ?? definitions.find((item) => item.id === instance.definitionId);
        const nodes = new Map(
          (definition?.graph?.nodes ?? []).map((node) => [node.id, node]),
        );
        return new Set(
          Object.entries(instance.nodes ?? {}).flatMap(([nodeId, state]) => {
            if (["completed", "skipped"].includes(state.status)) return [];
            const node = nodes.get(nodeId);
            const ownerId = node?.responsible?.id ?? node?.executor?.id;
            return ownerId === undefined ? [] : [ownerId];
          }),
        );
      };
      const ownerOptions = [];
      const seenOwnerIds = new Set();
      for (const instance of instances) {
        for (const ownerId of currentOwnerIds(instance)) {
          if (seenOwnerIds.has(ownerId)) continue;
          seenOwnerIds.add(ownerId);
          ownerOptions.push({
            id: ownerId,
            name: memberNames.get(ownerId) ?? ownerId,
          });
        }
      }

      const filtered = instances.filter((item) => {
        if (statusFilters.size > 0 && !statusFilters.has(item.status))
          return false;
        if (ownerFilter !== "all" && !currentOwnerIds(item).has(ownerFilter))
          return false;
        if (query.trim() === "") return true;
        const needle = query.trim().toLowerCase();
        const definition =
          definitions.find(
            (candidate) => candidate.definitionId === item.definitionId,
          ) ??
          definitions.find((candidate) => candidate.id === item.definitionId);
        return (
          item.title.toLowerCase().includes(needle) ||
          item.definitionKey.toLowerCase().includes(needle) ||
          (definition?.name ?? "").toLowerCase().includes(needle)
        );
      });
      /** 详情页模式：选中某条实例后整页切到详情，列表与筛选暂时隐藏。 */
      // 只有当前数据范围内仍存在这条实例时才进入详情模式；否则切范围后会只剩空白页。
      const detailMode =
        openId !== "" && instances.some((item) => item.id === openId);

      if (phase === "login") {
        return jsxRuntime.jsx("div", {
          className: "pmwf",
          children: jsxRuntime.jsx("div", {
            className: "pmwf-empty",
            children: "请先在「账号与权限 → 登录账号」登录。",
          }),
        });
      }
      if (phase === "error") {
        return jsxRuntime.jsx("div", {
          className: "pmwf",
          children: jsxRuntime.jsxs("div", {
            className: "pmwf-empty",
            children: [
              error,
              jsxRuntime.jsx("div", {
                style: { marginTop: 10 },
                children: jsxRuntime.jsx("button", {
                  type: "button",
                  className: "pmwf-btn secondary small",
                  onClick: () => {
                    setPhase("loading");
                    setWorkspaceId("");
                    setPhase("ready");
                  },
                  children: "重试",
                }),
              }),
            ],
          }),
        });
      }

      if (templateMode) {
        return jsxRuntime.jsxs("div", {
          className: "pmwf",
          children: [
            jsxRuntime.jsx("style", { children: css }),
            jsxRuntime.jsxs("div", {
              className: "pmwf-page",
              children: [
                jsxRuntime.jsxs("div", {
                  className: "pmwf-page-head",
                  children: [
                    jsxRuntime.jsxs("div", {
                      children: [
                        jsxRuntime.jsx("h1", {
                          children: "工作流模版管理",
                        }),
                      ],
                    }),
                    jsxRuntime.jsx("button", {
                      type: "button",
                      className: "pmwf-btn small",
                      onClick: () => setTemplateMode(false),
                      children: "返回工作流",
                    }),
                  ],
                }),
                jsxRuntime.jsx(WorkflowTemplateManager, {
                  workspaceOptions,
                  currentWorkspaceId: workspaceId,
                  canManage,
                  onClose: () => {
                    setTemplateMode(false);
                    void load(true);
                  },
                }),
              ],
            }),
          ],
        });
      }

      return jsxRuntime.jsxs("div", {
        className: `pmwf${detailMode ? " is-detail-mode" : ""}`,
        children: [
          jsxRuntime.jsx("style", { children: css }),
          jsxRuntime.jsxs("div", {
            className: "pmwf-page",
            children: [
              jsxRuntime.jsxs("div", {
                className: "pmwf-heading",
                children: [
                  jsxRuntime.jsx("h1", { children: "工作流" }),
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-heading-actions",
                    children: [
                      me?.role === "admin"
                        ? jsxRuntime.jsxs("div", {
                            className: "pmwf-scope-seg",
                            role: "group",
                            "aria-label": "项目范围",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: `pmwf-btn${
                                  showAllWorkspaces ? "" : " active"
                                }`,
                                "aria-pressed": !showAllWorkspaces,
                                title: "只看我已加入的项目（默认视图）",
                                onClick: () => {
                                  setOpenId("");
                                  setDetail(null);
                                  setExpandedNodeIds(new Set());
                                  setDeliveryPopover(null);
                                  if (showAllWorkspaces)
                                    scopeStore.setAll(false);
                                },
                                children: "仅看已加入",
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: `pmwf-btn${
                                  showAllWorkspaces ? " active" : ""
                                }`,
                                "aria-pressed": showAllWorkspaces,
                                title: "平台管理员全量视图",
                                onClick: () => {
                                  setOpenId("");
                                  setDetail(null);
                                  setExpandedNodeIds(new Set());
                                  setDeliveryPopover(null);
                                  if (!showAllWorkspaces)
                                    scopeStore.setAll(true);
                                },
                                children: "平台全量",
                              }),
                            ],
                          })
                        : null,
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "pmwf-btn secondary",
                        disabled: busy !== "" || !canManage,
                        title: canManage
                          ? "打开工作流模板管理"
                          : "需要工作区 Owner 或全局管理员权限",
                        onClick: openWorkflowTemplateSettings,
                        children: "模版管理",
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "pmwf-btn",
                        disabled: !canStart || busy !== "",
                        onClick: () => {
                          setStartError("");
                          setStartOpen(true);
                        },
                        children: "新建工作流",
                      }),
                      jsxRuntime.jsx(MeetingPanelToggle, {}),
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsx("div", {
                className: "pmwf-kpis",
                "aria-label": "工作流关键指标",
                children: workflowKpis(instances).map((item) =>
                  jsxRuntime.jsxs(
                    "div",
                    {
                      className: "pmwf-kpi",
                      children: [
                        jsxRuntime.jsx("span", { children: item.label }),
                        jsxRuntime.jsx("strong", {
                          className: item.tone ?? "",
                          children: String(item.value),
                        }),
                        jsxRuntime.jsx("small", { children: item.note }),
                      ],
                    },
                    item.label,
                  ),
                ),
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-toolbar",
                children: [
                  jsxRuntime.jsxs("select", {
                    className: "pmwf-select pmwf-project-filter",
                    value: effectiveWorkspaceId,
                    onChange: (event) => {
                      setWorkspaceId(event.target.value);
                      setStartWorkspaceId(event.target.value);
                      setOpenId("");
                      setDetail(null);
                      setExpandedNodeIds(new Set());
                      setDeliveryPopover(null);
                    },
                    "aria-label": "选择项目",
                    children: [
                      jsxRuntime.jsx("option", {
                        value: "",
                        children: "全部项目",
                      }),
                      ...workspaceOptions.map((item) =>
                        jsxRuntime.jsx(
                          "option",
                          { value: item.id, children: workspaceName(item) },
                          item.id,
                        ),
                      ),
                    ],
                  }),
                  jsxRuntime.jsxs("details", {
                    className: "pmwf-status-multi",
                    open: statusMenuOpen,
                    onToggle: (event) => setStatusMenuOpen(event.target.open),
                    "aria-label": "按状态过滤",
                    children: [
                      jsxRuntime.jsxs("summary", {
                        title: `按状态筛选：${statusFilterLabel(statusFilters)}`,
                        children: [
                          jsxRuntime.jsx("span", {
                            children: `状态：${statusFilterLabel(statusFilters)}`,
                          }),
                          jsxRuntime.jsx(
                            "span",
                            { className: "pmwf-status-multi-arrow" },
                            "▾",
                          ),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        className: "pmwf-status-menu",
                        role: "group",
                        children: [
                          ...workflowStatusFilterValues.map((value) =>
                            jsxRuntime.jsxs(
                              "label",
                              {
                                className: "pmwf-status-option",
                                children: [
                                  jsxRuntime.jsx("input", {
                                    type: "checkbox",
                                    "aria-label": statusText(value),
                                    checked: statusFilters.has(value),
                                    onChange: () => toggleStatusFilter(value),
                                  }),
                                  jsxRuntime.jsx("span", {
                                    children: statusText(value),
                                  }),
                                ],
                              },
                              value,
                            ),
                          ),
                          jsxRuntime.jsx("button", {
                            type: "button",
                            className: "pmwf-btn secondary pmwf-status-clear",
                            onClick: () => setStatusFilters(new Set()),
                            children: "清空筛选",
                          }),
                        ],
                      }),
                    ],
                  }),
                  jsxRuntime.jsxs("select", {
                    className: "pmwf-select pmwf-owner-filter",
                    value: ownerFilter,
                    onChange: (event) => setOwnerFilter(event.target.value),
                    "aria-label": "按当前节点负责人筛选",
                    children: [
                      jsxRuntime.jsx("option", {
                        value: "all",
                        children: "全部负责人",
                      }),
                      ...ownerOptions.map((owner) =>
                        jsxRuntime.jsx(
                          "option",
                          { value: owner.id, children: owner.name },
                          owner.id,
                        ),
                      ),
                    ],
                  }),
                  jsxRuntime.jsx("input", {
                    className: "pmwf-input pmwf-search",
                    value: searchInput,
                    onChange: (event) => setSearchInput(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === "Enter") setQuery(searchInput.trim());
                    },
                    placeholder: "搜索流程标题或模板",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-btn secondary pmwf-search-submit",
                    onClick: () => setQuery(searchInput.trim()),
                    children: "搜索",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-btn secondary small pmwf-toolbar-clear",
                    disabled:
                      statusFilters.size === 0 &&
                      ownerFilter === "all" &&
                      query.trim() === "" &&
                      searchInput.trim() === "",
                    onClick: () => {
                      setStatusFilters(new Set());
                      setOwnerFilter("all");
                      setQuery("");
                      setSearchInput("");
                    },
                    children: "清除筛选",
                  }),
                ],
              }),
              !canStart
                ? jsxRuntime.jsx("div", {
                    className: "pmwf-note info pmwf-toolbar-note",
                    children:
                      "访客不能发起流程；需要工作区成员、负责人或管理员权限。",
                  })
                : null,
              startOpen && canStart
                ? jsxRuntime.jsxs("div", {
                    className: "pmwf-mask",
                    onMouseDown: (event) => {
                      if (event.target === event.currentTarget)
                        setStartOpen(false);
                    },
                    children: [
                      jsxRuntime.jsxs("div", {
                        className: "pmwf-dialog",
                        children: [
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-dialog-head",
                            children: [
                              jsxRuntime.jsx("h3", { children: "新建工作流" }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary small",
                                onClick: () => setStartOpen(false),
                                children: "关闭",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            "data-workspace-id": startWorkspace?.id ?? "",
                            "data-session-id": sessionId ?? "",
                            "data-definition-id": selectedDefinition?.id ?? "",
                            className: "pmwf-form",
                            children: [
                              startError
                                ? jsxRuntime.jsx("div", {
                                    className: "pmwf-note error",
                                    role: "alert",
                                    children: startError,
                                  })
                                : null,
                              jsxRuntime.jsxs("label", {
                                className: "pmwf-dialog-field",
                                children: [
                                  jsxRuntime.jsx("span", {
                                    children: "工作流名称",
                                  }),
                                  jsxRuntime.jsx("input", {
                                    className: "pmwf-input pmwf-start-title",
                                    placeholder: "例如：订单导出功能",
                                    required: true,
                                  }),
                                ],
                              }),
                              jsxRuntime.jsxs("label", {
                                className: "pmwf-dialog-field",
                                children: [
                                  jsxRuntime.jsx("span", {
                                    children: "项目归属",
                                  }),
                                  jsxRuntime.jsxs("select", {
                                    className:
                                      "pmwf-select pmwf-start-definition",
                                    value: startWorkspace?.id ?? "",
                                    onChange: (event) => {
                                      setStartWorkspaceId(event.target.value);
                                      setStartDefinitionId("");
                                    },
                                    children: [
                                      selectableWorkspaces.length === 0
                                        ? jsxRuntime.jsx(
                                            "option",
                                            {
                                              value: "",
                                              children:
                                                "暂无可选项目（你还没有加入任何项目）",
                                            },
                                            "__empty",
                                          )
                                        : null,
                                      ...selectableWorkspaces.map((item) =>
                                        jsxRuntime.jsx(
                                          "option",
                                          {
                                            value: item.id,
                                            children: workspaceName(item),
                                          },
                                          item.id,
                                        ),
                                      ),
                                    ],
                                  }),
                                ],
                              }),
                              jsxRuntime.jsxs("label", {
                                className: "pmwf-dialog-field",
                                children: [
                                  jsxRuntime.jsx("span", {
                                    children: "工作流模版",
                                  }),
                                  jsxRuntime.jsxs("select", {
                                    className: "pmwf-select",
                                    value: selectedDefinition?.id ?? "",
                                    required: true,
                                    onChange: (event) =>
                                      setStartDefinitionId(event.target.value),
                                    children: [
                                      jsxRuntime.jsx("option", {
                                        value: "",
                                        children: "选择流程模版",
                                      }),
                                      ...startDefinitions.map((item) =>
                                        jsxRuntime.jsx(
                                          "option",
                                          {
                                            value: item.id,
                                            children: `${item.name} v${item.version}`,
                                          },
                                          item.id,
                                        ),
                                      ),
                                    ],
                                  }),
                                ],
                              }),
                              selectedDefinition
                                ? jsxRuntime.jsxs("div", {
                                    className: "pmwf-template-preview",
                                    children: [
                                      jsxRuntime.jsx("h4", {
                                        children: "节点预览",
                                      }),
                                      jsxRuntime.jsx("div", {
                                        className: "pmwf-template-preview-list",
                                        children:
                                          selectedDefinition.graph?.nodes
                                            ?.length > 0
                                            ? selectedDefinition.graph.nodes.map(
                                                (node, index, nodes) =>
                                                  jsxRuntime.jsxs(
                                                    "div",
                                                    {
                                                      className: `pmwf-template-preview-node${(selectedDefinition.graph.edges ?? []).filter((edge) => edge.to === node.id).length > 1 ? " branch" : ""}`,
                                                      children: [
                                                        jsxRuntime.jsx("span", {
                                                          className: `pmwf-template-preview-index${(selectedDefinition.graph.edges ?? []).filter((edge) => edge.to === node.id).length > 1 ? " branch" : ""}`,
                                                          children:
                                                            workflowNodeKey(
                                                              nodes,
                                                              index,
                                                            ),
                                                        }),
                                                        jsxRuntime.jsxs("div", {
                                                          className:
                                                            "pmwf-template-preview-main",
                                                          children: [
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-template-preview-title",
                                                                children: [
                                                                  jsxRuntime.jsx(
                                                                    "strong",
                                                                    {
                                                                      children:
                                                                        node.name,
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsx(
                                                                    "span",
                                                                    {
                                                                      className:
                                                                        "pmwf-template-preview-type",
                                                                      children:
                                                                        nodeTypeLabel(
                                                                          node.type,
                                                                        ),
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-template-preview-meta",
                                                                children: [
                                                                  jsxRuntime.jsxs(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        [
                                                                          "负责人 / 角色：",
                                                                          jsxRuntime.jsx(
                                                                            "b",
                                                                            {
                                                                              children:
                                                                                workflowNodeOwnerLabel(
                                                                                  node,
                                                                                ),
                                                                            },
                                                                          ),
                                                                        ],
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsxs(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        [
                                                                          "依赖：",
                                                                          jsxRuntime.jsx(
                                                                            "b",
                                                                            {
                                                                              children:
                                                                                workflowNodeDependencyLabel(
                                                                                  node,
                                                                                  nodes,
                                                                                  selectedDefinition
                                                                                    .graph
                                                                                    .edges,
                                                                                ),
                                                                            },
                                                                          ),
                                                                        ],
                                                                    },
                                                                  ),
                                                                  workflowNodeApprovalLabel(
                                                                    node,
                                                                  ) === ""
                                                                    ? null
                                                                    : jsxRuntime.jsxs(
                                                                        "span",
                                                                        {
                                                                          children:
                                                                            [
                                                                              "审批逻辑：",
                                                                              jsxRuntime.jsx(
                                                                                "b",
                                                                                {
                                                                                  children:
                                                                                    workflowNodeApprovalLabel(
                                                                                      node,
                                                                                    ),
                                                                                },
                                                                              ),
                                                                            ],
                                                                        },
                                                                      ),
                                                                  node.type ===
                                                                  "task"
                                                                    ? jsxRuntime.jsxs(
                                                                        "span",
                                                                        {
                                                                          children:
                                                                            [
                                                                              "完成后：",
                                                                              jsxRuntime.jsx(
                                                                                "b",
                                                                                {
                                                                                  children:
                                                                                    node.reviewRequired ===
                                                                                    false
                                                                                      ? "直接完成"
                                                                                      : "人工Review",
                                                                                },
                                                                              ),
                                                                            ],
                                                                        },
                                                                      )
                                                                    : null,
                                                                ],
                                                              },
                                                            ),
                                                            node.description
                                                              ? jsxRuntime.jsx(
                                                                  "p",
                                                                  {
                                                                    className:
                                                                      "pmwf-template-preview-desc",
                                                                    children:
                                                                      node.description,
                                                                  },
                                                                )
                                                              : null,
                                                          ],
                                                        }),
                                                      ],
                                                    },
                                                    node.id,
                                                  ),
                                              )
                                            : jsxRuntime.jsx("span", {
                                                className: "pmwf-label",
                                                children:
                                                  "该模版暂无可预览节点。",
                                              }),
                                      }),
                                    ],
                                  })
                                : null,
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "pmwf-dialog-actions",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn secondary",
                                onClick: () => setStartOpen(false),
                                children: "取消",
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "pmwf-btn pmwf-start-submit",
                                disabled:
                                  busy === "start" || !selectedDefinition?.id,
                                children: busy === "start" ? "启动中" : "启动",
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  })
                : null,
              jsxRuntime.jsx(Feedback, { error, notice }),
              templatePreview
                ? jsxRuntime.jsx(WorkflowTemplateDialog, {
                    definition: templatePreview,
                    onClose: () => setTemplatePreview(null),
                  })
                : null,
              jsxRuntime.jsxs("div", {
                className: "pmwf-list-head",
                children: [
                  jsxRuntime.jsx("h2", { children: "工作流实例" }),
                  jsxRuntime.jsx("span", {
                    children: `${filtered.length} 个${
                      filtered.length === instances.length
                        ? ""
                        : ` / 共 ${instances.length} 个`
                    }`,
                  }),
                ],
              }),
              filtered.length === 0
                ? jsxRuntime.jsx("div", {
                    className: "pmwf-empty",
                    children:
                      instances.length > 0
                        ? jsxRuntime.jsxs(react.Fragment, {
                            children: [
                              jsxRuntime.jsxs("div", {
                                children: [
                                  "当前筛选条件隐藏了全部 ",
                                  jsxRuntime.jsx("strong", {
                                    children: String(instances.length),
                                  }),
                                  " 条流程实例（状态 / 负责人 / 搜索条件）。",
                                ],
                              }),
                              jsxRuntime.jsx("div", {
                                style: { marginTop: 10 },
                                children: jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "pmwf-btn secondary small",
                                  onClick: () => {
                                    setStatusFilters(new Set());
                                    setOwnerFilter("all");
                                    setQuery("");
                                    setSearchInput("");
                                  },
                                  children: "清空筛选，显示全部",
                                }),
                              }),
                            ],
                          })
                        : workspaceId === ""
                          ? "当前范围内暂无可访问的流程实例。"
                          : "当前项目暂无流程实例。",
                  })
                : jsxRuntime.jsx("div", {
                    className: `pmwf-list${detailMode ? " detail-mode" : ""}`,
                    children: [
                      openId === ""
                        ? jsxRuntime.jsx(
                            "div",
                            {
                              className: "pmwf-placeholder",
                              style: {
                                gridRow: `1 / span ${Math.max(filtered.length, 1)}`,
                              },
                              children:
                                "从左侧列表选择一条流程，这里显示节点、任务与审计详情",
                            },
                            "workflow-placeholder",
                          )
                        : null,
                      ...filtered.map((instance, index) => {
                        const definition =
                          (detail?.instance?.id === instance.id
                            ? detail.definition
                            : undefined) ??
                          definitions.find(
                            (item) =>
                              item.definitionId === instance.definitionId,
                          ) ??
                          definitions.find(
                            (item) => item.id === instance.definitionId,
                          );
                        const nodePresentation =
                          workflowNodePresentation(definition);
                        const isOpen = openId === instance.id;
                        const currentState = currentStates(instance)[0];
                        const currentNode = definition?.graph?.nodes?.find(
                          (node) => node.id === currentState?.nodeId,
                        );
                        const currentDue = currentNode
                          ? workflowNodeDue(currentNode, currentState)
                          : undefined;
                        const currentDueLabel = formatDueLabel(currentDue);
                        return jsxRuntime.jsxs(
                          "article",
                          {
                            className: "pmwf-flow",
                            key: instance.id,
                            children: [
                              jsxRuntime.jsxs("div", {
                                className: `pmwf-summary-row${isOpen ? " active" : ""}`,
                                style: { gridRow: String(index + 1) },
                                children: [
                                  jsxRuntime.jsxs("button", {
                                    type: "button",
                                    className: "pmwf-summary",
                                    "aria-expanded": isOpen,
                                    onClick: () => expand(instance.id),
                                    children: [
                                      jsxRuntime.jsx("span", {
                                        className: `pmwf-dot ${pillClass(instance.status)}`,
                                      }),
                                      jsxRuntime.jsxs("span", {
                                        className: "pmwf-name",
                                        children: [
                                          jsxRuntime.jsxs("span", {
                                            className: "pmwf-title-line",
                                            children: [
                                              jsxRuntime.jsx("strong", {
                                                children: instance.title,
                                              }),
                                              jsxRuntime.jsx(
                                                WorkflowFollowButton,
                                                {
                                                  instanceId: instance.id,
                                                  workspaceId:
                                                    instance.workspaceId,
                                                  iconOnly: true,
                                                },
                                              ),
                                            ],
                                          }),
                                          jsxRuntime.jsxs("span", {
                                            className: "pmwf-current-line",
                                            title: currentDueLabel,
                                            children: [
                                              "当前：",
                                              jsxRuntime.jsx("b", {
                                                children:
                                                  currentNode?.name ??
                                                  (instance.status ===
                                                  "completed"
                                                    ? "流程已完成"
                                                    : "—"),
                                              }),
                                              currentState?.assignedTo
                                                ? ` · ${currentState.assignedTo}`
                                                : "",
                                              currentDueLabel
                                                ? jsxRuntime.jsx("span", {
                                                    className: `pmwf-current-due${workflowDueOverdue(currentDue) ? " overdue" : ""}`,
                                                    children: ` · ${currentDueLabel}`,
                                                  })
                                                : null,
                                            ],
                                          }),
                                        ],
                                      }),
                                      jsxRuntime.jsxs("span", {
                                        className: "pmwf-row-meta",
                                        children: [
                                          jsxRuntime.jsxs("span", {
                                            title: `项目：${projectName(instance)}`,
                                            children: [
                                              "项目：",
                                              projectName(instance),
                                            ],
                                          }),
                                        ],
                                      }),
                                      jsxRuntime.jsx("span", {
                                        className: `pmwf-status-note ${pillClass(instance.status)}`,
                                        children: [
                                          jsxRuntime.jsx("span", {
                                            children: statusText(
                                              instance.status,
                                            ),
                                          }),
                                          jsxRuntime.jsx("span", {
                                            className: "pmwf-status-meta",
                                            title: `更新：${instance.updatedByName ?? creatorName(instance)} ${timeShort(instance.updatedAt)}`,
                                            children: `${instance.updatedByName ?? creatorName(instance)} ${timeShort(instance.updatedAt)}`,
                                          }),
                                        ],
                                      }),
                                      jsxRuntime.jsx("span", {
                                        className: "pmwf-chevron",
                                        "aria-hidden": true,
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              jsxRuntime.jsxs("div", {
                                className: "pmwf-detail open",
                                style: {
                                  display: isOpen ? "block" : "none",
                                  gridRow: detailMode
                                    ? "auto"
                                    : `1 / span ${filtered.length}`,
                                },
                                children: [
                                  jsxRuntime.jsxs("div", {
                                    className: "pmwf-detail-inner",
                                    children: [
                                      jsxRuntime.jsxs("div", {
                                        className: "pmwf-detail-head",
                                        children: [
                                          jsxRuntime.jsxs("div", {
                                            className: "pmwf-detail-title",
                                            children: [
                                              jsxRuntime.jsx("button", {
                                                type: "button",
                                                className:
                                                  "pmwf-btn secondary small pmwf-detail-back",
                                                onClick: () => {
                                                  setOpenId("");
                                                  setDetail(null);
                                                  setDeliveryPopover(null);
                                                },
                                                children: "← 返回",
                                              }),
                                              jsxRuntime.jsxs("span", {
                                                className: "pmwf-crumb",
                                                title: `工作流 / ${instance.title}`,
                                                children: [
                                                  jsxRuntime.jsx("span", {
                                                    className:
                                                      "pmwf-crumb-root",
                                                    children: "工作流 / ",
                                                  }),
                                                  jsxRuntime.jsx("b", {
                                                    children: instance.title,
                                                  }),
                                                ],
                                              }),
                                              jsxRuntime.jsx(
                                                WorkflowFollowButton,
                                                {
                                                  instanceId: instance.id,
                                                  workspaceId:
                                                    instance.workspaceId,
                                                  iconOnly: true,
                                                },
                                              ),
                                            ],
                                          }),
                                          jsxRuntime.jsx("span", {
                                            className: "pmwf-time",
                                            title: `更新时间：${timeShort(instance.updatedAt)}`,
                                            children: `更新 ${timeShort(instance.updatedAt)}`,
                                          }),
                                        ],
                                      }),
                                      jsxRuntime.jsxs("div", {
                                        className: "pmwf-detail-meta",
                                        children: [
                                          jsxRuntime.jsxs("span", {
                                            children: [
                                              "项目：",
                                              jsxRuntime.jsx("b", {
                                                children: projectName(instance),
                                              }),
                                            ],
                                          }),
                                          jsxRuntime.jsxs("span", {
                                            className: "pmwf-detail-meta-right",
                                            children: [
                                              jsxRuntime.jsxs("span", {
                                                children: [
                                                  "创建人：",
                                                  jsxRuntime.jsx("b", {
                                                    children:
                                                      creatorName(instance),
                                                  }),
                                                ],
                                              }),
                                              jsxRuntime.jsxs("span", {
                                                children: [
                                                  "创建时间：",
                                                  jsxRuntime.jsx("b", {
                                                    children: timeShort(
                                                      instance.createdAt,
                                                    ),
                                                  }),
                                                ],
                                              }),
                                            ],
                                          }),
                                        ],
                                      }),
                                      detail?.instance?.id !== instance.id
                                        ? jsxRuntime.jsx("div", {
                                            className: "pmwf-note info",
                                            children: "加载节点详情…",
                                          })
                                        : jsxRuntime.jsxs(react.Fragment, {
                                            children: [
                                              jsxRuntime.jsx(
                                                WorkflowFlowOverview,
                                                {
                                                  definition,
                                                  states: detail.instance.nodes,
                                                  submissions:
                                                    detail.submissions ?? [],
                                                  onTemplateOpen: () =>
                                                    setTemplatePreview(
                                                      definition,
                                                    ),
                                                  onSelectNode:
                                                    toggleNodeExpanded,
                                                  resolveSubflow:
                                                    resolveSubflowDefinition,
                                                  onDeliverableOpen: (
                                                    nodeId,
                                                    rect,
                                                  ) =>
                                                    setDeliveryPopover({
                                                      nodeId,
                                                      left: rect.left,
                                                      top: rect.bottom + 6,
                                                    }),
                                                },
                                              ),
                                              jsxRuntime.jsxs("div", {
                                                className:
                                                  "pmwf-node-section-title",
                                                children: [
                                                  jsxRuntime.jsx("h2", {
                                                    children: "节点详情",
                                                  }),
                                                  jsxRuntime.jsx("span", {
                                                    children: `${(definition?.graph.nodes ?? []).length} 个节点`,
                                                  }),
                                                ],
                                              }),
                                              jsxRuntime.jsx("ol", {
                                                className: "pmwf-nodes",
                                                children: (
                                                  definition?.graph.nodes ?? []
                                                ).map((node) => {
                                                  const state =
                                                    detail.instance.nodes[
                                                      node.id
                                                    ];
                                                  const info =
                                                    nodePresentation.byId.get(
                                                      node.id,
                                                    );
                                                  const expanded =
                                                    expandedNodeIds.has(
                                                      node.id,
                                                    );
                                                  const subflowDefinition =
                                                    node.type === "subworkflow"
                                                      ? resolveSubflowDefinition(
                                                          node,
                                                        )
                                                      : undefined;
                                                  const subflowCount =
                                                    subflowDefinition?.graph
                                                      ?.nodes?.length ?? 0;
                                                  const headlineDelivery =
                                                    workflowDeliverableSummary(
                                                      node,
                                                      state,
                                                      detail.submissions ?? [],
                                                    );
                                                  const approvalKey =
                                                    pendingApproverKey(
                                                      state,
                                                      detail.actor,
                                                    );
                                                  const actionable =
                                                    state?.status === "ready" ||
                                                    (approvalKey !==
                                                      undefined &&
                                                      state?.status ===
                                                        "waiting" &&
                                                      state?.enteredAt !==
                                                        undefined);
                                                  const canCountersign =
                                                    node.type === "approval" &&
                                                    approvalKey !== undefined;
                                                  const pendingApproverNames =
                                                    node.type === "approval"
                                                      ? Object.values(
                                                          state?.approvals ??
                                                            {},
                                                        )
                                                          .filter(
                                                            (approval) =>
                                                              approval.status ===
                                                              "pending",
                                                          )
                                                          .map((approval) =>
                                                            approverLabel(
                                                              approval.approver,
                                                              memberNames,
                                                            ),
                                                          )
                                                          .join("、")
                                                      : "";
                                                  const activeLoopRules =
                                                    loopRules(definition);
                                                  const outgoingLoopRule =
                                                    activeLoopRules.find(
                                                      (rule) =>
                                                        rule.edge.from ===
                                                        node.id,
                                                    );
                                                  const blockedLoopRule =
                                                    triggeredLoopRule(
                                                      activeLoopRules,
                                                      node.id,
                                                      state,
                                                    );
                                                  return jsxRuntime.jsxs(
                                                    "li",
                                                    {
                                                      id: `pmwf-node-${node.id}`,
                                                      className: `pmwf-node ${nodeClass(state)}${info?.join ? " join" : ""}${expanded ? "" : " collapsed"}`,
                                                      children: [
                                                        jsxRuntime.jsxs("div", {
                                                          className:
                                                            "pmwf-node-card-head",
                                                          role: "button",
                                                          tabIndex: 0,
                                                          "aria-expanded":
                                                            expanded,
                                                          onClick: () =>
                                                            toggleNodeExpanded(
                                                              node.id,
                                                            ),
                                                          onKeyDown: (
                                                            event,
                                                          ) => {
                                                            if (
                                                              event.key !==
                                                                "Enter" &&
                                                              event.key !== " "
                                                            ) {
                                                              return;
                                                            }
                                                            event.preventDefault();
                                                            toggleNodeExpanded(
                                                              node.id,
                                                            );
                                                          },
                                                          children: [
                                                            jsxRuntime.jsx(
                                                              "span",
                                                              {
                                                                className:
                                                                  "pmwf-node-index",
                                                                children:
                                                                  info?.code ??
                                                                  "?",
                                                              },
                                                            ),
                                                            jsxRuntime.jsx(
                                                              "h3",
                                                              {
                                                                children:
                                                                  node.name,
                                                              },
                                                            ),
                                                            jsxRuntime.jsxs(
                                                              "span",
                                                              {
                                                                className:
                                                                  "pmwf-node-head-fields",
                                                                children: [
                                                                  jsxRuntime.jsxs(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        [
                                                                          "负责人：",
                                                                          jsxRuntime.jsx(
                                                                            "b",
                                                                            {
                                                                              children:
                                                                                node
                                                                                  .responsible
                                                                                  ?.label ??
                                                                                node
                                                                                  .responsible
                                                                                  ?.id ??
                                                                                executorLabel(
                                                                                  node,
                                                                                ),
                                                                            },
                                                                          ),
                                                                        ],
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsxs(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        [
                                                                          "执行时间：",
                                                                          jsxRuntime.jsx(
                                                                            "b",
                                                                            {
                                                                              children:
                                                                                workflowNodeExecutionTime(
                                                                                  node,
                                                                                  state,
                                                                                ),
                                                                            },
                                                                          ),
                                                                        ],
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsxs(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        [
                                                                          "交付物：",
                                                                          jsxRuntime.jsx(
                                                                            "b",
                                                                            {
                                                                              children:
                                                                                headlineDelivery.total >
                                                                                0
                                                                                  ? `${headlineDelivery.done}/${headlineDelivery.total}`
                                                                                  : "—",
                                                                            },
                                                                          ),
                                                                        ],
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            info?.join
                                                              ? jsxRuntime.jsx(
                                                                  "span",
                                                                  {
                                                                    className:
                                                                      "pmwf-type-tag join",
                                                                    children:
                                                                      "汇合",
                                                                  },
                                                                )
                                                              : null,
                                                            jsxRuntime.jsx(
                                                              "span",
                                                              {
                                                                className: `pmwf-type-tag ${node.type}`,
                                                                children:
                                                                  node.type ===
                                                                    "subworkflow" &&
                                                                  subflowCount >
                                                                    0
                                                                    ? `子流程 · ${subflowCount}`
                                                                    : workflowNodeTypeLabel(
                                                                        node.type,
                                                                      ),
                                                              },
                                                            ),
                                                            info?.branch &&
                                                            info.branchLabel
                                                              ? jsxRuntime.jsx(
                                                                  "span",
                                                                  {
                                                                    className:
                                                                      "pmwf-type-tag branch-condition",
                                                                    title: `进入条件：${info.branchLabel}`,
                                                                    children: `进入条件：${info.branchLabel}`,
                                                                  },
                                                                )
                                                              : null,
                                                            jsxRuntime.jsx(
                                                              "span",
                                                              {
                                                                className: `pmwf-state ${nodeClass(state)}`,
                                                                children:
                                                                  workflowNodeStatusText(
                                                                    node,
                                                                    state,
                                                                  ),
                                                              },
                                                            ),
                                                            jsxRuntime.jsx(
                                                              "span",
                                                              {
                                                                className: `pmwf-node-arrow${expanded ? " open" : ""}`,
                                                                "aria-hidden": true,
                                                                children: "▾",
                                                              },
                                                            ),
                                                          ],
                                                        }),
                                                        jsxRuntime.jsxs("div", {
                                                          className:
                                                            "pmwf-node-facts",
                                                          children: [
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-fact",
                                                                children: [
                                                                  jsxRuntime.jsx(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        "负责人",
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsx(
                                                                    "strong",
                                                                    {
                                                                      children:
                                                                        node
                                                                          .responsible
                                                                          ?.label ??
                                                                        node
                                                                          .responsible
                                                                          ?.id ??
                                                                        executorLabel(
                                                                          node,
                                                                        ),
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-fact",
                                                                children: [
                                                                  jsxRuntime.jsx(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        "实际执行人",
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsx(
                                                                    "strong",
                                                                    {
                                                                      children:
                                                                        state?.assignedTo ??
                                                                        executorLabel(
                                                                          node,
                                                                        ),
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-fact",
                                                                children: [
                                                                  jsxRuntime.jsx(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        "SLA / DDL",
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsx(
                                                                    "strong",
                                                                    {
                                                                      children: `${workflowSlaLabel(node)}${
                                                                        formatDueLabel(
                                                                          workflowNodeDue(
                                                                            node,
                                                                            state,
                                                                          ),
                                                                        )
                                                                          ? ` · ${formatDueLabel(
                                                                              workflowNodeDue(
                                                                                node,
                                                                                state,
                                                                              ),
                                                                            )}`
                                                                          : ""
                                                                      }`,
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                            jsxRuntime.jsxs(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-fact",
                                                                children: [
                                                                  jsxRuntime.jsx(
                                                                    "span",
                                                                    {
                                                                      children:
                                                                        "更新时间",
                                                                    },
                                                                  ),
                                                                  jsxRuntime.jsx(
                                                                    "strong",
                                                                    {
                                                                      children:
                                                                        (state?.completedAt ??
                                                                        state?.enteredAt)
                                                                          ? timeShort(
                                                                              state.completedAt ??
                                                                                state.enteredAt,
                                                                            )
                                                                          : "—",
                                                                    },
                                                                  ),
                                                                ],
                                                              },
                                                            ),
                                                          ],
                                                        }),
                                                        node.description
                                                          ? jsxRuntime.jsx(
                                                              "p",
                                                              {
                                                                className:
                                                                  "pmwf-node-desc",
                                                                children:
                                                                  node.description,
                                                              },
                                                            )
                                                          : null,
                                                        state?.note
                                                          ? jsxRuntime.jsx(
                                                              "div",
                                                              {
                                                                className:
                                                                  "pmwf-note info",
                                                                children:
                                                                  state.note,
                                                              },
                                                            )
                                                          : null,
                                                        jsxRuntime.jsxs("div", {
                                                          className:
                                                            "pmwf-node-main",
                                                          children: [
                                                            outgoingLoopRule
                                                              ? jsxRuntime.jsx(
                                                                  "div",
                                                                  {
                                                                    className:
                                                                      "pmwf-note warning",
                                                                    children:
                                                                      loopHint(
                                                                        outgoingLoopRule,
                                                                        detail.instance,
                                                                      ),
                                                                  },
                                                                )
                                                              : null,
                                                            blockedLoopRule
                                                              ? jsxRuntime.jsx(
                                                                  "div",
                                                                  {
                                                                    className:
                                                                      "pmwf-note error",
                                                                    children:
                                                                      blockedLoopRule.limit ===
                                                                      null
                                                                        ? `循环保护已触发，后续流程阻断。触发条件：${blockedLoopRule.edge.breakCondition}`
                                                                        : `已达到尝试上限：最多尝试 ${blockedLoopRule.limit} 次，后续流程已阻断。`,
                                                                  },
                                                                )
                                                              : null,
                                                            node.type ===
                                                            "subworkflow"
                                                              ? state?.childInstanceId
                                                                ? nestedChildCard(
                                                                    state.childInstanceId,
                                                                    info?.code ??
                                                                      "",
                                                                    info?.depth ??
                                                                      0,
                                                                  )
                                                                : subflowTemplatePreview(
                                                                    node,
                                                                    info?.code ??
                                                                      "",
                                                                    info?.depth ??
                                                                      0,
                                                                  )
                                                              : null,
                                                            node.type ===
                                                            "approval"
                                                              ? jsxRuntime.jsxs(
                                                                  react.Fragment,
                                                                  {
                                                                    children: [
                                                                      jsxRuntime.jsx(
                                                                        "div",
                                                                        {
                                                                          className:
                                                                            "pmwf-node-section-head",
                                                                          children:
                                                                            jsxRuntime.jsx(
                                                                              "strong",
                                                                              {
                                                                                children:
                                                                                  "审批信息",
                                                                              },
                                                                            ),
                                                                        },
                                                                      ),
                                                                      jsxRuntime.jsx(
                                                                        WorkflowApprovalList,
                                                                        {
                                                                          approvals:
                                                                            state?.approvals,
                                                                          memberNames,
                                                                          teammateById,
                                                                        },
                                                                      ),
                                                                    ],
                                                                  },
                                                                )
                                                              : null,
                                                            node.type ===
                                                              "approval" &&
                                                            actionable &&
                                                            !approvalKey &&
                                                            pendingApproverNames
                                                              ? jsxRuntime.jsx(
                                                                  "div",
                                                                  {
                                                                    className:
                                                                      "pmwf-note info",
                                                                    children: `当前账号不是该审批的审批人。请切换到 ${pendingApproverNames} 登录，或由当前审批人加签给你。`,
                                                                  },
                                                                )
                                                              : null,
                                                            node.executor
                                                              .kind ===
                                                              "agent" ||
                                                            node.executor
                                                              .kind ===
                                                              "employee"
                                                              ? AgentRunPanel({
                                                                  node,
                                                                  state,
                                                                  runs: (
                                                                    detail.agentRuns ??
                                                                    []
                                                                  ).filter(
                                                                    (run) =>
                                                                      run.instanceId ===
                                                                        instance.id &&
                                                                      run.nodeId ===
                                                                        node.id,
                                                                  ),
                                                                  busy,
                                                                  act,
                                                                  workspaceId:
                                                                    instance.workspaceId,
                                                                  instanceId:
                                                                    instance.id,
                                                                  actor:
                                                                    detail.actor,
                                                                  isManager,
                                                                  notes:
                                                                    agentInterventionNotes,
                                                                  onNoteChange:
                                                                    setAgentInterventionNote,
                                                                })
                                                              : null,
                                                            jsxRuntime.jsx(
                                                              DeliverablePanel,
                                                              {
                                                                node,
                                                                state,
                                                                detail,
                                                                instance,
                                                                runs: (
                                                                  detail.agentRuns ??
                                                                  []
                                                                ).filter(
                                                                  (run) =>
                                                                    run.instanceId ===
                                                                      instance.id &&
                                                                    run.nodeId ===
                                                                      node.id,
                                                                ),
                                                                isManager,
                                                                busy,
                                                                drafts:
                                                                  deliverableDrafts,
                                                                files:
                                                                  deliverableFiles,
                                                                onDraft:
                                                                  setDeliverableDraft,
                                                                onFile:
                                                                  setDeliverableFile,
                                                                onSubmit:
                                                                  submitDeliverable,
                                                                onDownload:
                                                                  downloadDeliverable,
                                                                onReject:
                                                                  rejectDeliverable,
                                                              },
                                                            ),
                                                            systemServiceHint(
                                                              node,
                                                              state,
                                                              isManager,
                                                            )
                                                              ? jsxRuntime.jsx(
                                                                  "div",
                                                                  {
                                                                    className:
                                                                      "pmwf-note info",
                                                                    children:
                                                                      systemServiceHint(
                                                                        node,
                                                                        state,
                                                                        isManager,
                                                                      ),
                                                                  },
                                                                  "system-service-hint",
                                                                )
                                                              : null,
                                                            actionable
                                                              ? jsxRuntime.jsxs(
                                                                  "div",
                                                                  {
                                                                    className:
                                                                      "pmwf-actions",
                                                                    children: [
                                                                      [
                                                                        "task",
                                                                        "service",
                                                                      ].includes(
                                                                        node.type,
                                                                      )
                                                                        ? jsxRuntime.jsx(
                                                                            "button",
                                                                            {
                                                                              type: "button",
                                                                              className:
                                                                                "pmwf-btn small",
                                                                              disabled:
                                                                                busy !==
                                                                                  "" ||
                                                                                missingDeliverables(
                                                                                  node,
                                                                                  state,
                                                                                )
                                                                                  .length >
                                                                                  0 ||
                                                                                !canCompleteNode(
                                                                                  node,
                                                                                  detail.actor,
                                                                                  isManager,
                                                                                  state,
                                                                                ),
                                                                              onClick:
                                                                                () =>
                                                                                  act(
                                                                                    `complete:${node.id}`,
                                                                                    "/api/collab/workflow/nodes/complete",
                                                                                    {
                                                                                      instanceId:
                                                                                        instance.id,
                                                                                      nodeId:
                                                                                        node.id,
                                                                                    },
                                                                                    `已完成「${node.name}」`,
                                                                                  ),
                                                                              children:
                                                                                completeButtonLabel(
                                                                                  node,
                                                                                  detail.actor,
                                                                                  isManager,
                                                                                  memberNames,
                                                                                  state,
                                                                                ),
                                                                            },
                                                                          )
                                                                        : null,
                                                                      node.type ===
                                                                        "approval" &&
                                                                      approvalKey
                                                                        ? [
                                                                            jsxRuntime.jsx(
                                                                              "input",
                                                                              {
                                                                                type: "text",
                                                                                className:
                                                                                  "pmwf-input small",
                                                                                placeholder:
                                                                                  "审批意见（可选）",
                                                                                value:
                                                                                  approvalNote,
                                                                                onChange:
                                                                                  (
                                                                                    event,
                                                                                  ) =>
                                                                                    setApprovalNote(
                                                                                      event
                                                                                        .target
                                                                                        .value,
                                                                                    ),
                                                                                style:
                                                                                  {
                                                                                    minWidth: 160,
                                                                                    flex: "1 1 120px",
                                                                                  },
                                                                              },
                                                                              "approval-note",
                                                                            ),
                                                                            jsxRuntime.jsx(
                                                                              "button",
                                                                              {
                                                                                type: "button",
                                                                                className:
                                                                                  "pmwf-btn small",
                                                                                disabled:
                                                                                  busy !==
                                                                                  "",
                                                                                onClick:
                                                                                  () =>
                                                                                    act(
                                                                                      `approve:${node.id}`,
                                                                                      "/api/collab/workflow/approvals/decide",
                                                                                      {
                                                                                        instanceId:
                                                                                          instance.id,
                                                                                        nodeId:
                                                                                          node.id,
                                                                                        decision:
                                                                                          "approved",
                                                                                        note:
                                                                                          approvalNote ||
                                                                                          undefined,
                                                                                      },
                                                                                      "已通过审批",
                                                                                    ),
                                                                                children:
                                                                                  "通过",
                                                                              },
                                                                              "approve",
                                                                            ),
                                                                            jsxRuntime.jsx(
                                                                              "button",
                                                                              {
                                                                                type: "button",
                                                                                className:
                                                                                  "pmwf-btn secondary small",
                                                                                disabled:
                                                                                  busy !==
                                                                                  "",
                                                                                onClick:
                                                                                  () =>
                                                                                    act(
                                                                                      `reject:${node.id}`,
                                                                                      "/api/collab/workflow/approvals/decide",
                                                                                      {
                                                                                        instanceId:
                                                                                          instance.id,
                                                                                        nodeId:
                                                                                          node.id,
                                                                                        decision:
                                                                                          "rejected",
                                                                                        note:
                                                                                          approvalNote ||
                                                                                          undefined,
                                                                                      },
                                                                                      "已否决审批",
                                                                                    ),
                                                                                children:
                                                                                  "否决",
                                                                              },
                                                                              "reject",
                                                                            ),
                                                                            jsxRuntime.jsx(
                                                                              "button",
                                                                              {
                                                                                type: "button",
                                                                                className:
                                                                                  "pmwf-btn secondary small",
                                                                                onClick:
                                                                                  () =>
                                                                                    setGateForm(
                                                                                      {
                                                                                        mode: "delegate",
                                                                                        instanceId:
                                                                                          instance.id,
                                                                                        nodeId:
                                                                                          node.id,
                                                                                        toId: "",
                                                                                      },
                                                                                    ),
                                                                                children:
                                                                                  "转交",
                                                                              },
                                                                              "delegate",
                                                                            ),
                                                                          ]
                                                                        : null,
                                                                      node.type ===
                                                                        "approval" &&
                                                                      canCountersign
                                                                        ? jsxRuntime.jsx(
                                                                            "button",
                                                                            {
                                                                              type: "button",
                                                                              className:
                                                                                "pmwf-btn secondary small",
                                                                              onClick:
                                                                                () =>
                                                                                  setGateForm(
                                                                                    {
                                                                                      mode: "countersign",
                                                                                      instanceId:
                                                                                        instance.id,
                                                                                      nodeId:
                                                                                        node.id,
                                                                                      toId: "",
                                                                                    },
                                                                                  ),
                                                                              children:
                                                                                "加签",
                                                                            },
                                                                          )
                                                                        : null,
                                                                      node.type ===
                                                                      "decision"
                                                                        ? jsxRuntime.jsx(
                                                                            "button",
                                                                            {
                                                                              type: "button",
                                                                              className:
                                                                                "pmwf-btn small",
                                                                              onClick:
                                                                                () => {
                                                                                  setDecisionValues(
                                                                                    JSON.stringify(
                                                                                      detail
                                                                                        .instance
                                                                                        .context ??
                                                                                        {},
                                                                                      null,
                                                                                      2,
                                                                                    ),
                                                                                  );
                                                                                  setGateForm(
                                                                                    {
                                                                                      mode: "decision",
                                                                                      instanceId:
                                                                                        instance.id,
                                                                                      nodeId:
                                                                                        node.id,
                                                                                    },
                                                                                  );
                                                                                },
                                                                              children:
                                                                                "录入判断",
                                                                            },
                                                                          )
                                                                        : null,
                                                                    ],
                                                                  },
                                                                )
                                                              : null,
                                                            gateForm?.instanceId ===
                                                              instance.id &&
                                                            gateForm.nodeId ===
                                                              node.id
                                                              ? jsxRuntime.jsxs(
                                                                  "form",
                                                                  {
                                                                    className:
                                                                      "pmwf-form",
                                                                    onSubmit: (
                                                                      event,
                                                                    ) => {
                                                                      event.preventDefault();
                                                                      if (
                                                                        gateForm.mode ===
                                                                        "decision"
                                                                      ) {
                                                                        let values;
                                                                        try {
                                                                          values =
                                                                            JSON.parse(
                                                                              decisionValues,
                                                                            );
                                                                        } catch {
                                                                          setError(
                                                                            '判断结果必须是 JSON，例如 {"complexity":8}',
                                                                          );
                                                                          return;
                                                                        }
                                                                        act(
                                                                          `decision:${node.id}`,
                                                                          "/api/collab/workflow/decisions/resolve",
                                                                          {
                                                                            instanceId:
                                                                              instance.id,
                                                                            nodeId:
                                                                              node.id,
                                                                            values,
                                                                          },
                                                                          "已记录判断",
                                                                        );
                                                                      } else {
                                                                        const target =
                                                                          members.find(
                                                                            (
                                                                              item,
                                                                            ) =>
                                                                              item.userId ===
                                                                              gateForm.toId,
                                                                          );
                                                                        act(
                                                                          `${gateForm.mode}:${node.id}`,
                                                                          `/api/collab/workflow/approvals/${gateForm.mode === "delegate" ? "delegate" : "countersign"}`,
                                                                          {
                                                                            instanceId:
                                                                              instance.id,
                                                                            nodeId:
                                                                              node.id,
                                                                            toId: gateForm.toId,
                                                                            toName:
                                                                              target?.name ??
                                                                              gateForm.toId,
                                                                          },
                                                                          gateForm.mode ===
                                                                            "delegate"
                                                                            ? "已转交审批"
                                                                            : "已加签审批",
                                                                        );
                                                                      }
                                                                    },
                                                                    children: [
                                                                      gateForm.mode ===
                                                                      "decision"
                                                                        ? jsxRuntime.jsx(
                                                                            "textarea",
                                                                            {
                                                                              className:
                                                                                "pmwf-area",
                                                                              rows: 3,
                                                                              value:
                                                                                decisionValues,
                                                                              onChange:
                                                                                (
                                                                                  event,
                                                                                ) =>
                                                                                  setDecisionValues(
                                                                                    event
                                                                                      .target
                                                                                      .value,
                                                                                  ),
                                                                              placeholder:
                                                                                '{"complexity": 8}',
                                                                            },
                                                                          )
                                                                        : jsxRuntime.jsxs(
                                                                            "div",
                                                                            {
                                                                              className:
                                                                                "pmwf-row",
                                                                              children:
                                                                                [
                                                                                  jsxRuntime.jsx(
                                                                                    "span",
                                                                                    {
                                                                                      className:
                                                                                        "pmwf-label",
                                                                                      children:
                                                                                        gateForm.mode ===
                                                                                        "delegate"
                                                                                          ? "转交给"
                                                                                          : "加签人",
                                                                                    },
                                                                                  ),
                                                                                  jsxRuntime.jsxs(
                                                                                    "select",
                                                                                    {
                                                                                      className:
                                                                                        "pmwf-select",
                                                                                      value:
                                                                                        gateForm.toId,
                                                                                      onChange:
                                                                                        (
                                                                                          event,
                                                                                        ) =>
                                                                                          setGateForm(
                                                                                            {
                                                                                              ...gateForm,
                                                                                              toId: event
                                                                                                .target
                                                                                                .value,
                                                                                            },
                                                                                          ),
                                                                                      required: true,
                                                                                      children:
                                                                                        [
                                                                                          jsxRuntime.jsx(
                                                                                            "option",
                                                                                            {
                                                                                              value:
                                                                                                "",
                                                                                              children:
                                                                                                "选择成员",
                                                                                            },
                                                                                          ),
                                                                                          ...members
                                                                                            .filter(
                                                                                              (
                                                                                                item,
                                                                                              ) => {
                                                                                                if (
                                                                                                  item.userId ===
                                                                                                  me?.id
                                                                                                ) {
                                                                                                  return false;
                                                                                                }
                                                                                                const approval =
                                                                                                  state
                                                                                                    ?.approvals?.[
                                                                                                    `${node.id}:${item.userId}`
                                                                                                  ];
                                                                                                return gateForm.mode ===
                                                                                                  "delegate"
                                                                                                  ? approval ===
                                                                                                      undefined
                                                                                                  : approval?.status ===
                                                                                                      "delegated";
                                                                                              },
                                                                                            )
                                                                                            .map(
                                                                                              (
                                                                                                item,
                                                                                              ) =>
                                                                                                jsxRuntime.jsx(
                                                                                                  "option",
                                                                                                  {
                                                                                                    value:
                                                                                                      item.userId,
                                                                                                    children: `${item.name ?? item.userId}${state?.approvals?.[`${node.id}:${item.userId}`]?.status === "delegated" ? "（已转交）" : ""}`,
                                                                                                  },
                                                                                                  item.userId,
                                                                                                ),
                                                                                            ),
                                                                                        ],
                                                                                    },
                                                                                  ),
                                                                                ],
                                                                            },
                                                                          ),
                                                                      jsxRuntime.jsxs(
                                                                        "div",
                                                                        {
                                                                          className:
                                                                            "pmwf-row",
                                                                          children:
                                                                            [
                                                                              jsxRuntime.jsx(
                                                                                "button",
                                                                                {
                                                                                  type: "submit",
                                                                                  className:
                                                                                    "pmwf-btn small",
                                                                                  disabled:
                                                                                    busy !==
                                                                                      "" ||
                                                                                    ((gateForm.mode ===
                                                                                      "delegate" ||
                                                                                      gateForm.mode ===
                                                                                        "countersign") &&
                                                                                      gateForm.toId ===
                                                                                        (me ===
                                                                                        null
                                                                                          ? undefined
                                                                                          : me.id)),
                                                                                  title:
                                                                                    (gateForm.mode ===
                                                                                      "delegate" ||
                                                                                      gateForm.mode ===
                                                                                        "countersign") &&
                                                                                    gateForm.toId ===
                                                                                      (me ===
                                                                                      null
                                                                                        ? undefined
                                                                                        : me.id)
                                                                                      ? gateForm.mode ===
                                                                                        "delegate"
                                                                                        ? "不能转交给自己"
                                                                                        : "不能加签给自己"
                                                                                      : undefined,
                                                                                  children:
                                                                                    "确认",
                                                                                },
                                                                              ),
                                                                              jsxRuntime.jsx(
                                                                                "button",
                                                                                {
                                                                                  type: "button",
                                                                                  className:
                                                                                    "pmwf-btn secondary small",
                                                                                  onClick:
                                                                                    () =>
                                                                                      setGateForm(
                                                                                        null,
                                                                                      ),
                                                                                  children:
                                                                                    "取消",
                                                                                },
                                                                              ),
                                                                            ],
                                                                        },
                                                                      ),
                                                                    ],
                                                                  },
                                                                )
                                                              : null,
                                                          ],
                                                        }),
                                                      ],
                                                    },
                                                    node.id,
                                                  );
                                                }),
                                              }),
                                              (detail.events ?? []).length > 0
                                                ? jsxRuntime.jsxs("div", {
                                                    className: "pmwf-note info",
                                                    children: [
                                                      "最近：",
                                                      detail.events
                                                        .slice(-3)
                                                        .reverse()
                                                        .map(
                                                          (event) =>
                                                            `${event.message}（${timeShort(event.at)}）`,
                                                        )
                                                        .join("；"),
                                                    ],
                                                  })
                                                : null,
                                              instance.status !== "completed" &&
                                              instance.status !== "cancelled"
                                                ? jsxRuntime.jsx("div", {
                                                    className: "pmwf-actions",
                                                    children: jsxRuntime.jsx(
                                                      "button",
                                                      {
                                                        type: "button",
                                                        className:
                                                          "pmwf-btn secondary small",
                                                        disabled:
                                                          busy !== "" ||
                                                          !(
                                                            canManage ||
                                                            instance.createdBy ===
                                                              (me === null
                                                                ? undefined
                                                                : me.id)
                                                          ),
                                                        onClick: () =>
                                                          act(
                                                            `cancel:${instance.id}`,
                                                            "/api/collab/workflow/instances/cancel",
                                                            {
                                                              instanceId:
                                                                instance.id,
                                                            },
                                                            "已取消流程",
                                                          ),
                                                        children: "取消流程",
                                                      },
                                                    ),
                                                  })
                                                : null,
                                            ],
                                          }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          },
                          instance.id,
                        );
                      }),
                    ],
                  }),
            ],
          }),
          deliveryPopover === null || detail?.instance?.id === undefined
            ? null
            : (() => {
                const node = detail.definition?.graph?.nodes?.find(
                  (item) => item.id === deliveryPopover.nodeId,
                );
                if (node === undefined) return null;
                const state =
                  detail.instance.nodes?.[deliveryPopover.nodeId] ?? null;
                const summary = workflowDeliverableSummary(
                  node,
                  state,
                  detail.submissions ?? [],
                );
                const width = Math.min(320, window.innerWidth - 24);
                const left = Math.max(
                  12,
                  Math.min(
                    deliveryPopover.left,
                    window.innerWidth - width - 12,
                  ),
                );
                return jsxRuntime.jsxs("div", {
                  className: "pmwf-delivery-popover",
                  role: "dialog",
                  "aria-label": `${node.name} 交付物清单`,
                  style: {
                    left,
                    top: Math.max(
                      12,
                      Math.min(deliveryPopover.top, window.innerHeight - 320),
                    ),
                  },
                  children: [
                    jsxRuntime.jsx("h4", {
                      children: `${node.name} · 交付物 ${summary.done}/${summary.total}`,
                    }),
                    jsxRuntime.jsx("ul", {
                      children: summary.rows.map((row) =>
                        jsxRuntime.jsxs(
                          "li",
                          {
                            children: [
                              jsxRuntime.jsx("span", {
                                children: row.title,
                              }),
                              jsxRuntime.jsxs("span", {
                                className: row.status,
                                children: [
                                  row.done
                                    ? row.value
                                    : row.status === "rejected"
                                      ? "已退回"
                                      : "待提交",
                                  row.done && row.submittedAt
                                    ? jsxRuntime.jsx("small", {
                                        className: "pmwf-delivery-time",
                                        children: ` · ${workflowDateTime(row.submittedAt)}`,
                                      })
                                    : null,
                                ],
                              }),
                            ],
                          },
                          row.key,
                        ),
                      ),
                    }),
                  ],
                });
              })(),
        ],
      });
    }

    function WorkflowSettings() {
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [currentUser, setCurrentUser] = react.useState(null);
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      /** 方案 B：项目清单默认只看"已加入"；平台管理员可切全量视图。 */
      const showAllWorkspaces = react.useSyncExternalStore(
        scopeStore.subscribe,
        scopeStore.getSnapshot,
        scopeStore.getSnapshot,
      );
      const showAllWorkspacesRef = react.useRef(showAllWorkspaces);
      react.useEffect(() => {
        showAllWorkspacesRef.current = showAllWorkspaces;
      }, [showAllWorkspaces]);
      const [definitions, setDefinitions] = react.useState([]);
      const [sourceMd, setSourceMd] = react.useState("");
      const [validation, setValidation] = react.useState(null);
      const [activate, setActivate] = react.useState(true);
      const [startTitle, setStartTitle] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [showArchived, setShowArchived] = react.useState(false);
      const [selectedDefinitionId, setSelectedDefinitionId] =
        react.useState("");
      const notify = (text) => {
        setError("");
        setNotice(text);
      };
      const fail = (cause) => {
        setNotice("");
        setError(friendly(cause));
      };
      const canManage =
        currentUser?.role === "admin" ||
        workspaces.find((item) => item.id === workspaceId)?.memberRole ===
          "owner";
      const activeDefinition = definitions.find(
        (item) => item.status === "active",
      );
      const activeDefinitions = definitions.filter(
        (item) => item.status === "active",
      );
      const archivedDefinitions = definitions.filter(
        (item) => item.status === "archived",
      );
      const visibleDefinitions = showArchived ? definitions : activeDefinitions;
      const selectedDefinition =
        visibleDefinitions.find((item) => item.id === selectedDefinitionId) ??
        visibleDefinitions[0] ??
        null;

      const load = react.useCallback(
        async (silent = false) => {
          if (getToken() === null) {
            setPhase("login");
            return;
          }
          try {
            const [meResult, workspaceResult] = await Promise.all([
              request("/api/collab/auth/me"),
              request("/api/collab/team/workspaces"),
            ]);
            setCurrentUser(meResult.user);
            const allOptions = workspaceResult.workspaces ?? [];
            const options =
              meResult.user?.role === "admin" &&
              showAllWorkspacesRef.current === true
                ? allOptions
                : allOptions.filter((workspace) => workspace.isMember === true);
            setWorkspaces(options);
            const selected = options.some((item) => item.id === workspaceId)
              ? workspaceId
              : (options[0]?.id ?? "");
            setWorkspaceId(selected);
            if (selected) {
              const result = await request(
                `/api/collab/workflow/definitions?workspaceId=${encodeURIComponent(selected)}`,
              );
              setDefinitions(result.definitions ?? []);
            } else setDefinitions([]);
            if (!silent) notify("已刷新");
            setPhase("ready");
          } catch (cause) {
            if (cause.status === 401) setPhase("login");
            fail(cause);
            setPhase("error");
          }
        },
        [workspaceId],
      );

      react.useEffect(() => {
        load();
      }, [load]);

      react.useEffect(() => {
        if (
          selectedDefinitionId !== "" &&
          visibleDefinitions.some((item) => item.id === selectedDefinitionId)
        ) {
          return;
        }
        setSelectedDefinitionId(visibleDefinitions[0]?.id ?? "");
      }, [selectedDefinitionId, visibleDefinitions]);

      const validate = async () => {
        setBusy("validate");
        try {
          const result = await request(
            "/api/collab/workflow/definitions/validate",
            {
              method: "POST",
              body: JSON.stringify({ workspaceId, sourceMd }),
            },
          );
          setValidation(result);
          if (result.issues.some((issue) => issue.level === "error")) {
            setNotice("");
            setError("校验发现错误");
          } else {
            notify("校验通过");
          }
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const importDefinition = async (event) => {
        event.preventDefault();
        setBusy("import");
        try {
          const result = await request(
            "/api/collab/workflow/definitions/import",
            {
              method: "POST",
              body: JSON.stringify({ workspaceId, sourceMd, activate }),
            },
          );
          setValidation({ graph: result.definition.graph, issues: [] });
          notify(
            `已保存「${result.definition.name}」v${result.definition.version}`,
          );
          await load(true);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const chooseFile = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setSourceMd(String(reader.result ?? ""));
        reader.readAsText(file);
      };

      if (phase === "login")
        return jsxRuntime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)" },
          children: "请先在「账号与权限 → 登录账号」登录。",
        });
      if (phase === "loading")
        return jsxRuntime.jsx("p", {
          style: { color: "var(--dsw-alias-label-secondary)" },
          children: "加载中…",
        });

      return jsxRuntime.jsxs("section", {
        className: "pmwf-section",
        children: [
          jsxRuntime.jsx("style", { children: css }),
          jsxRuntime.jsx("h3", {
            className: "pmwf-title",
            children: "工作流模板管理",
          }),
          jsxRuntime.jsxs("div", {
            className: "pmwf-row",
            children: [
              currentUser?.role === "admin"
                ? jsxRuntime.jsxs("div", {
                    className: "pmwf-scope-seg",
                    role: "group",
                    "aria-label": "项目范围",
                    children: [
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: `pmwf-btn${
                          showAllWorkspaces ? "" : " active"
                        }`,
                        "aria-pressed": !showAllWorkspaces,
                        title: "只看我已加入的项目（默认视图）",
                        onClick: () => {
                          if (showAllWorkspaces) {
                            scopeStore.setAll(false);
                            void load();
                          }
                        },
                        children: "仅看已加入",
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: `pmwf-btn${
                          showAllWorkspaces ? " active" : ""
                        }`,
                        "aria-pressed": showAllWorkspaces,
                        title: "平台管理员全量视图：显示全部项目",
                        onClick: () => {
                          if (!showAllWorkspaces) {
                            scopeStore.setAll(true);
                            void load();
                          }
                        },
                        children: "平台全量",
                      }),
                    ],
                  })
                : null,
              jsxRuntime.jsx("span", {
                className: "pmwf-label",
                children: "工作区",
              }),
              jsxRuntime.jsxs("select", {
                className: "pmwf-select",
                value: workspaceId,
                onChange: (event) => {
                  setWorkspaceId(event.target.value);
                  setValidation(null);
                  setShowArchived(false);
                },
                children: workspaces.map((item) =>
                  jsxRuntime.jsx(
                    "option",
                    { value: item.id, children: workspaceName(item) },
                    item.id,
                  ),
                ),
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "pmwf-iconbtn",
                onClick: () => load(),
                "aria-label": "刷新工作流模版",
                title: "刷新",
                children: jsxRuntime.jsx(RefreshIcon, {}),
              }),
            ],
          }),
          !canManage
            ? jsxRuntime.jsx("div", {
                className: "pmwf-note info",
                children:
                  "流程模板由工作区负责人或全局管理员管理；你可以查看当前工作区模板。",
              })
            : null,
          jsxRuntime.jsx(Feedback, { error, notice }),
          jsxRuntime.jsxs("div", {
            className: "pmwf-template-layout",
            children: [
              jsxRuntime.jsxs("aside", {
                className: "pmwf-template-directory",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "pmwf-template-directory-head",
                    children: [
                      jsxRuntime.jsx("span", { children: "工作流模板" }),
                      jsxRuntime.jsx("span", {
                        children: visibleDefinitions.length,
                      }),
                    ],
                  }),
                  visibleDefinitions.map((item) =>
                    jsxRuntime.jsxs(
                      "button",
                      {
                        type: "button",
                        className: `pmwf-template-item${item.id === selectedDefinition?.id ? " active" : ""}`,
                        onClick: () => setSelectedDefinitionId(item.id),
                        children: [
                          jsxRuntime.jsx("strong", {
                            children: `${item.name} v${item.version}`,
                          }),
                          jsxRuntime.jsx("span", {
                            children: `${item.key} · ${item.status === "active" ? "启用" : "归档"}`,
                          }),
                        ],
                      },
                      item.id,
                    ),
                  ),
                  visibleDefinitions.length === 0
                    ? jsxRuntime.jsx("p", {
                        className: "pmwf-label",
                        children: "当前项目还没有流程模板。",
                      })
                    : null,
                  archivedDefinitions.length > 0
                    ? jsxRuntime.jsx("button", {
                        type: "button",
                        className: "pmwf-btn secondary small",
                        onClick: () => setShowArchived(!showArchived),
                        children: showArchived
                          ? "仅显示启用模板"
                          : `查看已归档 ${archivedDefinitions.length}`,
                      })
                    : null,
                ],
              }),
              jsxRuntime.jsx("div", {
                className: "pmwf-template-editor",
                children: selectedDefinition
                  ? jsxRuntime.jsxs("div", {
                      className: "pmwf-template-summary",
                      children: [
                        jsxRuntime.jsx("h4", {
                          children: `${selectedDefinition.name} v${selectedDefinition.version}`,
                        }),
                        jsxRuntime.jsx("div", {
                          className: "pmwf-template-meta",
                          children: `${selectedDefinition.key} · ${selectedDefinition.status === "active" ? "启用中" : "已归档"} · 更新 ${timeShort(selectedDefinition.updatedAt)}`,
                        }),
                        canManage
                          ? jsxRuntime.jsxs("div", {
                              className: "pmwf-actions-right",
                              children: [
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "pmwf-btn secondary small",
                                  disabled:
                                    busy !== "" ||
                                    selectedDefinition.status === "active",
                                  onClick: async () => {
                                    setBusy(`status:${selectedDefinition.id}`);
                                    try {
                                      await request(
                                        "/api/collab/workflow/definitions/status",
                                        {
                                          method: "POST",
                                          body: JSON.stringify({
                                            workspaceId,
                                            definitionId: selectedDefinition.id,
                                            status: "active",
                                          }),
                                        },
                                      );
                                      notify("已启用模板");
                                      await load(true);
                                    } catch (cause) {
                                      fail(cause);
                                    } finally {
                                      setBusy("");
                                    }
                                  },
                                  children: "启用",
                                }),
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "pmwf-btn secondary small",
                                  disabled:
                                    busy !== "" ||
                                    selectedDefinition.status === "archived",
                                  onClick: async () => {
                                    setBusy(`status:${selectedDefinition.id}`);
                                    try {
                                      await request(
                                        "/api/collab/workflow/definitions/status",
                                        {
                                          method: "POST",
                                          body: JSON.stringify({
                                            workspaceId,
                                            definitionId: selectedDefinition.id,
                                            status: "archived",
                                          }),
                                        },
                                      );
                                      notify("已归档模板");
                                      await load(true);
                                    } catch (cause) {
                                      fail(cause);
                                    } finally {
                                      setBusy("");
                                    }
                                  },
                                  children: "归档",
                                }),
                              ],
                            })
                          : null,
                      ],
                    })
                  : jsxRuntime.jsx("div", {
                      className: "pmwf-empty",
                      children: "选择一个模板查看详情，或在下方导入新版本。",
                    }),
              }),
            ],
          }),
          jsxRuntime.jsxs("form", {
            className: "pmwf-card",
            onSubmit: importDefinition,
            children: [
              jsxRuntime.jsx("h4", {
                style: { margin: 0 },
                children: "导入 Markdown 模板",
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-row",
                children: [
                  jsxRuntime.jsx("input", {
                    type: "file",
                    accept: ".md,.markdown,text/markdown",
                    onChange: chooseFile,
                  }),
                  jsxRuntime.jsxs("label", {
                    className: "pmwf-label",
                    children: [
                      jsxRuntime.jsx("input", {
                        type: "checkbox",
                        checked: activate,
                        onChange: (event) => setActivate(event.target.checked),
                      }),
                      " 保存后启用",
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsx("textarea", {
                className: "pmwf-area",
                rows: 10,
                value: sourceMd,
                onChange: (event) => setSourceMd(event.target.value),
                placeholder: "# 工作流：产品交付",
              }),
              jsxRuntime.jsxs("div", {
                className: "pmwf-row",
                children: [
                  jsxRuntime.jsx("button", {
                    type: "button",
                    className: "pmwf-btn secondary",
                    disabled: !canManage || busy !== "" || sourceMd === "",
                    onClick: validate,
                    children: busy === "validate" ? "校验中" : "校验",
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    className: "pmwf-btn",
                    disabled: !canManage || busy !== "" || sourceMd === "",
                    children: busy === "import" ? "保存中" : "保存新版本",
                  }),
                ],
              }),
              validation
                ? jsxRuntime.jsxs(react.Fragment, {
                    children: [
                      validation.issues.length === 0
                        ? jsxRuntime.jsx("div", {
                            className: "pmwf-note success",
                            children: "没有校验错误或警告。",
                          })
                        : jsxRuntime.jsx("ul", {
                            className: "pmwf-issues",
                            children: validation.issues.map((issue, index) =>
                              jsxRuntime.jsx(
                                "li",
                                {
                                  style: {
                                    color:
                                      issue.level === "error"
                                        ? "#e26d6d"
                                        : "#d99a26",
                                  },
                                  children: issue.message,
                                },
                                `${issue.level}:${index}`,
                              ),
                            ),
                          }),
                      validation.graph
                        ? jsxRuntime.jsxs("div", {
                            className: "pmwf-graph",
                            children: [
                              validation.graph.nodes.map((node) =>
                                jsxRuntime.jsxs(
                                  "div",
                                  {
                                    className: "pmwf-graph-node",
                                    children: [
                                      jsxRuntime.jsx("strong", {
                                        children: node.name,
                                      }),
                                      jsxRuntime.jsx("span", {
                                        className: "pmwf-type",
                                        children: nodeTypeLabel(node.type),
                                      }),
                                    ],
                                  },
                                  node.id,
                                ),
                              ),
                            ],
                          })
                        : null,
                    ],
                  })
                : null,
            ],
          }),
          activeDefinition
            ? jsxRuntime.jsxs("form", {
                className: "pmwf-card",
                onSubmit: async (event) => {
                  event.preventDefault();
                  setBusy("start");
                  try {
                    await request("/api/collab/workflow/instances/start", {
                      method: "POST",
                      body: JSON.stringify({
                        workspaceId,
                        definitionId: activeDefinition.id,
                        title: startTitle,
                      }),
                    });
                    notify("已启动工作流");
                    setStartTitle("");
                  } catch (cause) {
                    fail(cause);
                  } finally {
                    setBusy("");
                  }
                },
                children: [
                  jsxRuntime.jsx("h4", {
                    style: { margin: 0 },
                    children: "从启用模板发起",
                  }),
                  jsxRuntime.jsx("input", {
                    className: "pmwf-input",
                    value: startTitle,
                    onChange: (event) => setStartTitle(event.target.value),
                    placeholder: "实例标题",
                    required: true,
                  }),
                  jsxRuntime.jsx("button", {
                    type: "submit",
                    className: "pmwf-btn",
                    disabled: busy === "start",
                    children: busy === "start" ? "启动中" : "启动",
                  }),
                ],
              })
            : null,
        ],
      });
    }

    /**
     * 工作流关注按钮由 dsh-collab-workbench 提供：服务端持久化、跨页面同步。
     * 该插件未安装时按钮不渲染，工作流页保持原样。
     */
    function WorkflowFollowButton(props) {
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
      return jsxRuntime.jsx("span", {
        className: "pmwf-follow-bare",
        children: jsxRuntime.jsx(Button, {
          type: "workflow",
          id: props.instanceId,
          compact: true,
          iconOnly: true,
          workspaceId: props.workspaceId,
        }),
      });
    }

    function MeetingPanelToggle() {
      const meetingOpen = react.useSyncExternalStore(
        (listener) =>
          window.__pluginmaxMeeting?.subscribe(() =>
            listener(Boolean(window.__pluginmaxMeeting.open)),
          ) ?? (() => {}),
        () => Boolean(window.__pluginmaxMeeting?.open),
      );
      return jsxRuntime.jsx("button", {
        type: "button",
        className: `pmwf-meeting-toggle${meetingOpen ? " active" : ""}`,
        "aria-label": meetingOpen ? "收起会议侧边栏" : "展开会议侧边栏",
        "aria-pressed": meetingOpen,
        title: meetingOpen ? "收起会议侧边栏" : "展开会议侧边栏",
        onClick: () => window.__pluginmaxMeeting?.toggle(),
        children: jsxRuntime.jsxs("svg", {
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          children: [
            jsxRuntime.jsx("path", { d: "m22 8-6 4 6 4V8Z" }),
            jsxRuntime.jsx("rect", {
              x: 2,
              y: 6,
              width: 14,
              height: 12,
              rx: 2,
            }),
          ],
        }),
      });
    }

    function WorkflowGlobalPage(props) {
      const { useShellRoute, ...tabProps } = props;
      const route = useShellRoute?.((state) => state.route);
      const [viewRequest, setViewRequest] = react.useState(null);
      react.useEffect(() => {
        const navigate = (event) => {
          const target = event.detail ?? {};
          if (target.plugin !== "workflow" || !target.instanceId) return;
          setViewRequest({
            view: "pluginmax-workflow",
            focus: target.instanceId,
            workspaceId: target.workspaceId,
            nodeId: target.nodeId,
          });
        };
        window.addEventListener("pluginmax:collab-navigate", navigate);
        return () =>
          window.removeEventListener("pluginmax:collab-navigate", navigate);
      }, []);
      if (route !== "workflow") return null;
      return jsxRuntime.jsx(WorkflowTab, {
        ...tabProps,
        viewRequest,
        completeViewRequest: () => setViewRequest(null),
      });
    }

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      if (!window.__pluginmaxWorkflowStartBound) {
        window.__pluginmaxWorkflowStartBound = true;
        document.addEventListener("click", startWorkflowFromTab);
      }
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          {
            name: "pluginmax.global",
            id: "pluginmax-workflow",
            order: 30,
          },
          WorkflowGlobalPage,
        ),
      );
    };

    return module.exports;
  },
});
