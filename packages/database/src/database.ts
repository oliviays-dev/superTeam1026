import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class Database {
  private readonly pool: Pool;
  private closing: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
    });
  }

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  async close(): Promise<void> {
    this.closing ??= this.pool.end();
    await this.closing;
  }
}
