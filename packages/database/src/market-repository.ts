import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  canonicalWorkbenchJson,
  marketAssetManifestSchema,
  type CopyMarketTemplateInput,
  type CreateMarketAssetInput,
  type GrantMarketEntitlementInput,
  type InstallMarketAssetInput,
  type MarketAsset,
  type MarketAssetDetail,
  type MarketAssetKind,
  type MarketAssetStatus,
  type MarketAssetVersion,
  type MarketAssetVersionStatus,
  type MarketCompatibility,
  type MarketEntitlement,
  type MarketInstallResult,
  type MarketInstallation,
  type MarketTemplate,
  type MarketTemplateCopy,
  type PublishMarketAssetVersionInput,
  type SetMarketAssetStatusInput,
  type SetMarketAssetVersionStatusInput,
} from "@pluginmax/contracts";
import type { Database } from "./database.js";
import { appendAuditEventWithClient } from "./audit-event-repository.js";

interface MarketAssetRow {
  readonly id: string;
  readonly asset_key: string;
  readonly kind: MarketAssetKind;
  readonly name: string;
  readonly description: string;
  readonly publisher_principal_id: string;
  readonly trust_level: "official" | "verified" | "private";
  readonly visibility: "public" | "private" | "workspace" | "project";
  readonly visibility_scope_id: string | null;
  readonly status: MarketAssetStatus;
  readonly current_version: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MarketAssetVersionRow {
  readonly id: string;
  readonly asset_id: string;
  readonly version: number;
  readonly digest: string;
  readonly publisher_principal_id: string;
  readonly manifest: unknown;
  readonly compatibility: MarketCompatibility;
  readonly status: MarketAssetVersionStatus;
  readonly created_at: Date;
}

interface MarketEntitlementRow {
  readonly id: string;
  readonly principal_id: string;
  readonly asset_id: string;
  readonly status: "active" | "revoked";
  readonly revision: number;
  readonly granted_by_principal_id: string;
  readonly granted_at: Date;
  readonly updated_at: Date;
}

interface MarketInstallationRow {
  readonly id: string;
  readonly principal_id: string;
  readonly asset_id: string;
  readonly asset_version_id: string;
  readonly entitlement_id: string;
  readonly status: "active" | "uninstalled";
  readonly revision: number;
  readonly config: Record<string, unknown>;
  readonly installed_by_principal_id: string;
  readonly installed_at: Date;
  readonly updated_at: Date;
  readonly asset_version: number;
}

interface MarketTemplateRow {
  readonly id: string;
  readonly asset_id: string;
  readonly template_key: string;
  readonly name: string;
  readonly status: "active" | "archived";
  readonly current_version: number;
  readonly created_by_principal_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MarketTemplateDependencyRow {
  readonly dependency_asset_id: string;
  readonly dependency_asset_key: string;
  readonly minimum_version: number;
  readonly required: boolean;
}

interface MarketTemplateCopyRow {
  readonly id: string;
  readonly principal_id: string;
  readonly template_id: string;
  readonly asset_version_id: string;
  readonly workbench_id: string;
  readonly status: "active" | "uninstalled";
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly asset_version: number;
}

export type MarketRepositoryErrorCode =
  | "market_asset_not_found"
  | "market_asset_version_not_found"
  | "market_asset_not_active"
  | "market_asset_key_conflict"
  | "market_asset_revision_conflict"
  | "market_version_digest_conflict"
  | "market_manifest_invalid"
  | "market_visibility_denied"
  | "market_entitlement_required"
  | "market_entitlement_not_found"
  | "market_installation_not_found"
  | "market_template_not_found"
  | "market_template_dependency_missing"
  | "market_template_copy_not_found"
  | "market_compatibility_unsupported";

export class MarketRepositoryError extends Error {
  constructor(
    readonly code: MarketRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MarketRepositoryError";
  }
}

export interface MarketVisibilityActor {
  readonly principalId: string;
  readonly authSource: "bearer" | "local-development";
  readonly platformAdministrator: boolean;
}

export class MarketRepository {
  constructor(private readonly database: Database) {}

  async listAssets(
    actor: MarketVisibilityActor,
    kind?: MarketAssetKind,
  ): Promise<MarketAsset[]> {
    const result = await this.database.query<MarketAssetRow>(
      `${visibilityAssetSelect}
       WHERE asset.status <> 'archived'
         AND ($1::text IS NULL OR asset.kind = $1)
       ORDER BY
         CASE asset.trust_level
           WHEN 'official' THEN 0
           WHEN 'verified' THEN 1
           ELSE 2
         END,
         asset.updated_at DESC,
         asset.id`,
      [kind ?? null],
    );
    const visible = await this.filterVisibleAssets(actor, result.rows);
    return visible.map(marketAssetFromRow);
  }

