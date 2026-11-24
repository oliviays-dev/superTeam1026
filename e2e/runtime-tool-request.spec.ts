import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

interface Fixture {
  readonly projectId: string;
  readonly taskTitle: string;
  readonly runId: string;
  readonly toolKey: string;
  readonly requestId: string;
  readonly inputSecret: string;
  readonly outputSecret: string;
}

const fixture = JSON.parse(
  readFileSync(process.env.M13C_E2E_FIXTURE_PATH!, "utf8"),
) as Fixture;

test("Runtime Tool Request status stays read-only and redacted", async ({
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

  const runtimeSection = page
    .locator(".run-section")
    .filter({ hasText: "Runtime Tool Requests" });
  await expect(
    runtimeSection.getByRole("heading", { name: "Runtime Tool Requests" }),
  ).toBeVisible();
  await expect(
    runtimeSection.getByText("succeeded", { exact: true }),
  ).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(fixture.inputSecret);
  expect(body).not.toContain(fixture.outputSecret);
  expect(body).not.toContain(fixture.requestId);

  const directSubmit = await page.evaluate(async ({ runId }) => {
    const response = await fetch(`/api/v1/runs/${runId}/runtime-tool-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        toolKey: "a".repeat(64),
        gateId: crypto.randomUUID(),
        idempotencyKey: "browser-must-not-submit",
        arguments: { forbidden: true },
      }),
    });
    return response.status;
  }, fixture);
  expect(directSubmit).toBe(404);

  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 900, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      runtimeSection.getByRole("heading", { name: "Runtime Tool Requests" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `.tmp/m13c-runtime-tool-${viewport.width}.png`,
      fullPage: true,
    });
  }
});
