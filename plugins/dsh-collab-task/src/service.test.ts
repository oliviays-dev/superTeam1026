import { describe, expect, it } from "vitest";
import { TaskService, type KvTableLike } from "./service.js";
import type { TaskRecord } from "./types.js";

function memoryTable(): KvTableLike<TaskRecord> {
  const values = new Map<string, TaskRecord>();
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

const actor = { id: "admin", name: "Admin", kind: "human" } as const;

function storedTask(overrides: Record<string, unknown> = {}): TaskRecord {
  return {
    id: "TSK-legacy",
    workspaceId: "workspace-1",
    title: "Product design",
    type: "工作流",
    status: "progress",
    priority: "P2",
    receiverType: "human",
    receiverId: "admin",
    receiverName: "Admin",
    createdBy: "admin",
    createdByName: "Admin",
    description: "Submit the deliverable.",
    acceptance: ["PRD"],
    links: [],
    progress: 0,
    sessionEpoch: 0,
    autoSubmitReview: true,
    steps: [{ id: "step-1", label: "PRD", done: false }],
    agentRunIds: [],
    messages: [],
    comments: [],
    events: [],
    queueState: "idle",
    dependsOn: [],
    autoRunEligible: true,
    needsInput: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as TaskRecord;
}

describe("task execution policy", () => {
  it("stores and updates the phase-one execution policy", async () => {
    const tasks = new TaskService({ tasks: memoryTable() });
    const executionPolicy = {
      schemaVersion: 1 as const,
      runtime: {
        selection: "recommended" as const,
        allowedRuntimeIds: [],
        requiredCapabilities: [
          { key: "search" as const, necessity: "required" as const },
        ],
      },
      sourcePolicy: {
        allow: ["workspace", "public-web"] as const,
        deny: ["private-local-data"] as const,
        citation: "required-for-factual-claims" as const,
        requirePublishedAt: true,
        requireAccessedAt: true,
      },
      toolPolicy: {
        allow: [],
        deny: [],
        requireApproval: ["fs.write"],
      },
      evidence: {
        requirePlan: true,
        requireToolEvents: true,
        requireCitations: true,
        requireStructuredSubagents: false,
      },
      humanGates: [],
      budget: {},
    };
    const created = await tasks.create(actor, {
      workspaceId: "workspace-1",
      title: "Research with sources",
      priority: "P2",
      receiverType: "human",
      receiverId: "admin",
      receiverName: "Admin",
      description: "Research the market.",
      acceptance: ["Report with citations"],
      executionPolicy,
    });
    expect(created.executionPolicy).toEqual(executionPolicy);

    const updated = await tasks.update(actor, {
      taskId: created.id,
      title: created.title,
      priority: created.priority,
      description: created.description,
      acceptance: created.acceptance,
      executionPolicy: {
        ...executionPolicy,
        evidence: {
          ...executionPolicy.evidence,
          requireToolEvents: false,
        },
      },
    });
    expect(updated.executionPolicy?.evidence.requireToolEvents).toBe(false);
  });
});

describe("legacy task compatibility", () => {
  it("accepts canonical Principal receivers and keeps compatibility aliases", async () => {
    const table = memoryTable();
    const tasks = new TaskService(
      { tasks: table },
      {
        principals: () => ({
          resolveReference: (reference) => {
            if (reference === "principal:principal-ai-backend") {
              return {
                id: "principal-ai-backend",
                kind: "ai",
                status: "active",
              };
            }
            if (reference === "principal:principal-human-alice") {
              return {
                id: "principal-human-alice",
                kind: "human",
                status: "active",
              };
            }
            return undefined;
          },
          resolveSubject: (subjectType, subjectId) => {
            if (subjectType === "auth-user" && subjectId === "alice") {
              return {
                id: "principal-human-alice",
                kind: "human",
                status: "active",
              };
            }
            return undefined;
          },
          preferredSubjectId: (principalId) =>
            principalId === "principal-ai-backend"
              ? "teammate-backend"
              : principalId === "principal-human-alice"
                ? "alice"
                : undefined,
        }),
      },
    );

    const created = await tasks.create(actor, {
      workspaceId: "workspace-1",
      title: "Principal assignment",
      priority: "P2",
      receiverType: "agent",
      receiverId: "principal:principal-ai-backend",
      receiverName: "Backend AI",
      description: "Handle the implementation.",
      acceptance: ["Done"],
    });
    expect(created).toMatchObject({
      receiverType: "agent",
      receiverId: "teammate-backend",
      receiverPrincipalId: "principal-ai-backend",
    });
    expect(created.events.at(-1)?.actorPrincipalId).toBeUndefined();

    const reassigned = await tasks.assign(
      { id: "alice", name: "Alice", kind: "human" },
      {
        taskId: created.id,
        receiverType: "human",
        receiverId: "principal:principal-human-alice",
        receiverName: "Alice",
      },
    );
    expect(reassigned).toMatchObject({
      receiverType: "human",
      receiverId: "alice",
      receiverPrincipalId: "principal-human-alice",
    });
    expect(reassigned.events.at(-1)?.actorPrincipalId).toBe(
      "principal-human-alice",
    );
  });

  it("treats old human workflow tasks as auto-approved", async () => {
    const table = memoryTable();
    const tasks = new TaskService({ tasks: table });
    const { autoApproveReview: _ignored, ...legacy } = storedTask({
      workflow: {
        instanceId: "wf-1",
        nodeId: "design",
        instanceTitle: "Delivery",
        nodeName: "Design",
        reviewRequired: true,
      },
    });
    await table.put(legacy.id, legacy as TaskRecord);

    expect(tasks.get(legacy.id).autoApproveReview).toBe(true);
    const submitted = await tasks.submit(actor, legacy.id);
    expect(submitted.status).toBe("done");
    expect(submitted.progress).toBe(100);
  });

  it("keeps explicit opt-out and approval tasks on manual review", async () => {
    const table = memoryTable();
    const tasks = new TaskService({ tasks: table });
    const optOut = storedTask({
      id: "TSK-opt-out",
      autoApproveReview: false,
      workflow: {
        instanceId: "wf-2",
        nodeId: "design",
        instanceTitle: "Delivery",
        nodeName: "Design",
        reviewRequired: true,
      },
    });
    const approval = storedTask({
      id: "TSK-approval",
      receiverId: "manager",
      workflow: {
        instanceId: "wf-3",
        nodeId: "approval",
        instanceTitle: "Delivery",
        nodeName: "Approval",
        approvalPolicy: "all",
        reviewRequired: false,
      },
    });
    await table.put(optOut.id, optOut as TaskRecord);
    await table.put(approval.id, approval as TaskRecord);

    expect(tasks.get(optOut.id).autoApproveReview).toBe(false);
    expect(tasks.get(approval.id).autoApproveReview).toBe(false);
  });

  it("syncs approvers only on approval tasks and skips unchanged writes", async () => {
    const table = memoryTable();
    const tasks = new TaskService({ tasks: table });
    const approval = storedTask({
      id: "TSK-sync-approval",
      receiverId: "manager",
      status: "review",
      workflow: {
        instanceId: "wf-4",
        nodeId: "approval",
        instanceTitle: "Delivery",
        nodeName: "Approval",
        approvalPolicy: "all",
        reviewRequired: false,
      },
    });
    const delivery = storedTask({
      id: "TSK-sync-delivery",
      workflow: {
        instanceId: "wf-5",
        nodeId: "delivery",
        instanceTitle: "Delivery",
        nodeName: "Delivery",
        reviewRequired: true,
      },
    });
    await table.put(approval.id, approval);
    await table.put(delivery.id, delivery);
    const system = { id: "workflow", name: "工作流", kind: "system" } as const;

    const synced = await tasks.projectApprovalApprovers(system, {
      taskId: approval.id,
      approverIds: ["admin", "manager", "admin", ""],
    });
    expect(synced.workflow?.approverIds).toEqual(["admin", "manager"]);
    expect(synced.events.at(-1)?.message).toBe("工作流同步审批人");

    const unchanged = await tasks.projectApprovalApprovers(system, {
      taskId: approval.id,
      approverIds: ["admin", "manager"],
    });
    expect(unchanged.id).toBe(approval.id);
    expect(unchanged.events).toStrictEqual(synced.events);

    await expect(
      tasks.projectApprovalApprovers(system, {
        taskId: delivery.id,
        approverIds: ["admin"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("project role removal", () => {
  it("marks active role tasks as needing reassignment", async () => {
    const table = memoryTable();
    const tasks = new TaskService({ tasks: table });
    const open = storedTask({
      id: "TSK-role-open",
      status: "progress",
      receiverType: "role",
      receiverId: "role-reviewer",
      receiverName: "评审组",
    });
    const done = storedTask({
      id: "TSK-role-done",
      status: "done",
      receiverType: "role",
      receiverId: "role-reviewer",
      receiverName: "评审组",
    });
    await table.put(open.id, open);
    await table.put(done.id, done);

    const marked = await tasks.markRoleUnavailable(
      "workspace-1",
      new Map([["role-reviewer", "评审组"]]),
    );
    expect(marked).toBe(1);
    const updated = tasks.get(open.id);
    expect(updated).toMatchObject({
      receiverType: "unassigned",
      receiverState: "needs_reassignment",
      reassignmentReason: "项目角色「评审组」已下线",
      previousReceiver: {
        type: "role",
        id: "role-reviewer",
        name: "评审组",
      },
    });
    expect(updated.receiverId).toBeUndefined();
    expect(updated.receiverName).toBeUndefined();
    expect(updated.events.at(-1)?.message).toContain("需改派");
    // 已完成任务保留历史角色快照。
    expect(tasks.get(done.id).receiverState).toBe("active");
    expect(tasks.get(done.id).receiverId).toBe("role-reviewer");

    // 重新指派会清除“需改派”标记。
    const assigned = await tasks.assign(actor, {
      taskId: open.id,
      receiverType: "human",
      receiverId: "flow-member",
      receiverName: "Flow Member",
    });
    expect(assigned.receiverState).toBe("active");
    expect(assigned.reassignmentReason).toBeUndefined();
    expect(assigned.receiverType).toBe("human");
    expect(assigned.receiverId).toBe("flow-member");
  });
});
