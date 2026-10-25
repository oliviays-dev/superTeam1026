import {
  type ActorRef,
  type Approver,
  type DeliverableRequirement,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from "./types.js";

export interface ParseResult {
  readonly graph?: WorkflowGraph;
  readonly errors: string[];
  readonly warnings: string[];
}

type ExpressionValue = string | number | boolean;

const TYPE_ALIASES: Record<string, WorkflowNode["type"]> = {
  task: "task",
  任务: "task",
  service: "service",
  服务: "service",
  approval: "approval",
  审批: "approval",
  decision: "decision",
  判断: "decision",
  subworkflow: "subworkflow",
  子流程: "subworkflow",
};

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

class WorkflowParseError {
  constructor(readonly message: string) {}
}

function sections(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = "";
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = heading[1]!.trim();
      result.set(current, []);
      continue;
    }
    if (current !== "") result.get(current)!.push(rawLine);
  }
  return result;
}

function bulletValue(line: string): { key: string; value: string } | undefined {
  const match = /^[-*]\s*([^:：]+?)\s*[:：]\s*(.*)$/.exec(line.trim());
  if (match === null) return undefined;
  return { key: match[1]!.trim().toLowerCase(), value: match[2]!.trim() };
}

function parseLiteral(input: string): ExpressionValue {
  const value = input.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^"[^"]*"$/.test(value)) return value.slice(1, -1);
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  throw new WorkflowParseError(`invalid variable default: ${input}`);
}

function parseExecutor(
  value: string,
  errors: string[],
): WorkflowNode["executor"] | undefined {
  const match =
    /^(system|user|agent|employee|role|系统|用户|员工|角色)\s*[:：]\s*(.+)$/.exec(
      value,
    );
  if (match === null) {
    errors.push(
      `invalid executor "${value}"; use system:user, user:alice, agent:architect, employee:backend-engineer-01, or role:reviewer`,
    );
    return undefined;
  }
  const kindRaw = match[1]!.toLowerCase();
  const kind =
    kindRaw === "system" || kindRaw === "系统"
      ? "system"
      : kindRaw === "user" || kindRaw === "用户"
        ? "user"
        : kindRaw === "employee" || kindRaw === "员工"
          ? "employee"
          : kindRaw === "role" || kindRaw === "角色"
            ? "role"
            : "agent";
  const id = match[2]!.trim();
  if (!ID_PATTERN.test(id)) {
    errors.push(`invalid executor id "${id}"`);
    return undefined;
  }
  return { kind, id, label: id };
}

function parseApprover(value: string, errors: string[]): Approver | undefined {
  const match = /^(用户|agent|employee|员工|角色|role)\s*[:：]\s*(.+)$/.exec(
    value,
  );
  if (match === null) {
    errors.push(
      `invalid approver "${value}"; use 用户:id, agent:id, employee:id, or 角色:id`,
    );
    return undefined;
  }
  const rawKind = match[1]!.toLowerCase();
  const kind =
    rawKind === "agent"
      ? "agent"
      : rawKind === "employee" || rawKind === "员工"
        ? "employee"
        : rawKind === "role" || rawKind === "角色"
          ? "role"
          : "user";
  const id = match[2]!.trim();
  if (!ID_PATTERN.test(id)) {
    errors.push(`invalid approver id "${id}"`);
    return undefined;
  }
  return { kind, id, name: id };
}

const DELIVERABLE_FIELDS = new Set([
  "title",
  "type",
  "required",
  "description",
  "accept",
  "min-text-length",
  "max-files",
]);

function parseDurationMs(value: string): number | undefined {
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as "ms" | "s" | "m" | "h"
  ];
  return amount * unitMs;
}

