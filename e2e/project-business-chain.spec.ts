import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("project business chain overview is operational and responsive", async ({
  page,
  request,
}) => {
  const headers = { "x-pluginmax-actor": "local-admin" };
  const suffix = randomUUID().slice(0, 8);
  const projectResponse = await request.post("/api/v1/projects", {
    headers,
    data: {
      name: `M11 项目概览 ${suffix}`,
      description: "M11 browser verification",
    },
  });
  expect(projectResponse.status()).toBe(201);
  const project = (await projectResponse.json()) as {
    id: string;
    name: string;
  };
  const settingsResponse = await request.get(
    `/api/v1/projects/${project.id}/business-chain`,
    { headers },
  );
  expect(settingsResponse.ok()).toBe(true);
  const settings = (await settingsResponse.json()) as {
    featureFlags: {
      businessChain: { revision: number };
      sourceMock: { revision: number };
    };
  };
  const flagsResponse = await request.patch(
    `/api/v1/projects/${project.id}/business-chain/flags`,
    {
      headers,
      data: {
        businessChainEnabled: true,
        expectedBusinessChainRevision:
          settings.featureFlags.businessChain.revision,
        sourceMockEnabled: true,
        expectedSourceMockRevision: settings.featureFlags.sourceMock.revision,
      },
    },
  );
  expect(flagsResponse.ok()).toBe(true);

  const workflowResponse = await request.post("/api/v1/workflows", {
    headers,
    data: {
      projectId: project.id,
      name: "订单交付工作流",
      description: "M11 browser flow",
      stepNames: ["接单", "履约"],
      stepRoleIds: [],
    },
  });
  expect(workflowResponse.status()).toBe(201);
  const workflow = (await workflowResponse.json()) as {
    id: string;
    revision: number;
  };
  const definitionResponse = await request.post(
    `/api/v1/workflows/${workflow.id}/business-chain`,
    {
      headers,
      data: {
        chainKey: "ORDER_DELIVERY",
        templateKey: "TEMPLATE_ORDER_DELIVERY",
        displayName: "订单交付链路",
        projectTypeCodes: ["ORDER"],
        snapshotPolicy: "pin-at-project-create",
        allowUnboundSources: false,
        nodes: [
          {
            sequence: 1,
            stageCode: "ORDER",
            summaryMetric: "订单金额",
            fields: [
              {
                key: "amount",
                label: "订单金额",
                bindings: [
                  {
                    refKey: "mock:order-ui",
                    sourceKind: "mock",
                    sourceSystem: "mock",
                    objectType: "order",
                    objectId: "order-ui",
                    path: "amount",
                    required: true,
                  },
                ],
              },
            ],
          },
        ],
        expectedRevision: workflow.revision,
      },
    },
  );
  expect(definitionResponse.ok()).toBe(true);
  const definition = (await definitionResponse.json()) as { id: string };
  const bindResponse = await request.post(
    `/api/v1/projects/${project.id}/business-chain/bind`,
    {
      headers,
      data: {
        workflowDefinitionId: definition.id,
        nodeBindings: [],
        expectedRevision: 0,
        reason: "M11 browser binding",
        upgrade: false,
      },
    },
  );
  expect(bindResponse.status()).toBe(201);
  const refreshResponse = await request.post(
    `/api/v1/projects/${project.id}/business-chain/refresh`,
    {
      headers,
      data: { timeoutMs: 8_000 },
    },
  );
  expect(refreshResponse.ok()).toBe(true);
  const taskResponse = await request.post("/api/v1/tasks", {
    headers,
    data: {
      projectId: project.id,
      title: "验证业务链路概览",
      description: "Browser overview task",
      acceptance: ["overview shows current task"],
      agentId: "00000000-0000-4000-8000-000000000001",
    },
  });
  expect(taskResponse.status()).toBe(201);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page
    .locator("button.pm-directory-row")
    .filter({ hasText: project.name })
    .click();
  await expect(page.getByText("业务链路", { exact: true })).toBeVisible();
  await expect(page.getByText("订单交付链路").first()).toBeVisible();
  await expect(page.getByText("最新", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("业务阶段", { exact: true })).toBeVisible();
  await expect(page.getByText("验证业务链路概览")).toBeVisible();
  await page.screenshot({
    path: ".tmp/m11-project-overview-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("业务链路", { exact: true })).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await page.screenshot({
    path: ".tmp/m11-project-overview-mobile.png",
    fullPage: true,
  });
});
