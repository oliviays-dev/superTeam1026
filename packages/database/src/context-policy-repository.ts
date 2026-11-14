import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  type ContextPolicy,
  type ContextPolicyScene,
  type ContextPolicyScopeType,
  type ContextPolicySettings,
  type ResetContextPolicyInput,
  type UpdateContextPolicyInput,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";

interface ContextPolicyRow {
  scope_type: ContextPolicyScopeType;
  scope_id: string;
  scene_type: ContextPolicyScene;
  warning_ratio: string | number;
  compact_ratio: string | number;
  rollover_ratio: string | number;
  preserve_recent_messages: number;
  max_trigger_depth: number;
  max_concurrent_agents_per_scene: number;
  max_context_chars: number;
  revision: number;
  updated_by: string;
  updated_at: Date;
}

export class ContextPolicyRepositoryError extends Error {
  constructor(
    readonly code: "context_policy_revision_conflict",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ContextPolicyRepositoryError";
  }
}

function settingsFromRow(row: ContextPolicyRow): ContextPolicySettings {
  return {
    warningRatio: Number(row.warning_ratio),
    compactRatio: Number(row.compact_ratio),
    rolloverRatio: Number(row.rollover_ratio),
    preserveRecentMessages: row.preserve_recent_messages,
    maxTriggerDepth: row.max_trigger_depth,
    maxConcurrentAgentsPerScene: row.max_concurrent_agents_per_scene,
    maxContextChars: row.max_context_chars,
  };
}