function parseEdges(
  lines: string[],
  errors: string[],
): { edges: WorkflowEdge[]; edgeCount: number } {
  const edges: WorkflowEdge[] = [];
  let edgeCount = 0;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    edgeCount += 1;
    const match = /^[-*]\s+(.+)$/.exec(line);
    if (match === null) {
      errors.push(`connection line ${index + 1}: expected "- from -> to"`);
      return;
    }
    const arrowIndex = match[1]!.indexOf("->");
    if (arrowIndex < 0) {
      errors.push(`connection line ${index + 1}: missing ->`);
      return;
    }
    const left = match[1]!.slice(0, arrowIndex).trim();
    const rightRaw = match[1]!.slice(arrowIndex + 2).trim();
    if (/\s\+\s/.test(left)) {
      errors.push(
        `connection line ${index + 1}: write each parallel incoming edge separately`,
      );
      return;
    }
    const attributeStart = rightRaw.indexOf("[");
    const attributeEnd = rightRaw.lastIndexOf("]");
    const target = (
      attributeStart >= 0 ? rightRaw.slice(0, attributeStart) : rightRaw
    ).trim();
    if (!ID_PATTERN.test(left) || !ID_PATTERN.test(target)) {
      errors.push(`connection line ${index + 1}: node ids must use kebab-case`);
      return;
    }
    const edge: WorkflowEdge = {
      id: `e-${edges.length + 1}-${left}-${target}`,
      from: left,
      to: target,
      default: false,
    };
    if (attributeStart >= 0) {
      if (attributeEnd < attributeStart) {
        errors.push(`connection line ${index + 1}: unterminated [attributes]`);
        return;
      }
      const attributes = rightRaw.slice(attributeStart + 1, attributeEnd);
      for (const part of attributes.split(",")) {
        const item = part.trim();
        if (item === "default") {
          edge.default = true;
          continue;
        }
        const detail = /^(condition|break|result)\s*[:：]\s*(.+)$/.exec(item);
        if (detail === null) {
          errors.push(
            `connection line ${index + 1}: unknown attribute "${item}"`,
          );
          continue;
        }
        const key = detail[1]!;
        const value = detail[2]!.trim();
        if (key === "condition") edge.condition = value;
        else if (key === "break") edge.breakCondition = value;
        else if (value === "approved" || value === "rejected")
          edge.result = value;
        else
          errors.push(
            `connection line ${index + 1}: result must be approved or rejected`,
          );
      }
    }
    edges.push(edge);
  });
  return { edges, edgeCount };
}

function findCycles(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (nodeId: string): void => {
    const current = state.get(nodeId) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(nodeId);
      if (start >= 0) cycles.push([...stack.slice(start), nodeId]);
      return;
    }
    if (current !== 0) return;
    state.set(nodeId, 1);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) visit(next);
    stack.pop();
    state.set(nodeId, 2);
  };
  for (const node of nodes) visit(node.id);
  return cycles;
}

