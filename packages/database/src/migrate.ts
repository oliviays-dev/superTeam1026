import {
  AGENT_MANAGEMENT_SCHEMA_SQL,
  COLLABORATION_SCHEMA_SQL,
  CONTEXT_SCHEMA_SQL,
  INITIAL_SCHEMA_SQL,
  PROJECT_MEMBERSHIP_SCHEMA_SQL,
  TASK_DEPENDENCY_MEMORY_SCHEMA_SQL,
  TASK_COLLABORATION_SCHEMA_SQL,
  TASK_COLLABORATION_ASSET_SCHEMA_SQL,
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
] as const;

export async function migrate(database: Database): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS platform_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  for (const migration of migrations) {
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
