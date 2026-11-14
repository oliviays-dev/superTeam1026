import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

interface ApiResult<T> {
  readonly status: number;
  readonly body: T;
}

interface Workbench {
  readonly id: string;
  readonly name: string;
}

interface WorkbenchPanel {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly position: number;
  readonly width: number;
  readonly state: string;
}

interface WorkbenchDetail {
  readonly workbench: Workbench;
  readonly layout: {
    readonly revision: number;
    readonly isDefault: boolean;
  };
  readonly panels: WorkbenchPanel[];
}

interface WorkbenchBootstrap {
  readonly enabled: boolean;
  readonly workbenches: Workbench[];
  readonly defaultWorkbench: WorkbenchDetail | null;
}

interface Project {
  readonly id: string;
  readonly name: string;
}

interface ProjectRole {
  readonly id: string;
}

interface ProjectMember {
  readonly id: string;
}

interface MarketAsset {
  readonly id: string;
  readonly name: string;
}

const viewports = [
  { label: "1440", width: 1440, height: 1000 },
  { label: "900", width: 900, height: 1000 },
  { label: "390", width: 390, height: 844 },
] as const;

test.setTimeout(240_000);

for (const viewport of viewports) {
  test(`M8 Workbench and Market web flow at ${viewport.label}px`, async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await adminContext.newPage();
    try {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "我的工作台" })).toBeVisible();
      await selectWorkbench(page, "Layout E2E");

      await page
        .getByRole("combobox", { name: "我的待办宽度" })
        .selectOption("3");
      const focusBefore = (await detailFor(page, "Layout E2E")).panels.find(
        (panel) => panel.pluginId === "focus",
      )!.position;
      await page.getByRole("button", { name: "上移重点关注" }).click();
      await page.getByRole("button", { name: "保存布局" }).click();
      await expect
        .poll(async () => {
          const detail = await detailFor(page, "Layout E2E");
          const todo = detail.panels.find((panel) => panel.pluginId === "todo");
          const focus = detail.panels.find(
            (panel) => panel.pluginId === "focus",
          );
          return `${todo?.width}:${focus?.position}:${todo?.position}`;
        })
        .toBe(`3:${focusBefore - 1}:3`);

      await page.reload();
      await selectWorkbench(page, "Layout E2E");
      await expect(
        page.getByRole("combobox", { name: "我的待办宽度" }),
      ).toHaveValue("3");
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= window.innerWidth + 1 &&
            (document.querySelector<HTMLElement>(".app-stage")?.scrollWidth ??
              0) <=
              (document.querySelector<HTMLElement>(".app-stage")
                ?.clientWidth ?? 0) +
                1,
        ),
      ).toBe(true);

      await selectWorkbench(page, "Degradation E2E");
      await page.getByRole("button", { name: "设为默认" }).click();
      await expect
        .poll(async () => (await bootstrap(page)).defaultWorkbench?.workbench.name)
        .toBe("Degradation E2E");
      await expect(
        page.locator('[data-workbench-module="legacy.removed"]'),
      ).toContainText("未知面板已降级");
      await expect(page.locator(".module-supplier")).toContainText(
        "面板已禁用",
      );

      await selectWorkbench(page, "Entitlement E2E");
      await expect(
        page.locator('[data-workbench-module="market.sample"]'),
      ).toContainText("需要有效的市场 entitlement");

      await selectWorkbench(page, "Layout E2E");
      await page.getByRole("button", { name: "设为默认" }).click();
      await expect
        .poll(async () => (await bootstrap(page)).defaultWorkbench?.workbench.name)
        .toBe("Layout E2E");

      const memberPage = await createMemberPage(browser, viewport);
      try {
        const project = await ok<Project>(
          api(page, "POST", "/projects", {
            name: `M8 revoke ${viewport.label} ${Date.now()}`,
            description: "Permission revocation web fixture",
          }),
        );
        const role = await ok<ProjectRole>(
          api(page, "POST", `/projects/${project.id}/roles`, {
            code: "M8_E2E_READER",
            name: "M8 E2E Reader",
            category: "execution",
            description: "Read-only E2E member",
            permissions: ["read"],
          }),
        );
        const member = await ok<ProjectMember>(
          api(page, "POST", `/projects/${project.id}/members`, {
            kind: "human",
            actorId: "m8-member",
            name: "M8 Member",
            responsibility: "Permission revocation fixture",
            roleIds: [role.id],
          }),
        );

        await memberPage.goto("/");
        await expect(memberPage.locator(".module-todo")).toHaveAttribute(
          "data-module-state",
          "ready",
        );
        await memberPage
          .getByRole("button", { name: "刷新我的待办" })
          .click();
        await ok(
          api(
            page,
            "PATCH",
            `/projects/${project.id}/roles/${role.id}`,
            { permissions: ["write"] },
          ),
        );
        await ok(
          api(
            page,
            "PATCH",
            `/projects/${project.id}/members/${member.id}`,
            { roleIds: [role.id] },
          ),
        );
        const revokedCapability = await api<{
          readonly code?: string;
          readonly details?: { readonly permission?: string };
        }>(memberPage, "GET", `/projects/${project.id}/capability`);
        expect(revokedCapability.status).toBe(403);
        expect(revokedCapability.body).toMatchObject({
          code: "forbidden",
          details: { permission: "read" },
        });
        await memberPage
          .getByRole("button", { name: "刷新我的待办" })
          .click();
        await expect(memberPage.locator(".module-todo")).toContainText(
          "项目读取权限已撤销",
        );
        await expect(memberPage.locator(".module-todo")).toHaveAttribute(
          "data-module-state",
          "forbidden",
        );
      } finally {
        await memberPage.context().close();
      }

      await page.getByRole("button", { name: "资源市场" }).click();
      const assetName = `M8 Template ${viewport.label} ${Date.now()}`;
      const assetKey = `m8.e2e.${viewport.label}.${Date.now()}`;
      const assetForm = page.locator(".market-admin-form").first();
      await assetForm.getByLabel("Asset Key").fill(assetKey);
      await assetForm.getByLabel("名称", { exact: true }).fill(assetName);
      await assetForm.getByRole("button", { name: "创建市场资产" }).click();
      await expect(
        page.locator(".market-admin-form").nth(1).getByLabel("资产"),
      ).toHaveValue(/.+/);
      await page.getByRole("button", { name: "发布版本" }).click();
      await expect(page.locator(".market-version-row")).toContainText("v1");

      await expect(page.getByLabel("目标账号")).toContainText(
        "local-admin",
      );
      await page
        .getByLabel("目标账号")
        .selectOption("local-admin");
      await page.getByRole("button", { name: "授予 entitlement" }).click();
      await expect(
        page
          .locator(".market-entitlement-row")
          .filter({ hasText: "local-admin" }),
      ).toContainText("active");

      const assetCard = page
        .locator(".market-asset-card")
        .filter({ hasText: assetName });
      await expect(assetCard).toBeVisible();
      await assetCard.getByRole("button", { name: "安装" }).click();
      await expect(
        assetCard.getByRole("button", { name: "卸载" }),
      ).toBeVisible();
      const templateRow = page
        .locator(".market-template-row")
        .filter({ hasText: assetName });
      await expect(templateRow).toBeVisible();
      const copiedName = `${assetName} Copy`;
      await templateRow
        .getByPlaceholder("复制后的工作台名称")
        .fill(copiedName);
      await templateRow.getByRole("button", { name: "复制方案" }).click();
      await expect
        .poll(async () =>
          (await bootstrap(page)).workbenches.some(
            (workbench) => workbench.name === copiedName,
          ),
        )
        .toBe(true);
      await assetCard.getByRole("button", { name: "卸载" }).click();
      await expect(
        assetCard.getByRole("button", { name: "安装" }),
      ).toBeVisible();

      const versionRow = page.locator(".market-version-row").first();
      await versionRow.getByRole("button", { name: "弃用" }).click();
      await expect(versionRow).toContainText("deprecated");
      const entitlementRow = page
        .locator(".market-entitlement-row")
        .filter({ hasText: "local-admin" });
      await entitlementRow.getByRole("button", { name: "撤销" }).click();
      await expect(entitlementRow).toContainText("revoked");
      await page.getByRole("button", { name: "下架" }).click();
      await expect(
        page.locator(".market-admin-pills").filter({ hasText: "delisted" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "归档" }).click();
      await expect(
        page.locator(".market-admin-pills").filter({ hasText: "archived" }),
      ).toBeVisible();

      await page.screenshot({
        path: `.tmp/m8-workbench-market-${viewport.label}.png`,
        fullPage: true,
      });
    } finally {
      await adminContext.close();
    }
  });
}

