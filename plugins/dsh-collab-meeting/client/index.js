window.__ModuleLoader__.load({
  id: "dsh-collab-meeting",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");

    /* ── constants ── */

    const TOKEN_KEY = "pluginmax.collab.token";
    const PANEL_LAST_MEETING_KEY =
      "pluginmax.collab.meeting.panel.lastMeetingId";
    const RECENT_EMPTY_MEETING_IDS_KEY =
      "pluginmax.collab.meeting.recentEmptyMeetingIds";
    const PANEL_WIDTH = 410;
    const SYSTEM_DEFAULT_WORKSPACE_ID = "system.default";
    const SYSTEM_DEFAULT_WORKSPACE = {
      id: SYSTEM_DEFAULT_WORKSPACE_ID,
      title: "默认项目",
      path: "",
      isMember: true,
      memberRole: "member",
      ownerId: "system",
    };

    /* ── module-level store (open/close shared by toggle + panel) ── */

    const store = {
      open: false,
      listeners: new Set(),
      // 跨视图数据联动：右侧栏与会议页各自持有一份会议数据，
      // 任一侧改完数据后通知另一侧重新拉取，避免两处显示不一致。
      changeListeners: new Set(),
      openPanel() {
        this.open = true;
        this.emit();
      },
      toggle() {
        this.open = !this.open;
        this.emit();
      },
      close() {
        this.open = false;
        this.emit();
      },
      subscribe(fn) {
        this.listeners.add(fn);
        return () => {
          this.listeners.delete(fn);
        };
      },
      bumpChange(source) {
        for (const fn of this.changeListeners) fn(source);
      },
      subscribeChange(fn) {
        this.changeListeners.add(fn);
        return () => {
          this.changeListeners.delete(fn);
        };
      },
      emit() {
        window.__pluginmaxShell?.setMeetingOpen(this.open);
        for (const fn of this.listeners) fn(this.open);
      },
    };

    window.__pluginmaxMeeting = store;

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

    function usePanelOpen() {
      const [open, setOpen] = react.useState(store.open);
      react.useEffect(() => store.subscribe(setOpen), []);
      return open;
    }

    function useViewportWidth() {
      const [width, setWidth] = react.useState(
        () => window.innerWidth || 1440,
      );
      react.useEffect(() => {
        const onResize = () => setWidth(window.innerWidth || 1440);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, []);
      return width;
    }

    /* ── element helper ── */

    const h = (type, props, ...children) =>
      jsxRuntime.jsxs(
        type,
        Object.assign({}, props, {
          // 兼容两种写法：子节点既可通过展开参数传入，也可写成 props.children。
          // 否则 `h("h1", { children: "会议" })` 会被覆盖成 undefined，文本丢失。
          children:
            children.length === 0
              ? props
                ? props.children
                : undefined
              : children.length === 1
                ? children[0]
                : children,
        }),
      );

    /**
     * 展示层清理：模型偶尔会把思考过程或工具调用标记写进正文
     * （例如 `<|DSML| calls>` / `<|DSML| invoke name="Bash">`）。
     * 这里隐去这类块，并在正文含 Markdown 标题时只保留标题之后的正文，
     * 避免群聊里出现工具调用乱码。
     */
    function displayContent(raw) {
      if (typeof raw !== "string") return raw;
      // 服务端固定通知不是纪要正文，不能进入“无结构化标题即失败”的兜底。
      if (/^会议纪要 v\d+ 已生成。$/.test(raw.trim())) return raw.trim();
      let text = raw;
      // 注意：模型输出的是全角竖线「｜」，这里同时兼容半角「|」。
      const start = text.search(/<[|｜]+\s*[|｜]?\s*DSML/i);
      if (start >= 0) text = text.slice(0, start);
      text = text.replace(/<[|｜]+\s*[|｜]?[^>\n]*>/g, "");
      const match = /^#{1,6}\s/m.exec(text);
      if (match !== null && match.index > 0) text = text.slice(match.index);
      const cleaned = text.trim();
      // 纪要消息（「会议纪要 vN …」）如果清理后没有结构化标题，
      // 说明该版本只有思考过程/工具调用，直接给占位说明，避免误导。
      if (/^会议纪要 v\d/.test(raw) && !/^#{1,6}\s/m.test(cleaned)) {
        return "（该版本未生成结构化纪要）";
      }
      return cleaned === "" ? "（本次未生成可用内容）" : cleaned;
    }

    /**
     * 会议聊天里的轻量 Markdown 渲染：支持 # 标题、有序/无序列表、
     * **加粗**、`行内代码` 与 ``` 代码块。会议消息（尤其纪要）本身是 MD，
     * 直接当纯文本显示会把 `##` 这类标记露出来。
     */
    function renderChatMarkdown(raw) {
      const text = typeof raw === "string" ? raw : "";
      if (text.trim() === "") return null;
      const blocks = [];
      let listItems = [];
      let ordered = false;
      let inCode = false;
      let codeLines = [];
      let seq = 0;
      const inline = (source, keyBase) => {
        const parts = [];
        const pattern = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
        let last = 0;
        let match;
        let i = 0;
        while ((match = pattern.exec(source)) !== null) {
          if (match.index > last) parts.push(source.slice(last, match.index));
          if (match[2] !== undefined) {
            parts.push(h("strong", { key: `${keyBase}-b${i}` }, match[2]));
          } else if (match[3] !== undefined) {
            parts.push(
              h(
                "code",
                {
                  key: `${keyBase}-c${i}`,
                  style: {
                    background: "var(--dsw-alias-bg-layer-2)",
                    borderRadius: 4,
                    fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                    fontSize: "0.92em",
                    padding: "1px 4px",
                  },
                },
                match[3],
              ),
            );
          }
          last = pattern.lastIndex;
          i += 1;
        }
        if (last < source.length) parts.push(source.slice(last));
        return parts;
      };
      const flushList = () => {
        if (listItems.length === 0) return;
        const Tag = ordered ? "ol" : "ul";
        const key = `list-${seq}`;
        blocks.push(
          h(
            Tag,
            { key, style: { margin: "2px 0", paddingLeft: 18 } },
            ...listItems.map((item, i) =>
              h("li", { key: `li-${seq}-${i}` }, ...inline(item, i)),
            ),
          ),
        );
        listItems = [];
        seq += 1;
      };
      for (const line of text.split("\n")) {
        if (line.trim().startsWith("```")) {
          if (inCode) {
            blocks.push(
              h(
                "pre",
                {
                  key: `code-${seq}`,
                  style: {
                    background: "var(--dsw-alias-bg-base)",
                    borderRadius: 6,
                    fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                    fontSize: 12,
                    overflowX: "auto",
                    padding: "8px 10px",
                  },
                },
                codeLines.join("\n"),
              ),
            );
            seq += 1;
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
        const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
        if (headingMatch) {
          flushList();
          const level = Math.min(headingMatch[1].length, 6);
          blocks.push(
            h(
              `h${level}`,
              {
                key: `h-${seq}`,
                style: {
                  fontSize: level <= 2 ? 14 : 13,
                  fontWeight: 650,
                  margin: "6px 0 2px",
                },
              },
              ...inline(headingMatch[2], seq),
            ),
          );
          seq += 1;
          continue;
        }
        const unorderedMatch = line.match(/^\s*[-·*]\s+(.*)/);
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
          h(
            "p",
            { key: `p-${seq}`, style: { margin: "2px 0" } },
            ...inline(line, seq),
          ),
        );
        seq += 1;
      }
      flushList();
      if (inCode && codeLines.length > 0) {
        blocks.push(
          h(
            "pre",
            {
              key: `code-${seq}`,
              style: {
                background: "var(--dsw-alias-bg-base)",
                borderRadius: 6,
                fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                fontSize: 12,
                overflowX: "auto",
                padding: "8px 10px",
              },
            },
            codeLines.join("\n"),
          ),
        );
      }
      return h("div", null, ...blocks);
    }

    /* ── meeting panel (shell.overlay slot): list + group chat only ── */

    const svgIcon = (paths, size = 15) =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        ...paths.map((d, index) => h("path", { key: index, d })),
      );

    /** 会议切换操作位：只用放大镜图标，不加矩形边线。 */
    const searchIcon = (size = 14) =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("circle", { cx: 11, cy: 11, r: 7.5 }),
        h("path", { d: "m21 21-4.3-4.3" }),
      );

    const backIcon = () => svgIcon(["m15 18-6-6 6-6"], 14);
    const plusCircleIcon = () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 16,
          height: 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "M12 8v8" }),
        h("path", { d: "M8 12h8" }),
      );

    const clipIcon = () =>
      svgIcon(
        [
          "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
        ],
        11,
      );

    const atIcon = () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 11,
          height: 11,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("circle", { cx: 12, cy: 12, r: 4 }),
        h("path", { d: "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" }),
      );

    const videoIcon = () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 15,
          height: 15,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("path", {
          d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
        }),
        h("rect", { x: 2, y: 6, width: 14, height: 12, rx: 2 }),
      );

    const sendIcon = () =>
      svgIcon(["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"], 13);

    const downloadIcon = () =>
      svgIcon(["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"], 12);

    const downloadMinutesMarkdown = (meeting, version) => {
      const content = String(version?.content ?? "");
      if (content.trim() === "") return;
      const safeTitle = String(meeting?.title ?? "会议")
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim();
      const filename = `${safeTitle || "会议"}-会议纪要-v${version.version}.md`;
      const url = URL.createObjectURL(
        new Blob([content], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    /** 姓名缩写：与任务管理页同一套规则（按空格分词，取前两段首字母）。 */
    const initials = (value) =>
      String(value ?? "?")
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    /* ── 头像：与 AI Teammates / 任务管理页同一套 ── */

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

    const avatarHair = (preset) => {
      const fill = preset.hair;
      if (preset.hairStyle === "bun")
        return [
          h("circle", { key: "bun", cx: 47, cy: 14, r: 6, fill }),
          h("path", {
            key: "bun-body",
            d: "M16 29c0-12 7-19 16-19 9 0 16 7 16 19-5-3-8-8-9-12-5 7-14 11-23 12Z",
            fill,
          }),
        ];
      if (preset.hairStyle === "side")
        return [
          h("path", {
            key: "side",
            d: "M17 27c1-11 8-17 17-17 8 0 14 5 15 15-7-1-11-5-14-10-4 6-11 10-18 12Z",
            fill,
          }),
        ];
      if (preset.hairStyle === "bob")
        return [
          h("path", {
            key: "bob",
            d: "M16 28c0-12 7-18 16-18s16 7 16 18v13h-6V30c-7 1-13-1-19-6-1 5-3 8-7 10Z",
            fill,
          }),
        ];
      return [
        h("path", {
          key: "wave",
          d: "M16 29c0-12 7-19 17-19 10 0 16 7 16 19-4-2-7-6-9-10-5 6-14 9-24 10Z",
          fill,
        }),
      ];
    };

    const AVATAR_ART_STYLE = {
      background: "#20242a",
      border: "2px solid var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
      borderRadius: "50%",
      display: "block",
      height: "100%",
      objectFit: "cover",
      overflow: "hidden",
      width: "100%",
    };

    const avatarArt = (value) => {
      if (typeof value === "string" && value.startsWith("data:image/"))
        return h("img", { style: AVATAR_ART_STYLE, src: value, alt: "" });
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
            h("circle", { cx: 25.5, cy: 31, r: 5.4 }),
            h("circle", { cx: 38.5, cy: 31, r: 5.4 }),
            h("path", { d: "M31 31h2" }),
          ),
        );
      }
      return h(
        "svg",
        { viewBox: "0 0 64 64", style: AVATAR_ART_STYLE, "aria-hidden": true },
        ...children,
      );
    };

    /** 人类头像：与任务管理页同款 26px 圆角方块 + 姓名缩写（自己显示「我」）。 */
    const initialsAvatarStyle = {
      alignItems: "center",
      background: "#2f9e66",
      borderRadius: 7,
      color: "#fff",
      display: "grid",
      flexShrink: 0,
      fontSize: 10,
      fontWeight: 700,
      height: 26,
      placeItems: "center",
      width: 26,
    };

    /** AI teammate 头像：渐变光环 + 生成式头像（平台实例用蓝色光环）。 */
    const teammateRingStyle = (platform) => ({
      alignItems: "center",
      background: platform
        ? "#63b8ff"
        : "conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff)",
      borderRadius: "50%",
      boxShadow: platform
        ? "0 0 0 1px rgba(99,184,255,.55)"
        : "0 0 0 1px rgba(139,108,255,.26)",
      display: "grid",
      flexShrink: 0,
      height: 26,
      padding: 2,
      placeItems: "center",
      width: 26,
    });

    /**
     * 会话头像：系统=灰底、人类=缩写圆角方块、AI=光环 + 生成式头像。
     * 中间沟通区与右侧栏共用，样式与 AI Teammates / 任务管理页一致。
     */
    const chatAvatar = (message, mine, teammates) => {
      if (message.senderKind === "system")
        return h(
          "span",
          {
            style: Object.assign({}, initialsAvatarStyle, {
              background: "var(--dsw-alias-bg-layer-3)",
              color: "var(--dsw-alias-label-secondary)",
            }),
          },
          "系",
        );
      if (message.senderKind === "human")
        return h(
          "span",
          { style: initialsAvatarStyle },
          mine ? "我" : initials(message.senderName),
        );
      const list = teammates ?? [];
      const teammate =
        list.find((item) => item.id === message.senderId) ??
        list.find((item) => item.name === message.senderName);
      return h(
        "span",
        {
          style: teammateRingStyle(teammate?.source === "platform"),
          title: message.senderName,
        },
        avatarArt(teammate?.avatar),
      );
    };

    const participantAvatarNode = (participant, teammates) => {
      if (participant.kind === "human") {
        return h(
          "span",
          { style: initialsAvatarStyle },
          initials(participant.displayName),
        );
      }
      const teammate = (teammates ?? []).find(
        (item) =>
          item.id === participant.teammateInstanceId ||
          item.id === participant.refId,
      );
      return h(
        "span",
        { style: teammateRingStyle(teammate?.source === "platform") },
        avatarArt(teammate?.avatar),
      );
    };

    const panelStyles = {
      root: {
        alignItems: "stretch",
        display: "flex",
        inset: 0,
        justifyContent: "flex-end",
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
        zIndex: 20,
      },
      panel: {
        background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
        borderLeft: "0.5px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        position: "relative",
        width: `min(${PANEL_WIDTH}px, 100%)`,
      },
      head: {
        alignItems: "center",
        borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexShrink: 0,
        flexWrap: "wrap",
        gap: 8,
        padding: "12px 14px 10px",
      },
      headerAvatar: {
        alignItems: "center",
        display: "grid",
        flexShrink: 0,
        height: 30,
        justifyContent: "center",
        placeItems: "center",
        width: 30,
      },
      meetingAvatar: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 7,
        color: "var(--dsw-alias-accent-primary,#4f8ef7)",
        display: "grid",
        flexShrink: 0,
        height: 26,
        placeItems: "center",
        width: 26,
      },
      title: {
        flex: 1,
        fontSize: 14,
        fontWeight: 600,
        margin: 0,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      select: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        fontSize: 12,
        padding: "5px 7px",
      },
      btn: {
        alignItems: "center",
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "inline-flex",
        fontSize: 12,
        gap: 4,
        justifyContent: "center",
        padding: "5px 9px",
      },
      list: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflowY: "auto",
        padding: 8,
      },
      item: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        color: "inherit",
        cursor: "pointer",
        display: "block",
        padding: "9px 10px",
        textAlign: "left",
        width: "100%",
      },
      itemActive: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,var(--dsw-alias-bg-layer-1))",
        borderColor:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent)",
        boxShadow:
          "inset 2px 0 0 var(--dsw-alias-accent-primary,#4f8ef7)",
      },
      meta: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 },
      empty: {
        alignItems: "center",
        border: "0.5px dashed var(--dsw-alias-border-l3)",
        borderRadius: 7,
        color: "var(--dsw-alias-label-secondary)",
        display: "grid",
        flex: 1,
        fontSize: 12,
        justifyContent: "center",
        minHeight: 280,
        padding: 28,
        textAlign: "center",
      },
      chat: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
      },
      stream: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 8,
        overflowY: "auto",
        padding: 10,
      },
      bubble: {
        background: "var(--dsw-alias-bg-layer-2)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: "3px 8px 8px 8px",
        fontSize: 13,
        lineHeight: 1.55,
        maxWidth: "100%",
        padding: "7px 10px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      },
      bubbleMine: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,var(--dsw-alias-bg-layer-2))",
        borderColor:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 35%,transparent)",
        borderRadius: "8px 3px 8px 8px",
      },
      systemMessage: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
        padding: "5px 0",
        textAlign: "center",
        width: "100%",
      },
      form: {
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
        display: "flex",
        gap: 6,
        padding: 8,
      },
      textarea: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        flex: 1,
        fontFamily: "inherit",
        fontSize: 12,
        // 默认多留一行高度，避免刚打开就只能看到一行。
        minHeight: 52,
        padding: "6px 8px",
        resize: "vertical",
      },
      error: {
        background: "rgba(220,60,60,0.14)",
        borderRadius: 6,
        color: "#e06a6a",
        fontSize: 11,
        margin: "0 10px 8px",
        padding: "6px 8px",
      },
      notice: {
        background: "rgba(52,212,126,0.12)",
        borderRadius: 6,
        color: "#34d47e",
        fontSize: 11,
        margin: "0 10px 8px",
        padding: "6px 8px",
      },
      picker: {
        alignItems: "center",
        display: "flex",
        flexShrink: 0,
        gap: 6,
        padding: "8px 10px 0",
      },
      search: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        flex: 1,
        fontFamily: "inherit",
        fontSize: 12,
        minWidth: 0,
        padding: "6px 8px",
      },
      dialogOverlay: {
        alignItems: "center",
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        position: "absolute",
        zIndex: 30,
      },
      dialog: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: 8,
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxHeight: "80%",
        padding: 14,
        width: 340,
      },
      dialogTitle: { fontSize: 14, fontWeight: 600 },
      dialogBody: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        overflowY: "auto",
      },
      dialogActions: {
        display: "flex",
        gap: 6,
        justifyContent: "flex-end",
        marginTop: 4,
      },
      checkRow: {
        alignItems: "center",
        display: "flex",
        fontSize: 12,
        gap: 8,
        padding: "6px 0",
      },
      block: {
        display: "flex",
        flexDirection: "column",
        gap: 8,
      },
      divider: {
        borderTop: "0.5px solid var(--dsw-alias-border-l2)",
        margin: "2px 0",
      },
      // 头像样式对齐任务管理页：26px 圆角方块 + 姓名缩写。
      chip: {
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 4,
        color: "var(--dsw-alias-label-secondary)",
        flexShrink: 0,
        fontSize: 10,
        padding: "1px 5px",
      },
      name: {
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      btnPrimary: {
        background: "var(--dsw-alias-accent-fill, #2f6feb)",
        border: "none",
        borderRadius: 6,
        color: "#fff",
        cursor: "pointer",
        fontSize: 12,
        padding: "6px 12px",
      },
      titleWrap: {
        alignItems: "center",
        display: "flex",
        flex: 1,
        gap: 6,
        minWidth: 0,
      },
      // 会议切换操作位：无边框，只用图标表达（放大镜）。
      iconGhost: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 22,
        placeItems: "center",
        width: 22,
      },
      titleText: {
        flex: "0 1 auto",
        fontSize: 14,
        fontWeight: 600,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      aiBadge: {
        background: "linear-gradient(135deg,#6f53d6,#2f6feb)",
        borderRadius: 4,
        color: "#fff",
        flexShrink: 0,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.4,
        padding: "1px 4px",
      },
      // 输入框上方的附件 / @ 操作位：浅背景、无边框、图标更小。
      composerBtn: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "none",
        borderRadius: 6,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 22,
        placeItems: "center",
        width: 22,
      },
      sendBtn: {
        alignItems: "center",
        background: "var(--dsw-alias-accent-primary,#4f8ef7)",
        border: "none",
        borderRadius: 6,
        color: "#fff",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 26,
        placeItems: "center",
        width: 26,
      },
      iconBtn: {
        alignItems: "center",
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 26,
        placeItems: "center",
        width: 26,
      },
      dropdown: {
        background:
          "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 8,
        boxShadow:
          "0 20px 52px rgba(0,0,0,0.58), 0 2px 8px rgba(0,0,0,0.34)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: 6,
        left: 14,
        padding: 10,
        position: "absolute",
        right: 14,
        top: 62,
        zIndex: 40,
      },
      dropdownList: {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        maxHeight: 220,
        overflowY: "auto",
      },
      dropdownItem: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        fontSize: 12,
        gap: 8,
        justifyContent: "space-between",
        padding: "6px 8px",
        textAlign: "left",
      },
      dropdownItemActive: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,var(--dsw-alias-bg-layer-2))",
        border:
          "0.5px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent)",
      },
      dropdownItemIdle: {
        border: "0.5px solid var(--dsw-alias-border-l3)",
        background: "var(--dsw-alias-bg-layer-2)",
      },
      switchCopy: {
        display: "grid",
        flex: 1,
        gap: 1,
        minWidth: 0,
        textAlign: "left",
      },
      dropdownAvatar: {
        alignItems: "center",
        display: "grid",
        flexShrink: 0,
        height: 26,
        placeItems: "center",
        width: 26,
      },
      switchName: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      switchMeta: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
      },
      switchTime: {
        color: "var(--dsw-alias-label-tertiary)",
        flexShrink: 0,
        fontSize: 10,
        whiteSpace: "nowrap",
      },
      dropdownFooter: {
        display: "flex",
        justifyContent: "flex-end",
        marginTop: 2,
      },
      contentView: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        padding: 10,
      },
      detailView: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
      },
      newView: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
        overflowY: "auto",
        padding: 10,
      },
      listSection: {
        display: "flex",
        flexDirection: "column",
        gap: 5,
      },
      sectionTitle: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 11,
        fontWeight: 600,
      },
      field: {
        display: "grid",
        gap: 4,
        fontSize: 11,
      },
      textLink: {
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        fontSize: 11,
        textDecoration: "underline",
        textDecorationColor:
          "color-mix(in srgb,var(--dsw-alias-label-secondary) 45%,transparent)",
        textUnderlineOffset: 3,
      },
      tabs: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "flex",
        flexShrink: 0,
        gap: 2,
        margin: "10px 10px 8px",
        padding: 3,
      },
      tab: {
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        flex: 1,
        fontSize: 11,
        padding: "5px 6px",
      },
      tabActive: {
        background: "#4f8ef7",
        color: "#fff",
        fontWeight: 600,
      },
      panelSection: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        overflowY: "auto",
        padding: 10,
      },
      summarySectionHead: {
        alignItems: "center",
        display: "flex",
        gap: 8,
        justifyContent: "space-between",
      },
      minutesBody: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        flex: 1,
        fontSize: 12,
        minHeight: 0,
        overflowY: "auto",
        padding: 10,
      },
      settings: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 14,
        minHeight: 0,
        overflowY: "auto",
        padding: 12,
      },
      composer: {
        alignItems: "center",
        display: "flex",
        flexShrink: 0,
        gap: 6,
      },
      mentionMenu: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        bottom: "100%",
        boxShadow: "0 12px 28px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        left: 10,
        maxHeight: 200,
        overflowY: "auto",
        padding: 4,
        position: "absolute",
        right: 10,
        zIndex: 20,
      },
      mentionItem: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        fontSize: 12,
        gap: 8,
        padding: "6px 7px",
        textAlign: "left",
        width: "100%",
      },
      mentionCopy: { display: "grid", gap: 1, minWidth: 0, textAlign: "left" },
      mentionName: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      mentionMeta: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
        lineHeight: 1.35,
      },
      groupTitle: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 11,
        fontWeight: 600,
      },
    };

    const MeetingPanel = () => {
      const open = usePanelOpen();
      const [accountName, setAccountName] = react.useState("");
      const [meetings, setMeetings] = react.useState([]);
      const [query, setQuery] = react.useState("");
      const [meetingId, setMeetingId] = react.useState(
        () => window.localStorage.getItem(PANEL_LAST_MEETING_KEY) ?? "",
      );
      const [detail, setDetail] = react.useState(null);
      const [minutes, setMinutes] = react.useState(null);
      const [teammates, setTeammates] = react.useState([]);
      const [content, setContent] = react.useState("");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [refreshKey, setRefreshKey] = react.useState(0);
      const [panelTab, setPanelTab] = react.useState("conversation");
      // 状态反馈条 3 秒后自动消失。
      react.useEffect(() => {
        if (notice === "" && error === "") return undefined;
        const timer = window.setTimeout(() => {
          setNotice("");
          setError("");
        }, 3_000);
        return () => window.clearTimeout(timer);
      }, [notice, error]);
      const [panelView, setPanelView] = react.useState("list");
      const previousOpenRef = react.useRef(false);
      const [switcherOpen, setSwitcherOpen] = react.useState(false);
      const [newMeetingTitle, setNewMeetingTitle] = react.useState("");
      const [workspaceOptions, setWorkspaceOptions] = react.useState([
        SYSTEM_DEFAULT_WORKSPACE,
      ]);
      const [newWorkspaceId, setNewWorkspaceId] = react.useState(
        SYSTEM_DEFAULT_WORKSPACE_ID,
      );
      const [people, setPeople] = react.useState([]);
      const [inviteOpen, setInviteOpen] = react.useState(false);
      const [inviteQuery, setInviteQuery] = react.useState("");
      const [inviteSelected, setInviteSelected] = react.useState([]);
      const [minutesOverwriteOpen, setMinutesOverwriteOpen] =
        react.useState(false);
      const [titleDraft, setTitleDraft] = react.useState("");
      const [mentionOpen, setMentionOpen] = react.useState(false);
      const [mentionIds, setMentionIds] = react.useState([]);
      const [mentionQuery, setMentionQuery] = react.useState("");
      const messagesRef = react.useRef(null);
      const fileRef = react.useRef(null);
      const composerInputRef = react.useRef(null);
      const mentionAnchorRef = react.useRef(null);
      const switcherPanelRef = react.useRef(null);
      const switcherButtonRef = react.useRef(null);

      react.useEffect(
        () =>
          store.subscribeChange((source) => {
            if (source !== "panel") setRefreshKey((key) => key + 1);
          }),
        [],
      );

      react.useEffect(() => {
        const onTokenChange = () => {
          if (window.localStorage.getItem("pluginmax.collab.token") === null) {
            setMeetings([]);
            setMeetingId("");
            setDetail(null);
            setMinutes(null);
            setTeammates([]);
            setAccountName("");
          }
          setRefreshKey((key) => key + 1);
        };
        window.addEventListener("pluginmax:collab-token", onTokenChange);
        return () =>
          window.removeEventListener("pluginmax:collab-token", onTokenChange);
      }, []);

      const fail = (cause) =>
        setError(cause instanceof Error ? cause.message : String(cause));

      react.useEffect(() => {
        if (!open) return undefined;
        let disposed = false;
        (async () => {
          try {
            const [ws, me, team] = await Promise.all([
              request("/api/collab/team/workspaces"),
              request("/api/collab/auth/me").catch(() => ({})),
              request(
                "/api/collab/teammates?workspaceId=system.default",
              ).catch(() => ({ teammates: [] })),
            ]);
            if (disposed) return;
            setAccountName(me.user?.name ?? "");
            setTeammates(team.teammates ?? []);
            // 抽屉顶部的会议选择器跨项目：把当前用户已加入项目的会议合并。
            const joined = [
              ...(ws.workspaces ?? []).filter(
                (workspace) =>
                  workspace.isMember === true &&
                  workspace.id !== SYSTEM_DEFAULT_WORKSPACE_ID,
              ),
              SYSTEM_DEFAULT_WORKSPACE,
            ];
            setWorkspaceOptions(joined);
            setNewWorkspaceId((current) =>
              joined.some((workspace) => workspace.id === current)
                ? current
                : (joined[0]?.id ?? SYSTEM_DEFAULT_WORKSPACE_ID),
            );
            const lists = await Promise.all(
              joined.map((workspace) =>
                request(
                  `/api/collab/meetings?workspaceId=${encodeURIComponent(workspace.id)}`,
                )
                  .then((result) => result.meetings ?? [])
                  .catch(() => []),
              ),
            );
            if (disposed) return;
            const merged = lists
              .flat()
              .sort((left, right) =>
                String(meetingActivityTime(right) ?? "").localeCompare(
                  String(meetingActivityTime(left) ?? ""),
                ),
              );
            setMeetings(merged);
            const withHistory = merged.filter((item) =>
              meetingHasConversation(item),
            );
            const remembered =
              window.localStorage.getItem(PANEL_LAST_MEETING_KEY) ?? "";
            setMeetingId((current) => {
              const preferred = current || remembered;
              return withHistory.some((item) => item.id === preferred)
                ? preferred
                : (withHistory[0]?.id ?? "");
            });
          } catch (cause) {
            if (!disposed) fail(cause);
          }
        })();
        return () => {
          disposed = true;
        };
      }, [open, refreshKey]);

      react.useEffect(() => {
        if (!open || meetingId === "") {
          setDetail(null);
          setMinutes(null);
          return undefined;
        }
        let disposed = false;
        (async () => {
          try {
            const result = await request(
              `/api/collab/meeting?meetingId=${encodeURIComponent(meetingId)}`,
            );
            const minuteResult =
              result.meeting?.kind === "ai"
                ? null
                : await request(
                    `/api/collab/meeting/minutes?meetingId=${encodeURIComponent(meetingId)}`,
                  ).catch(() => null);
            if (disposed) return;
            setDetail(result);
            setMinutes(minuteResult);
          } catch (cause) {
            if (!disposed) fail(cause);
          }
        })();
        return () => {
          disposed = true;
        };
      }, [open, meetingId, refreshKey]);

      react.useEffect(() => {
        if ((panelTab !== "settings" && !inviteOpen) || meetingId === "")
          return undefined;
        let disposed = false;
        request(
          `/api/collab/meeting/people?meetingId=${encodeURIComponent(meetingId)}`,
        )
          .then((result) => {
            if (!disposed) setPeople(result.people ?? []);
          })
          .catch(() => undefined);
        return () => {
          disposed = true;
        };
      }, [panelTab, inviteOpen, meetingId]);

      // 切换会议时回到常规会话视图并收起下拉。
      react.useEffect(() => {
        if (open && !previousOpenRef.current) {
          setPanelView("list");
          setSwitcherOpen(false);
          setQuery("");
        }
        previousOpenRef.current = open;
      }, [open]);

      react.useEffect(() => {
        setPanelTab("conversation");
        setInviteOpen(false);
        setSwitcherOpen(false);
      }, [meetingId]);

      react.useEffect(() => {
        if (
          !open ||
          !switcherOpen ||
          panelView !== "detail" ||
          typeof document === "undefined"
        ) {
          return undefined;
        }
        // 打开下拉的这一轮 click 不参与判断，避免刚展开就被关闭。
        let armed = false;
        const timer = window.setTimeout(() => {
          armed = true;
        }, 0);
        const onPointerDown = (event) => {
          if (!armed) return;
          const target = event.target;
          if (
            switcherPanelRef.current?.contains?.(target) ||
            switcherButtonRef.current?.contains?.(target)
          ) {
            return;
          }
          setSwitcherOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key !== "Escape") return;
          setSwitcherOpen(false);
          switcherButtonRef.current?.focus?.();
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          window.clearTimeout(timer);
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open, panelView, switcherOpen]);

      react.useEffect(() => {
        if (meetingId === "") {
          window.localStorage.removeItem(PANEL_LAST_MEETING_KEY);
          return;
        }
        window.localStorage.setItem(PANEL_LAST_MEETING_KEY, meetingId);
      }, [meetingId]);

      // 会议名称默认处于可编辑态：进入设置视图或标题变化时同步草稿。
      react.useEffect(() => {
        if (panelTab !== "settings") return;
        setTitleDraft(detail?.meeting?.title ?? "");
      }, [panelTab, detail?.meeting?.title]);

      react.useEffect(() => {
        if (!open || meetingId === "") return undefined;
        const versions = minutes?.versions ?? [];
        const generating = versions.some(
          (version) =>
            version.status === "generating" || version.status === "pending",
        );
        if (!generating) return undefined;
        const timer = window.setInterval(
          () => setRefreshKey((key) => key + 1),
          4_000,
        );
        return () => window.clearInterval(timer);
      }, [open, meetingId, minutes]);

      react.useEffect(() => {
        // 任意新消息（系统 / 人类 / AI）到达后，始终跟随到最新位置。
        if (messagesRef.current)
          messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }, [detail]);

      react.useEffect(() => {
        if (
          detail?.meeting?.kind !== "ai" ||
          detail?.meeting?.status !== "active"
        ) {
          return undefined;
        }
        const lastMessage = (detail?.transcript ?? []).at(-1);
        const waitingForReply =
          lastMessage?.senderKind === "human" &&
          (lastMessage.deliveries ?? []).some(
            (delivery) => delivery.status === "pending",
          );
        if (!waitingForReply) return undefined;
        const timer = window.setInterval(
          () => setRefreshKey((key) => key + 1),
          2_000,
        );
        return () => window.clearInterval(timer);
      }, [detail]);

      if (!open) return null;

      const meeting = detail?.meeting;
      const isAiConversation = meeting?.kind === "ai";
      const activePanelTab = isAiConversation ? "conversation" : panelTab;
      const transcript = detail?.transcript ?? [];
      const actorId = detail?.actorId ?? "";
      const joined = (detail?.participants ?? []).some(
        (participant) =>
          participant.kind === "human" &&
          participant.status === "active" &&
          participant.refId === actorId,
      );
      const participants = detail?.participants ?? [];
      const aiConversationTeammate = isAiConversation
        ? teammates.find(
            (item) => item.id === meeting?.teammateInstanceId,
          )
        : undefined;
      const panelAiCount = participants.filter(
        (participant) =>
          participant.status === "active" && participant.kind !== "human",
      ).length;
      const panelMinutesVersion = [...(minutes?.versions ?? [])]
        .reverse()
        .find((version) => String(version.content ?? "").trim() !== "");
      const panelMentionOptions = participants.filter(
        (participant) =>
          participant.status === "active" &&
          !(participant.kind === "human" && participant.refId === actorId) &&
          (mentionQuery === "" ||
            (participant.displayName ?? "")
              .toLowerCase()
              .includes(mentionQuery.toLowerCase())),
      );
      const focusPanelComposerAt = (cursor) => {
        window.requestAnimationFrame(() => {
          const field = composerInputRef.current;
          if (!field) return;
          field.focus();
          field.setSelectionRange(cursor, cursor);
        });
      };
      const closePanelMention = () => {
        setMentionOpen(false);
        setMentionQuery("");
        mentionAnchorRef.current = null;
      };
      const insertPanelMentionTrigger = () => {
        const input = composerInputRef.current;
        const start = input?.selectionStart ?? content.length;
        const end = input?.selectionEnd ?? start;
        mentionAnchorRef.current = { start };
        setContent(`${content.slice(0, start)}@${content.slice(end)}`);
        setMentionOpen(true);
        setMentionQuery("");
        focusPanelComposerAt(start + 1);
      };
      const togglePanelMention = () => {
        if (mentionOpen) {
          closePanelMention();
          return;
        }
        insertPanelMentionTrigger();
      };
      const panelMentionChanged = (value) => {
        setContent(value);
        const range = mentionTokenRange(value);
        if (range) {
          mentionAnchorRef.current = { start: range.start };
          setMentionOpen(true);
          setMentionQuery(value.slice(range.start + 1, range.end));
        } else {
          closePanelMention();
        }
      };
      const pickPanelMention = (participant) => {
        const range = mentionTokenRange(
          content,
          mentionAnchorRef.current?.start,
        );
        const start = range?.start ?? content.length;
        const end = range?.end ?? content.length;
        const token = `@${participant.displayName} `;
        const cursor = start + token.length;
        setContent(`${content.slice(0, start)}${token}${content.slice(end)}`);
        setMentionIds((current) => [...new Set([...current, participant.id])]);
        closePanelMention();
        focusPanelComposerAt(cursor);
      };
      // 未启用时接口返回 null，统一收敛成 undefined，避免后续判空遗漏。
      const facilitator = minutes?.facilitator ?? undefined;
      // 会议成员 = 启用的 AI Facilitator（如果有）+ 普通参会人。
      // 两者共用一张列表，保证「成员里有它 = facilitator 已启用」。
      // 平台 Facilitator 实例只以「席位」形态出现，历史遗留的
      // `participant/ai` 记录不再重复展示，避免同一 AI 出现两行。
      const humanMemberRows = participants
        .filter(
          (participant) =>
            participant.status === "active" &&
            participant.kind === "human",
        )
        .map((participant) => ({
          id: participant.id,
          label: participant.displayName,
          kind: "human",
          teammateId: participant.refId,
          facilitator: false,
          active: true,
          participantId: participant.id,
        }));
      const aiMemberRows = participants
        .filter(
          (participant) =>
            participant.status === "active" &&
            participant.kind !== "human" &&
            !(
              participant.kind === "ai_teammate" &&
              participant.refId === "meeting-facilitator"
            ),
        )
        .map((participant) => ({
          id: participant.id,
          label: participant.displayName,
          kind: "ai",
          teammateId: participant.teammateInstanceId ?? participant.refId,
          facilitator: false,
          active: true,
          participantId: participant.id,
        }));
      const memberRows = [
        ...humanMemberRows,
        ...(facilitator === undefined
          ? []
          : [
              {
                id: `facilitator:${facilitator.id}`,
                label: "会议 Facilitator",
                kind: "ai",
                teammateId: "meeting-facilitator",
                tag: "会议服务",
                facilitator: true,
                active: true,
              },
            ]),
        ...aiMemberRows,
      ];
      const panelWorkspaceNameById = new Map(
        workspaceOptions.map((workspace) => [
          workspace.id,
          workspaceLabel(workspace),
        ]),
      );
      const panelTeammateById = new Map(
        teammates.map((teammate) => [teammate.id, teammate]),
      );
      const panelSearchScore = (item) => {
        const teammate = panelTeammateById.get(item.teammateInstanceId);
        return relevanceScore(
          [
            { text: item.title, weight: 1.3 },
            { text: teammate?.name, weight: 1.2 },
            { text: teammate?.ownerName, weight: 1.1 },
            { text: panelWorkspaceNameById.get(item.workspaceId), weight: 1 },
            { text: item.agenda, weight: 0.4 },
            { text: item.summary, weight: 0.35 },
            { text: meetingLastMessageText(item), weight: 0.45 },
          ],
          query,
        );
      };
      const matched = meetings
        .filter((item) => meetingHasConversation(item))
        .map((item) => ({
          item,
          score: normalizeSearchText(query) === "" ? 0 : panelSearchScore(item),
        }))
        .filter(({ score }) => normalizeSearchText(query) === "" || score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            String(meetingActivityTime(right.item) ?? "").localeCompare(
              String(meetingActivityTime(left.item) ?? ""),
            ),
        )
        .map(({ item }) => item);
      const myTeammates = teammates.filter((item) => item.state !== "archived");
      const activeTeammateIds = new Set(
        participants
          .filter((participant) => participant.status === "active")
          .map(
            (participant) =>
              participant.teammateInstanceId ?? participant.refId,
          ),
      );
      // 邀请对象不分人类/AI：一起列在一个可搜索的清单里。
      const inviteKeyword = inviteQuery.trim().toLowerCase();
      const inviteCandidates = [
        ...people.map((person) => ({
          key: `human:${person.id}`,
          kind: "human",
          name: person.name,
          inMeeting: person.state === "active",
        })),
        ...myTeammates.map((item) => ({
          key: `ai:${item.id}`,
          kind: "ai",
          name: item.name,
          avatar: item.avatar,
          source: item.source,
          // 平台「会议 Facilitator」实例就是会议里的 Facilitator 席位：
          // facilitator 已启用 ⇔ 它已在会议中，两者是同一件事。
          inMeeting:
            activeTeammateIds.has(item.id) ||
            (facilitator !== undefined && item.id === "meeting-facilitator"),
        })),
      ].filter(
        (candidate) =>
          inviteKeyword === "" ||
          candidate.name.toLowerCase().includes(inviteKeyword),
      );
      const post = (path, body) =>
        request(path, { method: "POST", body: JSON.stringify(body) });
      const run = async (labelOrAction, maybeAction) => {
        const label =
          typeof labelOrAction === "string" ? labelOrAction : "run";
        const action =
          typeof maybeAction === "function" ? maybeAction : labelOrAction;
        setBusy(label);
        setError("");
        setNotice("");
        try {
          await action();
          setRefreshKey((key) => key + 1);
          store.bumpChange("panel");
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };
      const uploadFile = async (file) => {
        if (file === undefined) return;
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result ?? "").split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        await run(() =>
          post("/api/collab/meeting/file", {
            meetingId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            data,
          }),
        );
      };
      const saveTitle = async () => {
        const next = titleDraft.trim();
        if (next === "") return;
        await run(async () => {
          await post("/api/collab/meeting/update", { meetingId, title: next });
          setNotice("会议名称已更新");
        });
      };
      const removePanelMember = async (row) => {
        await run(() =>
          row.facilitator
            ? post("/api/collab/meeting/facilitator/close", { meetingId })
            : post("/api/collab/meeting/participant/remove", {
                meetingId,
                participantId: row.participantId,
              }),
        );
      };
      const confirmInvite = async () => {
        const humans = inviteSelected
          .filter((key) => key.startsWith("human:"))
          .map((key) => key.slice("human:".length));
        const instances = inviteSelected
          .filter((key) => key.startsWith("ai:"))
          .map((key) => key.slice("ai:".length));
        await run(async () => {
          if (humans.length > 0) {
            await post("/api/collab/meeting/participants/invite", {
              meetingId,
              people: humans.map((id) => ({ targetId: id })),
            });
          }
          for (const instanceId of instances) {
            if (instanceId === "meeting-facilitator") {
              // 邀请平台 Facilitator 实例 = 启用会议 AI Facilitator（同一状态）。
              if (facilitator === undefined) {
                await post("/api/collab/meeting/facilitator/open", {
                  meetingId,
                });
              }
              continue;
            }
            const teammate = teammates.find((item) => item.id === instanceId);
            await post("/api/collab/meeting/participant/ai", {
              meetingId,
              teammateInstanceId: instanceId,
              displayName: teammate?.name ?? instanceId,
              speechMode: "mention",
            });
          }
          setInviteSelected([]);
          setInviteOpen(false);
          setNotice("已发送邀请");
        });
      };
      const openConversation = (item) => {
        setMeetingId(item.id);
        setPanelView("detail");
        setSwitcherOpen(false);
        setQuery("");
      };
      const createMeeting = async () => {
        const title = newMeetingTitle.trim();
        if (title === "" || busy !== "") return;
        setBusy("new-meeting");
        setError("");
        try {
          const result = await post("/api/collab/meetings", {
            workspaceId: newWorkspaceId,
            title,
            displayName: accountName,
          });
          if (result?.meeting?.id) {
            const created = Object.assign({}, result.meeting, {
              messageCount: 0,
              unreadCount: 0,
              lastActivityAt: result.meeting.updatedAt,
              lastMessage: null,
            });
            setMeetings((current) => [
              created,
              ...current.filter((item) => item.id !== created.id),
            ]);
            setMeetingId(created.id);
            setPanelView("detail");
            setNewMeetingTitle("");
          }
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };
      const createAiConversation = async (teammate) => {
        if (busy !== "") return;
        setBusy(`new-ai:${teammate.id}`);
        setError("");
        try {
          const result = await post("/api/collab/meetings", {
            workspaceId: SYSTEM_DEFAULT_WORKSPACE_ID,
            title: teammate.name,
            kind: "ai",
            teammateInstanceId: teammate.id,
            teammateName: teammate.name,
            displayName: accountName,
          });
          if (result?.meeting?.id) {
            const existing = meetings.find(
              (item) => item.id === result.meeting.id,
            );
            const created = Object.assign(
              {},
              existing,
              result.meeting,
              {
                messageCount:
                  result.meeting.messageCount ??
                  existing?.messageCount ??
                  0,
                unreadCount:
                  result.meeting.unreadCount ??
                  existing?.unreadCount ??
                  0,
                lastActivityAt:
                  result.meeting.lastActivityAt ??
                  existing?.lastActivityAt ??
                  result.meeting.updatedAt,
              },
            );
            setMeetings((current) => [
              created,
              ...current.filter((item) => item.id !== created.id),
            ]);
            setMeetingId(created.id);
            setPanelView("detail");
          }
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };
      const panelHeaderAvatar =
        panelView !== "detail" || meeting === undefined
          ? null
          : isAiConversation
            ? h(
                "span",
                {
                  style: Object.assign(
                    {},
                    panelStyles.headerAvatar,
                    teammateRingStyle(
                      aiConversationTeammate?.source === "platform",
                    ),
                    { height: 30, padding: 2, width: 30 },
                  ),
                  title: meeting.title,
                  "aria-label": `${meeting.title} 头像`,
                },
                avatarArt(aiConversationTeammate?.avatar),
              )
            : h(
                "span",
                {
                  style: Object.assign(
                    {},
                    panelStyles.headerAvatar,
                    panelStyles.meetingAvatar,
                    { height: 30, width: 30 },
                  ),
                  title: meeting.title,
                  "aria-label": `${meeting.title} 头像`,
                },
                videoIcon(),
              );
      const communicationRowNode = (item) => {
        const aiConversation = item.kind === "ai";
        const teammate = aiConversation
          ? teammates.find(
              (candidate) => candidate.id === item.teammateInstanceId,
            )
          : undefined;
        const workspaceName = panelWorkspaceNameById.get(item.workspaceId);
        const meta = aiConversation
          ? [
              teammate?.ownerName ? `${teammate.ownerName} 的 AI` : "AI 伙伴",
              workspaceName,
            ]
          : [
              item.status === "active"
                ? ""
                : meetingStatusLabel(item.status),
              workspaceName,
            ];
        return h(
          "button",
          {
            type: "button",
            key: item.id,
            "aria-label": `打开沟通 ${item.title}`,
            style: Object.assign(
              {},
              panelStyles.dropdownItem,
              panelStyles.dropdownItemIdle,
              item.id === meetingId ? panelStyles.dropdownItemActive : {},
            ),
            onClick: () => openConversation(item),
          },
          aiConversation
            ? h(
                "span",
                {
                  style: Object.assign(
                    {},
                    panelStyles.dropdownAvatar,
                    teammateRingStyle(teammate?.source === "platform"),
                  ),
                  title: item.title,
                  "aria-label": `${item.title} 头像`,
                },
                avatarArt(teammate?.avatar),
              )
            : h(
                "span",
                {
                  style: panelStyles.meetingAvatar,
                  title: item.title,
                  "aria-label": `${item.title} 头像`,
                },
                videoIcon(),
              ),
          h("span", { style: panelStyles.switchCopy }, [
            h("span", {
              style: panelStyles.switchName,
              children: item.title,
            }),
            h("span", {
              style: panelStyles.switchMeta,
              children: meta.filter(Boolean).join(" · "),
            }),
          ]),
          h("time", {
            style: panelStyles.switchTime,
            dateTime: meetingActivityTime(item),
            children: timeShort(meetingActivityTime(item)) || "—",
          }),
        );
      };
      const listView = h(
        "div",
        { style: panelStyles.contentView },
        h("input", {
          style: Object.assign({}, panelStyles.search, {
            boxSizing: "border-box",
            flex: "0 0 auto",
            height: 34,
            minHeight: 34,
          }),
          value: query,
          placeholder: "搜索沟通",
          "aria-label": "搜索沟通",
          onChange: (event) => setQuery(event.target.value),
        }),
        h(
          "div",
          {
            style: Object.assign({}, panelStyles.dropdownList, {
              flex: 1,
              maxHeight: "none",
            }),
          },
          ...(matched.length === 0
            ? [
                h("div", {
                  style: panelStyles.meta,
                  children: "暂无有历史记录的沟通",
                }),
              ]
            : matched.map((item) => communicationRowNode(item))),
        ),
      );
      const newCommunicationView = h(
        "div",
        { style: panelStyles.newView },
        h("div", { style: panelStyles.listSection }, [
          h("div", {
            style: panelStyles.sectionTitle,
            children: "与 AI 伙伴开始对话",
          }),
          h(
            "div",
            { style: panelStyles.dropdownList },
            ...(myTeammates.length === 0
              ? [
                  h("div", {
                    style: panelStyles.meta,
                    children: "暂无可用的 AI 伙伴",
                  }),
                ]
              : myTeammates.map((teammate) =>
                  h(
                    "button",
                    {
                      key: teammate.id,
                      type: "button",
                      style: Object.assign(
                        {},
                        panelStyles.dropdownItem,
                        panelStyles.dropdownItemIdle,
                      ),
                      "aria-label": `与 ${teammate.name} 开始对话`,
                      disabled: busy !== "",
                      onClick: () => void createAiConversation(teammate),
                    },
                    h(
                      "span",
                      {
                        style: Object.assign(
                          {},
                          panelStyles.dropdownAvatar,
                          teammateRingStyle(teammate.source === "platform"),
                        ),
                      },
                      avatarArt(teammate.avatar),
                    ),
                    h("span", { style: panelStyles.switchCopy }, [
                      h("span", {
                        style: panelStyles.switchName,
                        children: teammate.name,
                      }),
                      h("span", {
                        style: panelStyles.switchMeta,
                        children: teammate.ownerName
                          ? `${teammate.ownerName} 的 AI · 默认对话`
                          : "AI 伙伴 · 默认对话",
                      }),
                    ]),
                  ),
                )),
          ),
        ]),
        h("div", { style: panelStyles.divider }),
        h("form", {
          style: panelStyles.listSection,
          onSubmit: (event) => {
            event.preventDefault();
            void createMeeting();
          },
        }, [
          h("div", {
            style: panelStyles.sectionTitle,
            children: "新建会议",
          }),
          h("label", { style: panelStyles.field }, [
            h("span", { children: "会议主题" }),
            h("input", {
              style: panelStyles.search,
              value: newMeetingTitle,
              placeholder: "输入会议主题",
              "aria-label": "新沟通会议主题",
              onChange: (event) => setNewMeetingTitle(event.target.value),
            }),
          ]),
          h("label", { style: panelStyles.field }, [
            h("span", { children: "关联项目" }),
            h(
              "select",
              {
                style: panelStyles.search,
                value: newWorkspaceId,
                "aria-label": "新沟通关联项目",
                onChange: (event) => setNewWorkspaceId(event.target.value),
              },
              ...workspaceOptions.map((workspace) =>
                h("option", {
                  key: workspace.id,
                  value: workspace.id,
                  children: workspaceLabel(workspace),
                }),
              ),
            ),
          ]),
          h(
            "div",
            { style: { display: "flex", justifyContent: "flex-end" } },
            h("button", {
              type: "submit",
              style: Object.assign(
                {},
                panelStyles.btnPrimary,
                busy !== "" || newMeetingTitle.trim() === ""
                  ? { cursor: "default", opacity: 0.5 }
                  : {},
              ),
              disabled: busy !== "" || newMeetingTitle.trim() === "",
              children: busy === "new-meeting" ? "创建中…" : "创建会议",
            }),
          ),
        ]),
      );
      const headerTitle =
        panelView === "list"
          ? "沟通"
          : panelView === "new"
            ? "新建沟通"
            : (meeting?.title ?? "沟通");
      const headerMeta =
        panelView === "detail" && meeting
          ? isAiConversation
            ? `${aiConversationTeammate?.ownerName ? `${aiConversationTeammate.ownerName} 的 AI` : "AI 伙伴"} · ${meetingTimeLabel(meeting)}`
            : `${meetingTimeLabel(meeting)} · ${meetingStatusLabel(meeting.status)} · ${participants.filter((participant) => participant.status === "active").length} 人 · ${panelAiCount} 个 AI`
          : null;

      return h(
        "div",
        { style: panelStyles.root },
        h("div", { style: panelStyles.panel }, [
          h("div", { style: panelStyles.head }, [
            panelView !== "list"
              ? h(
                  "button",
                  {
                    type: "button",
                    style: panelStyles.iconBtn,
                    title: "返回沟通列表",
                    "aria-label": "返回沟通列表",
                    onClick: () => setPanelView("list"),
                  },
                  backIcon(),
                )
              : null,
            panelHeaderAvatar,
            h("div", { style: { flex: 1, minWidth: 0 } }, [
              h("div", { style: panelStyles.titleWrap }, [
                h("span", {
                  style: panelStyles.titleText,
                  title: headerTitle,
                  children: headerTitle,
                }),
                panelView === "detail" && meeting
                  ? h(
                      "button",
                      {
                        ref: switcherButtonRef,
                        type: "button",
                        style: panelStyles.iconGhost,
                        title: "搜索 / 切换沟通",
                        "aria-label": "切换沟通",
                        "aria-haspopup": "dialog",
                        "aria-expanded": switcherOpen,
                        onClick: () =>
                          setSwitcherOpen((value) => !value),
                      },
                      searchIcon(),
                    )
                  : null,
                panelView === "detail" &&
                meeting &&
                (isAiConversation || facilitator)
                  ? h("span", { style: panelStyles.aiBadge, children: "AI" })
                  : null,
              ]),
              headerMeta !== null
                ? h("div", {
                    style: panelStyles.meta,
                    children: headerMeta,
                  })
                : null,
            ]),
            h(
              "button",
              {
                type: "button",
                style: panelStyles.iconBtn,
                title: "新建沟通",
                "aria-label": "新建沟通",
                onClick: () => {
                  setPanelView("new");
                  setNewMeetingTitle("");
                },
              },
              plusCircleIcon(),
            ),
          ]),
          panelView === "detail" && switcherOpen
            ? h(
                "div",
                {
                  ref: switcherPanelRef,
                  role: "dialog",
                  "aria-label": "切换沟通",
                  style: panelStyles.dropdown,
                },
                h("input", {
                  style: Object.assign({}, panelStyles.search, {
                    background: "var(--dsw-alias-bg-base)",
                    borderColor: "var(--dsw-alias-border-l3)",
                    boxSizing: "border-box",
                    flex: "0 0 auto",
                    height: 34,
                    minHeight: 34,
                  }),
                  value: query,
                  placeholder: "搜索沟通",
                  "aria-label": "搜索并切换沟通",
                  autoFocus: true,
                  onChange: (event) => setQuery(event.target.value),
                }),
                h(
                  "div",
                  {
                    style: Object.assign({}, panelStyles.dropdownList, {
                      maxHeight: 240,
                    }),
                  },
                  ...(matched.length === 0
                    ? [
                        h("div", {
                          style: panelStyles.meta,
                          children: "没有匹配的历史沟通",
                        }),
                      ]
                    : matched.map((item) => communicationRowNode(item))),
                ),
                h(
                  "div",
                  { style: panelStyles.dropdownFooter },
                  h("button", {
                    type: "button",
                    style: Object.assign({}, panelStyles.textLink, {
                      background: "transparent",
                      border: "none",
                      font: "inherit",
                      padding: 0,
                    }),
                    onClick: () => {
                      setSwitcherOpen(false);
                      setPanelView("list");
                    },
                    children: "查看沟通列表",
                  }),
                ),
              )
            : null,
          error
            ? h("div", { style: panelStyles.error, children: error })
            : null,
          notice
            ? h("div", { style: panelStyles.notice, children: notice })
            : null,
          panelView === "list"
            ? listView
            : panelView === "new"
              ? newCommunicationView
              : h("div", { style: panelStyles.detailView }, [
          meeting && !isAiConversation
            ? h(
                "div",
                {
                  role: "tablist",
                  "aria-label": "会议侧栏页签",
                  style: panelStyles.tabs,
                },
                ...[
                  ["conversation", "对话"],
                  ["minutes", "纪要"],
                  ["settings", "设置"],
                ].map(([key, label]) =>
                  h("button", {
                    key,
                    type: "button",
                    role: "tab",
                    style: Object.assign(
                      {},
                      panelStyles.tab,
                      activePanelTab === key ? panelStyles.tabActive : {},
                    ),
                    "aria-selected": activePanelTab === key,
                    onClick: () => setPanelTab(key),
                    children: label,
                  }),
                ),
              )
            : null,
          activePanelTab === "settings" && meeting
            ? h("div", { style: panelStyles.settings }, [
                // 会议名称默认就是可编辑态，不需要先点一下才能改。
                h("div", { style: panelStyles.block }, [
                  h("div", {
                    style: panelStyles.groupTitle,
                    children: "会议名称",
                  }),
                  h(
                    "div",
                    {
                      style: { alignItems: "center", display: "flex", gap: 8 },
                    },
                    h("input", {
                      style: Object.assign({}, panelStyles.search, { flex: 1 }),
                      value: titleDraft,
                      placeholder: "会议名称",
                      "aria-label": "会议名称",
                      onChange: (event) => setTitleDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveTitle();
                        }
                      },
                    }),
                    h("button", {
                      type: "button",
                      style: Object.assign(
                        {},
                        panelStyles.btnPrimary,
                        busy !== "" ||
                          titleDraft.trim() === "" ||
                          titleDraft.trim() === meeting.title
                          ? { cursor: "default", opacity: 0.5 }
                          : {},
                      ),
                      disabled:
                        busy !== "" ||
                        titleDraft.trim() === "" ||
                        titleDraft.trim() === meeting.title,
                      onClick: () => void saveTitle(),
                      children: "保存",
                    }),
                  ),
                ]),
                h("div", { style: panelStyles.divider }),
                h("div", { style: panelStyles.block }, [
                  h("div", {
                    style: panelStyles.groupTitle,
                    children: "AI 会议 Facilitator",
                  }),
                  h(
                    "label",
                    {
                      style: {
                        alignItems: "center",
                        background: "var(--dsw-alias-bg-layer-1)",
                        border: "0.5px solid var(--dsw-alias-border-l3)",
                        borderRadius: 6,
                        cursor:
                          meeting.status === "archived" || busy !== ""
                            ? "not-allowed"
                            : "pointer",
                        display: "flex",
                        gap: 8,
                        opacity:
                          meeting.status === "archived" || busy !== ""
                            ? 0.55
                            : 1,
                        padding: "8px 9px",
                      },
                    },
                    h("input", {
                      type: "checkbox",
                      checked: facilitator !== undefined,
                      disabled: meeting.status === "archived" || busy !== "",
                      onChange: (event) =>
                        void run(() =>
                          event.target.checked
                            ? post("/api/collab/meeting/facilitator/open", {
                                meetingId,
                              })
                            : post("/api/collab/meeting/facilitator/close", {
                                meetingId,
                              }),
                        ),
                    }),
                    h("span", {
                      style: {
                        flex: 1,
                        fontSize: 12,
                        fontWeight: 500,
                      },
                      children: "启用 AI 会议 Facilitator",
                    }),
                    h("span", {
                      style: panelStyles.meta,
                      children: facilitator ? "已启用" : "未启用",
                    }),
                  ),
                ]),
                h("div", { style: panelStyles.divider }),
                h("div", { style: panelStyles.block }, [
                  h(
                    "div",
                    {
                      style: { alignItems: "center", display: "flex", gap: 8 },
                    },
                    h("span", {
                      style: panelStyles.groupTitle,
                      children: "会议成员",
                    }),
                    h("span", { style: { flex: 1 } }),
                    h("button", {
                      type: "button",
                      style: Object.assign(
                        {},
                        panelStyles.btnPrimary,
                        busy !== ""
                          ? { cursor: "not-allowed", opacity: 0.55 }
                          : {},
                      ),
                      disabled: busy !== "",
                      onClick: () => {
                        setInviteQuery("");
                        setInviteSelected([]);
                        setInviteOpen(true);
                      },
                      children: "邀请成员",
                    }),
                  ),
                  ...memberRows.map((row) => {
                    const teammate =
                      row.kind === "ai"
                        ? teammates.find(
                            (item) =>
                              item.id === row.teammateId ||
                              item.name === row.label,
                          )
                        : undefined;
                    return h(
                      "div",
                      { key: row.id, style: panelStyles.checkRow },
                      row.kind === "ai"
                        ? h(
                            "span",
                            {
                              style: teammateRingStyle(
                                teammate?.source === "platform",
                              ),
                            },
                            avatarArt(teammate?.avatar),
                          )
                        : h(
                            "span",
                            { style: initialsAvatarStyle },
                            initials(row.label),
                          ),
                      h("span", {
                        style: panelStyles.name,
                        children: row.label,
                      }),
                      row.tag
                        ? h("span", {
                            style: panelStyles.chip,
                            children: row.tag,
                          })
                        : null,
                      row.active
                        ? h("button", {
                            type: "button",
                            style: panelStyles.btn,
                            disabled: busy !== "",
                            onClick: () => void removePanelMember(row),
                            children: "移除",
                          })
                        : h("span", {
                            style: panelStyles.meta,
                            children: "已离会",
                          }),
                    );
                  }),
                ]),
              ])
            : !meeting
              ? h("div", { style: panelStyles.meta, children: "请选择会议" })
              : activePanelTab === "minutes"
                  ? h("div", { style: panelStyles.panelSection }, [
                      h("div", { style: panelStyles.summarySectionHead }, [
                        h("div", {
                          style: { fontSize: 13, fontWeight: 600 },
                          children: "会议纪要",
                        }),
                        h(
                          "div",
                          { style: { display: "flex", gap: 6 } },
                          panelMinutesVersion === undefined
                            ? null
                            : h("button", {
                                type: "button",
                                style: panelStyles.btn,
                                title: "下载 Markdown",
                                "aria-label": "下载会议纪要 Markdown",
                                onClick: () =>
                                  downloadMinutesMarkdown(
                                    meeting,
                                    panelMinutesVersion,
                                  ),
                                children: [
                                  downloadIcon(),
                                  h("span", { children: "下载" }),
                                ],
                              }),
                          meeting.status !== "archived" &&
                          facilitator !== undefined
                            ? h("button", {
                                type: "button",
                                style: panelStyles.btn,
                                disabled: busy !== "" || !joined,
                                onClick: () => {
                                  if (panelMinutesVersion !== undefined) {
                                    setMinutesOverwriteOpen(true);
                                    return;
                                  }
                                  void run("minutes", () =>
                                    post(
                                      "/api/collab/meeting/minutes/trigger",
                                      { meetingId },
                                    ),
                                  );
                                },
                                children:
                                  busy === "minutes"
                                    ? "生成中…"
                                    : "更新纪要",
                              })
                            : null,
                        ),
                      ]),
                      panelMinutesVersion === undefined
                        ? h("div", {
                            style: panelStyles.meta,
                            children: "暂无会议纪要",
                          })
                        : h(
                            "div",
                            { style: panelStyles.minutesBody },
                            renderChatMarkdown(panelMinutesVersion.content),
                          ),
                      panelMinutesVersion === undefined
                        ? null
                        : h("div", {
                            style: panelStyles.meta,
                            children: `更新于：${timeFull(
                              panelMinutesVersion.updatedAt ??
                                panelMinutesVersion.createdAt,
                            )}`,
                          }),
                    ])
              : h("div", { style: panelStyles.chat }, [
                  h(
                    "div",
                    {
                      ref: messagesRef,
                      style: panelStyles.stream,
                    },
                    ...transcript.map((message) => {
                      if (message.senderKind === "system")
                        return h("div", {
                          key: message.id,
                          style: panelStyles.systemMessage,
                          children: displayContent(message.content),
                        });
                      const mine =
                        message.senderKind === "human" &&
                        message.senderId === actorId;
                      const label =
                        message.provenance?.role === "representative"
                          ? `${message.senderName} · AI 参会代表`
                          : message.senderKind === "agent"
                            ? `${message.senderName} · AI`
                            : mine
                              ? "我"
                              : message.senderName;
                      return h(
                        "div",
                        {
                          key: message.id,
                          style: {
                            alignItems: "flex-start",
                            display: "flex",
                            flexDirection: mine ? "row-reverse" : "row",
                            gap: 8,
                          },
                        },
                        chatAvatar(message, mine, teammates),
                        h(
                          "div",
                          {
                            style: {
                              alignItems: mine ? "flex-end" : "flex-start",
                              display: "flex",
                              flexDirection: "column",
                              gap: 2,
                              maxWidth: "calc(100% - 34px)",
                              minWidth: 0,
                            },
                          },
                          h("div", {
                            style: panelStyles.meta,
                            children: `${label} · ${timeShort(message.createdAt)}`,
                          }),
                          h(
                            "div",
                            {
                              style: Object.assign(
                                {},
                                panelStyles.bubble,
                                mine ? panelStyles.bubbleMine : {},
                              ),
                            },
                            h(
                              "div",
                              null,
                              renderChatMarkdown(
                                displayContent(message.content),
                              ),
                            ),
                          ),
                        ),
                      );
                    }),
                    transcript.length === 0
                      ? h("div", {
                          style: panelStyles.meta,
                          children: "暂无消息",
                        })
                      : null,
                  ),
                  meeting.status === "active"
                    ? joined
                      ? h(
                          "form",
                          {
                            style: {
                              background:
                                "var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))",
                              border:
                                "0.5px solid var(--dsw-alias-border-l3)",
                              borderRadius: 6,
                              flexShrink: 0,
                              margin: "0 8px 8px",
                              padding: 8,
                              position: "relative",
                            },
                            onSubmit: async (event) => {
                              event.preventDefault();
                              const text = content.trim();
                              if (text === "") return;
                              setContent("");
                              closePanelMention();
                              await run(() =>
                                post("/api/collab/meeting/message", {
                                  meetingId,
                                  content: text,
                                  mentions: mentionIds,
                                }),
                              );
                              setMentionIds([]);
                            },
                          },
                          h(
                            "div",
                            { style: panelStyles.composer },
                            h(
                              "button",
                              {
                                type: "button",
                                style: panelStyles.composerBtn,
                                title: "上传文件",
                                "aria-label": "上传文件",
                                onClick: () => fileRef.current?.click(),
                              },
                              clipIcon(),
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                style: panelStyles.composerBtn,
                                title: "提及成员",
                                "aria-label": "提及成员",
                                onClick: togglePanelMention,
                              },
                              atIcon(),
                            ),
                            h("input", {
                              ref: fileRef,
                              type: "file",
                              style: { display: "none" },
                              onChange: (event) => {
                                const file = event.target.files?.[0];
                                if (file !== undefined) void uploadFile(file);
                                event.target.value = "";
                              },
                            }),
                            mentionOpen
                              ? panelMentionOptions.length > 0
                                ? h(
                                    "div",
                                    { style: panelStyles.mentionMenu },
                                    ...panelMentionOptions.map((participant) =>
                                      h(
                                        "button",
                                        {
                                          type: "button",
                                          key: participant.id,
                                          style: panelStyles.mentionItem,
                                          onClick: () =>
                                            pickPanelMention(participant),
                                        },
                                        participantAvatarNode(
                                          participant,
                                          teammates,
                                        ),
                                        h(
                                          "span",
                                          { style: panelStyles.mentionCopy },
                                          h("span", {
                                            style: panelStyles.mentionName,
                                            children: participant.displayName,
                                          }),
                                          h("span", {
                                            style: panelStyles.mentionMeta,
                                            children:
                                              participant.kind === "human"
                                                ? "会议成员"
                                                : participant.ownerName
                                                  ? `${participant.ownerName} 的 AI`
                                                  : "AI 成员",
                                          }),
                                        ),
                                      ),
                                    ),
                                  )
                                : h(
                                    "div",
                                    { style: panelStyles.mentionMenu },
                                    h("div", {
                                      style: panelStyles.mentionItem,
                                      children: "没有匹配成员",
                                    }),
                                  )
                              : null,
                          ),
                          h(
                            "div",
                            {
                              style: {
                                alignItems: "flex-end",
                                display: "flex",
                                gap: 6,
                                marginTop: 6,
                              },
                            },
                            h("textarea", {
                              ref: composerInputRef,
                              style: Object.assign({}, panelStyles.textarea, {
                                background: "transparent",
                                border: "none",
                                minHeight: 64,
                                padding: 2,
                              }),
                              value: content,
                              placeholder: "输入消息，@ 成员…",
                              onChange: (event) =>
                                panelMentionChanged(event.target.value),
                            }),
                            h("button", {
                              type: "submit",
                              style: Object.assign({}, panelStyles.sendBtn, {
                                opacity:
                                  busy !== "" || content.trim() === ""
                                    ? 0.45
                                    : 1,
                              }),
                              title: "发送消息",
                              "aria-label": "发送消息",
                              disabled: busy !== "" || content.trim() === "",
                              children: sendIcon(),
                            }),
                          ),
                        )
                      : h(
                          "div",
                          { style: { padding: 10 } },
                          h("button", {
                            type: "button",
                            style: panelStyles.btn,
                            disabled: busy !== "",
                            onClick: () =>
                              run(() =>
                                post("/api/collab/meeting/join", {
                                  meetingId,
                                  displayName:
                                    accountName ||
                                    `用户-${actorId.slice(0, 6)}`,
                                }),
                              ),
                            children: "加入会议",
                          }),
                        )
                    : null,
                ]),
          minutesOverwriteOpen && meeting
            ? h(
                "div",
                { style: panelStyles.dialogOverlay },
                h("div", { style: panelStyles.dialog }, [
                  h("div", {
                    style: panelStyles.dialogTitle,
                    children: "重新生成会议纪要？",
                  }),
                  h("div", {
                    style: panelStyles.meta,
                    children:
                      "当前会议纪要已有内容，重新生成会覆盖原有内容。",
                  }),
                  h("div", { style: panelStyles.dialogActions }, [
                    h("button", {
                      type: "button",
                      style: panelStyles.btn,
                      onClick: () => setMinutesOverwriteOpen(false),
                      children: "取消",
                    }),
                    h("button", {
                      type: "button",
                      style: panelStyles.btnPrimary,
                      disabled: busy !== "",
                      onClick: () => {
                        setMinutesOverwriteOpen(false);
                        void run("minutes", () =>
                          post("/api/collab/meeting/minutes/trigger", {
                            meetingId,
                          }),
                        );
                      },
                      children: "覆盖生成",
                    }),
                  ]),
                ]),
              )
            : null,
          inviteOpen && meeting
            ? h(
                "div",
                { style: panelStyles.dialogOverlay },
                h("div", { style: panelStyles.dialog }, [
                  h("div", {
                    style: panelStyles.dialogTitle,
                    children: "邀请成员",
                  }),
                  h("input", {
                    style: Object.assign({}, panelStyles.search, {
                      flex: "none",
                    }),
                    value: inviteQuery,
                    placeholder: "搜索成员或 AI伙伴",
                    "aria-label": "搜索邀请对象",
                    onChange: (event) => setInviteQuery(event.target.value),
                  }),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        maxHeight: 260,
                        overflowY: "auto",
                      },
                    },
                    ...(inviteCandidates.length === 0
                      ? [
                          h("div", {
                            style: panelStyles.meta,
                            children: "无匹配成员",
                          }),
                        ]
                      : inviteCandidates.map((candidate) =>
                          h(
                            "label",
                            {
                              key: candidate.key,
                              style: Object.assign(
                                {},
                                panelStyles.checkRow,
                                candidate.inMeeting ? { opacity: 0.7 } : {},
                              ),
                            },
                            h("input", {
                              type: "checkbox",
                              // 已在会议中的成员直接勾选 + 禁用，不再写「（已在会议中）」。
                              checked:
                                candidate.inMeeting ||
                                inviteSelected.includes(candidate.key),
                              disabled: candidate.inMeeting,
                              onChange: (event) =>
                                setInviteSelected((current) =>
                                  event.target.checked
                                    ? [...current, candidate.key]
                                    : current.filter(
                                        (key) => key !== candidate.key,
                                      ),
                                ),
                            }),
                            // 头像样式参考任务管理页；AI 成员直接用 AI 图标表达身份。
                            candidate.kind === "ai"
                              ? h(
                                  "span",
                                  {
                                    style: teammateRingStyle(
                                      candidate.source === "platform",
                                    ),
                                  },
                                  avatarArt(candidate.avatar),
                                )
                              : h(
                                  "span",
                                  { style: initialsAvatarStyle },
                                  initials(candidate.name),
                                ),
                            h("span", {
                              style: panelStyles.name,
                              children: candidate.name,
                            }),
                          ),
                        )),
                  ),
                  h(
                    "div",
                    { style: panelStyles.dialogActions },
                    h("button", {
                      type: "button",
                      style: panelStyles.btn,
                      onClick: () => setInviteOpen(false),
                      children: "取消",
                    }),
                    h("button", {
                      type: "button",
                      style: Object.assign(
                        {},
                        panelStyles.btnPrimary,
                        busy !== "" || inviteSelected.length === 0
                          ? { cursor: "default", opacity: 0.5 }
                          : {},
                      ),
                      disabled: busy !== "" || inviteSelected.length === 0,
                      onClick: () => void confirmInvite(),
                      children: busy !== "" ? "处理中…" : "确认",
                    }),
                  ),
                ]),
              )
            : null,
                ]),
        ]),
      );
    };

    /* ── helpers ── */

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

    function workspaceLabel(workspace) {
      const title = workspace.title?.trim();
      if (title) return title;
      // 项目名缺失时才回退路径；右侧只展示项目名称，不展示完整路径。
      const path = workspace.path?.trim();
      if (path) return path;
      return `未知项目 (${workspace.id.slice(0, 8)})`;
    }

    /**
     * 会议关注按钮由 dsh-collab-workbench 提供：服务端持久化、跨页面同步。
     * 该插件未安装时按钮不渲染，会议面板保持原样。
     */
    function MeetingFollowButton(props) {
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
      return jsxRuntime.jsx(Button, {
        type: "meeting",
        id: props.meetingId,
        iconOnly: true,
        compact: true,
      });
    }

    /** 完整时间戳：yyyy-mm-dd hh:mm（纪要「更新时间」用）。 */
    function timeFull(iso) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return String(iso ?? "");
      const pad = (value) => String(value).padStart(2, "0");
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }

    function timeShort(iso) {
      const time = new Date(iso);
      if (Number.isNaN(time.getTime())) return iso ?? "";
      const now = new Date();
      const sameDay =
        time.getFullYear() === now.getFullYear() &&
        time.getMonth() === now.getMonth() &&
        time.getDate() === now.getDate();
      if (sameDay) {
        return time.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      }
      return time.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }

    /* ── meetings page (pluginmax.global slot) ── */

    const PS = {
      root: {
        background: "var(--dsw-alias-bg-base)",
        boxSizing: "border-box",
        color: "var(--dsw-alias-label-primary)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        height: "calc(100vh - 18px)",
        // 壳层页面高度是 auto（只设了 min-height），`height:100%` 解析不到，
        // 于是整页随消息一起被撑高、输入框被推走。用视口上限把高度兜住，
        // 中间沟通列改为内部滚动，输入框自然吸底。
        maxHeight: "calc(100vh - 18px)",
        minHeight: 0,
        padding: 18,
      },
      top: {
        alignItems: "center",
        display: "flex",
        flexShrink: 0,
        flexWrap: "wrap",
        gap: 8,
      },
      topActions: {
        alignItems: "center",
        display: "flex",
        flex: 1,
        flexWrap: "wrap",
        gap: 8,
        justifyContent: "flex-end",
        minWidth: 0,
      },
      topFilters: {
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        justifyContent: "flex-end",
        minWidth: 0,
      },
      // 与 AI Teammates 页标题对齐（.pmtm-head h1: 19px / line-height 1.3）。
      title: {
        flexShrink: 0,
        fontSize: 19,
        fontWeight: 600,
        lineHeight: 1.3,
        margin: 0,
        whiteSpace: "nowrap",
      },
      select: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        fontSize: 13,
        padding: "6px 8px",
      },
      primaryBtn: {
        // 与任务管理「新建任务」保持同一套主按钮样式。
        alignItems: "center",
        background:
          "var(--dsw-alias-button-primary-fill, var(--dsw-alias-accent-fill, #2f6feb))",
        border: "none",
        borderRadius: 6,
        color: "var(--dsw-alias-label-primary-foreground, #fff)",
        cursor: "pointer",
        display: "inline-flex",
        flexShrink: 0,
        fontSize: 12.5,
        fontWeight: 600,
        gap: 6,
        height: 34,
        justifyContent: "center",
        padding: "0 12px",
        whiteSpace: "nowrap",
      },
      sidebarBtn: {
        alignItems: "center",
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 34,
        placeItems: "center",
        width: 34,
      },
      sidebarBtnActive: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent)",
        borderColor:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 50%,transparent)",
        color: "var(--dsw-alias-accent-primary,#4f8ef7)",
      },
      ghostBtn: {
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        fontSize: 12,
        padding: "5px 9px",
      },
      body: {
        display: "grid",
        flex: 1,
        gap: 12,
        gridTemplateRows: "minmax(0,1fr)",
        minHeight: 0,
      },
      list: {
        border: "none",
        borderRadius: 0,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: 8,
        minWidth: 0,
        overflow: "visible",
      },
      listHeader: {
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: 8,
        padding: 0,
      },
      listItems: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        overflowY: "auto",
        padding: 0,
      },
      item: {
        background: "var(--dsw-alias-bg-layer-1)",
        // 固定使用不透明深灰，避免主题变量或透明度把边框渲染成白色。
        border: "1px solid #44454a",
        borderColor: "#44454a",
        borderRadius: 7,
        boxShadow: "none",
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        gap: 6,
        outline: "none",
        padding: "9px 10px",
        textAlign: "left",
        width: "100%",
      },
      itemIdle: {
        borderColor: "#44454a",
      },
      itemActive: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,var(--dsw-alias-bg-layer-1))",
        borderColor:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent)",
      },
      searchShell: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-base)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        display: "flex",
        gap: 7,
        height: 32,
        minWidth: 0,
        padding: "0 9px",
      },
      searchField: {
        background: "transparent",
        border: "none",
        color: "inherit",
        flex: 1,
        fontFamily: "inherit",
        fontSize: 12,
        minWidth: 0,
        outline: "none",
        padding: 0,
      },
      typeTags: {
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
      },
      typeTag: {
        background: "var(--dsw-alias-bg-layer-2)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 999,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        fontSize: 11,
        height: 28,
        padding: "0 12px",
        whiteSpace: "nowrap",
      },
      typeTagActive: {
        background: "var(--dsw-alias-accent-primary,#4f8ef7)",
        borderColor: "transparent",
        color: "#fff",
        fontWeight: 600,
      },
      iconBtn: {
        alignItems: "center",
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 32,
        placeItems: "center",
        padding: 0,
        width: 32,
      },
      threadHead: {
        alignItems: "center",
        display: "flex",
        gap: 7,
        minWidth: 0,
      },
      threadTitle: {
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.4,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      threadSub: {
        color: "var(--dsw-alias-label-tertiary)",
        flexShrink: 0,
        fontSize: 10,
        maxWidth: 84,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      unavailableTag: {
        background:
          "color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 14%,transparent)",
        border:
          "0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 42%,transparent)",
        borderRadius: 999,
        color: "var(--dsw-alias-state-error-primary,#e5534b)",
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 600,
        lineHeight: "18px",
        padding: "0 7px",
        whiteSpace: "nowrap",
      },
      threadPreview: {
        alignItems: "center",
        display: "flex",
        gap: 8,
        justifyContent: "space-between",
        minWidth: 0,
      },
      threadPreviewText: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 11,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      threadSpeaker: {
        color: "var(--dsw-alias-label-primary)",
        fontWeight: 600,
      },
      threadTime: {
        color: "var(--dsw-alias-label-tertiary)",
        flexShrink: 0,
        fontSize: 10,
        whiteSpace: "nowrap",
      },
      unreadBadge: {
        alignItems: "center",
        background: "var(--dsw-alias-accent-primary,#4f8ef7)",
        borderRadius: 999,
        color: "#fff",
        display: "inline-flex",
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 700,
        height: 18,
        justifyContent: "center",
        minWidth: 18,
        padding: "0 5px",
      },
      threadAvatar: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 6,
        color: "var(--dsw-alias-accent-primary)",
        display: "grid",
        flexShrink: 0,
        height: 24,
        placeItems: "center",
        width: 24,
      },
      listSection: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderTop: "0.5px solid var(--dsw-alias-border-l3)",
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        display: "flex",
        fontSize: 11,
        fontWeight: 600,
        justifyContent: "space-between",
        marginTop: 2,
        padding: "8px 4px 4px",
        textAlign: "left",
        width: "100%",
      },
      listSectionLabel: {
        alignItems: "center",
        display: "flex",
        gap: 6,
      },
      meta: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 },
      chat: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 8,
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
      },
      chatHead: {
        alignItems: "center",
        borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
        display: "flex",
        flexShrink: 0,
        flexWrap: "wrap",
        gap: 8,
        padding: "10px 12px",
      },
      stream: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        overflowY: "auto",
        padding: 12,
      },
      bubble: {
        background: "var(--dsw-alias-bg-layer-2)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: "3px 8px 8px 8px",
        fontSize: 13,
        lineHeight: 1.55,
        maxWidth: "100%",
        padding: "7px 10px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      },
      bubbleMine: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,var(--dsw-alias-bg-layer-2))",
        borderColor:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 35%,transparent)",
        borderRadius: "8px 3px 8px 8px",
      },
      systemMessage: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
        padding: "5px 0",
        textAlign: "center",
        width: "100%",
      },
      inputRow: {
        background:
          "var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1))",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: 6,
        margin: "0 10px 10px",
        padding: 8,
      },
      // 输入框上方的附件 / @ 操作位：小图标、浅背景、无边框（与右侧栏一致）。
      composerTools: { alignItems: "center", display: "flex", gap: 6 },
      composerBtn: {
        alignItems: "center",
        background: "transparent",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 26,
        placeItems: "center",
        width: 26,
      },
      sendBtn: {
        alignItems: "center",
        background: "var(--dsw-alias-accent-primary,#4f8ef7)",
        border: "none",
        borderRadius: 6,
        color: "#fff",
        cursor: "pointer",
        display: "grid",
        flexShrink: 0,
        height: 28,
        placeItems: "center",
        width: 28,
      },
      composerRow: { alignItems: "flex-end", display: "flex", gap: 8 },
      mentionMenu: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        bottom: "100%",
        boxShadow: "0 12px 28px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        left: 10,
        maxHeight: 200,
        overflowY: "auto",
        padding: 4,
        position: "absolute",
        right: 10,
        zIndex: 20,
      },
      mentionItem: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        fontSize: 12,
        gap: 8,
        padding: "6px 7px",
        textAlign: "left",
        width: "100%",
      },
      mentionCopy: { display: "grid", gap: 1, minWidth: 0, textAlign: "left" },
      mentionName: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      mentionMeta: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
        lineHeight: 1.35,
      },
      textarea: {
        background: "transparent",
        border: "none",
        borderRadius: 0,
        color: "inherit",
        flex: 1,
        fontFamily: "inherit",
        fontSize: 13,
        minHeight: 72,
        padding: 2,
        resize: "vertical",
      },
      side: {
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
        width: 300,
      },
      tabs: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "flex",
        flexShrink: 0,
        gap: 2,
        margin: 8,
        padding: 3,
      },
      tab: {
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "inherit",
        cursor: "pointer",
        flex: 1,
        fontSize: 12,
        padding: "5px 8px",
      },
      tabActive: {
        background: "#4f8ef7",
        color: "#fff",
        fontWeight: 600,
      },
      centerTabs: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "inline-flex",
        flexShrink: 0,
        gap: 2,
        padding: 3,
      },
      centerTab: {
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        flex: 1,
        fontSize: 12,
        minWidth: 68,
        padding: "6px 8px",
        whiteSpace: "nowrap",
      },
      centerSettings: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        overflowY: "auto",
        padding: 12,
      },
      centerMembers: { display: "grid", gap: 6 },
      centerMember: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 6,
        display: "flex",
        gap: 8,
        padding: "7px 9px",
      },
      centerMemberCopy: {
        display: "grid",
        flex: 1,
        gap: 1,
        minWidth: 0,
      },
      centerMemberName: {
        fontSize: 12,
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      sideBody: {
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 10,
        overflowY: "auto",
        padding: 12,
      },
      group: { display: "flex", flexDirection: "column", gap: 4 },
      summaryCard: {
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 10,
      },
      summaryHead: {
        alignItems: "center",
        display: "flex",
        gap: 8,
        justifyContent: "space-between",
      },
      summaryFacts: {
        display: "grid",
        gap: 6,
        gridTemplateColumns: "repeat(2,minmax(0,1fr))",
      },
      summaryFact: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderRadius: 6,
        display: "grid",
        gap: 1,
        minWidth: 0,
        padding: "7px 8px",
      },
      summaryLabel: {
        color: "var(--dsw-alias-label-tertiary)",
        fontSize: 10,
      },
      summaryValue: {
        fontSize: 12,
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      summaryActions: {
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
      },
      statusPill: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent)",
        borderRadius: 999,
        color: "var(--dsw-alias-accent-primary,#4f8ef7)",
        fontSize: 10,
        padding: "1px 7px",
      },
      briefSection: {
        background: "var(--dsw-alias-bg-layer-2)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "grid",
        gap: 4,
        padding: "8px 10px",
      },
      briefSectionTitle: { fontSize: 12, fontWeight: 600 },
      groupTitle: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 11,
        fontWeight: 600,
      },
      row: { alignItems: "center", display: "flex", gap: 6, fontSize: 13 },
      tag: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderRadius: 4,
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 10,
        padding: "1px 5px",
      },
      pre: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: 6,
        fontFamily: "inherit",
        fontSize: 12,
        margin: 0,
        maxHeight: 320,
        overflow: "auto",
        padding: 10,
        whiteSpace: "pre-wrap",
      },
      overlay: {
        alignItems: "center",
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        position: "fixed",
        zIndex: 60,
      },
      modal: {
        background: "var(--dsw-alias-bg-layer-1)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxHeight: "86vh",
        overflowY: "auto",
        padding: 18,
        width: "min(560px, 92vw)",
      },
      field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12 },
      input: {
        background: "var(--dsw-alias-bg-base)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        fontFamily: "inherit",
        fontSize: 13,
        padding: "7px 9px",
      },
      filterSegment: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "0.5px solid var(--dsw-alias-border-l3)",
        borderRadius: 7,
        display: "inline-flex",
        flexShrink: 0,
        gap: 2,
        padding: 2,
      },
      filterBtn: {
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        fontSize: 11,
        height: 28,
        padding: "0 9px",
        whiteSpace: "nowrap",
      },
      filterBtnActive: {
        background: "#4f8ef7",
        color: "#fff",
        fontWeight: 600,
      },
      // Fixed toast: never participates in layout, so showing/hiding a notice
      // cannot reflow the page under a pointer mid-click.
      banner: {
        borderRadius: 6,
        bottom: 16,
        boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
        fontSize: 12,
        maxWidth: "50vw",
        padding: "7px 10px",
        position: "fixed",
        right: 16,
        zIndex: 70,
      },
      error: { background: "rgba(220,60,60,0.14)", color: "#e06a6a" },
      notice: { background: "rgba(60,180,120,0.14)", color: "#4fb783" },
      picker: { display: "flex", flexDirection: "column", gap: 6 },
      pickerTrigger: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-base)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        minHeight: 34,
        padding: "5px 9px",
        width: "100%",
      },
      pickerPlaceholder: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 12,
      },
      pickerCaret: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 10,
        marginLeft: "auto",
      },
      chips: { display: "flex", flexWrap: "wrap", gap: 4 },
      chip: {
        alignItems: "center",
        background: "var(--dsw-alias-bg-layer-2)",
        borderRadius: 4,
        display: "inline-flex",
        fontSize: 11,
        gap: 4,
        padding: "2px 6px",
      },
      chipRemove: { cursor: "pointer", opacity: 0.7 },
      pickerPanel: {
        background: "var(--dsw-alias-bg-base)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 6,
      },
      pickerSearch: {
        background: "var(--dsw-alias-bg-base)",
        border: "0.5px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        color: "inherit",
        fontFamily: "inherit",
        fontSize: 12,
        padding: "6px 8px",
      },
      // 默认可见 10 行（10 × 32 + 9 × 2 间距），超出滚动。
      pickerList: {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        maxHeight: 338,
        overflowY: "auto",
      },
      pickerOption: {
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderRadius: 5,
        color: "inherit",
        cursor: "pointer",
        display: "flex",
        gap: 8,
        minHeight: 32,
        padding: "0 8px",
        width: "100%",
      },
      pickerOptionOn: {
        background:
          "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent)",
      },
      pickerOptionOff: { cursor: "not-allowed", opacity: 0.55 },
      check: {
        alignItems: "center",
        border: "1px solid var(--dsw-alias-border-l3)",
        borderRadius: 4,
        display: "inline-flex",
        flexShrink: 0,
        fontSize: 11,
        height: 16,
        justifyContent: "center",
        width: 16,
      },
      checkOn: {
        background: "var(--dsw-alias-accent-fill, #2f6feb)",
        borderColor: "var(--dsw-alias-accent-fill, #2f6feb)",
        color: "#fff",
      },
    };

    /**
     * 简单模糊匹配：优先子串命中，其次按顺序子序列命中，用于下拉框内搜索。
     */
    function fuzzyMatch(text, query) {
      const haystack = String(text ?? "").toLowerCase();
      const needle = String(query ?? "")
        .trim()
        .toLowerCase();
      if (needle === "") return true;
      if (haystack.includes(needle)) return true;
      let cursor = 0;
      for (const char of haystack) {
        if (char === needle[cursor]) cursor += 1;
        if (cursor === needle.length) return true;
      }
      return false;
    }

    /**
     * 邀请成员用的多选下拉：默认展开、可见 5 行，超出滚动，框内支持模糊搜索。
     */
    function InviteMemberPicker(props) {
      const [open, setOpen] = react.useState(true);
      const [query, setQuery] = react.useState("");
      const rootRef = react.useRef(null);

      react.useEffect(() => {
        if (!open || typeof document === "undefined") return undefined;
        // 两个坑都要绕开：
        // 1) 在 mousedown 收起会让面板下方内容上移，同一次点击的 mouseup 落到别的元素上，
        //    从而吞掉「发送邀请」的首击 —— 所以监听 click（等按钮的 click 先跑完再收起）。
        // 2) click 又会在「打开弹窗」那一下冒泡到 document，导致刚展开的面板立刻收起 ——
        //    所以本轮事件循环内先不生效（armed）。
        let armed = false;
        const arm = () => {
          armed = true;
        };
        // 用全局 setTimeout：测试环境里 window 桩可能没有它。
        const timer = setTimeout(arm, 0);
        const onDocumentClick = (event) => {
          if (!armed) return;
          const node = rootRef.current;
          if (
            node &&
            typeof node.contains === "function" &&
            node.contains(event.target)
          )
            return;
          setOpen(false);
        };
        document.addEventListener("click", onDocumentClick);
        return () => {
          clearTimeout(timer);
          document.removeEventListener("click", onDocumentClick);
        };
      }, [open]);

      const items = props.items ?? [];
      const selectedIds = props.selectedIds ?? new Set();
      const selected = items.filter((item) => selectedIds.has(item.id));
      const list = items.filter((item) => fuzzyMatch(item.name, query));
      // agent 参会方在名字后面直接标「（AI）」，和人类成员区分开。
      const displayName = (item) =>
        item.kind === "ai" ? `${item.name}（AI）` : item.name;

      return h("div", { ref: rootRef, style: PS.picker }, [
        h(
          "div",
          {
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            "aria-label": "选择邀请成员",
            style: PS.pickerTrigger,
            onClick: () => setOpen((value) => !value),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen((value) => !value);
              }
            },
          },
          [
            selected.length === 0
              ? h("span", {
                  style: PS.pickerPlaceholder,
                  children: "选择成员…",
                })
              : h(
                  "div",
                  { style: PS.chips },
                  selected.map((item) =>
                    h("span", { key: item.id, style: PS.chip }, [
                      h("span", { children: displayName(item) }),
                      h("span", {
                        role: "button",
                        "aria-label": `移除 ${item.name}`,
                        style: PS.chipRemove,
                        onClick: (event) => {
                          event.stopPropagation();
                          props.onToggle(item.id);
                        },
                        children: "×",
                      }),
                    ]),
                  ),
                ),
            h("span", { style: PS.pickerCaret, children: open ? "▲" : "▼" }),
          ],
        ),
        open
          ? h("div", { style: PS.pickerPanel }, [
              h("input", {
                style: PS.pickerSearch,
                value: query,
                placeholder: "搜索成员",
                "aria-label": "搜索邀请成员",
                onChange: (event) => setQuery(event.target.value),
              }),
              h(
                "div",
                { style: PS.pickerList },
                list.length === 0
                  ? [
                      h("div", {
                        key: "empty",
                        style: PS.meta,
                        children: "没有匹配的成员",
                      }),
                    ]
                  : list.map((item) => {
                      const inMeeting = item.state === "active";
                      // 已在会议中的参会方默认勾选，且不能再取消/重复邀请。
                      const checked = selectedIds.has(item.id) || inMeeting;
                      return h(
                        "button",
                        {
                          type: "button",
                          key: item.id,
                          disabled: inMeeting,
                          "aria-pressed": checked,
                          style: Object.assign(
                            {},
                            PS.pickerOption,
                            checked ? PS.pickerOptionOn : {},
                            inMeeting ? PS.pickerOptionOff : {},
                          ),
                          onClick: () => {
                            if (!inMeeting) props.onToggle(item.id);
                          },
                        },
                        [
                          h("span", {
                            style: Object.assign(
                              {},
                              PS.check,
                              checked ? PS.checkOn : {},
                            ),
                            children: checked ? "✓" : "",
                          }),
                          h("span", {
                            style: { flex: 1, textAlign: "left" },
                            children: displayName(item),
                          }),
                          inMeeting
                            ? h("span", {
                                style: PS.meta,
                                children: "已在会议中",
                              })
                            : null,
                        ],
                      );
                    }),
              ),
            ])
          : null,
      ]);
    }

    const SPEECH_MODE_OPTIONS = [
      { id: "mention", label: "被点名" },
      { id: "key_topic", label: "关键议题" },
      { id: "observe", label: "观察" },
      { id: "active", label: "主动参与" },
    ];

    const splitLines = (text) =>
      String(text ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");

    const mentionTokenRange = (value, anchorStart) => {
      if (
        Number.isInteger(anchorStart) &&
        anchorStart >= 0 &&
        anchorStart < value.length &&
        value[anchorStart] === "@"
      ) {
        let end = anchorStart + 1;
        while (end < value.length && !/\s/.test(value[end])) end += 1;
        return { start: anchorStart, end };
      }
      const match = /@([^\s@]*)$/.exec(value);
      return match
        ? { start: match.index, end: match.index + match[0].length }
        : null;
    };

    const meetingStatusLabel = (status) =>
      status === "archived"
        ? "已归档"
        : status === "closed"
          ? "已结束"
          : status === "draft"
            ? "未开始"
            : "进行中";

    const meetingStatusTone = (status) =>
      Object.assign({}, PS.statusPill, {
        background:
          status === "closed"
            ? "color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 14%,transparent)"
            : status === "active"
              ? "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent)"
              : "var(--dsw-alias-bg-layer-2)",
        color:
          status === "closed"
            ? "var(--dsw-alias-state-success-primary,#34d47e)"
            : status === "active"
              ? "var(--dsw-alias-accent-primary,#4f8ef7)"
              : "var(--dsw-alias-label-secondary)",
      });

    const meetingTimeLabel = (meeting) => {
      if (meeting?.createdAt === undefined) return "";
      const start = new Date(meeting.createdAt);
      if (Number.isNaN(start.getTime())) return "";
      const now = new Date();
      const sameDay =
        start.getFullYear() === now.getFullYear() &&
        start.getMonth() === now.getMonth() &&
        start.getDate() === now.getDate();
      const pad = (value) => String(value).padStart(2, "0");
      const clock = (value) => `${pad(value.getHours())}:${pad(value.getMinutes())}`;
      const startText = sameDay
        ? `今天 ${clock(start)}`
        : `${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${clock(start)}`;
      const end =
        meeting.closedAt === undefined ? null : new Date(meeting.closedAt);
      if (end !== null && !Number.isNaN(end.getTime())) {
        const sameEndDay =
          start.getFullYear() === end.getFullYear() &&
          start.getMonth() === end.getMonth() &&
          start.getDate() === end.getDate();
        return `${startText} - ${sameEndDay ? clock(end) : `${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${clock(end)}`}`;
      }
      return `${startText} 开始`;
    };

    const normalizeSearchText = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    /**
     * 通用搜索按字段命中质量给分。完整命中、前缀、子串依次降级，
     * 子序列只作为兜底，避免短关键词把无关结果排到前面。
     */
    const searchFieldScore = (value, query) => {
      const text = normalizeSearchText(value);
      if (text === "" || query === "") return 0;
      if (text === query) return 1_000;
      if (text.startsWith(query)) return 850;
      const index = text.indexOf(query);
      if (index >= 0) return 700 - Math.min(index, 200);
      if (query.length > 1 && fuzzyMatch(text, query)) return 300;
      return 0;
    };

    const relevanceScore = (fields, rawQuery) => {
      const query = normalizeSearchText(rawQuery);
      if (query === "") return 0;
      const normalized = fields
        .map((field) => ({
          text: normalizeSearchText(field.text),
          weight: field.weight ?? 1,
        }))
        .filter((field) => field.text !== "");
      if (normalized.length === 0) return 0;
      const tokens = query.split(" ").filter(Boolean);
      const allTokensMatch = tokens.every((token) =>
        normalized.some(
          (field) =>
            field.text.includes(token) || fuzzyMatch(field.text, token),
        ),
      );
      if (!allTokensMatch) return 0;
      let score = Math.max(
        ...normalized.map(
          (field) => searchFieldScore(field.text, query) * field.weight,
        ),
      );
      for (const token of tokens) {
        score += Math.max(
          ...normalized.map(
            (field) => searchFieldScore(field.text, token) * field.weight,
          ),
        );
      }
      return score;
    };

    const isSyntheticMeeting = (meeting) => {
      const title = String(meeting?.title ?? "").trim();
      const summary = String(meeting?.summary ?? "");
      const lastContent = String(meeting?.lastMessage?.content ?? "");
      return (
        /^(AUTO-REVIEW|UI-CREATE)\s+会议(?:\s|$)/i.test(title) ||
        /^自动化会议(?:\s|$)/.test(title) ||
        summary.includes("浏览器自动化验收清理") ||
        /^自动化会议消息(?:\s|$)/.test(lastContent)
      );
    };
    const meetingHasConversation = (meeting) =>
      Number(meeting?.messageCount ?? 0) > 0 &&
      !isSyntheticMeeting(meeting);
    const meetingIsNavigable = (meeting) => meetingHasConversation(meeting);
    const meetingActivityTime = (meeting) =>
      meeting?.lastActivityAt ??
      meeting?.lastMessage?.createdAt ??
      meeting?.updatedAt;
    const meetingLastMessageText = (meeting) =>
      String(displayContent(meeting?.lastMessage?.content) ?? "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/```[\s\S]*?```/g, (block) =>
          block.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""),
        )
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/[*_~`#|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    const meetingLastMessageSpeaker = (meeting, fallback = "") => {
      if (meeting?.lastMessage === null || meeting?.lastMessage === undefined)
        return "";
      const senderName = String(meeting.lastMessage.senderName ?? "").trim();
      if (senderName !== "") return senderName;
      if (meeting.lastMessage.senderKind === "human") return "参会人";
      if (meeting.lastMessage.senderKind === "agent")
        return fallback.trim() || "AI";
      return fallback.trim();
    };
    const teammateIsUnavailable = (teammate) =>
      teammate?.availability?.available === false ||
      (teammate?.availability === undefined &&
        teammate?.state !== undefined &&
        teammate.state !== "active");
    const teammateUnavailableReason = (teammate) =>
      String(
        teammate?.availability?.reason ??
          (teammate?.state === "archived"
            ? "AI伙伴已归档"
            : teammate?.state === "inactive"
              ? "AI伙伴已失效"
              : teammate?.state === "paused"
                ? "AI伙伴已暂停"
                : teammate?.state === "draft"
                  ? "AI伙伴仍是草稿"
                  : "AI伙伴当前不可用"),
      );
    const meetingPreviewText = (meeting, fallback = "暂无消息") =>
      meetingLastMessageText(meeting) ||
      String(meeting?.summary ?? "").trim() ||
      String(meeting?.agenda ?? "").trim() ||
      (meeting?.messageCount > 0
        ? `共 ${meeting.messageCount} 条消息`
        : fallback);

    const errText = (cause) =>
      cause instanceof Error ? cause.message : String(cause);

    const participantGroup = (participant, facilitatorId) => {
      if (
        participant.kind === "facilitator" ||
        (facilitatorId !== undefined && participant.id === facilitatorId)
      )
        return "service";
      if (
        participant.kind === "ai_teammate" ||
        participant.kind === "ai_representative" ||
        participant.kind === "agent" ||
        participant.principalUserId !== undefined ||
        participant.teammateInstanceId !== undefined
      )
        return "ai";
      return "human";
    };

    function MeetingsPage(props) {
      const route = props.useShellRoute?.((state) => state.route);
      const meetingPanelOpen = usePanelOpen();
      const viewportWidth = useViewportWidth();
      const compactLayout = viewportWidth <= 900;
      const [workspaces, setWorkspaces] = react.useState([]);
      // 顶部项目下拉默认「全部」：它是筛选器，不再等同于「当前项目」。
      const [workspaceFilter, setWorkspaceFilter] = react.useState("all");
      /**
       * 方案 B：项目清单默认只看"已加入"；平台管理员可切全量视图。
       * 状态来自跨模块共享 store，跳转前后保持同一选择。
       */
      const [allWorkspaces, setAllWorkspaces] = react.useState([]);
      const showAllWorkspaces = react.useSyncExternalStore(
        scopeStore.subscribe,
        scopeStore.getSnapshot,
        scopeStore.getSnapshot,
      );
      const showAllWorkspacesRef = react.useRef(showAllWorkspaces);
      react.useEffect(() => {
        showAllWorkspacesRef.current = showAllWorkspaces;
      }, [showAllWorkspaces]);
      const [isPlatformAdmin, setIsPlatformAdmin] = react.useState(false);
      // 新建会议落到哪个项目：默认取当前可用的项目。
      const [createWorkspaceId, setCreateWorkspaceId] = react.useState("");
      const [accountName, setAccountName] = react.useState("");
      const [accountId, setAccountId] = react.useState("");
      const [meetings, setMeetings] = react.useState([]);
      const [meetingId, setMeetingId] = react.useState("");
      const [recentEmptyMeetingIds, setRecentEmptyMeetingIds] = react.useState(
        () => {
          try {
            const value = JSON.parse(
              window.localStorage.getItem(RECENT_EMPTY_MEETING_IDS_KEY) ?? "[]",
            );
            return new Set(
              Array.isArray(value)
                ? value.filter((item) => typeof item === "string")
                : [],
            );
          } catch {
            return new Set();
          }
        },
      );
      const [detail, setDetail] = react.useState(null);
      const [minutes, setMinutes] = react.useState(null);
      const [teammates, setTeammates] = react.useState([]);
      const [centerTab, setCenterTab] = react.useState("conversation");
      const [content, setContent] = react.useState("");
      const fileRef = react.useRef(null);
      const composerInputRef = react.useRef(null);
      const mentionAnchorRef = react.useRef(null);
      const streamRef = react.useRef(null);
      const searchInputRef = react.useRef(null);
      const [search, setSearch] = react.useState("");
      const [communicationFilter, setCommunicationFilter] =
        react.useState("all");
      // 与 AI Teammates 一致：已归档的会议不混在正常列表里，用「已归档 N」切换。
      const [showArchived, setShowArchived] = react.useState(false);
      const [closedOpen, setClosedOpen] = react.useState(false);
      const [briefOpen, setBriefOpen] = react.useState(false);
      const [mentionIds, setMentionIds] = react.useState(() => new Set());
      const [mentionOpen, setMentionOpen] = react.useState(false);
      const [mentionQuery, setMentionQuery] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [refreshKey, setRefreshKey] = react.useState(0);
      const [createOpen, setCreateOpen] = react.useState(false);
      // 状态反馈条 3 秒后自动消失。
      react.useEffect(() => {
        if (notice === "" && error === "") return undefined;
        const timer = window.setTimeout(() => {
          setNotice("");
          setError("");
        }, 3_000);
        return () => window.clearTimeout(timer);
      }, [notice, error]);
      const [newTitle, setNewTitle] = react.useState("");
      const [newAgenda, setNewAgenda] = react.useState("");
      const [delegateOpen, setDelegateOpen] = react.useState(false);
      const [inviteOpen, setInviteOpen] = react.useState(false);
      const [invitePeople, setInvitePeople] = react.useState([]);
      const [inviteIds, setInviteIds] = react.useState(() => new Set());
      const [dform, setDform] = react.useState({
        teammateInstanceId: "",
        speechMode: "mention",
        goal: "",
        stance: "",
        mustSay: "",
        focusPoints: "",
      });
      const [minutesDraft, setMinutesDraft] = react.useState("");
      const [centerTitleDraft, setCenterTitleDraft] = react.useState("");
      const [centerAgendaDraft, setCenterAgendaDraft] = react.useState("");
      const [editingMinutes, setEditingMinutes] = react.useState(false);
      const [closeOpen, setCloseOpen] = react.useState(false);
      const [closeSummary, setCloseSummary] = react.useState("");
      // 「已有纪要时再点生成」的覆盖确认弹窗。
      const [minutesOverwriteOpen, setMinutesOverwriteOpen] =
        react.useState(false);

      react.useEffect(() => {
        const pending = window.__pluginmaxPendingMeeting;
        if (pending === null || typeof pending !== "object") return;
        window.__pluginmaxPendingMeeting = null;
        if (
          typeof pending.workspaceId === "string" &&
          pending.workspaceId !== ""
        ) {
          setWorkspaceFilter(pending.workspaceId);
        }
        if (typeof pending.meetingId === "string" && pending.meetingId !== "") {
          setMeetingId(pending.meetingId);
        }
      }, []);

      react.useEffect(() => {
        const onNavigate = (event) => {
          const detail = event?.detail;
          if (detail?.plugin !== "meeting") return;
          if (
            typeof detail.workspaceId === "string" &&
            detail.workspaceId !== ""
          ) {
            setWorkspaceFilter(detail.workspaceId);
          }
          if (typeof detail.meetingId === "string" && detail.meetingId !== "") {
            setMeetingId(detail.meetingId);
          }
        };
        window.addEventListener("pluginmax:collab-navigate", onNavigate);
        return () =>
          window.removeEventListener("pluginmax:collab-navigate", onNavigate);
      }, []);

      react.useEffect(
        () =>
          store.subscribeChange((source) => {
            if (source !== "page") setRefreshKey((key) => key + 1);
          }),
        [],
      );

      react.useEffect(() => {
        const onTokenChange = () => {
          if (window.localStorage.getItem("pluginmax.collab.token") === null) {
            setMeetings([]);
            setMeetingId("");
            setDetail(null);
            setMinutes(null);
            setTeammates([]);
            setAccountName("");
            setAccountId("");
            setAllWorkspaces([]);
            setWorkspaces([]);
          }
          setRefreshKey((key) => key + 1);
        };
        window.addEventListener("pluginmax:collab-token", onTokenChange);
        return () =>
          window.removeEventListener("pluginmax:collab-token", onTokenChange);
      }, []);

      react.useEffect(() => {
        if (route !== "meetings") return undefined;
        let disposed = false;
        (async () => {
          try {
            const [workspaceResult, me, teammateResult] = await Promise.all([
              request("/api/collab/team/workspaces"),
              request("/api/collab/auth/me"),
              request(
                "/api/collab/teammates?workspaceId=system.default",
              ).catch(() => ({ teammates: [] })),
            ]);
            if (disposed) return;
            const list = [
              ...(workspaceResult.workspaces ?? []).filter(
                (workspace) => workspace.id !== SYSTEM_DEFAULT_WORKSPACE_ID,
              ),
              SYSTEM_DEFAULT_WORKSPACE,
            ];
            const admin = me.user?.role === "admin";
            setIsPlatformAdmin(admin);
            setAllWorkspaces(list);
            setWorkspaces(
              admin && showAllWorkspacesRef.current
                ? list
                : list.filter((workspace) => workspace.isMember === true),
            );
            setAccountName(me.user?.name ?? "");
            setAccountId(me.user?.id ?? "");
            setTeammates(
              (teammateResult.teammates ?? []).filter(
                (item) => item.state === "active",
              ),
            );
            // 平台管理员对全部项目都有建会权限，可选项不止“已加入”的项目；
            // 否则管理员在未加入任何项目时「新建会议」会一直被禁用。
            const creatable = admin
              ? list
              : list.filter((workspace) => workspace.isMember === true);
            setCreateWorkspaceId((current) =>
              current && creatable.some((workspace) => workspace.id === current)
                ? current
                : (creatable[0]?.id ?? ""),
            );
          } catch (cause) {
            if (!disposed) setError(errText(cause));
          }
        })();
        return () => {
          disposed = true;
        };
      }, [route, showAllWorkspaces, refreshKey]);

      react.useEffect(() => {
        if (route !== "meetings") return undefined;
        // 「全部」= 并列拉取所有可见项目后合并，其余取单个项目。
        // 平台管理员能对全部项目建会，因此默认「仅看已加入」视图也要把
        // 自己在未加入项目里创建/主持的会议带出来，否则建完会议列表反而为空。
        const aggregated =
          workspaceFilter === "all"
            ? isPlatformAdmin
              ? allWorkspaces
              : workspaces
            : [];
        const targets =
          workspaceFilter === "all"
            ? aggregated.map((workspace) => workspace.id)
            : [...new Set([workspaceFilter, SYSTEM_DEFAULT_WORKSPACE_ID])];
        if (targets.length === 0) return undefined;
        const joinedIds = new Set(workspaces.map((workspace) => workspace.id));
        const keep = (meeting) =>
          workspaceFilter !== "all" ||
          showAllWorkspaces ||
          joinedIds.has(meeting.workspaceId) ||
          (accountId !== "" &&
            (meeting.createdBy === accountId ||
              meeting.ownerUserId === accountId));
        let disposed = false;
        (async () => {
          try {
            const lists = await Promise.all(
              targets.map((id) =>
                request(
                  `/api/collab/meetings?workspaceId=${encodeURIComponent(id)}`,
                )
                  .then((result) => result.meetings ?? [])
                  .catch(() => []),
              ),
            );
            if (disposed) return;
            setMeetings(
              lists
                .flat()
                .filter(keep)
                .filter(
                  (meeting) =>
                    workspaceFilter === "all" ||
                    meeting.workspaceId === workspaceFilter ||
                    (meeting.kind === "ai" &&
                      meeting.workspaceId === SYSTEM_DEFAULT_WORKSPACE_ID),
                )
                .sort((left, right) =>
                  String(right.updatedAt).localeCompare(String(left.updatedAt)),
                ),
            );
          } catch (cause) {
            if (!disposed) setError(errText(cause));
          }
        })();
        return () => {
          disposed = true;
        };
      }, [
        route,
        workspaceFilter,
        workspaces,
        allWorkspaces,
        isPlatformAdmin,
        showAllWorkspaces,
        accountId,
        refreshKey,
      ]);

      react.useEffect(() => {
        if (route !== "meetings") return undefined;
        const pending = meetings.filter(
          (item) => item.messageCount === undefined,
        );
        if (pending.length === 0) return undefined;
        let disposed = false;
        (async () => {
          const hydrated = [];
          for (let index = 0; index < pending.length; index += 4) {
            const batch = pending.slice(index, index + 4);
            const results = await Promise.all(
              batch.map(async (item) => {
                try {
                  const result = await request(
                    `/api/collab/meeting?meetingId=${encodeURIComponent(item.id)}`,
                  );
                  const actor =
                    typeof result.actorId === "string" ? result.actorId : "";
                  const conversation = (result.transcript ?? []).filter(
                    (message) => message.senderKind !== "system",
                  );
                  const lastMessage = conversation.at?.(-1);
                  const lastReadSeq = Number(
                    result.read?.lastReadSeq ??
                      result.read?.lastReadSequence ??
                      0,
                  );
                  return Object.assign({}, item, {
                    messageCount: conversation.length,
                    unreadCount: conversation.filter(
                      (message) =>
                        Number(message.sequence ?? 0) > lastReadSeq &&
                        !(
                          message.senderKind === "human" &&
                          message.senderId === actor
                        ),
                    ).length,
                    lastMessage:
                      lastMessage === undefined
                        ? null
                        : {
                            id: lastMessage.id,
                            senderKind: lastMessage.senderKind,
                            senderName: lastMessage.senderName,
                            content: lastMessage.content,
                            createdAt: lastMessage.createdAt,
                          },
                    lastActivityAt:
                      lastMessage?.createdAt ?? item.updatedAt,
                  });
                } catch {
                  return Object.assign({}, item, {
                    messageCount: 0,
                    unreadCount: 0,
                    lastMessage: null,
                  });
                }
              }),
            );
            hydrated.push(...results);
          }
          if (disposed) return;
          const byId = new Map(hydrated.map((item) => [item.id, item]));
          setMeetings((current) =>
            current.map((item) => byId.get(item.id) ?? item),
          );
        })();
        return () => {
          disposed = true;
        };
      }, [route, meetings]);

      react.useEffect(() => {
        if (route !== "meetings" || meetingId === "") {
          setDetail(null);
          setMinutes(null);
          return undefined;
        }
        let disposed = false;
        (async () => {
          try {
            const detailResult = await request(
              `/api/collab/meeting?meetingId=${encodeURIComponent(meetingId)}`,
            );
            const groupMeeting = detailResult.meeting?.kind !== "ai";
            const minutesResult = groupMeeting
              ? await request(
                  `/api/collab/meeting/minutes?meetingId=${encodeURIComponent(meetingId)}`,
                ).catch(() => null)
              : null;
            if (disposed) return;
            setDetail(detailResult);
            setMinutes(minutesResult);
            const lastSeq =
              (detailResult?.transcript ?? []).at?.(-1)?.sequence ?? 0;
            if (lastSeq > 0)
              request("/api/collab/meeting/read", {
                method: "POST",
                body: JSON.stringify({ meetingId, lastReadSeq: lastSeq }),
              })
                .then(() => {
                  if (disposed) return;
                  setMeetings((current) =>
                    current.map((item) =>
                      item.id === meetingId
                        ? Object.assign({}, item, { unreadCount: 0 })
                        : item,
                    ),
                  );
                })
                .catch(() => undefined);
          } catch (cause) {
            if (!disposed) setError(errText(cause));
          }
        })();
        return () => {
          disposed = true;
        };
      }, [route, meetingId, refreshKey]);

      react.useEffect(() => {
        setCenterTab("conversation");
      }, [meetingId]);

      react.useEffect(() => {
        if (route !== "meetings") return;
        setCenterTitleDraft(detail?.meeting?.title ?? "");
        setCenterAgendaDraft(detail?.meeting?.agenda ?? "");
      }, [route, meetingId, detail?.meeting?.title, detail?.meeting?.agenda]);

      // 纪要生成是异步的：只要还有生成中的版本，就轮询刷新，
      // 否则界面会一直停在「generating」，看不到待确认或生效状态。
      react.useEffect(() => {
        if (route !== "meetings" || meetingId === "") return undefined;
        const versions = minutes?.versions ?? [];
        const generating = versions.some(
          (version) =>
            version.status === "generating" || version.status === "pending",
        );
        if (!generating) return undefined;
        const timer = window.setInterval(
          () => setRefreshKey((key) => key + 1),
          4_000,
        );
        return () => window.clearInterval(timer);
      }, [route, meetingId, minutes]);

      // 会议成员变动签名：邀请/移除后详情刷新时，同时刷新邀请弹窗里的候选列表，
      // 避免弹窗沿用打开时那份过期名单。
      const rosterKey = (detail?.participants ?? [])
        .map(
          (participant) =>
            `${participant.id}:${participant.refId}:${participant.status}`,
        )
        .join(",");

      react.useEffect(() => {
        if (!inviteOpen || meetingId === "") return undefined;
        let disposed = false;
        (async () => {
          try {
            const result = await request(
              `/api/collab/meeting/people?meetingId=${encodeURIComponent(meetingId)}`,
            );
            if (!disposed) setInvitePeople(result.people ?? []);
          } catch (cause) {
            if (!disposed) setError(errText(cause));
          }
        })();
        return () => {
          disposed = true;
        };
      }, [inviteOpen, meetingId, refreshKey, rosterKey]);

      const run = async (label, action) => {
        setBusy(label);
        setError("");
        try {
          await action();
          setRefreshKey((key) => key + 1);
          store.bumpChange("page");
        } catch (cause) {
          setError(errText(cause));
        } finally {
          setBusy("");
        }
      };

      const post = (path, body) =>
        request(path, { method: "POST", body: JSON.stringify(body) });
      const rememberEmptyMeeting = (id) => {
        if (id === "") return;
        setRecentEmptyMeetingIds((current) => {
          const next = new Set(current);
          next.add(id);
          const limited = [...next].slice(-50);
          window.localStorage.setItem(
            RECENT_EMPTY_MEETING_IDS_KEY,
            JSON.stringify(limited),
          );
          return new Set(limited);
        });
      };

      // 可见项目：管理员可用全部项目，普通成员仅限已加入的项目。
      const visibleWorkspaces = isPlatformAdmin ? allWorkspaces : workspaces;
      const workspaceNameById = new Map(
        (allWorkspaces.length > 0 ? allWorkspaces : workspaces).map(
          (workspace) => [workspace.id, workspaceLabel(workspace)],
        ),
      );
      const teammateById = new Map(
        teammates.map((teammate) => [teammate.id, teammate]),
      );
      // 每位 AI伙伴只保留最近一个进行中的默认会话，避免历史数据里的
      // 同实例多会话在左侧重复成多行。
      const activeAiConversationByTeammate = new Map();
      for (const item of meetings) {
        if (
          item.kind !== "ai" ||
          item.status !== "active" ||
          !meetingIsNavigable(item) ||
          !meetingHasConversation(item) ||
          item.teammateInstanceId === undefined ||
          activeAiConversationByTeammate.has(item.teammateInstanceId)
        )
          continue;
        activeAiConversationByTeammate.set(item.teammateInstanceId, item);
      }
      const meetingSearchScore = (item) =>
        relevanceScore(
          [
            { text: item.title, weight: 1.25 },
            { text: workspaceNameById.get(item.workspaceId), weight: 1 },
            {
              text: teammateById.get(item.teammateInstanceId)?.name,
              weight: 1.2,
            },
            {
              text: teammateById.get(item.teammateInstanceId)?.ownerName,
              weight: 1,
            },
            { text: item.agenda, weight: 0.35 },
            { text: item.summary, weight: 0.3 },
            { text: meetingLastMessageText(item), weight: 0.45 },
          ],
          search,
        );
      const teammateSearchScore = (teammate) => {
        const activeConversation = activeAiConversationByTeammate.get(
          teammate.id,
        );
        return relevanceScore(
          [
            { text: teammate.name, weight: 1.3 },
            { text: teammate.ownerName, weight: 1.1 },
            { text: teammate.ownerUserId, weight: 0.65 },
            {
              text:
                activeConversation === undefined
                  ? ""
                  : workspaceNameById.get(activeConversation.workspaceId),
              weight: 0.8,
            },
          ],
          search,
        );
      };

      const openTeammateConversation = async (teammate) => {
        const existing = activeAiConversationByTeammate.get(teammate.id);
        if (existing !== undefined) {
          setMeetingId(existing.id);
          return;
        }
        // 一对一默认会话固定在平台默认项目，避免切换项目筛选后
        // 为同一个 AI伙伴重复创建多段单聊。
        const workspaceId = SYSTEM_DEFAULT_WORKSPACE_ID;
        await run(`ai-chat:${teammate.id}`, async () => {
          const result = await post("/api/collab/meetings", {
            workspaceId,
            title: teammate.name,
            kind: "ai",
            teammateInstanceId: teammate.id,
            teammateName: teammate.name,
            displayName: accountName,
          });
          if (result?.meeting?.id) {
            setMeetings((current) => [
              result.meeting,
              ...current.filter((item) => item.id !== result.meeting.id),
            ]);
            setMeetingId(result.meeting.id);
          }
        });
      };

      // 默认选中当前筛选下第一场会议；筛选或搜索变化后若当前会议不再可见，
      // 也自动落到第一条结果，避免中间会话区停留在无选择状态。
      react.useEffect(() => {
        if (route !== "meetings") return;
        if (meetings.length === 0) return;
        const matchesView = (item) =>
          showArchived
            ? item.status === "archived"
            : item.status !== "archived";
        const matchesType = (item) =>
          communicationFilter === "all" ||
          (communicationFilter === "ai"
            ? item.kind === "ai"
            : item.kind !== "ai");
        const matchesSearch = (item) =>
          normalizeSearchText(search) === "" ||
          meetingSearchScore(item) > 0;
        const matchesConversation = (item) =>
          meetingHasConversation(item) ||
          (item.status === "active" &&
            (item.id === meetingId || recentEmptyMeetingIds.has(item.id)));
        const current = meetings.find((item) => item.id === meetingId);
        if (current !== undefined && current.messageCount === undefined)
          return;
        if (
          current !== undefined &&
          matchesView(current) &&
          matchesType(current) &&
          matchesConversation(current) &&
          matchesSearch(current)
        )
          return;
        const candidates = meetings.filter(
          (item) =>
            matchesView(item) &&
            matchesType(item) &&
            matchesConversation(item) &&
            matchesSearch(item) &&
            item.status !== "closed",
        ).sort((left, right) =>
          normalizeSearchText(search) === ""
            ? String(meetingActivityTime(right) ?? "").localeCompare(
                String(meetingActivityTime(left) ?? ""),
              )
            : meetingSearchScore(right) - meetingSearchScore(left) ||
              String(meetingActivityTime(right) ?? "").localeCompare(
                String(meetingActivityTime(left) ?? ""),
              ),
        );
        if (!candidates.some((item) => item.id === meetingId)) {
          const fallback =
            normalizedQuery === ""
              ? (candidates.find((item) => meetingHasConversation(item)) ??
                candidates[0])
              : candidates[0];
          setMeetingId(fallback?.id ?? "");
        }
      }, [
        route,
        meetings,
        meetingId,
        recentEmptyMeetingIds,
        search,
        showArchived,
        communicationFilter,
        workspaces,
        allWorkspaces,
        teammates,
      ]);

      react.useEffect(() => {
        if (
          route !== "meetings" ||
          detail?.meeting?.kind !== "ai" ||
          detail?.meeting?.status !== "active"
        ) {
          return undefined;
        }
        const lastMessage = (detail?.transcript ?? []).at(-1);
        const waitingForReply =
          lastMessage?.senderKind === "human" &&
          (lastMessage.deliveries ?? []).some(
            (delivery) => delivery.status === "pending",
          );
        if (!waitingForReply) return undefined;
        const timer = window.setInterval(
          () => setRefreshKey((key) => key + 1),
          2_000,
        );
        return () => window.clearInterval(timer);
      }, [route, meetingId, detail]);

      if (route !== "meetings") return null;

      const normalizedQuery = normalizeSearchText(search);
      const matchesSearch = (score) =>
        normalizedQuery === "" || score > 0;
      const sortRowsByRelevance = (left, right) =>
        right.score - left.score ||
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        );
      const sortRowsByUpdatedAt = (left, right) =>
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        );
      const sortRowsForDisplay = (left, right) =>
        normalizedQuery === ""
          ? sortRowsByUpdatedAt(left, right)
          : sortRowsByRelevance(left, right);

      const teammateRows =
        communicationFilter === "meeting"
          ? []
          : teammates
              .map((teammate) => {
                const conversation =
                  activeAiConversationByTeammate.get(teammate.id);
                return {
                  id: `teammate:${teammate.id}`,
                  teammate,
                  conversation,
                  updatedAt: meetingActivityTime(conversation),
                  score: teammateSearchScore(teammate),
                };
              })
              .filter(
                (row) =>
                  communicationFilter === "ai" ||
                  row.conversation !== undefined,
              )
              .filter((row) => matchesSearch(row.score));
      const rankedTeammateRows =
        normalizedQuery === ""
          ? teammateRows
          : [...teammateRows].sort(sortRowsForDisplay);

      // 已归档的会议单独成组：默认列表只显示未归档的，由「已归档 N」入口切换。
      const archivedMeetings = meetings.filter(
        (item) =>
          item.status === "archived" &&
          meetingHasConversation(item) &&
          (communicationFilter === "all" ||
            (communicationFilter === "ai"
              ? item.kind === "ai"
              : item.kind !== "ai")),
      );
      const rankedArchivedRows = archivedMeetings
        .map((item) => ({
          id: `meeting:${item.id}`,
          item,
          updatedAt: meetingActivityTime(item),
          score: meetingSearchScore(item),
        }))
        .filter((row) => matchesSearch(row.score))
        .sort(sortRowsForDisplay);

      const regularMeetings =
        communicationFilter === "ai"
          ? []
          : meetings.filter(
              (item) =>
                item.kind !== "ai" &&
                item.status !== "archived" &&
                (meetingHasConversation(item) ||
                  (item.status === "active" &&
                    (item.id === meetingId ||
                      recentEmptyMeetingIds.has(item.id)))),
            );
      const openMeetingRows = showArchived
        ? []
        : regularMeetings
            .filter((item) => item.status !== "closed")
            .map((item) => ({
              id: `meeting:${item.id}`,
              item,
              updatedAt: meetingActivityTime(item),
              score: meetingSearchScore(item),
            }))
            .filter((row) => matchesSearch(row.score));
      const closedMeetingRows = showArchived
        ? []
        : regularMeetings
            .filter((item) => item.status === "closed")
            .map((item) => ({
              id: `meeting:${item.id}`,
              item,
              updatedAt: meetingActivityTime(item),
              score: meetingSearchScore(item),
            }))
            .filter((row) => matchesSearch(row.score))
            .sort(sortRowsForDisplay);
      const rankedOpenMeetingRows =
        normalizedQuery === ""
          ? openMeetingRows
          : [...openMeetingRows].sort(sortRowsForDisplay);
      const rankedConversationRows = [
        ...rankedTeammateRows,
        ...rankedOpenMeetingRows,
      ].sort(sortRowsForDisplay);
      const visibleResultCount = showArchived
        ? rankedArchivedRows.length
        : rankedTeammateRows.length +
          rankedOpenMeetingRows.length +
          closedMeetingRows.length;
      // 邀请弹窗只用一个控件：人和 AI Teammate 合成同一份候选清单。
      // 已在会议中的参会方在清单里保持勾选（禁用），提交时只处理新增的那些。
      const inMeetingAgentIds = new Set(
        (detail?.participants ?? [])
          .filter(
            (participant) =>
              participant.kind !== "human" &&
              participant.status === "active",
          )
          .map(
            (participant) =>
              participant.teammateInstanceId ?? participant.refId,
          ),
      );
      const inviteCandidates = [
        ...invitePeople.map((person) => ({
          id: person.id,
          name: person.name,
          kind: "human",
          state: person.state,
        })),
        ...teammates.map((item) => ({
          id: item.id,
          name: item.name,
          kind: "ai",
          state: inMeetingAgentIds.has(item.id) ? "active" : undefined,
        })),
      ];
      const participants = detail?.participants ?? [];
      const transcript = detail?.transcript ?? [];
      // 任意新消息（系统 / 人类 / AI）到达后，始终跟随到最新位置。
      react.useEffect(() => {
        const node = streamRef.current;
        if (node === null) return;
        node.scrollTop = node.scrollHeight;
      }, [meetingId, transcript.length, centerTab]);
      const meeting = detail?.meeting;
      const isAiConversation = meeting?.kind === "ai";
      const aiConversationTeammate = isAiConversation
        ? teammates.find(
            (item) => item.id === meeting?.teammateInstanceId,
          )
        : undefined;
      const aiConversationUnavailable =
        isAiConversation && teammateIsUnavailable(aiConversationTeammate);
      const aiConversationUnavailableReason =
        aiConversationUnavailable
          ? teammateUnavailableReason(aiConversationTeammate)
          : "";
      const actorId = detail?.actorId ?? "";
      const joined = participants.some(
        (participant) =>
          participant.kind === "human" &&
          participant.status === "active" &&
          participant.refId === actorId,
      );
      const facilitatorId = minutes?.facilitator?.id;
      const bucket = { human: [], ai: [], service: [] };
      // Facilitator 只占一个「服务成员」席位：启用时合成一行，
      // 同时隐藏历史遗留的同实例 participant 记录，避免重复。
      const activeFacilitator = minutes?.facilitator ?? undefined;
      const facilitatorSeat =
        activeFacilitator === undefined
          ? undefined
          : {
              id: `facilitator:${activeFacilitator.id}`,
              kind: "facilitator",
              refId: "meeting-facilitator",
              displayName: "会议 Facilitator（AI）",
              status: "active",
            };
      for (const participant of [
        ...(facilitatorSeat === undefined ? [] : [facilitatorSeat]),
        ...participants.filter(
          (participant) =>
            participant.status === "active" &&
            !(
              participant.kind === "ai_teammate" &&
              participant.refId === "meeting-facilitator"
            ),
        ),
      ])
        bucket[participantGroup(participant, facilitatorId)].push(participant);
      const canConfirm =
        meeting !== undefined &&
        actorId !== "" &&
        (meeting.ownerUserId ?? meeting.createdBy) === actorId;
      // 以「最近更新」为准：不再走「待确认 / 确认生效」流程。
      // （服务端仍会保留 pending_confirm 状态，但不再作为展示门槛。）
      const pending = undefined;
      const allVersions = minutes?.versions ?? [];
      // 展示用版本：最近一版「有内容」的版本。重新生成会先落一条空内容的新版本，
      // 若直接按最新一版渲染，点一次生成就会把已有纪要清空。
      const displayVersion = [...allVersions]
        .reverse()
        .find((version) => String(version.content ?? "").trim() !== "");
      const canEditMinutes = canConfirm && meeting?.status !== "archived";
      const activeHumans = participants.filter(
        (participant) =>
          participant.status === "active" && participant.kind === "human",
      );
      const activeAi = participants.filter(
        (participant) =>
          participant.status === "active" && participant.kind !== "human",
      );
      const projectName =
        meeting === undefined
          ? ""
          : (workspaceNameById.get(meeting.workspaceId) ?? meeting.workspaceId);
      const compactText = (value, limit = 260) => {
        const text = String(displayContent(value) ?? "").replace(/\s+/g, " ");
        return text.length > limit ? `${text.slice(0, limit)}…` : text;
      };
      const recentBriefMessages = transcript.slice(-3).map((message) => ({
        id: message.id,
        sender:
          message.senderKind === "system"
            ? "系统"
            : message.senderName || message.senderId,
        content: compactText(message.content, 180),
      }));

      const banner = error
        ? h("div", {
            style: Object.assign({}, PS.banner, PS.error),
            children: error,
          })
        : notice
          ? h("div", {
              style: Object.assign({}, PS.banner, PS.notice),
              children: notice,
            })
          : null;

      // 更新纪要：放在「会议纪要 vN」标题行右上角。
      const minutesTriggerBtn =
        meeting?.status === "archived" || !minutes?.facilitator
          ? null
          : h("button", {
              type: "button",
              style: PS.ghostBtn,
              disabled: busy !== "" || !joined,
              onClick: () => {
                // 已有内容时先弹窗告知：重新生成会覆盖现有纪要。
                if (displayVersion !== undefined) {
                  setMinutesOverwriteOpen(true);
                  return;
                }
                void run("minutes", () =>
                  post("/api/collab/meeting/minutes/trigger", { meetingId }),
                );
              },
              children: busy === "minutes" ? "生成中…" : "更新纪要",
            });

      const minutesTab = h(
        "div",
        {
          key: "center-minutes",
          // 纪要框撑满侧栏剩余高度：容器不滚动，滚动交给正文区。
          style: Object.assign({}, PS.sideBody, { overflowY: "hidden" }),
        },
        meeting?.status === "archived"
          ? h("div", {
              style: PS.meta,
              children: "会议已归档，纪要进入只读状态。",
            })
          : minutes?.facilitator
            ? null
            : h("div", {
                style: PS.meta,
                children:
                  "会议 Facilitator 未在会：用「邀请成员」把它拉进会议后即可生成纪要。",
              }),
        displayVersion === undefined
          ? h("div", { style: PS.group }, [
              h(
                "div",
                { style: { alignItems: "center", display: "flex", gap: 6 } },
                [
                  h("div", {
                    style: Object.assign({}, PS.groupTitle, { flex: 1 }),
                    children: "会议纪要",
                  }),
                  minutesTriggerBtn,
                ],
              ),
              h("div", { style: PS.meta, children: "暂无会议纪要" }),
            ])
          : h(
              "div",
              { style: Object.assign({}, PS.group, { flex: 1, minHeight: 0 }) },
              [
                h(
                  "div",
                  { style: { alignItems: "center", display: "flex", gap: 6 } },
                  [
                    h("div", {
                      style: Object.assign({}, PS.groupTitle, { flex: 1 }),
                      children: `会议纪要 v${displayVersion.version}`,
                    }),
                    h("button", {
                      type: "button",
                      key: "minutes-download",
                      style: Object.assign({}, PS.ghostBtn, {
                        alignItems: "center",
                        display: "inline-flex",
                        gap: 4,
                      }),
                      title: "下载 Markdown",
                      "aria-label": "下载会议纪要 Markdown",
                      onClick: () =>
                        downloadMinutesMarkdown(meeting, displayVersion),
                      children: [
                        downloadIcon(),
                        h("span", { children: "下载" }),
                      ],
                    }),
                    ...(canEditMinutes && minutes?.facilitator
                      ? editingMinutes
                        ? [
                            h("button", {
                              type: "button",
                              key: "minutes-cancel",
                              style: PS.ghostBtn,
                              disabled: busy !== "",
                              onClick: () => setEditingMinutes(false),
                              children: "取消",
                            }),
                            h("button", {
                              type: "button",
                              key: "minutes-save",
                              style: PS.ghostBtn,
                              disabled: busy !== "",
                              onClick: () =>
                                run("confirm", async () => {
                                  await post(
                                    "/api/collab/meeting/minutes/confirm",
                                    {
                                      meetingId,
                                      versionId: displayVersion.id,
                                      content: minutesDraft,
                                    },
                                  );
                                  setEditingMinutes(false);
                                }),
                              children: busy === "confirm" ? "保存中…" : "保存",
                            }),
                          ]
                        : [
                            h("button", {
                              type: "button",
                              key: "minutes-edit",
                              style: PS.ghostBtn,
                              disabled: busy !== "",
                              onClick: () => {
                                setMinutesDraft(displayVersion.content ?? "");
                                setEditingMinutes(true);
                              },
                              children: "编辑",
                            }),
                          ]
                      : []),
                    minutesTriggerBtn,
                  ],
                ),
                editingMinutes
                  ? h("textarea", {
                      style: Object.assign({}, PS.textarea, {
                        flex: 1,
                        minHeight: 0,
                      }),
                      value: minutesDraft,
                      onChange: (event) => setMinutesDraft(event.target.value),
                    })
                  : h(
                      "div",
                      {
                        style: Object.assign({}, PS.pre, {
                          flex: 1,
                          maxHeight: "none",
                          minHeight: 0,
                        }),
                      },
                      renderChatMarkdown(displayVersion.content) ??
                        h("span", null, "（空）"),
                    ),
                // 纪要下方：更新时间（人工编辑与重新生成都算一次更新）。
                h("div", {
                  style: PS.meta,
                  children: `更新于：${timeFull(
                    displayVersion.updatedAt ?? displayVersion.createdAt,
                  )}`,
                }),
              ],
            ),
        pending
          ? h("div", { style: PS.group }, [
              h("div", {
                style: PS.groupTitle,
                children: `待确认 v${pending.version}`,
              }),
              canConfirm
                ? h("div", { style: { display: "grid", gap: 6 } }, [
                    editingMinutes
                      ? h("textarea", {
                          style: Object.assign({}, PS.textarea, {
                            minHeight: 120,
                          }),
                          value: minutesDraft,
                          onChange: (event) =>
                            setMinutesDraft(event.target.value),
                        })
                      : null,
                    h("div", { style: { display: "flex", gap: 6 } }, [
                      h("button", {
                        type: "button",
                        style: PS.ghostBtn,
                        onClick: () => {
                          setEditingMinutes((value) => !value);
                          setMinutesDraft(pending.content ?? "");
                        },
                        children: editingMinutes ? "取消编辑" : "编辑",
                      }),
                      h("button", {
                        type: "button",
                        style: PS.primaryBtn,
                        disabled: busy !== "",
                        onClick: () =>
                          run("confirm", () =>
                            post("/api/collab/meeting/minutes/confirm", {
                              meetingId,
                              versionId: pending.id,
                              ...(editingMinutes
                                ? { content: minutesDraft }
                                : {}),
                            }),
                          ),
                        children: "确认生效",
                      }),
                    ]),
                  ])
                : h("div", { style: PS.meta, children: "等待会议负责人确认" }),
            ])
          : null,
      );

      const stream = h(
        "div",
        {
          key: "center-conversation",
          ref: streamRef,
          style: PS.stream,
        },
        // 与右侧栏会话保持同一套排版：头像 + 名称/时间 + 气泡，
        // 自己的消息头像与内容一起靠右，名称显示「我」。
        ...transcript.map((message) => {
          if (message.senderKind === "system")
            return h("div", {
              key: message.id,
              style: PS.systemMessage,
              children: displayContent(message.content),
            });
          const mine =
            message.senderKind === "human" && message.senderId === actorId;
          const label =
            message.provenance?.role === "representative"
              ? `${message.senderName} · AI 参会代表`
              : message.senderKind === "agent"
                ? `${message.senderName} · AI`
                : mine
                  ? "我"
                  : message.senderName;
          return h(
            "div",
            {
              key: message.id,
              style: {
                alignItems: "flex-start",
                display: "flex",
                flexDirection: mine ? "row-reverse" : "row",
                gap: 8,
              },
            },
            chatAvatar(message, mine, teammates),
            h(
              "div",
              {
                style: {
                  alignItems: mine ? "flex-end" : "flex-start",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  maxWidth: "calc(100% - 34px)",
                  minWidth: 0,
                },
              },
              h("div", {
                style: PS.meta,
                children: `${label} · ${timeShort(message.createdAt)}`,
              }),
              h(
                "div",
                {
                  style: Object.assign(
                    {},
                    PS.bubble,
                    mine ? PS.bubbleMine : {},
                    { maxWidth: "100%" },
                  ),
                },
                h(
                  "div",
                  null,
                  renderChatMarkdown(displayContent(message.content)),
                ),
                (message.attachments ?? []).length > 0
                  ? h(
                      "div",
                      {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          marginTop: 4,
                        },
                      },
                      ...(message.attachments ?? []).map((attachment) =>
                        h(
                          "button",
                          {
                            key: attachment.id,
                            type: "button",
                            style: PS.ghostBtn,
                            onClick: () => void openAttachment(attachment),
                          },
                          `${attachment.name}（${Math.max(1, Math.round(attachment.size / 1024))}KB）`,
                        ),
                      ),
                    )
                  : null,
              ),
            ),
          );
        }),
        transcript.length === 0
          ? h("div", {
              style: PS.empty,
              children: isAiConversation
                ? "当前没有对话记录。"
                : meeting?.status === "active"
                  ? "会议刚刚开始，当前没有对话记录。"
                  : "会议尚未产生对话记录。",
            })
          : null,
      );

      const mentionOptions = participants.filter(
        (participant) =>
          participant.status === "active" &&
          !(participant.kind === "human" && participant.refId === actorId) &&
          (mentionQuery === "" ||
            (participant.displayName ?? "")
              .toLowerCase()
              .includes(mentionQuery.toLowerCase())),
      );
      const focusComposerAt = (cursor) => {
        window.requestAnimationFrame(() => {
          const field = composerInputRef.current;
          if (!field) return;
          field.focus();
          field.setSelectionRange(cursor, cursor);
        });
      };
      const insertMentionTrigger = () => {
        const input = composerInputRef.current;
        const start = input?.selectionStart ?? content.length;
        const end = input?.selectionEnd ?? start;
        mentionAnchorRef.current = { start };
        setContent(`${content.slice(0, start)}@${content.slice(end)}`);
        setMentionOpen(true);
        setMentionQuery("");
        focusComposerAt(start + 1);
      };
      const closeMention = () => {
        setMentionOpen(false);
        setMentionQuery("");
        mentionAnchorRef.current = null;
      };
      const mentionChanged = (value) => {
        setContent(value);
        const range = mentionTokenRange(value);
        if (range) {
          mentionAnchorRef.current = { start: range.start };
          setMentionOpen(true);
          setMentionQuery(value.slice(range.start + 1, range.end));
        } else {
          closeMention();
        }
      };
      const toggleMention = () => {
        if (mentionOpen) {
          closeMention();
          return;
        }
        insertMentionTrigger();
      };
      const pickMention = (participant) => {
        const range = mentionTokenRange(
          content,
          mentionAnchorRef.current?.start,
        );
        const start = range?.start ?? content.length;
        const end = range?.end ?? content.length;
        const token = `@${participant.displayName} `;
        const cursor = start + token.length;
        setContent(`${content.slice(0, start)}${token}${content.slice(end)}`);
        setMentionIds((ids) => new Set(ids).add(participant.id));
        setMentionOpen(false);
        setMentionQuery("");
        mentionAnchorRef.current = null;
        focusComposerAt(cursor);
      };

      async function openAttachment(attachment) {
        try {
          const result = await request(
            `/api/collab/meeting/file?fileId=${encodeURIComponent(attachment.id)}`,
          );
          const file = result.file;
          const binary = atob(file.data ?? "");
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1)
            bytes[index] = binary.charCodeAt(index);
          const url = URL.createObjectURL(
            new Blob([bytes], {
              type: file.mime || attachment.mime || "application/octet-stream",
            }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = file.name || attachment.name || "file";
          link.click();
          URL.revokeObjectURL(url);
        } catch (cause) {
          setError(errText(cause));
        }
      }

      async function uploadFile(file) {
        if (file === undefined) return;
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(String(reader.result ?? "").split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        await run("upload", () =>
          post("/api/collab/meeting/file", {
            meetingId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            data,
          }),
        );
      }

      const saveCenterSettings = async () => {
        if (meeting === undefined) return;
        const title = centerTitleDraft.trim();
        if (title === "") return;
        await run("meeting-settings", async () => {
          await post("/api/collab/meeting/update", {
            meetingId,
            title,
            agenda: centerAgendaDraft,
          });
          setNotice("会议设置已更新");
        });
      };

      const removeCenterMember = async (participant) => {
        await run("member", () =>
          participant.kind === "facilitator" ||
          participant.refId === "meeting-facilitator"
            ? post("/api/collab/meeting/facilitator/close", { meetingId })
            : post("/api/collab/meeting/participant/remove", {
                meetingId,
                participantId: participant.id,
              }),
        );
      };

      const centerTabBar = meeting && meeting.kind !== "ai"
        ? h(
            "div",
            {
              role: "tablist",
              "aria-label": "会议工作区页签",
              style: PS.centerTabs,
            },
            ...[
              ["conversation", "对话"],
              ["minutes", "纪要"],
              ["settings", "设置"],
            ].map(([key, label]) =>
              h("button", {
                key,
                type: "button",
                role: "tab",
                style: Object.assign(
                  {},
                  PS.centerTab,
                  centerTab === key ? PS.tabActive : {},
                ),
                "aria-selected": centerTab === key,
                onClick: () => setCenterTab(key),
                children: label,
              }),
            ),
          )
        : null;

      const centerMemberRows = [
        ...bucket.human,
        ...bucket.service,
        ...bucket.ai,
      ];

      const centerSettings = meeting
        ? h("div", { key: "center-settings", style: PS.centerSettings }, [
            h(
              "div",
              { style: PS.summaryFacts },
              h("div", { style: PS.summaryFact }, [
                h("span", { style: PS.summaryLabel, children: "关联项目" }),
                h("span", {
                  style: PS.summaryValue,
                  children: projectName || "未分组",
                }),
              ]),
              h("div", { style: PS.summaryFact }, [
                h("span", { style: PS.summaryLabel, children: "会议状态" }),
                h("span", {
                  style: PS.summaryValue,
                  children: meetingStatusLabel(meeting.status),
                }),
              ]),
            ),
            h("div", { style: PS.group }, [
              h("div", { style: PS.groupTitle, children: "会议名称" }),
              h("input", {
                style: PS.input,
                value: centerTitleDraft,
                placeholder: "会议名称",
                "aria-label": "中心会议名称",
                disabled: meeting.status === "archived",
                onChange: (event) =>
                  setCenterTitleDraft(event.target.value),
              }),
            ]),
            h("div", { style: PS.group }, [
              h("div", { style: PS.groupTitle, children: "会议议程" }),
              h("textarea", {
                style: Object.assign({}, PS.textarea, { minHeight: 120 }),
                value: centerAgendaDraft,
                placeholder: "暂无议程，可在此补充",
                disabled: meeting.status === "archived",
                onChange: (event) =>
                  setCenterAgendaDraft(event.target.value),
              }),
            ]),
            h("div", { style: PS.group }, [
              h("div", { style: PS.groupTitle, children: "AI 会议 Facilitator" }),
              h(
                "label",
                {
                  style: {
                    alignItems: "center",
                    background: "var(--dsw-alias-bg-layer-1)",
                    border: "0.5px solid var(--dsw-alias-border-l3)",
                    borderRadius: 6,
                    cursor:
                      meeting.status === "archived" || busy !== ""
                        ? "not-allowed"
                        : "pointer",
                    display: "flex",
                    gap: 8,
                    opacity:
                      meeting.status === "archived" || busy !== ""
                        ? 0.55
                        : 1,
                    padding: "8px 9px",
                  },
                },
                h("input", {
                  type: "checkbox",
                  checked: activeFacilitator !== undefined,
                  disabled: meeting.status === "archived" || busy !== "",
                  onChange: (event) =>
                    void run("facilitator", () =>
                      event.target.checked
                        ? post("/api/collab/meeting/facilitator/open", {
                            meetingId,
                          })
                        : post("/api/collab/meeting/facilitator/close", {
                            meetingId,
                          }),
                    ),
                }),
                h("span", {
                  style: { flex: 1, fontSize: 12 },
                  children: "启用 AI 会议 Facilitator",
                }),
                h("span", {
                  style: PS.meta,
                  children:
                    activeFacilitator === undefined ? "未启用" : "已启用",
                }),
              ),
            ]),
            h("div", { style: PS.group }, [
              h(
                "div",
                {
                  style: {
                    alignItems: "center",
                    display: "flex",
                    gap: 8,
                  },
                },
                h("div", {
                  style: Object.assign({}, PS.groupTitle, { flex: 1 }),
                  children: `会议成员（${centerMemberRows.length}）`,
                }),
                joined && meeting.status === "active"
                  ? h("button", {
                      type: "button",
                      style: PS.ghostBtn,
                      disabled: busy !== "",
                      onClick: () => setInviteOpen(true),
                      children: "邀请成员",
                    })
                  : null,
              ),
              h(
                "div",
                { style: PS.centerMembers },
                ...centerMemberRows.map((participant) => {
                  const teammate =
                    participant.kind === "human"
                      ? undefined
                      : teammates.find(
                          (item) =>
                            item.id ===
                              (participant.teammateInstanceId ??
                                participant.refId) ||
                            item.name === participant.displayName,
                        );
                  const ai =
                    participant.kind !== "human";
                  return h(
                    "div",
                    {
                      key: participant.id,
                      style: PS.centerMember,
                    },
                    ai
                      ? h(
                          "span",
                          {
                            style: teammateRingStyle(
                              teammate?.source === "platform",
                            ),
                          },
                          avatarArt(teammate?.avatar),
                        )
                      : h(
                          "span",
                          { style: initialsAvatarStyle },
                          initials(participant.displayName),
                        ),
                    h("div", { style: PS.centerMemberCopy }, [
                      h("div", {
                        style: {
                          alignItems: "center",
                          display: "flex",
                          gap: 6,
                          minWidth: 0,
                        },
                      }, [
                        h("span", {
                          style: PS.centerMemberName,
                          children: participant.displayName,
                        }),
                        ai
                          ? h("span", {
                              style: PS.tag,
                              children:
                                participant.kind === "facilitator"
                                  ? "会议服务"
                                  : "AI",
                            })
                          : null,
                      ]),
                      h("span", {
                        style: PS.meta,
                        children:
                          participant.kind === "human"
                            ? "会议成员"
                            : participant.kind === "facilitator"
                              ? "会议服务"
                              : participant.principalName
                                ? `代表 ${participant.principalName}`
                                : "AI 伙伴",
                      }),
                    ]),
                    h("button", {
                      type: "button",
                      style: PS.ghostBtn,
                      disabled: busy !== "",
                      onClick: () => void removeCenterMember(participant),
                      children: "移除",
                    }),
                  );
                }),
              ),
            ]),
            h("div", { style: PS.group }, [
              h("div", { style: PS.groupTitle, children: "会议操作" }),
              h(
                "div",
                { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                joined && meeting.status === "active"
                  ? h("button", {
                      type: "button",
                      style: PS.ghostBtn,
                      disabled: busy !== "",
                      onClick: () => setDelegateOpen(true),
                      children: "指派 AI 参会",
                    })
                  : null,
                joined && meeting.status === "active"
                  ? h("button", {
                      type: "button",
                      style: PS.ghostBtn,
                      disabled: busy !== "",
                      onClick: () => {
                        setCloseOpen(true);
                        setCloseSummary("");
                      },
                      children: "关闭会议",
                    })
                  : null,
                meeting.status === "closed"
                  ? h("button", {
                      type: "button",
                      style: PS.ghostBtn,
                      disabled: busy !== "",
                      onClick: () =>
                        run("archive", () =>
                          post("/api/collab/meeting/archive", { meetingId }),
                        ),
                      children: "归档会议",
                    })
                  : null,
              ),
            ]),
            meeting.status === "archived"
              ? h("div", {
                  style: PS.meta,
                  children: "已归档会议不可编辑。",
                })
              : h(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end" } },
                  h("button", {
                    type: "button",
                    style: PS.primaryBtn,
                    disabled:
                      busy !== "" ||
                      centerTitleDraft.trim() === "" ||
                      (centerTitleDraft.trim() === meeting.title &&
                        centerAgendaDraft === (meeting.agenda ?? "")),
                    onClick: () => void saveCenterSettings(),
                    children:
                      busy === "meeting-settings" ? "保存中…" : "保存设置",
                  }),
                ),
          ])
        : null;

      const chat = meeting
        ? h(
            "div",
            {
              style: Object.assign(
                {},
                PS.chat,
                compactLayout ? { width: "100%" } : {},
              ),
            },
            [
            h("div", {
              role: "group",
              "aria-label": "当前沟通头部",
              style: PS.chatHead,
            }, [
              h("div", { style: { flex: 1, minWidth: 0 } }, [
                h(
                  "div",
                  {
                    style: {
                      alignItems: "center",
                      display: "flex",
                      gap: 8,
                      minWidth: 0,
                    },
                  },
                  isAiConversation
                    ? h(
                        "span",
                        {
                          style: Object.assign(
                            {},
                            teammateRingStyle(
                              aiConversationTeammate?.source === "platform",
                            ),
                            { height: 28, padding: 2, width: 28 },
                          ),
                          title: meeting.title,
                          "aria-label": `${meeting.title} 头像`,
                        },
                        avatarArt(aiConversationTeammate?.avatar),
                      )
                    : null,
                  h("div", {
                    style: {
                      flex: isAiConversation ? "0 1 auto" : 1,
                      fontSize: 15,
                      fontWeight: 600,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                    children: meeting.title,
                  }),
                  isAiConversation
                    ? h("span", {
                        style: Object.assign({}, panelStyles.aiBadge, {
                          flexShrink: 0,
                        }),
                        children: "AI伙伴",
                      })
                    : null,
                  aiConversationUnavailable
                    ? h("span", {
                        style: PS.unavailableTag,
                        title: aiConversationUnavailableReason,
                        children: "不可用",
                      })
                    : null,
                  isAiConversation
                    ? h("span", { style: { flex: 1, minWidth: 0 } })
                    : null,
                  !isAiConversation
                    ? h("span", {
                        style: meetingStatusTone(meeting.status),
                        children: meetingStatusLabel(meeting.status),
                      })
                    : h("time", {
                        style: Object.assign({}, PS.threadTime, {
                          fontSize: 10.5,
                        }),
                        dateTime: meetingActivityTime(meeting),
                        title: `最近更新 ${timeFull(meetingActivityTime(meeting))}`,
                        "aria-label": `最近更新时间 ${timeShort(meetingActivityTime(meeting))}`,
                        children:
                          timeShort(meetingActivityTime(meeting)) || "—",
                      }),
                ),
                h("div", {
                  style: PS.meta,
                  children: isAiConversation
                    ? meetingTimeLabel(meeting)
                    : `${meetingTimeLabel(meeting)} · ${projectName || "未分组"} · ${participants.filter((participant) => participant.status === "active").length} 人 · ${bucket.ai.length} 个 AI`,
                }),
              ]),
              h(
                "div",
                {
                  style: {
                    alignItems: "center",
                    display: "flex",
                    flexShrink: 0,
                    gap: 8,
                  },
                },
                !joined
                  ? h("button", {
                      type: "button",
                      style: PS.primaryBtn,
                      disabled: busy !== "",
                      onClick: () =>
                        run("join", () =>
                          post("/api/collab/meeting/join", {
                            meetingId,
                            displayName:
                              accountName || `用户-${actorId.slice(0, 6)}`,
                          }),
                        ),
                      children: "加入会议",
                    })
                  : null,
                centerTabBar,
              ),
            ]),
            isAiConversation || centerTab === "conversation"
              ? stream
              : centerTab === "minutes"
                ? minutesTab
                : centerSettings,
            (isAiConversation || centerTab === "conversation") &&
            meeting.status === "active" &&
            joined
              ? h("div", { style: { flexShrink: 0, position: "relative" } }, [
                  mentionOpen
                    ? h(
                        "div",
                        { style: PS.mentionMenu },
                        ...(mentionOptions.length > 0
                          ? mentionOptions.map((participant) =>
                              h("button", {
                                type: "button",
                                key: participant.id,
                                style: PS.mentionItem,
                                onClick: () => pickMention(participant),
                                children: [
                                  participantAvatarNode(participant, teammates),
                                  h(
                                    "span",
                                    { style: PS.mentionCopy },
                                    h("span", {
                                      style: PS.mentionName,
                                      children: participant.displayName,
                                    }),
                                    h("span", {
                                      style: PS.mentionMeta,
                                      children:
                                        participant.kind === "human"
                                          ? "会议成员"
                                          : participant.ownerName
                                            ? `${participant.ownerName} 的 AI`
                                            : "AI 成员",
                                    }),
                                  ),
                                ],
                              }),
                            )
                          : [
                              h("div", {
                                key: "empty",
                                style: PS.mentionItem,
                                children: "没有匹配成员",
                              }),
                            ]),
                      )
                    : null,
                  h(
                    "form",
                    {
                      style: PS.inputRow,
                      onSubmit: async (event) => {
                        event.preventDefault();
                        const text = content.trim();
                        if (text === "") return;
                        setContent("");
                        setMentionOpen(false);
                        await run("send", () =>
                          post("/api/collab/meeting/message", {
                            meetingId,
                            content: text,
                            mentions: [...mentionIds],
                          }),
                        );
                        setMentionIds(new Set());
                      },
                    },
                    // 附件 / @ 收成小图标，放在输入框上方（与右侧栏一致）。
                    h("div", { style: PS.composerTools }, [
                      h(
                        "button",
                        {
                          type: "button",
                          style: PS.composerBtn,
                          title: "上传文件",
                          "aria-label": "上传文件",
                          onClick: () => fileRef.current?.click(),
                        },
                        clipIcon(),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          style: PS.composerBtn,
                          title: "提及成员",
                          "aria-label": "提及成员",
                          onClick: toggleMention,
                        },
                        atIcon(),
                      ),
                      h("input", {
                        ref: fileRef,
                        type: "file",
                        style: { display: "none" },
                        onChange: (event) => {
                          void uploadFile(event.target.files?.[0]);
                          event.target.value = "";
                        },
                      }),
                    ]),
                    h("div", { style: PS.composerRow }, [
                      h("textarea", {
                        ref: composerInputRef,
                        style: Object.assign({}, PS.textarea, {
                          minHeight: 72,
                        }),
                        rows: 3,
                        value: content,
                        placeholder: "输入消息，@ 成员…",
                        onChange: (event) => mentionChanged(event.target.value),
                        onBlur: () => {
                          if (!mentionOpen) closeMention();
                        },
                      }),
                      h("button", {
                        type: "submit",
                        style: Object.assign({}, PS.sendBtn, {
                          opacity:
                            busy !== "" || content.trim() === "" ? 0.45 : 1,
                        }),
                        title: "发送消息",
                        "aria-label": "发送消息",
                        disabled: busy !== "" || content.trim() === "",
                        children: sendIcon(),
                      }),
                    ]),
                  ),
                ])
              : null,
            ],
          )
        : h(
            "div",
            {
              style: Object.assign({}, PS.chat, {
                alignItems: "center",
                justifyContent: "center",
                ...(compactLayout ? { width: "100%" } : {}),
              }),
            },
            h("div", { style: PS.meta, children: "选择或创建一个会议" }),
          );

      /** 方案 B：在"只看已加入项目"与"全量（管理员）"之间切换。 */
      const setShowAllProjects = (next) => {
        showAllWorkspacesRef.current = next;
        scopeStore.setAll(next);
        setWorkspaceFilter("all");
      };

      const meetingListHeader = h("div", { style: PS.listHeader }, [
        h(
          "div",
          {
            style: {
              display: "grid",
              gap: 6,
              gridTemplateColumns: "112px minmax(0,1fr) 32px",
            },
          },
          h(
            "select",
            {
              style: Object.assign({}, PS.select, {
                height: 32,
                minWidth: 0,
                padding: "0 8px",
                width: "100%",
              }),
              value: workspaceFilter,
              "aria-label": "项目筛选",
              title: "项目筛选",
              onChange: (event) => {
                setWorkspaceFilter(event.target.value);
                setMeetingId("");
              },
            },
            h("option", { value: "all", children: "全部项目" }),
            ...visibleWorkspaces.map((workspace) =>
              h("option", {
                key: workspace.id,
                value: workspace.id,
                children: workspaceLabel(workspace),
              }),
            ),
          ),
          h(
            "label",
            {
              style: PS.searchShell,
            },
            h("span", {
              style: {
                color: "var(--dsw-alias-label-secondary)",
                display: "grid",
                flexShrink: 0,
                placeItems: "center",
              },
              children: searchIcon(13),
            }),
            h("input", {
              ref: searchInputRef,
              style: PS.searchField,
              value: search,
              placeholder: "搜索 AI伙伴、Owner、会议、项目",
              "aria-label": "通用搜索",
              onChange: (event) => setSearch(event.target.value),
            }),
          ),
          h(
            "button",
            {
              type: "button",
              style: PS.iconBtn,
              "aria-label": "执行通用搜索",
              title: "执行通用搜索",
              onClick: () => searchInputRef.current?.focus(),
            },
            searchIcon(14),
          ),
        ),
        h(
          "div",
          {
            role: "group",
            "aria-label": "沟通类型筛选",
            style: PS.typeTags,
          },
          ...[
            ["all", "全部"],
            ["ai", "AI伙伴"],
            ["meeting", "会议"],
          ].map(([key, label]) =>
            h("button", {
              key,
              type: "button",
              style: Object.assign(
                {},
                PS.typeTag,
                communicationFilter === key ? PS.typeTagActive : {},
              ),
              "aria-pressed": communicationFilter === key,
              onClick: () => setCommunicationFilter(key),
              children: label,
            }),
          ),
        ),
      ]);

      const meetingFilters = isPlatformAdmin
        ? h("div", { style: PS.topFilters }, [
            h(
              "div",
              {
                role: "group",
                "aria-label": "项目范围",
                style: PS.filterSegment,
              },
              h("button", {
                type: "button",
                style: Object.assign(
                  {},
                  PS.filterBtn,
                  showAllWorkspaces ? {} : PS.filterBtnActive,
                ),
                "aria-pressed": !showAllWorkspaces,
                onClick: () => {
                  if (showAllWorkspaces) setShowAllProjects(false);
                },
                children: "仅看已加入",
              }),
              h("button", {
                type: "button",
                style: Object.assign(
                  {},
                  PS.filterBtn,
                  showAllWorkspaces ? PS.filterBtnActive : {},
                ),
                "aria-pressed": showAllWorkspaces,
                onClick: () => {
                  if (!showAllWorkspaces) setShowAllProjects(true);
                },
                children: "平台全量",
              }),
            ),
          ])
        : null;

      const teammateRowNode = (row) => {
        const teammate = row.teammate;
        const selected = row.conversation?.id === meetingId;
        const loading = busy === `ai-chat:${teammate.id}`;
        const owner = teammate.ownerName?.trim() || teammate.ownerUserId?.trim();
        const unavailable = teammateIsUnavailable(teammate);
        const unavailableReason = teammateUnavailableReason(teammate);
        const unreadCount = Number(row.conversation?.unreadCount ?? 0);
        const preview = meetingPreviewText(
          row.conversation,
          loading ? "正在打开默认对话…" : "暂无消息",
        );
        const speaker = meetingLastMessageText(row.conversation)
          ? meetingLastMessageSpeaker(row.conversation, teammate.name)
          : "";
        return h(
          "button",
          {
            type: "button",
            key: row.id,
            "aria-label": `打开与 ${teammate.name} 的默认对话`,
            disabled: busy !== "",
            style: Object.assign(
              {},
              PS.item,
              PS.itemIdle,
              selected ? PS.itemActive : {},
              busy !== "" && !loading ? { opacity: 0.55 } : {},
            ),
            onClick: () => void openTeammateConversation(teammate),
          },
          h(
            "div",
            { style: PS.threadHead },
            h(
              "span",
              {
                style: Object.assign(
                  {},
                  teammateRingStyle(teammate.source === "platform"),
                  { borderRadius: 6, height: 24, width: 24 },
                ),
              },
              avatarArt(teammate.avatar),
            ),
            h(
              "div",
              {
                style: {
                  alignItems: "center",
                  display: "flex",
                  flex: 1,
                  gap: 5,
                  minWidth: 0,
                },
              },
              [
                h("strong", {
                  style: Object.assign({}, PS.threadTitle, {
                    flex: "0 1 auto",
                  }),
                  children: teammate.name,
                }),
                owner
                  ? h("span", {
                      style: PS.threadSub,
                      children: `（${owner}）`,
                    })
                  : null,
                unavailable
                  ? h("span", {
                      style: PS.unavailableTag,
                      title: unavailableReason,
                      children: "不可用",
                    })
                  : null,
              ],
            ),
            h("time", {
              style: PS.threadTime,
              dateTime:
                row.conversation === undefined
                  ? undefined
                  : meetingActivityTime(row.conversation),
              children: row.conversation
                ? timeShort(meetingActivityTime(row.conversation))
                : "—",
            }),
            unreadCount > 0
              ? h("span", {
                  style: PS.unreadBadge,
                  title: `${unreadCount} 条未读消息`,
                  "aria-label": `${unreadCount} 条未读消息`,
                  children: unreadCount > 99 ? "99+" : String(unreadCount),
                })
              : null,
          ),
          h(
            "div",
            { style: PS.threadPreview },
            h(
              "span",
              { style: PS.threadPreviewText },
              speaker !== ""
                ? h("span", {
                    style: PS.threadSpeaker,
                    children: `${speaker}：`,
                  })
                : null,
              preview,
            ),
          ),
        );
      };

      const meetingRowNode = (row) => {
        const item = row.item;
        const aiConversation = item.kind === "ai";
        const teammate = aiConversation
          ? teammateById.get(item.teammateInstanceId)
          : undefined;
        const unreadCount = Number(item.unreadCount ?? 0);
        const preview = meetingPreviewText(item);
        const speaker = meetingLastMessageText(item)
          ? meetingLastMessageSpeaker(item, teammate?.name)
          : "";
        return h(
          "button",
          {
            type: "button",
            key: item.id,
            "aria-label": `打开会议 ${item.title}`,
            style: Object.assign(
              {},
              PS.item,
              PS.itemIdle,
              item.id === meetingId ? PS.itemActive : {},
            ),
            onMouseDown: () => setMeetingId(item.id),
            onClick: () => setMeetingId(item.id),
          },
          h(
            "div",
            { style: PS.threadHead },
            h(
              "span",
              {
                style: PS.threadAvatar,
                title: aiConversation ? "AI 对话" : "会议",
              },
              aiConversation
                ? avatarArt(teammate?.avatar)
                : videoIcon(13),
            ),
            h(
              "div",
              {
                style: {
                  alignItems: "center",
                  display: "flex",
                  flex: 1,
                  gap: 5,
                  minWidth: 0,
                },
              },
              [
                h("strong", {
                  style: Object.assign({}, PS.threadTitle, {
                    flex: "0 1 auto",
                  }),
                  children: item.title,
                }),
                aiConversation
                  ? teammate?.ownerName
                    ? h("span", {
                        style: PS.threadSub,
                        children: `（${teammate.ownerName}）`,
                      })
                    : null
                  : h("span", {
                      style: PS.threadSub,
                      children:
                        workspaceNameById.get(item.workspaceId) ?? "未分组",
                    }),
              ],
            ),
            h("time", {
              style: PS.threadTime,
              dateTime: meetingActivityTime(item),
              children: timeShort(meetingActivityTime(item)) || "—",
            }),
            unreadCount > 0
              ? h("span", {
                  style: PS.unreadBadge,
                  title: `${unreadCount} 条未读消息`,
                  "aria-label": `${unreadCount} 条未读消息`,
                  children: unreadCount > 99 ? "99+" : String(unreadCount),
                })
              : null,
          ),
          h(
            "div",
            { style: PS.threadPreview },
            h(
              "span",
              { style: PS.threadPreviewText },
              speaker !== ""
                ? h("span", {
                    style: PS.threadSpeaker,
                    children: `${speaker}：`,
                  })
                : null,
              preview,
            ),
          ),
        );
      };

      const closedMeetingNodes = () => {
        if (closedMeetingRows.length === 0) return [];
        return [
          h(
            "button",
            {
              type: "button",
              key: "closed-meetings",
              "aria-expanded": closedOpen,
              "aria-label": closedOpen
                ? "收起已关闭会议"
                : "展开已关闭会议",
              style: PS.listSection,
              onClick: () => setClosedOpen((value) => !value),
            },
            h("span", { style: PS.listSectionLabel }, [
              h("span", { children: "已关闭会议" }),
              h("span", {
                style: PS.tag,
                children: String(closedMeetingRows.length),
              }),
            ]),
            h("span", { children: closedOpen ? "▾" : "▸" }),
          ),
          ...(closedOpen
            ? closedMeetingRows.map((row) => meetingRowNode(row))
            : []),
        ];
      };

      let listItemNodes = [];
      if (showArchived) {
        listItemNodes =
          rankedArchivedRows.length === 0
            ? [
                h("div", {
                  key: "archived-empty",
                  style: PS.meta,
                  children: normalizedQuery === ""
                    ? "暂无已归档会议"
                    : "没有匹配的已归档会议",
                }),
              ]
            : rankedArchivedRows.map((row) => meetingRowNode(row));
      } else {
        listItemNodes = [
          ...rankedConversationRows.map((row) =>
            row.teammate === undefined
              ? meetingRowNode(row)
              : teammateRowNode(row),
          ),
          ...closedMeetingNodes(),
        ];
        if (visibleResultCount === 0) {
          listItemNodes = [
            h("div", {
              key: "list-empty",
              style: PS.meta,
              children:
                normalizedQuery === ""
                  ? "暂无沟通"
                  : "没有匹配的沟通",
            }),
          ];
        }
      }

      return h("div", {
        style: Object.assign(
          {},
          PS.root,
          compactLayout ? { gap: 8, padding: 10 } : {},
        ),
      }, [
        h("div", { style: PS.top }, [
          h("h1", { style: PS.title, children: "沟通" }),
          h("div", { style: PS.topActions }, [
            meetingFilters,
            h("button", {
              type: "button",
              style: PS.primaryBtn,
              disabled: visibleWorkspaces.length === 0,
              onClick: () => setCreateOpen(true),
              children: "新建会议",
            }),
            // 已归档入口：放在「新建会议」右侧；进入归档列表后变成「返回会议列表」。
            archivedMeetings.length > 0
              ? h("button", {
                  type: "button",
                  style: Object.assign({}, PS.select, {
                    cursor: "pointer",
                    flexShrink: 0,
                    height: 34,
                    padding: "0 12px",
                    fontSize: 12.5,
                    whiteSpace: "nowrap",
                    ...(showArchived
                      ? {
                          background:
                            "color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 14%,transparent)",
                          color:
                            "var(--dsw-alias-accent-primary,#4f8ef7)",
                        }
                      : {}),
                  }),
                  "aria-pressed": showArchived,
                  title: showArchived ? "返回会议列表" : "查看已归档会议",
                  onClick: () => {
                    setShowArchived((value) => !value);
                    setMeetingId("");
                  },
                  children: showArchived
                    ? "返回会议列表"
                    : `已归档 ${archivedMeetings.length}`,
                })
              : null,
            // 会议页右上角也提供侧边栏开关（与中间区域的会议图标等价）。
            h(
              "button",
              {
                type: "button",
                style: Object.assign(
                  {},
                  PS.sidebarBtn,
                  meetingPanelOpen ? PS.sidebarBtnActive : {},
                ),
                title: meetingPanelOpen ? "关闭会议侧边栏" : "打开会议侧边栏",
                "aria-label": "会议侧边栏",
                "aria-pressed": meetingPanelOpen,
                onClick: () => window.__pluginmaxMeeting?.toggle(),
              },
              videoIcon(),
            ),
          ]),
        ]),
        banner,
        closeOpen
          ? h(
              "div",
              { style: Object.assign({}, PS.banner, PS.notice) },
              h("div", {
                style: { marginBottom: 6 },
                children: "散会摘要（可留空）",
              }),
              h("textarea", {
                style: PS.textarea,
                value: closeSummary,
                "aria-label": "散会摘要",
                onChange: (event) => setCloseSummary(event.target.value),
              }),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: 8,
                    justifyContent: "flex-end",
                    marginTop: 6,
                  },
                },
                h("button", {
                  type: "button",
                  style: PS.ghostBtn,
                  onClick: () => setCloseOpen(false),
                  children: "取消",
                }),
                h("button", {
                  type: "button",
                  style: PS.primaryBtn,
                  disabled: busy !== "",
                  onClick: () => {
                    void run("close", async () => {
                      await post("/api/collab/meeting/close", {
                        meetingId,
                        summary: closeSummary,
                      });
                      setCloseOpen(false);
                    });
                  },
                  children: "确认散会",
                }),
              ),
            )
          : null,
        minutesOverwriteOpen
          ? h(
              "div",
              { style: PS.overlay },
              h(
                "form",
                {
                  style: PS.modal,
                  onSubmit: (event) => {
                    event.preventDefault();
                    setMinutesOverwriteOpen(false);
                    void run("minutes", () =>
                      post("/api/collab/meeting/minutes/trigger", {
                        meetingId,
                      }),
                    );
                  },
                },
                [
                  h("div", { style: PS.title, children: "重新生成会议纪要？" }),
                  h("div", {
                    style: PS.meta,
                    children: "当前会议纪要已有内容，重新生成会覆盖原有内容。",
                  }),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        gap: 8,
                        justifyContent: "flex-end",
                      },
                    },
                    [
                      h("button", {
                        type: "button",
                        style: PS.ghostBtn,
                        onClick: () => setMinutesOverwriteOpen(false),
                        children: "取消",
                      }),
                      h("button", {
                        type: "submit",
                        style: PS.primaryBtn,
                        disabled: busy !== "",
                        children: "覆盖生成",
                      }),
                    ],
                  ),
                ],
              ),
            )
          : null,
        h("div", {
          style: Object.assign(
            {},
            PS.body,
            compactLayout
              ? {
                  gridTemplateColumns: "minmax(0,1fr)",
                  gridTemplateRows: "minmax(190px,250px) minmax(0,1fr)",
                  minHeight: 0,
                }
              : {
                  gridTemplateColumns:
                    "minmax(270px,320px) minmax(0,1fr)",
                },
          ),
        }, [
          h(
            "div",
            {
              style: Object.assign(
                {},
                PS.list,
                compactLayout
                  ? {
                      height: "100%",
                      flexShrink: 0,
                      width: "100%",
                    }
                  : {},
              ),
            },
            meetingListHeader,
            h(
              "div",
              { style: PS.listItems },
              ...listItemNodes,
            ),
          ),
          chat,
        ]),
        briefOpen && meeting
          ? h(
              "div",
              { style: PS.overlay },
              h("div", { style: PS.modal }, [
                h("div", { style: PS.summaryHead }, [
                  h("div", { style: PS.title, children: "会议简报" }),
                  h("span", {
                    style: PS.statusPill,
                    children: meetingStatusLabel(meeting.status),
                  }),
                ]),
                h("div", { style: PS.briefSection }, [
                  h("div", {
                    style: PS.briefSectionTitle,
                    children: "会议信息",
                  }),
                  h("div", {
                    style: PS.meta,
                    children: `${meeting.title} · ${projectName || "未分组"} · ${activeHumans.length} 位人类 · ${activeAi.length} 位 AI`,
                  }),
                ]),
                h("div", { style: PS.briefSection }, [
                  h("div", {
                    style: PS.briefSectionTitle,
                    children: "会议概要",
                  }),
                  h("div", {
                    style: PS.meta,
                    children:
                      meeting.agenda?.trim() ||
                      meeting.summary?.trim() ||
                      "暂无会议议程或概要",
                  }),
                ]),
                h("div", { style: PS.briefSection }, [
                  h("div", {
                    style: PS.briefSectionTitle,
                    children: "最近沟通",
                  }),
                  recentBriefMessages.length === 0
                    ? h("div", { style: PS.meta, children: "暂无沟通记录" })
                    : h(
                        "div",
                        { style: { display: "grid", gap: 5 } },
                        ...recentBriefMessages.map((message) =>
                          h("div", {
                            key: message.id,
                            style: PS.meta,
                            children: `${message.sender}：${message.content}`,
                          }),
                        ),
                      ),
                ]),
                h("div", { style: PS.briefSection }, [
                  h("div", {
                    style: PS.briefSectionTitle,
                    children: "会议纪要",
                  }),
                  h("div", {
                    style: PS.meta,
                    children:
                      displayVersion === undefined
                        ? "暂无会议纪要"
                        : `会议纪要 v${displayVersion.version} 已生成，更新于 ${timeFull(
                            displayVersion.updatedAt ?? displayVersion.createdAt,
                          )}`,
                  }),
                ]),
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      gap: 8,
                      justifyContent: "flex-end",
                    },
                  },
                  h("button", {
                    type: "button",
                    style: PS.primaryBtn,
                    onClick: () => setBriefOpen(false),
                    children: "关闭",
                  }),
                ),
              ]),
            )
          : null,
        createOpen
          ? h(
              "div",
              { style: PS.overlay },
              h(
                "form",
                {
                  style: PS.modal,
                  onSubmit: async (event) => {
                    event.preventDefault();
                    if (newTitle.trim() === "") return;
                    await run("create", async () => {
                      const result = await post("/api/collab/meetings", {
                        workspaceId: createWorkspaceId,
                        title: newTitle.trim(),
                        agenda: newAgenda,
                      });
                      setCreateOpen(false);
                      setNewTitle("");
                      setNewAgenda("");
                      if (result?.meeting?.id) {
                        rememberEmptyMeeting(result.meeting.id);
                        setMeetings((current) => [
                          result.meeting,
                          ...current.filter(
                            (item) => item.id !== result.meeting.id,
                          ),
                        ]);
                        setMeetingId(result.meeting.id);
                      }
                    });
                  },
                },
                [
                  h("div", { style: PS.title, children: "新建会议" }),
                  h("label", { style: PS.field }, [
                    h("span", { children: "关联项目" }),
                    h(
                      "select",
                      {
                        style: PS.input,
                        value: createWorkspaceId,
                        "aria-label": "新建会议关联项目",
                        onChange: (event) =>
                          setCreateWorkspaceId(event.target.value),
                      },
                      ...visibleWorkspaces.map((workspace) =>
                        h("option", {
                          key: workspace.id,
                          value: workspace.id,
                          children:
                            workspace.id === SYSTEM_DEFAULT_WORKSPACE_ID
                              ? "默认项目（system，不关联项目）"
                              : workspaceLabel(workspace),
                        }),
                      ),
                    ),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "会议主题" }),
                    h("input", {
                      style: PS.input,
                      value: newTitle,
                      onChange: (event) => setNewTitle(event.target.value),
                    }),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "议程（可选）" }),
                    h("textarea", {
                      style: PS.textarea,
                      value: newAgenda,
                      onChange: (event) => setNewAgenda(event.target.value),
                    }),
                  ]),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        gap: 8,
                        justifyContent: "flex-end",
                      },
                    },
                    [
                      h("button", {
                        type: "button",
                        style: PS.ghostBtn,
                        onClick: () => setCreateOpen(false),
                        children: "取消",
                      }),
                      h("button", {
                        type: "submit",
                        style: PS.primaryBtn,
                        children: "创建",
                      }),
                    ],
                  ),
                ],
              ),
            )
          : null,
        inviteOpen
          ? h(
              "div",
              { style: PS.overlay },
              h(
                "form",
                {
                  style: PS.modal,
                  onSubmit: async (event) => {
                    event.preventDefault();
                    await run("invite", async () => {
                      // 一次性提交：人和 AI 在同一份清单里选好后一起发。
                      const picked = inviteCandidates.filter(
                        (item) =>
                          inviteIds.has(item.id) && item.state !== "active",
                      );
                      const people = picked.filter(
                        (item) => item.kind === "human",
                      );
                      const agents = picked.filter(
                        (item) => item.kind === "ai",
                      );
                      if (people.length > 0) {
                        await post("/api/collab/meeting/participants/invite", {
                          meetingId,
                          people: people.map((item) => ({
                            targetId: item.id,
                          })),
                        });
                      }
                      for (const agent of agents) {
                        await post("/api/collab/meeting/participant/ai", {
                          meetingId,
                          teammateInstanceId: agent.id,
                          displayName: agent.name,
                          speechMode: dform.speechMode,
                        });
                      }
                      setInviteOpen(false);
                      setInviteIds(new Set());
                      setNotice("已发送邀请");
                    });
                  },
                },
                [
                  h("div", { style: PS.title, children: "邀请成员" }),
                  h("div", { style: PS.group }, [
                    h("div", {
                      style: PS.groupTitle,
                      children: "选择参会成员（人 / AI）",
                    }),
                    inviteCandidates.length === 0
                      ? h("div", { style: PS.meta, children: "暂无可邀请成员" })
                      : h(InviteMemberPicker, {
                          items: inviteCandidates,
                          selectedIds: inviteIds,
                          onToggle: (id) =>
                            setInviteIds((ids) => {
                              const next = new Set(ids);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            }),
                        }),
                  ]),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        gap: 8,
                        justifyContent: "flex-end",
                      },
                    },
                    [
                      h("button", {
                        type: "button",
                        style: PS.ghostBtn,
                        onClick: () => setInviteOpen(false),
                        children: "取消",
                      }),
                      h("button", {
                        type: "submit",
                        style: PS.primaryBtn,
                        disabled: busy !== "",
                        children: busy === "invite" ? "发送中…" : "发送邀请",
                      }),
                    ],
                  ),
                ],
              ),
            )
          : null,
        delegateOpen
          ? h(
              "div",
              { style: PS.overlay },
              h(
                "form",
                {
                  style: PS.modal,
                  onSubmit: async (event) => {
                    event.preventDefault();
                    if (dform.teammateInstanceId === "") {
                      setError("请选择一个 AI伙伴");
                      return;
                    }
                    await run("assign", async () => {
                      await post("/api/collab/meeting/delegate/assign", {
                        meetingId,
                        teammateInstanceId: dform.teammateInstanceId,
                        speechMode: dform.speechMode,
                        instruction: {
                          goal: dform.goal,
                          stance: dform.stance,
                          mustSay: splitLines(dform.mustSay),
                          focusPoints: splitLines(dform.focusPoints),
                        },
                      });
                      setDelegateOpen(false);
                      setNotice("已指派 AI 参会代表");
                    });
                  },
                },
                [
                  h("div", { style: PS.title, children: "指派 AI 参会代表" }),
                  h("label", { style: PS.field }, [
                    h("span", { children: "选择我的 AI伙伴" }),
                    h(
                      "select",
                      {
                        style: PS.input,
                        value: dform.teammateInstanceId,
                        onChange: (event) =>
                          setDform((form) =>
                            Object.assign({}, form, {
                              teammateInstanceId: event.target.value,
                            }),
                          ),
                      },
                      h("option", { value: "", children: "请选择" }),
                      ...teammates.map((item) =>
                        h("option", {
                          key: item.id,
                          value: item.id,
                          children: `${item.name} · ${item.ownerName ?? ""}`,
                        }),
                      ),
                    ),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "发言模式" }),
                    h(
                      "select",
                      {
                        style: PS.input,
                        value: dform.speechMode,
                        onChange: (event) =>
                          setDform((form) =>
                            Object.assign({}, form, {
                              speechMode: event.target.value,
                            }),
                          ),
                      },
                      ...SPEECH_MODE_OPTIONS.map((option) =>
                        h("option", {
                          key: option.id,
                          value: option.id,
                          children: option.label,
                        }),
                      ),
                    ),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "参会目标" }),
                    h("textarea", {
                      style: PS.textarea,
                      value: dform.goal,
                      onChange: (event) =>
                        setDform((form) =>
                          Object.assign({}, form, { goal: event.target.value }),
                        ),
                    }),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "核心立场" }),
                    h("textarea", {
                      style: PS.textarea,
                      value: dform.stance,
                      onChange: (event) =>
                        setDform((form) =>
                          Object.assign({}, form, {
                            stance: event.target.value,
                          }),
                        ),
                    }),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "必须表达的要点（每行一条）" }),
                    h("textarea", {
                      style: PS.textarea,
                      value: dform.mustSay,
                      onChange: (event) =>
                        setDform((form) =>
                          Object.assign({}, form, {
                            mustSay: event.target.value,
                          }),
                        ),
                    }),
                  ]),
                  h("label", { style: PS.field }, [
                    h("span", { children: "把控点（每行一条）" }),
                    h("textarea", {
                      style: PS.textarea,
                      value: dform.focusPoints,
                      onChange: (event) =>
                        setDform((form) =>
                          Object.assign({}, form, {
                            focusPoints: event.target.value,
                          }),
                        ),
                    }),
                  ]),
                  h("div", {
                    style: PS.meta,
                    children: "委托正文仅你本人与该 AI伙伴可见。",
                  }),
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        gap: 8,
                        justifyContent: "flex-end",
                      },
                    },
                    [
                      h("button", {
                        type: "button",
                        style: PS.ghostBtn,
                        onClick: () => setDelegateOpen(false),
                        children: "取消",
                      }),
                      h("button", {
                        type: "submit",
                        style: PS.primaryBtn,
                        disabled: busy !== "",
                        children: busy === "assign" ? "指派中…" : "确认指派",
                      }),
                    ],
                  ),
                ],
              ),
            )
          : null,
      ]);
    }

    function MeetingsGlobalPage(props) {
      const route = props.useShellRoute?.((state) => state.route);
      if (route !== "meetings") return null;
      return h(MeetingsPage, props);
    }

    /* ── apply: register slots ── */

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          { name: "pluginmax.global", id: "pluginmax-meetings", order: 34 },
          MeetingsGlobalPage,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "pluginmax-meeting-panel", order: 10 },
          MeetingPanel,
        ),
      );
    };

    return module.exports;
  },
});
