import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canReviewTask,
  createTaskDispatcher,
  createTaskDocumentQueryService,
  createTaskRoutes,
  taskContextContributions,
} from "./index.js";
import {
  orderQueue,
  pickNextTask,
  TaskService,
  type KvTableLike,
} from "./service.js";
import type { TaskRecord } from "./types.js";
import {
  attachmentDocuments,
  collectDocuments,
  extractAgentOutputDocuments,
  materializeAgentOutputDocuments,
  mergeDocuments,
  safeFileName,
  windowsFromRuns,
} from "./documents.js";

function memoryTable<V>(): KvTableLike<V> {
  const values = new Map<string, V>();
  return {
    get: (key) => values.get(key),
    entries: () => values.entries(),
    keys: () => values.keys(),
    get size() {
      return values.size;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
  };
}

function service(): TaskService {
  return new TaskService({ tasks: memoryTable<TaskRecord>() });
}

const olivia = { id: "olivia", name: "Olivia", kind: "human" as const };

describe("dsh-collab-task service", () => {
  it("separates review authority from task assignment", async () => {
    const tasks = service();
    const task = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Review authority",
      priority: "P2",
      receiverType: "human",
      receiverId: "worker",
      receiverName: "Worker",
      description: "Verify reviewer selection.",
      acceptance: ["Only authorized reviewers can approve"],
    });
    const team = {
      resolveToken: () => undefined,
      users: () => [
        { id: "admin", name: "Admin", role: "admin" },
        { id: "owner", name: "Owner", role: "member" },
        { id: "approver", name: "Approver", role: "member" },
        { id: "worker", name: "Worker", role: "member" },
      ],
      members: () => [
        { userId: "owner", memberRole: "owner" },
        { userId: "worker", memberRole: "member" },
        { userId: "approver", memberRole: "member" },
      ],
    };
    const assignments = {
      config: () => ({
        seats: [
          { id: "builder", label: "Builder", permissions: ["read", "write"] },
          {
            id: "reviewer",
            label: "Reviewer",
            permissions: ["read", "approve"],
          },
        ],
      }),
      members: (_workspaceId: string, seatId: string) =>
        seatId === "reviewer"
          ? [
              {
                seatId,
                assigneeKind: "user" as const,
                assigneeId: "approver",
                status: "assigned" as const,
              },
            ]
          : [],
    };
    const canReview = (actor: { id: string; role: "admin" | "member" }) =>
      canReviewTask({
        task,
        actor: { ...actor, name: actor.id, kind: "human" },
        team,
        assignments,
      });
    expect(canReview({ id: "admin", role: "admin" })).toBe(true);
    expect(canReview({ id: "olivia", role: "member" })).toBe(true);
    expect(canReview({ id: "owner", role: "member" })).toBe(true);
    expect(canReview({ id: "approver", role: "member" })).toBe(true);
    expect(canReview({ id: "worker", role: "member" })).toBe(false);
  });

  it("creates, assigns, claims, transitions, comments, and replies", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Review task board",
      priority: "P2",
      receiverType: "role",
      receiverId: "review-guild",
      receiverName: "Review Guild",
      description: "Validate the task management demo.",
      acceptance: ["Board renders", "Role task can be claimed"],
      due: "2026-09-24",
    });
    expect(created.status).toBe("todo");
    expect(created.events).toHaveLength(1);

    const claimed = await tasks.claim(olivia, created.id);
    expect(claimed.receiverType).toBe("human");
    expect(claimed.receiverId).toBe("olivia");
    expect(claimed.status).toBe("progress");

    await tasks.toggleStep(olivia, {
      taskId: created.id,
      stepId: created.steps[0]!.id,
      done: true,
    });
    const review = await tasks.submit(olivia, created.id);
    expect(review.status).toBe("review");
    expect(review.progress).toBeGreaterThanOrEqual(86);
    expect(review.steps.map((step) => step.done)).toEqual([true, false]);

    const commented = await tasks.addComment(olivia, {
      taskId: created.id,
      content: "Please include the workflow link.",
    });
    const commentId = commented.comments[0]?.id;
    expect(commentId).toBeDefined();
    expect(commented.comments[0]?.isKeyConsensus).toBe(false);
    const consensus = await tasks.addComment(olivia, {
      taskId: created.id,
      content: "风险章节使用统一口径，并保留来源链接。",
      isKeyConsensus: true,
    });
    expect(consensus.comments.at(-1)).toMatchObject({
      content: "风险章节使用统一口径，并保留来源链接。",
      isKeyConsensus: true,
    });
    expect(consensus.events.at(-1)?.message).toBe("Olivia 添加了关键共识");
    const replied = await tasks.replyComment(olivia, {
      taskId: created.id,
      commentId: commentId!,
      content: "Added.",
    });
    expect(replied.comments[0]?.replies[0]?.content).toBe("Added.");

    const done = await tasks.approve(olivia, created.id);
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
  });

  it("exposes key consensus as structured context contributions", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Context contributions",
      priority: "P2",
      receiverType: "unassigned",
      description: "Collect confirmed decisions.",
      acceptance: ["Decision is recorded"],
    });
    await tasks.addComment(olivia, {
      taskId: created.id,
      content: "这条只是讨论",
    });
    await tasks.addComment(olivia, {
      taskId: created.id,
      content: "正文控制在 1000 字以内。",
      isKeyConsensus: true,
    });
    const contributions = taskContextContributions(tasks.get(created.id));
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      id: expect.stringMatching(/^task-consensus:/),
      text: expect.stringContaining("正文控制在 1000 字以内。"),
      sourceRefs: [
        {
          type: "task-comment",
          version: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(contributions)).not.toContain("这条只是讨论");
  });

  it("refuses review submission without a completed acceptance item", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Acceptance check",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Do not submit an empty acceptance state.",
      acceptance: ["Scope checked", "Risk recorded"],
    });

    await expect(tasks.submit(olivia, created.id)).rejects.toMatchObject({
      code: "conflict",
      message: "提交验收前至少需要完成一项验收标准",
    });
    const unchanged = tasks.get(created.id);
    expect(unchanged.status).toBe("progress");
    expect(unchanged.steps.map((step) => step.done)).toEqual([false, false]);
  });

  it("requires all acceptance items before a no-review task can close", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "No review acceptance",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "All acceptance items gate direct completion.",
      acceptance: ["Scope checked", "Risk recorded"],
      autoSubmitReview: false,
    });
    await tasks.toggleStep(olivia, {
      taskId: created.id,
      stepId: created.steps[0]!.id,
      done: true,
    });
    await expect(tasks.submit(olivia, created.id)).rejects.toMatchObject({
      code: "conflict",
      message: "标记任务完成前需勾选全部验收标准",
    });
    await tasks.toggleStep(olivia, {
      taskId: created.id,
      stepId: created.steps[1]!.id,
      done: true,
    });
    const completed = await tasks.submit(olivia, created.id);
    expect(completed.status).toBe("done");
    expect(completed.progress).toBe(100);
  });

  it("requires and records a rejection note", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Reject with explanation",
      priority: "P2",
      status: "review",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Rejections must explain what remains incomplete.",
      acceptance: ["Risk section is complete"],
    });

    await expect(tasks.reject(olivia, created.id, "   ")).rejects.toMatchObject(
      {
        code: "invalid_input",
        message: "退回必须填写退回说明",
      },
    );
    expect(tasks.get(created.id).status).toBe("review");

    const rejected = await tasks.reject(
      olivia,
      created.id,
      "缺少风险项，请补充影响范围和应对措施",
    );
    expect(rejected.status).toBe("progress");
    expect(rejected.messages.at(-1)).toMatchObject({
      kind: "human",
      content: "缺少风险项，请补充影响范围和应对措施",
      deliveryTarget: "receiver",
    });
    expect(rejected.events.at(-1)?.message).toContain(
      "退回并补充说明：缺少风险项",
    );
  });

  it("rejects invalid create input", async () => {
    const tasks = service();
    await expect(
      tasks.create(olivia, {
        workspaceId: "workspace-1",
        title: "",
        priority: "P9",
        receiverType: "human",
        description: "",
        acceptance: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps cancelled workflow tasks distinct from completed tasks", async () => {
    const tasks = service();
    const system = { id: "workflow", name: "系统", kind: "system" } as const;
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Cancelled workflow delivery",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "A manual workflow cancellation must remain cancelled.",
      acceptance: ["Run the agent", "Return the delivery"],
      workflow: {
        instanceId: "wf-cancel",
        nodeId: "development",
        instanceTitle: "Cancelled workflow",
        nodeName: "Development",
        reviewRequired: true,
      },
    });
    const reviewing = await tasks.projectStatus(
      system,
      created.id,
      "review",
      "Agent 已提交交付物",
    );
    const cancelled = await tasks.settleProjection(
      system,
      created.id,
      "cancelled",
    );

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.progress).toBe(reviewing.progress);
    expect(cancelled.steps.every((step) => !step.done)).toBe(true);
    expect(cancelled.workflow?.outcome).toBe("cancelled");
    expect(cancelled.events.at(-1)).toMatchObject({
      kind: "closed",
      message: "工作流节点已取消",
    });
    await expect(
      tasks.assign(olivia, {
        taskId: created.id,
        receiverType: "human",
        receiverId: "olivia",
        receiverName: "Olivia",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.changeStatus(olivia, { taskId: created.id, status: "progress" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.addComment(olivia, { taskId: created.id, content: " revisit " }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.settleProjection(system, created.id, "approved"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("repairs legacy manual cancellations that were stored as approved tasks", async () => {
    const table = memoryTable<TaskRecord>();
    const tasks = new TaskService({ tasks: table });
    const system = { id: "workflow", name: "系统", kind: "system" } as const;
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Legacy cancelled projection",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Legacy cancellation data should be repaired safely.",
      acceptance: ["Run the agent"],
      workflow: {
        instanceId: "wf-legacy",
        nodeId: "development",
        instanceTitle: "Legacy workflow",
        nodeName: "Development",
        reviewRequired: true,
      },
    });
    await tasks.settleProjection(system, created.id, "approved");
    const legacy = table.get(created.id)!;
    table.put(created.id, {
      ...legacy,
      workflow: { ...legacy.workflow!, outcome: "approved" },
    });
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: () => {},
      submit: () => {},
      reconcile: () => "cancelled",
    });

    await tasks.reconcileWorkflowProjections("workspace-1");
    const repaired = tasks.get(created.id);
    expect(repaired.status).toBe("cancelled");
    expect(repaired.progress).toBe(0);
    expect(repaired.steps.every((step) => !step.done)).toBe(true);
    expect(repaired.workflow?.outcome).toBe("cancelled");
    expect(repaired.events.at(-1)?.message).toBe("修正历史取消状态");
    table.put(created.id, {
      ...repaired,
      progress: 100,
      steps: repaired.steps.map((step) => ({ ...step, done: true })),
    });
    await tasks.reconcileWorkflowProjections("workspace-1");
    const residualRepaired = tasks.get(created.id);
    expect(residualRepaired.progress).toBe(0);
    expect(residualRepaired.steps.every((step) => !step.done)).toBe(true);
    await tasks.reconcileWorkflowProjections("workspace-1");
    expect(
      tasks
        .get(created.id)
        .events.filter((event) => event.message === "修正历史取消状态"),
    ).toHaveLength(2);
  });

  it("hands an auto-submitted agent task back to the instance owner", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Agent task",
      priority: "P1",
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "Research Agent",
      description: "Do the thing.",
      acceptance: ["done"],
    });
    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-9",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "交付完成" },
      },
      "Research Agent",
      { userId: "olivia", name: "Olivia" },
    );
    expect(completed.status).toBe("review");
    expect(completed.receiverType).toBe("human");
    expect(completed.receiverId).toBe("olivia");
    expect(completed.receiverName).toBe("Olivia");
    expect(completed.events.at(-1)?.message).toBe(
      "Research Agent 完成产出物，已提交 Olivia 确认",
    );
  });

  it("records queued and completed agent executions on the task", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Delegate to an agent",
      priority: "P1",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Prepare a concise implementation note.",
      acceptance: ["Return a concise note"],
    });
    const queued = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-1",
        instanceId: created.id,
        status: "queued",
      },
      "Backend DE",
    );
    expect(queued.status).toBe("progress");
    expect(queued.agentRunIds).toEqual(["run-1"]);
    expect(queued.messages[0]).toMatchObject({
      runId: "run-1",
      runRole: "owner",
      state: "queued",
      authorName: "Backend DE",
    });

    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-1",
        instanceId: created.id,
        status: "succeeded",
        execution: {
          provider: "custom",
          model: "deepseek-flash",
          runtime: "Codex CLI",
          runtimeVersion: "0.163.0-alpha.10.2",
          authMode: "api-key",
          sandbox: "read-only / network restricted",
        },
        output: { summary: "Implementation note completed." },
      },
      "Backend DE",
    );
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      runId: "run-1",
      state: "succeeded",
      content: "Implementation note completed.",
      execution: {
        provider: "custom",
        model: "deepseek-flash",
        runtime: "Codex CLI",
        runtimeVersion: "0.163.0-alpha.10.2",
        authMode: "api-key",
        sandbox: "read-only / network restricted",
      },
    });
  });

  it("creates tasks in the requested initial status", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Start in progress",
      priority: "P2",
      status: "progress",
      receiverType: "unassigned",
      description: "Created from a kanban column.",
      acceptance: ["Task is visible in the selected column"],
    });
    expect(created.status).toBe("progress");
  });

  it("reconciles only active workflow task projections", async () => {
    const tasks = service();
    const workflowTask = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Stale workflow projection",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "The workflow node is already complete.",
      acceptance: ["Projection settles"],
      autoSubmitReview: true,
      workflow: {
        instanceId: "wf-1",
        nodeId: "confirm",
        instanceTitle: "Delivery",
        nodeName: "Confirm",
        reviewRequired: true,
      },
    });
    await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Ordinary task",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Stay untouched by workflow reconciliation.",
      acceptance: ["No workflow reconciliation"],
      autoSubmitReview: false,
    });

    const reconciled: string[] = [];
    const refreshedReceivers: string[] = [];
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: () => {},
      submit: () => {},
      reconcile: (task) => {
        reconciled.push(task.id);
        return "approved";
      },
      refreshReceiver: (task) => {
        refreshedReceivers.push(task.id);
      },
      events: () => [
        {
          id: "workflow-event-1",
          instanceId: "wf-1",
          nodeId: "confirm",
          actorId: "olivia",
          actorKind: "user",
          actorName: "Olivia",
          message: "完成节点：Confirm",
          at: "2026-09-28T10:00:00.000Z",
        },
      ],
    });
    await tasks.reconcileWorkflowProjections("workspace-1");
    expect(reconciled).toEqual([workflowTask.id]);
    await tasks.reconcileWorkflowProjections("workspace-1");
    expect(refreshedReceivers).toEqual([workflowTask.id]);
    const settled = tasks.get(workflowTask.id);
    expect(settled.status).toBe("done");
    expect(settled.workflow?.outcome).toBe("approved");
    expect(settled.events.at(-1)?.message).toBe("工作流节点完成");
    expect(
      settled.events.some((event) => event.id === "workflow-event-1"),
    ).toBe(true);
  });

  it("auto-submits an agent task for review once the run succeeds", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Auto submit on agent completion",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Produce the release note.",
      acceptance: ["Release note is attached", "Risk list is present"],
    });
    expect(created.autoSubmitReview).toBe(true);

    await tasks.attachAgentRun(
      created.id,
      { id: "run-auto", instanceId: created.id, status: "running" },
      "Backend DE",
    );
    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-auto",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "Release note ready." },
      },
      "Backend DE",
    );
    expect(completed.status).toBe("review");
    expect(completed.progress).toBeGreaterThanOrEqual(86);
    expect(completed.steps[0]?.done).toBe(true);
    expect(completed.events.at(-1)?.message).toContain("自动提交验收");
  });

  it("keeps an agent task in progress when auto submit is disabled", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Manual review only",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Stay in progress after completion.",
      acceptance: ["Manual hand-off"],
      autoSubmitReview: false,
    });
    expect(created.autoSubmitReview).toBe(false);

    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-manual",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "Done, awaiting manual submit." },
      },
      "Backend DE",
    );
    expect(completed.status).toBe("progress");
    expect(completed.events.at(-1)?.message).toContain("返回了执行反馈");
  });

  it("direct-completes a workflow agent task when review is disabled", async () => {
    const tasks = service();
    const submitted: string[] = [];
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: () => {},
      submit: (task) => {
        submitted.push(task.status);
      },
    });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Agent workflow task",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Complete the workflow node directly.",
      acceptance: ["Implementation note ready"],
      autoSubmitReview: false,
      workflow: {
        instanceId: "wf-1",
        nodeId: "development",
        instanceTitle: "Delivery",
        nodeName: "Development",
        reviewRequired: false,
      },
    });
    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-direct",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "Node output ready." },
      },
      "Backend DE",
    );
    expect(completed.status).toBe("done");
    expect(completed.progress).toBe(100);
    expect(completed.steps.map((step) => step.done)).toEqual([true]);
    expect(submitted).toEqual(["done"]);
  });

  it("does not direct-complete approval tasks when an agent run succeeds", async () => {
    const tasks = service();
    const callbacks: string[] = [];
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: (_task, _actor, decision) => {
        callbacks.push(decision);
      },
      submit: () => {
        callbacks.push("submitted");
      },
    });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Agent approval task",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Approver DE",
      description: "Give an explicit approval decision.",
      acceptance: ["Decision recorded"],
      autoSubmitReview: false,
      workflow: {
        instanceId: "wf-1",
        nodeId: "release-approval",
        instanceTitle: "Delivery",
        nodeName: "Release Approval",
        approvalPolicy: "all",
      },
    });
    const completed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-approval",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "Review notes ready." },
      },
      "Approver DE",
    );
    expect(completed.status).toBe("progress");
    expect(callbacks).toEqual([]);
  });

  it("syncs workflow task decisions and protects approval assignees", async () => {
    const tasks = service();
    const events: Array<{ kind: string; decision?: string | undefined }> = [];
    tasks.bindWorkflowActions({
      assign: (task) => {
        events.push({ kind: "assigned", decision: task.receiverId });
      },
      decide: (_task, _actor, decision) => {
        events.push({ kind: "decision", decision });
      },
      submit: (task) => {
        events.push({ kind: "submitted", decision: task.status });
      },
    });

    const execution = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Workflow execution task",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Complete the node.",
      acceptance: ["Node output is ready"],
      autoSubmitReview: false,
      workflow: {
        instanceId: "wf-1",
        nodeId: "development",
        instanceTitle: "Delivery",
        nodeName: "Development",
        reviewRequired: false,
      },
    });
    const completed = await tasks.submit(olivia, execution.id);
    expect(completed.status).toBe("done");
    expect(events).toContainEqual({ kind: "submitted", decision: "progress" });

    const approval = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Workflow approval task",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Approve the node.",
      acceptance: ["Give a decision"],
      autoSubmitReview: false,
      workflow: {
        instanceId: "wf-1",
        nodeId: "approval",
        instanceTitle: "Delivery",
        nodeName: "Approval",
        approvalPolicy: "all",
        reviewRequired: false,
      },
    });
    expect(approval.autoSubmitReview).toBe(false);
    await expect(
      tasks.assign(olivia, {
        taskId: approval.id,
        receiverType: "unassigned",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await tasks.assign(olivia, {
      taskId: approval.id,
      receiverType: "human",
      receiverId: "member",
      receiverName: "Member",
    });
    expect(events).toContainEqual({ kind: "assigned", decision: "member" });
    const rejected = await tasks.reject(olivia, approval.id, "审批资料不完整");
    expect(rejected.status).toBe("done");
    expect(rejected.workflow?.outcome).toBe("rejected");
    expect(rejected.messages.at(-1)?.content).toBe("审批资料不完整");
    expect(events).toContainEqual({ kind: "decision", decision: "rejected" });
  });

  it("auto-approves a human workflow task after submission", async () => {
    const tasks = service();
    const submitted: string[] = [];
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: () => {},
      submit: (task) => {
        submitted.push(task.status);
      },
    });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Human workflow execution",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Submit the completed deliverable.",
      acceptance: ["PRD is ready"],
      workflow: {
        instanceId: "wf-human",
        nodeId: "prd",
        instanceTitle: "Product delivery",
        nodeName: "PRD",
        reviewRequired: true,
      },
    });

    expect(created.autoApproveReview).toBe(false);
    const configured = await tasks.updateReviewApproval(olivia, {
      taskId: created.id,
      autoApproveReview: true,
    });
    expect(configured.autoApproveReview).toBe(true);

    const completed = await tasks.submit(olivia, configured.id);
    expect(completed.status).toBe("done");
    expect(completed.progress).toBe(100);
    expect(completed.steps.map((step) => step.done)).toEqual([true]);
    expect(submitted).toEqual(["progress"]);
  });

  it("settles an in-review workflow task when auto approval is enabled", async () => {
    const tasks = service();
    const submitted: string[] = [];
    tasks.bindWorkflowActions({
      assign: () => {},
      decide: () => {},
      submit: (task) => {
        submitted.push(task.status);
      },
    });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Existing human review task",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "The task is already waiting for review.",
      acceptance: ["PRD is ready"],
      workflow: {
        instanceId: "wf-review",
        nodeId: "prd",
        instanceTitle: "Product delivery",
        nodeName: "PRD",
        reviewRequired: true,
      },
    });
    await tasks.submit(olivia, created.id);
    expect(tasks.get(created.id).status).toBe("review");

    const completed = await tasks.updateReviewApproval(olivia, {
      taskId: created.id,
      autoApproveReview: true,
    });
    expect(completed.status).toBe("done");
    expect(submitted).toEqual(["review"]);
  });

  it("does not auto-submit when the agent run fails", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Failing agent run",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Failure must not enter review.",
      acceptance: ["Failure stays in progress"],
    });

    await tasks.attachAgentRun(
      created.id,
      { id: "run-fail", instanceId: created.id, status: "running" },
      "Backend DE",
    );
    const failed = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-fail",
        instanceId: created.id,
        status: "failed",
        error: "Tool crashed",
      },
      "Backend DE",
    );
    expect(failed.status).toBe("progress");
  });

  it("projects workflow status changes without allowing local status ownership", async () => {
    const tasks = service();
    const system = { id: "workflow", name: "系统", kind: "system" } as const;
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Workflow projection",
      priority: "P2",
      status: "progress",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "The workflow controls this task.",
      acceptance: ["Node output ready"],
      workflow: {
        instanceId: "wf-1",
        nodeId: "development",
        instanceTitle: "Delivery",
        nodeName: "Development",
        reviewRequired: true,
      },
    });
    const projected = await tasks.projectStatus(
      system,
      created.id,
      "review",
      "Agent 已提交交付物，等待人工 Review",
    );
    expect(projected.status).toBe("review");
    expect(projected.progress).toBeGreaterThanOrEqual(86);
    expect(projected.events.at(-1)?.message).toContain("等待人工 Review");
    await expect(
      tasks.changeStatus(olivia, { taskId: created.id, status: "todo" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.projectStatus(system, created.id, "review", "等待人工 Review"),
    ).resolves.toStrictEqual(projected);
    const workflowEvent = await tasks.projectWorkflowEvent(system, created.id, {
      id: "workflow-event-1",
      instanceId: "wf-1",
      nodeId: "development",
      actorId: "olivia",
      actorKind: "user",
      actorName: "Olivia",
      message: "通过审批：Development",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(workflowEvent.events.at(-1)).toMatchObject({
      id: "workflow-event-1",
      kind: "workflow",
      actorName: "Olivia",
      message: "通过审批：Development",
    });
    await expect(
      tasks.projectWorkflowEvent(system, created.id, {
        id: "workflow-event-1",
        instanceId: "wf-1",
        nodeId: "development",
        actorId: "olivia",
        actorKind: "user",
        actorName: "Olivia",
        message: "通过审批：Development",
        at: "2026-01-01T00:00:01.000Z",
      }),
    ).resolves.toStrictEqual(workflowEvent);
    const runProjected = await tasks.projectAgentRun(
      system,
      created.id,
      {
        id: "workflow-run-1",
        nodeId: "development",
        status: "running",
      },
      "Backend DE",
    );
    expect(runProjected.status).toBe("progress");
    expect(runProjected.messages.at(-1)).toMatchObject({
      runId: "workflow-run-1",
      state: "running",
      content: "已接收指令，正在执行…",
    });
    const failedRun = await tasks.projectAgentRun(
      system,
      created.id,
      {
        id: "workflow-run-2",
        status: "failed",
        error: "Delivery format is invalid",
      },
      "Backend DE",
    );
    expect(failedRun.status).toBe("todo");
    expect(failedRun.messages.at(-1)).toMatchObject({
      runId: "workflow-run-2",
      state: "failed",
      content: "Delivery format is invalid",
    });
    await expect(
      tasks.projectAgentRun(
        system,
        created.id,
        {
          id: "workflow-run-2",
          status: "failed",
          error: "Delivery format is invalid",
        },
        "Backend DE",
      ),
    ).resolves.toStrictEqual(failedRun);
    await expect(
      tasks.update(olivia, {
        taskId: created.id,
        title: "Changed locally",
        priority: "P1",
        description: "This must not bypass the workflow node.",
        acceptance: ["Local edit rejected"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.addMessage(olivia, {
        taskId: created.id,
        content: "Ordinary execution input",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.toggleStep(olivia, {
        taskId: created.id,
        stepId: created.steps[0]!.id,
        done: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("removes a stale agent run projected into another workflow node", async () => {
    const table = memoryTable<TaskRecord>();
    const tasks = new TaskService({ tasks: table });
    const system = { id: "workflow", name: "系统", kind: "system" } as const;
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Test preparation",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Prepare the regression checklist.",
      acceptance: ["Checklist is ready"],
      workflow: {
        instanceId: "wf-1",
        nodeId: "test-preparation",
        instanceTitle: "Delivery",
        nodeName: "Test preparation",
        reviewRequired: true,
      },
    });
    expect(created.status).toBe("progress");

    // Older builds copied every instance run into every node task. Refreshing
    // must remove that stale projection instead of treating it as authoritative.
    table.put(created.id, {
      ...created,
      agentRunIds: ["development-run"],
      messages: [
        {
          id: "development-run",
          at: "2026-01-01T00:00:00.000Z",
          authorId: "agent-1",
          authorName: "Backend DE",
          kind: "agent",
          content: "已接收指令，正在执行…",
          attachments: [],
          mentions: [],
          runId: "development-run",
          state: "running",
        },
      ],
    });
    const repaired = await tasks.projectAgentRun(
      system,
      created.id,
      {
        id: "development-run",
        nodeId: "development",
        status: "succeeded",
        output: { summary: "Development output belongs elsewhere" },
      },
      "Backend DE",
    );
    expect(repaired.status).toBe("todo");
    expect(repaired.messages).toEqual([]);
    expect(repaired.agentRunIds).not.toContain("development-run");
    expect(
      repaired.messages.some((item) => item.runId === "development-run"),
    ).toBe(false);
    expect(repaired.events.at(-1)?.message).toBe(
      "清理不属于当前节点的 Agent 执行记录",
    );
  });

  it("updates the auto submit flag from the task edit form", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Toggle auto submit",
      priority: "P2",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Backend DE",
      description: "Toggle the flag.",
      acceptance: ["Flag follows the checkbox"],
    });

    const off = await tasks.update(olivia, {
      taskId: created.id,
      title: created.title,
      priority: created.priority,
      description: created.description,
      acceptance: created.acceptance,
      autoSubmitReview: false,
    });
    expect(off.autoSubmitReview).toBe(false);
    const on = await tasks.update(olivia, {
      taskId: created.id,
      title: created.title,
      priority: created.priority,
      description: created.description,
      acceptance: created.acceptance,
      autoSubmitReview: true,
    });
    expect(on.autoSubmitReview).toBe(true);

    const untouched = await tasks.update(olivia, {
      taskId: created.id,
      title: created.title,
      priority: created.priority,
      description: created.description,
      acceptance: created.acceptance,
    });
    expect(untouched.autoSubmitReview).toBe(true);
  });

  it("archives and restores a task while keeping its history", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Archive and restore",
      priority: "P3",
      receiverType: "unassigned",
      description: "Board cleanup candidate.",
      acceptance: ["Archive keeps history"],
    });
    expect(created.archivedAt).toBeUndefined();

    const archived = await tasks.archive(olivia, created.id);
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.events.at(-1)).toMatchObject({
      kind: "archived",
      actorName: "Olivia",
    });
    expect(archived.steps).toHaveLength(1);

    const archivedAgain = await tasks.archive(olivia, created.id);
    expect(archivedAgain.events).toHaveLength(archived.events.length);

    const restored = await tasks.restore(olivia, created.id);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.events.at(-1)).toMatchObject({ kind: "restored" });
    expect(restored.events.map((event) => event.kind)).toEqual([
      "created",
      "archived",
      "restored",
    ]);

    const unchanged = await tasks.restore(olivia, created.id);
    expect(unchanged.events).toHaveLength(restored.events.length);
  });

  it("archives a cancelled task and restores it without reopening it", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Archive a cancelled task",
      priority: "P3",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Cancelled history should be removable from the board.",
      acceptance: ["Cancellation remains unchanged"],
    });
    const cancelled = await tasks.changeStatus(olivia, {
      taskId: created.id,
      status: "cancelled",
    });
    expect(cancelled.status).toBe("cancelled");

    const archived = await tasks.archive(olivia, created.id);
    expect(archived).toMatchObject({
      id: created.id,
      status: "cancelled",
    });
    expect(archived.archivedAt).toBeTruthy();

    const restored = await tasks.restore(olivia, created.id);
    expect(restored).toMatchObject({
      id: created.id,
      status: "cancelled",
    });
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.events.map((event) => event.kind)).toEqual([
      "created",
      "status",
      "archived",
      "restored",
    ]);
  });

  it("keeps archived tasks read-only until they are restored", async () => {
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Locked while archived",
      priority: "P2",
      receiverType: "unassigned",
      description: "Archived tasks must not be editable.",
      acceptance: ["Mutations are rejected"],
    });
    await tasks.archive(olivia, created.id);

    await expect(
      tasks.addMessage(olivia, { taskId: created.id, content: "补充指令" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.changeStatus(olivia, { taskId: created.id, status: "progress" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.assign(olivia, {
        taskId: created.id,
        receiverType: "human",
        receiverId: "olivia",
        receiverName: "Olivia",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tasks.update(olivia, {
        taskId: created.id,
        title: "改过的标题",
        priority: "P1",
        description: "changed",
        acceptance: ["changed"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(tasks.nudge(olivia, created.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      tasks.addComment(olivia, { taskId: created.id, content: "评论" }),
    ).rejects.toMatchObject({ code: "conflict" });

    await tasks.restore(olivia, created.id);
    const resumed = await tasks.addMessage(olivia, {
      taskId: created.id,
      content: "复原之后可以继续",
    });
    expect(resumed.messages).toHaveLength(1);
    expect(resumed.messages[0]?.content).toBe("复原之后可以继续");
  });

  it("lists workspace files produced during an agent run, newest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-documents-"));
    const now = Date.now();
    const inside = new Date(now - 30_000);
    const outside = new Date(now - 3 * 60 * 60 * 1000);
    await writeFile(join(root, "产品PRD.md"), "# 需求\n", "utf8");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf8");
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(root, ".pluginmax", "task-outputs"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "left-pad", "index.js"),
      "",
      "utf8",
    );
    await writeFile(
      join(root, ".pluginmax", "task-outputs", "内部文档.md"),
      "",
      "utf8",
    );
    await utimes(join(root, "产品PRD.md"), inside, inside);
    await utimes(join(root, "src", "index.ts"), outside, outside);
    await utimes(
      join(root, "node_modules", "left-pad", "index.js"),
      inside,
      inside,
    );
    await utimes(
      join(root, ".pluginmax", "task-outputs", "内部文档.md"),
      inside,
      inside,
    );
    await writeFile(join(root, ".DS_Store"), "junk", "utf8");
    await utimes(join(root, ".DS_Store"), inside, inside);

    const windows = windowsFromRuns(
      [
        {
          id: "run-product",
          startedAt: new Date(now - 120_000).toISOString(),
          endedAt: new Date(now).toISOString(),
          actor: "Pluginmax DE",
        },
      ],
      "Agent",
      now,
    );
    const documents = await collectDocuments({ root, windows });

    expect(documents.map((document) => document.relativePath)).toEqual([
      "产品PRD.md",
    ]);
    expect(documents[0]).toMatchObject({
      runId: "run-product",
      kind: "produced",
      name: "产品PRD.md",
      updatedBy: "Pluginmax DE",
      mimeType: "text/markdown; charset=utf-8",
      available: true,
    });
  });

  it("keeps files a subagent writes after the run settled", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-documents-"));
    const now = Date.now();
    const afterSettle = new Date(now - 30_000);
    await writeFile(join(root, "五子棋PRD.md"), "# PRD\n", "utf8");
    await utimes(join(root, "五子棋PRD.md"), afterSettle, afterSettle);

    const windows = windowsFromRuns(
      [
        {
          id: "run-after-settle",
          startedAt: new Date(now - 10 * 60_000).toISOString(),
          endedAt: new Date(now - 8 * 60_000).toISOString(),
          actor: "DE 测小白",
        },
      ],
      "Agent",
      now,
    );
    const documents = await collectDocuments({ root, windows });
    expect(documents.map((document) => document.relativePath)).toEqual([
      "五子棋PRD.md",
    ]);
    expect(documents[0]?.updatedBy).toBe("DE 测小白");
    expect(documents[0]?.runId).toBe("run-after-settle");
  });

  it("ignores files touched outside every run window", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-documents-"));
    const now = Date.now();
    const old = new Date(now - 6 * 60 * 60 * 1000);
    await writeFile(join(root, "notes.md"), "older\n", "utf8");
    await utimes(join(root, "notes.md"), old, old);

    const documents = await collectDocuments({
      root,
      windows: windowsFromRuns(
        [
          {
            startedAt: new Date(now - 60_000).toISOString(),
            endedAt: new Date(now).toISOString(),
            actor: "Pluginmax DE",
          },
        ],
        "Agent",
        now,
      ),
    });
    expect(documents).toEqual([]);
    expect(await collectDocuments({ root, windows: [] })).toEqual([]);
  });

  it("does not leave a settled run window open indefinitely", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-documents-"));
    const now = Date.now();
    const lateFile = new Date(now - 60_000);
    await writeFile(join(root, "late-manual-edit.md"), "late\n", "utf8");
    await utimes(join(root, "late-manual-edit.md"), lateFile, lateFile);

    const documents = await collectDocuments({
      root,
      windows: windowsFromRuns(
        [
          {
            id: "run-old",
            startedAt: new Date(now - 40 * 60_000).toISOString(),
            endedAt: new Date(now - 30 * 60_000).toISOString(),
            actor: "Old Agent",
          },
        ],
        "Agent",
        now,
      ),
    });
    expect(documents).toEqual([]);
  });

  it("does not attribute another task's files to the current task", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-documents-"));
    const now = Date.now();
    const tasks = service();
    const current = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Current task",
      priority: "P2",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Current task",
      acceptance: ["Current output only"],
    });
    const other = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Other task",
      priority: "P2",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Other task",
      acceptance: ["Other output only"],
    });
    await writeFile(join(root, "current.md"), "current\n", "utf8");
    await writeFile(join(root, "other.md"), "other\n", "utf8");
    await utimes(
      join(root, "current.md"),
      new Date(now - 4 * 60_000),
      new Date(now - 4 * 60_000),
    );
    await utimes(
      join(root, "other.md"),
      new Date(now - 60_000),
      new Date(now - 60_000),
    );
    const runs = [
      {
        id: "run-current",
        instanceId: current.id,
        nodeId: "task",
        status: "succeeded" as const,
        createdAt: new Date(now - 5 * 60_000).toISOString(),
        startedAt: new Date(now - 5 * 60_000).toISOString(),
        endedAt: new Date(now - 3 * 60_000).toISOString(),
        payload: {
          profileName: "Current Agent",
          context: {
            taskId: current.id,
            taskReceiverName: "Current Agent",
            taskRunRole: "owner",
          },
        },
      },
      {
        id: "run-other",
        instanceId: other.id,
        nodeId: "task",
        status: "succeeded" as const,
        createdAt: new Date(now - 2 * 60_000).toISOString(),
        startedAt: new Date(now - 2 * 60_000).toISOString(),
        endedAt: new Date(now - 30_000).toISOString(),
        payload: {
          profileName: "Other Agent",
          context: {
            taskId: other.id,
            taskReceiverName: "Other Agent",
            taskRunRole: "owner",
          },
        },
      },
    ];
    const agent = {
      runs: (filter: { instanceId?: string }) =>
        filter.instanceId === undefined
          ? runs
          : runs.filter((run) => run.instanceId === filter.instanceId),
    };
    const query = createTaskDocumentQueryService(tasks, () => agent as never, {
      get: () => ({ id: "workspace-1", title: "Workspace", path: root }),
      list: () => [],
    } as never);

    const result = await query.list(current.id);
    expect(result.documents.map((document) => document.relativePath)).toEqual([
      "current.md",
    ]);
    expect(result.documents[0]?.runId).toBe("run-current");
  });

  it("extracts named documents from read-only agent output", () => {
    const legacy = [
      "当前工作区为只读，无法生成可下载附件；以下为完整单文件 Markdown 源文，名为 `OPPO_R9_2016_上市前行业分析.md`。",
      "",
      "# OPPO R9 上市前行业分析",
      "",
      "## 结论",
      "",
      "只采用发布前可获得的信息。",
    ].join("\n");
    expect(extractAgentOutputDocuments(legacy)).toEqual([
      {
        name: "OPPO_R9_2016_上市前行业分析.md",
        content: [
          "# OPPO R9 上市前行业分析",
          "",
          "## 结论",
          "",
          "只采用发布前可获得的信息。",
        ].join("\n"),
      },
    ]);

    const protocol = [
      "已完成两份文档。",
      "<!-- pluginmax-document: 调研报告.md -->",
      "# 调研报告",
      "",
      "正文",
      "<!-- /pluginmax-document -->",
      "<!-- pluginmax-document: 数据附录.json -->",
      '{"ok":true}',
      "<!-- /pluginmax-document -->",
    ].join("\n");
    expect(extractAgentOutputDocuments(protocol)).toEqual([
      { name: "调研报告.md", content: "# 调研报告\n\n正文" },
      { name: "数据附录.json", content: '{"ok":true}' },
    ]);
  });

  it("materializes read-only agent output as downloadable task documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-output-documents-"));
    const summary = [
      "当前工作区为只读；以下文件名为 `行业分析.md`。",
      "",
      "# 行业分析",
      "",
      "这是完整正文。",
    ].join("\n");
    const options = {
      root,
      taskId: "TSK-OUTPUT-1",
      runs: [
        {
          id: "run-output-1",
          status: "succeeded",
          endedAt: "2026-10-23T03:00:00.000Z",
          actor: "Codex 调研架构师",
          output: { summary },
        },
      ],
    };
    const documents = await materializeAgentOutputDocuments(options);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      runId: "run-output-1",
      kind: "produced",
      name: "行业分析.md",
      updatedBy: "Codex 调研架构师",
      updatedAt: "2026-10-23T03:00:00.000Z",
      mimeType: "text/markdown; charset=utf-8",
      available: true,
    });
    expect(
      await readFile(
        join(root, documents[0]?.relativePath ?? "missing"),
        "utf8",
      ),
    ).toBe("# 行业分析\n\n这是完整正文。\n");

    const repeated = await materializeAgentOutputDocuments(options);
    expect(repeated.map((document) => document.relativePath)).toEqual(
      documents.map((document) => document.relativePath),
    );
  });

  it("lists read-only run output through the task documents endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-output-route-"));
    const tasks = service();
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "读取只读运行产物",
      priority: "P2",
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "Codex 调研架构师",
      description: "生成 Markdown 报告。",
      acceptance: ["报告可下载"],
    });
    const routes = createTaskRoutes(
      tasks,
      {
        resolveToken: (candidate) =>
          candidate === "token"
            ? { userId: "admin", role: "admin" }
            : undefined,
        users: () => [{ id: "admin", name: "Admin", role: "admin" }],
        members: () => [{ userId: "admin", memberRole: "owner" }],
      },
      undefined,
      undefined,
      () => ({
        bindTask: () => undefined,
        dispatch: async () => {
          throw new Error("not used");
        },
        runs: () => [
          {
            id: "run-doc-1",
            status: "succeeded" as const,
            createdAt: "2026-10-23T02:50:00.000Z",
            startedAt: "2026-10-23T02:50:00.000Z",
            endedAt: "2026-10-23T03:00:00.000Z",
            payload: {
              profileName: "Codex 调研架构师",
              context: { taskRunRole: "owner" },
            },
            output: {
              summary:
                "当前工作区为只读；文档名为 `行业分析.md`。\n\n# 行业分析\n\n完整正文。",
            },
          },
        ],
      }),
      {
        get: () => ({ id: "workspace-1", path: root }),
        list: () => [{ id: "workspace-1", path: root }],
      },
    );
    const documentsRoute = routes.find(
      (route) => route.path === "/api/collab/tasks/documents",
    );
    const response = fakeResponse();
    await documentsRoute?.handler(
      fakeRequest({
        method: "GET",
        url: `/api/collab/tasks/documents?taskId=${created.id}`,
      }),
      response.response,
    );
    const result = response.read();
    expect(result.status).toBe(200);
    expect(result.body?.documents).toContainEqual(
      expect.objectContaining({
        runId: "run-doc-1",
        kind: "produced",
        name: "行业分析.md",
        updatedBy: "Codex 调研架构师",
        available: true,
      }),
    );
    const listed = (
      result.body?.documents as Array<{ relativePath: string }> | undefined
    )?.[0];
    expect(
      await readFile(join(root, listed?.relativePath ?? "missing"), "utf8"),
    ).toBe("# 行业分析\n\n完整正文。\n");
  });

  it("falls back to the task owner name and sanitizes upload names", () => {
    const now = Date.now();
    const [window] = windowsFromRuns(
      [{ createdAt: new Date(now).toISOString(), actor: "" }],
      "Pluginmax DE",
      now,
    );
    expect(window).toMatchObject({
      actor: "Pluginmax DE",
      from: now - 5_000,
      to: now,
    });
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a/b\\c:d.txt")).toBe("b_c_d.txt");
    expect(safeFileName("   ")).toBe("file");
  });

  it("lists stored uploads and keeps the newest copy of a file", () => {
    const uploaded = attachmentDocuments(
      {
        messages: [
          {
            id: "message-1",
            at: "2026-09-23T01:00:00.000Z",
            authorId: "admin",
            authorName: "Admin",
            kind: "human",
            content: "带附件的说明",
            attachments: [
              {
                name: "需求.md",
                size: 12,
                mimeType: "text/markdown",
                storedPath: ".pluginmax/task-uploads/TSK-1/需求.md",
              },
            ],
            mentions: [],
          },
          {
            id: "message-2",
            at: "2026-09-23T02:00:00.000Z",
            authorId: "admin",
            authorName: "Admin",
            kind: "human",
            content: "历史附件",
            attachments: [{ name: "旧附件.txt" }],
            mentions: [],
          },
        ],
      },
      true,
      new Map([["message-1", "run-upload-1"]]),
    );
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0]).toMatchObject({
      runId: "run-upload-1",
      kind: "uploaded",
      name: "需求.md",
      relativePath: ".pluginmax/task-uploads/TSK-1/需求.md",
      updatedBy: "Admin",
      updatedAt: "2026-09-23T01:00:00.000Z",
      available: true,
    });
    expect(uploaded[1]).toMatchObject({
      name: "旧附件.txt",
      relativePath: "",
      available: false,
    });

    const merged = mergeDocuments([
      {
        id: "produced:需求.md",
        kind: "produced",
        name: "需求.md",
        relativePath: "需求.md",
        size: 10,
        mimeType: "text/markdown; charset=utf-8",
        updatedBy: "Pluginmax DE",
        updatedAt: "2026-09-23T01:30:00.000Z",
        available: true,
      },
      {
        id: "produced:需求.md",
        kind: "produced",
        name: "需求.md",
        relativePath: "需求.md",
        size: 32,
        mimeType: "text/markdown; charset=utf-8",
        updatedBy: "Pluginmax DE",
        updatedAt: "2026-09-23T03:00:00.000Z",
        available: true,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.size).toBe(32);
  });
});

