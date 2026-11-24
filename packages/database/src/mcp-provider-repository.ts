import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CreateMcpProviderInput,
  CreateMcpProviderVersionInput,
  McpProvider,
  McpProviderAudit,
  McpProviderAuthKind,
  McpProviderDetail,
  McpProviderDiscoveryStatus,
  McpProviderErrorCategory,
  McpProviderHealthCheckInput,
  McpProviderHealthCheckResult,
  McpProviderHealthStatus,
  McpProviderProbe,
  McpProviderProbeInput,
  McpProviderProbeRequestResult,
  McpProviderProbeStatus,
  McpProviderProbeTrigger,
  McpProviderRevisionInput,
  McpProviderStatus,
  McpProviderTool,
  McpProviderToolList,
  McpProviderTransport,
  McpProviderVersion,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";

interface McpProviderRow {
  readonly id: string;
  readonly provider_key: string;
  readonly owner_principal_id: string;
  readonly name: string;
  readonly description: string;
  readonly status: McpProviderStatus;
  readonly current_version: number;
  readonly current_version_id: string;
  readonly health_status: McpProviderHealthStatus;
  readonly health_checked_at: Date | null;
  readonly health_version_id: string | null;
  readonly discovery_status: McpProviderDiscoveryStatus;
  readonly tool_count: number;
  readonly last_error_category: McpProviderErrorCategory | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly transport: McpProviderTransport;
  readonly endpoint_url: string;
  readonly auth_kind: McpProviderAuthKind;
  readonly credential_configured: boolean;
  readonly request_timeout_ms: number;
}

interface McpProviderVersionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly version: number;
  readonly transport: McpProviderTransport;
  readonly endpoint_url: string;
  readonly auth_kind: McpProviderAuthKind;
  readonly credential_ref: string | null;
  readonly credential_header_name: string | null;
  readonly request_timeout_ms: number;
  readonly config_digest: string;
  readonly created_by_principal_id: string;
  readonly created_at: Date;
}

interface McpProviderProbeRow {
  readonly id: string;
  readonly provider_id: string;
  readonly provider_version_id: string;
  readonly status: McpProviderProbeStatus;
  readonly trigger_source: McpProviderProbeTrigger;
  readonly requested_by_principal_id: string;
  readonly error_category: McpProviderErrorCategory | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly duration_ms: number | null;
  readonly tool_count: number | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly requested_at: Date;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}

interface McpProviderToolRow {
  readonly id: string;
  readonly provider_id: string;
  readonly provider_version_id: string;
  readonly probe_id: string;
  readonly tool_key: string;
  readonly tool_name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown> | null;
  readonly schema_digest: string;
  readonly discovered_at: Date;
}

interface McpProviderAuditRow {
  readonly id: string;
  readonly provider_id: string;
  readonly seq: string | number;
  readonly action: string;
  readonly actor_principal_id: string;
  readonly actor_role: "owner" | "platform-admin" | "system";
  readonly reason: string;
  readonly from_state: Record<string, unknown>;
  readonly to_state: Record<string, unknown>;
  readonly revision: number;
  readonly created_at: Date;
}

export interface McpProviderVisibilityActor {
  readonly principalId: string;
  readonly platformAdministrator: boolean;
}

export interface McpProviderDiscoveredToolInput {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown> | null;
  readonly schemaDigest: string;
}

export interface ClaimedMcpProviderProbeJob {
  readonly probeId: string;
  readonly providerId: string;
  readonly providerVersionId: string;
  readonly providerVersion: number;
  readonly providerRevision: number;
  readonly endpointUrl: string;
  readonly authKind: McpProviderAuthKind;
  readonly credentialRef: string | null;
  readonly credentialHeaderName: string | null;
  readonly requestTimeoutMs: number;
  readonly leaseToken: string;
}

export interface CompleteMcpProviderProbeInput {
  readonly probeId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly tools: readonly McpProviderDiscoveredToolInput[];
  readonly errorCategory?: McpProviderErrorCategory | undefined;
  readonly errorCode?: string | undefined;
  readonly errorMessage?: string | undefined;
}

