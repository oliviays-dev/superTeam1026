import { expect, test } from "@playwright/test";

test("external runtime management, Probe, enablement, and mobile layout", async ({
  page,
}) => {
  const stamp = Date.now();
  const runtimeName = `Browser Runtime ${stamp}`;

  await page.goto("/");
  await page.getByRole("button", { name: "运行时", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运行时", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建运行时" }).first().click();
  await page.getByPlaceholder("例如：Codex CLI").fill(runtimeName);
  await page.locator("#runtime-provider").selectOption("command");
  await expect(page.locator("#runtime-protocol")).toHaveValue("plain-text");
  await page.locator("#runtime-command").fill(process.execPath);
  await page.locator("#runtime-custom-args").fill("--trace-warnings");
  await page.getByRole("button", { name: "保存运行时" }).click();
  await expect(
    page.getByRole("heading", { name: runtimeName }),
  ).toBeVisible();
  await expect(page.getByText("未探测").first()).toBeVisible();

  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect(
    page.getByText(
      "A successful probe for the current runtime revision is required",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Probe", exact: true }).click();
  await expect(page.getByText("排队中").first()).toBeVisible();
  await expect(page.getByText("Probe 通过").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect(page.getByText("已启用").first()).toBeVisible();

  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch13a-external-runtimes-${stamp}.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "运行时", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运行时", level: 1 }),
  ).toBeVisible();
  await page
    .locator(".runtime-list-row")
    .filter({ hasText: runtimeName })
    .click();
  await expect(page.locator(".runtime-command-input")).toHaveValue(
    process.execPath,
  );
  expect(
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".app-stage");
      return stage === null || stage.scrollWidth <= stage.clientWidth + 1;
    }),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp/batch13a-external-runtimes-mobile-${stamp}.png`,
    fullPage: true,
  });
});
