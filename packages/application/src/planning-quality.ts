import type {
  CriticReportPayload,
  PlanningPolicyConfig,
  PlanningQualityGate,
  PlanningTriggerKind,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowPlanSettings,
} from "@pluginmax/contracts";
import { validateWorkflowPlanGraph } from "@pluginmax/domain";

const HIGH_RISK_PATTERNS = [
  /\bdelete\b/i,
  /\bdestroy\b/i,
  /\bdrop\b/i,
  /\bdeploy\b/i,
  /\bproduction\b/i,
  /\bpayment\b/i,
  /\btransfer\b/i,
  /\brelease\b/i,
  /\bpermission\b/i,
  /\bcredential\b/i,
  /删除/,
  /销毁/,
  /部署/,
  /生产/,
  /支付/,
  /转账/,
  /发布/,
  /权限/,
  /凭证/,
];

export interface PlanningGraphInspection {
  readonly validatorErrorCount: number;
  readonly acceptanceCoverage: number;
  readonly uncoveredAcceptance: readonly string[];
  readonly highRiskNodeIds: readonly string[];
  readonly highRiskGateMissing: readonly string[];
  readonly evidenceMissing: readonly string[];
  readonly nodeCount: number;
  readonly depth: number;
}

export function inspectPlanningGraph(
  graph: WorkflowGraph,
  settings: WorkflowPlanSettings,
  rootAcceptance: readonly string[],
): PlanningGraphInspection {
  const validation = validateWorkflowPlanGraph(graph, settings);
  const normalizedAcceptance = rootAcceptance.map(normalizeStatement);
  const covered = new Set(
    graph.nodes.flatMap((node) =>
      (node.acceptance ?? []).map(normalizeStatement),
    ),
  );
  const uncoveredAcceptance =
    normalizedAcceptance.length === 0
      ? []
      : rootAcceptance.filter(
          (_item, index) => !covered.has(normalizedAcceptance[index]!),
        );
  const highRiskNodeIds = graph.nodes
    .filter(isPlanningHighRiskNode)
    .map((node) => node.id);
  const highRiskGateMissing = graph.nodes
    .filter(
      (node) =>
        highRiskNodeIds.includes(node.id) &&
        (node.autoDispatch ||
          !node.approvers.some((approver) => approver.kind === "user")),
    )
    .map((node) => node.id);
  const evidenceMissing = graph.nodes
    .filter(
      (node) =>
        node.description.trim() === "" ||
        node.acceptance === undefined ||
        node.acceptance.length === 0 ||
        node.acceptance.some((item) => item.trim() === ""),
    )
    .map((node) => node.id);
  const depth = planDepth(graph);
  return {
    validatorErrorCount: validation.issues.length,
    acceptanceCoverage:
      normalizedAcceptance.length === 0
        ? 1
        : (normalizedAcceptance.length - uncoveredAcceptance.length) /
          normalizedAcceptance.length,
    uncoveredAcceptance,
    highRiskNodeIds,
    highRiskGateMissing,
    evidenceMissing,
    nodeCount: graph.nodes.length,
    depth,
  };
}

export function critiquePlanningGraph(input: {
  readonly graph: WorkflowGraph;
  readonly settings: WorkflowPlanSettings;
  readonly rootAcceptance: readonly string[];
}): CriticReportPayload {
  const inspection = inspectPlanningGraph(
    input.graph,
    input.settings,
    input.rootAcceptance,
  );
  const findings: CriticReportPayload["findings"] = [];
  if (inspection.validatorErrorCount > 0) {
    findings.push({
      code: "graph-invalid",
      severity: "error",
      message: "计划图未通过结构、依赖或限制校验",
      nodeId: null,
    });
  }
  if (inspection.acceptanceCoverage < 1) {
    findings.push({
      code: "acceptance-uncovered",
      severity: "error",
      message: `仍有 ${inspection.uncoveredAcceptance.length} 项 Root Acceptance 未被节点覆盖`,
      nodeId: null,
    });
  }
  if (inspection.evidenceMissing.length > 0) {
    findings.push({
      code: "node-evidence-missing",
      severity: "error",
      message: "存在缺少可检查证据要求的节点",
      nodeId: inspection.evidenceMissing[0] ?? null,
    });
  }
  if (inspection.highRiskGateMissing.length > 0) {
    findings.push({
      code: "high-risk-gate-missing",
      severity: "error",
      message: "高风险节点缺少人工审批 Gate",
      nodeId: inspection.highRiskGateMissing[0] ?? null,
    });
  }
  const score = Math.max(
    0,
    Math.min(
      100,
      100 -
        inspection.validatorErrorCount * 15 -
        inspection.uncoveredAcceptance.length * 20 -
        inspection.evidenceMissing.length * 10 -
        inspection.highRiskGateMissing.length * 25,
    ),
  );
  return {
    verdict: findings.some((item) => item.severity === "error")
      ? "reject"
      : "pass",
    score,
    summary:
      findings.length === 0
        ? "计划覆盖验收、证据与风险门要求"
        : "计划存在必须在执行前修正的问题",
    findings,
    checks: [
      {
        code: "graph",
        status:
          inspection.validatorErrorCount === 0 ? "pass" : "fail",
        message:
          inspection.validatorErrorCount === 0
            ? "图结构与依赖合法"
            : "图结构与依赖校验失败",
      },
      {
        code: "acceptance",
        status:
          inspection.acceptanceCoverage === 1 ? "pass" : "fail",
        message:
          inspection.acceptanceCoverage === 1
            ? "Root Acceptance 已全部覆盖"
            : "Root Acceptance 未全部覆盖",
      },
      {
        code: "evidence",
        status:
          inspection.evidenceMissing.length === 0 ? "pass" : "fail",
        message:
          inspection.evidenceMissing.length === 0
            ? "所有节点都有证据要求"
            : "存在缺少证据要求的节点",
      },
      {
        code: "risk",
        status:
          inspection.highRiskGateMissing.length === 0
            ? "pass"
            : "fail",
        message:
          inspection.highRiskGateMissing.length === 0
            ? "高风险节点已配置人工 Gate"
            : "高风险节点缺少人工 Gate",
      },
    ],
  };
}

