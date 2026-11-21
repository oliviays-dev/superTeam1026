import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

interface Fixture {
  readonly projectId: string;
  readonly projectName: string;
  readonly refKey: string;
  readonly providerId: string;
  readonly providerVersionId: string;
  readonly toolKey: string;
  readonly outputSecret: string;
  readonly endpoint: string;
  readonly credentialRef: string;
}

const fixture = JSON.parse(
  readFileSync(process.env.M13D_E2E_FIXTURE_PATH!, "utf8"),
) as Fixture;

test("MCP project sources are Worker-only and browser read-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .locator("button.pm-directory-row")
    .filter({ hasText: fixture.projectName })
    .click();

  await expect(page.getByText("业务链路", { exact: true })).toBeVisible();
  await expect(page.getByText("订单只读来源链路").first()).toBeVisible();
  await expect(page.getByText("420", { exact: true })).toBeVisible();
  await expect(page.getByText("MCP 项目来源超时")).toBeVisible();
  await expect(page.getByTitle("刷新来源")).toHaveCount(0);

  const body = await page.locator("body").innerText();
  for (const secret of [
    fixture.outputSecret,
    fixture.endpoint,
    fixture.credentialRef,
    fixture.toolKey,
    fixture.providerVersionId,
    fixture.providerId,
  ]) {
    expect(body).not.toContain(secret);
  }

  const directRefresh = await page.evaluate(async ({ projectId, refKey }) => {
    const response = await fetch(
      `/api/v1/projects/${projectId}/business-chain/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refKeys: [refKey] }),
      },
    );
    return {
      status: response.status,
      code: ((await response.json()) as { code?: string }).code,
    };
  }, { projectId: fixture.projectId, refKey: fixture.refKey });
  expect(directRefresh.status).toBe(403);
  expect(directRefresh.code).toBe("project_source_mcp_worker_only");

  const adminOps = await page.evaluate(async () => {
    const [summary, reconcile, retention] = await Promise.all([
      fetch("/api/v1/admin/project-source-mcp/summary"),
      fetch("/api/v1/admin/project-source-mcp/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 10 }),
      }),
      fetch("/api/v1/admin/project-source-mcp/retention?retentionDays=30"),
    ]);
    return {
      summaryStatus: summary.status,
      reconcileStatus: reconcile.status,
      retentionStatus: retention.status,
      summary: (await summary.json()) as { total?: number },
      reconcile: (await reconcile.json()) as { reconciled?: number },
      retention: (await retention.json()) as {
        dryRun?: boolean;
        action?: string;
      },
    };
  });
  expect(adminOps.summaryStatus).toBe(200);
  expect(adminOps.reconcileStatus).toBe(200);
  expect(adminOps.retentionStatus).toBe(200);
  expect(adminOps.summary.total).toBe(0);
  expect(adminOps.reconcile.reconciled).toBe(0);
  expect(adminOps.retention).toMatchObject({
    dryRun: true,
    action: "archive-before-delete",
  });

  for (const path of [
    `/api/v1/projects/${fixture.projectId}/business-chain/mcp-tools/call`,
    `/api/v1/projects/${fixture.projectId}/sources/read`,
    `/api/v1/mcp-providers/${fixture.providerId}/invoke`,
  ]) {
    const status = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arguments: { forbidden: true } }),
      });
      return response.status;
    }, path);
    expect(status).toBe(404);
  }

  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 900, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByText("业务链路", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `.tmp/m13d-project-source-${viewport.width}.png`,
      fullPage: true,
    });
  }
});
