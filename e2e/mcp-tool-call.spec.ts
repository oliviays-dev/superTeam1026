import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

interface Fixture {
  readonly projectId: string;
  readonly taskTitle: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly toolName: string;
  readonly toolKey: string;
  readonly inputSecret: string;
  readonly outputSecret: string;
}

const fixture = JSON.parse(
  readFileSync(process.env.M13B_E2E_FIXTURE_PATH!, "utf8"),
) as Fixture;

test("MCP Tool call is server-owned and visible as a redacted Run status", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "任务项目" })
    .selectOption(fixture.projectId);
  await page
    .locator(".task-board-card")
    .filter({ hasText: fixture.taskTitle })
    .click();

  await expect(
    page.getByRole("heading", { name: "MCP Tool Calls" }),
  ).toBeVisible();
  await expect(page.getByText(fixture.toolName, { exact: true })).toBeVisible();
  await expect(page.getByText("succeeded", { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.providerKey, { exact: true })).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(fixture.inputSecret);
  expect(body).not.toContain(fixture.outputSecret);

  const directCall = await page.evaluate(
    async ({ providerId, toolKey }) => {
      const response = await fetch(
        `/api/v1/mcp-providers/${providerId}/tools/${toolKey}/call`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ arguments: { forbidden: true } }),
        },
      );
      return response.status;
    },
    {
      providerId: fixture.providerId,
      toolKey: fixture.toolKey,
    },
  );
  expect(directCall).toBe(404);

  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 900, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole("heading", { name: "MCP Tool Calls" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `.tmp/m13b-mcp-tool-call-${viewport.width}.png`,
      fullPage: true,
    });
  }
});
