window.__ModuleLoader__.load({
  id: "dsh-collab-shell",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");

    const router = {
      state: {
        // 刷新后的默认落地页：工作台
        route: "workbench",
        // 窄屏（手机）默认收起左侧栏，避免主区被挤到不可用；桌面/平板保持展开。
        leftOpen: typeof window === "undefined" || window.innerWidth >= 600,
        meetingOpen: false,
        meetingWidth: 380,
        detailsOpen: false,
      },
      listeners: new Set(),
      setState(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener(this.state);
      },
      setRoute(route) {
        this.setState({ route });
      },
      setLeftOpen(leftOpen) {
        this.setState({ leftOpen });
      },
      setMeetingOpen(meetingOpen) {
        this.setState({ meetingOpen });
      },
      setMeetingWidth(meetingWidth) {
        this.setState({ meetingWidth });
      },
      setDetailsOpen(detailsOpen) {
        this.setState({ detailsOpen });
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      getSnapshot() {
        return this.state;
      },
    };

    const routeSource = {
      getSnapshot: () => router.state,
      subscribe: (listener) => router.subscribe(listener),
    };

    /**
     * Switches the global route and announces the click. The event fires even
     * when the route is unchanged so a page can return to its root view when
     * its own navigation item is clicked again.
     */
    function selectRoute(route) {
      router.setRoute(route);
      window.dispatchEvent(
        new CustomEvent("pluginmax:route-select", { detail: { route } }),
      );
    }

    window.addEventListener("pluginmax:navigate", (event) => {
      const route = event?.detail?.route;
      if (typeof route === "string" && route !== "") selectRoute(route);
    });

    const DARK_ATTRIBUTE = "data-ds-dark-theme";
    const CONTENT_FONT_SIZE_VARIABLE = "--dsh-content-font-size";

    function applyThemeSnapshot(snapshot) {
      const scheme = snapshot.active.colorScheme;
      document.documentElement.style.colorScheme = scheme;
      if (scheme === "dark") document.body.setAttribute(DARK_ATTRIBUTE, "");
      else document.body.removeAttribute(DARK_ATTRIBUTE);
      document.body.style.setProperty(
        CONTENT_FONT_SIZE_VARIABLE,
        `${snapshot.fontSize}px`,
      );
      for (const name of router.appliedThemeTokens ?? []) {
        document.body.style.removeProperty(name);
      }
      router.appliedThemeTokens = Object.keys(snapshot.active.tokens);
      for (const [name, value] of Object.entries(snapshot.active.tokens)) {
        document.body.style.setProperty(name, value);
      }
    }

    if (!window.__pluginmaxShell) {
      window.__pluginmaxShell = {
        setRoute: (route) => router.setRoute(route),
        setMeetingOpen: (open) => router.setMeetingOpen(open),
        router,
      };
    }

    const useShellState = () =>
      react.useSyncExternalStore(
        router.subscribe.bind(router),
        router.getSnapshot.bind(router),
        router.getSnapshot.bind(router),
      );

    const styles = `
      .pmx-shell{position:fixed;inset:0;z-index:0;display:grid;min-height:0;
        grid-template-columns:264px minmax(0,1fr) 0 0;overflow:hidden;
        background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        font-family:-apple-system,BlinkMacSystemFont,
        "Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
        transition:grid-template-columns .24s ease;}
      .pmx-shell *,.pmx-shell *::before,.pmx-shell *::after{box-sizing:border-box;}
      .pmx-sidebar{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;
        background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));
        border-right:1px solid var(--dsw-alias-border-l3);padding:14px 12px;}
      .pmx-rail-head{display:flex;align-items:center;gap:8px;flex:none;}
      .pmx-brand{flex:1;display:flex;align-items:center;gap:9px;min-width:0;padding:2px;}
      .pmx-brand-logo{flex:none;display:grid;place-items:center;width:30px;height:30px;
        border:1px solid var(--dsw-alias-border-l3);border-radius:8px;
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmx-brand-logo svg{width:18px;height:auto;}
      .pmx-brand-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--dsw-alias-label-primary);font-size:13px;font-weight:650;letter-spacing:0;}
      .pmx-brand-name small{display:block;color:var(--dsw-alias-label-tertiary);
        font-size:10px;font-weight:500;line-height:1.2;}
      .pmx-toggle{width:30px;height:30px;flex:none;display:grid;place-items:center;cursor:pointer;
        border:1px solid var(--dsw-alias-border-l3);border-radius:6px;
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
      .pmx-brand-toggle{display:none;width:38px;height:38px;flex:none;place-items:center;
        border:1px solid var(--dsw-alias-border-l3);border-radius:8px;
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-accent-primary,#4f8ef7);
        cursor:pointer;}
      .pmx-brand-toggle svg{width:22px;height:17px;}
      .pmx-nav{display:grid;gap:2px;margin-top:14px;flex:none;}
      .pmx-nav button{width:100%;min-height:36px;display:flex;align-items:center;gap:9px;
        padding:7px 9px;border:0;border-radius:7px;background:transparent;
        color:var(--dsw-alias-label-secondary);
        font:inherit;font-size:12.5px;text-align:left;cursor:pointer;}
      .pmx-nav button:hover{
        color:var(--dsw-alias-label-primary);
        background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);}
      .pmx-nav button.active{
        color:var(--dsw-alias-label-primary);
        background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent);
        box-shadow:inset 2px 0 0 var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmx-nav svg{width:15px;height:15px;flex:none;}
      .pmx-workspaces{flex:1;min-height:0;margin-top:14px;overflow-y:auto;overflow-x:hidden;
        border-top:1px solid var(--dsw-alias-border-l3);
        padding-top:14px;}
      .pmx-workspaces > *{min-width:0;max-width:100%;}
      .pmx-sidebar-foot{display:flex;align-items:center;gap:6px;flex:none;margin-top:12px;
        padding-top:12px;border-top:1px solid var(--dsw-alias-border-l3);}
      .pmx-account-wrap{position:relative;flex:1;min-width:0;}
      .pmx-account{display:flex;align-items:center;flex:1;min-width:0;gap:8px;padding:7px;
        min-height:42px;border:0;border-radius:7px;background:transparent;
        color:var(--dsw-alias-label-primary);
        font:inherit;text-align:left;cursor:pointer;}
      .pmx-account:hover{background:transparent;}
      .pmx-avatar{flex:none;width:28px;height:28px;display:grid;place-items:center;border-radius:50%;
        background:var(--dsw-alias-accent-primary,#4f8ef7);color:#fff;font-size:9px;font-weight:800;}
      .pmx-account-main{min-width:0;}
      .pmx-account-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:12px;font-weight:650;}
      .pmx-account-role{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
      .pmx-account-menu{position:fixed;left:12px;bottom:62px;z-index:60;width:232px;
        display:grid;gap:3px;padding:7px;border:1px solid var(--dsw-alias-border-l3);
        border-radius:9px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));
        box-shadow:0 16px 38px rgba(0,0,0,.18);}
      .pmx-account-menu-head{display:flex;align-items:center;gap:8px;padding:7px 7px 9px;
        margin-bottom:3px;border-bottom:1px solid var(--dsw-alias-border-l2);}
      .pmx-account-menu-head strong{display:block;font-size:12.5px;}
      .pmx-account-menu-head small{display:block;margin-top:1px;color:var(--dsw-alias-label-tertiary);
        font-size:10.5px;}
      .pmx-account-menu button{width:100%;display:flex;align-items:center;gap:8px;
        padding:8px 9px;border:0;border-radius:6px;background:transparent;
        color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
      .pmx-account-menu button:hover{
        background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);}
      .pmx-account-menu button.danger{color:var(--dsw-alias-state-error-primary,#e5534b);}
      .pmx-auth-layer{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;
        padding:20px;background:rgba(0,0,0,.22);backdrop-filter:blur(2px);}
      .pmx-auth-card{width:min(380px,100%);display:grid;gap:14px;padding:18px;
        border:1px solid var(--dsw-alias-border-l3);border-radius:12px;
        background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));
        box-shadow:0 20px 48px rgba(0,0,0,.22);}
      .pmx-auth-head{display:grid;gap:4px;}
      .pmx-auth-head h3{margin:0;font-size:16px;}
      .pmx-auth-head p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}
      .pmx-auth-card label{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmx-auth-card input{box-sizing:border-box;width:100%;height:36px;
        padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;
        background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
        font:inherit;font-size:13px;}
      .pmx-auth-password{position:relative;}
      .pmx-auth-password input{padding-right:44px;}
      .pmx-auth-password button{position:absolute;right:6px;top:50%;transform:translateY(-50%);
        display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:4px;
        background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;}
      .pmx-auth-password button svg{display:block;width:16px;height:16px;}
      .pmx-auth-password button:hover{color:var(--dsw-alias-label-primary);}
      .pmx-auth-password button:hover{background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent);}
      .pmx-auth-error{color:var(--dsw-alias-state-error-primary,#e5534b);font-size:12px;}
      .pmx-auth-actions{display:flex;justify-content:flex-end;gap:8px;}
      .pmx-auth-actions button{height:36px;padding:0 14px;border-radius:6px;
        border:0.5px solid var(--dsw-alias-border-l3);font:inherit;font-size:13px;
        white-space:nowrap;cursor:pointer;}
      .pmx-auth-actions .primary{border-color:transparent;
        background:var(--dsw-alias-button-primary-fill);
        color:var(--dsw-alias-label-primary-foreground);}
      .pmx-settings-slot{flex:none;}
      .pmx-settings-slot button[aria-haspopup="dialog"]{width:42px !important;height:42px !important;justify-content:center !important;
        padding:0 !important;border:1px solid var(--dsw-alias-border-l3) !important;
        border-radius:7px !important;background:var(--dsw-alias-bg-layer-2) !important;
        color:var(--dsw-alias-label-secondary) !important;}
      .pmx-settings-slot button[aria-haspopup="dialog"] span{display:none !important;}
      .pmx-main{display:flex;flex-direction:column;min-width:0;min-height:0;
        background:var(--dsw-alias-bg-base);}
      .pmx-stage{flex:1;min-height:0;overflow:auto;}
      .pmx-page{min-height:100%;display:flex;flex-direction:column;padding:18px 20px 28px;}
      .pmx-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
      .pmx-page-head h1{margin:0;font-size:18px;line-height:1.3;}
      .pmx-page-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmx-placeholder{margin-top:16px;padding:36px;
        border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;
        color:var(--dsw-alias-label-secondary);text-align:center;font-size:13px;line-height:1.6;}
      .pmx-conversation-host{height:100%;min-height:0;display:flex;flex-direction:column;}
      .pmx-overlay-track{position:relative;min-width:0;min-height:0;overflow:visible;}
      .pmx-meeting-resize{position:absolute;top:0;bottom:0;left:0;z-index:30;width:10px;
        transform:translateX(-5px);cursor:col-resize;touch-action:none;}
      .pmx-meeting-resize::after{content:"";position:absolute;top:50%;left:50%;
        width:12px;height:34px;transform:translate(-50%,-50%);border-radius:8px;
        border:0.5px solid var(--dsw-alias-border-l2);
        background:var(--dsw-alias-button-floating-fill,var(--dsw-alias-bg-layer-1));
        opacity:0.7;transition:opacity .15s ease,background .15s ease;}
      .pmx-meeting-resize:hover::after,
      .pmx-meeting-resize[data-dragging]::after{
        background:var(--dsw-alias-button-floating-hover,var(--dsw-alias-bg-layer-2));opacity:1;}
      .pmx-details-track{position:relative;min-width:0;min-height:0;overflow:hidden;
        border-left:1px solid var(--dsw-alias-border-l3);
        background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmx-shell[data-details-closed] .pmx-details-track{
        visibility:hidden;pointer-events:none;border-left:0;}
      .pmx-shell[data-global-route] .pmx-workspaces [role="treeitem"][aria-selected="true"]{
        color:var(--dsw-alias-label-secondary) !important;
        background:transparent !important;
        box-shadow:none !important;}
      .pmx-shell[data-global-route] .pmx-workspaces [role="treeitem"][aria-selected="true"]:hover{
        color:var(--dsw-alias-label-primary) !important;
        background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent) !important;}
      .pmx-details-content{height:100%;overflow:auto;}
      .pmx-shell[data-left-closed] .pmx-brand,.pmx-shell[data-left-closed] .pmx-nav span,
      .pmx-shell[data-left-closed] .pmx-workspaces,.pmx-shell[data-left-closed] .pmx-account-main{display:none;}
      /* 未登录：不展示项目/会话列表，主界面由登录引导覆盖。 */
      .pmx-shell[data-requires-login] .pmx-workspaces{display:none;}
      .pmx-shell[data-requires-login] .pmx-auth-layer{background:var(--dsw-alias-bg-base);}
      .pmx-shell[data-left-closed] .pmx-nav button{width:42px;height:42px;justify-content:center;
        padding:0;gap:0;}
      .pmx-shell[data-left-closed] .pmx-nav{justify-items:center;margin-top:14px;}
      .pmx-shell[data-left-closed] .pmx-rail-head{justify-content:center;}
      .pmx-shell[data-left-closed] .pmx-rail-head .pmx-brand{display:none;}
      .pmx-shell[data-left-closed] .pmx-brand-toggle{display:grid;}
      .pmx-shell[data-left-closed] .pmx-sidebar{padding:12px 15px;}
      .pmx-shell[data-left-closed] .pmx-sidebar-foot{
        display:grid;justify-items:center;gap:6px;margin-top:auto;padding-top:0;border-top:0;}
      .pmx-shell[data-left-closed] .pmx-account{
        width:42px;flex:none;display:grid;place-items:center;padding:0;justify-items:center;}
      .pmx-shell[data-left-closed] .pmx-account-wrap{width:42px;flex:none;}
      .pmx-shell[data-left-closed] .pmx-toggle{position:absolute;opacity:0;pointer-events:none;}

      @media (max-width:600px){
        /* 手机上全局页优先保证主内容可用：左侧自动收成图标栏。 */
        .pmx-shell[data-global-route]:not([data-meeting-open]){
          grid-template-columns:72px minmax(0,1fr) 0 0 !important;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-brand,
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-nav span,
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-workspaces,
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-account-main{
          display:none;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-sidebar{
          padding:12px 15px;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-nav{
          justify-items:center;margin-top:14px;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-nav button{
          width:42px;height:42px;justify-content:center;padding:0;gap:0;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-sidebar-foot{
          display:grid;justify-items:center;gap:6px;margin-top:auto;
          padding-top:0;border-top:0;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-account{
          width:42px;flex:none;display:grid;place-items:center;padding:0;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-account-wrap{
          width:42px;flex:none;
        }
        .pmx-shell[data-global-route]:not([data-meeting-open]) .pmx-toggle{
          position:absolute;opacity:0;pointer-events:none;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav){
          width:calc(100vw - 16px) !important;height:calc(100vh - 16px) !important;
          max-width:none !important;max-height:none !important;margin:8px !important;
          display:flex !important;flex-direction:column !important;border-radius:10px !important;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav) > nav{
          width:100% !important;height:auto !important;max-height:none !important;
          flex:none !important;display:flex !important;flex-direction:column !important;
          padding:8px 10px !important;border-right:0 !important;
          border-bottom:0.5px solid var(--dsw-alias-border-l2) !important;
          overflow:hidden !important;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav) > nav > div:first-child{
          display:none !important;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav) > nav > div:last-child{
          width:100% !important;display:flex !important;flex-direction:row !important;
          gap:4px !important;overflow-x:auto !important;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav) > nav button{
          width:auto !important;flex:none !important;white-space:nowrap !important;
        }
        div[role="presentation"] > div[role="dialog"]:has(> nav) > div{
          width:100% !important;min-width:0 !important;flex:1 !important;
          overflow:auto !important;padding:14px !important;
        }
      }

      @media (max-width:900px){
        .pmx-shell[data-meeting-open]{
          grid-template-columns:72px minmax(0,1fr) 0
            min(380px,calc(100vw - 312px)) !important;}
        .pmx-shell[data-meeting-open] .pmx-brand,
        .pmx-shell[data-meeting-open] .pmx-nav span,
        .pmx-shell[data-meeting-open] .pmx-workspaces,
        .pmx-shell[data-meeting-open] .pmx-account-main{display:none;}
        .pmx-shell[data-meeting-open] .pmx-sidebar{padding:12px 15px;}
        .pmx-shell[data-meeting-open] .pmx-nav button{
          width:42px;height:42px;justify-content:center;padding:0;gap:0;}
        .pmx-shell[data-meeting-open] .pmx-nav{justify-items:center;margin-top:14px;}
        .pmx-shell[data-meeting-open] .pmx-sidebar-foot{
          display:grid;justify-items:center;gap:6px;margin-top:auto;padding-top:0;border-top:0;}
        .pmx-shell[data-meeting-open] .pmx-account{
          width:42px;flex:none;display:grid;place-items:center;padding:0;justify-items:center;}
        .pmx-shell[data-meeting-open] .pmx-account-wrap{width:42px;flex:none;}
        .pmx-shell[data-meeting-open] .pmx-toggle{position:absolute;opacity:0;pointer-events:none;}
        .pmx-shell[data-meeting-open] .pmx-brand-toggle{display:grid;}
      }
    `;

    const icons = {
      panel: jsxRuntime.jsx("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [
          jsxRuntime.jsx(
            "rect",
            { x: 3, y: 4, width: 18, height: 16, rx: 2 },
            "r",
          ),
          jsxRuntime.jsx("path", { d: "M9 4v16" }, "p"),
        ],
      }),
      brand: jsxRuntime.jsx("svg", {
        viewBox: "0 0 23.16 17.04",
        fill: "none",
        "aria-hidden": true,
        children: jsxRuntime.jsx("path", {
          d: "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z",
          fill: "currentColor",
        }),
      }),
      people: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [
          jsxRuntime.jsx(
            "path",
            { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" },
            "a",
          ),
          jsxRuntime.jsx("circle", { cx: 9, cy: 7, r: 4 }, "b"),
          jsxRuntime.jsx(
            "path",
            { d: "M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" },
            "c",
          ),
        ],
      }),
      task: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [
          jsxRuntime.jsx(
            "path",
            { d: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
            "p",
          ),
        ],
      }),
      workflow: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [
          jsxRuntime.jsx(
            "rect",
            { x: 3, y: 3, width: 7, height: 7, rx: 1 },
            "a",
          ),
          jsxRuntime.jsx(
            "rect",
            { x: 14, y: 14, width: 7, height: 7, rx: 1 },
            "b",
          ),
          jsxRuntime.jsx(
            "path",
            { d: "M10 6h4a2 2 0 0 1 2 2v2M14 18h-4a2 2 0 0 1-2-2v-2" },
            "c",
          ),
        ],
      }),
      meeting: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        children: [
          jsxRuntime.jsx("path", { d: "m22 8-6 4 6 4V8Z" }, "a"),
          jsxRuntime.jsx(
            "rect",
            { x: 2, y: 6, width: 14, height: 12, rx: 2 },
            "b",
          ),
        ],
      }),
      project: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        children: [
          jsxRuntime.jsx(
            "path",
            {
              d: "M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z",
            },
            "a",
          ),
        ],
      }),
      teammate: jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        children: [
          jsxRuntime.jsx(
            "rect",
            { x: 4, y: 7, width: 16, height: 12, rx: 2 },
            "a",
          ),
          jsxRuntime.jsx(
            "path",
            { d: "M9 12h.01M15 12h.01M9 16h6M12 7V3M8 3h8" },
            "b",
          ),
        ],
      }),
    };

    const navItems = [
      { key: "workbench", label: "工作台", icon: icons.people },
      { key: "projects", label: "项目", icon: icons.project },
      { key: "task", label: "任务", icon: icons.task },
      { key: "workflow", label: "工作流", icon: icons.workflow },
      { key: "meetings", label: "沟通", icon: icons.meeting },
      { key: "teammates", label: "AI伙伴", icon: icons.teammate },
    ];

    /**
     * 品牌区文案与 logo：品牌名暂定 “DSH Enterprise+”，logo 复用 DeepSeek 官方
     * fish 标识（几何与上游 ui-primitives 的 FishLogo 一致），后续换品牌时只改这里。
     */
    const BRAND_NAME = "DSH Enterprise+";
    const FISH_LOGO_PATH =
      "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";
    const fishLogo = jsxRuntime.jsx("svg", {
      viewBox: "0 0 23.16 17.04",
      fill: "none",
      "aria-hidden": "true",
      children: jsxRuntime.jsx("path", {
        d: FISH_LOGO_PATH,
        fill: "currentColor",
      }),
    });

    async function requestIdentity(path) {
      const token = window.localStorage.getItem("pluginmax.collab.token");
      const headers = { "cache-control": "no-store" };
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const response = await fetch(path, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function friendlyAuthError(cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "invalid user or password")
        return "用户 ID 或密码不正确。";
      if (message === "account is disabled")
        return "该账号已停用，请联系管理员启用。";
      if (message === "invalid or expired token")
        return "登录状态已过期，请重新登录。";
      return message;
    }

    /** 密码可见性图标：睁眼 = 显示中，闭眼（带斜线）= 已隐藏。 */
    const EyeIcon = ({ off }) =>
      jsxRuntime.jsxs("svg", {
        viewBox: "0 0 24 24",
        width: 16,
        height: 16,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        children: [
          jsxRuntime.jsx("path", {
            d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z",
          }),
          jsxRuntime.jsx("circle", { cx: 12, cy: 12, r: 3 }),
          off ? jsxRuntime.jsx("path", { d: "M4 4l16 16" }) : null,
        ],
      });

    const AccountButton = ({ onOpenAccountManagement, onOpenSettings }) => {
      const [account, setAccount] = react.useState(null);
      const [menuOpen, setMenuOpen] = react.useState(false);
      const [authOpen, setAuthOpen] = react.useState(false);
      const [authMode, setAuthMode] = react.useState("login");
      const [authForm, setAuthForm] = react.useState({
        userId: "",
        password: "",
      });
      const [authPasswordVisible, setAuthPasswordVisible] =
        react.useState(false);
      const [authError, setAuthError] = react.useState("");
      const [authBusy, setAuthBusy] = react.useState(false);
      const wrapRef = react.useRef(null);
      react.useEffect(() => {
        let disposed = false;
        const load = async () => {
          try {
            const status = await requestIdentity("/api/collab/auth/status");
            if (
              !status.initialized ||
              window.localStorage.getItem("pluginmax.collab.token") === null
            ) {
              if (!disposed) setAccount(null);
              return;
            }
            const current = await requestIdentity("/api/collab/auth/me");
            if (!disposed) setAccount(current.user);
          } catch {
            if (!disposed) setAccount(null);
          }
        };
        load();
        const listener = () => load();
        window.addEventListener("pluginmax:collab-token", listener);
        return () => {
          disposed = true;
          window.removeEventListener("pluginmax:collab-token", listener);
        };
      }, []);

      react.useEffect(() => {
        if (!menuOpen) return undefined;
        const close = (event) => {
          if (wrapRef.current?.contains(event.target)) return;
          setMenuOpen(false);
        };
        const closeOnEscape = (event) => {
          if (event.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("pointerdown", close);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
          document.removeEventListener("pointerdown", close);
          document.removeEventListener("keydown", closeOnEscape);
        };
      }, [menuOpen]);

      const clearToken = () => {
        window.localStorage.removeItem("pluginmax.collab.token");
        window.dispatchEvent(new CustomEvent("pluginmax:collab-token"));
      };
      const logout = async () => {
        const token = window.localStorage.getItem("pluginmax.collab.token");
        try {
          if (token !== null) {
            await fetch("/api/collab/auth/logout", {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
            });
          }
        } finally {
          clearToken();
          setAccount(null);
          setMenuOpen(false);
        }
      };
      const openAuth = (mode) => {
        setAuthMode(mode);
        setAuthForm({ userId: "", password: "" });
        setAuthPasswordVisible(false);
        setAuthError("");
        setAuthOpen(true);
        setMenuOpen(false);
      };
      const submitAuth = async (event) => {
        event.preventDefault();
        if (authBusy) return;
        setAuthBusy(true);
        setAuthError("");
        try {
          const response = await fetch("/api/collab/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(authForm),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
          }
          window.localStorage.setItem("pluginmax.collab.token", body.token);
          window.dispatchEvent(new CustomEvent("pluginmax:collab-token"));
          setAccount(body.user);
          setAuthOpen(false);
          setAuthForm({ userId: "", password: "" });
          setAuthPasswordVisible(false);
        } catch (cause) {
          setAuthError(friendlyAuthError(cause));
        } finally {
          setAuthBusy(false);
        }
      };

      const name = account?.name ?? "未登录";
      const role = account?.role === "admin" ? "管理员" : "成员";
      const initials = (account?.name ?? "?").slice(0, 2).toUpperCase();
      return jsxRuntime.jsxs("div", {
        ref: wrapRef,
        className: "pmx-account-wrap",
        children: [
          jsxRuntime.jsxs("button", {
            type: "button",
            className: "pmx-account",
            title: `${name} · ${account ? role : "在设置中登录"}`,
            "aria-haspopup": "menu",
            "aria-expanded": menuOpen,
            onClick: () => setMenuOpen((open) => !open),
            children: [
              jsxRuntime.jsx("span", {
                className: "pmx-avatar",
                children: initials,
              }),
              jsxRuntime.jsxs("span", {
                className: "pmx-account-main",
                children: [
                  jsxRuntime.jsx("span", {
                    className: "pmx-account-name",
                    children: name,
                  }),
                  jsxRuntime.jsx("span", {
                    className: "pmx-account-role",
                    children: account ? role : "登录账号",
                  }),
                ],
              }),
            ],
          }),
          menuOpen
            ? jsxRuntime.jsxs("div", {
                className: "pmx-account-menu",
                role: "menu",
                children: [
                  account
                    ? jsxRuntime.jsxs("div", {
                        className: "pmx-account-menu-head",
                        children: [
                          jsxRuntime.jsx("span", {
                            className: "pmx-avatar",
                            children: initials,
                          }),
                          jsxRuntime.jsxs("span", {
                            children: [
                              jsxRuntime.jsx("strong", { children: name }),
                              jsxRuntime.jsxs("small", {
                                children: [account.id, " · ", role],
                              }),
                            ],
                          }),
                        ],
                      })
                    : null,
                  jsxRuntime.jsxs("button", {
                    type: "button",
                    role: "menuitem",
                    onClick: () => {
                      onOpenAccountManagement();
                      setMenuOpen(false);
                    },
                    children: account ? "账号设置" : "登录账号",
                  }),
                  account
                    ? jsxRuntime.jsx("button", {
                        type: "button",
                        role: "menuitem",
                        onClick: () => {
                          openAuth("switch");
                        },
                        children: "切换账号",
                      })
                    : null,
                  account
                    ? jsxRuntime.jsx("button", {
                        type: "button",
                        role: "menuitem",
                        className: "danger",
                        onClick: () => {
                          void logout();
                        },
                        children: "退出登录",
                      })
                    : null,
                  jsxRuntime.jsx("button", {
                    type: "button",
                    role: "menuitem",
                    onClick: () => {
                      setMenuOpen(false);
                      onOpenSettings();
                    },
                    children: "打开设置",
                  }),
                ],
              })
            : null,
          authOpen
            ? jsxRuntime.jsx("div", {
                className: "pmx-auth-layer",
                onMouseDown: (event) => {
                  if (event.target === event.currentTarget) setAuthOpen(false);
                },
                children: jsxRuntime.jsxs("form", {
                  className: "pmx-auth-card",
                  onSubmit: submitAuth,
                  children: [
                    jsxRuntime.jsxs("div", {
                      className: "pmx-auth-head",
                      children: [
                        jsxRuntime.jsx("h3", {
                          children:
                            authMode === "switch" ? "切换账号" : "登录账号",
                        }),
                        jsxRuntime.jsx("p", {
                          children:
                            authMode === "switch"
                              ? `新账号登录成功前，当前账号「${name}」仍然保持登录。`
                              : "使用 Pluginmax 用户 ID 和密码登录。",
                        }),
                      ],
                    }),
                    jsxRuntime.jsxs("label", {
                      children: [
                        "用户 ID",
                        jsxRuntime.jsx("input", {
                          autoFocus: true,
                          autoComplete: "username",
                          value: authForm.userId,
                          onChange: (event) =>
                            setAuthForm((current) => ({
                              ...current,
                              userId: event.target.value,
                            })),
                        }),
                      ],
                    }),
                    jsxRuntime.jsxs("label", {
                      children: [
                        "密码",
                        jsxRuntime.jsxs("span", {
                          className: "pmx-auth-password",
                          children: [
                            jsxRuntime.jsx("input", {
                              type: authPasswordVisible ? "text" : "password",
                              autoComplete: "current-password",
                              value: authForm.password,
                              onChange: (event) =>
                                setAuthForm((current) => ({
                                  ...current,
                                  password: event.target.value,
                                })),
                            }),
                            jsxRuntime.jsx("button", {
                              type: "button",
                              "aria-label": authPasswordVisible
                                ? "隐藏密码"
                                : "显示密码",
                              title: authPasswordVisible
                                ? "隐藏密码"
                                : "显示密码",
                              onClick: () =>
                                setAuthPasswordVisible((visible) => !visible),
                              children: jsxRuntime.jsx(EyeIcon, {
                                off: !authPasswordVisible,
                              }),
                            }),
                          ],
                        }),
                      ],
                    }),
                    authError === ""
                      ? null
                      : jsxRuntime.jsx("div", {
                          className: "pmx-auth-error",
                          children: authError,
                        }),
                    jsxRuntime.jsxs("div", {
                      className: "pmx-auth-actions",
                      children: [
                        jsxRuntime.jsx("button", {
                          type: "button",
                          onClick: () => {
                            setAuthOpen(false);
                            setAuthPasswordVisible(false);
                          },
                          children: "取消",
                        }),
                        jsxRuntime.jsx("button", {
                          type: "submit",
                          className: "primary",
                          disabled:
                            authBusy ||
                            authForm.userId === "" ||
                            authForm.password === "",
                          children: authBusy
                            ? "处理中…"
                            : authMode === "switch"
                              ? "登录并切换"
                              : "登录",
                        }),
                      ],
                    }),
                  ],
                }),
              })
            : null,
        ],
      });
    };

    /**
     * 未登录时的登录引导：挡住主界面，避免在未登录状态下展示项目/会话/协作数据。
     */
    const LoginGate = ({ initialized }) => {
      const [userId, setUserId] = react.useState("");
      const [password, setPassword] = react.useState("");
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [showPassword, setShowPassword] = react.useState(false);
      const submit = async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const response = await fetch("/api/collab/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: userId.trim(), password }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
          }
          window.localStorage.setItem("pluginmax.collab.token", body.token);
          window.dispatchEvent(new CustomEvent("pluginmax:collab-token"));
        } catch (cause) {
          setError(friendlyAuthError(cause));
        } finally {
          setBusy(false);
        }
      };
      return jsxRuntime.jsx("div", {
        className: "pmx-auth-layer",
        children: jsxRuntime.jsxs("form", {
          className: "pmx-auth-card",
          onSubmit: submit,
          children: [
            jsxRuntime.jsxs("div", {
              className: "pmx-auth-head",
              children: [
                jsxRuntime.jsx("h3", { children: "登录协作账号" }),
                jsxRuntime.jsx("p", {
                  children: initialized
                    ? "登录后即可查看项目、会话与协作数据。"
                    : "平台账号尚未初始化：请先用管理员账号在「设置 → 账号与权限 → 登录账号」完成首次创建，然后再登录。",
                }),
              ],
            }),
            jsxRuntime.jsxs("label", {
              children: [
                "用户 ID",
                jsxRuntime.jsx("input", {
                  autoFocus: true,
                  autoComplete: "username",
                  value: userId,
                  onChange: (event) => setUserId(event.target.value),
                }),
              ],
            }),
            jsxRuntime.jsxs("label", {
              children: [
                "密码",
                jsxRuntime.jsxs("span", {
                  className: "pmx-auth-password",
                  children: [
                    jsxRuntime.jsx("input", {
                      type: showPassword ? "text" : "password",
                      autoComplete: "current-password",
                      value: password,
                      onChange: (event) => setPassword(event.target.value),
                    }),
                    jsxRuntime.jsx("button", {
                      type: "button",
                      "aria-label": showPassword ? "隐藏密码" : "显示密码",
                      title: showPassword ? "隐藏密码" : "显示密码",
                      onClick: () => setShowPassword((visible) => !visible),
                      children: jsxRuntime.jsx(EyeIcon, { off: !showPassword }),
                    }),
                  ],
                }),
              ],
            }),
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
                  type: "submit",
                  className: "primary",
                  disabled: busy || userId.trim() === "" || password === "",
                  children: busy ? "登录中…" : "登录",
                }),
              ],
            }),
          ],
        }),
      });
    };

    const Sidebar = ({ renderSlot }) => {
      const shell = useShellState();
      const settingsHost = react.useRef(null);
      const openSettings = (sectionLabel, tabId) => {
        const button = settingsHost.current?.querySelector(
          'button[aria-haspopup="dialog"]',
        );
        button?.click();
        if (sectionLabel !== undefined) {
          let attempts = 0;
          const selectSection = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const section = Array.from(
              dialog?.querySelectorAll("button") ?? [],
            ).find(
              (candidate) => candidate.textContent?.trim() === sectionLabel,
            );
            if (section !== undefined) {
              section.click();
              if (tabId !== undefined) {
                window.localStorage.setItem(
                  "pluginmax.accountAccess.activeTab",
                  tabId,
                );
                requestAnimationFrame(() => {
                  window.dispatchEvent(
                    new CustomEvent("pluginmax:account-access-tab", {
                      detail: { tabId },
                    }),
                  );
                });
              }
              return;
            }
            attempts += 1;
            if (attempts < 20) requestAnimationFrame(selectSection);
          };
          requestAnimationFrame(selectSection);
        }
      };
      return jsxRuntime.jsxs("aside", {
        className: "pmx-sidebar",
        "aria-label": "主导航",
        children: [
          jsxRuntime.jsxs("div", {
            className: "pmx-rail-head",
            children: [
              jsxRuntime.jsxs("div", {
                className: "pmx-brand",
                title: BRAND_NAME,
                children: [
                  jsxRuntime.jsx("span", {
                    className: "pmx-brand-logo",
                    children: fishLogo,
                  }),
                  jsxRuntime.jsxs("span", {
                    className: "pmx-brand-name",
                    children: BRAND_NAME,
                  }),
                ],
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "pmx-toggle",
                "aria-label": "折叠左侧栏",
                onClick: () => router.setLeftOpen(false),
                children: icons.panel,
              }),
              jsxRuntime.jsx("button", {
                type: "button",
                className: "pmx-brand-toggle",
                "aria-label": "展开左侧栏",
                title: "展开左侧栏",
                onClick: () => router.setLeftOpen(true),
                children: icons.brand,
              }),
            ],
          }),
          jsxRuntime.jsx("nav", {
            className: "pmx-nav",
            "aria-label": "全局功能",
            children: [
              ...navItems.map((item) =>
                jsxRuntime.jsxs(
                  "button",
                  {
                    type: "button",
                    "aria-label": item.label,
                    title: item.label,
                    className: shell.route === item.key ? "active" : undefined,
                    onClick: () => selectRoute(item.key),
                    children: [
                      item.icon,
                      jsxRuntime.jsx("span", { children: item.label }),
                    ],
                  },
                  item.key,
                ),
              ),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "pmx-workspaces",
            onClickCapture: (event) => {
              if (
                event.target.closest?.(
                  '[role="treeitem"], [aria-label*="Session"], [aria-label*="会话"]',
                )
              ) {
                router.setRoute("session");
              }
            },
            children: renderSlot("sidebar.workspaces", {
              wide: shell.leftOpen,
              expandSidebar: () => router.setLeftOpen(true),
            }),
          }),
          jsxRuntime.jsxs("footer", {
            className: "pmx-sidebar-foot",
            children: [
              jsxRuntime.jsx(AccountButton, {
                onOpenAccountManagement: () =>
                  openSettings("账号与权限", "accounts"),
                onOpenSettings: () => openSettings(),
              }),
              jsxRuntime.jsx("div", {
                ref: settingsHost,
                className: "pmx-settings-slot",
                children: renderSlot("sidebar.settings", { wide: true }),
              }),
            ],
          }),
        ],
      });
    };

    const TaskPage = () =>
      jsxRuntime.jsxs("section", {
        className: "pmx-page",
        "data-page": "task",
        children: [
          jsxRuntime.jsxs("div", {
            className: "pmx-page-head",
            children: [
              jsxRuntime.jsxs("div", {
                children: [
                  jsxRuntime.jsx("h1", { children: "任务" }),
                  jsxRuntime.jsx("div", {
                    className: "pmx-page-sub",
                    children: "全局能力 · 按当前项目默认筛选",
                  }),
                ],
              }),
            ],
          }),
          jsxRuntime.jsx("div", {
            className: "pmx-placeholder",
            children:
              "任务独立实现中。布局与全局入口已就位，后续在此挂载任务列表、详情和派发流程。",
          }),
        ],
      });

    const MeetingResizeHandle = ({ width, onResize }) => {
      const [dragging, setDragging] = react.useState(false);
      const startX = react.useRef(0);
      const startWidth = react.useRef(width);
      const clampWidth = (nextWidth) => {
        const available = Math.max(280, window.innerWidth - 420);
        return Math.max(300, Math.min(nextWidth, available));
      };
      return jsxRuntime.jsx("div", {
        role: "separator",
        "aria-label": "调整会议侧栏宽度",
        "aria-orientation": "vertical",
        tabIndex: 0,
        className: "pmx-meeting-resize",
        "data-dragging": dragging ? "true" : undefined,
        onPointerDown: (event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          startX.current = event.clientX;
          startWidth.current = width;
          setDragging(true);
        },
        onPointerMove: (event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          onResize(
            clampWidth(startWidth.current + startX.current - event.clientX),
          );
        },
        onPointerUp: (event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
        },
        onPointerCancel: () => setDragging(false),
        onKeyDown: (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? 20 : -20;
          onResize(clampWidth(width + delta));
        },
      });
    };

    const Shell = ({ useSessions, renderSlot, SessionProvider }) => {
      const shell = useShellState();
      // undefined = 状态未知（加载中）；null = 未登录；对象 = 已登录
      const [account, setAccount] = react.useState(undefined);
      const [authInitialized, setAuthInitialized] = react.useState(true);
      react.useEffect(() => {
        const root = document.querySelector(".pmx-workspaces");
        if (root === null) return undefined;
        const renameWorkspaceLabels = () => {
          for (const node of root.querySelectorAll("span")) {
            if (node.childElementCount === 0 && node.textContent === "工作区") {
              node.textContent = "项目";
            }
          }
          for (const node of root.querySelectorAll(
            '[aria-label="添加工作区"]',
          )) {
            node.setAttribute("aria-label", "添加项目");
          }
        };
        renameWorkspaceLabels();
        const observer = new MutationObserver(renameWorkspaceLabels);
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        return () => observer.disconnect();
      }, []);
      react.useEffect(() => {
        let disposed = false;
        const load = async () => {
          try {
            const status = await requestIdentity("/api/collab/auth/status");
            if (disposed) return;
            setAuthInitialized(status.initialized !== false);
            if (!status.initialized) {
              setAccount(null);
              return;
            }
            const token = window.localStorage.getItem("pluginmax.collab.token");
            if (token === null) {
              setAccount(null);
              return;
            }
            const current = await requestIdentity("/api/collab/auth/me");
            if (!disposed) setAccount(current.user ?? null);
          } catch {
            if (!disposed) setAccount(null);
          }
        };
        void load();
        const listener = () => void load();
        window.addEventListener("pluginmax:collab-token", listener);
        return () => {
          disposed = true;
          window.removeEventListener("pluginmax:collab-token", listener);
        };
      }, []);
      const session = useSessions((state) => {
        const id = state.current;
        return id !== undefined && state.byId[id]?.blank === false
          ? {
              id,
              title:
                state.byId[id]?.displayTitle ??
                state.byId[id]?.title ??
                "未命名 Session",
            }
          : undefined;
      });
      const route =
        session !== undefined && shell.route === "session"
          ? "session"
          : shell.route;
      const activeGlobal = route === "session" ? "" : route;

      return jsxRuntime.jsxs("div", {
        className: "pmx-shell",
        "data-left-closed": shell.leftOpen ? undefined : "true",
        // 登录态未知或未登录时都先隐藏项目/会话列表，避免鉴权前闪现。
        "data-requires-login":
          account === null || account === undefined ? "true" : undefined,
        "data-global-route": activeGlobal === "" ? undefined : "true",
        "data-meeting-open": shell.meetingOpen ? "true" : undefined,
        "data-details-closed": shell.detailsOpen ? undefined : "true",
        style: {
          gridTemplateColumns: `${shell.leftOpen ? 264 : 72}px minmax(0,1fr) ${
            shell.detailsOpen ? "min(360px,32vw)" : "0"
          } ${shell.meetingOpen ? `${shell.meetingWidth}px` : "0"}`,
        },
        children: [
          jsxRuntime.jsx("style", { children: styles }),
          account === null
            ? jsxRuntime.jsx(LoginGate, { initialized: authInitialized })
            : null,
          jsxRuntime.jsx(Sidebar, { renderSlot }),
          jsxRuntime.jsxs("main", {
            className: "pmx-main",
            children: [
              jsxRuntime.jsx("div", {
                className: "pmx-stage",
                children:
                  activeGlobal === ""
                    ? jsxRuntime.jsx("div", {
                        className: "pmx-conversation-host",
                        children: renderSlot("conversation", {}),
                      })
                    : jsxRuntime.jsx("div", {
                        className: "pmx-page",
                        children: renderSlot("pluginmax.global", {}),
                      }),
              }),
            ],
          }),
          jsxRuntime.jsx("aside", {
            className: "pmx-details-track",
            "aria-label": "详情",
            children: jsxRuntime.jsx("div", {
              className: "pmx-details-content",
              children: jsxRuntime.jsx(SessionProvider, {
                children: renderSlot("details", {}),
              }),
            }),
          }),
          jsxRuntime.jsx("aside", {
            className: "pmx-overlay-track",
            "data-shell-overlay": true,
            children: [
              shell.meetingOpen
                ? jsxRuntime.jsx(MeetingResizeHandle, {
                    width: shell.meetingWidth,
                    onResize: (width) => router.setMeetingWidth(width),
                  })
                : null,
              renderSlot("shell.overlay", {}),
            ],
          }),
        ],
      });
    };

    exports.inject = ["slots", "theme"];
    exports.apply = (ctx) => {
      // SlotRegistry owns registration cleanup through the current fiber effect.
      // Register synchronously so the synchronous root render cannot race ahead
      // of the shell and throw a boot-order SlotAssemblyError.
      ctx.slots.register(
        {
          name: "root",
          priority: -20,
          children: {
            conversation: { kind: "single", scope: "session-maybe" },
            details: { kind: "single", scope: "session" },
            "shell.overlay": { kind: "list", scope: "root" },
            "sidebar.workspaces": { kind: "single", scope: "root" },
            "sidebar.settings": { kind: "single", scope: "root" },
            "pluginmax.global": {
              kind: "list",
              scope: "root",
              inject: { hooks: { shellRoute: routeSource } },
            },
          },
        },
        Shell,
      );

      ctx.effect(() => {
        const layout = {
          toggleSidebar: () => router.setLeftOpen(!router.state.leftOpen),
          openDetails: () => router.setDetailsOpen(true),
          closeDetails: () => router.setDetailsOpen(false),
        };
        const disposeLayout = ctx.reflect.provide("layout", layout);
        const disposeThemeListener = ctx.on("theme/change", applyThemeSnapshot);
        applyThemeSnapshot(ctx.theme.getTheme());
        return () => {
          disposeThemeListener();
          void disposeLayout();
        };
      }, "pluginmax-shell: layout compatibility + theme presentation");
    };

    return module.exports;
  },
});
