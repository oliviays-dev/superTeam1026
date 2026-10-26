import { expect, test, type APIResponse } from "@playwright/test";

interface Agent {
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

test("AI direct chat sends a private message and stays usable on mobile", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const agent = await json<Agent>(
    await request.post("/api/v1/agents", {
      data: {
        name: `Browser direct AI ${stamp}`,
        description: "Focused direct chat browser scenario",
        runtimeKind: "fake",
        soul: "Answer only the private message.",
      },
      headers: { "content-type": "application/json" },
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page.getByRole("combobox", { name: "会话类型" }).selectOption("direct");
  const row = page.locator(".direct-chat-row").filter({ hasText: agent.name });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.getByText("AI 对话", { exact: true }).last()).toBeVisible();
  await page.getByLabel("AI 私聊消息").fill("请确认这条私聊只属于当前会话。");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const agentMessage = page
    .locator(".direct-chat-message.message-agent")
    .last();
  await expect(agentMessage).toBeVisible({ timeout: 30_000 });
  await expect(agentMessage).toContainText(agent.name);
  await expect(agentMessage).toContainText("任务「AI 对话");
  await expect(
    page.locator(".direct-chat-message.message-owner"),
  ).toContainText("请确认这条私聊只属于当前会话。");

  await page.screenshot({
    path: `.tmp/batch12b-ai-direct-chat-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "沟通", exact: true }).click();
  await page.getByRole("combobox", { name: "会话类型" }).selectOption("direct");
  await page
    .locator(".direct-chat-row")
    .filter({ hasText: agent.name })
    .click();
  await expect(page.getByLabel("AI 私聊消息")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch12b-ai-direct-chat-mobile-${stamp}.png`,
    fullPage: true,
  });
});