export type McpProviderRepositoryErrorCode =
  | "mcp_provider_not_found"
  | "mcp_provider_forbidden"
  | "mcp_provider_key_conflict"
  | "mcp_provider_revision_conflict"
  | "mcp_provider_state_invalid"
  | "mcp_provider_not_ready"
  | "mcp_provider_probe_conflict";

export class McpProviderRepositoryError extends Error {
  constructor(
    readonly code: McpProviderRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpProviderRepositoryError";
  }
}

const providerSelect = `
  SELECT
    provider.*,
    version.transport,
    version.endpoint_url,
    version.auth_kind,
    (version.credential_ref IS NOT NULL) AS credential_configured,
    version.request_timeout_ms
  FROM mcp_providers AS provider
  JOIN mcp_provider_versions AS version
    ON version.id = provider.current_version_id
`;

export class McpProviderRepository {
  constructor(private readonly database: Database) {}

  async listProviders(
    actor: McpProviderVisibilityActor,
  ): Promise<McpProvider[]> {
    const result = await this.database.query<McpProviderRow>(
      `${providerSelect}
       WHERE $1::boolean OR provider.owner_principal_id = $2
       ORDER BY
         CASE provider.status
           WHEN 'active' THEN 0
           WHEN 'draft' THEN 1
           WHEN 'disabled' THEN 2
           ELSE 3
         END,
         provider.updated_at DESC,
         provider.id`,
      [actor.platformAdministrator, actor.principalId],
    );
    return result.rows.map(mcpProviderFromRow);
  }