async function createMemberPage(
  browser: Browser,
  viewport: { readonly width: number; readonly height: number },
): Promise<Page> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.route("**/api/v1/**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "x-pluginmax-actor": "m8-member",
      },
    });
  });
  return context.newPage();
}

async function selectWorkbench(page: Page, name: string): Promise<void> {
  const select = page.getByLabel("切换工作台");
  await expect(select).toBeVisible();
  await select.selectOption({ label: name });
  await expect(page.locator(".workbench-config-panel")).toContainText("保存布局");
}

async function bootstrap(page: Page): Promise<WorkbenchBootstrap> {
  return ok(api(page, "GET", "/workbenches"));
}

async function detailFor(
  page: Page,
  name: string,
): Promise<WorkbenchDetail> {
  const state = await bootstrap(page);
  const workbench = state.workbenches.find((item) => item.name === name);
  if (workbench === undefined) throw new Error(`Workbench ${name} not found`);
  return ok(api(page, "GET", `/workbenches/${workbench.id}`));
}

async function api<T>(
  page: Page,
  method: string,
  path: string,
  payload?: unknown,
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ method: requestMethod, path: requestPath, payload: body }) => {
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => ({}))) as T,
      };
    },
    { method, path, payload },
  );
}

async function ok<T>(resultPromise: Promise<ApiResult<T>>): Promise<T> {
  const result = await resultPromise;
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}