function fakeRequest(options: {
  method: string;
  url: string;
  token?: string;
  body?: unknown;
}): IncomingMessage {
  const chunks =
    options.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(options.body), "utf8")];
  return {
    method: options.method,
    url: options.url,
    headers: {
      host: "localhost:3210",
      origin: "http://localhost:3210",
      authorization: `Bearer ${options.token ?? "token"}`,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
}

function fakeResponse(): {
  response: ServerResponse;
  read: () => { status: number; body: Record<string, unknown> | null };
} {
  let payload = "";
  const response: {
    statusCode: number;
    writeHead: (status: number) => void;
    setHeader: () => void;
    end: (chunk?: unknown) => void;
  } = {
    statusCode: 200,
    writeHead: (status) => {
      response.statusCode = status;
    },
    setHeader: () => undefined,
    end: (chunk?: unknown) => {
      payload += chunk === undefined ? "" : String(chunk);
    },
  };
  return {
    response: response as unknown as ServerResponse,
    read: () => ({
      status: response.statusCode,
      body:
        payload === ""
          ? null
          : (JSON.parse(payload) as Record<string, unknown>),
    }),
  };
}

describe("workflow task action errors", () => {
  it("keeps workflow permission errors actionable", async () => {
    const table = memoryTable<TaskRecord>();
    const tasks = new TaskService({ tasks: table });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Controlled approval",
      priority: "P2",
      status: "review",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Approve the delivery.",
      acceptance: ["Give a decision"],
    });
    table.put(created.id, {
      ...created,
      workflow: {
        instanceId: "wf-1",
        nodeId: "approval",
        instanceTitle: "Delivery",
        nodeName: "Approval",
        approvalPolicy: "any",
        nodeAttempt: 1,
        reviewRequired: false,
      },
    });
    tasks.bindWorkflowActions({
      assign: async () => undefined,
      decide: async () => {
        throw Object.assign(new Error("you are not an approver"), {
          code: "forbidden",
          name: "WorkflowError",
        });
      },
      reconcile: async () => undefined,
      submit: async () => undefined,
    });
    const routes = createTaskRoutes(tasks, {
      resolveToken: (candidate) =>
        candidate === "token" ? { userId: "admin", role: "admin" } : undefined,
      users: () => [{ id: "admin", name: "Admin", role: "admin" }],
      members: () => [{ userId: "admin", memberRole: "owner" }],
    });
    const action = routes.find(
      (candidate) => candidate.path === "/api/collab/tasks/action",
    );
    const response = fakeResponse();
    await action?.handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: created.id, action: "approve" },
      }),
      response.response,
    );
    const result = response.read();
    expect(result.status).toBe(403);
    expect(result.body?.error).toMatchObject({
      code: "forbidden",
      message: "you are not an approver",
    });
  });
});

