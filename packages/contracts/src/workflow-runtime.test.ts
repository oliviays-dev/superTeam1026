import { describe, expect, it } from "vitest";
import {
  completeWorkflowNodeInputSchema,
  cosignWorkflowApprovalInputSchema,
  createProjectMemberInputSchema,
  decideWorkflowApprovalInputSchema,
  retryWorkflowNodeInputSchema,
  runInputSnapshotSchema,
  startWorkflowInputSchema,
  transferWorkflowApprovalInputSchema,
  workflowAuditQuerySchema,
  workflowGraphNodeSchema,
  workflowRuntimeNodeSchema,
} from "./index.js";

describe("workflow runtime API contracts", () => {
  it("keeps workflow start context deterministic and scalar-only", () => {
    expect(
      startWorkflowInputSchema.parse({
        title: "Release",
        context: { complexity: 8, security: true, owner: "local-admin" },
      }),
    ).toEqual({
      title: "Release",
      context: { complexity: 8, security: true, owner: "local-admin" },
    });
    expect(() =>
      startWorkflowInputSchema.parse({
        title: "Release",
        context: { nested: { invalid: true } },
      }),
    ).toThrow();
  });

  it("requires explicit approval and retry commands", () => {
    expect(
      decideWorkflowApprovalInputSchema.parse({
        nodeId: "review",
        decision: "reject",
        note: "missing evidence",
      }),
    ).toMatchObject({ decision: "reject" });
    expect(() =>
      decideWorkflowApprovalInputSchema.parse({
        nodeId: "review",
        decision: "maybe",
      }),
    ).toThrow();
    expect(retryWorkflowNodeInputSchema.parse({ nodeId: "agent" })).toEqual({
      nodeId: "agent",
      reason: "",
    });
    expect(
      completeWorkflowNodeInputSchema.parse({ nodeId: "service" }),
    ).toEqual({ nodeId: "service", output: "" });
  });

  it("exposes runtime reliability metadata on graph nodes and runs", () => {
    const node = workflowGraphNodeSchema.parse({
      id: "agent",
      name: "Agent",
      type: "task",
      executor: { kind: "agent", id: "agent-id" },
      description: "",
      approvers: [],
      approvalPolicy: "all",
      autoDispatch: true,
      maxAttempts: 3,
      timeoutSeconds: 30,
    });
    expect(node.maxAttempts).toBe(3);
    expect(node.timeoutSeconds).toBe(30);
    expect(node.start).toBe(false);
    expect(node.retryBackoffSeconds).toBeUndefined();

    const snapshot = runInputSnapshotSchema.parse({
      taskTitle: "Agent",
      taskDescription: "Run the workflow node",
      acceptance: ["Return evidence"],
      instruction: "Run",
      agentName: "Fake Agent",
      runtimeKind: "fake",
      runtimeOptions: { fault: "timeout" },
    });
    expect(snapshot.runtimeOptions?.fault).toBe("timeout");
  });

  it("validates approval governance and audit query contracts", () => {
    expect(
      transferWorkflowApprovalInputSchema.parse({
        nodeId: "review",
        targetActorId: "reviewer-2",
      }),
    ).toEqual({
      nodeId: "review",
      targetActorId: "reviewer-2",
      note: "",
    });
    expect(
      cosignWorkflowApprovalInputSchema.parse({
        nodeId: "review",
        approvers: [{ kind: "user", id: "security-reviewer" }],
      }),
    ).toMatchObject({ nodeId: "review", note: "" });
    expect(() =>
      cosignWorkflowApprovalInputSchema.parse({
        nodeId: "review",
        approvers: [],
      }),
    ).toThrow();
    expect(
      workflowAuditQuerySchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        failuresOnly: "true",
      }),
    ).toMatchObject({
      failuresOnly: true,
      page: 1,
      pageSize: 20,
    });
  });

  it("accepts an explicit actor only for human project members", () => {
    expect(
      createProjectMemberInputSchema.parse({
        kind: "human",
        actorId: "reviewer-2",
        name: "Reviewer 2",
      }),
    ).toMatchObject({ actorId: "reviewer-2" });
    expect(() =>
      createProjectMemberInputSchema.parse({
        kind: "agent",
        actorId: "invalid-agent-actor",
        agentId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("rejects unknown runtime node statuses", () => {
    expect(() =>
      workflowRuntimeNodeSchema.parse({
        nodeId: "node",
        name: "Node",
        type: "service",
        status: "mystery",
        visits: 1,
        attempt: 0,
        approvalPolicy: "all",
        selectedEdgeId: null,
        output: null,
        error: null,
        taskId: null,
        runId: null,
        childInstanceId: null,
        startedAt: null,
        endedAt: null,
        timeoutAt: null,
      }),
    ).toThrow();
  });
});
