import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface AccountFixture {
  readonly principalId: string;
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

test("meeting collaboration governance, private briefings, files, minutes, tasks and archive", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  try {
    const page = await login(context);
    const stamp = Date.now();
    const project = await api(page, "POST", "/projects", {
      name: `Batch18 Meeting ${stamp}`,
      description: "Meeting collaboration browser fixture",
    });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;
    const agent = await api(page, "POST", "/agents", {
      name: `Meeting Delegate Agent ${stamp}`,
      description: "AI delegate execution identity",
      runtimeKind: "fake",
    });
    expect(agent.status).toBe(201);
    const agentId = agent.body.id as string;
    const role = await api(page, "POST", `/projects/${projectId}/roles`, {
      name: `Meeting Reader ${stamp}`,
      permissions: ["read", "write"],
    });
    expect(role.status).toBe(201);
    const member = await api(page, "POST", `/projects/${projectId}/members`, {
      kind: "agent",
      agentId,
      responsibility: "Represent meeting participants",
      roleIds: [role.body.id],
    });
    expect(member.status).toBe(201);
    const meeting = await api(page, "POST", "/meetings", {
      projectId,
      title: `Collaboration meeting ${stamp}`,
      agenda: "Confirm collaboration and delivery boundaries",
      agentIds: [agentId],
    });
    expect(meeting.status).toBe(201);
    const meetingId = meeting.body.id as string;
    const source = await api(page, "POST", `/meetings/${meetingId}/messages`, {
      content: "Decision: deliver the meeting collaboration workflow.",
      clientMessageId: "meeting-collaboration-e2e-source",
    });
    expect(source.status).toBe(201);

    await page.reload();
    await page.getByRole("button", { name: "沟通", exact: true }).click();
    await page
      .getByRole("combobox", { name: "会议项目" })
      .selectOption(projectId);
    await page
      .locator(".meeting-row")
      .filter({ hasText: `Collaboration meeting ${stamp}` })
      .click();
    await page.getByRole("tab", { name: "协作", exact: true }).click();

    const panel = page.getByTestId("meeting-collaboration");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("owner E2E Principal");

    await panel.getByLabel("代表类型").selectOption("agent");
    await panel
      .getByLabel("AI 代表")
      .selectOption({ label: `Meeting Delegate Agent ${stamp}` });
    await panel
      .getByLabel("委托原因")
      .fill("AI represents the owner in this meeting");
    await panel.getByRole("button", { name: "授权代表" }).click();
    await expect(panel).toContainText(`Meeting Delegate Agent ${stamp}`);

    await panel
      .getByLabel("私密嘱咐")
      .fill("Private constraint for the delegated participant only.");
    await panel.getByRole("button", { name: "保存嘱咐" }).click();
    await expect(panel).toContainText(
      "Private constraint for the delegated participant only.",
    );

    await panel.getByLabel("上传会议文件").setInputFiles({
      name: "meeting-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Batch 18 meeting file"),
    });
    await expect(panel).toContainText("meeting-notes.txt");

    await panel.getByRole("button", { name: "从消息生成草稿" }).click();
    await expect(
      panel.getByRole("button", { name: "确认并发布纪要" }),
    ).toBeEnabled();
    await panel.getByLabel("确认说明").fill("Browser confirmed minutes");
    await panel.getByRole("button", { name: "确认并发布纪要" }).click();
    await expect(panel).toContainText(`${fixture.owner.principalId} 已确认`);

    await panel.getByLabel("会议任务标题").fill("Follow up meeting decision");
    await panel
      .getByLabel("会议任务执行 AI")
      .selectOption({ label: `Meeting Delegate Agent ${stamp}` });
    await panel.getByRole("button", { name: "创建任务" }).click();
    await expect(panel).toContainText("Follow up meeting decision");

    await panel.getByLabel("归档原因").fill("Browser archive check");
    await panel.getByRole("button", { name: "归档会议" }).click();
    await expect(panel).toContainText("已归档");
    const blocked = await api(page, "POST", `/meetings/${meetingId}/messages`, {
      content: "This must fail while archived",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("meeting_archived");
    await panel.getByRole("button", { name: "恢复会议" }).click();
    await expect(panel).toContainText("协作中");
    await expect(panel).not.toContainText("Internal error");

    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(panel).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: `.tmp/batch18-meeting-collaboration-${viewport.width}-${stamp}.png`,
        fullPage: true,
      });
    }
  } finally {
    await context.close();
  }
});
