import { describe, expect, it } from "vitest";
import {
  completeWorkflowNodeInputSchema,
  decideWorkflowApprovalInputSchema,
  retryWorkflowNodeInputSchema,
  runInputSnapshotSchema,
  startWorkflowInputSchema,
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
