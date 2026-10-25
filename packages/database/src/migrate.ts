import { INITIAL_SCHEMA_SQL } from "./schema.js";
import type { Database } from "./database.js";

const MIGRATION_VERSION = 1;

export async function migrate(database: Database): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS platform_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  const applied = await database.query<{ version: number }>(
    "SELECT version FROM platform_migrations WHERE version = $1",
    [MIGRATION_VERSION],
  );
  if (applied.rowCount !== 0) return;

  await database.transaction(async (client) => {
    await client.query(INITIAL_SCHEMA_SQL);
    await client.query(
      "INSERT INTO platform_migrations (version, applied_at) VALUES ($1, NOW())",
      [MIGRATION_VERSION],
    );
  });
}