  async getAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    includeVersions = true,
  ): Promise<MarketAssetDetail | undefined> {
    const result = await this.database.query<MarketAssetRow>(
      `SELECT * FROM market_assets WHERE id = $1`,
      [assetId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (!(await this.canViewAsset(actor, row))) return undefined;
    const versions = includeVersions
      ? await this.listVersions(assetId)
      : [];
    return {
      ...marketAssetFromRow(row),
      versions,
    };
  }

  async createAsset(
    actor: MarketVisibilityActor,
    input: CreateMarketAssetInput,
  ): Promise<MarketAssetDetail> {
    const id = randomUUID();
    try {
      await this.database.query(
        `INSERT INTO market_assets (
           id, asset_key, kind, name, description, publisher_principal_id,
           trust_level, visibility, visibility_scope_id, status,
           current_version, revision, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 1, 1,
           NOW(), NOW()
         )`,
        [
          id,
          input.assetKey,
          input.kind,
          input.name,
          input.description,
          actor.principalId,
          input.trustLevel,
          input.visibility,
          input.visibilityScopeId ?? null,
        ],
      );
    } catch (error) {
      throw translateMarketConstraint(error, "market_asset_key_conflict");
    }
    await this.database.transaction(async (client) => {
      await appendAuditEventWithClient(client, {
        action: "market.asset.created",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId: id,
          assetKey: input.assetKey,
          kind: input.kind,
          trustLevel: input.trustLevel,
          visibility: input.visibility,
          visibilityScopeId: input.visibilityScopeId ?? null,
        },
      });
    });
    const asset = await this.getAsset(actor, id);
    if (asset === undefined) throw new Error("created Market asset is missing");
    return asset;
  }

  async publishVersion(
    actor: MarketVisibilityActor,
    assetId: string,
    input: PublishMarketAssetVersionInput,
  ): Promise<MarketAssetVersion> {
    return this.database.transaction(async (client) => {
      const assetResult = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1 FOR UPDATE`,
        [assetId],
      );
      const asset = assetResult.rows[0];
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (asset.status !== "active") {
        throw new MarketRepositoryError(
          "market_asset_not_active",
          "Market asset is not active",
        );
      }
      if (
        !actor.platformAdministrator &&
        asset.publisher_principal_id !== actor.principalId
      ) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the publisher or platform administrator can publish versions",
        );
      }
      const manifest = marketAssetManifestSchema.parse(input.manifest);
      const nextVersion = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
         FROM market_asset_versions
         WHERE asset_id = $1`,
        [assetId],
      );
      const version = nextVersion.rows[0]!.version;
      const digest = marketVersionDigest({
        assetKey: asset.asset_key,
        version,
        publisherPrincipalId: asset.publisher_principal_id,
        manifest,
        compatibility: input.compatibility,
      });
      if (
        input.expectedDigest !== undefined &&
        input.expectedDigest !== digest
      ) {
        throw new MarketRepositoryError(
          "market_version_digest_conflict",
          "Expected Market asset digest does not match the immutable payload",
        );
      }
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO market_asset_versions (
           id, asset_id, version, digest, publisher_principal_id, manifest,
           compatibility, status, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'published', NOW()
         )`,
        [
          versionId,
          assetId,
          version,
          digest,
          asset.publisher_principal_id,
          JSON.stringify(manifest),
          JSON.stringify(input.compatibility),
        ],
      );
      await client.query(
        `UPDATE market_assets
         SET current_version = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [assetId, version],
      );
      if (asset.kind === "workbench-template") {
        await this.writeTemplateVersionWithClient(client, {
          actorId: actor.principalId,
          asset,
          versionId,
          version,
          manifest,
        });
      }
      await appendAuditEventWithClient(client, {
        action: "market.asset.version.published",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId,
          assetKey: asset.asset_key,
          version,
          digest,
          kind: asset.kind,
        },
      });
      return {
        id: versionId,
        assetId,
        version,
        digest,
        publisherPrincipalId: asset.publisher_principal_id,
        manifest,
        compatibility: input.compatibility,
        status: "published",
        createdAt: new Date().toISOString(),
      };
    });
  }

  async setAssetStatus(
    actor: MarketVisibilityActor,
    assetId: string,
    input: SetMarketAssetStatusInput,
  ): Promise<MarketAsset> {
    return this.database.transaction(async (client) => {
      const result = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1 FOR UPDATE`,
        [assetId],
      );
      const asset = result.rows[0];
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (
        !actor.platformAdministrator &&
        asset.publisher_principal_id !== actor.principalId
      ) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the publisher or platform administrator can change lifecycle",
        );
      }
      if (asset.revision !== input.expectedRevision) {
        throw new MarketRepositoryError(
          "market_asset_revision_conflict",
          "Market asset revision changed",
        );
      }
      const updated = await client.query<MarketAssetRow>(
        `UPDATE market_assets
         SET status = $2,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [assetId, input.status],
      );
      await appendAuditEventWithClient(client, {
        action: "market.asset.status.changed",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId,
          previousStatus: asset.status,
          status: input.status,
          revision: input.expectedRevision + 1,
        },
      });
      return marketAssetFromRow(updated.rows[0]!);
    });
  }

  async setVersionStatus(
    actor: MarketVisibilityActor,
    assetId: string,
    version: number,
    input: SetMarketAssetVersionStatusInput,
  ): Promise<MarketAssetVersion> {
    return this.database.transaction(async (client) => {
      const assetResult = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1 FOR UPDATE`,
        [assetId],
      );
      const asset = assetResult.rows[0];
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (
        !actor.platformAdministrator &&
        asset.publisher_principal_id !== actor.principalId
      ) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the publisher or platform administrator can revoke versions",
        );
      }
      const result = await client.query<MarketAssetVersionRow>(
        `UPDATE market_asset_versions
         SET status = $3
         WHERE asset_id = $1 AND version = $2
         RETURNING *`,
        [assetId, version, input.status],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new MarketRepositoryError(
          "market_asset_version_not_found",
          "Market asset version not found",
        );
      }
      await appendAuditEventWithClient(client, {
        action: "market.asset.version.status.changed",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId,
          version,
          status: input.status,
          digest: row.digest,
        },
      });
      return marketVersionFromRow(row);
    });
  }

  async grantEntitlement(
    actor: MarketVisibilityActor,
    input: GrantMarketEntitlementInput,
  ): Promise<MarketEntitlement> {
    return this.database.transaction(async (client) => {
      const asset = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1`,
        [input.assetId],
      );
      const assetRow = asset.rows[0];
      if (assetRow === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (
        !actor.platformAdministrator &&
        assetRow.publisher_principal_id !== actor.principalId
      ) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the publisher or platform administrator can grant entitlements",
        );
      }
      const principal = await client.query(
        `SELECT 1 FROM principals WHERE id = $1 AND status = 'active'`,
        [input.principalId],
      );
      if (principal.rowCount === 0) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Entitlement target Principal is not active",
        );
      }
      const result = await client.query<MarketEntitlementRow>(
        `INSERT INTO market_entitlements (
           id, principal_id, asset_id, status, revision,
           granted_by_principal_id, granted_at, updated_at
         ) VALUES ($1, $2, $3, 'active', 1, $4, NOW(), NOW())
         ON CONFLICT (principal_id, asset_id) DO UPDATE
         SET status = 'active',
             revision = market_entitlements.revision + 1,
             granted_by_principal_id = EXCLUDED.granted_by_principal_id,
             granted_at = EXCLUDED.granted_at,
             updated_at = NOW()
         RETURNING *`,
        [randomUUID(), input.principalId, input.assetId, actor.principalId],
      );
      await appendAuditEventWithClient(client, {
        action: "market.entitlement.granted",
        actorPrincipalId: actor.principalId,
        subjectPrincipalId: input.principalId,
        metadata: {
          entitlementId: result.rows[0]!.id,
          assetId: input.assetId,
          assetKey: assetRow.asset_key,
          grantsAuthorization: false,
        },
      });
      return marketEntitlementFromRow(result.rows[0]!);
    });
  }

  async revokeEntitlement(
    actor: MarketVisibilityActor,
    entitlementId: string,
  ): Promise<MarketEntitlement> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<MarketEntitlementRow>(
        `SELECT * FROM market_entitlements WHERE id = $1 FOR UPDATE`,
        [entitlementId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new MarketRepositoryError(
          "market_entitlement_not_found",
          "Market entitlement not found",
        );
      }
      const asset = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1`,
        [row.asset_id],
      );
      const assetRow = asset.rows[0];
      if (
        !actor.platformAdministrator &&
        assetRow?.publisher_principal_id !== actor.principalId
      ) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the publisher or platform administrator can revoke entitlements",
        );
      }
      const updated = await client.query<MarketEntitlementRow>(
        `UPDATE market_entitlements
         SET status = 'revoked',
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [entitlementId],
      );
      await appendAuditEventWithClient(client, {
        action: "market.entitlement.revoked",
        actorPrincipalId: actor.principalId,
        subjectPrincipalId: row.principal_id,
        metadata: {
          entitlementId,
          assetId: row.asset_id,
          previousRevision: row.revision,
          revision: row.revision + 1,
          grantsAuthorization: false,
        },
      });
      return marketEntitlementFromRow(updated.rows[0]!);
    });
  }

  async listEntitlements(
    principalId: string,
  ): Promise<MarketEntitlement[]> {
    const result = await this.database.query<MarketEntitlementRow>(
      `SELECT * FROM market_entitlements
       WHERE principal_id = $1
       ORDER BY updated_at DESC, id`,
      [principalId],
    );
    return result.rows.map(marketEntitlementFromRow);
  }

  async listAllEntitlements(): Promise<MarketEntitlement[]> {
    const result = await this.database.query<MarketEntitlementRow>(
      `SELECT *
       FROM market_entitlements
       ORDER BY updated_at DESC, id`,
    );
    return result.rows.map(marketEntitlementFromRow);
  }

  async activeEntitlement(
    principalId: string,
    assetId: string,
  ): Promise<MarketEntitlementRow | undefined> {
    const result = await this.database.query<MarketEntitlementRow>(
      `SELECT * FROM market_entitlements
       WHERE principal_id = $1 AND asset_id = $2 AND status = 'active'`,
      [principalId, assetId],
    );
    return result.rows[0];
  }

  async hasPanelEntitlement(
    principalId: string,
    pluginId: string,
    minimumVersion: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1
       FROM market_entitlements AS entitlement
       JOIN market_assets AS asset
         ON asset.id = entitlement.asset_id
        AND asset.status = 'active'
        AND asset.kind = 'panel'
       JOIN market_asset_versions AS version
         ON version.asset_id = asset.id
        AND version.version = asset.current_version
        AND version.status = 'published'
        AND COALESCE((version.manifest ->> 'panelPluginId'), '') = $2
       WHERE entitlement.principal_id = $1
         AND entitlement.status = 'active'
         AND asset.current_version >= $3
       LIMIT 1`,
      [principalId, pluginId, minimumVersion],
    );
    return result.rowCount === 1;
  }

  async installAsset(
    actorId: string,
    input: InstallMarketAssetInput,
    idempotencyKey: string,
  ): Promise<MarketInstallResult> {
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`market-install:${actorId}:${input.assetId}`],
      );
      const entitlement = await client.query<MarketEntitlementRow>(
        `SELECT * FROM market_entitlements
         WHERE principal_id = $1 AND asset_id = $2 AND status = 'active'
         FOR UPDATE`,
        [actorId, input.assetId],
      );
      const entitlementRow = entitlement.rows[0];
      if (entitlementRow === undefined) {
        throw new MarketRepositoryError(
          "market_entitlement_required",
          "An active Market entitlement is required",
        );
      }
      const assetResult = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets WHERE id = $1`,
        [input.assetId],
      );
      const asset = assetResult.rows[0];
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (asset.status !== "active") {
        throw new MarketRepositoryError(
          "market_asset_not_active",
          "Market asset is not active",
        );
      }
      const versionResult = await client.query<MarketAssetVersionRow>(
        `SELECT * FROM market_asset_versions
         WHERE asset_id = $1 AND version = $2`,
        [input.assetId, input.version],
      );
      const version = versionResult.rows[0];
      if (version === undefined) {
        throw new MarketRepositoryError(
          "market_asset_version_not_found",
          "Market asset version not found",
        );
      }
      if (version.status !== "published") {
        throw new MarketRepositoryError(
          "market_asset_version_not_found",
          "Market asset version is not installable",
        );
      }
      if (!hostSupports(version.compatibility)) {
        throw new MarketRepositoryError(
          "market_compatibility_unsupported",
          "Market asset is incompatible with this host",
        );
      }
      const existing = await client.query<MarketInstallationRow>(
        `SELECT installation.*, version.version AS asset_version
         FROM market_installations AS installation
         JOIN market_asset_versions AS version
           ON version.id = installation.asset_version_id
         WHERE installation.principal_id = $1
           AND installation.asset_id = $2
         FOR UPDATE`,
        [actorId, input.assetId],
      );
      const current = existing.rows[0];
      if (
        current !== undefined &&
        current.status === "active" &&
        current.asset_version_id === version.id
      ) {
        return {
          installation: marketInstallationFromRow(current),
          created: false,
          deduplicated: true,
        };
      }
      const installationId = current?.id ?? randomUUID();
      const inserted = current === undefined
        ? await client.query<MarketInstallationRow>(
            `INSERT INTO market_installations (
               id, principal_id, asset_id, asset_version_id, entitlement_id,
               status, revision, idempotency_key, config,
               installed_by_principal_id, installed_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, 'active', 1, $6, $7::jsonb, $8,
               NOW(), NOW()
             )
             RETURNING *, $9::integer AS asset_version`,
            [
              installationId,
              actorId,
              input.assetId,
              version.id,
              entitlementRow.id,
              idempotencyKey,
              JSON.stringify(input.config),
              actorId,
              input.version,
            ],
          )
        : await client.query<MarketInstallationRow>(
            `UPDATE market_installations
             SET asset_version_id = $2,
                 entitlement_id = $3,
                 status = 'active',
                 revision = revision + 1,
                 idempotency_key = $4,
                 config = $5::jsonb,
                 installed_by_principal_id = $6,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *, $7::integer AS asset_version`,
            [
              installationId,
              version.id,
              entitlementRow.id,
              idempotencyKey,
              JSON.stringify(input.config),
              actorId,
              input.version,
            ],
          );
      await appendAuditEventWithClient(client, {
        action: current === undefined
          ? "market.asset.installed"
          : "market.asset.version.changed",
        actorPrincipalId: actorId,
        metadata: {
          installationId,
          assetId: input.assetId,
          assetKey: asset.asset_key,
          version: input.version,
          digest: version.digest,
          entitlementId: entitlementRow.id,
          grantsAuthorization: false,
        },
      });
      return {
        installation: marketInstallationFromRow(inserted.rows[0]!),
        created: current === undefined,
        deduplicated: false,
      };
    });
  }

  async uninstallAsset(
    actorId: string,
    assetId: string,
  ): Promise<MarketInstallation> {
    return this.database.transaction(async (client) => {
      const result = await client.query<MarketInstallationRow>(
        `UPDATE market_installations AS installation
         SET status = 'uninstalled',
             revision = revision + 1,
             updated_at = NOW()
         FROM market_asset_versions AS version
         WHERE installation.asset_id = $2
           AND installation.principal_id = $1
           AND version.id = installation.asset_version_id
         RETURNING installation.*, version.version AS asset_version`,
        [actorId, assetId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new MarketRepositoryError(
          "market_installation_not_found",
          "Market installation not found",
        );
      }
      await appendAuditEventWithClient(client, {
        action: "market.asset.uninstalled",
        actorPrincipalId: actorId,
        metadata: {
          installationId: row.id,
          assetId,
          revision: row.revision,
          grantsAuthorization: false,
        },
      });
      return marketInstallationFromRow(row);
    });
  }

  async listInstallations(
    principalId: string,
  ): Promise<MarketInstallation[]> {
    const result = await this.database.query<MarketInstallationRow>(
      `SELECT installation.*, version.version AS asset_version
       FROM market_installations AS installation
       JOIN market_asset_versions AS version
         ON version.id = installation.asset_version_id
       WHERE installation.principal_id = $1
       ORDER BY installation.updated_at DESC, installation.id`,
      [principalId],
    );
    return result.rows.map(marketInstallationFromRow);
  }

  async listTemplates(
    actor: MarketVisibilityActor,
  ): Promise<MarketTemplate[]> {
    const result = await this.database.query<MarketTemplateRow>(
      `SELECT template.*
       FROM market_templates AS template
       JOIN market_assets AS asset ON asset.id = template.asset_id
       WHERE template.status = 'active'
       ORDER BY template.updated_at DESC, template.id`,
    );
    const visible: MarketTemplate[] = [];
    for (const row of result.rows) {
      const asset = await this.database.query<MarketAssetRow>(
        "SELECT * FROM market_assets WHERE id = $1",
        [row.asset_id],
      );
      const assetRow = asset.rows[0];
      if (
        assetRow !== undefined &&
        (await this.canViewAsset(actor, assetRow))
      ) {
        visible.push(await this.templateFromRow(row));
      }
    }
    return visible;
  }

  async getTemplate(
    actor: MarketVisibilityActor,
    templateId: string,
  ): Promise<MarketTemplate | undefined> {
    const result = await this.database.query<MarketTemplateRow>(
      `SELECT * FROM market_templates WHERE id = $1`,
      [templateId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const asset = await this.database.query<MarketAssetRow>(
      "SELECT * FROM market_assets WHERE id = $1",
      [row.asset_id],
    );
    const assetRow = asset.rows[0];
    if (
      assetRow === undefined ||
      !(await this.canViewAsset(actor, assetRow))
    ) {
      return undefined;
    }
    return this.templateFromRow(row);
  }

  async templateVersionManifest(
    templateId: string,
    version: number,
  ): Promise<{
    readonly template: MarketTemplateRow;
    readonly asset: MarketAssetRow;
    readonly version: MarketAssetVersionRow;
  }> {
    const templateResult = await this.database.query<MarketTemplateRow>(
      `SELECT * FROM market_templates WHERE id = $1 AND status = 'active'`,
      [templateId],
    );
    const template = templateResult.rows[0];
    if (template === undefined) {
      throw new MarketRepositoryError(
        "market_template_not_found",
        "Market template not found",
      );
    }
    const assetResult = await this.database.query<MarketAssetRow>(
      `SELECT * FROM market_assets WHERE id = $1 AND status = 'active'`,
      [template.asset_id],
    );
    const asset = assetResult.rows[0];
    if (asset === undefined) {
      throw new MarketRepositoryError(
        "market_asset_not_active",
        "Market template asset is not active",
      );
    }
    const versionResult = await this.database.query<MarketAssetVersionRow>(
      `SELECT * FROM market_asset_versions
       WHERE asset_id = $1 AND version = $2 AND status = 'published'`,
      [template.asset_id, version],
    );
    const assetVersion = versionResult.rows[0];
    if (assetVersion === undefined) {
      throw new MarketRepositoryError(
        "market_asset_version_not_found",
        "Market template version not found",
      );
    }
    return { template, asset, version: assetVersion };
  }

  async dependencyStatus(
    templateId: string,
    versionId: string,
  ): Promise<
    Array<{
      readonly dependencyAssetKey: string;
      readonly minimumVersion: number;
      readonly required: boolean;
      readonly installed: boolean;
    }>
  > {
    const result = await this.database.query<
      MarketTemplateDependencyRow & { readonly installed: boolean }
    >(
      `SELECT
         dependency.dependency_asset_id,
         asset.asset_key AS dependency_asset_key,
         dependency.minimum_version,
         dependency.required,
         EXISTS (
           SELECT 1
           FROM market_installations AS installation
           JOIN market_asset_versions AS installed_version
             ON installed_version.id = installation.asset_version_id
           WHERE installation.asset_id = dependency.dependency_asset_id
             AND installation.status = 'active'
             AND installed_version.version >= dependency.minimum_version
         ) AS installed
       FROM market_template_dependencies AS dependency
       JOIN market_assets AS asset ON asset.id = dependency.dependency_asset_id
       WHERE dependency.template_id = $1
         AND dependency.asset_version_id = $2
       ORDER BY asset.asset_key`,
      [templateId, versionId],
    );
    return result.rows.map((row) => ({
      dependencyAssetKey: row.dependency_asset_key,
      minimumVersion: row.minimum_version,
      required: row.required,
      installed: row.installed,
    }));
  }

  async recordTemplateCopy(
    actorId: string,
    input: CopyMarketTemplateInput,
    workbenchId: string,
    idempotencyKey: string,
  ): Promise<MarketTemplateCopy> {
    const version = await this.templateVersionManifest(
      input.templateId,
      input.version,
    );
    return this.database.transaction(async (client) => {
      const result = await client.query<MarketTemplateCopyRow>(
        `INSERT INTO market_template_copies (
           id, principal_id, template_id, asset_version_id, workbench_id,
           status, revision, idempotency_key, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', 1, $6, NOW(), NOW()
         )
         ON CONFLICT (principal_id, template_id) DO UPDATE
         SET asset_version_id = EXCLUDED.asset_version_id,
             workbench_id = EXCLUDED.workbench_id,
             status = 'active',
             revision = market_template_copies.revision + 1,
             idempotency_key = EXCLUDED.idempotency_key,
             updated_at = NOW()
         RETURNING *, $7::integer AS asset_version`,
        [
          randomUUID(),
          actorId,
          input.templateId,
          version.version.id,
          workbenchId,
          idempotencyKey,
          input.version,
        ],
      );
      await appendAuditEventWithClient(client, {
        action: "market.template.copied",
        actorPrincipalId: actorId,
        metadata: {
          templateId: input.templateId,
          version: input.version,
          workbenchId,
          idempotencyKey,
        },
      });
      return marketTemplateCopyFromRow(result.rows[0]!);
    });
  }

  async existingTemplateCopy(
    actorId: string,
    templateId: string,
  ): Promise<MarketTemplateCopy | undefined> {
    const result = await this.database.query<MarketTemplateCopyRow>(
      `SELECT copy.*, version.version AS asset_version
       FROM market_template_copies AS copy
       JOIN market_asset_versions AS version
         ON version.id = copy.asset_version_id
       WHERE copy.principal_id = $1 AND copy.template_id = $2`,
      [actorId, templateId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : marketTemplateCopyFromRow(row);
  }

  async templateCopyWorkbenchIds(
    workbenchIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (workbenchIds.length === 0) return new Set();
    const result = await this.database.query<{ readonly workbench_id: string }>(
      `SELECT DISTINCT workbench_id
       FROM market_template_copies
       WHERE workbench_id = ANY($1::uuid[])`,
      [workbenchIds],
    );
    return new Set(result.rows.map((row) => row.workbench_id));
  }

  async uninstallTemplateCopy(
    actorId: string,
    templateId: string,
  ): Promise<MarketTemplateCopy> {
    return this.database.transaction(async (client) => {
      const result = await client.query<MarketTemplateCopyRow>(
        `UPDATE market_template_copies AS copy
         SET status = 'uninstalled',
             revision = revision + 1,
             updated_at = NOW()
         FROM market_asset_versions AS version
         WHERE copy.template_id = $2
           AND copy.principal_id = $1
           AND version.id = copy.asset_version_id
         RETURNING copy.*, version.version AS asset_version`,
        [actorId, templateId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new MarketRepositoryError(
          "market_template_copy_not_found",
          "Market template copy not found",
        );
      }
      await appendAuditEventWithClient(client, {
        action: "market.template.uninstalled",
        actorPrincipalId: actorId,
        metadata: {
          templateId,
          workbenchId: row.workbench_id,
          revision: row.revision,
        },
      });
      return marketTemplateCopyFromRow(row);
    });
  }

  private async writeTemplateVersionWithClient(
    client: PoolClient,
    input: {
      readonly actorId: string;
      readonly asset: MarketAssetRow;
      readonly versionId: string;
      readonly version: number;
      readonly manifest: ReturnType<typeof marketAssetManifestSchema.parse>;
    },
  ): Promise<void> {
    if (input.manifest.template === undefined) {
      throw new MarketRepositoryError(
        "market_manifest_invalid",
        "Workbench template manifest requires a layout template",
      );
    }
    const templateResult = await client.query<MarketTemplateRow>(
      `INSERT INTO market_templates (
         id, asset_id, template_key, name, status, current_version,
         created_by_principal_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW(), NOW())
       ON CONFLICT (asset_id) DO UPDATE
       SET current_version = EXCLUDED.current_version,
           updated_at = NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.asset.id,
        input.asset.asset_key,
        input.asset.name,
        input.version,
        input.actorId,
      ],
    );
    const template = templateResult.rows[0]!;
    for (const dependency of input.manifest.dependencies) {
      const asset = await client.query<MarketAssetRow>(
        `SELECT * FROM market_assets
         WHERE asset_key = $1 AND status = 'active'`,
        [dependency.dependencyAssetKey],
      );
      const dependencyAsset = asset.rows[0];
      if (dependencyAsset === undefined) {
        if (dependency.required) {
          throw new MarketRepositoryError(
            "market_template_dependency_missing",
            `Market template dependency ${dependency.dependencyAssetKey} is missing`,
          );
        }
        continue;
      }
      const versions = await client.query(
        `SELECT 1
         FROM market_asset_versions
         WHERE asset_id = $1
           AND version >= $2
           AND status = 'published'
         LIMIT 1`,
        [dependencyAsset.id, dependency.minimumVersion],
      );
      if (versions.rowCount === 0 && dependency.required) {
        throw new MarketRepositoryError(
          "market_template_dependency_missing",
          `Market template dependency ${dependency.dependencyAssetKey} does not satisfy minimum version`,
        );
      }
      await client.query(
        `INSERT INTO market_template_dependencies (
           template_id, asset_version_id, dependency_asset_id,
           minimum_version, required, created_at
         ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          template.id,
          input.versionId,
          dependencyAsset.id,
          dependency.minimumVersion,
          dependency.required,
        ],
      );
    }
  }

  private async templateFromRow(
    row: MarketTemplateRow,
  ): Promise<MarketTemplate> {
    const version = await this.database.query<{ readonly id: string }>(
      `SELECT id FROM market_asset_versions
       WHERE asset_id = $1 AND version = $2`,
      [row.asset_id, row.current_version],
    );
    const dependencies = await this.database.query<MarketTemplateDependencyRow>(
      `SELECT
         dependency.dependency_asset_id,
         asset.asset_key AS dependency_asset_key,
         dependency.minimum_version,
         dependency.required
       FROM market_template_dependencies AS dependency
       JOIN market_assets AS asset ON asset.id = dependency.dependency_asset_id
       WHERE dependency.template_id = $1
         AND dependency.asset_version_id = $2
       ORDER BY asset.asset_key`,
      [row.id, version.rows[0]?.id ?? randomUUID()],
    );
    return {
      id: row.id,
      assetId: row.asset_id,
      templateKey: row.template_key,
      name: row.name,
      status: row.status,
      currentVersion: row.current_version,
      createdByPrincipalId: row.created_by_principal_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      dependencies: dependencies.rows.map((dependency) => ({
        dependencyAssetId: dependency.dependency_asset_id,
        dependencyAssetKey: dependency.dependency_asset_key,
        minimumVersion: dependency.minimum_version,
        required: dependency.required,
      })),
    };
  }

  private async listVersions(assetId: string): Promise<MarketAssetVersion[]> {
    const result = await this.database.query<MarketAssetVersionRow>(
      `SELECT * FROM market_asset_versions
       WHERE asset_id = $1
       ORDER BY version DESC`,
      [assetId],
    );
    return result.rows.map(marketVersionFromRow);
  }

  private async filterVisibleAssets(
    actor: MarketVisibilityActor,
    rows: readonly MarketAssetRow[],
  ): Promise<MarketAssetRow[]> {
    const visible: MarketAssetRow[] = [];
    for (const row of rows) {
      if (await this.canViewAsset(actor, row)) visible.push(row);
    }
    return visible;
  }

  private async canViewAsset(
    actor: MarketVisibilityActor,
    asset: MarketAssetRow,
  ): Promise<boolean> {
    if (
      actor.platformAdministrator ||
      asset.publisher_principal_id === actor.principalId ||
      asset.visibility === "public"
    ) {
      return true;
    }
    const entitlement = await this.database.query(
      `SELECT 1 FROM market_entitlements
       WHERE principal_id = $1 AND asset_id = $2 AND status = 'active'`,
      [actor.principalId, asset.id],
    );
    if (entitlement.rowCount === 1) return true;
    if (asset.visibility === "workspace") {
      const membership = await this.database.query(
        `SELECT 1
         FROM workspace_members
         WHERE workspace_id = $1 AND principal_id = $2 AND status = 'active'`,
        [asset.visibility_scope_id, actor.principalId],
      );
      return membership.rowCount === 1;
    }
    if (asset.visibility === "project") {
      const membership = await this.database.query(
        `SELECT 1
         FROM project_members
         WHERE project_id::text = $1
           AND principal_id = $2
           AND status = 'active'`,
        [asset.visibility_scope_id, actor.principalId],
      );
      return membership.rowCount === 1;
    }
    return false;
  }
}

const visibilityAssetSelect = `SELECT asset.* FROM market_assets AS asset`;

function marketAssetFromRow(row: MarketAssetRow): MarketAsset {
  return {
    id: row.id,
    assetKey: row.asset_key,
    kind: row.kind,
    name: row.name,
    description: row.description,
    publisherPrincipalId: row.publisher_principal_id,
    trustLevel: row.trust_level,
    visibility: row.visibility,
    visibilityScopeId: row.visibility_scope_id,
    status: row.status,
    currentVersion: row.current_version,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function marketVersionFromRow(row: MarketAssetVersionRow): MarketAssetVersion {
  return {
    id: row.id,
    assetId: row.asset_id,
    version: row.version,
    digest: row.digest,
    publisherPrincipalId: row.publisher_principal_id,
    manifest: marketAssetManifestSchema.parse(row.manifest),
    compatibility: row.compatibility,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function marketEntitlementFromRow(
  row: MarketEntitlementRow,
): MarketEntitlement {
  return {
    id: row.id,
    principalId: row.principal_id,
    assetId: row.asset_id,
    status: row.status,
    revision: row.revision,
    grantedByPrincipalId: row.granted_by_principal_id,
    grantedAt: row.granted_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    grantsAuthorization: false,
  };
}

function marketInstallationFromRow(
  row: MarketInstallationRow,
): MarketInstallation {
  return {
    id: row.id,
    principalId: row.principal_id,
    assetId: row.asset_id,
    assetVersionId: row.asset_version_id,
    assetVersion: row.asset_version,
    entitlementId: row.entitlement_id,
    status: row.status,
    revision: row.revision,
    config: row.config,
    installedByPrincipalId: row.installed_by_principal_id,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    grantsAuthorization: false,
  };
}

function marketTemplateCopyFromRow(
  row: MarketTemplateCopyRow,
): MarketTemplateCopy {
  return {
    id: row.id,
    principalId: row.principal_id,
    templateId: row.template_id,
    assetVersionId: row.asset_version_id,
    assetVersion: row.asset_version,
    workbenchId: row.workbench_id,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function marketVersionDigest(input: {
  readonly assetKey: string;
  readonly version: number;
  readonly publisherPrincipalId: string;
  readonly manifest: unknown;
  readonly compatibility: unknown;
}): string {
  return createHash("sha256")
    .update(canonicalWorkbenchJson(input))
    .digest("hex");
}

function hostSupports(compatibility: MarketCompatibility): boolean {
  const host = [2, 0, 0] as const;
  const minimum = parseVersion(compatibility.minHostVersion);
  if (minimum === undefined || compareVersions(host, minimum) < 0) {
    return false;
  }
  if (compatibility.maxHostVersion === undefined) return true;
  const maximum = parseVersion(compatibility.maxHostVersion);
  return maximum !== undefined && compareVersions(host, maximum) <= 0;
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function translateMarketConstraint(
  error: unknown,
  code: MarketRepositoryErrorCode,
): MarketRepositoryError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  ) {
    return new MarketRepositoryError(
      code,
      "Market record conflicts with an existing record",
    );
  }
  return error instanceof MarketRepositoryError
    ? error
    : new MarketRepositoryError(code, "Market write failed");
}
