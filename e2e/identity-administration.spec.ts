import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

interface FixtureAccount {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
}

interface IdentityFixture {
  readonly password: string;
  readonly admin: FixtureAccount;
  readonly owner: FixtureAccount;
  readonly member: FixtureAccount;
}

test("Identity Administration manages accounts, grants, workspaces and audit", async ({
  page,
}) => {
  const fixturePath = process.env.RBAC_E2E_FIXTURE_PATH;
  if (fixturePath === undefined)
    throw new Error("RBAC_E2E_FIXTURE_PATH missing");
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as IdentityFixture;
  const screenshotRoot = join(
    process.cwd(),
    ".tmp",
    "identity-admin-e2e",
    "screenshots",
  );

  await page.goto("/");
  await page.getByLabel("登录 ID").fill(fixture.admin.loginId);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "账号与权限" }).click();
  await expect(page.getByRole("heading", { name: "账号与权限" })).toBeVisible();

  const loginId = `identity-ui-${Date.now()}`;
  await page.getByRole("button", { name: "创建账号" }).click();
  const createPanel = page.locator(".identity-create-panel");
  await createPanel.getByLabel("登录 ID").fill(loginId);
  await createPanel.getByLabel("显示名").fill("Identity UI Member");
  await createPanel.getByLabel("凭据初始化").selectOption("invitation");
  await createPanel.getByRole("button", { name: "创建账号" }).click();
  const activation = page.getByRole("status");
  await expect(activation).toContainText("一次性激活凭据");
  const activationToken =
    (await activation.locator("code").textContent()) ?? "";
  expect(activationToken).toHaveLength(43);
  await expect(page.getByText("Identity UI Member").first()).toBeVisible();

  await page.getByRole("button", { name: "平台 Grant" }).click();
  await page.getByLabel("Principal ID").fill(fixture.owner.principalId);
  await page.getByLabel("角色").selectOption("ADMIN");
  await page.getByRole("button", { name: "授予 Grant" }).click();
  await expect(page.getByText(fixture.owner.principalId).first()).toBeVisible();
  await expect(page.getByText("ADMIN").first()).toBeVisible();

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const workspaceName = `Identity Workspace ${Date.now()}`;
  await page.getByPlaceholder("新 Workspace 名称").fill(workspaceName);
  await page.getByRole("button", { name: "新建" }).click();
  await expect(
    page.getByRole("heading", { name: workspaceName }),
  ).toBeVisible();
  await page.getByLabel("添加成员").fill(fixture.owner.principalId);
  await page.getByRole("button", { name: "加入" }).click();
  await expect(page.getByText(fixture.owner.principalId).first()).toBeVisible();
  await page.getByLabel("授予 Workspace Grant").fill(fixture.owner.principalId);
  await page.getByLabel("Workspace 角色").selectOption("MEMBER");
  await page.getByRole("button", { name: "授予", exact: true }).click();
  await expect(page.getByText("MEMBER").first()).toBeVisible();

  await page.getByRole("button", { name: "身份审计" }).click();
  await page
    .getByPlaceholder("过滤 action，例如 identity.account.created")
    .fill("identity.account.created");
  await expect(
    page.getByText("identity.account.created").first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({
    path: join(screenshotRoot, "identity-admin-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 960 });
  await page.screenshot({
    path: join(screenshotRoot, "identity-admin-900.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(screenshotRoot, "identity-admin-390.png"),
    fullPage: true,
  });
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  }
});

test("non-administrators only see permitted identity surfaces", async ({
  page,
}) => {
  const fixturePath = process.env.RBAC_E2E_FIXTURE_PATH;
  if (fixturePath === undefined)
    throw new Error("RBAC_E2E_FIXTURE_PATH missing");
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as IdentityFixture;
  await page.goto("/");
  await page.getByLabel("登录 ID").fill(fixture.member.loginId);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "账号与权限" }).click();
  await expect(
    page.getByRole("button", { name: "Workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "账号目录" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "平台 Grant" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "身份审计" })).toHaveCount(0);
});