export function evaluatePlanningQualityGate(input: {
  readonly graph: WorkflowGraph;
  readonly settings: WorkflowPlanSettings;
  readonly rootAcceptance: readonly string[];
  readonly critic: CriticReportPayload;
  readonly policy: PlanningPolicyConfig;
  readonly triggerKind: PlanningTriggerKind;
}): { readonly gate: PlanningQualityGate; readonly inspection: PlanningGraphInspection } {
  const inspection = inspectPlanningGraph(
    input.graph,
    input.settings,
    input.rootAcceptance,
  );
  const reasons: string[] = [];
  const checks: PlanningQualityGate["checks"] = [];
  const fail = (
    code: string,
    message: string,
    nodeId: string | null = null,
  ) => {
    reasons.push(message);
    checks.push({ code, status: "fail", message, nodeId });
  };
  const pass = (code: string, message: string) => {
    checks.push({ code, status: "pass", message, nodeId: null });
  };

  if (inspection.validatorErrorCount > 0) {
    fail("validator", "Validator 存在错误");
  } else {
    pass("validator", "Validator 错误为零");
  }
  if (inspection.acceptanceCoverage < 1) {
    fail("acceptance-coverage", "Root Acceptance 未完全覆盖");
  } else {
    pass("acceptance-coverage", "Root Acceptance 已完全覆盖");
  }
  if (inspection.evidenceMissing.length > 0) {
    fail(
      "node-evidence",
      "存在缺少证据要求的节点",
      inspection.evidenceMissing[0] ?? null,
    );
  } else {
    pass("node-evidence", "所有节点都有可检查证据要求");
  }
  if (inspection.highRiskGateMissing.length > 0) {
    fail(
      "high-risk-review",
      "高风险节点缺少人工审批 Gate",
      inspection.highRiskGateMissing[0] ?? null,
    );
  } else {
    pass("high-risk-review", "高风险节点满足人工 Gate 要求");
  }
  if (input.critic.verdict !== "pass") {
    fail("critic-verdict", `Critic verdict 为 ${input.critic.verdict}`);
  } else {
    pass("critic-verdict", "Critic verdict 已通过");
  }
  if (input.critic.score < input.policy.minScore) {
    fail(
      "critic-score",
      `Critic score ${input.critic.score} 低于阈值 ${input.policy.minScore}`,
    );
  } else {
    pass("critic-score", "Critic score 达到策略阈值");
  }

  const eligible = reasons.length === 0;
  const reviewRequired =
    !eligible ||
    input.policy.requireHumanReview ||
    input.triggerKind === "human-manual" ||
    inspection.highRiskNodeIds.length > 0;
  if (reviewRequired) {
    reasons.push(
      !eligible
        ? "质量门未通过，必须人工处理"
        : "策略或 Trigger 要求人工审核",
    );
  }
  const autoApproveEligible =
    eligible && input.policy.autoApprove && !reviewRequired;
  return {
    inspection,
    gate: {
      eligible,
      reviewRequired,
      autoApproveEligible,
      criticVerdict: input.critic.verdict,
      criticScore: input.critic.score,
      acceptanceCoverage: inspection.acceptanceCoverage,
      validatorErrorCount: inspection.validatorErrorCount,
      highRiskNodeIds: [...inspection.highRiskNodeIds],
      reasons,
      checks,
    },
  };
}

export function normalizeAcceptanceStatement(value: string): string {
  return normalizeStatement(value);
}

function normalizeStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function isPlanningHighRiskNode(node: WorkflowGraphNode): boolean {
  const text = [
    node.name,
    node.description,
    ...(node.acceptance ?? []),
  ].join("\n");
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

function planDepth(graph: WorkflowGraph): number {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  const depth = (nodeId: string): number => {
    if (visiting.has(nodeId)) return 0;
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    visiting.add(nodeId);
    const value = Math.max(
      0,
      ...(outgoing.get(nodeId) ?? []).map((next) => 1 + depth(next)),
    );
    visiting.delete(nodeId);
    memo.set(nodeId, value);
    return value;
  };
  return graph.nodes.length === 0
    ? 0
    : Math.max(...graph.nodes.map((node) => depth(node.id)));
}
