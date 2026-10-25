import type { WorkflowGraph, WorkflowGraphNode } from "@pluginmax/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveWorkflowInstanceStatus,
  evaluateWorkflowExpression,
  initializeWorkflowRuntime,
  transitionWorkflowNode,
  WorkflowExpressionError,
} from "./workflow-runtime.js";

function node(
  id: string,
  type: WorkflowGraphNode["type"] = "task",
  overrides: Partial<WorkflowGraphNode> = {},
): WorkflowGraphNode {
  return {
    id,
    name: id,
    type,
    executor: { kind: "user", id: "local-admin" },
    description: "",
    approvers: type === "approval" ? [{ kind: "user", id: "local-admin" }] : [],
    approvalPolicy: "all",
    autoDispatch: false,
    start: false,
    maxAttempts: 1,
    timeoutSeconds: 300,
    ...overrides,
  };
}

function graph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    key: "test",
    version: 1,
    name: "Test",
    description: "",
    nodes: [],
    edges: [],
    startNodeIds: [],
    warnings: [],
    ...overrides,
  };
}

describe("workflow expression", () => {
  it("evaluates deterministic comparisons without eval", () => {
    expect(
      evaluateWorkflowExpression(
        '(complexity >= 8 && security == true) || priority == "urgent"',
        { complexity: 9, security: true, priority: "normal" },
      ),
    ).toBe(true);
    expect(() => evaluateWorkflowExpression("process.exit(1)", {})).toThrow(
      WorkflowExpressionError,
    );
    expect(() => evaluateWorkflowExpression("missing >= 1", {})).toThrow(
      /Unknown workflow variable/,
    );
  });
});

describe("workflow runtime", () => {
  it("selects one deterministic conditional branch and skips the other", () => {
    const definition = graph({
      nodes: [
        node("start", "decision"),
        node("complex"),
        node("standard"),
        node("join", "service"),
      ],
      edges: [
        {
          id: "e1",
          from: "start",
          to: "complex",
          condition: "complexity >= 8",
        },
        { id: "e2", from: "start", to: "standard", default: true },
        { id: "e3", from: "complex", to: "join" },
        { id: "e4", from: "standard", to: "join" },
      ],
      startNodeIds: ["start"],
    });
    const runtime = initializeWorkflowRuntime(definition, { complexity: 9 });
    const result = transitionWorkflowNode({
      graph: definition,
      runtime,
      nodeId: "start",
      actorId: "system",
    });
    expect(
      result.runtime.nodes.find((candidate) => candidate.nodeId === "complex")
        ?.status,
    ).toBe("ready");
    expect(
      result.runtime.nodes.find((candidate) => candidate.nodeId === "standard")
        ?.status,
    ).toBe("skipped");
    expect(
      result.runtime.edges.find((candidate) => candidate.edgeId === "e1")
        ?.status,
    ).toBe("selected");
  });

  it("blocks a branch when a runtime variable is missing", () => {
    const definition = graph({
      nodes: [node("start", "decision"), node("end", "service")],
      edges: [
        { id: "route", from: "start", to: "end", condition: "missing > 1" },
      ],
      startNodeIds: ["start"],
    });
    const result = transitionWorkflowNode({
      graph: definition,
      runtime: initializeWorkflowRuntime(definition),
      nodeId: "start",
      actorId: "system",
    });
    expect(result.blockedReason).toContain("Unknown workflow variable");
    expect(deriveWorkflowInstanceStatus(result.runtime)).toBe("blocked");
  });

  it("enforces a controlled loop limit and records visits", () => {
    const definition = graph({
      nodes: [
        node("work", "task", { loopLimit: 2 }),
        node("check", "decision"),
      ],
      edges: [
        { id: "forward", from: "work", to: "check" },
        {
          id: "retry",
          from: "check",
          to: "work",
          breakCondition: "visits.work >= 3",
        },
      ],
      startNodeIds: ["work"],
    });
    const first = transitionWorkflowNode({
      graph: definition,
      runtime: initializeWorkflowRuntime(definition, {}),
      nodeId: "work",
      actorId: "local-admin",
    });
    const second = transitionWorkflowNode({
      graph: definition,
      runtime: first.runtime,
      nodeId: "check",
      actorId: "local-admin",
    });
    expect(second.blockedReason).toBeNull();
    const third = transitionWorkflowNode({
      graph: definition,
      runtime: second.runtime,
      nodeId: "work",
      actorId: "local-admin",
    });
    const fourth = transitionWorkflowNode({
      graph: definition,
      runtime: third.runtime,
      nodeId: "check",
      actorId: "local-admin",
    });
    expect(fourth.blockedReason).toContain("循环次数已达到上限");
    expect(deriveWorkflowInstanceStatus(fourth.runtime)).toBe("blocked");
    expect(
      fourth.runtime.nodes.find((candidate) => candidate.nodeId === "work")
        ?.visits,
    ).toBe(2);
  });

  it("supports all/any approval rejection semantics", () => {
    const definition = graph({
      nodes: [node("approve", "approval"), node("rejected", "service")],
      edges: [
        { id: "no", from: "approve", to: "rejected", result: "rejected" },
      ],
      startNodeIds: ["approve"],
    });
    const runtime = initializeWorkflowRuntime(definition, {});
    const result = transitionWorkflowNode({
      graph: definition,
      runtime,
      nodeId: "approve",
      actorId: "local-admin",
      approvalResult: "rejected",
    });
    expect(
      result.runtime.nodes.find((candidate) => candidate.nodeId === "approve")
        ?.status,
    ).toBe("rejected");
    expect(
      result.runtime.nodes.find((candidate) => candidate.nodeId === "rejected")
        ?.status,
    ).toBe("ready");
  });

  it("reactivates a branch that was skipped by an earlier loop iteration", () => {
    const definition = graph({
      nodes: [
        node("work", "service", { loopLimit: 3, start: true }),
        node("check", "decision"),
        node("exit", "service"),
      ],
      edges: [
        { id: "forward", from: "work", to: "check" },
        {
          id: "retry",
          from: "check",
          to: "work",
          condition: "visits.work < 3",
          breakCondition: "visits.work >= 3",
        },
        { id: "exit", from: "check", to: "exit", default: true },
      ],
      startNodeIds: ["work"],
    });
    let runtime = initializeWorkflowRuntime(definition, {});
    for (let iteration = 0; iteration < 3; iteration += 1) {
      runtime = transitionWorkflowNode({
        graph: definition,
        runtime,
        nodeId: "work",
        actorId: "local-admin",
      }).runtime;
      runtime = transitionWorkflowNode({
        graph: definition,
        runtime,
        nodeId: "check",
        actorId: "system",
      }).runtime;
    }
    expect(
      runtime.nodes.find((candidate) => candidate.nodeId === "work")?.visits,
    ).toBe(3);
    expect(
      runtime.nodes.find((candidate) => candidate.nodeId === "exit")?.status,
    ).toBe("ready");
  });
});