describe("teammate task assignment", () => {
  it("lists AI Teammates as receivers and provisions the runtime on dispatch", async () => {
    const tasks = service();
    const dispatched: Array<Record<string, unknown>> = [];
    const ensured: Array<{ teammateId: string; workspaceId: string }> = [];
    const routes = createTaskRoutes(
      tasks,
      {
        resolveToken: (candidate) =>
          candidate === "token"
            ? { userId: "admin", role: "admin" }
            : undefined,
        users: () => [{ id: "admin", name: "Admin", role: "admin" }],
        members: () => [{ userId: "admin", memberRole: "owner" }],
      },
      {
        list: () => [
          {
            id: "digital-1",
            displayName: "测小白",
            kind: "digital" as const,
            status: "active",
            managerEmployeeId: "admin",
          },
        ],
        employeeWorkspaceTarget: () => undefined,
        workflowTarget: () => ({
          employee: {
            id: "digital-1",
            displayName: "后端开发 Agent",
            kind: "digital" as const,
            status: "active",
            managerEmployeeId: "admin",
          },
          profile: {
            name: "测小白（旧执行身份）",
            legacyAgentProfileId: "agent-legacy",
            budget: { maxMinutes: 5 },
          },
        }),
      },
      undefined,
      () => ({
        bindTask: () => undefined,
        dispatch: async (input) => {
          dispatched.push(input as unknown as Record<string, unknown>);
          return {
            id: "run-1",
            instanceId: String(
              (input as unknown as { instanceId: string }).instanceId,
            ),
            status: "queued" as const,
          };
        },
      }),
      {
        get: () => ({ id: "workspace-1", path: "/tmp/workspace-1" }),
        list: () => [{ id: "workspace-1", path: "/tmp/workspace-1" }],
      },
      () => ({
        assignable: () => [
          {
            id: "tm-1",
            name: "测小白",
            ownerUserId: "admin",
            ownerName: "平台",
            source: "platform" as const,
            avatar: "",
            employeeId: "digital-1",
          },
        ],
        ensureRuntime: async (input) => {
          ensured.push({
            teammateId: input.teammateId,
            workspaceId: input.workspaceId,
          });
          return {
            teammateId: input.teammateId,
            employeeId: "digital-1",
            profileId: "agent-1",
            personaId: "persona-tm-1",
          };
        },
      }),
    );

    const bootstrap = routes.find(
      (route) => route.path === "/api/collab/tasks/bootstrap",
    );
    expect(bootstrap).toBeDefined();
    const listed = fakeResponse();
    await bootstrap?.handler(
      fakeRequest({
        method: "GET",
        url: "/api/collab/tasks/bootstrap?workspaceId=workspace-1",
      }),
      listed.response,
    );
    const listResult = listed.read();
    expect(listResult.status).toBe(200);
    const directory = listResult.body?.directory as {
      agents: Array<{
        id: string;
        name: string;
        employeeId?: string;
        ownerAuthUserId?: string;
      }>;
    };
    expect(
      directory.agents.some(
        (agent) => agent.id === "tm-1" && agent.name === "测小白",
      ),
    ).toBe(true);
    // 实例归属：目录要带上实例 owner（创建人）与员工身份 id 别名。
    expect(directory.agents.find((agent) => agent.id === "tm-1")).toMatchObject(
      {
        employeeId: "digital-1",
        ownerAuthUserId: "admin",
      },
    );
    expect(
      directory.agents.filter((agent) => agent.name === "测小白"),
    ).toHaveLength(1);

    const create = routes.find(
      (route) => route.path === "/api/collab/tasks/create",
    );
    expect(create).toBeDefined();
    const created = fakeResponse();
    await create?.handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "交给测小白的任务",
          priority: "P2",
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
          description: "验证 teammate 派发链路",
          acceptance: ["可以派发"],
        },
      }),
      created.response,
    );
    const createResult = created.read();
    expect(createResult.status).toBe(200);
    expect(ensured).toEqual([
      { teammateId: "tm-1", workspaceId: "workspace-1" },
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      profileId: "agent-1",
      employeeId: "digital-1",
      personaId: "persona-tm-1",
      source: "task",
      payload: { context: { employeeName: "测小白" } },
    });
  });

  it("dispatches through Principal Runtime and issues an action ticket", async () => {
    const tasks = new TaskService({ tasks: memoryTable() });
    const dispatched: Array<Record<string, unknown>> = [];
    const tickets: Array<Record<string, unknown>> = [];
    const prepared: Array<Record<string, unknown>> = [];
    const receipts: Array<Record<string, unknown>> = [];
    const actor = { id: "admin", name: "Admin", kind: "human" as const };
    const task = await tasks.create(actor, {
      workspaceId: "workspace-1",
      title: "Principal task",
      priority: "P2",
      receiverType: "agent",
      receiverId: "tm-principal",
      receiverName: "Principal Worker",
      description: "Run with Principal identity",
      acceptance: ["Completed"],
    });
    const dispatch = createTaskDispatcher({
      service: tasks,
      team: {
        resolveToken: () => undefined,
        users: () => [{ id: "admin", name: "Admin", role: "admin" }],
        members: () => [{ userId: "admin", memberRole: "owner" }],
      },
      agent: () => ({
        bindTask: () => undefined,
        dispatch: async (input) => {
          dispatched.push(input as unknown as Record<string, unknown>);
          return {
            id: "run-principal",
            instanceId: task.id,
            nodeId: "task",
            status: "queued",
          };
        },
        run: (runId: string) =>
          runId === "run-previous"
            ? {
                id: "run-previous",
                instanceId: task.id,
                status: "queued" as const,
                payload: {
                  context: {
                    taskReceiverId: "tm-principal",
                    taskRunRole: "owner",
                    taskSessionEpoch: "0",
                  },
                },
              }
            : undefined,
      }),
      workspaces: {
        get: () => ({ id: "workspace-1", path: "/tmp/workspace-1" }),
        list: () => [{ id: "workspace-1", path: "/tmp/workspace-1" }],
      },
      teammates: () => ({
        assignable: () => [],
        ensureRuntime: async () => ({
          teammateId: "tm-principal",
          principalId: "principal-ai-tm-principal",
          profileId: "agent-principal",
        }),
      }),
      principalRuntime: () => ({
        profile: () => ({ id: "principal-runtime-1" }),
        issueTicket: async (input) => {
          tickets.push(input);
          return { id: "principal-ticket-task" };
        },
      }),
      context: () => ({
        registerAdapter: () => () => undefined,
        prepare: async (input) => {
          prepared.push(input);
          return {
            id: "pack-task-1",
            sessionBindingId: "task:task-1:principal:g0",
            rendered: {
              systemText: "system",
              userText: "task context",
              flattenedPrompt: "system\n\ntask context",
            },
          };
        },
        session: () => ({ sessionId: "de-task-context", generation: 0 }),
        recordRuntime: async (input) => {
          receipts.push(input);
        },
      }),
    });

    const taskWithHistory = await tasks.attachAgentRun(
      task.id,
      {
        id: "run-previous",
        instanceId: task.id,
        status: "queued",
        payload: {
          context: {
            taskReceiverId: "tm-principal",
            taskRunRole: "owner",
            taskSessionEpoch: "0",
          },
        },
      },
      "Principal Worker",
    );
    await dispatch(taskWithHistory, actor);

    expect(dispatched[0]).toMatchObject({
      profileId: "agent-principal",
      principalId: "principal-ai-tm-principal",
      principalType: "principal-runtime",
      ticketId: "principal-ticket-task",
      contextPackId: "pack-task-1",
      sessionBindingId: "task:task-1:principal:g0",
      sessionId: "de-task-context",
      payload: {
        context: {
          instruction: "system\n\ntask context",
          contextPackId: "pack-task-1",
        },
      },
    });
    expect(dispatched[0]?.employeeId).toBeUndefined();
    expect(tickets[0]).toMatchObject({
      principalId: "principal-ai-tm-principal",
      contextType: "task",
      contextId: task.id,
    });
    expect(prepared[0]).toMatchObject({
      scene: "task",
      objectId: task.id,
      agentProfileId: "agent-principal",
      actorPrincipalId: "admin",
      rerunOfRunId: "run-previous",
    });
    expect(receipts[0]).toMatchObject({
      runId: "run-principal",
      contextPackId: "pack-task-1",
      runtime: { kind: "builtin" },
    });
  });

  it("leaves workflow Agent dispatch to the workflow bridge after reassignment", async () => {
    const { tasks, route, dispatched } = contextHarness();
    const assigned: Array<{
      receiverType: string;
      receiverId?: string | undefined;
    }> = [];
    tasks.bindWorkflowActions({
      assign: async () => undefined,
      assigned: async (task) => {
        assigned.push({
          receiverType: task.receiverType,
          receiverId: task.receiverId,
        });
      },
      decide: async () => undefined,
      submit: async () => undefined,
    });
    const task = await tasks.create(
      { id: "admin", name: "Admin", kind: "human", role: "admin" },
      {
        workspaceId: "workspace-1",
        title: "工作流测试设计",
        priority: "P2",
        receiverType: "human",
        receiverId: "admin",
        receiverName: "Admin",
        description: "由工作流节点驱动",
        acceptance: ["完成测试设计"],
        workflow: {
          instanceId: "wf-1",
          nodeId: "test-design",
          instanceTitle: "交付流程",
          nodeName: "测试文档设计",
          nodeAttempt: 1,
          reviewRequired: true,
        },
      },
    );

    const response = fakeResponse();
    await route("/api/collab/tasks/assign").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/assign",
        body: {
          taskId: task.id,
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
        },
      }),
      response.response,
    );

    expect(response.read().status).toBe(200);
    expect(tasks.get(task.id)).toMatchObject({
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "测小白",
    });
    expect(assigned).toEqual([{ receiverType: "agent", receiverId: "tm-1" }]);
    // 关键回归：工作流任务不能再生成 instanceId=taskId 的普通任务 run。
    expect(dispatched).toHaveLength(0);
  });
});

