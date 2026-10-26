import { expect, test, type APIResponse } from "@playwright/test";

interface TemplateRole {
  id: string;
}

interface WorkflowTemplate {
  id: string;
  version: number;
}

interface ProjectTemplate {
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

test("project template maintenance and template-based project creation", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const post = async <T>(path: string, data: unknown): Promise<T> =>
    json<T>(
      await request.post(path, {
        data,
        headers: { "content-type": "application/json" },
      }),
    );
  const role = await post<TemplateRole>("/api/v1/template-roles", {
    code: `ROLE_BROWSER_${stamp}`,
    name: "浏览器项目负责人",
    category: "management",
    description: "Batch 11B browser role",
    permissions: ["read", "write", "approve", "manage_members", "manage_roles"],
  });
  const workflow = await post<WorkflowTemplate>("/api/v1/workflow-templates", {
    key: `FLOW_BROWSER_${stamp}`,
    name: "浏览器交付流程",
    description: "Workflow-domain owned template",
    definition: {
      steps: [
        {
          name: "执行",
          kind: "agent",
          roleCode: `ROLE_BROWSER_${stamp}`,
        },
        { name: "验收", kind: "human" },
      ],
    },
  });
  const template = await post<ProjectTemplate>("/api/v1/project-templates", {
    name: `浏览器项目模板 ${stamp}`,
    code: `TPL-BROWSER-${stamp}`,
    type: "研发类",
    description: "由 Playwright 创建的项目模板",
    roleIds: [role.id],
    ownerRoleId: role.id,
    workflowTemplates: [
      {
        workflowTemplateId: workflow.id,
        expectedVersion: workflow.version,
      },
    ],
    accessPolicy: "all-members",
    allowedActorIds: [],
  });
  const projectName = `模板项目 ${stamp}`;

  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "项目" })).toBeVisible();
  await page.getByRole("button", { name: "项目模版" }).click();
  await expect(
    page.getByRole("heading", { name: "项目模版维护" }),
  ).toBeVisible();
  await expect(page.getByText(template.name).first()).toBeVisible();
  await expect(page.getByText("浏览器项目负责人").last()).toBeVisible();
  await expect(page.getByText("浏览器交付流程").last()).toBeVisible();
  await expect(page.getByText("历史摘要")).toBeVisible();
  await page.getByRole("button", { name: "角色库" }).click();
  await expect(page.getByText("角色库", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("浏览器项目负责人").first()).toBeVisible();
  await page.getByRole("button", { name: "返回项目" }).click();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByPlaceholder("项目名称").fill(projectName);
  await page
    .locator(".template-create-select select")
    .selectOption(template.id);
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(
    page.locator(".project-detail").getByRole("heading", { name: projectName }),
  ).toBeVisible();
  await page.getByRole("button", { name: /成员与角色/ }).click();
  await expect(page.getByText("浏览器项目负责人").first()).toBeVisible();

  await page.getByRole("button", { name: "项目模版" }).click();
  await expect(
    page.getByRole("heading", { name: "项目模版维护" }),
  ).toBeVisible();
  await page.screenshot({
    path: `.tmp/batch11b-project-templates-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "项目模版" }).click();
  await expect(
    page.getByRole("heading", { name: "项目模版维护" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch11b-project-templates-mobile-${stamp}.png`,
    fullPage: true,
  });
});
