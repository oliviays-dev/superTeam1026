import type {
  WorkflowExecutor,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowNodeType,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from "@pluginmax/contracts";

interface RawNode {
  readonly line: number;
  readonly name: string;
  readonly fields: Map<string, string[]>;
}

const nodeTypes = new Set<WorkflowNodeType>([
  "task",
  "approval",
  "service",
  "decision",
  "subworkflow",
]);

export function validateWorkflowMarkdown(
  markdown: string,
): WorkflowValidationResult {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const errors: WorkflowValidationIssue[] = [];
  const warnings: WorkflowValidationIssue[] = [];
  let title = "";
  let section = "";
  const sections = new Set<string>();
  const metadata = new Map<string, string[]>();
  const rawNodes: RawNode[] = [];
  let currentNode: RawNode | undefined;

  const addField = (
    target: Map<string, string[]>,
    key: string,
    value: string,
  ) => {
    const values = target.get(key) ?? [];
    values.push(value);
    target.set(key, values);
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      section = heading[1]!;
      sections.add(section);
      currentNode = undefined;
      return;
    }
    if (/^#\s+/.test(line)) {
      const match = /^#\s+工作流\s*[:：]\s*(.+?)\s*$/.exec(line);
      if (match === null) {
        errors.push({
          line: lineNumber,
          code: "invalid_title",
          message: "工作流标题必须使用“# 工作流：名称”",
        });
      } else {
        title = match[1]!;
      }
      return;
    }
    const nodeHeading = /^###\s+(.+?)\s*$/.exec(line);
    if (nodeHeading !== null && section === "节点") {
      currentNode = {
        line: lineNumber,
        name: nodeHeading[1]!,
        fields: new Map(),
      };
      rawNodes.push(currentNode);
      return;
    }
    const field = /^\s*-\s+([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (field === null) return;
    const key = field[1]!;
    const value = field[2]!;
    if (section === "元信息") {
      addField(metadata, key, value);
    } else if (section === "节点" && currentNode !== undefined) {
      addField(currentNode.fields, key, value);
    }
  });

  for (const required of ["元信息", "节点", "连接"]) {
    if (!sections.has(required)) {
      errors.push({
        code: "missing_section",
        message: `缺少“## ${required}”章节`,
      });
    }
  }

  const key = metadata.get("key")?.[0] ?? "";
  const versionText = metadata.get("version")?.[0] ?? "";
  const version = Number(versionText);
  const description = metadata.get("description")?.[0] ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    errors.push({
      code: "invalid_key",
      message: "元信息 key 必须是 kebab-case",
    });
  }
  if (!Number.isInteger(version) || version <= 0) {
    errors.push({
      code: "invalid_version",
      message: "元信息 version 必须是正整数",
    });
  }

  const nodes: WorkflowGraphNode[] = [];
  const nodeIds = new Set<string>();
  for (const raw of rawNodes) {
    const id = raw.fields.get("id")?.[0] ?? "";
    const typeValue = raw.fields.get("type")?.[0] ?? "";
    const descriptionValue = raw.fields.get("description")?.[0] ?? "";
    if (id === "") {
      errors.push({
        line: raw.line,
        code: "node_id_required",
        message: `节点“${raw.name}”缺少 id`,
      });
    } else if (nodeIds.has(id)) {
      errors.push({
        line: raw.line,
        code: "duplicate_node_id",
        message: `节点 id 重复：${id}`,
      });
    } else {
      nodeIds.add(id);
    }
    if (!nodeTypes.has(typeValue as WorkflowNodeType)) {
      errors.push({
        line: raw.line,
        code: "invalid_node_type",
        message: `节点“${raw.name}”的 type 不合法`,
      });
      continue;
    }
    const executorValue = raw.fields.get("executor")?.[0] ?? "";
    const executor = parseExecutor(executorValue);
    if (executor === undefined) {
      errors.push({
        line: raw.line,
        code: "invalid_executor",
        message: `节点“${raw.name}”缺少合法的 executor`,
      });
    }
    const approvers = (raw.fields.get("approver") ?? [])
      .map(parseExecutor)
      .filter((value): value is WorkflowExecutor => value !== undefined);
    if (typeValue === "approval" && approvers.length === 0) {
      errors.push({
        line: raw.line,
        code: "approver_required",
        message: `审批节点“${raw.name}”至少需要一个 approver`,
      });
    }
    const policyValue = raw.fields.get("policy")?.[0] ?? "all";
    if (!["all", "any"].includes(policyValue)) {
      errors.push({
        line: raw.line,
        code: "invalid_approval_policy",
        message: `节点“${raw.name}”的审批策略只能是 all 或 any`,
      });
    }
    if (id !== "" && executor !== undefined) {
      const execution = raw.fields.get("execution")?.[0] ?? "";
      const trigger = raw.fields.get("trigger")?.[0] ?? "";
      nodes.push({
        id,
        name: raw.name,
        type: typeValue as WorkflowNodeType,
        executor,
        description: descriptionValue,
        approvers,
        approvalPolicy: policyValue === "any" ? "any" : "all",
        autoDispatch:
          execution === "task-worker" && trigger === "auto-on-ready",
      });
    }
  }

  const edges: WorkflowGraphEdge[] = [];
  let connections = false;
  lines.forEach((line, index) => {
    if (/^##\s+连接\s*$/.test(line)) {
      connections = true;
      return;
    }
    if (connections && /^##\s+/.test(line)) connections = false;
    if (!connections) return;
    const match = /^\s*-\s+([a-zA-Z0-9_-]+)\s*->\s*([a-zA-Z0-9_-]+)(.*)$/.exec(
      line,
    );
    if (match === null) return;
    const from = match[1]!;
    const to = match[2]!;
    const options = match[3] ?? "";
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      errors.push({
        line: index + 1,
        code: "unknown_edge_node",
        message: `连接引用了不存在的节点：${from} -> ${to}`,
      });
    }
    const result = /\[result:\s*(approved|rejected)\s*\]/i.exec(options)?.[1];
    const condition = /\[condition:\s*([^\]]+)\]/i.exec(options)?.[1]?.trim();
    const breakCondition = /\[break:\s*([^\]]+)\]/i.exec(options)?.[1]?.trim();
    const isDefault = /\[default:\s*true\s*\]/i.test(options);
    edges.push({
      id: `edge-${from}-${to}-${edges.length + 1}`,
      from,
      to,
      ...(result === undefined
        ? {}
        : { result: result.toLowerCase() as "approved" | "rejected" }),
      ...(condition === undefined ? {} : { condition }),
      ...(breakCondition === undefined ? {} : { breakCondition }),
      ...(isDefault ? { default: true } : {}),
    });
  });

  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const startNodeIds = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  if (nodes.length > 0 && startNodeIds.length === 0) {
    errors.push({
      code: "missing_start_node",
      message: "工作流至少需要一个无入边的起点",
    });
  }

  const adjacency = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of edges) {
    const items = adjacency.get(edge.from) ?? [];
    items.push(edge);
    adjacency.set(edge.from, items);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (nodeId: string) => {
    state.set(nodeId, 1);
    for (const edge of adjacency.get(nodeId) ?? []) {
      if (state.get(edge.to) === 1 && edge.breakCondition === undefined) {
        errors.push({
          code: "uncontrolled_cycle",
          message: `循环 ${nodeId} -> ${edge.to} 缺少 break 条件`,
        });
      }
      if ((state.get(edge.to) ?? 0) === 0) visit(edge.to);
    }
    state.set(nodeId, 2);
  };
  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  }

  for (const node of nodes) {
    if (node.type !== "decision") continue;
    const outgoing = adjacency.get(node.id) ?? [];
    if (
      !outgoing.some(
        (edge) => edge.condition !== undefined || edge.default === true,
      )
    ) {
      errors.push({
        code: "decision_branch_required",
        message: `判断节点“${node.name}”至少需要一个条件边或默认边`,
      });
    }
  }

  const reachable = new Set<string>();
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const edge of adjacency.get(nodeId) ?? []) queue.push(edge.to);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      warnings.push({
        code: "unreachable_node",
        message: `节点“${node.name}”不可达`,
      });
    }
  }

  const graph: WorkflowGraph = {
    key,
    version: Number.isInteger(version) ? version : 0,
    name: title,
    description,
    nodes,
    edges,
    startNodeIds,
    warnings: warnings.map((warning) => warning.message),
  };
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    graph,
  };
}

function parseExecutor(value: string): WorkflowExecutor | undefined {
  const match = /^(system|user|agent|role|用户)\s*:\s*(\S.+)$/i.exec(value);
  if (match === null) return undefined;
  const kindValue = match[1]!.toLowerCase();
  const kind =
    kindValue === "用户" ? "user" : (kindValue as WorkflowExecutor["kind"]);
  return { kind, id: match[2]!.trim() };
}
