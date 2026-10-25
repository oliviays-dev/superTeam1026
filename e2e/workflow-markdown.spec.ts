import { expect, test, type APIResponse } from "@playwright/test";

interface Project {
  id: string;
  name: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("workflow markdown validation and import", async ({ page, request }) => {
  const stamp = Date.now();
  const project = await json<Project>(
    await request.post("/api/v1/projects", {
      data: { name: `Workflow markdown browser ${stamp}` },
      headers: { "content-type": "application/json" },
    }),
  );
  const workflowName = `浏览器发布流程 ${stamp}`;
  const markdown = `# 工作流：${workflowName}

## 元信息

- key: browser-release-${stamp}
- version: 1
- description: Playwright deterministic import

## 节点

### 准备

- id: prepare
- type: task
- executor: user:local-admin

### 发布

- id: release
- type: service
- executor: system:deployment

## 连接

- prepare -> release`;

  await page.goto("/");
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page
    .getByRole("combobox", { name: "工作流项目" })
    .selectOption(project.id);
  await page.getByText("从 Markdown 导入").click();
  const editor = page.locator(".workflow-markdown-import textarea");
  await editor.fill(markdown);
  await page.getByRole("button", { name: "校验 Markdown" }).click();
  await expect(page.locator(".workflow-validation.valid")).toContainText(
    "校验通过 · 2 个节点",
  );
  await page.getByRole("button", { name: "导入定义" }).click();
  await expect(
    page.locator(".workflow-library .pm-directory-row").filter({
      hasText: workflowName,
    }),
  ).toBeVisible();

  await page.screenshot({
    path: `.tmp/batch4-workflow-markdown-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(workflowName).first()).toBeVisible();
  await page.screenshot({
    path: `.tmp/batch4-workflow-markdown-mobile-${stamp}.png`,
    fullPage: true,
  });
});