describe("project role tasks", () => {
  function roleRoutes() {
    const tasks = service();
    const routes = createTaskRoutes(
      tasks,
      {
        resolveToken: (candidate) =>
          candidate === "token"
            ? { userId: "alice", role: "member" }
            : candidate === "bob"
              ? { userId: "bob", role: "member" }
              : undefined,
        users: () => [
          { id: "alice", name: "Alice", role: "member" },
          { id: "bob", name: "Bob", role: "member" },
        ],
        members: () => [
          { userId: "alice", memberRole: "member" },
          { userId: "bob", memberRole: "member" },
        ],
      },
      undefined,
      {
        config: () => ({
          seats: [
            {
              id: "reviewer",
              label: "评审组",
              participantKind: "any" as const,
              permissions: ["read", "approve"] as const,
            },
          ],
        }),
        seats: () => [
          {
            seatId: "reviewer",
            assigneeKind: "user" as const,
            assigneeId: "alice",
            status: "claimed" as const,
          },
          {
            seatId: "reviewer",
            assigneeKind: "agent" as const,
            assigneeId: "tm-tester",
            status: "assigned" as const,
          },
        ],
        members: (_workspaceId, seatId) =>
          seatId === "reviewer"
            ? [
                {
                  assigneeKind: "user" as const,
                  assigneeId: "alice",
                  status: "claimed" as const,
                },
                {
                  assigneeKind: "agent" as const,
                  assigneeId: "tm-tester",
                  status: "assigned" as const,
                },
              ]
            : [],
      },
    );
    return { routes, tasks };
  }

  it("lists role candidates and only lets current members claim", async () => {
    const { routes, tasks } = roleRoutes();
    const bootstrap = routes.find(
      (route) => route.path === "/api/collab/tasks/bootstrap",
    );
    const listed = fakeResponse();
    await bootstrap?.handler(
      fakeRequest({
        method: "GET",
        url: "/api/collab/tasks/bootstrap?workspaceId=workspace-1",
      }),
      listed.response,
    );
    const directory = listed.read().body?.directory as {
      roles: Array<{
        id: string;
        name: string;
        members?: Array<{ kind: string; id: string; name?: string }>;
      }>;
    };
    expect(directory.roles[0]).toMatchObject({
      id: "reviewer",
      name: "评审组",
    });
    expect(directory.roles[0]?.members).toEqual([
      { kind: "user", id: "alice", name: "Alice" },
      { kind: "agent", id: "tm-tester" },
    ]);

    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "角色任务",
      priority: "P2",
      receiverType: "role",
      receiverId: "reviewer",
      receiverName: "评审组",
      description: "由角色成员或签完成",
      acceptance: ["任一成员完成即可"],
    });

    const claim = routes.find(
      (route) => route.path === "/api/collab/tasks/claim",
    );
    const bob = fakeResponse();
    await claim?.handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/claim",
        token: "bob",
        body: { taskId: created.id },
      }),
      bob.response,
    );
    expect(bob.read().status).toBe(403);

    const start = routes.find(
      (route) => route.path === "/api/collab/tasks/action",
    );
    const prematureStart = fakeResponse();
    await start?.handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: created.id, action: "start" },
      }),
      prematureStart.response,
    );
    expect(prematureStart.read().status).toBe(409);
    expect(tasks.get(created.id).status).toBe("todo");

    const alice = fakeResponse();
    await claim?.handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/claim",
        body: { taskId: created.id },
      }),
      alice.response,
    );
    expect(alice.read().status).toBe(200);
    expect(tasks.get(created.id)).toMatchObject({
      receiverType: "human",
      receiverId: "alice",
      status: "progress",
    });
  });
});

