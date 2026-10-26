import { expect, test, type APIResponse } from "@playwright/test";

interface Agent {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

interface Meeting {
  id: string;
  title: string;
}

interface MeetingAiPolicy {
  revision: number;
  status: "active" | "paused" | "terminated";
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("meeting AI participation policy and deterministic reply", async ({
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
    name: `Browser meeting AI ${stamp}`,
    runtimeKind: "fake",
    soul: "Participate as a concise meeting reviewer.",
  });
  const project = await post<Project>("/api/v1/projects", {
    name: `Meeting AI browser project ${stamp}`,
    description: "Batch 12A targeted browser scenario",
  });
  await post(`/api/v1/projects/${project.id}/members`, {
    kind: "agent",
    agentId: agent.id,
    responsibility: "Participate in deterministic meeting rounds",
    roleIds: [],
  });
  const meeting = await post<Meeting>("/api/v1/meetings", {
    projectId: project.id,
    title: `Meeting AI browser ${stamp}`,
    agenda: "Review deterministic participation and runtime budget",
    agentIds: [agent.id],
  });
  const policy = await json<MeetingAiPolicy>(
    await request.get(`/api/v1/meetings/${meeting.id}/ai-policy`),
  );
  await put<MeetingAiPolicy>(`/api/v1/meetings/${meeting.id}/ai-policy`, {
    expectedRevision: policy.revision,
    status: "active",
    triggerKinds: ["mention", "round", "agenda", "summary"],
    cooldownSeconds: 0,
    maxRounds: 5,
    maxMessages: 8,
    runBudgetMs: 10_000,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page
    .getByRole("combobox", { name: "会议项目" })
    .selectOption(project.id);
  await page.locator(".meeting-row").filter({ hasText: meeting.title }).click();

  await expect(page.getByLabel("AI 自动发言")).toBeVisible();
  await expect(page.getByRole("switch", { name: "自动发言" })).toBeChecked();
  await expect(page.getByText("5 轮 · 8 条剩余")).toBeVisible();
  await expect(
    page.locator(".meeting-ai-mentions button").filter({ hasText: agent.name }),
  ).toBeVisible();

  await page
    .locator(".meeting-ai-mentions button")
    .filter({ hasText: agent.name })
    .click();
  await page.getByPlaceholder("发送会议消息").fill("请评审当前议程与风险。");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const agentMessage = page
    .locator(".meeting-message.message-agent")
    .filter({ hasText: agent.name })
    .last();
  await expect(agentMessage).toBeVisible({ timeout: 30_000 });
  await expect(agentMessage).toContainText("任务「Meeting AI browser");
  await expect(agentMessage.locator(".meeting-ai-message-meta")).toContainText(
    "mention",
  );

  await page.getByLabel("暂停自动发言").click();
  await expect(
    page.getByRole("switch", { name: "自动发言" }),
  ).not.toBeChecked();
  await page.getByLabel("恢复自动发言").click();
  await expect(page.getByRole("switch", { name: "自动发言" })).toBeChecked();

  await page.getByRole("button", { name: "触发议程" }).click();
  await expect(
    page
      .locator(".meeting-message.message-agent")
      .filter({ hasText: agent.name }),
  ).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText(/轮 · .* 条剩余/)).toBeVisible();

  await page.screenshot({
    path: `.tmp/batch12a-meeting-ai-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page
    .getByRole("combobox", { name: "会议项目" })
    .selectOption(project.id);
  await page.locator(".meeting-row").filter({ hasText: meeting.title }).click();
  await expect(page.getByLabel("AI 自动发言")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch12a-meeting-ai-mobile-${stamp}.png`,
    fullPage: true,
  });
});
