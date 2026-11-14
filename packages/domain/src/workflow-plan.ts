import { createHash } from "node:crypto";
import type {
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowPlanDiff,
  WorkflowPlanSettings,
  WorkflowPlanValidationIssue,
  WorkflowPlanValidationResult,
} from "@pluginmax/contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkflowPlanGraphError extends Error {
  constructor(
    readonly issues: readonly WorkflowPlanValidationIssue[],
    message = "Workflow plan graph is invalid",
  ) {
    super(message);
    this.name = "WorkflowPlanGraphError";
  }
}

export function workflowPlanGraphDigest(graph: WorkflowGraph): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(graph)))
    .digest("hex");
}

export function validateWorkflowPlanGraph(
  graph: WorkflowGraph,
  settings: WorkflowPlanSettings,
): WorkflowPlanValidationResult {
  const issues: WorkflowPlanValidationIssue[] = [];
  const nodes = new Map<string, WorkflowGraphNode>();
  const duplicateIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) duplicateIds.add(node.id);
    nodes.set(node.id, node);
  }
  for (const nodeId of duplicateIds) {
    issues.push({
      code: "node_id_duplicate",
      message: `Node id ${nodeId} is duplicated`,
      nodeId,
    });
  }
  if (graph.nodes.length === 0) {
    issues.push({
      code: "nodes_empty",
      message: "A plan must contain at least one node",
    });
  }
  if (graph.nodes.length > settings.maxNodes) {
    issues.push({
      code: "node_limit_exceeded",
      message: `Plan has ${graph.nodes.length} nodes; limit is ${settings.maxNodes}`,
    });
  }

  const outgoing = new Map<string, WorkflowGraphEdge[]>();
  const incoming = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      issues.push({
        code: "dependency_missing",
        message: `Edge ${edge.id} references a missing node`,
        edgeId: edge.id,
      });
      continue;
    }
    if (edge.from === edge.to) {
      issues.push({
        code: "self_dependency",
        message: `Edge ${edge.id} declares a self dependency`,
        edgeId: edge.id,
      });
    }
    if (
      edge.condition !== undefined ||
      edge.result !== undefined ||
      edge.default === true ||
      edge.breakCondition !== undefined
    ) {
      issues.push({
        code: "join_mode_not_and",
        message: "Router plans only support unconditional AND-join edges",
        edgeId: edge.id,
      });
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }

  for (const node of graph.nodes) {
    if (node.type !== "task") {
      issues.push({
        code: "node_type_unsupported",
        message: "M3 plan nodes must materialize as Task nodes",
        nodeId: node.id,
      });
    }
    if (node.name.trim() === "") {
      issues.push({
        code: "node_name_empty",
        message: "Node name must not be empty",
        nodeId: node.id,
      });
    }
    if (node.description.trim() === "") {
      issues.push({
        code: "node_description_empty",
        message: "Node description must not be empty",
        nodeId: node.id,
      });
    }
    if (
      node.type === "task" &&
      (node.acceptance === undefined || node.acceptance.length === 0)
    ) {
      issues.push({
        code: "node_acceptance_empty",
        message: "Task nodes must declare at least one acceptance item",
        nodeId: node.id,
      });
    }
    if (
      node.type === "task" &&
      (node.executor.kind !== "agent" ||
        !UUID_PATTERN.test(node.executor.id))
    ) {
      issues.push({
        code: "receiver_invalid",
        message:
          "Task nodes must use an AI Agent receiver with a valid UUID",
        nodeId: node.id,
      });
    }
    if ((outgoing.get(node.id)?.length ?? 0) > settings.maxOutDegree) {
      issues.push({
        code: "out_degree_limit_exceeded",
        message: `Node exceeds the maximum out-degree ${settings.maxOutDegree}`,
        nodeId: node.id,
      });
    }
  }

  const startNodeIds = [
    ...new Set([
      ...graph.startNodeIds,
      ...graph.nodes.filter((node) => node.start).map((node) => node.id),
    ]),
  ];
  if (startNodeIds.length === 0) {
    issues.push({
      code: "start_missing",
      message: "A plan must declare at least one start node",
    });
  }
  for (const nodeId of startNodeIds) {
    if (!nodes.has(nodeId)) {
      issues.push({
        code: "start_node_missing",
        message: `Start node ${nodeId} does not exist`,
        nodeId,
      });
    }
  }

  const reachable = new Set<string>();
  const queue = startNodeIds.filter((nodeId) => nodes.has(nodeId));
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (!reachable.has(edge.to)) queue.push(edge.to);
    }
  }
  for (const node of graph.nodes) {
    if (startNodeIds.length > 0 && !reachable.has(node.id)) {
      issues.push({
        code: "node_unreachable",
        message: "Every node must be reachable from a start node",
        nodeId: node.id,
      });
    }
  }

  if (
    countWeakComponents(graph) > 1 &&
    graph.nodes.length > 1
  ) {
    issues.push({
      code: "multiple_components",
      message: "A plan graph must be a single connected component",
    });
  }

  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (indegree.has(edge.to)) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }
  const initialReady = [...indegree.values()].filter((count) => count === 0);
  if (initialReady.length > settings.maxConcurrency) {
    issues.push({
      code: "concurrency_limit_exceeded",
      message: `Initial concurrency ${initialReady.length} exceeds limit ${settings.maxConcurrency}`,
    });
  }

  const topologicalNodeIds: string[] = [];
  const remaining = new Map(indegree);
  const ready = graph.nodes
    .filter((node) => remaining.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    topologicalNodeIds.push(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      const next = (remaining.get(edge.to) ?? 0) - 1;
      remaining.set(edge.to, next);
      if (next === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }
  if (topologicalNodeIds.length !== graph.nodes.length) {
    issues.push({
      code: "cycle_detected",
      message: "Plan dependencies must not contain a cycle",
    });
  }

  const depth = new Map<string, number>();
  for (const nodeId of topologicalNodeIds) {
    const current = depth.get(nodeId) ?? 0;
    for (const edge of outgoing.get(nodeId) ?? []) {
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, current + 1));
    }
  }
  const maximumDepth = Math.max(0, ...depth.values());
  if (maximumDepth > settings.maxDepth) {
    issues.push({
      code: "depth_limit_exceeded",
      message: `Plan depth ${maximumDepth} exceeds limit ${settings.maxDepth}`,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    topologicalNodeIds:
      topologicalNodeIds.length === graph.nodes.length
        ? topologicalNodeIds
        : [],
  };
}

export function assertValidWorkflowPlanGraph(
  graph: WorkflowGraph,
  settings: WorkflowPlanSettings,
): WorkflowPlanValidationResult {
  const result = validateWorkflowPlanGraph(graph, settings);
  if (!result.valid) {
    throw new WorkflowPlanGraphError(result.issues);
  }
  return result;
}

export function diffWorkflowPlanGraphs(
  planId: string,
  fromVersion: number,
  toVersion: number,
  before: WorkflowGraph,
  after: WorkflowGraph,
): WorkflowPlanDiff {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const nodeIds = [
    ...new Set([...beforeNodes.keys(), ...afterNodes.keys()]),
  ].sort();
  const nodes = nodeIds
    .map((nodeId) => {
      const previous = beforeNodes.get(nodeId) ?? null;
      const next = afterNodes.get(nodeId) ?? null;
      if (
        previous !== null &&
        next !== null &&
        JSON.stringify(canonicalValue(previous)) ===
          JSON.stringify(canonicalValue(next))
      ) {
        return undefined;
      }
      return { nodeId, before: previous, after: next };
    })
    .filter((change) => change !== undefined);
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const addedEdgeIds = [...afterEdges.keys()]
    .filter((edgeId) => !beforeEdges.has(edgeId))
    .sort();
  const removedEdgeIds = [...beforeEdges.keys()]
    .filter((edgeId) => !afterEdges.has(edgeId))
    .sort();
  const changedEdgeIds = [...afterEdges.keys()]
    .filter((edgeId) => {
      const previous = beforeEdges.get(edgeId);
      const next = afterEdges.get(edgeId);
      return (
        previous !== undefined &&
        next !== undefined &&
        JSON.stringify(canonicalValue(previous)) !==
          JSON.stringify(canonicalValue(next))
      );
    })
    .sort();
  return {
    planId,
    fromVersion,
    toVersion,
    nodes,
    addedEdgeIds,
    removedEdgeIds,
    changedEdgeIds,
  };
}

function countWeakComponents(graph: WorkflowGraph): number {
  const adjacency = new Map<string, Set<string>>(
    graph.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const visited = new Set<string>();
  let components = 0;
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    components += 1;
    const stack = [node.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
  }
  return components;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
