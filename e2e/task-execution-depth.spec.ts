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

test("Task execution depth controls, documents, Session reset, and responsive layout", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const agent = await api(page, "POST", "/agents", {
      name: `Batch17A E2E Agent ${stamp}`,
      description: "Fake runtime for task execution depth",
      runtimeKind: "fake",
    });
    expect(agent.status).toBe(201);
    const project = await api(page, "POST", "/projects", {
      name: `Batch17A E2E ${stamp}`,
      description: "Task execution depth browser fixture",
    });
    expect(project.status).toBe(201);
    const member = await api(
      page,
      "POST",
      `/projects/${project.body.id as string}/members`,
      {
        kind: "agent",
        agentId: agent.body.id,
        responsibility: "Execution depth",
        roleIds: [],
      },
    );
    expect(member.status).toBe(201);
    const task = await api(page, "POST", "/tasks", {
      projectId: project.body.id,
      title: `Batch17A execution task ${stamp}`,
      description:
        "Exercise pause, input, document, Review, and Session reset.",
      acceptance: ["Produce a deterministic result"],
      agentId: agent.body.id,
      priority: "urgent",
      autoSubmit: true,
    });
    expect(task.status).toBe(201);

    await page.reload();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await page
      .getByRole("combobox", { name: "任务项目" })
      .selectOption(project.body.id as string);
    const card = page
      .locator(".task-board-card")
      .filter({ hasText: task.body.title as string });
    await expect(card).toContainText("紧急优先级");
    await card.click();

    const detail = page.getByRole("region", { name: "任务详情" });
    await expect(detail.locator(".task-detail-meta")).toContainText(
      "紧急优先级",
    );
    await detail.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(detail.locator(".task-detail-meta")).toContainText("已暂停");
    await detail.getByRole("button", { name: "恢复任务" }).click();
    await expect(detail.locator(".task-detail-meta")).toContainText("待处理");

    await detail
      .getByPlaceholder("暂停、阻断或补充输入说明")
      .fill("Confirm the target account segment");
    await detail.getByRole("button", { name: "等待输入" }).click();
    await expect(detail.locator(".task-detail-meta")).toContainText(
      "待补充输入",
    );
    await detail
      .getByPlaceholder("补充任务输入")
      .fill("The enterprise segment is approved");
    await detail.getByRole("button", { name: "补充并恢复" }).click();
    await expect(detail.locator(".task-detail-meta")).toContainText("待处理");

    await detail.locator('input[type="file"]').setInputFiles({
      name: "batch17a-evidence.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Batch 17A evidence", "utf8"),
    });
    const attachment = detail
      .locator(".task-attachment-row")
      .filter({ hasText: "batch17a-evidence.md" });
    await expect(attachment).toContainText(`documents/`);
    await attachment.getByRole("button", { name: "显示文档位置" }).click();
    await attachment.getByRole("button", { name: "归档附件" }).click();
    await expect(
      attachment.getByRole("button", { name: "复原附件" }),
    ).toBeVisible();
    await attachment.getByRole("button", { name: "复原附件" }).click();

    await detail.getByRole("button", { name: "派发执行" }).click();
    await expect(detail.locator(".task-detail-meta")).toContainText("待验收", {
      timeout: 30_000,
    });
    await detail.getByRole("button", { name: "重置任务 Session" }).click();
    await expect(detail).toContainText("generation 1");

    const runResponse = await api(
      page,
      "GET",
      `/tasks/${task.body.id as string}/runs`,
    );
    expect(runResponse.status).toBe(200);
    const runs = runResponse.body.items as Array<{ id: string }>;
    const scene = await api(page, "GET", `/runs/${runs[0]!.id}/scene-context`);
    expect(scene.status).toBe(200);
    expect(
      (scene.body.scene as { binding: { generation: number } }).binding
        .generation,
    ).toBe(0);

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(detail).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch17a-task-depth-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