function policyFromRow(
  row: ContextPolicyRow,
  source: ContextPolicy["source"],
): ContextPolicy {
  return {
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    sceneType: row.scene_type,
    source,
    revision: row.revision,
    settings: settingsFromRow(row),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function builtInPolicy(
  projectId: string | null,
  sceneType: ContextPolicyScene,
): ContextPolicy {
  return {
    scopeType: projectId === null ? "platform" : "project",
    scopeId: projectId ?? "platform",
    sceneType,
    source: "built-in-default",
    revision: 0,
    settings: { ...DEFAULT_CONTEXT_POLICY_SETTINGS },
    updatedBy: "system:default",
    updatedAt: new Date(0).toISOString(),
  };
}

export class ContextPolicyRepository {
  constructor(private readonly database: Database) {}

  async effective(
    projectId: string | null,
    sceneType: ContextPolicyScene,
  ): Promise<ContextPolicy> {
    const candidates: Array<{
      scopeType: ContextPolicyScopeType;
      scopeId: string;
      scene: ContextPolicyScene;
      source: ContextPolicy["source"];
    }> = [];
    if (projectId !== null) {
      candidates.push(
        {
          scopeType: "project",
          scopeId: projectId,
          scene: sceneType,
          source: "project-override",
        },
        {
          scopeType: "project",
          scopeId: projectId,
          scene: "default",
          source: "project-default",
        },
      );
    }
    if (sceneType !== "default") {
      candidates.push({
        scopeType: "platform",
        scopeId: "platform",
        scene: sceneType,
        source: "platform-override",
      });
    }
    candidates.push({
      scopeType: "platform",
      scopeId: "platform",
      scene: "default",
      source: "platform-default",
    });
    for (const candidate of candidates) {
      const result = await this.database.query<ContextPolicyRow>(
        `SELECT *
         FROM context_policy_heads
         WHERE scope_type = $1 AND scope_id = $2 AND scene_type = $3`,
        [candidate.scopeType, candidate.scopeId, candidate.scene],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return policyFromRow(row, candidate.source);
      }
    }
    return builtInPolicy(projectId, sceneType);
  }

  async update(input: UpdateContextPolicyInput & {
    readonly actorId: string;
  }): Promise<ContextPolicy> {
    const scopeId =
      input.scopeType === "platform" ? "platform" : input.projectId!;
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`context-policy:${input.scopeType}:${scopeId}:${input.sceneType}`],
      );
      const current = await client.query<ContextPolicyRow>(
        `SELECT *
         FROM context_policy_heads
         WHERE scope_type = $1 AND scope_id = $2 AND scene_type = $3
         FOR UPDATE`,
        [input.scopeType, scopeId, input.sceneType],
      );
      const existing = current.rows[0];
      const currentRevision =
        existing?.revision ??
        (
          await this.effective(
            input.scopeType === "project" ? scopeId : null,
            input.sceneType,
          )
        ).revision;
      if (currentRevision !== input.expectedVersion) {
        throw new ContextPolicyRepositoryError(
          "context_policy_revision_conflict",
          "Context Policy changed before the update was applied",
          { expectedVersion: input.expectedVersion, currentRevision },
        );
      }
      const revision = currentRevision + 1;
      const settings = input.settings;
      const result = existing === undefined
        ? await client.query<ContextPolicyRow>(
            `INSERT INTO context_policy_heads (
               scope_type, scope_id, scene_type, warning_ratio, compact_ratio,
               rollover_ratio, preserve_recent_messages, max_trigger_depth,
               max_concurrent_agents_per_scene, max_context_chars, revision,
               updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
             )
             RETURNING *`,
            [
              input.scopeType,
              scopeId,
              input.sceneType,
              settings.warningRatio,
              settings.compactRatio,
              settings.rolloverRatio,
              settings.preserveRecentMessages,
              settings.maxTriggerDepth,
              settings.maxConcurrentAgentsPerScene,
              settings.maxContextChars,
              revision,
              input.actorId,
            ],
          )
        : await client.query<ContextPolicyRow>(
            `UPDATE context_policy_heads
             SET warning_ratio = $4,
                 compact_ratio = $5,
                 rollover_ratio = $6,
                 preserve_recent_messages = $7,
                 max_trigger_depth = $8,
                 max_concurrent_agents_per_scene = $9,
                 max_context_chars = $10,
                 revision = $11,
                 updated_by = $12,
                 updated_at = NOW()
             WHERE scope_type = $1 AND scope_id = $2 AND scene_type = $3
             RETURNING *`,
            [
              input.scopeType,
              scopeId,
              input.sceneType,
              settings.warningRatio,
              settings.compactRatio,
              settings.rolloverRatio,
              settings.preserveRecentMessages,
              settings.maxTriggerDepth,
              settings.maxConcurrentAgentsPerScene,
              settings.maxContextChars,
              revision,
              input.actorId,
            ],
          );
      await client.query(
        `INSERT INTO context_policy_versions (
           id, scope_type, scope_id, scene_type, revision, warning_ratio,
           compact_ratio, rollover_ratio, preserve_recent_messages,
           max_trigger_depth, max_concurrent_agents_per_scene,
           max_context_chars, source, updated_by, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'update',
           $13, NOW()
         )`,
        [
          randomUUID(),
          input.scopeType,
          scopeId,
          input.sceneType,
          revision,
          settings.warningRatio,
          settings.compactRatio,
          settings.rolloverRatio,
          settings.preserveRecentMessages,
          settings.maxTriggerDepth,
          settings.maxConcurrentAgentsPerScene,
          settings.maxContextChars,
          input.actorId,
        ],
      );
      await appendAuditEventWithClient(client, {
        action: "context.policy.updated",
        actorPrincipalId: input.actorId,
        metadata: {
          scopeType: input.scopeType,
          scopeId,
          sceneType: input.sceneType,
          revision,
          settings,
        },
      });
      return policyFromRow(
        result.rows[0]!,
        input.scopeType === "platform"
          ? input.sceneType === "default"
            ? "platform-default"
            : "platform-override"
          : input.sceneType === "default"
            ? "project-default"
            : "project-override",
      );
    });
  }

  async reset(input: ResetContextPolicyInput & {
    readonly actorId: string;
  }): Promise<ContextPolicy> {
    const scopeId =
      input.scopeType === "platform" ? "platform" : input.projectId!;
    const fallback =
      input.scopeType === "project"
        ? await this.effective(null, input.sceneType)
        : input.sceneType === "default"
          ? builtInPolicy(null, "default")
          : await this.effective(null, "default");
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`context-policy:${input.scopeType}:${scopeId}:${input.sceneType}`],
      );
      const current = await client.query<ContextPolicyRow>(
        `SELECT *
         FROM context_policy_heads
         WHERE scope_type = $1 AND scope_id = $2 AND scene_type = $3
         FOR UPDATE`,
        [input.scopeType, scopeId, input.sceneType],
      );
      const existing = current.rows[0];
      const currentRevision =
        existing?.revision ??
        (
          await this.effective(
            input.scopeType === "project" ? scopeId : null,
            input.sceneType,
          )
        ).revision;
      if (currentRevision !== input.expectedVersion) {
        throw new ContextPolicyRepositoryError(
          "context_policy_revision_conflict",
          "Context Policy changed before the reset was applied",
          { expectedVersion: input.expectedVersion, currentRevision },
        );
      }
      const revision = currentRevision + 1;
      const settings = fallback.settings;
      const result = existing === undefined
        ? await client.query<ContextPolicyRow>(
            `INSERT INTO context_policy_heads (
               scope_type, scope_id, scene_type, warning_ratio, compact_ratio,
               rollover_ratio, preserve_recent_messages, max_trigger_depth,
               max_concurrent_agents_per_scene, max_context_chars, revision,
               updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
             )
             RETURNING *`,
            [
              input.scopeType,
              scopeId,
              input.sceneType,
              settings.warningRatio,
              settings.compactRatio,
              settings.rolloverRatio,
              settings.preserveRecentMessages,
              settings.maxTriggerDepth,
              settings.maxConcurrentAgentsPerScene,
              settings.maxContextChars,
              revision,
              input.actorId,
            ],
          )
        : await client.query<ContextPolicyRow>(
            `UPDATE context_policy_heads
             SET warning_ratio = $4,
                 compact_ratio = $5,
                 rollover_ratio = $6,
                 preserve_recent_messages = $7,
                 max_trigger_depth = $8,
                 max_concurrent_agents_per_scene = $9,
                 max_context_chars = $10,
                 revision = $11,
                 updated_by = $12,
                 updated_at = NOW()
             WHERE scope_type = $1 AND scope_id = $2 AND scene_type = $3
             RETURNING *`,
            [
              input.scopeType,
              scopeId,
              input.sceneType,
              settings.warningRatio,
              settings.compactRatio,
              settings.rolloverRatio,
              settings.preserveRecentMessages,
              settings.maxTriggerDepth,
              settings.maxConcurrentAgentsPerScene,
              settings.maxContextChars,
              revision,
              input.actorId,
            ],
          );
      await client.query(
        `INSERT INTO context_policy_versions (
           id, scope_type, scope_id, scene_type, revision, warning_ratio,
           compact_ratio, rollover_ratio, preserve_recent_messages,
           max_trigger_depth, max_concurrent_agents_per_scene,
           max_context_chars, source, updated_by, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'reset',
           $13, NOW()
         )`,
        [
          randomUUID(),
          input.scopeType,
          scopeId,
          input.sceneType,
          revision,
          settings.warningRatio,
          settings.compactRatio,
          settings.rolloverRatio,
          settings.preserveRecentMessages,
          settings.maxTriggerDepth,
          settings.maxConcurrentAgentsPerScene,
          settings.maxContextChars,
          input.actorId,
        ],
      );
      await appendAuditEventWithClient(client, {
        action: "context.policy.reset",
        actorPrincipalId: input.actorId,
        metadata: {
          scopeType: input.scopeType,
          scopeId,
          sceneType: input.sceneType,
          revision,
          settings,
        },
      });
      return policyFromRow(
        result.rows[0]!,
        input.scopeType === "project"
          ? input.sceneType === "default"
            ? "project-default"
            : "project-override"
          : input.sceneType === "default"
            ? "platform-default"
            : "platform-override",
      );
    });
  }
}
