import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  canonicalWorkbenchJson,
  marketAssetManifestSchema,
  mapVisibilityToSharingScope,
  type MarketAdminLockInput,
  type CopyMarketTemplateInput,
  type CreateMarketAssetInput,
  type GrantMarketEntitlementInput,
  type InstallMarketAssetInput,
  type MarketAsset,
  type MarketAssetDetail,
  type MarketAssetKind,
  type MarketAssetResourceBinding,
  type MarketAssetStatus,
  type MarketAssetVersion,
  type MarketAssetVersionStatus,
  type MarketAvailabilityStatus,
  type MarketCompatibility,
  type MarketEntitlement,
  type MarketGovernanceActionInput,
  type MarketGovernanceAudit,
  type MarketInstallResult,
  type MarketInstallation,
  type MarketInstallationImpact,
  type MarketOrigin,
  type MarketPublicationStatus,
  type MarketResourceBindingInput,
  type MarketResourceKind,
  type MarketSharingScope,
  type MarketSuspendInput,
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
  readonly origin: MarketOrigin;
  readonly sharing_scope: MarketSharingScope;
  readonly sharing_scope_id: string | null;
  readonly publication_status: MarketPublicationStatus;
  readonly availability_status: MarketAvailabilityStatus;
  readonly admin_locked: boolean;
  readonly admin_locked_at: Date | null;
  readonly admin_locked_by_principal_id: string | null;
  readonly admin_lock_reason: string | null;
  readonly published_at: Date | null;
  readonly delisted_at: Date | null;
  readonly archived_at: Date | null;
  readonly suspended_at: Date | null;
  readonly suspended_reason: string | null;
  readonly publication_changed_at: Date;
  readonly availability_changed_at: Date;
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
  readonly publication_status: MarketPublicationStatus;
  readonly availability_status: MarketAvailabilityStatus;
  readonly suspended_reason: string | null;
}

