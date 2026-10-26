import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeBinding,
  AgentRuntimeBindingStatus,
  ExternalRuntimeProbe,
  ExternalRuntimeStatus,
  RuntimePreflightErrorCode,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";

interface AgentRuntimeBindingRow {
  id: string;
  agent_id: string;
  runtime_id: string;
  execution_mode: "external";
  status: AgentRuntimeBindingStatus;
  revision: number;
  bound_by: string;
  disabled_by: string | null;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
}

interface RuntimeBindingSourceRow {
  id: string;
  status: ExternalRuntimeStatus;
  revision: number;
  command_digest: string;
  args_digest: string;
  last_probe_id: string | null;
}

interface RuntimeProbeSourceRow {
  id: string;
  runtime_revision: number;
  status: ExternalRuntimeProbe["status"];
  command_digest: string;
  args_digest: string;
}

interface AgentSourceRow {
  id: string;
  status: "active" | "disabled";
}

type BindingFailureCode = Extract<
  RuntimePreflightErrorCode,
  | "agent_not_found"
  | "agent_unavailable"
  | "runtime_not_found"
  | "runtime_inactive"
  | "runtime_archived"
  | "runtime_probe_missing"
  | "runtime_probe_pending"
  | "runtime_probe_failed"
  | "runtime_probe_stale"
  | "runtime_command_digest_mismatch"
  | "runtime_args_digest_mismatch"
>;

export type SetAgentRuntimeBindingResult =
  | {
      readonly kind: "bound";
      readonly binding: AgentRuntimeBinding;
    }
  | {
      readonly kind: "unchanged";
      readonly binding: AgentRuntimeBinding;
    }
  | {
      readonly kind: "failed";
      readonly code: BindingFailureCode;
      readonly message: string;
    }
  | { readonly kind: "revision_conflict" };