describe("workflow agent run reconciliation", () => {
  it("cleans a stale run already attached to another node's task", async () => {
    const table = memoryTable<TaskRecord>();
    const tasks = new TaskService({ tasks: table });
    const created = await tasks.create(olivia, {
      workspaceId: "workspace-1",
      title: "Test preparation",
      priority: "P2",
      status: "progress",
      receiverType: "human",
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "Prepare the checklist.",
      acceptance: ["Checklist is ready"],
      workflow: {
        instanceId: "wf-1",
        nodeId: "test-preparation",
        instanceTitle: "Delivery",
        nodeName: "Test preparation",
        reviewRequired: true,
      },
    });
    table.put(created.id, {
      ...created,
      agentRunIds: ["development-run"],
      messages: [
        {
          id: "development-run",
          at: "2026-01-01T00:00:00.000Z",
          authorId: "agent-1",
          authorName: "Backend DE",
          kind: "agent",
          content: "已接收指令，正在执行…",
          attachments: [],
          mentions: [],
          runId: "development-run",
          state: "running",
        },
      ],
    });
    const routes = createTaskRoutes(
      tasks,
      {
        resolveToken: (candidate) =>
          candidate === "token"
            ? { userId: "admin", role: "admin" }
            : undefined,
        users: () => [{ id: "admin", name: "Admin", role: "admin" }],
        members: () => [{ userId: "admin", memberRole: "owner" }],
      },
      undefined,
      undefined,
      () => ({
        bindTask: () => undefined,
        dispatch: async () => {
          throw new Error("not used");
        },
        runs: () => [
          {
            id: "development-run",
            nodeId: "development",
            status: "succeeded" as const,
            payload: { profileName: "Backend DE" },
            output: { summary: "Development output belongs elsewhere" },
          },
        ],
      }),
      {
        get: () => ({ id: "workspace-1", path: "/tmp/workspace-1" }),
        list: () => [{ id: "workspace-1", path: "/tmp/workspace-1" }],
      },
    );
    const bootstrap = routes.find(
      (route) => route.path === "/api/collab/tasks/bootstrap",
    );
    const response = fakeResponse();
    await bootstrap?.handler(
      fakeRequest({
        method: "GET",
        url: "/api/collab/tasks/bootstrap?workspaceId=workspace-1",
      }),
      response.response,
    );
    expect(response.read().status).toBe(200);

    const repaired = tasks.get(created.id);
    expect(repaired.status).toBe("todo");
    expect(repaired.agentRunIds).toEqual([]);
    expect(repaired.messages).toEqual([]);
    expect(repaired.events.at(-1)?.message).toBe(
      "清理不属于当前节点的 Agent 执行记录",
    );
  });
});

