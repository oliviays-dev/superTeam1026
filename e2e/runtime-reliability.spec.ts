import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const screenshotDir = resolve(
  process.env.BATCH8_SCREENSHOT_DIR ?? ".tmp/screenshots/batch8",
);

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
});

test.describe("runtime operations desktop", () => {
  test.use({ viewport: { width: 1440, height: 960 } });

  test("shows worker health, queue, SLA and dead-letter operations", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "运维" }).click();
    await expect(page.getByRole("heading", { name: "运行运维" })).toBeVisible();
    await expect(page.getByText("在线 Worker")).toBeVisible();
    await expect(page.getByText("队列深度")).toBeVisible();
    await expect(page.getByText("SLA 超时", { exact: true })).toBeVisible();
    await expect(page.getByText("死信队列", { exact: true })).toBeVisible();
    await expect(page.getByText("Migration v23 / v23")).toBeVisible();
    await expect(page.getByText("租约抖动", { exact: true })).toBeVisible();
    await expect(page.getByText("SLA 燃尽率", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(screenshotDir, "operations-desktop.png"),
      fullPage: true,
    });
  });
});

test.describe("runtime operations mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps the operations dashboard usable on a phone viewport", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTitle("展开导航").click();
    await page.getByRole("button", { name: "运维" }).click();
    await expect(page.getByRole("heading", { name: "运行运维" })).toBeVisible();
    await expect(page.getByText("在线 Worker")).toBeVisible();
    await expect(page.getByText("死信队列", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(screenshotDir, "operations-mobile.png"),
      fullPage: true,
    });
  });
});
