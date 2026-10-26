import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
}

interface Fixture {
  readonly password: string;
  readonly admin: AccountFixture;
  readonly owner: AccountFixture;
  readonly member: AccountFixture;
  readonly outsider: AccountFixture;
}

interface BrowserResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(process.env.RBAC_E2E_FIXTURE_PATH!, "utf8"),
) as Fixture;

async function login(
  context: BrowserContext,
  account: AccountFixture,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("登录 ID").fill(account.loginId);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => sessionStorage.getItem("pluginmax.auth.token")),
    )
    .not.toBeNull();
  return page;
}

async function api(
  page: Page,
  method: string,
  path: string,
  payload?: unknown,
): Promise<BrowserResponse> {
  return page.evaluate(
    async ({ method: requestMethod, path: requestPath, payload: body }) => {
      const token = sessionStorage.getItem("pluginmax.auth.token");
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >,
      };
    },
    { method, path, payload },
  );
}

test("multi-Principal project authorization and immediate Grant revocation", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const ownerPage = await login(ownerContext, fixture.owner);
    const memberPage = await login(memberContext, fixture.member);
    const adminPage = await login(adminContext, fixture.admin);
    const outsiderPage = await login(outsiderContext, fixture.outsider);

    const projectName = `RBAC E2E ${Date.now()}`;
    const created = await api(ownerPage, "POST", "/projects", {
      name: projectName,
      description: "Playwright multi-Principal authorization",
    });
    expect(created.status).toBe(201);
    const projectId = created.body.id as string;

    const role = await api(ownerPage, "POST", `/projects/${projectId}/roles`, {
      code: "E2E_WRITER",
      name: "E2E Writer",
      category: "execution",
      description: "Playwright authorization role",
      permissions: ["read", "write"],
    });
    expect(role.status).toBe(201);
    const roleId = role.body.id as string;

    const added = await api(
      ownerPage,
      "POST",
      `/projects/${projectId}/members`,
      {
        kind: "human",
        actorId: fixture.member.principalId,
        name: "E2E Member",
        responsibility: "Playwright authorization member",
        roleIds: [roleId],
      },
    );
    expect(added.status).toBe(201);
    const memberId = added.body.id as string;

    const otherProjectName = `RBAC Other ${Date.now()}`;
    const otherProject = await api(ownerPage, "POST", "/projects", {
      name: otherProjectName,
      description: "Cross-project read isolation",
    });
    expect(otherProject.status).toBe(201);
    const otherProjectId = otherProject.body.id as string;
    const readableTask = await api(ownerPage, "POST", "/tasks", {
      projectId,
      title: "Readable E2E task",
      description: "Member may read this task",
    });
    expect(readableTask.status).toBe(201);
    const otherTask = await api(ownerPage, "POST", "/tasks", {
      projectId: otherProjectId,
      title: "Cross-project E2E task",
      description: "Member must not read this task",
    });
    expect(otherTask.status).toBe(201);
    const readableTaskId = readableTask.body.id as string;
    const otherTaskId = otherTask.body.id as string;
    expect(
      (await api(memberPage, "GET", `/tasks/${readableTaskId}`)).status,
    ).toBe(200);
    expect((await api(memberPage, "GET", `/tasks/${otherTaskId}`)).status).toBe(
      403,
    );
    expect((await api(adminPage, "GET", `/projects/${projectId}`)).status).toBe(
      403,
    );
    const memberProjects = await api(memberPage, "GET", "/projects");
    expect(memberProjects.status).toBe(200);
    expect(
      (memberProjects.body.items as Array<{ id: string }>).map(
        (item) => item.id,
      ),
    ).toEqual([projectId]);
    const memberTasks = await api(memberPage, "GET", "/tasks");
    expect(memberTasks.status).toBe(200);
    expect(
      (memberTasks.body.items as Array<{ projectId: string }>).every(
        (item) => item.projectId === projectId,
      ),
    ).toBe(true);

    const memberWrite = await api(
      memberPage,
      "PATCH",
      `/projects/${projectId}`,
      { description: "member write through project role" },
    );
    expect(memberWrite.status).toBe(200);

    const adminWrite = await api(adminPage, "PATCH", `/projects/${projectId}`, {
      description: "platform admin must not bypass projects",
    });
    expect(adminWrite.status).toBe(403);
    expect(adminWrite.body).toMatchObject({
      details: { reason: "membership_missing" },
    });

    const outsiderWrite = await api(
      outsiderPage,
      "PATCH",
      `/projects/${projectId}`,
      { description: "outsider write must fail" },
    );
    expect(outsiderWrite.status).toBe(403);

    const permissionReduced = await api(
      ownerPage,
      "PATCH",
      `/projects/${projectId}/roles/${roleId}`,
      { permissions: ["read"] },
    );
    expect(permissionReduced.status).toBe(200);
    await memberPage.reload();
    await memberPage.getByRole("button", { name: "项目", exact: true }).click();
    await expect(
      memberPage.getByRole("button", { name: new RegExp(projectName) }).first(),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("button", {
        name: new RegExp(otherProjectName),
      }),
    ).toHaveCount(0);
    await expect(
      memberPage.getByRole("button", { name: "项目设置" }),
    ).toBeDisabled();
    const deniedAfterReduction = await api(
      memberPage,
      "PATCH",
      `/projects/${projectId}`,
      { description: "write after permission reduction" },
    );
    expect(deniedAfterReduction.status).toBe(403);
    expect(deniedAfterReduction.body).toMatchObject({
      details: { reason: "permission_missing" },
    });
    const report = await api(
      memberPage,
      "GET",
      `/projects/${projectId}/authorization-report`,
    );
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      projectId,
      consistent: true,
    });

    const restored = await api(
      ownerPage,
      "PATCH",
      `/projects/${projectId}/roles/${roleId}`,
      { permissions: ["read", "write"] },
    );
    expect(restored.status).toBe(200);
    const revoked = await api(
      ownerPage,
      "PATCH",
      `/projects/${projectId}/members/${memberId}`,
      { roleIds: [] },
    );
    expect(revoked.status).toBe(200);
    const deniedAfterRevoke = await api(
      memberPage,
      "PATCH",
      `/projects/${projectId}`,
      { description: "write after Grant revocation" },
    );
    expect(deniedAfterRevoke.status).toBe(403);
    expect(deniedAfterRevoke.body).toMatchObject({
      details: { reason: "grant_missing" },
    });
    await memberPage.screenshot({
      path: `.tmp/batch14c-rbac-e2e-${Date.now()}.png`,
      fullPage: true,
    });
  } finally {
    await Promise.all([
      ownerContext.close(),
      memberContext.close(),
      adminContext.close(),
      outsiderContext.close(),
    ]);
  }
});
