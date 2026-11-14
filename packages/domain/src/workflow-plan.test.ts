import { describe, expect, it } from "vitest";
import type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import {
  assertValidWorkflowPlanGraph,
  diffWorkflowPlanGraphs,
  validateWorkflowPlanGraph,
  WorkflowPlanGraphError,
} from "./workflow-plan.js";

const settings: WorkflowPlanSettings = {
  maxNodes: 10,
  maxDepth: 8,
  maxOutDegree: 4,
  maxConcurrency: 3,
};

const node = (id: string, start = false): WorkflowGraphNode => ({
  id,
  name: id,
  type: "task",
  executor: {
    kind: "agent",
    id: "00000000-0000-4000-8000-000000000001",
  },
  description: `${id} description`,
  acceptance: [`${id} acceptance`],
  approvers: [],
  approvalPolicy: "all",
  autoDispatch: true,
  start,
  maxAttempts: 1,
  timeoutSeconds: 300,
});

function graph(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraph["edges"] = [],
  startNodeIds: string[] = nodes[0] === undefined ? [] : [nodes[0].id],
): WorkflowGraph {
  return {
    key: "plan:test",
    version: 1,
    name: "Plan test",
    description: "Plan test graph",
    nodes,
    edges,
    startNodeIds,
    warnings: [],
  };
}

describe("workflow plan graph validation", () => {
  it("accepts a deterministic AND-join DAG", () => {
    const result = assertValidWorkflowPlanGraph(
      graph(
        [node("a", true), node("b"), node("c")],
        [
          { id: "ab", from: "a", to: "b" },
          { id: "ac", from: "a", to: "c" },
          { id: "bc", from: "b", to: "c" },
        ],
      ),
      settings,
    );
    expect(result.topologicalNodeIds).toEqual(["a", "b", "c"]);
  });

  it.each([
    [
      graph(
        [node("a", true), node("b")],
        [
          { id: "ab", from: "a", to: "b" },
          { id: "ba", from: "b", to: "a" },
        ],
      ),
      "cycle_detected",
    ],
    [
      graph([node("a", true), node("b", true)]),
      "multiple_components",
    ],
    [graph([node("a", true), node("b")], [], ["a"]), "node_unreachable"],
    [
      graph(
        [node("a", true), node("b")],
        [{ id: "ab", from: "a", to: "b", condition: "x > 0" }],
      ),
      "join_mode_not_and",
    ],
    [
      graph([node("a", true)], [{ id: "aa", from: "a", to: "a" }]),
      "self_dependency",
    ],
  ])("rejects invalid dependency topology", (candidate, code) => {
    expect(
      validateWorkflowPlanGraph(candidate, settings).issues.map(
        (issue) => issue.code,
      ),
    ).toContain(code);
  });

  it("rejects duplicate nodes and depth limits", () => {
    const candidate = graph(
      [node("a", true), node("b"), node("c"), node("c")],
      [
        { id: "ab", from: "a", to: "b" },
        { id: "bc", from: "b", to: "c" },
      ],
    );
    const issues = validateWorkflowPlanGraph(candidate, {
      ...settings,
      maxDepth: 1,
    }).issues.map((issue) => issue.code);
    expect(issues).toContain("node_id_duplicate");
    expect(issues).toContain("depth_limit_exceeded");
  });

  it("throws a typed graph error before confirmation", () => {
    expect(() =>
      assertValidWorkflowPlanGraph(graph([node("a")], [], []), settings),
    ).toThrow(WorkflowPlanGraphError);
  });

  it("computes immutable-version node and edge diffs", () => {
    const before = graph(
      [node("a", true), node("b")],
      [{ id: "ab", from: "a", to: "b", label: "old" }],
    );
    const changedB = { ...node("b"), description: "changed" };
    const after = graph(
      [node("a", true), changedB, node("c")],
      [{ id: "ab", from: "a", to: "b", label: "new" }],
    );
    const diff = diffWorkflowPlanGraphs(
      "00000000-0000-4000-8000-000000000100",
      1,
      2,
      before,
      after,
    );
    expect(diff.nodes.map((item) => item.nodeId)).toEqual(["b", "c"]);
    expect(diff.changedEdgeIds).toEqual(["ab"]);
  });
});
