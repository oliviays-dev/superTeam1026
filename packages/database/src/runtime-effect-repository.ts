import { randomUUID } from "node:crypto";
import type {
  RuntimeEffectReceipt,
  RuntimeEffectStatus,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface RuntimeEffectRow {
  id: string;
  effect_key: string;
  run_id: string;
  trace_id: string | null;
  job_id: string | null;
  operation: string;
  status: RuntimeEffectStatus;
  attempt: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  replay_count: number;
  cancel_requested_at: Date | null;
  cancel_acknowledged_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

function effectFromRow(row: RuntimeEffectRow): RuntimeEffectReceipt {
  return {
    id: row.id,
    effectKey: row.effect_key,
    runId: row.run_id,
    traceId: row.trace_id,
    jobId: row.job_id,
    operation: row.operation,
    status: row.status,
    attempt: row.attempt,
    replayCount: row.replay_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    result: row.result,
    error: row.error,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    cancelAcknowledgedAt: row.cancel_acknowledged_at?.toISOString() ?? null,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface BeginRuntimeEffectInput {
  readonly effectKey: string;
  readonly runId: string;
  readonly jobId: string;
  readonly operation: string;
  readonly owner: string;
  readonly leaseSeconds: number;
}

export type BeginRuntimeEffectResult =
  | {
      readonly kind: "claimed";
      readonly receipt: RuntimeEffectReceipt;
      readonly leaseToken: string;
    }
  | { readonly kind: "replay"; readonly receipt: RuntimeEffectReceipt }
  | { readonly kind: "cancelled"; readonly receipt: RuntimeEffectReceipt }
  | { readonly kind: "busy"; readonly receipt: RuntimeEffectReceipt };

export interface RuntimeEffectControl {
  readonly cancellationRequested: boolean;
  readonly leaseLost: boolean;
  readonly status: RuntimeEffectStatus;
}

export class RuntimeEffectRepository {
  constructor(private readonly database: Database) {}

  private async lockByKey(
    client: PoolClient,
    effectKey: string,
  ): Promise<RuntimeEffectRow | undefined> {
    const result = await client.query<RuntimeEffectRow>(
      `SELECT * FROM runtime_effect_receipts
       WHERE effect_key = $1
       FOR UPDATE`,
      [effectKey],
    );
    return result.rows[0];
  }

  async begin(
    input: BeginRuntimeEffectInput,
  ): Promise<BeginRuntimeEffectResult> {
    return this.database.transaction(async (client) => {
      const leaseToken = randomUUID();
      let row = await this.lockByKey(client, input.effectKey);
      if (row === undefined) {
        const inserted = await client.query<RuntimeEffectRow>(
          `INSERT INTO runtime_effect_receipts (
             id, effect_key, run_id, trace_id, job_id, operation, status, attempt,
             lease_owner, lease_token, lease_expires_at,
             started_at, updated_at
           ) VALUES (
             $1, $2, $3, (SELECT trace_id FROM runs WHERE id = $3),
             $4, $5, 'running', 1,
             $6, $7, NOW() + ($8 || ' seconds')::interval,
             NOW(), NOW()
           )
           ON CONFLICT (effect_key) DO NOTHING
           RETURNING *`,
          [
            randomUUID(),
            input.effectKey,
            input.runId,
            input.jobId,
            input.operation,
            input.owner,
            leaseToken,
            input.leaseSeconds,
          ],
        );
        if (inserted.rows[0] !== undefined) {
          return {
            kind: "claimed",
            receipt: effectFromRow(inserted.rows[0]),
            leaseToken,
          };
        }
        row = await this.lockByKey(client, input.effectKey);
      }
      if (row === undefined) {
        throw new Error("runtime effect could not be initialized");
      }
      if (row.run_id !== input.runId || row.operation !== input.operation) {
        throw new Error("runtime effect key belongs to another effect");
      }
      if (row.status === "completed") {
        await client.query(
          `UPDATE runtime_effect_receipts
           SET replay_count = replay_count + 1, updated_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
        return {
          kind: "replay",
          receipt: effectFromRow({
            ...row,
            replay_count: row.replay_count + 1,
          }),
        };
      }
      if (row.status === "cancelled" || row.cancel_requested_at !== null) {
        return { kind: "cancelled", receipt: effectFromRow(row) };
      }
      if (
        row.status === "running" &&
        row.lease_expires_at !== null &&
        row.lease_expires_at.getTime() > Date.now()
      ) {
        return { kind: "busy", receipt: effectFromRow(row) };
      }
      const claimed = await client.query<RuntimeEffectRow>(
        `UPDATE runtime_effect_receipts
         SET
           job_id = $2,
           status = 'running',
           attempt = attempt + 1,
           lease_owner = $3,
           lease_token = $4,
           lease_expires_at = NOW() + ($5 || ' seconds')::interval,
           error = NULL,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [row.id, input.jobId, input.owner, leaseToken, input.leaseSeconds],
      );
      return {
        kind: "claimed",
        receipt: effectFromRow(claimed.rows[0]!),
        leaseToken,
      };
    });
  }

  async renew(
    effectKey: string,
    owner: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE runtime_effect_receipts
       SET
         lease_expires_at = NOW() + ($4 || ' seconds')::interval,
         updated_at = NOW()
       WHERE effect_key = $1
         AND status = 'running'
         AND lease_owner = $2
         AND lease_token = $3`,
      [effectKey, owner, leaseToken, leaseSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async control(
    effectKey: string,
    owner: string,
    leaseToken: string,
  ): Promise<RuntimeEffectControl | undefined> {
    const result = await this.database.query<{
      status: RuntimeEffectStatus;
      cancel_requested: boolean;
      lease_owned: boolean;
      run_status: string;
    }>(
      `SELECT
         effect.status,
         (
           effect.cancel_requested_at IS NOT NULL
           OR run.status = 'cancelled'
         ) AS cancel_requested,
         (
           effect.status = 'running'
           AND effect.lease_owner = $2
           AND effect.lease_token = $3
           AND effect.lease_expires_at > NOW()
         ) AS lease_owned,
         run.status AS run_status
       FROM runtime_effect_receipts AS effect
       JOIN runs AS run ON run.id = effect.run_id
       WHERE effect.effect_key = $1`,
      [effectKey, owner, leaseToken],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      cancellationRequested:
        row.cancel_requested || row.run_status === "cancelled",
      leaseLost: !row.lease_owned,
      status: row.status,
    };
  }

  async complete(
    effectKey: string,
    owner: string,
    leaseToken: string,
    result: Record<string, unknown>,
  ): Promise<RuntimeEffectReceipt | undefined> {
    const completed = await this.database.query<RuntimeEffectRow>(
      `UPDATE runtime_effect_receipts
       SET
         status = 'completed',
         result = $4::jsonb,
         error = NULL,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = NOW(),
         updated_at = NOW()
       WHERE effect_key = $1
         AND status = 'running'
         AND lease_owner = $2
         AND lease_token = $3
       RETURNING *`,
      [effectKey, owner, leaseToken, JSON.stringify(result)],
    );
    return completed.rows[0] === undefined
      ? undefined
      : effectFromRow(completed.rows[0]);
  }

  async fail(
    effectKey: string,
    owner: string,
    leaseToken: string,
    error: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE runtime_effect_receipts
       SET
         status = 'failed',
         error = $4,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = NOW(),
         updated_at = NOW()
       WHERE effect_key = $1
         AND status = 'running'
         AND lease_owner = $2
         AND lease_token = $3`,
      [effectKey, owner, leaseToken, error.slice(0, 4_000)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async acknowledgeCancellation(
    effectKey: string,
    owner: string,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE runtime_effect_receipts
       SET
         status = 'cancelled',
         cancel_acknowledged_at = NOW(),
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
       WHERE effect_key = $1
         AND status = 'running'
         AND lease_owner = $2
         AND lease_token = $3`,
      [effectKey, owner, leaseToken],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async requestCancellation(runId: string): Promise<number> {
    const result = await this.database.query(
      `UPDATE runtime_effect_receipts
       SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
           updated_at = NOW()
       WHERE run_id = $1
         AND status = 'running'`,
      [runId],
    );
    return result.rowCount ?? 0;
  }

  async reconcileExpired(limit = 100): Promise<{
    readonly cancelled: number;
    readonly failed: number;
  }> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<RuntimeEffectRow>(
        `SELECT effect.*
         FROM runtime_effect_receipts AS effect
         JOIN runs AS run ON run.id = effect.run_id
         WHERE effect.status = 'running'
           AND effect.lease_expires_at <= NOW()
         ORDER BY effect.lease_expires_at
         FOR UPDATE OF effect SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      let cancelled = 0;
      let failed = 0;
      for (const row of expired.rows) {
        const isCancelled =
          row.cancel_requested_at !== null ||
          (
            await client.query<{ status: string }>(
              "SELECT status FROM runs WHERE id = $1",
              [row.run_id],
            )
          ).rows[0]?.status === "cancelled";
        await client.query(
          `UPDATE runtime_effect_receipts
           SET
             status = $2,
             error = CASE
               WHEN $2 = 'failed' THEN 'runtime effect lease expired'
               ELSE error
             END,
             cancel_acknowledged_at =
               CASE WHEN $2 = 'cancelled' THEN NOW() ELSE NULL END,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             completed_at = NOW(),
             updated_at = NOW()
           WHERE id = $1`,
          [row.id, isCancelled ? "cancelled" : "failed"],
        );
        if (isCancelled) cancelled += 1;
        else failed += 1;
      }
      return { cancelled, failed };
    });
  }

  async listRecent(limit = 20): Promise<RuntimeEffectReceipt[]> {
    const result = await this.database.query<RuntimeEffectRow>(
      `SELECT *
       FROM runtime_effect_receipts
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(effectFromRow);
  }
}
