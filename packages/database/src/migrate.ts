import {
  COLLABORATION_SCHEMA_SQL,
  CONTEXT_SCHEMA_SQL,
  INITIAL_SCHEMA_SQL,
} from "./schema.js";
import type { Database } from "./database.js";

const migrations = [
  { version: 1, sql: INITIAL_SCHEMA_SQL },
  { version: 2, sql: CONTEXT_SCHEMA_SQL },
  { version: 3, sql: COLLABORATION_SCHEMA_SQL },
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
