import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  createWorkflowRoutes,
  extractAgentDeliverableText,
  inject,
  parseDefinitionFixture,
  workflowDomainSpec,
  WorkflowService,
  type TeamServiceLike,
  type WebRouteLike,
  type WorkflowActor,
  type WorkflowDefinition,
  type WorkflowDomainLike,
  type WorkflowEvent,
  type WorkflowInstance,
  type WorkflowTaskBridge,
  type WorkflowTaskRef,
  type WorkflowSubmission,
  workflowTaskBridgeFrom,
} from "./index.js";
import type {
  AgentRunView,
  AgentServiceLike,
  EmployeeServiceLike,
} from "./index.js";

class FakeTable<V> {
  readonly records = new Map<string, V>();
  get(key: string): V | undefined {
    return this.records.get(key);
  }
  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }
  keys(): IterableIterator<string> {
    return this.records.keys();
  }
  get size(): number {
    return this.records.size;
  }
  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

function tables() {
  return {
    definitions: new FakeTable<WorkflowDefinition>(),
    instances: new FakeTable<WorkflowInstance>(),
    events: new FakeTable<WorkflowEvent>(),
    submissions: new FakeTable<WorkflowSubmission>(),
  };
}

function fakeDomain(current: ReturnType<typeof tables>): WorkflowDomainLike {
  return {
    table: ((name: "definitions" | "instances" | "events") =>
      current[name]) as unknown as WorkflowDomainLike["table"],
    close: async () => undefined,
  };
}

class FakeResponse {
  status = 0;
  body = "";
  writeHead(status: number): ServerResponse {
    this.status = status;
    return this as unknown as ServerResponse;
  }
  end(body?: string): ServerResponse {
    if (body !== undefined) this.body = body;
    return this as unknown as ServerResponse;
  }
  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function fakeRequest(
  method: string,
  url: string,
  options: { body?: unknown; token?: string; origin?: string } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33117",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body);
    },
  };
}

async function call(route: WebRouteLike, request: unknown) {
  const response = new FakeResponse();
  await route.handler(
    request as Parameters<typeof route.handler>[0],
    response as unknown as ServerResponse,
  );
  return response;
}

const timestamp = "2026-01-01T00:00:00.000Z";
const owner: WorkflowActor = {
  kind: "user",
  id: "flow-owner",
  name: "Owner",
  workspaceRole: "owner",
};
const member: WorkflowActor = {
  kind: "user",
  id: "workflow-member",
  name: "Member",
  workspaceRole: "member",
};
function team(): TeamServiceLike {
  return {
    resolveToken: (token) =>
      token === "owner"
        ? { userId: "flow-owner", role: "member" }
        : token === "member"
          ? { userId: "workflow-member", role: "member" }
          : undefined,
    members: (workspaceId) =>
      workspaceId === "main"
        ? [
            { userId: "workflow-admin", name: "Admin", memberRole: "member" },
            { userId: "flow-owner", name: "Owner", memberRole: "owner" },
            { userId: "workflow-member", name: "Member", memberRole: "member" },
            {
              userId: "flow-member",
              name: "Flow Member",
              memberRole: "member",
            },
          ]
        : [],
    users: () => [
      { id: "workflow-admin", name: "Admin" },
      { id: "flow-owner", name: "Owner" },
      { id: "workflow-member", name: "Member" },
      { id: "flow-member", name: "Flow Member" },
    ],
  };
}

async function importedFixture(
  service: WorkflowService,
  name: string,
  actor = owner,
) {
  const sourceMd = await readFile(
    new URL(`../../../docs/fixtures/workflow/${name}`, import.meta.url),
    "utf8",
  );
  return service.importDefinition(actor, { workspaceId: "main", sourceMd });
}

function humanReviewFixture(key: string) {
  return [
    "# 工作流：人类执行验收",
    "",
    "## 元信息",
    "",
    `- key: ${key}`,
    "- version: 1",
    "",
    "## 节点",
    "",
    "### 需求确认",
    "",
    "- id: requirement-confirmation",
    "- type: approval",
    "- executor: user:flow-owner",
    "- approver: 用户:flow-owner",
    "- policy: any",
    "",
    "### 方案设计",
    "",
    "- id: product-design",
    "- type: task",
    "- executor: user:workflow-member",
    "- responsible: user:workflow-member",
    "- deliverable: product-design",
    "  title: 产品方案",
    "  type: text",
    "  required: true",
    "  min-text-length: 20",
    "",
    "## 连接",
    "",
    "- requirement-confirmation -> product-design",
  ].join("\n");
}

type FakeWorkflowRef = {
  instanceId: string;
  nodeId: string;
  nodeAttempt?: number | undefined;
  reviewRequired?: boolean | undefined;
  approvalPolicy?: "all" | "any";
  approverIds?: Array<string> | undefined;
};

type FakeWorkflowTask = Omit<WorkflowTaskRef, "status"> & {
  status: WorkflowTaskRef["status"];
  workflow?: FakeWorkflowRef | undefined;
  description?: string | undefined;
  autoSubmitReview?: boolean | undefined;
  autoApproveReview?: boolean | undefined;
};

class FakeTaskBridge implements WorkflowTaskBridge {
  private nextId = 0;
  readonly records = new Map<string, FakeWorkflowTask>();
  readonly outcomes = new Map<
    string,
    "approved" | "rejected" | "cancelled" | "superseded"
  >();
  readonly projectedStatuses = new Map<
    string,
    "todo" | "progress" | "review"
  >();
  readonly projectedRuns = new Map<string, string>();
  readonly projectedEvents = new Map<
    string,
    Array<{ id: string; kind: string; message: string }>
  >();

  get(taskId: string) {
    return this.records.get(taskId);
  }

  async create(
    _actor: Parameters<WorkflowTaskBridge["create"]>[0],
    input: Record<string, unknown>,
  ) {
    const id = `workflow-task-${String(++this.nextId)}`;
    const task: FakeWorkflowTask = {
      id,
      receiverType: input.receiverType as WorkflowTaskRef["receiverType"],
      receiverId: input.receiverId as string | undefined,
      receiverName: input.receiverName as string | undefined,
      status: input.status as WorkflowTaskRef["status"],
      workflow: input.workflow as FakeWorkflowTask["workflow"],
      nodeAttempt: input.nodeAttempt as number | undefined,
      reviewRequired: input.reviewRequired as boolean | undefined,
      description: input.description as string,
      autoSubmitReview: input.autoSubmitReview as boolean,
      autoApproveReview: input.autoApproveReview as boolean,
    };
    this.records.set(id, task);
    return task;
  }

  async projectAssigned(
    _actor: Parameters<WorkflowTaskBridge["projectAssigned"]>[0],
    input: Record<string, unknown>,
  ) {
    const task = this.records.get(String(input.taskId));
    if (task === undefined) throw new Error("task not found");
    Object.assign(task, {
      receiverType: input.receiverType,
      receiverId: input.receiverId,
      receiverName: input.receiverName,
    });
    return task;
  }

  async projectReceiverDisplay(
    _actor: Parameters<
      NonNullable<WorkflowTaskBridge["projectReceiverDisplay"]>
    >[0],
    input: Record<string, unknown>,
  ) {
    const task = this.records.get(String(input.taskId));
    if (task === undefined) throw new Error("task not found");
    Object.assign(task, {
      receiverType: input.receiverType,
      receiverId: input.receiverId,
      receiverName: input.receiverName,
    });
    return task;
  }

  async projectApprovalApprovers(
    _actor: Parameters<
      NonNullable<WorkflowTaskBridge["projectApprovalApprovers"]>
    >[0],
    input: { taskId: string; approverIds: readonly string[] },
  ) {
    const task = this.records.get(input.taskId);
    if (task === undefined) throw new Error("task not found");
    task.workflow = {
      instanceId: task.workflow?.instanceId ?? "",
      nodeId: task.workflow?.nodeId ?? "",
      ...task.workflow,
      approverIds: [...input.approverIds],
    };
    return task;
  }

  async settle(
    _actor: Parameters<WorkflowTaskBridge["settle"]>[0],
    taskId: string,
    outcome: "approved" | "rejected" | "cancelled" | "superseded",
  ) {
    const task = this.records.get(taskId);
    if (task === undefined) throw new Error("task not found");
    task.status = outcome === "cancelled" ? "cancelled" : "done";
    this.outcomes.set(taskId, outcome);
    return task;
  }

  async projectStatus(
    _actor: Parameters<WorkflowTaskBridge["create"]>[0],
    taskId: string,
    status: "todo" | "progress" | "review",
  ) {
    const task = this.records.get(taskId);
    if (task === undefined) throw new Error("task not found");
    task.status = status;
    this.projectedStatuses.set(taskId, status);
    return task;
  }

  async projectAgentRun(
    _actor: Parameters<WorkflowTaskBridge["create"]>[0],
    taskId: string,
    run: { id: string },
  ) {
    const task = this.records.get(taskId);
    if (task === undefined) throw new Error("task not found");
    this.projectedRuns.set(taskId, run.id);
    return task;
  }

  async projectEvent(
    _actor: Parameters<NonNullable<WorkflowTaskBridge["projectEvent"]>>[0],
    taskId: string,
    event: Parameters<NonNullable<WorkflowTaskBridge["projectEvent"]>>[2],
  ) {
    const task = this.records.get(taskId);
    if (task === undefined) throw new Error("task not found");
    const events = this.projectedEvents.get(taskId) ?? [];
    events.push({
      id: event.id,
      kind: event.actorKind,
      message: event.message,
    });
    this.projectedEvents.set(taskId, events);
    return task;
  }
}

class FakeAgentService implements AgentServiceLike {
  readonly dispatchInputs: Array<Parameters<AgentServiceLike["dispatch"]>[0]> =
    [];
  private readonly records = new Map<string, AgentRunView>();

  constructor(private readonly hasProfile = true) {}

  profile(workspaceId: string, profileId: string) {
    if (!this.hasProfile || workspaceId !== "main") return undefined;
    return {
      id: profileId,
      name: "Backend Agent",
      runtimeKind: "task-worker",
      status: "active",
    };
  }

  runs(instanceId: string, nodeId?: string): AgentRunView[] {
    return [...this.records.values()]
      .filter(
        (run) =>
          run.instanceId === instanceId &&
          (nodeId === undefined || run.nodeId === nodeId),
      )
      .sort((left, right) => left.runSeq - right.runSeq);
  }

  run(runId: string): AgentRunView | undefined {
    return this.records.get(runId);
  }

  async dispatch(
    input: Parameters<AgentServiceLike["dispatch"]>[0],
  ): Promise<AgentRunView> {
    this.dispatchInputs.push(input);
    const run: AgentRunView = {
      id: `agent-run-${this.dispatchInputs.length}`,
      workspaceId: input.workspaceId,
      agentProfileId: input.profileId,
      instanceId: input.instanceId,
      nodeId: input.nodeId,
      dispatchKey: input.dispatchKey,
      trigger: input.trigger,
      status: "queued",
      attempt: input.attempt,
      runSeq: input.runSeq,
      maxAttempts: input.maxAttempts,
      timeoutMs: input.timeoutMs,
      ...(input.employeeId === undefined
        ? {}
        : { employeeId: input.employeeId }),
      ...(input.principalId === undefined
        ? {}
        : { principalId: input.principalId }),
      ...(input.principalType === undefined
        ? {}
        : { principalType: input.principalType }),
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      payload: input.payload,
      createdBy: input.createdBy,
      createdAt: timestamp,
    };
    this.records.set(run.id, run);
    return run;
  }

