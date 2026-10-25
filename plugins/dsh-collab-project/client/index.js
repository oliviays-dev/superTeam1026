window.__ModuleLoader__.load({
  id: "dsh-collab-project",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;
    const Fragment = react.Fragment;

    const TOKEN_KEY = "pluginmax.collab.token";
    const PROJECT_STATUSES = ["进行中", "规划中", "已完成", "已暂停", "风险"];
    const PROJECT_HEALTHS = ["健康", "关注", "风险"];
    const ROLE_CATEGORIES = [
      "管理",
      "执行",
      "评审",
      "审批",
      "计划",
      "采购",
      "支持",
    ];
    const PERMISSION_OPTIONS = [
      { key: "read", label: "查看" },
      { key: "write", label: "编辑" },
      { key: "approve", label: "审批" },
      { key: "manage_members", label: "成员管理" },
      { key: "manage_roles", label: "角色管理" },
    ];
    const TASK_STATUS_LABEL = {
      todo: "待处理",
      progress: "进行中",
      review: "待验收",
      done: "已完成",
      cancelled: "已取消",
    };
    const WORKFLOW_STATUS_LABEL = {
      running: "进行中",
      waiting: "等待中",
      blocked: "阻塞",
      completed: "已完成",
      cancelled: "已取消",
      failed: "失败",
    };
    const WORKFLOW_STATUS_TONE = {
      blocked: "warn",
      failed: "warn",
      completed: "done",
    };
    const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 };
    const PRIORITY_DISPLAY = { P1: "P0", P2: "P1", P3: "P2" };
    const priorityLabel = (value) => PRIORITY_DISPLAY[value] ?? value;
    const AUDIT_CATEGORY_LABELS = {
      all: "全部",
      project: "项目设置",
      member: "成员权限",
      role: "项目角色",
      template: "关联模版",
      report: "项目日报",
      identity: "账号与权限",
    };
    const PLATFORM_ROLE_LABELS = {
      admin: "平台管理员",
      owner: "平台负责人",
      member: "平台成员",
      guest: "平台访客",
    };
    const WORKSPACE_ROLE_LABELS = {
      owner: "负责人",
      member: "成员",
      guest: "访客",
    };

    /** 客户端上下文：新建项目需要调用宿主的目录选择与工作区控制器。 */
    let clientCtx = null;

    function token() {
      return window.localStorage.getItem(TOKEN_KEY);
    }

    async function request(path, options = {}) {
      const headers = { ...options.headers };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const current = token();
      if (current !== null) headers.authorization = `Bearer ${current}`;
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
        error.code = body?.error?.code;
        error.details = body?.error;
        throw error;
      }
      return body;
    }

    function initials(name) {
      const value = String(name ?? "").trim();
      if (value === "") return "—";
      const first = value.slice(0, 1);
      const words = value.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        return `${words[0].slice(0, 1)}${words[1].slice(0, 1)}`.toUpperCase();
      }
      return first.toUpperCase();
    }

    const MEMBER_AVATAR_PRESETS = [
      {
        id: "sky",
        bg: "#d9efff",
        shirt: "#568fd8",
        skin: "#f1c5a3",
        hair: "#244d77",
        accent: "#ffd166",
      },
      {
        id: "sunset",
        bg: "#ffe5d8",
        shirt: "#db6d65",
        skin: "#d99a76",
        hair: "#743d2d",
        accent: "#ff8d7a",
      },
      {
        id: "forest",
        bg: "#def6e8",
        shirt: "#3f9d73",
        skin: "#e3b08d",
        hair: "#245543",
        accent: "#67d4a1",
      },
      {
        id: "berry",
        bg: "#f1e2ff",
        shirt: "#7d59c6",
        skin: "#efb38f",
        hair: "#533275",
        accent: "#c06cff",
      },
      {
        id: "lemon",
        bg: "#fff3c9",
        shirt: "#d7a62e",
        skin: "#d49974",
        hair: "#414554",
        accent: "#f2cb45",
      },
      {
        id: "ocean",
        bg: "#d9f4ff",
        shirt: "#2f84a8",
        skin: "#ce9874",
        hair: "#164f6f",
        accent: "#4fc3e8",
      },
    ];

    function memberAvatarArt(value, key) {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        return h("img", {
          key,
          className: "pmproj-avatar-art",
          src: value,
          alt: "",
        });
      }
      const preset =
        MEMBER_AVATAR_PRESETS.find((item) => item.id === value) ??
        MEMBER_AVATAR_PRESETS[
          Math.abs(String(value ?? "").charCodeAt(0) || 0) %
            MEMBER_AVATAR_PRESETS.length
        ];
      return h(
        "svg",
        {
          key,
          className: "pmproj-avatar-art",
          viewBox: "0 0 64 64",
          "aria-hidden": "true",
        },
        h("rect", { key: "bg", width: 64, height: 64, fill: preset.bg }),
        h("circle", {
          key: "accent",
          cx: 52,
          cy: 12,
          r: 11,
          fill: preset.accent,
          opacity: 0.3,
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
        h("path", {
          key: "hair",
          d: "M16 29c0-12 7-19 17-19 10 0 16 7 16 19-4-2-7-6-9-10-5 6-14 9-24 10Z",
          fill: preset.hair,
        }),
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
      );
    }

    function MemberAvatar({ member }) {
      if (member.kind === "agent") {
        const source = member.source === "personal" ? "personal" : "platform";
        return h(
          "span",
          {
            className: `pmproj-avatar-ring ${source}`,
            role: "img",
            "aria-label": `${member.name} 的头像`,
            title: member.name,
          },
          memberAvatarArt(member.avatar ?? "", "avatar"),
        );
      }
      return h(
        "span",
        {
          className: "pmproj-avatar human",
          role: "img",
          "aria-label": `${member.name} 的头像`,
          title: member.name,
        },
        initials(member.name),
      );
    }

    function statusTone(status) {
      if (status === "风险" || status === "阻塞") return "warn";
      if (status === "已完成") return "done";
      if (status === "关注" || status === "规划中") return "notice";
      return "progress";
    }

    function permissionLabels(permissions) {
      const labels = [];
      for (const permission of permissions ?? []) {
        const option = PERMISSION_OPTIONS.find(
          (candidate) => candidate.key === permission,
        );
        const label = option === undefined ? permission : option.label;
        if (!labels.includes(label)) labels.push(label);
      }
      return labels.length === 0 ? "未分配" : labels.join("、");
    }

    function platformUserOptionLabel(member, kind) {
      if (kind === "agent") {
        const ownerName = String(member.ownerName ?? "").trim();
        return `${member.name}·AI（by ${ownerName || "实例 Owner"}）`;
      }
      return `${member.name}（${member.platformRole ?? "平台成员"}）`;
    }

    function auditCategoryLabel(category) {
      return AUDIT_CATEGORY_LABELS[category] ?? category ?? "其他";
    }

    function workspaceRoleLabel(role) {
      return WORKSPACE_ROLE_LABELS[role] ?? "不适用";
    }

    function compactWorkspacePath(path, segmentCount = 3) {
      const value = String(path ?? "").trim();
      if (value === "") return "未知";
      const parts = value.split(/[\\/]+/).filter(Boolean);
      if (parts.length === 0) return value;
      return `.../${parts.slice(-segmentCount).join("/")}`;
    }

    function auditMatches(event, keyword, category) {
      if (category !== "all" && event.category !== category) return false;
      const value = String(keyword ?? "")
        .trim()
        .toLowerCase();
      if (value === "") return true;
      const detail = Object.entries(event.detail ?? {})
        .map(([key, item]) => `${key} ${item}`)
        .join(" ");
      return `${event.summary ?? ""} ${event.actorName ?? ""} ${
        event.actorRole ?? ""
      } ${event.targetName ?? ""} ${event.action ?? ""} ${detail}`
        .toLowerCase()
        .includes(value);
    }

    function memberScopeForRoles(roles, roleIds) {
      const permissions = [];
      for (const roleId of roleIds ?? []) {
        const role = (roles ?? []).find((item) => item.id === roleId);
        for (const permission of role?.permissions ?? []) {
          permissions.push(permission);
        }
      }
      return permissionLabels(permissions);
    }

    function projectMatches(project, keyword) {
      const value = String(keyword ?? "")
        .trim()
        .toLowerCase();
      if (value === "") return true;
      return `${project.name} ${project.code} ${project.ownerName} ${project.status} ${project.health}`
        .toLowerCase()
        .includes(value);
    }

    function roleCodeKey(role) {
      return String(role?.code ?? "")
        .trim()
        .toUpperCase();
    }

    function roleFieldsDiffer(left, right) {
      const leftPermissions = [...(left.permissions ?? [])].sort().join(",");
      const rightPermissions = [...(right.permissions ?? [])].sort().join(",");
      return (
        left.name !== right.name ||
        left.category !== right.category ||
        (left.description ?? "") !== (right.description ?? "") ||
        leftPermissions !== rightPermissions
      );
    }

    /** 草稿差异：code 是业务身份；name/权限等变化不算新增/移除。 */
    function computeRoleDiff(effective, draft) {
      const effectiveByCode = new Map(
        effective.map((role) => [roleCodeKey(role), role]),
      );
      const draftByCode = new Map(
        draft.map((role) => [roleCodeKey(role), role]),
      );
      return {
        added: draft.filter((role) => !effectiveByCode.has(roleCodeKey(role))),
        updated: draft.filter((role) => {
          const original = effectiveByCode.get(roleCodeKey(role));
          return original !== undefined && roleFieldsDiffer(original, role);
        }),
        removed: effective.filter(
          (role) => !draftByCode.has(roleCodeKey(role)),
        ),
      };
    }

    /**
     * 另存项目角色时生成新的业务 code：不覆盖原角色，
     * 依次尝试 <CODE>_COPY、<CODE>_COPY_2 ...
     */
    function nextRoleCopyCode(baseCode, roles) {
      const used = new Set(roles.map((role) => roleCodeKey(role)));
      const base = `${roleCodeKey({ code: baseCode })}_COPY`;
      if (!used.has(base)) return base;
      let index = 2;
      while (used.has(`${base}_${index}`)) index += 1;
      return `${base}_${index}`;
    }

    function sortProjectTasks(tasks) {
      return [...tasks].sort((left, right) => {
        const gap =
          (PRIORITY_RANK[left.priority] ?? 9) -
          (PRIORITY_RANK[right.priority] ?? 9);
        if (gap !== 0) return gap;
        return String(right.createdAt).localeCompare(String(left.createdAt));
      });
    }

    /** 日报 Markdown → 结构化块；供渲染与测试共用。 */
    function parseReportBlocks(content) {
      const blocks = [];
      let list = null;
      for (const rawLine of String(content ?? "").split("\n")) {
        const line = rawLine.trimEnd();
        if (line.trim() === "") continue;
        if (line.startsWith("## ")) {
          list = null;
          blocks.push({ type: "heading", text: line.slice(3).trim() });
          continue;
        }
        if (line.startsWith("- ")) {
          if (list === null) {
            list = { type: "list", items: [] };
            blocks.push(list);
          }
          list.items.push(line.slice(2).trim());
          continue;
        }
        list = null;
        blocks.push({ type: "paragraph", text: line.trim() });
      }
      return blocks;
    }

    function renderInline(text, keyPrefix) {
      const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
      return parts
        .filter((part) => part !== "")
        .map((part, index) => {
          const key = `${keyPrefix}-${index}`;
          if (part.startsWith("`") && part.endsWith("`")) {
            return h("code", { key }, part.slice(1, -1));
          }
          if (part.startsWith("**") && part.endsWith("**")) {
            return h("strong", { key }, part.slice(2, -2));
          }
          return h(Fragment, { key }, part);
        });
    }

    function markdownBlocks(content) {
      return parseReportBlocks(content).map((block, index) => {
        if (block.type === "heading") {
          return h("h3", { key: `b${index}` }, block.text);
        }
        if (block.type === "list") {
          return h(
            "ul",
            { key: `b${index}` },
            block.items.map((item, itemIndex) =>
              h(
                "li",
                { key: `i${itemIndex}` },
                renderInline(item, `i${itemIndex}`),
              ),
            ),
          );
        }
        return h(
          "p",
          { key: `b${index}` },
          renderInline(block.text, `p${index}`),
        );
      });
    }

    const styles = `
      .pmproj{min-height:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);}
      .pmproj *{box-sizing:border-box;}
      .pmproj-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px;}
      .pmproj-head h1{margin:0;font-size:19px;line-height:1.3;}
      .pmproj-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      .pmproj-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
      .pmproj-btn{height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;padding:0 12px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;}
      .pmproj-btn:not(:disabled):hover{filter:brightness(1.06);}
      .pmproj-btn.secondary{background:transparent;border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-weight:500;}
      .pmproj-btn.secondary:not(:disabled):hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);filter:none;}
      .pmproj-btn.danger{background:transparent;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 45%,transparent);color:var(--dsw-alias-state-error-primary,#e5534b);font-weight:500;}
      .pmproj-btn.subtle{height:28px;padding:0 7px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-weight:400;}
      .pmproj-btn.subtle:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
      .pmproj-btn.small{height:28px;padding:0 10px;font-size:12px;}
      .pmproj-btn:disabled{opacity:.5;cursor:not-allowed;}
      .pmproj-follow-star{width:32px;height:32px;flex:none;padding:0;border-radius:999px;color:var(--dsw-alias-label-secondary);}
      .pmproj-follow-star.active{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 10%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);}
      .pmproj-layout{display:grid;grid-template-columns:minmax(230px,290px) minmax(0,1fr);gap:12px;align-items:start;}
      .pmproj-directory{display:flex;flex-direction:column;gap:8px;min-width:0;}
      .pmproj-search{display:flex;align-items:center;gap:7px;height:32px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);}
      .pmproj-search:focus-within{border-color:var(--dsw-alias-accent-primary,#4f8ef7);box-shadow:var(--focus-ring);}
      .pmproj-search svg{width:13px;height:13px;flex:none;color:var(--dsw-alias-label-secondary);}
      .pmproj-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;}
      .pmproj-directory-title{display:flex;align-items:center;justify-content:space-between;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmproj-list{display:grid;gap:5px;}
      .pmproj-list-item{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease;}
      .pmproj-list-item:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);}
      .pmproj-list-item.active{border-color:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 12%,transparent);}
      .pmproj-list-item .pmproj-pill{flex:none;}
      .pmproj-list-mark{width:24px;height:24px;flex:none;display:grid;place-items:center;border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:700;}
      .pmproj-list-copy{flex:1;min-width:0;}
      .pmproj-list-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:12px;white-space:nowrap;}
      .pmproj-list-copy small{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap;}
      .pmproj-detail{min-width:0;display:flex;flex-direction:column;gap:8px;}
      .pmproj-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}
      .pmproj-title-line{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}
      .pmproj-title-line h2{margin:0;font-size:17px;line-height:1.3;overflow-wrap:anywhere;}
      .pmproj-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px;}
      .pmproj-desc{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55;}
      .pmproj-workspace-meta{align-items:center;gap:12px;margin-top:1px;}
      .pmproj-workspace-value{display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:100%;}
      .pmproj-workspace-value code{min-width:0;overflow-wrap:anywhere;font:inherit;}
      .pmproj-copy-icon{width:22px;height:22px;flex:none;display:inline-grid;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;}
      .pmproj-copy-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
      .pmproj-copy-icon svg{width:12px;height:12px;}
      .pmproj-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;}
      .pmproj-fact{min-width:0;padding:8px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-2);}
      .pmproj-fact span{display:block;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-fact strong{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;font-size:13px;white-space:nowrap;}
      .pmproj-fact small{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap;}
      .pmproj-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:0.5px solid var(--dsw-alias-border-l3);padding-bottom:5px;}
      .pmproj-tab{border:0;border-radius:6px;padding:6px 10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
      .pmproj-tab:hover{color:var(--dsw-alias-label-primary);}
      .pmproj-tab.active{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-weight:600;}
      .pmproj-panel{display:flex;flex-direction:column;gap:8px;min-width:0;}
      .pmproj-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
      .pmproj-panel-title{display:flex;align-items:center;gap:8px;min-width:0;}
      .pmproj-panel-head h3{margin:0;font-size:13.5px;}
      .pmproj-count{color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmproj-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6;}
      .pmproj-table{display:grid;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;overflow:hidden;}
      .pmproj-row{display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(130px,1.2fr) minmax(90px,.7fr) minmax(120px,1fr) auto;gap:10px;align-items:center;padding:9px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-row:last-child{border-bottom:0;}
      .pmproj-row:hover{background:var(--dsw-alias-bg-layer-2);}
      .pmproj-role-row{display:grid;grid-template-columns:minmax(160px,1.4fr) minmax(140px,1.2fr) 90px 190px;gap:10px;align-items:center;min-height:58px;padding:9px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-role-row:last-child{border-bottom:0;}
      .pmproj-role-row:not(.removed):hover{background:var(--dsw-alias-bg-layer-2);}
      .pmproj-role-row.draft{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 7%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)));}
      .pmproj-role-row.removed{opacity:.62;}
      .pmproj-role-row.removed .pmproj-member-copy strong{text-decoration:line-through;}
      .pmproj-member{display:flex;align-items:center;gap:8px;min-width:0;}
      .pmproj-avatar{width:26px;height:26px;flex:none;display:grid;place-items:center;border-radius:7px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:700;}
      .pmproj-avatar.human{background:#2f9e66;color:#fff;}
      .pmproj-avatar-ring{width:26px;height:26px;flex:none;display:grid;place-items:center;padding:2px;border-radius:50%;background:conic-gradient(from 210deg,#8b6cff,#4f8ef7,#7ed0ff,#ff79c9,#8b6cff);box-shadow:0 0 0 1px rgba(139,108,255,.26);}
      .pmproj-avatar-ring.platform{background:#63b8ff;box-shadow:0 0 0 1px rgba(99,184,255,.55);}
      .pmproj-avatar-art{width:100%;height:100%;display:block;overflow:hidden;border:2px solid var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border-radius:50%;background:#20242a;object-fit:cover;}
      .pmproj-member-copy{min-width:0;}
      .pmproj-member-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:12px;white-space:nowrap;}
      .pmproj-member-copy small{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:10px;}
      .pmproj-label{display:block;color:var(--dsw-alias-label-secondary);font-size:10px;}
      .pmproj-value{display:block;margin-top:2px;font-size:11.5px;line-height:1.45;overflow-wrap:anywhere;}
      .pmproj-subvalue{display:block;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.4;}
      .pmproj-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;}
      .pmproj-chip{border:0.5px solid var(--dsw-alias-border-l3);border-radius:4px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);font-size:10px;white-space:nowrap;}
      .pmproj-chip.agent{color:#8b7bf7;background:color-mix(in srgb,#8b7bf7 14%,transparent);border-color:transparent;}
      .pmproj-chip.empty{border-style:dashed;color:var(--dsw-alias-label-secondary);background:transparent;}
      .pmproj-actions{display:flex;justify-content:flex-end;gap:6px;}
      .pmproj-pill{display:inline-flex;align-items:center;border-radius:999px;padding:1px 7px;font-size:10.5px;white-space:nowrap;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);}
      .pmproj-pill.progress{color:#4f8ef7;background:color-mix(in srgb,#4f8ef7 14%,transparent);}
      .pmproj-pill.notice{color:#c99a2e;background:color-mix(in srgb,#c99a2e 16%,transparent);}
      .pmproj-pill.warn{color:#e5534b;background:color-mix(in srgb,#e5534b 16%,transparent);}
      .pmproj-pill.done{color:#3fa46a;background:color-mix(in srgb,#3fa46a 16%,transparent);}
      .pmproj-items{display:grid;gap:8px;}
      .pmproj-item{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:9px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-item-main{min-width:0;}
      .pmproj-item-title{display:flex;align-items:center;gap:6px;min-width:0;}
      .pmproj-item-title .id{color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-item-title strong{overflow:hidden;text-overflow:ellipsis;font-size:12.5px;white-space:nowrap;}
      .pmproj-item-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-empty{padding:28px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:7px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;}
      .pmproj-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;}
      .pmproj-history-search{width:min(360px,100%);}
      .pmproj-toolbar input[type="date"],.pmproj-toolbar input[type="search"]{height:30px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;min-width:0;}
      .pmproj-output-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
      .pmproj-output-search{display:flex;align-items:center;gap:6px;flex:1 1 260px;min-width:180px;height:30px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);}
      .pmproj-output-search svg{width:13px;height:13px;flex:none;color:var(--dsw-alias-label-secondary);}
      .pmproj-output-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
      .pmproj-output-toolbar input[type="date"],.pmproj-output-toolbar select{height:30px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:0 7px;min-width:0;}
      .pmproj-output-range{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;}
      .pmproj-output-timeline{display:grid;gap:12px;}
      .pmproj-output-day{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:start;}
      .pmproj-output-date{position:sticky;top:8px;padding-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1.4;}
      .pmproj-output-date small{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;}
      .pmproj-output-list{display:grid;gap:7px;min-width:0;}
      .pmproj-output-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:10px 11px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-output-item:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);}
      .pmproj-output-main{min-width:0;}
      .pmproj-output-title{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap;}
      .pmproj-output-title strong{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;white-space:nowrap;}
      .pmproj-output-meta,.pmproj-output-links{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-output-source{padding:0;border:0;background:transparent;color:var(--dsw-alias-accent-primary,#4f8ef7);font:inherit;font-size:10.5px;cursor:pointer;text-align:left;}
      .pmproj-output-source:hover{text-decoration:underline;}
      .pmproj-output-node{padding:1px 7px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 35%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-accent-primary,#4f8ef7) 8%,transparent);color:var(--dsw-alias-accent-primary,#4f8ef7);font:inherit;font-size:10px;cursor:pointer;}
      .pmproj-output-actions{display:flex;align-items:flex-start;gap:6px;}
      .pmproj-output-download{display:inline-flex;align-items:center;gap:5px;}
      .pmproj-output-empty{padding:28px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:7px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;}
      .pmproj-report{display:flex;flex-direction:column;gap:8px;padding:12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-report-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;}
      .pmproj-report-head h3{margin:0;font-size:13px;}
      .pmproj-report-head small{color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-history{display:grid;gap:8px;}
      .pmproj-history-event{display:grid;grid-template-columns:8px minmax(0,1fr);gap:10px;padding:10px 11px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));}
      .pmproj-history-dot{width:7px;height:7px;margin-top:5px;border-radius:999px;background:var(--dsw-alias-button-primary-fill);}
      .pmproj-history-event.identity .pmproj-history-dot{background:#8b7bf7;}
      .pmproj-history-event.template .pmproj-history-dot{background:#c99a2e;}
      .pmproj-history-event.member .pmproj-history-dot{background:#3fa46a;}
      .pmproj-history-body{min-width:0;}
      .pmproj-history-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;}
      .pmproj-history-title{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap;}
      .pmproj-history-title strong{font-size:12.5px;line-height:1.5;overflow-wrap:anywhere;}
      .pmproj-history-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:10.5px;}
      .pmproj-history-detail{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 10px;margin-top:7px;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.5;}
      .pmproj-history-detail dt{color:var(--dsw-alias-label-secondary);}
      .pmproj-history-detail dd{margin:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}
      .pmproj-markdown{font-size:12.5px;line-height:1.7;}
      .pmproj-markdown h3{margin:10px 0 6px;font-size:12.5px;color:var(--dsw-alias-label-primary);}
      .pmproj-markdown h3:first-child{margin-top:0;}
      .pmproj-markdown p{margin:4px 0;}
      .pmproj-markdown ul{margin:4px 0;padding-left:18px;display:grid;gap:3px;}
      .pmproj-markdown code{border-radius:4px;padding:0 4px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;}
      .pmproj-section{display:flex;flex-direction:column;gap:8px;margin-top:4px;}
      .pmproj-section-title{display:flex;align-items:center;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmproj-inline-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;}
      .pmproj-inline-form select,.pmproj-inline-form input{flex:1;min-width:140px;height:30px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;}
      .pmproj-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
      .pmproj-form-grid .wide{grid-column:1 / -1;}
      .pmproj-settings-basics{gap:8px 14px;margin-top:2px;}
      .pmproj-settings-basics .pmproj-field{gap:4px;}
      .pmproj-settings-basics .pmproj-footer{margin-top:2px;padding-top:8px;}
      .pmproj-field{display:grid;gap:5px;min-width:0;}
      .pmproj-field .label{color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmproj-field input,.pmproj-field select,.pmproj-field textarea{width:100%;height:32px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 9px;min-width:0;}
      .pmproj-field textarea{height:auto;min-height:78px;padding:8px 9px;resize:vertical;}
      .pmproj-field input:disabled,.pmproj-field select:disabled{opacity:.7;}
      .pmproj-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}
      .pmproj-checkboxes{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;}
      .pmproj-checkbox{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;cursor:pointer;}
      .pmproj-checkbox:has(input:checked){border-color:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 50%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 12%,transparent);}
      .pmproj-checkbox input{margin:0;}
      .pmproj-modal-mask{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(8,10,14,.55);}
      .pmproj-modal-mask.open{display:flex;}
      .pmproj-modal{width:min(680px,100%);max-height:86vh;overflow:auto;padding:16px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:0 18px 48px rgba(0,0,0,.35);}
      .pmproj-modal.wide{width:min(960px,100%);}
      .pmproj-modal.wide .pmproj-modal-head{margin-bottom:8px;}
      .pmproj-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}
      .pmproj-modal-head h2{margin:0;font-size:14.5px;}
      .pmproj-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5534b) 45%,transparent);border-radius:6px;color:var(--dsw-alias-state-error-primary,#e5534b);font-size:12px;}
      .pmproj-notice{padding:8px 10px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d47e) 38%,transparent);border-radius:6px;color:var(--dsw-alias-state-success-primary,#34d47e);font-size:12px;line-height:1.55;}
      .pmproj-draft-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-button-primary-fill) 40%,transparent);border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-button-primary-fill) 8%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)));color:var(--dsw-alias-label-secondary);font-size:11.5px;}
      .pmproj-loading{padding:32px;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center;}
      .pmproj-readonly{padding:8px 9px;border:0.5px dashed var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;}
      @media (max-width:900px){
        .pmproj-layout{grid-template-columns:1fr;}
        .pmproj-row{grid-template-columns:minmax(0,1fr);}
        .pmproj-role-row{grid-template-columns:minmax(0,1fr);}
        .pmproj-role-editor .pmproj-role-row{grid-template-columns:minmax(130px,1.3fr) minmax(110px,1fr) 70px 170px;}
        .pmproj-facts{grid-template-columns:1fr;}
        .pmproj-form-grid{grid-template-columns:1fr;}
        .pmproj-history-detail{grid-template-columns:1fr;}
        .pmproj-output-day{grid-template-columns:1fr;}
        .pmproj-output-date{position:static;display:flex;align-items:center;gap:7px;}
        .pmproj-output-date small{display:inline;margin:0;}
      }
      @media (max-width:640px){
        .pmproj-role-editor .pmproj-role-row{grid-template-columns:minmax(0,1fr);}
      }
    `;

    const SearchIcon = () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
        },
        h("circle", { cx: 11, cy: 11, r: 7, key: "c" }),
        h("path", { d: "m20 20-3.6-3.6", key: "p" }),
      );

    const CopyIcon = () =>
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
        h("rect", { x: 8, y: 8, width: 13, height: 13, rx: 2, key: "r" }),
        h("path", {
          d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
          key: "p",
        }),
      );

    const StarIcon = ({ filled = false }) =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 14,
          height: 14,
          fill: filled ? "currentColor" : "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", {
          d: "m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17.1 6.4 20l1.2-6.2L3 9.5l6.3-.8L12 3Z",
        }),
      );

    const DownloadIcon = () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 13,
          height: 13,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M12 3v12", key: "line" }),
        h("path", { d: "m7 10 5 5 5-5", key: "arrow" }),
        h("path", { d: "M5 21h14", key: "base" }),
      );

    function Pill({ tone, children }) {
      return h(
        "span",
        { className: `pmproj-pill ${tone ?? ""}`.trim() },
        children,
      );
    }

    function Markdown({ content }) {
      return h(
        "div",
        { className: "pmproj-markdown" },
        markdownBlocks(content),
      );
    }

    /** 任务详情：复用任务模块的 pending task 深链约定。 */
    function openTask(taskId, workspaceId) {
      window.__pluginmaxPendingTask = { taskId, workspaceId };
      if (typeof window.__pluginmaxShell?.setRoute === "function") {
        window.__pluginmaxShell.setRoute("task");
        return;
      }
      window.dispatchEvent(
        new CustomEvent("pluginmax:navigate", { detail: { route: "task" } }),
      );
    }

    /** 工作流详情：复用工作流模块的 collab-navigate 约定。 */
    function openWorkflow(instanceId, workspaceId, nodeId) {
      if (typeof window.__pluginmaxShell?.setRoute === "function") {
        window.__pluginmaxShell.setRoute("workflow");
      }
      window.dispatchEvent(
        new CustomEvent("pluginmax:collab-navigate", {
          detail: { plugin: "workflow", instanceId, workspaceId, nodeId },
        }),
      );
    }

    const OUTPUT_TYPE_LABELS = {
      pdf: "PDF",
      word: "Word",
      spreadsheet: "表格",
      presentation: "演示文稿",
      markdown: "Markdown",
      text: "文本",
      image: "图片",
      archive: "压缩包",
      other: "其他",
    };

    function outputDay(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const pad = (number) => String(number).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
        date.getDate(),
      )}`;
    }

    function outputMatches(item, keyword, type, fromDate, toDate) {
      const day = outputDay(item.updatedAt);
      if (type !== "all" && item.documentType !== type) return false;
      if (fromDate !== "" && day < fromDate) return false;
      if (toDate !== "" && day > toDate) return false;
      const needle = String(keyword ?? "")
        .trim()
        .toLowerCase();
      if (needle === "") return true;
      return [
        item.name,
        item.workflowNodeName,
        item.workflowInstanceTitle,
        item.sourceName,
      ]
        .filter((value) => value !== undefined)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    }

    function groupOutputsByDay(items) {
      const groups = [];
      for (const item of [...items].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.name.localeCompare(right.name),
      )) {
        const day = outputDay(item.updatedAt) || "日期未知";
        let group = groups.at(-1);
        if (group === undefined || group.date !== day) {
          group = { date: day, items: [] };
          groups.push(group);
        }
        group.items.push(item);
      }
      return groups;
    }

    function formatFileSize(value) {
      const size = Number(value);
      if (!Number.isFinite(size) || size < 0) return "—";
      if (size < 1_024) return `${size} B`;
      if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KB`;
      return `${(size / (1_024 * 1_024)).toFixed(1)} MB`;
    }

    function outputLoadErrorMessage(cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "status" in cause &&
        cause.status === 404
      ) {
        return "产出物服务未加载，请重启当前服务后重试。";
      }
      return cause instanceof Error ? cause.message : String(cause);
    }

    function ProjectGlobalPage(props) {
      const route = props.useShellRoute?.((state) => state.route);
      if (route !== "projects") return null;
      return h(ProjectWorkspace, props);
    }

    function ProjectWorkspace() {
      const [phase, setPhase] = react.useState("loading");
      const [error, setError] = react.useState("");
      const [projects, setProjects] = react.useState([]);
      const [viewer, setViewer] = react.useState(null);
      const [selectedId, setSelectedId] = react.useState("");
      const [search, setSearch] = react.useState("");
      const [tab, setTab] = react.useState("members");
      const [view, setView] = react.useState("detail");
      const [memberManageMode, setMemberManageMode] = react.useState(false);
      const [detail, setDetail] = react.useState(null);
      const [detailLoading, setDetailLoading] = react.useState(false);
      const [followed, setFollowed] = react.useState(() => new Set());
      const [editOpen, setEditOpen] = react.useState(false);
      const [editDraft, setEditDraft] = react.useState(null);
      const [editTab, setEditTab] = react.useState("basics");
      const [leaveOpen, setLeaveOpen] = react.useState(false);
      const [memberModal, setMemberModal] = react.useState(null);
      const [roleModal, setRoleModal] = react.useState(null);
      const [roleSourcesOpen, setRoleSourcesOpen] = react.useState(false);
      const [roleSources, setRoleSources] = react.useState([]);
      const [roleSourcesLoading, setRoleSourcesLoading] = react.useState(false);
      const [roleSourceId, setRoleSourceId] = react.useState("");
      const [roleSourceRoleIds, setRoleSourceRoleIds] = react.useState([]);
      const [createOpen, setCreateOpen] = react.useState(false);
      const [createDraft, setCreateDraft] = react.useState({
        name: "",
        path: "",
        templateId: "",
      });
      /** 项目角色草稿：null 表示未进入编辑，展示当前有效集。 */
      const [roleDraft, setRoleDraft] = react.useState(null);
      const [roleDraftRevision, setRoleDraftRevision] = react.useState(null);
      const [templateLoadOpen, setTemplateLoadOpen] = react.useState(false);
      const [memberImpact, setMemberImpact] = react.useState(null);
      const [workflowBlock, setWorkflowBlock] = react.useState(null);
      const [roleNotice, setRoleNotice] = react.useState("");
      const [draftGuard, setDraftGuard] = react.useState(null);
      const [busy, setBusy] = react.useState("");
      const [templatePane, setTemplatePane] = react.useState("templates");
      const [templateTab, setTemplateTab] = react.useState("basics");
      const [templateData, setTemplateData] = react.useState(null);
      const [templateSearch, setTemplateSearch] = react.useState("");
      const [selectedTemplateId, setSelectedTemplateId] = react.useState("");
      const [selectedRoleId, setSelectedRoleId] = react.useState("");
      const [templateDraft, setTemplateDraft] = react.useState(null);
      const [catalogRoleDraft, setCatalogRoleDraft] = react.useState(null);
      const [reports, setReports] = react.useState([]);
      const [reportFrom, setReportFrom] = react.useState("");
      const [reportTo, setReportTo] = react.useState("");
      const [reportSearch, setReportSearch] = react.useState("");
      const [history, setHistory] = react.useState([]);
      const [historyLoading, setHistoryLoading] = react.useState(false);
      const [historySearch, setHistorySearch] = react.useState("");
      const [historyCategory, setHistoryCategory] = react.useState("all");
      const [outputs, setOutputs] = react.useState([]);
      const [outputsFor, setOutputsFor] = react.useState("");
      const [outputsLoading, setOutputsLoading] = react.useState(false);
      const [outputsError, setOutputsError] = react.useState("");
      const [outputSearch, setOutputSearch] = react.useState("");
      const [outputType, setOutputType] = react.useState("all");
      const [outputFrom, setOutputFrom] = react.useState("");
      const [outputTo, setOutputTo] = react.useState("");

      const fail = (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
      };

      const copyWorkspaceValue = async (value, label) => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          fail(new Error(`复制${label}失败`));
        }
      };

      react.useEffect(() => {
        if (error === "") return undefined;
        const timer = window.setTimeout(() => setError(""), 4_000);
        return () => window.clearTimeout(timer);
      }, [error]);
      react.useEffect(() => {
        if (roleNotice === "") return undefined;
        const timer = window.setTimeout(() => setRoleNotice(""), 6_000);
        return () => window.clearTimeout(timer);
      }, [roleNotice]);

      const loadProjects = react.useCallback(async () => {
        if (token() === null) {
          setError("请先在「账号与权限 → 登录账号」中登录。");
          setPhase("ready");
          return;
        }
        try {
          setPhase("loading");
          const result = await request("/api/collab/projects");
          const items = result.projects ?? [];
          setProjects(items);
          setViewer(result.viewer ?? null);
          setSelectedId((current) =>
            items.some((project) => project.workspaceId === current)
              ? current
              : (items[0]?.workspaceId ?? ""),
          );
          setPhase("ready");
        } catch (cause) {
          setPhase("ready");
          fail(cause);
        }
      }, []);

      const loadFollows = react.useCallback(async () => {
        try {
          const result = await request("/api/collab/workbench/follows");
          const ids = (result.follows ?? [])
            .filter((record) => record.type === "project")
            .map((record) => record.targetId);
          setFollowed(new Set(ids));
        } catch {
          // 关注状态不可用不影响项目管理主体功能。
        }
      }, []);

      react.useEffect(() => {
        void loadProjects();
        void loadFollows();
        const synchronize = () => {
          setPhase("loading");
          setError("");
          setProjects([]);
          setViewer(null);
          setSelectedId("");
          setSearch("");
          setTab("members");
          setView("detail");
          setMemberManageMode(false);
          setDetail(null);
          setFollowed(new Set());
          setEditOpen(false);
          setEditDraft(null);
          setLeaveOpen(false);
          setMemberModal(null);
          setRoleModal(null);
          setRoleSourcesOpen(false);
          setRoleSources([]);
          setRoleSourceRoleIds([]);
          setCreateOpen(false);
          setRoleDraft(null);
          setRoleDraftRevision(null);
          setTemplateLoadOpen(false);
          setMemberImpact(null);
          setWorkflowBlock(null);
          setRoleNotice("");
          setDraftGuard(null);
          setReports([]);
          setHistory([]);
          setOutputs([]);
          setOutputsFor("");
          setOutputsLoading(false);
          setOutputsError("");
          setOutputSearch("");
          setOutputType("all");
          setOutputFrom("");
          setOutputTo("");
          void loadProjects();
          void loadFollows();
        };
        window.addEventListener("pluginmax:collab-token", synchronize);
        return () =>
          window.removeEventListener("pluginmax:collab-token", synchronize);
      }, [loadProjects, loadFollows]);

      const loadDetail = react.useCallback(
        async (workspaceId, silent = false) => {
          if (workspaceId === "") {
            setDetail(null);
            return;
          }
          try {
            if (!silent) setDetailLoading(true);
            const result = await request(
              `/api/collab/projects/detail?workspaceId=${encodeURIComponent(
                workspaceId,
              )}`,
            );
            setDetail(result);
            setDetailLoading(false);
          } catch (cause) {
            setDetailLoading(false);
            fail(cause);
          }
        },
        [],
      );

      react.useEffect(() => {
        void loadDetail(selectedId);
      }, [selectedId, loadDetail]);

      const loadReports = react.useCallback(async (workspaceId) => {
        if (workspaceId === "") return;
        try {
          const result = await request(
            `/api/collab/projects/reports?workspaceId=${encodeURIComponent(
              workspaceId,
            )}`,
          );
          setReports(result.reports ?? []);
        } catch (cause) {
          fail(cause);
        }
      }, []);

      const loadHistory = react.useCallback(async (workspaceId) => {
        if (workspaceId === "") return;
        try {
          setHistoryLoading(true);
          const result = await request(
            `/api/collab/projects/history?workspaceId=${encodeURIComponent(
              workspaceId,
            )}&limit=500`,
          );
          setHistory(result.events ?? []);
        } catch (cause) {
          fail(cause);
        } finally {
          setHistoryLoading(false);
        }
      }, []);

      const loadOutputs = react.useCallback(async (workspaceId) => {
        if (workspaceId === "") return;
        try {
          setOutputsLoading(true);
          setOutputsError("");
          const result = await request(
            `/api/collab/projects/outputs?workspaceId=${encodeURIComponent(
              workspaceId,
            )}`,
          );
          setOutputs(result.outputs ?? []);
          setOutputsFor(workspaceId);
        } catch (cause) {
          setOutputsError(outputLoadErrorMessage(cause));
        } finally {
          setOutputsLoading(false);
        }
      }, []);

      const downloadOutput = async (item) => {
        try {
          const current = token();
          const response = await fetch(item.downloadUrl, {
            headers:
              current === null ? {} : { authorization: `Bearer ${current}` },
            cache: "no-store",
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(
              body?.error?.message ?? `下载失败（HTTP ${response.status}）`,
            );
          }
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = item.name;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(objectUrl);
        } catch (cause) {
          setOutputsError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      };

      react.useEffect(() => {
        if (tab !== "reports") return;
        void loadReports(selectedId);
      }, [tab, selectedId, loadReports]);

      react.useEffect(() => {
        if (tab !== "history") return;
        void loadHistory(selectedId);
      }, [tab, selectedId, loadHistory]);

      react.useEffect(() => {
        setTab("members");
        setMemberManageMode(false);
        setOutputs([]);
        setOutputsFor("");
        setOutputsLoading(false);
        setOutputsError("");
        setOutputSearch("");
        setOutputType("all");
        setOutputFrom("");
        setOutputTo("");
      }, [selectedId]);

      react.useEffect(() => {
        if (selectedId === "") return;
        if (outputsFor === selectedId) return;
        void loadOutputs(selectedId);
      }, [selectedId, outputsFor, loadOutputs]);

      const loadTemplates = react.useCallback(async () => {
        try {
          const result = await request("/api/collab/projects/templates");
          setTemplateData(result);
          setSelectedTemplateId((current) =>
            (result.templates ?? []).some((item) => item.id === current)
              ? current
              : ((result.templates ?? [])[0]?.id ?? ""),
          );
          setSelectedRoleId((current) =>
            (result.roles ?? []).some((item) => item.id === current)
              ? current
              : ((result.roles ?? [])[0]?.id ?? ""),
          );
        } catch (cause) {
          fail(cause);
        }
      }, []);

      react.useEffect(() => {
        if (view !== "templates" || templateData !== null) return;
        void loadTemplates();
      }, [view, templateData, loadTemplates]);

      const selectedProject =
        projects.find((project) => project.workspaceId === selectedId) ??
        projects[0] ??
        null;
      const canManage =
        detail?.viewer?.canManage === true || viewer?.role === "admin";
      const visibleProjects = projects.filter((project) =>
        projectMatches(project, search),
      );
      const effectiveRoles = (detail?.roles ?? []).filter(
        (role) => role.system !== true,
      );
      const systemRoles = (detail?.roles ?? []).filter(
        (role) => role.system === true,
      );
      const draftRoles = roleDraft ?? effectiveRoles;
      const roleDiff = computeRoleDiff(effectiveRoles, draftRoles);
      const roleDraftDirty =
        roleDiff.added.length +
          roleDiff.updated.length +
          roleDiff.removed.length >
        0;

      const refreshDetail = async () => {
        await Promise.all([loadProjects(), loadDetail(selectedId, true)]);
      };

      const toggleFollow = async () => {
        if (selectedProject === null) return;
        try {
          const sharedFollow = window.__pluginmaxFollow;
          const result =
            typeof sharedFollow?.toggle === "function"
              ? await sharedFollow.toggle(
                  "project",
                  selectedProject.workspaceId,
                )
              : await request("/api/collab/workbench/follows/toggle", {
                  method: "POST",
                  body: JSON.stringify({
                    type: "project",
                    targetId: selectedProject.workspaceId,
                  }),
                });
          const isFollowed =
            typeof result === "boolean" ? result : result.followed === true;
          const next = new Set(followed);
          if (isFollowed) next.add(selectedProject.workspaceId);
          else next.delete(selectedProject.workspaceId);
          setFollowed(next);
          window.dispatchEvent(
            new CustomEvent("pluginmax:follow-change", {
              detail: {
                type: "project",
                targetId: selectedProject.workspaceId,
                followed: isFollowed,
              },
            }),
          );
        } catch (cause) {
          fail(cause);
        }
      };

      const leaveProject = async () => {
        if (selectedProject === null) return;
        setBusy("leave");
        try {
          await request("/api/collab/projects/leave", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: selectedProject.workspaceId,
            }),
          });
          setLeaveOpen(false);
          setDetail(null);
          setTab("members");
          await loadProjects();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const openEdit = () => {
        if (selectedProject === null) return;
        setRoleNotice("");
        setEditDraft({
          name: selectedProject.name,
          ownerId: selectedProject.ownerId ?? "",
          status: selectedProject.status,
          health: selectedProject.health,
          progress: String(selectedProject.progress ?? 0),
          startDate: selectedProject.startDate ?? "",
          targetDate: selectedProject.targetDate ?? "",
          description: selectedProject.description ?? "",
        });
        setEditTab("basics");
        setEditOpen(true);
      };

      const closeEditModal = () => {
        if (roleDraftDirty) {
          setDraftGuard({ kind: "edit-close" });
          return;
        }
        setRoleDraft(null);
        setRoleDraftRevision(null);
        setEditOpen(false);
      };

      const saveEdit = async () => {
        if (selectedProject === null || editDraft === null) return;
        setBusy("edit");
        try {
          await request("/api/collab/projects/update", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: selectedProject.workspaceId,
              ...(editDraft.ownerId === ""
                ? {}
                : { ownerId: editDraft.ownerId }),
              status: editDraft.status,
              health: editDraft.health,
              progress: Number(editDraft.progress || 0),
              startDate: editDraft.startDate,
              targetDate: editDraft.targetDate,
              description: editDraft.description,
            }),
          });
          if (roleDraftDirty) {
            setRoleNotice("基础信息已保存；项目角色草稿尚未生效。");
            setEditTab("roles");
          } else {
            setRoleDraft(null);
            setRoleDraftRevision(null);
            setEditOpen(false);
          }
          await refreshDetail();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const openMemberModal = (mode, member) => {
        if (detail === null) return;
        setMemberModal({
          mode,
          memberId: member?.principalId ?? member?.id ?? "",
          memberKind: member?.kind ?? "human",
          roleIds: [...(member?.roleIds ?? [])],
          workspaceRole: member?.workspaceRole ?? "member",
          addKind: "human",
          addId: "",
        });
      };

      const memberModalMember = (() => {
        if (memberModal === null || detail === null) return null;
        if (memberModal.mode === "add") {
          if (memberModal.addKind === "human") {
            const candidate = (detail.directory?.humans ?? []).find(
              (item) =>
                item.principalId === memberModal.addId ||
                item.id === memberModal.addId,
            );
            return candidate === undefined
              ? null
              : {
                  id: candidate.id,
                  principalId: candidate.principalId,
                  name: candidate.name,
                  kind: "human",
                  kindLabel: "Human Principal",
                  platformRole: candidate.platformRole,
                  workspaceRole: "member",
                  roleIds: [],
                };
          }
          const candidate = (detail.directory?.agents ?? []).find(
            (item) =>
              item.principalId === memberModal.addId ||
              item.id === memberModal.addId,
          );
          return candidate === undefined
            ? null
            : {
                id: candidate.id,
                principalId: candidate.principalId,
                name: candidate.name,
                kind: "agent",
                kindLabel: candidate.kindLabel ?? "AI伙伴",
                platformRole: candidate.platformRole ?? "未分配",
                workspaceRole: undefined,
                roleIds: [],
              };
        }
        return (
          (detail.members ?? []).find(
            (member) =>
              member.principalId === memberModal.memberId ||
              member.id === memberModal.memberId,
          ) ?? null
        );
      })();

      const memberModalScope =
        memberModal === null || detail === null
          ? "未分配"
          : memberScopeForRoles(detail.roles ?? [], memberModal.roleIds);

      const saveMember = async () => {
        if (detail === null || memberModal === null) return;
        const memberId =
          memberModal.mode === "add" ? memberModal.addId : memberModal.memberId;
        const memberKind =
          memberModal.mode === "add"
            ? memberModal.addKind
            : memberModal.memberKind;
        if (memberId === "") {
          fail(new Error("请选择要添加的成员"));
          return;
        }
        setBusy("member");
        try {
          await request("/api/collab/projects/members/save", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: selectedProject.workspaceId,
              memberKind,
              memberId,
              roleIds: memberModal.roleIds,
              ...(memberKind === "human"
                ? { workspaceRole: memberModal.workspaceRole }
                : {}),
            }),
          });
          setMemberModal(null);
          await refreshDetail();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const removeMember = async (memberKind, memberId) => {
        if (selectedProject === null) return;
        setBusy("member");
        try {
          await request("/api/collab/projects/members/remove", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: selectedProject.workspaceId,
              memberKind,
              memberId,
            }),
          });
          setMemberModal(null);
          await refreshDetail();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      /** 打开项目角色的新增/编辑弹窗（角色定义只属于当前项目）。 */
      const openRoleModal = (mode, role) => {
        const stamp = Date.now().toString(36);
        setRoleModal(
          mode === "edit" && role !== undefined && role !== null
            ? {
                mode: "edit",
                id: role.id,
                name: role.name,
                code: role.code,
                category: role.category || "执行",
                description: role.description ?? "",
                permissions: [...(role.permissions ?? ["read", "write"])],
                prefillId: "",
                copyMode: false,
                effective: effectiveRoles.some(
                  (item) => roleCodeKey(item) === roleCodeKey(role),
                ),
                originalId: role.id,
                originalName: role.name,
                originalCode: role.code,
              }
            : {
                mode: "add",
                id: `role-${stamp}`,
                name: "",
                code: "",
                category: "执行",
                description: "",
                permissions: ["read", "write"],
                prefillId: "",
                copyMode: false,
                effective: false,
                originalId: "",
                originalName: "",
                originalCode: "",
              },
        );
      };

      /** 编辑弹窗内切换「调整原角色 / 另存为新角色」。 */
      const switchRoleCopyMode = (copyMode) => {
        if (roleModal === null) return;
        if (copyMode) {
          const base = currentRoleDraft();
          const code = nextRoleCopyCode(
            roleModal.originalCode || roleModal.code,
            base,
          );
          setRoleModal({
            ...roleModal,
            copyMode: true,
            id: `role-${Date.now().toString(36)}`,
            name:
              roleModal.originalName !== "" &&
              roleModal.name === roleModal.originalName
                ? `${roleModal.originalName}（副本）`
                : roleModal.name,
            code,
          });
          return;
        }
        setRoleModal({
          ...roleModal,
          copyMode: false,
          id: roleModal.originalId || roleModal.id,
          code: roleModal.originalCode || roleModal.code,
          name:
            roleModal.originalName !== "" &&
            roleModal.name === `${roleModal.originalName}（副本）`
              ? roleModal.originalName
              : roleModal.name,
        });
      };

      /** 从全局角色库预填表单，但保存时仍生成该项目的独立角色 id。 */
      const prefillRole = (catalogId) => {
        if (roleModal === null) return;
        const role = (detail?.roleLibrary ?? []).find(
          (item) => item.id === catalogId,
        );
        if (role === undefined) {
          setRoleModal({ ...roleModal, prefillId: catalogId });
          return;
        }
        const usedCodes = new Set(draftRoles.map((item) => roleCodeKey(item)));
        let code = role.code;
        let index = 2;
        while (usedCodes.has(roleCodeKey({ code }))) {
          code = `${role.code}_${index}`;
          index += 1;
        }
        setRoleModal({
          ...roleModal,
          prefillId: catalogId,
          name: role.name,
          code,
          category: role.category,
          description: role.description ?? "",
          permissions: [...(role.permissions ?? ["read", "write"])],
        });
      };

      const saveRoleModal = () => {
        if (roleModal === null || selectedProject === null) return;
        if (roleModal.name.trim() === "") {
          fail(new Error("请填写角色名称"));
          return;
        }
        if (roleModal.permissions.length === 0) {
          fail(new Error("请至少选择一个角色权限"));
          return;
        }
        const base = currentRoleDraft();
        const copyMode = roleModal.copyMode === true;
        const timestamp = Date.now().toString(36);
        const rawName = roleModal.name.trim();
        const name =
          copyMode && rawName === roleModal.originalName
            ? `${rawName}（副本）`
            : rawName;
        const code = copyMode
          ? nextRoleCopyCode(roleModal.originalCode, base)
          : roleModal.code.trim().toUpperCase() ||
            name
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "_")
              .replace(/^_+|_+$/g, "") ||
            `ROLE_${timestamp.toUpperCase()}`;
        const id = copyMode ? `role-${timestamp}` : roleModal.id;
        const nameKey = name.toLowerCase();
        const duplicateCode = base.some(
          (role) =>
            (copyMode || role.id !== id) &&
            roleCodeKey(role) === roleCodeKey({ code }),
        );
        const duplicateName = base.some(
          (role) =>
            (copyMode || role.id !== id) &&
            String(role.name).trim().toLowerCase() === nameKey,
        );
        if (duplicateCode) {
          fail(new Error(`角色标识已存在：${code}`));
          return;
        }
        if (duplicateName) {
          fail(new Error(`角色名称已存在：${roleModal.name.trim()}`));
          return;
        }
        const nextRole = {
          id,
          name,
          code,
          category: roleModal.category,
          description: roleModal.description,
          permissions: [...roleModal.permissions],
        };
        const index = copyMode ? -1 : base.findIndex((role) => role.id === id);
        const next =
          index < 0
            ? [...base, nextRole]
            : base.map((role, position) =>
                position === index ? nextRole : role,
              );
        setRoleDraft(next);
        if (roleDraft === null) {
          setRoleDraftRevision(detail?.project?.rolesRevision ?? 1);
        }
        setRoleModal(null);
      };

      const deleteRoleModal = () => {
        if (roleModal === null || selectedProject === null) return;
        const base = currentRoleDraft();
        const next = base.filter(
          (role) =>
            role.id !== roleModal.id &&
            roleCodeKey(role) !== roleCodeKey(roleModal),
        );
        setRoleDraft(next);
        if (roleDraft === null) {
          setRoleDraftRevision(detail?.project?.rolesRevision ?? 1);
        }
        setRoleModal(null);
      };

      const cloneRole = (role) => ({
        ...role,
        permissions: [...(role.permissions ?? [])],
      });

      /** 当前草稿；未进入草稿时从有效集复制。 */
      const currentRoleDraft = () =>
        roleDraft === null
          ? effectiveRoles.map(cloneRole)
          : roleDraft.map(cloneRole);

      const markDraft = (next) => {
        setRoleDraft(next);
        if (roleDraft === null) {
          setRoleDraftRevision(detail?.project?.rolesRevision ?? 1);
        }
      };

      const resetRoleDraft = () => {
        setRoleDraft(null);
        setRoleDraftRevision(null);
        setMemberImpact(null);
        setWorkflowBlock(null);
        setDraftGuard(null);
      };

      const removeDraftRole = (role) => {
        markDraft(
          currentRoleDraft().filter(
            (item) => roleCodeKey(item) !== roleCodeKey(role),
          ),
        );
      };

      const restoreDraftRole = (role) => {
        const base = currentRoleDraft();
        if (base.some((item) => roleCodeKey(item) === roleCodeKey(role))) {
          return;
        }
        markDraft([...base, cloneRole(role)]);
      };

      const openTemplateLoad = () => {
        setTemplateLoadOpen(true);
      };

      /** 选中模版即写入草稿；已有同 code 角色保留原 id/成员指派。 */
      const applyTemplateToDraft = (templateId) => {
        if (detail === null) return;
        const template = (detail.templates ?? []).find(
          (item) => item.id === templateId,
        );
        if (template === undefined) return;
        const stamp = Date.now().toString(36);
        let index = 0;
        const next = template.roleIds
          .map((roleId) =>
            (detail.roleLibrary ?? []).find((role) => role.id === roleId),
          )
          .filter(Boolean)
          .map((role) => {
            const existing = effectiveRoles.find(
              (item) => roleCodeKey(item) === roleCodeKey(role),
            );
            index += 1;
            return {
              id: existing?.id ?? `role-${stamp}-${index}`,
              name: role.name,
              code: roleCodeKey(role),
              category: role.category,
              description: role.description ?? "",
              permissions: [...(role.permissions ?? [])],
            };
          });
        setRoleDraft(next);
        setRoleDraftRevision(detail.project?.rolesRevision ?? 1);
        setTemplateLoadOpen(false);
        setDraftGuard(null);
        setRoleNotice(
          `已加载模版「${template.name}」的 ${next.length} 个角色，确认后生效`,
        );
      };

      /**
       * 选择模版之后才判断草稿覆盖：先让用户看到并选中模版，
       * 再由确认弹窗决定是否放弃当前草稿。
       */
      const loadTemplateToDraft = (templateId) => {
        if (roleDraftDirty) {
          const template = (detail?.templates ?? []).find(
            (item) => item.id === templateId,
          );
          setTemplateLoadOpen(false);
          setDraftGuard({
            kind: "template",
            templateId,
            templateName: template?.name ?? "",
          });
          return;
        }
        applyTemplateToDraft(templateId);
      };

      /** 打开「复用其他项目角色」弹窗并加载可访问的来源项目。 */
      const openRoleSources = async () => {
        if (selectedProject === null) return;
        setRoleSourcesOpen(true);
        setRoleSourcesLoading(true);
        try {
          const result = await request(
            `/api/collab/projects/role-sources?workspaceId=${encodeURIComponent(
              selectedProject.workspaceId,
            )}`,
          );
          const sources = result.sources ?? [];
          setRoleSources(sources);
          const first = sources[0];
          setRoleSourceId(first?.workspaceId ?? "");
          setRoleSourceRoleIds(
            first === undefined ? [] : first.roles.map((role) => role.id),
          );
        } catch (cause) {
          fail(cause);
        } finally {
          setRoleSourcesLoading(false);
        }
      };

      const selectRoleSource = (workspaceId) => {
        const source = roleSources.find(
          (item) => item.workspaceId === workspaceId,
        );
        setRoleSourceId(workspaceId);
        setRoleSourceRoleIds(
          source === undefined ? [] : source.roles.map((role) => role.id),
        );
      };

      const importSourceRoles = () => {
        if (
          selectedProject === null ||
          roleSourceId === "" ||
          roleSourceRoleIds.length === 0
        ) {
          return;
        }
        const source = roleSources.find(
          (item) => item.workspaceId === roleSourceId,
        );
        if (source === undefined) return;
        const base = currentRoleDraft();
        const existingCodes = new Set(base.map((role) => roleCodeKey(role)));
        const stamp = Date.now().toString(36);
        let added = 0;
        let skipped = 0;
        const next = [...base];
        for (const role of source.roles) {
          if (!roleSourceRoleIds.includes(role.id)) continue;
          const code = roleCodeKey(role);
          if (existingCodes.has(code)) {
            skipped += 1;
            continue;
          }
          existingCodes.add(code);
          added += 1;
          next.push({
            id: `role-${stamp}-${added}`,
            name: role.name,
            code,
            category: role.category,
            description: role.description ?? "",
            permissions: [...(role.permissions ?? [])],
          });
        }
        markDraft(next);
        setRoleSourcesOpen(false);
        setRoleNotice(
          `已加入 ${added} 个角色${skipped === 0 ? "" : `，跳过 ${skipped} 个重复角色`}，确认后生效`,
        );
      };

      const confirmRoleDraft = async (acknowledgeMemberLoss = false) => {
        if (selectedProject === null || detail === null || roleDraft === null) {
          return;
        }
        setBusy("role-confirm");
        try {
          const result = await request("/api/collab/projects/roles/confirm", {
            method: "POST",
            body: JSON.stringify({
              workspaceId: selectedProject.workspaceId,
              expectedRevision:
                roleDraftRevision ?? detail.project?.rolesRevision ?? 1,
              roles: roleDraft.map((role) => ({
                id: role.id,
                name: role.name,
                code: role.code,
                category: role.category,
                description: role.description ?? "",
                permissions: role.permissions,
              })),
              ackMemberLoss: acknowledgeMemberLoss,
            }),
          });
          const diff = result.diff ?? {};
          setRoleNotice(
            [
              `角色已生效（v${result.revision}）`,
              diff.added?.length ? `新增 ${diff.added.length}` : "",
              diff.updated?.length ? `修改 ${diff.updated.length}` : "",
              diff.removed?.length ? `移除 ${diff.removed.length}` : "",
              result.tasksNeedingReassignment
                ? `${result.tasksNeedingReassignment} 个任务需改派`
                : "",
              result.warning ?? "",
            ]
              .filter(Boolean)
              .join(" · "),
          );
          resetRoleDraft();
          await refreshDetail();
        } catch (cause) {
          if (cause.code === "member_impact") {
            setMemberImpact(cause.details ?? null);
            return;
          }
          if (cause.code === "workflow_template_blocked") {
            setWorkflowBlock(cause.details?.templates ?? []);
            return;
          }
          if (cause.code === "revision_conflict") {
            fail(new Error("项目角色已被其他人更新，请刷新后重新编辑"));
            return;
          }
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const requestSelectProject = (projectId) => {
        if (roleDraftDirty) {
          setDraftGuard({ kind: "switch", projectId });
          return;
        }
        setSelectedId(projectId);
        setMemberManageMode(false);
        setHistory([]);
        setView("detail");
      };

      const resolveDraftGuard = (discard) => {
        const guard = draftGuard;
        setDraftGuard(null);
        if (!discard || guard === null) return;
        setRoleDraft(null);
        setRoleDraftRevision(null);
        setMemberImpact(null);
        setWorkflowBlock(null);
        if (guard.kind === "switch") {
          setSelectedId(guard.projectId);
          setMemberManageMode(false);
          setHistory([]);
          setView("detail");
        } else if (guard.kind === "edit-close") {
          setEditOpen(false);
        } else if (guard.kind === "template") {
          applyTemplateToDraft(guard.templateId);
        }
      };

      const pickDirectory = async () => {
        const uiWorkspace = clientCtx?.get?.("uiWorkspace");
        if (uiWorkspace?.pickDirectory === undefined) {
          fail(new Error("当前环境不支持目录选择，请从左侧栏添加项目。"));
          return;
        }
        try {
          const path = await uiWorkspace.pickDirectory();
          if (typeof path === "string" && path !== "") {
            setCreateDraft((current) => ({
              ...current,
              path,
              name:
                current.name === ""
                  ? (path.split(/[\\/]/).filter(Boolean).pop() ?? "")
                  : current.name,
            }));
          }
        } catch (cause) {
          fail(cause);
        }
      };

      const submitCreate = async () => {
        if (createDraft.name.trim() === "") {
          fail(new Error("请填写项目名称"));
          return;
        }
        if (createDraft.path === "") {
          fail(new Error("请选择项目目录"));
          return;
        }
        setBusy("create");
        try {
          const result = await request("/api/collab/projects/create", {
            method: "POST",
            body: JSON.stringify({
              path: createDraft.path,
              name: createDraft.name.trim(),
              ...(createDraft.templateId === ""
                ? {}
                : { templateId: createDraft.templateId }),
            }),
          });
          setCreateOpen(false);
          setCreateDraft({ name: "", path: "", templateId: "" });
          await loadProjects();
          if (typeof result.workspaceId === "string") {
            setSelectedId(result.workspaceId);
          }
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const generateReport = async () => {
        if (selectedProject === null) return;
        setBusy("report");
        try {
          await request("/api/collab/projects/reports/generate", {
            method: "POST",
            body: JSON.stringify({ workspaceId: selectedProject.workspaceId }),
          });
          await loadReports(selectedProject.workspaceId);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const templateDraftFrom = (template) => ({
        id: template?.id ?? "",
        name: template?.name ?? "",
        code: template?.code ?? "",
        type: template?.type ?? "",
        status: template?.status ?? "启用",
        description: template?.description ?? "",
        roleIds: [...(template?.roleIds ?? [])],
        workflowTemplateIds: [...(template?.workflowTemplateIds ?? [])],
      });

      const catalogRoleDraftFrom = (role) => ({
        id: role?.id ?? "",
        name: role?.name ?? "",
        code: role?.code ?? "",
        category: role?.category ?? "执行",
        description: role?.description ?? "",
        permissions: [...(role?.permissions ?? ["read", "write"])],
      });

      /** 模版数据首次到达（或选中项被删除）时，补齐编辑草稿。 */
      react.useEffect(() => {
        if (templateData === null) return;
        if (templateDraft === null) {
          const first = (templateData.templates ?? [])[0];
          if (first !== undefined) setTemplateDraft(templateDraftFrom(first));
        }
        if (catalogRoleDraft === null) {
          const role = (templateData.roles ?? [])[0];
          if (role !== undefined) {
            setCatalogRoleDraft(catalogRoleDraftFrom(role));
          }
        }
      }, [templateData, templateDraft, catalogRoleDraft]);

      const openTemplateView = () => {
        setView(view === "templates" ? "detail" : "templates");
        if (view !== "templates" && templateData !== null) {
          const template = (templateData.templates ?? []).find(
            (item) => item.id === selectedTemplateId,
          );
          setTemplateDraft(templateDraftFrom(template));
          const role = (templateData.roles ?? []).find(
            (item) => item.id === selectedRoleId,
          );
          setCatalogRoleDraft(catalogRoleDraftFrom(role));
        }
      };

      const selectTemplate = (templateId) => {
        setSelectedTemplateId(templateId);
        const template = (templateData?.templates ?? []).find(
          (item) => item.id === templateId,
        );
        setTemplateDraft(templateDraftFrom(template));
        setTemplateTab("basics");
      };

      const selectRole = (roleId) => {
        setSelectedRoleId(roleId);
        const role = (templateData?.roles ?? []).find(
          (item) => item.id === roleId,
        );
        setCatalogRoleDraft(catalogRoleDraftFrom(role));
      };

      const saveTemplate = async (override) => {
        const draft = override ?? templateDraft;
        if (draft === null) return;
        setBusy("template");
        try {
          await request("/api/collab/projects/templates/save", {
            method: "POST",
            body: JSON.stringify({
              id: draft.id,
              name: draft.name,
              code: draft.code,
              type: draft.type,
              status: draft.status,
              description: draft.description,
              roleIds: draft.roleIds,
              workflowTemplateIds: draft.workflowTemplateIds,
            }),
          });
          await loadTemplates();
          setTemplateDraft(draft);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const saveRole = async () => {
        if (catalogRoleDraft === null) return;
        setBusy("role");
        try {
          await request("/api/collab/projects/roles/save", {
            method: "POST",
            body: JSON.stringify(catalogRoleDraft),
          });
          await loadTemplates();
          await loadDetail(selectedId, true);
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const removeRole = async () => {
        if (catalogRoleDraft === null) return;
        setBusy("role");
        try {
          await request("/api/collab/projects/roles/remove", {
            method: "POST",
            body: JSON.stringify({ id: catalogRoleDraft.id }),
          });
          setSelectedRoleId("");
          setCatalogRoleDraft(null);
          await loadTemplates();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const removeTemplate = async () => {
        if (templateDraft === null) return;
        setBusy("template");
        try {
          await request("/api/collab/projects/templates/remove", {
            method: "POST",
            body: JSON.stringify({ id: templateDraft.id }),
          });
          setSelectedTemplateId("");
          setTemplateDraft(null);
          await loadTemplates();
        } catch (cause) {
          fail(cause);
        } finally {
          setBusy("");
        }
      };

      const duplicateTemplate = () => {
        if (templateDraft === null) return;
        const copy = {
          ...templateDraft,
          id: `${templateDraft.id}-copy-${Date.now().toString(36)}`,
          name: `${templateDraft.name}（副本）`,
          code: `${templateDraft.code}-COPY`,
        };
        setTemplateDraft(copy);
        void saveTemplate(copy);
      };

      const createTemplate = () => {
        const stamp = Date.now().toString(36);
        const draft = {
          id: `tpl-${stamp}`,
          name: "新建项目模版",
          code: `TPL-${stamp.toUpperCase()}`,
          type: "研发类",
          status: "启用",
          description: "",
          roleIds: [],
          workflowTemplateIds: [],
        };
        setTemplateDraft(draft);
        setSelectedTemplateId(draft.id);
        setTemplateTab("basics");
        void saveTemplate(draft);
      };

      const createRole = () => {
        const stamp = Date.now().toString(36);
        const draft = {
          id: `role-${stamp}`,
          name: "新建项目角色",
          code: `ROLE_${stamp.toUpperCase()}`,
          category: "执行",
          description: "",
          permissions: ["read", "write"],
        };
        setCatalogRoleDraft(draft);
        setSelectedRoleId(draft.id);
        void (async () => {
          setBusy("role");
          try {
            await request("/api/collab/projects/roles/save", {
              method: "POST",
              body: JSON.stringify(draft),
            });
            await loadTemplates();
          } catch (cause) {
            fail(cause);
          } finally {
            setBusy("");
          }
        })();
      };

      // ------------------------------------------------------------ rendering

      const renderError = () =>
        error === ""
          ? null
          : h(
              "div",
              { className: "pmproj-error" },
              h("span", null, error),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setError(""),
                },
                "关闭",
              ),
            );

      const renderProjectList = () =>
        h(
          "aside",
          { className: "pmproj-directory", "aria-label": "项目清单" },
          h(
            "label",
            { className: "pmproj-search" },
            SearchIcon(),
            h("input", {
              value: search,
              placeholder: "搜索项目",
              "aria-label": "搜索项目",
              onChange: (event) => setSearch(event.target.value),
            }),
          ),
          h(
            "div",
            { className: "pmproj-directory-title" },
            h("span", null, "项目列表"),
            h("span", null, `${visibleProjects.length}个`),
          ),
          h(
            "div",
            { className: "pmproj-list" },
            visibleProjects.length === 0
              ? h("div", { className: "pmproj-empty" }, "没有匹配的项目。")
              : visibleProjects.map((project) =>
                  h(
                    "button",
                    {
                      key: project.workspaceId,
                      type: "button",
                      className: `pmproj-list-item ${
                        project.workspaceId === selectedProject?.workspaceId
                          ? "active"
                          : ""
                      }`.trim(),
                      onClick: () => requestSelectProject(project.workspaceId),
                    },
                    h(
                      "span",
                      { className: "pmproj-list-copy" },
                      h("strong", null, project.name),
                      h(
                        "small",
                        null,
                        `${project.code || "未编号"} · Owner ${
                          project.ownerName || "未指定"
                        }`,
                      ),
                    ),
                    h(
                      Pill,
                      { tone: statusTone(project.status) },
                      project.status,
                    ),
                  ),
                ),
          ),
        );

      const renderFacts = () => {
        if (selectedProject === null) return null;
        const counts = selectedProject.counts ?? {};
        const notes = selectedProject.notes ?? {};
        return h(
          "div",
          { className: "pmproj-facts" },
          h(
            "div",
            { className: "pmproj-fact" },
            h("span", null, "项目成员"),
            h(
              "strong",
              null,
              `${counts.humans ?? 0} 人 · ${counts.aiPartners ?? 0} AI伙伴`,
            ),
            h("small", null, notes.members || "平台与项目角色分离"),
          ),
          h(
            "div",
            { className: "pmproj-fact" },
            h("span", null, "活跃任务"),
            h("strong", null, `${counts.tasks ?? 0} 项`),
            h("small", null, notes.tasks || ""),
          ),
          h(
            "div",
            { className: "pmproj-fact" },
            h("span", null, "关联工作流"),
            h("strong", null, `${counts.workflows ?? 0} 个`),
            h("small", null, notes.workflows || ""),
          ),
        );
      };

      const renderWorkspaceInfo = () => {
        if (selectedProject === null) return null;
        return h(
          "div",
          { className: "pmproj-meta pmproj-workspace-meta" },
          h("span", null, "工作区："),
          h(
            "span",
            { className: "pmproj-workspace-value" },
            h(
              "code",
              { title: selectedProject.path || "未知" },
              compactWorkspacePath(selectedProject.path),
            ),
            h(
              "button",
              {
                className: "pmproj-copy-icon",
                type: "button",
                disabled: !selectedProject.path,
                title: "复制工作区路径",
                "aria-label": "复制工作区路径",
                onClick: () =>
                  void copyWorkspaceValue(selectedProject.path, "工作区路径"),
              },
              CopyIcon(),
            ),
          ),
          h(
            "span",
            { className: "pmproj-workspace-value" },
            h(
              "code",
              { title: selectedProject.workspaceId },
              selectedProject.workspaceId,
            ),
            h(
              "button",
              {
                className: "pmproj-copy-icon",
                type: "button",
                title: "复制工作区 ID",
                "aria-label": "复制工作区 ID",
                onClick: () =>
                  void copyWorkspaceValue(
                    selectedProject.workspaceId,
                    "工作区 ID",
                  ),
              },
              CopyIcon(),
            ),
          ),
        );
      };

      const renderMembersTab = () => {
        if (detail === null) return null;
        const members = detail.members ?? [];
        return h(
          "div",
          { className: "pmproj-panel" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h(
              "div",
              { className: "pmproj-panel-title" },
              h("h3", null, "成员权限"),
              h(
                "span",
                { className: "pmproj-count" },
                `${members.length} 个成员`,
              ),
            ),
            h(
              "div",
              { className: "pmproj-head-actions" },
              canManage
                ? h(
                    "button",
                    {
                      className: "pmproj-btn secondary small",
                      type: "button",
                      onClick: () => setMemberManageMode((current) => !current),
                    },
                    memberManageMode ? "完成" : "管理成员",
                  )
                : null,
              memberManageMode && canManage
                ? h(
                    "button",
                    {
                      className: "pmproj-btn small",
                      type: "button",
                      onClick: () => openMemberModal("add", null),
                    },
                    "添加成员",
                  )
                : null,
            ),
          ),
          h(
            "p",
            { className: "pmproj-hint" },
            memberManageMode
              ? "正在管理项目成员。工作区角色属于项目成员关系；平台角色只读；项目角色只能从当前已生效的项目角色中选择。"
              : "工作区角色属于项目成员关系，平台角色由平台账号体系统一维护；项目角色决定任务指派与工作流流转。",
          ),
          members.length === 0
            ? h("div", { className: "pmproj-empty" }, "当前项目还没有成员。")
            : h(
                "div",
                { className: "pmproj-table" },
                members.map((member) =>
                  h(
                    "div",
                    {
                      className: "pmproj-row",
                      key: `${member.kind}:${member.id}`,
                    },
                    h(
                      "div",
                      { className: "pmproj-member" },
                      h(MemberAvatar, { member }),
                      h(
                        "div",
                        { className: "pmproj-member-copy" },
                        h("strong", null, member.name),
                        h(
                          "small",
                          null,
                          member.kind === "agent" && member.ownerName
                            ? `${member.kindLabel} · Owner ${member.ownerName}`
                            : member.kind === "human" && member.joinedAt
                              ? `${member.kindLabel} · 加入 ${new Date(
                                  member.joinedAt,
                                ).toLocaleDateString("zh-CN")}`
                              : member.kindLabel,
                        ),
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "项目角色"),
                      h(
                        "div",
                        { className: "pmproj-chips" },
                        (member.roleNames ?? []).length === 0
                          ? h(
                              "span",
                              { className: "pmproj-chip empty" },
                              "未分配",
                            )
                          : member.roleNames.map((roleName) =>
                              h(
                                "span",
                                {
                                  key: roleName,
                                  className: `pmproj-chip ${
                                    member.kind === "agent" ? "agent" : ""
                                  }`.trim(),
                                },
                                roleName,
                              ),
                            ),
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "平台角色"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        member.platformRole,
                      ),
                      h(
                        "span",
                        { className: "pmproj-subvalue" },
                        `工作区角色：${workspaceRoleLabel(
                          member.workspaceRole,
                        )}`,
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "授权范围"),
                      h("span", { className: "pmproj-value" }, member.scope),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      canManage && memberManageMode
                        ? h(
                            Fragment,
                            null,
                            h(
                              "button",
                              {
                                className: "pmproj-btn secondary small",
                                type: "button",
                                onClick: () => openMemberModal("edit", member),
                              },
                              "变更",
                            ),
                            h(
                              "button",
                              {
                                className: "pmproj-btn danger small",
                                type: "button",
                                disabled: busy === "member",
                                onClick: () =>
                                  void removeMember(
                                    member.kind,
                                    member.principalId ?? member.id,
                                  ),
                              },
                              "移除",
                            ),
                          )
                        : canManage
                          ? h(
                              "button",
                              {
                                className: "pmproj-btn secondary small",
                                type: "button",
                                onClick: () => openMemberModal("edit", member),
                              },
                              "管理",
                            )
                          : null,
                    ),
                  ),
                ),
              ),
        );
      };

      const renderProjectRoleEditor = () =>
        h(
          "div",
          { className: "pmproj-section pmproj-role-editor" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h(
              "div",
              { className: "pmproj-panel-title" },
              h("h3", null, "项目角色清单"),
              h(
                "span",
                { className: "pmproj-count" },
                `${draftRoles.length} 个角色${roleDraftDirty ? "（草稿）" : ""}`,
              ),
            ),
            h(
              "div",
              { className: "pmproj-head-actions" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: openTemplateLoad,
                },
                "从模版加载",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => void openRoleSources(),
                },
                "复用其他项目",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn small",
                  type: "button",
                  onClick: () => openRoleModal("add"),
                },
                "添加角色",
              ),
            ),
          ),
          h(
            "p",
            { className: "pmproj-hint" },
            "每个项目持有自己的一份项目角色定义。从模版加载或复用其他项目只写入草稿，确认后整组覆盖生效；已启动的工作流实例按启动时快照继续运行。",
          ),
          roleNotice !== ""
            ? h("div", { className: "pmproj-notice" }, roleNotice)
            : null,
          draftRoles.length === 0 &&
            roleDiff.removed.length === 0 &&
            systemRoles.length === 0
            ? h(
                "div",
                { className: "pmproj-empty" },
                "当前项目还没有项目角色。可以从模版加载、复用其他项目，或手动添加角色。",
              )
            : h(
                "div",
                { className: "pmproj-table" },
                draftRoles.map((role) => {
                  const added = roleDiff.added.some(
                    (item) => roleCodeKey(item) === roleCodeKey(role),
                  );
                  const updated = roleDiff.updated.some(
                    (item) => roleCodeKey(item) === roleCodeKey(role),
                  );
                  const effective = effectiveRoles.find(
                    (item) => roleCodeKey(item) === roleCodeKey(role),
                  );
                  return h(
                    "div",
                    {
                      className: `pmproj-role-row ${
                        added || updated ? "draft" : ""
                      }`.trim(),
                      key: `${role.id}:${role.code}`,
                    },
                    h(
                      "div",
                      { className: "pmproj-member-copy" },
                      h("strong", null, role.name),
                      h(
                        "small",
                        null,
                        `${role.code} · ${role.category || "未分类"}`,
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "授权范围"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        permissionLabels(role.permissions),
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "成员"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        added
                          ? "新增角色"
                          : `${effective?.memberCount ?? 0} 人`,
                      ),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      added
                        ? h(Pill, { tone: "notice" }, "新增")
                        : updated
                          ? h(Pill, { tone: "notice" }, "已修改")
                          : null,
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary small",
                          type: "button",
                          onClick: () => openRoleModal("edit", role),
                        },
                        "编辑",
                      ),
                      h(
                        "button",
                        {
                          className: "pmproj-btn danger small",
                          type: "button",
                          onClick: () => removeDraftRole(role),
                        },
                        "移除",
                      ),
                    ),
                  );
                }),
                roleDiff.removed.map((role) =>
                  h(
                    "div",
                    {
                      className: "pmproj-role-row removed",
                      key: `removed:${role.id}`,
                    },
                    h(
                      "div",
                      { className: "pmproj-member-copy" },
                      h("strong", null, role.name),
                      h(
                        "small",
                        null,
                        `${role.code} · ${role.category || "未分类"}`,
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "授权范围"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        permissionLabels(role.permissions),
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "成员"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        `${role.memberCount ?? 0} 人`,
                      ),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      h(Pill, { tone: "warn" }, "待移除"),
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary small",
                          type: "button",
                          onClick: () => restoreDraftRole(role),
                        },
                        "撤销移除",
                      ),
                    ),
                  ),
                ),
                systemRoles.map((role) =>
                  h(
                    "div",
                    { className: "pmproj-role-row", key: role.id },
                    h(
                      "div",
                      { className: "pmproj-member-copy" },
                      h("strong", null, role.name),
                      h("small", null, `${role.code} · 平台系统席位`),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "授权范围"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        permissionLabels(role.permissions),
                      ),
                    ),
                    h(
                      "div",
                      null,
                      h("span", { className: "pmproj-label" }, "成员"),
                      h(
                        "span",
                        { className: "pmproj-value" },
                        `${role.memberCount ?? 0} 人`,
                      ),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      h(Pill, null, "系统"),
                    ),
                  ),
                ),
              ),
          roleDraftDirty
            ? h(
                "div",
                { className: "pmproj-draft-bar" },
                h(
                  "span",
                  null,
                  `新增 ${roleDiff.added.length} · 修改 ${roleDiff.updated.length} · 移除 ${roleDiff.removed.length}（确认后整组覆盖）`,
                ),
                h(
                  "div",
                  { className: "pmproj-head-actions" },
                  h(
                    "button",
                    {
                      className: "pmproj-btn secondary small",
                      type: "button",
                      disabled: busy === "role-confirm",
                      onClick: resetRoleDraft,
                    },
                    "取消编辑",
                  ),
                  h(
                    "button",
                    {
                      className: "pmproj-btn small",
                      type: "button",
                      disabled: busy === "role-confirm",
                      onClick: () => void confirmRoleDraft(false),
                    },
                    "确认生效",
                  ),
                ),
              )
            : null,
        );

      const renderTasksTab = () => {
        if (detail === null || selectedProject === null) return null;
        const tasks = sortProjectTasks(detail.tasks ?? []);
        return h(
          "div",
          { className: "pmproj-panel" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h("h3", null, "任务清单"),
            h("span", { className: "pmproj-count" }, `${tasks.length} 项`),
          ),
          tasks.length === 0
            ? h("div", { className: "pmproj-empty" }, "当前项目没有活跃任务。")
            : h(
                "div",
                { className: "pmproj-items" },
                tasks.map((task) =>
                  h(
                    "article",
                    { className: "pmproj-item", key: task.id },
                    h(
                      "div",
                      { className: "pmproj-item-main" },
                      h(
                        "div",
                        { className: "pmproj-item-title" },
                        h("span", { className: "id" }, task.id),
                        h("strong", null, task.title),
                      ),
                      h(
                        "div",
                        { className: "pmproj-item-meta" },
                        h(
                          Pill,
                          { tone: task.priority === "P1" ? "warn" : undefined },
                          priorityLabel(task.priority),
                        ),
                        h(
                          Pill,
                          { tone: statusTone(TASK_STATUS_LABEL[task.status]) },
                          TASK_STATUS_LABEL[task.status] ?? task.status,
                        ),
                        task.receiverState === "needs_reassignment"
                          ? h(Pill, { tone: "warn" }, "需改派")
                          : null,
                        h("span", null, selectedProject.name),
                        h(
                          "span",
                          null,
                          task.receiverName ||
                            (task.receiverType === "role"
                              ? "待认领（项目角色）"
                              : "待指派"),
                        ),
                        task.receiverState === "needs_reassignment"
                          ? h(
                              "span",
                              { title: task.reassignmentReason ?? "" },
                              task.reassignmentReason ??
                                `原角色：${task.previousReceiver?.name ?? "未知"}`,
                            )
                          : null,
                        h(
                          "span",
                          null,
                          `截止 ${task.due ? task.due.slice(5, 10) : "不限"}`,
                        ),
                      ),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary small",
                          type: "button",
                          onClick: () =>
                            openTask(task.id, selectedProject.workspaceId),
                        },
                        "详情",
                      ),
                    ),
                  ),
                ),
              ),
        );
      };

      const renderWorkflowsTab = () => {
        if (detail === null || selectedProject === null) return null;
        const workflows = detail.workflows ?? [];
        return h(
          "div",
          { className: "pmproj-panel" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h("h3", null, "工作流"),
            h(
              "span",
              { className: "pmproj-count" },
              `${workflows.length} 个流程`,
            ),
          ),
          workflows.length === 0
            ? h(
                "div",
                { className: "pmproj-empty" },
                "当前项目没有关联工作流。",
              )
            : h(
                "div",
                { className: "pmproj-items" },
                workflows.map((workflow) =>
                  h(
                    "article",
                    { className: "pmproj-item", key: workflow.id },
                    h(
                      "div",
                      { className: "pmproj-item-main" },
                      h(
                        "div",
                        { className: "pmproj-item-title" },
                        h("span", { className: "id" }, workflow.definitionKey),
                        h("strong", null, workflow.title),
                      ),
                      h(
                        "div",
                        { className: "pmproj-item-meta" },
                        h(
                          Pill,
                          { tone: WORKFLOW_STATUS_TONE[workflow.status] },
                          WORKFLOW_STATUS_LABEL[workflow.status] ??
                            workflow.status,
                        ),
                        h("span", null, selectedProject.name),
                        h(
                          "span",
                          null,
                          `更新于 ${workflow.updatedAt.slice(0, 16).replace("T", " ")}`,
                        ),
                      ),
                    ),
                    h(
                      "div",
                      { className: "pmproj-actions" },
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary small",
                          type: "button",
                          onClick: () =>
                            openWorkflow(
                              workflow.id,
                              selectedProject.workspaceId,
                            ),
                        },
                        "查看流程",
                      ),
                    ),
                  ),
                ),
              ),
        );
      };

      const renderOutputsTab = () => {
        if (detail === null || selectedProject === null) return null;
        const visible = outputs.filter((item) =>
          outputMatches(item, outputSearch, outputType, outputFrom, outputTo),
        );
        const groups = groupOutputsByDay(visible);
        const loading =
          outputsLoading ||
          (outputsFor !== selectedProject.workspaceId && outputsError === "");
        return h(
          "div",
          { className: "pmproj-panel pmproj-outputs" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h(
              "div",
              { className: "pmproj-panel-title" },
              h("h3", null, "产出物"),
              h(
                "span",
                { className: "pmproj-count" },
                outputsFor === selectedProject.workspaceId
                  ? `${visible.length} / ${outputs.length} 项`
                  : "加载中",
              ),
            ),
            h(
              "button",
              {
                className: "pmproj-btn secondary small",
                type: "button",
                disabled: loading,
                onClick: () => void loadOutputs(selectedProject.workspaceId),
              },
              "刷新",
            ),
          ),
          h(
            "div",
            { className: "pmproj-output-toolbar" },
            h(
              "label",
              { className: "pmproj-output-search" },
              SearchIcon(),
              h("input", {
                value: outputSearch,
                placeholder: "搜索文档名称、工作流、节点或任务名称",
                "aria-label": "搜索产出物",
                onChange: (event) => setOutputSearch(event.target.value),
              }),
            ),
            h(
              "div",
              { className: "pmproj-output-range" },
              h("span", null, "时间"),
              h("input", {
                type: "date",
                value: outputFrom,
                "aria-label": "产出物开始日期",
                onChange: (event) => setOutputFrom(event.target.value),
              }),
              h("span", null, "至"),
              h("input", {
                type: "date",
                value: outputTo,
                "aria-label": "产出物结束日期",
                onChange: (event) => setOutputTo(event.target.value),
              }),
            ),
            h(
              "select",
              {
                value: outputType,
                "aria-label": "按文档类型筛选产出物",
                onChange: (event) => setOutputType(event.target.value),
              },
              h("option", { value: "all" }, "全部文档类型"),
              Object.entries(OUTPUT_TYPE_LABELS).map(([value, label]) =>
                h("option", { key: value, value }, label),
              ),
            ),
            outputSearch !== "" ||
              outputType !== "all" ||
              outputFrom !== "" ||
              outputTo !== ""
              ? h(
                  "button",
                  {
                    className: "pmproj-btn subtle",
                    type: "button",
                    onClick: () => {
                      setOutputSearch("");
                      setOutputType("all");
                      setOutputFrom("");
                      setOutputTo("");
                    },
                  },
                  "清除筛选",
                )
              : null,
          ),
          outputsError !== ""
            ? h(
                "div",
                { className: "pmproj-output-empty", role: "alert" },
                outputsError,
              )
            : loading
              ? h("div", { className: "pmproj-loading" }, "正在加载产出物…")
              : groups.length === 0
                ? h(
                    "div",
                    { className: "pmproj-output-empty" },
                    outputs.length === 0
                      ? "当前项目还没有产出物。"
                      : "没有匹配的产出物。",
                  )
                : h(
                    "div",
                    { className: "pmproj-output-timeline" },
                    groups.map((group) =>
                      h(
                        "section",
                        {
                          className: "pmproj-output-day",
                          key: group.date,
                        },
                        h(
                          "div",
                          { className: "pmproj-output-date" },
                          group.date,
                          h("small", null, `${group.items.length} 项`),
                        ),
                        h(
                          "div",
                          { className: "pmproj-output-list" },
                          group.items.map((item) =>
                            h(
                              "article",
                              {
                                className: "pmproj-output-item",
                                key: item.id,
                              },
                              h(
                                "div",
                                { className: "pmproj-output-main" },
                                h(
                                  "div",
                                  { className: "pmproj-output-title" },
                                  h("strong", { title: item.name }, item.name),
                                  h(
                                    Pill,
                                    null,
                                    OUTPUT_TYPE_LABELS[item.documentType] ??
                                      "其他",
                                  ),
                                ),
                                h(
                                  "div",
                                  { className: "pmproj-output-meta" },
                                  h("span", null, item.authorName || "未知"),
                                  h("span", null, "·"),
                                  h("span", null, formatFileSize(item.size)),
                                  h("span", null, "·"),
                                  h(
                                    "span",
                                    null,
                                    item.updatedAt
                                      .slice(0, 16)
                                      .replace("T", " "),
                                  ),
                                ),
                                h(
                                  "div",
                                  { className: "pmproj-output-links" },
                                  h(
                                    "button",
                                    {
                                      className: "pmproj-output-source",
                                      type: "button",
                                      title:
                                        item.sourceKind === "task"
                                          ? "打开任务"
                                          : "打开工作流",
                                      onClick: () => {
                                        if (
                                          item.sourceKind === "task" &&
                                          item.taskId !== undefined
                                        ) {
                                          openTask(
                                            item.taskId,
                                            selectedProject.workspaceId,
                                          );
                                          return;
                                        }
                                        if (
                                          item.workflowInstanceId !== undefined
                                        ) {
                                          openWorkflow(
                                            item.workflowInstanceId,
                                            selectedProject.workspaceId,
                                          );
                                        }
                                      },
                                    },
                                    `${item.sourceKind === "task" ? "任务" : "工作流"} · ${item.sourceName}`,
                                  ),
                                  item.workflowNodeName === undefined ||
                                    item.workflowInstanceId === undefined
                                    ? null
                                    : h(
                                        "button",
                                        {
                                          className: "pmproj-output-node",
                                          type: "button",
                                          title: "打开对应工作流节点",
                                          onClick: () =>
                                            openWorkflow(
                                              item.workflowInstanceId,
                                              selectedProject.workspaceId,
                                              item.workflowNodeId,
                                            ),
                                        },
                                        `节点 · ${item.workflowNodeName}`,
                                      ),
                                ),
                              ),
                              h(
                                "div",
                                { className: "pmproj-output-actions" },
                                h(
                                  "button",
                                  {
                                    className:
                                      "pmproj-btn secondary small pmproj-output-download",
                                    type: "button",
                                    onClick: () => void downloadOutput(item),
                                  },
                                  DownloadIcon(),
                                  "下载",
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
        );
      };

      const renderReportsTab = () => {
        const keywords = reportSearch
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const visible = reports
          .filter((report) => {
            if (reportFrom !== "" && report.date < reportFrom) return false;
            if (reportTo !== "" && report.date > reportTo) return false;
            if (keywords.length === 0) return true;
            return keywords.every((keyword) =>
              `${report.date} ${report.content}`
                .toLowerCase()
                .includes(keyword),
            );
          })
          .sort((left, right) => right.date.localeCompare(left.date));
        const latest = visible[0] ?? null;
        const history = visible.slice(1);
        return h(
          "div",
          { className: "pmproj-panel" },
          h(
            "div",
            { className: "pmproj-toolbar" },
            h("input", {
              type: "date",
              value: reportFrom,
              "aria-label": "项目日报开始日期",
              onChange: (event) => setReportFrom(event.target.value),
            }),
            h("span", { className: "pmproj-hint" }, "至"),
            h("input", {
              type: "date",
              value: reportTo,
              "aria-label": "项目日报结束日期",
              onChange: (event) => setReportTo(event.target.value),
            }),
            h("input", {
              type: "search",
              value: reportSearch,
              placeholder: "关键词",
              "aria-label": "搜索项目日报",
              onChange: (event) => setReportSearch(event.target.value),
            }),
            canManage
              ? h(
                  "button",
                  {
                    className: "pmproj-btn small",
                    type: "button",
                    disabled: busy === "report",
                    onClick: () => void generateReport(),
                  },
                  "更新日报",
                )
              : null,
          ),
          latest === null
            ? h("div", { className: "pmproj-empty" }, "没有匹配的项目日报。")
            : h(
                "div",
                { className: "pmproj-report" },
                h(
                  "div",
                  { className: "pmproj-report-head" },
                  h("h3", null, `${latest.date} 项目日报`),
                  h(
                    "small",
                    null,
                    `撰写人：${latest.generatedBy} · 撰写时间：${latest.generatedAt}`,
                  ),
                ),
                h(Markdown, { content: latest.content }),
              ),
          h(
            "div",
            { className: "pmproj-section" },
            h(
              "div",
              { className: "pmproj-section-title" },
              h("span", null, "历史记录"),
              h("span", null, String(history.length)),
            ),
            history.length === 0
              ? h(
                  "div",
                  { className: "pmproj-empty" },
                  "没有更早的项目日报快照。",
                )
              : history.map((report) =>
                  h(
                    "div",
                    { className: "pmproj-report", key: report.date },
                    h(
                      "div",
                      { className: "pmproj-report-head" },
                      h("h3", null, `${report.date} 项目日报`),
                      h(
                        "small",
                        null,
                        `撰写人：${report.generatedBy} · 撰写时间：${report.generatedAt}`,
                      ),
                    ),
                    h(Markdown, { content: report.content }),
                  ),
                ),
          ),
        );
      };

      const renderHistoryTab = () => {
        if (detail === null || selectedProject === null) return null;
        const events = history.filter((event) =>
          auditMatches(event, historySearch, historyCategory),
        );
        return h(
          "div",
          { className: "pmproj-panel" },
          h(
            "div",
            { className: "pmproj-panel-head" },
            h(
              "div",
              { className: "pmproj-panel-title" },
              h("h3", null, "历史记录"),
              h("span", { className: "pmproj-count" }, `${events.length} 条`),
            ),
            h(
              "button",
              {
                className: "pmproj-btn secondary small",
                type: "button",
                disabled: historyLoading,
                onClick: () => void loadHistory(selectedProject.workspaceId),
              },
              historyLoading ? "刷新中…" : "刷新",
            ),
          ),
          h(
            "p",
            { className: "pmproj-hint" },
            "记录项目设置、成员权限、项目角色、关联模版和项目日报的变更；账号与权限中的项目成员操作也会合并展示。历史记录仅追加，不随当前配置覆盖。",
          ),
          h(
            "div",
            { className: "pmproj-toolbar" },
            h(
              "div",
              { className: "pmproj-search pmproj-history-search" },
              SearchIcon(),
              h("input", {
                value: historySearch,
                placeholder: "搜索操作人、对象或变更内容",
                "aria-label": "搜索历史记录",
                onChange: (event) => setHistorySearch(event.target.value),
              }),
            ),
          ),
          h(
            "div",
            {
              className: "pmproj-tabs",
              role: "tablist",
              "aria-label": "历史记录分类",
            },
            Object.entries(AUDIT_CATEGORY_LABELS).map(([key, label]) =>
              h(
                "button",
                {
                  key,
                  type: "button",
                  role: "tab",
                  "aria-selected": historyCategory === key ? "true" : "false",
                  className: `pmproj-tab ${
                    historyCategory === key ? "active" : ""
                  }`.trim(),
                  onClick: () => setHistoryCategory(key),
                },
                label,
              ),
            ),
          ),
          historyLoading && history.length === 0
            ? h("div", { className: "pmproj-loading" }, "正在加载历史记录…")
            : events.length === 0
              ? h(
                  "div",
                  { className: "pmproj-empty" },
                  history.length === 0
                    ? "当前项目还没有历史记录。"
                    : "没有匹配的历史记录。",
                )
              : h(
                  "div",
                  { className: "pmproj-history" },
                  events.map((event) =>
                    h(
                      "article",
                      {
                        className: `pmproj-history-event ${event.category}`,
                        key: event.id,
                      },
                      h("span", { className: "pmproj-history-dot" }),
                      h(
                        "div",
                        { className: "pmproj-history-body" },
                        h(
                          "div",
                          { className: "pmproj-history-head" },
                          h(
                            "div",
                            null,
                            h(
                              "div",
                              { className: "pmproj-history-title" },
                              h("strong", null, event.summary),
                              h(
                                Pill,
                                {
                                  tone:
                                    event.category === "member"
                                      ? "done"
                                      : undefined,
                                },
                                auditCategoryLabel(event.category),
                              ),
                              event.source === "identity"
                                ? h(Pill, { tone: "notice" }, "账号与权限")
                                : null,
                            ),
                            h(
                              "div",
                              { className: "pmproj-history-meta" },
                              h(
                                "span",
                                null,
                                `${event.actorName || event.actorId || "系统"}${
                                  event.actorRole
                                    ? ` · ${
                                        PLATFORM_ROLE_LABELS[event.actorRole] ??
                                        event.actorRole
                                      }`
                                    : ""
                                }`,
                              ),
                              h("span", null, "·"),
                              h(
                                "span",
                                null,
                                new Date(event.at).toLocaleString("zh-CN", {
                                  hour12: false,
                                }),
                              ),
                            ),
                          ),
                        ),
                        Object.keys(event.detail ?? {}).length === 0
                          ? null
                          : h(
                              "dl",
                              { className: "pmproj-history-detail" },
                              Object.entries(event.detail).flatMap(
                                ([key, value]) => [
                                  h("dt", { key: `${key}:label` }, key),
                                  h("dd", { key: `${key}:value` }, value),
                                ],
                              ),
                            ),
                      ),
                    ),
                  ),
                ),
        );
      };

      const renderDetail = () => {
        if (selectedProject === null) {
          return h("div", { className: "pmproj-empty" }, "还没有项目。");
        }
        if (detailLoading && detail === null) {
          return h("div", { className: "pmproj-loading" }, "正在加载项目详情…");
        }
        const tabs = [
          {
            key: "members",
            label: "成员权限",
            count: (detail?.members ?? []).length,
          },
          {
            key: "tasks",
            label: "任务清单",
            count: (detail?.tasks ?? []).length,
          },
          {
            key: "workflows",
            label: "工作流",
            count: (detail?.workflows ?? []).length,
          },
          {
            key: "outputs",
            label: "产出物",
            count:
              outputsFor === selectedProject.workspaceId
                ? outputs.length
                : undefined,
          },
          { key: "reports", label: "项目日报", count: reports.length },
          ...(canManage
            ? [{ key: "history", label: "历史记录", count: history.length }]
            : []),
        ];
        const body =
          tab === "tasks"
            ? renderTasksTab()
            : tab === "workflows"
              ? renderWorkflowsTab()
              : tab === "outputs"
                ? renderOutputsTab()
                : tab === "reports"
                  ? renderReportsTab()
                  : tab === "history"
                    ? renderHistoryTab()
                    : renderMembersTab();
        const followedNow = followed.has(selectedProject.workspaceId);
        return h(
          Fragment,
          null,
          h(
            "div",
            { className: "pmproj-detail-head" },
            h(
              "div",
              null,
              h(
                "div",
                { className: "pmproj-title-line" },
                h("h2", null, selectedProject.name),
                h(
                  Pill,
                  { tone: statusTone(selectedProject.status) },
                  selectedProject.status,
                ),
                h(
                  Pill,
                  { tone: statusTone(selectedProject.health) },
                  `健康度${selectedProject.health}`,
                ),
              ),
              h(
                "div",
                { className: "pmproj-meta" },
                h("span", null, selectedProject.code || "未编号"),
                h("span", null, "·"),
                h(
                  "span",
                  null,
                  `Owner ${selectedProject.ownerName || "未指定"}`,
                ),
                h("span", null, "·"),
                h(
                  "span",
                  null,
                  `${selectedProject.startDate || "未设置"} 至 ${
                    selectedProject.targetDate || "未设置"
                  }`,
                ),
                h("span", null, "·"),
                h("span", null, `进度 ${selectedProject.progress}%`),
              ),
              selectedProject.description
                ? h(
                    "p",
                    { className: "pmproj-desc" },
                    selectedProject.description,
                  )
                : null,
            ),
            h(
              "div",
              { className: "pmproj-head-actions" },
              h(
                "button",
                {
                  className: `pmproj-btn secondary small pmproj-follow-star ${
                    followedNow ? "active" : ""
                  }`.trim(),
                  type: "button",
                  "aria-pressed": followedNow ? "true" : "false",
                  "aria-label": followedNow ? "取消关注" : "关注",
                  title: followedNow ? "取消关注" : "关注",
                  onClick: () => void toggleFollow(),
                },
                StarIcon({ filled: followedNow }),
              ),
              canManage
                ? h(
                    "button",
                    {
                      className: "pmproj-btn small",
                      type: "button",
                      onClick: openEdit,
                    },
                    "项目设置",
                  )
                : null,
              detail?.viewer?.workspaceRole
                ? h(
                    "button",
                    {
                      className: "pmproj-btn subtle",
                      type: "button",
                      onClick: () => setLeaveOpen(true),
                    },
                    "退出项目",
                  )
                : null,
            ),
          ),
          renderWorkspaceInfo(),
          renderFacts(),
          h(
            "div",
            {
              className: "pmproj-tabs",
              role: "tablist",
              "aria-label": "项目详情内容",
            },
            tabs.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  role: "tab",
                  "aria-selected": tab === item.key ? "true" : "false",
                  className:
                    `pmproj-tab ${tab === item.key ? "active" : ""}`.trim(),
                  onClick: () => {
                    setTab(item.key);
                    if (item.key !== "members") setMemberManageMode(false);
                  },
                },
                item.count === undefined
                  ? item.label
                  : `${item.label} ${item.count}`,
              ),
            ),
          ),
          body,
        );
      };

      const renderTemplateList = () => {
        const keyword = templateSearch.trim().toLowerCase();
        if (templatePane === "roles") {
          const roles = (templateData?.roles ?? []).filter(
            (role) =>
              keyword === "" ||
              `${role.name} ${role.code} ${role.category} ${role.description}`
                .toLowerCase()
                .includes(keyword),
          );
          return roles.length === 0
            ? h("div", { className: "pmproj-empty" }, "没有匹配的项目角色。")
            : roles.map((role) =>
                h(
                  "button",
                  {
                    key: role.id,
                    type: "button",
                    className: `pmproj-list-item ${
                      role.id === selectedRoleId ? "active" : ""
                    }`.trim(),
                    onClick: () => selectRole(role.id),
                  },
                  h(
                    "span",
                    { className: "pmproj-list-mark" },
                    initials(role.name),
                  ),
                  h(
                    "span",
                    { className: "pmproj-list-copy" },
                    h("strong", null, role.name),
                    h("small", null, `${role.code} · ${role.category}`),
                  ),
                  h(
                    "span",
                    { className: "pmproj-count" },
                    `${
                      (templateData?.templates ?? []).filter((template) =>
                        template.roleIds.includes(role.id),
                      ).length
                    } 模版`,
                  ),
                ),
              );
        }
        const templates = (templateData?.templates ?? []).filter(
          (template) =>
            keyword === "" ||
            `${template.name} ${template.code} ${template.type} ${template.description}`
              .toLowerCase()
              .includes(keyword),
        );
        return templates.length === 0
          ? h("div", { className: "pmproj-empty" }, "没有匹配的项目模版。")
          : templates.map((template) =>
              h(
                "button",
                {
                  key: template.id,
                  type: "button",
                  className: `pmproj-list-item ${
                    template.id === selectedTemplateId ? "active" : ""
                  }`.trim(),
                  onClick: () => selectTemplate(template.id),
                },
                h(
                  "span",
                  { className: "pmproj-list-mark" },
                  initials(template.name),
                ),
                h(
                  "span",
                  { className: "pmproj-list-copy" },
                  h("strong", null, template.name),
                  h("small", null, `${template.code} · ${template.type}`),
                ),
                h(
                  "span",
                  { className: "pmproj-count" },
                  `${template.roleIds.length} 角色`,
                ),
              ),
            );
      };

      const renderTemplateDetail = () => {
        if (templateData === null) {
          return h("div", { className: "pmproj-loading" }, "正在加载项目模版…");
        }
        if (templatePane === "roles") {
          if (catalogRoleDraft === null) {
            return h("div", { className: "pmproj-empty" }, "还没有项目角色。");
          }
          const usedBy = (templateData.templates ?? []).filter((template) =>
            template.roleIds.includes(catalogRoleDraft.id),
          );
          return h(
            Fragment,
            null,
            h(
              "div",
              { className: "pmproj-detail-head" },
              h(
                "div",
                null,
                h(
                  "div",
                  { className: "pmproj-title-line" },
                  h("h2", null, catalogRoleDraft.name || "项目角色"),
                  h(Pill, null, catalogRoleDraft.category),
                ),
                h(
                  "div",
                  { className: "pmproj-meta" },
                  h("span", null, catalogRoleDraft.code || "未设置标识"),
                  h("span", null, "·"),
                  h("span", null, `${usedBy.length} 个模版引用`),
                ),
                h(
                  "p",
                  { className: "pmproj-desc" },
                  catalogRoleDraft.description ||
                    "项目内用于任务指派与工作流流转的角色。",
                ),
              ),
            ),
            h(
              "div",
              { className: "pmproj-form-grid" },
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色名称"),
                h("input", {
                  value: catalogRoleDraft.name,
                  onChange: (event) =>
                    setCatalogRoleDraft({
                      ...catalogRoleDraft,
                      name: event.target.value,
                    }),
                }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色标识"),
                h("input", {
                  value: catalogRoleDraft.code,
                  onChange: (event) =>
                    setCatalogRoleDraft({
                      ...catalogRoleDraft,
                      code: event.target.value,
                    }),
                }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色分类"),
                h(
                  "select",
                  {
                    value: catalogRoleDraft.category,
                    onChange: (event) =>
                      setCatalogRoleDraft({
                        ...catalogRoleDraft,
                        category: event.target.value,
                      }),
                  },
                  ROLE_CATEGORIES.map((category) =>
                    h("option", { key: category, value: category }, category),
                  ),
                ),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "使用场景"),
                h("input", { value: "任务指派 · 工作流流转", disabled: true }),
              ),
              h(
                "div",
                { className: "pmproj-field wide" },
                h("span", { className: "label" }, "角色权限（授权范围的来源）"),
                h(
                  "div",
                  { className: "pmproj-checkboxes" },
                  PERMISSION_OPTIONS.map((option) =>
                    h(
                      "label",
                      { key: option.key, className: "pmproj-checkbox" },
                      h("input", {
                        type: "checkbox",
                        checked: catalogRoleDraft.permissions.includes(
                          option.key,
                        ),
                        onChange: (event) => {
                          const next = new Set(catalogRoleDraft.permissions);
                          if (event.target.checked) next.add(option.key);
                          else next.delete(option.key);
                          setCatalogRoleDraft({
                            ...catalogRoleDraft,
                            permissions: [...next],
                          });
                        },
                      }),
                      h("span", null, option.label),
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { className: "pmproj-field wide" },
                h("span", { className: "label" }, "角色说明"),
                h("textarea", {
                  value: catalogRoleDraft.description,
                  onChange: (event) =>
                    setCatalogRoleDraft({
                      ...catalogRoleDraft,
                      description: event.target.value,
                    }),
                }),
              ),
              h(
                "div",
                { className: "pmproj-footer wide" },
                h(
                  "button",
                  {
                    className: "pmproj-btn danger",
                    type: "button",
                    disabled: busy === "role",
                    onClick: () => void removeRole(),
                  },
                  "删除角色",
                ),
                h(
                  "button",
                  {
                    className: "pmproj-btn",
                    type: "button",
                    disabled: busy === "role",
                    onClick: () => void saveRole(),
                  },
                  "保存角色",
                ),
              ),
            ),
            h(
              "div",
              { className: "pmproj-section" },
              h(
                "div",
                { className: "pmproj-section-title" },
                h("span", null, "引用该角色的项目模版"),
                h("span", null, String(usedBy.length)),
              ),
              usedBy.length === 0
                ? h(
                    "div",
                    { className: "pmproj-empty" },
                    "暂无模版引用该角色。",
                  )
                : usedBy.map((template) =>
                    h(
                      "div",
                      { className: "pmproj-item", key: template.id },
                      h(
                        "div",
                        { className: "pmproj-item-main" },
                        h(
                          "div",
                          { className: "pmproj-item-title" },
                          h("strong", null, template.name),
                        ),
                        h(
                          "div",
                          { className: "pmproj-item-meta" },
                          h(
                            "span",
                            null,
                            `${template.code} · ${template.type}`,
                          ),
                        ),
                      ),
                      h(Pill, null, "模版"),
                    ),
                  ),
            ),
          );
        }
        if (templateDraft === null) {
          return h(
            "div",
            { className: "pmproj-empty" },
            "没有可展示的项目模版。",
          );
        }
        const availableRoles = (templateData.roles ?? []).filter(
          (role) => !templateDraft.roleIds.includes(role.id),
        );
        const selectedRoles = templateDraft.roleIds
          .map((roleId) =>
            (templateData.roles ?? []).find((role) => role.id === roleId),
          )
          .filter(Boolean);
        const selectedWorkflows = templateDraft.workflowTemplateIds
          .map((id) =>
            (templateData.workflowTemplates ?? []).find(
              (item) => item.id === id,
            ),
          )
          .filter(Boolean);
        const availableWorkflows = (
          templateData.workflowTemplates ?? []
        ).filter(
          (item) => !templateDraft.workflowTemplateIds.includes(item.id),
        );
        const tabs = [
          { key: "basics", label: "基本信息" },
          {
            key: "roles",
            label: `预定义项目角色 ${selectedRoles.length}`,
          },
          {
            key: "workflows",
            label: `预定义工作流模版 ${selectedWorkflows.length}`,
          },
        ];
        return h(
          Fragment,
          null,
          h(
            "div",
            { className: "pmproj-detail-head" },
            h(
              "div",
              null,
              h(
                "div",
                { className: "pmproj-title-line" },
                h("h2", null, templateDraft.name || "项目模版"),
                h(Pill, null, templateDraft.type || "未设置类型"),
                h(
                  Pill,
                  { tone: templateDraft.status === "启用" ? "done" : "notice" },
                  templateDraft.status,
                ),
              ),
              h(
                "div",
                { className: "pmproj-meta" },
                h("span", null, templateDraft.code || "未设置标识"),
                h("span", null, "·"),
                h("span", null, `${templateDraft.roleIds.length} 个角色`),
              ),
              templateDraft.description
                ? h(
                    "p",
                    { className: "pmproj-desc" },
                    templateDraft.description,
                  )
                : null,
            ),
            h(
              "div",
              { className: "pmproj-head-actions" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  disabled: busy === "template",
                  onClick: duplicateTemplate,
                },
                "复制",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn danger small",
                  type: "button",
                  disabled: busy === "template",
                  onClick: () => void removeTemplate(),
                },
                "删除",
              ),
            ),
          ),
          h(
            "div",
            { className: "pmproj-tabs" },
            tabs.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  className: `pmproj-tab ${
                    templateTab === item.key ? "active" : ""
                  }`.trim(),
                  onClick: () => setTemplateTab(item.key),
                },
                item.label,
              ),
            ),
          ),
          templateTab === "roles"
            ? h(
                Fragment,
                null,
                h(
                  "p",
                  { className: "pmproj-hint" },
                  "这里是模版素材：项目创建或应用该模版时，会把这批角色复制成项目自己的角色清单，之后项目可独立增删改，不会反向修改模版。",
                ),
                h(
                  "div",
                  { className: "pmproj-table" },
                  selectedRoles.length === 0
                    ? h(
                        "div",
                        { className: "pmproj-row" },
                        h(
                          "div",
                          { className: "pmproj-value" },
                          "尚未预定义项目角色。",
                        ),
                      )
                    : selectedRoles.map((role) =>
                        h(
                          "div",
                          { className: "pmproj-row", key: role.id },
                          h(
                            "div",
                            { className: "pmproj-member-copy" },
                            h("strong", null, role.name),
                            h(
                              "small",
                              null,
                              `${role.code} · ${role.category} · ${
                                role.description || "无说明"
                              }`,
                            ),
                          ),
                          h(
                            "div",
                            null,
                            h(
                              "span",
                              { className: "pmproj-label" },
                              "授权范围",
                            ),
                            h(
                              "span",
                              { className: "pmproj-value" },
                              permissionLabels(role.permissions),
                            ),
                          ),
                          h(Fragment, null),
                          h(Fragment, null),
                          h(
                            "div",
                            { className: "pmproj-actions" },
                            h(
                              "button",
                              {
                                className: "pmproj-btn secondary small",
                                type: "button",
                                onClick: () =>
                                  void saveTemplate({
                                    ...templateDraft,
                                    roleIds: templateDraft.roleIds.filter(
                                      (roleId) => roleId !== role.id,
                                    ),
                                  }),
                              },
                              "移除",
                            ),
                          ),
                        ),
                      ),
                ),
                h(
                  "div",
                  { className: "pmproj-inline-form" },
                  h(
                    "select",
                    {
                      value: "",
                      "aria-label": "选择要添加的项目角色",
                      onChange: (event) => {
                        if (event.target.value === "") return;
                        void saveTemplate({
                          ...templateDraft,
                          roleIds: [
                            ...templateDraft.roleIds,
                            event.target.value,
                          ],
                        });
                      },
                    },
                    h("option", { value: "" }, "添加项目角色…"),
                    availableRoles.map((role) =>
                      h(
                        "option",
                        { key: role.id, value: role.id },
                        `${role.name} · ${role.category}`,
                      ),
                    ),
                  ),
                ),
              )
            : templateTab === "workflows"
              ? h(
                  Fragment,
                  null,
                  h(
                    "p",
                    { className: "pmproj-hint" },
                    "这里只做引用：工作流模版本体统一在「工作流 → 工作流模版管理」维护。",
                  ),
                  h(
                    "div",
                    { className: "pmproj-table" },
                    selectedWorkflows.length === 0
                      ? h(
                          "div",
                          { className: "pmproj-row" },
                          h(
                            "div",
                            { className: "pmproj-value" },
                            "尚未引用工作流模版。",
                          ),
                        )
                      : selectedWorkflows.map((workflow) =>
                          h(
                            "div",
                            { className: "pmproj-row", key: workflow.id },
                            h(
                              "div",
                              { className: "pmproj-member-copy" },
                              h("strong", null, workflow.name),
                              h(
                                "small",
                                null,
                                `${workflow.key} v${workflow.version}`,
                              ),
                            ),
                            h(Pill, null, workflow.status),
                            h(Fragment, null),
                            h(Fragment, null),
                            h(
                              "div",
                              { className: "pmproj-actions" },
                              h(
                                "button",
                                {
                                  className: "pmproj-btn secondary small",
                                  type: "button",
                                  onClick: () =>
                                    void saveTemplate({
                                      ...templateDraft,
                                      workflowTemplateIds:
                                        templateDraft.workflowTemplateIds.filter(
                                          (id) => id !== workflow.id,
                                        ),
                                    }),
                                },
                                "移除",
                              ),
                            ),
                          ),
                        ),
                  ),
                  h(
                    "div",
                    { className: "pmproj-inline-form" },
                    h(
                      "select",
                      {
                        value: "",
                        "aria-label": "选择要引用的工作流模版",
                        onChange: (event) => {
                          if (event.target.value === "") return;
                          void saveTemplate({
                            ...templateDraft,
                            workflowTemplateIds: [
                              ...templateDraft.workflowTemplateIds,
                              event.target.value,
                            ],
                          });
                        },
                      },
                      h("option", { value: "" }, "引用工作流模版…"),
                      availableWorkflows.map((workflow) =>
                        h(
                          "option",
                          { key: workflow.id, value: workflow.id },
                          `${workflow.name} v${workflow.version}`,
                        ),
                      ),
                    ),
                  ),
                )
              : h(
                  "div",
                  { className: "pmproj-form-grid" },
                  h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "模版名称"),
                    h("input", {
                      value: templateDraft.name,
                      onChange: (event) =>
                        setTemplateDraft({
                          ...templateDraft,
                          name: event.target.value,
                        }),
                    }),
                  ),
                  h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "模版标识"),
                    h("input", {
                      value: templateDraft.code,
                      onChange: (event) =>
                        setTemplateDraft({
                          ...templateDraft,
                          code: event.target.value,
                        }),
                    }),
                  ),
                  h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "项目类型"),
                    h("input", {
                      value: templateDraft.type,
                      onChange: (event) =>
                        setTemplateDraft({
                          ...templateDraft,
                          type: event.target.value,
                        }),
                    }),
                  ),
                  h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "状态"),
                    h(
                      "select",
                      {
                        value: templateDraft.status,
                        onChange: (event) =>
                          setTemplateDraft({
                            ...templateDraft,
                            status: event.target.value,
                          }),
                      },
                      h("option", { value: "启用" }, "启用"),
                      h("option", { value: "停用" }, "停用"),
                    ),
                  ),
                  h(
                    "label",
                    { className: "pmproj-field wide" },
                    h("span", { className: "label" }, "模版说明"),
                    h("textarea", {
                      value: templateDraft.description,
                      onChange: (event) =>
                        setTemplateDraft({
                          ...templateDraft,
                          description: event.target.value,
                        }),
                    }),
                  ),
                  h(
                    "div",
                    { className: "pmproj-footer wide" },
                    h(
                      "button",
                      {
                        className: "pmproj-btn",
                        type: "button",
                        disabled: busy === "template",
                        onClick: () => void saveTemplate(),
                      },
                      "保存模版",
                    ),
                  ),
                ),
        );
      };

      const renderTemplateView = () =>
        h(
          Fragment,
          null,
          h(
            "div",
            { className: "pmproj-head" },
            h(
              "div",
              null,
              h("h1", null, "项目模版维护"),
              h(
                "div",
                { className: "pmproj-sub" },
                "按项目类型预置「项目角色清单」与「工作流模版清单」；工作流模版本体统一在工作流 → 工作流模版管理维护。",
              ),
            ),
            h(
              "div",
              { className: "pmproj-head-actions" },
              h(
                "div",
                { className: "pmproj-tabs" },
                h(
                  "button",
                  {
                    type: "button",
                    className: `pmproj-tab ${
                      templatePane === "templates" ? "active" : ""
                    }`.trim(),
                    onClick: () => setTemplatePane("templates"),
                  },
                  "项目模版",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `pmproj-tab ${
                      templatePane === "roles" ? "active" : ""
                    }`.trim(),
                    onClick: () => setTemplatePane("roles"),
                  },
                  "角色库（模版素材）",
                ),
              ),
              h(
                "button",
                {
                  className: "pmproj-btn small",
                  type: "button",
                  onClick: () =>
                    templatePane === "roles" ? createRole() : createTemplate(),
                },
                templatePane === "roles" ? "新建角色" : "新建模版",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setView("detail"),
                },
                "关闭",
              ),
            ),
          ),
          h(
            "div",
            { className: "pmproj-layout" },
            h(
              "aside",
              { className: "pmproj-directory", "aria-label": "项目模版列表" },
              h(
                "label",
                { className: "pmproj-search" },
                SearchIcon(),
                h("input", {
                  value: templateSearch,
                  placeholder:
                    templatePane === "roles"
                      ? "搜索角色名称、标识或分类"
                      : "搜索模版名称、类型或角色",
                  onChange: (event) => setTemplateSearch(event.target.value),
                }),
              ),
              h("div", { className: "pmproj-list" }, renderTemplateList()),
            ),
            h("main", { className: "pmproj-detail" }, renderTemplateDetail()),
          ),
        );

      const renderCreateModal = () =>
        h(
          "div",
          { className: `pmproj-modal-mask ${createOpen ? "open" : ""}`.trim() },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "新建项目"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setCreateOpen(false),
                },
                "关闭",
              ),
            ),
            h(
              "div",
              { className: "pmproj-form-grid" },
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "项目名称"),
                h("input", {
                  value: createDraft.name,
                  placeholder: "例如：供应链韧性专项",
                  onChange: (event) =>
                    setCreateDraft({
                      ...createDraft,
                      name: event.target.value,
                    }),
                }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "项目模版（可选）"),
                h(
                  "select",
                  {
                    value: createDraft.templateId,
                    onChange: (event) =>
                      setCreateDraft({
                        ...createDraft,
                        templateId: event.target.value,
                      }),
                  },
                  h("option", { value: "" }, "暂不套用模版"),
                  (templateData?.templates ?? [])
                    .filter((template) => template.status === "启用")
                    .map((template) =>
                      h(
                        "option",
                        { key: template.id, value: template.id },
                        template.name,
                      ),
                    ),
                ),
              ),
              h(
                "div",
                { className: "pmproj-field wide" },
                h("span", { className: "label" }, "项目目录"),
                h(
                  "div",
                  { className: "pmproj-inline-form" },
                  h("input", {
                    value: createDraft.path,
                    readOnly: true,
                    placeholder: "选择一个已存在的本地目录",
                    "aria-label": "项目目录",
                  }),
                  h(
                    "button",
                    {
                      className: "pmproj-btn secondary small",
                      type: "button",
                      onClick: () => void pickDirectory(),
                    },
                    "选择目录",
                  ),
                ),
                h(
                  "p",
                  { className: "pmproj-hint" },
                  "项目即 DSH 工作区：模块只注册目录，不会改动磁盘内容；创建者会成为项目负责人。",
                ),
              ),
              h(
                "div",
                { className: "pmproj-footer wide" },
                h(
                  "button",
                  {
                    className: "pmproj-btn secondary",
                    type: "button",
                    onClick: () => setCreateOpen(false),
                  },
                  "取消",
                ),
                h(
                  "button",
                  {
                    className: "pmproj-btn",
                    type: "button",
                    disabled: busy === "create",
                    onClick: () => void submitCreate(),
                  },
                  "创建项目",
                ),
              ),
            ),
          ),
        );

      const renderLeaveModal = () =>
        h(
          "div",
          {
            className: `pmproj-modal-mask ${leaveOpen ? "open" : ""}`.trim(),
          },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "退出项目？"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setLeaveOpen(false),
                },
                "关闭",
              ),
            ),
            h(
              "p",
              { className: "pmproj-hint" },
              `退出「${selectedProject?.name ?? "当前项目"}」后，你将不再是该项目（工作区）的成员，当前持有的项目角色会被清空。平台账号和全局平台角色不受影响。`,
            ),
            detail?.viewer?.workspaceRole === "owner"
              ? h(
                  "p",
                  { className: "pmproj-notice" },
                  "你当前是工作区负责人。退出后该项目可能没有工作区负责人，平台管理员仍可继续维护。",
                )
              : null,
            h(
              "div",
              { className: "pmproj-footer" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary",
                  type: "button",
                  disabled: busy === "leave",
                  onClick: () => setLeaveOpen(false),
                },
                "取消",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn danger",
                  type: "button",
                  disabled: busy === "leave",
                  onClick: () => void leaveProject(),
                },
                busy === "leave" ? "退出中…" : "确认退出",
              ),
            ),
          ),
        );

      const renderEditModal = () =>
        h(
          "div",
          { className: `pmproj-modal-mask ${editOpen ? "open" : ""}`.trim() },
          h(
            "div",
            {
              className: "pmproj-modal wide",
              role: "dialog",
              "aria-modal": "true",
            },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "项目设置"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: closeEditModal,
                },
                "关闭",
              ),
            ),
            h(
              "div",
              {
                className: "pmproj-tabs",
                role: "tablist",
                "aria-label": "项目编辑内容",
              },
              h(
                "button",
                {
                  className: `pmproj-tab ${
                    editTab === "basics" ? "active" : ""
                  }`.trim(),
                  type: "button",
                  role: "tab",
                  "aria-selected": editTab === "basics" ? "true" : "false",
                  onClick: () => setEditTab("basics"),
                },
                "基础信息",
              ),
              h(
                "button",
                {
                  className: `pmproj-tab ${
                    editTab === "roles" ? "active" : ""
                  }`.trim(),
                  type: "button",
                  role: "tab",
                  "aria-selected": editTab === "roles" ? "true" : "false",
                  onClick: () => setEditTab("roles"),
                },
                `项目角色 ${effectiveRoles.length}${
                  roleDraftDirty ? " · 草稿" : ""
                }`,
              ),
            ),
            editDraft === null
              ? null
              : editTab === "roles"
                ? renderProjectRoleEditor()
                : h(
                    "div",
                    {
                      className: "pmproj-form-grid pmproj-settings-basics",
                    },
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h(
                        "span",
                        { className: "label" },
                        "项目名称（与左侧项目保持一致）",
                      ),
                      h("input", { value: editDraft.name, disabled: true }),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "项目负责人"),
                      h(
                        "select",
                        {
                          value: editDraft.ownerId,
                          onChange: (event) =>
                            setEditDraft({
                              ...editDraft,
                              ownerId: event.target.value,
                            }),
                        },
                        h("option", { value: "" }, "未指定"),
                        (detail?.members ?? [])
                          .filter((member) => member.kind === "human")
                          .map((member) =>
                            h(
                              "option",
                              { key: member.id, value: member.id },
                              member.name,
                            ),
                          ),
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "运行状态"),
                      h(
                        "select",
                        {
                          value: editDraft.status,
                          onChange: (event) =>
                            setEditDraft({
                              ...editDraft,
                              status: event.target.value,
                            }),
                        },
                        PROJECT_STATUSES.map((status) =>
                          h("option", { key: status, value: status }, status),
                        ),
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "项目健康度"),
                      h(
                        "select",
                        {
                          value: editDraft.health,
                          onChange: (event) =>
                            setEditDraft({
                              ...editDraft,
                              health: event.target.value,
                            }),
                        },
                        PROJECT_HEALTHS.map((health) =>
                          h("option", { key: health, value: health }, health),
                        ),
                      ),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "整体进度 %"),
                      h("input", {
                        type: "number",
                        min: 0,
                        max: 100,
                        value: editDraft.progress,
                        onChange: (event) =>
                          setEditDraft({
                            ...editDraft,
                            progress: event.target.value,
                          }),
                      }),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "开始日期"),
                      h("input", {
                        type: "date",
                        value: editDraft.startDate,
                        onChange: (event) =>
                          setEditDraft({
                            ...editDraft,
                            startDate: event.target.value,
                          }),
                      }),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field" },
                      h("span", { className: "label" }, "目标日期"),
                      h("input", {
                        type: "date",
                        value: editDraft.targetDate,
                        onChange: (event) =>
                          setEditDraft({
                            ...editDraft,
                            targetDate: event.target.value,
                          }),
                      }),
                    ),
                    h(
                      "label",
                      { className: "pmproj-field wide" },
                      h("span", { className: "label" }, "项目说明"),
                      h("textarea", {
                        value: editDraft.description,
                        onChange: (event) =>
                          setEditDraft({
                            ...editDraft,
                            description: event.target.value,
                          }),
                      }),
                    ),
                    h(
                      "div",
                      { className: "pmproj-footer wide" },
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary",
                          type: "button",
                          onClick: closeEditModal,
                        },
                        "取消",
                      ),
                      h(
                        "button",
                        {
                          className: "pmproj-btn",
                          type: "button",
                          disabled: busy === "edit",
                          onClick: () => void saveEdit(),
                        },
                        "保存基础信息",
                      ),
                    ),
                  ),
          ),
        );

      const renderMemberModal = () => {
        if (memberModal === null || detail === null) return null;
        const member = memberModalMember;
        const roleOptions = (detail.roles ?? []).filter(
          (role) => role.system !== true,
        );
        const selectedKind =
          memberModal.mode === "add"
            ? memberModal.addKind
            : memberModal.memberKind;
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h(
                "h2",
                null,
                memberModal.mode === "add"
                  ? "添加项目成员"
                  : "编辑项目成员权限",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setMemberModal(null),
                },
                "关闭",
              ),
            ),
            h(
              "div",
              { className: "pmproj-form-grid" },
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "成员"),
                memberModal.mode === "add"
                  ? h(
                      Fragment,
                      null,
                      h(
                        "select",
                        {
                          value: `${memberModal.addKind}|${memberModal.addId}`,
                          onChange: (event) => {
                            const [kind, id] = event.target.value.split("|");
                            setMemberModal({
                              ...memberModal,
                              addKind: kind,
                              addId: id,
                            });
                          },
                        },
                        h("option", { value: "human|" }, "选择主体…"),
                        (detail.directory?.humans ?? []).map((candidate) =>
                          h(
                            "option",
                            {
                              key: `human:${candidate.id}`,
                              value: `human|${
                                candidate.principalId ?? candidate.id
                              }`,
                            },
                            `${platformUserOptionLabel(candidate, "human")} · Human Principal`,
                          ),
                        ),
                        (detail.directory?.agents ?? []).map((candidate) =>
                          h(
                            "option",
                            {
                              key: `agent:${candidate.id}`,
                              value: `agent|${
                                candidate.principalId ?? candidate.id
                              }`,
                            },
                            `${platformUserOptionLabel(candidate, "agent")} · AI Principal`,
                          ),
                        ),
                      ),
                    )
                  : h("input", {
                      value: member?.name ?? "",
                      disabled: true,
                    }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "项目角色"),
                roleOptions.length === 0
                  ? h(
                      "select",
                      { value: "", disabled: true },
                      h("option", null, "暂无可用项目角色"),
                    )
                  : h(
                      "select",
                      {
                        value: memberModal.roleIds[0] ?? "",
                        onChange: (event) =>
                          setMemberModal({
                            ...memberModal,
                            roleIds:
                              event.target.value === ""
                                ? []
                                : [event.target.value],
                          }),
                      },
                      h("option", { value: "" }, "未分配"),
                      roleOptions.map((role) =>
                        h(
                          "option",
                          { key: role.id, value: role.id },
                          role.name,
                        ),
                      ),
                    ),
              ),
              selectedKind === "human"
                ? h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "工作区角色"),
                    h(
                      "select",
                      {
                        value: memberModal.workspaceRole ?? "member",
                        onChange: (event) =>
                          setMemberModal({
                            ...memberModal,
                            workspaceRole: event.target.value,
                          }),
                      },
                      h("option", { value: "owner" }, "负责人"),
                      h("option", { value: "member" }, "成员"),
                      h("option", { value: "guest" }, "访客"),
                    ),
                  )
                : null,
              selectedKind === "human"
                ? h(
                    "label",
                    { className: "pmproj-field" },
                    h("span", { className: "label" }, "加入时间"),
                    h("input", {
                      value:
                        member?.joinedAt === undefined
                          ? memberModal.mode === "add"
                            ? "保存后记录"
                            : "未知"
                          : new Date(member.joinedAt).toLocaleString("zh-CN", {
                              hour12: false,
                            }),
                      disabled: true,
                    }),
                  )
                : null,
              h(
                "label",
                { className: "pmproj-field wide" },
                h(
                  "span",
                  { className: "label" },
                  "授权范围（按项目角色只读汇总）",
                ),
                h("input", { value: memberModalScope, disabled: true }),
              ),
              h(
                "p",
                { className: "pmproj-hint wide" },
                "工作区角色只属于当前项目（工作区）成员关系，不是平台账号的全局角色；平台账号、平台角色与启停用状态仍只在平台设置中维护。",
              ),
              h(
                "div",
                { className: "pmproj-footer wide" },
                memberModal.mode === "edit" && canManage
                  ? h(
                      "button",
                      {
                        className: "pmproj-btn danger",
                        type: "button",
                        disabled: busy === "member",
                        onClick: () =>
                          void removeMember(
                            memberModal.memberKind,
                            memberModal.memberId,
                          ),
                      },
                      "移除成员",
                    )
                  : null,
                h(
                  "button",
                  {
                    className: "pmproj-btn secondary",
                    type: "button",
                    onClick: () => setMemberModal(null),
                  },
                  "取消",
                ),
                h(
                  "button",
                  {
                    className: "pmproj-btn",
                    type: "button",
                    disabled: busy === "member",
                    onClick: () => void saveMember(),
                  },
                  memberModal.mode === "add" ? "添加成员" : "保存变更",
                ),
              ),
            ),
          ),
        );
      };

      const renderRoleModal = () => {
        if (roleModal === null || detail === null) return null;
        /**
         * 不依赖打开弹窗时缓存的 effective 标记：直接按当前有效集判断，
         * 避免旧数据/草稿状态导致“调整 / 新建”选择器不出现。
         */
        const isEffectiveRole =
          roleModal.mode === "edit" &&
          effectiveRoles.some(
            (role) =>
              roleCodeKey(role) ===
              roleCodeKey({ code: roleModal.originalCode || roleModal.code }),
          );
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h(
                "h2",
                null,
                roleModal.copyMode
                  ? "创建新角色"
                  : roleModal.mode === "add"
                    ? "添加项目角色"
                    : "编辑项目角色",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setRoleModal(null),
                },
                "关闭",
              ),
            ),
            h(
              "div",
              { className: "pmproj-form-grid" },
              roleModal.mode === "add"
                ? h(
                    "label",
                    { className: "pmproj-field wide" },
                    h("span", { className: "label" }, "从角色库预填（可选）"),
                    h(
                      "select",
                      {
                        value: roleModal.prefillId,
                        onChange: (event) => prefillRole(event.target.value),
                      },
                      h("option", { value: "" }, "从空白开始…"),
                      (detail.roleLibrary ?? []).map((role) =>
                        h(
                          "option",
                          { key: role.id, value: role.id },
                          `${role.name} · ${role.category}`,
                        ),
                      ),
                    ),
                  )
                : null,
              isEffectiveRole
                ? h(
                    "div",
                    { className: "pmproj-field wide" },
                    h("span", { className: "label" }, "保存方式"),
                    h(
                      "div",
                      { className: "pmproj-checkboxes" },
                      h(
                        "label",
                        { className: "pmproj-checkbox" },
                        h("input", {
                          type: "radio",
                          name: "roleSaveMode",
                          checked: !roleModal.copyMode,
                          onChange: () => switchRoleCopyMode(false),
                        }),
                        h("span", null, "调整原有角色"),
                      ),
                      h(
                        "label",
                        { className: "pmproj-checkbox" },
                        h("input", {
                          type: "radio",
                          name: "roleSaveMode",
                          checked: roleModal.copyMode,
                          onChange: () => switchRoleCopyMode(true),
                        }),
                        h("span", null, "创建新角色"),
                      ),
                    ),
                    h(
                      "p",
                      { className: "pmproj-hint" },
                      roleModal.copyMode
                        ? "将另存为新的项目角色，系统自动生成新的角色标识，原角色保持不变。"
                        : "修改会更新当前角色；角色标识保持不变，上下游引用不受影响。",
                    ),
                  )
                : null,
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色名称"),
                h("input", {
                  value: roleModal.name,
                  onChange: (event) =>
                    setRoleModal({ ...roleModal, name: event.target.value }),
                }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色标识"),
                h("input", {
                  value: roleModal.code,
                  readOnly:
                    roleModal.copyMode ||
                    (roleModal.mode === "edit" && isEffectiveRole),
                  title: roleModal.copyMode
                    ? "系统自动生成的新角色标识"
                    : roleModal.mode === "edit" && isEffectiveRole
                      ? "角色标识是上下游业务键，创建后不可修改"
                      : undefined,
                  onChange: (event) =>
                    setRoleModal({ ...roleModal, code: event.target.value }),
                }),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "角色分类"),
                h(
                  "select",
                  {
                    value: roleModal.category,
                    onChange: (event) =>
                      setRoleModal({
                        ...roleModal,
                        category: event.target.value,
                      }),
                  },
                  ROLE_CATEGORIES.map((category) =>
                    h("option", { key: category, value: category }, category),
                  ),
                ),
              ),
              h(
                "label",
                { className: "pmproj-field" },
                h("span", { className: "label" }, "使用场景"),
                h("input", { value: "任务指派 · 工作流流转", disabled: true }),
              ),
              h(
                "div",
                { className: "pmproj-field wide" },
                h("span", { className: "label" }, "角色权限（授权范围的来源）"),
                h(
                  "div",
                  { className: "pmproj-checkboxes" },
                  PERMISSION_OPTIONS.map((option) =>
                    h(
                      "label",
                      { key: option.key, className: "pmproj-checkbox" },
                      h("input", {
                        type: "checkbox",
                        checked: roleModal.permissions.includes(option.key),
                        onChange: (event) => {
                          const next = new Set(roleModal.permissions);
                          if (event.target.checked) next.add(option.key);
                          else next.delete(option.key);
                          setRoleModal({
                            ...roleModal,
                            permissions: [...next],
                          });
                        },
                      }),
                      h("span", null, option.label),
                    ),
                  ),
                ),
              ),
              h(
                "label",
                { className: "pmproj-field wide" },
                h("span", { className: "label" }, "角色说明"),
                h("textarea", {
                  value: roleModal.description,
                  onChange: (event) =>
                    setRoleModal({
                      ...roleModal,
                      description: event.target.value,
                    }),
                }),
              ),
              h(
                "p",
                { className: "pmproj-hint wide" },
                "该角色只属于本项目；修改或删除不会影响项目模版、全局角色库或其他项目。删除角色会同时释放该角色的成员指派。",
              ),
              h(
                "div",
                { className: "pmproj-footer wide" },
                roleModal.mode === "edit" && !roleModal.copyMode
                  ? h(
                      "button",
                      {
                        className: "pmproj-btn danger",
                        type: "button",
                        disabled: busy === "role",
                        onClick: () => void deleteRoleModal(),
                      },
                      "删除角色",
                    )
                  : null,
                h(
                  "button",
                  {
                    className: "pmproj-btn secondary",
                    type: "button",
                    onClick: () => setRoleModal(null),
                  },
                  "取消",
                ),
                h(
                  "button",
                  {
                    className: "pmproj-btn",
                    type: "button",
                    disabled: busy === "role",
                    onClick: () => void saveRoleModal(),
                  },
                  "保存角色",
                ),
              ),
            ),
          ),
        );
      };

      const renderRoleSourcesModal = () => {
        if (!roleSourcesOpen) return null;
        const source =
          roleSources.find((item) => item.workspaceId === roleSourceId) ?? null;
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "复用其他项目的角色"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setRoleSourcesOpen(false),
                },
                "关闭",
              ),
            ),
            roleSourcesLoading
              ? h("div", { className: "pmproj-loading" }, "正在加载可复用项目…")
              : roleSources.length === 0
                ? h(
                    "div",
                    { className: "pmproj-empty" },
                    "暂无可复用的项目角色。请确认其他项目已有角色，并且你有访问权限。",
                  )
                : h(
                    Fragment,
                    null,
                    h(
                      "div",
                      { className: "pmproj-form-grid" },
                      h(
                        "label",
                        { className: "pmproj-field wide" },
                        h("span", { className: "label" }, "来源项目"),
                        h(
                          "select",
                          {
                            value: roleSourceId,
                            onChange: (event) =>
                              selectRoleSource(event.target.value),
                          },
                          roleSources.map((item) =>
                            h(
                              "option",
                              {
                                key: item.workspaceId,
                                value: item.workspaceId,
                              },
                              `${item.name} · ${item.roles.length} 角色`,
                            ),
                          ),
                        ),
                      ),
                      source === null
                        ? null
                        : h(
                            "div",
                            { className: "pmproj-field wide" },
                            h(
                              "span",
                              { className: "label" },
                              "选择要复用的角色",
                            ),
                            h(
                              "div",
                              { className: "pmproj-checkboxes" },
                              source.roles.map((role) =>
                                h(
                                  "label",
                                  {
                                    key: role.id,
                                    className: "pmproj-checkbox",
                                  },
                                  h("input", {
                                    type: "checkbox",
                                    checked: roleSourceRoleIds.includes(
                                      role.id,
                                    ),
                                    onChange: (event) => {
                                      const next = new Set(roleSourceRoleIds);
                                      if (event.target.checked)
                                        next.add(role.id);
                                      else next.delete(role.id);
                                      setRoleSourceRoleIds([...next]);
                                    },
                                  }),
                                  h("span", null, role.name),
                                ),
                              ),
                            ),
                          ),
                    ),
                    h(
                      "p",
                      { className: "pmproj-hint" },
                      "角色会以副本形式合并进当前项目；id 或标识重复的角色会自动跳过。来源项目不受影响。",
                    ),
                    h(
                      "div",
                      { className: "pmproj-footer" },
                      h(
                        "button",
                        {
                          className: "pmproj-btn secondary",
                          type: "button",
                          onClick: () => setRoleSourcesOpen(false),
                        },
                        "取消",
                      ),
                      h(
                        "button",
                        {
                          className: "pmproj-btn",
                          type: "button",
                          disabled:
                            busy === "import" ||
                            roleSourceId === "" ||
                            roleSourceRoleIds.length === 0,
                          onClick: () => void importSourceRoles(),
                        },
                        `引入所选角色（${roleSourceRoleIds.length}）`,
                      ),
                    ),
                  ),
          ),
        );
      };

      const renderTemplateLoadModal = () => {
        if (!templateLoadOpen) return null;
        const templates = detail?.templates ?? [];
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "从模版加载项目角色"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setTemplateLoadOpen(false),
                },
                "关闭",
              ),
            ),
            h(
              "p",
              { className: "pmproj-hint" },
              "选择后会替换当前角色草稿；在点「确认生效」前，不会影响已生效角色与成员指派。",
            ),
            templates.length === 0
              ? h(
                  "div",
                  { className: "pmproj-empty" },
                  "还没有可用的项目模版。",
                )
              : h(
                  "div",
                  { className: "pmproj-items" },
                  templates
                    .filter((template) => template.status === "启用")
                    .map((template) =>
                      h(
                        "button",
                        {
                          key: template.id,
                          className: "pmproj-list-item",
                          type: "button",
                          onClick: () => loadTemplateToDraft(template.id),
                        },
                        h(
                          "span",
                          { className: "pmproj-list-mark" },
                          initials(template.name),
                        ),
                        h(
                          "span",
                          { className: "pmproj-list-copy" },
                          h("strong", null, template.name),
                          h(
                            "small",
                            null,
                            `${template.type} · ${template.roleIds.length} 个角色`,
                          ),
                        ),
                        h(Pill, null, "加载"),
                      ),
                    ),
                ),
            h(
              "div",
              { className: "pmproj-footer" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary",
                  type: "button",
                  onClick: () => setTemplateLoadOpen(false),
                },
                "取消",
              ),
            ),
          ),
        );
      };

      const renderMemberImpactModal = () => {
        if (memberImpact === null) return null;
        const impacts = memberImpact.impacts ?? [];
        const removedRoles = memberImpact.removedRoles ?? [];
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "确认删除项目角色"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setMemberImpact(null),
                },
                "关闭",
              ),
            ),
            h(
              "p",
              { className: "pmproj-hint" },
              `本次将移除 ${removedRoles.length} 个角色；以下成员在这些角色上的项目角色会被清空，成员仍保留在项目中。`,
            ),
            h(
              "div",
              { className: "pmproj-items" },
              impacts.map((impact) =>
                h(
                  "div",
                  {
                    className: "pmproj-item",
                    key: `${impact.memberKind}:${impact.memberId}`,
                  },
                  h(
                    "div",
                    { className: "pmproj-item-main" },
                    h(
                      "div",
                      { className: "pmproj-item-title" },
                      h("strong", null, impact.memberName),
                    ),
                    h(
                      "div",
                      { className: "pmproj-item-meta" },
                      h(
                        "span",
                        null,
                        impact.memberKind === "agent" ? "AI伙伴" : "人员",
                      ),
                      h(
                        "span",
                        null,
                        `将清空：${impact.roles
                          .map((role) => role.roleName)
                          .join("、")}`,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "pmproj-footer" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary",
                  type: "button",
                  onClick: () => setMemberImpact(null),
                },
                "取消",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn danger",
                  type: "button",
                  disabled: busy === "role-confirm",
                  onClick: () => {
                    setMemberImpact(null);
                    void confirmRoleDraft(true);
                  },
                },
                "确认删除并生效",
              ),
            ),
          ),
        );
      };

      const renderWorkflowBlockModal = () => {
        if (workflowBlock === null) return null;
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "角色不能下线"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setWorkflowBlock(null),
                },
                "关闭",
              ),
            ),
            h(
              "p",
              { className: "pmproj-hint" },
              "以下角色仍被项目已加载的工作流模版引用。请先在工作流模版管理中失效或编辑对应模版，再回来确认。",
            ),
            h(
              "div",
              { className: "pmproj-items" },
              workflowBlock.map((block, index) =>
                h(
                  "div",
                  {
                    className: "pmproj-item",
                    key: `${block.templateId}:${block.nodeId}:${index}`,
                  },
                  h(
                    "div",
                    { className: "pmproj-item-main" },
                    h(
                      "div",
                      { className: "pmproj-item-title" },
                      h("strong", null, block.templateName),
                    ),
                    h(
                      "div",
                      { className: "pmproj-item-meta" },
                      h("span", null, `节点：${block.nodeName}`),
                      h(
                        "span",
                        null,
                        `角色：${block.roleName}${block.roleCode ? `（${block.roleCode}）` : ""}`,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            h(
              "div",
              { className: "pmproj-footer" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary",
                  type: "button",
                  onClick: () => setWorkflowBlock(null),
                },
                "知道了",
              ),
            ),
          ),
        );
      };

      const renderDraftGuardModal = () => {
        if (draftGuard === null) return null;
        const message =
          draftGuard.kind === "switch"
            ? "当前项目有未生效的角色草稿，切换项目会丢弃草稿。"
            : draftGuard.kind === "edit-close"
              ? "当前项目有未生效的角色草稿，关闭项目设置会丢弃草稿。"
              : `加载模版「${draftGuard.templateName || "所选模版"}」会覆盖当前角色草稿。`;
        return h(
          "div",
          { className: "pmproj-modal-mask open" },
          h(
            "div",
            { className: "pmproj-modal", role: "dialog", "aria-modal": "true" },
            h(
              "div",
              { className: "pmproj-modal-head" },
              h("h2", null, "放弃角色草稿？"),
              h(
                "button",
                {
                  className: "pmproj-btn secondary small",
                  type: "button",
                  onClick: () => setDraftGuard(null),
                },
                "关闭",
              ),
            ),
            h("p", { className: "pmproj-hint" }, message),
            h(
              "div",
              { className: "pmproj-footer" },
              h(
                "button",
                {
                  className: "pmproj-btn secondary",
                  type: "button",
                  onClick: () => setDraftGuard(null),
                },
                "继续编辑",
              ),
              h(
                "button",
                {
                  className: "pmproj-btn danger",
                  type: "button",
                  onClick: () => resolveDraftGuard(true),
                },
                draftGuard.kind === "template"
                  ? "放弃草稿并加载模版"
                  : draftGuard.kind === "edit-close"
                    ? "放弃草稿并关闭"
                    : "放弃草稿并继续",
              ),
            ),
          ),
        );
      };

      if (view === "templates") {
        return h(
          "section",
          { className: "pmproj", "data-page": "projects" },
          h("style", null, styles),
          renderError(),
          renderTemplateView(),
        );
      }

      return h(
        "section",
        { className: "pmproj", "data-page": "projects" },
        h("style", null, styles),
        h(
          "div",
          { className: "pmproj-head" },
          h(
            "div",
            null,
            h("h1", null, "项目"),
            h(
              "div",
              { className: "pmproj-sub" },
              "项目清单、成员权限、任务、工作流、项目日报与项目模版",
            ),
          ),
          h(
            "div",
            { className: "pmproj-head-actions" },
            viewer?.role === "admin"
              ? h(
                  "button",
                  {
                    className: "pmproj-btn secondary",
                    type: "button",
                    "aria-pressed": "false",
                    onClick: openTemplateView,
                  },
                  "项目模版",
                )
              : null,
            h(
              "button",
              {
                className: "pmproj-btn",
                type: "button",
                onClick: () => setCreateOpen(true),
              },
              "新建项目",
            ),
          ),
        ),
        renderError(),
        phase === "loading"
          ? h("div", { className: "pmproj-loading" }, "正在加载项目…")
          : h(
              "div",
              { className: "pmproj-layout" },
              renderProjectList(),
              h(
                "main",
                { className: "pmproj-detail", "aria-label": "项目详情" },
                renderDetail(),
              ),
            ),
        renderCreateModal(),
        renderLeaveModal(),
        renderEditModal(),
        renderMemberModal(),
        renderRoleModal(),
        renderRoleSourcesModal(),
        renderTemplateLoadModal(),
        renderMemberImpactModal(),
        renderWorkflowBlockModal(),
        renderDraftGuardModal(),
      );
    }

    exports.__test = {
      statusTone,
      priorityLabel,
      permissionLabels,
      platformUserOptionLabel,
      memberScopeForRoles,
      workspaceRoleLabel,
      compactWorkspacePath,
      auditCategoryLabel,
      auditMatches,
      projectMatches,
      sortProjectTasks,
      outputMatches,
      groupOutputsByDay,
      formatFileSize,
      outputLoadErrorMessage,
      parseReportBlocks,
      roleCodeKey,
      roleFieldsDiffer,
      computeRoleDiff,
      nextRoleCopyCode,
      openTask,
      openWorkflow,
    };

    exports.inject = ["slots"];
    exports.apply = (ctx) => {
      clientCtx = ctx;
      ctx.slots.inject("pluginmax.global", () =>
        ctx.slots.register(
          {
            name: "pluginmax.global",
            id: "pluginmax-project",
            order: 32,
          },
          ProjectGlobalPage,
        ),
      );
    };

    return module.exports;
  },
});
