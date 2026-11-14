import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

export interface AuditEventInput {
  readonly action: string;
  readonly actorPrincipalId: string | null;
  readonly subjectPrincipalId?: string | null;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function appendAuditEventWithClient(
  client: PoolClient,
  input: AuditEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_audit_events (
       id, action, decision, actor_principal_id, subject_principal_id,
       reason, metadata, created_at
     ) VALUES (
       $1, $2, 'allowed',
       (SELECT id FROM principals WHERE id = $3::text),
       (SELECT id FROM principals WHERE id = $4::text),
       $5, $6::jsonb, NOW()
     )`,
    [
      randomUUID(),
      input.action.slice(0, 160),
      input.actorPrincipalId,
      input.subjectPrincipalId ?? null,
      (input.reason ?? "").slice(0, 1_000),
      JSON.stringify({
        ...input.metadata,
        actorPrincipalId: input.actorPrincipalId,
      }),
    ],
  );
}

export class AuditEventRepository {
  constructor(private readonly database: Database) {}

  async append(input: AuditEventInput): Promise<void> {
    await this.database.transaction(async (client) => {
      await appendAuditEventWithClient(client, input);
    });
  }
}
