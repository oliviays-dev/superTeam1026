import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

interface Fixture {
  readonly password?: string;
  readonly admin?: {
    readonly loginId: string;
  };
  readonly owner: {
    readonly loginId: string;
  };
}

const fixturePath = process.env.RBAC_E2E_FIXTURE_PATH;
const fixture =
  fixturePath === undefined
    ? undefined
    : (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture);
const password = process.env.CORE_REGRESSION_PASSWORD ?? fixture?.password;

interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  if (fixture === undefined) return;
  if (password === undefined) throw new Error("CORE_REGRESSION_PASSWORD missing");
  await page.getByLabel("登录 ID").fill(fixture.admin?.loginId ?? fixture.owner.loginId);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(window.sessionStorage.getItem("pluginmax.auth.token")),
      ),
    )
    .toBe(true);
}

async function api<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  actorId?: string,
): Promise<ApiResponse<T>> {
  return page.evaluate(
    async ({ method: requestMethod, path: requestPath, body: requestBody, actorId: actor }) => {
      const token = window.sessionStorage.getItem("pluginmax.auth.token");
      const headers: Record<string, string> = {};
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (requestBody !== undefined) headers["content-type"] = "application/json";
      if (actor !== undefined) headers["x-pluginmax-actor"] = actor;
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        headers,
        ...(requestBody === undefined
          ? {}
          : { body: JSON.stringify(requestBody) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === "" ? null : JSON.parse(text),
      };
    },
    { method, path, body, actorId },
  ) as Promise<ApiResponse<T>>;
}

test("Shared Space file, policy, revision, lock, download, digest and Global Write approval", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await login(page);
  const viewer = await api<{
    principalId: string;
    platformAdministrator: boolean;
  }>(page, "GET", "/viewer");
  expect(viewer.status).toBe(200);
  const principalId = viewer.body.principalId;
  const workspace = await api<{ workspace: { id: string; displayName: string } }>(
    page,
    "POST",
    "/workspaces",
    {
      displayName: `Shared GUI ${Date.now()}`,
    },
  );
  expect(workspace.status).toBe(201);
  const workspaceId = workspace.body.workspace.id;

  await page.getByRole("button", { name: "共享空间" }).click();
  await expect(page.getByRole("heading", { name: "共享空间" })).toBeVisible();
  await page.getByLabel("选择 Workspace").selectOption(workspaceId);
  await expect(page.getByText("默认只读").first()).toBeVisible();

  await page.getByRole("button", { name: "策略", exact: true }).click();
  const policyForm = page.locator(".shared-config-form").first();
  await policyForm.getByLabel("路径模式").fill("research/**");
  await policyForm.getByLabel("write").check();
  await policyForm.getByRole("button", { name: "保存策略" }).click();
  await expect(page.getByText("路径策略已创建")).toBeVisible();

  const previewForm = page.locator(".shared-preview-form");
  await previewForm.getByLabel("Principal").fill(principalId);
  await previewForm.getByLabel("路径").fill("research/brief.md");
  await previewForm.getByRole("button", { name: "预览" }).click();
  await expect(previewForm.getByText("allow policy and Workspace write boundary")).toBeVisible();

  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("textbox", { name: "新目录路径" }).fill("research");
  await page.getByRole("button", { name: "创建目录" }).click();
  await expect(page.getByText("research", { exact: true }).first()).toBeVisible();
  await page.getByText("research", { exact: true }).first().click();

  await page.getByLabel("上传路径").fill("research/brief.md");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "brief.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Brief\nversion one\n"),
  });
  await page.getByRole("button", { name: "上传" }).click();
  await expect(page.getByText("brief.md")).toBeVisible();

  await page.getByText("brief.md").click();
  const editor = page.getByLabel("文件内容");
  await expect(editor).toHaveValue("# Brief\nversion one\n");
  await editor.fill("# Brief\nversion two\n");
  await page.getByRole("button", { name: "保存为 v2" }).click();
  await expect(page.getByText("已保存 v2")).toBeVisible();

  const current = await api<{ id: string; currentVersion: number }>(
    page,
    "GET",
    `/workspaces/${workspaceId}/shared-space/files?path=research`,
  );
  expect(current.status).toBe(200);
  const entry = (
    current.body as unknown as {
      entries: Array<{ id: string; currentVersion: number }>;
    }
  ).entries[0]!;
  const externalUpdate = await api(
    page,
    "PUT",
    `/workspaces/${workspaceId}/shared-space/files/${entry.id}/content`,
    {
      contentBase64: Buffer.from("# Brief\nversion three\n").toString("base64"),
      expectedVersion: entry.currentVersion,
      mimeType: "text/markdown",
      lockId: null,
    },
  );
  expect(externalUpdate.status).toBe(200);
  await page.getByRole("button", { name: /保存为 v/ }).click();
  await expect(page.getByText(/版本冲突/)).toBeVisible();
  await page.getByTitle("关闭预览").click();

  await page.getByTitle("查看版本").click();
  await expect(page.getByRole("heading", { name: "brief.md 版本" })).toBeVisible();
  await expect(page.getByText("v3")).toBeVisible();
  await page.getByTitle("关闭版本").click();

  const lock = await api(page, "POST", `/workspaces/${workspaceId}/shared-space/locks`, {
    path: "research/brief.md",
    mode: "exclusive",
    leaseSeconds: 60,
    sessionId: "browser:playwright",
  });
  expect(lock.status).toBe(201);
  await page.getByRole("button", { name: "刷新共享空间" }).click();
  await expect(page.getByText("locked", { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTitle("下载文件").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("brief.md");

  const globalPath = `reports/global-${Date.now()}.md`;
  const globalRequest = await api<{ request: { id: string } }>(
    page,
    "POST",
    "/shared-space/global-write-requests",
    {
      workspaceId,
      path: globalPath,
      name: "global-summary.md",
      mimeType: "text/markdown",
      contentBase64: Buffer.from("# Global\napproved summary\n").toString("base64"),
      expectedVersion: 0,
      purpose: "Playwright Global Write approval",
      scope: "global",
      lockId: null,
    },
  );
  expect(globalRequest.status).toBe(201);
  await page.getByRole("button", { name: "审批", exact: true }).click();
  const requestRow = page.locator(".shared-request-row", { hasText: globalPath });
  await expect(requestRow).toBeVisible();
  await requestRow.getByRole("button", { name: "批准" }).click();
  await expect(requestRow.getByText("approved")).toBeVisible();

  await page.getByRole("button", { name: "审计与摘要", exact: true }).click();
  await page.getByRole("button", { name: "生成摘要" }).click();
  await expect(page.locator(".shared-digest-panel pre").first()).toContainText(
    "Shared Space digest",
  );

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 900, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true);
    const screenshot = testInfo.outputPath(`shared-space-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`shared-space-${viewport.width}`, {
      path: screenshot,
      contentType: "image/png",
    });
  }
});
