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

test("AI Teammate template versions, work queue, lifecycle and reporting", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const project = await api(page, "POST", "/projects", {
      name: `Batch17B Teammate ${stamp}`,
      description: "AI Teammate browser fixture",
    });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;
    const agent = await api(page, "POST", "/agents", {
      name: `Batch17B Agent ${stamp}`,
      description: "Fake execution identity",
      runtimeKind: "fake",
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.id as string;
    const role = await api(page, "POST", `/projects/${projectId}/roles`, {
      name: `Teammate Writer ${stamp}`,
      permissions: ["read", "write"],
    });
    expect(role.status).toBe(201);
    const roleId = role.body.id as string;
    const agentMember = await api(
      page,
      "POST",
      `/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "AI Teammate execution",
        roleIds: [roleId],
      },
    );
    expect(agentMember.status).toBe(201);
    const template = await api(page, "POST", "/teammate-templates", {
      projectId,
      scope: "personal",
      definition: {
        name: `Research partner ${stamp}`,
        role: "Researcher",
        description: "Evidence-first research",
        soul: "Use verified evidence.",
        scenarios: ["Research"],
        goals: ["Traceable output"],
        tools: ["search"],
      },
    });
    expect(template.status).toBe(201);
    const teammate = await api(page, "POST", "/teammates", {
      projectId,
      templateId: template.body.id,
      agentId,
      name: `Researcher ${stamp}`,
      autoExecute: false,
    });
    expect(teammate.status).toBe(201);

    await page.reload();
    await page
      .getByRole("button", { name: "AI Teammate", exact: true })
      .click();
    const workspace = page.getByRole("main", { name: "AI Teammate 工作台" });
    await expect(workspace).toBeVisible();
    await page
      .getByRole("combobox", { name: "AI Teammate 项目" })
      .selectOption(projectId);
    await expect(workspace).toContainText("Research partner");
    await expect(workspace).toContainText(`Researcher ${stamp}`);

    await workspace
      .getByRole("textbox", { name: "工作计划指令" })
      .fill("明天 P1 整理竞品证据\nP2 输出对比表");
    await workspace.getByRole("button", { name: "解析" }).click();
    await expect(workspace).toContainText("整理竞品证据");
    await workspace.getByRole("button", { name: "生成任务" }).click();
    await expect(
      workspace.getByRole("region", { name: "Teammate 工作队列" }),
    ).toContainText("输出对比表");

    await workspace
      .getByRole("checkbox", { name: "自动执行", exact: true })
      .click();
    await expect
      .poll(() =>
        workspace
          .getByRole("checkbox", { name: "自动执行", exact: true })
          .isChecked(),
      )
      .toBe(true);
    await workspace.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(workspace).toContainText("恢复");
    await workspace.getByRole("button", { name: "恢复" }).click();

    await workspace
      .getByRole("region", { name: "AI Teammate 治理" })
      .getByRole("button", { name: "生成" })
      .click();
    await expect(workspace).toContainText("周报");
    await expect(workspace).toContainText("report");

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(workspace).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch17b-ai-teammate-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
