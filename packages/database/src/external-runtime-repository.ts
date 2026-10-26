import { createHash, randomUUID } from "node:crypto";
import {
  adapterCapabilityProfile,
  canTransitionExternalRuntimeStatus,
  declaredCapabilityProfile,
  emptyExternalRuntimeCapabilitySet,
  mergeCapabilityProfiles,
  type CreateExternalRuntimeInput,
  type ExternalRuntime,
  type ExternalRuntimeCapabilitySnapshot,
  type ExternalRuntimeEvent,
  type ExternalRuntimeEventKind,
  type ExternalRuntimeProbe,
  type ExternalRuntimeProbeSummary,
  type ExternalRuntimeStatus,
  type RuntimeToolName,
  type UpdateExternalRuntimeInput,
} from "@pluginmax/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "./database.js";

interface ExternalRuntimeRow {
  id: string;
  name: string;
  provider: ExternalRuntime["provider"];
  protocol: ExternalRuntime["protocol"];
  command: string;
  managed_args: string[];
  custom_args: string[];
  supported_models: string[];
  default_model: string | null;
  context_window_tokens: number | null;
  supported_tools: RuntimeToolName[];
  network_mode: ExternalRuntime["networkMode"];
  sandbox_mode: ExternalRuntime["sandboxMode"];
  status: ExternalRuntimeStatus;
  visibility: ExternalRuntime["visibility"];
  owner_id: string;
  revision: number;
  command_digest: string;
  args_digest: string;
  last_probe_id: string | null;
  last_probe_at: Date | null;
  last_probe_ok: boolean | null;
  last_probe_message: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface ExternalRuntimeProbeRow {
  id: string;
  runtime_id: string;
  runtime_revision: number;
  requested_by: string;
  status: ExternalRuntimeProbe["status"];
  command_digest: string;
  args_digest: string;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  exit_code: number | null;
  timed_out: boolean;
  runtime_version: string | null;
  stdout_excerpt: string | null;
  stderr_excerpt: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ExternalRuntimeCapabilityRow {
  id: string;
  runtime_id: string;
  runtime_revision: number;
  probe_id: string;
  adapter_profile: ExternalRuntimeCapabilitySnapshot["adapterProfile"];
  declared_profile: ExternalRuntimeCapabilitySnapshot["declaredProfile"];
  probe_profile: ExternalRuntimeCapabilitySnapshot["probeProfile"];
  effective_profile: ExternalRuntimeCapabilitySnapshot["effectiveProfile"];
  captured_at: Date;
}

interface ExternalRuntimeEventRow {
  id: string;
  runtime_id: string;
  kind: ExternalRuntimeEventKind;
  actor_id: string;
  previous_status: ExternalRuntimeStatus | null;
  next_status: ExternalRuntimeStatus;
  changed_fields: string[];
  previous_state: Record<string, unknown> | null;
  next_state: Record<string, unknown>;
  message: string;
  created_at: Date;
}

interface ProbeJobRow {
  id: string;
  runtime_id: string;
  probe_id: string;
  outbox_id: string;
  status: "queued" | "running" | "completed" | "dead_letter";
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
}

export interface ClaimedRuntimeProbeJob {
  readonly jobId: string;
  readonly runtime: ExternalRuntime;
  readonly probe: ExternalRuntimeProbe;
  readonly leaseToken: string;
}

export interface CompleteRuntimeProbeInput {
  readonly jobId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutExcerpt: string;
  readonly stderrExcerpt: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type RuntimeTransitionResult =
  | { readonly kind: "updated"; readonly runtime: ExternalRuntime }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "probe_required" };

export type RequestRuntimeProbeResult =
  | {
      readonly kind: "requested";
      readonly runtime: ExternalRuntime;
      readonly probe: ExternalRuntimeProbe;
      readonly jobId: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict" }
  | { readonly kind: "archived" }
  | { readonly kind: "probe_in_progress" };

export type UpdateRuntimeDefinitionResult =
  | { readonly kind: "updated"; readonly runtime: ExternalRuntime }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict" };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function externalRuntimeCommandDigest(command: string): string {
  return digest(command.trim());
}

export function externalRuntimeArgsDigest(
  managedArgs: readonly string[],
  customArgs: readonly string[],
): string {
  return digest(JSON.stringify([...managedArgs, ...customArgs]));
}

function probeSummary(row: ExternalRuntimeProbeRow): ExternalRuntimeProbeSummary {
  return {
    id: row.id,
    runtimeRevision: row.runtime_revision,
    status: row.status,
    ok:
      row.status === "passed"
        ? true
        : row.status === "failed"
          ? false
          : null,
    message: row.error_message,
    exitCode: row.exit_code,
    timedOut: row.timed_out,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function runtimeFromRow(
  row: ExternalRuntimeRow,
  latestProbe?: ExternalRuntimeProbeRow,
): ExternalRuntime {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    protocol: row.protocol,
    command: row.command,
    managedArgs: row.managed_args,
    customArgs: row.custom_args,
    supportedModels: row.supported_models,
    defaultModel: row.default_model,
    contextWindowTokens: row.context_window_tokens,
    supportedTools: row.supported_tools,
    networkMode: row.network_mode,
    sandboxMode: row.sandbox_mode,
    status: row.status,
    visibility: row.visibility,
    ownerId: row.owner_id,
    revision: row.revision,
    commandDigest: row.command_digest,
    argsDigest: row.args_digest,
    lastProbe: latestProbe === undefined ? null : probeSummary(latestProbe),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

function probeFromRow(row: ExternalRuntimeProbeRow): ExternalRuntimeProbe {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    runtimeRevision: row.runtime_revision,
    requestedBy: row.requested_by,
    status: row.status,
    commandDigest: row.command_digest,
    argsDigest: row.args_digest,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    timedOut: row.timed_out,
    runtimeVersion: row.runtime_version,
    stdoutExcerpt: row.stdout_excerpt,
    stderrExcerpt: row.stderr_excerpt,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function capabilityFromRow(
  row: ExternalRuntimeCapabilityRow,
): ExternalRuntimeCapabilitySnapshot {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    runtimeRevision: row.runtime_revision,
    probeId: row.probe_id,
    adapterProfile: row.adapter_profile,
    declaredProfile: row.declared_profile,
    probeProfile: row.probe_profile,
    effectiveProfile: row.effective_profile,
    capturedAt: row.captured_at.toISOString(),
  };
}

function eventFromRow(row: ExternalRuntimeEventRow): ExternalRuntimeEvent {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    kind: row.kind,
    actorId: row.actor_id,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    changedFields: row.changed_fields,
    previousState: row.previous_state,
    nextState: row.next_state,
    message: row.message,
    createdAt: row.created_at.toISOString(),
  };
}

function runtimeState(runtime: ExternalRuntime): Record<string, unknown> {
  return {
    id: runtime.id,
    name: runtime.name,
    provider: runtime.provider,
    protocol: runtime.protocol,
    command: runtime.command,
    managedArgs: runtime.managedArgs,
    customArgs: runtime.customArgs,
    supportedModels: runtime.supportedModels,
    defaultModel: runtime.defaultModel,
    contextWindowTokens: runtime.contextWindowTokens,
    supportedTools: runtime.supportedTools,
    networkMode: runtime.networkMode,
    sandboxMode: runtime.sandboxMode,
    status: runtime.status,
    visibility: runtime.visibility,
    ownerId: runtime.ownerId,
    revision: runtime.revision,
    commandDigest: runtime.commandDigest,
    argsDigest: runtime.argsDigest,
    lastProbe: runtime.lastProbe,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    archivedAt: runtime.archivedAt,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedDefinitionFields(
  previous: ExternalRuntime,
  next: ExternalRuntime,
): string[] {
  const fields: Array<keyof ExternalRuntime> = [
    "name",
    "provider",
    "protocol",
    "command",
    "managedArgs",
    "customArgs",
    "supportedModels",
    "defaultModel",
    "contextWindowTokens",
    "supportedTools",
    "networkMode",
    "sandboxMode",
    "visibility",
  ];
  return fields.filter(
    (field) => !sameJson(previous[field], next[field]),
  );
}

async function insertEvent(
  client: PoolClient,
  input: {
    readonly runtimeId: string;
    readonly kind: ExternalRuntimeEventKind;
    readonly actorId: string;
    readonly previous: ExternalRuntime | null;
    readonly next: ExternalRuntime;
    readonly changedFields: readonly string[];
    readonly message: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO external_runtime_events (
       id, runtime_id, kind, actor_id, previous_status, next_status,
       changed_fields, previous_state, next_state, message, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, NOW()
     )`,
    [
      randomUUID(),
      input.runtimeId,
      input.kind,
      input.actorId,
      input.previous?.status ?? null,
      input.next.status,
      JSON.stringify(input.changedFields),
      input.previous === null
        ? null
        : JSON.stringify(runtimeState(input.previous)),
      JSON.stringify(runtimeState(input.next)),
      input.message.slice(0, 4_000),
    ],
  );
}

interface ExternalRuntimeQueryable {
  query<R extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

async function latestProbeFor(
  queryable: ExternalRuntimeQueryable,
  runtimeId: string,
): Promise<ExternalRuntimeProbeRow | undefined> {
  const result = await queryable.query<ExternalRuntimeProbeRow>(
    `SELECT * FROM external_runtime_probes
     WHERE runtime_id = $1
     ORDER BY requested_at DESC, id DESC
     LIMIT 1`,
    [runtimeId],
  );
  return result.rows[0];
}

async function runtimeForClient(
  client: PoolClient,
  runtimeId: string,
  lock = false,
): Promise<{ row: ExternalRuntimeRow; runtime: ExternalRuntime } | undefined> {
  const result = await client.query<ExternalRuntimeRow>(
    `SELECT * FROM external_runtimes
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [runtimeId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    row,
    runtime: runtimeFromRow(row, await latestProbeFor(client, runtimeId)),
  };
}

function excerpt(value: string): string {
  return value.slice(0, 2_000);
}

export class ExternalRuntimeRepository {
  constructor(private readonly database: Database) {}

  async list(input: {
    readonly actorId: string;
    readonly administrator: boolean;
    readonly includeArchived: boolean;
  }): Promise<ExternalRuntime[]> {
    const result = await this.database.query<ExternalRuntimeRow>(
      `SELECT * FROM external_runtimes
       WHERE (
         $1::boolean
         OR visibility = 'platform'
         OR owner_id = $2
       )
       AND ($3::boolean OR status <> 'archived')
       ORDER BY updated_at DESC, name`,
      [input.administrator, input.actorId, input.includeArchived],
    );
    return Promise.all(
      result.rows.map(async (row) =>
        runtimeFromRow(row, await latestProbeFor(this.database, row.id)),
      ),
    );
  }

  async get(runtimeId: string): Promise<ExternalRuntime | undefined> {
    const result = await this.database.query<ExternalRuntimeRow>(
      "SELECT * FROM external_runtimes WHERE id = $1",
      [runtimeId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : runtimeFromRow(row, await latestProbeFor(this.database, runtimeId));
  }

  async create(
    input: CreateExternalRuntimeInput,
    ownerId: string,
    actorId: string,
  ): Promise<ExternalRuntime> {
    const id = randomUUID();
    const commandDigest = externalRuntimeCommandDigest(input.command);
    const argsDigest = externalRuntimeArgsDigest(
      input.managedArgs,
      input.customArgs,
    );
    return this.database.transaction(async (client) => {
      const result = await client.query<ExternalRuntimeRow>(
        `INSERT INTO external_runtimes (
           id, name, provider, protocol, command, managed_args, custom_args,
           supported_models, default_model, context_window_tokens,
           supported_tools, network_mode, sandbox_mode, status, visibility,
           owner_id, revision, command_digest, args_digest,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
           $8::jsonb, $9, $10, $11::jsonb, $12, $13, 'disabled', $14,
           $15, 1, $16, $17, NOW(), NOW()
         )
         RETURNING *`,
        [
          id,
          input.name,
          input.provider,
          input.protocol,
          input.command,
          JSON.stringify(input.managedArgs),
          JSON.stringify(input.customArgs),
          JSON.stringify(input.supportedModels),
          input.defaultModel,
          input.contextWindowTokens,
          JSON.stringify(input.supportedTools),
          input.networkMode,
          input.sandboxMode,
          input.visibility,
          ownerId,
          commandDigest,
          argsDigest,
        ],
      );
      const runtime = runtimeFromRow(result.rows[0]!);
      await insertEvent(client, {
        runtimeId: id,
        kind: "registered",
        actorId,
        previous: null,
        next: runtime,
        changedFields: ["runtime"],
        message: `注册外部运行时“${runtime.name}”`,
      });
      return runtime;
    });
  }

  async updateDefinition(input: {
    readonly runtimeId: string;
    readonly current: ExternalRuntime;
    readonly update: UpdateExternalRuntimeInput;
    readonly merged: ExternalRuntime;
    readonly actorId: string;
  }): Promise<UpdateRuntimeDefinitionResult> {
    return this.database.transaction(async (client) => {
      const locked = await runtimeForClient(client, input.runtimeId, true);
      if (locked === undefined) return { kind: "not_found" } as const;
      if (locked.row.revision !== input.update.expectedRevision) {
        return { kind: "revision_conflict" } as const;
      }
      const commandDigest = externalRuntimeCommandDigest(
        input.merged.command,
      );
      const argsDigest = externalRuntimeArgsDigest(
        input.merged.managedArgs,
        input.merged.customArgs,
      );
      const commandChanged =
        commandDigest !== locked.row.command_digest ||
        argsDigest !== locked.row.args_digest;
      const changedFields = changedDefinitionFields(locked.runtime, {
        ...input.merged,
        commandDigest,
        argsDigest,
        status: commandChanged ? "disabled" : locked.runtime.status,
        revision: locked.row.revision + 1,
        lastProbe: commandChanged ? null : locked.runtime.lastProbe,
      });
      if (commandChanged) {
        await client.query(
          `UPDATE domain_outbox
           SET status = 'superseded', published_at = NOW()
           WHERE topic = 'runtime.probe'
             AND status = 'pending'
             AND payload ->> 'runtimeId' = $1::text`,
          [input.runtimeId],
        );
        await client.query(
          "DELETE FROM runtime_probe_jobs WHERE runtime_id = $1",
          [input.runtimeId],
        );
        await client.query(
          "DELETE FROM external_runtime_probes WHERE runtime_id = $1",
          [input.runtimeId],
        );
      }
      const result = await client.query<ExternalRuntimeRow>(
        `UPDATE external_runtimes
         SET
           name = $2,
           provider = $3,
           protocol = $4,
           command = $5,
           managed_args = $6::jsonb,
           custom_args = $7::jsonb,
           supported_models = $8::jsonb,
           default_model = $9,
           context_window_tokens = $10,
           supported_tools = $11::jsonb,
           network_mode = $12,
           sandbox_mode = $13,
           visibility = $14,
           status = CASE WHEN $15::boolean THEN 'disabled' ELSE status END,
           revision = revision + 1,
           command_digest = $16,
           args_digest = $17,
           last_probe_id = CASE WHEN $15::boolean THEN NULL ELSE last_probe_id END,
           last_probe_at = CASE WHEN $15::boolean THEN NULL ELSE last_probe_at END,
           last_probe_ok = CASE WHEN $15::boolean THEN NULL ELSE last_probe_ok END,
           last_probe_message =
             CASE WHEN $15::boolean THEN NULL ELSE last_probe_message END,
           archived_at = CASE WHEN $15::boolean THEN NULL ELSE archived_at END,
           updated_at = NOW()
         WHERE id = $1
           AND revision = $18
         RETURNING *`,
        [
          input.runtimeId,
          input.merged.name,
          input.merged.provider,
          input.merged.protocol,
          input.merged.command,
          JSON.stringify(input.merged.managedArgs),
          JSON.stringify(input.merged.customArgs),
          JSON.stringify(input.merged.supportedModels),
          input.merged.defaultModel,
          input.merged.contextWindowTokens,
          JSON.stringify(input.merged.supportedTools),
          input.merged.networkMode,
          input.merged.sandboxMode,
          input.merged.visibility,
          commandChanged,
          commandDigest,
          argsDigest,
          input.update.expectedRevision,
        ],
      );
      const updatedRow = result.rows[0];
      if (updatedRow === undefined) {
        return { kind: "revision_conflict" } as const;
      }
      const updated = runtimeFromRow(
        updatedRow,
        commandChanged
          ? undefined
          : await latestProbeFor(client, input.runtimeId),
      );
      await insertEvent(client, {
        runtimeId: input.runtimeId,
        kind: "updated",
        actorId: input.actorId,
        previous: locked.runtime,
        next: updated,
        changedFields:
          commandChanged && !changedFields.includes("probe")
            ? [...changedFields, "probe"]
            : changedFields,
        message: commandChanged
          ? `更新外部运行时“${updated.name}”，旧 Probe 已清空`
          : `更新外部运行时“${updated.name}”`,
      });
      return { kind: "updated", runtime: updated } as const;
    });
  }

  async transition(input: {
    readonly runtimeId: string;
    readonly expectedRevision: number;
    readonly nextStatus: ExternalRuntimeStatus;
    readonly actorId: string;
    readonly requirePassedProbe: boolean;
  }): Promise<RuntimeTransitionResult> {
    return this.database.transaction(async (client) => {
      const locked = await runtimeForClient(client, input.runtimeId, true);
      if (locked === undefined) return { kind: "not_found" } as const;
      if (locked.row.revision !== input.expectedRevision) {
        return { kind: "revision_conflict" } as const;
      }
      if (
        !canTransitionExternalRuntimeStatus(
          locked.runtime.status,
          input.nextStatus,
        )
      ) {
        return { kind: "invalid_transition" } as const;
      }
      if (input.requirePassedProbe) {
        const latest = await latestProbeFor(client, input.runtimeId);
        if (
          latest === undefined ||
          latest.status !== "passed" ||
          latest.runtime_revision !== locked.row.revision ||
          latest.command_digest !== locked.row.command_digest ||
          latest.args_digest !== locked.row.args_digest
        ) {
          return { kind: "probe_required" } as const;
        }
      }
      if (
        input.nextStatus === "archived" ||
        input.nextStatus === "disabled"
      ) {
        await client.query(
          `UPDATE domain_outbox
           SET status = 'superseded', published_at = NOW()
           WHERE topic = 'runtime.probe'
             AND status = 'pending'
             AND payload ->> 'runtimeId' = $1::text`,
          [input.runtimeId],
        );
        await client.query(
          `DELETE FROM runtime_probe_jobs
           WHERE runtime_id = $1 AND status = 'queued'`,
          [input.runtimeId],
        );
        await client.query(
          `DELETE FROM external_runtime_probes
           WHERE runtime_id = $1 AND status = 'requested'`,
          [input.runtimeId],
        );
      }
      const result = await client.query<ExternalRuntimeRow>(
        `UPDATE external_runtimes
         SET
           status = $2,
           revision = revision + 1,
           archived_at =
             CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END,
           updated_at = NOW()
         WHERE id = $1
           AND revision = $3
         RETURNING *`,
        [input.runtimeId, input.nextStatus, input.expectedRevision],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "revision_conflict" } as const;
      const runtime = runtimeFromRow(
        row,
        await latestProbeFor(client, input.runtimeId),
      );
      const kind: ExternalRuntimeEventKind =
        input.nextStatus === "active"
          ? "enabled"
          : input.nextStatus === "archived"
            ? "archived"
            : locked.runtime.status === "archived"
              ? "restored"
              : "disabled";
      await insertEvent(client, {
        runtimeId: input.runtimeId,
        kind,
        actorId: input.actorId,
        previous: locked.runtime,
        next: runtime,
        changedFields: ["status", "revision"],
        message:
          kind === "enabled"
            ? `启用外部运行时“${runtime.name}”`
            : kind === "archived"
              ? `归档外部运行时“${runtime.name}”`
              : kind === "restored"
                ? `复原外部运行时“${runtime.name}”`
                : `停用外部运行时“${runtime.name}”`,
      });
      return { kind: "updated", runtime } as const;
    });
  }

  async requestProbe(input: {
    readonly runtimeId: string;
    readonly expectedRevision: number;
    readonly actorId: string;
  }): Promise<RequestRuntimeProbeResult> {
    return this.database.transaction(async (client) => {
      const locked = await runtimeForClient(client, input.runtimeId, true);
      if (locked === undefined) return { kind: "not_found" } as const;
      if (locked.row.revision !== input.expectedRevision) {
        return { kind: "revision_conflict" } as const;
      }
      if (locked.runtime.status === "archived") {
        return { kind: "archived" } as const;
      }
      const active = await client.query(
        `SELECT 1 FROM runtime_probe_jobs
         WHERE runtime_id = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [input.runtimeId],
      );
      if ((active.rowCount ?? 0) > 0) {
        return { kind: "probe_in_progress" } as const;
      }
      const probeId = randomUUID();
      const jobId = randomUUID();
      const outboxId = randomUUID();
      const probeResult = await client.query<ExternalRuntimeProbeRow>(
        `INSERT INTO external_runtime_probes (
           id, runtime_id, runtime_revision, requested_by, status,
           command_digest, args_digest, requested_at
         ) VALUES (
           $1, $2, $3, $4, 'requested', $5, $6, NOW()
         )
         RETURNING *`,
        [
          probeId,
          input.runtimeId,
          locked.row.revision,
          input.actorId,
          locked.row.command_digest,
          locked.row.args_digest,
        ],
      );
      await client.query(
        `INSERT INTO runtime_probe_jobs (
           id, runtime_id, probe_id, outbox_id, status, attempts,
           max_attempts, available_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 'queued', 0, 3, NOW(), NOW(), NOW()
         )`,
        [jobId, input.runtimeId, probeId, outboxId],
      );
      await client.query(
        `INSERT INTO domain_outbox (
           id, topic, payload, status, created_at
         ) VALUES ($1, 'runtime.probe', $2::jsonb, 'pending', NOW())`,
        [
          outboxId,
          JSON.stringify({
            runtimeId: input.runtimeId,
            probeId,
            jobId,
            runtimeRevision: locked.row.revision,
          }),
        ],
      );
      const runtimeResult = await client.query<ExternalRuntimeRow>(
        `UPDATE external_runtimes
         SET
           last_probe_id = $2,
           last_probe_at = NOW(),
           last_probe_ok = NULL,
           last_probe_message = 'Probe queued',
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [input.runtimeId, probeId],
      );
      const runtime = runtimeFromRow(
        runtimeResult.rows[0]!,
        probeResult.rows[0],
      );
      await insertEvent(client, {
        runtimeId: input.runtimeId,
        kind: "probed",
        actorId: input.actorId,
        previous: locked.runtime,
        next: runtime,
        changedFields: ["lastProbe"],
        message: `外部运行时“${runtime.name}”的 Probe 已排队`,
      });
      return {
        kind: "requested",
        runtime,
        probe: probeFromRow(probeResult.rows[0]!),
        jobId,
      } as const;
    });
  }

  async claimProbeJob(
    owner: string,
    leaseSeconds: number,
    runtimeId?: string,
  ): Promise<ClaimedRuntimeProbeJob | undefined> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<ProbeJobRow>(
        `SELECT * FROM runtime_probe_jobs
         WHERE status = 'queued'
           AND available_at <= NOW()
           AND attempts < max_attempts
           AND ($1::uuid IS NULL OR runtime_id = $1)
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [runtimeId ?? null],
      );
      const job = candidate.rows[0];
      if (job === undefined) return undefined;
      const leaseToken = randomUUID();
      const updated = await client.query<ProbeJobRow>(
        `UPDATE runtime_probe_jobs
         SET
           status = 'running',
           attempts = attempts + 1,
           lease_owner = $2,
           lease_token = $3,
           lease_expires_at = NOW() + ($4 || ' seconds')::interval,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [job.id, owner, leaseToken, leaseSeconds],
      );
      await client.query(
        `UPDATE external_runtime_probes
         SET status = 'running', started_at = NOW()
         WHERE id = $1 AND status = 'requested'`,
        [job.probe_id],
      );
      await client.query(
        `UPDATE domain_outbox
         SET status = 'published', published_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [job.outbox_id],
      );
      const runtimeResult = await client.query<ExternalRuntimeRow>(
        "SELECT * FROM external_runtimes WHERE id = $1",
        [job.runtime_id],
      );
      const probeResult = await client.query<ExternalRuntimeProbeRow>(
        "SELECT * FROM external_runtime_probes WHERE id = $1",
        [job.probe_id],
      );
      const runtimeRow = runtimeResult.rows[0];
      const probeRow = probeResult.rows[0];
      if (runtimeRow === undefined || probeRow === undefined) {
        await client.query(
          `UPDATE runtime_probe_jobs
           SET status = 'dead_letter', last_error = 'probe source missing',
               lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1`,
          [job.id],
        );
        return undefined;
      }
      return {
        jobId: updated.rows[0]!.id,
        runtime: runtimeFromRow(runtimeRow, probeRow),
        probe: probeFromRow(probeRow),
        leaseToken,
      };
    });
  }

  async completeProbeJob(input: CompleteRuntimeProbeInput): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const jobResult = await client.query<ProbeJobRow>(
        `SELECT * FROM runtime_probe_jobs
         WHERE id = $1
         FOR UPDATE`,
        [input.jobId],
      );
      const job = jobResult.rows[0];
      if (
        job === undefined ||
        job.status !== "running" ||
        job.lease_owner !== input.owner ||
        job.lease_token !== input.leaseToken
      ) {
        return false;
      }
      const runtimeResult = await client.query<ExternalRuntimeRow>(
        "SELECT * FROM external_runtimes WHERE id = $1 FOR UPDATE",
        [job.runtime_id],
      );
      const probeResult = await client.query<ExternalRuntimeProbeRow>(
        "SELECT * FROM external_runtime_probes WHERE id = $1 FOR UPDATE",
        [job.probe_id],
      );
      const runtimeRow = runtimeResult.rows[0];
      const probeRow = probeResult.rows[0];
      if (runtimeRow === undefined || probeRow === undefined) {
        return false;
      }
      const runtime = runtimeFromRow(runtimeRow, probeRow);
      const stale =
        runtimeRow.revision !== probeRow.runtime_revision ||
        runtimeRow.command_digest !== probeRow.command_digest ||
        runtimeRow.args_digest !== probeRow.args_digest;
      const output = input.stdoutExcerpt.trim();
      const passed =
        !stale &&
        !input.timedOut &&
        input.exitCode === 0 &&
        output !== "";
      let errorCode = passed ? null : input.errorCode ?? null;
      let errorMessage = passed ? null : input.errorMessage ?? null;
      if (stale) {
        errorCode = "probe_stale";
        errorMessage =
          "Runtime definition changed before the Probe completed";
      } else if (input.timedOut) {
        errorCode = "probe_timeout";
        errorMessage = "Runtime Probe exceeded its execution timeout";
      } else if (input.errorCode !== undefined) {
        errorCode = input.errorCode;
        errorMessage = input.errorMessage ?? "Runtime Probe could not start";
      } else if (input.exitCode !== 0) {
        errorCode = "probe_nonzero_exit";
        errorMessage =
          errorMessage ??
          `Runtime Probe exited with code ${String(input.exitCode)}`;
      } else if (output === "") {
        errorCode = "probe_empty_output";
        errorMessage = "Runtime Probe returned no usable version output";
      }
      const startedAt = probeRow.started_at ?? new Date();
      const durationMs = Math.max(0, Date.now() - startedAt.getTime());
      const stdoutExcerpt = excerpt(input.stdoutExcerpt);
      const stderrExcerpt = excerpt(input.stderrExcerpt);
      const runtimeVersion =
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line !== "")
          ?.slice(0, 240) ?? null;
      const probeStatus = passed ? "passed" : "failed";
      const updatedProbeResult =
        await client.query<ExternalRuntimeProbeRow>(
          `UPDATE external_runtime_probes
           SET
             status = $2,
             completed_at = NOW(),
             duration_ms = $3,
             exit_code = $4,
             timed_out = $5,
             runtime_version = $6,
             stdout_excerpt = $7,
             stderr_excerpt = $8,
             error_code = $9,
             error_message = $10
           WHERE id = $1
           RETURNING *`,
          [
            probeRow.id,
            probeStatus,
            durationMs,
            input.exitCode,
            input.timedOut,
            runtimeVersion,
            stdoutExcerpt,
            stderrExcerpt,
            errorCode,
            errorMessage?.slice(0, 2_000) ?? null,
          ],
        );
      const adapter = adapterCapabilityProfile(runtimeRow.protocol);
      const declared = declaredCapabilityProfile(
        runtimeRow.supported_tools,
        runtimeRow.network_mode,
      );
      const probeProfile = emptyExternalRuntimeCapabilitySet("unknown");
      const effective = mergeCapabilityProfiles({
        adapter,
        declared,
        probe: probeProfile,
      });
      await client.query(
        `INSERT INTO external_runtime_capabilities (
           id, runtime_id, runtime_revision, probe_id,
           adapter_profile, declared_profile, probe_profile,
           effective_profile, captured_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
           $8::jsonb, NOW()
         )`,
        [
          randomUUID(),
          job.runtime_id,
          probeRow.runtime_revision,
          probeRow.id,
          JSON.stringify(adapter),
          JSON.stringify(declared),
          JSON.stringify(probeProfile),
          JSON.stringify(effective),
        ],
      );
      let nextRuntime = runtime;
      if (!stale) {
        const runtimeUpdate = await client.query<ExternalRuntimeRow>(
          `UPDATE external_runtimes
           SET
             last_probe_id = $2,
             last_probe_at = NOW(),
             last_probe_ok = $3,
             last_probe_message = $4,
             updated_at = NOW()
           WHERE id = $1
             AND revision = $5
           RETURNING *`,
          [
            job.runtime_id,
            probeRow.id,
            passed,
            (passed ? runtimeVersion : errorMessage)?.slice(0, 2_000) ??
              (passed ? "Probe passed" : "Probe failed"),
            probeRow.runtime_revision,
          ],
        );
        if (runtimeUpdate.rows[0] !== undefined) {
          nextRuntime = runtimeFromRow(
            runtimeUpdate.rows[0],
            updatedProbeResult.rows[0],
          );
        }
      }
      await client.query(
        `UPDATE runtime_probe_jobs
         SET
           status = 'completed',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [job.id, errorMessage?.slice(0, 2_000) ?? null],
      );
      await client.query(
        `UPDATE domain_outbox
         SET status = 'published', published_at = COALESCE(published_at, NOW())
         WHERE id = $1`,
        [job.outbox_id],
      );
      await insertEvent(client, {
        runtimeId: job.runtime_id,
        kind: "probed",
        actorId: probeRow.requested_by,
        previous: runtime,
        next: nextRuntime,
        changedFields: ["lastProbe", "capabilities"],
        message: passed
          ? `Probe 通过：${runtimeVersion ?? "runtime available"}`
          : `Probe 失败：${errorMessage ?? errorCode ?? "unknown error"}`,
      });
      return true;
    });
  }

  async latestProbe(
    runtimeId: string,
  ): Promise<ExternalRuntimeProbe | undefined> {
    const row = await latestProbeFor(this.database, runtimeId);
    return row === undefined ? undefined : probeFromRow(row);
  }

  async listEvents(
    runtimeId: string,
    limit = 100,
  ): Promise<ExternalRuntimeEvent[]> {
    const result = await this.database.query<ExternalRuntimeEventRow>(
      `SELECT * FROM external_runtime_events
       WHERE runtime_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [runtimeId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map(eventFromRow);
  }

  async listCapabilities(
    runtimeId: string,
  ): Promise<ExternalRuntimeCapabilitySnapshot[]> {
    const result = await this.database.query<ExternalRuntimeCapabilityRow>(
      `SELECT * FROM external_runtime_capabilities
       WHERE runtime_id = $1
       ORDER BY runtime_revision DESC, captured_at DESC, id DESC`,
      [runtimeId],
    );
    return result.rows.map(capabilityFromRow);
  }
}