export function parseWorkflowMarkdown(markdown: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allLines = markdown.split(/\r?\n/);
  const titleLine = allLines.find((line) =>
    /^#\s+工作流\s*[:：]\s*.+/.test(line.trim()),
  );
  if (titleLine === undefined) {
    errors.push('first-level title must use "# 工作流：名称"');
  }
  const name = titleLine?.replace(/^#\s+工作流\s*[:：]\s*/, "").trim() ?? "";
  const parsedSections = sections(markdown);
  const requiredSections = ["元信息", "节点", "连接"];
  for (const section of requiredSections) {
    if (!parsedSections.has(section))
      errors.push(`missing section: ${section}`);
  }
  if (errors.length > 0) return { errors, warnings };

  const metadata: Record<string, string> = {};
  const variables: WorkflowGraph["variables"] = [];
  for (const line of parsedSections.get("元信息")!) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const bullet = bulletValue(line);
    if (bullet === undefined) {
      errors.push(`metadata line is invalid: ${line.trim()}`);
      continue;
    }
    if (bullet.key === "variable") {
      const variable = /^(.+?)\s*=\s*(.+)$/.exec(bullet.value);
      if (variable === null) {
        errors.push(`invalid variable: ${bullet.value}`);
        continue;
      }
      const variableName = variable[1]!.trim();
      if (!ID_PATTERN.test(variableName)) {
        errors.push(`invalid variable name: ${variableName}`);
        continue;
      }
      try {
        variables.push({
          name: variableName,
          value: parseLiteral(variable[2]!),
        });
      } catch (error) {
        errors.push(
          error instanceof WorkflowParseError
            ? error.message
            : "invalid variable value",
        );
      }
      continue;
    }
    metadata[bullet.key] = bullet.value;
  }
  const key = metadata["key"];
  const versionText = metadata["version"];
  if (key === undefined || !ID_PATTERN.test(key))
    errors.push("metadata key is required and must use kebab-case");
  const version = Number(versionText);
  if (versionText === undefined || !Number.isInteger(version) || version <= 0) {
    errors.push("metadata version must be a positive integer");
  }

  const nodeLines = parsedSections.get("节点")!;
  const groups: Array<{ name: string; lines: string[] }> = [];
  for (const line of nodeLines) {
    const heading = /^###\s+(.+)$/.exec(line.trim());
    if (heading) groups.push({ name: heading[1]!.trim(), lines: [] });
    else if (groups.length > 0) groups[groups.length - 1]!.lines.push(line);
  }
  if (groups.length === 0) errors.push("at least one node is required");
  const nodes: WorkflowNode[] = [];
  const nodeIds = new Set<string>();
  for (const group of groups) {
    const fields = new Map<string, string[]>();
    const deliverables: DeliverableRequirement[] = [];
    let activeDeliverable: DeliverableRequirement | undefined;
    for (const line of group.lines) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const continuation = /^ {2,}([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
      const bullet = continuation
        ? {
            key: continuation[1]!.trim().toLowerCase(),
            value: continuation[2]!.trim(),
          }
        : bulletValue(line);
      if (bullet === undefined) {
        errors.push(
          `node "${group.name}" has an invalid field: ${line.trim()}`,
        );
        continue;
      }
      if (bullet.key === "deliverable") {
        if (!ID_PATTERN.test(bullet.value)) {
          errors.push(
            `node "${group.name}" has an invalid deliverable key: ${bullet.value}`,
          );
          activeDeliverable = undefined;
          continue;
        }
        if (deliverables.some((item) => item.key === bullet.value)) {
          errors.push(`duplicate deliverable key: ${bullet.value}`);
          activeDeliverable = undefined;
          continue;
        }
        activeDeliverable = {
          key: bullet.value,
          title: bullet.value,
          type: "file",
          required: true,
          description: "",
          accept: [],
          maxFiles: 1,
        };
        deliverables.push(activeDeliverable);
        continue;
      }
      if (
        activeDeliverable !== undefined &&
        DELIVERABLE_FIELDS.has(bullet.key)
      ) {
        const value = bullet.value;
        if (bullet.key === "title")
          activeDeliverable.title = value || activeDeliverable.title;
        else if (bullet.key === "description")
          activeDeliverable.description = value;
        else if (bullet.key === "required")
          activeDeliverable.required = value === "true";
        else if (bullet.key === "type") {
          if (!["file", "text", "link"].includes(value)) {
            errors.push(
              `deliverable "${activeDeliverable.key}" has an invalid type: ${value}`,
            );
          } else
            activeDeliverable.type = value as DeliverableRequirement["type"];
        } else if (bullet.key === "accept") {
          activeDeliverable.accept = value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== "");
        } else if (bullet.key === "min-text-length") {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            errors.push(
              `deliverable "${activeDeliverable.key}" has an invalid min-text-length`,
            );
          } else activeDeliverable.minTextLength = parsed;
        } else {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            errors.push(
              `deliverable "${activeDeliverable.key}" has an invalid max-files`,
            );
          } else activeDeliverable.maxFiles = parsed;
        }
        continue;
      }
      if (activeDeliverable !== undefined) activeDeliverable = undefined;
      const values = fields.get(bullet.key) ?? [];
      values.push(bullet.value);
      fields.set(bullet.key, values);
    }
    const nodeId = fields.get("id")?.[0];
    const typeText = fields.get("type")?.[0]?.toLowerCase();
    const executorText = fields.get("executor")?.[0];
    if (nodeId === undefined || !ID_PATTERN.test(nodeId)) {
      errors.push(`node "${group.name}" requires an id`);
      continue;
    }
    if (nodeIds.has(nodeId)) errors.push(`duplicate node id: ${nodeId}`);
    nodeIds.add(nodeId);
    const type = typeText === undefined ? undefined : TYPE_ALIASES[typeText];
    if (type === undefined) {
      errors.push(
        `node "${group.name}" has an unknown type: ${typeText ?? ""}`,
      );
      continue;
    }
    const executor =
      executorText === undefined
        ? undefined
        : parseExecutor(executorText, errors);
    if (executor === undefined) continue;
    const responsibleText = fields.get("responsible")?.[0];
    const responsible =
      responsibleText === undefined
        ? undefined
        : parseExecutor(responsibleText, errors);
    const typedResponsible = responsible as ActorRef | undefined;
    if (responsibleText !== undefined && responsible === undefined) continue;
    if (
      typedResponsible !== undefined &&
      !["user", "employee"].includes(typedResponsible.kind)
    ) {
      errors.push(`node "${nodeId}" responsible must be a user or employee`);
      continue;
    }
    const earlyReviewText =
      fields.get("review-required")?.[0] ?? fields.get("review")?.[0];
    const reviewIsRequired = earlyReviewText?.toLowerCase() !== "false";
    if (
      executor.kind === "agent" &&
      typedResponsible === undefined &&
      reviewIsRequired
    ) {
      errors.push(
        `节点「${nodeId}」的执行者是 Agent 且需要人工 Review（review: true），必须指定 responsible: user:<用户ID> 作为交付责任人`,
      );
    } else if (
      executor.kind === "agent" &&
      typedResponsible === undefined &&
      !reviewIsRequired
    ) {
      warnings.push(
        `节点「${nodeId}」的执行者是 Agent 且设置了 review: false，未指定 responsible；Agent 失败时需工作区负责人或管理员介入。建议添加 responsible: user:<用户ID>`,
      );
    }
    for (const deliverable of deliverables) {
      if (
        deliverable.type === "text" &&
        deliverable.minTextLength === undefined
      )
        deliverable.minTextLength = 1;
      if (deliverable.type !== "file") {
        deliverable.accept = [];
        deliverable.maxFiles = 1;
      }
      if (deliverable.type === "text" && deliverable.accept.length > 0) {
        errors.push(
          `deliverable "${deliverable.key}" cannot combine text with accept`,
        );
      }
      if (
        deliverable.type !== "text" &&
        deliverable.minTextLength !== undefined
      ) {
        errors.push(
          `deliverable "${deliverable.key}" cannot combine min-text-length with ${deliverable.type}`,
        );
      }
      if (deliverable.title === deliverable.key) {
        errors.push(`deliverable "${deliverable.key}" requires a title`);
      }
    }
    const approvers = (fields.get("approver") ?? [])
      .map((value) => parseApprover(value, errors))
      .filter((value): value is Approver => value !== undefined);
    const reviewText =
      fields.get("review-required")?.[0] ?? fields.get("review")?.[0];
    const reviewRequired = reviewText?.toLowerCase() !== "false";
    if (
      reviewText !== undefined &&
      !["true", "false"].includes(reviewText.toLowerCase())
    ) {
      errors.push(
        `node "${nodeId}" has an invalid review-required: ${reviewText}`,
      );
    }
    const node: WorkflowNode = {
      id: nodeId,
      name: group.name,
      type,
      description: fields.get("description")?.[0] ?? "",
      executor,
      responsible: typedResponsible,
      reviewRequired,
      execution: "manual",
      trigger: "manual-dispatch",
      maxAttempts: 1,
      timeoutMs: 1_800_000,
      deliverables,
      approvers,
      approvalPolicy: fields.get("policy")?.[0] === "any" ? "any" : "all",
      ...(fields.get("metric")?.[0] === undefined
        ? {}
        : { metricExpression: fields.get("metric")![0] }),
      ...(fields.get("subworkflow")?.[0] === undefined
        ? {}
        : { subworkflowKey: fields.get("subworkflow")![0] }),
      ...(fields.get("subworkflow-version")?.[0] === undefined
        ? {}
        : {
            subworkflowVersion: Number(fields.get("subworkflow-version")![0]),
          }),
    };
    const executionText = fields.get("execution")?.[0]?.toLowerCase();
    if (executionText !== undefined) {
      if (executionText === "manual" || executionText === "task-worker") {
        node.execution = executionText;
      } else {
        errors.push(
          `node "${nodeId}" has an invalid execution: ${executionText}`,
        );
      }
    }
    const triggerText = fields.get("trigger")?.[0]?.toLowerCase();
    if (triggerText !== undefined) {
      if (
        triggerText === "manual-dispatch" ||
        triggerText === "auto-on-ready"
      ) {
        node.trigger = triggerText;
      } else {
        errors.push(`node "${nodeId}" has an invalid trigger: ${triggerText}`);
      }
    }
    if (executor.kind === "agent" && node.trigger === "manual-dispatch") {
      warnings.push(
        `节点「${group.name}」的 Agent 执行器需要手动派发；如需就绪后自动启动，请设置 execution: task-worker 和 trigger: auto-on-ready`,
      );
    }
    const maxAttemptsText = fields.get("max-attempts")?.[0];
    if (maxAttemptsText !== undefined) {
      const parsed = Number(maxAttemptsText);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        errors.push(
          `node "${nodeId}" has an invalid max-attempts: ${maxAttemptsText}`,
        );
      } else {
        node.maxAttempts = parsed;
      }
    }
    const timeoutText = fields.get("timeout")?.[0];
    if (timeoutText !== undefined) {
      const parsed = parseDurationMs(timeoutText);
      if (parsed === undefined || parsed < 1_000 || parsed > 3_600_000) {
        errors.push(
          `node "${nodeId}" has an invalid timeout: ${timeoutText} (use 1s - 1h)`,
        );
      } else {
        node.timeoutMs = parsed;
      }
    }
    const agentProfileText = fields.get("agent-profile")?.[0];
    if (agentProfileText !== undefined) {
      if (ID_PATTERN.test(agentProfileText)) {
        node.agentProfileId = agentProfileText;
      } else {
        errors.push(
          `node "${nodeId}" has an invalid agent-profile: ${agentProfileText}`,
        );
      }
    }
    if (node.trigger === "auto-on-ready" && node.execution !== "task-worker") {
      errors.push(
        `节点「${nodeId}」设置了 trigger: auto-on-ready，但缺少 execution: task-worker；请添加 execution: task-worker 以启用自动派发`,
      );
    }
    if (type === "subworkflow") {
      if (node.subworkflowKey === undefined)
        errors.push(`subworkflow node ${nodeId} requires subworkflow`);
      const childVersion = node.subworkflowVersion;
      if (
        childVersion !== undefined &&
        (!Number.isInteger(childVersion) || childVersion <= 0)
      ) {
        errors.push(`subworkflow node ${nodeId} has an invalid version`);
      }
    }
    if (type === "approval" && approvers.length === 0) {
      errors.push(`approval node requires approver: ${nodeId}`);
    }
    nodes.push(node);
  }

  const parsedEdges = parseEdges(parsedSections.get("连接")!, errors);
  for (const edge of parsedEdges.edges) {
    if (!nodeIds.has(edge.from))
      errors.push(`edge references unknown node: ${edge.from}`);
    if (!nodeIds.has(edge.to))
      errors.push(`edge references unknown node: ${edge.to}`);
  }

  const targetNodeIds = new Set(parsedEdges.edges.map((edge) => edge.to));
  const reachable = new Set<string>();
  const roots = nodes
    .filter((node) => !targetNodeIds.has(node.id))
    .filter(
      (node) =>
        parsedEdges.edges.some((edge) => edge.from === node.id) ||
        nodes.length === 1,
    )
    .map((node) => node.id);
  if (roots.length === 0 && nodes.length > 0) roots.push(nodes[0]!.id);
  const adjacency = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of parsedEdges.edges) adjacency.get(edge.from)?.push(edge.to);
  const walk = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) walk(next);
  };
  roots.forEach(walk);
  for (const node of nodes) {
    if (!reachable.has(node.id))
      warnings.push(`node is unreachable: ${node.id}`);
  }
  for (const cycle of findCycles(nodes, parsedEdges.edges)) {
    const cycleIds = new Set(cycle);
    const controlled = parsedEdges.edges.some(
      (edge) =>
        cycleIds.has(edge.from) &&
        cycleIds.has(edge.to) &&
        edge.breakCondition !== undefined,
    );
    if (!controlled) {
      errors.push(`cycle requires a break condition: ${cycle.join(" -> ")}`);
    }
  }
  for (const node of nodes) {
    if (node.type !== "decision") continue;
    const outgoing = parsedEdges.edges.filter((edge) => edge.from === node.id);
    if (!outgoing.some((edge) => edge.default) && outgoing.length > 0) {
      errors.push(`decision node requires a default edge: ${node.id}`);
    }
  }

  if (errors.length > 0 || name === "" || key === undefined) {
    return { errors, warnings };
  }
  return {
    graph: {
      key,
      version,
      name,
      description: metadata["description"] ?? "",
      variables,
      nodes,
      edges: parsedEdges.edges,
      startNodeIds: roots,
      warnings,
    },
    errors,
    warnings,
  };
}

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: string }
  | { type: "paren"; value: "(" | ")" };

