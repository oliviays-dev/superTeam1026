import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(import.meta.dirname, "../client/index.js");

interface ClientExports {
  inject?: readonly string[];
  apply?: unknown;
  __test?: {
    runtimeTabs(): readonly { key: string; label: string }[];
    sortPlanTasks(
      tasks: readonly {
        id: string;
        priority: string;
        createdAt: string;
      }[],
    ): readonly { id: string; priority: string; createdAt: string }[];
    planStoragePriority(display: string): string;
    groupTeammateTemplates(
      items: readonly {
        id: string;
        personaId?: string | undefined;
        profileTemplateId?: string | undefined;
        createdAt: string;
      }[],
    ): readonly {
      item: { id: string };
      instanceIds: readonly string[];
    }[];
    markdownTableCells(line: string): readonly string[];
    isMarkdownTableSeparator(line: string): boolean;
    runtimeDetailEditPolicy(editing: boolean): {
      showMetrics: boolean;
      panelsClass: string;
    };
    externalRuntimeStatusLabel(status: string): string;
    splitExternalRuntimes(
      runtimes: readonly { id: string; status: string }[],
    ): {
      active: readonly { id: string; status: string }[];
      archived: readonly { id: string; status: string }[];
      defaultView: readonly { id: string; status: string }[];
    };
    teammateExecutionPill(
      teammate: { execution?: string; externalRuntimeId?: string },
      runtimes: readonly { id: string; name: string; status: string }[],
    ): { text: string; tone: string };
    externalRuntimeOptions(
      runtimes: readonly {
        id: string;
        name: string;
        provider: string;
        status: string;
      }[],
      boundId?: string,
    ): readonly {
      props: { value: string; disabled?: boolean };
    }[];
    unavailableBoundRuntime(
      runtimes: readonly { id: string; status: string }[],
      boundId?: string,
    ): { id: string; status: string } | undefined;
    parseExternalArgsText(value: string): {
      args: readonly string[];
      error: string;
    };
    formatExternalArgsText(args: readonly string[]): string;
    parseExternalRuntimeArgs(
      provider: string,
      args: readonly string[],
    ): {
      modelMode: string;
      model: string;
      supportedModels?: readonly string[] | undefined;
      defaultModel?: string | undefined;
      supportedTools?: readonly string[] | undefined;
      customArgs?: readonly string[] | undefined;
      customArgsText?: string | undefined;
      searchEnabled: boolean;
      permissionMode: string;
      maxTurns: string;
      ignoredOutputFormat: boolean;
      advancedArgs?:
        | readonly {
            kind: string;
            name: string;
            value: string;
          }[]
        | undefined;
    };
    compileExternalRuntimeArgs(form: {
      provider: string;
      modelMode: string;
      model: string;
      supportedModels?: readonly string[] | undefined;
      defaultModel?: string | undefined;
      supportedTools?: readonly string[] | undefined;
      searchEnabled: boolean;
      permissionMode: string;
      maxTurns: string;
      advancedArgs: readonly {
        kind: string;
        name: string;
        value: string;
      }[];
    }): readonly string[];
    externalRuntimeFormError(form: {
      provider: string;
      modelMode: string;
      model: string;
      supportedModels?: readonly string[] | undefined;
      defaultModel?: string | undefined;
      maxTurns: string;
      contextWindowTokens?: string | undefined;
      customArgsText?: string | undefined;
      advancedArgs?:
        | readonly {
            kind: string;
            name: string;
            value: string;
          }[]
        | undefined;
    }): string;
    runtimeConfigurationLabels(runtime: {
      provider: string;
      args: readonly string[];
      supportedModels?: readonly string[] | undefined;
      defaultModel?: string | undefined;
      supportedTools?: readonly string[] | undefined;
      customArgs?: readonly string[] | undefined;
      contextWindowTokens?: number | undefined;
    }): readonly string[];
    externalCommandPreview(form: {
      provider: string;
      protocol: string;
      command: string;
      modelMode: string;
      model: string;
      supportedModels?: readonly string[] | undefined;
      defaultModel?: string | undefined;
      supportedTools?: readonly string[] | undefined;
      customArgsText?: string | undefined;
      searchEnabled: boolean;
      permissionMode: string;
      maxTurns: string;
      contextWindowTokens?: string | undefined;
    }): string;
  };
}