  async cancel(runId: string): Promise<AgentRunView> {
    const run = this.records.get(runId);
    if (run === undefined) throw new Error("run not found");
    if (!["queued", "running", "waiting_input"].includes(run.status)) {
      throw Object.assign(
        new Error(
          run.status === "succeeded"
            ? "Agent 运行已完成，无法取消"
            : "Agent 运行已结束，无法取消",
        ),
        { code: "conflict" },
      );
    }
    const cancelled = { ...run, status: "cancelled" } as const;
    this.records.set(runId, cancelled);
    return cancelled;
  }

  bindWorkflow(): void {}

  settle(runId: string, patch: Partial<AgentRunView>): void {
    const run = this.records.get(runId);
    if (run === undefined) throw new Error("run not found");
    this.records.set(runId, { ...run, ...patch } as AgentRunView);
  }
}

class FakeEmployeeService implements EmployeeServiceLike {
  readonly tickets: Array<{ id: string; input: unknown }> = [];
  readonly authorized: string[] = [];
  private ticketAttempts = 0;

  constructor(
    private readonly failTickets = false,
    private readonly failWriteAuthorization = false,
    private readonly workflowBlockReason?: string,
  ) {}

  employeeWorkspaceTarget() {
    return {
      employee: {
        id: "backend-01",
        displayName: "Backend Engineer 01",
        status: "active",
      },
      assignment: { role: "member" as const, permissions: ["read", "write"] },
    };
  }

  workflowTarget() {
    return {
      employee: {
        id: "backend-01",
        displayName: "Backend Engineer 01",
        status: "active",
      },
      assignment: { role: "member" as const, permissions: ["read", "write"] },
      profile: {
        id: "runtime-backend-01",
        name: "Backend runtime",
        legacyAgentProfileId: "backend-agent",
      },
    };
  }

  workflowDispatchBlockReason() {
    return this.workflowBlockReason;
  }

  employeeApprovalTarget() {
    return undefined;
  }

  async issueRuntimeTicket(
    actorAuthUserId: string,
    input: Parameters<EmployeeServiceLike["issueRuntimeTicket"]>[1],
  ) {
    this.ticketAttempts += 1;
    if (this.failTickets && this.ticketAttempts === 1) {
      throw new Error("active Human Employee is required");
    }
    const ticket = {
      id: `ticket-${this.tickets.length + 1}`,
      actorAuthUserId,
      input,
    };
    this.tickets.push(ticket);
    return ticket;
  }

  async authorizeTicket(
    input: Parameters<EmployeeServiceLike["authorizeTicket"]>[0],
  ) {
    if (this.failWriteAuthorization && input.ticketId === "ticket-1") {
      throw new Error("action is explicitly denied");
    }
    this.authorized.push(input.ticketId);
    return { employeeId: "backend-01" };
  }
}

const guest: WorkflowActor = {
  kind: "user",
  id: "workflow-guest",
  name: "Guest",
  workspaceRole: "guest",
};

describe("workflow task bridge adapter", () => {
  it("adapts the task service implementation names to the bridge contract", async () => {
    const calls: string[] = [];
    const record: WorkflowTaskRef = {
      id: "task-1",
      receiverType: "agent",
      receiverId: "agent-1",
      receiverName: "Agent",
      status: "done",
    };
    const bridge = workflowTaskBridgeFrom({
      get: () => record,
      create: async () => record,
      projectAssigned: async () => record,
      settleProjection: async (
        _actor: unknown,
        taskId: string,
        outcome: "approved" | "rejected" | "cancelled" | "superseded",
      ) => {
        calls.push(`${taskId}:${outcome}`);
        return { ...record, status: "cancelled" };
      },
      projectStatus: async () => record,
      projectWorkflowEvent: async () => record,
      projectAgentRun: async () => record,
      bindWorkflowActions: () => {},
    });
    expect(bridge).toBeDefined();
    const settled = await bridge!.settle(
      { id: "workflow", name: "工作流", kind: "system" },
      "task-1",
      "cancelled",
    );
    expect(settled.status).toBe("cancelled");
    expect(calls).toEqual(["task-1:cancelled"]);
  });

  it("rejects a task service that does not satisfy the required contract", () => {
    expect(
      workflowTaskBridgeFrom({
        get: () => undefined,
        create: async () => undefined,
        projectAssigned: async () => undefined,
      }),
    ).toBeUndefined();
  });
});