function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(input.slice(index));
      tokens.push({ type: "number", value: Number(match![0]) });
      index += match![0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = input.indexOf(char, index + 1);
      if (end < 0)
        throw new ExpressionIssue("unterminated string in expression");
      tokens.push({ type: "string", value: input.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[a-zA-Z_][a-zA-Z0-9_.]*/.test(char)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(input.slice(index))!;
      tokens.push({ type: "identifier", value: match[0] });
      index += match[0].length;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }
    const operator = ["&&", "||", ">=", "<=", "==", "!=", ">", "<", "!"].find(
      (candidate) => input.startsWith(candidate, index),
    );
    if (operator === undefined)
      throw new ExpressionIssue(`unsupported character: ${char}`);
    tokens.push({ type: "operator", value: operator });
    index += operator.length;
  }
  return tokens;
}

export class ExpressionIssue extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionIssue";
  }
}

export function compileExpression(
  expression: string,
): (context: Record<string, ExpressionValue>) => boolean {
  let tokens: Token[];
  try {
    tokens = tokenizeExpression(expression);
  } catch (error) {
    const message =
      error instanceof ExpressionIssue ? error.message : "invalid expression";
    throw new ExpressionIssue(message);
  }
  let position = 0;
  const peek = () => tokens[position];
  const consume = (value?: string): Token => {
    const token = tokens[position];
    if (token === undefined || (value !== undefined && token.value !== value)) {
      throw new ExpressionIssue(
        `unexpected token near position ${position + 1}`,
      );
    }
    position += 1;
    return token;
  };
  const parseOr = (): ((
    context: Record<string, ExpressionValue>,
  ) => boolean) => {
    let left = parseAnd();
    while (
      peek()?.type === "operator" &&
      (peek() as { value: string }).value === "||"
    ) {
      consume("||");
      const right = parseAnd();
      const previous = left;
      left = (context) => previous(context) || right(context);
    }
    return left;
  };
  const parseAnd = (): ((
    context: Record<string, ExpressionValue>,
  ) => boolean) => {
    let left = parseUnary();
    while (
      peek()?.type === "operator" &&
      (peek() as { value: string }).value === "&&"
    ) {
      consume("&&");
      const right = parseUnary();
      const previous = left;
      left = (context) => previous(context) && right(context);
    }
    return left;
  };
  const parseUnary = (): ((
    context: Record<string, ExpressionValue>,
  ) => boolean) => {
    if (
      peek()?.type === "operator" &&
      (peek() as { value: string }).value === "!"
    ) {
      consume("!");
      const operand = parseUnary();
      return (context) => !operand(context);
    }
    return parseComparison();
  };
  const parseComparison = (): ((
    context: Record<string, ExpressionValue>,
  ) => boolean) => {
    const left = parsePrimary();
    const token = peek();
    if (
      token?.type !== "operator" ||
      !["<", ">", "<=", ">=", "==", "!="].includes(
        (token as { value: string }).value,
      )
    ) {
      return (context) => Boolean(left(context));
    }
    const operator = (consume() as { value: string }).value;
    const right = parsePrimary();
    return (context) => {
      const leftValue = left(context);
      const rightValue = right(context);
      if (typeof leftValue === "boolean" || typeof rightValue === "boolean") {
        if (operator === "==") return leftValue === rightValue;
        if (operator === "!=") return leftValue !== rightValue;
        throw new ExpressionIssue("booleans support == and !=");
      }
      if (typeof leftValue !== typeof rightValue)
        throw new ExpressionIssue("comparison operands have different types");
      switch (operator) {
        case "<":
          return leftValue < rightValue;
        case ">":
          return leftValue > rightValue;
        case "<=":
          return leftValue <= rightValue;
        case ">=":
          return leftValue >= rightValue;
        case "==":
          return leftValue === rightValue;
        default:
          return leftValue !== rightValue;
      }
    };
  };
  const parsePrimary = (): ((
    context: Record<string, ExpressionValue>,
  ) => ExpressionValue) => {
    const token = peek();
    if (token === undefined)
      throw new ExpressionIssue("expression is incomplete");
    if (token.type === "number") {
      consume();
      const value = token.value;
      return () => value;
    }
    if (token.type === "string") {
      consume();
      const value = token.value;
      return () => value;
    }
    if (token.type === "identifier") {
      consume();
      const name = token.value;
      return (context) => {
        if (!(name in context))
          throw new ExpressionIssue(`missing variable: ${name}`);
        return context[name]!;
      };
    }
    if (token.type === "paren" && token.value === "(") {
      consume("(");
      const grouped = parseOr();
      consume(")");
      return grouped;
    }
    throw new ExpressionIssue("unexpected expression token");
  };
  const compiled = parseOr();
  if (position !== tokens.length)
    throw new ExpressionIssue("unexpected trailing expression");
  return (context) => compiled(context);
}

export function evaluateExpression(
  expression: string,
  context: Record<string, ExpressionValue>,
): boolean {
  return compileExpression(expression)(context);
}