/** 用最小 window/React 替身执行 bundle，取出导出给测试的纯函数。 */
function loadClientExports(): ClientExports {
  let exports: ClientExports = {};
  const fakeReact = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: props ?? {},
      children,
    }),
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: () => unknown) => callback(),
    useRef: (value: unknown) => ({ current: value }),
    Fragment: "Fragment",
  };
  const windowStub = {
    __ModuleLoader__: {
      load: (definition: {
        id: string;
        factory: (require: (id: string) => unknown) => unknown;
      }) => {
        exports = definition.factory((id: string) => {
          if (id === "react") return fakeReact;
          throw new Error(`unexpected module: ${id}`);
        }) as ClientExports;
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    document: {
      querySelectorAll: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  };
  const source = readFileSync(CLIENT_PATH, "utf8");
  const factory = new Function("window", "module", "exports", source) as (
    window: unknown,
    module: { exports: unknown },
    exports: unknown,
  ) => void;
  const module = { exports: {} };
  factory(windowStub, module, module.exports);
  return exports;
}

describe("AI Teammate runtime client", () => {
  it("creates AI companions with a project through the bundled runtime route", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain('"/api/collab/teammates/create-with-employee"');
    expect(source).toContain("关联项目");
    expect(source).toContain("createInstanceWorkspaceId");
  });

  it("declares the fixed runtime tabs in product order", () => {
    const exported = loadClientExports();
    const tabs = exported.__test?.runtimeTabs();
    expect(tabs?.map((tab) => tab.label)).toEqual([
      "当前工作",
      "工作计划",
      "工作日报",
      "角色权限",
      "历史记录",
    ]);
    expect(tabs?.map((tab) => tab.key)).toEqual([
      "current",
      "plan",
      "report",
      "roles",
      "audit",
    ]);
  });

  it("sorts planned tasks by priority then creation time", () => {
    const exported = loadClientExports();
    const sorted = exported.__test?.sortPlanTasks([
      { id: "later", priority: "P3", createdAt: "2026-10-10T02:00:00.000Z" },
      { id: "high", priority: "P1", createdAt: "2026-10-10T03:00:00.000Z" },
      { id: "earlier", priority: "P3", createdAt: "2026-10-10T01:00:00.000Z" },
    ]);
    expect(sorted?.map((task) => task.id)).toEqual([
      "high",
      "earlier",
      "later",
    ]);
    expect(exported.__test?.planStoragePriority("P0")).toBe("P1");
    expect(exported.__test?.planStoragePriority("P2")).toBe("P3");
  });

  it("groups definition rows by agent template", () => {
    const exported = loadClientExports();
    const grouped = exported.__test?.groupTeammateTemplates([
      {
        id: "tm-2",
        personaId: "backend-soul",
        createdAt: "2026-10-10T01:30:00.000Z",
      },
      {
        id: "tm-1",
        personaId: "backend-soul",
        createdAt: "2026-09-24T01:09:00.000Z",
      },
      {
        id: "tm-3",
        profileTemplateId: "profile-pd",
        createdAt: "2026-09-23T12:08:00.000Z",
      },
      // 没有模版归属的实例各自成组
      { id: "tm-4", createdAt: "2026-10-09T13:58:00.000Z" },
    ]);
    expect(grouped?.map((entry) => entry.item.id)).toEqual([
      "tm-1",
      "tm-3",
      "tm-4",
    ]);
    expect(grouped?.[0]?.instanceIds).toEqual(["tm-2", "tm-1"]);
  });

  it("parses GFM tables inside work report markdown", () => {
    const exported = loadClientExports();
    expect(exported.__test?.isMarkdownTableSeparator("| --- | :---: |")).toBe(
      true,
    );
    expect(exported.__test?.isMarkdownTableSeparator("| 任务 | 状态 |")).toBe(
      false,
    );
    expect(exported.__test?.markdownTableCells("| TSK-1 | 已完成 |")).toEqual([
      "TSK-1",
      "已完成",
    ]);
  });

  it("locks runtime detail panels while editing base info", () => {
    const exported = loadClientExports();
    expect(exported.__test?.runtimeDetailEditPolicy(false)).toEqual({
      showMetrics: true,
      panelsClass: "pmtm-runtime-panels",
    });
    expect(exported.__test?.runtimeDetailEditPolicy(true)).toEqual({
      showMetrics: false,
      panelsClass: "pmtm-runtime-panels editing",
    });
  });

  it("hides runtime tab actions in the editing state", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain(
      ".pmtm-runtime-panels.editing .pmtm-btn{display:none;}",
    );
  });

  it("auto-dismisses the top status notice after 3s", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toMatch(/setNotice\(""\),\s*3_000\)/);
  });

  it("keeps work-report history unfiltered by default", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toMatch(
      /function defaultReportRange\(\)[\s\S]{0,260}?return \{ from: "", to: "" \};/,
    );
  });

  it("renders task progress through the markdown renderer", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toMatch(
      /function LatestProgressText[\s\S]{0,1200}?renderMarkdown\(task\.latestProgress/,
    );
    expect(source).toMatch(
      /const latestOf = \(task, fallback\) =>[\s\S]{0,600}?renderMarkdown\(/,
    );
    expect(source).toMatch(
      /run\.summary === undefined[\s\S]{0,700}?renderMarkdown\(run\.summary\)/,
    );
  });

  it("edits teammate definitions through SOUL only", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    // 场景行为 / 工作目标已并入 SOUL.md，编辑表单不再有独立输入框。
    expect(source).not.toContain("场景行为（每行一项");
    expect(source).not.toContain("工作目标（每行一项");
    // 编辑态直接用生效人格全文，保存时清空旧字段。
    expect(source).toMatch(/soul: effectiveSoulText\(selected\)/);
    expect(source).toContain("scenarios: [],");
    expect(source).toContain("goals: [],");
  });

  it("filters the definition list by the archived view", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toMatch(
      /archivedOnly\s*\?\s*item\.state === "archived"\s*:\s*item\.state !== "archived"/,
    );
  });

  it("labels external runtime status and splits the archived view", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    expect(test?.externalRuntimeStatusLabel("active")).toBe("启用中");
    expect(test?.externalRuntimeStatusLabel("disabled")).toBe("已停用");
    expect(test?.externalRuntimeStatusLabel("archived")).toBe("已归档");
    const groups = test?.splitExternalRuntimes([
      { id: "ext-1", status: "active" },
      { id: "ext-2", status: "disabled" },
      { id: "ext-3", status: "archived" },
    ]);
    expect(groups?.defaultView.map((item) => item.id)).toEqual([
      "ext-1",
      "ext-2",
    ]);
    expect(groups?.archived.map((item) => item.id)).toEqual(["ext-3"]);
    expect(groups?.active.map((item) => item.id)).toEqual(["ext-1"]);
  });

  it("flags teammate bindings whose external runtime is unavailable", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    const runtimes = [
      { id: "ext-1", name: "Codex 本机", status: "active" },
      { id: "ext-2", name: "WorkBuddy CLI", status: "disabled" },
      { id: "ext-3", name: "旧运行时", status: "archived" },
    ];
    expect(
      test?.teammateExecutionPill({ execution: "builtin" }, runtimes),
    ).toEqual({ text: "内置执行", tone: "builtin" });
    expect(
      test?.teammateExecutionPill(
        { execution: "external", externalRuntimeId: "ext-1" },
        runtimes,
      ),
    ).toEqual({ text: "外部 Agent · Codex 本机", tone: "external" });
    expect(
      test?.teammateExecutionPill(
        { execution: "external", externalRuntimeId: "ext-2" },
        runtimes,
      ),
    ).toEqual({
      text: "外部 Agent · WorkBuddy CLI（已停用）",
      tone: "external warn",
    });
    expect(
      test?.teammateExecutionPill(
        { execution: "external", externalRuntimeId: "ext-3" },
        runtimes,
      ).tone,
    ).toBe("external warn");
    expect(
      test?.teammateExecutionPill({ execution: "external" }, runtimes),
    ).toEqual({ text: "外部 Agent · 未选择", tone: "external warn" });
    expect(
      test?.teammateExecutionPill(
        { execution: "external", externalRuntimeId: "ext-missing" },
        runtimes,
      ),
    ).toEqual({
      text: "外部 Agent · ext-missing（运行时不存在）",
      tone: "external warn",
    });
  });

  it("keeps the bound runtime visible as a disabled option when it is unavailable", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    const runtimes = [
      { id: "ext-1", name: "Codex 本机", provider: "codex", status: "active" },
      {
        id: "ext-2",
        name: "WorkBuddy CLI",
        provider: "workbuddy",
        status: "disabled",
      },
      {
        id: "ext-3",
        name: "旧运行时",
        provider: "command",
        status: "archived",
      },
    ];
    const options = test?.externalRuntimeOptions(runtimes, "ext-3");
    expect(options?.map((item) => item.props.value)).toEqual([
      "",
      "ext-1",
      "ext-3",
    ]);
    expect(options?.[1]?.props.disabled).toBeUndefined();
    expect(options?.[2]?.props.disabled).toBe(true);
    expect(test?.unavailableBoundRuntime(runtimes, "ext-1")).toBeUndefined();
    expect(test?.unavailableBoundRuntime(runtimes, "ext-2")).toMatchObject({
      id: "ext-2",
      status: "disabled",
    });
  });

  it("supports editing external runtime definitions", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("const startExternalEdit = (runtime)");
    expect(source).toContain("已更新外部 Agent");
    expect(source).toContain("/api/collab/agent/external-runtimes/update");
    expect(source).toContain("运行时名称");
    expect(source).toContain("Agent 角色、职责和 SOUL 请在定义态配置");
    expect(source).toContain("执行配置");
    expect(source).toContain("支持的常用工具");
    expect(source).toContain("网页搜索");
    expect(source).toContain("执行命令");
    expect(source).toContain("MCP");
    expect(source).toContain("支持的模型池");
    expect(source).toContain("默认模型");
    expect(source).toContain("加入模型池");
    expect(source).toContain("supportedModels: externalForm.supportedModels");
    expect(source).toContain("supportedTools: externalForm.supportedTools");
    expect(source).toContain("启动命令预览");
    expect(source).toContain("高级启动参数");
    expect(source).toContain("最大上下文窗口");
    expect(source).toContain("DEFAULT_CONTEXT_WINDOW_TOKENS");
    expect(source).toContain("DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000");
    expect(source).toContain("align-items:start;gap:9px;margin-top:14px");
    expect(source).toContain(".pmtm-input,.pmtm-select{height:34px");
    expect(source).toContain("恢复推荐配置");
    expect(source).toContain("pmtm-runtime-form-actions");
    expect(source).not.toContain("参数格式有效");
    expect(source).not.toContain("平台托管参数");
    expect(source).not.toContain("status: externalForm.active");
    expect(source).not.toContain("value: externalForm.active");
    expect(source).not.toContain("添加参数");
    expect(source).not.toContain("固定参数（每个 argv token 单独一行）");
    expect(source).toContain("pmtm-profile-head-actions");
    expect(source).toContain(".pmtm-instance-exec .pmtm-select{height:34px");
    expect(source).toContain('className: "pmtm-meta secondary"');
    expect(source).toContain('ROLE_PLACEHOLDER = "角色待定"');
    expect(source).toContain("result.pausedTeammateIds?.length");
    expect(source).toContain("个绑定的 AI伙伴已暂停");
    expect(source).toContain("const openDefinitionForTeammate = (teammate)");
    expect(source).toContain(
      "onClick: () => openDefinitionForTeammate(teammate)",
    );
  });

  it("converts runtime args to structured readable configuration", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    const parsed = test?.parseExternalRuntimeArgs("workbuddy", [
      "/tmp/workbuddy.mjs",
      "--print",
      "--model",
      "hy4",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "8",
      "--output-format",
      "text",
      "--include-directory",
      "docs",
      "extra-token",
    ]);
    expect(parsed).toMatchObject({
      modelMode: "custom",
      model: "hy4",
      permissionMode: "acceptEdits",
      maxTurns: "8",
      ignoredOutputFormat: true,
    });
    expect(parsed?.advancedArgs).toMatchObject([
      { kind: "positional", value: "/tmp/workbuddy.mjs" },
      { kind: "keyValue", name: "--include-directory", value: "docs" },
      { kind: "positional", value: "extra-token" },
    ]);
    const compiled = test?.compileExternalRuntimeArgs({
      provider: "workbuddy",
      modelMode: "custom",
      model: "hy4",
      supportedModels: ["hy4"],
      defaultModel: "hy4",
      supportedTools: ["web_search"],
      searchEnabled: true,
      permissionMode: "acceptEdits",
      maxTurns: "8",
      advancedArgs: parsed?.advancedArgs ?? [],
    });
    expect(compiled).toEqual([
      "/tmp/workbuddy.mjs",
      "--include-directory",
      "docs",
      "extra-token",
      "--model",
      "hy4",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "8",
    ]);
    expect(
      test?.runtimeConfigurationLabels({
        provider: "workbuddy",
        args: compiled ?? [],
        supportedModels: ["hy4"],
        defaultModel: "hy4",
        supportedTools: ["web_search"],
        contextWindowTokens: 128_000,
      }),
    ).toEqual([
      "模型池：1 个",
      "默认模型：hy4",
      "工具：网页搜索",
      "上下文窗口：128K token",
      "权限：自动接受文件修改",
      "回合上限：8",
      "额外参数：3 项",
    ]);
  });

  it("validates structured runtime configuration before save", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    expect(
      test?.externalRuntimeFormError({
        provider: "codex",
        modelMode: "custom",
        model: "",
        supportedModels: ["gpt-5"],
        defaultModel: "gpt-5.2-codex",
        maxTurns: "",
        advancedArgs: [],
      }),
    ).toContain("默认模型必须来自模型池");
    expect(
      test?.externalRuntimeFormError({
        provider: "workbuddy",
        modelMode: "default",
        model: "",
        maxTurns: "1.5",
        advancedArgs: [],
      }),
    ).toContain("1 到 100");
    expect(
      test?.externalRuntimeFormError({
        provider: "command",
        modelMode: "default",
        model: "",
        maxTurns: "",
        customArgsText: "docs | report",
      }),
    ).toContain("不支持 shell 操作符");
    expect(
      test?.externalRuntimeFormError({
        provider: "workbuddy",
        modelMode: "default",
        model: "",
        maxTurns: "",
        customArgsText: "--effort high",
      }),
    ).toContain("推理强度请在任务执行时选择");
    expect(
      test?.externalRuntimeFormError({
        provider: "workbuddy",
        modelMode: "default",
        model: "",
        maxTurns: "",
        customArgsText: "--print",
      }),
    ).toContain("由平台托管");
    expect(
      test?.externalRuntimeFormError({
        provider: "codex",
        modelMode: "default",
        model: "",
        maxTurns: "",
        contextWindowTokens: "999",
        customArgsText: "",
      }),
    ).toContain("最大上下文窗口");
  });

  it("parses pasted extra argv and generates an executable preview", () => {
    const exported = loadClientExports();
    const test = exported.__test;
    const parsed = test?.parseExternalArgsText(
      '--add-dir "./docs and specs" --verbose',
    );
    expect(parsed).toEqual({
      args: ["--add-dir", "./docs and specs", "--verbose"],
      error: "",
    });
    expect(test?.formatExternalArgsText(parsed?.args ?? [])).toBe(
      '--add-dir "./docs and specs" --verbose',
    );
    const form = {
      provider: "workbuddy",
      protocol: "plain-text",
      command: "codebuddy",
      modelMode: "default",
      model: "",
      supportedModels: ["hy3"],
      defaultModel: "hy3",
      supportedTools: ["web_search"],
      customArgsText: '--add-dir "./docs and specs"',
      searchEnabled: false,
      permissionMode: "default",
      maxTurns: "6",
    };
    expect(test?.externalCommandPreview(form)).toBe(
      'codebuddy --add-dir "./docs and specs" --model hy3 --max-turns 6 --print --output-format stream-json',
    );
    expect(
      test?.externalCommandPreview({
        ...form,
        customArgsText: "--effort high",
      }),
    ).toBe(
      "codebuddy --model hy3 --max-turns 6 --print --output-format stream-json",
    );
  });

  it("archives external runtimes through the shared archive view", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("/api/collab/agent/external-runtimes/archive");
    expect(source).toContain("/api/collab/agent/external-runtimes/restore");
    expect(source).toContain("includeArchived=1");
    expect(source).toMatch(
      /externalArchivedOnly\s*\?\s*runtimeGroups\.archived\s*:\s*runtimeGroups\.defaultView/,
    );
  });

  it("requires an explicit action to create or save", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    // 输入框不再用回车隐式提交：中文输入法确认候选词时按 Enter 会误触发。
    expect(source).not.toContain('event.key === "Enter"');
  });

  it("creates a task inside the assign dialog for the selected teammate", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain('"/api/collab/tasks/create"');
    expect(source).toContain("新建任务并安排给");
    expect(source).toContain("创建并派发");
    expect(source).toContain("receiverId: selected.id");
  });
});