describe("workflow parser", () => {
  it("parses parallel branches, approvals, and controlled cycles", async () => {
    const result = parseDefinitionFixture(
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/product-delivery.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(" ")).toContain(
      "节点「开发」的 Agent 执行器需要手动派发",
    );
    expect(result.graph?.nodes).toHaveLength(5);
    expect(result.graph?.edges).toHaveLength(5);
    expect(result.graph?.startNodeIds).toEqual(["requirement-review"]);
    expect(
      result.graph?.nodes.find((node) => node.id === "release-approval")
        ?.approvers,
    ).toHaveLength(2);
    const enhanced = parseDefinitionFixture(
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/product-delivery-v2.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(enhanced.errors).toEqual([]);
    expect(
      enhanced.graph?.nodes.find((node) => node.id === "development")
        ?.deliverables,
    ).toHaveLength(2);
    expect(
      enhanced.graph?.nodes.find((node) => node.id === "development")
        ?.responsible,
    ).toMatchObject({ kind: "user", id: "workflow-member" });
    expect(
      enhanced.graph?.nodes.find((node) => node.id === "development"),
    ).toMatchObject({
      execution: "task-worker",
      trigger: "manual-dispatch",
      maxAttempts: 2,
      timeoutMs: 1_800_000,
      agentProfileId: "backend-agent",
    });
    expect(enhanced.warnings).toContain(
      "节点「开发」的 Agent 执行器需要手动派发；如需就绪后自动启动，请设置 execution: task-worker 和 trigger: auto-on-ready",
    );
  });

  it("rejects an uncontrolled cycle", async () => {
    const result = parseDefinitionFixture(
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/invalid-cycle.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(result.graph).toBeUndefined();
    expect(result.errors.join(" ")).toContain(
      "cycle requires a break condition",
    );
  });

  it("parses Agent execution and runtime limits", async () => {
    const result = parseDefinitionFixture(
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/agent-node.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(result.errors).toEqual([]);
    const node = result.graph?.nodes.find((item) => item.id === "development");
    expect(node).toMatchObject({
      executor: { kind: "agent", id: "backend-agent" },
      execution: "task-worker",
      trigger: "auto-on-ready",
      maxAttempts: 2,
      timeoutMs: 1_800_000,
      responsible: { kind: "user", id: "workflow-member" },
    });
    expect(node?.agentProfileId).toBeUndefined();
    expect(result.warnings.join(" ")).not.toContain(
      "节点「开发」的 Agent 执行器需要手动派发",
    );

    const timeoutResult = parseDefinitionFixture(
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/agent-node-timeout.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const timeoutNode = timeoutResult.graph?.nodes.find(
      (item) => item.id === "development",
    );
    expect(timeoutNode).toMatchObject({ timeoutMs: 1_000 });
  });
});

describe("workflow service", () => {
  let current: ReturnType<typeof tables>;
  let service: WorkflowService;

  beforeEach(() => {
    current = tables();
    service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
    });
  });

  it("declares services and storage tables", () => {
    expect(inject).toEqual(["storageDomain", "commands", "tools", "webServer"]);
    expect(workflowDomainSpec).toMatchObject({
      name: "collab_workflow",
      version: 1,
    });
    expect(Object.keys(workflowDomainSpec.tables)).toEqual([
      "definitions",
      "instances",
      "events",
      "submissions",
    ]);
  });

  it("normalizes principal references to compatibility actor aliases", () => {
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      principals: () => ({
        resolveReference: (reference) => {
          if (reference === "principal:principal-ai-backend") {
            return {
              id: "principal-ai-backend",
              kind: "ai",
              status: "active",
            };
          }
          if (reference === "principal:principal-human-owner") {
            return {
              id: "principal-human-owner",
              kind: "human",
              status: "active",
            };
          }
          return undefined;
        },
        resolveSubject: () => undefined,
        preferredSubjectId: (principalId) => {
          if (principalId === "principal-ai-backend") return "backend-01";
          if (principalId === "principal-human-owner") return "workflow-member";
          return undefined;
        },
      }),
    });
    const sourceMd = [
      "# 工作流：Principal 执行",
      "",
      "## 元信息",
      "",
      "- key: principal-execution",
      "- version: 1",
      "",
      "## 节点",
      "",
      "### 执行",
      "",
      "- id: develop",
      "- type: task",
      "- executor: principal:principal-ai-backend",
      "- responsible: principal:principal-human-owner",
      "- review: false",
      "",
      "## 连接",
    ].join("\n");

    const checked = service.validate(sourceMd);
    expect(checked.issues.filter((issue) => issue.level === "error")).toEqual(
      [],
    );
    expect(checked.graph?.nodes[0]).toMatchObject({
      executor: { kind: "employee", id: "backend-01" },
      responsible: { kind: "user", id: "workflow-member" },
    });
  });

  it("reports the agent review missing responsible error", async () => {
    const sourceMd = [
      "# 工作流：Agent 缺少责任人",
      "",
      "## 元信息",
      "",
      "- key: agent-missing-responsible",
      "- version: 1",
      "",
      "## 节点",
      "",
      "### 开发",
      "",
      "- id: development",
      "- type: task",
      "- executor: agent:backend-agent",
      "",
      "### 发布",
      "",
      "- id: release",
      "- type: service",
      "- executor: system:deployment",
      "",
      "## 连接",
      "",
      "- development -> release",
    ].join("\n");
    const result = service.validate(sourceMd, "main");
    const error =
      "节点「development」的执行者是 Agent 且需要人工 Review（review: true），必须指定 responsible: user:<用户ID> 作为交付责任人";
    expect(
      result.issues.filter((issue) => issue.message === error),
    ).toHaveLength(1);
  });

  it("reports duplicate key and version during validation", async () => {
    const first = await importedFixture(service, "product-delivery.md");
    const result = service.validate(first.sourceMd);
    expect(result.issues).toContainEqual({
      level: "error",
      message: `模板版本已存在：${first.key} v${first.version}。请把元信息里的 version 改成未占用的 v2，或更换流程 key。`,
    });

    const nextVersion = first.sourceMd.replace("version: 1", "version: 2");
    await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: nextVersion,
    });
    expect(
      service
        .validate(nextVersion)
        .issues.some((issue) =>
          issue.message.includes(
            `模板版本已存在：${first.key} v2。请把元信息里的 version 改成未占用的 v3`,
          ),
        ),
    ).toBe(true);
    expect(
      service
        .validate(first.sourceMd.replace("version: 1", "version: 3"))
        .issues.some((issue) => issue.message.includes("模板版本已存在")),
    ).toBe(false);
  });

  it("imports, archives previous versions, and starts an instance", async () => {
    const first = await importedFixture(service, "product-delivery.md");
    const changed = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/product-delivery.md",
          import.meta.url,
        ),
        "utf8",
      )
    ).replace("version: 1", "version: 2");
    const second = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: changed,
    });
    expect(
      service.definitions("main").find((item) => item.id === first.id)?.status,
    ).toBe("archived");
    expect(second.status).toBe("active");
    const disabled = await service.setDefinitionStatus(owner, {
      workspaceId: "main",
      definitionId: second.id,
      status: "disabled",
    });
    expect(disabled.status).toBe("disabled");
    const reactivated = await service.setDefinitionStatus(owner, {
      workspaceId: "main",
      definitionId: second.id,
      status: "active",
    });
    expect(reactivated.status).toBe("active");
    const agentDefinition = await importedFixture(service, "agent-node.md");
    await current.definitions.put(first.id, {
      ...first,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await current.definitions.put(second.id, {
      ...second,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    await current.definitions.put(agentDefinition.id, {
      ...agentDefinition,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(service.definitions("main").map((item) => item.id)).toEqual([
      second.id,
      first.id,
      agentDefinition.id,
    ]);
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: second.id,
      title: "订单导出",
      sessionId: "session-a",
    });
    expect(instance.status).toBe("running");
    expect(instance.nodes["requirement-review"]?.status).toBe("ready");
    expect(instance.relatedSessionIds).toEqual(["session-a"]);
    await expect(
      service.completeNode(member, {
        instanceId: instance.id,
        nodeId: "release",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "node is waiting for upstream nodes",
    });
    await current.instances.put(instance.id, {
      ...instance,
      nodes: {
        ...instance.nodes,
        release: {
          ...instance.nodes.release!,
          status: "completed",
          completedAt: timestamp,
        },
      },
    });
    expect(service.instanceView(instance.id)?.status).toBe("blocked");
    expect(service.instances("main")[0]?.status).toBe("blocked");
  });

  it("starts a shared template from a different project", async () => {
    const sharedTeam: TeamServiceLike = {
      resolveToken: team().resolveToken,
      members: (workspaceId) =>
        workspaceId === "project-b"
          ? [
              { userId: "admin", name: "Admin", memberRole: "member" },
              {
                userId: "flow-member",
                name: "Flow Member",
                memberRole: "member",
              },
            ]
          : [],
      users: () => [
        { id: "admin", name: "Admin" },
        { id: "flow-member", name: "Flow Member" },
      ],
    };
    const sharedService = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team: () => sharedTeam,
    });
    const sourceMd = await readFile(
      new URL(
        "../../../docs/fixtures/workflow/gui-from-zero.md",
        import.meta.url,
      ),
      "utf8",
    );
    const definition = await sharedService.importDefinition(owner, {
      workspaceId: "template-home",
      sourceMd,
    });
    expect(definition.workspaceId).toBe("template-home");

    const instance = await sharedService.startInstance(member, {
      workspaceId: "project-b",
      definitionId: definition.id,
      title: "跨项目启动共享模版",
    });
    expect(instance.workspaceId).toBe("project-b");
    expect(instance.definitionKey).toBe(definition.key);
    expect(instance.nodes["requirement-confirmation"]?.status).toBe("ready");
  });

  it("runs parallel nodes through a join and approval", async () => {
    const definition = await importedFixture(service, "product-delivery-v2.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "订单导出",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    const progressed = service.instance(instance.id)!;
    expect(progressed.status).toBe("running");
    expect(progressed.nodes.development?.status).toBe("ready");
    expect(progressed.nodes["test-preparation"]?.status).toBe("ready");
    expect(progressed.nodes["release-approval"]?.status).toBe("waiting");
    await expect(
      service.completeNode(member, {
        instanceId: instance.id,
        nodeId: "development",
      }),
    ).rejects.toMatchObject({ code: "missing_deliverables" });
    const submission = await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value:
        "完成订单导出接口与数据结构，覆盖权限、并发导出和空结果场景，记录已知风险。",
    });
    expect(submission.onBehalfOf).toBe("backend-agent");
    await service.completeNode(member, {
      instanceId: instance.id,
      nodeId: "development",
    });
    expect(
      service.instance(instance.id)!.nodes["release-approval"]?.status,
    ).toBe("waiting");
    await service.completeNode(member, {
      instanceId: instance.id,
      nodeId: "test-preparation",
    });
    const ready = service.instance(instance.id)!;
    expect(ready.nodes["release-approval"]?.status).toBe("ready");
    expect(ready.nodes.release?.status).toBe("waiting");
  });

  it("allows the second approver to act after the node enters partial-approval waiting", async () => {
    const definition = await importedFixture(service, "product-delivery-v2.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "多审批人部分等待",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "完成订单导出接口与数据结构，覆盖权限、并发导出和空结果场景。",
    });
    await service.completeNode(member, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await service.completeNode(member, {
      instanceId: instance.id,
      nodeId: "test-preparation",
    });
    const ready = service.instance(instance.id)!;
    expect(ready.nodes["release-approval"]?.status).toBe("ready");
    expect(ready.nodes["release-approval"]?.enteredAt).toBeDefined();

    await service.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "release-approval",
      decision: "approved",
      note: "owner 通过",
    });
    const partial = service.instance(instance.id)!;
    expect(partial.nodes["release-approval"]?.status).toBe("waiting");
    expect(partial.nodes["release-approval"]?.enteredAt).toBeDefined();

    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "release-approval",
      decision: "approved",
      note: "member 通过",
    });
    const completed = service.instance(instance.id)!;
    expect(completed.nodes["release-approval"]?.status).toBe("completed");
    expect(completed.nodes.release?.status).toBe("ready");
  });

  it("auto-completes a human node after all deliverables are submitted when approval is enabled", async () => {
    const tablesData = tables();
    const tasks = new FakeTaskBridge();
    const autoService = new WorkflowService(tablesData, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
    });
    const definition = await autoService.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: humanReviewFixture("gui-human-auto-approve-on"),
    });
    const instance = await autoService.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "人类任务自动验收",
    });
    await autoService.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-confirmation",
      decision: "approved",
    });
    const taskId = autoService
      .instance(instance.id)!
      .nodes["product-design"]!.taskIds.at(-1)!;
    expect(tasks.records.get(taskId)?.autoApproveReview).toBe(true);
    expect(tasks.records.get(taskId)?.description).toContain(
      "提交后自动通过 Review，完成节点",
    );

    await autoService.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "product-design",
      requirementKey: "product-design",
      type: "text",
      value: "完成产品方案，补充边界条件、依赖影响、验证结果和已知风险。",
    });
    for (
      let settled = false, attempts = 0;
      !settled && attempts < 20;
      attempts += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled =
        autoService.instance(instance.id)!.nodes["product-design"]?.status ===
        "completed";
    }

    expect(
      autoService.instance(instance.id)!.nodes["product-design"]?.status,
    ).toBe("completed");
    expect(tasks.records.get(taskId)?.status).toBe("done");
    expect(tasks.outcomes.get(taskId)).toBe("approved");
  });

  it("keeps a human node open when automatic approval is disabled", async () => {
    const tablesData = tables();
    const tasks = new FakeTaskBridge();
    const manualService = new WorkflowService(tablesData, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
    });
    const definition = await manualService.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: humanReviewFixture("gui-human-auto-approve-off"),
    });
    const instance = await manualService.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "人类任务人工验收",
    });
    await manualService.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-confirmation",
      decision: "approved",
    });
    const taskId = manualService
      .instance(instance.id)!
      .nodes["product-design"]!.taskIds.at(-1)!;
    expect(tasks.records.get(taskId)?.description).toContain(
      "提交后自动通过 Review，完成节点",
    );
    tasks.records.get(taskId)!.autoApproveReview = false;

    await manualService.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "product-design",
      requirementKey: "product-design",
      type: "text",
      value: "完成产品方案，补充边界条件、依赖影响、验证结果和已知风险。",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      manualService.instance(instance.id)!.nodes["product-design"]?.status,
    ).toBe("ready");
    expect(tasks.records.get(taskId)?.status).toBe("progress");
  });

  it("rejects decisions on a future approval node that is still waiting", async () => {
    const definition = await importedFixture(service, "product-delivery-v2.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "未来审批防护",
    });
    expect(instance.nodes["release-approval"]?.status).toBe("waiting");
    for (const actor of [owner, member]) {
      await expect(
        service.decideApproval(actor, {
          instanceId: instance.id,
          nodeId: "release-approval",
          decision: "approved",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("waiting for upstream"),
      });
      await expect(
        service.decideApproval(actor, {
          instanceId: instance.id,
          nodeId: "release-approval",
          decision: "rejected",
          note: "不该被记录",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("waiting for upstream"),
      });
    }
    const unchanged = service.instance(instance.id)!;
    expect(unchanged.nodes["release-approval"]?.status).toBe("waiting");
    expect(
      Object.values(unchanged.nodes["release-approval"]!.approvals).every(
        (item) => item.status === "pending",
      ),
    ).toBe(true);
    expect(
      service
        .events(instance.id)
        .some(
          (event) =>
            event.nodeId === "release-approval" &&
            event.kind.startsWith("approval."),
        ),
    ).toBe(false);
  });

  it("rejects a deliverable and requires a new submission", async () => {
    const definition = await importedFixture(service, "product-delivery-v2.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "交付物退回",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    const submission = await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "初版说明已补充接口与测试范围，但还缺少风险、覆盖范围和结论。",
    });
    const rejected = await service.rejectSubmission(owner, {
      submissionId: submission.id,
      note: "缺少回归范围",
    });
    expect(rejected.status).toBe("rejected");
    await expect(
      service.completeNode(member, {
        instanceId: instance.id,
        nodeId: "development",
      }),
    ).rejects.toMatchObject({ code: "missing_deliverables" });
    await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value:
        "完成订单导出接口与数据结构，覆盖权限、并发导出和空结果场景，记录已知风险。",
    });
    expect(
      service.instance(instance.id)?.nodes.development?.deliverables[
        "implementation-report"
      ]?.status,
    ).toBe("submitted");
    await expect(
      service.completeNode(member, {
        instanceId: instance.id,
        nodeId: "development",
      }),
    ).resolves.toBeDefined();
  });

  it("supports delegation and countersign", async () => {
    const tasks = new FakeTaskBridge();
    const taskLinkedService = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
    });
    const definition = await importedFixture(
      taskLinkedService,
      "product-delivery.md",
    );
    const instance = await taskLinkedService.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "审批链",
    });
    await expect(
      taskLinkedService.countersignApproval(member, {
        instanceId: instance.id,
        nodeId: "requirement-review",
        toId: "missing-user",
        toName: "Missing User",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      taskLinkedService.countersignApproval(member, {
        instanceId: instance.id,
        nodeId: "requirement-review",
        toId: "workflow-member",
        toName: "Member",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const delegated = await taskLinkedService.delegateApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      toId: "flow-owner",
      toName: "Owner",
    });
    expect(delegated.nodes["requirement-review"]?.approvals).toMatchObject({
      "requirement-review:flow-owner": { status: "pending" },
    });
    const delegatedTaskId = delegated.nodes["requirement-review"]!.taskIds[0]!;
    expect(tasks.records.get(delegatedTaskId)).toMatchObject({
      receiverType: "human",
      receiverId: "flow-owner",
      receiverName: "Owner",
    });
    const staleProjection = tasks.records.get(delegatedTaskId)!;
    Object.assign(staleProjection, {
      receiverType: "human",
      receiverId: "workflow-member",
      receiverName: "Member",
    });
    await taskLinkedService.handleTaskReconcile(staleProjection);
    expect(tasks.records.get(delegatedTaskId)).toMatchObject({
      receiverType: "human",
      receiverId: "flow-owner",
      receiverName: "Owner",
    });
    const countersigned = await taskLinkedService.countersignApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      toId: "workflow-admin",
      toName: "Admin",
    });
    expect(
      Object.values(countersigned.nodes["requirement-review"]!.approvals),
    ).toHaveLength(3);
    await expect(
      taskLinkedService.countersignApproval(member, {
        instanceId: instance.id,
        nodeId: "requirement-review",
        toId: "auditor-2",
        toName: "Auditor 2",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("processes countersigned approvals serially before the initiator", async () => {
    const countersignService = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
    });
    const definition = await importedFixture(
      countersignService,
      "product-delivery.md",
    );
    const instance = await countersignService.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "串行加签",
    });
    const countersigned = await countersignService.countersignApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      toId: "flow-owner",
      toName: "Owner",
    });
    expect(
      Object.keys(countersigned.nodes["requirement-review"]!.approvals),
    ).toEqual([
      "requirement-review:flow-owner",
      "requirement-review:workflow-member",
    ]);
    expect(
      countersigned.nodes["requirement-review"]!.approvals[
        "requirement-review:flow-owner"
      ],
    ).toMatchObject({ status: "pending", source: "countersign" });

    await expect(
      countersignService.decideApproval(member, {
        instanceId: instance.id,
        nodeId: "requirement-review",
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const ownerApproved = await countersignService.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    expect(ownerApproved.nodes["requirement-review"]?.status).toBe("waiting");

    const memberApproved = await countersignService.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
      note: "原审批人确认",
    });
    expect(memberApproved.nodes["requirement-review"]?.status).toBe(
      "completed",
    );
    expect(memberApproved.status).toBe("running");
  });

  it("lets a delegated approver be countersigned back into the serial queue", async () => {
    const countersignService = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
    });
    const definition = await importedFixture(
      countersignService,
      "product-delivery.md",
    );
    const instance = await countersignService.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "转交后重新加签",
    });
    await countersignService.delegateApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      toId: "flow-owner",
      toName: "Owner",
    });
    const countersigned = await countersignService.countersignApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      toId: "workflow-member",
      toName: "Member",
    });
    expect(
      Object.keys(countersigned.nodes["requirement-review"]!.approvals),
    ).toEqual([
      "requirement-review:workflow-member",
      "requirement-review:flow-owner",
    ]);
    expect(
      countersigned.nodes["requirement-review"]!.approvals[
        "requirement-review:workflow-member"
      ],
    ).toMatchObject({ status: "pending", source: "countersign" });
    expect(
      countersigned.nodes["requirement-review"]!.approvals[
        "requirement-review:flow-owner"
      ],
    ).toMatchObject({ status: "pending" });

    await expect(
      countersignService.decideApproval(owner, {
        instanceId: instance.id,
        nodeId: "requirement-review",
        decision: "approved",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const memberApproved = await countersignService.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    expect(memberApproved.nodes["requirement-review"]?.status).toBe("waiting");
    const ownerApproved = await countersignService.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    expect(ownerApproved.nodes["requirement-review"]?.status).toBe("completed");
  });

  it("creates approval tasks and syncs reassignment and decisions", async () => {
    const tasks = new FakeTaskBridge();
    const taskService = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
    });
    const definition = await importedFixture(
      taskService,
      "product-delivery-v2.md",
    );
    const instance = await taskService.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "审批 Task 联动",
    });
    const requirementTaskId = instance.nodes["requirement-review"]!.taskIds[0]!;
    const requirementTask = tasks.records.get(requirementTaskId)!;
    expect(requirementTask).toMatchObject({
      receiverType: "human",
      receiverId: "workflow-member",
      status: "review",
      autoSubmitReview: false,
    });
    expect(requirementTask.workflow?.approverIds).toEqual(["workflow-member"]);
    expect(requirementTask.description).toContain("或签：任一审批人通过即可");

    delete requirementTask.workflow?.approverIds;
    await taskService.reconcileTaskProjections(instance.id);
    expect(tasks.records.get(requirementTaskId)?.workflow?.approverIds).toEqual(
      ["workflow-member"],
    );

    await taskService.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "requirement-review",
      decision: "approved",
    });
    expect(tasks.records.get(requirementTaskId)?.status).toBe("done");
    expect(
      tasks.projectedEvents
        .get(requirementTaskId)
        ?.some(
          (event) =>
            event.kind === "user" && event.message.includes("通过审批"),
        ),
    ).toBe(true);

    delete tasks.records.get(requirementTaskId)?.workflow?.approverIds;
    await taskService.reconcileTaskProjections(instance.id);
    expect(tasks.records.get(requirementTaskId)?.workflow?.approverIds).toEqual(
      ["workflow-member"],
    );

    await taskService.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "完成订单导出接口与数据结构，覆盖权限、并发导出和空结果场景。",
    });
    await taskService.completeNode(member, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await taskService.completeNode(member, {
      instanceId: instance.id,
      nodeId: "test-preparation",
    });
    const releaseState = taskService.instance(instance.id)!.nodes[
      "release-approval"
    ]!;
    const releaseTaskId = releaseState.taskIds[0]!;
    const releaseTask = tasks.records.get(releaseTaskId)!;
    expect(releaseTask).toMatchObject({
      receiverType: "human",
      receiverId: "flow-owner",
      status: "review",
      autoSubmitReview: false,
    });
    expect(releaseTask.workflow?.approvalPolicy).toBe("all");
    expect(releaseTask.workflow?.approverIds).toEqual([
      "flow-owner",
      "workflow-member",
    ]);
    expect(releaseTask.description).toContain("并签：全部审批人通过后才完成");

    await taskService.handleTaskAssigned(
      {
        id: releaseTaskId,
        workspaceId: "main",
        receiverType: "human",
        receiverId: "workflow-admin",
        receiverName: "Admin",
        workflow: { instanceId: instance.id, nodeId: "release-approval" },
      },
      owner,
    );
    const reassigned = taskService.instance(instance.id)!.nodes[
      "release-approval"
    ]!;
    expect(reassigned.approvals["release-approval:flow-owner"]).toMatchObject({
      status: "pending",
      approver: { kind: "user", id: "workflow-admin", name: "Admin" },
    });
    expect(tasks.projectedEvents.get(releaseTaskId)?.at(-1)?.message).toContain(
      "改派审批 Task",
    );

    await taskService.decideApproval(
      {
        kind: "user",
        id: "workflow-admin",
        name: "Admin",
        workspaceRole: "owner",
      },
      {
        instanceId: instance.id,
        nodeId: "release-approval",
        decision: "approved",
      },
    );
    await taskService.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "release-approval",
      decision: "approved",
    });
    expect(tasks.records.get(releaseTaskId)?.status).toBe("done");
  });

  it("allows shared templates to reference accounts outside the source project", async () => {
    const sourceMd = await readFile(
      new URL(
        "../../../docs/fixtures/workflow/product-delivery.md",
        import.meta.url,
      ),
      "utf8",
    );
    const definition = await service.importDefinition(owner, {
      workspaceId: "template-home",
      sourceMd,
    });
    expect(definition.workspaceId).toBe("template-home");

    await expect(
      service.startInstance(member, {
        workspaceId: "project-without-members",
        definitionId: definition.id,
        title: "项目成员校验",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("不是当前工作区成员"),
    });
    expect(service.instances("project-without-members")).toHaveLength(0);
  });

  it("blocks a controlled loop when break becomes true", async () => {
    const definition = await importedFixture(service, "controlled-loop.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "返工流程",
      context: { attempts: 3 },
    });
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "confirm",
    });
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "testing",
      decision: "rejected",
    });
    const blocked = service.instance(instance.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.nodes.development?.status).toBe("blocked");
    expect(blocked.nodes.development?.note).toContain("已触发 break");
  });

  it("keeps the workflow authoritative when task projection is unavailable", async () => {
    const tasks = new FakeTaskBridge();
    const failingCreate = Object.create(tasks) as FakeTaskBridge;
    failingCreate.create = async () => {
      throw new Error("task service down");
    };
    const serviceWithCreateFailure = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => failingCreate,
    });
    const definition = await importedFixture(
      serviceWithCreateFailure,
      "controlled-loop.md",
    );
    const started = await serviceWithCreateFailure.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Task 投影失败不阻塞",
    });
    expect(started.nodes.confirm?.status).toBe("ready");
    expect(started.status).toBe("running");

    const validTasks = new FakeTaskBridge();
    const serviceWithTasks = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => validTasks,
    });
    const syncedInstance = await serviceWithTasks.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Task 结算失败不阻塞",
    });
    expect(validTasks.records.size).toBeGreaterThan(0);
    const readyTask = [...validTasks.records.values()].find(
      (task) =>
        task.workflow?.instanceId === syncedInstance.id &&
        task.workflow.nodeId === "confirm",
    )!;
    readyTask.status = "todo";
    await serviceWithTasks.handleTaskReconcile(readyTask);
    expect(validTasks.records.get(readyTask.id)?.status).toBe("progress");
    const failingSettle = Object.create(validTasks) as FakeTaskBridge;
    failingSettle.settle = async () => {
      throw new Error("task service down");
    };
    const serviceWithSettleFailure = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => failingSettle,
    });
    await serviceWithSettleFailure.completeNode(owner, {
      instanceId: syncedInstance.id,
      nodeId: "confirm",
    });
    const completed = serviceWithSettleFailure.instance(syncedInstance.id)!;
    expect(completed.nodes.confirm?.status).toBe("completed");
    expect(completed.nodes.development?.status).toBe("ready");
    expect(completed.status).toBe("running");

    const staleTask = [...validTasks.records.values()].find(
      (task) =>
        task.workflow?.instanceId === syncedInstance.id &&
        task.workflow.nodeId === "confirm",
    )!;
    expect(staleTask.status).toBe("progress");
    await serviceWithTasks.handleTaskReconcile(staleTask);
    expect(validTasks.records.get(staleTask.id)?.status).toBe("done");
    expect(validTasks.outcomes.get(staleTask.id)).toBe("approved");
  });

  it("runs the human and approval lifecycle without an optional task module", async () => {
    const definition = await importedFixture(service, "controlled-loop.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "无任务模块闭环",
    });
    expect(instance.status).toBe("running");
    expect(instance.nodes.confirm?.status).toBe("ready");
    expect(
      Object.values(instance.nodes).every(
        (state) => state.taskIds.length === 0,
      ),
    ).toBe(true);

    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "confirm",
    });
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "testing",
      decision: "approved",
    });
    const completed = service.instanceView(instance.id)!;
    expect(completed.status).toBe("running");
    expect(completed.nodes["release-ready"]?.status).toBe("ready");
    expect(
      Object.values(completed.nodes).every(
        (state) => state.taskIds.length === 0,
      ),
    ).toBe(true);
  });

  it("reactivates a completed node after a controlled rejection", async () => {
    const definition = await importedFixture(service, "controlled-loop.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "首次返工",
    });
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "confirm",
    });
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    const reworked = await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "testing",
      decision: "rejected",
    });
    expect(reworked.nodes.development?.status).toBe("ready");
    expect(reworked.nodes.development?.attempts).toBe(2);
    expect(reworked.context.attempts).toBe(2);
    expect(reworked.nodes.testing?.status).toBe("completed");
    expect(reworked.status).toBe("running");
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "testing",
      decision: "rejected",
    });
    const secondRework = service.instance(instance.id)!;
    expect(secondRework.nodes.development?.status).toBe("ready");
    expect(secondRework.context.attempts).toBe(3);
    await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "testing",
      decision: "rejected",
    });
    const blocked = service.instance(instance.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.nodes.development?.status).toBe("blocked");
    expect(blocked.nodes.development?.note).toContain("已触发 break");
  });

  it("starts and completes a sub-workflow", async () => {
    await importedFixture(service, "sub-process.md");
    const parentDefinition = await importedFixture(service, "parent-child.md");
    const parent = await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: parentDefinition.id,
      title: "父流程",
    });
    const withChild = await service.resolveDecision(owner, {
      instanceId: parent.id,
      nodeId: "complexity",
      values: { complexity: 8 },
    });
    const parentNode = withChild.nodes["complex-review"]!;
    expect(parentNode.status).toBe("running");
    expect(parentNode.childInstanceId).toBeDefined();
    const child = service.instance(parentNode.childInstanceId!)!;
    expect(child.definitionKey).toBe("complex-review");
    await service.decideApproval(owner, {
      instanceId: child.id,
      nodeId: "architecture",
      decision: "approved",
    });
    const childAfterFirst = service.instance(child.id)!;
    expect(childAfterFirst.nodes.security?.status).toBe("ready");
    await service.decideApproval(member, {
      instanceId: child.id,
      nodeId: "security",
      decision: "approved",
    });
    const completedChild = service.instance(child.id)!;
    expect(completedChild.status).toBe("completed");
    const completedParent = service.instance(parent.id)!;
    expect(completedParent.nodes["complex-review"]?.status).toBe("completed");
    expect(completedParent.nodes.archive?.status).toBe("ready");
    await service.completeNode(owner, {
      instanceId: parent.id,
      nodeId: "archive",
    });
    const archivedParent = service.instance(parent.id)!;
    expect(archivedParent.nodes.archive?.status).toBe("completed");
    expect(archivedParent.status).toBe("completed");
    const low = await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: parentDefinition.id,
      title: "标准方案实例",
    });
    const lowRouted = await service.resolveDecision(owner, {
      instanceId: low.id,
      nodeId: "complexity",
      values: { complexity: 3 },
    });
    expect(lowRouted.nodes["complex-review"]?.status).toBe("skipped");
    expect(lowRouted.nodes["standard-development"]?.status).toBe("ready");
    await expect(
      service.completeNode(member, {
        instanceId: low.id,
        nodeId: "standard-development",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.completeNode(owner, {
      instanceId: low.id,
      nodeId: "standard-development",
    });
    await service.completeNode(owner, {
      instanceId: low.id,
      nodeId: "archive",
    });
    const archivedLow = service.instance(low.id)!;
    expect(archivedLow.nodes.archive?.status).toBe("completed");
    expect(archivedLow.status).toBe("completed");
  });
});

