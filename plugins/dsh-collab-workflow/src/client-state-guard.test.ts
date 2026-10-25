import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(import.meta.dirname, "../client/index.js");

/**
 * 客户端 bundle 没有类型检查兜底：调用一个不存在的 state setter 会让整个
 * slot 在渲染期抛 ReferenceError，页面直接空白。这里用静态扫描挡住这一类
 * 低级错误（本轮工作流跳转空白即由 `setStatusFilter` 拼写错误引起）。
 */
const ALLOWED_EXTERNAL_SETTERS = new Set([
  "setTimeout",
  "setInterval",
  "setRoute",
  "setState",
  "setValue",
]);

function declaredSetterNames(source: string): Set<string> {
  const declared = new Set<string>();
  const patterns = [
    /const\s*\[\s*[A-Za-z0-9_$]+\s*,\s*([A-Za-z0-9_$]+)\s*\]\s*=\s*react\.use(?:State|Reducer)/g,
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g,
    /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) declared.add(match[1]);
    }
  }
  return declared;
}

function calledSetterNames(source: string): Set<string> {
  const called = new Set<string>();
  for (const match of source.matchAll(
    /(?<![A-Za-z0-9_$.])set[A-Z][A-Za-z0-9_$]*\s*\(/g,
  )) {
    called.add(match[0].replace(/\s*\($/, ""));
  }
  return called;
}

describe("workflow client state setters", () => {
  it("only calls declared or external state setters", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const declared = declaredSetterNames(source);
    const missing = [...calledSetterNames(source)].filter(
      (name) => !declared.has(name) && !ALLOWED_EXTERNAL_SETTERS.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("opens shared template management with the currently selected project", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    expect(source).toContain("currentWorkspaceId: workspaceId");
    expect(source).toContain(
      "workspaceOptions.some((item) => item.id === currentWorkspaceId)",
    );
  });

  it("clears account-scoped workflow detail when the login token changes", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("const synchronize = () => {");
    const end = source.indexOf(
      'window.addEventListener("pluginmax:collab-token", synchronize)',
      start,
    );
    const synchronize = source.slice(start, end);
    expect(synchronize).toContain("setTokenVersion");
    expect(synchronize).toContain("setDetail(null)");
    expect(synchronize).toContain('setOpenId("")');
    expect(synchronize).toContain('setBusy("")');
  });

  it("keeps overview node selection and delivery as sibling controls", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("function WorkflowFlowOverview(");
    const end = source.indexOf("function Feedback(", start);
    const overview = source.slice(start, end);

    expect(overview).toContain('className: "pmwf-overview-select"');
    expect(overview).toContain('className: "pmwf-overview-delivery"');
    expect(overview).not.toContain('role: "button"');
  });

  it("reserves a mobile header row for the workflow breadcrumb controls", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");

    expect(source).toContain("pmwf-crumb-root");
    expect(source).toContain(
      ".pmwf-detail-head{display:grid;grid-template-columns:minmax(0,1fr) auto",
    );
    expect(source).toContain(".pmwf-detail-title{grid-column:1/-1");
  });

  it("does not show the redundant template-preview badge in subflow cards", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("const subflowTemplatePreview =");
    const end = source.indexOf("const currentOwnerIds =", start);
    const subflow = source.slice(start, end);

    expect(subflow).not.toContain('children: "模板预览"');
    expect(subflow).toContain('" 个节点"');
  });

  it("uses the instance project for Agent run actions from the all-projects view", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("? AgentRunPanel({");
    const end = source.indexOf(": null", start);
    const panel = source.slice(start, end);

    expect(panel).toContain("instance.workspaceId");
    expect(panel).not.toContain("effectiveWorkspaceId");
  });

  it("returns to the workflow list when the workflow menu is selected again", () => {
    const source = readFileSync(CLIENT_PATH, "utf8");
    const start = source.indexOf("const returnToRoot =");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("], []);", start);
    const listener = source.slice(start, end);

    expect(listener).toContain('event?.detail?.route !== "workflow"');
    expect(listener).toContain('setOpenId("")');
    expect(listener).toContain("setDetail(null)");
    expect(listener).toContain("setTemplateMode(false)");
    expect(listener).toContain("setStartOpen(false)");
  });
});
