import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";

interface WorkflowIdempotencyRow {
  id: string;
  request_hash: string;
  state: "pending" | "completed" | "failed";
  response_status: number | null;
  response_body: unknown;
  updated_at: Date;
}

export type WorkflowIdempotencyBeginResult =
  | { readonly kind: "new" }
  | {
      readonly kind: "replay";
      readonly statusCode: number;
      readonly body: unknown;
    }
  | { readonly kind: "in_progress" }
  | { readonly kind: "conflict" };

export class WorkflowIdempotencyRepository {
  constructor(private readonly database: Database) {}

  async begin(input: {
    readonly scope: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<WorkflowIdempotencyBeginResult> {
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO workflow_idempotency_keys (
         id, scope, operation, idempotency_key, request_hash, state,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        input.scope,
        input.operation,
        input.idempotencyKey,
        input.requestHash,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: "new" };

    const existing = await this.database.query<WorkflowIdempotencyRow>(
      `SELECT * FROM workflow_idempotency_keys
       WHERE scope = $1 AND idempotency_key = $2`,
      [input.scope, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) return { kind: "in_progress" };
    if (row.request_hash !== input.requestHash) return { kind: "conflict" };
    if (row.state === "completed" && row.response_status !== null) {
      return {
        kind: "replay",
        statusCode: row.response_status,
        body: row.response_body,
      };
    }
    if (row.state === "failed") {
      const retried = await this.database.query(
        `UPDATE workflow_idempotency_keys
         SET state = 'pending', response_status = NULL, response_body = NULL,
             updated_at = NOW(), completed_at = NULL
         WHERE id = $1 AND state = 'failed'`,
        [row.id],
      );
      if ((retried.rowCount ?? 0) > 0) return { kind: "new" };
    }
    if (
      row.state === "pending" &&
      Date.now() - row.updated_at.getTime() >= 5 * 60 * 1_000
    ) {
      const reclaimed = await this.database.query(
        `UPDATE workflow_idempotency_keys
         SET updated_at = NOW()
         WHERE id = $1
           AND state = 'pending'
           AND updated_at = $2`,
        [row.id, row.updated_at],
      );
      if ((reclaimed.rowCount ?? 0) > 0) return { kind: "new" };
    }
    return { kind: "in_progress" };
  }

  async complete(input: {
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly statusCode: number;
    readonly body: unknown;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workflow_idempotency_keys
       SET state = 'completed', response_status = $4, response_body = $5::jsonb,
           updated_at = NOW(), completed_at = NOW()
       WHERE scope = $1
         AND idempotency_key = $2
         AND request_hash = $3
         AND state = 'pending'`,
      [
        input.scope,
        input.idempotencyKey,
        input.requestHash,
        input.statusCode,
        input.body === undefined ? null : JSON.stringify(input.body),
      ],
    );
  }

  async fail(input: {
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<void> {
    await this.database.query(
      `UPDATE workflow_idempotency_keys
       SET state = 'failed', updated_at = NOW()
       WHERE scope = $1
         AND idempotency_key = $2
         AND request_hash = $3
         AND state = 'pending'`,
      [input.scope, input.idempotencyKey, input.requestHash],
    );
  }
}