interface MarketGovernanceAuditRow {
  readonly id: string;
  readonly asset_id: string;
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

interface MarketResourceBindingRow {
  readonly id: string;
  readonly asset_id: string;
  readonly asset_version_id: string;
  readonly resource_kind: MarketResourceKind;
  readonly resource_id: string;
  readonly resource_version_id: string | null;
  readonly created_by_principal_id: string;
  readonly created_at: Date;
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
  | "market_compatibility_unsupported"
  | "market_governance_transition_invalid"
  | "market_admin_lock_conflict"
  | "market_resource_binding_conflict"
  | "market_resource_not_found";

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
       WHERE ($1::text IS NULL OR asset.kind = $1)
       ORDER BY
         CASE asset.publication_status
           WHEN 'published' THEN 0
           WHEN 'draft' THEN 1
           WHEN 'delisted' THEN 2
           ELSE 3
         END,
         CASE asset.trust_level
           WHEN 'official' THEN 0
           WHEN 'verified' THEN 1
           ELSE 2
         END,
         asset.updated_at DESC,
         asset.id`,
      [kind ?? null],
    );
    const visible = (await this.filterVisibleAssets(actor, result.rows)).filter(
      (asset) =>
        asset.publisher_principal_id === actor.principalId ||
        actor.platformAdministrator ||
        (asset.publication_status === "published" &&
          asset.availability_status === "active"),
    );
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
    const resourceBindings = await this.listResourceBindings(assetId);
    const impact = await this.installationImpact(row);
    return {
      ...marketAssetFromRow(row),
      versions,
      resourceBindings,
      installationImpact: impact,
    };
  }

  async createAsset(
    actor: MarketVisibilityActor,
    input: CreateMarketAssetInput,
    recordGovernanceAudit = false,
  ): Promise<MarketAssetDetail> {
    const id = randomUUID();
    const sharingScope =
      input.sharingScope ??
      (input.visibility === undefined
        ? "private"
        : mapVisibilityToSharingScope(input.visibility));
    const origin =
      input.origin ??
      (input.trustLevel === "official" || input.trustLevel === "verified"
        ? "platform"
        : "user");
    await this.database.transaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO market_assets (
             id, asset_key, kind, name, description, publisher_principal_id,
             origin, sharing_scope, sharing_scope_id, publication_status,
             availability_status, current_version, revision, created_at,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 1, 1,
             NOW(), NOW()
           )`,
          [
            id,
            input.assetKey,
            input.kind,
            input.name,
            input.description,
            actor.principalId,
            origin,
            sharingScope,
            sharingScope === "project" || sharingScope === "workspace"
              ? (input.visibilityScopeId ?? null)
              : null,
            input.publicationStatus,
          ],
        );
      } catch (error) {
        throw translateMarketConstraint(error, "market_asset_key_conflict");
      }
      if (recordGovernanceAudit) {
        await appendMarketGovernanceAuditWithClient(client, {
          assetId: id,
          action: "market.asset.created",
          actor,
          reason: "",
          fromState: {},
          toState: {
            origin,
            sharingScope,
            publicationStatus: input.publicationStatus,
            availabilityStatus: "active",
          },
          revision: 1,
        });
      }
      await appendAuditEventWithClient(client, {
        action: "market.asset.created",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId: id,
          assetKey: input.assetKey,
          kind: input.kind,
          origin,
          sharingScope,
          publicationStatus: input.publicationStatus,
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
    recordGovernanceAudit = false,
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
      if (asset.publication_status === "archived") {
        throw new MarketRepositoryError(
          "market_asset_not_active",
          "Archived Market assets cannot receive versions",
        );
      }
      if (!this.canGovernAsset(actor, asset)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can publish versions",
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
      if (recordGovernanceAudit) {
        await appendMarketGovernanceAuditWithClient(client, {
          assetId,
          action: "market.asset.version.published",
          actor,
          reason: "",
          fromState: {
            currentVersion: asset.current_version,
            publicationStatus: asset.publication_status,
          },
          toState: {
            currentVersion: version,
            publicationStatus: asset.publication_status,
          },
          revision: asset.revision + 1,
        });
      }
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
    recordGovernanceAudit = false,
  ): Promise<MarketAsset> {
    return this.database.transaction(async (client) => {
      const asset = await lockMarketAssetWithClient(client, assetId);
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (!this.canGovernAsset(actor, asset)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can change lifecycle",
        );
      }
      requireMarketRevision(asset, input.expectedRevision);
      const publicationStatus: MarketPublicationStatus =
        input.status === "active"
          ? "published"
          : input.status === "delisted"
            ? "delisted"
            : "archived";
      const availabilityStatus =
        input.status === "active" ? asset.availability_status : "active";
      const updated = await client.query<MarketAssetRow>(
        `UPDATE market_assets
         SET publication_status = $2,
             availability_status = $3,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [assetId, publicationStatus, availabilityStatus],
      );
      const row = updated.rows[0]!;
      if (recordGovernanceAudit) {
        await appendMarketGovernanceAuditWithClient(client, {
          assetId,
          action: "market.asset.legacy_status.changed",
          actor,
          reason: "",
          fromState: marketGovernanceState(asset),
          toState: marketGovernanceState(row),
          revision: row.revision,
        });
      }
      await appendAuditEventWithClient(client, {
        action: "market.asset.status.changed",
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId,
          previousStatus: asset.status,
          status: row.status,
          publicationStatus,
          availabilityStatus,
          revision: row.revision,
        },
      });
      return marketAssetFromRow(row);
    });
  }

  async delistAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.delisted",
      (asset) => {
        if (asset.publication_status !== "published") {
          throw invalidGovernanceTransition("Only published assets can be delisted");
        }
        return {
          publicationStatus: "delisted",
          availabilityStatus: asset.availability_status,
        };
      },
    );
  }

  async publishAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.published",
      (asset) => {
        if (asset.publication_status !== "draft") {
          throw invalidGovernanceTransition(
            "Only draft assets can be published for the first time",
          );
        }
        return {
          publicationStatus: "published",
          availabilityStatus: asset.availability_status,
        };
      },
    );
  }

  async relistAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.relisted",
      (asset) => {
        if (asset.publication_status !== "delisted") {
          throw invalidGovernanceTransition(
            "Only delisted assets can be relisted",
          );
        }
        if (asset.admin_locked && !actor.platformAdministrator) {
          throw new MarketRepositoryError(
            "market_admin_lock_conflict",
            "An administrator lock blocks the owner from relisting this asset",
          );
        }
        return {
          publicationStatus: "published",
          availabilityStatus: asset.availability_status,
        };
      },
    );
  }

  async suspendAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketSuspendInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.suspended",
      (asset) => {
        if (asset.availability_status !== "active") {
          throw invalidGovernanceTransition(
            "Only active assets can be suspended",
          );
        }
        return {
          publicationStatus: asset.publication_status,
          availabilityStatus: "suspended",
          suspendedReason: input.reason,
        };
      },
    );
  }

  async resumeAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.resumed",
      (asset) => {
        if (asset.availability_status !== "suspended") {
          throw invalidGovernanceTransition(
            "Only suspended assets can be resumed",
          );
        }
        if (asset.admin_locked && !actor.platformAdministrator) {
          throw new MarketRepositoryError(
            "market_admin_lock_conflict",
            "An administrator lock blocks the owner from resuming this asset",
          );
        }
        return {
          publicationStatus: asset.publication_status,
          availabilityStatus: "active",
          suspendedReason: null,
        };
      },
    );
  }

  async archiveAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.archived",
      (asset) => {
        if (asset.publication_status === "archived") {
          throw invalidGovernanceTransition("Market asset is already archived");
        }
        return {
          publicationStatus: "archived",
          availabilityStatus: asset.availability_status,
        };
      },
    );
  }

  async lockAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketAdminLockInput,
  ): Promise<MarketAsset> {
    if (!actor.platformAdministrator) {
      throw new MarketRepositoryError(
        "market_visibility_denied",
        "Only platform administrators can lock Market governance",
      );
    }
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.admin_locked",
      (asset) => {
        if (asset.admin_locked) {
          throw invalidGovernanceTransition("Market asset is already locked");
        }
        if (asset.sharing_scope === "private") {
          throw new MarketRepositoryError(
            "market_visibility_denied",
            "Administrators cannot lock another Principal's private resource",
          );
        }
        return {
          publicationStatus: asset.publication_status,
          availabilityStatus: asset.availability_status,
          adminLocked: true,
          adminLockReason: input.reason,
        };
      },
    );
  }

  async unlockAsset(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
  ): Promise<MarketAsset> {
    if (!actor.platformAdministrator) {
      throw new MarketRepositoryError(
        "market_visibility_denied",
        "Only platform administrators can unlock Market governance",
      );
    }
    return this.changeGovernance(
      actor,
      assetId,
      input,
      "market.asset.admin_unlocked",
      (asset) => {
        if (!asset.admin_locked) {
          throw invalidGovernanceTransition("Market asset is not locked");
        }
        return {
          publicationStatus: asset.publication_status,
          availabilityStatus: asset.availability_status,
          adminLocked: false,
          adminLockReason: null,
        };
      },
    );
  }

  async getGovernanceAudit(
    actor: MarketVisibilityActor,
    assetId: string,
  ): Promise<MarketGovernanceAudit[]> {
    const asset = await this.getAssetRow(assetId);
    if (asset === undefined || !(await this.canViewAsset(actor, asset))) {
      throw new MarketRepositoryError(
        "market_asset_not_found",
        "Market asset not found",
      );
    }
    const result = await this.database.query<MarketGovernanceAuditRow>(
      `SELECT *
       FROM market_governance_audit_events
       WHERE asset_id = $1
       ORDER BY seq DESC`,
      [assetId],
    );
    return result.rows.map(marketGovernanceAuditFromRow);
  }

  async installationImpactForAsset(
    actor: MarketVisibilityActor,
    assetId: string,
  ): Promise<MarketInstallationImpact> {
    const asset = await this.getAssetRow(assetId);
    if (asset === undefined || !(await this.canViewAsset(actor, asset))) {
      throw new MarketRepositoryError(
        "market_asset_not_found",
        "Market asset not found",
      );
    }
    return this.installationImpact(asset);
  }

  async listResourceBindings(
    assetId: string,
  ): Promise<MarketAssetResourceBinding[]> {
    const result = await this.database.query<MarketResourceBindingRow>(
      `SELECT *
       FROM market_asset_resource_bindings
       WHERE asset_id = $1
       ORDER BY created_at DESC, id`,
      [assetId],
    );
    return result.rows.map(marketResourceBindingFromRow);
  }

  async bindResource(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketResourceBindingInput,
  ): Promise<MarketAssetResourceBinding> {
    return this.database.transaction(async (client) => {
      const asset = await lockMarketAssetWithClient(client, assetId);
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (!this.canGovernAsset(actor, asset)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can bind resources",
        );
      }
      const version = await client.query(
        `SELECT 1
         FROM market_asset_versions
         WHERE id = $1 AND asset_id = $2`,
        [input.assetVersionId, assetId],
      );
      if (version.rowCount === 0) {
        throw new MarketRepositoryError(
          "market_asset_version_not_found",
          "Market asset version not found",
        );
      }
      try {
        const result = await client.query<MarketResourceBindingRow>(
          `INSERT INTO market_asset_resource_bindings (
             id, asset_id, asset_version_id, resource_kind, resource_id,
             resource_version_id, created_by_principal_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           RETURNING *`,
          [
            randomUUID(),
            assetId,
            input.assetVersionId,
            input.resourceKind,
            input.resourceId,
            input.resourceVersionId,
            actor.principalId,
          ],
        );
        await appendMarketGovernanceAuditWithClient(client, {
          assetId,
          action: "market.asset.resource.bound",
          actor,
          reason: "",
          fromState: {},
          toState: {
            assetVersionId: input.assetVersionId,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            resourceVersionId: input.resourceVersionId,
          },
          revision: asset.revision,
        });
        return marketResourceBindingFromRow(result.rows[0]!);
      } catch (error) {
        if (
          error instanceof Error &&
          /resource binding target does not exist/i.test(error.message)
        ) {
          throw new MarketRepositoryError(
            "market_resource_not_found",
            "Market resource binding target does not exist",
          );
        }
        throw translateMarketConstraint(
          error,
          "market_resource_binding_conflict",
        );
      }
    });
  }

  private async changeGovernance(
    actor: MarketVisibilityActor,
    assetId: string,
    input: MarketGovernanceActionInput,
    action: string,
    transition: (
      asset: MarketAssetRow,
    ) => {
      readonly publicationStatus: MarketPublicationStatus;
      readonly availabilityStatus: MarketAvailabilityStatus;
      readonly suspendedReason?: string | null;
      readonly adminLocked?: boolean;
      readonly adminLockReason?: string | null;
    },
  ): Promise<MarketAsset> {
    return this.database.transaction(async (client) => {
      const asset = await lockMarketAssetWithClient(client, assetId);
      if (asset === undefined) {
        throw new MarketRepositoryError(
          "market_asset_not_found",
          "Market asset not found",
        );
      }
      if (!this.canGovernAsset(actor, asset)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can govern this asset",
        );
      }
      requireMarketRevision(asset, input.expectedRevision);
      const target = transition(asset);
      const adminLocked = target.adminLocked ?? asset.admin_locked;
      const needLockFields = target.adminLocked === true;
      const clearLockFields = target.adminLocked === false;
      const updated = await client.query<MarketAssetRow>(
        `UPDATE market_assets
         SET publication_status = $2,
             availability_status = $3,
             suspended_reason = $4,
             admin_locked = $5,
             admin_locked_at = CASE
               WHEN $6::boolean THEN NOW()
               WHEN $7::boolean THEN NULL
               ELSE admin_locked_at
             END,
             admin_locked_by_principal_id = CASE
               WHEN $6::boolean THEN $8
               WHEN $7::boolean THEN NULL
               ELSE admin_locked_by_principal_id
             END,
             admin_lock_reason = CASE
               WHEN $6::boolean THEN $9
               WHEN $7::boolean THEN NULL
               ELSE admin_lock_reason
             END,
             revision = revision + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          assetId,
          target.publicationStatus,
          target.availabilityStatus,
          target.availabilityStatus === "suspended"
            ? (target.suspendedReason ?? asset.suspended_reason)
            : null,
          adminLocked,
          needLockFields,
          clearLockFields,
          actor.principalId,
          target.adminLockReason ?? input.reason,
        ],
      );
      const row = updated.rows[0]!;
      await appendMarketGovernanceAuditWithClient(client, {
        assetId,
        action,
        actor,
        reason: input.reason,
        fromState: marketGovernanceState(asset),
        toState: marketGovernanceState(row),
        revision: row.revision,
      });
      await appendAuditEventWithClient(client, {
        action,
        actorPrincipalId: actor.principalId,
        metadata: {
          assetId,
          assetKey: asset.asset_key,
          fromState: marketGovernanceState(asset),
          toState: marketGovernanceState(row),
          revision: row.revision,
          reason: input.reason,
        },
      });
      return marketAssetFromRow(row);
    });
  }

  private async getAssetRow(assetId: string): Promise<MarketAssetRow | undefined> {
    const result = await this.database.query<MarketAssetRow>(
      `SELECT * FROM market_assets WHERE id = $1`,
      [assetId],
    );
    return result.rows[0];
  }

  private async installationImpact(
    asset: MarketAssetRow,
  ): Promise<MarketInstallationImpact> {
    const counts = await this.database.query<{
      readonly active_installations: string;
      readonly uninstalled_installations: string;
      readonly active_template_copies: string;
    }>(
      `SELECT
         (
           SELECT COUNT(*)::text
           FROM market_installations
           WHERE asset_id = $1 AND status = 'active'
         ) AS active_installations,
         (
           SELECT COUNT(*)::text
           FROM market_installations
           WHERE asset_id = $1 AND status = 'uninstalled'
         ) AS uninstalled_installations,
         (
           SELECT COUNT(*)::text
           FROM market_template_copies AS copy
           JOIN market_templates AS template ON template.id = copy.template_id
           WHERE template.asset_id = $1 AND copy.status = 'active'
         ) AS active_template_copies`,
      [asset.id],
    );
    const row = counts.rows[0]!;
    const newInstallAllowed =
      asset.publication_status === "published" &&
      asset.availability_status === "active";
    const existingRunsAllowed =
      asset.publication_status !== "draft" &&
      asset.availability_status === "active";
    return {
      activeInstallations: Number(row.active_installations),
      uninstalledInstallations: Number(row.uninstalled_installations),
      activeTemplateCopies: Number(row.active_template_copies),
      newInstallAllowed,
      existingRunsAllowed,
      blockedReason: marketExecutionBlockedReason(asset),
    };
  }

  private canGovernAsset(
    actor: MarketVisibilityActor,
    asset: MarketAssetRow,
  ): boolean {
    if (asset.publisher_principal_id === actor.principalId) return true;
    return (
      actor.platformAdministrator &&
      asset.sharing_scope !== "private"
    );
  }

  async setVersionStatus(
    actor: MarketVisibilityActor,
    assetId: string,
    version: number,
    input: SetMarketAssetVersionStatusInput,
  ): Promise<MarketAssetVersion> {
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
      if (!this.canGovernAsset(actor, asset)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can revoke versions",
        );
      }
      const versionResult = await client.query<MarketAssetVersionRow>(
        `UPDATE market_asset_versions
         SET status = $3
         WHERE asset_id = $1 AND version = $2
         RETURNING *`,
        [assetId, version, input.status],
      );
      const row = versionResult.rows[0];
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
      if (!this.canGovernAsset(actor, assetRow)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can grant entitlements",
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
      if (assetRow === undefined || !this.canGovernAsset(actor, assetRow)) {
        throw new MarketRepositoryError(
          "market_visibility_denied",
          "Only the owner or an authorized platform administrator can revoke entitlements",
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
    mode: "install" | "runtime" = "runtime",
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1
       FROM market_entitlements AS entitlement
       JOIN market_assets AS asset
         ON asset.id = entitlement.asset_id
        AND asset.kind = 'panel'
        AND asset.availability_status = 'active'
        AND (
          ($4::text = 'install' AND asset.publication_status = 'published')
          OR
          ($4::text = 'runtime' AND asset.publication_status <> 'draft')
        )
       JOIN market_asset_versions AS version
         ON version.asset_id = asset.id
        AND version.version = asset.current_version
        AND version.status = 'published'
        AND COALESCE((version.manifest ->> 'panelPluginId'), '') = $2
       JOIN market_installations AS installation
         ON installation.principal_id = entitlement.principal_id
        AND installation.asset_id = asset.id
        AND installation.status = 'active'
       WHERE entitlement.principal_id = $1
         AND entitlement.status = 'active'
         AND asset.current_version >= $3
       LIMIT 1`,
      [principalId, pluginId, minimumVersion, mode],
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
      if (asset.publication_status !== "published") {
        throw new MarketRepositoryError(
          "market_asset_not_active",
          "Market asset is not published for new installation",
        );
      }
      if (asset.availability_status !== "active") {
        throw new MarketRepositoryError(
          "market_asset_not_active",
          asset.suspended_reason === null
            ? "Market asset is suspended"
            : `Market asset is suspended: ${asset.suspended_reason}`,
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
        `SELECT
           installation.*,
           version.version AS asset_version,
           asset.publication_status,
           asset.availability_status,
           asset.suspended_reason
         FROM market_installations AS installation
         JOIN market_asset_versions AS version
           ON version.id = installation.asset_version_id
         JOIN market_assets AS asset ON asset.id = installation.asset_id
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
        installation: marketInstallationFromRow({
          ...inserted.rows[0]!,
          publication_status: asset.publication_status,
          availability_status: asset.availability_status,
          suspended_reason: asset.suspended_reason,
        }),
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
             revision = installation.revision + 1,
             updated_at = NOW()
         FROM market_asset_versions AS version
         JOIN market_assets AS asset ON asset.id = version.asset_id
         WHERE installation.asset_id = $2
           AND installation.principal_id = $1
           AND version.id = installation.asset_version_id
         RETURNING
           installation.*,
           version.version AS asset_version,
           asset.publication_status,
           asset.availability_status,
           asset.suspended_reason`,
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
      `SELECT
         installation.*,
         version.version AS asset_version,
         asset.publication_status,
         asset.availability_status,
         asset.suspended_reason
       FROM market_installations AS installation
       JOIN market_asset_versions AS version
         ON version.id = installation.asset_version_id
       JOIN market_assets AS asset ON asset.id = installation.asset_id
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
        (await this.canViewAsset(actor, assetRow)) &&
        (assetRow.publisher_principal_id === actor.principalId ||
          actor.platformAdministrator ||
          (assetRow.publication_status === "published" &&
            assetRow.availability_status === "active"))
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
      `SELECT *
       FROM market_assets
       WHERE id = $1
         AND publication_status = 'published'
         AND availability_status = 'active'`,
      [template.asset_id],
    );
    const asset = assetResult.rows[0];
    if (asset === undefined) {
      throw new MarketRepositoryError(
        "market_asset_not_active",
        "Market template asset is not published and available",
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
         AND asset.availability_status = 'active'
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
         WHERE asset_key = $1
           AND publication_status = 'published'
           AND availability_status = 'active'`,
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
    if (asset.publisher_principal_id === actor.principalId) {
      return true;
    }
    if (asset.sharing_scope === "private") {
      return false;
    }
    if (asset.sharing_scope === "platform") {
      return true;
    }
    if (actor.platformAdministrator) {
      return true;
    }
    const entitlement = await this.database.query(
      `SELECT 1 FROM market_entitlements
       WHERE principal_id = $1 AND asset_id = $2 AND status = 'active'`,
      [actor.principalId, asset.id],
    );
    if (entitlement.rowCount === 1) return true;
    if (asset.sharing_scope === "workspace") {
      const membership = await this.database.query(
        `SELECT 1
         FROM workspace_members
         WHERE workspace_id = $1 AND principal_id = $2 AND status = 'active'`,
        [asset.sharing_scope_id, actor.principalId],
      );
      return membership.rowCount === 1;
    }
    if (asset.sharing_scope === "project") {
      const membership = await this.database.query(
        `SELECT 1
         FROM project_members
         WHERE project_id::text = $1
           AND principal_id = $2
           AND status = 'active'`,
        [asset.sharing_scope_id, actor.principalId],
      );
      return membership.rowCount === 1;
    }
    return false;
  }
}

const visibilityAssetSelect = `SELECT asset.* FROM market_assets AS asset`;

function marketAssetFromRow(row: MarketAssetRow): MarketAsset {
  const newInstallAllowed =
    row.publication_status === "published" &&
    row.availability_status === "active";
  const existingRunsAllowed =
    row.publication_status !== "draft" &&
    row.availability_status === "active";
  return {
    id: row.id,
    assetKey: row.asset_key,
    kind: row.kind,
    name: row.name,
    description: row.description,
    publisherPrincipalId: row.publisher_principal_id,
    origin: row.origin,
    sharingScope: row.sharing_scope,
    sharingScopeId: row.sharing_scope_id,
    publicationStatus: row.publication_status,
    availabilityStatus: row.availability_status,
    adminLocked: row.admin_locked,
    adminLockedAt: row.admin_locked_at?.toISOString() ?? null,
    adminLockedByPrincipalId: row.admin_locked_by_principal_id,
    adminLockReason: row.admin_lock_reason,
    publicationChangedAt: row.publication_changed_at.toISOString(),
    availabilityChangedAt: row.availability_changed_at.toISOString(),
    suspendedReason: row.suspended_reason,
    trustLevel: row.trust_level,
    visibility: row.visibility,
    visibilityScopeId: row.visibility_scope_id,
    status: row.status,
    legacyStatus: row.status,
    legacyVisibility: row.visibility,
    newInstallAllowed,
    existingRunsAllowed,
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
  const runtimeAvailable =
    row.status === "active" &&
    row.publication_status !== "draft" &&
    row.availability_status === "active";
  const blockedReason =
    row.status !== "active"
      ? null
      : row.availability_status === "suspended"
        ? (row.suspended_reason ?? "资源已安全停用")
        : row.publication_status === "draft"
          ? "资源尚未发布"
          : null;
  return {
    id: row.id,
    principalId: row.principal_id,
    assetId: row.asset_id,
    assetVersionId: row.asset_version_id,
    assetVersion: row.asset_version,
    entitlementId: row.entitlement_id,
    status: row.status,
    publicationStatus: row.publication_status,
    availabilityStatus: row.availability_status,
    runtimeAvailable,
    blockedReason,
    revision: row.revision,
    config: row.config,
    installedByPrincipalId: row.installed_by_principal_id,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    grantsAuthorization: false,
  };
}

function marketGovernanceAuditFromRow(
  row: MarketGovernanceAuditRow,
): MarketGovernanceAudit {
  return {
    id: row.id,
    assetId: row.asset_id,
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

function marketResourceBindingFromRow(
  row: MarketResourceBindingRow,
): MarketAssetResourceBinding {
  return {
    id: row.id,
    assetId: row.asset_id,
    assetVersionId: row.asset_version_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    resourceVersionId: row.resource_version_id,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at.toISOString(),
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

async function lockMarketAssetWithClient(
  client: PoolClient,
  assetId: string,
): Promise<MarketAssetRow | undefined> {
  const result = await client.query<MarketAssetRow>(
    `SELECT * FROM market_assets WHERE id = $1 FOR UPDATE`,
    [assetId],
  );
  return result.rows[0];
}

function requireMarketRevision(
  asset: MarketAssetRow,
  expectedRevision: number,
): void {
  if (asset.revision !== expectedRevision) {
    throw new MarketRepositoryError(
      "market_asset_revision_conflict",
      "Market asset revision changed",
    );
  }
}

function invalidGovernanceTransition(message: string): MarketRepositoryError {
  return new MarketRepositoryError(
    "market_governance_transition_invalid",
    message,
  );
}

function marketGovernanceState(
  asset: MarketAssetRow,
): Record<string, unknown> {
  return {
    origin: asset.origin,
    sharingScope: asset.sharing_scope,
    sharingScopeId: asset.sharing_scope_id,
    publicationStatus: asset.publication_status,
    availabilityStatus: asset.availability_status,
    adminLocked: asset.admin_locked,
    adminLockReason: asset.admin_lock_reason,
    suspendedReason: asset.suspended_reason,
    revision: asset.revision,
  };
}

function marketExecutionBlockedReason(asset: MarketAssetRow): string | null {
  if (asset.availability_status === "suspended") {
    return asset.suspended_reason ?? "资源已安全停用";
  }
  if (asset.publication_status === "draft") {
    return "资源尚未发布，已有安装不可运行";
  }
  return null;
}

async function appendMarketGovernanceAuditWithClient(
  client: PoolClient,
  input: {
    readonly assetId: string;
    readonly action: string;
    readonly actor: MarketVisibilityActor;
    readonly reason: string;
    readonly fromState: Record<string, unknown>;
    readonly toState: Record<string, unknown>;
    readonly revision: number;
  },
): Promise<void> {
  const seq = await client.query<{ readonly seq: string }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
     FROM market_governance_audit_events
     WHERE asset_id = $1`,
    [input.assetId],
  );
  await client.query(
    `INSERT INTO market_governance_audit_events (
       id, asset_id, seq, action, actor_principal_id, actor_role, reason,
       from_state, to_state, revision, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, NOW()
     )`,
    [
      randomUUID(),
      input.assetId,
      seq.rows[0]!.seq,
      input.action,
      input.actor.principalId,
      input.actor.platformAdministrator ? "platform-admin" : "owner",
      input.reason,
      JSON.stringify(input.fromState),
      JSON.stringify(input.toState),
      input.revision,
    ],
  );
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
