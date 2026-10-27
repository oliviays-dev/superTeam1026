import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface AccountFixture {
  readonly loginId: string;
}

interface Fixture {
  readonly password: string;
  readonly owner: AccountFixture;
}

interface BrowserResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(process.env.RBAC_E2E_FIXTURE_PATH!, "utf8"),
) as Fixture;

async function login(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("登录 ID").fill(fixture.owner.loginId);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("pluginmax.auth.token")),
    )
    .not.toBeNull();
  return page;
}

async function api(
  page: Page,
  method: string,
  path: string,
  payload?: unknown,
): Promise<BrowserResponse> {
  return page.evaluate(
    async ({ method: requestMethod, path: requestPath, payload: body }) => {
      const token = sessionStorage.getItem("pluginmax.auth.token");
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >,
      };
    },
    { method, path, payload },
  );
}

test("Runtime visibility economics and Run settlement across responsive layouts", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const project = await api(page, "POST", "/projects", {
      name: `Batch13.1B E2E ${stamp}`,
      description: "Runtime economics browser fixture",
    });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;
    const agent = await api(page, "POST", "/agents", {
      name: `Batch13.1B Agent ${stamp}`,
      description: "Fake runtime for economics",
      runtimeKind: "fake",
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.id as string;
    const member = await api(page, "POST", `/projects/${projectId}/members`, {
      kind: "agent",
      agentId,
      responsibility: "Economics execution",
      roleIds: [],
    });
    expect(member.status).toBe(201);
    const runtime = await api(page, "POST", "/runtimes", {
      name: `Workspace Runtime ${stamp}`,
      provider: "command",
      protocol: "plain-text",
      command: "runtime-economics-fixture",
      managedArgs: [],
      customArgs: [],
      supportedModels: [],
      defaultModel: null,
      contextWindowTokens: null,
      supportedTools: [],
      networkMode: "unknown",
      sandboxMode: "read-only",
      visibility: "workspace",
      workspaceId: projectId,
    });
    expect(runtime.status).toBe(201);

    const task = await api(page, "POST", "/tasks", {
      projectId,
      title: `Batch13.1B economics task ${stamp}`,
      description: "Capture unknown usage and duration phases.",
      acceptance: ["Expose deterministic economics"],
      agentId,
    });
    expect(task.status).toBe(201);
    const taskId = task.body.id as string;
    const dispatched = await api(page, "POST", `/tasks/${taskId}/dispatch`);
    expect(dispatched.status).toBe(202);
    const runId = dispatched.body.runId as string;
    await expect
      .poll(
        async () => {
          const detail = await api(page, "GET", `/runs/${runId}`);
          return (detail.body.run as { status?: string } | undefined)?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("completed");

    await page.reload();
    await page.getByRole("button", { name: "运行时", exact: true }).click();
    const economics = page.getByRole("region", {
      name: "Runtime 经济与可见性",
    });
    await expect(economics).toBeVisible();
    await expect(economics).toContainText("Token");
    await expect(economics).toContainText("unknown");
    await expect(
      page.getByRole("heading", { name: runtime.body.name as string }),
    ).toBeVisible();

    await page.getByRole("button", { name: "任务", exact: true }).click();
    await page
      .getByRole("combobox", { name: "任务项目" })
      .selectOption(projectId);
    await page
      .locator(".task-board-card")
      .filter({ hasText: task.body.title as string })
      .click();
    const runEconomics = page.getByRole("region", {
      name: "Run 经济统计",
    });
    await expect(runEconomics).toBeVisible();
    await expect(runEconomics).toContainText("执行经济与结算");
    await expect(runEconomics).toContainText("unknown");
    await expect(runEconomics).toContainText("Claim");

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(runEconomics).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch13.1b-runtime-economics-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
