import { randomUUID } from "node:crypto";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type ResolvedTaskExecutionPolicy,
  type TaskExecutionPolicy,
  type TaskExecutionPolicyContextType,
  type TaskExecutionPolicyRecord,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";

interface TaskExecutionPolicyRow {
  id: string;
  context_type: TaskExecutionPolicyContextType;
  context_id: string;
  project_id: string | null;
  revision: number;
  policy: TaskExecutionPolicy;
  created_by: string;
  created_at: Date;
}

export type ReplaceTaskExecutionPolicyResult =
  | {
      readonly kind: "saved";
      readonly record: TaskExecutionPolicyRecord;
    }
  | {
      readonly kind: "revision_conflict";
      readonly currentRevision: number;
    };

function policyRecordFromRow(
  row: TaskExecutionPolicyRow,
): TaskExecutionPolicyRecord {
  return {
    id: row.id,
    contextType: row.context_type,
    contextId: row.context_id,
    projectId: row.project_id,
    revision: row.revision,
    policy: taskExecutionPolicySchema.parse(row.policy),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function resolved(
  record: TaskExecutionPolicyRecord,
  requestedContext: {
    readonly contextType: TaskExecutionPolicyContextType;
    readonly contextId: string;
  },
  source: "context" | "project-default",
): ResolvedTaskExecutionPolicy {
  return {
    id: record.id,
    revision: record.revision,
    version: `task-execution-policy-v1:${record.contextType}:${record.contextId}:r${record.revision}`,
    contextType: requestedContext.contextType,
    contextId: requestedContext.contextId,
    source,
    policy: record.policy,
  };
}

export class TaskExecutionPolicyRepository {
  constructor(private readonly database: Database) {}

  async get(
    contextType: TaskExecutionPolicyContextType,
    contextId: string,
  ): Promise<TaskExecutionPolicyRecord | undefined> {
    const result = await this.database.query<TaskExecutionPolicyRow>(
      `SELECT *
       FROM task_execution_policies
       WHERE context_type = $1 AND context_id = $2
       ORDER BY revision DESC
       LIMIT 1`,
      [contextType, contextId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : policyRecordFromRow(row);
  }

  async getRevision(
    id: string,
    revision: number,
  ): Promise<TaskExecutionPolicyRecord | undefined> {
    const result = await this.database.query<TaskExecutionPolicyRow>(
      `SELECT *
       FROM task_execution_policies
       WHERE id = $1 AND revision = $2`,
      [id, revision],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : policyRecordFromRow(row);
  }

  async resolve(input: {
    readonly contextType: TaskExecutionPolicyContextType;
    readonly contextId: string;
    readonly projectId?: string | null;
  }): Promise<ResolvedTaskExecutionPolicy> {
    const contextual = await this.get(input.contextType, input.contextId);
    if (contextual !== undefined) {
      return resolved(contextual, input, "context");
    }
    if (input.projectId !== undefined && input.projectId !== null) {
      const projectDefault = await this.get("project", input.projectId);
      if (projectDefault !== undefined) {
        return resolved(projectDefault, input, "project-default");
      }
    }
    return {
      id: null,
      revision: 0,
      version: "legacy-task-execution-policy-v1",
      contextType: input.contextType,
      contextId: input.contextId,
      source: "legacy",
      policy: legacyTaskExecutionPolicy(),
    };
  }

  async replace(input: {
    readonly contextType: TaskExecutionPolicyContextType;
    readonly contextId: string;
    readonly projectId: string | null;
    readonly expectedRevision: number;
    readonly policy: TaskExecutionPolicy;
    readonly actorId: string;
  }): Promise<ReplaceTaskExecutionPolicyResult> {
    const policy = taskExecutionPolicySchema.parse(input.policy);
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`task-execution-policy:${input.contextType}:${input.contextId}`],
      );
      const current = await client.query<{ revision: number }>(
        `SELECT revision
         FROM task_execution_policies
         WHERE context_type = $1 AND context_id = $2
         ORDER BY revision DESC
         LIMIT 1`,
        [input.contextType, input.contextId],
      );
      const currentRevision = current.rows[0]?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        return {
          kind: "revision_conflict" as const,
          currentRevision,
        };
      }
      const id = randomUUID();
      const revision = currentRevision + 1;
      const inserted = await client.query<TaskExecutionPolicyRow>(
        `INSERT INTO task_execution_policies (
           id, context_type, context_id, project_id, revision, policy,
           created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
         RETURNING *`,
        [
          id,
          input.contextType,
          input.contextId,
          input.projectId,
          revision,
          JSON.stringify(policy),
          input.actorId,
        ],
      );
      await client.query(
        `INSERT INTO identity_audit_events (
           id, action, decision, actor_principal_id, subject_principal_id,
           reason, metadata, created_at
         ) VALUES ($1, $2, 'allowed', $3, $3, '', $4::jsonb, NOW())`,
        [
          randomUUID(),
          currentRevision === 0
            ? "authorization.execution_policy.created"
            : "authorization.execution_policy.revised",
          input.actorId,
          JSON.stringify({
            contextType: input.contextType,
            contextId: input.contextId,
            projectId: input.projectId,
            policyId: id,
            revision,
            previousRevision: currentRevision,
          }),
        ],
      );
      return {
        kind: "saved" as const,
        record: policyRecordFromRow(inserted.rows[0]!),
      };
    });
  }
}
