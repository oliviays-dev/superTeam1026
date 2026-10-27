import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
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
    .poll(async () =>
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

function executionPolicy() {
  return {
    schemaVersion: 1,
    runtime: {
      selection: "recommended",
      allowedRuntimeIds: ["builtin:fake"],
      requiredCapabilities: [],
    },
    sourcePolicy: {
      allow: ["workspace", "task-attachments", "project-memory"],
      deny: ["private-local-data"],
      citation: "none",
      requirePublishedAt: false,
      requireAccessedAt: false,
    },
    toolPolicy: {
      allow: [],
      deny: [],
      requireApproval: [],
    },
    evidence: {
      requirePlan: true,
      requireToolEvents: false,
      requireCitations: false,
      requireStructuredSubagents: false,
    },
    humanGates: [
      {
        id: "playwright-blocking-gate",
        kind: "preflight",
        enforcement: "blocking",
        reason: "Playwright approval before process dispatch",
      },
    ],
    budget: { timeoutMs: 30_000, maxTurns: 2 },
  };
}

test("blocking Action Ticket Gate waits, resumes and completes across viewports", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const project = await api(page, "POST", "/projects", {
      name: `Action Gate E2E ${stamp}`,
      description: "Playwright Action Ticket and Execution Gate",
    });
    expect(project.status).toBe(201);
    const task = await api(page, "POST", "/tasks", {
      projectId: project.body.id,
      title: `Gate task ${stamp}`,
      description: "Wait for a blocking Gate before Runtime dispatch.",
    });
    expect(task.status).toBe(201);
    const policy = await api(
      page,
      "PUT",
      `/tasks/${task.body.id}/execution-policy`,
      { expectedRevision: 0, policy: executionPolicy() },
    );
    expect(policy.status).toBe(200);
    const dispatch = await api(
      page,
      "POST",
      `/tasks/${task.body.id}/dispatch`,
    );
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
    const runStatus = page.locator(".run-header .status-pill");
    await expect(runStatus).toHaveText("待审批");
    await expect(page.getByText("Action Ticket", { exact: true })).toBeVisible();

    await page.getByLabel("Gate decision basis").fill(
      "Playwright verified ticket scope and policy revision",
    );
    await page.getByRole("button", { name: "批准", exact: true }).click();
    await expect(page.getByText("approved", { exact: true })).toBeVisible();
    await expect(runStatus).toHaveText("已完成", {
      timeout: 30_000,
    });

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.getByText("Action Ticket", { exact: true })).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                window.innerWidth + 1,
            ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch15b-action-gate-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
