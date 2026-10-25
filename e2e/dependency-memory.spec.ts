import { expect, test, type APIResponse } from "@playwright/test";

interface Agent {
  id: string;
}

interface Project {
  id: string;
  name: string;
}

interface ProjectRole {
  id: string;
  name: string;
}

interface Task {
  id: string;
  title: string;
}

interface MemoryTopic {
  id: string;
  title: string;
  currentTruth: { version: number } | null;
}

interface MemoryClaim {
  id: string;
}

async function json<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${body.message ?? ""}`);
  }
  return body;
}

test("project role, task dependency and structured memory", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const post = async <T>(path: string, data: unknown): Promise<T> =>
    json<T>(
      await request.post(path, {
        data,
        headers: { "content-type": "application/json" },
      }),
    );
  const patch = async <T>(path: string, data: unknown): Promise<T> =>
    json<T>(
      await request.patch(path, {
        data,
        headers: { "content-type": "application/json" },
      }),
    );

  const agent = await post<Agent>("/api/v1/agents", {
    name: `Browser dependency agent ${stamp}`,
    runtimeKind: "fake",
  });
  const project = await post<Project>("/api/v1/projects", {
    name: `Browser batch3b ${stamp}`,
  });
  const role = await post<ProjectRole>(`/api/v1/projects/${project.id}/roles`, {
    name: `Browser delivery role ${stamp}`,
    description: "Playwright role assignment",
  });
  await post(`/api/v1/projects/${project.id}/members`, {
    kind: "agent",
    agentId: agent.id,
    roleIds: [role.id],
  });
  const blocker = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Browser prerequisite ${stamp}`,
    description: "Must finish first.",
    agentId: agent.id,
  });
  const dependent = await post<Task>("/api/v1/tasks", {
    projectId: project.id,
    title: `Browser dependent ${stamp}`,
    description: "Waits for the prerequisite.",
    roleId: role.id,
    dependsOn: [blocker.id],
  });

  const topic = await post<MemoryTopic>(
    `/api/v1/projects/${project.id}/memory/topics`,
    { title: `Browser delivery truth ${stamp}` },
  );
  const firstClaim = await post<MemoryClaim>(
    `/api/v1/projects/${project.id}/memory/topics/${topic.id}/claims`,
    { content: "The contract is versioned." },
  );
  await patch(
    `/api/v1/projects/${project.id}/memory/topics/${topic.id}/claims/${firstClaim.id}`,
    { status: "confirmed" },
  );
  await post(
    `/api/v1/projects/${project.id}/memory/topics/${topic.id}/truths`,
    { claimIds: [firstClaim.id] },
  );
  const secondClaimText = "Browser regression covers the dependency gate.";
  const secondClaim = await post<MemoryClaim>(
    `/api/v1/projects/${project.id}/memory/topics/${topic.id}/claims`,
    { content: secondClaimText },
  );
  await patch(
    `/api/v1/projects/${project.id}/memory/topics/${topic.id}/claims/${secondClaim.id}`,
    { status: "confirmed" },
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
  await page
    .locator(".sidebar-project-list button")
    .filter({ hasText: project.name })
    .first()
    .click();
  await page.getByRole("button", { name: /项目记忆/ }).click();
  const memoryCard = page
    .locator(".memory-topic-card")
    .filter({ hasText: topic.title })
    .first();
  await expect(memoryCard).toContainText(secondClaimText);
  await memoryCard
    .locator(".memory-claim")
    .filter({ hasText: secondClaimText })
    .getByRole("checkbox")
    .check();
  await memoryCard.getByRole("button", { name: "发布 Truth" }).click();
  await expect(memoryCard).toContainText("Current Truth v2");

  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "任务项目" })
    .selectOption(project.id);
  await page
    .locator(".task-board-card")
    .filter({ hasText: dependent.title })
    .click();
  const detail = page.getByRole("region", { name: "任务详情" });
  await expect(detail).toContainText(blocker.title);
  await expect(detail).toContainText("前置任务未完成，暂不能派发");
  await expect(detail.getByRole("button", { name: "派发执行" })).toBeDisabled();

  await page.screenshot({
    path: `.tmp/batch3b-dependency-memory-${stamp}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail).toContainText("前置依赖");
  await page.screenshot({
    path: `.tmp/batch3b-dependency-memory-mobile-${stamp}.png`,
    fullPage: true,
  });
});
