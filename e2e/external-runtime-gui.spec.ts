import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const fixturePath = resolve(
  process.cwd(),
  "packages/agent-runtime/test-fixtures/external-cli.mjs",
);

interface Agent {
  readonly id: string;
  readonly name: string;
}

interface Project {
  readonly id: string;
  readonly name: string;
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
}

interface Runtime {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly status: string;
  readonly lastProbe: {
    readonly status: string;
    readonly runtimeRevision: number;
  } | null;
}

interface Run {
  readonly id: string;
  readonly status: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & {
    readonly message?: string;
  };
  if (!response.ok()) {
    throw new Error(
      `HTTP ${response.status()} ${body.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

async function post<T>(
  request: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<T> {
  return json<T>(await request.post(path, data === undefined ? {} : { data }));
}

async function put<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
): Promise<T> {
  return json<T>(await request.put(path, { data }));
}

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  return json<T>(await request.get(path));
}

async function createAgent(
  request: APIRequestContext,
  runtimeKind: "plain-text" | "codex-jsonl",
  stamp: number,
): Promise<Agent> {
  return post<Agent>(request, "/api/v1/agents", {
    name: `Batch 13E ${runtimeKind} agent ${stamp}`,
    description: "External runtime GUI fixture",
    soul: "Return the fixture result.",
    scenarios: [],
    goals: [],
    tools: [],
    runtimeKind,
    source: "personal",
  });
}

async function waitForProbe(
  request: APIRequestContext,
  runtimeId: string,
): Promise<"passed" | "failed"> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await get<{
      readonly runtime: Runtime;
      readonly latestProbe: Runtime["lastProbe"];
    }>(request, `/api/v1/runtimes/${runtimeId}`);
    const status = detail.latestProbe?.status;
    if (status === "passed" || status === "failed") return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Probe did not finish for runtime ${runtimeId}`);
}

async function createRuntime(
  request: APIRequestContext,
  input: {
    readonly name: string;
    readonly protocol: "plain-text" | "codex-jsonl";
    readonly scenario: string;
    readonly command?: string;
  },
): Promise<Runtime> {
  const created = await post<Runtime>(request, "/api/v1/runtimes", {
    name: input.name,
    provider: input.protocol === "codex-jsonl" ? "codex" : "command",
    protocol: input.protocol,
    command: input.command ?? process.execPath,
    managedArgs: input.command === undefined ? [fixturePath] : [],
    customArgs:
      input.command === undefined
        ? [input.protocol === "codex-jsonl" ? "codex" : "plain", input.scenario]
        : [],
    supportedModels: input.protocol === "codex-jsonl" ? ["gpt-fixture"] : [],
    defaultModel: input.protocol === "codex-jsonl" ? "gpt-fixture" : null,
    contextWindowTokens: null,
    supportedTools:
      input.protocol === "codex-jsonl"
        ? ["structured_plan", "structured_tool_events"]
        : [],
    networkMode: "restricted",
    sandboxMode: "read-only",
    visibility: "owner",
  });
  await post(request, `/api/v1/runtimes/${created.id}/probe`, {
    expectedRevision: created.revision,
  });
  const probeStatus = await waitForProbe(request, created.id);
  if (probeStatus === "failed") {
    return (
      await get<{ runtime: Runtime }>(request, `/api/v1/runtimes/${created.id}`)
    ).runtime;
  }
  return post<Runtime>(request, `/api/v1/runtimes/${created.id}/enable`, {
    expectedRevision: created.revision,
  });
}

async function bindRuntime(
  request: APIRequestContext,
  agentId: string,
  runtimeId: string,
): Promise<void> {
  await put(request, `/api/v1/agents/${agentId}/runtime-binding`, {
    runtimeId,
    expectedRevision: 0,
  });
}

async function createTaskFixture(
  request: APIRequestContext,
  agentId: string,
  label: string,
): Promise<{ readonly project: Project; readonly task: Task }> {
  const project = await post<Project>(request, "/api/v1/projects", {
    name: `Batch 13E ${label} ${Date.now()}`,
    description: "External runtime Run observability",
  });
  const task = await post<Task>(request, "/api/v1/tasks", {
    projectId: project.id,
    title: `Batch 13E ${label} task`,
    description: "Execute the repository external CLI fixture.",
    acceptance: ["Fixture output is visible"],
    agentId,
  });
  return { project, task };
}

async function dispatchAndWait(
  request: APIRequestContext,
  taskId: string,
): Promise<Run> {
  const dispatched = await post<{ readonly runId: string }>(
    request,
    `/api/v1/tasks/${taskId}/dispatch`,
  );
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const detail = await get<{ readonly run: Run }>(
      request,
      `/api/v1/runs/${dispatched.runId}`,
    );
    if (
      ["completed", "failed", "cancelled", "timeout", "interrupted"].includes(
        detail.run.status,
      )
    ) {
      expect(detail.run.status).toBe("completed");
      return detail.run;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Run did not finish for task ${taskId}`);
}

async function openTask(
  page: Page,
  project: Project,
  task: Task,
): Promise<void> {
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "任务项目" })
    .selectOption(project.id);
  await page
    .locator(".task-board-card")
    .filter({ hasText: task.title })
    .click();
  await expect(page.getByRole("region", { name: "任务详情" })).toBeVisible();
}

async function expectNoStageOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
}

test.describe("external runtime GUI", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("binds a probed runtime, runs Preflight and explains every unavailable state", async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const agent = await createAgent(request, "plain-text", stamp);
    const runtime = await createRuntime(request, {
      name: `Batch 13E binding runtime ${stamp}`,
      protocol: "plain-text",
      scenario: "success",
    });
    const failedRuntime = await createRuntime(request, {
      name: `Batch 13E failed probe ${stamp}`,
      protocol: "plain-text",
      scenario: "probe-failed",
      command: `/missing-pluginmax-probe-${randomUUID()}`,
    });
    expect(failedRuntime.lastProbe?.status).toBe("failed");

    await page.goto("/");
    await page.getByRole("button", { name: "AI伙伴", exact: true }).click();
    await page
      .locator(".agent-list-row")
      .filter({ hasText: agent.name })
      .click();
    const bindingPanel = page.getByLabel("AI 伙伴外部 Runtime");
    await expect(bindingPanel).toContainText("未绑定");
    await expect(bindingPanel).toContainText("不代表已有可用 Runtime");

    const runtimeSelect = bindingPanel.getByLabel("外部 Runtime", {
      exact: true,
    });
    await expect(
      runtimeSelect.locator(`option[value="${failedRuntime.id}"]`),
    ).toHaveCount(0);
    await runtimeSelect.selectOption(runtime.id);
    await bindingPanel
      .getByRole("button", { name: "绑定 Runtime", exact: true })
      .click();
    await expect(bindingPanel.locator(".runtime-binding-state")).toHaveText(
      "Active",
    );
    await expect(bindingPanel).toContainText(`r${runtime.revision}`);
    await expect(bindingPanel).toContainText("read-only");
    await expect(bindingPanel).toContainText("restricted");

    await bindingPanel.getByLabel("要求 结构化计划").check();
    await bindingPanel
      .getByRole("button", { name: "运行 Preflight", exact: true })
      .click();
    const preflightFeedback = bindingPanel.getByLabel("Preflight 结果");
    await expect(preflightFeedback).toContainText("runtime_capability_missing");
    await expect(preflightFeedback).toContainText(
      "Select a runtime with the required capabilities",
    );

    await bindingPanel.getByLabel("要求 结构化计划").uncheck();
    await bindingPanel
      .getByRole("button", { name: "运行 Preflight", exact: true })
      .click();
    await expect(preflightFeedback).toContainText("Preflight 通过");
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-agent-binding-${stamp}.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "运行时", exact: true }).click();
    await page
      .locator(".runtime-list-row")
      .filter({ hasText: runtime.name })
      .click();
    await expect(page.getByLabel("运行时状态摘要")).toContainText(
      /1 active \/\s*1 total/,
    );
    await page
      .locator(".runtime-list-row")
      .filter({ hasText: failedRuntime.name })
      .click();
    await expect(page.getByLabel("运行时可用性")).toContainText("Probe 失败");
    await expect(page.getByLabel("运行时可用性")).toContainText(
      "当前不可绑定或派发",
    );
    await page.screenshot({
      path: `.tmp/batch13e-runtime-probe-failed-${stamp}.png`,
      fullPage: true,
    });

    const disabled = await post<Runtime>(
      request,
      `/api/v1/runtimes/${runtime.id}/disable`,
      { expectedRevision: runtime.revision },
    );
    await page.reload();
    await page.getByRole("button", { name: "AI伙伴", exact: true }).click();
    await page
      .locator(".agent-list-row")
      .filter({ hasText: agent.name })
      .click();
    await expect(bindingPanel.locator(".runtime-binding-state")).toHaveText(
      "Disabled",
    );
    await expect(bindingPanel).toContainText("Runtime 已停用");

    const archived = await post<Runtime>(
      request,
      `/api/v1/runtimes/${runtime.id}/archive`,
      { expectedRevision: disabled.revision },
    );
    expect(archived.status).toBe("archived");
    await page.reload();
    await page.getByRole("button", { name: "AI伙伴", exact: true }).click();
    await page
      .locator(".agent-list-row")
      .filter({ hasText: agent.name })
      .click();
    await expect(bindingPanel).toContainText("Runtime 已归档");

    await page.setViewportSize({ width: 900, height: 900 });
    await page.reload();
    await page.getByRole("button", { name: "AI伙伴", exact: true }).click();
    await page
      .locator(".agent-list-row")
      .filter({ hasText: agent.name })
      .click();
    await bindingPanel.scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-agent-binding-900-${stamp}.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByTitle("展开导航").click();
    await page.getByRole("button", { name: "AI伙伴", exact: true }).click();
    await page
      .locator(".agent-list-row")
      .filter({ hasText: agent.name })
      .click();
    await expect(bindingPanel).toContainText("Runtime 已归档");
    await bindingPanel.scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-agent-binding-390-${stamp}.png`,
      fullPage: true,
    });
  });

  test("shows plain-text final-only and codex-jsonl structured Run evidence", async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const plainAgent = await createAgent(request, "plain-text", stamp);
    const plainRuntime = await createRuntime(request, {
      name: `Batch 13E plain Run ${stamp}`,
      protocol: "plain-text",
      scenario: "success",
    });
    await bindRuntime(request, plainAgent.id, plainRuntime.id);
    const plainFixture = await createTaskFixture(
      request,
      plainAgent.id,
      "plain",
    );
    await dispatchAndWait(request, plainFixture.task.id);

    await page.goto("/");
    await openTask(page, plainFixture.project, plainFixture.task);
    const plainRun = page.getByLabel("外部 Runtime 执行");
    await expect(plainRun).toContainText("final-only");
    await expect(plainRun).toContainText("plain-text");
    await expect(plainRun).toContainText("Binding r1");
    await expect(page.locator(".plan-list li")).toHaveCount(0);
    await expect(
      page.locator(".event-timeline").getByText("tool.call", { exact: true }),
    ).toHaveCount(0);
    await plainRun.scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-run-plain-${stamp}.png`,
      fullPage: true,
    });

    const codexAgent = await createAgent(request, "codex-jsonl", stamp);
    const codexRuntime = await createRuntime(request, {
      name: `Batch 13E codex Run ${stamp}`,
      protocol: "codex-jsonl",
      scenario: "success",
    });
    await bindRuntime(request, codexAgent.id, codexRuntime.id);
    const codexFixture = await createTaskFixture(
      request,
      codexAgent.id,
      "codex",
    );
    await dispatchAndWait(request, codexFixture.task.id);

    await page.reload();
    await openTask(page, codexFixture.project, codexFixture.task);
    const codexRun = page.getByLabel("外部 Runtime 执行");
    await expect(codexRun).toContainText("structured");
    await expect(codexRun).toContainText("codex-session-fixture");
    await expect(codexRun).toContainText("9.8.7-fixture");
    await expect(codexRun).toContainText("Binding r1");
    await expect(page.locator(".event-timeline")).toContainText(
      "progress.summary",
    );
    await expect(page.locator(".event-timeline")).toContainText("tool.call");
    await expect(page.locator("body")).not.toContainText(
      "PRIVATE_REASONING_MUST_NOT_LEAK",
    );
    await codexRun.scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-run-codex-${stamp}.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 900, height: 900 });
    await page.reload();
    await openTask(page, codexFixture.project, codexFixture.task);
    await codexRun.scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-run-codex-900-${stamp}.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByTitle("展开导航").click();
    await openTask(page, codexFixture.project, codexFixture.task);
    await expect(page.getByLabel("外部 Runtime 执行")).toContainText(
      "codex-session-fixture",
    );
    await page.getByLabel("外部 Runtime 执行").scrollIntoViewIfNeeded();
    await expectNoStageOverflow(page);
    await page.screenshot({
      path: `.tmp/batch13e-run-codex-390-${stamp}.png`,
      fullPage: true,
    });
  });
});
