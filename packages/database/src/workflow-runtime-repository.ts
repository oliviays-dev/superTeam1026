import { randomUUID } from "node:crypto";
import type {
  WorkflowApproval,
  WorkflowAuditEvent,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowRuntimeNode,
  WorkflowRuntimeState,
  WorkflowStepState,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface WorkflowInstanceRow {
  id: string;
  workflow_id: string;
  project_id: string;
  title: string;
  status: WorkflowInstanceStatus;
  definition_key: string | null;
  definition_version: number | null;
  parent_instance_id: string | null;
  parent_node_id: string | null;
  runtime_context: Record<string, string | number | boolean | null>;
  runtime_nodes: WorkflowRuntimeNode[];
  runtime_edges: WorkflowRuntimeState["edges"];
  failure_reason: string | null;
  paused_at: Date | null;
  revision: number;
  current_step: number;
  steps: WorkflowStepState[];
  created_at: Date;
  updated_at: Date;
  graph: WorkflowGraph | null;
}

interface WorkflowDefinitionRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  steps: WorkflowDefinition["steps"];
  source_md: string;
  graph: WorkflowGraph | null;
  status: WorkflowDefinition["status"];
  created_at: Date;
  updated_at: Date;
}

interface WorkflowApprovalRow {
  id: string;
  instance_id: string;
  node_id: string;
  round: number;
  approver_id: string;
  approver_role_id: string | null;
  status: WorkflowApproval["status"];
  note: string;
  acted_by: string | null;
  acted_at: Date | null;
  created_at: Date;
}

interface WorkflowAuditRow {
  id: string;
  instance_id: string;
  node_id: string | null;
  seq: string;
  kind: WorkflowAuditEvent["kind"];
  actor_id: string;
  summary: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateWorkflowRuntimeInstanceInput {
  readonly workflow: WorkflowDefinition;
  readonly graph: WorkflowGraph;
  readonly title: string;
  readonly context: Record<string, string | number | boolean | null>;
  readonly runtime: WorkflowRuntimeState;
  readonly status: WorkflowInstanceStatus;
  readonly idempotencyKey?: string;
  readonly parentInstanceId?: string;
  readonly parentNodeId?: string;
}

export interface SaveWorkflowRuntimeInput {
  readonly runtime: WorkflowRuntimeState;
  readonly status: WorkflowInstanceStatus;
  readonly failureReason?: string | null;
  readonly pausedAt?: string | null;
  readonly actorId: string;
  readonly audits?: ReadonlyArray<{
    readonly kind: WorkflowAuditEvent["kind"];
    readonly nodeId?: string;
    readonly summary: string;
    readonly data?: Record<string, unknown> | null;
  }>;
}

export class WorkflowRuntimeRepository {
  constructor(private readonly database: Database) {}

