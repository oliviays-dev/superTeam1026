import {
  AGENT_RUNTIME_BINDING_SCHEMA_SQL,
  AGENT_MANAGEMENT_SCHEMA_SQL,
  AI_TEAMMATE_SCHEMA_SQL,
  AI_DIRECT_CHAT_SCHEMA_SQL,
  COLLABORATION_SCHEMA_SQL,
  CONTEXT_SCHEMA_SQL,
  EXTERNAL_RUN_EXECUTION_SCHEMA_SQL,
  EXTERNAL_RUNTIME_SCHEMA_SQL,
  IDENTITY_PRINCIPAL_SCHEMA_SQL,
  INITIAL_SCHEMA_SQL,
  MEMORY_CLOSURE_SCHEMA_SQL,
  MEETING_AI_PARTICIPATION_SCHEMA_SQL,
  MEETING_DECISIONS_SCHEMA_SQL,
  PROJECT_MEMBERSHIP_SCHEMA_SQL,
  PROJECT_TEMPLATES_SCHEMA_SQL,
  PRODUCTION_READINESS_SCHEMA_SQL,
  RUNTIME_RELIABILITY_SCHEMA_SQL,
  RUNTIME_ECONOMICS_SCHEMA_SQL,
  RUNTIME_MAINTENANCE_EFFECTS_SCHEMA_SQL,
  TASK_DEPENDENCY_MEMORY_SCHEMA_SQL,
  TASK_COLLABORATION_SCHEMA_SQL,
  TASK_COLLABORATION_ASSET_SCHEMA_SQL,
  ACTION_TICKET_SCHEMA_SQL,
  SCENE_CONTEXT_SCHEMA_SQL,
  TASK_EXECUTION_POLICY_SCHEMA_SQL,
  TASK_EXECUTION_DEPTH_SCHEMA_SQL,
  WORKFLOW_GOVERNANCE_SCHEMA_SQL,
  WORKFLOW_MARKDOWN_SCHEMA_SQL,
  WORKFLOW_RUNTIME_SCHEMA_SQL,
  WORKBENCH_REPORTS_SCHEMA_SQL,
} from "./schema.js";
import type { Database } from "./database.js";

const migrations = [
  { version: 1, sql: INITIAL_SCHEMA_SQL },
  { version: 2, sql: CONTEXT_SCHEMA_SQL },
  { version: 3, sql: COLLABORATION_SCHEMA_SQL },
  { version: 4, sql: AGENT_MANAGEMENT_SCHEMA_SQL },
  { version: 5, sql: TASK_COLLABORATION_SCHEMA_SQL },
  { version: 6, sql: PROJECT_MEMBERSHIP_SCHEMA_SQL },
  { version: 7, sql: TASK_DEPENDENCY_MEMORY_SCHEMA_SQL },
  { version: 8, sql: TASK_COLLABORATION_ASSET_SCHEMA_SQL },
  { version: 9, sql: WORKFLOW_MARKDOWN_SCHEMA_SQL },
  { version: 10, sql: WORKFLOW_RUNTIME_SCHEMA_SQL },
  { version: 11, sql: WORKFLOW_GOVERNANCE_SCHEMA_SQL },
  { version: 12, sql: RUNTIME_RELIABILITY_SCHEMA_SQL },
  { version: 13, sql: RUNTIME_MAINTENANCE_EFFECTS_SCHEMA_SQL },
  { version: 14, sql: PRODUCTION_READINESS_SCHEMA_SQL },
  { version: 15, sql: MEETING_DECISIONS_SCHEMA_SQL },
  { version: 16, sql: MEMORY_CLOSURE_SCHEMA_SQL },
  { version: 17, sql: WORKBENCH_REPORTS_SCHEMA_SQL },
  { version: 18, sql: PROJECT_TEMPLATES_SCHEMA_SQL },
  { version: 19, sql: MEETING_AI_PARTICIPATION_SCHEMA_SQL },
  { version: 20, sql: AI_DIRECT_CHAT_SCHEMA_SQL },
  { version: 21, sql: EXTERNAL_RUNTIME_SCHEMA_SQL },
  { version: 22, sql: AGENT_RUNTIME_BINDING_SCHEMA_SQL },
  { version: 23, sql: EXTERNAL_RUN_EXECUTION_SCHEMA_SQL },
  { version: 24, sql: IDENTITY_PRINCIPAL_SCHEMA_SQL },
  { version: 25, sql: TASK_EXECUTION_POLICY_SCHEMA_SQL },
  { version: 26, sql: ACTION_TICKET_SCHEMA_SQL },
  { version: 27, sql: SCENE_CONTEXT_SCHEMA_SQL },
  { version: 28, sql: TASK_EXECUTION_DEPTH_SCHEMA_SQL },
  { version: 29, sql: RUNTIME_ECONOMICS_SCHEMA_SQL },
  { version: 30, sql: AI_TEAMMATE_SCHEMA_SQL },
] as const;

export async function migrate(
  database: Database,
  targetVersion = Number.POSITIVE_INFINITY,
): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS platform_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  for (const migration of migrations) {
    if (migration.version > targetVersion) continue;
    const applied = await database.query<{ version: number }>(
      "SELECT version FROM platform_migrations WHERE version = $1",
      [migration.version],
    );
    if (applied.rowCount !== 0) continue;

    await database.transaction(async (client) => {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO platform_migrations (version, applied_at) VALUES ($1, NOW())",
        [migration.version],
      );
    });
  }
}