interface CapturedRun {
  id: string;
  instanceId: string;
  status: "queued";
  payload: { context: Record<string, string> };
  /** 真实 harness 在 worker 启动时把会话 id 写回 run；这里模拟成确定值。 */
  sessionId?: string;
}

function contextHarness(
  options: { readonly execution?: "builtin" | "external" } = {},
) {
  const tasks = service();
  const dispatched: Array<{
    profileId: string;
    payload: { context: Record<string, string> };
  }> = [];
  const runs = new Map<string, CapturedRun>();
  /** 每次派发交给 teammate runtime 的操作者信息（角色是首次开通执行身份的关键）。 */
  const runtimeActors: Array<{ teammateId: string; role?: string }> = [];
  const team = {
    resolveToken: (
      candidate: string,
    ):
      | { userId: string; role?: "admin" | "owner" | "member" | "guest" }
      | undefined =>
      candidate === "token" ? { userId: "admin", role: "admin" } : undefined,
    users: (): Array<{ id: string; name: string; role: string }> => [
      { id: "admin", name: "Admin", role: "admin" },
    ],
    members: (
      _workspaceId: string,
    ): Array<{ userId: string; memberRole: "owner" | "member" }> => [
      { userId: "admin", memberRole: "owner" },
    ],
  };
  const routes = createTaskRoutes(
    tasks,
    team,
    undefined,
    undefined,
    () => ({
      bindTask: () => undefined,
      dispatch: async (input) => {
        const id = `run-${String(runs.size + 1)}`;
        const run: CapturedRun = {
          id,
          instanceId: (input as unknown as { instanceId: string }).instanceId,
          status: "queued",
          payload: (
            input as unknown as { payload: { context: Record<string, string> } }
          ).payload,
          sessionId: `de-task-${(input as unknown as { instanceId: string }).instanceId}-test`,
        };
        runs.set(id, run);
        dispatched.push({
          profileId: (input as unknown as { profileId: string }).profileId,
          payload: run.payload,
        });
        return run;
      },
      run: (runId: string) => runs.get(runId),
    }),
    {
      get: () => ({ id: "workspace-1", path: "/tmp/workspace-1" }),
      list: () => [{ id: "workspace-1", path: "/tmp/workspace-1" }],
    },
    () => ({
      assignable: () => [
        {
          id: "tm-1",
          name: "测小白",
          ownerUserId: "admin",
          ownerName: "平台",
          source: "platform" as const,
          avatar: "",
        },
      ],
      // 每个 teammate 实例对应一套独立执行身份：被 @ 的协作方要落到自己的会话。
      ensureRuntime: async (input) => {
        runtimeActors.push({
          teammateId: input.teammateId,
          ...(input.actor?.role === undefined
            ? {}
            : { role: input.actor.role }),
        });
        const base =
          input.teammateId === "tm-1"
            ? {
                teammateId: input.teammateId,
                employeeId: "digital-1",
                profileId: "agent-1",
                personaId: "persona-tm-1",
              }
            : {
                teammateId: input.teammateId,
                employeeId: `digital-${input.teammateId.replace(/[^a-zA-Z0-9]/g, "")}`,
                profileId: `agent-${input.teammateId.replace(/[^a-zA-Z0-9]/g, "")}`,
                personaId: `persona-${input.teammateId.replace(/[^a-zA-Z0-9]/g, "")}`,
              };
        return {
          ...base,
          ...(options.execution === undefined
            ? {}
            : { execution: options.execution }),
        };
      },
    }),
  );
  const route = (path: string) => {
    const found = routes.find((candidate) => candidate.path === path);
    if (found === undefined) throw new Error(`missing route ${path}`);
    return found;
  };
  return { tasks, dispatched, runs, route, team, runtimeActors };
}

describe("task context delivery", () => {
  it("delivers the full task context once, then only increments", async () => {
    const { tasks, route, dispatched } = contextHarness();
    const created = fakeResponse();
    await route("/api/collab/tasks/create").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "优化产品设计文档",
          priority: "P2",
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
          description: "把已生成的产品设计文档检查一遍并优化。",
          acceptance: ["文档结构完整", "补充风险章节"],
        },
      }),
      created.response,
    );
    const createResult = created.read();
    expect(createResult.status).toBe(200);
    const task = (createResult.body?.task ?? {}) as { id: string };
    expect(dispatched).toHaveLength(1);
    const first = dispatched[0]?.payload.context.instruction ?? "";
    expect(first).toContain("# 任务");
    expect(first).toContain("把已生成的产品设计文档检查一遍并优化。");
    expect(first).toContain("## 验收标准");
    expect(first).toContain("## 本次需要你响应");
    expect(dispatched[0]?.payload.context.firstDelivery).toBe("true");

    // 模拟 Agent 完成一轮：它的回复已经写进会话历史，增量不应再回灌
    await tasks.attachAgentRun(
      task.id,
      {
        id: "run-1",
        instanceId: task.id,
        status: "succeeded",
        output: { summary: "这是 Agent 的旧结论" },
      },
      "测小白",
    );

    // 评论区不 @ 执行人 = 讨论：只记录，不触发执行
    const discussion = fakeResponse();
    await route("/api/collab/tasks/comment").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/comment",
        body: {
          taskId: task.id,
          content: "我们内部再确认一下风险章节的口径。",
          isKeyConsensus: true,
        },
      }),
      discussion.response,
    );
    expect(discussion.read().body?.dispatched).toBe(false);
    expect(
      (
        discussion.read().body?.task as
          { comments?: Array<Record<string, unknown>> } | undefined
      )?.comments?.at(-1),
    ).toMatchObject({ isKeyConsensus: true });
    expect(dispatched).toHaveLength(1);

    // 指令输入框：不 @ 也直接触发，且只投递增量
    const followUp = fakeResponse();
    await route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body: { taskId: task.id, content: "请按确认后的口径更新风险章节。" },
      }),
      followUp.response,
    );
    expect(followUp.read().status).toBe(200);
    expect(dispatched).toHaveLength(2);
    const second = dispatched[1]?.payload.context.instruction ?? "";
    expect(second).not.toContain("# 任务");
    expect(second).toContain("## 上次投递之后的新增讨论");
    expect(second).not.toContain("这是 Agent 的旧结论");
    expect(second).not.toContain("我们内部再确认一下风险章节的口径。");
    expect(second).toContain("请按确认后的口径更新风险章节。");
    expect(dispatched[1]?.payload.context.firstDelivery).toBe("false");
    expect(dispatched[1]?.payload.context.taskReceiverId).toBe("tm-1");

    // 评论里 @ 执行人：也触发一次
    const mention = fakeResponse();
    await route("/api/collab/tasks/comment").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/comment",
        body: {
          taskId: task.id,
          content: "@测小白 风险章节还差一条指标说明。",
        },
      }),
      mention.response,
    );
    expect(mention.read().status).toBe(200);
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]?.payload.context.instruction).toContain(
      "@测小白 风险章节还差一条指标说明。",
    );

    // 重置执行会话：下一次执行换新会话，并重新注入完整上下文
    const reset = fakeResponse();
    await route("/api/collab/tasks/session/reset").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/session/reset",
        body: { taskId: task.id },
      }),
      reset.response,
    );
    const resetResult = reset.read();
    expect(resetResult.status).toBe(200);
    expect(
      (resetResult.body?.task as { sessionEpoch?: number } | undefined)
        ?.sessionEpoch,
    ).toBe(1);
    const afterReset = fakeResponse();
    await route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body: { taskId: task.id, content: "@测小白 按新会话重新开始。" },
      }),
      afterReset.response,
    );
    expect(dispatched).toHaveLength(4);
    expect(dispatched[3]?.payload.context.taskSessionEpoch).toBe("1");
    expect(dispatched[3]?.payload.context.firstDelivery).toBe("true");
    expect(dispatched[3]?.payload.context.instruction).toContain("# 任务");
  });

  it("resends full task context to stateless external agents", async () => {
    const { tasks, route, dispatched } = contextHarness({
      execution: "external",
    });
    const created = fakeResponse();
    await route("/api/collab/tasks/create").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "外部 Agent 反馈修复",
          priority: "P2",
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
          description: "先生成报告。",
          acceptance: ["报告可直接审阅"],
        },
      }),
      created.response,
    );
    expect(created.read().status).toBe(200);
    expect(dispatched[0]?.payload.context.instruction).toContain("# 任务");

    const task = (created.read().body?.task ?? {}) as { id: string };
    await tasks.addMessage(olivia, {
      taskId: task.id,
      content: "补充前置约束：不要改目录结构。",
    });
    await tasks.attachAgentRun(
      task.id,
      {
        id: "run-1",
        instanceId: task.id,
        status: "succeeded",
        output: { summary: "旧结论" },
      },
      "测小白",
    );

    const followUp = fakeResponse();
    await route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body: { taskId: task.id, content: "需形成 md 文档报告。" },
      }),
      followUp.response,
    );
    expect(followUp.read().status).toBe(200);
    const second = dispatched[1]?.payload.context.instruction ?? "";
    expect(second).toContain("# 任务");
    expect(second).toContain("先生成报告。");
    expect(second).toContain("补充前置约束：不要改目录结构。");
    expect(second).toContain("## 验收标准");
    expect(second).toContain("旧结论");
    expect(second).toContain("需形成 md 文档报告。");
    expect(dispatched[1]?.payload.context.firstDelivery).toBe("true");
  });
});

