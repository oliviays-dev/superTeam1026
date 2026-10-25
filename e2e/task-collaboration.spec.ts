import { expect, test, type APIResponse } from "@playwright/test";

interface Agent {
  id: string;
}

interface Project {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("task replies, attachments and activity timeline", async ({
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
  const agent = await post<Agent>("/api/v1/agents", {
    name: `Collaboration browser agent ${stamp}`,
    runtimeKind: "fake",
  });
  const project = await post<Project>("/api/v1/projects", {
    name: `Collaboration browser ${stamp}`,
  });
  const task = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Collaboration task ${stamp}`,
    description: "Exercise browser comments and attachments.",
    agentId: agent.id,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "任务项目" })
    .selectOption(project.id);
  await page
    .locator(".task-board-card")
    .filter({ hasText: task.title })
    .click();

  const detail = page.getByRole("region", { name: "任务详情" });
  const commentBox = detail.getByPlaceholder("添加任务评论");
  await commentBox.fill("Top-level browser decision");
  await detail.getByTitle("发送评论").click();
  await expect(detail).toContainText("Top-level browser decision");

  const firstMessage = detail
    .locator(".task-message")
    .filter({ hasText: "Top-level browser decision" });
  await firstMessage.getByRole("button", { name: "回复" }).click();
  await commentBox.fill("Reply from Playwright");
  await detail.getByTitle("发送评论").click();
  await expect(detail).toContainText("回复 Local Admin");
  await expect(detail).toContainText("Reply from Playwright");

  await detail.locator('input[type="file"]').setInputFiles({
    name: "browser-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("playwright attachment evidence", "utf8"),
  });
  const attachment = detail
    .locator(".task-attachment-row")
    .filter({ hasText: "browser-evidence.txt" });
  await expect(attachment).toBeVisible();
  await attachment.getByRole("button", { name: "归档附件" }).click();
  await expect(
    attachment.getByRole("button", { name: "复原附件" }),
  ).toBeVisible();
  await attachment.getByRole("button", { name: "复原附件" }).click();
  await expect(
    attachment.getByRole("button", { name: "归档附件" }),
  ).toBeVisible();

  await expect(detail).toContainText("活动时间线");
  await expect(detail).toContainText("上传任务附件");
  await expect(detail).toContainText("归档任务附件");
  await expect(detail).toContainText("回复任务评论");

  await page.screenshot({
    path: `.tmp/batch4-task-collaboration-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(attachment).toBeVisible();
  await page.screenshot({
    path: `.tmp/batch4-task-collaboration-mobile-${stamp}.png`,
    fullPage: true,
  });
});
