import { expect, test, type APIResponse } from "@playwright/test";

interface Project {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
}

interface ProjectReport {
  id: string;
  read: boolean;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("project report history, real workbench risks and source return context", async ({
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
  const project = await post<Project>("/api/v1/projects", {
    name: `Batch 11A browser ${stamp}`,
    description: "Workbench and project report browser scenario",
  });
  const task = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Report source task ${stamp}`,
    description: "Verify report source navigation and return context.",
    acceptance: ["Source link returns to the report"],
    agentId: "00000000-0000-4000-8000-000000000001",
    dependsOn: [],
  });
  const generated = await post<{ report: ProjectReport }>(
    `/api/v1/projects/${project.id}/reports/generate`,
    { reportDate: "2026-10-26" },
  );
  await post("/api/v1/workbench/supply-exceptions", {
    projectId: project.id,
    title: "Persisted supply exception browser",
    severity: "high",
    suggestedAction: "Open the qualification action",
    ownerActorId: "local-admin",
    impactScope: "Browser fixture",
    sourceTaskId: task.id,
    status: "open",
  });
  await post("/api/v1/workbench/supplier-risks", {
    projectId: project.id,
    supplierName: "Browser persisted supplier",
    riskType: "Capacity",
    riskScore: 91,
    commitmentRate: 68,
    qualityMetric: "Open deviations",
    purchaseShare: 42,
    suggestedAction: "Start capacity review",
    status: "open",
    sourceNote: "Persistent row rendered in workbench",
  });
  await post("/api/v1/workbench/follows", {
    targetType: "task",
    targetId: task.id,
    projectId: project.id,
    followed: true,
  });

  await page.goto("/");
  await page
    .locator(".sidebar-project-list button")
    .filter({ hasText: project.name })
    .first()
    .click();
  await page.getByRole("button", { name: "项目日报" }).click();
  await expect(page.getByText("2026-10-26").first()).toBeVisible();
  const sourceButton = page
    .locator(".report-sources .source-link")
    .filter({ hasText: task.title })
    .first();
  await expect(sourceButton).toBeVisible();
  await sourceButton.click();
  await expect(page.getByRole("region", { name: "任务详情" })).toContainText(
    task.title,
  );
  await expect(page.getByRole("button", { name: "返回项目" })).toBeVisible();
  await page.getByRole("button", { name: "返回项目" }).click();
  await expect(
    page.getByRole("button", { name: "项目日报", exact: true }),
  ).toHaveClass(/active/);
  await expect(
    page.locator(".project-report-detail").filter({ hasText: task.title }),
  ).toBeVisible();

  const reportList = await json<{ items: ProjectReport[] }>(
    await request.get(`/api/v1/projects/${project.id}/reports`),
  );
  expect(
    reportList.items.find((item) => item.id === generated.report.id)?.read,
  ).toBe(true);

  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "我的工作台" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("每日简报")).toBeVisible();
  await expect(
    page
      .locator(".workbench-risk")
      .filter({ hasText: "Persisted supply exception browser" })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .locator(".workbench-risk")
      .filter({ hasText: "Browser persisted supplier" })
      .first(),
  ).toBeVisible();
  await expect(page.getByText("直接关注任务").first()).toBeVisible();
  await page
    .getByRole("combobox", { name: "简报更新频次" })
    .selectOption("every-4-hours");
  await expect(
    page.getByRole("combobox", { name: "简报更新频次" }),
  ).toHaveValue("every-4-hours");

  await page.getByRole("button", { name: "管理驾驶舱" }).click();
  await expect(page.locator(".workbench-cockpit-placeholder")).toBeVisible();
  await page.getByRole("button", { name: "我的工作台" }).click();

  await page.screenshot({
    path: `.tmp/batch11a-workbench-reports-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "我的工作台" })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  const mobileGridColumns = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".workbench-canvas");
    return canvas === null ? "" : getComputedStyle(canvas).gridTemplateColumns;
  });
  expect(mobileGridColumns.trim().split(/\s+/)).toHaveLength(1);
  await page.screenshot({
    path: `.tmp/batch11a-workbench-reports-mobile-${stamp}.png`,
    fullPage: true,
  });
});
