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

interface MeetingMessage {
  id: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("meeting minutes revisions, action conversion and closure trace", async ({
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
    name: `Meeting decision agent ${stamp}`,
    runtimeKind: "fake",
  });
  const project = await post<Project>("/api/v1/projects", {
    name: `Meeting decision browser ${stamp}`,
    description: "Batch 10A targeted browser scenario",
  });
  await post(`/api/v1/projects/${project.id}/members`, {
    kind: "agent",
    agentId: agent.id,
    responsibility: "Execute meeting decisions",
    roleIds: [],
  });
  const meeting = await post<Meeting>("/api/v1/meetings", {
    projectId: project.id,
    title: `Decision meeting ${stamp}`,
    agenda: "Confirm a decision, owner and verifiable outcome",
    agentIds: [agent.id],
  });
  await post<MeetingMessage>(`/api/v1/meetings/${meeting.id}/messages`, {
    content: "Decision: ship the meeting closure flow before Friday.",
  });

  await page.goto("/");
  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page
    .getByRole("combobox", { name: "会议项目" })
    .selectOption(project.id);
  await page.locator(".meeting-row").filter({ hasText: meeting.title }).click();

  await page.getByRole("tab", { name: "纪要" }).click();
  await page
    .getByRole("textbox", { name: "会议纪要内容" })
    .fill("Decision: ship the meeting closure flow before Friday.");
  await page
    .getByRole("textbox", { name: "会议决策" })
    .fill("Ship the closure flow before Friday");
  await page.locator(".meeting-source-picker > summary").click();
  await page.locator(".meeting-source-picker input[type=checkbox]").check();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.locator(".meeting-decision-section-head")).toContainText(
    "修订 1",
  );

  const currentMinutes = await json<{
    draft: { revision: number };
  }>(await request.get(`/api/v1/meetings/${meeting.id}/minutes`));
  await put(`/api/v1/meetings/${meeting.id}/minutes/draft`, {
    content: "A concurrent revision from another editor.",
    decisions: ["Concurrent revision won the first save"],
    sourceMessageIds: [],
    expectedRevision: currentMinutes.draft.revision,
  });
  await page
    .getByRole("textbox", { name: "会议纪要内容" })
    .fill("This stale editor must receive a conflict.");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.locator(".meeting-minutes-editor .pm-error")).toContainText(
    "Meeting minutes were revised by another request",
  );
  await page.getByRole("button", { name: "载入最新修订" }).click();
  await expect(page.locator(".meeting-decision-section-head")).toContainText(
    "修订 2",
  );

  await page
    .getByRole("textbox", { name: "会议纪要内容" })
    .fill("Decision: ship the meeting closure flow before Friday.");
  await page
    .getByRole("textbox", { name: "会议决策" })
    .fill("Ship the closure flow before Friday");
  await page.getByRole("button", { name: "发布纪要" }).click();
  await expect(page.locator(".meeting-version-row").first()).toContainText(
    "v1",
  );

  await page
    .getByRole("textbox", { name: "会议纪要内容" })
    .fill("Decision revised after risk review: ship after acceptance.");
  await page
    .getByRole("textbox", { name: "会议决策" })
    .fill("Ship after acceptance\nThe accepted result becomes memory");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.locator(".meeting-decision-section-head")).toContainText(
    "修订 4",
  );
  await page.getByRole("button", { name: "发布纪要" }).click();
  await expect(page.locator(".meeting-version-row").first()).toContainText(
    "v2",
  );

  await page.getByRole("tab", { name: "行动项" }).click();
  await page
    .getByRole("textbox", { name: "行动项标题" })
    .fill("Ship meeting decision closure");
  await page
    .getByRole("textbox", { name: "行动项说明" })
    .fill("Execute the accepted decision, run it and retain review evidence.");
  await page
    .getByRole("combobox", { name: "行动项负责人" })
    .selectOption(agent.id);
  await page
    .getByRole("combobox", { name: "行动项优先级" })
    .selectOption("high");
  await page.getByRole("button", { name: "添加行动项" }).click();

  const actionCard = page
    .locator(".meeting-action-card")
    .filter({ hasText: "Ship meeting decision closure" });
  await expect(actionCard).toBeVisible();
  await actionCard
    .getByRole("combobox", { name: /选择执行 AI/ })
    .selectOption(agent.id);
  await actionCard.getByRole("button", { name: "转为任务" }).click();
  await actionCard.getByRole("button", { name: "打开关联任务" }).click();

  const taskDetail = page.getByRole("region", { name: "任务详情" });
  await expect(taskDetail).toBeVisible();
  await expect(taskDetail).toContainText("Ship meeting decision closure");
  await expect(taskDetail).toContainText("待验收", { timeout: 30_000 });
  await taskDetail
    .getByPlaceholder("验收意见或退回原因")
    .fill("Meeting action delivered and accepted.");
  await taskDetail.getByRole("button", { name: "验收通过" }).click();
  await expect(taskDetail).toContainText("已完成", { timeout: 15_000 });
  await page.getByTitle("关闭任务详情").click();

  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page
    .getByRole("combobox", { name: "会议项目" })
    .selectOption(project.id);
  await page.locator(".meeting-row").filter({ hasText: meeting.title }).click();
  await page.getByRole("tab", { name: "闭环" }).click();
  const traceChain = page
    .locator(".meeting-trace-chain")
    .filter({ hasText: "Ship meeting decision closure" });
  await expect(traceChain).toBeVisible();
  await expect(traceChain).toContainText("已完成", { timeout: 15_000 });
  await expect(traceChain).toContainText("completed");
  await expect(traceChain).toContainText("通过");
  await expect(traceChain).toContainText("1 条");

  await page.screenshot({
    path: `.tmp/batch10a-meeting-decisions-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(traceChain).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector<HTMLElement>(".app-stage")?.clientWidth ?? 0,
      ),
    )
    .toBeGreaterThan(300);
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".app-stage");
    stage?.scrollTo({ left: 0, top: 0 });
  });
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch10a-meeting-decisions-mobile-${stamp}.png`,
    fullPage: true,
  });
});
