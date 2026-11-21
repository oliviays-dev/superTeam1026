import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("MCP Provider control plane is safe and responsive", async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const providerKey = `m13a.e2e.${suffix}`;
  const providerName = `M13a E2E ${suffix}`;
  const credentialRef = `env://M13A_E2E_${suffix.toUpperCase()}`;
  const endpoint = `https://${providerKey}.example.test/mcp`;

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "MCP 连接", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "MCP Provider" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "平台健康检查" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "注册 Provider" }).click();
  await page.getByLabel("Provider Key").fill(providerKey);
  await page.getByLabel("显示名称").fill(providerName);
  await page.getByLabel("说明").fill("M13a browser verification");
  await page.getByLabel("Endpoint").fill(endpoint);
  await page.getByLabel("认证方式").selectOption("bearer");
  await page.getByLabel("凭证引用").fill(credentialRef);
  await page.getByRole("button", { name: "保存 Provider" }).click();

  await expect(
    page.locator(".mcp-provider-list").getByText(providerName, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("已配置安全引用")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发起探测" }),
  ).toBeVisible();
  await expect(page.getByText(endpoint)).toHaveCount(0);
  await expect(page.getByText(credentialRef)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Tool Schema" }),
  ).toBeVisible();
  await expect(page.getByText("不提供 Tool 调用或执行授权")).toBeVisible();
  await page.screenshot({
    path: ".tmp/m13a-mcp-provider-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 900, height: 1000 });
  await expect(
    page.locator(".mcp-provider-list").getByText(providerName, {
      exact: true,
    }),
  ).toBeVisible();
  const tabletOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(tabletOverflows).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator(".mcp-provider-list").getByText(providerName, {
      exact: true,
    }),
  ).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await page.screenshot({
    path: ".tmp/m13a-mcp-provider-mobile.png",
    fullPage: true,
  });
});