  async getProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
  ): Promise<McpProviderDetail> {
    const provider = await this.readVisibleProvider(actor, providerId);
    if (provider === undefined) throw notFound();
    const [versions, latestProbe, tools, audit] = await Promise.all([
      this.listProviderVersions(providerId),
      this.latestProbe(providerId, provider.current_version_id),
      this.toolsForProbe(
        providerId,
        provider.current_version_id,
        "latest-passed",
      ),
      this.listAuditRows(providerId),
    ]);
    return {
      provider: mcpProviderFromRow(provider),
      versions: versions.map(mcpProviderVersionFromRow),
      latestProbe:
        latestProbe === undefined ? null : mcpProviderProbeFromRow(latestProbe),
      tools: tools.map(mcpProviderToolFromRow),
      audit: audit.map(mcpProviderAuditFromRow),
    };
  }

  async createProvider(
    actor: McpProviderVisibilityActor,
    input: CreateMcpProviderInput,
  ): Promise<McpProviderDetail> {
    const providerId = randomUUID();
    const versionId = randomUUID();
    const now = new Date();
    await this.database.transaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO mcp_providers (
             id, provider_key, owner_principal_id, name, description, status,
             current_version, current_version_id, health_status,
             discovery_status, tool_count, revision, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'draft', 1, $6, 'unknown',
             'not_discovered', 0, 1, $7, $7
           )`,
          [
            providerId,
            input.providerKey,
            actor.principalId,
            input.name,
            input.description,
            versionId,
            now,
          ],
        );
      } catch (error) {
        throw translateMcpProviderConstraint(
          error,
          "mcp_provider_key_conflict",
        );
      }
      await insertProviderVersionWithClient(client, {
        providerId,
        versionId,
        version: 1,
        input,
        actorId: actor.principalId,
        now,
      });
      await appendMcpProviderAuditWithClient(client, {
        providerId,
        action: "mcp.provider.created",
        actor,
        reason: "",
        fromState: {},
        toState: {
          status: "draft",
          currentVersion: 1,
          authKind: input.authKind,
          credentialConfigured: input.credentialRef !== null,
          transport: input.transport,
        },
        revision: 1,
        now,
      });
      await appendAuditEventWithClient(client, {
        action: "mcp.provider.created",
        actorPrincipalId: actor.principalId,
        metadata: {
          providerId,
          providerKey: input.providerKey,
          authKind: input.authKind,
          credentialConfigured: input.credentialRef !== null,
        },
      });
    });
    const detail = await this.getProvider(actor, providerId);
    if (detail === undefined) {
      throw new Error("created MCP Provider is missing");
    }
    return detail;
  }

  async createVersion(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: CreateMcpProviderVersionInput,
  ): Promise<McpProviderDetail> {
    await this.database.transaction(async (client) => {
      const provider = await lockProviderWithClient(client, providerId);
      assertProviderWritable(actor, provider);
      requireRevision(provider, input.expectedRevision);
      if (provider.status === "archived") {
        throw stateError("Archived providers cannot receive versions");
      }
      const nextVersion = provider.current_version + 1;
      const versionId = randomUUID();
      const now = new Date();
      await insertProviderVersionWithClient(client, {
        providerId,
        versionId,
        version: nextVersion,
        input,
        actorId: actor.principalId,
        now,
      });
      const updated = await client.query<McpProviderRow>(
        `UPDATE mcp_providers
         SET name = $2,
             description = $3,
             current_version = $4,
             current_version_id = $5,
             status = CASE WHEN status = 'active' THEN 'draft' ELSE status END,
             health_status = 'unknown',
             health_checked_at = NULL,
             health_version_id = NULL,
             discovery_status = 'not_discovered',
             tool_count = 0,
             last_error_category = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             revision = revision + 1,
             updated_at = $6
         WHERE id = $1
         RETURNING *`,
        [
          providerId,
          input.name,
          input.description,
          nextVersion,
          versionId,
          now,
        ],
      );
      const row = updated.rows[0]!;
      await appendMcpProviderAuditWithClient(client, {
        providerId,
        action: "mcp.provider.version.created",
        actor,
        reason: "",
        fromState: {
          status: provider.status,
          currentVersion: provider.current_version,
        },
        toState: {
          status: row.status,
          currentVersion: nextVersion,
          authKind: input.authKind,
          credentialConfigured: input.credentialRef !== null,
        },
        revision: row.revision,
        now,
      });
    });
    const detail = await this.getProvider(actor, providerId);
    if (detail === undefined) {
      throw notFound();
    }
    return detail;
  }

  async activateProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    return this.transitionProvider(actor, providerId, input, "active");
  }

  async disableProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    return this.transitionProvider(actor, providerId, input, "disabled");
  }

  async archiveProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    return this.transitionProvider(actor, providerId, input, "archived");
  }

  async requestProbe(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: McpProviderProbeInput,
    trigger: McpProviderProbeTrigger,
  ): Promise<McpProviderProbeRequestResult> {
    const probeId = await this.database.transaction(async (client) => {
      const provider = await lockProviderWithClient(client, providerId);
      assertProviderWritable(actor, provider);
      requireRevision(provider, input.expectedRevision);
      if (provider.status === "archived") {
        throw stateError("Archived providers cannot be probed");
      }
      const activeProbe = await client.query<{ id: string }>(
        `SELECT id
         FROM mcp_provider_probes
         WHERE provider_id = $1 AND status IN ('queued', 'running')
         LIMIT 1`,
        [providerId],
      );
      if (activeProbe.rows[0] !== undefined) {
        throw new McpProviderRepositoryError(
          "mcp_provider_probe_conflict",
          "An MCP Provider probe is already active",
        );
      }
      const id = randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO mcp_provider_probes (
           id, provider_id, provider_version_id, status, trigger_source,
           requested_by_principal_id, requested_at
         ) VALUES ($1, $2, $3, 'queued', $4, $5, $6)`,
        [id, providerId, provider.current_version_id, trigger, actor.principalId, now],
      );
      const updated = await client.query<McpProviderRow>(
        `UPDATE mcp_providers
         SET health_status = 'probing',
             health_version_id = current_version_id,
             last_error_category = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             revision = revision + 1,
             updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [providerId, now],
      );
      const row = updated.rows[0]!;
      await appendMcpProviderAuditWithClient(client, {
        providerId,
        action: "mcp.provider.probe.requested",
        actor,
        reason: "",
        fromState: {
          healthStatus: provider.health_status,
          currentVersion: provider.current_version,
        },
        toState: {
          healthStatus: "probing",
          probeId: id,
          trigger,
        },
        revision: row.revision,
        now,
      });
      return id;
    });
    const [provider, probe] = await Promise.all([
      this.getProvider(actor, providerId),
      this.getProbe(probeId),
    ]);
    if (provider === undefined || probe === undefined) {
      throw notFound();
    }
    return { provider: provider.provider, probe };
  }

  async requestPlatformHealthCheck(
    actor: McpProviderVisibilityActor,
    input: McpProviderHealthCheckInput,
  ): Promise<McpProviderHealthCheckResult> {
    if (!actor.platformAdministrator) {
      throw forbidden();
    }
    const requestedIds =
      input.providerIds.length === 0 ? null : input.providerIds;
    const candidates = await this.database.query<{
      readonly id: string;
      readonly revision: number;
    }>(
      `SELECT provider.id, provider.revision
       FROM mcp_providers AS provider
       WHERE provider.status = 'active'
         AND ($1::uuid[] IS NULL OR provider.id = ANY($1::uuid[]))
         AND NOT EXISTS (
           SELECT 1
           FROM mcp_provider_probes AS probe
           WHERE probe.provider_id = provider.id
             AND probe.status IN ('queued', 'running')
         )
       ORDER BY provider.updated_at, provider.id
       LIMIT 100`,
      [requestedIds],
    );
    const probes: McpProviderProbe[] = [];
    let skipped = 0;
    for (const candidate of candidates.rows) {
      try {
        const requested = await this.requestProbe(
          actor,
          candidate.id,
          { expectedRevision: candidate.revision },
          "admin",
        );
        probes.push(requested.probe);
      } catch (error) {
        if (
          error instanceof McpProviderRepositoryError &&
          (error.code === "mcp_provider_revision_conflict" ||
            error.code === "mcp_provider_probe_conflict" ||
            error.code === "mcp_provider_state_invalid")
        ) {
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
    const totalCandidates = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM mcp_providers
       WHERE status = 'active'
         AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
      [requestedIds],
    );
    const total = Number(totalCandidates.rows[0]?.count ?? "0");
    return {
      queued: probes.length,
      skipped: Math.max(skipped, total - probes.length - skipped),
      probes,
    };
  }

  async listTools(
    actor: McpProviderVisibilityActor,
    providerId: string,
  ): Promise<McpProviderToolList> {
    const provider = await this.readVisibleProvider(actor, providerId);
    if (provider === undefined) throw notFound();
    const tools = await this.toolsForProbe(
      providerId,
      provider.current_version_id,
      "latest-passed",
    );
    return {
      providerId,
      providerVersionId: provider.current_version_id,
      items: tools.map(mcpProviderToolFromRow),
    };
  }

  async claimProbeJob(
    owner: string,
    leaseSeconds: number,
  ): Promise<ClaimedMcpProviderProbeJob | undefined> {
    return this.database.transaction(async (client) => {
      const candidate = await client.query<{
        readonly id: string;
        readonly provider_id: string;
        readonly provider_version_id: string;
        readonly version: number;
        readonly provider_revision: number;
        readonly endpoint_url: string;
        readonly auth_kind: McpProviderAuthKind;
        readonly credential_ref: string | null;
        readonly credential_header_name: string | null;
        readonly request_timeout_ms: number;
      }>(
        `SELECT
           probe.id,
           probe.provider_id,
           probe.provider_version_id,
           version.version,
           provider.revision AS provider_revision,
           version.endpoint_url,
           version.auth_kind,
           version.credential_ref,
           version.credential_header_name,
           version.request_timeout_ms
         FROM mcp_provider_probes AS probe
         JOIN mcp_providers AS provider ON provider.id = probe.provider_id
         JOIN mcp_provider_versions AS version
           ON version.id = probe.provider_version_id
         WHERE (
           probe.status = 'queued'
           OR (
             probe.status = 'running'
             AND probe.lease_expires_at < NOW()
           )
         )
           AND provider.status <> 'archived'
         ORDER BY probe.requested_at, probe.id
         FOR UPDATE OF probe SKIP LOCKED
         LIMIT 1`,
      );
      const row = candidate.rows[0];
      if (row === undefined) return undefined;
      const leaseToken = randomUUID();
      const claimed = await client.query(
        `UPDATE mcp_provider_probes
         SET status = 'running',
             lease_owner = $2,
             lease_token = $3,
             lease_expires_at = NOW() + ($4::text || ' seconds')::interval,
             started_at = COALESCE(started_at, NOW())
         WHERE id = $1
         RETURNING id`,
        [row.id, owner, leaseToken, leaseSeconds],
      );
      if (claimed.rows[0] === undefined) return undefined;
      return {
        probeId: row.id,
        providerId: row.provider_id,
        providerVersionId: row.provider_version_id,
        providerVersion: row.version,
        providerRevision: row.provider_revision,
        endpointUrl: row.endpoint_url,
        authKind: row.auth_kind,
        credentialRef: row.credential_ref,
        credentialHeaderName: row.credential_header_name,
        requestTimeoutMs: row.request_timeout_ms,
        leaseToken,
      };
    });
  }

  async completeProbeJob(
    input: CompleteMcpProviderProbeInput,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const probeResult = await client.query<McpProviderProbeRow>(
        `SELECT *
         FROM mcp_provider_probes
         WHERE id = $1
         FOR UPDATE`,
        [input.probeId],
      );
      const probe = probeResult.rows[0];
      if (
        probe === undefined ||
        probe.status !== "running" ||
        probe.lease_owner !== input.owner
      ) {
        return false;
      }
      const providerResult = await client.query<McpProviderRow>(
        `SELECT * FROM mcp_providers WHERE id = $1 FOR UPDATE`,
        [probe.provider_id],
      );
      const provider = providerResult.rows[0];
      if (provider === undefined) return false;
      const completed = await client.query(
        `UPDATE mcp_provider_probes
         SET status = $2,
             error_category = $3,
             error_code = $4,
             error_message = $5,
             duration_ms = $6,
             tool_count = $7,
             completed_at = NOW(),
             lease_expires_at = NULL
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $8
           AND lease_token = $9`,
        [
          input.probeId,
          input.passed ? "passed" : "failed",
          input.passed ? null : (input.errorCategory ?? "unknown"),
          input.passed ? null : (input.errorCode?.slice(0, 160) ?? null),
          input.passed
            ? null
            : (input.errorMessage?.slice(0, 2_000) ??
              "MCP Provider probe failed"),
          Math.max(0, Math.trunc(input.durationMs)),
          input.passed ? input.tools.length : null,
          input.owner,
          input.leaseToken,
        ],
      );
      if (completed.rowCount !== 1) return false;

      const isCurrentVersion =
        provider.current_version_id === probe.provider_version_id;
      if (isCurrentVersion) {
        const updated = await client.query<McpProviderRow>(
          `UPDATE mcp_providers
           SET health_status = $2,
               health_checked_at = NOW(),
               health_version_id = current_version_id,
               discovery_status = $3,
               tool_count = $4,
               last_error_category = $5,
               last_error_code = $6,
               last_error_message = $7,
               revision = revision + 1,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            provider.id,
            input.passed ? "healthy" : "unhealthy",
            input.passed ? "ready" : "failed",
            input.passed ? input.tools.length : provider.tool_count,
            input.passed ? null : (input.errorCategory ?? "unknown"),
            input.passed ? null : (input.errorCode?.slice(0, 160) ?? null),
            input.passed
              ? null
              : (input.errorMessage?.slice(0, 2_000) ??
                "MCP Provider probe failed"),
          ],
        );
        const row = updated.rows[0]!;
        if (input.passed) {
          for (const tool of input.tools) {
            await client.query(
              `INSERT INTO mcp_provider_tools (
                 id, provider_id, provider_version_id, probe_id, tool_key,
                 tool_name, description, input_schema, output_schema,
                 schema_digest, discovered_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                 $10, NOW()
               )`,
              [
                randomUUID(),
                provider.id,
                probe.provider_version_id,
                input.probeId,
                mcpProviderToolKey({
                  providerId: provider.id,
                  providerVersionId: probe.provider_version_id,
                  toolName: tool.name,
                  schemaDigest: tool.schemaDigest,
                }),
                tool.name,
                tool.description,
                JSON.stringify(tool.inputSchema),
                tool.outputSchema === null
                  ? null
                  : JSON.stringify(tool.outputSchema),
                tool.schemaDigest,
              ],
            );
          }
        }
        await appendMcpProviderAuditWithClient(client, {
          providerId: provider.id,
          action: input.passed
            ? "mcp.provider.probe.passed"
            : "mcp.provider.probe.failed",
          actor: {
            principalId: input.owner,
            platformAdministrator: false,
          },
          actorRole: "system",
          reason: "",
          fromState: {
            healthStatus: provider.health_status,
            toolCount: provider.tool_count,
          },
          toState: {
            healthStatus: row.health_status,
            discoveryStatus: row.discovery_status,
            toolCount: row.tool_count,
            errorCategory: row.last_error_category,
            errorCode: row.last_error_code,
          },
          revision: row.revision,
          now: new Date(),
        });
      } else {
        await appendMcpProviderAuditWithClient(client, {
          providerId: provider.id,
          action: "mcp.provider.probe.stale_result",
          actor: {
            principalId: input.owner,
            platformAdministrator: false,
          },
          actorRole: "system",
          reason: "The provider version changed before the probe completed",
          fromState: { currentVersionId: provider.current_version_id },
          toState: { probedVersionId: probe.provider_version_id },
          revision: provider.revision,
          now: new Date(),
        });
      }
      return true;
    });
  }

  private async transitionProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
    input: McpProviderRevisionInput,
    target: McpProviderStatus,
  ): Promise<McpProviderDetail> {
    await this.database.transaction(async (client) => {
      const provider = await lockProviderWithClient(client, providerId);
      assertProviderWritable(actor, provider);
      requireRevision(provider, input.expectedRevision);
      if (provider.status === "archived") {
        throw stateError("Archived providers are immutable");
      }
      if (target === "active") {
        if (provider.status !== "draft" && provider.status !== "disabled") {
          throw stateError("Only draft or disabled providers can be activated");
        }
        if (
          provider.health_status !== "healthy" ||
          provider.discovery_status !== "ready" ||
          provider.health_version_id !== provider.current_version_id
        ) {
          throw new McpProviderRepositoryError(
            "mcp_provider_not_ready",
            "The current provider version must pass a probe before activation",
          );
        }
      } else if (target === "disabled") {
        if (provider.status !== "draft" && provider.status !== "active") {
          throw stateError("Only draft or active providers can be disabled");
        }
      } else if (target !== "archived") {
        throw stateError("Unsupported MCP Provider transition");
      }
      const now = new Date();
      const updated = await client.query<McpProviderRow>(
        `UPDATE mcp_providers
         SET status = $2, revision = revision + 1, updated_at = $3
         WHERE id = $1
         RETURNING *`,
        [providerId, target, now],
      );
      const row = updated.rows[0]!;
      await appendMcpProviderAuditWithClient(client, {
        providerId,
        action: `mcp.provider.status.${target}`,
        actor,
        reason: input.reason,
        fromState: { status: provider.status },
        toState: { status: target },
        revision: row.revision,
        now,
      });
    });
    const detail = await this.getProvider(actor, providerId);
    if (detail === undefined) throw notFound();
    return detail;
  }

  private async readVisibleProvider(
    actor: McpProviderVisibilityActor,
    providerId: string,
  ): Promise<McpProviderRow | undefined> {
    const result = await this.database.query<McpProviderRow>(
      `${providerSelect} WHERE provider.id = $1`,
      [providerId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (
      !actor.platformAdministrator &&
      row.owner_principal_id !== actor.principalId
    ) {
      throw forbidden();
    }
    return row;
  }

  private async listProviderVersions(
    providerId: string,
  ): Promise<McpProviderVersionRow[]> {
    const result = await this.database.query<McpProviderVersionRow>(
      `SELECT *
       FROM mcp_provider_versions
       WHERE provider_id = $1
       ORDER BY version DESC`,
      [providerId],
    );
    return result.rows;
  }

  private async latestProbe(
    providerId: string,
    providerVersionId: string,
  ): Promise<McpProviderProbeRow | undefined> {
    const result = await this.database.query<McpProviderProbeRow>(
      `SELECT *
       FROM mcp_provider_probes
       WHERE provider_id = $1 AND provider_version_id = $2
       ORDER BY requested_at DESC, id DESC
       LIMIT 1`,
      [providerId, providerVersionId],
    );
    return result.rows[0];
  }

  private async getProbe(
    probeId: string,
  ): Promise<McpProviderProbe | undefined> {
    const result = await this.database.query<McpProviderProbeRow>(
      `SELECT * FROM mcp_provider_probes WHERE id = $1`,
      [probeId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mcpProviderProbeFromRow(row);
  }

  private async toolsForProbe(
    providerId: string,
    providerVersionId: string,
    mode: "latest-passed",
  ): Promise<McpProviderToolRow[]> {
    if (mode !== "latest-passed") return [];
    const result = await this.database.query<McpProviderToolRow>(
      `SELECT tool.*
       FROM mcp_provider_tools AS tool
       WHERE tool.provider_id = $1
         AND tool.provider_version_id = $2
         AND tool.probe_id = (
           SELECT probe.id
           FROM mcp_provider_probes AS probe
           WHERE probe.provider_id = $1
             AND probe.provider_version_id = $2
             AND probe.status = 'passed'
           ORDER BY probe.completed_at DESC, probe.id DESC
           LIMIT 1
         )
       ORDER BY tool.tool_name`,
      [providerId, providerVersionId],
    );
    return result.rows;
  }

  private async listAuditRows(
    providerId: string,
  ): Promise<McpProviderAuditRow[]> {
    const result = await this.database.query<McpProviderAuditRow>(
      `SELECT *
       FROM mcp_provider_audit_events
       WHERE provider_id = $1
       ORDER BY seq DESC
       LIMIT 200`,
      [providerId],
    );
    return result.rows;
  }
}

async function insertProviderVersionWithClient(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly versionId: string;
    readonly version: number;
    readonly input: CreateMcpProviderInput | CreateMcpProviderVersionInput;
    readonly actorId: string;
    readonly now: Date;
  },
): Promise<void> {
  const digest = mcpProviderConfigDigest(
    input.providerId,
    input.version,
    input.input,
  );
  await client.query(
    `INSERT INTO mcp_provider_versions (
       id, provider_id, version, transport, endpoint_url, auth_kind,
       credential_ref, credential_header_name, request_timeout_ms,
       config_digest, created_by_principal_id, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     )`,
    [
      input.versionId,
      input.providerId,
      input.version,
      input.input.transport,
      input.input.endpointUrl,
      input.input.authKind,
      input.input.credentialRef,
      input.input.credentialHeaderName,
      input.input.requestTimeoutMs,
      digest,
      input.actorId,
      input.now,
    ],
  );
}

async function lockProviderWithClient(
  client: PoolClient,
  providerId: string,
): Promise<McpProviderRow> {
  const result = await client.query<McpProviderRow>(
    `SELECT * FROM mcp_providers WHERE id = $1 FOR UPDATE`,
    [providerId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound();
  return row;
}

function assertProviderWritable(
  actor: McpProviderVisibilityActor,
  provider: Pick<McpProviderRow, "owner_principal_id">,
): void {
  if (
    !actor.platformAdministrator &&
    provider.owner_principal_id !== actor.principalId
  ) {
    throw forbidden();
  }
}

function requireRevision(
  provider: Pick<McpProviderRow, "revision">,
  expectedRevision: number,
): void {
  if (provider.revision !== expectedRevision) {
    throw new McpProviderRepositoryError(
      "mcp_provider_revision_conflict",
      "The MCP Provider was changed by another request",
    );
  }
}

async function appendMcpProviderAuditWithClient(
  client: PoolClient,
  input: {
    readonly providerId: string;
    readonly action: string;
    readonly actor: McpProviderVisibilityActor;
    readonly actorRole?: "owner" | "platform-admin" | "system";
    readonly reason: string;
    readonly fromState: Record<string, unknown>;
    readonly toState: Record<string, unknown>;
    readonly revision: number;
    readonly now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO mcp_provider_audit_events (
       id, provider_id, seq, action, actor_principal_id, actor_role,
       reason, from_state, to_state, revision, created_at
     ) VALUES (
       $1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10
     )`,
    [
      randomUUID(),
      input.providerId,
      input.action,
      input.actor.principalId,
      input.actorRole ??
        (input.actor.platformAdministrator ? "platform-admin" : "owner"),
      input.reason.slice(0, 2_000),
      JSON.stringify(input.fromState),
      JSON.stringify(input.toState),
      input.revision,
      input.now,
    ],
  );
}

function mcpProviderFromRow(row: McpProviderRow): McpProvider {
  return {
    id: row.id,
    providerKey: row.provider_key,
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.current_version,
    currentVersionId: row.current_version_id,
    transport: row.transport,
    endpointHost: safeEndpointHost(row.endpoint_url),
    authKind: row.auth_kind,
    credentialConfigured: row.credential_configured,
    requestTimeoutMs: row.request_timeout_ms,
    healthStatus: row.health_status,
    healthCheckedAt: isoOrNull(row.health_checked_at),
    healthVersionId: row.health_version_id,
    discoveryStatus: row.discovery_status,
    toolCount: row.tool_count,
    lastErrorCategory: row.last_error_category,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    revision: row.revision,
    invocationEnabled: false,
    grantsExecution: false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mcpProviderVersionFromRow(
  row: McpProviderVersionRow,
): McpProviderVersion {
  return {
    id: row.id,
    providerId: row.provider_id,
    version: row.version,
    transport: row.transport,
    endpointHost: safeEndpointHost(row.endpoint_url),
    authKind: row.auth_kind,
    credentialConfigured: row.credential_ref !== null,
    requestTimeoutMs: row.request_timeout_ms,
    configDigest: row.config_digest,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}

function mcpProviderProbeFromRow(row: McpProviderProbeRow): McpProviderProbe {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerVersionId: row.provider_version_id,
    status: row.status,
    trigger: row.trigger_source,
    requestedByPrincipalId: row.requested_by_principal_id,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    toolCount: row.tool_count,
    requestedAt: row.requested_at.toISOString(),
    startedAt: isoOrNull(row.started_at),
    completedAt: isoOrNull(row.completed_at),
  };
}

function mcpProviderToolFromRow(row: McpProviderToolRow): McpProviderTool {
  return {
    toolKey: row.tool_key,
    name: row.tool_name,
    description: row.description,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    schemaDigest: row.schema_digest,
    schemaRef: `mcp://${row.tool_key}`,
    invocationEnabled: false,
    grantsExecution: false,
  };
}

function mcpProviderToolKey(input: {
  readonly providerId: string;
  readonly providerVersionId: string;
  readonly toolName: string;
  readonly schemaDigest: string;
}): string {
  const identity = `${input.providerId}:${input.providerVersionId}:${input.toolName}:${input.schemaDigest}`;
  return (
    createHash("md5").update(identity).digest("hex") +
    createHash("md5").update(`m13b:${identity}`).digest("hex")
  );
}

function mcpProviderAuditFromRow(
  row: McpProviderAuditRow,
): McpProviderAudit {
  return {
    id: row.id,
    providerId: row.provider_id,
    seq: Number(row.seq),
    action: row.action,
    actorPrincipalId: row.actor_principal_id,
    actorRole: row.actor_role,
    reason: row.reason,
    fromState: row.from_state,
    toState: row.to_state,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
  };
}

function safeEndpointHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid-endpoint";
  }
}

function mcpProviderConfigDigest(
  providerId: string,
  version: number,
  input: CreateMcpProviderInput | CreateMcpProviderVersionInput,
): string {
  const payload = {
    providerId,
    version,
    name: input.name,
    description: input.description,
    transport: input.transport,
    endpointUrl: input.endpointUrl,
    authKind: input.authKind,
    credentialRef: input.credentialRef,
    credentialHeaderName: input.credentialHeaderName,
    requestTimeoutMs: input.requestTimeoutMs,
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function notFound(): McpProviderRepositoryError {
  return new McpProviderRepositoryError(
    "mcp_provider_not_found",
    "MCP Provider not found",
  );
}

function forbidden(): McpProviderRepositoryError {
  return new McpProviderRepositoryError(
    "mcp_provider_forbidden",
    "Only the provider owner or a platform administrator can manage this provider",
  );
}

function stateError(message: string): McpProviderRepositoryError {
  return new McpProviderRepositoryError(
    "mcp_provider_state_invalid",
    message,
  );
}

function translateMcpProviderConstraint(
  error: unknown,
  fallback: McpProviderRepositoryErrorCode,
): McpProviderRepositoryError {
  if (error instanceof McpProviderRepositoryError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  ) {
    return new McpProviderRepositoryError(
      fallback,
      "MCP Provider identity already exists",
    );
  }
  throw error;
}
