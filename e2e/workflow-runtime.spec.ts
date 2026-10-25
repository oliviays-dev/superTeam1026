import { expect, test, type APIResponse } from "@playwright/test";

interface Project {
  readonly id: string;
  readonly name: string;
}

interface Workflow {
  readonly id: string;
}

interface Instance {
  readonly id: string;
  readonly title: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("workflow runtime branches, approval, audit and mobile layout", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const project = await json<Project>(
    await request.post("/api/v1/projects", {
      data: { name: `Workflow runtime browser ${stamp}` },
      headers: { "content-type": "application/json" },
    }),
  );
  const markdown = `# 工作流：运行时浏览器 ${stamp}

## 元信息

- key: runtime-browser-${stamp}
- version: 1

## 节点

### 评审

- id: review
- type: approval
- executor: user:local-admin
- approver: user:local-admin

### 判断

- id: decide
- type: decision
- executor: system:rules

### 复杂方案

- id: complex
- type: service
- executor: user:local-admin

### 标准方案

- id: standard
- type: service
- executor: user:local-admin

### 完成

- id: done
- type: service
- executor: user:local-admin

## 连接

- review -> decide [result: approved]
- decide -> complex [condition: complexity >= 8]
- decide -> standard [default: true]
- complex -> done
- standard -> done`;
  const workflow = await json<Workflow>(
    await request.post("/api/v1/workflows/import", {
      data: { projectId: project.id, markdown },
      headers: { "content-type": "application/json" },
    }),
  );
  const title = `运行时浏览器实例 ${stamp}`;
  const instance = await json<Instance>(
    await request.post(`/api/v1/workflows/${workflow.id}/start`, {
      data: { title, context: { complexity: 9 } },
      headers: {
        "content-type": "application/json",
        "idempotency-key": `browser-start-${stamp}`,
      },
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page
    .getByRole("combobox", { name: "工作流项目" })
    .selectOption(project.id);
  await page
    .locator(".workflow-instance-list .pm-directory-row")
    .filter({ hasText: title })
    .click();

  const reviewNode = page.locator('.workflow-node[data-node-id="review"]');
  await expect(reviewNode).toContainText("待审批");
  await expect(page.getByText("审批记录")).toBeVisible();
  await reviewNode.getByRole("button", { name: "同意" }).click();

  const complexNode = page.locator('.workflow-node[data-node-id="complex"]');
  await expect(complexNode).toContainText("就绪");
  await expect(
    page.locator(".workflow-branch.selected").filter({
      hasText: "decide → complex",
    }),
  ).toContainText("selected");
  await complexNode.getByRole("button", { name: "完成" }).click();

  const doneNode = page.locator('.workflow-node[data-node-id="done"]');
  await expect(doneNode).toContainText("就绪");
  await doneNode.getByRole("button", { name: "完成" }).click();
  await expect(page.locator(".workflow-runtime-head")).toContainText("已完成");
  await expect(page.getByRole("heading", { name: "运行审计" })).toBeVisible();
  await expect(
    page.locator(".workflow-audit-list").getByText("审批结论").first(),
  ).toBeVisible();

  await page.screenshot({
    path: ".tmp/batch5-workflow-runtime-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await expect(page.locator(".workflow-runtime-panel")).toBeVisible();
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector(".workflow-runtime-panel");
    if (panel === null) return 0;
    return Math.max(0, panel.scrollWidth - panel.getBoundingClientRect().width);
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: ".tmp/batch5-workflow-runtime-mobile.png",
    fullPage: true,
  });
  expect(instance.id).not.toBe("");
});