describe("workflow agent nodes", () => {
  async function agentHarness(
    hasProfile = true,
    withTasks = true,
    withContext = false,
  ) {
    const current = tables();
    const agent = new FakeAgentService(hasProfile);
    const tasks = new FakeTaskBridge();
    const contextPrepared: Array<Record<string, unknown>> = [];
    const receipts: Array<Record<string, unknown>> = [];
    const context = {
      registerAdapter: () => () => undefined,
      prepare: async (input: Record<string, unknown>) => {
        contextPrepared.push(input);
        return {
          id: "pack-workflow-1",
          sessionBindingId: "workflow-node:instance:development:g0",
          rendered: {
            systemText: "system",
            userText: "workflow context",
            flattenedPrompt: "system\n\nworkflow context",
          },
        };
      },
      session: () => ({
        sessionId: "de-flow-instance-development",
        generation: 0,
      }),
      recordRuntime: async (input: Record<string, unknown>) => {
        receipts.push(input);
      },
    };
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      ...(withTasks ? { tasks: () => tasks } : {}),
      agent: () => agent,
      ...(withContext ? { context: () => context } : {}),
    });
    return {
      agent,
      context,
      contextPrepared,
      current,
      receipts,
      tasks,
      service,
    };
  }

  async function employeeHarness(
    hasProfile = true,
    failTickets = false,
    failWriteAuthorization = false,
    workflowBlockReason?: string,
  ) {
    const current = tables();
    const agent = new FakeAgentService(hasProfile);
    const employee = new FakeEmployeeService(
      failTickets,
      failWriteAuthorization,
      workflowBlockReason,
    );
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      agent: () => agent,
      employee: () => employee,
      principals: () => ({
        resolveReference: (reference) =>
          reference === "principal:principal-ai-backend-01" ||
          reference === "employee:backend-01"
            ? {
                id: "principal-ai-backend-01",
                kind: "ai",
                status: "active",
              }
            : undefined,
        resolveSubject: (subjectType, subjectId) =>
          (subjectType === "employee" && subjectId === "backend-01") ||
          (subjectType === "auth-user" && subjectId === "workflow-member")
            ? {
                id:
                  subjectType === "employee"
                    ? "principal-ai-backend-01"
                    : "principal-human-workflow-member",
                kind: subjectType === "employee" ? "ai" : "human",
                status: "active",
              }
            : undefined,
        preferredSubjectId: (principalId) =>
          principalId === "principal-ai-backend-01"
            ? "backend-01"
            : principalId === "principal-human-workflow-member"
              ? "workflow-member"
              : undefined,
      }),
    });
    return { agent, current, employee, service };
  }

  it("rejects start when the referenced Agent Profile is unavailable", async () => {
    const { service } = await agentHarness(false);
    const definition = await importedFixture(service, "agent-node.md");
    await expect(
      service.startInstance(member, {
        workspaceId: "main",
        definitionId: definition.id,
        title: "Agent Profile 校验",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Agent Profile「backend-agent」不存在"),
    });
  });

  it("auto-dispatches a ready Agent node and maps output to the delivery gate", async () => {
    const { agent, service, tasks } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 自动执行",
    });
    expect(instance.nodes.development?.status).toBe("running");
    expect(instance.nodes.development?.assignedTo).toBe("Backend Agent");
    const developmentTaskId = instance.nodes.development?.taskIds[0]!;
    expect(tasks.records.get(developmentTaskId)).toMatchObject({
      receiverId: "backend-agent",
      receiverName: "Backend Agent",
    });
    expect(agent.dispatchInputs).toHaveLength(1);
    expect(agent.dispatchInputs[0]).toMatchObject({
      profileId: "backend-agent",
      trigger: "auto-on-ready",
      attempt: 1,
      runSeq: 1,
      maxAttempts: 2,
      timeoutMs: 1_800_000,
      payload: { responsibleId: "workflow-member" },
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n已完成 Agent 执行说明，覆盖接口与风险检查。",
        stopReason: "completed",
      },
    });
    await expect(service.cancelAgentRun(member, run.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Agent 运行已完成，无法取消",
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    const settled = service.instance(instance.id)!;
    expect(settled.nodes.development?.status).toBe("ready");
    expect(settled.nodes.development?.note).toContain("等待人工 Review");
    expect(tasks.records.get(developmentTaskId)?.status).toBe("review");
    expect(tasks.projectedStatuses.get(developmentTaskId)).toBe("review");
    expect(tasks.projectedRuns.get(developmentTaskId)).toBe(run.id);
    const submissions = service.submissions(instance.id, {
      nodeId: "development",
    });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      requirementKey: "implementation-report",
      submittedBy: "agent:backend-agent",
      onBehalfOf: "backend-agent",
      note: `agent-run:${run.id}`,
    });
    expect(settled.status).toBe("running");
  });

  it("dispatches Agent nodes through a canonical ContextPack and receipt", async () => {
    const { agent, contextPrepared, receipts, service } = await agentHarness(
      true,
      true,
      true,
    );
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Context Pack 工作流",
    });
    expect(agent.dispatchInputs[0]).toMatchObject({
      profileId: "backend-agent",
      contextPackId: "pack-workflow-1",
      sessionBindingId: "workflow-node:instance:development:g0",
      sessionId: "de-flow-instance-development",
      payload: {
        context: {
          instruction: "system\n\nworkflow context",
          contextPackId: "pack-workflow-1",
        },
      },
    });
    expect(contextPrepared[0]).toMatchObject({
      scene: "workflow-node",
      objectId: `${instance.id}:development`,
      workspaceId: "main",
      agentProfileId: "backend-agent",
    });
    expect(receipts[0]).toMatchObject({
      contextPackId: "pack-workflow-1",
      runtime: { kind: "builtin" },
    });
  });

  it("direct-completes a no-review Agent node and closes its task projection", async () => {
    const { agent, service, tasks } = await agentHarness();
    const sourceMd = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/agent-node.md",
          import.meta.url,
        ),
        "utf8",
      )
    ).replace(
      "- execution: task-worker",
      "- review-required: false\n- execution: task-worker",
    );
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd,
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 无需 Review 直接完成",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    const developmentTaskId = service.instance(instance.id)!.nodes.development!
      .taskIds[0]!;
    expect(tasks.records.get(developmentTaskId)).toMatchObject({
      status: "progress",
    });
    expect(tasks.records.get(developmentTaskId)?.workflow).toMatchObject({
      reviewRequired: false,
    });
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n已完成 Agent 执行说明，覆盖接口与风险检查。",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    const settled = service.instance(instance.id)!;
    expect(settled.nodes.development?.status).toBe("completed");
    expect(settled.status).toBe("completed");
    expect(tasks.records.get(developmentTaskId)?.status).toBe("done");
    expect(tasks.outcomes.get(developmentTaskId)).toBe("approved");
    expect(tasks.projectedRuns.get(developmentTaskId)).toBe(run.id);
  });

  it("refreshes stale agent task display names without changing the executor", async () => {
    const { service, tasks } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "旧显示名同步",
    });
    const taskId = instance.nodes.development?.taskIds[0]!;
    Object.assign(tasks.records.get(taskId)!, {
      receiverName: "backend-agent",
    });

    await service.handleTaskReconcile(tasks.records.get(taskId)!);

    expect(tasks.records.get(taskId)).toMatchObject({
      receiverId: "backend-agent",
      receiverName: "Backend Agent",
    });

    Object.assign(tasks.records.get(taskId)!, {
      status: "done",
      receiverName: "backend-agent",
    });
    await service.refreshTaskReceiverDisplay(tasks.records.get(taskId)!);

    expect(tasks.records.get(taskId)).toMatchObject({
      receiverId: "backend-agent",
      receiverName: "Backend Agent",
    });
  });

  it("keeps a manual task reassignment instead of reverting it on reconcile", async () => {
    const { service, tasks } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "改派保持",
    });
    const taskId = instance.nodes.development?.taskIds[0]!;

    await service.handleTaskAssigned(
      {
        id: taskId,
        workspaceId: "main",
        receiverType: "agent",
        receiverId: "qa-agent",
        receiverName: "QA Agent",
        workflow: { instanceId: instance.id, nodeId: "development" },
      },
      owner,
    );
    Object.assign(tasks.records.get(taskId)!, {
      receiverType: "agent",
      receiverId: "qa-agent",
      receiverName: "QA Agent",
    });

    const reassigned = service.instance(instance.id)!.nodes.development!;
    expect(reassigned.receiverOverride).toMatchObject({
      type: "agent",
      id: "qa-agent",
      name: "QA Agent",
    });
    expect(reassigned.assignedTo).toBe("QA Agent");

    await service.handleTaskReconcile(tasks.records.get(taskId)!);

    expect(tasks.records.get(taskId)).toMatchObject({
      receiverType: "agent",
      receiverId: "qa-agent",
      receiverName: "QA Agent",
    });
  });

  it("releases the owner fallback when the task is reassigned back to the node teammate", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const employee = new FakeEmployeeService(
      false,
      false,
      "Teammate「Backend Engineer 01」已暂停，不能派发",
    );
    const tasks = new FakeTaskBridge();
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
      agent: () => agent,
      employee: () => employee,
      teammates: () => ({
        list: () => [
          {
            id: "tm-backend",
            name: "Backend Engineer 01",
            state: "inactive",
            employeeId: "backend-01",
            ownerUserId: "workflow-member",
            ownerName: "Member",
          },
        ],
      }),
    });
    const definition = await importedFixture(
      service,
      "employee-node-manual.md",
    );
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "改派解除兜底",
    });
    const dispatched = await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(dispatched.nodes.development?.executorFallback).toBeDefined();
    const taskId = dispatched.nodes.development?.taskIds.at(-1)!;

    await service.handleTaskAssigned(
      {
        id: taskId,
        workspaceId: "main",
        receiverType: "agent",
        receiverId: "tm-backend",
        receiverName: "Backend Engineer 01",
        workflow: { instanceId: instance.id, nodeId: "development" },
      },
      owner,
    );

    const released = service.instance(instance.id)!.nodes.development!;
    expect(released.executorFallback).toBeUndefined();
    expect(released.status).toBe("ready");
    expect(released.receiverOverride).toMatchObject({
      type: "agent",
      id: "tm-backend",
      name: "Backend Engineer 01",
    });

    Object.assign(tasks.records.get(taskId)!, {
      receiverType: "agent",
      receiverId: "tm-backend",
      receiverName: "Backend Engineer 01",
    });
    await service.handleTaskReconcile(tasks.records.get(taskId)!);
    expect(tasks.records.get(taskId)).toMatchObject({
      receiverType: "agent",
      receiverId: "tm-backend",
      receiverName: "Backend Engineer 01",
    });
  });

  it("starts the workflow Agent run after a task reassignment is persisted", async () => {
    const { agent, service, tasks } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "改派后启动工作流运行",
    });
    const taskId = instance.nodes.development?.taskIds[0]!;
    const initialRun = agent.runs(instance.id, "development")[0]!;

    agent.settle(initialRun.id, {
      status: "failed",
      error: "首次执行失败",
    });
    await service.handleAgentSettle(agent.run(initialRun.id)!);
    expect(service.instance(instance.id)?.nodes.development?.status).toBe(
      "blocked",
    );

    await service.handleTaskAssigned(
      {
        id: taskId,
        workspaceId: "main",
        receiverType: "agent",
        receiverId: "backend-agent",
        receiverName: "Backend Agent",
        workflow: { instanceId: instance.id, nodeId: "development" },
      },
      owner,
    );
    Object.assign(tasks.records.get(taskId)!, {
      receiverType: "agent",
      receiverId: "backend-agent",
      receiverName: "Backend Agent",
    });
    await service.handleTaskAssignedAfterPersist(
      tasks.records.get(taskId)!,
      owner,
    );

    expect(agent.dispatchInputs).toHaveLength(2);
    expect(agent.dispatchInputs[1]).toMatchObject({
      source: "workflow",
      instanceId: instance.id,
      nodeId: "development",
      trigger: "auto-on-ready",
    });
    expect(service.instance(instance.id)?.nodes.development?.status).toBe(
      "running",
    );
  });

  it("direct-completes a no-review Agent node without a task module", async () => {
    const { agent, service } = await agentHarness(true, false);
    const sourceMd = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/agent-node.md",
          import.meta.url,
        ),
        "utf8",
      )
    ).replace(
      "- execution: task-worker",
      "- review-required: false\n- execution: task-worker",
    );
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd,
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "无任务模块 Agent 闭环",
    });
    expect(instance.nodes.development).toMatchObject({
      status: "running",
      assignedTo: "Backend Agent",
    });
    expect(instance.nodes.development?.taskIds).toEqual([]);
    expect(agent.dispatchInputs).toHaveLength(1);
    expect(
      agent.dispatchInputs[0]?.payload.context.workflowTaskId,
    ).toBeUndefined();

    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n已完成 Agent 执行说明，覆盖接口与风险检查。",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    const settled = service.instanceView(instance.id)!;
    expect(settled.nodes.development?.status).toBe("completed");
    expect(settled.status).toBe("completed");
    expect(settled.nodes.development?.taskIds).toEqual([]);
    expect(
      service.submissions(instance.id, { nodeId: "development" }),
    ).toHaveLength(1);
  });

  it("retries a run retired after restart while the node remains running", async () => {
    const { agent, service } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 重启恢复",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "interrupted",
      error: "服务重启导致运行中断，可重试或转人工",
    });

    expect(service.instance(instance.id)!.nodes.development?.status).toBe(
      "running",
    );
    const retried = await service.retryAgentRun(member, run.id);
    expect(agent.runs(instance.id, "development")).toHaveLength(2);
    expect(agent.dispatchInputs[1]?.payload.previousFailure).toContain(
      "服务重启导致运行中断",
    );
    expect(retried.nodes.development).toMatchObject({
      status: "running",
      note: "Agent 运行中 · 第 2 次",
    });
  });

  it("dispatches employee nodes through mapped runtime and preserves the principal", async () => {
    const { agent, employee, service, current } = await employeeHarness();
    const definition = await importedFixture(service, "employee-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Digital Employee 自动执行",
    });
    expect(instance.nodes.development?.assignedTo).toBe("Backend Engineer 01");
    expect(employee.tickets).toHaveLength(1);
    expect(agent.dispatchInputs[0]).toMatchObject({
      profileId: "backend-agent",
      employeeId: "backend-01",
      principalId: "principal-ai-backend-01",
      principalType: "digital-employee",
      ticketId: "ticket-1",
      payload: { employeeName: "Backend Engineer 01" },
    });
    const run = agent.runs(instance.id, "development")[0]!;
    expect(run.principalId).toBe("principal-ai-backend-01");
    expect(
      [...current.events.entries()].some(
        ([, event]) =>
          event.actorPrincipalId === "principal-human-workflow-member",
      ),
    ).toBe(true);
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n已完成 Digital Employee 交付说明与风险检查。",
        stopReason: "completed",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    expect(employee.authorized).toEqual(["ticket-1"]);
    const settled = service.instance(instance.id)!;
    const submissions = service.submissions(instance.id, {
      nodeId: "development",
    });
    expect(submissions[0]).toMatchObject({
      submittedBy: "employee:backend-01",
      submittedByName: "Backend Engineer 01",
      onBehalfOf: "backend-01",
    });
    expect(settled.status).toBe("running");
  });

  it("recovers an employee node after an automatic ticket failure", async () => {
    const { agent, employee, service } = await employeeHarness(true, true);
    const definition = await importedFixture(service, "employee-node.md");
    const failed = await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Digital Employee 票据失败恢复",
    });
    expect(failed.nodes.development).toMatchObject({
      status: "blocked",
    });
    expect(failed.nodes.development?.note).toContain("AI伙伴运行票据签发失败");

    const recovered = await service.dispatchAgentNode(owner, {
      instanceId: failed.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(recovered.nodes.development?.status).toBe("running");
    expect(employee.tickets).toHaveLength(1);
    expect(agent.dispatchInputs[0]).toMatchObject({
      principalType: "digital-employee",
      ticketId: "ticket-1",
    });
  });

  it("recovers an employee run whose output was denied by its ticket", async () => {
    const { agent, employee, service } = await employeeHarness(
      true,
      false,
      true,
    );
    const definition = await importedFixture(service, "employee-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Digital Employee 票据拒绝恢复",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n已完成 Digital Employee 交付说明与风险检查。",
        stopReason: "completed",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    const blocked = service.instance(instance.id)!;
    expect(blocked.nodes.development).toMatchObject({
      status: "blocked",
      note: expect.stringContaining("action is explicitly denied"),
    });
    expect(employee.authorized).toEqual([]);
    expect(
      service.submissions(instance.id, { nodeId: "development" }),
    ).toHaveLength(0);

    const retried = await service.retryAgentRun(owner, run.id);
    const secondRun = agent.runs(instance.id, "development")[1]!;
    expect(secondRun.ticketId).toBe("ticket-2");
    expect(retried.nodes.development).toMatchObject({
      status: "running",
      note: "AI伙伴运行中 · 第 2 次",
    });

    agent.settle(secondRun.id, {
      ...secondRun,
      status: "succeeded",
      output: {
        summary: "## 交付说明\n\n调整 Runtime 后完成交付说明与风险检查。",
        stopReason: "completed",
      },
    });
    await service.handleAgentSettle(agent.run(secondRun.id)!);
    const settled = service.instance(instance.id)!;
    expect(settled.nodes.development?.status).toBe("ready");
    expect(settled.nodes.development?.note).toContain("等待人工 Review");
    expect(settled.status).toBe("running");
    expect(employee.authorized).toEqual(["ticket-2"]);
  });

  it("dispatches a Principal Runtime node without an Employee record", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const issued: Array<Record<string, unknown>> = [];
    const authorized: string[] = [];
    const principalId = "principal-ai-tm-principal";
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      agent: () => agent,
      teammates: () => ({
        list: () => [
          {
            id: "tm-principal",
            name: "Principal Worker",
            state: "active",
            ownerUserId: "workflow-member",
            ownerName: "Member",
          },
        ],
      }),
      teammateRuntime: () => ({
        ensureRuntime: async () => ({
          teammateId: "tm-principal",
          principalId,
          profileId: "agent-principal",
        }),
      }),
      principals: () => ({
        resolveReference: () => ({
          id: principalId,
          kind: "ai",
          status: "active",
        }),
        resolveSubject: (subjectType, subjectId) =>
          subjectType === "teammate" && subjectId === "tm-principal"
            ? { id: principalId, kind: "ai", status: "active" }
            : undefined,
        preferredSubjectId: () => undefined,
      }),
      principalRuntime: () => ({
        profile: () => ({
          id: "principal-runtime-1",
          agentProfileId: "agent-principal",
          status: "active",
        }),
        issueTicket: async (input) => {
          issued.push(input);
          return { id: "principal-ticket-1" };
        },
        authorizeTicket: async (input) => {
          authorized.push(input.ticketId);
          return { principalId };
        },
      }),
    });
    const source = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/employee-node.md",
          import.meta.url,
        ),
        "utf8",
      )
    )
      .replace("executor: employee:backend-01", "executor: agent:tm-principal")
      .replace("trigger: auto-on-ready", "trigger: manual-dispatch");
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: source,
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Principal Runtime",
    });
    await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(agent.dispatchInputs[0]).toMatchObject({
      profileId: "agent-principal",
      principalId,
      principalType: "principal-runtime",
      ticketId: "principal-ticket-1",
    });
    expect(issued[0]).toMatchObject({
      principalId,
      contextType: "workflow",
      contextId: instance.id,
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary:
          "## 交付说明\n\nPrincipal Runtime 已完成实现说明、范围检查和风险复核。",
        stopReason: "completed",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    expect(authorized).toContain("principal-ticket-1");
  });

  it("resolves a unique Principal Runtime for a legacy Agent Profile node", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const principalId = "principal-ai-legacy-profile";
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      agent: () => agent,
      teammates: () => ({ list: () => [] }),
      principals: () => ({
        resolveReference: () => undefined,
        resolveSubject: () => undefined,
        preferredSubjectId: () => undefined,
      }),
      principalRuntime: () => ({
        profiles: () => [
          {
            id: "principal-runtime-legacy",
            principalId,
            workspaceId: "main",
            agentProfileId: "agent-principal",
            status: "active",
          },
        ],
        profile: () => ({
          id: "principal-runtime-legacy",
          agentProfileId: "agent-principal",
          status: "active",
        }),
        issueTicket: async () => ({ id: "principal-ticket-legacy" }),
        authorizeTicket: async () => ({ principalId }),
      }),
    });
    const source = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/employee-node.md",
          import.meta.url,
        ),
        "utf8",
      )
    )
      .replace(
        "executor: employee:backend-01",
        "executor: agent:agent-principal",
      )
      .replace("trigger: auto-on-ready", "trigger: manual-dispatch");
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: source,
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Legacy Agent Profile",
    });
    await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(agent.dispatchInputs[0]).toMatchObject({
      profileId: "agent-principal",
      principalId,
      principalType: "principal-runtime",
      ticketId: "principal-ticket-legacy",
    });
  });

  it("reports a suspended employee as the manual dispatch blocker", async () => {
    const { agent, service } = await employeeHarness(
      true,
      false,
      false,
      "Teammate「Backend Engineer 01」已暂停，不能派发",
    );
    const definition = await importedFixture(
      service,
      "employee-node-manual.md",
    );
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Digital Employee 暂停原因",
    });
    expect(instance.nodes.development?.status).toBe("ready");
    await expect(
      service.dispatchAgentNode(member, {
        instanceId: instance.id,
        nodeId: "development",
        trigger: "manual-dispatch",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Teammate「Backend Engineer 01」已暂停，不能派发",
    });
    expect(agent.dispatchInputs).toHaveLength(0);
  });

  it("falls back to the instance owner when the executor teammate is not dispatchable", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const employee = new FakeEmployeeService(
      false,
      false,
      "Teammate「Backend Engineer 01」已暂停，不能派发",
    );
    const tasks = new FakeTaskBridge();
    const teammate = {
      id: "tm-backend",
      name: "Backend Engineer 01",
      state: "inactive",
      employeeId: "backend-01",
      ownerUserId: "workflow-member",
      ownerName: "Member",
    };
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
      agent: () => agent,
      employee: () => employee,
      teammates: () => ({ list: () => [teammate] }),
    });
    const definition = await importedFixture(
      service,
      "employee-node-manual.md",
    );
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "执行实例失效兜底",
    });
    expect(instance.nodes.development?.status).toBe("ready");

    const dispatched = await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(dispatched.nodes.development).toMatchObject({
      status: "ready",
      assignedTo: "Member",
      executorFallback: {
        kind: "user",
        id: "workflow-member",
        label: "Member",
        originalExecutorId: "backend-01",
        originalExecutorLabel: "Backend Engineer 01",
      },
    });
    expect(dispatched.nodes.development?.note).toContain("已自动转交");
    expect(agent.dispatchInputs).toHaveLength(0);
    const taskId = dispatched.nodes.development?.taskIds.at(-1)!;
    expect(tasks.records.get(taskId)).toMatchObject({
      receiverType: "human",
      receiverId: "workflow-member",
      receiverName: "Member",
    });
    expect(service.events(instance.id).map((event) => event.kind)).toContain(
      "executor.fallback",
    );

    // 兜底接收人与节点责任人同权：可以补交交付物并人工完成节点。
    await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "人工兜底补交实现说明，覆盖范围与风险检查。",
    });
    const completed = await service.completeNode(member, {
      instanceId: instance.id,
      nodeId: "development",
    });
    expect(completed.nodes.development?.status).toBe("completed");
  });

  it("hands the node to the project owner when the instance owner is not a member", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const employee = new FakeEmployeeService(
      false,
      false,
      "Teammate「Backend Engineer 01」已暂停，不能派发",
    );
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      agent: () => agent,
      employee: () => employee,
      teammates: () => ({
        list: () => [
          {
            id: "tm-backend",
            name: "Backend Engineer 01",
            state: "inactive",
            employeeId: "backend-01",
            ownerUserId: "ghost-owner",
            ownerName: "Ghost Owner",
          },
        ],
      }),
    });
    const definition = await importedFixture(
      service,
      "employee-node-manual.md",
    );
    const instance = await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "执行实例失效兜底到项目 owner",
    });

    const dispatched = await service.dispatchAgentNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(dispatched.nodes.development?.executorFallback).toMatchObject({
      id: "flow-owner",
      label: "Owner",
    });
    expect(agent.dispatchInputs).toHaveLength(0);
  });

  it("still starts the instance when the referenced teammate is already inactive", async () => {
    const current = tables();
    const agent = new FakeAgentService(true);
    const employee: EmployeeServiceLike = {
      employeeWorkspaceTarget: () => undefined,
      workflowTarget: () => undefined,
      workflowDispatchBlockReason: () => undefined,
      employeeApprovalTarget: () => undefined,
      issueRuntimeTicket: async () => ({ id: "ticket-1" }),
      authorizeTicket: async () => ({ employeeId: "backend-01" }),
    };
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      agent: () => agent,
      employee: () => employee,
      teammates: () => ({
        list: () => [
          {
            id: "tm-backend",
            name: "Backend Engineer 01",
            state: "inactive",
            employeeId: "backend-01",
            ownerUserId: "flow-owner",
            ownerName: "Owner",
          },
        ],
      }),
    });
    const definition = await importedFixture(
      service,
      "employee-node-manual.md",
    );
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "执行实例已停用时仍可启动",
    });
    expect(instance.nodes.development?.status).toBe("ready");

    const dispatched = await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    expect(dispatched.nodes.development).toMatchObject({
      status: "ready",
      executorFallback: {
        id: "flow-owner",
        label: "Owner",
        originalExecutorId: "backend-01",
      },
    });
    expect(dispatched.nodes.development?.note).toContain("已自动转交");
    expect(agent.dispatchInputs).toHaveLength(0);
  });

  it("does not accept an agent reply without the required delivery section", async () => {
    const { agent, service } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 输出格式校验",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "succeeded",
      output: {
        summary:
          "Let me inspect the workspace before writing the delivery note.",
        stopReason: "completed",
      },
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    expect(extractAgentDeliverableText("没有约定章节")).toBe("");
    const settled = service.instance(instance.id)!;
    expect(settled.nodes.development).toMatchObject({
      status: "blocked",
      note: expect.stringContaining("未按约定输出「交付说明」"),
    });
    expect(
      service.submissions(instance.id, { nodeId: "development" }),
    ).toHaveLength(0);
    const retried = await service.retryAgentRun(member, run.id);
    expect(agent.runs(instance.id, "development")).toHaveLength(2);
    expect(retried.nodes.development).toMatchObject({
      status: "running",
      note: "Agent 运行中 · 第 2 次",
    });
  });

  it("allows the responsible user to recover a timed-out agent node manually", async () => {
    const { agent, service } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 超时转人工",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    agent.settle(run.id, {
      ...run,
      status: "timeout",
      error: "运行超时，已中止",
    });
    await service.handleAgentSettle(agent.run(run.id)!);
    expect(service.instance(instance.id)!.nodes.development?.status).toBe(
      "blocked",
    );
    const submission = await service.submitDeliverable(member, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value:
        "人工接管完成开发说明：覆盖接口结果、验证范围和上线风险，避免流程停滞。",
    });
    expect(submission.onBehalfOf).toBe("backend-agent");
    const recovered = service.instance(instance.id)!;
    expect(recovered.nodes.development?.status).toBe("ready");
    expect(recovered.nodes.development?.note).toContain("人工代交");
    const completed = await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
    });
    expect(completed.nodes.development?.status).toBe("completed");
  });

  it("allows manual intervention to complete a running or blocked Agent node", async () => {
    const { agent, service } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 人工完成",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    await expect(
      service.completeNode(member, {
        instanceId: instance.id,
        nodeId: "development",
        force: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.completeNode(owner, {
        instanceId: instance.id,
        nodeId: "development",
        force: true,
      }),
    ).rejects.toMatchObject({ code: "missing_deliverables" });

    await service.cancelAgentRun(owner, run.id);
    await service.handleAgentSettle(agent.run(run.id)!);
    await service.submitDeliverable(owner, {
      instanceId: instance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "Owner 人工接管完成开发说明：覆盖接口结果、验证范围和上线风险。",
    });
    const completed = await service.completeNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
      note: "结果已线下确认",
      force: true,
    });
    expect(completed.nodes.development).toMatchObject({
      status: "completed",
      note: "人工介入完成：结果已线下确认",
    });
    expect(completed.status).toBe("completed");
    expect(agent.run(run.id)?.status).toBe("cancelled");
    expect(
      service
        .events(instance.id)
        .some(
          (event) =>
            event.kind === "node.completed" &&
            event.message === "人工完成节点：开发" &&
            event.data.manual === true,
        ),
    ).toBe(true);

    const failedInstance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 人工兜底",
    });
    const failedRun = agent.runs(failedInstance.id, "development")[0]!;
    agent.settle(failedRun.id, { status: "failed", error: "worker stopped" });
    await service.handleAgentSettle(agent.run(failedRun.id)!);
    await service.submitDeliverable(owner, {
      instanceId: failedInstance.id,
      nodeId: "development",
      requirementKey: "implementation-report",
      type: "text",
      value: "失败后由 Owner 补交说明：结果已完成且风险可接受。",
    });
    const recovered = await service.completeNode(owner, {
      instanceId: failedInstance.id,
      nodeId: "development",
      force: true,
    });
    expect(recovered.nodes.development?.status).toBe("completed");
  });

  it("allows manual intervention to cancel an Agent node and cancels its task", async () => {
    const { agent, service, tasks: taskService } = await agentHarness();
    const definition = await importedFixture(service, "agent-node.md");
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 人工取消",
    });
    const run = agent.runs(instance.id, "development")[0]!;
    const taskId = instance.nodes.development?.taskIds[0]!;
    await expect(
      service.cancelNode(guest, {
        instanceId: instance.id,
        nodeId: "development",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    await expect(
      service.cancelNode(member, {
        instanceId: instance.id,
        nodeId: "development",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const cancelled = await service.cancelNode(owner, {
      instanceId: instance.id,
      nodeId: "development",
      note: "不再需要该分支",
    });
    expect(cancelled.nodes.development).toMatchObject({
      status: "skipped",
      note: "人工取消：不再需要该分支",
    });
    expect(agent.run(run.id)?.status).toBe("cancelled");
    expect(taskService.get(taskId)?.status).toBe("cancelled");
    expect(
      service
        .events(instance.id)
        .some(
          (event) =>
            event.kind === "node.cancelled" && event.data.manual === true,
        ),
    ).toBe(true);
  });

  it("supports manual dispatch, cancellation, retry, permissions, and attempt cap", async () => {
    const { agent, service } = await agentHarness();
    const sourceMd = (
      await readFile(
        new URL(
          "../../../docs/fixtures/workflow/agent-node.md",
          import.meta.url,
        ),
        "utf8",
      )
    )
      .replace("version: 2", "version: 3")
      .replace("trigger: auto-on-ready", "trigger: manual-dispatch");
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd,
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Agent 手动执行",
    });
    expect(instance.nodes.development?.status).toBe("ready");
    await expect(
      service.dispatchAgentNode(guest, {
        instanceId: instance.id,
        nodeId: "development",
        trigger: "manual-dispatch",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.dispatchAgentNode(member, {
      instanceId: instance.id,
      nodeId: "development",
      trigger: "manual-dispatch",
    });
    const firstRun = agent.runs(instance.id)[0]!;
    await service.cancelAgentRun(member, firstRun.id);
    await service.handleAgentSettle(agent.run(firstRun.id)!);
    expect(service.instance(instance.id)!.nodes.development?.status).toBe(
      "ready",
    );
    await service.retryAgentRun(member, firstRun.id);
    const secondRun = agent.runs(instance.id)[1]!;
    agent.settle(secondRun.id, { status: "failed", error: "worker stopped" });
    expect(secondRun.runSeq).toBe(2);
    await service.handleAgentSettle({
      ...secondRun,
      status: "failed",
      error: "worker stopped",
    });
    expect(service.instance(instance.id)!.nodes.development).toMatchObject({
      status: "blocked",
      note: "Agent 运行未完成：worker stopped",
    });
    await expect(
      service.retryAgentRun(member, secondRun.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    await service.retryAgentRun(owner, secondRun.id);
    expect(agent.runs(instance.id)).toHaveLength(3);
  });
});

describe("workflow project role nodes", () => {
  type RoleMember = {
    readonly assigneeKind: "user" | "agent";
    readonly assigneeId: string;
    readonly status: string;
  };

  function roleFixture(key: string) {
    return [
      "# 工作流：项目角色执行",
      "",
      "## 元信息",
      "",
      `- key: ${key}`,
      "- version: 1",
      "",
      "## 节点",
      "",
      "### 评审",
      "",
      "- id: review",
      "- type: approval",
      "- executor: user:flow-owner",
      "- approver: 角色:reviewer",
      "- policy: any",
      "",
      "### 设计",
      "",
      "- id: design",
      "- type: task",
      "- executor: role:reviewer",
      "- description: 输出设计说明",
      "- deliverable: design-report",
      "  title: 设计说明",
      "  type: text",
      "  required: true",
      "  min-text-length: 10",
      "",
      "## 连接",
      "",
      "- review -> design",
    ].join("\n");
  }

  function roleHarness(members: readonly RoleMember[]) {
    const current = tables();
    const tasks = new FakeTaskBridge();
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
      roles: () => ({
        config: () => ({
          seats: [{ id: "reviewer", label: "评审组", participantKind: "any" }],
        }),
        members: (_workspaceId: string, seatId: string) =>
          seatId === "reviewer" ? members : [],
      }),
    });
    return { current, tasks, service };
  }

  const roleMembers: RoleMember[] = [
    { assigneeKind: "user", assigneeId: "workflow-member", status: "claimed" },
    { assigneeKind: "user", assigneeId: "flow-member", status: "assigned" },
    { assigneeKind: "agent", assigneeId: "tm-tester", status: "assigned" },
  ];

  it("projects a role node to the role and lets any member act", async () => {
    const { service, tasks } = roleHarness(roleMembers);
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: roleFixture("role-node"),
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "角色节点执行",
    });

    const reviewTaskId = instance.nodes.review?.taskIds[0]!;
    expect(tasks.records.get(reviewTaskId)).toMatchObject({
      receiverType: "role",
      receiverId: "reviewer",
      receiverName: "评审组",
    });

    // 角色成员的任一人都能给出审批结论（或签）。
    const decided = await service.decideApproval(member, {
      instanceId: instance.id,
      nodeId: "review",
      decision: "approved",
    });
    expect(decided.nodes.review?.status).toBe("completed");
    const designTaskId = decided.nodes.design?.taskIds[0]!;
    expect(tasks.records.get(designTaskId)).toMatchObject({
      receiverType: "role",
      receiverId: "reviewer",
      receiverName: "评审组",
    });

    // 非角色成员不能代交 / 完成角色节点。
    const outsider: WorkflowActor = {
      kind: "user",
      id: "workflow-admin",
      name: "Admin",
      workspaceRole: "member",
    };
    await expect(
      service.submitDeliverable(outsider, {
        instanceId: decided.id,
        nodeId: "design",
        requirementKey: "design-report",
        type: "text",
        value: "非成员提交的设计说明，不应该被接受。",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // 角色里的另一名成员补交并完成节点。
    const other: WorkflowActor = {
      kind: "user",
      id: "flow-member",
      name: "Flow Member",
      workspaceRole: "member",
    };
    await service.submitDeliverable(other, {
      instanceId: decided.id,
      nodeId: "design",
      requirementKey: "design-report",
      type: "text",
      value: "角色成员提交的设计说明，覆盖范围与风险。",
    });
    const completed = await service.completeNode(other, {
      instanceId: decided.id,
      nodeId: "design",
    });
    expect(completed.nodes.design?.status).toBe("completed");
  });

  it("keeps active instances on their start-time role snapshot after the role is removed", async () => {
    const current = tables();
    const tasks = new FakeTaskBridge();
    const seats = [{ id: "reviewer", label: "评审组", participantKind: "any" }];
    let roleMembers: RoleMember[] = [
      {
        assigneeKind: "user",
        assigneeId: "workflow-member",
        status: "claimed",
      },
      { assigneeKind: "user", assigneeId: "flow-member", status: "assigned" },
    ];
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      tasks: () => tasks,
      roles: () => ({
        config: () => ({ seats }),
        members: (_workspaceId: string, seatId: string) =>
          seatId === "reviewer" ? roleMembers : [],
      }),
    });
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: roleFixture("role-node"),
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "角色快照",
    });
    expect(instance.roleSnapshot.reviewer).toMatchObject({
      roleId: "reviewer",
      name: "评审组",
      members: [
        { kind: "user", id: "workflow-member" },
        { kind: "user", id: "flow-member" },
      ],
    });

    // 角色从项目下线、成员指派清空；已启动实例继续用启动时快照。
    seats.splice(0, seats.length);
    roleMembers = [];
    const decided = await service.decideApproval(
      {
        kind: "user",
        id: "flow-member",
        name: "Flow Member",
        workspaceRole: "member",
      },
      {
        instanceId: instance.id,
        nodeId: "review",
        decision: "approved",
      },
    );
    expect(decided.nodes.review?.status).toBe("completed");

    // 快照之后新加入的成员不能操作旧实例。
    await expect(
      service.submitDeliverable(
        {
          kind: "user",
          id: "workflow-admin",
          name: "Admin",
          workspaceRole: "member",
        },
        {
          instanceId: decided.id,
          nodeId: "design",
          requirementKey: "design-report",
          type: "text",
          value: "后加入的角色成员不能操作旧实例。",
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    // 快照成员仍可在旧实例完成节点。
    await service.submitDeliverable(
      {
        kind: "user",
        id: "flow-member",
        name: "Flow Member",
        workspaceRole: "member",
      },
      {
        instanceId: decided.id,
        nodeId: "design",
        requirementKey: "design-report",
        type: "text",
        value: "快照成员继续完成旧实例。",
      },
    );
    const completed = await service.completeNode(
      {
        kind: "user",
        id: "flow-member",
        name: "Flow Member",
        workspaceRole: "member",
      },
      { instanceId: decided.id, nodeId: "design" },
    );
    expect(completed.nodes.design?.status).toBe("completed");

    // 角色已下线时不能启动新实例。
    await expect(
      service.startInstance(member, {
        workspaceId: "main",
        definitionId: definition.id,
        title: "角色已下线的新实例",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("pins a role node to a concrete executor at instance creation", async () => {
    const { service, tasks } = roleHarness(roleMembers);
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: roleFixture("role-node-pinned"),
    });
    const instance = await service.startInstance(member, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "角色节点指定执行人",
      assignees: {
        review: { kind: "user", id: "flow-owner", name: "Owner" },
        design: { kind: "agent", id: "tm-tester", name: "柯真 01 测试" },
      },
    });

    expect(instance.nodes.review?.approvals["review:reviewer"]).toMatchObject({
      approver: { kind: "user", id: "flow-owner", name: "Owner" },
    });
    expect(instance.nodes.design?.receiverOverride).toMatchObject({
      type: "agent",
      id: "tm-tester",
      name: "柯真 01 测试",
    });
    expect(tasks.records.get(instance.nodes.review!.taskIds[0]!)).toMatchObject(
      {
        receiverType: "human",
        receiverId: "flow-owner",
        receiverName: "Owner",
      },
    );

    // 下游角色节点指定执行人后，节点任务直接落到那个执行人身上。
    const decided = await service.decideApproval(owner, {
      instanceId: instance.id,
      nodeId: "review",
      decision: "approved",
    });
    expect(tasks.records.get(decided.nodes.design!.taskIds[0]!)).toMatchObject({
      receiverType: "agent",
      receiverId: "tm-tester",
      receiverName: "柯真 01 测试",
    });

    // 未在模板里的节点不允许指定执行人。
    await expect(
      service.startInstance(member, {
        workspaceId: "main",
        definitionId: definition.id,
        title: "非法指定",
        assignees: { missing: { kind: "user", id: "flow-owner" } },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects role references the project does not maintain", async () => {
    const current = tables();
    const service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
      roles: () => ({
        config: () => ({ seats: [] }),
      }),
    });
    const definition = await service.importDefinition(owner, {
      workspaceId: "main",
      sourceMd: roleFixture("role-node-missing"),
    });
    await expect(
      service.startInstance(member, {
        workspaceId: "main",
        definitionId: definition.id,
        title: "角色不存在",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("reviewer"),
    });
  });
});

describe("workflow routes", () => {
  let current: ReturnType<typeof tables>;
  let service: WorkflowService;
  let routes: WebRouteLike[];

  beforeEach(async () => {
    current = tables();
    service = new WorkflowService(current, {
      now: () => new Date(timestamp),
      team,
    });
    routes = createWorkflowRoutes(service, team);
  });

  function route(path: string): WebRouteLike {
    const found = routes.find((item) => item.path === path);
    if (found === undefined) throw new Error(`missing route ${path}`);
    return found;
  }

  it("requires same origin and a valid bearer token", async () => {
    const cross = await call(
      route("/api/collab/workflow/instances"),
      fakeRequest("GET", "/api/collab/workflow/instances?workspaceId=main", {
        token: "owner",
        origin: "https://evil.example",
      }),
    );
    expect(cross.status).toBe(403);
    const unauthorized = await call(
      route("/api/collab/workflow/instances"),
      fakeRequest("GET", "/api/collab/workflow/instances?workspaceId=main", {
        token: "bad",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(unauthorized.status).toBe(401);
  });

  it("rejects a member of another workspace", async () => {
    const response = await call(
      route("/api/collab/workflow/instances"),
      fakeRequest("GET", "/api/collab/workflow/instances?workspaceId=other", {
        token: "owner",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lists instances only inside the requested workspace", async () => {
    const definition = await importedFixture(service, "product-delivery.md");
    await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "A",
      sessionId: "s-a",
    });
    await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "B",
      sessionId: "s-b",
    });
    const response = await call(
      route("/api/collab/workflow/instances"),
      fakeRequest(
        "GET",
        "/api/collab/workflow/instances?workspaceId=main&sessionId=s-a",
        { token: "owner", origin: "http://127.0.0.1:33117" },
      ),
    );
    expect(response.status).toBe(200);
    const payload = response.json() as { instances: WorkflowInstance[] };
    expect(payload.instances).toHaveLength(1);
    expect(payload.instances[0]!.title).toBe("A");
  });

  it("returns the referenced definition with an instance detail", async () => {
    const definition = await importedFixture(service, "product-delivery.md");
    const instance = await service.startInstance(owner, {
      workspaceId: "main",
      definitionId: definition.id,
      title: "Detail",
    });
    const response = await call(
      route("/api/collab/workflow/instances/detail"),
      fakeRequest(
        "GET",
        `/api/collab/workflow/instances/detail?workspaceId=main&instanceId=${instance.id}`,
        { token: "owner", origin: "http://127.0.0.1:33117" },
      ),
    );
    expect(response.status).toBe(200);
    const payload = response.json() as { definition?: WorkflowDefinition };
    expect(payload.definition?.id).toBe(definition.id);
    expect(payload.definition?.graph.nodes.length).toBeGreaterThan(0);
  });

  it("blocks non-manager import", async () => {
    const sourceMd = await readFile(
      new URL(
        "../../../docs/fixtures/workflow/product-delivery.md",
        import.meta.url,
      ),
      "utf8",
    );
    const response = await call(
      route("/api/collab/workflow/definitions/import"),
      fakeRequest("POST", "/api/collab/workflow/definitions/import", {
        token: "member",
        origin: "http://127.0.0.1:33117",
        body: { workspaceId: "main", sourceMd },
      }),
    );
    expect(response.status).toBe(403);
    expect(current.definitions.size).toBe(0);
  });
});

describe("workflow apply", () => {
  it("registers routes, command, and tool", async () => {
    const current = tables();
    const routes: WebRouteLike[] = [];
    const registered: unknown[] = [];
    const provided: string[] = [];
    const ctx = {
      storageDomain: { open: async () => fakeDomain(current) },
      commands: {
        register: (definition: unknown) => registered.push(definition),
      },
      tools: { register: (definition: unknown) => registered.push(definition) },
      webServer: { register: (route: WebRouteLike) => routes.push(route) },
      provide: (key: string) => provided.push(key),
      effect: (operation: () => () => void) => operation()(),
      inject: (
        _keys: readonly string[],
        callback: (value: unknown) => void,
      ) => {
        callback({
          collabTeam: team(),
          collabContext: {
            registerAdapter: () => () => undefined,
          },
          effect: (operation: () => () => void) => operation()(),
        });
      },
      get: () => team(),
    };
    await apply(ctx as unknown as Parameters<typeof apply>[0]);
    expect(provided).toEqual(["collabWorkflow"]);
    expect(routes).toHaveLength(22);
    expect(registered).toHaveLength(2);
    const tool = registered.find(
      (item) => (item as { name?: string }).name === "collab_workflow",
    ) as
      | {
          output: {
            schema: { type: string };
            render(
              args: unknown,
              value: string,
            ): Array<{ type: "text"; text: string }>;
          };
        }
      | undefined;
    expect(tool?.output).toMatchObject({ schema: { type: "string" } });
    expect(tool?.output.render({}, "ok")).toEqual([
      { type: "text", text: "ok" },
    ]);
  });
});