describe("task continuation re-dispatch", () => {
  const createAssignedTask = async (
    harness: ReturnType<typeof contextHarness>,
  ): Promise<{ id: string }> => {
    const created = fakeResponse();
    await harness.route("/api/collab/tasks/create").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "优化产品设计文档",
          priority: "P2",
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
          description: "把已生成的产品设计文档检查一遍并优化。",
          acceptance: ["文档结构完整", "补充风险章节"],
        },
      }),
      created.response,
    );
    return (created.read().body?.task ?? {}) as { id: string };
  };

  const settleFirstRound = async (
    harness: ReturnType<typeof contextHarness>,
    taskId: string,
  ): Promise<void> => {
    // 第一轮跑完：会话里已有 Agent 的结论，任务回到待验收，责任人仍是这个 Agent。
    await harness.tasks.attachAgentRun(
      taskId,
      {
        id: "run-1",
        instanceId: taskId,
        status: "succeeded",
        output: { summary: "这是 Agent 的上一轮结论" },
      },
      "测小白",
    );
  };

  const reassignToSameAgent = async (
    harness: ReturnType<typeof contextHarness>,
    taskId: string,
  ) => {
    const assigned = fakeResponse();
    await harness.route("/api/collab/tasks/assign").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/assign",
        body: {
          taskId,
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
        },
      }),
      assigned.response,
    );
    return assigned.read();
  };

  /** 人工 review OK：任务进入「已完成」。 */
  const approveTask = async (
    harness: ReturnType<typeof contextHarness>,
    taskId: string,
  ): Promise<string | undefined> => {
    const approved = fakeResponse();
    await harness.route("/api/collab/tasks/action").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId, action: "approve" },
      }),
      approved.response,
    );
    const result = approved.read();
    expect(result.status).toBe(200);
    return (result.body?.task as { status?: string } | undefined)?.status;
  };

  it("pushes the edited task body into the same session when reassigned", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    expect(dispatched).toHaveLength(1);

    // 人工 review OK 后追加要求：改的是任务内容，不产生新消息。
    const edited = fakeResponse();
    await harness.route("/api/collab/tasks/update").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/update",
        body: {
          taskId: task.id,
          title: "优化产品设计文档",
          priority: "P2",
          description:
            "把已生成的产品设计文档检查一遍并优化。追加：补一节回滚方案。",
          acceptance: ["文档结构完整", "补充风险章节", "回滚方案可执行"],
        },
      }),
      edited.response,
    );
    expect(edited.read().status).toBe(200);

    const assigned = await reassignToSameAgent(harness, task.id);
    expect(assigned.status).toBe(200);

    // 改派给同一个 Agent 必须真的唤起它，并把最新定义推进同一条会话。
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.payload.context.firstDelivery).toBe("false");
    expect(dispatched[1]?.payload.context.taskReceiverId).toBe("tm-1");
    const instruction = dispatched[1]?.payload.context.instruction ?? "";
    expect(instruction).toContain("# 任务（已更新）");
    expect(instruction).toContain("补一节回滚方案");
    expect(instruction).toContain("回滚方案可执行");
    expect(instruction).not.toContain("这是 Agent 的上一轮结论");
  });

  it("restores the submitting agent and immediately redelivers a rejection note", async () => {
    const harness = contextHarness();
    const { dispatched, tasks } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    await tasks.assign(
      { id: "admin", name: "Admin", kind: "human" },
      {
        taskId: task.id,
        receiverType: "human",
        receiverId: "admin",
        receiverName: "平台 Admin",
      },
    );
    expect(tasks.get(task.id)).toMatchObject({
      status: "review",
      receiverType: "human",
      receiverId: "admin",
      reviewSubmitter: {
        receiverType: "agent",
        receiverId: "tm-1",
        receiverName: "测小白",
      },
    });
    expect(dispatched).toHaveLength(1);

    const note = "请补充风险清单，并为每个风险写出应对措施和责任人。";
    const rejected = fakeResponse();
    await harness.route("/api/collab/tasks/action").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: task.id, action: "reject", note },
      }),
      rejected.response,
    );

    const result = rejected.read();
    expect(result.status).toBe(200);
    const rejectedTask = result.body?.task as
      | (Record<string, unknown> & {
          messages?: Array<Record<string, unknown>>;
        })
      | undefined;
    expect(rejectedTask).toMatchObject({
      status: "progress",
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "测小白",
    });
    expect(rejectedTask?.reviewSubmitter).toBeUndefined();
    const rejectedMessages = rejectedTask?.messages ?? [];
    expect(rejectedMessages).toContainEqual(
      expect.objectContaining({
        kind: "human",
        content: note,
        deliveryTarget: "receiver",
      }),
    );
    expect(result.body?.execution).toMatchObject({ runId: "run-2" });

    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.payload.context.taskReceiverId).toBe("tm-1");
    expect(dispatched[1]?.payload.context.triggerMessageId).not.toBe("");
    expect(dispatched[1]?.payload.context.instruction).toContain(note);
    expect(
      tasks
        .get(task.id)
        .messages.some(
          (message) => message.kind === "human" && message.content === note,
        ),
    ).toBe(true);
  });

  it("keeps rejected feedback active when a failed run is retried", async () => {
    const harness = contextHarness();
    const { dispatched, tasks } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    await tasks.assign(
      { id: "admin", name: "Admin", kind: "human" },
      {
        taskId: task.id,
        receiverType: "human",
        receiverId: "admin",
        receiverName: "平台 Admin",
      },
    );

    const note = "补充分析过程说明，并解释订单需求缺口如何影响结论。";
    const rejected = fakeResponse();
    await harness.route("/api/collab/tasks/action").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: task.id, action: "reject", note },
      }),
      rejected.response,
    );
    expect(rejected.read().status).toBe(200);
    expect(dispatched).toHaveLength(2);

    await tasks.attachAgentRun(
      task.id,
      {
        id: "run-2",
        instanceId: task.id,
        status: "failed",
        error: "502 TLS connection failed",
      },
      "测小白",
    );

    const retried = fakeResponse();
    await harness.route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body: { taskId: task.id, content: "重试一下" },
      }),
      retried.response,
    );
    expect(retried.read().status).toBe(200);
    expect(dispatched).toHaveLength(3);

    const instruction = dispatched[2]?.payload.context.instruction ?? "";
    const activeSection = instruction.slice(
      instruction.indexOf("## 本次需要你响应"),
    );
    expect(activeSection).toContain("本轮仍有尚未完成的人类要求");
    expect(activeSection).toContain(note);
    expect(activeSection).toContain("重试一下");
  });

  it("stays a no-op when the same agent already saw everything", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    expect(dispatched).toHaveLength(1);

    const assigned = await reassignToSameAgent(harness, task.id);
    expect(assigned.status).toBe(200);
    // 没有新消息、任务内容也没改：不应该重复唤起 Agent。
    expect(dispatched).toHaveLength(1);
  });

  it("reopens a completed task when a new instruction arrives, in the same session", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    expect(await approveTask(harness, task.id)).toBe("done");

    // 通过之后追加要求：发送一条新指令。
    const followUp = fakeResponse();
    await harness.route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body: { taskId: task.id, content: "再补一节回滚方案，明天前给结论。" },
      }),
      followUp.response,
    );
    const result = followUp.read();
    expect(result.status).toBe(200);
    // 任务被重开并立刻进入新一轮执行。
    expect((result.body?.task as { status?: string } | undefined)?.status).toBe(
      "progress",
    );
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.payload.context.firstDelivery).toBe("false");
    expect(dispatched[1]?.payload.context.taskReceiverId).toBe("tm-1");
    expect(dispatched[1]?.payload.context.instruction).toContain(
      "再补一节回滚方案",
    );
  });

  it("reopens a completed task on reassignment and re-runs the agent", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    expect(await approveTask(harness, task.id)).toBe("done");

    // 通过之后原样改派给同一个 Agent：也要真的重开一轮。
    const assigned = await reassignToSameAgent(harness, task.id);
    expect(assigned.status).toBe(200);
    expect(
      (assigned.body?.task as { status?: string } | undefined)?.status,
    ).toBe("progress");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.payload.context.firstDelivery).toBe("false");
  });

  it("reopens a completed task on content edit and carries the new criteria", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    await settleFirstRound(harness, task.id);
    expect(await approveTask(harness, task.id)).toBe("done");

    // 追加一条验收标准：任务重开为待处理，但编辑本身不触发执行。
    const edited = fakeResponse();
    await harness.route("/api/collab/tasks/update").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/update",
        body: {
          taskId: task.id,
          title: "优化产品设计文档",
          priority: "P2",
          description:
            "把已生成的产品设计文档检查一遍并优化。追加：补一节回滚方案。",
          acceptance: ["文档结构完整", "补充风险章节", "回滚方案可执行"],
        },
      }),
      edited.response,
    );
    const editedResult = edited.read();
    expect(editedResult.status).toBe(200);
    expect(
      (editedResult.body?.task as { status?: string } | undefined)?.status,
    ).toBe("todo");
    expect(dispatched).toHaveLength(1);

    // 改派给同一个 Agent：新一轮带上更新后的定义。
    const assigned = await reassignToSameAgent(harness, task.id);
    expect(assigned.status).toBe(200);
    expect(dispatched).toHaveLength(2);
    const instruction = dispatched[1]?.payload.context.instruction ?? "";
    expect(instruction).toContain("# 任务（已更新）");
    expect(instruction).toContain("回滚方案可执行");
  });
});

describe("task cross-agent mention", () => {
  const createAssignedTask = async (
    harness: ReturnType<typeof contextHarness>,
  ): Promise<{ id: string }> => {
    const created = fakeResponse();
    await harness.route("/api/collab/tasks/create").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "优化产品设计文档",
          priority: "P2",
          receiverType: "agent",
          receiverId: "tm-1",
          receiverName: "测小白",
          description: "把已生成的产品设计文档检查一遍并优化。",
          acceptance: ["文档结构完整", "补充风险章节"],
        },
      }),
      created.response,
    );
    return (created.read().body?.task ?? {}) as { id: string };
  };

  const postMessage = async (
    harness: ReturnType<typeof contextHarness>,
    body: Record<string, unknown>,
  ) => {
    const posted = fakeResponse();
    await harness.route("/api/collab/tasks/message").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/message",
        body,
      }),
      posted.response,
    );
    return posted.read();
  };

  it("dispatches to the mentioned agents in their own sessions and skips the assignee", async () => {
    const harness = contextHarness();
    const { route, dispatched, tasks } = harness;
    const task = await createAssignedTask(harness);
    const beforeStatus = tasks.get(task.id).status;
    // 只观察这条消息产生的派发。
    dispatched.length = 0;

    const result = await postMessage(harness, {
      taskId: task.id,
      content: "@柯真 01 测试 @陆行01 开发 你们看下这个PRD是否可以进入开发",
      deliveryTarget: "collaborators",
      mentions: [
        { kind: "agent", id: "tm-qa", name: "柯真 01 测试" },
        { kind: "agent", id: "tm-dev", name: "陆行01 开发" },
      ],
    });
    expect(result.status).toBe(200);
    // 内容不是要求任务责任人执行：不要唤起它。
    expect(result.body?.dispatched).toBe(false);

    // 两个被 @ 的 Agent 各自一轮，各自用自己的执行身份（= 各自的会话）。
    expect(dispatched).toHaveLength(2);
    expect(dispatched.map((item) => item.payload.context.taskRunRole)).toEqual([
      "assist",
      "assist",
    ]);
    expect(
      dispatched.map((item) => item.payload.context.taskReceiverId),
    ).toEqual(["tm-qa", "tm-dev"]);
    expect(dispatched.map((item) => item.payload.context.receiverId)).toEqual([
      "digital-tmqa",
      "digital-tmdev",
    ]);

    // 上下文里带上任务定义、@ 的诉求，并声明它不是任务责任人。
    const instruction = dispatched[0]?.payload.context.instruction ?? "";
    expect(instruction).toContain("# 你在任务里被 @ 了");
    expect(instruction).toContain("# 任务定义");
    expect(instruction).toContain("把已生成的产品设计文档检查一遍并优化。");
    expect(instruction).toContain("你们看下这个PRD是否可以进入开发");
    expect(instruction).toContain("任务责任人不是你");

    // 协作轮次写回任务历史，任务生命周期没有被推进。
    const updated = tasks.get(task.id);
    expect(updated.status).toBe(beforeStatus);
    expect(updated.messages.at(-1)?.authorName).toBe("陆行01 开发");
    expect(updated.messages.at(-1)?.authorId).toBe("tm-dev");
    expect(route("/api/collab/tasks/message")).toBeDefined();
  });

  it("keeps a completed task done when only collaborator agents are mentioned", async () => {
    const harness = contextHarness();
    const { tasks, dispatched } = harness;
    const task = await createAssignedTask(harness);
    const admin = { id: "admin", name: "Admin", kind: "human" as const };
    await tasks.start(admin, task.id);
    await tasks.approve(admin, task.id);
    expect(tasks.get(task.id).status).toBe("done");
    dispatched.length = 0;

    const result = await postMessage(harness, {
      taskId: task.id,
      content: "@柯真 01 测试 @陆行01 开发 你们看下这个PRD是否可以进入开发",
      deliveryTarget: "collaborators",
      mentions: [
        { kind: "agent", id: "tm-qa", name: "柯真 01 测试" },
        { kind: "agent", id: "tm-dev", name: "陆行01 开发" },
      ],
    });

    expect(result.status).toBe(200);
    expect(result.body?.dispatched).toBe(false);
    expect((result.body?.task as { status?: string } | undefined)?.status).toBe(
      "done",
    );
    expect(tasks.get(task.id).status).toBe("done");
    expect(dispatched).toHaveLength(2);
    expect(
      tasks
        .get(task.id)
        .events.filter((event) => event.kind === "message")
        .slice(-2)
        .map((event) => event.message),
    ).toEqual(["柯真 01 测试 开始协作执行", "陆行01 开发 开始协作执行"]);
  });

  it("still runs the assignee when the message also mentions it", async () => {
    const harness = contextHarness();
    const { dispatched } = harness;
    const task = await createAssignedTask(harness);
    dispatched.length = 0;

    const result = await postMessage(harness, {
      taskId: task.id,
      content: "@测小白 你先给出结论，@柯真 01 测试 也一起看下",
      deliveryTarget: "broadcast",
      mentions: [
        { kind: "agent", id: "tm-1", name: "测小白" },
        { kind: "agent", id: "tm-qa", name: "柯真 01 测试" },
      ],
    });
    expect(result.status).toBe(200);
    expect(dispatched.map((item) => item.payload.context.taskRunRole)).toEqual([
      "assist",
      "owner",
    ]);
    expect(dispatched[1]?.payload.context.taskReceiverId).toBe("tm-1");
    expect(dispatched[1]?.payload.context.triggerMessageId).not.toBe("");
  });

  it("honors an explicit receiver target instead of inferring from mentions", async () => {
    const harness = contextHarness();
    const { tasks, dispatched } = harness;
    const task = await createAssignedTask(harness);
    const admin = { id: "admin", name: "Admin", kind: "human" as const };
    await tasks.start(admin, task.id);
    await tasks.approve(admin, task.id);
    dispatched.length = 0;

    const result = await postMessage(harness, {
      taskId: task.id,
      content: "@柯真 01 测试 请协作，同时责任人继续处理",
      deliveryTarget: "receiver",
      mentions: [{ kind: "agent", id: "tm-qa", name: "柯真 01 测试" }],
    });

    expect(result.status).toBe(200);
    expect(result.body?.dispatched).toBeUndefined();
    expect(dispatched.map((item) => item.payload.context.taskRunRole)).toEqual([
      "owner",
    ]);
    expect(tasks.get(task.id).status).toBe("progress");
    expect(
      tasks.get(task.id).messages.find((message) => message.kind === "human")
        ?.deliveryTarget,
    ).toBe("receiver");
  });

  it("keeps the task lifecycle untouched when a mentioned agent reports back", async () => {
    const harness = contextHarness();
    const { dispatched, tasks } = harness;
    const task = await createAssignedTask(harness);
    dispatched.length = 0;
    await postMessage(harness, {
      taskId: task.id,
      content: "@柯真 01 测试 看下这个PRD是否可以进入开发",
      mentions: [{ kind: "agent", id: "tm-qa", name: "柯真 01 测试" }],
    });
    const before = tasks.get(task.id);
    const assistRunId = before.messages.at(-1)?.runId;
    expect(assistRunId).toBeDefined();

    // 协作方结算：只写回反馈，不推进状态、不标记验收步骤。
    await tasks.attachAgentRun(
      task.id,
      {
        id: assistRunId ?? "",
        instanceId: task.id,
        status: "succeeded",
        output: { summary: "评审意见：可以进入开发，注意补回滚方案。" },
      },
      "柯真 01 测试",
      undefined,
      { role: "assist", authorId: "tm-qa", authorName: "柯真 01 测试" },
    );
    const after = tasks.get(task.id);
    expect(after.status).toBe(before.status);
    expect(after.progress).toBe(before.progress);
    expect(after.steps.every((step) => step.done)).toBe(false);
    expect(after.messages.at(-1)?.content).toBe(
      "评审意见：可以进入开发，注意补回滚方案。",
    );
    expect(after.messages.at(-1)?.authorName).toBe("柯真 01 测试");
    expect(after.messages.at(-1)?.runRole).toBe("assist");
  });

  it("refuses any write that would move a task to another project", async () => {
    const harness = contextHarness();
    const task = await createAssignedTask(harness);
    // put() 是任务唯一的写入口：直接以「换了项目」的任务写回必须被拒绝。
    const write = (
      harness.tasks as unknown as {
        put(task: unknown): Promise<unknown>;
      }
    ).put;
    await expect(
      write.call(harness.tasks, {
        ...harness.tasks.get(task.id),
        workspaceId: "workspace-2",
      }),
    ).rejects.toThrow("任务归属项目创建后不可变更");
    expect(harness.tasks.get(task.id).workspaceId).toBe("workspace-1");
  });

  it("keeps the owning project even when a request asks to move the task", async () => {
    const harness = contextHarness();
    const { route } = harness;
    const task = await createAssignedTask(harness);

    const moved = fakeResponse();
    await route("/api/collab/tasks/update").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/update",
        body: {
          taskId: task.id,
          workspaceId: "workspace-2",
          title: "试图换项目",
          priority: "P2",
          description: "把归属项目改掉试试。",
          acceptance: ["不能被换项目"],
        },
      }),
      moved.response,
    );
    const result = moved.read();
    expect(result.status).toBe(200);
    expect(
      (result.body?.task as { workspaceId?: string } | undefined)?.workspaceId,
    ).toBe("workspace-1");
    expect(harness.tasks.get(task.id).workspaceId).toBe("workspace-1");
    expect(harness.tasks.get(task.id).title).toBe("试图换项目");
  });

  it("only allows nudging tasks assigned to a human", async () => {
    const harness = contextHarness();
    const { route, tasks } = harness;
    const agentTask = await createAssignedTask(harness);

    // Agent 承接的任务：催办没有意义（推进靠指令/改派），接口层直接拒绝。
    const refused = fakeResponse();
    await route("/api/collab/tasks/action").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: agentTask.id, action: "nudge" },
      }),
      refused.response,
    );
    expect(refused.read().status).toBe(409);

    const humanTask = await tasks.create(
      { id: "admin", name: "Admin", kind: "human", role: "admin" },
      {
        workspaceId: "workspace-1",
        title: "指派给人的任务",
        priority: "P2",
        receiverType: "human",
        receiverId: "admin",
        receiverName: "Admin",
        description: "请尽快处理。",
        acceptance: ["完成"],
      },
    );
    const nudged = fakeResponse();
    await route("/api/collab/tasks/action").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/action",
        body: { taskId: humanTask.id, action: "nudge" },
      }),
      nudged.response,
    );
    expect(nudged.read().status).toBe(200);
    // 催办留一条 nudge 事件：工作台简报按它把任务带进被催办人的简报。
    expect(tasks.get(humanTask.id).events.at(-1)?.kind).toBe("nudge");
  });

  it("resolves the caller's role before provisioning a fresh agent runtime", async () => {
    const harness = contextHarness();
    // 会议模块那条内域路径：调用方只带 id/name，没有 role（平台管理员也是）。
    harness.team.resolveToken = () => ({ userId: "admin" });
    const created = fakeResponse();
    await harness.route("/api/collab/tasks/create").handler(
      fakeRequest({
        method: "POST",
        url: "/api/collab/tasks/create",
        body: {
          workspaceId: "workspace-1",
          title: "贪食蛇 0.1迭代 需求评审会 · 会议 Facilitator",
          priority: "P2",
          receiverType: "agent",
          receiverId: "meeting-facilitator",
          receiverName: "会议 Facilitator",
          description: "你是这场会议的 AI 参会方。",
          acceptance: ["被 @ 时给出反馈"],
        },
      }),
      created.response,
    );
    expect(created.read().status).toBe(200);
    // 首次开通执行身份时 teammate/employee 域按 owner/admin 校验操作者；
    // 角色被丢成 member 就会直接 403「workspace owner or admin is required」。
    expect(harness.runtimeActors.at(-1)).toEqual({
      teammateId: "meeting-facilitator",
      role: "admin",
    });
  });

  it("exposes the task's agent session so the UI can jump to it", async () => {
    const harness = contextHarness();
    const { route } = harness;
    const task = await createAssignedTask(harness);

    const found = fakeResponse();
    await route("/api/collab/tasks/session").handler(
      fakeRequest({
        method: "GET",
        url: `/api/collab/tasks/session?taskId=${task.id}`,
      }),
      found.response,
    );
    const result = found.read();
    expect(result.status).toBe(200);
    // 「打开会话」入口就是靠这个 sessionId：和 harness 实际落盘的那条会话一致。
    expect(result.body?.sessionId).toBe(`de-task-${task.id}-test`);
  });
});

