import type {
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowRuntimeEdge,
  WorkflowRuntimeNode,
  WorkflowRuntimeState,
} from "@pluginmax/contracts";

type RuntimeScalar = string | number | boolean | null;
type RuntimeContext = Record<string, RuntimeScalar>;

export class WorkflowExpressionError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at character ${position + 1}`);
    this.name = "WorkflowExpressionError";
  }
}

type Token =
  | { readonly kind: "number"; readonly value: number; readonly at: number }
  | { readonly kind: "string"; readonly value: string; readonly at: number }
  | { readonly kind: "boolean"; readonly value: boolean; readonly at: number }
  | { readonly kind: "null"; readonly at: number }
  | { readonly kind: "identifier"; readonly value: string; readonly at: number }
  | {
      readonly kind: "operator";
      readonly value: "&&" | "||" | "!" | "==" | "!=" | ">=" | "<=" | ">" | "<";
      readonly at: number;
    }
  | { readonly kind: "paren"; readonly value: "(" | ")"; readonly at: number }
  | { readonly kind: "eof"; readonly at: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const at = index;
    const pair = source.slice(index, index + 2);
    if (["&&", "||", "==", "!=", ">=", "<="].includes(pair)) {
      tokens.push({
        kind: "operator",
        value: pair as Extract<Token, { kind: "operator" }>["value"],
        at,
      });
      index += 2;
      continue;
    }
    if (["!", ">", "<"].includes(char)) {
      tokens.push({
        kind: "operator",
        value: char as Extract<Token, { kind: "operator" }>["value"],
        at,
      });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char, at });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
          if (index >= source.length) {
            throw new WorkflowExpressionError("Unterminated string", at);
          }
          const escaped = source[index]!;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else {
          value += source[index];
        }
        index += 1;
      }
      if (source[index] !== quote) {
        throw new WorkflowExpressionError("Unterminated string", at);
      }
      tokens.push({ kind: "string", value, at });
      index += 1;
      continue;
    }
    if (/\d/.test(char)) {
      const match = /^(?:\d+\.\d+|\d+)/.exec(source.slice(index));
      if (match === null)
        throw new WorkflowExpressionError("Invalid number", at);
      tokens.push({ kind: "number", value: Number(match[0]), at });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(index));
      if (match === null)
        throw new WorkflowExpressionError("Invalid identifier", at);
      const raw = match[0];
      if (raw === "true" || raw === "false") {
        tokens.push({ kind: "boolean", value: raw === "true", at });
      } else if (raw === "null") {
        tokens.push({ kind: "null", at });
      } else {
        tokens.push({ kind: "identifier", value: raw, at });
      }
      index += raw.length;
      continue;
    }
    throw new WorkflowExpressionError(`Unexpected character ${char}`, at);
  }
  tokens.push({ kind: "eof", at: source.length });
  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly context: RuntimeContext,
    private readonly mode: "evaluate" | "syntax" = "evaluate",
  ) {}

  parse(): boolean {
    const value = this.parseOr();
    const token = this.peek();
    if (token.kind !== "eof") {
      throw new WorkflowExpressionError("Unexpected token", token.at);
    }
    return this.requireBoolean(value, token.at);
  }

  private parseOr(): RuntimeScalar {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      const right = this.parseAnd();
      left = this.requireBoolean(left, 0) || this.requireBoolean(right, 0);
    }
    return left;
  }

  private parseAnd(): RuntimeScalar {
    let left = this.parseComparison();
    while (this.matchOperator("&&")) {
      const right = this.parseComparison();
      left = this.requireBoolean(left, 0) && this.requireBoolean(right, 0);
    }
    return left;
  }

  private parseComparison(): RuntimeScalar {
    const left = this.parseUnary();
    const token = this.peek();
    const operator =
      token.kind === "operator" &&
      (token.value === "==" ||
        token.value === "!=" ||
        token.value === ">=" ||
        token.value === "<=" ||
        token.value === ">" ||
        token.value === "<")
        ? token.value
        : undefined;
    if (operator !== undefined) {
      this.index += 1;
      const right = this.parseUnary();
      if (this.mode === "syntax") return true;
      return compare(left, right, operator, token.at);
    }
    return left;
  }

  private parseUnary(): RuntimeScalar {
    const token = this.peek();
    if (token.kind === "operator" && token.value === "!") {
      this.index += 1;
      return !this.requireBoolean(this.parseUnary(), token.at);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): RuntimeScalar {
    const token = this.peek();
    this.index += 1;
    if (
      token.kind === "number" ||
      token.kind === "string" ||
      token.kind === "boolean"
    ) {
      return token.value;
    }
    if (token.kind === "null") return null;
    if (token.kind === "identifier") {
      if (!(token.value in this.context)) {
        if (this.mode === "syntax") return null;
        throw new WorkflowExpressionError(
          `Unknown workflow variable ${token.value}`,
          token.at,
        );
      }
      return this.context[token.value] ?? null;
    }
    if (token.kind === "paren" && token.value === "(") {
      const value = this.parseOr();
      const closing = this.peek();
      if (closing.kind !== "paren" || closing.value !== ")") {
        throw new WorkflowExpressionError(
          "Expected closing parenthesis",
          closing.at,
        );
      }
      this.index += 1;
      return value;
    }
    throw new WorkflowExpressionError("Expected expression", token.at);
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private matchOperator(value: string): boolean {
    const token = this.peek();
    if (token.kind === "operator" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private requireBoolean(value: RuntimeScalar, position: number): boolean {
    if (this.mode === "syntax") return true;
    if (typeof value !== "boolean") {
      throw new WorkflowExpressionError(
        "Expression must evaluate to boolean",
        position,
      );
    }
    return value;
  }
}

function compare(
  left: RuntimeScalar,
  right: RuntimeScalar,
  operator: "==" | "!=" | ">=" | "<=" | ">" | "<",
  position: number,
): boolean {
  if (operator === "==" || operator === "!=") {
    const equal = left === right;
    return operator === "==" ? equal : !equal;
  }
  if (typeof left !== typeof right) {
    throw new WorkflowExpressionError(
      "Comparison operands have different types",
      position,
    );
  }
  if (typeof left !== "number" && typeof left !== "string") {
    throw new WorkflowExpressionError(
      "Ordered comparison requires numbers or strings",
      position,
    );
  }
  const rightValue = right as number | string;
  const leftValue = left as number | string;
  switch (operator) {
    case ">":
      return leftValue > rightValue;
    case "<":
      return leftValue < rightValue;
    case ">=":
      return leftValue >= rightValue;
    case "<=":
      return leftValue <= rightValue;
  }
}

export function evaluateWorkflowExpression(
  expression: string,
  context: Readonly<Record<string, RuntimeScalar>> = {},
): boolean {
  return new ExpressionParser(tokenize(expression), { ...context }).parse();
}

export function validateWorkflowExpressionSyntax(expression: string): void {
  new ExpressionParser(tokenize(expression), {}, "syntax").parse();
}

export interface WorkflowRuntimeTransition {
  readonly runtime: WorkflowRuntimeState;
  readonly audit: ReadonlyArray<{
    readonly kind:
      | "node.completed"
      | "node.rejected"
      | "node.blocked"
      | "node.skipped"
      | "branch.selected"
      | "branch.skipped";
    readonly nodeId: string;
    readonly edgeId?: string;
    readonly message: string;
  }>;
  readonly blockedReason: string | null;
}

export function initializeWorkflowRuntime(
  graph: WorkflowGraph,
  context: Readonly<Record<string, RuntimeScalar>> = {},
  now = new Date(),
): WorkflowRuntimeState {
  const nodes: WorkflowRuntimeNode[] = graph.nodes.map((node) => ({
    nodeId: node.id,
    name: node.name,
    type: node.type,
    status: graph.startNodeIds.includes(node.id) ? "ready" : "waiting",
    visits: graph.startNodeIds.includes(node.id) ? 1 : 0,
    attempt: 0,
    approvalPolicy: node.approvalPolicy,
    selectedEdgeId: null,
    output: null,
    error: null,
    taskId: null,
    runId: null,
    childInstanceId: null,
    startedAt: graph.startNodeIds.includes(node.id) ? now.toISOString() : null,
    endedAt: null,
    timeoutAt: null,
    failureCount: 0,
    nextRetryAt: null,
  }));
  const edges: WorkflowRuntimeEdge[] = graph.edges.map((edge) => ({
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    status: "pending",
    conditionResult: null,
  }));
  return {
    nodes,
    edges,
    context: { ...context },
  };
}

export function workflowRetryDelayMs(
  failureCount: number,
  overrideSeconds?: number,
): number {
  if (failureCount <= 0) return 0;
  const seconds =
    overrideSeconds === undefined
      ? Math.min(5 * 2 ** (failureCount - 1), 3_600)
      : overrideSeconds;
  return Math.max(0, seconds) * 1_000;
}

export function shiftWorkflowDeadlines(
  runtime: WorkflowRuntimeState,
  shiftMs: number,
): WorkflowRuntimeState {
  const shifted = cloneRuntime(runtime);
  if (shiftMs <= 0) return shifted;
  for (const node of shifted.nodes) {
    if (node.timeoutAt !== null && node.timeoutAt !== undefined) {
      node.timeoutAt = new Date(
        new Date(node.timeoutAt).getTime() + shiftMs,
      ).toISOString();
    }
    if (node.nextRetryAt !== null && node.nextRetryAt !== undefined) {
      node.nextRetryAt = new Date(
        new Date(node.nextRetryAt).getTime() + shiftMs,
      ).toISOString();
    }
  }
  return shifted;
}

export function workflowContextForNode(
  runtime: WorkflowRuntimeState,
  nodeId: string,
): RuntimeContext {
  const node = requireRuntimeNode(runtime, nodeId);
  const context: RuntimeContext = { ...runtime.context };
  for (const candidate of runtime.nodes) {
    context[`visits.${candidate.nodeId}`] = candidate.visits;
    context[`${candidate.nodeId}.attempts`] = candidate.visits;
  }
  context["visits"] = node.visits;
  context["attempts"] = node.visits;
  return context;
}

export function transitionWorkflowNode(input: {
  readonly graph: WorkflowGraph;
  readonly runtime: WorkflowRuntimeState;
  readonly nodeId: string;
  readonly actorId: string;
  readonly output?: string;
  readonly approvalResult?: "approved" | "rejected";
  readonly now?: Date;
}): WorkflowRuntimeTransition {
  const now = input.now ?? new Date();
  const runtime = cloneRuntime(input.runtime);
  const node = requireRuntimeNode(runtime, input.nodeId);
  const definition = requireGraphNode(input.graph, input.nodeId);
  const audit: Array<WorkflowRuntimeTransition["audit"][number]> = [];
  if (!["ready", "running", "waiting_approval"].includes(node.status)) {
    throw new Error(
      `node ${node.nodeId} cannot complete from status ${node.status}`,
    );
  }

  const rejected =
    definition.type === "approval" && input.approvalResult === "rejected";
  node.status = rejected ? "rejected" : "completed";
  node.output = input.output ?? null;
  node.error = rejected ? "审批已拒绝" : null;
  node.endedAt = now.toISOString();
  const context = workflowContextForNode(runtime, node.nodeId);
  const outgoing = input.graph.edges.filter(
    (edge) => edge.from === node.nodeId,
  );
  let selected: WorkflowGraphEdge[];
  try {
    selected = selectEdges(outgoing, definition, context, input.approvalResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    node.status = "blocked";
    node.error = `分支求值失败：${message}`;
    return {
      runtime,
      audit: [
        ...audit,
        {
          kind: "node.blocked",
          nodeId: node.nodeId,
          message: node.error,
        },
      ],
      blockedReason: node.error,
    };
  }
  if (rejected && selected.length === 0) {
    node.status = "blocked";
    node.error = "审批已拒绝，且没有配置拒绝分支";
    node.endedAt = now.toISOString();
    return {
      runtime,
      audit: [
        ...audit,
        {
          kind: "node.blocked",
          nodeId: node.nodeId,
          message: node.error,
        },
      ],
      blockedReason: node.error,
    };
  }
  const selectedIds = new Set(selected.map((edge) => edge.id));
  audit.push({
    kind: rejected ? "node.rejected" : "node.completed",
    nodeId: node.nodeId,
    message: rejected ? `节点“${node.name}”被拒绝` : `节点“${node.name}”已完成`,
  });

  let blockedReason: string | null = null;
  for (const edge of outgoing) {
    const edgeState = requireRuntimeEdge(runtime, edge.id);
    if (!selectedIds.has(edge.id)) {
      edgeState.status = "skipped";
      edgeState.conditionResult = false;
      audit.push({
        kind: "branch.skipped",
        nodeId: node.nodeId,
        edgeId: edge.id,
        message: `未选择分支 ${edge.from} -> ${edge.to}`,
      });
      continue;
    }
    if (edge.breakCondition !== undefined) {
      let shouldBreak: boolean;
      try {
        shouldBreak = evaluateWorkflowExpression(edge.breakCondition, context);
      } catch (error) {
        blockedReason = error instanceof Error ? error.message : String(error);
        node.status = "blocked";
        node.error = blockedReason;
        edgeState.status = "skipped";
        continue;
      }
      const target = requireRuntimeNode(runtime, edge.to);
      const targetDefinition = requireGraphNode(input.graph, edge.to);
      const nextVisits = target.visits + 1;
      const loopLimit = targetDefinition.loopLimit ?? definition.loopLimit;
      if (shouldBreak || (loopLimit !== undefined && nextVisits > loopLimit)) {
        target.status = "blocked";
        target.error = shouldBreak
          ? `循环退出条件已触发：${edge.breakCondition}`
          : `循环次数已达到上限 ${loopLimit}`;
        target.endedAt = now.toISOString();
        edgeState.status = "looped";
        blockedReason = target.error;
        audit.push({
          kind: "node.blocked",
          nodeId: target.nodeId,
          edgeId: edge.id,
          message: target.error,
        });
        continue;
      }
      edgeState.status = "looped";
      edgeState.conditionResult = true;
      reactivateLoopPath(runtime, input.graph, target.nodeId, node.nodeId, now);
      audit.push({
        kind: "branch.selected",
        nodeId: node.nodeId,
        edgeId: edge.id,
        message: `循环回到“${target.name}”，第 ${target.visits} 次进入`,
      });
      continue;
    }
    edgeState.status = "selected";
    edgeState.conditionResult =
      edge.condition === undefined
        ? null
        : evaluateWorkflowExpression(edge.condition, context);
    const target = requireRuntimeNode(runtime, edge.to);
    if (target.status === "skipped") {
      target.status = "waiting";
      target.output = null;
      target.error = null;
      target.startedAt = null;
      target.endedAt = null;
      target.timeoutAt = null;
      target.nextRetryAt = null;
    }
    audit.push({
      kind: "branch.selected",
      nodeId: node.nodeId,
      edgeId: edge.id,
      message: `选择分支 ${edge.from} -> ${edge.to}`,
    });
  }
  propagateReadiness(runtime, input.graph, now, audit);
  if (blockedReason !== null) {
    for (const candidate of runtime.nodes) {
      if (candidate.status === "ready") candidate.status = "waiting";
    }
  }
  return { runtime, audit, blockedReason };
}

export function deriveWorkflowInstanceStatus(
  runtime: WorkflowRuntimeState,
): "active" | "waiting" | "blocked" | "completed" | "failed" {
  if (runtime.nodes.some((node) => node.status === "failed")) return "failed";
  if (runtime.nodes.some((node) => node.status === "blocked")) return "blocked";
  if (
    runtime.nodes.length > 0 &&
    runtime.nodes.every(
      (node) =>
        node.status === "completed" ||
        node.status === "skipped" ||
        node.status === "rejected",
    )
  ) {
    return "completed";
  }
  if (
    runtime.nodes.some(
      (node) => node.status === "ready" || node.status === "running",
    )
  ) {
    return "active";
  }
  return "waiting";
}

export function skipUnselectedBranches(
  graph: WorkflowGraph,
  runtime: WorkflowRuntimeState,
  now = new Date(),
): ReadonlyArray<WorkflowRuntimeTransition["audit"][number]> {
  const audit: Array<WorkflowRuntimeTransition["audit"][number]> = [];
  propagateReadiness(runtime, graph, now, audit);
  return audit;
}

function selectEdges(
  outgoing: readonly WorkflowGraphEdge[],
  node: WorkflowGraphNode,
  context: RuntimeContext,
  approvalResult: "approved" | "rejected" | undefined,
): WorkflowGraphEdge[] {
  if (node.type === "approval" && approvalResult !== undefined) {
    const resultEdges = outgoing.filter(
      (edge) => edge.result === approvalResult,
    );
    if (resultEdges.length > 0) return resultEdges;
    if (approvalResult === "rejected") return [];
  }
  if (node.type === "decision") {
    for (const edge of outgoing) {
      if (
        edge.condition !== undefined &&
        evaluateWorkflowExpression(edge.condition, context)
      ) {
        return [edge];
      }
    }
    const fallback = outgoing.find((edge) => edge.default === true);
    if (fallback !== undefined) return [fallback];
    return outgoing.filter((edge) => edge.breakCondition !== undefined);
  }
  const conditional = outgoing.filter(
    (edge) =>
      edge.default !== true &&
      edge.result === undefined &&
      (edge.condition === undefined ||
        evaluateWorkflowExpression(edge.condition, context)),
  );
  if (conditional.length > 0) return conditional;
  const fallback = outgoing.find((edge) => edge.default === true);
  return fallback === undefined ? [] : [fallback];
}

function propagateReadiness(
  runtime: WorkflowRuntimeState,
  graph: WorkflowGraph,
  now: Date,
  audit: Array<WorkflowRuntimeTransition["audit"][number]>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of runtime.nodes) {
      if (node.status !== "waiting") continue;
      const incoming = runtime.edges.filter((edge) => edge.to === node.nodeId);
      const relevant = incoming.filter((edge) => edge.status !== "pending");
      if (relevant.length === 0) {
        if (incoming.length === 0) {
          node.status = "ready";
          node.visits = Math.max(1, node.visits);
          node.startedAt ??= now.toISOString();
          changed = true;
        }
        continue;
      }
      if (relevant.length !== incoming.length) continue;
      const selected = incoming.some(
        (edge) => edge.status === "selected" || edge.status === "looped",
      );
      if (!selected) {
        node.status = "skipped";
        node.endedAt = now.toISOString();
        audit.push({
          kind: "node.skipped",
          nodeId: node.nodeId,
          message: `节点“${node.name}”因分支未命中而跳过`,
        });
        for (const edge of graph.edges.filter(
          (edge) => edge.from === node.nodeId,
        )) {
          const edgeState = requireRuntimeEdge(runtime, edge.id);
          if (edgeState.status === "pending") {
            edgeState.status = "skipped";
            audit.push({
              kind: "branch.skipped",
              nodeId: node.nodeId,
              edgeId: edge.id,
              message: `跳过不可达分支 ${edge.from} -> ${edge.to}`,
            });
          }
        }
        changed = true;
        continue;
      }
      const predecessorsSettled = incoming.every((edgeState) => {
        const predecessor = requireRuntimeNode(runtime, edgeState.from);
        return [
          "completed",
          "rejected",
          "skipped",
          "failed",
          "blocked",
        ].includes(predecessor.status);
      });
      if (predecessorsSettled) {
        node.status = "ready";
        node.visits = Math.max(1, node.visits);
        node.startedAt ??= now.toISOString();
        changed = true;
      }
    }
  }
}

function reactivateLoopPath(
  runtime: WorkflowRuntimeState,
  graph: WorkflowGraph,
  targetId: string,
  sourceId: string,
  now: Date,
): void {
  const node = requireRuntimeNode(runtime, targetId);
  const limit = graph.nodes.find(
    (candidate) => candidate.id === targetId,
  )?.loopLimit;
  const nextVisits = node.visits + 1;
  if (limit !== undefined && nextVisits > limit) {
    node.status = "blocked";
    node.error = `循环次数已达到上限 ${limit}`;
    return;
  }
  const path = shortestPath(graph, targetId, sourceId);
  const pathIds = new Set(path ?? []);
  for (const pathNodeId of path ?? []) {
    const pathNode = requireRuntimeNode(runtime, pathNodeId);
    if (pathNodeId !== targetId) {
      pathNode.status = "waiting";
      pathNode.output = null;
      pathNode.error = null;
      pathNode.startedAt = null;
      pathNode.endedAt = null;
      pathNode.timeoutAt = null;
    }
    for (const edge of graph.edges.filter((edge) => edge.from === pathNodeId)) {
      const edgeState = requireRuntimeEdge(runtime, edge.id);
      edgeState.status = "pending";
      edgeState.conditionResult = null;
      if (pathIds.has(edge.to)) continue;
      const branchNode = requireRuntimeNode(runtime, edge.to);
      if (branchNode.status === "skipped") {
        resetSkippedBranch(runtime, graph, branchNode.nodeId);
      }
    }
  }
  node.status = "ready";
  node.visits = nextVisits;
  node.attempt = 0;
  node.selectedEdgeId = null;
  node.output = null;
  node.error = null;
  node.startedAt = now.toISOString();
  node.endedAt = null;
  node.timeoutAt = null;
  node.nextRetryAt = null;
  for (const edge of graph.edges.filter((edge) => edge.from === node.nodeId)) {
    const edgeState = requireRuntimeEdge(runtime, edge.id);
    edgeState.status = "pending";
    edgeState.conditionResult = null;
  }
}

function resetSkippedBranch(
  runtime: WorkflowRuntimeState,
  graph: WorkflowGraph,
  nodeId: string,
): void {
  const node = requireRuntimeNode(runtime, nodeId);
  node.status = "waiting";
  node.output = null;
  node.error = null;
  node.startedAt = null;
  node.endedAt = null;
  node.timeoutAt = null;
  node.nextRetryAt = null;
  for (const edge of graph.edges.filter((edge) => edge.from === nodeId)) {
    const edgeState = requireRuntimeEdge(runtime, edge.id);
    edgeState.status = "pending";
    edgeState.conditionResult = null;
    const target = requireRuntimeNode(runtime, edge.to);
    if (target.status === "skipped") {
      resetSkippedBranch(runtime, graph, target.nodeId);
    }
  }
}

function shortestPath(
  graph: WorkflowGraph,
  from: string,
  to: string,
): string[] | undefined {
  const queue: string[][] = [[from]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === to) return path;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges.filter((edge) => edge.from === current)) {
      queue.push([...path, edge.to]);
    }
  }
  return undefined;
}

function cloneRuntime(runtime: WorkflowRuntimeState): WorkflowRuntimeState {
  return {
    nodes: runtime.nodes.map((node) => ({ ...node })),
    edges: runtime.edges.map((edge) => ({ ...edge })),
    context: { ...runtime.context },
  };
}

function requireRuntimeNode(
  runtime: WorkflowRuntimeState,
  nodeId: string,
): WorkflowRuntimeNode {
  const node = runtime.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) throw new Error(`unknown runtime node ${nodeId}`);
  return node;
}

function requireRuntimeEdge(
  runtime: WorkflowRuntimeState,
  edgeId: string,
): WorkflowRuntimeEdge {
  const edge = runtime.edges.find((candidate) => candidate.edgeId === edgeId);
  if (edge === undefined) throw new Error(`unknown runtime edge ${edgeId}`);
  return edge;
}

function requireGraphNode(
  graph: WorkflowGraph,
  nodeId: string,
): WorkflowGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`unknown graph node ${nodeId}`);
  return node;
}
