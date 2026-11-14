import { expect, test, type APIResponse } from "@playwright/test";
import pg from "../packages/database/node_modules/pg/lib/index.js";

const { Client } = pg;

interface Project {
  readonly id: string;
}

interface Agent {
  readonly id: string;
}

interface Task {
  readonly id: string;
}

interface Meeting {
  readonly id: string;
}

interface Workflow {
  readonly id: string;
}

interface WorkflowInstance {
  readonly id: string;
}

interface Delegation {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("Delegation center lifecycle, confirmations, reports and responsive boundaries", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const post = async <T>(path: string, data?: unknown): Promise<T> =>
    json<T>(
      await request.post(path, {
        ...(data === undefined ? {} : { data }),
        headers: { "content-type": "application/json" },
      }),
    );

  const project = await post<Project>("/api/v1/projects", {
    name: `Delegation browser ${stamp}`,
    description: "Human Avatar browser fixture",
  });
  const agent = await post<Agent>("/api/v1/agents", {
    name: `Avatar representative ${stamp}`,
    description: "Scoped representative for browser verification",
    runtimeKind: "fake",
  });
  const role = await post<{ id: string }>(
    `/api/v1/projects/${project.id}/roles`,
    {
      name: `Avatar writer ${stamp}`,
      permissions: ["read", "write"],
    },
  );
  await post(`/api/v1/projects/${project.id}/members`, {
    kind: "agent",
    agentId: agent.id,
    responsibility: "Represent the owner in scoped contexts",
    roleIds: [role.id],
  });
  const task = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Delegated task ${stamp}`,
    description: "Browser task context for a Human Avatar",
    agentId: agent.id,
  });
  const wizardTask = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Wizard task ${stamp}`,
    description: "Create a Delegation from the browser wizard",
    agentId: agent.id,
  });
  const meeting = await post<Meeting>("/api/v1/meetings", {
    projectId: project.id,
    title: `Delegated meeting ${stamp}`,
    agenda: "Verify Meeting Delegate compatibility",
    agentIds: [agent.id],
  });
  const markdown = `# 工作流：委托浏览器 ${stamp}

## 元信息

- key: delegation-browser-${stamp}
- version: 1

## 节点

### 评审

- id: review
- type: service
- executor: user:local-admin

### 完成

- id: done
- type: service
- executor: user:local-admin

## 连接

- review -> done`;
  const workflow = await post<Workflow>("/api/v1/workflows/import", {
    projectId: project.id,
    markdown,
  });
  const workflowInstance = await post<WorkflowInstance>(
    `/api/v1/workflows/${workflow.id}/start`,
    {
      title: `Delegation workflow ${stamp}`,
      context: {},
    },
  );

  const basePayload = {
    representativeKind: "ai",
    representativeAgentId: agent.id,
    workspaceId: project.id,
    projectId: project.id,
    objective: "Review the context and return a bounded owner report.",
    stance: "Preserve the owner's current delivery position.",
    watchItems: ["approval boundary", "scope drift"],
    materialScopes: [`project:${project.id}`],
    autoParticipation: "mentions",
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
    reportRequired: true,
  };
  const taskDelegation = await post<Delegation>("/api/v1/delegations", {
    ...basePayload,
    displayName: `Task avatar ${stamp}`,
    contextType: "task",
    contextId: task.id,
  });
  await post(`/api/v1/delegations/${taskDelegation.id}/activate`, {
    expectedRevision: taskDelegation.revision,
    reason: "Activate task avatar",
  });
  const workflowDelegation = await post<Delegation>("/api/v1/delegations", {
    ...basePayload,
    displayName: `Workflow avatar ${stamp}`,
    contextType: "workflow_instance",
    contextId: workflowInstance.id,
    approvalPolicy: "require-confirmation",
    allowedActions: ["read_context", "submit_deliverable"],
  });
  await post(`/api/v1/delegations/${workflowDelegation.id}/activate`, {
    expectedRevision: workflowDelegation.revision,
    reason: "Activate workflow avatar",
  });
  const confirmation = await post<{ id: string }>(
    `/api/v1/delegations/${workflowDelegation.id}/confirmations`,
    {
      action: "submit_deliverable",
      targetType: "workflow_node",
      targetId: `${workflowInstance.id}:review`,
      proposedPayloadHash: "d".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    },
  );
  const meetingDelegation = await post<Delegation>("/api/v1/delegations", {
    ...basePayload,
    displayName: `Meeting avatar ${stamp}`,
    contextType: "meeting",
    contextId: meeting.id,
  });
  await post(`/api/v1/delegations/${meetingDelegation.id}/activate`, {
    expectedRevision: meetingDelegation.revision,
    reason: "Activate meeting avatar",
  });

  await page.goto("/");
  await page.getByRole("button", { name: "委托中心", exact: true }).click();
  const center = page.locator(".delegation-center");
  await expect(center).toBeVisible();
  await expect(center).toContainText(`Task avatar ${stamp}`);
  await expect(center).toContainText(`Workflow avatar ${stamp}`);
  await expect(center).toContainText(`Meeting avatar ${stamp}`);

  await center
    .locator(".delegation-list > button")
    .filter({ hasText: `Workflow avatar ${stamp}` })
    .click();
  await expect(center).toContainText("有效权限");
  await expect(center).toContainText("需主人确认");
  await center.getByRole("button", { name: "允许", exact: true }).click();
  await expect(center).toContainText("approved");

  await center.getByRole("button", { name: "新建委托" }).click();
  await center.getByLabel("上下文 ID").fill(wizardTask.id);
  await center.getByRole("button", { name: "下一步" }).click();
  await center
    .getByLabel("Teammate / Agent")
    .selectOption({ label: `Avatar representative ${stamp}` });
  await center
    .getByLabel("展示名称")
    .fill(`Wizard avatar ${stamp}`);
  await center.getByRole("button", { name: "下一步" }).click();
  await center
    .getByLabel("目标")
    .fill("Verify the create wizard and permission preview.");
  await center.getByRole("button", { name: "下一步" }).click();
  await expect(center).toContainText("有效权限预览");
  await center.getByRole("button", { name: "创建并激活" }).click();
  await expect(center).toContainText(`Wizard avatar ${stamp}`);
  await expect(center).toContainText("生效中");

  await center
    .locator(".delegation-list > button")
    .filter({ hasText: `Task avatar ${stamp}` })
    .click();
  await center.getByTitle("暂停委托").click();
  await expect(center).toContainText("已暂停");
  await center.getByTitle("恢复委托").click();
  await expect(center).toContainText("生效中");
  await center
    .getByLabel("新的到期时间")
    .fill(new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 16));
  await center.getByRole("button", { name: "延期" }).click();

  const database = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await database.connect();
  try {
    await database.query(
      `INSERT INTO delegation_reports (
         delegation_id, status, attempt_count, error_code, error_message,
         created_at, updated_at
       ) VALUES (
         $1, 'failed', 5, 'report_backend_unavailable',
         'Report backend unavailable for browser verification', NOW(), NOW()
       )
       ON CONFLICT (delegation_id) DO UPDATE
       SET status = 'failed', attempt_count = 5,
           error_code = EXCLUDED.error_code,
           error_message = EXCLUDED.error_message,
           updated_at = NOW()`,
      [meetingDelegation.id],
    );
  } finally {
    await database.end();
  }
  await page.reload();
  await page.getByRole("button", { name: "委托中心", exact: true }).click();
  await center
    .locator(".delegation-list > button")
    .filter({ hasText: `Meeting avatar ${stamp}` })
    .click();
  await expect(center).toContainText("报告生成失败");
  await expect(center).toContainText("Report backend unavailable");
  await center.getByRole("button", { name: "重试" }).click();
  await expect(center).not.toContainText("报告生成失败");

  await center
    .locator(".delegation-list > button")
    .filter({ hasText: `Task avatar ${stamp}` })
    .click();
  await center.getByTitle("召回委托").click();
  await expect(center).toContainText("已召回");

  await expect(
    center
      .locator(".delegation-list > button")
      .filter({ hasText: `Workflow avatar ${stamp}` })
      .getByText("生效中", { exact: true }),
  ).toBeVisible();

  const assertNoOverflow = async () => {
    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      centerWidth: document.querySelector(".delegation-center")?.scrollWidth,
      centerClient:
        document.querySelector(".delegation-center")?.clientWidth,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(
      dimensions.viewportWidth + 1,
    );
    expect(dimensions.centerWidth ?? 0).toBeLessThanOrEqual(
      (dimensions.centerClient ?? 0) + 1,
    );
  };

  await page.setViewportSize({ width: 1440, height: 960 });
  await assertNoOverflow();
  await page.screenshot({
    path: `.tmp/delegation-center-1440-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 900 });
  await assertNoOverflow();
  await page.screenshot({
    path: `.tmp/delegation-center-900-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoOverflow();
  await page.screenshot({
    path: `.tmp/delegation-center-390-${stamp}.png`,
    fullPage: true,
  });

  expect(confirmation.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
