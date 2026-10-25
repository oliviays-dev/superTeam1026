import type { ContextPack, ContextReceipt } from "@pluginmax/contracts";
import type { Database } from "./database.js";

export class ContextRepository {
  constructor(private readonly database: Database) {}

  async save(pack: ContextPack, receipt: ContextReceipt): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO context_packs (
           id, run_id, project_id, task_id, agent_id,
           pack, receipt, content_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         ON CONFLICT (run_id) DO UPDATE SET
           pack = EXCLUDED.pack,
           receipt = EXCLUDED.receipt,
           content_hash = EXCLUDED.content_hash`,
        [
          pack.id,
          pack.runId,
          pack.projectId,
          pack.taskId,
          pack.agentId,
          JSON.stringify(pack),
          JSON.stringify(receipt),
          pack.contentHash,
          pack.createdAt,
        ],
      );
      await client.query(
        "UPDATE runs SET context_pack_id = $2, updated_at = NOW() WHERE id = $1",
        [pack.runId, pack.id],
      );
    });
  }

  async getByRun(
    runId: string,
  ): Promise<{ pack: ContextPack; receipt: ContextReceipt } | undefined> {
    const result = await this.database.query<{
      pack: ContextPack;
      receipt: ContextReceipt;
    }>("SELECT pack, receipt FROM context_packs WHERE run_id = $1", [runId]);
    return result.rows[0];
  }
}