  async getDefinition(
    projectId: string,
    key: string,
    version?: number,
  ): Promise<WorkflowDefinition | undefined> {
    const result = await this.database.query<WorkflowDefinitionRow>(
      `SELECT * FROM workflow_definitions
       WHERE project_id = $1
         AND COALESCE(graph->>'key', name) = $2
         AND status = 'active'
         AND ($3::integer IS NULL OR graph->>'version' = $3::text)
       ORDER BY COALESCE((graph->>'version')::integer, 1) DESC
       LIMIT 1`,
      [projectId, key, version ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : definitionFromRow(row);
  }

  async hasSubworkflowCycle(
    projectId: string,
    graph: WorkflowGraph,
    ancestorKeys: readonly string[],
  ): Promise<boolean> {
    const seen = new Set([...ancestorKeys, graph.key]);
    for (const node of graph.nodes) {
      if (node.type !== "subworkflow" || node.subworkflowKey === undefined) {
        continue;
      }
      if (seen.has(node.subworkflowKey)) return true;
      const child = await this.getDefinition(
        projectId,
        node.subworkflowKey,
        node.subworkflowVersion,
      );
      if (child?.graph === null || child?.graph === undefined) continue;
      if (await this.hasSubworkflowCycle(projectId, child.graph, [...seen])) {
        return true;
      }
    }
    return false;
  }

  async createInstance(
    input: CreateWorkflowRuntimeInstanceInput,
  ): Promise<WorkflowInstance> {
    return this.database.transaction(async (client) => {
      if (input.idempotencyKey !== undefined) {
        const existing = await client.query<WorkflowInstanceRow>(
          `SELECT instance.*, definition.graph
           FROM workflow_instances AS instance
           JOIN workflow_definitions AS definition
             ON definition.id = instance.workflow_id
           WHERE instance.workflow_id = $1
             AND instance.start_idempotency_key = $2`,
          [input.workflow.id, input.idempotencyKey],
        );
        if (existing.rows[0] !== undefined) {
          return instanceFromRow(existing.rows[0]);
        }
      }
      const id = randomUUID();
      const steps = stepsFromRuntime(input.runtime);
      const result = await client.query<WorkflowInstanceRow>(
        `WITH inserted AS (
           INSERT INTO workflow_instances (
             id, workflow_id, project_id, title, status,
             definition_key, definition_version,
             parent_instance_id, parent_node_id,
             runtime_context, runtime_nodes, runtime_edges,
             failure_reason, paused_at, revision, start_idempotency_key,
             current_step, steps, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7,
             $8, $9,
             $10::jsonb, $11::jsonb, $12::jsonb,
             NULL, NULL, 1, $13,
             0, $14::jsonb, NOW(), NOW()
           )
           RETURNING *
         )
         SELECT inserted.*, definition.graph
         FROM inserted
         JOIN workflow_definitions AS definition
           ON definition.id = inserted.workflow_id`,
        [
          id,
          input.workflow.id,
          input.workflow.projectId,
          input.title,
          input.status,
          input.graph.key,
          input.graph.version,
          input.parentInstanceId ?? null,
          input.parentNodeId ?? null,
          JSON.stringify(input.context),
          JSON.stringify(input.runtime.nodes),
          JSON.stringify(input.runtime.edges),
          input.idempotencyKey ?? null,
          JSON.stringify(steps),
        ],
      );
      await appendAudits(client, id, "system", [
        {
          kind: "instance.started",
          summary: input.parentInstanceId
            ? `子流程“${input.title}”已启动`
            : `工作流“${input.title}”已启动`,
          data: {
            definitionKey: input.graph.key,
            definitionVersion: input.graph.version,
            parentInstanceId: input.parentInstanceId ?? null,
          },
        },
      ]);
      return instanceFromRow(result.rows[0]!);
    });
  }

  async list(projectId: string): Promise<WorkflowInstance[]> {
    const result = await this.database.query<WorkflowInstanceRow>(
      `SELECT instance.*, definition.graph
       FROM workflow_instances AS instance
       JOIN workflow_definitions AS definition
         ON definition.id = instance.workflow_id
       WHERE instance.project_id = $1
       ORDER BY instance.updated_at DESC, instance.id`,
      [projectId],
    );
    return result.rows.map(instanceFromRow);
  }

  async get(id: string): Promise<WorkflowInstance | undefined> {
    const result = await this.database.query<WorkflowInstanceRow>(
      `SELECT instance.*, definition.graph
       FROM workflow_instances AS instance
       JOIN workflow_definitions AS definition
         ON definition.id = instance.workflow_id
       WHERE instance.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : instanceFromRow(row);
  }

  async listChildren(instanceId: string): Promise<WorkflowInstance[]> {
    const result = await this.database.query<WorkflowInstanceRow>(
      `SELECT instance.*, definition.graph
       FROM workflow_instances AS instance
       JOIN workflow_definitions AS definition
         ON definition.id = instance.workflow_id
       WHERE instance.parent_instance_id = $1
       ORDER BY instance.created_at, instance.id`,
      [instanceId],
    );
    return result.rows.map(instanceFromRow);
  }

  async save(
    instanceId: string,
    expectedRevision: number,
    input: SaveWorkflowRuntimeInput,
  ): Promise<WorkflowInstance | undefined> {
    return this.database.transaction(async (client) => {
      const steps = stepsFromRuntime(input.runtime);
      const result = await client.query<WorkflowInstanceRow>(
        `WITH updated AS (
           UPDATE workflow_instances AS instance
           SET
             runtime_context = $3::jsonb,
             runtime_nodes = $4::jsonb,
             runtime_edges = $5::jsonb,
             steps = $6::jsonb,
             status = $7,
             failure_reason = $8,
             paused_at = $9,
             revision = revision + 1,
             updated_at = NOW()
           WHERE instance.id = $1
             AND instance.revision = $2
           RETURNING instance.*
         )
         SELECT updated.*, definition.graph
         FROM updated
         JOIN workflow_definitions AS definition
           ON definition.id = updated.workflow_id`,
        [
          instanceId,
          expectedRevision,
          JSON.stringify(input.runtime.context),
          JSON.stringify(input.runtime.nodes),
          JSON.stringify(input.runtime.edges),
          JSON.stringify(steps),
          input.status,
          input.failureReason ?? null,
          input.pausedAt === undefined ? null : input.pausedAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await appendAudits(client, instanceId, input.actorId, input.audits ?? []);
      return instanceFromRow(row);
    });
  }

  async listAudit(instanceId: string): Promise<WorkflowAuditEvent[]> {
    const result = await this.database.query<WorkflowAuditRow>(
      `SELECT * FROM workflow_audit_events
       WHERE instance_id = $1
       ORDER BY seq`,
      [instanceId],
    );
    return result.rows.map(auditFromRow);
  }

  async listApprovals(instanceId: string): Promise<WorkflowApproval[]> {
    const result = await this.database.query<WorkflowApprovalRow>(
      `SELECT * FROM workflow_approvals
       WHERE instance_id = $1
       ORDER BY created_at, node_id, approver_id`,
      [instanceId],
    );
    return result.rows.map(approvalFromRow);
  }

  async createApprovals(
    instanceId: string,
    nodeId: string,
    round: number,
    approvers: ReadonlyArray<{
      readonly actorId: string;
      readonly roleId?: string;
    }>,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      for (const approver of approvers) {
        await client.query(
          `INSERT INTO workflow_approvals (
             id, instance_id, node_id, round, approver_id,
             approver_role_id, status, note, acted_by, acted_at, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'pending', '', NULL, NULL, NOW()
           )
           ON CONFLICT (instance_id, node_id, round, approver_id) DO NOTHING`,
          [
            randomUUID(),
            instanceId,
            nodeId,
            round,
            approver.actorId,
            approver.roleId ?? null,
          ],
        );
      }
    });
  }

  async decideApproval(input: {
    readonly instanceId: string;
    readonly nodeId: string;
    readonly round: number;
    readonly actorId: string;
    readonly decision: "approve" | "reject";
    readonly note: string;
  }): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workflow_approvals
       SET
         status = $5,
         note = $6,
         acted_by = $4,
         acted_at = NOW()
       WHERE instance_id = $1
         AND node_id = $2
         AND round = $3
         AND approver_id = $4
         AND status = 'pending'`,
      [
        input.instanceId,
        input.nodeId,
        input.round,
        input.actorId,
        input.decision === "approve" ? "approved" : "rejected",
        input.note,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimCommand(
    instanceId: string,
    commandKey: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO workflow_command_receipts (
         id, instance_id, command_key, idempotency_key, created_at
       ) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (instance_id, command_key, idempotency_key) DO NOTHING`,
      [randomUUID(), instanceId, commandKey, idempotencyKey],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

async function appendAudits(
  client: PoolClient,
  instanceId: string,
  actorId: string,
  entries: ReadonlyArray<{
    readonly kind: WorkflowAuditEvent["kind"];
    readonly nodeId?: string;
    readonly summary: string;
    readonly data?: Record<string, unknown> | null;
  }>,
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO workflow_audit_events (
         id, instance_id, node_id, seq, kind, actor_id, summary, data, created_at
       )
       SELECT
         $1, $2, $3, COALESCE(MAX(seq), 0) + 1, $4, $5, $6, $7::jsonb, NOW()
       FROM workflow_audit_events
       WHERE instance_id = $2`,
      [
        randomUUID(),
        instanceId,
        entry.nodeId ?? null,
        entry.kind,
        actorId,
        entry.summary,
        entry.data === undefined || entry.data === null
          ? null
          : JSON.stringify(entry.data),
      ],
    );
  }
}

function instanceFromRow(row: WorkflowInstanceRow): WorkflowInstance {
  const graph = row.graph ?? null;
  const legacyRuntime = legacyRuntimeFromSteps(row.steps, graph);
  const storedNodes = row.runtime_nodes ?? [];
  const runtime: WorkflowRuntimeState = {
    nodes: storedNodes.length > 0 ? storedNodes : legacyRuntime.nodes,
    edges:
      row.runtime_edges.length > 0 ? row.runtime_edges : legacyRuntime.edges,
    context: row.runtime_context ?? {},
  };
  return {
    id: row.id,
    workflowId: row.workflow_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    definitionKey:
      row.definition_key === null || row.definition_key === ""
        ? (graph?.key ?? "legacy-workflow")
        : row.definition_key,
    definitionVersion:
      row.definition_key === null || row.definition_key === ""
        ? (graph?.version ?? row.definition_version ?? 1)
        : (row.definition_version ?? graph?.version ?? 1),
    parentInstanceId: row.parent_instance_id,
    parentNodeId: row.parent_node_id,
    failureReason: row.failure_reason,
    pausedAt: row.paused_at?.toISOString() ?? null,
    revision: row.revision,
    runtime,
    graph,
    currentStep: row.current_step,
    steps: row.steps,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function legacyRuntimeFromSteps(
  steps: readonly WorkflowStepState[],
  graph: WorkflowGraph | null,
): WorkflowRuntimeState {
  if (graph === null) {
    return { nodes: [], edges: [], context: {} };
  }
  const activeIndex = steps.findIndex((step) => step.status === "active");
  const completedNames = new Set(
    steps
      .filter((step) => step.status === "completed")
      .map((step) => step.name),
  );
  const activeName =
    activeIndex >= 0 ? (steps[activeIndex]?.name ?? null) : null;
  return {
    nodes: graph.nodes.map((node) => {
      const completed = completedNames.has(node.name);
      const active = node.name === activeName;
      return {
        nodeId: node.id,
        name: node.name,
        type: node.type,
        status: completed ? "completed" : active ? "ready" : "waiting",
        visits: completed || active ? 1 : 0,
        attempt: 0,
        approvalPolicy: node.approvalPolicy,
        selectedEdgeId: null,
        output: null,
        error: null,
        taskId: null,
        runId: null,
        childInstanceId: null,
        startedAt: completed || active ? new Date().toISOString() : null,
        endedAt: completed ? new Date().toISOString() : null,
        timeoutAt: null,
      };
    }),
    edges: graph.edges.map((edge) => ({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      status: "pending",
      conditionResult: null,
    })),
    context: {},
  };
}

function stepsFromRuntime(runtime: WorkflowRuntimeState): WorkflowStepState[] {
  return runtime.nodes.map((node) => ({
    stepId: randomUUID(),
    name: node.name,
    kind: node.type === "task" || node.type === "approval" ? "human" : "agent",
    status:
      node.status === "completed" || node.status === "skipped"
        ? "completed"
        : node.status === "ready" ||
            node.status === "running" ||
            node.status === "waiting_approval"
          ? "active"
          : "pending",
    completedAt:
      node.status === "completed" || node.status === "skipped"
        ? node.endedAt
        : null,
    ...(node.taskId === null ? {} : { taskId: node.taskId }),
    ...(node.runId === null ? {} : { runId: node.runId }),
  }));
}

function definitionFromRow(row: WorkflowDefinitionRow): WorkflowDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    steps: row.steps,
    sourceMarkdown: row.source_md,
    graph: row.graph,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function approvalFromRow(row: WorkflowApprovalRow): WorkflowApproval {
  return {
    id: row.id,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    round: row.round,
    approverId: row.approver_id,
    approverRoleId: row.approver_role_id,
    status: row.status,
    note: row.note,
    actedBy: row.acted_by,
    actedAt: row.acted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function auditFromRow(row: WorkflowAuditRow): WorkflowAuditEvent {
  return {
    id: row.id,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    seq: Number(row.seq),
    kind: row.kind,
    actorId: row.actor_id,
    summary: row.summary,
    data: row.data,
    createdAt: row.created_at.toISOString(),
  };
}
