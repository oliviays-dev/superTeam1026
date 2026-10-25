import { expect, test, type APIResponse } from "@playwright/test";

interface Project {
  readonly id: string;
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

test("workflow governance approvals, audit filters and mobile layout", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const project = await json<Project>(
    await request.post("/api/v1/projects", {
      data: { name: `Workflow governance browser ${stamp}` },
      headers: { "content-type": "application/json" },
    }),
  );
  await json(
    await request.post(`/api/v1/projects/${project.id}/members`, {
      data: {
        kind: "human",
        actorId: "reviewer-1",
        name: "Reviewer One",
        responsibility: "Primary reviewer",
      },
      headers: { "content-type": "application/json" },
    }),
  );
  await json(
    await request.post(`/api/v1/projects/${project.id}/members`, {
      data: {
        kind: "human",
        actorId: "reviewer-2",
        name: "Reviewer Two",
        responsibility: "Security reviewer",
      },
      headers: { "content-type": "application/json" },
    }),
  );
  const markdown = `# 工作流：治理浏览器 ${stamp}

## 元信息

- key: governance-browser-${stamp}
- version: 1

## 节点

### Review

- id: review
- type: approval
- executor: user:local-admin
- approver: user:local-admin
- policy: all

## 连接
`;
  const workflow = await json<Workflow>(
    await request.post("/api/v1/workflows/import", {
      data: { projectId: project.id, markdown },
      headers: { "content-type": "application/json" },
    }),
  );
  const title = `Governance browser ${stamp}`;
  const instance = await json<Instance>(
    await request.post(`/api/v1/workflows/${workflow.id}/start`, {
      data: { title },
      headers: {
        "content-type": "application/json",
        "idempotency-key": `governance-browser-start-${stamp}`,
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
  await reviewNode.getByRole("button", { name: "加签" }).click();
  await reviewNode
    .getByRole("combobox", { name: "加签审批人" })
    .selectOption("reviewer-2");
  await reviewNode
    .getByRole("textbox", { name: "审批操作备注" })
    .fill("security review");
  await reviewNode.getByRole("button", { name: "确认加签" }).click();
  await expect(page.locator(".workflow-approval-list")).toContainText(
    "reviewer-2",
  );

  await reviewNode.getByRole("button", { name: "转交" }).click();
  await reviewNode
    .getByRole("combobox", { name: "转交审批人" })
    .selectOption("reviewer-1");
  await reviewNode
    .getByRole("textbox", { name: "审批操作备注" })
    .fill("handoff");
  await reviewNode.getByRole("button", { name: "确认转交" }).click();
  await expect(page.locator(".workflow-approval-list")).toContainText(
    "reviewer-1",
  );

  await page
    .getByRole("combobox", { name: "审计事件类型" })
    .selectOption("approval.transferred");
  await expect(page.locator(".workflow-audit-list")).toContainText("审批转交");

  for (const actorId of ["reviewer-1", "reviewer-2"]) {
    await json(
      await request.post(`/api/v1/workflow-instances/${instance.id}/approvals`, {
        data: {
          nodeId: "review",
          decision: "approve",
          note: `${actorId} approved`,
        },
        headers: {
          "content-type": "application/json",
          "x-pluginmax-actor": actorId,
          "idempotency-key": `browser-${actorId}-${stamp}`,
        },
      }),
    );
  }
  await page.getByRole("button", { name: "同步运行状态" }).click();
  await expect(page.locator(".workflow-runtime-head")).toContainText("已完成");

  await page.screenshot({
    path: ".tmp/batch6-workflow-governance-desktop.png",
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
    path: ".tmp/batch6-workflow-governance-mobile.png",
    fullPage: true,
  });
});