describe("task queue and待确认", () => {
  const queueTask = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: "todo",
    priority: "P2",
    ...overrides,
  });

  const createTask = (
    tasks: TaskService,
    title: string,
    overrides: Record<string, unknown> = {},
  ) =>
    tasks.create(olivia, {
      workspaceId: "workspace-1",
      title,
      priority: "P1",
      receiverType: "unassigned",
      description: title,
      acceptance: ["done"],
      ...overrides,
    });

  it("keeps manual order and appends unsorted tasks to the tail", () => {
    const ordered = orderQueue([
      queueTask("TSK-new"),
      queueTask("TSK-b", { queueSeq: 2000 }),
      queueTask("TSK-a", { queueSeq: 1000 }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual([
      "TSK-a",
      "TSK-b",
      "TSK-new",
    ]);
  });

  it("falls back to draft order (priority → due → id) before any manual sort", () => {
    const ordered = orderQueue([
      queueTask("TSK-p3", { priority: "P3" }),
      queueTask("TSK-p1-late", { priority: "P1", due: "2026-10-20" }),
      queueTask("TSK-p1-soon", { priority: "P1", due: "2026-10-13" }),
    ]);
    expect(ordered.map((task) => task.id)).toEqual([
      "TSK-p1-soon",
      "TSK-p1-late",
      "TSK-p3",
    ]);
  });

  it("skips paused, blocked and dependency-blocked tasks when picking", () => {
    const tasks = [
      queueTask("TSK-paused", { queueState: "paused", queueSeq: 1000 }),
      queueTask("TSK-dep", { queueSeq: 2000, dependsOn: ["TSK-blocker"] }),
      queueTask("TSK-blocker", { queueSeq: 3000, status: "review" }),
      queueTask("TSK-ready", { queueSeq: 4000 }),
    ];
    expect(pickNextTask({ tasks, running: false })?.id).toBe("TSK-ready");
    expect(pickNextTask({ tasks, running: true })).toBeUndefined();
  });

  it("only filters auto-run eligibility during unattended runs", () => {
    const tasks = [queueTask("TSK-manual", { autoRunEligible: false })];
    expect(
      pickNextTask({ tasks, running: false, autoRun: true }),
    ).toBeUndefined();
    expect(pickNextTask({ tasks, running: false })?.id).toBe("TSK-manual");
  });

  it("reorders by writing queueSeq and parks new tasks behind them", async () => {
    const tasks = service();
    const first = await createTask(tasks, "A");
    const second = await createTask(tasks, "B");
    await tasks.reorderQueue(olivia, { taskIds: [second.id, first.id] });
    expect(tasks.get(second.id).queueSeq).toBe(1000);
    expect(tasks.get(first.id).queueSeq).toBe(2000);

    const third = await createTask(tasks, "C");
    expect(third.queueSeq).toBeUndefined();
    const ordered = tasks.sortQueue([
      tasks.get(third.id),
      tasks.get(first.id),
      tasks.get(second.id),
    ]);
    expect(ordered.map((task) => task.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);
  });

  it("supports approve / handoff on a review task", async () => {
    const tasks = service();
    const created = await createTask(tasks, "待确认闭环", {
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "小白 PD",
    });
    const inReview = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-1",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "交付完成" },
      },
      "小白 PD",
      { userId: "olivia", name: "Olivia" },
    );
    expect(inReview.status).toBe("review");
    expect(inReview.receiverType).toBe("human");
    expect(inReview.reviewSubmitter).toMatchObject({
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "小白 PD",
    });

    const handed = await tasks.confirm(olivia, {
      taskId: created.id,
      action: "handoff",
      assigneeId: "peter",
      assigneeName: "Peter",
    });
    expect(handed.receiverId).toBe("peter");
    expect(handed.events.at(-1)?.message).toContain("转交 Peter");

    const approved = await tasks.confirm(olivia, {
      taskId: created.id,
      action: "approve",
    });
    expect(approved.status).toBe("done");
    expect(approved.progress).toBe(100);
    expect(approved.reviewSubmitter).toBeUndefined();
  });

  it("requeues a rejected task with the note and a tail sequence", async () => {
    const tasks = service();
    const other = await createTask(tasks, "既有任务");
    await tasks.reorderQueue(olivia, { taskIds: [other.id] });
    const created = await createTask(tasks, "退回并补充", {
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "小白 PD",
    });
    await tasks.attachAgentRun(
      created.id,
      {
        id: "run-2",
        instanceId: created.id,
        status: "succeeded",
        output: { summary: "先给一版" },
      },
      "小白 PD",
      { userId: "olivia", name: "Olivia" },
    );
    const rejected = await tasks.confirm(olivia, {
      taskId: created.id,
      action: "reject",
      note: "请补充证据链",
    });
    expect(rejected.status).toBe("todo");
    expect(rejected.needsInput).toBe(false);
    expect(rejected.queueSeq).toBe(2000);
    expect(rejected.receiverType).toBe("agent");
    expect(rejected.receiverId).toBe("tm-1");
    expect(rejected.receiverName).toBe("小白 PD");
    expect(rejected.reviewSubmitter).toBeUndefined();
    expect(rejected.messages.at(-1)?.content).toBe("请补充证据链");
    expect(rejected.events.at(-1)?.message).toContain("负责人恢复为 小白 PD");
    // 退回后任务已回到「待处理」，再次退回属于状态冲突。
    await expect(
      tasks.confirm(olivia, { taskId: created.id, action: "reject" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // 退回必须写补充说明。
    const another = await createTask(tasks, "退回必填原因", {
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "小白 PD",
    });
    await tasks.attachAgentRun(
      another.id,
      {
        id: "run-4",
        instanceId: another.id,
        status: "succeeded",
        output: { summary: "完成" },
      },
      "小白 PD",
      { userId: "olivia", name: "Olivia" },
    );
    await expect(
      tasks.confirm(olivia, { taskId: another.id, action: "reject" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("marks waiting_input runs as feedback items handed to the owner", async () => {
    const tasks = service();
    const created = await createTask(tasks, "需要补充信息", {
      receiverType: "agent",
      receiverId: "tm-1",
      receiverName: "小白 PD",
    });
    const waiting = await tasks.attachAgentRun(
      created.id,
      {
        id: "run-3",
        instanceId: created.id,
        status: "waiting_input",
        output: { summary: "缺少接口契约" },
      },
      "小白 PD",
      { userId: "olivia", name: "Olivia" },
    );
    expect(waiting.needsInput).toBe(true);
    expect(waiting.status).toBe("progress");
    expect(waiting.receiverType).toBe("human");
    expect(waiting.receiverId).toBe("olivia");
    expect(waiting.events.at(-1)?.message).toContain("需要补充信息");
  });
});