export type RemoveAgentRuntimeBindingResult =
  | {
      readonly kind: "removed";
      readonly binding: AgentRuntimeBinding;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict" };

export interface DisabledRuntimeBinding {
  readonly binding: AgentRuntimeBinding;
  readonly runtimeStatus: ExternalRuntimeStatus;
}

function bindingFromRow(row: AgentRuntimeBindingRow): AgentRuntimeBinding {
  return {
    id: row.id,
    agentId: row.agent_id,
    runtimeId: row.runtime_id,
    executionMode: row.execution_mode,
    status: row.status,
    revision: row.revision,
    boundBy: row.bound_by,
    disabledBy: row.disabled_by,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null,
  };
}

function bindingState(binding: AgentRuntimeBinding): Record<string, unknown> {
  return {
    id: binding.id,
    agentId: binding.agentId,
    runtimeId: binding.runtimeId,
    executionMode: binding.executionMode,
    status: binding.status,
    revision: binding.revision,
    boundBy: binding.boundBy,
    disabledBy: binding.disabledBy,
    disabledReason: binding.disabledReason,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    disabledAt: binding.disabledAt,
  };
}

async function insertBindingEvent(
  client: PoolClient,
  input: {
    readonly runtimeId: string;
    readonly agentId: string;
    readonly kind: "bound" | "unbound";
    readonly actorId: string;
    readonly runtimeStatus: ExternalRuntimeStatus;
    readonly previous: AgentRuntimeBinding | null;
    readonly next: AgentRuntimeBinding;
    readonly message: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO external_runtime_events (
       id, runtime_id, agent_id, kind, actor_id, previous_status, next_status,
       changed_fields, previous_state, next_state, message, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $6, '["binding"]'::jsonb,
       $7::jsonb, $8::jsonb, $9, NOW()
     )`,
    [
      randomUUID(),
      input.runtimeId,
      input.agentId,
      input.kind,
      input.actorId,
      input.runtimeStatus,
      input.previous === null
        ? null
        : JSON.stringify(bindingState(input.previous)),
      JSON.stringify(bindingState(input.next)),
      input.message.slice(0, 4_000),
    ],
  );
}

function validateProbeForBinding(
  runtime: RuntimeBindingSourceRow,
  probe: RuntimeProbeSourceRow | undefined,
): Extract<SetAgentRuntimeBindingResult, { kind: "failed" }> | undefined {
  if (runtime.status === "archived") {
    return {
      kind: "failed",
      code: "runtime_archived",
      message: "Archived runtimes cannot be bound to an agent",
    };
  }
  if (runtime.status !== "active") {
    return {
      kind: "failed",
      code: "runtime_inactive",
      message: "Only an active external runtime can be bound to an agent",
    };
  }
  if (probe === undefined) {
    return {
      kind: "failed",
      code: "runtime_probe_missing",
      message: "The runtime has no probe for its current revision",
    };
  }
  if (probe.id !== runtime.last_probe_id) {
    return {
      kind: "failed",
      code: "runtime_probe_stale",
      message: "The runtime no longer references the latest probe",
    };
  }
  if (probe.command_digest !== runtime.command_digest) {
    return {
      kind: "failed",
      code: "runtime_command_digest_mismatch",
      message: "The latest runtime probe does not match the current command",
    };
  }
  if (probe.args_digest !== runtime.args_digest) {
    return {
      kind: "failed",
      code: "runtime_args_digest_mismatch",
      message: "The latest runtime probe does not match the current arguments",
    };
  }
  if (probe.status === "requested" || probe.status === "running") {
    return {
      kind: "failed",
      code: "runtime_probe_pending",
      message: "The latest runtime probe is still pending",
    };
  }
  if (probe.status === "failed") {
    return {
      kind: "failed",
      code: "runtime_probe_failed",
      message: "The latest runtime probe failed",
    };
  }
  return undefined;
}

async function currentBindingForUpdate(
  client: PoolClient,
  agentId: string,
): Promise<AgentRuntimeBindingRow | undefined> {
  const result = await client.query<AgentRuntimeBindingRow>(
    `SELECT * FROM agent_runtime_bindings
     WHERE agent_id = $1 AND status = 'active'
     FOR UPDATE`,
    [agentId],
  );
  return result.rows[0];
}

async function lockAgentBindingScope(
  client: PoolClient,
  agentId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`agent-runtime-binding:${agentId}`],
  );
}

export class AgentRuntimeBindingRepository {
  constructor(private readonly database: Database) {}

  async getCurrent(agentId: string): Promise<AgentRuntimeBinding | undefined> {
    const result = await this.database.query<AgentRuntimeBindingRow>(
      `SELECT * FROM agent_runtime_bindings
       WHERE agent_id = $1
       ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC, id DESC
       LIMIT 1`,
      [agentId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : bindingFromRow(row);
  }

  async listHistory(agentId: string): Promise<AgentRuntimeBinding[]> {
    const result = await this.database.query<AgentRuntimeBindingRow>(
      `SELECT * FROM agent_runtime_bindings
       WHERE agent_id = $1
       ORDER BY created_at DESC, id DESC`,
      [agentId],
    );
    return result.rows.map(bindingFromRow);
  }

  async set(input: {
    readonly agentId: string;
    readonly runtimeId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  }): Promise<SetAgentRuntimeBindingResult> {
    return this.database.transaction(async (client) => {
      await lockAgentBindingScope(client, input.agentId);
      const agentResult = await client.query<AgentSourceRow>(
        "SELECT id, status FROM agents WHERE id = $1",
        [input.agentId],
      );
      const agent = agentResult.rows[0];
      if (agent === undefined) {
        return {
          kind: "failed",
          code: "agent_not_found",
          message: "Agent not found",
        } as const;
      }
      if (agent.status !== "active") {
        return {
          kind: "failed",
          code: "agent_unavailable",
          message: "Only an active agent can bind an external runtime",
        } as const;
      }

      const runtimeResult = await client.query<RuntimeBindingSourceRow>(
        `SELECT
           id, status, revision, command_digest, args_digest, last_probe_id
         FROM external_runtimes
         WHERE id = $1
         FOR UPDATE`,
        [input.runtimeId],
      );
      const runtime = runtimeResult.rows[0];
      if (runtime === undefined) {
        return {
          kind: "failed",
          code: "runtime_not_found",
          message: "External runtime not found",
        } as const;
      }

      const currentRow = await currentBindingForUpdate(client, input.agentId);
      const current =
        currentRow === undefined ? undefined : bindingFromRow(currentRow);
      const expectedCurrentRevision = current?.revision ?? 0;
      if (expectedCurrentRevision !== input.expectedRevision) {
        return { kind: "revision_conflict" } as const;
      }
      if (current?.runtimeId === input.runtimeId) {
        return { kind: "unchanged", binding: current } as const;
      }

      const probeResult = await client.query<RuntimeProbeSourceRow>(
        `SELECT id, runtime_revision, status, command_digest, args_digest
         FROM external_runtime_probes
         WHERE runtime_id = $1
         ORDER BY requested_at DESC, id DESC
         LIMIT 1`,
        [input.runtimeId],
      );
      const invalid = validateProbeForBinding(runtime, probeResult.rows[0]);
      if (invalid !== undefined) return invalid;

      if (current !== undefined) {
        const disabledResult = await client.query<AgentRuntimeBindingRow>(
          `UPDATE agent_runtime_bindings
           SET
             status = 'disabled',
             revision = revision + 1,
             disabled_by = $2,
             disabled_reason = 'replaced by a new external runtime binding',
             disabled_at = NOW(),
             updated_at = NOW()
           WHERE id = $1 AND status = 'active'
           RETURNING *`,
          [current.id, input.actorId],
        );
        const disabledRow = disabledResult.rows[0];
        if (disabledRow === undefined) {
          return { kind: "revision_conflict" } as const;
        }
        const disabled = bindingFromRow(disabledRow);
        await insertBindingEvent(client, {
          runtimeId: current.runtimeId,
          agentId: current.agentId,
          kind: "unbound",
          actorId: input.actorId,
          runtimeStatus: runtime.status,
          previous: current,
          next: disabled,
          message: "Agent external runtime binding was replaced",
        });
      }

      const inserted = await client.query<AgentRuntimeBindingRow>(
        `INSERT INTO agent_runtime_bindings (
           id, agent_id, runtime_id, execution_mode, status, revision,
           bound_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'external', 'active', 1, $4, NOW(), NOW()
         )
         RETURNING *`,
        [randomUUID(), input.agentId, input.runtimeId, input.actorId],
      );
      const binding = bindingFromRow(inserted.rows[0]!);
      await insertBindingEvent(client, {
        runtimeId: input.runtimeId,
        agentId: input.agentId,
        kind: "bound",
        actorId: input.actorId,
        runtimeStatus: runtime.status,
        previous: null,
        next: binding,
        message: "Agent was bound to an external runtime",
      });
      return { kind: "bound", binding } as const;
    });
  }

  async remove(input: {
    readonly agentId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<RemoveAgentRuntimeBindingResult> {
    return this.database.transaction(async (client) => {
      await lockAgentBindingScope(client, input.agentId);
      const currentRow = await currentBindingForUpdate(client, input.agentId);
      if (currentRow === undefined) return { kind: "not_found" } as const;
      if (currentRow.revision !== input.expectedRevision) {
        return { kind: "revision_conflict" } as const;
      }
      const updated = await client.query<AgentRuntimeBindingRow>(
        `UPDATE agent_runtime_bindings
         SET
           status = 'disabled',
           revision = revision + 1,
           disabled_by = $2,
           disabled_reason = $3,
           disabled_at = NOW(),
           updated_at = NOW()
         WHERE id = $1 AND status = 'active' AND revision = $4
         RETURNING *`,
        [
          currentRow.id,
          input.actorId,
          input.reason.slice(0, 1_000),
          input.expectedRevision,
        ],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        return { kind: "revision_conflict" } as const;
      }
      const current = bindingFromRow(currentRow);
      const binding = bindingFromRow(updatedRow);
      const runtime = await client.query<{ status: ExternalRuntimeStatus }>(
        "SELECT status FROM external_runtimes WHERE id = $1",
        [current.runtimeId],
      );
      await insertBindingEvent(client, {
        runtimeId: current.runtimeId,
        agentId: current.agentId,
        kind: "unbound",
        actorId: input.actorId,
        runtimeStatus: runtime.rows[0]?.status ?? "disabled",
        previous: current,
        next: binding,
        message: "Agent was explicitly unbound from its external runtime",
      });
      return { kind: "removed", binding } as const;
    });
  }
}

export async function disableActiveAgentRuntimeBindingsWithClient(
  client: PoolClient,
  input: {
    readonly runtimeId: string;
    readonly runtimeStatus: ExternalRuntimeStatus;
    readonly actorId: string;
    readonly reason: string;
  },
): Promise<DisabledRuntimeBinding[]> {
  const active = await client.query<AgentRuntimeBindingRow>(
    `SELECT * FROM agent_runtime_bindings
     WHERE runtime_id = $1 AND status = 'active'
     FOR UPDATE`,
    [input.runtimeId],
  );
  const disabled: DisabledRuntimeBinding[] = [];
  for (const previousRow of active.rows) {
    const updated = await client.query<AgentRuntimeBindingRow>(
      `UPDATE agent_runtime_bindings
       SET
         status = 'disabled',
         revision = revision + 1,
         disabled_by = $2,
         disabled_reason = $3,
         disabled_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [previousRow.id, input.actorId, input.reason.slice(0, 1_000)],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) continue;
    const previous = bindingFromRow(previousRow);
    const binding = bindingFromRow(updatedRow);
    await insertBindingEvent(client, {
      runtimeId: input.runtimeId,
      agentId: previous.agentId,
      kind: "unbound",
      actorId: input.actorId,
      runtimeStatus: input.runtimeStatus,
      previous,
      next: binding,
      message: input.reason.slice(0, 4_000),
    });
    disabled.push({ binding, runtimeStatus: input.runtimeStatus });
  }
  return disabled;
}
