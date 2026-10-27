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

test("Scene Context receipt and deterministic replay stay isolated across viewports", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const project = await api(page, "POST", "/projects", {
      name: `Scene Context E2E ${stamp}`,
      description: "Playwright Scene Context and receipt replay",
    });
    expect(project.status).toBe(201);
    const task = await api(page, "POST", "/tasks", {
      projectId: project.body.id,
      title: `Scene task ${stamp}`,
      description: "Exercise Scene Context in the browser.",
      acceptance: ["Show a deterministic receipt"],
    });
    expect(task.status).toBe(201);
    const consensus = await api(
      page,
      "POST",
      `/tasks/${task.body.id}/messages`,
      {
        content: "Browser-approved consensus stays inside this task Scene.",
        isKeyConsensus: true,
      },
    );
    expect(consensus.status).toBe(201);
    const dispatch = await api(page, "POST", `/tasks/${task.body.id}/dispatch`);
    expect(dispatch.status).toBe(202);

    await page.reload();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await page
      .getByRole("combobox", { name: "任务项目" })
      .selectOption(project.body.id as string);
    await page
      .locator(".task-board-card")
      .filter({ hasText: task.body.title as string })
      .click();

    await expect(page.locator(".run-header .status-pill")).toHaveText(
      "已完成",
      { timeout: 30_000 },
    );
    await expect(
      page.getByText("Scene Context", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".scene-context-grid")).toContainText("task");
    await expect(page.locator(".scene-contribution")).toContainText(
      "Browser-approved consensus stays inside this task Scene.",
    );
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await expect(
      page.getByText("deterministic", { exact: true }),
    ).toBeVisible();

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(
        page.getByText("Scene Context", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch16-scene-context-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
