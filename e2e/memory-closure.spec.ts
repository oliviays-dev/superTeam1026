import { expect, test, type APIResponse } from "@playwright/test";

interface Agent {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
}

interface Meeting {
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

test("memory review, source return, handoff confirmation and episode empty state", async ({
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
  const put = async <T>(path: string, data: unknown): Promise<T> =>
    json<T>(
      await request.put(path, {
        data,
        headers: { "content-type": "application/json" },
      }),
    );

  const agent = await post<Agent>("/api/v1/agents", {
    name: `Memory closure agent ${stamp}`,
    runtimeKind: "fake",
  });
  const project = await post<Project>("/api/v1/projects", {
    name: `Memory closure browser ${stamp}`,
    description: "Batch 10B targeted browser scenario",
  });
  await post(`/api/v1/projects/${project.id}/members`, {
    kind: "agent",
    agentId: agent.id,
    responsibility: "Review project memory",
    roleIds: [],
  });
  const task = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Memory handoff task ${stamp}`,
    description: "Provide a source reference for the handoff card.",
    acceptance: [],
    agentId: agent.id,
  });
  await post(`/api/v1/projects/${project.id}/agent-episodes`, {
    agentId: agent.id,
    visibility: "project",
    kind: "decision",
    summary: "Project-visible memory closure episode",
    content: "The agent can reuse the confirmed memory decision.",
    sourceRefs: [],
  });
  const meeting = await post<Meeting>("/api/v1/meetings", {
    projectId: project.id,
    title: `Memory closure meeting ${stamp}`,
    agenda: "Publish a decision into the review queue",
    agentIds: [agent.id],
  });
  const message = await post<{ id: string }>(
    `/api/v1/meetings/${meeting.id}/messages`,
    { content: "Decision: close the memory review loop." },
  );
  const draft = await put<{ revision: number }>(
    `/api/v1/meetings/${meeting.id}/minutes/draft`,
    {
      content: "Decision: close the memory review loop.",
      decisions: ["Close the memory review loop"],
      sourceMessageIds: [message.id],
      expectedRevision: 0,
    },
  );
  await post(`/api/v1/meetings/${meeting.id}/minutes/publish`, {
    expectedRevision: draft.revision,
  });

  await page.goto("/");
  await page
    .locator(".sidebar-project-list button")
    .filter({ hasText: project.name })
    .first()
    .click();
  await page.getByRole("button", { name: /项目记忆/ }).click();
  await expect(page.getByRole("tab", { name: "Review 队列" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const reviewItem = page
    .locator(".memory-review-item")
    .filter({ hasText: "Close the memory review loop" });
  await expect(reviewItem).toBeVisible();

  await reviewItem.getByRole("button", { name: "会议纪要" }).click();
  await expect(page.getByRole("heading", { name: "沟通" })).toBeVisible();
  await expect(
    page.locator(".meeting-row").filter({ hasText: meeting.title }),
  ).toBeVisible();

  await page
    .locator(".sidebar-project-list button")
    .filter({ hasText: project.name })
    .first()
    .click();
  await page.getByRole("button", { name: /项目记忆/ }).click();
  const returnedReview = page
    .locator(".memory-review-item")
    .filter({ hasText: "Close the memory review loop" });
  await returnedReview.getByRole("checkbox").check();
  await page
    .getByRole("textbox", { name: "Review 说明" })
    .fill("Accept the decision backed by published minutes.");
  await page.getByRole("button", { name: "接受并更新 Truth" }).click();
  await expect(
    page.locator(".memory-review-empty strong").filter({
      hasText: "Review 队列为空",
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Topic 与 Truth" }).click();
  await expect(
    page.locator(".memory-topic-card").filter({
      hasText: "Close the memory review loop",
    }),
  ).toBeVisible();
  await expect(page.locator(".memory-topic-card")).toContainText(
    "Current Truth v1",
  );

  await page.getByRole("tab", { name: "Handoff" }).click();
  await page
    .getByRole("textbox", { name: "交接标题" })
    .fill("Memory closure handoff");
  await page
    .getByRole("textbox", { name: "交接摘要" })
    .fill("Continue from the reviewed decision and linked task.");
  await page.getByRole("combobox", { name: "关联任务" }).selectOption(task.id);
  await page.getByRole("button", { name: "新建草稿" }).click();
  const handoff = page
    .locator(".handoff-card")
    .filter({ hasText: "Memory closure handoff" });
  await expect(handoff).toContainText("草稿");
  await handoff.getByRole("button", { name: "确认交接" }).click();
  await expect(handoff).toContainText("已确认");
  await expect(handoff).toContainText("1 条不可变确认记录");

  await handoff.getByRole("button", { name: "关联任务" }).click();
  await expect(page.getByRole("region", { name: "任务详情" })).toContainText(
    task.title,
  );
  await page.getByTitle("关闭任务详情").click();

  await page
    .locator(".sidebar-project-list button")
    .filter({ hasText: project.name })
    .first()
    .click();
  await page.getByRole("button", { name: /项目记忆/ }).click();
  await page.getByRole("tab", { name: "Agent Episode" }).click();
  await page
    .getByRole("combobox", { name: "Episode Agent" })
    .selectOption(agent.id);
  await expect(page.locator(".episode-item")).toContainText(
    "Project-visible memory closure episode",
  );

  await page.screenshot({
    path: `.tmp/batch10b-memory-closure-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "Agent Episode" })).toBeVisible();
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
});
